import {
  JUSTIFICATION_MIN, classerErreur, versNombre,
  type ErreurPv, type GenreErreur, type TypeReseau,
} from "./projetsVoirie";

/**
 * Dossiers de conflit (lot RC-3) : constantes d'affichage et fonctions pures.
 * Contrat : docs/projets-voirie/CONTRAT-CONFLITS.md (section 3 modele, 4 machine a etats, 6 API, 7 interface).
 *
 * Rien ici ne touche le reseau, le DOM ni un stockage local. Rien ici n'ordonne, ne deplace ni n'execute : un conflit est un signal de
 * verification, une decision est PROPOSEE puis APPROUVEE par des humains, un cout est une saisie, jamais un calcul.
 */

export type StatutConflit = "A_INVESTIGUER" | "POTENTIEL" | "CONFIRME" | "INFIRME" | "TRAITEMENT_DECIDE" | "CLOTURE";
export type TypeConflit = "INTERSECTION_CHAUSSEE" | "INTERSECTION_EMPRISE" | "PROXIMITE" | "TRAVERSEE" | "COUVERTURE_INSUFFISANTE" | "DIVERGENCE_SOURCES";
export type RisqueConflit = "FAIBLE" | "MOYEN" | "ELEVE" | "INCONNU";
export type MotifReexamen = "NON_RETROUVE" | "MESURE_MODIFIEE" | "NOUVELLE_VERSION_DONNEES";
export type OptionDecision = "PROTEGER" | "ADAPTER_PROJET" | "DEPLACER_RESEAU" | "SANS_INTERVENTION" | "A_ETUDIER";
export type StatutDecision = "PROPOSEE" | "APPROUVEE" | "REFUSEE" | "ANNULEE";
export type TypePreuve = "NOTE" | "REFERENCE_DOCUMENT" | "CONTACT_CONCESSIONNAIRE" | "RELEVE_TERRAIN";
export type StatutRegle = "BROUILLON" | "APPROUVEE" | "RETIREE";
export type StatutAnalyseConflit = "TERMINEE" | "ECHEC";

export const STATUTS_CONFLIT: readonly StatutConflit[] = ["A_INVESTIGUER", "POTENTIEL", "CONFIRME", "INFIRME", "TRAITEMENT_DECIDE", "CLOTURE"];
export const TYPES_CONFLIT: readonly TypeConflit[] = ["INTERSECTION_CHAUSSEE", "INTERSECTION_EMPRISE", "PROXIMITE", "TRAVERSEE", "COUVERTURE_INSUFFISANTE", "DIVERGENCE_SOURCES"];
export const RISQUES_CONFLIT: readonly RisqueConflit[] = ["FAIBLE", "MOYEN", "ELEVE", "INCONNU"];
export const MOTIFS_REEXAMEN: readonly MotifReexamen[] = ["NON_RETROUVE", "MESURE_MODIFIEE", "NOUVELLE_VERSION_DONNEES"];
export const OPTIONS_DECISION: readonly OptionDecision[] = ["PROTEGER", "ADAPTER_PROJET", "DEPLACER_RESEAU", "SANS_INTERVENTION", "A_ETUDIER"];
export const STATUTS_DECISION: readonly StatutDecision[] = ["PROPOSEE", "APPROUVEE", "REFUSEE", "ANNULEE"];
export const TYPES_PREUVE: readonly TypePreuve[] = ["NOTE", "REFERENCE_DOCUMENT", "CONTACT_CONCESSIONNAIRE", "RELEVE_TERRAIN"];
export const STATUTS_REGLE: readonly StatutRegle[] = ["BROUILLON", "APPROUVEE", "RETIREE"];
export const STATUTS_ANALYSE_CONFLIT: readonly StatutAnalyseConflit[] = ["TERMINEE", "ECHEC"];

/** Texte du bandeau permanent (contrat, section 7), mot pour mot. */
export const BANDEAU_GARDE_FOUS = "Un conflit est un signal de vérification : aucun déplacement n'est décidé ni ordonné par le système. L'absence de conflit détecté ne prouve pas l'absence de réseau.";
export const MENTION_VERTICAL = "Vertical non évalué : profondeur et altitude absentes.";
export const MENTION_RECOLEMENT = "Récolement à valider (non géré dans cet outil)";
export const RAPPEL_SEPARATION = "Séparation des tâches : la personne qui propose une décision ou une clôture ne l'approuve pas. Seul un administrateur peut accorder une dérogation, avec un motif, tracée dans l'historique et l'audit.";
export const AVERTISSEMENT_COUTS = "Le coût estimé et le coût réel sont deux champs distincts, saisis à la main : l'outil ne calcule, ne déduit et ne somme aucun coût.";

