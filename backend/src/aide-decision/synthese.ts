/**
 * SYNTHESE de l'Aide a la decision (lot 2) : assemble les indicateurs du contrat (paragraphe 5) a partir du noyau pur
 * (`kpi.noyau.ts`), des lectures SQL agregees (`kpi.depot.ts`), du registre d'indicateurs EXISTANT
 * (`tableau-de-bord/indicateurs.registre.ts`) et des detecteurs de qualite (`qualite.ts`).
 *
 * Ce module REMPLACE `GET /api/dashboard/decision` (numerateur sur tous les troncons et denominateur sur le reseau
 * classe, `take: 50` sur les chantiers, « budget engage » = somme de tous les chantiers, « marches recenses » =
 * nombre de chantiers).
 *
 * REGLES TENUES ICI
 *  - une donnee inconnue n'est jamais un zero : `valeur: null` et un etat qui dit pourquoi ;
 *  - les montants sont des CHAINES (BigInt) ; contractuel, engage, decaisse et previsionnel sont quatre notions
 *    distinctes, chacune avec son etat ; le budget engage n'est PAS calcule (source non validee, B-08, ADR-003) ;
 *  - la portee (regions) vient du COMPTE, pas de la requete : un compte regional ne recoit que sa region ;
 *  - les lectures sont injectees (`DepotSynthese`) : le noyau d'assemblage se teste sans base ;
 *  - une lecture secondaire qui echoue degrade SON bloc (NON_DISPONIBLE + avertissement, incident journalise) ; la
 *    lecture de l'etat du reseau, sans laquelle la synthese n'a pas de sens, fait echouer l'appel.
 */
import type { PrismaClient } from "@prisma/client";
import { REGISTRE } from "../tableau-de-bord/indicateurs.registre";
import { evaluer, type IndicateurEvalue } from "../tableau-de-bord/tableau-de-bord.service";
import { nomsDesRegions } from "../qualite/detecteurs.depot";
import { REGION_NON_RENSEIGNEE } from "../lib/localisation";
import {
  CLASSES_EVALUEES, PARAMETRES_KPI, agregerEtat, ageEnJours, arrondi, avertissementsEtat, decrirePerimetre, differenceGnf, indicateursReseau,
  nombreSur, sommeGnf,
  type Bilan, type EtatDisponibilite, type IndicateursReseau, type LigneEtat, type ParametresKpi, type PerimetreDecrit,
} from "./kpi.noyau";
import {
  compterChantiersSansEcheance, lireDecaisse, lireEtatReseau, lireMarches, lireParBailleur,
  type Regions, type ResumeDecaisse, type ResumeMarches, type VentilationBailleurs,
} from "./kpi.depot";
import { entree } from "./dictionnaire";
import { FAMILLES_SYNTHESE, collecterQualitePartage, couvertureParRegion, donneesAConfirmer, type CouvertureRegion, type ResultatQualite } from "./qualite";
import type { FamilleDetecteur } from "../qualite/detecteurs.noyau";
import type { FiltresSynthese } from "./synthese.filtres";
import { filtresNonAppliques, type FiltreNonApplique } from "./synthese.filtres";

// ===================================================================================== formes de la reponse

export type EtatKpi = "DISPONIBLE" | "NON_DISPONIBLE" | "PARTIEL" | "PERIME" | "DEFINITION_NON_VALIDEE";
export type IdOnglet = "carte" | "liste" | "simulation" | "contractuel" | "scenarios" | "rapports";

export interface FiltresDecision {
  regionId?: number;
  classe?: string[];
  etat?: string[];
  statutChantier?: string[];
  depuis?: string;
  jusqua?: string;
}

/** Contrat AD paragraphe 5 + champs ADDITIFS (`valeurTexte` pour les montants exacts, couverture detaillee). */
export interface Kpi {
  code: string;
  libelle: string;
  valeur: number | null;
  /** Montants GNF : la valeur EXACTE en chaine (`valeur` n'est renseignee que si le nombre est exactement representable). */
  valeurTexte?: string | null;
  unite: string;
  etat: EtatKpi;
  statutDefinition: "PROVISOIRE" | "VALIDEE";
  periode: { depuis: string | null; jusqua: string | null } | null;
  perimetre: { libelle: string; regionId: number | null };
  source: string;
  calculeLe: string;
  couverture: CouvertureKpi | null;
  definition: string;
  formule: string;
  avertissements: string[];
  ouvre: { onglet: IdOnglet; filtres: FiltresDecision };
}

export interface CouvertureKpi {
  evalueKm: number;
  eligibleKm: number;
  nonEvalueKm: number;
  partNonEvaluee: number;
  /** Additifs. */
  etatNonValideKm: number;
  tronconsNonEvalues: number;
  tronconsEtatNonValide: number;
  tronconsSansLongueurMetier: number;
}

export type EtatMontant = "DISPONIBLE" | "PARTIEL" | "NON_DISPONIBLE" | "NON_AUTORISE";

export interface MontantEtat {
  etat: EtatMontant;
  /** Montant exact en chaine (GNF) ; `null` quand le montant est inconnu ou non communique, jamais "0" par defaut. */
  valeurGnf: string | null;
  source: string | null;
  avertissement: string | null;
}

export interface BailleurLigne {
  bailleurId: number | null;
  bailleur: string;
  marches: number;
  /** `null` : aucun marche de ce bailleur n'a de montant GNF (sans montant ou en devise etrangere) : inconnu, jamais \"0\". */
  contractuelGnf: string | null;
  /** Marches GNF avec montant saisi : explique un `contractuelGnf` nul ou partiel. */
  marchesAvecMontantGnf: number;
  decaisseGnf: string | null;
  marchesSansMontant: number;
  marchesHorsGnf: number;
}

