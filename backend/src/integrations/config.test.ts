import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { lireConfigIntegrations, resumerConfig, verifierUrlBase } from "./config";
import { DESTINATIONS } from "./types";

/**
 * Configuration des adaptateurs. Ce que ces tests defendent :
 *   - RIEN n'est actif par defaut, avec un environnement vide comme avec un environnement partiel ;
 *   - aucune valeur par defaut ne peut activer un envoi reel (URL, chemin, jeton sans defaut) ;
 *   - https est exige hors boucle locale ;
 *   - le jeton ne sort ni par JSON, ni par console, ni par String().
 */
const ACTIF = {
  INTEGRATIONS_SORTANTES_ACTIVES: "true",
  OUTBOX_DIGITALROAD_ACTIF: "true",
  OUTBOX_DIGITALROAD_URL: "https://digitalroad.example.test",
  OUTBOX_DIGITALROAD_CHEMIN: "/api/fiches",
  OUTBOX_DIGITALROAD_JETON: "jeton-secret-0123456789",
};

describe("desactive par defaut", () => {
  it("un environnement vide n'active aucune destination", () => {
    const c = lireConfigIntegrations({});
    expect(c.interrupteurGeneral).toBe(false);
    for (const d of DESTINATIONS) {
      expect(c.destinations[d].actif).toBe(false);
      expect(c.destinations[d].raison).toMatch(/interrupteur general/);
    }
  });

  it("sans l'interrupteur general, une destination entierement configuree reste inactive", () => {
    const { INTEGRATIONS_SORTANTES_ACTIVES: _x, ...sansGeneral } = ACTIF;
    expect(lireConfigIntegrations(sansGeneral).destinations.DIGITALROAD.actif).toBe(false);
  });

  it("l'interrupteur general seul n'active rien", () => {
    const c = lireConfigIntegrations({ INTEGRATIONS_SORTANTES_ACTIVES: "true" });
    for (const d of DESTINATIONS) expect(c.destinations[d].actif).toBe(false);
  });

  it.each(["TRUE ", "1", "oui", "yes", "false", ""])("l'interrupteur general vaut true et seulement true : %j", (v) => {
    const c = lireConfigIntegrations({ ...ACTIF, INTEGRATIONS_SORTANTES_ACTIVES: v });
    // « TRUE » avec espace est accepte (insensible a la casse et aux espaces) ; les autres non.
    expect(c.destinations.DIGITALROAD.actif).toBe(v.trim().toLowerCase() === "true");
  });

  it.each([
    ["URL", "OUTBOX_DIGITALROAD_URL", /URL absente/],
    ["chemin", "OUTBOX_DIGITALROAD_CHEMIN", /CHEMIN absent/],
    ["jeton", "OUTBOX_DIGITALROAD_JETON", /JETON absent/],
    ["activation nommee", "OUTBOX_DIGITALROAD_ACTIF", /non activee/],
  ])("sans %s, la destination reste inactive et dit pourquoi", (_n, cle, motif) => {
    const env: Record<string, string | undefined> = { ...ACTIF };
    delete env[cle];
    const d = lireConfigIntegrations(env).destinations.DIGITALROAD;
    expect(d.actif).toBe(false);
    expect(d.raison).toMatch(motif);
  });

  it("n'active que la destination nommee", () => {
    const c = lireConfigIntegrations(ACTIF);
    expect(c.destinations.DIGITALROAD.actif).toBe(true);
    expect(c.destinations.SHAREPOINT.actif).toBe(false);
    expect(c.destinations.BDR_L2R.actif).toBe(false);
  });
});

