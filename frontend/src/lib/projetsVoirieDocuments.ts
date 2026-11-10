import { classerErreur, formaterNombre, formaterTaille, versNombre, type ErreurPv, type GenreErreur } from "./projetsVoirie";
import { ReponseInattendue } from "./projetsVoirieApi";

/**
 * Documents du projet et « ce que les documents permettent » (lot D1, interface UI-D). Regles PURES et lecteurs des reponses.
 * SOURCE DES FORMES : docs/projets-voirie/CONTRAT-DOCUMENTS.md (sections 3 a 6), API.md section D1, et le code reel du serveur
 * (backend/src/projets-voirie/documents/vues.ts, documents.service.ts, completude.noyau.ts).
 *
 * Principes tenus ici :
 *  - le serveur fait autorite : `transitionsPossibles`, `exploitable`, `aide`, les avertissements de depot sont LUS, jamais recalcules ;
 *  - un champ masque pour ce compte (jeu lie illisible, justification, historique) est rendu `null` et l'ecran le dit, jamais une valeur deduite ;
 *  - le fichier d'une piece (PDF, DWG) est envoye au serveur, qui en lit le format par la signature et en calcule l'empreinte, puis l'oublie
 *    (contrat, section 2.1 et 5) : aucune lecture du contenu dans le navigateur, aucun stockage local.
 */

// ---------------------------------------------------------------------------------------------------
// Constantes du contrat
// ---------------------------------------------------------------------------------------------------

export type StatutDocument = "ATTENDU" | "RECU" | "EN_ANALYSE" | "EXPLOITABLE" | "INCOMPLET" | "A_CORRIGER" | "REMPLACE" | "VALIDE" | "REJETE";
export const STATUTS_DOCUMENT: readonly StatutDocument[] = ["ATTENDU", "RECU", "EN_ANALYSE", "EXPLOITABLE", "INCOMPLET", "A_CORRIGER", "VALIDE", "REJETE", "REMPLACE"];
export const estStatutDocument = (v: unknown): v is StatutDocument => typeof v === "string" && (STATUTS_DOCUMENT as readonly string[]).includes(v);

export const LIBELLE_STATUT_DOCUMENT: Readonly<Record<StatutDocument, string>> = {
  ATTENDU: "Attendu", RECU: "Reçu", EN_ANALYSE: "En analyse", EXPLOITABLE: "Exploitable", INCOMPLET: "Incomplet", A_CORRIGER: "À corriger",
  VALIDE: "Validé", REJETE: "Rejeté", REMPLACE: "Remplacé",
};
export const AIDE_STATUT_DOCUMENT: Readonly<Record<StatutDocument, string>> = {
  ATTENDU: "pièce demandée, pas encore reçue",
  RECU: "pièce reçue, pas encore examinée",
  EN_ANALYSE: "en cours d'examen",
  EXPLOITABLE: "lisible et utilisable pour ce à quoi elle sert",
  INCOMPLET: "il manque une partie de la pièce",
  A_CORRIGER: "erreur à corriger par le fournisseur",
  VALIDE: "validée par une autre personne que le déposant",
  REJETE: "refusée définitivement",
  REMPLACE: "une version plus récente l'a remplacée",
};

/** Statuts qu'une personne peut demander (route `statut`) ; ATTENDU, RECU et REMPLACE sont poses par le serveur. */
export const STATUTS_DEMANDABLES: readonly StatutDocument[] = ["EN_ANALYSE", "EXPLOITABLE", "INCOMPLET", "A_CORRIGER", "VALIDE", "REJETE"];
/** Statuts qui exigent une justification de 10 caracteres au moins (contrat, section 3.1 ; contrainte de la base). */
export const JUSTIFICATION_EXIGEE: readonly StatutDocument[] = ["INCOMPLET", "A_CORRIGER", "VALIDE", "REJETE"];
export const JUSTIFICATION_DOCUMENT_MIN = 10;
/** Libelle de l'action qui mene a un statut (bouton). */
export const ACTION_VERS_STATUT: Readonly<Record<StatutDocument, string>> = {
  ATTENDU: "Attendu", RECU: "Reçu", EN_ANALYSE: "Mettre en analyse", EXPLOITABLE: "Déclarer exploitable", INCOMPLET: "Déclarer incomplet",
  A_CORRIGER: "Demander une correction", VALIDE: "Valider", REJETE: "Rejeter", REMPLACE: "Remplacé",
};

