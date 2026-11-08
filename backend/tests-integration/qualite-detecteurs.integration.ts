// Banc d'integration PostGIS : detecteurs de qualite des troncons. Voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/qualite-detecteurs.integration.ts
import "./lib/garde";
//
// CE QUI EST EPROUVE, CONTRE POSTGIS REEL, DANS UNE TRANSACTION ANNULEE SUR `replay`
//   - UNE anomalie par detecteur (PK 0/0, fin < debut, NaN, negatif, chevauchement, trou, longueur nulle, ecart de
//     longueur, geometrie nulle / vide / invalide / micro-trace, region discordante nette et a cheval, « Non renseigne »,
//     region sans limite, hors territoire documente ou non, doublon strict, inverse, quasi, trois etats) ET des troncons
//     SAINS qui ne doivent pas etre signales (faux positifs : ecart de longueur sous le seuil, petit troncon, parallele a
//     111 m, decale de 3 m, jumeau supprime logiquement, partage 50/50, 70/30 dans la region declaree, chaine continue) ;
//   - TROIS accords : le modele ecrit a la main pour chaque fixture, un ORACLE SQL ecrit independamment (spheroide par
//     segment, milieu de segment dans le polygone, ST_Equals, distance de sommets, fonctions fenetres pour les PK),
//     et le service. Les longueurs declarees des troncons sains viennent de Vincenty (TypeScript, sans PostGIS) ;
//   - la portee par region (entite OU partenaire dans la region pour le chainage de PK) ;
//   - AUCUNE ECRITURE : le service tourne dans une transaction passee en lecture seule apres l'insertion des fixtures ; les
//     compteurs d'ecriture de pg_stat_xact_user_tables et l'empreinte des troncons sont identiques avant et apres ; la base
//     refuse une ecriture dans cette transaction ; la forme `lancerEnLectureSeule` ouvre bien une transaction READ ONLY ;
//   - deux CONTRE-EPREUVES : un seuil resserre fait diverger le service de l'oracle ; une fixture saine devient anormale.
//
// CE QU'IL NE PROUVE PAS : la production (volumes, duree d'un balayage de 261 387 troncons), la precision de la couche
// de limites reelle, ni la pertinence metier des seuils (provisoires). `replay` n'est jamais ecrite durablement.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lancerDetecteurs, lancerEnLectureSeule } from "../src/qualite/detecteurs.service";
import { SEUILS_PROVISOIRES, CODES_ANOMALIE, type CodeAnomalie } from "../src/qualite/detecteurs.noyau";
import { longueurLigneGeodesique } from "./lib/geodesie";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
const ROLLBACK = new Error("ROLLBACK_VOULU");
const MAINTENANT = new Date("2026-10-26T12:00:00Z");

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
type Pt = [number, number];
type Reg = "A" | "B" | "C" | "N";
interface Fixture {
  id: string;
  region: Reg;
  /** Trace [lon, lat][], ou NULL / EMPTY. */
  geom: Pt[] | "NULL" | "EMPTY";
  /** Longueur declaree en km : nombre, ou facteur applique a la longueur de Vincenty du trace. */
  longueur: number | { facteur: number };
  nom?: string;
  section?: string | null;
  pkDebut?: string;
  pkFin?: string;
  etat?: string;
  date?: string | null;
  perimetre?: string | null;
  supprime?: boolean;
  /** Codes attendus (le modele, ecrit a la main). */
  attendu: CodeAnomalie[];
}

let k = 0;
/** Une ligne de 0,1 deg en longitude a une latitude propre a chaque fixture : aucune n'en croise une autre. */
const lat = () => Number((10.05 + 0.012 * k++).toFixed(4));
const enA = (dx = 0.1): Pt[] => { const y = lat(); return [[-13.9, y], [-13.9 + dx, y]]; };
const enB = (dx = 0.1): Pt[] => { const y = lat(); return [[-12.9, y], [-12.9 + dx, y]]; };
const decale = (g: Pt[], dlon: number): Pt[] => g.map(([x, y]) => [Number((x + dlon).toFixed(7)), y] as Pt);

const h1 = enA(); // jumeau supprime logiquement
const d1 = enA();
const d3 = enA();
const d5 = enA();
const p6u = enB(); // pour u2, en B
const h6 = enA();
const h6bis = h6.map(([x, y]) => [x, Number((y + 0.001).toFixed(4))] as Pt); // parallele a 111 m
const h7 = enA();

