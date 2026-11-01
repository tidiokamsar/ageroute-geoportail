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
  // Tableau VIDE = aucun module accessible, et non « aucune restriction » : le sens du
  // vide a ete inverse le 05/09/2026 (voir lib/access.ts). Seul un ADMIN y echappe.
  modulesAutorises: z.array(z.enum(MODULE_KEYS)).optional(),
  // Droit de designer un validateur (paragraphe 35). Modifiable par un ADMIN,
  // et pose par le profil Direction Technique.
  peutDeleguerValidation: z.boolean().optional(),
});

export const userResetPasswordSchema = z.object({
  password: passwordPolicy,
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
