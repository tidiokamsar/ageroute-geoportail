import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { LIMITES_COUCHE_DEFAUT, ErreurSortie, ValidateurCouche } from "./sortie.noyau";
import {
  copierEntree, disponibiliteSpool, entreeExiste, lireCoucheVersValidateur, lireResultatBrut, lireStatutSpool, ouvrirSpool, publierDemande, purger, stagerEntree, type Spool,
} from "./spool";
import { DEUX_AXES, resultatValide, texteCouche } from "./fixtures.gdal";

/** Protocole de spool (lot B2) : le conteneur est un ecrivain NON FIABLE de sortie/ ; aucune lecture hors du dossier du job, aucune erreur avec un chemin. */

const racine = mkdtempSync(path.join(tmpdir(), "b2-spool-"));
const s: Spool = ouvrirSpool(racine);
const ID = "123e4567-e89b-42d3-a456-426614174000-t1";
const ID2 = "123e4567-e89b-42d3-a456-426614174000-t2";
const LIM = { sommetsParObjet: 100_000, sommetsParFichier: 2_000_000, objetsMax: 50_000, ...LIMITES_COUCHE_DEFAUT };

beforeEach(() => {
  rmSync(racine, { recursive: true, force: true });
  mkdirSync(path.join(racine, "entree"), { recursive: true });
  mkdirSync(path.join(racine, "sortie"), { recursive: true });
});
afterAll(() => rmSync(racine, { recursive: true, force: true }));

const refus = async (f: () => Promise<unknown>): Promise<string> => { try { await f(); } catch (e) { return e instanceof ErreurSortie ? e.code : `AUTRE:${(e as Error).message}`; } return "AUCUN"; };
const ecrireSortie = (id: string, rel: string, contenu: string | Buffer) => {
  const f = path.join(racine, "sortie", id, ...rel.split("/"));
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, contenu);
};
const validateur = () => new ValidateurCouche({ limites: LIM, coordonnees: "wgs84", retenir: true });
const peutJonction = (() => {
  try { const d = mkdtempSync(path.join(tmpdir(), "b2-jct-")); mkdirSync(path.join(d, "cible")); symlinkSync(path.join(d, "cible"), path.join(d, "j"), "junction"); rmSync(d, { recursive: true }); return true; } catch { return false; }
})();
const peutLierSymboliquement = (() => {
  try { const d = mkdtempSync(path.join(tmpdir(), "b2-lien-")); writeFileSync(path.join(d, "a"), "x"); symlinkSync(path.join(d, "a"), path.join(d, "l")); rmSync(d, { recursive: true }); return true; } catch { return false; }
})();

describe("dépôt dans entree/ : demande.json EN DERNIER", () => {
  it("le fichier est déposé SANS demande.json ; la demande est publiée ensuite, atomiquement", async () => {
    await stagerEntree(s, ID, "gpkg", Buffer.from("contenu"));
    expect(readdirSync(path.join(racine, "entree", ID))).toEqual(["fichier.gpkg"]); // le conteneur ne traite pas encore
    expect(await entreeExiste(s, ID, "gpkg")).toBe(true);
    await publierDemande(s, ID, { version: 1, fichier: "fichier.gpkg", epsg_source: 32629 });
    expect(readdirSync(path.join(racine, "entree", ID)).sort()).toEqual(["demande.json", "fichier.gpkg"]);
    expect(JSON.parse(readFileSync(path.join(racine, "entree", ID, "demande.json"), "utf8"))).toEqual({ version: 1, fichier: "fichier.gpkg", epsg_source: 32629 });
  });

  it("aucun écrasement : un second dépôt dans le même dossier échoue", async () => {
    await stagerEntree(s, ID, "dxf", Buffer.from("a"));
    await expect(stagerEntree(s, ID, "dxf", Buffer.from("b"))).rejects.toThrow();
    expect(readFileSync(path.join(racine, "entree", ID, "fichier.dxf"), "utf8")).toBe("a");
  });

  it("jamais d'identifiant de dossier venu d'ailleurs que <uuid>-t<n>, jamais d'extension libre", async () => {
    for (const mauvais of ["../evil", "x", `${ID}/../../y`, "123e4567-e89b-42d3-a456-426614174000", "/etc"]) {
      await expect(stagerEntree(s, mauvais, "gpkg", Buffer.from("x")), mauvais).rejects.toThrow("identifiant de spool invalide");
      await expect(purger(s, mauvais), mauvais).rejects.toThrow("identifiant de spool invalide");
    }
    await expect(stagerEntree(s, ID, "../x", Buffer.from("x"))).rejects.toThrow("extension invalide");
    await expect(stagerEntree(s, ID, "GPKG", Buffer.from("x"))).rejects.toThrow("extension invalide");
    expect(existsSync(path.join(racine, "evil"))).toBe(false);
  });

  it("nouvelle tentative : le fichier est recopié dans un nouveau dossier, sans demande", async () => {
    await stagerEntree(s, ID, "zip", Buffer.from("zipzip"));
    await publierDemande(s, ID, { version: 1 });
    await copierEntree(s, ID, ID2, "zip");
    expect(readdirSync(path.join(racine, "entree", ID2))).toEqual(["fichier.zip"]);
    expect(readFileSync(path.join(racine, "entree", ID2, "fichier.zip"), "utf8")).toBe("zipzip");
  });
});

