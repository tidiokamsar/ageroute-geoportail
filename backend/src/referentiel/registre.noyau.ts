import { createHash } from "node:crypto";

/**
 * Noyau PUR du registre des anomalies du referentiel des troncons (BDRI, lot C).
 *
 * Aucune base, aucune horloge : tout ce qui decide (quelle regle, quelle gravite, quelle transition est
 * permise, quelle correction est recevable) est ici et se teste sans PostgreSQL. Les detecteurs SQL
 * (`registre.depot.ts`) ne font que CONSTATER des valeurs ; ils ne jugent pas.
 *
 * TROIS PRINCIPES, QUI VIENNENT DU CAHIER ET NON D'UN GOUT
 *
 *   1. Une anomalie est un CONSTAT, pas une erreur prouvee. « PK de fin inferieur au debut » peut traduire un
 *      sens de chainage ; deux traces proches peuvent etre deux chaussees. Le registre dit ce qu'il voit et
 *      laisse la decision a une personne.
 *   2. Rien n'est corrige sans une valeur cible DONNEE par une personne, avec sa justification et sa source.
 *      Le registre ne deduit jamais un PK de la longueur geometrique, ni une longueur officielle du trace.
 *   3. Rien n'est efface : une decision s'ajoute au journal, une anomalie qui ne se constate plus recoit
 *      `disparueLe`, une correction appliquee peut etre annulee tant que la valeur n'a pas rebouge.
 */

export const STATUTS = ["A_EXAMINER", "CORRECTION_PROPOSEE", "VALIDEE", "REJETEE", "CORRIGEE"] as const;
export type Statut = (typeof STATUTS)[number];
export type Gravite = "BLOQUANTE" | "MAJEURE" | "MINEURE" | "INFO";

/** Champs qu'une correction du registre peut toucher. L'etat routier n'y est pas : il a son propre circuit. */
export const CHAMPS_CORRIGEABLES = ["pkDebut", "pkFin", "longueurKm", "classe", "revetement"] as const;
export type ChampCorrigeable = (typeof CHAMPS_CORRIGEABLES)[number];

const CLASSES = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] as const;
const REVETEMENTS = ["BITUME", "TERRE", "LATERITE", "PAVE", "NON_RENSEIGNE"] as const;

export interface DefinitionRegle {
  libelle: string;
  gravite: Gravite;
  /** Ce que la regle constate, en une phrase, pour le rapport et l'ecran. */
  regle: string;
  /** Ce qui peut etre corrige depuis le registre. Vide : le constat s'examine, il ne se corrige pas ici. */
  champs: readonly ChampCorrigeable[];
}

/**
 * Le catalogue. Chaque regle porte sa version dans `source` (« controle:PK_NON_RENSEIGNES v1 ») : changer une
 * regle change sa version, et les anomalies deja enregistrees gardent la trace de la regle qui les a vues.
 */
