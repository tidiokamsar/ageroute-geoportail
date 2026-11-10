/**
 * DEROGATIONS DE CONFIDENTIALITE DE L'EXPORT (lot X1 ; contrat CONTRAT-EXPORTS.md, section 5). ADMIN seul (la route l'impose). Une derogation est
 * nominative (beneficiaire OBLIGATOIRE et different de l'ADMIN qui l'accorde : separation des taches, revue du lot X1, M2), justifiee, bornee dans le
 * temps, a usage unique ; elle ne couvre que des jeux AUTORISE d'un niveau sensible du projet.
 * Creation auditee dans sa transaction ; reservation et consommation : dossier.service.ts. Aucune modification ni suppression (declencheurs).
 * Horloge : celle de la BASE seulement (creation, expiration, etat ; revue du lot X1, m4).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { perimetreDe } from "../../territoire/territoire.service";
import { verifierTerritoire } from "../../territoire/territoire.noyau";
import { exigerProjetActif } from "../conflits/dossiers.service";
import { ErreurMetier } from "../erreurs";
import { verrouillerProjet, type Acteur, type Tx } from "../projets.service";
import { DEROGATION_DUREE_MAX_H, derogationDureeH, reservationPerimeeS } from "./config";
import { etatDerogation, verifierBeneficiaire, verifierCreationDerogation, type DerogationLue, type Verdict } from "./confidentialite.noyau";

const lever = (v: Verdict): void => { if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message, v.extra); };

export interface DemandeDerogation { jeuxIds: string[]; justification: string; beneficiaireId: string; dureeHeures?: number }

interface LigneDerogation {
  id: string; projetId: string; jeuxIds: string[]; beneficiaireId: string; accordeeParId: string; justification: string; createdAt: Date; expireLe: Date;
  utiliseeLe: Date | null; exportId: string | null; expiree: boolean; reserveeActive: boolean;
}

/** Derogations lues avec leur etat calcule PAR LA BASE (expiration, reservation par une tentative EN_COURS encore dans son delai). */
export async function lireDerogations(lecteur: Pick<Tx, "$queryRaw">, filtre: { id?: string; projetId?: string; beneficiaireId?: string }): Promise<LigneDerogation[]> {
  return lecteur.$queryRaw<LigneDerogation[]>`
    SELECT d."id", d."projetId", d."jeuxIds", d."beneficiaireId", d."accordeeParId", d."justification", d."createdAt", d."expireLe", d."utiliseeLe", d."exportId",
           d."expireLe" <= (now() AT TIME ZONE 'UTC') AS "expiree",
           (d."utiliseeLe" IS NULL AND e."id" IS NOT NULL AND e."statut" = 'EN_COURS'
             AND e."createdAt" > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${reservationPerimeeS()}::int)) AS "reserveeActive"
      FROM "derogations_export_projet_voirie" d LEFT JOIN "exports_dossier_projet_voirie" e ON e."id" = d."exportId"
     WHERE (${filtre.id ?? null}::text IS NULL OR d."id" = ${filtre.id ?? null}::text)
       AND (${filtre.projetId ?? null}::text IS NULL OR d."projetId" = ${filtre.projetId ?? null}::text)
       AND (${filtre.beneficiaireId ?? null}::text IS NULL OR d."beneficiaireId" = ${filtre.beneficiaireId ?? null}::text)
     ORDER BY d."createdAt" DESC, d."id" DESC LIMIT 100`;
}

export const versLue = (l: LigneDerogation): DerogationLue => ({
  id: l.id, projetId: l.projetId, beneficiaireId: l.beneficiaireId, jeuxIds: l.jeuxIds, utilisee: l.utiliseeLe !== null, expiree: l.expiree, reserveeActive: l.reserveeActive,
});

function vue(d: LigneDerogation, personnes: Map<string, { id: string; nomComplet: string }>) {
  const p = (id: string) => personnes.get(id) ?? { id, nomComplet: null };
  return {
    id: d.id, projetId: d.projetId, jeuxIds: d.jeuxIds, beneficiaire: p(d.beneficiaireId), accordeePar: p(d.accordeeParId), justification: d.justification,
    createdAt: d.createdAt, expireLe: d.expireLe, utiliseeLe: d.utiliseeLe, exportId: d.exportId, etat: etatDerogation(versLue(d)),
  };
}

