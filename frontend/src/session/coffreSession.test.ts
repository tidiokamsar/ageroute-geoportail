// @vitest-environment node
// jsdom perd les Blob (pas d'`arrayBuffer`) et n'a pas WebCrypto complet : ces essais tournent sous Node, dont
// `crypto.subtle` est celui de la plateforme, pas une simulation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import {
  CoffreSession, ErreurCoffre, ITERATIONS_PBKDF2_DEFAUT, ITERATIONS_PBKDF2_MAX, ITERATIONS_PBKDF2_MIN, TAILLE_MAX_BLOB_OCTETS,
  aadBlob, aadFile, avecVerrouCoffre, creerCoffre,
  listerComptesAvecCoffre, mesurerDerivationMs, ouvrirCoffre, sha256WebCrypto, stockageEnMemoire, stockageIndexedDb,
  validerPin, type EnveloppeCoffre, type IdentiteProfil, type StockageCoffre,
} from "./coffreSession";
import { PARAMETRES_SESSION as P } from "./noyauSession";
import { empreinteCompte } from "./compteLocal";

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const JOUR = 24 * 60 * MIN;
const PIN = "Zq7!kd-4821";
const COMPTE = "user-alice-001";
const APPAREIL = "appareil-local-42";
/** Peu d'iterations : on teste la mecanique, pas le cout. Un essai distinct prend la valeur par defaut. */
const IT = 1000;
/** Sous le plancher de production : n'est accepte qu'avec `iterationsDeTest: true`, que chaque coffre de test passe. */
const MODE_TEST = { iterations: IT, iterationsDeTest: true } as const;
const NOUVEAU_PIN = "nouveau-pin-77";

const identite: IdentiteProfil = {
  userId: COMPTE,
  nom: "Alice Camara",
  role: "AGENT_TERRAIN",
  modules: ["inspection", "carte"],
  regions: ["Kankan", "Faranah"],
};

function nouveauStockage() {
  return stockageEnMemoire();
}

async function fabriquer(stockage = nouveauStockage(), surcharge: Partial<Parameters<typeof creerCoffre>[0]> = {}) {
  const coffre = await creerCoffre({
    stockage, compteId: COMPTE, appareilId: APPAREIL, pin: PIN, profil: identite, maintenantMs: T0, ...MODE_TEST, ...surcharge,
  });
  return { stockage, coffre };
}

function rouvrir(stockage: StockageCoffre, surcharge: { compteId?: string; appareilId?: string; crypto?: Crypto } = {}) {
  return ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, ...MODE_TEST, ...surcharge });
}

async function enveloppe(stockage: ReturnType<typeof nouveauStockage>, compteId = COMPTE): Promise<EnveloppeCoffre> {
  const e = await stockage.get(compteId);
  if (!e) throw new Error("enveloppe absente");
  return e;
}

const octetsAleatoires = (n: number) => {
  const o = new Uint8Array(n);
  // Tous les octets possibles, y compris 0x00 et 0xff, sur un motif non periodique court.
  for (let i = 0; i < n; i++) o[i] = (i * 31 + (i >> 8) * 7 + 13) & 0xff;
  return o;
};

async function lireOctets(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("validerPin", () => {
  it("accepte 6 caracteres ou plus, chiffres ou texte", () => {
    expect(validerPin("123456")).toEqual({ valide: true });
    expect(validerPin("abc-def")).toEqual({ valide: true });
    expect(validerPin("a".repeat(128))).toEqual({ valide: true });
  });
  it("refuse le vide, le trop court, le trop long", () => {
    expect(validerPin("")).toEqual({ valide: false, motif: "VIDE" });
    expect(validerPin(undefined as unknown as string)).toEqual({ valide: false, motif: "VIDE" });
    expect(validerPin("12345")).toEqual({ valide: false, motif: "TROP_COURT" });
    expect(validerPin("a".repeat(129))).toEqual({ valide: false, motif: "TROP_LONG" });
  });
  it("compte les caracteres et non les unites UTF-16", () => {
    expect(validerPin("😀😀😀😀😀")).toEqual({ valide: false, motif: "TROP_COURT" });
    expect(validerPin("😀😀😀😀😀😀")).toEqual({ valide: true });
  });
});

describe("creation", () => {
  it("rend un coffre deverrouille, avec un profil complet et une validite de 7 jours", async () => {
    const { coffre } = await fabriquer();
    expect(coffre.estDeverrouille()).toBe(true);
    expect(coffre.profilCourant()).toEqual({ ...identite, emisLe: T0, valideLe: T0, expireLe: T0 + 7 * JOUR });
  });

  it("l'enveloppe porte des parametres de derivation versionnes, un sel aleatoire et aucun compteur d'echec", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    expect(e).toMatchObject({
      v: 1, compteId: COMPTE, appareilId: APPAREIL, creeLe: T0, echecs: 0, pasAvantMs: null, dernierInstantMs: T0,
      kdf: { alg: "PBKDF2-SHA256", iterations: IT },
      cle: { alg: "AES-GCM-256" },
    });
    expect(atob(e.kdf.sel)).toHaveLength(16);
    expect(atob(e.cle.iv)).toHaveLength(12);
    // 32 octets de cle + 16 d'etiquette GCM : la DEK n'est pas stockee nue.
    expect(atob(e.cle.enveloppee)).toHaveLength(48);
  });

  it("deux creations donnent deux sels, deux IV et deux enveloppes de cle differents", async () => {
    const a = await enveloppe((await fabriquer()).stockage);
    const b = await enveloppe((await fabriquer()).stockage);
    expect(a.kdf.sel).not.toBe(b.kdf.sel);
    expect(a.cle.iv).not.toBe(b.cle.iv);
    expect(a.cle.enveloppee).not.toBe(b.cle.enveloppee);
  });

  it("par defaut : 600 000 iterations PBKDF2, enregistrees dans l'enveloppe, et le coffre se rouvre", async () => {
    expect(ITERATIONS_PBKDF2_DEFAUT).toBe(600_000);
    const stockage = nouveauStockage();
    await creerCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, pin: PIN, profil: identite, maintenantMs: T0 });
    expect((await enveloppe(stockage)).kdf.iterations).toBe(600_000);
    const r = await ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL }).deverrouiller(PIN, T0 + 1000);
    expect(r.ok).toBe(true);
  });

  it("les iterations sont lues dans l'enveloppe, pas dans les options : un coffre se rouvre meme si le reglage change", async () => {
    const { stockage } = await fabriquer(nouveauStockage(), { iterations: 1234 });
    const r = await ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, iterations: 5000, iterationsDeTest: true }).deverrouiller(PIN, T0 + 1);
    expect(r.ok).toBe(true);
  });

  it("refuse d'ecraser un coffre existant (ce serait perdre les saisies chiffrees)", async () => {
    const { stockage } = await fabriquer();
    await expect(fabriquer(stockage)).rejects.toMatchObject({ code: "COFFRE_EXISTANT" });
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 1)).ok).toBe(true);
  });

  it("refuse un PIN trop court, un profil d'un autre compte, des identifiants contenant le separateur", async () => {
    await expect(fabriquer(nouveauStockage(), { pin: "12345" })).rejects.toMatchObject({ code: "PIN_INVALIDE" });
    await expect(fabriquer(nouveauStockage(), { profil: { ...identite, userId: "autre" } })).rejects.toMatchObject({ code: "AUTRE_COMPTE" });
    await expect(fabriquer(nouveauStockage(), { compteId: "a|b" })).rejects.toMatchObject({ code: "ARGUMENT_INVALIDE" });
    await expect(fabriquer(nouveauStockage(), { appareilId: "" })).rejects.toMatchObject({ code: "ARGUMENT_INVALIDE" });
  });

  it("sans WebCrypto, echoue avec un code et non avec une erreur obscure", () => {
    expect(() => ouvrirCoffre({ stockage: nouveauStockage(), compteId: COMPTE, appareilId: APPAREIL, crypto: {} as Crypto })).toThrow(ErreurCoffre);
  });
});

describe("deverrouiller", () => {
  it("bon PIN : profil rendu, coffre deverrouille, compteur a zero", async () => {
    const { stockage, coffre } = await fabriquer();
    coffre.verrouiller();
    const r = await coffre.deverrouiller(PIN, T0 + MIN);
    expect(r).toEqual({ ok: true, profil: { ...identite, emisLe: T0, valideLe: T0, expireLe: T0 + 7 * JOUR } });
    expect(coffre.estDeverrouille()).toBe(true);
    expect((await enveloppe(stockage)).echecs).toBe(0);
  });

  it("depuis une nouvelle instance (redemarrage) : le coffre se rouvre avec le PIN seul", async () => {
    const { stockage } = await fabriquer();
    const neuf = rouvrir(stockage);
    expect(neuf.estDeverrouille()).toBe(false);
    expect((await neuf.deverrouiller(PIN, T0 + MIN)).ok).toBe(true);
  });

  it("mauvais PIN : PIN_INCORRECT, rien en memoire", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    expect(await c.deverrouiller("000000", T0 + MIN)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect(c.estDeverrouille()).toBe(false);
    expect(c.profilCourant()).toBeNull();
  });

  it("PIN vide ou absent : PIN_INCORRECT, sans exception", async () => {
    const { stockage } = await fabriquer();
    expect(await rouvrir(stockage).deverrouiller("", T0)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await rouvrir(stockage).deverrouiller(undefined as unknown as string, T0)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
  });

  it("le PIN saisi en chiffres pleine chasse (autre clavier) ouvre le meme coffre (NFKC)", async () => {
    const { stockage } = await fabriquer(nouveauStockage(), { pin: "123456" });
    expect((await rouvrir(stockage).deverrouiller("１２３４５６", T0 + 1)).ok).toBe(true);
  });

  it("COFFRE_ABSENT quand rien n'existe", async () => {
    expect(await rouvrir(nouveauStockage()).deverrouiller(PIN, T0)).toEqual({ ok: false, erreur: "COFFRE_ABSENT" });
  });

  it("AUTRE_COMPTE : l'enveloppe d'un compte copiee sous la cle d'un autre n'est pas ouverte", async () => {
    const { stockage } = await fabriquer();
    await stockage.put("user-bob-002", await enveloppe(stockage));
    const r = await rouvrir(stockage, { compteId: "user-bob-002" }).deverrouiller(PIN, T0 + 1);
    expect(r).toEqual({ ok: false, erreur: "AUTRE_COMPTE" });
  });

  it("AUTRE_APPAREIL : un autre identifiant d'installation n'ouvre pas le coffre", async () => {
    const { stockage } = await fabriquer();
    const r = await rouvrir(stockage, { appareilId: "autre-appareil" }).deverrouiller(PIN, T0 + 1);
    expect(r).toEqual({ ok: false, erreur: "AUTRE_APPAREIL" });
  });

  it("la cle est liee au compte : reetiqueter l'enveloppe d'un autre compte ne fait pas ouvrir le coffre, meme avec le bon PIN", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    await stockage.put("user-bob-002", { ...e, compteId: "user-bob-002" });
    const r = await rouvrir(stockage, { compteId: "user-bob-002" }).deverrouiller(PIN, T0 + 1);
    expect(r.ok).toBe(false);
  });

  it("COFFRE_ILLISIBLE : version inconnue, champ manquant, base64 casse", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    await stockage.put(COMPTE, { ...e, v: 2 } as unknown as EnveloppeCoffre);
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 1)).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
    await stockage.put(COMPTE, { ...e, kdf: undefined } as unknown as EnveloppeCoffre);
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 1)).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
    await stockage.put(COMPTE, { ...e, profil: "!!pas du base64!!" });
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 1)).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
  });

  it("profil chiffre altere (PIN juste) : COFFRE_ILLISIBLE, pas un faux PIN_INCORRECT", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    const octets = Uint8Array.from(atob(e.profil), (c) => c.charCodeAt(0));
    octets[octets.length - 1] ^= 0x01; // etiquette GCM
    await stockage.put(COMPTE, { ...e, profil: btoa(String.fromCharCode(...octets)) });
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 1)).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
  });

  it("cle enveloppee alteree : le coffre ne s'ouvre pas, meme avec le bon PIN", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    const octets = Uint8Array.from(atob(e.cle.enveloppee), (c) => c.charCodeAt(0));
    octets[0] ^= 0xff;
    await stockage.put(COMPTE, { ...e, cle: { ...e.cle, enveloppee: btoa(String.fromCharCode(...octets)) } });
    const r = await rouvrir(stockage).deverrouiller(PIN, T0 + 1);
    expect(r.ok).toBe(false);
  });
});

