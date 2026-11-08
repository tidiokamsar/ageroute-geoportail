/**
 * TACHES liees a un projet, un conflit ou une demande : lecture et ecritures (contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, 5.2).
 *
 * Le responsable fait avancer SA tache ; valider (A_VALIDER -> TERMINEE) exige un tiers (separation des taches, noyau commun avec RC-3).
 * Lier une tache a un conflit ou a une demande lui donne le concessionnaire du lien mais NE LA PARTAGE PAS : c'est `partagee` qui la rend visible
 * des referents de ce concessionnaire. Aucune tache ne cree d'ordre ni ne modifie un conflit.
 */

import type { Prisma, TacheProjetVoirie } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { verifierResponsable } from "../conflits/etats.noyau";
import { decoderCurseurConflit, encoderCurseurConflit } from "../conflits/curseurs.noyau";
import { ErreurMetier, introuvable } from "../erreurs";
import {
  ajouterHistorique, contexteDe, dateJour, exigerProjetActif, exigerQuota, jour, lever, lireHistorique, nomsDe, personneDe, transactionProjet, verifierCadence,
  type ActeurWorkflow, type Personne, type Tx,
} from "./communs";
import { matriceEffective, tachesParProjetMax } from "./config";
import { clauseCurseur, clausesVisibilite, minuitUtc } from "./filtres";
import { autorise } from "./profils.noyau";
import { lirePreuves } from "./preuves.service";
import {
  evaluerTransitionTache, PRIORITES_TACHE, responsableHabilite, STATUTS_TACHE, STATUTS_TACHE_TERMINAUX, transitionsTachePossibles, type PrioriteTache, type StatutTache,
} from "./taches.noyau";
import { diffChamps, exigerJustification, jourValide, refus, texteBorne } from "./validation.noyau";
import { filtreTaches, historiqueVisible, ligneVisible, sorteDe, type ContexteLecture } from "./visibilite.noyau";

const TACHE_INTROUVABLE = () => introuvable("Tâche", "TACHE_INTROUVABLE");

async function nomsConcessionnaires(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const uniques = [...new Set(ids.filter((i): i is string => i !== null))];
  if (uniques.length === 0) return new Map();
  const l = await prisma.concessionnaireReseau.findMany({ where: { id: { in: uniques } }, select: { id: true, nom: true } });
  return new Map(l.map((c) => [c.id, c.nom]));
}

function vueTache(t: TacheProjetVoirie, acteur: ActeurWorkflow, ctx: ContexteLecture, noms: Map<string, Personne>, conc: Map<string, string>) {
  const interne = sorteDe(ctx) === "DECIDEUR";
  const estMoi = t.responsableId === acteur.id;
  const { matrice } = matriceEffective();
  return {
    id: t.id, projetId: t.projetId, titre: t.titre, description: t.description, conflitId: t.conflitId, demandeId: t.demandeId,
    concessionnaire: t.concessionnaireId ? { id: t.concessionnaireId, nom: conc.get(t.concessionnaireId) ?? "" } : null, partagee: t.partagee,
    responsable: interne || estMoi ? personneDe(noms, t.responsableId) : null, responsableEstMoi: estMoi,
    echeance: jour(t.echeance), echeanceDepassee: t.echeance !== null && t.echeance < minuitUtc() && !STATUTS_TACHE_TERMINAUX.includes(t.statut),
    statut: t.statut, priorite: t.priorite, validationRequise: t.validationRequise, termineLe: t.termineLe,
    creePar: interne ? personneDe(noms, t.creeParId) : null, createdAt: t.createdAt, updatedAt: t.updatedAt,
    transitionsPossibles: transitionsTachePossibles({
      de: t.statut, validationRequise: t.validationRequise, acteurId: acteur.id, responsableId: t.responsableId,
      peutGerer: autorise(matrice, "tache.gerer", acteur.profil), peutExecuter: autorise(matrice, "tache.executer", acteur.profil),
    }),
  };
}

async function vues(lignes: TacheProjetVoirie[], acteur: ActeurWorkflow, ctx: ContexteLecture) {
  const [noms, conc] = await Promise.all([nomsDe(lignes.flatMap((t) => [t.responsableId, t.creeParId])), nomsConcessionnaires(lignes.map((t) => t.concessionnaireId))]);
  return lignes.map((t) => vueTache(t, acteur, ctx, noms, conc));
}

