/**
 * CONTRAT DE LA CONVERSION GDAL (lot B2) : formats, statuts, machine a etats des jobs, codes d'erreur et messages. Sans E/S, sans base.
 * Contrat du spool : docs/projets-voirie/CHAINE-GDAL.md ; contrat des jobs : docs/projets-voirie/CONTRAT-IMPORT.md section 13.
 *
 * REGLE DES MESSAGES : la sortie du conteneur est NON FIABLE. Un message libre du worker (qui peut citer un chemin, un nom de couche, une ligne
 * d'erreur de GDAL) n'est JAMAIS renvoye : seul un code connu est retenu, et le message affiche est celui de la table ci-dessous.
 */

export const FORMATS_GDAL = ["GPKG", "SHAPEFILE", "DXF"] as const;
export type FormatGdal = (typeof FORMATS_GDAL)[number];

export const STATUTS_JOB = ["EN_ATTENTE", "EN_COURS", "TERMINE", "ECHEC", "ANNULE", "EXPIRE"] as const;
export type StatutJob = (typeof STATUTS_JOB)[number];

/** Statuts qui ne changent plus (la base l'impose aussi : declencheur `projets_voirie_import_jobs_transition`). */
export const STATUTS_FINAUX: ReadonlySet<StatutJob> = new Set<StatutJob>(["ECHEC", "ANNULE", "EXPIRE"]);
export const STATUTS_ACTIFS: readonly StatutJob[] = ["EN_ATTENTE", "EN_COURS"];

/** Transitions permises. Miroir exact du declencheur de la migration 20261102200000 (un test compare les deux). */
export const TRANSITIONS: Readonly<Record<StatutJob, readonly StatutJob[]>> = {
  EN_ATTENTE: ["EN_COURS", "ANNULE", "EXPIRE", "ECHEC"],
  EN_COURS: ["TERMINE", "ECHEC", "ANNULE", "EN_ATTENTE", "EXPIRE"],
  TERMINE: ["EXPIRE"],
  ECHEC: [],
  ANNULE: [],
  EXPIRE: [],
};

export const transitionPermise = (de: StatutJob, vers: StatutJob): boolean => TRANSITIONS[de].includes(vers);

export const UNITES_DXF = ["metre", "degre"] as const;
export type UniteDxf = (typeof UNITES_DXF)[number];

/** Entites DXF lues par la conversion ; tout le reste est ignore ET compte (CHAINE-GDAL.md section 4.2). */
export const ENTITES_DXF_SUPPORTEES = ["LINE", "LWPOLYLINE", "POLYLINE", "3DPOLYLINE"] as const;

/** Libelle de l'unite de $INSUNITS (code DXF) tel que le conteneur le rapporte. Seul 6 (metres) est compatible avec un CRS en metres. */
export const INSUNITS_METRE = 6;
export const INSUNITS_SANS_UNITE = 0;

// ------------------------------------------------------------------------------------------------ Codes d'erreur

/** Un code du conteneur, tel que l'API le rend : code stable, message fixe, et si une nouvelle tentative a un sens. */
export interface DefinitionErreur { message: string; relancable?: boolean }

/**
 * Codes du worker (CHAINE-GDAL.md 4.3 et DXF) et codes propres au backend. Le message est FIXE : il ne reprend aucun texte du conteneur.
 * `INTERROMPU` (redemarrage du worker) est le seul code du conteneur qui justifie une nouvelle tentative : tous les autres sont deterministes.
 */
