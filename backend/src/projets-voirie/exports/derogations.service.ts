/**
 * DEROGATIONS DE CONFIDENTIALITE DE L'EXPORT (lot X1 ; contrat CONTRAT-EXPORTS.md, section 5). ADMIN seul (la route l'impose). Une derogation est
 * nominative (beneficiaire), justifiee, bornee dans le temps, a usage unique ; elle ne couvre que des jeux AUTORISE d'un niveau sensible du projet.
 * Creation auditee dans sa transaction ; consommation : dossier.service.ts (transaction de remise). Aucune modification ni suppression (declencheurs).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { perimetreDe } from "../../territoire/territoire.service";
import { verifierTerritoire } from "../../territoire/territoire.noyau";
import { exigerProjetActif } from "../conflits/dossiers.service";
import { ErreurMetier } from "../erreurs";
import { verrouillerProjet, type Acteur } from "../projets.service";
import { DEROGATION_DUREE_MAX_H, derogationDureeH } from "./config";
import { etatDerogation, verifierBeneficiaire, verifierCreationDerogation, type Verdict } from "./confidentialite.noyau";

const lever = (v: Verdict): void => { if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message, v.extra); };

export interface DemandeDerogation { jeuxIds: string[]; justification: string; beneficiaireId?: string; dureeHeures?: number }

type LigneDerogation = { id: string; projetId: string; jeuxIds: string[]; beneficiaireId: string; accordeeParId: string; justification: string; createdAt: Date; expireLe: Date; utiliseeLe: Date | null; exportId: string | null };

function vue(d: LigneDerogation, personnes: Map<string, { id: string; nomComplet: string }>, maintenant: Date) {
  const p = (id: string) => personnes.get(id) ?? { id, nomComplet: null };
  return {
    id: d.id, projetId: d.projetId, jeuxIds: d.jeuxIds, beneficiaire: p(d.beneficiaireId), accordeePar: p(d.accordeeParId), justification: d.justification,
    createdAt: d.createdAt, expireLe: d.expireLe, utiliseeLe: d.utiliseeLe, exportId: d.exportId, etat: etatDerogation(d, maintenant),
  };
}

export async function creerDerogation(acteur: Acteur, projetId: string, d: DemandeDerogation) {
  const dureeH = d.dureeHeures ?? derogationDureeH();
  const beneficiaireId = d.beneficiaireId ?? acteur.id;
  return prisma.$transaction(async (tx) => {
    // Verrou du projet (delais cote base) : la derogation est verifiee contre l'etat des jeux au moment ou elle est accordee.
    await verrouillerProjet(tx, projetId);
    const trouves = await tx.jeuDonneesProjet.findMany({ where: { projetId, id: { in: d.jeuxIds } }, select: { id: true, statut: true, confidentialite: true } });
    lever(verifierCreationDerogation({ demandes: d.jeuxIds, trouves: new Map(trouves.map((j) => [j.id, j])), justification: d.justification, dureeH, dureeMaxH: DEROGATION_DUREE_MAX_H }));
    const projet = await tx.projetVoirie.findUniqueOrThrow({ where: { id: projetId }, select: { regionId: true } });
    const b = await tx.user.findFirst({ where: { id: beneficiaireId }, select: { id: true, actif: true, role: true, modulesAutorises: true } });
    const perimetreCouvre = b ? verifierTerritoire(await perimetreDe({ id: b.id, role: b.role }), [projet.regionId]).ok : false;
    lever(verifierBeneficiaire(b ? { actif: b.actif, role: b.role, modules: b.modulesAutorises, perimetreCouvre } : null));
    const maintenant = new Date();
    const cree = await tx.derogationExportProjetVoirie.create({
      data: {
        id: randomUUID(), projetId, jeuxIds: d.jeuxIds, beneficiaireId, accordeeParId: acteur.id, justification: d.justification.trim(),
        createdAt: maintenant, expireLe: new Date(maintenant.getTime() + dureeH * 3_600_000),
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "DerogationExportProjetVoirie", entityId: cree.id,
      after: {
        projetId, jeux: trouves.map((j) => ({ jeuId: j.id, confidentialite: j.confidentialite })), beneficiaireId, expireLe: cree.expireLe,
        justification: cree.justification, usageUnique: true,
      },
      ipAddress: acteur.ip,
    });
    const us = await tx.user.findMany({ where: { id: { in: [beneficiaireId, acteur.id] } }, select: { id: true, nomComplet: true } });
    return { derogation: vue(cree, new Map(us.map((u) => [u.id, u])), maintenant) };
  }, { timeout: 30_000, maxWait: 10_000 });
}

export async function listerDerogations(projetId: string) {
  await exigerProjetActif(projetId);
  const lignes = await prisma.derogationExportProjetVoirie.findMany({ where: { projetId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
  const ids = [...new Set(lignes.flatMap((l) => [l.beneficiaireId, l.accordeeParId]))];
  const us = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, nomComplet: true } }) : [];
  const maintenant = new Date();
  return { derogations: lignes.map((l) => vue(l, new Map(us.map((u) => [u.id, u])), maintenant)) };
}
