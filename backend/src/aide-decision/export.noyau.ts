/**
 * NOYAU PUR des exports gouvernes de l'Aide a la decision (lot 6) : AUCUN import, aucune horloge (l'instant est un
 * parametre), aucun acces a la base. Il decide ce qu'un fichier doit porter, retire ce qu'un compte n'a pas le droit de
 * lire, et ecrit le CSV / JSON.
 *
 * CE QU'UN FICHIER PORTE (CONTRAT-AD.md paragraphe 6) : date de generation, auteur, filtres appliques ET filtres non
 * appliques (avec la raison), perimetre, unites, sources et dates de reference, definitions des indicateurs, avertissements
 * sur les donnees partielles, mention « consultatif, non engageant », nombre de lignes, colonnes financieres retirees.
 * Un filtre que l'export ne sait pas appliquer est DIT, jamais retire en silence : un fichier qui laisserait croire qu'il
 * est filtre par periode alors qu'il ne l'est pas serait pire que pas de filtre.
 *
 * AUCUNE COLONNE FINANCIERE POUR UN COMPTE SANS DROIT FINANCIER. Chaque colonne dit si elle est financiere ; le retrait
 * porte sur l'en-tete ET sur chaque ligne, et les colonnes retirees sont nommees dans le fichier (le lecteur sait que le
 * fichier est incomplet, il n'a pas a deviner).
 *
 * LE CSV NE SERT PAS DE VECTEUR D'INJECTION DE FORMULE : une cellule texte qui commence par = + - @ (ou tabulation,
 * retour chariot) est prefixee d'une apostrophe, comme le recommande l'OWASP. Les nombres ne sont pas touches.
 */

// ------------------------------------------------------------------------------------------------------ constantes

export const MENTION_CONSULTATIVE =
  "Consultatif, non engageant : les indicateurs provisoires, priorites calculees et simulations de ce fichier ne constituent ni une decision ni un engagement financier.";

/**
 * Plafond de lignes d'un fichier. PROVISOIRE : le cahier ne fixe aucune limite ; 10 000 lignes tiennent largement
 * dans un tableur et dans la memoire d'une requete. Au-dela : 413 et un message qui dit quoi faire (restreindre le perimetre).
 */
export const LIMITE_LIGNES_EXPORT = 10_000;

export const TYPES_EXPORT = ["synthese", "reseau_regions", "interventions", "scenario"] as const;
export type TypeExport = (typeof TYPES_EXPORT)[number];
export const FORMATS_EXPORT = ["csv", "json"] as const;
export type FormatExport = (typeof FORMATS_EXPORT)[number];

export const LIBELLE_TYPE: Record<TypeExport, string> = {
  synthese: "Rapport de synthese (indicateurs du perimetre)",
  reseau_regions: "Etat du reseau par region",
  interventions: "Liste des interventions prioritaires",
  scenario: "Scenario de programmation (simulation)",
};

export interface FiltresExport {
  regionId?: number;
  classe?: string[];
  etat?: string[];
  statutChantier?: string[];
  depuis?: string;
  jusqua?: string;
}
type CleFiltre = keyof FiltresExport;

export type Cellule = string | number | boolean | null;

export interface Colonne {
  cle: string;
  libelle: string;
  unite: string | null;
  /** Montant ou valeur derivee d'un montant : retiree pour un compte sans droit financier. */
  financier?: boolean;
}

export interface JeuDonnees {
  colonnes: Colonne[];
  lignes: Record<string, Cellule>[];
}

export interface SourceExport { code: string; libelle: string; dateReference: string | null }

export interface DefinitionIndicateur {
  code: string;
  libelle: string;
  definition: string;
  formule: string;
  unite: string;
  statutDefinition: "PROVISOIRE" | "VALIDEE";
  /** D'ou vient la definition : le dictionnaire du lot 2, ou le contrat (adaptateur local, a remplacer). */
  origine: string;
}

export interface PerimetreExport { libelle: string; national: boolean; regionIds: number[] | null }

export interface EnteteExport {
  titre: string;
  type: string;
  format: FormatExport | "geojson";
  exportId: string;
  genereLe: string;
  auteur: { id: string; email: string; role: string };
  filtresDemandes: FiltresExport;
  filtresAppliques: FiltresExport;
  filtresNonAppliques: { filtre: string; raison: string }[];
  perimetre: PerimetreExport;
  unites: Record<string, string>;
  sources: SourceExport[];
  definitions: DefinitionIndicateur[];
  avertissements: string[];
  mention: string;
  nbLignes: number;
  limiteLignes: number;
  droitFinancier: boolean;
  colonnesFinancieresRetirees: string[];
}

// ------------------------------------------------------------------------------------------------------ filtres

