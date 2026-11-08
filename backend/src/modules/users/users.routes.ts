import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/rbac.middleware";
import { listHandler, getHandler, createHandler, updateHandler, resetPasswordHandler, listProfilsHandler, appliquerProfilHandler } from "./users.controller";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole("ADMIN"));
usersRouter.get("/", listHandler);
// AVANT `/:id`, et ce n'est pas un detail : poser `/profils` apres ferait matcher
// `/:id` sur la chaine « profils », et la route rendrait un 404 d'utilisateur
// introuvable au lieu de la liste. Le depot connait ce piege — un test de troncons
// verifie deja que `/geo` n'est pas confondu avec un identifiant.
usersRouter.get("/profils", listProfilsHandler);
usersRouter.get("/:id", getHandler);
usersRouter.post("/", createHandler);
usersRouter.put("/:id", updateHandler);
usersRouter.post("/:id/reset-password", resetPasswordHandler);
usersRouter.post("/:id/profil", appliquerProfilHandler);
