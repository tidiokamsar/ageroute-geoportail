import type { FormatPropose, MetaImport, ReceptionReponse, StatutLot } from "./types";

/**
 * Noyau PUR du formulaire de réception d'un lot (aucun DOM, aucune horloge, aucun `File`) :
 * validation par champ, diagnostic du bouton principal, lecture des refus du serveur.
 *
 * CE QUE CE NOYAU DÉCIDE, ET CE QU'IL NE DÉCIDE PAS
 *
 * Il aide la personne à ne pas perdre un envoi pour une faute évidente (champ vide, fichier vide ou
 * au-dessus du plafond annoncé par /meta). Il ne VALIDE JAMAIS un fichier : l'extension est un
 * indice, jamais une preuve, et c'est le serveur qui lit les octets, calcule l'empreinte, vérifie le
 * format réel et décide du statut. Les plafonds viennent de `meta` (route /meta), jamais d'une
 * constante du client ; les seules valeurs écrites ici sont les longueurs maximales des champs
 * texte, qui reflètent le contrôle zod de `backend/src/api-v2/imports.routes.ts` (le serveur reste
 * juge : un décalage ne ferait que laisser passer un envoi que le serveur refuserait).
 */

export type ChampReception = "systemeSource" | "format" | "methodeSource" | "versionMapping" | "autorisationRef" | "fichier";

/** Ordre de lecture du formulaire : celui du résumé d'erreurs et du « premier champ en erreur ». */
export const ORDRE_CHAMPS: readonly ChampReception[] = [
  "systemeSource", "format", "methodeSource", "versionMapping", "autorisationRef", "fichier",
];

export interface ValeursReception {
  systemeSource: string;
  /** Code du format (`csv`, `geojson`) ; vide tant que rien n'est choisi. */
  format: string;
  methodeSource: string;
  versionMapping: string;
  autorisationRef: string;
}

/** Ce que le formulaire remet à `onSoumettre` : textes nettoyés (trim), format présent dans /meta. */
export interface DonneesReception {
  systemeSource: string;
  format: FormatPropose["code"];
  methodeSource: string;
  versionMapping: string;
  autorisationRef: string;
}

/** Ce que le noyau sait d'un fichier : un nom et une taille. Jamais le contenu. */
export interface InfoFichier { nom: string; taille: number }

/**
 * Valeurs de départ, identiques à celles de l'ancienne page (ImportsPage : « ONR_BDR », « csv »,
 * « v0 ») : on conserve le comportement existant plutôt que d'en inventer un autre.
 */
export const VALEURS_PAR_DEFAUT: ValeursReception = {
  systemeSource: "ONR_BDR", format: "csv", methodeSource: "", versionMapping: "v0", autorisationRef: "",
};

/**
 * Longueur minimale de la référence d'autorisation, APRÈS suppression des espaces de début et de fin
 * (exigence de l'audit de sécurité du 25/10/2026, appliquée aussi par le serveur) : une référence de
 * 1 ou 2 caractères ne désigne aucun document.
 */
export const LONGUEUR_MIN_AUTORISATION = 5;

/** Longueurs maximales des champs texte (miroir du contrôle serveur, voir l'en-tête). */
export const LONGUEUR_MAX: Readonly<Record<Exclude<ChampReception, "format" | "fichier">, number>> = {
  systemeSource: 64, methodeSource: 120, versionMapping: 64, autorisationRef: 120,
};

export const LIBELLE_CHAMP: Readonly<Record<ChampReception, string>> = {
  systemeSource: "Système source",
  format: "Format",
  methodeSource: "Méthode de la source",
  versionMapping: "Version du mapping",
  autorisationRef: "Référence de l'autorisation écrite",
  fichier: "Fichier à recevoir",
};

/** Forme utilisée dans la phrase « il manque : … » (article inclus). */
const MANQUE_PHRASE: Readonly<Record<ChampReception, string>> = {
  systemeSource: "le système source",
  format: "le format",
  methodeSource: "la méthode de la source",
  versionMapping: "la version du mapping",
  autorisationRef: "la référence de l'autorisation écrite",
  fichier: "un fichier",
};

