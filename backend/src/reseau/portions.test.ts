import { describe, expect, it } from "vitest";
import {
  LONGUEUR_MINIMALE_M,
  chevauchements,
  couverture,
  decouper,
  fusionner,
  portionA,
  refusFusion,
  refusPortion,
  repartition,
  type Portion,
} from "./portions";

/**
 * Les portions homogenes : ce que ces tests defendent.
 *
 * LE RISQUE N'EST PAS UNE ERREUR D'ARITHMETIQUE
 *
 * Additionner des longueurs est facile, et une somme fausse se verrait. Ce qui ne se
 * verrait pas, c'est une repartition par revetement qui a l'air complete alors que 60 %
 * du troncon n'a jamais ete inventorie, ou une portion « en bon etat » nee de la fusion
 * de deux releves qui disaient autre chose.
 *
 * Ces tests defendent donc surtout les REFUS et les TROUS.
 *
 * MESURE QUI JUSTIFIE LE REFUS PRINCIPAL
 *
 * En production, le 13/10/2026 : `revetement` vaut NON_RENSEIGNE sur 258 961 troncons et
 * BITUME sur 2 426, sans une seule laterite. `etat` vaut NON_EVALUE sur 254 547 sur
 * 261 387. Deduire des portions de ces colonnes fabriquerait 261 387 observations que
 * personne n'a faites. Un troncon sans portion est donc NON QUALIFIE, et c'est teste.
 */

function p(partiel: Partial<Portion> & Pick<Portion, "id" | "debutM" | "finM">): Portion {
  return {
    tronconId: "t-1",
    revetement: "BITUME",
    etat: "BON",
    praticabilite: null,
    largeurM: null,
    source: "mission-2026-10",
    observeeLe: new Date("2026-10-01T00:00:00Z"),
    confiance: "HIGH",
    statutValidation: "VALIDE",
    remplaceeLe: null,
    deletedAt: null,
    ...partiel,
  };
}

describe("Une portion doit tenir debout sur son troncon", () => {
  it("accepte une portion normale", () => {
    expect(refusPortion({ debutM: 0, finM: 8000 }, 20000)).toBeNull();
  });

  it("REFUSE des bornes inversees ou nulles", () => {
    expect(refusPortion({ debutM: 500, finM: 200 }, 20000)).toBe("BORNES_INVERSEES");
    expect(refusPortion({ debutM: 500, finM: 500 }, 20000)).toBe("BORNES_INVERSEES");
  });

  it("REFUSE une portion qui depasse le troncon", () => {
    // Elle decrirait une route qui n'existe pas.
    expect(refusPortion({ debutM: 19000, finM: 21000 }, 20000)).toBe("HORS_TRONCON");
    expect(refusPortion({ debutM: -100, finM: 500 }, 20000)).toBe("HORS_TRONCON");
  });

  it("REFUSE une portion plus courte que le plancher de bruit", () => {
    // En dessous, on decrit la derive d'un GPS, pas un changement de chaussee.
    expect(refusPortion({ debutM: 0, finM: LONGUEUR_MINIMALE_M - 1 }, 20000)).toBe("TROP_COURTE");
  });

  it("REFUSE quand la longueur du troncon est inconnue, au lieu de la supposer", () => {
    // `longueurKm` et la longueur geometrique divergent, et la regle du depot interdit
    // d'ecraser l'une par l'autre. Sans longueur mesuree, on ne valide rien.
    expect(refusPortion({ debutM: 0, finM: 500 }, null)).toBe("LONGUEUR_TRONCON_INCONNUE");
    expect(refusPortion({ debutM: 0, finM: 500 }, 0)).toBe("LONGUEUR_TRONCON_INCONNUE");
  });
});

