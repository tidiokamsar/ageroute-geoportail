/**
 * PREUVES REFERENCEES du workflow : lecture (vue selon le profil) et ajout (ajout seul).
 *
 * REFERENCES ET EMPREINTES SEULEMENT : le stockage de pieces jointes n'est pas decide, aucun fichier n'est stocke ni lu. Une preuve est un texte
 * (description), une reference libre (numero de courrier, nom de plan, emplacement d'archive externe), un nom de fichier, une empreinte SHA-256 et
 * une taille declaree. Voir contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, 5.4.
 */

import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { ErreurMetier, introuvable } from "../erreurs";
import {
  ajouterHistorique, contexteDe, exigerQuota, nomsDe, personneDe, transactionProjet, verifierCadence, type ActeurWorkflow, type Tx,
} from "./communs";
import { matriceEffective, preuvesParObjetMax } from "./config";
import { autorise } from "./profils.noyau";
import { evaluerAjoutPreuve, validerChampsPreuve, type ChampsPreuve, type TypeObjet, type TypePreuveWorkflow } from "./preuves.noyau";
import { filtreDemandes, filtreRecolements, filtreTaches, ligneVisible, preuveVisible, sorteDe, type ContexteLecture } from "./visibilite.noyau";

export const ENTITE_AUDIT: Record<TypeObjet, string> = { DEMANDE: "DemandeConcessionnaire", TACHE: "TacheProjetVoirie", RECOLEMENT: "RecolementProjetVoirie" };
const CODE_INTROUVABLE: Record<TypeObjet, [string, string]> = { DEMANDE: ["Demande", "DEMANDE_INTROUVABLE"], TACHE: ["Tâche", "TACHE_INTROUVABLE"], RECOLEMENT: ["Récolement", "RECOLEMENT_INTROUVABLE"] };

/** Preuves d'un objet, filtrees selon le profil (un decideur lit tout ; les autres, les preuves partagees). Le nom de l'auteur est reserve aux decideurs et a l'auteur. */
export async function lirePreuves(acteur: ActeurWorkflow, ctx: ContexteLecture, objetType: TypeObjet, objetId: string) {
  const l = await prisma.preuveWorkflowProjet.findMany({ where: { objetType, objetId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1000 });
  // Un agent de terrain (et tout auteur) relit ses propres preuves, meme internes.
  const visibles = l.filter((p) => preuveVisible(ctx, p) || p.auteurId === acteur.id);
  const noms = await nomsDe(visibles.map((p) => p.auteurId));
  const decideur = sorteDe(ctx) === "DECIDEUR";
  return visibles.map((p) => ({
    id: p.id, objetType: p.objetType, objetId: p.objetId, type: p.type, texte: p.texte, reference: p.reference, nomFichier: p.nomFichier, sha256: p.sha256,
    tailleOctets: p.tailleOctets, partagee: p.partagee, auteur: decideur || p.auteurId === acteur.id ? personneDe(noms, p.auteurId) : null, auteurProfil: p.auteurProfil, createdAt: p.createdAt,
  }));
}

export interface CorpsPreuve extends ChampsPreuve { type: TypePreuveWorkflow; partagee?: boolean }

interface CibleLue { statut: string; responsableId: string | null; concessionnaireId: string | null; conflitId: string | null; partage: boolean }

/** Lit l'objet cible dans le projet. Introuvable, ou invisible pour le profil : la MEME 404 (rien ne revele l'existence d'un element d'autrui). */
async function lireCible(tx: Tx, acteur: ActeurWorkflow, projetId: string, objetType: TypeObjet, objetId: string): Promise<CibleLue> {
  const ctx = contexteDe(acteur, projetId);
  const [libelle, code] = CODE_INTROUVABLE[objetType];
  let c: CibleLue | null = null;
  let visible = false;
  if (objetType === "DEMANDE") {
    const d = await tx.demandeConcessionnaire.findFirst({ where: { id: objetId, projetId } });
    if (d) { c = { statut: d.statut, responsableId: null, concessionnaireId: d.concessionnaireId, conflitId: null, partage: d.envoyeLe !== null }; visible = ligneVisible(filtreDemandes(ctx), c); }
  } else if (objetType === "TACHE") {
    const t = await tx.tacheProjetVoirie.findFirst({ where: { id: objetId, projetId } });
    if (t) {
      c = { statut: t.statut, responsableId: t.responsableId, concessionnaireId: t.concessionnaireId, conflitId: t.conflitId, partage: t.partagee };
      // Meme regle que la lecture d'une tache (taches.service.ts) : le filtre de projet pour qui lit le workflow ; un agent de terrain, ses propres taches.
      const lecteur = autorise(matriceEffective().matrice, "workflow.lire", acteur.profil);
      visible = (lecteur && ligneVisible(filtreTaches(ctx), c)) || (acteur.profil === "INSPECTEUR" && t.responsableId === acteur.id);
    }
  } else {
    const r = await tx.recolementProjetVoirie.findFirst({ where: { id: objetId, projetId } });
    if (r) { c = { statut: r.statut, responsableId: null, concessionnaireId: r.concessionnaireId, conflitId: r.conflitId, partage: r.statut !== "BROUILLON" }; visible = ligneVisible(filtreRecolements(ctx), c); }
  }
  // Un compte qui ne fait que lire (observateur) ne voit pas l'objet mais n'a de toute facon pas `preuve.ajouter` : la garde de route l'a deja refuse.
  if (!c || !visible) throw introuvable(libelle, code);
  return c;
}

export async function ajouterPreuve(acteur: ActeurWorkflow, projetId: string, objetType: TypeObjet, objetId: string, corps: CorpsPreuve) {
  return transactionProjet(projetId, async (tx) => {
    const cible = await lireCible(tx, acteur, projetId, objetType, objetId);
    const peutAjouter = autorise(matriceEffective().matrice, "preuve.ajouter", acteur.profil);
    const v = evaluerAjoutPreuve({
      profil: acteur.profil, peutAjouter, acteurId: acteur.id, cible: { type: objetType, statut: cible.statut, responsableId: cible.responsableId },
      typePreuve: corps.type, partageeDemandee: corps.partagee,
    });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
    const champs = validerChampsPreuve(corps);
    if (!champs.ok) throw new ErreurMetier(champs.status, champs.code, champs.message);
    exigerQuota(await tx.preuveWorkflowProjet.count({ where: { objetType, objetId } }), preuvesParObjetMax(), "preuves par élément");
    await verifierCadence(tx, acteur, projetId);
    const p = await tx.preuveWorkflowProjet.create({
      data: { projetId, objetType, objetId, type: corps.type, ...champs.valeurs, partagee: v.partagee, auteurId: acteur.id, auteurProfil: acteur.profil },
    });
    await ajouterHistorique(tx, acteur, { projetId, objetType, objetId, action: "PREUVE", donnees: { preuveId: p.id, type: p.type, partagee: p.partagee, sha256: p.sha256 } });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: ENTITE_AUDIT[objetType], entityId: objetId,
      after: { preuveId: p.id, type: p.type, partagee: p.partagee, sha256: p.sha256, nomFichier: p.nomFichier }, ipAddress: acteur.ip,
    });
    return {
      preuve: {
        id: p.id, objetType: p.objetType, objetId: p.objetId, type: p.type, texte: p.texte, reference: p.reference, nomFichier: p.nomFichier, sha256: p.sha256,
        tailleOctets: p.tailleOctets, partagee: p.partagee, auteur: personneDe(await nomsDe([acteur.id]), acteur.id), auteurProfil: p.auteurProfil, createdAt: p.createdAt,
      },
    };
  });
}
