/**
 * DOSSIERS DE CONFLIT : lecture (liste filtrable, fiche), attribution, transitions de statut, preuves, decisions, export CSV
 * (contrat RC-3, sections 4 et 6).
 *
 * REGLES :
 *   - un conflit est un signal de verification, jamais un ordre : aucune route de ce service ne cree d'ordre, de deplacement ni de decision
 *     automatique ; une decision est une proposition humaine, approuvee ou refusee par une autre personne (separation des taches) ;
 *   - toute ecriture se fait dans UNE transaction qui verrouille la ligne du conflit, ecrit l'historique (ajout seul) et l'audit ;
 *   - la LECTURE de la geometrie d'un reseau de tiers est tracee comme celle de la carte (consultation.ts), avant la remise des donnees ;
 *   - un compte qui n'est ni ADMIN ni GESTIONNAIRE ne voit la geometrie, la boite englobante et le jeu d'un conflit que si ce jeu est
 *     encore AUTORISE (meme regle que le socle pour les jeux) ; un jeu RETIRE n'est montre a personne : le dossier reste, sa geometrie non ;
 *   - un recalcul ne modifie jamais ce que ce service a ecrit (voir la migration : declencheur `conflits_projet_recalcul`).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { estDelaiDepasse, poserDelais } from "../bd";
import { delaiDepotMs, delaiVerrouMs } from "../config";
import { tracerConsultation } from "../consultation";
import { celluleCsv } from "../analyse.service";
import { ErreurMetier, introuvable } from "../erreurs";
import { voitTousLesJeux, type Acteur } from "../projets.service";
import * as depot from "./conflits.depot";
import {
  evaluerTransition, transitionsPossibles, verifierPropositionDecision, verifierSeparationDecision, verifierTranchage,
  type DecisionApprouvee,
} from "./etats.noyau";
import {
  AVERTISSEMENTS_DOSSIER, JUSTIFICATION_MIN, OPTIONS_DECISION, RISQUES_CONFLIT, STATUTS_CONFLIT, TYPES_CONFLIT, TYPES_PREUVE, type OptionDecision, type StatutConflit, type TypePreuve, type RisqueConflit,
} from "./types.noyau";

export const CONFLIT_INTROUVABLE = (): ErreurMetier => introuvable("Conflit", "CONFLIT_INTROUVABLE");

const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const nombre = (d: Prisma.Decimal | null | undefined): number | null => (d === null || d === undefined ? null : Number(d));
const aujourdhui = (): Date => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const personne = (p: { id: string; nomComplet: string } | null | undefined) => (p ? { id: p.id, nomComplet: p.nomComplet } : null);
const STATUTS_FERMES: StatutConflit[] = ["CLOTURE", "INFIRME"];

// ------------------------------------------------------------------------------------------------
// Vues
// ------------------------------------------------------------------------------------------------

const INCLURE_LISTE = {
  responsable: { select: { id: true, nomComplet: true } },
  concessionnaire: { select: { id: true, nom: true } },
  jeuReseau: { select: { id: true, statut: true, typeReseau: true, confidentialite: true, version: true } },
  objet: { select: { id: true, nom: true } },
} as const;

type LigneConflit = Prisma.ConflitProjetGetPayload<{ include: typeof INCLURE_LISTE }>;

/** Vrai si `role` peut lire la geometrie d'un conflit dont le jeu de reseau a ce statut (nul : conflit sans jeu de reseau, ex. couverture). */
export function geometrieVisible(role: string, statutJeu: string | null): boolean {
  if (statutJeu === null) return true;
  if (statutJeu === "RETIRE") return false;
  return voitTousLesJeux(role) || statutJeu === "AUTORISE";
}

