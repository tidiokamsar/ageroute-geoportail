/**
 * OBJETS DE RESEAU ET DESCRIPTEURS (lot B1) : liste, fiche, declaration de la nature, de la qualite et du vertical d'un objet.
 *
 * REGLES :
 *   - un objet herite de son jeu ce que son descripteur ne dit pas (nature, classe de precision, precisions, methode, date) ; sa source (jeu,
 *     version) et sa confidentialite sont celles du jeu. RIEN n'est invente : classe absente = inconnue, profondeur et altitude absentes =
 *     aucune conclusion 3D (jamais deduites) ;
 *   - LISIBILITE : un jeu RETIRE n'est montre a personne ; un jeu autre que AUTORISE n'est montre qu'a ADMIN et GESTIONNAIRE (voir commun.ts) ;
 *     un objet d'un jeu illisible repond 404 OBJET_INTROUVABLE, comme un identifiant inconnu ;
 *   - la lecture des objets d'un jeu CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE est TRACEE (consultation.ts, route `reseau`),
 *     avant la remise des donnees ; AUCUNE geometrie n'est rendue par ce service ;
 *   - toute ecriture se fait dans UNE transaction qui verrouille le projet, controle la coherence, ecrit l'audit (sans geometrie) ;
 *   - un descripteur ne se supprime pas : on le corrige (PUT), le motif et l'auteur sont conserves, l'ancienne valeur est dans l'audit.
 */

import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { tracerConsultation } from "../consultation";
import { ErreurMetier } from "../erreurs";
import { jeuLisible } from "../conflits/visibilite.noyau";
import { estDecideur } from "../conflits/types.noyau";
import { verrouillerProjet, type Acteur } from "../projets.service";
import {
  JEU_INTROUVABLE, OBJET_INTROUVABLE, STATUTS_QUALIFIABLES, arrondi2, avecTraductionBase, exigerProjetActif, lireSousDelai, statutsLisibles,
} from "./commun";
import { decoderCurseurObjet, encoderCurseurObjet } from "./curseurs.noyau";
import { verifierQualite } from "./qualite.noyau";
import * as depot from "./reseaux.depot";
import { natureEffective, verifierDescripteur, type NatureDeclarable } from "./types.noyau";
import { jeuxConsultesParRelations } from "./consultation-reseau";
import { vueObjet, vueRelation } from "./vues";
import { etatConnexion } from "../sources/classification-sources.noyau";

export { decoderCurseurObjet };

export interface FiltresObjetsService {
  jeuId?: string; nature?: string; typeObjet?: string; q?: string; curseur?: string; limite: number;
}

export async function listerObjetsReseau(acteur: Acteur, projetId: string, f: FiltresObjetsService) {
  await exigerProjetActif(projetId);
  let apres: string | undefined;
  if (f.curseur !== undefined) {
    const c = decoderCurseurObjet(f.curseur);
    if (c === null) throw new ErreurMetier(400, "CURSEUR_INVALIDE", "Curseur invalide : repartez de la première page.");
    apres = c;
  }
  if (f.jeuId) {
    // Un jeu d'un autre projet, inconnu, retire ou illisible pour ce compte : le meme 404 (aucun sondage de l'existence d'un jeu).
    const j = await prisma.jeuDonneesProjet.findFirst({ where: { id: f.jeuId, projetId }, select: { statut: true } });
    if (!j || !jeuLisible(acteur.role, j.statut)) throw JEU_INTROUVABLE();
  }
  const lignes = await lireSousDelai((tx) => depot.listerObjets(tx, {
    projetId, statuts: statutsLisibles(acteur.role), jeuId: f.jeuId, nature: f.nature, typeObjet: f.typeObjet, q: f.q, apres, limite: f.limite,
  }));
  const page = lignes.slice(0, f.limite);
  const parJeu = new Map<string, { id: string; confidentialite: string; nbObjets: number }>();
  for (const l of page) {
    const j = parJeu.get(l.jeuId) ?? { id: l.jeuId, confidentialite: l.confidentialite, nbObjets: 0 };
    j.nbObjets += 1;
    parJeu.set(l.jeuId, j);
  }
  await tracerConsultation(acteur, [...parJeu.values()], { route: "reseau", bbox: null, zoom: null });
  const dernier = page[page.length - 1];
  return {
    objets: page.map(vueObjet),
    curseurSuivant: lignes.length > f.limite && dernier ? encoderCurseurObjet(dernier.objetId) : null,
  };
}

export async function ficheObjetReseau(acteur: Acteur, projetId: string, objetId: string) {
  await exigerProjetActif(projetId);
  const decide = estDecideur(acteur.role);
  const { ligne, relations, partage, connexions } = await lireSousDelai(async (tx) => {
    const l = await depot.lireObjet(tx, projetId, objetId);
    // Un objet d'un jeu illisible pour ce compte n'existe pas pour lui (meme 404 qu'un identifiant inconnu).
    if (!l || !jeuLisible(acteur.role, l.statutJeu)) throw OBJET_INTROUVABLE();
    const r = await depot.listerRelations(tx, { projetId, statutsJeu: statutsLisibles(acteur.role), objetId, limite: 200 });
    const p = l.typeGeom === "LIGNE" ? await depot.tracePartagee(tx, objetId) : null;
    // Lot S1 : etat de connexion DECLARE (CONNECTE_A validees, avec leur preuve), jamais deduit d une proximite.
    const cx = await depot.connexionsDe(tx, objetId, statutsLisibles(acteur.role));
    return { ligne: l, relations: r.slice(0, 200), partage: p, connexions: cx };
  });
  // m4 : les relations rendues portent aussi les objets (nom, nature, jeu) de l'AUTRE bout, qui peut etre d'un autre jeu sensible : tout est trace.
  await tracerConsultation(acteur, jeuxConsultesParRelations(relations, [{ id: ligne.jeuId, confidentialite: ligne.confidentialite, nbObjets: 1 }]), { route: "reseau", bbox: null, zoom: null });
  return {
    objet: vueObjet(ligne),
    relations: relations.map((r) => ({ ...vueRelation(r, decide), role: r.sourceObjetId === objetId ? "SOURCE" : "CIBLE" })),
    // Circuits superposes : autres objets du meme jeu a la trace strictement identique. Ils restent separes et ne sont pas des cables distincts.
    tracePartagee: partage === null ? null : { nbAutresObjets: partage, libelle: "autres objets du même jeu dont la trace est strictement identique : ils restent séparés, ce ne sont pas des câbles distincts" },
    connexions: etatConnexion(connexions),
  };
}

