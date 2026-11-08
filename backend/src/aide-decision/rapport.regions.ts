/**
 * RAPPORT « ETAT DU RESEAU PAR REGION » (lot 6) : km par etat, non evalue A PART, taux sur un denominateur qui exclut
 * les non evalues, numerateur et denominateur sur LA MEME population.
 *
 * ADAPTATEUR MINCE, SANS DUPLICATION DE FORMULE. Les formules et la lecture SQL sont celles du lot 2
 * (`kpi.noyau.ts` : `agregerEtat`, `indicateursReseau`, `avertissementsEtat` ; `kpi.depot.ts` : `lireEtatReseau`).
 * Ce fichier ne fait que les mettre en lignes de tableau. Ce que le rapport heritage `/api/dashboard/rapport-regions`
 * faisait de travers et que celui-ci corrige : il sommait les km de TOUS les troncons non supprimes (voirie promue
 * comprise, une centaine de milliers de km) sans portee territoriale, et rangeait en « bon / moyen / mauvais » des etats
 * jamais constates. Ici le perimetre est le RESEAU CLASSE saisi (la voirie locale promue et les troncons hors territoire
 * en sont exclus, et le rapport le dit) ; un etat n'entre dans un taux que s'il est VALIDE au sens du parametre PROVISOIRE
 * du lot 2 ; les autres sont comptes a part (non evalue, etat renseigne mais non valide).
 *
 * LES KM SONT DES LONGUEURS METIER (`longueurKm`) : un troncon sans longueur metier est COMPTE mais jamais additionne, et la
 * longueur geometrique ne s'y substitue pas (contrat, principe 4). Un groupe de troncons dont AUCUN n'a de longueur n'a pas « 0 km » :
 * ses km sont `null` (inconnus) ; une somme partielle reste un nombre, signalee par `longueurDisponibilite` (PARTIELLE) et `disponibilite`.
 */
import {
  PARAMETRES_KPI, agregerEtat, avertissementsEtat, decrirePerimetre, indicateursReseau, arrondi,
  type Bilan, type IndicateursReseau, type LigneEtat, type ParametresKpi, type PerimetreDecrit,
} from "./kpi.noyau";
import type { Colonne, JeuDonnees } from "./export.noyau";

export interface DepotRapport {
  etat(regions: readonly number[] | null, classes: readonly string[] | null): Promise<LigneEtat[]>;
  nomsRegions(): Promise<Map<number, string>>;
}

/**
 * Les longueurs de la ligne sont-elles toutes connues ? COMPLETE : chaque troncon a une longueur metier. PARTIELLE : certains n'en ont pas, les
 * km sont des MINORANTS. ABSENTE : aucun n'en a, les km sont inconnus (null). SANS_OBJET : aucun troncon dans la ligne.
 */
export type DisponibiliteLongueur = "COMPLETE" | "PARTIELLE" | "ABSENTE" | "SANS_OBJET";

export interface LigneRapportRegion {
  regionId: number | null;
  region: string;
  troncons: number;
  tronconsSansLongueurMetier: number;
  /** Dont troncons a etat VALIDE sans longueur metier : ils sont dans les classes ci-dessous (comptes) mais n'y ajoutent aucun km. */
  tronconsValidesSansLongueur: number;
  longueurDisponibilite: DisponibiliteLongueur;
  /**
   * Longueur metier des troncons a etat VALIDE, par classe. `null` = INCONNUE : la classe compte des troncons mais AUCUN n'a de longueur
   * metier (jamais « 0 km »). Zero seulement si la classe n'a aucun troncon. Une somme partielle (certains troncons sans longueur) reste un
   * nombre : `longueurDisponibilite` et `disponibilite` disent qu'elle est partielle.
   */
  kmBon: number | null;
  kmMoyen: number | null;
  kmMauvais: number | null;
  kmCritique: number | null;
  /** Etat renseigne mais non valide (conteste, non constate...) : a part, exclu du denominateur. `null` : troncons sans aucune longueur. */
  kmEtatNonValide: number | null;
  /** Non evalue : a part, exclu du denominateur. `null` : troncons sans aucune longueur. */
  kmNonEvalue: number | null;
  tronconsNonEvalues: number;
  /** Denominateur des taux. `null` : des troncons a etat valide mais aucune longueur connue. */
  kmEligible: number | null;
  /** `null` : des troncons mais aucune longueur connue. */
  kmPerimetre: number | null;
  degradePct: number | null;
  critiquePct: number | null;
  partNonEvaluee: number | null;
  derniereEvaluation: string | null;
  disponibilite: IndicateursReseau["etat"];
}