export function vueConflit(c: LigneConflit, role: string, bbox: number[] | null) {
  const visible = geometrieVisible(role, c.jeuReseau?.statut ?? null);
  const depassee = c.echeance !== null && c.echeance < aujourdhui() && !STATUTS_FERMES.includes(c.statut as StatutConflit);
  return {
    id: c.id, projetId: c.projetId, cle: c.cle, type: c.type, axe: c.axe, statut: c.statut, risque: c.risque,
    aReexaminer: c.aReexaminer, motifReexamen: c.motifReexamen,
    responsable: personne(c.responsable), echeance: jour(c.echeance), echeanceDepassee: depassee, actionProposee: c.actionProposee,
    classePrecision: c.classePrecision, verticalEvalue: c.verticalEvalue,
    concessionnaire: c.concessionnaire ? { id: c.concessionnaire.id, nom: c.concessionnaire.nom } : null,
    typeReseau: c.jeuReseau?.typeReseau ?? null,
    jeuReseauId: visible ? c.jeuReseauId : null,
    objet: c.objet ? { id: String(c.objet.id), nom: c.objet.nom } : null,
    mesure: c.mesure, premiereAnalyseId: c.premiereAnalyseId, derniereAnalyseId: c.derniereAnalyseId,
    bbox: visible ? bbox : null, geometrieMasquee: !visible,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

async function boitesEnglobantes(ids: readonly string[]): Promise<Map<string, number[]>> {
  if (ids.length === 0) return new Map();
  const r = await prisma.$queryRaw<{ id: string; w: number; s: number; e: number; n: number }[]>`
    SELECT "id", ST_XMin("geom") AS "w", ST_YMin("geom") AS "s", ST_XMax("geom") AS "e", ST_YMax("geom") AS "n" FROM "conflits_projet" WHERE "id" = ANY(${[...ids]}::text[])`;
  return new Map(r.map((x) => [x.id, [Number(x.w), Number(x.s), Number(x.e), Number(x.n)]]));
}

// ------------------------------------------------------------------------------------------------
// Liste
// ------------------------------------------------------------------------------------------------

export interface FiltresConflits {
  statuts?: StatutConflit[]; types?: string[]; axe?: string; concessionnaireId?: string; responsableId?: string;
  aReexaminer?: boolean; echeanceDepassee?: boolean; q?: string;
}

function ou(...l: Prisma.ConflitProjetWhereInput[]): Prisma.ConflitProjetWhereInput { return { OR: l }; }

export function filtreConflits(projetId: string, f: FiltresConflits, inclureStatut = true): Prisma.ConflitProjetWhereInput {
  const and: Prisma.ConflitProjetWhereInput[] = [{ projetId }];
  if (inclureStatut && f.statuts?.length) and.push({ statut: { in: f.statuts } });
  if (f.types?.length) and.push({ type: { in: f.types as never[] } });
  if (f.axe) and.push({ axe: { equals: f.axe, mode: "insensitive" } });
  if (f.concessionnaireId) and.push({ concessionnaireId: f.concessionnaireId });
  if (f.responsableId) and.push({ responsableId: f.responsableId });
  if (f.aReexaminer !== undefined) and.push({ aReexaminer: f.aReexaminer });
  if (f.echeanceDepassee === true) and.push({ echeance: { lt: aujourdhui() }, statut: { notIn: STATUTS_FERMES } });
  if (f.echeanceDepassee === false) and.push(ou({ echeance: null }, { echeance: { gte: aujourdhui() } }, { statut: { in: STATUTS_FERMES } }));
  if (f.q) and.push(ou({ axe: { contains: f.q, mode: "insensitive" } }, { actionProposee: { contains: f.q, mode: "insensitive" } },
    { concessionnaire: { nom: { contains: f.q, mode: "insensitive" } } }, { objet: { nom: { contains: f.q, mode: "insensitive" } } }));
  return { AND: and };
}

const encoderCurseur = (c: { t: string; i: string }) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
export function decoderCurseurConflit(s: string): { t: Date; i: string } | null {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof o.t !== "string" || typeof o.i !== "string" || o.i.length > 64) return null;
    const t = new Date(o.t);
    return Number.isNaN(t.getTime()) ? null : { t, i: o.i };
  } catch { return null; }
}

