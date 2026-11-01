/**
 * Consultation des releves en roulage : la LECTURE de ce que `session.service.ts` ecrit.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * Un releve envoye par `POST /v2/sync/push` (entityType `SessionRoulage`) etait enregistre dans quatre
 * tables (`sessions_roulage`, `marqueurs_roulage`, `evenements_roulage`, `evenements_roulage_portions`) que
 * rien ne relisait : l'agent avait envoye, le serveur avait accepte, et le releve restait invisible. Ce
 * fichier est le cote serveur de la consultation (liste, detail). Il n'ecrit RIEN.
 *
 * REGLES TENUES ICI
 *
 *  - Visibilite : `consultation.noyau.ts` (`porteeDe`). Elle est appliquee DANS la requete SQL (clause
 *    `WHERE`), jamais apres coup en memoire : un releve hors portee n'est ni compte, ni charge, ni
 *    distinguable d'un releve inexistant (le `total` d'une liste n'est donc pas un oracle).
 *  - Un releve supprime logiquement (`deletedAt`) n'existe pour personne, ADMIN compris.
 *  - SQL parametre : `Prisma.sql` et `$queryRaw`, aucune valeur concatenee. `geom` est une colonne
 *    `Unsupported` pour Prisma : tout passe par SQL brut.
 *  - La trace brute (`points`, JSON volumineux) n'est lue que sur demande (`avecPoints`), et bornee.
 *  - `analyse`, `compteurs`, `trous`, `interruptions`, `pauses`, `parametres` sont rendus TELS QU'ILS SONT
 *    ECRITS : ce service ne les reinterprete pas (les seuils sont provisoires, voir `session.service.ts`).
 *
 * CE QUE LES LECTURES N'AUDITENT PAS : aucune ligne d'`audit_logs` n'est ecrite par une consultation (comme
 * les autres lectures de l'API). La creation du releve est, elle, auditee (`SessionRoulage`, CREATE).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { regionsVisibles } from "../territoire/territoire.lecture";
import {
  encoderCurseur, POINTS_MAX_REPONSE, porteeDe, roleALePerimetre, SOMMETS_MAX_AFFICHAGE, TOLERANCES_SIMPLIFICATION, versMultiLigne,
  type GeoJsonMultiLigne, type ParametresListe, type Portee,
} from "./consultation.noyau";

type Depot = Pick<typeof prisma, "$queryRaw">;

export interface ResumeSession {
  id: string;
  debutA: string;
  finA: string;
  dureeS: number;
  nbPoints: number;
  nbMarqueurs: number;
  nbEvenements: number;
  tauxRattachement: number | null;
  longueurM: number | null;
  missionId: string | null;
  agent: { id: string; nom: string };
  nbTronconsTraverses: number;
  creeLe: string;
}

export interface ReponseListe { items: ResumeSession[]; suivant: string | null; total: number }

export interface MarqueurConsulte {
  id: string;
  code: string;
  note: string | null;
  poseA: string;
  lat: number | null;
  lon: number | null;
  /** D'ou vient la position : la trace interpolee a l'instant de pose, ou la position brute de l'appareil. */
  sourcePosition: "TRACE" | "APPAREIL" | null;
  precisionM: number | null;
  positionPerimee: boolean;
  statut: string;
  motif: string | null;
  tronconId: string | null;
  tronconCode: string | null;
  abscisseM: number | null;
}

export interface PortionConsultee {
  rang: number;
  portionId: string;
  tronconId: string;
  tronconCode: string;
  tronconNom: string;
  debutM: number;
  finM: number;
  sens: string;
}

export interface EvenementConsulte {
  id: string;
  code: string;
  note: string | null;
  statutAppareil: string;
  qualification: unknown;
  debutA: string;
  finA: string | null;
  statutRattachement: string;
  motif: string | null;
  portions: PortionConsultee[];
}

export interface DetailSession extends ResumeSession {
  geometrie: GeoJsonMultiLigne | null;
  /** `true` si la geometrie a ete simplifiee pour l'affichage (la trace brute reste intacte en base). */
  simplifiee: boolean;
  marqueurs: MarqueurConsulte[];
  evenements: EvenementConsulte[];
  analyse: { compteurs: unknown; trous: unknown; interruptions: unknown; pauses: unknown; serveur: unknown };
  parametres: { provenance: string; versionContrat: number; seuils: unknown };
  trace: {
    nbPoints: number;
    pointsDisponibles: boolean;
    /** Presents seulement avec `avecPoints`. Forme compacte du contrat : [tMs, lat, lon, precisionM, vitesseMs, segment]. */
    points?: unknown[];
    tronque?: boolean;
  };
}

