import { classerErreur, formaterNombre, formaterTaille, versNombre, type ErreurPv, type GenreErreur } from "./projetsVoirie";
import { ReponseInattendue } from "./projetsVoirieApi";

/**
 * Export du dossier technique, derogations de confidentialite et tableaux de bord (lot X1, interface UI-D). Regles PURES et lecteurs.
 * SOURCE DES FORMES : docs/projets-voirie/CONTRAT-EXPORTS.md (sections 4 a 6 et 9, corrections apres revue), API.md section X1, et le code reel
 * (backend/src/api-v2/projets-voirie.dossier-technique.routes.ts, exports/confidentialite.noyau.ts, tableaux/tableau.noyau.ts).
 *
 * Principes tenus ici :
 *  - ce que l'archive contiendra est une PREVISION a partir des regles du contrat ; le manifeste de l'archive (et l'en-tete `X-Jeux-Geojson`) fait foi :
 *    un reglage du serveur peut encore restreindre les niveaux exportables ;
 *  - un agregat `null` pour ce compte est « non communique a votre role », jamais zero ; la lisibilite vient du serveur (`lisibilite`), pas du role ;
 *  - aucune geometrie ni nom d'objet n'est lu par les tableaux de bord ; l'archive n'est jamais ouverte par le navigateur.
 */

// ---------------------------------------------------------------------------------------------------
// Constantes du contrat
// ---------------------------------------------------------------------------------------------------

/** Niveaux exportables par defaut (contrat 4.3) ; un reglage du serveur peut seulement les RESTREINDRE. */
export const NIVEAUX_EXPORTABLES_DEFAUT: readonly string[] = ["PUBLIC", "INTERNE", "RESTREINT_PROJET"];
/** Niveaux qui ne sortent JAMAIS en GeoJSON sans derogation ADMIN nominative et a usage unique. */
export const NIVEAUX_SOUS_DEROGATION: readonly string[] = ["CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"];
export const JUSTIFICATION_DEROGATION_MIN = 20;
export const JUSTIFICATION_DEROGATION_MAX = 2000;
export const DUREE_DEROGATION_DEFAUT_H = 24;
export const DUREE_DEROGATION_MAX_H = 168;
export const JEUX_DEROGATION_MAX = 20;
/**
 * Attente bornee cote navigateur : le serveur arrete la fabrication a 50 s au plus (contrat 9.5) et nginx coupe a 60 s ; au-dela de 70 s le
 * navigateur abandonne lui-meme (la tentative est alors consignee ECHEC_ENVOI et une derogation citee est liberee, non consommee).
 */
export const DELAI_EXPORT_NAVIGATEUR_MS = 70_000;

export const FICHIERS_ARCHIVE: readonly { chemin: string; contenu: string }[] = [
  { chemin: "LISEZMOI.txt", contenu: "ce qu'est le dossier (une aide à la décision, aucun ordre) et comment vérifier les empreintes" },
  { chemin: "fiche-projet.json et fiche-projet.pdf", contenu: "le projet et ses jeux non retirés (rôle, format, empreinte, version, statut, confidentialité), en JSON et en PDF texte simple" },
  { chemin: "analyse/agregats.json", contenu: "les totaux de l'analyse 2D sur les seuls jeux autorisés, sans aucune géométrie ni liste d'objets" },
  { chemin: "conflits/dossiers.csv", contenu: "les dossiers de conflit (le même fichier que l'export CSV des conflits)" },
  { chemin: "documents/journal.json et journal.csv", contenu: "les documents du dossier, toutes versions, et leur historique" },
  { chemin: "documents/completude.json", contenu: "ce que les documents disponibles permettent" },
  { chemin: "geojson/", contenu: "le tracé des jeux autorisés d'un niveau exportable seulement (sans les attributs des fichiers source)" },
  { chemin: "manifeste.json et manifeste.sha256", contenu: "l'empreinte SHA-256 de chaque fichier, les jeux inclus et écartés avec leur raison (vérifiable par sha256sum -c)" },
];