describe("expiration appliquee a la lecture du profil", () => {
  it("1 ms avant l'echeance : ouvre ; a l'echeance exacte : EXPIRE (motif DUREE), rien en memoire", async () => {
    const { stockage } = await fabriquer();
    const avant = rouvrir(stockage);
    expect((await avant.deverrouiller(PIN, T0 + P.dureeMaxMs - 1)).ok).toBe(true);

    const pile = rouvrir(stockage);
    expect(await pile.deverrouiller(PIN, T0 + P.dureeMaxMs)).toEqual({ ok: false, erreur: "EXPIRE", motif: "DUREE" });
    expect(pile.estDeverrouille()).toBe(false);
  });

  it("EXPIRE ne se revele qu'avec le bon PIN : un mauvais PIN, meme apres l'echeance, dit PIN_INCORRECT", async () => {
    const { stockage } = await fabriquer();
    expect(await rouvrir(stockage).deverrouiller("000000", T0 + 8 * JOUR)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
  });

  it("le coffre expire reste intact : rien n'est supprime", async () => {
    const { stockage } = await fabriquer();
    await rouvrir(stockage).deverrouiller(PIN, T0 + 8 * JOUR);
    expect(await stockage.get(COMPTE)).not.toBeNull();
  });

  it("recul d'horloge : tolere jusqu'a 5 min sous la marque persistee, EXPIRE (HORLOGE) au-dela", async () => {
    const { stockage } = await fabriquer();
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 10 * MIN)).ok).toBe(true); // marque = T0 + 10 min
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 5 * MIN)).ok).toBe(true); // exactement 5 min de recul
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 5 * MIN - 1)).toEqual({ ok: false, erreur: "EXPIRE", motif: "HORLOGE" });
  });

  it("la marque d'horloge ne descend pas : un deverrouillage tolere avec recul ne l'abaisse pas", async () => {
    const { stockage } = await fabriquer();
    await rouvrir(stockage).deverrouiller(PIN, T0 + 10 * MIN);
    await rouvrir(stockage).deverrouiller(PIN, T0 + 6 * MIN);
    expect((await enveloppe(stockage)).dernierInstantMs).toBe(T0 + 10 * MIN);
  });

  it("noterInstant ne fait que monter la marque", async () => {
    const { stockage, coffre } = await fabriquer();
    await coffre.noterInstant(T0 + 3 * MIN);
    expect((await enveloppe(stockage)).dernierInstantMs).toBe(T0 + 3 * MIN);
    await coffre.noterInstant(T0 + 1 * MIN);
    expect((await enveloppe(stockage)).dernierInstantMs).toBe(T0 + 3 * MIN);
  });
});

describe("verrouiller", () => {
  it("oublie la DEK et le profil ; chiffrer et dechiffrer jettent VERROUILLE", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ a: 1 }, "ctx");
    coffre.verrouiller();
    expect(coffre.estDeverrouille()).toBe(false);
    expect(coffre.profilCourant()).toBeNull();
    await expect(coffre.chiffrer({ a: 1 }, "ctx")).rejects.toMatchObject({ code: "VERROUILLE" });
    await expect(coffre.dechiffrer(paquet, "ctx")).rejects.toMatchObject({ code: "VERROUILLE" });
    await expect(coffre.chiffrerBlob(new Blob(["x"]), "id")).rejects.toMatchObject({ code: "VERROUILLE" });
    await expect(coffre.dechiffrerBlob(paquet, "id")).rejects.toMatchObject({ code: "VERROUILLE" });
  });

  it("apres un nouveau deverrouillage, ce qui a ete chiffre avant se relit", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ saisie: "PK 12+300", n: 7 }, "file|42");
    coffre.verrouiller();
    await coffre.deverrouiller(PIN, T0 + MIN);
    expect(await coffre.dechiffrerJson(paquet, "file|42")).toEqual({ saisie: "PK 12+300", n: 7 });
  });
});

