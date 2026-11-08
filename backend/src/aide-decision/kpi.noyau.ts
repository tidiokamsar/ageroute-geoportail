/**
 * NOYAU PUR des indicateurs de l'Aide a la decision (lot 2) : AUCUN import applicatif, aucune horloge, aucun acces
 * a la base. Les formules vivent ici, la lecture SQL dans `kpi.depot.ts`, l'assemblage dans `synthese.ts`.
 *
 * CE QUE CE FICHIER REMPLACE : le calcul de `GET /api/dashboard/decision` (dashboard.routes.ts), qui divisait une
 * somme sur TOUS les troncons (voirie promue comprise, environ 185 000 km) par la longueur du reseau classe : un
 * pourcentage pouvait depasser 100 %, et les troncons non evalues restaient au denominateur. Ici :
 *
 *  - numerateur ET denominateur sont calcules sur LA MEME population (un seul passage sur les memes lignes) ;
 *  - la longueur est la longueur METIER (`longueurKm`), jamais la geometrique ; une longueur absente, nulle, non
 *    finie ou seulement DERIVEE de la geometrie vaut « inconnue » : le troncon est compte, sa longueur n'est jamais
 *    additionnee comme si elle valait 0 ;
 *  - un troncon NON_EVALUE (ou sans etat) n'est ni au numerateur ni au denominateur : il est compte a part ;
 *  - un etat renseigne mais non valide (voir `PARAMETRES_KPI.exigenceEtat`) est lui aussi compte a part ;
 *  - quand le denominateur est nul, la valeur est `null`, jamais 0.
 */

// ===================================================================================== parametres PROVISOIRES

export const ETATS_CONNUS = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"] as const;
export const CLASSES_EVALUEES = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE"] as const;
export type ClasseEvaluee = (typeof CLASSES_EVALUEES)[number];

/**
 * Regle d'« etat valide ». Deux niveaux, le premier est le defaut :
 *  - `OBSERVE_SEULEMENT` : seul un etat CONSTATE sur le terrain est valide, c'est-a-dire une ligne
 *    `valeurs_qualite` (champ `etat`) au statut OBSERVED avec une date de constat. Source : `lib/qualite.ts` et
 *    `inspections.service.ts` (« une inspection est le SEUL evenement qui produise une valeur reellement
 *    constatee ») ; la migration 20260902110000 (« un BON de cette annee et un BON d'il y a dix ans occupent la
 *    meme case ») ; `troncons.service.ts` (« un etat DECLARE n'est pas un etat CONSTATE »).
 *  - `NON_CONTESTE` : tout etat renseigne que rien ne contredit (OBSERVED, importe non verifie, derive, ou sans
 *    ligne de provenance) est valide. Plus permissif : il compte comme valides des etats d'import sans date.
 */
export type ExigenceEtat = "OBSERVE_SEULEMENT" | "NON_CONTESTE";

export interface ParametresKpi {
  /** Version du jeu de parametres, reprise dans chaque reponse : un chiffre se relit avec la regle qui l'a produit. */
  readonly version: string;
  readonly statutDefinition: "PROVISOIRE" | "VALIDEE";
  readonly classesDegradees: readonly ClasseEvaluee[];
  readonly classesCritiques: readonly ClasseEvaluee[];
  readonly exigenceEtat: ExigenceEtat;
  /** Nombre maximal de bailleurs rendus dans la ventilation budgetaire (le reste est agrege et dit). */
  readonly limiteBailleurs: number;
  readonly origine: string;
}

/**
 * PARAMETRES PROVISOIRES. Aucune de ces valeurs n'est une decision d'AGEROUTE : « degrade » et « critique » ne sont
 * definis nulle part dans le depot (LOT-AD-00-RAPPORT, section 3), et le cahier (paragraphe 9.1) les range parmi les
 * definitions « a confirmer ». Le mecanisme de parametres versionnes du moteur de programmation
 * (`parametres_programmation`, `programmation/parametres.noyau.ts`) porte des ponderations de risque et une
 * correspondance etat vers risque, mais aucune notion de classe « degradee » : l'etendre demanderait de modifier son
 * noyau et une migration, hors du perimetre de ce lot. Ces valeurs vivent donc en code, nommees, versionnees,
 * etiquetees PROVISOIRE, et rendues dans chaque reponse.
 */
