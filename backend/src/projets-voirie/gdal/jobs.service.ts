/**
 * JOBS DE CONVERSION GDAL (lot B2) : creation, lecture, annulation, chargement du resultat valide pour le pipeline commun. Contrat : docs/projets-voirie/
 * CONTRAT-IMPORT.md section 13 et API.md.
 *
 *   - TOUT est derriere l'interrupteur `PROJETS_VOIRIE_GDAL` (DESACTIVE par defaut) : desactive, aucun acces au spool ni au conteneur ;
 *   - le fichier est depose dans le dossier PRIVE du backend (prive/<jobId>/, jamais monte dans le conteneur) APRES l'insertion de la ligne : une ligne existe
 *     toujours pour un depot ; le sondage (`traiteur.ts`) le copie dans entree/<spoolId>/ et publie `demande.json` A LA RECLAMATION seulement, puis retire
 *     entree/<spoolId>/ des la fin du job : le conteneur ne voit que les fichiers des jobs qu'il traite (M2 de la revue) ;
 *   - cadence, plafonds par compte et par projet, file globale, resultats non utilises : sous le VERROU DU PROJET puis un VERROU CONSULTATIF GLOBAL (les
 *     compteurs qui depassent le projet ne se comptent pas entre deux projets en meme temps : m6 de la revue) ;
 *   - un job n'est utilisable qu'une fois (un depot) : la consommation est ecrite dans la transaction du depot (`consommerDansTx`) ;
 *   - le resultat est RE-VALIDE a chaque usage et son empreinte comparee a celle du resume : un fichier du spool modifie apres validation est refuse ;
 *   - audit sans geometrie : fichier, empreinte, taille, format, parametres, codes.
 */

import { createHash, randomUUID } from "node:crypto";
import { Prisma, type JobImportProjet } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Limiteur } from "../../import/limiteur";
import { logAuditTransactionnelle } from "../../utils/audit";
import { ErreurMetier } from "../erreurs";
import { crsSourceAutorises, limitesZip } from "../formats/import.config";
import { resoudreCrs } from "../formats/crs.service";
import { ErreurLecture, type Avertissement } from "../lecture.types";
import { sommetsParFichierMax, sommetsParObjetMax } from "../config";
import { verrouillerProjet, type Acteur, type Tx } from "../projets.service";
import { gdalActif, reglagesGdal, spoolPrive, spoolRacine } from "./config";
import {
  ERREURS_JOB, FORMATS_GDAL, STATUTS_ACTIFS, messageErreur, spoolIdDe, type FormatGdal, type StatutJob, type UniteDxf,
} from "./contrat.noyau";
import { assembler, ecartsAvecResume, resumer, type ConversionValidee, type CoucheLue, type ParametresJob, type ResumeJob } from "./conversion.noyau";
import { classerErreurFinalisation } from "./finalisation.noyau";
import { detecterFormatGdal, EXTENSION_DE_FORMAT } from "./format.noyau";
import {
  disponibiliteSpool, lireCoucheVersValidateur, lireInventaireBrut, lireResultatBrut, ouvrirSpool, purger, purgerEntree, purgerPrive, stagerPrive, type Spool,
} from "./spool";
import {
  ErreurSortie, LIMITES_COUCHE_DEFAUT, ValidateurCouche, codeDeErreurSortie, controlerResultat, controlerUniteContreCrs, slugDeFichier, validerResultat,
  type AttendusJob,
} from "./sortie.noyau";

/** Journal sans chemin ni contenu : le type de l'erreur et son code. */
const journalErreur = (contexte: string, e: unknown): void => {
  const code = (e as NodeJS.ErrnoException)?.code;
  console.warn(`[gdal] ${contexte} : ${e instanceof Error ? e.name : "erreur"}${typeof code === "string" ? ` (${code})` : ""}`);
};

// ------------------------------------------------------------------------------------------------ Disponibilite

export interface Disponibilite { actif: boolean; disponible: boolean; raison: string | null }

