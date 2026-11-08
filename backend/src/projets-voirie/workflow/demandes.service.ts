/**
 * DEMANDES DE DONNEES AUX CONCESSIONNAIRES : lecture et ecritures (contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, 5.1).
 *
 * L'ENVOI SE FAIT HORS APPLICATION : ce service enregistre un envoi fait par une personne ; il n'emet aucun courriel, aucun message, aucune
 * requete reseau (un test statique interdit d'importer un client de messagerie ou HTTP dans le workflow). Recevoir une reponse (lier un jeu) ne
 * modifie pas le jeu : il reste en quarantaine jusqu'a son autorisation par le socle.
 */

import type { DemandeConcessionnaire, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { decoderCurseurConflit, encoderCurseurConflit } from "../conflits/curseurs.noyau";
import { ErreurMetier, introuvable } from "../erreurs";
import {
  ajouterHistorique, aujourdhui, contexteDe, dateJour, exigerProjetActif, exigerQuota, jour, lever, lireHistorique, nomsDe, personneDe, transactionProjet,
  verifierCadence, type ActeurWorkflow, type Personne, type Tx,
} from "./communs";
import { demandesParProjetMax, matriceEffective } from "./config";
import {
  evaluerModificationDemande, evaluerTransitionDemande, transitionsDemandePossibles, type CorpsStatutDemande, type StatutDemande, STATUTS_DEMANDE,
} from "./demandes.noyau";
import { clauseCurseur, clausesVisibilite, minuitUtc } from "./filtres";
import { autorise } from "./profils.noyau";
import { lirePreuves } from "./preuves.service";
import { diffChamps, texteBorne } from "./validation.noyau";
import { filtreDemandes, historiqueVisible, jeuLieVisible, ligneVisible, sorteDe, type ContexteLecture } from "./visibilite.noyau";

const DEMANDE_INTROUVABLE = () => introuvable("Demande", "DEMANDE_INTROUVABLE");

interface JeuLie { id: string; version: number; nomFichier: string; statut: string }

async function jeuxLies(ids: readonly (string | null)[]): Promise<Map<string, JeuLie>> {
  const uniques = [...new Set(ids.filter((i): i is string => i !== null))];
  if (uniques.length === 0) return new Map();
  const l = await prisma.jeuDonneesProjet.findMany({ where: { id: { in: uniques } }, select: { id: true, version: true, nomFichier: true, statut: true } });
  return new Map(l.map((j) => [j.id, j]));
}

/** Vue d'une demande. Un referent ne voit pas le personnel d'AGEROUTE (createur, enregistreurs) ni le motif de fin ; un lecteur de projet pas l'interlocuteur. */
function vueDemande(d: DemandeConcessionnaire, ctx: ContexteLecture, noms: Map<string, Personne>, conc: Map<string, string>, jeux: Map<string, JeuLie>) {
  const sorte = sorteDe(ctx);
  const interne = sorte === "DECIDEUR";
  const jeu = d.jeuRecuId ? jeux.get(d.jeuRecuId) : undefined;
  const jeuVisible = jeu !== undefined && jeuLieVisible(ctx, jeu.statut);
  return {
    id: d.id, projetId: d.projetId, concessionnaire: { id: d.concessionnaireId, nom: conc.get(d.concessionnaireId) ?? "" },
    objet: d.objet, description: d.description, echeance: jour(d.echeance), statut: d.statut,
    echeanceDepassee: d.echeance !== null && d.echeance < minuitUtc() && (d.statut === "BROUILLON" || d.statut === "ENVOYEE"),
    envoi: d.envoyeLe
      ? {
        dateEnvoi: jour(d.dateEnvoi), canal: d.canalEnvoi, reference: d.referenceEnvoi, interlocuteur: sorte === "AUTRE" ? null : d.interlocuteur,
        enregistrePar: interne ? personneDe(noms, d.envoyeParId) : null, enregistreLe: d.envoyeLe,
      }
      : null,
    reception: d.recueLe
      ? {
        dateReception: jour(d.dateReception), enregistrePar: interne ? personneDe(noms, d.recueParId) : null, enregistreLe: d.recueLe,
        jeu: jeuVisible ? { id: jeu!.id, version: jeu!.version, nomFichier: jeu!.nomFichier, statut: jeu!.statut } : null, jeuMasque: d.jeuRecuId !== null && !jeuVisible,
      }
      : null,
    fin: d.finLe ? { type: d.statut === "ANNULEE" ? "ANNULEE" : "CLOTUREE", le: d.finLe, par: interne ? personneDe(noms, d.finParId) : null, motif: interne ? d.motifFin : null } : null,
    creePar: interne ? personneDe(noms, d.creeParId) : null, createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

async function nomsConcessionnaires(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const l = await prisma.concessionnaireReseau.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, nom: true } });
  return new Map(l.map((c) => [c.id, c.nom]));
}

