import { z } from "zod";

export const documentCreateSchema = z.object({
  titre: z.string().min(1, "Le titre est requis"),
  type: z.enum(["ARRETE", "CAHIER_CHARGES", "CAHIER_ENGAGEMENT", "AUTRE"]),
  annee: z.coerce.number().int().min(1900).max(2100).optional(),
  tronconId: z.string().min(1).optional(),
});

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;
