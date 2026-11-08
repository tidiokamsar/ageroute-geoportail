// Banc d'integration PostGIS des indicateurs de l'Aide a la decision (lot 2) : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`, jamais ecrite : le banc travaille dans le clone `essai_ad_l2_kpi`, cree puis detruit
// par lui) :
//   DATABASE_URL=postgresql://<utilisateur>:<motdepasse>@127.0.0.1:5434/replay npx tsx tests-integration/aide-decision-kpi.integration.mts
//
// CE QUE LE BANC EPROUVE, CONTRE POSTGIS REEL
//   Pour chaque indicateur, sur cinq portees (pays, region 1, region 2, regions 1 et 2, region vide), TROIS accords :
//     1. la valeur attendue CALCULEE A LA MAIN dans ce fichier (commentee troncon par troncon) ;
//     2. un ORACLE SQL ecrit a part (une autre formulation : sous-requetes EXISTS, starts_with, BETWEEN, bornes JS en BigInt) ;
//     3. le service (`composerSynthese`, donc `kpi.depot.ts`, le registre d'indicateurs et les detecteurs de qualite).
//   Fixtures VOLONTAIREMENT PIEGEES : voirie promue et hors territoire (CRITIQUE, qui ne doivent PAS entrer au numerateur
//   seul), troncon supprime, etat importe non verifie, sans ligne de provenance, en conflit, a ligne « inconnu », constat sans
//   date, troncon rejete, longueur nulle, longueur NaN, longueur DERIVEE de la geometrie, non evalue, trois classes de route ;
//   marches en GNF, en USD, sans montant, sans bailleur, sans chantier, a cheval sur deux regions, supprimes, rattaches a un
//   chantier supprime ; decomptes payes, emis, rejetes, supprimes, sans date, de retenue de garantie ; montants au-dela de 2^53.
//   AUCUNE ECRITURE : empreinte md5 de chaque table source avant et apres tous les appels (service, HTTP, volume exclu).
//   COMPTES REELS : routeur monte derriere requireAuth / requireModuleAccess, jetons signes (secrets aleatoires), modules et
//   perimetre lus en base ; un compte regional ne recoit rien d'une autre region ; 404 identique ; montants sans le droit.
//   CONTRE-EPREUVES : la formule HERITEE donne plus de 100 % sur ces fixtures ; une voirie promue qui entrerait dans le perimetre
//   fausserait le taux (le banc le voit) ; une provenance elargie le change.
//   VOLUME : 50 000 troncons, 3 000 marches, 8 000 chantiers, 12 000 decomptes ; durees mesurees et consignees ; l'accord
//   avec l'oracle est reverifie au volume.
//
// CE QU'IL NE PROUVE PAS : la production (volumes reels, distribution des etats et des provenances, couche de limites
// administratives : `replay` n'en porte aucune, la famille REGION des detecteurs n'est donc pas executee, sauf au volume ou le
// banc en cree deux), ni la pertinence metier des definitions (PROVISOIRES). Les durees sont celles de ce poste.
import { performance } from "node:perf_hooks";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";

const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_ad_l2_kpi");
const { prisma } = await banc.imp("lib/prisma");
const { composerSynthese, depotPrisma } = await banc.imp("aide-decision/synthese");
const { composerQualite } = await banc.imp("aide-decision/qualite");
const { lireEtatReseau, lireMarches, lireDecaisse, lireParBailleur } = await banc.imp("aide-decision/kpi.depot");
const { agregerEtat, indicateursReseau } = await banc.imp("aide-decision/kpi.noyau");
const { aideDecisionSyntheseRouter } = await banc.imp("api-v2/aide-decision.synthese.routes");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const { REGISTRE } = await banc.imp("tableau-de-bord/indicateurs.registre");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const sql = <T = Record<string, unknown>>(texte: string, ...p: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...p);
const exec = (texte: string, ...p: unknown[]): Promise<number> => prisma.$executeRawUnsafe(texte, ...p);
const NOW = new Date("2026-10-26T12:00:00Z");