/** Etat annonce par `GET import/options` : desactive = indisponible sans toucher au spool ; active = le dossier d'echange doit etre accessible. */
export async function disponibilite(): Promise<Disponibilite> {
  if (!gdalActif()) return { actif: false, disponible: false, raison: "interrupteur PROJETS_VOIRIE_GDAL desactive" };
  const racine = spoolRacine();
  if (racine === null) return { actif: true, disponible: false, raison: "PROJETS_VOIRIE_GDAL_SPOOL non configure" };
  const d = await disponibiliteSpool(ouvrirSpool(racine, spoolPrive()));
  return d.ok ? { actif: true, disponible: true, raison: null } : { actif: true, disponible: false, raison: d.raison };
}

/** Spool de travail, ou une erreur typee : desactive = 503 GDAL_DESACTIVE, non configure = 503 SPOOL_INDISPONIBLE. Aucun acces disque ici. */
export function spoolOuvert(): Spool {
  if (!gdalActif()) throw new ErreurMetier(503, "GDAL_DESACTIVE", "Le traitement GDAL est désactivé sur ce serveur (interrupteur PROJETS_VOIRIE_GDAL).");
  const racine = spoolRacine();
  if (racine === null) throw new ErreurMetier(503, "SPOOL_INDISPONIBLE", ERREURS_JOB.SPOOL_INDISPONIBLE.message);
  return ouvrirSpool(racine, spoolPrive());
}

// ------------------------------------------------------------------------------------------------ Vue

export interface JobVue {
  id: string;
  projetId: string;
  format: string;
  statut: StatutJob;
  nomFichier: string;
  tailleOctets: number;
  sha256: string;
  parametres: Record<string, unknown>;
  etape: string | null;
  progression: number;
  codeErreur: string | null;
  messageErreur: string | null;
  tentatives: number;
  tentativesMax: number;
  creeLe: string;
  reclameLe: string | null;
  finLe: string | null;
  expireLe: string;
  fichiersPurges: boolean;
  /** Vrai si le resultat peut encore servir d'entree a l'apercu et au depot. */
  utilisable: boolean;
  jeuId: string | null;
  resume: ResumeJob | null;
}

export function vueJob(j: JobImportProjet, maintenant: Date = new Date()): JobVue {
  const termine = j.statut === "TERMINE";
  return {
    id: j.id, projetId: j.projetId, format: j.format, statut: j.statut, nomFichier: j.nomFichier, tailleOctets: j.tailleOctets, sha256: j.sha256,
    parametres: (j.parametres ?? {}) as Record<string, unknown>, etape: j.etape, progression: j.progression,
    codeErreur: j.codeErreur, messageErreur: j.codeErreur ? messageErreur(j.codeErreur) : null,
    tentatives: j.tentatives, tentativesMax: j.tentativesMax,
    creeLe: j.createdAt.toISOString(), reclameLe: j.reclameLe?.toISOString() ?? null, finLe: j.finLe?.toISOString() ?? null, expireLe: j.expireLe.toISOString(),
    fichiersPurges: j.purgeLe !== null,
    utilisable: termine && j.purgeLe === null && j.jeuId === null && j.expireLe.getTime() > maintenant.getTime(),
    jeuId: j.jeuId, resume: termine ? ((j.resume ?? null) as ResumeJob | null) : null,
  };
}

// ------------------------------------------------------------------------------------------------ Creation

export interface DemandeJob {
  acteur: Acteur;
  projetId: string;
  fichier: Buffer;
  nomFichier: string;
  epsgSource?: number;
  unitesDxf?: UniteDxf;
}

const TAILLE_NOM_MAX = 255;

/** Retire les caracteres de controle du nom de fichier (donnee de l'utilisateur, conservee pour l'affichage et l'audit). */
const nomPropre = (n: string): string => n.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, TAILLE_NOM_MAX) || "fichier";

let declencheur: (() => void) | null = null;
/** Le sondage s'enregistre ici pour etre reveille a la creation d'un job (pas d'attente du prochain tour). */
export function enregistrerDeclencheur(f: (() => void) | null): void { declencheur = f; }

const retryApres = (since: Date, maintenant: Date, fenetreMs: number): number => Math.max(1, Math.ceil((since.getTime() + fenetreMs - maintenant.getTime()) / 1000));