export async function creerDerogation(acteur: Acteur, projetId: string, d: DemandeDerogation) {
  const dureeH = d.dureeHeures ?? derogationDureeH();
  return prisma.$transaction(async (tx) => {
    // Verrou du projet (delais cote base) : la derogation est verifiee contre l'etat des jeux au moment ou elle est accordee.
    await verrouillerProjet(tx, projetId);
    const trouves = await tx.jeuDonneesProjet.findMany({ where: { projetId, id: { in: d.jeuxIds } }, select: { id: true, statut: true, confidentialite: true } });
    lever(verifierCreationDerogation({ demandes: d.jeuxIds, trouves: new Map(trouves.map((j) => [j.id, j])), justification: d.justification, dureeH, dureeMaxH: DEROGATION_DUREE_MAX_H }));
    const projet = await tx.projetVoirie.findUniqueOrThrow({ where: { id: projetId }, select: { regionId: true } });
    const b = await tx.user.findFirst({ where: { id: d.beneficiaireId }, select: { id: true, actif: true, role: true, modulesAutorises: true } });
    const perimetreCouvre = b ? verifierTerritoire(await perimetreDe({ id: b.id, role: b.role }), [projet.regionId]).ok : false;
    lever(verifierBeneficiaire(b ? { actif: b.actif, role: b.role, modules: b.modulesAutorises, perimetreCouvre } : null, { estAuteur: d.beneficiaireId === acteur.id }));
    // Dates de la BASE (le declencheur refuse une date de creation eloignee de son horloge).
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "derogations_export_projet_voirie" ("id", "projetId", "jeuxIds", "beneficiaireId", "accordeeParId", "justification", "createdAt", "expireLe")
      VALUES (${id}, ${projetId}, ${d.jeuxIds}::text[], ${d.beneficiaireId}, ${acteur.id}, ${d.justification.trim()},
              (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + make_interval(hours => ${dureeH}::int))`;
    const [cree] = await lireDerogations(tx, { id });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "DerogationExportProjetVoirie", entityId: id,
      after: {
        projetId, jeux: trouves.map((j) => ({ jeuId: j.id, confidentialite: j.confidentialite })), beneficiaireId: d.beneficiaireId, expireLe: cree.expireLe,
        justification: cree.justification, usageUnique: true, separationDesTaches: true,
      },
      ipAddress: acteur.ip,
    });
    const us = await tx.user.findMany({ where: { id: { in: [d.beneficiaireId, acteur.id] } }, select: { id: true, nomComplet: true } });
    return { derogation: vue(cree, new Map(us.map((u) => [u.id, u]))) };
  }, { timeout: 30_000, maxWait: 10_000 }).catch((e: unknown) => {
    // Contrainte de la base (separation des taches, duree) : erreur typee, jamais un 500 (la verification du service la precede).
    const texte = e instanceof Error ? e.message : String(e);
    if (/dxpv_separation/.test(texte)) throw new ErreurMetier(409, "SEPARATION_DES_TACHES", "Le bénéficiaire d'une dérogation est une autre personne que l'administrateur qui l'accorde.");
    throw e;
  });
}

export async function listerDerogations(projetId: string) {
  await exigerProjetActif(projetId);
  const lignes = await lireDerogations(prisma, { projetId });
  const ids = [...new Set(lignes.flatMap((l) => [l.beneficiaireId, l.accordeeParId]))];
  const us = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, nomComplet: true } }) : [];
  return { derogations: lignes.map((l) => vue(l, new Map(us.map((u) => [u.id, u])))) };
}

/**
 * Derogations qui designent le compte appelant comme beneficiaire, sur ce projet (ecart E1 du lot UI-D) : un GESTIONNAIRE beneficiaire voit
 * enfin ce qui lui est accorde, sans acces a la liste ADMIN des autres derogations. Lecture seule, aucune ecriture ni audit (comme la liste ADMIN).
 */
export async function listerMesDerogations(acteur: Acteur, projetId: string) {
  await exigerProjetActif(projetId);
  const lignes = await lireDerogations(prisma, { projetId, beneficiaireId: acteur.id });
  const ids = [...new Set(lignes.flatMap((l) => [l.beneficiaireId, l.accordeeParId]))];
  const us = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, nomComplet: true } }) : [];
  return { derogations: lignes.map((l) => vue(l, new Map(us.map((u) => [u.id, u])))) };
}
