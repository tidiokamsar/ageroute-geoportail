import { describe, expect, it } from "vitest";
import {
  COMPOSANTE_PAR_FAMILLE,
  collecter,
  diagnostic,
  etatChausseeRetenu,
  normaliser,
  type SourcesTroncon,
  type TableNormalisation,
} from "./condition.collecte";
import { calculerRci, type RegleRci } from "./condition";

/**
 * La collecte du RCI : ce que ces tests defendent.
 *
 * LA DISTINCTION QUI PORTE TOUT LE MODULE
 *
 *   valeur lue + correspondance connue  ->  composante utilisable
 *   valeur lue + correspondance ABSENTE ->  ABSENTE, pas zero
 *   aucune valeur lue                   ->  ABSENTE, pas zero
 *
 * Traduire une valeur illisible en zero ferait chuter le score d'un troncon pour une raison
 * qui n'a rien a voir avec la route. C'est le mensonge le plus facile a commettre ici, et
 * celui qui serait le plus difficile a detecter ensuite : le score aurait l'air plausible.
 *
 * ET LA REGLE DECIDE DES NOMBRES, PAS LE CODE
 *
 * Si la regle ne dit pas ce que vaut un etat `BON`, la composante est absente. Un test
 * verifie qu'une table de correspondance vide ne produit AUCUN score, ce qui est l'etat
 * correct avant arbitrage.
 */

function sources(over: Partial<SourcesTroncon> = {}): SourcesTroncon {
  return {
    etatTroncon: null,
    etatEvalueLe: null,
    traficMoyenJma: null,
    traficDateComptage: null,
    portionsValidees: [],
    ouvrages: [],
    defautsParFamille: {},
    ...over,
  };
}

/** Correspondance d'exemple. Arbitraire exprès : la figer serait en faire une norme. */
const TABLE: TableNormalisation = {
  CHAUSSEE: { BON: 90, MOYEN: 65, MAUVAIS: 35, CRITIQUE: 10 },
  OUVRAGES: { BON: 90, MOYEN: 65, MAUVAIS: 35, CRITIQUE: 10 },
};

describe("Normaliser une valeur de source", () => {
  it("traduit une valeur que la regle connait", () => {
    expect(normaliser(TABLE, "CHAUSSEE", "BON")).toBe(90);
    expect(normaliser(TABLE, "CHAUSSEE", "CRITIQUE")).toBe(10);
  });

  it("rend NULL pour une valeur que la regle ne connait PAS", () => {
    // Le test central. « Je ne sais pas lire cette valeur » n'est pas « cette valeur est
    // mauvaise », et rendre zero ici noircirait un troncon sans raison.
    expect(normaliser(TABLE, "CHAUSSEE", "NON_EVALUE")).toBeNull();
    expect(normaliser(TABLE, "CHAUSSEE", "UN_ETAT_AJOUTE_PLUS_TARD")).toBeNull();
  });

  it("rend NULL pour une composante absente de la table", () => {
    expect(normaliser(TABLE, "DRAINAGE", "BON")).toBeNull();
  });

  it("rend NULL sur une valeur source absente", () => {
    expect(normaliser(TABLE, "CHAUSSEE", null)).toBeNull();
  });

  it("REFUSE une correspondance hors des bornes du score", () => {
    // Une regle corrigee a la main un soir ne doit pas pouvoir faire sortir un score de
    // l'intervalle que tout le reste suppose.
    const mauvaise: TableNormalisation = { CHAUSSEE: { BON: 150, MOYEN: -5, MAUVAIS: Number.NaN } };
    expect(normaliser(mauvaise, "CHAUSSEE", "BON")).toBeNull();
    expect(normaliser(mauvaise, "CHAUSSEE", "MOYEN")).toBeNull();
    expect(normaliser(mauvaise, "CHAUSSEE", "MAUVAIS")).toBeNull();
  });
});

