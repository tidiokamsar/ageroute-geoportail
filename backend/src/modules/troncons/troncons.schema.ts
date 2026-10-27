import { z } from "zod";

const geomSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(z.array(z.number()).min(2)),
}).optional();

export const tronconCreateSchema = z.object({
  code: z.string().min(1, "Code requis"),
  nom: z.string().min(1, "Nom requis"),
  // NON_CLASSEE et NON_RENSEIGNE existent en base (enums Prisma) : les refuser ici empechait de modifier un
  // troncon qui les porte, sans rien imposer de plus juste. L'absence se dit, elle ne s'invente pas.
  classe: z.enum(["RN", "RR", "RU", "PISTE", "NON_CLASSEE"]),
  regionId: z.number().int().positive(),
  longueurKm: z.number().positive(),
  revetement: z.enum(["BITUME", "TERRE", "LATERITE", "PAVE", "NON_RENSEIGNE"]),
  etat: z.enum(["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"]).optional(),
  pkDebut: z.number().nonnegative(),
  pkFin: z.number().nonnegative(),
  traficMoyenJma: z.number().int().nonnegative().optional(),
  prefecture: z.string().optional(),
  commune: z.string().optional(),
  observations: z.string().optional(),
  geom: geomSchema,
});

export const tronconUpdateSchema = tronconCreateSchema.partial();

export const tronconGeomSchema = z.object({
  geom: z.object({
    type: z.literal("LineString"),
    coordinates: z.array(z.array(z.number()).min(2)),
  }),
});

export type TronconCreateInput = z.infer<typeof tronconCreateSchema>;
export type TronconUpdateInput = z.infer<typeof tronconUpdateSchema>;
