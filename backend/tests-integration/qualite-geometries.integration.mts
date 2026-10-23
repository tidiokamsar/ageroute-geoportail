// Banc d'integration PostGIS : validite des geometries sur SIX tables (§ 7.1). Voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/qualite-geometries.integration.mts
//
// CE QUI EST EPROUVE, CONTRE POSTGIS REEL, AVEC DES GEOMETRIES REELLEMENT INVALIDES
//   - troncons, chantiers, portions, limites administratives (polygones), emprises de teledetection,
//     actifs lineaires (ouvrages.geomLigne) : compte EXACT au-dela du plafond d'exemples, exemples plafonnes,
//     perimetre par region (dont la descente par `parentPcode` des limites), supprimees et remplacees ignorees ;
//   - un ORACLE INDEPENDANT, ecrit en TypeScript sans PostGIS : il juge chaque geometrie fabriquee a partir de
//     ses coordonnees (croisement de segments, point dans polygone). Les nombres attendus viennent du MODELE
//     des fixtures que le banc a lui-meme insere, jamais de la reponse du detecteur ; l'accord de l'oracle et
//     de ST_IsValid est lui-meme verifie, geometrie par geometrie ;
//   - une CONTRE-EPREUVE : le detecteur d'avant l'extension (troncons seuls) ne voit aucune des invalides des
//     autres tables ;
//   - la boucle non fermee est REFUSEE par PostGIS a la construction : elle ne peut pas entrer dans une table.
//
// CE QU'IL NE PROUVE PAS : la base de production (volumes, duree des balayages sur 261 387 troncons), ni les
// tables non couvertes (points, roulage, voirie locale, emprises de defauts et de missions). Travaille dans le
// clone jetable `essai_qualgeom` de `replay` (la migration unaccent y est appliquee : le controle des
// limites en depend) ; la contrainte `eo_emprise_valide` y est supprimee pour pouvoir fabriquer une emprise
// invalide. `replay` n'est jamais ecrite.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_qualgeom", { migrations: ["20261026400000_extension_unaccent"] });
const { prisma: clientApp } = await banc.imp("lib/prisma");
const { geometriesInvalides, invalidesTroncons, invalidesLimitesAdmin, PLAFOND_EXEMPLES } = await banc.imp("qualite/anomalies.depot");
const prisma = clientApp;
const db = prisma; // meme client : le detecteur et le banc voient la meme base

// ---------------------------------------------------------------------------------------------
// Oracle independant (aucun appel a PostGIS)
// ---------------------------------------------------------------------------------------------
type Pt = [number, number];
type Geo = { type: "ligne"; pts: Pt[] } | { type: "poly"; coque: Pt[]; trous?: Pt[][] };

