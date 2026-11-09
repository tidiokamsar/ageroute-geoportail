/**
 * SPOOL partage avec le conteneur de conversion (lot B2, durci lot V2) : seul module qui touche le systeme de fichiers du protocole (CHAINE-GDAL.md section 4).
 *
 *   prive/<jobId>/fichier.<ext>         depot PRIVE du backend (jamais monte dans le conteneur) : le fichier y attend sa reclamation (M2 de la revue)
 *   entree/<spoolId>/fichier.<ext>      copie deposee A LA RECLAMATION seulement ; le conteneur le lit en LECTURE SEULE ; retiree des la fin du job
 *   entree/<spoolId>/demande.json       ecrit EN DERNIER (fichier temporaire puis rename) : c'est lui qui declenche le traitement
 *   sortie/<spoolId>/statut.json        ecrit par le conteneur (en dernier) ; resultat.json et inventaire.json ; couches/<slug>.geojson
 *
 * Le dossier d'un job ne porte JAMAIS un nom venu de l'utilisateur : `<uuid du job>-t<n>` dans entree/ et sortie/ (verifie par `RE_SPOOL_ID`), `<uuid du job>`
 * dans prive/ (verifie par `RE_JOB_ID`). Le conteneur est un ecrivain NON FIABLE de `sortie/` : tout chemin y est lu sans suivre de lien (lstat, O_NOFOLLOW),
 * sans jamais bloquer (O_NONBLOCK puis fstat : un tube nomme ou un peripherique est refuse), sous une taille maximale, et le chemin reel doit rester dans
 * `realpath(sortie)/<spoolId>`. La purge ne retire que des NOMS CONNUS (jamais de suppression recursive d'un arbre ecrit par le conteneur). Aucune erreur ne
 * cite un chemin (les messages sont fixes).
 */

import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { RE_SPOOL_ID } from "./contrat.noyau";
import { ErreurSortie, SchemaStatut, type StatutWorker, type ValidateurCouche } from "./sortie.noyau";

export interface Spool { racine: string; entree: string; sortie: string; prive: string }

/** Identifiant de job de l'API (UUID v4 en minuscules) : seul nom admis sous prive/. */
export const RE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RE_EXTENSION = /^[a-z0-9]{1,8}$/;
/** Noms que le backend ecrit lui-meme dans entree/ et prive/ (la purge n'en retire pas d'autres). */
const EXTENSIONS_CONNUES = ["gpkg", "zip", "dxf"];
const FICHIERS_ENTREE = [...EXTENSIONS_CONNUES.map((e) => `fichier.${e}`), "demande.json", "demande.json.tmp"];
/** Noms que le worker ecrit dans sortie/<id>/ (CHAINE-GDAL.md 4.2), avec leurs temporaires. */
const FICHIERS_SORTIE = ["statut.json", "statut.json.tmp", "resultat.json", "resultat.json.tmp", "inventaire.json", "inventaire.json.tmp"];
const RE_FICHIER_COUCHE = /^[a-z0-9][a-z0-9_-]{0,63}\.geojson$/;

/** `prive` : dossier du backend seul, `<racine>/prive` par defaut, ou un chemin a part (`PROJETS_VOIRIE_GDAL_PRIVE`) quand entree/ et sortie/ sont des volumes montes. */
export function ouvrirSpool(racine: string, prive?: string | null): Spool {
  return { racine, entree: path.join(racine, "entree"), sortie: path.join(racine, "sortie"), prive: prive && prive !== "" ? prive : path.join(racine, "prive") };
}

function dossierJob(base: string, spoolId: string): string {
  if (!RE_SPOOL_ID.test(spoolId)) throw new Error("identifiant de spool invalide");
  return path.join(base, spoolId);
}

function dossierPrive(s: Spool, jobId: string): string {
  if (!RE_JOB_ID.test(jobId)) throw new Error("identifiant de job invalide");
  return path.join(s.prive, jobId);
}

const codeErrno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

/**
 * Le dossier d'echange est-il utilisable ? Verifie seulement l'existence et les droits (aucun fichier n'est cree) : entree/ et sortie/ en lecture ET ecriture
 * (le backend y purge, m1 de la revue), prive/ en lecture et ecriture, ou a defaut sa racine en ecriture (il est cree au premier depot).
 */
