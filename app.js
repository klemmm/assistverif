const DATA_URL =
  "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/assistance-psh-pmr/exports/json";
const CACHE_NAME = "pmr-data-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Le serveur répond "Cache-Control: no-store", donc on gère le cache nous-mêmes
// via l'API Cache (dispo en contexte sécurisé : https ou localhost).
// Renvoie { data, fetchedAt } (fetchedAt : date du téléchargement, en ms).
async function loadData() {
  // L'API Cache peut être indisponible (navigation privée, stockage bloqué) : on fait sans.
  let cache = null, cached = null;
  try {
    cache = await caches.open(CACHE_NAME);
    cached = await cache.match(DATA_URL);
  } catch {}

  const cachedAt = cached && Number(cached.headers.get("x-fetched-at"));
  if (cached && Date.now() - cachedAt < MAX_AGE_MS) {
    return { data: await cached.json(), fetchedAt: cachedAt };
  }

  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const data = JSON.parse(body);
    // Ne pas écraser la bonne copie en cache avec une réponse cassée.
    if (!Array.isArray(data) || !data.length) throw new Error("Données inattendues");
    const fetchedAt = Date.now();
    await cache?.put(
      DATA_URL,
      new Response(body, {
        headers: {
          "content-type": "application/json",
          "x-fetched-at": String(fetchedAt),
        },
      })
    ).catch(() => {});
    return { data, fetchedAt };
  } catch (err) {
    // Réseau indisponible : on se rabat sur la version en cache, même périmée.
    if (cached) return { data: await cached.json(), fetchedAt: cachedAt };
    throw err;
  }
}

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function jourSemaine(date) {
  const [a, m, j] = date.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, j)).getUTCDay();
}

const MIN_JOUR = 24 * 60;

// ("2026-10-23", 1) -> "2026-10-24"
function decalerJour(date, n) {
  const [a, m, j] = date.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, j + n)).toISOString().slice(0, 10);
}

// "08:45" -> 525
function minutes(horaire) {
  const [hh, mm] = horaire.split(":").map(Number);
  return hh * 60 + mm;
}

// "2026-10-23" -> "vendredi 23 octobre 2026"
function dateLisible(date) {
  const [a, m, j] = date.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, j)).toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

// Petit utilitaire pour créer un élément : el("p", { class: "x" }, "texte", autreElement)
function el(tag, attributs = {}, ...enfants) {
  const e = document.createElement(tag);
  for (const [nom, valeur] of Object.entries(attributs)) e.setAttribute(nom, valeur);
  e.append(...enfants);
  return e;
}

// (jour, 1470) -> <time datetime="2026-10-24T00:30">samedi 24 octobre 2026 à 00:30</time>
// (minutes comptées depuis le début de `jour`)
function heure(jour, t) {
  const n = Math.floor(t / MIN_JOUR);
  const date = decalerJour(jour, n);
  const reste = t - n * MIN_JOUR;
  const hhmm = `${String(Math.floor(reste / 60)).padStart(2, "0")}:${String(reste % 60).padStart(2, "0")}`;
  return el("time", { datetime: `${date}T${hhmm}` }, `${dateLisible(date)} à ${hhmm}`);
}

// "08:45 - 12:00 / 13:30 - 17:00" -> [[525, 720], [810, 1020]] (en minutes)
function parsePlages(texte) {
  return texte.split(" / ").map((plage) => {
    const [debut, fin] = plage.split(" - ").map(minutes);
    // "04:30 - 00:15" : la plage se termine après minuit
    return [debut, fin <= debut ? fin + MIN_JOUR : fin];
  });
}

// Plage horaire applicable à une gare pour une date donnée (null = pas d'assistance).
function horairesDuJour(gare, date) {
  for (let i = 1; i <= 20; i++) {
    if (gare[`jour_ferie_${i}`] === date) return gare[`horaires_jour_ferie_${i}`];
  }
  return gare[`horaires_jour_nominal_${JOURS[jourSemaine(date)]}`];
}

// Un jour est férié uniquement s'il figure dans les jours fériés de la gare.
function estFerie(gare, date) {
  return Array.from({ length: 20 }, (_, i) => gare[`jour_ferie_${i + 1}`]).includes(date);
}

// Toutes les dates fériées citées par au moins une gare de la base. Sert à repérer
// les jours fériés pour les gares qui ne renseignent pas les leurs.
let FERIES_CONNUS = new Set();
function joursFeriesConnus(data) {
  return new Set(data.flatMap((g) => Array.from({ length: 20 }, (_, i) => g[`jour_ferie_${i + 1}`]).filter(Boolean)));
}

