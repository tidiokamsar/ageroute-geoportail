// Banc d'integration du curseur temporel : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/curseur.integration.mts
// Les services committent et se voient entre eux : le banc travaille dans un CLONE jetable de `replay`,
// cree puis detruit par lui-meme (essai_curseur).
import { pathToFileURL } from "node:url";
import { evaluerCible } from "./lib/garde.ts";
import { creerClone, supprimerClone, urlClone } from "./lib/clone.ts";

const ORIGINE = process.env.DATABASE_URL;
const cible = evaluerCible(ORIGINE);
if (!cible.ok || cible.base !== "replay") {
  console.error("Banc d'integration refuse : DATABASE_URL doit etre une base locale nommee replay (le clone est cree par le banc).");
  process.exit(3);
}
const NOM_CLONE = "essai_curseur";
await creerClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = urlClone(ORIGINE!, NOM_CLONE);
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const { lirePortionsALaDate, chronologie, PLAFOND_PORTIONS } = await imp("reseau/curseur.service");
const { creerPortion, requalifierPortion, decouperPortion, fusionnerPortions } = await imp("reseau/portions.service");
const { depotPrisma } = await imp("reseau/portions.depot");

const J = (s: string) => new Date(`${s}T00:00:00Z`);
const fin = (s: string) => new Date(`${s}T23:59:59.999Z`);
const BBOX = { ouest: -13.7, sud: 9.5, est: -13.4, nord: 9.8 };
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = uid(1), A = uid(10), B = uid(11);
const P = { p1: uid(101), p2: uid(102), p3: uid(103), p4: uid(104), p5: uid(105), p6: uid(106) };

const verdicts: Record<string, boolean> = {};
const ok = (nom: string, cond: boolean, detail?: unknown) => {
  verdicts[nom] = cond;
  console.log(`${cond ? "  ok    " : "  ECHEC "} ${nom}${cond ? "" : "  -> " + JSON.stringify(detail)}`);
};
const ids = (r: { portions: { id: string }[] }) => r.portions.map((p) => p.id).sort();
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function sql(q: string, ...a: unknown[]) { return prisma.$executeRawUnsafe(q, ...a); }

async function portion(id: string, o: Record<string, unknown>) {
  await sql(
    `INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, "statutValidation", origine, "valideDu", "valideAu", "createdAt", "remplaceeLe", "creeParId", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::"StatutValidation", 'SAISIE_TERRAIN', $7::date, $8::date, $9::timestamp, $10::timestamp, $11, now())`,
    id, o.troncon, o.debut, o.fin, o.etat ?? "BON", o.statut ?? "VALIDE",
    o.valideDu ?? null, o.valideAu ?? null, o.cree ?? "2026-01-10T08:00:00", o.remplacee ?? null, U);
}

