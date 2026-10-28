import { beforeEach, describe, expect, it } from "vitest";
import {
  creerPortion,
  decouperPortion,
  fusionnerPortions,
  requalifierPortion,
  type DepotPortions,
  type Ecriture,
} from "./portions.service";
import type { Portion } from "./portions";

/**
 * L'ecriture des portions : ce que ces tests defendent.
 *
 * TROIS CHOSES, ET AUCUNE N'EST UNE PRECAUTION DE PRINCIPE
 *
 * RIEN N'EST MODIFIE EN PLACE. Decouper, fusionner et requalifier marquent l'ancienne
 * version `remplaceeLe` et inserent la ou les nouvelles, avec le lignage. Une portion
 * modifiee en place perdrait ce qu'elle disait avant, et les validations rendues sous elle
 * deviendraient inexplicables.
 *
 * TOUT SORT EN PROPOSITION. Meme une requalification d'une portion VALIDEE : heriter du
 * statut ferait entrer un changement d'etat dans le referentiel officiel sans decision.
 *
 * L'IDEMPOTENCE EST UNE REPONSE, PAS UNE ERREUR. Une reponse perdue en zone blanche fait
 * renvoyer l'operation ; rendre la portion deja enregistree est le comportement correct.
 */

function portion(partiel: Partial<Portion> & Pick<Portion, "id" | "debutM" | "finM">): Portion {
  return {
    tronconId: "t-1",
    revetement: "BETON_BITUMINEUX",
    etat: "BON",
    praticabilite: null,
    largeurM: null,
    source: "mission-2026-10",
    observeeLe: new Date("2026-10-01T00:00:00Z"),
    confiance: "HIGH",
    statutValidation: "A_VALIDER",
    origine: "SAISIE_TERRAIN",
    clientOperationId: null,
    remplaceeLe: null,
    deletedAt: null,
    ...partiel,
  };
}

/** Dernier appel recu par `appliquer`, pour verifier ce que le service demande vraiment. */
let dernier: Ecriture | null = null;

function depot(over: Partial<DepotPortions> = {}): DepotPortions {
  return {
    longueurTronconM: async () => 20_000,
    portionsDuTroncon: async () => [],
    portionParId: async () => null,
    portionParCleClient: async () => null,
    appliquer: async (e) => {
      dernier = e;
      return e.inserer.map((p, i) => ({ ...p, id: `neuf-${i}` }));
    },
    decider: async () => portion({ id: "x", debutM: 0, finM: 1 }),
    ...over,
  };
}

beforeEach(() => { dernier = null; });

