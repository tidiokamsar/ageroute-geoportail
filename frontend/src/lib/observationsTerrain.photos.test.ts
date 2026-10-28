import { describe, expect, it } from "vitest";
import { PHOTO_TAILLE_MAX_OCTETS, construireObservation, motifRefusPhoto } from "./observationsTerrain";

/**
 * Photos d'une observation, côté saisie. Ce que ces tests défendent :
 *   - une photo valide est gardée AVEC l'observation mais jamais dans le payload (le schéma serveur est strict) ;
 *   - ce que le serveur refuserait (format, 8 Mo, vide, plus de cinq, position non appariée) est refusé tout de suite, sur le terrain.
 */
const MAINTENANT = new Date("2026-10-25T09:00:00.000Z");
const jpeg = (octets = 10, name = "p.jpg") => ({ name, blob: new Blob([new Uint8Array(octets)], { type: "image/jpeg" }), capturedA: "2026-10-25T09:00:00.000Z", lat: 9.64, lon: -13.6, precisionM: 6 });

describe("photos d'une observation", () => {
  it("gardées avec l'observation, hors du payload", () => {
    const r = construireObservation({ type: "DEGRADATION", lat: 9.64, lon: -13.6, photos: [jpeg(), jpeg(20, "q.jpg")] }, { userId: "u1", maintenant: MAINTENANT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.observation.photos).toHaveLength(2);
    expect(Object.keys(r.observation.payload)).not.toContain("photos");
    expect(r.observation.photos?.[0]).toMatchObject({ name: "p.jpg", lat: 9.64, lon: -13.6, precisionM: 6 });
  });

  it("sans photo : aucun champ photos", () => {
    const r = construireObservation({ type: "DEGRADATION", lat: 9.64, lon: -13.6 }, { userId: "u1", maintenant: MAINTENANT });
    expect(r.ok && "photos" in r.observation).toBe(false);
  });

  it("refus nommés : format, taille, fichier vide, plus de cinq, position non appariée", () => {
    const base = { type: "DEGRADATION", lat: 9.64, lon: -13.6 };
    const refus = (photos: ReturnType<typeof jpeg>[]) => {
      const r = construireObservation({ ...base, photos }, { userId: "u1", maintenant: MAINTENANT });
      return r.ok ? [] : r.erreurs.join(" | ");
    };
    expect(refus([{ ...jpeg(), name: "x.gif", blob: new Blob(["x"], { type: "image/gif" }) }])).toMatch(/seuls les formats JPG, PNG et WebP/);
    expect(refus([{ ...jpeg(), blob: { type: "image/jpeg", size: PHOTO_TAILLE_MAX_OCTETS + 1 } as Blob }])).toMatch(/taille maximale est de 8 Mo/);
    expect(refus([jpeg(0)])).toMatch(/le fichier est vide/);
    expect(refus(Array.from({ length: 6 }, () => jpeg()))).toMatch(/Cinq photos au maximum/);
    const { lon: _lon, ...sansLon } = jpeg();
    expect(refus([sansLon as ReturnType<typeof jpeg>])).toMatch(/va par paire/);
  });

  it("exactement 8 Mo et exactement cinq photos passent", () => {
    expect(motifRefusPhoto({ name: "p.jpg", blob: { type: "image/jpeg", size: PHOTO_TAILLE_MAX_OCTETS } as Blob })).toBeNull();
    const r = construireObservation({ type: "DEGRADATION", lat: 9.64, lon: -13.6, photos: Array.from({ length: 5 }, () => jpeg()) }, { userId: "u1", maintenant: MAINTENANT });
    expect(r.ok).toBe(true);
  });
});
