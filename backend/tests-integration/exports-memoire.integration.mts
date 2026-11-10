// Mesure de la MEMOIRE DE POINTE de l'export du dossier technique (revue du lot X1, M3), contre un vrai PostGIS, dans le clone jetable `essai_export_memoire`.
// Cas de la revue : 50 000 objets, 1 000 000 de sommets, noms de 1 500 caracteres ; et le meme volume avec des noms de 20 caracteres.
// Lancer (DATABASE_URL pointe sur `replay`) :  npx tsx tests-integration/exports-memoire.integration.mts
// Mesure dans le processus (route reelle par supertest) : RSS echantillonne toutes les 20 ms pendant l'export ; ce n'est pas la memoire de production.
// DONNEES 100 % SYNTHETIQUES : lignes de 20 sommets generees par PostGIS dans l'emprise nationale configuree, noms de lettres repetees.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_export_memoire", { migrations: ["20261104200000_exports_tableaux_de_bord"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;
process.env.PROJETS_VOIRIE_EXPORT_CADENCE_MAX = "1000";
const app = createApp();
const BASE = "/api/v2/projets-voirie";
const sql = (t: string, ...v: unknown[]) => prisma.$queryRawUnsafe(t, ...v) as Promise<Record<string, unknown>[]>;
const Mo = (o: number) => Math.round(o / 1024 / 1024);

async function main() {
  const admin = await prisma.user.create({ data: { email: "admin@mem-x1.invalid", nomComplet: "Admin memoire X1", passwordHash: "x", role: "ADMIN", modulesAutorises: [] } });
  const chef = await prisma.user.create({ data: { email: "chef@mem-x1.invalid", nomComplet: "Gestionnaire memoire X1", passwordHash: "x", role: "GESTIONNAIRE", modulesAutorises: ["projets-voirie"] } });
  const T = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const nation = (await sql(`SELECT id FROM territoires_voirie WHERE niveau = 'NATION' AND "deletedAt" IS NULL LIMIT 1`))[0].id as string;
  const mesures: Record<string, unknown> = {};
  for (const [cas, longueurNom, role] of [["axes-noms-1500", 1500, "AXES_TRAVAUX"], ["limites-noms-1500", 1500, "LIMITES_ROUTE"], ["limites-noms-20", 20, "LIMITES_ROUTE"]] as const) {
    const p = await request(app).post(BASE).set("Authorization", `Bearer ${T(chef)}`).send({ code: `MEM-${role.slice(0, 4)}-${longueurNom}`, nom: `Memoire ${cas}`, territoireId: nation });
    const pid = p.body.projet.id as string;
    const f = Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Graine" }, geometry: { type: "LineString", coordinates: [[-10, 9], [-10.001, 9.001]] } }] }));
    const d = await request(app).post(`${BASE}/${pid}/jeux`).set("Authorization", `Bearer ${T(chef)}`).field("role", role).field("confidentialite", "PUBLIC").attach("fichier", f, { filename: "graine.geojson" });
    const jeu = d.body.jeu.id as string;
    await request(app).post(`${BASE}/${pid}/jeux/${jeu}/autoriser`).set("Authorization", `Bearer ${T(admin)}`).send({ justification: "Jeu de mesure synthetique" });
    // 49 999 objets de 20 sommets ajoutes en base (hors declencheurs) : 50 000 objets et 1 000 000 de sommets au total avec la graine (2 sommets).
    await prisma.$transaction(async (tx: typeof prisma) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(`
        INSERT INTO projets_voirie_objets ("jeuId", nom, "typeGeom", geom, "longueurM", attributs, empreinte, ordre)
        SELECT $1, repeat('n', $2::int), 'LIGNE',
               (SELECT ST_SetSRID(ST_MakeLine(array_agg(ST_MakePoint(-12 + (i % 500) * 0.004 + k * 0.0001, 8 + (i / 500) * 0.004 + k * 0.00005) ORDER BY k)), 4326) FROM generate_series(0, 19) k),
               10, '{}'::jsonb, md5(i::text) || '00000000', i
          FROM generate_series(1, 49999) i`, jeu, longueurNom);
    }, { timeout: 600_000 });
    const nb = (await sql(`SELECT count(*)::int n, sum(ST_NPoints(geom))::int s FROM projets_voirie_objets WHERE "jeuId" = $1`, jeu))[0];
    if (global.gc) global.gc();
    const avant = process.memoryUsage().rss;
    let pointe = avant;
    const echantillon = setInterval(() => { pointe = Math.max(pointe, process.memoryUsage().rss); }, 20);
    const t0 = Date.now();
    const r = await request(app).get(`${BASE}/${pid}/export/dossier`).set("Authorization", `Bearer ${T(chef)}`).buffer(true).parse((res, cb) => {
      const m: Buffer[] = []; res.on("data", (c: Buffer) => m.push(c)); res.on("end", () => cb(null, Buffer.concat(m)));
    });
    clearInterval(echantillon);
    pointe = Math.max(pointe, process.memoryUsage().rss);
    const corps = r.status === 200 ? null : JSON.parse((r.body as Buffer).toString());
    mesures[cas] = {
      objets: nb.n, sommets: nb.s, statut: r.status, code: corps?.code ?? null, detail: corps ? { octets: corps.octets, octetsEstimes: corps.octetsEstimes, octetsMax: corps.octetsMax } : null,
      archiveMo: r.status === 200 ? Mo((r.body as Buffer).length) : null, rssAvantMo: Mo(avant), rssPointeMo: Mo(pointe), hausseMo: Mo(pointe - avant), dureeMs: Date.now() - t0,
    };
    console.log(cas, JSON.stringify(mesures[cas]));
    // Un plan d'AXES de 50 000 objets passe aussi par l'analyse 2D du socle (reponse complete en memoire, comme GET /:id/analyse) : mesure rapportee, seuil non applique.
    verifier(`${cas} : export borne (200 sous le plafond, 422 EXPORT_TROP_VOLUMINEUX, ou 504 EXPORT_TROP_LONG avant 55 s)${role === "LIMITES_ROUTE" ? " et hausse de RSS sous 400 Mo" : ""}`, (r.status === 200 || corps?.code === "EXPORT_TROP_VOLUMINEUX" || (corps?.code === "EXPORT_TROP_LONG" && Date.now() - t0 < 55_000)) && (role !== "LIMITES_ROUTE" || pointe - avant < 400 * 1024 * 1024), mesures[cas]);
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  verifier("la mesure va jusqu'au bout", false, String(e));
} finally {
  conclure();
  await prisma.$disconnect();
  await banc.fermer();
}
