import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La qualification de portion arrivee hors ligne : ce que ces tests defendent.
 *
 * AUCUNE REGLE N'EST REIMPLEMENTEE ICI, ET IL FAUT LE VERIFIER
 *
 * Ce module appelle `creerPortion`, le meme service que la route en ligne. Le risque n'est
 * donc pas qu'une regle soit fausse, c'est qu'elle soit CONTOURNEE : un statut fourni par
 * le telephone, un auteur pris du payload, ou une cle d'idempotence libre. Les trois sont
 * testes.
 *
 * Le depot a deja divergé une fois dans ce programme : un ancien module de regles des
 * observations (supprime depuis) portait un duplicata de la regle de validation qui disait
 * `MOTIF_REQUIS` quand l'original disait `COMMENTAIRE_REQUIS`. C'est ce que ces tests existent pour empecher.
 *
 * UN REFUS DEFINITIF NE DOIT PAS REVENIR
 *
 * Un appareil qui reessaie un refus definitif le reessaiera a chaque retour de reseau, et
 * la file ne se videra jamais. Un appareil qui abandonne un refus temporaire perd une
 * observation de terrain. La distinction est testee des deux cotes.
 */

const h = vi.hoisted(() => ({
  demandes: [] as unknown[],
  auteurs: [] as string[],
  refus: null as string | null,
}));

vi.mock("../reseau/portions.service", () => ({
  creerPortion: async (d: unknown, auteurId: string) => {
    h.demandes.push(d);
    h.auteurs.push(auteurId);
    return h.refus !== null
      ? { refus: h.refus }
      : { refus: null, valeur: { id: "p-neuve", statutValidation: "A_VALIDER" } };
  },
}));

vi.mock("../reseau/portions.depot", () => ({
  depotDans: (tx: unknown) => ({ tx }),
}));

import { appliquerPortionSync, payloadPortion, refusDefinitif } from "./portions.sync";

const UUID = "11111111-1111-4111-8111-111111111111";
const TX = {} as Parameters<typeof appliquerPortionSync>[0];

function payload(over: Record<string, unknown> = {}) {
  return { tronconId: UUID, debutM: 0, finM: 8_000, revetement: "LATERITE", ...over };
}

beforeEach(() => {
  h.demandes.length = 0;
  h.auteurs.length = 0;
  h.refus = null;
});

describe("Ce que le telephone ne decide pas", () => {
  it("IGNORE un statutValidation envoye dans le payload", async () => {
    // Le contournement le plus simple de toute la separation des roles : zod ne connait
    // pas ce champ, donc il disparait avant d'atteindre le service.
    await appliquerPortionSync(TX, payload({ statutValidation: "VALIDE" }), {
      userId: "u-agent", operationId: "op-1",
    });
    expect(h.demandes[0]).not.toHaveProperty("statutValidation");
  });

  it("IGNORE un creeParId envoye dans le payload, et prend l'auteur du CONTEXTE", async () => {
    // Un auteur fourni par l'appareil desactiverait le controle d'auto-validation sans
    // laisser de trace.
    await appliquerPortionSync(TX, payload({ creeParId: "quelqu-un-d-autre" }), {
      userId: "u-agent", operationId: "op-1",
    });
    expect(h.auteurs[0]).toBe("u-agent");
    expect(h.demandes[0]).not.toHaveProperty("creeParId");
  });

  it("prend la cle d'idempotence du PROTOCOLE, pas du corps", async () => {
    // Un champ libre du corps aurait permis a deux operations distinctes de se faire
    // passer l'une pour l'autre, et une reprise aurait cree un doublon.
    await appliquerPortionSync(TX, payload({ clientOperationId: "clef-choisie-par-le-tel" }), {
      userId: "u-agent", operationId: "op-protocole",
    });
    expect(h.demandes[0]).toMatchObject({ clientOperationId: "op-protocole" });
  });

  it("IGNORE une origine envoyee par le payload", async () => {
    // L'origine dit COMMENT la portion est nee. La laisser au telephone permettrait de
    // faire passer une saisie pour un decoupage, et l'historique deviendrait illisible.
    await appliquerPortionSync(TX, payload({ origine: "FUSION" }), {
      userId: "u-agent", operationId: "op-1",
    });
    expect(h.demandes[0]).not.toHaveProperty("origine");
  });
});

