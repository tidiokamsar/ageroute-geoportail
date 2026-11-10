/**
 * Module « Projets de voirie et reseaux » : constantes d'affichage et fonctions pures.
 * Contrat : docs/projets-voirie/CONTRAT.md (version 2 : statuts, confidentialite, qualite, nature des objets, CRS, delta).
 *
 * Rien ici ne touche le reseau, le DOM ni un stockage local. Les donnees de concessionnaires sont sensibles
 * (trace d'infrastructure critique) : ce module ne les conserve nulle part.
 */

export type TypeReseau = "TELECOM" | "EAU_POTABLE" | "ELECTRICITE" | "ASSAINISSEMENT" | "GAZ_HYDROCARBURES" | "AUTRE";
export type RoleJeu = "AXES_TRAVAUX" | "RESEAU_TIERS" | "LIMITES_ROUTE" | "AUTRE";
export type FormatJeu = "KML" | "KMZ" | "GEOJSON" | "GPX" | "CSV";
/** Contrat v2 : cinq niveaux. */
export type Confidentialite = "PUBLIC" | "INTERNE" | "RESTREINT_PROJET" | "CONFIDENTIEL_CONCESSIONNAIRE" | "INFRASTRUCTURE_SENSIBLE";
/** Contrat v2 : un depot reel cree un jeu CONTROLE (quarantaine) ; seul AUTORISE alimente la carte et l'analyse. */
export type StatutJeu = "RECU" | "CONTROLE" | "AUTORISE" | "REJETE" | "REMPLACE" | "RETIRE";
export type ClassePrecision = "A" | "B" | "C" | "D" | "E" | "INCONNUE";
export type NatureObjet = "ACTIF_PHYSIQUE" | "CIRCUIT_LOGIQUE" | "EQUIPEMENT" | "AXE" | "EMPRISE" | "INCONNUE";
export type StatutParametres = "THEORIQUE" | "VALIDE";
export type TypeGeom = "LIGNE" | "POINT" | "POLYGONE";
/** Emprise WGS84 dans l'ordre du contrat : ouest, sud, est, nord. */
export type Bbox = [number, number, number, number];

export const TYPES_RESEAU: readonly TypeReseau[] = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"];
export const ROLES_JEU: readonly RoleJeu[] = ["AXES_TRAVAUX", "RESEAU_TIERS", "LIMITES_ROUTE", "AUTRE"];

export interface StyleReseau {
  libelle: string;
  /** Couleur du contrat (section 6). */
  couleur: string;
  /** Motif de trait (SVG/Leaflet `dashArray`), vide pour un trait plein : la couleur ne porte jamais seule l'information. */
  motif: string;
  /** Nom du motif, dit en toutes lettres dans la legende. */
  nomMotif: string;
  /** Lettre/forme courte repetee dans les tableaux. */
  court: string;
}

export const STYLE_RESEAU: Record<TypeReseau, StyleReseau> = {
  TELECOM: { libelle: "Télécom", couleur: "#ff7900", motif: "", nomMotif: "trait plein", court: "T" },
  EAU_POTABLE: { libelle: "Eau potable", couleur: "#1e66f5", motif: "10 5", nomMotif: "tirets longs", court: "E" },
  ELECTRICITE: { libelle: "Électricité", couleur: "#d32f2f", motif: "2 5", nomMotif: "pointillé", court: "É" },
  ASSAINISSEMENT: { libelle: "Assainissement", couleur: "#2e7d32", motif: "12 4 2 4", nomMotif: "tiret-point", court: "A" },
  GAZ_HYDROCARBURES: { libelle: "Gaz et hydrocarbures", couleur: "#f9a825", motif: "5 5", nomMotif: "tirets courts", court: "G" },
  AUTRE: { libelle: "Autre réseau", couleur: "#6b7f99", motif: "1 7", nomMotif: "points espacés", court: "?" },
};

export const COULEUR_AXES = "#0b2545";

export const LIBELLE_ROLE: Record<RoleJeu, string> = {
  AXES_TRAVAUX: "Axes de travaux",
  RESEAU_TIERS: "Réseau de concessionnaire",
  LIMITES_ROUTE: "Limites de route",
  AUTRE: "Autre donnée",
};

export const NIVEAUX_CONFIDENTIALITE: readonly Confidentialite[] = ["PUBLIC", "INTERNE", "RESTREINT_PROJET", "CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"];

