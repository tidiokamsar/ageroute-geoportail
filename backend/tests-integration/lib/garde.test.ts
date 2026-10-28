import { describe, expect, it } from "vitest";
import { evaluerCible } from "./garde";

/**
 * La garde est ce qui separe « un banc qui verifie » de « un banc qui ecrit dans une base de
 * production laissee dans l'environnement du terminal ». Elle est donc testee sur les URL qu'on
 * pourrait vraiment y trouver.
 */
describe("evaluerCible", () => {
  it("accepte la base de rejeu et un clone jetable, en local", () => {
    expect(evaluerCible("postgresql://u:p@127.0.0.1:5434/replay")).toMatchObject({ ok: true, base: "replay" });
    expect(evaluerCible("postgresql://u:p@localhost:5432/essai_curseur")).toMatchObject({ ok: true, base: "essai_curseur" });
    expect(evaluerCible("postgres://u:p@[::1]:5432/essai_x1")).toMatchObject({ ok: true });
  });

  it("refuse un hote distant, meme avec un nom de base jetable", () => {
    for (const hote of ["db.example.org", "10.0.0.5", "192.168.1.20", "127.0.0.1.example.org", "localhost.example.org"]) {
      expect(evaluerCible(`postgresql://u:p@${hote}:5432/replay`).ok, hote).toBe(false);
    }
  });

  it("refuse une base locale qui n'est pas jetable (les noms de production ordinaires)", () => {
    for (const base of ["console_bdri", "console_bdri_dev", "postgres", "template1", "replay2", "essai", "essai_", "Essai_X", "essai-x", "x_replay"]) {
      expect(evaluerCible(`postgresql://u:p@127.0.0.1:5432/${base}`).ok, base).toBe(false);
    }
  });

  it("refuse une URL absente, illisible ou d'un autre protocole", () => {
    expect(evaluerCible(undefined).ok).toBe(false);
    expect(evaluerCible("").ok).toBe(false);
    expect(evaluerCible("pas une url").ok).toBe(false);
    expect(evaluerCible("mysql://u:p@127.0.0.1/replay").ok).toBe(false);
  });

  it("ne laisse jamais le mot de passe dans le message de refus", () => {
    const r = evaluerCible("postgresql://admin:Sup3rSecret@db.example.org:5432/console_bdri");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("Sup3rSecret");
  });

  it("n'est pas dupe d'un faux hote place avant l'arobase", () => {
    expect(evaluerCible("postgresql://127.0.0.1:x@db.example.org:5432/replay").ok).toBe(false);
  });
});
