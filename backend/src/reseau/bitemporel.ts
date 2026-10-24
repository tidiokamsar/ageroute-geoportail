/**
 * Historisation bitemporelle : les regles, sans la base.
 *
 * DEUX AXES DE TEMPS, ET POURQUOI UN SEUL NE SUFFIT PAS
 *
 * Le paragraphe 7.2 du mandat v2.1 exige « `valide_du` / `valide_au` (date d'effet terrain) +
 * `enregistre_le` (date systeme) ». La distinction n'est pas une subtilite de modelisation.
 *
 * Une route est reprise le 15 mars. Un agent le releve le 2 avril. Deux questions, deux
 * reponses :
 *
 *   « Quel etait l'etat au 20 mars ? »        axe TERRAIN   -> repris
 *   « Que savait-on le 25 mars de l'etat ? »  axe SYSTEME   -> pas encore repris
 *
 * La seconde est celle qu'un bailleur pose en demandant sur quelles donnees une programmation
 * a ete decidee. Sans elle, un programme arrete en mars paraitrait avoir ignore une
 * information qui n'existait pas encore — et personne ne pourrait prouver le contraire.
 *
 * CE QUE LE MODELE PORTAIT DEJA
 *
 * `portions` porte `observeeLe` (date de constat), `createdAt` (date systeme) et `remplaceeLe`
 * (cloture systeme). Il manquait une date d'effet de FIN : `remplaceeLe` dit quand on a
 * ENREGISTRE le remplacement, pas quand la realite a change.
 *
 * `observeeLe` n'est pas renomme en `valideDu`, et ce n'est pas de la prudence : ce sont deux
 * choses. Un agent peut constater le 2 avril qu'une piste est en laterite DEPUIS l'an dernier.
 * `observeeLe` dit quand on a regarde, `valideDu` depuis quand c'est vrai.
 *
 * L'INTERVALLE EST SEMI-OUVERT : [valideDu, valideAu)
 *
 * Ferme des deux cotes, deux versions successives seraient toutes deux valides a l'instant de
 * la bascule, et toute requete a cette date rendrait deux reponses. La convention semi-ouverte
 * supprime cette classe entiere d'ambiguites. C'est la meme raison qui fait preferer
 * `debutM <= x < finM` aux abscisses dans `portions.ts`.
 *
 * CE MODULE EST PUR
 *
 * Aucun acces a Prisma, aucune date « maintenant » lue implicitement. Les deux sont
 * volontaires : les regles doivent etre eprouvables sans base — il n'en existe aucune en
 * developpement (B-13) — et un module qui lit l'horloge n'est pas testable deux fois de la
 * meme facon.
 */

/** Une version d'objet patrimonial, sur les deux axes de temps. */
export interface VersionTemporelle {
  id: string;
  /** Depuis quand le contenu de cette version est VRAI SUR LE TERRAIN. */
  valideDu: Date | null;
  /** Jusqu'a quand, EXCLU. Nulle quand la version est encore vraie. */
  valideAu: Date | null;
  /** Quand le systeme a enregistre cette version. Axe systeme. */
  enregistreLe: Date;
  /** Quand le systeme a enregistre son remplacement. Axe systeme, distinct de `valideAu`. */
  remplaceeLe: Date | null;
  /** Suppression logique : la version n'aurait jamais du etre saisie. */
  deletedAt: Date | null;
}

export type RefusVersion =
  | "SANS_DATE_EFFET"
  | "DATE_INVALIDE"
  | "FIN_AVANT_DEBUT"
  | "INTERVALLE_VIDE";

/** Explications destinees a une personne, pas a un journal technique. */
export const MOTIFS_REFUS_VERSION: Readonly<Record<RefusVersion, string>> = {
  SANS_DATE_EFFET:
    "Cette version n'a pas de date d'effet : impossible de dire depuis quand elle est vraie.",
  DATE_INVALIDE:
    "Une des dates de cette version n'est pas une date exploitable.",
  FIN_AVANT_DEBUT:
    "La fin de validite precede le debut : la version ne serait vraie a aucun moment.",
  INTERVALLE_VIDE:
    "Le debut et la fin de validite sont identiques, donc la version ne couvre aucune duree.",
};

