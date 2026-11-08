/**
 * Plans d'execution REELS (EXPLAIN ANALYZE, BUFFERS) des requetes dont depend un seuil.
 *
 * Le SQL de l'appariement est CAPTURE au moment de l'appel reel de `apparier()` (on enveloppe
 * `prisma.$queryRawUnsafe` le temps d'un appel), pas recopie : le plan montre ce que le code envoie.
 * Les autres requetes sont recopiees des sources et le disent.
 */
import { Client } from "pg";
import { empriseMission } from "./points-gps";
import type { Contexte } from "./mesures";

interface Capture { sql: string; params: unknown[] }

async function capturer(c: Contexte, f: () => Promise<unknown>): Promise<Capture | null> {
  const p = c.mod.prisma as unknown as { $queryRawUnsafe: (...a: unknown[]) => Promise<unknown> };
  const origine = p.$queryRawUnsafe.bind(p);
  let pris: Capture | null = null;
  try {
    p.$queryRawUnsafe = (...a: unknown[]) => { if (!pris) pris = { sql: String(a[0]), params: a.slice(1) }; return origine(...a); };
  } catch { return null; }
  try { await f(); } finally { p.$queryRawUnsafe = origine; }
  return pris;
}

async function expliquer(client: Client, sql: string, params: unknown[]): Promise<string> {
  // Trois passages : le dernier est a chaud (plan et buffers deja en memoire).
  let texte = "";
  for (let k = 0; k < 3; k += 1) {
    const r = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params as never[]);
    texte = r.rows.map((x) => x["QUERY PLAN"]).join("\n");
  }
  return texte;
}

export async function capturerPlans(c: Contexte, urlClone: string): Promise<Record<string, string>> {
  const client = new Client({ connectionString: urlClone });
  await client.connect();
  const plans: Record<string, string> = {};
  try {
    const p = c.points.find((x) => x.groupe === "classe-5m")!;
    const u = c.points.find((x) => x.groupe === "urbain-5m")!;
    const pos = (q: { lat: number; lon: number; precisionM: number }) => ({ lat: q.lat, lon: q.lon, precisionM: q.precisionM });

    const cas: [string, () => Promise<unknown>][] = [
      ["candidats.reference.sans-emprise", () => c.mod.apparier(pos(p), { reseau: "reference" })],
      ["candidats.tout.sans-emprise", () => c.mod.apparier(pos(u), { reseau: "tout" })],
      ["candidats.tout.emprise-4km", () => c.mod.apparier(pos(u), { reseau: "tout", emprise: empriseMission(u, 2) })],
    ];
    for (const [nom, f] of cas) {
      const cap = await capturer(c, f);
      plans[nom] = cap ? await expliquer(client, cap.sql, cap.params) : "(requete non capturee)";
    }

    // Recopie de graphe.depot.ts (SQL de chargement), pour une emprise de 50 km autour d'un troncon classe.
    // Troncon classe le plus proche du centre du pays (-11,5 ; 10,5) : un cas rural, loin des grandes agglomerations.
    const idCentre = (await client.query<{ id: string }>(`SELECT id FROM troncons WHERE "sourceReference" IS NULL ORDER BY geom <-> ST_SetSRID(ST_MakePoint(-11.5, 10.5), 4326) LIMIT 1`)).rows[0].id;
    const k = c.reseau.troncons.find((t) => t.id === idCentre)!;
    const [e] = (await client.query<{ o: number; s: number; e: number; n: number }>(
      `SELECT ST_XMin(b) AS o, ST_YMin(b) AS s, ST_XMax(b) AS e, ST_YMax(b) AS n
         FROM (SELECT ST_Envelope(ST_Buffer(geom::geography, 25000)::geometry) AS b FROM troncons WHERE id = $1) x`, [k.id])).rows;
    plans["graphe.chargement-emprise-50km"] = await expliquer(client,
      `SELECT t."id", ST_Length(t."geom"::geography) AS "longueurM", ST_AsGeoJSON(t."geom") AS "geojson"
         FROM "troncons" t WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
          AND t."geom" && ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326) LIMIT 20001`,
      [e.o, e.s, e.e, e.n]);

    // Recopie de la forme Prisma de la route /api/search (ILIKE '%q%' sur code ou nom, take 5).
    plans["recherche.absent"] = await expliquer(client,
      `SELECT t."id", t."code", t."nom" FROM "troncons" t
        WHERE t."deletedAt" IS NULL AND (t."code" ILIKE $1 OR t."nom" ILIKE $1) LIMIT 5`, ["%zqplmk%"]);
    plans["recherche.mot-de-nom"] = await expliquer(client,
      `SELECT t."id", t."code", t."nom" FROM "troncons" t
        WHERE t."deletedAt" IS NULL AND (t."code" ILIKE $1 OR t."nom" ILIKE $1) LIMIT 5`, [`%${k.nom.split(" ")[1].toLowerCase()}%`]);
  } finally {
    await client.end();
  }
  return plans;
}
