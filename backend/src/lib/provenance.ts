import type { SourceType, NiveauConfiance } from "@prisma/client";

/**
 * Deduit la provenance d'un troncon depuis son code.
 *
 * POURQUOI C'EST POSSIBLE
 *
 * Le journal d'audit contient 1 155 modifications de troncons et ZERO creation : les
 * 1 690 troncons sont entres par un chemin qui n'ecrit pas dans le journal. Leur
 * origine n'etait donc consignee nulle part.
 *
 * Elle est pourtant lisible dans le code, qui porte la marque de son lot d'import.
 * Mesure du 01/09/2026 sur les 1 690 troncons :
 *
 *   famille              classe   nb   longueur saisie   PK exploitable
 *   RES-*                RR    1 028         0 / 1 028        0 / 1 028
 *   GN N*                RN      551       551 / 551        551 / 551
 *   *-OSM-*              RN       70        70 / 70            0 / 70
 *   suffixe -w<chiffres> RU       20        20 / 20            0 / 20
 *   DI* sans suffixe     RU        4         4 / 4             0 / 4
 *   autre                RU       16        16 / 16            0 / 16
 *   code « test »        RR        1         1 / 1             0 / 1
 *
 * Le decoupage n'est pas cosmetique : il explique entierement le probleme des
 * longueurs nulles, qui coincide EXACTEMENT avec la famille RES-*, et celui des PK,
 * exploitables sur la seule famille GN N*.
 *
 * DEDUIT N'EST PAS DOCUMENTE
 *
 * `IMPORT_CODE_PATTERN` dit « provenance deduite du prefixe », jamais « provenance
 * documentee ». Ce que le prefixe designe est un LOT D'IMPORT ; ce que recouvre
 * reellement « RES-* » reste a etablir aupres d'AGEROUTE. La confiance porte donc sur
 * le rattachement au lot, pas sur l'identification de la source primaire.
 *
 * LE SUFFIXE -w<chiffres>
 *
 * `w` suivi de chiffres est la notation OpenStreetMap d'un identifiant de way
 * (`DI 002-w1096262465`). Ces 20 troncons urbains viennent donc d'OSM eux aussi, par
 * un nommage different des 70 nationales en `*-OSM-*`. Le depot porte d'ailleurs un
 * script `merge:osm-routes` qui corrobore cette lecture.
 */

export interface ProvenanceDeduite {
  sourceType: SourceType;
  /** Le motif reconnu, tel qu'il sera lisible en base. Null quand rien n'est reconnu. */
  sourceReference: string | null;
  sourceConfidence: NiveauConfiance;
  /** Ce qui a motive la deduction, pour l'audit et pour l'ecran de qualite. */
  motif: string;
}

const INCONNUE: ProvenanceDeduite = {
  sourceType: "INCONNUE",
  sourceReference: null,
  sourceConfidence: "LOW",
  motif: "aucun motif reconnu dans le code",
};

