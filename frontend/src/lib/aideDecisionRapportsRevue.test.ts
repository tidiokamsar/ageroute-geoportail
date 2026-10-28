import { describe, expect, it } from "vitest";
import { prixAbrege, prixExact } from "./aideDecisionRapportsBaremes";
import { mentionLongueur, peutConsulterJournal, statutLongueur } from "./aideDecisionRapports";
import { analyserRapportRegions, retryHorsErreurClient } from "./aideDecisionRapportsApi";

/**
 * Revue independante du frontend (lot 6) : prix exact sans flottant, longueur metier inconnue, droit de lire le journal,
 * politique de relance. Les espaces de groupement sont insecables : on les normalise pour comparer.
 */
const n = (s: string | null) => (s === null ? null : s.replace(new RegExp(String.fromCharCode(160), "g"), " "));

describe("prixExact : le prix est exact, jamais arrondi, jamais passe par un flottant", () => {
  it("400000 reste 400 000 (et non « 0 M »)", () => {
    expect(n(prixExact("400000", "GNF"))).toBe("400 000 GNF/km");
  });
  it("999999999 reste 999 999 999 (et non « 1 000 M »)", () => {
    expect(n(prixExact("999999999", "GNF"))).toBe("999 999 999 GNF/km");
  });
  it("au-dela de 2^53 : aucun chiffre n'est perdu", () => {
    expect(n(prixExact("9007199254740993", "GNF"))).toBe("9 007 199 254 740 993 GNF/km");
    expect(n(prixExact("12345678901234567890", "GNF"))).toBe("12 345 678 901 234 567 890 GNF/km");
  });
  it("zeros de tete ecartes ; valeur illisible : dite, pas affichee comme un montant", () => {
    expect(n(prixExact("0003500", "GNF"))).toBe("3 500 GNF/km");
    expect(prixExact("3,5", "GNF")).toBe("Prix illisible");
    expect(prixExact("", "GNF")).toBe("Prix illisible");
    expect(prixExact("-5", "GNF")).toBe("Prix illisible");
  });
});

describe("prixAbrege : annonce approchee, calculee en BigInt", () => {
  it("rien sous un million (le prix exact suffit, aucun arrondi n'est annonce)", () => {
    expect(prixAbrege("400000", "GNF")).toBeNull();
    expect(prixAbrege("999999", "GNF")).toBeNull();
  });
  it("millions et milliards, arrondi au dixieme", () => {
    expect(n(prixAbrege("1000000", "GNF"))).toBe("≈ 1 M GNF/km");
    expect(n(prixAbrege("350000000", "GNF"))).toBe("≈ 350 M GNF/km");
    expect(n(prixAbrege("3500000000", "GNF"))).toBe("≈ 3,5 Md GNF/km");
    expect(n(prixAbrege("1234567890", "GNF"))).toBe("≈ 1,2 Md GNF/km");
  });
  it("un arrondi qui atteindrait 1 000 M passe en milliards (999999999 -> ≈ 1 Md, pas « 1 000 M »)", () => {
    expect(n(prixAbrege("999999999", "GNF"))).toBe("≈ 1 Md GNF/km");
  });
  it("au-dela de 2^53 : l'abrege ne perd pas de precision significative", () => {
    expect(n(prixAbrege("9007199254740993", "GNF"))).toBe("≈ 9 007 199,3 Md GNF/km");
  });
  it("valeur illisible : pas d'abrege", () => {
    expect(prixAbrege("abc", "GNF")).toBeNull();
  });
});

describe("statutLongueur / mentionLongueur : une longueur inconnue n'est pas 0 km", () => {
  it("aucun troncon avec longueur metier : « Longueur non renseignée »", () => {
    const l = { troncons: 4, tronconsSansLongueurMetier: 4, kmPerimetre: 0 };
    expect(statutLongueur(l)).toBe("NON_RENSEIGNEE");
    expect(mentionLongueur(l)).toBe("Longueur non renseignée");
  });
  it("partiel : le nombre de troncons manquants est dit", () => {
    expect(mentionLongueur({ troncons: 4, tronconsSansLongueurMetier: 1, kmPerimetre: 20 })).toBe("1 tronçon sans longueur métier : km partiels");
    expect(mentionLongueur({ troncons: 4, tronconsSansLongueurMetier: 3, kmPerimetre: 20 })).toBe("3 tronçons sans longueur métier : km partiels");
  });
  it("tout est renseigne : aucune mention ; region sans troncon : aucune mention", () => {
    expect(mentionLongueur({ troncons: 4, tronconsSansLongueurMetier: 0, kmPerimetre: 20 })).toBeNull();
    expect(mentionLongueur({ troncons: 0, tronconsSansLongueurMetier: 0, kmPerimetre: 0 })).toBeNull();
  });
  it("le compte de troncons sans longueur est lu dans la reponse du serveur", () => {
    const l = { region: "Kindia", troncons: 4, tronconsSansLongueurMetier: 4, kmPerimetre: 0, kmBon: 0, kmMoyen: 0, kmMauvais: 0, kmCritique: 0, kmEtatNonValide: 0, kmNonEvalue: 0, kmEligible: 0, degradePct: null, critiquePct: null, disponibilite: "NON_DISPONIBLE" };
    const r = analyserRapportRegions({ rapport: { perimetre: { libelle: "x" }, regions: [l], total: l, avertissements: [] } });
    expect(r?.regions[0].tronconsSansLongueurMetier).toBe(4);
    expect(r?.regions[0].kmPerimetre).toBe(0);
    expect(r?.regions[0].disponibilite).toBe("NON_DISPONIBLE");
  });
});

describe("peutConsulterJournal : memes conditions que l'export", () => {
  it("LECTEUR, sans compte, GESTIONNAIRE sans module rapports ou avec une liste vide : non", () => {
    expect(peutConsulterJournal(null)).toBe(false);
    expect(peutConsulterJournal({ role: "LECTEUR", modulesAutorises: ["rapports"] })).toBe(false);
    expect(peutConsulterJournal({ role: "GESTIONNAIRE", modulesAutorises: [] })).toBe(false);
    expect(peutConsulterJournal({ role: "GESTIONNAIRE", modulesAutorises: ["decision"] })).toBe(false);
  });
  it("ADMIN toujours ; GESTIONNAIRE avec le module rapports : oui", () => {
    expect(peutConsulterJournal({ role: "ADMIN", modulesAutorises: [] })).toBe(true);
    expect(peutConsulterJournal({ role: "GESTIONNAIRE", modulesAutorises: ["rapports"] })).toBe(true);
  });
});

describe("retryHorsErreurClient : aucune relance sur une erreur de requete", () => {
  const erreur = (status?: number) => (status === undefined ? new Error("reseau") : { response: { status } });
  it.each([400, 401, 403, 404, 409, 413, 422])("%i : jamais relance", (s) => {
    expect(retryHorsErreurClient(0, erreur(s))).toBe(false);
  });
  it("panne passagere (5xx ou pas de reponse) : une seule relance", () => {
    for (const e of [erreur(500), erreur(503), erreur()]) {
      expect(retryHorsErreurClient(0, e)).toBe(true);
      expect(retryHorsErreurClient(1, e)).toBe(false);
    }
  });
});
