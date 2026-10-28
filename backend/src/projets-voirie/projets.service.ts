/**
 * Service des projets de voirie, des concessionnaires et du cycle de vie des jeux (autorisation, rejet, retrait).
 * Le depot d'un fichier est dans `import.service.ts`, la carte dans `carte.service.ts`, l'analyse dans `analyse.service.ts`.
 *
 * REGLES (contrat v2) : suppression logique uniquement ; toute ecriture est auditee DANS la transaction qui la porte (un echec
 * d'audit annule l'ecriture) ; aucune ecriture hors des tables du module et de `audit_logs`.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { ErreurMetier, introuvable } from "./erreurs";
import type { Bbox } from "./lecture.types";
import { INCLURE_JEU, vueJeu, vueProjet } from "./vues";

export interface Acteur { id: string; role: string; ip?: string }
/** Regions visibles : `null` = pays entier (compte national). */
export type Portee = readonly number[] | null;
export type Tx = Prisma.TransactionClient;

// ------------------------------------------------------------------------------------------------
// Projets
// ------------------------------------------------------------------------------------------------

export interface DonneesProjet {
  code: string; nom: string; commune?: string | null; prefecture?: string | null; regionId?: number | null;
  description?: string | null; largeurEmpriseM?: number; largeurChausseeM?: number;
}

function erreurUnicite(e: unknown, code: string, message: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ErreurMetier(409, code, message);
  throw e;
}

export async function creerProjet(acteur: Acteur, d: DonneesProjet) {
  const code = d.code.trim().toUpperCase();
  const empr = d.largeurEmpriseM ?? 15;
  const chau = d.largeurChausseeM ?? 7;
  if (!(chau > 0 && chau <= empr && empr <= 200)) {
    throw new ErreurMetier(400, "LARGEURS_INCOHERENTES", "La largeur de chaussée doit être positive et au plus égale à la largeur d'emprise (200 m au plus).");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      if (d.regionId != null) {
        const region = await tx.region.findUnique({ where: { id: d.regionId }, select: { id: true } });
        if (!region) throw new ErreurMetier(400, "REGION_INCONNUE", "Région inconnue.");
      }
      const p = await tx.projetVoirie.create({
        data: {
          code, nom: d.nom.trim(), commune: d.commune ?? null, prefecture: d.prefecture ?? null, regionId: d.regionId ?? null,
          description: d.description ?? null, largeurEmpriseM: empr, largeurChausseeM: chau, creeParId: acteur.id,
        },
      });
      await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "ProjetVoirie", entityId: p.id, after: vueProjet(p), ipAddress: acteur.ip });
      return vueProjet(p);
    });
  } catch (e) {
    return erreurUnicite(e, "CODE_DEJA_UTILISE", `Le code « ${code} » est déjà utilisé (y compris par un projet retiré).`);
  }
}

function encoderCurseur(c: { t: string; i: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
export function decoderCurseur(s: string): { t: Date; i: string } | null {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof o.t !== "string" || typeof o.i !== "string" || o.i.length > 64) return null;
    const t = new Date(o.t);
    return Number.isNaN(t.getTime()) ? null : { t, i: o.i };
  } catch { return null; }
}

