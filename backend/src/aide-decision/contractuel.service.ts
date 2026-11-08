/**
 * Service du suivi contractuel (AD-LOT-5) : compose le depot (lecture seule) et le noyau (pur). Il ne fait AUCUNE ecriture.
 *
 * ORDRE DES GARDES, ET POURQUOI
 *
 *  1. Le perimetre territorial du compte vient de la BASE a chaque requete (`perimetreDe`), jamais de la requete.
 *  2. Le depot pre-selectionne par region (optimisation) ; le NOYAU decide ensuite de la visibilite de chaque marche. Un depot
 *     qui rendrait trop de lignes ne ferait donc rien fuiter : c'est le « oracle ferme » que les tests verifient.
 *  3. Les filtres s'appliquent APRES la visibilite : un compte regional ne devine rien par un filtre.
 *  4. Les agregats (synthese, controles) portent sur les marches VISIBLES ET FILTRES, jamais sur le national.
 *
 * LA CONFIDENTIALITE FINANCIERE (D-C1-1, decision ouverte) : le modele n'a pas de « droit financier ». Regle la plus
 * prudente appliquee : le module `marches` est exige (garde de la route) ET le droit financier est la regle unique `droitMontantsContractuels`. Quand une
 * decision creera un droit plus fin, `droitFinancierDe` est le SEUL point a changer ; sans ce droit, aucun montant n'est rendu.
 */
import { modulesAutorisesDe } from "../lib/access";
import { droitMontantsContractuels } from "../modules/chantiers/chantiers.confidentialite";
import { perimetreDe } from "../territoire/territoire.service";
import { depotPrisma, type DepotContractuel } from "./contractuel.depot";
import {
  PLAFOND_CHANTIERS_PAR_MARCHE, PLAFOND_MARCHES_ANALYSES, SOURCE_COPIE_GELEE, DEFINITIONS_CONTRACTUEL,
  agregerControles, analyserMarche, correspondAuxFiltres, evaluerFraicheur, raisonsPartielles, rattacherProgrammes, regionsNonRenseignees,
  synthetiser, territoireDuMarche, tronconsDuMarche, visibleDuPerimetre,
  type Analyse, type ControleVue, type DonneesPartielles, type FiltresContractuel, type FraicheurVue, type MarcheEntree, type MarcheVue, type SyntheseVue,
} from "./contractuel.noyau";
import { encoderCurseur, type CurseurContractuel } from "./contractuel.filtres";

export interface CompteLecture { id: string; role: string }

export interface DepsContractuel {
  depot: DepotContractuel;
  perimetreDe: (c: CompteLecture) => Promise<{ national: true } | { national: false; regions: ReadonlySet<number> }>;
  droitFinancierDe: (c: CompteLecture) => Promise<boolean>;
  maintenant: () => Date;
}

/** Le droit financier est la regle UNIQUE des montants contractuels (D-C1-1, PROVISOIRE) : ADMIN, `marches` ou `chantiers`. */
async function droitFinancierParModule(c: CompteLecture): Promise<boolean> {
  return droitMontantsContractuels(await modulesAutorisesDe(c));
}

export const depsParDefaut: DepsContractuel = {
  depot: depotPrisma,
  perimetreDe: (c) => perimetreDe(c),
  droitFinancierDe: droitFinancierParModule,
  maintenant: () => new Date(),
};

export interface PerimetreVue {
  national: boolean;
  regionIds: number[] | null;
  libelle: string;
  /** Un compte regional ne recoit JAMAIS de total national : dit dans la reponse, pas seulement dans la documentation. */
  totalNationalFourni: boolean;
  filtres: FiltresContractuel;
  exclusParFiltre?: { sansDate: number };
}

export interface ReponseContractuel {
  genereLe: string;
  source: typeof SOURCE_COPIE_GELEE;
  droitFinancier: boolean;
  perimetre: PerimetreVue;
  donneesPartielles: DonneesPartielles;
  fraicheur: FraicheurVue;
  plafond: { marchesAnalyses: number; plafond: number; tronque: boolean };
  synthese: SyntheseVue;
  controles: ControleVue[];
  marches: MarcheVue[];
  page: { limite: number; total: number; curseurSuivant: string | null };
  definitions: typeof DEFINITIONS_CONTRACTUEL;
}

export interface DecompteVue {
  numero: number; type: string; statut: string; montantGnf: string | null;
  dateEmission: string | null; datePaiement: string | null; compteDansDecaisse: boolean;
}

