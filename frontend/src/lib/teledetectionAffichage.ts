import type {
  ConfianceRattachement, EtatSource, NiveauPriorite, Proposition, StatutProposition,
} from "./teledetectionApi";

/**
 * Noyau PUR de l'ecran Observation de la Terre : libelles, regles d'affichage, couleurs de statut.
 * Ni horloge, ni DOM, ni reseau : tout ce qui decide ce que l'utilisateur LIT est ici, donc testable
 * (voir docs/observation-terre/CONTRAT-API-UI.md, principes d'integrite du paragraphe 1).
 *
 * Aucune constante de ce fichier ne vient de la capture de reference : elle est une cible visuelle,
 * jamais une source de donnees.
 */

// ---------------------------------------------------------------- constantes provisoires

// Le zoom minimal et l'emprise maximale d'une demande de propositions vivent dans `teledetectionCarte.ts`
// (`ZOOM_MINIMUM_PROPOSITIONS`, `etatZoom`) : une seule source de verite, l'ecran n'en garde pas de copie.
/** Au-dela, la derniere acquisition est signalee comme ancienne (PROVISOIRE). */
export const SEUIL_ACQUISITION_ANCIENNE_JOURS = 30;
/** Le seuil d'echantillon fait foi cote serveur (`seuil`) ; ce repli ne sert que s'il manque. */
export const SEUIL_ECHANTILLON_PAR_DEFAUT = 30;
/** Demi-cote, en degres, de l'emprise cadree sur une proposition ponctuelle (environ 1 km). */
export const DEMI_EMPRISE_DEG = 0.01;
/** Longueur maximale de la reference d'un constat : celle du serveur (`constatRef`, 200 caracteres). */
export const CONSTAT_REF_MAX = 200;

// ---------------------------------------------------------------- libelles

const LIBELLES_TYPE: Record<string, string> = {
  NOUVELLE_ROUTE: "Nouvelle route",
  COUPURE_PROBABLE: "Coupure probable",
  VEGETATION: "Végétation",
  INONDATION: "Inondation",
};

/** Types connus du depot (backend/src/teledetection/teledetection.noyau.ts), pour le filtre. */
export const TYPES_CONNUS = Object.keys(LIBELLES_TYPE);

/** Libelle lisible ; un type inconnu est rendu en minuscules lisibles, jamais en SNAKE_CASE brut. */
export function libelleType(type: string): string {
  if (LIBELLES_TYPE[type]) return LIBELLES_TYPE[type];
  const t = type.replace(/_/g, " ").trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Type non renseigné";
}

export interface OngletStatut { statut: StatutProposition; libelle: string; cle: "aVerifier" | "enAttente" | "nonConcluantes" | "confirmees" | "infirmees" }

export const ONGLETS_STATUT: readonly OngletStatut[] = [
  { statut: "A_VERIFIER", libelle: "À vérifier", cle: "aVerifier" },
  { statut: "EN_ATTENTE", libelle: "En attente", cle: "enAttente" },
  { statut: "NON_CONCLUANTE", libelle: "Non concluantes", cle: "nonConcluantes" },
  { statut: "CONFIRMEE", libelle: "Confirmées", cle: "confirmees" },
  { statut: "INFIRMEE", libelle: "Infirmées", cle: "infirmees" },
];

const LIBELLES_STATUT: Record<StatutProposition, string> = {
  A_VERIFIER: "À vérifier", EN_ATTENTE: "En attente", NON_CONCLUANTE: "Non concluante", CONFIRMEE: "Confirmée", INFIRMEE: "Infirmée",
};
export function libelleStatut(s: string): string {
  return LIBELLES_STATUT[s as StatutProposition] ?? "Statut inconnu";
}

export function libellePriorite(n: NiveauPriorite | null | undefined): string {
  if (n === "HAUTE") return "Priorité haute";
  if (n === "MOYENNE") return "Priorité moyenne";
  if (n === "FAIBLE") return "Priorité faible";
  return "Priorité non déterminée";
}

const LIBELLES_RATTACHEMENT: Record<ConfianceRattachement, string> = {
  HAUTE: "Rattachement de confiance haute", MOYENNE: "Rattachement de confiance moyenne",
  FAIBLE: "Rattachement de confiance faible", AUCUN: "Aucun rattachement",
};
export function libelleConfianceRattachement(c: string): string {
  return LIBELLES_RATTACHEMENT[c as ConfianceRattachement] ?? "Rattachement non qualifié";
}