describe("chiffrer / dechiffrer", () => {
  it("aller-retour d'octets, d'objet et de tampon", async () => {
    const { coffre } = await fabriquer();
    const octets = octetsAleatoires(1000);
    expect(await coffre.dechiffrer(await coffre.chiffrer(octets, "a"), "a")).toEqual(octets);
    expect(await coffre.dechiffrerJson(await coffre.chiffrer({ x: [1, 2, { y: "é" }] }, "a"), "a")).toEqual({ x: [1, 2, { y: "é" }] });
    expect(await coffre.dechiffrer(await coffre.chiffrer(octets.buffer, "a"), "a")).toEqual(octets);
    expect(await coffre.dechiffrer(await coffre.chiffrer(new Uint8Array(0), "a"), "a")).toEqual(new Uint8Array(0));
  });

  it("l'AAD peut etre un texte ou des octets, equivalents", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ k: 1 }, "ctx");
    expect(await coffre.dechiffrerJson(paquet, new TextEncoder().encode("ctx"))).toEqual({ k: 1 });
  });

  it("le meme clair chiffre deux fois donne deux chiffres differents (IV neuf a chaque ecriture)", async () => {
    const { coffre } = await fabriquer();
    const a = await coffre.chiffrer({ meme: "entree" }, "ctx");
    const b = await coffre.chiffrer({ meme: "entree" }, "ctx");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a.subarray(1, 13)).equals(Buffer.from(b.subarray(1, 13)))).toBe(false);
    expect(Buffer.from(a.subarray(13)).equals(Buffer.from(b.subarray(13)))).toBe(false);
  });

  it("paquet : version 1, IV de 96 bits, puis le chiffre avec son etiquette de 128 bits", async () => {
    const { coffre } = await fabriquer();
    const clair = octetsAleatoires(50);
    const paquet = await coffre.chiffrer(clair, "ctx");
    expect(paquet[0]).toBe(1);
    expect(paquet.length).toBe(1 + 12 + 50 + 16);
  });

  it("300 IV tires : aucun doublon", async () => {
    const { coffre } = await fabriquer();
    const ivs = new Set<string>();
    for (let i = 0; i < 300; i++) ivs.add(Buffer.from((await coffre.chiffrer(new Uint8Array(1), "ctx")).subarray(1, 13)).toString("hex"));
    expect(ivs.size).toBe(300);
  });

  it("mauvais AAD : rejet, sans dire pourquoi", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ a: 1 }, "bon");
    await expect(coffre.dechiffrer(paquet, "mauvais")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    await expect(coffre.dechiffrerJson(paquet, "mauvais")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("paquet altere : un octet change dans le chiffre, l'etiquette, l'IV ou l'en-tete est rejete", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrer(octetsAleatoires(64), "ctx");
    for (const position of [0, 1, 12, 13, 40, paquet.length - 17, paquet.length - 1]) {
      const copie = Uint8Array.from(paquet);
      copie[position] ^= 0x01;
      await expect(coffre.dechiffrer(copie, "ctx"), `octet ${position}`).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    }
  });

  it("paquet tronque, vide ou d'un autre type : rejete proprement", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ a: 1 }, "ctx");
    await expect(coffre.dechiffrer(paquet.subarray(0, paquet.length - 1), "ctx")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    await expect(coffre.dechiffrer(new Uint8Array(0), "ctx")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    await expect(coffre.dechiffrer(new Uint8Array(20), "ctx")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    await expect(coffre.dechiffrer("pas un paquet" as unknown as Uint8Array, "ctx")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("un objet non serialisable est refuse avec un code", async () => {
    const { coffre } = await fabriquer();
    await expect(coffre.chiffrer(undefined as unknown as object, "ctx")).rejects.toThrow();
  });

  it("un autre compte ne dechiffre pas, meme avec le meme PIN et le meme AAD textuel", async () => {
    const a = await fabriquer(nouveauStockage());
    const b = await fabriquer(nouveauStockage(), { compteId: "user-bob-002", profil: { ...identite, userId: "user-bob-002" } });
    const paquet = await a.coffre.chiffrer({ secret: 1 }, "ctx");
    await expect(b.coffre.dechiffrer(paquet, "ctx")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });
});

describe("blocs (photos)", () => {
  it("aller-retour octet pour octet, type MIME conserve", async () => {
    const { coffre } = await fabriquer();
    const source = octetsAleatoires(100_003);
    const paquet = await coffre.chiffrerBlob(new Blob([source], { type: "image/jpeg" }), "photo-1");
    const relu = await coffre.dechiffrerBlob(paquet, "photo-1");
    expect(relu.type).toBe("image/jpeg");
    expect(relu.size).toBe(source.length);
    expect(Buffer.from(await lireOctets(relu)).equals(Buffer.from(source))).toBe(true);
  });

  it("couvre les 256 valeurs d'octet, le bloc vide et le bloc sans type", async () => {
    const { coffre } = await fabriquer();
    const tous = Uint8Array.from({ length: 256 }, (_, i) => i);
    const a = await coffre.dechiffrerBlob(await coffre.chiffrerBlob(new Blob([tous]), "tous"), "tous");
    expect(Array.from(await lireOctets(a))).toEqual(Array.from(tous));
    expect(a.type).toBe("");
    const vide = await coffre.dechiffrerBlob(await coffre.chiffrerBlob(new Blob([], { type: "image/png" }), "vide"), "vide");
    expect(vide.size).toBe(0);
    expect(vide.type).toBe("image/png");
  });

  it("8 Mio exactement : accepte ; 8 Mio + 1 octet : BLOB_TROP_GROS", async () => {
    const { coffre } = await fabriquer();
    const pile = new Blob([new Uint8Array(TAILLE_MAX_BLOB_OCTETS)], { type: "image/jpeg" });
    const relu = await coffre.dechiffrerBlob(await coffre.chiffrerBlob(pile, "gros"), "gros");
    expect(relu.size).toBe(TAILLE_MAX_BLOB_OCTETS);
    const trop = new Blob([new Uint8Array(TAILLE_MAX_BLOB_OCTETS + 1)]);
    await expect(coffre.chiffrerBlob(trop, "trop")).rejects.toMatchObject({ code: "BLOB_TROP_GROS" });
  });

  it("l'ancienne AAD (aadBlob) vaut compteId|identifiantLocal|version : conservee pour relire les blocs anciens", () => {
    expect(aadBlob("c1", "photo-9", 3)).toBe("c1|photo-9|3");
    expect(() => aadBlob("c1", "a|b", 1)).toThrow();
    expect(() => aadBlob("c1", "", 1)).toThrow();
    expect(() => aadBlob("c1", "x", -1)).toThrow();
    expect(() => aadBlob("c1", "x", 1.5)).toThrow();
  });

  it("aadFile : bdri-coffre|1|file|<nom>|<compteId>|<id>|<rev>, et refuse tout composant vide, avec separateur ou rev invalide", () => {
    expect(aadFile("inspections", "c1", "loc-9", 3)).toBe("bdri-coffre|1|file|inspections|c1|loc-9|3");
    for (const faux of [["", "c1", "x", 1], ["f", "", "x", 1], ["f", "c1", "", 1], ["f|g", "c1", "x", 1], ["f", "c|1", "x", 1], ["f", "c1", "x|y", 1],
      ["f", "c1", "x", -1], ["f", "c1", "x", 1.5], ["f", "c1", "x", Number.NaN]] as Array<[string, string, string, number]>) {
      expect(() => aadFile(...faux), JSON.stringify(faux)).toThrow(ErreurCoffre);
    }
  });

  it("separation des domaines : la meme chaine ne se confond ni avec l'AAD de la cle, ni avec celle du profil, ni d'une file a l'autre", () => {
    const f = aadFile("inspections", COMPTE, "x", 1);
    expect(f).not.toBe(`bdri-coffre|1|cle|${COMPTE}|${APPAREIL}`);
    expect(f).not.toBe(`bdri-coffre|1|profil|${COMPTE}|${APPAREIL}`);
    expect(f.startsWith("bdri-coffre|1|file|")).toBe(true);
    expect(aadFile("defauts", COMPTE, "x", 1)).not.toBe(f);
    expect(aadFile("inspections", COMPTE, "x", 2)).not.toBe(f);
    expect(aadFile("inspections", "autre", "x", 1)).not.toBe(f);
  });

  it("un enregistrement de file ne se relit ni dans une autre file, ni sous une autre revision, ni sous un autre compte", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ saisie: 1 }, aadFile("inspections", COMPTE, "loc-1", 4));
    expect(await coffre.dechiffrerJson(paquet, aadFile("inspections", COMPTE, "loc-1", 4))).toEqual({ saisie: 1 });
    for (const mauvaise of [aadFile("defauts", COMPTE, "loc-1", 4), aadFile("inspections", COMPTE, "loc-1", 5),
      aadFile("inspections", COMPTE, "loc-2", 4), aadFile("inspections", "autre", "loc-1", 4)]) {
      await expect(coffre.dechiffrer(paquet, mauvaise)).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    }
  });

  it("un bloc est ecrit sous l'AAD aadFile(\"blob\", ...) et non plus sous l'ancienne", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrerBlob(new Blob(["abc"], { type: "image/png" }), "photo-1", 2);
    const clair = await coffre.dechiffrer(paquet, aadFile("blob", COMPTE, "photo-1", 2));
    expect(clair[0]).toBe("image/png".length);
    await expect(coffre.dechiffrer(paquet, aadBlob(COMPTE, "photo-1", 2))).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    await expect(coffre.dechiffrer(paquet, aadFile("inspections", COMPTE, "photo-1", 2))).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("transitoire : un bloc ecrit sous l'ancienne AAD se relit encore", async () => {
    const { coffre } = await fabriquer();
    const type = new TextEncoder().encode("image/jpeg");
    const ancien = await coffre.chiffrer(Uint8Array.from([type.length, ...type, 1, 2, 3]), aadBlob(COMPTE, "photo-1", 1));
    const relu = await coffre.dechiffrerBlob(ancien, "photo-1");
    expect(relu.type).toBe("image/jpeg");
    expect(Array.from(await lireOctets(relu))).toEqual([1, 2, 3]);
    await expect(coffre.dechiffrerBlob(ancien, "photo-2")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("un clair vide ou dont le type annonce plus que le contenu n'est pas un bloc", async () => {
    const { coffre } = await fabriquer();
    const vide = await coffre.chiffrer(new Uint8Array(0), aadFile("blob", COMPTE, "x", 1));
    await expect(coffre.dechiffrerBlob(vide, "x")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    const menteur = await coffre.chiffrer(Uint8Array.from([5, 97]), aadFile("blob", COMPTE, "x", 1));
    await expect(coffre.dechiffrerBlob(menteur, "x")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    const juste = await coffre.chiffrer(Uint8Array.from([1, 97]), aadFile("blob", COMPTE, "x", 1));
    expect((await coffre.dechiffrerBlob(juste, "x")).type).toBe("a");
  });

  it("le bloc est lie a son identifiant local : relu sous un autre identifiant, il est rejete", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrerBlob(new Blob(["contenu"]), "photo-1");
    await expect(coffre.dechiffrerBlob(paquet, "photo-2")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("le bloc est lie a sa version de format", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrerBlob(new Blob(["contenu"]), "photo-1", 2);
    expect((await coffre.dechiffrerBlob(paquet, "photo-1", 2)).size).toBe(7);
    await expect(coffre.dechiffrerBlob(paquet, "photo-1", 1)).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    await expect(coffre.dechiffrerBlob(paquet, "photo-1")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("le bloc est lie au compte : un autre compte ne le relit pas", async () => {
    const a = await fabriquer(nouveauStockage());
    const b = await fabriquer(nouveauStockage(), { compteId: "user-bob-002", profil: { ...identite, userId: "user-bob-002" } });
    const paquet = await a.coffre.chiffrerBlob(new Blob(["contenu"]), "photo-1");
    await expect(b.coffre.dechiffrerBlob(paquet, "photo-1")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("un bloc altere (une etiquette changee) est rejete", async () => {
    const { coffre } = await fabriquer();
    const paquet = await coffre.chiffrerBlob(new Blob([octetsAleatoires(500)], { type: "image/jpeg" }), "photo-1");
    const copie = Uint8Array.from(paquet);
    copie[copie.length - 1] ^= 0x80;
    await expect(coffre.dechiffrerBlob(copie, "photo-1")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("un paquet demesure (octet de version VALIDE) est refuse avant tout dechiffrement ; a la borne exacte il est tente", async () => {
    const { coffre } = await fabriquer();
    const borne = 1 + 12 + 1 + 255 + TAILLE_MAX_BLOB_OCTETS + 16;
    const spy = vi.spyOn(globalThis.crypto.subtle, "decrypt");

    // Version 1 : seule la borne de taille peut l'arreter (l'octet de version, lui, est bon).
    const trop = new Uint8Array(borne + 1);
    trop[0] = 1;
    await expect(coffre.dechiffrerBlob(trop, "x")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    expect(spy).not.toHaveBeenCalled();

    // A la borne exacte : la taille ne l'arrete plus, c'est l'etiquette qui le rejette, apres un essai de dechiffrement.
    const pile = new Uint8Array(borne);
    pile[0] = 1;
    await expect(coffre.dechiffrerBlob(pile, "x")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
    expect(spy).toHaveBeenCalled();
  });

  it("deux ecritures du meme bloc : deux IV, deux chiffres differents, les deux se relisent", async () => {
    const { coffre } = await fabriquer();
    const blob = new Blob([octetsAleatoires(2000)], { type: "image/jpeg" });
    const a = await coffre.chiffrerBlob(blob, "photo-1");
    const b = await coffre.chiffrerBlob(blob, "photo-1");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a.subarray(1, 13)).equals(Buffer.from(b.subarray(1, 13)))).toBe(false);
    expect((await coffre.dechiffrerBlob(a, "photo-1")).size).toBe(2000);
    expect((await coffre.dechiffrerBlob(b, "photo-1")).size).toBe(2000);
  });

  it("un type MIME trop long est refuse", async () => {
    const { coffre } = await fabriquer();
    await expect(coffre.chiffrerBlob(new Blob(["x"], { type: "a".repeat(256) }), "id")).rejects.toMatchObject({ code: "ARGUMENT_INVALIDE" });
  });
});

describe("changerPin", () => {
  it("l'ancien PIN cesse de marcher, le nouveau marche, les donnees deja chiffrees restent lisibles", async () => {
    const { stockage, coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ saisie: 1 }, "ctx");
    const avant = await enveloppe(stockage);

    expect(await coffre.changerPin(PIN, "nouveau-pin-77", T0 + MIN)).toEqual({ ok: true });

    const apres = await enveloppe(stockage);
    expect(apres.kdf.sel).not.toBe(avant.kdf.sel); // sel neuf
    expect(apres.cle.iv).not.toBe(avant.cle.iv);
    expect(apres.profil).toBe(avant.profil); // le profil n'est pas rechiffre : la DEK est la meme

    const c = rouvrir(stockage);
    expect(await c.deverrouiller(PIN, T0 + 2 * MIN)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect((await c.deverrouiller("nouveau-pin-77", T0 + 3 * MIN)).ok).toBe(true);
    expect(await c.dechiffrerJson(paquet, "ctx")).toEqual({ saisie: 1 });
  });

  it("ancien PIN faux : PIN_INCORRECT, rien ne change, l'echec est compte", async () => {
    const { stockage, coffre } = await fabriquer();
    const avant = await enveloppe(stockage);
    expect(await coffre.changerPin("000000", "nouveau-pin-77", T0 + MIN)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    const apres = await enveloppe(stockage);
    expect(apres.kdf).toEqual(avant.kdf);
    expect(apres.echecs).toBe(1);
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 2 * MIN)).ok).toBe(true);
  });

  it("nouveau PIN invalide : PIN_INVALIDE avant toute ecriture", async () => {
    const { stockage, coffre } = await fabriquer();
    const avant = JSON.stringify(await enveloppe(stockage));
    expect(await coffre.changerPin(PIN, "123", T0 + MIN)).toEqual({ ok: false, erreur: "PIN_INVALIDE" });
    expect(JSON.stringify(await enveloppe(stockage))).toBe(avant);
  });

  it("fonctionne coffre verrouille, et le laisse verrouille", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    expect(await c.changerPin(PIN, "nouveau-pin-77", T0 + MIN)).toEqual({ ok: true });
    expect(c.estDeverrouille()).toBe(false);
  });

  it("coffre ouvert, il reste ouvert et utilisable", async () => {
    const { coffre } = await fabriquer();
    await coffre.changerPin(PIN, "nouveau-pin-77", T0 + MIN);
    expect(coffre.estDeverrouille()).toBe(true);
    expect(await coffre.dechiffrerJson(await coffre.chiffrer({ ok: 1 }, "c"), "c")).toEqual({ ok: 1 });
  });

  it("sur coffre absent : COFFRE_ABSENT", async () => {
    expect(await rouvrir(nouveauStockage()).changerPin(PIN, "nouveau-pin-77", T0)).toEqual({ ok: false, erreur: "COFFRE_ABSENT" });
  });
});

describe("reinitialiser", () => {
  it("detruit l'enveloppe, verrouille, et rend les anciennes donnees illisibles meme pour un coffre recree", async () => {
    const { stockage, coffre } = await fabriquer();
    const paquet = await coffre.chiffrer({ saisie: "non synchronisee" }, "ctx");
    await coffre.reinitialiser();

    expect(coffre.estDeverrouille()).toBe(false);
    expect(await stockage.get(COMPTE)).toBeNull();
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + MIN)).toEqual({ ok: false, erreur: "COFFRE_ABSENT" });
    expect((await coffre.lireMeta()).existe).toBe(false);

    const { coffre: neuf } = await fabriquer(stockage, { maintenantMs: T0 + 2 * MIN });
    await expect(neuf.dechiffrer(paquet, "ctx")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("ne touche pas le coffre d'un autre compte", async () => {
    const stockage = nouveauStockage();
    const a = await fabriquer(stockage);
    await fabriquer(stockage, { compteId: "user-bob-002", profil: { ...identite, userId: "user-bob-002" } });
    await a.coffre.reinitialiser();
    expect(await stockage.get("user-bob-002")).not.toBeNull();
    expect(await listerComptesAvecCoffre(stockage)).toEqual(["user-bob-002"]);
  });
});

describe("compteur d'echecs persistant", () => {
  /** `pasMs` : ecart entre deux essais. 1 ms = essais enchaines ; 16 min = chaque essai arrive apres le delai precedent. */
  async function echouer(c: CoffreSession, fois: number, debutMs: number, pasMs = 1) {
    let dernier: Awaited<ReturnType<CoffreSession["deverrouiller"]>> | null = null;
    for (let i = 0; i < fois; i++) dernier = await c.deverrouiller("mauvais-pin", debutMs + i * pasMs);
    return dernier;
  }

  it("5 premiers echecs sans delai, le 6e en impose un de 30 s, le 7e de 60 s", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    for (let i = 1; i <= 5; i++) {
      expect(await c.deverrouiller("mauvais-pin", T0 + i)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
      expect((await enveloppe(stockage)).pasAvantMs).toBeNull();
    }
    expect(await c.deverrouiller("mauvais-pin", T0 + 100)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await enveloppe(stockage)).toMatchObject({ echecs: 6, pasAvantMs: T0 + 100 + 30_000 });

    // Pendant le delai : refus immediat, sans derivation, sans compter un echec de plus.
    const espion = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    expect(await c.deverrouiller("mauvais-pin", T0 + 200)).toEqual({ ok: false, erreur: "DELAI_EN_COURS", reessayerDansMs: 29_900 });
    expect(espion).not.toHaveBeenCalled();
    expect((await enveloppe(stockage)).echecs).toBe(6);
    espion.mockRestore();

    expect(await c.deverrouiller("mauvais-pin", T0 + 100 + 30_000)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await enveloppe(stockage)).toMatchObject({ echecs: 7, pasAvantMs: T0 + 100 + 30_000 + 60_000 });
  });

  it("le BON PIN pendant un delai est refuse aussi : le delai ne se contourne pas", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    await echouer(c, 6, T0 + 1);
    const r = await c.deverrouiller(PIN, T0 + 10);
    expect(r).toMatchObject({ ok: false, erreur: "DELAI_EN_COURS" });
    expect(c.estDeverrouille()).toBe(false);
  });

  it("apres le delai, le bon PIN ouvre et remet le compteur a zero", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    await echouer(c, 6, T0 + 1);
    const r = await c.deverrouiller(PIN, T0 + 6 + 30_000);
    expect(r.ok).toBe(true);
    expect(await enveloppe(stockage)).toMatchObject({ echecs: 0, pasAvantMs: null });
  });

  it("le compteur survit au redemarrage : une nouvelle instance voit le meme etat", async () => {
    const { stockage } = await fabriquer();
    await echouer(rouvrir(stockage), 7, T0, 16 * MIN);
    const dernierEssai = T0 + 6 * 16 * MIN;
    const meta = await rouvrir(stockage).lireMeta();
    expect(meta).toMatchObject({ existe: true, echecs: 7, compteId: COMPTE, appareilId: APPAREIL, iterations: IT });
    expect(meta.pasAvantMs).toBe(dernierEssai + 60_000);
    expect(await rouvrir(stockage).deverrouiller(PIN, dernierEssai + 8)).toMatchObject({ erreur: "DELAI_EN_COURS" });
  });

  it("le delai est plafonne a 15 minutes", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    let t = T0;
    for (let i = 0; i < 14; i++) { await c.deverrouiller("mauvais-pin", t); t += 15 * MIN; }
    const e = await enveloppe(stockage);
    expect(e.echecs).toBe(14);
    expect(e.pasAvantMs! - (t - 15 * MIN)).toBe(15 * MIN);
  });

  it("AUCUNE destruction automatique : apres 60 echecs, le coffre est toujours la et le bon PIN l'ouvre", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    let t = T0;
    for (let i = 0; i < 60; i++) { await c.deverrouiller("mauvais-pin", t); t += 16 * MIN; }
    expect((await enveloppe(stockage)).echecs).toBe(60);
    const r = await c.deverrouiller(PIN, t);
    expect(r.ok).toBe(true);
  });

  it("le compteur est ecrit AVANT la derivation : un processus tue pendant l'essai compte quand meme", async () => {
    const { stockage } = await fabriquer();
    const reel = globalThis.crypto;
    const planteur = {
      getRandomValues: reel.getRandomValues.bind(reel),
      subtle: new Proxy(reel.subtle, {
        get(cible, prop) {
          if (prop === "deriveKey") return async () => { throw new Error("processus tue"); };
          const v = Reflect.get(cible, prop);
          return typeof v === "function" ? v.bind(cible) : v;
        },
      }),
    } as Crypto;
    const c = ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, crypto: planteur });
    await c.deverrouiller(PIN, T0 + 1);
    expect((await enveloppe(stockage)).echecs).toBe(1);
  });
});

describe("revalider et prolonger", () => {
  it("revalider apres expiration : le PIN suffit, le profil prend les droits du serveur et une validite neuve", async () => {
    const { stockage } = await fabriquer();
    const tard = T0 + 9 * JOUR;
    expect(await rouvrir(stockage).deverrouiller(PIN, tard)).toMatchObject({ erreur: "EXPIRE" });

    const c = rouvrir(stockage);
    const r = await c.revalider({ pin: PIN, identite: { ...identite, role: "SUPERVISEUR", modules: ["inspection"] }, maintenantMs: tard });
    expect(r).toEqual({
      ok: true,
      profil: { ...identite, role: "SUPERVISEUR", modules: ["inspection"], emisLe: T0, valideLe: tard, expireLe: tard + 7 * JOUR },
    });
    expect(c.estDeverrouille()).toBe(true);

    const plus = await rouvrir(stockage).deverrouiller(PIN, tard + JOUR);
    expect(plus).toMatchObject({ ok: true, profil: { role: "SUPERVISEUR" } });
  });

  it("revalider remet la marque d'horloge a maintenant (un poste dont la date a ete corrigee redevient utilisable)", async () => {
    const { stockage } = await fabriquer();
    await rouvrir(stockage).deverrouiller(PIN, T0 + 2 * JOUR);
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + MIN)).toMatchObject({ erreur: "EXPIRE", motif: "HORLOGE" });
    await rouvrir(stockage).revalider({ pin: PIN, identite, maintenantMs: T0 + MIN });
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 2 * MIN)).ok).toBe(true);
  });

  it("revalider : mauvais PIN refuse et compte ; profil d'un autre compte refuse", async () => {
    const { stockage } = await fabriquer();
    expect(await rouvrir(stockage).revalider({ pin: "000000", identite, maintenantMs: T0 + 1 })).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect((await enveloppe(stockage)).echecs).toBe(1);
    expect(await rouvrir(stockage).revalider({ pin: PIN, identite: { ...identite, userId: "autre" }, maintenantMs: T0 + 2 })).toEqual({ ok: false, erreur: "AUTRE_COMPTE" });
  });

  it("prolonger (coffre ouvert) repousse la validite, sans PIN, et la persiste", async () => {
    const { stockage, coffre } = await fabriquer();
    const dans3Jours = T0 + 3 * JOUR;
    expect(await coffre.prolonger({ maintenantMs: dans3Jours })).toEqual({ ok: true });
    expect(coffre.profilCourant()).toMatchObject({ emisLe: T0, valideLe: dans3Jours, expireLe: dans3Jours + 7 * JOUR });
    // 8 jours apres la creation : serait EXPIRE sans la prolongation.
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 8 * JOUR)).ok).toBe(true);
  });

  it("prolonger avec une nouvelle identite remplace les droits", async () => {
    const { stockage, coffre } = await fabriquer();
    await coffre.prolonger({ maintenantMs: T0 + JOUR, identite: { ...identite, regions: ["Conakry"] } });
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 2 * JOUR)).toMatchObject({ ok: true, profil: { regions: ["Conakry"] } });
  });

  it("prolonger coffre verrouille : VERROUILLE, rien n'est repousse", async () => {
    const { stockage, coffre } = await fabriquer();
    coffre.verrouiller();
    expect(await coffre.prolonger({ maintenantMs: T0 + JOUR })).toEqual({ ok: false, erreur: "VERROUILLE" });
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 8 * JOUR)).toMatchObject({ erreur: "EXPIRE" });
  });
});