async function vues(lignes: DemandeConcessionnaire[], ctx: ContexteLecture) {
  const [noms, conc, jeux] = await Promise.all([
    nomsDe(lignes.flatMap((d) => [d.creeParId, d.envoyeParId, d.recueParId, d.finParId])), nomsConcessionnaires(lignes.map((d) => d.concessionnaireId)), jeuxLies(lignes.map((d) => d.jeuRecuId)),
  ]);
  return lignes.map((d) => vueDemande(d, ctx, noms, conc, jeux));
}

// ------------------------------------------------------------------------------------------------
// Lecture
// ------------------------------------------------------------------------------------------------

export interface FiltresDemandes { statuts?: StatutDemande[]; concessionnaireId?: string; echeanceDepassee?: boolean }

function clauses(projetId: string, ctx: ContexteLecture, f: FiltresDemandes, avecStatut: boolean): Prisma.DemandeConcessionnaireWhereInput[] {
  const and: Prisma.DemandeConcessionnaireWhereInput[] = [{ projetId }, ...(clausesVisibilite(filtreDemandes(ctx), { renseignee: "envoyeLe" }, false) as Prisma.DemandeConcessionnaireWhereInput[])];
  if (avecStatut && f.statuts?.length) and.push({ statut: { in: f.statuts } });
  if (f.concessionnaireId) and.push({ concessionnaireId: f.concessionnaireId });
  if (f.echeanceDepassee === true) and.push({ echeance: { lt: minuitUtc() }, statut: { in: ["BROUILLON", "ENVOYEE"] } });
  if (f.echeanceDepassee === false) and.push({ OR: [{ echeance: null }, { echeance: { gte: minuitUtc() } }, { statut: { notIn: ["BROUILLON", "ENVOYEE"] } }] });
  return and;
}

