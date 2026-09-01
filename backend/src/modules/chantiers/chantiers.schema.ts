import { z } from "zod";

export const chantierCreateSchema = z.object({
  intitule: z.string().min(1),
  entreprise: z.string().min(1),
  bailleur: z.string().optional(),
  regionId: z.number().int().positive().optional(),
  tronconId: z.string().uuid().optional(),
  pkDebut: z.number().nonnegative().optional(),
  pkFin: z.number().nonnegative().optional(),
  statut: z.enum(["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE"]).optional(),
  avancementPct: z.number().int().min(0).max(100).optional(),
  dateDebutPrevue: z.coerce.date().optional(),
  dateFinPrevue: z.coerce.date().optional(),
  dateDebutReelle: z.coerce.date().optional(),
  dateFinReelle: z.coerce.date().optional(),
  montantGnf: z.number().nonnegative().optional().transform((v) => (v === undefined ? undefined : BigInt(v))),
  numContrat: z.string().optional(),
  observations: z.string().optional(),
});

export const chantierUpdateSchema = chantierCreateSchema.partial();
export type ChantierCreateInput = z.infer<typeof chantierCreateSchema>;
export type ChantierUpdateInput = z.infer<typeof chantierUpdateSchema>;
