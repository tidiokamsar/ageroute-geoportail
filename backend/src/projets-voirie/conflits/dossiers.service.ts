/**
 * DOSSIERS DE CONFLIT : lecture (liste filtrable, fiche), attribution, transitions de statut, preuves, decisions, export CSV
 * (contrat RC-3, sections 4 et 6).
 *
 * REGLES :
 *   - un conflit est un signal de verification, jamais un ordre : aucune route de ce service ne cree d'ordre, de deplacement ni de decision
 *     automatique ; une decision est une proposition humaine, approuvee ou refusee par une autre personne (separation des taches) ;
 *   - toute ecriture se fait dans UNE transaction qui verrouille la ligne du conflit, ecrit l'historique (ajout seul) et l'audit ;
 *   - la LECTURE de la geometrie d'un reseau de tiers est tracee comme celle de la carte (consultation.ts), avant la remise des donnees ;
 *   - LISIBILITE (revue RC-3, M1 ; voir visibilite.noyau.ts et la section 9.17 du contrat) : un jeu RETIRE n'est montre a personne ; un jeu
 *     non AUTORISE n'est montre qu'a ADMIN et GESTIONNAIRE. Un compte qui ne decide pas ne voit un dossier que si son jeu est AUTORISE
 *     (sinon absent de la liste, du total, des compteurs, des comparaisons et 404 sur la fiche) ; un compte qui decide voit toujours le
 *     dossier (archive des decisions), mais sans les donnees tirees d'un jeu RETIRE (geometrie, mesure, objet, jeu, troncons voisins...) ;
 *   - un projet retire ou inconnu n'existe pour personne (404 PROJET_INTROUVABLE), national compris (revue RC-3, m1) ;
 *   - un recalcul ne modifie jamais ce que ce service a ecrit (voir la migration : declencheur `conflits_projet_recalcul`).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { avecErreurDelai, estDelaiDepasse, poserDelais } from "../bd";
import { delaiAnalyseMs, delaiDepotMs, delaiVerrouMs } from "../config";
import { tracerConsultation } from "../consultation";
import { celluleCsv } from "../analyse.service";
import { ErreurMetier, introuvable } from "../erreurs";
import { limiteurAnalyses } from "../limiteurs";
import type { Acteur } from "../projets.service";
import * as depot from "./conflits.depot";
import { decoderCurseurConflit as decoderCurseurConflitNoyau, encoderCurseurConflit } from "./curseurs.noyau";
import {
  decisionsEnVigueur, evaluerTransition, transitionsPossibles, verifierModificationDossier, verifierPropositionDecision, verifierResponsable,
  verifierSeparationDecision, verifierTranchage, type DecisionApprouvee,
} from "./etats.noyau";
import { donneesHistoriqueVisibles, donneesReseauLisibles, dossierVisible, jeuLisible } from "./visibilite.noyau";
import {
  AVERTISSEMENTS_DOSSIER, JUSTIFICATION_MIN, OPTIONS_DECISION, RISQUES_CONFLIT, STATUTS_CONFLIT, TYPES_CONFLIT, TYPES_PREUVE, estDecideur,
  type OptionDecision, type StatutConflit, type TypePreuve, type RisqueConflit,
} from "./types.noyau";

export const CONFLIT_INTROUVABLE = (): ErreurMetier => introuvable("Conflit", "CONFLIT_INTROUVABLE");
export const PROJET_INTROUVABLE = (): ErreurMetier => introuvable("Projet", "PROJET_INTROUVABLE");

/**
 * Un projet retire (suppression logique) ou inconnu n'existe pour personne : le controle territorial laisse passer un compte national sans
 * rien lire (territoire.middleware.ts), c'est donc ici que tout service de lecture ou d'ecriture le verifie (revue RC-3, m1).
 */
export async function exigerProjetActif(projetId: string): Promise<void> {
  const p = await prisma.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true } });
  if (!p) throw PROJET_INTROUVABLE();
}

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
  // Plan d'axes d'un dossier de couverture insuffisante (revue RC-3, m6) : meme masquage et meme trace que le jeu de reseau.
  jeuAxes: { select: { id: true, statut: true, confidentialite: true } },
  objet: { select: { id: true, nom: true } },
} as const;

