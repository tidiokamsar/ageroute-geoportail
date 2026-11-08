/**
 * RECOLEMENTS (as-built) : lecture et ecritures (contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, 5.3 et 7).
 *
 * VALIDER UN RECOLEMENT NE MODIFIE NI LE REFERENTIEL OFFICIEL, NI UN JEU, NI LE CONFLIT : c'est l'attestation d'un dossier, par un tiers, qui sert de
 * pre-requis (ou de mention) a la cloture d'un conflit a deplacement decide. Historisation : chaque modification ecrit l'avant et l'apres, l'auteur, son
 * profil, la date et la justification (historique en ajout seul).
 */

import type { Prisma, RecolementProjetVoirie } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { decoderCurseurConflit, encoderCurseurConflit } from "../conflits/curseurs.noyau";
import { ErreurMetier, introuvable } from "../erreurs";
import {
  ajouterHistorique, aujourdhui, contexteDe, dateJour, exigerProjetActif, exigerQuota, jour, lever, lireHistorique, nomsDe, personneDe, transactionProjet, verifierCadence,
  type ActeurWorkflow, type Personne,
} from "./communs";
import { matriceEffective, recolementsParProjetMax } from "./config";
import { clauseCurseur, clausesVisibilite } from "./filtres";
import { autorise } from "./profils.noyau";
import { lirePreuves } from "./preuves.service";
import {
  concessionnaireDuRecolement, conflitEligible, evaluerTransitionRecolement, STATUTS_RECOLEMENT, transitionsRecolementPossibles, TYPES_PREUVE_SUFFISANTE, type StatutRecolement,
} from "./recolements.noyau";
import { diffChamps, exigerDatePassee, exigerJustification, refus, texteBorne } from "./validation.noyau";
import { filtreRecolements, historiqueVisible, jeuLieVisible, ligneVisible, sorteDe, type ContexteLecture } from "./visibilite.noyau";

const RECOLEMENT_INTROUVABLE = () => introuvable("Récolement", "RECOLEMENT_INTROUVABLE");

interface ConflitLie { id: string; type: string; axe: string; statut: string }
interface JeuLie { id: string; version: number; nomFichier: string; statut: string; role: string }

async function conflitsLies(ids: readonly (string | null)[]): Promise<Map<string, ConflitLie>> {
  const uniques = [...new Set(ids.filter((i): i is string => i !== null))];
  if (uniques.length === 0) return new Map();
  const l = await prisma.conflitProjet.findMany({ where: { id: { in: uniques } }, select: { id: true, type: true, axe: true, statut: true } });
  return new Map(l.map((c) => [c.id, c]));
}
async function jeuxLies(ids: readonly (string | null)[]): Promise<Map<string, JeuLie>> {
  const uniques = [...new Set(ids.filter((i): i is string => i !== null))];
  if (uniques.length === 0) return new Map();
  const l = await prisma.jeuDonneesProjet.findMany({ where: { id: { in: uniques } }, select: { id: true, version: true, nomFichier: true, statut: true, role: true } });
  return new Map(l.map((j) => [j.id, j]));
}
async function nomsConcessionnaires(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const uniques = [...new Set(ids.filter((i): i is string => i !== null))];
  if (uniques.length === 0) return new Map();
  const l = await prisma.concessionnaireReseau.findMany({ where: { id: { in: uniques } }, select: { id: true, nom: true } });
  return new Map(l.map((c) => [c.id, c.nom]));
}