describe("aucun secret en clair, aucun jeton", () => {
  /** Espionne `generateKey` pour retrouver les octets de la DEK a la creation (elle est extractible a cet instant seulement). */
  function cryptoEspion() {
    const reel = globalThis.crypto;
    const cles: CryptoKey[] = [];
    const subtle = new Proxy(reel.subtle, {
      get(cible, prop) {
        if (prop === "generateKey") {
          return async (...args: Parameters<SubtleCrypto["generateKey"]>) => {
            const k = (await cible.generateKey(...args)) as CryptoKey;
            cles.push(k);
            return k;
          };
        }
        const v = Reflect.get(cible, prop);
        return typeof v === "function" ? v.bind(cible) : v;
      },
    });
    return { cles, crypto: { subtle, getRandomValues: reel.getRandomValues.bind(reel) } as Crypto };
  }

  it("l'enveloppe serialisee ne contient ni le PIN, ni la DEK (base64, base64url, hexa), ni motif de jeton", async () => {
    const { cles, crypto } = cryptoEspion();
    const stockage = nouveauStockage();
    const profilAvecJeton = {
      ...identite,
      accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLWJpZW4tbG9uZ3VlLXBvdXItbGUtdGVzdA",
      refreshToken: "refresh-secret-0123456789abcdef",
      token: "tok_live_abcdef",
    } as unknown as IdentiteProfil;

    await creerCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, pin: PIN, profil: profilAvecJeton, maintenantMs: T0, ...MODE_TEST, crypto });

    expect(cles).toHaveLength(1);
    const dek = Buffer.from(await crypto.subtle.exportKey("raw", cles[0]));
    expect(dek).toHaveLength(32);

    const brut = stockage.lireBrut(COMPTE)!;
    expect(brut).not.toContain(PIN);
    expect(brut).not.toContain(dek.toString("base64"));
    expect(brut).not.toContain(dek.toString("base64url"));
    expect(brut).not.toContain(dek.toString("hex"));
    expect(brut).not.toContain(dek.toString("latin1"));
    expect(brut).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}/);
    expect(brut).not.toContain("refresh-secret");
    expect(brut).not.toContain("tok_live");
    // Les noms de champ de l'enveloppe ne parlent pas de jeton.
    const cle = (o: unknown): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...cle(v)]) : []);
    expect(cle(JSON.parse(brut)).filter((k) => /token|jeton|password|motdepasse|secret|^pin$/i.test(k))).toEqual([]);
    // Le profil lui-meme est chiffre : ni le nom ni le role ne sont lisibles.
    expect(brut).not.toContain("Alice");
    expect(brut).not.toContain("AGENT_TERRAIN");
    expect(brut).not.toContain("Kankan");
  });

  it("un jeton glisse dans l'identite n'entre pas dans le profil dechiffre", async () => {
    const stockage = nouveauStockage();
    const profil = { ...identite, accessToken: "a", refreshToken: "b", token: "c" } as unknown as IdentiteProfil;
    await creerCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, pin: PIN, profil, maintenantMs: T0, ...MODE_TEST });
    const r = await rouvrir(stockage).deverrouiller(PIN, T0 + 1);
    expect(r.ok && Object.keys(r.profil).sort()).toEqual(
      ["emisLe", "expireLe", "modules", "nom", "regions", "role", "userId", "valideLe"],
    );
  });

  it("la DEK en memoire n'est pas extractible", async () => {
    const { coffre } = await fabriquer();
    const interne = (coffre as unknown as { dek: CryptoKey }).dek;
    expect(interne.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("raw", interne)).rejects.toThrow();
  });

  it("aucune sortie console, et aucun message d'erreur ne porte le PIN", async () => {
    const consoles = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const { stockage, coffre } = await fabriquer();
    await coffre.chiffrer({ a: 1 }, "ctx");
    const c = rouvrir(stockage);
    await c.deverrouiller("mauvais-pin-xyz", T0 + 1);
    await c.deverrouiller(PIN, T0 + 2);
    await c.changerPin(PIN, "nouveau-pin-77", T0 + 3);
    const erreurs: Error[] = [];
    try { await rouvrir(stockage).chiffrer({}, "x"); } catch (e) { erreurs.push(e as Error); }
    try { await coffre.dechiffrer(new Uint8Array(40), "x"); } catch (e) { erreurs.push(e as Error); }
    await coffre.reinitialiser();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(erreurs).toHaveLength(2);
    for (const e of erreurs) {
      expect(e).toBeInstanceOf(ErreurCoffre);
      expect(e.message).toBe((e as ErreurCoffre).code);
      expect(e.message).not.toContain(PIN);
    }
  });

  it("deux coffres du meme PIN ne partagent ni sel ni DEK : leurs enveloppes de cle different", async () => {
    const a = await enveloppe((await fabriquer()).stockage);
    const b = await enveloppe((await fabriquer()).stockage);
    expect(a.cle.enveloppee).not.toBe(b.cle.enveloppee);
    expect(a.kdf.sel).not.toBe(b.kdf.sel);
  });
});

