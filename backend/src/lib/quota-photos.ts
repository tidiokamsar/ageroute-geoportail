import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Plafonds de stockage des photos : ce qui manquait, et ce que cela exposait.
 *
 * L'ETAT CONSTATE LE 12/10/2026
 *
 * `upload-photo.middleware.ts` ne declarait qu'une seule limite :
 * `limits: { fileSize: 8 * 1024 * 1024 }`. Huit mebioctets PAR FICHIER, et rien
 * d'autre — ni nombre de fichiers par objet, ni total par appareil, ni plafond global.
 *
 * Quatre routes acceptent des photos sur ce meme middleware : defauts v2, inspections,
 * ouvrages et ordres de travaux. Toutes sont derriere une authentification, donc le
 * risque n'est pas celui d'un inconnu. Il est plus banal et plus probable : l'application
 * de terrain synchronise SEULE, et une file locale qui se rejoue en boucle televerse sans
 * qu'aucun humain regarde. Mille photos de 8 Mio font huit gigaoctets.
 *
 * Le disque heberge aussi PostgreSQL et le fond de carte du geoportail public. Le remplir
 * n'abime pas seulement la collecte terrain : il arrete la carte.
 *
 * CE QUI NE PROTEGEAIT DEJA PAS
 *
 * La route des defauts dedoublonne par empreinte SHA-256, ce qui est bien fait et ne
 * protege pas de ceci : elle arrete la MEME photo renvoyee, pas mille photos
 * differentes. Un appareil qui prend des cliches en rafale produit mille empreintes
 * distinctes.
 *
 * DEUX PLAFONDS, PARCE QU'IL Y A DEUX PANNES DIFFERENTES
 *
 * 1. PAR OBJET, exact et peu couteux : un simple comptage indexe. Il arrete la panne
 *    realiste — une file qui se rejoue sur un meme defaut — et il s'explique a un agent :
 *    « ce defaut porte deja trente photos ». Un nid-de-poule se documente en trois
 *    cliches, pas en deux cents.
 *
 * 2. GLOBAL, approche et mis en cache : le garde-fou de dernier recours contre la
 *    croissance agregee, celle que le plafond par objet ne voit pas puisqu'elle se repartit
 *    sur des milliers d'objets legitimes.
 *
 * POURQUOI LE PLAFOND GLOBAL EST APPROCHE, ET POURQUOI C'EST ACCEPTABLE
 *
 * Mesurer le repertoire a chaque requete coute un `stat` par fichier. Avec des dizaines
 * de milliers de cliches, cela devient le poste le plus lourd d'un televersement. La
 * mesure est donc mise en cache, selon le meme motif que `longueurReseauPublique` dans
 * `reseau.ts`.
 *
 * Consequence a dire franchement : le depassement toleré vaut au pire
 * (duree du cache) x (debit de televersement). C'est pour cela que le plafond doit etre
 * place NETTEMENT en dessous de la capacite reelle du disque — il signale une derive, il
 * ne tient pas une comptabilite.
 *
 * LES NOMBRES NE SONT PAS UNE DECISION QUE JE PEUX PRENDRE
 *
 * Le cahier des charges ne fixe aucun seuil de media. Les valeurs par defaut ci-dessous
 * sont prudentes et reglables par variable d'environnement, sans migration. Elles valent
 * mieux que l'infini, elles ne valent pas un arbitrage : voir `13_RAPPORT_CONTINUITE`.
 */

/** Nombre de photos par objet. Trente laisse largement la place a un releve complet. */
export const PLAFOND_PHOTOS_PAR_OBJET_DEFAUT = 30;

/** Plafond global du repertoire, en mebioctets. Vingt gibioctets par defaut. */
export const PLAFOND_DISQUE_MIO_DEFAUT = 20 * 1024;

/** Duree de validite de la mesure du repertoire. Voir l'en-tete sur le depassement. */
export const DUREE_CACHE_MS = 60_000;

/**
 * Lit un plafond dans l'environnement, et retombe sur le defaut plutot que sur zero.
 *
 * `PHOTOS_MAX_PAR_OBJET=trente` ou une valeur vide ne doivent pas se transformer en
 * « pas de plafond » : une faute de frappe retirerait silencieusement le garde-fou. Un
 * zero EXPLICITE reste accepte, parce qu'il faut pouvoir desactiver la limite sciemment.
 */
function plafondDepuis(brut: string | undefined, defaut: number): number {
  if (brut === undefined || brut.trim() === "") return defaut;
  const n = Number(brut);
  return Number.isInteger(n) && n >= 0 ? n : defaut;
}

/**
 * Plafonds effectifs.
 *
 * POURQUOI CETTE FONCTION ET PAS `config/env`
 *
 * `config/env` appelle `process.exit(1)` quand `.env` manque. Un middleware qui
 * l'importe entraine ce code dans tout test important une route : le test ne tombe pas en
 * echec, IL NE DEMARRE PAS. C'est arrive ici meme, sur deux fichiers de tests, apres
 * avoir ecrit l'avertissement quatre lignes plus haut dans ce fichier.
 *
 * `env.ts` declare toujours les deux variables — pour la validation au demarrage et pour
 * qu'on les trouve — en reprenant les memes constantes par defaut. Les nombres n'ont donc
 * qu'une seule source.
 */
