// Banc d'integration du lot X1 : EXPORT DU DOSSIER TECHNIQUE (archive ZIP, manifeste, confidentialite, derogation a usage unique) et TABLEAUX DE BORD
// (national, par territoire) contre un vrai PostGIS. Contrat : docs/projets-voirie/CONTRAT-EXPORTS.md. Voir tests-integration/README.md. Lancer
// (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/exports-tableaux.integration.mts
// Avec EXPORTS_EXEMPLES=<fichier.json>, des reponses reelles servant d'exemples a docs/projets-voirie/API.md y sont ecrites.
//
// Tout passe par les routes reelles (`createApp`), des jetons signes par des secrets aleatoires, le role, le module et le perimetre LUS EN BASE, le SQL reel
// (PostGIS), les contraintes et declencheurs reels, dans le clone jetable `essai_exports_x1` (la migration du lot X1 y est appliquee par le banc si `replay`
// ne la porte pas). L'archive est RELUE par le lecteur ZIP borne du module et ses empreintes verifiees.
//
// DONNEES 100 % SYNTHETIQUES : axes, cables et conduites inventes en metres dans le repere UTM 29N (origine arbitraire), transformes par PostGIS ; aucun
// plan, aucun operateur, aucune ville reels.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_exports_x1", { migrations: ["20261104200000_exports_tableaux_de_bord"] });
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const { inspecterZip, extraireEntree } = await banc.imp("projets-voirie/formats/zip.noyau");
const { verifierEmpreintes } = await banc.imp("projets-voirie/exports/manifeste.noyau");
const { ENTETE_CSV_CONFLITS } = await banc.imp("projets-voirie/conflits/dossiers.service");
const { _viderCadenceTableaux } = await banc.imp("projets-voirie/tableaux/tableau.service");
const { _ouvrirTentativePourBanc } = await banc.imp("projets-voirie/exports/dossier.service");
const request = (await import("supertest")).default;
const { Client } = (await import("pg")).default;

process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
const app = createApp();
const BASE = "/api/v2/projets-voirie";
const E0 = 380000, N0 = 1015000;
const LIMITES_ZIP = { entreesMax: 1000, tailleEntreeMax: 64 * 1024 * 1024, tailleTotaleMax: 256 * 1024 * 1024, tauxMax: 10_000, profondeurMax: 8 };

const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;
const compter = async (texte: string, ...v: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...v))[0].n);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function wgs(pts: [number, number][]): Promise<[number, number][]> {
  const wkt = `LINESTRING(${pts.map(([x, y]) => `${E0 + x} ${N0 + y}`).join(",")})`;
  const r = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, wkt);
  return JSON.parse(r[0].g).coordinates;
}
async function geojson(lignes: { nom: string; pts: [number, number][] }[]): Promise<Buffer> {
  const features = [];
  for (const l of lignes) features.push({ type: "Feature", properties: { name: l.nom, proprietaireInterne: "attribut source a ne pas exporter" }, geometry: { type: "LineString", coordinates: await wgs(l.pts) } });
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}
async function essaiAnnule(f: (tx: typeof prisma) => Promise<unknown>): Promise<string> {
  const ANNULE = new Error("annule");
  try { await prisma.$transaction(async (tx: typeof prisma) => { await f(tx); throw ANNULE; }); return "ok"; } catch (e) {
    if (e === ANNULE) return "ok";
    const meta = (e as { meta?: { code?: string } }).meta;
    return meta?.code ?? String(e).slice(0, 160);
  }
}
const binaire = (r: ReturnType<typeof request.get>) => r.buffer(true).parse((res, cb) => {
  const m: Buffer[] = []; res.on("data", (c: Buffer) => m.push(c)); res.on("end", () => cb(null, Buffer.concat(m)));
});
function relire(zip: Buffer): Map<string, Buffer> {
  const inv = inspecterZip(zip, LIMITES_ZIP);
  return new Map(inv.entrees.map((e: { nom: string }) => [e.nom, extraireEntree(zip, e)]));
}

const exemples: Record<string, unknown> = {};
async function issueDe(exportId: string | undefined, delaiMs = 8_000): Promise<string | null> {
  const fin = Date.now() + delaiMs;
  for (;;) {
    const l = exportId ? (await sql<{ s: string }>(`SELECT statut s FROM exports_dossier_projet_voirie WHERE id = $1`, exportId))[0] : undefined;
    if (l && l.s !== "EN_COURS") return l.s;
    if (Date.now() > fin) return l?.s ?? null;
    await new Promise((ok) => setTimeout(ok, 100));
  }
}
const attendreSansEnCours = async () => {
  const fin = Date.now() + 8_000;
  while (Date.now() < fin && Number((await sql<{ n: bigint }>(`SELECT count(*) n FROM exports_dossier_projet_voirie WHERE statut = 'EN_COURS' AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '2 minutes'`))[0].n) > 0) await new Promise((ok) => setTimeout(ok, 100));
};
const JUSTIF = "Controle effectue avec le chef de projet";