// ---------------------------------------------------------------- couleurs (couples fond / texte)

/**
 * Couples fond / texte en hexadecimal, pour que le test de contraste puisse les mesurer avec
 * `lib/contraste.ts` (seuil WCAG 1.4.3 : 4,5:1). Les teintes sont celles de styles/tokens.css
 * (echelle d'etat, jeux « texte » et « fond »), jamais une couleur choisie a l'oeil.
 * La couleur ne porte jamais seule l'information : chaque pastille a son libelle.
 */
export interface CoupleCouleur { fond: string; texte: string }

const ROUGE: CoupleCouleur = { fond: "#fdeaea", texte: "#b91c1c" };
const AMBRE: CoupleCouleur = { fond: "#f9f0d9", texte: "#7a5b00" };
const VERT: CoupleCouleur = { fond: "#e8f5ef", texte: "#12694a" };
const GRIS: CoupleCouleur = { fond: "#eef0f2", texte: "#565b63" };
const MARINE: CoupleCouleur = { fond: "#e6edf7", texte: "#1a2942" };

export const COULEURS_PRIORITE: Record<NiveauPriorite | "AUCUNE", CoupleCouleur> = {
  HAUTE: ROUGE, MOYENNE: AMBRE, FAIBLE: MARINE, AUCUNE: GRIS,
};
export function couleurPriorite(n: NiveauPriorite | null | undefined): CoupleCouleur {
  return COULEURS_PRIORITE[n ?? "AUCUNE"] ?? GRIS;
}

export const COULEURS_STATUT: Record<StatutProposition, CoupleCouleur> = {
  A_VERIFIER: MARINE, EN_ATTENTE: AMBRE, NON_CONCLUANTE: GRIS, CONFIRMEE: VERT, INFIRMEE: ROUGE,
};
export function couleurStatut(s: string): CoupleCouleur {
  return COULEURS_STATUT[s as StatutProposition] ?? GRIS;
}

// ---------------------------------------------------------------- sources : echelle d'etat (contrat paragraphe 4)

export interface InfoEtatSource { libelle: string; explication: string; couleur: CoupleCouleur; active: boolean; connu: boolean }

const ETATS_SOURCE: Record<EtatSource, InfoEtatSource> = {
  NON_CONFIGUREE: { libelle: "Non configurée", explication: "Aucun paramètre de connexion n'est enregistré pour cette source.", couleur: GRIS, active: false, connu: true },
  CONFIGUREE: { libelle: "Configurée, non testée", explication: "Les paramètres existent mais aucun test de connexion n'a abouti.", couleur: GRIS, active: false, connu: true },
  AUTHENTIFIEE: { libelle: "Authentifiée", explication: "Le serveur s'est identifié auprès du fournisseur. Aucun produit n'a encore été confirmé disponible.", couleur: MARINE, active: false, connu: true },
  ACCESSIBLE: { libelle: "Catalogue accessible", explication: "Le catalogue du fournisseur répond. Aucun produit n'a encore été retrouvé dans la fenêtre testée.", couleur: MARINE, active: false, connu: true },
  PRODUIT_DISPONIBLE: { libelle: "Produits disponibles", explication: "Au moins un produit a été trouvé, mais aucun traitement n'est en service : la source n'alimente pas encore de propositions.", couleur: MARINE, active: false, connu: true },
  TRAITEMENT_OPERATIONNEL: { libelle: "Active", explication: "Un traitement réel a abouti : la source alimente des propositions.", couleur: VERT, active: true, connu: true },
  EN_ERREUR: { libelle: "En erreur", explication: "Le dernier test ou le dernier traitement a échoué. Voir le message.", couleur: ROUGE, active: false, connu: true },
  EN_ATTENTE_CONFIGURATION: { libelle: "Identifiants requis", explication: "Le fournisseur exige des identifiants, à enregistrer côté serveur.", couleur: AMBRE, active: false, connu: true },
};

/** Seul `TRAITEMENT_OPERATIONNEL` est « Active ». Un etat inconnu n'est jamais presente comme actif. */
export function infoEtatSource(etat: string): InfoEtatSource {
  return ETATS_SOURCE[etat as EtatSource] ?? {
    libelle: "État inconnu", explication: `L'état « ${etat} » n'est pas reconnu par cette version de l'écran.`, couleur: GRIS, active: false, connu: false,
  };
}
export function estSourceActive(etat: string): boolean {
  return infoEtatSource(etat).active;
}

