import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { listHandler, getHandler, createHandler, updateHandler, resetPasswordHandler } from "./users.controller";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole("ADMIN"));
usersRouter.get("/", listHandler);
usersRouter.get("/:id", getHandler);
usersRouter.post("/", createHandler);
usersRouter.put("/:id", updateHandler);
usersRouter.post("/:id/reset-password", resetPasswordHandler);