export async function creerJob(d: DemandeJob): Promise<JobVue> {
  if (!gdalActif()) throw new ErreurMetier(415, "FORMAT_GDAL_DESACTIVE", "Les formats GeoPackage, Shapefile ZIP et DXF sont désactivés sur ce serveur (interrupteur PROJETS_VOIRIE_GDAL).", { formats: [...FORMATS_GDAL] });
  const spool = spoolOuvert();
  const reg = reglagesGdal();
  if (d.fichier.length === 0) throw new ErreurLecture("FICHIER_VIDE", "le fichier est vide");

  // 1. Format PAR LE CONTENU ; archive controlee par le noyau ZIP du module (zip-slip, bombe, imbrication) AVANT tout depot dans le spool.
  const det = detecterFormatGdal(d.fichier, limitesZip(), true);
  if (det === null) throw new ErreurMetier(415, "FORMAT_NON_SUPPORTE", "Contenu non reconnu : GeoPackage, archive ZIP de Shapefile (.shp, .shx, .dbf) ou DXF texte attendu. Les autres formats se déposent directement (aperçu).");
  if (det.format === "DXF_BINAIRE") throw new ErreurLecture("DXF_BINAIRE_NON_PRIS_EN_CHARGE", ERREURS_JOB.DXF_BINAIRE_NON_PRIS_EN_CHARGE.message);
  const format = det.format;

  // 2. CRS JAMAIS devine : Shapefile et DXF exigent un EPSG confirme ; liste blanche ; DXF : unites declarees et compatibles avec le CRS.
  const autorises = crsSourceAutorises();
  if (format !== "GPKG" && d.epsgSource === undefined) {
    throw new ErreurLecture("CRS_REQUIS", format === "SHAPEFILE"
      ? `le CRS d'un Shapefile doit etre confirme (epsgSource) : le .prj est lu mais ne vaut jamais confirmation. Liste blanche : ${autorises.map((e) => `EPSG:${e}`).join(", ")}`
      : `un DXF n'a pas de georeferencement : le CRS doit etre fourni (epsgSource), il n'est jamais devine. Liste blanche : ${autorises.map((e) => `EPSG:${e}`).join(", ")}`);
  }
  let uniteCrs: string | null = null;
  if (d.epsgSource !== undefined) {
    if (!autorises.includes(d.epsgSource)) {
      throw new ErreurLecture("CRS_NON_AUTORISE", `EPSG:${d.epsgSource} n'est pas dans la liste des CRS source autorises (non valide par le DSI) : ${autorises.map((e) => `EPSG:${e}`).join(", ")}`);
    }
    uniteCrs = (await resoudreCrs(prisma, d.epsgSource)).unite;
  }
  if (format === "DXF") {
    if (d.unitesDxf === undefined) throw new ErreurLecture("UNITES_REQUISES", "les unites du DXF doivent etre declarees (unitesDxf : metre ou degre) : elles ne sont jamais devinees");
    try { controlerUniteContreCrs(d.unitesDxf, uniteCrs ?? ""); } catch (e) {
      throw new ErreurLecture("DXF_UNITES_CONFLIT", e instanceof ErreurSortie ? `${e.message} (CRS en ${uniteCrs ?? "?"}, unites declarees : ${d.unitesDxf})` : "unites incompatibles");
    }
  } else if (d.unitesDxf !== undefined) {
    throw new ErreurMetier(400, "CHAMPS_INVALIDES", "unitesDxf ne s'applique qu'a un DXF.");
  }

  const parametres: ParametresJob = { ...(d.epsgSource !== undefined ? { epsgSource: d.epsgSource } : {}), ...(d.unitesDxf !== undefined ? { unitesDxf: d.unitesDxf } : {}) };
  const sha256 = createHash("sha256").update(d.fichier).digest("hex");
  const id = randomUUID();
  const maintenant = new Date();
  const expireLe = new Date(maintenant.getTime() + reg.retentionH * 3_600_000);

  // 3. Ligne du job, SOUS LE VERROU DU PROJET puis le VERROU GLOBAL des jobs : doublon, plafonds, cadence, file, resultats non utilises.
  const job = await prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, d.projetId);
    // Verrou consultatif global (toujours pris APRES celui du projet, dans ce seul endroit : aucun interblocage possible) : les compteurs par compte, la
    // file globale et les resultats non utilises se comptent une creation a la fois, quel que soit le projet (m6 de la revue).
    await tx.$queryRaw`SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"pv-gdal-jobs"}, 0))) v`;
    const doublon = await tx.jobImportProjet.findFirst({
      where: { projetId: d.projetId, sha256, statut: { in: ["EN_ATTENTE", "EN_COURS"] }, parametres: { equals: parametres as Prisma.InputJsonValue } }, select: { id: true, statut: true },
    });
    if (doublon) throw new ErreurMetier(409, "JOB_DEJA_EN_COURS", "Ce fichier est deja en cours de conversion dans ce projet (meme empreinte, memes parametres).", { jobId: doublon.id, statut: doublon.statut });

    const actifs = { in: [...STATUTS_ACTIFS] as ("EN_ATTENTE" | "EN_COURS")[] };
    const actifsCompte = await tx.jobImportProjet.count({ where: { creeParId: d.acteur.id, statut: actifs } });
    if (actifsCompte >= reg.actifsParCompte) {
      throw new ErreurMetier(429, "PLAFOND_JOBS_COMPTE", `Ce compte a deja ${actifsCompte} conversion(s) en cours (maximum ${reg.actifsParCompte}) : attendez qu'elles se terminent ou annulez-en une.`, { retryAfterS: 30 });
    }
    const actifsProjet = await tx.jobImportProjet.count({ where: { projetId: d.projetId, statut: actifs } });
    if (actifsProjet >= reg.actifsParProjet) {
      throw new ErreurMetier(429, "PLAFOND_JOBS_PROJET", `Ce projet a deja ${actifsProjet} conversion(s) en cours (maximum ${reg.actifsParProjet}).`, { retryAfterS: 30 });
    }
    const fenetre = new Date(maintenant.getTime() - 3_600_000);
    for (const [portee, where] of [["compte", { creeParId: d.acteur.id }], ["projet", { projetId: d.projetId }]] as const) {
      const recents = await tx.jobImportProjet.findMany({ where: { ...where, createdAt: { gt: fenetre } }, orderBy: { createdAt: "asc" }, take: reg.creationsParHeure, select: { createdAt: true } });
      if (recents.length >= reg.creationsParHeure) {
        throw new ErreurMetier(429, "JOBS_TROP_FREQUENTS", `Trop de conversions creees pour ce ${portee} sur la derniere heure (maximum ${reg.creationsParHeure}).`, { retryAfterS: retryApres(recents[0].createdAt, maintenant, 3_600_000) });
      }
    }
    const enFile = await tx.jobImportProjet.count({ where: { statut: "EN_ATTENTE" } });
    if (enFile >= reg.fileMax) throw new ErreurMetier(503, "FILE_JOBS_PLEINE", "La file de conversion est pleine : reessayez dans quelques minutes.", { retryAfterS: 60 });
    // Chaque resultat TERMINE non utilise retient jusqu'a `sortieOctetsMax` dans le spool jusqu'a son usage ou son expiration : plafond global (m6 de la revue).
    const enAttenteUsage = await tx.jobImportProjet.count({ where: { statut: "TERMINE", jeuId: null, purgeLe: null, expireLe: { gt: maintenant } } });
    if (enAttenteUsage >= reg.resultatsMax) {
      throw new ErreurMetier(503, "PLAFOND_RESULTATS_EN_ATTENTE", `Trop de conversions terminees attendent d'etre utilisees (maximum ${reg.resultatsMax}) : deposez ou annulez-en avant d'en creer une nouvelle.`, { retryAfterS: 60 });
    }

    const cree = await tx.jobImportProjet.create({
      data: {
        id, projetId: d.projetId, creeParId: d.acteur.id, format, statut: "EN_ATTENTE", nomFichier: nomPropre(d.nomFichier), sha256, tailleOctets: d.fichier.length,
        parametres: parametres as Prisma.InputJsonValue, spoolId: spoolIdDe(id, 1), tentativesMax: reg.tentativesMax, expireLe, createdAt: maintenant, updatedAt: maintenant,
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: d.acteur.id, action: "CREATE", entityType: "JobImportProjet", entityId: id,
      after: { projetId: d.projetId, format, nomFichier: cree.nomFichier, sha256, tailleOctets: d.fichier.length, parametres, statut: "EN_ATTENTE", expireLe: expireLe.toISOString() },
      ipAddress: d.acteur.ip,
    });
    return cree;
  }, { timeout: 30_000, maxWait: 15_000 });

  // 4. Fichier dans le depot PRIVE du backend (copie dans entree/ a la reclamation seulement). Un echec de depot termine le job (jamais un job EN_ATTENTE sans fichier).
  try {
    await stagerPrive(spool, job.id, EXTENSION_DE_FORMAT[format], d.fichier);
  } catch {
    await terminerEnEchec(job.id, "SPOOL_INDISPONIBLE", ["EN_ATTENTE"]);
    throw new ErreurMetier(503, "SPOOL_INDISPONIBLE", ERREURS_JOB.SPOOL_INDISPONIBLE.message);
  }
  declencheur?.();
  return vueJob(job);
}

