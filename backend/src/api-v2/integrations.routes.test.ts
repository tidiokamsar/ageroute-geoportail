import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/integrations` -- ce que ces tests defendent :
 *   - reserve au role ADMIN : GESTIONNAIRE et LECTEUR recoivent 403 sur CHAQUE route ;
 *   - l'auteur vient de la SESSION, jamais du corps (corps stricts : une cle inconnue est un 400) ;
 *   - aucune reponse ne montre la charge (sauf demande expresse), ni jeton, ni URL de destinataire ;
 *   - inscrire une source non validee, ou vers une destination desactivee, est un 409 qui n'ecrit rien ;
 *   - relancer / abandonner exigent un motif, sont audites avec l'auteur, et refusent un evenement ENVOYE ;
 *   - rejouer un evenement ENVOYE ne contacte personne.
 * Contre des simulateurs loopback ecrits par AGEROUTE et un depot en memoire : rien de reel n'est atteint.
 */
const compte = vi.hoisted(() => ({ id: "u-admin", role: "ADMIN" as string }));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));
vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { creerRouteurIntegrations } from "./integrations.routes";
import { bancDeTest, chargeTroncon, JETON_DE_TEST, type BancDeTest } from "../integrations/essais.support";
import { lireConfigIntegrations } from "../integrations/config";
import { creerAdaptateurs } from "../integrations/adaptateurs";

let banc: BancDeTest;
let app: express.Express;
let appSansDestination: express.Express;

beforeAll(async () => {
  banc = await bancDeTest();
  app = express();
  app.use(express.json());
  app.use("/api/v2/integrations", creerRouteurIntegrations(() => banc.deps, () => banc.config));
  appSansDestination = express();
  appSansDestination.use(express.json());
  const vide = lireConfigIntegrations({});
  appSansDestination.use("/api/v2/integrations", creerRouteurIntegrations(() => ({ ...banc.deps, adaptateurs: creerAdaptateurs(vide) }), () => vide));
});
afterAll(async () => { await banc.fermer(); });

beforeEach(() => {
  compte.id = "u-admin"; compte.role = "ADMIN";
  for (const s of Object.values(banc.simulateurs)) s?.reinitialiser();
  banc.depot.evenements.length = 0; banc.depot.tentatives.length = 0; banc.depot.audits.length = 0;
  banc.sources.sources.clear();
  banc.horloge.maintenant = new Date("2026-10-24T08:00:00.000Z");
});

const BDR = () => banc.simulateurs.BDR_L2R!;
const poser = (id = "t-1") => banc.sources.poser("Troncon", id, { emissible: true, charge: chargeTroncon(id) });
const inscrire = (id = "t-1") => request(app).post("/api/v2/integrations/outbox").send({ destination: "BDR_L2R", sourceType: "Troncon", sourceId: id });

describe("acces reserve a ADMIN", () => {
  const ROUTES_PROTEGEES: [string, string, object?][] = [
    ["get", "/api/v2/integrations"],
    ["get", "/api/v2/integrations/contrats"],
    ["get", "/api/v2/integrations/outbox"],
    ["get", "/api/v2/integrations/outbox/3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ["post", "/api/v2/integrations/outbox", { destination: "BDR_L2R", sourceType: "Troncon", sourceId: "t-1" }],
    ["post", "/api/v2/integrations/outbox/traiter", {}],
    ["post", "/api/v2/integrations/outbox/3fa85f64-5717-4562-b3fc-2c963f66afa6/relancer", { motif: "essai" }],
    ["post", "/api/v2/integrations/outbox/3fa85f64-5717-4562-b3fc-2c963f66afa6/abandonner", { motif: "essai" }],
    ["post", "/api/v2/integrations/outbox/3fa85f64-5717-4562-b3fc-2c963f66afa6/rejouer", {}],
  ];

  it.each(["GESTIONNAIRE", "LECTEUR"])("%s recoit 403 sur chaque route, et rien n'est ecrit ni emis", async (role) => {
    compte.role = role;
    poser();
    for (const [methode, chemin, corps] of ROUTES_PROTEGEES) {
      const r = methode === "get" ? await request(app).get(chemin) : await request(app).post(chemin).send(corps);
      expect(r.status, `${methode} ${chemin}`).toBe(403);
    }
    expect(banc.depot.evenements).toHaveLength(0);
    expect(banc.depot.audits).toHaveLength(0);
    expect(BDR().requetes).toHaveLength(0);
  });
});

describe("lecture", () => {
  it("GET / : configuration sans jeton ni URL, et comptes par etat", async () => {
    const r = await request(app).get("/api/v2/integrations");
    expect(r.status).toBe(200);
    expect(r.body.contrat).toMatch(/brouillon/);
    expect(r.body.avertissement).toMatch(/simulateurs/);
    expect(r.body.outbox).toEqual({ EN_ATTENTE: 0, EN_COURS: 0, ENVOYE: 0, ECHEC: 0, ABANDONNE: 0 });
    const texte = JSON.stringify(r.body);
    expect(texte).not.toContain(JETON_DE_TEST);
    expect(texte).not.toContain("127.0.0.1");
    expect(r.body.configuration.destinations).toHaveLength(3);
  });

  it("GET / sur une configuration vide : toutes les destinations inactives, avec la raison", async () => {
    const r = await request(appSansDestination).get("/api/v2/integrations");
    for (const d of r.body.configuration.destinations) {
      expect(d.actif).toBe(false);
      expect(d.raison).toMatch(/interrupteur general/);
    }
  });

  it("GET /contrats : les trois routes et la liste de ce qui reste a confirmer", async () => {
    const r = await request(app).get("/api/v2/integrations/contrats");
    expect(r.status).toBe(200);
    expect(r.body.routes.map((x: { destination: string }) => x.destination)).toEqual(["DIGITALROAD", "SHAREPOINT", "BDR_L2R"]);
    for (const route of r.body.routes) expect(route.aConfirmer.length).toBeGreaterThanOrEqual(5);
  });

  it("GET /outbox : liste paginee, filtrable, SANS la charge", async () => {
    poser("t-1"); poser("t-2");
    await inscrire("t-1"); await inscrire("t-2");
    const r = await request(app).get("/api/v2/integrations/outbox?pageSize=1&page=2");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(r.body.evenements).toHaveLength(1);
    expect(r.body.evenements[0].chargeCanonique).toBeUndefined();
    expect(r.body.evenements[0].tailleCharge).toBeGreaterThan(100);
    expect((await request(app).get("/api/v2/integrations/outbox?statut=ENVOYE")).body.total).toBe(0);
    expect((await request(app).get("/api/v2/integrations/outbox?destination=SHAREPOINT")).body.total).toBe(0);
  });

  it.each(["?statut=INCONNU", "?destination=ONR", "?pageSize=1000", "?page=0", "?autre=1"])("GET /outbox%s : requete invalide (400)", async (q) => {
    expect((await request(app).get(`/api/v2/integrations/outbox${q}`)).status).toBe(400);
  });

  it("GET /outbox/:id : evenement, tentatives et journal ; la charge seulement sur demande", async () => {
    poser();
    const { body: { evenement } } = await inscrire();
    BDR().programmer({ type: "erreur5xx" });
    await request(app).post(`/api/v2/integrations/outbox/${evenement.id}/rejouer`).send({});
    const r = await request(app).get(`/api/v2/integrations/outbox/${evenement.id}`);
    expect(r.status).toBe(200);
    expect(r.body.evenement.chargeCanonique).toBeUndefined();
    expect(r.body.evenement.charge).toBeUndefined();
    expect(r.body.tentatives).toHaveLength(1);
    expect(r.body.journal.map((j: { after: { transition: string } }) => j.after.transition)).toEqual(["(nouveau)>EN_ATTENTE", "EN_ATTENTE>EN_COURS", "EN_COURS>ECHEC"]);
    const avec = await request(app).get(`/api/v2/integrations/outbox/${evenement.id}?avecCharge=true`);
    expect(avec.body.evenement.charge.type).toBe("FeatureCollection");
    expect(JSON.stringify(avec.body)).not.toContain(JETON_DE_TEST);
  });

  it("GET /outbox/:id : 404 si inconnu, 400 si l'identifiant n'est pas un uuid", async () => {
    expect((await request(app).get("/api/v2/integrations/outbox/3fa85f64-5717-4562-b3fc-2c963f66afa6")).status).toBe(404);
    expect((await request(app).get("/api/v2/integrations/outbox/pas-un-uuid")).status).toBe(400);
  });
});

describe("inscription", () => {
  it("201 pour une source validee, auteur = la session ; 200 et dejaEnregistre au second appel", async () => {
    compte.id = "u-admin-7";
    poser();
    const a = await inscrire();
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ dejaEnregistre: false, evenement: { statut: "EN_ATTENTE", version: 1, creeParId: "u-admin-7" } });
    expect(banc.depot.audits[0]).toMatchObject({ userId: "u-admin-7", action: "CREATE" });
    const ecritures = banc.depot.ecritures();
    const b = await inscrire();
    expect(b.status).toBe(200);
    expect(b.body.dejaEnregistre).toBe(true);
    expect(b.body.evenement.id).toBe(a.body.evenement.id);
    expect(banc.depot.ecritures()).toBe(ecritures);
  });

  it("l'auteur ne peut pas etre impose par le corps (corps strict)", async () => {
    poser();
    const r = await request(app).post("/api/v2/integrations/outbox").send({ destination: "BDR_L2R", sourceType: "Troncon", sourceId: "t-1", creeParId: "u-usurpe" });
    expect(r.status).toBe(400);
    expect(banc.depot.evenements).toHaveLength(0);
  });

  it.each([
    [{ destination: "ONR", sourceType: "Troncon", sourceId: "t-1" }],
    [{ destination: "BDR_L2R", sourceType: "Defaut", sourceId: "t-1" }],
    [{ destination: "BDR_L2R", sourceType: "Troncon", sourceId: "" }],
    [{ destination: "BDR_L2R", sourceType: "Troncon" }],
    [{}],
  ])("corps invalide %j : 400", async (corps) => {
    expect((await request(app).post("/api/v2/integrations/outbox").send(corps)).status).toBe(400);
  });

  it("une source non validee : 409 SOURCE_NON_EMISSIBLE, rien d'ecrit", async () => {
    banc.sources.poser("Troncon", "t-1", { emissible: false, motif: "troncon t-1 au statut A_VALIDER : seul VALIDE est emis" });
    const r = await inscrire();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "SOURCE_NON_EMISSIBLE" });
    expect(banc.depot.evenements).toHaveLength(0);
    expect(banc.depot.audits).toHaveLength(0);
  });

  it("une destination desactivee : 409 DESTINATION_DESACTIVEE, rien d'ecrit", async () => {
    poser();
    const r = await request(appSansDestination).post("/api/v2/integrations/outbox").send({ destination: "BDR_L2R", sourceType: "Troncon", sourceId: "t-1" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("DESTINATION_DESACTIVEE");
    expect(banc.depot.evenements).toHaveLength(0);
  });

  it("une destination qui ne recoit pas cette source : 404 SOURCE_INCONNUE", async () => {
    const r = await request(app).post("/api/v2/integrations/outbox").send({ destination: "SHAREPOINT", sourceType: "Troncon", sourceId: "t-1" });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("SOURCE_INCONNUE");
  });
});

describe("relance, abandon, rejeu", () => {
  async function enEchec() {
    poser();
    const { body } = await inscrire();
    BDR().programmer({ type: "erreur5xx" });
    await request(app).post(`/api/v2/integrations/outbox/${body.evenement.id}/rejouer`).send({});
    return body.evenement.id as string;
  }
  const url = (id: string, action: string) => `/api/v2/integrations/outbox/${id}/${action}`;

  it("relancer : 200, EN_ATTENTE, audite avec l'auteur de la session et le motif", async () => {
    compte.id = "u-admin-9";
    const id = await enEchec();
    const r = await request(app).post(url(id, "relancer")).send({ motif: "service retabli" });
    expect(r.status).toBe(200);
    expect(r.body.evenement).toMatchObject({ statut: "EN_ATTENTE", relances: 1, tentatives: 0 });
    const a = banc.depot.audits.at(-1)!;
    expect(a).toMatchObject({ userId: "u-admin-9", entityId: id });
    expect(a.after).toMatchObject({ transition: "ECHEC>EN_ATTENTE", motif: "service retabli" });
  });

  it.each([{}, { motif: "" }, { motif: "ab" }, { motif: "ok ok", auteur: "x" }])("relancer sans motif valide ou avec une cle inconnue (%j) : 400", async (corps) => {
    const id = await enEchec();
    expect((await request(app).post(url(id, "relancer")).send(corps)).status).toBe(400);
    expect((await request(app).post(url(id, "abandonner")).send(corps)).status).toBe(400);
    expect(banc.depot.evenements[0].statut).toBe("ECHEC");
  });

  it("relancer ou abandonner un evenement ENVOYE : 409 DEJA_ENVOYE, rien d'ecrit", async () => {
    poser();
    const { body } = await inscrire();
    await request(app).post(url(body.evenement.id, "rejouer")).send({});
    expect(banc.depot.evenements[0].statut).toBe("ENVOYE");
    const ecritures = banc.depot.ecritures();
    const a = await request(app).post(url(body.evenement.id, "relancer")).send({ motif: "essai" });
    const b = await request(app).post(url(body.evenement.id, "abandonner")).send({ motif: "essai" });
    expect([a.status, b.status]).toEqual([409, 409]);
    expect([a.body.code, b.body.code]).toEqual(["DEJA_ENVOYE", "DEJA_ENVOYE"]);
    expect(banc.depot.ecritures()).toBe(ecritures);
  });

  it("abandonner avec motif : 200, ABANDONNE, l'evenement reste lisible", async () => {
    const id = await enEchec();
    const r = await request(app).post(url(id, "abandonner")).send({ motif: "donnee remplacee" });
    expect(r.status).toBe(200);
    expect(r.body.evenement.statut).toBe("ABANDONNE");
    expect(r.body.evenement.motifAbandon).toContain("donnee remplacee");
    expect((await request(app).get(`/api/v2/integrations/outbox/${id}`)).status).toBe(200);
  });

  it("evenement inconnu : 404", async () => {
    const inconnu = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect((await request(app).post(url(inconnu, "relancer")).send({ motif: "essai" })).status).toBe(404);
    expect((await request(app).post(url(inconnu, "abandonner")).send({ motif: "essai" })).status).toBe(404);
  });

  it("rejouer un evenement ENVOYE : 200 DEJA_ENVOYE, le simulateur n'est pas contacte, rien n'est ecrit", async () => {
    poser();
    const { body } = await inscrire();
    const premier = await request(app).post(url(body.evenement.id, "rejouer")).send({});
    expect(premier.body).toMatchObject({ traite: true, statut: "ENVOYE" });
    const requetes = BDR().requetes.length;
    const ecritures = banc.depot.ecritures();
    const second = await request(app).post(url(body.evenement.id, "rejouer")).send({});
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ traite: false, id: body.evenement.id, raison: "DEJA_ENVOYE" });
    expect(BDR().requetes).toHaveLength(requetes);
    expect(banc.depot.ecritures()).toBe(ecritures);
  });

  it("traiter : emet les evenements dus, au plus la limite", async () => {
    for (const id of ["t-1", "t-2", "t-3"]) { poser(id); await inscrire(id); }
    const r = await request(app).post("/api/v2/integrations/outbox/traiter").send({ limite: 2 });
    expect(r.status).toBe(200);
    expect(r.body.examines).toBe(2);
    expect(BDR().requetes).toHaveLength(2);
    expect((await request(app).post("/api/v2/integrations/outbox/traiter").send({ limite: 0 })).status).toBe(400);
    expect((await request(app).post("/api/v2/integrations/outbox/traiter").send({ toutes: true })).status).toBe(400);
  });

  it("traiter sur une configuration sans destination active : rien n'est emis", async () => {
    poser();
    await inscrire();
    const r = await request(appSansDestination).post("/api/v2/integrations/outbox/traiter").send({});
    expect(r.status).toBe(200);
    expect(r.body.examines).toBe(0);
    expect(BDR().requetes).toHaveLength(0);
  });
});