describe("Quel etat de chaussee retenir", () => {
  it("une PORTION VALIDEE prime sur l'etat declare du troncon", () => {
    // `troncons.etat` est DECLARE et vaut NON_EVALUE sur 254 547 des 261 387 lignes ; une
    // portion validee est une observation datee, attribuee et validee par un tiers.
    const r = etatChausseeRetenu(sources({
      etatTroncon: "BON",
      portionsValidees: [{ debutM: 0, finM: 5_000, etat: "MAUVAIS", observeeLe: new Date("2026-10-01"), confiance: "HIGH" }],
    }));
    expect(r).toMatchObject({ valeur: "MAUVAIS", confiance: "HIGH", source: "portion_validee" });
  });

  it("retient la portion la plus LONGUE, pas la pire", () => {
    // Prendre la pire ferait d'un seul kilometre critique l'etat de vingt ; moyenner des
    // codes d'etat n'a pas de sens.
    const r = etatChausseeRetenu(sources({
      portionsValidees: [
        { debutM: 0, finM: 1_000, etat: "CRITIQUE", observeeLe: null, confiance: "HIGH" },
        { debutM: 1_000, finM: 20_000, etat: "BON", observeeLe: null, confiance: "HIGH" },
      ],
    }));
    expect(r.valeur).toBe("BON");
  });

  it("se replie sur l'etat declare en le marquant PEU FIABLE", () => {
    // Une valeur declaree n'est pas une valeur constatee, et le moteur degrade la confiance
    // du score en consequence.
    const r = etatChausseeRetenu(sources({ etatTroncon: "MOYEN", etatEvalueLe: new Date("2026-05-01") }));
    expect(r).toMatchObject({ valeur: "MOYEN", confiance: "LOW", source: "etat_declare_troncon" });
  });

  it("rend NULL quand il n'y a rien, et aucune confiance", () => {
    const r = etatChausseeRetenu(sources());
    expect(r.valeur).toBeNull();
    expect(r.confiance).toBeNull();
  });

  it("ignore une portion validee SANS etat", () => {
    const r = etatChausseeRetenu(sources({
      etatTroncon: "BON",
      portionsValidees: [{ debutM: 0, finM: 5_000, etat: null, observeeLe: null, confiance: "HIGH" }],
    }));
    expect(r.source).toBe("etat_declare_troncon");
  });
});

describe("Les ouvrages : le pire gouverne", () => {
  it("retient le PIRE etat d'ouvrage, pas la moyenne", () => {
    // Un seul pont critique rend le troncon critique pour qui le franchit. Moyenner
    // diluerait exactement le risque qu'on cherche a voir.
    const e = collecter(sources({
      ouvrages: [
        { etat: "BON", derniereInspectionLe: new Date("2026-01-01") },
        { etat: "CRITIQUE", derniereInspectionLe: new Date("2026-02-01") },
        { etat: "BON", derniereInspectionLe: null },
      ],
    }), ["OUVRAGES"], TABLE);
    expect(e[0]).toMatchObject({ valeur: 10, source: "pire_de_3_ouvrages" });
  });

  it("rend ABSENTE quand aucun etat d'ouvrage n'est lisible", () => {
    const e = collecter(sources({
      ouvrages: [{ etat: "NON_EVALUE", derniereInspectionLe: null }],
    }), ["OUVRAGES"], TABLE);
    expect(e[0]).toMatchObject({ valeur: null, source: null });
  });
});

describe("Ce que la collecte refuse de convertir", () => {
  it("le TRAFIC reste absent, meme quand la donnee existe", () => {
    // Le trafic est un nombre, pas un code : sa conversion demande des seuils que la regle
    // ne porte pas. Convertir par une formule que personne n'a validee serait inventer.
    const e = collecter(sources({
      traficMoyenJma: 4_500, traficDateComptage: new Date("2026-03-01"),
    }), ["TRAFIC"], TABLE);
    expect(e[0].valeur).toBeNull();
    // Mais la source DIT que la donnee existe : le diagnostic pourra distinguer
    // « il manque la regle » de « il manque la collecte ».
    expect(e[0].source).toBe("trafic_jma_non_normalisable");
  });

  it("un comptage de DEFAUTS n'est pas un score", () => {
    const e = collecter(sources({
      defautsParFamille: { ASSAINISSEMENT: { nombre: 12, dernierLe: new Date("2026-09-01") } },
    }), ["DRAINAGE"], TABLE);
    expect(e[0].valeur).toBeNull();
    expect(e[0].source).toBe("12_defauts_non_normalisables");
  });

  it("relie chaque famille de defaut a sa composante, par le SENS", () => {
    // Cette correspondance n'est pas une ponderation : la changer serait changer ce que le
    // mot « drainage » designe. Elle vit donc dans le code, pas dans la regle.
    expect(COMPOSANTE_PAR_FAMILLE.ASSAINISSEMENT).toBe("DRAINAGE");
    expect(COMPOSANTE_PAR_FAMILLE.SIGNALISATION).toBe("SIGNALISATION");
    expect(COMPOSANTE_PAR_FAMILLE.OUVRAGE).toBe("OUVRAGES");
  });
});

