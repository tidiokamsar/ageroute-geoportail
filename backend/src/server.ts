import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { startSnapshotScheduler } from "./jobs/snapshot-indicateurs";
import { startAlertesScheduler } from "./jobs/alertes-contractuelles";

// JSON.stringify ne sait pas serialiser BigInt nativement (montantGnf, recettesMensuellesGnf...).
// Le frontend attend une chaine pour ces champs (precision GNF potentiellement > Number.MAX_SAFE_INTEGER).
declare global {
  interface BigInt {
    toJSON(): string;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Console BDRI API demarree sur le port ${env.PORT} (${env.NODE_ENV})`);
  console.log(`Documentation Swagger : http://localhost:${env.PORT}/api/docs`);
  startSnapshotScheduler();
  startAlertesScheduler();
});

async function shutdown(signal: string) {
  console.log(`${signal} recu, arret propre du serveur...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
