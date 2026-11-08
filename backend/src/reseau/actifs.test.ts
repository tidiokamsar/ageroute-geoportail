import { describe, expect, it } from "vitest";
import { TypeOuvrage } from "@prisma/client";
import {
  FORME_PAR_TYPE,
  LONGUEUR_ACTIF_MINIMALE_M,
  longueurEtendueM,
  longueurRetenue,
  refusEtendue,
  typesAvecEtendue,
  type TypeActif,
} from "./actifs";

/**
 * Les actifs lineaires : ce que ces tests defendent.
 *
 * LE TEST LE PLUS UTILE EST CELUI QUI ECHOUERA TOUT SEUL
 *
 * `FORME_PAR_TYPE` doit couvrir exactement l'enum Prisma. Le jour ou quelqu'un ajoute une
 * quatorzieme valeur a `TypeOuvrage` sans la ranger, le classement se taira : l'actif
 * tombera dans `undefined`, `refusEtendue` lira une forme inexistante, et aucune erreur ne
 * se produira — l'etendue serait simplement acceptee ou refusee au hasard. Le premier test
 * ci-dessous est la pour forcer a y penser.
 *
 * UN FOSSE PEUT ETRE REPERE AVANT D'ETRE MESURE
 *
 * Exiger les deux bornes des la creation empecherait d'inventorier un fosse qu'on vient de
 * voir. L'absence d'etendue n'est donc pas un refus ; une etendue INCOMPLETE l'est.
 *
 * LA PROVENANCE ACCOMPAGNE LA LONGUEUR
 *
 * Un metre de curage etabli sur une longueur declaree et un metre etabli sur l'etendue
 * geometrique n'ont pas la meme valeur de preuve. Rendre un nombre nu obligerait l'appelant
 * a deviner lequel il tient.
 */

const PONCTUEL: TypeActif = "PONT";
const LINEAIRE: TypeActif = "FOSSE";

function etendue(debutM: number | null, finM: number | null, tronconId: string | null = "t-1") {
  return { tronconId, abscisseDebutM: debutM, abscisseFinM: finM };
}

describe("Le classement couvre exactement l'enum", () => {
  it("chaque valeur de TypeOuvrage est rangee, sans trou ni surplus", () => {
    // Le test qui echouera tout seul le jour ou un type sera ajoute sans etre range.
    const prisma = Object.keys(TypeOuvrage).sort();
    const classees = Object.keys(FORME_PAR_TYPE).sort();
    expect(classees).toEqual(prisma);
  });

  it("les quatre familles ajoutees existent bien dans l'enum Prisma", () => {
    for (const t of ["FOSSE", "CANIVEAU", "SIGNALISATION", "GLISSIERE"]) {
      expect(Object.keys(TypeOuvrage)).toContain(t);
    }
  });

  it("ne propose une etendue que pour ce qui n'est pas ponctuel", () => {
    const avec = typesAvecEtendue();
    expect(avec).toContain("FOSSE");
    expect(avec).toContain("SIGNALISATION");
    expect(avec).not.toContain("PONT");
    expect(avec).not.toContain("BUSE");
  });
});

describe("Un actif repere mais pas mesure reste valide", () => {
  it("ACCEPTE un actif lineaire sans aucune etendue", () => {
    // Exiger les bornes des la creation empecherait d'inventorier un fosse qu'on vient de
    // voir depuis le vehicule.
    expect(refusEtendue(LINEAIRE, etendue(null, null), 20_000)).toBeNull();
  });

  it("ACCEPTE un actif ponctuel sans etendue, evidemment", () => {
    expect(refusEtendue(PONCTUEL, etendue(null, null), 20_000)).toBeNull();
  });
});