export interface RapportRegions {
  calculeLe: string;
  perimetre: PerimetreDecrit;
  parametres: { version: string; statutDefinition: string; classesDegradees: readonly string[]; classesCritiques: readonly string[]; exigenceEtat: string; origine: string };
  regions: LigneRapportRegion[];
  total: LigneRapportRegion;
  avertissements: string[];
  derniereEvaluationLe: string | null;
}

const jour = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
const km2 = (v: number): number => arrondi(v, 2);

/**
 * Km d'un groupe de troncons. Une longueur « connue » est strictement positive (voir `ajouter`, kpi.noyau) : un groupe qui compte des troncons
 * pour 0 km n'en a donc AUCUN de mesure. Son km est inconnu (null), pas « 0 km ». Un groupe vide vaut 0.
 */
const kmOuInconnu = (troncons: number, km: number): number | null => (troncons > 0 && km <= 0 ? null : km2(km));

function disponibiliteLongueur(b: Bilan): DisponibiliteLongueur {
  if (b.troncons === 0) return "SANS_OBJET";
  if (b.tronconsSansLongueur === 0) return "COMPLETE";
  return b.tronconsSansLongueur >= b.troncons ? "ABSENTE" : "PARTIELLE";
}

function ligneDe(regionId: number | null, nom: string, b: Bilan, p: ParametresKpi): LigneRapportRegion {
  const ind = indicateursReseau(b, p);
  const classe = b.valide.parClasse;
  return {
    regionId, region: nom, troncons: b.troncons, tronconsSansLongueurMetier: b.tronconsSansLongueur,
    tronconsValidesSansLongueur: b.valide.tronconsSansLongueur, longueurDisponibilite: disponibiliteLongueur(b),
    kmBon: kmOuInconnu(classe.BON.troncons, classe.BON.km), kmMoyen: kmOuInconnu(classe.MOYEN.troncons, classe.MOYEN.km),
    kmMauvais: kmOuInconnu(classe.MAUVAIS.troncons, classe.MAUVAIS.km), kmCritique: kmOuInconnu(classe.CRITIQUE.troncons, classe.CRITIQUE.km),
    kmEtatNonValide: kmOuInconnu(b.etatNonValide.troncons, ind.etatNonValideKm), kmNonEvalue: kmOuInconnu(b.nonEvalue.troncons, ind.nonEvalueKm),
    tronconsNonEvalues: b.nonEvalue.troncons,
    kmEligible: kmOuInconnu(b.valide.troncons, ind.eligibleKm), kmPerimetre: kmOuInconnu(b.troncons, ind.perimetreKm),
    degradePct: ind.degradePct, critiquePct: ind.critiquePct,
    partNonEvaluee: ind.partNonEvaluee, derniereEvaluation: jour(b.derniereEvaluationValide), disponibilite: ind.etat,
  };
}

/** Pur : lignes d'etat (du lot 2) vers rapport. `regions` = portee du compte (`null` = pays entier). */
export function construireRapportRegions(
  lignes: readonly LigneEtat[], noms: ReadonlyMap<number, string>, regions: readonly number[] | null,
  maintenant: Date, p: ParametresKpi = PARAMETRES_KPI,
): RapportRegions {
  const bilans = agregerEtat(lignes, p);
  const parRegion = bilans.parRegion
    .map(({ regionId, bilan }) => ligneDe(regionId, noms.get(regionId) ?? `Region ${regionId}`, bilan, p))
    .sort((a, b) => a.region.localeCompare(b.region, "fr"));
  const total = ligneDe(null, regions === null ? "TOTAL national" : "TOTAL du perimetre", bilans.total, p);
  const avertissements = [
    "Perimetre : reseau classe saisi. La voirie locale promue (voirie_locale:) et les troncons hors territoire (hors_territoire:) en sont exclus.",
    "Les kilometres sont des longueurs METIER (longueurKm) ; la longueur geometrique ne s'y substitue jamais. Un troncon sans longueur metier est compte mais pas additionne.",
    "Les troncons non evalues et ceux dont l'etat est renseigne mais non valide sont comptes a part et exclus du denominateur des taux ; ils ne sont jamais assimiles a « bon ».",
    ...avertissementsEtat(bilans.total, indicateursReseau(bilans.total, p), p),
  ];
  if (parRegion.length === 0) avertissements.push("Aucune region ne porte de troncon du reseau classe dans ce perimetre : le rapport est vide, pas nul.");
  return {
    calculeLe: maintenant.toISOString(),
    perimetre: decrirePerimetre(regions, noms),
    parametres: {
      version: p.version, statutDefinition: p.statutDefinition, classesDegradees: p.classesDegradees,
      classesCritiques: p.classesCritiques, exigenceEtat: p.exigenceEtat, origine: p.origine,
    },
    regions: parRegion, total, avertissements, derniereEvaluationLe: jour(bilans.total.derniereEvaluationValide),
  };
}