describe("stockage", () => {
  it("stockageEnMemoire : copie profonde, liste des cles, suppression", async () => {
    const s = stockageEnMemoire();
    expect(await s.get("x")).toBeNull();
    const { stockage } = await fabriquer(s);
    const lu = await stockage.get(COMPTE);
    (lu as { echecs: number }).echecs = 99;
    expect((await stockage.get(COMPTE))!.echecs).toBe(0);
    expect(await stockage.cles()).toEqual([COMPTE]);
    await stockage.delete(COMPTE);
    expect(await stockage.cles()).toEqual([]);
  });

  it("stockageIndexedDb : memes contrats, essayes contre une IndexedDB factice (pas un vrai navigateur)", async () => {
    const donnees = new Map<string, unknown>();
    let versions = 0;
    let magasinCree = false;
    const fauxMagasin = (tx: { oncomplete: (() => void) | null; onerror: (() => void) | null }) => {
      const requete = <T,>(resultat: T) => {
        const r = { result: resultat, error: null };
        setTimeout(() => tx.oncomplete?.(), 0);
        return r;
      };
      return {
        get: (k: string) => requete(donnees.get(k)),
        put: (v: unknown, k: string) => { donnees.set(k, JSON.parse(JSON.stringify(v))); return requete(k); },
        // Comme IndexedDB : `add` sur une cle presente echoue par une ConstraintError, signalee par la transaction.
        add: (v: unknown, k: string) => {
          if (!donnees.has(k)) { donnees.set(k, JSON.parse(JSON.stringify(v))); return requete(k); }
          const r: { result: unknown; error: unknown } = { result: undefined, error: null };
          setTimeout(() => { r.error = { name: "ConstraintError" }; tx.onerror?.(); }, 0);
          return r;
        },
        delete: (k: string) => { donnees.delete(k); return requete(undefined); },
        getAllKeys: () => requete([...donnees.keys()]),
      };
    };
    const fauxIndexedDb = {
      open(nom: string, version: number) {
        expect(nom).toBe("bdri-coffre-test");
        expect(version).toBe(1);
        const req: { result: unknown; error: null; onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null; onerror: (() => void) | null } =
          { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        setTimeout(() => {
          versions++;
          req.result = {
            objectStoreNames: { contains: () => magasinCree },
            createObjectStore: (n: string) => { expect(n).toBe("enveloppes"); magasinCree = true; },
            transaction: (n: string) => {
              expect(n).toBe("enveloppes");
              const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: null; error: null; objectStore: () => unknown } =
                { oncomplete: null, onerror: null, onabort: null, error: null, objectStore: () => fauxMagasin(tx) };
              return tx;
            },
          };
          if (!magasinCree) req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      },
    };
    vi.stubGlobal("indexedDB", fauxIndexedDb);

    const s = stockageIndexedDb("bdri-coffre-test");
    expect(await s.get(COMPTE)).toBeNull();
    const { coffre } = await fabriquer(s as ReturnType<typeof nouveauStockage>);
    const paquet = await coffre.chiffrer({ via: "idb" }, "ctx");
    expect(await s.cles()).toEqual([COMPTE]);
    expect(versions).toBe(1); // une seule ouverture, partagee

    // Nouvelle instance de stockage = redemarrage : le coffre se rouvre depuis la « base ».
    const s2 = stockageIndexedDb("bdri-coffre-test");
    const c2 = ouvrirCoffre({ stockage: s2, compteId: COMPTE, appareilId: APPAREIL, ...MODE_TEST });
    expect((await c2.deverrouiller(PIN, T0 + 1)).ok).toBe(true);
    expect(await c2.dechiffrerJson(paquet, "ctx")).toEqual({ via: "idb" });
    // `add` : une cle presente donne COFFRE_EXISTANT (la ConstraintError d'IndexedDB), jamais un ecrasement.
    const avant = JSON.stringify(await s2.get(COMPTE));
    await expect(s2.add(COMPTE, (await s2.get(COMPTE))!)).rejects.toMatchObject({ code: "COFFRE_EXISTANT" });
    expect(JSON.stringify(await s2.get(COMPTE))).toBe(avant);
    await expect(fabriquer(s2 as ReturnType<typeof nouveauStockage>)).rejects.toMatchObject({ code: "COFFRE_EXISTANT" });
    await c2.reinitialiser();
    expect(await s2.cles()).toEqual([]);
  });
});

describe("outils", () => {
  it("sha256WebCrypto est l'adaptateur reel du port : vecteur « abc » via empreinteCompte", async () => {
    expect(await empreinteCompte("abc", sha256WebCrypto)).toBe("ba7816bf8f01cfea");
    const complet = Buffer.from(await sha256WebCrypto(new TextEncoder().encode("abc")) as Uint8Array).toString("hex");
    expect(complet).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("mesurerDerivationMs rend une duree positive pour un petit nombre de tours", async () => {
    expect(await mesurerDerivationMs(1000)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Outils d'observation et de simultaneite
// ---------------------------------------------------------------------------------------------------

/** Une porte : `atteinte` se resout quand le code teste y arrive, `ouverte` quand le test la laisse passer. */
function porte() {
  let liberer!: () => void;
  let signaler!: () => void;
  const ouverte = new Promise<void>((r) => { liberer = r; });
  const atteinte = new Promise<void>((r) => { signaler = r; });
  return { liberer, signaler, ouverte, atteinte };
}

type Ecoute = { avantDeriveKey?: () => Promise<void>; avantEncrypt?: () => Promise<void> };

/** WebCrypto reel, observe : garde les cles produites et peut suspendre une derivation ou un chiffrement. */
function cryptoObserve(ecoute: Ecoute = {}) {
  const reel = globalThis.crypto;
  const derivees: { algo: Parameters<SubtleCrypto["deriveKey"]>[0]; cle: CryptoKey }[] = [];
  const deballees: CryptoKey[] = [];
  const generees: CryptoKey[] = [];
  const subtle = new Proxy(reel.subtle, {
    get(cible, prop) {
      if (prop === "deriveKey") {
        return async (...a: Parameters<SubtleCrypto["deriveKey"]>) => {
          await ecoute.avantDeriveKey?.();
          const cle = await cible.deriveKey(...a);
          derivees.push({ algo: a[0], cle });
          return cle;
        };
      }
      if (prop === "unwrapKey") {
        return async (...a: Parameters<SubtleCrypto["unwrapKey"]>) => {
          const cle = await cible.unwrapKey(...a);
          deballees.push(cle);
          return cle;
        };
      }
      if (prop === "generateKey") {
        return async (...a: Parameters<SubtleCrypto["generateKey"]>) => {
          const cle = (await cible.generateKey(...a)) as CryptoKey;
          generees.push(cle);
          return cle;
        };
      }
      if (prop === "encrypt") {
        return async (...a: Parameters<SubtleCrypto["encrypt"]>) => {
          await ecoute.avantEncrypt?.();
          return cible.encrypt(...a);
        };
      }
      const v = Reflect.get(cible, prop);
      return typeof v === "function" ? v.bind(cible) : v;
    },
  });
  return { derivees, deballees, generees, ecoute, crypto: { subtle, getRandomValues: reel.getRandomValues.bind(reel) } as Crypto };
}

/** `crypto` dont `getRandomValues` rend, dans l'ordre, des fragments imposes (sel, IV...) ; WebCrypto reste le reel. */
function cryptoDeterministe(fragments: Uint8Array[]) {
  const reel = globalThis.crypto;
  let i = 0;
  const getRandomValues = <T extends ArrayBufferView | null>(a: T): T => {
    const f = fragments[i++];
    if (!f || !a || f.length !== a.byteLength) throw new Error("fragment aleatoire inattendu");
    (a as unknown as Uint8Array).set(f);
    return a;
  };
  return { crypto: { subtle: reel.subtle, getRandomValues } as unknown as Crypto, consommes: () => i };
}

/** Gestionnaire de verrous factice : tient le journal des noms demandes et serialise (comme Web Locks). */
function verrousSerialises() {
  const noms: string[] = [];
  let file: Promise<unknown> = Promise.resolve();
  const request = <T,>(nom: string, cb: () => Promise<T>): Promise<T> => {
    noms.push(nom);
    const p = file.then(() => cb());
    file = p.then(() => undefined, () => undefined);
    return p;
  };
  return { noms, locks: { request } };
}

/** Gestionnaire de verrous qui N'exclut rien : simule deux contextes sans exclusion mutuelle effective. */
function verrousNonExclusifs() {
  const noms: string[] = [];
  const request = <T,>(nom: string, cb: () => Promise<T>): Promise<T> => { noms.push(nom); return cb(); };
  return { noms, locks: { request } };
}

const b64 = (o: Uint8Array | Buffer) => Buffer.from(o).toString("base64");
const deB64 = (s: string) => Buffer.from(s, "base64");

const VARIANTES_VERROU: Array<[string, () => void]> = [
  ["Web Locks de la plateforme", () => undefined],
  ["repli en memoire (navigator.locks absent)", () => { vi.stubGlobal("navigator", {}); }],
];

// ---------------------------------------------------------------------------------------------------
// Simultaneite
// ---------------------------------------------------------------------------------------------------

describe("avecVerrouCoffre", () => {
  it.each(VARIANTES_VERROU)("exclusion mutuelle par compte, comptes independants, erreur propagee puis verrou libere : %s", async (_nom, installer) => {
    installer();
    let actifs = 0;
    let max = 0;
    const journal: string[] = [];
    const tache = (n: string) => async () => {
      actifs++; max = Math.max(max, actifs); journal.push(`debut ${n}`);
      await new Promise((r) => setTimeout(r, 5));
      journal.push(`fin ${n}`); actifs--;
      return n;
    };
    expect(await Promise.all(["1", "2", "3"].map((n) => avecVerrouCoffre("cpt-a", tache(n))))).toEqual(["1", "2", "3"]);
    expect(max).toBe(1);
    expect(journal).toEqual(["debut 1", "fin 1", "debut 2", "fin 2", "debut 3", "fin 3"]);

    // Un autre compte n'attend pas celui qui est bloque.
    const bloc = porte();
    const lent = avecVerrouCoffre("cpt-b", async () => { bloc.signaler(); await bloc.ouverte; return "lent"; });
    await bloc.atteinte;
    expect(await avecVerrouCoffre("cpt-c", async () => "libre")).toBe("libre");
    bloc.liberer();
    expect(await lent).toBe("lent");

    // Une tache qui jette ne garde pas le verrou.
    await expect(avecVerrouCoffre("cpt-d", async () => { throw new Error("boum"); })).rejects.toThrow("boum");
    expect(await avecVerrouCoffre("cpt-d", async () => "suite")).toBe("suite");
  });

  it("le nom du verrou Web Locks est bdri-coffre:<compteId> ; une tache qui jette n'est pas rejouee par le repli", async () => {
    const v = verrousSerialises();
    vi.stubGlobal("navigator", { locks: v.locks });
    let executions = 0;
    await expect(avecVerrouCoffre("cpt-x", async () => { executions++; throw new Error("echec de la tache"); })).rejects.toThrow("echec de la tache");
    expect(v.noms).toEqual(["bdri-coffre:cpt-x"]);
    expect(executions).toBe(1);
  });

  it("Web Locks qui refuse avant de lancer la tache (document inactif) : repli en memoire, la tache s'execute une fois", async () => {
    vi.stubGlobal("navigator", { locks: { request: () => Promise.reject(new DOMException("inactif", "SecurityError")) } });
    let executions = 0;
    expect(await avecVerrouCoffre("cpt-y", async () => { executions++; return "ok"; })).toBe("ok");
    expect(executions).toBe(1);
  });
});

describe("simultaneite : creation", () => {
  const tenter = (stockage: StockageCoffre, pin: string, surcharge = {}) =>
    creerCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, pin, profil: identite, maintenantMs: T0, ...MODE_TEST, ...surcharge });

  async function verifierUnSeulGagnant(stockage: StockageCoffre, essais: Array<[string, Promise<CoffreSession>]>) {
    const res = await Promise.allSettled(essais.map(([, p]) => p));
    const gagnants = res.flatMap((r, i) => (r.status === "fulfilled" ? [{ i, coffre: r.value }] : []));
    expect(gagnants).toHaveLength(1);
    for (const r of res) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "COFFRE_EXISTANT" });

    const [pinGagnant] = essais[gagnants[0].i];
    const paquet = await gagnants[0].coffre.chiffrer({ saisie: "du gagnant" }, "ctx");
    // Aucune donnee perdue : le coffre qui reste est celui du gagnant, et ce qu'il a chiffre se relit.
    const rouvert = rouvrir(stockage);
    expect((await rouvert.deverrouiller(pinGagnant, T0 + 5)).ok).toBe(true);
    expect(await rouvert.dechiffrerJson(paquet, "ctx")).toEqual({ saisie: "du gagnant" });
    for (const [pin] of essais) {
      if (pin !== pinGagnant) expect(await rouvrir(stockage).deverrouiller(pin, T0 + 6)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    }
  }

  it.each(VARIANTES_VERROU)("(a) trois creerCoffre simultanes : un seul reussit, COFFRE_EXISTANT pour les autres, aucune donnee perdue : %s", async (_nom, installer) => {
    installer();
    const stockage = nouveauStockage();
    await verifierUnSeulGagnant(stockage, [["pin-premier-1", tenter(stockage, "pin-premier-1")], ["pin-deuxieme-2", tenter(stockage, "pin-deuxieme-2")], ["pin-troisieme-3", tenter(stockage, "pin-troisieme-3")]]);
  });

  it("(a) sans exclusion mutuelle entre contextes (verrou qui n'exclut rien), `add` du port suffit a n'en laisser passer qu'une", async () => {
    const v = verrousNonExclusifs();
    vi.stubGlobal("navigator", { locks: v.locks });
    const stockage = nouveauStockage();
    await verifierUnSeulGagnant(stockage, [["pin-premier-1", tenter(stockage, "pin-premier-1")], ["pin-deuxieme-2", tenter(stockage, "pin-deuxieme-2")]]);
    expect(v.noms.length).toBeGreaterThanOrEqual(2);
    expect(new Set(v.noms)).toEqual(new Set([`bdri-coffre:${COMPTE}`])); // les deux creations ont bien demande le verrou, qui ne les a pas serialisees
  });

  it("port sans `add` : le verrou assure l'exclusion (get puis put sous verrou)", async () => {
    const base = nouveauStockage();
    const sansAdd: StockageCoffre = { get: (k) => base.get(k), put: (k, e) => base.put(k, e), delete: (k) => base.delete(k), cles: () => base.cles() };
    await verifierUnSeulGagnant(sansAdd, [["pin-premier-1", tenter(sansAdd, "pin-premier-1")], ["pin-deuxieme-2", tenter(sansAdd, "pin-deuxieme-2")]]);
  });

  it("la creation utilise `add` du port (et non put) ; une cle existante n'est jamais ecrasee", async () => {
    const base = nouveauStockage();
    const appels: string[] = [];
    const espion: StockageCoffre = {
      get: (k) => base.get(k),
      put: async (k, e) => { appels.push("put"); return base.put(k, e); },
      add: async (k, e) => { appels.push("add"); return base.add(k, e); },
      delete: (k) => base.delete(k),
      cles: () => base.cles(),
    };
    await tenter(espion, PIN);
    expect(appels).toEqual(["add"]);
    const avant = JSON.stringify(await base.get(COMPTE));
    await expect(tenter(espion, "autre-pin-99")).rejects.toMatchObject({ code: "COFFRE_EXISTANT" });
    expect(JSON.stringify(await base.get(COMPTE))).toBe(avant);
  });

  it("stockageEnMemoire.add refuse une cle presente", async () => {
    const s = nouveauStockage();
    await fabriquer(s);
    await expect(s.add(COMPTE, (await s.get(COMPTE))!)).rejects.toMatchObject({ code: "COFFRE_EXISTANT" });
  });
});

describe("simultaneite : operations sous verrou", () => {
  it("chaque operation qui lit puis ecrit passe par le verrou bdri-coffre:<compteId> ; la lecture seule non", async () => {
    const v = verrousSerialises();
    vi.stubGlobal("navigator", { locks: v.locks });
    const attendu = `bdri-coffre:${COMPTE}`;
    const compter = async (nom: string, action: () => Promise<unknown>, n: number) => {
      const avant = v.noms.length;
      await action();
      expect(v.noms.length - avant, nom).toBe(n);
      expect(new Set(v.noms)).toEqual(new Set([attendu]));
    };

    const stockage = nouveauStockage();
    let coffre!: CoffreSession;
    await compter("creer", async () => { coffre = (await fabriquer(stockage)).coffre; }, 1);
    await compter("deverrouiller", () => coffre.deverrouiller(PIN, T0 + 1), 1);
    await compter("changerPin", () => coffre.changerPin(PIN, NOUVEAU_PIN, T0 + 2), 1);
    await compter("revalider", () => coffre.revalider({ pin: NOUVEAU_PIN, identite, maintenantMs: T0 + 3 }), 1);
    await compter("prolonger", () => coffre.prolonger({ maintenantMs: T0 + 4 }), 1);
    await compter("noterInstant", () => coffre.noterInstant(T0 + 5 * MIN), 1);
    await compter("lireMeta", () => coffre.lireMeta(), 0);
    await compter("reinitialiser", () => coffre.reinitialiser(), 1);
  });

  it.each(VARIANTES_VERROU)("(b) 5 echecs de PIN simultanes comptent 5 : %s", async (_nom, installer) => {
    installer();
    const { stockage } = await fabriquer();
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => rouvrir(stockage).deverrouiller(`mauvais-${i}-pin`, T0 + 1)));
    expect(res).toEqual(Array.from({ length: 5 }, () => ({ ok: false, erreur: "PIN_INCORRECT" })));
    expect(await enveloppe(stockage)).toMatchObject({ echecs: 5, pasAvantMs: null });
  });

  it.each(VARIANTES_VERROU)("(b) 20 echecs simultanes : 6 comptes (le 6e declenche le delai de 30 s), les 14 autres sont refuses par le delai : %s", async (_nom, installer) => {
    installer();
    const { stockage } = await fabriquer();
    const espion = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    const unique = rouvrir(stockage);
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => unique.deverrouiller(`mauvais-${i}-pin`, T0 + 1)));
    expect(res.filter((r) => !r.ok && r.erreur === "PIN_INCORRECT")).toHaveLength(6);
    const retardes = res.filter((r) => !r.ok && r.erreur === "DELAI_EN_COURS");
    expect(retardes).toHaveLength(14);
    for (const r of retardes) expect(r).toEqual({ ok: false, erreur: "DELAI_EN_COURS", reessayerDansMs: 30_000 });
    expect(await enveloppe(stockage)).toMatchObject({ echecs: 6, pasAvantMs: T0 + 1 + 30_000 });
    expect(espion).toHaveBeenCalledTimes(6); // les essais refuses par le delai ne derivent rien
  });

  it("le delai s'applique aux essais paralleles : le BON PIN lance en meme temps que d'autres, pendant un delai, n'ouvre rien", async () => {
    const { stockage } = await fabriquer();
    for (let i = 0; i < 6; i++) await rouvrir(stockage).deverrouiller("mauvais-pin", T0 + 1 + i);
    const coffres = Array.from({ length: 5 }, () => rouvrir(stockage));
    const res = await Promise.all(coffres.map((c) => c.deverrouiller(PIN, T0 + 10)));
    for (const r of res) expect(r).toMatchObject({ ok: false, erreur: "DELAI_EN_COURS" });
    expect(coffres.some((c) => c.estDeverrouille())).toBe(false);
    expect((await enveloppe(stockage)).echecs).toBe(6);
  });

  it("(c) changerPin et deverrouiller lances ensemble, dans les deux ordres : un seul PIN valide a la fin", async () => {
    for (const ordre of ["deverrouiller d'abord", "changerPin d'abord"] as const) {
      const { stockage } = await fabriquer();
      const d = rouvrir(stockage);
      const c = rouvrir(stockage);
      const [rD, rC] = ordre === "deverrouiller d'abord"
        ? await Promise.all([d.deverrouiller(PIN, T0 + 10), c.changerPin(PIN, NOUVEAU_PIN, T0 + 11)])
        : await (async () => { const rc = c.changerPin(PIN, NOUVEAU_PIN, T0 + 11); const rd = d.deverrouiller(PIN, T0 + 10); return [await rd, await rc] as const; })();
      expect(rC, ordre).toEqual({ ok: true });
      if (ordre === "deverrouiller d'abord") expect(rD.ok).toBe(true);
      else expect(rD).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
      expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 30), ordre).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
      expect((await rouvrir(stockage).deverrouiller(NOUVEAU_PIN, T0 + 31)).ok, ordre).toBe(true);
    }
  });

  it("(c) deux changerPin simultanes : le second ne voit plus l'ancien PIN, un seul nouveau PIN est valide", async () => {
    const { stockage } = await fabriquer();
    const [r1, r2] = await Promise.all([
      rouvrir(stockage).changerPin(PIN, "premier-pin-11", T0 + 1),
      rouvrir(stockage).changerPin(PIN, "second-pin-22", T0 + 2),
    ]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect((await rouvrir(stockage).deverrouiller("premier-pin-11", T0 + 30)).ok).toBe(true);
    expect((await rouvrir(stockage).deverrouiller("second-pin-22", T0 + 31)).ok).toBe(false);
  });

  it("(c) sans exclusion entre contextes : un deverrouillage qui a derive AVANT un changement de PIN ne rouvre pas l'ancien PIN", async () => {
    vi.stubGlobal("navigator", { locks: verrousNonExclusifs().locks });
    const { stockage } = await fabriquer();
    const p = porte();
    const obs = cryptoObserve({ avantDeriveKey: async () => { p.signaler(); await p.ouverte; } });
    const b = rouvrir(stockage, { crypto: obs.crypto });
    const pB = b.deverrouiller(PIN, T0 + 10);
    await p.atteinte; // B a compte son essai et attend sa derivation

    expect(await rouvrir(stockage).changerPin(PIN, NOUVEAU_PIN, T0 + 20)).toEqual({ ok: true });
    p.liberer();

    expect(await pB).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect(b.estDeverrouille()).toBe(false);
    // La reecriture de B n'a pas ressuscite l'ancienne enveloppe de cle.
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 30)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect((await rouvrir(stockage).deverrouiller(NOUVEAU_PIN, T0 + 31)).ok).toBe(true);
  });

  it("(c) sans exclusion : un changerPin dont la seconde derivation (nouveau PIN) est depassee par un autre changerPin n'ecrase pas celui-ci", async () => {
    vi.stubGlobal("navigator", { locks: verrousNonExclusifs().locks });
    const { stockage } = await fabriquer();
    const p = porte();
    let appels = 0;
    const obs = cryptoObserve({ avantDeriveKey: async () => { if (++appels === 2) { p.signaler(); await p.ouverte; } } });
    const a = rouvrir(stockage, { crypto: obs.crypto });
    const pA = a.changerPin(PIN, "pin-de-a-1111", T0 + 10); // 1re derivation : ancien PIN ; 2e : nouveau PIN, suspendue
    await p.atteinte;
    expect(await rouvrir(stockage).changerPin(PIN, "pin-de-b-2222", T0 + 20)).toEqual({ ok: true });
    p.liberer();
    expect(await pA).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect((await rouvrir(stockage).deverrouiller("pin-de-b-2222", T0 + 30)).ok).toBe(true);
    expect((await rouvrir(stockage).deverrouiller("pin-de-a-1111", T0 + 31)).ok).toBe(false);
  });

  it("apres la derivation, l'enveloppe est RELUE : une ecriture faite ailleurs entre-temps (profil prolonge, marque d'horloge) survit", async () => {
    vi.stubGlobal("navigator", { locks: verrousNonExclusifs().locks });
    const { stockage } = await fabriquer();
    const ailleurs = rouvrir(stockage);
    expect((await ailleurs.deverrouiller(PIN, T0 + 1)).ok).toBe(true);

    const p = porte();
    const obs = cryptoObserve({ avantDeriveKey: async () => { p.signaler(); await p.ouverte; } });
    const c = rouvrir(stockage, { crypto: obs.crypto });
    const pC = c.deverrouiller(PIN, T0 + 10);
    await p.atteinte;

    // Pendant la derivation de C, l'autre contexte prolonge la session de 3 jours.
    expect(await ailleurs.prolonger({ maintenantMs: T0 + 3 * JOUR })).toEqual({ ok: true });
    p.liberer();

    const r = await pC;
    expect(r).toMatchObject({ ok: true, profil: { valideLe: T0 + 3 * JOUR } }); // le profil lu est le profil COURANT
    const e = await enveloppe(stockage);
    expect(e.dernierInstantMs).toBe(T0 + 3 * JOUR); // la marque n'a pas ete reabaissee par un instantane perime
    expect(e.echecs).toBe(0);
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 9 * JOUR)).ok).toBe(true); // validite prolongee conservee
  });

  it("prolonger ne baisse jamais la marque d'horloge ; noterInstant concurrent n'est pas ecrase", async () => {
    const { stockage, coffre } = await fabriquer();
    await coffre.noterInstant(T0 + 5 * MIN);
    expect(await coffre.prolonger({ maintenantMs: T0 + MIN })).toEqual({ ok: true });
    expect((await enveloppe(stockage)).dernierInstantMs).toBe(T0 + 5 * MIN);
    await Promise.all([coffre.noterInstant(T0 + 9 * MIN), coffre.prolonger({ maintenantMs: T0 + 7 * MIN }), coffre.noterInstant(T0 + 8 * MIN)]);
    expect((await enveloppe(stockage)).dernierInstantMs).toBe(T0 + 9 * MIN);
  });

  it("`rev` : +1 a chaque ecriture, absent des enveloppes anciennes (lu comme 0) sans que le format `v` change", async () => {
    const { stockage, coffre } = await fabriquer();
    expect((await enveloppe(stockage)).rev).toBe(1);
    await coffre.noterInstant(T0 + MIN);
    expect((await enveloppe(stockage)).rev).toBe(2);
    await coffre.prolonger({ maintenantMs: T0 + 2 * MIN });
    expect((await enveloppe(stockage)).rev).toBe(3);
    await rouvrir(stockage).deverrouiller(PIN, T0 + 3 * MIN); // compte l'essai, puis le succes
    expect((await enveloppe(stockage)).rev).toBe(5);

    const ancienne = { ...(await enveloppe(stockage)) } as { rev?: number };
    delete ancienne.rev;
    await stockage.put(COMPTE, ancienne as EnveloppeCoffre);
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 4 * MIN)).ok).toBe(true);
    expect((await enveloppe(stockage)).rev).toBe(2);
    expect((await enveloppe(stockage)).v).toBe(1);

    await stockage.put(COMPTE, { ...(await enveloppe(stockage)), rev: -1 });
    expect((await rouvrir(stockage).lireMeta()).existe).toBe(false);
    await stockage.put(COMPTE, { ...(await enveloppe(stockage)), rev: 1.5 });
    expect((await rouvrir(stockage).lireMeta()).existe).toBe(false);
  });
});

