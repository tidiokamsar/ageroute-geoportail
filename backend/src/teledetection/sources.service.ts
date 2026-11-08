/**
 * Pont entre les adaptateurs de catalogue (EO-SOURCES, sans base) et la base (EO-DB, sans reseau) : verification de
 * connectivite d'une source, synchronisation du catalogue, apercu d'un produit. C'est le seul endroit ou le reseau
 * et la base se rencontrent, et il ne fait aucune des deux choses lui-meme : le reseau passe par les adaptateurs, la
 * base par les fonctions du service d'EO-DB (`changerEtatSource`, `enregistrerProduits`).
 *
 * CE QUE CE PONT S'INTERDIT
 *   - declarer une source « active » : un test de catalogue anonyme ne depasse jamais PRODUIT_DISPONIBLE, et ne declare jamais
 *     TRAITEMENT_OPERATIONNEL (le service d'EO-DB l'exige par ailleurs : traitement reel reussi et preuve) ;
 *   - ecrire une valeur que le catalogue n'a pas donnee : un produit sans emprise valide ou sans couverture nuageuse (optique) est
 *     ECARTE et compte, jamais complete ;
 *   - servir au navigateur une adresse ou une cle du fournisseur : l'apercu est lu COTE SERVEUR et renvoye en octets ;
 *   - appeler le reseau dans les tests : les adaptateurs et le `fetch` de l'apercu sont injectables.
 *
 * LES CODES DE SOURCE. La base nomme ses sources par produit (`SENTINEL2`, `LANDSAT89`, `PLANETSCOPE`, `SPOT`) ; les adaptateurs par
 * catalogue (`cdse-stac`, `earth-search`, `planetscope`, `spot`). `CORRESPONDANCES` les relie, et l'API accepte les deux ecritures.
 * PROVISOIRE : Sentinel-2 passe par le CDSE, Landsat 8/9 par Earth Search (recherche seulement) ; le repli d'Earth Search pour Sentinel-2
 * n'a pas de ligne propre en base.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import {
  creerAdaptateurs, ErreurSource, assainirTexte, ZONE_SONDE_PAR_DEFAUT,
  type CodeSource, type EtatConnectivite, type FetchLike, type ProduitNormalise, type ResultatConnectivite, type SourceAdaptateur,
} from "./sources";
import { verifierEmpriseProduit, bornesCatalogue, type DemandeSynchro } from "./api.noyau";
import { RefusApi } from "./api.erreurs";
import { produitPourApercu, type DepotLecture } from "./api.lecture";
import {
  changerEtatSource, enregistrerProduits, type DepotTeledetection, type GeometrieGeoJson,
} from "./teledetection.service";
import { codeProduitCatalogue, verifierProduitCatalogue, type ProduitCatalogueSaisi } from "./teledetection.noyau";

// ============================================================ correspondance des sources

export interface CorrespondanceSource {
  /** Code de la ligne de `sources_observation`. */
  codeBase: string;
  /** Adaptateur de catalogue qui l'interroge. */
  adaptateur: CodeSource;
  /** Collection STAC propre a la source ; `null` = la collection par defaut de l'adaptateur. */
  collection: string | null;
}

export const CORRESPONDANCES: readonly CorrespondanceSource[] = [
  { codeBase: "SENTINEL2", adaptateur: "cdse-stac", collection: null },
  { codeBase: "LANDSAT89", adaptateur: "earth-search", collection: "landsat-c2-l2" },
  { codeBase: "PLANETSCOPE", adaptateur: "planetscope", collection: null },
  { codeBase: "SPOT", adaptateur: "spot", collection: null },
];

/** Code de base ou code d'adaptateur -> correspondance ; `null` si inconnu. */
export function resoudreSource(code: string): CorrespondanceSource | null {
  return CORRESPONDANCES.find((c) => c.codeBase === code) ?? CORRESPONDANCES.find((c) => c.adaptateur === code) ?? null;
}

export const adaptateurDeCodeBase = (codeBase: string): string | null => CORRESPONDANCES.find((c) => c.codeBase === codeBase)?.adaptateur ?? null;

// ============================================================ injection (tests) et debit sortant

let adaptateursInstalles: Record<CodeSource, SourceAdaptateur> | null = null;
let adaptateursParDefaut: Record<CodeSource, SourceAdaptateur> | null = null;
let fetchApercu: FetchLike | null = null;
let maintenantInstalle: (() => Date) | null = null;
let resolveurInstalle: Resolveur | null = null;

