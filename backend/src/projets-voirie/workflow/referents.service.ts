/**
 * REFERENTS CONCESSIONNAIRES : rattachement d'un compte a un concessionnaire pour un projet, et profil de workflow d'un compte
 * (contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, sections 2, 3 et 6).
 *
 * Un referent n'est PAS un role : c'est un compte LECTEUR qui porte la cle de module `projets-voirie` et un RATTACHEMENT pose par un ADMIN.
 * Le rattachement se revoque, ne se supprime pas. L'acteur d'une requete est resolu ICI (relu en base a chaque requete, comme le role et les
 * modules : un rattachement revoque s'applique a la requete suivante).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { perimetreDe } from "../../territoire/territoire.service";
import { logAuditTransactionnelle } from "../../utils/audit";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur } from "../projets.service";
import { exigerProjetActif, lever, nomsDe, personneDe, transactionProjet, type ActeurWorkflow, type Rattachement } from "./communs";
import { matriceEffective } from "./config";
import { ACTIONS, CORRESPONDANCE_CAHIER, DROITS_SOCLE, droitsDe, profilEffectif } from "./profils.noyau";
import { exigerJustification } from "./validation.noyau";

/** Rattachements ACTIFS d'un compte (tous projets). Un ADMIN n'est jamais referent : aucune lecture. */
export async function rattachementsActifs(userId: string, role: string): Promise<Rattachement[]> {
  if (role === "ADMIN") return [];
  const l = await prisma.referentConcessionnaire.findMany({ where: { userId, revoqueLe: null }, select: { id: true, projetId: true, concessionnaireId: true } });
  return l ?? [];
}

/** Acteur du workflow : profil effectif et rattachements, lus en base pour CETTE requete. */
export async function resoudreActeur(base: Acteur): Promise<ActeurWorkflow> {
  const rattachements = await rattachementsActifs(base.id, base.role);
  return { ...base, referent: rattachements.length > 0, rattachements, profil: profilEffectif(base.role, rattachements.length > 0) };
}

const vueRattachement = (r: Prisma.ReferentConcessionnaireGetPayload<object>, noms: Awaited<ReturnType<typeof nomsDe>>, conc: Map<string, string>) => ({
  id: r.id, projetId: r.projetId,
  compte: personneDe(noms, r.userId), concessionnaire: { id: r.concessionnaireId, nom: conc.get(r.concessionnaireId) ?? "" },
  motif: r.motif, creePar: personneDe(noms, r.creeParId), createdAt: r.createdAt,
  actif: r.revoqueLe === null,
  revocation: r.revoqueLe ? { le: r.revoqueLe, par: personneDe(noms, r.revoqueParId), motif: r.motifRevocation } : null,
});

async function nomsConcessionnaires(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const l = await prisma.concessionnaireReseau.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, nom: true } });
  return new Map(l.map((c) => [c.id, c.nom]));
}

export async function listerReferents(projetId: string) {
  await exigerProjetActif(projetId);
  const l = await prisma.referentConcessionnaire.findMany({ where: { projetId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 500 });
  const [noms, conc] = await Promise.all([nomsDe(l.flatMap((r) => [r.userId, r.creeParId, r.revoqueParId])), nomsConcessionnaires(l.map((r) => r.concessionnaireId))]);
  return { rattachements: l.map((r) => vueRattachement(r, noms, conc)) };
}

export async function creerRattachement(acteur: ActeurWorkflow, projetId: string, d: { userId: string; concessionnaireId: string; motif: string }) {
  lever(exigerJustification(d.motif, "Un motif") ?? { ok: true });
  return transactionProjet(projetId, async (tx) => {
    const u = await tx.user.findUnique({ where: { id: d.userId }, select: { id: true, actif: true, role: true, modulesAutorises: true } });
    if (!u) throw new ErreurMetier(400, "COMPTE_INCONNU", "Le compte désigné n'existe pas.");
    if (!u.actif || u.role !== "LECTEUR") {
      throw new ErreurMetier(422, "COMPTE_NON_ELIGIBLE", "Un référent concessionnaire est un compte actif de rôle LECTEUR (jamais un compte qui écrit dans le socle).");
    }
    if (!u.modulesAutorises.includes("projets-voirie")) {
      throw new ErreurMetier(422, "COMPTE_SANS_MODULE", "Le compte n'a pas la clé de module projets-voirie : attribuez-la d'abord (geste d'administration séparé).");
    }
    const c = await tx.concessionnaireReseau.findFirst({ where: { id: d.concessionnaireId, deletedAt: null }, select: { id: true, nom: true } });
    if (!c) throw introuvable("Concessionnaire", "CONCESSIONNAIRE_INTROUVABLE");
    const actif = await tx.referentConcessionnaire.findFirst({ where: { userId: d.userId, projetId, concessionnaireId: d.concessionnaireId, revoqueLe: null }, select: { id: true } });
    if (actif) throw new ErreurMetier(409, "RATTACHEMENT_DEJA_ACTIF", "Ce compte est déjà référent de ce concessionnaire sur ce projet.", { rattachementId: actif.id });
    const r = await tx.referentConcessionnaire.create({ data: { userId: d.userId, concessionnaireId: d.concessionnaireId, projetId, creeParId: acteur.id, motif: d.motif.trim() } });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "ReferentConcessionnaire", entityId: r.id,
      after: { compteId: d.userId, concessionnaireId: d.concessionnaireId, projetId, motif: r.motif }, ipAddress: acteur.ip,
    });
    const noms = await nomsDe([r.userId, r.creeParId]);
    return { rattachement: vueRattachement(r, noms, new Map([[c.id, c.nom]])) };
  });
}

