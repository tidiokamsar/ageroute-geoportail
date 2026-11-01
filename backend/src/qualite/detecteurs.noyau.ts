/**
 * Noyau PUR des detecteurs de qualite des donnees de troncons (lecture seule).
 *
 * Ni base, ni horloge, ni import : il prend des MESURES deja relevees (par `detecteurs.depot.ts`,
 * qui interroge PostGIS en lecture seule) et rend des anomalies classees. La date courante est un
 * parametre. Un detecteur est un SIGNAL, jamais une action : ce module ne corrige rien, ne propose
 * aucune suppression, et chaque code porte une correction proposee en texte, a appliquer par les
 * routes normales et leur validation (cahier § 10, regle 2 d'AGENTS.md).
 *
 * POURQUOI CE MODULE EXISTE A COTE DE `anomalies.ts`
 *
 * `anomalies.ts` agrege par FAMILLE (un compte et trois exemples) et ne voit que six familles sur
 * huit attendues : la sentinelle PK 0/0, l'incoherence de longueur, la geometrie nulle ou vide, la
 * region discordante, le chevauchement et les trous de PK n'y sont pas. Celui-ci rend, par CODE
 * STABLE, la liste des entites en cause avec les valeurs mesurees et le seuil applique. Les deux
 * coexistent : aucune famille existante n'est modifiee.
 *
 * LES SEUILS SONT PROVISOIRES, ET LE DISENT
 *
 * Aucun nombre ci-dessous n'est une norme d'AGEROUTE. Chacun est nomme, documente
 * (`DOCUMENTATION_SEUILS`) et recu en parametre par chaque fonction : le figer en ferait une
 * verite metier que personne n'a decidee. La valeur et le nom du seuil appliques figurent sur
 * chaque anomalie rendue.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Codes, gravites, seuils
// ─────────────────────────────────────────────────────────────────────────────

/** Meme vocabulaire que `Gravite` de `anomalies.ts` (redefini ici : le noyau n'importe rien). */
export type GraviteDetecteur = "BLOQUANTE" | "A_TRAITER" | "A_SURVEILLER";

export const CODES_ANOMALIE = [
  // (a) PK
  "PK_SENTINELLE_ZERO",
  "PK_FIN_INFERIEUR_DEBUT",
  "PK_ABSENT",
  "PK_NEGATIF",
  "PK_CHEVAUCHEMENT",
  "PK_TROU",
  // (b) longueur
  "LONGUEUR_NON_POSITIVE",
  "LONGUEUR_ECART_GEOMETRIE",
  // (c) geometrie
  "GEOM_ABSENTE",
  "GEOM_VIDE",
  "GEOM_INVALIDE",
  "GEOM_NON_LINEAIRE",
  "GEOM_SRID_INATTENDU",
  "GEOM_LONGUEUR_NULLE",
  // (d) region
  "REGION_DISCORDANTE",
  "REGION_NON_RENSEIGNEE",
  "REGION_NON_VERIFIABLE",
  "HORS_TERRITOIRE",
  // (e) doublons
  "DOUBLON_GEOMETRIE_STRICT",
  "DOUBLON_GEOMETRIE_QUASI",
  // (f) etat declare
  "ETAT_ABSENT",
  "ETAT_INCONNU",
  "ETAT_NON_EVALUE",
  "ETAT_DATE_SANS_ETAT",
  "ETAT_SANS_DATE_EVALUATION",
  "ETAT_DATE_FUTURE",
] as const;

export type CodeAnomalie = (typeof CODES_ANOMALIE)[number];

export type FamilleDetecteur = "PK" | "LONGUEUR" | "GEOMETRIE" | "REGION" | "DOUBLON" | "ETAT";

export interface DescriptionCode {
  famille: FamilleDetecteur;
  /** Gravite par defaut ; REGION_DISCORDANTE, HORS_TERRITOIRE et PK_SENTINELLE_ZERO peuvent la nuancer. */
  gravite: GraviteDetecteur;
  description: string;
  correctionProposee: string;
}

/**
 * Catalogue des codes. Les GRAVITES sont provisoires au meme titre que les seuils : elles disent
 * l'ordre dans lequel regarder, pas une decision d'AGEROUTE.
 */
