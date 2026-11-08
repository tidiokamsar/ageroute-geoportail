// Banc d'integration de l'import BDR/ANASUR (scenario d'acceptation A28 : import idempotent, 100 % des
// lignes dans un statut). Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/import.integration.mts
//
// Le fichier passe par la route reelle `POST /api/v2/imports` (multipart, jeton signe, role lu en base),
// l'orchestration reelle (`import.service.ts`) et les contraintes reelles de `lots_import` /
// `lignes_import`, dans un clone PostGIS jetable. Le CSV est fabrique a partir d'un MODELE du banc qui
// connait, ligne par ligne, le statut attendu : l'oracle est ecrit AVANT le code qu'il juge, il n'en
// reprend aucune regle.
//
// Perimetre honnete : l'etape 1 seulement (reception, empreinte, verification de schema, statut par
// ligne). L'application au referentiel n'existe pas (aucun rapprochement d'identifiants, aucun
// echantillon approuve) : le banc verifie donc aussi qu'AUCUNE ecriture n'atteint le referentiel.
import { createHash } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_import");
const { prisma } = await banc.imp("lib/prisma");
const { apiV2Router } = await banc.imp("api-v2/index");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/v2", apiV2Router);
app.use(errorHandler);

const compter = async (sql: string): Promise<number> => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Statut = "VALIDEE" | "REJETEE" | "IGNOREE";
interface LigneModele { cols: string[]; attendu: Statut; motif?: string }

const ENTETE = ["systeme_source", "type_objet", "identifiant_source", "code_route", "debut_m", "fin_m", "geometrie", "date_source", "commentaire"];
const LS = (c: [number, number][]) => JSON.stringify({ type: "LineString", coordinates: c });
const PT = (lon: number, lat: number) => JSON.stringify({ type: "Point", coordinates: [lon, lat] });
const citer = (v: string) => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvDe = (lignes: LigneModele[], entete = ENTETE) => [entete.join(";"), ...lignes.map((l) => l.cols.map(citer).join(";"))].join("\n") + "\n";
const ligne = (type: string, id: string, extra: Partial<Record<string, string>> = {}, attendu: Statut = "VALIDEE", motif?: string): LigneModele => ({
  cols: ENTETE.map((c) => ({ systeme_source: "ONR_BDR", type_objet: type, identifiant_source: id, code_route: "RN1", debut_m: "", fin_m: "", geometrie: "", date_source: "", commentaire: "", ...extra })[c] ?? ""),
  attendu, motif,
});
/** Une ligne valide dont la forme depend du type, pour que le lot melange vraiment les cas. */
function valide(p: number): LigneModele {
  const id = `L-${String(p).padStart(5, "0")}`;
  switch (p % 5) {
    case 0: return ligne("troncon", id, { geometrie: LS([[-13.60 + p * 1e-5, 9.64], [-13.59 + p * 1e-5, 9.65]]), date_source: "2026-09-15" });
    case 1: return ligne("portion", id, { debut_m: "0", fin_m: String(100 + p), commentaire: "portion; avec point-virgule" });
    case 2: return ligne("degradation", id, { geometrie: PT(-13.595, 9.645), debut_m: "10,5", fin_m: "20,5" });   // virgule decimale
    case 3: return ligne("ouvrage", id, { geometrie: PT(-13.6, 9.6), commentaire: 'pont "Kaloum" ' });
    default: return ligne("comptage", id, { commentaire: "multi\nligne" });                                          // saut de ligne DANS un champ cite
  }
}
const DEFAUTS_SCHEMA: Array<[() => LigneModele, string]> = [
  [() => ligne("troncon", "", { geometrie: LS([[-13.6, 9.6], [-13.5, 9.7]]) }, "REJETEE"), "identifiant_source manquant"],
  [() => ligne("route", "X-1", {}, "REJETEE"), "type_objet absent ou inconnu"],
  [() => ligne("troncon", "X-2", { geometrie: LS([[7500000, 1100000], [7500100, 1100100]]) }, "REJETEE"), "hors de l'etendue WGS 84"],
  [() => ligne("portion", "X-3", { debut_m: "200", fin_m: "100" }, "REJETEE"), "emprise incoherente"],
  [() => ligne("portion", "X-4", { debut_m: "10" }, "REJETEE"), "ensemble"],
  [() => ligne("troncon", "X-5", { geometrie: "{pas du json" }, "REJETEE"), "JSON invalide"],
  [() => ligne("troncon", "X-6", { geometrie: PT(-13.6, 9.6), date_source: "pas une date" }, "REJETEE"), "date_source non interpretable"],
  [() => ligne("ouvrage", "X-7", {}, "REJETEE"), "sans geometrie"],
  [() => ligne("troncon", "X-8", { geometrie: JSON.stringify({ type: "Polygon", coordinates: [] }) }, "REJETEE"), "non admis"],
  [() => ligne("portion", "X-9", {}, "REJETEE"), "sans emprise ni geometrie"],
];