// Plages d'assistance de la veille, du jour et du lendemain, en minutes depuis le
// début de `jour`. Les plages qui se touchent sont fusionnées
// (ex. "... - 23:59" puis "00:00 - ..." le lendemain).
function plagesAutourDe(gare, jour) {
  const plages = [];
  for (const n of [-1, 0, 1]) {
    const horaires = horairesDuJour(gare, decalerJour(jour, n));
    if (!horaires) continue;
    for (const [debut, fin] of parsePlages(horaires)) {
      plages.push([debut + n * MIN_JOUR, fin + n * MIN_JOUR]);
    }
  }
  plages.sort((a, b) => a[0] - b[0]);
  const fusion = [];
  for (const plage of plages) {
    const derniere = fusion.at(-1);
    if (derniere && plage[0] <= derniere[1] + 1) derniere[1] = Math.max(derniere[1], plage[1]);
    else fusion.push(plage);
  }
  return fusion;
}

// Vérifie que l'assistance couvre tout l'intervalle [debut, fin] sans interruption.
// debut et fin sont en minutes depuis le début de `jour` (peuvent déborder sur les jours suivants).
// Renvoie { ok, motif, gare, jour, debut, fin, jours, plage } (motif : raison du refus).
function verifier(data, jour, nom, debut, fin) {
  const gare = data.find((g) => g.nom && normaliser(g.nom) === normaliser(nom));
  if (!gare) return { ok: false, motif: "gare inconnue", gare: null };

  // On se ramène au jour où commence l'intervalle.
  const n = Math.floor(debut / MIN_JOUR);
  jour = decalerJour(jour, n);
  debut -= n * MIN_JOUR;
  fin -= n * MIN_JOUR;

  // Horaires de chaque jour touché par l'intervalle
  const jours = [];
  for (let i = 0; i <= Math.floor(fin / MIN_JOUR); i++) {
    const date = decalerJour(jour, i);
    const ferie = estFerie(gare, date);
    // Jour férié ailleurs dans la base, mais la gare n'indique rien pour ce jour-là
    const ferieNonPrecise = !ferie && FERIES_CONNUS.has(date);
    jours.push({ date, horaires: horairesDuJour(gare, date), ferie, ferieNonPrecise });
  }

  const plage = plagesAutourDe(gare, jour).find(([d, f]) => d <= debut && fin <= f);
  return { ok: Boolean(plage), motif: "hors plage d'assistance", gare, jour, debut, fin, jours, plage };
}

const PRISES_EN_CHARGE = {
  "RESERVE": "sur réservation uniquement",
  "SPONTANE": "sans réservation uniquement",
  "RESERVE ET SPONTANE": "avec ou sans réservation",
};

// Section du résultat pour une étape. `verdict` : "ok", "attention" ou "rejet".
function sectionEtape(titre, v, alertes) {
  const verdict = !v.ok ? "rejet" : alertes.length ? "attention" : "ok";
  const section = el("section", { "data-verdict": verdict }, el("h3", {}, titre));
  if (!v.gare) {
    section.append(el("p", {}, "Gare inconnue : vérifiez le nom saisi."));
    return section;
  }

  const dl = el("dl");
  const ligne = (terme, ...definition) => dl.append(el("dt", {}, terme), el("dd", {}, ...definition));
  if (v.debut === v.fin) ligne("Horaire", heure(v.jour, v.debut));
  else ligne("Présence en gare", "de ", heure(v.jour, v.debut), " à ", heure(v.jour, v.fin));
  if (v.gare.lieurendezvousgare) ligne("Point de rendez-vous", v.gare.lieurendezvousgare);
  ligne("Prise en charge", PRISES_EN_CHARGE[v.gare.typepriseencharge] ?? v.gare.typepriseencharge);
  for (const j of v.jours) {
    const mention = j.ferie ? " (jour férié)" : j.ferieNonPrecise ? " (jour férié, horaires habituels)" : "";
    ligne(`Horaires d'assistance du ${dateLisible(j.date)}${mention}`, j.horaires ?? "aucune assistance");
  }
  if (v.plage) ligne("Créneau qui couvre votre présence","de ", heure(v.jour, v.plage[0]), " à ", heure(v.jour, v.plage[1]));
  ligne("Verdict", v.ok ? "dans la plage d'assistance" : "hors plage d'assistance");
  const maj = v.gare.datestatut?.slice(0, 10);
  if (maj) ligne("Fiche de la gare mise à jour le", el("time", { datetime: maj }, dateLisible(maj)));
  section.append(dl);

  if (alertes.length) section.append(el("ul", {}, ...alertes.map((a) => el("li", {}, `Attention : ${a}`))));
  return section;
}

