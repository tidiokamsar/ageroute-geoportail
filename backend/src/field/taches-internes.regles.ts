/**
 * Taches internes (TI-01, arbitrage D1, scenario A29) : les regles, isolees de la base.
 *
 * « Tache d'intervention INTERNE, NON CONTRACTUELLE » : regie, cantonnage, verifications, nettoyage
 * d'ouvrages, inspections periodiques. Des qu'un prestataire ou un marche intervient, l'objet vit
 * dans DigitalRoad et n'est pas representable ici (la table n'a aucune colonne de montant).
 *
 * CE QUE LA BASE TIENT DEJA, ET CE QUE CE FICHIER AJOUTE
 *
 * La base refuse, par contrainte, une tache cloturee sans ses quatre preuves (chemin et date, avant
 * et apres), une preuve « apres » anterieure a la preuve « avant », une cloture sans auteur ni date,
 * un abandon sans motif, une quantite sans unite. Ces contraintes sont la derniere ligne : elles
 * repondent « non » sans dire POURQUOI. Ce fichier dit pourquoi, avant la base, dans les mots d'un
 * agent -- et porte ce que la base ne peut pas dire : les transitions autorisees, le retard, les
 * alertes de rapprochement.
 */

export type StatutTache = "OUVERTE" | "EN_COURS" | "CLOTUREE" | "ABANDONNEE";

export const STATUTS_TACHE: readonly StatutTache[] = ["OUVERTE", "EN_COURS", "CLOTUREE", "ABANDONNEE"];

/**
 * Transitions autorisees. CLOTUREE et ABANDONNEE sont TERMINALES.
 *
 * Une tache terminee ne se rouvre pas : « reouvrir » effacerait la date et l'auteur de la cloture
 * (ou le motif de l'abandon), c'est-a-dire la trace que la tache existe pour garder. Un travail a
 * refaire est une NOUVELLE tache, rattachee au meme objet.
 *
 * OUVERTE peut etre cloturee directement : une intervention de dix minutes (fermer un regard, nettoyer
 * un caniveau) n'a pas a passer par « en cours ». Les preuves, elles, restent exigees.
 */
export const TRANSITIONS_TACHE: Record<StatutTache, readonly StatutTache[]> = {
  OUVERTE: ["EN_COURS", "CLOTUREE", "ABANDONNEE"],
  EN_COURS: ["CLOTUREE", "ABANDONNEE"],
  CLOTUREE: [],
  ABANDONNEE: [],
};

export const transitionTachePermise = (de: StatutTache, vers: StatutTache) => TRANSITIONS_TACHE[de].includes(vers);

export const estTerminee = (s: StatutTache) => s === "CLOTUREE" || s === "ABANDONNEE";

export interface ProuvesTache {
  avantChemin: string | null;
  avantPriseLe: Date | null;
  apresChemin: string | null;
  apresPriseLe: Date | null;
}

export type ManqueCloture =
  | "PREUVE_AVANT_ABSENTE"
  | "PREUVE_APRES_ABSENTE"
  | "PREUVE_APRES_ANTERIEURE_A_AVANT";

/**
 * Ce qui manque pour cloturer, dans l'ordre ou l'agent le corrige. Liste vide : on peut cloturer.
 *
 * Une preuve compte quand son chemin ET sa date de prise sont la : un fichier sans date ne prouve pas
 * que « apres » vient apres « avant ».
 */
export function manquesPourCloture(p: ProuvesTache): ManqueCloture[] {
  const manques: ManqueCloture[] = [];
  const avant = !!p.avantChemin && !!p.avantPriseLe;
  const apres = !!p.apresChemin && !!p.apresPriseLe;
  if (!avant) manques.push("PREUVE_AVANT_ABSENTE");
  if (!apres) manques.push("PREUVE_APRES_ABSENTE");
  if (avant && apres && p.apresPriseLe!.getTime() < p.avantPriseLe!.getTime()) manques.push("PREUVE_APRES_ANTERIEURE_A_AVANT");
  return manques;
}

export const EXPLICATIONS_MANQUE: Record<ManqueCloture, string> = {
  PREUVE_AVANT_ABSENTE: "La photo « avant » manque : sans elle, rien ne montre l'etat de depart.",
  PREUVE_APRES_ABSENTE: "La photo « apres » manque : sans elle, rien ne montre que le travail est fait.",
  PREUVE_APRES_ANTERIEURE_A_AVANT: "La photo « apres » a ete prise AVANT la photo « avant » : les deux fichiers sont probablement inverses.",
};

/** Un abandon est une decision : il se motive. Un motif blanc ne motive rien. */
export const motifAbandonValide = (motif: string | null | undefined): motif is string => typeof motif === "string" && motif.trim().length > 0;