export const PARAMETRES_KPI: ParametresKpi = Object.freeze({
  version: "kpi-provisoire-1",
  statutDefinition: "PROVISOIRE",
  classesDegradees: Object.freeze(["MAUVAIS", "CRITIQUE"] as ClasseEvaluee[]),
  classesCritiques: Object.freeze(["CRITIQUE"] as ClasseEvaluee[]),
  exigenceEtat: "OBSERVE_SEULEMENT",
  limiteBailleurs: 20,
  origine: "Convention de travail du 26/10/2026 (contrat AD, paragraphe 5) : classes degradees = MAUVAIS et CRITIQUE ; critique = CRITIQUE ; etat valide = etat constate et date. A faire confirmer par la Direction technique.",
});

// ===================================================================================== lignes lues

/** Provenance d'un etat d'apres `valeurs_qualite` (champ `etat`) ; `SANS_LIGNE` quand aucune ligne n'existe. */
export const PROVENANCES = ["OBSERVED", "IMPORTED_UNVERIFIED", "DERIVED", "CONFLICTING", "UNKNOWN", "SANS_LIGNE"] as const;

/** Un groupe de troncons du perimetre : memes dimensions categorielles, comptes et longueur metier sommee cote SQL. */
export interface LigneEtat {
  regionId: number;
  /** `troncons.etat` ; `null` ou hors nomenclature = non evalue. */
  etat: string | null;
  provenance: string;
  /** La ligne de provenance porte une date de constat (`observedAt`). */
  observeDate: boolean;
  /** `troncons.statutValidation` (peut etre nul). */
  statutValidation: string | null;
  /** Longueur metier CONNUE : `longueurKm` finie et > 0, et non marquee DERIVED dans `valeurs_qualite`. */
  longueurConnue: boolean;
  nb: number;
  /** Somme de `longueurKm` des troncons du groupe a longueur connue ; 0 sinon (jamais une inconnue sommee). */
  km: number;
  derniereEvaluation: Date | null;
  plusAncienneEvaluation: Date | null;
}

// ===================================================================================== classement d'un etat

export type MotifNonValide =
  | "TRONCON_REJETE_OU_A_CORRIGER"
  | "ETAT_EN_CONFLIT"
  | "ETAT_INCOHERENT_AVEC_LA_QUALITE"
  | "ETAT_NON_CONSTATE"
  | "CONSTAT_SANS_DATE";

export type Classement =
  | { categorie: "NON_EVALUE" }
  | { categorie: "NON_VALIDE"; classe: ClasseEvaluee; motif: MotifNonValide }
  | { categorie: "VALIDE"; classe: ClasseEvaluee };

const EST_CLASSE = (e: string): e is ClasseEvaluee => (CLASSES_EVALUEES as readonly string[]).includes(e);

/** Ordre des verifications = du motif le plus specifique au plus general ; echoue FERME (une provenance inconnue n'est pas valide). */
export function classerEtat(
  l: Pick<LigneEtat, "etat" | "provenance" | "observeDate" | "statutValidation">,
  p: Pick<ParametresKpi, "exigenceEtat"> = PARAMETRES_KPI,
): Classement {
  if (l.etat === null || l.etat === undefined || !EST_CLASSE(l.etat)) return { categorie: "NON_EVALUE" };
  const classe = l.etat;
  const nonValide = (motif: MotifNonValide): Classement => ({ categorie: "NON_VALIDE", classe, motif });
  if (l.statutValidation === "REJETE" || l.statutValidation === "A_CORRIGER") return nonValide("TRONCON_REJETE_OU_A_CORRIGER");
  if (l.provenance === "CONFLICTING") return nonValide("ETAT_EN_CONFLIT");
  // Un etat renseigne alors que la ligne de qualite dit « inconnu » : l'un des deux est faux (edition manuelle apres import).
  if (l.provenance === "UNKNOWN") return nonValide("ETAT_INCOHERENT_AVEC_LA_QUALITE");
  if (p.exigenceEtat === "OBSERVE_SEULEMENT") {
    if (l.provenance !== "OBSERVED") return nonValide("ETAT_NON_CONSTATE");
    if (!l.observeDate) return nonValide("CONSTAT_SANS_DATE");
    return { categorie: "VALIDE", classe };
  }
  if (l.provenance === "OBSERVED" || l.provenance === "IMPORTED_UNVERIFIED" || l.provenance === "DERIVED" || l.provenance === "SANS_LIGNE") {
    return { categorie: "VALIDE", classe };
  }
  return nonValide("ETAT_INCOHERENT_AVEC_LA_QUALITE");
}

