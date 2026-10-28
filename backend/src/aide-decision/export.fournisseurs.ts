/**
 * FOURNISSEURS REELS des exports gouvernes (lot 6) : ils lisent la base, en LECTURE SEULE, par les fonctions des autres
 * lots quand elles existent, et ne duplique aucune formule.
 *
 *  - `synthese`      : `composerSynthese` du lot 2 (les memes indicateurs que l'ecran, au meme perimetre : AD-11) ;
 *  - `reseauRegions` : `lireRapportRegions` (adaptateur mince sur `kpi.noyau` / `kpi.depot` du lot 2) ;
 *  - `interventions` et `scenario` : un scenario de programmation SCELLE (`scenarios_programmation`, lu par
 *    `moteur.depot.lireScenario`). Le lot 3 (liste d'interventions priorisee) et le lot 4 (export de scenario) n'existaient
 *    pas a la livraison de ce lot : l'interface `Fournisseurs` (export.service.ts) est la prise ou ils se brancheront ; en
 *    attendant, l'export relit la meme source de verite qu'eux, le scenario scelle, sans second moteur.
 *
 * Un fournisseur ne controle PAS le territoire d'une ressource designee par identifiant (c'est la route, avant l'appel) ;
 * il filtre en revanche les LIGNES sur la portee du compte (defense en profondeur) et ne rend jamais une valeur inconnue
 * sous la forme d'un zero.
 */
import { prisma } from "../lib/prisma";
import { lireScenario } from "../programmation/moteur.depot";
import { composerSynthese, depotPrisma, type Kpi } from "./synthese";
import { DICTIONNAIRE } from "./dictionnaire";
import { jeuReseauRegions, lireRapportRegions } from "./rapport.regions";
import type { Colonne, DefinitionIndicateur, FiltresExport, JeuDonnees, SourceExport } from "./export.noyau";
import type { ContexteProduction, Fournisseurs, ProduitExport } from "./export.service";

const ORIGINE_DICTIONNAIRE = "dictionnaire des indicateurs du lot 2 (GET /api/v2/aide-decision/dictionnaire)";

function definitionDe(code: string): DefinitionIndicateur | null {
  const e = DICTIONNAIRE.find((d) => d.code === code);
  return e ? {
    code: e.code, libelle: e.libelle, definition: e.definition, formule: e.formule, unite: e.unite,
    statutDefinition: e.statutDefinition, origine: ORIGINE_DICTIONNAIRE,
  } : null;
}

// ------------------------------------------------------------------------------------------------------ synthese

const COLONNES_SYNTHESE: Colonne[] = [
  { cle: "code", libelle: "Code de l'indicateur", unite: null },
  { cle: "libelle", libelle: "Libelle", unite: null },
  { cle: "valeur", libelle: "Valeur (vide si non disponible : jamais un zero)", unite: null },
  { cle: "unite", libelle: "Unite", unite: null },
  { cle: "etat", libelle: "Disponibilite (DISPONIBLE, PARTIEL, NON_DISPONIBLE, ...)", unite: null },
  { cle: "statut_definition", libelle: "Statut de la definition (PROVISOIRE tant que le metier ne l'a pas validee)", unite: null },
  { cle: "perimetre", libelle: "Perimetre", unite: null },
  { cle: "periode_depuis", libelle: "Debut de periode", unite: "date" },
  { cle: "periode_jusqua", libelle: "Fin de periode", unite: "date" },
  { cle: "source", libelle: "Source", unite: null },
  { cle: "calcule_le", libelle: "Calcule le", unite: "date-heure" },
  { cle: "couverture_evalue_km", libelle: "Longueur evaluee", unite: "km" },
  { cle: "couverture_eligible_km", libelle: "Longueur eligible (denominateur)", unite: "km" },
  { cle: "avertissements", libelle: "Avertissements propres a l'indicateur", unite: null },
];

function ligneKpi(k: Kpi) {
  return {
    code: k.code, libelle: k.libelle,
    // Les montants GNF restent des chaines exactes ; une valeur absente reste vide.
    valeur: k.valeurTexte ?? k.valeur, unite: k.unite, etat: k.etat, statut_definition: k.statutDefinition,
    perimetre: k.perimetre.libelle, periode_depuis: k.periode?.depuis ?? null, periode_jusqua: k.periode?.jusqua ?? null,
    source: k.source, calcule_le: k.calculeLe,
    couverture_evalue_km: k.couverture?.evalueKm ?? null, couverture_eligible_km: k.couverture?.eligibleKm ?? null,
    avertissements: k.avertissements.join(" | ") || null,
  };
}

