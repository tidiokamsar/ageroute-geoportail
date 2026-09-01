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
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Route introuvable" });
}