describe("verrouiller() pendant une operation en vol (jeton de generation)", () => {
  it("deverrouiller : le verrou survenu pendant la derivation l'emporte, rien n'est restaure", async () => {
    const { stockage } = await fabriquer();
    const p = porte();
    const obs = cryptoObserve({ avantDeriveKey: async () => { p.signaler(); await p.ouverte; } });
    const c = rouvrir(stockage, { crypto: obs.crypto });
    const pending = c.deverrouiller(PIN, T0 + 1);
    await p.atteinte;
    c.verrouiller();
    p.liberer();
    expect(await pending).toEqual({ ok: false, erreur: "VERROUILLE" });
    expect(c.estDeverrouille()).toBe(false);
    expect(c.profilCourant()).toBeNull();
    // Une demande posterieure au verrou, elle, ouvre.
    expect((await c.deverrouiller(PIN, T0 + 2)).ok).toBe(true);
    expect(c.estDeverrouille()).toBe(true);
  });

  it("revalider : meme garantie", async () => {
    const { stockage } = await fabriquer();
    const p = porte();
    const obs = cryptoObserve({ avantDeriveKey: async () => { p.signaler(); await p.ouverte; } });
    const c = rouvrir(stockage, { crypto: obs.crypto });
    const pending = c.revalider({ pin: PIN, identite, maintenantMs: T0 + 1 });
    await p.atteinte;
    c.verrouiller();
    p.liberer();
    expect(await pending).toEqual({ ok: false, erreur: "VERROUILLE" });
    expect(c.estDeverrouille()).toBe(false);
    expect(c.profilCourant()).toBeNull();
  });

  it.each(VARIANTES_VERROU)("prolonger en attente du verrou puis verrouiller() : VERROUILLE, rien d'ecrit, rien de restaure : %s", async (_nom, installer) => {
    installer();
    const { stockage, coffre } = await fabriquer();
    // Une autre operation tient le verrou : la prolongation attend son tour.
    const bloc = porte();
    const occupant = avecVerrouCoffre(COMPTE, async () => { bloc.signaler(); await bloc.ouverte; });
    await bloc.atteinte;
    const pending = coffre.prolonger({ maintenantMs: T0 + 3 * JOUR });
    coffre.verrouiller();
    bloc.liberer();
    await occupant;
    expect(await pending).toEqual({ ok: false, erreur: "VERROUILLE" });
    expect(coffre.profilCourant()).toBeNull();
    expect(coffre.estDeverrouille()).toBe(false);
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 8 * JOUR)).toMatchObject({ erreur: "EXPIRE" }); // validite non repoussee
  });

  it("prolonger en attente, verrouiller() PUIS rouverture avant son tour : la prolongation est annulee meme si la cle est de nouveau en memoire", async () => {
    // Gestionnaire de verrous pilote a la main : on choisit l'ordre d'execution des taches.
    const attente: Array<() => void> = [];
    const request = <T,>(_nom: string, cb: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => { attente.push(() => { cb().then(resolve, reject); }); });
    vi.stubGlobal("navigator", { locks: { request } });
    const stockage = nouveauStockage();
    const pCreation = fabriquer(stockage);
    await vi.waitFor(() => expect(attente).toHaveLength(1));
    attente[0]();
    const { coffre } = await pCreation;

    const prolongation = coffre.prolonger({ maintenantMs: T0 + 3 * JOUR }); // demande #1, en attente
    coffre.verrouiller();
    const ouverture = coffre.deverrouiller(PIN, T0 + 1); // demande #2
    await vi.waitFor(() => expect(attente).toHaveLength(3));
    attente[2](); // la reouverture passe d'abord
    expect((await ouverture).ok).toBe(true);
    expect(coffre.estDeverrouille()).toBe(true);
    attente[1](); // puis la prolongation, lancee avant le verrou
    expect(await prolongation).toEqual({ ok: false, erreur: "VERROUILLE" });
    expect(coffre.profilCourant()?.valideLe).toBe(T0); // inchange
    vi.unstubAllGlobals();
    expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 8 * JOUR)).toMatchObject({ erreur: "EXPIRE" });
  });

  it("creer : verrouiller() pendant la creation laisse le coffre cree mais verrouille (rien n'est restaure)", async () => {
    const p = porte();
    const obs = cryptoObserve({ avantDeriveKey: async () => { p.signaler(); await p.ouverte; } });
    const stockage = nouveauStockage();
    const coffre = new CoffreSession({ stockage, compteId: COMPTE, appareilId: APPAREIL, ...MODE_TEST, crypto: obs.crypto });
    const pending = coffre.creer(PIN, identite, T0);
    await p.atteinte;
    coffre.verrouiller();
    p.liberer();
    await pending;
    expect(coffre.estDeverrouille()).toBe(false);
    expect(coffre.profilCourant()).toBeNull();
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 1)).ok).toBe(true); // le coffre existe bien
  });

  it("prolonger : verrouiller() pendant l'ecriture du profil ne remet pas le profil en memoire (la prolongation, elle, est persistee)", async () => {
    const obs = cryptoObserve();
    const { stockage, coffre } = await fabriquer(nouveauStockage(), { crypto: obs.crypto });
    const p = porte();
    obs.ecoute.avantEncrypt = async () => { p.signaler(); await p.ouverte; };
    const pending = coffre.prolonger({ maintenantMs: T0 + 3 * JOUR });
    await p.atteinte;
    coffre.verrouiller();
    p.liberer();
    expect(await pending).toEqual({ ok: true });
    expect(coffre.profilCourant()).toBeNull();
    expect(coffre.estDeverrouille()).toBe(false);
    expect((await rouvrir(stockage).deverrouiller(PIN, T0 + 8 * JOUR)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Cryptographie : vecteur a reponse connue, parametres, AAD, extractibilite
// ---------------------------------------------------------------------------------------------------

describe("vecteur a reponse connue (recalcule avec node:crypto, independamment du code teste)", () => {
  const SEL = Uint8Array.from({ length: 16 }, (_, i) => i);
  const IV_CLE = Uint8Array.from({ length: 12 }, (_, i) => 0x20 + i);
  const IV_PROFIL = Uint8Array.from({ length: 12 }, (_, i) => 0x40 + i);
  const IV_DONNEES = Uint8Array.from({ length: 12 }, (_, i) => 0x60 + i);
  const PIN_KAT = "123456";
  const ITERATIONS_KAT = 2000;

  function dechiffrerNode(cle: Buffer, iv: Buffer | Uint8Array, chiffreEtEtiquette: Buffer | Uint8Array, aad: string): Buffer {
    const brut = Buffer.from(chiffreEtEtiquette);
    const d = createDecipheriv("aes-256-gcm", cle, iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(brut.subarray(brut.length - 16));
    return Buffer.concat([d.update(brut.subarray(0, brut.length - 16)), d.final()]);
  }

  it("sel, IV, PIN et iterations fixes : la cle derivee est celle de PBKDF2-HMAC-SHA256, la DEK et le profil se retrouvent avec node:crypto", async () => {
    const { crypto, consommes } = cryptoDeterministe([SEL, IV_CLE, IV_PROFIL, IV_DONNEES]);
    const stockage = nouveauStockage();
    const coffre = await creerCoffre({
      stockage, compteId: COMPTE, appareilId: APPAREIL, pin: PIN_KAT, profil: identite, maintenantMs: T0,
      iterations: ITERATIONS_KAT, iterationsDeTest: true, crypto,
    });
    const e = await enveloppe(stockage);
    expect(e.kdf).toEqual({ alg: "PBKDF2-SHA256", iterations: ITERATIONS_KAT, sel: b64(SEL) });
    expect(e.cle.iv).toBe(b64(IV_CLE));
    expect(e.cle.alg).toBe("AES-GCM-256");

    // La cle derivee : valeur litterale (calculee une fois avec node:crypto) ET recalculee ici.
    const kek = pbkdf2Sync(Buffer.from(PIN_KAT, "utf8"), Buffer.from(SEL), ITERATIONS_KAT, 32, "sha256");
    expect(kek.toString("hex")).toBe("2fe85a62fe11c8399897789aa3c088263f730cc8053e678e2ab691a31763c10b");
    // Garde-fou contre un test tautologique : le vecteur RFC 7914 de PBKDF2-HMAC-SHA256 (« password », « salt », 1 tour).
    expect(pbkdf2Sync("password", "salt", 1, 32, "sha256").toString("hex")).toBe("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");

    // La DEK est retrouvee SANS passer par le code teste.
    const dek = dechiffrerNode(kek, IV_CLE, deB64(e.cle.enveloppee), `bdri-coffre|1|cle|${COMPTE}|${APPAREIL}`);
    expect(dek).toHaveLength(32);

    // Le profil : [1 | IV | chiffre+etiquette], sous la DEK et l'AAD du profil.
    const paquet = deB64(e.profil);
    expect(paquet[0]).toBe(1);
    expect(Buffer.from(paquet.subarray(1, 13)).equals(Buffer.from(IV_PROFIL))).toBe(true);
    const profil = JSON.parse(dechiffrerNode(dek, paquet.subarray(1, 13), paquet.subarray(13), `bdri-coffre|1|profil|${COMPTE}|${APPAREIL}`).toString("utf8"));
    expect(profil).toEqual({ ...identite, emisLe: T0, valideLe: T0, expireLe: T0 + 7 * JOUR });

    // Un enregistrement de file : AAD litterale.
    const donnees = await coffre.chiffrer({ x: 1 }, aadFile("note", COMPTE, "id1", 3));
    expect(Buffer.from(donnees.subarray(1, 13)).equals(Buffer.from(IV_DONNEES))).toBe(true);
    expect(dechiffrerNode(dek, donnees.subarray(1, 13), donnees.subarray(13), "bdri-coffre|1|file|note|user-alice-001|id1|3").toString("utf8")).toBe('{"x":1}');
    expect(consommes()).toBe(4);
  });

  it("l'inverse : une enveloppe fabriquee ENTIEREMENT avec node:crypto s'ouvre (bonne derivation, bon hash, bonnes AAD)", async () => {
    const stockage = nouveauStockage();
    await stockage.put(COMPTE, enveloppeManuelle({ aadCle: `bdri-coffre|1|cle|${COMPTE}|${APPAREIL}`, aadProfil: `bdri-coffre|1|profil|${COMPTE}|${APPAREIL}` }));
    const r = await rouvrir(stockage).deverrouiller(PIN, T0 + 1);
    expect(r).toEqual({ ok: true, profil: { ...identite, emisLe: T0, valideLe: T0, expireLe: T0 + 7 * JOUR } });
  });

  it("les AAD de la cle enveloppee et du profil sont distinctes et exactes : echanger ou changer l'une empeche l'ouverture", async () => {
    const aadC = `bdri-coffre|1|cle|${COMPTE}|${APPAREIL}`;
    const aadP = `bdri-coffre|1|profil|${COMPTE}|${APPAREIL}`;
    const essayer = async (e: EnveloppeCoffre) => {
      const s = nouveauStockage();
      await s.put(COMPTE, e);
      return rouvrir(s).deverrouiller(PIN, T0 + 1);
    };
    // Cle enveloppee sous l'AAD du profil, ou d'un autre appareil, ou vide : PIN_INCORRECT (la DEK ne sort pas).
    expect(await essayer(enveloppeManuelle({ aadCle: aadP, aadProfil: aadP }))).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await essayer(enveloppeManuelle({ aadCle: `bdri-coffre|1|cle|${COMPTE}|autre`, aadProfil: aadP }))).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await essayer(enveloppeManuelle({ aadCle: "", aadProfil: aadP }))).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    // Profil chiffre sous l'AAD de la cle, d'un autre compte, ou vide : la DEK sort, le profil est refuse.
    expect(await essayer(enveloppeManuelle({ aadCle: aadC, aadProfil: aadC }))).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
    expect(await essayer(enveloppeManuelle({ aadCle: aadC, aadProfil: `bdri-coffre|1|profil|autre|${APPAREIL}` }))).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
    expect(await essayer(enveloppeManuelle({ aadCle: aadC, aadProfil: "" }))).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
  });

  it("un profil dechiffre qui porte l'identifiant d'un AUTRE compte est refuse (AUTRE_COMPTE), meme avec le bon PIN et les bonnes AAD", async () => {
    const stockage = nouveauStockage();
    await stockage.put(COMPTE, enveloppeManuelle({
      aadCle: `bdri-coffre|1|cle|${COMPTE}|${APPAREIL}`, aadProfil: `bdri-coffre|1|profil|${COMPTE}|${APPAREIL}`, userIdProfil: "user-bob-002",
    }));
    const c = rouvrir(stockage);
    expect(await c.deverrouiller(PIN, T0 + 1)).toEqual({ ok: false, erreur: "AUTRE_COMPTE" });
    expect(c.estDeverrouille()).toBe(false);
    expect(await rouvrir(stockage).revalider({ pin: PIN, identite, maintenantMs: T0 + 2 })).toEqual({ ok: false, erreur: "AUTRE_COMPTE" });
  });

  it("parametres de derivation transmis a WebCrypto : PBKDF2, SHA-256, sel et iterations de l'enveloppe, cle AES-GCM 256 non extractible, usages wrapKey/unwrapKey", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    const obs = cryptoObserve();
    expect((await rouvrir(stockage, { crypto: obs.crypto }).deverrouiller(PIN, T0 + 1)).ok).toBe(true);
    expect(obs.derivees).toHaveLength(1);
    const { algo, cle } = obs.derivees[0];
    expect(algo).toMatchObject({ name: "PBKDF2", hash: "SHA-256", iterations: IT });
    expect(Buffer.from((algo as Pbkdf2Params).salt as Uint8Array).toString("base64")).toBe(e.kdf.sel);
    expect(cle.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(cle.extractable).toBe(false);
    expect([...cle.usages].sort()).toEqual(["unwrapKey", "wrapKey"]);
  });

  it("algorithmes de l'enveloppe : une autre valeur de kdf.alg ou de cle.alg rend le coffre illisible, sans compter un essai ni deriver", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    const espion = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    for (const alt of [
      { ...e, kdf: { ...e.kdf, alg: "PBKDF2-SHA1" } }, { ...e, kdf: { ...e.kdf, alg: "PBKDF2-SHA512" } }, { ...e, kdf: { ...e.kdf, alg: "scrypt" } },
      { ...e, cle: { ...e.cle, alg: "AES-GCM-128" } }, { ...e, cle: { ...e.cle, alg: "AES-CBC-256" } },
    ]) {
      await stockage.put(COMPTE, alt as unknown as EnveloppeCoffre);
      expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 1), JSON.stringify(alt.kdf.alg + alt.cle.alg)).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
    }
    expect(espion).not.toHaveBeenCalled();
    expect((await enveloppe(stockage)).echecs).toBe(0);
  });
});