// ===================================================================================== bilan par region

interface Cumul { troncons: number; km: number }
type ParClasse = Record<ClasseEvaluee, Cumul>;

export interface Bilan {
  /** Tous les troncons du perimetre. Egal a nonEvalue + etatNonValide + valide. */
  troncons: number;
  /** Troncons dont la longueur metier est inconnue (dans toutes les categories). */
  tronconsSansLongueur: number;
  /** Somme de la longueur metier CONNUE, tous etats confondus. */
  longueurConnueKm: number;
  nonEvalue: Cumul & { tronconsSansLongueur: number };
  etatNonValide: Cumul & { tronconsSansLongueur: number; parClasse: ParClasse; parMotif: Partial<Record<MotifNonValide, Cumul>> };
  valide: Cumul & { tronconsSansLongueur: number; parClasse: ParClasse };
  /** Dates d'evaluation des seuls troncons a etat valide. */
  derniereEvaluationValide: Date | null;
  plusAncienneEvaluationValide: Date | null;
}

const parClasseVide = (): ParClasse => ({ BON: { troncons: 0, km: 0 }, MOYEN: { troncons: 0, km: 0 }, MAUVAIS: { troncons: 0, km: 0 }, CRITIQUE: { troncons: 0, km: 0 } });

export function bilanVide(): Bilan {
  return {
    troncons: 0, tronconsSansLongueur: 0, longueurConnueKm: 0,
    nonEvalue: { troncons: 0, km: 0, tronconsSansLongueur: 0 },
    etatNonValide: { troncons: 0, km: 0, tronconsSansLongueur: 0, parClasse: parClasseVide(), parMotif: {} },
    valide: { troncons: 0, km: 0, tronconsSansLongueur: 0, parClasse: parClasseVide() },
    derniereEvaluationValide: null, plusAncienneEvaluationValide: null,
  };
}

const plusRecente = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a.getTime() >= b.getTime() ? a : b);
const plusAncienne = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a.getTime() <= b.getTime() ? a : b);

function ajouter(b: Bilan, l: LigneEtat, c: Classement): void {
  // Longueur « connue » cote SQL implique une somme finie et > 0. Si la ligne dit connue sans somme exploitable, elle est
  // traitee comme INCONNUE (jamais d'inconnu additionne, jamais de longueur fantome).
  const connue = l.longueurConnue && Number.isFinite(l.km) && l.km > 0;
  const km = connue ? l.km : 0;
  const sans = connue ? 0 : l.nb;
  b.troncons += l.nb;
  b.tronconsSansLongueur += sans;
  b.longueurConnueKm += km;
  if (c.categorie === "NON_EVALUE") {
    b.nonEvalue.troncons += l.nb; b.nonEvalue.km += km; b.nonEvalue.tronconsSansLongueur += sans;
  } else if (c.categorie === "NON_VALIDE") {
    const e = b.etatNonValide;
    e.troncons += l.nb; e.km += km; e.tronconsSansLongueur += sans;
    e.parClasse[c.classe].troncons += l.nb; e.parClasse[c.classe].km += km;
    const m = (e.parMotif[c.motif] ??= { troncons: 0, km: 0 });
    m.troncons += l.nb; m.km += km;
  } else {
    const v = b.valide;
    v.troncons += l.nb; v.km += km; v.tronconsSansLongueur += sans;
    v.parClasse[c.classe].troncons += l.nb; v.parClasse[c.classe].km += km;
    b.derniereEvaluationValide = plusRecente(b.derniereEvaluationValide, l.derniereEvaluation);
    b.plusAncienneEvaluationValide = plusAncienne(b.plusAncienneEvaluationValide, l.plusAncienneEvaluation);
  }
}

export interface BilansReseau {
  total: Bilan;
  /** Une entree par region presente dans les lignes, triee par identifiant. */
  parRegion: { regionId: number; bilan: Bilan }[];
}

