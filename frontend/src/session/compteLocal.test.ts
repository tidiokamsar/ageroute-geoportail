// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BASE_OFFLINE_HISTORIQUE, BASE_ROULAGE_HISTORIQUE, LONGUEUR_EMPREINTE, analyserNomBase, basesDesAutresComptes,
  cleAppartientAuCompte, cleLocalStorage, empreinteCompte, empreinteValide, nomBaseOffline, nomBaseRoulage,
  prefixeLocalStorage, type PortSha256,
} from "./compteLocal";

/** Port SHA-256 de reference (Node), independant de WebCrypto : un second avis sur le calcul. */
const sha256Node: PortSha256 = async (octets) => new Uint8Array(createHash("sha256").update(octets).digest());

describe("empreinteCompte", () => {
  it("SHA-256 tronque a 16 hexa : vecteurs connus (chaine vide et « abc »)", async () => {
    // ba7816bf8f01cfea : debut de SHA-256("abc") (vecteur de la norme FIPS 180-2).
    expect(await empreinteCompte("a", sha256Node)).toBe(createHash("sha256").update("a").digest("hex").slice(0, 16));
    expect(await empreinteCompte("abc", sha256Node)).toBe("ba7816bf8f01cfea");
  });

  it("est deterministe, de la bonne longueur et en minuscules", async () => {
    const a = await empreinteCompte("c1f4-user", sha256Node);
    const b = await empreinteCompte("c1f4-user", sha256Node);
    expect(a).toBe(b);
    expect(a).toHaveLength(LONGUEUR_EMPREINTE);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("deux comptes ont deux empreintes ; la casse compte", async () => {
    const [a, b, c] = await Promise.all(["alice", "bob", "Alice"].map((u) => empreinteCompte(u, sha256Node)));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("encode en UTF-8 (un identifiant accentue ne plante pas et differe de sa forme nue)", async () => {
    const a = await empreinteCompte("éléonore", sha256Node);
    expect(a).toBe(createHash("sha256").update("éléonore", "utf8").digest("hex").slice(0, 16));
  });

  it("accepte un port qui rend un ArrayBuffer", async () => {
    const port: PortSha256 = async (o) => new Uint8Array(createHash("sha256").update(o).digest()).buffer;
    expect(await empreinteCompte("abc", port)).toBe("ba7816bf8f01cfea");
  });

  it("refuse un identifiant vide et un port defaillant", async () => {
    await expect(empreinteCompte("", sha256Node)).rejects.toThrow(/vide/);
    await expect(empreinteCompte(undefined as unknown as string, sha256Node)).rejects.toThrow();
    await expect(empreinteCompte("x", async () => new Uint8Array(3))).rejects.toThrow(/moins de 8 octets/);
  });

  it("n'expose pas l'identifiant dans l'empreinte", async () => {
    const e = await empreinteCompte("alice@ageroute.gov.gn", sha256Node);
    expect(e).not.toContain("alice");
  });
});

describe("noms de bases et de cles", () => {
  const e = "0123456789abcdef";

  it("une base par compte et par famille", () => {
    expect(nomBaseOffline(e)).toBe("bdri-offline-0123456789abcdef");
    expect(nomBaseRoulage(e)).toBe("bdri-roulage-0123456789abcdef");
  });

  it("les noms cloisonnes different des noms historiques", () => {
    expect(nomBaseOffline(e)).not.toBe(BASE_OFFLINE_HISTORIQUE);
    expect(nomBaseRoulage(e)).not.toBe(BASE_ROULAGE_HISTORIQUE);
    expect(BASE_OFFLINE_HISTORIQUE).toBe("bdri-offline");
    expect(BASE_ROULAGE_HISTORIQUE).toBe("bdri-roulage");
  });

  it("prefixe et cles localStorage", () => {
    expect(prefixeLocalStorage(e)).toBe("bdri:0123456789abcdef:");
    expect(cleLocalStorage(e, "deconnexionEnAttente")).toBe("bdri:0123456789abcdef:deconnexionEnAttente");
    expect(cleAppartientAuCompte("bdri:0123456789abcdef:x", e)).toBe(true);
    expect(cleAppartientAuCompte("bdri:fedcba9876543210:x", e)).toBe(false);
    expect(cleAppartientAuCompte("bdri_refresh_token", e)).toBe(false);
  });

  it("une cle vide est refusee", () => {
    expect(() => cleLocalStorage(e, "")).toThrow();
  });

  it.each(["", "abc", "0123456789ABCDEF", "0123456789abcdeg", "0123456789abcdef0", "../etc/passwd0000", " 123456789abcdef"])(
    "empreinte mal formee refusee partout : %j",
    (mauvaise) => {
      expect(empreinteValide(mauvaise)).toBe(false);
      expect(() => nomBaseOffline(mauvaise)).toThrow();
      expect(() => nomBaseRoulage(mauvaise)).toThrow();
      expect(() => prefixeLocalStorage(mauvaise)).toThrow();
      expect(() => cleLocalStorage(mauvaise, "k")).toThrow();
    },
  );

  it("empreinteValide refuse les non-chaines", () => {
    expect(empreinteValide(undefined)).toBe(false);
    expect(empreinteValide(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe("analyserNomBase", () => {
  const e = "0123456789abcdef";
  it("reconnait les deux familles et rend l'empreinte", () => {
    expect(analyserNomBase(nomBaseOffline(e))).toEqual({ genre: "OFFLINE", empreinte: e });
    expect(analyserNomBase(nomBaseRoulage(e))).toEqual({ genre: "ROULAGE", empreinte: e });
  });
  it("ne reconnait ni la base historique, ni une base etrangere, ni une empreinte mal formee", () => {
    expect(analyserNomBase("bdri-offline")).toBeNull();
    expect(analyserNomBase("bdri-roulage")).toBeNull();
    expect(analyserNomBase("autre-base")).toBeNull();
    expect(analyserNomBase("bdri-offline-XYZ")).toBeNull();
    expect(analyserNomBase("bdri-offline-0123456789abcdef-extra")).toBeNull();
  });
  it("basesDesAutresComptes : exclut le compte courant et ce qu'elle ne reconnait pas", () => {
    const autre = "fedcba9876543210";
    const noms = [nomBaseOffline(e), nomBaseRoulage(e), nomBaseOffline(autre), nomBaseRoulage(autre), "bdri-offline", "x"];
    expect(basesDesAutresComptes(noms, e)).toEqual([nomBaseOffline(autre), nomBaseRoulage(autre)]);
    expect(() => basesDesAutresComptes(noms, "mauvaise")).toThrow();
  });
});