export type StatutTentative = "EN_COURS" | "REMIS" | "ECHEC" | "ECHEC_ENVOI";
export const LIBELLE_TENTATIVE: Readonly<Record<StatutTentative, string>> = { EN_COURS: "En cours", REMIS: "Remis", ECHEC: "Échec", ECHEC_ENVOI: "Non reçu (envoi interrompu)" };

export type EtatDerogation = "DISPONIBLE" | "RESERVEE" | "UTILISEE" | "EXPIREE";
export const LIBELLE_ETAT_DEROGATION: Readonly<Record<EtatDerogation, string>> = { DISPONIBLE: "Disponible", RESERVEE: "Réservée par un export en cours", UTILISEE: "Utilisée", EXPIREE: "Expirée" };
export const AIDE_ETAT_DEROGATION: Readonly<Record<EtatDerogation, string>> = {
  DISPONIBLE: "peut servir à un seul export de son bénéficiaire, avant son expiration",
  RESERVEE: "un export en cours la tient ; elle est libérée s'il échoue ou si le téléchargement est interrompu",
  UTILISEE: "a servi à un export : elle est à usage unique",
  EXPIREE: "n'a pas servi avant son expiration ; un administrateur peut en accorder une nouvelle",
};

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export interface PersonneExport { id: string; nomComplet: string | null }

export interface TentativeExport {
  id: string; acteur: PersonneExport | null; statut: StatutTentative | null; codeEchec: string | null; createdAt: string | null; termineLe: string | null;
  sha256: string | null; tailleOctets: number | null; nbFichiers: number | null; nbJeuxGeojson: number | null; derogationId: string | null;
}

export interface Derogation {
  id: string; projetId: string | null; jeuxIds: string[]; beneficiaire: PersonneExport | null; accordeePar: PersonneExport | null; justification: string | null;
  createdAt: string | null; expireLe: string | null; utiliseeLe: string | null; exportId: string | null;
  /** `null` : etat inconnu du client (valeur future) : montre tel quel, jamais assimile a « disponible ». */
  etat: EtatDerogation | null; etatBrut: string | null;
}

export interface ResultatExport { exportId: string | null; sha256: string | null; nbFichiers: number | null; nbJeuxGeojson: number | null; nomFichier: string; tailleOctets: number | null }

export interface Agregat {
  projets: number | null;
  jeux: Record<string, number>;
  conflits: Record<string, number>;
  documentsManquants: { typesObligatoiresNonFournis: number | null; projetsIncomplets: number | null; piecesEnAttente: number | null; piecesEnAttenteParStatut: Record<string, number> | null };
  referentsActifs: { comptes: number | null; rattachements: number | null } | null;
}
export interface Lisibilite { jeux: "TOUS_SAUF_RETIRE" | "AUTORISE_SEULEMENT"; conflits: "TOUS" | "DOSSIERS_VISIBLES"; documentsEnCours: boolean; referents: boolean }
export interface LigneTableau { cle: string; libelle: string; niveau: string | null; agregat: Agregat }
export interface TableauDeBord {
  portee: "NATIONAL" | "TERRITOIRE";
  territoire: { id: string; code: string | null; nom: string; niveau: string | null; ancetres: { id: string; nom: string }[] } | null;
  perimetre: { national: boolean; regions: number[] | null };
  lisibilite: Lisibilite;
  total: Agregat;
  lignes: LigneTableau[];
  rattachesDirectement: Agregat | null;
  nonVentiles: Agregat | null;
  tronque: boolean;
  calculeLe: string | null;
  regle: string | null;
}

// ---------------------------------------------------------------------------------------------------
// Lecteurs
// ---------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const date = (v: unknown): string | null => (typeof v === "string" ? v : null);
const personne = (v: unknown): PersonneExport | null => (estObjet(v) && texte(v.id) ? { id: String(v.id), nomComplet: texte(v.nomComplet) } : null);
const STATUTS_TENTATIVE: readonly StatutTentative[] = ["EN_COURS", "REMIS", "ECHEC", "ECHEC_ENVOI"];
const ETATS_DEROGATION: readonly EtatDerogation[] = ["DISPONIBLE", "RESERVEE", "UTILISEE", "EXPIREE"];

