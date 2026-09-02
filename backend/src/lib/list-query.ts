import type { Request } from "express";
import { z } from "zod";

// z.coerce.boolean() utilise Boolean(value) : la chaine "false" devient `true` (chaine non
// vide), donc inutilisable pour des query params texte. On compare explicitement a "true".
const queryBoolean = z
  .union([z.literal("true"), z.literal("false")])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true"));

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
  // P2-02 : sortBy part directement dans orderBy — identifier seul, sinon ZodError -> 400.
  // (Colonne inexistante mais bien formée : voir PrismaClientValidationError -> 400
  // dans error.middleware — ceinture et bretelles.)
  sortBy: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/, "Colonne de tri invalide").optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  search: z.string().optional(),
  region: z.string().optional(),
  etat: z.string().optional(),
  type: z.string().optional(),
  role: z.string().optional(),
  actif: queryBoolean,
  archived: queryBoolean,
});

export function parseListQuery(req: Request) {
  return listQuerySchema.parse(req.query);
}