const maintenant = (): Date => (maintenantInstalle ? maintenantInstalle() : new Date());

/** Un seul jeu d'adaptateurs par processus : leurs compteurs de requetes (quotas de la session) y vivent. */
function adaptateurs(): Record<CodeSource, SourceAdaptateur> {
  if (adaptateursInstalles) return adaptateursInstalles;
  adaptateursParDefaut ??= creerAdaptateurs();
  return adaptateursParDefaut;
}

/** Reserve aux tests : adaptateurs, `fetch` de l'apercu et horloge injectes ; `null` remet les valeurs reelles. */
export function _installerSources(o: {
  adaptateurs?: Record<CodeSource, SourceAdaptateur> | null; fetchApercu?: FetchLike | null; maintenant?: (() => Date) | null; resolveur?: Resolveur | null;
}): void {
  if (o.adaptateurs !== undefined) adaptateursInstalles = o.adaptateurs;
  if (o.fetchApercu !== undefined) fetchApercu = o.fetchApercu;
  if (o.resolveur !== undefined) resolveurInstalle = o.resolveur;
  if (o.maintenant !== undefined) maintenantInstalle = o.maintenant;
  limites.clear(); synchrosEnCours.clear(); cacheApercu.clear();
}

/**
 * Debit SORTANT : les routes qui appellent un service public partage (verification, synchronisation, apercu) sont plafonnees par
 * processus, en plus du plafond general de l'API. PROVISOIRE : 6 par minute pour une verification ou une synchronisation (par source),
 * 120 par minute pour les apercus. Au-dela : 429 `LIMITE_ATTEINTE`.
 */
const limites = new Map<string, number[]>();
export const PLAFONDS_SORTANTS = { verifier: 6, synchroniser: 6, apercu: 120 } as const;
const FENETRE_LIMITE_MS = 60_000;

function limiterSortant(cle: string, max: number): void {
  const t = maintenant().getTime();
  const recents = (limites.get(cle) ?? []).filter((x) => t - x < FENETRE_LIMITE_MS);
  if (recents.length >= max) {
    limites.set(cle, recents);
    throw new RefusApi(429, "LIMITE_ATTEINTE", `Trop d'appels vers le fournisseur (${max} par minute) : reessayer dans un instant.`, { retryApresS: Math.ceil((FENETRE_LIMITE_MS - (t - recents[0])) / 1000) });
  }
  recents.push(t);
  limites.set(cle, recents);
}

/** Une limite par minute CHIFFREE par la documentation du fournisseur est respectee ; une limite non chiffree (null) n'est jamais inventee. */
function respecterQuotas(a: SourceAdaptateur): void {
  const q = a.quotas();
  for (const l of q.limites) {
    if (l.concerneRecherche && l.valeur !== null && /minute/i.test(l.unite ?? "") && q.compteurs.derniereMinute >= l.valeur) {
      throw new RefusApi(429, "QUOTA_SOURCE", `Limite du fournisseur atteinte (${l.libelle}) : reessayer plus tard.`);
    }
  }
}

// ============================================================ transaction

type Fournisseur = DepotTeledetection & { $transaction?: PrismaClient["$transaction"] };

async function enTransaction<T>(depot: Fournisseur, f: (tx: DepotTeledetection) => Promise<T>): Promise<T> {
  return depot.$transaction ? depot.$transaction((tx) => f(tx as unknown as DepotTeledetection), { timeout: 120_000, maxWait: 10_000 }) : f(depot);
}

interface Contexte { auteurId: string; ipAddress?: string }

interface LigneSource { id: string; etat: string; requiertIdentifiants: boolean }

async function chargerSource(depot: Pick<DepotTeledetection, "$queryRaw">, codeBase: string): Promise<LigneSource> {
  const l = await depot.$queryRaw<LigneSource[]>`
    SELECT "id", "etat", "requiertIdentifiants" FROM "sources_observation" WHERE "code" = ${codeBase} AND "deletedAt" IS NULL`;
  if (!l[0]) throw new RefusApi(404, "INTROUVABLE", "Source introuvable.");
  return l[0];
}