/** Formes distinctes pour les badges : le MOT et la FORME portent l'information, jamais la seule couleur (WCAG 1.4.1). */
export type FormeBadge = "loupe" | "triangle" | "bouclier" | "barre" | "presse-papiers" | "cadenas" | "carre" | "losange" | "cercle" | "hexagone" | "pentagone" | "octogone" | "plume" | "croix" | "coche" | "fleche" | "sablier" | "point";

export interface StyleStatutConflit { libelle: string; aide: string; forme: FormeBadge; classes: string }

export const STYLE_STATUT_CONFLIT: Record<StatutConflit, StyleStatutConflit> = {
  A_INVESTIGUER: { libelle: "À investiguer", forme: "loupe", classes: "border-blue-300 bg-blue-50 text-blue-900", aide: "Précision faible ou inconnue, vertical non évalué, couverture insuffisante ou sources divergentes : à vérifier avant toute conclusion." },
  POTENTIEL: { libelle: "Potentiel", forme: "triangle", classes: "border-amber-400 bg-amber-100 text-amber-900", aide: "Intersection ou proximité sur des données de classe A, B ou C : à confirmer ou infirmer par une personne." },
  CONFIRME: { libelle: "Confirmé", forme: "bouclier", classes: "border-red-300 bg-red-50 text-red-900", aide: "Confirmé par une personne, preuve à l'appui : une décision peut être proposée." },
  INFIRME: { libelle: "Infirmé", forme: "barre", classes: "border-gray-400 bg-gray-100 text-gray-800", aide: "Écarté par une personne, avec justification. Peut être rouvert." },
  TRAITEMENT_DECIDE: { libelle: "Traitement décidé", forme: "presse-papiers", classes: "border-purple-300 bg-purple-50 text-purple-900", aide: "Une décision a été approuvée par un humain. Le système n'exécute rien." },
  CLOTURE: { libelle: "Clos", forme: "cadenas", classes: "border-green-400 bg-green-50 text-green-900", aide: "Dossier clos par un administrateur, avec motif." },
};

export const LIBELLE_TYPE_CONFLIT: Record<TypeConflit, string> = {
  INTERSECTION_CHAUSSEE: "Intersection avec la chaussée",
  INTERSECTION_EMPRISE: "Intersection avec l'emprise",
  PROXIMITE: "Proximité à vérifier",
  TRAVERSEE: "Traversée de l'axe",
  COUVERTURE_INSUFFISANTE: "Couverture insuffisante",
  DIVERGENCE_SOURCES: "Divergence entre sources",
};
export const FORME_TYPE_CONFLIT: Record<TypeConflit, FormeBadge> = {
  INTERSECTION_CHAUSSEE: "carre", INTERSECTION_EMPRISE: "losange", PROXIMITE: "cercle", TRAVERSEE: "hexagone", COUVERTURE_INSUFFISANTE: "pentagone", DIVERGENCE_SOURCES: "octogone",
};
export const AIDE_TYPE_CONFLIT: Record<TypeConflit, string> = {
  INTERSECTION_CHAUSSEE: "Le réseau passe dans la bande de chaussée de l'axe.",
  INTERSECTION_EMPRISE: "Le réseau passe dans l'emprise, hors chaussée.",
  PROXIMITE: "Hors emprise, mais à moins de la tolérance de proximité augmentée de la précision déclarée du jeu.",
  TRAVERSEE: "Le réseau croise l'axe.",
  COUVERTURE_INSUFFISANTE: "Aucun jeu réseau autorisé ne couvre cet axe : zone à investiguer, jamais une preuve d'absence de réseau.",
  DIVERGENCE_SOURCES: "Deux jeux de la même famille se recouvrent avec des tracés distants : chaque source est préservée.",
};

