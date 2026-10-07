import { Router } from "express";
import { geoV2Router } from "./geo.routes";
import { syncV2Router } from "./sync.routes";
import { devicesV2Router } from "./devices.routes";
import { missionsV2Router } from "./missions.routes";
import { observationsV2Router } from "./observations.routes";

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
 * observations, assets, offline, sync, intelligence, ai, integrations. Cinq sont la.
 * Les ajouter tous d'un coup produirait des routes sans implementation derriere, ce
 * qui est pire que leur absence : un client les appellerait.
 *
 * `geo` est venu en premier parce que son moteur existait et qu'il etait mesure.
 * `sync` suit parce qu'il est le plus couteux a rattraper apres coup : une
 * application mobile batie sans idempotence ni detection de conflit produit des
 * doublons et des ecrasements qu'aucune correction ulterieure ne rattrape, les
 * donnees perdues l'etant pour de bon.
 *
 * `devices` et `missions` ont suivi par necessite : `sync/push` exige un appareilId
 * et refuse tout appareil inconnu, si bien que le protocole etait inutilisable sans
 * route pour en enregistrer un. La chaine se tient maintenant de bout en bout —
 * enregistrer un appareil, recevoir une mission, collecter, remonter.
 *
 * Les suivants viendront avec leur service, pas avant.
 */
export const apiV2Router = Router();

apiV2Router.use("/geo", geoV2Router);
apiV2Router.use("/sync", syncV2Router);
apiV2Router.use("/devices", devicesV2Router);
apiV2Router.use("/missions", missionsV2Router);
apiV2Router.use("/observations", observationsV2Router);

/**
 * Inventaire de la surface v2, pour qu'un client sache ce qui existe reellement.
 *
 * Plus honnete qu'une documentation qui promet douze domaines : cette liste est
 * construite a partir de ce qui est monte, donc elle ne peut pas mentir.
 */
apiV2Router.get("/", (_req, res) => {
  res.json({
    version: "v2",
    domaines: ["geo", "sync", "devices", "missions", "observations"],
    aVenir: [
      "auth", "tracks",
      "assets", "offline", "intelligence", "ai", "integrations",
    ],
    v1: "/api — inchangee, toujours servie",
  });
});
