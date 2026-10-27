import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `GET /api/v2/aide-decision/contractuel` et `/contractuel/marches/:id` : ce que ce fichier prouve.
 *
 * Il monte le VRAI routeur, le VRAI `requireAuth` (jeton signe, compte relu par un resolveur injecte), le VRAI
 * `requireModuleAccess`, le VRAI `perimetreDe` et le VRAI service et noyau ; seuls la base (modules, rattachements) et le
 * depot de lignes sont simules. Le depot FAUX rend volontairement TOUS les marches, quelle que soit la pre-selection regionale
 * demandee : c'est l'« oracle ferme » (le noyau, pas le depot, decide de ce qu'un compte regional voit).
 *
 * CE QU'IL NE PROUVE PAS : que le SQL du depot ramene les bonnes lignes, ni qu'il n'ecrit rien. Cela, c'est le banc PostGIS
 * `tests-integration/aide-decision-contractuel.integration.mts`.
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const w = vi.hoisted(() => ({
  comptes: {} as Record<string, { role: string; modules: string[]; regions: number[]; actif: boolean; email: string }>,
  marches: [] as unknown[],
  programmes: [] as unknown[],
  parTroncon: new Map<string, Set<string>>(),
  tronque: false,
  sansMarche: { nombre: 3, surTotal: 40, exemples: [{ id: "cx", intitule: "Chantier orphelin" }] },
  demandes: [] as Record<string, unknown>[],
  demandesChantiers: [] as Record<string, unknown>[],
  requetes: [] as string[],
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const c = w.comptes[where.id];
        return c ? { modulesAutorises: c.modules } : null;
      },
    },
    $queryRaw: async (premier: unknown, ...reste: unknown[]) => {
      const texte = Array.isArray(premier) ? (premier as string[]).join("?") : String(premier);
      w.requetes.push(texte);
      if (texte.includes("perimetres_comptes")) return (w.comptes[String(reste[0])]?.regions ?? []).map((regionId) => ({ regionId }));
      throw new Error(`requete inattendue : ${texte}`);
    },
  },
}));

vi.mock("../aide-decision/contractuel.depot", () => ({
  depotPrisma: {
    async chargerMarches(d: { marcheId?: string; plafond: number } & Record<string, unknown>) {
      w.demandes.push({ ...d });
      const tous = w.marches as { id: string }[];
      const liste = d.marcheId ? tous.filter((m) => m.id === d.marcheId) : tous;
      return { marches: liste.slice(0, d.plafond), tronque: w.tronque, programmes: w.programmes, marchesParTroncon: w.parTroncon };
    },
    async chargerRegions() { return [{ id: 1, nom: "Conakry" }, { id: 2, nom: "Kindia" }, { id: 99, nom: "Non renseigné" }]; },
    async chantiersSansMarche(d: Record<string, unknown>) { w.demandesChantiers.push(d); return w.sansMarche; },
  },
}));

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { errorHandler } from "../middleware/error.middleware";
import { signAccessToken } from "../utils/jwt";
import { aideDecisionContractuelRouter } from "./aide-decision.contractuel.routes";
import { chantier, decompte, jours, lien, marche, troncon } from "../aide-decision/contractuel.testutil";
import { encoderCurseur } from "../aide-decision/contractuel.filtres";

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const U = { admin: ID(901), nat: ID(902), lecteur: ID(903), r1: ID(904), r2: ID(905), sansMarches: ID(906), sansDecision: ID(907), aucunModule: ID(908), inactif: ID(909) };
const M = { r1: ID(1), r2: ID(2), multi: ID(3), nr: ID(4), sans: ID(5), usd: ID(6), absent: ID(99) };
const BASE = "/api/v2/aide-decision/contractuel";
const TOUS = ["marches", "decision"];

function app() {
  const a = express();
  a.use("/api/v2/aide-decision", aideDecisionContractuelRouter);
  a.use(errorHandler);
  return a;
}
const jeton = (id: string) => signAccessToken({ sub: id, role: (w.comptes[id]?.role ?? "LECTEUR") as never, email: "x@ageroute.invalid" });
const lister = (id: string | null, q = "") => {
  const r = request(app()).get(`${BASE}${q}`);
  return id ? r.set("Authorization", `Bearer ${jeton(id)}`) : r;
};
const fiche = (id: string | null, marcheId: string) => {
  const r = request(app()).get(`${BASE}/marches/${marcheId}`);
  return id ? r.set("Authorization", `Bearer ${jeton(id)}`) : r;
};
const intitules = (r: { body: { marches: { intitule: string }[] } }) => r.body.marches.map((m) => m.intitule).sort();