describe("lecture de statut.json et resultat.json (non fiables)", () => {
  it("absent, valide, illisible, hors contrat, autre job", async () => {
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "absent" });
    const ok = { jobId: ID, statut: "en_cours", etape: "conversion", code: null, message: null, debut: "2026-11-08T10:00:00Z", fin: null, versionWorker: "0.2.0", versionContrat: 1 };
    ecrireSortie(ID, "statut.json", JSON.stringify(ok));
    expect(await lireStatutSpool(s, ID)).toMatchObject({ etat: "ok", statut: { statut: "en_cours", etape: "conversion" } });
    ecrireSortie(ID, "statut.json", "{pas du json");
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "illisible" });
    ecrireSortie(ID, "statut.json", JSON.stringify({ ...ok, extra: 1 }));
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "illisible" });
    ecrireSortie(ID, "statut.json", JSON.stringify({ ...ok, jobId: ID2 }));
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "illisible" });
  });

  it("un statut.json plus gros que 64 Kio est refusé sans être lu", async () => {
    ecrireSortie(ID, "statut.json", " ".repeat(70_000) + "{}");
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "illisible" });
  });

  it("resultat.json : lu en JSON, jamais au-delà de 4 Mo ; sans message de chemin", async () => {
    ecrireSortie(ID, "resultat.json", JSON.stringify(resultatValide({ spoolId: ID })));
    expect(((await lireResultatBrut(s, ID)) as { jobId: string }).jobId).toBe(ID);
    ecrireSortie(ID, "resultat.json", "x".repeat(4 * 1024 * 1024 + 1));
    const code = await refus(() => lireResultatBrut(s, ID));
    expect(code).toBe("SORTIE_TROP_GROSSE");
    ecrireSortie(ID, "resultat.json", "pas json");
    try { await lireResultatBrut(s, ID); } catch (e) { expect(String((e as Error).message)).not.toContain(racine); }
  });

  it.skipIf(!peutLierSymboliquement)("un lien symbolique placé dans sortie/ n'est jamais suivi", async () => {
    const dehors = path.join(racine, "secret.json");
    writeFileSync(dehors, JSON.stringify({ secret: true }));
    mkdirSync(path.join(racine, "sortie", ID), { recursive: true });
    symlinkSync(dehors, path.join(racine, "sortie", ID, "resultat.json"));
    expect(await refus(() => lireResultatBrut(s, ID))).toBe("SORTIE_INVALIDE");
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "illisible" });
  });

  it.skipIf(!peutJonction)("un dossier couches/ remplacé par un lien vers l'extérieur n'est jamais lu", async () => {
    const dehors = path.join(racine, "dehors");
    mkdirSync(dehors);
    writeFileSync(path.join(dehors, "axes.geojson"), texteCouche(DEUX_AXES));
    mkdirSync(path.join(racine, "sortie", ID), { recursive: true });
    symlinkSync(dehors, path.join(racine, "sortie", ID, "couches"), "junction");
    expect(await refus(() => lireCoucheVersValidateur(s, ID, "axes", validateur(), { octetsMax: 10_000_000, ligneMax: 1_000_000 }))).toBe("SORTIE_INVALIDE");
  });
});

