/**
 * Tableau de bord, Control Tower et Fiche 360 : types de l'API v2 et phrases que les ecrans doivent dire
 * (A12, paragraphe 7.12).
 *
 * TROIS REGLES DE PRESENTATION, ET CHACUNE EVITE UN MENSONGE
 *
 * **Le perimetre est dit avec le chiffre.** « Réseau classé saisi » n'est jamais présenté comme « réseau
 * national » : la base porte une fraction du réseau annoncé par les TDR de la BDR (décision D-06).
 *
 * **Un module sans donnee dit « aucune donnee », pas 0.** Un zero se lit comme un constat (« rien à
 * signaler »), alors que la table peut simplement n'avoir jamais été alimentée.
 *
 * **Un montant en GNF reste une chaine.** Il dépasse 2^53 sur le registre complet : le convertir en
 * nombre fausserait les derniers chiffres sans le dire.
 */

export type Valeur = number | string | null;
export type Unite = "nombre" | "km" | "GNF" | "part";
export type Groupe = "reseau" | "portions" | "qualite" | "veille" | "patrouilles" | "teledetection" | "programmation";

export interface PerimetreIndicateur { code: string; libelle: string; definition: string }

export interface IndicateurEvalue {
  code: string;
  libelle: string;
  groupe: Groupe;
  unite: Unite;
  perimetre: PerimetreIndicateur;
  statut: "CALCULE" | "INDISPONIBLE" | "ERREUR";
  valeur: Valeur;
  motif: string | null;
  aucuneDonnee: boolean;
  sourceLibelle: string | null;
}

export interface PorteeCompte { national: boolean; regions: { id: number; nom: string }[] }

export interface ReponseIndicateurs { genereLe: string; portee: PorteeCompte; indicateurs: IndicateurEvalue[] }

export interface ModuleControlTower {
  code: string;
  libelle: string;
  lien: string;
  indicateurs: IndicateurEvalue[];
  aucuneDonnee: boolean;
  indisponible: boolean;
}

export interface ReponseControlTower { genereLe: string; portee: PorteeCompte; modules: ModuleControlTower[]; nonCouvert: string[] }

export interface ResultatControle {
  code: string;
  libelle: string;
  unite: Unite;
  statut: "EGAL" | "ECART" | "INDISPONIBLE" | "ERREUR";
  calcul: Valeur;
  controle: Valeur;
  motif: string | null;
}

export interface RapportControle {
  genereLe: string;
  total: number;
  egaux: number;
  ecarts: number;
  erreurs: number;
  indisponibles: number;
  resultats: ResultatControle[];
}

/** Espace fine insecable : separateur de milliers de la typographie francaise, sans conversion en nombre. */
const FINE = String.fromCharCode(0x202f);

/** Une chaine de chiffres regroupee par trois, sans jamais la convertir en nombre. */
export function grouperChiffres(chiffres: string): string {
  if (!/^\d+$/.test(chiffres)) return chiffres;
  return chiffres.replace(/\B(?=(\d{3})+(?!\d))/g, FINE);
}

function decimales(v: number, n: number): string {
  return v.toLocaleString("fr-FR", { minimumFractionDigits: n, maximumFractionDigits: n });
}

/** La valeur telle qu'on la lit, avec son unite. `null` : « non calculable », jamais « 0 ». */
export function formaterValeur(valeur: Valeur, unite: Unite): string {
  if (valeur === null) return "non calculable";
  if (typeof valeur === "string") return unite === "GNF" ? `${grouperChiffres(valeur)}${FINE}GNF` : valeur;
  switch (unite) {
    case "km": return `${valeur.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}${FINE}km`;
    case "part": return `${decimales(valeur * 100, 1)}${FINE}%`;
    case "GNF": return `${grouperChiffres(String(valeur))}${FINE}GNF`;
    default: return valeur.toLocaleString("fr-FR");
  }
}

export type EtatAffichage = "valeur" | "aucune-donnee" | "indisponible" | "erreur";

export function etatAffichage(i: Pick<IndicateurEvalue, "statut" | "aucuneDonnee">): EtatAffichage {
  if (i.statut === "INDISPONIBLE") return "indisponible";
  if (i.statut === "ERREUR") return "erreur";
  return i.aucuneDonnee ? "aucune-donnee" : "valeur";
}

/** Le texte principal d'un indicateur : sa valeur, ou pourquoi il n'y en a pas. */
export function texteIndicateur(i: IndicateurEvalue): string {
  switch (etatAffichage(i)) {
    case "indisponible": return "Indisponible hors périmètre national";
    case "erreur": return "Calcul en erreur";
    case "aucune-donnee": return i.sourceLibelle ? `Aucune donnée (${i.sourceLibelle} : rien d'enregistré dans ce périmètre)` : "Aucune donnée";
    default: return formaterValeur(i.valeur, i.unite);
  }
}