async function synthese(ctx: ContexteProduction, filtres: FiltresExport): Promise<ProduitExport> {
  const s = await composerSynthese(depotPrisma(prisma), {
    regions: ctx.portee.regions, maintenant: ctx.maintenant,
    filtres: { regionId: filtres.regionId, classe: filtres.classe },
    droits: { marches: ctx.droits.marches, programmation: ctx.droits.programmation },
  });
  const avertissements = [...s.avertissements, s.consultatif];
  // Un indicateur financier (unite GNF) est une LIGNE, pas une colonne : il est retire en entier sans droit financier.
  let kpis = s.kpis;
  if (!ctx.droits.financier) {
    const retires = kpis.filter((k) => k.unite === "GNF").map((k) => k.code);
    kpis = kpis.filter((k) => k.unite !== "GNF");
    if (retires.length > 0) avertissements.push(`Indicateurs financiers retires (droit financier absent) : ${retires.join(", ")}.`);
  }
  const jeu: JeuDonnees = { colonnes: COLONNES_SYNTHESE, lignes: kpis.map(ligneKpi) };
  const sources: SourceExport[] = [...new Set(kpis.map((k) => k.source))].map((src, i) => ({
    code: `source_${i + 1}`, libelle: src, dateReference: s.calculeLe,
  }));
  if (s.fraicheur.derniereEvaluationLe) {
    sources.push({ code: "derniere_evaluation_troncons", libelle: "Derniere evaluation d'un troncon a etat valide", dateReference: s.fraicheur.derniereEvaluationLe });
  }
  const definitions: DefinitionIndicateur[] = kpis.map((k) => ({
    code: k.code, libelle: k.libelle, definition: k.definition, formule: k.formule, unite: k.unite,
    statutDefinition: k.statutDefinition, origine: ORIGINE_DICTIONNAIRE,
  }));
  return { jeu, sources, definitions, avertissements };
}

// ------------------------------------------------------------------------------------------------------ etat par region

async function reseauRegions(ctx: ContexteProduction, filtres: FiltresExport): Promise<ProduitExport> {
  const r = await lireRapportRegions(depotPrisma(prisma), {
    regions: ctx.portee.regions, classes: filtres.classe ?? null, maintenant: ctx.maintenant,
  });
  return {
    jeu: jeuReseauRegions(r),
    sources: [{ code: "troncons", libelle: "Registre des troncons, reseau classe saisi (etat courant, longueur metier)", dateReference: r.derniereEvaluationLe }],
    definitions: ["reseau_degrade_pct", "reseau_critique_pct", "couverture_etat_part"]
      .map(definitionDe).filter((d): d is DefinitionIndicateur => d !== null),
    avertissements: [
      ...r.avertissements,
      `Parametres ${r.parametres.version} (${r.parametres.statutDefinition}) : degrade = ${r.parametres.classesDegradees.join(" + ")}, critique = ${r.parametres.classesCritiques.join(" + ")}. ${r.parametres.origine}`,
    ],
  };
}

// ------------------------------------------------------------------------------------------------------ scenario

interface LigneStockee {
  troncon: { code: string; nom: string | null; regionId: number | null; classe: string | null; revetement: string | null; etat: string | null; longueurM: number | null; longueurOrigine: string | null };
  decision: string;
  rangPriorite: number | null;
  rangRetenu: number | null;
  motifExclusion: { code: string; detail: string } | null;
  risque: { ok: boolean; score?: number; couverture?: number; code?: string; motif?: string; formule?: string };
  traitement: { ok: boolean; traitement?: { code: string } } | null;
  cout: { ok: boolean; montantGnf?: string; devise?: string; classePrecision?: string; provisoire?: boolean; bareme?: { id: number | string }; code?: string } | null;
  priorite: { ratioPointsParMilliardGnf: string } | null;
  budget: { resteApresGnf: string } | null;
  etiquette: string;
  justification: string;
}

interface ScenarioStocke {
  annee: number;
  budgetGnf: string;
  parametres: { version: string; source: string; approuveeLe: string | null; etiquette: string };
  provisoire: boolean;
  etiquette: string;
  motifsProvisoire: string[];
  limites: string[];
  avertissement: string;
  totaux: { candidats: number; eligibles: number; retenues: number; ecartees: number; engageGnf: string; resteGnf: string };
  lignes: LigneStockee[];
}