// ------------------------------------------------------------------------------------------------
// Declaration d'un descripteur
// ------------------------------------------------------------------------------------------------

export interface CorpsDescripteur {
  nature: NatureDeclarable | null; typeObjet: string | null; classePrecision: string | null;
  precisionHorizontaleM: number | null; precisionVerticaleM: number | null; methodeCollecte: string | null; dateConstat: string | null;
  niveauConfiance: string | null; statutQualite: string; profondeurM: number | null; altitudeM: number | null; referenceVerticale: string | null;
  justification: string;
}

const champsAudit = (e: depot.LigneObjet) => ({
  nature: e.dNature, typeObjet: e.dTypeObjet, classePrecision: e.dClasse, precisionHorizontaleM: e.dPrecisionH, precisionVerticaleM: e.dPrecisionV,
  methodeCollecte: e.dMethode, niveauConfiance: e.dConfiance, statutQualite: e.dStatutQualite, profondeurM: e.dProfondeur, altitudeM: e.dAltitude,
  referenceVerticale: e.dReference, justification: e.dJustification,
});

/**
 * Cree ou remplace le descripteur d'un objet. Les valeurs absentes restent NULLES : une valeur omise n'est ni heritee ni deduite, elle est
 * inconnue. Les precisions sont arrondies au centimetre (la colonne) AVANT controle : une precision qui s'arrondit a zero est refusee.
 */
export async function declarerDescripteur(acteur: Acteur, projetId: string, objetId: string, c: CorpsDescripteur) {
  await exigerProjetActif(projetId);
  const corps: CorpsDescripteur = {
    ...c,
    precisionHorizontaleM: c.precisionHorizontaleM === null ? null : arrondi2(c.precisionHorizontaleM),
    precisionVerticaleM: c.precisionVerticaleM === null ? null : arrondi2(c.precisionVerticaleM),
    profondeurM: c.profondeurM === null ? null : arrondi2(c.profondeurM),
    altitudeM: c.altitudeM === null ? null : arrondi2(c.altitudeM),
  };
  const verdictQualite = verifierQualite({
    classePrecision: corps.classePrecision as never, precisionHorizontaleM: corps.precisionHorizontaleM, precisionVerticaleM: corps.precisionVerticaleM,
    profondeurM: corps.profondeurM, altitudeM: corps.altitudeM, referenceVerticale: corps.referenceVerticale,
  });
  if (!verdictQualite.ok) throw new ErreurMetier(422, verdictQualite.code, verdictQualite.message);

  return avecTraductionBase(() => prisma.$transaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const avant = await depot.lireObjet(tx, projetId, objetId);
    if (!avant || !jeuLisible(acteur.role, avant.statutJeu)) throw OBJET_INTROUVABLE();
    if (!STATUTS_QUALIFIABLES.includes(avant.statutJeu)) {
      throw new ErreurMetier(409, "JEU_NON_QUALIFIABLE", `Les objets d'un jeu ${avant.statutJeu} ne se qualifient plus : seul un jeu en contrôle ou autorisé le permet.`, { statut: avant.statutJeu });
    }
    const nat = natureEffective(corps.nature, avant.natureJeu);
    const verdict = verifierDescripteur({ role: avant.role, typeGeom: avant.typeGeom, natureEff: nat.nature, typeObjet: corps.typeObjet });
    if (!verdict.ok) throw new ErreurMetier(422, verdict.code, verdict.message);

    // Une nature effective qui change sous une relation proposee ou validee la rendrait incoherente : on revoque ou refuse d'abord.
    const natureAvant = natureEffective(avant.dNature, avant.natureJeu).nature;
    if (nat.nature !== natureAvant) {
      const n = await depot.nbRelationsActives(tx, objetId);
      if (n > 0) {
        throw new ErreurMetier(409, "RELATIONS_ACTIVES", `Cet objet porte ${n} relation(s) proposée(s) ou validée(s) : refusez ou révoquez-les avant de changer sa nature.`, { nbRelations: n });
      }
    }

    await depot.ecrireDescripteur(tx, objetId, corps, acteur.id);
    const apres = await depot.lireObjet(tx, projetId, objetId);
    if (!apres) throw OBJET_INTROUVABLE();
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: avant.aDescripteur ? "UPDATE" : "CREATE", entityType: "ReseauObjetDescripteur", entityId: objetId,
      before: avant.aDescripteur ? { projetId, jeuId: avant.jeuId, ...champsAudit(avant) } : undefined,
      after: { projetId, jeuId: apres.jeuId, ...champsAudit(apres), natureEffective: nat.nature, geometries: false },
      ipAddress: acteur.ip,
    });
    return { objet: vueObjet(apres), cree: !avant.aDescripteur };
  }, { timeout: 30_000, maxWait: 10_000 }));
}