describe("La couverture nomme les trous au lieu de les resumer", () => {
  it("un troncon SANS portion est non qualifie, et n'herite de rien", () => {
    // Le test le plus important du fichier. En production, `revetement` ne dit rien sur
    // 258 961 troncons : en deduire une portion fabriquerait une observation.
    const c = couverture([], 20000);
    expect(c.qualifieM).toBe(0);
    expect(c.part).toBe(0);
    expect(c.trous).toEqual([{ debutM: 0, finM: 20000, longueurM: 20000 }]);
  });

  it("enonce OU se trouve le trou, pas seulement combien il mesure", () => {
    // « 60 % qualifie » n'envoie personne nulle part ; « non qualifie de 8 000 a 13 000 »
    // envoie une equipe au bon endroit.
    const c = couverture(
      [p({ id: "a", debutM: 0, finM: 8000 }), p({ id: "b", debutM: 13000, finM: 20000 })],
      20000,
    );
    expect(c.trous).toEqual([{ debutM: 8000, finM: 13000, longueurM: 5000 }]);
    expect(c.qualifieM).toBe(15000);
    expect(c.part).toBe(0.75);
  });

  it("couvre entierement un troncon decoupe bout a bout", () => {
    const c = couverture(
      [
        p({ id: "a", debutM: 0, finM: 8000 }),
        p({ id: "b", debutM: 8000, finM: 13000 }),
        p({ id: "c", debutM: 13000, finM: 17000 }),
        p({ id: "d", debutM: 17000, finM: 20000 }),
      ],
      20000,
    );
    expect(c.trous).toEqual([]);
    expect(c.part).toBe(1);
  });

  it("ne compte pas deux fois les metres couverts par deux portions", () => {
    const c = couverture(
      [p({ id: "a", debutM: 0, finM: 1000 }), p({ id: "b", debutM: 500, finM: 1500 })],
      2000,
    );
    expect(c.qualifieM).toBe(1500);
    expect(c.trous).toEqual([{ debutM: 1500, finM: 2000, longueurM: 500 }]);
  });

  it("ignore une portion supprimee logiquement, qui n'aurait pas du etre saisie", () => {
    // `deletedAt` et `remplaceeLe` ne disent pas la meme chose, mais ni l'une ni l'autre
    // ne decrit l'etat actuel du reseau.
    const c = couverture(
      [
        p({ id: "erreur", debutM: 0, finM: 20000, deletedAt: new Date("2026-10-02") }),
        p({ id: "bonne", debutM: 0, finM: 5000 }),
      ],
      20000,
    );
    expect(c.qualifieM).toBe(5000);
  });

  it("ignore les portions remplacees, qui sont de l'historique", () => {
    const c = couverture(
      [
        p({ id: "vieille", debutM: 0, finM: 20000, remplaceeLe: new Date("2026-09-01") }),
        p({ id: "neuve", debutM: 0, finM: 5000 }),
      ],
      20000,
    );
    expect(c.qualifieM).toBe(5000);
  });
});

describe("Les chevauchements sont signales, jamais corriges", () => {
  it("trouve deux portions qui se recouvrent et dit de combien", () => {
    // Choisir automatiquement laquelle garder trancherait une contradiction de terrain
    // depuis un serveur.
    const r = chevauchements([
      p({ id: "a", debutM: 0, finM: 1000 }),
      p({ id: "b", debutM: 800, finM: 1500 }),
    ]);
    expect(r).toEqual([{ a: "a", b: "b", longueurM: 200 }]);
  });

  it("ne voit pas de chevauchement entre portions simplement adjacentes", () => {
    expect(chevauchements([
      p({ id: "a", debutM: 0, finM: 1000 }),
      p({ id: "b", debutM: 1000, finM: 2000 }),
    ])).toEqual([]);
  });

  it("l'historique se recouvre par construction, et ne compte pas", () => {
    expect(chevauchements([
      p({ id: "vieille", debutM: 0, finM: 1000, remplaceeLe: new Date("2026-09-01") }),
      p({ id: "neuve", debutM: 0, finM: 1000 }),
    ])).toEqual([]);
  });
});