/** Plafond du fichier d'une piece (contrat, section 5 : 25 Mo, 413 FICHIER_TROP_GROS au-dela). */
export const TAILLE_MAX_PIECE = 25 * 1024 * 1024;
/** Plafond d'affichage des pieces manquantes avant le bouton « afficher les autres ». */
export const PIECES_AFFICHEES = 20;

export const AIDE_DWG_LOCALE = "Un DWG est un format propriétaire : aucun convertisseur n'est embarqué et il ne devient jamais exploitable ni validé. Il est conservé comme pièce reçue (son empreinte et sa référence). Pour l'exploiter : exportez le dessin en DXF (Enregistrer sous, type DXF), en mètres et dans un système de coordonnées connu, importez le DXF comme jeu de données du projet, puis déposez une nouvelle version de ce document liée au jeu importé.";
export const AIDE_PDF_LOCALE = "Un PDF est une pièce de référence : il est conservé par sa référence et son empreinte, jamais importé comme géométrie. Il peut devenir exploitable et validé comme pièce du dossier.";
export const MENTION_FICHIER_NON_CONSERVE = "Le fichier est lu par le serveur pour en calculer l'empreinte (SHA-256) et en reconnaître le format par son contenu, puis oublié : il n'est conservé ni en base, ni sur disque, ni sur cet appareil.";
export const MENTION_INDEPENDANCE = "Chaque fonction a ses propres conditions : une pièce manquante ne bloque que les fonctions qui en dépendent, jamais une fonction indépendante.";

export type CodeFonction = "ANALYSE_2D" | "CONFLITS" | "COMPARAISON_SOURCES" | "RECOLEMENT" | "EXPORT_DOSSIER";
export const LIBELLE_FONCTION: Readonly<Record<string, string>> = {
  ANALYSE_2D: "Analyse 2D (longueurs dans la chaussée et l'emprise)",
  CONFLITS: "Analyse des conflits (dossiers persistés)",
  COMPARAISON_SOURCES: "Comparaison de deux sources d'un même réseau",
  RECOLEMENT: "Récolement d'un réseau déplacé",
  EXPORT_DOSSIER: "Export du dossier technique",
};
export const LIBELLE_CONDITION: Readonly<Record<string, string>> = {
  PLAN_AXES_AUTORISE: "Un plan d'axes autorisé",
  RESEAU_AUTORISE: "Un réseau de concessionnaire autorisé",
  DEUX_SOURCES_MEME_RESEAU: "Deux sources autorisées d'un même réseau (même concessionnaire, même type)",
  DECISION_DEPLACEMENT: "Une décision de déplacement de réseau approuvée",
  SECONDE_SOURCE: "Une seconde source autorisée de ce réseau",
};
export const libelleFonction = (code: string, serveur?: string | null): string => LIBELLE_FONCTION[code] ?? serveur ?? code;
export const libelleCondition = (code: string, serveur?: string | null): string => LIBELLE_CONDITION[code] ?? serveur ?? code;

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export interface PersonneDoc { id: string; nomComplet: string | null }

export interface PieceDocument {
  reference: string | null; nomFichier: string | null; format: string | null; sha256: string | null; tailleOctets: number | null;
  /** `true` : une piece liee a un jeu ; `false` : sans jeu ; `null` : inconnu pour ce compte (jeu qu'il ne voit plus). */
  jeuLie: boolean | null;
}

export interface DocumentProjet {
  id: string; projetId: string | null; ligneeId: string; version: number; remplaceId: string | null;
  typeCode: string; type: { code: string; libelle: string; actif: boolean } | null;
  titre: string; description: string | null; dateDocument: string | null; concessionnaire: { id: string; nom: string } | null;
  statut: StatutDocument; piece: PieceDocument;
  jeu: { id: string; statut: string | null; role: string | null; version: number | null; format: string | null } | null;
  /** `null` : non rendu (jeu lie illisible pour ce compte). */
  exploitable: { possible: boolean; raison: string | null } | null;
  aide: string | null;
  creePar: PersonneDoc | null; createdAt: string | null; deposePar: PersonneDoc | null; deposeLe: string | null;
  validePar: PersonneDoc | null; valideLe: string | null;
  derniereAction: { par: PersonneDoc | null; le: string | null; justification: string | null } | null;
  /** `null` : non rendu par le serveur (compte qui ne decide pas). */
  transitionsPossibles: StatutDocument[] | null;
}

