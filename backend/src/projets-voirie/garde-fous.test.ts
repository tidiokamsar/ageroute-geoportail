import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { Budget, avecErreurDelai, estDelaiDepasse } from "./bd";
import { delaiAnalyseMs, delaiCarteMs, delaiDepotMs, delaiVerrouMs, sommetsParFichierMax, sommetsParObjetMax } from "./config";
import { ErreurMetier } from "./erreurs";
import { ErreurLecture, lireFichier } from "./lecture.noyau";
import { RECEPTIONS_PAR_COMPTE_MAX, etatReceptions, reserverReception } from "./limiteurs";
import { ServiceOccupe } from "../import/limiteur";

/**
 * Garde-fous du module (revue de securite, M2, m4) : reglages bornes, plafonds de sommets, delais cote base, limiteurs. Sans base ;
 * le delai reel (`statement_timeout` qui coupe une requete lente) est prouve par le banc PostGIS.
 */
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("reglages par variable d'environnement : bornes et defauts", () => {
  it("defauts : analyse 20 s, carte 10 s, depot 60 s, verrou 5 s, 100 000 sommets par objet, 2 000 000 par fichier", () => {
    expect([delaiAnalyseMs(), delaiCarteMs(), delaiDepotMs(), delaiVerrouMs(), sommetsParObjetMax(), sommetsParFichierMax()])
      .toEqual([20_000, 10_000, 60_000, 5_000, 100_000, 2_000_000]);
  });

  it("une valeur valide est prise en compte", () => {
    vi.stubEnv("PROJETS_VOIRIE_DELAI_ANALYSE_MS", "45000");
    vi.stubEnv("PROJETS_VOIRIE_SOMMETS_PAR_OBJET", "5000");
    expect(delaiAnalyseMs()).toBe(45_000);
    expect(sommetsParObjetMax()).toBe(5_000);
  });

  it("une valeur hors bornes, illisible, vide, decimale ou negative redonne le defaut (un delai ne peut etre ni supprime ni absurde)", () => {
    for (const v of ["0", "-5", "abc", "", " ", "1.5", "999999999", "NaN", "Infinity"]) {
      vi.stubEnv("PROJETS_VOIRIE_DELAI_ANALYSE_MS", v);
      expect(delaiAnalyseMs(), v).toBe(20_000);
      vi.stubEnv("PROJETS_VOIRIE_SOMMETS_PAR_FICHIER", v);
      expect(sommetsParFichierMax(), v).toBe(2_000_000);
    }
  });
});

describe("plafonds de sommets (TROP_DE_SOMMETS)", () => {
  const ligne = (n: number) => Array.from({ length: n }, (_, i) => [-10.5 + i * 1e-6, 9.2]);
  const geojson = (...lignes: number[][][]) => Buffer.from(JSON.stringify({
    type: "FeatureCollection",
    features: lignes.map((c, i) => ({ type: "Feature", properties: { name: `l${i}` }, geometry: { type: "LineString", coordinates: c } })),
  }));

  it("un objet de plus que le plafond par objet est refuse", () => {
    expect(() => lireFichier(geojson(ligne(1_001)), "a.geojson", { sommetsParObjet: 1_000 })).toThrowError(ErreurLecture);
    try { lireFichier(geojson(ligne(1_001)), "a.geojson", { sommetsParObjet: 1_000 }); } catch (e) {
      expect((e as ErreurLecture).code).toBe("TROP_DE_SOMMETS");
      expect((e as Error).message).toContain("1001");
    }
    expect(lireFichier(geojson(ligne(1_000)), "a.geojson", { sommetsParObjet: 1_000 }).resume.nbObjets).toBe(1);
  });

  it("le plafond par fichier cumule les objets", () => {
    const fichier = geojson(ligne(600), ligne(600), ligne(600));
    expect(() => lireFichier(fichier, "a.geojson", { sommetsParObjet: 1_000, sommetsParFichier: 1_500 })).toThrowError(/depasse 1500 sommets/);
    expect(lireFichier(fichier, "a.geojson", { sommetsParObjet: 1_000, sommetsParFichier: 1_800 }).resume.nbObjets).toBe(3);
  });

  it("les defauts sont ceux du contrat (100 000 par objet) : 100 001 sommets sont refuses, sans construire quoi que ce soit", () => {
    let code = "";
    try { lireFichier(geojson(ligne(100_001)), "a.geojson"); } catch (e) { code = (e as ErreurLecture).code; }
    expect(code).toBe("TROP_DE_SOMMETS");
  });

  it("KML : le plafond s'applique aussi, y compris sur un MultiGeometry (somme des membres)", () => {
    const l = (n: number) => `<LineString><coordinates>${ligne(n).map(([x, y]) => `${x},${y}`).join(" ")}</coordinates></LineString>`;
    const kml = Buffer.from(`<kml><Document><Placemark><MultiGeometry>${l(600)}${l(600)}</MultiGeometry></Placemark></Document></kml>`);
    expect(() => lireFichier(kml, "a.kml", { sommetsParObjet: 1_000 })).toThrowError(/1200 sommets/);
  });
});

