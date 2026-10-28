/**
 * CYCLE DE VIE D'UNE FICHE D'INTERVENTION, et le garde-fou de la frontiere DigitalRoad.
 * AUCUN IMPORT.
 *
 * Paragraphe 7.7 du mandat V10 :
 *
 *   BROUILLON -> PROPOSE -> ARBITRE -> APPROUVE -> TRANSMIS -> EN_EXECUTION -> ACHEVE -> EVALUE
 *
 * « Les statuts a partir de TRANSMIS sont RECUS de DigitalRoad, jamais saisis dans le
 * Geoportail. » Et : « fiche d'intervention = objet unitaire transmis a DigitalRoad ; VERSION
 * FIGEE a la transmission. »
 *
 * POURQUOI CE FICHIER EXISTE AVANT LA TABLE
 *
 * Aucune table de fiches d'intervention n'existe : le moteur de programmation est l'etape 5
 * de MAINTENANCE_PROGRAMMING_DESIGN.md, et il attend la decision D-07. Mais la regle qui le
 * gardera peut etre ecrite et testee des maintenant, exactement comme le noyau d'appariement
 * l'a ete avant l'ecran de roulage. Le jour ou la table arrivera, la route n'aura qu'a appeler
 * `transiter` : elle ne pourra pas inventer un passage en EN_EXECUTION, parce que la fonction
 * ne le lui donnera pas.
 *
 * C'est le meme dispositif que la frontiere tenue par l'ABSENCE DES COLONNES dans
 * `taches_internes` : ici, la frontiere est tenue par l'ABSENCE DE LA TRANSITION. Il n'existe
 * aucun chemin, dans ce module, qui mene a un statut post-TRANSMIS sans une origine externe
 * nommee et identifiee.
 *
 * LES TROIS ORIGINES, ET POURQUOI IL N'Y EN A PAS UNE SEULE
 *
 *   GEOPORTAIL                 un utilisateur, de BROUILLON a APPROUVE, et les retours en
 *                              arriere AVANT transmission -- motives
 *   DIGITALROAD                un message recu de l'ERP, identifie : accuse de reception
 *                              (TRANSMIS), demarrage (EN_EXECUTION), achevement (ACHEVE)
 *   INSPECTION_POST_TRAVAUX    un constat d'etat du patrimoine realise par AGEROUTE
 *                              (EVALUE), identifie par son inspection
 *
 * La troisieme merite une explication, parce qu'elle NUANCE la lettre du mandat. Le § 7.7 dit
 * « a partir de TRANSMIS, recus de DigitalRoad », et dit aussi que l'evaluation apres travaux
 * « s'appuie sur une inspection typee post-travaux [...] realisee par AGEROUTE ; c'est un
 * constat d'etat du patrimoine, pas une reception de travaux ». EVALUE ne vient donc pas de
 * DigitalRoad : il vient d'une inspection AGEROUTE. Ce qui est commun aux deux, et qui est
 * l'esprit de la regle, c'est qu'AUCUN statut post-TRANSMIS n'est une saisie libre : chacun
 * est adosse a un fait identifie -- un message ou une inspection -- et non a un clic. Cette
 * lecture est consignee pour etre confirmee (D-08), et elle est la plus stricte des deux.
 *
 * LA VERSION FIGEE est exigee a la transmission : l'empreinte de la fiche telle qu'envoyee.
 * Ce qui a ete transmis ne change pas de sens parce que les parametres changent ensuite --
 * meme principe que `publiable` fige a l'ecriture pour le RCI.
 */

export type StatutIntervention =
  | "BROUILLON" | "PROPOSE" | "ARBITRE" | "APPROUVE"
  | "TRANSMIS" | "EN_EXECUTION" | "ACHEVE" | "EVALUE";

export const STATUTS_INTERVENTION: readonly StatutIntervention[] = [
  "BROUILLON", "PROPOSE", "ARBITRE", "APPROUVE", "TRANSMIS", "EN_EXECUTION", "ACHEVE", "EVALUE",
];

/** Les statuts que le Geoportail ne peut JAMAIS poser lui-meme. */
export const STATUTS_RECUS: readonly StatutIntervention[] = ["TRANSMIS", "EN_EXECUTION", "ACHEVE", "EVALUE"];

export type Origine = "GEOPORTAIL" | "DIGITALROAD" | "INSPECTION_POST_TRAVAUX";

/**
 * Transitions autorisees. Les retours en arriere n'existent qu'AVANT la transmission : apres,
 * les statuts sont des faits externes, et un fait ne se defait pas -- une nouvelle fiche se
 * cree, et les deux restent.
 */
export const TRANSITIONS: Record<StatutIntervention, readonly StatutIntervention[]> = {
  BROUILLON:    ["PROPOSE"],
  PROPOSE:      ["ARBITRE", "BROUILLON"],
  ARBITRE:      ["APPROUVE", "PROPOSE"],
  APPROUVE:     ["TRANSMIS", "ARBITRE"],
  TRANSMIS:     ["EN_EXECUTION"],
  EN_EXECUTION: ["ACHEVE"],
  ACHEVE:       ["EVALUE"],
  EVALUE:       [],
};

/** Qui a le droit de produire chaque statut d'arrivee. */
export const ORIGINE_REQUISE: Record<StatutIntervention, Origine> = {
  BROUILLON:    "GEOPORTAIL",
  PROPOSE:      "GEOPORTAIL",
  ARBITRE:      "GEOPORTAIL",
  APPROUVE:     "GEOPORTAIL",
  TRANSMIS:     "DIGITALROAD",
  EN_EXECUTION: "DIGITALROAD",
  ACHEVE:       "DIGITALROAD",
  EVALUE:       "INSPECTION_POST_TRAVAUX",
};

