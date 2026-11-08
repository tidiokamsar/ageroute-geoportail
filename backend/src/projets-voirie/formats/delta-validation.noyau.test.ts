import { describe, expect, it } from "vitest";
import type { GeometrieLue, ObjetLu } from "../lecture.types";
import { calculerDeltaDetaille, cleDe, type ObjetDelta } from "./delta-detaille.noyau";
import { choisirEchantillon, classerRaison, construireEchantillon, decimerGeometrie } from "./validation.noyau";

const o = (ref: number, nom: string | null, empreinte: string, cle: string | null = nom): ObjetDelta => ({ ref, nom, empreinte, cle });

describe("delta detaille : ajoutes, modifies, retires, identiques", () => {
  it("premiere comparaison simple : identiques par empreinte, ajoutes et retires par difference", () => {
    const d = calculerDeltaDetaille([o(0, "A", "e1"), o(1, "B", "e2"), o(2, "C", "e3")], [o(10, "A", "e1"), o(11, "D", "e9")]);
    expect(d).toMatchObject({ identiques: 1, ajoutes: 2, modifies: 0, retires: 1, clesAmbigues: 0 });
    expect(d.echantillons.retires).toEqual([{ objetId: 11, nom: "D" }]);
    expect(d.echantillons.ajoutes.map((x) => x.nom)).toEqual(["B", "C"]);
  });

  it("modifie : meme cle (nom), empreinte differente ; les totaux se recoupent (ajoutes + modifies + identiques = nouveaux ; retires + modifies + identiques = anciens)", () => {
    const nouveaux = [o(0, "A", "e1"), o(1, "B", "e2bis"), o(2, "N", "e5")];
    const anciens = [o(10, "A", "e1"), o(11, "B", "e2"), o(12, "S", "e6")];
    const d = calculerDeltaDetaille(nouveaux, anciens);
    expect(d).toMatchObject({ identiques: 1, modifies: 1, ajoutes: 1, retires: 1 });
    expect(d.ajoutes + d.modifies + d.identiques).toBe(nouveaux.length);
    expect(d.retires + d.modifies + d.identiques).toBe(anciens.length);
    expect(d.echantillons.modifies).toEqual([{ cle: "B", nomAvant: "B", nomApres: "B" }]);
  });

  it("une cle presente plusieurs fois d'un cote est AMBIGUE : jamais rapprochee au hasard (ajoutes et retires)", () => {
    const d = calculerDeltaDetaille([o(0, "X", "n1"), o(1, "X", "n2")], [o(10, "X", "a1")]);
    expect(d).toMatchObject({ modifies: 0, ajoutes: 2, retires: 1, clesAmbigues: 1 });
    // Deux de chaque cote, des empreintes toutes differentes : ambigu aussi.
    expect(calculerDeltaDetaille([o(0, "X", "n1"), o(1, "X", "n2")], [o(10, "X", "a1"), o(11, "X", "a2")])).toMatchObject({ modifies: 0, ajoutes: 2, retires: 2, clesAmbigues: 1 });
  });

  it("sans cle (objets sans nom) : jamais de modification, uniquement ajoutes et retires", () => {
    const d = calculerDeltaDetaille([o(0, null, "n1", null)], [o(10, null, "a1", null)]);
    expect(d).toMatchObject({ modifies: 0, ajoutes: 1, retires: 1, identiques: 0 });
  });

  it("multi-ensemble : un meme objet present deux fois compte deux fois", () => {
    const d = calculerDeltaDetaille([o(0, "A", "e1"), o(1, "A", "e1"), o(2, "A", "e1")], [o(10, "A", "e1"), o(11, "A", "e1")]);
    expect(d).toMatchObject({ identiques: 2, ajoutes: 1, retires: 0 });
  });

  it("une version qui retire tout : N retires, rien d'ajoute ; la version vide est impossible mais le calcul tient", () => {
    const d = calculerDeltaDetaille([], [o(10, "A", "e1"), o(11, "B", "e2")]);
    expect(d).toMatchObject({ retires: 2, ajoutes: 0, identiques: 0 });
  });

  it("l'empreinte des retires ne depend pas de l'ordre et change avec le contenu (la revue est liee a CE contenu)", () => {
    const a = calculerDeltaDetaille([], [o(1, "A", "e1"), o(2, "B", "e2")]);
    const b = calculerDeltaDetaille([], [o(2, "B", "e2"), o(1, "A", "e1")]);
    const c = calculerDeltaDetaille([], [o(1, "A", "e1"), o(2, "B", "e3")]);
    expect(a.empreinteRetires).toBe(b.empreinteRetires);
    expect(a.empreinteRetires).not.toBe(c.empreinteRetires);
    expect(a.empreinteRetires).toMatch(/^[0-9a-f]{64}$/);
  });

  it("echantillons bornes a 20 par categorie", () => {
    const anciens = Array.from({ length: 100 }, (_, i) => o(i, `A${i}`, `a${i}`));
    expect(calculerDeltaDetaille([], anciens).echantillons.retires).toHaveLength(20);
  });

  it("cleDe : identifiant mappe si les deux versions en ont un, sinon le nom ; vide = pas de cle", () => {
    expect(cleDe("Nom", { id: " R1 " }, "id")).toBe("R1");
    expect(cleDe("Nom", { id: "" }, "id")).toBeNull();
    expect(cleDe("Nom", {}, "id")).toBeNull();
    expect(cleDe("  Nom ", null, null)).toBe("Nom");
    expect(cleDe(null, null, null)).toBeNull();
    expect(cleDe("  ", null, null)).toBeNull();
  });
});

