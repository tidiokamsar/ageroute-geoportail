import type { StatutLocalisation } from "@prisma/client";

/**
 * Niveau de localisation reel d'un chantier (T6).
 *
 * LE PROBLEME
 *
 * Mesure du 01/09/2026 sur les 488 chantiers :
 *
 *     geometrie propre                 6    1,2 %
 *     troncon + PK, sans geometrie     0    0,0 %
 *     region reelle                  432   88,5 %
 *     region « Non renseigne »        50   10,2 %
 *
 * La carte ne savait pas distinguer ces cas. Placer au centre d'une region un
 * chantier dont on ignore jusqu'a la region revient a inventer une position — et
 * c'est exactement ce que le §17 du cahier des charges interdit.
 *
 * LE QUATRIEME NIVEAU
 *
 * « Non renseigne » figure dans la table des regions comme s'il s'agissait d'une
 * region. Ce n'en est pas une : c'est un contournement de la contrainte d'obligation
 * sur `regionId`. Les 50 chantiers qui s'y rattachent n'ont aucune localisation, pas
 * meme approximative, et ne doivent pas apparaitre sur une carte.
 *
 * LE NIVEAU INTERMEDIAIRE EST VIDE
 *
 * Aucun chantier n'est reference par route + PK seuls : les 4 qui portent un
 * `tronconId` sont les memes que ceux qui ont deja une geometrie. Le niveau le plus
 * realiste a alimenter n'est utilise par personne, ce qui est precisement ce que T5
 * cherche a corriger.
 */

/** Nom de l'entree de la table des regions qui tient lieu d'absence de region. */
export const REGION_NON_RENSEIGNEE = "Non renseigné";

export interface ChantierALocaliser {
  aGeometrie: boolean;
  tronconId: string | null;
  pkDebut: number | null;
  pkFin: number | null;
  regionNom: string | null;
}

export interface Localisation {
  statut: StatutLocalisation;
  /** Ce que l'interface affiche a cote du chantier. Rendu ici pour ne pas diverger d'un ecran a l'autre. */
  libelle: string;
  /**
   * Vrai si le chantier peut figurer sur une carte a une position qui lui est propre.
   * Faux pour NONE : il n'y a rien a placer, et un point par defaut serait une
   * information fausse.
   */
  cartographiable: boolean;
  /** Ce qui fonde le niveau, pour que l'utilisateur puisse en juger. */
  fondement: string;
}

export function localisationDe(c: ChantierALocaliser): Localisation {
  if (c.aGeometrie) {
    return {
      statut: "PRECISE",
      libelle: "Localisation précise",
      cartographiable: true,
      fondement: "emprise géométrique enregistrée",
    };
  }

  // Referencement lineaire complet : la route ET la position sur la route.
  if (c.tronconId && c.pkDebut != null && c.pkFin != null) {
    return {
      statut: "LINEAIRE",
      libelle: "Emprise déduite des PK",
      cartographiable: true,
      fondement: "tronçon et points kilométriques de début et de fin",
    };
  }

  // La route est connue, pas la position sur la route. C'est mieux qu'une region,
  // mais ce n'est pas une emprise : le chantier couvre alors toute la route.
  if (c.tronconId) {
    return {
      statut: "APPROXIMATIVE",
      libelle: "Rattaché à une route, position inconnue",
      cartographiable: true,
      fondement: "tronçon connu, sans point kilométrique",
    };
  }

  const region = c.regionNom?.trim();
  if (!region || region === REGION_NON_RENSEIGNEE) {
    return {
      statut: "NONE",
      libelle: "Localisation absente",
      // Le point cle du ticket : ces chantiers sortent de la carte.
      cartographiable: false,
      fondement:
        region === REGION_NON_RENSEIGNEE
          ? "rattaché à l'entrée « Non renseigné », qui n'est pas une région"
          : "aucune région",
    };
  }

  return {
    statut: "APPROXIMATIVE",
    libelle: "Position régionale, non localisée",
    cartographiable: true,
    fondement: `région ${region}, sans précision supplémentaire`,
  };
}

/** Repartition des niveaux, pour les indicateurs et les tests de non-regression. */
export function repartitionLocalisation(
  chantiers: ChantierALocaliser[]
): Record<StatutLocalisation, number> {
  const r: Record<StatutLocalisation, number> = {
    PRECISE: 0,
    LINEAIRE: 0,
    APPROXIMATIVE: 0,
    NONE: 0,
  };
  for (const c of chantiers) r[localisationDe(c).statut]++;
  return r;
}