export async function disponibiliteSpool(s: Spool): Promise<{ ok: true } | { ok: false; raison: string }> {
  try {
    await fs.access(s.entree, constants.R_OK | constants.W_OK);
    await fs.access(s.sortie, constants.R_OK | constants.W_OK);
  } catch {
    return { ok: false, raison: "dossiers d'echange du convertisseur inaccessibles" };
  }
  try {
    await fs.access(s.prive, constants.R_OK | constants.W_OK);
  } catch {
    try { await fs.access(path.dirname(s.prive), constants.W_OK); } catch { return { ok: false, raison: "dossier prive du backend inaccessible" }; }
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ Depot prive (backend seul)

async function ecrireExclusif(cible: string, contenu: Buffer, mode: number): Promise<void> {
  const h = await fs.open(cible, "wx", mode);
  try { await h.writeFile(contenu); await h.sync(); } finally { await h.close(); }
}

/** Depose le fichier a convertir dans le dossier PRIVE du backend (`prive/<jobId>/`), hors de portee du conteneur, jusqu'a la reclamation du job. */
export async function stagerPrive(s: Spool, jobId: string, extension: string, contenu: Buffer): Promise<void> {
  if (!RE_EXTENSION.test(extension)) throw new Error("extension invalide");
  const d = dossierPrive(s, jobId);
  await fs.mkdir(s.prive, { recursive: true, mode: 0o700 });
  await fs.mkdir(d, { recursive: false, mode: 0o700 });
  await ecrireExclusif(path.join(d, `fichier.${extension}`), contenu, 0o600);
}

export async function priveExiste(s: Spool, jobId: string, extension: string): Promise<boolean> {
  try {
    const st = await fs.lstat(path.join(dossierPrive(s, jobId), `fichier.${extension}`));
    return st.isFile();
  } catch { return false; }
}

/** Retire le depot prive d'un job (noms connus puis rmdir). Idempotent. */
export async function purgerPrive(s: Spool, jobId: string): Promise<void> {
  await retirerDossierConnu(dossierPrive(s, jobId), EXTENSIONS_CONNUES.map((e) => `fichier.${e}`), null);
}

// ------------------------------------------------------------------------------------------------ Entree (lue par le conteneur)

/** Depose le fichier a convertir dans `entree/<spoolId>/` SANS `demande.json` : le conteneur n'y touchera pas tant que la demande n'est pas publiee. */
export async function stagerEntree(s: Spool, spoolId: string, extension: string, contenu: Buffer): Promise<void> {
  if (!RE_EXTENSION.test(extension)) throw new Error("extension invalide");
  const d = dossierJob(s.entree, spoolId);
  await fs.mkdir(d, { recursive: false, mode: 0o755 });
  // Ecriture exclusive (aucun ecrasement), droits 0644 : le conteneur (autre UID) doit pouvoir lire.
  await ecrireExclusif(path.join(d, `fichier.${extension}`), contenu, 0o644);
}

/**
 * A LA RECLAMATION : copie le depot prive dans `entree/<spoolId>/` (sans demande.json). Si le dossier existe deja avec le fichier (transmission interrompue
 * puis reprise), la copie est consideree faite (idempotent : m7 de la revue). Leve si le depot prive a disparu.
 */
export async function copierVersEntree(s: Spool, jobId: string, spoolId: string, extension: string): Promise<void> {
  const src = path.join(dossierPrive(s, jobId), `fichier.${extension}`);
  const st = await fs.lstat(src);
  if (!st.isFile()) throw new Error("fichier source absent");
  try {
    await stagerEntree(s, spoolId, extension, await fs.readFile(src));
  } catch (e) {
    if (codeErrno(e) === "EEXIST" && (await entreeExiste(s, spoolId, extension))) return;
    throw e;
  }
}

/** Publie `demande.json` en dernier (ecriture temporaire puis rename atomique). */
export async function publierDemande(s: Spool, spoolId: string, demande: Record<string, unknown>): Promise<void> {
  const d = dossierJob(s.entree, spoolId);
  const tmp = path.join(d, "demande.json.tmp");
  const h = await fs.open(tmp, "w", 0o644);
  try { await h.writeFile(JSON.stringify(demande)); await h.sync(); } finally { await h.close(); }
  await fs.rename(tmp, path.join(d, "demande.json"));
}

export async function entreeExiste(s: Spool, spoolId: string, extension: string): Promise<boolean> {
  try {
    const st = await fs.lstat(path.join(dossierJob(s.entree, spoolId), `fichier.${extension}`));
    return st.isFile();
  } catch { return false; }
}

// ------------------------------------------------------------------------------------------------ Purge par noms connus

async function lstatOuNull(chemin: string): Promise<import("node:fs").Stats | null> {
  try { return await fs.lstat(chemin); } catch (e) { if (codeErrno(e) === "ENOENT") return null; throw e; }
}

/** Retire un fichier par son nom si c'est un fichier ou un lien (jamais un dossier : le dossier serait un ecart au contrat, laisse en place). */
async function retirerFichier(chemin: string): Promise<void> {
  const st = await lstatOuNull(chemin);
  if (st === null || st.isDirectory()) return;
  try { await fs.unlink(chemin); } catch (e) { if (codeErrno(e) !== "ENOENT") throw e; }
}

/**
 * Retire un dossier dont on connait le contenu attendu : fichiers nommes, puis au plus UN sous-dossier (`couches/`) dont les fichiers suivent le motif des
 * couches, puis `rmdir`. Un lien a la place du dossier est retire comme lien (jamais suivi). Tout nom inattendu reste en place et fait echouer le `rmdir`
 * (ENOTEMPTY) : l'erreur remonte, le sondage la journalise et reessaie ; le worker purge de toute facon `sortie/` a `GEOCONV_RETENTION_H`. Idempotent.
 */
async function retirerDossierConnu(dossier: string, fichiers: readonly string[], sousDossier: { nom: string; motif: RegExp } | null): Promise<void> {
  const st = await lstatOuNull(dossier);
  if (st === null) return;
  if (st.isSymbolicLink() || !st.isDirectory()) { await fs.unlink(dossier); return; }
  for (const nom of fichiers) await retirerFichier(path.join(dossier, nom));
  if (sousDossier) {
    const sd = path.join(dossier, sousDossier.nom);
    const sst = await lstatOuNull(sd);
    if (sst !== null) {
      if (sst.isSymbolicLink() || !sst.isDirectory()) await fs.unlink(sd);
      else {
        for (const nom of await fs.readdir(sd)) {
          if (sousDossier.motif.test(nom) || /\.tmp$/.test(nom)) await retirerFichier(path.join(sd, nom));
        }
        await fs.rmdir(sd);
      }
    }
  }
  await fs.rmdir(dossier);
}

export const purgerEntree = (s: Spool, spoolId: string): Promise<void> => retirerDossierConnu(dossierJob(s.entree, spoolId), FICHIERS_ENTREE, null);
export const purgerSortie = (s: Spool, spoolId: string): Promise<void> => retirerDossierConnu(dossierJob(s.sortie, spoolId), FICHIERS_SORTIE, { nom: "couches", motif: RE_FICHIER_COUCHE });

/** Retire les dossiers d'une tentative (entree et sortie). Idempotent ; ne suit pas les liens ; noms connus seulement. */
export async function purger(s: Spool, spoolId: string): Promise<void> {
  await purgerEntree(s, spoolId);
  await purgerSortie(s, spoolId);
}

// ------------------------------------------------------------------------------------------------ Lecture non fiable

/** Drapeaux d'ouverture d'un fichier ecrit par le conteneur : lecture seule, sans suivre de lien, SANS BLOQUER (un tube nomme ne retient aucun thread). */
export function drapeauxLectureSure(c: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number }): number {
  // O_NOFOLLOW et O_NONBLOCK n'existent pas partout (absents sous Windows) : la verification lstat puis fstat fait foi dans ce cas.
  return c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0);
}