export const LIBELLE_RISQUE: Record<RisqueConflit, string> = { FAIBLE: "Risque faible", MOYEN: "Risque moyen", ELEVE: "Risque élevé", INCONNU: "Risque inconnu" };
/** Rang pour le tri : le plus eleve d'abord, inconnu apres les risques connus (jamais assimile a faible). */
export const RANG_RISQUE: Record<RisqueConflit, number> = { ELEVE: 0, MOYEN: 1, FAIBLE: 2, INCONNU: 3 };

export const LIBELLE_MOTIF_REEXAMEN: Record<MotifReexamen, string> = {
  NON_RETROUVE: "Non retrouvé par la dernière analyse",
  MESURE_MODIFIEE: "Mesure modifiée par la dernière analyse",
  NOUVELLE_VERSION_DONNEES: "Nouvelle version des données",
};

export const AIDE_MOTIF_REEXAMEN: Record<MotifReexamen, string> = {
  NON_RETROUVE: "Une nouvelle analyse ne l'a pas retrouvé. Il n'est ni fermé ni supprimé : son verdict humain est conservé, une personne doit le réexaminer.",
  MESURE_MODIFIEE: "Une nouvelle analyse a mesuré autre chose. Le verdict humain est conservé : une personne doit le réexaminer.",
  NOUVELLE_VERSION_DONNEES: "Un jeu de données a changé de version. Le verdict humain est conservé : une personne doit le réexaminer.",
};

export const LIBELLE_OPTION_DECISION: Record<OptionDecision, string> = {
  PROTEGER: "Protéger le réseau en place",
  ADAPTER_PROJET: "Adapter le projet",
  DEPLACER_RESEAU: "Déplacer le réseau (proposition)",
  SANS_INTERVENTION: "Sans intervention",
  A_ETUDIER: "À étudier",
};

export const LIBELLE_STATUT_DECISION: Record<StatutDecision, string> = { PROPOSEE: "Proposée", APPROUVEE: "Approuvée", REFUSEE: "Refusée", ANNULEE: "Annulée" };
export const FORME_STATUT_DECISION: Record<StatutDecision, FormeBadge> = { PROPOSEE: "sablier", APPROUVEE: "coche", REFUSEE: "croix", ANNULEE: "barre" };
export const CLASSES_STATUT_DECISION: Record<StatutDecision, string> = {
  PROPOSEE: "border-amber-400 bg-amber-100 text-amber-900",
  APPROUVEE: "border-green-400 bg-green-50 text-green-900",
  REFUSEE: "border-red-300 bg-red-50 text-red-900",
  ANNULEE: "border-gray-400 bg-gray-100 text-gray-800",
};

export const LIBELLE_TYPE_PREUVE: Record<TypePreuve, string> = {
  NOTE: "Note",
  REFERENCE_DOCUMENT: "Référence de document",
  CONTACT_CONCESSIONNAIRE: "Contact avec le concessionnaire",
  RELEVE_TERRAIN: "Relevé de terrain",
};

export const LIBELLE_STATUT_REGLE: Record<StatutRegle, string> = { BROUILLON: "Brouillon", APPROUVEE: "Approuvée", RETIREE: "Retirée" };
export const FORME_STATUT_REGLE: Record<StatutRegle, FormeBadge> = { BROUILLON: "plume", APPROUVEE: "coche", RETIREE: "barre" };
export const CLASSES_STATUT_REGLE: Record<StatutRegle, string> = {
  BROUILLON: "border-amber-400 bg-amber-100 text-amber-900",
  APPROUVEE: "border-green-400 bg-green-50 text-green-900",
  RETIREE: "border-gray-400 bg-gray-100 text-gray-800",
};

export const LIBELLE_STATUT_ANALYSE: Record<StatutAnalyseConflit, string> = { TERMINEE: "Terminée", ECHEC: "En échec" };

/** Libelle d'une action d'historique ; une action inconnue du client est montree telle quelle (jamais masquee). */
export const LIBELLE_ACTION_HISTORIQUE: Record<string, string> = {
  CREATION: "Création par une analyse",
  RETROUVE: "Retrouvé par une analyse",
  MESURE_MODIFIEE: "Mesure modifiée par une analyse",
  STATUT: "Changement de statut",
  ATTRIBUTION: "Attribution (responsable, échéance, risque, action)",
  PREUVE: "Preuve ajoutée",
  DECISION_PROPOSEE: "Décision proposée",
  DECISION_APPROUVEE: "Décision approuvée",
  DECISION_REFUSEE: "Décision refusée",
  REEXAMEN: "Marqué à réexaminer",
};
export const libelleAction = (a: string) => LIBELLE_ACTION_HISTORIQUE[a] ?? a;

