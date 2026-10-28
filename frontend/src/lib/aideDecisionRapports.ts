import type { FiltresDecision } from "../components/decision/types";
import { erreurPeriode, normaliserFiltres } from "./decision";

/**
 * Noyau pur de l'onglet « Rapports » (lot 6) : types de rapport, filtres que chaque type applique (et ceux qu'il
 * n'applique pas, avec la raison), droit d'exporter et sa raison, corps de la demande, apercu des parametres. Aucune
 * horloge, aucun DOM, aucun appel reseau.
 *
 * LE SERVEUR DECIDE. Ce fichier ne fait que PREVENIR l'utilisateur (bouton desactive AVEC la raison, filtres non appliques
 * annonces avant l'export) : toute regle ici est reverifiee cote serveur (module, role, perimetre, droit financier), et un
 * refus du serveur est affiche tel quel. Les tables `FILTRES_PAR_TYPE` et `RAISONS_NON_APPLIQUE` MIROITENT celles de
 * `backend/src/aide-decision/export.noyau.ts` : en cas d'ecart, le fichier remis (qui liste filtres appliques et non
 * appliques) fait foi.
 */

export type TypeRapport = "synthese" | "reseau_regions" | "interventions" | "scenario";
export type FormatRapport = "csv" | "json";

export const MENTION_CONSULTATIVE =
  "Consultatif, non engageant : les indicateurs provisoires, priorités calculées et simulations de ces rapports ne constituent ni une décision ni un engagement financier.";

type CleFiltre = keyof FiltresDecision;

export interface DefinitionTypeRapport {
  type: TypeRapport;
  libelle: string;
  description: string;
  /** Le rapport porte sur un scenario de programmation calcule et scelle. */
  necessiteScenario: boolean;
  /** Modules exiges EN PLUS du role (le module `rapports` est toujours exige). */
  modulesSupplementaires: string[];
  sources: string[];
  filtresPrisEnCharge: CleFiltre[];
  raisonsNonAppliques: Partial<Record<CleFiltre, string>>;
}

const INSTANTANE = "l'état du réseau est un instantané courant : aucune donnée n'est datée par période";
const SCENARIO_SCELLE = "un scénario est scellé à sa date de calcul : aucun filtre de période";

export const TYPES_RAPPORT: readonly DefinitionTypeRapport[] = [
  {
    type: "synthese", libelle: "Rapport de synthèse",
    description: "Les indicateurs du périmètre, avec leur définition, leur statut (provisoire) et leur couverture.",
    necessiteScenario: false, modulesSupplementaires: [],
    sources: ["Registre des tronçons (état courant, longueur métier)", "Marchés et chantiers (selon vos droits)", "Détecteurs de qualité"],
    filtresPrisEnCharge: ["regionId", "classe"],
    raisonsNonAppliques: {
      etat: "l'état est une dimension du rapport (km par état, non évalué à part), pas un filtre",
      statutChantier: "ce rapport ne porte pas sur les chantiers", depuis: INSTANTANE, jusqua: INSTANTANE,
    },
  },
  {
    type: "reseau_regions", libelle: "État du réseau par région",
    description: "Kilomètres par état et par région, non évalué à part, taux calculés sur les seuls états valides.",
    necessiteScenario: false, modulesSupplementaires: [],
    sources: ["Registre des tronçons, réseau classé saisi (état courant, longueur métier)"],
    filtresPrisEnCharge: ["regionId", "classe"],
    raisonsNonAppliques: {
      etat: "l'état est une dimension du rapport (km par état, non évalué à part), pas un filtre",
      statutChantier: "ce rapport ne porte pas sur les chantiers", depuis: INSTANTANE, jusqua: INSTANTANE,
    },
  },
  {
    type: "interventions", libelle: "Liste des interventions prioritaires",
    description: "Les tronçons classés par priorité dans un scénario de programmation, avec leur justification. Simulation, jamais une décision.",
    necessiteScenario: true, modulesSupplementaires: ["programmation"],
    sources: ["Scénario de programmation scellé (paramètres de priorité, barèmes embarqués)"],
    filtresPrisEnCharge: ["regionId", "classe", "etat"],
    raisonsNonAppliques: { statutChantier: "la liste ne porte pas sur les chantiers", depuis: SCENARIO_SCELLE, jusqua: SCENARIO_SCELLE },
  },
  {
    type: "scenario", libelle: "Scénario de programmation",
    description: "Toutes les lignes d'un scénario, retenues et écartées, avec le motif de chaque écart. Simulation non engageante.",
    necessiteScenario: true, modulesSupplementaires: ["programmation"],
    sources: ["Scénario de programmation scellé (paramètres de priorité, barèmes embarqués)"],
    filtresPrisEnCharge: ["regionId", "classe", "etat"],
    raisonsNonAppliques: { statutChantier: "un scénario ne porte pas sur les chantiers", depuis: SCENARIO_SCELLE, jusqua: SCENARIO_SCELLE },
  },
];