const FIXTURES: Fixture[] = [
  // ---- sains : rien ne doit etre signale ----
  { id: "qd-h1", region: "A", geom: h1, longueur: { facteur: 1 }, attendu: [] },
  { id: "qd-h2", region: "B", geom: enB(), longueur: { facteur: 1 }, attendu: [] },
  { id: "qd-h3a", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN1", section: "1", pkDebut: "0", pkFin: "10", attendu: [] },
  { id: "qd-h3b", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN1", section: "1", pkDebut: "10", pkFin: "25", attendu: [] },
  { id: "qd-h3c", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN1", section: "1", pkDebut: "25.2", pkFin: "30", attendu: [] },
  // 70 % dans A (declaree) et 30 % dans B : la region declaree est majoritaire
  { id: "qd-h4", region: "A", geom: (() => { const y = lat(); return [[-13.7, y], [-13.0, y], [-12.7, y]] as Pt[]; })(), longueur: { facteur: 1 }, attendu: [] },
  // 50/50 : la region declaree est aussi bien placee que l'autre
  { id: "qd-h5", region: "A", geom: (() => { const y = lat(); return [[-13.2, y], [-13.0, y], [-12.8, y]] as Pt[]; })(), longueur: { facteur: 1 }, attendu: [] },
  // parallele a 111 m, puis decale de 3 m : voisins, pas doublons
  { id: "qd-h6a", region: "A", geom: h6, longueur: { facteur: 1 }, attendu: [] },
  { id: "qd-h6b", region: "A", geom: h6bis, longueur: { facteur: 1 }, attendu: [] },
  { id: "qd-h7a", region: "A", geom: h7, longueur: { facteur: 1 }, attendu: [] },
  { id: "qd-h7b", region: "A", geom: decale(h7, 0.00003), longueur: { facteur: 1 }, attendu: [] },
  // meme trace que qd-h1 mais supprime logiquement : ne rend pas qd-h1 doublon, n'est pas examine
  { id: "qd-h8", region: "A", geom: h1, longueur: { facteur: 1 }, supprime: true, attendu: [] },
  { id: "qd-h9", region: "A", geom: enA(), longueur: { facteur: 1 }, etat: "MAUVAIS", date: "2026-10-01 00:00:00", attendu: [] },
  // ecart de 5 % : sous le seuil provisoire de 10 %
  { id: "qd-l3", region: "A", geom: enA(), longueur: { facteur: 1.05 }, attendu: [] },
  // petit troncon : 25 % d'ecart mais 10 m seulement, sous le minimum absolu
  { id: "qd-l4", region: "A", geom: (() => { const y = lat(); return [[-13.9, y], [-13.8996, y]] as Pt[]; })(), longueur: 0.03, attendu: [] },
  // voirie sans section : PK locaux 0 -> longueur, non chaines
  { id: "qd-hv", region: "A", geom: enA(), longueur: { facteur: 1 }, pkDebut: "0", pkFin: "10.9", section: null, attendu: [] },

  // ---- (a) PK ----
  { id: "qd-p1", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN2", section: "1", pkDebut: "0", pkFin: "0", attendu: ["PK_SENTINELLE_ZERO"] },
  { id: "qd-p2", region: "A", geom: enA(), longueur: { facteur: 1 }, pkDebut: "12", pkFin: "4", attendu: ["PK_FIN_INFERIEUR_DEBUT"] },
  // PK de fin nul mais PK de debut positif : fin < debut, et PAS la sentinelle 0/0
  { id: "qd-p7", region: "A", geom: enA(), longueur: { facteur: 1 }, pkDebut: "7", pkFin: "0", attendu: ["PK_FIN_INFERIEUR_DEBUT"] },
  { id: "qd-p3", region: "A", geom: enA(), longueur: { facteur: 1 }, pkDebut: "NaN", pkFin: "5", attendu: ["PK_ABSENT"] },
  { id: "qd-p4", region: "A", geom: enA(), longueur: { facteur: 1 }, pkDebut: "-3", pkFin: "5", attendu: ["PK_NEGATIF"] },
  { id: "qd-p5a", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN2", section: "1", pkDebut: "0", pkFin: "10", attendu: [] },
  { id: "qd-p5b", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN2", section: "1", pkDebut: "8", pkFin: "20", attendu: ["PK_CHEVAUCHEMENT"] },
  { id: "qd-p5c", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN2", section: "1", pkDebut: "24", pkFin: "30", attendu: ["PK_TROU"] },
  // chainage a cheval sur deux regions : l'anomalie est portee par le troncon de B, le partenaire est en A
  { id: "qd-p6a", region: "A", geom: enA(), longueur: { facteur: 1 }, nom: "QD RN3", section: "1", pkDebut: "0", pkFin: "10", attendu: [] },
  { id: "qd-p6b", region: "B", geom: p6u, longueur: { facteur: 1 }, nom: "QD RN3", section: "1", pkDebut: "8", pkFin: "20", attendu: ["PK_CHEVAUCHEMENT"] },

  // ---- (b) longueur ----
  { id: "qd-l1", region: "A", geom: enA(), longueur: 0, attendu: ["LONGUEUR_NON_POSITIVE"] },
  { id: "qd-l2", region: "A", geom: enA(), longueur: 30, attendu: ["LONGUEUR_ECART_GEOMETRIE"] },

  // ---- (c) geometrie ----
  { id: "qd-g1", region: "A", geom: "NULL", longueur: 5, attendu: ["GEOM_ABSENTE"] },
  { id: "qd-g2", region: "A", geom: "EMPTY", longueur: 5, attendu: ["GEOM_VIDE"] },
  // deux sommets identiques : LineString invalide (« Too few points ») et sans etendue ; deux copies identiques
  // qui ne doivent PAS etre dites doublons (une geometrie invalide est ecartee des doublons)
  { id: "qd-g3a", region: "A", geom: [[-13.5, 10.9], [-13.5, 10.9]], longueur: 1, attendu: ["GEOM_INVALIDE", "GEOM_LONGUEUR_NULLE"] },
  { id: "qd-g3b", region: "A", geom: [[-13.5, 10.9], [-13.5, 10.9]], longueur: 1, attendu: ["GEOM_INVALIDE", "GEOM_LONGUEUR_NULLE"] },
  // valide mais de 1 mm : longueur nulle au seuil de 1 cm
  { id: "qd-g4", region: "A", geom: (() => { const y = lat(); return [[-13.5, y], [-13.49999999, y]] as Pt[]; })(), longueur: 0.001, attendu: ["GEOM_LONGUEUR_NULLE"] },

  // ---- (d) region ----
  { id: "qd-r1", region: "B", geom: enA(), longueur: { facteur: 1 }, attendu: ["REGION_DISCORDANTE"] },
  { id: "qd-r2", region: "B", geom: (() => { const y = lat(); return [[-13.2, y], [-13.0, y], [-12.9, y]] as Pt[]; })(), longueur: { facteur: 1 }, attendu: ["REGION_DISCORDANTE"] },
  { id: "qd-r3", region: "N", geom: enA(), longueur: { facteur: 1 }, attendu: ["REGION_NON_RENSEIGNEE"] },
  { id: "qd-r4", region: "C", geom: enA(), longueur: { facteur: 1 }, attendu: ["REGION_NON_VERIFIABLE"] },
  { id: "qd-r5", region: "A", geom: (() => { const y = lat(); return [[-10, y], [-9.9, y]] as Pt[]; })(), longueur: { facteur: 1 }, attendu: ["HORS_TERRITOIRE"] },
  { id: "qd-r6", region: "A", geom: (() => { const y = lat(); return [[-10, y], [-9.9, y]] as Pt[]; })(), longueur: { facteur: 1 }, perimetre: "HORS_TERRITOIRE_NATIONAL", attendu: ["HORS_TERRITOIRE"] },

  // ---- (e) doublons ----
  { id: "qd-d1", region: "A", geom: d1, longueur: { facteur: 1 }, attendu: ["DOUBLON_GEOMETRIE_STRICT"] },
  { id: "qd-d2", region: "B", geom: d1, longueur: { facteur: 1 }, attendu: ["DOUBLON_GEOMETRIE_STRICT", "REGION_DISCORDANTE"] },
  { id: "qd-d3", region: "A", geom: d3, longueur: { facteur: 1 }, attendu: ["DOUBLON_GEOMETRIE_STRICT"] },
  { id: "qd-d4", region: "A", geom: [...d3].reverse(), longueur: { facteur: 1 }, attendu: ["DOUBLON_GEOMETRIE_STRICT"] },
  { id: "qd-d5", region: "A", geom: d5, longueur: { facteur: 1 }, attendu: ["DOUBLON_GEOMETRIE_QUASI"] },
  { id: "qd-d6", region: "A", geom: decale(d5, 0.000005), longueur: { facteur: 1 }, attendu: ["DOUBLON_GEOMETRIE_QUASI"] },

  // ---- (f) etat declare ----
  { id: "qd-e1", region: "A", geom: enA(), longueur: { facteur: 1 }, etat: "NON_EVALUE", date: null, attendu: ["ETAT_NON_EVALUE"] },
  { id: "qd-e2", region: "A", geom: enA(), longueur: { facteur: 1 }, etat: "NON_EVALUE", date: "2026-03-01 00:00:00", attendu: ["ETAT_DATE_SANS_ETAT", "ETAT_NON_EVALUE"] },
  { id: "qd-e3", region: "A", geom: enA(), longueur: { facteur: 1 }, etat: "BON", date: null, attendu: ["ETAT_SANS_DATE_EVALUATION"] },
  { id: "qd-e4", region: "A", geom: enA(), longueur: { facteur: 1 }, etat: "BON", date: "2027-06-01 00:00:00", attendu: ["ETAT_DATE_FUTURE"] },
];
// qd-d2 : meme trace que qd-d1 mais declare en B alors qu'il est en A -> region discordante en plus, voulu.
// (le modele le dit : un doublon inter-regions est aussi un probleme de rattachement)

const REGIONS: Record<Reg, string> = { A: "Qd Boké", B: "Qd Kindia", C: "Qd Sans limite", N: "Non renseigné" };
const wkt = (g: Fixture["geom"]): string | null =>
  g === "NULL" ? null : g === "EMPTY" ? "LINESTRING EMPTY" : `LINESTRING(${g.map(([x, y]) => `${x} ${y}`).join(", ")})`;
const km = (f: Fixture): number => {
  if (typeof f.longueur === "number") return f.longueur;
  if (f.geom === "NULL" || f.geom === "EMPTY") return 1;
  return (longueurLigneGeodesique(f.geom) / 1000) * f.longueur.facteur;
};

// ---------------------------------------------------------------------------------------------
// Oracle SQL ecrit independamment du service : aucun appel aux fonctions du depot, seuils en litteraux.
// ---------------------------------------------------------------------------------------------
const SPHEROIDE = `'SPHEROID["WGS 84",6378137,298.257223563]'`;
const ORACLE_SQL = `
WITH
actifs AS (SELECT t.* FROM troncons t WHERE t.id LIKE 'qd-%' AND t."deletedAt" IS NULL),
-- longueur geodesique par somme de distances spheroidiques entre sommets (ni ST_Length ni geography)
pts AS (
  SELECT a.id, (dp).path[1] AS i, (dp).geom AS g
    FROM actifs a, LATERAL ST_DumpPoints(a.geom) dp
   WHERE a.geom IS NOT NULL AND NOT ST_IsEmpty(a.geom)
), seg AS (
  SELECT p.id, ST_DistanceSpheroid(p.g, q.g, ${SPHEROIDE}) AS m, p.i,
         ST_LineInterpolatePoint(ST_MakeLine(p.g, q.g), 0.5) AS milieu
    FROM pts p JOIN pts q ON q.id = p.id AND q.i = p.i + 1
), lg AS (
  SELECT a.id, coalesce((SELECT sum(m) FROM seg WHERE seg.id = a.id), 0) AS m
    FROM actifs a WHERE a.geom IS NOT NULL AND NOT ST_IsEmpty(a.geom)
),
-- (a) PK
pk_absent AS (SELECT id FROM actifs WHERE "pkDebut" IN ('NaN','Infinity','-Infinity') OR "pkFin" IN ('NaN','Infinity','-Infinity')),
pk_ok AS (SELECT * FROM actifs WHERE id NOT IN (SELECT id FROM pk_absent)),
chaine AS (
  SELECT id, "pkDebut", "pkFin", nom, "sectionPk",
         max("pkFin") OVER (PARTITION BY nom, "sectionPk" ORDER BY "pkDebut", "pkFin", id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS fin_precedente
    FROM pk_ok
   WHERE "sectionPk" IS NOT NULL AND "pkDebut" >= 0 AND "pkFin" >= 0 AND "pkFin" >= "pkDebut"
     AND NOT ("pkDebut" = 0 AND "pkFin" = 0)
),
-- (d) region : part de la longueur dans chaque limite, par milieu de segment couvert
regpart AS (
  SELECT s.id, unaccent(lower(l.nom)) AS cle, l.nom, sum(s.m) / NULLIF((SELECT m FROM lg WHERE lg.id = s.id), 0) AS part
    FROM seg s JOIN limites_admin l ON l.niveau = 1 AND ST_Covers(l.geom, s.milieu)
   WHERE s.id IN (SELECT id FROM actifs WHERE geom IS NOT NULL AND ST_IsValid(geom))
   GROUP BY s.id, l.nom
),
regdom AS (
  SELECT DISTINCT ON (id) id, cle, nom, part FROM regpart ORDER BY id, part DESC
),
-- vertices couverts par une limite : un trace dont aucun sommet ni milieu n'est couvert est hors territoire
touche AS (
  SELECT DISTINCT p.id FROM pts p JOIN limites_admin l ON l.niveau = 1 AND ST_Covers(l.geom, p.g)
  UNION SELECT id FROM regpart
),
reg AS (
  SELECT a.id, r.nom AS rnom, unaccent(lower(r.nom)) AS rcle,
         EXISTS (SELECT 1 FROM limites_admin l WHERE l.niveau = 1 AND unaccent(lower(l.nom)) = unaccent(lower(r.nom))) AS a_limite
    FROM actifs a JOIN regions r ON r.id = a."regionId"
   WHERE a.geom IS NOT NULL AND NOT ST_IsEmpty(a.geom) AND ST_IsValid(a.geom) AND (SELECT m FROM lg WHERE lg.id = a.id) > 0
),
-- (e) doublons : paires ordonnees de troncons actifs valides, sans filtre d'emprise
pair AS (
  SELECT a.id AS id, b.id AS autre, ST_Equals(a.geom, b.geom) AS egal,
         NOT EXISTS (SELECT 1 FROM ST_DumpPoints(a.geom) d WHERE ST_Distance((d).geom, b.geom) > 0.00001)
         AND NOT EXISTS (SELECT 1 FROM ST_DumpPoints(b.geom) d WHERE ST_Distance((d).geom, a.geom) > 0.00001) AS proche
    FROM actifs a JOIN actifs b ON a.id <> b.id
   WHERE a.geom IS NOT NULL AND b.geom IS NOT NULL AND NOT ST_IsEmpty(a.geom) AND NOT ST_IsEmpty(b.geom)
     AND ST_IsValid(a.geom) AND ST_IsValid(b.geom)
)
SELECT code, id FROM (
  SELECT 'PK_ABSENT' AS code, id FROM pk_absent
  UNION ALL SELECT 'PK_NEGATIF', id FROM pk_ok WHERE "pkDebut" < 0 OR "pkFin" < 0
  UNION ALL SELECT 'PK_SENTINELLE_ZERO', id FROM pk_ok WHERE "pkDebut" = 0 AND "pkFin" = 0
  UNION ALL SELECT 'PK_FIN_INFERIEUR_DEBUT', id FROM pk_ok WHERE "pkFin" < "pkDebut" AND NOT ("pkDebut" = 0 AND "pkFin" = 0)
  UNION ALL SELECT 'PK_CHEVAUCHEMENT', id FROM chaine WHERE fin_precedente - "pkDebut" > 0.05 + 1e-9
  UNION ALL SELECT 'PK_TROU', id FROM chaine WHERE NOT (fin_precedente - "pkDebut" > 0.05 + 1e-9) AND "pkDebut" - fin_precedente > 0.5 + 1e-9
  UNION ALL SELECT 'LONGUEUR_NON_POSITIVE', id FROM actifs WHERE "longueurKm" <= 0 OR "longueurKm" IN ('NaN','Infinity')
  UNION ALL SELECT 'LONGUEUR_ECART_GEOMETRIE', a.id FROM actifs a JOIN lg ON lg.id = a.id
     WHERE a."longueurKm" > 0 AND a."longueurKm" NOT IN ('NaN','Infinity') AND lg.m >= 0.01
       AND abs(a."longueurKm" - lg.m / 1000) / (lg.m / 1000) > 0.10 + 1e-9
       AND abs(a."longueurKm" - lg.m / 1000) >= 0.05 - 1e-9
  UNION ALL SELECT 'GEOM_ABSENTE', id FROM actifs WHERE geom IS NULL
  UNION ALL SELECT 'GEOM_VIDE', id FROM actifs WHERE geom IS NOT NULL AND ST_IsEmpty(geom)
  UNION ALL SELECT 'GEOM_INVALIDE', id FROM actifs WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND NOT ST_IsValid(geom)
  UNION ALL SELECT 'GEOM_NON_LINEAIRE', id FROM actifs WHERE geom IS NOT NULL AND GeometryType(geom) <> 'LINESTRING'
  UNION ALL SELECT 'GEOM_SRID_INATTENDU', id FROM actifs WHERE geom IS NOT NULL AND ST_SRID(geom) <> 4326
  UNION ALL SELECT 'GEOM_LONGUEUR_NULLE', id FROM lg WHERE m < 0.01
  UNION ALL SELECT 'HORS_TERRITOIRE', r.id FROM reg r WHERE r.id NOT IN (SELECT id FROM touche)
  UNION ALL SELECT 'REGION_NON_RENSEIGNEE', r.id FROM reg r WHERE r.id IN (SELECT id FROM touche) AND r.rnom = 'Non renseigné'
  UNION ALL SELECT 'REGION_NON_VERIFIABLE', r.id FROM reg r WHERE r.id IN (SELECT id FROM touche) AND r.rnom <> 'Non renseigné' AND NOT r.a_limite
  UNION ALL SELECT 'REGION_DISCORDANTE', r.id FROM reg r JOIN regdom d ON d.id = r.id
     WHERE r.rnom <> 'Non renseigné' AND r.a_limite AND d.cle <> r.rcle AND d.part > 0.5 + 1e-9
       AND d.part > coalesce((SELECT sum(part) FROM regpart p WHERE p.id = r.id AND p.cle = r.rcle), 0)
  UNION ALL SELECT 'DOUBLON_GEOMETRIE_STRICT', id FROM pair GROUP BY id HAVING bool_or(egal)
  UNION ALL SELECT 'DOUBLON_GEOMETRIE_QUASI', id FROM pair GROUP BY id HAVING NOT bool_or(egal) AND bool_or(proche)
  UNION ALL SELECT 'ETAT_NON_EVALUE', id FROM actifs WHERE etat = 'NON_EVALUE'
  UNION ALL SELECT 'ETAT_DATE_SANS_ETAT', id FROM actifs WHERE etat = 'NON_EVALUE' AND "dateDerniereEvaluation" IS NOT NULL
  UNION ALL SELECT 'ETAT_SANS_DATE_EVALUATION', id FROM actifs WHERE etat <> 'NON_EVALUE' AND "dateDerniereEvaluation" IS NULL
  UNION ALL SELECT 'ETAT_DATE_FUTURE', id FROM actifs WHERE etat <> 'NON_EVALUE' AND "dateDerniereEvaluation" > timestamp '2026-10-26 12:00:00' + interval '1 day'
) x
`;

const paires = (lignes: { code: string; id: string }[]): Set<string> => new Set(lignes.map((l) => `${l.code}|${l.id}`));
const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function inserer(tx: Tx): Promise<Record<Reg, number>> {
  await tx.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS unaccent`);
  const ids = {} as Record<Reg, number>;
  for (const [cle, nom] of Object.entries(REGIONS) as [Reg, string][]) {
    await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ($1) ON CONFLICT (nom) DO NOTHING`, nom);
    ids[cle] = (await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom = $1`, nom))[0].id;
  }
  // Limites de niveau 1 : A (Boke, SANS accent sur la limite pour eprouver la jointure unaccent) et B
  const carre = (x0: number, x1: number) => `MULTIPOLYGON(((${x0} 10, ${x1} 10, ${x1} 11, ${x0} 11, ${x0} 10)))`;
  await tx.$executeRawUnsafe(
    `INSERT INTO limites_admin (pcode, niveau, nom, source, geom) VALUES
       ('QD-A', 1, 'Qd Boke', 'banc', ST_GeomFromText($1, 4326)),
       ('QD-B', 1, 'Qd Kindia', 'banc', ST_GeomFromText($2, 4326))`,
    carre(-14, -13), carre(-13, -12));
  for (const f of FIXTURES) {
    await tx.$executeRawUnsafe(
      `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin",
                             "sectionPk", perimetre, "dateDerniereEvaluation", geom, "deletedAt", "updatedAt")
       VALUES ($1, $2, $3, 'RN'::"ClasseRoute", $4::int, $5::float8, 'BITUME'::"Revetement", $6::"EtatPatrimoine",
               $7::text::float8, $8::text::float8, $9, $10::"PerimetreReseau", $11::timestamp,
               ST_GeomFromText($12, 4326), $13::timestamp, CURRENT_TIMESTAMP)`,
      f.id, `QD-${f.id.slice(3).toUpperCase()}`, f.nom ?? "QD piste", ids[f.region], km(f),
      f.etat ?? "BON", f.pkDebut ?? "0", f.pkFin ?? "5",
      f.section === undefined ? null : f.section, f.perimetre ?? null,
      f.date === undefined ? "2026-01-01 00:00:00" : f.date,
      wkt(f.geom), f.supprime ? "2026-02-01 00:00:00" : null);
  }
  return ids;
}

async function main() {
  // Les seuils du banc sont des LITTERAUX (dans l'oracle) : si un seuil provisoire change, le banc doit le dire.
  verifier("les seuils provisoires du service sont ceux que l'oracle suppose", JSON.stringify(SEUILS_PROVISOIRES) === JSON.stringify({
    PK_CHEVAUCHEMENT_KM: 0.05, PK_TROU_KM: 0.5, LONGUEUR_ECART_RELATIF: 0.1, LONGUEUR_ECART_ABSOLU_MIN_KM: 0.05,
    LONGUEUR_GEOMETRIQUE_NULLE_M: 0.01, REGION_MAJORITE: 0.5, REGION_PART_DECLAREE_FAIBLE: 0.2,
    DOUBLON_QUASI_TOLERANCE_DEG: 0.00001, ETAT_DATE_FUTURE_TOLERANCE_JOURS: 1,
  }), SEUILS_PROVISOIRES);

  // ---- la structure interdit un trace non lineaire ou d'un autre SRID (transaction a part, annulee) ----
  const refus: Record<string, string> = {};
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Qd typage')`);
      for (const [nom, ewkt] of [["point", "SRID=4326;POINT(-13.5 10.5)"], ["srid3857", "SRID=3857;LINESTRING(0 0, 1 1)"]]) {
        await tx.$executeRawUnsafe(`SAVEPOINT s_typage`);
        try {
          await tx.$executeRawUnsafe(
            `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
             VALUES ($1, $1, 'x', 'RN', (SELECT id FROM regions WHERE nom = 'Qd typage'), 1, 'BITUME', 0, 1, ST_GeomFromEWKT($2), CURRENT_TIMESTAMP)`,
            `qd-typage-${nom}`, ewkt);
          refus[nom] = "";
        } catch (e) { refus[nom] = e instanceof Error ? e.message : String(e); }
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT s_typage`);
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  verifier("structure : un POINT ne peut pas entrer dans troncons.geom (GEOM_NON_LINEAIRE impossible)", /does not match column type/i.test(refus.point), refus.point?.slice(0, 200));
  verifier("structure : un SRID 3857 ne peut pas entrer dans troncons.geom (GEOM_SRID_INATTENDU impossible)", /does not match column SRID/i.test(refus.srid3857), refus.srid3857?.slice(0, 200));

  try {
    await prisma.$transaction(async (tx) => {
      const regionIds = await inserer(tx);
      const actives = FIXTURES.filter((f) => !f.supprime);

      // ---- oracle SQL, modele, service ----
      const oracle = paires(await tx.$queryRawUnsafe<{ code: string; id: string }[]>(ORACLE_SQL));
      const modele = new Set<string>();
      for (const f of actives) for (const c of f.attendu) modele.add(`${c}|${f.id}`);

      // ---- immobilisation : tout ce qui suit est en lecture seule ----
      const compteurs = async () => (await tx.$queryRawUnsafe<{ relname: string; i: string; u: string; d: string }[]>(
        `SELECT relname, n_tup_ins::text AS i, n_tup_upd::text AS u, n_tup_del::text AS d
           FROM pg_stat_xact_user_tables WHERE n_tup_ins + n_tup_upd + n_tup_del > 0 ORDER BY relname`));
      const empreinte = async () => (await tx.$queryRawUnsafe<{ h: string; n: string; a: string; v: string; r: string }[]>(
        `SELECT (SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM troncons t) AS h,
                (SELECT count(*)::text FROM troncons) AS n,
                (SELECT count(*)::text FROM audit_logs) AS a,
                (SELECT count(*)::text FROM valeurs_qualite) AS v,
                (SELECT count(*)::text FROM regions) AS r`))[0];

      await tx.$executeRawUnsafe(`SET LOCAL transaction_read_only = on`);
      const avantStat = await compteurs();
      const avantEmpreinte = await empreinte();
      const lectureSeule = (await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>(`SHOW transaction_read_only`))[0].transaction_read_only;
      verifier("la transaction du service est en lecture seule (SHOW transaction_read_only = on)", lectureSeule === "on", lectureSeule);

      await tx.$executeRawUnsafe(`SAVEPOINT avant_ecriture`);
      let refus = "";
      try { await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Qd ne-doit-pas-exister')`); }
      catch (e) { refus = e instanceof Error ? e.message : String(e); }
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT avant_ecriture`);
      verifier("la base refuse une ecriture dans cette transaction (read-only)", /read-only transaction/i.test(refus), refus.slice(0, 120));

      const base = { maintenant: MAINTENANT, plafondParCode: 10_000 };
      const national = await lancerDetecteurs(tx, { ...base, portee: { regionId: null } });

      const apresStat = await compteurs();
      const apresEmpreinte = await empreinte();
      verifier("aucune ecriture : pg_stat_xact_user_tables identique avant et apres le service", JSON.stringify(avantStat) === JSON.stringify(apresStat), { avantStat, apresStat });
      verifier("aucune ecriture : empreinte des troncons, comptes troncons / audit_logs / valeurs_qualite / regions inchanges",
        JSON.stringify(avantEmpreinte) === JSON.stringify(apresEmpreinte), { avantEmpreinte, apresEmpreinte });
      verifier("le service n'a ajoute aucune ligne a audit_logs", apresEmpreinte.a === avantEmpreinte.a && apresEmpreinte.a === "0", apresEmpreinte.a);

      const service = new Set<string>();
      for (const c of national.parCode) for (const e of c.entites) if (e.entiteId.startsWith("qd-")) service.add(`${c.code}|${e.entiteId}`);

      // ---- trois accords ----
      verifier("le modele ecrit a la main est non vide et couvre tous les codes sauf les quatre impossibles par typage (GEOM_NON_LINEAIRE, GEOM_SRID_INATTENDU) ou par enum (ETAT_ABSENT, ETAT_INCONNU)",
        [...new Set([...modele].map((m) => m.split("|")[0]))].length === CODES_ANOMALIE.length - 4,
        { manquants: CODES_ANOMALIE.filter((c) => ![...modele].some((m) => m.startsWith(c + "|"))) });
      verifier("service = modele (chaque anomalie attendue est rendue, aucune de plus)", diff(service, modele).length === 0 && diff(modele, service).length === 0,
        { enTrop: diff(service, modele), manquantes: diff(modele, service) });
      verifier("oracle SQL = modele", diff(oracle, modele).length === 0 && diff(modele, oracle).length === 0,
        { enTrop: diff(oracle, modele), manquantes: diff(modele, oracle) });
      verifier("service = oracle SQL", diff(service, oracle).length === 0 && diff(oracle, service).length === 0,
        { service_seul: diff(service, oracle), oracle_seul: diff(oracle, service) });

      // ---- une verification nommee par detecteur et par famille de faux positifs ----
      const dit = (code: CodeAnomalie, id: string) => service.has(`${code}|${id}`);
      const rien = (id: string) => ![...service].some((s) => s.endsWith(`|${id}`));
      for (const [code, id] of [
        ["PK_SENTINELLE_ZERO", "qd-p1"], ["PK_FIN_INFERIEUR_DEBUT", "qd-p2"], ["PK_ABSENT", "qd-p3"], ["PK_NEGATIF", "qd-p4"],
        ["PK_CHEVAUCHEMENT", "qd-p5b"], ["PK_TROU", "qd-p5c"], ["LONGUEUR_NON_POSITIVE", "qd-l1"], ["LONGUEUR_ECART_GEOMETRIE", "qd-l2"],
        ["GEOM_ABSENTE", "qd-g1"], ["GEOM_VIDE", "qd-g2"], ["GEOM_INVALIDE", "qd-g3a"], ["GEOM_LONGUEUR_NULLE", "qd-g4"],
        ["REGION_DISCORDANTE", "qd-r1"], ["REGION_DISCORDANTE", "qd-r2"], ["REGION_NON_RENSEIGNEE", "qd-r3"], ["REGION_NON_VERIFIABLE", "qd-r4"],
        ["HORS_TERRITOIRE", "qd-r5"], ["HORS_TERRITOIRE", "qd-r6"],
        ["DOUBLON_GEOMETRIE_STRICT", "qd-d1"], ["DOUBLON_GEOMETRIE_STRICT", "qd-d4"], ["DOUBLON_GEOMETRIE_QUASI", "qd-d6"],
        ["ETAT_NON_EVALUE", "qd-e1"], ["ETAT_DATE_SANS_ETAT", "qd-e2"], ["ETAT_SANS_DATE_EVALUATION", "qd-e3"], ["ETAT_DATE_FUTURE", "qd-e4"],
      ] as [CodeAnomalie, string][]) verifier(`detecte ${code} sur ${id}`, dit(code, id));

      for (const [id, raison] of [
        ["qd-h1", "troncon sain avec un jumeau supprime logiquement"], ["qd-h2", "troncon sain en region B"],
        ["qd-h3a", "chaine de PK continue (debut)"], ["qd-h3b", "chaine de PK continue (milieu)"], ["qd-h3c", "chaine avec trou de 200 m sous le seuil"],
        ["qd-h4", "70 % dans la region declaree"], ["qd-h5", "partage 50/50 avec une autre region"],
        ["qd-h6a", "parallele a 111 m (voisin, pas doublon)"], ["qd-h6b", "parallele a 111 m (voisin, pas doublon)"],
        ["qd-h7a", "decale de 3 m (au-dessus du seuil quasi-doublon)"], ["qd-h7b", "decale de 3 m (au-dessus du seuil quasi-doublon)"],
        ["qd-h9", "etat MAUVAIS date du 1er octobre"], ["qd-l3", "ecart de longueur de 5 % sous le seuil"],
        ["qd-l4", "petit troncon : 25 % mais 10 m d'ecart"], ["qd-hv", "voirie sans section, PK locaux 0 -> longueur"],
        ["qd-p5a", "debut d'une chaine dont la suite chevauche"], ["qd-p6a", "partenaire sain d'un chevauchement inter-regions"],
      ] as [string, string][]) verifier(`ne signale pas ${id} : ${raison}`, rien(id));
      verifier("le troncon supprime logiquement n'est pas examine", rien("qd-h8"));
      verifier("les PK 0/0 sont ecartes du chainage (qd-p1 n'est pas dit chevauchement ni trou)", !dit("PK_CHEVAUCHEMENT", "qd-p1") && !dit("PK_TROU", "qd-p1"));
      verifier("deux copies invalides identiques ne sont pas dites doublons", !dit("DOUBLON_GEOMETRIE_STRICT", "qd-g3a") && !dit("DOUBLON_GEOMETRIE_STRICT", "qd-g3b"));
      verifier("le quasi-doublon n'est pas aussi dit strict", !dit("DOUBLON_GEOMETRIE_STRICT", "qd-d5") && !dit("DOUBLON_GEOMETRIE_STRICT", "qd-d6"));

      // ---- details mesures, gravites, seuils ----
      const entite = (code: CodeAnomalie, id: string) => national.parCode.find((c) => c.code === code)?.entites.find((e) => e.entiteId === id);
      const l2 = entite("LONGUEUR_ECART_GEOMETRIE", "qd-l2");
      const l2Vincenty = longueurLigneGeodesique(FIXTURES.find((f) => f.id === "qd-l2")!.geom as Pt[]) / 1000;
      const relPostgisVsVincenty = Math.abs(Number(l2?.details.longueurGeometriqueKm) - l2Vincenty) / l2Vincenty;
      console.log(`  (info) qd-l2 : longueur geometrique rendue ${l2?.details.longueurGeometriqueKm} km, Vincenty ${l2Vincenty.toFixed(4)} km, ecart relatif ${relPostgisVsVincenty.toExponential(2)}`);
      verifier("la longueur geometrique mesuree par le service egale Vincenty (JS pur) a 1e-4 pres", relPostgisVsVincenty < 1e-4, relPostgisVsVincenty);
      verifier("l'ecart relatif rendu egale (30 - geometrique) / geometrique", Math.abs(Number(l2?.details.ecartRelatif) - (30 - l2Vincenty) / l2Vincenty) < 1e-3, l2?.details);
      verifier("l'anomalie de longueur porte le seuil PROVISOIRE applique", l2?.seuil?.nom === "LONGUEUR_ECART_RELATIF" && l2.seuil.valeur === 0.1 && l2.seuil.statut === "PROVISOIRE", l2?.seuil);
      verifier("PK 0/0 : gravite A_TRAITER, details pkDebut/pkFin/longueurKm", (() => { const e = entite("PK_SENTINELLE_ZERO", "qd-p1"); return e?.gravite === "A_TRAITER" && e.details.pkDebut === 0 && e.details.pkFin === 0 && typeof e.details.longueurKm === "number"; })());
      verifier("fin < debut : gravite BLOQUANTE", entite("PK_FIN_INFERIEUR_DEBUT", "qd-p2")?.gravite === "BLOQUANTE");
      verifier("chevauchement : 2 km mesures, partenaire qd-p5a", (() => { const e = entite("PK_CHEVAUCHEMENT", "qd-p5b"); return e?.details.chevauchementKm === 2 && e.details.partenaireId === "qd-p5a"; })());
      verifier("trou : 4 km mesures, partenaire qd-p5b", (() => { const e = entite("PK_TROU", "qd-p5c"); return e?.details.trouKm === 4 && e.details.partenaireId === "qd-p5b"; })());
      verifier("geometrie invalide : la raison de PostGIS est restituee", /Too few points/.test(String(entite("GEOM_INVALIDE", "qd-g3a")?.details.raison)));
      verifier("region discordante nette : A_TRAITER, region dominante Qd Boke, part declaree 0", (() => { const e = entite("REGION_DISCORDANTE", "qd-r1"); return e?.gravite === "A_TRAITER" && e.details.regionDominante === "Qd Boke" && e.details.partDansRegionDeclaree === 0; })());
      verifier("region discordante a cheval (2/3 - 1/3) : A_SURVEILLER, part declaree ~ 1/3", (() => { const e = entite("REGION_DISCORDANTE", "qd-r2"); return e?.gravite === "A_SURVEILLER" && Math.abs(Number(e.details.partDansRegionDeclaree) - 1 / 3) < 0.01; })());
      verifier("hors territoire non documente : A_TRAITER ; documente (HORS_TERRITOIRE_NATIONAL) : A_SURVEILLER", entite("HORS_TERRITOIRE", "qd-r5")?.gravite === "A_TRAITER" && entite("HORS_TERRITOIRE", "qd-r6")?.gravite === "A_SURVEILLER");
      verifier("doublon strict inverse : sensInverse vrai ; doublon inter-regions : le partenaire est cite avec sa region", (() => {
        const inv = entite("DOUBLON_GEOMETRIE_STRICT", "qd-d4"); const x = entite("DOUBLON_GEOMETRIE_STRICT", "qd-d1");
        return inv?.details.sensInverse === true && JSON.stringify(x?.details.partenaires) === JSON.stringify(["qd-d2"]) && JSON.stringify(x?.details.partenairesRegions) === JSON.stringify([regionIds.B]);
      })());
      verifier("quasi-doublon : seuil PROVISOIRE rendu", entite("DOUBLON_GEOMETRIE_QUASI", "qd-d5")?.seuil?.nom === "DOUBLON_QUASI_TOLERANCE_DEG");

      // ---- agregats ----
      const attenduParCode = new Map<string, number>();
      for (const f of actives) for (const c of f.attendu) attenduParCode.set(c, (attenduParCode.get(c) ?? 0) + 1);
      const rendus = new Map(national.parCode.map((c) => [c.code, c.nombre]));
      verifier("compteurs par code = comptes du modele", [...attenduParCode].every(([c, n]) => rendus.get(c as CodeAnomalie) === n), { rendus: [...rendus], attendu: [...attenduParCode] });
      const attenduParRegion = new Map<number, number>();
      for (const f of actives) attenduParRegion.set(regionIds[f.region], (attenduParRegion.get(regionIds[f.region]) ?? 0) + f.attendu.length);
      verifier("compteurs par region = comptes du modele", [...attenduParRegion].every(([r, n]) => national.parRegion.find((x) => x.regionId === r)?.total === n),
        { rendus: national.parRegion.map((r) => [r.regionId, r.total]), attendu: [...attenduParRegion] });
      verifier("la population des troncons actifs est comptee (hors supprimes)", national.populationTronconsActifs === actives.length, national.populationTronconsActifs);
      verifier("aucun code n'est rendu pour un troncon hors fixtures", national.total === [...service].length, { total: national.total, fixtures: [...service].length });
      verifier("aucun avertissement sur une base saine", national.avertissements.length === 0, national.avertissements);
      verifier("le rapport dit ce qu'il ne couvre pas et liste les seuils provisoires", national.nonCouvert.length >= 8 && national.seuils.length === Object.keys(SEUILS_PROVISOIRES).length && national.seuils.every((s) => s.statut === "PROVISOIRE"));

      // ---- plafond de liste : le compte reste exact ----
      const petit = await lancerDetecteurs(tx, { ...base, plafondParCode: 1, portee: { regionId: null }, familles: ["ETAT", "PK"] });
      const nonEval = petit.parCode.find((c) => c.code === "ETAT_NON_EVALUE");
      verifier("plafond de 1 entite par code : liste tronquee, compte exact", nonEval?.entites.length === 1 && nonEval.tronque && nonEval.nombre === 2, nonEval && { n: nonEval.nombre, l: nonEval.entites.length });

      // ---- pagination : taille de lot 7 donne le meme resultat que 5000 ----
      const pagine = await lancerDetecteurs(tx, { ...base, portee: { regionId: null }, tailleLot: 7 });
      const sp = new Set<string>();
      for (const c of pagine.parCode) for (const e of c.entites) sp.add(`${c.code}|${e.entiteId}`);
      verifier("pagination par curseur (lots de 7) : meme resultat qu'en un lot", diff(sp, service).length === 0 && diff(service, sp).length === 0 && pagine.total === national.total);

      // ---- portee par region ----
      for (const reg of ["A", "B", "C", "N"] as Reg[]) {
        const rapport = await lancerDetecteurs(tx, { ...base, portee: { regionId: regionIds[reg] } });
        const s = new Set<string>();
        for (const c of rapport.parCode) for (const e of c.entites) s.add(`${c.code}|${e.entiteId}`);
        // modele : anomalies des troncons de la region, plus les chainages dont le partenaire est dans la region
        const attendu = new Set<string>();
        for (const f of actives) {
          for (const c of f.attendu) {
            if (regionIds[f.region] === regionIds[reg]) attendu.add(`${c}|${f.id}`);
            else if (c === "PK_CHEVAUCHEMENT" && f.id === "qd-p6b" && reg === "A") attendu.add(`${c}|${f.id}`);
          }
        }
        // les doublons : le partenaire peut etre hors region, l'entite examinee non
        verifier(`portee region ${reg} : exactement les anomalies attendues`, diff(s, attendu).length === 0 && diff(attendu, s).length === 0, { enTrop: diff(s, attendu), manquantes: diff(attendu, s) });
      }
      const regionA = await lancerDetecteurs(tx, { ...base, portee: { regionId: regionIds.A } });
      verifier("portee A : qd-d2 (region B) n'est pas examine, qd-d1 l'est avec son partenaire de B",
        !regionA.parCode.some((c) => c.entites.some((e) => e.entiteId === "qd-d2" && c.code.startsWith("DOUBLON")))
        && regionA.parCode.some((c) => c.entites.some((e) => e.entiteId === "qd-d1" && c.code === "DOUBLON_GEOMETRIE_STRICT")));
      const vide = await lancerDetecteurs(tx, { ...base, portee: { regionId: regionIds.A + 9999 } });
      verifier("une region sans troncon donne 0 anomalie et population 0", vide.total === 0 && vide.populationTronconsActifs === 0);

      // ---- limites de la structure (les deux codes impossibles par typage ne sont jamais rendus) ----
      verifier("les quatre codes impossibles par typage ou par enum ne sont rendus pour aucun troncon", ["GEOM_NON_LINEAIRE", "GEOM_SRID_INATTENDU", "ETAT_ABSENT", "ETAT_INCONNU"].every((c) => !rendus.has(c as CodeAnomalie)));

      // ---- le fichier de requetes remis a la DSI (lecture seule) donne les memes comptes que le modele ----
      const fichierDsi = readFileSync(join(__dirname, "../../docs/qualite/DETECTEURS-REQUETES-DSI.sql"), "utf8");
      const requetesDsi = fichierDsi.split("\n").filter((l) => !/^\s*--/.test(l) && !l.startsWith("\\")).join("\n")
        .split(/;\s*(?:\n|$)/).map((s) => s.trim())
        .filter((s) => s && !/^(BEGIN|SET LOCAL|ROLLBACK)\b/i.test(s))
        .map((s) => s.replace(/:region_id::int/g, "NULL::int"));
      verifier("le fichier DSI contient six requetes", requetesDsi.length === 6, requetesDsi.length);
      const lignesDsi: Record<string, unknown>[][] = [];
      for (const r of requetesDsi) lignesDsi.push(await tx.$queryRawUnsafe<Record<string, unknown>[]>(r));
      const nb = (x: unknown) => Number(x);
      const comptes = (code: string) => attenduParCode.get(code) ?? 0;
      const q1 = lignesDsi[0]?.[0] ?? {};
      verifier("requete DSI 1 : comptes simples = modele", nb(q1.troncons_actifs) === actives.length
        && nb(q1.pk_sentinelle_zero) === comptes("PK_SENTINELLE_ZERO") && nb(q1.pk_fin_inferieur_debut) === comptes("PK_FIN_INFERIEUR_DEBUT")
        && nb(q1.pk_absent) === comptes("PK_ABSENT") && nb(q1.pk_negatif) === comptes("PK_NEGATIF")
        && nb(q1.longueur_non_positive) === comptes("LONGUEUR_NON_POSITIVE") && nb(q1.geom_absente) === comptes("GEOM_ABSENTE") && nb(q1.geom_vide) === comptes("GEOM_VIDE")
        && nb(q1.etat_non_evalue) === comptes("ETAT_NON_EVALUE") && nb(q1.etat_date_sans_etat) === comptes("ETAT_DATE_SANS_ETAT")
        && nb(q1.etat_sans_date_evaluation) === comptes("ETAT_SANS_DATE_EVALUATION") && nb(q1.etat_date_future) === comptes("ETAT_DATE_FUTURE"), q1);
      verifier("requete DSI 2 : les PK 0/0 sont ventiles par famille de source", lignesDsi[1]?.length === 1 && nb(lignesDsi[1][0].n) === comptes("PK_SENTINELLE_ZERO"), lignesDsi[1]);
      const chaineModele = [...modele].filter((m) => m.startsWith("PK_CHEVAUCHEMENT|") || m.startsWith("PK_TROU|")).map((m) => m.replace("|qd-", "|QD-").toUpperCase()).sort();
      const chaineDsi = (lignesDsi[2] ?? []).map((r) => `${r.code}|${r.troncon}`).sort();
      verifier("requete DSI 3 : chevauchements et trous de PK = modele", JSON.stringify(chaineDsi) === JSON.stringify(chaineModele), { chaineDsi, chaineModele });
      verifier("requete DSI 4 : ecarts de longueur = modele", nb(lignesDsi[3]?.[0]?.longueur_ecart_geometrie) === comptes("LONGUEUR_ECART_GEOMETRIE"), lignesDsi[3]);
      verifier("requete DSI 5 : geometries invalides et de longueur nulle = modele", nb(lignesDsi[4]?.[0]?.geom_invalide) === comptes("GEOM_INVALIDE") && nb(lignesDsi[4]?.[0]?.geom_longueur_nulle) === comptes("GEOM_LONGUEUR_NULLE"), lignesDsi[4]);
      verifier("requete DSI 6 : doublons binaires stricts (un groupe qd-d1 / qd-d2 ; l'inverse et le quasi ne sont vus que par la route)", nb(lignesDsi[5]?.[0]?.groupes) === 1 && nb(lignesDsi[5]?.[0]?.troncons_en_trop) === 1, lignesDsi[5]);

      // ---- contre-epreuves ----
      // La transaction est en lecture seule : les contre-epreuves ne modifient rien, elles changent un SEUIL.
      const strict = await lancerDetecteurs(tx, { ...base, portee: { regionId: null }, seuils: { LONGUEUR_ECART_RELATIF: 0.01, LONGUEUR_ECART_ABSOLU_MIN_KM: 0.001 }, familles: ["LONGUEUR"] });
      const ss = new Set<string>();
      for (const c of strict.parCode) for (const e of c.entites) ss.add(`${c.code}|${e.entiteId}`);
      verifier("contre-epreuve : un seuil de longueur resserre signale qd-l3 (5 %) et s'ecarte alors de l'oracle", ss.has("LONGUEUR_ECART_GEOMETRIE|qd-l3") && diff(ss, oracle).length > 0, [...ss]);
      const large = await lancerDetecteurs(tx, { ...base, portee: { regionId: null }, seuils: { PK_TROU_KM: 10, PK_CHEVAUCHEMENT_KM: 5 }, familles: ["PK"] });
      verifier("contre-epreuve : des seuils de PK elargis ne signalent plus le chevauchement ni le trou", !large.parCode.some((c) => c.code === "PK_CHEVAUCHEMENT" || c.code === "PK_TROU"));

      throw ROLLBACK;
    }, { timeout: 180_000, maxWait: 30_000 });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // ---- la forme READ ONLY de production, sur les donnees validees de replay (vides en principe) ----
  let lectureSeule = "", ecritureRefusee = false;
  const espion = {
    $transaction: (fn: (tx: Tx) => Promise<unknown>, opts: { timeout: number; maxWait: number }) =>
      prisma.$transaction(async (tx) => {
        const r = await fn(tx);
        lectureSeule = (await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>(`SHOW transaction_read_only`))[0].transaction_read_only;
        await tx.$executeRawUnsafe(`SAVEPOINT s`);
        try { await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Qd ne-doit-pas-exister')`); }
        catch (e) { ecritureRefusee = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)); }
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT s`);
        return r;
      }, opts),
  };
  const enProd = await lancerEnLectureSeule(espion as never, { portee: { regionId: null }, plafondParCode: 5 });
  verifier("lancerEnLectureSeule : la transaction est READ ONLY et la base refuse l'ecriture", lectureSeule === "on" && ecritureRefusee, { lectureSeule, ecritureRefusee });
  verifier("lancerEnLectureSeule : rend un rapport complet", Array.isArray(enProd.parCode) && enProd.nonCouvert.length > 0);

  // ---- rien ne reste apres l'annulation ----
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT (SELECT count(*) FROM troncons WHERE id LIKE 'qd-%') + (SELECT count(*) FROM regions WHERE nom LIKE 'Qd %')
          + (SELECT count(*) FROM limites_admin WHERE pcode LIKE 'QD-%') AS n`);
  verifier("fixtures restantes apres annulation : 0", String(n) === "0", String(n));

  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
