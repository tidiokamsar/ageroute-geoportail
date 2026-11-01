/**
 * Chargement du reseau synthetique dans un CLONE jetable (`essai_<nom>`), par lots parametres.
 * Aucune valeur n'est concatenee dans le SQL : les colonnes partent en tableaux (unnest).
 * La garde (`../../lib/garde`) est exigee par l'appelant avant toute connexion.
 */
import { Client } from "pg";
import { wkt, type ReseauSynthetique } from "./reseau-synthetique";

const LOT = 4_000;

export const EMAIL_BANC = "perf@local.invalid";
export const ID_UTILISATEUR_BANC = "u-perf";

export interface ResumeChargement {
  regions: number;
  troncons: number;
  ouvrages: number;
  dureeChargementMs: number;
  dureeIndexAnalyseMs: number;
}

export async function chargerReseau(client: Client, reseau: ReseauSynthetique): Promise<ResumeChargement> {
  const t0 = Date.now();
  // `unaccent` n'est cree par AUCUNE migration du depot (la production l'a recu hors chaine) alors que
  // la couche chantiers de la carte publique l'appelle : sur une base rejouee depuis les migrations,
  // GET /api/public/carte/geo repond 500. Le clone de mesure le pose pour que la carte soit mesurable.
  await client.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
  // Regions (8 regions administratives du territoire, plus ce que les noeuds ont produit).
  for (const nom of reseau.regions) {
    await client.query(`INSERT INTO regions (nom) VALUES ($1) ON CONFLICT (nom) DO NOTHING`, [nom]);
  }
  const rg = await client.query<{ id: number; nom: string }>(`SELECT id, nom FROM regions`);
  const idRegion = new Map(rg.rows.map((r) => [r.nom, r.id]));

  for (let i = 0; i < reseau.troncons.length; i += LOT) {
    const lot = reseau.troncons.slice(i, i + LOT);
    await client.query(
      `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", "sourceReference", geom, "updatedAt")
       SELECT x.id, x.code, x.nom, x.classe::"ClasseRoute", x.region, x.lkm, x.rev::"Revetement", x.pkd, x.pkf, x.src,
              ST_SetSRID(ST_GeomFromText(x.g), 4326), CURRENT_TIMESTAMP
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::float8[], $7::text[], $8::float8[], $9::float8[], $10::text[], $11::text[])
              AS x(id, code, nom, classe, region, lkm, rev, pkd, pkf, src, g)`,
      [
        lot.map((t) => t.id), lot.map((t) => t.code), lot.map((t) => t.nom), lot.map((t) => t.classe),
        lot.map((t) => idRegion.get(t.regionNom)), lot.map((t) => t.longueurKm), lot.map((t) => t.revetement),
        lot.map((t) => t.pkDebut), lot.map((t) => t.pkFin), lot.map((t) => t.sourceReference), lot.map((t) => wkt(t.coordonnees)),
      ],
    );
  }
  const dureeChargementMs = Date.now() - t0;

  // 126 ouvrages inventories (chiffre du registre), poses sur des troncons classes choisis
  // regulierement : ils alimentent la carte publique et le complement « actifs proches ».
  await client.query(
    `INSERT INTO ouvrages (id, nom, type, etat, "regionId", "tronconId", pk, geom, "updatedAt")
     SELECT 'perf-ouv-' || r.rn, 'Ouvrage du banc ' || r.rn, 'PONT', 'MOYEN', t."regionId", t.id, 0,
            ST_LineInterpolatePoint(t.geom, 0.5), CURRENT_TIMESTAMP
       FROM (SELECT id, row_number() OVER (ORDER BY code) AS rn FROM troncons WHERE "sourceReference" IS NULL) r
       JOIN troncons t ON t.id = r.id
      WHERE r.rn % GREATEST(1, ((SELECT count(*) FROM troncons WHERE "sourceReference" IS NULL) / 126)::int) = 0
      LIMIT 126`,
  );

  // Compte d'essai : GESTIONNAIRE avec acces aux modules utilises, pour que le chemin HTTP
  // inclue la lecture `modulesAutorises` (un ADMIN y echappe, un agent de terrain non).
  await client.query(
    `INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "modulesAutorises", "updatedAt")
     VALUES ($1, $2, 'Compte du banc de performance', 'fixture-sans-usage', 'GESTIONNAIRE', ARRAY['geoportail','inspections','troncons','ouvrages','points-noirs','postes','chantiers'], CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO NOTHING`,
    [ID_UTILISATEUR_BANC, EMAIL_BANC],
  );

  const t1 = Date.now();
  await client.query(`VACUUM (ANALYZE) troncons`);
  await client.query(`ANALYZE ouvrages`);
  const dureeIndexAnalyseMs = Date.now() - t1;

  const c = await client.query<{ t: string; o: string }>(`SELECT (SELECT count(*) FROM troncons)::text AS t, (SELECT count(*) FROM ouvrages)::text AS o`);
  return { regions: rg.rowCount ?? 0, troncons: Number(c.rows[0].t), ouvrages: Number(c.rows[0].o), dureeChargementMs, dureeIndexAnalyseMs };
}