export function lireJournalExports(data: unknown): TentativeExport[] {
  if (!estObjet(data) || !Array.isArray(data.exports)) throw new ReponseInattendue("GET /v2/projets-voirie/:id/export/journal");
  return data.exports.flatMap((x): TentativeExport[] => (estObjet(x) && texte(x.id) ? [{
    id: String(x.id), acteur: personne(x.acteur),
    // Un journal anterieur aux corrections (sans statut) ne contient que des remises.
    statut: (STATUTS_TENTATIVE as readonly string[]).includes(String(x.statut)) ? (x.statut as StatutTentative) : x.statut === undefined && texte(x.sha256) ? "REMIS" : null,
    codeEchec: texte(x.codeEchec), createdAt: date(x.createdAt), termineLe: date(x.termineLe), sha256: texte(x.sha256),
    tailleOctets: versNombre(x.tailleOctets), nbFichiers: versNombre(x.nbFichiers), nbJeuxGeojson: versNombre(x.nbJeuxGeojson), derogationId: texte(x.derogationId),
  }] : []));
}

export function lireDerogation(x: unknown): Derogation | null {
  if (!estObjet(x) || !texte(x.id)) return null;
  const brut = texte(x.etat);
  return {
    id: String(x.id), projetId: texte(x.projetId), jeuxIds: tableau(x.jeuxIds).filter((j): j is string => typeof j === "string"),
    beneficiaire: personne(x.beneficiaire), accordeePar: personne(x.accordeePar), justification: texte(x.justification),
    createdAt: date(x.createdAt), expireLe: date(x.expireLe), utiliseeLe: date(x.utiliseeLe), exportId: texte(x.exportId),
    etat: brut && (ETATS_DEROGATION as readonly string[]).includes(brut) ? (brut as EtatDerogation) : null, etatBrut: brut,
  };
}

export function lireDerogations(data: unknown): Derogation[] {
  if (!estObjet(data) || !Array.isArray(data.derogations)) throw new ReponseInattendue("GET /v2/projets-voirie/:id/export/derogations");
  return data.derogations.flatMap((d) => { const x = lireDerogation(d); return x ? [x] : []; });
}

function nombres(v: unknown): Record<string, number> {
  const s: Record<string, number> = {};
  if (estObjet(v)) for (const [k, n] of Object.entries(v)) { const x = versNombre(n); if (x !== null) s[k] = x; }
  return s;
}

/** Un agregat : un nombre absent ou `null` reste `null` (non communique), il ne devient jamais zero. */
export function lireAgregat(v: unknown): Agregat {
  const a = estObjet(v) ? v : {};
  const dm = estObjet(a.documentsManquants) ? a.documentsManquants : {};
  const r = estObjet(a.referentsActifs) ? a.referentsActifs : null;
  return {
    projets: versNombre(a.projets), jeux: nombres(a.jeux), conflits: nombres(a.conflits),
    documentsManquants: {
      typesObligatoiresNonFournis: versNombre(dm.typesObligatoiresNonFournis), projetsIncomplets: versNombre(dm.projetsIncomplets),
      piecesEnAttente: versNombre(dm.piecesEnAttente), piecesEnAttenteParStatut: estObjet(dm.piecesEnAttenteParStatut) ? nombres(dm.piecesEnAttenteParStatut) : null,
    },
    referentsActifs: r ? { comptes: versNombre(r.comptes), rattachements: versNombre(r.rattachements) } : null,
  };
}