describe("lecture d'une couche en flux : borne, empreinte, UTF-8", () => {
  const lire = (nom = "axes") => lireCoucheVersValidateur(s, ID, nom, validateur(), { octetsMax: 10_000_000, ligneMax: LIM.ligneMax });

  it("lit la couche, rend l'empreinte SHA-256 EXACTE et la taille des octets lus", async () => {
    const t = texteCouche(DEUX_AXES);
    ecrireSortie(ID, "couches/axes.geojson", t);
    const v = validateur();
    const r = await lireCoucheVersValidateur(s, ID, "axes", v, { octetsMax: 10_000_000, ligneMax: LIM.ligneMax });
    expect(r.sha256).toBe(createHash("sha256").update(t).digest("hex"));
    expect(r.octets).toBe(Buffer.byteLength(t));
    expect(v.terminer().nb).toBe(2);
  });

  it("découpe correcte sur de gros fichiers (lignes à cheval sur plusieurs blocs)", async () => {
    const f = Array.from({ length: 6000 }, (_, i) => ({ props: { i, texte: "é".repeat(40) }, geom: { type: "LineString", coordinates: [[-9 + i * 1e-5, 10.8], [-9 + i * 1e-5, 10.801]] } }));
    const t = texteCouche(f);
    expect(Buffer.byteLength(t)).toBeGreaterThan(512 * 1024);
    ecrireSortie(ID, "couches/axes.geojson", t);
    const v = validateur();
    await lireCoucheVersValidateur(s, ID, "axes", v, { octetsMax: 50_000_000, ligneMax: LIM.ligneMax });
    expect(v.terminer().nb).toBe(6000);
  });

  it("refuse une couche plus grosse que le plafond, une ligne trop longue, un UTF-8 invalide", async () => {
    ecrireSortie(ID, "couches/axes.geojson", texteCouche(DEUX_AXES));
    expect(await refus(() => lireCoucheVersValidateur(s, ID, "axes", validateur(), { octetsMax: 100, ligneMax: LIM.ligneMax }))).toBe("SORTIE_TROP_GROSSE");
    expect(await refus(() => lireCoucheVersValidateur(s, ID, "axes", validateur(), { octetsMax: 10_000_000, ligneMax: 50 }))).toBe("SORTIE_INVALIDE");
    ecrireSortie(ID, "couches/axes.geojson", Buffer.concat([Buffer.from(texteCouche(DEUX_AXES).split("\n").slice(0, 3).join("\n")), Buffer.from([0xff, 0xfe, 0x0a])]));
    expect(await refus(() => lire())).toBe("SORTIE_INVALIDE");
  });

  it("jamais de nom de couche hors motif, jamais un fichier absent confondu avec une couche vide", async () => {
    for (const mauvais of ["../resultat", "A", "a/b", "", "a.b"]) expect(await refus(() => lire(mauvais)), mauvais).toBe("SORTIE_INVALIDE");
    await expect(lire("axes")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("purge et disponibilité", () => {
  it("purge entree/ et sortie/ du job, idempotente, sans toucher aux autres jobs", async () => {
    await stagerEntree(s, ID, "gpkg", Buffer.from("x"));
    await stagerEntree(s, ID2, "gpkg", Buffer.from("y"));
    ecrireSortie(ID, "couches/axes.geojson", "{}");
    await purger(s, ID);
    await purger(s, ID);
    expect(existsSync(path.join(racine, "entree", ID))).toBe(false);
    expect(existsSync(path.join(racine, "sortie", ID))).toBe(false);
    expect(existsSync(path.join(racine, "entree", ID2))).toBe(true);
  });

  it("disponibilité : dossiers présents ou non (aucun fichier créé)", async () => {
    expect(await disponibiliteSpool(s)).toEqual({ ok: true });
    rmSync(path.join(racine, "sortie"), { recursive: true });
    const d = await disponibiliteSpool(s);
    expect(d.ok).toBe(false);
    expect(JSON.stringify(d)).not.toContain(racine);
  });
});
