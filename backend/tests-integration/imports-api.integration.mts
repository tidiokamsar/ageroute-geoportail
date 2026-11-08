// Banc d'integration de l'API ADDITIVE des lots d'import (liste, meta, sources, detail enrichi, apercu) et du
// DURCISSEMENT de la reception (format incoherent, encodage, NUL, plafond de lignes, formules, saturation).
// Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/imports-api.integration.mts
//
// Tout passe par les routes reelles montees comme en production (`apiV2Router`, jetons signes, role lu en base),
// l'orchestration reelle (`import.service.ts`), le SQL reel (jsonb_object_keys, ILIKE, curseur) et les
// contraintes reelles de `lots_import` / `lignes_import`, dans le clone jetable `essai_imports_api`.
//
// Ce que le banc prouve que les tests Vitest (base simulee) ne prouvent pas :
//   - la liste filtree et paginee est stable sur une vraie base, y compris apres une insertion concurrente ;
//   - `q` traite % et _ comme des caracteres, pas comme des jokers ;
//   - le detail calcule les colonnes avec le SQL reel, et l'historique lit `audit_logs` sans `MODULE_PAR_ENTITE` ;
//   - AUCUNE route ne modifie autre chose que lots_import / lignes_import / audit_logs : comptes de TOUTES les
//     tables avant/apres, separement pour les lectures (aucun changement) et les receptions ;
//   - un refus (400/503) ne laisse AUCUN lot ; une cellule NUL, un octet Latin-1, un faux format ne font jamais un 500 ;
//   - sous charge, jamais de 500 ni de 409, et un autre utilisateur est servi pendant ce temps.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_imports_api");
const { prisma } = await banc.imp("lib/prisma");
const { apiV2Router } = await banc.imp("api-v2/index");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const { LIMITE_LIGNES } = await banc.imp("import/reception.noyau");
const { lireCsv } = await banc.imp("import/pivot.noyau");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/v2", apiV2Router);
app.use(errorHandler);

const BASE = "/api/v2/imports";
const ENTETE = "systeme_source;type_objet;identifiant_source;code_route;geometrie;note";
const ligneCsv = (id: string, note = "", src = "ONR_BDR") => `${src};comptage;${id};RN1;;${note}`;
const csvDe = (lignes: string[]) => `${ENTETE}\n${lignes.join("\n")}\n`;
const BASE_CHAMPS = { systemeSource: "ONR_BDR", format: "csv", methodeSource: "export fichier", versionMapping: "v1", autorisationRef: "AUT-2026-001" };

/** Etat de toutes les tables de `public` (nombre de lignes) : la preuve que rien n'a bouge ailleurs. */
async function instantane(): Promise<Record<string, number>> {
  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE '\\_%' ORDER BY 1`);
  const sortie: Record<string, number> = {};
  for (const t of tables) sortie[t.table_name] = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) n FROM "${t.table_name}"`))[0].n);
  return sortie;
}
const differences = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).filter((t) => a[t] !== b[t]).sort();
const compter = async (sql: string): Promise<number> => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);