export const LIBELLE_CONFIDENTIALITE: Record<Confidentialite, string> = {
  PUBLIC: "Public",
  INTERNE: "Interne (usage AGEROUTE)",
  RESTREINT_PROJET: "Restreint au projet",
  CONFIDENTIEL_CONCESSIONNAIRE: "Confidentiel concessionnaire",
  INFRASTRUCTURE_SENSIBLE: "Infrastructure sensible",
};

/** Niveau propose selon le role (contrat v2) : reseau tiers => confidentiel concessionnaire ; autres roles => restreint au projet. */
export function confidentialiteParDefaut(role: RoleJeu): Confidentialite {
  return role === "RESEAU_TIERS" ? "CONFIDENTIEL_CONCESSIONNAIRE" : "RESTREINT_PROJET";
}

export const CLASSES_PRECISION: readonly ClassePrecision[] = ["INCONNUE", "A", "B", "C", "D", "E"];
export const AIDE_CLASSE: Record<ClassePrecision, string> = {
  A: "A : levé contrôlé",
  B: "B : plan validé",
  C: "C : plan de conception",
  D: "D : approximation",
  E: "E : sans géométrie exploitable",
  INCONNUE: "Inconnue (par défaut)",
};
/** Pour D, E ou inconnue, l'analyse parle de « proximite a verifier » et non de conflit. */
export const classeIncertaine = (c: ClassePrecision | null | undefined) => !c || c === "D" || c === "E" || c === "INCONNUE";

export const NATURES_OBJET: readonly NatureObjet[] = ["INCONNUE", "ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT", "AXE", "EMPRISE"];
export const LIBELLE_NATURE: Record<NatureObjet, string> = {
  ACTIF_PHYSIQUE: "Actif physique (câble, conduite posés)",
  CIRCUIT_LOGIQUE: "Circuit logique (parcours, pas un tracé physique)",
  EQUIPEMENT: "Équipement (chambre, regard, poteau)",
  AXE: "Axe de travaux",
  EMPRISE: "Emprise ou limite",
  INCONNUE: "Inconnue (par défaut pour un réseau tiers)",
};
/** Natures proposees : les axes et les limites sont imposes par le contrat (AXE, EMPRISE) ; un reseau tiers ou « autre » choisit. */
export function natureParDefaut(role: RoleJeu): NatureObjet {
  return role === "AXES_TRAVAUX" ? "AXE" : role === "LIMITES_ROUTE" ? "EMPRISE" : "INCONNUE";
}
export function naturesProposees(role: RoleJeu): readonly NatureObjet[] {
  return role === "AXES_TRAVAUX" ? ["AXE"] : role === "LIMITES_ROUTE" ? ["EMPRISE"] : ["INCONNUE", "ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT"];
}

export const LIBELLE_STATUT_JEU: Record<StatutJeu, string> = {
  RECU: "Reçu",
  CONTROLE: "À autoriser",
  AUTORISE: "Autorisé",
  REJETE: "Rejeté",
  REMPLACE: "Remplacé",
  RETIRE: "Retiré",
};

export const MESSAGE_QUARANTAINE = "Un fichier reçu n'est pas un fichier importé : il n'alimente le projet qu'après autorisation.";
/** Libelles imposes par le contrat v2 (jamais « N cables » pour N lignes). */
export const LIBELLE_TRACE_FUSIONNE = "Longueur du tracé fusionné (circuits superposés comptés une fois)";
export const LIBELLE_NB_OBJETS = "Circuits ou objets du fichier";
export const JUSTIFICATION_MIN = 10;

export type CleConflit = "chaussee" | "emprise" | "hors" | "croisements";

export interface StyleConflit {
  libelle: string;
  couleur: string;
  motif: string;
  nomMotif: string;
  epaisseur: number;
  explication: string;
}

export const STYLE_CONFLIT: Record<CleConflit, StyleConflit> = {
  chaussee: { libelle: "Dans la chaussée", couleur: "#d32f2f", motif: "", nomMotif: "trait plein épais", epaisseur: 7, explication: "Réseau dans la bande axe ± demi-largeur de chaussée." },
  emprise: { libelle: "Dans l'emprise, hors chaussée", couleur: "#c2410c", motif: "9 6", nomMotif: "tirets", epaisseur: 6, explication: "Réseau dans la bande axe ± demi-largeur d'emprise, hors chaussée." },
  hors: { libelle: "Hors emprise", couleur: "#7b1fa2", motif: "2 6", nomMotif: "pointillé", epaisseur: 5, explication: "Réseau au-delà de l'emprise des travaux." },
  croisements: { libelle: "Croisements avec un axe", couleur: "#000000", motif: "", nomMotif: "disque noir cerclé de blanc", epaisseur: 2, explication: "Points où un réseau coupe un axe de travaux." },
};