// Section du verdict global, placée en tête du résultat.
function sectionGlobale(rejets, alertes) {
  const verdict = rejets.length ? "rejet" : alertes.length ? "attention" : "ok";
  const libelles = {
    ok: "horaires compatibles avec l'assistance",
    attention: "horaires compatibles avec l'assistance, points à vérifier",
    rejet: "horaires incompatibles avec l'assistance",
  };
  const section = el("section", { "data-verdict": verdict }, el("h3", {}, `Verdict global : ${libelles[verdict]}`));
  if (verdict === "ok") {
    section.append(el("p", {}, "Toutes les étapes sont dans les plages d'assistance."));
  } else {
    section.append(el("ul", {},
      ...rejets.map((r) => el("li", {}, `Refus : ${r}`)),
      ...alertes.map((a) => el("li", {}, `Attention : ${a}`))));
  }
  return section;
}

// "Saint-Étienne Châteaucreux" -> "saint etienne chateaucreux" ; "St" et "Ste" sont développés.
function normaliser(texte) {
  return texte.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").replace(/\bste\b/g, "sainte").replace(/\bst\b/g, "saint").trim();
}

// Noms de gares pour l'autocomplétion : [{ nom, cle }], cle = nom normalisé.
let GARES = [];

// Gares dont le nom contient tous les mots saisis ; celles qui commencent par la saisie d'abord.
function suggestions(saisie, max = 8) {
  const debut = normaliser(saisie);
  const mots = debut.split(" ").filter(Boolean);
  if (!mots.length) return [];
  return GARES
    .filter((g) => mots.every((m) => g.cle.includes(m)))
    .sort((a, b) => b.cle.startsWith(debut) - a.cle.startsWith(debut) || a.nom.localeCompare(b.nom, "fr"))
    .slice(0, max);
}

