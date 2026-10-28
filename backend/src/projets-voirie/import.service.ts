/**
 * DEPOT D'UN FICHIER dans un projet (KML ou GeoJSON) : lecture, controles, quarantaine, simulation, versions, delta.
 *
 * UN LOT RECU N'EST PAS UN LOT IMPORTE. Un depot reel cree un jeu `CONTROLE` : la lecture, les controles et les statistiques sont
 * deja faits, mais le jeu n'entre dans l'analyse qu'une fois `AUTORISE` (voir `projets.service.ts#decider`).
 *
 * SIMULATION (`simuler: true`) : le depot COMPLET s'execute dans une transaction qui est ensuite ANNULEE. C'est exactement le chemin du
 * depot reel (memes controles, memes reparations PostGIS, memes mesures, meme delta) : le resume de la simulation ne peut pas
 * differer du resultat. Rien n'est conserve (ni jeu, ni objet, ni audit) ; seules des valeurs de sequence sont consommees.
 *
 * REMPLACEMENT : une nouvelle version (meme projet, role, concessionnaire, contenu different) arrive `CONTROLE` avec `remplaceId` =
 * le jeu `AUTORISE` courant. L'ancien reste `AUTORISE` jusqu'a l'autorisation du nouveau. Le `delta` est informatif.
 *
 * Aucune ecriture hors de `projets_voirie_jeux`, `projets_voirie_objets` et `audit_logs`.
 */

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { Limiteur } from "../import/limiteur";
import { logAuditTransactionnelle } from "../utils/audit";
import { calculerDelta, type Delta } from "./delta.noyau";
import { ErreurMetier, introuvable } from "./erreurs";
import { lireFichier } from "./lecture.noyau";
import type { Avertissement, ObjetLu, ResultatLecture, TypeGeom } from "./lecture.types";
import { verrouillerProjet, type Acteur, type Tx } from "./projets.service";
import { INCLURE_JEU, vueJeu } from "./vues";

export type Role = "AXES_TRAVAUX" | "RESEAU_TIERS" | "LIMITES_ROUTE" | "AUTRE";
export type Nature = "ACTIF_PHYSIQUE" | "CIRCUIT_LOGIQUE" | "EQUIPEMENT" | "AXE" | "EMPRISE" | "INCONNUE";
export type Niveau = "PUBLIC" | "INTERNE" | "RESTREINT_PROJET" | "CONFIDENTIEL_CONCESSIONNAIRE" | "INFRASTRUCTURE_SENSIBLE";
export type Classe = "A" | "B" | "C" | "D" | "E";
export type TypeReseau = "TELECOM" | "EAU_POTABLE" | "ELECTRICITE" | "ASSAINISSEMENT" | "GAZ_HYDROCARBURES" | "AUTRE";

export interface ChampsDepot {
  role: Role;
  concessionnaireId?: string;
  typeReseau?: TypeReseau;
  dateDonnees?: string;
  origineFichier?: string;
  confidentialite?: Niveau;
  natureObjets?: Nature;
  classePrecision?: Classe;
  precisionHorizontaleM?: number;
  precisionVerticaleM?: number;
  methode?: string;
  dateConstat?: string;
}

export interface DemandeDepot {
  acteur: Acteur;
  projetId: string;
  fichier: Buffer;
  nomFichier: string;
  champs: ChampsDepot;
  simuler: boolean;
}

/** Au plus deux depots simultanes par processus : un depot garde une connexion de la base pendant toute sa transaction. */
export const limiteurDepots = new Limiteur(2, 15_000);

const TAILLE_LOT_INSERTION = 500;
const DELAI_TRANSACTION_MS = 180_000;

class SimulationTerminee extends Error {
  constructor(public readonly resultat: unknown) { super("simulation terminee"); }
}

export const confidentialiteParDefaut = (role: Role): Niveau => (role === "RESEAU_TIERS" ? "CONFIDENTIEL_CONCESSIONNAIRE" : "RESTREINT_PROJET");

/** Nature imposee par le role, ou celle demandee (jamais AXE ou EMPRISE pour un reseau). */
export function natureEffective(role: Role, demandee: Nature | undefined): Nature {
  if (role === "AXES_TRAVAUX") {
    if (demandee && demandee !== "AXE") throw new ErreurMetier(400, "NATURE_INCOMPATIBLE", "Un plan d'axes a pour nature « AXE ».");
    return "AXE";
  }
  if (role === "LIMITES_ROUTE") {
    if (demandee && demandee !== "EMPRISE") throw new ErreurMetier(400, "NATURE_INCOMPATIBLE", "Des limites de route ont pour nature « EMPRISE ».");
    return "EMPRISE";
  }
  if (demandee === "AXE" || demandee === "EMPRISE") throw new ErreurMetier(400, "NATURE_INCOMPATIBLE", `La nature « ${demandee} » est réservée aux plans d'axes et aux limites de route.`);
  return demandee ?? "INCONNUE";
}