export function lireTableauDeBord(data: unknown): TableauDeBord {
  if (!estObjet(data) || (data.portee !== "NATIONAL" && data.portee !== "TERRITOIRE") || !estObjet(data.total)) throw new ReponseInattendue("GET /v2/projets-voirie/tableau-de-bord");
  const l = estObjet(data.lisibilite) ? data.lisibilite : {};
  // Echec ferme : sans lisibilite explicite, on suppose la plus restreinte (rien de ce qui manque n'est presente comme un zero).
  const lisibilite: Lisibilite = {
    jeux: l.jeux === "TOUS_SAUF_RETIRE" ? "TOUS_SAUF_RETIRE" : "AUTORISE_SEULEMENT", conflits: l.conflits === "TOUS" ? "TOUS" : "DOSSIERS_VISIBLES",
    documentsEnCours: l.documentsEnCours === true, referents: l.referents === true,
  };
  const t = estObjet(data.territoire) && texte(data.territoire.id) ? data.territoire : null;
  const lignes: LigneTableau[] = data.portee === "NATIONAL"
    ? tableau(data.parRegion).flatMap((r) => (estObjet(r) ? [{ cle: r.regionId === null || r.regionId === undefined ? "sans-region" : String(r.regionId), libelle: texte(r.region) ?? (r.regionId === null ? "Sans région" : `Région ${String(r.regionId)}`), niveau: null, agregat: lireAgregat(r) }] : []))
    : tableau(data.enfants).flatMap((e) => (estObjet(e) && texte(e.territoireId) ? [{ cle: String(e.territoireId), libelle: texte(e.nom) ?? texte(e.code) ?? "Territoire sans nom", niveau: texte(e.niveau), agregat: lireAgregat(e) }] : []));
  const p = estObjet(data.perimetre) ? data.perimetre : {};
  return {
    portee: data.portee,
    territoire: t ? {
      id: String(t.id), code: texte(t.code), nom: texte(t.nom) ?? "Territoire sans nom", niveau: texte(t.niveau),
      ancetres: tableau(t.ancetres).flatMap((a) => (estObjet(a) && texte(a.id) ? [{ id: String(a.id), nom: texte(a.nom) ?? "" }] : [])),
    } : null,
    perimetre: { national: p.national === true, regions: Array.isArray(p.regions) ? p.regions.map(versNombre).filter((x): x is number => x !== null) : null },
    lisibilite, total: lireAgregat(data.total), lignes,
    rattachesDirectement: estObjet(data.rattachesDirectement) ? lireAgregat(data.rattachesDirectement) : null,
    nonVentiles: estObjet(data.nonVentiles) ? lireAgregat(data.nonVentiles) : null,
    tronque: data.tronque === true, calculeLe: date(data.calculeLe), regle: texte(data.regle),
  };
}

/** Nom du fichier de `Content-Disposition` (`attachment; filename="..."`), assaini ; sinon le nom par defaut. */
export function nomFichierExport(disposition: unknown, code: string): string {
  const m = typeof disposition === "string" ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  const brut = m ? m[1].trim() : "";
  const propre = brut.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return propre && propre.toLowerCase().endsWith(".zip") ? propre : `dossier-${code.replace(/[^\w.-]+/g, "_").toLowerCase()}.zip`;
}

// ---------------------------------------------------------------------------------------------------
// Regles d'interface
// ---------------------------------------------------------------------------------------------------

export interface JeuApercu { id: string; statut: string; confidentialite: string; libelle: string }
export type RaisonEcartPrevue = "NON_AUTORISE" | "CONFIDENTIALITE" | "GEOJSON_NON_DEMANDE";
export interface ApercuArchive {
  inclus: { jeu: JeuApercu; derogation: boolean }[];
  ecartes: { jeu: JeuApercu; raison: RaisonEcartPrevue }[];
}
export const LIBELLE_RAISON_ECART: Readonly<Record<RaisonEcartPrevue | "NIVEAU_NON_EXPORTABLE", string>> = {
  NON_AUTORISE: "jeu non autorisé : décrit dans la fiche, jamais exporté en GeoJSON",
  CONFIDENTIALITE: "niveau confidentiel : exclu sans dérogation d'un administrateur",
  GEOJSON_NON_DEMANDE: "GeoJSON non demandé",
  NIVEAU_NON_EXPORTABLE: "niveau retiré de la liste des niveaux exportables par le réglage du serveur",
};

