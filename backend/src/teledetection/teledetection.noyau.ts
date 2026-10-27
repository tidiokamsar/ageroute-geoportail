/**
 * Noyau de l'observation de la Terre (partie E du mandat V10). Aucune importation.
 *
 * CE QU'IL DECIDE : si un produit peut entrer au registre, si une proposition peut changer de statut,
 * si une source peut changer d'etat, si une mission de verification peut lui etre depechee, ce qu'un
 * compte regional a le droit de voir, et comment se lit un taux de confirmation. Les memes regles sont
 * tenues en base (declencheurs, contraintes) ; le noyau les dit avant elle, pour rendre un message clair.
 *
 * LE TERRAIN RESTE JUGE. Une proposition de teledetection n'est jamais un fait : CONFIRMEE ou INFIRMEE,
 * elle cite le constat de terrain qui la fonde, et ce verdict ne se reprend pas. Aucune proposition ne
 * modifie le referentiel : elle n'en a pas le moyen.
 *
 * CE QU'IL NE DECIDE PAS : aucun seuil de score n'est ecrit. Un score est ce que la methode rend, pas
 * une probabilite d'exactitude. Les rares constantes de conduite portent le suffixe PROVISOIRE, un
 * commentaire qui dit qui doit les fixer, et sont reprises dans MODELE-DONNEES.md.
 */

export const NATURES_PRODUIT = ["OPTIQUE", "RADAR", "ALTIMETRIE", "PRECIPITATIONS", "POPULATION", "INONDATION", "ROUTES_EXTRAITES"] as const;
export type NatureProduit = (typeof NATURES_PRODUIT)[number];

export const TYPES_PROPOSITION = ["NOUVELLE_ROUTE", "COUPURE_PROBABLE", "VEGETATION", "INONDATION"] as const;
export type TypeProposition = (typeof TYPES_PROPOSITION)[number];

export type Verdict = { ok: true } | { ok: false; code: string; motif: string };

const vide = (s: string | null | undefined) => typeof s !== "string" || s.trim().length === 0;
const refus = (code: string, motif: string): Verdict => ({ ok: false, code, motif });

// ============================================================ produits

export const CYCLES_VIE_PRODUIT = ["CATALOGUE", "TELECHARGE", "TRAITE", "ARCHIVE", "PURGE", "EN_ECHEC"] as const;
export type CycleVieProduit = (typeof CYCLES_VIE_PRODUIT)[number];

export interface ProduitSaisi {
  palier: number;
  source: string;
  nature: string;
  dateAcquisition: Date;
  dateFin?: Date | null;
  resolutionM: number;
  couvertureNuagesPct?: number | null;
  incertitude: string;
  provenance: string;
  licence: string;
  versionTraitement: string;
  autorisationDepenseRef?: string | null;
}

/** Tracabilite fournisseur d'un produit (migration 20261028100000). Tous les champs sont facultatifs. */
export interface TracabiliteProduit {
  sourceCode?: string | null;
  fournisseur?: string | null;
  identifiantFournisseur?: string | null;
  collection?: string | null;
  capteur?: string | null;
  orbite?: string | null;
  scene?: string | null;
  niveauTraitement?: string | null;
  resolutionNativeM?: number | null;
  empreinteSha256?: string | null;
  stockageChemin?: string | null;
  cycleVie?: string | null;
  licenceCode?: string | null;
  licenceAttribution?: string | null;
  synthetique?: boolean;
}

/** Un produit enregistre depuis un catalogue : le fournisseur, son identifiant, la collection, le capteur et le niveau sont requis. */
export type ProduitCatalogueSaisi = ProduitSaisi & TracabiliteProduit & {
  fournisseur: string;
  identifiantFournisseur: string;
  collection: string;
  capteur: string;
  niveauTraitement: string;
};

