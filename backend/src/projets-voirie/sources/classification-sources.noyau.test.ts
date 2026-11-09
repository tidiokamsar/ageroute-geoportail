import { describe, expect, it } from "vitest";
import {
  assemblerResultats, classerCouple, cleResultat, empreinteMesureComparaison, etatConnexion, identiteObjet, instantaneDe, totauxDe,
  type AppariementBrut, type ObjetCompare,
} from "./classification-sources.noyau";

const obj = (id: string, nom: string | null, s: Partial<ObjetCompare> = {}): ObjetCompare => ({ id, nom, empreinte: `emp-${id}`, longueurM: 60, precisionM: 1, originePrecision: "JEU", ...s });

describe("classement d'un couple apparie", () => {
  it("concordance stricte : toute la longueur de A dans le corridor de B (a 1 cm pres, tolerance numerique)", () => {
    const c = classerCouple({ corridorM: 2, hausdorffM: 0.5, longueurAM: 60, longueurBM: 60, longueurRecouvrementM: 59.995, distanceMinM: 0.5 }, 0);
    expect(c.statut).toBe("CONCORDANCE");
    expect(c.mesure).toMatchObject({ longueurHorsCorridorM: 0, partHorsCorridor: 0, hausdorffM: 0.5, longueurAM: 60, longueurRecouvrementM: 60 });
  });
  it("divergence : decalage de 3 m sur un corridor de 2 m, toute la longueur hors corridor, Hausdorff 3 m", () => {
    const c = classerCouple({ corridorM: 2, hausdorffM: 3, longueurAM: 60, longueurBM: 60, longueurRecouvrementM: 0, distanceMinM: 3 }, 0);
    expect(c.statut).toBe("DIVERGENCE");
    expect(c.mesure).toEqual({ hausdorffM: 3, longueurAM: 60, longueurBM: 60, longueurRecouvrementM: 0, longueurHorsCorridorM: 60, partHorsCorridor: 1, distanceMinM: 3 });
  });
  it("la part toleree de la regle decide : 10 % hors corridor concorde a 0,1, diverge a 0", () => {
    const brut = { corridorM: 2, hausdorffM: 1.5, longueurAM: 100, longueurBM: 100, longueurRecouvrementM: 90, distanceMinM: 0 };
    expect(classerCouple(brut, 0.1).statut).toBe("CONCORDANCE");
    expect(classerCouple(brut, 0.05).statut).toBe("DIVERGENCE");
    expect(classerCouple(brut, 0).mesure?.partHorsCorridor).toBe(0.1);
  });
  it("corridor inconnu : rapprochement incertain, AUCUNE mesure (meme si des longueurs sont fournies)", () => {
    const c = classerCouple({ corridorM: null, hausdorffM: 3, longueurAM: 60, longueurBM: 60, longueurRecouvrementM: 60, distanceMinM: 3 }, 0);
    expect(c).toEqual({ statut: "RAPPROCHEMENT_INCERTAIN", mesure: null });
  });
  it("un recouvrement superieur a la longueur (bruit du tampon) est borne ; une longueur nulle ne divise pas", () => {
    expect(classerCouple({ corridorM: 2, hausdorffM: 0, longueurAM: 10, longueurBM: 10, longueurRecouvrementM: 10.4, distanceMinM: 0 }, 0).mesure?.longueurRecouvrementM).toBe(10);
    expect(classerCouple({ corridorM: 2, hausdorffM: 0, longueurAM: 0, longueurBM: 10, longueurRecouvrementM: 0, distanceMinM: 0 }, 0).statut).toBe("CONCORDANCE");
  });
});

describe("identite, cle stable et empreinte", () => {
  it("l'identite est le nom normalise, sinon l'empreinte ; jamais l'identifiant", () => {
    expect(identiteObjet("  Fibre  L2 ", "x")).toBe("n:fibre l2");
    expect(identiteObjet("FIBRE L2", "x")).toBe("n:fibre l2");
    expect(identiteObjet(null, "abc")).toBe("e:abc");
    expect(identiteObjet("   ", "abc")).toBe("e:abc");
  });
  it("la cle ne depend que du projet et des deux identites ; A et B ne sont pas interchangeables", () => {
    const k = cleResultat("p", "n:a", "n:b");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(cleResultat("p", "n:a", "n:b")).toBe(k);
    expect(cleResultat("p", "n:b", "n:a")).not.toBe(k);
    expect(cleResultat("q", "n:a", "n:b")).not.toBe(k);
    expect(cleResultat("p", "n:a", null)).not.toBe(cleResultat("p", null, "n:a"));
  });
  it("l'empreinte d'une mesure est stable, celle d'une absence de mesure est un tiret", () => {
    const m = { hausdorffM: 3, longueurAM: 60, longueurBM: 60, longueurRecouvrementM: 0, longueurHorsCorridorM: 60, partHorsCorridor: 1, distanceMinM: 3 };
    expect(empreinteMesureComparaison(m)).toBe(empreinteMesureComparaison({ ...m }));
    expect(empreinteMesureComparaison({ ...m, hausdorffM: 3.01 })).not.toBe(empreinteMesureComparaison(m));
    expect(empreinteMesureComparaison(null)).toBe("-");
  });
});

