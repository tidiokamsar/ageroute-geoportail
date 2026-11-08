/**
 * SELECTION D'UN PRODUIT PARMI LES SOURCES. Fonction pure : ni reseau, ni base, ni horloge. Les
 * produits (deja cherches), l'etat des sources, les quotas et le cache sont des ENTREES ; la sortie
 * dit ce qui est retenu, ce qui est ecarte et POURQUOI, en un format que l'API enregistre tel quel
 * dans les metadonnees du produit ou de la proposition.
 *
 * REGLES (toutes PROVISOIRES : des choix de conduite reversibles, pas des verites metier)
 *   1. Filtres durs, dans cet ordre, chacun trace : emprise qui couvre au moins la part minimale de la
 *      zone (defaut 50 %), date dans la fenetre,
 *      nature du capteur adaptee au phenomene, resolution suffisante, nuages <= seuil (optique).
 *   2. Deduplication entre catalogues : meme `cleScene` = meme prise de vue. On garde la
 *      representation de la source la plus prioritaire ; les autres sont citees, pas perdues.
 *   3. Classement par POINTS EXPLICITES (PONDERATIONS_SELECTION, total 100) : couverture de la zone,
 *      nuages de tuile, resolution, fraicheur, etat de la source, quota, cache. Chaque terme est
 *      rendu avec sa valeur, ses points et sa phrase. Egalite : date recente, L2A avant L1C, priorite
 *      de la source, identifiant (ordre total, donc resultat deterministe).
 *   4. JAMAIS DE CHANGEMENT SILENCIEUX DE CAPTEUR. Pour l'eau et les surfaces inondees, si l'optique
 *      manque, le radar Sentinel-1 est PROPOSE (`alternative`) et dit comme tel ; il n'est retenu que si
 *      l'appelant l'a accepte (`accepterAlternativeRadar`), et le produit retenu porte alors
 *      `changementDeCapteur: true`. Pour une nouvelle route ou la vegetation, le radar (20 x 22 m) ne
 *      remplace pas l'optique : aucune alternative n'est proposee, et on le dit.
 *   5. « Aucune source satisfaisante » rend la CAUSE : absence de couverture, nuages, qualite, quota,
 *      erreur d'API, fenetre trop courte (plus : source non configuree, source non interrogee). Une
 *      absence de couverture n'est jamais affirmee si une source n'a pas pu repondre.
 *
 * LA COUVERTURE NUAGEUSE EST CELLE DE LA TUILE ENTIERE : un pre-filtre. Elle peut differer fortement de
 * la couverture sur la zone (mesure du 25/10/2026 : 25,8 % de tuile pour 0 % local, 82 % de tuile pour
 * 100 % local). Le classement le dit dans chaque raison « nuages ».
 */
import { bboxValide, fractionCouverte, polygoneDeBbox, polygonesSIntersectent, type BBox, type PolygoneGeoJson } from "./geometrie";
import { ErreurSource, type CategorieErreur, type Capteur, type CodeSource, type ProduitNormalise } from "./contrat";

export type Phenomene = "NOUVELLE_ROUTE" | "COUPURE_PROBABLE" | "VEGETATION" | "INONDATION" | "EAU_SURFACE";

export type EtatSourceEnBase =
  | "NON_CONFIGUREE" | "CONFIGUREE" | "AUTHENTIFIEE" | "ACCESSIBLE" | "PRODUIT_DISPONIBLE"
  | "TRAITEMENT_OPERATIONNEL" | "EN_ERREUR" | "EN_ATTENTE_CONFIGURATION";

export type EtatQuota = "OK" | "PROCHE" | "EPUISE" | "INCONNU";

export type CauseAucune =
  | "ABSENCE_COUVERTURE" | "NUAGES" | "QUALITE" | "QUOTA" | "ERREUR_API" | "FENETRE_TROP_COURTE"
  | "SOURCE_NON_CONFIGUREE" | "SOURCE_NON_INTERROGEE";

