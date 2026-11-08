/**
 * VISIBILITE DU WORKFLOW SELON LE PROFIL (noyau pur ; contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, section 6).
 *
 * TROIS SORTES DE LECTEURS :
 *   - DECIDEUR (ADMIN, GESTIONNAIRE) : tout le projet, brouillons compris, historique et preuves internes compris ;
 *   - REFERENT : uniquement ce qui porte le concessionnaire de l'un de ses rattachements ACTIFS pour ce projet, et seulement ce qui a ete
 *     PARTAGE avec lui : une demande envoyee, une tache qui porte un concessionnaire, un recolement soumis, une preuve partagee ;
 *   - AUTRE (INSPECTEUR ou LECTEUR auxquels la configuration ouvre `workflow.lire`) : vue de PROJET : les demandes, les taches et recolements
 *     NON lies a un conflit, les preuves partagees ; jamais d'historique. Le dossier d'un conflit n'est pas montre par le workflow a un compte
 *     qui ne decide pas (il n'en a la lecture que par les routes des conflits, avec leurs propres regles).
 *
 * Les fonctions rendent soit un FILTRE (que les services traduisent en clause `where`, pour que la base ne remonte que ce qui est visible),
 * soit un verdict sur une ligne deja lue (pour une fiche).
 */

import { estDecideurProfil, type ProfilEffectif } from "./profils.noyau";

export interface ContexteLecture {
  profil: ProfilEffectif;
  /** Concessionnaires des rattachements actifs du compte POUR CE PROJET (referent seulement ; vide sinon). */
  concessionnaires: readonly string[];
}

export type SorteLecteur = "DECIDEUR" | "REFERENT" | "AUTRE";
export const sorteDe = (c: ContexteLecture): SorteLecteur => (estDecideurProfil(c.profil) ? "DECIDEUR" : c.profil === "REFERENT" ? "REFERENT" : "AUTRE");

export interface FiltreVisibilite {
  /** `null` : tous les concessionnaires ; sinon la ligne doit porter l'un de ces identifiants (liste vide : rien n'est visible). */
  concessionnaires: readonly string[] | null;
  /** La ligne doit porter un concessionnaire (une tache sans concessionnaire est interne a AGEROUTE). */
  exigeConcessionnaire: boolean;
  /** La ligne ne doit pas etre liee a un conflit. */
  sansConflit: boolean;
  /** Demande : envoyee (`envoyeLe` renseigne). Recolement : autre que BROUILLON. Tache : `partagee`. */
  exigePartage: boolean;
}

const TOUT: FiltreVisibilite = { concessionnaires: null, exigeConcessionnaire: false, sansConflit: false, exigePartage: false };

/** Demandes : un referent ne voit que celles de son concessionnaire, une fois envoyees. */
export function filtreDemandes(c: ContexteLecture): FiltreVisibilite {
  switch (sorteDe(c)) {
    case "DECIDEUR": return TOUT;
    case "REFERENT": return { ...TOUT, concessionnaires: c.concessionnaires, exigePartage: true };
    default: return { ...TOUT, exigePartage: true };
  }
}

/**
 * Taches : un referent ne voit que celles qui portent son concessionnaire ET qu'un decideur a PARTAGEES (`partagee`) : lier une tache a un conflit
 * ou a une demande lui donne un concessionnaire mais ne la partage pas. Les autres lecteurs voient celles qui ne sont pas liees a un conflit.
 */
export function filtreTaches(c: ContexteLecture): FiltreVisibilite {
  switch (sorteDe(c)) {
    case "DECIDEUR": return TOUT;
    case "REFERENT": return { ...TOUT, concessionnaires: c.concessionnaires, exigeConcessionnaire: true, exigePartage: true };
    default: return { ...TOUT, sansConflit: true };
  }
}

