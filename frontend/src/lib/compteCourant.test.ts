import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoffreSession } from "../session/coffreSession";
import { cleLocalStorage } from "../session/compteLocal";
import {
  abonnerCompte, compteCourant, ecrireStockageLocal, ErreurStockageLocal, estErreurAccesFile, estErreurStockageLocal, etatCompte,
  exigerCompte, exigerDeverrouille, fermerCompte, lireCompteurs, lireStockageLocal, majCompteurs, majCompteursCourant, ouvrirCompte,
  resumeAutresComptes, retirerStockageLocal, traduireErreurChiffrement, type Chiffreur,
} from "./compteCourant";

/**
 * Compte courant du stockage local : ce que le reste du stockage (offlineDb, roulageHote, cles localStorage) en suppose.
 * Le chiffreur est une interface ; ces tests en utilisent un faux (le vrai coffre est eprouve avec offlineDb.test.ts).
 */

// Verification de TYPE (jamais executee) : le vrai coffre satisfait l'interface sans adaptateur.
const _coffreEstUnChiffreur = (c: CoffreSession): Chiffreur => c;
void _coffreEstUnChiffreur;

const EMP_A = "aaaaaaaaaaaaaaaa";
const EMP_B = "bbbbbbbbbbbbbbbb";

function fauxChiffreur(options: { compteId?: string; deverrouille?: boolean } = {}): Chiffreur & { deverrouille: boolean } {
  const etat = { deverrouille: options.deverrouille ?? true };
  const rien = async () => { throw new Error("non utilise ici"); };
  return {
    compteId: options.compteId,
    get deverrouille() { return etat.deverrouille; },
    set deverrouille(v: boolean) { etat.deverrouille = v; },
    estDeverrouille: () => etat.deverrouille,
    chiffrer: rien, dechiffrer: rien, dechiffrerJson: rien, chiffrerBlob: rien, dechiffrerBlob: rien,
  } as unknown as Chiffreur & { deverrouille: boolean };
}

beforeEach(() => { localStorage.clear(); fermerCompte(); });
afterEach(() => { localStorage.clear(); fermerCompte(); });

describe("ouvrir et fermer le compte", () => {
  it("sans compte : etat AUCUN, exigerCompte leve AUCUN_COMPTE", () => {
    expect(compteCourant()).toBeNull();
    expect(etatCompte()).toBe("AUCUN");
    expect(() => exigerCompte()).toThrowError(ErreurStockageLocal);
    try { exigerCompte(); } catch (e) { expect(estErreurStockageLocal(e, "AUCUN_COMPTE")).toBe(true); expect(estErreurAccesFile(e)).toBe(true); }
  });

  it("ouvre le compte, distingue ouvert et verrouille, ferme sans rien effacer", () => {
    const c = fauxChiffreur({ deverrouille: false });
    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: c });
    expect(compteCourant()).toMatchObject({ compteId: "agent-A", empreinte: EMP_A });
    expect(etatCompte()).toBe("VERROUILLE");
    expect(() => exigerDeverrouille(exigerCompte())).toThrowError(/verrouill/);
    c.deverrouille = true;
    expect(etatCompte()).toBe("OUVERT");
    expect(exigerDeverrouille(exigerCompte())).toBe(c);
    ecrireStockageLocal("k", "v");
    fermerCompte();
    expect(compteCourant()).toBeNull();
    expect(localStorage.getItem(cleLocalStorage(EMP_A, "k"))).toBe("v"); // fermer n'efface rien
  });

  it("rejette un identifiant vide, une empreinte mal formee, un chiffreur absent", () => {
    const c = fauxChiffreur();
    expect(() => ouvrirCompte({ compteId: "", empreinte: EMP_A, chiffreur: c })).toThrowError(ErreurStockageLocal);
    expect(() => ouvrirCompte({ compteId: "u", empreinte: "xyz", chiffreur: c })).toThrowError(ErreurStockageLocal);
    expect(() => ouvrirCompte({ compteId: "u", empreinte: EMP_A, chiffreur: undefined as never })).toThrowError(ErreurStockageLocal);
    expect(compteCourant()).toBeNull();
  });

  it("refuse le chiffreur d'un AUTRE compte (COMPTE_INCOHERENT) : jamais ecrire sous une cle qui n'est pas la sienne", () => {
    try {
      ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: fauxChiffreur({ compteId: "agent-B" }) });
      expect.unreachable();
    } catch (e) {
      expect(estErreurStockageLocal(e, "COMPTE_INCOHERENT")).toBe(true);
    }
    expect(compteCourant()).toBeNull();
  });

  it("rappeler ouvrirCompte avec les memes arguments garde la meme generation mais reveille les abonnes ; changer de compte la change", () => {
    const c = fauxChiffreur();
    const g1 = ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: c }).generation;
    let reveils = 0;
    const desabonner = abonnerCompte(() => { reveils += 1; });
    expect(ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: c }).generation).toBe(g1);
    expect(reveils).toBe(1);
    const g2 = ouvrirCompte({ compteId: "agent-B", empreinte: EMP_B, chiffreur: fauxChiffreur() }).generation;
    expect(g2).not.toBe(g1);
    fermerCompte();
    expect(reveils).toBe(3);
    desabonner();
    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: c });
    expect(reveils).toBe(3);
  });

  it("un abonne qui leve ne bloque pas les autres", () => {
    let vu = false;
    abonnerCompte(() => { throw new Error("abonne defaillant"); });
    abonnerCompte(() => { vu = true; });
    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: fauxChiffreur() });
    expect(vu).toBe(true);
  });
});

