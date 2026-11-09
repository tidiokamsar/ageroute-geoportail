import type { NextFunction, RequestHandler, Request, Response, Router } from "express";
import { z } from "zod";
import { META_WGS84 } from "../projets-voirie/formats/crs.noyau";
import { resoudreCrs } from "../projets-voirie/formats/crs.service";
import { apercuFichier, inventaireFichier, type DemandeFichier } from "../projets-voirie/formats/apercu.service";
import { modeConservationOriginal, crsSourceAutorises, delaiApercuMs, limitesCsv, limitesZip, tailleEchantillon } from "../projets-voirie/formats/import.config";
import type { OptionsImport } from "../projets-voirie/formats/lecture-import.noyau";
import { CHAMPS_CIBLES, analyserMapping } from "../projets-voirie/formats/mapping.noyau";
import { lireDelta, retourArriere, revueSuppressions } from "../projets-voirie/formats/revue-versions.service";
import { BBOX_GUINEE, OBJETS_MAX, SOMMETS_PAR_FICHIER_MAX, SOMMETS_PAR_OBJET_MAX, TAILLE_MAX_OCTETS } from "../projets-voirie/lecture.types";
import { prisma } from "../lib/prisma";
import { disponibilite } from "../projets-voirie/gdal/jobs.service";
import { formatsGdalAnnonces } from "../projets-voirie/gdal/formats.registre";
import { jobIdOption, sourceConvertie } from "./projets-voirie.gdal.routes";
import { regionsDuProjet, type Acteur } from "../projets-voirie/projets.service";

/**
 * `/api/v2/projets-voirie/:id/import/...` et `/:id/jeux/:jeuId/{delta,revue-suppressions,retour-arriere}` -- FORMATS D'IMPORT OUVERTS, CRS,
 * MAPPING, VERSIONS (lot A1). Contrat : docs/projets-voirie/CONTRAT-IMPORT.md ; reponses reelles : docs/projets-voirie/API.md.
 *
 * Montees sur le routeur du socle, elles en heritent TOUTES les gardes dans le meme ordre : authentification -> cle de module -> octet NUL (400)
 * -> identifiants d'URL en UUID (400) -> role ADMIN ou GESTIONNAIRE -> PROJET DESIGNE (404 identique si inexistant ou hors perimetre) ->
 * place de reception (fichiers) -> validation des entrees (400) -> service.
 *
 *   - l'inventaire et l'apercu NE PERSISTENT RIEN (ni jeu, ni objet, ni audit) et ne renvoient que le contenu du fichier que l'appelant vient
 *     d'envoyer, borne a un echantillon ;
 *   - aucune route n'exporte la geometrie d'un jeu ; la revue des suppressions et le retour arriere sont audites, justifies, sans perte ;
 *   - AUCUNE route ne cree d'ordre, de deplacement ni de decision automatique.
 */

