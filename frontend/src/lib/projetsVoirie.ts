/**
 * Module « Projets de voirie et reseaux » : constantes d'affichage et fonctions pures.
 * Contrat : docs/projets-voirie/CONTRAT.md (version 2 : statuts, confidentialite, qualite, nature des objets, CRS, delta).
 *
 * Rien ici ne touche le reseau, le DOM ni un stockage local. Les donnees de concessionnaires sont sensibles
 * (trace d'infrastructure critique) : ce module ne les conserve nulle part.
 */

export type TypeReseau = "TELECOM" | "EAU_POTABLE" | "ELECTRICITE" | "ASSAINISSEMENT" | "GAZ_HYDROCARBURES" | "AUTRE";
export type RoleJeu = "AXES_TRAVAUX" | "RESEAU_TIERS" | "LIMITES_ROUTE" | "AUTRE";
export type FormatJeu = "KML" | "GEOJSON";
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

export type GenreErreur = "reseau" | "permission" | "introuvable" | "conflit" | "validation" | "trop-gros" | "serveur" | "inattendue";

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
}

/** Messages en clair pour les codes du contrat v2 (section 4). Le texte du serveur ne sert que pour un code inconnu. */
export const MESSAGE_CODE: Record<string, string> = {
  JEU_DEJA_CHARGE: "Ce fichier est déjà chargé dans ce projet : un fichier de même empreinte (SHA-256) existe. Rien n'a été écrit.",
  DEPOT_EN_ATTENTE: "Un autre dépôt du même rôle et du même concessionnaire attend déjà son autorisation. Autorisez-le ou rejetez-le avant d'en déposer un nouveau. Rien n'a été écrit.",
  FORMAT_NON_SUPPORTE: "Format prévu au lot suivant. Ce lot ne lit que les fichiers KML et GeoJSON ; KMZ, ZIP, Shapefile, DXF, PDF et HTML ne sont pas pris en charge. Exportez le fichier en KML ou en GeoJSON puis réessayez.",
  CONTENU_NON_RECONNU: "Le contenu du fichier n'est pas reconnu comme un KML ou un GeoJSON, quelle que soit son extension. Le fichier n'a pas été ouvert ni exécuté. Format prévu au lot suivant, s'il s'agit d'un autre format.",
  HORS_GUINEE: "Des coordonnées sont en dehors de la Guinée (longitude de -15,2 à -7,5 ; latitude de 7,1 à 12,8). Vérifiez que le fichier est en WGS 84, avec la longitude avant la latitude. Rien n'a été écrit.",
  CRS_NON_SUPPORTE: "Le système de coordonnées déclaré par le fichier n'est pas pris en charge : ce lot n'accepte que le WGS 84 (norme KML et GeoJSON), sans transformation. Les systèmes projetés viendront au lot suivant. Rien n'a été écrit.",
  GEOMETRIE_INVALIDE: "Une géométrie du fichier est invalide et n'a pu être réparée. Corrigez-la dans l'outil d'origine puis réessayez. Rien n'a été écrit.",
  FICHIER_VIDE: "Le fichier est vide ou ne contient aucun objet exploitable. Rien n'a été écrit.",
  TROP_D_OBJETS: "Le fichier contient plus de 50 000 objets. Découpez-le en plusieurs fichiers puis réessayez. Rien n'a été écrit.",
  FICHIER_TROP_GROS: "Le fichier dépasse la taille maximale de 25 Mo. Découpez-le ou simplifiez-le puis réessayez.",
  STATUT_INCOMPATIBLE: "Ce jeu n'est plus dans un état qui permet cette action (il a peut-être déjà été autorisé ou rejeté par quelqu'un d'autre). Rechargez la page.",
  SERVICE_OCCUPE: "Le serveur traite déjà d'autres fichiers. Réessayez dans un instant.",
};

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
    if (enObjet(e)?.name === "ProjetVoirieReponseInattendue") return { genre: "inattendue", status: null, code: null, message: String((e as Error).message), champs };
    return { genre: "reseau", status: null, code: null, message: "Le serveur est injoignable. Ce module a besoin du réseau : vérifiez votre connexion puis réessayez.", champs };
  }
  const base = { status, code, champs, jeuId: typeof corps?.jeuId === "string" ? corps.jeuId : null };
  if (code && MESSAGE_CODE[code]) {
    const genre: GenreErreur = status === 409 ? "conflit" : status === 413 ? "trop-gros" : status === 503 ? "serveur" : "validation";
    return { genre, ...base, message: MESSAGE_CODE[code] };
  }
  if (status === 401 || status === 403) {
    return { genre: "permission", ...base, message: "Votre compte n'a pas la clé de module « Projets de voirie », ou son rôle ne permet pas cette action." };
  }
  if (status === 404) return { genre: "introuvable", ...base, message: texteServeur ?? "Élément introuvable." };
  if (status === 409) return { genre: "conflit", ...base, message: texteServeur ?? "Cette opération entre en conflit avec l'état actuel des données." };
  if (status === 413) return { genre: "trop-gros", ...base, message: MESSAGE_CODE.FICHIER_TROP_GROS };
  if (status === 415) return { genre: "validation", ...base, message: MESSAGE_CODE.FORMAT_NON_SUPPORTE };
  if (status === 400 || status === 422) return { genre: "validation", ...base, message: texteServeur ?? "Les données envoyées sont refusées par le serveur." };
  if (status !== null && status >= 500) return { genre: "serveur", ...base, message: texteServeur ?? "Le serveur a rencontré une erreur. Réessayez dans un instant." };
  return { genre: "serveur", ...base, message: texteServeur ?? "Une erreur est survenue." };
}

// ---------------------------------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------------------------------

export const TAILLE_MAX_FICHIER = 25 * 1024 * 1024;
export const EXTENSIONS_ADMISES = [".kml", ".geojson", ".json"] as const;
const EXTENSIONS_REFUSEES = [".kmz", ".zip", ".shp", ".shx", ".dbf", ".dxf", ".dwg", ".pdf", ".html", ".htm", ".gpx", ".csv", ".xlsx", ".exe"];

export interface VerdictFichier { ok: boolean; message: string | null; format: "KML" | "GEOJSON" | null }

/**
 * Controle LOCAL, avant tout envoi : une economie de transfert, pas une validation. Le serveur lit les octets et decide. L'extension n'est
 * qu'un indice ; le contenu du fichier n'est jamais lu par le navigateur (ni apercu, ni execution).
 */
export function controlerFichier(f: { name: string; size: number } | null): VerdictFichier {
  if (!f) return { ok: false, message: null, format: null };
  const nom = f.name.toLowerCase();
  if (EXTENSIONS_REFUSEES.some((x) => nom.endsWith(x))) return { ok: false, message: MESSAGE_CODE.FORMAT_NON_SUPPORTE, format: null };
  if (f.size === 0) return { ok: false, message: "Le fichier est vide.", format: null };
  if (f.size > TAILLE_MAX_FICHIER) return { ok: false, message: `Le fichier fait ${formaterTaille(f.size)} : le maximum est de 25 Mo.`, format: null };
  if (nom.endsWith(".kml")) return { ok: true, message: null, format: "KML" };
  if (nom.endsWith(".geojson") || nom.endsWith(".json")) return { ok: true, message: null, format: "GEOJSON" };
  return { ok: false, message: "Extension non reconnue : choisissez un fichier .kml ou .geojson.", format: null };
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