function vueRecolement(r: RecolementProjetVoirie, acteur: ActeurWorkflow, ctx: ContexteLecture, o: { noms: Map<string, Personne>; conc: Map<string, string>; conflits: Map<string, ConflitLie>; jeux: Map<string, JeuLie> }) {
  const interne = sorteDe(ctx) === "DECIDEUR";
  const jeu = r.jeuId ? o.jeux.get(r.jeuId) : undefined;
  const jeuVisible = jeu !== undefined && jeuLieVisible(ctx, jeu.statut);
  const conflit = r.conflitId ? o.conflits.get(r.conflitId) : undefined;
  const { matrice } = matriceEffective();
  return {
    id: r.id, projetId: r.projetId, conflit: conflit ? { id: conflit.id, type: conflit.type, axe: conflit.axe, statut: conflit.statut } : null,
    jeu: jeuVisible ? { id: jeu!.id, version: jeu!.version, nomFichier: jeu!.nomFichier, statut: jeu!.statut, role: jeu!.role } : null, jeuMasque: r.jeuId !== null && !jeuVisible,
    concessionnaire: r.concessionnaireId ? { id: r.concessionnaireId, nom: o.conc.get(r.concessionnaireId) ?? "" } : null,
    objet: r.objet, constat: r.constat, ecarts: r.ecarts, dateRecolement: jour(r.dateRecolement), statut: r.statut, revision: r.revision,
    soumission: r.soumisLe ? { le: r.soumisLe, par: interne ? personneDe(o.noms, r.soumisParId) : null } : null,
    decision: r.decideLe ? { le: r.decideLe, par: interne ? personneDe(o.noms, r.decideParId) : null, motif: interne ? r.motifDecision : null, derogationSeparation: interne ? r.derogationSeparation : null } : null,
    creePar: interne ? personneDe(o.noms, r.creeParId) : null, createdAt: r.createdAt, updatedAt: r.updatedAt,
    transitionsPossibles: transitionsRecolementPossibles({ de: r.statut, peutEcrire: autorise(matrice, "recolement.ecrire", acteur.profil), peutValider: autorise(matrice, "recolement.valider", acteur.profil) }),
  };
}

async function vues(lignes: RecolementProjetVoirie[], acteur: ActeurWorkflow, ctx: ContexteLecture) {
  const [noms, conc, conflits, jeux] = await Promise.all([
    nomsDe(lignes.flatMap((r) => [r.creeParId, r.soumisParId, r.decideParId])), nomsConcessionnaires(lignes.map((r) => r.concessionnaireId)),
    conflitsLies(lignes.map((r) => r.conflitId)), jeuxLies(lignes.map((r) => r.jeuId)),
  ]);
  return lignes.map((r) => vueRecolement(r, acteur, ctx, { noms, conc, conflits, jeux }));
}

// ------------------------------------------------------------------------------------------------
// Lecture
// ------------------------------------------------------------------------------------------------

export interface FiltresRecolements { statuts?: StatutRecolement[]; conflitId?: string; jeuId?: string }

function clauses(projetId: string, ctx: ContexteLecture, f: FiltresRecolements, avecStatut: boolean): Prisma.RecolementProjetVoirieWhereInput[] {
  const and: Prisma.RecolementProjetVoirieWhereInput[] = [{ projetId }, ...(clausesVisibilite(filtreRecolements(ctx), { statutNon: "BROUILLON" }, true) as Prisma.RecolementProjetVoirieWhereInput[])];
  if (avecStatut && f.statuts?.length) and.push({ statut: { in: f.statuts } });
  if (f.conflitId) and.push({ conflitId: f.conflitId });
  if (f.jeuId) and.push({ jeuId: f.jeuId });
  return and;
}