export const ERREURS_JOB: Readonly<Record<string, DefinitionErreur>> = {
  // entree, demande
  ENTREE_ABSENTE: { message: "Le fichier deposé n'a pas pu être lu par le conteneur de conversion." },
  DEMANDE_INVALIDE: { message: "La demande de conversion a été refusée par le conteneur (paramètres incohérents)." },
  FICHIER_VIDE: { message: "Le fichier est vide." },
  FICHIER_TROP_GROS: { message: "Le fichier dépasse la taille maximale de conversion." },
  FICHIER_TRONQUE: { message: "Le fichier est tronqué ou incomplet." },
  FICHIER_INVALIDE: { message: "Le fichier est invalide ou illisible." },
  FORMAT_NON_RECONNU: { message: "Le contenu n'est ni un GeoPackage, ni une archive de Shapefile, ni un DXF." },
  FORMAT_NON_AUTORISE: { message: "Ce format de fichier n'est pas autorisé (base SQLite autre qu'un GeoPackage, par exemple)." },
  // archive
  ARCHIVE_INVALIDE: { message: "L'archive est corrompue ou illisible." },
  ARCHIVE_TROP_D_ENTREES: { message: "L'archive contient trop d'entrées." },
  ARCHIVE_CHEMIN_DANGEREUX: { message: "L'archive contient un chemin dangereux (remontée de dossier, chemin absolu) : elle est refusée en entier." },
  ARCHIVE_NOMS_AMBIGUS: { message: "L'archive contient des noms d'entrée ambigus ou en double." },
  ARCHIVE_LIEN_SYMBOLIQUE: { message: "L'archive contient un lien symbolique : elle est refusée en entier." },
  ARCHIVE_ENTREE_SPECIALE: { message: "L'archive contient une entrée spéciale (périphérique, tube) : elle est refusée en entier." },
  ARCHIVE_CHIFFREE: { message: "L'archive est chiffrée." },
  ARCHIVE_METHODE_NON_SUPPORTEE: { message: "L'archive utilise une méthode de compression non prise en charge." },
  ARCHIVE_IMBRIQUEE: { message: "L'archive contient une autre archive : elle est refusée." },
  ARCHIVE_TROP_GROSSE: { message: "L'archive est trop volumineuse une fois décompressée." },
  ARCHIVE_TAUX_COMPRESSION: { message: "Le taux de compression de l'archive est anormal (bombe de décompression probable)." },
  ARCHIVE_CHEVAUCHEMENT: { message: "Les entrées de l'archive se recouvrent : elle est refusée." },
  ARCHIVE_SANS_DONNEES: { message: "L'archive ne contient aucun Shapefile." },
  SHAPEFILE_INCOMPLET: { message: "Shapefile incomplet : les fichiers .shp, .shx et .dbf sont tous obligatoires." },
  SHAPEFILE_INVALIDE: { message: "Un fichier du Shapefile est invalide." },
  // lecture, selection
  SOURCE_ILLISIBLE: { message: "Le fichier n'a pas pu être lu par GDAL." },
  PILOTE_INATTENDU: { message: "Le fichier n'a pas été ouvert par le pilote attendu." },
  TROP_DE_COUCHES: { message: "Le fichier contient trop de couches." },
  CHAMPS_TROP_NOMBREUX: { message: "Une couche contient trop de champs." },
  AUCUNE_COUCHE: { message: "Aucune couche géométrique convertible dans le fichier." },
  COUCHE_INTROUVABLE: { message: "La couche demandée n'existe pas dans le fichier." },
  COUCHE_AMBIGUE: { message: "Plusieurs couches portent le même nom." },
  // CRS, conversion
  CRS_CONFLIT: { message: "Le système de coordonnées déclaré par le fichier (.prj, GeoPackage) diffère de l'EPSG confirmé, ou n'a pas de code EPSG identifiable. Un CRS déclaré ne se surcharge pas." },
  CRS_NON_RECONNU: { message: "L'EPSG demandé est inconnu de PROJ." },
  REPROJECTION_ECHEC: { message: "La reprojection vers WGS 84 a échoué (coordonnées incompatibles avec le CRS choisi, ou valeurs aberrantes)." },
  CONVERSION_ECHEC: { message: "La conversion a échoué." },
  TROP_DE_SOMMETS: { message: "Le fichier contient trop de sommets (un objet ou l'ensemble du fichier dépasse le plafond)." },
  TROP_D_OBJETS: { message: "Le fichier contient trop d'objets pour la conversion." },
  AUCUN_OBJET: { message: "Aucun objet dans les couches converties." },
  SORTIE_TROP_GROSSE: { message: "Le résultat de la conversion dépasse la taille autorisée." },
  // DXF
  DXF_BINAIRE_NON_PRIS_EN_CHARGE: { message: "Le DXF binaire n'est pas pris en charge : exportez le dessin en DXF texte (ASCII)." },
  DXF_SANS_ENTITE_SUPPORTEE: { message: "Le DXF ne contient aucune entité prise en charge (LINE, LWPOLYLINE, POLYLINE, 3DPOLYLINE)." },
  DXF_TROP_DE_CALQUES: { message: "Le DXF contient trop de calques." },
  // ressources
  DELAI_DEPASSE: { message: "La conversion a dépassé le délai maximal." },
  MEMOIRE_EPUISEE: { message: "La conversion a épuisé la mémoire autorisée (géométrie trop lourde)." },
  GDAL_PLANTAGE: { message: "Le convertisseur s'est arrêté de façon inattendue sur ce fichier." },
  INTERROMPU: { message: "La conversion a été interrompue (redémarrage du convertisseur).", relancable: true },
  ERREUR_INTERNE: { message: "Erreur interne du convertisseur." },
  // codes propres au backend
  SORTIE_INVALIDE: { message: "Le résultat de la conversion ne respecte pas le contrat attendu et a été refusé." },
  SORTIE_INCOHERENTE: { message: "Le résultat de la conversion est incohérent avec ses propres comptes et a été refusé." },
  SPOOL_INDISPONIBLE: { message: "Le dossier d'échange avec le convertisseur est inaccessible." },
  JOB_PERDU: { message: "Le convertisseur n'a pas répondu dans le délai imparti après plusieurs tentatives." },
  DXF_UNITES_CONFLIT: { message: "Les unités déclarées ne correspondent pas à l'en-tête du DXF ($INSUNITS) : aucune mise à l'échelle n'est faite silencieusement." },
  CONVERSION_EXPIREE: { message: "Le job a expiré avant d'être utilisé." },
};

/** Code de l'API pour un code du conteneur : un code inconnu devient `CONVERSION_ECHEC` (jamais le texte du conteneur). */
export function codeApi(codeWorker: unknown): string {
  return typeof codeWorker === "string" && Object.prototype.hasOwnProperty.call(ERREURS_JOB, codeWorker) ? codeWorker : "CONVERSION_ECHEC";
}

