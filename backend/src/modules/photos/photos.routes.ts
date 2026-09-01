import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { photoAbsolutePath } from "../../lib/photos";

export const photosRouter = Router();
photosRouter.use(requireAuth);
photosRouter.get("/:filename", (req, res) => {
  res.sendFile(photoAbsolutePath(req.params.filename));
});
