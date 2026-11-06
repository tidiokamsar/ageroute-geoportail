/**
 * REGLES DE CONFLIT (versionnees, approuvees) ET HISTORIQUE DES ANALYSES PERSISTEES : lecture, creation, approbation, comparaison
 * (contrat RC-3, sections 3, 5 et 6).
 *
 * Une regle APPROUVEE est immuable : la base le garantit (declencheur) ; pour changer un seuil on cree une nouvelle version. Creer une
 * regle ne modifie aucun conflit existant : elle s'applique a la PROCHAINE analyse, qui enregistre la version utilisee.
 * Separation des taches : l'auteur d'une regle ne l'approuve pas sans derogation motivee, tracee dans l'audit.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { estDelaiDepasse } from "../bd";
import { ErreurMetier, introuvable } from "../erreurs";
import { verrouillerProjet, type Acteur } from "../projets.service";
import { INCLURE_ANALYSE, vueAnalyse } from "./analyse-conflits.service";
import { prochaineVersionRegle, resoudreRegle, verifierApprobationRegle, type RegleLue } from "./regle.noyau";
import { comparerInstantanes } from "./rejeu.noyau";
import { JUSTIFICATION_MIN } from "./types.noyau";

const FAMILLES = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"] as const;
const personne = (p: { id: string; nomComplet: string } | null | undefined) => (p ? { id: p.id, nomComplet: p.nomComplet } : null);
const INCLURE_REGLE = { creePar: { select: { id: true, nomComplet: true } }, approuvePar: { select: { id: true, nomComplet: true } } } as const;
type LigneRegle = Prisma.RegleConflitGetPayload<{ include: typeof INCLURE_REGLE }>;

export function vueRegle(r: LigneRegle) {
  return {
    id: r.id, projetId: r.projetId, portee: r.projetId ? "PROJET" : "GENERALE", famille: r.famille, code: r.code, version: r.version,
    toleranceProximiteM: Number(r.toleranceProximiteM), margeIncertitude: Number(r.margeIncertitude), statut: r.statut, justification: r.justification,
    systeme: r.creeParId === null, creePar: personne(r.creePar), approuvePar: personne(r.approuvePar), approuveLe: r.approuveLe,
    motifApprobation: r.motifApprobation, derogationApprobation: r.derogationApprobation, createdAt: r.createdAt,
  };
}

const lue = (r: LigneRegle): RegleLue => ({
  regleId: r.id, projetId: r.projetId, famille: r.famille, code: r.code, version: r.version, toleranceProximiteM: Number(r.toleranceProximiteM),
  margeIncertitude: Number(r.margeIncertitude), statut: r.statut, approuveLe: r.approuveLe,
});

/** Regles du projet et regles generales (dont la regle par defaut), avec la regle EFFECTIVE de chaque famille de reseau. */
export async function listerRegles(projetId: string) {
  const lignes = await prisma.regleConflit.findMany({
    where: { OR: [{ projetId }, { projetId: null }] }, include: INCLURE_REGLE, orderBy: [{ projetId: "asc" }, { code: "asc" }, { version: "desc" }],
  });
  const lues = lignes.map(lue);
  const effectives = FAMILLES.map((famille) => {
    const r = resoudreRegle(lues, projetId, famille);
    return { famille, regleId: r.regle.regleId, code: r.regle.code, version: r.regle.version, portee: r.portee, toleranceProximiteM: r.regle.toleranceProximiteM, margeIncertitude: r.regle.margeIncertitude };
  });
  return { regles: lignes.map(vueRegle), effectives };
}

export interface CreationRegle { famille?: (typeof FAMILLES)[number] | null; code: string; toleranceProximiteM: number; margeIncertitude: number; justification: string }

export async function creerRegle(acteur: Acteur, projetId: string, d: CreationRegle) {
  if (d.justification.trim().length < JUSTIFICATION_MIN) {
    throw new ErreurMetier(422, "JUSTIFICATION_REQUISE", `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise.`);
  }
  return prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const famille = d.famille ?? null;
    const code = d.code.trim();
    const max = await tx.regleConflit.aggregate({ where: { projetId, famille, code }, _max: { version: true } });
    const version = prochaineVersionRegle(max._max.version === null ? [] : [max._max.version]);
    const r = await tx.regleConflit.create({
      data: {
        projetId, famille, code, version, toleranceProximiteM: d.toleranceProximiteM, margeIncertitude: d.margeIncertitude,
        justification: d.justification.trim(), creeParId: acteur.id, statut: "BROUILLON",
      },
      include: INCLURE_REGLE,
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "RegleConflit", entityId: r.id,
      after: { projetId, famille, code, version, toleranceProximiteM: d.toleranceProximiteM, margeIncertitude: d.margeIncertitude, statut: "BROUILLON" }, ipAddress: acteur.ip,
    });
    return { regle: vueRegle(r) };
  });
}