/**
 * PREVISION de ce que l'archive contiendra en GeoJSON, selon les regles du contrat (4.3, 5) appliquees aux jeux que la fiche du projet montre deja.
 * Ce n'est pas une decision : le serveur la refait, et son reglage peut encore retirer PUBLIC, INTERNE ou RESTREINT_PROJET. Le manifeste fait foi.
 * Un jeu RETIRE n'apparait nulle part ; un niveau inconnu est traite comme confidentiel (echec ferme, comme le serveur).
 */
export function apercuArchive(jeux: readonly JeuApercu[], o: { geojson: boolean; jeuxDerogation: ReadonlySet<string> }): ApercuArchive {
  const sortie: ApercuArchive = { inclus: [], ecartes: [] };
  for (const j of jeux) {
    if (j.statut === "RETIRE") continue;
    if (j.statut !== "AUTORISE") { sortie.ecartes.push({ jeu: j, raison: "NON_AUTORISE" }); continue; }
    if (!o.geojson) { sortie.ecartes.push({ jeu: j, raison: "GEOJSON_NON_DEMANDE" }); continue; }
    if (NIVEAUX_SOUS_DEROGATION.includes(j.confidentialite)) {
      if (o.jeuxDerogation.has(j.id)) sortie.inclus.push({ jeu: j, derogation: true });
      else sortie.ecartes.push({ jeu: j, raison: "CONFIDENTIALITE" });
    } else if (NIVEAUX_EXPORTABLES_DEFAUT.includes(j.confidentialite)) sortie.inclus.push({ jeu: j, derogation: false });
    else sortie.ecartes.push({ jeu: j, raison: "CONFIDENTIALITE" });
  }
  return sortie;
}

/** Jeux qu'une derogation peut couvrir : AUTORISE et d'un niveau sous derogation (sinon le serveur repond 409 DEROGATION_INUTILE ou JEU_NON_AUTORISE). */
export const jeuDerogeable = (j: Pick<JeuApercu, "statut" | "confidentialite">): boolean => j.statut === "AUTORISE" && NIVEAUX_SOUS_DEROGATION.includes(j.confidentialite);

export interface CompteBeneficiaire { id: string; nom: string | null; email: string | null; role: "ADMIN" | "GESTIONNAIRE"; modules: string[] | null }
/**
 * Beneficiaires proposables : comptes ADMIN et GESTIONNAIRE actifs, AUTRES que l'administrateur qui accorde (separation des taches, 409 du serveur
 * sinon). Un gestionnaire sans la cle du module est montre mais non proposable (422 BENEFICIAIRE_NON_HABILITE). Le perimetre est verifie par le serveur.
 */
export function beneficiairesProposables(comptes: readonly CompteBeneficiaire[], moi: string | null | undefined): { compte: CompteBeneficiaire; proposable: boolean; raison: string | null }[] {
  return comptes.filter((c) => c.id !== moi).map((c) => {
    if (c.role === "GESTIONNAIRE" && c.modules !== null && !c.modules.includes("projets-voirie")) return { compte: c, proposable: false, raison: "sans la clé du module Projets de voirie" };
    return { compte: c, proposable: true, raison: null };
  });
}

