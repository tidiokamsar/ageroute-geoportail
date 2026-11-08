import { classerErreur, versNombre, type ErreurPv, type GenreErreur } from "./projetsVoirie";
import { classerErreurConflit, justificationValide } from "./projetsVoirieConflits";

/**
 * Echanges avec les concessionnaires (lot B3, interface) : constantes d'affichage et fonctions pures.
 * Contrat : docs/projets-voirie/CONTRAT-WORKFLOW.md ; reponses : docs/projets-voirie/API.md, section « Workflow concessionnaire, referents et recolement (lot B3) ».
 *
 * Rien ici ne touche le reseau, le DOM ni un stockage local. Regles de ce module :
 *   - L'APPLICATION N'ENVOIE RIEN : l'envoi d'une demande se fait hors application, par une personne ; l'application l'ENREGISTRE (canal, date, reference, interlocuteur) ;
 *   - une preuve est une REFERENCE et une EMPREINTE : jamais un fichier ; une reference est toujours du texte, jamais un lien suivi ;
 *   - valider un recolement ou une tache exige un TIERS (separation des taches), sauf derogation motivee d'un administrateur ;
 *   - aucune action n'est proposee hors de ce que le serveur renvoie (`droits`, `transitionsPossibles`) ; aucun ordre, deplacement ni message n'est propose.
 */

export type ProfilEffectif = "ADMIN" | "GESTIONNAIRE" | "INSPECTEUR" | "LECTEUR" | "REFERENT";
export type ActionWorkflow = "referent.gerer" | "referent.lire" | "workflow.lire" | "demande.ecrire" | "tache.gerer" | "tache.executer" | "preuve.ajouter" | "recolement.ecrire" | "recolement.valider";
export type StatutDemande = "BROUILLON" | "ENVOYEE" | "RECUE" | "CLOTUREE" | "ANNULEE";
export type StatutTache = "A_FAIRE" | "EN_COURS" | "A_VALIDER" | "TERMINEE" | "ANNULEE";
export type PrioriteTache = "BASSE" | "NORMALE" | "HAUTE" | "URGENTE";
export type StatutRecolement = "BROUILLON" | "SOUMIS" | "VALIDE" | "REJETE";
export type TypePreuveWorkflow = "NOTE" | "REFERENCE_DOCUMENT" | "COURRIER" | "REPONSE_CONCESSIONNAIRE" | "PLAN_RECOLEMENT" | "RELEVE_TERRAIN";
export type ObjetWorkflow = "DEMANDE" | "TACHE" | "RECOLEMENT";