describe("erreurs du coffre traduites en erreurs typees", () => {
  const erreurCoffre = (code: string) => Object.assign(new Error(code), { name: "ErreurCoffre", code });
  it("VERROUILLE, DONNEES_ALTEREES, BLOB_TROP_GROS ; une erreur inconnue est rendue telle quelle", () => {
    expect(traduireErreurChiffrement(erreurCoffre("VERROUILLE"))).toMatchObject({ code: "COFFRE_VERROUILLE" });
    expect(traduireErreurChiffrement(erreurCoffre("DONNEES_ALTEREES"))).toMatchObject({ code: "DONNEES_ALTEREES" });
    expect(traduireErreurChiffrement(erreurCoffre("BLOB_TROP_GROS"))).toMatchObject({ code: "PHOTO_TROP_GROSSE" });
    const autre = new Error("autre");
    expect(traduireErreurChiffrement(autre)).toBe(autre);
    expect(traduireErreurChiffrement(erreurCoffre("PIN_INCORRECT"))).toMatchObject({ code: "PIN_INCORRECT" });
  });
});

describe("localStorage du compte : toujours sous le prefixe, jamais sans compte", () => {
  it("sans compte ouvert : rien n'est lu, rien n'est ecrit, aucune cle sans prefixe", () => {
    expect(ecrireStockageLocal("terrain.referentiels", "x")).toBe(false);
    expect(lireStockageLocal("terrain.referentiels")).toBeNull();
    expect(localStorage.length).toBe(0);
    retirerStockageLocal("terrain.referentiels");
  });

  it("ecrit sous bdri:<empreinte>:<nom> et cloisonne les comptes", () => {
    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: fauxChiffreur() });
    expect(ecrireStockageLocal("terrain.referentiels", "A")).toBe(true);
    expect(localStorage.getItem(`bdri:${EMP_A}:terrain.referentiels`)).toBe("A");
    expect(Object.keys(localStorage)).toEqual([`bdri:${EMP_A}:terrain.referentiels`]);

    ouvrirCompte({ compteId: "agent-B", empreinte: EMP_B, chiffreur: fauxChiffreur() });
    expect(lireStockageLocal("terrain.referentiels")).toBeNull();
    ecrireStockageLocal("terrain.referentiels", "B");
    expect(localStorage.getItem(`bdri:${EMP_A}:terrain.referentiels`)).toBe("A");
    retirerStockageLocal("terrain.referentiels");
    expect(localStorage.getItem(`bdri:${EMP_A}:terrain.referentiels`)).toBe("A");
    expect(lireStockageLocal("terrain.referentiels")).toBeNull();
  });

  it("le compte demande garde un appel asynchrone commence sous un autre compte", () => {
    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: fauxChiffreur() });
    expect(ecrireStockageLocal("sync.device", "id-A", "agent-A")).toBe(true);
    expect(lireStockageLocal("sync.device", "agent-A")).toBe("id-A");
    expect(lireStockageLocal("sync.device", "agent-B")).toBeNull();
    expect(ecrireStockageLocal("sync.device", "id-B", "agent-B")).toBe(false);
    retirerStockageLocal("sync.device", "agent-B");
    expect(lireStockageLocal("sync.device", "agent-A")).toBe("id-A");
  });

  it("un stockage qui refuse l'ecriture (quota, mode prive) rend false sans lever", () => {
    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: fauxChiffreur() });
    const reel = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("QuotaExceededError"); };
    try { expect(ecrireStockageLocal("k", "v")).toBe(false); } finally { Storage.prototype.setItem = reel; }
  });
});