describe("Creer une portion", () => {
  it("la cree en PROPOSITION, et jamais validee", async () => {
    const r = await creerPortion(
      { tronconId: "t-1", debutM: 0, finM: 8_000, revetement: "LATERITE" },
      "u-1",
      depot(),
    );
    expect(r.refus).toBeNull();
    if (r.refus !== null) return;
    expect(r.valeur.statutValidation).toBe("A_VALIDER");
    expect(r.valeur.origine).toBe("SAISIE_TERRAIN");
    expect(dernier?.remplacer).toEqual([]);
  });

  it("transmet les ABSCISSES et le troncon, pas une conversion refaite a la main", async () => {
    // La conversion abscisse -> fraction appartient au helper geometrique, qui divise par
    // la longueur geodesique du troncon. La refaire ici creerait une seconde source de
    // verite pour le meme calcul, donc une occasion de divergence.
    await creerPortion({ tronconId: "t-1", debutM: 5_000, finM: 15_000 }, "u-1", depot());
    expect(dernier?.tronconId).toBe("t-1");
    expect(dernier?.inserer[0]).toMatchObject({ debutM: 5_000, finM: 15_000 });
  });

  it("REND LA PORTION DEJA ENREGISTREE quand la cle d'idempotence est connue", async () => {
    // Une reponse perdue en zone blanche fait renvoyer l'operation. Repondre 409 obligerait
    // le client mobile a distinguer « deja fait » de « conflit », ce qu'il ne peut pas.
    const deja = portion({ id: "p-deja", debutM: 0, finM: 8_000, clientOperationId: "op-1" });
    const r = await creerPortion(
      { tronconId: "t-1", debutM: 0, finM: 8_000, clientOperationId: "op-1" },
      "u-1",
      depot({ portionParCleClient: async () => deja }),
    );
    expect(r.refus).toBeNull();
    if (r.refus !== null) return;
    expect(r.valeur.id).toBe("p-deja");
    // Et SURTOUT : rien n'a ete ecrit une seconde fois.
    expect(dernier).toBeNull();
  });

  it("REFUSE une portion hors du troncon ou trop courte", async () => {
    expect((await creerPortion({ tronconId: "t-1", debutM: 19_000, finM: 25_000 }, "u-1", depot())).refus)
      .toBe("HORS_TRONCON");
    expect((await creerPortion({ tronconId: "t-1", debutM: 0, finM: 5 }, "u-1", depot())).refus)
      .toBe("TROP_COURTE");
  });

  it("REFUSE quand la longueur du troncon n'est pas mesurable", async () => {
    const r = await creerPortion(
      { tronconId: "t-1", debutM: 0, finM: 8_000 },
      "u-1",
      depot({ longueurTronconM: async () => null }),
    );
    expect(r.refus).toBe("LONGUEUR_TRONCON_INCONNUE");
  });

  it("REFUSE de se poser PAR-DESSUS une portion deja VALIDEE", async () => {
    // Le cas qui compte. L'agent doit REQUALIFIER l'existante, pas en proposer une seconde
    // par-dessus : sinon un valideur recoit deux verites concurrentes sans savoir laquelle
    // est la correction de l'autre.
    const r = await creerPortion(
      { tronconId: "t-1", debutM: 4_000, finM: 12_000 },
      "u-1",
      depot({
        portionsDuTroncon: async () => [
          portion({ id: "officielle", debutM: 0, finM: 8_000, statutValidation: "VALIDE" }),
        ],
      }),
    );
    expect(r.refus).toBe("CHEVAUCHE_UNE_VALIDEE");
  });

  it("ACCEPTE de contredire une PROPOSITION existante", async () => {
    // Deux releves peuvent dire autre chose l'un de l'autre : c'est ainsi qu'arrive une
    // contradiction de terrain, et le cahier interdit tout ecrasement silencieux.
    const r = await creerPortion(
      { tronconId: "t-1", debutM: 4_000, finM: 12_000 },
      "u-1",
      depot({
        portionsDuTroncon: async () => [
          portion({ id: "proposee", debutM: 0, finM: 8_000, statutValidation: "A_VALIDER" }),
        ],
      }),
    );
    expect(r.refus).toBeNull();
  });
});

describe("Decouper", () => {
  it("marque l'originale REMPLACEE, insere DEUX morceaux, inscrit le lignage", async () => {
    const p = portion({ id: "p-1", debutM: 0, finM: 20_000 });
    const r = await decouperPortion("p-1", 8_000, "u-1", depot({ portionParId: async () => p }));
    expect(r.refus).toBeNull();
    expect(dernier?.remplacer).toEqual(["p-1"]);
    expect(dernier?.inserer).toHaveLength(2);
    expect(dernier?.lignage).toEqual([
      { parentId: "p-1", enfantIndex: 0 },
      { parentId: "p-1", enfantIndex: 1 },
    ]);
    expect(dernier?.operation).toBe("DECOUPE");
  });

  it("les morceaux portent l'origine DECOUPE et heritent des attributs", async () => {
    // Decouper n'est pas qualifier : donner d'office un etat different au second morceau
    // inventerait une observation.
    const p = portion({ id: "p-1", debutM: 0, finM: 20_000, etat: "MAUVAIS" });
    await decouperPortion("p-1", 8_000, "u-1", depot({ portionParId: async () => p }));
    expect(dernier?.inserer.map((x) => [x.origine, x.etat])).toEqual([
      ["DECOUPE", "MAUVAIS"],
      ["DECOUPE", "MAUVAIS"],
    ]);
  });

  it("REFUSE une portion introuvable, une coupe hors bornes, un morceau trop court", async () => {
    expect((await decouperPortion("absente", 100, "u-1", depot())).refus).toBe("PORTION_INTROUVABLE");
    const p = portion({ id: "p-1", debutM: 100, finM: 2_000 });
    const d = depot({ portionParId: async () => p });
    expect((await decouperPortion("p-1", 50, "u-1", d)).refus).toBe("HORS_PORTION");
    expect((await decouperPortion("p-1", 105, "u-1", d)).refus).toBe("MORCEAU_TROP_COURT");
  });
});

