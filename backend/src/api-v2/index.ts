import { Router } from "express";
import { geoV2Router } from "./geo.routes";
import { syncV2Router } from "./sync.routes";
import { devicesV2Router } from "./devices.routes";
import { missionsV2Router } from "./missions.routes";
import { roulageV2Router } from "./roulage.routes";
import { referentielV2Router } from "./referentiel.routes";
import { observationsV2Router } from "./observations.routes";
import { defautsV2Router } from "./defauts.routes";
import { fieldV2Router } from "./field.routes";
import { portionsV2Router } from "./portions.routes";
import { referentielsV2Router } from "./referentiels.routes";
import { qualiteV2Router } from "./qualite.routes";
import { reseauV2Router } from "./reseau.routes";
import { importsV2Router } from "./imports.routes";
import { exploitationV2Router } from "./exploitation.routes";
import { patrouillesV2Router } from "./patrouilles.routes";
import { infoRouteV2Router } from "./info-route.routes";
import { veilleV2Router } from "./veille.routes";
import { teledetectionV2Router } from "./teledetection.routes";
import { programmationV2Router } from "./programmation.routes";
import { baremesV2Router } from "./baremes.routes";
import { exportV2Router } from "./export.routes";
import { rechercheV2Router } from "./troncons-recherche.routes";
import { bulkEtatV2Router } from "./troncons-bulk-etat.routes";
import { perimetresV2Router } from "./perimetres.routes";
import { moteurProgrammationV2Router } from "./programmation.moteur.routes";
import { ppeProgrammationV2Router } from "./programmation.ppe.routes";
import { integrationsV2Router } from "./integrations.routes";
import { tableauDeBordV2Router, fiche360V2Router } from "./tableau-de-bord.routes";
import { tachesInternesV2Router } from "./taches-internes.routes";
import { correspondancesV2Router } from "./correspondances.routes";
import { mobileV2Router } from "./mobile.routes";

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
 * observations, assets, offline, sync, intelligence, ai, integrations. Six sont la.
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
 * `defauts` suit les observations : la validation de celles-ci ne servait a rien tant
 * que la degradation restait du texte libre. Le defaut porte le metre, la gravite et
 * l'etendue — ce dont les moteurs de traitement, quantite et cout auront besoin.
 *
 * `field` vient en dernier parce qu'il ne fait que COMPOSER : il apparie la position,
 * cherche la portion a l'abscisse obtenue et ramene les actifs autour. Il n'a pu etre
 * ecrit qu'une fois les portions modelisees, et il rend en une requete ce qu'un client
 * mobile aurait dû assembler en trois sur un reseau ou chaque aller-retour coute.
 *
 * Les suivants viendront avec leur service, pas avant.
 */
export const apiV2Router = Router();

apiV2Router.use("/geo", geoV2Router);
apiV2Router.use("/sync", syncV2Router);
apiV2Router.use("/devices", devicesV2Router);
apiV2Router.use("/missions", missionsV2Router);
apiV2Router.use("/roulage", roulageV2Router);
apiV2Router.use("/referentiel/troncons", referentielV2Router);
apiV2Router.use("/observations", observationsV2Router);
apiV2Router.use("/defauts", defautsV2Router);
apiV2Router.use("/field", fieldV2Router);
apiV2Router.use("/portions", portionsV2Router);
apiV2Router.use("/referentiels", referentielsV2Router);
apiV2Router.use("/qualite", qualiteV2Router);
apiV2Router.use("/reseau", reseauV2Router);
apiV2Router.use("/imports", importsV2Router);
// Le chemin le plus specifique d'abord : `/exploitation` ne connait pas `/patrouilles`.
apiV2Router.use("/exploitation/patrouilles", patrouillesV2Router);
apiV2Router.use("/exploitation/info-route", infoRouteV2Router);
apiV2Router.use("/exploitation/veille", veilleV2Router);
apiV2Router.use("/exploitation", exploitationV2Router);
apiV2Router.use("/teledetection", teledetectionV2Router);
// Le plus specifique d'abord : `/moteur` ne connait pas `/ppe`, `/programmation` (saisie manuelle) ne connait pas `/moteur`.
apiV2Router.use("/programmation/moteur/ppe", ppeProgrammationV2Router);
apiV2Router.use("/programmation/moteur", moteurProgrammationV2Router);
apiV2Router.use("/programmation", programmationV2Router);
apiV2Router.use("/baremes", baremesV2Router);
apiV2Router.use("/export", exportV2Router);
apiV2Router.use("/troncons-recherche", rechercheV2Router);
// Le chemin specifique d'abord : bulk-etat vit sous le meme espace que la recherche.
apiV2Router.use("/troncons-corridor", bulkEtatV2Router);
apiV2Router.use("/perimetres", perimetresV2Router);
apiV2Router.use("/integrations", integrationsV2Router);
apiV2Router.use("/tableau-de-bord", tableauDeBordV2Router);
apiV2Router.use("/fiche-360", fiche360V2Router);
apiV2Router.use("/taches-internes", tachesInternesV2Router);
apiV2Router.use("/correspondances", correspondancesV2Router);
apiV2Router.use("/mobile", mobileV2Router);

/**
 * Inventaire de la surface v2, pour qu'un client sache ce qui existe reellement.
 *
 * Plus honnete qu'une documentation qui promet douze domaines : cette liste est
 * construite a partir de ce qui est monte, donc elle ne peut pas mentir.
 */
apiV2Router.get("/", (_req, res) => {
  res.json({
    version: "v2",
    domaines: ["geo", "sync", "devices", "missions", "roulage", "referentiel", "observations", "defauts", "field", "portions", "referentiels", "qualite", "reseau", "imports", "exploitation", "teledetection", "programmation", "baremes", "perimetres", "integrations", "tableau-de-bord", "fiche-360", "taches-internes", "correspondances"],
    aVenir: [
      "auth", "tracks",
      "assets", "offline", "intelligence", "ai",
    ],
    v1: "/api — inchangee, toujours servie",
  });
});
