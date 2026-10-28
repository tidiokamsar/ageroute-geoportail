import type { EchantillonRetenu, ParametresRoulage, ResumeSession } from "../roulage";
import { ecrireStockageLocal, lireStockageLocal, majCompteursCourant, retirerStockageLocal } from "./compteCourant";

/**
 * Ce que l'ecran d'enregistrement en roulant AFFICHE, calcule hors du composant pour etre testable.
 * Rien ici ne touche le noyau de collecte ni le serveur : ce sont des libelles, des profils et des
 * lectures d'etat. Les seuils sont PROVISOIRES et NON CALIBRES (aucun appareil, aucune mesure en roulant).
 */

// ------------------------------------------------------------------ profils de precision

export type CodeProfil = "standard" | "strict" | "tolerant";

export interface ProfilPrecision {
  code: CodeProfil;
  libelle: string;
  explication: string;
  /** Seule la precision maximale change : les autres seuils restent ceux du noyau. */
  parametres: Pick<ParametresRoulage, "precisionMaxM">;
}

/**
 * Trois profils, trois valeurs de `precisionMaxM`. Les valeurs sont des CHOIX de depart, pas des normes : 50 m est
 * la valeur par defaut du noyau, alignee sur le noyau serveur. Le profil choisi part avec la session (les parametres
 * sont recopies dans la charge, avec `provenanceParametres`), pour qu'une analyse sache avec quel seuil la trace a ete filtree.
 */
export const PROFILS_PRECISION: readonly ProfilPrecision[] = [
  { code: "standard", libelle: "Standard", explication: "Écarte les positions annoncées à plus de 50 m d'incertitude.", parametres: { precisionMaxM: 50 } },
  { code: "strict", libelle: "Strict", explication: "Écarte au-delà de 20 m : trace plus propre, plus de trous si le signal est médiocre.", parametres: { precisionMaxM: 20 } },
  { code: "tolerant", libelle: "Tolérant", explication: "Écarte au-delà de 100 m : moins de trous, trace moins fidèle.", parametres: { precisionMaxM: 100 } },
];

export function profilParCode(code: string): ProfilPrecision {
  return PROFILS_PRECISION.find((p) => p.code === code) ?? PROFILS_PRECISION[0];
}

// ------------------------------------------------------------------ session vide, qualite

/** Une session sans aucune position retenue n'est pas un releve : aucune trace, rien a envoyer. */
export function sessionVide(resume: Pick<ResumeSession, "echantillons">): boolean {
  return resume.echantillons === 0;
}

export type NiveauQualite = "vide" | "faible" | "moyenne" | "bonne";

export interface QualiteTrace {
  niveau: NiveauQualite;
  libelle: string;
  /** Pourquoi, en phrases : la qualite n'est jamais un chiffre sans explication. */
  raisons: string[];
}

/**
 * Qualite GENERALE d'une trace, d'apres ce que le noyau a mesure : part de positions ecartees et part du temps
 * passee dans des trous. Indicatif : les seuils (20 % / 50 % des positions ecartees, 10 % / 30 % du temps en
 * trou) sont provisoires, non calibres. Ce n'est PAS une mesure de l'exactitude de la position.
 */
export function qualiteTrace(resume: ResumeSession, dureeMs: number): QualiteTrace {
  if (resume.echantillons === 0) return { niveau: "vide", libelle: "Aucune trace", raisons: ["Aucune position valide n'a été enregistrée."] };
  const recues = resume.echantillons + resume.rejetsTotal;
  const partRejets = recues > 0 ? resume.rejetsTotal / recues : 0;
  const partTrous = dureeMs > 0 ? Math.min(1, resume.dureeTrousMs / dureeMs) : 0;
  const raisons: string[] = [];
  if (resume.echantillons < 2) raisons.push("Une seule position retenue : aucune distance ne peut être calculée.");
  if (partRejets > 0.2) raisons.push(`${Math.round(partRejets * 100)} % des positions reçues ont été écartées (précision insuffisante, saut ou doublon).`);
  if (partTrous > 0.1) raisons.push(`${Math.round(partTrous * 100)} % du temps s'est passé sans signal exploitable.`);
  if (resume.interruptions > 0) raisons.push(`${resume.interruptions} interruption(s) du signal ou de la page.`);
  let niveau: NiveauQualite = "bonne";
  if (resume.echantillons < 2 || partRejets > 0.5 || partTrous > 0.3) niveau = "faible";
  else if (partRejets > 0.2 || partTrous > 0.1) niveau = "moyenne";
  const libelle = niveau === "bonne" ? "Trace de bonne qualité" : niveau === "moyenne" ? "Trace de qualité moyenne" : "Trace de faible qualité";
  if (raisons.length === 0) raisons.push("Peu de positions écartées et peu de trous de signal.");
  return { niveau, libelle, raisons };
}

