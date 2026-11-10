/**
 * SONDAGE DES JOBS DE CONVERSION (lot B2, durci lot V2) : un tour BORNE, declenche par un minuteur et non par une boucle sans fin. Contrat : docs/projets-voirie/
 * CONTRAT-IMPORT.md section 13.
 *
 * POURQUOI UN SONDAGE ET PAS `backend/src/jobs`. Ce dossier ne contient que deux planificateurs `setTimeout` de taches periodiques (snapshot mensuel, alertes
 * quotidiennes) : aucune file, aucune reprise, aucune reclamation atomique. Un job de conversion doit survivre a un redemarrage et ne jamais etre traite deux
 * fois : l'etat est dans la base (reclamation `FOR UPDATE SKIP LOCKED`, comparaison et echange sur chaque transition) et le sondage ne garde RIEN en memoire.
 *
 * BORNES. Un tour : 50 jobs EN_COURS examines au plus, 50 candidats a l'expiration, 25 purges, `concurrence` reclamations, et un BUDGET DE TEMPS
 * (`PROJETS_VOIRIE_GDAL_DELAI_TOUR_S`, 120 s par defaut ; 10 s par acces court au spool) : un acces au spool qui ne repond pas (tube nomme, disque reseau)
 * est abandonne et compte en erreur, le tour se termine et le suivant repart (M1 de la revue). Un seul tour a la fois par processus (le suivant est ignore
 * s'il tombe pendant un tour). Desactive (interrupteur), le minuteur n'est meme pas cree. Quand rien n'est a faire, un tour coute trois requetes de comptage.
 *
 * REPRISE APRES REDEMARRAGE. Aucun etat local : un job EN_COURS est relu dans le spool au premier tour ; son `reclameLe` donne l'echeance de perte.
 * RELANCE CONTROLEE. Un job perdu (aucune reponse dans `delai * concurrence + marge`) ou interrompu (redemarrage du conteneur) est remis EN_ATTENTE avec un NOUVEAU
 * dossier du spool, au plus `tentativesMax` fois ; ensuite ECHEC `JOB_PERDU`. Le fichier est recopie depuis le depot prive a la reclamation suivante.
 * ERREURS TRANSITOIRES. Une validation qui echoue pour une cause du backend (limiteur sature, base, descripteurs, delai) laisse le job EN_COURS et sera
 * retentee au tour suivant (M3 de la revue) ; seul un ecart de la sortie du conteneur donne ECHEC.
 * PURGE. Les fichiers temporaires ne survivent jamais a l'expiration. Un dossier de sortie n'est PAS retire tant que le conteneur y ecrit encore (retirer le
 * repertoire sous un job en cours ferait echouer l'ecriture du statut et pourrait faire tomber le worker) : le sondage attend la fin du job ou son echeance.
 * Une purge qui echoue (droits, nom inattendu laisse par le conteneur) est journalisee sans chemin et le job passe en queue de la file des purges (m1).
 */

import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { DELAI_ACCES_SPOOL_MS, gdalActif, MARGE_PERTE_S, reglagesGdal, spoolPrive, spoolRacine } from "./config";
import { codeApi, decider, echeancePerte, messageErreur, progressionDepuisEtape, spoolIdDe, type StatutJob } from "./contrat.noyau";
import { BudgetTour, avecDelai } from "./delai.noyau";
import { EXTENSION_DE_FORMAT } from "./format.noyau";
import { changerStatut, enregistrerDeclencheur, finaliserJob, terminerEnEchec } from "./jobs.service";
import { copierVersEntree, lireStatutSpool, ouvrirSpool, priveExiste, publierDemande, purger, purgerEntree, purgerPrive, type ObservationBrute, type Spool } from "./spool";
import type { ObservationSpool } from "./contrat.noyau";
import type { FormatGdal } from "./contrat.noyau";
import type { JobImportProjet } from "@prisma/client";

export interface BilanTour {
  reclames: number; termines: number; echecs: number; relances: number; expires: number; purges: number; progres: number; erreurs: number;
}

const vide = (): BilanTour => ({ reclames: 0, termines: 0, echecs: 0, relances: 0, expires: 0, purges: 0, progres: 0, erreurs: 0 });
const EXAMINES_MAX = 50;
const PURGES_MAX = 25;

let tourEnCours = false;

function observation(o: ObservationBrute): ObservationSpool {
  if (o.etat !== "ok") return { etat: o.etat };
  const s = o.statut;
  if (s.statut === "termine") return { etat: "termine" };
  if (s.statut === "echec") return { etat: "echec", code: s.code };
  return { etat: "en_cours", etape: s.etape };
}