// ------------------------------------------------------------------ portee

/** Portee du compte. Le perimetre regional n'est relu en base que pour un GESTIONNAIRE (les autres voient les leurs). */
export async function porteeDuCompte(compte: { id: string; role: string }): Promise<Portee> {
  const regions = roleALePerimetre(compte.role) ? await regionsVisibles(compte) : null;
  return porteeDe(compte, regions);
}

/**
 * Fragment de visibilite d'un releve `s`. Le commentaire SQL nomme la portee : il apparait dans les journaux
 * de la base et permet aux tests des routes de verifier la forme de la clause sans la reinterpreter.
 */
function visibilite(p: Portee): Prisma.Sql {
  switch (p.type) {
    case "tous":
      return Prisma.sql`/* portee:tous */ TRUE`;
    case "siens":
      return Prisma.sql`/* portee:siens */ s."userId" = ${p.userId}`;
    case "regions":
      // Un nombre part en TEXTE puis est converti cote SQL (Prisma type un tableau de nombres d'apres son premier element).
      return Prisma.sql`/* portee:regions */ (s."userId" = ${p.userId} OR EXISTS (
        SELECT 1 FROM "evenements_roulage_portions" lp
          JOIN "troncons" t ON t."id" = lp."tronconId"
         WHERE lp."sessionId" = s."id" AND t."regionId" = ANY(${p.regions.map(String)}::text[]::int[])))`;
  }
}

// ------------------------------------------------------------------ resume

/**
 * Colonnes du resume, communes a la liste et au detail. Les comptes sont des sous-requetes correlees qui
 * s'appuient sur la cle primaire de chaque table (`sessionId` en tete).
 *
 * `nbTronconsTraverses` = troncons DISTINCTS auxquels le releve se rattache : ceux d'une portion creee
 * et ceux d'un marqueur rattache. C'est ce que le serveur a conserve de la traversee (l'analyse n'enregistre
 * pas la liste des troncons de la trace, seulement des compteurs).
 *
 * `longueurM` : la distance parcourue telle que l'ANALYSE SERVEUR l'a calculee a l'ecriture et conservee
 * (`analyse.indicateurs.distanceParcourueM` : somme, segment par segment, des distances entre points retenus,
 * arrondie au metre). Elle est LUE, pas recalculee : `ST_Length` sur la geometrie coute de 100 a 200 ms par
 * session de 25 000 points (mesure du 26/10/2026, poste de developpement), soit 15 a 19 s pour une page de 100
 * releves ; la lecture de `geom` seule (decompression) en coute deja la moitie. Ce n'est donc PAS la longueur
 * de la polyligne dessinee (celle-ci est plus longue du bruit GNSS que le nettoyage retire). `null` si
 * l'indicateur manque.
 */
const COLONNES_RESUME = Prisma.sql`
  s."id", s."debutA", s."finA",
  GREATEST(0, round(EXTRACT(EPOCH FROM (s."finA" - s."debutA"))))::int AS "dureeS",
  s."nbPoints",
  (SELECT count(*) FROM "marqueurs_roulage" m WHERE m."sessionId" = s."id")::int AS "nbMarqueurs",
  (SELECT count(*) FROM "evenements_roulage" e WHERE e."sessionId" = s."id")::int AS "nbEvenements",
  s."tauxRattachement",
  CASE WHEN jsonb_typeof(s."analyse" #> '{indicateurs,distanceParcourueM}') = 'number'
       THEN (s."analyse" #>> '{indicateurs,distanceParcourueM}')::float8 END AS "longueurM",
  s."missionId", s."userId", u."nomComplet" AS "agentNom",
  (SELECT count(DISTINCT x."tronconId") FROM (
     SELECT lp."tronconId" FROM "evenements_roulage_portions" lp WHERE lp."sessionId" = s."id"
     UNION ALL
     SELECT m2."tronconId" FROM "marqueurs_roulage" m2 WHERE m2."sessionId" = s."id" AND m2."statut" = 'RATTACHE'
  ) x)::int AS "nbTronconsTraverses",
  s."createdAt"`;

interface LigneResume {
  id: string; debutA: Date; finA: Date; dureeS: number; nbPoints: number; nbMarqueurs: number; nbEvenements: number;
  tauxRattachement: number | null; longueurM: number | null; missionId: string | null; userId: string; agentNom: string;
  nbTronconsTraverses: number; createdAt: Date;
}