function correspondance(code: string): CorrespondanceSource {
  const c = resoudreSource(code);
  if (!c) throw new RefusApi(404, "INTROUVABLE", "Source introuvable.");
  return c;
}

// ============================================================ verification de connectivite

/** Sonde une collection qui n'est pas celle par defaut de l'adaptateur (Landsat chez Earth Search) : une recherche, au plus un produit. */
async function sonderCollection(a: SourceAdaptateur, collection: string): Promise<ResultatConnectivite> {
  const fin = maintenant();
  const debut = new Date(fin.getTime() - 60 * 86_400_000);
  const t0 = Date.now();
  try {
    const r = await a.rechercher({ bbox: ZONE_SONDE_PAR_DEFAUT, debut, fin, collections: [collection], limiteParPage: 1, pagesMax: 1, produitsMax: 1 });
    const trouve = r.produits.length;
    return {
      etatAtteint: trouve > 0 ? "PRODUIT_DISPONIBLE" : "ACCESSIBLE",
      message: trouve > 0
        ? `catalogue accessible sans identifiants ; au moins un produit ${collection} dans les 60 derniers jours`
        : `catalogue accessible sans identifiants ; aucun produit ${collection} dans les 60 derniers jours sur la zone sondee`,
      latenceMs: Date.now() - t0, requete: `recherche ${collection}, zone par defaut, 1 produit`, produitsTrouves: trouve, categorieErreur: null, verifieLe: fin.toISOString(),
    };
  } catch (e) {
    const categorie = a.classerErreur(e);
    return { etatAtteint: "EN_ERREUR", message: `${categorie} : ${assainirTexte(e instanceof Error ? e.message : String(e), [], 300)}`, latenceMs: Date.now() - t0, requete: null, produitsTrouves: null, categorieErreur: categorie, verifieLe: fin.toISOString() };
  }
}

const ETATS_ECRITS_PAR_UN_TEST: readonly EtatConnectivite[] = ["CONFIGUREE", "ACCESSIBLE", "PRODUIT_DISPONIBLE", "EN_ERREUR", "EN_ATTENTE_CONFIGURATION"];

/**
 * Etat a enregistrer apres un test de connectivite. JAMAIS au-dessus de PRODUIT_DISPONIBLE, JAMAIS TRAITEMENT_OPERATIONNEL :
 * un test de catalogue ne prouve pas un traitement. Une source deja operationnelle dont le test reussit garde son etat (le test
 * ne la retrograde pas) ; un test en echec la fait descendre, honnetement.
 */
export function etatApresTest(etatActuel: string, r: ResultatConnectivite): string {
  if (!ETATS_ECRITS_PAR_UN_TEST.includes(r.etatAtteint)) {
    throw new Error(`etat de connectivite inattendu : ${String(r.etatAtteint)}`); // defensif : un adaptateur ne doit jamais depasser l'echelle
  }
  if (etatActuel === "TRAITEMENT_OPERATIONNEL" && (r.etatAtteint === "ACCESSIBLE" || r.etatAtteint === "PRODUIT_DISPONIBLE")) return etatActuel;
  return r.etatAtteint;
}

export async function verifierSource(depot: Fournisseur, code: string, ctx: Contexte) {
  const corr = correspondance(code);
  const ligne = await chargerSource(depot, corr.codeBase);
  const a = adaptateurs()[corr.adaptateur];
  limiterSortant(`verifier:${corr.codeBase}`, PLAFONDS_SORTANTS.verifier);

  const defaut = a.descriptif.collections.find((c) => c.parDefaut)?.id ?? null;
  const resultat = corr.collection && corr.collection !== defaut ? await sonderCollection(a, corr.collection) : await a.verifierConnectivite({});
  const vers = etatApresTest(ligne.etat, resultat);
  const message = `${resultat.message} (${resultat.latenceMs} ms)`;

  const ecrit = await enTransaction(depot, async (tx) => {
    const r = await changerEtatSource(tx, corr.codeBase, { vers, message }, ctx);
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "UPDATE", entityType: "SourceObservation", entityId: ligne.id, ipAddress: ctx.ipAddress,
      after: {
        operation: "VERIFIER_CONNECTIVITE", adaptateur: corr.adaptateur, etatAtteint: resultat.etatAtteint, etatEnregistre: vers,
        produitsTrouves: resultat.produitsTrouves, latenceMs: resultat.latenceMs, requete: resultat.requete, categorieErreur: resultat.categorieErreur,
      },
    });
    return r;
  });

  const corps = {
    source: { code: corr.codeBase, adaptateur: corr.adaptateur, etat: vers, derniereVerification: resultat.verifieLe, message },
    resultat: {
      etatAtteint: resultat.etatAtteint, latenceMs: resultat.latenceMs, produitsTrouves: resultat.produitsTrouves,
      requete: resultat.requete ? `${resultat.requete.slice(0, 200)}${resultat.requete.length > 200 ? "..." : ""}` : null, categorieErreur: resultat.categorieErreur,
    },
    changement: ecrit.changement, de: ecrit.de, vers: ecrit.vers,
  };
  if (resultat.etatAtteint === "EN_ERREUR") {
    // L'etat EN_ERREUR est enregistre ; l'appelant recoit un refus, pas un faux succes.
    const quota = resultat.categorieErreur === "QUOTA";
    throw new RefusApi(quota ? 429 : 503, quota ? "QUOTA_SOURCE" : "SOURCE_INDISPONIBLE", `Le catalogue ne repond pas : ${resultat.message}`, { etat: vers, source: corps.source, resultat: corps.resultat });
  }
  return corps;
}