describe("Fusionner", () => {
  it("marque les DEUX remplacees, insere UNE portion, inscrit deux parents", async () => {
    // Le lignage plusieurs-a-plusieurs existe pour ce cas precis : une colonne
    // `remplaceeParId` n'aurait pas su dire que la nouvelle vient de deux.
    const a = portion({ id: "a", debutM: 0, finM: 8_000 });
    const b = portion({ id: "b", debutM: 8_000, finM: 13_000 });
    const r = await fusionnerPortions("a", "b", "u-1", depot({
      portionParId: async (id) => (id === "a" ? a : b),
    }));
    expect(r.refus).toBeNull();
    expect(dernier?.remplacer).toEqual(["a", "b"]);
    expect(dernier?.inserer).toHaveLength(1);
    expect(dernier?.inserer[0]).toMatchObject({ debutM: 0, finM: 13_000, origine: "FUSION" });
    expect(dernier?.lignage).toEqual([
      { parentId: "a", enfantIndex: 0 },
      { parentId: "b", enfantIndex: 0 },
    ]);
  });

  it("REFUSE des attributs differents, et n'ecrit rien", async () => {
    const a = portion({ id: "a", debutM: 0, finM: 8_000, etat: "BON" });
    const b = portion({ id: "b", debutM: 8_000, finM: 13_000, etat: "MAUVAIS" });
    const r = await fusionnerPortions("a", "b", "u-1", depot({
      portionParId: async (id) => (id === "a" ? a : b),
    }));
    expect(r.refus).toBe("ATTRIBUTS_DIFFERENTS");
    expect(dernier).toBeNull();
  });

  it("REFUSE de fusionner une validee avec une proposition", async () => {
    const a = portion({ id: "a", debutM: 0, finM: 8_000, statutValidation: "VALIDE" });
    const b = portion({ id: "b", debutM: 8_000, finM: 13_000, statutValidation: "A_VALIDER" });
    const r = await fusionnerPortions("a", "b", "u-1", depot({
      portionParId: async (id) => (id === "a" ? a : b),
    }));
    expect(r.refus).toBe("VALIDATIONS_DIFFERENTES");
  });
});

describe("Requalifier", () => {
  it("garde les bornes, change les attributs, et REPART EN PROPOSITION", async () => {
    // Meme quand l'ancienne etait validee : heriter du statut ferait entrer un changement
    // d'etat dans le referentiel officiel sans decision.
    const p = portion({ id: "p-1", debutM: 8_000, finM: 13_000, etat: "BON", statutValidation: "VALIDE" });
    const r = await requalifierPortion(
      "p-1",
      { etat: "CRITIQUE", source: "mission-2026-11", observeeLe: new Date("2026-11-02") },
      "u-1",
      depot({ portionParId: async () => p, portionsDuTroncon: async () => [p] }),
    );
    expect(r.refus).toBeNull();
    if (r.refus !== null) return;
    expect(r.valeur).toMatchObject({
      debutM: 8_000, finM: 13_000, etat: "CRITIQUE",
      statutValidation: "A_VALIDER", origine: "REQUALIFICATION",
    });
    expect(dernier?.remplacer).toEqual(["p-1"]);
    expect(dernier?.lignage).toEqual([{ parentId: "p-1", enfantIndex: 0 }]);
  });

  it("conserve les attributs non fournis", async () => {
    const p = portion({ id: "p-1", debutM: 0, finM: 5_000, revetement: "LATERITE", etat: "MOYEN" });
    const r = await requalifierPortion("p-1", { etat: "MAUVAIS" }, "u-1",
      depot({ portionParId: async () => p, portionsDuTroncon: async () => [p] }));
    if (r.refus !== null) throw new Error("refus inattendu");
    expect(r.valeur.revetement).toBe("LATERITE");
  });

  it("REFUSE de requalifier de l'historique", async () => {
    const p = portion({ id: "p-1", debutM: 0, finM: 5_000, remplaceeLe: new Date("2026-09-01") });
    const r = await requalifierPortion("p-1", { etat: "BON" }, "u-1", depot({ portionParId: async () => p }));
    expect(r.refus).toBe("PORTION_REMPLACEE");
  });

  it("ne se considere PAS comme chevauchant elle-meme", async () => {
    // Requalifier sa propre emprise est precisement le geste voulu : s'exclure du controle
    // de chevauchement est donc necessaire, sinon aucune portion validee ne serait jamais
    // corrigeable.
    const p = portion({ id: "p-1", debutM: 0, finM: 5_000, statutValidation: "VALIDE" });
    const r = await requalifierPortion("p-1", { etat: "CRITIQUE" }, "u-1",
      depot({ portionParId: async () => p, portionsDuTroncon: async () => [p] }));
    expect(r.refus).toBeNull();
  });
});
