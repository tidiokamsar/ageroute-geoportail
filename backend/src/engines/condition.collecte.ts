/**
 * Collecte des composantes du RCI depuis les sources de la base.
 *
 * CE QUE CE MODULE FAIT, ET CE QU'IL REFUSE
 *
 * Il lit ce que la base porte, applique la CORRESPONDANCE DECLAREE DANS LA REGLE, et rend
 * des entrees que `calculerRci` sait consommer. Il ne decide d'aucun nombre : si la regle ne
 * dit pas ce que vaut un etat `BON`, la composante est ABSENTE, pas zero.
 *
 * LA DISTINCTION QUI PORTE TOUT
 *
 *   valeur lue + correspondance connue  ->  composante utilisable
 *   valeur lue + correspondance absente ->  ABSENTE, et le moteur renormalise sans elle
 *   aucune valeur lue                   ->  ABSENTE
 *
 * Confondre les deux derniers cas avec « zero » ferait chuter le score d'un troncon pour une
 * raison qui n'a rien a voir avec la route. C'est le meme refus que celui de
 * `engines/condition.ts`, tenu une couche plus bas.
 *
 * CE MODULE EST PUR
 *
 * Il recoit les donnees deja lues. Les requetes vivent dans `condition.collecte.prisma.ts`.
 * C'est la cinquieme fois dans ce programme qu'un module de regles doit etre extrait pour
 * pouvoir etre eprouve sans base, et la raison ne change pas : ce qui est difficile ici est
 * le RAISONNEMENT, pas la requete.
 *
 * MESURE DU 13/10/2026, QUI EXPLIQUE POURQUOI AUCUN SCORE NE SORTIRA ENCORE
 *
 *   CHAUSSEE       6 840 troncons sur 261 387 portent un etat, soit 2,6 %
 *   TRAFIC         0 sur 261 387
 *   OUVRAGES       0 des 1 172 ouvrages n'a de date d'inspection
 *   DRAINAGE       0 defaut enregistre
 *   SIGNALISATION  0 defaut enregistre
 *   SECURITE       0 defaut enregistre
 *   HISTORIQUE     aucune source
 *   INCIDENTS      aucune source
 *   ENVIRONNEMENT  aucune source
 *   AUTRES         aucune source POSSIBLE, faute de definition
 *
 * Un troncon n'atteint donc que les 30 points de la chaussee, soit 30 % du modele, et la
 * couverture minimale de 0,5 fait REFUSER le score. C'est le comportement correct : le
 * verrou n'est pas la ponderation, c'est la collecte.
 */
import type { ComposanteRci, EntreeComposante } from "./condition";

/** Ce que la regle dit : { COMPOSANTE: { "valeur source": 0-100 } }. */
export type TableNormalisation = Partial<Record<ComposanteRci, Record<string, number>>>;

/** Etat d'un troncon, tel que la base le porte. */
export interface SourcesTroncon {
  /** `etat` du troncon, vocabulaire `EtatPatrimoine`. Nul quand absent. */
  etatTroncon: string | null;
  /** Date de la derniere evaluation de cet etat. Nulle quand inconnue. */
  etatEvalueLe: Date | null;
  /** Trafic moyen journalier annuel. Nul sur la totalite du reseau au 13/10/2026. */
  traficMoyenJma: number | null;
  traficDateComptage: Date | null;
  /** Portions VALIDEES couvrant le troncon, pour l'etat de chaussee le plus fiable. */
  portionsValidees: readonly {
    debutM: number; finM: number;
    etat: string | null; observeeLe: Date | null; confiance: string | null;
  }[];
  /** Ouvrages rattaches, avec leur etat et la date de leur derniere inspection. */
  ouvrages: readonly { etat: string | null; derniereInspectionLe: Date | null }[];
  /**
   * Defauts actifs, groupes par famille de catalogue.
   *
   * La famille fait le lien avec la composante : ASSAINISSEMENT alimente DRAINAGE,
   * SIGNALISATION alimente SIGNALISATION, et ainsi de suite. Le detail de ce lien est dans
   * `COMPOSANTE_PAR_FAMILLE`.
   */
  defautsParFamille: Readonly<Record<string, { nombre: number; dernierLe: Date | null }>>;
}

