/**
 * Qualite des donnees de l'Aide a la decision (lot 2, cahier paragraphe 9.2) : compose les detecteurs EXISTANTS
 * (`qualite/detecteurs.service.ts`, LECTURE SEULE, transaction PostgreSQL READ ONLY) avec le bilan d'etat du reseau
 * (`kpi.noyau.ts`). Aucun detecteur n'est reecrit.
 *
 * COMPTES SEULS, JAMAIS DE LISTE D'ENTITES. Le service est appele avec `plafondParCode: 0` : la reponse porte des
 * comptes par code, par gravite et par region, pas les troncons en cause. Une anomalie de chainage de PK peut
 * viser un troncon d'une AUTRE region que celle du compte : n'en rendre que des comptes evite d'en designer un.
 *
 * PORTEE. Les detecteurs prennent UNE region ou `null` (pays entier). Un compte a plusieurs regions est donc servi
 * region par region, et seule la ligne de la region examinee est retenue a chaque passage : une anomalie qui lie
 * deux regions du perimetre (chainage de PK) n'est ainsi comptee qu'une fois, dans la region du troncon porteur.
 *
 * PERIMETRE DES TRONCONS : `reseau: "reference"`, le meme que les indicateurs (reseau classe saisi).
 */
import type { PrismaClient } from "@prisma/client";
import {
  CATALOGUE_CODES, CODES_ANOMALIE,
  type CodeAnomalie, type FamilleDetecteur, type GraviteDetecteur,
} from "../qualite/detecteurs.noyau";
import { etatDesLimites, nomsDesRegions } from "../qualite/detecteurs.depot";
import { NON_COUVERT, TOUTES_FAMILLES, lancerEnLectureSeule, type RapportDetecteurs, type SeuilRapporte } from "../qualite/detecteurs.service";
import { REGION_NON_RENSEIGNEE } from "../lib/localisation";
import { agregerEtat, arrondi, decrirePerimetre, type BilansReseau, type LigneEtat, type PerimetreDecrit } from "./kpi.noyau";
import type { Regions } from "./kpi.depot";

/** Codes qui DISENT « non evalue » : deja comptes comme troncons non evalues, ils n'entrent pas deux fois dans `donnees_a_confirmer`. */
export const CODES_ETAT_NON_EVALUE: readonly CodeAnomalie[] = ["ETAT_NON_EVALUE", "ETAT_ABSENT", "ETAT_INCONNU"];

/**
 * Familles executees par la SYNTHESE : un seul passage borne par troncon (PK, longueur, geometrie, etat). Les familles REGION
 * (intersection avec les limites administratives) et DOUBLON (auto-jointure spatiale) coutent un balayage entier : elles
 * sont reservees a GET /qualite et dites NON EXECUTEES dans la synthese. Mesures : voir `tests-integration/aide-decision-kpi`.
 */
export const FAMILLES_SYNTHESE: readonly FamilleDetecteur[] = ["PK", "LONGUEUR", "GEOMETRIE", "ETAT"];
const RANG: Record<GraviteDetecteur, number> = { BLOQUANTE: 0, A_TRAITER: 1, A_SURVEILLER: 2 };

export interface ResumeCodeQualite {
  code: CodeAnomalie;
  famille: FamilleDetecteur;
  gravite: GraviteDetecteur;
  description: string;
  correctionProposee: string;
  nombre: number;
  /** nombre / population examinee ; `null` si la population est nulle. */
  part: number | null;
}

export interface RegionAnomalies {
  regionId: number | null;
  regionNom: string | null;
  total: number;
  parCode: Partial<Record<CodeAnomalie, number>>;
}

export interface ResultatQualite {
  genereLe: string;
  /** Troncons du reseau classe saisi examines. */
  population: number;
  total: number;
  parGravite: Record<GraviteDetecteur, number>;
  parCode: ResumeCodeQualite[];
  parRegion: RegionAnomalies[];
  /** Codes des familles EXECUTEES sans aucune anomalie. */
  codesSansAnomalie: CodeAnomalie[];
  /** Familles executees. */
  famillesExecutees: FamilleDetecteur[];
  /** Familles NON executees : non demandees (cout) ou impossibles (REGION sans limite administrative en base). */
  famillesNonExecutees: FamilleDetecteur[];
  seuils: SeuilRapporte[];
  avertissements: string[];
}

