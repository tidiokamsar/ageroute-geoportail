/**
 * Nommage du stockage local par compte (conception : docs/securite/SESSION-HORS-LIGNE.md, section 4).
 *
 * Une base IndexedDB PAR COMPTE, pour le journal de saisies et pour le journal de roulage, et des cles
 * localStorage prefixees par la meme empreinte. Plus aucun filtre `ownerUserId` a oublier : un compte ne
 * peut pas ouvrir la base d'un autre sans en connaitre le nom, et la suppression d'un compte ne touche
 * que ses bases.
 *
 * Fonctions PURES : le calcul du SHA-256 est fourni par l'appelant (`PortSha256`, asynchrone) pour que ce
 * fichier n'importe rien et ne touche ni le DOM ni le stockage. L'adaptateur reel est
 * `sha256WebCrypto` dans coffreSession.ts.
 *
 * CONTRAT POUR LES INTEGRATEURS
 *
 *   const empreinte = await empreinteCompte(user.id, sha256WebCrypto);   // 16 caracteres hexa
 *   nomBaseOffline(empreinte)   // "bdri-offline-<empreinte>"
 *   nomBaseRoulage(empreinte)   // "bdri-roulage-<empreinte>"
 *   cleLocalStorage(empreinte, "derniereSync")   // "bdri:<empreinte>:derniereSync"
 *   BASE_OFFLINE_HISTORIQUE, BASE_ROULAGE_HISTORIQUE : les noms d'avant le cloisonnement ("bdri-offline",
 *     "bdri-roulage"), a lire UNE fois pour la migration (etape 3) puis a ne plus ouvrir.
 *   analyserNomBase(nom)   // reconnait une base de cette famille et rend son genre et son empreinte, ou null
 *
 * L'empreinte n'est pas un secret : c'est un nom de dossier. Elle est tronquee a 64 bits, ce qui suffit a
 * distinguer les quelques comptes d'un meme telephone (collision negligeable) et ne revele pas l'identifiant
 * a qui lit seulement la liste des bases.
 */

/** Calcule un SHA-256 : octets en entree, 32 octets en sortie. Injecte pour garder ce fichier pur. */
export type PortSha256 = (octets: Uint8Array) => Promise<ArrayBuffer | Uint8Array>;

/** Noms d'avant le cloisonnement par compte. */
export const BASE_OFFLINE_HISTORIQUE = "bdri-offline";
export const BASE_ROULAGE_HISTORIQUE = "bdri-roulage";

/** Nombre de caracteres hexadecimaux conserves : 16 = 64 bits. */
export const LONGUEUR_EMPREINTE = 16;

const PREFIXE_OFFLINE = `${BASE_OFFLINE_HISTORIQUE}-`;
const PREFIXE_ROULAGE = `${BASE_ROULAGE_HISTORIQUE}-`;
const MOTIF_EMPREINTE = new RegExp(`^[0-9a-f]{${LONGUEUR_EMPREINTE}}$`);

export function empreinteValide(valeur: unknown): valeur is string {
  return typeof valeur === "string" && MOTIF_EMPREINTE.test(valeur);
}

function exigerEmpreinte(empreinte: string): string {
  if (!empreinteValide(empreinte)) {
    throw new Error("Empreinte de compte invalide : 16 caractères hexadécimaux minuscules attendus.");
  }
  return empreinte;
}

/** SHA-256 de l'identifiant du compte (UTF-8), en hexadecimal minuscule, tronque a 16 caracteres. */
export async function empreinteCompte(userId: string, sha256: PortSha256): Promise<string> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Identifiant de compte vide : aucune empreinte possible.");
  }
  const sortie = await sha256(new TextEncoder().encode(userId));
  const octets = sortie instanceof Uint8Array ? sortie : new Uint8Array(sortie);
  let hexa = "";
  for (const o of octets) hexa += o.toString(16).padStart(2, "0");
  if (hexa.length < LONGUEUR_EMPREINTE) throw new Error("Le port SHA-256 a rendu moins de 8 octets.");
  return hexa.slice(0, LONGUEUR_EMPREINTE);
}

export function nomBaseOffline(empreinte: string): string {
  return `${PREFIXE_OFFLINE}${exigerEmpreinte(empreinte)}`;
}

export function nomBaseRoulage(empreinte: string): string {
  return `${PREFIXE_ROULAGE}${exigerEmpreinte(empreinte)}`;
}

/** Prefixe de toutes les cles localStorage d'un compte. */
export function prefixeLocalStorage(empreinte: string): string {
  return `bdri:${exigerEmpreinte(empreinte)}:`;
}

export function cleLocalStorage(empreinte: string, cle: string): string {
  if (typeof cle !== "string" || cle.length === 0) throw new Error("Clé de stockage vide.");
  return `${prefixeLocalStorage(empreinte)}${cle}`;
}

/** Cette cle localStorage appartient-elle a ce compte ? */
export function cleAppartientAuCompte(cleComplete: string, empreinte: string): boolean {
  return cleComplete.startsWith(prefixeLocalStorage(empreinte));
}

export type GenreBase = "OFFLINE" | "ROULAGE";

/**
 * Reconnait une base de la famille cloisonnee. `null` pour la base historique (sans empreinte), pour toute
 * autre base, et pour un nom dont l'empreinte est mal formee : on n'ouvre jamais ce qu'on ne reconnait pas.
 */
export function analyserNomBase(nom: string): { readonly genre: GenreBase; readonly empreinte: string } | null {
  if (nom.startsWith(PREFIXE_OFFLINE)) {
    const empreinte = nom.slice(PREFIXE_OFFLINE.length);
    return empreinteValide(empreinte) ? { genre: "OFFLINE", empreinte } : null;
  }
  if (nom.startsWith(PREFIXE_ROULAGE)) {
    const empreinte = nom.slice(PREFIXE_ROULAGE.length);
    return empreinteValide(empreinte) ? { genre: "ROULAGE", empreinte } : null;
  }
  return null;
}

/** Les bases d'un autre compte, parmi une liste de noms : sert au seul compteur d'information. */
export function basesDesAutresComptes(noms: readonly string[], empreinteCourante: string): string[] {
  exigerEmpreinte(empreinteCourante);
  return noms.filter((n) => {
    const a = analyserNomBase(n);
    return a !== null && a.empreinte !== empreinteCourante;
  });
}
