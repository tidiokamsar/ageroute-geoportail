// Banc du correctif D7 (pilote local du 09/11/2026) : un dossier COUVERTURE_INSUFFISANTE par AXE du plan d'axes, plus par objet.
// Lancer (DATABASE_URL pointe sur `replay`, qui porte toutes les migrations du depot) :
//   npx tsx tests-integration/conflits-couverture-axes.integration.mts
// Donnees 100 % synthetiques : un corridor de 100 morceaux de 200 m (un par « feuille de plan »), un axe court, deux objets sans nom ; un reseau
// dont l'emprise englobante couvre les 40 premiers morceaux ; des feuilles de noms differents rattachees par la colonne identifiant du mapping.
//
// CE QUE LE BANC AFFIRME : un seul dossier par axe nomme (geometrie = reunion des morceaux NON couverts, mesure = nombre, longueur totale et detail
// par morceau ; la liste ne porte pas le detail) ; un objet sans nom garde son propre dossier, sans morceaux ; cle stable au rejeu (0 nouveau,
// 0 ligne d'historique) ; un morceau ajoute garde la cle et marque le dossier MESURE_MODIFIEE (historique avant / apres) ; la colonne
// identifiant du mapping regroupe des feuilles de noms differents ; un dossier PAR OBJET d'une ancienne analyse rejouee reste en base, son statut
// intact, marque NON_RETROUVE avec une ligne REEXAMEN qui cite le dossier regroupe ; les dossiers des autres types sont ceux d'avant.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";
import { avecTerritoireParDefaut } from "./lib/territoire-par-defaut.mts";

process.env.PROJETS_VOIRIE_ANALYSE_INTERVALLE_S = "0";
const banc = await ouvrirBancClone("essai_couverture_d7");
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const request = (await import("supertest")).default;
const app = avecTerritoireParDefaut(createApp(), prisma);
const BASE = "/api/v2/projets-voirie";
const sql = <T = Record<string, unknown>>(texte: string, ...v: unknown[]) => prisma.$queryRawUnsafe(texte, ...v) as Promise<T[]>;

const LON0 = -10.2, LAT0 = 9.1;
const M_LAT = 1 / 110_574, M_LON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const pt = (xm: number, ym: number): [number, number] => [Math.round((LON0 + xm * M_LON) * 1e7) / 1e7, Math.round((LAT0 + ym * M_LAT) * 1e7) / 1e7];
const ligne = (x0: number, x1: number, y: number) => ({ type: "LineString", coordinates: [pt(x0, y), pt((x0 + x1) / 2, y), pt(x1, y)] });
const fc = (features: unknown[]) => Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
const feuille = (i: number, props: Record<string, unknown> = { name: "Corridor synthetique" }) => ({ type: "Feature", properties: props, geometry: ligne(i * 200, (i + 1) * 200, 0) });

