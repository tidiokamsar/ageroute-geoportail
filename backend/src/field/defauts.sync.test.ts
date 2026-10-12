import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { preparerDefautSync } from "./defauts.sync";

const h = vi.hoisted(() => ({
  catalogue: {
    id: 2,
    code: "ORNIERAGE",
    unite: "METRE",
    mesuresRequises: ["LONGUEUR", "PROFONDEUR"],
    graviteMax: 4,
    actif: true,
  },
  troncon: { id: "t1", longueurKm: 2 },
  mission: { id: "m1" },
  observation: { id: "o1", missionId: "m1" },
  codeExiste: false,
  missionAssignee: true,
  observationAutorisee: true,
}));

const tx = {
  catalogueDefaut: { findUnique: vi.fn(async () => h.catalogue) },
  troncon: { findFirst: vi.fn(async () => h.troncon) },
  mission: { findFirst: vi.fn(async () => h.missionAssignee ? h.mission : null) },
  observation: { findFirst: vi.fn(async () => h.observationAutorisee ? h.observation : null) },
  defaut: {
    findUnique: vi.fn(async () => h.codeExiste ? { id: "d-existing" } : null),
  },
} as unknown as Prisma.TransactionClient;

const contexte = {
  entityId: "d1",
  operationId: "11111111-1111-4111-8111-111111111111",
  userId: "agent-1",
  appareilId: "22222222-2222-4222-8222-222222222222",
};

beforeEach(() => {
  h.codeExiste = false;
  h.missionAssignee = true;
  h.observationAutorisee = true;
  vi.clearAllMocks();
});

describe("préparation d'un défaut hors ligne", () => {
  it("calcule le métré et force l'auteur, l'idempotence et l'état de proposition côté serveur", async () => {
    const r = await preparerDefautSync(tx, contexte, {
      catalogueCode: "ORNIERAGE",
      lat: 9.5,
      lon: -13.7,
      missionId: "33333333-3333-4333-8333-333333333333",
      mesures: { longueurM: 50, profondeurM: 0.04 },
      gravite: 2,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("La préparation attendue a été refusée");
    expect(r.preparation.data).toMatchObject({
      id: "d1",
      clientOperationId: contexte.operationId,
      constateParId: "agent-1",
      statutValidation: "A_VALIDER",
      etat: "ACTIF",
      version: 1,
      quantite: 50,
      methodeQuantite: "LONGUEUR",
    });
  });

  it("rejette les identités et statuts que le client tente de fournir", async () => {
    const r = await preparerDefautSync(tx, contexte, {
      catalogueCode: "ORNIERAGE",
      lat: 9.5,
      lon: -13.7,
      constateParId: "autre-agent",
      statutValidation: "VALIDE",
    });

    expect(r).toMatchObject({ ok: false, motif: expect.stringContaining("PAYLOAD_INVALIDE") });
  });

  it("exige une confiance d'appariement avec l'abscisse locale", async () => {
    const r = await preparerDefautSync(tx, contexte, {
      catalogueCode: "ORNIERAGE",
      tronconId: "t1",
      abscisseM: 250,
      mesures: { longueurM: 50, profondeurM: 0.04 },
      gravite: 2,
    });

    expect(r).toEqual({ ok: false, motif: "CONFIANCE_APPARIEMENT_REQUISE" });
  });

  it("refuse le métré incomplet et les abscisses au-delà du tronçon", async () => {
    const incomplet = await preparerDefautSync(tx, contexte, {
      catalogueCode: "ORNIERAGE",
      lat: 9.5,
      lon: -13.7,
      mesures: { longueurM: 50 },
      gravite: 2,
    });
    expect(incomplet).toEqual({ ok: false, motif: "RELEVE_INCOMPLET" });

    const horsTroncon = await preparerDefautSync(tx, contexte, {
      catalogueCode: "ORNIERAGE",
      tronconId: "t1",
      abscisseM: 2_001,
      confianceAppariement: 0.95,
      mesures: { longueurM: 50, profondeurM: 0.04 },
      gravite: 2,
    });
    expect(horsTroncon).toEqual({ ok: false, motif: "ABSCISSE_HORS_TRONCON" });
  });

  it("n'accepte qu'une mission de l'utilisateur ou de son appareil", async () => {
    h.missionAssignee = false;
    const r = await preparerDefautSync(tx, contexte, {
      catalogueCode: "ORNIERAGE",
      lat: 9.5,
      lon: -13.7,
      missionId: "33333333-3333-4333-8333-333333333333",
      mesures: { longueurM: 50, profondeurM: 0.04 },
      gravite: 2,
    });

    expect(r).toEqual({ ok: false, motif: "MISSION_INTROUVABLE_OU_NON_ASSIGNEE" });
  });
});
