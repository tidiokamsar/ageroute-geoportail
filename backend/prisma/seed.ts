import { PrismaClient, ClasseRoute, Revetement, EtatPatrimoine, TypeOuvrage, Gravite } from "@prisma/client";
import { hashPassword } from "../src/utils/password";
import "dotenv/config";

const prisma = new PrismaClient();

const REGIONS = ["Conakry", "Boké", "Kindia", "Mamou", "Labé", "Faranah", "Kankan", "Nzérékoré"];

async function main() {
  console.log("Seed : regions...");
  const regions = new Map<string, number>();
  for (const nom of REGIONS) {
    const r = await prisma.region.upsert({ where: { nom }, update: {}, create: { nom } });
    regions.set(nom, r.id);
  }

  console.log("Seed : compte administrateur...");
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "tidiane.diallo@ageroute.gov.gn";
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      nomComplet: process.env.SEED_ADMIN_NAME ?? "Administrateur BDRI",
      passwordHash: await hashPassword(process.env.SEED_ADMIN_PASSWORD ?? "changeme"),
      role: "ADMIN",
    },
  });

  console.log("Seed : troncons RN1-RN6...");
  const troncons = [
    { code: "RN1-01", nom: "Conakry - Coyah", classe: ClasseRoute.RN, region: "Conakry", km: 35, rev: Revetement.BITUME, etat: EtatPatrimoine.BON, pkD: 0, pkF: 35 },
    { code: "RN1-02", nom: "Coyah - Kindia", classe: ClasseRoute.RN, region: "Kindia", km: 45, rev: Revetement.BITUME, etat: EtatPatrimoine.MOYEN, pkD: 35, pkF: 80 },
    { code: "RN1-03", nom: "Kindia - Mamou", classe: ClasseRoute.RN, region: "Mamou", km: 88, rev: Revetement.BITUME, etat: EtatPatrimoine.MOYEN, pkD: 80, pkF: 168 },
    { code: "RN1-04", nom: "Mamou - Faranah", classe: ClasseRoute.RN, region: "Faranah", km: 112, rev: Revetement.BITUME, etat: EtatPatrimoine.MAUVAIS, pkD: 168, pkF: 280 },
    { code: "RN3-01", nom: "Boké - frontiere", classe: ClasseRoute.RN, region: "Boké", km: 95, rev: Revetement.BITUME, etat: EtatPatrimoine.BON, pkD: 0, pkF: 95 },
    { code: "RN5-01", nom: "Labé - Mali-ville", classe: ClasseRoute.RN, region: "Labé", km: 60, rev: Revetement.LATERITE, etat: EtatPatrimoine.MAUVAIS, pkD: 0, pkF: 60 },
    { code: "RN6-01", nom: "Nzérékoré - Lola", classe: ClasseRoute.RN, region: "Nzérékoré", km: 70, rev: Revetement.BITUME, etat: EtatPatrimoine.BON, pkD: 0, pkF: 70 },
    { code: "RN7-01", nom: "Kankan - Kerouane", classe: ClasseRoute.RN, region: "Kankan", km: 130, rev: Revetement.TERRE, etat: EtatPatrimoine.CRITIQUE, pkD: 0, pkF: 130 },
  ];
  const tronconIds: Record<string, string> = {};
  for (const t of troncons) {
    const created = await prisma.troncon.upsert({
      where: { code: t.code },
      update: {},
      create: {
        code: t.code, nom: t.nom, classe: t.classe, regionId: regions.get(t.region)!,
        longueurKm: t.km, revetement: t.rev, etat: t.etat, pkDebut: t.pkD, pkFin: t.pkF,
        traficMoyenJma: Math.floor(800 + Math.random() * 3000),
      },
    });
    tronconIds[t.code] = created.id;
  }

  console.log("Seed : ouvrages d'art...");
  const ouvrages = [
    { nom: "Pont de Kolenté", type: TypeOuvrage.PONT, region: "Kindia", troncon: "RN1-02", etat: EtatPatrimoine.MOYEN, annee: 1985 },
    { nom: "Pont du Konkouré", type: TypeOuvrage.PONT, region: "Boké", troncon: "RN3-01", etat: EtatPatrimoine.BON, annee: 2014 },
    { nom: "Dalot PK35 Kindia-Mamou", type: TypeOuvrage.DALOT, region: "Mamou", troncon: "RN1-03", etat: EtatPatrimoine.BON, annee: 2018 },
    { nom: "Radier de Diafore", type: TypeOuvrage.RADIER, region: "Labé", troncon: "RN5-01", etat: EtatPatrimoine.CRITIQUE, annee: 1995 },
  ];
  for (const o of ouvrages) {
    await prisma.ouvrage.create({
      data: { nom: o.nom, type: o.type, etat: o.etat, regionId: regions.get(o.region)!, tronconId: tronconIds[o.troncon], anneeConstruction: o.annee },
    });
  }

  console.log("Seed : points noirs...");
  await prisma.pointNoir.create({
    data: { description: "Virage dangereux de Linsan", regionId: regions.get("Kindia")!, tronconId: tronconIds["RN1-02"], gravite: Gravite.FORTE, nbAccidents: 14, causes: "Visibilite reduite, vitesse excessive" },
  });

  console.log("Seed : chantier en cours...");
  await prisma.chantier.create({
    data: { intitule: "Rehabilitation RN1 Coyah-Kindia", entreprise: "Entreprise GTM Guinee", bailleur: "BAD", regionId: regions.get("Kindia")!, tronconId: tronconIds["RN1-02"], avancementPct: 62, statut: "EN_COURS" },
  });

  console.log("Seed termine.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
