import { z } from "zod";

export const pointNoirCreateSchema = z.object({
  description: z.string().min(1),
  regionId: z.number().int().positive(),
  tronconId: z.string().uuid().optional(),
  pk: z.number().nonnegative().optional(),
  gravite: z.enum(["FAIBLE", "MOYENNE", "FORTE"]),
  nbAccidents: z.number().int().nonnegative().default(0),
  causes: z.string().optional(),
  mesuresCorrectives: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

export const pointNoirUpdateSchema = pointNoirCreateSchema.partial();
export type PointNoirCreateInput = z.infer<typeof pointNoirCreateSchema>;
export type PointNoirUpdateInput = z.infer<typeof pointNoirUpdateSchema>;
