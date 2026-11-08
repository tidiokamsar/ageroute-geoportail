import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { http, connecter, td } from "./api";
import { empreinte } from "./base";
import { avecBase, majRun, lireRun, type CompteRun, type NomCompte, type ProduitRun, type TronconRun } from "./donnees";
import { RACINE_DEPOT } from "./env";

/**
 * SEMIS DES DONNEES DE TEST (une fois par lancement, dans la base JETABLE `essai_eo_e2e` uniquement).
 *
 *   FIXTURES DE TEST : ce qui est cree ici n'est PAS une observation reelle.
 *   - Les COMPTES sont crees par les routes d'administration (`POST /api/users`, `PUT /api/users/:id`, `PUT /api/v2/perimetres/:id`),
 *     comme le fait l'administration, pas par SQL.
 *   - Les PRODUITS sont de VRAIES metadonnees : l'adaptateur reel du catalogue Copernicus (STAC, recherche anonyme, une requete) est
 *     appele par `POST /sources/cdse-stac/synchroniser-catalogue`.
 *   - Les TRONCONS sont des routes reelles de `frontend/public/osm-routes.geojson` (geometries realistes), recoupees a l'emprise des
 *     produits reels, avec des noms qui disent « FIXTURE DE TEST ». Regions A et B : des regions de test, pas des regions administratives.
 *   - Les PROPOSITIONS sont des FIXTURES : leur geometrie est posee sur ou pres de ces troncons par le semis, `synthetique: false`
 *     (consigne du chantier). AUCUNE detection satellitaire reelle n'a ete calculee ; la methode s'appelle `fixture-e2e-eo`.
 */

const MODULES_TITULAIRES = ["dashboard", "geoportail", "troncons", "teledetection"];
const MODULES_SANS_TELEDETECTION = ["dashboard", "geoportail", "troncons"];

/** Boke 10,93 N ; 14,29 O, plus ou moins 0,1 degre (la verification reelle du 25/10/2026 y a trouve 7 produits). */
const ZONE_BOKE: [number, number, number, number] = [-14.39, 10.83, -14.19, 11.03];


const ligne = (t: string) => console.log(`[semis eo] ${t}`);

