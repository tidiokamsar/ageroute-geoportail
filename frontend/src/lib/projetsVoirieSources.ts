/**
 * Sources multiples d'un reseau et comparaison entre sources (lot S1, interface UI-C) : types, libelles et fonctions pures.
 * SOURCE DES FORMES : docs/projets-voirie/CONTRAT-SOURCES.md, API.md section S1, et le code reel (backend/src/projets-voirie/sources/*).
 *
 * PRINCIPES AFFICHES : une source unique est l'etat NORMAL (jamais une erreur) ; une comparaison est une SYNTHESE, jamais une decision ; les
 * geometries d'origine ne sont ni modifiees ni fusionnees, aucune source n'est privilegiee ; seul un geste humain justifie ouvre un dossier de
 * divergence. Aucune fonction ici ne propose de « fusionner », de « retenir » ni de « corriger » une source.
 *
 * Aucune E/S, aucun stockage, aucun DOM.
 */

import { classerErreur, formaterNombre, lireSaisieNombre, versNombre, type ErreurPv, type GenreErreur } from "./projetsVoirie";
import { classerErreurConflit, justificationValide } from "./projetsVoirieConflits";
import type { CorpsRegleRapprochement } from "./projetsVoirieSourcesApi";

export type StatutReseauSources = "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE" | "COMPARABLE";
export type StatutResultat = "CONCORDANCE" | "DIVERGENCE" | "RAPPROCHEMENT_INCERTAIN" | "SANS_CORRESPONDANCE_A" | "SANS_CORRESPONDANCE_B";
export const STATUTS_RESULTAT: readonly StatutResultat[] = ["CONCORDANCE", "DIVERGENCE", "RAPPROCHEMENT_INCERTAIN", "SANS_CORRESPONDANCE_A", "SANS_CORRESPONDANCE_B"];
export type OriginePrecision = "OBJET" | "JEU" | "CLASSE" | "INCONNUE";
export type ModeComparaison = "SOURCES" | "VERSION_CANDIDATE";
export type StatutRegle = "BROUILLON" | "APPROUVEE" | "RETIREE";

export interface PersonneRef { id: string; nomComplet: string }

export interface SourceJeu {
  jeuId: string; role: string; version: number; methodeAcquisition: string | null; dateDonnees: string | null; dateDepot: string | null; nomFichier: string;
  classePrecision: string | null; precisionHorizontaleM: number | null; nbObjets: number | null; confidentialite: string | null;
}
export interface VersionCandidate extends SourceJeu { statut: string; remplace: string | null }

export interface GroupeSources {
  role: "RESEAU_TIERS" | "AXES_TRAVAUX";
  concessionnaire: { id: string; nom: string } | null;
  typeReseau: string | null;
  /** Identite d'un reseau par type CONFIGURABLE (annonce de l'architecte du 09/11) ; nul tant que le serveur ne le rend pas. */
  typeReseauCode: string | null;
  statut: StatutReseauSources;
  nbSources: number;
  sources: SourceJeu[];
  derniereComparaison: { id: string; numero: number | null; createdAt: string | null; totaux: Record<string, number> | null } | null;
  /** `null` pour un compte qui ne decide pas : le serveur ne lui rend ni ces jeux ni leur existence. */
  versionsCandidates: VersionCandidate[] | null;
  mention: string | null;
}
export interface VueSources { reseaux: GroupeSources[]; ignores: number; limites: string[] }

export interface RegleRapprochement {
  id: string; portee: "PROJET" | "GENERALE"; famille: string | null; code: string; version: number;
  margeM: number | null; rayonAppariementM: number | null; partHorsCorridorMax: number | null; precisionParClasseM: Record<string, number> | null;
  statut: StatutRegle; justification: string | null; systeme: boolean; creePar: PersonneRef | null; approuvePar: PersonneRef | null; approuveLe: string | null;
  motifApprobation: string | null; derogationApprobation: string | null; createdAt: string | null;
}
export interface RegleEffective {
  famille: string; regleId: string | null; code: string | null; version: number | null; portee: string | null;
  margeM: number | null; rayonAppariementM: number | null; partHorsCorridorMax: number | null; precisionParClasseM: Record<string, number> | null;
}
export interface VueRegles { regles: RegleRapprochement[]; effectives: RegleEffective[]; avertissements: string[] }

