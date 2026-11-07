/**
 * REGLES DE COMPTAGE des reseaux physiques et des circuits logiques (noyau pur, lot B1 ; cahier v2, 20.1 et 22.2 point 5).
 *
 * LE PRINCIPE : le nombre de lignes d'un fichier n'est PAS un nombre d'equipements physiques. Plusieurs circuits logiques peuvent suivre le
 * meme support physique : N circuits superposes sur une meme trace ne sont JAMAIS comptes comme N cables.
 *
 * LES TOTAUX NE MELANGENT JAMAIS LES NATURES. Il n'y a aucun total « tous objets » : chaque nature a son bloc, et chaque grandeur porte son
 * nom exact :
 *   - `infrastructuresPhysiques.nombreDeclare`         : nombre d'infrastructures DECLAREES (des objets declares ; aucun dedoublonnage) ;
 *   - `infrastructuresPhysiques.longueurTraceFusionneM`: longueur de TRACE FUSIONNEE (union des traces : une trace superposee compte une fois) ;
 *   - `circuitsLogiques.nombreDeclare`                 : nombre de circuits declares (pas un nombre de cables) ;
 *   - `circuitsLogiques.sommeLongueursCircuitsM`       : SOMME DES LONGUEURS DE CIRCUITS (une trace partagee par N circuits y compte N fois :
 *                                                        ce n'est pas une longueur de cable) ;
 *   - `circuitsLogiques.longueurTraceFusionneM`        : longueur de trace fusionnee des circuits ;
 *   - un objet de nature INCONNUE n'est compte NI comme infrastructure NI comme circuit : bloc `natureInconnue`.
 *
 * DEUX CHEMINS, UN SEUL ASSEMBLAGE : `comptabiliser` (geometrie plane, en metres : reference et oracle des tests, trace fusionnee limitee aux
 * segments identiques au millimetre comme `longueurPhysique` du socle) et `assemblerComptage` (mesures deja calculees par PostGIS, qui
 * fusionne aussi les recouvrements partiels). Les deux rendent la meme forme.
 */

import { longueur, longueurPhysique, type Pt } from "../analyse.noyau";
import type { NatureDeclarable, StatutRelation, TypeGeom, TypeRelation } from "./types.noyau";

export type NatureComptee = NatureDeclarable | "INCONNUE";

export interface ObjetCompte {
  id: string;
  nature: NatureComptee;
  typeObjet: string | null;
  typeGeom: TypeGeom;
  /** Sommets (metres, repere plan) d'un objet LIGNE. */
  ligne?: readonly Pt[];
}

export interface LiaisonCompte { sourceId: string; cibleId: string; type: TypeRelation; statut: StatutRelation }

export interface MesuresGroupe {
  /** Objets declares de cette nature, toutes geometries. */
  nb: number;
  nbLineaires: number;
  /** Somme des longueurs des objets lineaires (m). */
  sommeM: number;
  /** Longueur de l'union des traces (m). */
  fusionneM: number;
  parType: Record<string, number>;
  /** Groupes d'objets lineaires de trace STRICTEMENT identique (au moins deux objets). */
  tracesPartagees: { nbGroupes: number; nbObjets: number };
}

export interface SupportPhysique {
  /** Circuits relies a au moins une infrastructure par une relation VALIDEE. */
  avecSupportValide: number;
  /** Circuits sans relation validee mais avec au moins une proposition en attente. */
  avecPropositionSeulement: number;
  /** Circuits sans relation validee ni proposition en attente : support physique INCONNU (jamais suppose). */
  sansSupportConnu: number;
}

export interface EntreeAssemblage {
  infrastructures: MesuresGroupe;
  circuits: MesuresGroupe;
  equipements: MesuresGroupe;
  inconnue: MesuresGroupe;
  supportPhysique: SupportPhysique;
}

export const LIBELLES_COMPTAGE = {
  nombreInfrastructuresDeclarees: "nombre d'infrastructures physiques déclarées (objets déclarés, sans dédoublonnage géométrique)",
  longueurTraceFusionneM: "longueur de trace fusionnée (union des tracés : un tracé superposé ne compte qu'une fois)",
  nombreCircuitsDeclares: "nombre de circuits logiques déclarés (ce n'est pas un nombre de câbles physiques)",
  sommeLongueursCircuitsM: "somme des longueurs de circuits (un tracé partagé par N circuits y compte N fois : ce n'est pas une longueur de câble)",
  natureInconnue: "objets de nature inconnue : comptés ni comme infrastructures ni comme circuits",
} as const;

