import { describe, expect, it } from "vitest";
import { decoderCurseurAnalyse, decoderCurseurConflit, encoderCurseurAnalyse, encoderCurseurConflit } from "./curseurs.noyau";

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o), "utf8").toString("base64url");
const ID = "123e4567-e89b-42d3-a456-426614174000";
const T = "2026-11-06T10:15:30.123Z";
/** Chaine d'un octet NUL, construite sans ecrire l'octet dans ce fichier. */
const NUL = String.fromCharCode(0);

describe("revue RC-3, m7 : curseur des dossiers", () => {
  it("un curseur produit par le serveur se relit a l'identique", () => {
    const c = decoderCurseurConflit(encoderCurseurConflit({ t: T, i: ID }));
    expect(c?.i).toBe(ID);
    expect(c?.t.toISOString()).toBe(T);
  });

  it.each([
    ["pas du base64 de JSON", "zzz"],
    ["JSON qui n'est pas un objet", b64("[1,2]")],
    ["t manquant", b64({ i: ID })],
    ["i manquant", b64({ t: T })],
    ["t numerique", b64({ t: 1762424130123, i: ID })],
    ["i numerique", b64({ t: T, i: 5 })],
    ["i qui contient un octet NUL (500 PostgreSQL avant la correction)", b64({ t: T, i: NUL })],
    ["i qui n'est pas un UUID", b64({ t: T, i: "abc" })],
    ["i en majuscules", b64({ t: T, i: ID.toUpperCase() })],
    ["i trop long", b64({ t: T, i: `${ID}${"a".repeat(40)}` })],
    ["t forge a l'annee 275760 (hors intervalle PostgreSQL)", b64({ t: "+275760-09-13T00:00:00.000Z", i: ID })],
    ["t a l'annee 9999", b64({ t: "9999-01-01T00:00:00.000Z", i: ID })],
    ["t avant 1970", b64({ t: "1969-12-31T23:59:59.999Z", i: ID })],
    ["t forme libre (analysable par JavaScript, jamais produite par le serveur)", b64({ t: "Nov 6 2026", i: ID })],
    ["t sans millisecondes", b64({ t: "2026-11-06T10:15:30Z", i: ID })],
    ["t avec un jour inexistant (31 novembre)", b64({ t: "2026-11-31T10:15:30.123Z", i: ID })],
    ["t avec un fuseau", b64({ t: "2026-11-06T10:15:30.123+02:00", i: ID })],
  ])("refuse : %s", (_nom, brut) => { expect(decoderCurseurConflit(brut)).toBeNull(); });

  it("accepte les bornes 1970 et 2200 et refuse au-dela", () => {
    expect(decoderCurseurConflit(b64({ t: "1970-01-01T00:00:00.000Z", i: ID }))).not.toBeNull();
    expect(decoderCurseurConflit(b64({ t: "2200-12-31T23:59:59.999Z", i: ID }))).not.toBeNull();
    expect(decoderCurseurConflit(b64({ t: "2201-01-01T00:00:00.000Z", i: ID }))).toBeNull();
  });
});

describe("revue RC-3, m7 : curseur des analyses", () => {
  it("un curseur produit par le serveur se relit a l'identique, jusqu'a la borne de la colonne integer", () => {
    expect(decoderCurseurAnalyse(encoderCurseurAnalyse(1))).toBe(1);
    expect(decoderCurseurAnalyse(encoderCurseurAnalyse(2_147_483_647))).toBe(2_147_483_647);
  });

  it.each([
    ["zero", b64({ n: 0 })], ["negatif", b64({ n: -3 })], ["fraction", b64({ n: 1.5 })], ["texte", b64({ n: "7" })],
    ["superieur a la colonne integer (500 PostgreSQL avant la correction)", b64({ n: 2_147_483_648 })], ["enorme", b64({ n: 1e300 })],
    ["absent", b64({})], ["pas un objet", b64("7")], ["pas du base64 de JSON", "zzz"], ["infini serialise", b64("{\"n\":1e999}")],
  ])("refuse : %s", (_nom, brut) => { expect(decoderCurseurAnalyse(brut)).toBeNull(); });
});
