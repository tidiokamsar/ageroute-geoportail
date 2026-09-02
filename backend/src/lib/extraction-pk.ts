import type { NiveauConfiance } from "@prisma/client";

/**
 * Extrait une reference lineaire — route + PK — d'un intitule de chantier (T5).
 *
 * POURQUOI C'EST DIFFICILE
 *
 * Les intitules sont du texte libre saisi depuis des dossiers de marche. Sur les 36
 * qui contiennent a la fois une route et un PK, on trouve :
 *
 *   « lot 12:travaux de cantonnage manuel de la route  PK24  - PK66  RN5 ( 42 km) »
 *       -> deux PK, une route, une longueur de controle : cas ideal
 *
 *   « lot 29 : ... route nationale Kankan - pk 41 (Kouroussa) rn 1 »
 *       -> UN seul PK. L'autre extremite est une localite. Aucune emprise calculable.
 *
 *   « lot 11:... route Gaoual (Kounsitel) - pk 24 rn23- rn5 ( 41 km) »
 *       -> DEUX routes citees. Laquelle ? On ne peut pas trancher.
 *
 *   « lot 33 : ... pk 106 - Siguiri - pk 160 axe Kankan - Kouremale (54 km) rn 6 »
 *       -> deux PK separes par une localite : lisible, mais le motif n'est pas contigu.
 *
 *   « ... RN38 entre Boula et la Frontiere ... situes au PK94+300 et PK135+100 »
 *       -> PK avec decalage metrique, et il s'agit de deux PONTS, pas d'une emprise.
 *
 * LE PRINCIPE
 *
 * Refuser plutot que deviner. Une proposition n'est emise que lorsque le texte
 * designe UNE route et DEUX PK sans ambiguite. Deux routes citees, un seul PK, ou
 * aucune route : pas d'emprise proposee.
 *
 * C'est ce que demande le §18 du cahier des charges — ne pas geocoder automatiquement
 * a partir d'un nom ambigu — et ce que la lecture des intitules confirme.
 *
 * LA LONGUEUR CITEE SERT DE CONTROLE
 *
 * 221 intitules portent une longueur. L'ecart entre cette longueur et celle de
 * l'emprise calculee dit si l'extraction a vu juste : c'est ce qu'un agent regarde en
 * premier avant de valider.
 */

export interface ReferenceExtraite {
  /** Designation normalisee : « RN5 », « RN23 ». Null si aucune route n'est citee. */
  route: string | null;
  /** Toutes les designations rencontrees, pour signaler une ambiguite. */
  routesCitees: string[];
  /** PK trouves, en kilometres, dans l'ordre du texte. */
  pks: number[];
  pkDebut: number | null;
  pkFin: number | null;
  /** Longueur annoncee dans le texte, en kilometres. Sert de controle, jamais de source. */
  longueurCiteeKm: number | null;
  confiance: NiveauConfiance | null;
  /** « INTITULE_ROUTE_PK », « INTITULE_ROUTE_SEULE », ou null si rien d'exploitable. */
  methode: string | null;
  /** Pourquoi cette proposition — ou pourquoi il n'y en a pas. */
  motif: string;
}

const RIEN = (motif: string): ReferenceExtraite => ({
  route: null,
  routesCitees: [],
  pks: [],
  pkDebut: null,
  pkFin: null,
  longueurCiteeKm: null,
  confiance: null,
  methode: null,
  motif,
});

/**
 * PK sous toutes ses formes rencontrees : « PK24 », « pk 41 », « PK 40+00 »,
 * « PK94+300 », « pk50km ».
 *
 * Le decalage apres « + » est en METRES dans les intitules observes (PK94+300 =
 * 94,3 km). Il est donc divise par 1 000, et ignore au-dela de 999 pour ne pas
 * confondre avec une autre notation.
 */
const MOTIF_PK = /\bpk\s*(\d{1,4})(?:\s*\+\s*(\d{1,3}))?/gi;

/** « RN5 », « rn 1 », « RN 38 », « (RN2) », « rr12 ». */
const MOTIF_ROUTE = /\b(RN|RR)\s*-?\s*(\d{1,3})\b/gi;

/** « 42 km », « 43km », « (68,06 Km) », « 50 KM ». Les « ml » sont des metres lineaires. */
const MOTIF_LONGUEUR_KM = /(\d{1,4}(?:[.,]\d{1,2})?)\s*km\b/gi;