export interface PassageDetecteurs {
  /** Region examinee par ce passage ; `null` = pays entier. */
  regionId: number | null;
  rapport: RapportDetecteurs;
}

const FAMILLES_PAR_CODE = (c: CodeAnomalie): FamilleDetecteur => CATALOGUE_CODES[c].famille;

/**
 * Fusionne les passages des detecteurs. PURE (testee sans base). Regle : un passage « pays entier » apporte toutes
 * ses lignes de region ; un passage de region R n'apporte QUE la ligne R (les lignes d'autres regions, issues d'un
 * chainage de PK dont le partenaire est en R, ne sont pas retenues).
 */
export function fusionnerPassages(
  passages: readonly PassageDetecteurs[],
  noms: ReadonlyMap<number, string>,
  famillesNonExecutees: readonly FamilleDetecteur[],
  genereLe: string,
): ResultatQualite {
  const parCode = new Map<CodeAnomalie, { nombre: number; gravite: GraviteDetecteur }>();
  const parRegion = new Map<number | null, RegionAnomalies>();
  const avertissements: string[] = [];
  let population = 0;
  let seuils: SeuilRapporte[] = [];

  for (const { regionId, rapport } of passages) {
    population += rapport.populationTronconsActifs;
    if (seuils.length === 0) seuils = rapport.seuils;
    for (const a of rapport.avertissements) if (!avertissements.includes(a)) avertissements.push(a);
    const graviteDuPassage = new Map(rapport.parCode.map((c) => [c.code, c.gravite]));
    const lignes = regionId === null ? rapport.parRegion : rapport.parRegion.filter((l) => l.regionId === regionId);
    for (const l of lignes) {
      const cle = l.regionId;
      const r = parRegion.get(cle) ?? { regionId: cle, regionNom: cle === null ? null : (noms.get(cle) ?? null), total: 0, parCode: {} };
      for (const [code, nombre] of Object.entries(l.parCode) as [CodeAnomalie, number][]) {
        if (!nombre) continue;
        r.total += nombre;
        r.parCode[code] = (r.parCode[code] ?? 0) + nombre;
        const g = graviteDuPassage.get(code) ?? CATALOGUE_CODES[code].gravite;
        const c = parCode.get(code) ?? { nombre: 0, gravite: g };
        c.nombre += nombre;
        if (RANG[g] < RANG[c.gravite]) c.gravite = g;
        parCode.set(code, c);
      }
      parRegion.set(cle, r);
    }
  }

  const codes: ResumeCodeQualite[] = [...parCode.entries()].map(([code, c]) => ({
    code, famille: FAMILLES_PAR_CODE(code), gravite: c.gravite,
    description: CATALOGUE_CODES[code].description, correctionProposee: CATALOGUE_CODES[code].correctionProposee,
    nombre: c.nombre, part: population > 0 ? arrondi(c.nombre / population, 4) : null,
  })).sort((x, y) => RANG[x.gravite] - RANG[y.gravite] || y.nombre - x.nombre || x.code.localeCompare(y.code));

  const parGravite: Record<GraviteDetecteur, number> = { BLOQUANTE: 0, A_TRAITER: 0, A_SURVEILLER: 0 };
  for (const c of codes) parGravite[c.gravite] += c.nombre;

  const presents = new Set(codes.map((c) => c.code));
  const nonExecutees = new Set(famillesNonExecutees);
  const famillesExecutees = TOUTES_FAMILLES.filter((f) => !nonExecutees.has(f));
  const codesSansAnomalie = CODES_ANOMALIE.filter((c) => !nonExecutees.has(FAMILLES_PAR_CODE(c)) && !presents.has(c));

  return {
    genereLe,
    population,
    total: codes.reduce((s, c) => s + c.nombre, 0),
    parGravite,
    parCode: codes,
    parRegion: [...parRegion.values()].sort((a, b) => (a.regionId ?? Number.MAX_SAFE_INTEGER) - (b.regionId ?? Number.MAX_SAFE_INTEGER)),
    codesSansAnomalie,
    famillesExecutees: [...famillesExecutees],
    famillesNonExecutees: TOUTES_FAMILLES.filter((f) => nonExecutees.has(f)),
    seuils,
    avertissements,
  };
}

