import { z } from "zod";
import { passwordPolicy } from "../auth/auth.schema";
import { MODULE_KEYS } from "../../lib/modules";

export const userCreateSchema = z.object({
  email: z.string().email(),
  nomComplet: z.string().min(2),
  password: passwordPolicy,
  role: z.enum(["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "LECTEUR"]),
});

export const userUpdateSchema = z.object({
  nomComplet: z.string().min(2).optional(),
  role: z.enum(["ADMIN", "GESTIONNAIRE", "INSPECTEUR", "LECTEUR"]).optional(),
  actif: z.boolean().optional(),
  // Tableau vide = aucune restriction (accès à tous les modules autorisés par le rôle).
  modulesAutorises: z.array(z.enum(MODULE_KEYS)).optional(),
});

export const userResetPasswordSchema = z.object({
  password: passwordPolicy,
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
