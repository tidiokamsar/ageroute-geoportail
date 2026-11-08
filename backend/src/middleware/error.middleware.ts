import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { MulterError } from "multer";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// A placer en tout dernier middleware (4 arguments => Express le reconnait comme error handler)
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation invalide", details: err.flatten() });
    return;
  }
  if (err instanceof MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof Error && err.message === "Format de fichier non supporté (xlsx/xls attendu)") {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Une entree avec cette valeur unique existe deja" });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: "Ressource introuvable" });
      return;
    }
  }
  // P2-02 : une requete mal formee (colonne de tri inexistante, filtre invalide...)
  // est une erreur CLIENT, pas un crash serveur. Avant : 500 générique.
  if (err instanceof Prisma.PrismaClientValidationError) {
    res.status(400).json({ error: "Paramètre de requête invalide" });
    return;
  }
  // Erreurs du lecteur de corps (body-parser / http-errors) : JSON mal forme (entity.parse.failed),
  // corps trop gros (entity.too.large), encodage non supporte... Elles portent un statut 4xx et
  // `expose: true`. Avant : 500 sans code. Le message d'origine n'est jamais renvoye tel quel.
  const http = err as { status?: unknown; type?: unknown; expose?: unknown };
  if (typeof http.status === "number" && http.status >= 400 && http.status < 500 && http.expose === true) {
    if (http.type === "entity.too.large") {
      res.status(413).json({ error: "Corps de requete trop volumineux", code: "CORPS_TROP_GROS" });
      return;
    }
    if (http.type === "entity.parse.failed") {
      res.status(400).json({ error: "Corps de requete illisible (JSON invalide)", code: "JSON_INVALIDE" });
      return;
    }
    res.status(http.status).json({ error: "Requete invalide", code: "REQUETE_INVALIDE" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Route introuvable" });
}