export const LIBELLE_REGLE_GENERALE = "Toutes familles (règle générale)";

// ---------------------------------------------------------------------------------------------------
// Machine a etats : affichage de SECOURS seulement
// ---------------------------------------------------------------------------------------------------

export interface ExigencesTransition {
  /** Justification d'au moins 10 caracteres : exigee pour TOUTE transition humaine. */
  justification: true;
  /** `POTENTIEL` vers `CONFIRME` : au moins une preuve. */
  preuveRequise: boolean;
  /** `CONFIRME` vers `TRAITEMENT_DECIDE` : une decision `APPROUVEE`. */
  decisionApprouveeRequise: boolean;
  /** `TRAITEMENT_DECIDE` vers `CLOTURE` : motif, acteur identifie ; pour `DEPLACER_RESEAU`, le recolement reste a valider. */
  cloture: boolean;
}

export function exigencesTransition(de: StatutConflit, vers: StatutConflit): ExigencesTransition {
  return {
    justification: true,
    preuveRequise: de === "POTENTIEL" && vers === "CONFIRME",
    decisionApprouveeRequise: de === "CONFIRME" && vers === "TRAITEMENT_DECIDE",
    cloture: vers === "CLOTURE",
  };
}

/**
 * Contrat, section 4. Le SERVEUR renvoie les transitions possibles pour le compte et l'etat et fait autorite ; cette table ne sert qu'a
 * l'affichage de secours quand la reponse n'en porte pas, et le serveur refuse toute transition interdite (409 TRANSITION_INTERDITE).
 */
export function transitionsDeSecours(statut: StatutConflit, role: string | undefined): StatutConflit[] {
  const ecrit = role === "ADMIN" || role === "GESTIONNAIRE";
  const admin = role === "ADMIN";
  switch (statut) {
    case "A_INVESTIGUER": return ecrit ? ["POTENTIEL", "INFIRME"] : [];
    case "POTENTIEL": return ecrit ? ["CONFIRME", "INFIRME", "A_INVESTIGUER"] : [];
    case "CONFIRME": return [...(ecrit ? ["TRAITEMENT_DECIDE" as const] : []), ...(admin ? ["INFIRME" as const] : [])];
    case "TRAITEMENT_DECIDE": return admin ? ["INFIRME", "CLOTURE"] : [];
    case "INFIRME": return ecrit ? ["A_INVESTIGUER"] : [];
    default: return [];
  }
}

/** Libelle du bouton d'une transition : un verbe d'etat du dossier, jamais un verbe d'execution. */
export function libelleTransition(de: StatutConflit, vers: StatutConflit): string {
  if (vers === "INFIRME") return de === "A_INVESTIGUER" || de === "POTENTIEL" ? "Infirmer ce conflit" : "Infirmer ce conflit (administrateur)";
  if (vers === "A_INVESTIGUER") return de === "INFIRME" ? "Rouvrir à investiguer" : "Renvoyer à investiguer";
  if (vers === "POTENTIEL") return "Qualifier de potentiel";
  if (vers === "CONFIRME") return "Confirmer ce conflit";
  if (vers === "TRAITEMENT_DECIDE") return "Marquer le traitement décidé";
  return "Clore le dossier";
}

// ---------------------------------------------------------------------------------------------------
// Echeance et filtres
// ---------------------------------------------------------------------------------------------------

/** Vrai si l'echeance (date AAAA-MM-JJ) est strictement avant aujourd'hui et le dossier encore ouvert. Affichage seulement : le filtre serveur fait foi. */
export function echeanceDepassee(echeance: string | null | undefined, statut: StatutConflit, maintenant: Date = new Date()): boolean {
  if (!echeance || !/^\d{4}-\d{2}-\d{2}/.test(echeance)) return false;
  if (statut === "CLOTURE" || statut === "INFIRME") return false;
  const aujourdhui = `${maintenant.getFullYear()}-${String(maintenant.getMonth() + 1).padStart(2, "0")}-${String(maintenant.getDate()).padStart(2, "0")}`;
  return echeance.slice(0, 10) < aujourdhui;
}