type LigneConflit = Prisma.ConflitProjetGetPayload<{ include: typeof INCLURE_LISTE }>;

/** Statuts COURANTS des jeux dont depend le dossier (reseau et/ou plan d'axes). */
export const statutsLies = (c: Pick<LigneConflit, "jeuReseau" | "jeuAxes">): string[] =>
  [c.jeuReseau?.statut, c.jeuAxes?.statut].filter((s): s is NonNullable<typeof s> => typeof s === "string");

/** Jeu dont la consultation est tracee quand les donnees du dossier sont rendues (le reseau, sinon le plan d'axes). */
const jeuTrace = (c: Pick<LigneConflit, "jeuReseau" | "jeuAxes">) => c.jeuReseau ?? c.jeuAxes ?? null;

/** Vrai si `role` peut lire la geometrie d'un conflit dont le jeu lie a ce statut (nul : aucun jeu lie). Voir visibilite.noyau.ts. */
export function geometrieVisible(role: string, statutJeu: string | null): boolean {
  return jeuLisible(role, statutJeu);
}

/**
 * `bbox` : boite englobante (nulle si non lisible) ; `undefined` pour une reponse d'ecriture, qui ne la porte pas (relire la fiche).
 * Les donnees tirees du jeu (reseau, objet, mesure, classe, concessionnaire, jeu, boite) ne sont rendues que si le jeu est lisible pour `role`.
 */
