/**
 * REVUE DES SUPPRESSIONS, DELTA DETAILLE ET RETOUR ARRIERE d'une version (lot A1). Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, sections 8 et 9.
 *
 * REGLES : les suppressions d'une nouvelle version ne sont JAMAIS appliquees sans revue humaine, auditee et justifiee ; un retour arriere remet
 * la version precedente comme AUTORISE par une action auditee, SANS PERTE (aucun jeu, objet ni decision n'est supprime). Chaque ecriture est
 * auditee dans la transaction qui la porte (un echec d'audit annule l'ecriture). Aucune ecriture hors des tables du module et d'`audit_logs`.
 */

import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { avecErreurDelai, poserDelais } from "../bd";
import { delaiVerrouMs } from "../config";
import { ErreurMetier, introuvable } from "../erreurs";
import { verrouillerProjet, type Acteur, type Tx } from "../projets.service";
import { INCLURE_JEU, vueJeu } from "../vues";
import { limiteurApercus } from "./apercu.service";
import { delaiApercuMs } from "./import.config";
import { colonneIdentifiant, deltaEntreJeux, jeuDeReferenceSuppressions, statutSuppressions } from "./versions.depot";
import { filtreCleVersion } from "../sources/cle-version.noyau";


type JeuLigne = NonNullable<Awaited<ReturnType<Tx["jeuDonneesProjet"]["findFirst"]>>>;

async function jeuDuProjet(tx: Tx, projetId: string, jeuId: string): Promise<JeuLigne> {
  const j = await tx.jeuDonneesProjet.findFirst({ where: { id: jeuId, projetId } });
  if (!j) throw introuvable("Jeu de données", "JEU_INTROUVABLE");
  return j;
}

export type RaisonRetourArriere = "AUCUNE_VERSION_PRECEDENTE" | "VERSION_PRECEDENTE_INDISPONIBLE" | "DEPOT_EN_ATTENTE";

export interface EvaluationRetour {
  possible: boolean;
  raison: RaisonRetourArriere | null;
  restaureraJeuId: string | null;
  restaureraVersion: number | null;
  /** Dépôt qui attend, le cas échéant. */
  depotEnAttenteId: string | null;
}

/** Peut-on remettre la version precedente de `jeu` (qui doit etre AUTORISE) ? */
async function evaluerRetourArriere(tx: Tx, jeu: JeuLigne): Promise<EvaluationRetour> {
  const non = (raison: RaisonRetourArriere, extra: Partial<EvaluationRetour> = {}): EvaluationRetour => ({ possible: false, raison, restaureraJeuId: null, restaureraVersion: null, depotEnAttenteId: null, ...extra });
  if (!jeu.remplaceId) return non("AUCUNE_VERSION_PRECEDENTE");
  const precedent = await tx.jeuDonneesProjet.findFirst({ where: { id: jeu.remplaceId, projetId: jeu.projetId }, select: { id: true, version: true, statut: true } });
  if (!precedent || precedent.statut !== "REMPLACE") return non("VERSION_PRECEDENTE_INDISPONIBLE");
  const attente = jeu.role === "AUTRE" ? null : await tx.jeuDonneesProjet.findFirst({
    where: { ...filtreCleVersion(jeu), statut: { in: ["RECU", "CONTROLE"] } }, select: { id: true },
  });
  if (attente) return non("DEPOT_EN_ATTENTE", { restaureraJeuId: precedent.id, restaureraVersion: precedent.version, depotEnAttenteId: attente.id });
  return { possible: true, raison: null, restaureraJeuId: precedent.id, restaureraVersion: precedent.version, depotEnAttenteId: null };
}

const MESSAGES_RETOUR: Record<RaisonRetourArriere, string> = {
  AUCUNE_VERSION_PRECEDENTE: "Ce jeu ne remplaçait aucune version : il n'y a rien à remettre en service.",
  VERSION_PRECEDENTE_INDISPONIBLE: "La version précédente n'est plus disponible (retirée) : le retour arrière est impossible.",
  DEPOT_EN_ATTENTE: "Un dépôt de même rôle et de même concessionnaire attend son autorisation : autorisez-le, rejetez-le ou retirez-le d'abord.",
};

// ------------------------------------------------------------------------------------------------ Lecture du delta