describe("Decouper", () => {
  it("rend deux morceaux et NE MODIFIE PAS l'original", () => {
    const origine = p({ id: "a", debutM: 0, finM: 20000 });
    const r = decouper(origine, 8000, ["g", "d"]);
    expect(r.refus).toBeNull();
    if (r.refus !== null) return;
    expect(r.morceaux[0]).toMatchObject({ id: "g", debutM: 0, finM: 8000 });
    expect(r.morceaux[1]).toMatchObject({ id: "d", debutM: 8000, finM: 20000 });
    // L'original garde ses bornes : c'est a l'appelant de le marquer remplace.
    expect(origine.finM).toBe(20000);
  });

  it("les morceaux heritent des attributs, et ne recoivent AUCUN etat nouveau", () => {
    // Decouper n'est pas qualifier. Donner d'office un etat different au second morceau
    // inventerait une observation que personne n'a faite.
    const r = decouper(p({ id: "a", debutM: 0, finM: 2000, etat: "MOYEN" }), 1000, ["g", "d"]);
    if (r.refus !== null) throw new Error("decoupe refusee");
    expect(r.morceaux[0].etat).toBe("MOYEN");
    expect(r.morceaux[1].etat).toBe("MOYEN");
    expect(r.morceaux[1].observeeLe).toEqual(r.morceaux[0].observeeLe);
  });

  it("REFUSE une coupe hors de la portion ou sur une borne", () => {
    const q = p({ id: "a", debutM: 100, finM: 2000 });
    expect(decouper(q, 50, ["g", "d"]).refus).toBe("HORS_PORTION");
    expect(decouper(q, 100, ["g", "d"]).refus).toBe("HORS_PORTION");
    expect(decouper(q, 2000, ["g", "d"]).refus).toBe("HORS_PORTION");
  });

  it("REFUSE une coupe qui produirait un morceau sous le plancher", () => {
    const q = p({ id: "a", debutM: 0, finM: 2000 });
    expect(decouper(q, 5, ["g", "d"]).refus).toBe("MORCEAU_TROP_COURT");
    expect(decouper(q, 1995, ["g", "d"]).refus).toBe("MORCEAU_TROP_COURT");
  });

  it("REFUSE de decouper de l'historique ou une portion supprimee", () => {
    const remplacee = p({ id: "a", debutM: 0, finM: 2000, remplaceeLe: new Date("2026-09-01") });
    expect(decouper(remplacee, 1000, ["g", "d"]).refus).toBe("PORTION_REMPLACEE");
    const supprimee = p({ id: "b", debutM: 0, finM: 2000, deletedAt: new Date("2026-09-01") });
    expect(decouper(supprimee, 1000, ["g", "d"]).refus).toBe("PORTION_REMPLACEE");
  });
});

describe("Fusionner", () => {
  it("fusionne deux portions adjacentes et identiques", () => {
    const r = fusionner(
      p({ id: "a", debutM: 0, finM: 1000 }),
      p({ id: "b", debutM: 1000, finM: 2500 }),
      "n",
    );
    expect(r.refus).toBeNull();
    if (r.refus !== null) return;
    expect(r.portion).toMatchObject({ id: "n", debutM: 0, finM: 2500 });
  });

  it("REFUSE de fusionner des attributs differents", () => {
    // La portion resultante aurait un etat choisi par le programme, pas observe.
    expect(refusFusion(
      p({ id: "a", debutM: 0, finM: 1000, etat: "BON" }),
      p({ id: "b", debutM: 1000, finM: 2000, etat: "MOYEN" }),
    )).toBe("ATTRIBUTS_DIFFERENTS");
  });

  it("REFUSE de fusionner une portion validee avec une proposition", () => {
    // Sinon la proposition entrerait dans le referentiel officiel sans decision.
    expect(refusFusion(
      p({ id: "a", debutM: 0, finM: 1000, statutValidation: "VALIDE" }),
      p({ id: "b", debutM: 1000, finM: 2000, statutValidation: "A_VALIDER" }),
    )).toBe("VALIDATIONS_DIFFERENTES");
  });

  it("REFUSE de fusionner par-dessus un trou", () => {
    expect(refusFusion(
      p({ id: "a", debutM: 0, finM: 1000 }),
      p({ id: "b", debutM: 1500, finM: 2000 }),
    )).toBe("NON_ADJACENTES");
  });

  it("REFUSE de fusionner des portions de troncons differents", () => {
    expect(refusFusion(
      p({ id: "a", debutM: 0, finM: 1000 }),
      p({ id: "b", debutM: 1000, finM: 2000, tronconId: "t-2" }),
    )).toBe("TRONCONS_DIFFERENTS");
  });

  it("prend la date la plus ANCIENNE et la confiance la plus FAIBLE", () => {
    // On ne gagne pas en fraicheur en additionnant deux releves.
    const r = fusionner(
      p({ id: "a", debutM: 0, finM: 1000, observeeLe: new Date("2026-01-01"), confiance: "HIGH" }),
      p({ id: "b", debutM: 1000, finM: 2000, observeeLe: new Date("2026-10-01"), confiance: "LOW" }),
      "n",
    );
    if (r.refus !== null) throw new Error("fusion refusee");
    expect(r.portion.observeeLe).toEqual(new Date("2026-01-01"));
    expect(r.portion.confiance).toBe("LOW");
  });

  it("perd la date des qu'un des deux releves n'en a pas", () => {
    // Une date absente n'est pas ancienne : elle est inconnue, et inconnu est pire que
    // vieux.
    const r = fusionner(
      p({ id: "a", debutM: 0, finM: 1000, observeeLe: new Date("2026-01-01") }),
      p({ id: "b", debutM: 1000, finM: 2000, observeeLe: null }),
      "n",
    );
    if (r.refus !== null) throw new Error("fusion refusee");
    expect(r.portion.observeeLe).toBeNull();
  });

  it("perd la source quand les deux releves ne viennent pas du meme endroit", () => {
    const r = fusionner(
      p({ id: "a", debutM: 0, finM: 1000, source: "mission-A" }),
      p({ id: "b", debutM: 1000, finM: 2000, source: "mission-B" }),
      "n",
    );
    if (r.refus !== null) throw new Error("fusion refusee");
    expect(r.portion.source).toBeNull();
  });
});