/**
 * Execute les detecteurs pour la portee (un passage par region, ou un seul pour le pays entier), en LECTURE SEULE.
 * `maintenant` est injecte : la date courante n'est pas lue dans le noyau.
 */
export async function collecterQualite(
  prisma: Pick<PrismaClient, "$transaction" | "$queryRaw">, regions: Regions, maintenant: Date, familles: readonly FamilleDetecteur[] = TOUTES_FAMILLES,
): Promise<ResultatQualite> {
  const cibles: (number | null)[] = regions === null ? [null] : [...regions];
  const passages: PassageDetecteurs[] = [];
  // En serie : les detecteurs ouvrent chacun une transaction ; les enchainer evite de saisir plusieurs connexions du pool.
  for (const regionId of cibles) {
    passages.push({ regionId, rapport: await lancerEnLectureSeule(prisma, { portee: { regionId, reseau: "reference" }, familles, plafondParCode: 0, maintenant }) });
  }
  const noms = await nomsDesRegions(prisma);
  const nonDemandees = TOUTES_FAMILLES.filter((f) => !familles.includes(f));
  // REGION demandee mais impossible : aucune limite de niveau 1 en base (le service ne l'execute pas et le dit en avertissement).
  const impossibles: FamilleDetecteur[] = familles.includes("REGION") && (await etatDesLimites(prisma)).utilisables === 0 ? ["REGION"] : [];
  return fusionnerPassages(passages, noms, [...nonDemandees, ...impossibles], maintenant.toISOString());
}

const enCours = new Map<string, Promise<ResultatQualite>>();

/**
 * Meme calcul, partage entre appels SIMULTANES de meme portee : dix lecteurs qui ouvrent l'ecran ensemble ne lancent
 * pas dix balayages. Aucune mise en cache au-dela de l'appel en cours : le suivant recalcule.
 */
export function collecterQualitePartage(
  prisma: Pick<PrismaClient, "$transaction" | "$queryRaw">, regions: Regions, maintenant: Date, familles: readonly FamilleDetecteur[] = TOUTES_FAMILLES,
): Promise<ResultatQualite> {
  const cle = `${regions === null ? "pays" : [...regions].sort((a, b) => a - b).join(",")}|${[...familles].sort().join(",")}`;
  const deja = enCours.get(cle);
  if (deja) return deja;
  const p = collecterQualite(prisma, regions, maintenant, familles).finally(() => { enCours.delete(cle); });
  enCours.set(cle, p);
  return p;
}

// ===================================================================================== donnees a confirmer

/**
 * `donnees_a_confirmer` : troncons non evalues + anomalies du perimetre, SANS compter deux fois ce qui dit « non
 * evalue ». C'est un nombre d'ELEMENTS a confirmer, pas de troncons distincts : un meme troncon peut porter
 * plusieurs anomalies et compte alors plusieurs fois.
 */
export function donneesAConfirmer(tronconsNonEvalues: number, q: Pick<ResultatQualite, "parCode">): { valeur: number; anomalies: number } {
  const anomalies = q.parCode.filter((c) => !CODES_ETAT_NON_EVALUE.includes(c.code)).reduce((s, c) => s + c.nombre, 0);
  return { valeur: tronconsNonEvalues + anomalies, anomalies };
}

export function anomaliesHorsEtatNonEvalue(r: Pick<RegionAnomalies, "parCode">): number {
  return (Object.entries(r.parCode) as [CodeAnomalie, number][])
    .filter(([code]) => !CODES_ETAT_NON_EVALUE.includes(code)).reduce((s, [, v]) => s + v, 0);
}

// ===================================================================================== couverture par region

