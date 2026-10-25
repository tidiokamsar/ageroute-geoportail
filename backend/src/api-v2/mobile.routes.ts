import { Router } from "express";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { requireAuth } from "../middleware/auth.middleware";

/**
 * Application mobile terrain (APK) : téléchargement RÉSERVÉ aux comptes connectés.
 *
 * POURQUOI (25/10) : l'APK était servi par nginx à `/mobile/...` sans aucune authentification (HTTP 200 pour n'importe
 * qui sur Internet). C'est une version DEBUG, signée par la clé de debug standard d'Android : une application repackagée
 * avec cette clé serait prise par Android pour une mise à jour de la vraie. Le fichier n'est donc plus servi que par cette
 * route, derrière l'authentification (comme `/documents/:id/download`), et nginx ne le sert plus.
 *
 * Le nom du fichier est FIXE : aucun chemin ne vient de la requête, aucun parcours de répertoire possible. Le dossier vient
 * de `MOBILE_DIR` (le volume monté en lecture seule), jamais du dépôt : l'APK n'est pas commité.
 *
 * `/apk/info` rend l'empreinte SHA-256 du fichier servi, pour qu'une personne habilitée puisse vérifier qu'il s'agit bien de
 * celui que la DSI a publié. Elle ne dit rien de sa signature : la version de release signée par une clé AGEROUTE est un geste
 * de la DSI, pas du code.
 */

export const mobileV2Router = Router();
mobileV2Router.use(requireAuth);

export const NOM_APK = "bdri-console-terrain.apk";
const dossier = () => process.env.MOBILE_DIR ?? "/app/mobile";

// L'empreinte se recalcule seulement quand le fichier change (taille + date de modification).
let memo: { cle: string; sha256: string } | null = null;

async function empreinte(chemin: string, cle: string): Promise<string> {
  if (memo?.cle === cle) return memo.sha256;
  const h = createHash("sha256");
  await new Promise<void>((ok, ko) => {
    createReadStream(chemin).on("data", (d) => h.update(d)).on("end", () => ok()).on("error", ko);
  });
  memo = { cle, sha256: h.digest("hex") };
  return memo.sha256;
}

async function lireFichier(): Promise<{ chemin: string; taille: number; modifieLe: Date } | null> {
  const chemin = join(dossier(), NOM_APK);
  try {
    const s = await stat(chemin);
    return s.isFile() ? { chemin, taille: s.size, modifieLe: s.mtime } : null;
  } catch {
    return null;
  }
}

mobileV2Router.get("/apk/info", async (_req, res, next) => {
  try {
    const f = await lireFichier();
    if (!f) { res.json({ disponible: false }); return; }
    res.json({
      disponible: true, nom: NOM_APK, tailleOctets: f.taille, modifieLe: f.modifieLe.toISOString(),
      sha256: await empreinte(f.chemin, `${f.taille}-${f.modifieLe.getTime()}`),
    });
  } catch (err) { next(err); }
});

mobileV2Router.get("/apk", async (_req, res, next) => {
  try {
    const f = await lireFichier();
    if (!f) { res.status(404).json({ error: "L'application mobile n'est pas publiée sur ce serveur." }); return; }
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Length", String(f.taille));
    res.setHeader("Content-Disposition", `attachment; filename="${NOM_APK}"`);
    res.setHeader("Cache-Control", "private, no-store");
    createReadStream(f.chemin).on("error", next).pipe(res);
  } catch (err) { next(err); }
});
