/**
 * Vocabulaire et regles d'heritage du NOYAU PUR des reseaux physiques et circuits logiques (lot B1).
 * Contrat : docs/projets-voirie/CONTRAT-RESEAUX.md. Sans base, sans E/S : tout ce qui est ici se teste sans PostGIS.
 *
 * Les valeurs des enumerations sont celles de la base (migration 20261101200000) et de `schema.prisma`.
 */

/** Natures qu'un descripteur d'objet peut DECLARER. AXE et EMPRISE sont reservees aux plans d'axes et aux limites de route ; INCONNUE ne se declare pas (absence de descripteur). */
export const NATURES_DECLARABLES = ["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT"] as const;
export type NatureDeclarable = (typeof NATURES_DECLARABLES)[number];

export type NatureObjet = NatureDeclarable | "AXE" | "EMPRISE" | "INCONNUE";
export type TypeGeom = "LIGNE" | "POINT" | "POLYGONE";
export type ClassePrecision = "A" | "B" | "C" | "D" | "E";

export const NIVEAUX_CONFIANCE = ["ELEVE", "MOYEN", "FAIBLE"] as const;
export type NiveauConfiance = (typeof NIVEAUX_CONFIANCE)[number];

export const STATUTS_QUALITE = ["OBSERVE", "IMPORTE_NON_VERIFIE", "DERIVE", "CONTREDIT", "INCONNU"] as const;
export type StatutQualite = (typeof STATUTS_QUALITE)[number];

/**
 * Types d'objet proposes par nature (cahier v2, 20.1). Liste de CONFORT validee par le service, pas par la base (la base ne verifie que
 * la forme du code) : l'etendre ne demande aucune migration. Un type absent (nul) est un type INCONNU, autorise.
 */
export const TYPES_OBJET_PAR_NATURE: Readonly<Record<NatureDeclarable, readonly string[]>> = {
  ACTIF_PHYSIQUE: ["CONDUITE", "GAINE", "FOURREAU", "CABLE", "CANALISATION", "COLLECTEUR", "CHAMBRE", "REGARD", "POTEAU", "AUTRE"],
  CIRCUIT_LOGIQUE: ["LIAISON", "FIBRE", "RESEAU", "SERVICE", "AUTRE"],
  EQUIPEMENT: ["VANNE", "TRANSFORMATEUR", "BOITE", "JONCTION", "ARMOIRE", "COMPTEUR", "BORNE", "AUTRE"],
};

export const TYPES_RELATION = ["PORTE_PAR", "CONTENU_DANS"] as const;
export type TypeRelation = (typeof TYPES_RELATION)[number];

export const STATUTS_RELATION = ["PROPOSEE", "VALIDEE", "REFUSEE", "REVOQUEE"] as const;
export type StatutRelation = (typeof STATUTS_RELATION)[number];

export const ORIGINES_RELATION = ["AUTOMATIQUE", "MANUELLE"] as const;
export type OrigineRelation = (typeof ORIGINES_RELATION)[number];

/** Un identifiant d'objet (`bigint` de la base, rendu en TEXTE) : entier positif sur au plus 18 chiffres, la seule forme acceptee sans debordement. */
export const ID_OBJET = /^[1-9][0-9]{0,17}$/;

/** Longueur minimale d'une justification humaine (comme les autres decisions du module). */
export const JUSTIFICATION_MIN = 10;

// ------------------------------------------------------------------------------------------------
// Heritage : l'objet porte sa valeur, sinon le jeu, sinon l'inconnu. JAMAIS une valeur inventee.
// ------------------------------------------------------------------------------------------------

export type OrigineValeur = "OBJET" | "JEU" | "INCONNUE";

/**
 * Nature EFFECTIVE d'un objet : celle de son descripteur si elle y est declaree, sinon celle du jeu (`natureObjets`), sinon INCONNUE.
 * Une nature de jeu INCONNUE reste INCONNUE : un objet de nature inconnue n'est compte ni comme infrastructure ni comme circuit.
 */
export function natureEffective(natureDescripteur: string | null | undefined, natureJeu: string | null | undefined): { nature: NatureObjet; origine: OrigineValeur } {
  if (natureDescripteur && (NATURES_DECLARABLES as readonly string[]).includes(natureDescripteur)) return { nature: natureDescripteur as NatureDeclarable, origine: "OBJET" };
  if (natureJeu && natureJeu !== "INCONNUE") return { nature: natureJeu as NatureObjet, origine: "JEU" };
  return { nature: "INCONNUE", origine: "INCONNUE" };
}