/** Un marche entierement dans une region, avec un tronçon propre. */
function marcheRegion(id: string, intitule: string, region: number, montant: number, extra: Parameters<typeof marche>[0] = {}) {
  return marche({
    id, intitule, montantTotal: BigInt(montant),
    liens: [lien({ chantier: chantier({ id: `c-${id}`, intitule: `Chantier ${intitule}`, regionId: region, tronconId: `t-${id}`, troncon: troncon({ id: `t-${id}`, code: `T-${id.slice(0, 8)}`, regionId: region }) }) })],
    ...extra,
  });
}

beforeEach(() => {
  w.comptes = {
    [U.admin]: { role: "ADMIN", modules: [], regions: [], actif: true, email: "ad@x.invalid" },
    [U.nat]: { role: "GESTIONNAIRE", modules: TOUS, regions: [], actif: true, email: "n@x.invalid" },
    [U.lecteur]: { role: "LECTEUR", modules: TOUS, regions: [], actif: true, email: "l@x.invalid" },
    [U.r1]: { role: "GESTIONNAIRE", modules: TOUS, regions: [1], actif: true, email: "r1@x.invalid" },
    [U.r2]: { role: "GESTIONNAIRE", modules: TOUS, regions: [2], actif: true, email: "r2@x.invalid" },
    [U.sansMarches]: { role: "GESTIONNAIRE", modules: ["decision"], regions: [], actif: true, email: "sm@x.invalid" },
    [U.sansDecision]: { role: "GESTIONNAIRE", modules: ["marches"], regions: [], actif: true, email: "sd@x.invalid" },
    [U.aucunModule]: { role: "GESTIONNAIRE", modules: [], regions: [], actif: true, email: "am@x.invalid" },
    [U.inactif]: { role: "GESTIONNAIRE", modules: TOUS, regions: [], actif: false, email: "in@x.invalid" },
  };
  const multi = marche({
    id: M.multi, intitule: "Marché Multi", montantTotal: BigInt(5_555_555), createdAt: jours(-30),
    decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(777_777) })],
    liens: [
      lien({ chantier: chantier({ id: "c-m1", intitule: "Chantier Chez R1", regionId: 1, tronconId: "t-m1", troncon: troncon({ id: "t-m1", code: "T-M1", regionId: 1 }) }) }),
      lien({ chantier: chantier({ id: "c-m2", intitule: "Chantier Chez R2", regionId: 2, tronconId: "t-m2", troncon: troncon({ id: "t-m2", code: "T-M2", regionId: 2 }) }) }),
    ],
  });
  w.marches = [
    marcheRegion(M.r1, "Marché R1", 1, 1_111_111, { createdAt: jours(-10), decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(300_001) })] }),
    marcheRegion(M.r2, "Marché R2", 2, 2_222_222, { createdAt: jours(-20) }),
    multi,
    marche({ id: M.nr, intitule: "Marché Non Renseigné", montantTotal: BigInt(4_444_444), createdAt: jours(-40), liens: [lien({ chantier: chantier({ id: "c-nr", regionId: 99, tronconId: null, troncon: null }) })] }),
    marche({ id: M.sans, intitule: "Marché Sans Lien", montantTotal: BigInt(6_666_666), createdAt: jours(-50), liens: [] }),
    marcheRegion(M.usd, "Marché USD", 1, 3_333_333, { createdAt: jours(-60), devise: "USD" }),
  ];
  w.programmes = [];
  w.parTroncon = new Map();
  w.tronque = false;
  w.demandes = [];
  w.demandesChantiers = [];
  w.requetes = [];
  _installerResolveurCompte(async (userId) => {
    const c = w.comptes[userId];
    return c ? { actif: c.actif, lockedUntil: null, role: c.role as never, email: c.email } : null;
  });
});

