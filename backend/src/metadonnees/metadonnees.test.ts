import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { CATALOGUE, trouverFiche } from "./catalogue.referentiel";
import { contexteDe, lister, xmlDe, type DepotMetadonnees, type OptionsPublication } from "./metadonnees.service";
import { creerRouteurMetadonnees } from "./metadonnees.routes";

/**
 * Ce que ces tests defendent :
 *   - le catalogue ne decrit que des jeux que le service public SERT (chemin verifie dans le routeur) ;
 *   - l'etendue et la revision viennent des donnees ; si la base tombe, la fiche sort quand meme avec
 *     ces champs vides ET declares en lacune, jamais avec une valeur de repli ;
 *   - aucun SQL ne vient de l'identifiant demande ;
 *   - un identifiant inconnu est un 404, pas un document vide.
 */

const OPT: OptionsPublication = { organisme: "AGEROUTE Guinee", courriel: null, baseUrl: null, aujourdhui: "2026-10-22" };

function depot(ligne: unknown = { ouest: -14.5, est: -8.1, sud: 8.2, nord: 12.1, revision: "2026-10-20" }) {
  const sql: string[] = [];
  const d: DepotMetadonnees = {
    $queryRaw: async <T,>(chaines: TemplateStringsArray) => { sql.push(chaines.join("?")); return [ligne] as unknown as T; },
  };
  return { d, sql };
}
const depotHS: DepotMetadonnees = { $queryRaw: async () => { throw new Error("base indisponible"); } };

