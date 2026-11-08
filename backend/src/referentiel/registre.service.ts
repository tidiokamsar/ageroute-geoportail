import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { construireSaisies } from "../lib/provenance";
import { logAuditTransactionnelle } from "../utils/audit";
import { exigerTerritoire } from "../territoire/territoire.service";
import { lireAttributs, nomsIdentiques, pairesProches, type Portee } from "./registre.depot";
import {
  CODES_REGLES, REGLES, constaterAttributs, constaterPaire, empreinte, jugerAnnulation, jugerApplication, jugerDecision, sourceDe,
  versCsv,
  type ChampCorrigeable, type CodeRegle, type Constat, type Correction, type DecisionDemandee, type Refus, type Seuils, type Statut,
} from "./registre.noyau";

/**
 * Registre des anomalies du referentiel des troncons : analyse, examen, decision, correction.
 *
 * TOUTE ECRITURE PART AVEC SA TRACE dans la meme transaction : une ligne du journal des decisions
 * (`decisions_anomalie`, ajout seul) et, pour ce qui touche un troncon, une ligne d'`audit_logs` et la
 * provenance des champs suivis (`valeurs_qualite`), exactement comme le CRUD des troncons.
 */

export class RefusRegistre extends Error {
  constructor(public readonly http: number, public readonly code: string, message: string) { super(message); }
}
const echec = (r: Refus, http = 409): never => { throw new RefusRegistre(http, r.code, r.message); };

const STATUTS_OUVERTS: Statut[] = ["A_EXAMINER", "CORRECTION_PROPOSEE", "VALIDEE"];
export const TOLERANCE_DOUBLON_M = 25;
export const RATIO_DOUBLON = 0.8;
/** Plafond d'une application groupee : au-dela, c'est un traitement de donnees, pas un geste d'ecran. */
export const PLAFOND_GROUPE = 100;

// ------------------------------------------------------------------ analyse

export interface BilanAnalyse {
  analyseId: string;
  portee: Portee;
  seuils: Seuils;
  tronconsExamines: number;
  tronque: boolean;
  parRegle: { regle: CodeRegle; constatees: number; nouvelles: number }[];
  nouvelles: number;
  confirmees: number;
  disparues: number;
}

export async function constater(portee: Portee, seuils: Seuils): Promise<{ constats: Constat[]; examines: number; tronque: boolean }> {
  const [attributs, proches, noms] = await Promise.all([
    lireAttributs(portee),
    pairesProches(portee, TOLERANCE_DOUBLON_M, RATIO_DOUBLON),
    nomsIdentiques(portee, TOLERANCE_DOUBLON_M),
  ]);
  const constats: Constat[] = [
    ...attributs.troncons.flatMap((t) => constaterAttributs(t, seuils)),
    ...proches.paires.flatMap((p) => constaterPaire(p, TOLERANCE_DOUBLON_M)),
    ...noms.paires.flatMap((p) => (["a", "b"] as const).map((soi) => ({
      tronconId: p[soi],
      regionId: p.regionId,
      regle: "NOM_IDENTIQUE" as const,
      valeurs: { nom: p.nom, autreTronconId: soi === "a" ? p.b : p.a, autreCode: soi === "a" ? p.codeB : p.codeA },
      source: sourceDe("NOM_IDENTIQUE", `sans recouvrement à ${TOLERANCE_DOUBLON_M} m`),
    }))),
  ];
  return { constats, examines: attributs.troncons.length, tronque: attributs.tronque || proches.tronque || noms.tronque };
}

/**
 * Enregistre les constats d'une analyse. IDEMPOTENT : un constat deja enregistre (meme troncon, meme regle,
 * meme empreinte de valeurs) n'est que reconfirme. Une anomalie OUVERTE de la portee qui n'est plus constatee
 * recoit `disparueLe` ; son statut ne change pas, sa decision appartient toujours a une personne.
 */
