import { describe, expect, it } from "vitest";
import {
  decoderCurseur, encoderCurseur, estIdentifiantSession, LIMITE_DEFAUT, LIMITE_MAX, lireInstant, lireOptionsDetail, lireParametresListe,
  porteeDe, roleALePerimetre, versMultiLigne,
} from "./consultation.noyau";

const ID = "11111111-1111-4111-8111-111111111111";
const refus = (r: { ok: boolean }) => (r.ok ? null : (r as unknown as { code: string }).code);

describe("lireInstant : dates ISO strictes", () => {
  it("lit une date, un instant UTC et un instant avec decalage", () => {
    expect(lireInstant("2026-10-25")).toEqual({ ms: Date.UTC(2026, 9, 25), jourSeul: true });
    expect(lireInstant("2026-10-25T10:30:15.250Z")).toEqual({ ms: Date.UTC(2026, 9, 25, 10, 30, 15, 250), jourSeul: false });
    expect(lireInstant("2026-10-25T10:30Z")?.ms).toBe(Date.UTC(2026, 9, 25, 10, 30));
    expect(lireInstant("2026-10-25T10:30:00+02:00")?.ms).toBe(Date.UTC(2026, 9, 25, 8, 30));
    expect(lireInstant("2026-10-25T10:30:00.5Z")?.ms).toBe(Date.UTC(2026, 9, 25, 10, 30, 0, 500));
  });

  it("accepte le 29 fevrier d'une annee bissextile seulement", () => {
    expect(lireInstant("2028-02-29")).not.toBeNull();
    expect(lireInstant("2100-02-29")).toBeNull();
    expect(lireInstant("2027-02-29")).toBeNull();
  });

  it.each([
    "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-10-00",
    "2026-10-25T24:00:00Z", "2026-10-25T10:60:00Z", "2026-10-25T10:00:60Z",
    "2026-10-25T10:00:00", "2026-10-25 10:00:00Z", "25/10/2026", "hier", "", "2026-10", "2026-10-25T10:00:00+25:00",
    "1999-12-31", "2100-01-01", "0000-01-01", "+2026-10-25", "2026-10-25T10:00:00Zjunk", " 2026-10-25", "2026-10-25\n",
  ])("refuse %j", (texte) => {
    expect(lireInstant(texte)).toBeNull();
  });
});

describe("curseur", () => {
  it("fait l'aller-retour", () => {
    const c = { debutA: "2026-10-25T10:30:15.250Z", id: ID };
    const t = encoderCurseur(c);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decoderCurseur(t)).toEqual({ ok: true, curseur: c });
  });

  const forger = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o), "utf8").toString("base64url");

  it.each([
    ["pas du base64url", "***"],
    ["vide", ""],
    ["trop long", "A".repeat(301)],
    ["pas du JSON", forger("pas du json")],
    ["un tableau", forger([1, 2])],
    ["null", forger("null")],
    ["une cle de trop", forger({ d: "2026-10-25T10:30:15.250Z", i: ID, x: 1 })],
    ["une cle manquante", forger({ d: "2026-10-25T10:30:15.250Z" })],
    ["date impossible", forger({ d: "2026-02-30T10:30:15.250Z", i: ID })],
    ["date non canonique", forger({ d: "2026-10-25", i: ID })],
    ["date avec decalage", forger({ d: "2026-10-25T10:30:15.250+02:00", i: ID })],
    ["date d'un autre type", forger({ d: 1790000000000, i: ID })],
    ["identifiant non UUID", forger({ d: "2026-10-25T10:30:15.250Z", i: "' OR 1=1 --" })],
    ["identifiant d'un autre type", forger({ d: "2026-10-25T10:30:15.250Z", i: 7 })],
  ])("refuse un curseur forge : %s", (_nom, texte) => {
    expect(refus(decoderCurseur(texte))).toBe("CURSEUR_INVALIDE");
  });
});