describe("matrice d'acces", () => {
  it("anonyme : 401, la base n'est pas interrogee", async () => {
    const r = await lister(null);
    expect(r.status).toBe(401);
    expect(w.demandes).toHaveLength(0);
    expect((await fiche(null, M.r1)).status).toBe(401);
  });

  it("jeton forge ou compte inactif : 401", async () => {
    expect((await request(app()).get(BASE).set("Authorization", "Bearer abc.def.ghi")).status).toBe(401);
    const r = await lister(U.inactif);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("COMPTE_INACTIF");
    expect(w.demandes).toHaveLength(0);
  });

  it("sans le module `marches` : 403 (liste et fiche), sans le module `decision` : 403, sans aucun module : 403", async () => {
    for (const u of [U.sansMarches, U.sansDecision, U.aucunModule]) {
      expect((await lister(u)).status).toBe(403);
      expect((await fiche(u, M.r1)).status).toBe(403);
    }
    expect(w.demandes).toHaveLength(0);
  });

  it("LECTEUR avec les deux modules : 200, montants rendus (le module `marches` vaut droit financier tant que D-C1-1 est ouverte)", async () => {
    const r = await lister(U.lecteur);
    expect(r.status).toBe(200);
    expect(r.body.droitFinancier).toBe(true);
    expect(r.body.marches.find((m: { id: string }) => m.id === M.r1).montants.contractuel.valeurGnf).toBe("1111111");
  });

  it("ADMIN : 200 sans module configure, tout est visible, le périmètre est national", async () => {
    const r = await lister(U.admin);
    expect(r.status).toBe(200);
    expect(r.body.marches).toHaveLength(6);
    expect(r.body.perimetre).toMatchObject({ national: true, regionIds: null, totalNationalFourni: true });
  });

  it("GESTIONNAIRE national : voit les six marchés ; la pré-sélection du dépôt est nulle", async () => {
    const r = await lister(U.nat);
    expect(r.body.marches).toHaveLength(6);
    expect(w.demandes[0].regions).toBeNull();
  });

  it("réponses en no-store (données financières)", async () => {
    expect((await lister(U.admin)).headers["cache-control"]).toBe("no-store");
    expect((await fiche(U.admin, M.r1)).headers["cache-control"]).toBe("no-store");
  });
});

describe("compte regional : jamais de total national, oracle ferme", () => {
  it("GESTIONNAIRE de la région 1 : voit ses marchés (R1, USD, Multi), ni R2, ni « Non renseigné », ni celui sans territoire", async () => {
    const r = await lister(U.r1);
    expect(r.status).toBe(200);
    expect(intitules(r)).toEqual(["Marché Multi", "Marché R1", "Marché USD"]);
    // le depot a recu la region lue en BASE ; il a pourtant rendu TOUT, et rien n'a fuite
    expect(w.demandes[0].regions).toEqual([1]);
    expect(w.requetes.every((q) => q.includes("perimetres_comptes"))).toBe(true);
  });

  it("le corps ne contient AUCUN montant, intitulé, chantier ni tronçon d'une autre région, ni total national", async () => {
    const r = await lister(U.r1);
    const corps = JSON.stringify(r.body);
    for (const interdit of ["2222222", "4444444", "6666666", "19999998", "Marché R2", "Non Renseigné", "Sans Lien", "Chantier Chez R2", "T-M2", "Kindia"]) {
      expect(corps, interdit).not.toContain(interdit);
    }
    expect(r.body.perimetre).toMatchObject({ national: false, regionIds: [1], totalNationalFourni: false });
    expect(r.body.perimetre.libelle).toMatch(/aucun total national/);
  });

  it("marché multi-régional : visible, mais montants masqués, décomptes absents, chantiers de l'autre région absents", async () => {
    const r = await lister(U.r1);
    const m = r.body.marches.find((x: { id: string }) => x.id === M.multi);
    expect(m.territoire).toMatchObject({ montantsMasques: true, multiRegions: true, regionIds: [1] });
    for (const k of ["contractuel", "engage", "decaisse", "previsionnel"]) expect(m.montants[k]).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "TERRITOIRE" });
    expect(m.liens.chantiers.liste.map((c: { intitule: string }) => c.intitule)).toEqual(["Chantier Chez R1"]);
    expect(m.liens.chantiers.autresRegionsMasquees).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/5555555|777777/);
  });

  it("la synthèse d'un compte régional ne somme que ses marchés visibles et non masqués, et le dit", async () => {
    const r = await lister(U.r1);
    expect(r.body.synthese.marchesRecenses.nombre).toBe(3);
    expect(r.body.synthese.financier.contractuel).toMatchObject({ etat: "PARTIEL", valeurGnf: "1111111", couverture: { pris: 1, total: 3 } });
    expect(r.body.page.total).toBe(3);
  });

  it("les contrôles d'un compte régional portent sur ses marchés ; les chantiers sans marché sont demandés avec SA région", async () => {
    const r = await lister(U.r1);
    expect(r.body.controles.find((c: { code: string }) => c.code === "MARCHE_SANS_CHANTIER").surTotal).toBe(3);
    expect(w.demandesChantiers[0].regions).toEqual([1]);
  });

  it("région demandée hors périmètre : 403 HORS_PERIMETRE avant toute lecture ; dans le périmètre : 200", async () => {
    const hors = await lister(U.r1, "?regionId=2");
    expect(hors.status).toBe(403);
    expect(hors.body.code).toBe("HORS_PERIMETRE");
    expect(w.demandes).toHaveLength(0);
    expect((await lister(U.r1, "?regionId=1")).status).toBe(200);
    expect(w.demandes[0].regions).toEqual([1]);
  });

  it("deux régions : un compte rattaché à 1 et 2 voit R1, R2 et le multi sans masquage", async () => {
    w.comptes[U.r1].regions = [1, 2];
    const r = await lister(U.r1);
    expect(intitules(r)).toEqual(["Marché Multi", "Marché R1", "Marché R2", "Marché USD"]);
    expect(r.body.marches.find((x: { id: string }) => x.id === M.multi).montants.contractuel.valeurGnf).toBe("5555555");
  });

  it("filtre `regionId` d'un compte national : la pré-sélection est cette région et seuls les marchés qui la touchent sortent", async () => {
    const r = await lister(U.nat, "?regionId=2");
    expect(w.demandes[0].regions).toEqual([2]);
    expect(intitules(r)).toEqual(["Marché Multi", "Marché R2"]);
  });

  it("un marché dont l'unique territoire est « Non renseigné » n'est visible que d'un national", async () => {
    w.comptes[U.r1].regions = [99];
    expect((await lister(U.r1)).body.marches).toHaveLength(0);
    expect(intitules(await lister(U.nat))).toContain("Marché Non Renseigné");
  });
});