function dateValide(d: Date | null | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * Ce qui empeche une version d'etre situee dans le temps. Rend `null` quand elle est saine.
 *
 * Une version refusee n'est pas corrigee ni ecartee en silence : `valideA` la rend fausse a
 * toute date, et `versionA` l'ignore. Le refus est donc visible dans le resultat, pas absorbe.
 */
export function refusVersion(v: VersionTemporelle): RefusVersion | null {
  if (v.valideDu === null) return "SANS_DATE_EFFET";
  if (!dateValide(v.valideDu)) return "DATE_INVALIDE";
  if (v.valideAu !== null) {
    if (!dateValide(v.valideAu)) return "DATE_INVALIDE";
    if (v.valideAu.getTime() < v.valideDu.getTime()) return "FIN_AVANT_DEBUT";
    if (v.valideAu.getTime() === v.valideDu.getTime()) return "INTERVALLE_VIDE";
  }
  return null;
}

/** Cette version est-elle vraie sur le terrain a cette date ? Intervalle semi-ouvert. */
export function valideA(v: VersionTemporelle, date: Date): boolean {
  if (refusVersion(v) !== null) return false;
  if (v.deletedAt !== null) return false;
  const t = date.getTime();
  // `valideDu` est non nul : `refusVersion` l'a deja garanti.
  if (t < (v.valideDu as Date).getTime()) return false;
  if (v.valideAu !== null && t >= v.valideAu.getTime()) return false;
  return true;
}

/**
 * La version vraie a une date de terrain, ou `null`.
 *
 * DEVANT UN CHEVAUCHEMENT, REND LA PLUS RECEMMENT ENREGISTREE. Deux versions valides a la
 * meme date sont une anomalie, que `chevauchementsTemporels` signale. Mais une requete doit
 * rendre UNE reponse : prendre la derniere connaissance enregistree est le choix le moins
 * arbitraire, et surtout il est DETERMINISTE — deux appels identiques rendent le meme
 * resultat, ce qu'exige le critere A22 pour qu'un programme soit reproductible.
 */
export function versionA(
  versions: readonly VersionTemporelle[],
  date: Date,
): VersionTemporelle | null {
  const candidates = versions.filter((v) => valideA(v, date));
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    b.enregistreLe.getTime() > a.enregistreLe.getTime() ? b : a);
}

/**
 * Ce que le systeme CONNAISSAIT a une date donnee, sur l'axe systeme.
 *
 * C'est ce qui rend l'historisation bitemporelle et non simplement versionnee. Les versions
 * enregistrees apres `dateSysteme` n'existaient pas encore : elles sont retirees. Et une
 * version dont le remplacement n'avait pas encore ete enregistre reapparait OUVERTE, puisque
 * c'est ainsi qu'on la voyait.
 *
 * Ce dernier point est l'essentiel : rendre la version avec son `valideAu` actuel ferait
 * croire qu'on savait deja qu'elle allait finir.
 */
export function telQuEnregistreA(
  versions: readonly VersionTemporelle[],
  dateSysteme: Date,
): VersionTemporelle[] {
  const t = dateSysteme.getTime();
  return versions
    .filter((v) => v.enregistreLe.getTime() <= t)
    .map((v) => {
      const remplacementConnu = v.remplaceeLe !== null && v.remplaceeLe.getTime() <= t;
      if (remplacementConnu) return v;
      // Le remplacement n'etait pas encore enregistre : la version paraissait ouverte.
      return { ...v, valideAu: null, remplaceeLe: null };
    });
}

/**
 * Clot une version a une DATE D'EFFET, et non a « maintenant ».
 *
 * C'est le geste qui distingue les deux axes. `remplaceeLe` se pose au moment de
 * l'enregistrement, par la couche de persistance ; `valideAu` se pose a la date ou la realite
 * a change, que l'agent rapporte.
 *
 * Leve plutot que de rendre un resultat degrade : clore avant le debut produirait une version
 * vraie a aucune date, et cette perte serait silencieuse.
 */
