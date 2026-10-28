import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refusQuota, statutHttp, EXPLICATIONS, octetsDuRepertoire, ajouterAuCache,
  invaliderCache, DUREE_CACHE_MS,
  PLAFOND_PHOTOS_PAR_OBJET_DEFAUT, PLAFOND_DISQUE_MIO_DEFAUT,
  type EtatQuota,
} from "./quota-photos";

/**
 * Les plafonds de photos : ce que ces tests defendent.
 *
 * L'ETAT CONSTATE LE 12/10/2026
 *
 * Le middleware de televersement ne declarait qu'une limite, `fileSize` a 8 Mio PAR
 * FICHIER. Rien ne bornait le nombre par objet ni le total du repertoire, sur quatre
 * routes qui acceptent des photos.
 *
 * Le risque n'est pas celui d'un inconnu — tout est derriere authentification. Il est
 * plus banal : l'application de terrain synchronise SEULE, et une file locale qui se
 * rejoue en boucle televerse sans qu'aucun humain regarde. Le disque heberge aussi
 * PostgreSQL et le fond de carte public : le remplir arrete la carte.
 *
 * Le dedoublonnage SHA-256 de la route des defauts ne protegeait pas de cela : il arrete
 * la MEME photo renvoyee, pas mille photos differentes.
 */

const e = (p: Partial<EtatQuota> = {}): EtatQuota => ({
  dejaPresentes: 0,
  plafondParObjet: 30,
  octetsUtilises: 0,
  plafondOctets: 20 * 1024 * 1024 * 1024,
  ...p,
});

describe("Deux plafonds, parce qu'il y a deux pannes differentes", () => {
  it("accepte quand les deux sont loin", () => {
    expect(refusQuota(e({ dejaPresentes: 3 }))).toBeNull();
  });

  it("refuse a partir du plafond par objet, pas apres", () => {
    // Le 30e cliche doit passer, le 31e non : `dejaPresentes` compte ce qui EST deja la.
    expect(refusQuota(e({ dejaPresentes: 29 }))).toBeNull();
    expect(refusQuota(e({ dejaPresentes: 30 }))).toBe("PLAFOND_PAR_OBJET");
  });

  it("refuse quand le repertoire atteint son plafond", () => {
    expect(refusQuota(e({ octetsUtilises: 100, plafondOctets: 100 }))).toBe("DISQUE_SATURE");
    expect(refusQuota(e({ octetsUtilises: 99, plafondOctets: 100 }))).toBeNull();
  });
});

describe("Le disque passe avant l'objet, et c'est une decision", () => {
  it("nomme le disque quand les deux plafonds sont atteints", () => {
    // Quand le disque est sature, le probleme n'appartient pas a l'agent et aucun menage
    // sur son objet n'y changera rien. Lui repondre « cet element porte deja trente
    // photos » l'enverrait supprimer des preuves pour rien.
    const motif = refusQuota(e({ dejaPresentes: 99, octetsUtilises: 100, plafondOctets: 100 }));
    expect(motif).toBe("DISQUE_SATURE");
  });

  it("distingue les deux par le code HTTP", () => {
    // 507 et non 503 : le service repond, c'est le stockage qui manque. Un 503 ferait
    // reessayer la file de synchronisation en boucle, ce qui aggraverait precisement la
    // situation qu'on signale.
    expect(statutHttp("DISQUE_SATURE")).toBe(507);
    expect(statutHttp("PLAFOND_PAR_OBJET")).toBe(409);
  });
});

describe("Un plafond mal configure ne doit pas arreter un pays", () => {
  it("traite zero comme une absence de plafond, pas comme un blocage total", () => {
    // Une variable d'environnement a zero est une faute de saisie. Bloquer tout
    // televersement ferait echouer la collecte sur l'ensemble du reseau, et le defaut de
    // configuration se verrait sur le terrain au lieu des journaux.
    expect(refusQuota(e({ dejaPresentes: 10_000, plafondParObjet: 0 }))).toBeNull();
    expect(refusQuota(e({ octetsUtilises: 10 ** 12, plafondOctets: 0 }))).toBeNull();
  });

  it("ignore un plafond negatif de la meme facon", () => {
    expect(refusQuota(e({ dejaPresentes: 99, plafondParObjet: -1 }))).toBeNull();
  });

  it("garde des valeurs par defaut qui ne sont pas l'infini", () => {
    // La valeur exacte est un arbitrage metier ; qu'elle existe n'en est pas un.
    expect(PLAFOND_PHOTOS_PAR_OBJET_DEFAUT).toBeGreaterThan(0);
    expect(PLAFOND_DISQUE_MIO_DEFAUT).toBeGreaterThan(0);
  });
});