export const CATALOGUE_CODES: Record<CodeAnomalie, DescriptionCode> = {
  PK_SENTINELLE_ZERO: {
    famille: "PK", gravite: "A_TRAITER",
    description: "PK debut et PK fin valent tous deux 0 : le zero tient lieu de valeur absente.",
    correctionProposee: "Relever ou deduire les PK reels par la section de referencement, ou laisser le tronçon sans PK de maniere explicite. Ne pas recopier 0 comme une mesure.",
  },
  PK_FIN_INFERIEUR_DEBUT: {
    famille: "PK", gravite: "BLOQUANTE",
    description: "Le PK de fin est inferieur au PK de debut : la section a une longueur negative.",
    correctionProposee: "Verifier le sens de referencement ; inverser debut et fin par une correction auditee si la saisie est inversee.",
  },
  PK_ABSENT: {
    famille: "PK", gravite: "A_TRAITER",
    description: "PK debut ou PK fin absent ou non fini (NaN, infini).",
    correctionProposee: "Renseigner le PK par un releve ; une valeur absente ne se remplace pas par 0.",
  },
  PK_NEGATIF: {
    famille: "PK", gravite: "A_TRAITER",
    description: "PK debut ou PK fin negatif.",
    correctionProposee: "Verifier la saisie : un PK negatif est une erreur de signe ou de reference.",
  },
  PK_CHEVAUCHEMENT: {
    famille: "PK", gravite: "A_TRAITER",
    description: "Deux troncons consecutifs d'une meme section de route se recouvrent en PK.",
    correctionProposee: "Faire trancher quel troncon decrit ces kilometres, puis corriger le PK de l'autre ou ses limites.",
  },
  PK_TROU: {
    famille: "PK", gravite: "A_SURVEILLER",
    description: "Un trou de PK separe deux troncons consecutifs d'une meme section de route.",
    correctionProposee: "Verifier si le trou est reel (section non inventoriee) ou un defaut de decoupage ; le combler par un releve, pas par interpolation.",
  },
  LONGUEUR_NON_POSITIVE: {
    famille: "LONGUEUR", gravite: "A_TRAITER",
    description: "La longueur declaree est nulle, negative ou non finie.",
    correctionProposee: "Renseigner la longueur ; la valeur geometrique peut etre proposee comme valeur DERIVEE, jamais ecrite en masse.",
  },
  LONGUEUR_ECART_GEOMETRIE: {
    famille: "LONGUEUR", gravite: "A_TRAITER",
    description: "La longueur declaree s'ecarte de la longueur geometrique au-dela du seuil provisoire.",
    correctionProposee: "Reverifier laquelle des deux est fausse (trace tronque, longueur saisie, troncon decoupe) avant de corriger l'une d'elles.",
  },
  GEOM_ABSENTE: {
    famille: "GEOMETRIE", gravite: "A_TRAITER",
    description: "Le troncon actif n'a aucune geometrie.",
    correctionProposee: "Geolocaliser le troncon par les routes normales ; il est invisible sur la carte et sorti de tous les calculs spatiaux.",
  },
  GEOM_VIDE: {
    famille: "GEOMETRIE", gravite: "A_TRAITER",
    description: "La geometrie existe mais est vide.",
    correctionProposee: "Retracer le troncon par une operation geometrique auditee.",
  },
  GEOM_INVALIDE: {
    famille: "GEOMETRIE", gravite: "BLOQUANTE",
    description: "La geometrie est invalide au sens de PostGIS (ST_IsValid).",
    correctionProposee: "Corriger le trace par une operation explicite et auditee. Ne pas reparer en masse : ST_MakeValid peut deplacer un sommet sans le dire.",
  },
  GEOM_NON_LINEAIRE: {
    famille: "GEOMETRIE", gravite: "BLOQUANTE",
    description: "La geometrie n'est pas une LineString.",
    correctionProposee: "Retracer le troncon. NB : la colonne est typee geometry(LineString,4326), cet etat ne devrait pas pouvoir exister.",
  },
  GEOM_SRID_INATTENDU: {
    famille: "GEOMETRIE", gravite: "BLOQUANTE",
    description: "Le SRID de la geometrie n'est pas 4326.",
    correctionProposee: "Reprojeter par une operation auditee. NB : la colonne est typee SRID 4326, cet etat ne devrait pas pouvoir exister.",
  },
  GEOM_LONGUEUR_NULLE: {
    famille: "GEOMETRIE", gravite: "A_TRAITER",
    description: "La longueur geometrique est nulle ou inferieure au seuil provisoire.",
    correctionProposee: "Retracer le troncon : un trace sans etendue ne decrit aucune route.",
  },
  REGION_DISCORDANTE: {
    famille: "REGION", gravite: "A_TRAITER",
    description: "Le troncon est rattache a une region, mais son trace est majoritairement dans une autre.",
    correctionProposee: "Reverifier le rattachement. rattacher-troncons-region.ts sait le corriger avec trace de la valeur precedente, apres arbitrage pour les troncons a cheval.",
  },
  REGION_NON_RENSEIGNEE: {
    famille: "REGION", gravite: "A_TRAITER",
    description: "Le troncon est rattache a la region « Non renseigne » alors qu'il a un trace.",
    correctionProposee: "Rattacher a la region dominante par intersection (rattacher-troncons-region.ts), apres revue.",
  },
  REGION_NON_VERIFIABLE: {
    famille: "REGION", gravite: "A_SURVEILLER",
    description: "La region du troncon n'a aucune limite de niveau 1 de meme nom : la discordance ne peut pas etre jugee.",
    correctionProposee: "Charger la limite de la region (importer-limites-admin.ts) ou corriger le nom de la region.",
  },
  HORS_TERRITOIRE: {
    famille: "REGION", gravite: "A_TRAITER",
    description: "La geometrie ne touche aucune limite administrative de niveau 1.",
    correctionProposee: "Donner un statut explicite (perimetre HORS_TERRITOIRE_NATIONAL et pays), pas une suppression : ces objets documentent une continuite transfrontaliere. La precision de la couche de limites n'est pas verifiee.",
  },
  DOUBLON_GEOMETRIE_STRICT: {
    famille: "DOUBLON", gravite: "BLOQUANTE",
    description: "Un autre troncon actif porte exactement la meme geometrie (meme sens ou sens inverse).",
    correctionProposee: "Arbitrer lequel fait foi, rattacher les observations au retenu, marquer l'autre remplace. Ne pas supprimer : des observations y pendent.",
  },
  DOUBLON_GEOMETRIE_QUASI: {
    famille: "DOUBLON", gravite: "A_TRAITER",
    description: "Un autre troncon actif a une geometrie distante au plus du seuil provisoire (distance de Hausdorff).",
    correctionProposee: "Meme arbitrage que pour un doublon strict, apres avoir verifie qu'il ne s'agit pas de deux voies voisines distinctes.",
  },
  ETAT_ABSENT: {
    famille: "ETAT", gravite: "A_TRAITER",
    description: "L'etat declare est absent.",
    correctionProposee: "Faire evaluer le troncon ; NON_EVALUE est la valeur honnete en attendant.",
  },
  ETAT_INCONNU: {
    famille: "ETAT", gravite: "A_TRAITER",
    description: "L'etat declare n'appartient pas a la liste connue (BON, MOYEN, MAUVAIS, CRITIQUE, NON_EVALUE).",
    correctionProposee: "Corriger la valeur ; l'enum de la base devrait l'interdire.",
  },
  ETAT_NON_EVALUE: {
    famille: "ETAT", gravite: "A_SURVEILLER",
    description: "Le troncon actif n'a pas d'etat evalue (NON_EVALUE). C'est la valeur par defaut, donc tres frequente.",
    correctionProposee: "Programmer une evaluation. Ne pas reconduire un etat ancien : il deviendrait une donnee inventee.",
  },
  ETAT_DATE_SANS_ETAT: {
    famille: "ETAT", gravite: "A_TRAITER",
    description: "Une date d'evaluation existe alors que l'etat est NON_EVALUE : l'un des deux est faux.",
    correctionProposee: "Retrouver l'evaluation : soit l'etat a ete efface, soit la date est une erreur.",
  },
  ETAT_SANS_DATE_EVALUATION: {
    famille: "ETAT", gravite: "A_SURVEILLER",
    description: "Un etat est declare mais aucune date d'evaluation ne le date : on ne sait pas s'il est constate.",
    correctionProposee: "Retrouver la source de l'etat ; a defaut, le laisser marque comme declare et non constate.",
  },
  ETAT_DATE_FUTURE: {
    famille: "ETAT", gravite: "A_TRAITER",
    description: "La date d'evaluation est dans le futur (au-dela de la tolerance provisoire).",
    correctionProposee: "Corriger la date de l'evaluation.",
  },
};