export interface CandidatSource {
  code: CodeSource;
  etat: EtatSourceEnBase;
  quota?: EtatQuota;
  /** Produits rendus par la recherche de cette source. Absent : la source n'a pas ete interrogee. */
  produits?: ProduitNormalise[];
  /** La recherche de cette source a echoue. */
  erreur?: { categorie: CategorieErreur; message: string };
  /** Les produits de cette source sont deja au registre local (catalogue deja synchronise). */
  enCache?: boolean;
  /** Plus petit = prefere, a egalite. Defaut : l'ordre d'entree. */
  priorite?: number;
}

/** Une mesure de disponibilite deja faite (ex. produits de Boke par mois sous un seuil de nuages). Explicative, jamais decisive. */
export interface MesureDisponibilite {
  capteur: Capteur;
  /** « AAAA-MM » */
  mois: string;
  seuilNuagesPct: number | null;
  produits: number;
  /** Document et date de la mesure. */
  reference: string;
}

export interface ParamsSelection {
  zone: { bbox: BBox } | { polygone: PolygoneGeoJson };
  dates: { debut: string | Date; fin: string | Date };
  phenomene: Phenomene;
  /** Seuil de couverture nuageuse de la tuile (%), optique seulement. */
  nuagesMax: number;
  sourcesDisponibles: CandidatSource[];
  mesuresDispo?: MesureDisponibilite[];
  /** Identifiants fournisseur ou cleScene deja au registre (cache). */
  dejaConnus?: string[];
  accepterAlternativeRadar?: boolean;
  ponderations?: Partial<Ponderations>;
  /** Resolution maximale admise (m), a la place de celle du phenomene. */
  resolutionMaxM?: number;
  /**
   * Part minimale de la zone que l'emprise d'un produit doit couvrir (0 a 1, defaut 0,5 : PROVISOIRE).
   * Pour un corridor long qu'aucune scene ne couvre seule, abaisser a 0 et mosaiquer plusieurs produits.
   */
  couvertureMinZone?: number;
}

export interface Ponderations {
  couverture: number; nuages: number; resolution: number; fraicheur: number; etat_source: number; quota: number; cache: number;
}

export const PONDERATIONS_SELECTION: Ponderations = {
  couverture: 40, nuages: 25, resolution: 15, fraicheur: 10, etat_source: 3, quota: 2, cache: 5,
};

/** Phenomenes pour lesquels le radar est une alternative honnete (EARTH_OBSERVATION_PLAN.md : Sentinel-1 pour inondations et coupures). */
export const PHENOMENES_EAU: readonly Phenomene[] = ["INONDATION", "EAU_SURFACE", "COUPURE_PROBABLE"];

/** Resolution maximale (m) pour que le produit ait un sens pour le phenomene. PROVISOIRE. */
export const RESOLUTION_MAX_PAR_PHENOMENE_M: Record<Phenomene, number> = {
  NOUVELLE_ROUTE: 10, COUPURE_PROBABLE: 30, VEGETATION: 30, INONDATION: 30, EAU_SURFACE: 30,
};

/** Juin a septembre : saison des pluies en Guinee, d'apres les mesures de disponibilite optique du 25/10/2026. */
export const MOIS_SAISON_PLUIES: readonly number[] = [6, 7, 8, 9];

/** Revisite en jours : Sentinel-2 a deux satellites (doc CDSE), Sentinel-1 a deux satellites (doc CDSE), Landsat (doc CDSE, 16 j). */
export const REVISITE_JOURS: Record<Capteur, number> = { "SENTINEL-2": 5, "SENTINEL-1": 6, LANDSAT: 16 };

export interface RaisonClassement {
  critere: keyof Ponderations;
  points: number;
  poidsMax: number;
  valeur: string;
  explication: string;
}

export interface CandidatClasse {
  rang: number;
  produit: ProduitNormalise;
  score: number;
  raisons: RaisonClassement[];
  couvertureZonePct: number;
  /** Memes prises de vue chez d'autres catalogues, ecartees comme doublons. */
  aussiChez: { source: CodeSource; identifiantFournisseur: string }[];
  changementDeCapteur: boolean;
}