export interface ErreursDerogation { erreurs: string[] }
export function verifierSaisieDerogation(s: { jeuxIds: readonly string[]; beneficiaireId: string | null; justification: string; dureeHeures: number | null }, moi: string | null | undefined): string[] {
  const e: string[] = [];
  if (s.jeuxIds.length === 0) e.push("Choisissez au moins un jeu confidentiel à couvrir.");
  if (s.jeuxIds.length > JEUX_DEROGATION_MAX) e.push(`Une dérogation couvre au plus ${JEUX_DEROGATION_MAX} jeux.`);
  if (!s.beneficiaireId) e.push("Choisissez le bénéficiaire : la personne qui fera l'export.");
  else if (moi && s.beneficiaireId === moi) e.push("Vous ne pouvez pas être le bénéficiaire d'une dérogation que vous accordez (séparation des tâches).");
  const n = s.justification.trim().length;
  if (n < JUSTIFICATION_DEROGATION_MIN) e.push(`La justification doit compter au moins ${JUSTIFICATION_DEROGATION_MIN} caractères.`);
  if (n > JUSTIFICATION_DEROGATION_MAX) e.push(`La justification compte au plus ${formaterNombre(JUSTIFICATION_DEROGATION_MAX, 0)} caractères.`);
  if (s.dureeHeures === null || !Number.isInteger(s.dureeHeures) || s.dureeHeures < 1 || s.dureeHeures > DUREE_DEROGATION_MAX_H) e.push(`La durée de validité est un nombre entier d'heures, de 1 à ${DUREE_DEROGATION_MAX_H} (7 jours).`);
  return e;
}

/** Derogations qui visent ce compte, utilisables maintenant (etat DISPONIBLE rendu par le serveur : son horloge, jamais celle du navigateur). */
export const derogationsUtilisables = (ds: readonly Derogation[], moi: string | null | undefined): Derogation[] => ds.filter((d) => !!moi && d.beneficiaire?.id === moi && d.etat === "DISPONIBLE");

export const MOTIF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NON_COMMUNIQUE = "Non communiqué à votre rôle";
/** Valeur d'agregat : `null` n'est jamais zero. */
export const valeurAgregat = (n: number | null | undefined): string => (typeof n === "number" ? formaterNombre(n, 0) : NON_COMMUNIQUE);

export const STATUTS_JEU_TABLEAU: readonly string[] = ["RECU", "CONTROLE", "AUTORISE", "REJETE", "REMPLACE"];
/**
 * Jeux par statut a afficher. Decideur (`TOUS_SAUF_RETIRE`) : chaque statut, 0 s'il est absent. Autre compte (`AUTORISE_SEULEMENT`) : AUTORISE seul est
 * compte ; les autres statuts sont « non communiques » (`null`), jamais zero (il n'en sait rien). Les statuts inconnus du client sont montres tels quels.
 */
export function jeuxParStatut(a: Agregat, l: Lisibilite): { statut: string; n: number | null }[] {
  const connus = STATUTS_JEU_TABLEAU.map((s) => ({ statut: s, n: l.jeux === "TOUS_SAUF_RETIRE" || s === "AUTORISE" ? a.jeux[s] ?? 0 : null }));
  const autres = Object.keys(a.jeux).filter((s) => !STATUTS_JEU_TABLEAU.includes(s) && s !== "RETIRE").map((s) => ({ statut: s, n: a.jeux[s] }));
  return [...connus, ...autres];
}

export const totalJeux = (a: Agregat): number => Object.entries(a.jeux).filter(([s]) => s !== "RETIRE").reduce((t, [, n]) => t + n, 0);

// ---------------------------------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------------------------------

const RIEN = " Rien n'a été modifié.";
const AUCUNE_ARCHIVE = " Aucune archive n'a été remise.";