async function main() {
  // ================================================================ Fixtures
  const mk = (email: string, nomComplet: string, role: string, modules: string[] = ["projets-voirie"]) =>
    prisma.user.create({ data: { email, nomComplet, passwordHash: "x", role, modulesAutorises: modules } });
  const admin = await mk("admin@banc-x1.invalid", "Admin banc X1", "ADMIN", []);
  const chef = await mk("chef@banc-x1.invalid", "Gestionnaire banc X1", "GESTIONNAIRE");
  const chef2 = await mk("chef2@banc-x1.invalid", "Second gestionnaire X1", "GESTIONNAIRE");
  const lecteur = await mk("lecteur@banc-x1.invalid", "Lecteur banc X1", "LECTEUR");
  const inspecteur = await mk("insp@banc-x1.invalid", "Inspecteur banc X1", "INSPECTEUR");
  const lecteurR1 = await mk("lect-r1@banc-x1.invalid", "Lecteur regional X1", "LECTEUR");
  const reg2 = await mk("reg2@banc-x1.invalid", "Gestionnaire region deux X1", "GESTIONNAIRE");
  const sansModule = await mk("sans@banc-x1.invalid", "Sans module X1", "GESTIONNAIRE", ["troncons"]);
  const referent = await mk("referent@banc-x1.invalid", "Referent concessionnaire X1", "LECTEUR");
  const R1 = (await prisma.region.create({ data: { nom: "Region banc X1 un" } })).id;
  const R2 = (await prisma.region.create({ data: { nom: "Region banc X1 deux" } })).id;
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3), ($4, $5, $3)`, lecteurR1.id, R1, admin.id, reg2.id, R2);
  const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
  const T = { admin: jeton(admin), chef: jeton(chef), chef2: jeton(chef2), lecteur: jeton(lecteur), insp: jeton(inspecteur), lectR1: jeton(lecteurR1), reg2: jeton(reg2), sans: jeton(sansModule) };

  const get = (chemin: string, t: string | null = T.chef) => { const r = request(app).get(`${BASE}${chemin}`); return t ? r.set("Authorization", `Bearer ${t}`) : r; };
  const envoyer = (methode: "post" | "patch" | "delete", chemin: string, corps?: unknown, t: string | null = T.chef) => {
    let r = request(app)[methode](`${BASE}${chemin}`);
    if (t) r = r.set("Authorization", `Bearer ${t}`);
    return corps === undefined ? r : r.send(corps as object);
  };
  const exporter = (pid: string, q = "", t = T.chef) => binaire(get(`/${pid}/export/dossier${q}`, t));
  const depot = (pid: string, contenu: Buffer, champs: Record<string, string | undefined>, nom: string, t = T.chef) => {
    const q = request(app).post(`${BASE}/${pid}/jeux`).set("Authorization", `Bearer ${t}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) q.field(k, v);
    return q.attach("fichier", contenu, { filename: nom });
  };
  async function deposer(pid: string, contenu: Buffer, champs: Record<string, string | undefined>, nom: string): Promise<string> {
    const r = request(app).post(`${BASE}/${pid}/jeux`).set("Authorization", `Bearer ${T.chef}`);
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) r.field(k, v);
    const d = await r.attach("fichier", contenu, { filename: nom });
    if (!d.body.jeu?.id) throw new Error(`depot refuse : ${JSON.stringify(d.body)}`);
    return d.body.jeu.id;
  }
  const autoriser = async (pid: string, id: string) => {
    const a = await envoyer("post", `/${pid}/jeux/${id}/autoriser`, { justification: JUSTIF });
    if (a.status !== 200) throw new Error(`autorisation refusee : ${JSON.stringify(a.body)}`);
  };

  console.log("\n== Export du dossier technique et tableaux de bord (lot X1) : banc PostGIS ==");
  // Territoires par l'API (aucune ligne de code) : une region rattachee a R1 et deux communes ; une region rattachee a R2.
  const nation = (await sql<{ id: string }>(`SELECT id FROM territoires_voirie WHERE niveau = 'NATION' AND "deletedAt" IS NULL LIMIT 1`))[0].id;
  const terr = async (code: string, nom: string, niveau: string, parentId: string, regionId?: number) => {
    const r = await envoyer("post", "/territoires", { code, nom, niveau, parentId, ...(regionId ? { regionId } : {}) }, T.admin);
    if (r.status !== 201) throw new Error(`territoire refuse : ${JSON.stringify(r.body)}`);
    return r.body.territoire.id as string;
  };
  const TREG1 = await terr("BANC-X1-REG1", "Region de banc X1 un", "REGION", nation, R1);
  const TCOM1 = await terr("BANC-X1-COM1", "Commune de banc X1 un", "COMMUNE", TREG1);
  const TCOM2 = await terr("BANC-X1-COM2", "Commune de banc X1 deux", "COMMUNE", TREG1);
  const TREG2 = await terr("BANC-X1-REG2", "Region de banc X1 deux", "REGION", nation, R2);
  const projet = async (code: string, territoireId: string) => {
    const r = await envoyer("post", "", { code, nom: `Voirie de banc ${code}`, territoireId });
    if (r.status !== 201) throw new Error(`projet refuse : ${JSON.stringify(r.body)}`);
    return r.body.projet.id as string;
  };
  const PID = await projet("X1-DOSSIER", TCOM1);
  const PID_B = await projet("X1-VOLUME", TCOM2);
  const PID_D = await projet("X1-DIRECT", TREG1);
  const PID_R2 = await projet("X1-AUTRE-REGION", TREG2);
  const CT: string = (await envoyer("post", "/concessionnaires", { nom: "Operateur Telecom Synthetique X1", typeReseau: "TELECOM" })).body.concessionnaire.id;
  const CE: string = (await envoyer("post", "/concessionnaires", { nom: "+Operateur Eau Synthetique X1", typeReseau: "EAU_POTABLE" })).body.concessionnaire.id;

  const JAX = await deposer(PID, await geojson([{ nom: "Axe A X1", pts: [[0, 0], [200, 0]] }]), { role: "AXES_TRAVAUX", confidentialite: "INTERNE" }, "axes-x1.geojson");
  const JR = await deposer(PID, await geojson([{ nom: "Cable croisant X1", pts: [[50, -20], [50, 20]] }]), { role: "RESEAU_TIERS", concessionnaireId: CT, methodeAcquisition: "NUMERISATION_PLAN", classePrecision: "B" }, "telecom-x1.geojson");
  const JS = await deposer(PID, await geojson([{ nom: "Conduite sensible X1", pts: [[120, -15], [120, 15]] }]), { role: "RESEAU_TIERS", concessionnaireId: CE, confidentialite: "INFRASTRUCTURE_SENSIBLE", methodeAcquisition: "NUMERISATION_PLAN" }, "eau-x1.geojson");
  const JRP = await deposer(PID, await geojson([{ nom: "Limite nord X1", pts: [[0, 8], [200, 8]] }]), { role: "LIMITES_ROUTE", confidentialite: "RESTREINT_PROJET" }, "limites-x1.geojson");
  for (const j of [JAX, JR, JS, JRP]) await autoriser(PID, j);
  const JQ = await deposer(PID, await geojson([{ nom: "Objet en quarantaine X1", pts: [[10, 30], [60, 30]] }]), { role: "AUTRE", confidentialite: "PUBLIC" }, "quarantaine-x1.geojson");
  const JRET = await deposer(PID, await geojson([{ nom: "Objet retire X1", pts: [[10, 40], [60, 40]] }]), { role: "AUTRE", confidentialite: "PUBLIC" }, "jeu-retire-x1.geojson");
  const anP = await envoyer("post", `/${PID}/analyses`, {});
  // Documents : un titre et une reference hostiles (injection de formules), un document lie au jeu qui sera retire, un document attendu.
  const TITRE_HOSTILE = "=HYPERLINK(\"http://exemple.invalid\",\"x\")";
  await envoyer("post", `/${PID}/documents`, { typeCode: "AUTRE", titre: TITRE_HOSTILE, reference: "@SUM(A1:A9)" });
  const docRet = await envoyer("post", `/${PID}/documents`, { typeCode: "AUTRE", titre: "Plan lie au jeu bientot retire", jeuId: JRET });
  await envoyer("post", `/${PID}/documents`, { typeCode: "LIMITES_ROUTE", titre: "Limites attendues" });
  const ret = await envoyer("delete", `/${PID}/jeux/${JRET}`);
  const ref = await envoyer("post", `/${PID}/workflow/referents`, { userId: referent.id, concessionnaireId: CT, motif: "Referent du concessionnaire pour le banc X1" }, T.admin);
  verifier("0. fixtures : 4 jeux autorises, 1 en quarantaine, 1 retire (lie a un document), analyse persistee, referent rattache",
    anP.status === 201 && docRet.status === 201 && ret.status === 200 && ref.status === 201 && (await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID)) > 0,
    { analyse: anP.status, doc: docRet.body, ret: ret.body, ref: ref.body });

  await prisma.$transaction(async (tx: typeof prisma) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(`INSERT INTO comparaisons_sources_projet (id, "projetId", numero, statut, "jeuAId", "jeuBId", "versionAlgorithme", "declencheParId") VALUES ('cmp-x1-ret', $1, 998, 'TERMINEE', $2, $3, 'banc-x1', $4)`, PID, JR, JRET, chef.id);
    await tx.$executeRawUnsafe(`INSERT INTO conflits_projet (id, "projetId", cle, type, axe, "jeuReseauId", geom, statut, "comparaisonId", mesure) VALUES ('cf-x1-ret', $1, $3, 'DIVERGENCE_SOURCES', 'Axe A X1', $2, ST_SetSRID(ST_MakePoint(-9.5, 9.21), 4326), 'A_INVESTIGUER', 'cmp-x1-ret', '{"distanceMinM": 4.2, "hausdorffM": 6.5}'::jsonb)`, PID, JR, sha(Buffer.from("cle-banc-x1-divergence-retire")));
  });
  const avantTout = await compter(`SELECT count(*) n FROM audit_logs`);
  const empreinteTroncons = async () => (await sql<{ h: string | null }>(`SELECT md5(string_agg(t::text, '|' ORDER BY id)) h FROM troncons t`))[0].h;
  const troncons0 = await empreinteTroncons();
  void avantTout;

  // ================================================================ 1. Gardes
  const g = await Promise.all([exporter(PID, "", T.lecteur), exporter(PID, "", T.insp), exporter(PID, "", T.sans), binaire(get(`/${PID}/export/dossier`, null)), exporter(PID, "", T.reg2),
    envoyer("post", `/${PID}/export/derogations`, { jeuxIds: [JR], justification: "x".repeat(25) }, T.chef), get(`/${PID}/export/journal`, T.lecteur)]);
  verifier("1. export : lecteur 403, inspecteur 403, sans module 403, sans jeton 401, gestionnaire d'une autre region 404 masque ; derogation par un gestionnaire 403 ; journal par un lecteur 403",
    g.map((r) => r.status).join() === "403,403,403,401,404,403,403", g.map((r) => r.status));
  verifier("1. aucune ligne de journal ni d'audit d'export apres ces refus", (await compter(`SELECT count(*) n FROM exports_dossier_projet_voirie`)) === 0
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" IN ('ExportDossierProjetVoirie', 'DerogationExportProjetVoirie')`)) === 0);

  // ================================================================ 2. Export reel : archive relue, manifeste, empreintes
  const e1 = await exporter(PID);
  const zip1 = e1.body as Buffer;
  exemples["entetes_export"] = { status: e1.status, "content-type": e1.headers["content-type"], "content-disposition": e1.headers["content-disposition"], "x-export-id": e1.headers["x-export-id"], "x-empreinte-sha256": e1.headers["x-empreinte-sha256"], "x-fichiers": e1.headers["x-fichiers"], "x-jeux-geojson": e1.headers["x-jeux-geojson"] };
  const issue1 = await issueDe(e1.headers["x-export-id"]);
  const lus = relire(zip1);
  const R = "dossier-x1-dossier/";
  const lire = (c: string) => lus.get(R + c);
  const manifeste = JSON.parse(lire("manifeste.json")!.toString("utf8"));
  exemples["manifeste"] = manifeste;
  verifier("2. 200 application/zip, piece jointe, empreinte de l'en-tete = SHA-256 des octets recus ; archive relue par le lecteur strict du module (CRC, tailles, noms)",
    e1.status === 200 && e1.headers["content-type"] === "application/zip" && /^attachment; filename="dossier-x1-dossier-\d{4}-\d{2}-\d{2}\.zip"$/.test(e1.headers["content-disposition"])
    && e1.headers["x-empreinte-sha256"] === sha(zip1) && Number(e1.headers["x-fichiers"]) === lus.size, { status: e1.status, h: e1.headers });
  const attendus = ["LISEZMOI.txt", "fiche-projet.json", "fiche-projet.pdf", "analyse/agregats.json", "conflits/dossiers.csv", "documents/journal.json", "documents/journal.csv", "documents/completude.json"];
  verifier("2. contenu : les huit fichiers du contrat, les GeoJSON, puis manifeste.json et manifeste.sha256, sous une racine unique",
    attendus.every((c) => lus.has(R + c)) && lus.has(R + "manifeste.json") && lus.has(R + "manifeste.sha256") && [...lus.keys()].every((k) => k.startsWith(R)), [...lus.keys()]);
  verifier("2. manifeste.sha256 se verifie entierement (sha256sum -c) ; le manifeste liste chaque autre fichier avec sa taille et son empreinte exactes",
    verifierEmpreintes(lire("manifeste.sha256")!.toString("utf8"), lire).ok
    && manifeste.fichiers.length === lus.size - 2 && manifeste.fichiers.every((f: { chemin: string; octets: number; sha256: string }) => lire(f.chemin)?.length === f.octets && sha(lire(f.chemin)!) === f.sha256),
    manifeste.fichiers);
  const journal1 = (await sql<{ id: string; sha256: string; nbFichiers: number; acteurId: string }>(`SELECT id, sha256, "nbFichiers", "acteurId" FROM exports_dossier_projet_voirie`))[0];
  verifier("2. journal : une ligne, REMIS apres l'ecriture complete de la reponse, identifiant = en-tete = manifeste, empreinte de l'archive remise, acteur = le compte",
    issue1 === "REMIS" && journal1?.id === e1.headers["x-export-id"] && journal1.id === manifeste.exportId && journal1.sha256 === sha(zip1) && journal1.acteurId === chef.id && journal1.nbFichiers === lus.size, journal1);

  // ================================================================ 3. Confidentialite : GeoJSON des seuls jeux autorises d'un niveau exportable
  const geo = [...lus.keys()].filter((k) => k.startsWith(`${R}geojson/`));
  const inclus = manifeste.geojson.inclus.map((i: { jeuId: string }) => i.jeuId).sort();
  const ecartes = Object.fromEntries(manifeste.geojson.ecartes.map((x: { jeuId: string; raison: string }) => [x.jeuId, x.raison]));
  verifier("3. GeoJSON : axes INTERNE et limites RESTREINT_PROJET seulement ; telecom CONFIDENTIEL_CONCESSIONNAIRE et eau INFRASTRUCTURE_SENSIBLE ecartes (CONFIDENTIALITE) ; quarantaine ecartee (NON_AUTORISE)",
    geo.length === 2 && JSON.stringify(inclus) === JSON.stringify([JAX, JRP].sort()) && ecartes[JR] === "CONFIDENTIALITE" && ecartes[JS] === "CONFIDENTIALITE" && ecartes[JQ] === "NON_AUTORISE"
    && e1.headers["x-jeux-geojson"] === "2", { geo, inclus, ecartes });
  const texteArchive = [...lus.values()].map((b) => b.toString("latin1")).join("\n");
  verifier("3. le jeu RETIRE n'apparait NULLE PART dans l'archive (ni identifiant, ni nom de fichier, ni nom d'objet), meme lie a un document",
    !texteArchive.includes(JRET) && !texteArchive.includes("jeu-retire-x1") && !texteArchive.includes("Objet retire X1"), JRET);
  verifier("3. aucune geometrie ni nom d'objet des jeux ecartes (telecom, eau, quarantaine) dans l'archive",
    !texteArchive.includes("Cable croisant X1") && !texteArchive.includes("Conduite sensible X1") && !texteArchive.includes("Objet en quarantaine X1"));
  const gAx = JSON.parse(lus.get(geo.find((k) => k.includes(JAX.toLowerCase()))!)!.toString("utf8"));
  const dbAx = (await sql<{ g: string }>(`SELECT ST_AsGeoJSON(geom, 7) g FROM projets_voirie_objets WHERE "jeuId" = $1 ORDER BY ordre`, JAX))[0].g;
  verifier("3. GeoJSON valide (RFC 7946) : FeatureCollection, geometrie identique a la base (7 decimales), proprietes du contrat, AUCUN attribut source ; membre bdri (jeu, version, empreinte source, niveau)",
    gAx.type === "FeatureCollection" && gAx.features.length === 1 && JSON.stringify(gAx.features[0].geometry) === JSON.stringify(JSON.parse(dbAx))
    && JSON.stringify(Object.keys(gAx.features[0].properties).sort()) === JSON.stringify(["longueurM", "nom", "objetId", "ordre", "typeGeom"])
    && !JSON.stringify(gAx).includes("proprietaireInterne") && gAx.bdri.jeuId === JAX && gAx.bdri.confidentialite === "INTERNE" && gAx.bdri.derogation === false, gAx);
  const fiche = JSON.parse(lire("fiche-projet.json")!.toString("utf8"));
  const agr = lire("analyse/agregats.json")!.toString("utf8");
  verifier("3. fiche : jeux non retires (quarantaine comprise, que le decideur lit deja), sans resume ni avertissements du depot ; agregats sans aucune coordonnee ni liste d'objets",
    fiche.jeux.length === 5 && fiche.jeux.every((j: Record<string, unknown>) => !("resume" in j) && !("avertissements" in j)) && JSON.parse(agr).analyse2D.disponible === true
    && !/coordinates|"objets"|Feature/.test(agr), { jeux: fiche.jeux.length });
  const csv = lire("conflits/dossiers.csv")!.toString("utf8").replace(/^﻿/, "");
  const lignesCsv = csv.split("\r\n").filter(Boolean);
  const nbConflits = await compter(`SELECT count(*) n FROM conflits_projet WHERE "projetId" = $1`, PID);
  const colDistance = (ENTETE_CSV_CONFLITS as readonly string[]).indexOf("distanceMinM");
  const ligneRet = lignesCsv.find((l) => l.endsWith(sha(Buffer.from("cle-banc-x1-divergence-retire"))))?.split(";");
  verifier("3. revue m1 : la mesure d'un dossier DIVERGENCE_SOURCES dont le jeu B est RETIRE n'est pas dans le CSV (distanceMinM vide)", !!ligneRet && ligneRet[colDistance] === "" && !csv.includes("4,2"), ligneRet);
  verifier("3. CSV des dossiers : l'en-tete existant, une ligne par dossier ; le nom de concessionnaire hostile est neutralise (apostrophe)",
    lignesCsv[0] === ENTETE_CSV_CONFLITS.join(";") && lignesCsv.length === 1 + nbConflits && csv.includes("'+Operateur Eau Synthetique X1") && !/;\+Operateur/.test(csv), lignesCsv.slice(0, 3));
  const jcsv = lire("documents/journal.csv")!.toString("utf8");
  verifier("3. journal des documents (CSV) : titre et reference hostiles neutralises ; aucune cellule ne commence par = + - @",
    jcsv.includes("'=HYPERLINK") && jcsv.includes("'@SUM(A1:A9)") && !jcsv.replace(/^﻿/, "").split("\r\n").slice(1).some((l) => l.split(";").some((c) => /^"?[=+\-@]/.test(c))), jcsv.slice(0, 400));
  const pdf = lire("fiche-projet.pdf")!;
  verifier("3. fiche PDF : PDF 1.4 texte simple, titre du projet, fin de fichier", pdf.subarray(0, 8).toString() === "%PDF-1.4" && pdf.toString("latin1").includes("(Dossier technique du projet X1-DOSSIER)") && pdf.toString("latin1").trimEnd().endsWith("%%EOF"));

  // ================================================================ 4. Audit (avant la remise, sans geometrie) et journal
  const audits = await sql<{ after: string }>(`SELECT after::text AS after FROM audit_logs WHERE "entityType" = 'ExportDossierProjetVoirie' AND "entityId" = $1 AND after->>'statut' = 'REMIS'`, PID);
  const auditsTentative = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportDossierProjetVoirie' AND "entityId" = $1 AND after->>'statut' = 'EN_COURS'`, PID);
  verifier("4. audit ExportDossierProjetVoirie : la tentative (EN_COURS) puis la remise (REMIS, empreinte et jeux exportes), aucune coordonnee", audits.length === 1 && auditsTentative === 1
    && audits[0].after.includes(sha(zip1)) && !/coordinates|LineString/.test(audits[0].after), audits);
  const jr = await get(`/${PID}/export/journal`);
  exemples["journal"] = jr.body;
  verifier("4. GET /export/journal : l'export, son acteur, son empreinte", jr.status === 200 && jr.body.exports.length === 1 && jr.body.exports[0].sha256 === sha(zip1) && jr.body.exports[0].acteur.id === chef.id, jr.body);

  // ================================================================ 5. Derogation de confidentialite : accordee, refusee, a usage unique
  const D = (corps: Record<string, unknown>) => envoyer("post", `/${PID}/export/derogations`, { justification: "Transmission au bureau de controle pour etudes d'execution", ...corps }, T.admin);
  const refus = await Promise.all([D({ jeuxIds: [JAX], beneficiaireId: chef.id }), D({ jeuxIds: [JQ], beneficiaireId: chef.id }), D({ jeuxIds: [JRET], beneficiaireId: chef.id }), D({ jeuxIds: [JR], beneficiaireId: lecteur.id }), D({ jeuxIds: [JR], beneficiaireId: reg2.id }),
    D({ jeuxIds: [JR], beneficiaireId: admin.id }), D({ jeuxIds: [JR] })]);
  verifier("5. creation refusee : jeu exportable sans derogation 409 DEROGATION_INUTILE ; quarantaine 409 JEU_NON_AUTORISE ; jeu retire 404 ; beneficiaire lecteur 422 ; hors perimetre 422 ; l'ADMIN lui-meme 409 SEPARATION_DES_TACHES (revue M2) ; sans beneficiaire 400",
    refus.map((r) => `${r.status}:${r.body.code}`).join() === "409:DEROGATION_INUTILE,409:JEU_NON_AUTORISE,404:JEU_INTROUVABLE,422:BENEFICIAIRE_NON_HABILITE,422:BENEFICIAIRE_HORS_PERIMETRE,409:SEPARATION_DES_TACHES,400:CHAMPS_INVALIDES", refus.map((r) => r.body));
  const separationBase = await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO derogations_export_projet_voirie (id, "projetId", "jeuxIds", "beneficiaireId", "accordeeParId", justification, "createdAt", "expireLe") VALUES ('dx-sep', $1, ARRAY[$2], $3, $3, 'Auto-derogation refusee par la base', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '1 hour')`, PID, JR, admin.id); });
  verifier("5. revue M2 : la base refuse aussi une derogation dont l'auteur est le beneficiaire, en SQL direct (contrainte dxpv_separation, 23514)", separationBase === "23514", separationBase);
  const dok = await D({ jeuxIds: [JR, JS], beneficiaireId: chef.id, dureeHeures: 2 });
  exemples["derogation"] = dok.body;
  const DID = dok.body.derogation?.id;
  verifier("5. derogation accordee par l'ADMIN : 201, nominative, DISPONIBLE, expiree dans 2 h ; auditee", dok.status === 201 && dok.body.derogation.etat === "DISPONIBLE"
    && dok.body.derogation.beneficiaire.id === chef.id && Math.abs(new Date(dok.body.derogation.expireLe).getTime() - Date.now() - 2 * 3_600_000) < 60_000
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'DerogationExportProjetVoirie' AND "entityId" = $1 AND action = 'CREATE'`, DID)) === 1, dok.body);
  const autres = await Promise.all([exporter(PID, `?derogation=${DID}`, T.chef2), exporter(PID_B, `?derogation=${DID}`), exporter(PID, `?derogation=${DID}&geojson=false`)]);
  verifier("5. citee par un autre compte : 404 DEROGATION_INTROUVABLE ; pour un autre projet : le meme 404 ; sans GeoJSON : 400 ; la derogation reste disponible",
    autres.map((r) => r.status).join() === "404,404,400" && JSON.parse(autres[0].body.toString()).code === "DEROGATION_INTROUVABLE"
    && (await compter(`SELECT count(*) n FROM derogations_export_projet_voirie WHERE id = $1 AND "utiliseeLe" IS NULL`, DID)) === 1, autres.map((r) => r.status));
  // Deux exports simultanes du beneficiaire avec la meme derogation : une seule archive (l'autre est refusee : un export par compte a la fois).
  const [c1, c2] = await Promise.all([exporter(PID, `?derogation=${DID}`), exporter(PID, `?derogation=${DID}`)]);
  const reussi = [c1, c2].find((r) => r.status === 200)!;
  await issueDe(reussi.headers["x-export-id"]);
  const lus2 = relire(reussi.body as Buffer);
  const man2 = JSON.parse(lus2.get(`${R}manifeste.json`)!.toString("utf8"));
  verifier("5. deux exports simultanes avec la derogation : un seul 200 (l'autre 503 SERVICE_OCCUPE), la derogation consommee une seule fois",
    [c1.status, c2.status].sort().join() === "200,503" && (await compter(`SELECT count(*) n FROM derogations_export_projet_voirie WHERE id = $1 AND "exportId" = $2`, DID, reussi.headers["x-export-id"])) === 1,
    [c1.status, c2.status]);
  verifier("5. avec la derogation : les GeoJSON du telecom et de l'eau sont dans l'archive, marques derogation dans le manifeste et le fichier ; manifeste et audit nomment la derogation",
    man2.derogationId === DID && man2.geojson.inclus.length === 4 && man2.geojson.inclus.filter((i: { derogation: boolean }) => i.derogation).map((i: { jeuId: string }) => i.jeuId).sort().join() === [JR, JS].sort().join()
    && [...lus2.keys()].some((k) => k.includes(JS.toLowerCase())) && JSON.parse(lus2.get([...lus2.keys()].find((k) => k.includes(JS.toLowerCase()))!)!.toString()).bdri.derogation === true
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'DerogationExportProjetVoirie' AND "entityId" = $1 AND action = 'UPDATE' AND after->>'consommee' = 'true'`, DID)) === 1
    && (await compter(`SELECT count(*) n FROM derogations_export_projet_voirie WHERE id = $1 AND "utiliseeLe" IS NOT NULL`, DID)) === 1, man2.geojson);
  const reuse = await exporter(PID, `?derogation=${DID}`);
  verifier("5. usage unique : la reutiliser repond 409 DEROGATION_INDISPONIBLE (UTILISEE) ; aucune archive", reuse.status === 409 && JSON.parse(reuse.body.toString()).extra === undefined
    && JSON.parse(reuse.body.toString()).etat === "UTILISEE", reuse.body.toString());
  const directs = {
    reconsommer: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE derogations_export_projet_voirie SET "utiliseeLe" = now(), "exportId" = $2 WHERE id = $1`, DID, journal1.id); }),
    modifier: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE derogations_export_projet_voirie SET justification = 'reecrite pour elargir le perimetre' WHERE id = $1`, DID); }),
    supprimer: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`DELETE FROM derogations_export_projet_voirie WHERE id = $1`, DID); }),
    journalModifie: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE exports_dossier_projet_voirie SET sha256 = $2 WHERE id = $1`, journal1.id, "0".repeat(64)); }),
    journalSupprime: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`DELETE FROM exports_dossier_projet_voirie WHERE id = $1`, journal1.id); }),
    tronquer: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`TRUNCATE derogations_export_projet_voirie`); }),
    dureeExcessive: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO derogations_export_projet_voirie (id, "projetId", "jeuxIds", "beneficiaireId", "accordeeParId", justification, "createdAt", "expireLe") VALUES ('dx-1', $1, ARRAY[$2], $3, $4, 'Duree excessive pour le banc X1', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '8 days')`, PID, JR, chef.id, admin.id); }),
    dateCreationChoisie: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO derogations_export_projet_voirie (id, "projetId", "jeuxIds", "beneficiaireId", "accordeeParId", justification, "createdAt", "expireLe") VALUES ('dx-3', $1, ARRAY[$2], $3, $4, 'Creation datee dans le futur par le banc', (now() AT TIME ZONE 'UTC') + interval '3 years', (now() AT TIME ZONE 'UTC') + interval '3 years 6 days')`, PID, JR, chef.id, admin.id); }),
    journalRemisRouvert: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE exports_dossier_projet_voirie SET statut = 'ECHEC', "codeEchec" = 'REECRIT' WHERE id = $1`, journal1.id); }),
    naitUtilisee: await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO derogations_export_projet_voirie (id, "projetId", "jeuxIds", "beneficiaireId", "accordeeParId", justification, "createdAt", "expireLe", "utiliseeLe", "exportId") VALUES ('dx-2', $1, ARRAY[$2], $3, $4, 'Nee deja utilisee pour le banc X1', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + interval '1 day', now(), $5)`, PID, JR, chef.id, admin.id, journal1.id); }),
  };
  verifier("5. base : reconsommer, modifier, supprimer, tronquer une derogation refuses (23001) ; journal fige apres son issue (23001) ; duree de plus de 7 jours (23514) ; naissance utilisee (23514) ; date de creation choisie (revue m3, 23514)",
    directs.reconsommer === "23001" && directs.modifier === "23001" && directs.supprimer === "23001" && directs.journalModifie === "23001" && directs.journalSupprime === "23001"
    && directs.tronquer === "23001" && directs.dureeExcessive === "23514" && directs.naitUtilisee === "23514"
    && directs.dateCreationChoisie === "23514" && directs.journalRemisRouvert === "23001", directs);
  await prisma.$transaction(async (tx: typeof prisma) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(`INSERT INTO derogations_export_projet_voirie (id, "projetId", "jeuxIds", "beneficiaireId", "accordeeParId", justification, "createdAt", "expireLe") VALUES ('11111111-1111-4111-8111-111111111111', $1, ARRAY[$2], $3, $4, 'Derogation deja expiree pour le banc X1', (now() AT TIME ZONE 'UTC') - interval '3 hours', (now() AT TIME ZONE 'UTC') - interval '1 hour')`, PID, JS, chef.id, admin.id);
  });
  const consommerExpiree = await essaiAnnule(async (tx) => { await tx.$executeRawUnsafe(`UPDATE derogations_export_projet_voirie SET "exportId" = $1 WHERE id = '11111111-1111-4111-8111-111111111111'`, journal1.id); });
  const exp = await exporter(PID, "?derogation=11111111-1111-4111-8111-111111111111");
  const nonUuid = await exporter(PID, "?derogation=dx-expiree");
  const expUuid = await exporter(PID, `?derogation=${"9".repeat(8)}-0000-4000-8000-000000000000`);
  verifier("5. derogation expiree : 409 DEROGATION_INDISPONIBLE (EXPIREE) ; identifiant non UUID : 400 ; UUID inconnu : 404 ; une expiree ne se reserve pas en base, horloge de la base (declencheur)",
    exp.status === 409 && JSON.parse(exp.body.toString()).etat === "EXPIREE" && nonUuid.status === 400 && expUuid.status === 404
    && consommerExpiree === "23514", [exp.status, exp.body.toString(), nonUuid.status, expUuid.status, consommerExpiree]);

  // ================================================================ 6. Cadence, geojson=false, volume, delai cote base
  await attendreSansEnCours();
  const n = await compter(`SELECT count(*) n FROM exports_dossier_projet_voirie WHERE "acteurId" = $1`, chef.id);
  process.env.PROJETS_VOIRIE_EXPORT_CADENCE_MAX = String(n);
  const trop = await exporter(PID);
  delete process.env.PROJETS_VOIRIE_EXPORT_CADENCE_MAX;
  verifier("6. cadence par compte : au plafond, 429 EXPORT_TROP_FREQUENT avec Retry-After ; aucune ligne de journal en plus", trop.status === 429 && JSON.parse(trop.body.toString()).code === "EXPORT_TROP_FREQUENT"
    && Number(trop.headers["retry-after"]) > 0 && (await compter(`SELECT count(*) n FROM exports_dossier_projet_voirie WHERE "acteurId" = $1`, chef.id)) === n, trop.body.toString());
  const sansGeo = await exporter(PID, "?geojson=false", T.admin);
  const man3 = JSON.parse(relire(sansGeo.body as Buffer).get(`${R}manifeste.json`)!.toString("utf8"));
  verifier("6. geojson=false : aucun GeoJSON, chaque jeu autorise ecarte GEOJSON_NON_DEMANDE ; l'ADMIN exporte aussi", sansGeo.status === 200 && man3.geojson.inclus.length === 0
    && man3.geojson.ecartes.filter((x: { raison: string }) => x.raison === "GEOJSON_NON_DEMANDE").length === 4 && sansGeo.headers["x-jeux-geojson"] === "0", man3.geojson);
  // Volume : une ligne de 12 000 sommets (public) dans un autre projet ; plafond de sommets abaisse a 10 000.
  const longue: [number, number][] = Array.from({ length: 12_000 }, (_, i) => [i * 0.05, Math.sin(i / 50)]);
  const JV = await deposer(PID_B, await geojson([{ nom: "Axe long X1", pts: longue }]), { role: "AXES_TRAVAUX", confidentialite: "PUBLIC" }, "axe-long-x1.geojson");
  await autoriser(PID_B, JV);
  process.env.PROJETS_VOIRIE_EXPORT_SOMMETS_MAX = "10000";
  const vol = await exporter(PID_B, "", T.chef2);
  const tentativeVol = (await sql<{ s: string; c: string | null }>(`SELECT statut s, "codeEchec" c FROM exports_dossier_projet_voirie WHERE "acteurId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, chef2.id))[0];
  const volSans = await exporter(PID_B, "?geojson=false", T.chef2);
  delete process.env.PROJETS_VOIRIE_EXPORT_SOMMETS_MAX;
  const corpsVol = JSON.parse(vol.body.toString());
  await issueDe(volSans.headers["x-export-id"]);
  verifier("6. volume compte AVANT de lire la geometrie : 422 EXPORT_TROP_VOLUMINEUX (sommets et plafond), tentative consignee ECHEC (comptee dans la cadence, revue M3) ; sans GeoJSON : 200", vol.status === 422 && corpsVol.code === "EXPORT_TROP_VOLUMINEUX"
    && corpsVol.sommets === 12_000 && corpsVol.sommetsMax === 10_000 && tentativeVol?.s === "ECHEC" && tentativeVol.c === "EXPORT_TROP_VOLUMINEUX" && volSans.status === 200, { corpsVol, tentativeVol });
  // Delai cote base : la table des objets verrouillee par une autre transaction ; la lecture du volume attend, puis lock_timeout l'annule.
  const verrou = new Client({ connectionString: banc.urlClone });
  verrou.on("error", () => undefined);
  await verrou.connect();
  await verrou.query("BEGIN");
  await verrou.query(`LOCK TABLE "projets_voirie_objets" IN ACCESS EXCLUSIVE MODE`);
  process.env.PROJETS_VOIRIE_VERROU_MS = "500";
  const t0 = Date.now();
  const bloque = await exporter(PID, "", T.chef2);
  const duree = Date.now() - t0;
  await verrou.query("ROLLBACK");
  verifier("6. delai cote base : table verrouillee, l'export s'arrete (504 EXPORT_TROP_LONG) en quelques secondes au lieu d'attendre ; tentative ECHEC, aucune remise", bloque.status === 504
    && JSON.parse(bloque.body.toString()).code === "EXPORT_TROP_LONG" && duree < 8_000 && (await compter(`SELECT count(*) n FROM exports_dossier_projet_voirie WHERE "acteurId" = $1 AND statut = 'REMIS'`, chef2.id)) === 1
    && (await compter(`SELECT count(*) n FROM exports_dossier_projet_voirie WHERE "acteurId" = $1 AND statut = 'ECHEC' AND "codeEchec" = 'EXPORT_TROP_LONG'`, chef2.id)) === 1,
    { status: bloque.status, duree });

  // ================================================================ 7. Tableaux de bord
  // Un dossier DIVERGENCE_SOURCES dont le jeu B est en quarantaine (fixture SQL) : un lecteur ne doit pas le compter (revue T1+S1, B1).
  await prisma.$transaction(async (tx: typeof prisma) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(`INSERT INTO comparaisons_sources_projet (id, "projetId", numero, statut, mode, "jeuAId", "jeuBId", "versionAlgorithme", "declencheParId") VALUES ('cmp-x1', $1, 999, 'TERMINEE', 'VERSION_CANDIDATE', $2, $3, 'banc-x1', $4)`, PID, JR, JQ, chef.id);
    await tx.$executeRawUnsafe(`INSERT INTO conflits_projet (id, "projetId", cle, type, axe, "jeuReseauId", geom, statut, "comparaisonId") VALUES ('cf-x1', $1, $3, 'DIVERGENCE_SOURCES', 'Axe A X1', $2, ST_SetSRID(ST_MakePoint(-9.5, 9.2), 4326), 'A_INVESTIGUER', 'cmp-x1')`, PID, JR, sha(Buffer.from("cle-banc-x1-divergence")));
  });
  // Un dossier dont le jeu de reseau passe REMPLACE (nouvelle version autorisee apres l'analyse) : invisible d'un lecteur.
  const JS2 = await deposer(PID, await geojson([{ nom: "Conduite sensible X1 v2", pts: [[121, -15], [121, 15]] }]), { role: "RESEAU_TIERS", concessionnaireId: CE, confidentialite: "INFRASTRUCTURE_SENSIBLE", methodeAcquisition: "NUMERISATION_PLAN" }, "eau-x1-v2.geojson");
  const revue = await envoyer("post", `/${PID}/jeux/${JS2}/revue-suppressions`, { decision: "ACCEPTER", justification: JUSTIF });
  const aut2 = await envoyer("post", `/${PID}/jeux/${JS2}/autoriser`, { justification: JUSTIF });
  _viderCadenceTableaux();
  const tn = await get("/tableau-de-bord");
  const tl = await get("/tableau-de-bord", T.lecteur);
  exemples["tableau_national_decideur"] = tn.body;
  exemples["tableau_national_lecteur"] = tl.body;
  const projetsTous = await compter(`SELECT count(*) n FROM projets_voirie WHERE "deletedAt" IS NULL`);
  const jeuxDb = Object.fromEntries((await sql<{ s: string; n: bigint }>(`SELECT statut::text s, count(*) n FROM projets_voirie_jeux WHERE statut <> 'RETIRE' GROUP BY 1`)).map((x) => [x.s, Number(x.n)]));
  const conflitsDb = Object.fromEntries((await sql<{ s: string; n: bigint }>(`SELECT statut::text s, count(*) n FROM conflits_projet GROUP BY 1`)).map((x) => [x.s, Number(x.n)]));
  verifier("7. national, decideur : tous les projets, jeux par statut (quarantaine et REMPLACE compris, RETIRE jamais), tous les dossiers par statut (comptes de la base)",
    tn.status === 200 && tn.body.total.projets === projetsTous && JSON.stringify(Object.entries(tn.body.total.jeux).sort()) === JSON.stringify(Object.entries(jeuxDb).sort())
    && Object.entries(conflitsDb).every(([s, k]) => tn.body.total.conflits[s] === k) && tn.body.total.jeux.RETIRE === undefined && tn.body.total.jeux.CONTROLE >= 1,
    { tableau: tn.body.total, jeuxDb, conflitsDb, revue: revue.status, aut2: aut2.status });
  // Oracle independant pour le lecteur : les routes de lecture du socle, projet par projet.
  let jeuxLect = 0, conflitsLect = 0;
  for (const p of [PID, PID_B, PID_D, PID_R2]) {
    jeuxLect += (await get(`/${p}/jeux`, T.lecteur)).body.jeux.length;
    conflitsLect += (await get(`/${p}/conflits`, T.lecteur)).body.total;
  }
  const totalLect = Object.values(tl.body.total.conflits as Record<string, number>).reduce((s, x) => s + x, 0);
  verifier("7. national, lecteur : AUCUN comptage de quarantaine (jeux AUTORISE seulement, egaux a la liste des jeux), dossiers visibles seulement (la liste moins les deux dossiers dont le jeu B est en quarantaine ou retire)",
    tl.status === 200 && Object.keys(tl.body.total.jeux).join() === "AUTORISE" && tl.body.total.jeux.AUTORISE === jeuxLect && totalLect === conflitsLect - 2
    && totalLect < Object.values(tn.body.total.conflits as Record<string, number>).reduce((s, x) => s + x, 0), { lecteur: tl.body.total, jeuxLect, conflitsLect });
  verifier("7. lecteur : pieces en attente et referents nuls ; decideur : pieces en attente (documents attendus et recus) et referent actif comptes",
    tl.body.total.documentsManquants.piecesEnAttente === null && tl.body.total.referentsActifs === null && tl.body.lisibilite.jeux === "AUTORISE_SEULEMENT"
    && tn.body.total.documentsManquants.piecesEnAttente >= 2 && tn.body.total.referentsActifs.comptes === 1 && tn.body.total.referentsActifs.rattachements === 1, { n: tn.body.total.documentsManquants, l: tl.body.total.documentsManquants });
  let typesOracle = 0;
  for (const p of [PID, PID_B, PID_D, PID_R2]) typesOracle += (await get(`/${p}/completude`, T.lecteur)).body.piecesManquantes.filter((x: { nature: string }) => x.nature === "TYPE_OBLIGATOIRE").length;
  verifier("7. types obligatoires non fournis : egaux a la somme des pieces TYPE_OBLIGATOIRE de la completude (lot D1), pour le decideur comme pour le lecteur",
    tn.body.total.documentsManquants.typesObligatoiresNonFournis === typesOracle && tl.body.total.documentsManquants.typesObligatoiresNonFournis === typesOracle, { typesOracle, n: tn.body.total.documentsManquants });
  const texteTableaux = JSON.stringify([tn.body, tl.body]);
  verifier("7. agregats seulement : aucune geometrie, aucun nom d'objet, de fichier, de concessionnaire ni de document dans les tableaux",
    !/coordinates|Feature|Cable croisant|Conduite sensible|Axe A X1|\.geojson|Operateur|HYPERLINK|Limites attendues/.test(texteTableaux));
  const tr1 = await get("/tableau-de-bord", T.lectR1);
  verifier("7. national d'un compte regional : ses seules regions (projets de R1), parRegion limite a R1", tr1.status === 200 && tr1.body.total.projets === 3
    && tr1.body.parRegion.length === 1 && tr1.body.parRegion[0].regionId === R1 && tr1.body.perimetre.national === false, tr1.body);
  const tt = await get(`/tableau-de-bord/territoires/${TREG1}`);
  exemples["tableau_territoire"] = tt.body;
  const enf = Object.fromEntries((tt.body.enfants ?? []).map((e: { code: string; projets: number }) => [e.code, e.projets]));
  verifier("7. par territoire (avec descendants) : total 3 projets, rattache directement 1, enfants COM1 et COM2 a 1 projet chacun, rien de non ventile",
    tt.status === 200 && tt.body.total.projets === 3 && tt.body.rattachesDirectement.projets === 1 && enf["BANC-X1-COM1"] === 1 && enf["BANC-X1-COM2"] === 1 && tt.body.nonVentiles.projets === 0
    && tt.body.territoire.ancetres.length === 1, tt.body);
  const tts = await Promise.all([get(`/tableau-de-bord/territoires/${TREG1}`, T.reg2), get(`/tableau-de-bord/territoires/${TREG2}`, T.lectR1), get(`/tableau-de-bord/territoires/${TCOM1}`, T.lectR1), get(`/tableau-de-bord/territoires/${TREG1}`, T.sans)]);
  verifier("7. territoire hors perimetre : le MEME 404 masque ; dans le perimetre : 200 sans nommer la nation (ancetre hors perimetre) ; sans module 403",
    tts.map((r) => r.status).join() === "404,404,200,403" && tts[0].body.code === "TERRITOIRE_INTROUVABLE" && tts[2].body.territoire.ancetres.every((a: { niveau: string }) => a.niveau !== "NATION"), tts.map((r) => r.body));
  // Cadence (memoire du processus) puis delai cote base (dossiers de conflit verrouilles).
  _viderCadenceTableaux();
  process.env.PROJETS_VOIRIE_TABLEAU_CADENCE_MAX = "3";
  const rafale = [];
  for (let i = 0; i < 4; i++) rafale.push(await get("/tableau-de-bord", T.insp));
  delete process.env.PROJETS_VOIRIE_TABLEAU_CADENCE_MAX;
  verifier("7. cadence par compte : 3 tableaux puis 429 TABLEAU_DE_BORD_TROP_FREQUENT avec Retry-After", rafale.map((r) => r.status).join() === "200,200,200,429"
    && rafale[3].body.code === "TABLEAU_DE_BORD_TROP_FREQUENT" && Number(rafale[3].headers["retry-after"]) > 0, rafale.map((r) => r.status));
  _viderCadenceTableaux();
  const verrou2 = new Client({ connectionString: banc.urlClone });
  verrou2.on("error", () => undefined);
  await verrou2.connect();
  await verrou2.query("BEGIN");
  await verrou2.query(`LOCK TABLE "conflits_projet" IN ACCESS EXCLUSIVE MODE`);
  const t1 = Date.now();
  const tbloque = await get("/tableau-de-bord", T.lecteur);
  const duree2 = Date.now() - t1;
  await verrou2.query("ROLLBACK");
  await verrou2.end();
  await verrou.end();
  delete process.env.PROJETS_VOIRIE_VERROU_MS;
  verifier("7. delai cote base : table des dossiers verrouillee, 504 TABLEAU_DE_BORD_TROP_LONG en quelques secondes", tbloque.status === 504 && tbloque.body.code === "TABLEAU_DE_BORD_TROP_LONG" && duree2 < 8_000, { s: tbloque.status, duree2 });

  // ================================================================ 9. Corrections apres revue : confidentialite heritee (M1), remise apres l'envoi (M4), concurrence (m5), orientation (m6)
  const CT2: string = (await envoyer("post", "/concessionnaires", { nom: "Operateur Electricite Synthetique X1", typeReseau: "ELECTRICITE" })).body.concessionnaire.id;
  const ligneE = (dx: number, nom: string) => geojson([{ nom, pts: [[80 + dx, -10], [80 + dx, 10]] }]);
  const premierInterne = await depot(PID_D, await ligneE(0, "Ligne electrique X1"), { role: "RESEAU_TIERS", concessionnaireId: CT2, confidentialite: "INTERNE" }, "elec-x1.geojson");
  verifier("9. revue M1 : un gestionnaire ne depose pas un reseau de concessionnaire sous CONFIDENTIEL_CONCESSIONNAIRE (403 CONFIDENTIALITE_ABAISSEMENT_RESERVE), rien n'est cree",
    premierInterne.status === 403 && premierInterne.body.code === "CONFIDENTIALITE_ABAISSEMENT_RESERVE" && (await compter(`SELECT count(*) n FROM projets_voirie_jeux WHERE "concessionnaireId" = $1`, CT2)) === 0, premierInterne.body);
  const limitesInternes = await depot(PID, await geojson([{ nom: "Limite nord X1 v2", pts: [[0, 9], [200, 9]] }]), { role: "LIMITES_ROUTE", confidentialite: "INTERNE" }, "limites-x1-v2.geojson");
  verifier("9. revue M1 : une nouvelle version de limites de route (lignee RESTREINT_PROJET) deposee en INTERNE par un gestionnaire : 403 (abaissement sous la version precedente)",
    limitesInternes.status === 403 && limitesInternes.body.code === "CONFIDENTIALITE_ABAISSEMENT_RESERVE" && limitesInternes.body.plancher === "RESTREINT_PROJET", limitesInternes.body);
  const JE = await deposer(PID_D, await ligneE(0, "Ligne electrique X1"), { role: "RESEAU_TIERS", concessionnaireId: CT2 }, "elec-x1.geojson");
  await autoriser(PID_D, JE);
  const v2Gest = await depot(PID_D, await ligneE(1, "Ligne electrique X1 b"), { role: "RESEAU_TIERS", concessionnaireId: CT2, confidentialite: "INTERNE", justificationConfidentialite: "Le gestionnaire tente d'abaisser le niveau" }, "elec-x1-b.geojson");
  const v2Herite = await depot(PID_D, await ligneE(2, "Ligne electrique X1 c"), { role: "RESEAU_TIERS", concessionnaireId: CT2 }, "elec-x1-c.geojson");
  verifier("9. revue M1 : redepot en INTERNE d'un reseau autorise CONFIDENTIEL par un gestionnaire : 403 ; redepot sans niveau : herite CONFIDENTIEL_CONCESSIONNAIRE (avertissement CONFIDENTIALITE_HERITEE)",
    v2Gest.status === 403 && v2Gest.body.code === "CONFIDENTIALITE_ABAISSEMENT_RESERVE" && v2Herite.status === 201 && v2Herite.body.jeu.confidentialite === "CONFIDENTIEL_CONCESSIONNAIRE"
    && v2Herite.body.jeu.version === 2, { v2Gest: v2Gest.body, v2Herite: v2Herite.body.jeu?.confidentialite });
  await envoyer("post", `/${PID_D}/jeux/${v2Herite.body.jeu.id}/rejeter`, { justification: JUSTIF });
  const v2AdminSans = await depot(PID_D, await ligneE(3, "Ligne electrique X1 d"), { role: "RESEAU_TIERS", concessionnaireId: CT2, confidentialite: "INTERNE" }, "elec-x1-d.geojson", T.admin);
  const e9a = await exporter(PID_D, "", T.chef2);
  await issueDe(e9a.headers["x-export-id"]);
  const man9a = JSON.parse(relire(e9a.body as Buffer).get("dossier-x1-direct/manifeste.json")!.toString("utf8"));
  verifier("9. revue M1 : l'ADMIN sans justification : 400 JUSTIFICATION_INVALIDE ; le reseau CONFIDENTIEL reste ecarte de l'export sans derogation (CONFIDENTIALITE)",
    v2AdminSans.status === 400 && v2AdminSans.body.code === "JUSTIFICATION_INVALIDE" && man9a.geojson.ecartes.some((x: { jeuId: string; raison: string }) => x.jeuId === JE && x.raison === "CONFIDENTIALITE"), { b: v2AdminSans.body, e: man9a.geojson });
  const v2Admin = await depot(PID_D, await ligneE(4, "Ligne electrique X1 e"), { role: "RESEAU_TIERS", concessionnaireId: CT2, confidentialite: "INTERNE", justificationConfidentialite: "Trace public publie par le concessionnaire lui-meme" }, "elec-x1-e.geojson", T.admin);
  const auditAbaisse = (await sql<{ a: string }>(`SELECT after->'abaissementConfidentialite'->>'de' a FROM audit_logs WHERE "entityType" = 'JeuDonneesProjet' AND "entityId" = $1 AND action = 'CREATE'`, v2Admin.body.jeu?.id))[0]?.a;
  verifier("9. revue M1 : l'ADMIN abaisse avec une justification : 201 INTERNE, avertissement CONFIDENTIALITE_ABAISSEE, audit (de CONFIDENTIEL_CONCESSIONNAIRE)",
    v2Admin.status === 201 && v2Admin.body.jeu.confidentialite === "INTERNE" && v2Admin.body.avertissements.some((a: { code: string }) => a.code === "CONFIDENTIALITE_ABAISSEE")
    && auditAbaisse === "CONFIDENTIEL_CONCESSIONNAIRE", { b: v2Admin.body.avertissements, auditAbaisse });

  // m6 : un polygone saisi dans le sens horaire sort dans le sens trigonometrique (RFC 7946).
  const anneauHoraire: [number, number][] = [[0, 50], [0, 60], [10, 60], [10, 50], [0, 50]];
  const polyWgs = await sql<{ g: string }>(`SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromText($1), 32629), 4326), 9) AS g`, `POLYGON((${anneauHoraire.map(([x, y]) => `${E0 + x} ${N0 + y}`).join(",")}))`);
  const JPOLY = await deposer(PID_D, Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Emprise horaire X1" }, geometry: JSON.parse(polyWgs[0].g) }] })), { role: "LIMITES_ROUTE", confidentialite: "PUBLIC" }, "emprise-x1.geojson");
  await autoriser(PID_D, JPOLY);
  const stockeHoraire = (await sql<{ cw: boolean }>(`SELECT ST_IsPolygonCW(geom) cw FROM projets_voirie_objets WHERE "jeuId" = $1`, JPOLY))[0]?.cw;
  const e9b = await exporter(PID_D, "", T.admin);
  await issueDe(e9b.headers["x-export-id"]);
  const lus9 = relire(e9b.body as Buffer);
  const poly = JSON.parse(lus9.get([...lus9.keys()].find((k) => k.includes(JPOLY.toLowerCase()))!)!.toString("utf8"));
  const anneau: [number, number][] = poly.features[0].geometry.coordinates[0];
  const aire = anneau.slice(0, -1).reduce((s2, [x1, y1], i) => { const [x2, y2] = anneau[i + 1]; return s2 + (x1 * y2 - x2 * y1); }, 0) / 2;
  verifier("9. revue m6 : un polygone stocke dans le sens horaire sort dans le sens trigonometrique dans le GeoJSON (aire signee positive, RFC 7946)", stockeHoraire === true && aire > 0, { stockeHoraire, aire });

  // M4 : le client part avant la fin ; la derogation n'est pas consommee, la tentative est ECHEC_ENVOI ; un nouvel export la consomme.
  const d4 = await D({ jeuxIds: [JR], beneficiaireId: chef.id, dureeHeures: 1 });
  const D4 = d4.body.derogation?.id;
  const debutAbandon = new Date(Date.now() - 1000).toISOString();
  const abandon = await get(`/${PID}/export/dossier?derogation=${D4}`).timeout(80).then(() => "recu", (e: { timeout?: number }) => (e.timeout ? "abandon" : "autre"));
  let ligneAbandon: { id: string; s: string; c: string | null } | undefined;
  for (let i = 0; i < 80 && (!ligneAbandon || ligneAbandon.s === "EN_COURS"); i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    ligneAbandon = (await sql<{ id: string; s: string; c: string | null }>(`SELECT id, statut s, "codeEchec" c FROM exports_dossier_projet_voirie WHERE "acteurId" = $1 AND "derogationId" = $2 AND "createdAt" > $3::timestamp ORDER BY "createdAt" DESC LIMIT 1`, chef.id, D4, debutAbandon))[0];
  }
  const derogApres = (await sql<{ u: Date | null; e: string | null }>(`SELECT "utiliseeLe" u, "exportId" e FROM derogations_export_projet_voirie WHERE id = $1`, D4))[0];
  verifier("9. revue M4 : client parti pendant la fabrication : tentative ECHEC_ENVOI (CLIENT_DECONNECTE), derogation NON consommee et liberee, aucune remise consignee",
    abandon === "abandon" && ligneAbandon?.s === "ECHEC_ENVOI" && ligneAbandon.c === "CLIENT_DECONNECTE" && derogApres.u === null && derogApres.e === null
    && (await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportDossierProjetVoirie' AND after->>'exportId' = $1 AND after->>'statut' = 'REMIS'`, ligneAbandon.id)) === 0,
    { abandon, ligneAbandon, derogApres });
  await attendreSansEnCours();
  const reprise = await exporter(PID, `?derogation=${D4}`);
  const issueReprise = await issueDe(reprise.headers["x-export-id"]);
  verifier("9. revue M4 : la meme derogation sert ensuite a un export complet : REMIS apres l'envoi, derogation consommee par cette tentative",
    reprise.status === 200 && issueReprise === "REMIS" && (await compter(`SELECT count(*) n FROM derogations_export_projet_voirie WHERE id = $1 AND "exportId" = $2 AND "utiliseeLe" IS NOT NULL`, D4, reprise.headers["x-export-id"])) === 1,
    { s: reprise.status, issueReprise });

  // m5 : deux ouvertures de tentative EN PARALLELE (deux connexions, sans la place unique du compte) avec la meme derogation : une seule la reserve.
  const d5 = await D({ jeuxIds: [JS2], beneficiaireId: chef2.id, dureeHeures: 1 });
  const D5 = d5.body.derogation?.id;
  const acteur2 = { id: chef2.id, role: "GESTIONNAIRE" };
  const paralleles = await Promise.allSettled([_ouvrirTentativePourBanc(acteur2, PID, { geojson: true, derogationId: D5 }), _ouvrirTentativePourBanc(acteur2, PID, { geojson: true, derogationId: D5 })]);
  const resolus = paralleles.filter((x) => x.status === "fulfilled").length;
  const rejet = paralleles.find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
  const apresParalleles = await exporter(PID, `?derogation=${D5}`, T.chef2);
  verifier("9. revue m5 : deux tentatives paralleles avec la meme derogation (deux connexions) : une reservation, l'autre 409 DEROGATION_INDISPONIBLE ; un export pendant la reservation : 409 RESERVEE",
    resolus === 1 && rejet?.reason?.code === "DEROGATION_INDISPONIBLE" && apresParalleles.status === 409 && JSON.parse(apresParalleles.body.toString()).etat === "RESERVEE"
    && (await compter(`SELECT count(*) n FROM derogations_export_projet_voirie WHERE id = $1 AND "exportId" IS NOT NULL AND "utiliseeLe" IS NULL`, D5)) === 1,
    { resolus, rejet: rejet?.reason?.code, s: apresParalleles.status });

  // ================================================================ 8. Projet supprime, isolation, audit
  await envoyer("delete", `/${PID_B}`, undefined, T.admin);
  const supp = await Promise.all([exporter(PID_B, "", T.admin), get(`/${PID_B}/export/journal`, T.admin), get(`/${PID_B}/export/derogations`, T.admin), envoyer("post", `/${PID_B}/export/derogations`, { jeuxIds: [JV], justification: "Apres suppression du projet de banc", beneficiaireId: chef.id }, T.admin)]);
  verifier("8. projet supprime : 404 PROJET_INTROUVABLE sur l'export, le journal et les derogations, ADMIN compris", supp.every((r) => r.status === 404), supp.map((r) => r.status));
  const tApres = await get(`/tableau-de-bord/territoires/${TREG1}`, T.admin);
  verifier("8. tableau apres suppression : le projet supprime n'est plus compte (2 projets sous la region)", tApres.body.total.projets === 2, tApres.body.total);
  await attendreSansEnCours();
  const nbExports = await compter(`SELECT count(*) n FROM exports_dossier_projet_voirie WHERE statut = 'REMIS'`);
  const nbAudits = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportDossierProjetVoirie' AND after->>'statut' = 'REMIS'`);
  const auditsTous = await sql<{ after: string }>(`SELECT after::text AS after FROM audit_logs WHERE "entityType" IN ('ExportDossierProjetVoirie', 'DerogationExportProjetVoirie')`);
  verifier("8. une ligne d'audit de remise par archive REMIS ; aucun audit ne porte de coordonnee", nbExports === nbAudits && nbExports >= 4
    && auditsTous.every((a) => !/coordinates|LineString|Point/.test(a.after)), { nbExports, nbAudits });
  verifier("8. isolation : troncons du referentiel identiques (md5) ; les tableaux de bord n'ont rien ecrit", (await empreinteTroncons()) === troncons0);

  const sortie = process.env.EXPORTS_EXEMPLES;
  if (sortie) writeFileSync(sortie, JSON.stringify(exemples, null, 2));
}

try {
  await main();
} catch (e) {
  console.error(e);
  verifier("le banc va jusqu'au bout (aucune exception)", false, String(e));
} finally {
  conclure();
  await prisma.$disconnect();
  await banc.fermer();
}