export function clore(v: VersionTemporelle, dateEffet: Date): VersionTemporelle {
  const candidate: VersionTemporelle = { ...v, valideAu: dateEffet };
  const refus = refusVersion(candidate);
  if (refus !== null) {
    throw new Error(`${refus} : ${MOTIFS_REFUS_VERSION[refus]}`);
  }
  return candidate;
}

export interface ChevauchementTemporel {
  a: string;
  b: string;
  /** Debut de la periode commune. */
  duM: Date;
  /** Fin de la periode commune, nulle quand les deux versions sont ouvertes. */
  auM: Date | null;
}

/**
 * Les paires de versions vraies en meme temps.
 *
 * SIGNALE, NE CORRIGE PAS. Meme regle que `chevauchements()` pour les abscisses et que le
 * moteur de qualite : « aucune correction automatique » (paragraphe 7.6). Deux versions
 * concurrentes viennent d'un conflit de saisie ou d'une date d'effet mal rapportee ; trancher
 * demande de savoir laquelle est juste, ce qu'aucun programme ne sait.
 */
export function chevauchementsTemporels(
  versions: readonly VersionTemporelle[],
): ChevauchementTemporel[] {
  const saines = versions.filter((v) => refusVersion(v) === null && v.deletedAt === null);
  const resultat: ChevauchementTemporel[] = [];

  for (let i = 0; i < saines.length; i++) {
    for (let j = i + 1; j < saines.length; j++) {
      const x = saines[i];
      const y = saines[j];
      const debut = Math.max((x.valideDu as Date).getTime(), (y.valideDu as Date).getTime());
      const finX = x.valideAu?.getTime() ?? Number.POSITIVE_INFINITY;
      const finY = y.valideAu?.getTime() ?? Number.POSITIVE_INFINITY;
      const fin = Math.min(finX, finY);
      // Strictement inferieur : deux versions jointives au meme instant ne se chevauchent
      // pas, l'intervalle etant semi-ouvert.
      if (debut < fin) {
        resultat.push({
          a: x.id, b: y.id,
          duM: new Date(debut),
          auM: Number.isFinite(fin) ? new Date(fin) : null,
        });
      }
    }
  }
  return resultat;
}

export interface TrouTemporel {
  duM: Date;
  auM: Date;
}

/**
 * Les periodes ou l'objet n'a aucune version valide, entre sa premiere et sa derniere.
 *
 * NOMMEES PAR LEURS DATES, pas resumees en pourcentage. « 80 % d'historique » n'envoie
 * personne nulle part ; « rien entre le 15/03 et le 01/06 » dit ou chercher. C'est la meme
 * raison qui fait enumerer les trous de couverture spatiale dans `portions.ts`.
 *
 * Une liste vide ne produit AUCUN trou, et non un trou depuis l'origine des temps : un objet
 * sans version n'a pas d'histoire trouee, il n'a pas d'histoire. La nuance se dit ailleurs.
 */
export function trousTemporels(versions: readonly VersionTemporelle[]): TrouTemporel[] {
  const saines = versions
    .filter((v) => refusVersion(v) === null && v.deletedAt === null)
    .slice()
    .sort((a, b) => (a.valideDu as Date).getTime() - (b.valideDu as Date).getTime());

  if (saines.length < 2) return [];

  const trous: TrouTemporel[] = [];
  let couvertJusqua = saines[0].valideAu?.getTime() ?? Number.POSITIVE_INFINITY;

  for (const v of saines.slice(1)) {
    const debut = (v.valideDu as Date).getTime();
    if (debut > couvertJusqua) {
      trous.push({ duM: new Date(couvertJusqua), auM: new Date(debut) });
    }
    const fin = v.valideAu?.getTime() ?? Number.POSITIVE_INFINITY;
    couvertJusqua = Math.max(couvertJusqua, fin);
  }
  return trous;
}