export async function analyser(portee: Portee, seuils: Seuils, userId: string, ip?: string): Promise<BilanAnalyse> {
  const { constats, examines, tronque } = await constater(portee, seuils);
  const analyseId = randomUUID();
  const maintenant = new Date();

  return prisma.$transaction(async (tx) => {
    const cles = constats.map((c) => ({ ...c, empreinte: empreinte(c.regle, c.valeurs) }));
    const existantes = await tx.anomalieReferentiel.findMany({
      where: { tronconId: { in: [...new Set(cles.map((c) => c.tronconId))] } },
      select: { id: true, tronconId: true, regle: true, empreinte: true },
    });
    const parCle = new Map(existantes.map((e) => [`${e.tronconId}|${e.regle}|${e.empreinte}`, e.id]));
    const vues = new Set<string>();
    const parRegle = new Map<CodeRegle, { constatees: number; nouvelles: number }>(CODES_REGLES.map((r) => [r, { constatees: 0, nouvelles: 0 }]));
    let nouvelles = 0;

    for (const c of cles) {
      const cle = `${c.tronconId}|${c.regle}|${c.empreinte}`;
      if (vues.has(cle)) continue;
      vues.add(cle);
      const compte = parRegle.get(c.regle)!;
      compte.constatees++;
      const id = parCle.get(cle);
      if (id) continue;
      const cree = await tx.anomalieReferentiel.create({
        data: {
          tronconId: c.tronconId, regionId: c.regionId, regle: c.regle, empreinte: c.empreinte,
          gravite: REGLES[c.regle].gravite, valeurs: c.valeurs as Prisma.InputJsonValue, source: c.source,
          detecteeLe: maintenant, derniereDetectionLe: maintenant,
        },
        select: { id: true },
      });
      await tx.decisionAnomalie.create({
        data: { anomalieId: cree.id, statutAvant: null, statutApres: "A_EXAMINER", commentaire: `Constatée par l'analyse ${analyseId}`, auteurId: userId, decideLe: maintenant },
      });
      compte.nouvelles++;
      nouvelles++;
    }

    const confirmeesIds = [...vues].map((k) => parCle.get(k)).filter((x): x is string => !!x);
    for (const ids of chunk(confirmeesIds, 1000)) {
      await tx.anomalieReferentiel.updateMany({ where: { id: { in: ids } }, data: { derniereDetectionLe: maintenant, disparueLe: null } });
    }
    // Disparues : seulement dans la portee examinee, et si l'analyse n'a pas ete tronquee (un constat absent
    // d'une lecture plafonnee n'est pas un constat disparu).
    let disparues = 0;
    if (!tronque) {
      const r = await tx.anomalieReferentiel.updateMany({
        where: {
          statut: { in: STATUTS_OUVERTS }, disparueLe: null, derniereDetectionLe: { lt: maintenant },
          ...(portee.regionId === null ? {} : { regionId: portee.regionId }),
        },
        data: { disparueLe: maintenant },
      });
      disparues = r.count;
    }

    const bilan: BilanAnalyse = {
      analyseId, portee, seuils, tronconsExamines: examines, tronque,
      parRegle: [...parRegle.entries()].map(([regle, v]) => ({ regle, ...v })),
      nouvelles, confirmees: confirmeesIds.length, disparues,
    };
    await logAuditTransactionnelle(tx, {
      userId, action: "CREATE", entityType: "AnalyseReferentiel", entityId: analyseId, before: null,
      after: { portee, seuils, tronconsExamines: examines, tronque, nouvelles, confirmees: confirmeesIds.length, disparues },
      ipAddress: ip,
    });
    return bilan;
  }, { timeout: 120_000, maxWait: 10_000 });
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ------------------------------------------------------------------ lecture

export interface FiltresListe {
  statut?: Statut; regle?: CodeRegle; gravite?: string; regionId?: number; tronconId?: string;
  /** Faux par defaut : une anomalie qui ne se constate plus reste lisible, mais hors de la liste courante. */
  inclureDisparues?: boolean;
  page?: number; pageSize?: number;
}

function whereListe(f: FiltresListe): Prisma.AnomalieReferentielWhereInput {
  return {
    ...(f.statut ? { statut: f.statut } : {}),
    ...(f.regle ? { regle: f.regle } : {}),
    ...(f.gravite ? { gravite: f.gravite } : {}),
    ...(f.regionId ? { regionId: f.regionId } : {}),
    ...(f.tronconId ? { tronconId: f.tronconId } : {}),
    ...(f.inclureDisparues ? {} : { disparueLe: null }),
  };
}

const AVEC_TRONCON = { troncon: { select: { id: true, code: true, nom: true, regionId: true, deletedAt: true, region: { select: { nom: true } } } } } as const;

export async function lister(f: FiltresListe) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
  const where = whereListe(f);
  const [data, total, comptes] = await Promise.all([
    prisma.anomalieReferentiel.findMany({
      where, include: AVEC_TRONCON,
      orderBy: [{ gravite: "asc" }, { detecteeLe: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.anomalieReferentiel.count({ where }),
    prisma.anomalieReferentiel.groupBy({ by: ["statut"], where: { ...where, statut: undefined }, _count: { _all: true } }),
  ]);
  return {
    data, total, page, pageSize, totalPages: Math.ceil(total / pageSize),
    parStatut: Object.fromEntries(comptes.map((c) => [c.statut, c._count._all])),
  };
}

export async function detail(id: string) {
  const a = await prisma.anomalieReferentiel.findUnique({
    where: { id },
    include: { ...AVEC_TRONCON, decisions: { orderBy: { decideLe: "asc" }, include: { auteur: { select: { id: true, nomComplet: true } } } } },
  });
  if (!a) throw new RefusRegistre(404, "INTROUVABLE", "Anomalie introuvable.");
  return { ...a, definition: REGLES[a.regle as CodeRegle] ?? null };
}

export async function exporterCsv(f: FiltresListe): Promise<string> {
  const lignes = await prisma.anomalieReferentiel.findMany({
    where: whereListe(f), include: { ...AVEC_TRONCON, decisions: { orderBy: { decideLe: "desc" }, take: 1, include: { auteur: { select: { nomComplet: true } } } } },
    orderBy: [{ regionId: "asc" }, { tronconId: "asc" }, { regle: "asc" }], take: 20_000,
  });
  const colonnes = ["anomalie", "tronconId", "code", "nom", "region", "regle", "libelle", "gravite", "statut", "valeurs", "source",
    "correctionChamp", "correctionAncienne", "correctionNouvelle", "correctionJustification", "correctionSource",
    "detecteeLe", "derniereDetectionLe", "disparueLe", "derniereDecision", "derniereDecisionPar"];
  return versCsv(colonnes, lignes.map((a) => {
    const c = a.correction as Correction | null;
    const d = a.decisions[0];
    return {
      anomalie: a.id, tronconId: a.tronconId, code: a.troncon.code, nom: a.troncon.nom, region: a.troncon.region?.nom ?? "",
      regle: a.regle, libelle: REGLES[a.regle as CodeRegle]?.libelle ?? a.regle, gravite: a.gravite, statut: a.statut,
      valeurs: a.valeurs, source: a.source,
      correctionChamp: c?.champ, correctionAncienne: c?.ancienne, correctionNouvelle: c?.nouvelle,
      correctionJustification: c?.justification, correctionSource: c?.source,
      detecteeLe: a.detecteeLe.toISOString(), derniereDetectionLe: a.derniereDetectionLe.toISOString(), disparueLe: a.disparueLe?.toISOString(),
      derniereDecision: d ? `${d.statutApres} ${d.decideLe.toISOString()}` : "", derniereDecisionPar: d?.auteur.nomComplet ?? "",
    };
  }));
}

// ------------------------------------------------------------------ decisions et corrections

type Tx = Prisma.TransactionClient;

const jsonOuNul = (c: Correction | null) => (c ? (c as unknown as Prisma.InputJsonValue) : Prisma.DbNull);

async function valeursTroncon(tx: Tx, tronconId: string) {
  const t = await tx.troncon.findUnique({ where: { id: tronconId }, select: { pkDebut: true, pkFin: true, longueurKm: true, classe: true, revetement: true, regionId: true, deletedAt: true } });
  if (!t) throw new RefusRegistre(404, "TRONCON_INTROUVABLE", "Tronçon introuvable.");
  return t;
}

export async function decider(id: string, demande: DecisionDemandee, userId: string, ip?: string) {
  const a0 = await prisma.anomalieReferentiel.findUnique({ where: { id }, select: { troncon: { select: { regionId: true } } } });
  if (!a0) throw new RefusRegistre(404, "INTROUVABLE", "Anomalie introuvable.");
  await exigerTerritoire(userId, [a0.troncon.regionId]);
  return prisma.$transaction(async (tx) => {
    const a = await tx.anomalieReferentiel.findUnique({ where: { id } });
    if (!a) throw new RefusRegistre(404, "INTROUVABLE", "Anomalie introuvable.");
    const t = await valeursTroncon(tx, a.tronconId);
    const j = jugerDecision({
      regle: a.regle as CodeRegle, statutActuel: a.statut as Statut, correctionActuelle: a.correction as Correction | null,
      demande, auteurId: userId, valeurCourante: (champ) => t[champ] as number | string,
    });
    if (!j.ok) return echec(j, j.code === "TRANSITION_INTERDITE" ? 409 : 422);
    // Compare-et-echange sur le statut lu : deux decisions concurrentes ne gagnent pas toutes deux.
    const maj = await tx.anomalieReferentiel.updateMany({
      where: { id, statut: a.statut },
      data: { statut: demande.statut, correction: jsonOuNul(j.correction) },
    });
    if (maj.count !== 1) throw new RefusRegistre(409, "CONCURRENCE", "L'anomalie a changé pendant la décision : recharger.");
    await tx.decisionAnomalie.create({
      data: { anomalieId: id, statutAvant: a.statut, statutApres: demande.statut, commentaire: demande.commentaire?.trim() || null, correction: jsonOuNul(j.correction), auteurId: userId },
    });
    await logAuditTransactionnelle(tx, {
      userId, action: demande.statut === "REJETEE" ? "REJECT" : demande.statut === "VALIDEE" ? "VALIDATE" : "UPDATE",
      entityType: "AnomalieReferentiel", entityId: id,
      before: { statut: a.statut, correction: a.correction }, after: { statut: demande.statut, correction: j.correction, commentaire: demande.commentaire ?? null },
      ipAddress: ip,
    });
    return tx.anomalieReferentiel.findUnique({ where: { id } });
  });
}

export interface LignePrevisualisation {
  anomalieId: string; tronconId: string; code: string;
  champ: ChampCorrigeable | null; constatee: unknown; actuelle: unknown; nouvelle: unknown;
  applicable: boolean; motif: string | null;
}

/** Ce que l'application ferait, sans rien ecrire. */
export async function previsualiser(ids: string[]): Promise<LignePrevisualisation[]> {
  const anomalies = await prisma.anomalieReferentiel.findMany({ where: { id: { in: ids } }, include: { troncon: { select: { code: true, pkDebut: true, pkFin: true, longueurKm: true, classe: true, revetement: true } } } });
  const parId = new Map(anomalies.map((a) => [a.id, a]));
  return ids.map((id) => {
    const a = parId.get(id);
    if (!a) return { anomalieId: id, tronconId: "", code: "", champ: null, constatee: null, actuelle: null, nouvelle: null, applicable: false, motif: "Anomalie introuvable." };
    const c = a.correction as Correction | null;
    const actuelle = c ? (a.troncon[c.champ] as number | string) : null;
    const j = jugerApplication(a.statut as Statut, c, actuelle);
    return {
      anomalieId: id, tronconId: a.tronconId, code: a.troncon.code, champ: c?.champ ?? null,
      constatee: c?.ancienne ?? null, actuelle, nouvelle: c?.nouvelle ?? null,
      applicable: j.ok, motif: j.ok ? null : j.message,
    };
  });
}

async function ecrireChamp(tx: Tx, p: { tronconId: string; champ: ChampCorrigeable; avant: unknown; apres: number | string; userId: string; ip?: string; motif: Record<string, unknown> }) {
  // Compare-et-echange : l'ecriture ne passe que si la valeur est toujours celle qui a ete jugee.
  const where = { id: p.tronconId, [p.champ]: p.avant } as Prisma.TronconWhereInput;
  const maj = await tx.troncon.updateMany({ where, data: { [p.champ]: p.apres } as Prisma.TronconUpdateManyMutationInput });
  if (maj.count !== 1) throw new RefusRegistre(409, "VALEUR_A_CHANGE", `Le champ ${p.champ} du tronçon a changé pendant l'opération : rien n'a été écrit.`);
  await Promise.all(construireSaisies("Troncon", p.tronconId, { [p.champ]: p.apres }, p.userId, tx as never) as Promise<unknown>[]);
  await logAuditTransactionnelle(tx, {
    userId: p.userId, action: "UPDATE", entityType: "Troncon", entityId: p.tronconId,
    before: { [p.champ]: p.avant }, after: { [p.champ]: p.apres, ...p.motif }, ipAddress: p.ip,
  });
}

/**
 * Applique des corrections VALIDEES, en une transaction : toutes passent, ou aucune. Chaque troncon garde dans
 * `audit_logs` l'ancienne et la nouvelle valeur, la justification, la source et l'anomalie d'origine.
 */
export async function appliquer(ids: string[], userId: string, ip?: string) {
  if (ids.length === 0 || ids.length > PLAFOND_GROUPE) throw new RefusRegistre(422, "TAILLE_GROUPE", `De 1 à ${PLAFOND_GROUPE} corrections par application.`);
  const unique = [...new Set(ids)];
  const regions = await prisma.anomalieReferentiel.findMany({ where: { id: { in: unique } }, select: { troncon: { select: { regionId: true } } } });
  if (regions.length !== unique.length) throw new RefusRegistre(404, "INTROUVABLE", "Une anomalie au moins est introuvable : rien n'a été appliqué.");
  await exigerTerritoire(userId, regions.map((r) => r.troncon.regionId));

  return prisma.$transaction(async (tx) => {
    const resultats: { anomalieId: string; tronconId: string; champ: ChampCorrigeable; ancienne: unknown; nouvelle: unknown }[] = [];
    const champsTouches = new Set<string>();
    for (const id of unique) {
      const a = await tx.anomalieReferentiel.findUnique({ where: { id } });
      if (!a) throw new RefusRegistre(404, "INTROUVABLE", "Anomalie introuvable.");
      const c = a.correction as Correction | null;
      const t = await valeursTroncon(tx, a.tronconId);
      if (t.deletedAt) throw new RefusRegistre(409, "TRONCON_ARCHIVE", `Le tronçon de l'anomalie ${id} est archivé : rien n'a été appliqué.`);
      const j = jugerApplication(a.statut as Statut, c, c ? (t[c.champ] as number | string) : null);
      if (!j.ok) throw new RefusRegistre(409, j.code, `${j.message} (anomalie ${id}) : rien n'a été appliqué.`);
      const cle = `${a.tronconId}|${j.correction.champ}`;
      if (champsTouches.has(cle)) throw new RefusRegistre(409, "CHAMP_EN_DOUBLE", `Deux corrections visent le même champ du même tronçon (${j.correction.champ}) : les appliquer une à une.`);
      champsTouches.add(cle);
      await ecrireChamp(tx, {
        tronconId: a.tronconId, champ: j.correction.champ, avant: j.correction.ancienne, apres: j.correction.nouvelle, userId, ip,
        motif: { justification: j.correction.justification, source: j.correction.source, anomalieId: id, regle: a.regle },
      });
      const maj = await tx.anomalieReferentiel.updateMany({ where: { id, statut: "VALIDEE" }, data: { statut: "CORRIGEE" } });
      if (maj.count !== 1) throw new RefusRegistre(409, "CONCURRENCE", "L'anomalie a changé pendant l'application : rien n'a été appliqué.");
      await tx.decisionAnomalie.create({ data: { anomalieId: id, statutAvant: "VALIDEE", statutApres: "CORRIGEE", commentaire: "Correction appliquée", correction: j.correction as unknown as Prisma.InputJsonValue, auteurId: userId } });
      resultats.push({ anomalieId: id, tronconId: a.tronconId, champ: j.correction.champ, ancienne: j.correction.ancienne, nouvelle: j.correction.nouvelle });
    }
    return { appliquees: resultats.length, resultats };
  }, { timeout: 60_000 });
}

/** Rend l'ancienne valeur d'une correction appliquee ; l'anomalie revient a VALIDEE, sa correction est gardee. */
export async function annuler(id: string, motif: string, userId: string, ip?: string) {
  if (motif.trim().length < 5) throw new RefusRegistre(422, "MOTIF_EXIGE", "Une annulation se motive (5 caractères au moins).");
  const a0 = await prisma.anomalieReferentiel.findUnique({ where: { id }, select: { troncon: { select: { regionId: true } } } });
  if (!a0) throw new RefusRegistre(404, "INTROUVABLE", "Anomalie introuvable.");
  await exigerTerritoire(userId, [a0.troncon.regionId]);
  return prisma.$transaction(async (tx) => {
    const a = await tx.anomalieReferentiel.findUnique({ where: { id } });
    if (!a) throw new RefusRegistre(404, "INTROUVABLE", "Anomalie introuvable.");
    const c = a.correction as Correction | null;
    const t = await valeursTroncon(tx, a.tronconId);
    const j = jugerAnnulation(a.statut as Statut, c, c ? (t[c.champ] as number | string) : null);
    if (!j.ok) return echec(j);
    if (j.correction.ancienne === null) throw new RefusRegistre(409, "ANCIENNE_INCONNUE", "L'ancienne valeur n'a pas été constatée : l'annulation n'a rien à rendre.");
    await ecrireChamp(tx, {
      tronconId: a.tronconId, champ: j.correction.champ, avant: j.correction.nouvelle, apres: j.correction.ancienne, userId, ip,
      motif: { annulationDe: id, motif: motif.trim() },
    });
    const maj = await tx.anomalieReferentiel.updateMany({ where: { id, statut: "CORRIGEE" }, data: { statut: "VALIDEE" } });
    if (maj.count !== 1) throw new RefusRegistre(409, "CONCURRENCE", "L'anomalie a changé pendant l'annulation.");
    await tx.decisionAnomalie.create({ data: { anomalieId: id, statutAvant: "CORRIGEE", statutApres: "VALIDEE", commentaire: `Correction annulée : ${motif.trim()}`, correction: j.correction as unknown as Prisma.InputJsonValue, auteurId: userId } });
    return tx.anomalieReferentiel.findUnique({ where: { id } });
  });
}