describe("Ce que l'etendue refuse", () => {
  it("REFUSE une etendue sur un type PONCTUEL", () => {
    // Un pont n'occupe pas une portion de route : son etendue n'a pas de sens le long du
    // trace, et l'accepter ferait croire a un metre de chaussee.
    expect(refusEtendue(PONCTUEL, etendue(100, 300), 20_000)).toBe("TYPE_PONCTUEL");
  });

  it("REFUSE une seule borne, qui ne decrit ni un point ni une ligne", () => {
    expect(refusEtendue(LINEAIRE, etendue(100, null), 20_000)).toBe("ETENDUE_INCOMPLETE");
    expect(refusEtendue(LINEAIRE, etendue(null, 300), 20_000)).toBe("ETENDUE_INCOMPLETE");
  });

  it("REFUSE des bornes inversees ou egales", () => {
    expect(refusEtendue(LINEAIRE, etendue(300, 100), 20_000)).toBe("ETENDUE_INVERSEE");
    expect(refusEtendue(LINEAIRE, etendue(300, 300), 20_000)).toBe("ETENDUE_INVERSEE");
  });

  it("REFUSE une abscisse negative", () => {
    expect(refusEtendue(LINEAIRE, etendue(-10, 300), 20_000)).toBe("ETENDUE_NEGATIVE");
  });

  it("REFUSE une etendue SANS troncon, parce qu'elle ne designerait rien", () => {
    // Des abscisses se mesurent le long d'une geometrie de reference. Sans troncon, ce sont
    // deux nombres flottants. Mieux vaut l'actif avec sa seule position.
    expect(refusEtendue(LINEAIRE, etendue(100, 300, null), 20_000)).toBe("ETENDUE_SANS_TRONCON");
  });

  it("REFUSE une etendue qui depasse le troncon", () => {
    expect(refusEtendue(LINEAIRE, etendue(19_000, 25_000), 20_000)).toBe("ETENDUE_HORS_TRONCON");
  });

  it("NE REFUSE PAS le depassement quand la longueur du troncon est inconnue", () => {
    // On ne sait pas ou le troncon s'arrete : refuser serait inventer une borne.
    expect(refusEtendue(LINEAIRE, etendue(19_000, 25_000), null)).toBeNull();
  });

  it("REFUSE sous deux metres, mais PAS sous dix", () => {
    // Le seuil n'a pas le meme sens que pour les portions : une glissiere de trois metres
    // devant un ouvrage existe reellement, une portion de chaussee de trois metres non.
    expect(refusEtendue(LINEAIRE, etendue(100, 101), 20_000)).toBe("TROP_COURTE");
    expect(refusEtendue(LINEAIRE, etendue(100, 103), 20_000)).toBeNull();
    expect(LONGUEUR_ACTIF_MINIMALE_M).toBe(2);
  });
});

describe("La signalisation accepte les deux formes", () => {
  it("un panneau, sans etendue", () => {
    expect(refusEtendue("SIGNALISATION", etendue(null, null), 20_000)).toBeNull();
  });

  it("un marquage axial, avec etendue", () => {
    // Forcer un choix ferait soit perdre l'etendue d'un marquage, soit exiger deux bornes
    // pour un panneau.
    expect(refusEtendue("SIGNALISATION", etendue(0, 4_000), 20_000)).toBeNull();
  });
});

describe("Trois des neuf types d'origine sont relus comme lineaires", () => {
  it("mur, tunnel et viaduc acceptent une etendue", () => {
    // Un mur de soutenement de 400 m est mal decrit par une epingle, et un viaduc est une
    // section de route a part entiere. Rien ne casse : les 1 172 ouvrages existants gardent
    // leurs abscisses nulles.
    for (const t of ["MUR_SOUTENEMENT", "TUNNEL", "VIADUC"] as TypeActif[]) {
      expect(FORME_PAR_TYPE[t]).toBe("LINEAIRE");
      expect(refusEtendue(t, etendue(0, 400), 20_000)).toBeNull();
    }
  });

  it("mais pont, dalot, buse, radier, ponceau et passerelle restent ponctuels", () => {
    for (const t of ["PONT", "DALOT", "BUSE", "RADIER", "PONCEAU", "PASSERELLE"] as TypeActif[]) {
      expect(FORME_PAR_TYPE[t]).toBe("PONCTUEL");
    }
  });
});

describe("Quelle longueur retenir, et d'ou elle vient", () => {
  it("l'ETENDUE prime sur la longueur declaree", () => {
    // L'etendue se verifie contre la geometrie ; la declaration non.
    const r = longueurRetenue(etendue(100, 450), 300);
    expect(r).toEqual({ longueurM: 350, provenance: "ETENDUE" });
  });

  it("se replie sur la DECLARATION, en le disant", () => {
    const r = longueurRetenue(etendue(null, null), 300);
    expect(r).toEqual({ longueurM: 300, provenance: "DECLAREE" });
  });

  it("rend NULL quand ni l'une ni l'autre n'existe, au lieu de zero", () => {
    // Zero serait une longueur mesuree, et un metre calcule dessus vaudrait zero sans que
    // personne sache pourquoi.
    expect(longueurRetenue(etendue(null, null), null)).toBeNull();
  });

  it("ignore une longueur declaree nulle ou negative", () => {
    expect(longueurRetenue(etendue(null, null), 0)).toBeNull();
    expect(longueurRetenue(etendue(null, null), -5)).toBeNull();
  });

  it("arrondit l'etendue au centimetre", () => {
    expect(longueurEtendueM(etendue(100.001, 450.009))).toBe(350.01);
  });
});