/** UN passage sur les memes lignes alimente le total ET chaque region : numerateur et denominateur ne peuvent pas diverger de perimetre. */
export function agregerEtat(lignes: readonly LigneEtat[], p: ParametresKpi = PARAMETRES_KPI): BilansReseau {
  const total = bilanVide();
  const regions = new Map<number, Bilan>();
  for (const l of lignes) {
    if (!Number.isFinite(l.nb) || l.nb <= 0) continue;
    const c = classerEtat(l, p);
    ajouter(total, l, c);
    let r = regions.get(l.regionId);
    if (!r) { r = bilanVide(); regions.set(l.regionId, r); }
    ajouter(r, l, c);
  }
  return { total, parRegion: [...regions.entries()].sort((a, b) => a[0] - b[0]).map(([regionId, bilan]) => ({ regionId, bilan })) };
}

// ===================================================================================== formules

export const arrondi = (v: number, d: number): number => { const f = 10 ** d; return Math.round(v * f) / f; };

export type EtatDisponibilite = "DISPONIBLE" | "PARTIEL" | "NON_DISPONIBLE";

export interface IndicateursReseau {
  /** Denominateur des taux : longueur metier des troncons a etat VALIDE. */
  eligibleKm: number;
  /** Longueur metier des troncons a etat renseigne (valide ou non). */
  evalueKm: number;
  /** Longueur metier des troncons NON_EVALUE ou sans etat. */
  nonEvalueKm: number;
  /** Longueur metier des troncons a etat renseigne mais non valide (evalueKm - eligibleKm). */
  etatNonValideKm: number;
  /** evalueKm + nonEvalueKm : toute la longueur metier connue du perimetre. */
  perimetreKm: number;
  /** nonEvalueKm / perimetreKm ; `null` si le perimetre n'a aucune longueur connue. */
  partNonEvaluee: number | null;
  /** eligibleKm / perimetreKm ; `null` si le perimetre n'a aucune longueur connue. */
  couvertureEtatPart: number | null;
  degradeKm: number;
  critiqueKm: number;
  degradePct: number | null;
  critiquePct: number | null;
  etat: EtatDisponibilite;
}

const somme = (c: ParClasse, classes: readonly ClasseEvaluee[]): number => classes.reduce((s, k) => s + c[k].km, 0);

export function indicateursReseau(b: Bilan, p: ParametresKpi = PARAMETRES_KPI): IndicateursReseau {
  const eligibleKm = b.valide.km;
  const etatNonValideKm = b.etatNonValide.km;
  const evalueKm = eligibleKm + etatNonValideKm;
  const nonEvalueKm = b.nonEvalue.km;
  const perimetreKm = evalueKm + nonEvalueKm;
  const degradeKm = somme(b.valide.parClasse, p.classesDegradees);
  const critiqueKm = somme(b.valide.parClasse, p.classesCritiques);
  // Le numerateur est une sous-somme des classes du denominateur : le min() ne fait que garder 100 contre un arrondi flottant.
  const pct = (num: number): number | null => (eligibleKm > 0 ? Math.min(100, arrondi((100 * num) / eligibleKm, 1)) : null);
  const incomplet = nonEvalueKm > 0 || etatNonValideKm > 0 || b.tronconsSansLongueur > 0 || b.nonEvalue.troncons > 0 || b.etatNonValide.troncons > 0;
  return {
    eligibleKm, evalueKm, nonEvalueKm, etatNonValideKm, perimetreKm,
    partNonEvaluee: perimetreKm > 0 ? arrondi(nonEvalueKm / perimetreKm, 4) : null,
    couvertureEtatPart: perimetreKm > 0 ? arrondi(eligibleKm / perimetreKm, 4) : null,
    degradeKm, critiqueKm,
    degradePct: pct(degradeKm), critiquePct: pct(critiqueKm),
    etat: eligibleKm <= 0 ? "NON_DISPONIBLE" : incomplet ? "PARTIEL" : "DISPONIBLE",
  };
}

export const LIBELLE_EXIGENCE: Record<ExigenceEtat, string> = {
  OBSERVE_SEULEMENT: "état constaté (ligne de qualité OBSERVED datée), tronçon ni rejeté ni à corriger, état non contesté",
  NON_CONTESTE: "état renseigné, tronçon ni rejeté ni à corriger, état non contesté (importé non vérifié accepté)",
};

const km = (v: number): string => `${arrondi(v, 2).toLocaleString("fr-FR")} km`;
const n = (v: number, un: string, plusieurs = `${un}s`): string => `${v} ${v > 1 ? plusieurs : un}`;

