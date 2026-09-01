import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth.middleware";

export const regionsRouter = Router();

regionsRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    const regions = await prisma.region.findMany({ orderBy: { nom: "asc" } });
    res.json(regions);
  } catch (err) {
    next(err);
  }
});
