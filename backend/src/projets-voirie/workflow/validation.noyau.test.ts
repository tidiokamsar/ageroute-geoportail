import { describe, expect, it } from "vitest";
import {
  diffChamps, exigerDatePassee, exigerJustification, jourDe, jourValide, justificationSuffisante, normaliserSha256, referenceAcceptable, sansCaractereDeControle, texteBorne,
} from "./validation.noyau";

describe("textes libres", () => {
  it("les caracteres de controle sont refuses (NUL compris), les sauts de ligne et tabulations admis", () => {
    expect(sansCaractereDeControle("ligne 1\nligne 2\t(suite)\r\n")).toBe(true);
    for (const c of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u001b", "\u007f"]) expect(sansCaractereDeControle(`a${c}b`), JSON.stringify(c)).toBe(false);
  });

  it("texteBorne : longueur apres retrait des espaces de bord, et controle", () => {
    expect(texteBorne("objet", "  ok  ", 10)).toBeNull();
    expect(texteBorne("objet", "   ", 10)).toMatchObject({ status: 400, code: "CHAMPS_INVALIDES" });
    expect(texteBorne("objet", "x".repeat(11), 10)).toMatchObject({ code: "CHAMPS_INVALIDES" });
    expect(texteBorne("objet", "x".repeat(10), 10)).toBeNull();
    expect(texteBorne("objet", "a\u0000b", 10)).toMatchObject({ code: "CHAMPS_INVALIDES" });
  });
});

describe("references de pieces : un texte, jamais un lien executable", () => {
  it("accepte numeros, noms de plan, chemins d'archive et URL http(s) (ce sont des textes)", () => {
    for (const r of ["Courrier AGEROUTE n° 123/2026", "plans/recolement-axe-A-v2.pdf", "\\\\serveur\\archives\\dossier", "https://exemple.invalid/plan.pdf", "mailto:archive@exemple.invalid"]) {
      expect(referenceAcceptable(r), r).toBe(true);
    }
  });

  it("refuse javascript:, data:, vbscript: et file:, y compris camoufles (espaces, tabulations, majuscules, caracteres invisibles)", () => {
    for (const r of ["javascript:alert(1)", "  JavaScript:alert(1)", "java\tscript:alert(1)", "java\u200bscript:alert(1)", "data:text/html;base64,AAAA", "vbscript:msgbox(1)", "file:///C:/Windows/system.ini", "FILE:///etc/passwd", "ja va script :x"]) {
      expect(referenceAcceptable(r), JSON.stringify(r)).toBe(false);
    }
  });

  it("refuse une reference qui contient un caractere de controle", () => {
    expect(referenceAcceptable("plan\u0000.pdf")).toBe(false);
  });
});

describe("empreinte SHA-256", () => {
  const h = "a".repeat(64);
  it("accepte 64 hexadecimaux (majuscules ramenees en minuscules, espaces de bord retires)", () => {
    expect(normaliserSha256(h)).toBe(h);
    expect(normaliserSha256(`  ${"AB".repeat(32)} `)).toBe("ab".repeat(32));
  });
  it("refuse toute autre chose", () => {
    for (const s of ["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), `${h}\n${h}`, "0x" + "a".repeat(62), "sha256:" + h]) expect(normaliserSha256(s), s).toBeNull();
  });
});

describe("dates de jour et justification", () => {
  it("jourValide : AAAA-MM-JJ existant, 1900 a 2100", () => {
    for (const s of ["2026-11-07", "1900-01-01", "2100-12-31", "2024-02-29"]) expect(jourValide(s), s).toBe(true);
    for (const s of ["2026-02-30", "2026-13-01", "2026-1-1", "26-11-07", "1899-12-31", "2101-01-01", "", "2026-11-07T00:00:00Z", "demain"]) expect(jourValide(s), s).toBe(false);
  });

  it("exigerDatePassee : refuse une date invalide ou future (422 DATE_INVALIDE), accepte aujourd'hui et le passe", () => {
    expect(exigerDatePassee("dateEnvoi", "2026-11-07", "2026-11-07")).toBeNull();
    expect(exigerDatePassee("dateEnvoi", "2026-01-01", "2026-11-07")).toBeNull();
    expect(exigerDatePassee("dateEnvoi", "2026-11-08", "2026-11-07")).toMatchObject({ status: 422, code: "DATE_INVALIDE" });
    expect(exigerDatePassee("dateEnvoi", "2026-02-30", "2026-11-07")).toMatchObject({ status: 422, code: "DATE_INVALIDE" });
  });

  it("jourDe rend le jour UTC", () => {
    expect(jourDe(new Date("2026-11-07T23:59:59.999Z"))).toBe("2026-11-07");
  });

  it("justification : 10 caracteres au moins apres retrait des espaces de bord (422 JUSTIFICATION_REQUISE)", () => {
    expect(justificationSuffisante("0123456789")).toBe(true);
    expect(justificationSuffisante("   012345678   ")).toBe(false);
    expect(justificationSuffisante(undefined)).toBe(false);
    expect(exigerJustification("court")).toMatchObject({ status: 422, code: "JUSTIFICATION_REQUISE" });
    expect(exigerJustification("une justification suffisante")).toBeNull();
  });
});

describe("diffChamps : l'avant et l'apres des seuls champs qui changent", () => {
  const avant = { objet: "A", constat: null as string | null, echeance: "2026-12-01" };
  it("ne garde que ce qui change, null compris", () => {
    expect(diffChamps(avant, { objet: "B", constat: null, echeance: "2026-12-01" })).toEqual({ avant: { objet: "A" }, apres: { objet: "B" } });
    expect(diffChamps(avant, { constat: "texte" })).toEqual({ avant: { constat: null }, apres: { constat: "texte" } });
    expect(diffChamps(avant, { echeance: null as unknown as string })).toEqual({ avant: { echeance: "2026-12-01" }, apres: { echeance: null } });
  });
  it("aucun changement, ou champs non fournis : null (aucune ligne d'historique)", () => {
    expect(diffChamps(avant, {})).toBeNull();
    expect(diffChamps(avant, { objet: "A", echeance: "2026-12-01" })).toBeNull();
    expect(diffChamps(avant, { objet: undefined })).toBeNull();
  });
});