const CODE_TYPE: Record<TypeGeom, number> = { POINT: 1, LIGNE: 2, POLYGONE: 3 };

interface BilanInsertion { inseres: number; reparees: number; vides: number }

/**
 * Insere les objets par lots. La geometrie lue (GeoJSON 2D) est REPAREE par `ST_MakeValid` si PostGIS la juge invalide (anneau qui se
 * croise...), puis ramenee au type attendu (`ST_CollectionExtract`) ; un objet qui devient vide est ecarte et compte.
 */
async function insererObjets(tx: Tx, jeuId: string, objets: readonly ObjetLu[]): Promise<BilanInsertion> {
  const bilan: BilanInsertion = { inseres: 0, reparees: 0, vides: 0 };
  for (let i = 0; i < objets.length; i += TAILLE_LOT_INSERTION) {
    const lot = objets.slice(i, i + TAILLE_LOT_INSERTION);
    const ordres = lot.map((o) => o.ordre);
    const noms = lot.map((o) => o.nom ?? "");
    const types = lot.map((o) => o.typeGeom as string);
    const codes = lot.map((o) => CODE_TYPE[o.typeGeom]);
    const geojsons = lot.map((o) => JSON.stringify(o.geometrie));
    const attributs = lot.map((o) => JSON.stringify(o.attributs));
    const empreintes = lot.map((o) => o.empreinte);
    const r = await tx.$queryRaw<{ inseres: number; reparees: number; vides: number }[]>`
      WITH src AS (
        SELECT t."ordre", NULLIF(t."nom", '') AS "nom", t."tg"::"TypeGeomObjet" AS "tg", t."code", t."attr"::jsonb AS "attributs", t."empreinte",
               ST_SetSRID(ST_GeomFromGeoJSON(t."gj"), 4326) AS "brute"
          FROM unnest(${ordres}::int[], ${noms}::text[], ${types}::text[], ${codes}::int[], ${geojsons}::text[], ${attributs}::text[], ${empreintes}::text[])
               AS t("ordre", "nom", "tg", "code", "gj", "attr", "empreinte")),
      prep AS (
        SELECT s.*, NOT ST_IsValid(s."brute") AS "reparee",
               CASE WHEN ST_IsValid(s."brute") THEN s."brute" ELSE ST_CollectionExtract(ST_MakeValid(s."brute"), s."code") END AS "g"
          FROM src s),
      ins AS (
        INSERT INTO "projets_voirie_objets" ("jeuId", "nom", "typeGeom", "geom", "longueurM", "attributs", "empreinte", "ordre")
        SELECT ${jeuId}, p."nom", p."tg", p."g", CASE WHEN p."tg" = 'LIGNE' THEN ST_Length(p."g"::geography) END, p."attributs", p."empreinte", p."ordre"
          FROM prep p WHERE NOT ST_IsEmpty(p."g")
        RETURNING 1)
      SELECT (SELECT count(*) FROM ins)::int AS "inseres",
             (SELECT count(*) FROM prep WHERE "reparee")::int AS "reparees",
             (SELECT count(*) FROM prep WHERE ST_IsEmpty("g"))::int AS "vides"`;
    bilan.inseres += r[0].inseres;
    bilan.reparees += r[0].reparees;
    bilan.vides += r[0].vides;
  }
  return bilan;
}

/** Mesures du jeu depuis les objets conserves : nombre, somme des longueurs, longueur de l'union des tracés, repartition par type. */
async function mesurerJeu(tx: Tx, jeuId: string) {
  const m = await tx.$queryRaw<{ n: number; total: number; fusionne: number }[]>`
    SELECT count(*)::int AS "n",
           COALESCE(SUM("longueurM"), 0)::float8 AS "total",
           COALESCE((SELECT ST_Length(ST_UnaryUnion(ST_Collect("geom"))::geography)
                       FROM "projets_voirie_objets" WHERE "jeuId" = ${jeuId} AND "typeGeom" = 'LIGNE'), 0)::float8 AS "fusionne"
      FROM "projets_voirie_objets" WHERE "jeuId" = ${jeuId}`;
  const t = await tx.$queryRaw<{ tg: string; n: number }[]>`
    SELECT "typeGeom"::text AS "tg", count(*)::int AS "n" FROM "projets_voirie_objets" WHERE "jeuId" = ${jeuId} GROUP BY "typeGeom"`;
  const parTypeGeom: Record<TypeGeom, number> = { LIGNE: 0, POINT: 0, POLYGONE: 0 };
  for (const x of t) parTypeGeom[x.tg as TypeGeom] = x.n;
  return { nbObjets: m[0].n, longueurTotaleM: Number(m[0].total), longueurTraceFusionneM: Number(m[0].fusionne), parTypeGeom };
}