export interface OutilsImportRoutes {
  ecriture: RequestHandler;
  gardeProjet: RequestHandler;
  acteurDe: (req: Request) => Acteur;
  enveloppe: (g: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
  refuser: (res: Response, e: z.ZodError, code?: string) => void;
  placeDeReception: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  recevoir: (req: Request, res: Response, next: NextFunction) => void;
}

const vide = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(vide, s.optional());
const booleen = z.preprocess(vide, z.enum(["true", "false"]).optional()).transform((v) => v === "true");
const colonne = z.string().min(1).max(200);
// Le delimiteur peut etre une vraie tabulation, ou l'ecriture « \t » ou « tab » (les formulaires ne savent pas envoyer une tabulation).
const delimiteur = z.preprocess((v) => (v === "\\t" || v === "tab" ? "\t" : vide(v)), z.enum([",", ";", "\t", "|"]).optional());

/**
 * Champs d'options d'import (multipart : tout arrive en texte). Fusionnes au dépôt (`POST /:id/jeux`), identiques pour l'inventaire et l'apercu.
 */
export const champsImport = z.object({
  couche: opt(z.string().min(1).max(200)),
  entreeKml: opt(z.string().min(1).max(300)),
  epsgSource: opt(z.coerce.number().int().min(1000).max(999999)),
  confirmerHorsZone: booleen,
  sha256Attendu: opt(z.string().regex(/^[0-9a-fA-F]{64}$/, "64 caractères hexadécimaux").transform((s) => s.toLowerCase())),
  mapping: opt(z.string().max(4000)),
  delimiteur,
  encodage: opt(z.enum(["utf-8", "iso-8859-1", "windows-1252"])),
  separateurDecimal: opt(z.enum([".", ","])),
  colonneX: opt(colonne), colonneY: opt(colonne), colonneWkt: opt(colonne), colonneCle: opt(colonne), colonneOrdre: opt(colonne),
  /** Lot B2 : resultat d'un job de conversion GDAL (GeoPackage, Shapefile ZIP, DXF) a la place du fichier. */
  jobId: jobIdOption,
});
export type ChampsImport = z.infer<typeof champsImport>;

/** Options de lecture depuis les champs valides. Le mapping est valide ici par liste blanche (400 MAPPING_INVALIDE). */
export function optionsDepuis(c: ChampsImport): OptionsImport {
  const csv = {
    delimiteur: c.delimiteur, encodage: c.encodage, separateurDecimal: c.separateurDecimal,
    colonneX: c.colonneX, colonneY: c.colonneY, colonneWkt: c.colonneWkt, colonneCle: c.colonneCle, colonneOrdre: c.colonneOrdre,
  };
  const aCsv = Object.values(csv).some((v) => v !== undefined);
  return {
    couche: c.couche, entreeKml: c.entreeKml, epsgSource: c.epsgSource, confirmerHorsZone: c.confirmerHorsZone,
    mapping: c.mapping !== undefined ? analyserMapping(c.mapping) : undefined,
    csv: aCsv ? csv : undefined,
  };
}

/** Champs du depot que l'inventaire et l'apercu ignorent (ils ne lisent que le fichier et les options d'import). */
const IGNORES_PAR_APERCU = z.object({
  role: z.string().optional(), concessionnaireId: z.string().optional(), typeReseau: z.string().optional(), dateDonnees: z.string().optional(),
  origineFichier: z.string().optional(), confidentialite: z.string().optional(), natureObjets: z.string().optional(), classePrecision: z.string().optional(),
  precisionHorizontaleM: z.string().optional(), precisionVerticaleM: z.string().optional(), methode: z.string().optional(), dateConstat: z.string().optional(),
  methodeAcquisition: z.string().optional(),
});
const champsApercu = champsImport.merge(IGNORES_PAR_APERCU).strict();

const corpsRevue = z.object({ decision: z.enum(["ACCEPTER", "REFUSER"]), justification: z.string().trim().min(10, "10 caractères au moins").max(2000) }).strict();
const corpsRetour = z.object({ justification: z.string().trim().min(10, "10 caractères au moins").max(2000) }).strict();

const FORMATS = [
  { format: "KML", extensions: [".kml"], detection: "contenu", crsParDefinition: "EPSG:4326", choixCrs: "interdit" },
  { format: "KMZ", extensions: [".kmz"], detection: "contenu", crsParDefinition: "EPSG:4326", choixCrs: "interdit" },
  { format: "GEOJSON", extensions: [".geojson", ".json"], detection: "contenu", crsParDefinition: "EPSG:4326", choixCrs: "facultatif" },
  { format: "GPX", extensions: [".gpx"], detection: "contenu", crsParDefinition: "EPSG:4326", choixCrs: "interdit" },
  { format: "CSV", extensions: [".csv", ".tsv", ".txt"], detection: "contenu", crsParDefinition: null, choixCrs: "obligatoire" },
] as const;
// GeoPackage, Shapefile ZIP et DXF ne sont plus ici : ils sont annonces par `formatsGdal` (supportes ou indisponibles, avec la raison).
const NON_SUPPORTES = [
  { format: "DWG", raison: "convertisseur approuve et licence verifiee requis" },
] as const;

export function monterRoutesImport(router: Router, o: OutilsImportRoutes): void {
  const { ecriture, gardeProjet, acteurDe, enveloppe, refuser, placeDeReception, recevoir } = o;

  /**
   * Un projet inexistant ou RETIRE repond 404 a TOUS les comptes, nationaux compris (la garde territoriale ne regarde que le perimetre) :
   * ni inventaire, ni apercu, ni delta d'un projet supprime.
   */
  const projetExiste: RequestHandler = (req, res, next) => {
    regionsDuProjet(req.params.id).then((r) => {
      if (r.length === 0) { res.status(404).json({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" }); return; }
      next();
    }).catch(next);
  };

  const jeuIdValide = (req: Request, res: Response): boolean => {
    if (req.params.jeuId.length > 64) { res.status(404).json({ error: "Jeu de données introuvable", code: "JEU_INTROUVABLE" }); return false; }
    return true;
  };

  // ---------------------------------------------------------------------------------------------- Etape 0 : options
  router.get("/:id/import/options", ecriture, gardeProjet, projetExiste, enveloppe(async (_req, res) => {
    const sources = [];
    for (const epsg of crsSourceAutorises()) {
      try {
        const m = await resoudreCrs(prisma, epsg);
        sources.push({ epsg, nom: m.nom, unite: m.unite, disponible: true });
      } catch (e) {
        if (!(e instanceof Error) || (e as { code?: string }).code !== "CRS_NON_DISPONIBLE") throw e;
        sources.push({ epsg, nom: null, unite: null, disponible: false });
      }
    }
    const zip = limitesZip();
    const csv = limitesCsv();
    // Lot B2 : etat des formats GDAL. Desactive (defaut), AUCUN acces au spool ni au conteneur : seulement l'etat de l'interrupteur.
    const gdal = formatsGdalAnnonces(await disponibilite());
    res.json({
      formats: FORMATS,
      formatsGdal: gdal,
      nonSupportes: NON_SUPPORTES,
      limites: {
        tailleMaxOctets: TAILLE_MAX_OCTETS, objetsMax: OBJETS_MAX, sommetsParObjetMax: SOMMETS_PAR_OBJET_MAX, sommetsParFichierMax: SOMMETS_PAR_FICHIER_MAX,
        archive: { entreesMax: zip.entreesMax, tailleDecompresseeMaxOctets: zip.tailleTotaleMax, tauxCompressionMax: zip.tauxMax, profondeurMax: zip.profondeurMax },
        csv: { lignesMax: csv.lignesMax, colonnesMax: csv.colonnesMax, celluleMaxCaracteres: csv.celluleMax },
        echantillonMax: tailleEchantillon(), delaiApercuMs: delaiApercuMs(),
      },
      crs: {
        cible: { epsg: META_WGS84.epsg, nom: META_WGS84.nom, unite: META_WGS84.unite },
        sourcesAutorises: sources,
        zoneAttendue: { nom: "Guinee", bbox: BBOX_GUINEE },
      },
      champsCibles: CHAMPS_CIBLES,
      csv: { delimiteurs: [",", ";", "\t", "|"], encodages: ["utf-8", "iso-8859-1", "windows-1252"], separateursDecimaux: [".", ","], modes: ["points", "lignes", "wkt"] },
      conservationOriginal: modeConservationOriginal(),
    });
  }));

  // ---------------------------------------------------------------------------------------------- Etapes 1 et 2 : inventaire, apercu
  const lireFichierEtOptions = async (req: Request, res: Response): Promise<DemandeFichier | null> => {
    const c = champsApercu.safeParse(req.body ?? {});
    if (!c.success) { refuser(res, c.error, "CHAMPS_INVALIDES"); return null; }
    const options = optionsDepuis(c.data);
    // Lot B2 : jobId = resultat valide d'une conversion GDAL (a la place du fichier) ; meme pipeline ensuite.
    if (c.data.jobId !== undefined) {
      const s = await sourceConvertie(req.params.id, c.data.jobId, c.data.couche, req.file !== undefined);
      return { fichier: Buffer.alloc(0), nomFichier: s.nomFichier, options, conversion: s.conversion };
    }
    if (!req.file) { res.status(400).json({ error: "Fichier manquant (champ multipart « fichier »)", code: "FICHIER_MANQUANT" }); return null; }
    return { fichier: req.file.buffer, nomFichier: req.file.originalname, options };
  };

  router.post("/:id/import/inventaire", ecriture, gardeProjet, projetExiste, placeDeReception, recevoir, enveloppe(async (req, res) => {
    const d = await lireFichierEtOptions(req, res);
    if (!d) return;
    res.json(inventaireFichier(d));
  }));

  router.post("/:id/import/apercu", ecriture, gardeProjet, projetExiste, placeDeReception, recevoir, enveloppe(async (req, res) => {
    const d = await lireFichierEtOptions(req, res);
    if (!d) return;
    res.json(await apercuFichier(d));
  }));

  // ---------------------------------------------------------------------------------------------- Etape 5 : delta, revue des suppressions
  router.get("/:id/jeux/:jeuId/delta", ecriture, gardeProjet, projetExiste, enveloppe(async (req, res) => {
    if (!jeuIdValide(req, res)) return;
    res.json(await lireDelta(req.params.id, req.params.jeuId));
  }));

  router.post("/:id/jeux/:jeuId/revue-suppressions", ecriture, gardeProjet, projetExiste, enveloppe(async (req, res) => {
    if (!jeuIdValide(req, res)) return;
    const p = corpsRevue.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "JUSTIFICATION_INVALIDE");
    res.json(await revueSuppressions(acteurDe(req), req.params.id, req.params.jeuId, p.data.decision, p.data.justification));
  }));

  // ---------------------------------------------------------------------------------------------- Etape 7 : retour arriere
  router.post("/:id/jeux/:jeuId/retour-arriere", ecriture, gardeProjet, projetExiste, enveloppe(async (req, res) => {
    if (!jeuIdValide(req, res)) return;
    const p = corpsRetour.safeParse(req.body ?? {});
    if (!p.success) return refuser(res, p.error, "JUSTIFICATION_INVALIDE");
    res.json(await retourArriere(acteurDe(req), req.params.id, req.params.jeuId, p.data.justification));
  }));
}