describe("URL de base", () => {
  it("exige https hors de la boucle locale", () => {
    expect(verifierUrlBase("http://digitalroad.example.test").ok).toBe(false);
    expect(verifierUrlBase("https://digitalroad.example.test").ok).toBe(true);
  });

  it("n'admet http que vers la boucle locale", () => {
    for (const u of ["http://127.0.0.1:4010", "http://localhost:4010", "http://[::1]:4010"]) expect(verifierUrlBase(u).ok).toBe(true);
    expect(verifierUrlBase("http://127.0.0.2:4010").ok).toBe(false);
    expect(verifierUrlBase("http://10.0.0.5").ok).toBe(false);
  });

  it("refuse un identifiant dans l'URL (le jeton se donne a part), une requete, un fragment, un autre protocole", () => {
    expect(verifierUrlBase("https://user:pw@digitalroad.example.test").ok).toBe(false);
    expect(verifierUrlBase("https://digitalroad.example.test/?token=x").ok).toBe(false);
    expect(verifierUrlBase("https://digitalroad.example.test/#x").ok).toBe(false);
    expect(verifierUrlBase("ftp://digitalroad.example.test").ok).toBe(false);
    expect(verifierUrlBase("pas une url").ok).toBe(false);
  });

  it("retire la barre finale", () => {
    expect(verifierUrlBase("https://digitalroad.example.test/")).toEqual({ ok: true, url: "https://digitalroad.example.test" });
  });

  it.each(["api/fiches", "/a//b", "/a/../b", "/api?x=1", "/api fiches"])("refuse le chemin %j", (chemin) => {
    const d = lireConfigIntegrations({ ...ACTIF, OUTBOX_DIGITALROAD_CHEMIN: chemin }).destinations.DIGITALROAD;
    expect(d.actif).toBe(false);
    expect(d.raison).toMatch(/CHEMIN/);
  });
});

describe("le jeton ne fuit pas", () => {
  const c = lireConfigIntegrations(ACTIF);
  const jeton = "jeton-secret-0123456789";

  it("n'apparait ni dans JSON.stringify, ni dans String(), ni dans util.inspect de la configuration", () => {
    expect(JSON.stringify(c)).not.toContain(jeton);
    expect(String(c.destinations.DIGITALROAD.jeton)).not.toContain(jeton);
    expect(inspect(c, { depth: 10 })).not.toContain(jeton);
    expect(`${c.destinations.DIGITALROAD.jeton}`).toBe("[SECRET]");
  });

  it("n'est lisible que par valeur()", () => {
    expect(c.destinations.DIGITALROAD.jeton?.valeur()).toBe(jeton);
  });

  it("la vue d'administration ne porte ni jeton ni URL", () => {
    const vue = JSON.stringify(resumerConfig(c));
    expect(vue).not.toContain(jeton);
    expect(vue).not.toContain("digitalroad.example.test");
  });
});

describe("reglages de reprise", () => {
  it("valeurs par defaut", () => {
    const c = lireConfigIntegrations({});
    expect(c.politique).toEqual({ tentativesMax: 8, delaiBaseMs: 30_000, delaiPlafondMs: 3_600_000 });
    expect(c.verrouMs).toBe(120_000);
    expect(c.lotMax).toBe(20);
    expect(c.avertissements).toEqual([]);
  });

  it("une valeur illisible est ignoree, remplacee par le defaut et signalee, sans lever", () => {
    const c = lireConfigIntegrations({ OUTBOX_TENTATIVES_MAX: "beaucoup", OUTBOX_LOT_MAX: "0", OUTBOX_DELAI_BASE_MS: "12.5" });
    expect(c.politique.tentativesMax).toBe(8);
    expect(c.lotMax).toBe(20);
    expect(c.avertissements.length).toBe(3);
  });

  it("le plafond ne peut pas etre inferieur a la base", () => {
    const c = lireConfigIntegrations({ OUTBOX_DELAI_BASE_MS: "60000", OUTBOX_DELAI_PLAFOND_MS: "5000" });
    expect(c.politique.delaiPlafondMs).toBe(60_000);
    expect(c.avertissements.join(" ")).toMatch(/plafond/);
  });

  it("le bail est au moins le double du plus long delai d'attente", () => {
    const c = lireConfigIntegrations({ OUTBOX_VERROU_MS: "1000", OUTBOX_BDR_L2R_TIMEOUT_MS: "30000" });
    expect(c.verrouMs).toBe(60_000);
    expect(c.avertissements.join(" ")).toMatch(/bail|VERROU/i);
  });
});
