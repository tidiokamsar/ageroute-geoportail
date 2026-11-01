/**
 * Parametres du noyau de collecte en roulage (paragraphe 7.13).
 *
 * TOUTES CES VALEURS SONT PROVISOIRES ET NON CALIBREES.
 *
 * Aucune n'a ete mesuree sur un telephone, sur une route de Guinee ni avec le recepteur GNSS
 * d'un appareil reel : le projet n'a, a ce jour, aucun appareil Android (blocage B-10). Elles
 * sont donc des POINTS DE DEPART explicites, jamais des normes. Chacune est :
 *   - nommee ici, a un seul endroit ;
 *   - parametrable a la creation d'une session (`validerParametres`) ;
 *   - recopiee dans la charge utile envoyee au serveur (`parametres` + `provenanceParametres`),
 *     pour qu'une analyse puisse toujours dire avec quels seuils la collecte a ete filtree.
 *
 * Le noyau n'importe rien du navigateur (ni DOM, ni stockage, ni reseau) : il tourne a
 * l'identique dans la PWA, dans une coque Capacitor et sous Node pour les tests.
 */

export interface ParametresRoulage {
  /** Cadence attendue des positions, en ms. 1 Hz = 1000 (critere A18). */
  intervalleAttenduMs: number;
  /** Precision annoncee au-dela de laquelle un echantillon est ecarte, en metres. */
  precisionMaxM: number;
  /** Si vrai, un echantillon sans precision annoncee est ecarte. Faux : il est garde, precision nulle. */
  refuserSansPrecision: boolean;
  /** Vitesse implicite au-dela de laquelle un saut de position est tenu pour une derive, en km/h. */
  vitesseMaxKmH: number;
  /** Ecart entre deux echantillons acceptes au-dela duquel un TROU est enregistre, en ms. */
  trouMs: number;
  /** Ecart au-dela duquel la trace est COUPEE en deux segments (le serveur ne les relie pas), en ms. */
  coupureSegmentMs: number;
  /** Nombre d'echantillons consecutifs a la meme position, vitesse annoncee non nulle, avant de parler de fix fige. */
  fixFigeEchantillons: number;
  /** Vitesse annoncee (m/s) au-dela de laquelle une position immobile est suspecte. */
  vitesseMouvementMs: number;
  /** Rejets consecutifs pour saut impossible apres lesquels la nouvelle position devient la reference. */
  reancrageApresRejets: number;
  /** Ecart tolere entre l'horodatage GNSS d'un echantillon et l'horloge de l'appareil a sa reception, en ms. */
  deriveHorlogeMs: number;
  /** Anciennete maximale du dernier fix pour qu'un marqueur soit tenu pour positionne, en ms. */
  ageFixMaxMarqueurMs: number;
  /** Budget logiciel de pose d'un marqueur, en ms (critere A16 : 200 ms). Mesure LOGICIELLE seulement. */
  budgetLatenceLogicielleMs: number;
  /** Duree minimale d'un evenement lineaire, en ms. */
  dureeMinEvenementMs: number;
  /** Part minimale de la duree d'un evenement couverte par des echantillons, entre 0 et 1. */
  couvertureMinEvenement: number;
  /** Distance directe minimale debut-fin d'un evenement, en metres (alignee sur la portion minimale du serveur). */
  distanceMinEvenementM: number;
}

export const PROVENANCE_PARAMETRES = "PROVISOIRE_NON_CALIBRE" as const;

export const PARAMETRES_PROVISOIRES: Readonly<ParametresRoulage> = Object.freeze({
  intervalleAttenduMs: 1000,
  // Alignee sur le seuil de rattachement du noyau serveur (appariement.noyau.ts), pas mesuree.
  precisionMaxM: 50,
  refuserSansPrecision: false,
  vitesseMaxKmH: 200,
  trouMs: 5000,
  coupureSegmentMs: 30_000,
  fixFigeEchantillons: 10,
  vitesseMouvementMs: 1,
  reancrageApresRejets: 5,
  deriveHorlogeMs: 2000,
  ageFixMaxMarqueurMs: 2000,
  budgetLatenceLogicielleMs: 200,
  dureeMinEvenementMs: 1000,
  couvertureMinEvenement: 0.8,
  distanceMinEvenementM: 10,
});

export type ValidationParametres =
  | { ok: true; parametres: ParametresRoulage }
  | { ok: false; erreurs: string[] };

const POSITIFS: (keyof ParametresRoulage)[] = [
  "intervalleAttenduMs", "precisionMaxM", "vitesseMaxKmH", "trouMs", "coupureSegmentMs", "deriveHorlogeMs",
  "ageFixMaxMarqueurMs", "budgetLatenceLogicielleMs", "vitesseMouvementMs",
];
const ENTIERS_POSITIFS: (keyof ParametresRoulage)[] = ["fixFigeEchantillons", "reancrageApresRejets"];

/** Complete les valeurs par defaut et refuse toute valeur incoherente. Rien n'est corrige en silence. */
export function validerParametres(surcharge: Partial<ParametresRoulage> = {}): ValidationParametres {
  const p: ParametresRoulage = { ...PARAMETRES_PROVISOIRES, ...surcharge };
  const erreurs: string[] = [];
  for (const k of POSITIFS) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) erreurs.push(`${k} doit etre un nombre strictement positif`);
  }
  for (const k of ENTIERS_POSITIFS) {
    const v = p[k];
    if (!Number.isInteger(v) || (v as number) < 1) erreurs.push(`${k} doit etre un entier superieur ou egal a 1`);
  }
  if (!Number.isFinite(p.dureeMinEvenementMs) || p.dureeMinEvenementMs < 0) erreurs.push("dureeMinEvenementMs doit etre positif ou nul");
  if (!Number.isFinite(p.distanceMinEvenementM) || p.distanceMinEvenementM < 0) erreurs.push("distanceMinEvenementM doit etre positif ou nul");
  if (!(p.couvertureMinEvenement > 0 && p.couvertureMinEvenement <= 1)) erreurs.push("couvertureMinEvenement doit etre dans ]0 ; 1]");
  if (typeof p.refuserSansPrecision !== "boolean") erreurs.push("refuserSansPrecision doit etre booleen");
  if (p.trouMs < p.intervalleAttenduMs) erreurs.push("trouMs ne peut pas etre inferieur a intervalleAttenduMs");
  if (p.coupureSegmentMs < p.trouMs) erreurs.push("coupureSegmentMs ne peut pas etre inferieur a trouMs");
  return erreurs.length > 0 ? { ok: false, erreurs } : { ok: true, parametres: p };
}