export async function revoquerRattachement(acteur: ActeurWorkflow, projetId: string, rid: string, d: { motif: string }) {
  lever(exigerJustification(d.motif, "Un motif") ?? { ok: true });
  return transactionProjet(projetId, async (tx) => {
    const r = await tx.referentConcessionnaire.findFirst({ where: { id: rid, projetId } });
    if (!r) throw introuvable("Rattachement", "RATTACHEMENT_INTROUVABLE");
    if (r.revoqueLe) throw new ErreurMetier(409, "RATTACHEMENT_DEJA_REVOQUE", "Ce rattachement est déjà révoqué.");
    const apres = await tx.referentConcessionnaire.update({ where: { id: rid }, data: { revoqueLe: new Date(), revoqueParId: acteur.id, motifRevocation: d.motif.trim() } });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "UPDATE", entityType: "ReferentConcessionnaire", entityId: rid,
      before: { actif: true }, after: { actif: false, motif: apres.motifRevocation, compteId: r.userId, concessionnaireId: r.concessionnaireId, projetId }, ipAddress: acteur.ip,
    });
    // Le compte redevient un lecteur ordinaire du socle s'il n'a plus aucun rattachement et garde la cle de module : on le dit.
    const restants = await tx.referentConcessionnaire.count({ where: { userId: r.userId, revoqueLe: null } });
    const u = await tx.user.findUnique({ where: { id: r.userId }, select: { modulesAutorises: true } });
    const avertissements: string[] = [];
    if (restants === 0 && u?.modulesAutorises.includes("projets-voirie")) {
      avertissements.push("Ce compte n'a plus aucun rattachement mais garde la clé de module projets-voirie : il redevient un lecteur ordinaire du socle (jeux autorisés de son périmètre). Retirez-lui la clé de module pour couper l'accès.");
    }
    const [noms, conc] = await Promise.all([nomsDe([apres.userId, apres.creeParId, apres.revoqueParId]), nomsConcessionnaires([apres.concessionnaireId])]);
    return { rattachement: vueRattachement(apres, noms, conc), avertissements };
  });
}

/** `GET /workflow/mon-profil` : ce que le compte est, pour le workflow, et ce qu'il peut y faire. Rien de sensible : pas de donnee de jeu. */
export async function monProfil(acteur: ActeurWorkflow) {
  const { matrice, avertissements } = matriceEffective();
  let rattachements: { id: string; projet: { id: string; code: string; nom: string }; concessionnaire: { id: string; nom: string } }[] = [];
  if (acteur.rattachements.length > 0) {
    const [projets, conc, p] = await Promise.all([
      prisma.projetVoirie.findMany({ where: { id: { in: [...new Set(acteur.rattachements.map((r) => r.projetId))] }, deletedAt: null }, select: { id: true, code: true, nom: true, regionId: true } }),
      nomsConcessionnaires(acteur.rattachements.map((r) => r.concessionnaireId)),
      perimetreDe(acteur),
    ]);
    // Meme regle que le socle : un projet sans region n'est visible que des comptes nationaux ; un projet d'une region, des comptes de cette region.
    const visibles = new Map(projets.filter((x) => p.national || (x.regionId !== null && p.regions.has(x.regionId))).map((x) => [x.id, x]));
    rattachements = acteur.rattachements.filter((r) => visibles.has(r.projetId)).map((r) => {
      const x = visibles.get(r.projetId)!;
      return { id: r.id, projet: { id: x.id, code: x.code, nom: x.nom }, concessionnaire: { id: r.concessionnaireId, nom: conc.get(r.concessionnaireId) ?? "" } };
    });
  }
  return {
    role: acteur.role, profil: acteur.profil, referent: acteur.referent, rattachements,
    droits: droitsDe(matrice, acteur.profil),
    matrice: Object.fromEntries(ACTIONS.map((a) => [a, [...matrice[a]]])),
    socle: DROITS_SOCLE, correspondanceCahier: CORRESPONDANCE_CAHIER, provisoire: true, avertissements,
  };
}