export type TriConflit = "serveur" | "echeance" | "statut" | "type" | "axe" | "risque";
export const LIBELLE_TRI: Record<TriConflit, string> = {
  serveur: "Ordre du serveur",
  echeance: "Échéance (la plus proche d'abord)",
  statut: "Statut (dans l'ordre du dossier)",
  type: "Type",
  axe: "Axe (A à Z)",
  risque: "Risque (le plus élevé d'abord)",
};

export interface FiltresConflits {
  statut: StatutConflit | "";
  type: TypeConflit | "";
  axe: string;
  concessionnaireId: string;
  responsableId: string;
  aReexaminer: boolean;
  echeanceDepassee: boolean;
  q: string;
  tri: TriConflit;
}

export const FILTRES_VIDES: FiltresConflits = { statut: "", type: "", axe: "", concessionnaireId: "", responsableId: "", aReexaminer: false, echeanceDepassee: false, q: "", tri: "serveur" };

/** Nombre de filtres actifs (le tri n'en est pas un : il ne change pas les resultats). */
export function nbFiltresActifs(f: FiltresConflits): number {
  return [f.statut, f.type, f.axe.trim(), f.concessionnaireId, f.responsableId, f.q.trim()].filter((v) => v !== "").length + (f.aReexaminer ? 1 : 0) + (f.echeanceDepassee ? 1 : 0);
}

/** Parametres de requete de `GET /conflits` : seuls les filtres renseignes partent. Le tri est cote client (le contrat n'a pas de parametre de tri). */
export function paramsListeConflits(f: FiltresConflits, curseur: string | null): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.statut) p.statut = f.statut;
  if (f.type) p.type = f.type;
  if (f.axe.trim()) p.axe = f.axe.trim();
  if (f.concessionnaireId) p.concessionnaireId = f.concessionnaireId;
  if (f.responsableId) p.responsableId = f.responsableId;
  if (f.aReexaminer) p.aReexaminer = "true";
  if (f.echeanceDepassee) p.echeanceDepassee = "true";
  if (f.q.trim()) p.q = f.q.trim();
  if (curseur) p.curseur = curseur;
  return p;
}

interface TriableConflit { statut: StatutConflit; type: TypeConflit; axe: string | null; risque: RisqueConflit | null; echeance: string | null }

/** Tri stable sur les conflits DEJA CHARGES. Sans echeance / sans risque / sans axe : en dernier, jamais assimile a une valeur. */
export function trierConflits<T extends TriableConflit>(liste: readonly T[], tri: TriConflit): T[] {
  const copie = liste.map((x, i) => ({ x, i }));
  const nonVide = <V,>(v: V | null | undefined): v is V => v !== null && v !== undefined && v !== "";
  const cmp = (a: T, b: T): number => {
    switch (tri) {
      case "echeance": {
        if (!nonVide(a.echeance) && !nonVide(b.echeance)) return 0;
        if (!nonVide(a.echeance)) return 1;
        if (!nonVide(b.echeance)) return -1;
        return a.echeance.localeCompare(b.echeance);
      }
      case "statut": return STATUTS_CONFLIT.indexOf(a.statut) - STATUTS_CONFLIT.indexOf(b.statut);
      case "type": return TYPES_CONFLIT.indexOf(a.type) - TYPES_CONFLIT.indexOf(b.type);
      case "axe": {
        if (!nonVide(a.axe) && !nonVide(b.axe)) return 0;
        if (!nonVide(a.axe)) return 1;
        if (!nonVide(b.axe)) return -1;
        return a.axe.localeCompare(b.axe, "fr", { numeric: true, sensitivity: "base" });
      }
      case "risque": return (a.risque ? RANG_RISQUE[a.risque] : 4) - (b.risque ? RANG_RISQUE[b.risque] : 4);
      default: return 0;
    }
  };
  return copie.sort((p, q) => cmp(p.x, q.x) || p.i - q.i).map((e) => e.x);
}

// ---------------------------------------------------------------------------------------------------
// Geometrie : emprise d'un conflit (zoom de la carte)
// ---------------------------------------------------------------------------------------------------