// ---------------------------------------------------------------- taux de confirmation terrain

export type GenreTaux = "aucun" | "insuffisant" | "suffisant";

export interface AffichageTaux {
  genre: GenreTaux;
  confirmees: number;
  infirmees: number;
  jugees: number;
  /** Pourcentage 0-100 calcule depuis les effectifs, ou null s'il n'y a aucun verdict. */
  pourcentage: number | null;
  /** Texte principal : « Aucun verdict », « 60,7 % ». */
  valeur: string;
  /** Mention obligatoire sous le seuil : « échantillon insuffisant (n = 12) », sinon null. */
  mention: string | null;
  seuil: number;
}

/** « 60,7 % » : une decimale, virgule francaise, espace insecable avant le signe. */
export function formaterPourcentage(p: number): string {
  return `${p.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\u00a0%`;
}

/**
 * Taux de confirmation = confirmees / (confirmees + infirmees) (contrat paragraphe 1, point 3).
 * Calcule ici depuis les EFFECTIFS, pas depuis une valeur toute faite : l'affichage ne peut pas
 * diverger des comptes qu'il montre a cote. Ce n'est PAS la precision statistique.
 *
 * - 0 verdict : « Aucun verdict », jamais 0 % ;
 * - sous le seuil : la valeur est montree AVEC « échantillon insuffisant (n = ... ) » ;
 * - le serveur peut exiger davantage (`echantillonSuffisant: false`) : on retient le plus prudent.
 */
export function affichageTaux(t: { confirmees: number; infirmees: number; seuil?: number | null; echantillonSuffisant?: boolean }): AffichageTaux {
  const confirmees = Math.max(0, Math.trunc(t.confirmees));
  const infirmees = Math.max(0, Math.trunc(t.infirmees));
  const jugees = confirmees + infirmees;
  const seuil = t.seuil && t.seuil > 0 ? t.seuil : SEUIL_ECHANTILLON_PAR_DEFAUT;
  if (jugees === 0) {
    return { genre: "aucun", confirmees, infirmees, jugees, pourcentage: null, valeur: "Aucun verdict", mention: null, seuil };
  }
  const pourcentage = (confirmees / jugees) * 100;
  const suffisant = jugees >= seuil && t.echantillonSuffisant !== false;
  return {
    genre: suffisant ? "suffisant" : "insuffisant",
    confirmees, infirmees, jugees, pourcentage,
    valeur: formaterPourcentage(pourcentage),
    mention: suffisant ? null : `échantillon insuffisant (n = ${jugees})`,
    seuil,
  };
}

export const MENTION_NON_PRECISION =
  "Ce taux n'est pas la précision statistique de la détection : il ne voit pas les changements réels que la méthode n'a pas détectés. Il ne mesure que la part des propositions jugées que le terrain a confirmées.";

// ---------------------------------------------------------------- confiance, rattachement, qualite

export interface AffichageConfiance { texte: string; nature: string; signification: string; calibree: boolean }

/**
 * Un pourcentage n'est presente comme probabilite que s'il est calibre (contrat, principe 5). Sinon
 * c'est un « indice non calibre », affiche en nombre a deux decimales (l'echelle 0 a 1 est celle des
 * scores deja deposes par le depot ; le serveur dit, dans `signification`, ce que la valeur veut dire).
 */
