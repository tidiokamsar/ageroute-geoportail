// Lot T1 : depuis la migration 20261103100000, `POST /api/v2/projets-voirie` exige `territoireId` (CONTRAT-TERRITOIRES.md, section 7).
// Les bancs ecrits AVANT ce lot creent leurs projets sans territoire. Pour qu'ils restent des bancs de NON-REGRESSION de leur propre sujet
// (socle, conflits, import, reseaux, workflow, GDAL) sans reecrire leurs dizaines d'appels, cette enveloppe ajoute un territoire au corps
// JSON d'une creation de projet qui n'en porte pas :
//   - corps avec `regionId` R : un territoire de niveau REGION rattache a R (cree au premier besoin, code `BANC-REG-<R>`, sous la nation) ;
//   - corps sans region : la nation (territoire sans region : meme visibilite qu'un projet sans region, comptes nationaux seulement).
// Rien d'autre n'est touche (les depots multipart ne sont pas lus). Le comportement propre au territoire est prouve par le banc
// `territoires-referentiels.integration.mts`, pas par cette enveloppe. Un corps qui porte deja `territoireId` passe tel quel.
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prisma = { $queryRawUnsafe: (q: string, ...v: unknown[]) => Promise<any[]> };

export function avecTerritoireParDefaut(app: Express, prisma: Prisma, base = "/api/v2/projets-voirie"): Express {
  const cache = new Map<string, string>();
  async function territoirePour(regionId: number | null): Promise<string> {
    const cle = String(regionId);
    const deja = cache.get(cle);
    if (deja) return deja;
    const nation = (await prisma.$queryRawUnsafe(`SELECT "id" FROM "territoires_voirie" WHERE "niveau" = 'NATION' AND "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1`))[0]?.id as string | undefined;
    if (!nation) throw new Error("banc : aucune nation dans territoires_voirie (la migration 20261103100000 doit etre appliquee au clone)");
    let id = nation;
    // Une region inexistante (test d'une region inconnue) garde la nation : le service repond lui-meme 400 REGION_INCONNUE.
    const regionExiste = regionId !== null && (await prisma.$queryRawUnsafe(`SELECT 1 FROM "regions" WHERE "id" = $1`, regionId)).length > 0;
    if (regionId !== null && regionExiste) {
      const trouve = (await prisma.$queryRawUnsafe(`SELECT "id" FROM "territoires_voirie" WHERE "niveau" = 'REGION' AND "regionId" = $1 AND "deletedAt" IS NULL LIMIT 1`, regionId))[0]?.id as string | undefined;
      id = trouve ?? ((await prisma.$queryRawUnsafe(
        `INSERT INTO "territoires_voirie" ("id", "parentId", "niveau", "code", "nom", "chemin", "profondeur", "regionId", "source")
         VALUES (gen_random_uuid()::text, $1, 'REGION', $2, $3, '', 0, $4, 'banc : territoire par defaut des bancs anterieurs au lot T1') RETURNING "id"`,
        nation, `BANC-REG-${regionId}`, `Region de banc ${regionId}`, regionId))[0].id as string);
    }
    cache.set(cle, id);
    return id;
  }

  const enveloppe = express();
  // Meme limite que l'application (5 Mo) ; seule la creation d'un projet est lue ici, tout le reste passe sans lecture du corps.
  enveloppe.post(base, express.json({ limit: "5mb" }), (req: Request, _res: Response, next: NextFunction) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (b && typeof b === "object" && !Array.isArray(b) && b.territoireId === undefined) {
      const region = typeof b.regionId === "number" ? b.regionId : null;
      territoirePour(region).then((id) => { b.territoireId = id; next(); }).catch(next);
      return;
    }
    next();
  });
  enveloppe.use(app);
  return enveloppe;
}
