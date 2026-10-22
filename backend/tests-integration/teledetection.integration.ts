// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/teledetection.integration.ts
import "./lib/garde";
// Epreuve d'integration de la teledetection contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import {
  enregistrerProduit, deposerPropositions, poserVerdict, depecherVerificationTeledetection, precision, RefusTeledetection,
} from "../src/teledetection/teledetection.service";
import { verifier, conclure, proche } from "./lib/verdict";

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
      verifier("le produit du palier 0 est enregistre", p.code === "S1-INTEG");

      try { await enregistrerProduit(depot, { ...({} as never), code: "X", palier: 1, source: "x", nature: "OPTIQUE", dateAcquisition: new Date(), resolutionM: 3, couvertureNuagesPct: 1, incertitude: "x", provenance: "x", licence: "x", versionTraitement: "x", emprise: { type: "Polygon", coordinates: [] } }, ctx); verifier("ERREUR : palier 1 accepte", false); }
      catch (e) { verifier("un produit payant (palier 1) sans autorisation de depense est refuse", e instanceof RefusTeledetection && e.code === "DEPENSE_NON_AUTORISEE", e instanceof RefusTeledetection ? e.code : String(e)); }

      // Trois points : a ~11 m au nord du troncon, a ~555 m au nord, et loin.
      const lot = [
        { type: "INONDATION" as const, geometrie: { type: "Point", coordinates: [-13.595, 9.6401] }, score: 0.9 },
        { type: "INONDATION" as const, geometrie: { type: "Point", coordinates: [-13.595, 9.645] }, score: 0.6 },
        { type: "INONDATION" as const, geometrie: { type: "Point", coordinates: [-13.45, 9.75] }, score: null },
      ];
      const sans = await deposerPropositions(depot, { produitId: p.id, methode: "seuil-sar v0", propositions: lot }, ctx);
      verifier("sans tolerance fournie, 3 propositions sont deposees et AUCUNE n'est rattachee (pas de tolerance supposee)", sans.deposees === 3 && sans.rattachees === 0, { deposees: sans.deposees, rattachees: sans.rattachees });
      const avec = await deposerPropositions(depot, { produitId: p.id, methode: "seuil-sar v0", toleranceRattachementM: 50, propositions: lot }, ctx);
      const rattachees = await tx.propositionTeledetection.findMany({ where: { id: { in: avec.ids } }, select: { tronconId: true, distanceTronconM: true } });
      // Oracle : 0,0001 degre de latitude = 11,13 m ; 0,005 degre = 556,6 m, au-dela des 50 m.
      verifier("avec 50 m, seul le point a 11 m est rattache, au troncon, a sa vraie distance", rattachees[0].tronconId === "t-tdi" && proche(rattachees[0].distanceTronconM ?? -1, 11.13, 0.3) && rattachees[1].tronconId === null && rattachees[2].tronconId === null, rattachees);

      const v = await poserVerdict(depot, avec.ids[0], { statut: "CONFIRMEE", motif: "Eau sur la chaussee", constatRef: "mission:VER-INTEG" }, ctx);
      verifier("un verdict CONFIRMEE est rendu et la date de verification est posee par le serveur", v.statut === "CONFIRMEE" && v.verifieeLe instanceof Date, v.statut);
      await poserVerdict(depot, avec.ids[1], { statut: "INFIRMEE", motif: "Chaussee seche", constatRef: "observation:O-INTEG" }, ctx);
      try { await poserVerdict(depot, avec.ids[0], { statut: "INFIRMEE", motif: "x", constatRef: "y" }, ctx); verifier("ERREUR : verdict repris", false); }
      catch (e) { verifier("un verdict est unique : le reprendre est refuse (VERDICT_DEJA_RENDU)", e instanceof RefusTeledetection && e.code === "VERDICT_DEJA_RENDU", e instanceof RefusTeledetection ? e.code : String(e)); }

      const m = await depecherVerificationTeledetection(depot, avec.ids[2], {}, ctx);
      verifier("la verification terrain d'une proposition cree une mission BROUILLON de SURVEILLANCE", /^VER-TD-[0-9A-Z]{8}$/.test(m.code) && m.type === "SURVEILLANCE" && m.statut === "BROUILLON", { code: m.code, type: m.type, statut: m.statut });
      const lignes = (await precision(depot)).filter((l) => l.methode === "seuil-sar v0");
      // 6 propositions deposees (deux lots de 3), 1 confirmee, 1 infirmee : precision = 1 / (1 + 1).
      verifier("la precision mesuree est confirmees / (confirmees + infirmees) = 0,5 sur 6 propositions", lignes.length === 1 && lignes[0].total === 6 && lignes[0].confirmees === 1 && lignes[0].infirmees === 1 && lignes[0].precision === 0.5, lignes);
      const audits = await tx.auditLog.groupBy({ by: ["action", "entityType"], where: { userId: "u-tdi" }, _count: true });
      const aud = audits.map((a) => `${a.action}:${a.entityType}:${a._count}`).sort().join(", ");
      verifier("toute ecriture est auditee, rien d'autre", aud === "CREATE:EarthObservationProduct:1, CREATE:Mission:1, CREATE:PropositionTeledetection:2, REJECT:PropositionTeledetection:1, VALIDATE:PropositionTeledetection:1", aud);
      throw new Annulation();
    }, { timeout: 120_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  verifier("rien ne subsiste apres l'annulation (0 produit)", (await prisma.earthObservationProduct.count()) === 0);
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