export interface JeuDansComparaison {
  role: "A" | "B"; jeuId: string; sha256: string | null; version: number | null; methodeAcquisition: string | null; dateDonnees: string | null;
  classePrecision: string | null; precisionHorizontaleM: number | null; nbObjets: number | null; nomFichier: string | null; confidentialite: string | null;
}
export interface RegleDeComparaison {
  regleId: string | null; code: string | null; version: number | null; famille: string | null; portee: string | null;
  margeM: number | null; rayonAppariementM: number | null; partHorsCorridorMax: number | null; precisionParClasseM: Record<string, number> | null;
  /**
   * Correctifs serveur T1+S1 (branche fix/vague3-revue-t1s1, M6) : attestation du bareme par classe. `source = "REGLE_APPROUVEE"` avec un
   * `approuveParId` : le bareme d'une regle approuvee par un ADMIN autre que son auteur. Nul pour un serveur ancien (provenance non attestee).
   */
  bareme: { applicable: boolean | null; applique: boolean | null; source: string | null; approuveParId: string | null } | null;
}
export type OrigineCorridor = "PRECISIONS_METRES" | "BAREME_APPROUVE" | "BAREME_NON_ATTESTE" | "INCERTAIN";
export interface ResumeComparaison {
  totaux: Record<string, number>;
  corridor: {
    minM: number | null; maxM: number | null; couplesSansCorridor: number | null; margeM: number | null; rayonAppariementM: number | null;
    /** Correctifs serveur : provenance globale des corridors ; nulle pour un serveur ancien. */
    origine: OrigineCorridor | null;
  } | null;
  /** Correctifs serveur : couples fondes sur une classe convertie par un bareme, et la regle (avec son approbateur). Nul pour un serveur ancien. */
  bareme: { applique: boolean; couples: number | null; regle: { regleId: string | null; code: string | null; version: number | null; approuveParId: string | null } | null } | null;
  limites: string[];
  /** Comparaison en ECHEC : code et message enregistres. */
  erreur: { code: string | null; message: string | null } | null;
}
export interface Comparaison {
  id: string; numero: number | null; statut: "TERMINEE" | "ECHEC"; mode: ModeComparaison | null; role: string | null;
  jeuAId: string | null; jeuBId: string | null; concessionnaireId: string | null; typeReseau: string | null;
  regle: RegleDeComparaison | null; versionAlgorithme: string | null; epsg: number | null;
  jeux: JeuDansComparaison[]; donneesMasquees: boolean; declenchePar: PersonneRef | null; duree: number | null; createdAt: string | null;
  limites: string[]; resume: ResumeComparaison | null;
}
export interface ObjetResultat { id: string; nom: string | null; precisionM: number | null; originePrecision: OriginePrecision }
export interface Mesure {
  hausdorffM: number | null; longueurAM: number | null; longueurBM: number | null; longueurRecouvrementM: number | null;
  longueurHorsCorridorM: number | null; partHorsCorridor: number | null; distanceMinM: number | null;
}
export interface ResultatComparaison {
  id: string; ordre: number; cle: string | null; statut: StatutResultat;
  objetA: ObjetResultat | null; objetB: ObjetResultat | null; corridorM: number | null; mesure: Mesure | null; conflitId: string | null;
}
export interface PageResultats { resultats: ResultatComparaison[]; masque: boolean; suivant: string | null; ignores: number }

// ---------------------------------------------------------------------------------------------------
// Libelles
// ---------------------------------------------------------------------------------------------------

export const LIBELLE_STATUT_RESEAU: Readonly<Record<StatutReseauSources, string>> = {
  SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE: "Source unique : comparaison indisponible",
  COMPARABLE: "Plusieurs sources : comparaison possible",
};
export const AIDE_SOURCE_UNIQUE = "C'est l'état normal d'un réseau décrit par une seule source : aucune divergence n'est calculée et rien n'est à corriger. Une comparaison devient possible quand une seconde source autorisée (autre méthode d'acquisition) ou une version candidate en contrôle existe.";