// Autocomplétion accessible (motif "combobox" ARIA), car <datalist> n'est pas géré
// partout (Firefox Android notamment). L'input doit être dans un élément .combobox.
let nbCombobox = 0;
function brancherCombobox(input) {
  const id = `suggestions-${++nbCombobox}`;
  const liste = el("ul", { role: "listbox", id, class: "suggestions", "aria-label": "Gares suggérées" });
  liste.hidden = true;
  input.closest(".combobox").append(liste);
  for (const [nom, valeur] of Object.entries({
    role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": id, autocomplete: "off",
  })) input.setAttribute(nom, valeur);

  let options = [];
  let actif = -1;
  const activer = (i) => {
    actif = i;
    options.forEach((o, j) => o.setAttribute("aria-selected", String(j === i)));
    if (i >= 0) {
      input.setAttribute("aria-activedescendant", options[i].id);
      options[i].scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };
  const fermer = () => {
    liste.hidden = true;
    input.setAttribute("aria-expanded", "false");
    activer(-1);
  };
  const choisir = (nom) => {
    input.value = nom;
    fermer();
  };
  const ouvrir = () => {
    options = suggestions(input.value).map((g, i) => {
      const option = el("li", { role: "option", id: `${id}-${i}`, "aria-selected": "false" }, g.nom);
      // mousedown plutôt que click : sinon l'input perd le focus et la liste se ferme avant le clic.
      option.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choisir(g.nom);
      });
      return option;
    });
    liste.replaceChildren(...options);
    actif = -1;
    if (!options.length) return fermer();
    liste.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("input", ouvrir);
  input.addEventListener("blur", fermer);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (liste.hidden) ouvrir();
      if (!options.length) return;
      const pas = e.key === "ArrowDown" ? 1 : -1;
      activer((actif + pas + options.length) % options.length);
    } else if (e.key === "Enter" && !liste.hidden && actif >= 0) {
      e.preventDefault();
      choisir(options[actif].textContent);
    } else if (e.key === "Escape" && !liste.hidden) {
      e.preventDefault();
      fermer();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const form = document.querySelector("form");
  const statut = document.getElementById("statut");
  const resultat = document.getElementById("resultat");
  const boutonAjout = document.getElementById("ajouter-correspondance");
  form.querySelectorAll(".combobox input").forEach(brancherCombobox);

  // Numérote les correspondances pour que les libellés restent distincts.
  const numeroter = () => {
    document.querySelectorAll(".correspondance").forEach((fieldset, i) => {
      fieldset.querySelector("legend").textContent = `Correspondance ${i + 1}`;
      fieldset.querySelector("button").textContent = `Supprimer la correspondance ${i + 1}`;
    });
  };

  // Chaque correspondance est insérée juste avant l'arrivée.
  boutonAjout.addEventListener("click", () => {
    const fragment = document.getElementById("correspondance").content.cloneNode(true);
    const fieldset = fragment.querySelector("fieldset");
    fieldset.querySelector("button").addEventListener("click", () => {
      fieldset.remove();
      numeroter();
      boutonAjout.focus();
    });
    document.getElementById("arrivee").before(fragment);
    brancherCombobox(fieldset.querySelector(".combobox input"));
    numeroter();
    fieldset.querySelector("input").focus();
  });

  let data = null;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!data) {
      statut.textContent = "Les données ne sont pas encore chargées.";
      return;
    }
    const f = new FormData(form);

    const jour = f.get("jour");
    const marge = Number(f.get("marge"));
    const correspMini = Number(f.get("corresp_mini"));

    // Place les horaires sur une frise en minutes depuis le début de `jour` :
    // un horaire antérieur au précédent veut dire qu'on est passé au lendemain.
    let precedent = 0;
    const surFrise = (horaire) => {
      let t = minutes(horaire) + Math.floor(precedent / MIN_JOUR) * MIN_JOUR;
      if (t < precedent) t += MIN_JOUR;
      return (precedent = t);
    };

    // Étapes dans l'ordre chronologique
    const depart = surFrise(f.get("horaire_depart"));
    const etapes = [{ libelle: "Départ", nom: f.get("gare_depart"), debut: depart - marge, fin: depart }];
    const departsCorresp = f.getAll("depart_corresp");
    const arriveesCorresp = f.getAll("arrivee_corresp");
    f.getAll("gare_corresp").forEach((nom, i) => {
      const arrivee = surFrise(arriveesCorresp[i]);
      etapes.push({ libelle: `Correspondance ${i + 1}`, nom, debut: arrivee, fin: surFrise(departsCorresp[i]), corresp: true });
    });
    const arrivee = surFrise(f.get("horaire_arrivee"));
    etapes.push({ libelle: "Arrivée", nom: f.get("gare_arrivee"), debut: arrivee, fin: arrivee });

    const rejets = [];
    const alertes = [];
    // Heure locale du visiteur, supposée être celle de la France.
    const departLe = new Date(`${jour}T${f.get("horaire_depart")}`);
    if (departLe - Date.now() < 24 * 60 * 60 * 1000) {
      alertes.push("départ dans moins de 24 h : la réservation Assist'enGare n'est peut-être plus possible, appelez le 32 12");
    }

    const sections = etapes.map(({ libelle, nom, debut, fin, corresp }) => {
      const v = verifier(data, jour, nom, debut, fin);
      nom = v.gare?.nom ?? nom; // nom officiel, si la saisie différait (accents, majuscules…)
      const alertesEtape = [];
      if (!v.ok) rejets.push(`${libelle} à ${nom} : ${v.motif}`);
      if (v.gare?.typepriseencharge === "RESERVE") alertesEtape.push(`${nom} : assistance uniquement sur réservation`);
      for (const j of v.jours ?? []) {
        if (j.ferieNonPrecise) {
          alertesEtape.push(`${nom} : le ${dateLisible(j.date)} est un jour férié et la gare ne précise pas ses horaires ce jour-là, vérifiez au 32 12`);
        }
      }
      if (corresp && fin - debut < correspMini) {
        alertesEtape.push(`correspondance de ${fin - debut} min à ${nom}, inférieure au minimum de ${correspMini} min`);
      }
      alertes.push(...alertesEtape);
      const titre = libelle === "Départ" ? `Départ de ${nom} (présentation ${marge} min avant)` : `${libelle} : ${nom}`;
      return sectionEtape(titre, v, alertesEtape);
    });

    statut.textContent = "";
    document.getElementById("contenu-resultat").replaceChildren(sectionGlobale(rejets, alertes), ...sections);
    resultat.hidden = false;
    document.getElementById("titre-resultat").focus();
  });

  statut.textContent = "Chargement des données…";
  try {
    const charge = await loadData();
    data = charge.data;
    FERIES_CONNUS = joursFeriesConnus(data);
    statut.textContent = "";
    document.getElementById("date-donnees").textContent =
      `Données téléchargées le ${new Date(charge.fetchedAt).toLocaleString("fr-FR")}.`;
    // Certaines gares apparaissent deux fois avec le même nom : une seule suggestion.
    GARES = [...new Set(data.map((g) => g.nom).filter(Boolean))].map((nom) => ({ nom, cle: normaliser(nom) }));
  } catch (err) {
    console.error("Échec du chargement des données :", err);
    statut.textContent = "Impossible de charger les données. Réessayez plus tard ou appelez le 32 12.";
  }
});
