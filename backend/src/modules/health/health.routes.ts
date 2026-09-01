import { Router } from "express";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import { prisma } from "../../lib/prisma";
import { UPLOAD_DIR } from "../../middleware/upload-document.middleware";
import { PHOTOS_UPLOAD_DIR } from "../../middleware/upload-photo.middleware";

export const healthRouter = Router();

type Etat = "ok" | "ko";

// Une sonde qui prend son temps ne sert a rien : la supervision doit obtenir une
// reponse meme quand la base ne repond plus. Sans ce plafond, une base bloquee ferait
// pendre la sonde elle-meme, et la supervision conclurait a une panne de l'API.
const DELAI_MAX_MS = 2000;

async function avecDelai<T>(promesse: Promise<T>, ms: number): Promise<T> {
  let minuteur: NodeJS.Timeout;
  const expiration = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new Error("delai depasse")), ms);
  });
  try {
    return await Promise.race([promesse, expiration]);
  } finally {
    clearTimeout(minuteur!);
  }
}

async function verifierBase(): Promise<{ etat: Etat; ms: number }> {
  const debut = Date.now();
  try {
    await avecDelai(prisma.$queryRaw`SELECT 1`, DELAI_MAX_MS);
    return { etat: "ok", ms: Date.now() - debut };
  } catch (err) {
    // Le detail part dans les journaux du serveur, jamais dans la reponse : un
    // message d'erreur PostgreSQL revele la structure de la base et parfois son hote.
    console.error("[health] base injoignable :", err instanceof Error ? err.message : err);
    return { etat: "ko", ms: Date.now() - debut };
  }
}

async function verifierStockage(): Promise<{ etat: Etat; ms: number }> {
  const debut = Date.now();
  try {
    // Acces en ecriture, et non simple existence : le defaut redoute est un volume
    // monte mais non inscriptible, cas ou le dossier existe et ou tout televersement
    // echoue malgre tout.
    await avecDelai(
      Promise.all([
        fs.access(UPLOAD_DIR, fsConstants.W_OK),
        fs.access(PHOTOS_UPLOAD_DIR, fsConstants.W_OK),
      ]),
      DELAI_MAX_MS
    );
    return { etat: "ok", ms: Date.now() - debut };
  } catch (err) {
    console.error("[health] stockage indisponible :", err instanceof Error ? err.message : err);
    return { etat: "ko", ms: Date.now() - debut };
  }
}

/**
 * Sonde d'etat publique.
 *
 * Elle repondait auparavant { status: "ok" } sans rien verifier — donc « ok » meme
 * base arretee, ce qui rendait toute supervision inutile : le seul cas qu'elle
 * detectait etait celui ou l'API ne repondait pas du tout, que la supervision voit
 * deja par l'absence de reponse.
 *
 * Elle distingue desormais trois situations :
 *   200 { "status": "ok" }        tout repond
 *   503 { "status": "degrade" }   l'API vit, mais la base ou le stockage manquent
 *   (pas de reponse)              l'API elle-meme est tombee
 *
 * Volontairement muette sur les details : ni version, ni chemin, ni message d'erreur,
 * ni volumetrie. Une sonde publique ne doit rien apprendre a qui la sollicite au-dela
 * de « cela fonctionne ou non ».
 */
healthRouter.get("/", async (_req, res) => {
  const [base, stockage] = await Promise.all([verifierBase(), verifierStockage()]);
  const enBonneSante = base.etat === "ok" && stockage.etat === "ok";

  res.status(enBonneSante ? 200 : 503).json({
    status: enBonneSante ? "ok" : "degrade",
    timestamp: new Date().toISOString(),
    checks: {
      api: { etat: "ok" as Etat },
      base: { etat: base.etat, ms: base.ms },
      stockage: { etat: stockage.etat, ms: stockage.ms },
    },
  });
});
