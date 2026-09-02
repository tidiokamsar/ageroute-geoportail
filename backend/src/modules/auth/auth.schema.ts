import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Adresse e-mail invalide"),
  password: z.string().min(1, "Mot de passe requis"),
});

// P3-B : refreshToken optionnel — le nouveau transport le porte par cookie
// HttpOnly ; le body reste accepte pour les anciens clients (transition
// documentee : au premier refresh body, la session migre en cookie).
export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const twoFaLoginVerifySchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().length(6, "Le code doit contenir 6 chiffres"),
});

export const twoFaConfirmSchema = z.object({
  code: z.string().length(6, "Le code doit contenir 6 chiffres"),
});

export const twoFaDisableSchema = z.object({
  password: z.string().min(1, "Mot de passe requis"),
});

// Politique de mot de passe : 10 caractères min, au moins 1 majuscule, 1 minuscule, 1 chiffre.
export const passwordPolicy = z
  .string()
  .min(10, "Le mot de passe doit contenir au moins 10 caractères")
  .regex(/[a-z]/, "Le mot de passe doit contenir au moins une minuscule")
  .regex(/[A-Z]/, "Le mot de passe doit contenir au moins une majuscule")
  .regex(/[0-9]/, "Le mot de passe doit contenir au moins un chiffre");

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