export function plafonds(source: NodeJS.ProcessEnv = process.env): {
  parObjet: number;
  disqueOctets: number;
} {
  return {
    parObjet: plafondDepuis(source.PHOTOS_MAX_PAR_OBJET, PLAFOND_PHOTOS_PAR_OBJET_DEFAUT),
    disqueOctets:
      plafondDepuis(source.PHOTOS_PLAFOND_DISQUE_MIO, PLAFOND_DISQUE_MIO_DEFAUT) * 1024 * 1024,
  };
}

export type RefusQuota = "PLAFOND_PAR_OBJET" | "DISQUE_SATURE";

export interface EtatQuota {
  /** Photos deja rattachees a l'objet vise. */
  dejaPresentes: number;
  plafondParObjet: number;
  /** Octets occupes par le repertoire des photos, tels que la derniere mesure les donne. */
  octetsUtilises: number;
  plafondOctets: number;
}

/**
 * Peut-on accepter une photo de plus, et sinon laquelle des deux limites bloque.
 *
 * L'ORDRE DES DEUX CONTROLES EST UNE DECISION
 *
 * Le disque passe en premier. Quand il est sature, le probleme n'appartient pas a l'agent
 * et aucun menage sur son objet n'y changera rien : lui repondre « cet objet porte deja
 * trente photos » l'enverrait supprimer des preuves pour rien.
 *
 * Un plafond nul ou negatif est traite comme une absence de plafond plutot que comme un
 * blocage total : une variable d'environnement mal saisie ne doit pas arreter la collecte
 * de tout un pays. Le defaut de configuration se voit alors dans les journaux, pas sur le
 * terrain.
 */
export function refusQuota(e: EtatQuota): RefusQuota | null {
  if (e.plafondOctets > 0 && e.octetsUtilises >= e.plafondOctets) return "DISQUE_SATURE";
  if (e.plafondParObjet > 0 && e.dejaPresentes >= e.plafondParObjet) return "PLAFOND_PAR_OBJET";
  return null;
}

/** Code HTTP : l'un se corrige par l'agent, l'autre non. */
export function statutHttp(motif: RefusQuota): number {
  // 507 et non 503 : le service repond, c'est le stockage qui manque. Un 503 ferait
  // reessayer la file de synchronisation en boucle, ce qui aggraverait exactement la
  // situation qu'on signale.
  return motif === "DISQUE_SATURE" ? 507 : 409;
}

/** Message destine a un agent, et non a un developpeur. */
export const EXPLICATIONS: Record<RefusQuota, string> = {
  PLAFOND_PAR_OBJET:
    "Cet élément porte déjà le nombre maximal de photos. Supprimez-en une avant d'en ajouter.",
  DISQUE_SATURE:
    "Le stockage des photos est saturé côté serveur. Signalez-le à l'administrateur : ce n'est pas corrigeable depuis le terrain.",
};

interface Mesure {
  octets: number;
  mesureA: number;
}

let cache: Mesure | null = null;

/**
 * Octets occupes par le repertoire des photos, mesure mise en cache.
 *
 * `maintenant` est injectable pour que la peremption du cache soit testable sans
 * attendre une minute.
 *
 * Un repertoire absent rend zero et non une erreur : au premier demarrage, avant le
 * premier televersement, il n'existe pas encore, et echouer la rendrait la collecte
 * impossible tant que personne n'a cree le dossier a la main.
 */
export async function octetsDuRepertoire(
  repertoire: string,
  maintenant: number = Date.now(),
): Promise<number> {
  if (cache && maintenant - cache.mesureA < DUREE_CACHE_MS) return cache.octets;

  let octets = 0;
  try {
    const entrees = await readdir(repertoire, { withFileTypes: true });
    for (const e of entrees) {
      if (!e.isFile()) continue;
      try {
        octets += (await stat(join(repertoire, e.name))).size;
      } catch {
        // Un fichier disparu entre la liste et la mesure ne doit pas faire echouer la
        // mesure entiere : on l'ignore et on compte le reste.
      }
    }
  } catch {
    // Repertoire absent ou illisible : on ne bloque pas la collecte sur une mesure.
    octets = 0;
  }

  cache = { octets, mesureA: maintenant };
  return octets;
}

/**
 * Prend en compte une photo acceptee sans relancer la mesure.
 *
 * Sans cela, le cache resterait sur son ancienne valeur pendant une minute et une file
 * qui se rejoue vite passerait tout entiere au travers du plafond global.
 */
export function ajouterAuCache(octets: number): void {
  if (cache) cache.octets += octets;
}

/** Pour les tests, et pour un administrateur qui veut une mesure fraiche. */
export function invaliderCache(): void {
  cache = null;
}
