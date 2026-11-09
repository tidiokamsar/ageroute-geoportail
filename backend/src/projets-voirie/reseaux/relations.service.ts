/**
 * RELATIONS ENTRE OBJETS (lot B1) : liste, declaration manuelle, validation, refus et revocation.
 *
 * REGLES (cahier v2, 20.1 et 20.3) :
 *   - une proximite geometrique ne prouve pas qu'un circuit est porte par une infrastructure : une relation AUTOMATIQUE naît PROPOSEE
 *     (voir associations.service.ts) et n'a d'effet qu'une fois VALIDEE par une personne identifiee, avec justification ;
 *   - une relation MANUELLE est deja une decision humaine : elle est creee VALIDEE, avec son auteur et sa justification ;
 *   - une relation ne se supprime pas : elle se revoque ; une proposition refusee n'est jamais reproposee ;
 *   - LISIBILITE : une relation n'existe pour un compte que si ses DEUX bouts sont lisibles (jeu RETIRE : a personne ; jeu non autorise :
 *     ADMIN et GESTIONNAIRE seulement) ; sinon 404 RELATION_INTROUVABLE ;
 *   - toute ecriture : une transaction qui verrouille le projet puis la relation, audit sans geometrie.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { ErreurMetier } from "../erreurs";
import { decoderCurseurConflit, encoderCurseurConflit } from "../conflits/curseurs.noyau";
import { jeuLisible } from "../conflits/visibilite.noyau";
import { estDecideur } from "../conflits/types.noyau";
import { verrouillerProjet, type Acteur } from "../projets.service";
import { tracerConsultation } from "../consultation";
import { jeuxConsultesParRelations } from "./consultation-reseau";
import {
  OBJET_INTROUVABLE, RELATION_INTROUVABLE, STATUTS_QUALIFIABLES, avecTraductionBase, exigerProjetActif, lireSousDelai, statutsLisibles,
} from "./commun";
import * as depot from "./reseaux.depot";
import { verifierRelation, verifierTransitionRelation, type ActionRelation } from "./relations.noyau";
import { JUSTIFICATION_MIN, natureEffective, type StatutRelation, type TypeRelation } from "./types.noyau";
import type { PreuveConnexion } from "../sources/types.noyau";
import { vueRelation } from "./vues";

export const decoderCurseurRelation = decoderCurseurConflit;

export interface FiltresRelationsService {
  statuts?: StatutRelation[]; type?: TypeRelation; objetId?: string; origine?: string; curseur?: { t: Date; i: string }; limite: number;
}

export async function listerRelationsProjet(acteur: Acteur, projetId: string, f: FiltresRelationsService) {
  await exigerProjetActif(projetId);
  const lignes = await lireSousDelai((tx) => depot.listerRelations(tx, {
    projetId, statutsJeu: statutsLisibles(acteur.role), statuts: f.statuts, type: f.type, objetId: f.objetId, origine: f.origine, curseur: f.curseur, limite: f.limite,
  }));
  const page = lignes.slice(0, f.limite);
  const dernier = page[page.length - 1];
  const decide = estDecideur(acteur.role);
  // m4 : la liste rend nom, nature, type et jeu des deux bouts : lecture tracee pour les jeux sensibles, AVANT la remise des donnees.
  await tracerConsultation(acteur, jeuxConsultesParRelations(page), { route: "reseau", bbox: null, zoom: null });
  return {
    relations: page.map((l) => vueRelation(l, decide)),
    curseurSuivant: lignes.length > f.limite && dernier ? encoderCurseurConflit({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}

const justificationOuErreur = (j: string): string => {
  const t = j.trim();
  if (t.length < JUSTIFICATION_MIN) throw new ErreurMetier(422, "JUSTIFICATION_REQUISE", `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise.`);
  return t;
};

export interface CorpsRelation {
  type: TypeRelation; sourceObjetId: string; cibleObjetId: string; justification: string;
  /** Lot S1 : preuve d une connexion (CONNECTE_A seulement, obligatoire pour ce type ; la route le verifie, la base aussi). */
  preuve?: PreuveConnexion | null;
}

