import { classerErreur, versNombre, type ClassePrecision, type ErreurPv, type GenreErreur, type NatureObjet, type TypeGeom } from "./projetsVoirie";
import { classerErreurConflit, justificationValide, lireMontant } from "./projetsVoirieConflits";

/**
 * Reseaux physiques et circuits logiques (lot B1, interface) : constantes d'affichage et fonctions pures.
 * Contrat : docs/projets-voirie/CONTRAT-RESEAUX.md ; reponses : docs/projets-voirie/API.md, section « Reseaux physiques et circuits logiques (lot B1) ».
 *
 * Rien ici ne touche le reseau, le DOM ni un stockage local. Regles de ce module :
 *   - rien n'est invente : une classe de precision, une precision, une profondeur ou une altitude absentes restent « non renseignees » ;
 *   - une association automatique est une PROPOSITION : elle n'a aucun effet tant qu'une personne ne l'a pas validee ;
 *   - aucun total ne melange les natures : un fichier de N lignes n'est pas N cables.
 */

export type NatureDeclarable = "ACTIF_PHYSIQUE" | "CIRCUIT_LOGIQUE" | "EQUIPEMENT";
export type OrigineValeur = "OBJET" | "JEU" | "INCONNUE";
export type EtatVertical = "ABSENTE" | "INCOMPLETE" | "FOURNIE";
export type NiveauConfiance = "ELEVE" | "MOYEN" | "FAIBLE";
export type StatutQualite = "OBSERVE" | "IMPORTE_NON_VERIFIE" | "DERIVE" | "CONTREDIT" | "INCONNU";
/** Lot S1 : `CONNECTE_A`, connexion DECLAREE entre deux objets physiques (jamais deduite d'une proximite). */
export type TypeRelation = "PORTE_PAR" | "CONTENU_DANS" | "CONNECTE_A";
export type StatutRelation = "PROPOSEE" | "VALIDEE" | "REFUSEE" | "REVOQUEE";
export type OrigineRelation = "AUTOMATIQUE" | "MANUELLE" | "IMPORT_DECLARATIF";
/** Lot S1 : preuve d'une connexion declaree. Obligatoire pour CONNECTE_A, absente pour les autres types. */
export type PreuveConnexion = "CONFIRMEE_PAR_FOURNISSEUR" | "INCONNUE";
export type EtatConnexion = "CONFIRMEE" | "INCONNUE" | "NON_FOURNIE";
export type ActionRelation = "valider" | "refuser" | "revoquer";
export type ClasseDeclarable = "A" | "B" | "C" | "D" | "E";

export const NATURES_DECLARABLES: readonly NatureDeclarable[] = ["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT"];
/** Natures proposees par le filtre de la liste (celles de `GET /reseau/objets`, `INCONNUE` comprise). */
export const NATURES_FILTRE: readonly (NatureDeclarable | "INCONNUE")[] = ["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT", "INCONNUE"];
export const CLASSES_DECLARABLES: readonly ClasseDeclarable[] = ["A", "B", "C", "D", "E"];
export const NIVEAUX_CONFIANCE: readonly NiveauConfiance[] = ["ELEVE", "MOYEN", "FAIBLE"];
export const STATUTS_QUALITE: readonly StatutQualite[] = ["OBSERVE", "IMPORTE_NON_VERIFIE", "DERIVE", "CONTREDIT", "INCONNU"];
export const TYPES_RELATION: readonly TypeRelation[] = ["PORTE_PAR", "CONTENU_DANS", "CONNECTE_A"];
export const PREUVES_CONNEXION: readonly PreuveConnexion[] = ["INCONNUE", "CONFIRMEE_PAR_FOURNISSEUR"];
export const ETATS_CONNEXION: readonly EtatConnexion[] = ["CONFIRMEE", "INCONNUE", "NON_FOURNIE"];
export const LIBELLE_PREUVE: Readonly<Record<PreuveConnexion, string>> = {
  INCONNUE: "Preuve inconnue : la connexion est affirmée sans document du fournisseur",
  CONFIRMEE_PAR_FOURNISSEUR: "Confirmée par le fournisseur (document ou fichier du concessionnaire)",
};
export const LIBELLE_PREUVE_COURT: Readonly<Record<PreuveConnexion, string>> = { INCONNUE: "preuve inconnue", CONFIRMEE_PAR_FOURNISSEUR: "confirmée par le fournisseur" };
export const LIBELLE_ETAT_CONNEXION: Readonly<Record<EtatConnexion, string>> = {
  CONFIRMEE: "Connexion confirmée par le fournisseur",
  INCONNUE: "Connexion déclarée, preuve inconnue",
  NON_FOURNIE: "Aucune connexion fournie",
};
export const MENTION_CONNEXION = "Une connexion n'existe ici que si une source la déclare ou si une personne la saisit avec justification : aucune connexion n'est jamais déduite d'une proximité géométrique.";
export const STATUTS_RELATION: readonly StatutRelation[] = ["PROPOSEE", "VALIDEE", "REFUSEE", "REVOQUEE"];
export const ORIGINES_RELATION: readonly OrigineRelation[] = ["AUTOMATIQUE", "MANUELLE", "IMPORT_DECLARATIF"];
export const ACTIONS_RELATION: readonly ActionRelation[] = ["valider", "refuser", "revoquer"];
export const ETATS_VERTICAUX: readonly EtatVertical[] = ["ABSENTE", "INCOMPLETE", "FOURNIE"];