// ============================================================ synchronisation du catalogue

const synchrosEnCours = new Set<string>();

/** Objet de la plateforme -> saisie du service : rien n'est ajoute que le catalogue n'ait donne. */
export function versSaisieCatalogue(p: ProduitNormalise, codeBase: string): ProduitCatalogueSaisi & { code: string; emprise: GeometrieGeoJson } {
  const o = p.orbite;
  const orbite = o.numeroRelatif !== null ? `relative ${o.numeroRelatif}${o.sens ? ` ${o.sens}` : ""}` : (o.numeroAbsolu !== null ? `absolue ${o.numeroAbsolu}${o.sens ? ` ${o.sens}` : ""}` : null);
  const nuages = p.couvertureNuagesPct !== null
    ? ` La couverture nuageuse annoncee (${p.couvertureNuagesPct} %) est celle de la ${p.nuagesPortee === "SCENE" ? "scene" : "tuile"} entiere, pas celle de la zone.`
    : "";
  return {
    code: codeProduitCatalogue(p.fournisseur, p.identifiantFournisseur),
    palier: 0,
    source: `${p.capteur} ${p.niveauTraitement}`,
    nature: p.nature,
    dateAcquisition: new Date(p.dateAcquisition),
    dateFin: p.dateFinAcquisition ? new Date(p.dateFinAcquisition) : null,
    resolutionM: p.resolutionNativeM,
    couvertureNuagesPct: p.couvertureNuagesPct,
    incertitude: `Resolution native ${p.resolutionNativeM} m (${p.resolutionOrigine === "FOURNISSEUR" ? "valeur du fournisseur" : "table documentee du capteur"}).${nuages}`,
    provenance: `Catalogue ${p.fournisseur}, collection ${p.collection}, produit ${p.identifiantFournisseur}. Reference de catalogue : aucune image n'est stockee.`,
    licence: `${p.licence.code}${p.licence.url ? ` : ${p.licence.url}` : ""}`,
    versionTraitement: `niveau ${p.niveauTraitement}`,
    autorisationDepenseRef: null,
    sourceCode: codeBase,
    fournisseur: p.fournisseur,
    identifiantFournisseur: p.identifiantFournisseur,
    collection: p.collection,
    capteur: p.capteur,
    orbite,
    scene: p.scene,
    niveauTraitement: p.niveauTraitement,
    resolutionNativeM: p.resolutionNativeM,
    cycleVie: "CATALOGUE",
    licenceCode: p.licence.code,
    licenceAttribution: p.licence.attribution,
    synthetique: false,
    emprise: p.emprise,
  };
}

const CODES_ECARTES_PAR_LE_MOTEUR = (code: string) => code.startsWith("PRODUIT_ECARTE_") || code === "DOUBLON_PAGINATION" || code === "NUAGES_AU_DESSUS_SEUIL";

