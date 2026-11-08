/**
 * Mise en forme des lignes de la base pour l'API des reseaux (lot B1) : aucune geometrie, aucune valeur inventee. Fonctions PURES (testees sans
 * base) : l'heritage objet / jeu, la qualite effective et l'etat vertical sont ceux des noyaux.
 */

import type { LigneObjet, LigneRelation } from "./reseaux.depot";
import { qualiteEffective } from "./qualite.noyau";
import { actionsPossibles } from "./relations.noyau";
import { natureEffective, type StatutRelation } from "./types.noyau";

const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const r2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100);

export function vueObjet(l: LigneObjet) {
  const nature = natureEffective(l.dNature, l.natureJeu);
  const q = qualiteEffective(
    l.aDescripteur
      ? { classePrecision: l.dClasse as never, precisionHorizontaleM: l.dPrecisionH, precisionVerticaleM: l.dPrecisionV, profondeurM: l.dProfondeur, altitudeM: l.dAltitude, referenceVerticale: l.dReference }
      : null,
    { classePrecision: l.classeJeu as never, precisionHorizontaleM: l.precisionHJeu, precisionVerticaleM: l.precisionVJeu },
  );
  return {
    id: l.objetId, jeuId: l.jeuId, nom: l.nom, typeGeom: l.typeGeom, longueurM: r2(l.longueurM),
    // La source et la confidentialite sont celles du jeu : l'objet les herite, il ne les porte pas.
    source: {
      jeuId: l.jeuId, version: l.versionJeu, role: l.role, statut: l.statutJeu, nomFichier: l.nomFichier, typeReseau: l.typeReseau,
      concessionnaire: l.concessionnaireId ? { id: l.concessionnaireId, nom: l.concessionnaireNom } : null,
      dateDonnees: jour(l.dateDonneesJeu), confidentialite: l.confidentialite,
    },
    nature: nature.nature, origineNature: nature.origine, typeObjet: l.dTypeObjet,
    qualite: {
      classePrecision: q.classePrecision, origineClasse: q.origineClasse,
      precisionHorizontaleM: q.precisionHorizontaleM, precisionVerticaleM: q.precisionVerticaleM,
      methodeCollecte: l.dMethode ?? l.methodeJeu, dateConstat: jour(l.dDateConstat ?? l.dateConstatJeu),
      niveauConfiance: l.dConfiance, statutQualite: l.dStatutQualite ?? "INCONNU",
    },
    vertical: q.vertical,
    descripteur: l.aDescripteur
      ? { justification: l.dJustification, declarePar: l.dDeclarePar, declareLe: l.dDeclareLe, modifiePar: l.dModifiePar, modifieLe: l.dUpdatedAt }
      : null,
  };
}

export type VueObjet = ReturnType<typeof vueObjet>;

/** Une relation. `peutDecider` : le compte peut ecrire (ADMIN, GESTIONNAIRE) : lui seul recoit les actions offertes. */
export function vueRelation(l: LigneRelation, peutDecider: boolean) {
  return {
    id: l.id, projetId: l.projetId, typeRelation: l.typeRelation, statut: l.statut, origine: l.origine,
    // Ce que l'association automatique a calcule (tolerance, composantes, couverture, seuil) : sans geometrie, immuable.
    proposition: l.proposition,
    source: { objetId: l.sourceObjetId, nom: l.sourceNom, nature: l.sourceNature, typeObjet: l.sourceType, typeGeom: l.sourceGeom, jeuId: l.sourceJeuId },
    cible: { objetId: l.cibleObjetId, nom: l.cibleNom, nature: l.cibleNature, typeObjet: l.cibleType, typeGeom: l.cibleGeom, jeuId: l.cibleJeuId },
    decision: l.decideLe ? { par: l.decidePar, le: l.decideLe, justification: l.justificationDecision } : null,
    creePar: l.creePar, createdAt: l.createdAt, updatedAt: l.updatedAt,
    actionsPossibles: peutDecider ? actionsPossibles(l.statut as StatutRelation) : [],
  };
}

export type VueRelation = ReturnType<typeof vueRelation>;