export function definitionType(t: TypeRapport): DefinitionTypeRapport {
  return TYPES_RAPPORT.find((d) => d.type === t) as DefinitionTypeRapport;
}

export function estTypeRapport(v: unknown): v is TypeRapport {
  return typeof v === "string" && TYPES_RAPPORT.some((d) => d.type === v);
}

/** Filtres du contrat que les donnees ne permettent pas (paragraphe 3) : annonces, jamais retires en silence. */
export const FILTRES_SANS_DONNEE: readonly { cle: string; libelle: string; raison: string }[] = [
  { cle: "prefecture", libelle: "Préfecture", raison: "texte libre sur le tronçon, aucune entité structurée" },
  { cle: "axe", libelle: "Axe / projet", raison: "aucune entité « axe » ni « projet » dans le référentiel" },
  { cle: "bailleur", libelle: "Bailleur / financement", raison: "trois formes non rapprochées (texte libre, clé étrangère)" },
  { cle: "gravite", libelle: "Gravité", raison: "aucune gravité structurée" },
  { cle: "intervention", libelle: "Type d'intervention", raison: "le moteur de priorisation ne l'expose pas encore" },
];

const LIBELLE_FILTRE: Record<CleFiltre, string> = {
  regionId: "Région", classe: "Classe de route", etat: "État", statutChantier: "Statut de chantier", depuis: "Début de période", jusqua: "Fin de période",
};

// ---------------------------------------------------------------------------------------------- droit d'exporter

export interface DroitsCompte { role?: string; modulesAutorises?: string[] }
export type Verdict = { ok: true } | { ok: false; raison: string };

const ROLES_EXPORT = ["ADMIN", "GESTIONNAIRE"];

/** ADMIN n'est jamais restreint ; pour les autres, une liste vide vaut AUCUN module (regle du serveur, lib/access.ts). */
export function moduleAutorise(c: DroitsCompte | null | undefined, cle: string): boolean {
  if (!c) return false;
  if (c.role === "ADMIN") return true;
  return (c.modulesAutorises ?? []).includes(cle);
}

/** Droit financier (PROVISOIRE, contrat paragraphe 2) : module `marches`. Sans lui, le fichier est remis sans colonne financiere. */
export function aDroitFinancier(c: DroitsCompte | null | undefined): boolean {
  return moduleAutorise(c, "marches");
}

/** Journal des exports : memes conditions que l'export (role ADMIN ou GESTIONNAIRE, module Rapports ; ADMIN jamais restreint). */
export function peutConsulterJournal(c: DroitsCompte | null | undefined): boolean {
  return !!c && !!c.role && ROLES_EXPORT.includes(c.role) && moduleAutorise(c, "rapports");
}

export function peutExporter(c: DroitsCompte | null | undefined, type: TypeRapport): Verdict {
  if (!c || !c.role) return { ok: false, raison: "Connexion requise pour exporter." };
  if (!ROLES_EXPORT.includes(c.role)) return { ok: false, raison: "L'export est réservé aux rôles Administrateur et Gestionnaire." };
  if (!moduleAutorise(c, "rapports")) return { ok: false, raison: "Le module Rapports n'est pas autorisé pour votre compte." };
  for (const m of definitionType(type).modulesSupplementaires) {
    if (!moduleAutorise(c, m)) return { ok: false, raison: "Ce rapport reprend des données du module Programmation, non autorisé pour votre compte." };
  }
  return { ok: true };
}