/** Declaration MANUELLE : une personne affirme que `source` est porte par (ou contenu dans) `cible`. Creee VALIDEE. */
export async function declarerRelation(acteur: Acteur, projetId: string, c: CorpsRelation) {
  await exigerProjetActif(projetId);
  const justification = justificationOuErreur(c.justification);
  return avecTraductionBase(() => prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const s = await depot.lireObjet(tx, projetId, c.sourceObjetId);
    const k = await depot.lireObjet(tx, projetId, c.cibleObjetId);
    // Les deux objets doivent exister dans CE projet et etre lisibles par le compte : sinon le meme 404 (aucun sondage).
    if (!s || !k || !jeuLisible(acteur.role, s.statutJeu) || !jeuLisible(acteur.role, k.statutJeu)) throw OBJET_INTROUVABLE();
    for (const o of [s, k]) {
      if (!STATUTS_QUALIFIABLES.includes(o.statutJeu)) {
        throw new ErreurMetier(409, "JEU_NON_QUALIFIABLE", `Un objet d'un jeu ${o.statutJeu} ne se relie plus : seul un jeu en contrôle ou autorisé le permet.`, { statut: o.statutJeu, objetId: o.objetId });
      }
    }
    const ns = natureEffective(s.dNature, s.natureJeu).nature;
    const nk = natureEffective(k.dNature, k.natureJeu).nature;
    const verdict = verifierRelation(c.type, { nature: ns, typeGeom: s.typeGeom }, { nature: nk, typeGeom: k.typeGeom }, s.objetId === k.objetId);
    if (!verdict.ok) throw new ErreurMetier(422, verdict.code, verdict.message);

    const existante = await depot.relationDuCouple(tx, c.type, s.objetId, k.objetId);
    if (existante) {
      throw new ErreurMetier(409, "RELATION_DEJA_CONNUE", `Ce couple est déjà enregistré (statut ${existante.statut}) : utilisez la validation de la relation existante.`, { relationId: existante.id, statut: existante.statut });
    }
    const id = randomUUID();
    await depot.insererRelationManuelle(tx, { id, projetId, type: c.type, source: s.objetId, cible: k.objetId, justification, acteurId: acteur.id, preuve: c.type === "CONNECTE_A" ? c.preuve ?? null : null });
    const relue = await depot.lireRelation(tx, projetId, id);
    if (!relue) throw RELATION_INTROUVABLE();
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "ReseauRelation", entityId: id,
      after: { projetId, typeRelation: c.type, sourceObjetId: s.objetId, cibleObjetId: k.objetId, statut: "VALIDEE", origine: "MANUELLE", preuve: c.type === "CONNECTE_A" ? c.preuve ?? null : undefined, justification, geometries: false },
      ipAddress: acteur.ip,
    });
    return { relation: vueRelation(relue, true) };
  }, { timeout: 30_000, maxWait: 10_000 }));
}

/** Valider, refuser ou revoquer une relation : un acte humain, justifie, audite. */
export async function transitionRelation(acteur: Acteur, projetId: string, relId: string, action: ActionRelation, justificationBrute: string) {
  await exigerProjetActif(projetId);
  return avecTraductionBase(() => prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const verrou = await depot.verrouillerRelation(tx, projetId, relId);
    const avant = verrou ? await depot.lireRelation(tx, projetId, relId) : null;
    // Une relation dont un bout est illisible pour ce compte n'existe pas pour lui.
    if (!verrou || !avant || !jeuLisible(acteur.role, avant.sourceStatutJeu) || !jeuLisible(acteur.role, avant.cibleStatutJeu)) throw RELATION_INTROUVABLE();
    const v = verifierTransitionRelation(action, avant.statut as StatutRelation, justificationBrute);
    if (!v.ok) throw new ErreurMetier(v.code === "TRANSITION_INTERDITE" ? 409 : 422, v.code, v.message, { statut: avant.statut });
    if (action === "valider") {
      for (const statut of [avant.sourceStatutJeu, avant.cibleStatutJeu]) {
        if (!STATUTS_QUALIFIABLES.includes(statut)) {
          throw new ErreurMetier(409, "JEU_NON_QUALIFIABLE", `Une relation dont un jeu est ${statut} ne se valide plus : seul un jeu en contrôle ou autorisé le permet.`, { statut });
        }
      }
    }
    const justification = justificationBrute.trim();
    await depot.changerStatutRelation(tx, relId, v.vers, acteur.id, justification);
    const apres = await depot.lireRelation(tx, projetId, relId);
    if (!apres) throw RELATION_INTROUVABLE();
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: action === "refuser" ? "REJECT" : action === "valider" ? "VALIDATE" : "UPDATE", entityType: "ReseauRelation", entityId: relId,
      before: { projetId, statut: avant.statut, decideLe: avant.decideLe, justification: avant.justificationDecision },
      after: {
        projetId, action, statut: v.vers, justification, typeRelation: avant.typeRelation, sourceObjetId: avant.sourceObjetId, cibleObjetId: avant.cibleObjetId,
        origine: avant.origine, geometries: false,
      },
      ipAddress: acteur.ip,
    });
    return { relation: vueRelation(apres, true) };
  }, { timeout: 30_000, maxWait: 10_000 }));
}
