/**
 * DEPOT D'UN FICHIER dans un projet (KML, KMZ, GeoJSON, GPX, CSV) : lecture, controles, quarantaine, simulation, versions, delta.
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
import { avecErreurDelai } from "./bd";
import { delaiDepotMs } from "./config";
import { ErreurMetier, introuvable } from "./erreurs";
import { META_WGS84 } from "./formats/crs.noyau";
import { resoudreCrs, transformerSommets, versionProj } from "./formats/crs.service";
import { classerRaison, type Probleme } from "./formats/validation.noyau";
import { LISTE_MAX, limitesImport, modeConservationOriginal } from "./formats/import.config";
import { detecter, detecterConvertie, preparer, type OptionsImport, type Preparation, type ResultatImport } from "./formats/lecture-import.noyau";
import type { ConversionValidee } from "./gdal/conversion.noyau";
import { deltaEntreJeux, type DeltaJeux } from "./formats/versions.depot";
import type { PropositionJeu } from "./formats/mapping.noyau";
import type { Avertissement, ObjetLu, TypeGeom } from "./lecture.types";
import { verrouillerProjet, type Acteur, type Tx } from "./projets.service";
import { contexteSpatialDuProjet } from "./territoires/contexte-spatial";
import { resoudreTypeReseau } from "./territoires/referentiels.service";
import { INCLURE_JEU, vueJeu } from "./vues";
import { filtreCleVersion } from "./sources/cle-version.noyau";
import { insererConnexionsDeclarees } from "./reseaux/reseaux.depot";

export type Role = "AXES_TRAVAUX" | "RESEAU_TIERS" | "LIMITES_ROUTE" | "AUTRE";
export type Nature = "ACTIF_PHYSIQUE" | "CIRCUIT_LOGIQUE" | "EQUIPEMENT" | "AXE" | "EMPRISE" | "INCONNUE";
export type Niveau = "PUBLIC" | "INTERNE" | "RESTREINT_PROJET" | "CONFIDENTIEL_CONCESSIONNAIRE" | "INFRASTRUCTURE_SENSIBLE";
export type Classe = "A" | "B" | "C" | "D" | "E";
export type TypeReseau = "TELECOM" | "EAU_POTABLE" | "ELECTRICITE" | "ASSAINISSEMENT" | "GAZ_HYDROCARBURES" | "AUTRE";

export interface ChampsDepot {
  role: Role;
  concessionnaireId?: string;
  typeReseau?: TypeReseau;
  /** Lot T1 : code du referentiel TYPE_RESEAU ; la famille `typeReseau` en est derivee (repli sur la famille declaree sans code). */
  typeReseauCode?: string;
  dateDonnees?: string;
  origineFichier?: string;
  confidentialite?: Niveau;
  natureObjets?: Nature;
  classePrecision?: Classe;
  precisionHorizontaleM?: number;
  precisionVerticaleM?: number;
  methode?: string;
  dateConstat?: string;
  /** Lot S1 : code de la methode d'acquisition (referentiel METHODE_ACQUISITION, valeur active : correctifs T1+S1, M2) ; composante de la cle de version d'un reseau. */
  methodeAcquisition?: string;
}

export interface DemandeDepot {
  acteur: Acteur;
  projetId: string;
  fichier: Buffer;
  nomFichier: string;
  champs: ChampsDepot;
  simuler: boolean;
  /** Lot A1 : couche, entree KML, CRS source, colonnes CSV, mapping, confirmation hors zone. */
  options?: OptionsImport;
  /** Lot A1 : empreinte attendue (garde contre un fichier modifie entre l'apercu et le depot). */
  sha256Attendu?: string;
  /**
   * Lot B2 : resultat VALIDE d'une conversion GDAL. `fichier` est alors vide ; l'empreinte, la taille et le nom sont ceux du fichier d'origine du job. Le resultat
   * entre dans le MEME pipeline (quarantaine, CRS, mapping, delta, revue des suppressions) : aucune seconde voie.
   */
  conversion?: ConversionValidee;
  /** Lot B2 : appele DANS la transaction du depot reel (jamais en simulation), apres l'insertion : consomme le job (un seul depot par job). */
  apresDepot?: (tx: Tx, jeuId: string) => Promise<void>;
}