/** Filtres que chaque type sait appliquer. Les autres sont rendus non appliques, avec leur raison. */
const FILTRES_PRIS_EN_CHARGE: Record<TypeExport, readonly CleFiltre[]> = {
  synthese: ["regionId", "classe"],
  reseau_regions: ["regionId", "classe"],
  interventions: ["regionId", "classe", "etat"],
  scenario: ["regionId", "classe", "etat"],
};

const RAISON_NON_APPLIQUE: Record<TypeExport, Partial<Record<CleFiltre, string>>> = {
  synthese: {
    etat: "l'etat est une dimension du rapport (km par etat, non evalue a part), pas un filtre : un taux sur un seul etat n'aurait pas de sens",
    statutChantier: "ce rapport ne porte pas sur les chantiers",
    depuis: "l'etat du reseau est un instantane courant : aucune donnee n'est datee par periode",
    jusqua: "l'etat du reseau est un instantane courant : aucune donnee n'est datee par periode",
  },
  reseau_regions: {
    etat: "l'etat est une dimension du rapport (km par etat, non evalue a part), pas un filtre",
    statutChantier: "ce rapport ne porte pas sur les chantiers",
    depuis: "l'etat du reseau est un instantane courant : aucune donnee n'est datee par periode",
    jusqua: "l'etat du reseau est un instantane courant : aucune donnee n'est datee par periode",
  },
  interventions: {
    statutChantier: "la liste ne porte pas sur les chantiers",
    depuis: "la liste est celle d'un scenario scelle a sa date de calcul : aucun filtre de periode",
    jusqua: "la liste est celle d'un scenario scelle a sa date de calcul : aucun filtre de periode",
  },
  scenario: {
    statutChantier: "un scenario ne porte pas sur les chantiers",
    depuis: "un scenario est scelle a sa date de calcul : aucun filtre de periode",
    jusqua: "un scenario est scelle a sa date de calcul : aucun filtre de periode",
  },
};

/** Filtres du contrat (paragraphe 3) que les donnees ne permettent PAS : toujours listes, jamais retires en silence. */
export const FILTRES_INDISPONIBLES: readonly { filtre: string; raison: string }[] = [
  { filtre: "prefecture", raison: "texte libre sur le troncon, aucune entite structuree" },
  { filtre: "axe", raison: "aucune entite « axe » dans le referentiel" },
  { filtre: "bailleur", raison: "texte libre sur les chantiers, cle etrangere sur les marches : trois formes non rapprochees" },
  { filtre: "gravite", raison: "aucune gravite structuree" },
  { filtre: "type_intervention", raison: "le moteur de priorisation ne l'expose pas encore" },
];

const vide = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === "";

export function partitionnerFiltres(type: TypeExport, demandes: FiltresExport): {
  appliques: FiltresExport;
  nonAppliques: { filtre: string; raison: string }[];
} {
  const pris = new Set<CleFiltre>(FILTRES_PRIS_EN_CHARGE[type]);
  const appliques: FiltresExport = {};
  const nonAppliques: { filtre: string; raison: string }[] = [];
  for (const cle of ["regionId", "classe", "etat", "statutChantier", "depuis", "jusqua"] as const) {
    const v = demandes[cle];
    if (vide(v)) continue;
    if (pris.has(cle)) (appliques as Record<string, unknown>)[cle] = v;
    else nonAppliques.push({ filtre: cle, raison: RAISON_NON_APPLIQUE[type][cle] ?? "filtre non pris en charge par ce type d'export" });
  }
  for (const f of FILTRES_INDISPONIBLES) nonAppliques.push({ filtre: f.filtre, raison: `indisponible : ${f.raison}` });
  return { appliques, nonAppliques };
}

export function resumeFiltres(f: FiltresExport): string {
  const parts: string[] = [];
  if (f.regionId !== undefined) parts.push(`regionId=${f.regionId}`);
  if (f.classe?.length) parts.push(`classe=${f.classe.join(",")}`);
  if (f.etat?.length) parts.push(`etat=${f.etat.join(",")}`);
  if (f.statutChantier?.length) parts.push(`statutChantier=${f.statutChantier.join(",")}`);
  if (f.depuis) parts.push(`depuis=${f.depuis}`);
  if (f.jusqua) parts.push(`jusqua=${f.jusqua}`);
  return parts.length > 0 ? parts.join("; ") : "aucun filtre (tout le perimetre autorise)";
}

// ------------------------------------------------------------------------------------------------------ droit financier

/** Retire les colonnes financieres (en-tete ET lignes) quand le compte n'a pas le droit financier. */
export function retirerColonnesFinancieres(jeu: JeuDonnees, droitFinancier: boolean): { jeu: JeuDonnees; retirees: string[] } {
  if (droitFinancier) return { jeu, retirees: [] };
  const retirees = jeu.colonnes.filter((c) => c.financier).map((c) => c.cle);
  if (retirees.length === 0) return { jeu, retirees };
  const interdit = new Set(retirees);
  return {
    jeu: {
      colonnes: jeu.colonnes.filter((c) => !interdit.has(c.cle)),
      lignes: jeu.lignes.map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => !interdit.has(k)))),
    },
    retirees,
  };
}

