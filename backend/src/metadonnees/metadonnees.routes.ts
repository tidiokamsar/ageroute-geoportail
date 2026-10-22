import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../lib/prisma";
import { lister, xmlDe, type DepotMetadonnees, type OptionsPublication } from "./metadonnees.service";

/**
 * Metadonnees ISO 19115 des jeux publics. Monte sous /api/public : aucune authentification, donc
 * derriere la limitation de debit du routeur public, et le contenu est exclusivement la
 * description de jeux DEJA publies (voir catalogue.referentiel.ts).
 */

export function creerRouteurMetadonnees(
  depot: DepotMetadonnees = prisma as unknown as DepotMetadonnees,
  options: () => OptionsPublication = optionsDepuisEnv,
): Router {
  const r = Router();

  r.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const jeux = await lister(depot, options());
      res.set("Cache-Control", "public, max-age=300");
      res.json({
        norme: "ISO 19115:2003/Cor 1:2006, encodage XML ISO 19139:2007",
        // Le document n'est PAS valide contre les schemas XSD : voir iso19115.noyau.ts.
        validationXsd: "non verifiee",
        jeux,
      });
    } catch (err) { next(err); }
  });

  r.get("/:id.xml", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const xml = await xmlDe(req.params.id, depot, options());
      if (xml === null) {
        res.status(404).json({ message: "Jeu de donnees inconnu." });
        return;
      }
      res.set("Cache-Control", "public, max-age=300");
      res.type("application/xml; charset=utf-8").send(xml);
    } catch (err) { next(err); }
  });

  return r;
}

/**
 * Les deux variables sont lues ici, paresseusement, et non importees depuis config/env : ce module
 * est charge par le routeur public, que des tests montent sans environnement. Leur VALIDATION
 * (courriel, URL) reste faite au demarrage par config/env.ts.
 */
function optionsDepuisEnv(): OptionsPublication {
  const courriel = process.env.METADATA_CONTACT_EMAIL?.trim();
  const base = process.env.PUBLIC_BASE_URL?.trim();
  return {
    organisme: "AGEROUTE Guinee",
    courriel: courriel || null,
    baseUrl: base ? base.replace(/\/+$/, "") : null,
    aujourdhui: new Date().toISOString().slice(0, 10),
  };
}
