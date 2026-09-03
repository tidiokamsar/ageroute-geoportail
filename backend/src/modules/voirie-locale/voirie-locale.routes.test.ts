import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Voirie locale — les garde-fous de l'emprise.
 *
 * La table porte 262 656 objets et 5,8 millions de sommets. Servie en entier, elle
 * representerait 41 Mo gzippes. Ces tests portent sur ce qui empeche cela d'arriver :
 * l'emprise obligatoire, sa surface bornee, et le plafond d'objets.
 *
 * Ils ne testent pas PostGIS. La requete spatiale elle-meme a ete mesuree sur les
 * 262 656 lignes reelles : Bitmap Index Scan, 7 ms.
 */

const etat = {
  lignes: [] as unknown[],
  derniereRequete: null as { texte: string; valeurs: unknown[] } | null,
};

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...valeurs: unknown[]) => {
      etat.derniereRequete = { texte: strings.join("?"), valeurs };
      return etat.lignes;
    }),
  },
}));

// Le controleur ne connait pas l'authentification : elle est posee au montage
// (requireAuth cote geoportail, limitation de debit cote carte publique). On monte
// donc les handlers nus, ce qui teste exactement ce que les deux surfaces partagent.
import { voirieGeoHandler, voirieStatsHandler } from "./voirie-locale.controller";
import { Router } from "express";

const voirieLocaleRouter = Router();
voirieLocaleRouter.get("/geo", voirieGeoHandler);
voirieLocaleRouter.get("/stats", voirieStatsHandler);

function app() {
  const a = express();
  a.use("/api/voirie-locale", voirieLocaleRouter);
  return a;
}

function voie(id: string, categorie = "VOIE_LOCALE", promue = false) {
  return {
    id, nature: "Route non classifiée", nom: null, reference: null,
    categorie, statut: promue ? "VALIDEE" : "SOURCE_EXTERNE",
    source: "OSM", source_id: `w${id}`,
    source_date: null, longueur_km: 0.4, region: null, region_methode: null,
    troncon_id: promue ? `t-${id}` : null,
    troncon_code: promue ? `KALOUM-OSM-w${id}` : null,
    geometry: '{"type":"LineString","coordinates":[[-13.7,9.5],[-13.6,9.6]]}',
  };
}

beforeEach(() => {
  etat.lignes = [];
  etat.derniereRequete = null;
});

describe("GET /api/voirie-locale/geo — l'emprise", () => {
  it("refuse une requête sans emprise", async () => {
    const r = await request(app()).get("/api/voirie-locale/geo");
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/emprise requise/i);
  });

  it("refuse le pays entier plutôt que de servir 41 Mo", async () => {
    const r = await request(app()).get("/api/voirie-locale/geo?bbox=-15,7,-7,13");
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/trop large/i);
    // Le message doit dire de combien on depasse, sinon il n'aide pas.
    expect(r.body.surfaceDemandee).toBeGreaterThan(r.body.surfaceMaximale);
  });

  it("accepte une emprise de ville", async () => {
    etat.lignes = [voie("a"), voie("b")];
    const r = await request(app()).get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65");
    expect(r.status).toBe(200);
    expect(r.body.voies).toHaveLength(2);
  });

  it("refuse une emprise mal formée", async () => {
    for (const bbox of ["1,2,3", "a,b,c,d", "-13,9,-14,10", "-13,9,-12,8", "999,9,1000,10"]) {
      const r = await request(app()).get(`/api/voirie-locale/geo?bbox=${bbox}`);
      expect(r.status, bbox).toBe(400);
    }
  });
});

describe("GET /api/voirie-locale/geo — la charge", () => {
  it("simplifie davantage sur une emprise large", async () => {
    await request(app()).get("/api/voirie-locale/geo?bbox=-13.9,9.3,-13.5,9.7"); // 0,16 deg²
    const large = etat.derniereRequete?.valeurs[0];

    await request(app()).get("/api/voirie-locale/geo?bbox=-13.60,9.57,-13.57,9.60"); // 0,0009 deg²
    const serre = etat.derniereRequete?.valeurs[0];

    expect(Number(large)).toBeGreaterThan(Number(serre));
  });

  it("ne simplifie pas au plus près — c'est la forme exacte qu'on regarde", async () => {
    await request(app()).get("/api/voirie-locale/geo?bbox=-13.60,9.57,-13.57,9.60");
    expect(Number(etat.derniereRequete?.valeurs[0])).toBe(0);
  });

  it("tronque au plafond et le signale", async () => {
    etat.lignes = Array.from({ length: 12_001 }, (_, i) => voie(String(i)));
    const r = await request(app()).get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65");

    expect(r.body.tronque).toBe(true);
    expect(r.body.voies).toHaveLength(r.body.plafond);
  });

  it("ne prétend pas tronquer quand tout tient", async () => {
    etat.lignes = [voie("a")];
    const r = await request(app()).get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65");
    expect(r.body.tronque).toBe(false);
  });
});

describe("GET /api/voirie-locale/geo — les catégories", () => {
  it("ignore une catégorie inconnue au lieu d'échouer", async () => {
    // Liste blanche : une valeur inventee ne doit ni passer en SQL, ni casser le client.
    const r = await request(app())
      .get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65&categories=CHEMIN,'; DROP TABLE--");
    expect(r.status).toBe(200);
    const categories = etat.derniereRequete?.valeurs[6] as string[];
    expect(categories).toContain("CHEMIN");
    expect(categories.join(" ")).not.toMatch(/DROP/i);
  });

  it("retient toutes les catégories quand aucune n'est demandée", async () => {
    await request(app()).get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65");
    expect((etat.derniereRequete?.valeurs[6] as string[]).length).toBe(11);
  });
});

describe("Ce que la réponse expose", () => {
  it("porte la provenance sur chaque voie", async () => {
    etat.lignes = [voie("a")];
    const r = await request(app()).get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65");
    const v = r.body.voies[0];

    // Une donnee externe doit rester identifiable comme telle, objet par objet.
    expect(v.source).toBe("OSM");
    expect(v.sourceId).toBe("wa");
    expect(v.statut).toBe("SOURCE_EXTERNE");
  });

  it("ne rattache aucun troncon a une voie non promue", async () => {
    etat.lignes = [voie("a")];
    const r = await request(app()).get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65");
    expect(r.body.voies[0].tronconId).toBeNull();
    expect(r.body.voies[0].tronconCode).toBeNull();
  });

  it("expose le troncon d'une voie promue — c'est ce qui la rend actif AGEROUTE", async () => {
    // VALIDEE ne dit que « le trace est juge correct ». Seul tronconId materialise
    // le classement institutionnel, et la fiche s'appuie dessus pour le dire.
    etat.lignes = [voie("b", "RESIDENTIELLE", true)];
    const r = await request(app()).get("/api/voirie-locale/geo?bbox=-13.75,9.48,-13.55,9.65");
    const v = r.body.voies[0];
    expect(v.tronconId).toBe("t-b");
    expect(v.tronconCode).toBe("KALOUM-OSM-wb");
  });
});