export const LIBELLE_STATUT_RESULTAT: Readonly<Record<StatutResultat, string>> = {
  CONCORDANCE: "Concordance",
  DIVERGENCE: "Divergence mesurée",
  RAPPROCHEMENT_INCERTAIN: "Rapprochement incertain",
  SANS_CORRESPONDANCE_A: "Objet de A sans correspondance dans B",
  SANS_CORRESPONDANCE_B: "Objet de B sans correspondance dans A",
};
export const AIDE_STATUT_RESULTAT: Readonly<Record<StatutResultat, string>> = {
  CONCORDANCE: "Le tracé de A reste dans le corridor de l'objet apparié de B.",
  DIVERGENCE: "Une partie du tracé de A sort du corridor de l'objet apparié de B : la distance et la longueur hors corridor sont mesurées.",
  RAPPROCHEMENT_INCERTAIN: "Les deux objets sont proches, mais au moins une précision en mètres manque : aucun corridor ni aucune distance n'est calculé.",
  SANS_CORRESPONDANCE_A: "Aucun objet de B n'est assez proche pour être apparié à cet objet de A.",
  SANS_CORRESPONDANCE_B: "Cet objet de B n'a été apparié à aucun objet de A.",
};
/** Forme repetee dans le badge (l'information ne passe jamais par la couleur seule). */
export const FORME_STATUT_RESULTAT: Readonly<Record<StatutResultat, string>> = {
  CONCORDANCE: "=", DIVERGENCE: "≠", RAPPROCHEMENT_INCERTAIN: "?", SANS_CORRESPONDANCE_A: "A", SANS_CORRESPONDANCE_B: "B",
};
export const CLASSES_STATUT_RESULTAT: Readonly<Record<StatutResultat, string>> = {
  CONCORDANCE: "border-green-700 bg-green-50 text-green-900",
  DIVERGENCE: "border-red-700 bg-red-50 text-red-900",
  RAPPROCHEMENT_INCERTAIN: "border-amber-700 bg-amber-50 text-amber-900",
  SANS_CORRESPONDANCE_A: "border-gray-600 bg-gray-50 text-gray-900",
  SANS_CORRESPONDANCE_B: "border-gray-600 bg-gray-50 text-gray-900",
};

export const LIBELLE_MODE: Readonly<Record<ModeComparaison, string>> = {
  SOURCES: "Deux sources autorisées",
  VERSION_CANDIDATE: "Version candidate face à la version autorisée",
};
export const LIBELLE_STATUT_REGLE: Readonly<Record<StatutRegle, string>> = { BROUILLON: "Brouillon (jamais appliqué)", APPROUVEE: "Approuvée", RETIREE: "Retirée" };

export const MENTION_SANS_FUSION = "Une comparaison est une synthèse, jamais une décision : les deux sources sont conservées telles quelles, aucune n'est modifiée, fusionnée ni privilégiée.";

// ---------------------------------------------------------------------------------------------------
// Precisions et corridor
// ---------------------------------------------------------------------------------------------------

const m = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? `${formaterNombre(x, 2)} m` : null);

/**
 * Provenance du bareme par classe d'une comparaison (revue UI-C, M1). « Approuve » n'est JAMAIS deduit de `originePrecision = CLASSE` :
 *   - SYSTEME : la regle est une regle du systeme (aucun auteur) : son bareme est provisoire et n'est jamais dit approuve, quoi que disent les champs ;
 *   - ATTESTE : le serveur l'atteste (regle.bareme.source = REGLE_APPROUVEE avec un approbateur, ou resume.bareme.regle.approuveParId) ;
 *   - NON_ATTESTE : un bareme existe (ou une classe a ete convertie) sans attestation (serveur ancien) : « provenance du corridor non attestee » ;
 *   - AUCUN : aucun bareme.
 */
export interface ProvenanceBareme { etat: "ATTESTE" | "SYSTEME" | "NON_ATTESTE" | "AUCUN"; code: string | null; version: number | null; couples: number | null }

export function provenanceBareme(c: Pick<Comparaison, "regle" | "resume">, regleSysteme: boolean): ProvenanceBareme {
  const rb = c.resume?.bareme?.regle ?? null;
  const code = rb?.code ?? c.regle?.code ?? null;
  const version = rb?.version ?? c.regle?.version ?? null;
  const couples = c.resume?.bareme?.couples ?? null;
  const base = { code, version, couples };
  const unBareme = !!c.regle?.precisionParClasseM || c.resume?.bareme?.applique === true || c.resume?.corridor?.origine === "BAREME_APPROUVE" || c.resume?.corridor?.origine === "BAREME_NON_ATTESTE";
  if (!unBareme) return { ...base, etat: "AUCUN" };
  if (regleSysteme) return { ...base, etat: "SYSTEME" };
  const parRegle = c.regle?.bareme?.source === "REGLE_APPROUVEE" && !!c.regle.bareme.approuveParId;
  const parResume = c.resume?.bareme?.applique === true && !!rb?.approuveParId;
  return { ...base, etat: parRegle || parResume ? "ATTESTE" : "NON_ATTESTE" };
}