/** Lot de 100 lignes : 80 valides, 10 invalides (p % 10 == 0), 10 doublons internes (p % 10 == 5). */
function lotDe100(): LigneModele[] {
  const lignes: LigneModele[] = [];
  let k = 0;
  for (let p = 1; p <= 100; p++) {
    if (p % 10 === 0) { const [f, m] = DEFAUTS_SCHEMA[k++ % DEFAUTS_SCHEMA.length]; const l = f(); l.motif = m; lignes.push(l); }
    else if (p % 10 === 5) { const o = lignes[p - 2]; lignes.push({ cols: [...o.cols], attendu: "IGNOREE", motif: "doublon dans le lot" }); }
    else lignes.push(valide(p));
  }
  return lignes;
}

async function envoyer(token: string, contenu: Buffer | string, opts: { nom?: string; format?: string; source?: string; sansAutorisation?: boolean } = {}) {
  const r = request(app).post("/api/v2/imports").set("Authorization", `Bearer ${token}`)
    .field("systemeSource", opts.source ?? "ONR_BDR").field("format", opts.format ?? "csv").field("methodeSource", "export fichier")
    .field("versionMapping", "v1");
  if (!opts.sansAutorisation) r.field("autorisationRef", "AUT-2026-001");
  return r.attach("fichier", Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu), { filename: opts.nom ?? "lot.csv", contentType: "text/csv" });
}

/** Compare, ligne par ligne, les statuts en base au modele du banc. */
async function compareAuModele(lotId: string, modele: LigneModele[]) {
  const enBase = await prisma.$queryRawUnsafe<{ numeroLigne: number; statut: string; motifRejet: string | null }[]>(
    `SELECT "numeroLigne", statut::text, "motifRejet" FROM lignes_import WHERE "lotId"='${lotId}' ORDER BY "numeroLigne"`);
  const ecarts: unknown[] = [];
  modele.forEach((m, i) => {
    const b = enBase[i];
    if (!b || b.numeroLigne !== i + 1 || b.statut !== m.attendu || (m.motif && !(b.motifRejet ?? "").includes(m.motif))) ecarts.push({ ligne: i + 1, attendu: m.attendu, motif: m.motif, base: b });
  });
  return { ecarts, lignesEnBase: enBase.length };
}

async function invariantsDuLot(lotId: string) {
  const brut = (await prisma.$queryRawUnsafe<Record<string, number | string | bigint>[]>(`SELECT * FROM lots_import WHERE id='${lotId}'`))[0];
  const lot = Object.fromEntries(Object.entries(brut).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])) as Record<string, number | string>;
  const parStatut = Object.fromEntries((await prisma.$queryRawUnsafe<{ statut: string; n: bigint }[]>(`SELECT statut::text, count(*) n FROM lignes_import WHERE "lotId"='${lotId}' GROUP BY 1`)).map((r) => [r.statut, Number(r.n)]));
  const total = Object.values(parStatut).reduce((a, b) => a + b, 0);
  return {
    lot, parStatut, total,
    compteursVrais: Number(lot.lignesLues) === total
      && Number(lot.lignesValidees) === (parStatut.VALIDEE ?? 0) && Number(lot.lignesRejetees) === (parStatut.REJETEE ?? 0)
      && Number(lot.lignesIgnorees) === (parStatut.IGNOREE ?? 0) && Number(lot.lignesImportees) === 0 && Number(lot.lignesEnConflit) === 0,
  };
}