export async function synchroniserCatalogue(depot: Fournisseur, code: string, d: DemandeSynchro, ctx: Contexte, limites_ = { produitsMax: 200, pagesMax: 4 }) {
  const corr = correspondance(code);
  const ligne = await chargerSource(depot, corr.codeBase);
  const a = adaptateurs()[corr.adaptateur];
  if (a.descriptif.interface !== "INTERFACE_ACTIVE") {
    throw new RefusApi(409, "SOURCE_NON_CONFIGUREE", "Cette source est une facade : aucune interrogation de catalogue n'est possible.", { etat: ligne.etat });
  }
  if (synchrosEnCours.has(corr.codeBase)) throw new RefusApi(429, "SYNCHRO_EN_COURS", "Une synchronisation de cette source est deja en cours.");
  limiterSortant(`synchroniser:${corr.codeBase}`, PLAFONDS_SORTANTS.synchroniser);
  respecterQuotas(a);

  synchrosEnCours.add(corr.codeBase);
  try {
    const r = await a.rechercher({
      bbox: d.bbox, debut: d.depuis, fin: d.jusqua, nuagesMax: d.nuagesMax,
      ...(corr.collection ? { collections: [corr.collection] } : {}),
      pagesMax: limites_.pagesMax, produitsMax: limites_.produitsMax,
    });

    const ecartes: Record<string, number> = {};
    const noter = (raison: string, n = 1) => { ecartes[raison] = (ecartes[raison] ?? 0) + n; };
    for (const dg of r.diagnostics) if (CODES_ECARTES_PAR_LE_MOTEUR(dg.code)) noter(dg.code, dg.nombre);

    const bornes = bornesCatalogue(maintenant());
    const valides: (ProduitCatalogueSaisi & { code: string; emprise: GeometrieGeoJson })[] = [];
    for (const p of r.produits) {
      const saisie = versSaisieCatalogue(p, corr.codeBase);
      const emprise = verifierEmpriseProduit(p.emprise);
      if (!emprise.ok) { noter("EMPRISE_INVALIDE"); continue; }
      const t = saisie.dateAcquisition.getTime();
      if (Number.isNaN(t) || t < bornes.min || t > bornes.max) { noter("DATE_ABSURDE"); continue; }
      const v = verifierProduitCatalogue(saisie);
      if (!v.ok) { noter(v.code); continue; }
      valides.push({ ...saisie, emprise: emprise.valeur });
    }

    const enregistre = await enTransaction(depot, async (tx) => {
      const rapport = valides.length > 0
        ? await enregistrerProduits(tx, valides, ctx)
        : { nouveaux: 0, dejaConnus: 0, produits: [] as { fournisseur: string; identifiantFournisseur: string; id: string; nouveau: boolean }[] };
      await logAuditTransactionnelle(tx, {
        userId: ctx.auteurId, action: "UPDATE", entityType: "SourceObservation", entityId: ligne.id, ipAddress: ctx.ipAddress,
        after: {
          operation: "SYNCHRONISER_CATALOGUE", adaptateur: corr.adaptateur, bbox: d.bbox, depuis: d.depuis.toISOString(), jusqua: d.jusqua.toISOString(),
          nuagesMax: d.nuagesMax, trouves: r.pagination.produitsLus, nouveaux: rapport.nouveaux, dejaConnus: rapport.dejaConnus, ecartes,
          complet: r.pagination.raisonArret === "FIN", raisonArret: r.pagination.raisonArret,
        },
      });
      return rapport;
    });

    return {
      source: { code: corr.codeBase, adaptateur: corr.adaptateur },
      zone: { bbox: d.bbox, depuis: d.depuis.toISOString(), jusqua: d.jusqua.toISOString(), nuagesMax: d.nuagesMax },
      trouves: r.pagination.produitsLus,
      nouveaux: enregistre.nouveaux,
      dejaConnus: enregistre.dejaConnus,
      ecartes,
      // Une recherche arretee par un plafond le dit : jamais de liste tronquee presentee comme complete.
      complet: r.pagination.raisonArret === "FIN",
      pagination: { pagesLues: r.pagination.pagesLues, totalAnnonce: r.pagination.totalAnnonce, raisonArret: r.pagination.raisonArret },
      latenceMs: r.latenceMs,
      requetes: r.requetes.length,
      diagnostics: r.diagnostics.map((g) => ({ niveau: g.niveau, code: g.code, nombre: g.nombre })),
      produits: enregistre.produits.slice(0, 50).map((p) => ({ id: p.id, identifiantFournisseur: p.identifiantFournisseur, nouveau: p.nouveau })),
    };
  } finally {
    synchrosEnCours.delete(corr.codeBase);
  }
}