/**
 * Seuils PROVISOIRES. Aucun n'est une norme d'AGEROUTE ; voir `DOCUMENTATION_SEUILS` pour l'origine
 * de chacun et `docs/qualite/DETECTEURS.md`.
 */
export const SEUILS_PROVISOIRES = {
  /** Recouvrement de PK (km) tolere entre deux troncons consecutifs avant d'etre signale. */
  PK_CHEVAUCHEMENT_KM: 0.05,
  /** Trou de PK (km) tolere entre deux troncons consecutifs avant d'etre signale. */
  PK_TROU_KM: 0.5,
  /** Ecart relatif |declaree - geometrique| / geometrique au-dela duquel la longueur est signalee. */
  LONGUEUR_ECART_RELATIF: 0.1,
  /** Ecart absolu (km) minimal : evite de signaler 3 m contre 4 m sur un troncon minuscule. */
  LONGUEUR_ECART_ABSOLU_MIN_KM: 0.05,
  /** Longueur geometrique (m) en dessous de laquelle un trace est dit de longueur nulle. */
  LONGUEUR_GEOMETRIQUE_NULLE_M: 0.01,
  /** Part du trace au-dela de laquelle une region est dite « majoritaire ». */
  REGION_MAJORITE: 0.5,
  /** Part du trace dans la region declaree en dessous de laquelle la discordance est nette (sinon a cheval). */
  REGION_PART_DECLAREE_FAIBLE: 0.2,
  /** Distance de Hausdorff maximale (degres) entre deux traces dits « quasi identiques ». 1e-5 deg ~ 1,1 m. */
  DOUBLON_QUASI_TOLERANCE_DEG: 0.00001,
  /** Avance (jours) toleree sur la date d'evaluation avant de la dire future (fuseaux, saisie du jour). */
  ETAT_DATE_FUTURE_TOLERANCE_JOURS: 1,
} as const;

export type NomSeuil = keyof typeof SEUILS_PROVISOIRES;
export type Seuils = { readonly [K in NomSeuil]: number };

export interface DocumentationSeuil {
  unite: string;
  statut: "PROVISOIRE";
  /** D'ou vient la valeur, et ce qu'elle n'est PAS. */
  origine: string;
}