/** Verdict complet du bouton : droits, puis coherence de la demande. La raison est TOUJOURS affichee quand le bouton est inactif. */
export function verdictExport(c: DroitsCompte | null | undefined, type: TypeRapport, filtres: FiltresDecision, scenarioId: string | null): Verdict {
  const droit = peutExporter(c, type);
  if (!droit.ok) return droit;
  const periode = erreurPeriode(filtres);
  if (periode) return { ok: false, raison: `${periode} Corrigez la période avant d'exporter.` };
  if (definitionType(type).necessiteScenario && !scenarioId) return { ok: false, raison: "Choisissez le scénario à exporter." };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------- demande et apercu

export interface CorpsExport { type: TypeRapport; format: FormatRapport; filtres?: FiltresDecision; scenarioId?: string }

/** Corps envoye au serveur : seuls les filtres valides, rien d'autre. Une demande SANS filtre est une demande de tout le perimetre autorise. */
export function corpsExport(type: TypeRapport, format: FormatRapport, filtres: FiltresDecision, scenarioId: string | null): CorpsExport {
  const f = normaliserFiltres(filtres);
  return {
    type, format,
    ...(Object.keys(f).length > 0 ? { filtres: f } : {}),
    ...(definitionType(type).necessiteScenario && scenarioId ? { scenarioId } : {}),
  };
}

export interface LigneFiltre { cle: string; libelle: string; valeur: string }
export interface LigneFiltreNonApplique { cle: string; libelle: string; raison: string }

function valeurFiltre(cle: CleFiltre, f: FiltresDecision, nomRegion: string | null): string {
  if (cle === "regionId") return nomRegion ?? `région n° ${f.regionId}`;
  const v = f[cle];
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/** Ce que le rapport applique, ce qu'il n'applique pas (avec la raison), et ce que les donnees ne permettent pas. */
export function repartitionFiltres(type: TypeRapport, filtres: FiltresDecision, nomRegion: string | null = null): {
  appliques: LigneFiltre[]; nonAppliques: LigneFiltreNonApplique[]; sansDonnee: typeof FILTRES_SANS_DONNEE;
} {
  const def = definitionType(type);
  const f = normaliserFiltres(filtres);
  const appliques: LigneFiltre[] = [];
  const nonAppliques: LigneFiltreNonApplique[] = [];
  for (const cle of ["regionId", "classe", "etat", "statutChantier", "depuis", "jusqua"] as const) {
    if (f[cle] === undefined) continue;
    if (def.filtresPrisEnCharge.includes(cle)) appliques.push({ cle, libelle: LIBELLE_FILTRE[cle], valeur: valeurFiltre(cle, f, nomRegion) });
    else nonAppliques.push({ cle, libelle: LIBELLE_FILTRE[cle], raison: def.raisonsNonAppliques[cle] ?? "filtre non pris en charge par ce rapport" });
  }
  return { appliques, nonAppliques, sansDonnee: FILTRES_SANS_DONNEE };
}

export interface ApercuParametres {
  titre: string;
  periode: string;
  perimetre: string;
  sources: string[];
  unites: string;
  financier: string;
}

/** Aperçu des paramètres AVANT export : période, périmètre, sources, droit financier. Rien n'est calculé ici. */
export function apercuParametres(type: TypeRapport, filtres: FiltresDecision, c: DroitsCompte | null | undefined, nomRegion: string | null = null): ApercuParametres {
  const def = definitionType(type);
  const f = normaliserFiltres(filtres);
  const nonAdmin = c?.role !== "ADMIN";
  const periodeAppliquee = def.filtresPrisEnCharge.includes("depuis") || def.filtresPrisEnCharge.includes("jusqua");
  return {
    titre: def.libelle,
    periode: periodeAppliquee && (f.depuis || f.jusqua)
      ? `${f.depuis ?? "début non borné"} au ${f.jusqua ?? "fin non bornée"}`
      : "Instantané à la date de génération (aucune période appliquée)",
    perimetre: f.regionId !== undefined
      ? `${nomRegion ?? `Région n° ${f.regionId}`}, dans la limite de votre périmètre territorial`
      : nonAdmin ? "Votre périmètre territorial, tel que le serveur l'applique (jamais plus)" : "Toutes les régions",
    sources: def.sources,
    unites: "Longueurs en km (longueur métier), taux en %, montants en GNF (chaînes exactes).",
    financier: aDroitFinancier(c)
      ? "Droit financier : les colonnes financières seront incluses."
      : "Sans droit financier (module Marchés) : les colonnes et indicateurs financiers seront retirés du fichier.",
  };
}

// ---------------------------------------------------------------------------------------------- fichier

/** Nom de fichier propose par le serveur (en-tete Content-Disposition), assaini ; repli si absent. */
export function nomFichierExport(contentDisposition: string | undefined | null, repli: string): string {
  const m = /filename="?([^";]+)"?/i.exec(contentDisposition ?? "");
  const brut = m?.[1]?.trim();
  if (!brut) return repli;
  return brut.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || repli;
}

