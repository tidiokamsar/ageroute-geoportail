import { z } from "zod";

export const posteCreateSchema = z.object({
  nom: z.string().min(1),
  type: z.enum(["PEAGE", "PESAGE"]),
  regionId: z.number().int().positive(),
  tronconId: z.string().uuid().optional(),
  pk: z.number().nonnegative().optional(),
  statut: z.enum(["EN_SERVICE", "HORS_SERVICE", "EN_CONSTRUCTION"]).optional(),
  traficJma: z.number().int().nonnegative().optional(),
  recettesMensuellesGnf: z.number().nonnegative().optional().transform((v) => (v === undefined ? undefined : BigInt(v))),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

export const posteUpdateSchema = posteCreateSchema.partial();
export type PosteCreateInput = z.infer<typeof posteCreateSchema>;
export type PosteUpdateInput = z.infer<typeof posteUpdateSchema>;
