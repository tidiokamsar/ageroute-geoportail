/**
 * INVENTAIRE ET APERCU d'un fichier, SANS RIEN PERSISTER (lot A1). Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 7.
 *
 *   - `inventaireFichier` : detection par le contenu, couches, entrees d'archive, colonnes ; pure, sans base ;
 *   - `apercuFichier`     : lecture, transformation de CRS (PostGIS), validation geometrique par objet (bornee), statistiques, echantillon
 *                           borne, plausibilite. Transaction `READ ONLY` : AUCUNE ecriture (ni jeu, ni objet, ni audit).
 *
 * Budget de temps : `PROJETS_VOIRIE_DELAI_APERCU_MS` cote base ; 2 apercus simultanes au plus par processus (503 SERVICE_OCCUPE).
 */

import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { Limiteur } from "../../import/limiteur";
import { avecErreurDelai, poserDelais, type TxMinimale } from "../bd";
import { delaiVerrouMs } from "../config";
import type { Avertissement, ObjetLu } from "../lecture.types";
import { META_WGS84 } from "./crs.noyau";
import { resoudreCrs, transformerSommets, versionProj } from "./crs.service";
import { LISTE_MAX, SOMMETS_ECHANTILLON_MAX, delaiApercuMs, limitesImport, tailleEchantillon } from "./import.config";
import { contexteSpatialDuProjet } from "../territoires/contexte-spatial";
import { detecter, detecterConvertie, inventaireConverti, inventorier, preparer, type InventaireFichier, type OptionsImport, type ResultatImport } from "./lecture-import.noyau";
import type { ConversionValidee } from "../gdal/conversion.noyau";
import { classerRaison, construireEchantillon, type ObjetEchantillon, type Probleme } from "./validation.noyau";

export const limiteurApercus = new Limiteur(2, 10_000);

export interface DemandeFichier {
  fichier: Buffer;
  nomFichier: string;
  options: OptionsImport;
  /** Lot T1 : projet vise, pour l'emprise du territoire, l'emprise nationale configuree et la liste blanche effective (apercu seulement). */
  projetId?: string;
  /** Lot B2 : resultat VALIDE d'une conversion GDAL (job). `fichier` est alors vide : l'empreinte et la taille sont celles du fichier d'origine du job. */
  conversion?: ConversionValidee;
}

const empreinteFichier = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const descriptionFichier = (d: DemandeFichier) => (d.conversion
  ? { nom: d.nomFichier.slice(0, 255), tailleOctets: d.conversion.source.octets, sha256: d.conversion.source.sha256 }
  : { nom: d.nomFichier.slice(0, 255), tailleOctets: d.fichier.length, sha256: empreinteFichier(d.fichier) });

export interface ReponseInventaire extends InventaireFichier {
  fichier: { nom: string; tailleOctets: number; sha256: string };
}

/** Inventaire : AUCUNE coordonnee n'est controlee, aucune base n'est lue. */
export function inventaireFichier(d: DemandeFichier): ReponseInventaire {
  if (d.conversion) return { fichier: descriptionFichier(d), ...inventaireConverti(d.conversion) };
  const limites = limitesImport();
  const detection = detecter(d.fichier, d.nomFichier, d.options, limites, { inventaire: true });
  return { fichier: descriptionFichier(d), ...inventorier(detection) };
}

// ------------------------------------------------------------------------------------------------ Validation geometrique (base)

const TAILLE_LOT = 500;

export interface AnalyseGeometries {
  longueurTotaleM: number;
  geometriesAReparer: number;
  geometriesVides: number;
  problemes: Probleme[];
  tronque: boolean;
}

/** Valide chaque geometrie par PostGIS (ST_IsValid, ST_IsValidReason, ST_Length) SANS rien ecrire. Rapport borne a 50 problemes. */
export async function analyserGeometries(tx: TxMinimale, objets: readonly ObjetLu[]): Promise<AnalyseGeometries> {
  const r: AnalyseGeometries = { longueurTotaleM: 0, geometriesAReparer: 0, geometriesVides: 0, problemes: [], tronque: false };
  let nbProblemes = 0;
  for (let i = 0; i < objets.length; i += TAILLE_LOT) {
    const lot = objets.slice(i, i + TAILLE_LOT);
    const ordres = lot.map((o) => o.ordre);
    const types = lot.map((o) => o.typeGeom as string);
    const geojsons = lot.map((o) => JSON.stringify(o.geometrie));
    const l = await tx.$queryRaw<{ aReparer: number; vides: number; longueur: number; details: { ordre: number; raison: string | null; vide: boolean }[] }[]>`
      WITH src AS (
        SELECT t."ordre", t."tg", ST_SetSRID(ST_GeomFromGeoJSON(t."gj"), 4326) AS "brute"
          FROM unnest(${ordres}::int[], ${types}::text[], ${geojsons}::text[]) AS t("ordre", "tg", "gj")),
      prep AS (SELECT s.*, ST_IsValid(s."brute") AS "valide" FROM src s)
      SELECT count(*) FILTER (WHERE NOT "valide")::int AS "aReparer",
             count(*) FILTER (WHERE ST_IsEmpty("brute"))::int AS "vides",
             COALESCE(SUM(ST_Length("brute"::geography)) FILTER (WHERE "tg" = 'LIGNE' AND "valide"), 0)::float8 AS "longueur",
             (SELECT COALESCE(jsonb_agg(jsonb_build_object('ordre', q."ordre", 'raison', q."raison", 'vide', q."vide") ORDER BY q."ordre"), '[]'::jsonb)
                FROM (SELECT "ordre", ST_IsValidReason("brute") AS "raison", ST_IsEmpty("brute") AS "vide" FROM prep WHERE NOT "valide" ORDER BY "ordre" LIMIT ${LISTE_MAX}) q) AS "details"
        FROM prep`;
    const x = l[0];
    r.longueurTotaleM += Number(x.longueur);
    r.geometriesAReparer += x.aReparer;
    r.geometriesVides += x.vides;
    nbProblemes += x.aReparer;
    for (const p of x.details) {
      if (r.problemes.length >= LISTE_MAX) break;
      const o = objets[p.ordre];
      if (!o || o.ordre !== p.ordre) continue;
      const c = classerRaison(p.raison, p.vide);
      r.problemes.push({ ordre: o.ordre, nom: o.nom, typeGeom: o.typeGeom, code: c.code, message: c.message });
    }
  }
  r.tronque = nbProblemes > r.problemes.length;
  return r;
}