/** Classe de precision EFFECTIVE : celle du descripteur si elle y est declaree, sinon celle du jeu, sinon INCONNUE (nulle). Jamais deduite. */
export function classeEffective(classeDescripteur: string | null | undefined, classeJeu: string | null | undefined): { classe: ClassePrecision | null; origine: OrigineValeur } {
  if (classeDescripteur) return { classe: classeDescripteur as ClassePrecision, origine: "OBJET" };
  if (classeJeu) return { classe: classeJeu as ClassePrecision, origine: "JEU" };
  return { classe: null, origine: "INCONNUE" };
}

/** Precision horizontale effective (metres) : celle du descripteur, sinon celle du jeu, sinon nulle. */
export function precisionHorizontaleEffective(descripteurM: number | null | undefined, jeuM: number | null | undefined): number | null {
  return descripteurM ?? jeuM ?? null;
}

// ------------------------------------------------------------------------------------------------
// Compatibilite nature / geometrie d'un descripteur
// ------------------------------------------------------------------------------------------------

/** Geometries admises par nature : un circuit logique est une ligne, un equipement un point, un actif physique n'importe quelle geometrie. */
export const GEOMETRIES_PAR_NATURE: Readonly<Record<NatureDeclarable, readonly TypeGeom[]>> = {
  ACTIF_PHYSIQUE: ["LIGNE", "POINT", "POLYGONE"],
  CIRCUIT_LOGIQUE: ["LIGNE"],
  EQUIPEMENT: ["POINT"],
};

/** Roles de jeu dont les objets peuvent recevoir un descripteur (pas les plans d'axes ni les limites de route). */
export const ROLES_QUALIFIABLES = ["RESEAU_TIERS", "AUTRE"] as const;

export type VerdictDescripteur = { ok: true } | { ok: false; code: "ROLE_NON_QUALIFIABLE" | "NATURE_INCOMPATIBLE_GEOMETRIE" | "TYPE_OBJET_INCONNU_POUR_NATURE" | "TYPE_OBJET_SANS_NATURE"; message: string };

/**
 * Un descripteur est-il coherent avec l'objet qu'il decrit ? `natureEff` : la nature qui s'appliquera (declaree, sinon celle du jeu) ;
 * `typeObjet` exige une nature connue (une nature inconnue ne permet pas de verifier le type).
 */
export function verifierDescripteur(o: { role: string; typeGeom: TypeGeom; natureEff: NatureObjet; typeObjet: string | null }): VerdictDescripteur {
  if (!(ROLES_QUALIFIABLES as readonly string[]).includes(o.role)) {
    return { ok: false, code: "ROLE_NON_QUALIFIABLE", message: "Seuls les objets d'un réseau de concessionnaire (ou d'un jeu « autre ») peuvent être qualifiés : pas les axes de travaux ni les limites de route." };
  }
  const n = o.natureEff;
  if ((NATURES_DECLARABLES as readonly string[]).includes(n)) {
    const nd = n as NatureDeclarable;
    if (!GEOMETRIES_PAR_NATURE[nd].includes(o.typeGeom)) {
      return { ok: false, code: "NATURE_INCOMPATIBLE_GEOMETRIE", message: `Un objet de nature ${nd} ne peut pas avoir une géométrie de type ${o.typeGeom} (attendu : ${GEOMETRIES_PAR_NATURE[nd].join(", ")}).` };
    }
    if (o.typeObjet !== null && !TYPES_OBJET_PAR_NATURE[nd].includes(o.typeObjet)) {
      return { ok: false, code: "TYPE_OBJET_INCONNU_POUR_NATURE", message: `Le type « ${o.typeObjet} » n'existe pas pour la nature ${nd} (types : ${TYPES_OBJET_PAR_NATURE[nd].join(", ")}).` };
    }
  } else if (o.typeObjet !== null) {
    return { ok: false, code: "TYPE_OBJET_SANS_NATURE", message: "Un type d'objet exige une nature connue : déclarez la nature de l'objet, ou précisez celle du jeu, avant d'en donner le type." };
  }
  return { ok: true };
}
