/**
 * Contrat commun des sources satellitaires (chantier EO-SOURCES). Types et erreurs, aucun acces base,
 * aucun reseau : le noyau que les adaptateurs implementent et que la selection et l'API consomment.
 *
 * CE QUE LE CONTRAT GARANTIT
 *   - un produit est normalise de la meme facon quel que soit le catalogue (champs, unites, licence) ;
 *   - une valeur absente chez le fournisseur reste ABSENTE (null), jamais un zero ou une valeur
 *     plausible : couverture nuageuse d'un radar, taille d'un fichier non annoncee, etc. ;
 *   - une URL d'acces n'est jamais « a ouvrir dans le navigateur » : `urlApercu` decrit un acces a
 *     executer COTE SERVEUR, avec le mode d'authentification requis, sans aucun secret ;
 *   - la connectivite ne depasse jamais PRODUIT_DISPONIBLE et ne declare jamais
 *     TRAITEMENT_OPERATIONNEL : cet etat exige un traitement reel reussi (contrat API §4) ;
 *   - le traitement (declencher, suivre, recuperer) n'est PAS implemente ici : il rend NON_SUPPORTE,
 *     sans simulation (Lot suivant).
 */
import type { BBox, PolygoneGeoJson } from "./geometrie";

export type { BBox, PolygoneGeoJson } from "./geometrie";

export const CODES_SOURCE = ["cdse-stac", "earth-search", "planetscope", "spot"] as const;
export type CodeSource = (typeof CODES_SOURCE)[number];

export type Capteur = "SENTINEL-2" | "SENTINEL-1" | "LANDSAT";
export type NatureObservation = "OPTIQUE" | "RADAR";
/** L1C : reflectance au sommet de l'atmosphere. L2A : reflectance de surface. L1_GRD : radar detecte, projete. */
export type NiveauTraitement = "L1C" | "L2A" | "L1_GRD" | "L2";

/** Echelle du contrat API §4, restreinte a ce qu'une verification SANS identifiants peut atteindre. */
export type EtatConnectivite = "CONFIGUREE" | "ACCESSIBLE" | "PRODUIT_DISPONIBLE" | "EN_ERREUR" | "EN_ATTENTE_CONFIGURATION";

// --------------------------------------------------------------------------------------------
// Erreurs
// --------------------------------------------------------------------------------------------

/**
 * Six categories demandees par le chantier, plus NON_SUPPORTE : une operation qui n'existe pas dans
 * ce lot n'est ni une panne reseau ni une entree invalide, et l'API doit pouvoir la repondre autrement
 * qu'un 503.
 */
export type CategorieErreur = "QUOTA" | "AUTH" | "RESEAU" | "INDISPONIBLE" | "ENTREE" | "INCONNUE" | "NON_SUPPORTE";

export type CodeErreurSource =
  | "HTTP_QUOTA" | "HTTP_AUTH" | "HTTP_ENTREE" | "HTTP_INDISPONIBLE"
  | "RESEAU" | "DELAI_DEPASSE" | "REPONSE_ILLISIBLE" | "REPONSE_TROP_GROSSE" | "REDIRECTION_REFUSEE"
  | "ENTREE_INVALIDE" | "PRODUIT_INTROUVABLE" | "NON_SUPPORTE" | "INCONNUE";

export class ErreurSource extends Error {
  readonly code: CodeErreurSource;
  readonly categorie: CategorieErreur;
  readonly source: string | null;
  readonly statutHttp: number | null;
  /** Attente demandee par le fournisseur (en-tete Retry-After), en ms. Null si non annoncee. */
  readonly retryApresMs: number | null;
  readonly tentatives: number;
  /** Description de la requete SANS secret (methode + URL assainie), pour le diagnostic. */
  readonly requete: string | null;