// ------------------------------------------------------------------------------------------------
// Lecture
// ------------------------------------------------------------------------------------------------

export interface FiltresTaches { statuts?: StatutTache[]; responsableId?: string; conflitId?: string; demandeId?: string; concessionnaireId?: string; echeanceDepassee?: boolean }

function clauses(projetId: string, acteur: ActeurWorkflow, ctx: ContexteLecture, f: FiltresTaches, avecStatut: boolean): Prisma.TacheProjetVoirieWhereInput[] {
  // Un compte qui n'a pas `workflow.lire` (agent de terrain) ne lit que SES taches ; un agent n'est pas soumis au filtre de projet (ses taches liees a un conflit comptent).
  const lecteur = autorise(matriceEffective().matrice, "workflow.lire", acteur.profil);
  const visibilite = !lecteur && acteur.profil === "INSPECTEUR" ? [] : (clausesVisibilite(filtreTaches(ctx), { vrai: "partagee" }, true) as Prisma.TacheProjetVoirieWhereInput[]);
  const and: Prisma.TacheProjetVoirieWhereInput[] = [{ projetId }, ...visibilite, ...(lecteur ? [] : [{ responsableId: acteur.id }])];
  if (avecStatut && f.statuts?.length) and.push({ statut: { in: f.statuts } });
  if (f.responsableId) and.push({ responsableId: f.responsableId });
  if (f.conflitId) and.push({ conflitId: f.conflitId });
  if (f.demandeId) and.push({ demandeId: f.demandeId });
  if (f.concessionnaireId) and.push({ concessionnaireId: f.concessionnaireId });
  if (f.echeanceDepassee === true) and.push({ echeance: { lt: minuitUtc() }, statut: { notIn: [...STATUTS_TACHE_TERMINAUX] } });
  if (f.echeanceDepassee === false) and.push({ OR: [{ echeance: null }, { echeance: { gte: minuitUtc() } }, { statut: { in: [...STATUTS_TACHE_TERMINAUX] } }] });
  return and;
}