describe("compteurs d'information, en clair, sans contenu", () => {
  it("n'ecrivent que des nombres et une date, et seulement quand un nombre change", () => {
    majCompteurs(EMP_A, { saisies: 3 });
    expect(lireCompteurs(EMP_A)).toMatchObject({ saisies: 3, releves: 0 });
    const brut = localStorage.getItem(`bdri:${EMP_A}:compteurs`) as string;
    expect(Object.keys(JSON.parse(brut)).sort()).toEqual(["maj", "releves", "saisies"]);
    majCompteurs(EMP_A, { releves: 1 });
    expect(lireCompteurs(EMP_A)).toMatchObject({ saisies: 3, releves: 1 });
    const avant = localStorage.getItem(`bdri:${EMP_A}:compteurs`);
    majCompteurs(EMP_A, { releves: 1 }); // aucun changement : pas de reecriture
    expect(localStorage.getItem(`bdri:${EMP_A}:compteurs`)).toBe(avant);
  });

  it("refusent un nombre invalide ; un compteur abime se lit comme absent", () => {
    majCompteurs(EMP_A, { saisies: -1 });
    majCompteurs(EMP_A, { saisies: 1.5 });
    expect(lireCompteurs(EMP_A)).toBeNull();
    localStorage.setItem(`bdri:${EMP_A}:compteurs`, "{pas du json");
    expect(lireCompteurs(EMP_A)).toBeNull();
    localStorage.setItem(`bdri:${EMP_A}:compteurs`, JSON.stringify({ saisies: "3", releves: 0 }));
    expect(lireCompteurs(EMP_A)).toBeNull();
  });

  it("majCompteursCourant vise le compte ouvert, sans effet sinon", () => {
    majCompteursCourant({ saisies: 5 });
    expect(localStorage.length).toBe(0);
    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: fauxChiffreur() });
    majCompteursCourant({ saisies: 5 });
    expect(lireCompteurs(EMP_A)?.saisies).toBe(5);
  });

  it("resumeAutresComptes additionne les AUTRES comptes (pas le courant), ignore les compteurs a zero et les cles etrangeres", () => {
    majCompteurs(EMP_A, { saisies: 2, releves: 1 });
    majCompteurs(EMP_B, { saisies: 4 });
    majCompteurs("cccccccccccccccc", { saisies: 0, releves: 0 });
    localStorage.setItem("bdri:dddddddddddddddd:autre", "{}");
    localStorage.setItem("compteurs", JSON.stringify({ saisies: 99, releves: 99 }));

    ouvrirCompte({ compteId: "agent-A", empreinte: EMP_A, chiffreur: fauxChiffreur() });
    expect(resumeAutresComptes()).toEqual({ comptes: 1, saisies: 4, releves: 0 });
    ouvrirCompte({ compteId: "agent-B", empreinte: EMP_B, chiffreur: fauxChiffreur() });
    expect(resumeAutresComptes()).toEqual({ comptes: 1, saisies: 2, releves: 1 });
    fermerCompte();
    expect(resumeAutresComptes()).toEqual({ comptes: 2, saisies: 6, releves: 1 });
  });

  it("le resume ne contient aucun identifiant de compte ni contenu : trois nombres", () => {
    majCompteurs(EMP_B, { saisies: 4, releves: 1 });
    expect(Object.keys(resumeAutresComptes()).sort()).toEqual(["comptes", "releves", "saisies"]);
  });
});