export function verifierProduit(p: ProduitSaisi): Verdict {
  if (!Number.isInteger(p.palier) || p.palier < 0 || p.palier > 3) return refus("PALIER_INVALIDE", "Palier : 0 (libre) a 3.");
  if (!(NATURES_PRODUIT as readonly string[]).includes(p.nature)) return refus("NATURE_INVALIDE", `Nature : ${NATURES_PRODUIT.join(", ")}.`);
  if (!(p.resolutionM > 0)) return refus("RESOLUTION_INVALIDE", "La resolution est un nombre de metres strictement positif.");
  for (const [champ, v] of [["source", p.source], ["incertitude", p.incertitude], ["provenance", p.provenance], ["licence", p.licence], ["versionTraitement", p.versionTraitement]] as const) {
    if (vide(v)) return refus("CHAMP_MANQUANT", `Le champ ${champ} est obligatoire : un produit se trace, et sa licence se releve a la source.`);
  }
  if (p.couvertureNuagesPct != null && (p.couvertureNuagesPct < 0 || p.couvertureNuagesPct > 100)) {
    return refus("NUAGES_HORS_BORNES", "La couverture nuageuse est un pourcentage, de 0 a 100.");
  }
  if (p.nature === "OPTIQUE" && p.couvertureNuagesPct == null) {
    return refus("NUAGES_REQUIS", "Un produit optique porte sa couverture nuageuse.");
  }
  if (p.palier > 0 && vide(p.autorisationDepenseRef)) {
    return refus("DEPENSE_NON_AUTORISEE", "Un produit d'un palier payant porte la reference de l'autorisation de depense (paragraphes A.5-6).");
  }
  if (p.dateFin && p.dateFin < p.dateAcquisition) return refus("PERIODE_INVERSEE", "La fin de la periode suit son debut.");
  return { ok: true };
}

const SHA256 = /^[0-9a-f]{64}$/;
const ADRESSE_AVEC_IDENTIFIANTS = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i;

/** Tracabilite d'un produit : ce que la base tient par contraintes, dit avant elle. */
export function verifierTracabilite(t: TracabiliteProduit): Verdict {
  for (const [champ, v] of [["fournisseur", t.fournisseur], ["identifiantFournisseur", t.identifiantFournisseur]] as const) {
    if (v != null && vide(v)) return refus("CHAMP_MANQUANT", `Le champ ${champ} ne peut pas etre blanc.`);
  }
  if ((t.fournisseur == null) !== (t.identifiantFournisseur == null)) {
    return refus("FOURNISSEUR_INCOMPLET", "Le fournisseur et l'identifiant fournisseur vont ensemble : l'un sans l'autre ne deduplique rien.");
  }
  for (const [champ, v] of [["collection", t.collection], ["capteur", t.capteur], ["orbite", t.orbite], ["scene", t.scene], ["niveauTraitement", t.niveauTraitement], ["stockageChemin", t.stockageChemin], ["licenceCode", t.licenceCode], ["licenceAttribution", t.licenceAttribution]] as const) {
    if (v != null && vide(v)) return refus("CHAMP_MANQUANT", `Le champ ${champ} ne peut pas etre blanc (absent : le laisser nul).`);
  }
  if (t.resolutionNativeM != null && !(t.resolutionNativeM > 0)) return refus("RESOLUTION_INVALIDE", "La resolution native est un nombre de metres strictement positif.");
  if (t.empreinteSha256 != null && !SHA256.test(t.empreinteSha256)) return refus("EMPREINTE_INVALIDE", "L'empreinte est un SHA-256 : 64 caracteres hexadecimaux en minuscules.");
  if (t.stockageChemin != null && ADRESSE_AVEC_IDENTIFIANTS.test(t.stockageChemin)) {
    return refus("STOCKAGE_AVEC_SECRET", "Le chemin de stockage est un identifiant interne : il ne porte jamais d'identifiants de connexion.");
  }
  const cycle = t.cycleVie ?? "CATALOGUE";
  if (!(CYCLES_VIE_PRODUIT as readonly string[]).includes(cycle)) return refus("CYCLE_VIE_INVALIDE", `Cycle de vie : ${CYCLES_VIE_PRODUIT.join(", ")}.`);
  if (["TELECHARGE", "TRAITE", "ARCHIVE"].includes(cycle) && (t.empreinteSha256 == null || t.stockageChemin == null)) {
    return refus("EMPREINTE_REQUISE", `Un produit ${cycle} porte son empreinte SHA-256 et son chemin de stockage : sans eux, il n'a pas ete stocke.`);
  }
  if (cycle === "CATALOGUE" && (t.empreinteSha256 != null || t.stockageChemin != null)) {
    return refus("CATALOGUE_AVEC_STOCKAGE", "Une simple reference de catalogue n'a ni empreinte ni chemin de stockage.");
  }
  return { ok: true };
}