export const PROFILS: readonly ProfilEffectif[] = ["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "LECTEUR", "REFERENT"];
export const ACTIONS_WORKFLOW: readonly ActionWorkflow[] = ["referent.gerer", "referent.lire", "workflow.lire", "demande.ecrire", "tache.gerer", "tache.executer", "preuve.ajouter", "recolement.ecrire", "recolement.valider"];
export const STATUTS_DEMANDE: readonly StatutDemande[] = ["BROUILLON", "ENVOYEE", "RECUE", "CLOTUREE", "ANNULEE"];
export const STATUTS_TACHE: readonly StatutTache[] = ["A_FAIRE", "EN_COURS", "A_VALIDER", "TERMINEE", "ANNULEE"];
export const PRIORITES_TACHE: readonly PrioriteTache[] = ["BASSE", "NORMALE", "HAUTE", "URGENTE"];
export const STATUTS_RECOLEMENT: readonly StatutRecolement[] = ["BROUILLON", "SOUMIS", "VALIDE", "REJETE"];
export const TYPES_PREUVE_WORKFLOW: readonly TypePreuveWorkflow[] = ["NOTE", "REFERENCE_DOCUMENT", "COURRIER", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT", "RELEVE_TERRAIN"];
export const STATUTS_DEMANDE_TERMINAUX: readonly StatutDemande[] = ["CLOTUREE", "ANNULEE"];
export const STATUTS_TACHE_TERMINAUX: readonly StatutTache[] = ["TERMINEE", "ANNULEE"];

export const LIBELLE_PROFIL: Readonly<Record<ProfilEffectif, string>> = {
  ADMIN: "Administrateur", GESTIONNAIRE: "Gestionnaire de projet", INSPECTEUR: "Agent de terrain (inspecteur)", LECTEUR: "Lecteur", REFERENT: "Référent concessionnaire",
};

/** Ce que chaque droit permet, en clair. Seuls les droits RENVOYES par le serveur sont affiches : l'interface n'en propose aucun autre. */
export const LIBELLE_ACTION_WORKFLOW: Readonly<Record<ActionWorkflow, string>> = {
  "referent.gerer": "Poser ou révoquer le rattachement d'un référent concessionnaire",
  "referent.lire": "Lister les rattachements des référents d'un projet",
  "workflow.lire": "Lire les demandes, les tâches, les récolements, les jeux et les dossiers de conflit (vue concessionnaire)",
  "demande.ecrire": "Créer et modifier une demande, enregistrer son envoi, sa réception, sa clôture ou son annulation",
  "tache.gerer": "Créer, modifier, réaffecter, annuler et valider une tâche",
  "tache.executer": "Faire avancer sa propre tâche",
  "preuve.ajouter": "Ajouter une preuve (référence et empreinte, jamais un fichier)",
  "recolement.ecrire": "Créer, modifier, soumettre ou retirer un récolement",
  "recolement.valider": "Valider ou rejeter un récolement soumis par un autre",
};

export const MENTION_AUCUN_ENVOI = "L'application n'envoie rien : l'envoi d'une demande se fait hors application (courriel, courrier, remise en main propre) par une personne. Enregistrez-le ici une fois fait.";
export const LIBELLE_ENVOI_HORS_APPLICATION = "L'envoi se fait hors application, enregistrez-le ici";
export const MENTION_PREUVES = "Une preuve est une référence (texte) et une empreinte SHA-256 : l'application ne stocke aucun fichier et n'ouvre ni ne suit jamais une référence.";
export const MENTION_RECOLEMENT = "Valider un récolement atteste le dossier : il ne met à jour ni le référentiel officiel, ni un jeu de données, ni le dossier de conflit lié. Un jeu reçu passe toujours par le dépôt, la quarantaine et l'autorisation.";
export const RAPPEL_SEPARATION_WORKFLOW = "Séparation des tâches : la validation exige un tiers. Seul un administrateur peut accorder une dérogation, avec un motif, tracée dans l'historique et l'audit.";
export const BANDEAU_WORKFLOW = "Cet écran enregistre des échanges faits hors application : il n'envoie aucun message, ne donne aucun ordre, ne déplace aucun réseau et ne modifie ni le référentiel officiel ni les jeux de données.";

export const LIBELLE_STATUT_DEMANDE: Readonly<Record<StatutDemande, string>> = { BROUILLON: "Brouillon", ENVOYEE: "Envoyée (enregistrée)", RECUE: "Réponse reçue", CLOTUREE: "Clôturée", ANNULEE: "Annulée" };
export const LIBELLE_STATUT_TACHE: Readonly<Record<StatutTache, string>> = { A_FAIRE: "À faire", EN_COURS: "En cours", A_VALIDER: "À valider", TERMINEE: "Terminée", ANNULEE: "Annulée" };
export const LIBELLE_PRIORITE: Readonly<Record<PrioriteTache, string>> = { BASSE: "Priorité basse", NORMALE: "Priorité normale", HAUTE: "Priorité haute", URGENTE: "Priorité urgente" };
export const LIBELLE_STATUT_RECOLEMENT: Readonly<Record<StatutRecolement, string>> = { BROUILLON: "Brouillon", SOUMIS: "Soumis", VALIDE: "Validé", REJETE: "Rejeté" };
export const LIBELLE_TYPE_PREUVE_WORKFLOW: Readonly<Record<TypePreuveWorkflow, string>> = {
  NOTE: "Note", REFERENCE_DOCUMENT: "Référence de document", COURRIER: "Courrier", REPONSE_CONCESSIONNAIRE: "Réponse du concessionnaire", PLAN_RECOLEMENT: "Plan de récolement", RELEVE_TERRAIN: "Relevé de terrain",
};

export type FormeWorkflow = "crayon" | "sablier" | "coche" | "croix" | "barre" | "boite" | "alerte" | "cadenas" | "fleche";
export interface StyleWorkflow { libelle: string; aide: string; forme: FormeWorkflow; classes: string }

const AMBRE = "border-amber-400 bg-amber-100 text-amber-900";
const VERT = "border-green-400 bg-green-50 text-green-900";
const ROUGE = "border-red-300 bg-red-50 text-red-900";
const GRIS = "border-gray-400 bg-gray-100 text-gray-800";
const BLEU = "border-blue-300 bg-blue-50 text-blue-900";

export const STYLE_STATUT_DEMANDE: Readonly<Record<StatutDemande, StyleWorkflow>> = {
  BROUILLON: { libelle: "Brouillon", forme: "crayon", classes: GRIS, aide: "Préparée, pas encore envoyée : l'envoi se fait hors application, puis s'enregistre ici." },
  ENVOYEE: { libelle: "Envoyée (enregistrée)", forme: "sablier", classes: AMBRE, aide: "Une personne a envoyé la demande hors application et l'a enregistrée. Le concessionnaire n'a pas encore répondu." },
  RECUE: { libelle: "Réponse reçue", forme: "boite", classes: BLEU, aide: "Une réponse est arrivée hors application. Un jeu reçu reste en quarantaine jusqu'à son autorisation." },
  CLOTUREE: { libelle: "Clôturée", forme: "cadenas", classes: VERT, aide: "Demande close, avec un motif. Elle ne change plus." },
  ANNULEE: { libelle: "Annulée", forme: "barre", classes: GRIS, aide: "Demande abandonnée, avec un motif. Elle ne change plus." },
};
export const STYLE_STATUT_TACHE: Readonly<Record<StatutTache, StyleWorkflow>> = {
  A_FAIRE: { libelle: "À faire", forme: "crayon", classes: GRIS, aide: "Pas encore commencée." },
  EN_COURS: { libelle: "En cours", forme: "fleche", classes: BLEU, aide: "Commencée par son responsable." },
  A_VALIDER: { libelle: "À valider", forme: "sablier", classes: AMBRE, aide: "Terminée par son responsable, en attente de validation par un tiers." },
  TERMINEE: { libelle: "Terminée", forme: "coche", classes: VERT, aide: "Terminée. Elle ne change plus." },
  ANNULEE: { libelle: "Annulée", forme: "barre", classes: GRIS, aide: "Abandonnée, avec un motif. Elle ne change plus." },
};
export const STYLE_STATUT_RECOLEMENT: Readonly<Record<StatutRecolement, StyleWorkflow>> = {
  BROUILLON: { libelle: "Brouillon", forme: "crayon", classes: GRIS, aide: "En préparation : modifiable avec une justification, historisée avant et après." },
  SOUMIS: { libelle: "Soumis", forme: "sablier", classes: AMBRE, aide: "Soumis à la validation d'un tiers : plus modifiable." },
  VALIDE: { libelle: "Validé", forme: "coche", classes: VERT, aide: "Validé par un tiers. Il ne se corrige pas : un nouveau récolement le remplace." },
  REJETE: { libelle: "Rejeté", forme: "croix", classes: ROUGE, aide: "Rejeté avec un motif : il peut être rouvert en brouillon." },
};
export const CLASSES_PRIORITE: Readonly<Record<PrioriteTache, string>> = {
  BASSE: "border-gray-400 bg-white text-gray-900", NORMALE: "border-gray-400 bg-white text-gray-900", HAUTE: "border-amber-400 bg-amber-50 text-amber-900 border-2", URGENTE: "border-red-400 bg-red-50 text-red-900 border-2",
};

/** Libelle du bouton d'une transition de tache : un verbe d'etat, jamais un verbe d'execution ou d'ordre. */
export function libelleTransitionTache(de: StatutTache, vers: StatutTache): string {
  if (vers === "EN_COURS") return de === "A_VALIDER" ? "Refuser la validation (retour en cours)" : "Commencer la tâche";
  if (vers === "A_VALIDER") return "Soumettre à validation";
  if (vers === "TERMINEE") return de === "A_VALIDER" ? "Valider la tâche (par un tiers)" : "Terminer la tâche";
  if (vers === "ANNULEE") return "Annuler la tâche";
  return "Remettre à faire";
}
export function libelleTransitionRecolement(de: StatutRecolement, vers: StatutRecolement): string {
  if (vers === "SOUMIS") return "Soumettre pour validation";
  if (vers === "VALIDE") return "Valider le récolement (par un tiers)";
  if (vers === "REJETE") return "Rejeter le récolement";
  return de === "REJETE" ? "Rouvrir en brouillon" : "Retirer la soumission";
}
export function libelleTransitionDemande(vers: StatutDemande): string {
  if (vers === "ENVOYEE") return "Enregistrer l'envoi (fait hors application)";
  if (vers === "RECUE") return "Enregistrer la réception de la réponse";
  if (vers === "CLOTUREE") return "Clore la demande";
  if (vers === "ANNULEE") return "Annuler la demande";
  return "Remettre en brouillon";
}

// ---------------------------------------------------------------------------------------------------
// Droits
// ---------------------------------------------------------------------------------------------------

/** Vrai si le serveur a renvoye ce droit pour le compte. Aucun droit n'est suppose. */
export const aLeDroit = (droits: readonly ActionWorkflow[] | null | undefined, a: ActionWorkflow): boolean => !!droits && droits.includes(a);

export type SectionWorkflow = "profil" | "demandes" | "taches" | "recolements" | "dossiers" | "referents";
export const LIBELLE_SECTION: Readonly<Record<SectionWorkflow, string>> = {
  profil: "Mon profil", demandes: "Demandes", taches: "Tâches", recolements: "Récolements", dossiers: "Dossiers et jeux", referents: "Référents",
};

/** Sections ouvertes pour ces droits : seules celles dont le serveur ouvre la lecture. « Mon profil » est toujours la. */
export function sectionsOuvertes(droits: readonly ActionWorkflow[] | null | undefined): SectionWorkflow[] {
  const lire = aLeDroit(droits, "workflow.lire");
  const s: SectionWorkflow[] = ["profil"];
  if (lire) s.push("demandes");
  if (lire || aLeDroit(droits, "tache.executer")) s.push("taches");
  if (lire) s.push("recolements", "dossiers");
  if (aLeDroit(droits, "referent.lire")) s.push("referents");
  return s;
}

// ---------------------------------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------------------------------

export const LIMITE_WORKFLOW = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const estUuid = (s: string): boolean => UUID.test(s);

export interface FiltresDemandes { statut: StatutDemande | ""; concessionnaireId: string; echeanceDepassee: boolean }
export const FILTRES_DEMANDES_VIDES: FiltresDemandes = { statut: "", concessionnaireId: "", echeanceDepassee: false };
export function paramsDemandes(f: FiltresDemandes, curseur: string | null): Record<string, string | number> {
  const p: Record<string, string | number> = { limite: LIMITE_WORKFLOW };
  if (f.statut) p.statut = f.statut;
  if (f.concessionnaireId && estUuid(f.concessionnaireId)) p.concessionnaireId = f.concessionnaireId;
  if (f.echeanceDepassee) p.echeanceDepassee = "true";
  if (curseur) p.curseur = curseur;
  return p;
}

export interface FiltresTaches { statut: StatutTache | ""; responsableId: string; echeanceDepassee: boolean }
export const FILTRES_TACHES_VIDES: FiltresTaches = { statut: "", responsableId: "", echeanceDepassee: false };
export function paramsTaches(f: FiltresTaches, curseur: string | null): Record<string, string | number> {
  const p: Record<string, string | number> = { limite: LIMITE_WORKFLOW };
  if (f.statut) p.statut = f.statut;
  if (f.responsableId && estUuid(f.responsableId)) p.responsableId = f.responsableId;
  if (f.echeanceDepassee) p.echeanceDepassee = "true";
  if (curseur) p.curseur = curseur;
  return p;
}

export interface FiltresRecolements { statut: StatutRecolement | "" }
export const FILTRES_RECOLEMENTS_VIDES: FiltresRecolements = { statut: "" };
export function paramsRecolements(f: FiltresRecolements, curseur: string | null): Record<string, string | number> {
  const p: Record<string, string | number> = { limite: LIMITE_WORKFLOW };
  if (f.statut) p.statut = f.statut;
  if (curseur) p.curseur = curseur;
  return p;
}

// ---------------------------------------------------------------------------------------------------
// Dates et saisies
// ---------------------------------------------------------------------------------------------------

/** Aujourd'hui en UTC, AAAA-MM-JJ (comme le serveur : « pas dans le futur » se juge sur la date UTC). */
export const aujourdhuiUtc = (maintenant: Date = new Date()): string => maintenant.toISOString().slice(0, 10);

export function jourValide(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
}

const dit = (liste: string[], ok: boolean, message: string) => { if (!ok) liste.push(message); };

export interface SaisieDemande { concessionnaireId: string; objet: string; description: string; echeance: string }
export function erreursDemande(s: SaisieDemande, creation: boolean): string[] {
  const e: string[] = [];
  if (creation) dit(e, estUuid(s.concessionnaireId), "Choisissez le concessionnaire.");
  dit(e, s.objet.trim().length >= 1, "L'objet de la demande est obligatoire.");
  dit(e, s.objet.trim().length <= 200, "L'objet fait 200 caractères au plus.");
  dit(e, s.description.length <= 4000, "La description fait 4 000 caractères au plus.");
  dit(e, s.echeance === "" || jourValide(s.echeance), "L'échéance doit être une date valide.");
  return e;
}

export interface SaisieEnvoi { canalEnvoi: string; dateEnvoi: string; referenceEnvoi: string; interlocuteur: string }
/** Enregistrement de l'envoi : canal obligatoire, date obligatoire et pas dans le futur. Aucun message n'est emis. */
export function erreursEnvoi(s: SaisieEnvoi, aujourdhui: string = aujourdhuiUtc()): string[] {
  const e: string[] = [];
  dit(e, s.canalEnvoi.trim().length >= 1, "Indiquez le canal de l'envoi (courriel, courrier, remise en main propre...).");
  dit(e, s.canalEnvoi.trim().length <= 100, "Le canal fait 100 caractères au plus.");
  if (!s.dateEnvoi) e.push("Indiquez la date de l'envoi.");
  else if (!jourValide(s.dateEnvoi)) e.push("La date de l'envoi doit être une date valide.");
  else if (s.dateEnvoi > aujourdhui) e.push("La date de l'envoi ne peut pas être dans le futur : on enregistre un envoi déjà fait.");
  dit(e, s.referenceEnvoi.length <= 200, "La référence fait 200 caractères au plus.");
  dit(e, s.interlocuteur.length <= 200, "L'interlocuteur fait 200 caractères au plus.");
  return e;
}

export interface SaisieReception { dateReception: string; jeuRecuId: string; note: string }
export function erreursReception(s: SaisieReception, dateEnvoi: string | null, aujourdhui: string = aujourdhuiUtc()): string[] {
  const e: string[] = [];
  if (!s.dateReception) e.push("Indiquez la date de réception de la réponse.");
  else if (!jourValide(s.dateReception)) e.push("La date de réception doit être une date valide.");
  else {
    if (s.dateReception > aujourdhui) e.push("La date de réception ne peut pas être dans le futur.");
    if (dateEnvoi && s.dateReception < dateEnvoi) e.push("La réponse ne peut pas être reçue avant l'envoi.");
  }
  dit(e, s.jeuRecuId === "" || estUuid(s.jeuRecuId), "Le jeu reçu choisi n'est pas valide.");
  dit(e, s.note.length <= 2000, "La note fait 2 000 caractères au plus.");
  return e;
}

export interface SaisieTache {
  titre: string; description: string; responsableId: string; echeance: string; priorite: PrioriteTache; validationRequise: boolean;
  lien: "AUCUN" | "DEMANDE" | "CONFLIT"; demandeId: string; conflitId: string; partagee: boolean;
}
export const SAISIE_TACHE_VIDE: SaisieTache = {
  titre: "", description: "", responsableId: "", echeance: "", priorite: "NORMALE", validationRequise: false, lien: "AUCUN", demandeId: "", conflitId: "", partagee: false,
};
export function erreursTache(s: SaisieTache): string[] {
  const e: string[] = [];
  dit(e, s.titre.trim().length >= 1, "Le titre de la tâche est obligatoire.");
  dit(e, s.titre.trim().length <= 200, "Le titre fait 200 caractères au plus.");
  dit(e, s.description.length <= 4000, "La description fait 4 000 caractères au plus.");
  dit(e, estUuid(s.responsableId.trim()), "Choisissez le responsable (ou saisissez son identifiant de compte, un UUID).");
  dit(e, s.echeance === "" || jourValide(s.echeance), "L'échéance doit être une date valide.");
  if (s.lien === "DEMANDE") dit(e, estUuid(s.demandeId), "Choisissez la demande liée.");
  if (s.lien === "CONFLIT") dit(e, estUuid(s.conflitId), "Choisissez le dossier de conflit lié.");
  return e;
}

export interface SaisieRecolement { lien: "CONFLIT" | "JEU" | "LES_DEUX"; conflitId: string; jeuId: string; objet: string; constat: string; ecarts: string; dateRecolement: string }
export const SAISIE_RECOLEMENT_VIDE: SaisieRecolement = { lien: "CONFLIT", conflitId: "", jeuId: "", objet: "", constat: "", ecarts: "", dateRecolement: "" };
export function erreursRecolement(s: SaisieRecolement, creation: boolean): string[] {
  const e: string[] = [];
  if (creation) {
    if (s.lien !== "JEU") dit(e, estUuid(s.conflitId), "Choisissez le dossier de conflit dont un déplacement est décidé.");
    if (s.lien !== "CONFLIT") dit(e, estUuid(s.jeuId), "Choisissez le jeu reçu auquel se rattache le récolement.");
  }
  dit(e, s.objet.trim().length >= 1, "L'objet du récolement est obligatoire.");
  dit(e, s.objet.trim().length <= 200, "L'objet fait 200 caractères au plus.");
  dit(e, s.constat.length <= 4000, "Le constat fait 4 000 caractères au plus.");
  dit(e, s.ecarts.length <= 4000, "Les écarts font 4 000 caractères au plus.");
  dit(e, s.dateRecolement === "" || jourValide(s.dateRecolement), "La date du récolement doit être une date valide.");
  return e;
}

/** Soumettre exige un objet et un constat renseignes (422 CHAMPS_INCOMPLETS sinon) : dit AVANT l'envoi. */
export function manquePourSoumettre(r: { objet: string | null; constat: string | null }): string[] {
  const m: string[] = [];
  if (!r.objet?.trim()) m.push("l'objet");
  if (!r.constat?.trim()) m.push("le constat");
  return m;
}

// ---------------------------------------------------------------------------------------------------
// Preuves : references et empreintes, jamais un fichier
// ---------------------------------------------------------------------------------------------------

/** Une reference qui commence par l'un de ces schemas est refusee (400 REFERENCE_INVALIDE) ; elle n'est de toute facon jamais suivie. */
const SCHEMAS_REFUSES = /^\s*(javascript|data|vbscript|file)\s*:/i;
export const referenceDangereuse = (ref: string): boolean => SCHEMAS_REFUSES.test(ref);
const SHA256 = /^[0-9a-f]{64}$/i;

export interface SaisiePreuve { type: TypePreuveWorkflow; texte: string; reference: string; nomFichier: string; sha256: string; tailleOctets: string; partagee: boolean }
export const SAISIE_PREUVE_VIDE: SaisiePreuve = { type: "NOTE", texte: "", reference: "", nomFichier: "", sha256: "", tailleOctets: "", partagee: false };

/** Types de preuve permis par profil (CONTRAT-WORKFLOW.md, 5.4). Le serveur revalide. */
export function typesPreuvePermis(profil: ProfilEffectif | null): readonly TypePreuveWorkflow[] {
  if (profil === "INSPECTEUR") return ["NOTE", "REFERENCE_DOCUMENT", "RELEVE_TERRAIN"];
  if (profil === "REFERENT") return ["NOTE", "REFERENCE_DOCUMENT", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT"];
  return TYPES_PREUVE_WORKFLOW;
}
/** Visibilite imposee : un referent partage toujours (`true`), un agent de terrain jamais (`false`) ; un decideur choisit (`null`). */
export function partageeImposee(profil: ProfilEffectif | null): boolean | null {
  return profil === "REFERENT" ? true : profil === "INSPECTEUR" ? false : null;
}

export function erreursPreuve(s: SaisiePreuve): string[] {
  const e: string[] = [];
  dit(e, s.texte.trim().length >= 1, "Le texte de la preuve est obligatoire (ce que la pièce atteste et où la retrouver).");
  dit(e, s.texte.trim().length <= 4000, "Le texte fait 4 000 caractères au plus.");
  if (s.reference.trim()) {
    dit(e, s.reference.length <= 500, "La référence fait 500 caractères au plus.");
    dit(e, !referenceDangereuse(s.reference), "Une référence ne peut pas commencer par javascript:, data:, vbscript: ou file: : c'est du texte qui localise la pièce, jamais un lien exécutable.");
  }
  dit(e, s.nomFichier.length <= 255, "Le nom du fichier fait 255 caractères au plus.");
  dit(e, s.sha256.trim() === "" || SHA256.test(s.sha256.trim()), "L'empreinte SHA-256 s'écrit sur 64 caractères hexadécimaux.");
  const t = s.tailleOctets.trim();
  dit(e, t === "" || (/^\d+$/.test(t) && Number(t) <= 2_147_483_647), "La taille déclarée est un nombre entier d'octets.");
  return e;
}

export interface CorpsPreuveWorkflow {
  type: TypePreuveWorkflow; texte: string; reference: string | null; nomFichier: string | null; sha256: string | null; tailleOctets: number | null; partagee?: boolean;
}
export function corpsPreuve(s: SaisiePreuve, profil: ProfilEffectif | null): CorpsPreuveWorkflow {
  const imposee = partageeImposee(profil);
  return {
    type: s.type, texte: s.texte.trim(), reference: s.reference.trim() || null, nomFichier: s.nomFichier.trim() || null, sha256: s.sha256.trim().toLowerCase() || null,
    tailleOctets: s.tailleOctets.trim() === "" ? null : Number(s.tailleOctets.trim()), partagee: imposee ?? s.partagee,
  };
}

export { justificationValide };

// ---------------------------------------------------------------------------------------------------
// Erreurs typees
// ---------------------------------------------------------------------------------------------------

const RIEN_MODIFIE = " Rien n'a été modifié.";

/** Messages en clair des codes du lot B3 (API.md, « Codes d'erreur ajoutes par ce lot »). Le texte du serveur ne s'affiche jamais pour un code connu. */
export const MESSAGE_CODE_WORKFLOW: Record<string, string> = {
  COMPTE_REFERENT_RESTREINT: "Votre compte est rattaché à un concessionnaire : il n'ouvre que l'écran des échanges, pas le reste du module.",
  ACTION_NON_AUTORISEE: "Votre profil ne permet pas cette action. Rechargez l'écran : seules les actions permises à votre profil y sont proposées." + RIEN_MODIFIE,
  PROJET_INTROUVABLE: "Projet introuvable : il n'existe pas, a été retiré, ou vous n'y êtes pas rattaché ou habilité.",
  DEMANDE_INTROUVABLE: "Cette demande est introuvable : elle n'existe pas, n'est pas partagée avec vous, ou concerne un autre concessionnaire. Revenez à la liste.",
  TACHE_INTROUVABLE: "Cette tâche est introuvable : elle n'existe pas, ou elle ne vous est pas partagée. Revenez à la liste.",
  RECOLEMENT_INTROUVABLE: "Ce récolement est introuvable : il n'existe pas, n'est pas soumis, ou concerne un autre concessionnaire. Revenez à la liste.",
  RATTACHEMENT_INTROUVABLE: "Ce rattachement est introuvable. Rechargez la liste des référents.",
  CONCESSIONNAIRE_INTROUVABLE: "Ce concessionnaire est introuvable (retiré ?). Choisissez-en un autre.",
  CONFLIT_INTROUVABLE: "Ce dossier de conflit est introuvable dans ce projet. Choisissez-en un autre.",
  JEU_INTROUVABLE: "Ce jeu de données est introuvable dans ce projet (retiré ?). Choisissez-en un autre.",
  IDENTIFIANT_INVALIDE: "L'identifiant demandé n'est pas valide (adresse modifiée ou lien tronqué). Revenez à la liste.",
  CURSEUR_INVALIDE: "La page demandée n'est plus valide. Repartez de la première page.",
  CHAMPS_INVALIDES: "Les valeurs envoyées sont refusées par le serveur (champ inconnu, trop long ou hors des bornes). Vérifiez la saisie." + RIEN_MODIFIE,
  COMPTE_INCONNU: "Le compte désigné n'existe pas. Choisissez un compte dans la liste." + RIEN_MODIFIE,
  REFERENCE_INVALIDE: "Une référence ne peut pas commencer par javascript:, data:, vbscript: ou file: : c'est du texte qui localise la pièce, jamais un lien exécutable." + RIEN_MODIFIE,
  TRANSITION_INTERDITE: "Cette transition n'est pas permise depuis l'état actuel : l'élément a peut-être déjà été traité par une autre personne. Rechargez : seules les transitions valides sont proposées." + RIEN_MODIFIE,
  STATUT_INCOMPATIBLE: "Cet élément est dans un état final (terminé, clos, annulé ou validé) : il ne change plus. Créez-en un nouveau si nécessaire." + RIEN_MODIFIE,
  SEPARATION_DES_TACHES: "Séparation des tâches : la validation exige un tiers, ni la personne qui a soumis, ni le responsable, ni le créateur. Seul un administrateur peut accorder une dérogation, avec un motif d'au moins 10 caractères, tracée dans l'historique et l'audit." + RIEN_MODIFIE,
  PREUVE_REQUISE: "Au moins une preuve qui n'est pas une simple note est requise pour valider un récolement : ajoutez un plan de récolement, une référence de document, un courrier, une réponse du concessionnaire ou un relevé." + RIEN_MODIFIE,
  RECOLEMENT_EN_COURS: "Un récolement est déjà en cours (brouillon ou soumis) pour ce dossier ou ce jeu : terminez-le d'abord, ou ouvrez-le." + RIEN_MODIFIE,
  RATTACHEMENT_DEJA_ACTIF: "Ce compte est déjà référent de ce concessionnaire sur ce projet." + RIEN_MODIFIE,
  RATTACHEMENT_DEJA_REVOQUE: "Ce rattachement est déjà révoqué. Rechargez la liste." + RIEN_MODIFIE,
  RECOLEMENT_NON_VALIDE: "Le récolement n'est pas validé : un récolement doit être validé par un tiers avant d'appuyer la clôture d'un dossier." + RIEN_MODIFIE,
  JUSTIFICATION_REQUISE: "Une justification (ou un motif) d'au moins 10 caractères est obligatoire." + RIEN_MODIFIE,
  DATE_INVALIDE: "Une date est invalide : une date d'envoi ou de réception ne peut pas être dans le futur, et la réception ne précède pas l'envoi." + RIEN_MODIFIE,
  RESPONSABLE_NON_HABILITE: "Ce compte ne peut pas être responsable : il doit être actif, avoir la clé de module, et être administrateur, gestionnaire, agent de terrain, ou référent du concessionnaire de la tâche." + RIEN_MODIFIE,
  COMPTE_NON_ELIGIBLE: "Ce compte n'est pas éligible : un référent est un compte actif de rôle lecteur (jamais un compte qui écrit dans le socle)." + RIEN_MODIFIE,
  COMPTE_SANS_MODULE: "Ce compte n'a pas la clé de module « Projets de voirie » : attribuez-la d'abord sur la page Utilisateurs." + RIEN_MODIFIE,
  CONCESSIONNAIRE_INCOHERENT: "Le concessionnaire choisi ne correspond pas à celui du dossier ou de la demande liés." + RIEN_MODIFIE,
  LIEN_INVALIDE: "Le lien est invalide : une tâche se lie à une demande ou à un dossier, pas aux deux ; un jeu reçu doit être un jeu de réseau tiers non retiré, du même projet et du même concessionnaire." + RIEN_MODIFIE,
  CONFLIT_NON_ELIGIBLE: "Ce dossier n'est pas éligible : un récolement se rattache à un dossier dont un déplacement de réseau est décidé (statut « Traitement décidé » ou « Clos », avec une décision de déplacement approuvée en vigueur)." + RIEN_MODIFIE,
  CHAMPS_INCOMPLETS: "Des champs obligatoires manquent : un récolement soumis doit avoir un objet et un constat renseignés." + RIEN_MODIFIE,
  QUOTA_ATTEINT: "Le plafond de ce projet est atteint (demandes, tâches, récolements ou preuves). Contactez un administrateur." + RIEN_MODIFIE,
  CADENCE_CREATION: "Trop de créations en peu de temps sur ce projet : le serveur limite la cadence." + RIEN_MODIFIE,
  PROJET_OCCUPE: "Ce projet est occupé par une autre écriture du workflow ou un dépôt en cours. Rien n'a été écrit : réessayez dans quelques secondes, sans risque de doublon.",
};

function texteDuServeur(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof r === "string" && r.trim() ? r.trim() : null;
}

/**
 * Classe une erreur des ecrans du workflow : les codes du lot ont un message en clair, la precision du serveur ne complete que la separation des taches
 * (qui peut deroger) ; 429 donne le delai, 503 et 504 sont expliques. JAMAIS d'exception.
 */
export function classerErreurWorkflow(e: unknown): ErreurPv {
  const base = classerErreur(e);
  if (base.code && MESSAGE_CODE_WORKFLOW[base.code]) {
    const genre: GenreErreur = base.status === 409 ? "conflit" : base.status === 404 ? "introuvable" : base.status === 403 ? "droit" : base.status === 503 || base.status === 504 || base.status === 429 ? "serveur" : "validation";
    let message = MESSAGE_CODE_WORKFLOW[base.code];
    if (base.code === "CADENCE_CREATION") message = `Trop de créations en peu de temps sur ce projet : le serveur limite la cadence.${base.retryAfterS !== null && base.retryAfterS !== undefined ? ` Réessayez dans ${base.retryAfterS} seconde${base.retryAfterS > 1 ? "s" : ""}.` : " Réessayez dans un instant."}${RIEN_MODIFIE}`;
    if (base.code === "SEPARATION_DES_TACHES") { const p = texteDuServeur(e); if (p) message += ` Précision du serveur : ${p}`; }
    return { ...base, genre, message };
  }
  return classerErreurConflit(e);
}

export const nombreOuNull = (v: unknown): number | null => versNombre(v);