export const CLES_CONFLIT: readonly CleConflit[] = ["chaussee", "emprise", "hors", "croisements"];

// ---------------------------------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------------------------------

const ESPACES_FINES = new RegExp("[" + String.fromCharCode(0x202f, 0xa0) + "]", "g");

/** Nombre a la francaise, avec des espaces ordinaires (les espaces fines insecables de `Intl` se cassent mal dans les tests et les copies). */
export function formaterNombre(n: number, decimales = 1): string {
  if (!Number.isFinite(n)) return "n/d";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: decimales, minimumFractionDigits: 0 }).format(n).replace(ESPACES_FINES, " ");
}

export function formaterMetres(m: number | null | undefined): string {
  return typeof m === "number" && Number.isFinite(m) ? `${formaterNombre(m, 1)} m` : "n/d";
}

/** Longueur lisible : en metres sous 1 km, en kilometres (deux decimales) au-dela. */
export function formaterLongueur(m: number | null | undefined): string {
  if (typeof m !== "number" || !Number.isFinite(m)) return "n/d";
  return Math.abs(m) >= 1000 ? `${formaterNombre(m / 1000, 2)} km` : `${formaterNombre(m, 1)} m`;
}

export function formaterPourcent(part: number): string {
  return `${formaterNombre(part * 100, 1)} %`;
}

export function formaterDate(iso: string | null | undefined): string {
  if (!iso) return "Non renseignée";
  const d = /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return "Non renseignée";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(d);
}

