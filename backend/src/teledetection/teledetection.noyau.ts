/**
 * Noyau de l'observation de la Terre (partie E du mandat V10). Aucune importation.
 *
 * CE QU'IL DECIDE : si un produit peut entrer au registre, si une proposition peut recevoir un
 * verdict, si une mission de verification peut lui etre depechee. Les memes regles sont tenues
 * en base ; le noyau les dit avant elle, pour rendre un message clair.
 *
 * LE TERRAIN RESTE JUGE. Une proposition de teledetection est A_VERIFIER jusqu'a ce qu'un constat
 * de terrain la confirme ou l'infirme ; ce verdict cite le constat et ne se reprend pas. Aucune
 * proposition ne modifie le referentiel : elle n'en a pas le moyen.
 *
 * CE QU'IL NE DECIDE PAS : aucun seuil de score n'est ecrit. Un score est ce que la methode rend,
 * pas une probabilite d'exactitude ; la precision se mesure apres coup, contre le terrain.
 */

export const NATURES_PRODUIT = ["OPTIQUE", "RADAR", "ALTIMETRIE", "PRECIPITATIONS", "POPULATION", "INONDATION", "ROUTES_EXTRAITES"] as const;
export type NatureProduit = (typeof NATURES_PRODUIT)[number];

export const TYPES_PROPOSITION = ["NOUVELLE_ROUTE", "COUPURE_PROBABLE", "VEGETATION", "INONDATION"] as const;
export type TypeProposition = (typeof TYPES_PROPOSITION)[number];

export type StatutProposition = "A_VERIFIER" | "CONFIRMEE" | "INFIRMEE";

export interface ProduitSaisi {
  palier: number;
  source: string;
  nature: string;
  dateAcquisition: Date;
  dateFin?: Date | null;
  resolutionM: number;
  couvertureNuagesPct?: number | null;
  incertitude: string;
  provenance: string;
  licence: string;
  versionTraitement: string;
  autorisationDepenseRef?: string | null;
}

export type Verdict = { ok: true } | { ok: false; code: string; motif: string };

const vide = (s: string | null | undefined) => typeof s !== "string" || s.trim().length === 0;

export function verifierProduit(p: ProduitSaisi): Verdict {
  if (!Number.isInteger(p.palier) || p.palier < 0 || p.palier > 3) return { ok: false, code: "PALIER_INVALIDE", motif: "Palier : 0 (libre) a 3." };
  if (!(NATURES_PRODUIT as readonly string[]).includes(p.nature)) return { ok: false, code: "NATURE_INVALIDE", motif: `Nature : ${NATURES_PRODUIT.join(", ")}.` };
  if (!(p.resolutionM > 0)) return { ok: false, code: "RESOLUTION_INVALIDE", motif: "La resolution est un nombre de metres strictement positif." };
  for (const [champ, v] of [["source", p.source], ["incertitude", p.incertitude], ["provenance", p.provenance], ["licence", p.licence], ["versionTraitement", p.versionTraitement]] as const) {
    if (vide(v)) return { ok: false, code: "CHAMP_MANQUANT", motif: `Le champ ${champ} est obligatoire : un produit se trace, et sa licence se releve a la source.` };
  }
  if (p.couvertureNuagesPct != null && (p.couvertureNuagesPct < 0 || p.couvertureNuagesPct > 100)) {
    return { ok: false, code: "NUAGES_HORS_BORNES", motif: "La couverture nuageuse est un pourcentage, de 0 a 100." };
  }
  if (p.nature === "OPTIQUE" && p.couvertureNuagesPct == null) {
    return { ok: false, code: "NUAGES_REQUIS", motif: "Un produit optique porte sa couverture nuageuse." };
  }
  if (p.palier > 0 && vide(p.autorisationDepenseRef)) {
    return { ok: false, code: "DEPENSE_NON_AUTORISEE", motif: "Un produit d'un palier payant porte la reference de l'autorisation de depense (paragraphes A.5-6)." };
  }
  if (p.dateFin && p.dateFin < p.dateAcquisition) return { ok: false, code: "PERIODE_INVERSEE", motif: "La fin de la periode suit son debut." };
  return { ok: true };
}

export function verifierVerdict(
  statutActuel: StatutProposition,
  verdict: { statut: string; motif?: string | null; constatRef?: string | null },
): Verdict {
  if (statutActuel !== "A_VERIFIER") {
    return { ok: false, code: "VERDICT_DEJA_RENDU", motif: `Le terrain a deja juge (${statutActuel}) : le verdict ne se reprend pas.` };
  }
  if (verdict.statut !== "CONFIRMEE" && verdict.statut !== "INFIRMEE") {
    return { ok: false, code: "VERDICT_INVALIDE", motif: "Verdict : CONFIRMEE ou INFIRMEE." };
  }
  if (vide(verdict.motif) || vide(verdict.constatRef)) {
    return { ok: false, code: "CONSTAT_REQUIS", motif: "Un verdict cite le constat de terrain qui le fonde, et dit pourquoi." };
  }
  return { ok: true };
}

export function verifierDepecheVerification(p: { statut: StatutProposition; missionId: string | null }): Verdict {
  if (p.statut !== "A_VERIFIER") return { ok: false, code: "VERDICT_DEJA_RENDU", motif: "La proposition est deja jugee : rien a verifier." };
  if (p.missionId) return { ok: false, code: "MISSION_DEJA_DEPECHEE", motif: "Une mission de verification est deja rattachee a cette proposition." };
  return { ok: true };
}

/**
 * Comparaison de deux dates : le produit de reference est acquis STRICTEMENT avant le produit
 * analyse, et c'est un autre produit. La base le tient aussi (`propositions_teledetection_coherence`).
 */
export function verifierDeuxDates(produit: { id: string; dateAcquisition: Date }, reference: { id: string; dateAcquisition: Date } | null): Verdict {
  if (!reference) return { ok: true };
  if (reference.id === produit.id) return { ok: false, code: "REFERENCE_IDENTIQUE", motif: "La reference d'une comparaison de deux dates est un autre produit." };
  if (reference.dateAcquisition.getTime() >= produit.dateAcquisition.getTime()) {
    return { ok: false, code: "REFERENCE_NON_ANTERIEURE", motif: "Le produit de reference doit etre acquis avant le produit analyse." };
  }
  return { ok: true };
}

/** Code d'une mission de verification de teledetection : VER-TD-<8 premiers caracteres>. */
export function codeMissionTeledetection(propositionId: string): string {
  return `VER-TD-${propositionId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