export async function lireDelta(projetId: string, jeuId: string) {
  const delai = delaiApercuMs();
  const message = `Le calcul du delta a depasse ${Math.round(delai / 1000)} s et a ete interrompu.`;
  return limiteurApercus.executer(() => avecErreurDelai("APERCU_TROP_LONG", message, () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await poserDelais(tx, delai, delaiVerrouMs());
    const jeu = await tx.jeuDonneesProjet.findFirst({ where: { id: jeuId, projetId, statut: { not: "RETIRE" } } });
    if (!jeu) throw introuvable("Jeu de données", "JEU_INTROUVABLE");

    // Le jeu compare est celui que ce depot remplace (remplaceId) ; un jeu retire n'est montre a personne.
    const ancien = jeu.remplaceId
      ? await tx.jeuDonneesProjet.findFirst({ where: { id: jeu.remplaceId, projetId, statut: { not: "RETIRE" } }, select: { id: true, version: true, statut: true, resume: true } })
      : null;
    const delta = ancien ? await deltaEntreJeux(tx, { id: jeu.id, colonneId: colonneIdentifiant(jeu.resume) }, ancien) : null;
    // Le statut des suppressions d'un depot en attente se lit contre la MEME reference que l'autorisation (M1) : le jeu autorise de meme cle, a defaut
    // le jeu que ce depot devait remplacer, meme retire depuis. Un jeu retire n'est pas montre : seul le nombre d'objets retires l'est (aux decideurs).
    let deltaSuppressions = delta;
    if (jeu.statut === "CONTROLE" || jeu.statut === "RECU") {
      const reference = await jeuDeReferenceSuppressions(tx, jeu);
      if (reference && reference.id !== ancien?.id) deltaSuppressions = await deltaEntreJeux(tx, { id: jeu.id, colonneId: colonneIdentifiant(jeu.resume) }, reference);
    }
    const s = await statutSuppressions(tx, jeu.id, deltaSuppressions);

    const evenements = await tx.evenementImportProjet.findMany({
      where: { projetId, OR: [{ jeuId: jeu.id }, { jeuLieId: jeu.id }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200,
    });
    const acteurs = evenements.length
      ? await tx.user.findMany({ where: { id: { in: [...new Set(evenements.map((e) => e.acteurId))] } }, select: { id: true, nomComplet: true } })
      : [];
    const retour = jeu.statut === "AUTORISE" ? await evaluerRetourArriere(tx, jeu) : null;

    return {
      jeu: { id: jeu.id, version: jeu.version, statut: jeu.statut, role: jeu.role },
      comparaison: ancien ? { jeuId: ancien.id, version: ancien.version, statut: ancien.statut } : null,
      delta: delta ? { ajoutes: delta.ajoutes, modifies: delta.modifies, retires: delta.retires, identiques: delta.identiques } : null,
      cleComparaison: delta ? delta.cleComparaison : null,
      clesAmbigues: delta ? delta.clesAmbigues : 0,
      echantillons: delta ? delta.echantillons : { ajoutes: [], modifies: [], retires: [] },
      suppressions: { statut: s.statut, nb: s.nb, revue: s.revue },
      retourArriere: retour ? { possible: retour.possible, raison: retour.raison, restaureraJeuId: retour.restaureraJeuId, restaureraVersion: retour.restaureraVersion } : null,
      evenements: evenements.map((e) => ({
        id: e.id, type: e.type, jeuId: e.jeuId, jeuLieId: e.jeuLieId, par: acteurs.find((a) => a.id === e.acteurId) ?? null, le: e.createdAt,
        justification: e.justification, details: e.details,
      })),
    };
  }, { timeout: delai + 10_000, maxWait: 15_000 })));
}

// ------------------------------------------------------------------------------------------------ Revue des suppressions

export type DecisionRevue = "ACCEPTER" | "REFUSER";

