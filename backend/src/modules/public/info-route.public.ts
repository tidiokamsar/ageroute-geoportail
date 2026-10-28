import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import { infoRouteCourante, versPublic } from "../../exploitation/info-route.service";

/**
 * Info Route publique (paragraphe 7.17, EX-05). Aucune authentification : c'est l'objet meme.
 *
 * Ce qui sort est filtre deux fois : par la vue `info_route_courante` (dernier etat publie, en
 * cours de validite, rien d'interne), puis par `versPublic` (pas d'identifiant de troncon ni
 * d'evenement de main courante, niveau seulement s'il est approuve).
 */
export async function infoRoutePubliqueHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const lignes = await infoRouteCourante(prisma);
    res.set("Cache-Control", "public, max-age=30");
    res.json({
      source: "AGEROUTE Guinée -- informations validées par l'exploitant",
      genereLe: new Date().toISOString(),
      publications: lignes.map(versPublic),
    });
  } catch (err) { next(err); }
}

/** Le dernier bulletin archive, en texte simple, tel quel : son empreinte l'accompagne. */
export async function dernierBulletinHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const b = await prisma.bulletinRoutier.findFirst({ orderBy: { genereLe: "desc" }, select: { numero: true, texte: true, empreinteSha256: true } });
    if (!b) { res.status(404).type("text/plain; charset=utf-8").send("Aucun bulletin n'a encore été publié."); return; }
    res.type("text/plain; charset=utf-8").set("X-Bulletin", b.numero).set("X-Empreinte-SHA256", b.empreinteSha256).send(b.texte);
  } catch (err) { next(err); }
}