export const REGLES = {
  PK_NON_RENSEIGNES: {
    libelle: "PK non renseignés",
    gravite: "MAJEURE",
    regle: "PK de début et de fin tous deux à 0 : la base les exige, 0 → 0 est la façon dont l'absence a été saisie.",
    champs: ["pkDebut", "pkFin"],
  },
  PK_NEGATIF: {
    libelle: "PK négatif",
    gravite: "MAJEURE",
    regle: "Un PK de début ou de fin est négatif.",
    champs: ["pkDebut", "pkFin"],
  },
  PK_FIN_AVANT_DEBUT: {
    libelle: "PK de fin inférieur au début",
    gravite: "MINEURE",
    regle: "PK de fin inférieur au PK de début. Peut traduire un sens de chaînage : à examiner, pas une erreur prouvée.",
    champs: ["pkDebut", "pkFin"],
  },
  ETENDUE_PK_LONGUEUR: {
    libelle: "Étendue des PK et longueur déclarée divergentes",
    gravite: "MINEURE",
    regle: "L'écart entre (PK fin − PK début) et la longueur déclarée dépasse le seuil choisi à l'analyse.",
    champs: ["pkDebut", "pkFin", "longueurKm"],
  },
  LONGUEUR_DECLAREE_NULLE: {
    libelle: "Longueur déclarée nulle ou négative",
    gravite: "MAJEURE",
    regle: "La longueur déclarée est inférieure ou égale à 0.",
    champs: ["longueurKm"],
  },
  ECART_LONGUEUR_GEOMETRIQUE: {
    libelle: "Longueur déclarée et longueur géométrique divergentes",
    gravite: "MINEURE",
    regle: "L'écart relatif entre la longueur déclarée et la longueur du tracé (géodésique) dépasse le seuil choisi à l'analyse. La longueur du tracé n'est pas une longueur officielle.",
    champs: ["longueurKm"],
  },
  GEOMETRIE_ABSENTE: {
    libelle: "Géométrie absente",
    gravite: "MAJEURE",
    regle: "Le tronçon n'a pas de tracé : il ne peut être ni localisé ni rattaché à un relevé GPS.",
    champs: [],
  },
  GEOMETRIE_INVALIDE: {
    libelle: "Géométrie invalide",
    gravite: "BLOQUANTE",
    regle: "ST_IsValid refuse le tracé ; la raison donnée par PostGIS est conservée.",
    champs: [],
  },
  GEOMETRIE_HORS_EMPRISE: {
    libelle: "Tracé hors de l'emprise nationale",
    gravite: "MAJEURE",
    regle: "La boîte englobante du tracé sort de l'emprise de la Guinée élargie d'une marge (coordonnées inversées, mauvais système de coordonnées).",
    champs: [],
  },
  SEGMENT_TRES_COURT: {
    libelle: "Tracé très court",
    gravite: "MINEURE",
    regle: "Le tracé mesure moins de 10 m : en deçà, on décrit la dérive du GPS, pas une route.",
    champs: [],
  },
  ATTRIBUTS_NON_RENSEIGNES: {
    libelle: "Attributs non renseignés",
    gravite: "MINEURE",
    regle: "Classe NON_CLASSEE ou revêtement NON_RENSEIGNE.",
    champs: ["classe", "revetement"],
  },
  DOUBLON_POTENTIEL: {
    libelle: "Doublon potentiel",
    gravite: "MAJEURE",
    regle: "Deux tronçons de la même région dont l'un couvre au moins 80 % du tracé de l'autre à 25 m près. Critères multiples (tracé, région, longueurs, PK) ; jamais une preuve, jamais une suppression.",
    champs: [],
  },
  NOM_IDENTIQUE: {
    libelle: "Nom identique, tracés distincts",
    gravite: "INFO",
    regle: "Même nom (sans accents ni casse) dans la même région, sans recouvrement de tracé. Un nom identique n'est pas un doublon.",
    champs: [],
  },
} as const satisfies Record<string, DefinitionRegle>;

export type CodeRegle = keyof typeof REGLES;
export const CODES_REGLES = Object.keys(REGLES) as CodeRegle[];

export const VERSION_REGLES = 1;
export const sourceDe = (regle: CodeRegle, precision?: string) =>
  `controle:${regle} v${VERSION_REGLES}${precision ? ` (${precision})` : ""}`;

/** JSON a cles triees : deux constats identiques donnent la meme empreinte, quel que soit l'ordre des cles. */
export function jsonStable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(jsonStable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jsonStable(o[k])}`).join(",")}}`;
}

export function empreinte(regle: CodeRegle, valeurs: Record<string, unknown>): string {
  return createHash("sha256").update(`${regle}|${jsonStable(valeurs)}`).digest("hex").slice(0, 32);
}

// ------------------------------------------------------------------ transitions

/**
 * Transitions par DECISION. `CORRIGEE` n'y figure pas en arrivee : on n'y entre que par l'application d'une
 * correction (route dediee, qui verifie la valeur courante) ; on n'en sort que par son annulation.
 */
export const TRANSITIONS: Record<Statut, readonly Statut[]> = {
  A_EXAMINER: ["CORRECTION_PROPOSEE", "VALIDEE", "REJETEE"],
  CORRECTION_PROPOSEE: ["VALIDEE", "REJETEE", "A_EXAMINER"],
  VALIDEE: ["CORRECTION_PROPOSEE", "A_EXAMINER"],
  REJETEE: ["A_EXAMINER"],
  CORRIGEE: [],
};

export interface CorrectionSaisie {
  champ: string;
  nouvelle: unknown;
  justification: string;
  source: string;
}

export interface Correction {
  champ: ChampCorrigeable;
  ancienne: number | string | null;
  nouvelle: number | string;
  justification: string;
  source: string;
  proposeeParId: string;
}

export type Refus = { ok: false; code: string; message: string };
const refus = (code: string, message: string): Refus => ({ ok: false, code, message });