const journalErreur = (contexte: string, e: unknown): void => {
  // Jamais de chemin ni de contenu : le type de l'erreur et son contexte.
  console.warn(`[gdal] ${contexte} : ${e instanceof Error ? e.name : "erreur"}${(e as NodeJS.ErrnoException)?.code ? ` (${(e as NodeJS.ErrnoException).code})` : ""}`);
};

/** Contexte d'un tour : spool, reglages et budget de temps. Chaque acces au spool passe par `court` (10 s au plus) ou `long` (le reste du tour). */
interface Tour {
  spool: Spool;
  reg: ReturnType<typeof reglagesGdal>;
  budget: BudgetTour;
  maintenant: Date;
}

const court = <T>(t: Tour, p: Promise<T>, contexte: string): Promise<T> => avecDelai(p, t.budget.court(), contexte);
const long = <T>(t: Tour, p: Promise<T>, contexte: string): Promise<T> => avecDelai(p, t.budget.long(), contexte);

/** Peut-on retirer les dossiers de ce job sans gener un conteneur qui y ecrit encore ? */
async function peutPurger(t: Tour, j: JobImportProjet): Promise<boolean> {
  if (!j.spoolId) return true;
  const o = await court(t, lireStatutSpool(t.spool, j.spoolId), "lecture du statut avant purge");
  if (o.etat === "ok" && o.statut.statut === "en_cours") {
    // Le conteneur travaille encore : on attend sa fin, ou l'echeance de perte (il aurait alors rendu la main ou ete redemarre).
    return j.reclameLe !== null && t.maintenant.getTime() >= echeancePerte(j.reclameLe, { delaiJobS: t.reg.delaiJobS, concurrence: t.reg.concurrence, margeS: MARGE_PERTE_S }).getTime();
  }
  return true;
}

async function purgerJob(t: Tour, j: JobImportProjet): Promise<boolean> {
  if (!(await peutPurger(t, j))) return false;
  try {
    if (j.spoolId) await court(t, purger(t.spool, j.spoolId), "purge des dossiers du job");
    await court(t, purgerPrive(t.spool, j.id), "purge du depot prive du job");
  } catch (e) {
    // Rotation : le job passe en queue de la file des purges (ordre par updatedAt), les autres purges ne sont plus affamees (m1 de la revue).
    await prisma.jobImportProjet.updateMany({ where: { id: j.id, purgeLe: null }, data: { updatedAt: t.maintenant } });
    throw e;
  }
  await prisma.jobImportProjet.updateMany({ where: { id: j.id, purgeLe: null }, data: { purgeLe: t.maintenant, updatedAt: t.maintenant } });
  return true;
}

