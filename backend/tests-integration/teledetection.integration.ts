// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/teledetection.integration.ts
import "./lib/garde";
// Epreuve d'integration de la teledetection contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import {
  enregistrerProduit, deposerPropositions, poserVerdict, depecherVerificationTeledetection, precision, RefusTeledetection,
} from "../src/teledetection/teledetection.service";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const depot = new Proxy(tx as unknown as Record<string, unknown>, {
        get: (t, k) => (k === "$transaction" ? (fn: (x: unknown) => unknown) => fn(tx) : t[k as string]),
      }) as never;
      await tx.$executeRawUnsafe(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-tdi','tdi@local.invalid','Integ','x','GESTIONNAIRE',now())`);
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region integ td')`);
      // Troncon est-ouest a la latitude 9,64, de -13,60 a -13,59.
      await tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
        VALUES ('t-tdi', 'TDI-A', 'Troncon integ', 'RN', (SELECT id FROM regions WHERE nom='Region integ td'), 1.1, 'BITUME', 0, 1.1,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), now())`);
      const ctx = { auteurId: "u-tdi" };

      const p = await enregistrerProduit(depot, {
        code: "S1-INTEG", palier: 0, source: "Sentinel-1 GRD", nature: "RADAR", dateAcquisition: new Date("2026-10-02"), resolutionM: 10,
        incertitude: "chatoiement radar", provenance: "scene-integ", licence: "relevee a la source", versionTraitement: "v0",
        emprise: { type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.4, 9.5], [-13.4, 9.8], [-13.7, 9.8], [-13.7, 9.5]]] },
      }, ctx);
      console.log("produit enregistre :", p.code);

      try { await enregistrerProduit(depot, { ...({} as never), code: "X", palier: 1, source: "x", nature: "OPTIQUE", dateAcquisition: new Date(), resolutionM: 3, couvertureNuagesPct: 1, incertitude: "x", provenance: "x", licence: "x", versionTraitement: "x", emprise: { type: "Polygon", coordinates: [] } }, ctx); console.log("ERREUR : palier 1 accepte"); }
      catch (e) { console.log("palier 1 sans autorisation :", e instanceof RefusTeledetection ? e.code : e); }

      // Trois points : a ~11 m au nord du troncon, a ~555 m au nord, et loin.
      const lot = [
        { type: "INONDATION" as const, geometrie: { type: "Point", coordinates: [-13.595, 9.6401] }, score: 0.9 },
        { type: "INONDATION" as const, geometrie: { type: "Point", coordinates: [-13.595, 9.645] }, score: 0.6 },
        { type: "INONDATION" as const, geometrie: { type: "Point", coordinates: [-13.45, 9.75] }, score: null },
      ];
      const sans = await deposerPropositions(depot, { produitId: p.id, methode: "seuil-sar v0", propositions: lot }, ctx);
      console.log("sans tolerance :", JSON.stringify({ deposees: sans.deposees, rattachees: sans.rattachees }));
      const avec = await deposerPropositions(depot, { produitId: p.id, methode: "seuil-sar v0", toleranceRattachementM: 50, propositions: lot }, ctx);
      const rattachees = await tx.propositionTeledetection.findMany({ where: { id: { in: avec.ids } }, select: { tronconId: true, distanceTronconM: true } });
      console.log("tolerance 50 m :", rattachees.map((r) => r.tronconId ? `${r.tronconId}@${r.distanceTronconM?.toFixed(1)}m` : "non rattachee").join(", "));

      const v = await poserVerdict(depot, avec.ids[0], { statut: "CONFIRMEE", motif: "Eau sur la chaussee", constatRef: "mission:VER-INTEG" }, ctx);
      console.log("verdict :", v.statut, "verifieeLe pose par le serveur :", v.verifieeLe instanceof Date);
      await poserVerdict(depot, avec.ids[1], { statut: "INFIRMEE", motif: "Chaussee seche", constatRef: "observation:O-INTEG" }, ctx);
      try { await poserVerdict(depot, avec.ids[0], { statut: "INFIRMEE", motif: "x", constatRef: "y" }, ctx); console.log("ERREUR : verdict repris"); }
      catch (e) { console.log("reprise :", e instanceof RefusTeledetection ? e.code : e); }

      const m = await depecherVerificationTeledetection(depot, avec.ids[2], {}, ctx);
      console.log("mission :", m.code, m.type, m.statut);
      const lignes = (await precision(depot)).filter((l) => l.methode === "seuil-sar v0");
      console.log("precision :", lignes.map((l) => `${l.type} total=${l.total} confirmees=${l.confirmees} infirmees=${l.infirmees} precision=${l.precision}`).join(" ; "));
      const audits = await tx.auditLog.groupBy({ by: ["action", "entityType"], where: { userId: "u-tdi" }, _count: true });
      console.log("audits :", audits.map((a) => `${a.action}:${a.entityType}:${a._count}`).sort().join(", "));
      throw new Annulation();
    }, { timeout: 120_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  console.log("produits restants :", await prisma.earthObservationProduct.count());
}
main().finally(() => prisma.$disconnect());