export async function listerTaches(acteur: ActeurWorkflow, projetId: string, f: FiltresTaches, limite: number, curseur?: { t: Date; i: string }) {
  await exigerProjetActif(projetId);
  const ctx = contexteDe(acteur, projetId);
  const lignes = await prisma.tacheProjetVoirie.findMany({
    where: { AND: [...clauses(projetId, acteur, ctx, f, true), ...(clauseCurseur(curseur) as Prisma.TacheProjetVoirieWhereInput[])] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite + 1,
  });
  const page = lignes.slice(0, limite);
  const groupes = await prisma.tacheProjetVoirie.groupBy({ by: ["statut"], where: { AND: clauses(projetId, acteur, ctx, f, false) }, _count: { _all: true } });
  const compteurs: Record<string, number> = Object.fromEntries(STATUTS_TACHE.map((s) => [s, 0]));
  for (const g of groupes) compteurs[g.statut] = g._count._all;
  const dernier = page[page.length - 1];
  return {
    taches: await vues(page, acteur, ctx), compteurs,
    curseurSuivant: lignes.length > limite && dernier ? encoderCurseurConflit({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}

export const decoderCurseurTache = decoderCurseurConflit;

/**
 * Tache du projet VISIBLE du profil, sinon la MEME 404. Un agent de terrain (qui ne lit pas le workflow) n'ouvre que les taches dont il est le responsable.
 */
async function tacheVisible(acteur: ActeurWorkflow, projetId: string, id: string, db: Pick<Tx, "tacheProjetVoirie"> = prisma): Promise<TacheProjetVoirie> {
  const t = await db.tacheProjetVoirie.findFirst({ where: { id, projetId } });
  if (!t) throw TACHE_INTROUVABLE();
  const ctx = contexteDe(acteur, projetId);
  const lecteur = autorise(matriceEffective().matrice, "workflow.lire", acteur.profil);
  const parFiltre = lecteur && ligneVisible(filtreTaches(ctx), { concessionnaireId: t.concessionnaireId, conflitId: t.conflitId, partage: t.partagee });
  const parResponsabilite = acteur.profil === "INSPECTEUR" && t.responsableId === acteur.id;
  if (!parFiltre && !parResponsabilite) throw TACHE_INTROUVABLE();
  return t;
}

export async function ficheTache(acteur: ActeurWorkflow, projetId: string, id: string) {
  await exigerProjetActif(projetId);
  const t = await tacheVisible(acteur, projetId, id);
  const ctx = contexteDe(acteur, projetId);
  const [[tache], preuves, historique] = await Promise.all([
    vues([t], acteur, ctx), lirePreuves(acteur, ctx, "TACHE", id), historiqueVisible(ctx) ? lireHistorique("TACHE", id) : Promise.resolve(undefined),
  ]);
  return { tache, preuves, ...(historique ? { historique } : {}), transitionsPossibles: tache.transitionsPossibles };
}

// ------------------------------------------------------------------------------------------------
// Responsable
// ------------------------------------------------------------------------------------------------

/** Responsable : compte actif avec la cle de module (RC-3, `verifierResponsable`) ET habilite a agir sur CETTE tache (`responsableHabilite`). */
async function verifierResponsableTache(tx: Tx, projetId: string, responsableId: string, concessionnaireId: string | null, partagee: boolean): Promise<void> {
  const u = await tx.user.findUnique({ where: { id: responsableId }, select: { actif: true, role: true, modulesAutorises: true } });
  if (!u) throw new ErreurMetier(400, "RESPONSABLE_INCONNU", "Le responsable désigné n'existe pas.");
  const r = verifierResponsable({ actif: u.actif, role: u.role, modulesAutorises: u.modulesAutorises });
  if (!r.ok) throw new ErreurMetier(r.status, r.code, r.message);
  const rattachements = u.role === "ADMIN" ? [] : await tx.referentConcessionnaire.findMany({ where: { userId: responsableId, revoqueLe: null }, select: { projetId: true, concessionnaireId: true } });
  const h = responsableHabilite({
    role: u.role, aDesRattachements: rattachements.length > 0, tacheConcessionnaireId: concessionnaireId,
    referentDuConcessionnaire: concessionnaireId !== null && rattachements.some((x) => x.projetId === projetId && x.concessionnaireId === concessionnaireId),
  });
  if (!h.ok) throw new ErreurMetier(h.status, h.code, h.message);
  // Un referent ne voit que les taches PARTAGEES : lui en confier une qui ne l'est pas la lui rendrait invisible.
  if (rattachements.length > 0 && !partagee) throw new ErreurMetier(422, "CONCESSIONNAIRE_INCOHERENT", "Une tâche confiée à un référent concessionnaire doit être partagée (partagee: true).");
}

// ------------------------------------------------------------------------------------------------
// Ecritures
// ------------------------------------------------------------------------------------------------

export interface CorpsCreationTache {
  titre: string; description?: string | null; responsableId: string; echeance?: string | null; priorite?: PrioriteTache; validationRequise?: boolean;
  conflitId?: string | null; demandeId?: string | null; concessionnaireId?: string | null; partagee?: boolean;
}

export async function creerTache(acteur: ActeurWorkflow, projetId: string, c: CorpsCreationTache) {
  for (const [champ, v, max] of [["titre", c.titre, 200], ["description", c.description, 4000]] as const) {
    if (v) { const r = texteBorne(champ, v, max); if (r) lever(r); }
  }
  if (c.echeance && !jourValide(c.echeance)) lever(refus(422, "DATE_INVALIDE", "echeance : date AAAA-MM-JJ valide attendue."));
  if (c.conflitId && c.demandeId) lever(refus(422, "LIEN_INVALIDE", "Une tâche se lie à un conflit ou à une demande, pas aux deux."));
  return transactionProjet(projetId, async (tx) => {
    let derive: string | null = null;
    if (c.conflitId) {
      const k = await tx.conflitProjet.findFirst({ where: { id: c.conflitId, projetId }, select: { concessionnaireId: true } });
      if (!k) throw introuvable("Conflit", "CONFLIT_INTROUVABLE");
      derive = k.concessionnaireId;
    } else if (c.demandeId) {
      const d = await tx.demandeConcessionnaire.findFirst({ where: { id: c.demandeId, projetId }, select: { concessionnaireId: true } });
      if (!d) throw introuvable("Demande", "DEMANDE_INTROUVABLE");
      derive = d.concessionnaireId;
    }
    let concessionnaireId = derive;
    if (c.concessionnaireId) {
      if (derive !== null && c.concessionnaireId !== derive) throw new ErreurMetier(422, "CONCESSIONNAIRE_INCOHERENT", "Le concessionnaire indiqué n'est pas celui du conflit ou de la demande liés.");
      if (derive === null) {
        const k = await tx.concessionnaireReseau.findFirst({ where: { id: c.concessionnaireId, deletedAt: null }, select: { id: true } });
        if (!k) throw introuvable("Concessionnaire", "CONCESSIONNAIRE_INTROUVABLE");
        concessionnaireId = c.concessionnaireId;
      }
    }
    if (c.partagee === true && concessionnaireId === null) throw new ErreurMetier(422, "CONCESSIONNAIRE_INCOHERENT", "Une tâche ne se partage qu'avec le concessionnaire d'un lien (conflit, demande) ou désigné.");
    await verifierResponsableTache(tx, projetId, c.responsableId, concessionnaireId, c.partagee === true);
    exigerQuota(await tx.tacheProjetVoirie.count({ where: { projetId } }), tachesParProjetMax(), "tâches par projet");
    await verifierCadence(tx, acteur, projetId);
    const t = await tx.tacheProjetVoirie.create({
      data: {
        projetId, titre: c.titre.trim(), description: c.description?.trim() || null, conflitId: c.conflitId ?? null, demandeId: c.demandeId ?? null, concessionnaireId,
        partagee: c.partagee === true, responsableId: c.responsableId, echeance: dateJour(c.echeance), priorite: c.priorite ?? "NORMALE", validationRequise: c.validationRequise === true, creeParId: acteur.id,
      },
    });
    const apres = {
      titre: t.titre, responsableId: t.responsableId, echeance: jour(t.echeance), priorite: t.priorite, validationRequise: t.validationRequise,
      conflitId: t.conflitId, demandeId: t.demandeId, concessionnaireId: t.concessionnaireId, partagee: t.partagee,
    };
    await ajouterHistorique(tx, acteur, { projetId, objetType: "TACHE", objetId: t.id, action: "CREATION", nouveauStatut: t.statut, donnees: { apres } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "TacheProjetVoirie", entityId: t.id, after: { ...apres, statut: t.statut, projetId }, ipAddress: acteur.ip });
    return { tache: (await vues([t], acteur, contexteDe(acteur, projetId)))[0] };
  });
}

export interface CorpsModifTache { titre?: string; description?: string | null; echeance?: string | null; priorite?: PrioriteTache; responsableId?: string; partagee?: boolean; justification?: string }

export async function modifierTache(acteur: ActeurWorkflow, projetId: string, id: string, m: CorpsModifTache) {
  if (m.titre !== undefined) { const r = texteBorne("titre", m.titre, 200); if (r) lever(r); }
  if (m.description) { const r = texteBorne("description", m.description, 4000); if (r) lever(r); }
  if (m.echeance && !jourValide(m.echeance)) lever(refus(422, "DATE_INVALIDE", "echeance : date AAAA-MM-JJ valide attendue."));
  if (m.priorite !== undefined && !PRIORITES_TACHE.includes(m.priorite)) lever(refus(400, "CHAMPS_INVALIDES", "priorite inconnue."));
  return transactionProjet(projetId, async (tx) => {
    const t = await tx.tacheProjetVoirie.findFirst({ where: { id, projetId } });
    if (!t) throw TACHE_INTROUVABLE();
    if (STATUTS_TACHE_TERMINAUX.includes(t.statut)) throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", "Cette tâche est terminée ou annulée : elle ne change plus.");
    if (m.responsableId !== undefined && m.responsableId !== t.responsableId) lever(exigerJustification(m.justification, "Une justification pour réaffecter une tâche") ?? { ok: true });
    if (m.partagee === true && t.concessionnaireId === null) throw new ErreurMetier(422, "CONCESSIONNAIRE_INCOHERENT", "Une tâche sans concessionnaire ne se partage pas.");
    if ((m.responsableId !== undefined && m.responsableId !== t.responsableId) || m.partagee !== undefined) {
      await verifierResponsableTache(tx, projetId, m.responsableId ?? t.responsableId, t.concessionnaireId, m.partagee ?? t.partagee);
    }
    const avant = { titre: t.titre, description: t.description, echeance: jour(t.echeance), priorite: t.priorite as string, responsableId: t.responsableId, partagee: t.partagee };
    const diff = diffChamps(avant, {
      ...(m.titre !== undefined ? { titre: m.titre.trim() } : {}), ...(m.description !== undefined ? { description: m.description?.trim() || null } : {}),
      ...(m.echeance !== undefined ? { echeance: m.echeance } : {}), ...(m.priorite !== undefined ? { priorite: m.priorite } : {}),
      ...(m.responsableId !== undefined ? { responsableId: m.responsableId } : {}), ...(m.partagee !== undefined ? { partagee: m.partagee } : {}),
    });
    if (!diff) return { tache: (await vues([t], acteur, contexteDe(acteur, projetId)))[0], modifie: false };
    const a = diff.apres;
    const apres = await tx.tacheProjetVoirie.update({
      where: { id },
      data: {
        ...(a.titre !== undefined ? { titre: a.titre as string } : {}), ...(a.description !== undefined ? { description: a.description as string | null } : {}),
        ...(a.echeance !== undefined ? { echeance: dateJour(a.echeance as string | null) } : {}), ...(a.priorite !== undefined ? { priorite: a.priorite as PrioriteTache } : {}),
        ...(a.responsableId !== undefined ? { responsableId: a.responsableId as string } : {}), ...(a.partagee !== undefined ? { partagee: a.partagee as boolean } : {}),
      },
    });
    const justification = m.justification?.trim() || null;
    await ajouterHistorique(tx, acteur, { projetId, objetType: "TACHE", objetId: id, action: "MODIFICATION", justification, donnees: diff });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "UPDATE", entityType: "TacheProjetVoirie", entityId: id, before: diff.avant, after: { ...diff.apres, justification }, ipAddress: acteur.ip });
    return { tache: (await vues([apres], acteur, contexteDe(acteur, projetId)))[0], modifie: true };
  });
}

export async function changerStatutTache(acteur: ActeurWorkflow, projetId: string, id: string, c: { vers: StatutTache; justification?: string; derogation?: string }) {
  return transactionProjet(projetId, async (tx) => {
    const t = await tacheVisible(acteur, projetId, id, tx);
    const { matrice } = matriceEffective();
    const aValider = t.statut === "A_VALIDER"
      ? await tx.historiqueWorkflowProjet.findFirst({ where: { objetType: "TACHE", objetId: id, action: "STATUT", nouveauStatut: "A_VALIDER" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { acteurId: true } })
      : null;
    const v = evaluerTransitionTache({
      de: t.statut, vers: c.vers, validationRequise: t.validationRequise, acteurId: acteur.id, role: acteur.role, responsableId: t.responsableId,
      peutGerer: autorise(matrice, "tache.gerer", acteur.profil), peutExecuter: autorise(matrice, "tache.executer", acteur.profil),
      justification: c.justification, derogation: c.derogation, aValiderParId: aValider?.acteurId ?? null,
    });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
    const apres = await tx.tacheProjetVoirie.update({ where: { id }, data: { statut: c.vers, termineLe: c.vers === "TERMINEE" ? new Date() : null } });
    await ajouterHistorique(tx, acteur, {
      projetId, objetType: "TACHE", objetId: id, action: "STATUT", ancienStatut: t.statut, nouveauStatut: c.vers, justification: v.justification,
      donnees: v.derogation ? { derogationSeparation: v.derogation } : {},
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: c.vers === "TERMINEE" && t.statut === "A_VALIDER" ? "VALIDATE" : "UPDATE", entityType: "TacheProjetVoirie", entityId: id,
      before: { statut: t.statut }, after: { statut: c.vers, justification: v.justification, derogationSeparation: v.derogation, memePersonne: t.responsableId === acteur.id }, ipAddress: acteur.ip,
    });
    return { tache: (await vues([apres], acteur, contexteDe(acteur, projetId)))[0] };
  });
}