export async function listerProjets(portee: Portee, f: { q?: string; limite: number; curseur?: { t: Date; i: string } }) {
  const and: Prisma.ProjetVoirieWhereInput[] = [{ deletedAt: null }];
  if (portee !== null) and.push({ regionId: { in: [...portee] } });
  if (f.q) {
    and.push({ OR: [
      { nom: { contains: f.q, mode: "insensitive" } }, { code: { contains: f.q, mode: "insensitive" } },
      { commune: { contains: f.q, mode: "insensitive" } }, { prefecture: { contains: f.q, mode: "insensitive" } },
    ] });
  }
  if (f.curseur) and.push({ OR: [{ createdAt: { lt: f.curseur.t } }, { createdAt: f.curseur.t, id: { lt: f.curseur.i } }] });
  const lignes = await prisma.projetVoirie.findMany({ where: { AND: and }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.limite + 1 });
  const page = lignes.slice(0, f.limite);
  const comptes = page.length
    ? await prisma.jeuDonneesProjet.groupBy({ by: ["projetId", "statut"], where: { projetId: { in: page.map((p) => p.id) }, statut: { not: "RETIRE" } }, _count: { _all: true } })
    : [];
  const dernier = page[page.length - 1];
  return {
    projets: page.map((p) => {
      const jeux: Record<string, number> = {};
      for (const c of comptes) if (c.projetId === p.id) jeux[c.statut] = c._count._all;
      return { ...vueProjet(p), jeux };
    }),
    curseurSuivant: lignes.length > f.limite && dernier ? encoderCurseur({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}

/** Region d'un projet pour le controle territorial : `[]` si le projet n'existe pas (ou est retire), `[null]` sans region. */
export async function regionsDuProjet(id: string): Promise<(number | null)[]> {
  const p = await prisma.projetVoirie.findFirst({ where: { id, deletedAt: null }, select: { regionId: true } });
  return p ? [p.regionId] : [];
}

async function projetOuErreur(tx: Pick<Tx, "projetVoirie">, id: string) {
  const p = await tx.projetVoirie.findFirst({ where: { id, deletedAt: null } });
  if (!p) throw introuvable("Projet", "PROJET_INTROUVABLE");
  return p;
}

/** Union des emprises (`resume.bbox`) des jeux autorises. */
function bboxDesJeux(jeux: { resume: unknown }[]): Bbox | null {
  let b: Bbox | null = null;
  for (const j of jeux) {
    const r = (j.resume as { bbox?: unknown } | null)?.bbox;
    if (!Array.isArray(r) || r.length !== 4 || !r.every((x) => typeof x === "number")) continue;
    const [w, s, e, n] = r as Bbox;
    b = b ? [Math.min(b[0], w), Math.min(b[1], s), Math.max(b[2], e), Math.max(b[3], n)] : [w, s, e, n];
  }
  return b;
}

export async function ficheProjet(id: string) {
  const p = await projetOuErreur(prisma, id);
  const jeux = await prisma.jeuDonneesProjet.findMany({ where: { projetId: id, statut: { not: "RETIRE" } }, include: INCLURE_JEU, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return {
    ...vueProjet(p),
    parametres: { largeurEmpriseM: Number(p.largeurEmpriseM), largeurChausseeM: Number(p.largeurChausseeM), statut: p.statutParametres },
    bbox: bboxDesJeux(jeux.filter((j) => j.statut === "AUTORISE")),
    jeux: jeux.map((j) => vueJeu(j)),
  };
}

export interface ModifProjet {
  nom?: string; commune?: string | null; prefecture?: string | null; description?: string | null;
  largeurEmpriseM?: number; largeurChausseeM?: number; statutParametres?: "THEORIQUE" | "VALIDE";
}

export async function modifierProjet(acteur: Acteur, id: string, m: ModifProjet) {
  if (m.statutParametres === "VALIDE" && acteur.role !== "ADMIN") {
    throw new ErreurMetier(403, "ROLE_INSUFFISANT", "Seul un administrateur peut valider les paramètres de largeur.");
  }
  return prisma.$transaction(async (tx) => {
    const avant = await projetOuErreur(tx, id);
    const empr = m.largeurEmpriseM ?? Number(avant.largeurEmpriseM);
    const chau = m.largeurChausseeM ?? Number(avant.largeurChausseeM);
    if (!(chau > 0 && chau <= empr && empr <= 200)) {
      throw new ErreurMetier(400, "LARGEURS_INCOHERENTES", "La largeur de chaussée doit être positive et au plus égale à la largeur d'emprise (200 m au plus).");
    }
    const largeursChangent = empr !== Number(avant.largeurEmpriseM) || chau !== Number(avant.largeurChausseeM);
    // Toute modification des largeurs remet les parametres a THEORIQUE, sauf validation explicite par un ADMIN dans la meme requete.
    const statut = m.statutParametres ?? (largeursChangent ? "THEORIQUE" : avant.statutParametres);
    const apres = await tx.projetVoirie.update({
      where: { id },
      data: {
        ...(m.nom !== undefined ? { nom: m.nom.trim() } : {}),
        ...(m.commune !== undefined ? { commune: m.commune } : {}),
        ...(m.prefecture !== undefined ? { prefecture: m.prefecture } : {}),
        ...(m.description !== undefined ? { description: m.description } : {}),
        largeurEmpriseM: empr, largeurChausseeM: chau, statutParametres: statut,
      },
    });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "UPDATE", entityType: "ProjetVoirie", entityId: id, before: vueProjet(avant), after: vueProjet(apres), ipAddress: acteur.ip });
    return vueProjet(apres);
  });
}

export async function retirerProjet(acteur: Acteur, id: string) {
  return prisma.$transaction(async (tx) => {
    const avant = await projetOuErreur(tx, id);
    const apres = await tx.projetVoirie.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "DELETE", entityType: "ProjetVoirie", entityId: id, before: vueProjet(avant), after: { ...vueProjet(apres), deletedAt: apres.deletedAt }, ipAddress: acteur.ip });
    return { id, retire: true };
  });
}

// ------------------------------------------------------------------------------------------------
// Concessionnaires
// ------------------------------------------------------------------------------------------------

export async function listerConcessionnaires() {
  const l = await prisma.concessionnaireReseau.findMany({ where: { deletedAt: null }, orderBy: { nom: "asc" } });
  return { concessionnaires: l.map((c) => ({ id: c.id, nom: c.nom, typeReseau: c.typeReseau, contact: c.contact, createdAt: c.createdAt })) };
}

export async function creerConcessionnaire(acteur: Acteur, d: { nom: string; typeReseau: Prisma.ConcessionnaireReseauCreateInput["typeReseau"]; contact?: string | null }) {
  const nom = d.nom.trim();
  try {
    return await prisma.$transaction(async (tx) => {
      const existant = await tx.concessionnaireReseau.findFirst({ where: { nom: { equals: nom, mode: "insensitive" } }, select: { id: true } });
      if (existant) throw new ErreurMetier(409, "CONCESSIONNAIRE_DEJA_CONNU", `Le concessionnaire « ${nom} » existe déjà.`, { concessionnaireId: existant.id });
      const c = await tx.concessionnaireReseau.create({ data: { nom, typeReseau: d.typeReseau, contact: d.contact ?? null } });
      const vue = { id: c.id, nom: c.nom, typeReseau: c.typeReseau, contact: c.contact, createdAt: c.createdAt };
      await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "ConcessionnaireReseau", entityId: c.id, after: vue, ipAddress: acteur.ip });
      return vue;
    });
  } catch (e) {
    return erreurUnicite(e, "CONCESSIONNAIRE_DEJA_CONNU", `Le concessionnaire « ${nom} » existe déjà.`);
  }
}

