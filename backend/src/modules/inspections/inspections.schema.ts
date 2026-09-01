import { z } from "zod";

export const inspectionCreateSchema = z.object({
  tronconId: z.string().uuid().optional(),
  ouvrageId: z.string().uuid().optional(),
  dateInspection: z.coerce.date(),
  etatObserve: z.enum(["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"]),
  defautsConstates: z.string().optional(),
  recommandations: z.string().optional(),
  photos: z.array(z.string()).optional(),
});

export const inspectionUpdateSchema = inspectionCreateSchema.partial();
export type InspectionCreateInput = z.infer<typeof inspectionCreateSchema>;
export type InspectionUpdateInput = z.infer<typeof inspectionUpdateSchema>;
