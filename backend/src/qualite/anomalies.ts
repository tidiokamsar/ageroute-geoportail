/**
 * Moteur de controle de qualite des donnees.
 *
 * LE PIEGE QUE CE MODULE EVITE, ET QUI EST LA SEULE CHOSE DIFFICILE ICI
 *
 * Detecter une anomalie est facile. Produire un rapport UTILISABLE sur ce reseau ne l'est
 * pas : `troncons.revetement` vaut NON_RENSEIGNE sur 258 961 lignes et `etat` vaut
 * NON_EVALUE sur 254 547. Un moteur qui emet une anomalie par objet rendrait donc un demi-
 * million de lignes, ce qui n'est pas un diagnostic mais un deluge. Personne ne le lirait,
 * et la seule anomalie qui compte vraiment y serait noyee.
 *
 * Ce moteur AGREGE donc par famille : un compte, une part du total, et quelques exemples
 * nommes. La liste exhaustive reste accessible famille par famille, quand quelqu'un decide
 * de traiter celle-la.
 *
 * UNE ANOMALIE EST UN SIGNAL, JAMAIS UNE ACTION
 *
 * Le paragraphe 10 du cahier l'exige et il a raison : « Ne supprime pas automatiquement les
 * donnees suspectes. Classe-les, explique les anomalies et propose une correction soumise
 * aux droits et workflows appropries. »
 *
 * Aucune fonction de ce module n'ecrit. Chaque anomalie porte une CORRECTION PROPOSEE, en
 * texte, que quelqu'un applique par les routes normales et leur validation. Sept des
 * 261 387 troncons sont hors du territoire guineen : les supprimer effacerait du patrimoine
 * d'archive, alors que leur donner un statut explicite le documente.
 *
 * LES SEUILS SONT DES PARAMETRES, PAS DES CONSTANTES
 *
 * « Inspection trop ancienne » suppose de savoir a partir de quand. Ce nombre appartient a
 * AGEROUTE, comme les coefficients du RCI, et le figer ici en ferait une norme. Il est donc
 * recu en parametre, et l'appelant doit le fournir.
 */

/** Les neuf familles du paragraphe 10, dans son ordre. */
export type FamilleAnomalie =
  | "HORS_TERRITOIRE"
  | "DOUBLON"
  | "GEOMETRIE_INVALIDE"
  | "PORTIONS_CHEVAUCHANTES"
  | "RUPTURE_DE_CONTINUITE"
  | "ATTRIBUTS_INCOHERENTS"
  | "ACTIF_SANS_VALIDATION"
  | "INSPECTION_PERIMEE"
  | "DONNEE_SANS_PROVENANCE";

/**
 * Gravite d'une famille.
 *
 * BLOQUANTE  la donnee est fausse et contamine les calculs : une geometrie invalide fait
 *            echouer une requete spatiale, deux portions validees chevauchantes rendent
 *            toute statistique indefendable.
 * A_TRAITER  la donnee est incomplete ou non verifiee : elle ne fausse rien, mais elle
 *            empeche de conclure.
 * A_SURVEILLER  la donnee vieillit. Rien n'est faux aujourd'hui.
 */
export type Gravite = "BLOQUANTE" | "A_TRAITER" | "A_SURVEILLER";

export const GRAVITE_PAR_FAMILLE: Record<FamilleAnomalie, Gravite> = {
  GEOMETRIE_INVALIDE: "BLOQUANTE",
  PORTIONS_CHEVAUCHANTES: "BLOQUANTE",
  DOUBLON: "BLOQUANTE",
  HORS_TERRITOIRE: "A_TRAITER",
  ATTRIBUTS_INCOHERENTS: "A_TRAITER",
  ACTIF_SANS_VALIDATION: "A_TRAITER",
  DONNEE_SANS_PROVENANCE: "A_TRAITER",
  RUPTURE_DE_CONTINUITE: "A_SURVEILLER",
  INSPECTION_PERIMEE: "A_SURVEILLER",
};

/**
 * Ce qu'il faut FAIRE, par famille. Jamais « supprimer ».
 *
 * Une anomalie qui dit seulement ce qui est faux laisse celui qui la lit sans prise. Et
 * « supprimer » n'apparait nulle part parce que le patrimoine routier est une donnee
 * d'archive : la regle 2 d'AGENTS.md n'admet que la suppression logique, et meme celle-ci
 * ne repare pas une donnee douteuse, elle la cache.
 */