async function empreintesDe(tx: Tx, jeuId: string): Promise<Map<string, number>> {
  const l = await tx.$queryRaw<{ e: string; n: number }[]>`
    SELECT "empreinte" AS "e", count(*)::int AS "n" FROM "projets_voirie_objets" WHERE "jeuId" = ${jeuId} GROUP BY "empreinte"`;
  return new Map(l.map((x) => [x.e, x.n]));
}

function dateJour(s: string | undefined): Date | null {
  return s ? new Date(`${s}T00:00:00.000Z`) : null;
}

export interface ResultatDepot {
  simulation: boolean;
  jeu: ReturnType<typeof vueJeu>;
  resume: Record<string, unknown>;
  avertissements: Avertissement[];
  delta: Delta | null;
  remplace: { jeuId: string; version: number } | null;
}

export async function deposerJeu(d: DemandeDepot): Promise<ResultatDepot> {
  // Lecture AVANT toute connexion a la base : un fichier refuse ne consomme ni transaction ni place dans le limiteur.
  const lecture: ResultatLecture = lireFichier(d.fichier, d.nomFichier);
  const sha256 = createHash("sha256").update(d.fichier).digest("hex");
  const c = d.champs;
  const nature = natureEffective(c.role, c.natureObjets);
  if (c.role === "RESEAU_TIERS" && !c.concessionnaireId) throw new ErreurMetier(400, "CONCESSIONNAIRE_REQUIS", "Un réseau de concessionnaire exige le champ concessionnaireId.");
  if (c.role !== "RESEAU_TIERS" && (c.concessionnaireId || c.typeReseau)) {
    throw new ErreurMetier(400, "CHAMPS_INVALIDES", "concessionnaireId et typeReseau ne s'appliquent qu'au rôle RESEAU_TIERS.");
  }
  if (c.role === "AXES_TRAVAUX" && lecture.resume.parTypeGeom.LIGNE === 0) {
    throw new ErreurMetier(422, "GEOMETRIE_INVALIDE", "Un plan d'axes doit contenir des lignes : le fichier n'en contient aucune.");
  }

  try {
    return await limiteurDepots.executer(() =>
      prisma.$transaction((tx) => deposerDansTransaction(tx, d, lecture, sha256, nature), { timeout: DELAI_TRANSACTION_MS, maxWait: 30_000 }));
  } catch (e) {
    if (e instanceof SimulationTerminee) return e.resultat as ResultatDepot;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Course residuelle sur un index unique partiel (le verrou du projet les rend improbables).
      throw new ErreurMetier(409, "DEPOT_EN_ATTENTE", "Un dépôt équivalent vient d'être enregistré : relisez la liste des jeux.");
    }
    throw e;
  }
}