/** Produit du catalogue d'un fournisseur : les regles du registre, plus la tracabilite complete. */
export function verifierProduitCatalogue(p: ProduitCatalogueSaisi): Verdict {
  const base = verifierProduit(p);
  if (!base.ok) return base;
  for (const [champ, v] of [["fournisseur", p.fournisseur], ["identifiantFournisseur", p.identifiantFournisseur], ["collection", p.collection], ["capteur", p.capteur], ["niveauTraitement", p.niveauTraitement]] as const) {
    if (vide(v)) return refus("CHAMP_MANQUANT", `Un produit de catalogue porte son ${champ} : sans lui, il ne se retrouve pas chez son fournisseur.`);
  }
  return verifierTracabilite(p);
}

/** Code d'un produit de catalogue : deterministe, donc le meme produit ne prend jamais deux codes. */
export function codeProduitCatalogue(fournisseur: string, identifiantFournisseur: string): string {
  return `${fournisseur.trim()}:${identifiantFournisseur.trim()}`;
}

// ============================================================ statuts d'une proposition

export const STATUTS_PROPOSITION = ["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"] as const;
export type StatutProposition = (typeof STATUTS_PROPOSITION)[number];

/** Les deux verdicts : definitifs, ils ne se reprennent pas. */
export const STATUTS_DEFINITIFS: readonly StatutProposition[] = ["CONFIRMEE", "INFIRMEE"];
export const estDefinitif = (s: string): boolean => (STATUTS_DEFINITIFS as readonly string[]).includes(s);

/**
 * Table des transitions autorisees. Elle est exhaustive : un statut absent d'une ligne est INTERDIT.
 * A_VERIFIER, EN_ATTENTE et NON_CONCLUANTE s'echangent librement et menent a un verdict ; le seul
 * « surplace » admis est EN_ATTENTE -> EN_ATTENTE (une nouvelle demande, par exemple d'information).
 * Depuis un verdict : rien. Le declencheur `propositions_teledetection_garde` tient la meme table.
 */
export const TRANSITIONS_AUTORISEES: Readonly<Record<StatutProposition, readonly StatutProposition[]>> = {
  A_VERIFIER: ["EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"],
  EN_ATTENTE: ["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"],
  NON_CONCLUANTE: ["A_VERIFIER", "EN_ATTENTE", "CONFIRMEE", "INFIRMEE"],
  CONFIRMEE: [],
  INFIRMEE: [],
};

export const MOTIFS_ATTENTE = ["INFO_DEMANDEE", "AUTRE"] as const;
export type MotifAttente = (typeof MOTIFS_ATTENTE)[number];

/** Longueur maximale du motif d'une transition (contrat d'API, section 5). */
export const MOTIF_TRANSITION_MAX = 1000;

export interface DemandeTransition {
  de: StatutProposition;
  vers: string;
  motif?: string | null;
  commentaire?: string | null;
  motifAttente?: string | null;
  /** Reference libre du constat de terrain (mission, observation...). */
  constatRef?: string | null;
  /** Observations de terrain citees a l'appui. */
  observationIds?: readonly string[] | null;
}

