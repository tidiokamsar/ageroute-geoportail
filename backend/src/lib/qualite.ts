import type { StatutValeur, NiveauConfiance } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Qualite des valeurs : ce que l'on sait d'un champ, et depuis quand (T3, T4).
 *
 * LE PROBLEME
 *
 * Un champ rempli n'est pas un champ renseigne. Mesures du 01/09/2026 sur la
 * production :
 *
 *   revetement    1 690 / 1 690 remplis, UNE seule valeur distincte : BITUME
 *   etat          1 690 / 1 690 remplis, dont 1 043 valent NON_EVALUE
 *   longueurKm      662 / 1 690
 *   trafic              0 / 1 690
 *   criticite           0 / 1 690
 *   cout                0 / 1 690
 *   dates de constat    3 / 4 970 attendues, tous champs confondus
 *
 * L'interface presentait BITUME comme une caracteristique du reseau et un etat non
 * date comme un constat. Les deux sont faux.
 *
 * CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS
 *
 * Il decrit les valeurs ; il ne les corrige pas. Marquer BITUME comme importe non
 * verifie est possible et honnete. Le remplacer ne l'est pas : aucune source ne dit
 * ce qu'est reellement le revetement de ces 1 690 troncons.
 */

/**
 * Les champs qui alimentent une decision d'investissement, et eux seuls.
 *
 * Le perimetre est deliberement etroit. Porter statut, source, methode, date, auteur
 * et confiance sur les vingt-deux champs des troncons couterait cher pour un benefice
 * nul sur les champs d'identification, qui ne se discutent pas. Ces six-la sont ceux
 * dont depend le classement d'un troncon pour des travaux.
 */
export const CHAMPS_DECISION = [
  "etat",
  "longueurKm",
  "revetement",
  "traficMoyenJma",
  "criticiteStrategique",
  "coutRehabEstime",
] as const;

export type ChampDecision = (typeof CHAMPS_DECISION)[number];

export interface QualiteValeur {
  champ: string;
  statut: StatutValeur;
  source: string | null;
  methode: string | null;
  observedAt: Date | null;
  observedById: string | null;
  confiance: NiveauConfiance | null;
  note: string | null;
}

/**
 * Une valeur accompagnee de ce qu'on en sait.
 *
 * `qualite` a null signifie « rien n'est enregistre sur cette valeur », ce qui n'est
 * pas la meme chose que UNKNOWN. UNKNOWN est une affirmation : on a regarde et on ne
 * sait pas. Null est une absence : personne n'a encore regarde.
 */
export interface ValeurQualifiee<T> {
  valeur: T;
  qualite: QualiteValeur | null;
}

/** Vrai quand la valeur ne doit pas etre presentee comme un fait etabli. */
export function estDouteuse(q: QualiteValeur | null): boolean {
  if (!q) return true;
  return q.statut !== "OBSERVED";
}

/**
 * Vrai quand la valeur est datee. Un statut OBSERVED sans date ne vaut pas mieux
 * qu'une absence de statut : deux constats non dates ne sont pas comparables.
 */
export function estDatee(q: QualiteValeur | null): boolean {
  return !!q?.observedAt;
}

/** Libelle court destine a l'interface. Le rendre ici evite qu'il diverge d'un ecran a l'autre. */
export function libelleStatut(q: QualiteValeur | null): string {
  if (!q) return "Qualité non renseignée";
  switch (q.statut) {
    case "OBSERVED":
      return q.observedAt ? "Constaté" : "Constaté — date inconnue";
    case "IMPORTED_UNVERIFIED":
      return "Importé — non vérifié";
    case "DERIVED":
      return "Calculé";
    case "CONFLICTING":
      return "Contredit par une autre source";
    case "UNKNOWN":
      return "Non renseigné";
  }
}

/**
 * Charge la qualite de plusieurs enregistrements d'un coup.
 *
 * Une requete par enregistrement ferait 1 690 allers-retours pour afficher une liste
 * de troncons. La cle du dictionnaire rendu est `${entityId}:${champ}`.
 */
export async function chargerQualite(
  entityType: string,
  entityIds: string[]
): Promise<Map<string, QualiteValeur>> {
  if (entityIds.length === 0) return new Map();

  const lignes = await prisma.valeurQualite.findMany({
    where: { entityType, entityId: { in: entityIds } },
    select: {
      entityId: true,
      champ: true,
      statut: true,
      source: true,
      methode: true,
      observedAt: true,
      observedById: true,
      confiance: true,
      note: true,
    },
  });

  const parCle = new Map<string, QualiteValeur>();
  for (const l of lignes) {
    parCle.set(`${l.entityId}:${l.champ}`, {
      champ: l.champ,
      statut: l.statut,
      source: l.source,
      methode: l.methode,
      observedAt: l.observedAt,
      observedById: l.observedById,
      confiance: l.confiance,
      note: l.note,
    });
  }
  return parCle;
}

