import { z } from "zod";

export const TYPES_INTERVENTION = [
  "REPARATION_CHAUSSEE", "CURAGE_ASSAINISSEMENT", "SIGNALISATION",
  "DEBROUSSAILLAGE", "OUVRAGE_ART_MINEUR", "URGENCE_SECURITE", "AUTRE",
] as const;

export const PRIORITES = ["URGENTE", "HAUTE", "NORMALE", "BASSE"] as const;
export const STATUTS_OT = ["BROUILLON", "ASSIGNE", "EN_COURS", "SUSPENDU", "TERMINE", "ANNULE", "CONVERTI_CHANTIER"] as const;

export const otCreateSchema = z.object({
  titre: z.string().min(3),
  description: z.string().optional(),
  typeIntervention: z.enum(TYPES_INTERVENTION),
  priorite: z.enum(PRIORITES).default("NORMALE"),
  regionId: z.number().int().positive().optional(),
  tronconId: z.string().uuid().optional(),
  ouvrageId: z.string().uuid().optional(),
  pointNoirId: z.string().uuid().optional(),
  pkLocalisation: z.number().nonnegative().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  coutEstimeGnf: z.number().nonnegative().optional(),
  entreprise: z.string().optional(),
  dateEcheance: z.coerce.date().optional(),
});

export const otUpdateSchema = otCreateSchema.partial().extend({
  coutReelGnf: z.number().nonnegative().optional(),
});

export const otChangeStatutSchema = z.object({
  statut: z.enum(STATUTS_OT),
  commentaire: z.string().optional(),
});

export const otAssignSchema = z.object({
  assigneAId: z.string().uuid(),
  priorite: z.enum(PRIORITES).optional(),
  dateEcheance: z.coerce.date().optional(),
});

export type OtCreateInput = z.infer<typeof otCreateSchema>;