async function main() {
  // ---------------------------------------------------------------- Fixtures
  const comptes = {
    admin: await prisma.user.create({ data: { email: "admin@banc.invalid", nomComplet: "Mariama Admin", passwordHash: "x", role: "ADMIN" } }),
    chef: await prisma.user.create({ data: { email: "chef@banc.invalid", nomComplet: "Sekou Gestionnaire", passwordHash: "x", role: "GESTIONNAIRE" } }),
    inspecteur: await prisma.user.create({ data: { email: "insp@banc.invalid", nomComplet: "Inspecteur banc", passwordHash: "x", role: "INSPECTEUR" } }),
    lecteur: await prisma.user.create({ data: { email: "lecteur@banc.invalid", nomComplet: "Lecteur banc", passwordHash: "x", role: "LECTEUR" } }),
  };
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = Object.fromEntries(Object.entries(comptes).map(([k, u]) => [k, jeton(u)])) as Record<keyof typeof comptes, string>;

  const get = (chemin: string, t = T.chef) => request(app).get(`${BASE}${chemin}`).set("Authorization", `Bearer ${t}`);
  function post(contenu: Buffer | string, champs: Record<string, string | undefined> = {}, nom = "lot.csv", t = T.chef) {
    const r = request(app).post(BASE).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries({ ...BASE_CHAMPS, ...champs })) if (v !== undefined) r.field(k, v);
    return r.attach("fichier", Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, "utf8"), { filename: nom, contentType: "text/csv" });
  }
  const lots = () => compter(`SELECT count(*) n FROM lots_import`);

  console.log("\n== API des lots d'import : lecture, durcissement, saturation ==");

  // ---------------------------------------------------------------- 1. Receptions de depart (instantane : seules 3 tables bougent)
  const avantReceptions = await instantane();
  const geo = (lon: number, lat: number) => `"{""type"":""Point"",""coordinates"":[${lon},${lat}]}"`;
  const a1 = (await post(csvDe([ligneCsv("A1"), ligneCsv("A2"), ligneCsv("A1"), "ONR_BDR;route;X;RN1;;"]), {}, "alpha.csv")).body;
  const a2 = (await post(csvDe([ligneCsv("B1", "<script>alert(1)</script>"), ligneCsv("B2", "x".repeat(600))]), {}, "Beta-Releve.csv", T.admin)).body;
  const a3 = (await post("systeme_source;libelle\nONR_BDR;x\n", {}, "sans-colonne.csv")).body;
  const a4 = (await post(csvDe([ligneCsv("C1", "", "ANASUR_COLLECT")]), { systemeSource: "ANASUR_COLLECT", autorisationRef: "AUT-2026-002" }, "gamma_100%_a.csv")).body;
  const a5 = (await post(csvDe([ligneCsv("D1", "", "onr_bdr")]), { systemeSource: "onr_bdr" }, "delta.csv")).body;
  const a6 = (await post(csvDe([ligneCsv("E1"), `ONR_BDR;ouvrage;P1;RN1;${geo(2.35, 48.85)};`, ligneCsv("E3", "", "AUTRE_SYSTEME")]), {}, "avertissements.csv")).body;
  const dix = [a1, a2, a3, a4, a5, a6];
  verifier("1. six lots de depart recus (statuts attendus : 4 VALIDE_SCHEMA, 1 REJETE de colonne absente, 1 VALIDE_SCHEMA avec avertissements)",
    dix.every((l) => l.id) && a3.statut === "REJETE" && [a1, a2, a4, a5, a6].every((l) => l.statut === "VALIDE_SCHEMA"), dix.map((l) => l.statut));
  const apresReceptions = await instantane();
  verifier("1. les receptions n'ont modifie QUE lots_import, lignes_import et audit_logs (comptes de toutes les tables)",
    JSON.stringify(differences(avantReceptions, apresReceptions)) === JSON.stringify(["audit_logs", "lignes_import", "lots_import"]), differences(avantReceptions, apresReceptions));

  // ---------------------------------------------------------------- 2. Lectures : aucune table ne bouge
  const avantLectures = await instantane();

  const meta = (await get("/meta")).body;
  verifier("2. /meta annonce csv et geojson, les 5 statuts, le plafond de lignes du code et la taille de multer",
    meta.formats?.map((f: { code: string }) => f.code).join() === "csv,geojson" && meta.statuts?.length === 5 && meta.limiteLignes === LIMITE_LIGNES && meta.tailleMaxOctets === 25 * 1024 * 1024, meta);

  const srcs = (await get("/sources")).body;
  verifier("2. /sources rend les valeurs distinctes reellement recues avec leur nombre de lots, sans les melanger",
    srcs.sources.length === 3 && [["ANASUR_COLLECT", 1], ["onr_bdr", 1], ["ONR_BDR", 4]].every(([v, n]) => srcs.sources.some((s: { valeur: string; nombreLots: number }) => s.valeur === v && s.nombreLots === n)), srcs);

  const liste = (await get("")).body;
  verifier("2. GET / : total exact (6), du plus recent au plus ancien, importePar nominatif, taille en chaine, motifRejetLot du lot rejete",
    liste.total === 6 && liste.suivant === null && liste.lots.map((l: { id: string }) => l.id).join() === [a6, a5, a4, a3, a2, a1].map((l) => l.id).join()
    && liste.lots[5].importePar?.nomComplet === "Sekou Gestionnaire" && liste.lots[4].importePar?.nomComplet === "Mariama Admin"
    && typeof liste.lots[0].tailleOctets === "string" && /colonne obligatoire absente/.test(liste.lots[3].motifRejetLot ?? ""), liste.lots[3]);

  const filtre = async (qs: string) => (await get(`?${qs}`)).body;
  verifier("2. filtre statut=REJETE : un lot ; statut=IMPORTE : zero ; le total suit le filtre (pas la page)",
    (await filtre("statut=REJETE")).total === 1 && (await filtre("statut=IMPORTE")).total === 0 && (await filtre("statut=VALIDE_SCHEMA&limite=1")).total === 5);
  verifier("2. filtre source insensible a la casse : ONR_BDR trouve ONR_BDR et onr_bdr (5), anasur_collect trouve ANASUR_COLLECT (1)",
    (await filtre("source=ONR_BDR")).total === 5 && (await filtre("source=anasur_collect")).total === 1);
  verifier("2. q cherche reference, nom de fichier et source sans tenir compte de la casse",
    (await filtre("q=BETA")).lots.map((l: { id: string }) => l.id).join() === a2.id && (await filtre("q=anasur")).total === 1 && (await filtre(`q=${a1.reference.toLowerCase()}`)).lots[0]?.id === a1.id);
  verifier("2. q traite % et _ comme des CARACTERES : « 100% » trouve gamma_100%_a.csv seul ; « % » seul ne rend pas tout ; « gamma_100%_ » ne devient pas un joker",
    (await filtre("q=100%25")).total === 1 && (await filtre("q=%25")).total === 1 && (await filtre("q=a_100")).total === 1 && (await filtre("q=gamm_")).total === 0,
    [(await filtre("q=100%25")).total, (await filtre("q=%25")).total, (await filtre("q=gamm_")).total]);
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const demain = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  verifier("2. du / au : la journee entiere est incluse (au=aujourd'hui rend les 6) ; du=demain ne rend rien",
    (await filtre(`du=${aujourdhui}&au=${aujourdhui}`)).total === 6 && (await filtre(`du=${demain}`)).total === 0);

  // Pagination par curseur, stable apres une insertion concurrente (la reception suivante est ecrite entre deux pages).
  const instantAvantInsertion = await instantane();
  const p1 = (await get("?limite=2")).body;
  const intrus = (await post(csvDe([ligneCsv("INTRUS")]), {}, "arrive-entre-deux-pages.csv")).body;
  const p2 = (await get(`?limite=2&curseur=${p1.suivant}`)).body;
  const p3 = (await get(`?limite=2&curseur=${p2.suivant}`)).body;
  const idsPages = [...p1.lots, ...p2.lots, ...p3.lots].map((l: { id: string }) => l.id);
  verifier("2. curseur : trois pages disjointes couvrent exactement les 6 lots d'avant, ordre stable, aucun doublon, l'intrus (plus recent) n'apparait pas dans les pages suivantes",
    idsPages.length === 6 && new Set(idsPages).size === 6 && idsPages.join() === [a6, a5, a4, a3, a2, a1].map((l) => l.id).join() && !idsPages.includes(intrus.id) && p3.suivant === null,
    { n: idsPages.length });
  verifier("2. ... et le total reflete la base au moment de la page (7 apres l'insertion), pas une valeur figee", p1.total === 6 && p2.total === 7 && (await get("")).body.total === 7);
  // Egalite d'horodatage : trois lots au meme instant, pagination un par un, ordre (importeLe desc, id asc).
  await prisma.$executeRawUnsafe(`UPDATE lots_import SET "importeLe" = '2026-01-01T10:00:00.000Z' WHERE reference IN ('${a1.reference}','${a2.reference}','${a3.reference}')`);
  const egaux: string[] = [];
  let cur = ""; let garde = 0;
  do {
    const r = (await get(`?du=2026-01-01T10:00:00.000Z&au=2026-01-01T10:00:00.000Z&limite=1${cur ? `&curseur=${cur}` : ""}`)).body;
    egaux.push(...r.lots.map((l: { id: string }) => l.id)); cur = r.suivant ?? ""; garde += 1;
  } while (cur && garde < 10);
  const attendusEgaux = [a1.id, a2.id, a3.id].sort();
  verifier("2. curseur sur des lots de MEME instant : aucun ne saute ni ne se repete, ordre par id", egaux.length === 3 && egaux.join() === attendusEgaux.join(), egaux);
  // Instantane des lectures seules (apres la reception de l'intrus, qu'on retire du calcul).
  const apresLecturesSeules = await instantane();
  verifier("2. les lectures (liste, meta, sources, filtres, pages) n'ont modifie AUCUNE table : seule la reception de l'intrus a bouge lots/lignes/audit",
    JSON.stringify(differences(instantAvantInsertion, apresLecturesSeules)) === JSON.stringify(["audit_logs", "lignes_import", "lots_import"]), differences(instantAvantInsertion, apresLecturesSeules));

  verifier("2. curseur et parametres invalides : 400 avec code stable, jamais 500",
    (await get("?curseur=zzz")).body.code === "CURSEUR_INVALIDE" && (await get("?curseur=zzz")).status === 400
    && (await get("?limite=0")).body.code === "PARAMETRES_INVALIDES" && (await get("?limite=101")).status === 400 && (await get("?inconnu=1")).status === 400
    && (await get("?statut=PIRATE")).status === 400 && (await get("?du=hier")).status === 400);

  // ---------------------------------------------------------------- 3. Detail enrichi
  const d1 = (await get(`/${a1.id}`)).body;
  verifier("3. detail : champs d'avant conserves + empreinte sha256 egale a celle de la base + importePar + taille en chaine",
    d1.reference === a1.reference && d1.statut === "VALIDE_SCHEMA" && d1.empreinte?.algorithme === "sha256" && d1.empreinte.valeur === d1.empreinteFichier
    && /^[0-9a-f]{64}$/.test(d1.empreinte.valeur) && d1.importePar?.nomComplet === "Sekou Gestionnaire" && /^\d+$/.test(d1.tailleOctets), d1.empreinte);
  verifier("3. detail : compteurs reels (4 lues, 1 validee... 2 validees, 1 rejetee, 1 ignoree) et premiersRejets motives",
    JSON.stringify(d1.controle.compteurs) === JSON.stringify({ lues: 4, validees: 2, rejetees: 1, enConflit: 0, ignorees: 1, importees: 0 })
    && d1.controle.premiersRejets.length === 2 && /type_objet/.test(d1.controle.premiersRejets.find((p: { statut: string }) => p.statut === "REJETEE")?.motif ?? ""), d1.controle);
  verifier("3. detail : colonnes calculees par le SQL reel depuis les cles de la charge (reconnues dans l'ordre du pivot, inconnues triees)",
    JSON.stringify(d1.controle.colonnes) === JSON.stringify({ reconnues: ["systeme_source", "type_objet", "identifiant_source", "code_route", "geometrie"], inconnues: ["note"] }), d1.controle.colonnes);
  verifier("3. detail : etapes (reception TERMINEE, controle AVEC_RESERVES, echantillon et import NON_DISPONIBLES avec leur raison) et actions (erreurs permise)",
    d1.etapes.map((e: { etat: string }) => e.etat).join() === "TERMINEE,TERMINEE_AVEC_RESERVES,NON_DISPONIBLE,NON_DISPONIBLE" && /decision DSI requise/.test(d1.etapes[2].raison)
    && /rien n'a ete cree/.test(d1.etapes[3].raison) && d1.actionsPermises.every((a: { permise: boolean }) => a.permise), d1.etapes);
  verifier("3. detail : historique lu dans audit_logs (LotImport n'est pas dans MODULE_PAR_ENTITE) : acteur nominatif, details sobres, ni IP ni empreinte",
    d1.historique.length === 1 && d1.historique[0].acteur === "Sekou Gestionnaire" && d1.historique[0].action === "CREATE"
    && new RegExp(`^Lot ${a1.reference} enregistre : statut VALIDE_SCHEMA, 4 lignes lues\\.$`).test(d1.historique[0].details) && !/ipAddress|[0-9a-f]{64}/.test(JSON.stringify(d1.historique)), d1.historique);
  const d3 = (await get(`/${a3.id}`)).body;
  verifier("3. detail d'un lot REJETE sans ligne : controle ECHEC avec le motif, colonnes null (non calculables, pas []), actions refusees avec raison",
    d3.etapes[1].etat === "ECHEC" && /colonne obligatoire absente/.test(d3.etapes[1].raison) && d3.etapes[2].etat === "NON_COMMENCEE" && d3.etapes[3].etat === "NON_COMMENCEE"
    && d3.controle.colonnes === null && d3.actionsPermises.every((a: { permise: boolean; raison: string | null }) => !a.permise && a.raison), d3.controle);
  const d6 = (await get(`/${a6.id}`)).body;
  verifier("3. avertissements stockes a la reception et rendus au detail : source differente d'une ligne + coordonnees hors du pays, la ligne reste VALIDEE",
    d6.controle.avertissements.length === 2 && d6.controle.avertissements.some((a: string) => /systeme_source different.*AUTRE_SYSTEME/.test(a)) && d6.controle.avertissements.some((a: string) => /hors de l'etendue attendue du pays/.test(a))
    && d6.controle.compteurs.validees === 3 && JSON.stringify(a6.avertissements) === JSON.stringify(d6.controle.avertissements), d6.controle.avertissements);
  verifier("3. detail inconnu ou id absurde : 404", (await get("/inconnu")).status === 404 && (await get(`/${"x".repeat(300)}`)).status === 404 && (await get("/inconnu/apercu")).status === 404 && (await get("/inconnu/erreurs.csv")).status === 404);

  // ---------------------------------------------------------------- 4. Apercu
  const ap = (await get(`/${a2.id}/apercu`)).body;
  verifier("4. apercu : lignes numerotees, statut, charge en texte ; <script> est rendu TEL QUEL dans le JSON (a l'interface de l'echapper)",
    ap.lignes.length === 2 && ap.lignes[0].numeroLigne === 1 && ap.lignes[0].charge.note === "<script>alert(1)</script>" && (await get(`/${a2.id}/apercu`)).text.includes("<script>alert(1)</script>"), ap.lignes[0]);
  verifier("4. apercu : une valeur de 600 caracteres est tronquee a 200 et `tronque` le dit", ap.lignes[1].charge.note.length === 200 && ap.tronque === true);
  const lotLarge = (await post(csvDe(Array.from({ length: 120 }, (_, i) => ligneCsv(`L${i}`))), {}, "cent-vingt.csv")).body;
  const apDefaut = (await get(`/${lotLarge.id}/apercu`)).body;
  const apMax = (await get(`/${lotLarge.id}/apercu?limite=50`)).body;
  const apSuite = (await get(`/${lotLarge.id}/apercu?limite=50&apres=${apMax.suivant}`)).body;
  verifier("4. apercu borne : defaut 20 lignes, max 50, 51 refuse (400), pagination par numero de ligne sans trou ni doublon (50 + 50 + 20)",
    apDefaut.lignes.length === 20 && apMax.lignes.length === 50 && (await get(`/${lotLarge.id}/apercu?limite=51`)).status === 400 && apMax.suivant === 50
    && apSuite.lignes.length === 50 && apSuite.lignes[0].numeroLigne === 51 && (await get(`/${lotLarge.id}/apercu?limite=50&apres=${apSuite.suivant}`)).body.lignes.length === 20);
  const apRej = (await get(`/${a1.id}/apercu?statut=REJETEE`)).body;
  verifier("4. apercu filtre par statut (REJETEE : la ligne 4 seule, avec son motif) ; IMPORTEE refuse", apRej.lignes.length === 1 && apRej.lignes[0].numeroLigne === 4 && /type_objet/.test(apRej.lignes[0].motifRejet) && (await get(`/${a1.id}/apercu?statut=IMPORTEE`)).status === 400);
  // Un motif enorme ne se recopie pas : type_objet de 300 Ko.
  const enorme = (await post(csvDe([`ONR_BDR;${"q".repeat(300_000)};E1;RN1;;`]), {}, "echo.csv")).body;
  const ligneEcho = (await get(`/${enorme.id}/apercu`)).body.lignes[0];
  const detailEcho = await get(`/${enorme.id}`);
  const erreursEcho = await get(`/${enorme.id}/erreurs.csv`);
  verifier("4. amplification par echo bornee : le motif ne cite qu'un extrait (detail < 5 Ko, apercu < 5 Ko, export d'erreurs < 20 Ko) alors que la charge complete (300 Ko) reste en base",
    detailEcho.text.length < 5_000 && JSON.stringify(ligneEcho).length < 5_000 && erreursEcho.text.length < 20_000
    && await compter(`SELECT count(*) n FROM lignes_import WHERE "lotId"='${enorme.id}' AND length("chargeOriginale"->>'type_objet') = 300000`) === 1, { detail: detailEcho.text.length, export: erreursEcho.text.length });

  // ---------------------------------------------------------------- 5. Erreurs.csv : formules
  const dangereux = ["=HYPERLINK(\"http://x\",\"a\")", "+cmd|' /C calc'!A0", "-2+3+cmd", "@SUM(A1)", "=1+1"];
  const lignesF = dangereux.flatMap((d) => { const c = `"${d.replace(/"/g, '""')}"`; return [`ONR_BDR;comptage;${c};RN1;;`, `ONR_BDR;comptage;${c};RN1;;`]; });
  const lotF = (await post(csvDe(lignesF), {}, "formules.csv")).body;
  const errF = await get(`/${lotF.id}/erreurs.csv`);
  const relu = lireCsv(errF.text);
  verifier("5. erreurs.csv : 5 cellules d'identifiant dangereuses (=, +, -, @) sortent precedees d'une apostrophe, aucune cellule ne commence par un declencheur, les 5 colonnes se relisent",
    errF.status === 200 && relu.lignes.length === 5 && relu.lignes.every((l: Record<string, string>) => /^'[=+\-@]/.test(l.identifiant_source) && Object.values(l).every((v) => !/^[=+\-@]/.test(v)))
    && relu.entete.join() === "numero_ligne,statut,motif,identifiant_source,charge_originale", relu.lignes[0]);
  verifier("5. ... et l'en-tete HTTP dit le nombre de lignes en erreur et exportees", errF.headers["x-lignes-en-erreur"] === "5" && errF.headers["x-lignes-exportees"] === "5");
  const errA = await get(`/${a1.id}/erreurs.csv`);
  verifier("5. erreurs.csv d'un lot ordinaire : 2 lignes (rejetee, ignoree) + en-tete, type text/csv, nosniff", errA.text.trim().split("\n").length === 3 && /text\/csv/.test(errA.headers["content-type"]) && errA.headers["x-content-type-options"] === "nosniff");

  // ---------------------------------------------------------------- 6. Refus avant toute ecriture : aucun lot, jamais de 500
  const csvOk = Buffer.from(csvDe([ligneCsv("R1"), ligneCsv("R2")]));
  const avant6 = await instantane();
  const refus: Array<[string, Promise<{ status: number; body: { code?: string; error?: string } }>, number, string]> = [
    ["CSV declare geojson", post(csvOk, { format: "geojson" }), 400, "FORMAT_INCOHERENT"],
    ["GeoJSON declare csv", post(JSON.stringify({ type: "FeatureCollection", features: [] }), { format: "csv" }), 400, "FORMAT_INCOHERENT"],
    ["binaire aleatoire", post(Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) % 256)), { format: "csv" }), 400, "FORMAT_INCOHERENT"],
    ["octet Latin-1 (Excel FR)", post(Buffer.concat([Buffer.from(`${ENTETE}\nONR_BDR;comptage;E1;RN1;;caf`), Buffer.from([0xe9]), Buffer.from("\n")])), 400, "ENCODAGE_NON_UTF8"],
    ["UTF-16 avec BOM", post(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csvOk.toString(), "utf16le")])), 400, "ENCODAGE_NON_UTF8"],
    ["fichier vide", post(""), 400, "FICHIER_VIDE"],
    ["TROP_DE_LIGNES (CSV)", post(csvDe(Array.from({ length: LIMITE_LIGNES + 1 }, (_, i) => ligneCsv(`T${i}`))), {}, "trop.csv"), 400, "TROP_DE_LIGNES"],
    ["TROP_DE_LIGNES (GeoJSON, features null)", post(JSON.stringify({ type: "FeatureCollection", features: Array.from({ length: LIMITE_LIGNES + 1 }, () => null) }), { format: "geojson" }, "t.geojson"), 400, "TROP_DE_LIGNES"],
    ["autorisationRef trop courte", post(csvOk, { autorisationRef: "x" }), 400, "CHAMPS_INVALIDES"],
    ["autorisationRef avec retour a la ligne", post(csvOk, { autorisationRef: "AUT\n2026-01" }), 400, "CHAMPS_INVALIDES"],
    ["NUL dans systemeSource", post(csvOk, { systemeSource: "ONR\u0000BDR" }), 400, "CHAMPS_INVALIDES"],
    ["NUL dans methodeSource", post(csvOk, { methodeSource: "a\u0000b" }), 400, "CHAMPS_INVALIDES"],
    ["dateSource -100000-01-01", post(csvOk, { dateSource: "-100000-01-01" }), 400, "CHAMPS_INVALIDES"],
    ["dateSource +275760-09-13", post(csvOk, { dateSource: "+275760-09-13" }), 400, "CHAMPS_INVALIDES"],
    ["format gpkg", post("x", { format: "gpkg" }), 400, "CHAMPS_INVALIDES"],
  ];
  const resultats = await Promise.all(refus.map(([, p]) => p));
  refus.forEach(([nom, , statut, code], i) => {
    const r = resultats[i];
    verifier(`6. ${nom} : ${statut} ${code}, jamais un 500`, r.status === statut && r.body.code === code, { statut: r.status, corps: r.body });
  });
  verifier("6. TOUS ces refus : aucun lot, aucune ligne, aucun audit, aucune table modifiee", differences(avant6, await instantane()).length === 0, differences(avant6, await instantane()));
  const e1 = await post(csvOk, { format: "geojson" });
  const e1bis = await post(csvOk, { format: "csv" });
  verifier("6. piege E1 ferme : le CSV envoye en geojson (400) n'a pas cree de lot REJETE, et les memes octets avec le bon format donnent un vrai lot VALIDE_SCHEMA (201, pas un dejaRecu REJETE)",
    e1.status === 400 && e1bis.status === 201 && e1bis.body.statut === "VALIDE_SCHEMA" && e1bis.body.dejaRecu === false, e1bis.body);
  const bom = await post(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvDe([ligneCsv("BOM1")]))]), {}, "bom.csv");
  verifier("6. le BOM UTF-8 est accepte", bom.status === 201 && bom.body.compteurs.validees === 1);

  // ---------------------------------------------------------------- 7. NUL, substituts, profondeur : la LIGNE est rejetee
  const avant7 = await lots();
  const nul = await post(csvDe([ligneCsv("N1"), ligneCsv("N2", "avant\u0000apres"), ligneCsv("N3")]), {}, "nul.csv");
  const lignesNul = await prisma.$queryRawUnsafe<{ numeroLigne: number; statut: string; motifRejet: string | null; note: string }[]>(
    `SELECT "numeroLigne", statut::text, "motifRejet", "chargeOriginale"->>'note' note FROM lignes_import WHERE "lotId"='${nul.body.id}' ORDER BY 1`);
  verifier("7. un NUL dans une cellule : le lot est enregistre (201), SEULE la ligne fautive est REJETEE avec son motif, la charge est conservee avec le marqueur U+2400",
    nul.status === 201 && lignesNul.map((l) => l.statut).join() === "VALIDEE,REJETEE,VALIDEE" && /colonne « note ».*NUL/.test(lignesNul[1].motifRejet ?? "") && lignesNul[1].note === "avant␀apres", lignesNul);
  const gjSpecial = { type: "FeatureCollection", features: [
    { type: "Feature", geometry: null, properties: { systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: "G1\u0000" } },
    { type: "Feature", geometry: null, properties: { systeme_source: "ONR\u0000", type_objet: "comptage", identifiant_source: "G2" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-13.6, 9.6, 52.4] }, properties: { systeme_source: "ONR_BDR", type_objet: "ouvrage", identifiant_source: "G3" } },
  ] };
  let profond: unknown = "fond";
  for (let i = 0; i < 4000; i += 1) profond = [profond];
  const brutGj = JSON.stringify({ type: "FeatureCollection", features: [
    ...gjSpecial.features,
    { type: "Feature", geometry: null, properties: { systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: "G4", cache: profond } },
  ] }).replace('"G2"', '"G2\\ud800"');
  const gj = await post(brutGj, { format: "geojson" }, "special.geojson");
  const lignesGj = await prisma.$queryRawUnsafe<{ statut: string }[]>(`SELECT statut::text FROM lignes_import WHERE "lotId"='${gj.body.id}' ORDER BY "numeroLigne"`);
  verifier("7. GeoJSON : NUL dans un identifiant, dans une source, substitut isole, propriete a 4 000 niveaux : lignes REJETEES ; une coordonnee 3D est ACCEPTEE (altitude ecartee) ; jamais de 500",
    gj.status === 201 && lignesGj.map((l) => l.statut).join() === "REJETEE,REJETEE,VALIDEE,REJETEE", { statut: gj.status, lignes: lignesGj });
  const entNul = await post("systeme_source;type_objet;identifiant_source;co\u0000l\nONR_BDR;comptage;A;x\n", {}, "entete-nul.csv");
  verifier("7. un NUL dans l'en-tete : lot REJETE avec son motif (201), pas un 500", entNul.status === 201 && entNul.body.statut === "REJETE" && /en-tete/.test(entNul.body.motifRejetLot));
  verifier("7. aucun de ces envois n'a ete perdu : 3 lots de plus (NUL de cellule, GeoJSON special, NUL d'en-tete)", (await lots()) - avant7 === 3, { delta: (await lots()) - avant7 });
  const dup = await post("systeme_source;type_objet;identifiant_source;type_objet\nONR_BDR;comptage;A;troncon\n", {}, "dup.csv");
  verifier("7. colonne dupliquee dans l'en-tete : lot REJETE, la derniere valeur ne gagne plus en silence", dup.body.statut === "REJETE" && /plusieurs fois/.test(dup.body.motifRejetLot));
  const dates = await post(["systeme_source;type_objet;identifiant_source;date_source", "ONR_BDR;comptage;D1;2026-02-30", "ONR_BDR;comptage;D2;05/10/2026", ""].join("\n"), {}, "dates.csv");
  verifier("7. date_source 2026-02-30 : ligne rejetee avec motif (ISO strict)", dates.body.compteurs?.rejetees === 2 && dates.body.compteurs?.validees === 0, dates.body);

  // ---------------------------------------------------------------- 8. Idempotence, metadonnees, sources
  const avant8 = await instantane();
  const rejeu = await post(Buffer.from(csvDe([ligneCsv("A1"), ligneCsv("A2"), ligneCsv("A1"), "ONR_BDR;route;X;RN1;;"])), { autorisationRef: "AUT-AUTRE-999", versionMapping: "v9", methodeSource: "autre methode" }, "renomme.csv", T.admin);
  verifier("8. meme fichier, autres metadonnees : 200 dejaRecu, les trois differences sont DITES et les anciennes valeurs conservees en base",
    rejeu.status === 200 && rejeu.body.dejaRecu === true && rejeu.body.id === a1.id && rejeu.body.metadonneesDifferentes.map((m: { champ: string }) => m.champ).join() === "autorisationRef,versionMapping,methodeSource"
    && rejeu.body.metadonneesDifferentes[0].conserve === "AUT-2026-001" && await compter(`SELECT count(*) n FROM lots_import WHERE id='${a1.id}' AND "autorisationRef"='AUT-2026-001' AND "versionMapping"='v1'`) === 1, rejeu.body.metadonneesDifferentes);
  verifier("8. ... et ce rejeu n'a ecrit RIEN (aucune table)", differences(avant8, await instantane()).length === 0);
  const autre = await post(Buffer.from(csvDe([ligneCsv("A1"), ligneCsv("A2"), ligneCsv("A1"), "ONR_BDR;route;X;RN1;;"])), { systemeSource: "Anasur Test", autorisationRef: "AUT-2026-777" }, "meme-contenu.csv");
  verifier("8. memes octets, AUTRE source : nouveau lot (201) signale par memeEmpreinteAutresSources, non bloquant",
    autre.status === 201 && autre.body.memeEmpreinteAutresSources.some((s: { reference: string; systemeSource: string }) => s.reference === a1.reference && s.systemeSource === "ONR_BDR"), autre.body.memeEmpreinteAutresSources);
  const variante = await post(Buffer.from(csvDe([ligneCsv("A1"), ligneCsv("A2"), ligneCsv("A1"), "ONR_BDR;route;X;RN1;;"])), { systemeSource: "ONR_bdr" }, "casse.csv");
  verifier("8. source qui ne differe que par la casse : la valeur est stockee telle quelle ET un avertissement nomme le lot d'origine",
    variante.status === 201 && await compter(`SELECT count(*) n FROM lots_import WHERE id='${variante.body.id}' AND "systemeSource"='ONR_bdr'`) === 1 && variante.body.avertissements.some((a: string) => /casse ou les espaces/.test(a)), variante.body.avertissements);
  const plusieurs = await post(Buffer.from(csvDe([ligneCsv("MUL1")])), {}, "meme-nom.csv");
  const plusieurs2 = await post(Buffer.from(csvDe([ligneCsv("MUL2")])), {}, "meme-nom.csv");
  verifier("8. meme nom de fichier, contenu different : deux lots distincts", plusieurs.status === 201 && plusieurs2.status === 201 && plusieurs.body.id !== plusieurs2.body.id);
  const usurpation = await post(Buffer.from(csvDe([ligneCsv("USURP")])), { importeParId: comptes.admin.id }, "usurpation.csv");
  verifier("8. importeParId falsifie dans le corps : ignore, l'importateur est l'utilisateur authentifie (en base ET dans l'audit)",
    await compter(`SELECT count(*) n FROM lots_import WHERE id='${usurpation.body.id}' AND "importeParId"='${comptes.chef.id}'`) === 1
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityId"='${usurpation.body.id}' AND "userId"='${comptes.chef.id}'`) === 1);
  const nomAccent = await post(Buffer.from(csvDe([ligneCsv("ACC1")])), {}, "relevé-été.csv");
  const nomHostile = await post(Buffer.from(csvDe([ligneCsv("ACC2")])), {}, "../../etc/passwd.csv");
  const noms = await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT "nomFichier" n FROM lots_import WHERE id IN ('${nomAccent.body.id}','${nomHostile.body.id}') ORDER BY "nomFichier"`);
  verifier("8. nom de fichier : l'accent arrive intact (multer decodait en latin1), un nom de chemin est reduit a son dernier element", noms.map((x) => x.n).join() === "passwd.csv,relevé-été.csv", noms);

  // ---------------------------------------------------------------- 9. Acces
  const routes = ["", "/meta", "/sources", `/${a1.id}`, `/${a1.id}/apercu`, `/${a1.id}/erreurs.csv`];
  const avant9 = await instantane();
  let refuses = 0; let essais = 0; const fuites: string[] = [];
  for (const role of ["lecteur", "inspecteur"] as const) {
    for (const r of routes) { essais += 1; const rep = await get(r, T[role]); if (rep.status === 403) refuses += 1; else fuites.push(`${role} GET ${r} -> ${rep.status}`); }
    essais += 1; const rp = await post(csvOk, {}, "x.csv", T[role]); if (rp.status === 403) refuses += 1; else fuites.push(`${role} POST -> ${rp.status}`);
  }
  verifier("9. LECTEUR et INSPECTEUR : 403 sur les 6 routes GET et sur POST (14 requetes), sans jeton 401", refuses === essais && (await request(app).get(BASE)).status === 401 && (await request(app).get(`${BASE}/meta`)).status === 401, fuites);
  verifier("9. ADMIN et GESTIONNAIRE lisent (200)", (await get("", T.admin)).status === 200 && (await get("/meta", T.chef)).status === 200);
  verifier("9. ces refus n'ont ecrit rien", differences(avant9, await instantane()).length === 0);

  // ---------------------------------------------------------------- 10. Saturation : jamais de 500 ni de 409, un autre utilisateur est servi
  const gros = (graine: number) => csvDe(Array.from({ length: 2500 }, (_, i) => ligneCsv(`S${graine}-${i}`, "commentaire de releve numero " + i)));
  const t0 = Date.now();
  const rafale = Array.from({ length: 10 }, (_, i) => post(Buffer.from(gros(i)), {}, `rafale-${i}.csv`, i % 2 ? T.admin : T.chef));
  const pendant: Array<{ statut: number; ms: number }> = [];
  const sonde = (async () => {
    for (let k = 0; k < 6; k += 1) { const s = Date.now(); const r = await get("/meta", T.admin); pendant.push({ statut: r.status, ms: Date.now() - s }); await new Promise((r2) => setTimeout(r2, 400)); }
  })();
  const reps = await Promise.all(rafale);
  await sonde;
  const dureeS = (Date.now() - t0) / 1000;
  const codes = reps.map((r) => r.status);
  verifier(`10. dix receptions de 2 500 lignes SIMULTANEES (${dureeS.toFixed(1)} s) : uniquement des 201 ou des 503 SERVICE_OCCUPE avec Retry-After, jamais de 500 ni de 409`,
    codes.every((c) => c === 201 || c === 503) && reps.filter((r) => r.status === 503).every((r) => r.body.code === "SERVICE_OCCUPE" && r.headers["retry-after"]) && codes.includes(201), codes);
  verifier("10. chaque 201 a ses 2 500 lignes et chaque 503 n'a laisse aucun lot (7 + lots de rafale = receptions reussies)",
    (await Promise.all(reps.filter((r) => r.status === 201).map((r) => compter(`SELECT count(*) n FROM lignes_import WHERE "lotId"='${r.body.id}'`)))).every((n) => n === 2500)
    && await compter(`SELECT count(*) n FROM lots_import WHERE "nomFichier" LIKE 'rafale-%'`) === codes.filter((c) => c === 201).length);
  verifier("10. pendant la rafale, un autre utilisateur lit /meta : toujours 200, sans attendre la fin des receptions",
    pendant.every((p) => p.statut === 200) && Math.max(...pendant.map((p) => p.ms)) < 3000, pendant);

  // ---------------------------------------------------------------- 11. Bilan
  const avantBilan = await instantane();
  const toutesLesLectures = [(await get("")), await get("/meta"), await get("/sources"), await get(`/${a1.id}`), await get(`/${a1.id}/apercu`), await get(`/${a1.id}/erreurs.csv`)];
  verifier("11. bilan : la derniere serie de lectures n'a modifie aucune table du referentiel ni aucune autre", toutesLesLectures.every((r) => r.status === 200) && differences(avantBilan, await instantane()).length === 0);
  const refInchange = ["troncons", "portions", "defauts", "observations", "ouvrages"].every((t) => avantReceptions[t] === avantBilan[t]);
  verifier("11. bilan : troncons, portions, defauts, observations, ouvrages : comptes identiques a ceux d'avant le premier lot", refInchange, ["troncons", "portions", "defauts", "observations", "ouvrages"].map((t) => [t, avantReceptions[t], avantBilan[t]]));
  const modifie = differences(avantReceptions, avantBilan);
  verifier("11. bilan : depuis le debut du banc, seules lots_import, lignes_import, audit_logs ont grossi (hors users, cree par le banc)", JSON.stringify(modifie.filter((t) => t !== "users")) === JSON.stringify(["audit_logs", "lignes_import", "lots_import"]), modifie);
  verifier("11. bilan : autant d'audits LotImport que de lots (aucun lot sans trace, aucun refus audite a tort)", await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='LotImport'`) === await lots());

  conclure();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); await banc.fermer(); });