function extraireRoutes(texte: string): string[] {
  const vues = new Set<string>();
  for (const m of texte.matchAll(MOTIF_ROUTE)) {
    vues.add(`${m[1].toUpperCase()}${parseInt(m[2], 10)}`);
  }
  return [...vues];
}

function extrairePks(texte: string): number[] {
  const pks: number[] = [];
  for (const m of texte.matchAll(MOTIF_PK)) {
    const km = parseInt(m[1], 10);
    const metres = m[2] ? parseInt(m[2], 10) : 0;
    pks.push(km + metres / 1000);
  }
  return pks;
}

function extraireLongueur(texte: string): number | null {
  const valeurs = [...texte.matchAll(MOTIF_LONGUEUR_KM)].map((m) =>
    parseFloat(m[1].replace(",", "."))
  );
  if (valeurs.length === 0) return null;
  // Plusieurs longueurs citees : on retient la plus grande, qui designe en general
  // l'ouvrage principal plutot qu'un detail de structure.
  return Math.max(...valeurs);
}

export function extraireReference(intitule: string | null | undefined): ReferenceExtraite {
  if (!intitule?.trim()) return RIEN("intitulé vide");

  const texte = intitule.trim();
  const routes = extraireRoutes(texte);
  const pks = extrairePks(texte);
  const longueurCiteeKm = extraireLongueur(texte);

  if (routes.length === 0) {
    return { ...RIEN("aucune désignation de route dans l'intitulé"), pks, longueurCiteeKm };
  }

  // Deux routes citees : on ne sait pas a laquelle rattacher les PK. « rn23- rn5 »
  // ou « (RN1) et ... (RN2) » sont des cas reels.
  if (routes.length > 1) {
    return {
      ...RIEN(`${routes.length} routes citées (${routes.join(", ")}) — rattachement ambigu`),
      routesCitees: routes,
      pks,
      longueurCiteeKm,
    };
  }

  const route = routes[0];

  // Un seul PK : l'autre extremite est une localite, qu'aucun referentiel ne permet
  // de resoudre. On rattache a la route, sans emprise.
  if (pks.length < 2) {
    return {
      route,
      routesCitees: routes,
      pks,
      pkDebut: null,
      pkFin: null,
      longueurCiteeKm,
      confiance: "LOW",
      methode: "INTITULE_ROUTE_SEULE",
      motif:
        pks.length === 1
          ? "un seul PK : l'autre extrémité est une localité, aucune emprise calculable"
          : "route citée sans PK : rattachement à la route, sans emprise",
    };
  }

  // Deux PK ou plus. On retient les extremes : « pk 106 - Siguiri - pk 160 » donne
  // bien 106 et 160, et un intitule citant trois PK couvre l'intervalle le plus large.
  const pkDebut = Math.min(...pks);
  const pkFin = Math.max(...pks);

  if (pkDebut === pkFin) {
    return {
      route,
      routesCitees: routes,
      pks,
      pkDebut: null,
      pkFin: null,
      longueurCiteeKm,
      confiance: "LOW",
      methode: "INTITULE_ROUTE_SEULE",
      motif: "les PK cités sont identiques : aucune emprise calculable",
    };
  }

  // Plus de deux PK : souvent plusieurs ouvrages ponctuels plutot qu'une emprise
  // continue — « situes au PK94+300 et PK135+100 » designe deux ponts. On propose
  // quand meme, avec une confiance moindre, et l'agent tranche.
  const plusieurs = pks.length > 2;
  const ecartPct =
    longueurCiteeKm && longueurCiteeKm > 0
      ? Math.abs(pkFin - pkDebut - longueurCiteeKm) / longueurCiteeKm
      : null;

  // La longueur citee corrobore ou contredit l'extraction. C'est le seul controle
  // independant disponible.
  let confiance: NiveauConfiance = plusieurs ? "MEDIUM" : "HIGH";
  let motif = `route ${route}, PK ${pkDebut} à ${pkFin}`;

  if (ecartPct != null) {
    if (ecartPct <= 0.1) {
      motif += `, longueur citée ${longueurCiteeKm} km cohérente`;
    } else {
      confiance = "LOW";
      motif += `, mais la longueur citée (${longueurCiteeKm} km) s'écarte de ${Math.round(ecartPct * 100)} % de l'intervalle`;
    }
  } else {
    if (confiance === "HIGH") confiance = "MEDIUM";
    motif += ", aucune longueur citée pour recouper";
  }

  return {
    route,
    routesCitees: routes,
    pks,
    pkDebut,
    pkFin,
    longueurCiteeKm,
    confiance,
    methode: "INTITULE_ROUTE_PK",
    motif,
  };
}
