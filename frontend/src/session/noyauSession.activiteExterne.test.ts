import { describe, expect, it } from "vitest";
import {
  PARAMETRES_SESSION as P, PLAFOND_ACTIVITE_EXTERNE_MS, contexteInitial, transition,
  type ContexteSession, type EtatSession, type EvenementSession,
} from "./noyauSession";

/**
 * ACTIVITE_EXTERNE (point GNSS d'un releve) : constat de la relecture independante. Le pont d'activite envoyait ACTIVITE, qui
 * remettait aussi `arrierePlanDepuisMs` a null : 30 min en arriere-plan avec des points GNSS restaient deverrouillees, sans borne.
 * Maintenant : evenement distinct, qui ne remet QUE le minuteur d'inactivite, plafonne a `PLAFOND_ACTIVITE_EXTERNE_MS`.
 */

const T0 = 1_790_000_000_000;
const MIN = 60_000;

const ouvert = (partiel: Partial<ContexteSession> = {}): ContexteSession =>
  contexteInitial({
    coffrePresent: true, cleEnMemoire: true, valideLeMs: T0, expireLeMs: T0 + P.dureeMaxMs, dernierInstantMs: T0,
    derniereActiviteMs: T0, derniereInteractionMs: T0, ...partiel,
  });

type SansTemps = EvenementSession extends infer E ? (E extends unknown ? Omit<E, "maintenantMs"> : never) : never;

/** Rejoue des evenements espaces dans le temps ; rend l'etat et le contexte finaux. */
function rejouer(etat: EtatSession, c: ContexteSession, suite: Array<[number, SansTemps]>) {
  let e = etat;
  let ctx = c;
  for (const [t, ev] of suite) {
    const r = transition(e, { ...ev, maintenantMs: T0 + t } as EvenementSession, ctx);
    e = r.etat;
    ctx = r.contexte;
  }
  return { etat: e, contexte: ctx };
}

describe("PLAFOND_ACTIVITE_EXTERNE_MS", () => {
  it("est nomme, vaut 30 minutes (PROVISOIRE) et fait partie des parametres", () => {
    expect(PLAFOND_ACTIVITE_EXTERNE_MS).toBe(30 * MIN);
    expect(P.plafondActiviteExterneMs).toBe(PLAFOND_ACTIVITE_EXTERNE_MS);
  });
});

