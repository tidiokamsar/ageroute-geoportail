import { z } from "zod";

const champsObservation = z.object({
  type: z.enum([
    "DEGRADATION", "CHAUSSEE", "ASSAINISSEMENT", "SIGNALISATION", "OUVRAGE",
    "SECURITE", "TRAFIC", "ENVIRONNEMENT", "CHANTIER", "INCIDENT", "AUTRE",
  ]).optional(),
  gravite: z.enum(["FAIBLE", "MOYENNE", "FORTE"]).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  missionId: z.string().uuid().nullable().optional(),
  tronconId: z.string().min(1).max(128).nullable().optional(),
  ouvrageId: z.string().min(1).max(128).nullable().optional(),
  chantierId: z.string().min(1).max(128).nullable().optional(),
  pk: z.number().finite().nonnegative().nullable().optional(),
  lat: z.number().finite().min(-90).max(90).nullable().optional(),
  lon: z.number().finite().min(-180).max(180).nullable().optional(),
  precisionM: z.number().finite().nonnegative().max(100_000).nullable().optional(),
  observeA: z.string().datetime().optional(),
}).strict();

const creationObservation = champsObservation.extend({
  type: z.enum([
    "DEGRADATION", "CHAUSSEE", "ASSAINISSEMENT", "SIGNALISATION", "OUVRAGE",
    "SECURITE", "TRAFIC", "ENVIRONNEMENT", "CHANTIER", "INCIDENT", "AUTRE",
  ]),
  observeA: z.string().datetime(),
});

export type OperationObservationSync = "CREATE" | "UPDATE" | "DELETE";

/** Les champs système (auteur, statut, validation, version et suppression) restent côté serveur. */
export function preparerPayloadObservationSync(
  operation: OperationObservationSync,
  payload: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false } {
  if (operation === "DELETE") return { ok: true, payload: {} };

  const schema = operation === "CREATE"
    ? creationObservation
    : champsObservation.refine((value) => Object.keys(value).length > 0);
  const resultat = schema.safeParse(payload);
  return resultat.success
    ? { ok: true, payload: resultat.data }
    : { ok: false };
}