/**
 * Quelle famille de defaut alimente quelle composante.
 *
 * DECLARE ICI ET NON DANS LA REGLE, contrairement aux nombres. La correspondance
 * famille-composante est une question de SENS — un defaut d'assainissement parle du drainage
 * — pas de ponderation. La changer serait changer ce que le mot « drainage » designe, ce
 * qu'aucun arbitrage de coefficients ne fait.
 *
 * Les familles absentes de cette table n'alimentent aucune composante, et c'est explicite :
 * CHAUSSEE et ACCOTEMENT decrivent la chaussee, mais leur traduction en score passe par
 * l'etat des portions, pas par un comptage de defauts.
 */
export const COMPOSANTE_PAR_FAMILLE: Readonly<Record<string, ComposanteRci>> = {
  ASSAINISSEMENT: "DRAINAGE",
  SIGNALISATION: "SIGNALISATION",
  OUVRAGE: "OUVRAGES",
  ENVIRONNEMENT: "ENVIRONNEMENT",
};

/**
 * Traduit une valeur de source en score, selon la regle.
 *
 * Rend `null` quand la regle ne connait pas cette valeur. C'est le coeur du refus : une
 * valeur illisible n'est pas une mauvaise valeur.
 */
export function normaliser(
  table: TableNormalisation,
  composante: ComposanteRci,
  valeurSource: string | null,
): number | null {
  if (valeurSource === null) return null;
  const pourComposante = table[composante];
  if (!pourComposante) return null;
  const v = pourComposante[valeurSource];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return v;
}

/**
 * Etat de chaussee le plus fiable disponible, et d'ou il vient.
 *
 * LES PORTIONS VALIDEES PRIMENT SUR L'ETAT DU TRONCON, et c'est le point.
 *
 * `troncons.etat` est une valeur DECLAREE, portee par la fiche, et NON_EVALUE sur 254 547
 * des 261 387 lignes. Une portion validee est une observation de terrain, datee, attribuee
 * et validee par un tiers. Quand les deux existent, la seconde est meilleure, et le dire
 * dans le code evite que quelqu'un s'etonne plus tard d'un score qui ne suit pas la fiche.
 *
 * Quand plusieurs portions couvrent le troncon, l'etat retenu est celui de la portion la
 * plus LONGUE : moyenner des codes d'etat n'a pas de sens, et prendre la pire ferait d'un
 * seul kilometre critique l'etat de vingt.
 */
export function etatChausseeRetenu(s: SourcesTroncon): {
  valeur: string | null;
  observeeLe: Date | null;
  confiance: string | null;
  source: string;
} {
  const avecEtat = s.portionsValidees.filter((p) => p.etat !== null);
  if (avecEtat.length > 0) {
    const plusLongue = avecEtat.reduce((a, b) =>
      (b.finM - b.debutM) > (a.finM - a.debutM) ? b : a);
    return {
      valeur: plusLongue.etat,
      observeeLe: plusLongue.observeeLe,
      confiance: plusLongue.confiance,
      source: "portion_validee",
    };
  }
  return {
    valeur: s.etatTroncon,
    observeeLe: s.etatEvalueLe,
    // Une valeur DECLAREE n'est pas une valeur CONSTATEE. La confiance le dit, et le moteur
    // s'en sert pour degrader la confiance du score.
    confiance: s.etatTroncon === null ? null : "LOW",
    source: "etat_declare_troncon",
  };
}

/**
 * Construit les entrees du moteur depuis les sources.
 *
 * Rend une entree pour CHAQUE composante que la regle pondere, meme absente : le moteur a
 * besoin de savoir qu'une composante attendue manque, pour la nommer dans son explication.
 */
