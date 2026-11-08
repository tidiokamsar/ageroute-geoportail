/**
 * Recherche STAC commune au CDSE et a Earth Search (les deux parlent le STAC API : POST /search,
 * pagination par lien « next »). Les differences (champs `fields`, noms de proprietes) restent dans
 * les adaptateurs ; ici : validation des parametres, pagination bornee, normalisation, diagnostics.
 *
 * BORNES TENUES
 *   - un plafond de pages par collection (defaut 5) et un plafond de produits (defaut 500) ;
 *   - la garde du STAC du CDSE : (page - 1) x limite <= 10 000. Elle est comptee en produits deja lus
 *     (decalage) : on ne demande plus de page au-dela. Source : contrainte relevee par l'agent « sources
 *     reelles » ; la documentation OData du CDSE borne de meme `$skip` a 10 000 ;
 *   - un lien « next » qui pointe hors de l'origine du catalogue est refuse (rien ne part ailleurs).
 */
import { bboxValide, type BBox } from "./geometrie";
import { ClientHttp, assainirTexte, masquerUrl } from "./http";
import { normaliserItemStac, COLLECTIONS_CONNUES } from "./normalisation";
import {
  ErreurSource, classerErreur,
  type CodeSource, type CurseurRecherche, type Diagnostic, type NiveauDiagnostic, type OptionsConnectivite,
  type ParamsRecherche, type ProduitNormalise, type RequeteJournal, type ResultatConnectivite, type ResultatRecherche,
} from "./contrat";

export const PLAFOND_DECALAGE_STAC = 10_000;

/** Boke +-0,1 degre (coordonnees de frontend/src/lib/villes.ts : 10,93 N ; 14,29 O). */
export const ZONE_SONDE_PAR_DEFAUT: BBox = [-14.39, 10.83, -14.19, 11.03];

export interface ConfigStac {
  source: CodeSource;
  fournisseur: "CDSE" | "EARTH_SEARCH";
  /** Racine de l'API STAC, sans barre finale. */
  urlBase: string;
  collectionsParDefaut: string[];
  /** Taille de page par defaut (defaut 50). Earth Search ne peut pas alleger ses items : page plus courte. */
  limiteParDefaut?: number;
  /** Extension `fields` : limite la reponse a ce qui sert (CDSE). Absent = reponse complete. */
  champs?: (collection: string) => { include: string[] } | undefined;
}

export interface ParamsValides {
  bbox: BBox;
  debut: string;
  fin: string;
  nuagesMax: number | undefined;
  collections: string[];
  limite: number;
  pagesMax: number;
  produitsMax: number;
  reprendre: CurseurRecherche | undefined;
}

const entree = (message: string) => new ErreurSource({ code: "ENTREE_INVALIDE", categorie: "ENTREE", message });

function isoCourt(v: string | Date, nom: string): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw entree(`${nom} : date illisible`);
  return d.toISOString().replace(".000Z", "Z");
}

export function validerParams(params: ParamsRecherche, cfg: ConfigStac): ParamsValides {
  if (!bboxValide(params.bbox)) throw entree("bbox invalide : [ouest, sud, est, nord] en degres, ouest < est et sud < nord");
  const debut = isoCourt(params.debut, "debut");
  const fin = isoCourt(params.fin, "fin");
  if (Date.parse(debut) > Date.parse(fin)) throw entree("la fin de la fenetre precede son debut");
  if (params.nuagesMax !== undefined && !(typeof params.nuagesMax === "number" && params.nuagesMax >= 0 && params.nuagesMax <= 100)) {
    throw entree("nuagesMax : un pourcentage entre 0 et 100");
  }
  const collections = params.collections ?? cfg.collectionsParDefaut;
  if (collections.length === 0) throw entree("aucune collection demandee");
  for (const c of collections) if (!COLLECTIONS_CONNUES[c]) throw entree(`collection non prise en charge : ${c}`);
  const entier = (v: number | undefined, defaut: number, min: number, max: number, nom: string) => {
    if (v === undefined) return defaut;
    if (!Number.isInteger(v) || v < min || v > max) throw entree(`${nom} : un entier entre ${min} et ${max}`);
    return v;
  };
  return {
    bbox: params.bbox, debut, fin, nuagesMax: params.nuagesMax, collections,
    limite: entier(params.limiteParPage, cfg.limiteParDefaut ?? 50, 1, 100, "limiteParPage"),
    pagesMax: entier(params.pagesMax, 5, 1, 100, "pagesMax"),
    produitsMax: entier(params.produitsMax, 500, 1, 100_000, "produitsMax"),
    reprendre: params.reprendre,
  };
}