/** Recolements : un referent ne voit que ceux de son concessionnaire une fois soumis (jamais un brouillon, meme rouvert apres un rejet) ; les autres lecteurs, ceux qui ne sont pas lies a un conflit. */
export function filtreRecolements(c: ContexteLecture): FiltreVisibilite {
  switch (sorteDe(c)) {
    case "DECIDEUR": return TOUT;
    case "REFERENT": return { ...TOUT, concessionnaires: c.concessionnaires, exigePartage: true };
    default: return { ...TOUT, sansConflit: true, exigePartage: true };
  }
}

export interface LigneVisible { concessionnaireId: string | null; conflitId?: string | null; partage?: boolean }

/** Verdict sur une ligne deja lue, avec le meme filtre que la liste. */
export function ligneVisible(f: FiltreVisibilite, l: LigneVisible): boolean {
  if (f.concessionnaires !== null && (l.concessionnaireId === null || !f.concessionnaires.includes(l.concessionnaireId))) return false;
  if (f.exigeConcessionnaire && l.concessionnaireId === null) return false;
  if (f.sansConflit && (l.conflitId ?? null) !== null) return false;
  if (f.exigePartage && l.partage !== true) return false;
  return true;
}

/** Preuves : un decideur lit tout ; les autres, uniquement les preuves partagees. */
export const preuveVisible = (c: ContexteLecture, p: { partagee: boolean }): boolean => sorteDe(c) === "DECIDEUR" || p.partagee;

/** L'historique (avant/apres, justifications internes) n'est lu que par un decideur. */
export const historiqueVisible = (c: ContexteLecture): boolean => sorteDe(c) === "DECIDEUR";

/** Auteurs et responsables (personnel d'AGEROUTE) : montres aux decideurs seulement ; un referent ne voit pas qui, chez AGEROUTE, a ecrit. */
export const identitesInternesVisibles = (c: ContexteLecture): boolean => sorteDe(c) === "DECIDEUR";

/**
 * Jeu lie a un objet du workflow (jeu recu d'une demande, jeu d'un recolement) : meme regle que le socle. Un jeu RETIRE n'est montre a personne ;
 * un jeu autre qu'AUTORISE n'est montre qu'a ADMIN et GESTIONNAIRE ; un jeu AUTORISE a tout compte qui lit le workflow. Pour un referent, le jeu
 * doit en plus etre celui de son concessionnaire (le filtre de la ligne qui le porte l'a deja garanti).
 */
export function jeuLieVisible(c: ContexteLecture, statutJeu: string): boolean {
  if (statutJeu === "RETIRE") return false;
  return statutJeu === "AUTORISE" || sorteDe(c) === "DECIDEUR";
}

/**
 * Vue concessionnaire d'un dossier de conflit : un referent ne voit que les dossiers de son concessionnaire CONFIRMES PAR UNE PERSONNE
 * (une proposition du systeme, A_INVESTIGUER ou POTENTIEL, ou un dossier infirme, est un signal interne), dont le jeu est AUTORISE.
 */
export const STATUTS_CONFLIT_PARTAGES: readonly string[] = ["CONFIRME", "TRAITEMENT_DECIDE", "CLOTURE"];

export interface FiltreConflitsVue { concessionnaires: readonly string[] | null; statuts: readonly string[] | null; jeuxAutorisesSeulement: boolean }

/** Les autres lecteurs (ni decideur ni referent) n'ont pas de vue de dossiers par le workflow : liste de concessionnaires vide. */
export function filtreConflitsVue(c: ContexteLecture): FiltreConflitsVue {
  switch (sorteDe(c)) {
    case "DECIDEUR": return { concessionnaires: null, statuts: null, jeuxAutorisesSeulement: false };
    case "REFERENT": return { concessionnaires: c.concessionnaires, statuts: STATUTS_CONFLIT_PARTAGES, jeuxAutorisesSeulement: true };
    default: return { concessionnaires: [], statuts: [], jeuxAutorisesSeulement: true };
  }
}
