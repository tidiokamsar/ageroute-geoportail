import { Router } from "express";
import { geoV2Router } from "./geo.routes";

/**
 * `/api/v2` — la nouvelle surface d'API.
 *
 * POURQUOI UNE SECONDE VERSION PLUTOT QU'UNE EVOLUTION
 *
 * Section 2 du cahier des charges : « Conserver V1 + creer /api/v2 ». La V1 sert
 * aujourd'hui la carte publique, la console interne et la carte embarquee de
 * DigitalRoad, cette derniere depuis un domaine SharePoint qu'on ne redeploie pas au
 * meme rythme. Casser un contrat que trois clients consomment pour gagner en elegance
 * n'aurait aucun sens.
 *
 * La V1 reste donc intacte sous `/api`. Les domaines ci-dessous s'ajoutent, et les
 * pages migrent une par une.
 *
 * CE QUI MANQUE ENCORE
 *
 * La section 16 liste douze domaines : auth, devices, missions, tracks, geo,
 * observations, assets, offline, sync, intelligence, ai, integrations. Un seul est
 * la. Les ajouter tous d'un coup produirait des routes sans implementation derriere,
 * ce qui est pire que leur absence : un client les appellerait.
 *
 * `geo` vient en premier parce que son moteur existe et qu'il est mesure — voir
 * geo/appariement.ts. Les suivants viendront avec leur service, pas avant.
 */
export const apiV2Router = Router();

apiV2Router.use("/geo", geoV2Router);

/**
 * Inventaire de la surface v2, pour qu'un client sache ce qui existe reellement.
 *
 * Plus honnete qu'une documentation qui promet douze domaines : cette liste est
 * construite a partir de ce qui est monte, donc elle ne peut pas mentir.
 */
apiV2Router.get("/", (_req, res) => {
  res.json({
    version: "v2",
    domaines: ["geo"],
    aVenir: [
      "auth", "devices", "missions", "tracks", "observations",
      "assets", "offline", "sync", "intelligence", "ai", "integrations",
    ],
    v1: "/api — inchangee, toujours servie",
  });
});