/** Types proposes par nature : liste de confort du serveur (CONTRAT-RESEAUX.md, 3.3), que le serveur revalide. Un type vide est un type inconnu, autorise. */
export const TYPES_OBJET_PAR_NATURE: Readonly<Record<NatureDeclarable, readonly string[]>> = {
  ACTIF_PHYSIQUE: ["CONDUITE", "GAINE", "FOURREAU", "CABLE", "CANALISATION", "COLLECTEUR", "CHAMBRE", "REGARD", "POTEAU", "AUTRE"],
  CIRCUIT_LOGIQUE: ["LIAISON", "FIBRE", "RESEAU", "SERVICE", "AUTRE"],
  EQUIPEMENT: ["VANNE", "TRANSFORMATEUR", "BOITE", "JONCTION", "ARMOIRE", "COMPTEUR", "BORNE", "AUTRE"],
};
export const TOUS_TYPES_OBJET: readonly string[] = [...new Set(Object.values(TYPES_OBJET_PAR_NATURE).flat())];
export const LIBELLE_TYPE_OBJET: Readonly<Record<string, string>> = {
  CONDUITE: "Conduite", GAINE: "Gaine", FOURREAU: "Fourreau", CABLE: "Câble", CANALISATION: "Canalisation", COLLECTEUR: "Collecteur", CHAMBRE: "Chambre", REGARD: "Regard", POTEAU: "Poteau",
  LIAISON: "Liaison", FIBRE: "Fibre", RESEAU: "Réseau (circuit)", SERVICE: "Service", VANNE: "Vanne", TRANSFORMATEUR: "Transformateur", BOITE: "Boîte", JONCTION: "Jonction",
  ARMOIRE: "Armoire", COMPTEUR: "Compteur", BORNE: "Borne", AUTRE: "Autre",
};
export const libelleTypeObjet = (t: string | null): string => (t ? LIBELLE_TYPE_OBJET[t] ?? t : "Type non renseigné");

/** Geometries admises par nature (CONTRAT-RESEAUX.md, 3.4 : un circuit est une ligne, un equipement un point). */
export function naturesCompatibles(typeGeom: TypeGeom | null): readonly NatureDeclarable[] {
  if (typeGeom === "LIGNE") return ["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE"];
  if (typeGeom === "POINT") return ["ACTIF_PHYSIQUE", "EQUIPEMENT"];
  if (typeGeom === "POLYGONE") return ["ACTIF_PHYSIQUE"];
  return NATURES_DECLARABLES;
}

