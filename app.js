const DATA_URL =
  "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/assistance-psh-pmr/exports/json";
const CACHE_NAME = "pmr-data-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function loadData() {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(DATA_URL);

  const cachedAt = cached && Number(cached.headers.get("x-fetched-at"));
  if (cached && Date.now() - cachedAt < MAX_AGE_MS) {
    return { data: await cached.json(), fetchedAt: cachedAt };
  }

  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const fetchedAt = Date.now();
    await cache.put(
      DATA_URL,
      new Response(body, {
        headers: {
          "content-type": "application/json",
          "x-fetched-at": String(fetchedAt),
        },
      })
    );
    return { data: JSON.parse(body), fetchedAt };
  } catch (err) {
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

function decalerJour(date, n) {
  const [a, m, j] = date.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, j + n)).toISOString().slice(0, 10);
}

function minutes(horaire) {
  const [hh, mm] = horaire.split(":").map(Number);
  return hh * 60 + mm;
}

function dateLisible(date) {
  const [a, m, j] = date.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, j)).toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

function el(tag, attributs = {}, ...enfants) {
  const e = document.createElement(tag);
  for (const [nom, valeur] of Object.entries(attributs)) e.setAttribute(nom, valeur);
  e.append(...enfants);
  return e;
}

function heure(jour, t) {
  const n = Math.floor(t / MIN_JOUR);
  const date = decalerJour(jour, n);
  const reste = t - n * MIN_JOUR;
  const hhmm = `${String(Math.floor(reste / 60)).padStart(2, "0")}:${String(reste % 60).padStart(2, "0")}`;
  return el("time", { datetime: `${date}T${hhmm}` }, `${dateLisible(date)} à ${hhmm}`);
}

function parsePlages(texte) {
  return texte.split(" / ").map((plage) => {
    const [debut, fin] = plage.split(" - ").map(minutes);
    return [debut, fin <= debut ? fin + MIN_JOUR : fin];
  });
}

function horairesDuJour(gare, date) {
  for (let i = 1; i <= 20; i++) {
    if (gare[`jour_ferie_${i}`] === date) return gare[`horaires_jour_ferie_${i}`];
  }
  return gare[`horaires_jour_nominal_${JOURS[jourSemaine(date)]}`];
}

function estFerie(gare, date) {
  return Array.from({ length: 20 }, (_, i) => gare[`jour_ferie_${i + 1}`]).includes(date);
}

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

function verifier(data, jour, nom, debut, fin) {
  const gare = data.find((g) => g.nom === nom);
  if (!gare) return { ok: false, motif: "gare inconnue", gare: null };

  const n = Math.floor(debut / MIN_JOUR);
  jour = decalerJour(jour, n);
  debut -= n * MIN_JOUR;
  fin -= n * MIN_JOUR;

  const jours = [];
  for (let i = 0; i <= Math.floor(fin / MIN_JOUR); i++) {
    const date = decalerJour(jour, i);
    jours.push({ date, horaires: horairesDuJour(gare, date), ferie: estFerie(gare, date) });
  }

  const plage = plagesAutourDe(gare, jour).find(([d, f]) => d <= debut && fin <= f);
  return { ok: Boolean(plage), motif: "hors plage d'assistance", gare, jour, debut, fin, jours, plage };
}

const PRISES_EN_CHARGE = {
  "RESERVE": "sur réservation uniquement",
  "SPONTANE": "sans réservation uniquement",
  "RESERVE ET SPONTANE": "avec ou sans réservation",
};

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
    ligne(`Horaires d'assistance du ${dateLisible(j.date)}${j.ferie ? " (jour férié)" : ""}`, j.horaires ?? "aucune assistance");
  }
  if (v.plage) ligne("Créneau qui couvre votre présence","de ", heure(v.jour, v.plage[0]), " à ", heure(v.jour, v.plage[1]));
  ligne("Verdict", v.ok ? "dans la plage d'assistance" : "hors plage d'assistance");
  section.append(dl);

  if (alertes.length) section.append(el("ul", {}, ...alertes.map((a) => el("li", {}, `Attention : ${a}`))));
  return section;
}

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

window.addEventListener("DOMContentLoaded", async () => {
  const form = document.querySelector("form");
  const statut = document.getElementById("statut");
  const resultat = document.getElementById("resultat");
  const boutonAjout = document.getElementById("ajouter-correspondance");

  const numeroter = () => {
    document.querySelectorAll(".correspondance").forEach((fieldset, i) => {
      fieldset.querySelector("legend").textContent = `Correspondance ${i + 1}`;
      fieldset.querySelector("button").textContent = `Supprimer la correspondance ${i + 1}`;
    });
  };

  boutonAjout.addEventListener("click", () => {
    const fragment = document.getElementById("correspondance").content.cloneNode(true);
    const fieldset = fragment.querySelector("fieldset");
    fieldset.querySelector("button").addEventListener("click", () => {
      fieldset.remove();
      numeroter();
      boutonAjout.focus();
    });
    document.getElementById("arrivee").before(fragment);
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

    let precedent = 0;
    const surFrise = (horaire) => {
      let t = minutes(horaire) + Math.floor(precedent / MIN_JOUR) * MIN_JOUR;
      if (t < precedent) t += MIN_JOUR;
      return (precedent = t);
    };

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
    const departLe = new Date(`${jour}T${f.get("horaire_depart")}`);
    if (departLe - Date.now() < 24 * 60 * 60 * 1000) {
      alertes.push("départ dans moins de 24 h : la réservation Assist'enGare n'est peut-être plus possible, appelez le 32 12");
    }

    const sections = etapes.map(({ libelle, nom, debut, fin, corresp }) => {
      const v = verifier(data, jour, nom, debut, fin);
      const alertesEtape = [];
      if (!v.ok) rejets.push(`${libelle} à ${nom} : ${v.motif}`);
      if (v.gare?.typepriseencharge === "RESERVE") alertesEtape.push(`${nom} : assistance uniquement sur réservation`);
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
    statut.textContent = "";
    document.getElementById("date-donnees").textContent =
      `Données téléchargées le ${new Date(charge.fetchedAt).toLocaleString("fr-FR")}.`;
    const datalist = document.getElementById("gares");
    for (const nom of new Set(data.map((g) => g.nom).filter(Boolean))) {
      datalist.append(el("option", { value: nom }));
    }
  } catch (err) {
    console.error("Échec du chargement des données :", err);
    statut.textContent = "Impossible de charger les données. Réessayez plus tard ou appelez le 32 12.";
  }
});