/** La valeur proposee, ramenee a son type et verifiee. Aucune valeur n'est deduite : elle est donnee. */
export function valeurRecevable(champ: ChampCorrigeable, v: unknown): { ok: true; valeur: number | string } | Refus {
  if (champ === "classe" || champ === "revetement") {
    const permis: readonly string[] = champ === "classe" ? CLASSES : REVETEMENTS;
    if (typeof v !== "string" || !permis.includes(v)) return refus("VALEUR_HORS_REFERENTIEL", `${champ} : valeur attendue parmi ${permis.join(", ")}.`);
    return { ok: true, valeur: v };
  }
  const n = typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return refus("VALEUR_NON_NUMERIQUE", `${champ} : un nombre est attendu.`);
  if (champ === "longueurKm" && !(n > 0 && n <= 2000)) return refus("LONGUEUR_HORS_BORNES", "Longueur déclarée : strictement positive et au plus 2 000 km.");
  if ((champ === "pkDebut" || champ === "pkFin") && !(n >= 0 && n <= 2000)) return refus("PK_HORS_BORNES", "PK : de 0 à 2 000.");
  return { ok: true, valeur: Math.round(n * 1000) / 1000 };
}

export interface DecisionDemandee {
  statut: Statut;
  commentaire?: string | null;
  correction?: CorrectionSaisie | null;
}

/**
 * Juge une decision. Rend la correction a enregistrer (ou celle deja portee) ou le refus nomme.
 *
 * `valeurCourante` est la valeur du champ en base AU MOMENT de la proposition : elle devient `ancienne`, et
 * c'est contre elle que l'application verifiera qu'aucune autre ecriture n'est passee entre-temps.
 */
export function jugerDecision(p: {
  regle: CodeRegle;
  statutActuel: Statut;
  correctionActuelle: Correction | null;
  demande: DecisionDemandee;
  auteurId: string;
  valeurCourante: (champ: ChampCorrigeable) => number | string | null;
}): { ok: true; correction: Correction | null } | Refus {
  const { demande, statutActuel } = p;
  if (!TRANSITIONS[statutActuel].includes(demande.statut)) {
    return refus("TRANSITION_INTERDITE", `Passage de ${statutActuel} à ${demande.statut} non permis.`);
  }
  const commentaire = demande.commentaire?.trim() ?? "";
  if ((demande.statut === "REJETEE" || (statutActuel === "REJETEE" && demande.statut === "A_EXAMINER")) && commentaire.length < 5) {
    return refus("MOTIF_EXIGE", "Un rejet ou une réouverture se motive (5 caractères au moins).");
  }

  if (demande.statut === "CORRECTION_PROPOSEE") {
    const c = demande.correction;
    if (!c) return refus("CORRECTION_EXIGEE", "Une proposition de correction porte un champ, une valeur, une justification et une source.");
    const permis: readonly string[] = REGLES[p.regle].champs;
    if (!permis.includes(c.champ)) {
      return refus("CHAMP_NON_CORRIGEABLE", permis.length ? `Pour cette règle, seuls ${permis.join(", ")} se corrigent ici.` : "Cette anomalie s'examine ; elle ne se corrige pas depuis le registre.");
    }
    const champ = c.champ as ChampCorrigeable;
    const v = valeurRecevable(champ, c.nouvelle);
    if (!v.ok) return v;
    if ((c.justification?.trim() ?? "").length < 5) return refus("JUSTIFICATION_EXIGEE", "La justification est exigée (5 caractères au moins).");
    if ((c.source?.trim() ?? "").length < 3) return refus("SOURCE_EXIGEE", "La source de la valeur est exigée (document, relevé, référence).");
    const ancienne = p.valeurCourante(champ);
    if (ancienne === v.valeur) return refus("VALEUR_INCHANGEE", "La valeur proposée est déjà la valeur en base.");
    return { ok: true, correction: { champ, ancienne, nouvelle: v.valeur, justification: c.justification.trim(), source: c.source.trim(), proposeeParId: p.auteurId } };
  }

  // Valider une correction : par une AUTRE personne que celle qui l'a proposee (separation des roles, comme
  // la validation des portions). Valider sans correction confirme seulement que l'anomalie est reelle.
  if (demande.statut === "VALIDEE" && statutActuel === "CORRECTION_PROPOSEE" && p.correctionActuelle?.proposeeParId === p.auteurId) {
    return refus("AUTO_VALIDATION", "Une correction se valide par une autre personne que celle qui l'a proposée.");
  }
  if (demande.correction) return refus("CORRECTION_NON_ATTENDUE", "Seule une proposition de correction porte une correction.");
  // Revenir a l'examen ou rejeter retire la correction en cours ; valider la garde.
  return { ok: true, correction: demande.statut === "VALIDEE" ? p.correctionActuelle : null };
}