export interface PageDocuments { documents: DocumentProjet[]; suivant: string | null; ignores: number }

export interface LigneHistoriqueDocument {
  id: string; version: number | null; action: string; statutAvant: string | null; statutApres: string | null; par: PersonneDoc | null;
  justification: string | null; details: Record<string, unknown> | null; le: string | null;
}

export interface FicheDocumentProjet {
  document: DocumentProjet;
  versions: { id: string; version: number; statut: StatutDocument | null; createdAt: string | null }[];
  versionsTronquees: boolean;
  /** `null` : historique non rendu (compte qui ne decide pas). */
  historique: LigneHistoriqueDocument[] | null;
  historiqueTronque: boolean;
}

export interface Avertissement { code: string; message: string }
export interface ResultatEcritureDocument { document: DocumentProjet; avertissements: Avertissement[]; remplace: { id: string; version: number | null; statut: string | null } | null }

export type EtatFonction = "DISPONIBLE" | "INDISPONIBLE" | "NON_LIVREE";
export interface FonctionCompletude { code: string; libelle: string; etat: EtatFonction; conditions: { code: string; libelle: string; remplie: boolean; nb: number | null }[] }
export interface DocumentPiece { id: string; version: number | null; titre: string; statut: StatutDocument | null; format: string | null; typeCode: string | null }
export type PieceManquante =
  | { nature: "CONDITION"; code: string; libelle: string; reseau: { concessionnaire: string | null; typeReseau: string | null } | null; fonctions: string[]; suffiraitPour: string[]; typesDocument: { code: string; libelle: string }[]; documents: DocumentPiece[] | null }
  | { nature: "TYPE_OBLIGATOIRE"; typeDocument: { code: string; libelle: string }; roleJeu: string | null; fonctions: string[]; suffiraitPour: string[]; documents: DocumentPiece[] | null }
  | { nature: "DOCUMENT"; document: DocumentPiece; fonctions: string[] };

export interface Completude {
  calculeLe: string | null;
  fonctions: FonctionCompletude[];
  reseaux: { concessionnaire: string | null; typeReseau: string | null; typeReseauCode: string | null; nbSources: number | null; comparable: boolean }[];
  piecesManquantes: PieceManquante[];
  /** Pieces illisibles ecartees de l'affichage (forme inattendue) : dites a l'ecran, jamais ignorees en silence. */
  piecesIgnorees: number;
  documents: { total: number | null; parStatut: Partial<Record<StatutDocument, number>>; tronque: boolean };
  regle: string | null;
}

// ---------------------------------------------------------------------------------------------------
// Lecteurs (tolerants a l'absence, stricts sur la structure)
// ---------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const chaines = (v: unknown): string[] => tableau(v).filter((x): x is string => typeof x === "string" && x.trim() !== "");
const date = (v: unknown): string | null => (typeof v === "string" ? v : v instanceof Date ? v.toISOString() : null);

function personne(v: unknown): PersonneDoc | null {
  return estObjet(v) && texte(v.id) ? { id: String(v.id), nomComplet: texte(v.nomComplet) } : null;
}