/** Taille du fichier d'origine : celle du job pour une conversion, sinon celle du fichier recu. */
const tailleDe = (d: DemandeDepot): number => (d.conversion ? d.conversion.source.octets : d.fichier.length);

/** Ce que renvoie le depot en plus du socle : delta detaille, suppressions a revoir, validation geometrique. */
export interface Suppressions { statut: "AUCUNE" | "A_REVOIR"; nb: number }
export interface ValidationGeometrique { nbProblemes: number; problemes: Probleme[]; tronque: boolean; elementsEcartes: ResultatImport["ecartes"] }
export interface DeltaVue { ajoutes: number; modifies: number; retires: number; identiques: number }

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

interface BilanInsertion { inseres: number; reparees: number; vides: number; problemes: Probleme[] }

/**
 * Insere les objets par lots. La geometrie lue (GeoJSON 2D) est REPAREE par `ST_MakeValid` si PostGIS la juge invalide (anneau qui se
 * croise...), puis ramenee au type attendu (`ST_CollectionExtract`) ; un objet qui devient vide est ecarte et compte.
 */
async function insererObjets(tx: Tx, jeuId: string, objets: readonly ObjetLu[]): Promise<BilanInsertion> {
  const bilan: BilanInsertion = { inseres: 0, reparees: 0, vides: 0, problemes: [] };
  for (let i = 0; i < objets.length; i += TAILLE_LOT_INSERTION) {
    const lot = objets.slice(i, i + TAILLE_LOT_INSERTION);
    const ordres = lot.map((o) => o.ordre);
    const noms = lot.map((o) => o.nom ?? "");
    const types = lot.map((o) => o.typeGeom as string);
    const codes = lot.map((o) => CODE_TYPE[o.typeGeom]);
    const geojsons = lot.map((o) => JSON.stringify(o.geometrie));
    const attributs = lot.map((o) => JSON.stringify(o.attributs));
    const empreintes = lot.map((o) => o.empreinte);
    const r = await tx.$queryRaw<{ inseres: number; reparees: number; vides: number; details: { ordre: number; raison: string | null; vide: boolean }[] }[]>`
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
             (SELECT count(*) FROM prep WHERE ST_IsEmpty("g"))::int AS "vides",
             (SELECT COALESCE(jsonb_agg(jsonb_build_object('ordre', q."ordre", 'raison', q."raison", 'vide', q."vide") ORDER BY q."ordre"), '[]'::jsonb)
                FROM (SELECT p."ordre", ST_IsValidReason(p."brute") AS "raison", ST_IsEmpty(p."g") AS "vide" FROM prep p WHERE p."reparee" OR ST_IsEmpty(p."g") ORDER BY p."ordre" LIMIT ${LISTE_MAX}) q) AS "details"`;
    bilan.inseres += r[0].inseres;
    bilan.reparees += r[0].reparees;
    bilan.vides += r[0].vides;
    for (const p of r[0].details) {
      if (bilan.problemes.length >= LISTE_MAX) break;
      const o = objets[p.ordre];
      if (!o || o.ordre !== p.ordre) continue;
      const c = classerRaison(p.raison, p.vide);
      bilan.problemes.push({ ordre: o.ordre, nom: o.nom, typeGeom: o.typeGeom, code: c.code, message: c.message });
    }
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

function dateJour(s: string | undefined): Date | null {
  return s ? new Date(`${s}T00:00:00.000Z`) : null;
}

export interface ResultatDepot {
  simulation: boolean;
  jeu: ReturnType<typeof vueJeu>;
  resume: Record<string, unknown>;
  avertissements: Avertissement[];
  delta: DeltaVue | null;
  remplace: { jeuId: string; version: number } | null;
  suppressions: Suppressions | null;
  validationGeometrique: ValidationGeometrique;
}

/** Controles qui dependent de ce que le fichier contient (apres lecture et transformation de CRS). */
function controlerLecture(c: ChampsDepot, lecture: ResultatImport): void {
  if (c.role === "AXES_TRAVAUX" && lecture.resume.parTypeGeom.LIGNE === 0) {
    throw new ErreurMetier(422, "GEOMETRIE_INVALIDE", "Un plan d'axes doit contenir des lignes : le fichier n'en contient aucune.");
  }
}

export async function deposerJeu(d: DemandeDepot): Promise<ResultatDepot> {
  const sha256 = d.conversion ? d.conversion.source.sha256 : createHash("sha256").update(d.fichier).digest("hex");
  if (d.sha256Attendu !== undefined && d.sha256Attendu !== sha256) {
    throw new ErreurMetier(409, "EMPREINTE_DIVERGENTE", "Le fichier envoyé n'est pas celui de l'aperçu (empreinte SHA-256 différente) : relancez l'aperçu avec ce fichier.", { sha256 });
  }
  const options = d.options ?? {};
  const limites = limitesImport();
  // Lot T1 : emprise nationale configuree, emprise du territoire du projet et liste blanche effective (CONTRAT-TERRITOIRES.md, section 6).
  const ctx = await contexteSpatialDuProjet(d.projetId);
  limites.lecture.emprise = ctx.zoneNationale;
  limites.lecture.territoire = ctx.zoneTerritoire ?? undefined;
  limites.crsAutorises = ctx.crsAutorises;
  // Lecture AVANT toute connexion a la base : un fichier refuse ne consomme ni transaction ni place dans le limiteur.
  const preparation = preparer(d.conversion ? detecterConvertie(d.conversion, options) : detecter(d.fichier, d.nomFichier, options, limites), options, limites);
  const c = d.champs;
  natureEffective(c.role, c.natureObjets);
  // Un concessionnaire peut venir du mapping (colonne `concessionnaire`) : il est alors resolu dans la transaction.
  if (c.role === "RESEAU_TIERS" && !c.concessionnaireId && options.mapping?.concessionnaire === undefined) {
    throw new ErreurMetier(400, "CONCESSIONNAIRE_REQUIS", "Un réseau de concessionnaire exige le champ concessionnaireId.");
  }
  if (c.role !== "RESEAU_TIERS" && (c.concessionnaireId || c.typeReseau || c.typeReseauCode)) {
    throw new ErreurMetier(400, "CHAMPS_INVALIDES", "concessionnaireId, typeReseau et typeReseauCode ne s'appliquent qu'au rôle RESEAU_TIERS.");
  }
  // WGS 84 : la lecture est complete ici. CRS projete : elle s'acheve dans la transaction, apres ST_Transform.
  const lecture: ResultatImport | null = preparation.besoinTransformation ? null : preparation.terminer(META_WGS84, null);
  if (lecture) controlerLecture(c, lecture);

  try {
    return await limiteurDepots.executer(() => avecErreurDelai(
      "DEPOT_TROP_LONG",
      `Le depot a depasse le delai alloue (${Math.round(delaiDepotMs() / 1000)} s par requete) ou le projet est occupe par une autre operation : reessayez, ou decoupez le fichier.`,
      () => prisma.$transaction((tx) => deposerDansTransaction(tx, d, lecture, preparation, sha256), { timeout: DELAI_TRANSACTION_MS, maxWait: 30_000 })));
  } catch (e) {
    if (e instanceof SimulationTerminee) return e.resultat as ResultatDepot;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Course residuelle sur un index unique partiel (le verrou du projet les rend improbables).
      throw new ErreurMetier(409, "DEPOT_EN_ATTENTE", "Un dépôt équivalent vient d'être enregistré : relisez la liste des jeux.");
    }
    throw e;
  }
}

/** 422 METHODE_ACQUISITION_INCONNUE si le code n'est pas une valeur active et non retiree du referentiel (une valeur desactivee reste lisible sur les jeux existants). */
export async function exigerMethodeAcquisition(tx: Pick<Tx, "referentielVoirie">, code: string): Promise<void> {
  const v = await tx.referentielVoirie.findFirst({ where: { domaine: "METHODE_ACQUISITION", code, deletedAt: null, actif: true }, select: { id: true } });
  if (!v) {
    throw new ErreurMetier(422, "METHODE_ACQUISITION_INCONNUE", `La méthode d'acquisition « ${code.slice(0, 40)} » n'est pas une valeur active du référentiel METHODE_ACQUISITION (voir GET /referentiels/METHODE_ACQUISITION).`, { methodeAcquisition: code.slice(0, 40) });
  }
}

interface ChampsAvecMapping {
  champs: ChampsDepot;
  depuisMapping: Record<string, PropositionJeu>;
  avertissements: Avertissement[];
}

/**
 * Applique les valeurs PROPOSEES par le mapping, seulement pour les champs que le formulaire n'a pas renseignes. Un concessionnaire est
 * retrouve par son nom (casse ignoree), jamais cree. Rien n'est invente : une proposition absente laisse le champ vide.
 */
async function appliquerPropositions(tx: Tx, c: ChampsDepot, props: ResultatImport["propositionsJeu"]): Promise<ChampsAvecMapping> {
  const champs: ChampsDepot = { ...c };
  const depuisMapping: Record<string, PropositionJeu> = {};
  const avertissements: Avertissement[] = [];
  const reseau = c.role === "RESEAU_TIERS";
  for (const [champ, prop] of Object.entries(props) as [string, PropositionJeu][]) {
    const ignorer = (raison: string) => avertissements.push({ code: "MAPPING_CHAMP_IGNORE", message: `Le champ ${champ} du mapping est ignore : ${raison}.` });
    switch (champ) {
      case "typeReseau":
        if (!reseau) ignorer("il ne s'applique qu'au role RESEAU_TIERS");
        else if (c.typeReseau === undefined) { champs.typeReseau = prop.valeur as TypeReseau; depuisMapping[champ] = prop; }
        break;
      case "concessionnaire":
        if (!reseau) ignorer("il ne s'applique qu'au role RESEAU_TIERS");
        else if (c.concessionnaireId === undefined) {
          const trouve = await tx.concessionnaireReseau.findFirst({ where: { nom: { equals: String(prop.valeur), mode: "insensitive" }, deletedAt: null }, select: { id: true } });
          if (trouve) { champs.concessionnaireId = trouve.id; depuisMapping[champ] = prop; }
          else avertissements.push({ code: "CONCESSIONNAIRE_INCONNU", message: `Le concessionnaire « ${String(prop.valeur).slice(0, 80)} » n'est pas connu : il n'est jamais cree par un import (creez-le puis choisissez-le).` });
        }
        break;
      case "classePrecision": if (c.classePrecision === undefined) { champs.classePrecision = prop.valeur as Classe; depuisMapping[champ] = prop; } break;
      case "precisionHorizontaleM": if (c.precisionHorizontaleM === undefined) { champs.precisionHorizontaleM = Number(prop.valeur); depuisMapping[champ] = prop; } break;
      case "precisionVerticaleM": if (c.precisionVerticaleM === undefined) { champs.precisionVerticaleM = Number(prop.valeur); depuisMapping[champ] = prop; } break;
      case "methode": if (c.methode === undefined) { champs.methode = String(prop.valeur); depuisMapping[champ] = prop; } break;
      case "dateDonnees": if (c.dateDonnees === undefined) { champs.dateDonnees = String(prop.valeur); depuisMapping[champ] = prop; } break;
      case "dateConstat": if (c.dateConstat === undefined) { champs.dateConstat = String(prop.valeur); depuisMapping[champ] = prop; } break;
      case "natureObjets": if (c.natureObjets === undefined) { champs.natureObjets = prop.valeur as Nature; depuisMapping[champ] = prop; } break;
      case "methodeAcquisition": if (c.methodeAcquisition === undefined) { champs.methodeAcquisition = String(prop.valeur); depuisMapping[champ] = prop; } break;
    }
  }
  return { champs, depuisMapping, avertissements };
}

async function deposerDansTransaction(tx: Tx, d: DemandeDepot, lecture0: ResultatImport | null, preparation: Preparation, sha256: string): Promise<ResultatDepot> {
  await verrouillerProjet(tx, d.projetId);

  // Idempotence : le meme fichier ne se charge pas deux fois (aucun objet en double). Controle AVANT toute transformation.
  const doublon = await tx.jeuDonneesProjet.findFirst({
    where: { projetId: d.projetId, sha256, statut: { in: ["RECU", "CONTROLE", "AUTORISE"] } }, select: { id: true, statut: true, version: true },
  });
  if (doublon) {
    throw new ErreurMetier(409, "JEU_DEJA_CHARGE", "Ce fichier est déjà chargé dans ce projet (même empreinte SHA-256).", { jeuId: doublon.id, statut: doublon.statut, version: doublon.version });
  }

  // CRS projete : transformation par la base (ST_Transform, PROJ), puis fin de la lecture (controle de zone, confirmation).
  let lecture = lecture0;
  if (!lecture) {
    const meta = await resoudreCrs(tx, preparation.choixCrs.epsg);
    const v = await versionProj(tx);
    const transformes = await transformerSommets(tx, preparation.choixCrs.epsg, preparation.sommets!);
    lecture = preparation.terminer(meta, v, transformes);
    controlerLecture(d.champs, lecture);
  }
  const mappe = await appliquerPropositions(tx, d.champs, lecture.propositionsJeu);
  const c = mappe.champs;
  const nature = natureEffective(c.role, c.natureObjets);
  if (c.role === "RESEAU_TIERS" && !c.concessionnaireId) throw new ErreurMetier(400, "CONCESSIONNAIRE_REQUIS", "Un réseau de concessionnaire exige le champ concessionnaireId (ou une colonne « concessionnaire » dont le nom est connu).");

  let typeReseau: TypeReseau | null = null;
  let typeReseauCode: string | null = null;
  if (c.role === "RESEAU_TIERS") {
    const conc = await tx.concessionnaireReseau.findFirst({ where: { id: c.concessionnaireId, deletedAt: null } });
    if (!conc) throw introuvable("Concessionnaire", "CONCESSIONNAIRE_INTROUVABLE");
    // Lot T1 : le code du referentiel (du depot, sinon du concessionnaire) donne la famille ; sans code, la famille declaree (repli).
    const type = await resoudreTypeReseau(tx, { code: c.typeReseauCode ?? conc.typeReseauCode, famille: c.typeReseau ?? conc.typeReseau });
    typeReseau = type.famille as TypeReseau;
    typeReseauCode = type.code;
  }
  const concId = c.role === "RESEAU_TIERS" ? c.concessionnaireId! : null;
  // Correctifs T1+S1 (M2) : la methode d'acquisition (du formulaire ou du mapping) est une valeur ACTIVE du referentiel METHODE_ACQUISITION.
  if (c.methodeAcquisition) await exigerMethodeAcquisition(tx, c.methodeAcquisition);

  let version = 1;
  let remplace: { id: string; version: number } | null = null;
  if (c.role !== "AUTRE") {
    // Lot S1 : la methode d'acquisition fait partie de la cle d'un reseau de concessionnaire (seconde source), pas des autres roles (CONTRAT-SOURCES.md, 3.1).
    const cle = filtreCleVersion({ projetId: d.projetId, role: c.role, concessionnaireId: concId, methodeAcquisition: c.methodeAcquisition ?? null });
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
      id, projetId: d.projetId, role: c.role, concessionnaireId: concId, typeReseau, typeReseauCode,
      nomFichier: d.nomFichier.slice(0, 255), format: lecture.format, sha256, tailleOctets: tailleDe(d), nbObjets: 0,
      dateDonnees: dateJour(c.dateDonnees), origineFichier: c.origineFichier ?? null,
      classePrecision: c.classePrecision ?? null, precisionHorizontaleM: c.precisionHorizontaleM ?? null, precisionVerticaleM: c.precisionVerticaleM ?? null,
      methode: c.methode ?? null, methodeAcquisition: c.methodeAcquisition ?? null, dateConstat: dateJour(c.dateConstat), natureObjets: nature,
      confidentialite: c.confidentialite ?? confidentialiteParDefaut(c.role), statut: "CONTROLE", version, remplaceId: remplace?.id ?? null,
      creeParId: d.acteur.id,
    },
  });

  const t0 = performance.now();
  const bilan = await insererObjets(tx, id, lecture.objets);
  if (process.env.PV_TRACE === "1") console.info(`[projets-voirie] insertion de ${lecture.objets.length} objets : ${Math.round(performance.now() - t0)} ms`);
  if (bilan.inseres === 0) throw new ErreurMetier(422, "GEOMETRIE_INVALIDE", "Aucune géométrie exploitable après contrôle par la base (toutes vides une fois réparées).");
  const t1 = performance.now();
  const mesures = await mesurerJeu(tx, id);
  if (process.env.PV_TRACE === "1") console.info(`[projets-voirie] mesures (union des trace) : ${Math.round(performance.now() - t1)} ms`);

  const avertissements: Avertissement[] = [...lecture.avertissements, ...mappe.avertissements];
  if (bilan.reparees > 0) avertissements.push({ code: "GEOMETRIES_REPAREES", message: "Géométries invalides réparées par la base (anneau qui se croise, par exemple).", nb: bilan.reparees });
  if (bilan.vides > 0) avertissements.push({ code: "GEOMETRIES_VIDES_IGNOREES", message: "Géométries devenues vides après réparation, ignorées.", nb: bilan.vides });

  // Delta DETAILLE (ajoutes, modifies, retires, identiques) contre le jeu autorise qu'il remplacera : information, jamais appliquee.
  let delta: DeltaVue | null = null;
  let suppressions: Suppressions | null = null;
  if (remplace) {
    const ancien = await tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id: remplace.id }, select: { id: true, resume: true } });
    const dj: DeltaJeux = await deltaEntreJeux(tx, { id, colonneId: lecture.importInfo.mapping.identifiant ?? null }, ancien);
    delta = { ajoutes: dj.ajoutes, modifies: dj.modifies, retires: dj.retires, identiques: dj.identiques };
    suppressions = { statut: dj.retires > 0 ? "A_REVOIR" : "AUCUNE", nb: dj.retires };
  }
  // Un fichier converti n'est jamais conserve en entier : seuls l'empreinte et la taille du fichier d'origine le sont (le spool est purge).
  const conservation = d.conversion ? "EMPREINTE_SEULE" : modeConservationOriginal();
  const validationGeometrique: ValidationGeometrique = { nbProblemes: bilan.reparees, problemes: bilan.problemes, tronque: bilan.reparees > bilan.problemes.length, elementsEcartes: lecture.ecartes };

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
    import: { ...lecture.importInfo, champsDepuisMapping: mappe.depuisMapping, conservationOriginal: conservation },
    suppressions,
  };
  await tx.jeuDonneesProjet.update({
    where: { id },
    data: {
      nbObjets: mesures.nbObjets, longueurTotaleM: mesures.longueurTotaleM, longueurTraceFusionneM: mesures.longueurTraceFusionneM,
      avertissements: avertissements as unknown as Prisma.InputJsonValue, resume: resume as unknown as Prisma.InputJsonValue,
    },
  });
  // Lot S1 : connexions DECLAREES par une colonne du fichier (mapping `connecteA`) : resolues par le NOM d'un objet du meme jeu, jamais par proximite.
  // Avant la fin d'une simulation : le resume les compte, la transaction annulee ne garde rien.
  const colonneConnexion = lecture.importInfo.mapping.connecteA;
  let connexions: { creees: number; nonResolues: number } | null = null;
  if (colonneConnexion !== undefined) {
    if (nature !== "ACTIF_PHYSIQUE" && nature !== "EQUIPEMENT") {
      throw new ErreurMetier(422, "CONNECTE_A_NATURE_REQUISE", "Des connexions déclarées (mapping connecteA) ne relient que des objets physiques : déclarez la nature du jeu (ACTIF_PHYSIQUE ou EQUIPEMENT).");
    }
    connexions = await insererConnexionsDeclarees(tx, { projetId: d.projetId, jeuId: id, colonne: colonneConnexion, acteurId: d.acteur.id, justification: `Connexion déclarée par le fichier ${d.nomFichier.slice(0, 120)} (colonne ${colonneConnexion.slice(0, 60)})` });
    if (connexions.nonResolues > 0) avertissements.push({ code: "CONNEXIONS_NON_RESOLUES", message: "Des objets désignent un objet connecté introuvable ou ambigu dans le même fichier : aucune connexion n'est créée pour eux (rien n'est deviné).", nb: connexions.nonResolues });
    (resume.import as Record<string, unknown>).connexionsDeclarees = connexions;
    await tx.jeuDonneesProjet.update({ where: { id }, data: { avertissements: avertissements as unknown as Prisma.InputJsonValue, resume: resume as unknown as Prisma.InputJsonValue } });
  }
  // Fichier d'origine : seulement si la configuration le demande (retention a decider ; defaut : empreinte seule, comme le socle).
  if (conservation === "STOCKE" && !d.simuler) {
    await tx.fichierOrigineJeuProjet.create({ data: { jeuId: id, sha256, tailleOctets: tailleDe(d), contenu: d.fichier } });
  }

  const jeu = await tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id }, include: INCLURE_JEU });
  const resultat: ResultatDepot = {
    simulation: d.simuler,
    jeu: vueJeu(jeu, { sansId: d.simuler }),
    resume,
    avertissements,
    delta,
    remplace: remplace ? { jeuId: remplace.id, version: remplace.version } : null,
    suppressions,
    validationGeometrique,
  };
  if (d.simuler) throw new SimulationTerminee(resultat);
  if (d.apresDepot) await d.apresDepot(tx, id);

  await logAuditTransactionnelle(tx, {
    userId: d.acteur.id, action: "CREATE", entityType: "JeuDonneesProjet", entityId: id,
    after: {
      projetId: d.projetId, role: c.role, concessionnaireId: concId, nomFichier: jeu.nomFichier, format: lecture.format, sha256,
      tailleOctets: tailleDe(d), nbObjets: mesures.nbObjets, longueurTraceFusionneM: mesures.longueurTraceFusionneM,
      version, statut: "CONTROLE", confidentialite: jeu.confidentialite, natureObjets: nature, classePrecision: c.classePrecision ?? null, methodeAcquisition: c.methodeAcquisition ?? null,
      connexionsDeclarees: connexions,
      origineFichier: c.origineFichier ?? null, remplaceId: remplace?.id ?? null, delta, suppressions,
      avertissements: avertissements.map((a) => ({ code: a.code, nb: a.nb ?? null })),
      // CRS source, cible, unites et methode : conserves dans l'audit (jamais de geometrie).
      crs: {
        epsgSource: lecture.crs.epsgSource, epsgCible: lecture.crs.epsgCible, uniteSource: lecture.crs.uniteSource, uniteCible: lecture.crs.uniteCible,
        methode: lecture.crs.methode, origine: lecture.crs.origine, versionProj: lecture.crs.versionProj, plausibilite: lecture.crs.plausibilite.statut,
        nbElementsHorsZone: lecture.crs.plausibilite.nbElementsHorsZone, confirmeeHorsZone: lecture.crs.plausibilite.confirmee,
      },
      import: {
        couche: lecture.importInfo.couche?.id ?? null, entreeKml: lecture.importInfo.entreeKml, mapping: lecture.importInfo.mapping,
        champsDepuisMapping: Object.fromEntries(Object.entries(mappe.depuisMapping).map(([k, v]) => [k, v.colonne])),
        csv: lecture.importInfo.csv ? { mode: lecture.importInfo.csv.mode, delimiteur: lecture.importInfo.csv.delimiteur, encodage: lecture.importInfo.csv.encodage, nbLignesRejetees: lecture.importInfo.csv.nbLignesRejetees } : null,
        conservationOriginal: conservation,
        // Lot B2 : provenance d'une conversion GDAL (job, version de GDAL et de PROJ, couches lues, comptes DXF) : jamais de geometrie.
        conversion: lecture.importInfo.conversion ?? null,
      },
    },
    ipAddress: d.acteur.ip,
  });
  return resultat;
}