describe("assemblage des resultats et rejeu idempotent", () => {
  const A1 = obj("11", "L2"), A2 = obj("12", "L6"), A3 = obj("13", "Loin"), A4 = obj("14", "Sans precision", { precisionM: null, originePrecision: "INCONNUE" });
  const B1 = obj("21", "L2 bis"), B2 = obj("22", "L6 bis"), B3 = obj("23", "Orphelin"), B4 = obj("24", "Flou");
  const appariements: AppariementBrut[] = [
    { objetA: A1, objetB: B1, corridorM: 2, hausdorffM: 0.5, longueurRecouvrementM: 60, distanceMinM: 0.5 },
    { objetA: A2, objetB: B2, corridorM: 2, hausdorffM: 3, longueurRecouvrementM: 0, distanceMinM: 3 },
    { objetA: A3, objetB: null, corridorM: null, hausdorffM: null, longueurRecouvrementM: null, distanceMinM: null },
    { objetA: A4, objetB: B4, corridorM: null, hausdorffM: 1, longueurRecouvrementM: 50, distanceMinM: 1 },
  ];
  it("un resultat par objet de A, un par objet de B jamais retenu ; statuts attendus ; ordre des cles", () => {
    const r = assemblerResultats("p", appariements, [B1, B2, B3, B4], 0);
    expect(r).toHaveLength(5);
    const parNom = Object.fromEntries(r.map((x) => [x.nomA ?? x.nomB, x]));
    expect(parNom["L2"].statut).toBe("CONCORDANCE");
    expect(parNom["L6"].statut).toBe("DIVERGENCE");
    expect(parNom["Loin"].statut).toBe("SANS_CORRESPONDANCE_A");
    expect(parNom["Sans precision"]).toMatchObject({ statut: "RAPPROCHEMENT_INCERTAIN", corridorM: null, mesure: null, origineA: "INCONNUE" });
    expect(parNom["Orphelin"]).toMatchObject({ statut: "SANS_CORRESPONDANCE_B", objetAId: null, objetBId: "23" });
    expect(r.map((x) => x.ordre)).toEqual([1, 2, 3, 4, 5]);
    expect(r.map((x) => x.cle)).toEqual([...r.map((x) => x.cle)].sort());
    const t = totauxDe(r);
    expect(t.parStatut).toEqual({ CONCORDANCE: 1, DIVERGENCE: 1, RAPPROCHEMENT_INCERTAIN: 1, SANS_CORRESPONDANCE_A: 1, SANS_CORRESPONDANCE_B: 1 });
    expect(t).toMatchObject({ couplesSansCorridor: 1, corridorMinM: 2, corridorMaxM: 2 });
  });
  it("REJEU IDEMPOTENT : les memes entrees dans un autre ordre donnent le meme instantane, les memes cles et les memes mesures", () => {
    const r1 = assemblerResultats("p", appariements, [B1, B2, B3, B4], 0);
    const r2 = assemblerResultats("p", [...appariements].reverse(), [B4, B3, B2, B1], 0);
    expect(instantaneDe(r2)).toEqual(instantaneDe(r1));
    expect(r2.map((x) => [x.cle, x.ordre, x.statut, x.mesure])).toEqual(r1.map((x) => [x.cle, x.ordre, x.statut, x.mesure]));
  });
  it("une mesure qui change change l'instantane, pas la cle", () => {
    const r1 = assemblerResultats("p", appariements, [], 0);
    const modifie = appariements.map((a) => (a.objetA.id === "12" ? { ...a, hausdorffM: 4 } : a));
    const r2 = assemblerResultats("p", modifie, [], 0);
    expect(r2.map((x) => x.cle)).toEqual(r1.map((x) => x.cle));
    expect(instantaneDe(r2)).not.toEqual(instantaneDe(r1));
  });
  it("deux copies d'un meme objet (meme nom) ne font qu'un resultat : le plus petit identifiant", () => {
    const copie = obj("99", "L2");
    const r = assemblerResultats("p", [...appariements, { objetA: copie, objetB: B1, corridorM: 2, hausdorffM: 0, longueurRecouvrementM: 60, distanceMinM: 0 }], [B1], 0);
    expect(r.filter((x) => x.nomA === "L2").map((x) => x.objetAId)).toEqual(["11"]);
  });
});

describe("etat de connexion : fourni, jamais deduit", () => {
  it("CONFIRMEE des qu'une connexion validee est confirmee par le fournisseur ; INCONNUE sinon ; NON_FOURNIE sans connexion validee", () => {
    expect(etatConnexion([]).etat).toBe("NON_FOURNIE");
    expect(etatConnexion([{ statut: "PROPOSEE", preuve: "CONFIRMEE_PAR_FOURNISSEUR" }, { statut: "REVOQUEE", preuve: "CONFIRMEE_PAR_FOURNISSEUR" }]).etat).toBe("NON_FOURNIE");
    expect(etatConnexion([{ statut: "VALIDEE", preuve: "INCONNUE" }])).toMatchObject({ etat: "INCONNUE", nbConfirmees: 0, nbInconnues: 1 });
    expect(etatConnexion([{ statut: "VALIDEE", preuve: "INCONNUE" }, { statut: "VALIDEE", preuve: "CONFIRMEE_PAR_FOURNISSEUR" }])).toMatchObject({ etat: "CONFIRMEE", nbConfirmees: 1, nbInconnues: 1 });
    expect(etatConnexion([]).libelle).toMatch(/aucune connexion n'est déduite/);
  });
  it("aucun etat « continue » n'existe", () => {
    for (const c of [[], [{ statut: "VALIDEE", preuve: "INCONNUE" }], [{ statut: "VALIDEE", preuve: "CONFIRMEE_PAR_FOURNISSEUR" }]]) {
      expect(["CONFIRMEE", "INCONNUE", "NON_FOURNIE"]).toContain(etatConnexion(c).etat);
    }
  });
});