describe("Ou suis-je ?", () => {
  it("rend la portion qui contient l'abscisse", () => {
    const portions = [
      p({ id: "a", debutM: 0, finM: 8000 }),
      p({ id: "b", debutM: 8000, finM: 13000, etat: "MAUVAIS" }),
    ];
    expect(portionA(portions, 10000)?.id).toBe("b");
  });

  it("rend NULL dans un trou, et non la portion d'a cote", () => {
    // Repondre « la portion d'a cote » serait le rattachement arbitraire que
    // l'appariement refuse deja.
    const portions = [
      p({ id: "a", debutM: 0, finM: 8000 }),
      p({ id: "b", debutM: 13000, finM: 20000 }),
    ];
    expect(portionA(portions, 10000)).toBeNull();
  });

  it("en cas de contradiction, rend la plus recemment OBSERVEE", () => {
    const portions = [
      p({ id: "vieux", debutM: 0, finM: 1000, observeeLe: new Date("2026-01-01") }),
      p({ id: "recent", debutM: 500, finM: 1500, observeeLe: new Date("2026-10-01") }),
    ];
    expect(portionA(portions, 700)?.id).toBe("recent");
    // Et la contradiction reste visible.
    expect(chevauchements(portions)).toHaveLength(1);
  });
});

describe("La repartition ne laisse pas croire le reseau inventorie", () => {
  it("affiche TOUJOURS la part non qualifiee", () => {
    const r = repartition([p({ id: "a", debutM: 0, finM: 5000 })], 20000, "revetement");
    expect(r).toEqual([
      { cle: "NON_QUALIFIE", longueurM: 15000, part: 0.75 },
      { cle: "BITUME", longueurM: 5000, part: 0.25 },
    ]);
  });

  it("distingue revetement et etat, qui ne disent pas la meme chose", () => {
    // Une route peut etre bitumee et en mauvais etat.
    const portions = [
      p({ id: "a", debutM: 0, finM: 10000, revetement: "BITUME", etat: "BON" }),
      p({ id: "b", debutM: 10000, finM: 20000, revetement: "BITUME", etat: "CRITIQUE" }),
    ];
    expect(repartition(portions, 20000, "revetement")).toEqual([
      { cle: "BITUME", longueurM: 20000, part: 1 },
    ]);
    expect(repartition(portions, 20000, "etat")).toHaveLength(2);
  });

  it("une praticabilite jamais relevee ne devient pas un etat", () => {
    const r = repartition([p({ id: "a", debutM: 0, finM: 20000 })], 20000, "praticabilite");
    expect(r).toEqual([{ cle: "NON_RENSEIGNE", longueurM: 20000, part: 1 }]);
  });

  it("EXCLUT les propositions des statistiques publiables", () => {
    // Compter les propositions gonflerait l'officiel avec ce que personne n'a accepte.
    const portions = [
      p({ id: "valide", debutM: 0, finM: 5000, statutValidation: "VALIDE" }),
      p({ id: "propose", debutM: 5000, finM: 20000, statutValidation: "A_VALIDER" }),
    ];
    const r = repartition(portions, 20000, "revetement", { publiablesSeules: true });
    expect(r).toEqual([
      { cle: "NON_QUALIFIE", longueurM: 15000, part: 0.75 },
      { cle: "BITUME", longueurM: 5000, part: 0.25 },
    ]);
  });
});