describe("catalogue", () => {
  it("a des identifiants uniques, sans caractere qui sorte de l'URL", () => {
    const ids = CATALOGUE.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("ne decrit que des points d'acces que le routeur public monte reellement", async () => {
    const { publicRouter } = await import("../modules/public/public.routes");
    type Couche = { route?: { path: string; methods: Record<string, boolean> } };
    const chemins = ((publicRouter as unknown as { stack: Couche[] }).stack)
      .filter((c) => c.route?.methods.get).map((c) => c.route!.path);
    expect(chemins.length).toBeGreaterThan(0);
    for (const f of CATALOGUE) {
      if (!f.acces) continue;
      expect(f.acces.chemin.startsWith("/api/public")).toBe(true);
      expect(chemins).toContain(f.acces.chemin.slice("/api/public".length));
    }
    // L'import charge tout le routeur public (controleurs, services) : 1,7 s a vide, plus de 30 s
    // quand la suite complete tourne en parallele (constate le 22/10 apres la fusion de lot/14).
  }, 90_000);

  it("ne choisit aucune licence a la place d'AGEROUTE (aucune decision de licence dans le depot)", () => {
    for (const f of CATALOGUE) expect(f.conditions).toBeNull();
  });

  it("dit que les ouvrages OSM sont exclus et que les positions heritees ne sont pas verifiees", () => {
    const o = trouverFiche("ouvrages")!;
    expect(o.genealogie).toMatch(/EXCLUS/);
    expect(o.genealogie).toMatch(/non verifiees/);
  });

  it("attribue OpenStreetMap pour la voirie locale et dit que la donnee n'est pas verifiee par AGEROUTE", () => {
    const v = trouverFiche("voirie-locale")!;
    expect(v.attribution).toMatch(/OpenStreetMap/);
    expect(v.genealogie).toMatch(/Ce n'est pas une donnee verifiee/);
  });

  it("a une source SQL pour chaque jeu (l'etendue est calculable)", async () => {
    for (const f of CATALOGUE) {
      const { d, sql } = depot();
      const ctx = await contexteDe(f, d, OPT);
      expect(sql, f.id).toHaveLength(1);
      expect(ctx.emprise, f.id).not.toBeNull();
    }
  });
});

describe("contexteDe", () => {
  it("calcule l'etendue et la revision sur les donnees servies", async () => {
    const { d, sql } = depot();
    const ctx = await contexteDe(trouverFiche("troncons")!, d, OPT);
    expect(ctx.emprise).toEqual({ ouest: -14.5, est: -8.1, sud: 8.2, nord: 12.1 });
    expect(ctx.derniereRevision).toBe("2026-10-20");
    expect(sql[0]).toMatch(/FROM troncons WHERE geom IS NOT NULL AND "deletedAt" IS NULL/);
  });

  it("formate la date de revision SANS conversion de fuseau : updatedAt est un timestamp sans fuseau, stocke en UTC", async () => {
    // AT TIME ZONE 'UTC' le ferait passer en timestamptz, que to_char formate ensuite dans le fuseau
    // de la SESSION : la date de revision changerait avec la configuration de la connexion.
    for (const f of CATALOGUE) {
      const { d, sql } = depot();
      await contexteDe(f, d, OPT);
      expect(sql[0], f.id).toContain("to_char(r, 'YYYY-MM-DD')");
      expect(sql[0], f.id).not.toMatch(/AT TIME ZONE/i);
    }
  });

  it("applique aux ouvrages le meme predicat que la carte publique (sans les franchissements OSM)", async () => {
    const { d, sql } = depot();
    await contexteDe(trouverFiche("ouvrages")!, d, OPT);
    expect(sql[0]).toMatch(/ouvrage_osm:%/);
    expect(sql[0]).toMatch(/"sourceReference" IS NULL/);
  });

  it("si la base tombe : pas d'etendue, pas de date, pas d'exception, pas de valeur de repli", async () => {
    const ctx = await contexteDe(trouverFiche("troncons")!, depotHS, OPT);
    expect(ctx.emprise).toBeNull();
    expect(ctx.derniereRevision).toBeNull();
  });

  it("une table vide (etendue NULL) donne une etendue absente, pas des zeros", async () => {
    const { d } = depot({ ouest: null, est: null, sud: null, nord: null, revision: null });
    const ctx = await contexteDe(trouverFiche("chantiers")!, d, OPT);
    expect(ctx.emprise).toBeNull();
    expect(ctx.derniereRevision).toBeNull();
  });
});

describe("lister et xmlDe", () => {
  it("liste les jeux avec leurs lacunes et l'adresse de leur fiche XML", async () => {
    const jeux = await lister(depot().d, OPT);
    expect(jeux.map((j) => j.id)).toEqual(CATALOGUE.map((f) => f.id));
    for (const j of jeux) {
      expect(j.xml).toBe(`/api/public/metadonnees/${j.id}.xml`);
      expect(j.lacunes.map((l) => l.champ)).toEqual(expect.arrayContaining(["contact.courriel", "contraintes.reutilisation"]));
    }
  });

  it("annonce l'etendue et la date comme lacunes quand la base est indisponible", async () => {
    const jeux = await lister(depotHS, OPT);
    for (const j of jeux) expect(j.lacunes.map((l) => l.champ)).toEqual(expect.arrayContaining(["etendue.geographique", "date.revision"]));
  });

  it("rend null pour un identifiant inconnu, sans interroger la base", async () => {
    const { d, sql } = depot();
    expect(await xmlDe("inconnu", d, OPT)).toBeNull();
    expect(await xmlDe("troncons'; DROP TABLE troncons;--", d, OPT)).toBeNull();
    expect(sql).toHaveLength(0);
  });
});

describe("routes /metadonnees", () => {
  const app = (d: DepotMetadonnees = depot().d, o: OptionsPublication = OPT) => {
    const a = express();
    a.use("/api/public/metadonnees", creerRouteurMetadonnees(d, () => o));
    return a;
  };

  it("GET / : liste JSON, norme annoncee, validation XSD declaree non verifiee", async () => {
    const r = await request(app()).get("/api/public/metadonnees");
    expect(r.status).toBe(200);
    expect(r.body.norme).toMatch(/ISO 19115/);
    expect(r.body.validationXsd).toBe("non verifiee");
    expect(r.body.jeux).toHaveLength(CATALOGUE.length);
  });

  it("GET /:id.xml : document XML pour chaque jeu du catalogue", async () => {
    for (const f of CATALOGUE) {
      const r = await request(app()).get(`/api/public/metadonnees/${f.id}.xml`);
      expect(r.status, f.id).toBe(200);
      expect(r.headers["content-type"]).toMatch(/application\/xml/);
      expect(r.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(r.text).toContain(`ageroute-bdri-${f.id}`);
    }
  });

  it("GET /:id.xml : 404 pour un identifiant inconnu", async () => {
    const r = await request(app()).get("/api/public/metadonnees/nexiste-pas.xml");
    expect(r.status).toBe(404);
  });

  it("l'adresse du service et le courriel configures figurent dans la fiche", async () => {
    const o = { ...OPT, courriel: "meta@exemple.org", baseUrl: "https://carte.exemple.org" };
    const r = await request(app(depot().d, o)).get("/api/public/metadonnees/voirie-locale.xml");
    expect(r.text).toContain("https://carte.exemple.org/api/public/voirie-locale/geo");
    expect(r.text).toContain("meta@exemple.org");
  });

  it("une erreur inattendue ne fabrique pas de document : elle part au gestionnaire d'erreurs", async () => {
    const o = { ...OPT, aujourdhui: "pas-une-date" };
    const a = express();
    a.use("/m", creerRouteurMetadonnees(depot().d, () => o));
    a.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ message: "erreur" }); });
    const r = await request(a).get("/m/troncons.xml");
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("MD_Metadata");
  });
});