describe("ACTIVITE_EXTERNE : verrou d'inactivite", () => {
  it("repousse le verrou d'inactivite tant que la derniere interaction reelle est recente", () => {
    // un point toutes les minutes pendant 29 min : jamais verrouille, malgre 5 min d'inactivite autorisees
    const suite: Array<[number, SansTemps]> = [];
    for (let m = 1; m <= 29; m += 1) suite.push([m * MIN, { type: "ACTIVITE_EXTERNE" }]);
    const r = rejouer("HORS_LIGNE_OUVERT", ouvert(), suite);
    expect(r.etat).toBe("HORS_LIGNE_OUVERT");
    expect(r.contexte.cleEnMemoire).toBe(true);
  });

  it("BORNE EXACTE : a 29 min 59 s 999 de la derniere interaction il repousse encore, a 30 min exactement il ne repousse plus", () => {
    const juste = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE_EXTERNE", maintenantMs: T0 + 30 * MIN - 1 }, ouvert({ derniereActiviteMs: T0 + 29 * MIN }));
    expect(juste.contexte.derniereActiviteMs).toBe(T0 + 30 * MIN - 1);
    const pile = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE_EXTERNE", maintenantMs: T0 + 30 * MIN }, ouvert({ derniereActiviteMs: T0 + 29 * MIN }));
    expect(pile.contexte.derniereActiviteMs).toBe(T0 + 29 * MIN); // inchangee
    expect(pile.etat).toBe("HORS_LIGNE_OUVERT"); // 1 min d'inactivite seulement : pas encore verrouille
  });

  it("au-dela du plafond, le verrou tombe au plus tard plafond + inactivite apres la derniere interaction, cle oubliee", () => {
    const suite: Array<[number, SansTemps]> = [];
    for (let s = 10; s <= 24 * 3600; s += 10) suite.push([s * 1000, { type: "ACTIVITE_EXTERNE" }]); // 24 h de points GNSS toutes les 10 s
    const r = rejouer("HORS_LIGNE_OUVERT", ouvert(), suite);
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(r.contexte.cleEnMemoire).toBe(false);
    // Le dernier instant qui a repousse est strictement avant 30 min ; le verrou date de cet instant + 5 min au plus.
    expect(r.contexte.derniereActiviteMs).toBe(T0 + 30 * MIN - 10_000);
    const verrou = transition("HORS_LIGNE_OUVERT", { type: "TICK", maintenantMs: T0 + 30 * MIN - 10_000 + P.inactiviteMs }, ouvert({ derniereActiviteMs: T0 + 30 * MIN - 10_000 }));
    expect(verrou.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(verrou.effets.map((x) => x.type)).toContain("OUBLIER_DEK");
  });

  it("une interaction REELLE relance le plafond", () => {
    const suite: Array<[number, SansTemps]> = [];
    for (let m = 1; m <= 29; m += 1) suite.push([m * MIN, { type: "ACTIVITE_EXTERNE" }]);
    suite.push([29 * MIN + 1000, { type: "ACTIVITE" }]);
    for (let m = 30; m <= 58; m += 1) suite.push([m * MIN + 1000, { type: "ACTIVITE_EXTERNE" }]); // 29 min apres l'interaction : repousse encore
    const r = rejouer("HORS_LIGNE_OUVERT", ouvert(), suite);
    expect(r.contexte.derniereActiviteMs).toBe(T0 + 58 * MIN + 1000);
    expect(r.etat).toBe("HORS_LIGNE_OUVERT");
  });

  it("sans cle en memoire ou sans reference d'activite : evenement ignore", () => {
    expect(transition("HORS_LIGNE_VERROUILLE", { type: "ACTIVITE_EXTERNE", maintenantMs: T0 + MIN }, ouvert({ cleEnMemoire: false })).applique).toBe(false);
    expect(transition("EN_LIGNE", { type: "ACTIVITE_EXTERNE", maintenantMs: T0 + MIN }, contexteInitial({ coffrePresent: true, cleEnMemoire: true })).applique).toBe(false);
  });

  it("derniereInteractionMs inconnue (contexte ancien) : la premiere activite externe la fixe a la derniere activite connue", () => {
    const sans = ouvert();
    delete (sans as { derniereInteractionMs?: unknown }).derniereInteractionMs;
    const r = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE_EXTERNE", maintenantMs: T0 + MIN }, sans);
    expect(r.contexte.derniereInteractionMs).toBe(T0);
    expect(r.contexte.derniereActiviteMs).toBe(T0 + MIN);
  });
});

describe("ACTIVITE_EXTERNE : verrou d'arriere-plan", () => {
  it("ne remet JAMAIS l'arriere-plan a zero : 2 min en arriere-plan verrouillent meme si des points arrivent toutes les 10 s", () => {
    const suite: Array<[number, SansTemps]> = [[1000, { type: "ARRIERE_PLAN" }]];
    for (let s = 10; s <= 180; s += 10) suite.push([s * 1000, { type: "ACTIVITE_EXTERNE" }]);
    const r = rejouer("HORS_LIGNE_OUVERT", ouvert(), suite);
    expect(r.etat).toBe("HORS_LIGNE_VERROUILLE");
    expect(r.contexte.cleEnMemoire).toBe(false);
  });

  it("a exactement la duree d'arriere-plan, le verrou tombe (borne inclusive), l'activite externe n'y change rien", () => {
    const c = ouvert({ arrierePlanDepuisMs: T0 });
    const avant = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE_EXTERNE", maintenantMs: T0 + P.arrierePlanMs - 1 }, c);
    expect(avant.etat).toBe("HORS_LIGNE_OUVERT");
    expect(avant.contexte.arrierePlanDepuisMs).toBe(T0);
    const pile = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE_EXTERNE", maintenantMs: T0 + P.arrierePlanMs }, c);
    expect(pile.etat).toBe("HORS_LIGNE_VERROUILLE");
  });

  it("l'interaction REELLE, elle, remet l'arriere-plan a zero (comportement conserve)", () => {
    const r = transition("HORS_LIGNE_OUVERT", { type: "ACTIVITE", maintenantMs: T0 + MIN }, ouvert({ arrierePlanDepuisMs: T0 }));
    expect(r.contexte.arrierePlanDepuisMs).toBeNull();
  });
});

describe("ACTIVITE_EXTERNE : en ligne", () => {
  it("meme regle : seule la cle est oubliee au-dela du plafond, l'etat reste EN_LIGNE", () => {
    const suite: Array<[number, SansTemps]> = [];
    for (let s = 60; s <= 2 * 3600; s += 60) suite.push([s * 1000, { type: "ACTIVITE_EXTERNE" }]);
    const r = rejouer("EN_LIGNE", ouvert(), suite);
    expect(r.etat).toBe("EN_LIGNE");
    expect(r.contexte.cleEnMemoire).toBe(false);
  });
});