/** Forme utilisée dans la phrase « à corriger : … ». */
const PROBLEME_PHRASE: Readonly<Record<ChampReception, string>> = {
  systemeSource: "le système source (valeur non acceptée)",
  format: "le format (non pris en charge)",
  methodeSource: "la méthode de la source (valeur non acceptée)",
  versionMapping: "la version du mapping (valeur non acceptée)",
  autorisationRef: "la référence de l'autorisation écrite (au moins 5 caractères, sur une seule ligne)",
  fichier: "le fichier choisi (voir le message sous la zone de dépôt)",
};

export const LIBELLE_STATUT_RECEPTION: Readonly<Record<StatutLot, string>> = {
  RECU: "Reçu",
  VALIDE_SCHEMA: "Schéma validé, non appliqué",
  IMPORTE_TEST: "Importé en test",
  IMPORTE: "Importé",
  REJETE: "Rejeté",
};

// ---------------------------------------------------------------------------------------------
// Mise en forme
// ---------------------------------------------------------------------------------------------

/** « a », « a et b », « a, b et c ». */
export function joindreFr(elements: readonly string[]): string {
  if (elements.length <= 1) return elements[0] ?? "";
  return `${elements.slice(0, -1).join(", ")} et ${elements[elements.length - 1]}`;
}