/** L'application exige une correction VALIDEE et une valeur courante identique a celle constatee a la proposition. */
export function jugerApplication(statut: Statut, correction: Correction | null, valeurCourante: number | string | null): { ok: true; correction: Correction } | Refus {
  if (statut !== "VALIDEE" || !correction) return refus("NON_APPLICABLE", "Seule une correction validée s'applique.");
  if (valeurCourante !== correction.ancienne) {
    return refus("VALEUR_A_CHANGE", `La valeur a changé depuis la proposition (constatée ${String(correction.ancienne)}, actuelle ${String(valeurCourante)}) : réexaminer avant d'appliquer.`);
  }
  return { ok: true, correction };
}

/** L'annulation rend l'ancienne valeur, seulement si personne n'a reecrit le champ depuis l'application. */
export function jugerAnnulation(statut: Statut, correction: Correction | null, valeurCourante: number | string | null): { ok: true; correction: Correction } | Refus {
  if (statut !== "CORRIGEE" || !correction) return refus("NON_ANNULABLE", "Seule une correction appliquée s'annule.");
  if (valeurCourante !== correction.nouvelle) {
    return refus("VALEUR_A_CHANGE", `Le champ a été réécrit depuis l'application (attendu ${String(correction.nouvelle)}, actuel ${String(valeurCourante)}) : l'annulation écraserait une autre écriture.`);
  }
  return { ok: true, correction };
}

// ------------------------------------------------------------------ export

/** Cellule CSV : guillemets si besoin, et neutralisation des formules (=, +, -, @, tabulation) pour le tableur. */
export function celluleCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function versCsv(colonnes: readonly string[], lignes: ReadonlyArray<Record<string, unknown>>): string {
  const corps = lignes.map((l) => colonnes.map((c) => celluleCsv(l[c])).join(";"));
  return `﻿${colonnes.join(";")}\n${corps.join("\n")}${corps.length ? "\n" : ""}`;
}

// ------------------------------------------------------------------ evaluation des attributs

/** Ce que le depot lit d'un troncon : des valeurs, aucun jugement. */
export interface AttributsTroncon {
  id: string;
  regionId: number | null;
  code: string;
  pkDebut: number;
  pkFin: number;
  longueurKm: number;
  classe: string;
  revetement: string;
  aGeometrie: boolean;
  geometrieValide: boolean | null;
  raisonInvalide: string | null;
  longueurGeometriqueM: number | null;
  emprise: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
}

export interface Constat {
  tronconId: string;
  regionId: number | null;
  regle: CodeRegle;
  valeurs: Record<string, unknown>;
  source: string;
}

export interface Seuils {
  /** Ecart relatif toleré entre longueur declaree et longueur du trace, en %. PARAMETRE de l'analyse, pas une norme. */
  ecartLongueurPct: number;
  /** Ecart relatif toleré entre l'etendue des PK et la longueur declaree, en %. */
  ecartPkPct: number;
}

/**
 * Emprise nationale ELARGIE : la Guinee s'etend d'environ 15,1 a 7,6 degres ouest et de 7,2 a 12,7 degres
 * nord ; la marge d'un demi-degre laisse passer les routes frontalieres. Ce n'est pas une frontiere (le
 * detecteur « hors territoire » du rapport de qualite la teste, et coute 20 s) : c'est un filet a coordonnees
 * inversees ou a mauvais systeme, qui placent un trace a des centaines de kilometres.
 */
export const EMPRISE_NATIONALE = { xmin: -15.6, ymin: 6.7, xmax: -7.1, ymax: 13.2 } as const;