export interface ReponseMarche {
  genereLe: string;
  source: typeof SOURCE_COPIE_GELEE;
  droitFinancier: boolean;
  donneesPartielles: DonneesPartielles;
  marche: MarcheVue;
  decomptes: { liste: DecompteVue[]; tronque: boolean };
  definitions: typeof DEFINITIONS_CONTRACTUEL;
}

interface Contexte { regionsPerimetre: ReadonlySet<number> | null; nonRenseignees: ReadonlySet<number>; droitFinancier: boolean; maintenant: Date; regions: { id: number; nom: string }[] }

async function contexteDe(c: CompteLecture, deps: DepsContractuel): Promise<Contexte> {
  const p = await deps.perimetreDe(c);
  const regions = await deps.depot.chargerRegions();
  return {
    regionsPerimetre: p.national ? null : p.regions,
    nonRenseignees: regionsNonRenseignees(regions),
    droitFinancier: await deps.droitFinancierDe(c),
    maintenant: deps.maintenant(),
    regions,
  };
}

function analyser(m: MarcheEntree, ctx: Contexte, programmes: Parameters<typeof rattacherProgrammes>[1], marchesParTroncon: Parameters<typeof rattacherProgrammes>[2], plafondListes: number): Analyse {
  return analyserMarche(m, {
    maintenant: ctx.maintenant, droitFinancier: ctx.droitFinancier, perimetre: ctx.regionsPerimetre, regionsNonRenseignees: ctx.nonRenseignees,
    programmes: rattacherProgrammes(tronconsDuMarche(m), programmes, marchesParTroncon), plafondListes,
  });
}

function libellePerimetre(ctx: Contexte): string {
  if (ctx.regionsPerimetre === null) return "National : tous les marchés recensés";
  const noms = ctx.regions.filter((r) => ctx.regionsPerimetre!.has(r.id)).map((r) => r.nom);
  return `Périmètre régional (${noms.length ? noms.join(", ") : [...ctx.regionsPerimetre].join(", ")}) : marchés dont un chantier ou un tronçon est dans votre périmètre ; aucun total national`;
}

function apresCurseur(m: MarcheEntree, c: CurseurContractuel): boolean {
  const t = m.createdAt.getTime();
  const tc = new Date(c.c).getTime();
  return t < tc || (t === tc && m.id > c.i);
}