// ------------------------------------------------------------------------------------------------
// Jeux : lecture, retrait, autorisation, rejet
// ------------------------------------------------------------------------------------------------

export async function listerJeux(projetId: string) {
  await projetOuErreur(prisma, projetId);
  const jeux = await prisma.jeuDonneesProjet.findMany({ where: { projetId, statut: { not: "RETIRE" } }, include: INCLURE_JEU, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return { jeux: jeux.map((j) => vueJeu(j)) };
}

/** Verrou du projet : serialise depots, decisions et retraits d'un meme projet (aucune course sur les index uniques partiels). */
export async function verrouillerProjet(tx: Tx, id: string): Promise<void> {
  const l = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "projets_voirie" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR UPDATE`;
  if (l.length === 0) throw introuvable("Projet", "PROJET_INTROUVABLE");
}

async function jeuOuErreur(tx: Tx, projetId: string, jeuId: string) {
  const j = await tx.jeuDonneesProjet.findFirst({ where: { id: jeuId, projetId } });
  if (!j) throw introuvable("Jeu de données", "JEU_INTROUVABLE");
  return j;
}

export async function retirerJeu(acteur: Acteur, projetId: string, jeuId: string) {
  return prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const avant = await jeuOuErreur(tx, projetId, jeuId);
    if (avant.statut === "RETIRE") throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", "Ce jeu est déjà retiré.", { statut: avant.statut });
    await tx.jeuDonneesProjet.update({ where: { id: jeuId }, data: { statut: "RETIRE", deletedAt: new Date() } });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "DELETE", entityType: "JeuDonneesProjet", entityId: jeuId,
      before: { statut: avant.statut, version: avant.version, role: avant.role }, after: { statut: "RETIRE" }, ipAddress: acteur.ip,
    });
    const apres = await tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id: jeuId }, include: INCLURE_JEU });
    return { jeu: vueJeu(apres) };
  });
}

export type Decision = "AUTORISE" | "REJETE";

/**
 * Autorise ou rejette un jeu en controle. `justification` : 10 caracteres au moins (verifie par l'appelant ET par la base).
 * Autoriser une nouvelle version passe le jeu AUTORISE de meme cle en REMPLACE (jamais de suppression). Si l'auteur du depot
 * est la personne qui decide, l'audit le note (`memePersonne`) sans bloquer.
 */
export async function decider(acteur: Acteur, projetId: string, jeuId: string, decision: Decision, justification: string) {
  const texte = justification.trim();
  if (texte.length < 10) throw new ErreurMetier(400, "JUSTIFICATION_INVALIDE", "La justification doit comporter 10 caractères au moins.");
  return prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const jeu = await jeuOuErreur(tx, projetId, jeuId);
    if (jeu.statut !== "CONTROLE" && jeu.statut !== "RECU") {
      throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", `Seul un jeu en contrôle peut être ${decision === "AUTORISE" ? "autorisé" : "rejeté"} (statut actuel : ${jeu.statut}).`, { statut: jeu.statut });
    }
    let remplaces: string[] = [];
    if (decision === "AUTORISE" && jeu.role !== "AUTRE") {
      const anciens = await tx.jeuDonneesProjet.findMany({
        where: { projetId, role: jeu.role, concessionnaireId: jeu.concessionnaireId, statut: "AUTORISE", id: { not: jeuId } }, select: { id: true },
      });
      remplaces = anciens.map((a) => a.id);
      // L'ancien jeu passe REMPLACE AVANT que le nouveau devienne AUTORISE (index unique partiel : un seul AUTORISE par cle).
      if (remplaces.length) await tx.jeuDonneesProjet.updateMany({ where: { id: { in: remplaces } }, data: { statut: "REMPLACE" } });
    }
    const maintenant = new Date();
    await tx.jeuDonneesProjet.update({
      where: { id: jeuId },
      data: { statut: decision, decideParId: acteur.id, decideLe: maintenant, justificationDecision: texte },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: decision === "AUTORISE" ? "VALIDATE" : "REJECT", entityType: "JeuDonneesProjet", entityId: jeuId,
      before: { statut: jeu.statut, version: jeu.version },
      after: { statut: decision, justification: texte, remplaces, memePersonne: jeu.creeParId === acteur.id, version: jeu.version, role: jeu.role },
      ipAddress: acteur.ip,
    });
    const apres = await tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id: jeuId }, include: INCLURE_JEU });
    return { jeu: vueJeu(apres), remplaces };
  });
}