export const MENTION_CIRCUITS_NON_CABLES = "Le nombre de circuits logiques n'est pas un nombre de câbles physiques : plusieurs circuits peuvent suivre le même support.";

export interface Comptage {
  infrastructuresPhysiques: {
    nombreDeclare: number;
    nombreLineaires: number;
    parType: Record<string, number>;
    longueurSommeM: number;
    longueurTraceFusionneM: number;
  };
  circuitsLogiques: {
    nombreDeclare: number;
    nombreLineaires: number;
    parType: Record<string, number>;
    sommeLongueursCircuitsM: number;
    longueurTraceFusionneM: number;
    tracesPartagees: { groupes: number; circuitsConcernes: number };
    supportPhysique: SupportPhysique;
  };
  equipements: { nombreDeclare: number; parType: Record<string, number> };
  natureInconnue: { nombreObjets: number; nombreLineaires: number; longueurSommeM: number; longueurTraceFusionneM: number };
  libelles: typeof LIBELLES_COMPTAGE;
  avertissements: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const fr = (n: number) => String(r2(n)).replace(".", ",");
const TYPE_INCONNU = "INCONNU";

export function groupeVide(): MesuresGroupe {
  return { nb: 0, nbLineaires: 0, sommeM: 0, fusionneM: 0, parType: {}, tracesPartagees: { nbGroupes: 0, nbObjets: 0 } };
}

/** Assemble le comptage a partir de mesures deja calculees (chemin PostGIS) ou par `comptabiliser` (chemin plan). Refuse des mesures impossibles. */
export function assemblerComptage(e: EntreeAssemblage): Comptage {
  for (const [nom, g] of Object.entries({ infrastructures: e.infrastructures, circuits: e.circuits, equipements: e.equipements, inconnue: e.inconnue })) {
    if (![g.nb, g.nbLineaires, g.sommeM, g.fusionneM].every((v) => Number.isFinite(v) && v >= 0)) throw new Error(`mesures invalides pour ${nom}`);
    if (g.nbLineaires > g.nb) throw new Error(`${nom} : plus d'objets lineaires que d'objets`);
  }
  const avertissements: string[] = [];
  const c = e.circuits;
  if (c.nb > 0) avertissements.push(MENTION_CIRCUITS_NON_CABLES);
  if (c.nbLineaires > 0 && c.sommeM - c.fusionneM > 0.005) {
    avertissements.push(
      `Les ${c.nbLineaires} circuits logiques linéaires déclarés partagent tout ou partie de leur tracé : la somme de leurs longueurs (${fr(c.sommeM)} m) dépasse la longueur de trace fusionnée (${fr(c.fusionneM)} m). Ce ne sont pas ${c.nbLineaires} câbles physiques.`,
    );
  }
  if (c.tracesPartagees.nbGroupes > 0) {
    avertissements.push(`${c.tracesPartagees.nbObjets} circuits logiques se superposent exactement, en ${c.tracesPartagees.nbGroupes} groupe(s) de tracé identique : ils restent séparés et ne sont pas convertis en infrastructures distinctes.`);
  }
  if (c.nb > 0 && e.infrastructures.nb === 0) {
    avertissements.push("Aucune infrastructure physique n'est déclarée : le support physique des circuits est inconnu (la relation entre circuit logique et infrastructure doit être renseignée, ou rester inconnue).");
  } else if (e.supportPhysique.sansSupportConnu > 0) {
    avertissements.push(`${e.supportPhysique.sansSupportConnu} circuit(s) logique(s) sans support physique validé : le support est inconnu, jamais supposé.`);
  }
  if (e.inconnue.nb > 0) avertissements.push(`${e.inconnue.nb} objet(s) de nature inconnue ne sont comptés ni comme infrastructures ni comme circuits : déclarez leur nature.`);

  return {
    infrastructuresPhysiques: {
      nombreDeclare: e.infrastructures.nb, nombreLineaires: e.infrastructures.nbLineaires, parType: { ...e.infrastructures.parType },
      longueurSommeM: r2(e.infrastructures.sommeM), longueurTraceFusionneM: r2(e.infrastructures.fusionneM),
    },
    circuitsLogiques: {
      nombreDeclare: c.nb, nombreLineaires: c.nbLineaires, parType: { ...c.parType },
      sommeLongueursCircuitsM: r2(c.sommeM), longueurTraceFusionneM: r2(c.fusionneM),
      tracesPartagees: { groupes: c.tracesPartagees.nbGroupes, circuitsConcernes: c.tracesPartagees.nbObjets },
      supportPhysique: { ...e.supportPhysique },
    },
    equipements: { nombreDeclare: e.equipements.nb, parType: { ...e.equipements.parType } },
    natureInconnue: { nombreObjets: e.inconnue.nb, nombreLineaires: e.inconnue.nbLineaires, longueurSommeM: r2(e.inconnue.sommeM), longueurTraceFusionneM: r2(e.inconnue.fusionneM) },
    libelles: LIBELLES_COMPTAGE,
    avertissements,
  };
}

/** Cle canonique d'un trace (au millimetre, sens de lecture indifferent) : deux circuits de meme cle se superposent exactement. */
export function cleTrace(ligne: readonly Pt[]): string {
  const q = (v: number) => String(Math.round(v * 1000));
  const pts = ligne.map((p) => `${q(p[0])},${q(p[1])}`);
  const inverse = [...pts].reverse();
  return pts.join(";") <= inverse.join(";") ? pts.join(";") : inverse.join(";");
}

function mesurerGroupe(objets: readonly ObjetCompte[]): MesuresGroupe {
  const g = groupeVide();
  const lignes: (readonly Pt[])[] = [];
  const parCle = new Map<string, number>();
  for (const o of objets) {
    g.nb += 1;
    g.parType[o.typeObjet ?? TYPE_INCONNU] = (g.parType[o.typeObjet ?? TYPE_INCONNU] ?? 0) + 1;
    if (o.typeGeom === "LIGNE" && o.ligne && o.ligne.length >= 2) {
      g.nbLineaires += 1;
      g.sommeM += longueur(o.ligne);
      lignes.push(o.ligne);
      const k = cleTrace(o.ligne);
      parCle.set(k, (parCle.get(k) ?? 0) + 1);
    }
  }
  g.fusionneM = longueurPhysique(lignes);
  for (const n of parCle.values()) if (n >= 2) { g.tracesPartagees.nbGroupes += 1; g.tracesPartagees.nbObjets += n; }
  return g;
}

/** Statistique des supports des circuits : seules les relations PORTE_PAR comptent, la plus favorable par circuit (VALIDEE > PROPOSEE). */
export function supportsDesCircuits(circuitsIds: readonly string[], liaisons: readonly LiaisonCompte[]): SupportPhysique {
  const meilleur = new Map<string, "VALIDEE" | "PROPOSEE">();
  const ensemble = new Set(circuitsIds);
  for (const l of liaisons) {
    if (l.type !== "PORTE_PAR" || !ensemble.has(l.sourceId)) continue;
    if (l.statut === "VALIDEE") meilleur.set(l.sourceId, "VALIDEE");
    else if (l.statut === "PROPOSEE" && meilleur.get(l.sourceId) !== "VALIDEE") meilleur.set(l.sourceId, "PROPOSEE");
  }
  let valide = 0, propose = 0;
  for (const v of meilleur.values()) { if (v === "VALIDEE") valide += 1; else propose += 1; }
  return { avecSupportValide: valide, avecPropositionSeulement: propose, sansSupportConnu: circuitsIds.length - valide - propose };
}

/** Comptage de reference sur geometrie plane (metres). Une nature absente de la liste donne un bloc a zero. */
export function comptabiliser(objets: readonly ObjetCompte[], liaisons: readonly LiaisonCompte[] = []): Comptage {
  const de = (n: NatureComptee) => objets.filter((o) => o.nature === n);
  const circuits = de("CIRCUIT_LOGIQUE");
  return assemblerComptage({
    infrastructures: mesurerGroupe(de("ACTIF_PHYSIQUE")),
    circuits: mesurerGroupe(circuits),
    equipements: mesurerGroupe(de("EQUIPEMENT")),
    inconnue: mesurerGroupe(de("INCONNUE")),
    supportPhysique: supportsDesCircuits(circuits.map((o) => o.id), liaisons),
  });
}