export function vueConflit(c: LigneConflit, role: string, bbox?: number[] | null) {
  const visible = donneesReseauLisibles(role, statutsLies(c));
  const depassee = c.echeance !== null && c.echeance < aujourdhui() && !STATUTS_FERMES.includes(c.statut as StatutConflit);
  return {
    id: c.id, projetId: c.projetId, cle: c.cle, type: c.type, axe: c.axe, statut: c.statut, risque: c.risque,
    aReexaminer: c.aReexaminer, motifReexamen: c.motifReexamen,
    responsable: personne(c.responsable), echeance: jour(c.echeance), echeanceDepassee: depassee, actionProposee: c.actionProposee,
    classePrecision: visible ? c.classePrecision : null, verticalEvalue: c.verticalEvalue,
    concessionnaire: visible && c.concessionnaire ? { id: c.concessionnaire.id, nom: c.concessionnaire.nom } : null,
    typeReseau: visible ? c.jeuReseau?.typeReseau ?? null : null,
    jeuReseauId: visible ? c.jeuReseauId : null,
    objet: visible && c.objet ? { id: String(c.objet.id), nom: c.objet.nom } : null,
    mesure: visible ? c.mesure : null, premiereAnalyseId: c.premiereAnalyseId, derniereAnalyseId: c.derniereAnalyseId,
    ...(bbox === undefined ? {} : { bbox: visible ? bbox : null }), geometrieMasquee: !visible,
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

/** Dossiers dont chaque jeu lie (reseau, plan d'axes) est AUTORISE, ou qui n'en ont pas : ce que voit un compte qui ne decide pas. */
const JEUX_AUTORISES: Prisma.ConflitProjetWhereInput[] = [
  ou({ jeuReseauId: null }, { jeuReseau: { is: { statut: "AUTORISE" } } }),
  ou({ jeuAxesId: null }, { jeuAxes: { is: { statut: "AUTORISE" } } }),
];
/** Dossiers qu'un compte qui ne decide pas NE VOIT PAS (un jeu lie n'est pas AUTORISE) : sert a retirer leurs cles d'une comparaison. */
export const dossiersNonVisibles = (projetId: string): Prisma.ConflitProjetWhereInput => ({ projetId, NOT: { AND: JEUX_AUTORISES } });
/** Dossiers dont aucun jeu lie n'est RETIRE : les filtres qui parlent du contenu d'un jeu (concessionnaire, objet) ne sondent pas un jeu retire. */
const JEUX_NON_RETIRES: Prisma.ConflitProjetWhereInput[] = [
  ou({ jeuReseauId: null }, { jeuReseau: { is: { statut: { not: "RETIRE" } } } }),
  ou({ jeuAxesId: null }, { jeuAxes: { is: { statut: { not: "RETIRE" } } } }),
];

/**
 * Filtre d'une liste. `role` determine la LISIBILITE (voir visibilite.noyau.ts) : un compte qui ne decide pas ne voit que les dossiers dont les
 * jeux sont AUTORISES ; ce filtre s'applique donc au total, aux compteurs, a la liste, a l'export et a la comparaison (revue RC-3, M1).
 * Les filtres `concessionnaireId` et `q` (objet, concessionnaire) ignorent les dossiers d'un jeu RETIRE, pour tous.
 */
export function filtreConflits(projetId: string, f: FiltresConflits, role: string, inclureStatut = true): Prisma.ConflitProjetWhereInput {
  const and: Prisma.ConflitProjetWhereInput[] = [{ projetId }];
  if (!estDecideur(role)) and.push(...JEUX_AUTORISES);
  if (inclureStatut && f.statuts?.length) and.push({ statut: { in: f.statuts } });
  if (f.types?.length) and.push({ type: { in: f.types as never[] } });
  if (f.axe) and.push({ axe: { equals: f.axe, mode: "insensitive" } });
  if (f.concessionnaireId) and.push({ concessionnaireId: f.concessionnaireId }, ...JEUX_NON_RETIRES);
  if (f.responsableId) and.push({ responsableId: f.responsableId });
  if (f.aReexaminer !== undefined) and.push({ aReexaminer: f.aReexaminer });
  if (f.echeanceDepassee === true) and.push({ echeance: { lt: aujourdhui() }, statut: { notIn: STATUTS_FERMES } });
  if (f.echeanceDepassee === false) and.push(ou({ echeance: null }, { echeance: { gte: aujourdhui() } }, { statut: { in: STATUTS_FERMES } }));
  if (f.q) {
    and.push(ou({ axe: { contains: f.q, mode: "insensitive" } }, { actionProposee: { contains: f.q, mode: "insensitive" } },
      { AND: [{ concessionnaire: { nom: { contains: f.q, mode: "insensitive" } } }, ...JEUX_NON_RETIRES] },
      { AND: [{ objet: { nom: { contains: f.q, mode: "insensitive" } } }, ...JEUX_NON_RETIRES] }));
  }
  return { AND: and };
}

/** Curseurs : voir curseurs.noyau.ts (une valeur hors des formes produites par le serveur est refusee, 400 CURSEUR_INVALIDE). */
export const decoderCurseurConflit = decoderCurseurConflitNoyau;

export async function listerConflits(acteur: Acteur, projetId: string, f: FiltresConflits, limite: number, curseur?: { t: Date; i: string }) {
  await exigerProjetActif(projetId);
  const base = filtreConflits(projetId, f, acteur.role);
  const where: Prisma.ConflitProjetWhereInput = curseur
    ? { AND: [base, ou({ createdAt: { lt: curseur.t } }, { createdAt: curseur.t, id: { lt: curseur.i } })] }
    : base;
  const lignes = await prisma.conflitProjet.findMany({ where, include: INCLURE_LISTE, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite + 1 });
  const page = lignes.slice(0, limite);
  const [boites, groupes, total] = await Promise.all([
    boitesEnglobantes(page.map((c) => c.id)),
    prisma.conflitProjet.groupBy({ by: ["statut"], where: filtreConflits(projetId, f, acteur.role, false), _count: { _all: true } }),
    prisma.conflitProjet.count({ where: base }),
  ]);
  const compteurs: Record<string, number> = Object.fromEntries(STATUTS_CONFLIT.map((s) => [s, 0]));
  for (const g of groupes) compteurs[g.statut] = g._count._all;
  const vues = page.map((c) => vueConflit(c, acteur.role, boites.get(c.id) ?? null));

  // Le rendu de la boite englobante d'un reseau de tiers est une lecture de position : tracee comme la carte, avant la remise.
  // Un dossier de couverture insuffisante rend l'axe : c'est le plan d'axes qui est consulte (revue RC-3, m6).
  const parJeu = new Map<string, { id: string; confidentialite: string; nbObjets: number }>();
  for (const c of page) {
    const jeu = jeuTrace(c);
    if (!jeu || !donneesReseauLisibles(acteur.role, statutsLies(c))) continue;
    const j = parJeu.get(jeu.id) ?? { id: jeu.id, confidentialite: jeu.confidentialite, nbObjets: 0 };
    j.nbObjets += 1;
    parJeu.set(jeu.id, j);
  }
  await tracerConsultation(acteur, [...parJeu.values()], { route: "conflits", bbox: null, zoom: null });

  const dernier = page[page.length - 1];
  return {
    conflits: vues, compteurs, total,
    curseurSuivant: lignes.length > limite && dernier ? encoderCurseurConflit({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}

// ------------------------------------------------------------------------------------------------
// Fiche
// ------------------------------------------------------------------------------------------------

export async function ficheConflit(acteur: Acteur, projetId: string, cid: string) {
  await exigerProjetActif(projetId);
  const c = await prisma.conflitProjet.findFirst({ where: { id: cid, projetId }, include: INCLURE_LISTE });
  // Un dossier dont le jeu n'est pas autorise n'existe pas pour un compte qui ne decide pas : meme 404 qu'un identifiant inconnu (revue RC-3, M1).
  if (!c || !dossierVisible(acteur.role, statutsLies(c))) throw CONFLIT_INTROUVABLE();
  const visible = donneesReseauLisibles(acteur.role, statutsLies(c));
  const [geo, historique, preuves, decisions, premiere, derniere, dernierConfirme] = await Promise.all([
    visible
      ? prisma.$queryRaw<{ g: string; w: number; s: number; e: number; n: number }[]>`
      SELECT ST_AsGeoJSON("geom", 6) AS "g", ST_XMin("geom") AS "w", ST_YMin("geom") AS "s", ST_XMax("geom") AS "e", ST_YMax("geom") AS "n" FROM "conflits_projet" WHERE "id" = ${cid}`
      : Promise.resolve([] as { g: string; w: number; s: number; e: number; n: number }[]),
    prisma.conflitHistorique.findMany({ where: { conflitId: cid }, include: { acteur: { select: { id: true, nomComplet: true } }, analyse: { select: { numero: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.conflitPreuve.findMany({ where: { conflitId: cid }, include: { auteur: { select: { id: true, nomComplet: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.decisionConflit.findMany({
      where: { conflitId: cid }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { proposePar: { select: { id: true, nomComplet: true } }, approuvePar: { select: { id: true, nomComplet: true } } },
    }),
    prisma.analyseConflitProjet.findUnique({ where: { id: c.premiereAnalyseId }, select: { id: true, numero: true, createdAt: true } }),
    prisma.analyseConflitProjet.findUnique({ where: { id: c.derniereAnalyseId }, select: { id: true, numero: true, createdAt: true, jeux: true, regles: true, largeurEmpriseM: true, largeurChausseeM: true, versionAlgorithme: true } }),
    prisma.conflitHistorique.findFirst({ where: { conflitId: cid, action: "STATUT", nouveauStatut: "CONFIRME" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } }),
  ]);
  const boite = geo[0] ? [Number(geo[0].w), Number(geo[0].s), Number(geo[0].e), Number(geo[0].n)] : null;

  // Sources : plan(s) d'axes et jeu de reseau de la derniere analyse, avec leurs versions et empreintes.
  const jeuxAnalyse = ((derniere?.jeux as { jeuId: string; role: string }[] | null) ?? []);
  const idsSources = [...new Set([...jeuxAnalyse.filter((j) => j.role === "AXES_TRAVAUX").map((j) => j.jeuId), ...(c.jeuReseauId ? [c.jeuReseauId] : [])])];
  const jeuxSources = idsSources.length
    ? await prisma.jeuDonneesProjet.findMany({ where: { id: { in: idsSources } }, include: { concessionnaire: { select: { id: true, nom: true } } } })
    : [];
  const sources = jeuxSources
    .filter((j) => jeuLisible(acteur.role, j.statut))
    .map((j) => ({
      jeuId: j.id, role: j.role, version: j.version, sha256: j.sha256, statut: j.statut, nomFichier: j.nomFichier, typeReseau: j.typeReseau,
      concessionnaire: j.concessionnaire, classePrecision: j.classePrecision, precisionHorizontaleM: nombre(j.precisionHorizontaleM),
      confidentialite: j.confidentialite, dateDonnees: jour(j.dateDonnees),
    }));

  const reglesAnalyse = ((derniere?.regles as { famille: string | null }[] | null) ?? []) as (Record<string, unknown> & { famille: string | null })[];
  // La regle appliquee porte la famille du reseau : pour un jeu non lisible, elle n'est pas rendue.
  const regle = !visible ? null : reglesAnalyse.find((r) => r.famille === (c.jeuReseau?.typeReseau ?? null)) ?? (c.jeuReseau ? null : reglesAnalyse[0] ?? null);

  // Decisions approuvees EN VIGUEUR seulement (depuis le dernier passage a CONFIRME) : revue RC-3, m3.
  const approuvees = decisionsEnVigueur(
    decisions.filter((d) => d.statut === "APPROUVEE").map((d) => ({ id: d.id, option: d.option as OptionDecision, proposeParId: d.proposeParId, approuveLe: d.approuveLe })),
    dernierConfirme?.createdAt,
  ).length;
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
    tronconsProches: visible ? c.tronconsProches : [],
    historique: historique.map((h) => ({
      id: h.id, action: h.action, ancienStatut: h.ancienStatut, nouveauStatut: h.nouveauStatut, justification: h.justification,
      acteur: personne(h.acteur), analyseId: h.analyseId, analyseNumero: h.analyse?.numero ?? null,
      donnees: donneesHistoriqueVisibles(h.action, h.donnees, { role: acteur.role, reseauLisible: visible }), createdAt: h.createdAt,
    })),
    preuves: preuves.map((p) => ({ id: p.id, type: p.type, texte: p.texte, reference: p.reference, auteur: personne(p.auteur), createdAt: p.createdAt })),
    decisions: decisions.map(vueDecision),
    transitionsPossibles: transitionsPossibles({ de: c.statut as StatutConflit, role: acteur.role, nbPreuves: preuves.length, nbDecisionsApprouvees: approuvees }),
    avertissements: [...AVERTISSEMENTS_DOSSIER],
  };
  // Trace AVANT la remise de la geometrie d'un reseau de tiers, ou de l'axe d'un dossier de couverture (plan d'axes).
  const jeu = jeuTrace(c);
  if (visible && jeu) {
    await tracerConsultation(acteur, [{ id: jeu.id, confidentialite: jeu.confidentialite, nbObjets: 1 }], { route: "conflits", bbox: null, zoom: null });
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
      // Un projet retire ne se modifie plus, meme par un compte national (revue RC-3, m1). Lecture simple, sans verrou : ne bloque pas les depots.
      const p = await tx.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true } });
      if (!p) throw PROJET_INTROUVABLE();
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
  return vueConflit(c, role);
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
      const u = await tx.user.findFirst({ where: { id: m.responsableId }, select: { actif: true, role: true, modulesAutorises: true } });
      if (!u) throw new ErreurMetier(400, "RESPONSABLE_INCONNU", "Le responsable désigné n'existe pas.");
      // Compte actif, avec la cle du module (un ADMIN l'a toujours) : 422 RESPONSABLE_NON_HABILITE sinon (observation de la revue RC-3).
      const r = verifierResponsable({ actif: u.actif, role: u.role, modulesAutorises: u.modulesAutorises });
      if (!r.ok) throw new ErreurMetier(r.status, r.code, r.message);
    }
    // Dossier clos : plus de modification (409) ; deplacement de reseau decide : le responsable ne s'efface pas (422) - revue RC-3, m4.
    const deplacements = await tx.decisionConflit.count({ where: { conflitId: cid, option: "DEPLACER_RESEAU", statut: { in: ["PROPOSEE", "APPROUVEE"] } } });
    const v = verifierModificationDossier({
      statut: ligne.statut,
      modifieChampsHumains: m.responsableId !== undefined || m.echeance !== undefined || m.risque !== undefined || m.actionProposee !== undefined,
      retireLeResponsable: m.responsableId === null && avant.responsableId !== null,
      deplacementPropose: deplacements > 0,
    });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
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
    const [nbPreuves, approuvees, passageTraitement, passageConfirme] = await Promise.all([
      tx.conflitPreuve.count({ where: { conflitId: cid } }),
      tx.decisionConflit.findMany({ where: { conflitId: cid, statut: "APPROUVEE" }, select: { id: true, option: true, proposeParId: true, approuveLe: true } }),
      tx.conflitHistorique.findFirst({ where: { conflitId: cid, action: "STATUT", nouveauStatut: "TRAITEMENT_DECIDE" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { acteurId: true } }),
      // Une approbation anterieure au dernier passage a CONFIRME est perimee (revue RC-3, m3).
      tx.conflitHistorique.findFirst({ where: { conflitId: cid, action: "STATUT", nouveauStatut: "CONFIRME" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } }),
    ]);
    const v = evaluerTransition({
      de: ligne.statut, vers: d.vers, role: acteur.role, acteurId: acteur.id, justification: d.justification, nbPreuves,
      decisionsApprouvees: approuvees as DecisionApprouvee[], dernierPassageConfirmeLe: passageConfirme?.createdAt ?? null, recolementAValider: d.recolementAValider,
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
  // Jusqu'a 100 000 lignes jointes : meme limiteur que les analyses (3 simultanes) et meme delai cote base (revue RC-3, m8).
  const trop = `L'export a dépassé ${Math.round(delaiAnalyseMs() / 1000)} s et a été interrompu : filtrez les dossiers (statut, type, axe) pour en exporter moins.`;
  const lignes = await limiteurAnalyses.executer(() => avecErreurDelai("EXPORT_TROP_LONG", trop, () => prisma.$transaction(async (tx) => {
    await poserDelais(tx, delaiAnalyseMs(), delaiVerrouMs());
    return tx.conflitProjet.findMany({
      where: filtreConflits(projetId, f, acteur.role), orderBy: [{ axe: "asc" }, { type: "asc" }, { id: "asc" }], take: EXPORT_MAX,
      include: {
        ...INCLURE_LISTE, premiereAnalyse: { select: { numero: true } }, derniereAnalyse: { select: { numero: true } },
        _count: { select: { preuves: true, decisions: true } },
      },
    });
  }, { timeout: delaiAnalyseMs() + 15_000, maxWait: 10_000 })));
  const m = (c: { mesure: unknown }) => (c.mesure ?? {}) as Record<string, number | null>;
  const rows = lignes.map((c) => {
    // Les donnees tirees d'un jeu RETIRE ne sortent pas, meme dans un export (voir visibilite.noyau.ts).
    const lisible = donneesReseauLisibles(acteur.role, statutsLies(c));
    const mesure = lisible ? m(c) : {};
    return [
      c.axe, c.type, c.statut, c.risque ?? "", c.aReexaminer ? "oui" : "non", c.motifReexamen ?? "", lisible ? c.concessionnaire?.nom ?? "" : "", lisible ? c.jeuReseau?.typeReseau ?? "" : "",
      lisible ? c.classePrecision ?? "inconnue" : "", c.verticalEvalue ? "oui" : "non",
      mesure.longueurChausseeM ?? 0, mesure.longueurEmpriseM ?? 0, mesure.distanceMinM ?? "", mesure.nbCroisements ?? 0, mesure.longueurPieceM ?? 0,
      c.responsable?.nomComplet ?? "", jour(c.echeance) ?? "", c.actionProposee ?? "", c._count.preuves, c._count.decisions,
      c.premiereAnalyse.numero, c.derniereAnalyse.numero, c.cle,
    ];
  });
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