// ============================================================ apercu (lu cote serveur)

/**
 * Hotes EXACTS admis pour lire une vignette (SSRF). Ce sont ceux que les fixtures REELLES d'EO-SOURCES montrent : la vignette Sentinel-2 d'Earth
 * Search (seau public `sentinel-cogs`), la vignette du CDSE (`datahub.creodias.eu`) et la destination vers laquelle ce dernier redirige
 * (`zipper.creodias.eu`, constat du 25/10/2026). Aucun suffixe : `.amazonaws.com` acceptait le seau d'un tiers et les noms ec2. Un hote de
 * plus se decide, se constate sur une reponse reelle et s'ajoute ICI.
 */
export const HOTES_APERCU_ADMIS = ["datahub.creodias.eu", "zipper.creodias.eu", "sentinel-cogs.s3.us-west-2.amazonaws.com"] as const;
const TYPES_IMAGE = ["image/jpeg", "image/png", "image/webp"] as const;
export const APERCU_OCTETS_MAX = 1_500_000;
const APERCU_DELAI_MS = 15_000;
const APERCU_REDIRECTIONS_MAX = 2;
const CACHE_APERCU_TTL_MS = 15 * 60_000;
const CACHE_APERCU_MAX = 30;

/** https, port 443 (le port par defaut : `URL.port` est alors vide), aucun identifiant dans l'URL, aucune adresse litterale, hote exact de la liste. */
export function hoteAdmis(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return false;
  const h = u.hostname.toLowerCase();
  if (isIP(h) !== 0 || /^[\d.]+$/.test(h) || h.startsWith("[") || h.includes(":") || h === "localhost") return false; // adresse litterale
  return (HOTES_APERCU_ADMIS as readonly string[]).includes(h);
}

export type Resolveur = (hote: string) => Promise<string[]>;
const resolveurReel: Resolveur = async (h) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address);

/** Adresse routable publiquement : ni boucle locale, ni reseau prive, lien local, CGNAT, multicast, reserve ou non specifiee (IPv4 et IPv6). */
export function adresseEstPublique(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && ((b === 168) || (b === 0 && c === 0))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mappee = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mappee) return adresseEstPublique(mappee[1]);
    if (s === "::" || s === "::1") return false;
    const premier = parseInt(s.split(":")[0] || "0", 16);
    if ((premier & 0xfe00) === 0xfc00 || (premier & 0xffc0) === 0xfe80 || (premier & 0xff00) === 0xff00) return false;
    return true;
  }
  return false;
}

/**
 * La resolution du nom est verifiee a CHAQUE saut (adresse de depart et chaque redirection) : un hote de la liste qui se resoudrait vers
 * une adresse interne n'est pas contacte. Un echec de resolution ou une reponse vide est un refus. LIMITE : le `fetch` resout de nouveau
 * le nom de son cote (fenetre de « rebond DNS » de quelques ms) ; la liste exacte d'hotes de fournisseurs reconnus la rend peu exploitable.
 * Avec un `fetch` injecte (tests) et sans resolveur injecte, aucune resolution reelle n'est faite : aucun appel reseau en test.
 */
async function verifierResolution(url: string): Promise<void> {
  const resolveur = resolveurInstalle ?? (fetchApercu ? null : resolveurReel);
  if (!resolveur) return;
  let adresses: string[];
  try { adresses = await resolveur(new URL(url).hostname); } catch { throw indisponible("le fournisseur ne repond pas"); }
  if (adresses.length === 0 || !adresses.every(adresseEstPublique)) throw indisponible("adresse du fournisseur non admise");
}

const cacheApercu = new Map<string, { octets: Buffer; type: string; le: number }>();
const indisponible = (raison: string) => new RefusApi(404, "APERCU_INDISPONIBLE", `Apercu indisponible : ${raison}`);

/** Lit le corps EN FLUX et le coupe des que la taille maximale est depassee, meme sans (ou avec un faux) `Content-Length`. */
async function lireCorpsBorne(rep: Response, max: number): Promise<Buffer> {
  if (!rep.body) return Buffer.alloc(0);
  const lecteur = rep.body.getReader();
  const morceaux: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await lecteur.cancel().catch(() => undefined); throw indisponible("image trop volumineuse"); }
      morceaux.push(value);
    }
  } catch (e) {
    if (e instanceof RefusApi) throw e;
    throw indisponible("le fournisseur ne repond pas");
  }
  return Buffer.concat(morceaux, total);
}