export const DOCUMENTATION_SEUILS: Record<NomSeuil, DocumentationSeuil> = {
  PK_CHEVAUCHEMENT_KM: {
    unite: "km", statut: "PROVISOIRE",
    origine: "Valeur technique (50 m) : au-dessus du bruit d'arrondi des PK. Aucune decision metier.",
  },
  PK_TROU_KM: {
    unite: "km", statut: "PROVISOIRE",
    origine: "Reprise de la tolerance (500 m) de la mesure du 05/09/2026 citee par scripts/extraire-section-pk.ts : 88 sections sur 90 s'enchainaient a moins de 500 m. C'est un ordre de grandeur observe, pas une regle.",
  },
  LONGUEUR_ECART_RELATIF: {
    unite: "ratio", statut: "PROVISOIRE",
    origine: "10 % : choix de depart sans fondement metier. A fixer par AGEROUTE apres lecture de la distribution reelle des ecarts.",
  },
  LONGUEUR_ECART_ABSOLU_MIN_KM: {
    unite: "km", statut: "PROVISOIRE",
    origine: "50 m : ecarte les troncons minuscules ou 1 m d'ecart fait 30 %. Valeur technique.",
  },
  LONGUEUR_GEOMETRIQUE_NULLE_M: {
    unite: "m", statut: "PROVISOIRE",
    origine: "1 cm : en dessous, le trace n'a pas d'etendue mesurable a la precision des donnees (coordonnees decimales a 1e-7 deg ~ 1 cm).",
  },
  REGION_MAJORITE: {
    unite: "ratio", statut: "PROVISOIRE",
    origine: "Definition du mot « majoritairement » (plus de la moitie du trace) ; non une norme.",
  },
  REGION_PART_DECLAREE_FAIBLE: {
    unite: "ratio", statut: "PROVISOIRE",
    origine: "20 % : reprend le seuil de la mesure du 05/09/2026 de scripts/rattacher-troncons-region.ts (« 3 en ont moins de 20 % »). Distingue le troncon entierement ailleurs du troncon a cheval.",
  },
  DOUBLON_QUASI_TOLERANCE_DEG: {
    unite: "degre", statut: "PROVISOIRE",
    origine: "1e-5 degre (environ 1,1 m a l'equateur) : precision de saisie des traces. Deux voies voisines distinctes plus proches que cela sont tres improbables mais possibles.",
  },
  ETAT_DATE_FUTURE_TOLERANCE_JOURS: {
    unite: "jour", statut: "PROVISOIRE",
    origine: "Un jour : absorbe fuseaux horaires et saisie anticipee du jour meme.",
  },
};

export interface SeuilApplique {
  nom: NomSeuil;
  valeur: number;
  unite: string;
  statut: "PROVISOIRE";
}

function seuilApplique(nom: NomSeuil, seuils: Seuils): SeuilApplique {
  return { nom, valeur: seuils[nom], unite: DOCUMENTATION_SEUILS[nom].unite, statut: "PROVISOIRE" };
}