export async function listerRecolements(acteur: ActeurWorkflow, projetId: string, f: FiltresRecolements, limite: number, curseur?: { t: Date; i: string }) {
  await exigerProjetActif(projetId);
  const ctx = contexteDe(acteur, projetId);
  const lignes = await prisma.recolementProjetVoirie.findMany({
    where: { AND: [...clauses(projetId, ctx, f, true), ...(clauseCurseur(curseur) as Prisma.RecolementProjetVoirieWhereInput[])] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite + 1,
  });
  const page = lignes.slice(0, limite);
  const groupes = await prisma.recolementProjetVoirie.groupBy({ by: ["statut"], where: { AND: clauses(projetId, ctx, f, false) }, _count: { _all: true } });
  const compteurs: Record<string, number> = Object.fromEntries(STATUTS_RECOLEMENT.map((s) => [s, 0]));
  for (const g of groupes) compteurs[g.statut] = g._count._all;
  const dernier = page[page.length - 1];
  return {
    recolements: await vues(page, acteur, ctx), compteurs,
    curseurSuivant: lignes.length > limite && dernier ? encoderCurseurConflit({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}

export const decoderCurseurRecolement = decoderCurseurConflit;

export async function ficheRecolement(acteur: ActeurWorkflow, projetId: string, id: string) {
  await exigerProjetActif(projetId);
  const r = await prisma.recolementProjetVoirie.findFirst({ where: { id, projetId } });
  const ctx = contexteDe(acteur, projetId);
  if (!r || !ligneVisible(filtreRecolements(ctx), { concessionnaireId: r.concessionnaireId, conflitId: r.conflitId, partage: r.statut !== "BROUILLON" })) throw RECOLEMENT_INTROUVABLE();
  const [[recolement], preuves, historique] = await Promise.all([
    vues([r], acteur, ctx), lirePreuves(acteur, ctx, "RECOLEMENT", id), historiqueVisible(ctx) ? lireHistorique("RECOLEMENT", id) : Promise.resolve(undefined),
  ]);
  return { recolement, preuves, ...(historique ? { historique } : {}), transitionsPossibles: recolement.transitionsPossibles };
}

// ------------------------------------------------------------------------------------------------
// Ecritures
// ------------------------------------------------------------------------------------------------

export interface CorpsCreationRecolement { conflitId?: string | null; jeuId?: string | null; objet: string; constat?: string | null; ecarts?: string | null; dateRecolement?: string | null }

export async function creerRecolement(acteur: ActeurWorkflow, projetId: string, c: CorpsCreationRecolement) {
  if (!c.conflitId && !c.jeuId) lever(refus(422, "LIEN_INVALIDE", "Un récolement se rattache à un conflit dont un déplacement est décidé, ou à un jeu (ou aux deux)."));
  for (const [champ, v, max] of [["objet", c.objet, 200], ["constat", c.constat, 4000], ["ecarts", c.ecarts, 4000]] as const) {
    if (v) { const r = texteBorne(champ, v, max); if (r) lever(r); }
  }
  if (c.dateRecolement) { const r = exigerDatePassee("dateRecolement", c.dateRecolement, aujourdhui()); if (r) lever(r); }
  return transactionProjet(projetId, async (tx) => {
    let concConflit: string | null = null;
    let concJeu: string | null = null;
    if (c.conflitId) {
      const k = await tx.conflitProjet.findFirst({ where: { id: c.conflitId, projetId }, select: { id: true, statut: true, concessionnaireId: true } });
      if (!k) throw introuvable("Conflit", "CONFLIT_INTROUVABLE");
      const [decisions, confirme] = await Promise.all([
        tx.decisionConflit.findMany({ where: { conflitId: k.id }, select: { id: true, option: true, statut: true, proposeParId: true, approuveLe: true } }),
        tx.conflitHistorique.findFirst({ where: { conflitId: k.id, action: "STATUT", nouveauStatut: "CONFIRME" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } }),
      ]);
      lever(conflitEligible({ statut: k.statut, decisions, dernierPassageConfirmeLe: confirme?.createdAt ?? null }));
      concConflit = k.concessionnaireId;
      const actif = await tx.recolementProjetVoirie.findFirst({ where: { conflitId: k.id, statut: { in: ["BROUILLON", "SOUMIS"] } }, select: { id: true } });
      if (actif) throw new ErreurMetier(409, "RECOLEMENT_EN_COURS", "Un récolement est déjà en cours (brouillon ou soumis) pour ce conflit.", { recolementId: actif.id });
    }
    if (c.jeuId) {
      const j = await tx.jeuDonneesProjet.findFirst({ where: { id: c.jeuId, projetId }, select: { id: true, statut: true, concessionnaireId: true } });
      if (!j) throw introuvable("Jeu de données", "JEU_INTROUVABLE");
      if (j.statut === "RETIRE") throw new ErreurMetier(422, "LIEN_INVALIDE", "Un jeu retiré ne reçoit pas de récolement.");
      concJeu = j.concessionnaireId;
      const actif = await tx.recolementProjetVoirie.findFirst({ where: { jeuId: j.id, statut: { in: ["BROUILLON", "SOUMIS"] } }, select: { id: true } });
      if (actif) throw new ErreurMetier(409, "RECOLEMENT_EN_COURS", "Un récolement est déjà en cours (brouillon ou soumis) pour ce jeu.", { recolementId: actif.id });
    }
    const conc = concessionnaireDuRecolement(concConflit, concJeu);
    if (!conc.ok) throw new ErreurMetier(conc.status, conc.code, conc.message);
    exigerQuota(await tx.recolementProjetVoirie.count({ where: { projetId } }), recolementsParProjetMax(), "récolements par projet");
    await verifierCadence(tx, acteur, projetId);
    const r = await tx.recolementProjetVoirie.create({
      data: {
        projetId, conflitId: c.conflitId ?? null, jeuId: c.jeuId ?? null, concessionnaireId: conc.concessionnaireId, objet: c.objet.trim(), constat: c.constat?.trim() || null,
        ecarts: c.ecarts?.trim() || null, dateRecolement: dateJour(c.dateRecolement), creeParId: acteur.id,
      },
    });
    const apres = { conflitId: r.conflitId, jeuId: r.jeuId, concessionnaireId: r.concessionnaireId, objet: r.objet, dateRecolement: jour(r.dateRecolement) };
    await ajouterHistorique(tx, acteur, { projetId, objetType: "RECOLEMENT", objetId: r.id, action: "CREATION", nouveauStatut: r.statut, donnees: { apres, revision: r.revision } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "RecolementProjetVoirie", entityId: r.id, after: { ...apres, statut: r.statut, projetId }, ipAddress: acteur.ip });
    return { recolement: (await vues([r], acteur, contexteDe(acteur, projetId)))[0] };
  });
}

export interface CorpsModifRecolement { objet?: string; constat?: string | null; ecarts?: string | null; dateRecolement?: string | null; justification: string }

/** Modification (BROUILLON seulement) : justification obligatoire, avant/apres historises, revision +1. */
export async function modifierRecolement(acteur: ActeurWorkflow, projetId: string, id: string, m: CorpsModifRecolement) {
  lever(exigerJustification(m.justification, "Une justification") ?? { ok: true });
  if (m.objet !== undefined) { const r = texteBorne("objet", m.objet, 200); if (r) lever(r); }
  for (const [champ, v] of [["constat", m.constat], ["ecarts", m.ecarts]] as const) {
    if (v) { const r = texteBorne(champ, v, 4000); if (r) lever(r); }
  }
  if (m.dateRecolement) { const r = exigerDatePassee("dateRecolement", m.dateRecolement, aujourdhui()); if (r) lever(r); }
  return transactionProjet(projetId, async (tx) => {
    const r = await tx.recolementProjetVoirie.findFirst({ where: { id, projetId } });
    if (!r) throw RECOLEMENT_INTROUVABLE();
    if (r.statut !== "BROUILLON") throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", `Un récolement ne se modifie qu'en brouillon (statut actuel : ${r.statut}) : retirez-le ou rouvrez-le d'abord.`, { statut: r.statut });
    const avant = { objet: r.objet, constat: r.constat, ecarts: r.ecarts, dateRecolement: jour(r.dateRecolement) };
    const diff = diffChamps(avant, {
      ...(m.objet !== undefined ? { objet: m.objet.trim() } : {}), ...(m.constat !== undefined ? { constat: m.constat?.trim() || null } : {}),
      ...(m.ecarts !== undefined ? { ecarts: m.ecarts?.trim() || null } : {}), ...(m.dateRecolement !== undefined ? { dateRecolement: m.dateRecolement } : {}),
    });
    if (!diff) return { recolement: (await vues([r], acteur, contexteDe(acteur, projetId)))[0], modifie: false };
    const a = diff.apres;
    const apres = await tx.recolementProjetVoirie.update({
      where: { id },
      data: {
        ...(a.objet !== undefined ? { objet: a.objet as string } : {}), ...(a.constat !== undefined ? { constat: a.constat as string | null } : {}),
        ...(a.ecarts !== undefined ? { ecarts: a.ecarts as string | null } : {}), ...(a.dateRecolement !== undefined ? { dateRecolement: dateJour(a.dateRecolement as string | null) } : {}),
        revision: { increment: 1 },
      },
    });
    const justification = m.justification.trim();
    await ajouterHistorique(tx, acteur, { projetId, objetType: "RECOLEMENT", objetId: id, action: "MODIFICATION", justification, donnees: { ...diff, revisionAvant: r.revision, revisionApres: apres.revision } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "UPDATE", entityType: "RecolementProjetVoirie", entityId: id, before: { ...diff.avant, revision: r.revision }, after: { ...diff.apres, revision: apres.revision, justification }, ipAddress: acteur.ip });
    return { recolement: (await vues([apres], acteur, contexteDe(acteur, projetId)))[0], modifie: true };
  });
}

export async function changerStatutRecolement(acteur: ActeurWorkflow, projetId: string, id: string, c: { vers: StatutRecolement; justification?: string; derogation?: string }) {
  return transactionProjet(projetId, async (tx) => {
    const r = await tx.recolementProjetVoirie.findFirst({ where: { id, projetId } });
    if (!r) throw RECOLEMENT_INTROUVABLE();
    const { matrice } = matriceEffective();
    const [nbPreuves, modificateurs] = await Promise.all([
      tx.preuveWorkflowProjet.count({ where: { objetType: "RECOLEMENT", objetId: id, type: { in: [...TYPES_PREUVE_SUFFISANTE] } } }),
      tx.historiqueWorkflowProjet.findMany({ where: { objetType: "RECOLEMENT", objetId: id, action: "MODIFICATION" }, select: { acteurId: true }, distinct: ["acteurId"] }),
    ]);
    const v = evaluerTransitionRecolement({
      de: r.statut, vers: c.vers, acteurId: acteur.id, role: acteur.role, peutEcrire: autorise(matrice, "recolement.ecrire", acteur.profil), peutValider: autorise(matrice, "recolement.valider", acteur.profil),
      justification: c.justification, derogation: c.derogation, objet: r.objet, constat: r.constat, nbPreuvesSuffisantes: nbPreuves,
      auteursIds: [r.creeParId, r.soumisParId, ...modificateurs.map((x) => x.acteurId)],
    });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
    const maintenant = new Date();
    const data: Prisma.RecolementProjetVoirieUncheckedUpdateInput = { statut: c.vers };
    if (c.vers === "SOUMIS") Object.assign(data, { soumisParId: acteur.id, soumisLe: maintenant, decideParId: null, decideLe: null, motifDecision: null, derogationSeparation: null });
    else if (c.vers === "VALIDE" || c.vers === "REJETE") Object.assign(data, { decideParId: acteur.id, decideLe: maintenant, motifDecision: v.justification, derogationSeparation: c.vers === "VALIDE" ? v.derogation : null });
    else Object.assign(data, { decideParId: null, decideLe: null, motifDecision: null, derogationSeparation: null });
    const apres = await tx.recolementProjetVoirie.update({ where: { id }, data });
    await ajouterHistorique(tx, acteur, {
      projetId, objetType: "RECOLEMENT", objetId: id, action: "STATUT", ancienStatut: r.statut, nouveauStatut: c.vers, justification: v.justification,
      donnees: { ...(v.derogation ? { derogationSeparation: v.derogation } : {}), revision: r.revision, ...(c.vers === "VALIDE" ? { nbPreuvesSuffisantes: nbPreuves } : {}) },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: c.vers === "VALIDE" ? "VALIDATE" : c.vers === "REJETE" ? "REJECT" : "UPDATE", entityType: "RecolementProjetVoirie", entityId: id,
      before: { statut: r.statut }, after: { statut: c.vers, justification: v.justification, derogationSeparation: v.derogation, memePersonne: r.creeParId === acteur.id || r.soumisParId === acteur.id }, ipAddress: acteur.ip,
    });
    return { recolement: (await vues([apres], acteur, contexteDe(acteur, projetId)))[0] };
  });
}