export interface ParBailleur {
  etat: EtatMontant;
  critere: string;
  limite: number;
  totalBailleurs: number;
  tronque: boolean;
  message: string | null;
  lignes: BailleurLigne[];
  autres: { bailleurs: number; marches: number; contractuelGnf: string | null } | null;
  avertissement: string | null;
}

export interface RegionDegradation {
  regionId: number;
  regionNom: string | null;
  regionNonRenseignee: boolean;
  /** Part du reseau a etat valide qui est degradee (%) ; `null` sans etat valide dans la region. */
  partDegradeePct: number | null;
  degradeKm: number;
  eligibleKm: number;
  nonEvalueKm: number;
  partNonEvaluee: number | null;
  troncons: number;
  tronconsNonEvalues: number;
  tronconsSansLongueurMetier: number;
  etat: EtatDisponibilite;
}

export interface Synthese {
  calculeLe: string;
  perimetre: PerimetreDecrit;
  filtres: { appliques: FiltresSynthese; nonAppliques: FiltreNonApplique[] };
  parametres: { version: string; statutDefinition: "PROVISOIRE" | "VALIDEE"; classesDegradees: readonly string[]; classesCritiques: readonly string[]; exigenceEtat: string; origine: string };
  kpis: Kpi[];
  repartitionEtat: {
    unite: "km";
    base: string;
    eligibleKm: number;
    perimetreKm: number;
    troncons: number;
    classes: { classe: string; km: number; troncons: number; partPct: number | null }[];
    nonEvalue: { km: number; troncons: number; partDuPerimetre: number | null };
    etatNonValide: { km: number; troncons: number; partDuPerimetre: number | null; parClasse: Record<string, { km: number; troncons: number }>; parMotif: Record<string, { km: number; troncons: number }> };
    longueurMetierAbsente: { troncons: number };
  };
  degradationParRegion: { mention: string; regions: RegionDegradation[] };
  budget: {
    mention: string;
    contractuel: MontantEtat;
    engage: MontantEtat;
    decaisse: MontantEtat;
    previsionnel: MontantEtat;
    parBailleur: ParBailleur;
  };
  qualite: {
    etat: EtatDisponibilite;
    population: number | null;
    total: number | null;
    parGravite: Record<string, number> | null;
    tronconsNonEvalues: number;
    donneesAConfirmer: number | null;
    famillesNonExecutees: string[];
    couvertureParRegion: CouvertureRegion[];
    avertissements: string[];
    lien: string;
  };
  fraicheur: { calculeLe: string; derniereEvaluationLe: string | null; plusAncienneEvaluationLe: string | null; ageJours: number | null; note: string };
  couverture: {
    evalueKm: number; eligibleKm: number; nonEvalueKm: number; partNonEvaluee: number | null; etatNonValideKm: number;
    tronconsTotal: number; tronconsNonEvalues: number; tronconsEtatNonValide: number; tronconsSansLongueurMetier: number;
  };
  avertissements: string[];
  consultatif: string;
}

// ===================================================================================== lectures injectees

export interface DepotSynthese {
  etat(regions: Regions, classes: readonly string[] | null): Promise<LigneEtat[]>;
  marches(regions: Regions): Promise<ResumeMarches>;
  decaisse(regions: Regions): Promise<ResumeDecaisse>;
  parBailleur(regions: Regions, limite: number): Promise<VentilationBailleurs>;
  chantiersSansEcheance(regions: Regions): Promise<number>;
  registre(codes: readonly string[], regions: Regions, maintenant: Date): Promise<IndicateurEvalue[]>;
  qualite(regions: Regions, maintenant: Date, familles: readonly FamilleDetecteur[]): Promise<ResultatQualite>;
  nomsRegions(): Promise<Map<number, string>>;
}

/** Les lectures reelles, sur un client Prisma. Le client de lecture des detecteurs ouvre sa propre transaction READ ONLY. */
export function depotPrisma(prisma: PrismaClient): DepotSynthese {
  return {
    etat: (regions, classes) => lireEtatReseau(prisma, regions, classes),
    marches: (regions) => lireMarches(prisma, regions),
    decaisse: (regions) => lireDecaisse(prisma, regions),
    parBailleur: (regions, limite) => lireParBailleur(prisma, regions, limite),
    chantiersSansEcheance: (regions) => compterChantiersSansEcheance(prisma, regions),
    registre: (codes, regions, maintenant) => evaluer(prisma, REGISTRE, { regions, maintenant }, { codes }),
    qualite: (regions, maintenant, familles) => collecterQualitePartage(prisma, regions, maintenant, familles),
    nomsRegions: () => nomsDesRegions(prisma),
  };
}

export interface ContexteSynthese {
  /** Regions en portee : celles du compte, reduites au filtre `regionId` ; `null` = pays entier (compte national sans filtre). */
  regions: Regions;
  maintenant: Date;
  filtres: FiltresSynthese;
  droits: { marches: boolean; programmation: boolean };
  parametres?: ParametresKpi;
}

// ===================================================================================== utilitaires

const MENTION_CONSULTATIF = "Indicateurs consultatifs, non engageants : ils décrivent l'état des données saisies, ils ne valent ni décision ni engagement financier.";

const CODES_REGISTRE = ["chantiers_en_cours", "chantiers_en_retard", "longueur_geometrique_km", "previsions_retenues_gnf", "previsions_retenues_nb"] as const;

