import type { SourceType, NiveauConfiance } from "@prisma/client";

/**
 * Deduction de provenance pour la REPRISE, a partir du code du troncon.
 *
 * POURQUOI CE CODE EST ICI ET PLUS DANS `src/lib/provenance.ts`
 *
 * Il y etait. Le commit 4eb1525 (« La provenance suit desormais toute ecriture
 * applicative ») a reecrit ce module pour un autre besoin : tracer les ecritures venant
 * de l'interface, dans la meme transaction que la valeur. Ce faisant il a supprime
 * `provenanceDepuisCode` et `planifierProvenance`, sans voir que
 * `scripts/backfill-provenance.ts` les importait.
 *
 * Consequence restee invisible du 04/09/2026 au 12/10/2026 : le script ne compilait pas
 * et ne demarrait meme pas, puisque l'import echouait. `typecheck:scripts` le disait,
 * mais ce script n'est pas appele par la verification du backend.
 *
 * La separation est en realite la bonne. Deduire une provenance depuis un code est une
 * operation de REPRISE d'un existant non trace ; enregistrer la provenance d'une saisie
 * est une operation d'EXPLOITATION. La premiere ne doit pas vivre dans le chemin chaud
 * de l'application, ou elle donnerait l'idee de l'y appeler.
 *
 * CE QUE CES REGLES VALENT
 *
 * Elles ont ete eprouvees sur la TOTALITE des 1 690 codes reels, pas sur un echantillon.
 * La regle urbaine a d'abord ete ecrite pour le seul prefixe DI, et seize codes de meme
 * forme restaient non reconnus ; c'est la raison de tester une deduction sur l'ensemble
 * des donnees.
 *
 * Aucune de ces regles n'est une verite : ce sont des lectures de forme, chacune avec
 * son motif et sa confiance, et le motif est conserve en base pour qu'on puisse revenir
 * dessus.
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
  // Confiance MEDIUM : la forme est constante et la classe homogene, mais ce que designe
  // le prefixe — vraisemblablement une commune — n'est pas etabli. Le rattachement au
  // lot est probable, sa signification ne l'est pas.
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
 * Separer la decision de l'ecriture permet trois choses : montrer a blanc ce qui va se
 * passer, garantir qu'un second passage ne reecrit rien, et eprouver la logique sans
 * base de donnees.
 */
export function planifierProvenance(troncons: TronconProvenance[]): PlanProvenance {
  const aEcrire: PlanProvenance["aEcrire"] = [];
  const stats = new Map<string, { total: number; aEcrire: number; motif: string }>();

  for (const t of troncons) {
    const provenance = provenanceDepuisCode(t.code);
    const cle = provenance.sourceReference ?? "(inconnue)";
    const s = stats.get(cle) ?? { total: 0, aEcrire: 0, motif: provenance.motif };
    s.total++;

    // Idempotence : un troncon deja porteur de cette provenance est laisse tel quel, ce
    // qui preserve aussi la date de la deduction d'origine.
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