describe("fiche d'un marche et 404 identique", () => {
  it("ADMIN lit n'importe quelle fiche ; décomptes listés avec leur statut et ce qui compte dans le décaissé", async () => {
    const r = await fiche(U.admin, M.r1);
    expect(r.status).toBe(200);
    expect(r.body.marche.id).toBe(M.r1);
    expect(r.body.decomptes.liste).toEqual([expect.objectContaining({ numero: 1, statut: "PAYE", montantGnf: "300001", compteDansDecaisse: true })]);
  });

  it("inexistant, mal formé, hors périmètre : UNE réponse, au même corps (aucun oracle d'existence)", async () => {
    const inconnu = await fiche(U.r1, M.absent);
    const malForme = await fiche(U.r1, "pas-un-uuid");
    const horsPerimetre = await fiche(U.r1, M.r2);
    const sansTerritoire = await fiche(U.r1, M.sans);
    for (const r of [inconnu, malForme, horsPerimetre, sansTerritoire]) expect(r.status).toBe(404);
    expect(malForme.body).toEqual(inconnu.body);
    expect(horsPerimetre.body).toEqual(inconnu.body);
    expect(sansTerritoire.body).toEqual(inconnu.body);
    expect(JSON.stringify(horsPerimetre.body)).not.toContain("Marché R2");
  });

  it("fiche d'un marché multi-régional pour un compte régional : montants et décomptes masqués", async () => {
    const r = await fiche(U.r1, M.multi);
    expect(r.status).toBe(200);
    expect(r.body.decomptes.liste[0].montantGnf).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/5555555|777777/);
  });

  it("injection dans l'identifiant : 404, sans lecture", async () => {
    const r = await fiche(U.admin, "1%27%20OR%201=1--");
    expect(r.status).toBe(404);
    expect(w.demandes).toHaveLength(0);
  });
});