const COLONNES_SCENARIO: Colonne[] = [
  { cle: "rang_priorite", libelle: "Rang de priorite (troncons chiffrables)", unite: "rang" },
  { cle: "rang_retenu", libelle: "Rang parmi les lignes retenues", unite: "rang" },
  { cle: "decision", libelle: "RETENUE ou ECARTEE (simulation, jamais une decision)", unite: null },
  { cle: "troncon_code", libelle: "Code du troncon", unite: null },
  { cle: "troncon_nom", libelle: "Nom du troncon", unite: null },
  { cle: "region", libelle: "Region", unite: null },
  { cle: "classe", libelle: "Classe de route", unite: null },
  { cle: "revetement", libelle: "Revetement", unite: null },
  { cle: "etat", libelle: "Etat du troncon", unite: null },
  { cle: "longueur_km", libelle: "Longueur a traiter (troncon entier)", unite: "km" },
  { cle: "longueur_origine", libelle: "Origine de la longueur (LONGUEUR_KM metier, GEOMETRIE)", unite: null },
  { cle: "risque_score", libelle: "Score de risque (vide si non calculable)", unite: "points 0-100" },
  { cle: "risque_couverture", libelle: "Part des facteurs de risque disponibles", unite: "part" },
  { cle: "risque_refus", libelle: "Motif de non calcul du risque", unite: null },
  { cle: "traitement_code", libelle: "Traitement propose", unite: null },
  { cle: "motif_exclusion_code", libelle: "Motif d'ecart", unite: null },
  // Texte libre qui cite des montants en GNF (« cout X superieur au reste de l'enveloppe Y ») : colonne financiere.
  { cle: "motif_exclusion_detail", libelle: "Detail du motif d'ecart (cite des montants)", unite: null, financier: true },
  { cle: "cout_refus", libelle: "Motif de cout non estimable", unite: null },
  { cle: "etiquette", libelle: "Etiquette de la ligne (provisoire, estime...)", unite: null },
  // Idem : la justification cite le cout, le reste de l'enveloppe avant et apres. Retiree sans droit financier.
  { cle: "justification", libelle: "Justification explicable (cite des montants)", unite: null, financier: true },
  { cle: "cout_estime_gnf", libelle: "Cout estime (provisoire)", unite: "GNF", financier: true },
  { cle: "devise", libelle: "Devise", unite: null, financier: true },
  { cle: "classe_precision_cout", libelle: "Classe de precision du cout", unite: null, financier: true },
  { cle: "cout_provisoire", libelle: "Cout provisoire (bareme non approuve, millesime ou largeur inconnus)", unite: null, financier: true },
  { cle: "bareme_id", libelle: "Ligne de bareme citee", unite: null, financier: true },
  { cle: "ratio_points_par_milliard", libelle: "Points de risque evites par milliard GNF", unite: "points/Md GNF", financier: true },
  { cle: "reste_apres_gnf", libelle: "Enveloppe restante apres la ligne", unite: "GNF", financier: true },
];

function lireStocke(texte: string): ScenarioStocke | null {
  try {
    const j = JSON.parse(texte) as ScenarioStocke;
    return j && Array.isArray(j.lignes) ? j : null;
  } catch { return null; }
}

async function nomsRegions(): Promise<Map<number, string>> {
  return depotPrisma(prisma).nomsRegions();
}