export const LIBELLE_FORMAT: Record<FormatRapport, string> = { csv: "CSV (tableur)", json: "JSON (échange de données)" };

// ---------------------------------------------------------------------------------------------- journal

const LIBELLE_JOURNAL: Record<string, string> = {
  synthese: "Rapport de synthèse", reseau_regions: "État du réseau par région",
  interventions: "Interventions prioritaires", scenario: "Scénario de programmation",
};

export function libelleTypeJournal(type: string): string {
  if (type.startsWith("selection:")) return `Sélection d'objets (${type.slice("selection:".length)})`;
  return LIBELLE_JOURNAL[type] ?? type;
}

/** Filtres d'une ligne de journal, en clair. Un export sans filtre le dit (« tout le périmètre autorisé »), il ne reste pas muet. */
export function resumeFiltresJournal(filtres: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filtres)) {
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    parts.push(`${k} = ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  return parts.length > 0 ? parts.join(" ; ") : "aucun filtre (tout le périmètre autorisé)";
}

// ---------------------------------------------------------------------------------------------- lignes du rapport par region

/**
 * Longueur des troncons d'une region : « connue », « partielle » ou « non renseignee ». Une region dont AUCUN troncon n'a de
 * longueur metier ne montre pas « 0 km » : ses kilometres sont inconnus (le serveur compte le troncon, il n'additionne pas une
 * longueur qu'il n'a pas).
 */
export type StatutLongueur = "CONNUE" | "PARTIELLE" | "NON_RENSEIGNEE";

export function statutLongueur(l: { troncons: number | null; tronconsSansLongueurMetier: number | null; kmPerimetre: number | null }): StatutLongueur {
  const n = l.troncons ?? 0;
  const sans = l.tronconsSansLongueurMetier ?? 0;
  if (n > 0 && (sans >= n || (l.tronconsSansLongueurMetier === null && l.kmPerimetre === 0))) return "NON_RENSEIGNEE";
  return sans > 0 ? "PARTIELLE" : "CONNUE";
}

export function mentionLongueur(l: { troncons: number | null; tronconsSansLongueurMetier: number | null; kmPerimetre: number | null }): string | null {
  const st = statutLongueur(l);
  if (st === "NON_RENSEIGNEE") return "Longueur non renseignée";
  if (st === "PARTIELLE") {
    const sans = l.tronconsSansLongueurMetier ?? 0;
    return `${sans} tronçon${sans > 1 ? "s" : ""} sans longueur métier : km partiels`;
  }
  return null;
}

export const LIBELLE_DISPONIBILITE: Record<string, string> = {
  DISPONIBLE: "Taux disponible", PARTIEL: "Taux partiel (données incomplètes)", NON_DISPONIBLE: "Taux non disponible",
};
