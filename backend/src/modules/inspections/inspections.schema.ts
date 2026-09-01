import { z } from "zod";

export const inspectionCreateSchema = z.object({
  tronconId: z.string().uuid().optional(),
  ouvrageId: z.string().uuid().optional(),
  dateInspection: z.coerce.date(),
  etatObserve: z.enum(["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"]),
  defautsConstates: z.string().optional(),
  recommandations: z.string().optional(),
  photos: z.array(z.string()).optional(),
  // Position relevee sur le terrain. Bornes verifiees : une coordonnee hors domaine
  // est un defaut de saisie ou de capteur, et vaut mieux etre refusee que stockee —
  // une position fausse est plus couteuse qu'une position absente.
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  // Incertitude annoncee par l'appareil, en metres. Negative n'a pas de sens.
  precisionM: z.number().nonnegative().optional(),
});

export const inspectionUpdateSchema = inspectionCreateSchema.partial();
export type InspectionCreateInput = z.infer<typeof inspectionCreateSchema>;
export type InspectionUpdateInput = z.infer<typeof inspectionUpdateSchema>;