// ------------------------------------------------------------------------------------------------ Transitions (comparaison et echange)

interface ChangementStatut {
  de: StatutJob[];
  vers: StatutJob;
  champs?: Prisma.JobImportProjetUpdateManyMutationInput;
  audit?: Record<string, unknown>;
  acteur?: Acteur | null;
}

/**
 * Change le statut d'UN job seulement s'il est encore dans l'un des statuts `de` (comparaison et echange : deux sondages ou une annulation concurrente ne
 * peuvent pas ecraser l'etat de l'autre). Rend `true` si le changement a eu lieu. La base impose en plus les transitions (declencheur).
 */
export async function changerStatut(id: string, c: ChangementStatut, tx?: Tx): Promise<boolean> {
  const faire = async (t: Tx): Promise<boolean> => {
    const maintenant = new Date();
    const r = await t.jobImportProjet.updateMany({
      where: { id, statut: { in: c.de } },
      data: { statut: c.vers, updatedAt: maintenant, ...(c.vers === "EN_ATTENTE" || c.vers === "EN_COURS" ? {} : { finLe: maintenant }), ...c.champs },
    });
    if (r.count === 0) return false;
    await logAuditTransactionnelle(t, {
      userId: c.acteur?.id ?? null, action: "UPDATE", entityType: "JobImportProjet", entityId: id, after: { statut: c.vers, ...c.audit }, ipAddress: c.acteur?.ip,
    });
    return true;
  };
  return tx ? faire(tx) : prisma.$transaction(faire, { timeout: 20_000, maxWait: 10_000 });
}