function jour(d: Date): string { return d.toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------------------------------------------
// 1. Comptes, par l'administration
// ---------------------------------------------------------------------------------------------------------------

async function creerComptes(tokenAdmin: string): Promise<void> {
  const run = lireRun();
  const modules: Record<NomCompte, string[] | null> = {
    admin: null, gestNational: MODULES_TITULAIRES, gestRegional: MODULES_TITULAIRES, inspecteur: MODULES_TITULAIRES,
    lecteur: MODULES_TITULAIRES, sansModule: MODULES_SANS_TELEDETECTION, modulesVides: [],
  };
  const ids: Partial<Record<NomCompte, string>> = {};
  for (const nom of Object.keys(modules) as NomCompte[]) {
    if (nom === "admin") { ids[nom] = run.comptes.admin.id; continue; }
    const c: CompteRun = run.comptes[nom];
    const r = await http("POST", "/api/users", { token: tokenAdmin, corps: { email: c.email, nomComplet: c.nomComplet, password: c.motDePasse, role: c.role } });
    if (r.status !== 201) throw new Error(`Creation du compte ${nom} refusee (HTTP ${r.status}).`);
    const id = (r.corps as { id: string }).id;
    ids[nom] = id;
    const m = await http("PUT", `/api/users/${id}`, { token: tokenAdmin, corps: { modulesAutorises: modules[nom] } });
    if (m.status !== 200) throw new Error(`Attribution des modules de ${nom} refusee (HTTP ${m.status}).`);
  }
  const p = await http("PUT", `/api/v2/perimetres/${ids.gestRegional}`, { token: tokenAdmin, corps: { regionIds: [run.regions.A.id] } });
  if (p.status !== 200) throw new Error(`Perimetre du gestionnaire regional refuse (HTTP ${p.status}).`);
  majRun((d) => { for (const nom of Object.keys(ids) as NomCompte[]) d.comptes[nom].id = ids[nom]!; });
  ligne("7 comptes crees par l'administration (modules attribues, perimetre regional pose)");
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Produits : VRAIE synchronisation du catalogue
// ---------------------------------------------------------------------------------------------------------------

async function synchroniserCatalogue(tokenAdmin: string): Promise<void> {
  const fin = new Date();
  const debut = new Date(fin.getTime() - 30 * 86_400_000);
  const corps = { bbox: ZONE_BOKE, depuis: jour(debut), jusqua: jour(fin), nuagesMax: 50 };
  let r = await td(tokenAdmin, "POST", "/sources/cdse-stac/synchroniser-catalogue", corps);
  // Une seule reprise (le catalogue public peut avoir un raté) : le budget reste d'au plus 2 requetes anonymes.
  if (r.status !== 200) { ligne(`synchronisation: HTTP ${r.status}, une reprise`); r = await td(tokenAdmin, "POST", "/sources/cdse-stac/synchroniser-catalogue", corps); }
  if (r.status !== 200) throw new Error(`Synchronisation du catalogue Copernicus impossible (HTTP ${r.status}) : reseau ou service indisponible. Ce lancement exige le reseau.`);
  const rap = r.corps as { trouves: number; nouveaux: number; dejaConnus: number; requetes?: number };
  ligne(`catalogue Copernicus reel : ${rap.trouves} trouves, ${rap.nouveaux} nouveaux (${r.dureeMs} ms)`);
  if (rap.trouves === 0) throw new Error("Le catalogue Copernicus n'a rendu aucun produit pour Boke dans les 30 derniers jours (nuages <= 50 %) : aucune proposition ne peut etre deposee sur un produit reel.");
  majRun((d) => { d.synchro = { trouves: rap.trouves, nouveaux: rap.nouveaux, dejaConnus: rap.dejaConnus, requetes: rap.requetes ?? 1 }; });
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Referentiel de test : troncons (routes reelles recoupees a l'emprise des produits), portions, ouvrage
// ---------------------------------------------------------------------------------------------------------------

interface Piece { wkt: string; metres: number; numero: string }
interface RouteOsm { numero: string; nature: string; lengthKm: number; coordinates: number[][] }

function lireRoutesOsm(): RouteOsm[] {
  const f = path.join(RACINE_DEPOT, "frontend", "public", "osm-routes.geojson");
  const g = JSON.parse(fs.readFileSync(f, "utf8")) as { features: { geometry: { type: string; coordinates: number[][] }; properties: { numero: string; nature: string; lengthKm: number } }[] };
  return g.features
    .filter((x) => x.geometry.type === "LineString" && x.geometry.coordinates.length >= 20 && x.properties.numero)
    .map((x) => ({ numero: x.properties.numero, nature: x.properties.nature, lengthKm: x.properties.lengthKm, coordinates: x.geometry.coordinates }));
}

/**
 * Produits reels de la synchronisation et zone ou poser les fixtures : l'UNION de leurs emprises, rognee de ~1 km. Une tuile Sentinel-2
 * est decoupee par orbite (la zone balayee change d'une date a l'autre) : l'intersection serait presque vide. Chaque proposition prendra,
 * elle, parmi les produits dont l'emprise la CONTIENT (le declencheur d'insertion l'exige), le plus recent comme « apres » et un plus ancien
 * comme « reference » s'il en existe un.
 */
export async function choisirProduitsEtEmprise(): Promise<{ produits: ProduitRun[]; footprintWkt: string }> {
  return avecBase(async (c) => {
    const l = await c.query<{ id: string; code: string; d: Date }>(
      `SELECT id, code, "dateAcquisition" AS d FROM earth_observation_products
        WHERE "sourceCode" = 'SENTINEL2' AND NOT synthetique AND "deletedAt" IS NULL ORDER BY "dateAcquisition" DESC, id`);
    if (l.rows.length === 0) throw new Error("Aucun produit Sentinel-2 en base apres la synchronisation.");
    const inset = (await c.query<{ w: string | null }>(
      `SELECT ST_AsText(ST_Buffer(ST_Union(emprise), -0.01)) AS w FROM earth_observation_products WHERE "sourceCode" = 'SENTINEL2' AND NOT synthetique AND "deletedAt" IS NULL`)).rows[0].w;
    if (!inset || /EMPTY/.test(inset)) throw new Error("Les emprises des produits reels n'ont pas d'union exploitable.");
    return { produits: l.rows.map((p) => ({ id: p.id, code: p.code, dateAcquisition: p.d.toISOString() })), footprintWkt: inset };
  });
}

export async function semerReferentiel(produits: ProduitRun[], footprintWkt: string): Promise<(TronconRun & { wkt: string })[]> {
  const run = lireRun();
  const routes = lireRoutesOsm().sort((a, b) => b.lengthKm - a.lengthKm || a.numero.localeCompare(b.numero));
  return avecBase(async (c) => {
    // Toutes les portions de routes reelles qui tombent DANS l'emprise (au moins 1,5 km), les plus longues d'abord.
    const pieces: Piece[] = [];
    for (const r of routes) {
      const piece = (await c.query<Piece>(
        `WITH f AS (SELECT ST_GeomFromText($1, 4326) AS g),
              l AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($2), 4326) AS g),
              p AS (SELECT (ST_Dump(ST_Intersection(l.g, f.g))).geom AS g FROM l, f)
         SELECT ST_AsText(g) AS wkt, ST_Length(g::geography) AS metres, $3::text AS numero FROM p WHERE GeometryType(g) = 'LINESTRING' ORDER BY ST_Length(g::geography) DESC LIMIT 1`,
        [footprintWkt, JSON.stringify({ type: "LineString", coordinates: r.coordinates }), r.numero])).rows[0];
      if (piece && piece.metres >= 1500) pieces.push(piece);
    }
    pieces.sort((a, b) => b.metres - a.metres);
    // Des troncons assez eloignes les uns des autres (1,5 km) : une proposition ne doit pas hesiter entre deux troncons.
    const retenus: Piece[] = [];
    for (const piece of pieces) {
      if (retenus.length >= 4) break;
      let proche = false;
      for (const k of retenus) {
        const dist = (await c.query<{ d: number }>(`SELECT ST_Distance(ST_GeomFromText($1, 4326)::geography, ST_GeomFromText($2, 4326)::geography) AS d`, [k.wkt, piece.wkt])).rows[0].d;
        if (dist < 1500) { proche = true; break; }
      }
      if (!proche) retenus.push(piece);
    }
    ligne(`routes reelles dans l'emprise : ${pieces.length} portion(s) de 1,5 km ou plus, ${retenus.length} retenue(s)`);
    if (retenus.length < 4) throw new Error(`Seulement ${retenus.length} route(s) reelle(s) exploitable(s) dans l'emprise des produits (4 attendues).`);

    const troncons: (TronconRun & { wkt: string })[] = [];
    for (let i = 0; i < 4; i++) {
      const r = retenus[i];
      const region = i < 2 ? run.regions.A : run.regions.B;
      const id = randomUUID();
      const code = `FIX-T${i + 1}`;
      const nom = `FIXTURE TEST route ${r.numero} (OSM) ${i + 1}`;
      const km = Math.round((r.metres / 1000) * 10) / 10;
      await c.query(
        `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", geom, "updatedAt")
         VALUES ($1, $2, $3, 'RN'::"ClasseRoute", $4, $5, 'BITUME'::"Revetement", 'MOYEN'::"EtatPatrimoine", 0, $5, ST_SetSRID(ST_GeomFromText($6), 4326), now())`,
        [id, code, nom, region.id, km, r.wkt]);
      troncons.push({ id, code, nom, regionId: region.id, longueurKm: km, wkt: r.wkt });
    }
    // Deux portions et un ouvrage : pour que l'empreinte du referentiel porte sur trois tables NON vides.
    for (const [i, t] of troncons.slice(0, 2).entries()) {
      await c.query(
        `INSERT INTO portions (id, "tronconId", "debutM", "finM", origine, "creeParId", "updatedAt")
         VALUES ($1, $2, 0, $3, 'SAISIE_TERRAIN'::"OriginePortion", $4, now())`, [randomUUID(), t.id, 1000 * (i + 1), run.comptes.admin.id]);
    }
    await c.query(
      `INSERT INTO ouvrages (id, nom, type, etat, "regionId", "tronconId", geom, "updatedAt")
       VALUES ($1, 'FIXTURE TEST pont', 'PONT'::"TypeOuvrage", 'MOYEN'::"EtatPatrimoine", $2, $3, ST_LineInterpolatePoint(ST_GeomFromText($4, 4326), 0.5), now())`,
      [randomUUID(), troncons[0].regionId, troncons[0].id, troncons[0].wkt]);
    void produits;
    return troncons;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Propositions : FIXTURES DE TEST deposees par POST /propositions sur les produits reels
// ---------------------------------------------------------------------------------------------------------------

const TYPES = ["NOUVELLE_ROUTE", "COUPURE_PROBABLE", "VEGETATION", "INONDATION"] as const;
const NIVEAUX: (("HAUTE" | "MOYENNE" | "FAIBLE") | null)[] = ["HAUTE", "MOYENNE", "MOYENNE", "FAIBLE", "FAIBLE", null];

interface Prevue { zone: "A" | "B" | "N"; troncon: number; f: number; type: (typeof TYPES)[number]; niveau: (typeof NIVEAUX)[number]; confiance: number; nuages: number; groupe: 0 | 1 }

function plan(): Prevue[] {
  const liste: Prevue[] = [];
  const repartition: { zone: Prevue["zone"]; troncon: number; n: number }[] = [
    { zone: "A", troncon: 0, n: 12 }, { zone: "A", troncon: 1, n: 10 }, { zone: "B", troncon: 2, n: 8 }, { zone: "B", troncon: 3, n: 6 }, { zone: "N", troncon: -1, n: 6 },
  ];
  let i = 0;
  for (const z of repartition) {
    for (let k = 0; k < z.n; k++, i++) {
      liste.push({
        zone: z.zone, troncon: z.troncon, f: 0.06 + (0.86 * k) / z.n, type: TYPES[i % 4], niveau: NIVEAUX[i % 6],
        confiance: Math.round((0.35 + ((i * 37) % 60) / 100) * 100) / 100, nuages: (i * 11) % 55, groupe: i % 3 === 2 ? 1 : 0,
      });
    }
  }
  return liste;
}

async function deposerPropositions(tokenAdmin: string, footprintWkt: string, troncons: (TronconRun & { wkt: string })[]): Promise<void> {
  const prevues = plan();

  // Points hors de tout troncon (a plus de 2,5 km) pour les propositions non rattachees.
  const libres = await avecBase(async (c) => (await c.query<{ lon: number; lat: number }>(
    `WITH f AS (SELECT ST_GeomFromText($1, 4326) AS g),
          pts AS (SELECT (ST_Dump(ST_GeneratePoints(f.g, 400, 42))).geom AS p FROM f)
     SELECT ST_X(p) AS lon, ST_Y(p) AS lat FROM pts
      WHERE NOT EXISTS (SELECT 1 FROM troncons t WHERE ST_DWithin(t.geom::geography, pts.p::geography, 2500)) LIMIT 6`, [footprintWkt])).rows);
  if (libres.length < 6) throw new Error(`Seulement ${libres.length} point(s) libre(s) de tout troncon dans l'emprise (6 attendus).`);

  // Un lot par couple (produit « apres », produit « reference »).
  const lots = new Map<string, { produitId: string; referenceId: string | null; items: unknown[] }>();
  let libre = 0;
  let ecartees = 0;
  for (const [i, p] of prevues.entries()) {
    let geometrie: unknown;
    if (p.zone === "N") {
      const pt = libres[libre++];
      geometrie = { type: "Point", coordinates: [pt.lon, pt.lat] };
    } else {
      const t = troncons[p.troncon];
      const sql = p.type === "COUPURE_PROBABLE"
        ? `SELECT ST_AsGeoJSON(ST_LineSubstring(ST_GeomFromText($1, 4326), $2::float8, LEAST($2::float8 + 0.01, 1)), 6) AS g`
        : p.type === "NOUVELLE_ROUTE"
          ? `SELECT ST_AsGeoJSON(ST_Translate(ST_LineSubstring(ST_GeomFromText($1, 4326), $2::float8, LEAST($2::float8 + 0.02, 1)), 0.0008, 0.0005), 6) AS g`
          : `SELECT ST_AsGeoJSON(ST_Buffer(ST_Translate(ST_LineInterpolatePoint(ST_GeomFromText($1, 4326), $2::float8), 0.0002, 0.0001), 0.0004, 4), 6) AS g`;
      const g = await avecBase(async (c) => (await c.query<{ g: string }>(sql, [t.wkt, p.f])).rows[0].g);
      geometrie = JSON.parse(g);
    }
    // Produits dont l'emprise contient la detection, du plus recent au plus ancien (le declencheur d'insertion l'exige).
    const cand = await avecBase(async (c) => (await c.query<{ id: string; d: Date }>(
      `SELECT id, "dateAcquisition" AS d FROM earth_observation_products
        WHERE "sourceCode" = 'SENTINEL2' AND NOT synthetique AND ST_Covers(emprise, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) ORDER BY "dateAcquisition" DESC, id`,
      [JSON.stringify(geometrie)])).rows);
    if (cand.length === 0) { ecartees++; continue; }
    const apres = cand[Math.min(p.groupe, cand.length - 1)];
    const plusAnciens = cand.filter((x) => x.d < apres.d);
    const reference = plusAnciens.length > 0 ? plusAnciens[plusAnciens.length - 1] : null;
    const cle = `${apres.id}|${reference?.id ?? ""}`;
    const lot = lots.get(cle) ?? { produitId: apres.id, referenceId: reference?.id ?? null, items: [] };
    lots.set(cle, lot);
    lot.items.push({
      type: p.type, geometrie, score: p.confiance, confianceDetection: p.confiance,
      priorite: p.niveau ? { niveau: p.niveau, regle: "FIXTURE DE TEST : niveau pose par le semis, aucune regle de priorite reelle" } : null,
      imageCouvertureNuagesPct: p.nuages,
      imageNote: "FIXTURE DE TEST : proposition posee par le semis, aucune detection satellitaire reelle",
      limites: [
        "Resolution native 10 m : les nids-de-poule et les fissures fines ne sont pas detectables.",
        `FIXTURE DE TEST (proposition ${i + 1}) : aucune detection satellitaire reelle n'a ete calculee.`,
      ],
    });
  }
  if (ecartees > 0) ligne(`${ecartees} proposition(s) ecartee(s) : aucun produit reel ne couvre leur geometrie`);
  for (const lot of lots.values()) {
    const r = await td(tokenAdmin, "POST", "/propositions", {
      produitId: lot.produitId, produitReferenceId: lot.referenceId,
      methodeNom: "fixture-e2e-eo", methodeVersion: "v0", toleranceRattachementM: 250, synthetique: false, propositions: lot.items,
    });
    if (r.status !== 201) throw new Error(`Depot d'un lot refuse (HTTP ${r.status}) : ${JSON.stringify(r.corps).slice(0, 300)}`);
  }
  ligne(`${lots.size} lot(s) deposes par POST /propositions`);
  const bilan = await avecBase(async (c) => (await c.query<{ total: string; a: string; b: string; n: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE "regionId" = $1) AS a, count(*) FILTER (WHERE "regionId" = $2) AS b, count(*) FILTER (WHERE "tronconId" IS NULL) AS n
       FROM propositions_teledetection`, [lireRun().regions.A.id, lireRun().regions.B.id])).rows[0]);
  const depot = { total: Number(bilan.total), regionA: Number(bilan.a), regionB: Number(bilan.b), nonRattachees: Number(bilan.n) };
  ligne(`propositions deposees (FIXTURES) : ${depot.total}, region A ${depot.regionA}, region B ${depot.regionB}, non rattachees ${depot.nonRattachees}`);
  if (depot.regionA === 0 || depot.regionB === 0 || depot.nonRattachees === 0) throw new Error(`Repartition inexploitable du semis : ${JSON.stringify(depot)}`);
  majRun((d) => { d.depot = depot; });
}

// ---------------------------------------------------------------------------------------------------------------

/** Tout le semis, apres le demarrage de l'API reelle. */
export async function semerTout(): Promise<void> {
  const run = lireRun();
  const tokenAdmin = await connecter(run.comptes.admin);
  await creerComptes(tokenAdmin);
  await synchroniserCatalogue(tokenAdmin);
  const { produits, footprintWkt } = await choisirProduitsEtEmprise();
  const troncons = await semerReferentiel(produits, footprintWkt);
  await deposerPropositions(tokenAdmin, footprintWkt, troncons);
  const avant = await empreinte();
  majRun((d) => {
    d.produits = produits;
    d.troncons = troncons.map(({ wkt: _wkt, ...t }) => t);
    d.empreinteAvant = avant;
  });
  ligne(`referentiel de test : ${troncons.length} troncons, empreintes ${Object.keys(avant).join("/")} prises`);
}