describe("Les refus s'expliquent a un agent, pas a un developpeur", () => {
  it("donne un message pour chaque motif", () => {
    for (const m of ["PLAFOND_PAR_OBJET", "DISQUE_SATURE"] as const) {
      expect(EXPLICATIONS[m].length, m).toBeGreaterThan(20);
      expect(EXPLICATIONS[m], m).not.toMatch(/_|\bundefined\b|\bnull\b|[A-Z]{4,}/);
    }
  });

  it("dit a l'agent lequel des deux problemes est le sien", () => {
    // Le message de saturation doit lever l'ambiguite, sinon l'agent cherchera une
    // correction qui n'existe pas de son cote.
    expect(EXPLICATIONS.DISQUE_SATURE).toMatch(/administrateur|serveur/i);
    expect(EXPLICATIONS.PLAFOND_PAR_OBJET).toMatch(/supprim/i);
  });
});

describe("Mesurer le repertoire sans le mesurer a chaque requete", () => {
  let repertoire: string;

  beforeEach(async () => {
    invaliderCache();
    repertoire = await mkdtemp(join(tmpdir(), "quota-photos-"));
  });

  afterEach(async () => {
    invaliderCache();
    await rm(repertoire, { recursive: true, force: true });
  });

  it("additionne la taille des fichiers presents", async () => {
    await writeFile(join(repertoire, "a.jpg"), Buffer.alloc(1000));
    await writeFile(join(repertoire, "b.jpg"), Buffer.alloc(2000));
    expect(await octetsDuRepertoire(repertoire, 0)).toBe(3000);
  });

  it("rend zero sur un repertoire absent, au lieu d'echouer", async () => {
    // Au premier demarrage, avant le premier televersement, le dossier n'existe pas
    // encore. Echouer rendrait la collecte impossible tant que personne ne l'a cree a la
    // main.
    expect(await octetsDuRepertoire(join(repertoire, "pas-la"), 0)).toBe(0);
  });

  it("rend la valeur en cache pendant la duree prevue", async () => {
    await writeFile(join(repertoire, "a.jpg"), Buffer.alloc(1000));
    expect(await octetsDuRepertoire(repertoire, 0)).toBe(1000);

    // Un fichier ajoute juste apres n'est pas vu : c'est le compromis assume, le
    // depassement tolere vaut au pire (duree du cache) x (debit de televersement).
    await writeFile(join(repertoire, "b.jpg"), Buffer.alloc(5000));
    expect(await octetsDuRepertoire(repertoire, DUREE_CACHE_MS - 1)).toBe(1000);
  });

  it("remesure apres peremption", async () => {
    await writeFile(join(repertoire, "a.jpg"), Buffer.alloc(1000));
    expect(await octetsDuRepertoire(repertoire, 0)).toBe(1000);
    await writeFile(join(repertoire, "b.jpg"), Buffer.alloc(5000));
    expect(await octetsDuRepertoire(repertoire, DUREE_CACHE_MS)).toBe(6000);
  });

  it("COMPTE LES PHOTOS ACCEPTEES SANS REMESURER", async () => {
    // La propriete qui rend le plafond global utile. Sans elle, le cache resterait sur
    // son ancienne valeur pendant une minute et une file qui se rejoue vite passerait
    // tout entiere au travers du plafond.
    await writeFile(join(repertoire, "a.jpg"), Buffer.alloc(1000));
    expect(await octetsDuRepertoire(repertoire, 0)).toBe(1000);

    ajouterAuCache(8 * 1024 * 1024);
    expect(await octetsDuRepertoire(repertoire, 1)).toBe(1000 + 8 * 1024 * 1024);
  });

  it("n'invente rien quand aucune mesure n'a encore eu lieu", async () => {
    // `ajouterAuCache` avant toute mesure ne doit pas creer un total a partir de rien :
    // la premiere mesure reelle doit rester la reference.
    ajouterAuCache(8 * 1024 * 1024);
    await writeFile(join(repertoire, "a.jpg"), Buffer.alloc(1000));
    expect(await octetsDuRepertoire(repertoire, 0)).toBe(1000);
  });

  it("ignore les sous-repertoires au lieu d'echouer dessus", async () => {
    await writeFile(join(repertoire, "a.jpg"), Buffer.alloc(1000));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(repertoire, "vignettes"));
    expect(await octetsDuRepertoire(repertoire, 0)).toBe(1000);
  });
});