describe("La forme du payload", () => {
  it("accepte une qualification minimale : troncon et deux bornes", async () => {
    const r = await appliquerPortionSync(TX, { tronconId: UUID, debutM: 0, finM: 500 }, {
      userId: "u", operationId: "op-1",
    });
    expect(r.ok).toBe(true);
  });

  it("REFUSE un tronconId qui n'est pas un UUID", async () => {
    const r = await appliquerPortionSync(TX, payload({ tronconId: "troncon-1" }), {
      userId: "u", operationId: "op-1",
    });
    expect(r).toEqual({ ok: false, motif: "PAYLOAD_INVALIDE" });
    // Et le service n'a pas ete appele : rien n'a touche la base.
    expect(h.demandes).toHaveLength(0);
  });

  it("REFUSE un payload sans bornes", async () => {
    const r = await appliquerPortionSync(TX, { tronconId: UUID }, { userId: "u", operationId: "op-1" });
    expect(r).toEqual({ ok: false, motif: "PAYLOAD_INVALIDE" });
  });

  it("NE RENVOIE PAS le detail zod, qui nommerait des champs internes", async () => {
    const r = await appliquerPortionSync(TX, { n_importe_quoi: 1 }, { userId: "u", operationId: "op-1" });
    expect(r).toEqual({ ok: false, motif: "PAYLOAD_INVALIDE" });
  });

  it("accepte une date de CONSTAT distincte de la date d'envoi", async () => {
    // Une portion relevee lundi et remontee vendredi decrit lundi. Confondre les deux
    // ferait vieillir toute la collecte hors ligne d'un coup.
    const r = payloadPortion.safeParse(payload({ observeeLe: "2026-10-09T08:00:00.000Z" }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.observeeLe).toEqual(new Date("2026-10-09T08:00:00.000Z"));
  });

  it("CONSERVE la date d'effet saisie hors ligne : zod ecarte en silence ce qu'il ne connait pas", async () => {
    // Sans `valideDu` dans le schema, la date saisie par l'agent disparaitrait a la
    // synchronisation, et la portion n'apparaitrait a aucune date du curseur temporel.
    await appliquerPortionSync(TX, payload({ valideDu: "2026-03-15T18:30:00Z" }), { userId: "u", operationId: "op-1" });
    expect((h.demandes[0] as { valideDu: Date }).valideDu.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("une date d'effet absente reste absente : rien n'est invente a partir de la date du constat", async () => {
    await appliquerPortionSync(TX, payload({ observeeLe: "2026-10-09T08:00:00.000Z" }), { userId: "u", operationId: "op-1" });
    expect((h.demandes[0] as { valideDu?: Date | null }).valideDu ?? null).toBeNull();
  });

  it("REFUSE une date d'effet future : un fait de terrain est deja vrai", async () => {
    const demain = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const r = await appliquerPortionSync(TX, payload({ valideDu: demain }), { userId: "u", operationId: "op-1" });
    expect(r).toEqual({ ok: false, motif: "PAYLOAD_INVALIDE" });
    expect(h.demandes).toHaveLength(0);
  });

  it("fait remonter le refus du service tel quel", async () => {
    h.refus = "CHEVAUCHE_UNE_VALIDEE";
    const r = await appliquerPortionSync(TX, payload(), { userId: "u", operationId: "op-1" });
    expect(r).toEqual({ ok: false, motif: "CHEVAUCHE_UNE_VALIDEE" });
  });
});

describe("Un refus definitif ne doit pas revenir a chaque reseau", () => {
  it("DEFINITIF : ce qui ne changera pas en reessayant", () => {
    for (const m of [
      "PAYLOAD_INVALIDE", "BORNES_INVERSEES", "HORS_TRONCON", "TROP_COURTE",
      "LONGUEUR_TRONCON_INCONNUE", "CHEVAUCHE_UNE_VALIDEE",
    ]) {
      expect(refusDefinitif(m)).toBe(true);
    }
  });

  it("CHEVAUCHE_UNE_VALIDEE est definitif, et c'est le cas interessant", () => {
    // L'agent doit requalifier la portion existante, pas en proposer une seconde. Le
    // reessayer ne changerait rien, et la file ne se viderait jamais.
    expect(refusDefinitif("CHEVAUCHE_UNE_VALIDEE")).toBe(true);
  });

  it("TEMPORAIRE : tout le reste, pour ne pas perdre une observation de terrain", () => {
    // Un motif inconnu est traite comme temporaire. Abandonner par defaut ferait perdre
    // une saisie a chaque motif ajoute plus tard sans etre range ici.
    expect(refusDefinitif("PORTION_INTROUVABLE")).toBe(false);
    expect(refusDefinitif("UN_MOTIF_AJOUTE_PLUS_TARD")).toBe(false);
  });
});