/** Enveloppe fabriquee avec node:crypto seulement (PIN « Zq7!kd-4821 » par defaut), pour fixer les AAD. */
function enveloppeManuelle(o: { aadCle: string; aadProfil: string; pin?: string; iterations?: number; userIdProfil?: string }): EnveloppeCoffre {
  const iterations = o.iterations ?? IT;
  const sel = Buffer.alloc(16, 7);
  const ivCle = Buffer.alloc(12, 9);
  const ivProfil = Buffer.alloc(12, 11);
  const dek = Buffer.alloc(32, 5);
  const kek = pbkdf2Sync(Buffer.from((o.pin ?? PIN).normalize("NFKC"), "utf8"), sel, iterations, 32, "sha256");
  const chiffrer = (cle: Buffer, iv: Buffer, clair: Buffer, aad: string) => {
    const c = createCipheriv("aes-256-gcm", cle, iv, { authTagLength: 16 });
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(clair), c.final()]);
    return Buffer.concat([ct, c.getAuthTag()]);
  };
  const profil = { ...identite, userId: o.userIdProfil ?? identite.userId, emisLe: T0, valideLe: T0, expireLe: T0 + 7 * JOUR };
  return {
    v: 1, compteId: COMPTE, appareilId: APPAREIL, creeLe: T0,
    kdf: { alg: "PBKDF2-SHA256", iterations, sel: b64(sel) },
    cle: { alg: "AES-GCM-256", iv: b64(ivCle), enveloppee: b64(chiffrer(kek, ivCle, dek, o.aadCle)) },
    profil: b64(Buffer.concat([Buffer.from([1]), ivProfil, chiffrer(dek, ivProfil, Buffer.from(JSON.stringify(profil)), o.aadProfil)])),
    echecs: 0, pasAvantMs: null, dernierInstantMs: T0,
  };
}