export interface EcritureQualite {
  entityType: string;
  entityId: string;
  champ: string;
  statut: StatutValeur;
  source?: string | null;
  methode?: string | null;
  observedAt?: Date | null;
  observedById?: string | null;
  confiance?: NiveauConfiance | null;
  note?: string | null;
}

/**
 * Enregistre ce que l'on sait d'une valeur.
 *
 * Un upsert sur (entityType, entityId, champ) : il ne peut y avoir qu'un seul etat de
 * connaissance par champ, sinon deux statuts contradictoires cohabiteraient et
 * l'interface devrait choisir.
 */
export async function enregistrerQualite(e: EcritureQualite): Promise<void> {
  const donnees = {
    statut: e.statut,
    source: e.source ?? null,
    methode: e.methode ?? null,
    observedAt: e.observedAt ?? null,
    observedById: e.observedById ?? null,
    confiance: e.confiance ?? null,
    note: e.note ?? null,
  };

  await prisma.valeurQualite.upsert({
    where: {
      entityType_entityId_champ: {
        entityType: e.entityType,
        entityId: e.entityId,
        champ: e.champ,
      },
    },
    create: { entityType: e.entityType, entityId: e.entityId, champ: e.champ, ...donnees },
    update: donnees,
  });
}

export interface RepartitionChamp {
  champ: string;
  total: number;
  parStatut: Record<string, number>;
  /** Valeurs portant une date de constat. C'est la dimension la plus degradee de la base. */
  datees: number;
}

/**
 * Repartition des statuts par champ, pour le tableau de bord qualite.
 *
 * Repond a « combien de valeurs de ce champ sont reellement fiables ? », la ou un
 * simple COUNT(non-null) repondait « 100 % » sur un champ constant.
 */
export async function repartitionQualite(entityType: string): Promise<RepartitionChamp[]> {
  const lignes = await prisma.valeurQualite.groupBy({
    by: ["champ", "statut"],
    where: { entityType },
    _count: { _all: true },
  });

  const datees = await prisma.valeurQualite.groupBy({
    by: ["champ"],
    where: { entityType, observedAt: { not: null } },
    _count: { _all: true },
  });
  const dateesParChamp = new Map(datees.map((d) => [d.champ, d._count._all]));

  const parChamp = new Map<string, RepartitionChamp>();

  /**
   * Les champs de decision sont amorces a zero AVANT le regroupement.
   *
   * Sans cela, un champ sur lequel aucune ligne de qualite n'existe disparaissait
   * simplement du tableau — et une dimension dont on ne sait absolument rien se
   * lisait comme une dimension sans probleme. C'est l'inverse du but.
   *
   * La fiche d'un enregistrement applique deja ce principe : « les six champs sont
   * toujours rendus, meme sans ligne de qualite ». La vue d'ensemble ne le faisait
   * pas, et les deux se contredisaient.
   */
  for (const champ of CHAMPS_DECISION) {
    parChamp.set(champ, { champ, total: 0, parStatut: {}, datees: dateesParChamp.get(champ) ?? 0 });
  }

  for (const l of lignes) {
    const r =
      parChamp.get(l.champ) ??
      ({ champ: l.champ, total: 0, parStatut: {}, datees: dateesParChamp.get(l.champ) ?? 0 } as RepartitionChamp);
    r.parStatut[l.statut] = l._count._all;
    r.total += l._count._all;
    parChamp.set(l.champ, r);
  }
  return [...parChamp.values()].sort((a, b) => b.total - a.total);
}

// ─────────────────────────────────────────────────────────────────────────────

/** Champs d'un troncon necessaires pour etablir l'etat de connaissance initial. */
export interface TronconAQualifier {
  id: string;
  etat: string;
  longueurKm: number | null;
  revetement: string | null;
  traficMoyenJma: number | null;
  criticiteStrategique: number | null;
  coutRehabEstime: unknown;
  dateDerniereEvaluation: Date | null;
}

const SOURCE_IMPORT = "IMPORT_INITIAL";