export interface CouvertureRegion {
  regionId: number;
  regionNom: string | null;
  /** La region « Non renseigné » n'est pas une region : ses troncons sont a localiser. */
  regionNonRenseignee: boolean;
  troncons: number;
  tronconsNonEvalues: number;
  /** tronconsNonEvalues / troncons ; `null` si aucun troncon saisi (couverture geographique nulle). */
  tauxNonEvalues: number | null;
  tronconsEtatNonValide: number;
  tronconsSansLongueurMetier: number;
  longueurConnueKm: number;
  nonEvalueKm: number;
  /** nonEvalueKm / longueurConnueKm ; `null` sans longueur connue. */
  partNonEvalueeKm: number | null;
  eligibleKm: number;
  /** Anomalies des detecteurs (tous codes) ; `null` si les detecteurs n'ont pas rendu. */
  anomalies: number | null;
  /** Anomalies hors celles qui disent « non evalue » (deja comptees a part). */
  anomaliesHorsEtatNonEvalue: number | null;
}

/**
 * Couverture et taux de non evalues par region, sur TOUTES les regions de la portee : une region sans troncon saisi
 * apparait avec 0 troncon et un taux `null`, pas absente (un trou de couverture est une information).
 */
export function couvertureParRegion(
  bilans: BilansReseau,
  noms: ReadonlyMap<number, string>,
  regionsEnPortee: Regions,
  anomalies: readonly RegionAnomalies[] | null,
): CouvertureRegion[] {
  const bilanDe = new Map(bilans.parRegion.map((r) => [r.regionId, r.bilan]));
  const ids = new Set<number>(regionsEnPortee === null ? noms.keys() : regionsEnPortee);
  for (const id of bilanDe.keys()) if (regionsEnPortee === null || regionsEnPortee.includes(id)) ids.add(id);
  const anomaliesDe = new Map((anomalies ?? []).filter((a) => a.regionId !== null).map((a) => [a.regionId as number, a]));
  const lignes: CouvertureRegion[] = [];
  for (const id of ids) {
    const b = bilanDe.get(id);
    const nom = noms.get(id) ?? null;
    const nonRenseignee = nom === REGION_NON_RENSEIGNEE;
    if (!b && nonRenseignee) continue;
    const troncons = b?.troncons ?? 0;
    const longueurConnueKm = b?.longueurConnueKm ?? 0;
    const nonEvalueKm = b?.nonEvalue.km ?? 0;
    const a = anomalies === null ? null : (anomaliesDe.get(id) ?? { regionId: id, regionNom: nom, total: 0, parCode: {} });
    lignes.push({
      regionId: id, regionNom: nom, regionNonRenseignee: nonRenseignee,
      troncons,
      tronconsNonEvalues: b?.nonEvalue.troncons ?? 0,
      tauxNonEvalues: troncons > 0 ? arrondi((b?.nonEvalue.troncons ?? 0) / troncons, 4) : null,
      tronconsEtatNonValide: b?.etatNonValide.troncons ?? 0,
      tronconsSansLongueurMetier: b?.tronconsSansLongueur ?? 0,
      longueurConnueKm: arrondi(longueurConnueKm, 3),
      nonEvalueKm: arrondi(nonEvalueKm, 3),
      partNonEvalueeKm: longueurConnueKm > 0 ? arrondi(nonEvalueKm / longueurConnueKm, 4) : null,
      eligibleKm: arrondi(b?.valide.km ?? 0, 3),
      anomalies: a === null ? null : a.total,
      anomaliesHorsEtatNonEvalue: a === null ? null : anomaliesHorsEtatNonEvalue(a),
    });
  }
  return lignes.sort((x, y) => (x.regionNom ?? "").localeCompare(y.regionNom ?? "", "fr") || x.regionId - y.regionId);
}

// ===================================================================================== ce que les detecteurs ne couvrent pas

/**
 * Ce que le rapport ne voit PAS. Reprend la liste du service des detecteurs puis ajoute ce que le cahier (paragraphe
 * 9.2) demande et qu'aucun detecteur ne fait. Chaque ligne est un constat de couverture, pas une anomalie : rien n'est
 * invente.
 */