/**
 * Une transition est-elle permise, et motivee comme il faut ? Ordre des refus : statut inconnu, verdict
 * deja rendu, transition hors table, motif, motif d'attente, constat d'un verdict, preuves.
 */
export function verifierTransition(d: DemandeTransition): Verdict {
  if (!(STATUTS_PROPOSITION as readonly string[]).includes(d.vers)) return refus("STATUT_INVALIDE", `Statut : ${STATUTS_PROPOSITION.join(", ")}.`);
  const vers = d.vers as StatutProposition;
  if (estDefinitif(d.de)) return refus("VERDICT_DEFINITIF", `Le terrain a deja juge (${d.de}) : le verdict ne se reprend pas.`);
  if (!TRANSITIONS_AUTORISEES[d.de].includes(vers)) return refus("TRANSITION_INTERDITE", `Transition interdite : ${d.de} vers ${vers}.`);
  if (vide(d.motif)) return refus("MOTIF_REQUIS", "Toute transition est motivee.");
  if ((d.motif as string).trim().length > MOTIF_TRANSITION_MAX) return refus("MOTIF_TROP_LONG", `Le motif tient en ${MOTIF_TRANSITION_MAX} caracteres au plus.`);
  if (vers === "EN_ATTENTE") {
    if (!(MOTIFS_ATTENTE as readonly (string | null | undefined)[]).includes(d.motifAttente)) {
      return refus("MOTIF_ATTENTE_REQUIS", `Une mise en attente dit pourquoi : ${MOTIFS_ATTENTE.join(" ou ")}.`);
    }
  } else if (d.motifAttente != null) {
    return refus("MOTIF_ATTENTE_INTERDIT", "Le motif d'attente n'a de sens que pour le statut EN_ATTENTE.");
  }
  const ids = d.observationIds ?? [];
  if (ids.some((i) => vide(i))) return refus("OBSERVATION_INVALIDE", "Une preuve cite une observation par son identifiant.");
  if (new Set(ids).size !== ids.length) return refus("OBSERVATION_EN_DOUBLE", "Une observation n'est citee qu'une fois par transition.");
  if (estDefinitif(vers) && vide(d.constatRef) && ids.length === 0) {
    return refus("CONSTAT_REQUIS", "Un verdict cite le constat de terrain qui le fonde : une reference de constat ou au moins une observation.");
  }
  return { ok: true };
}

/** Reference du constat inscrite avec un verdict : la reference donnee, sinon les observations citees. */
export function construireConstatRef(constatRef: string | null | undefined, observationIds: readonly string[] | null | undefined): string | null {
  if (!vide(constatRef)) return (constatRef as string).trim();
  const ids = observationIds ?? [];
  return ids.length > 0 ? ids.map((i) => `observation:${i}`).join(";") : null;
}

/** Ancienne API (route `/verdict`) : le terrain confirme ou infirme, en citant son constat. */
export function verifierVerdict(
  statutActuel: StatutProposition,
  verdict: { statut: string; motif?: string | null; constatRef?: string | null },
): Verdict {
  if (estDefinitif(statutActuel)) {
    return refus("VERDICT_DEJA_RENDU", `Le terrain a deja juge (${statutActuel}) : le verdict ne se reprend pas.`);
  }
  if (verdict.statut !== "CONFIRMEE" && verdict.statut !== "INFIRMEE") {
    return refus("VERDICT_INVALIDE", "Verdict : CONFIRMEE ou INFIRMEE.");
  }
  if (vide(verdict.motif) || vide(verdict.constatRef)) {
    return refus("CONSTAT_REQUIS", "Un verdict cite le constat de terrain qui le fonde, et dit pourquoi.");
  }
  return { ok: true };
}