/** Avertissements lisibles : ce qui est exclu, ce qui est compte a part, jamais passe sous silence. */
export function avertissementsEtat(b: Bilan, ind: IndicateursReseau, p: ParametresKpi = PARAMETRES_KPI): string[] {
  const a: string[] = [];
  if (b.troncons === 0) {
    a.push("Aucun tronçon du réseau classé saisi dans ce périmètre.");
    return a;
  }
  if (ind.eligibleKm <= 0) {
    a.push(`Aucun tronçon à état valide et longueur métier connue : le taux n'est pas calculable (règle « ${LIBELLE_EXIGENCE[p.exigenceEtat]} »).`);
  }
  if (b.nonEvalue.troncons > 0) {
    a.push(`${n(b.nonEvalue.troncons, "tronçon non évalué", "tronçons non évalués")} (${km(ind.nonEvalueKm)} de longueur métier connue) comptés à part, exclus du dénominateur.`);
  }
  if (b.etatNonValide.troncons > 0) {
    a.push(`${n(b.etatNonValide.troncons, "tronçon")} à état renseigné mais non valide (${km(ind.etatNonValideKm)}), exclus du dénominateur : règle « ${LIBELLE_EXIGENCE[p.exigenceEtat]} ».`);
  }
  if (b.tronconsSansLongueur > 0) {
    a.push(`${n(b.tronconsSansLongueur, "tronçon")} sans longueur métier (absente, nulle, non finie ou seulement dérivée de la géométrie) : comptés mais jamais additionnés ; la longueur géométrique n'est pas substituée.`);
  }
  a.push(`Définition PROVISOIRE (paramètres ${p.version}) : dégradé = ${p.classesDegradees.join(" + ")}, critique = ${p.classesCritiques.join(" + ")}.`);
  return a;
}

// ===================================================================================== montants GNF (chaines)

/** Somme exacte de montants GNF donnes en chaines : jamais un nombre JS (au-dela de 2^53). */
export function sommeGnf(montants: readonly (string | bigint)[]): string {
  return montants.reduce<bigint>((s, m) => s + BigInt(m), 0n).toString();
}

/** Difference bornee a zero, en chaines. */
export function differenceGnf(a: string, b: string): string {
  const d = BigInt(a) - BigInt(b);
  return (d < 0n ? 0n : d).toString();
}

/** Le nombre JS equivalent d'un montant en chaine, seulement s'il est exact ; sinon `null` (le lecteur prend la chaine). */
export function nombreSur(gnf: string): number | null {
  const v = Number(gnf);
  return Number.isSafeInteger(v) ? v : null;
}

// ===================================================================================== fraicheur

export function ageEnJours(date: Date | null, maintenant: Date): number | null {
  if (date === null) return null;
  return Math.max(0, Math.floor((maintenant.getTime() - date.getTime()) / 86_400_000));
}

// ===================================================================================== etat d'un KPI de comptage

/** Un comptage dont la source est vide n'est pas un zero : il n'y a rien a compter, et on le dit. */
export function etatComptage(valeur: number | null, sourceVide: boolean): EtatDisponibilite {
  if (valeur === null || sourceVide) return "NON_DISPONIBLE";
  return "DISPONIBLE";
}

// ===================================================================================== perimetre decrit

export interface PerimetreDecrit {
  national: boolean;
  libelle: string;
  /** La region quand le perimetre en compte une seule ; `null` sinon. */
  regionId: number | null;
  regions: { id: number; nom: string | null }[];
}

/**
 * Dit le perimetre d'un calcul. Un perimetre regional ne se dit JAMAIS « pays » : le libelle porte les noms des
 * regions, pour qu'un total regional ne soit pas lu comme un total national.
 */
export function decrirePerimetre(regions: readonly number[] | null, noms: ReadonlyMap<number, string>): PerimetreDecrit {
  if (regions === null) return { national: true, libelle: "Ensemble du pays", regionId: null, regions: [] };
  const ids = [...regions].sort((a, b) => a - b);
  const nom = (id: number): string => noms.get(id) ?? String(id);
  const unique = ids.length === 1 ? ids[0] : null;
  return {
    national: false,
    libelle: unique !== null ? `Région ${nom(unique)}` : `Régions du périmètre : ${ids.map(nom).join(", ")}`,
    regionId: unique,
    regions: ids.map((id) => ({ id, nom: noms.get(id) ?? null })),
  };
}
