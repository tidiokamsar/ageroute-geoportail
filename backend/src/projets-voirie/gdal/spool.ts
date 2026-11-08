/**
 * SPOOL partage avec le conteneur de conversion (lot B2) : seul module qui touche le systeme de fichiers du protocole (CHAINE-GDAL.md section 4).
 *
 *   entree/<spoolId>/fichier.<ext>      depose par le backend ; le conteneur le lit en LECTURE SEULE
 *   entree/<spoolId>/demande.json       ecrit EN DERNIER (fichier temporaire puis rename) : c'est lui qui declenche le traitement
 *   sortie/<spoolId>/statut.json        ecrit par le conteneur (en dernier) ; resultat.json et inventaire.json ; couches/<slug>.geojson
 *
 * Le dossier d'un job ne porte JAMAIS un nom venu de l'utilisateur : `<uuid du job>-t<n>`, verifie par `RE_SPOOL_ID` a chaque acces. Le conteneur est un
 * ecrivain NON FIABLE de `sortie/` : tout chemin y est lu sans suivre de lien (lstat), sous une taille maximale, et le chemin reel doit rester dans le
 * dossier du job. Aucune erreur ne cite un chemin (les messages sont fixes).
 */

import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { RE_SPOOL_ID } from "./contrat.noyau";
import { ErreurSortie, SchemaStatut, type StatutWorker, type ValidateurCouche } from "./sortie.noyau";

export interface Spool { racine: string; entree: string; sortie: string }

export function ouvrirSpool(racine: string): Spool {
  return { racine, entree: path.join(racine, "entree"), sortie: path.join(racine, "sortie") };
}

function dossierJob(base: string, spoolId: string): string {
  if (!RE_SPOOL_ID.test(spoolId)) throw new Error("identifiant de spool invalide");
  return path.join(base, spoolId);
}

/** Le dossier d'echange est-il utilisable ? Verifie seulement l'existence et les droits (aucun fichier n'est cree). */
export async function disponibiliteSpool(s: Spool): Promise<{ ok: true } | { ok: false; raison: string }> {
  try {
    await fs.access(s.entree, constants.R_OK | constants.W_OK);
    await fs.access(s.sortie, constants.R_OK);
  } catch {
    return { ok: false, raison: "dossiers d'echange du convertisseur inaccessibles" };
  }
  return { ok: true };
}

/** Depose le fichier a convertir dans `entree/<spoolId>/` SANS `demande.json` : le conteneur n'y touchera pas tant que la demande n'est pas publiee. */
export async function stagerEntree(s: Spool, spoolId: string, extension: string, contenu: Buffer): Promise<void> {
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error("extension invalide");
  const d = dossierJob(s.entree, spoolId);
  await fs.mkdir(d, { recursive: false, mode: 0o755 });
  const cible = path.join(d, `fichier.${extension}`);
  // Ecriture exclusive (aucun ecrasement), droits 0644 : le conteneur (autre UID) doit pouvoir lire.
  const h = await fs.open(cible, "wx", 0o644);
  try { await h.writeFile(contenu); await h.sync(); } finally { await h.close(); }
}

/** Publie `demande.json` en dernier (ecriture temporaire puis rename atomique). */
export async function publierDemande(s: Spool, spoolId: string, demande: Record<string, unknown>): Promise<void> {
  const d = dossierJob(s.entree, spoolId);
  const tmp = path.join(d, "demande.json.tmp");
  const h = await fs.open(tmp, "w", 0o644);
  try { await h.writeFile(JSON.stringify(demande)); await h.sync(); } finally { await h.close(); }
  await fs.rename(tmp, path.join(d, "demande.json"));
}

/** Nouvelle tentative : recopie le fichier depose de la tentative precedente dans un nouveau dossier (sans demande.json). */
export async function copierEntree(s: Spool, de: string, vers: string, extension: string): Promise<void> {
  const src = path.join(dossierJob(s.entree, de), `fichier.${extension}`);
  const st = await fs.lstat(src);
  if (!st.isFile()) throw new Error("fichier source absent");
  await stagerEntree(s, vers, extension, await fs.readFile(src));
}

export async function entreeExiste(s: Spool, spoolId: string, extension: string): Promise<boolean> {
  try {
    const st = await fs.lstat(path.join(dossierJob(s.entree, spoolId), `fichier.${extension}`));
    return st.isFile();
  } catch { return false; }
}

