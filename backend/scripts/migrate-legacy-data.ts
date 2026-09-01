/**
 * Migration des donnees reelles depuis l'ancienne base sig_routier (PostGIS, stack
 * PostgREST/MapLibre, serveur GEC) vers le nouveau schema Prisma (console-bdri).
 * Schema reel verifie sur le serveur de production le 23/06/2026.
 *
 * Usage : LEGACY_DATABASE_URL=postgres://... DATABASE_URL=postgres://... tsx scripts/migrate-legacy-data.ts
 */
import { Client } from "pg";
import { PrismaClient } from "@prisma/client";

const legacyUrl = process.env.LEGACY_DATABASE_URL;
if (!legacyUrl) {
  console.error("LEGACY_DATABASE_URL manquant (URL de l'ancienne base sig_routier).");
  process.exit(1);
}

const legacy = new Client({ connectionString: legacyUrl });
const prisma = new PrismaClient();

const FALLBACK_REGION = "Non renseigné";

function normalize(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

// etat texte du shapefile reseau_routier_import (6 niveaux) -> EtatPatrimoine (5 niveaux)
const RESEAU_ETAT_MAP: Record<string, string> = {
  "1- bon etat general": "BON",
  "2- alternance bon / moyen": "MOYEN",
  "3- moyen etat general": "MOYEN",
  "4- alternance moyen / mauvais": "MAUVAIS",
  "5- mauvais etat general": "CRITIQUE",
  "6- non observe": "NON_EVALUE",
};

// ref_etat.libelle (ouvrages/equipements) -> EtatPatrimoine
const REF_ETAT_MAP: Record<string, string> = {
  bon: "BON",
  moyen: "MOYEN",
  mauvais: "MAUVAIS",
  "tres mauvais": "CRITIQUE",
  "non evalue": "NON_EVALUE",
};

const TYPE_OUVRAGE_MAP: Record<string, string> = {
  pont: "PONT",
  dalot: "DALOT",
  buse: "BUSE",
  radier: "RADIER",
  ponceau: "PONCEAU",
  "mur de soutenement": "MUR_SOUTENEMENT",
  tunnel: "TUNNEL",
  passerelle: "PASSERELLE",
  viaduc: "VIADUC",
};

const GRAVITE_MAP: Record<string, string> = { faible: "FAIBLE", moyenne: "MOYENNE", forte: "FORTE" };

const TYPE_POSTE_MAP: Record<string, string> = { peage: "PEAGE", pesage: "PESAGE" };

const STATUT_POSTE_MAP: Record<string, string> = {
  "en service": "EN_SERVICE",
  "hors service": "HORS_SERVICE",
  "en construction": "EN_CONSTRUCTION",
};

const STATUT_CHANTIER_MAP: Record<string, string> = {
  "planifie": "PLANIFIE",
  "en cours": "EN_COURS",
  "travaux en cours": "EN_COURS",
  "suspendu": "SUSPENDU",
  "termine": "TERMINE",
};

async function migrateRegions() {
  const fallback = await prisma.region.upsert({
    where: { nom: FALLBACK_REGION },
    update: {},
    create: { nom: FALLBACK_REGION },
  });

  const { rows } = await legacy.query<{ id: number; nom: string }>("SELECT id, nom FROM ref_regions ORDER BY id");
  const idMap = new Map<number, number>();
  const byNormalizedName = new Map<string, number>();
  for (const r of rows) {
    const region = await prisma.region.upsert({ where: { nom: r.nom }, update: {}, create: { nom: r.nom } });
    idMap.set(r.id, region.id);
    byNormalizedName.set(normalize(r.nom), region.id);
  }
  console.log(`Régions migrées : ${idMap.size} (+ région de repli "${FALLBACK_REGION}")`);
  return { idMap, byNormalizedName, fallbackId: fallback.id };
}

interface TronconRow {
  ogc_fid: number;
  nom_route: string | null;
  name: string | null;
  code_bdr: string | null;
  troncon: string | null;
  nom_region: string | null;
  classement: string | null;
  longueur: number | null;
  etat: string | null;
  pkorigine: number | null;
  pkfin: number | null;
  trafic_jma: number | null;
  wkt: string | null;
}

async function migrateTroncons(byNormalizedName: Map<string, number>, fallbackId: number) {
  const { rows } = await legacy.query<TronconRow>(
    `SELECT ogc_fid, nom_route, name, code_bdr, troncon, nom_region, classement, longueur, etat,
            pkorigine, pkfin, trafic_jma,
            (SELECT ST_AsText(d.geom) FROM ST_Dump(geom) AS d ORDER BY ST_Length(d.geom) DESC LIMIT 1) AS wkt
     FROM reseau_routier_import
     WHERE geom IS NOT NULL`
  );

  const usedCodes = new Set<string>();
  let count = 0;
  for (const t of rows) {
    if (!t.wkt) continue;
    let code = (t.code_bdr || t.troncon || "").trim() || `RES-${t.ogc_fid}`;
    if (usedCodes.has(code)) code = `${code}-${t.ogc_fid}`;
    usedCodes.add(code);

    const regionId = byNormalizedName.get(normalize(t.nom_region)) ?? fallbackId;
    const etat = RESEAU_ETAT_MAP[normalize(t.etat)] ?? "NON_EVALUE";

    const created = await prisma.troncon.upsert({
      where: { code },
      update: {},
      create: {
        code,
        nom: t.nom_route || t.name || code,
        classe: normalize(t.classement) === "nationale" ? "RN" : "RR",
        regionId,
        longueurKm: t.longueur ?? 0,
        revetement: "BITUME", // non renseigne dans la source legacy
        etat: etat as never,
        pkDebut: t.pkorigine ?? 0,
        pkFin: t.pkfin ?? 0,
        traficMoyenJma: t.trafic_jma ?? null,
      },
    });

    await prisma.$executeRaw`UPDATE troncons SET geom = ST_GeomFromText(${t.wkt}, 4326) WHERE id = ${created.id}`;
    count++;
  }
  console.log(`Tronçons migrés : ${count}`);
}

async function migrateOuvrages(idMap: Map<number, number>, fallbackId: number) {
  const { rows } = await legacy.query(
    `SELECT o.id, o.nom, ot.libelle AS type, oe.libelle AS etat, o.regions_id, o.code_troncon, o.pk,
            o.longueur_m, o.gabarit_t, o.annee_construction, o.materiau, ST_AsText(o.geom) AS wkt
     FROM ouvrages_art o
     LEFT JOIN ref_type_ouvrage ot ON ot.id = o.type_ouvrage_id
     LEFT JOIN ref_etat oe ON oe.id = o.etat_id`
  );
  let count = 0;
  for (const o of rows) {
    const regionId = o.regions_id ? idMap.get(o.regions_id) ?? fallbackId : fallbackId;
    const troncon = o.code_troncon ? await prisma.troncon.findUnique({ where: { code: o.code_troncon } }) : null;

    const created = await prisma.ouvrage.create({
      data: {
        nom: o.nom,
        type: (TYPE_OUVRAGE_MAP[normalize(o.type)] ?? "PONT") as never,
        etat: (REF_ETAT_MAP[normalize(o.etat)] ?? "NON_EVALUE") as never,
        regionId,
        tronconId: troncon?.id,
        pk: o.pk != null ? Number(o.pk) : undefined,
        longueurM: o.longueur_m != null ? Number(o.longueur_m) : undefined,
        gabaritT: o.gabarit_t != null ? Number(o.gabarit_t) : undefined,
        anneeConstruction: o.annee_construction ?? undefined,
        materiau: o.materiau ?? undefined,
      },
    });
    if (o.wkt) {
      await prisma.$executeRaw`UPDATE ouvrages SET geom = ST_GeomFromText(${o.wkt}, 4326) WHERE id = ${created.id}`;
    }
    count++;
  }
  console.log(`Ouvrages d'art migrés : ${count}`);
}

async function migratePointsNoirs(idMap: Map<number, number>, fallbackId: number) {
  const { rows } = await legacy.query(
    `SELECT description, code_troncon, regions_id, gravite, nb_accidents, causes, mesures_correctives,
            ST_AsText(geom) AS wkt
     FROM points_noirs`
  );
  let count = 0;
  for (const p of rows) {
    const regionId = p.regions_id ? idMap.get(p.regions_id) ?? fallbackId : fallbackId;
    const troncon = p.code_troncon ? await prisma.troncon.findUnique({ where: { code: p.code_troncon } }) : null;

    const created = await prisma.pointNoir.create({
      data: {
        description: p.description ?? "Point noir",
        regionId,
        tronconId: troncon?.id,
        gravite: (GRAVITE_MAP[normalize(p.gravite)] ?? "MOYENNE") as never,
        nbAccidents: p.nb_accidents ?? 0,
        causes: p.causes ?? undefined,
        mesuresCorrectives: p.mesures_correctives ?? undefined,
      },
    });
    if (p.wkt) {
      await prisma.$executeRaw`UPDATE points_noirs SET geom = ST_GeomFromText(${p.wkt}, 4326) WHERE id = ${created.id}`;
    }
    count++;
  }
  console.log(`Points noirs migrés : ${count}`);
}

async function migratePostes(idMap: Map<number, number>, fallbackId: number) {
  const { rows } = await legacy.query(
    `SELECT nom, type_poste, code_troncon, regions_id, statut, recettes_mensuelles_gnf, trafic_jma,
            ST_AsText(geom) AS wkt
     FROM postes_controle`
  );
  let count = 0;
  for (const p of rows) {
    const regionId = p.regions_id ? idMap.get(p.regions_id) ?? fallbackId : fallbackId;
    const troncon = p.code_troncon ? await prisma.troncon.findUnique({ where: { code: p.code_troncon } }) : null;

    const created = await prisma.poste.create({
      data: {
        nom: p.nom,
        type: (TYPE_POSTE_MAP[normalize(p.type_poste)] ?? "PEAGE") as never,
        regionId,
        tronconId: troncon?.id,
        statut: (STATUT_POSTE_MAP[normalize(p.statut)] ?? "EN_SERVICE") as never,
        recettesMensuellesGnf: p.recettes_mensuelles_gnf != null ? BigInt(p.recettes_mensuelles_gnf) : undefined,
        traficJma: p.trafic_jma ?? undefined,
      },
    });
    if (p.wkt) {
      await prisma.$executeRaw`UPDATE postes SET geom = ST_GeomFromText(${p.wkt}, 4326) WHERE id = ${created.id}`;
    }
    count++;
  }
  console.log(`Postes péage/pesage migrés : ${count}`);
}

async function migrateChantiers(idMap: Map<number, number>, fallbackId: number) {
  const { rows } = await legacy.query(
    `SELECT intitule, code_troncon, regions_id, entreprise, bailleur, montant_gnf, statut, avancement_pct,
            date_debut, date_fin_prevue, date_fin_reelle, ST_AsText(geom) AS wkt
     FROM chantiers`
  );
  let count = 0;
  for (const c of rows) {
    const regionId = c.regions_id ? idMap.get(c.regions_id) ?? fallbackId : fallbackId;
    const troncon = c.code_troncon ? await prisma.troncon.findUnique({ where: { code: c.code_troncon } }) : null;

    const created = await prisma.chantier.create({
      data: {
        intitule: c.intitule ?? "Chantier",
        entreprise: c.entreprise || "Non renseigné",
        bailleur: c.bailleur ?? undefined,
        montantGnf: c.montant_gnf != null ? BigInt(c.montant_gnf) : undefined,
        regionId,
        tronconId: troncon?.id,
        avancementPct: c.avancement_pct ?? 0,
        statut: (STATUT_CHANTIER_MAP[normalize(c.statut)] ?? "PLANIFIE") as never,
        dateDebutPrevue: c.date_debut ?? undefined,
        dateFinPrevue: c.date_fin_prevue ?? undefined,
        dateFinReelle: c.date_fin_reelle ?? undefined,
      },
    });
    if (c.wkt) {
      await prisma.$executeRaw`UPDATE chantiers SET geom = ST_GeomFromText(${c.wkt}, 4326) WHERE id = ${created.id}`;
    }
    count++;
  }
  console.log(`Chantiers migrés : ${count}`);
}

async function main() {
  await legacy.connect();
  console.log("Connexion établie à l'ancienne base sig_routier. Démarrage de la migration...");

  const { idMap, byNormalizedName, fallbackId } = await migrateRegions();
  await migrateTroncons(byNormalizedName, fallbackId);
  await migrateOuvrages(idMap, fallbackId);
  await migratePointsNoirs(idMap, fallbackId);
  await migratePostes(idMap, fallbackId);
  await migrateChantiers(idMap, fallbackId);

  console.log("Migration terminée.");
}

main()
  .catch((err) => {
    console.error("Erreur de migration :", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await legacy.end();
    await prisma.$disconnect();
  });