const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const surSegment = (a: Pt, b: Pt, p: Pt) =>
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
/** Deux segments se rencontrent-ils (croisement ou contact) ? */
function segmentsSeRencontrent(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && surSegment(a, b, c)) || (o2 === 0 && surSegment(a, b, d)) || (o3 === 0 && surSegment(c, d, a)) || (o4 === 0 && surSegment(c, d, b));
}
/** Un anneau ferme est simple si aucune paire d'aretes NON adjacentes ne se rencontre. */
function anneauSimple(anneau: Pt[]): boolean {
  const n = anneau.length - 1; // dernier point = premier
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacents = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacents) continue;
      if (segmentsSeRencontrent(anneau[i], anneau[i + 1], anneau[j], anneau[j + 1])) return false;
    }
  }
  return true;
}
/** Point strictement a l'interieur d'un anneau (lancer de rayon). */
function dansAnneau(p: Pt, anneau: Pt[]): boolean {
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const [xi, yi] = anneau[i], [xj, yj] = anneau[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}
function estValideOracle(g: Geo): boolean {
  if (g.type === "ligne") return new Set(g.pts.map((p) => p.join(","))).size >= 2;
  if (g.coque.length < 4 || !anneauSimple(g.coque)) return false;
  for (const trou of g.trous ?? []) {
    if (!anneauSimple(trou)) return false;
    if (!trou.every((p) => dansAnneau(p, g.coque))) return false; // un sommet du trou hors de la coque
  }
  return true;
}
const coords = (pts: Pt[]) => pts.map((p) => `${p[0]} ${p[1]}`).join(", ");
function wkt(g: Geo): string {
  if (g.type === "ligne") return `LINESTRING(${coords(g.pts)})`;
  return `POLYGON((${coords(g.coque)})${(g.trous ?? []).map((t) => `,(${coords(t)})`).join("")})`;
}
const bbox = (g: Geo) => {
  const pts = g.type === "ligne" ? g.pts : g.coque;
  return { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) };
};
const boitesSeRecouvrent = (a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

// ---------------------------------------------------------------------------------------------
// Geometries fabriquees
// ---------------------------------------------------------------------------------------------
const carre = (x: number, y: number, c: number): Pt[] => [[x, y], [x + c, y], [x + c, y + c], [x, y + c], [x, y]];
const BOX_A = carre(-14, 10, 1); // region A : lon -14..-13, lat 10..11
const BOX_B = carre(-10, 10, 1); // region B : lon -10..-9,  lat 10..11
const POLY_VALIDE_A: Geo = { type: "poly", coque: carre(-13.8, 10.2, 0.5) };
/** Noeud papillon : deux aretes se croisent. */
const PAPILLON_A: Geo = { type: "poly", coque: [[-13.9, 10.1], [-13.1, 10.9], [-13.1, 10.1], [-13.9, 10.9], [-13.9, 10.1]] };
const PAPILLON_B: Geo = { type: "poly", coque: [[-9.9, 10.1], [-9.1, 10.9], [-9.1, 10.1], [-9.9, 10.9], [-9.9, 10.1]] };
/** Un trou situe hors de la coque. */
const TROU_HORS_COQUE_A: Geo = { type: "poly", coque: carre(-13.9, 10.1, 0.3), trous: [carre(-13.5, 10.6, 0.1)] };
const POLY_AVEC_TROU_VALIDE: Geo = { type: "poly", coque: carre(-13.9, 10.1, 0.6), trous: [carre(-13.7, 10.3, 0.2)] };
const LIGNE_VALIDE: Geo = { type: "ligne", pts: [[-13.5, 10.5], [-13.4, 10.6]] };
/** Deux points identiques : la LineString est invalide pour PostGIS (« Too few points »). */
const LIGNE_DEGENEREE: Geo = { type: "ligne", pts: [[-13.5, 10.5], [-13.5, 10.5]] };

interface Fixture {
  table: "troncons" | "chantiers" | "portions" | "limites_admin" | "earth_observation_products" | "ouvrages";
  id: string;
  /** Region d'appartenance attendue (A, B) ; null = aucune (comptee seulement en portee nationale). */
  region: "A" | "B" | null;
  geo: Geo;
  supprimee?: boolean;
  remplacee?: boolean;
}
const modele: Fixture[] = [];
const ajouter = (f: Fixture) => { modele.push(f); };

async function main() {
  const resultats: Record<string, boolean> = {};
  const ok = (nom: string, vrai: boolean) => { resultats[nom] = vrai; };
  let appels: string[] = [];

  {
    {
      // On garde le texte de chaque requete du detecteur pour verifier qu'elles sont toutes bornees.
      const origine = (clientApp as any).$queryRaw.bind(clientApp);
      (clientApp as any).$queryRaw = (strings: any, ...valeurs: unknown[]) => {
        appels.push(Array.isArray(strings) ? strings.join("?") : String(strings));
        return origine(strings, ...valeurs);
      };

      // ----------------------------------------------------------- 0. Etat de depart
      const base = await geometriesInvalides({ regionId: null });
      const baseParType = Object.fromEntries((base.parTypeEntite ?? []).map((t) => [t.entityType, t.nombre]));
      console.log("depart (replay) :", base.nombre, JSON.stringify(baseParType));

      // ----------------------------------------------------------- 1. Refus de la boucle non fermee
      let refus = "";
      try { await db.$queryRawUnsafe(`SELECT ST_GeomFromText('POLYGON((-14 10, -13 10, -13 11, -14 11))', 4326)`); }
      catch (e) { refus = e instanceof Error ? e.message : String(e); }
      console.log("boucle non fermee, message PostGIS :", refus.split("\n").filter(Boolean).pop());
      ok("une boucle non fermee est REFUSEE par PostGIS a la construction (elle ne peut entrer dans aucune table)", /non-closed rings|not closed/i.test(refus));

      // ----------------------------------------------------------- 2. Fixtures
      await db.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Boké Qualité A'), ('Kankan Qualité B')`);
      const rA = Number((await db.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom='Boké Qualité A'`))[0].id);
      const rB = Number((await db.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom='Kankan Qualité B'`))[0].id);
      const rId = { A: rA, B: rB };
      const user = await db.user.create({ data: { email: "qualite-geom@banc.invalid", nomComplet: "Banc", passwordHash: "x", role: "ADMIN" } });
      const N = PLAFOND_EXEMPLES + 5; // chantiers invalides en A : au-dela du plafond

      // troncons : 2 invalides en A, 1 en B, 1 valide, 1 invalide supprime (il ne compte pas)
      ajouter({ table: "troncons", id: "q-t-inv-a1", region: "A", geo: LIGNE_DEGENEREE });
      ajouter({ table: "troncons", id: "q-t-inv-a2", region: "A", geo: LIGNE_DEGENEREE });
      ajouter({ table: "troncons", id: "q-t-inv-b1", region: "B", geo: LIGNE_DEGENEREE });
      ajouter({ table: "troncons", id: "q-t-val-a", region: "A", geo: LIGNE_VALIDE });
      ajouter({ table: "troncons", id: "q-t-sup-a", region: "A", geo: LIGNE_DEGENEREE, supprimee: true });
      // chantiers : N invalides en A (depasse le plafond), 1 en B, 1 valide, 1 supprime
      for (let i = 1; i <= N; i++) ajouter({ table: "chantiers", id: `q-c-inv-a${i}`, region: "A", geo: LIGNE_DEGENEREE });
      ajouter({ table: "chantiers", id: "q-c-inv-b1", region: "B", geo: LIGNE_DEGENEREE });
      ajouter({ table: "chantiers", id: "q-c-val-a", region: "A", geo: LIGNE_VALIDE });
      ajouter({ table: "chantiers", id: "q-c-sup-a", region: "A", geo: LIGNE_DEGENEREE, supprimee: true });
      // portions (region = celle du troncon porteur) : 1 invalide courante A, 1 invalide B, 1 valide,
      // 1 invalide REMPLACEE (historique), 1 invalide supprimee
      ajouter({ table: "portions", id: "q-p-inv-a", region: "A", geo: LIGNE_DEGENEREE });
      ajouter({ table: "portions", id: "q-p-inv-b", region: "B", geo: LIGNE_DEGENEREE });
      ajouter({ table: "portions", id: "q-p-val-a", region: "A", geo: LIGNE_VALIDE });
      ajouter({ table: "portions", id: "q-p-rempl-a", region: "A", geo: LIGNE_DEGENEREE, remplacee: true });
      ajouter({ table: "portions", id: "q-p-sup-a", region: "A", geo: LIGNE_DEGENEREE, supprimee: true });
      // ouvrages (actifs lineaires) : 1 invalide A, 1 invalide B, 1 valide, 1 supprime
      ajouter({ table: "ouvrages", id: "q-o-inv-a", region: "A", geo: LIGNE_DEGENEREE });
      ajouter({ table: "ouvrages", id: "q-o-inv-b", region: "B", geo: LIGNE_DEGENEREE });
      ajouter({ table: "ouvrages", id: "q-o-val-a", region: "A", geo: LIGNE_VALIDE });
      ajouter({ table: "ouvrages", id: "q-o-sup-a", region: "A", geo: LIGNE_DEGENEREE, supprimee: true });
      // limites administratives. Hierarchie : L1A (valide) > L2A (noeud papillon) > L3A (trou hors coque) ;
      // L1B (valide) > L2B (noeud papillon) ; une limite de niveau 1 ORPHELINE invalide ; une valide avec trou.
      ajouter({ table: "limites_admin", id: "Q-L1A", region: "A", geo: { type: "poly", coque: BOX_A } });
      ajouter({ table: "limites_admin", id: "Q-L2A", region: "A", geo: PAPILLON_A });
      ajouter({ table: "limites_admin", id: "Q-L3A", region: "A", geo: TROU_HORS_COQUE_A });
      ajouter({ table: "limites_admin", id: "Q-L2A-OK", region: "A", geo: POLY_AVEC_TROU_VALIDE });
      ajouter({ table: "limites_admin", id: "Q-L1B", region: "B", geo: { type: "poly", coque: BOX_B } });
      ajouter({ table: "limites_admin", id: "Q-L2B", region: "B", geo: PAPILLON_B });
      ajouter({ table: "limites_admin", id: "Q-ORPHELINE", region: null, geo: PAPILLON_A });
      // emprises de teledetection : la region est celle dont la BOITE recouvre l'emprise (calculee par l'oracle)
      ajouter({ table: "earth_observation_products", id: "q-eo-inv-a", region: null, geo: PAPILLON_A });
      ajouter({ table: "earth_observation_products", id: "q-eo-inv-b", region: null, geo: PAPILLON_B });
      ajouter({ table: "earth_observation_products", id: "q-eo-val-a", region: null, geo: POLY_VALIDE_A });
      ajouter({ table: "earth_observation_products", id: "q-eo-sup-a", region: null, geo: PAPILLON_A, supprimee: true });
      // La region d'une emprise vient de la boite englobante : on la pose depuis l'oracle, pas a la main.
      for (const f of modele.filter((x) => x.table === "earth_observation_products")) {
        const b = bbox(f.geo);
        f.region = boitesSeRecouvrent(b, bbox({ type: "poly", coque: BOX_A })) ? "A" : boitesSeRecouvrent(b, bbox({ type: "poly", coque: BOX_B })) ? "B" : null;
      }

      // L'oracle et PostGIS s'accordent-ils, geometrie par geometrie ? (condition de validite du banc)
      const distincts = new Map<string, Geo>();
      for (const f of modele) distincts.set(wkt(f.geo), f.geo);
      distincts.set(wkt({ type: "poly", coque: BOX_A }), { type: "poly", coque: BOX_A });
      const desaccords: string[] = [];
      for (const [t, g] of distincts) {
        const v = (await db.$queryRawUnsafe<{ v: boolean }[]>(`SELECT ST_IsValid(ST_GeomFromText('${t}', 4326)) AS v`))[0].v;
        if (v !== estValideOracle(g)) desaccords.push(t);
      }
      ok(`l'oracle TypeScript et ST_IsValid s'accordent sur les ${distincts.size} geometries distinctes fabriquees`, desaccords.length === 0);
      if (desaccords.length) console.log("desaccords :", desaccords);
      ok("les fixtures contiennent bien des polygones invalides (papillon, trou hors coque) ET des valides", modele.some((f) => f.geo.type === "poly" && !estValideOracle(f.geo)) && modele.some((f) => f.geo.type === "poly" && estValideOracle(f.geo)));

      // Insertions
      const suppr = (f: Fixture) => (f.supprimee ? `now()` : `NULL`);
      // un troncon porteur par region pour les portions
      for (const reg of ["A", "B"] as const) {
        await db.$executeRawUnsafe(
          `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
           VALUES ('q-porteur-${reg}', 'Q-PORTEUR-${reg}', 'Porteur ${reg}', 'RN', ${rId[reg]}, 10, 'BITUME', 0, 10, ST_GeomFromText('LINESTRING(-13.9 10.5, -13.1 10.5)', 4326), now())`);
      }
      for (const f of modele) {
        const reg = f.region ? rId[f.region] : rA;
        const g = `ST_GeomFromText('${wkt(f.geo)}', 4326)`;
        if (f.table === "troncons") {
          await db.$executeRawUnsafe(
            `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt", "deletedAt")
             VALUES ('${f.id}', '${f.id.toUpperCase()}', 'Q', 'RN', ${reg}, 1, 'BITUME', 0, 1, ${g}, now(), ${suppr(f)})`);
        } else if (f.table === "chantiers") {
          await db.$executeRawUnsafe(
            `INSERT INTO chantiers (id, intitule, entreprise, "regionId", geom, "updatedAt", "deletedAt")
             VALUES ('${f.id}', 'Chantier ${f.id}', 'Entreprise banc', ${reg}, ${g}, now(), ${suppr(f)})`);
        } else if (f.table === "ouvrages") {
          await db.$executeRawUnsafe(
            `INSERT INTO ouvrages (id, nom, type, "regionId", "geomLigne", "updatedAt", "deletedAt")
             VALUES ('${f.id}', 'Ouvrage ${f.id}', 'PONT', ${reg}, ${g}, now(), ${suppr(f)})`);
        } else if (f.table === "portions") {
          await db.$executeRawUnsafe(
            `INSERT INTO portions (id, "tronconId", "debutM", "finM", origine, "creeParId", geom, "updatedAt", "deletedAt", "remplaceeLe")
             VALUES ('${f.id}', 'q-porteur-${f.region}', 0, 10, 'IMPORT', '${user.id}', ${g}, now(), ${suppr(f)}, ${f.remplacee ? "now()" : "NULL"})`);
        }
      }
      // Limites : niveaux et parentes. Q-L1A porte parentPcode = Q-L3A pour fermer un CYCLE (L1A > L2A > L3A > L1A) :
      // la descente doit s'arreter (niveau strictement croissant) au lieu de boucler.
      const limites: [string, number, string, string | null][] = [
        ["Q-L1A", 1, "Boke Qualite A", "Q-L3A"], ["Q-L2A", 2, "Sous-prefecture A2", "Q-L1A"], ["Q-L3A", 3, "Secteur A3", "Q-L2A"],
        ["Q-L2A-OK", 2, "Sous-prefecture A2 valide", "Q-L1A"],
        ["Q-L1B", 1, "Kankan Qualite B", null], ["Q-L2B", 2, "Sous-prefecture B2", "Q-L1B"],
        ["Q-ORPHELINE", 1, "Zone sans region", null],
      ];
      for (const [pcode, niveau, nom, parent] of limites) {
        const f = modele.find((x) => x.table === "limites_admin" && x.id === pcode)!;
        await db.$executeRawUnsafe(
          `INSERT INTO limites_admin (pcode, niveau, nom, "parentPcode", source, geom)
           VALUES ('${pcode}', ${niveau}, '${nom}', ${parent ? `'${parent}'` : "NULL"}, 'banc', ST_Multi(ST_GeomFromText('${wkt(f.geo)}', 4326)))`);
      }
      // Produits de teledetection : la contrainte eo_emprise_valide REFUSE l'emprise invalide (c'est son role) ;
      // on le constate, puis on la retire (dans la transaction annulee) pour fabriquer le cas que le detecteur garde.
      let refusEmprise = "";
      try {
        await db.$executeRawUnsafe(
          `INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
           VALUES ('q-eo-refuse', 'Q-EO-REFUSE', 0, 's', 'RADAR', now(), 10, 'i', 'p', 'l', 'v', ST_GeomFromText('${wkt(PAPILLON_A)}', 4326), '${user.id}')`);
      } catch (e) { refusEmprise = e instanceof Error ? e.message : String(e); }
      ok("la contrainte eo_emprise_valide refuse une emprise invalide a l'ecriture (le detecteur est la ceinture, pas la seule garde)", /eo_emprise_valide/.test(refusEmprise));
      await db.$executeRawUnsafe(`ALTER TABLE earth_observation_products DROP CONSTRAINT eo_emprise_valide`);
      for (const f of modele.filter((x) => x.table === "earth_observation_products")) {
        await db.$executeRawUnsafe(
          `INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId", "deletedAt")
           VALUES ('${f.id}', '${f.id.toUpperCase()}', 0, 's', 'RADAR', now(), 10, 'i', 'p', 'l', 'v', ST_GeomFromText('${wkt(f.geo)}', 4326), '${user.id}', ${suppr(f)})`);
      }

      // ----------------------------------------------------------- 3. Attendus du MODELE (oracle)
      const attendu = (table: Fixture["table"], region: "A" | "B" | "national") =>
        modele.filter((f) => f.table === table && !f.supprimee && !f.remplacee && !estValideOracle(f.geo) && (region === "national" || f.region === region)).length;
      const TYPES: [Fixture["table"], string][] = [
        ["troncons", "Troncon"], ["chantiers", "Chantier"], ["portions", "Portion"],
        ["limites_admin", "LimiteAdmin"], ["earth_observation_products", "EarthObservationProduct"], ["ouvrages", "Ouvrage"],
      ];

      for (const portee of ["A", "B", "national"] as const) {
        appels = [];
        const r = await geometriesInvalides({ regionId: portee === "national" ? null : rId[portee] });
        const parType = Object.fromEntries((r.parTypeEntite ?? []).map((t) => [t.entityType, t.nombre]));
        const delta = (type: string) => parType[type] - (portee === "national" ? baseParType[type] ?? 0 : 0);
        for (const [table, type] of TYPES) {
          ok(`portee ${portee} : ${table} -> ${attendu(table, portee)} invalide(s) attendue(s) par l'oracle`, delta(type) === attendu(table, portee));
        }
        const total = TYPES.reduce((s, [t]) => s + attendu(t, portee), 0);
        ok(`portee ${portee} : le compte total (${total}) est la somme exacte, ventilee`, r.nombre - (portee === "national" ? base.nombre : 0) === total && (r.parTypeEntite ?? []).reduce((s, t) => s + t.nombre, 0) === r.nombre);
        ok(`portee ${portee} : six requetes, toutes bornees (LIMIT), toutes a compte exact (count(*) OVER ())`,
          appels.length === 6 && appels.every((s) => /LIMIT/.test(s) && /count\(\*\) OVER \(\)/.test(s) && /NOT ST_IsValid/.test(s)));
        ok(`portee ${portee} : les exemples restent plafonnes a ${PLAFOND_EXEMPLES}`, r.exemples.length <= PLAFOND_EXEMPLES);
        if (portee === "A") {
          ok("portee A : les 25 chantiers invalides depassent le plafond, le compte annonce 25 et non 20",
            parType.Chantier === N && r.parTypeEntite!.find((t) => t.entityType === "Chantier")!.nombre === N);
          const types = new Set(r.exemples.slice(0, 3).map((e) => e.entityType));
          ok("portee A : les trois premiers exemples (ceux que la route affiche) sont de trois types differents", types.size === 3);
          const raisons = r.exemples.map((e) => e.explication).join(" | ");
          ok("portee A : la raison de PostGIS est restituee (Too few points, Self-intersection, Hole lies outside shell)",
            /Too few points/.test(raisons) && /Self-intersection/.test(raisons) && /Hole lies outside shell/.test(raisons));
        }
      }

      // Aucune ligne supprimee, remplacee, ni valide n'apparait dans les exemples (portee nationale, tout lister par type).
      const parTable = new Map<string, string[]>();
      for (const [table, type] of TYPES) {
        parTable.set(type, modele.filter((f) => f.table === table).map((f) => f.id));
      }
      const exNat = (await geometriesInvalides({ regionId: null })).exemples;
      const intrus = exNat.filter((e) => {
        const f = modele.find((x) => x.id === e.entityId);
        return f && (f.supprimee || f.remplacee || estValideOracle(f.geo));
      });
      ok("aucun exemple n'est une ligne supprimee, une portion remplacee ou une geometrie valide", intrus.length === 0);

      // Region inconnue : zero partout, sans erreur (la recursion des limites ne rend rien).
      const inconnue = await geometriesInvalides({ regionId: 987654 });
      ok("une region inconnue donne 0 pour les six tables, sans erreur", inconnue.nombre === 0 && inconnue.parTypeEntite!.every((t) => t.nombre === 0));

      // Cycle de parentPcode (L1A < L3A < L2A < L1A) : la descente s'arrete, et L2A et L3A sont trouvees une fois.
      const limitesA = await invalidesLimitesAdmin({ regionId: rA });
      ok("le cycle de parentPcode ne fait pas boucler la descente : L2A et L3A comptees une fois chacune",
        limitesA.nombre === 2 && new Set(limitesA.exemples.map((e) => e.entityId)).size === 2);

      // ----------------------------------------------------------- 4. Contre-epreuve
      const ancien = await invalidesTroncons({ regionId: null });
      const autresInvalides = TYPES.filter(([, type]) => type !== "Troncon").reduce((s, [t]) => s + attendu(t, "national"), 0);
      const complet = await geometriesInvalides({ regionId: null });
      ok(`CONTRE-EPREUVE : le detecteur d'avant (troncons seuls) ne voit aucune des ${autresInvalides} invalides des autres tables`,
        autresInvalides > 0 && complet.nombre - (base.nombre) - (ancien.nombre - (baseParType.Troncon ?? 0)) === autresInvalides
        && ancien.exemples.every((e) => e.entityType === "Troncon"));

    }
  }

  for (const [nom, vrai] of Object.entries(resultats)) verifier(nom, vrai);
  conclure();
}
main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); await banc.fermer(); });