export interface DemandeTransition {
  origine: Origine;
  /** Identifiant du message DigitalRoad qui porte le fait. Obligatoire pour l'origine DIGITALROAD. */
  messageDigitalRoadId?: string | null;
  /** Identifiant de l'inspection post-travaux. Obligatoire pour l'origine INSPECTION_POST_TRAVAUX. */
  inspectionId?: string | null;
  /** Empreinte de la fiche telle que transmise. Obligatoire pour entrer en TRANSMIS. */
  versionFigee?: string | null;
  /** Motif d'un retour en arriere. Obligatoire pour tout recul. */
  motif?: string | null;
}

export type CodeRefus =
  | "STATUT_INCONNU"
  | "TRANSITION_INEXISTANTE"
  | "ORIGINE_INTERDITE"
  | "MESSAGE_DIGITALROAD_REQUIS"
  | "INSPECTION_REQUISE"
  | "VERSION_FIGEE_REQUISE"
  | "RETOUR_NON_MOTIVE";

export type Verdict =
  | { ok: true; de: StatutIntervention; vers: StatutIntervention; recule: boolean }
  | { ok: false; code: CodeRefus; motif: string };

/** Ce que chaque refus veut dire, en une phrase actionnable. */
export const EXPLICATIONS: Record<CodeRefus, string> = {
  STATUT_INCONNU: "Ce statut n'existe pas dans le cycle de vie des interventions.",
  TRANSITION_INEXISTANTE: "Le cycle de vie ne permet pas ce passage : les etapes ne se sautent pas, et rien ne recule apres la transmission.",
  ORIGINE_INTERDITE: "Ce statut est recu de DigitalRoad ou d'une inspection post-travaux : il ne se saisit pas dans le Geoportail.",
  MESSAGE_DIGITALROAD_REQUIS: "Un statut recu de DigitalRoad doit citer le message qui le porte.",
  INSPECTION_REQUISE: "Une evaluation apres travaux s'adosse a une inspection post-travaux identifiee.",
  VERSION_FIGEE_REQUISE: "Une fiche se fige a la transmission : l'empreinte de la version transmise est obligatoire.",
  RETOUR_NON_MOTIVE: "Un retour en arriere se motive.",
};

function estStatut(v: string): v is StatutIntervention {
  return (STATUTS_INTERVENTION as readonly string[]).includes(v);
}

function rempli(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Vrai si `vers` est en amont de `de` dans l'ordre nominal. */
function recule(de: StatutIntervention, vers: StatutIntervention): boolean {
  return STATUTS_INTERVENTION.indexOf(vers) < STATUTS_INTERVENTION.indexOf(de);
}

/**
 * Decide si une transition est permise, et sinon dit pourquoi.
 *
 * L'ORDRE DES CONTROLES EST VOLONTAIRE. L'origine est examinee AVANT les pieces : un
 * utilisateur du Geoportail qui tente EN_EXECUTION doit lire « ce statut ne se saisit pas
 * ici », pas « message DigitalRoad requis » -- ce second motif l'inviterait a en fabriquer un.
 */
export function transiter(de: string, vers: string, demande: DemandeTransition): Verdict {
  if (!estStatut(de) || !estStatut(vers)) {
    return { ok: false, code: "STATUT_INCONNU", motif: `${EXPLICATIONS.STATUT_INCONNU} (${de} -> ${vers})` };
  }
  if (!TRANSITIONS[de].includes(vers)) {
    return { ok: false, code: "TRANSITION_INEXISTANTE", motif: `${EXPLICATIONS.TRANSITION_INEXISTANTE} (${de} -> ${vers})` };
  }

  const requise = ORIGINE_REQUISE[vers];
  if (demande.origine !== requise) {
    return { ok: false, code: "ORIGINE_INTERDITE", motif: `${EXPLICATIONS.ORIGINE_INTERDITE} (${vers} exige l'origine ${requise}, recu ${demande.origine})` };
  }

  if (requise === "DIGITALROAD" && !rempli(demande.messageDigitalRoadId)) {
    return { ok: false, code: "MESSAGE_DIGITALROAD_REQUIS", motif: EXPLICATIONS.MESSAGE_DIGITALROAD_REQUIS };
  }
  if (requise === "INSPECTION_POST_TRAVAUX" && !rempli(demande.inspectionId)) {
    return { ok: false, code: "INSPECTION_REQUISE", motif: EXPLICATIONS.INSPECTION_REQUISE };
  }
  if (vers === "TRANSMIS" && !rempli(demande.versionFigee)) {
    return { ok: false, code: "VERSION_FIGEE_REQUISE", motif: EXPLICATIONS.VERSION_FIGEE_REQUISE };
  }

  const retour = recule(de, vers);
  if (retour && !rempli(demande.motif)) {
    return { ok: false, code: "RETOUR_NON_MOTIVE", motif: EXPLICATIONS.RETOUR_NON_MOTIVE };
  }

  return { ok: true, de, vers, recule: retour };
}

/** Un statut post-transmission est-il modifiable depuis le Geoportail ? Jamais. */
export function saisissableDansLeGeoportail(statut: string): boolean {
  return estStatut(statut) && ORIGINE_REQUISE[statut] === "GEOPORTAIL";
}