export function lireDocument(v: unknown): DocumentProjet | null {
  if (!estObjet(v) || !texte(v.id) || !estStatutDocument(v.statut)) return null;
  const p = estObjet(v.piece) ? v.piece : {};
  const j = estObjet(v.jeu) && texte(v.jeu.id) ? v.jeu : null;
  const x = estObjet(v.exploitable) && typeof v.exploitable.possible === "boolean" ? { possible: v.exploitable.possible, raison: texte(v.exploitable.raison) } : null;
  const t = estObjet(v.type) && texte(v.type.code) ? { code: String(v.type.code), libelle: texte(v.type.libelle) ?? String(v.type.code), actif: v.type.actif !== false } : null;
  const c = estObjet(v.concessionnaire) && texte(v.concessionnaire.id) ? { id: String(v.concessionnaire.id), nom: texte(v.concessionnaire.nom) ?? "Concessionnaire sans nom" } : null;
  const da = estObjet(v.derniereAction) ? { par: personne(v.derniereAction.par), le: date(v.derniereAction.le), justification: texte(v.derniereAction.justification) } : null;
  return {
    id: String(v.id), projetId: texte(v.projetId), ligneeId: texte(v.ligneeId) ?? String(v.id), version: Math.max(1, versNombre(v.version) ?? 1), remplaceId: texte(v.remplaceId),
    typeCode: texte(v.typeCode) ?? t?.code ?? "", type: t, titre: texte(v.titre) ?? "Document sans titre", description: texte(v.description), dateDocument: texte(v.dateDocument),
    concessionnaire: c, statut: v.statut,
    piece: {
      reference: texte(p.reference), nomFichier: texte(p.nomFichier), format: texte(p.format), sha256: texte(p.sha256), tailleOctets: versNombre(p.tailleOctets),
      jeuLie: typeof p.jeuLie === "boolean" ? p.jeuLie : null,
    },
    jeu: j ? { id: String(j.id), statut: texte(j.statut), role: texte(j.role), version: versNombre(j.version), format: texte(j.format) } : null,
    exploitable: x, aide: texte(v.aide),
    creePar: personne(v.creePar), createdAt: date(v.createdAt), deposePar: personne(v.deposePar), deposeLe: date(v.deposeLe),
    validePar: personne(v.validePar), valideLe: date(v.valideLe), derniereAction: da,
    transitionsPossibles: Array.isArray(v.transitionsPossibles) ? v.transitionsPossibles.filter(estStatutDocument) : null,
  };
}

export function lirePageDocuments(data: unknown): PageDocuments {
  if (!estObjet(data) || !Array.isArray(data.documents)) throw new ReponseInattendue("GET /v2/projets-voirie/:id/documents");
  const documents: DocumentProjet[] = [];
  let ignores = 0;
  for (const d of data.documents) { const x = lireDocument(d); if (x) documents.push(x); else ignores += 1; }
  return { documents, suivant: texte(data.curseurSuivant), ignores };
}

export function lireFicheDocument(data: unknown): FicheDocumentProjet {
  const document = estObjet(data) ? lireDocument(data.document) : null;
  if (!estObjet(data) || !document) throw new ReponseInattendue("GET /v2/projets-voirie/:id/documents/:docId");
  return {
    document,
    versions: tableau(data.versions).flatMap((v) => (estObjet(v) && texte(v.id) ? [{ id: String(v.id), version: versNombre(v.version) ?? 0, statut: estStatutDocument(v.statut) ? v.statut : null, createdAt: date(v.createdAt) }] : [])),
    versionsTronquees: data.versionsTronquees === true,
    historique: Array.isArray(data.historique) ? data.historique.flatMap((h): LigneHistoriqueDocument[] => (estObjet(h) && (texte(h.action) !== null) ? [{
      id: String(h.id ?? ""), version: versNombre(h.version), action: String(h.action), statutAvant: texte(h.statutAvant), statutApres: texte(h.statutApres),
      par: personne(h.par), justification: texte(h.justification), details: estObjet(h.details) ? h.details : null, le: date(h.le),
    }] : [])) : null,
    historiqueTronque: data.historiqueTronque === true,
  };
}

export function lireAvertissements(v: unknown): Avertissement[] {
  return tableau(v).flatMap((a) => (estObjet(a) && texte(a.code) ? [{ code: String(a.code), message: texte(a.message) ?? "" }] : []));
}

export function lireEcritureDocument(data: unknown, route: string): ResultatEcritureDocument {
  const document = estObjet(data) ? lireDocument(data.document) : null;
  if (!estObjet(data) || !document) throw new ReponseInattendue(route);
  const r = estObjet(data.remplace) && texte(data.remplace.id) ? { id: String(data.remplace.id), version: versNombre(data.remplace.version), statut: texte(data.remplace.statut) } : null;
  return { document, avertissements: lireAvertissements(data.avertissements), remplace: r };
}