/** Un tour du sondage. Exporte pour les tests et le banc (aucun minuteur n'est necessaire pour l'appeler). */
export async function traiterUnTour(maintenant: Date = new Date()): Promise<BilanTour> {
  const bilan = vide();
  if (!gdalActif()) return bilan;
  const racine = spoolRacine();
  if (racine === null || tourEnCours) return bilan;
  tourEnCours = true;
  const reg = reglagesGdal();
  const t: Tour = { spool: ouvrirSpool(racine, spoolPrive()), reg, budget: BudgetTour.depuis(Date.now(), reg.delaiTourS * 1000, DELAI_ACCES_SPOOL_MS), maintenant };
  const params = { maintenant, delaiJobS: reg.delaiJobS, concurrence: reg.concurrence, margeS: MARGE_PERTE_S };
  try {
    // ---- 1. Jobs EN_COURS : ce que le conteneur a rendu
    const enCours = await prisma.jobImportProjet.findMany({ where: { statut: "EN_COURS" }, orderBy: { reclameLe: "asc" }, take: EXAMINES_MAX });
    for (const j of enCours) {
      if (t.budget.epuise()) { bilan.erreurs++; journalErreur("tour du sondage", new Error("budget du tour epuise")); break; }
      try {
        const obs = j.spoolId ? observation(await court(t, lireStatutSpool(t.spool, j.spoolId), "lecture du statut")) : null;
        const d = decider({ statut: j.statut as StatutJob, tentatives: j.tentatives, tentativesMax: j.tentativesMax, reclameLe: j.reclameLe, expireLe: j.expireLe }, obs, params);
        switch (d.type) {
          case "VALIDER": {
            // Une erreur transitoire remonte ici (M3) : comptee, journalisee, le job reste EN_COURS et sera revalide au tour suivant.
            const r = await long(t, finaliserJob(t.spool, j), "validation du resultat");
            if (r === "TERMINE") bilan.termines++; else if (r === "ECHEC") bilan.echecs++;
            break;
          }
          case "ECHEC":
            if (await terminerEnEchec(j.id, d.code, ["EN_COURS"])) bilan.echecs++;
            break;
          case "RELANCER":
            if (await relancer(t, j, d.raison)) bilan.relances++; else bilan.echecs++;
            break;
          case "EXPIRER":
            if (await expirer(j, ["EN_COURS"])) bilan.expires++;
            break;
          case "PROGRES": {
            const p = progressionDepuisEtape(d.etape);
            if (d.etape !== j.etape && p >= j.progression) {
              await prisma.jobImportProjet.updateMany({ where: { id: j.id, statut: "EN_COURS" }, data: { etape: d.etape?.slice(0, 40) ?? null, progression: p, updatedAt: maintenant } });
              bilan.progres++;
            }
            break;
          }
          default: break;
        }
      } catch (e) { bilan.erreurs++; journalErreur(`job ${j.id}`, e); }
    }

    // ---- 2. Expirations (EN_ATTENTE et TERMINE non utilises)
    const perimes = await prisma.jobImportProjet.findMany({ where: { statut: { in: ["EN_ATTENTE", "TERMINE"] }, expireLe: { lte: maintenant } }, take: EXAMINES_MAX, orderBy: { expireLe: "asc" } });
    for (const j of perimes) {
      try {
        // Un job TERMINE deja utilise n'a plus de fichiers a garder : il n'expire pas, il est purge (etape 3).
        if (j.statut === "TERMINE" && j.jeuId) continue;
        if (await expirer(j, [j.statut as StatutJob])) bilan.expires++;
      } catch (e) { bilan.erreurs++; journalErreur(`expiration ${j.id}`, e); }
    }

    // ---- 3. Purge des dossiers : jobs finis ou annules, et jobs utilises pour un depot
    const aPurger = await prisma.jobImportProjet.findMany({
      where: { purgeLe: null, OR: [{ statut: { in: ["ECHEC", "ANNULE", "EXPIRE"] } }, { statut: "TERMINE", jeuId: { not: null } }] }, take: PURGES_MAX, orderBy: { updatedAt: "asc" },
    });
    for (const j of aPurger) {
      if (t.budget.epuise()) { bilan.erreurs++; journalErreur("tour du sondage", new Error("budget du tour epuise")); break; }
      try { if (await purgerJob(t, j)) bilan.purges++; } catch (e) { bilan.erreurs++; journalErreur(`purge ${j.id}`, e); }
    }

    // ---- 4. Reclamation : transmettre des jobs EN_ATTENTE tant qu'il reste une place
    let actifs = await prisma.jobImportProjet.count({ where: { statut: "EN_COURS" } });
    while (actifs < reg.concurrence && !t.budget.epuise()) {
      const j = await reclamer(maintenant);
      if (!j) break;
      actifs++;
      bilan.reclames++;
      try { await transmettre(t, j); } catch (e) { bilan.erreurs++; journalErreur(`transmission ${j.id}`, e); }
    }
  } finally {
    tourEnCours = false;
  }
  return bilan;
}

/**
 * Reclame le plus ancien job EN_ATTENTE non expire (verrou de ligne `SKIP LOCKED` : deux instances ne prennent jamais le meme job). La transition
 * EN_ATTENTE -> EN_COURS est AUDITEE dans la meme transaction, sans acteur (c'est le sondage) : m8 de la revue.
 */
async function reclamer(maintenant: Date): Promise<JobImportProjet | null> {
  const id = await prisma.$transaction(async (tx) => {
    const lignes = await tx.$queryRaw<{ id: string; tentatives: number }[]>`
      UPDATE "projets_voirie_import_jobs"
         SET "statut" = 'EN_COURS', "tentatives" = "tentatives" + 1, "reclameLe" = ${maintenant}, "etape" = 'transmis', "progression" = 5, "updatedAt" = ${maintenant}
       WHERE "id" = (SELECT "id" FROM "projets_voirie_import_jobs"
                      WHERE "statut" = 'EN_ATTENTE' AND "expireLe" > ${maintenant} AND "tentatives" < "tentativesMax"
                      ORDER BY "createdAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING "id", "tentatives"`;
    if (lignes.length === 0) return null;
    await logAuditTransactionnelle(tx, {
      userId: null, action: "UPDATE", entityType: "JobImportProjet", entityId: lignes[0].id, after: { statut: "EN_COURS", tentative: lignes[0].tentatives, reclameLe: maintenant.toISOString() },
    });
    return lignes[0].id;
  }, { timeout: 20_000, maxWait: 10_000 });
  if (id === null) return null;
  return prisma.jobImportProjet.findUnique({ where: { id } });
}

/**
 * Publie la demande au conteneur : copie du depot prive vers entree/<spoolId>/ (c'est ICI que le fichier devient visible du conteneur : M2 de la revue),
 * puis `demande.json` en dernier. Limites : seulement a la BAISSE des plafonds de l'operateur du conteneur.
 */