export async function lireRapportRegions(
  depot: DepotRapport, ctx: { regions: readonly number[] | null; classes: readonly string[] | null; maintenant: Date },
): Promise<RapportRegions> {
  const [lignes, noms] = await Promise.all([depot.etat(ctx.regions, ctx.classes), depot.nomsRegions()]);
  return construireRapportRegions(lignes, noms, ctx.regions, ctx.maintenant);
}

export const COLONNES_RESEAU_REGIONS: readonly Colonne[] = [
  { cle: "region_id", libelle: "Identifiant de region", unite: null },
  { cle: "region", libelle: "Region", unite: null },
  { cle: "troncons", libelle: "Troncons du reseau classe", unite: "nombre" },
  { cle: "troncons_sans_longueur_metier", libelle: "Troncons sans longueur metier (comptes, jamais additionnes)", unite: "nombre" },
  { cle: "troncons_valides_sans_longueur", libelle: "Dont troncons a etat valide sans longueur metier (leurs km sont inconnus)", unite: "nombre" },
  { cle: "longueur_disponibilite", libelle: "Longueurs connues : COMPLETE, PARTIELLE (km minorants), ABSENTE (km vides), SANS_OBJET", unite: null },
  { cle: "km_bon", libelle: "Longueur metier a etat BON valide", unite: "km" },
  { cle: "km_moyen", libelle: "Longueur metier a etat MOYEN valide", unite: "km" },
  { cle: "km_mauvais", libelle: "Longueur metier a etat MAUVAIS valide", unite: "km" },
  { cle: "km_critique", libelle: "Longueur metier a etat CRITIQUE valide", unite: "km" },
  { cle: "km_etat_non_valide", libelle: "Longueur metier a etat renseigne mais non valide (a part)", unite: "km" },
  { cle: "km_non_evalue", libelle: "Longueur metier non evaluee (a part)", unite: "km" },
  { cle: "troncons_non_evalues", libelle: "Troncons non evalues", unite: "nombre" },
  { cle: "km_eligible", libelle: "Denominateur des taux : longueur metier a etat valide", unite: "km" },
  { cle: "km_perimetre", libelle: "Longueur metier connue du perimetre (valide + non valide + non evalue)", unite: "km" },
  { cle: "degrade_pct", libelle: "Reseau degrade (part du denominateur, PROVISOIRE)", unite: "%" },
  { cle: "critique_pct", libelle: "Reseau critique (part du denominateur, PROVISOIRE)", unite: "%" },
  { cle: "part_non_evaluee", libelle: "Part non evaluee de la longueur connue du perimetre (0 a 1)", unite: "part" },
  { cle: "derniere_evaluation", libelle: "Derniere evaluation des troncons a etat valide", unite: "date" },
  { cle: "disponibilite", libelle: "Disponibilite du taux (DISPONIBLE, PARTIEL, NON_DISPONIBLE)", unite: null },
];

/** Une valeur absente reste VIDE (null) : jamais un zero. */
export function jeuReseauRegions(r: RapportRegions): JeuDonnees {
  const ligne = (l: LigneRapportRegion) => ({
    region_id: l.regionId, region: l.region, troncons: l.troncons, troncons_sans_longueur_metier: l.tronconsSansLongueurMetier,
    troncons_valides_sans_longueur: l.tronconsValidesSansLongueur, longueur_disponibilite: l.longueurDisponibilite,
    km_bon: l.kmBon, km_moyen: l.kmMoyen, km_mauvais: l.kmMauvais, km_critique: l.kmCritique,
    km_etat_non_valide: l.kmEtatNonValide, km_non_evalue: l.kmNonEvalue, troncons_non_evalues: l.tronconsNonEvalues,
    km_eligible: l.kmEligible, km_perimetre: l.kmPerimetre, degrade_pct: l.degradePct, critique_pct: l.critiquePct,
    part_non_evaluee: l.partNonEvaluee, derniere_evaluation: l.derniereEvaluation, disponibilite: l.disponibilite,
  });
  return { colonnes: [...COLONNES_RESEAU_REGIONS], lignes: [...r.regions, r.total].map(ligne) };
}