describe("entrees hostiles : 400 avant la base", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const HOSTILES = [
    "regionId=abc", "regionId=1&regionId=2", "regionId=-1", "regionId=0", "regionId=1e3", "regionId=99999999999", "regionId=2147483648", "regionId=%00", "regionId=1%3BDROP", "regionId=",
    "classe=XX", "classe[a]=b", "classe=RN,,XX", "classe=RN,RR,RU,PISTE,NON_CLASSEE,RN,RR,RU,PISTE,NON_CLASSEE,RN", "etat=ENORME", "statutChantier=ACTIF", "statutMarche=ACTIF", "bailleurId=x", "bailleurId=0",
    "depuis=2026-02-30", "depuis=hier", "jusqua=2026-13-01", "depuis=2026-10-01&jusqua=2026-01-01",
    "limite=0", "limite=101", "limite=abc", "limite=1.5", "limite=-3", "limite=1&limite=2",
    "curseur=!!!", `curseur=${"a".repeat(301)}`, `curseur=${b64('{"c":"x","i":"y"}')}`, `curseur=${b64("pas du json")}`, `curseur=${b64(JSON.stringify({ c: "2026-10-01T00:00:00.000Z", i: "'; DROP TABLE marches;--" }))}`,
  ];
  it.each(HOSTILES)("%s : 400 PARAMETRES_INVALIDES, aucune lecture", async (q) => {
    for (const u of [U.admin, U.r1]) {
      const r = await lister(u, `?${q}`);
      expect(r.status, `${u} ${q}`).toBe(400);
      expect(r.body.code).toBe("PARAMETRES_INVALIDES");
    }
    expect(w.demandes).toHaveLength(0);
  });

  it("une cle inconnue (filtre d'un autre onglet) est ignorée : 200", async () => {
    expect((await lister(U.admin, "?bailleur=BAD&axe=RN1&prefecture=Kindia")).status).toBe(200);
  });

  it("valeurs valides sous toutes leurs formes : listes séparées par des virgules ou répétées", async () => {
    expect((await lister(U.admin, "?classe=RN,RR&etat=BON&etat=MOYEN&statutMarche=EN_COURS,PLANIFIE&statutChantier=EN_COURS&depuis=2026-01-01&jusqua=2026-12-31&bailleurId=1&limite=10")).status).toBe(200);
  });
});

describe("pagination par curseur", () => {
  function beaucoup() {
    // 7 marches, dont deux au MEME instant de creation (le curseur departage par identifiant)
    w.marches = Array.from({ length: 7 }, (_, i) => marcheRegion(ID(100 + i), `Marché ${i}`, 1, 1000 + i, { createdAt: jours(i === 4 ? -3 : -i) }));
  }

  it("parcourt tout sans doublon ni saut, y compris deux marchés au même instant, et le total reste constant", async () => {
    beaucoup();
    const vus: string[] = [];
    let curseur: string | null = null;
    let pages = 0;
    do {
      const r: request.Response = await lister(U.admin, `?limite=3${curseur ? `&curseur=${curseur}` : ""}`);
      expect(r.status).toBe(200);
      expect(r.body.page.total).toBe(7);
      vus.push(...r.body.marches.map((m: { id: string }) => m.id));
      curseur = r.body.page.curseurSuivant;
      pages += 1;
    } while (curseur && pages < 10);
    expect(pages).toBe(3);
    expect(vus).toHaveLength(7);
    expect(new Set(vus).size).toBe(7);
    expect(vus.sort()).toEqual(w.marches.map((m) => (m as { id: string }).id).sort());
  });

  it("tri : plus récent d'abord, identifiant en départage", async () => {
    beaucoup();
    const r = await lister(U.admin, "?limite=100");
    // 100, 101, 102 (de plus en plus anciens), puis 103 et 104 au meme instant (identifiant croissant), puis 105, 106
    expect(r.body.marches.map((m: { id: string }) => m.id)).toEqual([100, 101, 102, 103, 104, 105, 106].map(ID));
    expect(r.body.page.curseurSuivant).toBeNull();
  });

  it("un curseur qui ne désigne plus rien (tout est avant lui) rend une page vide, pas la première page", async () => {
    beaucoup();
    const r = await lister(U.admin, `?curseur=${encoderCurseur({ c: "1999-01-01T00:00:00.000Z", i: ID(1) })}`);
    expect(r.status).toBe(200);
    expect(r.body.marches).toEqual([]);
    expect(r.body.page.curseurSuivant).toBeNull();
  });

  it("limite par défaut 25, maximum 100", async () => {
    expect((await lister(U.admin)).body.page.limite).toBe(25);
    expect((await lister(U.admin, "?limite=100")).body.page.limite).toBe(100);
  });
});