export function collecter(
  s: SourcesTroncon,
  composantesPonderees: readonly ComposanteRci[],
  table: TableNormalisation,
): EntreeComposante[] {
  const chaussee = etatChausseeRetenu(s);

  return composantesPonderees.map((composante): EntreeComposante => {
    switch (composante) {
      case "CHAUSSEE":
        return {
          composante,
          valeur: normaliser(table, composante, chaussee.valeur),
          observeeLe: chaussee.observeeLe,
          confiance: lireConfiance(chaussee.confiance),
          source: chaussee.valeur === null ? null : chaussee.source,
        };

      case "TRAFIC":
        // Le trafic est un NOMBRE, pas un code : sa normalisation ne passe donc pas par la
        // table valeur-vers-score. Sans regle de seuils declaree, il reste ABSENT plutot
        // que converti par une formule que personne n'a validee.
        return {
          composante,
          valeur: null,
          observeeLe: s.traficDateComptage,
          confiance: null,
          source: s.traficMoyenJma === null ? null : "trafic_jma_non_normalisable",
        };

      case "OUVRAGES": {
        // Le pire etat d'ouvrage gouverne, et c'est voulu : un seul pont critique rend le
        // troncon critique pour qui le franchit. Moyenner diluerait exactement le risque
        // qu'on cherche a voir.
        const etats = s.ouvrages
          .map((o) => ({ score: normaliser(table, composante, o.etat), le: o.derniereInspectionLe }))
          .filter((x): x is { score: number; le: Date | null } => x.score !== null);
        if (etats.length === 0) {
          return { composante, valeur: null, observeeLe: null, confiance: null, source: null };
        }
        const pire = etats.reduce((a, b) => (b.score < a.score ? b : a));
        return {
          composante, valeur: pire.score, observeeLe: pire.le,
          confiance: pire.le === null ? null : "MEDIUM",
          source: `pire_de_${etats.length}_ouvrages`,
        };
      }

      default: {
        // Les composantes alimentees par des defauts : DRAINAGE, SIGNALISATION,
        // ENVIRONNEMENT. Un comptage de defauts n'est pas un score ; sa conversion demande
        // une regle de seuils que la regle ne porte pas encore. ABSENTE, donc, plutot
        // qu'inventee.
        const famille = Object.keys(COMPOSANTE_PAR_FAMILLE)
          .find((f) => COMPOSANTE_PAR_FAMILLE[f] === composante);
        const compte = famille ? s.defautsParFamille[famille] : undefined;
        return {
          composante,
          valeur: null,
          observeeLe: compte?.dernierLe ?? null,
          confiance: null,
          source: compte && compte.nombre > 0 ? `${compte.nombre}_defauts_non_normalisables` : null,
        };
      }
    }
  });
}

function lireConfiance(v: string | null): "HIGH" | "MEDIUM" | "LOW" | null {
  return v === "HIGH" || v === "MEDIUM" || v === "LOW" ? v : null;
}

/**
 * Pourquoi aucun score n'est calculable, en une phrase utilisable.
 *
 * Rendue a cote du refus du moteur, qui dit « couverture insuffisante » sans dire quoi
 * collecter. Celle-ci nomme les composantes a alimenter, ce qui transforme un refus en
 * liste de travail.
 */
export function diagnostic(entrees: readonly EntreeComposante[]): string {
  const lisibles = entrees.filter((e) => e.valeur !== null).map((e) => e.composante);
  const vues = entrees.filter((e) => e.valeur === null && e.source !== null);
  const absentes = entrees.filter((e) => e.valeur === null && e.source === null);

  const morceaux: string[] = [];
  morceaux.push(lisibles.length > 0
    ? `${lisibles.length} composante(s) exploitable(s) : ${lisibles.join(", ")}`
    : "aucune composante exploitable");
  if (vues.length > 0) {
    // La distinction qui rend ce diagnostic utile : une donnee PRESENTE mais non
    // normalisable demande une regle, pas une mission de terrain.
    morceaux.push(
      `${vues.length} donnee(s) presente(s) mais non normalisable(s), il manque la regle : `
      + vues.map((e) => e.composante).join(", "),
    );
  }
  if (absentes.length > 0) {
    morceaux.push(
      `${absentes.length} composante(s) sans aucune donnee, il manque la collecte : `
      + absentes.map((e) => e.composante).join(", "),
    );
  }
  return morceaux.join(". ") + ".";
}
