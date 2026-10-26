import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CompteursLot, formaterDate, formatTaille, nombre, rendreVisible, resumeControle } from "./CompteursLot";
import { lotListe } from "./lotsDeTest";

/**
 * Le formatage ne produit jamais un chiffre que le serveur n'a pas donné : une taille illisible est
 * `null`, un compteur absent est « non calculable », et une valeur hostile devient visible.
 */

describe("formatTaille : la taille arrive en chaîne (BigInt sérialisé)", () => {
  it("lit une taille courante", () => {
    expect(formatTaille("0")).toMatchObject({ lisible: "0 octets" });
    expect(formatTaille("1")).toMatchObject({ lisible: "1 octet" });
    expect(formatTaille("1023")?.lisible).toBe("1023 octets");
    expect(formatTaille("1024")?.lisible).toBe("1,0 Ko");
    expect(formatTaille("1572864")?.lisible).toBe("1,5 Mo");
    expect(formatTaille("52428800")?.lisible).toBe("50,0 Mo");
  });

  it("ne perd aucun octet au-delà de 2^53 : l'exact est écrit chiffre pour chiffre", () => {
    // Number("9007199254740993") vaut 9007199254740992 : l'exactitude ne tient qu'en BigInt.
    const t = formatTaille("9007199254740993");
    expect(t).not.toBeNull();
    expect(t!.exact.replace(/\s/g, "")).toBe("9007199254740993octets");
    expect(t!.lisible).toMatch(/To$/);
  });

  it("une chaîne qui n'est pas un entier décimal est refusée, pas devinée", () => {
    expect(formatTaille("abc")).toBeNull();
    expect(formatTaille("")).toBeNull();
    expect(formatTaille("-5")).toBeNull();
    expect(formatTaille("12.5")).toBeNull();
    expect(formatTaille(undefined)).toBeNull();
  });
});

describe("formaterDate", () => {
  it("rend une date lisible et ne casse pas sur une valeur illisible", () => {
    expect(formaterDate("2026-10-14T20:00:00.000Z")).toMatch(/2026|26/);
    expect(formaterDate("pas une date")).toBe("pas une date");
    expect(formaterDate(null)).toBe("");
  });
});

describe("resumeControle : « 8 conformes, 2 rejetées »", () => {
  it("dit les conformes puis seulement les écarts non nuls", () => {
    expect(resumeControle(lotListe())).toBe("8 conformes, 2 rejetées");
    expect(resumeControle(lotListe({ lignesLues: 4, lignesValidees: 2, lignesRejetees: 1, lignesIgnorees: 1 }))).toBe("2 conformes, 1 rejetée, 1 ignorée");
    expect(resumeControle(lotListe({ lignesLues: 5, lignesValidees: 5, lignesRejetees: 0 }))).toBe("5 conformes");
    expect(resumeControle(lotListe({ lignesLues: 3, lignesValidees: 1, lignesRejetees: 0, lignesEnConflit: 2 }))).toBe("1 conforme, 2 en conflit");
  });

  it("n'invente rien : aucune ligne lue, ou un compteur absent", () => {
    expect(resumeControle(lotListe({ lignesLues: 0, lignesValidees: 0, lignesRejetees: 0 }))).toBe("Aucune ligne lue");
    expect(resumeControle({ ...lotListe(), lignesValidees: undefined as unknown as number })).toBe("Compteurs non calculables");
  });

  it("ne présente JAMAIS les lignes importées comme une réussite", () => {
    const texte = resumeControle(lotListe({ lignesImportees: 8 }));
    expect(texte).not.toMatch(/import/i);
    expect(texte).toBe("8 conformes, 2 rejetées");
  });
});

describe("nombre", () => {
  it("un nombre non fini est dit non calculable, jamais 0", () => {
    expect(nombre(Number.NaN)).toBe("non calculable");
    expect(nombre(null)).toBe("non calculable");
    expect(nombre(0)).toBe("0");
  });
});

describe("rendreVisible : les caractères de contrôle ne passent pas inaperçus", () => {
  it("rend visibles les codes C0 (saut de ligne, tabulation, NUL)", () => {
    expect(rendreVisible("a\nb")).toBe("a␊b");
    expect(rendreVisible("a\tb")).toBe("a␉b");
    expect(rendreVisible("a\u0000b")).toBe("a␀b");
    expect(rendreVisible("a\u007fb")).toBe("a␡b");
  });

  it("neutralise l'inversion de sens (RLO) et les caractères de largeur nulle", () => {
    expect(rendreVisible("fdp.‮exe")).toBe("fdp.⟨U+202E⟩exe");
    expect(rendreVisible("a​b")).toBe("a⟨U+200B⟩b");
    expect(rendreVisible("﻿x")).toBe("⟨U+FEFF⟩x");
  });

  it("laisse intacts le texte ordinaire, les accents et les balises (React les échappe)", () => {
    expect(rendreVisible("Relevé été côtière <b>x</b>")).toBe("Relevé été côtière <b>x</b>");
    expect(rendreVisible("日本語 🚧")).toBe("日本語 🚧");
  });

  it("accepte null et undefined sans lever", () => {
    expect(rendreVisible(null)).toBe("");
    expect(rendreVisible(undefined)).toBe("");
  });
});

describe("CompteursLot", () => {
  it("est un tableau légendé : lues, conformes, rejetées, ignorées, en conflit", () => {
    render(<CompteursLot compteurs={{ lues: 10, validees: 8, rejetees: 2, enConflit: 0, ignorees: 0, importees: 0 }} />);
    const t = screen.getByRole("table", { name: /Compteurs du contrôle du schéma/ });
    const entetes = within(t).getAllByRole("columnheader").map((h) => h.textContent);
    expect(entetes).toEqual(["Lues", "Conformes", "Rejetées", "Ignorées", "En conflit"]);
    const valeurs = within(t).getAllByRole("cell").map((c) => c.textContent);
    expect(valeurs).toEqual(["10", "8", "2", "0", "0"]);
  });

  it("n'a pas de colonne « importées », et ne tait pas une valeur non nulle déclarée par le serveur", () => {
    const { rerender } = render(<CompteursLot compteurs={{ lues: 1, validees: 1, rejetees: 0, enConflit: 0, ignorees: 0, importees: 0 }} />);
    expect(screen.queryByText(/importées/i)).not.toBeInTheDocument();
    rerender(<CompteursLot compteurs={{ lues: 1, validees: 1, rejetees: 0, enConflit: 0, ignorees: 0, importees: 3 }} />);
    expect(screen.queryByRole("columnheader", { name: /import/i })).not.toBeInTheDocument();
    expect(screen.getByText(/3 ligne\(s\) écrite\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/pas un résultat du contrôle/)).toBeInTheDocument();
  });
});