async function main() {
  const admin = await prisma.user.create({ data: { email: "admin@couverture.invalid", nomComplet: "Admin couverture", passwordHash: "x", role: "ADMIN", modulesAutorises: [] } });
  const T = signAccessToken({ sub: admin.id, role: admin.role, email: admin.email });
  const get = (c: string) => request(app).get(`${BASE}${c}`).set("Authorization", `Bearer ${T}`);
  const conc = (await request(app).post(`${BASE}/concessionnaires`).set("Authorization", `Bearer ${T}`).send({ nom: "Operateur couverture", typeReseau: "TELECOM" })).body.concessionnaire.id as string;
  const projet = async (code: string) => (await request(app).post(BASE).set("Authorization", `Bearer ${T}`).send({ code, nom: code, largeurChausseeM: 7, largeurEmpriseM: 15 })).body.projet.id as string;
  const deposer = async (pid: string, nom: string, f: Buffer, champs: Record<string, string>) => {
    const r = request(app).post(`${BASE}/${pid}/jeux`).set("Authorization", `Bearer ${T}`);
    for (const [k, v] of Object.entries(champs)) r.field(k, v);
    const rep = await r.attach("fichier", f, { filename: nom });
    if (rep.status !== 201) throw new Error(`depot ${nom} : ${rep.status} ${JSON.stringify(rep.body).slice(0, 400)}`);
    const a = await request(app).post(`${BASE}/${pid}/jeux/${rep.body.jeu.id}/autoriser`).set("Authorization", `Bearer ${T}`).send({ justification: "Jeu synthetique du banc D7" });
    if (a.status !== 200) throw new Error(`autorisation ${nom} : ${a.status} ${JSON.stringify(a.body).slice(0, 400)}`);
    return rep.body.jeu.id as string;
  };
  const analyser = (pid: string) => request(app).post(`${BASE}/${pid}/analyses`).set("Authorization", `Bearer ${T}`).send({});
  const couvertures = async (pid: string) => (await get(`/${pid}/conflits?type=COUVERTURE_INSUFFISANTE&limite=200`)).body.conflits as { id: string; cle: string; axe: string; statut: string; aReexaminer: boolean; motifReexamen: string | null; mesure: Record<string, any> }[];
  const nbHistorique = async (pid: string) => Number((await sql<{ n: number }>(`SELECT count(*)::int n FROM "conflits_projet_historique" h JOIN "conflits_projet" c ON c."id" = h."conflitId" WHERE c."projetId" = $1`, pid))[0].n);

  // ================================================================ 1. Corridor de 100 morceaux, axe court, deux objets sans nom
  const P1 = await projet("D7-CORRIDOR");
  const axes = [
    ...Array.from({ length: 100 }, (_, i) => feuille(i)),
    { type: "Feature", properties: { name: "Axe court synthetique" }, geometry: ligne(0, 300, 3000) },
    { type: "Feature", properties: {}, geometry: ligne(0, 250, 6000) },
    { type: "Feature", properties: {}, geometry: ligne(1000, 1250, 6000) },
  ];
  await deposer(P1, "axes-d7.geojson", fc(axes), { role: "AXES_TRAVAUX" });
  // Reseau : une ligne en diagonale dont l'emprise englobante contient les 40 premiers morceaux du corridor (et eux seuls), plus une ligne qui croise le corridor.
  await deposer(P1, "reseau-d7.geojson", fc([
    { type: "Feature", properties: { name: "Diagonale" }, geometry: { type: "LineString", coordinates: [pt(-5, -40), pt(8005, 40)] } },
  ]), { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });

  const a1 = await analyser(P1);
  const r1 = a1.body.resume;
  verifier("1. analyse 201, version de l'algorithme RC3-2D-UTM-2", a1.status === 201 && a1.body.analyse.versionAlgorithme === "RC3-2D-UTM-2", [a1.status, a1.body.analyse?.versionAlgorithme, a1.body.code]);
  verifier("1. couverture : 4 dossiers (le corridor, l'axe court, deux objets sans nom) pour 63 objets non couverts (60 + 1 + 2), au lieu d'un par objet",
    r1.parType.COUVERTURE_INSUFFISANTE === 4 && r1.totaux.axesNonCouverts === 4 && r1.totaux.morceauxNonCouverts === 63 && r1.totaux.axes === 103, r1.totaux);
  verifier("1. la limite du resume dit le nombre d'axes et d'objets non couverts", r1.limites.some((l: string) => l.startsWith("4 axe(s) (63 objet(s) du plan d'axes)")), r1.limites);
  const c1 = await couvertures(P1);
  const corr = c1.find((c) => c.axe === "Corridor synthetique")!;
  verifier("1. corridor : UN dossier, A_INVESTIGUER, 60 morceaux, longueur de la reunion = somme des 60 morceaux (environ 12 000 m)",
    c1.filter((c) => c.axe === "Corridor synthetique").length === 1 && corr.statut === "A_INVESTIGUER" && corr.mesure.morceaux.nb === 60
    && proche(corr.mesure.longueurPieceM, 12_000, 5) && proche(corr.mesure.morceaux.longueurTotaleM, corr.mesure.longueurPieceM, 0.05), corr?.mesure);
  verifier("1. la LISTE ne porte pas le detail des morceaux (nombre, longueur totale, detailTronque seulement)",
    corr.mesure.morceaux.detail === undefined && corr.mesure.morceaux.detailTronque === false, corr.mesure.morceaux);
  const fiche = (await get(`/${P1}/conflits/${corr.id}`)).body;
  const det = fiche.conflit.mesure.morceaux.detail as { ordre: number; longueurM: number; nom: string; objetId: string }[];
  verifier("1. FICHE : detail des 60 morceaux non couverts, ranges 40 a 99 du fichier dans l'ordre, environ 200 m chacun, avec nom et objet",
    det.length === 60 && det.every((d, i) => d.ordre === 40 + i && proche(d.longueurM, 200, 1) && d.nom === "Corridor synthetique" && /^\d+$/.test(d.objetId)), det.slice(0, 3));
  verifier("1. FICHE : la geometrie est la reunion des morceaux non couverts, contigus, fusionnes en une ligne", fiche.conflit.geometrie?.type === "LineString", fiche.conflit.geometrie?.type);
  const sansNom = c1.filter((c) => /^Axe \d+$/.test(c.axe));
  verifier("1. objets sans nom : chacun garde son propre dossier (libelle « Axe <rang> »), sans morceaux, comme avant le correctif",
    sansNom.length === 2 && sansNom.every((c) => c.mesure.morceaux === undefined && proche(c.mesure.longueurPieceM, 250, 1)), sansNom.map((c) => [c.axe, c.mesure]));
  const autres1 = (await get(`/${P1}/conflits?limite=200`)).body.conflits.filter((c: { type: string }) => c.type !== "COUVERTURE_INSUFFISANTE");
  verifier("1. les dossiers des autres types sont produits comme avant (la diagonale coupe le corridor : traversee et intersections)",
    autres1.some((c: { type: string }) => c.type === "TRAVERSEE") && autres1.every((c: { mesure: Record<string, unknown> }) => c.mesure.morceaux === undefined), autres1.map((c: { type: string }) => c.type));

  // ================================================================ 2. Rejeu : meme entree, meme cle, aucun historique ajoute
  const h1 = await nbHistorique(P1);
  const a2 = await analyser(P1);
  const c2 = await couvertures(P1);
  verifier("2. rejeu : 0 nouveau, 0 modifie, 0 disparu, toutes les cles retrouvees a l'identique",
    a2.status === 201 && a2.body.resume.nouveaux === 0 && a2.body.resume.modifies === 0 && a2.body.resume.disparus === 0 && a2.body.resume.identiques === a2.body.resume.totaux.conflitsTrouves, a2.body.resume);
  verifier("2. rejeu : memes cles de couverture, aucune ligne d'historique ajoutee (ajout seul preserve)",
    JSON.stringify(c2.map((c) => c.cle).sort()) === JSON.stringify(c1.map((c) => c.cle).sort()) && (await nbHistorique(P1)) === h1, [await nbHistorique(P1), h1]);

  // ================================================================ 3. Nouvelle version du plan : un morceau de plus
  const court = c2.find((c) => c.axe === "Axe court synthetique")!;
  const majAvant = (await sql<{ u: string }>(`SELECT "updatedAt"::text u FROM "conflits_projet" WHERE "id" = $1`, court.id))[0].u;
  await deposer(P1, "axes-d7-v2.geojson", fc([...axes, feuille(100)]), { role: "AXES_TRAVAUX" });
  const a3 = await analyser(P1);
  const c3 = await couvertures(P1);
  const corr3 = c3.find((c) => c.axe === "Corridor synthetique")!;
  verifier("3. un morceau ajoute : MEME dossier (meme cle, meme identifiant), 61 morceaux, marque a reexaminer MESURE_MODIFIEE ; aucun nouveau dossier de couverture",
    a3.status === 201 && corr3.id === corr.id && corr3.cle === corr.cle && corr3.mesure.morceaux.nb === 61 && corr3.aReexaminer && corr3.motifReexamen === "MESURE_MODIFIEE"
    && c3.length === 4, [corr3?.mesure?.morceaux?.nb, corr3?.motifReexamen, c3.length]);
  const court3 = (await sql<{ u: string; motif: string | null; m: { morceaux: { detail: { objetId: string }[] } } }>(`SELECT "updatedAt"::text u, "motifReexamen"::text motif, "mesure" m FROM "conflits_projet" WHERE "id" = $1`, court.id))[0];
  verifier("3. axe court inchange dans la nouvelle version : marque NOUVELLE_VERSION_DONNEES, `updatedAt` inchange (la mesure n a pas change), detail repointe sur l objet de la nouvelle version",
    court3.motif === "NOUVELLE_VERSION_DONNEES" && court3.u === majAvant && (await sql<{ n: number }>(`SELECT count(*)::int n FROM "projets_voirie_objets" o JOIN "projets_voirie_jeux" j ON j."id" = o."jeuId" WHERE o."id" = $1::bigint AND j."statut" = 'AUTORISE'`, court3.m.morceaux.detail[0].objetId))[0].n === 1, [court3.motif, court3.u, majAvant]);
  const hist3 = (await get(`/${P1}/conflits/${corr.id}`)).body.historique as { action: string; donnees: Record<string, any> }[];
  const mm = hist3.find((h) => h.action === "MESURE_MODIFIEE");
  verifier("3. historique en ajout seul : CREATION conservee, ligne MESURE_MODIFIEE avec avant (60 morceaux) et apres (61)",
    hist3[0].action === "CREATION" && mm?.donnees.avant.morceaux.nb === 60 && mm?.donnees.apres.morceaux.nb === 61, hist3.map((h) => h.action));

  // ================================================================ 4. Ancienne analyse rejouee : dossier PAR OBJET d'avant le correctif
  // Un dossier de couverture tel que l'ecrivait RC3-2D-UTM-1 (un par objet, mesure sans morceaux, autre cle), confirme par une personne.
  const legacyId = "00000000-0000-4000-8000-00000000d701";
  await sql(`INSERT INTO "conflits_projet" ("id", "projetId", "cle", "type", "axe", "jeuReseauId", "jeuAxesId", "objetId", "concessionnaireId", "mesure", "geom", "statut", "classePrecision", "verticalEvalue", "premiereAnalyseId", "derniereAnalyseId", "aReexaminer", "motifReexamen", "tronconsProches")
             SELECT $1, c."projetId", repeat('d7', 32), c."type", c."axe", NULL, c."jeuAxesId", NULL, NULL,
                    '{"longueurChausseeM":0,"longueurEmpriseM":0,"distanceMinM":null,"nbCroisements":0,"longueurPieceM":200}'::jsonb, c."geom", 'INFIRME', NULL, false, c."premiereAnalyseId", c."premiereAnalyseId", false, NULL, '[]'::jsonb
               FROM "conflits_projet" c WHERE c."id" = $2`, legacyId, corr.id);
  const a4 = await analyser(P1);
  const leg = (await sql<{ statut: string; are: boolean; motif: string | null }>(`SELECT "statut"::text statut, "aReexaminer" are, "motifReexamen"::text motif FROM "conflits_projet" WHERE "id" = $1`, legacyId))[0];
  const legHist = await sql<{ action: string; donnees: Record<string, any> }>(`SELECT "action"::text action, "donnees" FROM "conflits_projet_historique" WHERE "conflitId" = $1 ORDER BY "createdAt"`, legacyId);
  verifier("4. ancien dossier par objet : reste en base, verdict humain INFIRME intact, marque NON_RETROUVE (a reexaminer)",
    a4.status === 201 && leg?.statut === "INFIRME" && leg.are === true && leg.motif === "NON_RETROUVE", leg);
  verifier("4. sa ligne REEXAMEN cite le dossier regroupe de son axe (regroupeDans : identifiant et cle du dossier du corridor)",
    legHist.length === 1 && legHist[0].action === "REEXAMEN" && legHist[0].donnees.motif === "NON_RETROUVE" && legHist[0].donnees.regroupeDans?.conflitId === corr.id && legHist[0].donnees.regroupeDans?.cle === corr.cle, legHist);

  // ================================================================ 5. Colonne identifiant du mapping
  const feuilles = Array.from({ length: 10 }, (_, i) => feuille(i, { name: `Feuille ${i + 1}`, code: "AX-1" }));
  const P2 = await projet("D7-IDENTIFIANT");
  await deposer(P2, "axes-code.geojson", fc(feuilles), { role: "AXES_TRAVAUX", mapping: JSON.stringify({ identifiant: "code" }) });
  const a5 = await analyser(P2);
  const c5 = await couvertures(P2);
  verifier("5. colonne identifiant du mapping : 10 feuilles de noms differents et de meme code = UN dossier (libelle du premier morceau), 10 morceaux",
    a5.status === 201 && c5.length === 1 && c5[0].axe === "Feuille 1" && c5[0].mesure.morceaux.nb === 10, c5.map((c) => [c.axe, c.mesure.morceaux?.nb]));
  const P3 = await projet("D7-SANS-MAPPING");
  await deposer(P3, "axes-sans-code.geojson", fc(feuilles), { role: "AXES_TRAVAUX" });
  const c6 = (await analyser(P3)).status === 201 ? await couvertures(P3) : [];
  verifier("5. le meme fichier SANS mapping : regroupement par nom, donc 10 dossiers d'un morceau", c6.length === 10 && c6.every((c) => c.mesure.morceaux.nb === 1), c6.length);

  // ================================================================ 6. Audit et geometrie
  const audit = await sql<{ n: number }>(`SELECT count(*)::int n FROM "audit_logs" WHERE "entityType" = 'AnalyseConflitProjet' AND ("after"::text ILIKE '%coordinates%' OR "after"::text ILIKE '%0102000020%')`);
  verifier("6. audit des analyses : aucune geometrie", audit[0].n === 0, audit);
}

try {
  await main();
} catch (e) {
  console.error("ERREUR du banc :", e);
  process.exitCode = 1;
} finally {
  if (process.env.PV_GARDER_CLONE !== "1") await banc.fermer();
  await prisma.$disconnect();
}
conclure();