export const MESSAGE_CODE_EXPORTS: Record<string, string> = {
  PARAMETRES_INVALIDES: "Les paramètres de la demande sont refusés par le serveur." + AUCUNE_ARCHIVE,
  CHAMPS_INVALIDES: "Les valeurs envoyées sont refusées par le serveur (identifiant invalide, durée hors bornes, champ inconnu). Vérifiez la saisie." + RIEN,
  JUSTIFICATION_INVALIDE: `Une dérogation exige une justification d'au moins ${JUSTIFICATION_DEROGATION_MIN} caractères.` + RIEN,
  PROJET_INTROUVABLE: "Projet introuvable : il n'existe pas, a été retiré, ou n'est pas dans votre périmètre.",
  JEU_INTROUVABLE: "Un des jeux choisis est introuvable dans ce projet (retiré, ou d'un autre projet)." + RIEN,
  DEROGATION_INTROUVABLE: "Dérogation introuvable pour ce projet et votre compte : vérifiez l'identifiant communiqué par l'administrateur (une dérogation ne sert qu'à son bénéficiaire, sur son projet)." + AUCUNE_ARCHIVE,
  DEROGATION_INDISPONIBLE: "Cette dérogation n'est plus utilisable." + AUCUNE_ARCHIVE,
  DEROGATION_INUTILE: "Un des jeux choisis n'est pas d'un niveau confidentiel : il s'exporte sans dérogation. Une dérogation ne couvre que les jeux « confidentiel concessionnaire » ou « infrastructure sensible »." + RIEN,
  JEU_NON_AUTORISE: "Seul un jeu autorisé peut être couvert par une dérogation (et exporté) : autorisez-le d'abord." + RIEN,
  SEPARATION_DES_TACHES: "Séparation des tâches : l'administrateur qui accorde une dérogation n'en est jamais le bénéficiaire. Choisissez une autre personne." + RIEN,
  BENEFICIAIRE_NON_HABILITE: "Le bénéficiaire doit être un compte actif, administrateur ou gestionnaire, portant la clé du module Projets de voirie." + RIEN,
  BENEFICIAIRE_HORS_PERIMETRE: "Le périmètre du bénéficiaire ne couvre pas la région de ce projet : choisissez un compte de cette région, ou un compte national." + RIEN,
  EXPORT_TROP_VOLUMINEUX: "Le dossier dépasse les bornes de l'export." + AUCUNE_ARCHIVE,
  EXPORT_TROP_LONG: "La fabrication du dossier a dépassé le délai autorisé et a été interrompue. Réessayez sans GeoJSON, ou demandez à un administrateur de retirer des jeux volumineux." + AUCUNE_ARCHIVE,
  EXPORT_TROP_FREQUENT: "Vous avez demandé trop de dossiers en peu de temps (chaque tentative compte, même en échec)." + AUCUNE_ARCHIVE,
  SERVICE_OCCUPE: "Le serveur fabrique déjà d'autres dossiers, ou un export de votre compte est en cours : attendez sa fin puis réessayez." + AUCUNE_ARCHIVE,
  PROJET_OCCUPE: "Ce projet est occupé par une autre écriture : réessayez dans quelques secondes." + RIEN,
  TABLEAU_DE_BORD_TROP_FREQUENT: "Trop de tableaux de bord demandés en peu de temps.",
  TABLEAU_DE_BORD_TROP_LONG: "Le calcul du tableau de bord a dépassé le délai autorisé : réessayez dans un instant.",
  TERRITOIRE_INTROUVABLE: "Territoire introuvable : il n'existe pas, a été retiré, ou n'est pas dans votre périmètre.",
  CONFIDENTIALITE_ABAISSEMENT_RESERVE: "Abaisser le niveau de confidentialité d'un jeu est réservé à un administrateur." + RIEN,
  IDENTIFIANT_INVALIDE: "L'identifiant demandé n'est pas valide (lien tronqué ou modifié).",
};

const secondes = (n: number) => `${n} seconde${n > 1 ? "s" : ""}`;

/** Erreurs des tableaux de bord : memes codes, sans les mentions propres a l'archive. */
export function classerErreurTableau(e: unknown): ErreurPv {
  const x = classerErreurExports(e);
  const attente = x.retryAfterS ? ` Réessayez dans ${secondes(x.retryAfterS)}.` : " Réessayez dans quelques instants.";
  if (x.code === "SERVICE_OCCUPE") return { ...x, message: `Le serveur calcule déjà d'autres tableaux de bord.${attente}` };
  if (x.status === 504 && x.code !== "TABLEAU_DE_BORD_TROP_LONG") return { ...x, message: "Le serveur a mis trop de temps à répondre : réessayez dans un instant." };
  if (x.code === "PARAMETRES_INVALIDES") return { ...x, message: "Les paramètres de la demande sont refusés par le serveur." };
  return x;
}