export const NON_COUVERT_AIDE_DECISION: readonly string[] = [
  ...NON_COUVERT,
  "Contradictions entre le referentiel, les inspections, les chantiers et la source contractuelle (cahier 9.2) : aucun detecteur ne compare ces sources entre elles. L'etat d'un troncon n'est confronte ni a ses inspections ni aux chantiers qui le visent.",
  "Source inconnue : seule la PROVENANCE DE L'ETAT (ligne `valeurs_qualite`, champ `etat`) est lue pour dire si un etat est valide ; `sourceType` et `sourceReference` des troncons ne sont pas controles.",
  "Date de mesure absente : seule la date d'evaluation de l'ETAT est controlee (ETAT_SANS_DATE_EVALUATION, ETAT_DATE_FUTURE) ; celle de la longueur, du trafic, du revetement ne l'est pas.",
  "Donnees trop anciennes : aucun seuil de fraicheur n'est valide (decision ouverte) ; l'age de la derniere evaluation est rendu dans la synthese, sans verdict.",
  "Absence de validation terrain : le statut de validation du troncon (`statutValidation`) exclut un etat rejete ou a corriger du calcul des taux, mais n'est pas compte comme anomalie.",
  "Associations marche-chantier-troncon manquantes ou ambigues : aucun detecteur (suivi contractuel, lot 5). Un marche rattache a des chantiers de plusieurs regions n'est pas communique a un compte regional.",
  "Montants (marches, decomptes, previsions budgetaires) : aucun controle de qualite. Un montant absent est compte a part dans la synthese, jamais controle.",
  "Valeurs uniformes de maniere improbable (par exemple un revetement identique sur tous les troncons) : non detectees.",
  "Couverture par axe : aucune entite « axe » n'existe en base ; la couverture est rendue par region seulement.",
];

// ===================================================================================== reponse de GET /qualite

export interface DepotQualite {
  etat(regions: Regions, classes: readonly string[] | null): Promise<LigneEtat[]>;
  qualite(regions: Regions, maintenant: Date, familles: readonly FamilleDetecteur[]): Promise<ResultatQualite>;
  nomsRegions(): Promise<Map<number, string>>;
}

export interface ReponseQualite {
  calculeLe: string;
  statutDefinition: "PROVISOIRE";
  perimetre: PerimetreDecrit;
  filtres: { appliques: { regionId?: number }; nonAppliques: { nom: string; raison: string }[] };
  /** Le perimetre des troncons examines : le meme que celui des indicateurs. */
  reseau: { code: string; libelle: string; definition: string };
  detecteurs: {
    etat: "DISPONIBLE" | "PARTIEL" | "NON_DISPONIBLE";
    population: number | null;
    total: number | null;
    parGravite: Record<GraviteDetecteur, number> | null;
    parCode: ResumeCodeQualite[];
    codesSansAnomalie: CodeAnomalie[];
    famillesExecutees: FamilleDetecteur[];
    famillesNonExecutees: FamilleDetecteur[];
    seuils: SeuilRapporte[];
    avertissements: string[];
  };
  couvertureParRegion: CouvertureRegion[];
  etatDuReseau: {
    troncons: number;
    tronconsNonEvalues: number;
    tronconsEtatNonValide: number;
    tronconsSansLongueurMetier: number;
    longueurConnueKm: number;
    eligibleKm: number;
    nonEvalueKm: number;
    partNonEvaluee: number | null;
  };
  donneesAConfirmer: { valeur: number | null; formule: string };
  nonCouvert: readonly string[];
  avertissements: string[];
  consultatif: string;
}

/**
 * Assemble la reponse de la qualite : detecteurs (comptes par code, gravite, region), couverture et taux de non
 * evalues par region, et ce qui n'est pas couvert. Les detecteurs sont lus pour le perimetre du compte ; si leur
 * execution echoue, la reponse le dit (`NON_DISPONIBLE`) et rend quand meme la couverture, qui vient d'une autre lecture.
 */