describe("Le diagnostic transforme un refus en liste de travail", () => {
  it("distingue « il manque la regle » de « il manque la collecte »", () => {
    // Le refus du moteur dit « couverture insuffisante » sans dire quoi faire. Celui-ci
    // nomme les deux actions, qui ne sont pas du tout les memes : arbitrer un seuil, ou
    // envoyer une equipe.
    const e = collecter(sources({
      etatTroncon: "BON",
      traficMoyenJma: 4_500,
    }), ["CHAUSSEE", "TRAFIC", "DRAINAGE"], TABLE);
    const d = diagnostic(e);
    expect(d).toMatch(/1 composante\(s\) exploitable\(s\) : CHAUSSEE/);
    expect(d).toMatch(/il manque la regle.*TRAFIC/);
    expect(d).toMatch(/il manque la collecte.*DRAINAGE/);
  });

  it("dit clairement qu'aucune composante n'est exploitable", () => {
    const d = diagnostic(collecter(sources(), ["CHAUSSEE", "TRAFIC"], TABLE));
    expect(d).toMatch(/aucune composante exploitable/);
  });
});

describe("Bout en bout : la collecte branchee sur le moteur", () => {
  const regle: RegleRci = {
    version: "essai",
    poids: { CHAUSSEE: 30, DRAINAGE: 15, OUVRAGES: 15, SIGNALISATION: 10, SECURITE: 10, TRAFIC: 10, HISTORIQUE: 5, INCIDENTS: 5 },
    fraicheurMaxJours: 365,
    confiancesAcceptees: ["HIGH", "MEDIUM", "LOW"],
    couvertureMinimale: 0.5,
    sensCroissant: true,
    approuvee: false,
  };
  const composantes = Object.keys(regle.poids) as (keyof typeof regle.poids)[];

  it("REFUSE le score dans l'etat reel de la base du 13/10/2026", () => {
    // Mesure : seule la chaussee a des donnees, sur 2,6 % des troncons. Un troncon
    // n'atteint donc que 30 points sur 100, et la couverture minimale de 0,5 fait refuser.
    // C'est le comportement CORRECT : le verrou n'est pas la ponderation, c'est la collecte.
    const e = collecter(
      sources({ etatTroncon: "MOYEN", etatEvalueLe: new Date("2026-10-01") }),
      composantes, TABLE,
    );
    const r = calculerRci(e, regle, new Date("2026-10-13"));
    expect(r.score).toBeNull();
    if (r.score !== null) return;
    expect(r.motif).toBe("COUVERTURE_INSUFFISANTE");
    expect(r.couverture).toBe(0.3);
  });

  it("rend un score des que la couverture suffit, et le marque NON PUBLIABLE", () => {
    const e = collecter(sources({
      portionsValidees: [{ debutM: 0, finM: 20_000, etat: "BON", observeeLe: new Date("2026-10-01"), confiance: "HIGH" }],
      ouvrages: [{ etat: "MOYEN", derniereInspectionLe: new Date("2026-09-01") }],
    }), ["CHAUSSEE", "OUVRAGES"], TABLE);
    // Regle reduite aux deux composantes collectables, pour isoler le comportement.
    const r = calculerRci(e, { ...regle, poids: { CHAUSSEE: 30, OUVRAGES: 15 } }, new Date("2026-10-13"));
    expect(r.score).not.toBeNull();
    if (r.score === null) return;
    // 90 x (30/45) + 65 x (15/45) = 60 + 21,67 = 81,7
    expect(r.score).toBeCloseTo(81.7, 1);
    expect(r.publiable).toBe(false);
    expect(r.explication).toMatch(/NON APPROUVÉE/);
  });

  it("une table de correspondance VIDE ne produit AUCUN score", () => {
    // L'etat correct avant arbitrage : le mecanisme attend la decision, il ne la devance pas.
    const e = collecter(
      sources({
        portionsValidees: [{ debutM: 0, finM: 20_000, etat: "BON", observeeLe: new Date("2026-10-01"), confiance: "HIGH" }],
      }),
      composantes, {},
    );
    const r = calculerRci(e, regle, new Date("2026-10-13"));
    expect(r.score).toBeNull();
  });
});