/** Duree reellement enregistree : la duree totale moins les pauses et les trous. Jamais negative. */
export function dureeEffectiveMs(dureeTotaleMs: number, resume: Pick<ResumeSession, "dureeTrousMs">, dureePausesMs: number): number {
  return Math.max(0, dureeTotaleMs - dureePausesMs - resume.dureeTrousMs);
}

// ------------------------------------------------------------------ trace pour la carte

export type PointCarte = [number, number];

/** Les positions retenues, regroupees par segment : deux segments ne sont jamais relies (un trou reste un trou). */
export function segmentsPourCarte(echantillons: readonly EchantillonRetenu[]): PointCarte[][] {
  const parSegment = new Map<number, PointCarte[]>();
  for (const e of echantillons) {
    const liste = parSegment.get(e.segment) ?? [];
    liste.push([e.lat, e.lon]);
    parSegment.set(e.segment, liste);
  }
  return [...parSegment.entries()].sort((a, b) => a[0] - b[0]).map(([, pts]) => pts);
}

// ------------------------------------------------------------------ etat d'une session (sur l'appareil)

/** L'etat de bout en bout d'une session telle que l'agent doit la comprendre. */
export type EtatSessionVue = "preparation" | "enregistrement" | "suspendue" | "interruption_gps" | "terminee_vide" | "terminee_a_envoyer" | "envoi" | "envoyee" | "erreur_envoi";

export function etatSessionVue(args: {
  phase: "repos" | "en_cours" | "pause" | "arretee";
  vide: boolean;
  gpsInterrompu: boolean;
  envoi: "aucun" | "en_cours" | "envoye" | "echec";
}): EtatSessionVue {
  if (args.phase === "repos") return "preparation";
  if (args.phase === "en_cours") return args.gpsInterrompu ? "interruption_gps" : "enregistrement";
  if (args.phase === "pause") return "suspendue";
  if (args.vide) return "terminee_vide";
  if (args.envoi === "en_cours") return "envoi";
  if (args.envoi === "envoye") return "envoyee";
  if (args.envoi === "echec") return "erreur_envoi";
  return "terminee_a_envoyer";
}

export const LIBELLES_ETAT: Record<EtatSessionVue, { libelle: string; ton: "neutre" | "ok" | "attention" | "erreur" }> = {
  preparation: { libelle: "Préparation", ton: "neutre" },
  enregistrement: { libelle: "Enregistrement en cours", ton: "ok" },
  suspendue: { libelle: "En pause", ton: "attention" },
  interruption_gps: { libelle: "Signal GPS interrompu", ton: "erreur" },
  terminee_vide: { libelle: "Terminée sans aucune position", ton: "erreur" },
  terminee_a_envoyer: { libelle: "Terminée, à envoyer", ton: "attention" },
  envoi: { libelle: "Envoi en cours", ton: "attention" },
  envoyee: { libelle: "Envoyée et confirmée par le serveur", ton: "ok" },
  erreur_envoi: { libelle: "Envoi non confirmé", ton: "erreur" },
};

// ------------------------------------------------------------------ envoi confirme, garde sur l'appareil

// Nom de la cle, pose sous le prefixe du compte courant (compteCourant.ts) : la confirmation d'un compte n'est pas celle d'un autre.
const cleEnvoi = (sessionId: string) => `roulage.envoi.${sessionId}`;

/**
 * Le serveur a confirme la session : on le retient sur l'appareil, pour qu'un rechargement de la page ne la
 * presente plus comme « pas encore envoyee ». Jamais ecrit avant la confirmation du serveur.
 */
export function noterEnvoiConfirme(sessionId: string, quand: Date = new Date()): void {
  // Stockage indisponible ou aucun compte ouvert : la session reste « a envoyer », un renvoi est idempotent.
  if (ecrireStockageLocal(cleEnvoi(sessionId), quand.toISOString())) majCompteursCourant({ releves: 0 });
}

export function lireEnvoiConfirme(sessionId: string): string | null {
  return lireStockageLocal(cleEnvoi(sessionId));
}

export function oublierEnvoi(sessionId: string): void {
  retirerStockageLocal(cleEnvoi(sessionId));
}

// ------------------------------------------------------------------ vitesse, stockage

/** Vitesse en km/h, ou `null` : une vitesse absente n'est jamais inventee, un nombre non fini non plus. */
export function vitesseKmH(vitesseMs: number | null | undefined): number | null {
  return typeof vitesseMs === "number" && Number.isFinite(vitesseMs) && vitesseMs >= 0 ? vitesseMs * 3.6 : null;
}

export interface EstimationStockage { usageMo: number; quotaMo: number; part: number }

/** Au-dela de cette part du quota, on previent l'agent : une collecte ne doit pas echouer en silence faute de place. */
export const SEUIL_STOCKAGE_PROCHE = 0.8;

export function stockageProche(e: EstimationStockage | null): boolean {
  return e !== null && e.quotaMo > 0 && e.part >= SEUIL_STOCKAGE_PROCHE;
}
