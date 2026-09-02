import { describe, expect, it } from "vitest";
import { normaliserNom, memeNom, dedoublonnerParNom, porteDesAccents } from "./dedoublonnage";

/**
 * Les dix postes supprimes le 01/07/2026 ne correspondaient qu'a six sites : les
 * doublons ne differaient que par les accents. Ces tests utilisent les noms reels
 * releves dans le journal d'audit.
 */

describe("Dédoublonnage par nom", () => {
  it("reconnaît deux orthographes du même site", () => {
    expect(memeNom("Peage de Kilissi", "Péage de Kilissi")).toBe(true);
    expect(memeNom("Peage de Maferinyah", "Péage de Maférinyah")).toBe(true);
  });

  it("ne confond pas deux sites différents", () => {
    expect(memeNom("Péage de Kilissi", "Péage de Kilomètre 36")).toBe(false);
    expect(memeNom("Pesage de Mamou", "Pesage de Linsan")).toBe(false);
  });

  it("ignore la casse et les espaces superflus", () => {
    expect(memeNom("  PÉAGE   de Kilissi ", "péage de kilissi")).toBe(true);
  });

  it("réduit les dix suppressions réelles à six sites", () => {
    const journal = [
      "Peage de Kilometre 36",
      "Poste de pesage de Kissidougou",
      "Peage de Maferinyah",
      "Poste de pesage de Linsan",
      "Peage de Kilissi",
      "Poste de pesage de Kissidougou",
      "Péage de Maférinyah",
      "Poste de pesage de Linsan",
      "Péage de Kilissi",
      "Pesage de Mamou",
    ];
    expect(dedoublonnerParNom(journal, (n) => n)).toHaveLength(6);
  });

  it("retient l'orthographe accentuée quand elle existe", () => {
    const retenus = dedoublonnerParNom(
      ["Peage de Kilissi", "Péage de Kilissi"],
      (n) => n,
      (candidat, retenu) => porteDesAccents(candidat) && !porteDesAccents(retenu)
    );
    expect(retenus).toEqual(["Péage de Kilissi"]);
  });

  it("garde le premier rencontré sans règle de préférence", () => {
    expect(dedoublonnerParNom(["Peage de Kilissi", "Péage de Kilissi"], (n) => n)).toEqual([
      "Peage de Kilissi",
    ]);
  });

  it("normalise vers une forme comparable", () => {
    expect(normaliserNom("Péage de Kilomètre 36")).toBe("peage de kilometre 36");
  });

  it("détecte la présence d'accents", () => {
    expect(porteDesAccents("Péage")).toBe(true);
    expect(porteDesAccents("Peage")).toBe(false);
  });

  it("ne casse pas sur une liste vide", () => {
    expect(dedoublonnerParNom([], (n: string) => n)).toEqual([]);
  });
});