/** Emprise `[ouest, sud, est, nord]` d'une geometrie GeoJSON (sans dependance), ou null si elle ne porte aucune coordonnee exploitable. */
export function bboxDeGeometrie(g: unknown): [number, number, number, number] | null {
  let ouest = Infinity, sud = Infinity, est = -Infinity, nord = -Infinity;
  const parcourir = (v: unknown, profondeur: number): void => {
    if (profondeur > 12 || !Array.isArray(v)) return;
    if (v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
      const [x, y] = v as number[];
      if (Number.isFinite(x) && Number.isFinite(y) && x >= -180 && x <= 180 && y >= -90 && y <= 90) {
        ouest = Math.min(ouest, x); est = Math.max(est, x); sud = Math.min(sud, y); nord = Math.max(nord, y);
      }
      return;
    }
    for (const e of v) parcourir(e, profondeur + 1);
  };
  const o = g as { type?: unknown; coordinates?: unknown; geometries?: unknown; geometry?: unknown } | null;
  if (!o || typeof o !== "object") return null;
  if (o.type === "GeometryCollection" && Array.isArray(o.geometries)) {
    for (const s of o.geometries) { const b = bboxDeGeometrie(s); if (b) { ouest = Math.min(ouest, b[0]); sud = Math.min(sud, b[1]); est = Math.max(est, b[2]); nord = Math.max(nord, b[3]); } }
  } else if (o.type === "Feature") {
    return bboxDeGeometrie(o.geometry);
  } else {
    parcourir(o.coordinates, 0);
  }
  return Number.isFinite(ouest) ? [ouest, sud, est, nord] : null;
}

// ---------------------------------------------------------------------------------------------------
// Saisies
// ---------------------------------------------------------------------------------------------------

export { JUSTIFICATION_MIN };

/** Justification valide : au moins 10 caracteres utiles (espaces de bord ignores). */
export const justificationValide = (s: string) => s.trim().length >= JUSTIFICATION_MIN;

/** Saisie d'un montant ou d'une tolerance : virgule ou point. `null` si vide, `NaN` si illisible (le formulaire refuse), jamais 0 par defaut. */
export function lireMontant(s: string): number | null {
  if (s.trim() === "") return null;
  const n = versNombre(s);
  return n === null ? Number.NaN : n;
}

export interface SaisieDecision {
  option: OptionDecision | "";
  justification: string;
  contraintes: string;
  coutEstime: string;
  deviseCout: string;
  coutReel: string;
  dateDebutPrevue: string;
  dateFinPrevue: string;
}

/** Messages d'erreur d'une proposition de decision (liste vide : la saisie est utilisable). */
export function erreursDecision(s: SaisieDecision): string[] {
  const e: string[] = [];
  if (!s.option) e.push("Choisissez une option.");
  if (!justificationValide(s.justification)) e.push(`La justification doit faire au moins ${JUSTIFICATION_MIN} caractères.`);
  const est = lireMontant(s.coutEstime);
  const reel = lireMontant(s.coutReel);
  if (Number.isNaN(est)) e.push("Le coût estimé n'est pas un nombre.");
  else if (est !== null && est < 0) e.push("Le coût estimé ne peut pas être négatif.");
  if (Number.isNaN(reel)) e.push("Le coût réel n'est pas un nombre.");
  else if (reel !== null && reel < 0) e.push("Le coût réel ne peut pas être négatif.");
  if ((est !== null || reel !== null) && !s.deviseCout.trim()) e.push("Indiquez la devise des coûts saisis (par exemple GNF).");
  if (s.dateDebutPrevue && s.dateFinPrevue && s.dateFinPrevue < s.dateDebutPrevue) e.push("La date de fin prévue ne peut pas précéder la date de début prévue.");
  return e;
}

export interface SaisieRegle { famille: TypeReseau | ""; code: string; toleranceProximiteM: string; margeIncertitude: string; justification: string }

export function erreursRegle(s: SaisieRegle): string[] {
  const e: string[] = [];
  if (!s.code.trim()) e.push("Le code de la règle est obligatoire.");
  else if (s.code.trim().length > 64) e.push("Le code de la règle fait 64 caractères au plus.");
  const tol = lireMontant(s.toleranceProximiteM);
  if (tol === null) e.push("La tolérance de proximité est obligatoire (aucune valeur n'est proposée : saisissez-la en mètres, 0 si aucune).");
  else if (Number.isNaN(tol) || tol < 0) e.push("La tolérance de proximité doit être un nombre de mètres supérieur ou égal à zéro.");
  const marge = lireMontant(s.margeIncertitude);
  if (marge === null) e.push("La marge d'incertitude est obligatoire (facteur appliqué à la précision déclarée du jeu).");
  else if (Number.isNaN(marge) || marge < 0) e.push("La marge d'incertitude doit être un nombre supérieur ou égal à zéro.");
  if (!justificationValide(s.justification)) e.push(`La justification doit faire au moins ${JUSTIFICATION_MIN} caractères.`);
  return e;
}