describe("delais cote base", () => {
  it("reconnait l'annulation par statement_timeout (57014) et par lock_timeout (55P03), pas les autres erreurs", () => {
    const erreurPrisma = (code: string) => new Prisma.PrismaClientKnownRequestError("Raw query failed", { code: "P2010", clientVersion: "5", meta: { code } });
    expect(estDelaiDepasse(erreurPrisma("57014"))).toBe(true);
    expect(estDelaiDepasse(erreurPrisma("55P03"))).toBe(true);
    expect(estDelaiDepasse(erreurPrisma("23505"))).toBe(false);
    expect(estDelaiDepasse(new Error("ERROR: canceling statement due to statement timeout"))).toBe(true);
    expect(estDelaiDepasse(new Error("could not obtain lock on row: lock timeout"))).toBe(true);
    expect(estDelaiDepasse(new Error("connexion refusee"))).toBe(false);
    expect(estDelaiDepasse("chaine")).toBe(false);
  });

  it("avecErreurDelai : un delai depasse devient l'erreur typee 504 ; une erreur metier et toute autre erreur passent telles quelles", async () => {
    const attendu = await avecErreurDelai("ANALYSE_TROP_LONGUE", "trop long", async () => { throw new Error("canceling statement due to statement timeout"); }).catch((e) => e);
    expect(attendu).toBeInstanceOf(ErreurMetier);
    expect(attendu).toMatchObject({ status: 504, code: "ANALYSE_TROP_LONGUE", message: "trop long" });
    const metier = new ErreurMetier(422, "X", "x");
    expect(await avecErreurDelai("A", "a", async () => { throw metier; }).catch((e) => e)).toBe(metier);
    expect((await avecErreurDelai("A", "a", async () => { throw new Error("autre"); }).catch((e) => e)).message).toBe("autre");
    expect(await avecErreurDelai("A", "a", async () => 42)).toBe(42);
  });

  it("Budget : chaque etape recoit ce qui reste du budget en statement_timeout ; budget epuise = erreur", async () => {
    vi.useFakeTimers();
    const delais: string[] = [];
    const tx = { $queryRaw: vi.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => { delais.push(String(v[0])); return []; }) };
    const budget = new Budget(tx as never, 10_000, 5_000, () => new ErreurMetier(504, "TROP_LONG", "x"));
    await budget.etape(async () => 1);
    vi.advanceTimersByTime(4_000);
    await budget.etape(async () => 2);
    expect(delais).toEqual(["10000", "6000"]);
    vi.advanceTimersByTime(6_000);
    await expect(budget.etape(async () => 3)).rejects.toMatchObject({ code: "TROP_LONG", status: 504 });
  });
});

describe("limiteur de receptions de fichiers (m4)", () => {
  it(`${RECEPTIONS_PAR_COMPTE_MAX} receptions simultanees par compte au plus : la troisieme est refusee, la liberation rend la place`, async () => {
    const a = await reserverReception("compte-A");
    const b = await reserverReception("compte-A");
    await expect(reserverReception("compte-A")).rejects.toBeInstanceOf(ServiceOccupe);
    a();
    a(); // idempotente
    const c = await reserverReception("compte-A");
    // Un autre compte n'est pas gene.
    const autre = await reserverReception("compte-B");
    for (const l of [b, c, autre]) l();
    await new Promise((r) => setImmediate(r));
    expect(etatReceptions().comptes).toBe(0);
    expect(etatReceptions().global.actifs).toBe(0);
  });

  it("4 receptions au plus pour tout le processus : la cinquieme attend puis recoit SERVICE_OCCUPE (503)", async () => {
    vi.useFakeTimers();
    const liberer = [];
    for (const compte of ["c1", "c2", "c3", "c4"]) liberer.push(await reserverReception(compte));
    const cinquieme = reserverReception("c5");
    const resultat = cinquieme.catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const e = await resultat;
    expect(e).toBeInstanceOf(ServiceOccupe);
    expect((e as ServiceOccupe).code).toBe("SERVICE_OCCUPE");
    // Le compte refuse n'a pas garde de place.
    expect(etatReceptions().comptes).toBe(4);
    for (const l of liberer) l();
    expect(etatReceptions().comptes).toBe(0);
  });
});
