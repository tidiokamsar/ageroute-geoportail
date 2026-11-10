import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { constants, promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITES_COUCHE_DEFAUT, ErreurSortie, ValidateurCouche } from "./sortie.noyau";
import {
  copierVersEntree, disponibiliteSpool, drapeauxLectureSure, entreeExiste, lireCoucheVersValidateur, lireResultatBrut, lireStatutSpool, ouvrirSpool, priveExiste, publierDemande, purger,
  purgerEntree, purgerPrive, purgerSortie, stagerEntree, stagerPrive, type Spool,
} from "./spool";
import { DEUX_AXES, resultatValide, texteCouche } from "./fixtures.gdal";

/** Protocole de spool (lot B2, durci lot V2) : le conteneur est un ecrivain NON FIABLE de sortie/ ; aucune lecture hors du dossier du job, aucune erreur avec un chemin. */

const racine = mkdtempSync(path.join(tmpdir(), "b2-spool-"));
const s: Spool = ouvrirSpool(racine);
const JOB = "123e4567-e89b-42d3-a456-426614174000";
const ID = `${JOB}-t1`;
const ID2 = `${JOB}-t2`;
const LIM = { sommetsParObjet: 100_000, sommetsParFichier: 2_000_000, objetsMax: 50_000, ...LIMITES_COUCHE_DEFAUT };

beforeEach(() => {
  rmSync(racine, { recursive: true, force: true });
  mkdirSync(path.join(racine, "entree"), { recursive: true });
  mkdirSync(path.join(racine, "sortie"), { recursive: true });
});
afterEach(() => vi.restoreAllMocks());
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
const statutOk = (id: string) => ({ jobId: id, statut: "en_cours", etape: "conversion", code: null, message: null, debut: "2026-11-08T10:00:00Z", fin: null, versionWorker: "0.2.0", versionContrat: 1 });

describe("depot PRIVE du backend puis copie dans entree/ a la reclamation (M2)", () => {
  it("le fichier depose n'apparait QUE dans prive/<jobId>/ (droits 0600), jamais dans entree/ avant la reclamation", async () => {
    await stagerPrive(s, JOB, "gpkg", Buffer.from("contenu"));
    expect(readdirSync(path.join(racine, "prive", JOB))).toEqual(["fichier.gpkg"]);
    expect(readdirSync(path.join(racine, "entree"))).toEqual([]);
    expect(await priveExiste(s, JOB, "gpkg")).toBe(true);
    expect(await entreeExiste(s, ID, "gpkg")).toBe(false);
  });

  it("a la reclamation, copie vers entree/<spoolId>/ SANS demande.json ; la demande est publiee ensuite, atomiquement", async () => {
    await stagerPrive(s, JOB, "gpkg", Buffer.from("contenu"));
    await copierVersEntree(s, JOB, ID, "gpkg");
    expect(readdirSync(path.join(racine, "entree", ID))).toEqual(["fichier.gpkg"]); // le conteneur ne traite pas encore
    expect(readFileSync(path.join(racine, "entree", ID, "fichier.gpkg"), "utf8")).toBe("contenu");
    await publierDemande(s, ID, { version: 1, fichier: "fichier.gpkg", epsg_source: 32629 });
    expect(readdirSync(path.join(racine, "entree", ID)).sort()).toEqual(["demande.json", "fichier.gpkg"]);
    expect(JSON.parse(readFileSync(path.join(racine, "entree", ID, "demande.json"), "utf8"))).toEqual({ version: 1, fichier: "fichier.gpkg", epsg_source: 32629 });
  });

  it("copie idempotente : un dossier d'entree deja present avec le fichier (transmission reprise) n'est pas une erreur (m7) ; sans depot prive : erreur", async () => {
    await stagerPrive(s, JOB, "zip", Buffer.from("zipzip"));
    await copierVersEntree(s, JOB, ID, "zip");
    await expect(copierVersEntree(s, JOB, ID, "zip")).resolves.toBeUndefined();
    expect(readFileSync(path.join(racine, "entree", ID, "fichier.zip"), "utf8")).toBe("zipzip");
    await expect(copierVersEntree(s, "223e4567-e89b-42d3-a456-426614174000", ID2, "zip")).rejects.toThrow();
    // une nouvelle tentative recopie depuis le prive dans un NOUVEAU dossier
    await copierVersEntree(s, JOB, ID2, "zip");
    expect(readdirSync(path.join(racine, "entree", ID2))).toEqual(["fichier.zip"]);
  });

  it("aucun ecrasement : un second depot prive du meme job, ou un second depot d'entree du meme dossier, echoue", async () => {
    await stagerPrive(s, JOB, "dxf", Buffer.from("a"));
    await expect(stagerPrive(s, JOB, "dxf", Buffer.from("b"))).rejects.toThrow();
    expect(readFileSync(path.join(racine, "prive", JOB, "fichier.dxf"), "utf8")).toBe("a");
    await stagerEntree(s, ID, "dxf", Buffer.from("a"));
    await expect(stagerEntree(s, ID, "dxf", Buffer.from("b"))).rejects.toThrow();
  });

  it("jamais d'identifiant venu d'ailleurs que <uuid>-t<n> (entree, sortie) ou <uuid> (prive), jamais d'extension libre", async () => {
    for (const mauvais of ["../evil", "x", `${ID}/../../y`, JOB, "/etc"]) {
      await expect(stagerEntree(s, mauvais, "gpkg", Buffer.from("x")), mauvais).rejects.toThrow("identifiant de spool invalide");
      await expect(purger(s, mauvais), mauvais).rejects.toThrow("identifiant de spool invalide");
    }
    for (const mauvais of ["../evil", ID, "x", `${JOB}/..`]) {
      await expect(stagerPrive(s, mauvais, "gpkg", Buffer.from("x")), mauvais).rejects.toThrow("identifiant de job invalide");
      await expect(purgerPrive(s, mauvais), mauvais).rejects.toThrow("identifiant de job invalide");
    }
    await expect(stagerEntree(s, ID, "../x", Buffer.from("x"))).rejects.toThrow("extension invalide");
    await expect(stagerPrive(s, JOB, "GPKG", Buffer.from("x"))).rejects.toThrow("extension invalide");
    expect(existsSync(path.join(racine, "evil"))).toBe(false);
  });

  it("le dossier prive peut etre place hors du spool (volumes montes) ; par defaut <racine>/prive", () => {
    expect(ouvrirSpool("/srv/spool").prive).toBe(path.join("/srv/spool", "prive"));
    expect(ouvrirSpool("/srv/spool", "/var/lib/backend/gdal-prive").prive).toBe("/var/lib/backend/gdal-prive");
    expect(ouvrirSpool("/srv/spool", "").prive).toBe(path.join("/srv/spool", "prive"));
  });
});

