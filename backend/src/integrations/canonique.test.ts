import { describe, expect, it } from "vitest";
import { canonique, ChargeNonCanonique, cleIdempotence, empreinteDeCharge, sha256Hex } from "./canonique";
import { DESTINATIONS, TYPES_EVENEMENT, TYPES_SOURCE } from "./types";

/**
 * Ce que ces tests defendent : l'idempotence repose sur une empreinte qui NE DEPEND PAS de l'ordre
 * des champs, et sur une cle que la base verifie octet pour octet (outbox_cle_deterministe).
 */
describe("JSON canonique", () => {
  it("trie les cles a tous les niveaux et n'ajoute aucun espace", () => {
    expect(canonique({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it("donne la meme empreinte quel que soit l'ordre de pose des champs", () => {
    const a = { nom: "RN1", longueurKm: 2.5, tags: ["x", "y"] };
    const b = { tags: ["x", "y"], longueurKm: 2.5, nom: "RN1" };
    expect(empreinteDeCharge(canonique(a))).toBe(empreinteDeCharge(canonique(b)));
  });

  it("change d'empreinte quand une valeur change, et quand l'ordre d'un TABLEAU change", () => {
    expect(empreinteDeCharge(canonique({ n: 1 }))).not.toBe(empreinteDeCharge(canonique({ n: 2 })));
    expect(canonique({ t: [1, 2] })).not.toBe(canonique({ t: [2, 1] }));
  });

  it("omet les proprietes undefined d'un objet, comme JSON", () => {
    expect(canonique({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it.each([
    ["un BigInt", { n: 10n }],
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["une Date", { d: new Date() }],
    ["une fonction", { f: () => 1 }],
    ["undefined dans un tableau", { t: [undefined] }],
  ])("refuse %s plutot que de le convertir en silence", (_nom, v) => {
    expect(() => canonique(v)).toThrow(ChargeNonCanonique);
  });

  it("echappe les chaines comme JSON (accents, guillemets, sauts de ligne)", () => {
    expect(canonique({ t: 'a"b\né' })).toBe(JSON.stringify({ t: 'a"b\né' }));
  });
});

describe("cle d'idempotence", () => {
  const base = { destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", sourceType: "Troncon", sourceId: "t-1", empreinteCharge: "e".repeat(64) };

  it("est deterministe : SHA-256 de destination|type|source|id|empreinte, comme la base le verifie", () => {
    expect(cleIdempotence(base)).toBe(sha256Hex(`BDR_L2R|PIVOT_OBJET_VALIDE|Troncon|t-1|${"e".repeat(64)}`));
    expect(cleIdempotence(base)).toBe(cleIdempotence({ ...base }));
    expect(cleIdempotence(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["destination", "typeEvenement", "sourceType", "sourceId", "empreinteCharge"] as const)(
    "change quand %s change", (champ) => {
      expect(cleIdempotence({ ...base, [champ]: "autre" })).not.toBe(cleIdempotence(base));
    });

  // Le separateur « | » est ambigu SI un des champs en contient un. Les trois premiers viennent
  // d'ensembles fermes (CHECK de la base) : on prouve ici qu'aucun ne contient le separateur, ce
  // qui ecarte toute collision entre (type, id) et (type', id') ; sourceId est un identifiant de
  // table (uuid), jamais saisi librement.
  it("n'est pas ambigue : aucune destination, aucun type, aucune source ne contient le separateur", () => {
    const fermes = [...DESTINATIONS, ...TYPES_EVENEMENT, ...TYPES_SOURCE];
    expect(fermes.filter((v) => v.includes("|"))).toEqual([]);
  });
});
