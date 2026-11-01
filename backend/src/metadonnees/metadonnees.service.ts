import { CATALOGUE, trouverFiche } from "./catalogue.referentiel";
import { construireXml, lacunes, type Contexte, type Emprise, type FicheJeu, type Lacune } from "./iso19115.noyau";

/**
 * Metadonnees ISO 19115 des jeux publics : le contexte est CALCULE sur les donnees servies, pas
 * ecrit a la main. L'etendue d'une fiche est celle des geometries que le service public renvoie
 * vraiment (memes predicats), et la date de revision est la derniere modification observee.
 *
 * Si la base ne repond pas, la fiche sort quand meme, avec ces deux champs absents et declares
 * comme lacunes : un catalogue de metadonnees ne doit pas tomber avec la base, et il ne doit pas
 * non plus fabriquer une etendue de repli.
 */

export interface DepotMetadonnees {
  $queryRaw<T = unknown>(chaines: TemplateStringsArray, ...valeurs: unknown[]): Promise<T>;
}

export interface OptionsPublication {
  organisme: string;
  courriel: string | null;
  baseUrl: string | null;
  /** Jour UTC de la fiche, injectable pour les tests. */
  aujourdhui: string;
}

interface LigneEtendue {
  ouest: number | null; est: number | null; sud: number | null; nord: number | null;
  revision: string | null;
}
type Requete = (d: DepotMetadonnees) => Promise<LigneEtendue[]>;

/**
 * Une requete CONSTANTE par jeu, ecrite en toutes lettres : aucun morceau de SQL ne se construit
 * (le garde-fou du paragraphe 7.1 interdit `$queryRawUnsafe` hors liste justifiee), et l'identifiant
 * demande ne sert qu'a retrouver une entree de cette table.
 *
 * Les predicats sont CEUX DE LA CARTE PUBLIQUE, pas ceux de la table entiere.
 */
const SOURCES: Record<string, Requete> = {
  troncons: (d) => d.$queryRaw<LigneEtendue[]>`
    SELECT ST_XMin(e)::float8 AS ouest, ST_XMax(e)::float8 AS est, ST_YMin(e)::float8 AS sud, ST_YMax(e)::float8 AS nord,
           to_char(r, 'YYYY-MM-DD') AS revision
    FROM (SELECT ST_Extent(geom) AS e, MAX("updatedAt") AS r FROM troncons WHERE geom IS NOT NULL AND "deletedAt" IS NULL) s`,
  // Les franchissements repris d'OpenStreetMap (propositions) n'apparaissent pas sur la carte publique.
  ouvrages: (d) => d.$queryRaw<LigneEtendue[]>`
    SELECT ST_XMin(e)::float8 AS ouest, ST_XMax(e)::float8 AS est, ST_YMin(e)::float8 AS sud, ST_YMax(e)::float8 AS nord,
           to_char(r, 'YYYY-MM-DD') AS revision
    FROM (SELECT ST_Extent(geom) AS e, MAX("updatedAt") AS r FROM ouvrages
          WHERE geom IS NOT NULL AND "deletedAt" IS NULL
            AND ("sourceReference" IS NULL OR "sourceReference" NOT LIKE 'ouvrage_osm:%')) s`,
  "points-noirs": (d) => d.$queryRaw<LigneEtendue[]>`
    SELECT ST_XMin(e)::float8 AS ouest, ST_XMax(e)::float8 AS est, ST_YMin(e)::float8 AS sud, ST_YMax(e)::float8 AS nord,
           to_char(r, 'YYYY-MM-DD') AS revision
    FROM (SELECT ST_Extent(geom) AS e, MAX("updatedAt") AS r FROM points_noirs WHERE geom IS NOT NULL AND "deletedAt" IS NULL) s`,
  chantiers: (d) => d.$queryRaw<LigneEtendue[]>`
    SELECT ST_XMin(e)::float8 AS ouest, ST_XMax(e)::float8 AS est, ST_YMin(e)::float8 AS sud, ST_YMax(e)::float8 AS nord,
           to_char(r, 'YYYY-MM-DD') AS revision
    FROM (SELECT ST_Extent(geom) AS e, MAX("updatedAt") AS r FROM chantiers WHERE geom IS NOT NULL AND "deletedAt" IS NULL) s`,
  "voirie-locale": (d) => d.$queryRaw<LigneEtendue[]>`
    SELECT ST_XMin(e)::float8 AS ouest, ST_XMax(e)::float8 AS est, ST_YMin(e)::float8 AS sud, ST_YMax(e)::float8 AS nord,
           to_char(r, 'YYYY-MM-DD') AS revision
    FROM (SELECT ST_Extent(geom) AS e, MAX("updatedAt") AS r FROM voirie_locale WHERE geom IS NOT NULL) s`,
};

export const IDENTIFIANTS_AVEC_SOURCE = Object.keys(SOURCES);

export async function contexteDe(fiche: FicheJeu, depot: DepotMetadonnees, opt: OptionsPublication): Promise<Contexte> {
  const base: Contexte = {
    organisme: opt.organisme, courriel: opt.courriel, baseUrl: opt.baseUrl,
    dateFiche: opt.aujourdhui, emprise: null, derniereRevision: null,
  };
  const requete = SOURCES[fiche.id];
  if (!requete) return base;
  try {
    const l = (await requete(depot))[0];
    if (!l) return base;
    const emprise: Emprise | null = [l.ouest, l.est, l.sud, l.nord].every((v) => typeof v === "number")
      ? { ouest: l.ouest as number, est: l.est as number, sud: l.sud as number, nord: l.nord as number }
      : null;
    return { ...base, emprise, derniereRevision: l.revision };
  } catch {
    return base;
  }
}

export interface ResumeFiche {
  id: string; titre: string; resume: string; categorie: string;
  xml: string; lacunes: Lacune[];
}

export async function lister(depot: DepotMetadonnees, opt: OptionsPublication): Promise<ResumeFiche[]> {
  return Promise.all(CATALOGUE.map(async (f) => {
    const ctx = await contexteDe(f, depot, opt);
    return {
      id: f.id, titre: f.titre, resume: f.resume, categorie: f.categorie,
      xml: `/api/public/metadonnees/${f.id}.xml`, lacunes: lacunes(f, ctx),
    };
  }));
}

/** XML d'une fiche, ou null si l'identifiant n'existe pas au catalogue. */
export async function xmlDe(id: string, depot: DepotMetadonnees, opt: OptionsPublication): Promise<string | null> {
  const fiche = trouverFiche(id);
  if (!fiche) return null;
  return construireXml(fiche, await contexteDe(fiche, depot, opt));
}