  constructor(init: {
    code: CodeErreurSource; categorie: CategorieErreur; message: string; source?: string | null;
    statutHttp?: number | null; retryApresMs?: number | null; tentatives?: number; requete?: string | null; cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ErreurSource";
    this.code = init.code;
    this.categorie = init.categorie;
    this.source = init.source ?? null;
    this.statutHttp = init.statutHttp ?? null;
    this.retryApresMs = init.retryApresMs ?? null;
    this.tentatives = init.tentatives ?? 0;
    this.requete = init.requete ?? null;
  }
}

/**
 * Classe n'importe quelle erreur. Une ErreurSource porte deja sa categorie ; une erreur de `fetch`
 * (TypeError « fetch failed », AbortError, TimeoutError) est RESEAU ; le reste est INCONNUE, jamais
 * rattache a une categorie par supposition.
 */
export function classerErreur(e: unknown): CategorieErreur {
  if (e instanceof ErreurSource) return e.categorie;
  const x = e as { name?: string; cause?: { code?: string } } | null;
  if (x && (x.name === "AbortError" || x.name === "TimeoutError")) return "RESEAU";
  if (x instanceof TypeError && /fetch failed|network|terminated/i.test(String((x as Error).message))) return "RESEAU";
  if (x?.cause?.code && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR)/.test(String(x.cause.code))) return "RESEAU";
  return "INCONNUE";
}

// --------------------------------------------------------------------------------------------
// Produit normalise
// --------------------------------------------------------------------------------------------

/**
 * Qui peut lire ce lien, d'apres l'hote et le protocole.
 * ANONYME : verifie par une requete sans compte (donnees du chantier).
 * JETON_OIDC : exige un jeton OpenID Connect (telechargement CDSE : 401 sans jeton, constate).
 * CLES_S3 : bucket s3://eodata du CDSE (403 sans cles, constate).
 * IDENTIFIANTS_CLOUD : autre s3:// (AWS) : exige les identifiants du cloud concerne.
 * INCONNU : acces anonyme non verifie ; ne jamais le presenter comme libre.
 */
export type AccesLien = "ANONYME" | "JETON_OIDC" | "CLES_S3" | "IDENTIFIANTS_CLOUD" | "INCONNU";

export interface LienActif {
  cle: string;
  /** URL sans identifiant ni parametre de requete (signature, jeton) : voir assainirUrl. */
  href: string;
  type: string | null;
  roles: string[];
  resolutionM: number | null;
  tailleOctets: number | null;
  acces: AccesLien;
}

export interface LicenceProduit {
  code: "COPERNICUS-SENTINEL" | "USGS-LANDSAT-DOMAINE-PUBLIC";
  /** Mention a afficher quand une donnee derivee est publiee. */
  attribution: string;
  url: string | null;
}

export interface OrbiteProduit {
  numeroRelatif: number | null;
  numeroAbsolu: number | null;
  sens: "ascending" | "descending" | null;
}

export interface ProduitNormalise {
  identifiantFournisseur: string;
  /** Nom du fournisseur du catalogue, pas du satellite. */
  fournisseur: "CDSE" | "EARTH_SEARCH";
  source: CodeSource;
  collection: string;
  capteur: Capteur;
  nature: NatureObservation;
  plateforme: string | null;
  typeProduit: string | null;
  niveauTraitement: NiveauTraitement;
  /** ISO 8601 UTC. */
  dateAcquisition: string;
  dateFinAcquisition: string | null;
  emprise: PolygoneGeoJson;
  orbite: OrbiteProduit;
  /** Tuile MGRS (Sentinel-2) sans prefixe, ex. « 28PET ». Null hors Sentinel-2. */
  tuileMgrs: string | null;
  /** Code de grille tel que le fournisseur le donne : « MGRS-28PET », « WRS2-203053 ». */
  grille: string | null;
  /** Identifiant de scene commun aux catalogues, sert a reconnaitre un meme produit chez deux fournisseurs. */
  scene: string;
  /** Cle de deduplication entre catalogues : meme cle = meme prise de vue. */
  cleScene: string;
  /** Resolution spatiale native la plus fine des bandes principales, en metres. */
  resolutionNativeM: number;
  /** Resolution native par bande ou polarisation, en metres. */
  resolutionParBande: Record<string, number>;
  /** D'ou viennent les valeurs ci-dessus : lues dans les metadonnees du fournisseur, ou table documentee du capteur. */
  resolutionOrigine: "FOURNISSEUR" | "TABLE_CAPTEUR";
  /** Pas d'echantillonnage du pixel si different de la resolution (radar GRD : 10 m pour 20 x 22 m). */
  echantillonnageM: number | null;
  /** Couverture nuageuse annoncee, en %. Null pour un radar ou si le fournisseur ne la donne pas. Jamais 0 par defaut. */
  couvertureNuagesPct: number | null;
  /** Etendue de la mesure : la tuile ou la scene ENTIERE, pas la zone demandee. Pre-filtre, pas verite locale. */
  nuagesPortee: "TUILE" | "SCENE" | null;
  licence: LicenceProduit;
  tailleOctetsAnnoncee: number | null;
  liens: { vignette: LienActif | null; actifs: LienActif[] };
  /** Calculee seulement apres telechargement et lecture du fichier : toujours null dans un catalogue. */
  empreinteSha256: null;
  /** Sous-ensemble reduit de la reponse du fournisseur (provenance), sans lien ni secret. */
  brut: Record<string, unknown>;
}