describe("lireParametresListe", () => {
  it("donne les valeurs par defaut", () => {
    expect(lireParametresListe({})).toEqual({ ok: true, valeur: { limite: LIMITE_DEFAUT, curseur: null, userId: null, depuis: null, avant: null } });
    expect(LIMITE_DEFAUT).toBe(25);
    expect(LIMITE_MAX).toBe(100);
  });

  it("accepte les bornes de limite et refuse ce qui en sort", () => {
    expect(lireParametresListe({ limite: "1" })).toMatchObject({ ok: true, valeur: { limite: 1 } });
    expect(lireParametresListe({ limite: "100" })).toMatchObject({ ok: true, valeur: { limite: 100 } });
    for (const l of ["0", "101", "-1", "1.5", "1e1", "abc", "", " 5", "5 ", "0x10", "1000", "NaN", "Infinity"]) {
      expect(refus(lireParametresListe({ limite: l })), `limite=${l}`).toBe("PARAMETRE_INVALIDE");
    }
  });

  it("refuse un parametre repete ou imbrique (tableau, objet) au lieu de deviner", () => {
    for (const nom of ["limite", "curseur", "userId", "depuis", "jusqua"]) {
      expect(refus(lireParametresListe({ [nom]: ["a", "b"] })), `${nom}[]`).toBe("PARAMETRE_INVALIDE");
      expect(refus(lireParametresListe({ [nom]: { a: "1" } })), `${nom}{}`).toBe("PARAMETRE_INVALIDE");
    }
  });

  it("refuse une date impossible (400, pas une date decalee)", () => {
    expect(refus(lireParametresListe({ depuis: "2026-02-30" }))).toBe("PARAMETRE_INVALIDE");
    expect(refus(lireParametresListe({ jusqua: "2026-13-01" }))).toBe("PARAMETRE_INVALIDE");
  });

  it("traduit une borne haute en borne EXCLUSIVE : un jour entier, ou la milliseconde suivante", () => {
    const jour = lireParametresListe({ depuis: "2026-10-01", jusqua: "2026-10-25" });
    expect(jour).toMatchObject({ ok: true, valeur: { depuis: "2026-10-01T00:00:00.000Z", avant: "2026-10-26T00:00:00.000Z" } });
    const instant = lireParametresListe({ jusqua: "2026-10-25T10:00:00.000Z" });
    expect(instant).toMatchObject({ ok: true, valeur: { avant: "2026-10-25T10:00:00.001Z" } });
  });

  it("refuse une plage a l'envers ou vide", () => {
    expect(refus(lireParametresListe({ depuis: "2026-10-25", jusqua: "2026-10-01" }))).toBe("PARAMETRE_INVALIDE");
    expect(refus(lireParametresListe({ depuis: "2026-10-25T10:00:00Z", jusqua: "2026-10-25T09:00:00Z" }))).toBe("PARAMETRE_INVALIDE");
    expect(lireParametresListe({ depuis: "2026-10-25", jusqua: "2026-10-25" })).toMatchObject({ ok: true });
  });

  it("refuse un userId hostile, accepte un identifiant sobre", () => {
    for (const u of ["", "a b", "x'; DROP TABLE users;--", "a".repeat(65), "é", "a/b"]) {
      expect(refus(lireParametresListe({ userId: u })), JSON.stringify(u)).toBe("PARAMETRE_INVALIDE");
    }
    expect(lireParametresListe({ userId: ID })).toMatchObject({ ok: true, valeur: { userId: ID } });
  });

  it("rend le refus de curseur sous son code propre", () => {
    expect(refus(lireParametresListe({ curseur: "zzz!" }))).toBe("CURSEUR_INVALIDE");
    const c = encoderCurseur({ debutA: "2026-10-25T10:30:15.250Z", id: ID });
    expect(lireParametresListe({ curseur: c })).toMatchObject({ ok: true, valeur: { curseur: { id: ID } } });
  });

  it("ignore un parametre inconnu", () => {
    expect(lireParametresListe({ inconnu: "x", _: "123" })).toMatchObject({ ok: true });
  });
});

