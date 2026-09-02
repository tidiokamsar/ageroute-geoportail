import { prisma } from "./prisma";

/**
 * Longueur du reseau routier, en distinguant ce qui est SAISI de ce qui est CALCULE.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Le tableau de bord annoncait « 7 933 km » comme longueur du reseau national. Ce
 * chiffre est la somme de `longueurKm`, et il ne compte en realite que les routes
 * dont quelqu'un a saisi la longueur. Mesure du 01/09/2026 :
 *
 *     RN   621 troncons   621 avec longueur    7 840 km saisis    7 824 km calcules
 *     RU    40 troncons    40 avec longueur       36 km saisis       36 km calcules
 *     RR 1 029 troncons     1 avec longueur       56 km saisis   13 296 km calcules
 *
 * Le champ a ete rempli integralement pour deux classes et pas du tout pour la
 * troisieme. L'indicateur public sous-estimait donc le reseau de 63 %.
 *
 * POURQUOI ON N'ECRIT PAS LA VALEUR CALCULEE DANS longueurKm
 *
 * Les deux valeurs ne repondent pas a la meme question. La longueur geometrique est
 * la longueur du trace numerise : reproductible, verifiable, elle se recalcule seule
 * quand le trace est corrige. La longueur metier est celle qui figure aux marches et
 * aux decomptes — c'est elle qui engage financierement, et elle peut legitimement
 * differer (bornage administratif, section non traitee, arrondi contractuel).
 *
 * Ecraser l'une par l'autre ferait passer un calcul pour un engagement. Les 662
 * valeurs saisies concordent d'ailleurs a moins de 1 % avec leur geometrie, sans
 * aucun ecart intermediaire : il n'y a rien a corriger, seulement a completer.
 *
 * CE QUE VAUT LA VALEUR CALCULEE
 *
 * Elle a ete confrontee a une source externe : une extraction OpenStreetMap de mars
 * 2023 donne 21 490 km pour le reseau classe, contre 21 156 km ici. Un ecart de 1,6 %
 * entre deux jeux constitues independamment.
 *
 * Reserve a garder en tete : la geometrie des regionales est cinq fois plus grossiere
 * que celle des nationales (2,2 points/km contre 12,0). L'effet mesure sur la longueur
 * reste sous 1 % — degrader la geometrie des nationales jusqu'a 1,6 point/km conserve
 * 99,09 % de leur longueur — mais la valeur calculee reste une borne basse.
 */

export interface LongueurParClasse {
  classe: string;
  troncons: number;
  /** Troncons dont la longueur metier est saisie et non nulle. */
  tronconsAvecLongueurMetier: number;
  /** Somme de `longueurKm`. Valeur SAISIE. */
  kmMetier: number;
  /** Somme de ST_Length(geom::geography). Valeur CALCULEE, jamais ecrite en base. */
  kmGeometrique: number;
}

export interface LongueurReseau {
  metier: {
    totalKm: number;
    tronconsRenseignes: number;
    tronconsTotal: number;
    /** Part des troncons dont la longueur metier est connue. */
    couverturePct: number;
  };
  geometrique: {
    totalKm: number;
    /** Rendu explicite pour que l'interface puisse citer la methode, pas seulement le chiffre. */
    methode: string;
  };
  parClasse: LongueurParClasse[];
}

interface LigneBrute {
  classe: string;
  troncons: bigint;
  avec_longueur: bigint;
  km_metier: number | null;
  km_geometrique: number | null;
}

/** `count(*)` revient en bigint depuis PostgreSQL ; JSON ne sait pas le serialiser. */
const nombre = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

/** Deux decimales suffisent : au-dela, on afficherait une precision que la donnee n'a pas. */
const arrondi = (v: number): number => Math.round(v * 100) / 100;

export async function longueurReseau(): Promise<LongueurReseau> {
  const lignes = await prisma.$queryRaw<LigneBrute[]>`
    SELECT
      classe::text                                                       AS classe,
      count(*)                                                           AS troncons,
      count(*) FILTER (WHERE "longueurKm" > 0)                           AS avec_longueur,
      COALESCE(SUM("longueurKm"), 0)                                     AS km_metier,
      COALESCE(SUM(ST_Length(geom::geography) / 1000.0), 0)              AS km_geometrique
    FROM troncons
    WHERE "deletedAt" IS NULL
    GROUP BY classe
    ORDER BY classe
  `;

  const parClasse: LongueurParClasse[] = lignes.map((l) => ({
    classe: l.classe,
    troncons: nombre(l.troncons),
    tronconsAvecLongueurMetier: nombre(l.avec_longueur),
    kmMetier: arrondi(nombre(l.km_metier)),
    kmGeometrique: arrondi(nombre(l.km_geometrique)),
  }));

  const tronconsTotal = parClasse.reduce((s, c) => s + c.troncons, 0);
  const tronconsRenseignes = parClasse.reduce((s, c) => s + c.tronconsAvecLongueurMetier, 0);

  return {
    metier: {
      totalKm: arrondi(parClasse.reduce((s, c) => s + c.kmMetier, 0)),
      tronconsRenseignes,
      tronconsTotal,
      couverturePct: tronconsTotal > 0 ? arrondi((tronconsRenseignes / tronconsTotal) * 100) : 0,
    },
    geometrique: {
      totalKm: arrondi(parClasse.reduce((s, c) => s + c.kmGeometrique, 0)),
      methode: "ST_Length(geom::geography)",
    },
    parClasse,
  };
}