async function produitScenario(ctx: ContexteProduction, filtres: FiltresExport, scenarioId: string, seulementPriorites: boolean): Promise<ProduitExport | null> {
  const ligne = await lireScenario(prisma, scenarioId);
  if (!ligne) return null;
  const s = lireStocke(ligne.resultatCanonique);
  if (!s) return null;
  const noms = await nomsRegions();

  const regionsAutorisees = ctx.portee.regions === null ? null : new Set(ctx.portee.regions);
  let lignes = s.lignes.filter((l) => {
    const r = l.troncon.regionId;
    // Defense en profondeur : une ligne sans region ou hors portee n'est jamais exportee pour un compte regional.
    if (regionsAutorisees !== null && (r === null || !regionsAutorisees.has(r))) return false;
    if (filtres.regionId !== undefined && r !== filtres.regionId) return false;
    if (filtres.classe?.length && !(l.troncon.classe && filtres.classe.includes(l.troncon.classe))) return false;
    if (filtres.etat?.length && !(l.troncon.etat && filtres.etat.includes(l.troncon.etat))) return false;
    return true;
  });
  if (seulementPriorites) lignes = lignes.filter((l) => l.rangPriorite !== null).sort((a, b) => (a.rangPriorite as number) - (b.rangPriorite as number));

  const rows = lignes.map((l) => ({
    rang_priorite: l.rangPriorite, rang_retenu: l.rangRetenu, decision: l.decision,
    troncon_code: l.troncon.code, troncon_nom: l.troncon.nom,
    region: l.troncon.regionId === null ? null : (noms.get(l.troncon.regionId) ?? String(l.troncon.regionId)),
    classe: l.troncon.classe, revetement: l.troncon.revetement, etat: l.troncon.etat,
    longueur_km: l.troncon.longueurM === null ? null : Math.round(l.troncon.longueurM) / 1000,
    longueur_origine: l.troncon.longueurOrigine,
    risque_score: l.risque.ok ? (l.risque.score ?? null) : null,
    risque_couverture: l.risque.ok ? (l.risque.couverture ?? null) : null,
    risque_refus: l.risque.ok ? null : (l.risque.motif ?? l.risque.code ?? "non calculable"),
    traitement_code: l.traitement?.ok ? (l.traitement.traitement?.code ?? null) : null,
    motif_exclusion_code: l.motifExclusion?.code ?? null, motif_exclusion_detail: l.motifExclusion?.detail ?? null,
    cout_refus: l.cout && !l.cout.ok ? (l.cout.code ?? "non estimable") : null,
    etiquette: l.etiquette, justification: l.justification,
    cout_estime_gnf: l.cout?.ok ? (l.cout.montantGnf ?? null) : null,
    devise: l.cout?.ok ? (l.cout.devise ?? null) : null,
    classe_precision_cout: l.cout?.ok ? (l.cout.classePrecision ?? null) : null,
    cout_provisoire: l.cout?.ok ? (l.cout.provisoire ?? null) : null,
    bareme_id: l.cout?.ok ? (l.cout.bareme ? String(l.cout.bareme.id) : null) : null,
    ratio_points_par_milliard: l.priorite?.ratioPointsParMilliardGnf ?? null,
    reste_apres_gnf: l.budget?.resteApresGnf ?? null,
  }));

  const formule = s.lignes.find((l) => l.risque.ok && l.risque.formule)?.risque.formule;
  const avertissements = [
    s.avertissement, s.etiquette,
    ...s.motifsProvisoire.map((m) => `Scenario provisoire : ${m}`),
    ...s.limites,
    `Scenario de ${s.annee} : ${s.totaux.candidats} candidats, ${s.totaux.eligibles} eligibles, ${s.totaux.retenues} retenues, ${s.totaux.ecartees} ecartees.`,
    ...(lignes.length < s.lignes.length && !seulementPriorites
      ? [`${s.lignes.length - lignes.length} ligne(s) du scenario ne figurent pas dans ce fichier (filtres ou perimetre du compte).`] : []),
    ...(seulementPriorites ? ["Seuls les troncons classes (rang de priorite) sont listes ; les ecartes avant classement figurent dans l'export de scenario."] : []),
  ];
  if (ctx.droits.financier) {
    avertissements.push(`Enveloppe saisie ${s.budgetGnf} GNF, engagee en simulation ${s.totaux.engageGnf} GNF, reste ${s.totaux.resteGnf} GNF : simulation, aucun engagement.`);
  }
  return {
    jeu: { colonnes: COLONNES_SCENARIO, lignes: rows },
    sources: [{
      code: "scenarios_programmation",
      libelle: `Scenario scelle « ${ligne.intitule} » (parametres ${s.parametres.version}, ${s.parametres.etiquette}, empreinte des resultats ${ligne.empreinteResultat})`,
      dateReference: ligne.creeLe instanceof Date ? ligne.creeLe.toISOString() : String(ligne.creeLe),
    }],
    definitions: [{
      code: "risque_score", libelle: "Score de risque du moteur de programmation",
      definition: "Score de 0 a 100 calcule sur les facteurs disponibles, ponderes par les parametres de programmation (poids PROVISOIRES tant que non approuves). Un facteur absent n'est pas compte comme zero.",
      formule: formule ?? "voir la justification de chaque ligne", unite: "points 0-100",
      statutDefinition: "PROVISOIRE", origine: "moteur de programmation (programmation/scenario.noyau.ts)",
    }],
    avertissements,
  };
}

export const fournisseursReels: Fournisseurs = {
  synthese,
  reseauRegions,
  interventions: (ctx, filtres, id) => produitScenario(ctx, filtres, id, true),
  scenario: (ctx, filtres, id) => produitScenario(ctx, filtres, id, false),
};