export type CauseEcart =
  | "HORS_ZONE" | "COUVERTURE_PARTIELLE" | "HORS_FENETRE" | "NATURE_NON_ADAPTEE" | "RESOLUTION_INSUFFISANTE"
  | "NUAGES_AU_DESSUS_SEUIL" | "NUAGES_INCONNUS" | "DOUBLON";

export interface ProduitEcarte {
  source: CodeSource;
  identifiantFournisseur: string;
  cause: CauseEcart;
  detail: string;
}

export interface Alternative {
  nature: "RADAR";
  /** true : a presenter a l'utilisateur comme choix. */
  proposee: boolean;
  motif: "AUCUN_OPTIQUE" | "SAISON_DES_PLUIES";
  message: string;
  classement: CandidatClasse[];
}

export interface ResultatSelection {
  retenue: CandidatClasse | null;
  classement: CandidatClasse[];
  alternative: Alternative | null;
  aucune: { cause: CauseAucune; details: string[] } | null;
  ecartes: ProduitEcarte[];
  /** Phrases enregistrables, dans l'ordre de la decision. */
  raisons: string[];
  /** Objet JSON-serialisable a ranger tel quel dans les metadonnees. */
  metadonnees: Record<string, unknown>;
}

const entree = (m: string) => new ErreurSource({ code: "ENTREE_INVALIDE", categorie: "ENTREE", message: m });
const JOUR_MS = 86_400_000;
const arrondi = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Part des jours de la fenetre qui tombent en saison des pluies (UTC). */
export function fractionSaisonDesPluies(debutMs: number, finMs: number): number {
  const jours = Math.max(1, Math.min(3660, Math.ceil((finMs - debutMs) / JOUR_MS) + 1));
  let n = 0;
  for (let i = 0; i < jours; i++) if (MOIS_SAISON_PLUIES.includes(new Date(debutMs + i * JOUR_MS).getUTCMonth() + 1)) n++;
  return n / jours;
}

interface Entree { produit: ProduitNormalise; source: CandidatSource; ordre: number }

function etatSourcePoints(e: EtatSourceEnBase): number {
  if (e === "PRODUIT_DISPONIBLE" || e === "TRAITEMENT_OPERATIONNEL") return 1;
  if (e === "ACCESSIBLE" || e === "AUTHENTIFIEE") return 0.5;
  if (e === "CONFIGUREE") return 0.25;
  return 0;
}