try {
  // ============================================================================ fixtures
  await exec(`INSERT INTO regions (nom) VALUES ('Region AD1'), ('Region AD2'), ('Region AD3 vide')`);
  const idRegion = async (nom: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, nom))[0].id);
  const [R1, R2, R3] = [await idRegion("Region AD1"), await idRegion("Region AD2"), await idRegion("Region AD3 vide")];
  await exec(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-ad','ad@x.invalid','Auteur banc','x','GESTIONNAIRE',now())`);

  // Un troncon : [id, region, longueurKm, etat, classe, sourceReference, supprime, statutValidation, dateDerniereEvaluation, [lon, lat1, lat2] | null]
  type T = {
    id: string; region: number; km: number | "NaN"; etat: string; classe?: string; src?: string | null; supprime?: boolean; sv?: string | null; date?: string | null;
    geom?: [number, number, number];
    /** Ligne de provenance de l'etat : [statut, observedAt | null] ; absente = aucune ligne. */
    prov?: [string, string | null]; derive?: boolean;
  };
  const D = "2026-09-01 00:00:00";
  const TRONCONS: T[] = [
    // ---- region 1
    { id: "ad-t01", region: R1, km: 10, etat: "MAUVAIS", date: "2026-10-01 00:00:00", prov: ["OBSERVED", D], geom: [-13.0, 9.0, 9.01] },    // VALIDE 10 (degrade)
    { id: "ad-t02", region: R1, km: 5, etat: "CRITIQUE", date: "2026-08-01 00:00:00", prov: ["OBSERVED", D] },                          // VALIDE 5 (critique)
    { id: "ad-t03", region: R1, km: 20, etat: "BON", classe: "RR", date: "2026-06-15 00:00:00", prov: ["OBSERVED", D] },               // VALIDE 20
    { id: "ad-t04", region: R1, km: 15, etat: "MOYEN", classe: "RR", date: "2025-12-01 00:00:00", prov: ["OBSERVED", D] },             // VALIDE 15
    { id: "ad-t05", region: R1, km: 100, etat: "CRITIQUE", date: "2026-10-25 00:00:00", prov: ["IMPORTED_UNVERIFIED", null] },         // NON VALIDE (importe) 100
    { id: "ad-t06", region: R1, km: 40, etat: "MAUVAIS" },                                                                              // NON VALIDE (aucune ligne) 40
    { id: "ad-t07", region: R1, km: 30, etat: "NON_EVALUE", prov: ["UNKNOWN", null] },                                                  // NON EVALUE 30
    { id: "ad-t08", region: R1, km: 0, etat: "CRITIQUE", prov: ["OBSERVED", D] },                                                       // VALIDE mais longueur NULLE : comptee, pas additionnee
    { id: "ad-t09", region: R1, km: 77, etat: "MAUVAIS", prov: ["OBSERVED", D], derive: true },                                          // VALIDE mais longueur DERIVEE de la geometrie : inconnue
    { id: "ad-t10", region: R1, km: 500, etat: "CRITIQUE", src: "voirie_locale:x", prov: ["OBSERVED", D] },                              // voirie promue : HORS PERIMETRE
    { id: "ad-t11", region: R1, km: 300, etat: "CRITIQUE", src: "hors_territoire:x", prov: ["OBSERVED", D] },                           // hors territoire : HORS PERIMETRE
    { id: "ad-t12", region: R1, km: 999, etat: "CRITIQUE", supprime: true, prov: ["OBSERVED", D] },                                      // supprime : HORS PERIMETRE
    { id: "ad-t13", region: R1, km: 8, etat: "CRITIQUE", sv: "REJETE", prov: ["OBSERVED", D] },                                         // NON VALIDE (rejete) 8
    { id: "ad-t14", region: R1, km: 12, etat: "BON", sv: "A_VALIDER", date: "2026-09-20 00:00:00", prov: ["OBSERVED", D] },            // VALIDE 12
    { id: "ad-t15", region: R1, km: 25, etat: "MAUVAIS", prov: ["CONFLICTING", D] },                                                    // NON VALIDE (conflit) 25
    { id: "ad-t16", region: R1, km: 9, etat: "MOYEN", prov: ["OBSERVED", null] },                                                       // NON VALIDE (constat sans date) 9
    { id: "ad-t17", region: R1, km: "NaN", etat: "MAUVAIS", prov: ["OBSERVED", D] },                                                    // VALIDE mais longueur NaN : inconnue
    // ---- region 2
    { id: "ad-t20", region: R2, km: 60, etat: "CRITIQUE", date: "2026-10-20 00:00:00", prov: ["OBSERVED", D], geom: [-12.0, 10.0, 10.03] }, // VALIDE 60
    { id: "ad-t21", region: R2, km: 140, etat: "BON", date: "2024-03-01 00:00:00", prov: ["OBSERVED", D] },                              // VALIDE 140
    { id: "ad-t22", region: R2, km: 20, etat: "NON_EVALUE", prov: ["UNKNOWN", null] },                                                  // NON EVALUE 20
    { id: "ad-t23", region: R2, km: 4, etat: "MAUVAIS" },                                                                               // NON VALIDE (aucune ligne) 4
    { id: "ad-t24", region: R2, km: 10, etat: "BON", classe: "NON_CLASSEE", prov: ["OBSERVED", D] },                                     // VALIDE 10
  ];
  const ligne = (lon: number, a: number, b: number) => `ST_SetSRID(ST_MakeLine(ST_MakePoint(${lon}, ${a}), ST_MakePoint(${lon}, ${b})), 4326)`;
  const insererTroncon = async (t: T) => {
    await exec(
      `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", geom, "sourceReference", "deletedAt", "statutValidation", "dateDerniereEvaluation", "updatedAt")
       VALUES ($1, $1, $1, $2::"ClasseRoute", $3, $4::float8, 'BITUME', $5::"EtatPatrimoine", 0, 1, ${t.geom ? ligne(...t.geom) : "NULL"}, $6, ${t.supprime ? "now()" : "NULL"}, $7::"StatutValidation", $8::timestamp, now())`,
      t.id, t.classe ?? "RN", t.region, String(t.km), t.etat, t.src ?? null, t.sv ?? null, t.date ?? null);
    if (t.prov) {
      await exec(`INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, "observedAt", "updatedAt") VALUES ($1,'Troncon',$2,'etat',$3::"StatutValeur",$4::timestamp,now())`,
        `vq-${t.id}-etat`, t.id, t.prov[0], t.prov[1]);
    }
    if (t.derive) {
      await exec(`INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, "updatedAt") VALUES ($1,'Troncon',$2,'longueurKm','DERIVED',now())`, `vq-${t.id}-lg`, t.id);
    }
  };
  for (const t of TRONCONS.filter((x) => x.km !== "NaN")) await insererTroncon(t);
  const T17 = TRONCONS.find((x) => x.id === "ad-t17")!; // NaN : insere plus tard, pour comparer d'abord le registre sans lui

  // Chantiers : montants volontairement enormes, pour prouver que leur somme n'est jamais lue.
  const chantier = (id: string, region: number, statut: string, fin: string | null, montant: number | null, supprime = false) => exec(
    `INSERT INTO chantiers (id, intitule, entreprise, "regionId", statut, "dateFinPrevue", "montantGnf", "deletedAt", "updatedAt")
     VALUES ($1, $1, 'Entreprise', $2, $3::"StatutChantier", $4::timestamp, $5::bigint, ${supprime ? "now()" : "NULL"}, now())`, id, region, statut, fin, montant);
  await chantier("ad-c1", R1, "EN_COURS", "2026-10-01T00:00:00", 1_000_000_000_000);  // en retard
  await chantier("ad-c2", R1, "EN_COURS", "2026-11-30T00:00:00", 2_000_000_000_000);  // a l'heure
  await chantier("ad-c3", R1, "EN_COURS", null, 3_000_000_000_000);                    // sans echeance : retard non juge
  await chantier("ad-c4", R1, "PLANIFIE", "2025-01-01T00:00:00", 4_000_000_000_000);
  await chantier("ad-c5", R2, "EN_COURS", "2025-01-01T00:00:00", 5_000_000_000_000);  // en retard
  await chantier("ad-c6", R2, "TERMINE", null, 6_000_000_000_000);
  await chantier("ad-c7", R2, "EN_COURS", "2025-01-01T00:00:00", 7_000_000_000_000, true); // supprime

  // Bailleurs et marches
  await exec(`INSERT INTO bailleurs (nom, type) VALUES ('AD Bailleur A','bilateral'), ('AD Bailleur B','multilateral')`);
  const bailleurA = Number((await sql<{ id: number }>(`SELECT id FROM bailleurs WHERE nom='AD Bailleur A'`))[0].id);
  const bailleurB = Number((await sql<{ id: number }>(`SELECT id FROM bailleurs WHERE nom='AD Bailleur B'`))[0].id);
  const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const marche = (n: number, bailleur: number | null, montant: string | null, devise: string, chantiers: string[], supprime = false) =>
    exec(`INSERT INTO marches (id, intitule, "bailleurId", "montantTotal", devise, "deletedAt", "updatedAt") VALUES ($1::uuid, $2, $3, $4::bigint, $5::"DeviseMarche", ${supprime ? "now()" : "NULL"}, now())`, u(n), `ad-m${n}`, bailleur, montant, devise)
      .then(async () => { for (const c of chantiers) await exec(`INSERT INTO marches_chantiers ("marcheId","chantierId") VALUES ($1::uuid,$2)`, u(n), c); });
  await marche(1, bailleurA, "1000", "GNF", ["ad-c1"]);                              // region 1
  await marche(2, bailleurA, "2000", "GNF", ["ad-c2", "ad-c3"]);                    // region 1
  await marche(3, bailleurB, "4000", "GNF", ["ad-c5"]);                              // region 2
  await marche(4, bailleurB, "9007199254740993", "GNF", ["ad-c1", "ad-c5"]);        // A CHEVAL sur deux regions, > 2^53
  await marche(5, null, "500", "GNF", []);                                           // sans bailleur, sans chantier : pays seulement
  await marche(6, bailleurA, "777", "USD", ["ad-c1"]);                               // devise etrangere : exclu de la somme GNF
  await marche(7, bailleurB, null, "GNF", ["ad-c5"]);                                // sans montant
  await marche(8, bailleurA, "123456", "GNF", ["ad-c1"], true);                      // marche supprime
  await marche(9, bailleurA, "300", "GNF", ["ad-c7"]);                               // rattache a un chantier supprime seulement
  const decompte = (n: number, marcheN: number, numero: number, type: string, montant: string, statut: string, datePaiement: string | null, supprime = false) =>
    exec(`INSERT INTO decomptes (id, "marcheId", numero, type, "montantGnf", statut, "datePaiement", "deletedAt", "updatedAt")
          VALUES ($1::uuid, $2::uuid, $3, $4::"DecompteType", $5::bigint, $6::"DecompteStatut", $7::timestamp, ${supprime ? "now()" : "NULL"}, now())`, u(100 + n), u(marcheN), numero, type, montant, statut, datePaiement);
  await decompte(1, 1, 1, "DECOMPTE", "100", "PAYE", "2026-09-01T00:00:00");
  await decompte(2, 1, 2, "DECOMPTE", "50", "EMIS", null);
  await decompte(3, 2, 1, "DECOMPTE", "200", "PAYE", null);                          // paye sans date
  await decompte(4, 3, 1, "RETENUE_GARANTIE", "300", "PAYE", "2026-09-02T00:00:00");
  await decompte(5, 4, 1, "SOLDE", "9007199254740000", "PAYE", "2026-09-03T00:00:00");
  await decompte(6, 5, 1, "AVANCE", "7", "PAYE", null);
  await decompte(7, 1, 3, "DECOMPTE", "11", "REJETE", null);
  await decompte(8, 1, 4, "DECOMPTE", "999", "PAYE", "2026-09-04T00:00:00", true);   // decompte supprime
  await decompte(9, 8, 1, "DECOMPTE", "55555", "PAYE", "2026-09-05T00:00:00");       // marche supprime

  // Previsions budgetaires
  const prevision = (n: number, tronc: string | null, statut: string, montant: string, supprime = false) => exec(
    `INSERT INTO programmes_budgetaires (id, annee, intitule, "tronconId", "montantPrevuGnf", statut, "createdById", "deletedAt")
     VALUES ($1::uuid, 2027, $2, $3, $4::bigint, $5, 'u-ad', ${supprime ? "now()" : "NULL"})`, u(200 + n), `ad-p${n}`, tronc, montant, statut);
  await prevision(1, "ad-t01", "RETENU", "500");
  await prevision(2, "ad-t20", "RETENU", "9007199254740993");
  await prevision(3, "ad-t01", "PROPOSE", "40");
  await prevision(4, null, "RETENU", "10");
  await prevision(5, "ad-t01", "RETENU", "77", true);

  // ============================================================================ attendus calcules a la main
  // PERIMETRE = reseau classe saisi, non supprime : t01..t09, t13..t17 (region 1), t20..t24 (region 2). t10, t11, t12 en sont exclus.
  // Region 1 : valides = t01 10, t02 5, t03 20, t04 15, t14 12 (= 62 km) + t08 t09 t17 sans longueur ; non valides = t05 100, t06 40, t13 8, t15 25, t16 9 (= 182 km) ;
  //            non evalue = t07 30 km. Longueur connue = 62 + 182 + 30 = 274. Degrade valide = 10 + 5 = 15. Critique valide = 5.
  // Region 2 : valides = t20 60, t21 140, t24 10 (= 210) ; non valide = t23 4 ; non evalue = t22 20. Longueur connue = 234. Degrade = 60. Critique = 60.
  // Pays : eligible 272, degrade 75 (27,6 %), critique 65 km (23,9 %), evalue 272 + 186 = 458, non evalue 50, longueur 508.
  type Etat = {
    degrade: number | null; critiqueKm: number | null; critiquePct: number | null; longueurRef: number | null; couvEtat: number | null; partNonEv: number | null;
    troncons: number; sansLongueur: number; nonEvN: number; nonValN: number; eligible: number; evalue: number; nonEvKm: number;
  };
  const ETAT: Record<string, Etat> = {
    pays: { degrade: 27.6, critiqueKm: 65, critiquePct: 23.9, longueurRef: 508, couvEtat: 0.5354, partNonEv: 0.0984, troncons: 19, sansLongueur: 3, nonEvN: 2, nonValN: 6, eligible: 272, evalue: 458, nonEvKm: 50 },
    r1: { degrade: 24.2, critiqueKm: 5, critiquePct: 8.1, longueurRef: 274, couvEtat: 0.2263, partNonEv: 0.1095, troncons: 14, sansLongueur: 3, nonEvN: 1, nonValN: 5, eligible: 62, evalue: 244, nonEvKm: 30 },
    r2: { degrade: 28.6, critiqueKm: 60, critiquePct: 28.6, longueurRef: 234, couvEtat: 0.8974, partNonEv: 0.0855, troncons: 5, sansLongueur: 0, nonEvN: 1, nonValN: 1, eligible: 210, evalue: 214, nonEvKm: 20 },
    r12: { degrade: 27.6, critiqueKm: 65, critiquePct: 23.9, longueurRef: 508, couvEtat: 0.5354, partNonEv: 0.0984, troncons: 19, sansLongueur: 3, nonEvN: 2, nonValN: 6, eligible: 272, evalue: 458, nonEvKm: 50 },
    r3: { degrade: null, critiqueKm: null, critiquePct: null, longueurRef: null, couvEtat: null, partNonEv: null, troncons: 0, sansLongueur: 0, nonEvN: 0, nonValN: 0, eligible: 0, evalue: 0, nonEvKm: 0 },
  };
  // Marches : voir les commentaires des fixtures. Pays = m1 m2 m3 m4 m5 m6 m7 m9 (m8 supprime) ; region 1 = m1 m2 m6 ; region 2 = m3 m7 ;
  // regions 1 et 2 = m1 m2 m3 m4 m6 m7 (m4 a cheval mais ses deux regions sont dans la portee) ; m5 (sans chantier) et m9 (chantier supprime) : pays seulement.
  type Fin = {
    chantiersEnCours: number | null; chantiersEnRetard: number | null; marches: number | null; contractuel: string | null;
    sansMontant: number; horsGnf: number; decaisse: string | null; payes: number; payesSansDate: number; retenue: number; emis: number; previsionnel: string | null;
  };
  const FIN: Record<string, Fin> = {
    pays: { chantiersEnCours: 4, chantiersEnRetard: 2, marches: 8, contractuel: "9007199254748793", sansMontant: 1, horsGnf: 1, decaisse: "9007199254740607", payes: 5, payesSansDate: 2, retenue: 1, emis: 1, previsionnel: "9007199254741503" },
    r1: { chantiersEnCours: 3, chantiersEnRetard: 1, marches: 3, contractuel: "3000", sansMontant: 0, horsGnf: 1, decaisse: "300", payes: 2, payesSansDate: 1, retenue: 0, emis: 1, previsionnel: "500" },
    r2: { chantiersEnCours: 1, chantiersEnRetard: 1, marches: 2, contractuel: "4000", sansMontant: 1, horsGnf: 0, decaisse: "300", payes: 1, payesSansDate: 0, retenue: 1, emis: 0, previsionnel: "9007199254740993" },
    r12: { chantiersEnCours: 4, chantiersEnRetard: 2, marches: 6, contractuel: "9007199254747993", sansMontant: 1, horsGnf: 1, decaisse: "9007199254740600", payes: 4, payesSansDate: 1, retenue: 1, emis: 1, previsionnel: "9007199254741493" },
    r3: { chantiersEnCours: null, chantiersEnRetard: null, marches: null, contractuel: null, sansMontant: 0, horsGnf: 0, decaisse: null, payes: 0, payesSansDate: 0, retenue: 0, emis: 0, previsionnel: null },
  };
  const PORTEES: [string, number[] | null][] = [["pays", null], ["r1", [R1]], ["r2", [R2]], ["r12", [R1, R2]], ["r3", [R3]]];

  // ============================================================================ oracles SQL (ecrits a part)
  const oracleEtat = async (regions: number[] | null, classes: string[] | null = null) => (await sql<Record<string, number>>(`
    WITH p AS (
      SELECT t.id, t."regionId" AS r, t.etat::text AS etat, t."longueurKm" AS km,
             (t."longueurKm" BETWEEN 0.000001 AND 1e12
                AND NOT EXISTS (SELECT 1 FROM valeurs_qualite d WHERE d."entityType" = 'Troncon' AND d."entityId" = t.id AND d.champ = 'longueurKm' AND d.statut = 'DERIVED')) AS connu,
             EXISTS (SELECT 1 FROM valeurs_qualite o WHERE o."entityType" = 'Troncon' AND o."entityId" = t.id AND o.champ = 'etat' AND o.statut = 'OBSERVED' AND o."observedAt" IS NOT NULL) AS constate,
             COALESCE(t."statutValidation"::text, '') IN ('REJETE', 'A_CORRIGER') AS rejete
        FROM troncons t
       WHERE t."deletedAt" IS NULL
         AND NOT starts_with(COALESCE(t."sourceReference", ''), 'voirie_locale:')
         AND NOT starts_with(COALESCE(t."sourceReference", ''), 'hors_territoire:')
         AND ($1::int[] IS NULL OR t."regionId" = ANY($1::int[]))
         AND ($2::text[] IS NULL OR t.classe::text = ANY($2::text[])))
    SELECT count(*)::int AS troncons,
           count(*) FILTER (WHERE NOT connu)::int AS sans_longueur,
           COALESCE(SUM(km) FILTER (WHERE connu), 0)::float8 AS connu_km,
           COALESCE(SUM(km) FILTER (WHERE connu AND etat <> 'NON_EVALUE' AND constate AND NOT rejete), 0)::float8 AS eligible_km,
           COALESCE(SUM(km) FILTER (WHERE connu AND etat IN ('MAUVAIS','CRITIQUE') AND constate AND NOT rejete), 0)::float8 AS degrade_km,
           COALESCE(SUM(km) FILTER (WHERE connu AND etat = 'CRITIQUE' AND constate AND NOT rejete), 0)::float8 AS critique_km,
           COALESCE(SUM(km) FILTER (WHERE connu AND etat = 'NON_EVALUE'), 0)::float8 AS nonevalue_km,
           count(*) FILTER (WHERE etat = 'NON_EVALUE')::int AS nonevalue_n,
           count(*) FILTER (WHERE etat <> 'NON_EVALUE' AND NOT (constate AND NOT rejete))::int AS nonvalide_n,
           COALESCE(SUM(km) FILTER (WHERE connu AND etat <> 'NON_EVALUE' AND NOT (constate AND NOT rejete)), 0)::float8 AS nonvalide_km
      FROM p`, regions, classes))[0];
  const pct1 = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
  const frac4 = (a: number, b: number) => (b > 0 ? Math.round((10000 * a) / b) / 10000 : null);

  /** Marches dans la portee, selon l'oracle : regions de leurs chantiers non supprimes lues puis filtrees cote JS. */
  const oracleMarches = async (regions: number[] | null) => {
    const lignes = await sql<{ id: string; devise: string; montant: string | null; regions: number[] | null }>(`
      SELECT m.id::text AS id, m.devise::text AS devise, m."montantTotal"::text AS montant,
             (SELECT array_agg(DISTINCT c."regionId") FROM marches_chantiers mc JOIN chantiers c ON c.id = mc."chantierId" AND c."deletedAt" IS NULL WHERE mc."marcheId" = m.id) AS regions
        FROM marches m WHERE m."deletedAt" IS NULL`);
    const dans = lignes.filter((m) => regions === null || (m.regions !== null && m.regions.length > 0 && m.regions.every((r) => regions.includes(Number(r)))));
    const gnf = dans.filter((m) => m.devise === "GNF" && m.montant !== null);
    const decs = await sql<{ marche: string; montant: string; type: string; date: string | null }>(
      `SELECT d."marcheId"::text AS marche, d."montantGnf"::text AS montant, d.type::text AS type, d."datePaiement"::text AS date FROM decomptes d WHERE d."deletedAt" IS NULL AND d.statut = 'PAYE'`);
    const ids = new Set(dans.map((m) => m.id));
    const payes = decs.filter((d) => ids.has(d.marche));
    const emis = Number((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM decomptes d WHERE d."deletedAt" IS NULL AND d.statut = 'EMIS' AND d."marcheId"::text = ANY($1::text[])`, [...ids]))[0].n);
    return {
      marches: dans.length, sansMontant: dans.filter((m) => m.montant === null).length, horsGnf: dans.filter((m) => m.devise !== "GNF").length,
      contractuel: gnf.reduce((s, m) => s + BigInt(m.montant!), 0n).toString(),
      payes: payes.length, decaisse: payes.reduce((s, d) => s + BigInt(d.montant), 0n).toString(),
      payesSansDate: payes.filter((d) => d.date === null).length, retenue: payes.filter((d) => d.type === "RETENUE_GARANTIE").length, emis,
    };
  };

  // ============================================================================ empreinte des tables sources AVANT
  const TABLES = ["troncons", "valeurs_qualite", "regions", "chantiers", "marches", "marches_chantiers", "decomptes", "bailleurs", "programmes_budgetaires", "audit_logs", "users", "perimetres_comptes"];
  const empreinte = async () => {
    const e: Record<string, string> = {};
    for (const t of TABLES) {
      const r = (await sql<{ n: number; h: string }>(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS h FROM ${t} x`))[0];
      e[t] = `${r.n}:${r.h}`;
    }
    return e;
  };

  // Comptes reels pour la section HTTP : crees AVANT l'empreinte (ce sont des donnees de fixture, pas des ecritures du service).
  const COMPTES = [
    { id: "ad-admin", role: "ADMIN", modules: [] as string[], regions: [] as number[] },
    { id: "ad-lect", role: "LECTEUR", modules: ["decision"], regions: [] },
    { id: "ad-fin", role: "LECTEUR", modules: ["decision", "marches", "programmation"], regions: [] },
    { id: "ad-sans", role: "LECTEUR", modules: ["dashboard", "marches"], regions: [] },
    { id: "ad-g1", role: "GESTIONNAIRE", modules: ["decision", "marches", "programmation"], regions: [R1] },
    { id: "ad-g12", role: "GESTIONNAIRE", modules: ["decision", "marches", "programmation"], regions: [R1, R2] },
  ];
  for (const c of COMPTES) {
    await exec(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "modulesAutorises", "updatedAt") VALUES ($1, $2, $1, 'x', $3::"Role", $4::text[], now())`, c.id, `${c.id}@x.invalid`, c.role, `{${c.modules.join(",")}}`);
    for (const r of c.regions) await exec(`INSERT INTO perimetres_comptes ("userId","regionId","accordeParId") VALUES ($1,$2,'u-ad')`, c.id, r);
  }
  let avant = await empreinte();

  // ============================================================================ 1. registre sans la valeur NaN
  const portee = (regions: number[] | null) => ({ regions, maintenant: NOW });
  const reg = (code: string) => REGISTRE.find((d: { code: string }) => d.code === code);
  const metierAvantNaN = await reg("longueur_metier_km").calcul(prisma, portee(null));
  // t05 (100) + t06 (40) + t07 (30) + t13 (8) + t15 (25) + t16 (9) + valides 62 = 274 en region 1 ; + 234 en region 2 = 508 (t08 = 0, t09 derive : exclus).
  verifier("registre : longueur_metier_km = 508 (egal a la longueur connue de la synthese)", proche(metierAvantNaN, 508, 0.011), metierAvantNaN);

  // ============================================================================ 2. trois accords, cinq portees
  await insererTroncon(T17);
  avant = await empreinte(); // la fixture NaN fait partie de l'etat de depart : l'empreinte est reprise apres son insertion
  const metierAvecNaN = await reg("longueur_metier_km").calcul(prisma, portee(null));
  console.log(`  CONSTAT  registre.longueur_metier_km (indicateurs.registre.ts) avec UN troncon a longueurKm = NaN rend ${metierAvecNaN} km au lieu de 508 : le NaN empoisonne la somme, qui revient null et se lit 0 (un inconnu rendu comme un zero). La synthese ecarte ce troncon (longueur inconnue) et reste a 508.`);

  const droits = { marches: true, programmation: true };
  const syntheses: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  const kpi = (s: any, code: string) => s.kpis.find((k: { code: string }) => k.code === code); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [nom, regions] of PORTEES) {
    const s = await composerSynthese(depotPrisma(prisma), { regions, maintenant: NOW, filtres: {}, droits });
    syntheses[nom] = s;
    const a = ETAT[nom];
    const o = await oracleEtat(regions);

    // -- etat du reseau : main = oracle = service
    const attendu = a;
    verifier(`${nom} reseau_degrade_pct : main ${attendu.degrade} = oracle ${pct1(o.degrade_km, o.eligible_km)} = service ${kpi(s, "reseau_degrade_pct").valeur}`,
      kpi(s, "reseau_degrade_pct").valeur === attendu.degrade && pct1(o.degrade_km, o.eligible_km) === attendu.degrade, kpi(s, "reseau_degrade_pct"));
    verifier(`${nom} reseau_critique_pct : main ${attendu.critiquePct} = oracle = service`,
      kpi(s, "reseau_critique_pct").valeur === attendu.critiquePct && pct1(o.critique_km, o.eligible_km) === attendu.critiquePct, kpi(s, "reseau_critique_pct").valeur);
    verifier(`${nom} reseau_critique_km : main ${attendu.critiqueKm} = oracle ${o.critique_km > 0 || attendu.eligible > 0 ? o.critique_km : null} = service`,
      kpi(s, "reseau_critique_km").valeur === attendu.critiqueKm && (attendu.critiqueKm === null || proche(o.critique_km, attendu.critiqueKm, 1e-9)), kpi(s, "reseau_critique_km").valeur);
    verifier(`${nom} longueur_reseau_reference_km : main ${attendu.longueurRef} = oracle ${o.connu_km} = service`,
      kpi(s, "longueur_reseau_reference_km").valeur === attendu.longueurRef && (attendu.longueurRef === null ? o.connu_km === 0 : proche(o.connu_km, attendu.longueurRef, 1e-9)), kpi(s, "longueur_reseau_reference_km").valeur);
    verifier(`${nom} couverture_etat_part : main ${attendu.couvEtat} = oracle ${frac4(o.eligible_km, o.connu_km)} = service`,
      kpi(s, "couverture_etat_part").valeur === attendu.couvEtat && frac4(o.eligible_km, o.connu_km) === attendu.couvEtat, kpi(s, "couverture_etat_part").valeur);
    verifier(`${nom} couverture : eligible ${attendu.eligible} km, evalue ${attendu.evalue} km, non evalue ${attendu.nonEvKm} km, part ${attendu.partNonEv} (main = oracle = service)`,
      s.couverture.eligibleKm === attendu.eligible && s.couverture.evalueKm === attendu.evalue && s.couverture.nonEvalueKm === attendu.nonEvKm && s.couverture.partNonEvaluee === attendu.partNonEv
      && proche(o.eligible_km, attendu.eligible, 1e-9) && proche(o.eligible_km + o.nonvalide_km, attendu.evalue, 1e-9) && proche(o.nonevalue_km, attendu.nonEvKm, 1e-9) && frac4(o.nonevalue_km, o.connu_km) === attendu.partNonEv, s.couverture);
    verifier(`${nom} troncons : ${attendu.troncons} dont ${attendu.sansLongueur} sans longueur, ${attendu.nonEvN} non evalues, ${attendu.nonValN} a etat non valide (main = oracle = service)`,
      s.couverture.tronconsTotal === attendu.troncons && s.couverture.tronconsSansLongueurMetier === attendu.sansLongueur && s.couverture.tronconsNonEvalues === attendu.nonEvN && s.couverture.tronconsEtatNonValide === attendu.nonValN
      && o.troncons === attendu.troncons && o.sans_longueur === attendu.sansLongueur && o.nonevalue_n === attendu.nonEvN && o.nonvalide_n === attendu.nonValN, s.couverture);
    verifier(`${nom} etat de l'indicateur : ${attendu.eligible === 0 ? "NON_DISPONIBLE, valeur nulle" : "PARTIEL"} ; jamais 0 pour un inconnu`,
      attendu.eligible === 0 ? kpi(s, "reseau_degrade_pct").etat === "NON_DISPONIBLE" && kpi(s, "reseau_degrade_pct").valeur === null : kpi(s, "reseau_degrade_pct").etat === "PARTIEL", kpi(s, "reseau_degrade_pct").etat);
    verifier(`${nom} pourcentages entre 0 et 100, jamais NaN`, s.kpis.filter((k: { unite: string }) => k.unite === "%").every((k: { valeur: number | null }) => k.valeur === null || (k.valeur >= 0 && k.valeur <= 100)), null);

    // -- chantiers, marches, montants : main = oracle = service
    const f = FIN[nom];
    verifier(`${nom} chantiers_en_cours ${f.chantiersEnCours} et chantiers_en_retard ${f.chantiersEnRetard} (main = service ; sans plafond, somme des chantiers jamais lue)`,
      kpi(s, "chantiers_en_cours").valeur === f.chantiersEnCours && kpi(s, "chantiers_en_retard").valeur === f.chantiersEnRetard, [kpi(s, "chantiers_en_cours").valeur, kpi(s, "chantiers_en_retard").valeur]);
    const om = await oracleMarches(regions);
    verifier(`${nom} marches_recenses : main ${f.marches} = oracle ${om.marches} = service (lignes de marches, pas de chantiers)`,
      (kpi(s, "marches_recenses").valeur ?? null) === (f.marches === 0 ? null : f.marches) && (f.marches === null ? om.marches === 0 : om.marches === f.marches), kpi(s, "marches_recenses"));
    verifier(`${nom} budget contractuel : main ${f.contractuel} = oracle ${om.contractuel} = service ${s.budget.contractuel.valeurGnf} (chaine exacte)`,
      (f.contractuel === null ? s.budget.contractuel.valeurGnf === null && om.marches === 0 : s.budget.contractuel.valeurGnf === f.contractuel && om.contractuel === f.contractuel), s.budget.contractuel);
    verifier(`${nom} budget contractuel : ${f.sansMontant} marche(s) sans montant et ${f.horsGnf} en devise etrangere comptes a part (oracle ${om.sansMontant}/${om.horsGnf})`,
      om.sansMontant === f.sansMontant && om.horsGnf === f.horsGnf
      && (f.contractuel === null || ((f.sansMontant > 0) === /sans montant/.test(s.budget.contractuel.avertissement ?? "") && (f.horsGnf > 0) === /devise étrangère/.test(s.budget.contractuel.avertissement ?? ""))), s.budget.contractuel);
    verifier(`${nom} budget decaisse : main ${f.decaisse} = oracle ${om.decaisse === "0" && om.payes === 0 ? null : om.decaisse} = service ${s.budget.decaisse.valeurGnf} (${f.payes} decomptes payes)`,
      f.decaisse === null ? s.budget.decaisse.valeurGnf === null && om.payes === 0 : s.budget.decaisse.valeurGnf === f.decaisse && om.decaisse === f.decaisse && om.payes === f.payes, s.budget.decaisse);
    verifier(`${nom} decomptes : ${f.payesSansDate} paye(s) sans date, ${f.retenue} retenue(s) de garantie, ${f.emis} emis non paye(s) (main = oracle = service)`,
      om.payesSansDate === f.payesSansDate && om.retenue === f.retenue && om.emis === f.emis
      && (f.payes === 0 || ((f.payesSansDate > 0) === /sans date de paiement/.test(s.budget.decaisse.avertissement ?? "") && (f.retenue > 0) === /retenue de garantie/.test(s.budget.decaisse.avertissement ?? "") && (f.emis > 0) === /émis non payé/.test(s.budget.decaisse.avertissement ?? ""))), s.budget.decaisse);
    verifier(`${nom} budget previsionnel : main ${f.previsionnel} = service ${s.budget.previsionnel.valeurGnf} (RETENU seulement, supprime et propose ecartes)`,
      s.budget.previsionnel.valeurGnf === f.previsionnel, s.budget.previsionnel);
    verifier(`${nom} budget engage : NON_DISPONIBLE, valeur nulle, raison B-08 / ADR-003 ; ni la somme des chantiers ni celle des marches`,
      s.budget.engage.etat === "NON_DISPONIBLE" && s.budget.engage.valeurGnf === null && /B-08, ADR-003/.test(s.budget.engage.avertissement) && kpi(s, "budget_engage_gnf").valeur === null, s.budget.engage);
  }
  verifier("aucun montant de chantier (1 000 milliards et plus) ne figure dans une reponse : la somme des chantiers n'est jamais lue",
    !JSON.stringify(Object.values(syntheses)).includes("21000000000000") && !JSON.stringify(Object.values(syntheses)).includes("1000000000000"), null);

  // -- fraicheur
  const age = (iso: string) => Math.floor((NOW.getTime() - new Date(iso).getTime()) / 86_400_000);
  verifier("fraicheur pays : derniere evaluation 20/10/2026 (t20 ; t05, non valide, ecarte), plus ancienne 01/03/2024, age 6 jours",
    syntheses.pays.fraicheur.derniereEvaluationLe === "2026-10-20T00:00:00.000Z" && syntheses.pays.fraicheur.plusAncienneEvaluationLe === "2024-03-01T00:00:00.000Z" && syntheses.pays.fraicheur.ageJours === age("2026-10-20T00:00:00Z"), syntheses.pays.fraicheur);
  verifier("fraicheur region 1 : derniere 01/10/2026, plus ancienne 01/12/2025, age 25 jours",
    syntheses.r1.fraicheur.derniereEvaluationLe === "2026-10-01T00:00:00.000Z" && syntheses.r1.fraicheur.plusAncienneEvaluationLe === "2025-12-01T00:00:00.000Z" && syntheses.r1.fraicheur.ageJours === 25, syntheses.r1.fraicheur);
  verifier("fraicheur region vide : aucune date, age nul (jamais 0)", syntheses.r3.fraicheur.ageJours === null && syntheses.r3.fraicheur.derniereEvaluationLe === null, syntheses.r3.fraicheur);

  // -- repartition de l'etat et degradation par region
  const rep = syntheses.pays.repartitionEtat;
  verifier("repartition pays : BON 182 km (4 troncons), MOYEN 15 (1), MAUVAIS 10 (3 dont 2 sans longueur), CRITIQUE 65 (3 dont 1 sans longueur) ; parts 66,9 / 5,5 / 3,7 / 23,9",
    JSON.stringify(rep.classes.map((c: any) => [c.classe, c.km, c.troncons, c.partPct])) === JSON.stringify([["BON", 182, 4, 66.9], ["MOYEN", 15, 1, 5.5], ["MAUVAIS", 10, 3, 3.7], ["CRITIQUE", 65, 3, 23.9]]), rep.classes); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("repartition pays : non evalue 50 km (2 troncons) et etat non valide 186 km (6 troncons : 4 importes/sans ligne, 1 rejete, 1 en conflit, 1 sans date) a part",
    rep.nonEvalue.km === 50 && rep.nonEvalue.troncons === 2 && rep.etatNonValide.km === 186 && rep.etatNonValide.troncons === 6
    && JSON.stringify(rep.etatNonValide.parMotif) === JSON.stringify({
      CONSTAT_SANS_DATE: { km: 9, troncons: 1 }, ETAT_EN_CONFLIT: { km: 25, troncons: 1 }, ETAT_NON_CONSTATE: { km: 144, troncons: 3 }, TRONCON_REJETE_OU_A_CORRIGER: { km: 8, troncons: 1 },
    }), rep.etatNonValide);
  verifier("degradation par region : region 1 = 24,2 % (15 sur 62 km), region 2 = 28,6 % (60 sur 210 km) ; aucun champ « score » ni « priorite »",
    JSON.stringify(syntheses.pays.degradationParRegion.regions.map((r: any) => [r.regionNom, r.partDegradeePct, r.degradeKm, r.eligibleKm])) === JSON.stringify([["Region AD1", 24.2, 15, 62], ["Region AD2", 28.6, 60, 210]]) // eslint-disable-line @typescript-eslint/no-explicit-any
    && !/score|priorite/i.test(Object.keys(syntheses.pays.degradationParRegion.regions[0]).join(",")), syntheses.pays.degradationParRegion);

  // -- parBailleur : oracle ecrit a part (groupement cote JS)
  {
    const lignes = await sql<{ id: number | null; devise: string; montant: string | null }>(`SELECT "bailleurId" AS id, devise::text AS devise, "montantTotal"::text AS montant FROM marches WHERE "deletedAt" IS NULL`);
    const parB = new Map<string, { nb: number; gnf: bigint }>();
    for (const l of lignes) { const k = String(l.id); const g = parB.get(k) ?? { nb: 0, gnf: 0n }; g.nb++; if (l.devise === "GNF" && l.montant !== null) g.gnf += BigInt(l.montant); parB.set(k, g); }
    const attendu = [...parB.entries()].sort((a, b) => (b[1].gnf > a[1].gnf ? 1 : -1)).map(([k, g]) => [k === "null" ? null : Number(k), g.nb, g.gnf.toString()]);
    const rendu = syntheses.pays.budget.parBailleur.lignes.map((l: any) => [l.bailleurId, l.marches, l.contractuelGnf]); // eslint-disable-line @typescript-eslint/no-explicit-any
    verifier("parBailleur (pays) : par marches.bailleurId, ordre des plus gros contractuels : B 9 007 199 254 744 993 (3 marches), A 3 300 (4), sans bailleur 500 (1) ; oracle = service",
      JSON.stringify(rendu) === JSON.stringify(attendu) && rendu[0][2] === "9007199254744993" && rendu[1][2] === "3300" && rendu[2][2] === "500", { rendu, attendu });
    const dec: Record<string, string | null> = Object.fromEntries(syntheses.pays.budget.parBailleur.lignes.map((l: any) => [String(l.bailleurId), l.decaisseGnf])); // eslint-disable-line @typescript-eslint/no-explicit-any
    verifier("parBailleur (pays) : decaisse B = 300 + 9 007 199 254 740 000, A = 100 + 200, sans bailleur = 7 ; un bailleur sans paiement aurait null, jamais 0",
      dec[String(bailleurB)] === "9007199254740300" && dec[String(bailleurA)] === "300" && dec["null"] === "7", dec);
    const tronque = await lireParBailleur(prisma, null, 2);
    verifier("parBailleur : limite 2 sur 3 bailleurs -> 2 lignes et totalBailleurs 3 (le service en tire « tronque » et « autres »)", tronque.lignes.length === 2 && tronque.totalBailleurs === 3, tronque);
    const sTronque = await composerSynthese(depotPrisma(prisma), { regions: null, maintenant: NOW, filtres: {}, droits, parametres: { ...(await banc.imp("aide-decision/kpi.noyau")).PARAMETRES_KPI, limiteBailleurs: 2 } });
    const pb = sTronque.budget.parBailleur;
    verifier("parBailleur tronque : message explicite, 1 autre bailleur, 1 marche, 500 GNF agreges (total 9 007 199 254 748 793 moins les deux premiers)",
      pb.tronque === true && /Liste limitée aux 2 bailleurs/.test(pb.message) && pb.autres.bailleurs === 1 && pb.autres.marches === 1 && pb.autres.contractuelGnf === "500", pb);
    const pbR1 = syntheses.r1.budget.parBailleur.lignes;
    verifier("parBailleur (region 1) : seulement A (m1 m2 m6 : 3 marches, 3 000 GNF, 1 en USD), decaisse 300", pbR1.length === 1 && pbR1[0].bailleurId === bailleurA && pbR1[0].marches === 3 && pbR1[0].contractuelGnf === "3000" && pbR1[0].marchesHorsGnf === 1 && pbR1[0].decaisseGnf === "300", pbR1);
  }

  // -- qualite : detecteurs reels sur les fixtures
  {
    const q = syntheses.pays.qualite;
    const total = (await composerQualite(depotPrisma(prisma), { regions: null, maintenant: NOW, regionDemandee: null, filtresNonAppliques: [] }));
    const code = (c: string) => total.detecteurs.parCode.find((x: { code: string }) => x.code === c)?.nombre ?? 0;
    const o = (await sql<{ geom_absente: number; non_evalue: number; longueur: number }>(`
      SELECT count(*) FILTER (WHERE geom IS NULL)::int AS geom_absente,
             count(*) FILTER (WHERE etat = 'NON_EVALUE')::int AS non_evalue,
             count(*) FILTER (WHERE NOT ("longueurKm" > 0 AND "longueurKm" < 'Infinity'::float8))::int AS longueur
        FROM troncons WHERE "deletedAt" IS NULL AND NOT starts_with(COALESCE("sourceReference",''),'voirie_locale:') AND NOT starts_with(COALESCE("sourceReference",''),'hors_territoire:')`))[0];
    verifier(`qualite : GEOM_ABSENTE ${code("GEOM_ABSENTE")} = oracle ${o.geom_absente} (19 troncons dont 2 ont un trace : 17 sans geometrie)`, code("GEOM_ABSENTE") === o.geom_absente && o.geom_absente === 17, [code("GEOM_ABSENTE"), o]);
    verifier(`qualite : ETAT_NON_EVALUE ${code("ETAT_NON_EVALUE")} = oracle ${o.non_evalue} = non evalues de la synthese`, code("ETAT_NON_EVALUE") === o.non_evalue && o.non_evalue === ETAT.pays.nonEvN, [code("ETAT_NON_EVALUE"), o]);
    verifier(`qualite : LONGUEUR_NON_POSITIVE ${code("LONGUEUR_NON_POSITIVE")} = oracle ${o.longueur} (t08 nulle, t17 NaN)`, code("LONGUEUR_NON_POSITIVE") === o.longueur && o.longueur === 2, [code("LONGUEUR_NON_POSITIVE"), o]);
    verifier("qualite : la famille REGION n'est pas executee faute de limite administrative en base, et le dit (jamais « zero anomalie »)",
      JSON.stringify(total.detecteurs.famillesNonExecutees) === JSON.stringify(["REGION"]) && !total.detecteurs.codesSansAnomalie.includes("HORS_TERRITOIRE") && total.detecteurs.etat === "PARTIEL", total.detecteurs.famillesNonExecutees);
    // La synthese n'execute que PK, LONGUEUR, GEOMETRIE et ETAT : son nombre est celui de ces familles. /qualite execute les six.
    const FAMILLES_RAPIDES = ["PK", "LONGUEUR", "GEOMETRIE", "ETAT"];
    const horsNonEvalue = (familles: string[]) => total.detecteurs.parCode.filter((c: { code: string; famille: string }) => familles.includes(c.famille) && !["ETAT_NON_EVALUE", "ETAT_ABSENT", "ETAT_INCONNU"].includes(c.code)).reduce((s: number, c: { nombre: number }) => s + c.nombre, 0);
    verifier(`donnees_a_confirmer (synthese, 4 familles) : ${kpi(syntheses.pays, "donnees_a_confirmer").valeur} = non evalues ${ETAT.pays.nonEvN} + anomalies des familles rapides hors « non evalue » ${horsNonEvalue(FAMILLES_RAPIDES)} ; PARTIEL (REGION, DOUBLON non executees)`,
      kpi(syntheses.pays, "donnees_a_confirmer").valeur === ETAT.pays.nonEvN + horsNonEvalue(FAMILLES_RAPIDES) && kpi(syntheses.pays, "donnees_a_confirmer").etat === "PARTIEL"
      && JSON.stringify(q.famillesNonExecutees) === JSON.stringify(["REGION", "DOUBLON"]), [kpi(syntheses.pays, "donnees_a_confirmer").valeur, horsNonEvalue(FAMILLES_RAPIDES)]);
    verifier(`donnees_a_confirmer (/qualite, six familles) : ${total.donneesAConfirmer.valeur} = non evalues ${ETAT.pays.nonEvN} + anomalies hors « non evalue » ${horsNonEvalue(["PK", "LONGUEUR", "GEOMETRIE", "REGION", "DOUBLON", "ETAT"])}`,
      total.donneesAConfirmer.valeur === ETAT.pays.nonEvN + horsNonEvalue(["PK", "LONGUEUR", "GEOMETRIE", "REGION", "DOUBLON", "ETAT"]), total.donneesAConfirmer);
    verifier("qualite : aucune liste d'entites (plafond 0) -> aucun identifiant de troncon dans la reponse", !/ad-t\d\d/.test(JSON.stringify(total)), null);
    const cr = total.couvertureParRegion.map((c: any) => [c.regionNom, c.troncons, c.tronconsNonEvalues, c.tauxNonEvalues]); // eslint-disable-line @typescript-eslint/no-explicit-any
    verifier("qualite : couverture et taux de non evalues par region : AD1 14 troncons / 1 non evalue (0,0714), AD2 5 / 1 (0,2), AD3 vide 0 troncon et taux nul (un trou de couverture est dit)",
      JSON.stringify(cr) === JSON.stringify([["Region AD1", 14, 1, 0.0714], ["Region AD2", 5, 1, 0.2], ["Region AD3 vide", 0, 0, null]]), cr);
    verifier("qualite : ce que les detecteurs ne couvrent pas est liste (contradictions inter-sources, source, date de mesure, associations marche-chantier)",
      /Contradictions entre le referentiel/.test(total.nonCouvert.join(" ")) && /Associations marche-chantier-troncon/.test(total.nonCouvert.join(" ")), null);
    const q1 = await composerQualite(depotPrisma(prisma), { regions: [R1], maintenant: NOW, regionDemandee: R1, filtresNonAppliques: [] });
    verifier("qualite region 1 : couverture de la region 1 seulement, detecteurs lances pour cette region", q1.couvertureParRegion.length === 1 && q1.couvertureParRegion[0].regionId === R1 && q1.detecteurs.population === 14, q1.couvertureParRegion);
  }

  // -- le service est mathematiquement coherent avec l'agregation pure rejouee sur les lignes lues
  {
    const lignes = await lireEtatReseau(prisma, null, null);
    const ind = indicateursReseau(agregerEtat(lignes).total);
    verifier(`lireEtatReseau : ${lignes.length} groupes (et non ${ETAT.pays.troncons} troncons) suffisent a reconstruire le taux : ${ind.degradePct}`, lignes.length < ETAT.pays.troncons && ind.degradePct === ETAT.pays.degrade, lignes.length);
  }

  // ============================================================================ 3. filtres de classe : meme perimetre au numerateur et au denominateur
  for (const [classes, attendu] of [[["RR"], { degrade: 0, eligible: 35 }], [["NON_CLASSEE"], { degrade: 0, eligible: 10 }], [["RN"], null], [["RN", "RR", "RU", "PISTE", "NON_CLASSEE"], null]] as const) {
    const s = await composerSynthese(depotPrisma(prisma), { regions: null, maintenant: NOW, filtres: { classe: [...classes] }, droits });
    const o = await oracleEtat(null, [...classes]);
    verifier(`filtre classe ${classes.join("+")} : degrade ${pct1(o.degrade_km, o.eligible_km)} % sur ${o.eligible_km} km (oracle = service)${attendu ? `, main ${attendu.degrade} % sur ${attendu.eligible} km` : ""}`,
      kpi(s, "reseau_degrade_pct").valeur === pct1(o.degrade_km, o.eligible_km) && s.couverture.eligibleKm === o.eligible_km && (!attendu || (o.eligible_km === attendu.eligible && pct1(o.degrade_km, o.eligible_km) === attendu.degrade)), kpi(s, "reseau_degrade_pct").valeur);
    verifier(`filtre classe ${classes.join("+")} : longueur geometrique NON_DISPONIBLE (non ventilee par classe), filtre rendu`, kpi(s, "longueur_geometrique_km").etat === "NON_DISPONIBLE" && JSON.stringify(s.filtres.appliques.classe) === JSON.stringify([...classes]), kpi(s, "longueur_geometrique_km").etat);
  }
  {
    const s = await composerSynthese(depotPrisma(prisma), { regions: null, maintenant: NOW, filtres: { classe: ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] }, droits });
    verifier("toutes les classes = aucun filtre : memes valeurs que le pays", kpi(s, "reseau_degrade_pct").valeur === ETAT.pays.degrade && s.couverture.eligibleKm === ETAT.pays.eligible, kpi(s, "reseau_degrade_pct").valeur);
  }

  // ============================================================================ 4. la longueur geometrique est celle du registre, et reste separee
  {
    const rad = (d: number) => (d * Math.PI) / 180;
    const arc = (phi1: number, phi2: number) => { const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f); const M = (d: number) => (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(rad(d)) ** 2, 1.5); const n = 2000, h = rad(phi2 - phi1) / n; let s = M(phi1) + M(phi2); for (let i = 1; i < n; i++) s += M(phi1 + (i * (phi2 - phi1)) / n) * (i % 2 ? 4 : 2); return (s * h) / 3; };
    const km = (v: number) => Math.round(v / 10) / 100; // metres -> km a 0,01
    verifier(`longueur_geometrique_km pays = ${km(arc(9.0, 9.01) + arc(10.0, 10.03))} (integrale du meridien, sans PostGIS) ; service ${kpi(syntheses.pays, "longueur_geometrique_km").valeur} ; differente de la longueur metier ${kpi(syntheses.pays, "longueur_reseau_reference_km").valeur}`,
      proche(kpi(syntheses.pays, "longueur_geometrique_km").valeur, km(arc(9.0, 9.01) + arc(10.0, 10.03)), 0.011) && kpi(syntheses.pays, "longueur_geometrique_km").valeur !== kpi(syntheses.pays, "longueur_reseau_reference_km").valeur, kpi(syntheses.pays, "longueur_geometrique_km").valeur);
    verifier("longueur geometrique region 3 (aucun troncon) : NON_DISPONIBLE, valeur nulle (jamais 0 km)", kpi(syntheses.r3, "longueur_geometrique_km").valeur === null && kpi(syntheses.r3, "longueur_geometrique_km").etat === "NON_DISPONIBLE", kpi(syntheses.r3, "longueur_geometrique_km"));
  }

  // ============================================================================ 5. comptes reels : routes montees derriere requireAuth / requireModuleAccess
  {
    const app = express();
    app.use("/api/v2/aide-decision", aideDecisionSyntheseRouter);
    app.use(errorHandler);
    const jeton = (id: string) => { const c = COMPTES.find((x) => x.id === id)!; return signAccessToken({ sub: c.id, role: c.role, email: `${c.id}@x.invalid` }); };
    const get = (id: string | null, url: string) => { let r = request(app).get(url); if (id) r = r.set("Authorization", `Bearer ${jeton(id)}`); return r as unknown as Promise<{ status: number; body: any; headers: Record<string, string> }>; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const S = "/api/v2/aide-decision/synthese";

    verifier("HTTP : anonyme 401, compte sans le module decision 403 (meme avec marches), jeton d'un compte inconnu 401",
      (await get(null, S)).status === 401 && (await get("ad-sans", S)).status === 403
      && (await (request(app).get(S).set("Authorization", `Bearer ${signAccessToken({ sub: "fantome", role: "ADMIN", email: "f@x.invalid" })}`) as unknown as Promise<{ status: number }>)).status === 401, null);
    const admin = await get("ad-admin", S);
    verifier("HTTP : ADMIN recoit le pays entier, memes valeurs que le service, montants en chaines", admin.status === 200 && admin.body.perimetre.national === true && admin.body.kpis.find((k: any) => k.code === "reseau_degrade_pct").valeur === 27.6 && admin.body.budget.contractuel.valeurGnf === "9007199254748793", admin.body.perimetre); // eslint-disable-line @typescript-eslint/no-explicit-any
    const g1 = await get("ad-g1", S);
    const texteG1 = JSON.stringify(g1.body);
    verifier("HTTP : GESTIONNAIRE regional (region 1) : perimetre region 1, taux 24,2 %, contractuel 3 000 (PARTIEL), 3 marches ; aucun total national",
      g1.status === 200 && g1.body.perimetre.regionId === R1 && g1.body.perimetre.national === false && g1.body.kpis.find((k: any) => k.code === "reseau_degrade_pct").valeur === 24.2 // eslint-disable-line @typescript-eslint/no-explicit-any
      && g1.body.budget.contractuel.valeurGnf === "3000" && g1.body.budget.contractuel.etat === "PARTIEL" && g1.body.kpis.find((k: any) => k.code === "marches_recenses").valeur === 3, g1.body.perimetre); // eslint-disable-line @typescript-eslint/no-explicit-any
    verifier("HTTP : la reponse du compte regional ne contient ni la region 2, ni ses troncons, ni les montants nationaux (9 007 199 254 748 793, 4000, 9 007 199 254 740 993)",
      !/Region AD2|Region AD3|ad-t2|9007199254748793|9007199254740993|"4000"/.test(texteG1) && g1.body.degradationParRegion.regions.length === 1 && g1.body.qualite.couvertureParRegion.length === 1, texteG1.slice(0, 200));
    const hors = await get("ad-g1", `${S}?regionId=${R2}`);
    const inexistant = await get("ad-admin", `${S}?regionId=987654`);
    verifier("HTTP : region hors perimetre et region inexistante : exactement le meme 404", hors.status === 404 && inexistant.status === 404 && JSON.stringify(hors.body) === JSON.stringify(inexistant.body) && hors.body.code === "INTROUVABLE", [hors.body, inexistant.body]);
    const g12 = await get("ad-g12", S);
    const g12r2 = await get("ad-g12", `${S}?regionId=${R2}`);
    verifier("HTTP : compte a deux regions : « Regions du perimetre » (jamais pays), taux 27,6 % ; filtre region 2 : 28,6 %",
      g12.body.perimetre.regionId === null && /^Régions du périmètre : Region AD1, Region AD2$/.test(g12.body.perimetre.libelle) && g12.body.kpis.find((k: any) => k.code === "reseau_degrade_pct").valeur === 27.6 // eslint-disable-line @typescript-eslint/no-explicit-any
      && g12r2.body.perimetre.regionId === R2 && g12r2.body.kpis.find((k: any) => k.code === "reseau_degrade_pct").valeur === 28.6, g12.body.perimetre); // eslint-disable-line @typescript-eslint/no-explicit-any
    const lect = await get("ad-lect", S);
    verifier("HTTP : lecteur avec le seul module decision : indicateurs d'etat servis, MONTANTS NON_AUTORISE (contractuel, decaisse, previsionnel, bailleurs), aucun montant dans la reponse",
      lect.status === 200 && lect.body.kpis.find((k: any) => k.code === "reseau_degrade_pct").valeur === 27.6 && lect.body.budget.contractuel.etat === "NON_AUTORISE" // eslint-disable-line @typescript-eslint/no-explicit-any
      && lect.body.budget.decaisse.etat === "NON_AUTORISE" && lect.body.budget.previsionnel.etat === "NON_AUTORISE" && lect.body.budget.parBailleur.etat === "NON_AUTORISE" && !/9007199254|"4000"|"3300"/.test(JSON.stringify(lect.body)), lect.body.budget.contractuel);
    const fin = await get("ad-fin", S);
    verifier("HTTP : lecteur avec marches et programmation : montants servis", fin.status === 200 && fin.body.budget.contractuel.valeurGnf === "9007199254748793" && fin.body.budget.previsionnel.valeurGnf === "9007199254741503", fin.body.budget.contractuel);
    const hostiles = ["?regionId=abc", "?classe=AUTOROUTE", "?classe[a]=b", "?depuis=2026-02-30", "?inconnu=1", "?regionId=1&regionId=2", `?classe=${"R".repeat(400)}`, "?depuis=2026-01-01'%3B%20DROP%20TABLE%20troncons%3B--", "?regionId=-1", "?statutChantier=ANNULE"];
    const reps = await Promise.all(hostiles.map((q) => get("ad-admin", `${S}${q}`)));
    verifier(`HTTP : ${hostiles.length} entrees hostiles -> 400 { error, code: FILTRE_INVALIDE }, jamais 500`, reps.every((r) => r.status === 400 && r.body.code === "FILTRE_INVALIDE" && typeof r.body.error === "string"), reps.map((r) => r.status));
    const dict = await get("ad-lect", "/api/v2/aide-decision/dictionnaire");
    const qual = await get("ad-g1", "/api/v2/aide-decision/qualite");
    const qualHors = await get("ad-g1", `/api/v2/aide-decision/qualite?regionId=${R2}`);
    verifier("HTTP : dictionnaire (PROVISOIRE) et qualite servis ; qualite d'un compte regional limitee a sa region ; qualite d'une region hors perimetre = meme 404",
      dict.status === 200 && dict.body.statutDefinition === "PROVISOIRE" && qual.status === 200 && qual.body.couvertureParRegion.length === 1 && qualHors.status === 404 && JSON.stringify(qualHors.body) === JSON.stringify(inexistant.body), qual.body.perimetre);
    verifier("HTTP : Cache-Control no-store", admin.headers["cache-control"] === "no-store", admin.headers["cache-control"]);
  }

  // ============================================================================ 6. contre-epreuves : le banc voit les defauts qu'il est cense voir
  {
    // (a) La formule HERITEE de /api/dashboard/decision : numerateur sur TOUS les troncons non supprimes, denominateur sur le reseau classe.
    const h = (await sql<{ num: number; den: number }>(`
      SELECT (SELECT COALESCE(SUM("longueurKm"),0) FROM troncons WHERE "deletedAt" IS NULL AND etat IN ('MAUVAIS','CRITIQUE') AND "longueurKm" <> 'NaN')::float8 AS num,
             (SELECT COALESCE(SUM("longueurKm"),0) FROM troncons WHERE "deletedAt" IS NULL AND ("sourceReference" IS NULL OR NOT ("sourceReference" LIKE 'voirie_locale:%' OR "sourceReference" LIKE 'hors_territoire:%')) AND "longueurKm" <> 'NaN')::float8 AS den`))[0];
    verifier(`contre-epreuve : la formule heritee donne ${(100 * h.num / h.den).toFixed(1)} % (> 100 %) sur ces fixtures ; la synthese donne ${syntheses.pays.kpis[0].valeur} %`, h.num / h.den > 1 && syntheses.pays.kpis[0].valeur <= 100, h);
    // (b) Une voirie promue qui entrerait dans le perimetre fausse le taux : transaction annulee.
    const ROLLBACK = new Error("ROLLBACK_VOULU");
    let fausse: number | null = null;
    await prisma.$transaction(async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      await tx.$executeRawUnsafe(`UPDATE troncons SET "sourceReference" = NULL WHERE id = 'ad-t10'`);
      fausse = indicateursReseau(agregerEtat(await lireEtatReseau(tx, null, null)).total).degradePct;
      throw ROLLBACK;
    }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
    verifier(`contre-epreuve : si la voirie promue (t10, 500 km critiques constates) entrait dans le perimetre, le taux passerait de 27,6 a ${fausse} % ; la base annulee la rend a ${ETAT.pays.degrade} %`,
      fausse !== null && fausse !== ETAT.pays.degrade && (await sql<{ s: string | null }>(`SELECT "sourceReference" AS s FROM troncons WHERE id='ad-t10'`))[0].s === "voirie_locale:x", fausse);
    // (c) Une provenance elargie change le taux : la regle d'etat valide est bien lue.
    const souple = { ...(await banc.imp("aide-decision/kpi.noyau")).PARAMETRES_KPI, exigenceEtat: "NON_CONTESTE" };
    const lignes = await lireEtatReseau(prisma, null, null);
    const avecSouple = indicateursReseau(agregerEtat(lignes, souple).total, souple).degradePct;
    verifier(`contre-epreuve : avec l'exigence NON_CONTESTE (importe accepte), le meme jeu donne ${avecSouple} % au lieu de 27,6 % : la regle d'etat valide est un parametre lu, pas un detail`, avecSouple !== null && avecSouple !== ETAT.pays.degrade, avecSouple);
  }

  // ============================================================================ 7. aucune ecriture
  {
    const apres = await empreinte();
    const diff = Object.keys(avant).filter((t) => avant[t] !== apres[t]);
    verifier(`aucune ecriture : empreinte md5 de ${TABLES.length} tables sources identique avant et apres (${TABLES.join(", ")})`, diff.length === 0, diff);
    const ecritures = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs`);
    verifier("aucune ecriture : audit_logs vide (une lecture n'est pas une ecriture du patrimoine)", Number(ecritures[0].n) === 0, ecritures);
  }

  // ============================================================================ 8. VOLUME
  {
    const duree = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t0 = performance.now(); const r = await f(); return [r, Math.round(performance.now() - t0)]; };
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const rep = async (n: number, f: () => Promise<unknown>) => { const t: number[] = []; for (let i = 0; i < n; i++) t.push((await duree(f))[1]); return t; };
    const compte = async (t: string, w = "true") => Number((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE ${w}`))[0].n);
    const { lancerEnLectureSeule } = await banc.imp("qualite/detecteurs.service");
    const { FAMILLES_SYNTHESE } = await banc.imp("aide-decision/qualite");
    const lancer = (familles: string[], regionId: number | null = null) => lancerEnLectureSeule(prisma, { portee: { regionId, reseau: "reference" }, familles, plafondParCode: 0, maintenant: NOW });
    const PERIMETRE = `"deletedAt" IS NULL AND NOT starts_with(COALESCE("sourceReference",''),'voirie_locale:') AND NOT starts_with(COALESCE("sourceReference",''),'hors_territoire:')`;

    // Deux limites administratives de niveau 1 (une par region) : sans elles la famille REGION des detecteurs ne s'execute pas.
    await exec(`INSERT INTO limites_admin (pcode, niveau, nom, source, geom) VALUES
      ('AD-1', 1, 'Region AD1', 'banc', ST_Multi(ST_GeomFromText('POLYGON((-15 7,-11 7,-11 12,-15 12,-15 7))', 4326))),
      ('AD-2', 1, 'Region AD2', 'banc', ST_Multi(ST_GeomFromText('POLYGON((-11 7,-8 7,-8 12,-11 12,-11 7))', 4326)))`);

    /** Genere les troncons g = de..a (7 % de voirie promue, 20 % de longueurs nulles, un etat sur cinq non evalue, 60 % de lignes de provenance). */
    const genererTroncons = async (de: number, a: number) => {
      await exec(`
        INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", geom, "sourceReference", "dateDerniereEvaluation", "updatedAt")
        SELECT 'vol-' || g, 'VOL-' || g, 'Volume ' || g, (ARRAY['RN','RR','RU','PISTE'])[1 + g % 4]::"ClasseRoute", CASE WHEN g % 2 = 0 THEN ${R1} ELSE ${R2} END,
               CASE WHEN g % 10 = 0 THEN 0 ELSE 1 + (g % 50)::float8 / 10 END, 'BITUME', (ARRAY['BON','MOYEN','MAUVAIS','CRITIQUE','NON_EVALUE'])[1 + g % 5]::"EtatPatrimoine", 0, 1,
               ST_SetSRID(ST_MakeLine(ST_MakePoint((-14.0 + (g % 200) * 0.01)::float8, (8.0 + (g / 200) * 0.001)::float8), ST_MakePoint((-14.0 + (g % 200) * 0.01 + 0.004)::float8, (8.0 + (g / 200) * 0.001)::float8)), 4326),
               CASE WHEN g % 7 = 0 THEN 'voirie_locale:v' || g ELSE NULL END, CASE WHEN g % 3 = 0 THEN now() - ((g % 400) || ' days')::interval ELSE NULL END, now()
          FROM generate_series(${de}, ${a}) g`);
      await exec(`
        INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, "observedAt", "updatedAt")
        SELECT 'vq-vol-' || g, 'Troncon', 'vol-' || g, 'etat', (ARRAY['OBSERVED','IMPORTED_UNVERIFIED','CONFLICTING','UNKNOWN'])[1 + g % 4]::"StatutValeur", CASE WHEN g % 8 = 0 THEN NULL ELSE now() END, now()
          FROM generate_series(${de}, ${a}) g WHERE g % 5 < 3`);
      await exec(`
        INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, "updatedAt")
        SELECT 'vq-vol-lg-' || g, 'Troncon', 'vol-' || g, 'longueurKm', 'DERIVED'::"StatutValeur", now() FROM generate_series(${de}, ${a}) g WHERE g % 25 = 0`);
      await exec(`ANALYZE troncons`);
      await exec(`ANALYZE valeurs_qualite`);
    };

    /** Mesure et verifie l'accord avec l'oracle a un volume donne. */
    const mesurer = async (etiquette: string, grand: boolean) => {
      const nPerim = await compte("troncons", PERIMETRE);
      console.log(`\n--- volume [${etiquette}] : ${nPerim} troncons dans le perimetre (${await compte("troncons")} au registre, dont ${await compte("troncons", `"sourceReference" LIKE 'voirie_locale:%'`)} de voirie promue hors perimetre), ${await compte("valeurs_qualite")} lignes de qualite, ${await compte("chantiers")} chantiers, ${await compte("marches")} marches, ${await compte("decomptes")} decomptes ---`);
      const tEtat = await rep(3, () => lireEtatReseau(prisma, null, null));
      const [lignes] = await duree(() => lireEtatReseau(prisma, null, null));
      const tMarches = await rep(3, async () => { await lireMarches(prisma, null); await lireDecaisse(prisma, null); await lireParBailleur(prisma, null, 20); });
      const tMarchesR = await rep(3, async () => { await lireMarches(prisma, [R1]); await lireDecaisse(prisma, [R1]); await lireParBailleur(prisma, [R1], 20); });
      const tRegistre = await rep(2, () => depotPrisma(prisma).registre(["chantiers_en_cours", "chantiers_en_retard", "longueur_geometrique_km", "previsions_retenues_gnf", "previsions_retenues_nb"], null, NOW));
      const [, tRapide] = await duree(() => lancer([...FAMILLES_SYNTHESE]));
      const [, tRegion] = await duree(() => lancer(["REGION"]));
      const [, tDoublon] = await duree(() => lancer(["DOUBLON"]));
      const tSynthese = await rep(grand ? 2 : 3, () => composerSynthese(depotPrisma(prisma), { regions: null, maintenant: NOW, filtres: {}, droits }));
      const tSyntheseR = await rep(2, () => composerSynthese(depotPrisma(prisma), { regions: [R1], maintenant: NOW, filtres: {}, droits }));
      const [, tQualite] = await duree(() => composerQualite(depotPrisma(prisma), { regions: null, maintenant: NOW, regionDemandee: null, filtresNonAppliques: [] }));
      console.log(`  duree  lireEtatReseau (pays)                                   : ${tEtat.join(", ")} ms (mediane ${med(tEtat)} ms), ${lignes.length} groupes rendus`);
      console.log(`  duree  marches + decaisse + bailleurs (pays)                   : ${tMarches.join(", ")} ms (mediane ${med(tMarches)} ms)`);
      console.log(`  duree  marches + decaisse + bailleurs (region 1)               : ${tMarchesR.join(", ")} ms (mediane ${med(tMarchesR)} ms)`);
      console.log(`  duree  registre (5 indicateurs, pays)                          : ${tRegistre.join(", ")} ms (mediane ${med(tRegistre)} ms)`);
      console.log(`  duree  detecteurs, familles de la synthese (PK LONGUEUR GEOMETRIE ETAT) : ${tRapide} ms`);
      console.log(`  duree  detecteurs, famille REGION                              : ${tRegion} ms`);
      console.log(`  duree  detecteurs, famille DOUBLON                             : ${tDoublon} ms`);
      console.log(`  duree  SYNTHESE complete (pays)                                : ${tSynthese.join(", ")} ms (mediane ${med(tSynthese)} ms)`);
      console.log(`  duree  SYNTHESE complete (region 1)                            : ${tSyntheseR.join(", ")} ms (mediane ${med(tSyntheseR)} ms)`);
      console.log(`  duree  QUALITE complete (pays, six familles)                   : ${tQualite} ms`);

      // L'accord avec l'oracle tient a ce volume.
      const grosse = await composerSynthese(depotPrisma(prisma), { regions: null, maintenant: NOW, filtres: {}, droits });
      const o = await oracleEtat(null);
      verifier(`volume [${etiquette}] : degrade ${kpi(grosse, "reseau_degrade_pct").valeur} % = oracle ${pct1(o.degrade_km, o.eligible_km)} % sur ${Math.round(o.eligible_km)} km ; ${o.troncons} troncons dont ${o.sans_longueur} sans longueur ; voirie promue exclue`,
        kpi(grosse, "reseau_degrade_pct").valeur === pct1(o.degrade_km, o.eligible_km) && grosse.couverture.tronconsTotal === o.troncons && grosse.couverture.tronconsSansLongueurMetier === o.sans_longueur
        && proche(grosse.couverture.eligibleKm, Math.round(o.eligible_km * 100) / 100, 0.011) && proche(grosse.couverture.nonEvalueKm, Math.round(o.nonevalue_km * 100) / 100, 0.011), kpi(grosse, "reseau_degrade_pct"));
      const o1 = await oracleEtat([R1]);
      const g1 = await composerSynthese(depotPrisma(prisma), { regions: [R1], maintenant: NOW, filtres: {}, droits });
      verifier(`volume [${etiquette}] (region 1) : degrade ${kpi(g1, "reseau_degrade_pct").valeur} % = oracle ${pct1(o1.degrade_km, o1.eligible_km)} %`, kpi(g1, "reseau_degrade_pct").valeur === pct1(o1.degrade_km, o1.eligible_km) && g1.couverture.tronconsTotal === o1.troncons, kpi(g1, "reseau_degrade_pct"));
      verifier(`volume [${etiquette}] : la lecture de l'etat rend un nombre de groupes BORNE (${lignes.length}, dimensions categorielles), sans rapport avec les ${nPerim} troncons`, lignes.length < 400, lignes.length);
      verifier(`volume [${etiquette}] : le pays entier n'est jamais aussi lent qu'un balayage de tous les troncons un a un : la synthese (familles bornees) ne depasse pas 60 s`, med(tSynthese) < 60_000, tSynthese);
      return grosse;
    };

    // ---- volume realiste : environ 2 000 troncons au perimetre (ordre de grandeur de la base de production d'apres lib/reseau.ts)
    console.log("\n--- generation (hors mesure) ---");
    await genererTroncons(1, 2000);
    await mesurer("realiste", false);

    // ---- volume de stress : 50 000 troncons, marches, chantiers et decomptes
    await genererTroncons(2001, 50000);
    await exec(`
      INSERT INTO chantiers (id, intitule, entreprise, "regionId", statut, "dateFinPrevue", "montantGnf", "updatedAt")
      SELECT 'vc-' || g, 'vc-' || g, 'E', CASE WHEN g % 2 = 0 THEN ${R1} ELSE ${R2} END, (ARRAY['PLANIFIE','EN_COURS','SUSPENDU','TERMINE'])[1 + g % 4]::"StatutChantier",
             now() - ((g % 300) || ' days')::interval, 1000000 + g, now() FROM generate_series(1, 8000) g`);
    await exec(`
      INSERT INTO marches (id, intitule, "bailleurId", "montantTotal", devise, "updatedAt")
      SELECT gen_random_uuid(), 'vm-' || g, CASE WHEN g % 11 = 0 THEN NULL ELSE ${bailleurA} + (g % 2) END, 100000 + g, (CASE WHEN g % 17 = 0 THEN 'USD' ELSE 'GNF' END)::"DeviseMarche", now()
        FROM generate_series(1, 3000) g`);
    await exec(`
      WITH m AS (SELECT id, row_number() OVER (ORDER BY intitule) AS rn FROM marches WHERE intitule LIKE 'vm-%')
      INSERT INTO marches_chantiers ("marcheId", "chantierId")
      SELECT id, 'vc-' || rn FROM m
      UNION ALL SELECT id, 'vc-' || (rn + 3000) FROM m
      UNION ALL SELECT id, 'vc-' || (rn + 1) FROM m WHERE rn % 5 = 0`);
    await exec(`
      INSERT INTO decomptes (id, "marcheId", numero, type, "montantGnf", statut, "datePaiement", "updatedAt")
      SELECT gen_random_uuid(), m.id, k, 'DECOMPTE', 1000 * k, (ARRAY['EMIS','PAYE','REJETE'])[1 + k % 3]::"DecompteStatut", CASE WHEN k % 3 = 1 THEN now() END, now()
        FROM marches m CROSS JOIN generate_series(1, 4) k WHERE m.intitule LIKE 'vm-%'`);
    await exec(`ANALYZE`);
    const grosse = await mesurer("stress 50 000", true);

    const om = await oracleMarches(null);
    verifier(`volume [stress] : contractuel ${grosse.budget.contractuel.valeurGnf} = oracle ${om.contractuel}, decaisse ${grosse.budget.decaisse.valeurGnf} = oracle ${om.decaisse}, marches ${kpi(grosse, "marches_recenses").valeur} = oracle ${om.marches}`,
      grosse.budget.contractuel.valeurGnf === om.contractuel && grosse.budget.decaisse.valeurGnf === om.decaisse && kpi(grosse, "marches_recenses").valeur === om.marches, [grosse.budget.contractuel.valeurGnf, om.contractuel]);
    const omR = await oracleMarches([R1]);
    const g1 = await composerSynthese(depotPrisma(prisma), { regions: [R1], maintenant: NOW, filtres: {}, droits });
    verifier(`volume [stress] (region 1) : marches ${kpi(g1, "marches_recenses").valeur} = oracle ${omR.marches}, contractuel ${g1.budget.contractuel.valeurGnf} = oracle ${omR.contractuel}, decaisse ${g1.budget.decaisse.valeurGnf} = oracle ${omR.decaisse} (marches a cheval exclus)`,
      kpi(g1, "marches_recenses").valeur === omR.marches && g1.budget.contractuel.valeurGnf === omR.contractuel && g1.budget.decaisse.valeurGnf === omR.decaisse, [kpi(g1, "marches_recenses").valeur, omR.marches]);
    verifier("volume : la synthese dit que REGION et DOUBLON ne sont pas executees (cout), donnees_a_confirmer est PARTIEL ; /qualite execute les six familles",
      JSON.stringify(grosse.qualite.famillesNonExecutees) === JSON.stringify(["REGION", "DOUBLON"]) && kpi(grosse, "donnees_a_confirmer").etat === "PARTIEL", grosse.qualite.famillesNonExecutees);
  }
} finally {
  await prisma.$disconnect();
  await banc.fermer();
}
conclure();
