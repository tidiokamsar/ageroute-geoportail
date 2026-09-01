import { z } from "zod";

export const marcheCreateSchema = z.object({
  intitule: z.string().min(1),
  bailleurId: z.number().int().positive().optional(),
  montantTotal: z.number().nonnegative().optional(),
  devise: z.enum(["GNF", "USD", "EUR"]).default("GNF"),
  dateSignature: z.coerce.date().optional(),
  dateDebutPrevue: z.coerce.date().optional(),
  dateFinPrevue: z.coerce.date().optional(),
  dateReceptionProvisoire: z.coerce.date().optional(),
  garantieBonneExecutionExp: z.coerce.date().optional(),
  tauxPenaliteRetardPct: z.number().min(0).max(100).optional(),
  statut: z.enum(["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE", "SOLDE"]).default("PLANIFIE"),
});

export const marcheUpdateSchema = marcheCreateSchema.partial();

export const bailleurCreateSchema = z.object({
  nom: z.string().min(1),
  type: z.enum(["etat", "multilateral", "bilateral", "autre"]).default("autre"),
});

export const attachChantierSchema = z.object({
  chantierId: z.string().min(1),
  tronconId: z.string().min(1).optional(),
});

export const avancementSchema = z.object({
  periode: z.coerce.date(),
  avancementPhysiquePrevu: z.number().min(0).max(100).default(0),
  avancementPhysiqueReel: z.number().min(0).max(100).default(0),
  avancementFinancierPrevu: z.number().min(0).max(100).default(0),
  avancementFinancierReel: z.number().min(0).max(100).default(0),
});

export type MarcheCreateInput = z.infer<typeof marcheCreateSchema>;
export type MarcheUpdateInput = z.infer<typeof marcheUpdateSchema>;
export type AvancementInput = z.infer<typeof avancementSchema>;