export function choisirSource(params: ParamsSelection): ResultatSelection {
  // ---- entrees ----
  let zone: PolygoneGeoJson;
  if ("bbox" in params.zone) {
    if (!bboxValide(params.zone.bbox)) throw entree("zone : bbox invalide");
    zone = polygoneDeBbox(params.zone.bbox);
  } else zone = params.zone.polygone;
  const debutMs = new Date(params.dates.debut).getTime();
  const finMs = new Date(params.dates.fin).getTime();
  if (Number.isNaN(debutMs) || Number.isNaN(finMs) || debutMs > finMs) throw entree("dates : fenetre illisible ou inversee");
  if (!(params.nuagesMax >= 0 && params.nuagesMax <= 100)) throw entree("nuagesMax : un pourcentage entre 0 et 100");
  const poids: Ponderations = { ...PONDERATIONS_SELECTION, ...params.ponderations };
  const resMax = params.resolutionMaxM ?? RESOLUTION_MAX_PAR_PHENOMENE_M[params.phenomene];
  const couvMin = params.couvertureMinZone ?? 0.5;
  if (!(couvMin >= 0 && couvMin <= 1)) throw entree("couvertureMinZone : une part entre 0 et 1");
  const eau = PHENOMENES_EAU.includes(params.phenomene);
  const fenetreJours = (finMs - debutMs) / JOUR_MS;
  const pluies = fractionSaisonDesPluies(debutMs, finMs);
  const connus = new Set(params.dejaConnus ?? []);
  const raisons: string[] = [];

  // ---- etat des sources ----
  type Blocage = "ERREUR_API" | "QUOTA" | "SOURCE_NON_CONFIGUREE" | "SOURCE_NON_INTERROGEE";
  const blocages: { code: CodeSource; blocage: Blocage; detail: string }[] = [];
  const utilisables: CandidatSource[] = [];
  for (const s of params.sourcesDisponibles) {
    if (s.erreur) blocages.push({ code: s.code, blocage: "ERREUR_API", detail: `${s.erreur.categorie} : ${s.erreur.message}` });
    else if (s.etat === "EN_ERREUR" && !s.produits) blocages.push({ code: s.code, blocage: "ERREUR_API", detail: "etat enregistre EN_ERREUR, aucune recherche recente" });
    else if (s.quota === "EPUISE") blocages.push({ code: s.code, blocage: "QUOTA", detail: "quota de requetes epuise" });
    else if (s.etat === "NON_CONFIGUREE" || s.etat === "EN_ATTENTE_CONFIGURATION") blocages.push({ code: s.code, blocage: "SOURCE_NON_CONFIGUREE", detail: `etat ${s.etat}` });
    else if (!s.produits) blocages.push({ code: s.code, blocage: "SOURCE_NON_INTERROGEE", detail: "la source n'a pas ete interrogee pour cette zone et cette fenetre" });
    else utilisables.push(s);
  }
  for (const b of blocages) raisons.push(`source ${b.code} ecartee (${b.blocage}) : ${b.detail}`);

  // ---- filtres durs, tries par etape pour tracer l'entonnoir ----
  const ecartes: ProduitEcarte[] = [];
  const toutes: Entree[] = [];
  let ordre = 0;
  for (const s of utilisables) for (const p of s.produits ?? []) toutes.push({ produit: p, source: s, ordre: ordre++ });
  const ecarter = (e: Entree, cause: CauseEcart, detail: string) =>
    ecartes.push({ source: e.source.code, identifiantFournisseur: e.produit.identifiantFournisseur, cause, detail });

  const couverturePct = new Map<Entree, number>();
  let restant: Entree[] = [];
  let coupentLaZone = 0;
  let meilleureCouverture = 0;
  for (const e of toutes) {
    if (!polygonesSIntersectent(zone, e.produit.emprise)) { ecarter(e, "HORS_ZONE", "l'emprise ne coupe pas la zone"); continue; }
    const f = fractionCouverte(zone, e.produit.emprise);
    if (f === 0) { ecarter(e, "HORS_ZONE", "l'emprise touche la zone sans en couvrir aucun point echantillonne"); continue; }
    coupentLaZone++;
    meilleureCouverture = Math.max(meilleureCouverture, f);
    if (f < couvMin) { ecarter(e, "COUVERTURE_PARTIELLE", `l'emprise ne couvre que ${arrondi(f * 100, 1)} % de la zone (minimum ${arrondi(couvMin * 100, 0)} %)`); continue; }
    couverturePct.set(e, f);
    restant.push(e);
  }
  const apresZone = restant.length;

  const surFenetre: Entree[] = [];
  for (const e of restant) {
    const t = Date.parse(e.produit.dateAcquisition);
    if (t < debutMs || t > finMs) ecarter(e, "HORS_FENETRE", `acquis le ${e.produit.dateAcquisition}, hors de la fenetre`);
    else surFenetre.push(e);
  }
  restant = surFenetre;
  const apresFenetre = restant.length;

  const surNature: Entree[] = [];
  const radarEnAttente: Entree[] = [];
  for (const e of restant) {
    if (e.produit.nature === "OPTIQUE") surNature.push(e);
    else if (eau) radarEnAttente.push(e);
    else ecarter(e, "NATURE_NON_ADAPTEE", `le radar (${e.produit.resolutionNativeM} m) ne remplace pas l'optique pour ${params.phenomene}`);
  }
  const apresNatureOptique = surNature.length;
  const apresNatureRadar = radarEnAttente.length;

  const filtrerResolution = (liste: Entree[]) => liste.filter((e) => {
    if (e.produit.resolutionNativeM > resMax) { ecarter(e, "RESOLUTION_INSUFFISANTE", `${e.produit.resolutionNativeM} m native > ${resMax} m admis pour ${params.phenomene}`); return false; }
    return true;
  });
  const optiqueRes = filtrerResolution(surNature);
  const radarRes = filtrerResolution(radarEnAttente);

  const nuagesObserves: number[] = [];
  const optiqueNuages = optiqueRes.filter((e) => {
    const n = e.produit.couvertureNuagesPct;
    if (n === null) { ecarter(e, "NUAGES_INCONNUS", "couverture nuageuse non annoncee : le seuil ne peut pas etre verifie"); return false; }
    nuagesObserves.push(n);
    if (n > params.nuagesMax) { ecarter(e, "NUAGES_AU_DESSUS_SEUIL", `${n} % de nuages sur la tuile > seuil ${params.nuagesMax} %`); return false; }
    return true;
  });

  // ---- deduplication entre catalogues ----
  const dedoublonner = (liste: Entree[]): { gardes: Entree[]; aussi: Map<Entree, { source: CodeSource; identifiantFournisseur: string }[]> } => {
    const parCle = new Map<string, Entree[]>();
    for (const e of liste) parCle.set(e.produit.cleScene, [...(parCle.get(e.produit.cleScene) ?? []), e]);
    const gardes: Entree[] = [];
    const aussi = new Map<Entree, { source: CodeSource; identifiantFournisseur: string }[]>();
    for (const groupe of parCle.values()) {
      const tri = [...groupe].sort((a, b) =>
        (a.source.priorite ?? a.ordre) - (b.source.priorite ?? b.ordre) || a.ordre - b.ordre);
      const [garde, ...autres] = tri;
      gardes.push(garde);
      aussi.set(garde, autres.map((o) => ({ source: o.source.code, identifiantFournisseur: o.produit.identifiantFournisseur })));
      for (const o of autres) ecarter(o, "DOUBLON", `meme prise de vue que ${garde.produit.identifiantFournisseur} (${garde.source.code}) : cle ${garde.produit.cleScene}`);
    }
    return { gardes, aussi };
  };
  const dedOptique = dedoublonner(optiqueNuages);
  const dedRadar = dedoublonner(radarRes);

  // ---- classement ----
  const classer = (liste: Entree[], aussi: Map<Entree, { source: CodeSource; identifiantFournisseur: string }[]>, radar: boolean): CandidatClasse[] => {
    if (liste.length === 0) return [];
    const resMin = Math.min(...liste.map((e) => e.produit.resolutionNativeM));
    const notes = liste.map((e) => {
      const p = e.produit;
      const f = couverturePct.get(e) ?? 0;
      const rs: RaisonClassement[] = [];
      const ajouter = (critere: keyof Ponderations, part: number, valeur: string, explication: string) =>
        rs.push({ critere, points: arrondi(poids[critere] * part), poidsMax: poids[critere], valeur, explication });
      ajouter("couverture", f, `${arrondi(f * 100, 1)} %`, "part de la zone couverte par l'emprise du produit (estimation sur grille)");
      if (radar || p.couvertureNuagesPct === null) {
        ajouter("nuages", 1, "sans objet", "radar : insensible aux nuages");
      } else {
        const part = params.nuagesMax > 0 ? Math.max(0, 1 - p.couvertureNuagesPct / params.nuagesMax) : (p.couvertureNuagesPct === 0 ? 1 : 0);
        ajouter("nuages", part, `${p.couvertureNuagesPct} % (tuile)`, "couverture nuageuse de la TUILE ENTIERE : pre-filtre, la couverture sur la zone peut differer fortement");
      }
      ajouter("resolution", resMin / p.resolutionNativeM, `${p.resolutionNativeM} m`, `resolution native ; la plus fine des candidats vaut ${resMin} m`);
      const age = finMs > debutMs ? (finMs - Date.parse(p.dateAcquisition)) / (finMs - debutMs) : 0;
      ajouter("fraicheur", Math.min(1, Math.max(0, 1 - age)), p.dateAcquisition.slice(0, 10), "plus l'acquisition est proche de la fin de la fenetre, plus elle compte");
      ajouter("etat_source", etatSourcePoints(e.source.etat), e.source.etat, "etat de la source dans l'echelle du contrat");
      const q = e.source.quota ?? "INCONNU";
      ajouter("quota", q === "OK" ? 1 : q === "PROCHE" ? 0.25 : 0.5, q, "marge de quota restante (inconnue = neutre)");
      const enCache = e.source.enCache === true || connus.has(p.identifiantFournisseur) || connus.has(p.cleScene);
      ajouter("cache", enCache ? 1 : 0, enCache ? "oui" : "non", "produit ou source deja au registre local");
      return { e, rs, score: arrondi(rs.reduce((t, r) => t + r.points, 0)) };
    });
    notes.sort((a, b) =>
      b.score - a.score ||
      Date.parse(b.e.produit.dateAcquisition) - Date.parse(a.e.produit.dateAcquisition) ||
      (a.e.produit.niveauTraitement === "L2A" ? 0 : 1) - (b.e.produit.niveauTraitement === "L2A" ? 0 : 1) ||
      (a.e.source.priorite ?? a.e.ordre) - (b.e.source.priorite ?? b.e.ordre) ||
      a.e.produit.identifiantFournisseur.localeCompare(b.e.produit.identifiantFournisseur));
    return notes.map((n, i) => ({
      rang: i + 1, produit: n.e.produit, score: n.score, raisons: n.rs,
      couvertureZonePct: arrondi((couverturePct.get(n.e) ?? 0) * 100, 1),
      aussiChez: aussi.get(n.e) ?? [], changementDeCapteur: radar,
    }));
  };
  const classementOptique = classer(dedOptique.gardes, dedOptique.aussi, false);
  const classementRadar = classer(dedRadar.gardes, dedRadar.aussi, true);

  // ---- cause d'absence (quand il n'y a pas d'optique satisfaisant) ----
  const causeDonnees = (): { cause: CauseAucune; details: string[] } => {
    const details: string[] = [];
    if (params.sourcesDisponibles.length === 0) return { cause: "SOURCE_NON_CONFIGUREE", details: ["aucune source n'est fournie a la selection"] };
    if (utilisables.length === 0) {
      for (const b of blocages) details.push(`${b.code} : ${b.blocage} (${b.detail})`);
      const cause = blocages.some((b) => b.blocage === "ERREUR_API") ? "ERREUR_API"
        : blocages.some((b) => b.blocage === "QUOTA") ? "QUOTA"
        : blocages.some((b) => b.blocage === "SOURCE_NON_INTERROGEE") ? "SOURCE_NON_INTERROGEE" : "SOURCE_NON_CONFIGUREE";
      return { cause, details };
    }
    const partiel = blocages.filter((b) => b.blocage === "ERREUR_API" || b.blocage === "QUOTA");
    const note = partiel.length > 0 ? [`resultat partiel : ${partiel.map((b) => `${b.code} (${b.blocage})`).join(", ")} n'a pas pu repondre`] : [];
    const cedePartiel = (cause: CauseAucune, d: string[]) =>
      partiel.length > 0 ? { cause: (partiel.some((b) => b.blocage === "ERREUR_API") ? "ERREUR_API" : "QUOTA") as CauseAucune, details: [...d, ...note] } : { cause, details: d };

    if (toutes.length === 0) {
      if (fenetreJours < REVISITE_JOURS["SENTINEL-2"]) {
        return cedePartiel("FENETRE_TROP_COURTE", [`fenetre de ${arrondi(fenetreJours, 1)} j < revisite de Sentinel-2 (${REVISITE_JOURS["SENTINEL-2"]} j a deux satellites, doc CDSE)`]);
      }
      return cedePartiel("ABSENCE_COUVERTURE", ["aucun produit rendu par les sources interrogees pour cette zone et cette fenetre"]);
    }
    if (apresZone === 0) {
      return cedePartiel("ABSENCE_COUVERTURE", coupentLaZone === 0
        ? [`${toutes.length} produit(s) rendu(s), aucun ne couvre la zone`]
        : [`${coupentLaZone} produit(s) coupent la zone mais aucun n'en couvre ${arrondi(couvMin * 100, 0)} % (meilleur : ${arrondi(meilleureCouverture * 100, 1)} %)`]);
    }
    if (apresFenetre === 0) {
      if (fenetreJours < REVISITE_JOURS["SENTINEL-2"]) {
        return cedePartiel("FENETRE_TROP_COURTE", [`${apresZone} produit(s) couvrent la zone mais hors de la fenetre ; fenetre de ${arrondi(fenetreJours, 1)} j < revisite de Sentinel-2 (${REVISITE_JOURS["SENTINEL-2"]} j)`]);
      }
      return cedePartiel("ABSENCE_COUVERTURE", [`${apresZone} produit(s) couvrent la zone, aucun dans la fenetre`]);
    }
    if (apresNatureOptique === 0) {
      return cedePartiel("ABSENCE_COUVERTURE", [`${apresFenetre} produit(s) dans la fenetre, tous radar : inadaptes a ${params.phenomene} ou non optiques`]);
    }
    if (optiqueRes.length === 0) {
      return { cause: "QUALITE", details: [`${apresNatureOptique} produit(s) optique(s), tous plus grossiers que ${resMax} m (resolution requise pour ${params.phenomene})`] };
    }
    if (optiqueNuages.length === 0) {
      const connu = nuagesObserves.length;
      if (connu === 0) return { cause: "QUALITE", details: [`${optiqueRes.length} produit(s) optique(s) sans couverture nuageuse annoncee : seuil inverifiable`] };
      const mini = Math.min(...nuagesObserves);
      return { cause: "NUAGES", details: [`${connu} produit(s) optique(s) avec nuages connus ; meilleure couverture de tuile observee ${arrondi(mini, 2)} % > seuil ${params.nuagesMax} %`, ...note] };
    }
    return { cause: "ABSENCE_COUVERTURE", details: ["aucun produit admissible apres deduplication"] };
  };

  // ---- decision ----
  let retenue: CandidatClasse | null = classementOptique[0] ?? null;
  let alternative: Alternative | null = null;
  let aucune: ResultatSelection["aucune"] = null;

  const pluvieuse = pluies >= 0.5;
  const mesuresFenetre = (params.mesuresDispo ?? []).filter((m) => {
    const lu = m.mois.match(/^(\d{4})-(\d{2})$/);
    if (!lu || m.capteur !== "SENTINEL-2") return false;
    const debutMois = Date.UTC(Number(lu[1]), Number(lu[2]) - 1, 1);
    const finMois = Date.UTC(Number(lu[1]), Number(lu[2]), 1);
    return debutMois <= finMs && finMois > debutMs;
  });
  if (mesuresFenetre.length > 0) {
    const total = mesuresFenetre.reduce((t, m) => t + m.produits, 0);
    raisons.push(`mesure de disponibilite optique Sentinel-2 sur la fenetre : ${total} produit(s) (${mesuresFenetre.map((m) => `${m.mois} : ${m.produits}${m.seuilNuagesPct !== null ? ` a <= ${m.seuilNuagesPct} %` : ""}`).join(" ; ")}) [${[...new Set(mesuresFenetre.map((m) => m.reference))].join(" ; ")}]`);
  }

  if (retenue) {
    raisons.push(`retenu : ${retenue.produit.identifiantFournisseur} (${retenue.produit.source}), score ${retenue.score}/100`);
    if (eau && pluvieuse) {
      alternative = {
        nature: "RADAR", proposee: classementRadar.length > 0, motif: "SAISON_DES_PLUIES",
        message: classementRadar.length > 0
          ? "La fenetre tombe surtout en saison des pluies (juin a septembre), ou l'optique est rare. Un complement radar Sentinel-1 est disponible ; le capteur retenu reste OPTIQUE, rien n'a ete change."
          : "La fenetre tombe surtout en saison des pluies ; aucun produit radar Sentinel-1 n'est disponible pour completer l'optique.",
        classement: classementRadar,
      };
      raisons.push(alternative.message);
    }
  } else {
    const c = causeDonnees();
    if (eau && classementRadar.length > 0) {
      alternative = {
        nature: "RADAR", proposee: true, motif: "AUCUN_OPTIQUE",
        message: `Aucun produit optique satisfaisant (${c.cause}). Le radar Sentinel-1 (resolution ${classementRadar[0].produit.resolutionNativeM} m, insensible aux nuages) peut servir pour ${params.phenomene} ; c'est un CHANGEMENT DE CAPTEUR, a confirmer.`,
        classement: classementRadar,
      };
      raisons.push(alternative.message);
      if (params.accepterAlternativeRadar) {
        retenue = classementRadar[0];
        raisons.push(`alternative radar acceptee par l'appelant : ${retenue.produit.identifiantFournisseur}, changementDeCapteur = true`);
      }
    } else if (!eau) {
      raisons.push(`pas d'alternative radar pour ${params.phenomene} : le radar Sentinel-1 (20 x 22 m) ne remplace pas l'optique pour ce phenomene`);
    }
    if (!retenue) {
      aucune = c;
      raisons.push(`aucune source satisfaisante : ${c.cause} (${c.details.join(" ; ")})`);
    }
  }

  const metadonnees: Record<string, unknown> = {
    regle: "selection-v1",
    parametres: {
      phenomene: params.phenomene, nuagesMaxPct: params.nuagesMax, resolutionMaxM: resMax,
      fenetre: { debut: new Date(debutMs).toISOString(), fin: new Date(finMs).toISOString(), jours: arrondi(fenetreJours, 1) },
      saisonDesPluies: { fractionFenetre: arrondi(pluies, 2), mois: MOIS_SAISON_PLUIES },
      ponderations: poids, accepterAlternativeRadar: params.accepterAlternativeRadar === true,
    },
    sources: params.sourcesDisponibles.map((s) => ({
      code: s.code, etat: s.etat, quota: s.quota ?? "INCONNU", produits: s.produits ? s.produits.length : null,
      blocage: blocages.find((b) => b.code === s.code)?.blocage ?? null, enCache: s.enCache === true,
    })),
    entonnoir: {
      produitsRendus: toutes.length, coupantLaZone: coupentLaZone, couvrantLaZone: apresZone, dansLaFenetre: apresFenetre,
      optiques: apresNatureOptique, radar: apresNatureRadar, optiquesResolutionSuffisante: optiqueRes.length,
      optiquesSousLeSeuilDeNuages: optiqueNuages.length, admissiblesApresDeduplication: classementOptique.length,
      radarAdmissibles: classementRadar.length,
    },
    ecartes: ecartes.reduce<Record<string, number>>((m, e) => { m[e.cause] = (m[e.cause] ?? 0) + 1; return m; }, {}),
    retenue: retenue ? {
      source: retenue.produit.source, identifiantFournisseur: retenue.produit.identifiantFournisseur, cleScene: retenue.produit.cleScene,
      score: retenue.score, changementDeCapteur: retenue.changementDeCapteur, raisons: retenue.raisons, aussiChez: retenue.aussiChez,
    } : null,
    causeAucune: aucune?.cause ?? null,
  };

  return { retenue, classement: classementOptique, alternative, aucune, ecartes, raisons, metadonnees };
}
