// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/historique.integration.ts
import "./lib/garde";
// Epreuve de l'historique d'une section et du classement « a controler » contre `replay`, transaction ANNULEE.
// Les valeurs attendues sont CALCULEES A LA MAIN ici, pas relues du service.
import { PrismaClient } from "@prisma/client";
import { aControler, voletConstats } from "../src/tableau-de-bord/historique.service";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
class Annulation extends Error {}
const MAINTENANT = new Date("2026-10-25T12:00:00Z");
const avant = (jours: number) => new Date(MAINTENANT.getTime() - jours * 86_400_000).toISOString();

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const sql = (q: string) => tx.$executeRawUnsafe(q);
      const depot = tx as unknown as PrismaClient;
      await sql(`INSERT INTO regions (nom) VALUES ('Region integ histo A'), ('Region integ histo B')`);
      await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-histo','histo@local.invalid','Integ','x','INSPECTEUR',now())`);
      await sql(`INSERT INTO catalogue_defauts (code, libelle, famille, unite, "updatedAt") VALUES ('NID_HISTO','Nid de poule (essai)','CHAUSSEE','UNITE',now()), ('FISS_HISTO','Fissure (essai)','CHAUSSEE','METRE',now())`);
      const troncon = (id: string, region: string) => sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", "updatedAt")
        VALUES ('${id}', '${id.toUpperCase()}', 'Route ${id}', 'RN', (SELECT id FROM regions WHERE nom='${region}'), 1, 'BITUME', 0, 1, now())`);
      await troncon("h-a", "Region integ histo A");
      await troncon("h-b", "Region integ histo A");
      await troncon("h-c", "Region integ histo B");
      await troncon("h-vide", "Region integ histo A");

      let n = 0;
      // Un defaut vit dans une observation « conteneur » (colonne observationId obligatoire).
      const defaut = async (tronconId: string, code: string, gravite: number, statut: string, jours: number, etat = "ACTIF") => {
        n += 1;
        await sql(`INSERT INTO observations (id, "clientOperationId", "agentId", type, statut, "observeA", "tronconId", "updatedAt")
          VALUES ('oc-${n}', 'op-oc-${n}', 'u-histo', 'DEGRADATION', 'PROPOSEE', '${avant(jours)}', '${tronconId}', now())`);
        await sql(`INSERT INTO defauts (id, "catalogueId", "observationId", "tronconId", gravite, "statutValidation", etat, "constateA", "constateParId", "updatedAt")
          VALUES ('d-${n}', (SELECT id FROM catalogue_defauts WHERE code='${code}'), 'oc-${n}', '${tronconId}', ${gravite}, '${statut}', '${etat}', '${avant(jours)}', 'u-histo', now())`);
      };
      const observation = async (tronconId: string, type: string, gravite: string | null, statut: string, jours: number, deleted = false) => {
        n += 1;
        await sql(`INSERT INTO observations (id, "clientOperationId", "agentId", type, statut, gravite, "observeA", "tronconId", "deletedAt", "updatedAt")
          VALUES ('o-${n}', 'op-o-${n}', 'u-histo', '${type}', '${statut}', ${gravite ? `'${gravite}'` : "NULL"}, '${avant(jours)}', '${tronconId}', ${deleted ? "now()" : "NULL"}, now())`);
      };

      // h-a : defaut grave A_VALIDER (30 j), meme type VALIDE grave (10 j) -> recurrence ; observation FORTE PROPOSEE (5 j) ;
      //       defaut REJETE (3 j, ecarte) ; observation supprimee logiquement (2 j, ecartee) ; defaut TRAITE (4 j, passe).
      await defaut("h-a", "NID_HISTO", 3, "A_VALIDER", 30);
      await defaut("h-a", "NID_HISTO", 4, "VALIDE", 10);
      await observation("h-a", "DEGRADATION", "FORTE", "PROPOSEE", 5);
      await defaut("h-a", "FISS_HISTO", 4, "REJETE", 3);
      await observation("h-a", "AUTRE", "FORTE", "PROPOSEE", 2, true);
      await defaut("h-a", "FISS_HISTO", 3, "A_VALIDER", 4, "TRAITE");
      // h-b : une seule observation FAIBLE VALIDEE il y a 400 jours -> information ancienne uniquement.
      await observation("h-b", "ASSAINISSEMENT", "FAIBLE", "VALIDEE", 400);
      // h-c : autre region, une observation FORTE PROPOSEE (1 j).
      await observation("h-c", "SECURITE", "FORTE", "PROPOSEE", 1);

      // ---- volet d'un troncon
      const v = await voletConstats(depot, "h-a");
      verifier("le volet de h-a existe et nomme le troncon", v?.tronconCode === "H-A", v?.tronconCode);
      const h = v!.historique;
      // Retenus : 2 defauts NID, 1 observation FORTE, 1 defaut FISS TRAITE (un defaut traite reste dans l'histoire) = 4 ; rejete et supprime ecartes.
      verifier("4 constats retenus : 3 defauts et 1 observation (le rejete et le supprime logiquement sont ecartes)", h.total === 4 && h.defauts === 3 && h.observations === 1, h);
      verifier("1 confirme (le NID valide) et 3 proposes, comptes a part", h.confirmes === 1 && h.proposes === 3, h);
      verifier("le defaut rejete est ecarte ET compte comme ecarte (1) ; l'observation supprimee n'est pas lue", h.rejetesEcartes === 1, h.rejetesEcartes);
      verifier("une recurrence : NID constate a 2 dates, rien d'autre", h.recurrents.length === 1 && h.recurrents[0].cle === "DEFAUT:NID_HISTO" && h.recurrents[0].nbDates === 2, h.recurrents);
      verifier("l'histoire va du constat de 30 j a celui de 4 j (le defaut traite est le plus recent retenu)", h.premierConstat === avant(30).slice(0, 10) && h.dernierConstat === avant(4).slice(0, 10), [h.premierConstat, h.dernierConstat]);
      verifier("la liste detaillee porte les 4 constats, les graves marques", v!.liste.length === 4 && v!.liste.filter((c) => c.grave).length === 4, v!.liste.map((c) => [c.type, c.grave]));
      verifier("un tronçon inconnu : null (la route repond 404)", (await voletConstats(depot, "inconnu")) === null);
      const vide = await voletConstats(depot, "h-vide");
      verifier("un troncon sans constat : histoire vide, jamais d'erreur", vide!.historique.total === 0 && vide!.liste.length === 0, vide!.historique);

      // ---- classement national
      const nat = await aControler(depot, { regionIds: null, limite: 10, maintenant: MAINTENANT });
      const l = Object.fromEntries(nat.lignes.map((x) => [x.tronconId, x]));
      // h-a : graves recents presents : NID 3 (30 j), NID 4 (10 j), observation FORTE (5 j) = 3 -> 9 ; le defaut TRAITE n'est plus present ;
      //       en attente (non confirmes, presents) : NID A_VALIDER + observation PROPOSEE = 2 -> 2 ; recurrence NID = 1 -> 2 ; total 13.
      verifier("h-a : score 13 calcule a la main (9 + 2 + 2)", l["h-a"]?.score === 13, l["h-a"]);
      verifier("h-a : trois facteurs, dont 3 constats graves", l["h-a"]?.facteurs.map((f) => `${f.facteur}:${f.nombre}`).join(",") === "constats_graves:3,constats_en_attente:2,recurrences:1", l["h-a"]?.facteurs);
      verifier("h-b : 2 points, l'information a plus d'un an", l["h-b"]?.score === 2 && l["h-b"].facteurs[0].facteur === "information_ancienne", l["h-b"]);
      // h-c : FORTE PROPOSEE il y a 1 j : grave recent 3 + en attente 1 = 4.
      verifier("h-c : score 4 (3 + 1)", l["h-c"]?.score === 4, l["h-c"]);
      verifier("ordre : h-a (13), h-c (4), h-b (2)", nat.lignes.map((x) => x.tronconId).join(",") === "h-a,h-c,h-b", nat.lignes.map((x) => x.tronconId));
      verifier("les informations du troncon (code, region) accompagnent la ligne", l["h-a"].tronconCode === "H-A" && l["h-a"].regionNom === "Region integ histo A", l["h-a"]);
      verifier("le troncon sans constat n'est pas classe, et il est compte a part", !("h-vide" in l) && nat.sansConstatSurLeReseau >= 1, nat.sansConstatSurLeReseau);

      // ---- perimetre regional : la region B ne voit que h-c
      const regB = await aControler(depot, { regionIds: [(await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom='Region integ histo B'`))[0].id], limite: 10, maintenant: MAINTENANT });
      verifier("un perimetre regional ne classe que ses troncons", regB.lignes.map((x) => x.tronconId).join(",") === "h-c", regB.lignes.map((x) => x.tronconId));
      verifier("la limite d'affichage tronque la liste mais pas le total classe", (await aControler(depot, { regionIds: null, limite: 1, maintenant: MAINTENANT })).lignes.length === 1 && nat.totalClasses >= 3);
      verifier("les poids provisoires sont rendus avec le resultat", nat.poids.provenance === "PROVISOIRE_NON_CALIBRE", nat.poids);
      throw new Annulation();
    }, { timeout: 120_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
