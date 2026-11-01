import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORPS_404_REEL, DETAIL_REEL_ECR1, DETAIL_REEL_ECR2, DETAIL_REEL_ECR3, LISTE_REELLE, LISTE_REELLE_AUTRE_AGENT, LISTE_REELLE_FILTREE,
} from "./roulageEnvoyes.reel.fixture";

/**
 * Le client des releves envoyes : ce que ces tests defendent.
 *   - les parametres de requete suivent le contrat (`limite`, `curseur`, `userId`, `depuis`, `jusqua`) et un filtre vide n'est pas envoye ;
 *   - une reponse qui n'a pas la forme du contrat est une ERREUR (`ReponseIllisible`), jamais une liste vide ;
 *   - les REPONSES REELLES du serveur (roulageEnvoyes.reel.fixture.ts, capturees sur l'API lancee contre PostGIS) sont lues sans erreur,
 *     champs additifs compris, et leurs valeurs ne sont ni modifiees ni inventees ;
 *   - l'identifiant du detail est place dans l'adresse sans pouvoir en sortir.
 * Les cas d'ERREUR de forme ci-dessous sont des variantes fabriquees a la main d'une reponse reelle (un champ casse a la fois) ; l'appel
 * HTTP lui-meme est simule au niveau de l'api (le navigateur reel est verifie a part, voir docs/roulage/CONSULTATION.md, « Integration »).
 */

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./api", () => ({ api: h }));

import { chargerDetailReleve, chargerPageReleves, lireDetailReleve, lirePageReleves, parametresListe, ReponseIllisible, TAILLE_PAGE } from "./roulageEnvoyes";

const copie = <T>(v: T): T => structuredClone(v);
const premier = () => copie(LISTE_REELLE.items[1]);

// Accolades : un `beforeEach` qui RENVOIE le mock (une fonction) le ferait appeler comme nettoyage apres le test, et rejouer l'erreur simulee.
beforeEach(() => { h.get.mockReset(); });

describe("parametresListe", () => {
  it("n'envoie que la limite quand rien n'est filtre", () => {
    expect(parametresListe({ depuis: null, jusqua: null, userId: "" }, null)).toEqual({ limite: TAILLE_PAGE });
  });
  it("envoie curseur, agent et periode (instants ISO avec fuseau, acceptes par le serveur reel) quand ils existent", () => {
    expect(parametresListe({ depuis: "2026-10-24T00:00:00.000Z", jusqua: "2026-10-24T23:59:59.999Z", userId: "u1" }, "c2", 10)).toEqual({
      limite: 10, curseur: "c2", userId: "u1", depuis: "2026-10-24T00:00:00.000Z", jusqua: "2026-10-24T23:59:59.999Z",
    });
  });
  it("la taille de page reste dans les bornes du contrat (1 a 100)", () => {
    expect(TAILLE_PAGE).toBeGreaterThanOrEqual(1);
    expect(TAILLE_PAGE).toBeLessThanOrEqual(100);
  });
});

describe("lirePageReleves : reponses reelles", () => {
  it("lit la liste reelle de trois releves, dans l'ordre du serveur, sans rien changer", () => {
    const p = lirePageReleves(LISTE_REELLE);
    expect(p.total).toBe(3);
    expect(p.suivant).toBeNull();
    expect(p.items.map((i) => i.debutA)).toEqual(["2026-10-25T09:00:00.000Z", "2026-10-24T08:00:00.000Z", "2026-10-23T06:00:00.000Z"]);
    expect(p.items).toEqual(LISTE_REELLE.items);
  });
  it("le taux reel est entre 0 et 1 (0 sur ECR-2 et ECR-3 hors reseau, 1 sur ECR-1), et la distance est celle de l'analyse", () => {
    const [ecr2, ecr1, ecr3] = lirePageReleves(LISTE_REELLE).items;
    expect([ecr2.tauxRattachement, ecr1.tauxRattachement, ecr3.tauxRattachement]).toEqual([0, 1, 0]);
    expect([ecr2.longueurM, ecr1.longueurM, ecr3.longueurM]).toEqual([878, 2797, 18921]);
    expect(ecr1.nbTronconsTraverses).toBe(2);
  });
  it("lit la liste vide reelle d'un autre agent (200, total 0) : c'est une liste vide, pas une erreur", () => {
    expect(lirePageReleves(LISTE_REELLE_AUTRE_AGENT)).toEqual({ items: [], suivant: null, total: 0 });
  });
  it("lit la liste reelle filtree par instants ISO", () => {
    expect(lirePageReleves(LISTE_REELLE_FILTREE).total).toBe(1);
  });
});