// ------------------------------------------------------------------------------------------------------ plafond

export type VerdictPlafond = { ok: true } | { ok: false; statut: 413; code: "EXPORT_TROP_VOLUMINEUX"; message: string };

export function verifierPlafond(nbLignes: number, limite: number = LIMITE_LIGNES_EXPORT): VerdictPlafond {
  if (nbLignes <= limite) return { ok: true };
  return {
    ok: false, statut: 413, code: "EXPORT_TROP_VOLUMINEUX",
    message: `L'export porterait ${nbLignes} lignes, au-dela du plafond de ${limite}. Restreignez le perimetre (region, classe) : aucun fichier tronque n'est remis.`,
  };
}

// ------------------------------------------------------------------------------------------------------ rendu

/** Neutralise l'interpretation d'une cellule comme formule par un tableur. */
export function neutraliserFormule(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function cellule(v: Cellule | undefined): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? neutraliserFormule(v) : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const ligneCsv = (cellules: readonly (Cellule | undefined)[]): string => cellules.map(cellule).join(";");

export function nomFichier(type: string, format: FormatExport, instant: Date): string {
  const t = instant.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  return `aide-decision-${type.replace(/[^a-z0-9_-]/gi, "_")}-${t}.${format}`;
}

/**
 * CSV a point-virgule avec BOM UTF-8 (ouverture directe dans Excel francophone) : un bloc d'en-tete `# cle;valeur`, une
 * ligne vide, puis le tableau. Les nombres sont ecrits avec le point decimal (format machine, stable).
 */
export function rendreCsv(e: EnteteExport, jeu: JeuDonnees): string {
  const meta: [string, Cellule][] = [
    ["# titre", e.titre],
    ["# type", e.type],
    ["# export_id", e.exportId],
    ["# genere_le", e.genereLe],
    ["# auteur", `${e.auteur.email} (${e.auteur.role})`],
    ["# perimetre", e.perimetre.libelle],
    ["# filtres_appliques", resumeFiltres(e.filtresAppliques)],
    ...e.filtresNonAppliques.map((f): [string, Cellule] => ["# filtre_non_applique", `${f.filtre} : ${f.raison}`]),
    ["# unites", Object.entries(e.unites).map(([k, u]) => `${k}=${u}`).join("; ") || "sans objet"],
    ...e.sources.map((s): [string, Cellule] => ["# source", `${s.libelle} [${s.code}] reference : ${s.dateReference ?? "date non connue"}`]),
    ...e.definitions.map((d): [string, Cellule] => [`# definition ${d.code}`, `${d.libelle} : ${d.definition} Formule : ${d.formule} Unite : ${d.unite}. Definition ${d.statutDefinition} (${d.origine})`]),
    ...e.avertissements.map((a): [string, Cellule] => ["# avertissement", a]),
    ["# colonnes_financieres_retirees", e.colonnesFinancieresRetirees.length > 0 ? e.colonnesFinancieresRetirees.join(", ") : "aucune"],
    ["# nb_lignes", e.nbLignes],
    ["# mention", e.mention],
  ];
  const corps = jeu.lignes.map((l) => ligneCsv(jeu.colonnes.map((c) => l[c.cle])));
  return `﻿${meta.map(([k, v]) => ligneCsv([k, v])).join("\n")}\n\n${ligneCsv(jeu.colonnes.map((c) => c.cle))}\n${corps.join("\n")}${corps.length > 0 ? "\n" : ""}`;
}

export function rendreJson(e: EnteteExport, jeu: JeuDonnees): string {
  return JSON.stringify({
    metadonnees: e,
    colonnes: jeu.colonnes.map((c) => ({ cle: c.cle, libelle: c.libelle, unite: c.unite })),
    lignes: jeu.lignes,
  }, null, 2);
}

export function rendre(format: FormatExport, e: EnteteExport, jeu: JeuDonnees): string {
  return format === "csv" ? rendreCsv(e, jeu) : rendreJson(e, jeu);
}

export function unitesDe(jeu: JeuDonnees): Record<string, string> {
  return Object.fromEntries(jeu.colonnes.filter((c) => c.unite).map((c) => [c.cle, c.unite as string]));
}

// ------------------------------------------------------------------------------------------------------ perimetre

/** Libelle de perimetre lisible : « National » ou la liste des regions que le compte peut voir. */
export function libellePerimetre(national: boolean, regionNoms: readonly string[], regionDemandee: string | null): string {
  if (regionDemandee) return `Region ${regionDemandee}`;
  if (national) return "National (toutes les regions)";
  return regionNoms.length > 0 ? `Regions du compte : ${regionNoms.join(", ")}` : "Regions du compte";
}
