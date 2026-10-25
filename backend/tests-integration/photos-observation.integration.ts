// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/photos-observation.integration.ts
import "./lib/garde";
// Epreuve de l'ecriture d'une photo d'observation contre `replay` (base construite par les migrations), transaction ANNULEE.
// Ce banc existe parce que le 25/10/2026 une derive a ete trouvee : `schema.prisma` declarait cinq colonnes d'analyse sur
// `medias_observation` que les migrations n'ajoutaient pas, donc `prisma.mediaObservation.create` echouait sur une base issue des
// migrations, alors que tous les tests de la route (base simulee) passaient.
import { PrismaClient } from "@prisma/client";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-pho','pho@local.invalid','Integ','x','INSPECTEUR',now())`);
      await tx.$executeRawUnsafe(`INSERT INTO observations (id, "clientOperationId", "agentId", type, "observeA", "updatedAt") VALUES ('o-pho','op-pho','u-pho','DEGRADATION',now(),now())`);

      // Comme la route : create avec les memes champs, via le client Prisma.
      const cree = await tx.mediaObservation.create({
        data: {
          observationId: "o-pho", type: "PHOTO", chemin: "essai.jpg", sha256: "a".repeat(64), mimeType: "image/jpeg", tailleOctets: 1234,
          lat: 9.64, lon: -13.6, precisionM: 6, cap: null, capturedA: new Date("2026-10-25T09:00:00Z"),
        },
      });
      verifier("le client Prisma ecrit la photo d'observation sur une base issue des migrations (colonnes d'analyse presentes)", cree.id.length > 0 && cree.observationId === "o-pho", cree);
      verifier("personne n'a regarde : `analyseeLe` est nulle, jamais « analysee sans detection »", cree.analyseeLe === null && cree.analyseResultat === null && cree.analyseModele === null, cree);

      const relue = await tx.mediaObservation.findUnique({ where: { sha256: "a".repeat(64) } });
      verifier("la photo se relit par son empreinte SHA-256", relue?.id === cree.id);

      // Une erreur SQL annule la transaction entiere : chaque essai de refus passe par un point de sauvegarde.
      let n = 0;
      const essayer = async (action: () => Promise<unknown>): Promise<string | null> => {
        const sp = `sp_${++n}`;
        await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
        try { await action(); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`); return null; }
        catch (e) { await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`); return (e as { code?: string }).code ?? String(e); }
      };
      const doublon = await essayer(() => tx.mediaObservation.create({ data: { observationId: "o-pho", type: "PHOTO", chemin: "autre.jpg", sha256: "a".repeat(64), mimeType: "image/jpeg", tailleOctets: 1 } }));
      verifier("la meme empreinte ne cree pas une seconde ligne (unicite : P2002)", doublon === "P2002", doublon);

      for (const [nom, sql] of [
        ["une analyse sans modele est refusee par la base", `UPDATE medias_observation SET "analyseeLe" = now() WHERE id = '${cree.id}'`],
        ["un resultat d'analyse qui n'est pas un tableau est refuse", `UPDATE medias_observation SET "analyseeLe" = now(), "analyseModele" = 'm', "analyseResultat" = '{"a":1}'::jsonb WHERE id = '${cree.id}'`],
        ["une confiance hors de [0, 1] est refusee", `UPDATE medias_observation SET "analyseeLe" = now(), "analyseModele" = 'm', "analyseResultat" = '[]'::jsonb, "analyseConfiance" = 1.5 WHERE id = '${cree.id}'`],
      ] as const) {
        verifier(nom, (await essayer(() => tx.$executeRawUnsafe(sql))) !== null);
      }
      await tx.$executeRawUnsafe(`UPDATE medias_observation SET "analyseeLe" = now(), "analyseModele" = 'modele-essai', "analyseResultat" = '[]'::jsonb, "analyseConfiance" = 0.5 WHERE id = '${cree.id}'`);
      const analysee = await tx.mediaObservation.findUnique({ where: { id: cree.id } });
      verifier("une analyse cohérente (date, modele, tableau vide = rien trouve) est acceptee", analysee?.analyseeLe !== null && Array.isArray(analysee?.analyseResultat), analysee);
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