/** Fusionne des surcharges partielles sur les valeurs provisoires. Refuse un seuil non fini ou negatif. */
export function construireSeuils(surcharges: Partial<Record<NomSeuil, number>> = {}): Seuils {
  const sortie: Record<string, number> = { ...SEUILS_PROVISOIRES };
  for (const [nom, valeur] of Object.entries(surcharges)) {
    if (!(nom in SEUILS_PROVISOIRES)) throw new Error(`Seuil inconnu : ${nom}`);
    if (typeof valeur !== "number" || !Number.isFinite(valeur) || valeur < 0) {
      throw new Error(`Seuil ${nom} invalide : ${String(valeur)}`);
    }
    sortie[nom] = valeur;
  }
  return sortie as unknown as Seuils;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anomalie rendue
// ─────────────────────────────────────────────────────────────────────────────

export type ValeurDetail = number | string | boolean | null | readonly (string | number)[];

export interface AnomalieDetectee {
  code: CodeAnomalie;
  gravite: GraviteDetecteur;
  entiteType: "Troncon";
  entiteId: string;
  entiteCode: string;
  regionId: number | null;
  /** Valeurs MESUREES qui motivent l'anomalie. */
  details: Record<string, ValeurDetail>;
  /** Seuil provisoire applique, ou null quand le code n'en depend pas. */
  seuil: SeuilApplique | null;
  /** Grandeur de tri (ecart relatif, metres, km...) : les plus grosses d'abord. */
  mesure: number | null;
}

interface Identite {
  id: string;
  code: string;
  regionId: number | null;
}

function anomalie(
  code: CodeAnomalie,
  e: Identite,
  details: Record<string, ValeurDetail>,
  opts: { gravite?: GraviteDetecteur; seuil?: SeuilApplique | null; mesure?: number | null } = {},
): AnomalieDetectee {
  return {
    code,
    gravite: opts.gravite ?? CATALOGUE_CODES[code].gravite,
    entiteType: "Troncon",
    entiteId: e.id,
    entiteCode: e.code,
    regionId: e.regionId,
    details,
    seuil: opts.seuil ?? null,
    mesure: opts.mesure ?? null,
  };
}

const arrondir = (x: number, decimales = 3): number => {
  const f = 10 ** decimales;
  return Math.round(x * f) / f;
};

const fini = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Bruit d'arrondi tolere sur une comparaison a un seuil. Les PK et les longueurs sont des flottants
 * saisis en decimal : `10 - 9.95` vaut 0.05000000000000071, et sans cette marge un ecart exactement
 * egal au seuil serait signale. Valeur technique, sans lien avec un seuil metier.
 */
const EPSILON = 1e-9;
const depasse = (valeur: number, seuil: number): boolean => valeur - seuil > EPSILON;

// ─────────────────────────────────────────────────────────────────────────────
// Mesures d'un troncon (une ligne par troncon actif), relevees par le depot SQL
// ─────────────────────────────────────────────────────────────────────────────

export interface MesureTroncon extends Identite {
  regionNom: string | null;
  longueurKm: number | null;
  pkDebut: number | null;
  pkFin: number | null;
  etat: string | null;
  dateDerniereEvaluation: Date | null;
  geomPresente: boolean;
  geomVide: boolean | null;
  geomValide: boolean | null;
  raisonInvalide: string | null;
  /** ST_GeometryType : « ST_LineString ». */
  geomType: string | null;
  geomSrid: number | null;
  /** Longueur geodesique du trace en metres, ou null quand la geometrie n'est pas mesurable. */
  longueurGeomM: number | null;
}

export const SRID_ATTENDU = 4326;
export const TYPE_ATTENDU = "ST_LineString";
export const ETATS_CONNUS = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"] as const;

/** (a) PK d'un troncon pris isolement : sentinelle, fin < debut, absent, negatif. */
export function classerPk(m: MesureTroncon): AnomalieDetectee[] {
  if (!fini(m.pkDebut) || !fini(m.pkFin)) {
    return [anomalie("PK_ABSENT", m, { pkDebut: fini(m.pkDebut) ? m.pkDebut : null, pkFin: fini(m.pkFin) ? m.pkFin : null })];
  }
  const sortie: AnomalieDetectee[] = [];
  if (m.pkDebut < 0 || m.pkFin < 0) {
    sortie.push(anomalie("PK_NEGATIF", m, { pkDebut: m.pkDebut, pkFin: m.pkFin }));
  }
  if (m.pkDebut === 0 && m.pkFin === 0) {
    // Le zero tient lieu de « valeur absente » (import-rural-osm.ts et merge-osm-routes.ts l'ecrivent
    // avec une longueur reelle). La longueur declaree figure dans le detail pour distinguer un troncon
    // de longueur nulle (coherent avec lui-meme, signale par ailleurs) d'un vrai PK absent.
    sortie.push(anomalie("PK_SENTINELLE_ZERO", m, { pkDebut: 0, pkFin: 0, longueurKm: fini(m.longueurKm) ? m.longueurKm : null }));
  } else if (m.pkFin < m.pkDebut) {
    sortie.push(anomalie("PK_FIN_INFERIEUR_DEBUT", m, {
      pkDebut: m.pkDebut, pkFin: m.pkFin, ecartKm: arrondir(m.pkDebut - m.pkFin),
    }, { mesure: m.pkDebut - m.pkFin }));
  }
  return sortie;
}

/** (b) Longueur declaree : non positive, ou ecartee de la longueur geometrique. */
export function classerLongueur(m: MesureTroncon, seuils: Seuils): AnomalieDetectee[] {
  if (!fini(m.longueurKm) || m.longueurKm <= 0) {
    return [anomalie("LONGUEUR_NON_POSITIVE", m, {
      longueurDeclareeKm: fini(m.longueurKm) ? m.longueurKm : null,
      longueurGeometriqueKm: fini(m.longueurGeomM) ? arrondir(m.longueurGeomM / 1000) : null,
    })];
  }
  // Pas de longueur geometrique exploitable (trace absent, vide, de longueur nulle) : rien a comparer,
  // la geometrie est signalee par ailleurs.
  if (!fini(m.longueurGeomM) || m.longueurGeomM < seuils.LONGUEUR_GEOMETRIQUE_NULLE_M) return [];

  const geomKm = m.longueurGeomM / 1000;
  const ecartAbsKm = Math.abs(m.longueurKm - geomKm);
  const ecartRel = ecartAbsKm / geomKm;
  if (depasse(ecartRel, seuils.LONGUEUR_ECART_RELATIF) && !depasse(seuils.LONGUEUR_ECART_ABSOLU_MIN_KM, ecartAbsKm)) {
    return [anomalie("LONGUEUR_ECART_GEOMETRIE", m, {
      longueurDeclareeKm: arrondir(m.longueurKm),
      longueurGeometriqueKm: arrondir(geomKm),
      ecartAbsoluKm: arrondir(ecartAbsKm),
      ecartRelatif: arrondir(ecartRel, 4),
      seuilEcartAbsoluMinKm: seuils.LONGUEUR_ECART_ABSOLU_MIN_KM,
    }, { seuil: seuilApplique("LONGUEUR_ECART_RELATIF", seuils), mesure: ecartRel })];
  }
  return [];
}

/** (c) Geometrie : absente, vide, invalide, non lineaire, SRID inattendu, longueur nulle. */
export function classerGeometrie(m: MesureTroncon, seuils: Seuils): AnomalieDetectee[] {
  if (!m.geomPresente) return [anomalie("GEOM_ABSENTE", m, {})];
  if (m.geomVide === true) return [anomalie("GEOM_VIDE", m, {})];

  const sortie: AnomalieDetectee[] = [];
  if (m.geomValide === false) {
    sortie.push(anomalie("GEOM_INVALIDE", m, { raison: m.raisonInvalide }));
  }
  if (m.geomType !== null && m.geomType !== TYPE_ATTENDU) {
    sortie.push(anomalie("GEOM_NON_LINEAIRE", m, { type: m.geomType, typeAttendu: TYPE_ATTENDU }));
  }
  if (m.geomSrid !== null && m.geomSrid !== SRID_ATTENDU) {
    sortie.push(anomalie("GEOM_SRID_INATTENDU", m, { srid: m.geomSrid, sridAttendu: SRID_ATTENDU }));
  }
  if (fini(m.longueurGeomM) && m.longueurGeomM < seuils.LONGUEUR_GEOMETRIQUE_NULLE_M) {
    sortie.push(anomalie("GEOM_LONGUEUR_NULLE", m, { longueurGeometriqueM: m.longueurGeomM }, {
      seuil: seuilApplique("LONGUEUR_GEOMETRIQUE_NULLE_M", seuils),
    }));
  }
  return sortie;
}

/**
 * (f) Etat declare. `troncons.etat` est une valeur DECLAREE (voir `engines/condition.collecte.ts`),
 * NON_NULL avec NON_EVALUE par defaut : « absent » se lit donc NON_EVALUE. Le code ETAT_NON_EVALUE
 * est tres frequent par construction ; l'agregateur en donne le compte exact et plafonne la liste.
 */
export function classerEtat(m: MesureTroncon, maintenant: Date, seuils: Seuils): AnomalieDetectee[] {
  const etat = m.etat;
  if (etat === null || etat === undefined || etat.trim() === "") return [anomalie("ETAT_ABSENT", m, {})];
  if (!(ETATS_CONNUS as readonly string[]).includes(etat)) {
    return [anomalie("ETAT_INCONNU", m, { etat })];
  }

  const sortie: AnomalieDetectee[] = [];
  const date = m.dateDerniereEvaluation;
  if (etat === "NON_EVALUE") {
    sortie.push(anomalie("ETAT_NON_EVALUE", m, { etat }));
    if (date !== null) {
      sortie.push(anomalie("ETAT_DATE_SANS_ETAT", m, { etat, dateDerniereEvaluation: date.toISOString() }));
    }
    return sortie;
  }
  if (date === null) {
    sortie.push(anomalie("ETAT_SANS_DATE_EVALUATION", m, { etat }));
    return sortie;
  }
  const limite = maintenant.getTime() + seuils.ETAT_DATE_FUTURE_TOLERANCE_JOURS * 86_400_000;
  if (date.getTime() > limite) {
    sortie.push(anomalie("ETAT_DATE_FUTURE", m, {
      etat,
      dateDerniereEvaluation: date.toISOString(),
      joursDAvance: arrondir((date.getTime() - maintenant.getTime()) / 86_400_000, 1),
    }, { seuil: seuilApplique("ETAT_DATE_FUTURE_TOLERANCE_JOURS", seuils), mesure: date.getTime() - maintenant.getTime() }));
  }
  return sortie;
}

/** Tout ce qui se juge sur UN troncon, sans voisin ni limite : PK, longueur, geometrie, etat. */
export function classerTroncon(m: MesureTroncon, maintenant: Date, seuils: Seuils): AnomalieDetectee[] {
  return [
    ...classerPk(m),
    ...classerLongueur(m, seuils),
    ...classerGeometrie(m, seuils),
    ...classerEtat(m, maintenant, seuils),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Chainage des PK le long d'une section de route
// ─────────────────────────────────────────────────────────────────────────────

export interface LignePkChaine extends Identite {
  nom: string;
  sectionPk: string;
  pkDebut: number | null;
  pkFin: number | null;
}

/** Un PK exploitable pour le chainage : fini, positif, debut <= fin, et pas la sentinelle 0/0. */
function pkChainable(l: LignePkChaine): l is LignePkChaine & { pkDebut: number; pkFin: number } {
  return fini(l.pkDebut) && fini(l.pkFin) && l.pkDebut >= 0 && l.pkFin >= 0
    && l.pkFin >= l.pkDebut && !(l.pkDebut === 0 && l.pkFin === 0);
}

/**
 * Chevauchements et trous de PK entre troncons consecutifs d'une meme route.
 *
 * UNE « MEME ROUTE » EST UN COUPLE (nom, section) : les PK ne sont pas globaux sur l'axe, chaque
 * section repart de zero (voir `Troncon.sectionPk`). Les troncons sans section (voirie promue,
 * OSM) ne se chainent pas et ne sont pas examines. Les PK deja signales isolement (sentinelle,
 * absent, negatif, fin < debut) sont ecartes du chainage : les y laisser produirait un
 * chevauchement par troncon sentinelle.
 *
 * L'anomalie est portee par le troncon qui COMMENCE apres le precedent (celui qui porte le PK de
 * fin le plus grand jusque-la) ; l'autre y figure en `partenaire*`.
 */
export function detecterChainesPk(lignes: readonly LignePkChaine[], seuils: Seuils): AnomalieDetectee[] {
  const groupes = new Map<string, (LignePkChaine & { pkDebut: number; pkFin: number })[]>();
  for (const l of lignes) {
    if (!pkChainable(l)) continue;
    const cle = `${l.nom}\u0000${l.sectionPk}`;
    const g = groupes.get(cle);
    if (g) g.push(l);
    else groupes.set(cle, [l]);
  }

  const sortie: AnomalieDetectee[] = [];
  for (const g of groupes.values()) {
    g.sort((a, b) => a.pkDebut - b.pkDebut || a.pkFin - b.pkFin || a.id.localeCompare(b.id));
    let tete: (typeof g)[number] | null = null;
    for (const cur of g) {
      if (tete !== null) {
        const recouvrement = tete.pkFin - cur.pkDebut;
        const trou = cur.pkDebut - tete.pkFin;
        const base = {
          route: cur.nom, sectionPk: cur.sectionPk,
          pkDebut: cur.pkDebut, pkFin: cur.pkFin,
          partenaireId: tete.id, partenaireCode: tete.code, partenaireRegionId: tete.regionId,
          partenairePkDebut: tete.pkDebut, partenairePkFin: tete.pkFin,
        };
        if (depasse(recouvrement, seuils.PK_CHEVAUCHEMENT_KM)) {
          sortie.push(anomalie("PK_CHEVAUCHEMENT", cur, { ...base, chevauchementKm: arrondir(recouvrement) }, {
            seuil: seuilApplique("PK_CHEVAUCHEMENT_KM", seuils), mesure: recouvrement,
          }));
        } else if (depasse(trou, seuils.PK_TROU_KM)) {
          sortie.push(anomalie("PK_TROU", cur, { ...base, trouKm: arrondir(trou) }, {
            seuil: seuilApplique("PK_TROU_KM", seuils), mesure: trou,
          }));
        }
      }
      if (tete === null || cur.pkFin > tete.pkFin) tete = cur;
    }
  }
  return sortie;
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) Region discordante / hors territoire
// ─────────────────────────────────────────────────────────────────────────────

export interface PartLimite {
  /** Cle de comparaison : nom de la limite de niveau 1, sans accent ni casse (calcule par la base). */
  cle: string;
  nom: string;
  /** Part de la longueur du trace dans cette limite, entre 0 et 1. */
  part: number;
}

export interface MesureRegion extends Identite {
  regionNom: string | null;
  /** Cle (sans accent ni casse) de la region declaree. */
  regionCle: string | null;
  /** Vrai si la region declaree est le substitut « Non renseigne ». */
  regionNonRenseignee: boolean;
  /** Vrai si une limite de niveau 1 de meme cle existe : sinon la comparaison est impossible. */
  regionALimite: boolean;
  /** Statut de perimetre declare (NATIONAL, HORS_TERRITOIRE_NATIONAL, VOIRIE_LOCALE) ou null. */
  perimetre: string | null;
  parts: readonly PartLimite[];
}

export function classerRegion(m: MesureRegion, seuils: Seuils): AnomalieDetectee[] {
  const parts = m.parts.filter((p) => fini(p.part));
  if (parts.length === 0) {
    // Hors de toute limite. Un statut HORS_TERRITOIRE_NATIONAL deja pose documente l'objet : il reste
    // signale (c'est un fait), mais ne demande plus d'action.
    const documente = m.perimetre === "HORS_TERRITOIRE_NATIONAL";
    return [anomalie("HORS_TERRITOIRE", m, {
      perimetreDeclare: m.perimetre, regionDeclaree: m.regionNom, statutDejaDocumente: documente,
    }, { gravite: documente ? "A_SURVEILLER" : "A_TRAITER" })];
  }

  const dominante = parts.reduce((a, b) => (b.part > a.part ? b : a));
  const dansDeclaree = m.regionCle === null ? 0 : parts.filter((p) => p.cle === m.regionCle).reduce((s, p) => s + p.part, 0);
  const commun = {
    regionDeclaree: m.regionNom,
    regionDominante: dominante.nom,
    partDansRegionDeclaree: arrondir(dansDeclaree, 4),
    partDansRegionDominante: arrondir(dominante.part, 4),
  };

  if (m.regionNonRenseignee) {
    return [anomalie("REGION_NON_RENSEIGNEE", m, commun, { mesure: dominante.part })];
  }
  if (!m.regionALimite) {
    return [anomalie("REGION_NON_VERIFIABLE", m, commun)];
  }
  // La dominante doit aussi l'emporter sur la region declaree : a egalite (45/45/10), la region
  // declaree est aussi bien placee que l'autre et le troncon n'est pas dit discordant.
  if (dominante.cle !== m.regionCle && depasse(dominante.part, seuils.REGION_MAJORITE) && dominante.part > dansDeclaree) {
    const nette = dansDeclaree < seuils.REGION_PART_DECLAREE_FAIBLE;
    return [anomalie("REGION_DISCORDANTE", m, { ...commun, entierementAilleurs: nette }, {
      gravite: nette ? "A_TRAITER" : "A_SURVEILLER",
      seuil: seuilApplique("REGION_MAJORITE", seuils),
      mesure: dominante.part - dansDeclaree,
    })];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// (e) Doublons de geometrie
// ─────────────────────────────────────────────────────────────────────────────

/** Une paire (troncon examine, autre troncon actif) relevee par le depot parmi les voisins de meme emprise. */
export interface PaireVoisine extends Identite {
  partenaireId: string;
  partenaireCode: string;
  partenaireRegionId: number | null;
  partenaireSourceReference: string | null;
  /** ST_AsBinary identique. */
  binaireIdentique: boolean;
  /** ST_AsBinary identique apres inversion du sens du partenaire. */
  inverseIdentique: boolean;
  /** Distance de Hausdorff planaire en degres, ou null quand les binaires sont deja egaux. */
  hausdorffDeg: number | null;
}

/**
 * Regroupe les paires par troncon examine. Un troncon qui a un jumeau STRICT est signale strict
 * (ses jumeaux quasi figurent aussi dans `partenaires`) ; sinon quasi s'il a au moins un voisin a
 * distance de Hausdorff <= seuil. Une paire dont les deux membres sont examines produit une anomalie
 * pour chacun : le compte est un compte d'ENTITES, pas de paires.
 */
export function classerDoublons(paires: readonly PaireVoisine[], seuils: Seuils): AnomalieDetectee[] {
  const parTroncon = new Map<string, PaireVoisine[]>();
  for (const p of paires) {
    const g = parTroncon.get(p.id);
    if (g) g.push(p);
    else parTroncon.set(p.id, [p]);
  }

  const sortie: AnomalieDetectee[] = [];
  for (const g of parTroncon.values()) {
    const stricts = g.filter((p) => p.binaireIdentique || p.inverseIdentique);
    const quasis = g.filter((p) => !(p.binaireIdentique || p.inverseIdentique)
      && fini(p.hausdorffDeg) && p.hausdorffDeg <= seuils.DOUBLON_QUASI_TOLERANCE_DEG);
    const concernes = stricts.length > 0 ? [...stricts, ...quasis] : quasis;
    if (concernes.length === 0) continue;
    const t = g[0];
    const code: CodeAnomalie = stricts.length > 0 ? "DOUBLON_GEOMETRIE_STRICT" : "DOUBLON_GEOMETRIE_QUASI";
    const plusProche = concernes.reduce((a, b) => ((b.hausdorffDeg ?? 0) < (a.hausdorffDeg ?? 0) ? b : a));
    sortie.push(anomalie(code, t, {
      partenaires: concernes.map((p) => p.partenaireId),
      partenairesCodes: concernes.map((p) => p.partenaireCode),
      partenairesRegions: concernes.map((p) => p.partenaireRegionId ?? "sans region"),
      partenairesSourceReference: concernes.map((p) => p.partenaireSourceReference ?? "(aucune)"),
      nombrePartenairesStricts: stricts.length,
      sensInverse: stricts.length > 0 ? stricts.every((p) => !p.binaireIdentique) : false,
      distanceHausdorffDeg: stricts.length > 0 ? 0 : (plusProche.hausdorffDeg ?? null),
    }, {
      seuil: code === "DOUBLON_GEOMETRIE_QUASI" ? seuilApplique("DOUBLON_QUASI_TOLERANCE_DEG", seuils) : null,
      mesure: concernes.length,
    }));
  }
  return sortie;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agregation : compteurs par code et par region, listes plafonnees
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeCode {
  code: CodeAnomalie;
  famille: FamilleDetecteur;
  gravite: GraviteDetecteur;
  /** Nombre EXACT d'entites en cause (la liste ci-dessous peut etre plafonnee, pas ce compte). */
  nombre: number;
  /** Vrai si `entites` ne contient pas toutes les entites. */
  tronque: boolean;
  entites: AnomalieDetectee[];
}

export interface ResumeRegion {
  regionId: number | null;
  total: number;
  parCode: Partial<Record<CodeAnomalie, number>>;
}

export interface Agregat {
  total: number;
  parCode: ResumeCode[];
  parRegion: ResumeRegion[];
}

const RANG: Record<GraviteDetecteur, number> = { BLOQUANTE: 0, A_TRAITER: 1, A_SURVEILLER: 2 };

function plusGrosseDAbord(a: AnomalieDetectee, b: AnomalieDetectee): number {
  return (b.mesure ?? -Infinity) - (a.mesure ?? -Infinity) || a.entiteId.localeCompare(b.entiteId);
}

/**
 * Accumule des anomalies en flot. Le COMPTE par code et par region est exact ; la liste des entites
 * par code est plafonnee aux `plafondParCode` plus grosses (mesure decroissante, puis identifiant),
 * ce qui la rend deterministe. La gravite d'un code est la plus elevee rencontree (un code peut etre
 * nuance : REGION_DISCORDANTE, HORS_TERRITOIRE).
 */
export class AccumulateurAnomalies {
  private readonly parCode = new Map<CodeAnomalie, { nombre: number; gravite: GraviteDetecteur; entites: AnomalieDetectee[] }>();
  private readonly parRegion = new Map<number | null, { total: number; parCode: Partial<Record<CodeAnomalie, number>> }>();
  private total = 0;

  constructor(private readonly plafondParCode: number) {
    if (!Number.isInteger(plafondParCode) || plafondParCode < 0) throw new Error("plafondParCode invalide");
  }

  ajouter(a: AnomalieDetectee): void {
    this.total++;
    let c = this.parCode.get(a.code);
    if (!c) {
      c = { nombre: 0, gravite: a.gravite, entites: [] };
      this.parCode.set(a.code, c);
    }
    c.nombre++;
    if (RANG[a.gravite] < RANG[c.gravite]) c.gravite = a.gravite;
    if (this.plafondParCode > 0) {
      c.entites.push(a);
      // Elagage amorti : on ne trie que lorsque la liste a double, pour rester lineaire.
      if (c.entites.length > 2 * this.plafondParCode) {
        c.entites.sort(plusGrosseDAbord);
        c.entites.length = this.plafondParCode;
      }
    }

    let r = this.parRegion.get(a.regionId);
    if (!r) {
      r = { total: 0, parCode: {} };
      this.parRegion.set(a.regionId, r);
    }
    r.total++;
    r.parCode[a.code] = (r.parCode[a.code] ?? 0) + 1;
  }

  ajouterTout(liste: readonly AnomalieDetectee[]): void {
    for (const a of liste) this.ajouter(a);
  }

  resultat(): Agregat {
    const parCode: ResumeCode[] = [...this.parCode.entries()].map(([code, c]) => {
      const entites = [...c.entites].sort(plusGrosseDAbord).slice(0, this.plafondParCode);
      return {
        code,
        famille: CATALOGUE_CODES[code].famille,
        gravite: c.gravite,
        nombre: c.nombre,
        tronque: entites.length < c.nombre,
        entites,
      };
    }).sort((x, y) => RANG[x.gravite] - RANG[y.gravite] || y.nombre - x.nombre || x.code.localeCompare(y.code));

    const parRegion: ResumeRegion[] = [...this.parRegion.entries()]
      .map(([regionId, r]) => ({ regionId, total: r.total, parCode: r.parCode }))
      .sort((x, y) => (x.regionId ?? Number.MAX_SAFE_INTEGER) - (y.regionId ?? Number.MAX_SAFE_INTEGER));

    return { total: this.total, parCode, parRegion };
  }
}