describe("contenu : separations du cahier tenues de bout en bout", () => {
  it("chaque marché : engagé NON_DISPONIBLE, constaté NON_DISPONIBLE, jamais 0, copie gelée dite", async () => {
    const r = await lister(U.admin);
    for (const m of r.body.marches) {
      expect(m.montants.engage).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null });
      expect(m.avancement.constate).toMatchObject({ etat: "NON_DISPONIBLE", valeurPct: null });
      expect(m.lots.etat).toBe("NON_DISPONIBLE");
      expect(m.retard.avertissements.join(" ")).toMatch(/Avenants et suspensions ignorés/);
    }
    expect(r.body.source).toMatchObject({ integree: false, copieGelee: true, sourceDeVerite: "DigitalRoad", derniereSynchronisation: null });
    expect(r.body.donneesPartielles.partiel).toBe(true);
    expect(r.body.donneesPartielles.message).toMatch(/non intégrée \(DigitalRoad\)/);
    expect(r.body.synthese.marchesRecenses.libelle).toBe("Marchés recensés");
    expect(r.body.synthese.financier.engage).toMatchObject({ etat: "NON_DISPONIBLE", valeurGnf: null });
  });

  it("agrégat national : contractuel en GNF sans le marché en USD, qui est dans « autres devises »", async () => {
    const r = await lister(U.admin);
    expect(r.body.synthese.financier.contractuel).toMatchObject({ valeurGnf: "19999998", etat: "PARTIEL", couverture: { pris: 5, total: 6 } });
    expect(r.body.synthese.totauxParBailleur[0].autresDevises).toEqual([{ devise: "USD", montant: "3333333", nombre: 1 }]);
  });

  it("contrôles : les relations manquantes sont comptées (marché sans chantier, chantier sans tronçon) et les chantiers sans marché viennent du dépôt", async () => {
    const r = await lister(U.admin);
    const par = Object.fromEntries(r.body.controles.map((c: { code: string }) => [c.code, c]));
    expect(par.MARCHE_SANS_CHANTIER.nombre).toBe(1);
    expect(par.CHANTIER_SANS_TRONCON.nombre).toBe(1);
    expect(par.CHANTIER_SANS_MARCHE).toMatchObject({ nombre: 3, surTotal: 40 });
    expect(par.MARCHE_SANS_CHANTIER.exemples[0]).toMatchObject({ type: "marche", id: M.sans });
  });

  it("filtres appliqués : statut de marché, bailleur, période", async () => {
    w.marches = [
      marcheRegion(ID(201), "Planifié 2026", 1, 10, { statut: "PLANIFIE", dateDebutPrevue: new Date("2026-01-01"), dateFinPrevue: new Date("2026-06-30") }),
      marcheRegion(ID(202), "En cours autre bailleur", 1, 10, { statut: "EN_COURS", bailleurId: 2, bailleurNom: "BM", dateDebutPrevue: new Date("2025-01-01"), dateFinPrevue: new Date("2025-06-30") }),
      marcheRegion(ID(203), "Sans date", 1, 10),
    ];
    expect(intitules(await lister(U.admin, "?statutMarche=PLANIFIE"))).toEqual(["Planifié 2026"]);
    expect(intitules(await lister(U.admin, "?bailleurId=2"))).toEqual(["En cours autre bailleur"]);
    const periode = await lister(U.admin, "?depuis=2026-03-01&jusqua=2026-12-31");
    expect(intitules(periode)).toEqual(["Planifié 2026"]);
    expect(periode.body.perimetre.exclusParFiltre).toEqual({ sansDate: 1 });
  });

  it("plafond atteint : la troncature est dite dans les données partielles", async () => {
    w.tronque = true;
    const r = await lister(U.admin);
    expect(r.body.plafond.tronque).toBe(true);
    expect(r.body.donneesPartielles.raisons.join(" ")).toMatch(/Plus de 2000 marchés/);
  });

  it("fraîcheur : la copie est dite gelée, avec la date de dernière mise à jour", async () => {
    const r = await lister(U.admin);
    expect(r.body.fraicheur).toMatchObject({ gelee: true, derniereSynchronisation: null, statutSeuil: "PROVISOIRE" });
    expect(typeof r.body.fraicheur.derniereMiseAJour).toBe("string");
  });

  it("erreur du dépôt : 500 du gestionnaire d'erreurs, pas de corps partiel", async () => {
    const depot = (await import("../aide-decision/contractuel.depot")).depotPrisma;
    const original = depot.chargerMarches;
    depot.chargerMarches = async () => { throw new Error("base indisponible"); };
    try {
      const r = await lister(U.admin);
      expect(r.status).toBe(500);
      expect(r.body.marches).toBeUndefined();
    } finally { depot.chargerMarches = original; }
  });
});