describe("lecture de statut.json et resultat.json (non fiables)", () => {
  it("absent, valide, illisible, hors contrat, autre job", async () => {
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "absent" });
    const ok = statutOk(ID);
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

  it.skipIf(!peutJonction)("le dossier du job LUI-MEME remplacé par un lien vers l'extérieur n'est jamais lu (m3 : la base est realpath(sortie)/<id>, pas realpath du lien)", async () => {
    const dehors = path.join(racine, "dehors-job");
    mkdirSync(dehors);
    writeFileSync(path.join(dehors, "resultat.json"), JSON.stringify(resultatValide({ spoolId: ID })));
    writeFileSync(path.join(dehors, "statut.json"), JSON.stringify(statutOk(ID)));
    symlinkSync(dehors, path.join(racine, "sortie", ID), "junction");
    expect(await refus(() => lireResultatBrut(s, ID))).toBe("SORTIE_INVALIDE");
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "illisible" });
    expect(existsSync(path.join(dehors, "resultat.json"))).toBe(true);
  });
});

describe("ouverture SANS BLOQUER puis fstat (M1) : un tube nomme ou un peripherique plante par le conteneur ne retient aucun thread", () => {
  it("les drapeaux d'ouverture portent O_RDONLY, O_NOFOLLOW et O_NONBLOCK (chacun absent = 0 sous Windows)", () => {
    const c = { O_RDONLY: 0, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 };
    const d = drapeauxLectureSure(c);
    expect(d & c.O_NOFOLLOW).toBe(c.O_NOFOLLOW);
    expect(d & c.O_NONBLOCK).toBe(c.O_NONBLOCK);
    expect(drapeauxLectureSure({ O_RDONLY: 0 })).toBe(0);
    expect(drapeauxLectureSure(constants) & (constants.O_NONBLOCK ?? 0)).toBe(constants.O_NONBLOCK ?? 0);
  });

  it("l'ouverture reelle passe ces drapeaux (jamais une chaine 'r' qui ouvrirait en bloquant)", async () => {
    ecrireSortie(ID, "statut.json", JSON.stringify(statutOk(ID)));
    const espion = vi.spyOn(fsp, "open");
    expect(await lireStatutSpool(s, ID)).toMatchObject({ etat: "ok" });
    const appel = espion.mock.calls.find((c) => String(c[0]).endsWith("statut.json"));
    expect(appel).toBeDefined();
    expect(appel![1]).toBe(drapeauxLectureSure(constants));
  });

  it("ce qui a ete OUVERT est controle par fstat : un descripteur qui n'est pas un fichier regulier (tube substitue entre lstat et open) est refuse et ferme", async () => {
    ecrireSortie(ID, "statut.json", JSON.stringify(statutOk(ID)));
    const ouvrirReel = fsp.open.bind(fsp);
    let ferme = 0;
    vi.spyOn(fsp, "open").mockImplementation(async (chemin, drapeaux, mode) => {
      const h = await ouvrirReel(chemin as string, drapeaux as number, mode as number);
      const statReel = h.stat.bind(h);
      const closeReel = h.close.bind(h);
      // Le descripteur est devenu un tube : fstat dit « pas un fichier ».
      h.stat = (async (...a: unknown[]) => { const st = await (statReel as (...x: unknown[]) => Promise<import("node:fs").Stats>)(...a); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false, isFIFO: () => true }); }) as typeof h.stat;
      h.close = (async () => { ferme++; return closeReel(); }) as typeof h.close;
      return h;
    });
    expect(await lireStatutSpool(s, ID)).toEqual({ etat: "illisible" });
    expect(ferme).toBe(1);
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
    mkdirSync(path.join(racine, "sortie", ID), { recursive: true });
    await expect(lire("axes")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("purge par NOMS CONNUS (m2) et disponibilité (m1)", () => {
  it("purge entree/, sortie/ et prive/ du job, idempotente, sans toucher aux autres jobs", async () => {
    await stagerPrive(s, JOB, "gpkg", Buffer.from("x"));
    await stagerEntree(s, ID, "gpkg", Buffer.from("x"));
    await publierDemande(s, ID, { version: 1 });
    await stagerEntree(s, ID2, "gpkg", Buffer.from("y"));
    ecrireSortie(ID, "couches/axes.geojson", "{}");
    ecrireSortie(ID, "couches/regards-2.geojson", "{}");
    ecrireSortie(ID, "statut.json", "{}");
    ecrireSortie(ID, "resultat.json.tmp", "{}");
    await purger(s, ID);
    await purger(s, ID);
    await purgerPrive(s, JOB);
    await purgerPrive(s, JOB);
    expect(existsSync(path.join(racine, "entree", ID))).toBe(false);
    expect(existsSync(path.join(racine, "sortie", ID))).toBe(false);
    expect(existsSync(path.join(racine, "prive", JOB))).toBe(false);
    expect(existsSync(path.join(racine, "entree", ID2))).toBe(true);
  });

  it("un nom INATTENDU laisse par le conteneur n'est jamais supprime : les noms connus partent, le dossier reste, l'erreur remonte (jamais de rm -rf d'un arbre du conteneur)", async () => {
    ecrireSortie(ID, "statut.json", "{}");
    ecrireSortie(ID, "couches/axes.geojson", "{}");
    ecrireSortie(ID, "couches/Évasion.bin", "x");
    ecrireSortie(ID, "autre/profond/fichier", "x");
    await expect(purgerSortie(s, ID)).rejects.toThrow();
    expect(existsSync(path.join(racine, "sortie", ID, "statut.json"))).toBe(false);
    expect(existsSync(path.join(racine, "sortie", ID, "couches", "axes.geojson"))).toBe(false);
    expect(existsSync(path.join(racine, "sortie", ID, "couches", "Évasion.bin"))).toBe(true);
    expect(existsSync(path.join(racine, "sortie", ID, "autre", "profond", "fichier"))).toBe(true);
    try { await purgerSortie(s, ID); } catch (e) { expect(String((e as Error).message)).not.toContain("profond"); }
    await expect(purgerEntree(s, ID)).resolves.toBeUndefined(); // entree absente : rien
  });

  it.skipIf(!peutJonction)("un dossier du job remplace par un lien est retire COMME LIEN : la cible reste intacte", async () => {
    const dehors = path.join(racine, "cible-intacte");
    mkdirSync(dehors);
    writeFileSync(path.join(dehors, "statut.json"), "{}");
    writeFileSync(path.join(dehors, "important.txt"), "x");
    symlinkSync(dehors, path.join(racine, "sortie", ID), "junction");
    await purgerSortie(s, ID);
    expect(existsSync(path.join(racine, "sortie", ID))).toBe(false);
    expect(existsSync(path.join(dehors, "statut.json"))).toBe(true);
    expect(existsSync(path.join(dehors, "important.txt"))).toBe(true);
    // couches/ remplace par un lien : meme regle
    ecrireSortie(ID2, "statut.json", "{}");
    symlinkSync(dehors, path.join(racine, "sortie", ID2, "couches"), "junction");
    await purgerSortie(s, ID2);
    expect(existsSync(path.join(racine, "sortie", ID2))).toBe(false);
    expect(existsSync(path.join(dehors, "important.txt"))).toBe(true);
  });

  it("disponibilité : entree et sortie en lecture ET ecriture ; prive present ou creable ; aucun fichier créé ; jamais de chemin dans la raison", async () => {
    expect(await disponibiliteSpool(s)).toEqual({ ok: true });
    expect(existsSync(path.join(racine, "prive"))).toBe(false);
    mkdirSync(path.join(racine, "prive"));
    expect(await disponibiliteSpool(s)).toEqual({ ok: true });
    const ailleurs = disponibiliteSpool(ouvrirSpool(racine, path.join(racine, "inexistant", "profond", "prive")));
    expect((await ailleurs).ok).toBe(false);
    rmSync(path.join(racine, "sortie"), { recursive: true });
    const d = await disponibiliteSpool(s);
    expect(d.ok).toBe(false);
    expect(JSON.stringify(d)).not.toContain(racine);
  });
});