export const LIBELLE_NATURE_COURT: Readonly<Record<NatureObjet, string>> = {
  ACTIF_PHYSIQUE: "Infrastructure physique", CIRCUIT_LOGIQUE: "Circuit logique", EQUIPEMENT: "Équipement", AXE: "Axe de travaux", EMPRISE: "Emprise ou limite", INCONNUE: "Nature inconnue",
};
export const AIDE_NATURE_COURTE: Readonly<Record<NatureObjet, string>> = {
  ACTIF_PHYSIQUE: "Ce qui est posé : conduite, gaine, câble, chambre, regard, poteau.",
  CIRCUIT_LOGIQUE: "Un parcours (liaison, fibre, service), pas un tracé physique : plusieurs circuits peuvent suivre le même support.",
  EQUIPEMENT: "Un équipement ponctuel : vanne, transformateur, boîte, armoire.",
  AXE: "Axe de travaux du projet.",
  EMPRISE: "Emprise ou limite de route.",
  INCONNUE: "La nature n'est pas établie : l'objet n'est compté ni comme infrastructure ni comme circuit.",
};
export const FORME_NATURE: Readonly<Record<NatureObjet, string>> = {
  ACTIF_PHYSIQUE: "cable", CIRCUIT_LOGIQUE: "reseau", EQUIPEMENT: "boite", AXE: "route", EMPRISE: "route", INCONNUE: "inconnue",
};
export const CLASSES_NATURE: Readonly<Record<NatureObjet, string>> = {
  ACTIF_PHYSIQUE: "border-blue-300 bg-blue-50 text-blue-900",
  CIRCUIT_LOGIQUE: "border-purple-300 bg-purple-50 text-purple-900",
  EQUIPEMENT: "border-green-400 bg-green-50 text-green-900",
  AXE: "border-gray-400 bg-gray-100 text-gray-800",
  EMPRISE: "border-gray-400 bg-gray-100 text-gray-800",
  INCONNUE: "border-dashed border-gray-500 bg-white text-gray-800",
};
export const LIBELLE_ORIGINE_VALEUR: Readonly<Record<OrigineValeur, string>> = { OBJET: "déclarée pour cet objet", JEU: "héritée du jeu", INCONNUE: "non renseignée" };

export const LIBELLE_STATUT_QUALITE: Readonly<Record<StatutQualite, string>> = {
  OBSERVE: "Observé", IMPORTE_NON_VERIFIE: "Importé, non vérifié", DERIVE: "Dérivé", CONTREDIT: "Contredit", INCONNU: "Inconnu",
};
export const LIBELLE_CONFIANCE: Readonly<Record<NiveauConfiance, string>> = { ELEVE: "Élevé", MOYEN: "Moyen", FAIBLE: "Faible" };

/** Classe de precision a afficher : la lettre declaree, jamais une classe inventee. */
export function libelleClasse(c: ClassePrecision | null): string {
  if (!c || c === "INCONNUE") return "Classe non renseignée";
  return `Classe ${c}`;
}

export const LIBELLE_ETAT_VERTICAL: Readonly<Record<EtatVertical, string>> = {
  ABSENTE: "Profondeur et altitude absentes : aucune conclusion 3D.",
  INCOMPLETE: "Une valeur verticale est fournie sans référence verticale : elle ne peut être comparée à rien.",
  FOURNIE: "Données verticales fournies par la source ; l'évaluation 3D n'est pas réalisée par l'application.",
};
export const MENTION_3D = "Aucune évaluation 3D n'est réalisée : même avec une profondeur ou une altitude fournie, l'application ne conclut ni à un conflit vertical ni à son absence.";

/** Phrase obligatoire du contrat (cahier v2, 20.1) : un nombre de lignes n'est pas un nombre d'equipements. */
export const MENTION_LIGNES_CABLES = "Un fichier de N lignes n'est pas N câbles : plusieurs circuits logiques (liaisons, fibres, services) peuvent suivre le même support physique. Le nombre de lignes d'un fichier n'est jamais un nombre d'équipements.";
export const BANDEAU_RESEAUX = "Une association automatique n'est qu'une proposition : elle n'a aucun effet tant qu'une personne ne l'a pas validée, avec une justification. Une simple superposition géométrique ne prouve pas qu'un circuit est porté par une infrastructure.";

export const LIBELLE_TYPE_RELATION: Readonly<Record<TypeRelation, string>> = {
  PORTE_PAR: "Circuit porté par une infrastructure", CONTENU_DANS: "Équipement contenu dans une chambre ou un regard", CONNECTE_A: "Objet physique déclaré connecté à un autre",
};
export const LIBELLE_TYPE_RELATION_COURT: Readonly<Record<TypeRelation, string>> = { PORTE_PAR: "Porté par", CONTENU_DANS: "Contenu dans", CONNECTE_A: "Connecté à" };
export const LIBELLE_ORIGINE_RELATION: Readonly<Record<OrigineRelation, string>> = { AUTOMATIQUE: "Proposition automatique", MANUELLE: "Déclarée par une personne", IMPORT_DECLARATIF: "Déclarée par le fichier du fournisseur" };