export function classerErreurExports(e: unknown): ErreurPv {
  const base = classerErreur(e);
  const corps = (() => { const r = estObjet(e) ? (e as Obj).response : null; return estObjet(r) && estObjet(r.data) ? r.data : {}; })();
  const code = base.code;
  if (code && MESSAGE_CODE_EXPORTS[code]) {
    const genre: GenreErreur = base.status === 409 ? "conflit" : base.status === 404 ? "introuvable" : base.status === 403 ? "droit"
      : base.status === 429 || base.status === 503 || base.status === 504 ? "serveur" : "validation";
    let message = MESSAGE_CODE_EXPORTS[code];
    if (code === "DEROGATION_INDISPONIBLE") {
      const etat = texte(corps.etat);
      message = etat === "UTILISEE" ? "Cette dérogation a déjà servi à un export : elle est à usage unique. Demandez-en une nouvelle à un administrateur." + AUCUNE_ARCHIVE
        : etat === "EXPIREE" ? "Cette dérogation a expiré : demandez-en une nouvelle à un administrateur." + AUCUNE_ARCHIVE
          : etat === "RESERVEE" ? "Cette dérogation est réservée par un export en cours : attendez sa fin (elle sera libérée s'il échoue ou si son téléchargement est interrompu)." + AUCUNE_ARCHIVE
            : message;
    }
    if (code === "EXPORT_TROP_VOLUMINEUX") {
      const n = (k: string) => versNombre(corps[k]);
      const detail: string[] = [];
      if (n("objets") !== null && n("objetsMax") !== null) detail.push(`${formaterNombre(n("objets") as number, 0)} objets pour ${formaterNombre(n("objetsMax") as number, 0)} au plus`);
      if (n("sommets") !== null && n("sommetsMax") !== null) detail.push(`${formaterNombre(n("sommets") as number, 0)} sommets pour ${formaterNombre(n("sommetsMax") as number, 0)} au plus`);
      const oct = n("octets") ?? n("octetsEstimes");
      if (oct !== null && n("octetsMax") !== null) detail.push(`${formaterTaille(oct)}${n("octetsEstimes") !== null && n("octets") === null ? " estimés" : ""} pour ${formaterTaille(n("octetsMax") as number)} au plus (fichiers non compressés)`);
      message = `Le dossier dépasse les bornes de l'export${detail.length ? ` : ${detail.join(" ; ")}` : ""}. Réessayez sans GeoJSON (les tracés sont le plus gros), ou demandez à un administrateur de retirer des jeux.${AUCUNE_ARCHIVE}`;
    }
    if ((code === "EXPORT_TROP_FREQUENT" || code === "TABLEAU_DE_BORD_TROP_FREQUENT" || code === "SERVICE_OCCUPE") && base.retryAfterS) message += ` Réessayez dans ${secondes(base.retryAfterS)}.`;
    return { ...base, genre, message };
  }
  if (base.status === 429) return { ...base, genre: "serveur", message: `Trop de demandes en peu de temps.${base.retryAfterS ? ` Réessayez dans ${secondes(base.retryAfterS)}.` : ""}` };
  if (base.status === 504) return { ...base, genre: "serveur", message: "Le serveur a mis trop de temps à répondre (délai du mandataire dépassé)." + AUCUNE_ARCHIVE };
  if (base.status === null && base.genre === "reseau" && estObjet(e) && (e as Obj).code === "ECONNABORTED") {
    return { ...base, genre: "serveur", code: "DELAI_NAVIGATEUR", message: `Le navigateur a cessé d'attendre après ${DELAI_EXPORT_NAVIGATEUR_MS / 1000} secondes. La tentative est consignée « non reçue » ; une dérogation citée est libérée, non consommée.` };
  }
  return base;
}
