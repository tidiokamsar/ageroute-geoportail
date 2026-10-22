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
  observationCreee: null as Record<string, unknown> | null,
}));

const tx = {
  catalogueDefaut: { findUnique: vi.fn(async () => h.catalogue) },
  troncon: { findFirst: vi.fn(async () => h.troncon) },
  mission: { findFirst: vi.fn(async () => h.missionAssignee ? h.mission : null) },
  observation: {
    findFirst: vi.fn(async () => h.observationAutorisee ? h.observation : null),
    // Le conteneur est materialise dans CETTE transaction depuis que
    // `defauts.observationId` est NOT NULL.
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      h.observationCreee = data;
      return { id: "obs-1" };
    }),
  },
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
  h.observationCreee = null;
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

describe("contour GPS d'un defaut hors ligne (A5)", () => {
  const trait = { type: "LineString" as const, coordinates: [[-13.7, 9.5], [-13.69, 9.5]] };
  const valide = [{ valide: true, raison: "Valid Geometry" }];
  const base = { catalogueCode: "ORNIERAGE", lat: 9.5, lon: -13.7, gravite: 2, mesures: { profondeurM: 0.04 } };
  const avecRaw = (reponses: unknown[][]) => ({ ...tx, $queryRaw: vi.fn(async () => reponses.shift() ?? []) }) as unknown as Prisma.TransactionClient;

  it("tire la quantite du contour, la laisse a null pour Prisma et la porte a part pour l'ecriture SQL", async () => {
    const t = avecRaw([valide, [{ epsg: 32628, longueurM: 1093.456, surfaceM2: 0, ecartLongueur: 0.0004, ecartSurface: null }]]);
    const r = await preparerDefautSync(t, contexte, { ...base, emprise: trait });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preparation.data).toMatchObject({ quantite: null, uniteQuantite: null, methodeQuantite: null, longueurM: null });
    expect(r.preparation.quantite).toBe(1093.456);
    expect(r.preparation.methode).toBe("EMPRISE_UTM");
    expect(r.preparation.emprise).toEqual({ geojson: trait, quantite: { valeur: 1093.456, unite: "METRE", methode: "EMPRISE_UTM" } });
  });

  it("refuse un contour invalide avec son motif, sans creer de conteneur", async () => {
    const t = avecRaw([[{ valide: false, raison: "Too few points in geometry component" }]]);
    const r = await preparerDefautSync(t, contexte, { ...base, emprise: trait });
    expect(r).toEqual({ ok: false, motif: "EMPRISE_INVALIDE" });
    expect(h.observationCreee).toBeNull();
  });

  it("refuse un contour hors de l'etendue WGS 84 sans interroger la base", async () => {
    const t = avecRaw([]);
    const r = await preparerDefautSync(t, contexte, { ...base, emprise: { type: "LineString", coordinates: [[653632, 1061500], [653700, 1061500]] } });
    expect(r).toEqual({ ok: false, motif: "EMPRISE_ILLISIBLE" });
    expect((t as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).not.toHaveBeenCalled();
  });

  it("le contour est un champ DECLARE du payload : zod n'ecarte pas en silence ce que le telephone envoie", async () => {
    const t = avecRaw([valide, [{ epsg: 32628, longueurM: 10, surfaceM2: 0, ecartLongueur: 0.0004, ecartSurface: null }]]);
    const r = await preparerDefautSync(t, contexte, { ...base, emprise: trait });
    expect(r.ok && r.preparation.emprise).not.toBeNull();
    // ... et un champ voisin non declare est toujours refuse.
    const inconnu = await preparerDefautSync(avecRaw([]), contexte, { ...base, empriseM2: 12 });
    expect(inconnu).toMatchObject({ ok: false, motif: expect.stringContaining("PAYLOAD_INVALIDE") });
  });

  it("sans contour, aucune lecture SQL brute et emprise nulle", async () => {
    const t = avecRaw([]);
    const r = await preparerDefautSync(t, contexte, { ...base, mesures: { longueurM: 50, profondeurM: 0.04 } });
    expect(r.ok && r.preparation.emprise).toBeNull();
    expect((t as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).not.toHaveBeenCalled();
  });
});