export async function approuverRegle(acteur: Acteur, projetId: string, regleId: string, d: { justification?: string; derogation?: string }) {
  try {
    return await prisma.$transaction(async (tx) => {
      await verrouillerProjet(tx, projetId);
      const r = await tx.regleConflit.findFirst({ where: { id: regleId, OR: [{ projetId }, { projetId: null }] }, include: INCLURE_REGLE });
      if (!r) throw introuvable("Règle", "REGLE_INTROUVABLE");
      const v = verifierApprobationRegle({ statut: r.statut, creeParId: r.creeParId, acteurId: acteur.id, justification: d.justification, derogation: d.derogation });
      if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
      const n = await tx.regleConflit.updateMany({
        where: { id: regleId, statut: "BROUILLON" },
        data: { statut: "APPROUVEE", approuveParId: acteur.id, approuveLe: new Date(), motifApprobation: (d.justification ?? "").trim(), derogationApprobation: v.derogation },
      });
      if (n.count !== 1) throw new ErreurMetier(409, "REGLE_IMMUABLE", "Cette règle vient d'être approuvée : elle ne change plus.");
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "VALIDATE", entityType: "RegleConflit", entityId: regleId,
        before: { statut: "BROUILLON" },
        after: { statut: "APPROUVEE", code: r.code, version: r.version, justification: (d.justification ?? "").trim(), derogationSeparation: v.derogation, memePersonne: r.creeParId === acteur.id },
        ipAddress: acteur.ip,
      });
      const apres = await tx.regleConflit.findUniqueOrThrow({ where: { id: regleId }, include: INCLURE_REGLE });
      return { regle: vueRegle(apres) };
    });
  } catch (e) {
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Le projet est occupé par une autre opération : réessayez dans quelques instants.");
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------
// Analyses : historique, detail, comparaison
// ------------------------------------------------------------------------------------------------

const encoder = (n: number) => Buffer.from(JSON.stringify({ n }), "utf8").toString("base64url");
export function decoderCurseurAnalyse(s: string): number | null {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as { n?: unknown };
    return typeof o.n === "number" && Number.isInteger(o.n) && o.n >= 1 ? o.n : null;
  } catch { return null; }
}

export async function listerAnalyses(projetId: string, limite: number, avantNumero?: number) {
  const l = await prisma.analyseConflitProjet.findMany({
    where: { projetId, ...(avantNumero ? { numero: { lt: avantNumero } } : {}) },
    include: INCLURE_ANALYSE, orderBy: { numero: "desc" }, take: limite + 1,
  });
  const page = l.slice(0, limite);
  return { analyses: page.map(vueAnalyse), curseurSuivant: l.length > limite ? encoder(page[page.length - 1].numero) : null };
}

export async function detailAnalyse(projetId: string, aid: string) {
  const a = await prisma.analyseConflitProjet.findFirst({ where: { id: aid, projetId }, include: INCLURE_ANALYSE });
  if (!a) throw introuvable("Analyse", "ANALYSE_INTROUVABLE");
  return { analyse: vueAnalyse(a) };
}

const DETAILS_MAX = 1000;

/**
 * Compare deux analyses d'un projet. `aid` est l'analyse COMPAREE, `bid` l'analyse de REFERENCE : `apparus` = presents dans `aid` et absents
 * de `bid` ; `disparus` = presents dans `bid` et absents de `aid` ; `modifies` = presents des deux avec une mesure differente.
 * Une analyse en echec n'a pas d'instantane : 409 ANALYSE_NON_COMPARABLE.
 */
export async function comparerAnalyses(projetId: string, aid: string, bid: string) {
  const [a, b] = await Promise.all([
    prisma.analyseConflitProjet.findFirst({ where: { id: aid, projetId }, select: { id: true, numero: true, statut: true, instantane: true, createdAt: true } }),
    prisma.analyseConflitProjet.findFirst({ where: { id: bid, projetId }, select: { id: true, numero: true, statut: true, instantane: true, createdAt: true } }),
  ]);
  if (!a || !b) throw introuvable("Analyse", "ANALYSE_INTROUVABLE");
  if (a.statut !== "TERMINEE" || b.statut !== "TERMINEE") {
    throw new ErreurMetier(409, "ANALYSE_NON_COMPARABLE", "Une analyse en échec n'a pas de résultat à comparer.");
  }
  const c = comparerInstantanes(b.instantane as Record<string, string>, a.instantane as Record<string, string>);
  const aDetailler = [...c.apparus.slice(0, DETAILS_MAX), ...c.disparus.slice(0, DETAILS_MAX), ...c.modifies.slice(0, DETAILS_MAX)];
  const lignes = aDetailler.length
    ? await prisma.conflitProjet.findMany({ where: { projetId, cle: { in: aDetailler } }, select: { cle: true, id: true, type: true, axe: true, statut: true, aReexaminer: true } })
    : [];
  const parCle = new Map(lignes.map((x) => [x.cle, x] as const));
  const liste = (cles: string[]) => ({
    nb: cles.length, cles,
    conflits: cles.slice(0, DETAILS_MAX).map((k) => parCle.get(k)).filter((x): x is NonNullable<typeof x> => x !== undefined),
    detailsTronques: cles.length > DETAILS_MAX,
  });
  return {
    reference: { id: b.id, numero: b.numero, createdAt: b.createdAt },
    comparee: { id: a.id, numero: a.numero, createdAt: a.createdAt },
    apparus: liste(c.apparus), disparus: liste(c.disparus), modifies: liste(c.modifies),
    identiques: { nb: c.identiques.length, cles: c.identiques },
  };
}