export async function lireContractuel(
  compte: CompteLecture,
  requete: { filtres: FiltresContractuel; limite: number; curseur: CurseurContractuel | null },
  deps: DepsContractuel = depsParDefaut,
): Promise<ReponseContractuel> {
  const ctx = await contexteDe(compte, deps);
  const { filtres } = requete;

  // Pre-selection regionale : perimetre du compte, reduit par le filtre `regionId` (la route a deja refuse un filtre hors perimetre).
  let regionsDepot: readonly number[] | null = ctx.regionsPerimetre === null ? null : [...ctx.regionsPerimetre];
  if (filtres.regionId !== undefined) regionsDepot = [filtres.regionId];

  const donnees = await deps.depot.chargerMarches({
    regions: regionsDepot, statutMarche: filtres.statutMarche, bailleurId: filtres.bailleurId, plafond: PLAFOND_MARCHES_ANALYSES,
  });

  const retenus: { m: MarcheEntree; a: Analyse }[] = [];
  let sansDate = 0;
  for (const m of donnees.marches) {
    const t = territoireDuMarche(m, ctx.nonRenseignees);
    if (!visibleDuPerimetre(t, ctx.regionsPerimetre)) continue;
    if (!correspondAuxFiltres(m, t, filtres)) {
      // Un marche sans aucune date est exclu par une fenetre de periode : on le compte, on ne le range pas.
      if ((filtres.depuis || filtres.jusqua) && !m.dateDebutPrevue && !m.dateSignature && !m.dateFinPrevue
        && correspondAuxFiltres(m, t, { ...filtres, depuis: undefined, jusqua: undefined })) sansDate += 1;
      continue;
    }
    retenus.push({ m, a: analyser(m, ctx, donnees.programmes, donnees.marchesParTroncon, PLAFOND_CHANTIERS_PAR_MARCHE) });
  }
  // Ordre : plus recent d'abord, identifiant en departage (le meme que le depot, refait ici parce que le noyau a retire des lignes).
  retenus.sort((x, y) => y.m.createdAt.getTime() - x.m.createdAt.getTime() || (x.m.id < y.m.id ? -1 : x.m.id > y.m.id ? 1 : 0));

  const analyses = retenus.map((r) => r.a);
  const sansMarche = await deps.depot.chantiersSansMarche({ regions: regionsDepot, statutChantier: filtres.statutChantier });

  // Curseur a cle (date de creation, identifiant) : stable si un marche est insere ou retire entre deux pages. Un curseur
  // qui ne designe plus rien (tout est avant lui) rend une page vide, jamais la premiere page.
  let debut = 0;
  if (requete.curseur) {
    debut = retenus.findIndex((r) => apresCurseur(r.m, requete.curseur!));
    if (debut < 0) debut = retenus.length;
  }
  const page = retenus.slice(debut, debut + requete.limite);
  const dernier = page[page.length - 1];
  const reste = debut + page.length < retenus.length;

  return {
    genereLe: ctx.maintenant.toISOString(),
    source: SOURCE_COPIE_GELEE,
    droitFinancier: ctx.droitFinancier,
    perimetre: {
      national: ctx.regionsPerimetre === null,
      regionIds: ctx.regionsPerimetre === null ? null : [...ctx.regionsPerimetre].sort((a, b) => a - b),
      libelle: libellePerimetre(ctx),
      totalNationalFourni: ctx.regionsPerimetre === null,
      filtres,
      ...(filtres.depuis || filtres.jusqua ? { exclusParFiltre: { sansDate } } : {}),
    },
    donneesPartielles: raisonsPartielles(analyses, { tronque: donnees.tronque, plafond: PLAFOND_MARCHES_ANALYSES }),
    fraicheur: evaluerFraicheur(analyses, ctx.maintenant),
    plafond: { marchesAnalyses: donnees.marches.length, plafond: PLAFOND_MARCHES_ANALYSES, tronque: donnees.tronque },
    synthese: synthetiser(analyses, ctx.droitFinancier),
    controles: agregerControles(analyses, sansMarche),
    marches: page.map((r) => r.a.vue),
    page: { limite: requete.limite, total: retenus.length, curseurSuivant: reste && dernier ? encoderCurseur({ c: dernier.m.createdAt.toISOString(), i: dernier.m.id }) : null },
    definitions: DEFINITIONS_CONTRACTUEL,
  };
}

const PLAFOND_DECOMPTES_FICHE = 200;
const PLAFOND_LISTES_FICHE = 200;

/** Fiche d'un marche. `null` : inexistant, supprime OU hors perimetre, indiscernables (meme 404). */
export async function lireMarche(compte: CompteLecture, id: string, deps: DepsContractuel = depsParDefaut): Promise<ReponseMarche | null> {
  const ctx = await contexteDe(compte, deps);
  const donnees = await deps.depot.chargerMarches({ regions: ctx.regionsPerimetre === null ? null : [...ctx.regionsPerimetre], marcheId: id, plafond: 1 });
  const m = donnees.marches.find((x) => x.id === id);
  if (!m) return null;
  if (!visibleDuPerimetre(territoireDuMarche(m, ctx.nonRenseignees), ctx.regionsPerimetre)) return null;
  const a = analyser(m, ctx, donnees.programmes, donnees.marchesParTroncon, PLAFOND_LISTES_FICHE);
  const masque = a.vue.territoire.montantsMasques;
  const payes = new Set(m.decomptes.filter((d) => d.statut === "PAYE").map((d) => d.id));
  const liste: DecompteVue[] = m.decomptes.slice(0, PLAFOND_DECOMPTES_FICHE).map((d) => ({
    numero: d.numero, type: d.type, statut: d.statut, montantGnf: masque ? null : d.montantGnf.toString(),
    dateEmission: d.dateEmission ? d.dateEmission.toISOString().slice(0, 10) : null,
    datePaiement: d.datePaiement ? d.datePaiement.toISOString().slice(0, 10) : null, compteDansDecaisse: payes.has(d.id),
  }));
  return {
    genereLe: ctx.maintenant.toISOString(), source: SOURCE_COPIE_GELEE, droitFinancier: ctx.droitFinancier,
    donneesPartielles: raisonsPartielles([a], { tronque: false, plafond: PLAFOND_MARCHES_ANALYSES }),
    marche: a.vue, decomptes: { liste, tronque: m.decomptes.length > PLAFOND_DECOMPTES_FICHE }, definitions: DEFINITIONS_CONTRACTUEL,
  };
}