/**
 * Indicateurs dont une valeur positive appelle un traitement : ceux que la Control Tower met en avant.
 * Aucun seuil n'est applique : zero est « rien a traiter », tout le reste est « a traiter ».
 */
export const INDICATEURS_A_TRAITER: readonly string[] = [
  "evenements_non_pris_en_compte", "trous_de_permanence", "patrouilles_en_retard", "propositions_a_verifier",
  "troncons_geometrie_invalide", "portions_chevauchantes", "chantiers_en_retard",
];

export function aTraiter(i: IndicateurEvalue): boolean {
  return INDICATEURS_A_TRAITER.includes(i.code) && etatAffichage(i) === "valeur" && typeof i.valeur === "number" && i.valeur > 0;
}

export const LIBELLE_GROUPE: Record<Groupe, string> = {
  reseau: "Réseau et patrimoine",
  portions: "Portions et état constaté",
  qualite: "Qualité des données",
  veille: "Cellule de veille",
  patrouilles: "Patrouilles programmées",
  teledetection: "Observation de la Terre",
  programmation: "Programme, réalisé et budget",
};

/** Qui voit quoi : la portee du compte, en une phrase. */
export function textePortee(p: PorteeCompte): string {
  if (p.national) return "Votre périmètre : national (toutes les régions).";
  const noms = p.regions.map((r) => r.nom).join(", ");
  return `Votre périmètre : ${p.regions.length > 1 ? "régions" : "région"} ${noms}. Les indicateurs sans ventilation régionale ne vous sont pas communiqués.`;
}

/** Les perimetres distincts d'une liste d'indicateurs, dans l'ordre d'apparition. */
export function perimetresDistincts(indicateurs: readonly IndicateurEvalue[]): PerimetreIndicateur[] {
  const vus = new Map<string, PerimetreIndicateur>();
  for (const i of indicateurs) if (!vus.has(i.perimetre.code)) vus.set(i.perimetre.code, i.perimetre);
  return [...vus.values()];
}

export function resumeControle(r: RapportControle): string {
  const ecarts = r.ecarts === 1 ? "1 écart" : `${r.ecarts} écarts`;
  const erreurs = r.erreurs > 0 ? `, ${r.erreurs} en erreur` : "";
  const indispo = r.indisponibles > 0 ? `, ${r.indisponibles} indisponible${r.indisponibles > 1 ? "s" : ""} pour votre périmètre` : "";
  return `${r.total} indicateurs rapprochés de leur requête de contrôle : ${r.egaux} égaux, ${ecarts}${erreurs}${indispo}.`;
}

// ===================================================================================== Fiche 360

export interface VersionPortion {
  id: string;
  debutM: number;
  finM: number;
  etat: string | null;
  etatLibelle: string | null;
  revetement: string | null;
  statutValidation: string;
  origine: string;
  valideDu: string | null;
  valideAu: string | null;
  enregistreLe: string;
  observeeLe: string | null;
  remplaceeLe: string | null;
  courante: boolean;
  issueDe: string[];
}

export interface VoletPortions {
  tronconId: string;
  tronconCode: string;
  tronconNom: string;
  courantes: VersionPortion[];
  historique: VersionPortion[];
  tronque: boolean;
  plafond: number;
  comptes: { courantes: number; remplacees: number; sansDateEffet: number };
}

export interface VoletProgrammation {
  tronconId: string;
  tronconCode: string;
  previsions: {
    id: string; annee: number; intitule: string; statut: string; source: string;
    bailleur: string | null; typeIntervention: string | null; priorite: number | null; montantPrevuGnf: string;
  }[];
  totaux: { statut: string; nb: number; montantGnf: string }[];
  chantiers: {
    id: string; intitule: string; statut: string; avancementPct: number; entreprise: string;
    montantGnf: string | null; dateDebutPrevue: string | null; dateFinPrevue: string | null;
  }[];
  interventionsFigees: { disponible: false; motif: string };
}

export const LIBELLE_STATUT_VALIDATION: Record<string, string> = {
  VALIDE: "Validée", A_VALIDER: "Proposition", REJETE: "Rejetée", A_CORRIGER: "À corriger",
};

export const LIBELLE_STATUT_PREVISION: Record<string, string> = {
  PROPOSE: "Proposée", RETENU: "Retenue", REPORTE: "Reportée", ANNULE: "Annulée", REALISE: "Réalisée",
};

/** « 0 m à 400 m », « 1,2 km à 2,0 km » : les abscisses, jamais des pourcentages. */
export function emprise(debutM: number, finM: number): string {
  const f = (m: number) => (m >= 1000 ? `${decimales(m / 1000, 2)}${FINE}km` : `${Math.round(m)}${FINE}m`);
  return `${f(debutM)} à ${f(finM)}`;
}

/** Une date AAAA-MM-JJ ou un instant ISO, en jour francais ; `null` : « non renseignée ». */
export function jourFr(iso: string | null): string {
  if (!iso) return "non renseignée";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR", { timeZone: "UTC" });
}