function lireDocumentPiece(v: unknown): DocumentPiece | null {
  return estObjet(v) && texte(v.id) ? {
    id: String(v.id), version: versNombre(v.version), titre: texte(v.titre) ?? "Document sans titre", statut: estStatutDocument(v.statut) ? v.statut : null,
    format: texte(v.format), typeCode: texte(v.typeCode),
  } : null;
}
const documentsPiece = (v: unknown): DocumentPiece[] | null => (Array.isArray(v) ? v.flatMap((d) => { const x = lireDocumentPiece(d); return x ? [x] : []; }) : null);
const typesDoc = (v: unknown) => tableau(v).flatMap((t) => (estObjet(t) && texte(t.code) ? [{ code: String(t.code), libelle: texte(t.libelle) ?? String(t.code) }] : []));

export function lirePieceManquante(v: unknown): PieceManquante | null {
  if (!estObjet(v)) return null;
  const fonctions = chaines(v.fonctions);
  if (v.nature === "CONDITION" && texte(v.code)) {
    const r = estObjet(v.reseau) ? { concessionnaire: texte(v.reseau.concessionnaire), typeReseau: texte(v.reseau.typeReseau) } : null;
    return { nature: "CONDITION", code: String(v.code), libelle: libelleCondition(String(v.code), texte(v.libelle)), reseau: r, fonctions, suffiraitPour: chaines(v.suffiraitPour), typesDocument: typesDoc(v.typesDocument), documents: documentsPiece(v.documents) };
  }
  if (v.nature === "TYPE_OBLIGATOIRE" && estObjet(v.typeDocument) && texte(v.typeDocument.code)) {
    return {
      nature: "TYPE_OBLIGATOIRE", typeDocument: { code: String(v.typeDocument.code), libelle: texte(v.typeDocument.libelle) ?? String(v.typeDocument.code) }, roleJeu: texte(v.roleJeu),
      fonctions, suffiraitPour: chaines(v.suffiraitPour), documents: documentsPiece(v.documents),
    };
  }
  if (v.nature === "DOCUMENT") {
    const d = lireDocumentPiece(v.document);
    return d ? { nature: "DOCUMENT", document: d, fonctions } : null;
  }
  return null;
}

export function lireCompletude(data: unknown): Completude {
  if (!estObjet(data) || !Array.isArray(data.fonctions)) throw new ReponseInattendue("GET /v2/projets-voirie/:id/completude");
  const fonctions = data.fonctions.flatMap((f): FonctionCompletude[] => {
    if (!estObjet(f) || !texte(f.code)) return [];
    const etat: EtatFonction = f.etat === "DISPONIBLE" || f.etat === "NON_LIVREE" ? f.etat : "INDISPONIBLE";
    return [{
      code: String(f.code), libelle: libelleFonction(String(f.code), texte(f.libelle)), etat,
      conditions: tableau(f.conditions).flatMap((c) => (estObjet(c) && texte(c.code) ? [{ code: String(c.code), libelle: libelleCondition(String(c.code), texte(c.libelle)), remplie: c.remplie === true, nb: versNombre(c.nb) }] : [])),
    }];
  });
  let piecesIgnorees = 0;
  const piecesManquantes: PieceManquante[] = [];
  for (const p of tableau(data.piecesManquantes)) { const x = lirePieceManquante(p); if (x) piecesManquantes.push(x); else piecesIgnorees += 1; }
  const d = estObjet(data.documents) ? data.documents : {};
  const parStatut: Partial<Record<StatutDocument, number>> = {};
  if (estObjet(d.parStatut)) for (const [k, n] of Object.entries(d.parStatut)) { const x = versNombre(n); if (estStatutDocument(k) && x !== null) parStatut[k] = x; }
  return {
    calculeLe: date(data.calculeLe), fonctions,
    reseaux: tableau(data.reseaux).flatMap((r) => (estObjet(r) ? [{ concessionnaire: texte(r.concessionnaire), typeReseau: texte(r.typeReseau), typeReseauCode: texte(r.typeReseauCode), nbSources: versNombre(r.nbSources), comparable: r.comparable === true }] : [])),
    piecesManquantes, piecesIgnorees,
    documents: { total: versNombre(d.total), parStatut, tronque: d.tronque === true },
    regle: texte(data.regle),
  };
}