// ---------------------------------------------------------------------------------------------------
// Erreurs typees du lot
// ---------------------------------------------------------------------------------------------------

/** Messages en clair des codes du lot (contrat, section 6). Le texte du serveur ne sert que pour un code inconnu. */
export const MESSAGE_CODE_CONFLIT: Record<string, string> = {
  TRANSITION_INTERDITE: "Cette transition n'est pas permise depuis le statut actuel : le dossier a peut-être changé, ou votre compte n'a pas ce droit. Rechargez la fiche : seules les transitions valides y sont proposées. Rien n'a été modifié.",
  SEPARATION_DES_TACHES: "Séparation des tâches : la personne qui a proposé cette décision (ou cette clôture) ne peut pas l'approuver. Un autre compte habilité doit le faire ; un administrateur peut accorder une dérogation motivée, tracée dans l'historique et l'audit. Rien n'a été modifié.",
  DECISION_REQUISE: "Une décision approuvée est requise avant de passer à « Traitement décidé » : proposez-en une, puis faites-la approuver par une autre personne. Rien n'a été modifié.",
  PREUVE_REQUISE: "Au moins une preuve est requise pour confirmer un conflit. Ajoutez une preuve (note, référence de document, contact du concessionnaire ou relevé de terrain), puis réessayez. Rien n'a été modifié.",
  JUSTIFICATION_REQUISE: `Une justification d'au moins ${JUSTIFICATION_MIN} caractères est obligatoire. Rien n'a été modifié.`,
  REGLE_IMMUABLE: "Une règle approuvée est immuable. Pour la changer, créez un nouveau brouillon : il portera une nouvelle version. Rien n'a été modifié.",
  CONFLIT_INTROUVABLE: "Ce conflit est introuvable : il a peut-être été retiré du projet. Revenez à la liste.",
  DECISION_INTROUVABLE: "Cette décision est introuvable. Rechargez la fiche.",
  REGLE_INTROUVABLE: "Cette règle est introuvable. Rechargez la liste des règles.",
  ANALYSE_INTROUVABLE: "Cette analyse est introuvable. Rechargez l'historique des analyses.",
  PROJET_INTROUVABLE: "Projet introuvable : il n'existe pas, a été retiré, ou n'est pas dans votre périmètre.",
};

/**
 * Classe une erreur pour l'ecran des conflits : les codes du lot ont un message en clair, un 503 ou un 504 sans code est explique (jamais un
 * « erreur » nu), le reste est delegue a `classerErreur` du socle. JAMAIS d'exception.
 */
export function classerErreurConflit(e: unknown): ErreurPv {
  const base = classerErreur(e);
  if (base.code && MESSAGE_CODE_CONFLIT[base.code]) {
    const genre: GenreErreur = base.status === 409 ? "conflit" : base.status === 404 ? "introuvable" : base.status === 403 ? "droit" : base.status === 422 || base.status === 400 ? "validation" : base.genre;
    return { ...base, genre, message: MESSAGE_CODE_CONFLIT[base.code] };
  }
  if (!base.code && base.status === 504) {
    return { ...base, genre: "serveur", message: "Le serveur n'a pas répondu dans le délai autorisé (504) : le calcul ou la lecture a été interrompu. Réessayez dans un instant ; avant de relancer une analyse, consultez l'historique des analyses." };
  }
  if (!base.code && base.status === 503) {
    return { ...base, genre: "serveur", message: "Le serveur est momentanément indisponible ou occupé (503). Réessayez dans quelques secondes." };
  }
  if (base.status === 403 && !base.code) {
    return { ...base, genre: "permission", message: "Votre compte n'a pas la clé de module « Projets de voirie », ou son rôle ne permet pas cette action (écritures : administrateur et gestionnaire)." };
  }
  return base;
}