/** Une mission de verification se depeche une seule fois, tant que la proposition n'a pas de verdict. */
export function verifierDepecheVerification(p: { statut: StatutProposition; missionId: string | null }): Verdict {
  if (estDefinitif(p.statut)) return refus("VERDICT_DEJA_RENDU", "La proposition est deja jugee : rien a verifier.");
  if (p.missionId) return refus("MISSION_DEJA_DEPECHEE", "Une mission de verification est deja rattachee a cette proposition.");
  return { ok: true };
}

/**
 * Comparaison de deux dates : le produit de reference est acquis STRICTEMENT avant le produit
 * analyse, et c'est un autre produit. La base le tient aussi (`propositions_teledetection_coherence`).
 */
export function verifierDeuxDates(produit: { id: string; dateAcquisition: Date }, reference: { id: string; dateAcquisition: Date } | null): Verdict {
  if (!reference) return { ok: true };
  if (reference.id === produit.id) return refus("REFERENCE_IDENTIQUE", "La reference d'une comparaison de deux dates est un autre produit.");
  if (reference.dateAcquisition.getTime() >= produit.dateAcquisition.getTime()) {
    return refus("REFERENCE_NON_ANTERIEURE", "Le produit de reference doit etre acquis avant le produit analyse.");
  }
  return { ok: true };
}