describe("lirePageReleves : formes refusees", () => {
  it("accepte un taux null (non evalue)", () => {
    const p = lirePageReleves({ items: [{ ...premier(), tauxRattachement: null, longueurM: null }], suivant: null, total: 1 });
    expect(p.items[0].tauxRattachement).toBeNull();
  });
  it.each([
    ["rien", undefined],
    ["une liste au lieu d'un objet", []],
    ["items absent", { suivant: null, total: 0 }],
    ["total absent", { items: [], suivant: null }],
    ["suivant absent", { items: [], total: 0 }],
    ["un relevé sans agent", { items: [{ ...premier(), agent: null }], suivant: null, total: 1 }],
    ["un relevé sans durée", { items: [{ ...premier(), dureeS: "12" }], suivant: null, total: 1 }],
    ["un taux en texte", { items: [{ ...premier(), tauxRattachement: "0.8" }], suivant: null, total: 1 }],
  ])("refuse %s : c'est une erreur, pas une liste vide", (_nom, brut) => {
    expect(() => lirePageReleves(brut)).toThrow(ReponseIllisible);
  });
});

describe("lireDetailReleve : reponses reelles", () => {
  it("lit le detail reel ECR-1 (sur le reseau) : reperes rattaches avec troncon et abscisse, portions avec leur identifiant", () => {
    const d = lireDetailReleve(DETAIL_REEL_ECR1);
    expect(d.marqueurs).toHaveLength(2);
    expect(d.marqueurs[0]).toMatchObject({
      code: "NID_DE_POULE", statut: "RATTACHE", sourcePosition: "TRACE", motif: null, tronconId: "t-ecr-1", tronconCode: "ECR-1", abscisseM: 600.1,
      lat: 9.64, lon: -13.594532909496058, positionPerimee: false,
    });
    expect(d.evenements).toHaveLength(2);
    expect(d.evenements[1].portions.map((p) => [p.rang, p.tronconCode, p.debutM, p.finM, p.sens])).toEqual([
      [0, "ECR-1", 1300.1, 1480.1, "CROISSANT"], [1, "ECR-2", 0, 300, "CROISSANT"],
    ]);
    expect(d.evenements[1].portions[0].portionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.evenements[0]).toMatchObject({ statutRattachement: "PORTIONS_CREEES", motif: null, qualification: { etat: "MAUVAIS" } });
  });
  it("lit l'analyse reelle : blocs de l'appareil, analyse du serveur (indicateurs, avertissements), seuils et provenance", () => {
    const d = lireDetailReleve(DETAIL_REEL_ECR1);
    expect(d.analyse.trous).toEqual([]);
    expect(d.analyse.compteurs).toEqual({ rejets: {}, alertes: 0, sansPrecision: 0 });
    const serveur = d.analyse.serveur as { indicateurs: Record<string, number>; avertissements: string[] };
    expect(serveur.indicateurs).toMatchObject({ pointsRecus: 281, pointsRetenus: 141, pointsRattaches: 141, distanceParcourueM: 2797, tauxRattachement: 1 });
    expect(serveur.avertissements).toHaveLength(2);
    expect(d.parametres).toMatchObject({ provenance: "PROVISOIRE_NON_CALIBRE", versionContrat: 1 });
    expect(d.parametres.seuils).toMatchObject({ trouMs: 5000, precisionMaxM: 50 });
    expect(d.trace).toEqual({ nbPoints: 281, pointsDisponibles: true });
  });
  it("lit le detail reel ECR-2 (hors reseau) : repere et segment NON rattaches avec leur motif, sans troncon ni portion", () => {
    const d = lireDetailReleve(DETAIL_REEL_ECR2);
    expect(d.marqueurs[0]).toMatchObject({ statut: "NON_RATTACHE", motif: "AUCUN_POINT_RATTACHE_A_PROXIMITE", tronconId: null, tronconCode: null, abscisseM: null });
    expect(d.evenements[0]).toMatchObject({ statutRattachement: "NON_RATTACHE", motif: "AUCUN_POINT_RATTACHE_AU_DEBUT", portions: [], qualification: null });
    expect(d.tauxRattachement).toBe(0);
  });
  it("lit le detail reel ECR-3 (25 000 positions) : geometrie simplifiee, aucun repere ni segment", () => {
    const d = lireDetailReleve(DETAIL_REEL_ECR3);
    expect(d.simplifiee).toBe(true);
    expect(d.nbPoints).toBe(25_000);
    expect(d.marqueurs).toEqual([]);
    expect(d.evenements).toEqual([]);
    expect(d.geometrie?.type).toBe("MultiLineString");
  });
  it("ne change aucune valeur du serveur", () => {
    for (const reel of [DETAIL_REEL_ECR1, DETAIL_REEL_ECR2, DETAIL_REEL_ECR3]) expect(lireDetailReleve(reel)).toEqual(reel);
  });
});