const arrondi = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function constaterAttributs(t: AttributsTroncon, s: Seuils): Constat[] {
  const out: Constat[] = [];
  const c = (regle: CodeRegle, valeurs: Record<string, unknown>, precision?: string) =>
    out.push({ tronconId: t.id, regionId: t.regionId, regle, valeurs, source: sourceDe(regle, precision) });
  const pk = { pkDebut: t.pkDebut, pkFin: t.pkFin };

  if (t.pkDebut === 0 && t.pkFin === 0) c("PK_NON_RENSEIGNES", pk);
  else {
    if (t.pkDebut < 0 || t.pkFin < 0) c("PK_NEGATIF", pk);
    if (t.pkFin < t.pkDebut) c("PK_FIN_AVANT_DEBUT", pk);
    else if (t.pkFin > t.pkDebut && t.longueurKm > 0) {
      const etendue = t.pkFin - t.pkDebut;
      const ecart = Math.abs(etendue - t.longueurKm) / t.longueurKm * 100;
      if (ecart > s.ecartPkPct) c("ETENDUE_PK_LONGUEUR", { ...pk, etendueKm: arrondi(etendue), longueurKm: t.longueurKm, ecartPct: arrondi(ecart, 1), seuilPct: s.ecartPkPct }, `seuil ${s.ecartPkPct} %`);
    }
  }
  if (!(t.longueurKm > 0)) c("LONGUEUR_DECLAREE_NULLE", { longueurKm: t.longueurKm });

  if (!t.aGeometrie) c("GEOMETRIE_ABSENTE", {});
  else if (t.geometrieValide === false) c("GEOMETRIE_INVALIDE", { raison: t.raisonInvalide });
  else {
    const e = t.emprise;
    if (e && (e.xmin < EMPRISE_NATIONALE.xmin || e.xmax > EMPRISE_NATIONALE.xmax || e.ymin < EMPRISE_NATIONALE.ymin || e.ymax > EMPRISE_NATIONALE.ymax)) {
      c("GEOMETRIE_HORS_EMPRISE", { emprise: { xmin: arrondi(e.xmin, 4), ymin: arrondi(e.ymin, 4), xmax: arrondi(e.xmax, 4), ymax: arrondi(e.ymax, 4) } });
    }
    const lg = t.longueurGeometriqueM;
    if (lg !== null && lg < 10) c("SEGMENT_TRES_COURT", { longueurGeometriqueM: arrondi(lg, 1) });
    if (lg !== null && lg >= 10 && t.longueurKm > 0) {
      const km = lg / 1000;
      const ecart = Math.abs(km - t.longueurKm) / t.longueurKm * 100;
      if (ecart > s.ecartLongueurPct) {
        c("ECART_LONGUEUR_GEOMETRIQUE", { longueurKm: t.longueurKm, longueurGeometriqueKm: arrondi(km), ecartPct: arrondi(ecart, 1), seuilPct: s.ecartLongueurPct }, `seuil ${s.ecartLongueurPct} %, longueur géodésique`);
      }
    }
  }
  const nonRenseignes = [
    ...(t.classe === "NON_CLASSEE" ? ["classe"] : []),
    ...(t.revetement === "NON_RENSEIGNE" ? ["revetement"] : []),
  ];
  if (nonRenseignes.length) c("ATTRIBUTS_NON_RENSEIGNES", { champs: nonRenseignes });
  return out;
}

export interface PaireProche {
  a: string; b: string; regionId: number | null;
  codeA: string; codeB: string;
  archiveA: boolean; archiveB: boolean;
  longueurAM: number; longueurBM: number;
  couvertureA: number; couvertureB: number;
  pkA: [number, number]; pkB: [number, number];
}

/** Un doublon potentiel se constate sur LES DEUX troncons : chaque fiche doit le montrer. */
export function constaterPaire(p: PaireProche, toleranceM: number): Constat[] {
  const commun = { toleranceM, couvertureMax: arrondi(Math.max(p.couvertureA, p.couvertureB), 3) };
  const cote = (soi: "A" | "B"): Constat => {
    const autre = soi === "A" ? "B" : "A";
    return {
      tronconId: soi === "A" ? p.a : p.b,
      regionId: p.regionId,
      regle: "DOUBLON_POTENTIEL",
      valeurs: {
        ...commun,
        autreTronconId: soi === "A" ? p.b : p.a,
        autreCode: soi === "A" ? p.codeB : p.codeA,
        autreArchive: soi === "A" ? p.archiveB : p.archiveA,
        longueursM: { soi: arrondi(soi === "A" ? p.longueurAM : p.longueurBM, 1), autre: arrondi(soi === "A" ? p.longueurBM : p.longueurAM, 1) },
        pk: { soi: soi === "A" ? p.pkA : p.pkB, autre: autre === "A" ? p.pkA : p.pkB },
      },
      source: sourceDe("DOUBLON_POTENTIEL", `tampon ${toleranceM} m, recouvrement ≥ 80 %`),
    };
  };
  return [cote("A"), cote("B")];
}