async function main() {
  // ---------- Fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region curseur')`);
  await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", "updatedAt") VALUES ($1, 'c@x.invalid', 'x', 'x', now())`, U);
  for (const [id, code, lat] of [[A, "CUR-A", 9.64], [B, "CUR-B", 9.66]] as const) {
    await sql(
      `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
       VALUES ($1, $2, $3, 'RN', (SELECT id FROM regions WHERE nom='Region curseur'), 2.2, 'BITUME', 0, 2.2,
               ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, ${lat}), ST_MakePoint(-13.58, ${lat})), 4326), now())`,
      id, code, `Troncon ${code}`);
  }
  for (const [c, l, o] of [["BON", "Bon", 1], ["MOYEN", "Moyen", 2], ["MAUVAIS", "Mauvais", 3]] as const) {
    await sql(`INSERT INTO referentiel_etats_chaussee (code, libelle, ordre, actif, critique, "updatedAt") VALUES ($1, $2, $3, true, false, now())`, c, l, o);
  }

  // P1 -> P2 : requalification au 01/06 (P1 close au terrain ET remplacee au systeme)
  await portion(P.p1, { troncon: A, debut: 0, fin: 1000, etat: "BON", valideDu: "2026-01-01", valideAu: "2026-06-01", cree: "2026-01-10T08:00:00", remplacee: "2026-06-02T09:00:00" });
  await portion(P.p2, { troncon: A, debut: 0, fin: 1000, etat: "MAUVAIS", valideDu: "2026-06-01", cree: "2026-06-02T09:00:00" });
  await portion(P.p3, { troncon: A, debut: 1000, fin: 2000, etat: "MOYEN", valideDu: "2026-02-01", cree: "2026-02-05T08:00:00" });
  await portion(P.p4, { troncon: B, debut: 0, fin: 500, etat: "BON", statut: "A_VALIDER", valideDu: "2026-03-01", cree: "2026-03-02T08:00:00" });
  await portion(P.p5, { troncon: B, debut: 600, fin: 900, etat: "BON", valideDu: null });
  await portion(P.p6, { troncon: B, debut: 1000, fin: 1500, etat: "BON", statut: "REJETE", valideDu: "2026-01-01" });
  const decision = async (portion: string, statut: string, quand: string) => sql(
    `INSERT INTO audit_logs (id, "userId", action, "entityType", "entityId", after, "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'VALIDATE'::"AuditAction", 'Portion', $2, $3::jsonb, $4::timestamp)`,
    U, portion, JSON.stringify({ statutValidation: statut }), quand);
  await decision(P.p1, "VALIDE", "2026-01-12T10:00:00");
  await decision(P.p3, "VALIDE", "2026-03-01T10:00:00");
  await decision(P.p2, "VALIDE", "2026-06-03T10:00:00");

  const base = { inclureAValider: false, connuLe: null, emprise: BBOX };

  // ---------- Axe terrain
  console.log("\nAxe terrain");
  let r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15") });
  ok("15/03 : P1 (BON) et P3 (MOYEN), pas P2", eq(ids(r), [P.p1, P.p3].sort()), ids(r));
  ok("15/03 : la sans-date, la rejetee et la proposition ne sont pas montrees", !ids(r).includes(P.p5) && !ids(r).includes(P.p6) && !ids(r).includes(P.p4), ids(r));
  ok("15/03 : la proposition en attente est comptee comme ecartee", r.comptes.aValiderEcartees === 1, r.comptes);
  ok("15/03 : le libelle d'etat vient du referentiel", r.portions.find((p: { id: string }) => p.id === P.p1)?.etatLibelle === "Bon");
  ok("15/03 : longueur couverte = 2 000 m", r.longueurCouverteM === 2000, r.longueurCouverteM);

  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), inclureAValider: true });
  ok("15/03 avec propositions : P4 s'ajoute, marquee A_VALIDER", eq(ids(r), [P.p1, P.p3, P.p4].sort()) && r.portions.find((p: { id: string }) => p.id === P.p4)?.statut === "A_VALIDER", ids(r));

  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-06-01") });
  ok("01/06 (bascule) : P2 seule sur [0,1000), P1 exclue (fin exclue)", eq(ids(r), [P.p2, P.p3].sort()), ids(r));
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-05-31") });
  ok("31/05 : P1 encore vraie, P2 pas commencee", eq(ids(r), [P.p1, P.p3].sort()), ids(r));
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-01-15") });
  ok("15/01 : P1 seule (P3 commence au 01/02)", eq(ids(r), [P.p1]), ids(r));
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2025-12-31") });
  ok("31/12/2025 : rien, et ce n'est pas une erreur", r.portions.length === 0 && r.comptes.retenues === 0);
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-10-01") });
  ok("aujourd'hui : P2 et P3 (l'etat actuel)", eq(ids(r), [P.p2, P.p3].sort()), ids(r));

  // ---------- Geometrie
  console.log("\nGeometrie derivee du troncon (aucune portion n'a de geom propre)");
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15") });
  const g1 = JSON.parse(r.portions.find((p: { id: string }) => p.id === P.p1).geometry);
  const g3 = JSON.parse(r.portions.find((p: { id: string }) => p.id === P.p3).geometry);
  ok("P1 : LineString a 2 sommets au moins", g1.type === "LineString" && g1.coordinates.length >= 2, g1);
  ok("P1 [0,1000) s'arrete vers le milieu du troncon (-13.60 -> -13.5909)", Math.abs(g1.coordinates.at(-1)[0] - -13.5909) < 0.0015, g1.coordinates);
  ok("P3 [1000,2000) commence ou P1 finit", Math.abs(g3.coordinates[0][0] - g1.coordinates.at(-1)[0]) < 1e-6, [g1.coordinates.at(-1), g3.coordinates[0]]);

  // ---------- Perimetre
  console.log("\nPerimetre");
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), inclureAValider: true, emprise: { ouest: 10, sud: 10, est: 11, nord: 11 } });
  ok("une emprise sans troncon : aucune portion", r.portions.length === 0);
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), inclureAValider: true, emprise: undefined, tronconId: B });
  ok("par troncon : seulement ceux de B", eq(ids(r), [P.p4]), ids(r));
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), emprise: { ouest: -13.7, sud: 9.655, est: -13.4, nord: 9.665 } });
  ok("une emprise qui ne touche que le troncon B ne rend pas A", !ids(r).some((i: string) => [P.p1, P.p3].includes(i)), ids(r));

  // ---------- Axe systeme
  console.log("\nAxe systeme (ce que l'on savait)");
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), connuLe: fin("2026-02-07") });
  ok("connu au 07/02 : P1 (validee le 12/01) seule ; P3 etait encore en attente", eq(ids(r), [P.p1]), ids(r));
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), connuLe: fin("2026-02-07"), inclureAValider: true });
  const s3 = r.portions.find((p: { id: string }) => p.id === P.p3);
  ok("connu au 07/02 avec propositions : P3 revient, A_VALIDER (validee le 01/03, apres)", s3?.statut === "A_VALIDER", s3?.statut);
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), connuLe: fin("2026-03-10") });
  ok("connu au 10/03 : P1 et P3, toutes deux validees", eq(ids(r), [P.p1, P.p3].sort()), ids(r));
  // Terrain 01/06 tel que connu le 01/06 : P1 est ROUVERTE (son remplacement date du 02/06), P2 n'existe pas encore.
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-06-01"), connuLe: fin("2026-06-01") });
  ok("terrain 01/06 connu le 01/06 : le remplacement n'etait pas enregistre -> P1 rouverte, P2 absente", eq(ids(r), [P.p1, P.p3].sort()), ids(r));
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-06-01"), connuLe: fin("2026-07-01") });
  ok("terrain 01/06 connu le 01/07 : P2 (validee le 03/06)", eq(ids(r), [P.p2, P.p3].sort()), ids(r));
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15"), connuLe: fin("2026-01-05") });
  ok("connu au 05/01 : rien n'etait enregistre", r.portions.length === 0, ids(r));

  // ---------- Plafond
  console.log("\nPlafond");
  await sql(
    `INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, "statutValidation", origine, "valideDu", "createdAt", "creeParId", "updatedAt")
     SELECT gen_random_uuid()::text, $1, 100000 + i * 10, 100000 + i * 10 + 10, 'BON', 'VALIDE'::"StatutValidation", 'SAISIE_TERRAIN', DATE '2026-01-01', timestamp '2026-01-10 08:00', $2, now()
       FROM generate_series(1, ${PLAFOND_PORTIONS + 50}) i`, A, U);
  r = await lirePortionsALaDate(prisma, { ...base, dateTerrain: J("2026-03-15") });
  ok(`plus de ${PLAFOND_PORTIONS} portions : tronque et le dit`, r.tronque === true && r.portions.length <= PLAFOND_PORTIONS, { tronque: r.tronque, n: r.portions.length });
  await sql(`DELETE FROM portions WHERE "debutM" >= 100000`);

  // ---------- Chronologie
  console.log("\nChronologie");
  const c = await chronologie(prisma);
  ok("total = portions non rejetees (P1..P5)", c.total === 5, c);
  ok("sans date d'effet = 1 (P5)", c.sansDateEffet === 1 && c.avecDateEffet === 4, c);
  ok("premiere = 2026-01-01, derniere = 2026-06-01", c.premiere === "2026-01-01" && c.derniere === "2026-06-01", c);
  ok("par mois : debuts et fins comptes", c.parMois.some((m: { mois: string }) => m.mois === "2026-06") && c.parMois.reduce((s: number, m: { n: number }) => s + m.n, 0) === 5, c.parMois);

  // ---------- Chemin d'ecriture reel
  console.log("\nEcriture reelle (date d'effet)");
  const TC = uid(12);
  await sql(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
     VALUES ($1, 'CUR-C', 'Troncon C', 'RN', (SELECT id FROM regions WHERE nom='Region curseur'), 2.2, 'BITUME', 0, 2.2,
             ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.70), ST_MakePoint(-13.58, 9.70)), 4326), now())`, TC);

  const cree = await creerPortion({ tronconId: TC, debutM: 0, finM: 1000, etat: "BON", valideDu: J("2026-04-01") }, U, depotPrisma);
  ok("creer avec date d'effet : acceptee", cree.refus === null, cree);
  const [ligneC] = await prisma.$queryRawUnsafe<{ valideDu: Date | null; valideAu: Date | null }[]>(`SELECT "valideDu", "valideAu" FROM portions WHERE id = $1`, (cree as { valeur: { id: string } }).valeur.id);
  ok("en base : valideDu = 2026-04-01, valideAu vide", ligneC.valideDu?.toISOString().slice(0, 10) === "2026-04-01" && ligneC.valideAu === null, ligneC);
  const idC = (cree as { valeur: { id: string } }).valeur.id;
  await sql(`UPDATE portions SET "statutValidation" = 'VALIDE' WHERE id = $1`, idC);

  const req = await requalifierPortion(idC, { etat: "MAUVAIS", valideDu: J("2026-08-01") }, U, depotPrisma);
  ok("requalifier avec date posterieure : acceptee (la contrainte d'exclusion ne se declenche pas)", req.refus === null, req);
  const lignes = await prisma.$queryRawUnsafe<{ id: string; etat: string; valideDu: Date | null; valideAu: Date | null; remplaceeLe: Date | null }[]>(`SELECT id, etat, "valideDu", "valideAu", "remplaceeLe" FROM portions WHERE "tronconId" = $1 ORDER BY "createdAt"`, TC);
  const ancienne = lignes.find((l) => l.id === idC)!;
  ok("l'ancienne est CLOSE au terrain (valideAu = 2026-08-01) ET remplacee au systeme (remplaceeLe pose)",
    ancienne.valideAu?.toISOString().slice(0, 10) === "2026-08-01" && ancienne.remplaceeLe !== null, ancienne);
  const nouvelleId = (req as { valeur: { id: string } }).valeur.id;
  const nouvelle = lignes.find((l) => l.id === nouvelleId)!;
  ok("la nouvelle s'ouvre le 2026-08-01, sans fin", nouvelle.valideDu?.toISOString().slice(0, 10) === "2026-08-01" && nouvelle.valideAu === null, nouvelle);
  const aud = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM audit_logs WHERE "entityId" = $1 AND "entityType" = 'Portion'`, idC);
  ok("la cloture est auditee", Number(aud[0].n) >= 2, aud);

  await sql(`UPDATE portions SET "statutValidation" = 'VALIDE' WHERE id = $1`, nouvelleId);
  const empC = { ouest: -13.7, sud: 9.69, est: -13.5, nord: 9.71 };
  let rc = await lirePortionsALaDate(prisma, { dateTerrain: J("2026-07-15"), connuLe: null, inclureAValider: false, emprise: empC });
  ok("le curseur au 15/07 montre l'ANCIENNE version (BON)", eq(rc.portions.map((p: { etat: string }) => p.etat), ["BON"]), rc.portions.map((p: { etat: string }) => p.etat));
  rc = await lirePortionsALaDate(prisma, { dateTerrain: J("2026-08-01"), connuLe: null, inclureAValider: false, emprise: empC });
  ok("le curseur au 01/08 montre la NOUVELLE (MAUVAIS), jamais les deux", eq(rc.portions.map((p: { etat: string }) => p.etat), ["MAUVAIS"]), rc.portions.map((p: { etat: string }) => p.etat));

  const refus = await requalifierPortion(nouvelleId, { etat: "MOYEN", valideDu: J("2026-08-01") }, U, depotPrisma);
  ok("requalifier avec une date NON posterieure : refusee, rien n'est ecrit", refus.refus === "DATE_EFFET_NON_POSTERIEURE", refus);

  const dec = await decouperPortion(nouvelleId, 400, U, depotPrisma);
  ok("decouper : acceptee", dec.refus === null, dec);
  const morceaux = (dec as { valeur: { id: string }[] }).valeur;
  const dm = await prisma.$queryRawUnsafe<{ valideDu: Date | null }[]>(`SELECT "valideDu" FROM portions WHERE id = ANY($1::text[])`, morceaux.map((m) => m.id));
  ok("les deux morceaux heritent de la date d'effet 2026-08-01", dm.every((x) => x.valideDu?.toISOString().slice(0, 10) === "2026-08-01"), dm);
  rc = await lirePortionsALaDate(prisma, { dateTerrain: J("2026-09-01"), connuLe: null, inclureAValider: true, emprise: empC });
  ok("apres decoupe, le curseur montre les 2 morceaux et PAS le parent (remplace sans date de fin), sans recouvrement",
    rc.portions.length === 2 && rc.comptes.ambigues === 0 && rc.comptes.remplaceesSansFin >= 1, { n: rc.portions.length, comptes: rc.comptes });

  // fusion refusee : deux portions de periodes differentes
  const autre = await creerPortion({ tronconId: TC, debutM: 1000, finM: 1500, etat: "MAUVAIS", valideDu: J("2026-05-01") }, U, depotPrisma);
  await sql(`UPDATE portions SET "statutValidation" = 'VALIDE' WHERE id = $1`, (autre as { valeur: { id: string } }).valeur.id);
  const f = await fusionnerPortions(morceaux[1].id, (autre as { valeur: { id: string } }).valeur.id, U, depotPrisma);
  ok("fusionner deux portions de periodes differentes : refusee (PERIODES_DIFFERENTES)", f.refus === "PERIODES_DIFFERENTES", f);

  const echecs = Object.entries(verdicts).filter(([, v]) => !v).map(([k]) => k);
  console.log(`\n${Object.keys(verdicts).length - echecs.length}/${Object.keys(verdicts).length} verifications reussies`);
  if (echecs.length) { console.log("ECHECS:", echecs); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(async () => { await prisma.$disconnect(); await supprimerClone(ORIGINE!, NOM_CLONE); });