export async function terminerEnEchec(id: string, code: string, de: StatutJob[], acteur?: Acteur): Promise<boolean> {
  const code2 = Object.prototype.hasOwnProperty.call(ERREURS_JOB, code) ? code : "CONVERSION_ECHEC";
  return changerStatut(id, {
    de, vers: "ECHEC", acteur: acteur ?? null,
    champs: { codeErreur: code2, messageErreur: messageErreur(code2), etape: "echec", progression: 100 }, audit: { codeErreur: code2 },
  });
}

// ------------------------------------------------------------------------------------------------ Lecture, liste, annulation

const jobDuProjet = async (projetId: string, jobId: string): Promise<JobImportProjet> => {
  const j = await prisma.jobImportProjet.findFirst({ where: { id: jobId, projetId } });
  // Un job d'un autre projet, ou inexistant : la MEME reponse (aucune fuite entre projets).
  if (!j) throw new ErreurMetier(404, "JOB_INTROUVABLE", "Job de conversion introuvable");
  return j;
};

export async function lireJob(projetId: string, jobId: string): Promise<JobVue> {
  spoolOuvertOuDesactive();
  return vueJob(await jobDuProjet(projetId, jobId));
}

/** Les routes de lecture, d'annulation et de liste repondent 503 GDAL_DESACTIVE quand l'interrupteur est coupe (aucun acces au spool). */
function spoolOuvertOuDesactive(): void {
  if (!gdalActif()) throw new ErreurMetier(503, "GDAL_DESACTIVE", "Le traitement GDAL est désactivé sur ce serveur (interrupteur PROJETS_VOIRIE_GDAL).");
}

export const LISTE_JOBS_MAX = 50;