describe("extractibilite des cles", () => {
  it("apres deverrouiller(), la DEK en memoire n'est pas extractible, et aucune cle deballee ni derivee ne l'est", async () => {
    const { stockage } = await fabriquer();
    const obs = cryptoObserve();
    const c = rouvrir(stockage, { crypto: obs.crypto });
    expect((await c.deverrouiller(PIN, T0 + 1)).ok).toBe(true);
    const interne = (c as unknown as { dek: CryptoKey }).dek;
    expect(interne.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("raw", interne)).rejects.toThrow();
    expect(obs.deballees.length).toBeGreaterThan(0);
    for (const k of obs.deballees) expect(k.extractable).toBe(false);
    expect(obs.derivees.length).toBeGreaterThan(0);
    for (const { cle } of obs.derivees) expect(cle.extractable).toBe(false);
    // La DEK chiffre et dechiffre quand meme.
    expect(await c.dechiffrerJson(await c.chiffrer({ a: 1 }, "x"), "x")).toEqual({ a: 1 });
  });

  it("apres revalider(), la DEK en memoire n'est pas extractible", async () => {
    const { stockage } = await fabriquer();
    const c = rouvrir(stockage);
    expect((await c.revalider({ pin: PIN, identite, maintenantMs: T0 + 1 })).ok).toBe(true);
    expect((c as unknown as { dek: CryptoKey }).dek.extractable).toBe(false);
  });

  it("a la creation, seule la DEK generee est extractible (le temps de l'envelopper) ; celle gardee en memoire ne l'est pas", async () => {
    const obs = cryptoObserve();
    const { coffre } = await fabriquer(nouveauStockage(), { crypto: obs.crypto });
    expect(obs.generees).toHaveLength(1);
    expect(obs.generees[0].extractable).toBe(true);
    const interne = (coffre as unknown as { dek: CryptoKey }).dek;
    expect(interne).not.toBe(obs.generees[0]);
    expect(interne.extractable).toBe(false);
    for (const k of obs.deballees) expect(k.extractable).toBe(false);
    for (const { cle } of obs.derivees) expect(cle.extractable).toBe(false);
  });

  it("changerPin : la DEK deballee pour l'envelopper est extractible le temps du changement ; celle du coffre ouvert ne le devient pas", async () => {
    const obs = cryptoObserve();
    const { coffre } = await fabriquer(nouveauStockage(), { crypto: obs.crypto });
    const avant = obs.deballees.length;
    expect(await coffre.changerPin(PIN, NOUVEAU_PIN, T0 + 1)).toEqual({ ok: true });
    const nouvelles = obs.deballees.slice(avant);
    expect(nouvelles).toHaveLength(1);
    expect(nouvelles[0].extractable).toBe(true);
    expect((coffre as unknown as { dek: CryptoKey }).dek.extractable).toBe(false);
    for (const { cle } of obs.derivees) expect(cle.extractable).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Iterations : plancher, borne haute, rehash, longueurs
// ---------------------------------------------------------------------------------------------------

describe("iterations PBKDF2 : plancher, borne haute, rehash", () => {
  const optionsBase = { stockage: stockageEnMemoire(), compteId: COMPTE, appareilId: APPAREIL };

  it("constantes : plancher 100 000, borne haute 10 000 000, defaut 600 000", () => {
    expect(ITERATIONS_PBKDF2_MIN).toBe(100_000);
    expect(ITERATIONS_PBKDF2_MAX).toBe(10_000_000);
    expect(ITERATIONS_PBKDF2_DEFAUT).toBe(600_000);
  });

  it("sans mode test, moins de 100 000 iterations est refuse (creation, ouverture) ; 100 000 et 10 000 000 sont acceptes ; au-dela refuse", async () => {
    await expect(creerCoffre({ ...optionsBase, pin: PIN, profil: identite, maintenantMs: T0, iterations: 99_999 })).rejects.toMatchObject({ code: "ARGUMENT_INVALIDE" });
    await expect(creerCoffre({ ...optionsBase, pin: PIN, profil: identite, maintenantMs: T0, iterations: 1 })).rejects.toMatchObject({ code: "ARGUMENT_INVALIDE" });
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 99_999 })).toThrow(ErreurCoffre);
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 100_000 })).not.toThrow();
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 10_000_000 })).not.toThrow();
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 10_000_001 })).toThrow(ErreurCoffre);
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 600_000.5 })).toThrow(ErreurCoffre);
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: Number.NaN })).toThrow(ErreurCoffre);
    // Mode test explicite : 1 passe, 0 non, la borne haute reste.
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 1, iterationsDeTest: true })).not.toThrow();
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 0, iterationsDeTest: true })).toThrow(ErreurCoffre);
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 10_000_001, iterationsDeTest: true })).toThrow(ErreurCoffre);
    // `iterationsDeTest: false` n'ouvre pas la porte.
    expect(() => ouvrirCoffre({ ...optionsBase, iterations: 1000, iterationsDeTest: false })).toThrow(ErreurCoffre);
  });

  it("a la lecture : au-dela de 10 000 000, ou non entier / negatif / nul / texte, l'enveloppe est illisible, sans compter d'essai ni deriver", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    const espion = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    for (const iterations of [10_000_001, 100_000_000, 0, -5, 1.5, "600000", null]) {
      await stockage.put(COMPTE, { ...e, kdf: { ...e.kdf, iterations: iterations as number } });
      expect((await rouvrir(stockage).lireMeta()).existe, String(iterations)).toBe(false);
      expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 1), String(iterations)).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
    }
    expect(espion).not.toHaveBeenCalled();
    // La borne elle-meme est lisible (sans derivation : lireMeta seulement).
    await stockage.put(COMPTE, { ...e, kdf: { ...e.kdf, iterations: 10_000_000 } });
    expect(await rouvrir(stockage).lireMeta()).toMatchObject({ existe: true, iterations: 10_000_000 });
    expect((await enveloppe(stockage)).echecs).toBe(0);
  });

  it("rehash : un deverrouillage reussi d'une enveloppe a moins d'iterations la reecrit au niveau courant, sans perdre les donnees ni changer la DEK", async () => {
    const { stockage, coffre } = await fabriquer(); // IT = 1000
    const paquet = await coffre.chiffrer({ saisie: "avant" }, "ctx");
    const avant = await enveloppe(stockage);

    const c = ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, iterations: 5000, iterationsDeTest: true });
    expect((await c.deverrouiller(PIN, T0 + MIN)).ok).toBe(true);

    const apres = await enveloppe(stockage);
    expect(apres.kdf.iterations).toBe(5000);
    expect(apres.kdf.sel).not.toBe(avant.kdf.sel);
    expect(apres.cle.iv).not.toBe(avant.cle.iv);
    expect(apres.cle.enveloppee).not.toBe(avant.cle.enveloppee);
    expect(apres.profil).toBe(avant.profil); // la DEK est la meme : le profil n'est pas rechiffre
    expect(apres).toMatchObject({ echecs: 0, pasAvantMs: null, compteId: COMPTE, appareilId: APPAREIL, creeLe: T0, v: 1 });
    expect(await c.dechiffrerJson(paquet, "ctx")).toEqual({ saisie: "avant" });
    expect((c as unknown as { dek: CryptoKey }).dek.extractable).toBe(false);

    // Le PIN ouvre encore, au niveau courant, et la nouvelle derivation est bien celle de 5000 tours.
    const obs = cryptoObserve();
    const suivant = ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, iterations: 5000, iterationsDeTest: true, crypto: obs.crypto });
    expect((await suivant.deverrouiller(PIN, T0 + 2 * MIN)).ok).toBe(true);
    expect(obs.derivees).toHaveLength(1); // plus de rehash
    expect(obs.derivees[0].algo).toMatchObject({ iterations: 5000 });
    expect(await suivant.dechiffrerJson(paquet, "ctx")).toEqual({ saisie: "avant" });
  });

  it("rehash : jamais de baisse (un reglage plus faible laisse l'enveloppe telle quelle), et un mauvais PIN ne la reecrit pas", async () => {
    const { stockage } = await fabriquer(nouveauStockage(), { iterations: 3000 });
    const avant = await enveloppe(stockage);

    const faible = ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, iterations: 500, iterationsDeTest: true });
    expect((await faible.deverrouiller(PIN, T0 + 1)).ok).toBe(true);
    expect((await enveloppe(stockage)).kdf).toEqual(avant.kdf);
    expect((await enveloppe(stockage)).cle).toEqual(avant.cle);

    const fort = ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, iterations: 6000, iterationsDeTest: true });
    expect(await fort.deverrouiller("mauvais-pin-00", T0 + 2)).toEqual({ ok: false, erreur: "PIN_INCORRECT" });
    expect((await enveloppe(stockage)).kdf).toEqual(avant.kdf);
  });

  it("rehash : une enveloppe a moins d'iterations est aussi remise au niveau par revalider", async () => {
    const { stockage } = await fabriquer();
    const c = ouvrirCoffre({ stockage, compteId: COMPTE, appareilId: APPAREIL, iterations: 4000, iterationsDeTest: true });
    expect((await c.revalider({ pin: PIN, identite, maintenantMs: T0 + 1 })).ok).toBe(true);
    expect((await enveloppe(stockage)).kdf.iterations).toBe(4000);
  });
});

describe("longueurs decodees a la lecture de l'enveloppe", () => {
  const octets = (n: number) => b64(new Uint8Array(n).fill(65));

  it("sel de 16 octets, IV de 12, cle enveloppee de 48, profil d'au moins 29 : toute autre longueur rend l'enveloppe illisible sans compter ni deriver", async () => {
    const { stockage } = await fabriquer();
    const e = await enveloppe(stockage);
    const espion = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    const variantes: Array<[string, EnveloppeCoffre]> = [
      ["sel 15", { ...e, kdf: { ...e.kdf, sel: octets(15) } }],
      ["sel 17", { ...e, kdf: { ...e.kdf, sel: octets(17) } }],
      ["sel vide", { ...e, kdf: { ...e.kdf, sel: "" } }],
      ["iv 11", { ...e, cle: { ...e.cle, iv: octets(11) } }],
      ["iv 13", { ...e, cle: { ...e.cle, iv: octets(13) } }],
      ["cle 47", { ...e, cle: { ...e.cle, enveloppee: octets(47) } }],
      ["cle 49", { ...e, cle: { ...e.cle, enveloppee: octets(49) } }],
      ["profil 28", { ...e, profil: octets(28) }],
      ["profil vide", { ...e, profil: "" }],
      ["sel pas du base64", { ...e, kdf: { ...e.kdf, sel: "!!!" } }],
      ["iv pas du base64", { ...e, cle: { ...e.cle, iv: "???" } }],
      ["sel non texte", { ...e, kdf: { ...e.kdf, sel: 12 as unknown as string } }],
    ];
    for (const [nom, v] of variantes) {
      await stockage.put(COMPTE, v);
      expect(await rouvrir(stockage).deverrouiller(PIN, T0 + 1), nom).toEqual({ ok: false, erreur: "COFFRE_ILLISIBLE" });
      expect((await rouvrir(stockage).lireMeta()).existe, nom).toBe(false);
    }
    expect(espion).not.toHaveBeenCalled();
    await stockage.put(COMPTE, { ...e, profil: octets(29) });
    expect((await rouvrir(stockage).lireMeta()).existe).toBe(true); // 29 = version + IV + etiquette : la plus petite longueur admise
    expect((await enveloppe(stockage)).echecs).toBe(0);
  });
});