export async function listerDemandes(acteur: ActeurWorkflow, projetId: string, f: FiltresDemandes, limite: number, curseur?: { t: Date; i: string }) {
  await exigerProjetActif(projetId);
  const ctx = contexteDe(acteur, projetId);
  const base = clauses(projetId, ctx, f, true);
  const lignes = await prisma.demandeConcessionnaire.findMany({
    where: { AND: [...base, ...(clauseCurseur(curseur) as Prisma.DemandeConcessionnaireWhereInput[])] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite + 1,
  });
  const page = lignes.slice(0, limite);
  const groupes = await prisma.demandeConcessionnaire.groupBy({ by: ["statut"], where: { AND: clauses(projetId, ctx, f, false) }, _count: { _all: true } });
  const compteurs: Record<string, number> = Object.fromEntries(STATUTS_DEMANDE.map((s) => [s, 0]));
  for (const g of groupes) compteurs[g.statut] = g._count._all;
  const dernier = page[page.length - 1];
  return {
    demandes: await vues(page, ctx), compteurs,
    curseurSuivant: lignes.length > limite && dernier ? encoderCurseurConflit({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}

export const decoderCurseurDemande = decoderCurseurConflit;

/** Lit une demande du projet visible du profil ; sinon la MEME 404 (inconnue, d'un autre projet, d'un autre concessionnaire, brouillon pour un referent). */
async function demandeVisible(acteur: ActeurWorkflow, projetId: string, id: string): Promise<DemandeConcessionnaire> {
  const d = await prisma.demandeConcessionnaire.findFirst({ where: { id, projetId } });
  if (!d || !ligneVisible(filtreDemandes(contexteDe(acteur, projetId)), { concessionnaireId: d.concessionnaireId, partage: d.envoyeLe !== null })) throw DEMANDE_INTROUVABLE();
  return d;
}

export async function ficheDemande(acteur: ActeurWorkflow, projetId: string, id: string) {
  await exigerProjetActif(projetId);
  const d = await demandeVisible(acteur, projetId, id);
  const ctx = contexteDe(acteur, projetId);
  const [[demande], preuves, historique] = await Promise.all([
    vues([d], ctx), lirePreuves(acteur, ctx, "DEMANDE", id), historiqueVisible(ctx) ? lireHistorique("DEMANDE", id) : Promise.resolve(undefined),
  ]);
  const peut = autorise(matriceEffective().matrice, "demande.ecrire", acteur.profil);
  return { demande, preuves, ...(historique ? { historique } : {}), transitionsPossibles: peut ? transitionsDemandePossibles(d.statut) : [] };
}

// ------------------------------------------------------------------------------------------------
// Ecritures
// ------------------------------------------------------------------------------------------------

export interface CorpsCreationDemande { concessionnaireId: string; objet: string; description?: string | null; echeance?: string | null }

export async function creerDemande(acteur: ActeurWorkflow, projetId: string, c: CorpsCreationDemande) {
  for (const [champ, v, max] of [["objet", c.objet, 200], ["description", c.description, 4000]] as const) {
    if (v) { const r = texteBorne(champ, v, max); if (r) lever(r); }
  }
  return transactionProjet(projetId, async (tx) => {
    const conc = await tx.concessionnaireReseau.findFirst({ where: { id: c.concessionnaireId, deletedAt: null }, select: { id: true, nom: true } });
    if (!conc) throw introuvable("Concessionnaire", "CONCESSIONNAIRE_INTROUVABLE");
    exigerQuota(await tx.demandeConcessionnaire.count({ where: { projetId } }), demandesParProjetMax(), "demandes par projet");
    await verifierCadence(tx, acteur, projetId);
    const d = await tx.demandeConcessionnaire.create({
      data: { projetId, concessionnaireId: c.concessionnaireId, objet: c.objet.trim(), description: c.description?.trim() || null, echeance: dateJour(c.echeance), creeParId: acteur.id },
    });
    const apres = { concessionnaireId: d.concessionnaireId, objet: d.objet, echeance: jour(d.echeance) };
    await ajouterHistorique(tx, acteur, { projetId, objetType: "DEMANDE", objetId: d.id, action: "CREATION", nouveauStatut: d.statut, donnees: { apres } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "DemandeConcessionnaire", entityId: d.id, after: { ...apres, statut: d.statut, projetId }, ipAddress: acteur.ip });
    const ctx = contexteDe(acteur, projetId);
    return { demande: (await vues([d], ctx))[0] };
  });
}

/** Un jeu recu lie a une demande : meme projet, meme concessionnaire, reseau de tiers, jamais retire. */
async function verifierJeuRecu(tx: Tx, projetId: string, concessionnaireId: string, jeuId: string): Promise<void> {
  const j = await tx.jeuDonneesProjet.findFirst({ where: { id: jeuId, projetId }, select: { role: true, concessionnaireId: true, statut: true } });
  if (!j) throw introuvable("Jeu de données", "JEU_INTROUVABLE");
  if (j.statut === "RETIRE" || j.role !== "RESEAU_TIERS" || j.concessionnaireId !== concessionnaireId) {
    throw new ErreurMetier(422, "LIEN_INVALIDE", "Le jeu reçu doit être un jeu de réseau tiers non retiré du même projet et du même concessionnaire que la demande.");
  }
}

export async function changerStatutDemande(acteur: ActeurWorkflow, projetId: string, id: string, corps: CorpsStatutDemande) {
  return transactionProjet(projetId, async (tx) => {
    const d = await tx.demandeConcessionnaire.findFirst({ where: { id, projetId } });
    if (!d) throw DEMANDE_INTROUVABLE();
    const v = evaluerTransitionDemande({ de: d.statut, corps, aujourdhui: aujourdhui(), dateEnvoiEnregistree: jour(d.dateEnvoi) });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
    const e = v.effet;
    const maintenant = new Date();
    const data: Prisma.DemandeConcessionnaireUncheckedUpdateInput = { statut: e.vers };
    let justification: string | null = null;
    const donnees: Record<string, unknown> = {};
    if (e.vers === "ENVOYEE") {
      Object.assign(data, { canalEnvoi: e.canalEnvoi, dateEnvoi: dateJour(e.dateEnvoi), referenceEnvoi: e.referenceEnvoi, interlocuteur: e.interlocuteur, envoyeParId: acteur.id, envoyeLe: maintenant });
      Object.assign(donnees, { canalEnvoi: e.canalEnvoi, dateEnvoi: e.dateEnvoi, referenceEnvoi: e.referenceEnvoi, envoiRealiseHorsApplication: true });
    } else if (e.vers === "RECUE") {
      if (e.jeuRecuId) await verifierJeuRecu(tx, projetId, d.concessionnaireId, e.jeuRecuId);
      Object.assign(data, { dateReception: dateJour(e.dateReception), recueParId: acteur.id, recueLe: maintenant, jeuRecuId: e.jeuRecuId });
      Object.assign(donnees, { dateReception: e.dateReception, jeuRecuId: e.jeuRecuId });
      justification = e.note;
    } else {
      Object.assign(data, { finParId: acteur.id, finLe: maintenant, motifFin: e.motifFin });
      justification = e.motifFin;
    }
    const apres = await tx.demandeConcessionnaire.update({ where: { id }, data });
    await ajouterHistorique(tx, acteur, { projetId, objetType: "DEMANDE", objetId: id, action: "STATUT", ancienStatut: d.statut, nouveauStatut: e.vers, justification, donnees });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "UPDATE", entityType: "DemandeConcessionnaire", entityId: id,
      before: { statut: d.statut }, after: { statut: e.vers, justification, ...donnees }, ipAddress: acteur.ip,
    });
    return { demande: (await vues([apres], contexteDe(acteur, projetId)))[0] };
  });
}

export interface CorpsModifDemande { objet?: string; description?: string | null; echeance?: string | null; jeuRecuId?: string | null; justification?: string }

export async function modifierDemande(acteur: ActeurWorkflow, projetId: string, id: string, m: CorpsModifDemande) {
  return transactionProjet(projetId, async (tx) => {
    const d = await tx.demandeConcessionnaire.findFirst({ where: { id, projetId } });
    if (!d) throw DEMANDE_INTROUVABLE();
    lever(evaluerModificationDemande({ statut: d.statut, champs: m }));
    if (m.jeuRecuId) await verifierJeuRecu(tx, projetId, d.concessionnaireId, m.jeuRecuId);
    const avantVue = { objet: d.objet, description: d.description, echeance: jour(d.echeance), jeuRecuId: d.jeuRecuId };
    const apresVue = {
      ...(m.objet !== undefined ? { objet: m.objet.trim() } : {}), ...(m.description !== undefined ? { description: m.description?.trim() || null } : {}),
      ...(m.echeance !== undefined ? { echeance: m.echeance } : {}), ...(m.jeuRecuId !== undefined ? { jeuRecuId: m.jeuRecuId } : {}),
    };
    const diff = diffChamps(avantVue, apresVue);
    if (!diff) return { demande: (await vues([d], contexteDe(acteur, projetId)))[0], modifie: false };
    const apres = await tx.demandeConcessionnaire.update({
      where: { id },
      data: {
        ...(diff.apres.objet !== undefined ? { objet: diff.apres.objet as string } : {}), ...(diff.apres.description !== undefined ? { description: diff.apres.description as string | null } : {}),
        ...(diff.apres.echeance !== undefined ? { echeance: dateJour(diff.apres.echeance as string | null) } : {}), ...(diff.apres.jeuRecuId !== undefined ? { jeuRecuId: diff.apres.jeuRecuId as string | null } : {}),
      },
    });
    const justification = m.justification?.trim() || null;
    await ajouterHistorique(tx, acteur, { projetId, objetType: "DEMANDE", objetId: id, action: "MODIFICATION", justification, donnees: diff });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "UPDATE", entityType: "DemandeConcessionnaire", entityId: id, before: diff.avant, after: { ...diff.apres, justification }, ipAddress: acteur.ip });
    return { demande: (await vues([apres], contexteDe(acteur, projetId)))[0], modifie: true };
  });
}