export function provenanceDepuisCode(code: string | null | undefined): ProvenanceDeduite {
  if (!code) return INCONNUE;
  const c = code.trim();
  if (!c) return INCONNUE;

  // Enregistrement d'essai laisse en production. Il porte le nom « RN2 », la classe RR
  // et 56,4 km — et c'est l'UNIQUE regionale avec une longueur saisie. Le signaler
  // plutot que de le ranger dans une famille d'import lui donnerait une legitimite
  // qu'il n'a pas.
  if (c.toLowerCase() === "test") {
    return {
      sourceType: "INCONNUE",
      sourceReference: null,
      sourceConfidence: "LOW",
      motif: "code d'essai — enregistrement a examiner, non un lot d'import",
    };
  }

  // OSM d'abord : le motif est le plus specifique et le mieux corrobore (script
  // merge:osm-routes dans le depot).
  if (c.includes("-OSM-")) {
    return {
      sourceType: "IMPORT_CODE_PATTERN",
      sourceReference: "OSM",
      sourceConfidence: "HIGH",
      motif: "le code porte le marqueur -OSM-",
    };
  }

  // `w` + chiffres en fin de code : notation OpenStreetMap d'un identifiant de way.
  if (/-w\d+$/.test(c)) {
    return {
      sourceType: "IMPORT_CODE_PATTERN",
      sourceReference: "OSM",
      sourceConfidence: "HIGH",
      motif: "le code se termine par un identifiant de way OSM (-w<chiffres>)",
    };
  }

  if (c.startsWith("RES-")) {
    return {
      sourceType: "IMPORT_CODE_PATTERN",
      sourceReference: "RES-*",
      sourceConfidence: "HIGH",
      motif: "1 028 troncons partagent ce prefixe, tous regionaux, aucun avec longueur saisie",
    };
  }

  if (c.startsWith("GN N")) {
    return {
      sourceType: "IMPORT_CODE_PATTERN",
      sourceReference: "GN N*",
      sourceConfidence: "HIGH",
      motif: "551 troncons partagent ce prefixe, seule famille dont les PK sont exploitables",
    };
  }

  // Deux lettres majuscules, un point facultatif, un nombre : DI 002, KA 004, MA 006,
  // RO. 001. Vingt troncons, TOUS urbains, repartis en quatre prefixes.
  //
  // La regle a d'abord ete ecrite pour le seul prefixe DI, puis elargie apres l'avoir
  // eprouvee sur les 1 690 codes reels : seize codes de meme forme restaient non
  // reconnus. C'est la raison de tester une regle de deduction sur la totalite des
  // donnees plutot que sur un echantillon.
  //
  // Confiance MEDIUM : la forme est constante et la classe homogene, mais ce que
  // designe le prefixe — vraisemblablement une commune — n'est pas etabli. Le
  // rattachement au lot est probable, sa signification ne l'est pas.
  const prefixeUrbain = c.match(/^([A-Z]{2})\.?\s+\d/);
  if (prefixeUrbain) {
    return {
      sourceType: "IMPORT_CODE_PATTERN",
      sourceReference: `${prefixeUrbain[1]}*`,
      sourceConfidence: "MEDIUM",
      motif: `prefixe ${prefixeUrbain[1]}, famille urbaine de faible effectif, signification non etablie`,
    };
  }

  return INCONNUE;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Etat de provenance d'un troncon tel qu'il est en base avant remplissage. */
export interface TronconProvenance {
  id: string;
  code: string;
  sourceType: SourceType | null;
  sourceReference: string | null;
  sourceConfidence: NiveauConfiance | null;
}

export interface PlanProvenance {
  /** Les seuls troncons a mettre a jour : ceux dont la provenance differe. */
  aEcrire: { id: string; code: string; provenance: ProvenanceDeduite }[];
  /** Repartition par famille, pour que l'operateur voie ce qu'il s'apprete a faire. */
  parReference: { reference: string; total: number; aEcrire: number; motif: string }[];
  total: number;
}

/**
 * Prepare le remplissage sans rien ecrire.
 *
 * Separer la decision de l'ecriture permet trois choses : montrer a blanc ce qui va
 * se passer, garantir qu'un second passage ne reecrit rien, et eprouver la logique
 * sans base de donnees.
 */
export function planifierProvenance(troncons: TronconProvenance[]): PlanProvenance {
  const aEcrire: PlanProvenance["aEcrire"] = [];
  const stats = new Map<string, { total: number; aEcrire: number; motif: string }>();

  for (const t of troncons) {
    const provenance = provenanceDepuisCode(t.code);
    const cle = provenance.sourceReference ?? "(inconnue)";
    const s = stats.get(cle) ?? { total: 0, aEcrire: 0, motif: provenance.motif };
    s.total++;

    // Idempotence : un troncon deja porteur de cette provenance est laisse tel quel,
    // ce qui preserve aussi la date de la deduction d'origine.
    const inchange =
      t.sourceType === provenance.sourceType &&
      t.sourceReference === provenance.sourceReference &&
      t.sourceConfidence === provenance.sourceConfidence;

    if (!inchange) {
      s.aEcrire++;
      aEcrire.push({ id: t.id, code: t.code, provenance });
    }
    stats.set(cle, s);
  }

  return {
    aEcrire,
    parReference: [...stats.entries()]
      .map(([reference, s]) => ({ reference, ...s }))
      .sort((a, b) => b.total - a.total),
    total: troncons.length,
  };
}