export interface StyleStatutRelation { libelle: string; aide: string; forme: "sablier" | "coche" | "croix" | "barre"; classes: string }
export const STYLE_STATUT_RELATION: Readonly<Record<StatutRelation, StyleStatutRelation>> = {
  PROPOSEE: { libelle: "Proposée", forme: "sablier", classes: "border-amber-400 bg-amber-100 text-amber-900", aide: "Aucun effet : tant qu'une personne ne l'a pas validée, cette relation n'est pas un support validé." },
  VALIDEE: { libelle: "Validée", forme: "coche", classes: "border-green-400 bg-green-50 text-green-900", aide: "Validée par une personne identifiée, avec justification : elle compte comme support validé." },
  REFUSEE: { libelle: "Refusée", forme: "croix", classes: "border-red-300 bg-red-50 text-red-900", aide: "Refusée par une personne : elle ne sera jamais reproposée automatiquement." },
  REVOQUEE: { libelle: "Révoquée", forme: "barre", classes: "border-gray-400 bg-gray-100 text-gray-800", aide: "Validée puis révoquée par une personne : elle ne compte plus comme support." },
};

export const LIBELLE_ACTION_RELATION: Readonly<Record<ActionRelation, string>> = { valider: "Valider cette association", refuser: "Refuser cette proposition", revoquer: "Révoquer cette association" };
export const VERBE_ACTION_RELATION: Readonly<Record<ActionRelation, string>> = { valider: "Valider", refuser: "Refuser", revoquer: "Révoquer" };
export const EFFET_ACTION_RELATION: Readonly<Record<ActionRelation, string>> = {
  valider: "Vous attestez que la relation est réelle : elle compte alors comme support validé. L'acte est consigné avec votre nom et votre justification.",
  refuser: "La proposition est écartée et ne sera jamais reproposée. L'acte est consigné avec votre nom et votre justification.",
  revoquer: "La relation validée cesse de compter comme support validé. L'acte est consigné avec votre nom et votre justification.",
};
export const LIBELLE_STATUT_JEU_COURT: Readonly<Record<string, string>> = { RECU: "reçu", CONTROLE: "à autoriser", AUTORISE: "autorisé", REJETE: "rejeté", REMPLACE: "remplacé", RETIRE: "retiré" };

/** Statuts de jeu dont les objets se qualifient et se relient (le serveur refuse les autres : 409 JEU_NON_QUALIFIABLE). */
export const STATUTS_JEU_QUALIFIABLES: readonly string[] = ["RECU", "CONTROLE", "AUTORISE"];
export const ROLES_JEU_QUALIFIABLES: readonly string[] = ["RESEAU_TIERS", "AUTRE"];

/** Valeurs provisoires du serveur (a valider par la DSI) : rappelees a l'ecran qui lance une proposition, jamais envoyees par defaut. */
export const AVERTISSEMENT_TOLERANCES = "Les tolérances et le seuil de couverture appliqués par le serveur sont des valeurs provisoires, en attente de validation par la DSI : ce sont des tolérances de rapprochement, pas des précisions attribuées aux données.";

// ---------------------------------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------------------------------