/** Tache non terminee dont l'echeance est passee. `aujourdhui` est un jour calendaire (UTC), comme `echeanceLe` (DATE). */
export function enRetard(echeanceLe: Date | null, statut: StatutTache, aujourdhui: Date): boolean {
  if (!echeanceLe || estTerminee(statut)) return false;
  const jour = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return jour(echeanceLe) < jour(aujourdhui);
}

/**
 * Les mots qui trahiraient un objet contractuel dans une demande. Meme liste que le garde-fou du
 * modele (`taches-internes.garde.test.ts`), appliquee ici aux ENTREES : si une demande porte un champ
 * de ce genre, on dit POURQUOI elle est refusee, au lieu d'un « champ inconnu » qui ne dit rien de la
 * frontiere avec DigitalRoad.
 */
const MOTS_CONTRACTUELS = [
  "montant", "prix", "cout", "marche", "entreprise", "prestataire", "decompte", "paiement",
  "facture", "devise", "gnf", "attributaire", "titulaire", "bailleur",
];

export function champsContractuels(corps: unknown): string[] {
  if (typeof corps !== "object" || corps === null || Array.isArray(corps)) return [];
  const sansAccent = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return Object.keys(corps).filter((cle) => MOTS_CONTRACTUELS.some((mot) => sansAccent(cle).includes(mot)));
}

export const MESSAGE_FRONTIERE =
  "Une tache interne ne porte ni montant, ni marche, ni entreprise : des qu'un prestataire ou un marche intervient, " +
  "l'objet vit dans DigitalRoad (arbitrage D1, critere A29).";

/* ============================= Rapprochement en lecture ============================= */

export type CodeAlerte =
  | "ECHUE_NON_CLOTUREE"
  | "CLOTUREE_DEFAUT_ENCORE_ACTIF"
  | "DEFAUT_TRAITE_TACHE_NON_CLOTUREE"
  | "RESPONSABLE_INACTIF";

export interface TachePourRapprochement {
  id: string;
  reference: string;
  statut: StatutTache;
  echeanceLe: Date | null;
  responsableActif: boolean;
  defaut: { id: string; etat: "ACTIF" | "TRAITE" | "DISPARU"; deletedAt: Date | null } | null;
}

export interface Alerte {
  code: CodeAlerte;
  tacheId: string;
  reference: string;
  defautId: string | null;
  detail: string;
}

/**
 * Les ecarts entre ce que les taches DISENT et ce que le patrimoine MONTRE. Ne corrige RIEN : elle
 * alerte (TECHNICAL_DECISIONS.md, TI-02 : « en lecture seule, sous forme d'alertes d'audit »).
 *
 * CE QUE CE RAPPROCHEMENT N'EST PAS : le rapprochement PHYSIQUE / FINANCIER de TI-02, qui oppose les
 * travaux constates aux decomptes de DigitalRoad. Il exige des donnees DigitalRoad qui n'existent pas
 * ici (blocage B-11). Celui-ci ne compare que des faits que la plateforme possede : la tache, son
 * defaut, son responsable, sa date.
 */
export function alertesRapprochement(taches: readonly TachePourRapprochement[], aujourdhui: Date): Alerte[] {
  const alertes: Alerte[] = [];
  for (const t of taches) {
    const defaut = t.defaut && !t.defaut.deletedAt ? t.defaut : null;
    const base = { tacheId: t.id, reference: t.reference, defautId: defaut?.id ?? null };
    if (enRetard(t.echeanceLe, t.statut, aujourdhui)) {
      alertes.push({ ...base, code: "ECHUE_NON_CLOTUREE", detail: `Echeance du ${t.echeanceLe!.toISOString().slice(0, 10)} depassee, tache ${t.statut}.` });
    }
    if (t.statut === "CLOTUREE" && defaut?.etat === "ACTIF") {
      alertes.push({ ...base, code: "CLOTUREE_DEFAUT_ENCORE_ACTIF", detail: "La tache est cloturee avec ses preuves, mais le defaut qu'elle visait est toujours ACTIF." });
    }
    if (!estTerminee(t.statut) && defaut && defaut.etat !== "ACTIF") {
      alertes.push({ ...base, code: "DEFAUT_TRAITE_TACHE_NON_CLOTUREE", detail: `Le defaut est ${defaut.etat} mais la tache est encore ${t.statut}.` });
    }
    if (!estTerminee(t.statut) && !t.responsableActif) {
      alertes.push({ ...base, code: "RESPONSABLE_INACTIF", detail: "Le responsable de la tache n'a plus de compte actif." });
    }
  }
  return alertes;
}