/**
 * Etablit ce que l'on sait des six champs de decision d'un troncon, tel que la base
 * se presente aujourd'hui.
 *
 * AUCUNE VALEUR N'EST OBSERVED
 *
 * C'est le resultat le plus dur de cet exercice, et il est exact : pas une seule
 * valeur de la base ne peut etre qualifiee de constatee. Il n'existe ni date de
 * constat, ni auteur, ni methode pour aucune d'entre elles. Le journal d'audit ne
 * contient meme aucune creation.
 *
 * Attribuer OBSERVED a un etat non date reviendrait a affirmer un constat que rien
 * n'atteste.
 *
 * POURQUOI LE REVETEMENT N'EST PAS MARQUE CONFLICTING
 *
 * La contradiction est etablie au niveau du RESEAU — 29 intitules de chantiers
 * decrivent des routes « en terre », « piste » ou « laterite » alors que le champ vaut
 * BITUME sur les 1 690 troncons — mais elle n'est pas attribuable troncon par troncon :
 * un seul chantier sur 488 contient un code de troncon exact, et aucun troncon ne
 * porte de nom de localite.
 *
 * Marquer un troncon precis comme CONFLICTING supposerait un rapprochement qu'on ne
 * sait pas faire. La contradiction est donc consignee en note sur chaque valeur, ou
 * elle est vraie, plutot que projetee sur des enregistrements arbitraires.
 */
export function qualiteInitialeTroncon(t: TronconAQualifier): EcritureQualite[] {
  const base = { entityType: "Troncon", entityId: t.id };
  const ecritures: EcritureQualite[] = [];

  // Revetement : rempli a 100 %, une seule valeur distincte sur 1 690 lignes.
  ecritures.push({
    ...base,
    champ: "revetement",
    statut: "IMPORTED_UNVERIFIED",
    source: SOURCE_IMPORT,
    methode: "IMPORT",
    confiance: "LOW",
    note:
      "Valeur unique sur les 1 690 troncons. 29 intitules de chantiers decrivent des " +
      "routes en terre, piste ou laterite : la valeur est contredite a l'echelle du " +
      "reseau, sans pouvoir etre attribuee troncon par troncon.",
  });

  // Etat : NON_EVALUE dit honnetement qu'on ne sait pas ; les autres valeurs sont
  // presentes mais sans aucune date de constat.
  ecritures.push({
    ...base,
    champ: "etat",
    statut: t.etat === "NON_EVALUE" ? "UNKNOWN" : "IMPORTED_UNVERIFIED",
    source: t.etat === "NON_EVALUE" ? null : SOURCE_IMPORT,
    methode: t.etat === "NON_EVALUE" ? null : "IMPORT",
    observedAt: t.dateDerniereEvaluation,
    confiance: t.etat === "NON_EVALUE" ? null : "LOW",
    note:
      t.etat === "NON_EVALUE"
        ? "Etat jamais evalue. 1 043 troncons sur 1 690 sont dans ce cas."
        : t.dateDerniereEvaluation
          ? null
          : "Etat renseigne mais non date : non comparable a un autre etat.",
  });

  // Longueur : les 662 valeurs presentes concordent a moins de 1 % avec la geometrie,
  // sans aucun ecart intermediaire. Il n'y a rien a corriger, seulement a completer.
  const aLongueur = (t.longueurKm ?? 0) > 0;
  ecritures.push({
    ...base,
    champ: "longueurKm",
    statut: aLongueur ? "IMPORTED_UNVERIFIED" : "UNKNOWN",
    source: aLongueur ? SOURCE_IMPORT : null,
    methode: aLongueur ? "IMPORT" : null,
    confiance: aLongueur ? "MEDIUM" : null,
    note: aLongueur
      ? "Concorde a moins de 1 % avec la longueur geometrique, sur les 662 troncons ou les deux existent."
      : "Longueur metier absente. La longueur geometrique est calculee a la lecture, jamais ecrite ici.",
  });

  const absents: [ChampDecision, boolean, string][] = [
    ["traficMoyenJma", t.traficMoyenJma != null, "Trafic absent sur les 1 690 troncons."],
    ["criticiteStrategique", t.criticiteStrategique != null, "Criticite absente sur les 1 690 troncons."],
    ["coutRehabEstime", t.coutRehabEstime != null, "Cout de rehabilitation absent sur les 1 690 troncons."],
  ];
  for (const [champ, present, note] of absents) {
    ecritures.push({
      ...base,
      champ,
      statut: present ? "IMPORTED_UNVERIFIED" : "UNKNOWN",
      source: present ? SOURCE_IMPORT : null,
      methode: present ? "IMPORT" : null,
      confiance: present ? "LOW" : null,
      note: present ? null : note,
    });
  }

  return ecritures;
}