export interface FiltresObjets { jeuId: string; nature: NatureDeclarable | "INCONNUE" | ""; typeObjet: string; q: string }
export const FILTRES_OBJETS_VIDES: FiltresObjets = { jeuId: "", nature: "", typeObjet: "", q: "" };
export const RECHERCHE_OBJET_MAX = 100;
export const LIMITE_OBJETS = 50;
const CODE_TYPE = /^[A-Z][A-Z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ID_OBJET = /^[1-9][0-9]{0,17}$/;

export const nbFiltresObjets = (f: FiltresObjets): number => [f.jeuId, f.nature, f.typeObjet, f.q.trim()].filter((v) => v !== "").length;

/** Seuls les filtres valides partent : un code mal forme ou un identifiant qui n'est pas un UUID n'est jamais envoye (le serveur repondrait 400). */
export function paramsObjets(f: FiltresObjets, curseur: string | null): Record<string, string | number> {
  const p: Record<string, string | number> = { limite: LIMITE_OBJETS };
  if (f.jeuId && UUID.test(f.jeuId)) p.jeuId = f.jeuId;
  if (f.nature) p.nature = f.nature;
  if (f.typeObjet && CODE_TYPE.test(f.typeObjet)) p.typeObjet = f.typeObjet;
  if (f.q.trim()) p.q = f.q.trim().slice(0, RECHERCHE_OBJET_MAX);
  if (curseur) p.curseur = curseur;
  return p;
}

export interface FiltresRelations { statut: StatutRelation | ""; type: TypeRelation | ""; origine: OrigineRelation | ""; objetId: string }
export const FILTRES_RELATIONS_VIDES: FiltresRelations = { statut: "", type: "", origine: "", objetId: "" };
export const LIMITE_RELATIONS = 50;

export function paramsRelations(f: FiltresRelations, curseur: string | null): Record<string, string | number> {
  const p: Record<string, string | number> = { limite: LIMITE_RELATIONS };
  if (f.statut) p.statut = f.statut;
  if (f.type) p.type = f.type;
  if (f.origine) p.origine = f.origine;
  if (f.objetId && ID_OBJET.test(f.objetId)) p.objetId = f.objetId;
  if (curseur) p.curseur = curseur;
  return p;
}

// ---------------------------------------------------------------------------------------------------
// Saisie d'un descripteur
// ---------------------------------------------------------------------------------------------------

export interface SaisieDescripteur {
  nature: NatureDeclarable | "";
  typeObjet: string;
  classePrecision: ClasseDeclarable | "";
  precisionHorizontaleM: string;
  precisionVerticaleM: string;
  methodeCollecte: string;
  dateConstat: string;
  niveauConfiance: NiveauConfiance | "";
  statutQualite: StatutQualite;
  profondeurM: string;
  altitudeM: string;
  referenceVerticale: string;
  justification: string;
}

export const SAISIE_DESCRIPTEUR_VIDE: SaisieDescripteur = {
  nature: "", typeObjet: "", classePrecision: "", precisionHorizontaleM: "", precisionVerticaleM: "", methodeCollecte: "", dateConstat: "", niveauConfiance: "",
  statutQualite: "INCONNU", profondeurM: "", altitudeM: "", referenceVerticale: "", justification: "",
};

/** Corps de `PUT .../descripteur` : le descripteur est REMPLACE, une valeur omise devient nulle (inconnue), jamais heritee ni deduite. */
export interface CorpsDescripteur {
  nature: NatureDeclarable | null;
  typeObjet: string | null;
  classePrecision: ClasseDeclarable | null;
  precisionHorizontaleM: number | null;
  precisionVerticaleM: number | null;
  methodeCollecte: string | null;
  dateConstat: string | null;
  niveauConfiance: NiveauConfiance | null;
  statutQualite: StatutQualite;
  profondeurM: number | null;
  altitudeM: number | null;
  referenceVerticale: string | null;
  justification: string;
}

const arrondi2 = (x: number) => Math.round(x * 100) / 100;

function jourValide(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
}

/** Nature qui s'appliquera : celle declaree dans la saisie, sinon celle du jeu si elle est declarable ; sinon inconnue (aucun type possible). */
export function natureQuiSAppliquera(s: Pick<SaisieDescripteur, "nature">, natureHeritee: NatureObjet): NatureDeclarable | null {
  if (s.nature) return s.nature;
  return (NATURES_DECLARABLES as readonly string[]).includes(natureHeritee) ? (natureHeritee as NatureDeclarable) : null;
}

/** Erreurs de saisie (liste vide : utilisable). Le serveur revalide tout et fait autorite. */
export function erreursDescripteur(s: SaisieDescripteur, ctx: { typeGeom: TypeGeom | null; natureHeritee: NatureObjet }): string[] {
  const e: string[] = [];
  const nat = natureQuiSAppliquera(s, ctx.natureHeritee);
  if (s.nature && !naturesCompatibles(ctx.typeGeom).includes(s.nature)) e.push("Cette nature n'est pas compatible avec la géométrie de l'objet : un circuit logique est une ligne, un équipement un point.");
  if (s.typeObjet) {
    if (!nat) e.push("Un type d'objet exige une nature connue : déclarez la nature de l'objet avant d'en donner le type.");
    else if (!TYPES_OBJET_PAR_NATURE[nat].includes(s.typeObjet)) e.push("Ce type n'existe pas pour cette nature.");
  }
  for (const [libelle, v] of [["horizontale", s.precisionHorizontaleM], ["verticale", s.precisionVerticaleM]] as const) {
    const n = lireMontant(v);
    if (n === null) continue;
    if (Number.isNaN(n)) e.push(`La précision ${libelle} n'est pas un nombre.`);
    else if (n <= 0 || arrondi2(n) <= 0) e.push(`La précision ${libelle} doit être strictement positive, au moins 0,01 m.`);
    else if (n > 100_000) e.push(`La précision ${libelle} ne peut pas dépasser 100 000 m.`);
  }
  if (s.methodeCollecte.trim().length > 200) e.push("La méthode de collecte fait 200 caractères au plus.");
  if (s.dateConstat && !jourValide(s.dateConstat)) e.push("La date du constat doit être une date valide.");
  const prof = lireMontant(s.profondeurM);
  const alt = lireMontant(s.altitudeM);
  if (prof !== null) { if (Number.isNaN(prof)) e.push("La profondeur n'est pas un nombre."); else if (prof < 0 || prof > 10_000) e.push("La profondeur est comprise entre 0 et 10 000 m (positive vers le bas)."); }
  if (alt !== null) { if (Number.isNaN(alt)) e.push("L'altitude n'est pas un nombre."); else if (alt < -500 || alt > 9_000) e.push("L'altitude est comprise entre -500 et 9 000 m."); }
  if (s.referenceVerticale.trim() && prof === null && alt === null) e.push("Une référence verticale exige une profondeur ou une altitude.");
  if (s.referenceVerticale.trim().length > 120) e.push("La référence verticale fait 120 caractères au plus.");
  if (!justificationValide(s.justification)) e.push("La justification doit faire au moins 10 caractères.");
  else if (s.justification.trim().length > 2000) e.push("La justification fait 2 000 caractères au plus.");
  return e;
}

const nombreOuNull = (v: string): number | null => { const n = lireMontant(v); return n === null || Number.isNaN(n) ? null : arrondi2(n); };

/** Corps a envoyer. Appeler seulement quand `erreursDescripteur` est vide. */
export function corpsDescripteur(s: SaisieDescripteur): CorpsDescripteur {
  return {
    nature: s.nature || null,
    typeObjet: s.typeObjet || null,
    classePrecision: s.classePrecision || null,
    precisionHorizontaleM: nombreOuNull(s.precisionHorizontaleM),
    precisionVerticaleM: nombreOuNull(s.precisionVerticaleM),
    methodeCollecte: s.methodeCollecte.trim() || null,
    dateConstat: s.dateConstat || null,
    niveauConfiance: s.niveauConfiance || null,
    statutQualite: s.statutQualite,
    profondeurM: nombreOuNull(s.profondeurM),
    altitudeM: nombreOuNull(s.altitudeM),
    referenceVerticale: s.referenceVerticale.trim() || null,
    justification: s.justification.trim(),
  };
}

/** Lecture sure d'un nombre venu du serveur pour pre-remplir un champ de saisie (virgule francaise). */
export const texteNombre = (n: number | null): string => (n === null || !Number.isFinite(n) ? "" : String(n).replace(".", ","));

export function classeDeclarable(c: ClassePrecision | null): ClasseDeclarable | "" {
  return c && (CLASSES_DECLARABLES as readonly string[]).includes(c) ? (c as ClasseDeclarable) : "";
}

// ---------------------------------------------------------------------------------------------------
// Erreurs typees
// ---------------------------------------------------------------------------------------------------

const RIEN_MODIFIE = " Rien n'a été modifié.";

/** Messages en clair des codes du lot B1 (API.md). Le texte du serveur ne sert que pour un code inconnu ; les precisions numeriques viennent du corps de la reponse. */
export const MESSAGE_CODE_RESEAU: Record<string, string> = {
  OBJET_INTROUVABLE: "Cet objet de réseau est introuvable : il n'existe pas dans ce projet, ou son jeu n'est pas lisible pour votre compte. Revenez à la liste.",
  RELATION_INTROUVABLE: "Cette relation est introuvable : elle n'existe pas, ou l'un de ses deux objets n'est pas lisible pour votre compte. Rechargez la liste.",
  JEU_INTROUVABLE: "Ce jeu de données est introuvable (retiré, d'un autre projet, ou hors de votre périmètre). Choisissez un autre jeu.",
  ROLE_NON_QUALIFIABLE: "Seuls les objets d'un réseau de concessionnaire (ou d'un jeu « autre ») se qualifient : pas les axes de travaux ni les limites de route." + RIEN_MODIFIE,
  NATURE_INCOMPATIBLE_GEOMETRIE: "Cette nature n'est pas compatible avec la géométrie de l'objet : un circuit logique est une ligne, un équipement un point." + RIEN_MODIFIE,
  TYPE_OBJET_INCONNU_POUR_NATURE: "Ce type d'objet n'existe pas pour cette nature. Choisissez un type de la liste proposée." + RIEN_MODIFIE,
  TYPE_OBJET_SANS_NATURE: "Un type d'objet exige une nature connue : déclarez la nature de l'objet, ou précisez celle du jeu, avant d'en donner le type." + RIEN_MODIFIE,
  REFERENCE_VERTICALE_SANS_VALEUR: "Une référence verticale exige une profondeur ou une altitude : une référence sans valeur est refusée." + RIEN_MODIFIE,
  PRECISION_INCOHERENTE: "Une précision, une profondeur ou une altitude est hors des bornes admises (une précision est strictement positive, au plus 100 000 m)." + RIEN_MODIFIE,
  INCOHERENCE_REFUSEE: "La base de données refuse cette écriture comme incohérente." + RIEN_MODIFIE,
  JEU_NON_QUALIFIABLE: "Le jeu de cet objet est rejeté, remplacé ou retiré : seuls les objets d'un jeu en contrôle ou autorisé se qualifient et se relient." + RIEN_MODIFIE,
  RELATIONS_ACTIVES: "Cet objet porte une relation proposée ou validée : refusez ou révoquez-la avant de changer sa nature." + RIEN_MODIFIE,
  NATURE_RELATION_INCOMPATIBLE: "Les natures des deux objets ne conviennent pas à ce type de relation : un circuit logique est porté par une infrastructure physique ; un équipement est contenu dans une infrastructure physique." + RIEN_MODIFIE,
  GEOMETRIE_RELATION_INCOMPATIBLE: "Les géométries des deux objets ne conviennent pas à ce type de relation : un circuit et son support sont des lignes ; un équipement est un point, sa chambre un point ou une surface." + RIEN_MODIFIE,
  RELATION_SUR_SOI: "Un objet ne peut pas être relié à lui-même." + RIEN_MODIFIE,
  RELATION_DEJA_CONNUE: "Ce couple d'objets a déjà une relation (proposée, validée, refusée ou révoquée) : une proposition refusée ne se contourne pas par une déclaration manuelle. Ouvrez la liste des relations pour la retrouver." + RIEN_MODIFIE,
  TRANSITION_INTERDITE: "Cette action n'est pas permise depuis le statut actuel de la relation : elle a peut-être déjà été traitée par une autre personne. Rechargez la liste : seules les actions valides y sont proposées." + RIEN_MODIFIE,
  JUSTIFICATION_INVALIDE: "La justification doit comporter 10 caractères au moins." + RIEN_MODIFIE,
  JUSTIFICATION_REQUISE: "Une justification d'au moins 10 caractères est obligatoire." + RIEN_MODIFIE,
  CHAMPS_INVALIDES: "Les valeurs envoyées sont refusées par le serveur (champ inconnu ou hors des bornes). Vérifiez la saisie." + RIEN_MODIFIE,
  JEU_NON_AUTORISE: "Les propositions ne portent que sur des jeux autorisés : le jeu choisi n'est pas autorisé. Autorisez-le d'abord ou choisissez un autre jeu.",
  TROP_DE_CIRCUITS: "Il y a trop de circuits pour une seule exécution. Restreignez la proposition à un jeu.",
  ASSOCIATION_TROP_FREQUENTE: "Une proposition automatique a déjà été lancée récemment sur ce projet : le serveur n'en admet qu'une à la fois, avec un délai entre deux exécutions.",
  ASSOCIATION_TROP_LONGUE: "Le calcul des propositions a dépassé le délai autorisé et a été interrompu : aucune proposition n'a été enregistrée. Restreignez la proposition à un jeu, puis réessayez.",
  COMPTAGE_TROP_LONG: "Le comptage a dépassé le délai autorisé et a été interrompu. Restreignez-le à un jeu, puis réessayez.",
  LECTURE_TROP_LONGUE: "La lecture a dépassé le délai autorisé et a été interrompue : affinez les filtres, puis réessayez.",
  CURSEUR_INVALIDE: "La page demandée n'est plus valide. Repartez de la première page.",
  SERVICE_OCCUPE: "Le serveur traite déjà d'autres calculs. Réessayez dans un instant.",
  PROJET_OCCUPE: "Ce projet est occupé par une autre opération (un dépôt ou une proposition est peut-être en cours). Rien n'a été écrit : réessayez dans quelques secondes, sans risque de doublon.",
  QUARANTAINE_RESERVEE: "L'affichage des données non autorisées est réservé aux administrateurs et aux gestionnaires.",
  PROJET_INTROUVABLE: "Projet introuvable : il n'existe pas, a été retiré, ou n'est pas dans votre périmètre.",
};

type Obj = Record<string, unknown>;
const enObjet = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
/** Un complement numerique du corps d'erreur (par exemple `maximum`). */
export function nombreDuCorps(e: unknown, cle: string): number | null {
  return versNombre(enObjet(enObjet(enObjet(e)?.response)?.data)?.[cle]);
}
function texteDuServeur(e: unknown): string | null {
  const t = enObjet(enObjet(enObjet(e)?.response)?.data)?.error;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/**
 * Classe une erreur des ecrans reseaux : les codes du lot ont un message en clair (le texte du serveur ne s'affiche jamais pour un code connu, sauf
 * la precision de la base pour INCOHERENCE_REFUSEE), le reste est delegue aux messages de l'ecran des conflits (429, 503, 504 sans code). JAMAIS d'exception.
 */
export function classerErreurReseau(e: unknown): ErreurPv {
  const base = classerErreur(e);
  if (base.code && MESSAGE_CODE_RESEAU[base.code]) {
    const genre: GenreErreur = base.status === 409 ? "conflit" : base.status === 404 ? "introuvable" : base.status === 403 ? "droit" : base.status === 503 || base.status === 504 || base.status === 429 ? "serveur" : "validation";
    let message = MESSAGE_CODE_RESEAU[base.code];
    if (base.code === "TROP_DE_CIRCUITS") { const m = nombreDuCorps(e, "maximum"); if (m !== null) message = `Il y a plus de ${m} circuits : c'est le maximum d'une exécution. Restreignez la proposition à un jeu.`; }
    if (base.code === "ASSOCIATION_TROP_FREQUENTE") message += base.retryAfterS !== null && base.retryAfterS !== undefined ? ` Réessayez dans ${base.retryAfterS} seconde${base.retryAfterS > 1 ? "s" : ""}.` : " Réessayez dans un instant.";
    if (base.code === "INCOHERENCE_REFUSEE") { const t = texteDuServeur(e); if (t) message += ` Précision du serveur : ${t}`; }
    return { ...base, genre, message };
  }
  return classerErreurConflit(e);
}

// ---------------------------------------------------------------------------------------------------
// Presentation de valeurs
// ---------------------------------------------------------------------------------------------------

const ESPACES_FINES = new RegExp("[" + String.fromCharCode(0x202f, 0xa0) + "]", "g");
export const TEXTE_NON_FOURNI = "non fourni";

/** Longueur ou precision en metres, ou « non renseignee » : une valeur absente n'est jamais rendue comme zero. */
export function texteMetres(m: number | null, absent = "non renseignée"): string {
  if (m === null || !Number.isFinite(m)) return absent;
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(m).replace(ESPACES_FINES, " ")} m`;
}

// ---------------------------------------------------------------------------------------------------
// Cible d'un dossier de conflit (CONTRAT-CONFLITS.md, section 9, points 35 a 41)
// ---------------------------------------------------------------------------------------------------

export type QualificationCible = "INFRASTRUCTURE_PHYSIQUE" | "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE" | "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE" | "EQUIPEMENT" | "NATURE_INCONNUE";
export const QUALIFICATIONS_CIBLE: readonly QualificationCible[] = ["INFRASTRUCTURE_PHYSIQUE", "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE", "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE", "EQUIPEMENT", "NATURE_INCONNUE"];
export const LIBELLE_QUALIFICATION_CIBLE: Readonly<Record<QualificationCible, string>> = {
  INFRASTRUCTURE_PHYSIQUE: "Infrastructure physique",
  CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE: "Circuit logique porté par une infrastructure validée",
  CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE: "Circuit logique sans support validé",
  EQUIPEMENT: "Équipement",
  NATURE_INCONNUE: "Nature inconnue",
};

/** Ce que le serveur dit de la cible d'un dossier (nature effective, qualification, support physique). Tout champ absent reste `null`. */
export interface CibleConflit {
  nature: NatureObjet | null;
  origineNature: OrigineValeur;
  qualification: QualificationCible | null;
  libelle: string | null;
  supportPhysique: { valides: number | null; proposes: number | null } | null;
  /** Autres circuits du meme jeu a la trace strictement identique (fiche seulement). */
  tracePartagee: number | null;
}

/** Libelle court de la cible pour la liste : la qualification du serveur, sinon la nature ; `null` si le serveur ne dit rien. */
export function libelleCibleCourt(c: CibleConflit | null): string | null {
  if (!c) return null;
  if (c.qualification) return LIBELLE_QUALIFICATION_CIBLE[c.qualification];
  return c.nature ? LIBELLE_NATURE_COURT[c.nature] : null;
}