const citerRegle = (p: Pick<ProvenanceBareme, "code" | "version">) => (p.code ? `règle ${p.code}${p.version !== null ? ` v${p.version}` : ""}` : "règle non précisée");

/** Provenance lisible de la precision retenue pour un objet ; une classe convertie n'est dite « approuvee » que si le serveur l'atteste. */
export function provenancePrecision(o: Pick<ObjetResultat, "precisionM" | "originePrecision"> | null, p: ProvenanceBareme | null): string {
  if (!o) return "non communiquée";
  if (o.originePrecision === "INCONNUE" || o.precisionM === null) return "inconnue";
  const v = m(o.precisionM) ?? "n/d";
  if (o.originePrecision === "OBJET") return `${v}, déclarée pour l'objet`;
  if (o.originePrecision === "JEU") return `${v}, déclarée pour le jeu`;
  const r = citerRegle(p ?? { code: null, version: null });
  if (p?.etat === "ATTESTE") return `${v}, attribuée à la classe par le barème approuvé de la ${r}`;
  if (p?.etat === "SYSTEME") return `${v}, attribuée à la classe par le barème provisoire du système (${r}), jamais approuvé`;
  return `${v}, attribuée à la classe par le barème de la ${r} (provenance du corridor non attestée)`;
}

/** Phrase d'en-tete sur le bareme d'une comparaison (meme regle d'attestation). */
export function texteBareme(p: ProvenanceBareme, table: Record<string, number> | null): string {
  const t = table ? ` : ${Object.entries(table).map(([k, x]) => `${k} ${m(x) ?? "n/d"}`).join(", ")}` : "";
  if (p.etat === "ATTESTE") return `Une précision attribuée à une classe (A à E) vient du barème approuvé de la ${citerRegle(p)}${p.couples !== null ? ` (${p.couples} couple(s))` : ""}${t}.`;
  if (p.etat === "SYSTEME") return `Le barème par classe de cette règle est le barème provisoire du système, jamais approuvé${t}.`;
  if (p.etat === "NON_ATTESTE") return `Provenance du corridor non attestée : la règle porte un barème par classe${t}, mais le serveur n'atteste pas qu'il a été approuvé par un administrateur autre que son auteur.`;
  return "Aucune classe n'est convertie en mètres : sans précision en mètres, le rapprochement reste incertain.";
}

/** Raison d'un rapprochement incertain : quelle(s) precision(s) en metres manque(nt). Jamais une mesure. */
export function raisonIncertitude(r: Pick<ResultatComparaison, "objetA" | "objetB">): string {
  const inconnue = (o: ObjetResultat | null) => !o || o.originePrecision === "INCONNUE" || o.precisionM === null;
  const a = inconnue(r.objetA), b = inconnue(r.objetB);
  if (a && b) return "Les précisions des deux objets sont inconnues en mètres : aucun corridor n'est calculable.";
  if (a) return "La précision de l'objet de A est inconnue en mètres : aucun corridor n'est calculable.";
  if (b) return "La précision de l'objet de B est inconnue en mètres : aucun corridor n'est calculable.";
  return "Une précision en mètres manque pour calculer le corridor : aucune distance n'est mesurée.";
}

/** Libelle de la mesure d'une divergence ; `null` si la mesure est absente (masquee pour ce compte, ou non calculee). */
export function texteMesure(r: Pick<ResultatComparaison, "mesure" | "corridorM">): string | null {
  const x = r.mesure;
  if (!x) return null;
  const parts: string[] = [];
  if (x.hausdorffM !== null) parts.push(`distance de Hausdorff ${m(x.hausdorffM)}`);
  if (x.longueurHorsCorridorM !== null) parts.push(`${m(x.longueurHorsCorridorM)} hors corridor${x.longueurAM !== null ? ` sur ${m(x.longueurAM)}` : ""}`);
  if (x.partHorsCorridor !== null) parts.push(`soit ${formaterNombre(x.partHorsCorridor * 100, 1)} %`);
  if (r.corridorM !== null) parts.push(`corridor ${m(r.corridorM)}`);
  return parts.length ? parts.join(", ") : null;
}

/** Totaux d'une comparaison dans l'ordre des statuts (zero si absent du resume). */
export function totauxParStatut(t: Record<string, number> | null | undefined): { statut: StatutResultat; n: number }[] {
  return STATUTS_RESULTAT.map((s) => ({ statut: s, n: versNombre(t?.[s]) ?? 0 }));
}

