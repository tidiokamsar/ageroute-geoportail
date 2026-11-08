import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENEMENTS_MAX, MARQUEURS_MAX, payloadSessionRoulage, POINTS_MAX_SESSION } from "./contrat";

/**
 * Le contrat serveur d'une session de roulage. Trois defenses :
 *   - la charge d'exemple ecrite par le NOYAU DE L'APPAREIL (docs/roulage/exemple-session.json, reecrite
 *     par frontend/src/roulage/golden.test.ts) passe ce schema tel quel : les deux cotes sont d'accord ;
 *   - tout ce qui rend une trace inexploitable est refuse (temps qui recule, segments incoherents) ;
 *   - AUCUN IRI n'est accepte.
 */

const exemple = () => JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "docs", "roulage", "exemple-session.json"), "utf8"));
type Charge = ReturnType<typeof exemple>;
const refus = (c: unknown) => payloadSessionRoulage.safeParse(c);

describe("charge produite par le noyau de l'appareil", () => {
  it("passe le schema serveur sans modification", () => {
    const r = refus(exemple());
    expect(r.success, JSON.stringify(r.success ? "" : r.error.issues.slice(0, 3))).toBe(true);
  });

  it("contient bien un marqueur, un evenement clos et une interruption : l'exemple n'est pas vide", () => {
    const p = exemple();
    expect(p.marqueurs).toHaveLength(1);
    expect(p.evenements).toHaveLength(1);
    expect(p.interruptions).toHaveLength(1);
    expect(p.points.length).toBeGreaterThan(50);
  });
});

describe("refus", () => {
  const modifie = (f: (c: Charge) => void) => { const c = exemple(); f(c); return c; };

  it("AUCUN IRI : la cle est refusee, pas ignoree en silence", () => {
    expect(refus(modifie((c) => { c.iri = [{ debutM: 0, finM: 100, iriMParKm: 2.5 }]; })).success).toBe(false);
    expect(refus(modifie((c) => { c.iri = null; })).success).toBe(false);
    // Absente ou indefinie : normal.
    expect(refus(modifie((c) => { c.iri = undefined; })).success).toBe(true);
  });

  it("une cle de plus au sommet n'est pas un refus (zod l'ignore) : seuls les champs DECLARES comptent", () => {
    // Documente le piege : c'est pourquoi chaque champ du contrat est declare ici, et pourquoi `iri` l'est explicitement.
    expect(refus(modifie((c) => { c.champInconnu = 1; })).success).toBe(true);
    const r = payloadSessionRoulage.parse(modifie((c) => { c.champInconnu = 1; }));
    expect(Object.keys(r)).not.toContain("champInconnu");
  });

  it("version de contrat inconnue", () => {
    expect(refus(modifie((c) => { c.versionContrat = 2; })).success).toBe(false);
  });

  it("identifiant de session qui n'est pas un uuid", () => {
    expect(refus(modifie((c) => { c.sessionId = "session-1"; })).success).toBe(false);
  });

  it("horodatages des points non strictement croissants", () => {
    expect(refus(modifie((c) => { c.points[5][0] = c.points[4][0]; })).success).toBe(false);
    expect(refus(modifie((c) => { c.points[5][0] = c.points[3][0]; })).success).toBe(false);
  });

  it("segments incoherents : le premier n'est pas 0, ou un saut de plus de 1", () => {
    expect(refus(modifie((c) => { for (const p of c.points) p[5] = 1; })).success).toBe(false);
    expect(refus(modifie((c) => { c.points[10][5] = 2; })).success).toBe(false);
  });

  it("coordonnees hors du globe, precision negative, horodatage hors 2000-2100", () => {
    expect(refus(modifie((c) => { c.points[3][1] = 91; })).success).toBe(false);
    expect(refus(modifie((c) => { c.points[3][2] = -181; })).success).toBe(false);
    expect(refus(modifie((c) => { c.points[3][3] = -1; })).success).toBe(false);
    expect(refus(modifie((c) => { c.points[0][0] = 5; })).success).toBe(false);
    expect(refus(modifie((c) => { c.debutMs = 9e15; })).success).toBe(false);
  });

  it("une session de moins de deux points, ou au-dela du plafond", () => {
    expect(refus(modifie((c) => { c.points = c.points.slice(0, 1); })).success).toBe(false);
    expect(POINTS_MAX_SESSION).toBe(36_000);
    expect(MARQUEURS_MAX).toBe(2_000);
    expect(EVENEMENTS_MAX).toBe(2_000);
  });

  it("fin avant debut de la session", () => {
    expect(refus(modifie((c) => { c.finMs = c.debutMs - 1; })).success).toBe(false);
  });

  it("evenement lineaire : fin anterieure au debut, fin absente pour un evenement clos, fin presente pour un abandonne", () => {
    expect(refus(modifie((c) => { c.evenements[0].fin.tMs = c.evenements[0].debut.tMs; })).success).toBe(false);
    expect(refus(modifie((c) => { c.evenements[0].fin = null; })).success).toBe(false);
    expect(refus(modifie((c) => { c.evenements[0].statut = "ABANDONNE"; })).success).toBe(false);
    expect(refus(modifie((c) => { c.evenements[0].statut = "ABANDONNE"; c.evenements[0].fin = null; c.evenements[0].motifAbandon = "x"; })).success).toBe(true);
  });

  it("code de marqueur ou d'evenement hors de la forme referentielle", () => {
    expect(refus(modifie((c) => { c.marqueurs[0].code = "nid de poule"; })).success).toBe(false);
    expect(refus(modifie((c) => { c.evenements[0].code = ""; })).success).toBe(false);
  });

  it("identifiants de marqueurs ou d'evenements en double", () => {
    expect(refus(modifie((c) => { c.marqueurs.push({ ...c.marqueurs[0] }); })).success).toBe(false);
    expect(refus(modifie((c) => { c.evenements.push({ ...c.evenements[0] }); })).success).toBe(false);
  });

  it("repere dont lat et lon ne vont pas ensemble", () => {
    expect(refus(modifie((c) => { c.marqueurs[0].repere.lat = null; })).success).toBe(false);
  });

  it("qualification : largeur non positive", () => {
    expect(refus(modifie((c) => { c.evenements[0].qualification = { largeurM: 0 }; })).success).toBe(false);
  });

  it("missionId qui n'est pas un uuid", () => {
    expect(refus(modifie((c) => { c.missionId = "mission"; })).success).toBe(false);
    expect(refus(modifie((c) => { c.missionId = "00000000-0000-4000-8000-0000000000aa"; })).success).toBe(true);
  });

  it("un refus ne leve jamais d'exception, meme pour des types absurdes", () => {
    for (const absurde of [null, undefined, 3, "x", [], {}, { points: "x" }, { points: [[1]] }]) {
      expect(() => refus(absurde)).not.toThrow();
      expect(refus(absurde).success).toBe(false);
    }
  });
});
