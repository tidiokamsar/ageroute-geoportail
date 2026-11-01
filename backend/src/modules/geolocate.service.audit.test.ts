import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Les trois services (ouvrages, postes, points noirs) transmettent l'utilisateur a
 * l'audit de la geolocalisation. Avant, `geolocateFromTroncon(id)` n'avait meme pas
 * l'identifiant de l'auteur : l'ecriture de geometrie ne pouvait pas etre attribuee.
 *
 * Le comportement de `deriveGeomFromTroncon` lui-meme est verifie par `lib/geo.audit.test.ts`.
 */

const h = vi.hoisted(() => ({ derive: vi.fn(async () => true) }));

vi.mock("../lib/prisma", () => ({
  prisma: { ouvrage: {}, poste: {}, pointNoir: {} },
}));
vi.mock("../lib/crud-factory", () => ({
  createCrudService: vi.fn(() => ({
    getById: vi.fn(async () => ({ id: "a1", tronconId: "t1", pk: 4.2 })),
  })),
}));
vi.mock("../lib/photos", () => ({ createPhotoService: vi.fn(() => ({})) }));
vi.mock("../lib/excel", () => ({
  buildExportBuffer: vi.fn(), parseImportBuffer: vi.fn(), formatImportError: vi.fn(),
}));
vi.mock("../lib/regions", () => ({ resolveRegionId: vi.fn() }));
vi.mock("../lib/geo", () => ({
  setPointGeom: vi.fn(),
  getPointLatLon: vi.fn(async () => ({ lat: 9.5, lon: -13.7 })),
  deriveGeomFromTroncon: h.derive,
}));

import { ouvragesService } from "./ouvrages/ouvrages.service";
import { postesService } from "./postes/postes.service";
import { pointsNoirsService } from "./points-noirs/points-noirs.service";

beforeEach(() => h.derive.mockClear());

describe.each([
  ["ouvrages", "Ouvrage", (u: string, ip?: string) => ouvragesService.geolocateFromTroncon("a1", u, ip)],
  ["postes", "Poste", (u: string, ip?: string) => postesService.geolocateFromTroncon("a1", u, ip)],
  ["points_noirs", "PointNoir", (u: string, ip?: string) => pointsNoirsService.geolocateFromTroncon("a1", u, ip)],
])("geolocateFromTroncon (%s)", (table, entityType, appeler) => {
  it("transmet l'auteur, l'adresse et le type d'entite a l'audit", async () => {
    await appeler("u7", "10.1.1.1");
    expect(h.derive).toHaveBeenCalledWith(table, "a1", "t1", 4.2, {
      userId: "u7", entityType, ipAddress: "10.1.1.1",
    });
  });
});