// ---------------------------------------------------------------------------------------------------
// Regles d'interface (le serveur reste la garde)
// ---------------------------------------------------------------------------------------------------

export interface TransitionProposee { statut: StatutDocument; libelle: string; justificationExigee: boolean }
export interface TransitionEcartee { statut: StatutDocument; raison: string }

/**
 * Transitions proposees a ce compte pour ce document : celles que le SERVEUR rend (`transitionsPossibles`, decideurs seulement), moins :
 *  - VALIDE quand ce compte a depose la piece (separation des taches, contrat 2.5 : il n'est jamais propose, et l'ecran dit pourquoi) ;
 *  - EXPLOITABLE et VALIDE quand le serveur dit la piece non exploitable (`exploitable.possible === false` : DWG, jeu non autorise).
 * Un lecteur (aucune transition rendue) n'a rien.
 */
export function transitionsPourCompte(d: DocumentProjet, compteId: string | null | undefined): { proposees: TransitionProposee[]; ecartees: TransitionEcartee[] } {
  const proposees: TransitionProposee[] = [];
  const ecartees: TransitionEcartee[] = [];
  for (const s of d.transitionsPossibles ?? []) {
    if (!STATUTS_DEMANDABLES.includes(s)) continue;
    if ((s === "EXPLOITABLE" || s === "VALIDE") && d.exploitable && !d.exploitable.possible) {
      ecartees.push({ statut: s, raison: d.exploitable.raison === "DWG_NON_EXPLOITABLE" ? "un DWG n'est jamais exploitable ni validé (exportez-le en DXF)." : d.exploitable.raison === "JEU_NON_AUTORISE" ? "le jeu lié n'est pas autorisé : autorisez-le d'abord." : "le serveur dit cette pièce non exploitable." });
      continue;
    }
    if (s === "VALIDE" && compteId && d.deposePar?.id === compteId) {
      ecartees.push({ statut: s, raison: "vous avez déposé cette pièce : une autre personne habilitée doit la valider (séparation des tâches)." });
      continue;
    }
    proposees.push({ statut: s, libelle: ACTION_VERS_STATUT[s], justificationExigee: JUSTIFICATION_EXIGEE.includes(s) });
  }
  return { proposees, ecartees };
}

/** Retrait : ADMIN et GESTIONNAIRE ; une piece VALIDE, ADMIN seulement (contrat, section 5 : 403 ROLE_INSUFFISANT sinon). */
export function peutRetirerDocument(d: DocumentProjet, role: string | undefined): { possible: boolean; raison: string | null } {
  if (role !== "ADMIN" && role !== "GESTIONNAIRE") return { possible: false, raison: null };
  if (d.statut === "VALIDE" && role !== "ADMIN") return { possible: false, raison: "Le retrait d'une pièce validée est réservé à un administrateur." };
  return { possible: true, raison: null };
}

/** Geste de piece d'un decideur : depot sur un document ATTENDU, nouvelle version sinon. */
export function gestePiece(d: DocumentProjet): "DEPOT" | "VERSION" {
  return d.statut === "ATTENDU" ? "DEPOT" : "VERSION";
}

export interface VerdictPiece { ok: boolean; message: string | null; avertissement: string | null; format: "PDF" | "DWG" | null }
/**
 * Controle LOCAL du fichier d'une piece, avant tout envoi (economie de transfert, jamais une validation) : vide ou trop gros refuses. L'extension
 * n'est qu'un indice : le serveur lit la signature (`%PDF-`, `AC10xx`) et refuse tout autre contenu (415).
 */
export function controlerFichierPiece(f: { name: string; size: number } | null): VerdictPiece {
  if (!f) return { ok: false, message: null, avertissement: null, format: null };
  if (f.size === 0) return { ok: false, message: "Le fichier est vide.", avertissement: null, format: null };
  if (f.size > TAILLE_MAX_PIECE) return { ok: false, message: `Le fichier fait ${formaterTaille(f.size)} : le maximum d'une pièce est de ${formaterTaille(TAILLE_MAX_PIECE)}.`, avertissement: null, format: null };
  const nom = f.name.toLowerCase();
  if (nom.endsWith(".pdf")) return { ok: true, message: null, avertissement: null, format: "PDF" };
  if (nom.endsWith(".dwg")) return { ok: true, message: null, avertissement: null, format: "DWG" };
  return { ok: true, message: null, avertissement: "Seuls un PDF et un DWG sont acceptés comme fichier de pièce. Le serveur reconnaît le format par le contenu et refusera tout autre fichier ; un plan géographique (GeoJSON, KML, DXF...) s'importe comme jeu de données, puis se lie au document.", format: null };
}

