import { z } from "zod";

export const smtpConfigSchema = z.object({
  host: z.string().min(1, "Hôte requis"),
  port: z.number().int().positive().default(587),
  secure: z.boolean().default(false),
  user: z.string().optional(),
  // Optionnel : si omis, le mot de passe déjà enregistré est conservé (permet de modifier
  // host/port/user sans ressaisir le mot de passe à chaque fois).
  password: z.string().optional(),
  from: z.string().min(1, "Adresse d'expédition requise"),
});

export const smtpTestSchema = z.object({
  to: z.string().email("Adresse e-mail invalide"),
});

export type SmtpConfigInput = z.infer<typeof smtpConfigSchema>;
