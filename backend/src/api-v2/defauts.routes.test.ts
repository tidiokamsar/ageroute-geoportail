import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/defauts` — ce que ces tests defendent.
 *
 * LE RELEVE INCOMPLET EST REFUSE SUR PLACE. C'est la raison d'etre du catalogue : un
 * orniérage sans profondeur produit un métré juste sur un relevé inutilisable. Si ce
 * refus cassait, la correction ne se verrait qu'au bureau, et chaque mesure manquante
 * redeviendrait un déplacement.
 *
 * L'AUTEUR VIENT DE LA LIGNE, PAS DE LA REQUÊTE. Toute la séparation des rôles
 * repose sur ce choix : un client qui passerait `auteurId` dans le corps ne doit rien
 * pouvoir désactiver, et un champ d'identité inconnu doit être rejeté, pas ignoré.
 *
 * LA DÉCISION ÉCRIT L'HISTORIQUE. Une validation qui ne laisserait pas de ligne dans
 * `validations` perdrait la chaîne des décisions — l'objet auditable — tout en
 * changeant l'état visible.
 */
const h = vi.hoisted(() => {
  const catalogue = {
    NID_POULE: { id: 1, code: "NID_POULE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, actif: true, version: 1, famille: "CHAUSSEE", libelle: "Nid de poule" },
    ORNIERAGE: { id: 2, code: "ORNIERAGE", unite: "METRE", mesuresRequises: ["LONGUEUR", "PROFONDEUR"], graviteMax: 4, actif: true, version: 1, famille: "CHAUSSEE", libelle: "Orniérage" },
    SIGNALISATION: { id: 12, code: "SIGNALISATION", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: null, actif: true, version: 1, famille: "SIGNALISATION", libelle: "Signalisation" },
    AUTRE: { id: 13, code: "AUTRE", unite: "UNITE", mesuresRequises: [], graviteMax: 4, actif: true, version: 1, famille: "CHAUSSEE", libelle: "Autre" },
  };
  return {
    compte: { id: "agent-1", role: "INSPECTEUR" },
    catalogue,
    defautExistant: null as Record<string, unknown> | null,
    defautCree: null as Record<string, unknown> | null,
    missions: [] as Array<{ id: string }>,
    updateCount: 1,
    validations: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    qualites: [] as Record<string, unknown>[],
    media: null as Record<string, unknown> | null,
    /** Photos deja rattachees, pour eprouver le plafond par objet. */
    photosDuDefaut: 0,
    /** Observation conteneur creee par le serveur, pour l'inspecter. */
    observationCreee: null as Record<string, unknown> | null,
    /** Delegations du domaine DEFAUT presentes en base. */
    delegations: [] as Record<string, unknown>[],
    setPointGeom: vi.fn(async () => {}),
    match: { tronconId: "t1", code: "RN1-001", nom: "RN1", classe: "RN", distanceM: 3, abscisseM: 120, pk: 4.2, pkMotif: "CALCULE", confiance: 0.9, ambigu: false },
    apparier: vi.fn(async () => h.match),
    tronconTrouve: { id: "t1", longueurKm: 2.0 },
  };
});

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/upload-photo.middleware", () => ({
  uploadPhoto: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, {
      file: {
        path: "uploads/photos/photo-test.jpg", filename: "photo-test.jpg",
        originalname: "photo.jpg", mimetype: "image/jpeg", size: 12,
      },
    });
    next();
  },
  // Importe par `lib/photos.ts` et par le garde-fou de quota : le mock doit l'exporter,
  // sinon l'acces leve au premier televersement et la route rend 500.
  PHOTOS_UPLOAD_DIR: "uploads/photos",
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("photo-test-bytes")),
  unlink: vi.fn(async () => undefined),
  // Le garde-fou de quota mesure le repertoire (`readdir`) et compte la photo retenue
  // (`stat`). Un repertoire vide laisse le plafond global hors de cause : ce sont les
  // tests du plafond PAR OBJET qui nous interessent ici.
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ size: 12 })),
}));
vi.mock("../geo/appariement", () => ({ apparier: h.apparier }));
vi.mock("../lib/prisma", () => ({
  prisma: {
    catalogueDefaut: {
      findUnique: vi.fn(async ({ where }: { where: { code?: string; id?: number } }) =>
        where.code ? h.catalogue[where.code as keyof typeof h.catalogue] ?? null : Object.values(h.catalogue).find((c) => c.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where?: { actif?: boolean } } = {}) => Object.values(h.catalogue)
        .filter((c) => where?.actif === undefined || c.actif === where.actif)
        .map((c) => ({
          code: c.code,
          libelle: c.libelle,
          famille: c.famille,
          unite: c.unite,
          mesuresRequises: c.mesuresRequises,
          graviteMax: c.graviteMax,
        }))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 14, version: 1, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 13),
    },
    troncon: {
      findFirst: vi.fn(async () => h.tronconTrouve),
      findUnique: vi.fn(async () => h.tronconTrouve),
    },
    mission: {
      findFirst: vi.fn(async () => ({ id: "m1" })),
      findMany: vi.fn(async () => h.missions),
    },
    // Paragraphe 35 : « un validateur est designe pour chaque domaine ». La route de
    // decision lit ces designations ; un mock sans ce delegue fait rendre 500.
    delegationValidation: { findMany: vi.fn(async () => h.delegations) },
    observation: {
      findFirst: vi.fn(async () => ({ id: "o1", missionId: null })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.observationCreee = data;
        return { id: "obs-1" };
      }),
    },
    defaut: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; clientOperationId?: string; code?: string } }) => {
        if (where.id) return h.defautCree ?? h.defautExistant;
        if (where.clientOperationId && h.defautExistant) return h.defautExistant;
        return null;
      }),
      findFirst: vi.fn(async (
        { where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {},
      ) => {
        const defaut = h.defautExistant;
        if (!defaut) return null;

        // Le filtre d'appartenance DOIT etre honore : le comptage de photos s'en sert
        // pour rendre `null` a qui n'a pas le droit de toucher le defaut, et laisser la
        // route repondre son 404. Un mock qui l'ignore ferait passer un test de fuite.
        if (where?.constateParId && where.constateParId !== defaut.constateParId) return null;

        const clauses = where?.OR;
        if (Array.isArray(clauses)) {
          const visible = clauses.some((clause) => {
            if (typeof clause !== "object" || clause === null) return false;
            const c = clause as Record<string, unknown>;
            if (c.constateParId === defaut.constateParId) return true;
            const missionClause = c.missionId as { in?: string[] } | undefined;
            return Boolean(missionClause?.in?.includes(String(defaut.missionId)));
          });
          if (!visible) return null;
        }

        // Prisma rend la forme demandee, pas la ligne entiere. Le comptage de photos
        // demande `select: { _count: { select: { medias: true } } }`.
        if (select && "_count" in select) return { _count: { medias: h.photosDuDefaut } };
        return defaut;
      }),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.defautCree = { id: "d1", version: 1, statutValidation: "A_VALIDER", etat: "ACTIF", ...data };
        return h.defautCree;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...h.defautExistant, ...data })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.defautExistant && h.updateCount === 1) {
          const next = { ...data };
          if (typeof next.version === "object" && next.version !== null && "increment" in next.version) {
            next.version = Number(h.defautExistant.version) + Number((next.version as { increment: number }).increment);
          }
          h.defautExistant = { ...h.defautExistant, ...next };
        }
        return { count: h.updateCount };
      }),
    },
    validation: {
      findMany: vi.fn(async () => h.validations),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.validations.push(data);
        return data;
      }),
    },
    mediaDefaut: {
      findUnique: vi.fn(async () => h.media),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "media-1", ...data })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      // Le serveur materialise l'observation conteneur DANS cette transaction depuis que
      // `defauts.observationId` est NOT NULL. Un mock sans ce delegue ferait rendre 500
      // a la creation, sans dire pourquoi.
      observation: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          h.observationCreee = data;
          return { id: "obs-1" };
        }),
      },
      defaut: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          h.defautCree = { id: "d1", version: 1, statutValidation: "A_VALIDER", etat: "ACTIF", ...data };
          return h.defautCree;
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...h.defautExistant, ...data })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (h.defautExistant && h.updateCount === 1) {
            const next = { ...data };
            if (typeof next.version === "object" && next.version !== null && "increment" in next.version) {
              next.version = Number(h.defautExistant.version) + Number((next.version as { increment: number }).increment);
            }
            h.defautExistant = { ...h.defautExistant, ...next };
          }
          return { count: h.updateCount };
        }),
        findUnique: vi.fn(async () => h.defautExistant),
      },
      catalogueDefaut: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 14, version: 1, ...data })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async ({ where }: { where: { code: keyof typeof h.catalogue } }) => h.catalogue[where.code] ?? null),
      },
      mediaDefaut: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "media-1", ...data })),
      },
      auditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.audits.push(data); return data; }),
      },
      validation: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          h.validations.push(data);
          return data;
        }),
      },
    })),
  },
}));
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(async (p: Record<string, unknown>) => { h.audits.push(p); }),
  logAuditTransactionnelle: vi.fn(async (tx: { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } }, p: Record<string, unknown>) => tx.auditLog.create({ data: p })),
}));
vi.mock("../lib/qualite", () => ({ enregistrerQualite: vi.fn(async (p: Record<string, unknown>) => { h.qualites.push(p); }) }));
vi.mock("../lib/geo", () => ({
  setPointGeom: h.setPointGeom,
  deriveGeomFromTroncon: vi.fn(async () => true),
  deriveGeomFromTronconAbscisse: vi.fn(async () => true),
}));

import { defautsV2Router } from "./defauts.routes";
import { errorHandler } from "../middleware/error.middleware";

const app = express();
app.use(express.json());
app.use("/api/v2/defauts", defautsV2Router);
app.use((_req, res) => res.status(404).json({ error: "Route introuvable" }));
// Le middleware d'erreur fait partie du contrat : un ZodError doit répondre 400 au
// client, pas 500. Sans lui, ces tests ne defendraient pas ce que la production sert.
app.use(errorHandler);

/** Un défaut cohérent, tel que la route le relit en base. */
function defautEnBase(surcharge: Record<string, unknown> = {}) {
  return {
    id: "d1",
    version: 1,
    deletedAt: null,
    statutValidation: "A_VALIDER",
    constateParId: "agent-1",
    clientOperationId: null,
    tronconId: null,
    nombre: null, longueurM: null, largeurM: null, profondeurM: null, quantiteSaisie: null,
    quantite: null, gravite: null, etendue: null, etat: "ACTIF", traiteA: null,
    catalogue: h.catalogue.ORNIERAGE,
    ...surcharge,
  };
}

beforeEach(() => {
  h.compte.id = "agent-1";
  h.compte.role = "INSPECTEUR";
  h.defautExistant = null;
  h.defautCree = null;
  h.missions = [];
  h.updateCount = 1;
  h.validations = [];
  h.audits = [];
  h.qualites = [];
  h.media = null;
  h.photosDuDefaut = 0;
  h.observationCreee = null;
  h.delegations = [];
  h.apparier.mockClear();
  vi.clearAllMocks();
});

describe("POST /api/v2/defauts — création", () => {
  const gps = { lat: 9.5, lon: -13.7 };

  it("refuse un orniérage sans profondeur : le relevé incomplet ne passe pas la porte", async () => {
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", ...gps,
      mesures: { longueurM: 50 },
      gravite: 2,
    });
    expect(r.status).toBe(422);
    expect(r.body.motif).toBe("RELEVE_INCOMPLET");
    expect(r.body.message).toContain("la profondeur");
    expect(h.defautCree).toBeNull();
  });

  it("accepte l'orniérage complet et pose son métré linéaire", async () => {
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", ...gps,
      mesures: { longueurM: 50, profondeurM: 0.04 },
      gravite: 2,
    });
    expect(r.status).toBe(201);
    expect(r.body.quantite).toBe(50);
    expect(r.body.methodeQuantite).toBe("LONGUEUR");
    expect(r.body.constateParId).toBe("agent-1");
  });

  describe("Tout défaut a son observation", () => {
    /**
     * `defauts.observationId` est NOT NULL depuis le 13/10/2026 (§7.1). Le frontend n'en
     * envoyait JAMAIS — zéro occurrence dans tout `frontend/src` — donc la contrainte
     * seule aurait cassé la saisie terrain à la première photo.
     *
     * Le serveur matérialise le conteneur depuis le relevé lui-même, dans la MÊME
     * transaction. Ces tests défendent le lien, et surtout la frontière : matérialiser
     * depuis la soumission, jamais déduire.
     */
    it("matérialise le conteneur et y rattache le défaut", async () => {
      const r = await request(app).post("/api/v2/defauts").send({
        catalogueCode: "ORNIERAGE", ...gps,
        mesures: { longueurM: 50, profondeurM: 0.04 }, gravite: 2,
      });
      expect(r.status).toBe(201);
      expect(r.body.observationId).toBe("obs-1");
      // Le conteneur reprend l'agent et la position du relevé, sans rien inventer.
      expect(h.observationCreee).toMatchObject({
        agentId: "agent-1", type: "CHAUSSEE", lat: gps.lat, lon: gps.lon,
      });
    });

    it("n'en crée AUCUN quand le terrain fournit déjà une observation", async () => {
      // Le jour où le client enverra observation puis défauts, ce chemin ne doit pas
      // doubler les conteneurs.
      const r = await request(app).post("/api/v2/defauts").send({
        catalogueCode: "ORNIERAGE", ...gps,
        mesures: { longueurM: 50, profondeurM: 0.04 }, gravite: 2,
        observationId: "00000000-0000-4000-8000-000000000001",
      });
      expect(r.status).toBe(201);
      expect(h.observationCreee).toBeNull();
      expect(r.body.observationId).toBe("00000000-0000-4000-8000-000000000001");
    });

    it("dérive la clé du conteneur de celle de l'opération", async () => {
      // Un rejeu rencontre alors la même collision d'unicité sur les deux lignes, et non
      // une observation de plus à chaque tentative.
      await request(app).post("/api/v2/defauts").send({
        catalogueCode: "ORNIERAGE", ...gps,
        mesures: { longueurM: 50, profondeurM: 0.04 }, gravite: 2,
        clientOperationId: "33333333-3333-4333-8333-333333333333",
      });
      expect(h.observationCreee?.clientOperationId)
        .toBe("33333333-3333-4333-8333-333333333333-observation");
    });

    it("n'invente pas de position quand le relevé n'en a pas", async () => {
      // Un conteneur doté d'une position plausible mentirait sur l'endroit du constat, et
      // cette position remonterait ensuite comme celle de l'observation d'origine.
      const r = await request(app).post("/api/v2/defauts").send({
        catalogueCode: "ORNIERAGE", tronconId: "t1", abscisseM: 120, confianceAppariement: 0.9,
        mesures: { longueurM: 50, profondeurM: 0.04 }, gravite: 2,
      });
      expect(r.status).toBe(201);
      expect(h.observationCreee).toMatchObject({ lat: null, lon: null, tronconId: "t1" });
    });
  });

  it("refuse un défaut rattaché à une mission que l'auteur ne peut pas consulter", async () => {
    const { prisma } = await import("../lib/prisma");
    vi.mocked(prisma.mission.findFirst).mockResolvedValueOnce(null);
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", missionId: "00000000-0000-4000-8000-000000000001",
      ...gps, mesures: { longueurM: 2, profondeurM: 0.04 },
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toContain("non autorisée");
    expect(h.defautCree).toBeNull();
  });

  it("refuse une observation liée à une autre mission", async () => {
    const { prisma } = await import("../lib/prisma");
    vi.mocked(prisma.observation.findFirst).mockResolvedValueOnce({
      id: "00000000-0000-4000-8000-000000000002",
      missionId: "00000000-0000-4000-8000-000000000003",
    } as never);
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE",
      missionId: "00000000-0000-4000-8000-000000000001",
      observationId: "00000000-0000-4000-8000-000000000002",
      ...gps, mesures: { longueurM: 2, profondeurM: 0.04 },
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toContain("ne correspondent pas");
    expect(h.defautCree).toBeNull();
  });

  it("calcule la surface du nid-de-poule et la marque DÉRIVÉE dans la qualité", async () => {
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "NID_POULE", ...gps,
      mesures: { longueurM: 4.2, largeurM: 1.8, profondeurM: 0.15 },
      gravite: 3,
    });
    expect(r.status).toBe(201);
    expect(r.body.quantite).toBe(7.56);
    expect(h.qualites[0]).toMatchObject({ entityType: "Defaut", champ: "quantite", statut: "DERIVED" });
  });

  it("borne la gravité par le catalogue : hors échelle, et refusée sur un type sans gravité", async () => {
    const trop = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "NID_POULE", ...gps, gravite: 5,
      mesures: { longueurM: 1, largeurM: 1, profondeurM: 0.1 },
    });
    expect(trop.status).toBe(422);
    expect(trop.body.motif).toBe("HORS_ECHELLE");

    const sansEchelle = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "SIGNALISATION", ...gps, gravite: 1, mesures: { nombre: 2 },
    });
    expect(sansEchelle.status).toBe(422);
    expect(sansEchelle.body.motif).toBe("TYPE_SANS_GRAVITE");

    const comptee = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "SIGNALISATION", ...gps, mesures: { nombre: 2 },
    });
    expect(comptee.status).toBe(201);
  });

  it("exige une localisation : GPS, ou tronçon avec un repère", async () => {
    const rien = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "NID_POULE", mesures: { longueurM: 1, largeurM: 1, profondeurM: 0.1 },
    });
    expect(rien.status).toBe(422);

    const demi = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "NID_POULE", lat: 9.5, mesures: { longueurM: 1, largeurM: 1, profondeurM: 0.1 },
    });
    expect(demi.status).toBe(422);

    const sansReperes = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "NID_POULE", tronconId: "t1",
      mesures: { longueurM: 1, largeurM: 1, profondeurM: 0.1 },
    });
    expect(sansReperes.status).toBe(422);
  });

  it("exige la confiance d'appariement avec l'abscisse, et l'accepte avec elle", async () => {
    const base = {
      catalogueCode: "ORNIERAGE", tronconId: "t1",
      mesures: { longueurM: 50, profondeurM: 0.04 }, gravite: 2,
    };
    const sans = await request(app).post("/api/v2/defauts").send({ ...base, abscisseM: 120 });
    expect(sans.status).toBe(422);

    const avec = await request(app).post("/api/v2/defauts").send({ ...base, abscisseM: 120, confianceAppariement: 0.9 });
    expect(avec.status).toBe(201);
  });

  it("refuse un défaut plus long que le tronçon qui le porte", async () => {
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", tronconId: "t1", pk: 1,
      mesures: { longueurM: 5_000, profondeurM: 0.04 }, gravite: 2,
    });
    expect(r.status).toBe(422);
    expect(r.body.motif).toBe("DEPASSE_LE_TRONCON");
  });

  it("accepte AUTRE sans relevé : le défaut existe, sa quantité attend le relevé", async () => {
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "AUTRE", ...gps, gravite: 2,
    });
    expect(r.status).toBe(201);
    expect(r.body.quantite).toBeNull();
    expect(h.qualites).toHaveLength(0);
  });

  it("rend la ligne existante sur un clientOperationId déjà vu, sans en créer une seconde", async () => {
    h.defautExistant = defautEnBase({ id: "d-deja-la", clientOperationId: "11111111-1111-4111-8111-111111111111" });
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", ...gps, clientOperationId: "11111111-1111-4111-8111-111111111111",
      mesures: { longueurM: 50, profondeurM: 0.04 },
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("d-deja-la");
    expect(h.defautCree).toBeNull();
  });

  it("ne divulgue pas le défaut d'un autre auteur lors d'une collision de clé", async () => {
    h.defautExistant = defautEnBase({
      id: "d-autre-agent",
      constateParId: "agent-2",
      clientOperationId: "22222222-2222-4222-8222-222222222222",
    });

    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE",
      lat: 9.5,
      lon: -13.7,
      clientOperationId: "22222222-2222-4222-8222-222222222222",
    });

    expect(r.status).toBe(409);
    expect(r.body).not.toHaveProperty("id");
    expect(h.defautCree).toBeNull();
  });

  it("pose la géométrie du point depuis le GPS", async () => {
    await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", ...gps, gravite: 2, mesures: { longueurM: 50, profondeurM: 0.04 },
    });
    expect(h.setPointGeom).toHaveBeenCalledWith("defauts", "d1", 9.5, -13.7);
  });

  it("dérive aussi la géométrie depuis l'abscisse locale sans dépendre du PK", async () => {
    const { deriveGeomFromTronconAbscisse } = await import("../lib/geo");
    await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", tronconId: "t1", abscisseM: 120,
      confianceAppariement: 0.9, gravite: 2,
      mesures: { longueurM: 50, profondeurM: 0.04 },
    });
    expect(deriveGeomFromTronconAbscisse).toHaveBeenCalledWith("defauts", "d1", "t1", 120);
  });

  it("rejette un champ d'identité que le client prétend fournir : l'auteur ne se déclare pas", async () => {
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", ...gps, constateParId: "quelquun-dautre",
      mesures: { longueurM: 50, profondeurM: 0.04 },
    });
    expect(r.status).toBe(400);
    expect(h.defautCree).toBeNull();
  });

  it("rejette une date de constat dans le futur", async () => {
    const r = await request(app).post("/api/v2/defauts").send({
      catalogueCode: "ORNIERAGE", ...gps,
      constateA: new Date(Date.now() + 86_400_000).toISOString(),
      mesures: { longueurM: 50, profondeurM: 0.04 },
    });
    expect(r.status).toBe(422);
  });
});

describe("POST /:id/decision — validation tierce", () => {
  it("valide le défaut d'un autre, écrit l'historique et audite VALIDATE", async () => {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });

    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(200);
    expect(r.body.statutValidation).toBe("VALIDE");
    // L'auteur dans la ligne d'historique vient de la LIGNE, jamais de la requête.
    expect(h.validations[0]).toMatchObject({
      entityType: "Defaut", entityId: "d1", statutApres: "VALIDE", auteurId: "agent-1",
    });
    expect(h.audits[0]).toMatchObject({ action: "VALIDATE", entityType: "Defaut" });
  });

  it("refuse à l'auteur de valider sa propre saisie", async () => {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "gestionnaire-1" });

    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("AUTO_VALIDATION");
  });

  it("refuse un rôle qui n'est pas validateur", async () => {
    h.compte.role = "INSPECTEUR";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });

    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("ROLE_INSUFFISANT");
  });

  it("exige le motif d'un rejet", async () => {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });

    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "REJETE" });
    expect(r.status).toBe(409);
    expect(r.body.motif).toBe("COMMENTAIRE_REQUIS");
  });

  it("ne revalide pas un défaut déjà validé : VALIDE ne revient pas en arrière", async () => {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "agent-1", statutValidation: "VALIDE" });

    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "REJETE", commentaire: "erreur de saisie" });
    expect(r.status).toBe(409);
    expect(r.body.motif).toBe("TRANSITION_INTERDITE");
  });

  it("renvoie en correction avec commentaire, et l'audite comme UPDATE", async () => {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });

    const r = await request(app).post("/api/v2/defauts/d1/decision").send({
      decision: "A_CORRIGER", commentaire: "La profondeur manque au relevé.",
    });
    expect(r.status).toBe(200);
    expect(r.body.statutValidation).toBe("A_CORRIGER");
    expect(h.validations[0]).toMatchObject({ statutApres: "A_CORRIGER", commentaire: "La profondeur manque au relevé." });
    expect(h.audits[0]).toMatchObject({ action: "UPDATE" });
  });
});

describe("POST /:id/decision — délégation de validation (§35)", () => {
  /**
   * CE QUE CE BLOC DEFEND
   *
   * Le §5 décrit le Coordonnateur comme faisant « validation selon délégation » ; le §35
   * dit ce qu'est une délégation : « un validateur est désigné pour chaque domaine ».
   * Avant, tout GESTIONNAIRE validait tout, partout.
   *
   * La règle est un RESSERREMENT PAR DOMAINE : tant que personne n'est désigné sur
   * `DEFAUT`, la règle d'avant s'applique. Dès qu'un seul l'est, le domaine lui est
   * réservé. Ces tests fixent les deux côtés, parce que c'est le genre de règle qu'une
   * refonte simplifierait dans un sens ou dans l'autre.
   */
  const delegation = (p: Record<string, unknown> = {}) => ({
    domaine: "DEFAUT",
    validateurId: "gestionnaire-1",
    regionId: null,
    debutLe: new Date("2026-01-01T00:00:00.000Z"),
    finLe: null,
    revoqueeLe: null,
    ...p,
  });

  function gestionnaire() {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });
  }

  it("laisse valider tant que PERSONNE n'est désigné sur le domaine", async () => {
    // Exiger une délégation dès le premier jour aurait arrêté la validation : les relevés
    // s'accumuleraient en attente et la chaîne de décision resterait vide.
    gestionnaire();
    h.delegations = [];
    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(200);
  });

  it("INSCRIT dans l'historique que l'autorité venait de l'absence de désignation", async () => {
    // « Personne n'est désigné » et « vous êtes désigné » autorisent la même action pour
    // des raisons opposées. Sans cette mention, on ne saura pas dans un an sur quoi une
    // validation reposait.
    gestionnaire();
    h.delegations = [];
    await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(h.validations[0]).toMatchObject({ source: "console:DOMAINE_NON_DESIGNE" });
  });

  it("RÉSERVE le domaine aux désignés dès qu'un seul l'est", async () => {
    gestionnaire();
    h.delegations = [delegation({ validateurId: "quelqu-un-d-autre" })];
    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("HORS_DELEGATION");
  });

  it("laisse passer le désigné, et le dit dans l'historique", async () => {
    gestionnaire();
    h.delegations = [delegation({ validateurId: "gestionnaire-1" })];
    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(200);
    expect(h.validations[0]).toMatchObject({ source: "console:DELEGATION_COUVRANTE" });
  });

  it("refuse une délégation EXPIRÉE, qui ne doit plus rien autoriser", async () => {
    // L'erreur la plus coûteuse : quelqu'un garderait un pouvoir qu'on croit lui avoir
    // retiré, et la ligne existant toujours, le journal donnerait le change.
    //
    // Ici la délégation expirée appartient à un autre : le domaine redevient donc non
    // désigné, et la règle d'avant s'applique.
    gestionnaire();
    h.delegations = [delegation({ validateurId: "autre", finLe: new Date("2026-06-30T00:00:00.000Z") })];
    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(200);
    expect(h.validations[0]).toMatchObject({ source: "console:DOMAINE_NON_DESIGNE" });
  });

  it("NOMME L'AUTO-VALIDATION avant la délégation", async () => {
    // Répondre « vous n'êtes pas désigné » à quelqu'un qui tente de valider son propre
    // relevé l'enverrait demander une délégation qui ne changerait rien : la séparation
    // des rôles n'est pas délégable.
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "gestionnaire-1" });
    h.delegations = [delegation({ validateurId: "autre" })];

    const r = await request(app).post("/api/v2/defauts/d1/decision").send({ decision: "VALIDE" });
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("AUTO_VALIDATION");
  });
});

describe("POST /:id/validate — le nom du contrat (§25) et /decision se tiennent ensemble", () => {
  /**
   * CE QUE CE BLOC DEFEND
   *
   * Le cahier nomme l'operation `/defects/{id}/validate` ; la route posee ici s'appelait
   * `/decision`. Les deux sont exposes et servis par la MEME fonction.
   *
   * Un alias n'est utile que s'il reste identique. Si quelqu'un recopiait un jour le
   * corps du gestionnaire pour « adapter » l'un des deux chemins, les deux divergeraient
   * en silence : chacun passerait ses propres tests pendant que l'un laisserait valider
   * ce que l'autre refuse. Ces tests parcourent donc les DEUX chemins sur les garanties
   * qui comptent, et echouent des que l'un s'ecarte.
   */
  const chemins = ["/api/v2/defauts/d1/decision", "/api/v2/defauts/d1/validate"];

  it("valide, ecrit l'historique et audite VALIDATE, par l'un comme par l'autre", async () => {
    for (const chemin of chemins) {
      h.validations.length = 0;
      h.audits.length = 0;
      h.compte.id = "gestionnaire-1";
      h.compte.role = "GESTIONNAIRE";
      h.defautExistant = defautEnBase({ constateParId: "agent-1" });

      const r = await request(app).post(chemin).send({ decision: "VALIDE" });
      expect(r.status, chemin).toBe(200);
      expect(r.body.statutValidation, chemin).toBe("VALIDE");
      // L'auteur de la ligne d'historique vient de la LIGNE, jamais de la requete, et
      // cela doit rester vrai quel que soit le chemin emprunte.
      expect(h.validations[0], chemin).toMatchObject({
        entityType: "Defaut", entityId: "d1", statutApres: "VALIDE", auteurId: "agent-1",
      });
      expect(h.audits[0], chemin).toMatchObject({ action: "VALIDATE", entityType: "Defaut" });
    }
  });

  it("refuse l'auto-validation par les deux chemins", async () => {
    // Le cas ou une divergence ferait le plus de degats : un alias plus permissif
    // contournerait toute la separation des roles sans qu'aucun test existant ne tombe.
    for (const chemin of chemins) {
      h.compte.id = "gestionnaire-1";
      h.compte.role = "GESTIONNAIRE";
      h.defautExistant = defautEnBase({ constateParId: "gestionnaire-1" });

      const r = await request(app).post(chemin).send({ decision: "VALIDE" });
      expect(r.status, chemin).toBe(403);
      expect(r.body.motif, chemin).toBe("AUTO_VALIDATION");
    }
  });

  it("refuse un role non validateur par les deux chemins, meme sur son propre releve", async () => {
    // L'inspecteur est ICI l'auteur, donc dans son perimetre : sans cela la requete
    // s'arreterait sur un 404 et ne dirait rien du role.
    //
    // Le motif attendu est ROLE_INSUFFISANT et non AUTO_VALIDATION, parce que le role
    // est verifie en premier. L'ordre est voulu : un inspecteur n'a pas a apprendre
    // qu'il aurait pu valider le releve de quelqu'un d'autre.
    for (const chemin of chemins) {
      h.compte.id = "agent-1";
      h.compte.role = "INSPECTEUR";
      h.defautExistant = defautEnBase({ constateParId: "agent-1" });

      const r = await request(app).post(chemin).send({ decision: "VALIDE" });
      expect(r.status, chemin).toBe(403);
      expect(r.body.motif, chemin).toBe("ROLE_INSUFFISANT");
    }
  });

  it("rend 404 hors perimetre par les deux chemins, sans reveler la ligne", async () => {
    // Un agent qui n'est ni l'auteur ni affecte a la mission ne doit pas APPRENDRE que
    // le defaut existe : 404 et non 403. Un alias qui sauterait le filtre de perimetre
    // transformerait cette route en moyen d'enumerer les identifiants.
    for (const chemin of chemins) {
      h.compte.id = "agent-2";
      h.compte.role = "INSPECTEUR";
      h.missions = [];
      h.defautExistant = defautEnBase({ constateParId: "agent-1" });

      const r = await request(app).post(chemin).send({ decision: "VALIDE" });
      expect(r.status, chemin).toBe(404);
      expect(r.body.motif, chemin).toBeUndefined();
    }
  });

  it("exige le commentaire d'un refus par les deux chemins", async () => {
    for (const chemin of chemins) {
      h.compte.id = "gestionnaire-1";
      h.compte.role = "GESTIONNAIRE";
      h.defautExistant = defautEnBase({ constateParId: "agent-1" });

      const r = await request(app).post(chemin).send({ decision: "REJETE" });
      expect(r.status, chemin).toBe(409);
      expect(r.body.motif, chemin).toBe("COMMENTAIRE_REQUIS");
    }
  });

  it("rejette un champ inconnu par les deux chemins", async () => {
    // Le schema est `.strict()` : un `auteurId` glissé dans le corps doit etre refuse,
    // pas ignore. Un alias laxiste rouvrirait precisement cette porte.
    for (const chemin of chemins) {
      h.compte.id = "gestionnaire-1";
      h.compte.role = "GESTIONNAIRE";
      h.defautExistant = defautEnBase({ constateParId: "agent-1" });

      const r = await request(app).post(chemin).send({ decision: "VALIDE", auteurId: "gestionnaire-1" });
      expect(r.status, chemin).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("POST /:id/resoumettre — retour de correction", () => {
  it("l'auteur resoumet avec la mesure qui manquait, et le métré se recalcule", async () => {
    h.compte.id = "agent-1";
    h.compte.role = "INSPECTEUR";
    h.defautExistant = defautEnBase({
      statutValidation: "A_CORRIGER",
      catalogue: h.catalogue.ORNIERAGE,
      longueurM: 50, profondeurM: null, gravite: 2,
    });

    const r = await request(app).post("/api/v2/defauts/d1/resoumettre").send({
      mesures: { profondeurM: 0.05 },
    });
    expect(r.status).toBe(200);
    expect(r.body.statutValidation).toBe("A_VALIDER");
    expect(r.body.profondeurM).toBe(0.05);
    expect(r.body.quantite).toBe(50);
    expect(h.validations[0]).toMatchObject({ statutAvant: "A_CORRIGER", statutApres: "A_VALIDER", source: "resoumission" });
  });

  it("refuse la resoumission d'un tiers non administrateur", async () => {
    h.compte.id = "curieux-1";
    h.compte.role = "INSPECTEUR";
    h.defautExistant = defautEnBase({ statutValidation: "A_CORRIGER", constateParId: "agent-1" });

    const r = await request(app).post("/api/v2/defauts/d1/resoumettre").send({});
    expect(r.status).toBe(403);
  });

  it("refuse la resoumission d'un défaut qui n'est pas en correction", async () => {
    h.compte.id = "agent-1";
    h.defautExistant = defautEnBase({ statutValidation: "A_VALIDER" });

    const r = await request(app).post("/api/v2/defauts/d1/resoumettre").send({});
    expect(r.status).toBe(409);
  });

  it("un administrateur peut resoumettre au nom de l'auteur", async () => {
    h.compte.id = "admin-1";
    h.compte.role = "ADMIN";
    h.defautExistant = defautEnBase({ statutValidation: "A_CORRIGER", constateParId: "agent-1", catalogue: h.catalogue.ORNIERAGE, longueurM: 50, gravite: 2 });

    const r = await request(app).post("/api/v2/defauts/d1/resoumettre").send({ mesures: { profondeurM: 0.05 } });
    expect(r.status).toBe(200);
  });
});

describe("POST /:id/etat — cycle de vie physique", () => {
  it("marque TRAITE en datant le traitement côté serveur", async () => {
    h.defautExistant = defautEnBase({ etat: "ACTIF" });
    const r = await request(app).post("/api/v2/defauts/d1/etat").send({ etat: "TRAITE" });
    expect(r.status).toBe(200);
    expect(r.body.etat).toBe("TRAITE");
    expect(r.body.traiteA).not.toBeNull();
    expect(h.defautExistant?.version).toBe(2);
  });

  it("un défaut traité qui redevient actif perd sa date de traitement", async () => {
    h.defautExistant = defautEnBase({ etat: "TRAITE", traiteA: new Date("2026-01-01") });
    const r = await request(app).post("/api/v2/defauts/d1/etat").send({ etat: "ACTIF" });
    expect(r.status).toBe(200);
    expect(r.body.traiteA).toBeNull();
  });

  it("un défaut traité ne disparaît pas : il a consommé un chantier", async () => {
    h.defautExistant = defautEnBase({ etat: "TRAITE" });
    const r = await request(app).post("/api/v2/defauts/d1/etat").send({ etat: "DISPARU" });
    expect(r.status).toBe(409);
  });

  it("refuse de modifier un défaut hors du périmètre auteur ou mission", async () => {
    h.defautExistant = defautEnBase({ constateParId: "agent-2", missionId: "mission-foreign" });
    const r = await request(app).post("/api/v2/defauts/d1/etat").send({ etat: "TRAITE" });
    expect(r.status).toBe(404);
    expect(h.defautExistant.etat).toBe("ACTIF");
  });

  it("refuse une transition si la version change avant l'écriture", async () => {
    h.defautExistant = defautEnBase({ etat: "ACTIF" });
    h.updateCount = 0;
    const r = await request(app).post("/api/v2/defauts/d1/etat").send({ etat: "TRAITE" });
    expect(r.status).toBe(409);
    expect(h.defautExistant.etat).toBe("ACTIF");
  });
});

describe("GET /api/v2/defauts — consultation", () => {
  it("rend le catalogue actif avec les mesures requises pour le formulaire terrain", async () => {
    const r = await request(app).get("/api/v2/defauts/catalogue");

    expect(r.status).toBe(200);
    expect(r.body.catalogue.map((c: { code: string }) => c.code)).toContain("NID_POULE");
    expect(r.body.catalogue[0]).toHaveProperty("mesuresRequises");
    expect(r.body.catalogue[0]).not.toHaveProperty("actif");
  });

  it("détail 404 quand le défaut n'existe pas", async () => {
    h.defautExistant = null;
    const r = await request(app).get("/api/v2/defauts/d1");
    expect(r.status).toBe(404);
  });

  it("une liste vide sur un code de catalogue inconnu, plutôt qu'une erreur", async () => {
    const r = await request(app).get("/api/v2/defauts?catalogueCode=INCONNU");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ defauts: [], curseurSuivant: null });
  });
});

describe("POST /:id/photos — plafond de stockage", () => {
  /**
   * CE QUE CE BLOC DEFEND
   *
   * Le middleware de televersement ne declarait qu'une limite : 8 Mio PAR FICHIER. Rien
   * ne bornait le nombre de photos par objet ni le total du repertoire.
   *
   * Le risque n'etait pas celui d'un inconnu — tout est derriere authentification. Il
   * etait plus banal : l'application de terrain synchronise SEULE, et une file locale qui
   * se rejoue en boucle televerse sans qu'aucun humain regarde. Le disque heberge aussi
   * PostgreSQL et le fond de carte public.
   *
   * Le dedoublonnage SHA-256 de cette route ne protegeait pas de cela : il arrete la MEME
   * photo renvoyee, pas mille photos differentes.
   */
  it("refuse au-dela du plafond par objet, en disant combien il y en a", async () => {
    h.compte.id = "agent-1";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });
    h.photosDuDefaut = 30;

    const r = await request(app)
      .post("/api/v2/defauts/d1/photos")
      .attach("photo", Buffer.from("x"), "photo.jpg");
    expect(r.status).toBe(409);
    expect(r.body.motif).toBe("PLAFOND_PAR_OBJET");
    // L'agent doit savoir ou il en est, sinon il reessaie sans comprendre.
    expect(r.body.dejaPresentes).toBe(30);
  });

  it("accepte juste en dessous du plafond", async () => {
    h.compte.id = "agent-1";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });
    h.photosDuDefaut = 29;

    const r = await request(app)
      .post("/api/v2/defauts/d1/photos")
      .attach("photo", Buffer.from("x"), "photo.jpg");
    expect(r.status).toBe(201);
  });

  it("REND 404 ET NON 409 au plafond, pour le defaut d'un autre agent", async () => {
    // Le cas qui justifie que le comptage reprenne la visibilite de la route. Repondre
    // « cet element porte deja trente photos » apprendrait a un inspecteur que le defaut
    // existe, ce que le 404 du gestionnaire existe precisement pour taire.
    h.compte.id = "agent-2";
    h.compte.role = "INSPECTEUR";
    h.missions = [];
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });
    h.photosDuDefaut = 30;

    const r = await request(app)
      .post("/api/v2/defauts/d1/photos")
      .attach("photo", Buffer.from("x"), "photo.jpg");
    expect(r.status).toBe(404);
    expect(r.body.motif).toBeUndefined();
  });

  it("laisse passer un gestionnaire sous le plafond sur le defaut d'un autre", async () => {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });
    h.photosDuDefaut = 2;

    const r = await request(app)
      .post("/api/v2/defauts/d1/photos")
      .attach("photo", Buffer.from("x"), "photo.jpg");
    expect(r.status).toBe(201);
  });
});

describe("POST /:id/appariement — confirmation humaine", () => {
  it("retourne une suggestion sans modifier le défaut", async () => {
    h.defautExistant = defautEnBase({ lat: 9.5, lon: -13.7, precisionM: 5 });
    const r = await request(app).post("/api/v2/defauts/d1/appariement/suggestion").send({});
    expect(r.status).toBe(200);
    expect(r.body.suggestion).toMatchObject({ tronconId: "t1", abscisseM: 120, confiance: 0.9 });
    expect(h.defautExistant?.tronconId).toBeNull();
  });

  it("recalcule le candidat côté serveur avant de le rattacher", async () => {
    h.defautExistant = defautEnBase({ lat: 9.5, lon: -13.7, precisionM: 5 });
    const r = await request(app).post("/api/v2/defauts/d1/appariement/confirmation").send({ tronconId: "t1" });
    expect(r.status).toBe(200);
    expect(r.body.defaut).toMatchObject({ tronconId: "t1", abscisseM: 120, pk: 4.2, confianceAppariement: 0.9 });
    expect(h.apparier).toHaveBeenCalled();
    expect(h.audits.at(-1)).toMatchObject({ action: "UPDATE", entityType: "Defaut", entityId: "d1" });
  });

  it("ne permet pas de confirmer un tronçon différent du candidat serveur", async () => {
    h.defautExistant = defautEnBase({ lat: 9.5, lon: -13.7, precisionM: 5 });
    const r = await request(app).post("/api/v2/defauts/d1/appariement/confirmation").send({ tronconId: "t-autre" });
    expect(r.status).toBe(409);
    expect(h.defautExistant?.tronconId).toBeNull();
  });
});

describe("POST /:id/photos — preuve photo", () => {
  it("stocke l'empreinte et les métadonnées GPS avec la photo", async () => {
    h.defautExistant = defautEnBase({ constateParId: "agent-1" });
    const r = await request(app).post("/api/v2/defauts/d1/photos").send({ lat: 9.5, lon: -13.7, precisionM: 5, capturedA: "2026-10-08T09:30:00.000Z" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ defautId: "d1", type: "PHOTO", mimeType: "image/jpeg", lat: 9.5, lon: -13.7, precisionM: 5 });
    expect(r.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(h.audits.at(-1)).toMatchObject({ action: "CREATE", entityType: "MediaDefaut" });
  });

  it("refuse la photo d'un défaut appartenant à un autre agent", async () => {
    h.defautExistant = defautEnBase({ constateParId: "agent-2" });
    const r = await request(app).post("/api/v2/defauts/d1/photos").send({});
    expect(r.status).toBe(404);
    const fs = await import("node:fs/promises");
    expect(fs.unlink).toHaveBeenCalledWith("uploads/photos/photo-test.jpg");
  });
});

describe("catalogue administrable", () => {
  it("refuse l'écriture au rôle terrain", async () => {
    const r = await request(app).post("/api/v2/defauts/catalogue").send({});
    expect(r.status).toBe(403);
  });

  it("autorise le gestionnaire à créer une entrée et en garde la source", async () => {
    h.compte.id = "gestionnaire-1";
    h.compte.role = "GESTIONNAIRE";
    const r = await request(app).post("/api/v2/defauts/catalogue").send({
      code: "FAIENCAGE_TEST", libelle: "Faïençage test", famille: "CHAUSSEE", unite: "METRE_CARRE",
      mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, description: null,
      source: "Référentiel local à valider", actif: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.version).toBe(1);
    expect(h.audits.at(-1)).toMatchObject({ action: "CREATE", entityType: "CatalogueDefaut" });
  });
});