export function formaterTaille(octets: number): string {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${formaterNombre(octets / 1024, 1)} Ko`;
  return `${formaterNombre(octets / (1024 * 1024), 1)} Mo`;
}

/** Nombre venu du serveur : un `Decimal` Prisma arrive en chaine (« 15.00 »). `null` si ce n'est pas un nombre fini. */
export function versNombre(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Emprises
// ---------------------------------------------------------------------------------------------------

/** Lit une emprise `[ouest, sud, est, nord]` ou `{ ouest, sud, est, nord }` (ou `west/south/east/north`). `null` si illisible ou vide. */
export function lireBbox(v: unknown): Bbox | null {
  let t: unknown[] | null = null;
  if (Array.isArray(v) && v.length === 4) t = v;
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("ouest" in o) t = [o.ouest, o.sud, o.est, o.nord];
    else if ("west" in o) t = [o.west, o.south, o.east, o.north];
    else if ("minLon" in o) t = [o.minLon, o.minLat, o.maxLon, o.maxLat];
  }
  if (!t) return null;
  const n = t.map(versNombre);
  if (n.some((x) => x === null)) return null;
  const [o, s, e, no] = n as number[];
  if (o < -180 || e > 180 || s < -90 || no > 90 || o > e || s > no) return null;
  return [o, s, e, no];
}

/** Emprise de requete : arrondie a 4 decimales (environ 10 m) pour que deux deplacements voisins partagent la meme cle de requete. */
export function arrondirBbox(b: Bbox): Bbox {
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return [r(b[0]), r(b[1]), r(b[2]), r(b[3])];
}

export function bboxVersChaine(b: Bbox): string {
  return b.join(",");
}

/** Elargit l'emprise de 10 % de chaque cote : un petit deplacement ne relance pas de requete et les bords ne sont pas nus. */
export function elargirBbox(b: Bbox, part = 0.1): Bbox {
  const dx = (b[2] - b[0]) * part;
  const dy = (b[3] - b[1]) * part;
  return [Math.max(-180, b[0] - dx), Math.max(-90, b[1] - dy), Math.min(180, b[2] + dx), Math.min(90, b[3] + dy)];
}

export function contientBbox(grande: Bbox, petite: Bbox): boolean {
  return grande[0] <= petite[0] && grande[1] <= petite[1] && grande[2] >= petite[2] && grande[3] >= petite[3];
}

// ---------------------------------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------------------------------

export type GenreErreur = "reseau" | "permission" | "droit" | "introuvable" | "conflit" | "validation" | "trop-gros" | "serveur" | "inattendue" | "annule";

export interface ErreurPv {
  genre: GenreErreur;
  status: number | null;
  /** `jeuId` d'un 409 JEU_DEJA_CHARGE ou DEPOT_EN_ATTENTE : le jeu existant. */
  jeuId?: string | null;
  /** Code applicatif du serveur (`{ error, code }`), en majuscules, ou null. */
  code: string | null;
  message: string;
  /** Erreurs par champ (`details.fieldErrors` d'un ZodError). */
  champs: Record<string, string[]>;
  /** Delai a attendre, en secondes, d'un 429 ou d'un 503 : `retryAfterS` du corps, sinon l'en-tete `Retry-After`. */
  retryAfterS?: number | null;
  /** Complements numeriques du corps : `nbElementsHorsZone` et `nbObjets` (409 CONFIRMATION_HORS_ZONE_REQUISE), `nb` (409 SUPPRESSIONS_A_REVOIR). */
  nb?: number | null;
  nbElementsHorsZone?: number | null;
  nbObjets?: number | null;
}

import { MESSAGE_CODE_IMPORT } from "./projetsVoirieMessages";

/** Messages en clair pour les codes du contrat v2 (section 4). Le texte du serveur ne sert que pour un code inconnu. */
export const MESSAGE_CODE: Record<string, string> = {
  JEU_DEJA_CHARGE: "Ce fichier est déjà chargé dans ce projet : un fichier de même empreinte (SHA-256) existe. Rien n'a été écrit.",
  DEPOT_EN_ATTENTE: "Un autre dépôt du même rôle et du même concessionnaire attend déjà son autorisation. Autorisez-le ou rejetez-le avant d'en déposer un nouveau. Rien n'a été écrit.",
  FORMAT_NON_SUPPORTE: "Format non pris en charge par cet import. Sont lus : KML, KMZ, GeoJSON, GPX et les tableaux CSV, TSV ou TXT. GeoPackage, Shapefile ZIP et DXF passent par une chaîne de conversion isolée, qui peut être désactivée sur ce serveur ; DWG n'est pas lu (exportez-le en DXF) ; PDF et HTML ne sont jamais importés comme données SIG. Exportez le fichier dans un format lu, puis réessayez.",
  CONTENU_NON_RECONNU: "Le contenu du fichier n'est pas reconnu comme un format lu (KML, KMZ, GeoJSON, GPX, tableau délimité), quelle que soit son extension. Le fichier n'a pas été exécuté ni interprété comme une page.",
  // Revue UI-C m7 : l'emprise nationale est configurable (lot T1) ; ses bornes viennent du serveur (options d'import), jamais du code.
  HORS_GUINEE: "Des coordonnées sont hors de l'emprise nationale de plausibilité configurée sur ce serveur. Vérifiez le système de coordonnées choisi et l'ordre des colonnes (longitude ou X avant latitude ou Y). Rien n'a été écrit.",
  CRS_NON_SUPPORTE: "Le système de coordonnées déclaré par le fichier est illisible ou n'est pas un code EPSG : il n'est pas pris en charge. Rien n'a été écrit.",
  GEOMETRIE_INVALIDE: "Une géométrie du fichier est invalide et n'a pu être réparée. Corrigez-la dans l'outil d'origine puis réessayez. Rien n'a été écrit.",
  FICHIER_VIDE: "Le fichier est vide ou ne contient aucun objet exploitable. Rien n'a été écrit.",
  TROP_D_OBJETS: "Le fichier contient plus de 50 000 objets. Découpez-le en plusieurs fichiers puis réessayez. Rien n'a été écrit.",
  FICHIER_TROP_GROS: "Le fichier dépasse la taille maximale de 25 Mo. Découpez-le ou simplifiez-le puis réessayez.",
  STATUT_INCOMPATIBLE: "Ce jeu n'est plus dans un état qui permet cette action (il a peut-être déjà été autorisé ou rejeté par quelqu'un d'autre). Rechargez la page.",
  SERVICE_OCCUPE: "Le serveur traite déjà d'autres demandes. Réessayez dans un instant.",
  PROJET_OCCUPE: "Ce projet est occupé : un autre dépôt, une autorisation ou un retrait est en cours. Réessayez dans quelques secondes.",
  IDENTIFIANT_INVALIDE: "L'identifiant demandé n'est pas valide (adresse modifiée ou lien tronqué). Revenez à la liste des projets et rouvrez le projet depuis celle-ci.",
  QUARANTAINE_RESERVEE: "L'affichage des données non autorisées est réservé aux administrateurs et aux gestionnaires.",
  ROLE_INSUFFISANT: "Votre rôle ne permet pas cette action (la validation des largeurs est réservée aux administrateurs).",
  TROP_DE_SOMMETS: "Le fichier contient trop de sommets (plus de 100 000 dans un objet, ou 2 000 000 dans le fichier). Simplifiez les tracés ou découpez le fichier, puis réessayez. Rien n'a été écrit.",
  XML_TROP_VOLUMINEUX: "Le document XML est trop volumineux pour être lu. Découpez le fichier puis réessayez. Rien n'a été écrit.",
  ANALYSE_TROP_VOLUMINEUSE: "L'analyse est trop volumineuse pour être calculée (trop de sommets d'axes ou de réseaux autorisés). Retirez ou simplifiez des jeux, puis réessayez.",
  ANALYSE_TROP_LONGUE: "Le calcul de l'analyse a dépassé le délai autorisé et a été interrompu. Réessayez, ou réduisez le volume de données (jeux retirés ou simplifiés).",
  CARTE_TROP_LONGUE: "L'affichage de la carte a dépassé le délai autorisé. Réessayez, ou zoomez pour réduire la zone affichée.",
  DEPOT_TROP_LONG: "Le traitement du dépôt a dépassé le délai autorisé et a été interrompu : rien n'a été enregistré. Réessayez, ou découpez le fichier.",
  COMPTE_REFERENT_RESTREINT: "Votre compte est rattaché à un concessionnaire pour des échanges de données : il n'ouvre que l'écran « Échanges avec les concessionnaires », pas le reste du module. Rien n'a été modifié.",
  ...MESSAGE_CODE_IMPORT,
};

/** Vrai pour l'annulation d'une requete par AbortController (axios : CanceledError, code ERR_CANCELED ; fetch : AbortError). */
export function estAnnulation(e: unknown): boolean {
  const o = enObjet(e);
  return !!o && (o.code === "ERR_CANCELED" || o.name === "CanceledError" || o.name === "AbortError");
}

function enObjet(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Classe une erreur axios (ou autre) pour l'affichage. JAMAIS d'exception : une erreur inclassable devient `serveur` ou `inattendue`.
 * Une absence de reponse HTTP est un probleme de reseau, pas un refus.
 */
export function classerErreur(e: unknown): ErreurPv {
  const r = enObjet(e)?.response;
  const reponse = enObjet(r);
  const status = typeof reponse?.status === "number" ? reponse.status : null;
  const corps = enObjet(reponse?.data);
  const code = typeof corps?.code === "string" ? corps.code.toUpperCase() : null;
  const texteServeur = typeof corps?.error === "string" && corps.error.trim() ? corps.error.trim() : null;
  const details = enObjet(corps?.details);
  const fe = enObjet(details?.fieldErrors);
  const champs: Record<string, string[]> = {};
  if (fe) for (const [k, v] of Object.entries(fe)) if (Array.isArray(v)) champs[k] = v.filter((x): x is string => typeof x === "string");

  if (!reponse) {
    if (estAnnulation(e)) return { genre: "annule", status: null, code: "ANNULE", message: "L'envoi a été annulé.", champs };
    if (enObjet(e)?.name === "ProjetVoirieReponseInattendue") return { genre: "inattendue", status: null, code: null, message: String((e as Error).message), champs };
    return { genre: "reseau", status: null, code: null, message: "Le serveur est injoignable. Ce module a besoin du réseau : vérifiez votre connexion puis réessayez.", champs };
  }
  const entete = enObjet(reponse.headers);
  const brutAttente = corps?.retryAfterS ?? entete?.["retry-after"] ?? entete?.["Retry-After"];
  const attente = versNombre(brutAttente);
  const nombre = (v: unknown) => versNombre(v);
  const base = {
    status, code, champs, jeuId: typeof corps?.jeuId === "string" ? corps.jeuId : null,
    retryAfterS: attente !== null && attente >= 0 ? Math.ceil(attente) : null,
    nb: nombre(corps?.nb), nbElementsHorsZone: nombre(corps?.nbElementsHorsZone), nbObjets: nombre(corps?.nbObjets),
  };
  if (code && MESSAGE_CODE[code]) {
    // 403 QUARANTAINE_RESERVEE et ROLE_INSUFFISANT : un refus de DROIT precis, pas l'absence de la cle de module.
    const genre: GenreErreur = status === 409 ? "conflit" : status === 413 ? "trop-gros" : status === 503 || status === 504 ? "serveur" : status === 403 ? "droit" : status === 404 ? "introuvable" : "validation";
    return { genre, ...base, message: MESSAGE_CODE[code] };
  }
  if (status === 401 || status === 403) {
    return { genre: "permission", ...base, message: "Votre compte n'a pas la clé de module « Projets de voirie », ou son rôle ne permet pas cette action." };
  }
  if (status === 404) return { genre: "introuvable", ...base, message: texteServeur ?? "Élément introuvable." };
  if (status === 409) return { genre: "conflit", ...base, message: texteServeur ?? "Cette opération entre en conflit avec l'état actuel des données." };
  if (status === 413) return { genre: "trop-gros", ...base, message: MESSAGE_CODE.FICHIER_TROP_GROS };
  if (status === 415) return { genre: "validation", ...base, message: MESSAGE_CODE.FORMAT_NON_SUPPORTE };
  if (status === 429) return { genre: "serveur", ...base, message: MESSAGE_CODE.TROP_DE_REQUETES };
  if (status === 400 || status === 422) return { genre: "validation", ...base, message: texteServeur ?? "Les données envoyées sont refusées par le serveur." };
  if (status !== null && status >= 500) return { genre: "serveur", ...base, message: texteServeur ?? "Le serveur a rencontré une erreur. Réessayez dans un instant." };
  return { genre: "serveur", ...base, message: texteServeur ?? "Une erreur est survenue." };
}

// ---------------------------------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------------------------------

export const TAILLE_MAX_FICHIER = 25 * 1024 * 1024;

/** Extensions de documents et d'executables : jamais des donnees SIG (le PDF est une piece jointe, le HTML n'est jamais importe). Refus local, sans envoi. */
const EXTENSIONS_NON_SIG = [".pdf", ".html", ".htm", ".xlsx", ".xls", ".doc", ".docx", ".exe", ".js", ".bat", ".cmd", ".msi", ".dll"];
/** Formats annonces par l'extension mais lus par une chaine a part (GDAL) : avertissement, pas de refus (le serveur decide par le contenu). */
const EXTENSIONS_HORS_LOT = [".gpkg", ".shp", ".shx", ".dbf", ".dxf", ".dwg", ".gdb", ".tab", ".mif", ".tif", ".tiff"];

export interface FormatLocal { format: string; extensions: readonly string[] }
/** Formats par defaut quand la liste de l'API n'est pas encore chargee : la meme que celle du contrat (CONTRAT-IMPORT.md, section 4). */
export const FORMATS_PAR_DEFAUT: readonly FormatLocal[] = [
  { format: "KML", extensions: [".kml"] }, { format: "KMZ", extensions: [".kmz"] }, { format: "GEOJSON", extensions: [".geojson", ".json"] },
  { format: "GPX", extensions: [".gpx"] }, { format: "CSV", extensions: [".csv", ".tsv", ".txt"] },
];

export interface VerdictFichier {
  ok: boolean;
  message: string | null;
  /** Format ANNONCE par l'extension (indice) : le format reel est detecte par le contenu, a l'etape suivante. */
  format: string | null;
  /** Mise en garde non bloquante (extension inconnue ou d'un format non lu : le serveur decidera par le contenu). */
  avertissement: string | null;
}

/**
 * Controle LOCAL, avant tout envoi : une economie de transfert, pas une validation. Le serveur lit les octets et decide PAR LE CONTENU. Seuls
 * sont refuses ici : un fichier vide, un fichier trop gros, un document ou un executable. Une extension inconnue ne bloque pas.
 */
export function controlerFichier(f: { name: string; size: number } | null, formats: readonly FormatLocal[] = FORMATS_PAR_DEFAUT, tailleMax = TAILLE_MAX_FICHIER): VerdictFichier {
  if (!f) return { ok: false, message: null, format: null, avertissement: null };
  const nom = f.name.toLowerCase();
  const refus = (message: string): VerdictFichier => ({ ok: false, message, format: null, avertissement: null });
  if (EXTENSIONS_NON_SIG.some((x) => nom.endsWith(x))) return refus("Ce type de fichier n'est pas une donnée SIG : un PDF reste une pièce jointe, une page HTML n'est jamais importée. Choisissez un fichier de la liste des formats acceptés.");
  if (f.size === 0) return refus("Le fichier est vide.");
  if (f.size > tailleMax) return refus(`Le fichier fait ${formaterTaille(f.size)} : le maximum est de ${formaterTaille(tailleMax)}.`);
  const connu = formats.find((x) => x.extensions.some((e) => nom.endsWith(e)));
  if (connu) return { ok: true, message: null, format: connu.format, avertissement: null };
  if (EXTENSIONS_HORS_LOT.some((x) => nom.endsWith(x))) {
    return { ok: true, message: null, format: null, avertissement: "Cette extension annonce un format que cet import ne lit pas (GeoPackage, Shapefile, DXF, DWG...). Le serveur vérifiera le contenu et refusera le fichier s'il n'est pas lisible." };
  }
  return { ok: true, message: null, format: null, avertissement: "Extension non reconnue : le serveur détectera le format par le contenu du fichier." };
}

// ---------------------------------------------------------------------------------------------------
// Largeurs et code de projet
// ---------------------------------------------------------------------------------------------------

export interface Largeurs { largeurEmpriseM: number; largeurChausseeM: number }

/** Message d'erreur d'une saisie de largeurs, ou null si elle est utilisable. Contrat v2 : 0 < chaussee <= emprise <= 200. */
export function erreurLargeurs(emprise: number | null, chaussee: number | null): string | null {
  if (emprise === null || chaussee === null) return "Saisissez les deux largeurs en mètres.";
  if (chaussee <= 0 || emprise <= 0) return "Les largeurs doivent être supérieures à zéro.";
  if (emprise > 200 || chaussee > 200) return "Une largeur de plus de 200 m n'est pas admise.";
  if (emprise < chaussee) return "L'emprise doit être au moins égale à la chaussée.";
  return null;
}

/** Code de projet (contrat v2) : majuscules, chiffres, tiret et souligne, 2 a 64 caracteres, commence par une lettre ou un chiffre. */
export const MOTIF_CODE_PROJET = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;

/** Lit une saisie decimale (virgule ou point). `null` si vide ou non numerique. */
export function lireSaisieNombre(s: string): number | null {
  if (s.trim() === "") return null;
  return versNombre(s);
}

// ---------------------------------------------------------------------------------------------------
// Style d'un jeu
// ---------------------------------------------------------------------------------------------------

export interface StyleJeu { libelle: string; couleur: string; motif: string; nomMotif: string; epaisseur: number }

/**
 * Style d'un jeu selon son role et son type de reseau. Couleurs du contrat pour les secteurs et les axes ; le contrat ne fixe pas celles des
 * limites de route et des jeux « autre » : choix d'interface (gris fonce tiret-point long, gris acier points espaces).
 */
export function styleJeu(role: RoleJeu | null, type: TypeReseau | null): StyleJeu {
  if (role === "AXES_TRAVAUX") return { libelle: "Axes de travaux", couleur: COULEUR_AXES, motif: "", nomMotif: "trait plein épais", epaisseur: 5 };
  if (role === "LIMITES_ROUTE") return { libelle: "Limites de route", couleur: "#374151", motif: "14 4 3 4", nomMotif: "tiret-point long", epaisseur: 3 };
  const t = role === "RESEAU_TIERS" ? (type ?? "AUTRE") : "AUTRE";
  const s = STYLE_RESEAU[t];
  return { libelle: s.libelle, couleur: s.couleur, motif: s.motif, nomMotif: s.nomMotif, epaisseur: 3 };
}

/** Libelle d'une ligne de resultat : chaque resultat est « A verifier » (contrat v2), avec la version de la regle quand elle est connue. */
export function libelleVerification(v: { statut: string; versionRegle: string | null }): string {
  const statut = v.statut === "A_VERIFIER" ? "À vérifier" : v.statut;
  return v.versionRegle ? `${statut} (règle v${v.versionRegle})` : statut;
}

/** Ecritures du module : ADMIN et GESTIONNAIRE (contrat, section 4). Le serveur fait autorite ; ceci ne fait que masquer des boutons inutiles. */
export function peutEcrireProjets(role: string | undefined): boolean {
  return role === "ADMIN" || role === "GESTIONNAIRE";
}
