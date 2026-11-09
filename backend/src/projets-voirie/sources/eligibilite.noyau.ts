/**
 * ELIGIBILITE DE DEUX JEUX A UNE COMPARAISON (noyau pur, lot S1 ; contrat CONTRAT-SOURCES.md, section 4.1).
 *
 * Deux modes, choisis par le serveur d apres les statuts, jamais par la requete :
 *   - SOURCES : deux jeux AUTORISE qui decrivent la meme chose : un meme reseau de concessionnaire (meme concessionnaire, meme type de reseau ;
 *     deux methodes d acquisition = deux sources), ou ... rien d autre (deux plans d axes ne sont jamais autorises en meme temps : voir cle-version) ;
 *   - VERSION_CANDIDATE : un jeu en controle (RECU, CONTROLE) face au jeu AUTORISE de MEME LIGNEE qu il remplacera (`remplaceId`), pour un reseau
 *     comme pour un PLAN D AXES : c est la comparaison « avant d autoriser » (par exemple un axe trace depuis un plan PDF, puis le meme axe livre en
 *     DXF par le bureau d etudes). La quarantaine n est lisible que des roles qui decident : la route est deja reservee a ADMIN et GESTIONNAIRE.
 * La reference (A) est toujours le jeu AUTORISE (en mode SOURCES : le depot le plus ancien) ; l autre est B.
 */

import { memeLignee } from "./cle-version.noyau";

export const ROLES_COMPARABLES = ["RESEAU_TIERS", "AXES_TRAVAUX"] as const;
export type ModeComparaison = "SOURCES" | "VERSION_CANDIDATE";
export type MotifNonComparable = "MEME_JEU" | "STATUT" | "ROLE" | "RESEAU_DIFFERENT" | "LIGNEE_DIFFERENTE";

export interface JeuEligible {
  id: string; projetId: string; role: string; statut: string; concessionnaireId: string | null; typeReseau: string | null;
  methodeAcquisition: string | null; remplaceId: string | null; createdAt: Date;
}

export type VerdictEligibilite =
  | { ok: true; mode: ModeComparaison; a: JeuEligible; b: JeuEligible }
  | { ok: false; motif: MotifNonComparable; message: string };

const EN_ATTENTE = ["RECU", "CONTROLE"];
const plusAncien = (x: JeuEligible, y: JeuEligible) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1);

export function evaluerEligibilite(j1: JeuEligible, j2: JeuEligible): VerdictEligibilite {
  if (j1.id === j2.id) return { ok: false, motif: "MEME_JEU", message: "Une source ne se compare pas à elle-même : désignez deux jeux distincts." };
  for (const j of [j1, j2]) {
    if (!(ROLES_COMPARABLES as readonly string[]).includes(j.role)) return { ok: false, motif: "ROLE", message: `Seuls des réseaux de concessionnaire ou des plans d'axes se comparent (jeu ${j.id} : rôle ${j.role}).` };
  }
  if (j1.role !== j2.role) return { ok: false, motif: "ROLE", message: "Les deux jeux doivent avoir le même rôle (deux réseaux, ou deux plans d'axes)." };
  if ((j1.concessionnaireId ?? null) !== (j2.concessionnaireId ?? null) || (j1.typeReseau ?? null) !== (j2.typeReseau ?? null)
      || (j1.role === "RESEAU_TIERS" && !j1.concessionnaireId)) {
    return { ok: false, motif: "RESEAU_DIFFERENT", message: "Les deux jeux doivent décrire le même réseau : même concessionnaire et même type de réseau." };
  }
  const autorises = [j1, j2].filter((j) => j.statut === "AUTORISE");
  if (autorises.length === 2) {
    // Deux plans d'axes ne sont jamais autorises ensemble (cle de version) : seule la comparaison d'une version candidate les concerne.
    const [a, b] = [j1, j2].sort(plusAncien);
    return { ok: true, mode: "SOURCES", a, b };
  }
  if (autorises.length === 1) {
    const a = autorises[0];
    const b = a === j1 ? j2 : j1;
    if (!EN_ATTENTE.includes(b.statut)) return { ok: false, motif: "STATUT", message: `Le second jeu doit être autorisé, ou en contrôle (version candidate) ; statut : ${b.statut}.` };
    if (b.remplaceId !== a.id || !memeLignee(a, b)) {
      return { ok: false, motif: "LIGNEE_DIFFERENTE", message: "Un jeu en contrôle ne se compare qu'au jeu autorisé qu'il remplacera (même rôle, même concessionnaire, même lignée de versions)." };
    }
    return { ok: true, mode: "VERSION_CANDIDATE", a, b };
  }
  return { ok: false, motif: "STATUT", message: "Au moins un des deux jeux doit être autorisé : deux sources autorisées, ou une version candidate face à la version autorisée." };
}