export const CORRECTION_PROPOSEE: Record<FamilleAnomalie, string> = {
  HORS_TERRITOIRE:
    "Donner un statut explicite (perimetre HORS_TERRITOIRE_NATIONAL et pays), et non supprimer : "
    + "ces objets documentent une continuite routiere transfrontaliere.",
  DOUBLON:
    "Arbitrer lequel fait foi, rattacher les observations au retenu, puis marquer l'autre "
    + "remplace. Supprimer l'un des deux ferait perdre les observations qui y pendent.",
  GEOMETRIE_INVALIDE:
    "Corriger le trace par une operation geometrique explicite et auditee. Ne jamais "
    + "reparer en masse : ST_MakeValid peut deplacer un sommet sans le dire.",
  PORTIONS_CHEVAUCHANTES:
    "Faire trancher par un validateur laquelle decrit ces metres, puis requalifier. Le "
    + "chevauchement est une contradiction de terrain, pas une erreur de saisie.",
  RUPTURE_DE_CONTINUITE:
    "Verifier si le trou est reel, c'est-a-dire une section non inventoriee, ou un defaut "
    + "de decoupage. Le combler par un releve, pas par une interpolation.",
  ATTRIBUTS_INCOHERENTS:
    "Reverifier sur le terrain. Deux attributs qui se contredisent signalent qu'au moins un "
    + "des deux n'a pas ete constate.",
  ACTIF_SANS_VALIDATION:
    "Faire valider par un tiers habilite, ou laisser en proposition. Un actif importe ne "
    + "devient pas officiel par l'anciennete de son import.",
  INSPECTION_PERIMEE:
    "Programmer une reinspection. Ne pas reconduire l'etat precedent : un etat ancien "
    + "reconduit devient une donnee inventee.",
  DONNEE_SANS_PROVENANCE:
    "Documenter la source, ou laisser le champ NON RENSEIGNE. Remplir au plus probable "
    + "produirait une donnee que personne n'a constatee.",
};

/** Une anomalie, sur un objet nomme. */
export interface Anomalie {
  famille: FamilleAnomalie;
  entityType: string;
  entityId: string;
  /** Ce qui ne va pas, en une phrase, avec les valeurs en cause. */
  explication: string;
  /** Valeur utile au tri : metres chevauchants, jours de retard, distance. */
  mesure?: number | null;
}

/** Une famille, resumee. */
export interface ResumeFamille {
  famille: FamilleAnomalie;
  gravite: Gravite;
  /** Nombre d'objets touches. */
  nombre: number;
  /** Population examinee, pour que le nombre soit lisible. */
  surTotal: number | null;
  part: number | null;
  correctionProposee: string;
  /** Quelques cas nommes. JAMAIS la liste entiere : voir l'en-tete. */
  exemples: Anomalie[];
}

/**
 * Nombre d'exemples conserves par famille.
 *
 * Trois suffisent a comprendre de quoi il s'agit et a verifier que la detection ne se
 * trompe pas. Au-dela, on recommence a produire la liste exhaustive que ce moteur existe
 * pour eviter.
 */
export const EXEMPLES_MAX = 3;

/**
 * Agrege des anomalies en resumes par famille.
 *
 * `populations` donne, par famille, le nombre d'objets EXAMINES. Sans lui, « 1 029
 * anomalies » ne dit pas si c'est tout le reseau ou une poignee. Une famille dont la
 * population est inconnue rend `part: null` au lieu d'un pourcentage invente.
 */
export function resumer(
  anomalies: readonly Anomalie[],
  populations: Partial<Record<FamilleAnomalie, number>> = {},
): ResumeFamille[] {
  const parFamille = new Map<FamilleAnomalie, Anomalie[]>();
  for (const a of anomalies) {
    const liste = parFamille.get(a.famille);
    if (liste) liste.push(a);
    else parFamille.set(a.famille, [a]);
  }

  return [...parFamille.entries()]
    .map(([famille, liste]) => {
      const surTotal = populations[famille] ?? null;
      return {
        famille,
        gravite: GRAVITE_PAR_FAMILLE[famille],
        nombre: liste.length,
        surTotal,
        part: surTotal !== null && surTotal > 0
          ? Math.round((liste.length / surTotal) * 10_000) / 10_000
          : null,
        correctionProposee: CORRECTION_PROPOSEE[famille],
        // Les plus gros d'abord quand une mesure existe : un chevauchement de 4 km merite
        // d'etre vu avant un de 30 cm.
        exemples: [...liste]
          .sort((x, y) => (y.mesure ?? 0) - (x.mesure ?? 0))
          .slice(0, EXEMPLES_MAX),
      };
    })
    .sort((x, y) => rangGravite(x.gravite) - rangGravite(y.gravite) || y.nombre - x.nombre);
}

