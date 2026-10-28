import { describe, expect, it } from "vitest";
import {
  BBOX_COTE_MAX_DEG, GEOJSON_PLAFOND_DEFAUT, GEOJSON_PLAFOND_MAX, LIMITE_DEFAUT, LIMITE_MAX,
  decoderCurseur, encoderCurseur, lireBbox, lireFiltresDetail, lireFiltresGeo, lireFiltresListe,
} from "./priorite.requete";

/**
 * Ce que ces tests defendent : chaque entree est ou bien formee ou REFUSEE avec une phrase (400) ; jamais ignoree, jamais une
 * erreur serveur. `maintenant` est un parametre (aucune horloge).
 */
const MAINTENANT = new Date("2026-10-27T10:00:00Z");

describe("filtres de la liste", () => {
  it("valeurs par defaut : limite 25, aucun filtre", () => {
    const f = lireFiltresListe({}, MAINTENANT);
    expect(f).toEqual({ ok: true, valeur: expect.objectContaining({ limite: LIMITE_DEFAUT }) });
  });

  it("lit les filtres du contrat sous les trois formes (virgules, repetes, crochets)", () => {
    const f = lireFiltresListe({ regionId: "3", classe: "RN,RR", etat: ["MAUVAIS", "CRITIQUE"], depuis: "2026-01-01", jusqua: "2026-06-30", limite: "40", parametresId: "abc-123" }, MAINTENANT);
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.valeur).toMatchObject({ regionId: 3, classe: ["RN", "RR"], etat: ["MAUVAIS", "CRITIQUE"], depuis: "2026-01-01", jusqua: "2026-06-30", limite: 40, parametresId: "abc-123" });
  });

  it("statutChantier est ACCEPTE (l'ecran serialise les memes filtres partout) pour etre dit non applique, pas refuse", () => {
    const f = lireFiltresListe({ statutChantier: "EN_COURS,SUSPENDU" }, MAINTENANT);
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.valeur.statutChantier).toEqual(["EN_COURS", "SUSPENDU"]);
  });

  const HOSTILES: [string, Record<string, unknown>][] = [
    ["parametre inconnu", { zzz: "1" }],
    ["limite 0", { limite: "0" }],
    ["limite au-dela du maximum", { limite: String(LIMITE_MAX + 1) }],
    ["limite texte", { limite: "abc" }],
    ["limite decimale", { limite: "1.5" }],
    ["limite repetee", { limite: ["1", "2"] }],
    ["limite vide", { limite: "" }],
    ["classe inconnue", { classe: "AUTOROUTE" }],
    ["classe avec valeur vide", { classe: "RN," }],
    ["classe objet", { classe: { a: "RN" } }],
    ["trop de valeurs", { etat: Array.from({ length: 11 }, () => "BON") }],
    ["etat inconnu", { etat: "TRES_BON" }],
    ["regionId texte", { regionId: "abc" }],
    ["regionId zero", { regionId: "0" }],
    ["regionId negatif", { regionId: "-3" }],
    ["regionId enorme", { regionId: "99999999999" }],
    ["depuis non ISO", { depuis: "27/10/2026" }],
    ["depuis jour inexistant", { depuis: "2026-02-30" }],
    ["depuis avant l'an 2000", { depuis: "1999-12-31" }],
    ["jusqua en l'an 2999", { jusqua: "2999-01-01" }],
    ["depuis apres jusqua", { depuis: "2026-06-01", jusqua: "2026-01-01" }],
    ["statutScore inconnu", { statutScore: "MEILLEUR" }],
    ["parametresId avec guillemet", { parametresId: "x' OR '1'='1" }],
    ["parametresId trop long", { parametresId: "a".repeat(65) }],
    ["statutChantier avec caracteres speciaux", { statutChantier: "a;b" }],
    ["curseur non base64url", { curseur: "!!!" }],
    ["curseur vide", { curseur: "" }],
    ["curseur trop long", { curseur: "A".repeat(601) }],
  ];
  it.each(HOSTILES)("refuse (jamais d'erreur serveur) : %s", (_nom, q) => {
    const f = lireFiltresListe(q, MAINTENANT);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.message.length).toBeGreaterThan(5);
  });
});