// --------------------------------------------------------------------------------------------
// Recherche
// --------------------------------------------------------------------------------------------

export interface ParamsRecherche {
  /** ouest, sud, est, nord, en degres. */
  bbox: BBox;
  debut: string | Date;
  fin: string | Date;
  /** Seuil de couverture nuageuse de la TUILE (%), pour les collections optiques seulement. */
  nuagesMax?: number;
  /** Collections visees ; defaut : celles que l'adaptateur declare par defaut. */
  collections?: string[];
  /** 1 a 100, defaut 50. */
  limiteParPage?: number;
  /** Plafond de pages lues par collection, defaut 5. */
  pagesMax?: number;
  /** Plafond de produits conserves au total, defaut 500. */
  produitsMax?: number;
  /** Reprise d'une recherche interrompue par un plafond (valeur rendue dans `pagination.suivant`). */
  reprendre?: CurseurRecherche;
}

export interface CurseurRecherche {
  collection: string;
  /** Requete de la page suivante, telle que le fournisseur l'a annoncee (lien « next »). */
  methode: "GET" | "POST";
  url: string;
  corps: Record<string, unknown> | null;
  /** Nombre de produits deja lus pour cette collection (garde de decalage). */
  decalage: number;
}

export type NiveauDiagnostic = "INFO" | "AVERTISSEMENT" | "ERREUR";

export interface Diagnostic {
  niveau: NiveauDiagnostic;
  code: string;
  message: string;
  /** Nombre d'occurrences regroupees sous ce diagnostic. */
  nombre: number;
  /** Quelques identifiants, jamais la liste complete. */
  exemples: string[];
}

export interface RequeteJournal {
  methode: "GET" | "POST";
  url: string;
  statut: number | null;
  latenceMs: number;
  tentatives: number;
  octets: number;
}

export interface ResultatRecherche {
  produits: ProduitNormalise[];
  pagination: {
    pagesLues: number;
    produitsLus: number;
    limiteParPage: number;
    /** Total annonce par le fournisseur (Earth Search le donne, le STAC du CDSE non). */
    totalAnnonce: number | null;
    /** Non nul si la recherche s'est arretee sur un plafond alors qu'il y avait une suite. */
    suivant: CurseurRecherche | null;
    raisonArret: "FIN" | "PLAFOND_PAGES" | "PLAFOND_PRODUITS" | "PLAFOND_DECALAGE" | "PAGE_TRONQUEE";
  };
  diagnostics: Diagnostic[];
  requetes: RequeteJournal[];
  latenceMs: number;
}

// --------------------------------------------------------------------------------------------
// Aperçu, quotas, connectivite
// --------------------------------------------------------------------------------------------

/**
 * Description d'un acces a executer COTE SERVEUR (le serveur lit le fichier et le sert). Elle ne
 * contient jamais de secret : `authentification` dit ce dont le serveur a besoin, il ne le porte pas.
 */
export interface DescriptionAcces {
  executionCote: "SERVEUR";
  /** Une tentative d'acces cote serveur est possible avec ce qu'on sait. Ne veut pas dire qu'elle reussira. */
  disponible: boolean;
  /** L'acces a ete constate par une requete reelle (sinon : a tenter, et a repondre APERCU_INDISPONIBLE en cas d'echec). */
  verifie: boolean;
  /** Pourquoi il n'y a rien a servir (vignette absente, interface non configuree...). */
  raison: string | null;
  methode: "GET" | null;
  url: string | null;
  authentification: AccesLien;
  typeContenu: string | null;
  note: string;
}

export interface LimiteConnue {
  cle: string;
  libelle: string;
  /** Null quand la documentation ne chiffre pas la limite. Jamais une valeur supposee. */
  valeur: number | null;
  unite: string | null;
  /** S'applique-t-elle a la recherche de catalogue de cet adaptateur ? */
  concerneRecherche: boolean;
  source: { url: string; consulteLe: string };
  note: string | null;
}