const abandonner = (rep: Response) => { void rep.body?.cancel().catch(() => undefined); };

export async function lireImage(url: string): Promise<{ octets: Buffer; type: string }> {
  const f: FetchLike = fetchApercu ?? ((u, init) => fetch(u, init));
  let courant = url;
  for (let saut = 0; saut <= APERCU_REDIRECTIONS_MAX; saut++) {
    if (!hoteAdmis(courant)) throw indisponible("adresse du fournisseur non admise");
    await verifierResolution(courant);
    let rep: Response;
    try {
      rep = await f(courant, { method: "GET", headers: { Accept: "image/jpeg,image/png,image/webp", "User-Agent": `AGEROUTE-BDRI/${process.env.AGEROUTE_VERSION ?? "inconnue"}` }, redirect: "manual", signal: AbortSignal.timeout(APERCU_DELAI_MS) });
    } catch {
      throw indisponible("le fournisseur ne repond pas");
    }
    if (rep.status >= 300 && rep.status < 400) {
      abandonner(rep);
      const suite = rep.headers.get("location");
      if (!suite) throw indisponible("redirection sans destination");
      try { courant = new URL(suite, courant).toString(); } catch { throw indisponible("redirection illisible"); }
      continue;
    }
    if (rep.status !== 200) { abandonner(rep); throw indisponible(`le fournisseur a repondu ${rep.status}`); }
    const type = (rep.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!(TYPES_IMAGE as readonly string[]).includes(type)) { abandonner(rep); throw indisponible("le fournisseur n'a pas rendu une image"); }
    const annonce = Number(rep.headers.get("content-length"));
    if (Number.isFinite(annonce) && annonce > APERCU_OCTETS_MAX) { abandonner(rep); throw indisponible("image trop volumineuse"); }
    const octets = await lireCorpsBorne(rep, APERCU_OCTETS_MAX);
    if (octets.length === 0) throw indisponible("image vide");
    return { octets, type };
  }
  throw indisponible("trop de redirections");
}

/**
 * Vignette d'un produit, lue COTE SERVEUR via l'adaptateur de sa source. Echec, absence, acces non etabli : 404 `APERCU_INDISPONIBLE`
 * -- jamais une image de remplacement (contrat, principe 7), jamais une adresse ni une cle du fournisseur dans la reponse.
 */
export async function apercuProduit(depot: DepotLecture, produitId: string): Promise<{ octets: Buffer; type: string }> {
  const chaud = cacheApercu.get(produitId);
  if (chaud && maintenant().getTime() - chaud.le < CACHE_APERCU_TTL_MS) return { octets: chaud.octets, type: chaud.type };
  const p = await produitPourApercu(depot, produitId);
  if (!p) throw indisponible("produit inconnu");
  if (p.synthetique) throw indisponible("donnee synthetique");
  if (!p.identifiantFournisseur || !p.collection || !p.sourceCode) throw indisponible("produit sans reference de catalogue");
  const corr = resoudreSource(p.sourceCode);
  if (!corr) throw indisponible("source inconnue");
  const a = adaptateurs()[corr.adaptateur];
  if (a.descriptif.interface !== "INTERFACE_ACTIVE") throw indisponible("source non configuree");
  limiterSortant("apercu", PLAFONDS_SORTANTS.apercu);

  let norm: ProduitNormalise | null;
  try { norm = await a.metadonnees(p.identifiantFournisseur, { collection: p.collection }); } catch (e) {
    throw indisponible(e instanceof ErreurSource && e.categorie === "QUOTA" ? "le fournisseur limite le debit" : "le catalogue ne repond pas");
  }
  if (!norm) throw indisponible("le fournisseur ne connait plus ce produit");
  const acces = a.urlApercu(norm);
  if (!acces.disponible || !acces.url) throw indisponible(acces.raison ?? "aucune vignette annoncee");

  const image = await lireImage(acces.url);
  if (cacheApercu.size >= CACHE_APERCU_MAX) cacheApercu.delete(cacheApercu.keys().next().value as string);
  cacheApercu.set(produitId, { ...image, le: maintenant().getTime() });
  return image;
}