async function transmettre(t: Tour, j: JobImportProjet): Promise<void> {
  const ext = EXTENSION_DE_FORMAT[j.format as FormatGdal];
  if (!j.spoolId || !(await court(t, priveExiste(t.spool, j.id, ext), "lecture du depot prive"))) {
    await terminerEnEchec(j.id, "ENTREE_ABSENTE", ["EN_COURS"]);
    return;
  }
  try {
    await court(t, copierVersEntree(t.spool, j.id, j.spoolId, ext), "copie vers l'entree du conteneur");
  } catch (e) {
    // Rien n'a ete publie : le job reste EN_COURS, l'echeance de perte le relancera (nouveau dossier) ou l'expirera ; le fichier prive est intact.
    journalErreur(`copie vers l'entree ${j.id}`, e);
    throw e;
  }
  const p = (j.parametres ?? {}) as { epsgSource?: number };
  await court(t, publierDemande(t.spool, j.spoolId, {
    version: 1, fichier: `fichier.${ext}`,
    ...(p.epsgSource !== undefined ? { epsg_source: p.epsgSource } : {}),
    limites: { objets_max: t.reg.objetsMax, delai_s: t.reg.delaiJobS, sortie_octets_max: t.reg.sortieOctetsMax, taille_entree_octets: t.reg.entreeOctetsMax },
  }), "publication de la demande");
}

/**
 * Nouvelle tentative : nouveau dossier du spool (le fichier sera recopie depuis le depot prive a la reclamation), job remis EN_ATTENTE, ancien dossier purge
 * seulement si le conteneur n'y ecrit plus (`peutPurger`, m7 de la revue) ; sinon l'entree seule est retiree et la sortie est laissee au worker
 * (`GEOCONV_RETENTION_H`). Sans depot prive : ECHEC `ENTREE_ABSENTE`.
 */
async function relancer(t: Tour, j: JobImportProjet, raison: string): Promise<boolean> {
  const ext = EXTENSION_DE_FORMAT[j.format as FormatGdal];
  const suivant = spoolIdDe(j.id, j.tentatives + 1);
  if (!j.spoolId || !(await court(t, priveExiste(t.spool, j.id, ext), "lecture du depot prive"))) {
    await terminerEnEchec(j.id, "ENTREE_ABSENTE", ["EN_COURS"]);
    return false;
  }
  const ancien = j.spoolId;
  const purgeSure = await peutPurger(t, j);
  const ok = await changerStatut(j.id, {
    de: ["EN_COURS"], vers: "EN_ATTENTE",
    champs: { spoolId: suivant, reclameLe: null, etape: null, progression: 0 }, audit: { relance: j.tentatives, raison },
  });
  if (!ok) return true;
  try {
    if (purgeSure) await court(t, purger(t.spool, ancien), "purge de la tentative precedente");
    else { await court(t, purgerEntree(t.spool, ancien), "purge de l'entree de la tentative precedente"); journalErreur("purge d'une tentative", new Error("sortie encore ecrite par le conteneur : laissee au worker")); }
  } catch (e) { journalErreur("purge d'une tentative", e); }
  return true;
}

async function expirer(j: JobImportProjet, de: StatutJob[]): Promise<boolean> {
  const ok = await changerStatut(j.id, { de, vers: "EXPIRE", champs: { codeErreur: "CONVERSION_EXPIREE", messageErreur: messageErreur("CONVERSION_EXPIREE"), etape: "expire", progression: 100 }, audit: { codeErreur: "CONVERSION_EXPIREE" } });
  return ok;
}

// ------------------------------------------------------------------------------------------------ Minuteur

let minuteur: ReturnType<typeof setInterval> | null = null;

/**
 * Demarre le sondage : UN minuteur, jamais cree si l'interrupteur est coupe, qui ne retient pas le processus (`unref`). Un premier tour part tout de suite
 * (reprise apres redemarrage). Idempotent.
 */
export function demarrerTraiteur(): boolean {
  if (!gdalActif() || minuteur !== null) return false;
  const tour = () => { traiterUnTour().catch((e) => journalErreur("tour du sondage", e)); };
  minuteur = setInterval(tour, reglagesGdal().sondageS * 1000);
  minuteur.unref();
  enregistrerDeclencheur(() => { setImmediate(tour); });
  setImmediate(tour);
  return true;
}

export function arreterTraiteur(): void {
  if (minuteur !== null) clearInterval(minuteur);
  minuteur = null;
  enregistrerDeclencheur(null);
}

export const traiteurActif = (): boolean => minuteur !== null;

export { codeApi };