/** Corps de la premiere requete d'une collection. Exporte : les tests le comparent aux fixtures capturees. */
export function construireCorps(cfg: ConfigStac, v: Pick<ParamsValides, "bbox" | "debut" | "fin" | "nuagesMax" | "limite">, collection: string): Record<string, unknown> {
  const corps: Record<string, unknown> = {
    collections: [collection],
    bbox: v.bbox,
    datetime: `${v.debut}/${v.fin}`,
    limit: v.limite,
    sortby: [{ field: "properties.datetime", direction: "desc" }],
  };
  // le seuil de nuages ne s'applique qu'a l'optique : un radar n'a pas de couverture nuageuse
  if (v.nuagesMax !== undefined && COLLECTIONS_CONNUES[collection]?.nature === "OPTIQUE") {
    corps.query = { "eo:cloud_cover": { lte: v.nuagesMax } };
  }
  const champs = cfg.champs?.(collection);
  if (champs) corps.fields = champs;
  return corps;
}

class Diagnostics {
  private m = new Map<string, Diagnostic>();
  ajouter(niveau: NiveauDiagnostic, code: string, message: string, exemple?: string): void {
    const d = this.m.get(code);
    if (d) {
      d.nombre++;
      if (exemple && d.exemples.length < 3 && !d.exemples.includes(exemple)) d.exemples.push(exemple);
    } else {
      this.m.set(code, { niveau, code, message, nombre: 1, exemples: exemple ? [exemple] : [] });
    }
  }
  liste(): Diagnostic[] { return [...this.m.values()]; }
}

interface Suite { methode: "GET" | "POST"; url: string; corps: Record<string, unknown> | null }

