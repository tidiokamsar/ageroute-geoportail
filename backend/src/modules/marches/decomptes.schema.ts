import { z } from "zod";

export const decompteCreateSchema = z.object({
  numero: z.number().int().positive(),
  type: z.enum(["AVANCE", "DECOMPTE", "RETENUE_GARANTIE", "SOLDE"]).default("DECOMPTE"),
  montantGnf: z.number().nonnegative(),
  dateEmission: z.coerce.date().optional(),
  datePaiement: z.coerce.date().optional(),
  statut: z.enum(["EMIS", "PAYE", "REJETE"]).default("EMIS"),
  observations: z.string().optional(),
});

export const decompteUpdateSchema = decompteCreateSchema.partial();

export type DecompteCreateInput = z.infer<typeof decompteCreateSchema>;
export type DecompteUpdateInput = z.infer<typeof decompteUpdateSchema>;