const jourDe = (d: Date): string => d.toISOString().slice(0, 10);

async function tenter<T>(nom: string, fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false }> {
  try {
    return { ok: true, v: await fn() };
  } catch (err) {
    console.error(`[aide-decision] ${nom} en echec :`, err instanceof Error ? err.message : err);
    return { ok: false };
  }
}

const pluriel = (v: number, un: string, plusieurs: string): string => `${v} ${v > 1 ? plusieurs : un}`;

// ===================================================================================== composition

export async function composerSynthese(depot: DepotSynthese, ctx: ContexteSynthese): Promise<Synthese> {
  const p = ctx.parametres ?? PARAMETRES_KPI;
  const { regions, maintenant, filtres } = ctx;
  const classes = filtres.classe ?? null;
  const calculeLe = maintenant.toISOString();
  const national = regions === null;

  const noms = await depot.nomsRegions();
  // La lecture de l'etat est la base de la synthese : si elle echoue, l'appel echoue (la route rend alors une erreur JSON).
  // Defense en profondeur : meme si la lecture ne bornait pas la region, une ligne hors portee n'entre jamais dans un total.
  const lignes = (await depot.etat(regions, classes)).filter((l) => regions === null || regions.includes(l.regionId));
  const bilans = agregerEtat(lignes, p);
  const total = bilans.total;
  const ind = indicateursReseau(total, p);

  const registre = await tenter("registre", () => depot.registre(CODES_REGISTRE, regions, maintenant));
  const [marches, decaisse, bailleurs, sansEcheance] = await Promise.all([
    tenter("marches", () => depot.marches(regions)),
    tenter("decaisse", () => depot.decaisse(regions)),
    tenter("par-bailleur", () => depot.parBailleur(regions, p.limiteBailleurs)),
    tenter("chantiers-sans-echeance", () => depot.chantiersSansEcheance(regions)),
  ]);
  const qualite = await tenter("qualite", () => depot.qualite(regions, maintenant, FAMILLES_SYNTHESE));

  // ---------------------------------------------------------------- perimetre
  const nomRegion = (id: number): string | null => noms.get(id) ?? null;
  const perimetre = decrirePerimetre(regions, noms);
  const regionUnique = perimetre.regionId;
  const libelleScope = perimetre.libelle;
  const periodeInstant = { depuis: jourDe(maintenant), jusqua: jourDe(maintenant) };
  // Seule la region qualifie tous les indicateurs ; la classe ne qualifie que les troncons (carte).
  const filtresOuvre: FiltresDecision = regionUnique !== null ? { regionId: regionUnique } : {};

  const kpi = (code: string, over: Partial<Kpi> & Pick<Kpi, "etat" | "valeur" | "ouvre" | "perimetre">): Kpi => {
    const e = entree(code);
    return {
      code, libelle: e.libelle, unite: e.unite === "elements" ? "éléments" : e.unite,
      statutDefinition: e.statutDefinition, periode: periodeInstant, source: e.source, calculeLe,
      couverture: null, definition: e.definition, formule: e.formule, avertissements: [],
      ...over,
    };
  };
  const perimetreReseau = { libelle: `${libelleScope} : réseau classé saisi${classes ? ` (classes ${classes.join(", ")})` : ""}`, regionId: regionUnique };
  const perimetreChantiers = { libelle: `${libelleScope} : chantiers au registre`, regionId: regionUnique };
  const perimetreMarches = { libelle: `${libelleScope} : marchés saisis`, regionId: regionUnique };
  const ouvreCarte = (etat?: string[]): { onglet: IdOnglet; filtres: FiltresDecision } => ({
    onglet: "carte", filtres: { ...filtresOuvre, ...(classes ? { classe: [...classes] } : {}), ...(etat ? { etat } : {}) },
  });
  const ouvreContrat = (statutChantier?: string[]): { onglet: IdOnglet; filtres: FiltresDecision } => ({ onglet: "contractuel", filtres: { ...filtresOuvre, ...(statutChantier ? { statutChantier } : {}) } });

  const couvertureKpi: CouvertureKpi | null = ind.perimetreKm > 0 ? {
    evalueKm: arrondi(ind.evalueKm, 2), eligibleKm: arrondi(ind.eligibleKm, 2), nonEvalueKm: arrondi(ind.nonEvalueKm, 2),
    partNonEvaluee: ind.partNonEvaluee ?? 0,
    etatNonValideKm: arrondi(ind.etatNonValideKm, 2), tronconsNonEvalues: total.nonEvalue.troncons,
    tronconsEtatNonValide: total.etatNonValide.troncons, tronconsSansLongueurMetier: total.tronconsSansLongueur,
  } : null;
  const avertEtat = avertissementsEtat(total, ind, p);
  const classesDegradees = [...p.classesDegradees] as string[];
  const classesCritiques = [...p.classesCritiques] as string[];

  // ---------------------------------------------------------------- qualite (anomalies) : sert plusieurs indicateurs
  const q = qualite.ok ? qualite.v : null;
  const ecartLongueur = q?.parCode.find((c) => c.code === "LONGUEUR_ECART_GEOMETRIE")?.nombre ?? 0;
  const geomAbsente = q?.parCode.find((c) => c.code === "GEOM_ABSENTE")?.nombre ?? 0;
  const aConfirmer = q ? donneesAConfirmer(total.nonEvalue.troncons, q) : null;

  // ---------------------------------------------------------------- KPI du reseau
  const kpis: Kpi[] = [];
  const nul = (v: number | null, d: number): number | null => (v === null ? null : arrondi(v, d));

  kpis.push(kpi("reseau_degrade_pct", {
    valeur: ind.degradePct, etat: ind.etat, perimetre: perimetreReseau, couverture: couvertureKpi,
    avertissements: avertEtat,
    ouvre: ouvreCarte(classesDegradees),
  }));
  kpis.push(kpi("reseau_critique_km", {
    valeur: ind.etat === "NON_DISPONIBLE" ? null : nul(ind.critiqueKm, 2), etat: ind.etat, perimetre: perimetreReseau, couverture: couvertureKpi,
    avertissements: avertEtat, ouvre: ouvreCarte(classesCritiques),
  }));
  kpis.push(kpi("reseau_critique_pct", {
    valeur: ind.critiquePct, etat: ind.etat, perimetre: perimetreReseau, couverture: couvertureKpi,
    avertissements: avertEtat, ouvre: ouvreCarte(classesCritiques),
  }));

  // Longueur du reseau de reference (metier) : separee de la geometrique, jamais completee par elle.
  const longueurEtat: EtatDisponibilite = total.troncons === 0 || total.longueurConnueKm <= 0 ? "NON_DISPONIBLE" : total.tronconsSansLongueur > 0 ? "PARTIEL" : "DISPONIBLE";
  const avertLongueur: string[] = [];
  if (total.troncons === 0) avertLongueur.push("Aucun tronçon du réseau classé saisi dans ce périmètre.");
  else if (total.longueurConnueKm <= 0) avertLongueur.push("Aucun tronçon du périmètre n'a de longueur métier connue : la longueur du réseau de référence est inconnue, pas nulle.");
  if (total.tronconsSansLongueur > 0 && total.troncons > 0) {
    avertLongueur.push(`${pluriel(total.tronconsSansLongueur, "tronçon", "tronçons")} sans longueur métier sur ${total.troncons} : la somme est une borne basse. La longueur géométrique n'est pas substituée.`);
  }
  if (ecartLongueur > 0) avertLongueur.push(`${pluriel(ecartLongueur, "tronçon", "tronçons")} dont la longueur saisie s'écarte de la longueur géométrique au-delà du seuil provisoire du détecteur (signalé, jamais corrigé).`);
  kpis.push(kpi("longueur_reseau_reference_km", {
    valeur: longueurEtat === "NON_DISPONIBLE" ? null : arrondi(total.longueurConnueKm, 2), etat: longueurEtat, perimetre: perimetreReseau,
    avertissements: avertLongueur, ouvre: ouvreCarte(),
  }));

  // Longueur geometrique : repris du registre, non ventile par classe.
  const geo = registre.ok ? registre.v.find((i) => i.code === "longueur_geometrique_km") : undefined;
  const avertGeo: string[] = [];
  let geoValeur: number | null = null;
  let geoEtat: EtatDisponibilite = "NON_DISPONIBLE";
  if (classes !== null) avertGeo.push("Non ventilée par classe : le filtre « classe » ne s'applique pas à la longueur géométrique.");
  else if (!geo || geo.statut !== "CALCULE") avertGeo.push("Indicateur non calculé (incident journalisé ou non communiqué à ce compte).");
  else if (geo.aucuneDonnee || total.troncons === 0) avertGeo.push("Aucun tronçon du réseau classé saisi dans ce périmètre.");
  else if (typeof geo.valeur !== "number" || geo.valeur <= 0) avertGeo.push("Aucun tronçon du périmètre n'a de géométrie exploitable : la longueur géométrique est inconnue, pas nulle.");
  else {
    geoValeur = geo.valeur;
    geoEtat = geomAbsente > 0 ? "PARTIEL" : "DISPONIBLE";
    if (geomAbsente > 0) avertGeo.push(`${pluriel(geomAbsente, "tronçon", "tronçons")} sans géométrie, exclus de la somme.`);
  }
  if (ecartLongueur > 0 && geoValeur !== null) avertGeo.push(`${pluriel(ecartLongueur, "tronçon", "tronçons")} dont la longueur saisie s'écarte de la longueur géométrique au-delà du seuil provisoire (signalé, jamais corrigé).`);
  kpis.push(kpi("longueur_geometrique_km", {
    valeur: geoValeur, etat: geoEtat, perimetre: perimetreReseau, avertissements: avertGeo, ouvre: ouvreCarte(),
  }));

  kpis.push(kpi("couverture_etat_part", {
    valeur: ind.couvertureEtatPart, perimetre: perimetreReseau, couverture: couvertureKpi,
    etat: ind.perimetreKm <= 0 ? "NON_DISPONIBLE" : total.tronconsSansLongueur > 0 ? "PARTIEL" : "DISPONIBLE",
    avertissements: ind.perimetreKm <= 0 ? ["Aucune longueur métier connue dans le périmètre."] : avertEtat,
    ouvre: ouvreCarte(["NON_EVALUE"]),
  }));

  // ---------------------------------------------------------------- chantiers (registre, sans take)
  const codeRegistre = (code: string): IndicateurEvalue | undefined => (registre.ok ? registre.v.find((i) => i.code === code) : undefined);
  const chantierKpi = (code: "chantiers_en_cours" | "chantiers_en_retard", extra: string[], partiel: boolean): Kpi => {
    const r = codeRegistre(code);
    const base = { perimetre: perimetreChantiers, ouvre: ouvreContrat(["EN_COURS"]) };
    if (!r || r.statut !== "CALCULE") return kpi(code, { ...base, valeur: null, etat: "NON_DISPONIBLE", avertissements: ["Indicateur non calculé (incident journalisé ou non communiqué à ce compte)."] });
    if (r.aucuneDonnee || typeof r.valeur !== "number") return kpi(code, { ...base, valeur: null, etat: "NON_DISPONIBLE", avertissements: ["Aucun chantier au registre dans ce périmètre : rien à compter (pas un zéro).", ...extra] });
    return kpi(code, { ...base, valeur: r.valeur, etat: partiel ? "PARTIEL" : "DISPONIBLE", avertissements: extra });
  };
  kpis.push(chantierKpi("chantiers_en_cours", ["Statut saisi dans l'application, non issu d'un système contractuel de référence."], false));
  const sansEch = sansEcheance.ok ? sansEcheance.v : null;
  kpis.push(chantierKpi("chantiers_en_retard", [
    "Règle : chantier EN_COURS dont la date de fin prévue est dépassée. Les suspensions (un chantier SUSPENDU n'est pas EN_COURS) et les avenants (la date prévue n'est pas prolongée par un avenant) ne sont pas pris en compte.",
    ...(sansEch !== null && sansEch > 0 ? [`${pluriel(sansEch, "chantier en cours sans date de fin prévue", "chantiers en cours sans date de fin prévue")} : leur retard ne peut pas être jugé.`] : []),
    ...(sansEch === null ? ["Le nombre de chantiers sans date de fin prévue n'a pas pu être lu."] : []),
  ], sansEch === null || sansEch > 0));

  // ---------------------------------------------------------------- budget
  const restreint = !national;
  const noteRegional = "Un marché n'a pas de région propre : pour un périmètre régional, seuls sont comptés les marchés rattachés à au moins un chantier et dont tous les chantiers sont dans le périmètre ; les marchés sans chantier ou à cheval sur une autre région ne sont pas communiqués.";
  const interdit = (module: string): MontantEtat => ({
    etat: "NON_AUTORISE", valeurGnf: null, source: null, avertissement: `Droit « ${module} » requis pour consulter les montants : non communiqué à ce compte.`,
  });
  const echec = (nom: string): MontantEtat => ({ etat: "NON_DISPONIBLE", valeurGnf: null, source: null, avertissement: `${nom} : lecture en échec (incident journalisé).` });

  const m = marches.ok ? marches.v : null;
  let contractuel: MontantEtat;
  if (!ctx.droits.marches) contractuel = interdit("marchés ou chantiers");
  else if (!m) contractuel = echec("Budget contractuel");
  else if (m.marches === 0) contractuel = { etat: "NON_DISPONIBLE", valeurGnf: null, source: "marches.montantTotal", avertissement: "Aucun marché saisi dans ce périmètre : le budget contractuel est inconnu, pas nul (la source de référence, DigitalRoad, n'est pas intégrée)." };
  else if (m.gnfAvecMontant === 0) contractuel = { etat: "NON_DISPONIBLE", valeurGnf: null, source: "marches.montantTotal", avertissement: `${pluriel(m.marches, "marché saisi", "marchés saisis")} mais aucun montant en GNF renseigné (${m.sansMontant} sans montant, ${m.horsGnf} en devise étrangère).` };
  else {
    const notes: string[] = [];
    if (m.sansMontant > 0) notes.push(`${pluriel(m.sansMontant, "marché sans montant saisi", "marchés sans montant saisi")} (non comptés comme 0)`);
    if (m.horsGnf > 0) notes.push(`${pluriel(m.horsGnf, "marché en devise étrangère exclu", "marchés en devise étrangère exclus")} de la somme (aucun taux de change validé)`);
    if (restreint) notes.push(noteRegional);
    contractuel = {
      etat: notes.length > 0 ? "PARTIEL" : "DISPONIBLE", valeurGnf: m.contractuelGnf,
      source: "marches.montantTotal (saisie applicative ; source de référence DigitalRoad non intégrée)",
      avertissement: notes.length > 0 ? `${notes.join(" ; ")}.` : null,
    };
  }

  const engage: MontantEtat = {
    etat: "NON_DISPONIBLE", valeurGnf: null, source: null,
    avertissement: "source financière de référence non validée (B-08, ADR-003). Le budget engagé n'est pas calculé : ni la somme des chantiers, ni celle des marchés ne le remplacent.",
  };

  const d = decaisse.ok ? decaisse.v : null;
  let decaisseM: MontantEtat;
  if (!ctx.droits.marches) decaisseM = interdit("marchés ou chantiers");
  else if (!d) decaisseM = echec("Budget décaissé");
  else if (d.payes === 0) {
    decaisseM = { etat: "NON_DISPONIBLE", valeurGnf: null, source: "decomptes (statut PAYE)", avertissement: `Aucun décompte payé saisi dans ce périmètre : le décaissé est inconnu, pas nul${d.emis > 0 ? ` (${pluriel(d.emis, "décompte émis non payé", "décomptes émis non payés")})` : ""}.` };
  } else {
    const notes: string[] = [];
    if (d.payesSansDate > 0) notes.push(`${pluriel(d.payesSansDate, "décompte payé sans date de paiement", "décomptes payés sans date de paiement")}`);
    if (d.payesRetenueGarantie > 0) notes.push(`${pluriel(d.payesRetenueGarantie, "décompte de retenue de garantie inclus", "décomptes de retenue de garantie inclus")} (à confirmer)`);
    if (d.emis > 0) notes.push(`${pluriel(d.emis, "décompte émis non payé", "décomptes émis non payés")}, non compté${d.emis > 1 ? "s" : ""}`);
    if (restreint) notes.push(noteRegional);
    decaisseM = {
      etat: restreint || d.payesSansDate > 0 ? "PARTIEL" : "DISPONIBLE", valeurGnf: d.payeGnf,
      source: "decomptes.montantGnf au statut PAYE (saisie applicative)",
      avertissement: notes.length > 0 ? `${notes.join(" ; ")}.` : null,
    };
  }

  const prevNb = codeRegistre("previsions_retenues_nb");
  const prevGnf = codeRegistre("previsions_retenues_gnf");
  let previsionnel: MontantEtat;
  if (!ctx.droits.programmation) previsionnel = interdit("programmation");
  else if (!prevNb || !prevGnf || prevNb.statut !== "CALCULE" || prevGnf.statut !== "CALCULE") previsionnel = echec("Budget prévisionnel");
  else if (typeof prevNb.valeur !== "number" || prevNb.valeur === 0 || typeof prevGnf.valeur !== "string") {
    previsionnel = { etat: "NON_DISPONIBLE", valeurGnf: null, source: "programmes_budgetaires (statut RETENU)", avertissement: "Aucune prévision retenue dans ce périmètre : le prévisionnel est inconnu, pas nul." };
  } else {
    previsionnel = {
      etat: restreint ? "PARTIEL" : "DISPONIBLE", valeurGnf: prevGnf.valeur,
      source: "programmes_budgetaires au statut RETENU (toutes années)",
      avertissement: restreint ? "Une prévision sans tronçon n'a pas de région : elle n'est pas communiquée à un périmètre régional." : null,
    };
  }

  // Ventilation par bailleur : marches.bailleurId -> bailleurs, jamais le texte libre de chantiers.bailleur.
  const parBailleur = composerBailleurs(bailleurs.ok ? bailleurs.v : null, m, ctx, p.limiteBailleurs, restreint, noteRegional);

  const gnfKpi = (code: "budget_contractuel_gnf", mt: MontantEtat, ouvre: Kpi["ouvre"]): Kpi => kpi(code, {
    valeur: mt.valeurGnf === null ? null : nombreSur(mt.valeurGnf), valeurTexte: mt.valeurGnf,
    etat: mt.etat === "DISPONIBLE" ? "DISPONIBLE" : mt.etat === "PARTIEL" ? "PARTIEL" : "NON_DISPONIBLE",
    perimetre: perimetreMarches, periode: null, avertissements: mt.avertissement ? [mt.avertissement] : [], ouvre,
  });
  kpis.push(kpi("budget_engage_gnf", {
    valeur: null, valeurTexte: null, etat: "NON_DISPONIBLE", perimetre: { libelle: `${libelleScope} : source financière non validée`, regionId: regionUnique },
    periode: null, avertissements: [engage.avertissement!], ouvre: ouvreContrat(),
  }));
  kpis.push(gnfKpi("budget_contractuel_gnf", contractuel, ouvreContrat()));

  // Marches recenses = lignes de `marches` (pas de chantiers) ; recense n'est pas actif.
  const avertMarches: string[] = ["Marchés recensés dans la table marches : un marché recensé n'est ni actif ni validé."];
  let marchesEtat: EtatKpi = "NON_DISPONIBLE";
  let marchesValeur: number | null = null;
  if (!m) avertMarches.push("Lecture en échec (incident journalisé).");
  else if (m.marches === 0) avertMarches.push("Aucun marché saisi dans ce périmètre (la source de référence, DigitalRoad, n'est pas intégrée) : le nombre est inconnu, pas nul.");
  else {
    marchesValeur = m.marches;
    marchesEtat = restreint ? "PARTIEL" : "DISPONIBLE";
    if (restreint) avertMarches.push(noteRegional);
  }
  kpis.push(kpi("marches_recenses", { valeur: marchesValeur, etat: marchesEtat, perimetre: perimetreMarches, avertissements: avertMarches, ouvre: ouvreContrat() }));

  // Donnees a confirmer : non evalues + anomalies (sans double compte).
  const avertConfirmer: string[] = [];
  let confirmerEtat: EtatKpi = "NON_DISPONIBLE";
  let confirmerValeur: number | null = null;
  if (total.troncons === 0) avertConfirmer.push("Aucun tronçon du réseau classé saisi dans ce périmètre.");
  else if (!q || !aConfirmer) avertConfirmer.push("Détecteurs de qualité non exécutés (incident journalisé) : seuls les tronçons non évalués seraient comptés, la valeur n'est pas rendue.");
  else {
    confirmerValeur = aConfirmer.valeur;
    confirmerEtat = q.famillesNonExecutees.length > 0 || q.avertissements.length > 0 ? "PARTIEL" : "DISPONIBLE";
    avertConfirmer.push(`${pluriel(total.nonEvalue.troncons, "tronçon non évalué", "tronçons non évalués")} + ${pluriel(aConfirmer.anomalies, "anomalie", "anomalies")} des détecteurs (hors codes « non évalué », déjà comptés). Nombre d'éléments, pas de tronçons distincts.`);
    if (q.famillesNonExecutees.length > 0) {
      avertConfirmer.push(`Familles de détecteurs non exécutées dans la synthèse : ${q.famillesNonExecutees.join(", ")} (REGION et DOUBLON coûtent un balayage entier : voir /api/v2/aide-decision/qualite, qui exécute les six familles). Le nombre est une borne basse.`);
    }
    for (const a of q.avertissements) avertConfirmer.push(a);
  }
  kpis.push(kpi("donnees_a_confirmer", {
    valeur: confirmerValeur, etat: confirmerEtat, perimetre: perimetreReseau, avertissements: avertConfirmer,
    ouvre: { onglet: "rapports", filtres: filtresOuvre },
  }));

  // ---------------------------------------------------------------- repartition de l'etat
  const sur = (v: number, den: number): number | null => (den > 0 ? arrondi((100 * v) / den, 1) : null);
  const repartitionEtat: Synthese["repartitionEtat"] = {
    unite: "km",
    base: "Longueur métier connue du réseau classé saisi (les tronçons sans longueur sont comptés à part, jamais additionnés). Les parts des classes sont rapportées aux seuls tronçons à état valide ; les non évalués et les états non valides sont à part.",
    eligibleKm: arrondi(ind.eligibleKm, 2),
    perimetreKm: arrondi(ind.perimetreKm, 2),
    troncons: total.troncons,
    classes: CLASSES_EVALUEES.map((c) => ({ classe: c, km: arrondi(total.valide.parClasse[c].km, 2), troncons: total.valide.parClasse[c].troncons, partPct: sur(total.valide.parClasse[c].km, ind.eligibleKm) })),
    nonEvalue: { km: arrondi(ind.nonEvalueKm, 2), troncons: total.nonEvalue.troncons, partDuPerimetre: ind.partNonEvaluee },
    etatNonValide: {
      km: arrondi(ind.etatNonValideKm, 2), troncons: total.etatNonValide.troncons,
      partDuPerimetre: ind.perimetreKm > 0 ? arrondi(ind.etatNonValideKm / ind.perimetreKm, 4) : null,
      parClasse: Object.fromEntries(CLASSES_EVALUEES.map((c) => [c, { km: arrondi(total.etatNonValide.parClasse[c].km, 2), troncons: total.etatNonValide.parClasse[c].troncons }])),
      parMotif: Object.fromEntries(Object.entries(total.etatNonValide.parMotif).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { km: arrondi(v!.km, 2), troncons: v!.troncons }])),
    },
    longueurMetierAbsente: { troncons: total.tronconsSansLongueur },
  };

  // ---------------------------------------------------------------- degradation par region (PAS un score de priorite)
  const regionsDeg: RegionDegradation[] = bilans.parRegion.map(({ regionId, bilan }) => {
    const i = indicateursReseau(bilan, p);
    const nom = nomRegion(regionId);
    return {
      regionId, regionNom: nom, regionNonRenseignee: nom === REGION_NON_RENSEIGNEE,
      partDegradeePct: i.degradePct, degradeKm: arrondi(i.degradeKm, 2), eligibleKm: arrondi(i.eligibleKm, 2), nonEvalueKm: arrondi(i.nonEvalueKm, 2),
      partNonEvaluee: i.partNonEvaluee, troncons: bilan.troncons, tronconsNonEvalues: bilan.nonEvalue.troncons,
      tronconsSansLongueurMetier: bilan.tronconsSansLongueur, etat: i.etat,
    };
  }).sort((a, b) => (a.regionNom ?? "").localeCompare(b.regionNom ?? "", "fr") || a.regionId - b.regionId);

  // ---------------------------------------------------------------- qualite et fraicheur
  const couvertureRegions = couvertureParRegion(bilans, noms, regions, q ? q.parRegion : null);
  const derniere = total.derniereEvaluationValide;
  const ancienne = total.plusAncienneEvaluationValide;

  const avertissements: string[] = [];
  if (!national) avertissements.push(`Périmètre limité à votre compte : ${libelleScope}. Aucun total national n'est communiqué.`);
  for (const f of filtresNonAppliques(filtres)) avertissements.push(f.raison);
  if (classes !== null) avertissements.push("Le filtre « classe » s'applique aux indicateurs de tronçons ; il ne qualifie ni les chantiers, ni les marchés, ni la longueur géométrique.");
  if (!registre.ok) avertissements.push("Le registre d'indicateurs n'a pas pu être lu : chantiers, longueur géométrique et prévisionnel sont non disponibles (incident journalisé).");
  if (!qualite.ok) avertissements.push("Les détecteurs de qualité n'ont pas pu être exécutés : données à confirmer non disponibles (incident journalisé).");
  avertissements.push("Définitions PROVISOIRES : à confirmer par la Direction technique et la Direction financière (voir /api/v2/aide-decision/dictionnaire).");
  avertissements.push(MENTION_CONSULTATIF);

  return {
    calculeLe,
    perimetre,
    filtres: { appliques: { ...(regionUnique !== null ? { regionId: regionUnique } : {}), ...(classes ? { classe: [...classes] } : {}) }, nonAppliques: filtresNonAppliques(filtres) },
    parametres: { version: p.version, statutDefinition: p.statutDefinition, classesDegradees, classesCritiques, exigenceEtat: p.exigenceEtat, origine: p.origine },
    kpis,
    repartitionEtat,
    degradationParRegion: {
      mention: "Part du réseau dégradé par région, parmi les tronçons à état valide : un indicateur d'état, PAS un score de priorité. Une priorité se calcule dans le moteur de programmation, avec ses paramètres approuvés.",
      regions: regionsDeg,
    },
    budget: {
      mention: "Contractuel, engagé, décaissé et prévisionnel sont quatre notions distinctes ; aucune n'est déduite d'une autre. Montants en GNF, en chaînes.",
      contractuel, engage, decaisse: decaisseM, previsionnel, parBailleur,
    },
    qualite: {
      etat: !q ? "NON_DISPONIBLE" : q.famillesNonExecutees.length > 0 || q.avertissements.length > 0 ? "PARTIEL" : "DISPONIBLE",
      population: q ? q.population : null, total: q ? q.total : null, parGravite: q ? q.parGravite : null,
      tronconsNonEvalues: total.nonEvalue.troncons, donneesAConfirmer: aConfirmer ? aConfirmer.valeur : null,
      famillesNonExecutees: q ? [...q.famillesNonExecutees] : [],
      couvertureParRegion: couvertureRegions,
      avertissements: q ? q.avertissements : [],
      lien: "/api/v2/aide-decision/qualite",
    },
    fraicheur: {
      calculeLe,
      derniereEvaluationLe: derniere ? derniere.toISOString() : null,
      plusAncienneEvaluationLe: ancienne ? ancienne.toISOString() : null,
      ageJours: ageEnJours(derniere, maintenant),
      note: "Age de l'évaluation la plus récente parmi les tronçons à état valide ; aucun seuil de fraîcheur n'est validé, aucun verdict n'est porté.",
    },
    couverture: {
      evalueKm: arrondi(ind.evalueKm, 2), eligibleKm: arrondi(ind.eligibleKm, 2), nonEvalueKm: arrondi(ind.nonEvalueKm, 2), partNonEvaluee: ind.partNonEvaluee,
      etatNonValideKm: arrondi(ind.etatNonValideKm, 2), tronconsTotal: total.troncons, tronconsNonEvalues: total.nonEvalue.troncons,
      tronconsEtatNonValide: total.etatNonValide.troncons, tronconsSansLongueurMetier: total.tronconsSansLongueur,
    },
    avertissements,
    consultatif: MENTION_CONSULTATIF,
  };
}