async function main() {
  // ---------------------------------------------------------------- Fixtures
  const admin = await prisma.user.create({ data: { email: "admin@banc.invalid", nomComplet: "Admin banc", passwordHash: "x", role: "ADMIN" } });
  const chef = await prisma.user.create({ data: { email: "chef@banc.invalid", nomComplet: "Chef banc", passwordHash: "x", role: "GESTIONNAIRE" } });
  const lecteur = await prisma.user.create({ data: { email: "lecteur@banc.invalid", nomComplet: "Lecteur banc", passwordHash: "x", role: "LECTEUR" } });
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const tAdmin = jeton(admin), tChef = jeton(chef), tLecteur = jeton(lecteur);

  const referentiel = async () => [
    await compter(`SELECT count(*) n FROM troncons`), await compter(`SELECT count(*) n FROM portions`),
    await compter(`SELECT count(*) n FROM defauts`), await compter(`SELECT count(*) n FROM observations`), await compter(`SELECT count(*) n FROM ouvrages`),
  ].join("/");
  const referentielAvant = await referentiel();
  const etat = async () => [await compter(`SELECT count(*) n FROM lots_import`), await compter(`SELECT count(*) n FROM lignes_import`), await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='LotImport'`)].join("/");

  console.log("\n== A28 : import idempotent, 100 % des lignes dans un statut ==");

  // --- 1. Un lot de 100 lignes melangeant valides, invalides et doublons.
  const modele1 = lotDe100();
  const csv1 = Buffer.from(csvDe(modele1));
  const r1 = await envoyer(tChef, csv1, { nom: "bdr-2026-10.csv" });
  const lot1 = r1.body;
  verifier("1. le lot de 100 lignes est recu (201) avec 80 validees, 10 rejetees, 10 ignorees, 0 importee",
    r1.status === 201 && lot1.statut === "VALIDE_SCHEMA" && lot1.compteurs.lues === 100 && lot1.compteurs.validees === 80
    && lot1.compteurs.rejetees === 10 && lot1.compteurs.ignorees === 10 && lot1.compteurs.importees === 0, r1.body);
  const inv1 = await invariantsDuLot(lot1.id);
  verifier("1. 100 % des lignes dans un statut : 100 lignes en base, somme des statuts = lignesLues, compteurs egaux aux comptes reels",
    inv1.total === 100 && inv1.compteursVrais, inv1);
  const cmp1 = await compareAuModele(lot1.id, modele1);
  verifier("1. chacune des 100 lignes porte le statut que le modele du banc lui assigne (et le bon motif), numerotee 1..100 sans trou", cmp1.ecarts.length === 0 && cmp1.lignesEnBase === 100, cmp1.ecarts.slice(0, 3));
  verifier("1. aucun statut nul, tout rejet est motive, la charge originale est conservee pour les 100 lignes",
    await compter(`SELECT count(*) n FROM lignes_import WHERE "lotId"='${lot1.id}' AND statut IS NULL`) === 0
    && await compter(`SELECT count(*) n FROM lignes_import WHERE "lotId"='${lot1.id}' AND statut='REJETEE' AND (btrim(coalesce("motifRejet",'')) = '')`) === 0
    && await compter(`SELECT count(*) n FROM lignes_import WHERE "lotId"='${lot1.id}' AND "chargeOriginale" IS NOT NULL`) === 100);
  verifier("1. l'empreinte est le SHA-256 des octets recus (calcule independamment par le banc)", inv1.lot.empreinteFichier === sha(csv1));
  verifier("1. l'importateur est l'utilisateur authentifie, le lot est audite une fois (CREATE LotImport)",
    inv1.lot.importeParId === chef.id && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='LotImport' AND "entityId"='${lot1.id}' AND "userId"='${chef.id}'`) === 1);
  const sautLigne = await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT "chargeOriginale"->>'commentaire' c FROM lignes_import WHERE "lotId"='${lot1.id}' AND "numeroLigne"=4`);
  verifier("1. un champ cite qui contient un saut de ligne reste UNE ligne, intact (lecture CSV conforme a la RFC 4180)", sautLigne[0]?.c === "multi\nligne", sautLigne);

  // --- 2. Rejeu du meme fichier.
  const avant2 = await etat();
  const r2 = await envoyer(tChef, csv1, { nom: "copie-renommee.csv" });
  verifier("2. le meme fichier (renomme) rend le lot existant : 200, dejaRecu, meme identifiant, memes compteurs",
    r2.status === 200 && r2.body.dejaRecu === true && r2.body.id === lot1.id && r2.body.compteurs.lues === 100, r2.body);
  verifier("2. ... et AUCUNE ecriture : memes nombres de lots, de lignes et d'audits", (await etat()) === avant2, { avant2, apres: await etat() });
  const r2b = await envoyer(tAdmin, csv1);
  verifier("2. rejoue par un autre importateur : meme lot, toujours rien d'ecrit", r2b.status === 200 && r2b.body.id === lot1.id && (await etat()) === avant2);
  const r2c = await envoyer(tChef, csv1, { source: "ANASUR_COLLECT" });
  verifier("2. la cle d'idempotence est (source, empreinte) : le meme fichier d'une AUTRE source est un autre lot", r2c.status === 201 && r2c.body.id !== lot1.id);

  // --- 3. Lot partiellement modifie : 90 lignes identiques, 5 modifiees, 5 nouvelles.
  const modele3 = modele1.map((l, i) => (i % 20 === 1 && l.attendu === "VALIDEE" ? ligne(l.cols[1], l.cols[2], { commentaire: "corrige apres relecture" }) : l));
  for (let p = 101; p <= 105; p++) modele3.push(valide(p));
  const avantRef3 = await referentiel();
  const r3 = await envoyer(tChef, csvDe(modele3), { nom: "bdr-2026-10-rev2.csv" });
  const cmp3 = await compareAuModele(r3.body.id, modele3);
  const inv3 = await invariantsDuLot(r3.body.id);
  verifier("3. un lot partiellement modifie est un NOUVEAU lot (octets differents), recu en entier : 105 lignes, chacune dans le statut attendu",
    r3.status === 201 && r3.body.id !== lot1.id && inv3.total === 105 && inv3.compteursVrais && cmp3.ecarts.length === 0, { total: inv3.total, ecarts: cmp3.ecarts.slice(0, 2) });
  const inv1bis = await invariantsDuLot(lot1.id);
  verifier("3. le premier lot est INTACT apres le second : memes lignes, memes statuts, memes compteurs (aucune ligne perdue ni dupliquee)",
    inv1bis.total === 100 && inv1bis.compteursVrais && JSON.stringify(inv1bis.parStatut) === JSON.stringify(inv1.parStatut));
  verifier("3. la ligne modifiee est conservee sous ses DEUX etats, un par lot (rien n'est ecrase)",
    await compter(`SELECT count(DISTINCT "chargeOriginale"->>'commentaire') n FROM lignes_import WHERE "identifiantSource"='${modele3.find((l, i) => i % 20 === 1 && l.attendu === "VALIDEE")!.cols[2]}'`) === 2);
  verifier("3. aucune ecriture dans le referentiel (troncons, portions, defauts, observations, ouvrages inchanges)", (await referentiel()) === avantRef3 && avantRef3 === referentielAvant, { avantRef3, referentielAvant });

  // --- 4. Erreurs exportables.
  const rE = await request(app).get(`/api/v2/imports/${lot1.id}/erreurs.csv`).set("Authorization", `Bearer ${tChef}`);
  const lignesErreur = rE.text.trim().split("\n");
  verifier("4. l'export d'erreurs contient exactement les 20 lignes rejetees ou ignorees + son en-tete",
    rE.status === 200 && lignesErreur.length === 21 && lignesErreur[0].startsWith("numero_ligne;statut;motif"), { lignes: lignesErreur.length });
  verifier("4. chaque ligne exportee nomme son numero, son statut et son motif ; les 10 rejets et les 10 doublons y sont",
    lignesErreur.slice(1).filter((l) => l.includes(";REJETEE;")).length === 10 && lignesErreur.slice(1).filter((l) => l.includes(";IGNOREE;")).length === 10);

  // --- 5. Des fichiers qui ne donnent pas de lignes : le lot est enregistre REJETE, avec son motif.
  const r5a = await envoyer(tChef, csvDe([ligne("route", "A"), ligne("troncon", "")]), { nom: "tout-rejete.csv" });
  verifier("5. aucune ligne conforme : lot REJETE (201), 2 lignes toutes REJETEE avec motif, compteurs coherents",
    r5a.status === 201 && r5a.body.statut === "REJETE" && r5a.body.compteurs.rejetees === 2 && (await invariantsDuLot(r5a.body.id)).compteursVrais);
  const r5b = await envoyer(tChef, "systeme_source;type_objet\nONR_BDR;troncon\n", { nom: "colonne-absente.csv" });
  verifier("5. colonne obligatoire absente : lot REJETE avec son motif, 0 ligne, la contrainte de compteurs tient", r5b.status === 201 && r5b.body.statut === "REJETE" && /identifiant_source/.test(r5b.body.motifRejetLot ?? "") && r5b.body.compteurs.lues === 0);
  const geoCrs = JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "EPSG:3857" } }, features: [{ type: "Feature", geometry: null, properties: { systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: "G1" } }] });
  const r5c = await envoyer(tChef, geoCrs, { format: "geojson", nom: "crs.geojson" });
  verifier("5. GeoJSON en EPSG:3857 : tout le fichier est refuse (lot REJETE), jamais « probablement 4326 »", r5c.status === 201 && r5c.body.statut === "REJETE" && /CRS/.test(r5c.body.motifRejetLot ?? ""));
  const avant5d = await etat();
  const r5d = await envoyer(tChef, "", { nom: "vide.csv" });
  verifier("5. fichier vide : 400, rien d'ecrit", r5d.status === 400 && (await etat()) === avant5d, { statut: r5d.status });

  // --- 6. CSV hors norme : colonnes en trop ou en moins, ligne vide, commentaire.
  const lignesBrutes = [
    ENTETE.join(";"),
    "# commentaire du fichier source",
    "",
    "ONR_BDR;comptage;R-1;RN1;;;;;ok",
    "ONR_BDR;comptage;R-2;RN1;;;;;ok;colonne;en;trop",                 // plus de colonnes que l'en-tete
    "ONR_BDR;comptage;R-3",                                             // moins de colonnes que l'en-tete
    "ONR_BDR;comptage;R-4;RN1;;;;;ok",
  ].join("\n") + "\n";
  const r6 = await envoyer(tChef, lignesBrutes, { nom: "hors-norme.csv" });
  const lignes6 = await prisma.$queryRawUnsafe<{ numeroLigne: number; statut: string; motifRejet: string | null; identifiantSource: string | null }[]>(
    `SELECT "numeroLigne", statut::text, "motifRejet", "identifiantSource" FROM lignes_import WHERE "lotId"='${r6.body.id}' ORDER BY 1`);
  verifier("6. 4 lignes de donnees (commentaire et ligne vide ne sont pas des enregistrements), chacune dans un statut", r6.status === 201 && lignes6.length === 4 && (await invariantsDuLot(r6.body.id)).compteursVrais, lignes6);
  verifier("6. une ligne avec des colonnes EN TROP n'est pas acceptee en silence tronquee : elle est REJETEE avec un motif de nombre de colonnes",
    lignes6[1]?.statut === "REJETEE" && /colonnes/.test(lignes6[1]?.motifRejet ?? ""), lignes6[1]);
  verifier("6. une ligne avec des colonnes EN MOINS est REJETEE de meme (champs obligatoires absents)", lignes6[2]?.statut === "REJETEE", lignes6[2]);
  verifier("6. les lignes saines autour d'elles sont VALIDEE (R-1 et R-4)", lignes6[0]?.statut === "VALIDEE" && lignes6[3]?.statut === "VALIDEE");

  // --- 7. GeoJSON : 50 entites avec doublons, geometries nulles et rejets.
  const feats = Array.from({ length: 50 }, (_, i) => {
    const p = i + 1;
    const dup = p % 10 === 0;
    const id = dup ? `G-${String(p - 1).padStart(3, "0")}` : `G-${String(p).padStart(3, "0")}`;
    const invalide = p % 10 === 3;
    return { type: "Feature", geometry: p % 7 === 0 ? null : { type: "Point", coordinates: invalide ? [999, 9.6] : [-13.6, 9.6] },
      properties: { systeme_source: "ONR_BDR", type_objet: "comptage", identifiant_source: id } };
  });
  const attendu7: Statut[] = feats.map((_, i) => (((i + 1) % 10 === 3) ? "REJETEE" : ((i + 1) % 10 === 0 ? "IGNOREE" : "VALIDEE")));
  const r7 = await envoyer(tChef, JSON.stringify({ type: "FeatureCollection", features: feats }), { format: "geojson", nom: "bdr.geojson" });
  const l7 = await prisma.$queryRawUnsafe<{ statut: string }[]>(`SELECT statut::text FROM lignes_import WHERE "lotId"='${r7.body.id}' ORDER BY "numeroLigne"`);
  verifier("7. GeoJSON de 50 entites : chacune dans le statut attendu (rejet hors etendue, doublon interne, valides), compteurs vrais",
    r7.status === 201 && l7.length === 50 && l7.every((x, i) => x.statut === attendu7[i]) && (await invariantsDuLot(r7.body.id)).compteursVrais, l7.map((x) => x.statut).join(","));

  // --- 8. Concurrence.
  const csvC = Buffer.from(csvDe(Array.from({ length: 30 }, (_, i) => valide(i + 1))));
  const avant8 = await compter(`SELECT count(*) n FROM lots_import`);
  const memes = await Promise.all([1, 2, 3, 4].map((i) => envoyer(i % 2 ? tChef : tAdmin, csvC, { nom: `c${i}.csv` })));
  verifier("8. le MEME fichier envoye 4 fois en meme temps : un seul lot cree, jamais d'erreur serveur (201 une fois, 200 pour les autres)",
    memes.every((r) => r.status === 200 || r.status === 201) && memes.filter((r) => r.status === 201).length === 1
    && await compter(`SELECT count(*) n FROM lots_import`) === avant8 + 1, memes.map((r) => r.status));
  verifier("8. ... avec ses 30 lignes une seule fois", await compter(`SELECT count(*) n FROM lignes_import WHERE "lotId"='${memes.find((r) => r.status === 201)!.body.id}'`) === 30
    && new Set(memes.map((r) => r.body.id)).size === 1);
  const differents = await Promise.all([1, 2, 3, 4].map((i) => envoyer(tChef, csvDe(Array.from({ length: 10 }, (_, k) => valide(1000 * i + k))), { nom: `d${i}.csv` })));
  verifier("8. QUATRE fichiers differents en meme temps : quatre lots, quatre references distinctes, aucune erreur serveur",
    differents.every((r) => r.status === 201) && new Set(differents.map((r) => r.body.reference)).size === 4, differents.map((r) => [r.status, r.body.reference ?? r.body]));

  // --- 9. Atomicite : un echec au milieu de l'enregistrement des lignes n'en laisse AUCUNE.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION banc_coupure_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."numeroLigne" = 7 THEN RAISE EXCEPTION 'coupure simulee'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER banc_coupure_import BEFORE INSERT ON lignes_import FOR EACH ROW EXECUTE FUNCTION banc_coupure_import()`);
  const csvA = Buffer.from(csvDe(Array.from({ length: 20 }, (_, i) => valide(2000 + i))));
  const avant9 = await etat();
  const r9 = await envoyer(tChef, csvA, { nom: "coupe.csv" });
  verifier("9. une coupure pendant l'ecriture des lignes annule tout : ni lot, ni ligne, ni audit (transaction unique)", r9.status >= 500 && (await etat()) === avant9, { statut: r9.status });
  await prisma.$executeRawUnsafe(`DROP TRIGGER banc_coupure_import ON lignes_import`);
  const r9b = await envoyer(tChef, csvA, { nom: "coupe.csv" });
  verifier("9. le renvoi apres la coupure aboutit : un lot, 20 lignes", r9b.status === 201 && (await invariantsDuLot(r9b.body.id)).total === 20);

  // --- 10. Volume : 20 000 lignes.
  const gros = Array.from({ length: 20000 }, (_, i) => (i % 100 === 99 ? ligne("troncon", "", {}, "REJETEE") : valide(10000 + i)));
  const t0 = Date.now();
  const r10 = await envoyer(tChef, csvDe(gros), { nom: "gros.csv" });
  const dureeMs = Date.now() - t0;
  const inv10 = r10.body?.id ? await invariantsDuLot(r10.body.id) : null;
  verifier(`10. un lot de 20 000 lignes (${(dureeMs / 1000).toFixed(1)} s) : 19 800 validees + 200 rejetees, 100 % comptees, compteurs vrais`,
    r10.status === 201 && inv10?.total === 20000 && inv10.compteursVrais && r10.body.compteurs.rejetees === 200, { statut: r10.status, total: inv10?.total });

  // --- 11. Acces.
  verifier("11. un LECTEUR recoit 403, sans jeton 401, rien n'est ecrit",
    (await envoyer(tLecteur, csvC, { nom: "x.csv" })).status === 403 && (await request(app).post("/api/v2/imports")).status === 401);
  verifier("11. une demande sans reference d'autorisation est refusee (400) : aucun import sans autorisation ecrite", (await envoyer(tChef, csvC, { nom: "y.csv", sansAutorisation: true, source: "AUTRE_SRC" })).status === 400);
  verifier("11. format non admis : 400", (await envoyer(tChef, csvC, { format: "gpkg", nom: "z.gpkg" })).status === 400);

  // --- 12. Bilan : pour TOUS les lots du clone, la propriete d'A28 tient.
  const lots = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM lots_import`);
  let mauvais = 0;
  for (const l of lots) { const i = await invariantsDuLot(l.id); if (!i.compteursVrais) mauvais += 1; }
  verifier(`12. bilan : sur les ${lots.length} lots du banc, la somme des statuts de lignes egale lignesLues et chaque compteur egale le compte reel`, mauvais === 0 && lots.length >= 14, { lots: lots.length, mauvais });
  verifier("12. bilan : aucune ligne orpheline, aucune ligne sans lot", await compter(`SELECT count(*) n FROM lignes_import li LEFT JOIN lots_import l ON l.id=li."lotId" WHERE l.id IS NULL`) === 0);
  verifier("12. bilan : le referentiel patrimonial n'a recu aucune ecriture de l'import", (await referentiel()) === referentielAvant);
  verifier("12. bilan : autant d'audits LotImport que de lots", await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='LotImport'`) === lots.length);

  conclure();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); await banc.fermer(); });
