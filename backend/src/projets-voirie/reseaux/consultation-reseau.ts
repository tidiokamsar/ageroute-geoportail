/**
 * Jeux CONSULTES par une lecture de relations (revue de la vague 1, m4) : une relation rend le nom, la nature, le type et le jeu des deux bouts ;
 * si un bout appartient a un jeu CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE, cette lecture est tracee comme celle des objets
 * (`tracerConsultation`, route `reseau`). Aucune geometrie ni contenu dans la trace : l'identifiant du jeu, le nombre d'objets rendus.
 */

import type { JeuConsulte } from "../consultation";
import type { LigneRelation } from "./reseaux.depot";

export function jeuxConsultesParRelations(relations: readonly LigneRelation[], supplementaires: readonly JeuConsulte[] = []): JeuConsulte[] {
  const parJeu = new Map<string, { id: string; confidentialite: string; objets: Set<string> }>();
  const ajouter = (jeuId: string, confidentialite: string, objetId: string): void => {
    const j = parJeu.get(jeuId) ?? { id: jeuId, confidentialite, objets: new Set<string>() };
    j.objets.add(objetId);
    parJeu.set(jeuId, j);
  };
  for (const r of relations) {
    ajouter(r.sourceJeuId, r.sourceConfidentialite, r.sourceObjetId);
    ajouter(r.cibleJeuId, r.cibleConfidentialite, r.cibleObjetId);
  }
  const sortie = [...parJeu.values()].map((j) => ({ id: j.id, confidentialite: j.confidentialite, nbObjets: j.objets.size }));
  for (const s of supplementaires) {
    const deja = sortie.find((x) => x.id === s.id);
    // Le jeu deja present l'est par un bout de relation : l'objet consulte en est un des bouts, il est deja compte.
    if (!deja) sortie.push({ ...s });
  }
  return sortie;
}
