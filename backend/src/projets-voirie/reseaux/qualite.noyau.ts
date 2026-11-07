/**
 * QUALITE D'UN OBJET ET ETAT VERTICAL (noyau pur, lot B1).
 *
 * REGLES (cahier v2, 5.2, 5.3, 20.2, 21.1) :
 *   - la precision, la classe, la profondeur et l'altitude sont DECLAREES par la source ou par une personne : jamais deduites, jamais
 *     completees par une valeur « standard ». Absente, la valeur reste nulle ;
 *   - la precision horizontale et la precision verticale sont separees ; un point planimetrique n'est jamais une certitude verticale ;
 *   - une profondeur ou une altitude sans reference verticale est incomplete : un nombre sans repere ne se compare a rien ;
 *   - AUCUNE conclusion 3D n'est produite dans ce lot : l'evaluation verticale n'existe pas encore (lot 7 du cahier). `evaluable` vaut
 *     TOUJOURS faux, et la fonction le dit, meme quand toutes les donnees sont fournies.
 */

import { classeEffective, precisionHorizontaleEffective, type ClassePrecision, type OrigineValeur } from "./types.noyau";

export interface DonneesVerticales {
  /** Profondeur en metres (positive vers le bas) ; nulle = inconnue. */
  profondeurM: number | null;
  /** Altitude en metres ; nulle = inconnue. */
  altitudeM: number | null;
  /** Repere de la profondeur ou de l'altitude (ex. « terrain naturel »), texte libre ; nul = non precise. */
  referenceVerticale: string | null;
  precisionVerticaleM: number | null;
}

/**
 * - ABSENTE : ni profondeur ni altitude. Aucune conclusion 3D possible.
 * - INCOMPLETE : une valeur, mais pas de reference verticale : elle ne peut etre comparee a rien.
 * - FOURNIE : une valeur et sa reference. Les donnees existent ; l'evaluation 3D n'est pas implementee (`evaluable` reste faux).
 */
export type EtatVertical = "ABSENTE" | "INCOMPLETE" | "FOURNIE";

export interface EvaluationVerticale {
  etat: EtatVertical;
  /** Toujours faux dans ce lot : aucune evaluation 3D n'est implementee. */
  evaluable: false;
  /** Toujours nulle dans ce lot : aucun conflit 3D n'est conclu, ni son absence. */
  conclusion3D: null;
  motifs: string[];
}

export function evaluerVertical(d: DonneesVerticales): EvaluationVerticale {
  const motifs: string[] = [];
  const aValeur = d.profondeurM !== null || d.altitudeM !== null;
  let etat: EtatVertical;
  if (!aValeur) {
    etat = "ABSENTE";
    motifs.push("Profondeur et altitude absentes : aucune conclusion 3D.");
  } else if (d.referenceVerticale === null || d.referenceVerticale.trim() === "") {
    etat = "INCOMPLETE";
    motifs.push("Une profondeur ou une altitude est fournie sans référence verticale : elle ne peut être comparée à rien.");
  } else {
    etat = "FOURNIE";
    motifs.push("Données verticales fournies par la source ; l'évaluation 3D n'est pas implémentée dans ce lot.");
  }
  if (d.profondeurM === null) motifs.push("Profondeur inconnue.");
  if (d.altitudeM === null) motifs.push("Altitude inconnue.");
  if (d.precisionVerticaleM === null) motifs.push("Précision verticale non déclarée.");
  return { etat, evaluable: false, conclusion3D: null, motifs };
}

/** Descripteur tel que stocke (champs de qualite seulement). */
export interface QualiteDescripteur {
  classePrecision: ClassePrecision | null;
  precisionHorizontaleM: number | null;
  precisionVerticaleM: number | null;
  profondeurM: number | null;
  altitudeM: number | null;
  referenceVerticale: string | null;
}

export interface QualiteJeu {
  classePrecision: ClassePrecision | null;
  precisionHorizontaleM: number | null;
  precisionVerticaleM: number | null;
}

export interface QualiteEffective {
  classePrecision: ClassePrecision | null;
  origineClasse: OrigineValeur;
  precisionHorizontaleM: number | null;
  precisionVerticaleM: number | null;
  vertical: EvaluationVerticale & Pick<DonneesVerticales, "profondeurM" | "altitudeM" | "referenceVerticale">;
}

/** Qualite effective d'un objet : le descripteur d'abord, le jeu ensuite, jamais une valeur inventee. */
export function qualiteEffective(descripteur: QualiteDescripteur | null, jeu: QualiteJeu): QualiteEffective {
  const c = classeEffective(descripteur?.classePrecision, jeu.classePrecision);
  const precisionVerticaleM = descripteur?.precisionVerticaleM ?? jeu.precisionVerticaleM ?? null;
  const donnees: DonneesVerticales = {
    profondeurM: descripteur?.profondeurM ?? null, altitudeM: descripteur?.altitudeM ?? null,
    referenceVerticale: descripteur?.referenceVerticale ?? null, precisionVerticaleM,
  };
  return {
    classePrecision: c.classe, origineClasse: c.origine,
    precisionHorizontaleM: precisionHorizontaleEffective(descripteur?.precisionHorizontaleM, jeu.precisionHorizontaleM),
    precisionVerticaleM,
    vertical: { ...evaluerVertical(donnees), profondeurM: donnees.profondeurM, altitudeM: donnees.altitudeM, referenceVerticale: donnees.referenceVerticale },
  };
}

// ------------------------------------------------------------------------------------------------
// Coherence d'une declaration de qualite
// ------------------------------------------------------------------------------------------------

export type VerdictQualite = { ok: true } | { ok: false; code: "REFERENCE_VERTICALE_SANS_VALEUR" | "PRECISION_INCOHERENTE"; message: string };

/**
 * Coherence d'une declaration :
 *   - une reference verticale sans profondeur ni altitude ne reference rien (refusee) ;
 *   - une precision, quand elle est donnee, est strictement positive et bornee (verifie aussi par la base).
 */
export function verifierQualite(q: QualiteDescripteur): VerdictQualite {
  if (q.referenceVerticale !== null && q.profondeurM === null && q.altitudeM === null) {
    return { ok: false, code: "REFERENCE_VERTICALE_SANS_VALEUR", message: "Une référence verticale n'a de sens qu'avec une profondeur ou une altitude." };
  }
  for (const [nom, v] of [["precisionHorizontaleM", q.precisionHorizontaleM], ["precisionVerticaleM", q.precisionVerticaleM]] as const) {
    if (v !== null && !(v > 0 && v <= 100_000)) {
      return { ok: false, code: "PRECISION_INCOHERENTE", message: `${nom} doit être strictement positive et au plus 100 000 m.` };
    }
  }
  return { ok: true };
}