export async function listerJobs(projetId: string, limite: number): Promise<{ jobs: JobVue[]; total: number; tronque: boolean }> {
  spoolOuvertOuDesactive();
  const n = Math.min(Math.max(1, Math.floor(limite)), LISTE_JOBS_MAX);
  const [lignes, total] = await Promise.all([
    prisma.jobImportProjet.findMany({ where: { projetId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: n }),
    prisma.jobImportProjet.count({ where: { projetId } }),
  ]);
  return { jobs: lignes.map((j) => vueJob(j)), total, tronque: total > lignes.length };
}

/**
 * Annule un job EN_ATTENTE ou EN_COURS. Les fichiers sont retires par le sondage (jamais pendant que le conteneur ecrit : voir `traiteur.ts`).
 */
export async function annulerJob(acteur: Acteur, projetId: string, jobId: string): Promise<JobVue> {
  spoolOuvertOuDesactive();
  const j = await jobDuProjet(projetId, jobId);
  const ok = await changerStatut(j.id, { de: ["EN_ATTENTE", "EN_COURS"], vers: "ANNULE", champs: { annuleParId: acteur.id, etape: "annule", progression: 100 }, acteur });
  if (!ok) {
    const apres = await jobDuProjet(projetId, jobId);
    throw new ErreurMetier(409, "JOB_NON_ANNULABLE", `Un job ${apres.statut} ne peut plus etre annule.`, { statut: apres.statut });
  }
  declencheur?.();
  return vueJob(await jobDuProjet(projetId, jobId));
}

// ------------------------------------------------------------------------------------------------ Lecture du resultat (validation stricte)

/** Au plus deux chargements de resultat a la fois : un resultat de 80 Mo valide en memoire est une charge, comme une reception de fichier. */
export const limiteurConversions = new Limiteur(2, 15_000);

/** `$INSUNITS` lu dans l'inventaire du conteneur (donnee non fiable : seul un entier est retenu). */
function insunitsDe(unites: unknown): number | null {
  const code = typeof unites === "object" && unites !== null ? (unites as { code?: unknown }).code : undefined;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 100 ? code : null;
}

export interface LectureOptions {
  /** Couches (identifiants de l'inventaire) dont les features sont conservees. `undefined` : toutes les couches non vides. */
  couche?: string;
  /** Garder les features en memoire (apercu, depot) ; sinon comptes seulement (finalisation du job). */
  retenir: boolean;
}

function attendusDe(j: JobImportProjet, spoolId: string): AttendusJob {
  const reg = reglagesGdal();
  return { spoolId, format: j.format as FormatGdal, sha256: j.sha256, tailleOctets: j.tailleOctets, objetsMax: reg.objetsMax, sortieOctetsMax: reg.sortieOctetsMax };
}

/**
 * Lit le resultat du conteneur pour un job, le valide ENTIEREMENT et l'assemble. Utilisee a la finalisation (comptes) et a chaque usage (features).
 * Leve `ErreurSortie` (code d'un refus de sortie) ou `ErreurLecture` (regle de CRS ou d'unites).
 */
export async function lireEtAssembler(spool: Spool, j: JobImportProjet, o: LectureOptions): Promise<ConversionValidee> {
  const spoolId = j.spoolId;
  if (!spoolId) throw new ErreurSortie("SORTIE_INVALIDE", "job sans dossier de spool");
  const reg = reglagesGdal();
  const resultat = validerResultat(await lireResultatBrut(spool, spoolId));
  const attendus = attendusDe(j, spoolId);
  // Controles de coherence (empreinte, format, plafonds) AVANT de lire la moindre couche : un conteneur qui a traite un autre fichier est refuse sans rien lire de plus.
  controlerResultat(resultat, attendus);
  const parametres = (j.parametres ?? {}) as ParametresJob;

  let insunits: number | null = null;
  let uniteCrsSource: string | null = null;
  if (j.format === "DXF") {
    const inv = await lireInventaireBrut(spool, spoolId);
    insunits = insunitsDe((inv as { unites?: unknown } | null)?.unites ?? null);
    if (parametres.epsgSource !== undefined) uniteCrsSource = (await resoudreCrs(prisma, parametres.epsgSource)).unite;
  }

  // Couches a lire : une seule si demandee (par son identifiant), sinon toutes celles qui portent des objets.
  const aLire = new Set<string>();
  for (const c of resultat.couches) {
    const slug = slugDeFichier(c.fichier);
    if (c.nbObjets > 0 && (j.format === "DXF" || o.couche === undefined || o.couche === slug)) aLire.add(slug);
  }
  const lues = new Map<string, CoucheLue>();
  for (const c of resultat.couches) {
    const slug = slugDeFichier(c.fichier);
    if (!aLire.has(slug)) continue;
    const v = new ValidateurCouche({
      limites: { sommetsParObjet: sommetsParObjetMax(), sommetsParFichier: sommetsParFichierMax(), objetsMax: reg.objetsMax, ...LIMITES_COUCHE_DEFAUT },
      coordonnees: c.coordonnees, nbObjetsDeclare: c.nbObjets, retenir: o.retenir,
      ...(j.format === "DXF" ? { grouperPar: "Layer", groupesMax: 1000 } : {}),
    });
    const { sha256, octets } = await lireCoucheVersValidateur(spool, spoolId, slug, v, { octetsMax: reg.sortieOctetsMax, ligneMax: LIMITES_COUCHE_DEFAUT.ligneMax });
    lues.set(slug, { v: v.terminer(), sha256, octets });
  }
  const conv = assembler({ format: j.format as FormatGdal, resultat, attendus, parametres, lues, insunits, uniteCrsSource, nomFichier: j.nomFichier });
  // Meta du CRS source (nom, unite) lue dans la base, pour `resume.crs` ; jamais devinee.
  const epsg = conv.couches[0]?.crsSource?.epsg ?? parametres.epsgSource;
  if (epsg) {
    try { conv.metaSource = await resoudreCrs(prisma, epsg); } catch (e) { if (!(e instanceof ErreurLecture)) throw e; }
  }
  return conv;
}

/** Code de job pour une erreur de lecture du resultat (sortie refusee, regle de CRS ou d'unites). */
export function codeDeErreurLecture(e: unknown): string {
  if (e instanceof ErreurSortie) return codeDeErreurSortie(e);
  if (e instanceof ErreurLecture && Object.prototype.hasOwnProperty.call(ERREURS_JOB, e.code)) return e.code;
  return "SORTIE_INVALIDE";
}

/**
 * Finalise un job EN_COURS dont le conteneur a rendu `termine` : validation stricte, puis TERMINE avec le resume, ou ECHEC avec un code. Une erreur
 * TRANSITOIRE (limiteur sature, base, descripteurs, delai du sondage) est RELANCEE a l'appelant : le job reste EN_COURS et la validation est retentee
 * au tour suivant, bornee par l'expiration du job (M3 de la revue). Apres TERMINE, l'entree du conteneur et le depot prive sont retires (M2, m6) : seule
 * la sortie validee reste, jusqu'a l'usage ou l'expiration.
 */
export async function finaliserJob(spool: Spool, j: JobImportProjet): Promise<"TERMINE" | "ECHEC" | "CONCURRENT"> {
  let resume: ResumeJob;
  try {
    const conv = await limiteurConversions.executer(() => lireEtAssembler(spool, j, { retenir: false }));
    resume = resumer(conv);
  } catch (e) {
    const verdict = classerErreurFinalisation(e);
    if (verdict.type === "REESSAYER") throw e;
    const ok = await terminerEnEchec(j.id, verdict.code, ["EN_COURS"]);
    return ok ? "ECHEC" : "CONCURRENT";
  }
  const ok = await changerStatut(j.id, {
    de: ["EN_COURS"], vers: "TERMINE",
    champs: { resume: resume as unknown as Prisma.InputJsonValue, etape: "termine", progression: 100, codeErreur: null, messageErreur: null },
    audit: { format: j.format, nbCouches: resume.couches.length, nbObjets: resume.couches.reduce((s, c) => s + c.nbObjets, 0), gdal: resume.gdal, avertissements: resume.avertissements.map((a: Avertissement) => ({ code: a.code, nb: a.nb ?? null })) },
  });
  if (!ok) return "CONCURRENT";
  await purgerEntreeEtPrive(spool, j);
  return "TERMINE";
}

/** Retire entree/<spoolId>/ et prive/<jobId>/ (le conteneur n'a plus rien a lire) ; une erreur est journalisee, la purge complete du sondage reprendra. */
export async function purgerEntreeEtPrive(spool: Spool, j: Pick<JobImportProjet, "id" | "spoolId">): Promise<void> {
  if (j.spoolId) await purgerEntree(spool, j.spoolId).catch((e) => journalErreur(`purge de l'entree du job ${j.id}`, e));
  await purgerPrive(spool, j.id).catch((e) => journalErreur(`purge du depot prive du job ${j.id}`, e));
}

/**
 * Resultat utilisable d'un job pour l'apercu et le depot (memes controles pour les deux) :
 * 404 hors projet ; 409 non termine ou deja utilise ; 410 expire ou purge ; 409 RESULTAT_ALTERE si un fichier du spool ne correspond plus a ce qui a ete valide.
 */
export async function chargerConversion(projetId: string, jobId: string, o: { couche?: string }): Promise<{ job: JobImportProjet; conversion: ConversionValidee }> {
  const spool = spoolOuvert();
  const j = await jobDuProjet(projetId, jobId);
  if (j.statut !== "TERMINE") {
    throw new ErreurMetier(409, "JOB_NON_TERMINE", `Le job est ${j.statut} : seul un job TERMINE peut servir d'entree.`, { statut: j.statut, codeErreur: j.codeErreur });
  }
  if (j.jeuId) throw new ErreurMetier(409, "JOB_DEJA_UTILISE", "Ce job a deja servi a un depot.", { jeuId: j.jeuId });
  if (j.purgeLe || j.expireLe.getTime() <= Date.now()) throw new ErreurMetier(410, "RESULTAT_EXPIRE", "Le resultat de ce job a expire (fichiers temporaires retires) : creez un nouveau job.");
  const resume = (j.resume ?? null) as ResumeJob | null;
  if (!resume) throw new ErreurMetier(409, "JOB_NON_TERMINE", "Le job n'a pas de resultat valide.", { statut: j.statut });
  let conversion: ConversionValidee;
  try {
    conversion = await limiteurConversions.executer(() => lireEtAssembler(spool, j, { couche: o.couche, retenir: true }));
  } catch (e) {
    if (e instanceof ErreurLecture || e instanceof ErreurMetier) throw e;
    const code = codeDeErreurLecture(e);
    const code404 = (e as { code?: string })?.code === "ENOENT";
    if (code404) throw new ErreurMetier(410, "RESULTAT_EXPIRE", "Le resultat de ce job n'est plus dans le dossier d'echange : creez un nouveau job.");
    throw new ErreurMetier(409, "RESULTAT_ALTERE", ERREURS_JOB[code]?.message ?? ERREURS_JOB.SORTIE_INVALIDE.message, { codeErreur: code });
  }
  // Empreintes des couches ET champs qui gouvernent le CRS (crsSource, coordonnees, reprojete), comptes, inventaire DXF, versions GDAL, avertissements du
  // conteneur : tout ce qui a ete valide au TERMINE doit etre identique a la relecture (m4 de la revue).
  if (ecartsAvecResume(conversion, resume) !== null) {
    throw new ErreurMetier(409, "RESULTAT_ALTERE", "Un fichier du dossier d'echange ne correspond plus a ce qui a ete valide : creez un nouveau job.");
  }
  return { job: j, conversion };
}

/** Dans la transaction du DEPOT : le job devient utilise (un seul depot par job, comparaison et echange). */
export async function consommerDansTx(tx: Tx, jobId: string, jeuId: string, acteur: Acteur): Promise<void> {
  const r = await tx.jobImportProjet.updateMany({ where: { id: jobId, statut: "TERMINE", jeuId: null }, data: { jeuId, updatedAt: new Date() } });
  if (r.count === 0) throw new ErreurMetier(409, "JOB_DEJA_UTILISE", "Ce job a deja servi a un depot.");
  await logAuditTransactionnelle(tx, { userId: acteur.id, action: "UPDATE", entityType: "JobImportProjet", entityId: jobId, after: { jeuId, utilise: true }, ipAddress: acteur.ip });
}

/** Apres un depot reel : retire les fichiers du spool et note la purge (le sondage reprend si cela echoue). */
export async function purgerApresDepot(jobId: string): Promise<void> {
  try {
    const spool = spoolOuvert();
    const j = await prisma.jobImportProjet.findUnique({ where: { id: jobId }, select: { spoolId: true } });
    if (j?.spoolId) await purger(spool, j.spoolId);
    await purgerPrive(spool, jobId);
    await prisma.jobImportProjet.updateMany({ where: { id: jobId, purgeLe: null }, data: { purgeLe: new Date(), updatedAt: new Date() } });
  } catch {
    // Le sondage purge les jobs utilises dont `purgeLe` est vide.
  }
}
