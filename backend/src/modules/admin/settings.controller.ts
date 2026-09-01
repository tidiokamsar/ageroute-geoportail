import type { Request, Response, NextFunction } from "express";
import { getSmtpConfigForApi, setSmtpConfig } from "./settings.service";
import { smtpConfigSchema, smtpTestSchema } from "./settings.schema";
import { sendTestMail } from "../../lib/mailer";
import { ApiError } from "../../middleware/error.middleware";

export async function getSmtpHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await getSmtpConfigForApi()); } catch (err) { next(err); }
}

export async function putSmtpHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    res.json(await setSmtpConfig(smtpConfigSchema.parse(req.body), req.user.id));
  } catch (err) { next(err); }
}

export async function testSmtpHandler(req: Request, res: Response, next: NextFunction) {
  let to: string;
  try {
    to = smtpTestSchema.parse(req.body).to;
  } catch (err) {
    return next(err); // erreur de validation Zod -> gérée par errorHandler (400)
  }

  try {
    await sendTestMail(to);
    res.status(204).send();
  } catch (err) {
    next(new ApiError(502, `Échec de l'envoi : ${err instanceof Error ? err.message : "erreur inconnue"}`));
  }
}