describe("lireDetailReleve : champs additifs et formes refusees", () => {
  it("un serveur qui n'envoie pas encore les champs additifs donne `null`, jamais une erreur", () => {
    const ancien = copie(DETAIL_REEL_ECR1) as unknown as Record<string, unknown> & { marqueurs: Record<string, unknown>[]; evenements: { portions: Record<string, unknown>[] }[] };
    for (const m of ancien.marqueurs) { delete m.sourcePosition; delete m.motif; delete m.tronconId; delete m.tronconCode; delete m.abscisseM; }
    for (const e of ancien.evenements) { delete (e as Record<string, unknown>).motif; for (const p of e.portions) delete p.portionId; }
    const analyse = ancien.analyse as Record<string, unknown>;
    delete analyse.serveur;
    delete (ancien.parametres as Record<string, unknown>).seuils;
    const d = lireDetailReleve(ancien);
    expect(d.marqueurs[0]).toMatchObject({ sourcePosition: null, motif: null, tronconId: null, tronconCode: null, abscisseM: null });
    expect(d.evenements[0].motif).toBeNull();
    expect(d.evenements[1].portions[0].portionId).toBeNull();
    expect(d.analyse.serveur).toBeNull();
    expect(d.parametres.seuils).toBeNull();
  });
  it.each([
    ["marqueurs absents", { marqueurs: undefined }],
    ["evenements absents", { evenements: "x" }],
    ["analyse absente", { analyse: null }],
    ["simplifiee absent", { simplifiee: undefined }],
    ["geometrie sans coordonnees", { geometrie: { type: "MultiLineString" } }],
    ["trace sans booleen pointsDisponibles (un nombre n'est pas le contrat)", { trace: { nbPoints: 281, pointsDisponibles: 120 } }],
    ["trace sans nbPoints", { trace: { pointsDisponibles: true } }],
    ["parametres absents", { parametres: undefined }],
    ["un repere dont la latitude est un texte", { marqueurs: [{ ...DETAIL_REEL_ECR1.marqueurs[0], lat: "9.6" }] }],
    ["un repere sans heure de pose", { marqueurs: [{ ...DETAIL_REEL_ECR1.marqueurs[0], poseA: "" }] }],
    ["un repere dont positionPerimee n'est pas un booleen", { marqueurs: [{ ...DETAIL_REEL_ECR1.marqueurs[0], positionPerimee: "non" }] }],
    ["un segment sans liste de portions", { evenements: [{ ...DETAIL_REEL_ECR1.evenements[0], portions: undefined }] }],
    ["une portion sans troncon", { evenements: [{ ...DETAIL_REEL_ECR1.evenements[0], portions: [{ rang: 0 }] }] }],
    ["un segment dont la qualification est une liste", { evenements: [{ ...DETAIL_REEL_ECR1.evenements[0], qualification: ["x"] }] }],
    ["resume invalide", { id: "" }],
  ])("refuse %s", (_nom, sur) => {
    expect(() => lireDetailReleve({ ...copie(DETAIL_REEL_ECR1), ...sur })).toThrow(ReponseIllisible);
  });
});

describe("appels", () => {
  it("la liste interroge /v2/roulage/sessions avec les parametres", async () => {
    h.get.mockResolvedValue({ data: { ...LISTE_REELLE, suivant: "c2", total: 40 } });
    const p = await chargerPageReleves({ limite: 25 });
    expect(h.get).toHaveBeenCalledWith("/v2/roulage/sessions", { params: { limite: 25 } });
    expect(p.suivant).toBe("c2");
  });
  it("une reponse illisible fait echouer l'appel", async () => {
    h.get.mockResolvedValue({ data: "<html>proxy</html>" });
    await expect(chargerPageReleves({ limite: 25 })).rejects.toBeInstanceOf(ReponseIllisible);
  });
  it("le detail encode l'identifiant dans l'adresse", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    await chargerDetailReleve("a/b ?c");
    expect(h.get).toHaveBeenCalledWith("/v2/roulage/sessions/a%2Fb%20%3Fc");
  });
  it("un 404 reel (corps `RELEVE_INTROUVABLE`) fait echouer l'appel avec l'erreur d'origine, que l'ecran classe par son statut", async () => {
    const erreur = Object.assign(new Error("HTTP 404"), { response: { status: 404, data: CORPS_404_REEL } });
    h.get.mockRejectedValue(erreur);
    await expect(chargerDetailReleve("00000001-0000-4000-8000-000000000009")).rejects.toBe(erreur);
  });
});