// ------------------------------------------------------------------------------------------------ Apercu

export interface ReponseApercu {
  fichier: { nom: string; tailleOctets: number; sha256: string };
  format: string;
  couche: { id: string; nom: string } | null;
  resume: Record<string, unknown>;
  statistiques: Record<string, unknown>;
  validationGeometrique: { nbProblemes: number; problemes: Probleme[]; tronque: boolean; elementsEcartes: ResultatImport["ecartes"] };
  echantillon: { taille: number; total: number; objets: ObjetEchantillon[] };
  mapping: { applique: Record<string, string>; propositionsJeu: ResultatImport["propositionsJeu"]; avertissements: Avertissement[] };
  avertissements: Avertissement[];
}

function nbSommets(objets: readonly ObjetLu[]): number {
  const compter = (x: unknown): number => (typeof (x as number[])[0] === "number" ? 1 : (x as unknown[]).reduce<number>((s, y) => s + compter(y), 0));
  return objets.reduce((s, o) => s + compter(o.geometrie.coordinates), 0);
}

export async function apercuFichier(d: DemandeFichier): Promise<ReponseApercu> {
  const limites = limitesImport();
  if (d.projetId) {
    const ctx = await contexteSpatialDuProjet(d.projetId);
    limites.lecture.emprise = ctx.zoneNationale;
    limites.lecture.territoire = ctx.zoneTerritoire ?? undefined;
    limites.crsAutorises = ctx.crsAutorises;
  }
  const detection = d.conversion ? detecterConvertie(d.conversion, d.options) : detecter(d.fichier, d.nomFichier, d.options, limites);
  const prep = preparer(detection, d.options, limites);
  // Sans transformation, la lecture est complete avant toute connexion : un fichier refuse ne consomme ni transaction ni place.
  let resultat: ResultatImport | null = prep.besoinTransformation ? null : prep.terminer(META_WGS84, null);

  const delai = delaiApercuMs();
  const message = `L'apercu a depasse ${Math.round(delai / 1000)} s et a ete interrompu : le fichier est trop volumineux pour un apercu immediat.`;
  const geo = await limiteurApercus.executer(() => avecErreurDelai("APERCU_TROP_LONG", message, () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await poserDelais(tx, delai, delaiVerrouMs());
    if (resultat === null) {
      const meta = await resoudreCrs(tx, prep.choixCrs.epsg);
      const v = await versionProj(tx);
      const t = await transformerSommets(tx, prep.choixCrs.epsg, prep.sommets!);
      resultat = prep.terminer(meta, v, t);
    }
    return analyserGeometries(tx, resultat.objets);
  }, { timeout: delai + 10_000, maxWait: 15_000 })));

  const res = resultat as ResultatImport | null;
  if (res === null) throw new Error("lecture non terminee");
  const aProbleme = new Set(geo.problemes.map((p) => p.ordre));
  const taille = tailleEchantillon();
  const doublons = res.avertissements.find((a) => a.code === "TRACES_DOUBLES")?.nb ?? 0;
  const sommets = nbSommets(res.objets);
  return {
    fichier: descriptionFichier(d),
    format: res.format,
    couche: res.importInfo.couche,
    resume: {
      nbObjets: res.resume.nbObjets, libelleNbObjets: "circuits ou objets du fichier", parTypeGeom: res.resume.parTypeGeom,
      longueurTotaleM: Math.round(geo.longueurTotaleM * 100) / 100, bbox: res.resume.bbox, attributsDetectes: res.resume.attributsDetectes,
      crs: res.crs, import: res.importInfo,
    },
    statistiques: {
      nbObjets: res.resume.nbObjets, parTypeGeom: res.resume.parTypeGeom, longueurTotaleM: Math.round(geo.longueurTotaleM * 100) / 100,
      doublonsInternes: doublons, sommets, geometriesAReparer: geo.geometriesAReparer, geometriesVides: geo.geometriesVides,
    },
    validationGeometrique: { nbProblemes: geo.geometriesAReparer, problemes: geo.problemes, tronque: geo.tronque, elementsEcartes: res.ecartes },
    echantillon: { taille: Math.min(taille, res.objets.length), total: res.objets.length, objets: construireEchantillon(res.objets, taille, aProbleme, SOMMETS_ECHANTILLON_MAX) },
    mapping: {
      applique: { ...res.importInfo.mapping }, propositionsJeu: res.propositionsJeu,
      avertissements: res.avertissements.filter((a) => a.code.startsWith("MAPPING_")),
    },
    avertissements: res.avertissements,
  };
}