/** Code d'une mission de verification de teledetection : VER-TD-<8 premiers caracteres>. */
export function codeMissionTeledetection(propositionId: string): string {
  return `VER-TD-${propositionId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/**
 * Marge ajoutee autour de la detection pour faire l'emprise de la mission de verification, en degres.
 * PROVISOIRE : la mission porte un POLYGONE et une detection ponctuelle n'en a pas ; 0,0005 degre est
 * de l'ordre de 55 m a l'equateur. Choix de conduite reversible, a fixer avec les equipes de terrain.
 */
export const MARGE_EMPRISE_MISSION_DEG = 0.0005;

// ============================================================ proposition deposee

export const PRIORITES = ["HAUTE", "MOYENNE", "FAIBLE"] as const;
export type NiveauPriorite = (typeof PRIORITES)[number];
export const CONFIANCES_RATTACHEMENT = ["HAUTE", "MOYENNE", "FAIBLE", "AUCUN"] as const;
export type ConfianceRattachement = (typeof CONFIANCES_RATTACHEMENT)[number];

const TYPES_GEOMETRIE = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"];

export interface PropositionAVerifier {
  type: string;
  geometrie: { type: string; coordinates?: unknown };
  score?: number | null;
  confianceDetection?: number | null;
  priorite?: { niveau: string; regle: string } | null;
  imageCouvertureNuagesPct?: number | null;
  imageNote?: string | null;
  limites?: readonly string[] | null;
}

/**
 * Une proposition deposee : type connu, geometrie GeoJSON simple, nombres dans leurs bornes, limites
 * OBLIGATOIRES (une detection sans limites laisse croire qu'elle n'en a pas), priorite coherente.
 */
export function verifierPropositionDeposee(p: PropositionAVerifier): Verdict {
  if (!(TYPES_PROPOSITION as readonly string[]).includes(p.type)) return refus("TYPE_INVALIDE", `Type : ${TYPES_PROPOSITION.join(", ")}.`);
  if (!p.geometrie || !TYPES_GEOMETRIE.includes(p.geometrie.type)) return refus("GEOMETRIE_INVALIDE", `Geometrie GeoJSON attendue : ${TYPES_GEOMETRIE.join(", ")}.`);
  for (const [champ, v, max] of [["score", p.score, 1], ["confianceDetection", p.confianceDetection, 1], ["imageCouvertureNuagesPct", p.imageCouvertureNuagesPct, 100]] as const) {
    if (v != null && !(typeof v === "number" && v >= 0 && v <= max)) return refus("VALEUR_HORS_BORNES", `${champ} : un nombre de 0 a ${max}.`);
  }
  const limites = p.limites ?? [];
  if (limites.length === 0 || limites.some((l) => vide(l))) {
    return refus("LIMITES_REQUISES", "Une proposition porte ses limites (resolution native, nuages, ce qui n'est pas detectable) : au moins une, jamais blanche.");
  }
  if (p.imageNote != null && vide(p.imageNote)) return refus("CHAMP_MANQUANT", "La note de qualite d'image ne peut pas etre blanche (absente : la laisser nulle).");
  if (p.priorite != null) {
    if (!(PRIORITES as readonly string[]).includes(p.priorite.niveau)) return refus("PRIORITE_INVALIDE", `Priorite : ${PRIORITES.join(", ")}.`);
    if (vide(p.priorite.regle)) return refus("PRIORITE_SANS_REGLE", "Une priorite dit quelle regle l'a produite.");
  }
  return { ok: true };
}

/** Une decision de rattachement : le troncon retenu, la confiance, l'algorithme, les concurrents. */
export interface CandidatTroncon { tronconId: string; code: string; distanceM: number }
export interface Rattachement {
  retenu: CandidatTroncon | null;
  confiance: ConfianceRattachement;
  algorithme: string;
  concurrents: CandidatTroncon[];
}

export const ALGORITHME_RATTACHEMENT = "PLUS_PROCHE_DANS_TOLERANCE_V1";
export const ALGORITHME_RATTACHEMENT_NON_DEMANDE = "NON_DEMANDE";
/** Nombre maximal de troncons concurrents conserves avec la decision. */
export const CANDIDATS_CONCURRENTS_MAX = 5;
/**
 * PROVISOIRES (conduite, a fixer par AGEROUTE) : un troncon unique a moins de la moitie de la tolerance est
 * un rattachement de confiance HAUTE ; en presence d'un concurrent, la confiance n'est MOYENNE que si le
 * concurrent est au moins deux fois plus loin que le retenu, sinon FAIBLE (carrefour, routes paralleles).
 * Ce sont des indices d'ambiguite, pas des probabilites.
 */
export const RATIO_PROXIMITE_PROVISOIRE = 0.5;
export const FACTEUR_SEPARATION_PROVISOIRE = 2;

/**
 * Decide du rattachement a partir des troncons trouves dans la tolerance, TRIES par distance croissante
 * (puis identifiant). Sans tolerance : aucun rattachement n'est tente, et c'est dit (NON_DEMANDE).
 */
export function evaluerRattachement(toleranceM: number | null, candidatsTries: readonly CandidatTroncon[]): Rattachement {
  if (toleranceM === null) return { retenu: null, confiance: "AUCUN", algorithme: ALGORITHME_RATTACHEMENT_NON_DEMANDE, concurrents: [] };
  if (candidatsTries.length === 0) return { retenu: null, confiance: "AUCUN", algorithme: ALGORITHME_RATTACHEMENT, concurrents: [] };
  const [retenu, ...autres] = candidatsTries;
  const concurrents = autres.slice(0, CANDIDATS_CONCURRENTS_MAX);
  let confiance: ConfianceRattachement;
  if (concurrents.length === 0) {
    confiance = retenu.distanceM <= RATIO_PROXIMITE_PROVISOIRE * toleranceM ? "HAUTE" : "MOYENNE";
  } else {
    const second = concurrents[0].distanceM;
    confiance = second > retenu.distanceM && second >= FACTEUR_SEPARATION_PROVISOIRE * retenu.distanceM ? "MOYENNE" : "FAIBLE";
  }
  return { retenu, confiance, algorithme: ALGORITHME_RATTACHEMENT, concurrents };
}

// ============================================================ sources

export const ECHELLE_ETAT_SOURCE = [
  "NON_CONFIGUREE", "CONFIGUREE", "AUTHENTIFIEE", "ACCESSIBLE", "PRODUIT_DISPONIBLE", "TRAITEMENT_OPERATIONNEL",
] as const;
export const ETATS_LATERAUX_SOURCE = ["EN_ERREUR", "EN_ATTENTE_CONFIGURATION"] as const;
export const ETATS_SOURCE = [...ECHELLE_ETAT_SOURCE, ...ETATS_LATERAUX_SOURCE] as const;
export type EtatSource = (typeof ETATS_SOURCE)[number];

/** « Active » = TRAITEMENT_OPERATIONNEL, et rien d'autre : un nom de fournisseur en base ne suffit pas. */
export const ETAT_SOURCE_ACTIVE: EtatSource = "TRAITEMENT_OPERATIONNEL";
export const estSourceActive = (etat: string): boolean => etat === ETAT_SOURCE_ACTIVE;

export interface ChangementEtatSource {
  vers: string;
  /** Message du test qui motive le changement. */
  message?: string | null;
  /** Reference du traitement reel reussi (exigee pour TRAITEMENT_OPERATIONNEL). */
  preuveTraitement?: string | null;
}

/**
 * Regles du changement d'etat d'une source (contrat, section 4) :
 *  - message obligatoire (c'est le message du dernier test) ;
 *  - AUTHENTIFIEE et EN_ATTENTE_CONFIGURATION n'existent que pour une source qui exige des identifiants ;
 *  - TRAITEMENT_OPERATIONNEL se gagne depuis PRODUIT_DISPONIBLE, avec la reference d'un traitement reel reussi :
 *    un test de connectivite n'y mene jamais.
 * Toute autre bascule (montee d'un test reussi, descente apres un echec, EN_ERREUR) est admise.
 */
export function verifierChangementEtatSource(source: { etat: string; requiertIdentifiants: boolean }, d: ChangementEtatSource): Verdict {
  if (!(ETATS_SOURCE as readonly string[]).includes(d.vers)) return refus("ETAT_INVALIDE", `Etat : ${ETATS_SOURCE.join(", ")}.`);
  if (vide(d.message)) return refus("MESSAGE_REQUIS", "Un changement d'etat porte le message du test qui le motive.");
  if ((d.vers === "AUTHENTIFIEE" || d.vers === "EN_ATTENTE_CONFIGURATION") && !source.requiertIdentifiants) {
    return refus("ETAT_NON_APPLICABLE", `L'etat ${d.vers} n'existe que pour une source qui exige des identifiants.`);
  }
  if (d.vers === ETAT_SOURCE_ACTIVE) {
    if (source.etat !== "PRODUIT_DISPONIBLE" && source.etat !== ETAT_SOURCE_ACTIVE) {
      return refus("ECHELON_NON_ATTEINT", "TRAITEMENT_OPERATIONNEL se gagne depuis PRODUIT_DISPONIBLE : un produit doit d'abord etre disponible.");
    }
    if (vide(d.preuveTraitement)) return refus("PREUVE_TRAITEMENT_REQUISE", "TRAITEMENT_OPERATIONNEL cite le traitement reel reussi qui le fonde.");
  }
  return { ok: true };
}

// ============================================================ indicateurs

/**
 * PROVISOIRE (choix de conduite reversible, a fixer par AGEROUTE) : effectif minimal de verdicts
 * (CONFIRMEE + INFIRMEE) au-dessous duquel un taux de confirmation n'est pas presente comme fiable.
 * La meme valeur vit en base (`eo_seuil_echantillon_taux()`) ; un banc verifie qu'elles sont egales.
 */
export const SEUIL_ECHANTILLON_TAUX = 30;

export const DEFINITION_TAUX_CONFIRMATION =
  "Taux de confirmation terrain = confirmees / (confirmees + infirmees). Ce n'est pas la precision statistique de la methode : " +
  "il ne voit pas les changements reels non detectes (aucun rappel). Nul tant qu'aucun verdict n'est rendu.";

export interface TauxConfirmation {
  confirmees: number;
  infirmees: number;
  jugees: number;
  /** Nulle a zero verdict : « aucun verdict » n'est pas 0 %. */
  valeur: number | null;
  echantillonSuffisant: boolean;
  seuil: number;
  definition: string;
}

export function calculerTauxConfirmation(confirmees: number, infirmees: number, seuil: number = SEUIL_ECHANTILLON_TAUX): TauxConfirmation {
  const jugees = confirmees + infirmees;
  return {
    confirmees, infirmees, jugees,
    valeur: jugees === 0 ? null : confirmees / jugees,
    echantillonSuffisant: jugees >= seuil,
    seuil,
    definition: DEFINITION_TAUX_CONFIRMATION,
  };
}

export interface ComptageSources { total: number; parEtat: Record<string, number>; actives: number }

/** Comptage des sources par etat. Tous les etats figurent (compte reel, souvent nul) ; `actives` = TRAITEMENT_OPERATIONNEL. */
export function compterSourcesParEtat(etats: readonly string[]): ComptageSources {
  const parEtat: Record<string, number> = Object.fromEntries(ETATS_SOURCE.map((e) => [e, 0]));
  for (const e of etats) parEtat[e] = (parEtat[e] ?? 0) + 1;
  return { total: etats.length, parEtat, actives: parEtat[ETAT_SOURCE_ACTIVE] ?? 0 };
}

/** Age en jours entiers (arrondi inferieur) ; nul sans date. Jamais negatif : une date future vaut 0. */
export function ageEnJours(maintenant: Date, date: Date | null): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((maintenant.getTime() - date.getTime()) / 86_400_000));
}

// ============================================================ perimetre territorial

/** Meme forme que `Perimetre` (territoire.noyau.ts), redeclaree ici parce que le noyau n'importe rien. */
export type PerimetreEo = { national: true } | { national: false; regions: ReadonlySet<number> };

/**
 * Un compte regional ne voit et ne decide que les propositions dont le troncon est dans son perimetre.
 * Une proposition NON RATTACHEE (region inconnue) n'est visible que d'un compte national : en deduire une
 * region de l'absence de rattachement serait la faute que le controle territorial evite ailleurs.
 * Sans perimetre fourni : pas de controle (appel interne, ou compte national).
 */
export function verifierPerimetreProposition(perimetre: PerimetreEo | undefined, regionId: number | null): Verdict {
  if (!perimetre || perimetre.national) return { ok: true };
  if (regionId === null) return refus("HORS_PERIMETRE", "Cette proposition n'est rattachee a aucun troncon : seul un compte national la decide.");
  if (!perimetre.regions.has(regionId)) return refus("HORS_PERIMETRE", "Cette proposition est hors de votre perimetre regional.");
  return { ok: true };
}

/**
 * Gravite des regles de la vue `coherence_teledetection` (migrations `20261022020000` et
 * `20261025120000`). BLOQUANTE : la mesure de precision est faussee (une detection qui ne pouvait
 * pas venir de son produit, un verdict anterieur au depot). A_EXAMINER : rien n'est faux, quelque
 * chose est en suspens et demande une personne. Une regle inconnue est BLOQUANTE : mieux vaut un
 * faux signal qu'un silence.
 */
export const GRAVITE_COHERENCE: Record<string, "BLOQUANTE" | "A_EXAMINER"> = {
  HORS_EMPRISE_PRODUIT: "BLOQUANTE",
  HORS_EMPRISE_REFERENCE: "BLOQUANTE",
  REFERENCE_NON_ANTERIEURE: "BLOQUANTE",
  VERDICT_AVANT_DEPOT: "BLOQUANTE",
  TRONCON_SUPPRIME: "A_EXAMINER",
  PRODUIT_RETIRE_EN_ATTENTE: "A_EXAMINER",
  MISSION_SANS_VERDICT: "A_EXAMINER",
  VERDICT_AVANT_FIN_MISSION: "A_EXAMINER",
};

export function graviteCoherence(regle: string): "BLOQUANTE" | "A_EXAMINER" {
  return GRAVITE_COHERENCE[regle] ?? "BLOQUANTE";
}