export async function listerConflits(acteur: Acteur, projetId: string, f: FiltresConflits, limite: number, curseur?: { t: Date; i: string }) {
  const base = filtreConflits(projetId, f);
  const where: Prisma.ConflitProjetWhereInput = curseur
    ? { AND: [base, ou({ createdAt: { lt: curseur.t } }, { createdAt: curseur.t, id: { lt: curseur.i } })] }
    : base;
  const lignes = await prisma.conflitProjet.findMany({ where, include: INCLURE_LISTE, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite + 1 });
  const page = lignes.slice(0, limite);
  const [boites, groupes] = await Promise.all([
    boitesEnglobantes(page.map((c) => c.id)),
    prisma.conflitProjet.groupBy({ by: ["statut"], where: filtreConflits(projetId, f, false), _count: { _all: true } }),
  ]);
  const compteurs: Record<string, number> = Object.fromEntries(STATUTS_CONFLIT.map((s) => [s, 0]));
  for (const g of groupes) compteurs[g.statut] = g._count._all;
  const vues = page.map((c) => vueConflit(c, acteur.role, boites.get(c.id) ?? null));

  // Le rendu de la boite englobante d'un reseau de tiers est une lecture de position : tracee comme la carte, avant la remise.
  const parJeu = new Map<string, { id: string; confidentialite: string; nbObjets: number }>();
  for (const c of page) {
    if (!c.jeuReseau || !geometrieVisible(acteur.role, c.jeuReseau.statut)) continue;
    const j = parJeu.get(c.jeuReseau.id) ?? { id: c.jeuReseau.id, confidentialite: c.jeuReseau.confidentialite, nbObjets: 0 };
    j.nbObjets += 1;
    parJeu.set(c.jeuReseau.id, j);
  }
  await tracerConsultation(acteur, [...parJeu.values()], { route: "conflits", bbox: null, zoom: null });

  const dernier = page[page.length - 1];
  return {
    conflits: vues, compteurs, total: Object.values(compteurs).reduce((a, b) => a + b, 0),
    curseurSuivant: lignes.length > limite && dernier ? encoderCurseur({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}

// ------------------------------------------------------------------------------------------------
// Fiche
// ------------------------------------------------------------------------------------------------

const sansIdentifiantDeJeu = (donnees: unknown): unknown => {
  if (!donnees || typeof donnees !== "object" || Array.isArray(donnees)) return donnees;
  const { jeuReseauId: _omis, ...reste } = donnees as Record<string, unknown>;
  void _omis;
  return reste;
};

export async function ficheConflit(acteur: Acteur, projetId: string, cid: string) {
  const c = await prisma.conflitProjet.findFirst({ where: { id: cid, projetId }, include: INCLURE_LISTE });
  if (!c) throw CONFLIT_INTROUVABLE();
  const decideur = voitTousLesJeux(acteur.role);
  const [geo, historique, preuves, decisions, premiere, derniere] = await Promise.all([
    prisma.$queryRaw<{ g: string; w: number; s: number; e: number; n: number }[]>`
      SELECT ST_AsGeoJSON("geom", 6) AS "g", ST_XMin("geom") AS "w", ST_YMin("geom") AS "s", ST_XMax("geom") AS "e", ST_YMax("geom") AS "n" FROM "conflits_projet" WHERE "id" = ${cid}`,
    prisma.conflitHistorique.findMany({ where: { conflitId: cid }, include: { acteur: { select: { id: true, nomComplet: true } }, analyse: { select: { numero: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.conflitPreuve.findMany({ where: { conflitId: cid }, include: { auteur: { select: { id: true, nomComplet: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.decisionConflit.findMany({
      where: { conflitId: cid }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { proposePar: { select: { id: true, nomComplet: true } }, approuvePar: { select: { id: true, nomComplet: true } } },
    }),
    prisma.analyseConflitProjet.findUnique({ where: { id: c.premiereAnalyseId }, select: { id: true, numero: true, createdAt: true } }),
    prisma.analyseConflitProjet.findUnique({ where: { id: c.derniereAnalyseId }, select: { id: true, numero: true, createdAt: true, jeux: true, regles: true, largeurEmpriseM: true, largeurChausseeM: true, versionAlgorithme: true } }),
  ]);
  const visible = geometrieVisible(acteur.role, c.jeuReseau?.statut ?? null);
  const boite = geo[0] ? [Number(geo[0].w), Number(geo[0].s), Number(geo[0].e), Number(geo[0].n)] : null;

  // Sources : plan(s) d'axes et jeu de reseau de la derniere analyse, avec leurs versions et empreintes.
  const jeuxAnalyse = ((derniere?.jeux as { jeuId: string; role: string }[] | null) ?? []);
  const idsSources = [...new Set([...jeuxAnalyse.filter((j) => j.role === "AXES_TRAVAUX").map((j) => j.jeuId), ...(c.jeuReseauId ? [c.jeuReseauId] : [])])];
  const jeuxSources = idsSources.length
    ? await prisma.jeuDonneesProjet.findMany({ where: { id: { in: idsSources } }, include: { concessionnaire: { select: { id: true, nom: true } } } })
    : [];
  const sources = jeuxSources
    .filter((j) => j.statut !== "RETIRE" && (decideur || j.statut === "AUTORISE"))
    .map((j) => ({
      jeuId: j.id, role: j.role, version: j.version, sha256: j.sha256, statut: j.statut, nomFichier: j.nomFichier, typeReseau: j.typeReseau,
      concessionnaire: j.concessionnaire, classePrecision: j.classePrecision, precisionHorizontaleM: nombre(j.precisionHorizontaleM),
      confidentialite: j.confidentialite, dateDonnees: jour(j.dateDonnees),
    }));

  const reglesAnalyse = ((derniere?.regles as { famille: string | null }[] | null) ?? []) as (Record<string, unknown> & { famille: string | null })[];
  const regle = reglesAnalyse.find((r) => r.famille === (c.jeuReseau?.typeReseau ?? null)) ?? (c.jeuReseau ? null : reglesAnalyse[0] ?? null);

  const approuvees = decisions.filter((d) => d.statut === "APPROUVEE").length;
  const brut = vueConflit(c, acteur.role, boite);
  const fiche = {
    conflit: { ...brut, geometrie: visible && geo[0] ? JSON.parse(geo[0].g) as unknown : null },
    sources,
    regle: regle ? { ...regle, versionAlgorithme: derniere?.versionAlgorithme ?? null } : null,
    largeurs: derniere ? { empriseM: Number(derniere.largeurEmpriseM), chausseeM: Number(derniere.largeurChausseeM) } : null,
    analyses: {
      premiere: premiere ? { id: premiere.id, numero: premiere.numero, createdAt: premiere.createdAt } : null,
      derniere: derniere ? { id: derniere.id, numero: derniere.numero, createdAt: derniere.createdAt } : null,
    },
    tronconsProches: c.tronconsProches,
    historique: historique.map((h) => ({
      id: h.id, action: h.action, ancienStatut: h.ancienStatut, nouveauStatut: h.nouveauStatut, justification: h.justification,
      acteur: personne(h.acteur), analyseId: h.analyseId, analyseNumero: h.analyse?.numero ?? null,
      donnees: decideur ? h.donnees : sansIdentifiantDeJeu(h.donnees), createdAt: h.createdAt,
    })),
    preuves: preuves.map((p) => ({ id: p.id, type: p.type, texte: p.texte, reference: p.reference, auteur: personne(p.auteur), createdAt: p.createdAt })),
    decisions: decisions.map(vueDecision),
    transitionsPossibles: transitionsPossibles({ de: c.statut as StatutConflit, role: acteur.role, nbPreuves: preuves.length, nbDecisionsApprouvees: approuvees }),
    avertissements: [...AVERTISSEMENTS_DOSSIER],
  };
  // Trace AVANT la remise de la geometrie d'un reseau de tiers.
  if (visible && c.jeuReseau) {
    await tracerConsultation(acteur, [{ id: c.jeuReseau.id, confidentialite: c.jeuReseau.confidentialite, nbObjets: 1 }], { route: "conflits", bbox: null, zoom: null });
  }
  return fiche;
}

type LigneDecision = Prisma.DecisionConflitGetPayload<{ include: { proposePar: { select: { id: true; nomComplet: true } }; approuvePar: { select: { id: true; nomComplet: true } } } }>;

export function vueDecision(d: LigneDecision) {
  return {
    id: d.id, conflitId: d.conflitId, option: d.option, justification: d.justification, contraintes: d.contraintes,
    coutEstime: nombre(d.coutEstime), deviseCout: d.deviseCout, coutReel: nombre(d.coutReel),
    dateDebutPrevue: jour(d.dateDebutPrevue), dateFinPrevue: jour(d.dateFinPrevue), statut: d.statut,
    proposePar: personne(d.proposePar), approuvePar: personne(d.approuvePar), approuveLe: d.approuveLe, motifDecision: d.motifDecision,
    derogationSeparation: d.derogationSeparation, createdAt: d.createdAt,
  };
}

// ------------------------------------------------------------------------------------------------
// Ecritures : socle commun (transaction, verrou de la ligne, delais cote base)
// ------------------------------------------------------------------------------------------------

async function sousVerrou<T>(projetId: string, cid: string, travail: (tx: Prisma.TransactionClient, c: { id: string; statut: StatutConflit }) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
      const l = await tx.$queryRaw<{ id: string; statut: StatutConflit }[]>`SELECT "id", "statut"::text AS "statut" FROM "conflits_projet" WHERE "id" = ${cid} AND "projetId" = ${projetId} FOR UPDATE`;
      if (l.length === 0) throw CONFLIT_INTROUVABLE();
      return travail(tx, l[0]);
    });
  } catch (e) {
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Ce dossier est occupé par une autre opération (une analyse est peut-être en cours) : réessayez dans quelques instants.");
    throw e;
  }
}

async function conflitCourt(tx: Prisma.TransactionClient, cid: string, role: string) {
  const c = await tx.conflitProjet.findUniqueOrThrow({ where: { id: cid }, include: INCLURE_LISTE });
  return vueConflit(c, role, null);
}

// ------------------------------------------------------------------------------------------------
// Attribution (responsable, echeance, risque, action proposee) et acquittement du re-examen
// ------------------------------------------------------------------------------------------------

export interface ModifConflit {
  responsableId?: string | null; echeance?: string | null; risque?: RisqueConflit | null; actionProposee?: string | null;
  /** Seule la valeur `false` existe : une personne a re-examine le dossier. Exige `justification`. */
  aReexaminer?: false; justification?: string;
}

export async function modifierConflit(acteur: Acteur, projetId: string, cid: string, m: ModifConflit) {
  if (m.aReexaminer === false && (m.justification ?? "").trim().length < JUSTIFICATION_MIN) {
    throw new ErreurMetier(422, "JUSTIFICATION_REQUISE", `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise pour acquitter un re-examen.`);
  }
  return sousVerrou(projetId, cid, async (tx, ligne) => {
    const avant = await tx.conflitProjet.findUniqueOrThrow({ where: { id: cid } });
    if (m.responsableId) {
      const u = await tx.user.findFirst({ where: { id: m.responsableId, actif: true }, select: { id: true } });
      if (!u) throw new ErreurMetier(400, "RESPONSABLE_INCONNU", "Le responsable désigné n'existe pas ou n'est pas actif.");
    }
    const donnees: Prisma.ConflitProjetUncheckedUpdateInput = {};
    const delta: Record<string, { avant: unknown; apres: unknown }> = {};
    const noter = <K extends string>(cle: K, ancien: unknown, nouveau: unknown) => { if (ancien !== nouveau) delta[cle] = { avant: ancien, apres: nouveau }; };
    if (m.responsableId !== undefined && m.responsableId !== avant.responsableId) { donnees.responsableId = m.responsableId; noter("responsableId", avant.responsableId, m.responsableId); }
    if (m.echeance !== undefined && m.echeance !== jour(avant.echeance)) { donnees.echeance = m.echeance === null ? null : new Date(`${m.echeance}T00:00:00.000Z`); noter("echeance", jour(avant.echeance), m.echeance); }
    if (m.risque !== undefined && m.risque !== avant.risque) { donnees.risque = m.risque; noter("risque", avant.risque, m.risque); }
    if (m.actionProposee !== undefined && m.actionProposee !== avant.actionProposee) { donnees.actionProposee = m.actionProposee; noter("actionProposee", avant.actionProposee, m.actionProposee); }
    const acquitte = m.aReexaminer === false && avant.aReexaminer;
    if (acquitte) { donnees.aReexaminer = false; donnees.motifReexamen = null; }
    if (Object.keys(donnees).length === 0) return { conflit: await conflitCourt(tx, cid, acteur.role), modifie: false };

    await tx.conflitProjet.update({ where: { id: cid }, data: donnees });
    const justification = m.justification?.trim() || null;
    if (Object.keys(delta).length > 0) {
      await tx.conflitHistorique.create({ data: { conflitId: cid, action: "ATTRIBUTION", justification, acteurId: acteur.id, donnees: delta as unknown as Prisma.InputJsonValue } });
    }
    if (acquitte) {
      await tx.conflitHistorique.create({ data: { conflitId: cid, action: "REEXAMEN", justification, acteurId: acteur.id, donnees: { acquitte: true, motifAvant: avant.motifReexamen } } });
    }
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "UPDATE", entityType: "ConflitProjet", entityId: cid,
      before: { statut: ligne.statut, ...Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, v.avant])), ...(acquitte ? { aReexaminer: true } : {}) },
      after: { ...Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, v.apres])), ...(acquitte ? { aReexaminer: false } : {}), justification },
      ipAddress: acteur.ip,
    });
    return { conflit: await conflitCourt(tx, cid, acteur.role), modifie: true };
  });
}

// ------------------------------------------------------------------------------------------------
// Transition de statut
// ------------------------------------------------------------------------------------------------

export interface DemandeStatut { vers: StatutConflit; justification?: string; derogation?: string; recolementAValider?: boolean }

export async function changerStatut(acteur: Acteur, projetId: string, cid: string, d: DemandeStatut) {
  return sousVerrou(projetId, cid, async (tx, ligne) => {
    const [nbPreuves, approuvees, passageTraitement] = await Promise.all([
      tx.conflitPreuve.count({ where: { conflitId: cid } }),
      tx.decisionConflit.findMany({ where: { conflitId: cid, statut: "APPROUVEE" }, select: { id: true, option: true, proposeParId: true } }),
      tx.conflitHistorique.findFirst({ where: { conflitId: cid, action: "STATUT", nouveauStatut: "TRAITEMENT_DECIDE" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { acteurId: true } }),
    ]);
    const v = evaluerTransition({
      de: ligne.statut, vers: d.vers, role: acteur.role, acteurId: acteur.id, justification: d.justification, nbPreuves,
      decisionsApprouvees: approuvees as DecisionApprouvee[], recolementAValider: d.recolementAValider,
      proposeurClotureId: passageTraitement?.acteurId ?? null, derogation: d.derogation,
    });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
    const avant = await tx.conflitProjet.findUniqueOrThrow({ where: { id: cid }, select: { aReexaminer: true, motifReexamen: true } });
    // Une personne qui tranche a re-examine le dossier : le drapeau du recalcul est acquitte (et la trace le dit).
    await tx.conflitProjet.update({ where: { id: cid }, data: { statut: d.vers, aReexaminer: false, motifReexamen: null } });
    await tx.conflitHistorique.create({
      data: {
        conflitId: cid, action: "STATUT", ancienStatut: ligne.statut, nouveauStatut: d.vers, justification: v.justification, acteurId: acteur.id,
        donnees: {
          ...(v.derogation ? { derogationSeparation: v.derogation } : {}),
          ...(v.recolementMentionne ? { recolementAValider: true } : {}),
          ...(avant.aReexaminer ? { reexamenAcquitte: avant.motifReexamen } : {}),
        },
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "UPDATE", entityType: "ConflitProjet", entityId: cid,
      before: { statut: ligne.statut }, after: { statut: d.vers, justification: v.justification, derogationSeparation: v.derogation, recolementAValider: v.recolementMentionne || undefined },
      ipAddress: acteur.ip,
    });
    return { conflit: await conflitCourt(tx, cid, acteur.role) };
  });
}

// ------------------------------------------------------------------------------------------------
// Preuves (ajout seul)
// ------------------------------------------------------------------------------------------------

export async function ajouterPreuve(acteur: Acteur, projetId: string, cid: string, p: { type: TypePreuve; texte: string; reference?: string | null }) {
  return sousVerrou(projetId, cid, async (tx) => {
    const preuve = await tx.conflitPreuve.create({
      data: { conflitId: cid, type: p.type, texte: p.texte.trim(), reference: p.reference?.trim() || null, auteurId: acteur.id },
      include: { auteur: { select: { id: true, nomComplet: true } } },
    });
    await tx.conflitHistorique.create({ data: { conflitId: cid, action: "PREUVE", acteurId: acteur.id, donnees: { preuveId: preuve.id, type: p.type } } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "ConflitProjet", entityId: cid, after: { preuveId: preuve.id, type: p.type }, ipAddress: acteur.ip });
    return { preuve: { id: preuve.id, type: preuve.type, texte: preuve.texte, reference: preuve.reference, auteur: personne(preuve.auteur), createdAt: preuve.createdAt } };
  });
}

// ------------------------------------------------------------------------------------------------
// Decisions : proposer, approuver, refuser
// ------------------------------------------------------------------------------------------------

export interface PropositionDecision {
  option: OptionDecision; justification: string; contraintes?: string | null;
  coutEstime?: number | null; coutReel?: number | null; deviseCout?: string | null;
  dateDebutPrevue?: string | null; dateFinPrevue?: string | null;
}

const INCLURE_DECISION = { proposePar: { select: { id: true, nomComplet: true } }, approuvePar: { select: { id: true, nomComplet: true } } } as const;
const date = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);

export async function proposerDecision(acteur: Acteur, projetId: string, cid: string, p: PropositionDecision) {
  return sousVerrou(projetId, cid, async (tx, ligne) => {
    const c = await tx.conflitProjet.findUniqueOrThrow({ where: { id: cid }, select: { responsableId: true } });
    const v = verifierPropositionDecision({
      statutConflit: ligne.statut, option: p.option, justification: p.justification, dateDebutPrevue: p.dateDebutPrevue, dateFinPrevue: p.dateFinPrevue, responsableId: c.responsableId,
    });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
    const d = await tx.decisionConflit.create({
      data: {
        conflitId: cid, option: p.option, justification: v.justification, contraintes: p.contraintes?.trim() || null,
        coutEstime: p.coutEstime ?? null, coutReel: p.coutReel ?? null, deviseCout: p.deviseCout ?? null,
        dateDebutPrevue: date(p.dateDebutPrevue), dateFinPrevue: date(p.dateFinPrevue), proposeParId: acteur.id,
      },
      include: INCLURE_DECISION,
    });
    await tx.conflitHistorique.create({ data: { conflitId: cid, action: "DECISION_PROPOSEE", justification: v.justification, acteurId: acteur.id, donnees: { decisionId: d.id, option: d.option } } });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "ConflitProjet", entityId: cid,
      after: { decisionId: d.id, option: d.option, statut: "PROPOSEE", coutEstime: nombre(d.coutEstime), deviseCout: d.deviseCout, dateDebutPrevue: jour(d.dateDebutPrevue), dateFinPrevue: jour(d.dateFinPrevue) },
      ipAddress: acteur.ip,
    });
    return { decision: vueDecision(d) };
  });
}

export async function trancherDecision(acteur: Acteur, projetId: string, cid: string, did: string, verdict: "APPROUVEE" | "REFUSEE", t: { motif?: string; derogation?: string }) {
  return sousVerrou(projetId, cid, async (tx, ligne) => {
    const d = await tx.decisionConflit.findFirst({ where: { id: did, conflitId: cid } });
    if (!d) throw introuvable("Décision", "DECISION_INTROUVABLE");
    const tr = verifierTranchage({ statutDecision: d.statut, motif: t.motif });
    if (!tr.ok) throw new ErreurMetier(tr.status, tr.code, tr.message);
    if (ligne.statut !== "CONFIRME") {
      throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", `Une décision ne se tranche que pour un conflit confirmé (statut actuel : ${ligne.statut}).`);
    }
    const projet = await tx.projetVoirie.findUniqueOrThrow({ where: { id: projetId }, select: { regionId: true } });
    const nbHabilites = await depot.compterComptesHabilites(tx, projet.regionId);
    const sep = verifierSeparationDecision({ option: d.option as OptionDecision, proposeurId: d.proposeParId, acteurId: acteur.id, role: acteur.role, nbHabilites, derogation: t.derogation });
    if (!sep.ok) throw new ErreurMetier(sep.status, sep.code, sep.message);
    const maintenant = new Date();
    const n = await tx.decisionConflit.updateMany({
      where: { id: did, statut: "PROPOSEE" },
      data: { statut: verdict, approuveParId: acteur.id, approuveLe: maintenant, motifDecision: tr.motif, derogationSeparation: sep.derogation },
    });
    if (n.count !== 1) throw new ErreurMetier(409, "DECISION_DEJA_TRANCHEE", "Cette décision vient d'être tranchée par une autre personne.");
    await tx.conflitHistorique.create({
      data: {
        conflitId: cid, action: verdict === "APPROUVEE" ? "DECISION_APPROUVEE" : "DECISION_REFUSEE", justification: tr.motif, acteurId: acteur.id,
        donnees: { decisionId: did, option: d.option, proposeParId: d.proposeParId, ...(sep.derogation ? { derogationSeparation: sep.derogation } : {}) },
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: verdict === "APPROUVEE" ? "VALIDATE" : "REJECT", entityType: "ConflitProjet", entityId: cid,
      before: { decisionId: did, statut: "PROPOSEE" }, after: { decisionId: did, option: d.option, statut: verdict, motif: tr.motif, derogationSeparation: sep.derogation, memePersonne: d.proposeParId === acteur.id },
      ipAddress: acteur.ip,
    });
    const apres = await tx.decisionConflit.findUniqueOrThrow({ where: { id: did }, include: INCLURE_DECISION });
    return { decision: vueDecision(apres) };
  });
}

// ------------------------------------------------------------------------------------------------
// Export CSV : un conflit par ligne, agregats seulement, AUCUNE geometrie ; audite AVANT la remise
// ------------------------------------------------------------------------------------------------

export const ENTETE_CSV_CONFLITS = [
  "axe", "type", "statut", "risque", "aReexaminer", "motifReexamen", "concessionnaire", "typeReseau", "classePrecision", "verticalEvalue",
  "longueurChausseeM", "longueurEmpriseM", "distanceMinM", "nbCroisements", "longueurPieceM", "responsable", "echeance", "actionProposee",
  "nbPreuves", "nbDecisions", "premiereAnalyse", "derniereAnalyse", "cle",
] as const;

const EXPORT_MAX = 100_000;

export async function exporterConflitsCsv(acteur: Acteur, projetId: string, f: FiltresConflits) {
  const projet = await prisma.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true, code: true } });
  if (!projet) throw introuvable("Projet", "PROJET_INTROUVABLE");
  const lignes = await prisma.conflitProjet.findMany({
    where: filtreConflits(projetId, f), orderBy: [{ axe: "asc" }, { type: "asc" }, { id: "asc" }], take: EXPORT_MAX,
    include: {
      ...INCLURE_LISTE, premiereAnalyse: { select: { numero: true } }, derniereAnalyse: { select: { numero: true } },
      _count: { select: { preuves: true, decisions: true } },
    },
  });
  const m = (c: { mesure: unknown }) => (c.mesure ?? {}) as Record<string, number | null>;
  const rows = lignes.map((c) => [
    c.axe, c.type, c.statut, c.risque ?? "", c.aReexaminer ? "oui" : "non", c.motifReexamen ?? "", c.concessionnaire?.nom ?? "", c.jeuReseau?.typeReseau ?? "",
    c.classePrecision ?? "inconnue", c.verticalEvalue ? "oui" : "non",
    m(c).longueurChausseeM ?? 0, m(c).longueurEmpriseM ?? 0, m(c).distanceMinM ?? "", m(c).nbCroisements ?? 0, m(c).longueurPieceM ?? 0,
    c.responsable?.nomComplet ?? "", jour(c.echeance) ?? "", c.actionProposee ?? "", c._count.preuves, c._count.decisions,
    c.premiereAnalyse.numero, c.derniereAnalyse.numero, c.cle,
  ]);
  const csv = "﻿" + [ENTETE_CSV_CONFLITS.join(";"), ...rows.map((r) => r.map((v) => celluleCsv(v as string | number)).join(";"))].join("\r\n") + "\r\n";
  await prisma.$transaction(async (tx) => {
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "ExportConflitsProjetVoirie", entityId: projet.id,
      after: { format: "csv", projet: projet.code, nbLignes: rows.length, filtres: f, geometries: false }, ipAddress: acteur.ip,
    });
  });
  return { csv, nbLignes: rows.length, nomFichier: `conflits-${projet.code.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv` };
}

/** Garde de coherence (tests) : les enumerations du noyau sont celles utilisees ici. */
export const ENUMERATIONS = { STATUTS_CONFLIT, TYPES_CONFLIT, RISQUES_CONFLIT, TYPES_PREUVE, OPTIONS_DECISION };