function rangGravite(g: Gravite): number {
  return g === "BLOQUANTE" ? 0 : g === "A_TRAITER" ? 1 : 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecteurs purs : ils travaillent sur des donnees deja chargees.
// ─────────────────────────────────────────────────────────────────────────────

export interface PortionExaminee {
  id: string;
  tronconId: string;
  debutM: number;
  finM: number;
  revetement: string | null;
  etat: string | null;
  statutValidation: string;
  remplaceeLe: Date | null;
  deletedAt: Date | null;
}

/** Tolerance de jointure, alignee sur `reseau/portions.ts`. */
const TOLERANCE_M = 0.05;

/**
 * Portions courantes qui se recouvrent sur le meme troncon.
 *
 * NE SIGNALE QUE LES PAIRES DONT AU MOINS UNE EST VALIDEE. Deux propositions qui se
 * contredisent sont NORMALES : c'est ainsi qu'arrive un second releve, et le cahier
 * interdit tout ecrasement silencieux. Les compter comme anomalies noierait le rapport sous
 * le fonctionnement voulu du systeme.
 */
export function chevauchementsAnormaux(portions: readonly PortionExaminee[]): Anomalie[] {
  const vivantes = portions
    .filter((p) => p.remplaceeLe === null && p.deletedAt === null)
    .slice()
    .sort((a, b) => a.tronconId.localeCompare(b.tronconId) || a.debutM - b.debutM);

  const trouvees: Anomalie[] = [];
  for (let i = 0; i < vivantes.length; i++) {
    for (let j = i + 1; j < vivantes.length; j++) {
      const a = vivantes[i];
      const b = vivantes[j];
      if (a.tronconId !== b.tronconId) break;
      if (b.debutM >= a.finM - TOLERANCE_M) break;
      if (a.statutValidation !== "VALIDE" && b.statutValidation !== "VALIDE") continue;
      const commun = Math.min(a.finM, b.finM) - Math.max(a.debutM, b.debutM);
      if (commun <= TOLERANCE_M) continue;
      trouvees.push({
        famille: "PORTIONS_CHEVAUCHANTES",
        entityType: "Portion",
        entityId: a.id,
        explication:
          `Recouvre la portion ${b.id} sur ${Math.round(commun)} m du troncon ${a.tronconId}`
          + ` (${a.statutValidation} contre ${b.statutValidation}).`,
        mesure: Math.round(commun),
      });
    }
  }
  return trouvees;
}

/**
 * Trous entre portions d'un meme troncon.
 *
 * NE SIGNALE QUE LES TRONCONS DEJA PARTIELLEMENT QUALIFIES. Un troncon sans aucune portion
 * n'est pas une rupture de continuite, c'est un troncon non inventorie : le signaler ici
 * rendrait 261 387 anomalies disant toutes la meme chose, et le moteur serait inutilisable
 * des sa premiere execution.
 */
export function rupturesDeContinuite(
  portions: readonly PortionExaminee[],
  longueursParTroncon: ReadonlyMap<string, number>,
  /** Trou minimal signale, en metres. Un ecart de dix metres est un artefact de decoupage. */
  trouMinimalM: number,
): Anomalie[] {
  const parTroncon = new Map<string, PortionExaminee[]>();
  for (const p of portions) {
    if (p.remplaceeLe !== null || p.deletedAt !== null) continue;
    const liste = parTroncon.get(p.tronconId);
    if (liste) liste.push(p);
    else parTroncon.set(p.tronconId, [p]);
  }

  const trouvees: Anomalie[] = [];
  for (const [tronconId, liste] of parTroncon) {
    const longueur = longueursParTroncon.get(tronconId);
    if (longueur === undefined || longueur <= 0) continue;
    const triees = liste.slice().sort((a, b) => a.debutM - b.debutM);

    let curseur = 0;
    for (const p of triees) {
      if (p.debutM - curseur > trouMinimalM) {
        trouvees.push(trou(tronconId, curseur, p.debutM));
      }
      curseur = Math.max(curseur, p.finM);
    }
    if (longueur - curseur > trouMinimalM) {
      trouvees.push(trou(tronconId, curseur, longueur));
    }
  }
  return trouvees;
}

function trou(tronconId: string, debutM: number, finM: number): Anomalie {
  return {
    famille: "RUPTURE_DE_CONTINUITE",
    entityType: "Troncon",
    entityId: tronconId,
    explication:
      `Non qualifie de ${Math.round(debutM)} m a ${Math.round(finM)} m, alors que d'autres`
      + " portions existent sur ce troncon.",
    mesure: Math.round(finM - debutM),
  };
}

export interface ReferentielFlags {
  /** Revetements declares bitumineux au referentiel. */
  bitumineux: ReadonlySet<string>;
}

/**
 * Attributs qui se contredisent.
 *
 * UNE SEULE REGLE POUR L'INSTANT, ET C'EST DELIBERE : une portion dont le revetement est
 * declare bitumineux et dont l'etat est NON_EVALUE n'est pas incoherente, seulement
 * incomplete. Les vraies incoherences metier (un bitume neuf declare impraticable, par
 * exemple) demandent le referentiel de praticabilite, qui n'a pas de valeurs.
 *
 * Inventer des regles supplementaires produirait des anomalies qu'aucune decision
 * d'AGEROUTE ne soutient, et le rapport perdrait sa credibilite des la premiere lecture.
 */
export function attributsIncoherents(
  portions: readonly PortionExaminee[],
  _refs: ReferentielFlags,
): Anomalie[] {
  return portions
    .filter((p) => p.remplaceeLe === null && p.deletedAt === null)
    // Une portion VALIDEE qui ne dit ni revetement ni etat ne qualifie rien : elle occupe
    // des metres dans le referentiel officiel sans rien y affirmer.
    .filter((p) => p.statutValidation === "VALIDE" && p.revetement === null && p.etat === null)
    .map((p) => ({
      famille: "ATTRIBUTS_INCOHERENTS" as const,
      entityType: "Portion",
      entityId: p.id,
      explication:
        "Portion VALIDEE sans revetement ni etat : elle occupe des metres du referentiel"
        + " officiel sans rien affirmer.",
      mesure: Math.round(p.finM - p.debutM),
    }));
}

/**
 * Inspections perimees.
 *
 * `fraicheurMaxJours` est un PARAMETRE. Le cahier ne dit pas a partir de quand une
 * inspection est trop ancienne, et le figer ici en ferait la norme d'AGEROUTE par defaut.
 * Meme regle que pour les coefficients du RCI.
 *
 * Une date ABSENTE est perimee, pas fraiche : un ouvrage dont on ne sait pas quand il a ete
 * inspecte n'a pas ete inspecte recemment, il n'a pas ete documente.
 */
export function inspectionsPerimees(
  actifs: readonly { id: string; type: string; derniereInspectionLe: Date | null }[],
  fraicheurMaxJours: number,
  maintenant: Date = new Date(),
): Anomalie[] {
  const JOUR_MS = 24 * 60 * 60 * 1000;
  return actifs
    .map((a): Anomalie | null => {
      if (a.derniereInspectionLe === null) {
        return {
          famille: "INSPECTION_PERIMEE" as const,
          entityType: "Ouvrage",
          entityId: a.id,
          explication: `${a.type} sans aucune date d'inspection enregistree.`,
          mesure: null,
        };
      }
      const jours = Math.floor((maintenant.getTime() - a.derniereInspectionLe.getTime()) / JOUR_MS);
      if (jours <= fraicheurMaxJours) return null;
      return {
        famille: "INSPECTION_PERIMEE" as const,
        entityType: "Ouvrage",
        entityId: a.id,
        explication: `${a.type} inspecte il y a ${jours} jours, seuil ${fraicheurMaxJours}.`,
        mesure: jours,
      };
    })
    .filter((x): x is Anomalie => x !== null);
}