describe("lireOptionsDetail", () => {
  it("lit avecPoints", () => {
    expect(lireOptionsDetail({})).toEqual({ ok: true, valeur: { avecPoints: false } });
    expect(lireOptionsDetail({ avecPoints: "1" })).toEqual({ ok: true, valeur: { avecPoints: true } });
    expect(lireOptionsDetail({ avecPoints: "true" })).toEqual({ ok: true, valeur: { avecPoints: true } });
    expect(lireOptionsDetail({ avecPoints: "0" })).toEqual({ ok: true, valeur: { avecPoints: false } });
    expect(lireOptionsDetail({ avecPoints: "false" })).toEqual({ ok: true, valeur: { avecPoints: false } });
  });
  it("refuse le reste", () => {
    for (const v of ["2", "oui", "", "TRUE", ["1", "1"], { a: 1 }]) {
      expect(refus(lireOptionsDetail({ avecPoints: v })), JSON.stringify(v)).toBe("PARAMETRE_INVALIDE");
    }
  });
});

describe("estIdentifiantSession", () => {
  it("n'accepte qu'un UUID", () => {
    expect(estIdentifiantSession(ID)).toBe(true);
    expect(estIdentifiantSession(ID.toUpperCase())).toBe(true);
    for (const v of ["", "abc", "u-roulage", `${ID}x`, ` ${ID}`, "../../etc/passwd", "1; DROP TABLE x", null, undefined, 12, {}]) {
      expect(estIdentifiantSession(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("porteeDe : qui voit quoi", () => {
  const compte = (role: string) => ({ id: "u1", role });
  it("ADMIN voit tout, meme avec un perimetre", () => {
    expect(porteeDe(compte("ADMIN"), null)).toEqual({ type: "tous" });
    expect(porteeDe(compte("ADMIN"), [1])).toEqual({ type: "tous" });
  });
  it("GESTIONNAIRE national voit tout, regional voit ses regions et les siens", () => {
    expect(porteeDe(compte("GESTIONNAIRE"), null)).toEqual({ type: "tous" });
    expect(porteeDe(compte("GESTIONNAIRE"), [3, 5])).toEqual({ type: "regions", userId: "u1", regions: [3, 5] });
  });
  it("une liste vide de regions ne rend jamais « tous » : le compte ne voit que les siens", () => {
    expect(porteeDe(compte("GESTIONNAIRE"), [])).toEqual({ type: "siens", userId: "u1" });
  });
  it("INSPECTEUR, LECTEUR et tout role inconnu ne voient que les leurs, perimetre ou non", () => {
    for (const role of ["INSPECTEUR", "LECTEUR", "AUDITEUR_FUTUR", ""]) {
      expect(porteeDe(compte(role), null), role).toEqual({ type: "siens", userId: "u1" });
      expect(porteeDe(compte(role), [1, 2]), role).toEqual({ type: "siens", userId: "u1" });
    }
  });
  it("seul un GESTIONNAIRE a son perimetre relu", () => {
    expect(roleALePerimetre("GESTIONNAIRE")).toBe(true);
    for (const r of ["ADMIN", "INSPECTEUR", "LECTEUR"]) expect(roleALePerimetre(r)).toBe(false);
  });
});

describe("versMultiLigne", () => {
  it("garde une MultiLineString, enveloppe une LineString, refuse le reste", () => {
    const multi = JSON.stringify({ type: "MultiLineString", coordinates: [[[1, 2], [3, 4]]] });
    expect(versMultiLigne(multi)).toEqual({ type: "MultiLineString", coordinates: [[[1, 2], [3, 4]]] });
    expect(versMultiLigne(JSON.stringify({ type: "LineString", coordinates: [[1, 2], [3, 4]] }))).toEqual({ type: "MultiLineString", coordinates: [[[1, 2], [3, 4]]] });
    expect(versMultiLigne(JSON.stringify({ type: "Point", coordinates: [1, 2] }))).toBeNull();
    expect(versMultiLigne("pas du json")).toBeNull();
    expect(versMultiLigne(null)).toBeNull();
  });
});