/** 12345 -> « 12 345 » (espace simple : le séparateur fin de `Intl` complique les comparaisons). */
export function formaterNombre(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Taille lisible en unités binaires (1 Ko = 1024 o), seules cohérentes avec un plafond de
 * 50 * 1024 * 1024 octets : il s'affiche « 50 Mo ». Virgule décimale française, « ,0 » omis.
 */
export function formaterTaille(octets: number): string {
  if (!Number.isFinite(octets) || octets < 0) return "taille inconnue";
  if (octets < 1024) return `${Math.trunc(octets)} o`;
  const unites = ["o", "Ko", "Mo", "Go", "To"];
  let valeur = octets;
  let i = 0;
  while (valeur >= 1024 && i < unites.length - 1) { valeur /= 1024; i++; }
  let arrondi = Math.round(valeur * 10) / 10;
  // 1023,97 Ko s'arrondit à 1024 : on passe à l'unité du dessus au lieu d'écrire « 1024 Ko ».
  if (arrondi >= 1024 && i < unites.length - 1) { arrondi = Math.round((arrondi / 1024) * 10) / 10; i++; }
  return `${String(arrondi).replace(".", ",")} ${unites[i]}`;
}

/**
 * Tronque un nom de fichier au milieu en gardant son extension (elle dit le format) :
 * `export_releves_RN1_2026_octobre_v2.csv` -> `export_releves_RN1_2026_oct….csv`.
 * Compte en points de code pour ne jamais couper un caractère composé en deux.
 */
export function tronquerNom(nom: string, max = 36): string {
  const signes = Array.from(nom);
  if (signes.length <= max) return nom;
  const point = signes.lastIndexOf(".");
  const longueurExt = point > 0 ? signes.length - point : 0;
  const ext = longueurExt > 0 && longueurExt <= 12 ? signes.slice(point).join("") : "";
  const debut = Math.max(1, max - Array.from(ext).length - 1);
  return `${signes.slice(0, debut).join("")}…${ext}`;
}

// ---------------------------------------------------------------------------------------------
// Formats et extensions (indicatif)
// ---------------------------------------------------------------------------------------------

/**
 * Extensions usuelles par code de format. /meta ne donne que le code : cette table sert UNIQUEMENT
 * à orienter (attribut `accept`, avertissement de cohérence). Un code inconnu n'a pas d'extension
 * connue, donc aucun avertissement et aucune restriction.
 */
const EXTENSIONS_PAR_FORMAT: Readonly<Record<string, readonly string[]>> = {
  csv: [".csv"],
  geojson: [".geojson", ".json"],
};

export function extensionsDuFormat(code: string): readonly string[] {
  return EXTENSIONS_PAR_FORMAT[code] ?? [];
}

/** Extension en minuscules avec son point (« .csv »), ou chaîne vide. */
export function extensionDe(nom: string): string {
  const point = nom.lastIndexOf(".");
  if (point < 0 || point === nom.length - 1) return "";
  return nom.slice(point).toLowerCase();
}

/** Valeur de l'attribut `accept` : union des extensions des formats ANNONCÉS par /meta. */
export function accepterDepuisMeta(meta: MetaImport): string | undefined {
  const uniques: string[] = [];
  for (const f of meta.formats) for (const e of extensionsDuFormat(f.code)) if (!uniques.includes(e)) uniques.push(e);
  return uniques.length > 0 ? uniques.join(",") : undefined;
}

function libelleFormat(meta: MetaImport, code: string): string {
  return meta.formats.find((f) => f.code === code)?.libelle ?? code;
}

/** Phrase d'aide : formats et plafonds lus dans /meta, avec la mention « seuls ces formats ». */
export function texteAideFormats(meta: MetaImport): string {
  if (meta.formats.length === 0) return "Le serveur n'annonce aucun format pris en charge : la réception est indisponible pour le moment.";
  const formats = joindreFr(meta.formats.map((f) => f.libelle));
  const limites = [`Taille maximale : ${formaterTaille(meta.tailleMaxOctets)}`];
  if (meta.limiteLignes > 0) limites.push(`${formaterNombre(meta.limiteLignes)} lignes au plus`);
  return `Formats pris en charge : ${formats}. Seuls ces formats sont pris en charge. ${limites.join(", ")}.`;
}

// ---------------------------------------------------------------------------------------------
// Validation par champ
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CARACTERES_NON_IMPRIMABLES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const MESSAGE_VIDE: Readonly<Record<ChampReception, string>> = {
  systemeSource: "Indiquez le système source (par exemple ONR_BDR).",
  format: "Choisissez le format du fichier.",
  methodeSource: "Indiquez la méthode de la source (export d'un logiciel, relevé tablette, etc.).",
  versionMapping: "Indiquez la version du mapping (par exemple v0).",
  autorisationRef: "Indiquez la référence de l'autorisation écrite : sans elle, le lot ne peut pas être reçu.",
  fichier: "Choisissez le fichier à recevoir.",
};

/** `null` si le champ est acceptable ; sinon le message en français clair. Le fichier a sa propre fonction. */
export function validerChamp(
  champ: Exclude<ChampReception, "fichier">, valeur: string, meta: MetaImport,
): string | null {
  const v = valeur.trim();
  if (v === "") return MESSAGE_VIDE[champ];
  if (champ === "format") {
    if (meta.formats.some((f) => f.code === v)) return null;
    const admis = meta.formats.length > 0 ? ` Formats pris en charge : ${joindreFr(meta.formats.map((f) => f.libelle))}.` : "";
    return `Ce format n'est pas pris en charge.${admis}`;
  }
  const max = LONGUEUR_MAX[champ];
  const longueur = Array.from(v).length;
  if (longueur > max) return `${LIBELLE_CHAMP[champ]} : ${max} caractères au maximum (vous en avez saisi ${longueur}).`;
  if (champ === "autorisationRef") {
    // Caractères de contrôle et séparateurs de ligne : un retour à la ligne collé dans cette référence
    // fausserait le journal et les exports. Les espaces ordinaires sont permis à l'intérieur.
    if (CARACTERES_NON_IMPRIMABLES.test(v)) return "La référence doit tenir sur une seule ligne, sans retour à la ligne ni caractère de contrôle.";
    if (longueur < LONGUEUR_MIN_AUTORISATION) {
      return `La référence doit comporter au moins ${LONGUEUR_MIN_AUTORISATION} caractères (contrat, courrier, numéro de référence...).`;
    }
  }
  return null;
}

export interface ControleFichier {
  /** Bloquant : le fichier ne partira pas. */
  erreur: string | null;
  /** Non bloquant : indice de cohérence, jamais une preuve. */
  avertissement: string | null;
}

export function controlerFichier(fichier: InfoFichier | null, formatDeclare: string, meta: MetaImport): ControleFichier {
  if (!fichier) return { erreur: MESSAGE_VIDE.fichier, avertissement: null };
  if (fichier.taille <= 0) {
    return { erreur: "Ce fichier est vide (0 octet) : choisissez un fichier qui contient des données.", avertissement: null };
  }
  if (fichier.taille > meta.tailleMaxOctets) {
    return {
      erreur: `Ce fichier fait ${formaterTaille(fichier.taille)} : le maximum accepté est ${formaterTaille(meta.tailleMaxOctets)}. Il ne sera pas envoyé. Réduisez-le ou découpez-le en plusieurs lots.`,
      avertissement: null,
    };
  }
  return { erreur: null, avertissement: avertissementExtension(fichier.nom, formatDeclare, meta) };
}

const PRECISION_INDICATIVE = "Cette vérification est indicative : le serveur contrôle le contenu réel du fichier et décide.";

/** Avertissement si le nom du fichier ne va pas avec le format déclaré ; `null` si cohérent ou indéterminable. */
export function avertissementExtension(nom: string, formatDeclare: string, meta: MetaImport): string | null {
  const attendues = extensionsDuFormat(formatDeclare);
  if (attendues.length === 0) return null;
  const ext = extensionDe(nom);
  if (attendues.includes(ext)) return null;
  const declare = libelleFormat(meta, formatDeclare);
  const evoque = meta.formats.find((f) => f.code !== formatDeclare && extensionsDuFormat(f.code).includes(ext));
  if (evoque) {
    return `Le nom du fichier évoque le format ${evoque.libelle}, alors que vous avez déclaré ${declare}. Vérifiez le format choisi. ${PRECISION_INDICATIVE}`;
  }
  const trouvee = ext === "" ? "Ce nom de fichier n'a pas d'extension" : `L'extension « ${ext} » n'est pas une de celles attendues`;
  return `${trouvee} pour le format ${declare} (attendu : ${attendues.join(", ")}). ${PRECISION_INDICATIVE}`;
}

// ---------------------------------------------------------------------------------------------
// Validation d'ensemble et diagnostic du bouton
// ---------------------------------------------------------------------------------------------

export interface EntreeValidation { valeurs: ValeursReception; fichier: InfoFichier | null; meta: MetaImport }

export interface ResultatValidation {
  /** Un message par champ en erreur (champ vide compris). */
  erreurs: Partial<Record<ChampReception, string>>;
  /** Avertissements non bloquants (aujourd'hui : cohérence extension / format sur le fichier). */
  avertissements: Partial<Record<ChampReception, string>>;
  /** Champs vides ou absents. */
  manques: ChampReception[];
  /** Champs renseignés mais non acceptables. */
  problemes: ChampReception[];
  valide: boolean;
}

export function validerReception({ valeurs, fichier, meta }: EntreeValidation): ResultatValidation {
  const erreurs: Partial<Record<ChampReception, string>> = {};
  const avertissements: Partial<Record<ChampReception, string>> = {};
  const manques: ChampReception[] = [];
  const problemes: ChampReception[] = [];
  for (const champ of ORDRE_CHAMPS) {
    if (champ === "fichier") {
      const c = controlerFichier(fichier, valeurs.format, meta);
      if (c.erreur) { erreurs.fichier = c.erreur; (fichier ? problemes : manques).push("fichier"); }
      if (c.avertissement) avertissements.fichier = c.avertissement;
      continue;
    }
    const message = validerChamp(champ, valeurs[champ], meta);
    if (!message) continue;
    erreurs[champ] = message;
    (valeurs[champ].trim() === "" ? manques : problemes).push(champ);
  }
  return { erreurs, avertissements, manques, problemes, valide: manques.length === 0 && problemes.length === 0 };
}

export interface DiagnosticBouton {
  actif: boolean;
  manques: ChampReception[];
  problemes: ChampReception[];
  /** Phrase à afficher près du bouton quand il est inactif ; `null` quand il est actif. */
  phrase: string | null;
}

export interface EntreeDiagnostic extends EntreeValidation {
  envoiEnCours?: boolean;
  /** Le parent a désactivé tout le formulaire ; `raisonDesactive` dit pourquoi, s'il le sait. */
  desactive?: boolean;
  raisonDesactive?: string;
}

/** Dit si « Recevoir et contrôler le lot » est actif et, sinon, ce qui manque ou ce qui est à corriger. */
export function diagnostiquerBouton(e: EntreeDiagnostic): DiagnosticBouton {
  const v = validerReception(e);
  if (e.envoiEnCours) {
    return { actif: false, manques: v.manques, problemes: v.problemes, phrase: "Envoi en cours : le bouton se réactivera à la fin. Ne relancez pas l'envoi." };
  }
  if (e.desactive) {
    return {
      actif: false, manques: v.manques, problemes: v.problemes,
      phrase: e.raisonDesactive ?? "Le formulaire est momentanément indisponible.",
    };
  }
  if (v.valide) return { actif: true, manques: [], problemes: [], phrase: null };
  const manque = v.manques.length > 0 ? joindreFr(v.manques.map((c) => MANQUE_PHRASE[c])) : null;
  const corriger = v.problemes.length > 0 ? joindreFr(v.problemes.map((c) => PROBLEME_PHRASE[c])) : null;
  const debut = "Pour activer « Recevoir et contrôler le lot »,";
  let phrase: string;
  if (manque && corriger) phrase = `${debut} il manque : ${manque}. Il faut aussi corriger : ${corriger}.`;
  else if (manque) phrase = `${debut} il manque : ${manque}.`;
  else phrase = `${debut} corrigez : ${corriger}.`;
  return { actif: false, manques: v.manques, problemes: v.problemes, phrase };
}

/** Données nettoyées à remettre à `onSoumettre`. À n'appeler que si la validation est passée. */
export function preparerDonnees(valeurs: ValeursReception): DonneesReception {
  return {
    systemeSource: valeurs.systemeSource.trim(),
    format: valeurs.format.trim() as DonneesReception["format"],
    methodeSource: valeurs.methodeSource.trim(),
    versionMapping: valeurs.versionMapping.trim(),
    autorisationRef: valeurs.autorisationRef.trim(),
  };
}

// ---------------------------------------------------------------------------------------------
// Refus et échecs du serveur
// ---------------------------------------------------------------------------------------------

export type NatureEchec =
  /** Le serveur a répondu et refusé : rien n'a été enregistré. */
  | "refus"
  /** Pas de réponse exploitable (réseau, délai, 5xx) : le lot a peut-être été enregistré. */
  | "incertain";

export interface EchecReception {
  nature: NatureEchec;
  statutHttp: number | null;
  /** Code stable du contrat (`FICHIER_VIDE`, ...) ; `null` s'il n'y en a pas. */
  code: string | null;
  titre: string;
  message: string;
  /** Délai conseillé par le serveur avant de réessayer (en-tête Retry-After, en secondes) ; `null` sinon. */
  delaiSecondes: number | null;
  /** Messages rattachés aux champs du formulaire. */
  champs: Partial<Record<ChampReception, string>>;
  /** Détails du serveur sur des champs que ce formulaire n'affiche pas. */
  autres: string[];
}

export const TITRE_REFUS = "Le serveur a refusé la réception. Rien n'a été enregistré.";
export const TITRE_INCERTAIN = "La réception n'a pas pu être confirmée.";
export const TITRE_OCCUPE = "Le serveur est occupé. Rien n'a été enregistré pour ce fichier.";
export const MESSAGE_INCERTAIN =
  "Consultez la liste des lots avant de réessayer : le lot a peut-être été enregistré. Vos informations et votre fichier sont conservés ici. Renvoyer le même fichier est sans danger : le serveur reconnaît un fichier déjà reçu et n'écrit rien.";

interface ReponseBrute { statut: number | null; donnees: Record<string, unknown>; retryApres: number | null }

function objet(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Lit une erreur axios (`response.status`, `response.data`) ou une forme directe `{ status, code, error, details }`. */
function lireReponse(erreur: unknown): ReponseBrute {
  const e = objet(erreur);
  const r = objet(e?.response);
  const brut = r ?? e;
  const statut = typeof brut?.status === "number" ? brut.status : null;
  const donnees = r ? (objet(r.data) ?? {}) : (e ?? {});
  return { statut, donnees, retryApres: lireRetryApres(brut) };
}

/**
 * Retry-After en secondes entières (axios range les en-têtes en minuscules ; une forme directe peut
 * donner `retryAfter`). La forme « date HTTP » n'est pas lue : elle exigerait l'horloge, et ce noyau
 * n'en a pas. Dans ce cas on ne propose simplement aucun délai chiffré.
 */
function lireRetryApres(brut: Record<string, unknown> | null | undefined): number | null {
  const entetes = objet(brut?.headers);
  let valeur: unknown = entetes?.["retry-after"] ?? entetes?.["Retry-After"] ?? brut?.retryAfter;
  if (typeof valeur === "string" && /^\s*\d+\s*$/.test(valeur)) valeur = Number(valeur);
  return typeof valeur === "number" && Number.isFinite(valeur) && valeur >= 0 ? Math.ceil(valeur) : null;
}

/** « environ 5 secondes », « environ 2 minutes ». */
export function formaterDelai(secondes: number): string {
  if (secondes < 60) return `${secondes} seconde${secondes > 1 ? "s" : ""}`;
  const minutes = Math.ceil(secondes / 60);
  return `${minutes} minute${minutes > 1 ? "s" : ""}`;
}

/** Traduit les messages zod les plus courants ; sinon une formule neutre (jamais d'anglais affiché). */
export function traduireDetailServeur(message: string): string {
  if (/^Required$/i.test(message)) return "valeur manquante";
  if (/at least 1 character/i.test(message) || /expected string to have >=1(?!\d)/i.test(message)) return "valeur vide";
  const min = message.match(/at least (\d+) character/i) ?? message.match(/>=\s*(\d+)\s*characters/i);
  if (min) return `valeur trop courte (${min[1]} caractères au minimum)`;
  const max = message.match(/at most (\d+) character/i) ?? message.match(/<=\s*(\d+)\s*characters/i);
  if (max) return `valeur trop longue (${max[1]} caractères au maximum)`;
  if (/invalid enum value|invalid option/i.test(message)) return "valeur non admise";
  if (/invalid date/i.test(message)) return "date non valide";
  return "valeur non acceptée";
}

function detailsParChamp(details: unknown): Array<[string, string]> {
  const d = objet(details);
  if (!d) return [];
  const sorties: Array<[string, string]> = [];
  for (const [cle, brut] of Object.entries(d)) {
    const liste = Array.isArray(brut) ? brut.filter((x): x is string => typeof x === "string") : [];
    sorties.push([cle, liste.length > 0 ? joindreFr([...new Set(liste.map(traduireDetailServeur))]) : "valeur non acceptée"]);
  }
  return sorties;
}

/** Texte et champ rattaché pour chaque code du contrat. */
function texteParCode(code: string, meta: MetaImport): { champ: ChampReception | null; message: string } | null {
  switch (code) {
    case "FICHIER_MANQUANT":
      return { champ: "fichier", message: "Le serveur n'a reçu aucun fichier. Choisissez un fichier puis recommencez." };
    case "CHAMPS_INVALIDES":
      return { champ: null, message: "Le serveur refuse certaines informations saisies. Corrigez les champs indiqués puis recommencez." };
    case "FORMAT_INCOHERENT":
      return { champ: "format", message: "Le contenu du fichier ne correspond pas au format déclaré. Vérifiez le format choisi ou le fichier lui-même." };
    case "FORMAT_NON_ADMIS":
      return { champ: "format", message: `Le serveur ne prend pas en charge ce format. ${texteAideFormats(meta)}` };
    case "ENCODAGE_NON_UTF8":
      return { champ: "fichier", message: "Le fichier n'est pas encodé en UTF-8 : réenregistrez-le en UTF-8 puis réessayez." };
    case "SERVICE_OCCUPE":
      return { champ: null, message: "Le serveur traite déjà d'autres lots. Rien n'a été enregistré pour ce fichier : réessayez dans quelques instants." };
    case "FICHIER_VIDE":
      return { champ: "fichier", message: "Le serveur a reçu un fichier vide. Choisissez un fichier qui contient des données." };
    case "FICHIER_TROP_GROS":
      return { champ: "fichier", message: `Le fichier dépasse la taille maximale acceptée par le serveur (${formaterTaille(meta.tailleMaxOctets)}). Réduisez-le ou découpez-le en plusieurs lots.` };
    case "TROP_DE_LIGNES":
      return { champ: "fichier", message: `Le fichier contient plus de lignes que le serveur n'en accepte (${formaterNombre(meta.limiteLignes)} lignes au plus). Découpez-le en plusieurs lots.` };
    case "TELEVERSEMENT_INVALIDE":
      return { champ: null, message: "Le transfert du fichier a été interrompu ou était mal formé. Recommencez l'envoi." };
    default:
      return null;
  }
}

/**
 * Range une erreur d'envoi dans l'une des deux natures qui ne se traitent pas pareil :
 * un REFUS (le serveur a répondu 4xx : rien n'est enregistré, on corrige) ou un résultat INCERTAIN
 * (réseau coupé, délai, 5xx : on ne sait pas, on regarde la liste des lots avant de réessayer).
 */
export function classerEchec(erreur: unknown, meta: MetaImport): EchecReception {
  const { statut, donnees, retryApres } = lireReponse(erreur);
  // 503 + SERVICE_OCCUPE : le serveur AFFIRME qu'aucun lot n'a été créé (il a refusé avant de traiter).
  // C'est la seule exception « 5xx = incertain » ; un 503 sans ce code (passerelle, serveur tombé) reste incertain.
  const occupe = statut === 503 && donnees.code === "SERVICE_OCCUPE";
  const refus = occupe || (statut !== null && statut >= 400 && statut < 500 && statut !== 408);
  if (!refus) {
    return { nature: "incertain", statutHttp: statut, code: null, titre: TITRE_INCERTAIN, message: MESSAGE_INCERTAIN, delaiSecondes: null, champs: {}, autres: [] };
  }
  const details = detailsParChamp(donnees.details);
  let code = typeof donnees.code === "string" ? donnees.code : null;
  // Un 413 vient du serveur web devant l'API (aucun corps JSON) ; un 400 « champs invalides » sans code
  // se reconnaît à ses détails. Dans les deux cas le sens est sans ambiguïté.
  if (!code && statut === 413) code = "FICHIER_TROP_GROS";
  if (!code && statut === 400 && details.length > 0) code = "CHAMPS_INVALIDES";

  const champs: Partial<Record<ChampReception, string>> = {};
  const autres: string[] = [];
  let message: string;

  if (statut === 401) {
    message = "Votre session a expiré. Reconnectez-vous puis recommencez l'envoi.";
  } else if (statut === 403) {
    message = "Votre profil n'est pas autorisé à recevoir des lots (réservé aux administrateurs et aux gestionnaires).";
  } else {
    const connu = code ? texteParCode(code, meta) : null;
    if (connu) {
      message = connu.message;
      if (connu.champ) champs[connu.champ] = connu.message;
    } else {
      const brut = typeof donnees.error === "string" && donnees.error.trim() !== "" ? donnees.error.trim() : null;
      message = brut ? `Le serveur a répondu : ${brut}.` : "Le serveur a refusé la demande, sans en donner le motif.";
    }
  }

  if (code === "CHAMPS_INVALIDES") {
    for (const [cle, texte] of details) {
      if ((ORDRE_CHAMPS as readonly string[]).includes(cle) && cle !== "fichier") {
        champs[cle as ChampReception] = `Le serveur refuse cette valeur : ${texte}.`;
      } else {
        autres.push(`${cle} : ${texte}`);
      }
    }
  }
  if (occupe && retryApres !== null) message = `${message} Délai conseillé par le serveur : ${formaterDelai(retryApres)}.`;
  return {
    nature: "refus", statutHttp: statut, code, titre: occupe ? TITRE_OCCUPE : TITRE_REFUS, message,
    delaiSecondes: occupe ? retryApres : null, champs, autres,
  };
}

// ---------------------------------------------------------------------------------------------
// Lecture d'une réponse de réception
// ---------------------------------------------------------------------------------------------

export type NatureResultat =
  /** Le même fichier avait déjà été reçu : rien n'a été écrit. */
  | "dejaRecu"
  /** Reçu, lisible, mais non conforme : c'est un RÉSULTAT (statut REJETE), pas une panne. */
  | "rejete"
  /** Reçu et conforme au contrat de schéma (statut VALIDE_SCHEMA). */
  | "controle"
  /** Autre statut décidé par le serveur : on le dit sans en tirer de conclusion. */
  | "autre";

export function natureResultat(r: ReceptionReponse): NatureResultat {
  if (r.dejaRecu) return "dejaRecu";
  if (r.statut === "REJETE") return "rejete";
  if (r.statut === "VALIDE_SCHEMA") return "controle";
  return "autre";
}

/** Libellé lisible d'un nom de champ renvoyé par le serveur dans `metadonneesDifferentes`. */
export function libelleChampServeur(champ: string): string {
  const connu = (LIBELLE_CHAMP as Record<string, string>)[champ];
  if (connu) return connu;
  if (champ === "auteurSource") return "Auteur de la source";
  if (champ === "dateSource") return "Date de la source";
  return champ;
}