export function affichageConfianceDetection(c: { valeur: number | null; calibree: boolean; signification: string }): AffichageConfiance {
  if (c.valeur === null || Number.isNaN(c.valeur)) {
    return { texte: "Non renseignée", nature: "Confiance de détection", signification: c.signification, calibree: c.calibree };
  }
  if (c.calibree) {
    return { texte: `${Math.round(c.valeur * 100)}\u00a0%`, nature: "Probabilité calibrée", signification: c.signification, calibree: true };
  }
  return {
    texte: `indice ${c.valeur.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    nature: "Indice non calibré", signification: c.signification, calibree: false,
  };
}

export interface AffichageRattachement {
  /** Vrai si le rattachement est assez sur pour NOMMER le troncon sans reserve. */
  fiable: boolean;
  titre: string;
  zone: string | null;
  reserve: string | null;
}

/**
 * Le troncon n'est nomme que si le rattachement est fiable (HAUTE ou MOYENNE). Un rattachement
 * faible ou absent donne « Anomalie non rattachée » ; le troncon candidat reste visible en reserve,
 * pour que rien ne soit cache, mais il n'est pas affirme.
 */
export function affichageRattachement(p: Pick<Proposition, "rattachee" | "troncon" | "rattachement">): AffichageRattachement {
  const t = p.troncon;
  const fiable = !!(p.rattachee && t && (p.rattachement.confiance === "HAUTE" || p.rattachement.confiance === "MOYENNE"));
  if (fiable && t) {
    return { fiable: true, titre: `${t.code} · ${t.nom}`, zone: t.regionNom ?? null, reserve: null };
  }
  const reserve = t && p.rattachee ? `Tronçon candidat : ${t.code} · ${t.nom}, rattachement de confiance faible. À confirmer sur le terrain.` : null;
  return { fiable: false, titre: "Anomalie non rattachée", zone: t?.regionNom ?? null, reserve };
}

export function libelleQualiteImage(q: { couvertureNuagesPct: number | null; note: string | null }): string {
  if (q.couvertureNuagesPct === null && !q.note) return "Non renseignée";
  const nuages = q.couvertureNuagesPct === null ? null : `${q.couvertureNuagesPct.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}\u00a0% de nuages`;
  return [nuages, q.note].filter(Boolean).join(" · ");
}

export function formaterResolution(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "Résolution non renseignée";
  return `${m.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}\u00a0m`;
}

// ---------------------------------------------------------------- dates

/** « 23 oct. 2026 » (jour calendaire UTC : la Guinee est a UTC+0, et le rendu reste deterministe). */
export function formaterDate(iso: string | null | undefined): string {
  if (!iso) return "Date inconnue";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Date inconnue";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formaterDateHeure(iso: string | null | undefined): string {
  if (!iso) return "Date inconnue";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Date inconnue";
  return d.toLocaleString("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export function acquisitionAncienne(ageJours: number | null | undefined): boolean {
  return typeof ageJours === "number" && ageJours > SEUIL_ACQUISITION_ANCIENNE_JOURS;
}

// ---------------------------------------------------------------- droits d'affichage (le serveur decide)

export type RoleApp = "ADMIN" | "GESTIONNAIRE" | "INSPECTEUR" | "LECTEUR" | string | undefined;

/** Transitions de statut et affectation : ADMIN et GESTIONNAIRE (contrat paragraphe 2). */
export function peutDecider(role: RoleApp): boolean {
  return role === "ADMIN" || role === "GESTIONNAIRE";
}
/** Gestion des sources : ADMIN seulement. */
export function peutGererSources(role: RoleApp): boolean {
  return role === "ADMIN";
}

export type ActionDecision = "CONFIRMER" | "INFIRMER" | "METTRE_EN_ATTENTE" | "DEMANDER_INFORMATIONS" | "NON_CONCLUANTE" | "REMETTRE_A_VERIFIER" | "AFFECTER";

export interface DefinitionAction {
  action: ActionDecision;
  libelle: string;
  /** Statut cible pour une transition ; absent pour l'affectation. */
  vers?: StatutProposition;
  motifAttente?: "INFO_DEMANDEE" | "AUTRE";
  /** Phrase de la page d'aide : ce que fait l'action. */
  effet: string;
}

const ACTIONS: Record<ActionDecision, DefinitionAction> = {
  CONFIRMER: { action: "CONFIRMER", libelle: "Confirmer", vers: "CONFIRMEE", effet: "Le terrain a constaté le changement. Le verdict est définitif." },
  INFIRMER: { action: "INFIRMER", libelle: "Infirmer", vers: "INFIRMEE", effet: "Le terrain n'a pas constaté le changement. Le verdict est définitif." },
  METTRE_EN_ATTENTE: { action: "METTRE_EN_ATTENTE", libelle: "Mettre en attente", vers: "EN_ATTENTE", motifAttente: "AUTRE", effet: "La proposition reste ouverte ; elle pourra être reprise ou jugée plus tard." },
  DEMANDER_INFORMATIONS: { action: "DEMANDER_INFORMATIONS", libelle: "Demander des informations", vers: "EN_ATTENTE", motifAttente: "INFO_DEMANDEE", effet: "La proposition passe en attente avec le motif « informations demandées »." },
  NON_CONCLUANTE: { action: "NON_CONCLUANTE", libelle: "Non concluante", vers: "NON_CONCLUANTE", effet: "L'image ou le terrain ne permettent pas de trancher. Cela ne compte ni comme confirmation ni comme infirmation." },
  REMETTRE_A_VERIFIER: { action: "REMETTRE_A_VERIFIER", libelle: "Remettre à vérifier", vers: "A_VERIFIER", effet: "La proposition retourne dans la file à vérifier." },
  AFFECTER: { action: "AFFECTER", libelle: "Affecter à une inspection", effet: "Crée une mission de vérification en brouillon, avec la région, l'emprise et le tronçon de la proposition." },
};

export function definitionAction(a: ActionDecision): DefinitionAction {
  return ACTIONS[a];
}

/**
 * Actions OFFERTES selon le role et le statut. C'est une commodite d'affichage : le serveur refuse
 * ce que le role ou la transition n'autorisent pas, et l'ecran affiche alors son refus.
 * Un verdict (CONFIRMEE, INFIRMEE) est definitif : aucune action de decision.
 */
export function actionsOffertes(role: RoleApp, statut: string, missionId: string | null): DefinitionAction[] {
  if (!peutDecider(role)) return [];
  const liste: ActionDecision[] = [];
  if (statut === "A_VERIFIER") liste.push("CONFIRMER", "INFIRMER", "METTRE_EN_ATTENTE", "DEMANDER_INFORMATIONS", "NON_CONCLUANTE");
  // EN_ATTENTE vers EN_ATTENTE est permis par le serveur : on peut relancer l'attente (nouveau motif) ou demander des informations.
  else if (statut === "EN_ATTENTE") liste.push("CONFIRMER", "INFIRMER", "METTRE_EN_ATTENTE", "DEMANDER_INFORMATIONS", "NON_CONCLUANTE", "REMETTRE_A_VERIFIER");
  else if (statut === "NON_CONCLUANTE") liste.push("CONFIRMER", "INFIRMER", "METTRE_EN_ATTENTE", "REMETTRE_A_VERIFIER");
  if ((statut === "A_VERIFIER" || statut === "EN_ATTENTE" || statut === "NON_CONCLUANTE") && !missionId) liste.push("AFFECTER");
  return liste.map(definitionAction);
}

// ---------------------------------------------------------------- constat exige par un verdict

/** CONFIRMER et INFIRMER sont des verdicts : le serveur exige alors un constat de terrain (`CONSTAT_REQUIS`, 400). */
export function exigeConstat(action: ActionDecision): boolean {
  return action === "CONFIRMER" || action === "INFIRMER";
}

export interface EtatConstat { suffisant: boolean; raison: string | null }

/**
 * Un verdict cite SON constat : au moins une observation liee OU une reference de constat (comme le serveur,
 * `verifierTransition`). Mise en attente et non concluante n'en exigent pas. `raison` dit pourquoi le bouton reste inactif.
 */
export function etatConstat(a: { action: ActionDecision; nbObservations: number; reference: string }): EtatConstat {
  if (!exigeConstat(a.action)) return { suffisant: true, raison: null };
  if (a.reference.trim().length > CONSTAT_REF_MAX) {
    return { suffisant: false, raison: `La référence du constat tient en ${CONSTAT_REF_MAX} caractères au plus.` };
  }
  if (a.nbObservations > 0 || a.reference.trim().length > 0) return { suffisant: true, raison: null };
  return { suffisant: false, raison: "Un verdict cite le constat de terrain qui le fonde : joignez au moins une observation ou saisissez la référence du constat." };
}

export function estVerdictDefinitif(statut: string): boolean {
  return statut === "CONFIRMEE" || statut === "INFIRMEE";
}

// ---------------------------------------------------------------- cadrage carte

/** Emprise [ouest, sud, est, nord] autour d'un point, pour recadrer la carte sur une proposition. */
export function empriseAutour(c: { lat: number; lon: number }, demi = DEMI_EMPRISE_DEG): [number, number, number, number] {
  return [c.lon - demi, c.lat - demi, c.lon + demi, c.lat + demi];
}

/** Arrondit une emprise (2 decimales) : evite une requete par pixel de deplacement de la carte. */
export function arrondirEmprise(b: [number, number, number, number]): [number, number, number, number] {
  const r = (v: number) => Math.round(v * 100) / 100;
  return [r(b[0]), r(b[1]), r(b[2]), r(b[3])];
}

// ---------------------------------------------------------------- totaux : compteur d'onglet et total filtre

export interface AffichageTotaux {
  /** « Total filtré renvoyé par le serveur : 12 » (et les filtres appliqués, s'il y en a). */
  totalFiltre: string;
  /** Presente seulement si le compteur d'onglet et le total different : dit pourquoi, sans rien deviner. */
  explication: string | null;
}

/**
 * Deux chiffres peuvent coexister a l'ecran : le compteur de l'onglet (la synthese ne suit que la region et la periode)
 * et le total de la liste (tous les filtres). Quand ils different, l'ecran le dit et en donne la cause CONNUE : des
 * filtres supplementaires, sinon deux lectures distinctes du serveur. Compteur indisponible (null) : rien a comparer.
 */
export function affichageTotaux(a: { total: number; compteurOnglet: number | null; autresFiltres: readonly string[]; libelleOnglet: string }): AffichageTotaux {
  const fmt = (n: number) => n.toLocaleString("fr-FR");
  const filtres = a.autresFiltres.length > 0 ? ` (filtres appliqués : ${a.autresFiltres.join(", ")})` : "";
  const totalFiltre = `Total filtré renvoyé par le serveur : ${fmt(a.total)}${filtres}`;
  if (a.compteurOnglet === null || a.compteurOnglet === a.total) return { totalFiltre, explication: null };
  const explication = a.autresFiltres.length > 0
    ? `Le compteur de l'onglet « ${a.libelleOnglet} » (${fmt(a.compteurOnglet)}) ne suit que la région et la période. La liste applique en plus : ${a.autresFiltres.join(", ")}. D'où l'écart avec ce total (${fmt(a.total)}).`
    : `Le compteur de l'onglet « ${a.libelleOnglet} » (${fmt(a.compteurOnglet)}) et ce total (${fmt(a.total)}) viennent de deux lectures distinctes du serveur : ils peuvent différer si des propositions ont changé entre les deux.`;
  return { totalFiltre, explication };
}

// ---------------------------------------------------------------- nom accessible

/** « Dégradation ... tronçon GN N0001 » : suffixe des noms accessibles des actions (distincts par proposition). */
export function nomProposition(p: Pick<Proposition, "type" | "troncon" | "rattachee" | "rattachement">): string {
  const r = affichageRattachement(p);
  return `${libelleType(p.type).toLowerCase()} ${r.fiable ? r.titre : "non rattachée"}`;
}

// ---------------------------------------------------------------- limites, observations masquees, origine des valeurs de repli

/** `limites: null` (colonne vide, ligne d'avant la migration du workflow) : « non renseignees » n'est JAMAIS « aucune limite ». */
export const MESSAGE_LIMITES_NON_RENSEIGNEES = "Limites non renseignées pour cette proposition";

export function limitesNonRenseignees(d: { limites: readonly string[] | null | undefined; limitesNonRenseignees?: boolean }): boolean {
  return d.limitesNonRenseignees === true || d.limites === null || d.limites === undefined;
}

/** « 2 observations hors de votre périmètre ne sont pas affichées » ; vide si rien n'est masqué. */
export function messageObservationsMasquees(n: number | null | undefined): string {
  if (typeof n !== "number" || !(n > 0)) return "";
  const k = Math.trunc(n).toLocaleString("fr-FR");
  return n === 1 ? `${k} observation hors de votre périmètre n'est pas affichée` : `${k} observations hors de votre périmètre ne sont pas affichées`;
}

export interface AffichageResolution {
  /** Intitule de la ligne : « Résolution native », ou « Résolution du produit livré » pour une valeur de repli. */
  intitule: string;
  valeur: string;
  /** Mention d'origine d'un repli (resolution ou capteur) ; null si la valeur est celle du produit. */
  note: string | null;
  native: boolean;
}

/**
 * La resolution et le capteur d'une proposition peuvent venir d'un REPLI du serveur (`resolutionOrigine`, `capteurOrigine`) :
 * une valeur de repli est etiquetee comme telle, jamais presentee comme la resolution native du produit.
 */
export function affichageResolution(s: { resolutionM: number | null; capteur?: string | null; resolutionOrigine?: string | null; capteurOrigine?: string | null }): AffichageResolution {
  const livre = s.resolutionOrigine === "PRODUIT_LIVRE";
  const notes: string[] = [];
  if (livre && s.resolutionM !== null) notes.push("résolution du produit livré, ce n'est pas la résolution native du capteur");
  if (s.capteurOrigine === "SOURCE" && s.capteur) notes.push("capteur de la source, le produit n'en indique pas");
  return {
    intitule: livre ? "Résolution du produit livré" : "Résolution native",
    valeur: formaterResolution(s.resolutionM),
    note: notes.length > 0 ? notes.join(" ; ") : null,
    native: !livre,
  };
}
