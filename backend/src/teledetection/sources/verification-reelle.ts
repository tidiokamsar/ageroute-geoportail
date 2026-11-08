/**
 * VERIFICATION REELLE ET ANONYME des adaptateurs de catalogue. OPT-IN : ce script n'est pas un test
 * (vitest ne le charge pas) et n'envoie rien sans l'option --oui.
 *
 *   cd backend && npx tsx src/teledetection/sources/verification-reelle.ts --oui
 *
 * Il interroge le STAC du CDSE et Earth Search pour une zone (Boke, +-0,1 degre autour des
 * coordonnees de frontend/src/lib/villes.ts, sur les 90 derniers jours, nuages de tuile <= 50 %),
 * affiche le nombre de produits NORMALISES, les latences et l'etat de connectivite, puis passe ces
 * produits REELS dans la selection (hors ligne).
 *
 * LIMITES TENUES PAR LE SCRIPT (et non par la bonne volonte) : aucun compte, aucun jeton, aucune
 * requete autre que recherche de catalogue ou lecture d'un item ; au plus 20 requetes HTTP en tout
 * (un compteur coupe au-dela) ; aucun telechargement de scene ; pas plus de quelques centaines de Ko.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { creerAdaptateurCdseStac } from "./adaptateurs/cdse-stac";
import { creerAdaptateurEarthSearch } from "./adaptateurs/earth-search";
import { choisirSource, type CandidatSource, type Phenomene } from "./selection";
import type { BBox, ProduitNormalise, ResultatConnectivite, ResultatRecherche, SourceAdaptateur } from "./contrat";
import type { FetchLike } from "./http";

const BUDGET_REQUETES = 20;
const JOURS = 90;
const NUAGES_MAX = 50;
const DEMI_COTE = 0.1;

function coordonneesBoke(): { lat: number; lon: number; origine: string } {
  const chemin = join(__dirname, "../../../../frontend/src/lib/villes.ts");
  if (existsSync(chemin)) {
    const m = readFileSync(chemin, "utf8").match(/nom:\s*"Bok[ée]",\s*lat:\s*(-?[\d.]+),\s*lon:\s*(-?[\d.]+)/);
    if (m) return { lat: Number(m[1]), lon: Number(m[2]), origine: "frontend/src/lib/villes.ts" };
  }
  // repli signale : les valeurs de villes.ts au 25/10/2026
  return { lat: 10.93, lon: -14.29, origine: "valeurs recopiees de villes.ts (fichier introuvable ou illisible)" };
}

let envoyees = 0;
const journal: string[] = [];
const fetchBorne: FetchLike = async (url, init) => {
  if (envoyees >= BUDGET_REQUETES) throw new Error(`budget de ${BUDGET_REQUETES} requetes atteint : requete refusee`);
  envoyees++;
  return fetch(url, init);
};

function ligne(s = ""): void { process.stdout.write(s + "\n"); }
const ms = (n: number) => `${Math.round(n)} ms`;
const ko = (n: number) => `${(n / 1024).toFixed(0)} Ko`;

async function etape<T>(titre: string, f: () => Promise<T>): Promise<T | null> {
  const avant = envoyees;
  const t0 = Date.now();
  try {
    const r = await f();
    ligne(`  [ok] ${titre} (${envoyees - avant} requete(s), ${ms(Date.now() - t0)})`);
    return r;
  } catch (e) {
    const err = e as { categorie?: string; code?: string; message?: string };
    ligne(`  [ECHEC] ${titre} : ${err.categorie ?? "?"}/${err.code ?? "?"} : ${err.message ?? String(e)}`);
    journal.push(`${titre} : ${err.message ?? String(e)}`);
    return null;
  }
}

function resume(nom: string, r: ResultatRecherche | null): void {
  if (!r) return;
  const p = r.produits;
  const nuages = p.map((x) => x.couvertureNuagesPct).filter((x): x is number => x !== null);
  ligne(`      ${nom} : ${p.length} produit(s) normalise(s) sur ${r.pagination.produitsLus} lu(s), ${r.pagination.pagesLues} page(s), arret=${r.pagination.raisonArret}, total annonce=${r.pagination.totalAnnonce ?? "non annonce"}`);
  ligne(`        latences par page : ${r.requetes.map((q) => `${ms(q.latenceMs)} (HTTP ${q.statut}, ${ko(q.octets)}, ${q.tentatives} envoi(s))`).join(" ; ")}`);
  if (nuages.length > 0) ligne(`        nuages de tuile : min ${Math.min(...nuages)} %, max ${Math.max(...nuages)} %, absents ${p.length - nuages.length}`);
  if (p.length > 0) {
    const dates = p.map((x) => x.dateAcquisition).sort();
    ligne(`        dates : ${dates[0].slice(0, 10)} a ${dates[dates.length - 1].slice(0, 10)} ; resolution native ${[...new Set(p.map((x) => x.resolutionNativeM))].join("/")} m ; origine resolution ${[...new Set(p.map((x) => x.resolutionOrigine))].join("/")}`);
  }
  for (const d of r.diagnostics) ligne(`        diagnostic ${d.niveau} ${d.code} x${d.nombre} : ${d.message}`);
}

function etat(nom: string, c: ResultatConnectivite | null): void {
  if (!c) return;
  ligne(`      ${nom} : etat=${c.etatAtteint}, latence=${ms(c.latenceMs)}, produits=${c.produitsTrouves ?? "-"}, categorieErreur=${c.categorieErreur ?? "-"}`);
  ligne(`        message : ${c.message}`);
  ligne(`        requete : ${c.requete}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes("--oui")) {
    ligne("Verification reelle anonyme du moteur de catalogue : NON LANCEE.");
    ligne("Elle envoie au plus " + BUDGET_REQUETES + " requetes de recherche a stac.dataspace.copernicus.eu et earth-search.aws.element84.com.");
    ligne("Pour la lancer : npx tsx src/teledetection/sources/verification-reelle.ts --oui");
    return;
  }
  const { lat, lon, origine } = coordonneesBoke();
  const bbox: BBox = [lon - DEMI_COTE, lat - DEMI_COTE, lon + DEMI_COTE, lat + DEMI_COTE].map((x) => Math.round(x * 10_000) / 10_000) as BBox;
  const fin = new Date();
  const debut = new Date(fin.getTime() - JOURS * 86_400_000);
  ligne(`Verification reelle anonyme, ${fin.toISOString()}`);
  ligne(`Zone : Boke (${lat}, ${lon}) d'apres ${origine} ; bbox ${JSON.stringify(bbox)}`);
  ligne(`Fenetre : ${debut.toISOString()} -> ${fin.toISOString()} (${JOURS} jours) ; nuages de tuile <= ${NUAGES_MAX} % ; budget ${BUDGET_REQUETES} requetes ; aucun identifiant, aucun telechargement`);
  ligne();

  const cdse = creerAdaptateurCdseStac({ fetch: fetchBorne });
  const es = creerAdaptateurEarthSearch({ fetch: fetchBorne });
  const base = { bbox, debut, fin };

  ligne("1. Connectivite (une requete de recherche chacun)");
  const cCdse = await etape("cdse-stac verifierConnectivite", () => cdse.verifierConnectivite({ bbox, joursFenetre: JOURS }));
  etat("cdse-stac", cCdse);
  const cEs = await etape("earth-search verifierConnectivite", () => es.verifierConnectivite({ bbox, joursFenetre: JOURS }));
  etat("earth-search", cEs);
  ligne();

  ligne("2. Recherches normalisees");
  const s2Cdse = await etape("cdse-stac Sentinel-2 L2A", () => cdse.rechercher({ ...base, collections: ["sentinel-2-l2a"], nuagesMax: NUAGES_MAX, limiteParPage: 50, pagesMax: 2 }));
  resume("cdse-stac S2 L2A", s2Cdse);
  const s2Es = await etape("earth-search Sentinel-2 L2A", () => es.rechercher({ ...base, collections: ["sentinel-2-l2a"], nuagesMax: NUAGES_MAX, limiteParPage: 20, pagesMax: 1 }));
  resume("earth-search S2 L2A", s2Es);
  const s1Cdse = await etape("cdse-stac Sentinel-1 GRD", () => cdse.rechercher({ ...base, collections: ["sentinel-1-grd"], limiteParPage: 50, pagesMax: 1 }));
  resume("cdse-stac S1 GRD", s1Cdse);
  const s1Es = await etape("earth-search Sentinel-1 GRD", () => es.rechercher({ ...base, collections: ["sentinel-1-grd"], limiteParPage: 20, pagesMax: 1 }));
  resume("earth-search S1 GRD", s1Es);
  ligne();

  ligne("3. Metadonnees d'un produit (lecture d'un item, un par catalogue)");
  const premier = (r: ResultatRecherche | null): ProduitNormalise | undefined => r?.produits[0];
  for (const [nom, a, p] of [["cdse-stac", cdse, premier(s2Cdse)], ["earth-search", es, premier(s2Es)]] as [string, SourceAdaptateur, ProduitNormalise | undefined][]) {
    if (!p) { ligne(`  [saute] ${nom} : aucun produit a relire`); continue; }
    const m = await etape(`${nom} metadonnees(${p.identifiantFournisseur})`, () => a.metadonnees(p.identifiantFournisseur));
    if (m) ligne(`      identique a la recherche : ${m.identifiantFournisseur === p.identifiantFournisseur && m.dateAcquisition === p.dateAcquisition && m.couvertureNuagesPct === p.couvertureNuagesPct && m.resolutionNativeM === p.resolutionNativeM}`);
  }
  ligne();

  ligne("4. Deduplication et selection sur ces produits REELS (hors ligne, 0 requete)");
  const cles = (r: ResultatRecherche | null) => new Set((r?.produits ?? []).map((p) => p.cleScene));
  const communS2 = [...cles(s2Cdse)].filter((c) => cles(s2Es).has(c)).length;
  const communS1 = [...cles(s1Cdse)].filter((c) => cles(s1Es).has(c)).length;
  ligne(`      prises de vue vues par les deux catalogues : Sentinel-2 ${communS2} (CDSE ${cles(s2Cdse).size}, Earth Search ${cles(s2Es).size}), Sentinel-1 ${communS1} (CDSE ${cles(s1Cdse).size}, Earth Search ${cles(s1Es).size})`);
  const sources: CandidatSource[] = [
    { code: "cdse-stac", etat: cCdse?.etatAtteint === "PRODUIT_DISPONIBLE" ? "PRODUIT_DISPONIBLE" : "ACCESSIBLE", quota: "OK", priorite: 1, produits: [...(s2Cdse?.produits ?? []), ...(s1Cdse?.produits ?? [])] },
    { code: "earth-search", etat: cEs?.etatAtteint === "PRODUIT_DISPONIBLE" ? "PRODUIT_DISPONIBLE" : "ACCESSIBLE", quota: "INCONNU", priorite: 2, produits: [...(s2Es?.produits ?? []), ...(s1Es?.produits ?? [])] },
  ];
  for (const phenomene of ["VEGETATION", "INONDATION"] as Phenomene[]) {
    const r = choisirSource({ zone: { bbox }, dates: { debut, fin }, phenomene, nuagesMax: NUAGES_MAX, sourcesDisponibles: sources });
    ligne(`      ${phenomene} : retenue=${r.retenue ? `${r.retenue.produit.source} ${r.retenue.produit.identifiantFournisseur} (score ${r.retenue.score}, zone couverte ${r.retenue.couvertureZonePct} %, nuages tuile ${r.retenue.produit.couvertureNuagesPct} %)` : "aucune"}`);
    ligne(`        entonnoir : ${JSON.stringify((r.metadonnees as { entonnoir: unknown }).entonnoir)}`);
    if (r.aucune) ligne(`        aucune source satisfaisante : ${r.aucune.cause} : ${r.aucune.details.join(" ; ")}`);
    if (r.alternative) ligne(`        alternative : ${r.alternative.message}`);
  }
  ligne();

  ligne("5. Quotas de la session (compteurs mesures ; limites citees)");
  for (const [nom, a] of [["cdse-stac", cdse], ["earth-search", es]] as [string, SourceAdaptateur][]) {
    const q = a.quotas();
    ligne(`      ${nom} : ${JSON.stringify(q.compteurs)}`);
  }
  ligne();
  ligne(`TOTAL : ${envoyees} requete(s) HTTP sur ${BUDGET_REQUETES} permises ; ${journal.length} echec(s) d'etape.`);
  for (const j of journal) ligne(`  echec : ${j}`);
}

main().catch((e) => { process.stderr.write(`ECHEC INATTENDU : ${(e as Error).message}\n`); process.exit(1); });
