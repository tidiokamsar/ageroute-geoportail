// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/trace.integration.ts
import "./lib/garde";
// Integration : analyserTrace contre PostGIS reel (base de rejeu locale), transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { analyserTrace } from "../src/geo/trace.service";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
const ROLLBACK = new Error("ROLLBACK_VOULU");
const bruit = (k: number) => Math.sin(k * 12.9898) * 4.5e-5; // +/- 5 m environ, deterministe

async function main() {
  let resultat: Awaited<ReturnType<typeof analyserTrace>> | null = null;
  let avecGraphe: Awaited<ReturnType<typeof analyserTrace>> | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region de test trace')`);
      const ligne = (id: string, code: string, a: [number, number], b: [number, number], km: number) =>
        tx.$executeRawUnsafe(
          `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
           VALUES ('${id}', '${code}', 'Troncon ${code}', 'RN', (SELECT id FROM regions WHERE nom='Region de test trace'), ${km}, 'BITUME', 0, ${km},
                   ST_SetSRID(ST_MakeLine(ST_MakePoint(${a[0]}, ${a[1]}), ST_MakePoint(${b[0]}, ${b[1]})), 4326), CURRENT_TIMESTAMP)`);
      await ligne("t-trc-a", "TRC-A", [-13.60, 9.64], [-13.58, 9.64], 2.2);       // vers l'est
      await ligne("t-trc-b", "TRC-B", [-13.58, 9.64], [-13.58, 9.66], 2.2);       // vers le nord
      await ligne("t-trc-c", "TRC-C", [-13.60, 9.64036], [-13.5810, 9.64036], 2.1); // leurre parallele a 40 m de A, loin de B

      const pasLon = 20 / (111320 * Math.cos((9.64 * Math.PI) / 180));
      const pasLat = 20 / 111320;
      const pts: { lat: number; lon: number; tMs: number; precisionM: null }[] = [];
      let k = 0;
      for (let lon = -13.60; lon < -13.58; lon += pasLon) pts.push({ lat: 9.64 + bruit(k++), lon, tMs: k * 2000, precisionM: null });
      for (let lat = 9.64; lat < 9.66; lat += pasLat) pts.push({ lat, lon: -13.58 + bruit(k++), tMs: k * 2000, precisionM: null });
      for (let lon = -13.58; lon < -13.57; lon += pasLon) pts.push({ lat: 9.66 + bruit(k++), lon, tMs: k * 2000, precisionM: null }); // hors reseau

      const derniereLigne = (e: unknown) => String((e as Error).message).trim().split(/\r?\n/).pop();
      try { resultat = await analyserTrace(tx as never, { points: pts }); console.log("SANS graphe : ok"); } catch (e) { console.log("SANS graphe : ECHEC", derniereLigne(e)); throw e; }
      try { avecGraphe = await analyserTrace(tx as never, { points: pts }, { toleranceFusionM: 2 }); console.log("AVEC graphe : ok"); } catch (e) { console.log("AVEC graphe : ECHEC", derniereLigne(e)); throw e; }
      throw ROLLBACK;
    }, { timeout: 120000 });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  const r = resultat!;
  console.log("indicateurs:", JSON.stringify(r.indicateurs));
  console.log("passages:", r.passages.map((p) => `${p.code} ${p.sens} de ${p.deM}m a ${p.aM}m (${p.longueurM}m, ${p.nombrePoints} pts, geom=${p.geojson ? (p.geojson as { type: string }).type : "non"})`));
  console.log("hors referentiel:", r.horsReferentiel.map((s) => `${s.nombrePoints} pts, ${s.longueurM} m`));
  console.log("avertissements:", r.avertissements);

  const codes = r.passages.map((p) => p.code);
  const ok = {
    "A puis B, jamais le leurre C": codes.length >= 2 && codes[0] === "TRC-A" && codes[codes.length - 1] === "TRC-B" && !codes.includes("TRC-C"),
    "A parcouru dans le sens croissant sur environ 2,2 km": r.passages[0]?.sens === "CROISSANT" && Math.abs((r.passages[0]?.longueurM ?? 0) - 2190) < 200,
    "la geometrie des passages non courts est extraite": r.passages.filter((p) => !p.court).every((p) => p.geojson !== null),
    "la suite hors reseau est detectee": r.horsReferentiel.length >= 1 && r.horsReferentiel.some((s) => s.longueurM > 500),
    "taux de rattachement entre 0,7 et 0,95": r.indicateurs.tauxRattachement > 0.7 && r.indicateurs.tauxRattachement < 0.95,
  };
  const g = avecGraphe!;
  console.log("AVEC GRAPHE parametres.graphe:", JSON.stringify(g.parametres.graphe), "| non verifiees:", g.indicateurs.transitionsNonVerifiees, "(sans graphe:", r.indicateurs.transitionsNonVerifiees + ")");
  console.log("passages avec graphe:", g.passages.map((p) => p.code));
  (ok as Record<string, boolean>)["graphe : charge depuis PostGIS, 3 troncons, tolerance 2 m"] = g.parametres.graphe?.nbTroncons === 3 && g.parametres.graphe?.toleranceFusionM === 2;
  (ok as Record<string, boolean>)["graphe : la jonction A->B est VERIFIEE (0 non verifie)"] = g.indicateurs.transitionsNonVerifiees === 0 && r.indicateurs.transitionsNonVerifiees > 0;
  (ok as Record<string, boolean>)["graphe : meme parcours, A puis B, sans le leurre C"] = eq2(g.passages.map((p) => p.code), ["TRC-A", "TRC-B"]);
  const verif = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM troncons WHERE id IN ('t-trc-a','t-trc-b','t-trc-c')`);
  ok["fixtures restantes apres annulation : 0"] = String(verif[0].n) === "0";
  for (const [nom, vrai] of Object.entries(ok)) verifier(nom, vrai);
  conclure();
}
function eq2(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
