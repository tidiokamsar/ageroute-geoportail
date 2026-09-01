import { z } from "zod";

export const ouvrageCreateSchema = z.object({
  nom: z.string().min(1),
  type: z.enum(["PONT", "DALOT", "BUSE", "RADIER", "PONCEAU", "MUR_SOUTENEMENT", "TUNNEL", "PASSERELLE", "VIADUC"]),
  etat: z.enum(["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"]).optional(),
  regionId: z.number().int().positive(),
  tronconId: z.string().uuid().optional(),
  pk: z.number().nonnegative().optional(),
  longueurM: z.number().positive().optional(),
  gabaritT: z.number().positive().optional(),
  anneeConstruction: z.number().int().min(1900).max(2100).optional(),
  materiau: z.string().optional(),
  derniereInspectionDate: z.coerce.date().optional(),
  ficheNumero: z.string().optional(),
  code: z.string().optional(),
  largeurM: z.number().positive().optional(),
  hauteurM: z.number().positive().optional(),
  nbTravees: z.number().int().nonnegative().optional(),
  longueurTravee: z.number().positive().optional(),
  materiauAppuis: z.string().optional(),
  materiauTablier: z.string().optional(),
  materiauPiles: z.string().optional(),
  materiauAutre: z.string().optional(),
  remarques: z.string().optional(),
  travauxAPrevoir: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  photos: z.array(z.string()).optional(),
});

export const ouvrageUpdateSchema = ouvrageCreateSchema.partial();
export type OuvrageCreateInput = z.infer<typeof ouvrageCreateSchema>;
export type OuvrageUpdateInput = z.infer<typeof ouvrageUpdateSchema>;