const iso = (d: Date): string => d.toISOString();
const nombreOuNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function versResume(l: LigneResume): ResumeSession {
  return {
    id: l.id,
    debutA: iso(l.debutA),
    finA: iso(l.finA),
    dureeS: Number(l.dureeS),
    nbPoints: Number(l.nbPoints),
    nbMarqueurs: Number(l.nbMarqueurs),
    nbEvenements: Number(l.nbEvenements),
    tauxRattachement: nombreOuNull(l.tauxRattachement),
    longueurM: nombreOuNull(l.longueurM),
    missionId: l.missionId ?? null,
    // Nom seulement : ni adresse e-mail ni aucun autre champ du compte.
    agent: { id: l.userId, nom: l.agentNom },
    nbTronconsTraverses: Number(l.nbTronconsTraverses),
    creeLe: iso(l.createdAt),
  };
}

// ------------------------------------------------------------------ liste

/**
 * Liste paginee par curseur, triee par `debutA` decroissant puis `id` croissant. `total` compte tous les releves
 * visibles qui satisfont les filtres, curseur exclu (il ne varie pas d'une page a l'autre).
 */
export async function listerSessions(portee: Portee, p: ParametresListe, depot: Depot = prisma): Promise<ReponseListe> {
  const filtres: Prisma.Sql[] = [Prisma.sql`s."deletedAt" IS NULL`, visibilite(portee)];
  if (p.userId !== null) filtres.push(Prisma.sql`s."userId" = ${p.userId}`);
  if (p.depuis !== null) filtres.push(Prisma.sql`s."debutA" >= (${p.depuis}::timestamptz AT TIME ZONE 'UTC')`);
  if (p.avant !== null) filtres.push(Prisma.sql`s."debutA" < (${p.avant}::timestamptz AT TIME ZONE 'UTC')`);
  const whereTotal = Prisma.join(filtres, " AND ");

  const filtresPage = [...filtres];
  if (p.curseur !== null) {
    // Ordre (debutA DESC, id ASC) : la suite d'une ligne est « plus ancienne » ou « meme instant et id plus grand ».
    filtresPage.push(Prisma.sql`(s."debutA" < (${p.curseur.debutA}::timestamptz AT TIME ZONE 'UTC')
      OR (s."debutA" = (${p.curseur.debutA}::timestamptz AT TIME ZONE 'UTC') AND s."id" > ${p.curseur.id}))`);
  }

  const lignes = await depot.$queryRaw<LigneResume[]>(Prisma.sql`
    SELECT ${COLONNES_RESUME}
      FROM "sessions_roulage" s
      JOIN "users" u ON u."id" = s."userId"
     WHERE ${Prisma.join(filtresPage, " AND ")}
     ORDER BY s."debutA" DESC, s."id" ASC
     LIMIT ${p.limite + 1}`);
  const [{ n }] = await depot.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS "n" FROM "sessions_roulage" s WHERE ${whereTotal}`);

  const page = lignes.slice(0, p.limite);
  const dernier = page[page.length - 1];
  return {
    items: page.map(versResume),
    suivant: lignes.length > p.limite && dernier ? encoderCurseur({ debutA: iso(dernier.debutA), id: dernier.id }) : null,
    total: Number(n),
  };
}

// ------------------------------------------------------------------ detail

/** Le releve existe-t-il, n'est-il pas supprime, et le compte a-t-il le droit de le voir ? Rien d'autre n'est lu. */
export async function sessionVisible(id: string, portee: Portee, depot: Depot = prisma): Promise<boolean> {
  const l = await depot.$queryRaw<{ ok: number }[]>(Prisma.sql`
    SELECT 1 AS "ok" FROM "sessions_roulage" s WHERE s."id" = ${id} AND s."deletedAt" IS NULL AND ${visibilite(portee)} LIMIT 1`);
  return l.length > 0;
}

interface LigneDetail extends LigneResume {
  versionContrat: number; provenanceParametres: string; parametres: unknown; compteurs: unknown; trous: unknown;
  interruptions: unknown; pauses: unknown; analyse: unknown; pointsDisponibles: boolean; nbSommets: number;
}

interface LigneMarqueur {
  id: string; code: string; note: string | null; poseA: Date; lat: number | null; lon: number | null;
  sourcePosition: "TRACE" | "APPAREIL" | null; precisionM: number | null; positionPerimee: boolean; statut: string; motif: string | null;
  tronconId: string | null; tronconCode: string | null; abscisseM: number | null;
}
interface LigneEvenement {
  id: string; code: string; note: string | null; statutAppareil: string; qualification: unknown; debutA: Date; finA: Date | null;
  statutRattachement: string; motif: string | null;
}
interface LignePortion {
  evenementId: string; rang: number; portionId: string; tronconId: string; tronconCode: string; tronconNom: string;
  debutM: number; finM: number; sens: string;
}

/**
 * Geometrie pour l'affichage. Jusqu'a `SOMMETS_MAX_AFFICHAGE` sommets, elle est rendue telle quelle (precision
 * 6 decimales, environ 0,1 m). Au-dela, on simplifie (Douglas-Peucker : aucun sommet de la trace n'est a plus de
 * `tolerance` de la ligne rendue) avec la plus fine des tolerances qui ramene sous le plafond : le client dessine
 * moins de points, la base garde la trace entiere. `ST_Simplify` et non `ST_SimplifyPreserveTopology` : une trace
 * GNSS se recoupe naturellement (rond-point, aller-retour), preserver une topologie n'a pas de sens ici, et cette
 * variante est de 2 a 10 fois plus rapide sur 25 000 points (mesure du 26/10/2026, poste de developpement).
 * `true` : une partie qui s'effondrerait sur elle-meme est gardee (deux sommets), pas supprimee.
 */
async function geometrieAffichage(depot: Depot, id: string, nbSommets: number): Promise<{ geometrie: GeoJsonMultiLigne | null; simplifiee: boolean }> {
  if (nbSommets === 0) return { geometrie: null, simplifiee: false };
  if (nbSommets <= SOMMETS_MAX_AFFICHAGE) {
    const [l] = await depot.$queryRaw<{ g: string | null }[]>(Prisma.sql`
      SELECT ST_AsGeoJSON(s."geom", 6::int) AS "g" FROM "sessions_roulage" s WHERE s."id" = ${id}`);
    return { geometrie: versMultiLigne(l?.g ?? null), simplifiee: false };
  }
  let dernier: { geometrie: GeoJsonMultiLigne | null; simplifiee: boolean } = { geometrie: null, simplifiee: true };
  for (const tolerance of TOLERANCES_SIMPLIFICATION) {
    const [l] = await depot.$queryRaw<{ n: number; g: string | null }[]>(Prisma.sql`
      SELECT ST_NPoints(q."g")::int AS "n", ST_AsGeoJSON(q."g", 6::int) AS "g"
        FROM (SELECT ST_Simplify(s."geom", ${tolerance}::float8, true) AS "g" FROM "sessions_roulage" s WHERE s."id" = ${id}) q`);
    dernier = { geometrie: versMultiLigne(l?.g ?? null), simplifiee: true };
    if (l && Number(l.n) <= SOMMETS_MAX_AFFICHAGE) break;
  }
  return dernier;
}

/**
 * Detail d'un releve visible, `null` s'il n'existe pas, est supprime ou hors portee (la route repond alors le MEME
 * 404 dans les trois cas). Les `points` bruts ne sont lus que si `avecPoints`.
 */
export async function chargerSession(id: string, portee: Portee, opts: { avecPoints: boolean }, depot: Depot = prisma): Promise<DetailSession | null> {
  const [ligne] = await depot.$queryRaw<LigneDetail[]>(Prisma.sql`
    SELECT ${COLONNES_RESUME},
           s."versionContrat", s."provenanceParametres", s."parametres", s."compteurs", s."trous", s."interruptions", s."pauses", s."analyse",
           (jsonb_typeof(s."points") = 'array' AND jsonb_array_length(s."points") > 0) AS "pointsDisponibles",
           CASE WHEN s."geom" IS NULL THEN 0 ELSE ST_NPoints(s."geom") END::int AS "nbSommets"
      FROM "sessions_roulage" s
      JOIN "users" u ON u."id" = s."userId"
     WHERE s."id" = ${id} AND s."deletedAt" IS NULL AND ${visibilite(portee)}`);
  if (!ligne) return null;

  const [marqueurs, evenements, portions, geo] = await Promise.all([
    depot.$queryRaw<LigneMarqueur[]>(Prisma.sql`
      SELECT m."id", m."code", m."note", m."poseA",
             COALESCE(m."positionTraceLat", m."lat") AS "lat", COALESCE(m."positionTraceLon", m."lon") AS "lon",
             CASE WHEN m."positionTraceLat" IS NOT NULL THEN 'TRACE' WHEN m."lat" IS NOT NULL THEN 'APPAREIL' END AS "sourcePosition",
             m."precisionM", m."positionPerimee", m."statut", m."motif", m."tronconId", t."code" AS "tronconCode", m."abscisseM"
        FROM "marqueurs_roulage" m
        LEFT JOIN "troncons" t ON t."id" = m."tronconId"
       WHERE m."sessionId" = ${id}
       ORDER BY m."poseA", m."id"`),
    depot.$queryRaw<LigneEvenement[]>(Prisma.sql`
      SELECT e."id", e."code", e."note", e."statutAppareil", e."qualification", e."debutA", e."finA", e."statutRattachement", e."motif"
        FROM "evenements_roulage" e
       WHERE e."sessionId" = ${id}
       ORDER BY e."debutA", e."id"`),
    depot.$queryRaw<LignePortion[]>(Prisma.sql`
      SELECT lp."evenementId", lp."rang", lp."portionId", lp."tronconId", t."code" AS "tronconCode", t."nom" AS "tronconNom",
             lp."debutM", lp."finM", lp."sens"
        FROM "evenements_roulage_portions" lp
        JOIN "troncons" t ON t."id" = lp."tronconId"
       WHERE lp."sessionId" = ${id}
       ORDER BY lp."evenementId", lp."rang"`),
    geometrieAffichage(depot, id, Number(ligne.nbSommets)),
  ]);

  const portionsParEvenement = new Map<string, PortionConsultee[]>();
  for (const p of portions) {
    const liste = portionsParEvenement.get(p.evenementId) ?? [];
    liste.push({
      rang: Number(p.rang), portionId: p.portionId, tronconId: p.tronconId, tronconCode: p.tronconCode, tronconNom: p.tronconNom,
      debutM: Number(p.debutM), finM: Number(p.finM), sens: p.sens,
    });
    portionsParEvenement.set(p.evenementId, liste);
  }

  const trace: DetailSession["trace"] = { nbPoints: Number(ligne.nbPoints), pointsDisponibles: Boolean(ligne.pointsDisponibles) };
  if (opts.avecPoints && trace.pointsDisponibles) {
    // Les premiers points seulement : la trace est chronologique, la fin tronquee est dite par `tronque`.
    // Rendu en TEXTE puis relu ici : le moteur de Prisma est bien plus lent a convertir un gros jsonb que JSON.parse.
    const [l] = await depot.$queryRaw<{ points: string | null }[]>(Prisma.sql`
      SELECT jsonb_path_query_array(s."points", '$[0 to $dernier]', jsonb_build_object('dernier', ${POINTS_MAX_REPONSE - 1}::int))::text AS "points"
        FROM "sessions_roulage" s WHERE s."id" = ${id}`);
    trace.points = l?.points ? (JSON.parse(l.points) as unknown[]) : [];
    trace.tronque = trace.nbPoints > POINTS_MAX_REPONSE;
  }

  return {
    ...versResume(ligne),
    geometrie: geo.geometrie,
    simplifiee: geo.simplifiee,
    marqueurs: marqueurs.map((m) => ({
      id: m.id, code: m.code, note: m.note, poseA: iso(m.poseA), lat: nombreOuNull(m.lat), lon: nombreOuNull(m.lon),
      sourcePosition: m.sourcePosition ?? null, precisionM: nombreOuNull(m.precisionM), positionPerimee: Boolean(m.positionPerimee),
      statut: m.statut, motif: m.motif ?? null, tronconId: m.tronconId ?? null, tronconCode: m.tronconCode ?? null, abscisseM: nombreOuNull(m.abscisseM),
    })),
    evenements: evenements.map((e) => ({
      id: e.id, code: e.code, note: e.note, statutAppareil: e.statutAppareil, qualification: e.qualification ?? null,
      debutA: iso(e.debutA), finA: e.finA ? iso(e.finA) : null, statutRattachement: e.statutRattachement, motif: e.motif ?? null,
      portions: portionsParEvenement.get(e.id) ?? [],
    })),
    analyse: { compteurs: ligne.compteurs, trous: ligne.trous, interruptions: ligne.interruptions, pauses: ligne.pauses, serveur: ligne.analyse },
    parametres: { provenance: ligne.provenanceParametres, versionContrat: Number(ligne.versionContrat), seuils: ligne.parametres },
    trace,
  };
}