/** Retire les dossiers d'une tentative (entree et sortie). Idempotent ; ne suit pas les liens. */
export async function purger(s: Spool, spoolId: string): Promise<void> {
  for (const base of [s.entree, s.sortie]) {
    await fs.rm(dossierJob(base, spoolId), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
}

// ------------------------------------------------------------------------------------------------ Lecture non fiable

/** Le chemin reel doit rester sous le dossier du job (un lien symbolique place dans `sortie/` par le conteneur ne doit mener nulle part ailleurs). */
async function verifierSousDossier(s: Spool, spoolId: string, fichier: string): Promise<void> {
  const base = await fs.realpath(dossierJob(s.sortie, spoolId));
  const reel = await fs.realpath(fichier);
  const relatif = path.relative(base, reel);
  if (relatif === "" || relatif.startsWith("..") || path.isAbsolute(relatif)) throw new ErreurSortie("SORTIE_INVALIDE", "fichier de sortie hors du dossier du job");
}

async function ouvrirFichierRegulier(s: Spool, spoolId: string, relatif: string, maxOctets: number): Promise<{ h: import("node:fs/promises").FileHandle; taille: number }> {
  const chemin = path.join(dossierJob(s.sortie, spoolId), ...relatif.split("/"));
  const st = await fs.lstat(chemin);
  if (!st.isFile() || st.isSymbolicLink()) throw new ErreurSortie("SORTIE_INVALIDE", "fichier de sortie qui n'est pas un fichier regulier");
  if (st.size > maxOctets) throw new ErreurSortie("SORTIE_TROP_GROSSE", "fichier de sortie plus gros que le plafond");
  await verifierSousDossier(s, spoolId, chemin);
  // O_NOFOLLOW n'existe pas partout (absent sous Windows) : la verification lstat ci-dessus fait foi dans ce cas.
  const h = await fs.open(chemin, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const fst = await h.stat();
  if (!fst.isFile() || fst.size > maxOctets) { await h.close(); throw new ErreurSortie("SORTIE_INVALIDE", "fichier de sortie modifie pendant la lecture"); }
  return { h, taille: fst.size };
}

async function lireJsonBorne(s: Spool, spoolId: string, relatif: string, maxOctets: number): Promise<unknown> {
  const { h, taille } = await ouvrirFichierRegulier(s, spoolId, relatif, maxOctets);
  try {
    const b = Buffer.alloc(taille);
    const { bytesRead } = await h.read(b, 0, taille, 0);
    return JSON.parse(b.subarray(0, bytesRead).toString("utf8"));
  } catch (e) {
    if (e instanceof ErreurSortie) throw e;
    throw new ErreurSortie("SORTIE_INVALIDE", "fichier JSON de sortie illisible");
  } finally { await h.close(); }
}

export type ObservationBrute =
  | { etat: "absent" }
  | { etat: "illisible" }
  | { etat: "ok"; statut: StatutWorker };

/** Lit `statut.json` du conteneur. Absent = pas commence ; illisible = hors contrat (le sondage decide apres l'echeance). */
export async function lireStatutSpool(s: Spool, spoolId: string): Promise<ObservationBrute> {
  let brut: unknown;
  try {
    brut = await lireJsonBorne(s, spoolId, "statut.json", 64 * 1024);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { etat: "absent" };
    return { etat: "illisible" };
  }
  const r = SchemaStatut.safeParse(brut);
  if (!r.success || r.data.jobId !== spoolId) return { etat: "illisible" };
  return { etat: "ok", statut: r.data };
}

/** `inventaire.json` du conteneur (4 Mo au plus) : donnee non fiable, l'appelant n'en retient que des champs precis. */
export const lireInventaireBrut = (s: Spool, spoolId: string): Promise<unknown> => lireJsonBorne(s, spoolId, "inventaire.json", 4 * 1024 * 1024);

export const lireResultatBrut = (s: Spool, spoolId: string): Promise<unknown> => lireJsonBorne(s, spoolId, "resultat.json", 4 * 1024 * 1024);

/**
 * Lit une couche GeoJSON LIGNE PAR LIGNE vers `validateur`, sous une taille maximale, en calculant l'empreinte SHA-256 de ce qui a ete lu.
 * Une ligne plus longue que `ligneMax` ou un contenu qui n'est pas de l'UTF-8 valide refuse la couche.
 */
export async function lireCoucheVersValidateur(
  s: Spool, spoolId: string, slug: string, validateur: ValidateurCouche, o: { octetsMax: number; ligneMax: number },
): Promise<{ sha256: string; octets: number }> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw new ErreurSortie("SORTIE_INVALIDE", "nom de couche hors contrat");
  const { h, taille } = await ouvrirFichierRegulier(s, spoolId, `couches/${slug}.geojson`, o.octetsMax);
  const hash = createHash("sha256");
  const decodeur = new TextDecoder("utf-8", { fatal: true });
  let lus = 0;
  let courant: Buffer[] = [];
  let longueur = 0;
  const finLigne = (): void => {
    const b = courant.length === 1 ? courant[0] : Buffer.concat(courant);
    courant = [];
    longueur = 0;
    let texte: string;
    try { texte = decodeur.decode(b); } catch { throw new ErreurSortie("SORTIE_INVALIDE", "sortie qui n'est pas de l'UTF-8 valide"); }
    validateur.ligne(texte);
  };
  try {
    const flux = h.createReadStream({ autoClose: false, highWaterMark: 256 * 1024, start: 0 });
    for await (const morceau of flux as AsyncIterable<Buffer>) {
      lus += morceau.length;
      if (lus > o.octetsMax || lus > taille) throw new ErreurSortie("SORTIE_INVALIDE", "fichier de sortie plus gros que prevu");
      hash.update(morceau);
      let debut = 0;
      for (;;) {
        const i = morceau.indexOf(0x0a, debut);
        if (i === -1) break;
        const part = morceau.subarray(debut, i);
        longueur += part.length;
        if (longueur > o.ligneMax) throw new ErreurSortie("SORTIE_INVALIDE", "ligne de GeoJSON trop longue");
        courant.push(part);
        finLigne();
        debut = i + 1;
      }
      const reste = morceau.subarray(debut);
      if (reste.length > 0) {
        longueur += reste.length;
        if (longueur > o.ligneMax) throw new ErreurSortie("SORTIE_INVALIDE", "ligne de GeoJSON trop longue");
        courant.push(reste);
      }
    }
    if (longueur > 0) finLigne();
  } finally {
    await h.close();
  }
  return { sha256: hash.digest("hex"), octets: lus };
}