describe("validation geometrique : classement des raisons de PostGIS, sans recopier de coordonnees", () => {
  it("auto-intersection, trop peu de points, anneau, vide, autre", () => {
    expect(classerRaison("Self-intersection[380000 1015000]", false).code).toBe("AUTO_INTERSECTION");
    expect(classerRaison("Ring Self-intersection[1 2]", false).code).toBe("AUTO_INTERSECTION");
    expect(classerRaison("Too few points in geometry component[1 2]", false).code).toBe("TROP_PEU_DE_POINTS");
    expect(classerRaison("Hole lies outside shell[1 2]", false).code).toBe("ANNEAU_INVALIDE");
    expect(classerRaison("Interior is disconnected[1 2]", false).code).toBe("ANNEAU_INVALIDE");
    expect(classerRaison(null, true).code).toBe("GEOMETRIE_VIDE");
    expect(classerRaison("autre chose", false).code).toBe("GEOMETRIE_INVALIDE");
    const m = classerRaison("Self-intersection[380000.123 1015000.456]", false).message;
    expect(m).not.toMatch(/380000|1015000|\[/);
  });
});

describe("echantillon d'apercu : borne, deterministe, cas limites d'abord", () => {
  it("un fichier plus petit que l'echantillon est rendu en entier", () => {
    expect(choisirEchantillon(5, 20, new Set())).toEqual([0, 1, 2, 3, 4]);
  });
  it("jamais tout le fichier : exactement la taille demandee, indices distincts tries, regulierement espaces", () => {
    const e = choisirEchantillon(1000, 20, new Set());
    expect(e).toHaveLength(20);
    expect(new Set(e).size).toBe(20);
    expect([...e].sort((a, b) => a - b)).toEqual(e);
    expect(e[0]).toBe(0);
    expect(e[19]).toBeGreaterThan(900);
    expect(choisirEchantillon(1000, 20, new Set())).toEqual(e);
  });
  it("les objets a probleme sont retenus en premier, dans la limite de la moitie de l'echantillon", () => {
    const pb = new Set(Array.from({ length: 30 }, (_, i) => 500 + i));
    const e = choisirEchantillon(1000, 20, pb);
    expect(e).toHaveLength(20);
    // Les dix premiers problemes sont tous la ; les dix autres places sont reparties dans le fichier (pas toutes groupees sur les problemes).
    for (let i = 500; i < 510; i++) expect(e).toContain(i);
    expect(e.filter((i) => i < 500 || i >= 530).length).toBeGreaterThanOrEqual(8);
  });
  it("tous les objets a probleme et peu de place : pas de doublon, pas de depassement", () => {
    for (const total of [21, 40, 100]) {
      const e = choisirEchantillon(total, 20, new Set(Array.from({ length: total }, (_, i) => i)));
      expect(e).toHaveLength(20);
      expect(new Set(e).size).toBe(20);
    }
  });

  it("decimation : une ligne de 10 000 sommets est reduite a 500 (extremites conservees), un anneau reste ferme, un point est intact", () => {
    const ligne: GeometrieLue = { type: "LineString", coordinates: Array.from({ length: 10_000 }, (_, i) => [-10 + i * 1e-5, 9.2] as [number, number]) };
    const r = decimerGeometrie(ligne, 500);
    expect(r.simplifiee).toBe(true);
    expect((r.geometrie.coordinates as unknown[]).length).toBe(500);
    expect((r.geometrie.coordinates as number[][])[0]).toEqual([-10, 9.2]);
    expect((r.geometrie.coordinates as number[][])[499]).toEqual((ligne.coordinates as number[][])[9_999]);
    const n = 2000;
    const anneau = Array.from({ length: n }, (_, i) => [-10 + Math.cos((2 * Math.PI * i) / (n - 1)) * 1e-3, 9.2 + Math.sin((2 * Math.PI * i) / (n - 1)) * 1e-3] as [number, number]);
    anneau[n - 1] = anneau[0];
    const p = decimerGeometrie({ type: "Polygon", coordinates: [anneau] }, 500);
    const rg = (p.geometrie.coordinates as number[][][])[0];
    expect(p.simplifiee).toBe(true);
    expect(rg[0]).toEqual(rg[rg.length - 1]);
    expect(rg.length).toBeLessThanOrEqual(500);
    expect(decimerGeometrie({ type: "Point", coordinates: [-10, 9] }, 500)).toEqual({ geometrie: { type: "Point", coordinates: [-10, 9] }, simplifiee: false });
    expect(decimerGeometrie({ type: "LineString", coordinates: [[0, 0], [1, 1]] }, 500).simplifiee).toBe(false);
  });

  it("l'echantillon rend au plus `taille` objets, attributs bornes (30 champs, valeurs tronquees)", () => {
    const objets: ObjetLu[] = Array.from({ length: 100 }, (_, i) => ({
      nom: `o${i}`, typeGeom: "POINT", geometrie: { type: "Point", coordinates: [-10, 9.2] }, empreinte: "x".repeat(40), ordre: i,
      attributs: i === 0 ? Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`c${k}`, "z".repeat(500)])) : {},
    }));
    const e = construireEchantillon(objets, 10, new Set(), 500);
    expect(e).toHaveLength(10);
    expect(Object.keys(e[0].attributs)).toHaveLength(30);
    expect(String(e[0].attributs.c0).length).toBe(203);
  });
});