function composerBailleurs(
  v: VentilationBailleurs | null, m: ResumeMarches | null, ctx: ContexteSynthese, limite: number, restreint: boolean, noteRegional: string,
): ParBailleur {
  const critere = "marches.bailleurId vers bailleurs.id (jamais le texte libre de chantiers.bailleur)";
  const base = { critere, limite, totalBailleurs: 0, tronque: false, message: null as string | null, lignes: [] as BailleurLigne[], autres: null as ParBailleur["autres"] };
  if (!ctx.droits.marches) return { ...base, etat: "NON_AUTORISE", avertissement: "Droit « marchés » ou « chantiers » requis pour consulter les montants : non communiqué à ce compte." };
  if (!v || !m) return { ...base, etat: "NON_DISPONIBLE", avertissement: "Lecture en échec (incident journalisé)." };
  if (v.lignes.length === 0) return { ...base, etat: "NON_DISPONIBLE", avertissement: "Aucun marché saisi dans ce périmètre : la ventilation par bailleur est inconnue." };

  const lignes: BailleurLigne[] = v.lignes.map((l) => ({
    bailleurId: l.bailleurId, bailleur: l.nom ?? "Bailleur non renseigné", marches: l.marches, contractuelGnf: l.contractuelGnf,
    marchesAvecMontantGnf: l.avecMontantGnf,
    decaisseGnf: l.decaisseGnf, marchesSansMontant: l.sansMontant, marchesHorsGnf: l.horsGnf,
  }));
  const tronque = v.totalBailleurs > lignes.length;
  // « autres » : la somme restante n'est connue que si au moins un marche regroupe a un montant GNF ; sinon elle est inconnue (null), pas 0.
  const autresAvecMontant = m.gnfAvecMontant - lignes.reduce((s, l) => s + l.marchesAvecMontantGnf, 0);
  const autres = tronque ? {
    bailleurs: v.totalBailleurs - lignes.length,
    marches: Math.max(0, m.marches - lignes.reduce((s, l) => s + l.marches, 0)),
    contractuelGnf: autresAvecMontant > 0
      ? differenceGnf(m.contractuelGnf, sommeGnf(lignes.map((l) => l.contractuelGnf).filter((x): x is string => x !== null)))
      : null,
  } : null;
  const notes: string[] = [];
  if (tronque) notes.push(`Liste limitée aux ${limite} bailleurs aux plus gros montants contractuels sur ${v.totalBailleurs} : ${v.totalBailleurs - lignes.length} autres bailleurs sont agrégés dans « autres ».`);
  if (lignes.some((l) => l.bailleurId === null)) notes.push("Des marchés n'ont pas de bailleur renseigné : groupe « Bailleur non renseigné ».");
  if (m.sansMontant > 0) notes.push(`${pluriel(m.sansMontant, "marché sans montant saisi", "marchés sans montant saisi")}, jamais comptés comme 0.`);
  if (m.horsGnf > 0) notes.push(`${pluriel(m.horsGnf, "marché en devise étrangère", "marchés en devise étrangère")} exclus des sommes GNF.`);
  if (restreint) notes.push(noteRegional);
  return {
    ...base, totalBailleurs: v.totalBailleurs, tronque, message: tronque ? notes[0] : null, lignes, autres,
    etat: notes.length > 0 ? "PARTIEL" : "DISPONIBLE", avertissement: notes.length > 0 ? notes.join(" ") : null,
  };
}

/** Pour les tests et la documentation : les bilans d'un jeu de lignes, sans le reste de la synthese. */
export function bilanDe(lignes: readonly LigneEtat[], p: ParametresKpi = PARAMETRES_KPI): { total: Bilan; ind: IndicateursReseau } {
  const { total } = agregerEtat(lignes, p);
  return { total, ind: indicateursReseau(total, p) };
}
