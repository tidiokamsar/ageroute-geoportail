// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  creerJournal, envoyerJournal, estUuid, evenementPourMotif, EVENEMENTS_LOCAUX, genererUuid, NOM_CLE_JOURNAL, OCCURRENCES_MAX, PLAFOND_JOURNAL,
  TAILLE_LOT_MAX, type CorpsLotEvenements, type StockageTexte,
} from "./journalEvenementsLocaux";
import { cleLocalStorage } from "./compteLocal";
import type { MotifJournal } from "./noyauSession";

/**
 * Journal des evenements locaux : une file PAR COMPTE, sans contenu, qui part par lots bornes et sans perte.
 * Les noms d'evenements, la forme du corps et les bornes sont ceux du serveur (backend/src/modules/auth/evenements-locaux.ts).
 */

const EMP_A = "aaaaaaaaaaaaaaaa";
const EMP_B = "bbbbbbbbbbbbbbbb";

function stockage(): StockageTexte & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
}

let n = 0;
const identifiant = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function journal(s: ReturnType<typeof stockage>, empreinte = EMP_A, t = Date.parse("2026-10-25T08:00:00.000Z")) {
  return creerJournal({ empreinte, stockage: s, identifiant, maintenant: () => t });
}

describe("contrat avec le serveur", () => {
  it("la liste des evenements est celle de la conception, dans le meme ordre", () => {
    expect([...EVENEMENTS_LOCAUX]).toEqual([
      "OUVERTURE_HORS_LIGNE", "DEVERROUILLAGE", "ECHEC_DEVERROUILLAGE", "VERROU_INACTIVITE",
      "SESSION_LOCALE_FERMEE", "SESSION_LOCALE_EXPIREE", "PIN_REINITIALISE", "EFFACEMENT_LOCAL",
    ]);
    expect(TAILLE_LOT_MAX).toBe(50);
  });

  it("chaque motif du noyau est rattache a un evenement de la liste fermee, ou ecarte (VERROU_MANUEL)", () => {
    const motifs: MotifJournal[] = [
      "OUVERTURE_HORS_LIGNE", "DEVERROUILLAGE", "ECHEC_DEVERROUILLAGE", "VERROU_INACTIVITE", "VERROU_ARRIERE_PLAN", "VERROU_MANUEL",
      "EXPIRATION", "HORLOGE_RECULEE", "FERMETURE_SESSION", "DECONNEXION_HORS_LIGNE", "DROITS_MODIFIES", "REINITIALISATION_PIN", "EFFACEMENT_LOCAL",
    ];
    for (const m of motifs) {
      const e = evenementPourMotif(m);
      expect(e === null || (EVENEMENTS_LOCAUX as readonly string[]).includes(e), m).toBe(true);
    }
    expect(evenementPourMotif("VERROU_MANUEL")).toBeNull();
    expect(evenementPourMotif("VERROU_ARRIERE_PLAN")).toBe("VERROU_INACTIVITE");
    expect(evenementPourMotif("DROITS_MODIFIES")).toBe("SESSION_LOCALE_FERMEE");
    expect(evenementPourMotif("HORLOGE_RECULEE")).toBe("SESSION_LOCALE_EXPIREE");
    expect(evenementPourMotif("REINITIALISATION_PIN")).toBe("PIN_REINITIALISE");
  });

  it("genererUuid donne des UUID v4 valides et distincts", () => {
    const a = genererUuid(); const b = genererUuid();
    expect(estUuid(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("file locale par compte", () => {
  it("un evenement porte un identifiant, une date ISO et rien d'autre ; la cle est celle du compte", () => {
    const s = stockage();
    journal(s).ajouter("DEVERROUILLAGE");
    expect([...s.m.keys()]).toEqual([cleLocalStorage(EMP_A, NOM_CLE_JOURNAL)]);
    const [e] = journal(s).lire();
    expect(Object.keys(e).sort()).toEqual(["evenement", "horodatageClient", "id"]);
    expect(e.horodatageClient).toBe("2026-10-25T08:00:00.000Z");
    expect(estUuid(e.id)).toBe(true);
  });

  it("ne contient ni PIN ni contenu : le texte stocke ne comporte que les champs attendus", () => {
    const s = stockage();
    const j = journal(s);
    j.ajouterMotif("ECHEC_DEVERROUILLAGE");
    j.ajouterMotif("REINITIALISATION_PIN");
    const brut = [...s.m.values()].join("");
    expect(brut).not.toMatch(/pin":|code|mot|secret|profil|userId|compteId/i);
  });

  it("deux comptes ont deux journaux separes", () => {
    const s = stockage();
    journal(s, EMP_A).ajouter("OUVERTURE_HORS_LIGNE");
    journal(s, EMP_B).ajouter("DEVERROUILLAGE");
    journal(s, EMP_B).ajouter("DEVERROUILLAGE");
    expect(journal(s, EMP_A).nombre()).toBe(1);
    expect(journal(s, EMP_B).nombre()).toBe(2);
  });

  it("les echecs consecutifs se regroupent en un evenement avec son nombre, jusqu'au plafond du serveur", () => {
    const s = stockage();
    const j = journal(s);
    for (let i = 0; i < 12; i += 1) j.ajouter("ECHEC_DEVERROUILLAGE");
    expect(j.lire()).toHaveLength(1);
    expect(j.lire()[0].occurrences).toBe(12);
    j.ajouter("DEVERROUILLAGE");
    j.ajouter("ECHEC_DEVERROUILLAGE");
    expect(j.lire().map((e) => [e.evenement, e.occurrences ?? 1])).toEqual([["ECHEC_DEVERROUILLAGE", 12], ["DEVERROUILLAGE", 1], ["ECHEC_DEVERROUILLAGE", 1]]);
    const t = stockage();
    const k = journal(t);
    for (let i = 0; i < OCCURRENCES_MAX + 5; i += 1) k.ajouter("ECHEC_DEVERROUILLAGE");
    expect(k.lire().map((e) => e.occurrences ?? 1)).toEqual([OCCURRENCES_MAX, 5]);
  });

  it("le plafond de taille retire les plus anciens et compte ce qui est perdu", () => {
    const s = stockage();
    const j = journal(s);
    for (let i = 0; i < PLAFOND_JOURNAL + 7; i += 1) j.ajouter(i % 2 === 0 ? "DEVERROUILLAGE" : "VERROU_INACTIVITE");
    expect(j.nombre()).toBe(PLAFOND_JOURNAL);
    expect(j.perdus()).toBe(7);
  });

  it("un contenu abime ou etranger est ignore sans lever", () => {
    const s = stockage();
    s.m.set(cleLocalStorage(EMP_A, NOM_CLE_JOURNAL), "{pas du json");
    expect(journal(s).lire()).toEqual([]);
    s.m.set(cleLocalStorage(EMP_A, NOM_CLE_JOURNAL), JSON.stringify({ v: 1, entrees: [{ id: "x", evenement: "PIRATE", horodatageClient: "2026-01-01T00:00:00Z" }], perdus: 0 }));
    expect(journal(s).lire()).toEqual([]);
    expect(() => journal(s).ajouter("DEVERROUILLAGE")).not.toThrow();
  });

  it("un stockage qui refuse l'ecriture ne leve pas : l'application continue", () => {
    const refuse: StockageTexte = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined };
    expect(() => creerJournal({ empreinte: EMP_A, stockage: refuse }).ajouter("DEVERROUILLAGE")).not.toThrow();
    expect(() => creerJournal({ empreinte: EMP_A, stockage: null }).ajouter("DEVERROUILLAGE")).not.toThrow();
  });
});

describe("envoi par lots", () => {
  it("poste les evenements, purge apres accuse, et le serveur recoit un corps conforme (appareilId au niveau du lot)", async () => {
    const s = stockage();
    const j = journal(s);
    j.ajouter("OUVERTURE_HORS_LIGNE"); j.ajouter("DEVERROUILLAGE");
    const recus: CorpsLotEvenements[] = [];
    const r = await envoyerJournal({ empreinte: EMP_A, stockage: s }, async (c) => { recus.push(c); }, { appareilId: "11111111-1111-4111-8111-111111111111" });
    expect(r).toMatchObject({ envoyes: 2, rejetes: 0, restants: 0, echec: false });
    expect(recus).toHaveLength(1);
    expect(recus[0].appareilId).toBe("11111111-1111-4111-8111-111111111111");
    expect(recus[0].evenements.map((e) => e.evenement)).toEqual(["OUVERTURE_HORS_LIGNE", "DEVERROUILLAGE"]);
    for (const e of recus[0].evenements) expect(Object.keys(e).every((k) => ["id", "evenement", "horodatageClient", "occurrences"].includes(k))).toBe(true);
    expect(j.nombre()).toBe(0);
  });

  it("un identifiant d'appareil qui n'est pas un UUID n'est pas envoye (le lot serait refuse en entier)", async () => {
    const s = stockage();
    journal(s).ajouter("DEVERROUILLAGE");
    const recus: CorpsLotEvenements[] = [];
    await envoyerJournal({ empreinte: EMP_A, stockage: s }, async (c) => { recus.push(c); }, { appareilId: "pas-un-uuid" });
    expect("appareilId" in recus[0]).toBe(false);
  });

  it("des lots de 50 au plus, dans l'ordre, et un nombre de lots borne par passage", async () => {
    const s = stockage();
    const j = journal(s);
    for (let i = 0; i < 120; i += 1) j.ajouter(i % 2 === 0 ? "DEVERROUILLAGE" : "VERROU_INACTIVITE");
    const tailles: number[] = [];
    const r = await envoyerJournal({ empreinte: EMP_A, stockage: s }, async (c) => { tailles.push(c.evenements.length); });
    expect(tailles).toEqual([50, 50, 20]);
    expect(r.restants).toBe(0);
    for (let i = 0; i < 120; i += 1) j.ajouter(i % 2 === 0 ? "DEVERROUILLAGE" : "VERROU_INACTIVITE");
    const bornes = await envoyerJournal({ empreinte: EMP_A, stockage: s }, async () => undefined, { lotsMax: 1 });
    expect(bornes.envoyes).toBe(50);
    expect(bornes.restants).toBe(70);
  });

  it("un echec d'envoi (reseau, 5xx, 401, 429) ne perd rien et le rejeu repart avec les memes identifiants", async () => {
    for (const statut of [undefined, 500, 401, 403, 408, 429]) {
      const s = stockage();
      const j = journal(s);
      j.ajouter("DEVERROUILLAGE");
      const avant = j.lire().map((e) => e.id);
      const r = await envoyerJournal({ empreinte: EMP_A, stockage: s }, async () => { throw statut === undefined ? {} : { statut }; });
      expect(r.echec, String(statut)).toBe(true);
      expect(j.lire().map((e) => e.id)).toEqual(avant);
      const reçus: string[] = [];
      await envoyerJournal({ empreinte: EMP_A, stockage: s }, async (c) => { reçus.push(...c.evenements.map((e) => e.id)); });
      expect(reçus).toEqual(avant);
      expect(j.nombre()).toBe(0);
    }
  });

  it("un lot que le serveur refuse lui-meme (400) est retire pour ne pas bloquer les suivants", async () => {
    const s = stockage();
    const j = journal(s);
    j.ajouter("DEVERROUILLAGE");
    const r = await envoyerJournal({ empreinte: EMP_A, stockage: s }, async () => { throw { statut: 400 }; });
    expect(r).toMatchObject({ rejetes: 1, echec: false, restants: 0 });
  });

  it("un seul passage a la fois par compte", async () => {
    const s = stockage();
    journal(s).ajouter("DEVERROUILLAGE");
    let appels = 0;
    let liberer: () => void = () => undefined;
    const bloque = new Promise<void>((res) => { liberer = res; });
    const premier = envoyerJournal({ empreinte: EMP_A, stockage: s }, async () => { appels += 1; await bloque; });
    const second = await envoyerJournal({ empreinte: EMP_A, stockage: s }, async () => { appels += 1; });
    expect(second.envoyes).toBe(0);
    liberer();
    await premier;
    expect(appels).toBe(1);
  });

  it("des echecs ajoutes PENDANT l'envoi ne sont pas perdus : le surplus repart sous un nouvel identifiant", async () => {
    const s = stockage();
    const j = journal(s);
    for (let i = 0; i < 3; i += 1) j.ajouter("ECHEC_DEVERROUILLAGE");
    await envoyerJournal({ empreinte: EMP_A, stockage: s }, async () => {
      journal(s).ajouter("ECHEC_DEVERROUILLAGE");
      journal(s).ajouter("ECHEC_DEVERROUILLAGE");
    });
    const restant = j.lire();
    expect(restant).toHaveLength(1);
    expect(restant[0].occurrences).toBe(2);
  });

  it("ne touche pas le journal d'un autre compte", async () => {
    const s = stockage();
    journal(s, EMP_A).ajouter("DEVERROUILLAGE");
    journal(s, EMP_B).ajouter("DEVERROUILLAGE");
    await envoyerJournal({ empreinte: EMP_A, stockage: s }, async () => undefined);
    expect(journal(s, EMP_A).nombre()).toBe(0);
    expect(journal(s, EMP_B).nombre()).toBe(1);
  });
});
