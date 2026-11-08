// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/tuiles.integration.ts
import "./lib/garde";
// Tuiles vectorielles MVT (paragraphe 7.14) contre PostGIS reel, transaction ANNULEE.
//
// L'ORACLE : la tuile rendue par `ST_AsMVT` est DECODEE ici (lecteur protobuf minimal, sans dependance)
// et son contenu compare aux fixtures : nombre d'objets par couche, noms des proprietes, valeur d'un
// code. Le service et ce lecteur ne partagent aucun code.
import { PrismaClient } from "@prisma/client";
import { tuileReseau } from "../src/tuiles/tuiles.service";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
class Annulation extends Error {}

// ---- Lecteur protobuf minimal : Tile.layers (3) ; Layer.name (1), features (2), keys (3), values (4), version (15), extent (5).
function varint(b: Buffer, i: number): [number, number] { let r = 0, s = 0, c; do { c = b[i++]; r += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return [r, i]; }
function champs(b: Buffer) {
  const out: { n: number; v: Buffer | number }[] = []; let i = 0;
  while (i < b.length) {
    let k; [k, i] = varint(b, i); const n = Math.floor(k / 8), t = k & 7;
    if (t === 2) { let l; [l, i] = varint(b, i); out.push({ n, v: b.subarray(i, i + l) }); i += l; }
    else if (t === 0) { let v; [v, i] = varint(b, i); out.push({ n, v }); }
    else if (t === 5) i += 4; else if (t === 1) i += 8; else throw new Error(`type de fil ${t}`);
  }
  return out;
}
function couches(mvt: Buffer) {
  return champs(mvt).filter((f) => f.n === 3).map((f) => {
    const c = champs(f.v as Buffer);
    const chaine = (b: Buffer) => { const s = champs(b).find((x) => x.n === 1); return s ? (s.v as Buffer).toString() : null; };
    return {
      nom: (c.find((x) => x.n === 1)!.v as Buffer).toString(),
      objets: c.filter((x) => x.n === 2).length,
      cles: c.filter((x) => x.n === 3).map((x) => (x.v as Buffer).toString()),
      valeurs: c.filter((x) => x.n === 4).map((x) => chaine(x.v as Buffer)),
      version: c.find((x) => x.n === 15)?.v, etendue: c.find((x) => x.n === 5)?.v,
    };
  });
}

// Tuile z12 1892/1938 : lon -13,711 a -13,623, lat 9,535 a 9,622 (Conakry). Fixtures au centre.
const Z12 = { z: 12, x: 1892, y: 1938 };
const Z11 = { z: 11, x: 946, y: 969 };

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region integ tuiles')`);
      const seg = (i: number, dy: number, source: string | null) => `('tu-${i}', 'TU-${i}', 'Troncon tuile ${i}', 'RN', (SELECT id FROM regions WHERE nom='Region integ tuiles'), 0.5, 'BITUME', 0, 0.5,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.675, ${9.57 + dy}), ST_MakePoint(-13.665, ${9.57 + dy})), 4326), ${source === null ? "NULL" : `'${source}'`}, now())`;
      await tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "sourceReference", "updatedAt") VALUES
        ${[seg(1, 0, null), seg(2, 0.005, null), seg(3, 0.01, "voirie_locale:integ-3"), seg(4, 0.015, "voirie_locale:integ-4"), seg(5, 0.02, "voirie_locale:integ-5"), seg(6, 0.025, "hors_territoire:integ-6")].join(",")}`);
      await tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt", "deletedAt")
        VALUES ('tu-7', 'TU-7', 'Troncon retire', 'RN', (SELECT id FROM regions WHERE nom='Region integ tuiles'), 0.5, 'BITUME', 0, 0.5,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.675, 9.6), ST_MakePoint(-13.665, 9.6)), 4326), now(), now())`);

      // Oracle des fixtures : combien de classes / voiries VIVANTES de la tuile, en SQL independant.
      const [o] = await tx.$queryRawUnsafe<{ classe: number; voirie: number }[]>(`
        SELECT count(*) FILTER (WHERE "sourceReference" IS NULL)::int AS classe, count(*) FILTER (WHERE "sourceReference" LIKE 'voirie_locale:%')::int AS voirie
          FROM troncons WHERE id LIKE 'tu-%' AND "deletedAt" IS NULL AND ST_Intersects(geom, ST_Transform(ST_TileEnvelope(12, 1892, 1938), 4326))`);
      verifier("oracle : 2 troncons classes et 3 de voirie locale vivants dans la tuile z12", o.classe === 2 && o.voirie === 3, o);

      const t12 = couches(await tuileReseau(tx, Z12));
      const classe = t12.find((c) => c.nom === "reseau_classe");
      const voirie = t12.find((c) => c.nom === "voirie_locale");
      // Les comptes incluent d'eventuels troncons deja presents dans `replay` sur cette tuile.
      const [base] = await tx.$queryRawUnsafe<{ classe: number; voirie: number }[]>(`
        SELECT count(*) FILTER (WHERE "sourceReference" IS NULL)::int AS classe, count(*) FILTER (WHERE "sourceReference" LIKE 'voirie_locale:%')::int AS voirie
          FROM troncons WHERE id NOT LIKE 'tu-%' AND "deletedAt" IS NULL AND ST_Intersects(geom, ST_Transform(ST_TileEnvelope(12, 1892, 1938, margin => 64.0/4096), 4326))`);
      verifier("z12 : la couche reseau_classe porte les 2 classes (hors territoire et retire exclus)", classe?.objets === o.classe + base.classe, { classe, base });
      verifier("z12 : la couche voirie_locale porte les 3 voiries", voirie?.objets === o.voirie + base.voirie, { voirie, base });
      verifier("z12 : tuiles MVT version 2, etendue 4096", t12.every((c) => c.version === 2 && c.etendue === 4096), t12);
      verifier("z12 : proprietes publiees du reseau classe (code, nom, classe, etat, revetement), rien d'autre",
        JSON.stringify([...(classe?.cles ?? [])].sort()) === JSON.stringify(["classe", "code", "etat", "nom", "revetement"]), classe?.cles);
      verifier("z12 : le code d'une fixture se lit dans la tuile", classe?.valeurs.includes("TU-1") === true, classe?.valeurs);

      const t11 = couches(await tuileReseau(tx, Z11));
      verifier("z11 : pas de couche voirie_locale (elle commence au zoom 12)", t11.length >= 1 && !t11.some((c) => c.nom === "voirie_locale"), t11.map((c) => c.nom));

      const vide = await tuileReseau(tx, { z: 12, x: 0, y: 0 });
      verifier("une tuile hors de Guinee est vide (0 octet, la route rendra 204)", vide.length === 0, vide.length);
      throw new Annulation();
    }, { timeout: 120_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  const reste = await prisma.troncon.count({ where: { id: { startsWith: "tu-" } } });
  verifier("rien ne subsiste apres l'annulation", reste === 0, reste);
  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