describe("curseur", () => {
  const c = { v: "prog-provisoire-1", g: 0 as const, s: -605000, c: "RN-A", i: "id-1" };

  it("aller-retour", () => {
    const r = decoderCurseur(encoderCurseur(c));
    expect(r).toEqual({ ok: true, valeur: c });
  });

  const forge = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  it.each([
    ["cle en trop", forge({ ...c, x: 1 })],
    ["cle manquante", forge({ v: c.v, g: 0, s: 1, c: "a" })],
    ["groupe hors 0/1", forge({ ...c, g: 2 })],
    ["score decimal", forge({ ...c, s: 1.5 })],
    ["score enorme", forge({ ...c, s: 1e12 })],
    ["version avec espace", forge({ ...c, v: "a b" })],
    ["code vide", forge({ ...c, c: "" })],
    ["code avec caractere de controle", forge({ ...c, c: "a\u0001b" })],
    ["identifiant avec guillemet", forge({ ...c, i: "a'b" })],
    ["tableau", forge([1, 2])],
    ["nombre", forge(5)],
    ["JSON invalide", Buffer.from("{pas du json", "utf8").toString("base64url")],
  ])("refuse un curseur forge : %s", (_nom, brut) => {
    expect(decoderCurseur(brut).ok).toBe(false);
  });
});

describe("emprise (GeoJSON)", () => {
  it("est OBLIGATOIRE", () => {
    const f = lireFiltresGeo({}, MAINTENANT);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.message).toContain("obligatoire");
  });

  it("lit une emprise nationale (la Guinee tient dans 10 degres) et le plafond par defaut de 300", () => {
    const f = lireFiltresGeo({ bbox: "-15,7,-7.5,12.8" }, MAINTENANT);
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.valeur).toMatchObject({ bbox: [-15, 7, -7.5, 12.8], limite: GEOJSON_PLAFOND_DEFAUT });
    expect(GEOJSON_PLAFOND_DEFAUT).toBe(300);
    expect(BBOX_COTE_MAX_DEG).toBe(10);
  });

  it("borne le plafond demande", () => {
    expect(lireFiltresGeo({ bbox: "-14,9,-13,10", limite: String(GEOJSON_PLAFOND_MAX) }, MAINTENANT).ok).toBe(true);
    expect(lireFiltresGeo({ bbox: "-14,9,-13,10", limite: String(GEOJSON_PLAFOND_MAX + 1) }, MAINTENANT).ok).toBe(false);
  });

  it.each([
    ["trop grande", "-20,0,0,5"],
    ["hors du globe", "-190,0,0,5"],
    ["latitude hors du globe", "0,-95,5,5"],
    ["ouest superieur a est", "5,0,0,5"],
    ["emprise degeneree", "1,1,1,2"],
    ["trois nombres", "1,2,3"],
    ["cinq nombres", "1,2,3,4,5"],
    ["texte", "a,b,c,d"],
    ["notation scientifique", "1e2,0,1e2,1"],
    ["NaN", "NaN,0,1,1"],
    ["vide", ""],
    ["trop de decimales", "0.1234567891,0,1,1"],
  ])("refuse une emprise : %s", (_nom, bbox) => {
    expect(lireBbox(bbox, BBOX_COTE_MAX_DEG).ok).toBe(false);
  });

  it("refuse une emprise repetee ou en objet, et un parametre inconnu", () => {
    expect(lireFiltresGeo({ bbox: ["-14,9,-13,10", "-14,9,-13,10"] }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresGeo({ bbox: { a: "1" } }, MAINTENANT).ok).toBe(false);
    expect(lireFiltresGeo({ bbox: "-14,9,-13,10", curseur: "x" }, MAINTENANT).ok).toBe(false);
  });
});

describe("detail", () => {
  it("n'accepte que parametresId", () => {
    expect(lireFiltresDetail({}).ok).toBe(true);
    expect(lireFiltresDetail({ parametresId: "abc" }).ok).toBe(true);
    expect(lireFiltresDetail({ limite: "2" }).ok).toBe(false);
    expect(lireFiltresDetail({ parametresId: "a b" }).ok).toBe(false);
  });
});