export const messageErreur = (code: string): string => ERREURS_JOB[code]?.message ?? ERREURS_JOB.CONVERSION_ECHEC.message;
export const codeRelancable = (code: string): boolean => ERREURS_JOB[code]?.relancable === true;

// ------------------------------------------------------------------------------------------------ Progression

/** Etape du conteneur (statut.json) vers un pourcentage d'avancement indicatif. */
const PROGRESSION: Readonly<Record<string, number>> = {
  demarrage: 5, copie: 10, detection: 15, "precontrole-archive": 20, extraction: 30, "pre-filtre-dxf": 35, inventaire: 45, conversion: 70, termine: 90,
};
export function progressionDepuisEtape(etape: unknown): number {
  return typeof etape === "string" && Object.prototype.hasOwnProperty.call(PROGRESSION, etape) ? PROGRESSION[etape] : 0;
}

// ------------------------------------------------------------------------------------------------ Decision du sondage

/** Ce que le sondage observe dans le spool pour un job EN_COURS. */
export type ObservationSpool =
  | { etat: "absent" }
  | { etat: "illisible" }
  | { etat: "en_cours"; etape: string | null }
  | { etat: "termine" }
  | { etat: "echec"; code: string | null };

export interface JobObserve {
  statut: StatutJob;
  tentatives: number;
  tentativesMax: number;
  reclameLe: Date | null;
  expireLe: Date;
}

export type Decision =
  | { type: "RIEN" }
  | { type: "PROGRES"; etape: string | null }
  | { type: "VALIDER" }
  | { type: "ECHEC"; code: string }
  | { type: "RELANCER"; raison: string }
  | { type: "EXPIRER" };

export interface ParametresDecision {
  maintenant: Date;
  /** Delai total d'un job cote conteneur, en secondes. */
  delaiJobS: number;
  /** Jobs transmis au conteneur en meme temps (il les traite un par un : un job peut attendre derriere les autres). */
  concurrence: number;
  margeS: number;
}

/** Instant au-dela duquel un job transmis est considere perdu : il peut attendre derriere `concurrence - 1` autres jobs, puis courir `delaiJobS`. */
export function echeancePerte(reclameLe: Date, p: Pick<ParametresDecision, "delaiJobS" | "concurrence" | "margeS">): Date {
  return new Date(reclameLe.getTime() + (p.delaiJobS * p.concurrence + p.margeS) * 1000);
}

/**
 * Machine a etats du sondage, PURE : a partir de l'etat d'un job et de ce que montre le spool, ce qu'il faut faire. Aucune ecriture ici.
 *
 *   - EN_ATTENTE ou TERMINE expires : EXPIRER (fichiers temporaires jamais conserves apres l'expiration) ;
 *   - EN_COURS, resultat `termine` : VALIDER (le resultat n'est cru qu'apres validation stricte) ;
 *   - EN_COURS, resultat `echec` : echec avec le code connu, ou RELANCER si ce code le permet et qu'il reste des tentatives ;
 *   - EN_COURS sans resultat apres l'echeance : RELANCER s'il reste des tentatives, sinon ECHEC `JOB_PERDU` (relance controlee, jamais infinie) ;
 *   - un statut illisible est traite comme une absence jusqu'a l'echeance, puis refuse (`SORTIE_INVALIDE`).
 */
export function decider(job: JobObserve, obs: ObservationSpool | null, p: ParametresDecision): Decision {
  const t = p.maintenant.getTime();
  if (job.statut === "EN_ATTENTE" || job.statut === "TERMINE" || job.statut === "EN_COURS") {
    if (job.expireLe.getTime() <= t) return { type: "EXPIRER" };
  }
  if (job.statut !== "EN_COURS") return { type: "RIEN" };
  const o: ObservationSpool = obs ?? { etat: "absent" };
  if (o.etat === "termine") return { type: "VALIDER" };
  if (o.etat === "echec") {
    const code = codeApi(o.code);
    if (codeRelancable(code) && job.tentatives < job.tentativesMax) return { type: "RELANCER", raison: code };
    return { type: "ECHEC", code };
  }
  const echeance = job.reclameLe ? echeancePerte(job.reclameLe, p).getTime() : t;
  if (t >= echeance) {
    if (job.tentatives < job.tentativesMax) return { type: "RELANCER", raison: "JOB_PERDU" };
    return { type: "ECHEC", code: o.etat === "illisible" ? "SORTIE_INVALIDE" : "JOB_PERDU" };
  }
  if (o.etat === "en_cours") return { type: "PROGRES", etape: o.etape };
  return { type: "RIEN" };
}

// ------------------------------------------------------------------------------------------------ Identifiants du spool

/** Identifiant de dossier du spool d'une tentative : `<uuid du job>-t<n>` (le contrat du conteneur impose ^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$). */
export const RE_SPOOL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-t[1-9]$/;
export const spoolIdDe = (jobId: string, tentative: number): string => `${jobId}-t${tentative}`;