// ---------------------------------------------------------------------------------------------------
// Regles : qui approuve
// ---------------------------------------------------------------------------------------------------

/**
 * L'approbation d'une regle est ADMIN, par une AUTRE personne que l'auteur (separation des taches). Rend la raison pour laquelle ce compte ne
 * peut pas approuver, ou `null` s'il peut. Le serveur reste la reference (409 SEPARATION_DES_TACHES, REGLE_IMMUABLE).
 */
export function raisonNonApprobation(r: Pick<RegleRapprochement, "statut" | "creePar">, compte: { id: string | undefined; role: string | undefined }): string | null {
  if (r.statut !== "BROUILLON") return r.statut === "APPROUVEE" ? "Règle approuvée : elle est immuable ; pour la changer, créez une nouvelle version." : "Règle retirée.";
  if (compte.role !== "ADMIN") return "L'approbation est réservée à un administrateur.";
  if (r.creePar && compte.id && r.creePar.id === compte.id) return "Vous êtes l'auteur de ce brouillon : une autre personne, administrateur, doit l'approuver (séparation des tâches).";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Saisie d'une regle
// ---------------------------------------------------------------------------------------------------

export interface SaisieRegle { famille: string; code: string; margeM: string; rayonAppariementM: string; partHorsCorridorPct: string; A: string; B: string; C: string; D: string; justification: string }

/** Construit le corps d'un brouillon ; aucun defaut invente : un champ vide n'est pas envoye (le serveur applique ses valeurs, provisoires). */
export function corpsRegle(s: SaisieRegle): { corps: CorpsRegleRapprochement | null; erreurs: string[] } {
  const erreurs: string[] = [];
  const code = s.code.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(code)) erreurs.push("Le code compte 2 à 64 caractères : lettres, chiffres, point, tiret ou souligné.");
  const nombreBorne = (t: string, min: number, max: number, nom: string): number | undefined => {
    if (!t.trim()) return undefined;
    const n = lireSaisieNombre(t);
    if (n === null || n < min || n > max) { erreurs.push(`${nom} : un nombre de ${min} à ${max} est attendu.`); return undefined; }
    return n;
  };
  const margeM = nombreBorne(s.margeM, 0, 100, "Marge (m)");
  const rayonAppariementM = nombreBorne(s.rayonAppariementM, 0.01, 1000, "Rayon d'appariement (m)");
  const pct = nombreBorne(s.partHorsCorridorPct, 0, 100, "Part hors corridor tolérée (%)");
  const classes = [s.A, s.B, s.C, s.D];
  let precisionParClasseM: Record<string, number> | undefined;
  if (classes.some((x) => x.trim())) {
    const v = classes.map((x) => lireSaisieNombre(x));
    if (v.some((x) => x === null || x <= 0 || x > 100_000)) erreurs.push("Barème par classe : les quatre précisions A, B, C et D sont des nombres de mètres strictement positifs, ou toutes vides.");
    else precisionParClasseM = { A: v[0] as number, B: v[1] as number, C: v[2] as number, D: v[3] as number };
  }
  if (!justificationValide(s.justification)) erreurs.push("Une justification de 10 caractères au moins est obligatoire.");
  if (erreurs.length) return { corps: null, erreurs };
  return {
    erreurs,
    corps: {
      code, justification: s.justification.trim(),
      ...(s.famille ? { famille: s.famille } : {}),
      ...(margeM !== undefined ? { margeM } : {}),
      ...(rayonAppariementM !== undefined ? { rayonAppariementM } : {}),
      ...(pct !== undefined ? { partHorsCorridorMax: pct / 100 } : {}),
      ...(precisionParClasseM ? { precisionParClasseM } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Erreurs typees du lot S1
// ---------------------------------------------------------------------------------------------------

const RIEN = " Rien n'a été modifié.";
export const MOTIF_NON_COMPARABLE: Readonly<Record<string, string>> = {
  MEME_JEU: "les deux choix désignent le même jeu",
  ROLE: "les deux jeux n'ont pas le même rôle (un réseau ne se compare qu'à un réseau, un plan d'axes qu'à un plan d'axes)",
  RESEAU_DIFFERENT: "les deux jeux ne décrivent pas le même réseau (concessionnaire ou type de réseau différents)",
  STATUT: "leurs statuts ne permettent ni la comparaison de deux sources autorisées, ni celle d'une version candidate face à la version qu'elle remplacera",
  LIGNEE_DIFFERENTE: "la version candidate ne remplace pas la version autorisée choisie",
};

export const MESSAGE_CODE_SOURCES: Record<string, string> = {
  COMPARAISON_INTROUVABLE: "Cette comparaison est introuvable : elle n'existe pas dans ce projet, ou l'une de ses sources n'est pas lisible pour votre compte.",
  RESULTAT_INTROUVABLE: "Ce résultat est introuvable dans cette comparaison.",
  REGLE_INTROUVABLE: "Cette règle de rapprochement est introuvable (autre projet, ou retirée).",
  JEU_INTROUVABLE: "Un des jeux choisis est introuvable (retiré, d'un autre projet, ou illisible pour votre compte).",
  JEUX_NON_COMPARABLES: "Ces deux jeux ne sont pas comparables." + RIEN,
  RESULTAT_NON_DIVERGENT: "Seul un résultat « divergence mesurée » ouvre un dossier à investiguer." + RIEN,
  DOSSIER_DEJA_OUVERT: "Un dossier de divergence est déjà ouvert pour ce résultat (ou pour ce couple d'objets) : retrouvez-le dans l'onglet Conflits." + RIEN,
  COMPARAISON_NON_TERMINEE: "Cette comparaison a échoué : elle n'a aucun résultat." + RIEN,
  REGLE_IMMUABLE: "Cette règle est déjà approuvée : elle ne change plus. Créez une nouvelle version pour la modifier." + RIEN,
  SEPARATION_DES_TACHES: "Séparation des tâches : l'auteur d'une règle ne l'approuve pas lui-même ; une autre personne, administrateur, doit l'approuver." + RIEN,
  JUSTIFICATION_REQUISE: "Une justification d'au moins 10 caractères est obligatoire." + RIEN,
  COMPARAISON_TROP_VOLUMINEUSE: "Les deux sources sont trop volumineuses pour une comparaison immédiate : découpez ou simplifiez les fichiers." + RIEN,
  COMPARAISON_TROP_FREQUENTE: "Une comparaison vient d'être calculée sur ce projet : le serveur impose un délai entre deux comparaisons." + RIEN,
  COMPARAISON_TROP_LONGUE: "La comparaison a dépassé le délai autorisé et a été interrompue (une ligne en échec est conservée dans l'historique).",
  PROJET_OCCUPE: "Une autre comparaison ou opération est en cours sur ce projet : réessayez dans quelques instants." + RIEN,
  SERVICE_OCCUPE: "Le serveur traite déjà d'autres calculs : réessayez dans un instant." + RIEN,
  CURSEUR_INVALIDE: "La page demandée n'est plus valide : repartez de la première page.",
  CHAMPS_INVALIDES: "Les valeurs envoyées sont refusées par le serveur (champ inconnu ou hors des bornes). Vérifiez la saisie." + RIEN,
  PROJET_INTROUVABLE: "Projet introuvable : il n'existe pas, a été retiré, ou n'est pas dans votre périmètre.",
};

type O = Record<string, unknown>;
const enObjet = (v: unknown): O | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as O) : null);

export function classerErreurSources(e: unknown): ErreurPv {
  const base = classerErreur(e);
  const corps = enObjet(enObjet(enObjet(e)?.response)?.data);
  if (base.code && MESSAGE_CODE_SOURCES[base.code]) {
    const genre: GenreErreur = base.status === 409 ? "conflit" : base.status === 404 ? "introuvable" : base.status === 403 ? "droit" : base.status === 429 || base.status === 503 || base.status === 504 ? "serveur" : "validation";
    let message = MESSAGE_CODE_SOURCES[base.code];
    if (base.code === "JEUX_NON_COMPARABLES" && typeof corps?.motif === "string" && MOTIF_NON_COMPARABLE[corps.motif]) message = `Ces deux jeux ne sont pas comparables : ${MOTIF_NON_COMPARABLE[corps.motif]}.${RIEN}`;
    if (base.code === "COMPARAISON_TROP_FREQUENTE" && base.retryAfterS) message += ` Réessayez dans ${base.retryAfterS} seconde${base.retryAfterS > 1 ? "s" : ""}.`;
    if (base.code === "COMPARAISON_TROP_VOLUMINEUSE") { const n = versNombre(corps?.objetsMax); if (n !== null) message = `Les deux sources portent plus de ${formaterNombre(n, 0)} objets linéaires : c'est le maximum d'une comparaison. Découpez les fichiers.${RIEN}`; }
    return { ...base, genre, message };
  }
  return classerErreurConflit(e);
}