export const empreinteCourte = (sha: string | null): string => (sha ? `${sha.slice(0, 12)}…` : "aucune");

/** Texte de la piece pour un compte : reference, fichier (format, taille), jeu lie, ou rien (document attendu). */
export function textePiece(d: DocumentProjet): string {
  const parts: string[] = [];
  if (d.piece.reference) parts.push(`référence ${d.piece.reference}`);
  if (d.piece.nomFichier && !d.jeu) parts.push(`fichier ${d.piece.nomFichier}${d.piece.format ? ` (${d.piece.format}` : ""}${d.piece.tailleOctets !== null ? `, ${formaterTaille(d.piece.tailleOctets)}` : ""}${d.piece.format ? ")" : ""}`);
  if (d.jeu) parts.push(`jeu de données lié (version ${d.jeu.version ?? "?"}${d.jeu.statut ? `, ${d.jeu.statut.toLowerCase()}` : ""})`);
  else if (d.piece.jeuLie === true) parts.push("jeu de données lié, non lisible par votre compte");
  else if (d.piece.jeuLie === null && d.statut !== "ATTENDU" && !d.piece.reference && !d.piece.sha256) parts.push("pièce non communiquée à votre compte");
  if (parts.length === 0) return d.statut === "ATTENDU" ? "aucune pièce : document attendu" : "aucune pièce communiquée";
  return parts.join(" ; ");
}

/** Nombre a afficher : `null` (non communique) n'est jamais zero. */
export const nombreOuNonCommunique = (n: number | null | undefined): string => (typeof n === "number" ? formaterNombre(n, 0) : "non communiqué");

// ---------------------------------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------------------------------

const RIEN = " Rien n'a été modifié.";

export const MESSAGE_CODE_DOCUMENTS: Record<string, string> = {
  CHAMPS_INVALIDES: "Les valeurs envoyées sont refusées par le serveur (champ inconnu, trop long, date invalide, ou caractère de contrôle ou de direction interdit). Vérifiez la saisie." + RIEN,
  JUSTIFICATION_INVALIDE: "Une justification d'au moins 10 caractères, sans caractère de contrôle, est obligatoire pour ce geste." + RIEN,
  TYPE_DOCUMENT_INCONNU: "Ce type de document est inconnu, retiré ou désactivé dans le référentiel : choisissez un type actif (Paramètres du module, Référentiels)." + RIEN,
  CONCESSIONNAIRE_INCONNU: "Ce concessionnaire est inconnu : choisissez-le dans la liste." + RIEN,
  PIECE_REQUISE: "Une pièce est requise : une référence, un fichier PDF ou DWG, ou un jeu de données du projet." + RIEN,
  PIECE_EXCLUSIVE: "Un fichier et un jeu de données ne vont pas ensemble : choisissez l'un ou l'autre (une référence peut accompagner chacun)." + RIEN,
  ROLE_INSUFFISANT: "Votre rôle ne permet pas ce geste : le retrait d'une pièce validée est réservé à un administrateur." + RIEN,
  DOCUMENT_INTROUVABLE: "Ce document est introuvable : il n'existe pas dans ce projet, il a été retiré, ou il n'est pas visible de votre compte.",
  JEU_INTROUVABLE: "Le jeu de données choisi est introuvable dans ce projet (retiré, ou d'un autre projet)." + RIEN,
  PROJET_INTROUVABLE: "Projet introuvable : il n'existe pas, a été retiré, ou n'est pas dans votre périmètre.",
  TRANSITION_INTERDITE: "Ce changement de statut n'est pas permis depuis le statut actuel : le document a peut-être changé entre-temps. Rechargez la fiche : seuls les gestes possibles y sont proposés." + RIEN,
  STATUT_INCOMPATIBLE: "Ce document n'est plus attendu : sa pièce a déjà été déposée. Déposez plutôt une nouvelle version." + RIEN,
  DOCUMENT_ATTENDU: "Ce document est encore attendu : déposez sa pièce au lieu d'une nouvelle version." + RIEN,
  VERSION_NON_COURANTE: "Ce n'est pas la dernière version de ce document : une nouvelle version se dépose sur la dernière." + RIEN,
  VERSION_EN_COURS: "Une version de ce document est déjà en cours d'examen." + RIEN,
  DOCUMENT_NON_EXPLOITABLE: "Un DWG n'est jamais exploitable ni validé : exportez le dessin en DXF, importez-le comme jeu de données, puis déposez une nouvelle version liée au jeu." + RIEN,
  JEU_NON_AUTORISE: "Le jeu de données lié n'est pas autorisé : la pièce ne deviendra exploitable qu'une fois le jeu autorisé (onglet Couches)." + RIEN,
  SEPARATION_DES_TACHES: "Séparation des tâches : la personne qui a déposé la pièce ne la valide pas ; une autre personne habilitée doit le faire." + RIEN,
  REFERENCE_INVALIDE: "Une référence de la pièce est refusée par la base (jeu d'un autre projet, ou valeur incohérente)." + RIEN,
  CONTRAINTE_DOCUMENT: "La base a refusé cet enregistrement (règle des documents) : rechargez la fiche, l'état a peut-être changé." + RIEN,
  FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE: "Ce fichier n'est ni un PDF ni un DWG (format reconnu par le contenu, pas par l'extension). Un plan géographique s'importe comme jeu de données (« Ajouter des données »), puis se lie au document." + RIEN,
  FICHIER_TROP_GROS: "Le fichier dépasse 25 Mo, la taille maximale d'une pièce." + RIEN,
  SERVICE_OCCUPE: "Le serveur reçoit déjà d'autres fichiers : réessayez dans un instant." + RIEN,
  PROJET_OCCUPE: "Ce projet est occupé par une autre écriture : réessayez dans quelques secondes." + RIEN,
  DOCUMENTS_LECTURE_TROP_LONGUE: "La lecture des documents a dépassé le délai autorisé : réessayez dans un instant.",
  COMPLETUDE_TROP_LONGUE: "Le calcul de « ce que les documents permettent » a dépassé le délai autorisé : réessayez dans un instant.",
  CURSEUR_INVALIDE: "La page demandée n'est plus valide : repartez de la première page.",
  IDENTIFIANT_INVALIDE: "L'identifiant demandé n'est pas valide (lien tronqué ou modifié).",
};

export function classerErreurDocuments(e: unknown): ErreurPv {
  const base = classerErreur(e);
  if (base.code && MESSAGE_CODE_DOCUMENTS[base.code]) {
    const genre: GenreErreur = base.status === 409 ? "conflit" : base.status === 404 ? "introuvable" : base.status === 403 ? "droit" : base.status === 413 ? "trop-gros"
      : base.status === 429 || base.status === 503 || base.status === 504 ? "serveur" : "validation";
    let message = MESSAGE_CODE_DOCUMENTS[base.code];
    if ((base.code === "SERVICE_OCCUPE" || base.code === "PROJET_OCCUPE") && base.retryAfterS) message += ` Réessayez dans ${base.retryAfterS} seconde${base.retryAfterS > 1 ? "s" : ""}.`;
    return { ...base, genre, message };
  }
  if (base.status === 413) return { ...base, genre: "trop-gros", message: MESSAGE_CODE_DOCUMENTS.FICHIER_TROP_GROS };
  if (base.status === 415) return { ...base, genre: "validation", message: MESSAGE_CODE_DOCUMENTS.FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE };
  if (base.status === 429) return { ...base, genre: "serveur", message: `Trop de demandes en peu de temps.${base.retryAfterS ? ` Réessayez dans ${base.retryAfterS} seconde${base.retryAfterS > 1 ? "s" : ""}.` : " Réessayez dans un instant."}` };
  if (base.status === 504) return { ...base, genre: "serveur", message: "Le serveur a mis trop de temps à répondre : réessayez dans un instant." };
  return base;
}