/** Lien « next » du fournisseur, ou null. `refuse` vaut true si un lien existait mais pointe hors du catalogue. */
export function lienSuivant(json: Record<string, unknown>, urlBase: string, corpsCourant: Record<string, unknown> | null): { suite: Suite | null; refuse: boolean } {
  const liens = Array.isArray(json.links) ? (json.links as unknown[]) : [];
  const next = liens.find((l): l is Record<string, unknown> => typeof l === "object" && l !== null && (l as { rel?: unknown }).rel === "next");
  if (!next || typeof next.href !== "string") return { suite: null, refuse: false };
  let cible: URL;
  try { cible = new URL(next.href, urlBase); } catch { return { suite: null, refuse: true }; }
  if (cible.origin !== new URL(urlBase).origin) return { suite: null, refuse: true };
  const methode = String(next.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  if (methode === "GET") return { suite: { methode, url: cible.toString(), corps: null }, refuse: false };
  const corpsLien = typeof next.body === "object" && next.body !== null ? (next.body as Record<string, unknown>) : {};
  const corps = next.merge === true ? { ...(corpsCourant ?? {}), ...corpsLien } : corpsLien;
  return { suite: { methode, url: cible.toString(), corps }, refuse: false };
}

export async function rechercherStac(cfg: ConfigStac, client: ClientHttp, params: ParamsRecherche): Promise<ResultatRecherche> {
  const v = validerParams(params, cfg);
  const diag = new Diagnostics();
  const requetes: RequeteJournal[] = [];
  const produits: ProduitNormalise[] = [];
  const vus = new Set<string>();
  let pagesLues = 0;
  let produitsLus = 0;
  let latenceMs = 0;
  let total: number | null = 0;
  let suivant: CurseurRecherche | null = null;
  let raison: ResultatRecherche["pagination"]["raisonArret"] = "FIN";

  const collections = v.reprendre ? [v.reprendre.collection] : v.collections;
  for (const collection of collections) {
    let suite: Suite = v.reprendre && v.reprendre.collection === collection
      ? { methode: v.reprendre.methode, url: v.reprendre.url, corps: v.reprendre.corps }
      : { methode: "POST", url: `${cfg.urlBase}/search`, corps: construireCorps(cfg, v, collection) };
    let decalage = v.reprendre && v.reprendre.collection === collection ? v.reprendre.decalage : 0;
    let pagesCollection = 0;

    for (;;) {
      const curseur: CurseurRecherche = { collection, methode: suite.methode, url: suite.url, corps: suite.corps, decalage };
      // garde du CDSE : (page - 1) x limite <= 10 000
      if (decalage > PLAFOND_DECALAGE_STAC) {
        diag.ajouter("AVERTISSEMENT", "PLAFOND_DECALAGE", `la pagination s'arrete a ${PLAFOND_DECALAGE_STAC} produits lus par collection (garde du STAC)`, collection);
        if (!suivant) { suivant = curseur; raison = "PLAFOND_DECALAGE"; }
        break;
      }
      if (pagesCollection >= v.pagesMax) {
        diag.ajouter("INFO", "PLAFOND_PAGES", `plafond de ${v.pagesMax} page(s) par collection atteint : la liste est incomplete`, collection);
        if (!suivant) { suivant = curseur; raison = "PLAFOND_PAGES"; }
        break;
      }
      if (produits.length >= v.produitsMax) {
        diag.ajouter("INFO", "PLAFOND_PRODUITS", `plafond de ${v.produitsMax} produit(s) atteint : la liste est incomplete`, collection);
        if (!suivant) { suivant = curseur; raison = "PLAFOND_PRODUITS"; }
        break;
      }

      const rep = await client.json({ methode: suite.methode, url: suite.url, corps: suite.corps ?? undefined });
      latenceMs += rep.latenceMs;
      requetes.push({ methode: suite.methode, url: masquerUrl(suite.url), statut: rep.statut, latenceMs: rep.latenceMs, tentatives: rep.tentatives, octets: rep.octets });
      pagesLues++;
      pagesCollection++;

      const json = rep.json;
      if (typeof json !== "object" || json === null || !Array.isArray((json as { features?: unknown }).features)) {
        throw new ErreurSource({ code: "REPONSE_ILLISIBLE", categorie: "INDISPONIBLE", source: cfg.source, message: "reponse de recherche sans liste `features`", requete: client.decrire({ methode: suite.methode, url: suite.url, corps: suite.corps ?? undefined }) });
      }
      const obj = json as Record<string, unknown>;
      const items = obj.features as unknown[];
      const annonce = typeof obj.numberMatched === "number" ? obj.numberMatched
        : typeof (obj.context as { matched?: unknown } | undefined)?.matched === "number" ? (obj.context as { matched: number }).matched : null;
      total = total !== null && annonce !== null ? total + annonce : null;

      // Le serveur n'est pas cru sur la taille de sa page : on lit au plus `limite` items (celle qu'on a demandee), et jamais assez pour
      // depasser `produitsMax` (un catalogue hostile rendait 1000 items pour un plafond de 200). Ce qu'on ne lit pas est SIGNALE.
      const examinables = items.length > v.limite ? items.slice(0, v.limite) : items;
      const pageTronquee = examinables.length < items.length;
      let plafondAtteint = false;
      for (const item of examinables) {
        if (produits.length >= v.produitsMax) { plafondAtteint = true; break; }
        produitsLus++;
        const r = normaliserItemStac(item, { source: cfg.source, fournisseur: cfg.fournisseur, collection });
        if (!r.ok) { diag.ajouter("AVERTISSEMENT", `PRODUIT_ECARTE_${r.code}`, `produit ecarte : ${r.message}`, r.identifiant ?? undefined); continue; }
        for (const a of r.avertissements) diag.ajouter("AVERTISSEMENT", a.code, a.message, r.produit.identifiantFournisseur);
        const p = r.produit;
        if (vus.has(p.identifiantFournisseur)) { diag.ajouter("INFO", "DOUBLON_PAGINATION", "meme produit rendu deux fois par la pagination : un seul garde", p.identifiantFournisseur); continue; }
        // controle de securite : le serveur filtre deja, on ne se fie pas a lui seul
        if (v.nuagesMax !== undefined && p.couvertureNuagesPct !== null && p.couvertureNuagesPct > v.nuagesMax) {
          diag.ajouter("INFO", "NUAGES_AU_DESSUS_SEUIL", "produit au-dessus du seuil de nuages, rendu malgre le filtre du serveur : ecarte", p.identifiantFournisseur);
          continue;
        }
        vus.add(p.identifiantFournisseur);
        produits.push(p);
      }

      if (plafondAtteint || pageTronquee) {
        // La page courante n'a pas ete lue en entier : on s'arrete ici (une page suivante cacherait le trou) et on reprendra a elle.
        if (plafondAtteint) diag.ajouter("INFO", "PLAFOND_PRODUITS", `plafond de ${v.produitsMax} produit(s) atteint en milieu de page : la liste est incomplete`, collection);
        if (pageTronquee) diag.ajouter("AVERTISSEMENT", "PAGE_TROP_GRANDE", `le catalogue a rendu ${items.length} items pour une page de ${v.limite} : seuls les ${v.limite} premiers sont lus`, collection);
        if (!suivant) { suivant = curseur; raison = plafondAtteint ? "PLAFOND_PRODUITS" : "PAGE_TRONQUEE"; }
        break;
      }

      decalage += items.length;
      const { suite: prochaine, refuse } = lienSuivant(obj, cfg.urlBase, suite.corps);
      if (refuse) diag.ajouter("ERREUR", "LIEN_SUIVANT_REFUSE", "le lien « next » pointe hors du catalogue interroge : refuse", collection);
      if (!prochaine || items.length === 0) break;
      suite = prochaine;
    }
  }

  return {
    produits,
    pagination: { pagesLues, produitsLus, limiteParPage: v.limite, totalAnnonce: total, suivant, raisonArret: raison },
    diagnostics: diag.liste(),
    requetes,
    latenceMs,
  };
}

// --------------------------------------------------------------------------------------------
// Metadonnees d'un produit
// --------------------------------------------------------------------------------------------

/** Collection deduite de la forme de l'identifiant, ou null. Les deux catalogues n'ont pas la meme grammaire. */
export function deduireCollection(id: string): string | null {
  if (/_MSIL2A_/.test(id) || /_L2A$/.test(id)) return "sentinel-2-l2a";
  if (/_MSIL1C_/.test(id) || /_L1C$/.test(id)) return "sentinel-2-l1c";
  if (/^S1[A-D]_[A-Z0-9]{2}_GRD/.test(id)) return "sentinel-1-grd";
  if (/^L[COTEM]\d{2}_L2/.test(id)) return "landsat-c2-l2";
  return null;
}

export async function chargerProduit(
  cfg: ConfigStac, client: ClientHttp, identifiant: string, collectionDemandee?: string,
): Promise<ProduitNormalise | null> {
  if (typeof identifiant !== "string" || identifiant.trim() === "" || identifiant.length > 200) throw entree("identifiant de produit invalide");
  const collection = collectionDemandee ?? deduireCollection(identifiant);
  if (!collection || !COLLECTIONS_CONNUES[collection]) throw entree("collection indeterminable : la fournir en option");
  const url = `${cfg.urlBase}/collections/${collection}/items/${encodeURIComponent(identifiant)}`;
  let rep;
  try {
    rep = await client.json({ methode: "GET", url });
  } catch (e) {
    if (e instanceof ErreurSource && e.statutHttp === 404) return null;
    throw e;
  }
  const r = normaliserItemStac(rep.json, { source: cfg.source, fournisseur: cfg.fournisseur, collection });
  if (!r.ok) {
    throw new ErreurSource({ code: "REPONSE_ILLISIBLE", categorie: "INDISPONIBLE", source: cfg.source, message: `produit ${identifiant} inexploitable : ${r.message}`, requete: client.decrire({ methode: "GET", url }) });
  }
  return r.produit;
}

// --------------------------------------------------------------------------------------------
// Connectivite
// --------------------------------------------------------------------------------------------

/**
 * UNE requete de recherche, sans identifiants. Rend au plus PRODUIT_DISPONIBLE : AUTHENTIFIEE et
 * TRAITEMENT_OPERATIONNEL ne se prouvent pas par une recherche anonyme (contrat API §4).
 */
export async function sonderStac(
  cfg: ConfigStac, client: ClientHttp, options: OptionsConnectivite, maintenant: () => number,
): Promise<ResultatConnectivite> {
  const verifieLe = new Date(maintenant()).toISOString();
  if (options.sansReseau) {
    return { etatAtteint: "CONFIGUREE", message: "adaptateur configure ; aucun test reseau demande", latenceMs: 0, requete: null, produitsTrouves: null, categorieErreur: null, verifieLe };
  }
  const bbox = options.bbox ?? ZONE_SONDE_PAR_DEFAUT;
  const jours = options.joursFenetre ?? 60;
  const fin = new Date(maintenant());
  const debut = new Date(fin.getTime() - jours * 86_400_000);
  const collection = cfg.collectionsParDefaut[0];
  const params: ParamsRecherche = { bbox, debut, fin, collections: [collection], limiteParPage: 1, pagesMax: 1, produitsMax: 1 };
  let requete: string | null = null;
  const t0 = maintenant();
  try {
    const v = validerParams(params, cfg);
    requete = client.decrire({ methode: "POST", url: `${cfg.urlBase}/search`, corps: construireCorps(cfg, v, collection) });
    const r = await rechercherStac(cfg, client, params);
    const latenceMs = maintenant() - t0;
    if (r.produits.length > 0) {
      return { etatAtteint: "PRODUIT_DISPONIBLE", message: `catalogue accessible sans identifiants ; au moins un produit ${collection} dans les ${jours} derniers jours`, latenceMs, requete, produitsTrouves: r.produits.length, categorieErreur: null, verifieLe };
    }
    const ecartes = r.pagination.produitsLus > 0;
    return {
      etatAtteint: "ACCESSIBLE",
      message: ecartes
        ? `catalogue accessible ; le produit rendu a ete ecarte a la normalisation (${r.diagnostics.map((d) => d.code).join(", ")})`
        : `catalogue accessible sans identifiants ; aucun produit ${collection} dans les ${jours} derniers jours sur la zone sondee`,
      latenceMs, requete, produitsTrouves: 0, categorieErreur: null, verifieLe,
    };
  } catch (e) {
    const categorie = classerErreur(e);
    const brut = e instanceof Error ? e.message : String(e);
    return { etatAtteint: "EN_ERREUR", message: `${categorie} : ${assainirTexte(brut, [], 300)}`, latenceMs: maintenant() - t0, requete, produitsTrouves: null, categorieErreur: categorie, verifieLe };
  }
}
