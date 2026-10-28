import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import {
  listDelegationsHandler, creerDelegationHandler, revoquerDelegationHandler,
  domainesValidationHandler, validateursPossiblesHandler,
} from "./delegations.controller";

/**
 * Designation des validateurs (paragraphe 35 du cahier).
 *
 * POURQUOI UN ROUTEUR A PART, ET PAS LE ROUTEUR D'ADMINISTRATION
 *
 * `adminSettingsRouter` pose `requireRole("ADMIN")` sur tout ce qu'il porte. Ces routes ne
 * peuvent pas en faire partie : AGEROUTE a confie la designation a la DIRECTION
 * TECHNIQUE, qui n'est pas administrateur de la plateforme. Les y placer reviendrait a
 * refuser la decision qu'on vient de prendre.
 *
 * Le droit est donc porte par `users.peutDeleguerValidation`, et les gestionnaires le
 * verifient eux-memes — avec l'auto-designation, le role du designe et la coherence de la
 * periode, qui ne sont pas des questions de role.
 */
export const gouvernanceRouter = Router();
gouvernanceRouter.use(requireAuth);

gouvernanceRouter.get("/delegations", listDelegationsHandler);
gouvernanceRouter.post("/delegations", creerDelegationHandler);
gouvernanceRouter.post("/delegations/:id/revocation", revoquerDelegationHandler);

// Avant `/delegations/:id` : l'ordre compte, comme toujours.
gouvernanceRouter.get("/domaines", domainesValidationHandler);
gouvernanceRouter.get("/validateurs-possibles", validateursPossiblesHandler);