export async function composerQualite(
  depot: DepotQualite,
  ctx: { regions: Regions; maintenant: Date; regionDemandee: number | null; filtresNonAppliques: { nom: string; raison: string }[] },
): Promise<ReponseQualite> {
  const { regions, maintenant } = ctx;
  const noms = await depot.nomsRegions();
  const bilans = agregerEtat((await depot.etat(regions, null)).filter((l) => regions === null || regions.includes(l.regionId)));
  let q: ResultatQualite | null = null;
  try {
    q = await depot.qualite(regions, maintenant, TOUTES_FAMILLES);
  } catch (err) {
    console.error("[aide-decision] detecteurs de qualite en echec :", err instanceof Error ? err.message : err);
  }
  const t = bilans.total;
  const perimetreKm = t.longueurConnueKm;
  const aConfirmer = q ? donneesAConfirmer(t.nonEvalue.troncons, q).valeur : null;
  const avertissements: string[] = [
    "Les seuils des détecteurs sont PROVISOIRES : un compte change si un seuil change. Aucun détecteur ne dit ce qui est juste, seulement ce qui s'écarte d'un seuil nommé.",
    "Consultatif, non engageant : cette qualité décrit les données saisies, elle ne corrige rien.",
  ];
  if (!q) avertissements.unshift("Les détecteurs de qualité n'ont pas pu être exécutés (incident journalisé) : la couverture reste rendue, les anomalies non.");
  if (regions !== null && regions.length > 1) avertissements.push("Compte à plusieurs régions : les détecteurs sont lancés région par région ; une anomalie qui lie deux régions du périmètre est comptée dans la région du tronçon porteur.");
  return {
    calculeLe: maintenant.toISOString(),
    statutDefinition: "PROVISOIRE",
    perimetre: decrirePerimetre(regions, noms),
    filtres: { appliques: ctx.regionDemandee !== null ? { regionId: ctx.regionDemandee } : {}, nonAppliques: ctx.filtresNonAppliques },
    reseau: {
      code: "RESEAU_CLASSE_SAISI",
      libelle: "Réseau classé saisi",
      definition: "Tronçons non supprimés dont la référence de source n'est ni « voirie_locale: » ni « hors_territoire: » (lib/reseau.ts) : le même périmètre que les indicateurs de la synthèse.",
    },
    detecteurs: {
      etat: !q ? "NON_DISPONIBLE" : q.famillesNonExecutees.length > 0 || q.avertissements.length > 0 ? "PARTIEL" : "DISPONIBLE",
      population: q ? q.population : null,
      total: q ? q.total : null,
      parGravite: q ? q.parGravite : null,
      parCode: q ? q.parCode : [],
      codesSansAnomalie: q ? q.codesSansAnomalie : [],
      famillesExecutees: q ? q.famillesExecutees : [],
      famillesNonExecutees: q ? q.famillesNonExecutees : [],
      seuils: q ? q.seuils : [],
      avertissements: q ? q.avertissements : [],
    },
    couvertureParRegion: couvertureParRegion(bilans, noms, regions, q ? q.parRegion : null),
    etatDuReseau: {
      troncons: t.troncons, tronconsNonEvalues: t.nonEvalue.troncons, tronconsEtatNonValide: t.etatNonValide.troncons,
      tronconsSansLongueurMetier: t.tronconsSansLongueur, longueurConnueKm: arrondi(perimetreKm, 3), eligibleKm: arrondi(t.valide.km, 3),
      nonEvalueKm: arrondi(t.nonEvalue.km, 3), partNonEvaluee: perimetreKm > 0 ? arrondi(t.nonEvalue.km / perimetreKm, 4) : null,
    },
    donneesAConfirmer: {
      valeur: t.troncons === 0 ? null : aConfirmer,
      formule: "tronçons non évalués + anomalies des détecteurs hors codes « non évalué » (nombre d'éléments, pas de tronçons distincts)",
    },
    nonCouvert: NON_COUVERT_AIDE_DECISION,
    avertissements,
    consultatif: "Indicateurs consultatifs, non engageants.",
  };
}
