import { describe, expect, it } from "vitest";
import { transitionPermise, TRANSITIONS } from "./observations.regles";

/**
 * La machine a etats d'une observation : BROUILLON, PROPOSEE, VALIDEE, REJETEE, CONVERTIE.
 *
 * CE QUI A QUITTE CE FICHIER, ET POURQUOI
 *
 * Il portait aussi son propre `validationPermise`, avec son propre `ROLES_VALIDATEURS`.
 * Cette copie etait devenue MORTE quand la regle a ete centralisee dans
 * `governance/validation` : la route importe la version partagee, et celle-ci n'etait plus
 * importee que par ce test.
 *
 * Elle n'avait notamment pas la verification de delegation ajoutee le 13/10/2026 —
 * quiconque l'aurait importee aurait obtenu la regle d'avant en croyant appliquer la
 * courante, et ses tests l'auraient confirme. Ces cas sont desormais defendus dans
 * `governance/validation.test.ts`, sur la source unique.
 *
 * CE QUI RESTE EST IRREMPLACABLE
 *
 * Les transitions ci-dessous sont celles de l'ENUM EN BASE, et elles ne se confondent pas
 * avec les quatre statuts de la gouvernance. VALIDEE ne revient jamais en arriere ;
 * REJETEE n'est pas une impasse ; CONVERTIE est terminal. Ces trois phrases decrivent le
 * cycle de vie d'une observation et de rien d'autre.
 */

describe("Le cycle de vie d'une observation", () => {
  it("mene un brouillon jusqu'a la conversion", () => {
    const chemin = ["BROUILLON", "PROPOSEE", "VALIDEE", "CONVERTIE"];
    for (let i = 1; i < chemin.length; i++) {
      expect(transitionPermise(chemin[i - 1], chemin[i]), `${chemin[i - 1]} vers ${chemin[i]}`).toBe(true);
    }
  });

  it("laisse un rejet revenir en proposition apres correction", () => {
    // REJETEE n'est pas une impasse : c'est le circuit normal d'une donnee qu'on
    // demande de reprendre.
    expect(transitionPermise("REJETEE", "PROPOSEE")).toBe(true);
  });

  it("NE DEVALIDE JAMAIS", () => {
    // Une donnee devenue officielle a pu etre lue, citee, reprise dans un marche. La
    // devalider en silence reecrirait l'histoire ; on produit une nouvelle
    // observation, et les deux restent.
    expect(transitionPermise("VALIDEE", "PROPOSEE")).toBe(false);
    expect(transitionPermise("VALIDEE", "REJETEE")).toBe(false);
  });

  it("ferme la conversion", () => {
    expect(TRANSITIONS.CONVERTIE).toEqual([]);
  });

  it("interdit de valider un brouillon sans le proposer", () => {
    expect(transitionPermise("BROUILLON", "VALIDEE")).toBe(false);
  });

  it("refuse tout retour sur soi-meme", () => {
    for (const s of Object.keys(TRANSITIONS)) {
      expect(transitionPermise(s, s), `${s} vers lui-meme`).toBe(false);
    }
  });
});