export interface CompteursRequetes {
  /** Requetes HTTP reellement envoyees, nouvelles tentatives comprises. */
  requetesEnvoyees: number;
  /** Appels logiques (une recherche = un appel, quel que soit le nombre de tentatives). */
  appelsLogiques: number;
  nouvellesTentatives: number;
  reponses2xx: number;
  reponses429: number;
  reponses5xx: number;
  autresStatuts: number;
  echecsReseau: number;
  delaisDepasses: number;
  octetsRecus: number;
  /** Requetes envoyees pendant les 60 dernieres secondes (a comparer a une limite par minute). */
  derniereMinute: number;
  premiereRequeteLe: string | null;
  derniereRequeteLe: string | null;
}

export interface InstantaneQuotas {
  source: CodeSource;
  /** Compteurs DE LA SESSION (processus courant) : ils repartent de zero au redemarrage. */
  compteurs: CompteursRequetes;
  limites: LimiteConnue[];
}

export interface OptionsConnectivite {
  /** Zone de la sonde ; defaut : Boke +-0,1 degre (coordonnees de frontend/src/lib/villes.ts). */
  bbox?: BBox;
  /** Fenetre de la sonde, en jours avant maintenant (defaut 60). */
  joursFenetre?: number;
  /** N'envoie rien : rend CONFIGUREE si l'adaptateur est configure. */
  sansReseau?: boolean;
}

export interface ResultatConnectivite {
  etatAtteint: EtatConnectivite;
  message: string;
  latenceMs: number;
  /** Requete de la sonde, sans secret. Null si rien n'a ete envoye. */
  requete: string | null;
  produitsTrouves: number | null;
  categorieErreur: CategorieErreur | null;
  verifieLe: string;
}

// --------------------------------------------------------------------------------------------
// Descriptif et adaptateur
// --------------------------------------------------------------------------------------------

export interface DescriptifCollection {
  id: string;
  capteur: Capteur;
  nature: NatureObservation;
  niveau: NiveauTraitement;
  /** Une collection de recherche seulement ne peut pas etre traitee dans ce lot. */
  parDefaut: boolean;
}

export interface DescriptifSource {
  code: CodeSource;
  nom: string;
  fournisseur: string;
  /** « INTERFACE_ACTIVE » : le catalogue est interrogeable. « FACADE » : interface prevue, rien n'est contacte. */
  interface: "INTERFACE_ACTIVE" | "FACADE";
  urlService: string | null;
  capteurs: string[];
  collections: DescriptifCollection[];
  /** Resolutions natives par capteur puis par bande (m). Vide pour une facade : rien n'est affirme. */
  resolutionsNatives: Record<string, Record<string, number>>;
  licence: { libelle: string; url: string | null; attribution: string };
  exigencesAcces: {
    recherche: "ANONYME" | "COMPTE" | "NON_DISPONIBLE";
    telechargement: "ANONYME" | "COMPTE" | "VARIABLE" | "NON_DISPONIBLE";
    traitement: "COMPTE" | "NON_DISPONIBLE";
    /** NOMS des variables d'environnement attendues, jamais leurs valeurs. */
    variablesEnvironnement: string[];
  };
}

export interface OptionsMetadonnees {
  collection?: string;
}

export interface SourceAdaptateur {
  readonly code: CodeSource;
  readonly descriptif: DescriptifSource;
  rechercher(params: ParamsRecherche): Promise<ResultatRecherche>;
  /** Null si le fournisseur ne connait pas l'identifiant (404). */
  metadonnees(identifiant: string, options?: OptionsMetadonnees): Promise<ProduitNormalise | null>;
  urlApercu(produit: ProduitNormalise): DescriptionAcces;
  verifierConnectivite(options?: OptionsConnectivite): Promise<ResultatConnectivite>;
  /** Non implemente dans ce lot : rejette ErreurSource NON_SUPPORTE. Aucune simulation. */
  declencherTraitement(demande?: unknown): Promise<never>;
  statutTraitement(identifiant?: string): Promise<never>;
  recupererResultat(identifiant?: string): Promise<never>;
  classerErreur(e: unknown): CategorieErreur;
  quotas(): InstantaneQuotas;
}

export function erreurNonSupporte(source: CodeSource, operation: string): ErreurSource {
  return new ErreurSource({
    code: "NON_SUPPORTE", categorie: "NON_SUPPORTE", source,
    message: `${operation} n'est pas implemente : le traitement n'existe pas dans ce lot et n'est pas simule`,
  });
}