/**
 * Le chemin reel doit rester sous `realpath(sortie)/<spoolId>` : la base n'est JAMAIS le realpath du dossier du job lui-meme (un dossier remplace par un lien
 * mene ailleurs et sa realpath suivrait le lien : m3 de la revue).
 */
async function verifierSousDossier(s: Spool, spoolId: string, fichier: string): Promise<void> {
  const base = path.join(await fs.realpath(s.sortie), spoolId);
  const reel = await fs.realpath(fichier);
  const relatif = path.relative(base, reel);
  if (relatif === "" || relatif.startsWith("..") || path.isAbsolute(relatif)) throw new ErreurSortie("SORTIE_INVALIDE", "fichier de sortie hors du dossier du job");
}

async function ouvrirFichierRegulier(s: Spool, spoolId: string, relatif: string, maxOctets: number): Promise<{ h: import("node:fs/promises").FileHandle; taille: number }> {
  const dj = dossierJob(s.sortie, spoolId);
  const stDossier = await fs.lstat(dj);
  if (stDossier.isSymbolicLink() || !stDossier.isDirectory()) throw new ErreurSortie("SORTIE_INVALIDE", "dossier de sortie du job qui n'est pas un dossier regulier");
  const chemin = path.join(dj, ...relatif.split("/"));
  const st = await fs.lstat(chemin);
  if (!st.isFile() || st.isSymbolicLink()) throw new ErreurSortie("SORTIE_INVALIDE", "fichier de sortie qui n'est pas un fichier regulier");
  if (st.size > maxOctets) throw new ErreurSortie("SORTIE_TROP_GROSSE", "fichier de sortie plus gros que le plafond");
  await verifierSousDossier(s, spoolId, chemin);
  const h = await fs.open(chemin, drapeauxLectureSure(constants));
  let fst: import("node:fs").Stats;
  try { fst = await h.stat(); } catch (e) { await h.close(); throw e; }
  // fstat sur le descripteur ouvert : ce qui a ete ouvert est un fichier regulier (ni tube, ni peripherique) de taille bornee, quoi qu'il soit arrive entre lstat et open.
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
    if (codeErrno(e) === "ENOENT") return { etat: "absent" };
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