export async function revueSuppressions(acteur: Acteur, projetId: string, jeuId: string, decision: DecisionRevue, justification: string) {
  const texte = justification.trim();
  if (texte.length < 10) throw new ErreurMetier(400, "JUSTIFICATION_INVALIDE", "La justification doit comporter 10 caractères au moins.");
  return prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const jeu = await jeuDuProjet(tx, projetId, jeuId);
    if (jeu.statut !== "CONTROLE" && jeu.statut !== "RECU") {
      throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", `Seul un jeu en contrôle peut faire l'objet d'une revue des suppressions (statut actuel : ${jeu.statut}).`, { statut: jeu.statut });
    }
    // Reference de la revue : le jeu autorise de meme cle, a defaut le jeu que ce depot devait remplacer, meme retire depuis (M1).
    const ancien = await jeuDeReferenceSuppressions(tx, jeu);
    const delta = ancien ? await deltaEntreJeux(tx, { id: jeu.id, colonneId: colonneIdentifiant(jeu.resume) }, ancien) : null;
    if (!ancien || !delta || delta.retires === 0) {
      throw new ErreurMetier(409, "AUCUNE_SUPPRESSION", "Cette version ne retire aucun objet de la version autorisée : il n'y a rien à revoir.", { jeuId: jeu.id });
    }
    // O1 : un refus de revue est DEFINITIF pour l'ensemble retire sur lequel il a porte (meme message que l'autorisation). Il ne se leve pas par
    // une acceptation ; il reste le rejet, le retrait, ou un fichier corrige (autre ensemble retire, donc revue a refaire). Refuser de nouveau reste permis.
    if (decision === "ACCEPTER" && (await statutSuppressions(tx, jeu.id, delta)).statut === "REFUSEES") {
      throw new ErreurMetier(409, "SUPPRESSIONS_REFUSEES", "La revue des suppressions de cette version est un refus : elle ne peut plus qu'être rejetée ou retirée, ou remplacée par un fichier corrigé.", { jeuId: jeu.id, nb: delta.retires });
    }
    const e = await tx.evenementImportProjet.create({
      data: {
        projetId, jeuId: jeu.id, type: decision === "ACCEPTER" ? "SUPPRESSIONS_ACCEPTEES" : "SUPPRESSIONS_REFUSEES", acteurId: acteur.id, justification: texte,
        details: { decision, nb: delta.retires, empreinteDelta: delta.empreinteRetires, jeuComparaisonId: ancien.id, versionComparee: ancien.version, statutComparaison: ancien.statut, delta: { ajoutes: delta.ajoutes, modifies: delta.modifies, retires: delta.retires, identiques: delta.identiques } },
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: decision === "ACCEPTER" ? "VALIDATE" : "REJECT", entityType: "JeuDonneesProjet", entityId: jeu.id,
      before: { suppressions: "A_REVOIR" },
      after: {
        revueSuppressions: decision, nb: delta.retires, justification: texte, jeuComparaisonId: ancien.id, versionComparee: ancien.version,
        memePersonne: jeu.creeParId === acteur.id, version: jeu.version, evenementId: e.id,
      },
      ipAddress: acteur.ip,
    });
    const apres = await tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id: jeu.id }, include: INCLURE_JEU });
    const s = await statutSuppressions(tx, jeu.id, delta);
    return {
      jeu: vueJeu(apres),
      suppressions: { statut: s.statut, nb: s.nb, revue: s.revue },
      evenement: { id: e.id, type: e.type, le: e.createdAt, justification: e.justification },
    };
  });
}

// ------------------------------------------------------------------------------------------------ Retour arriere

export async function retourArriere(acteur: Acteur, projetId: string, jeuId: string, justification: string) {
  const texte = justification.trim();
  if (texte.length < 10) throw new ErreurMetier(400, "JUSTIFICATION_INVALIDE", "La justification doit comporter 10 caractères au moins.");
  return prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const jeu = await jeuDuProjet(tx, projetId, jeuId);
    if (jeu.statut !== "AUTORISE") {
      throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", `Seul le jeu actuellement autorisé peut faire l'objet d'un retour arrière (statut actuel : ${jeu.statut}).`, { statut: jeu.statut });
    }
    const ev = await evaluerRetourArriere(tx, jeu);
    if (!ev.possible || !ev.restaureraJeuId) {
      throw new ErreurMetier(409, ev.raison!, MESSAGES_RETOUR[ev.raison!], ev.depotEnAttenteId ? { jeuId: ev.depotEnAttenteId } : {});
    }
    // Le jeu actuel passe REMPLACE AVANT que le precedent redevienne AUTORISE (index unique partiel : un seul AUTORISE par cle).
    await tx.jeuDonneesProjet.update({ where: { id: jeu.id }, data: { statut: "REMPLACE" } });
    await tx.jeuDonneesProjet.update({ where: { id: ev.restaureraJeuId }, data: { statut: "AUTORISE" } });
    const e = await tx.evenementImportProjet.create({
      data: {
        projetId, jeuId: jeu.id, jeuLieId: ev.restaureraJeuId, type: "RETOUR_ARRIERE", acteurId: acteur.id, justification: texte,
        details: { versionRetiree: jeu.version, versionRestauree: ev.restaureraVersion },
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "RESTORE", entityType: "JeuDonneesProjet", entityId: ev.restaureraJeuId,
      before: { statut: "REMPLACE" }, after: { statut: "AUTORISE", retourArriereDepuis: jeu.id, versionRestauree: ev.restaureraVersion, versionRetiree: jeu.version, justification: texte, evenementId: e.id },
      ipAddress: acteur.ip,
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "UPDATE", entityType: "JeuDonneesProjet", entityId: jeu.id,
      before: { statut: "AUTORISE", version: jeu.version }, after: { statut: "REMPLACE", retourArriereVers: ev.restaureraJeuId, justification: texte, evenementId: e.id },
      ipAddress: acteur.ip,
    });
    const [restaure, retire] = await Promise.all([
      tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id: ev.restaureraJeuId }, include: INCLURE_JEU }),
      tx.jeuDonneesProjet.findUniqueOrThrow({ where: { id: jeu.id }, include: INCLURE_JEU }),
    ]);
    return {
      jeuRestaure: vueJeu(restaure), jeuRetire: vueJeu(retire),
      evenement: { id: e.id, type: e.type, le: e.createdAt, justification: e.justification },
    };
  });
}