async function deposerDansTransaction(tx: Tx, d: DemandeDepot, lecture: ResultatLecture, sha256: string, nature: Nature): Promise<ResultatDepot> {
  const c = d.champs;
  await verrouillerProjet(tx, d.projetId);

  let typeReseau: TypeReseau | null = null;
  if (c.role === "RESEAU_TIERS") {
    const conc = await tx.concessionnaireReseau.findFirst({ where: { id: c.concessionnaireId, deletedAt: null } });
    if (!conc) throw introuvable("Concessionnaire", "CONCESSIONNAIRE_INTROUVABLE");
    typeReseau = c.typeReseau ?? conc.typeReseau;
  }
  const concId = c.role === "RESEAU_TIERS" ? c.concessionnaireId! : null;

  // Idempotence : le meme fichier ne se charge pas deux fois (aucun objet en double).
  const doublon = await tx.jeuDonneesProjet.findFirst({
    where: { projetId: d.projetId, sha256, statut: { in: ["RECU", "CONTROLE", "AUTORISE"] } }, select: { id: true, statut: true, version: true },
  });
  if (doublon) {
    throw new ErreurMetier(409, "JEU_DEJA_CHARGE", "Ce fichier est déjà chargé dans ce projet (même empreinte SHA-256).", { jeuId: doublon.id, statut: doublon.statut, version: doublon.version });
  }

  let version = 1;
  let remplace: { id: string; version: number } | null = null;
  if (c.role !== "AUTRE") {
    const cle = { projetId: d.projetId, role: c.role, concessionnaireId: concId };
    const attente = await tx.jeuDonneesProjet.findFirst({ where: { ...cle, statut: { in: ["RECU", "CONTROLE"] } }, select: { id: true, version: true } });
    if (attente) {
      throw new ErreurMetier(409, "DEPOT_EN_ATTENTE", "Un dépôt de même rôle et de même concessionnaire attend déjà son autorisation : autorisez-le, rejetez-le ou retirez-le d'abord.", { jeuId: attente.id, version: attente.version });
    }
    const courant = await tx.jeuDonneesProjet.findFirst({ where: { ...cle, statut: "AUTORISE" }, select: { id: true, version: true } });
    const max = await tx.jeuDonneesProjet.aggregate({ where: cle, _max: { version: true } });
    version = (max._max.version ?? 0) + 1;
    remplace = courant;
  }

  const id = randomUUID();
  await tx.jeuDonneesProjet.create({
    data: {
      id, projetId: d.projetId, role: c.role, concessionnaireId: concId, typeReseau,
      nomFichier: d.nomFichier.slice(0, 255), format: lecture.format, sha256, tailleOctets: d.fichier.length, nbObjets: 0,
      dateDonnees: dateJour(c.dateDonnees), origineFichier: c.origineFichier ?? null,
      classePrecision: c.classePrecision ?? null, precisionHorizontaleM: c.precisionHorizontaleM ?? null, precisionVerticaleM: c.precisionVerticaleM ?? null,
      methode: c.methode ?? null, dateConstat: dateJour(c.dateConstat), natureObjets: nature,
      confidentialite: c.confidentialite ?? confidentialiteParDefaut(c.role), statut: "CONTROLE", version, remplaceId: remplace?.id ?? null,
      creeParId: d.acteur.id,
    },
  });

  const bilan = await insererObjets(tx, id, lecture.objets);
  if (bilan.inseres === 0) throw new ErreurMetier(422, "GEOMETRIE_INVALIDE", "Aucune géométrie exploitable après contrôle par la base (toutes vides une fois réparées).");
  const mesures = await mesurerJeu(tx, id);

  const avertissements: Avertissement[] = [...lecture.avertissements];
  if (bilan.reparees > 0) avertissements.push({ code: "GEOMETRIES_REPAREES", message: "Géométries invalides réparées par la base (anneau qui se croise, par exemple).", nb: bilan.reparees });
  if (bilan.vides > 0) avertissements.push({ code: "GEOMETRIES_VIDES_IGNOREES", message: "Géométries devenues vides après réparation, ignorées.", nb: bilan.vides });

  let delta: Delta | null = null;
  if (remplace) delta = calculerDelta(lecture.objets.map((o) => o.empreinte), await empreintesDe(tx, remplace.id));

  const resume = {
    nbObjets: mesures.nbObjets,
    libelleNbObjets: "circuits ou objets du fichier",
    parTypeGeom: mesures.parTypeGeom,
    longueurTotaleM: Math.round(mesures.longueurTotaleM * 100) / 100,
    longueurTraceFusionneM: Math.round(mesures.longueurTraceFusionneM * 100) / 100,
    bbox: lecture.resume.bbox,
    attributsDetectes: lecture.resume.attributsDetectes,
    crs: lecture.crs,
    delta,
  };
  await tx.jeuDonneesProjet.update({
    where: { id },
    data: {
      nbObjets: mesures.nbObjets, longueurTotaleM: mesures.longueurTotaleM, longueurTraceFusionneM: mesures.longueurTraceFusionneM,
      avertissements: avertissements as unknown as Prisma.InputJsonValue, resume: resume as unknown as Prisma.InputJsonValue,
    },
  });

  const jeu = await tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id }, include: INCLURE_JEU });
  const resultat: ResultatDepot = {
    simulation: d.simuler,
    jeu: vueJeu(jeu, { sansId: d.simuler }),
    resume,
    avertissements,
    delta,
    remplace: remplace ? { jeuId: remplace.id, version: remplace.version } : null,
  };
  if (d.simuler) throw new SimulationTerminee(resultat);

  await logAuditTransactionnelle(tx, {
    userId: d.acteur.id, action: "CREATE", entityType: "JeuDonneesProjet", entityId: id,
    after: {
      projetId: d.projetId, role: c.role, concessionnaireId: concId, nomFichier: jeu.nomFichier, format: lecture.format, sha256,
      tailleOctets: d.fichier.length, nbObjets: mesures.nbObjets, longueurTraceFusionneM: mesures.longueurTraceFusionneM,
      version, statut: "CONTROLE", confidentialite: jeu.confidentialite, natureObjets: nature, classePrecision: c.classePrecision ?? null,
      origineFichier: c.origineFichier ?? null, remplaceId: remplace?.id ?? null, delta,
      avertissements: avertissements.map((a) => ({ code: a.code, nb: a.nb ?? null })),
    },
    ipAddress: d.acteur.ip,
  });
  return resultat;
}
