// Banc d'integration du metre geometrique branche sur la saisie du defaut (scenario d'acceptation A5 :
// « surface/longueur calculee en projection metrique, ecart < 1 % sur geometries de test connues »).
// Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/metre-defaut.integration.mts
//
// Le contour passe par la route reelle `POST /api/v2/defauts` et par la synchronisation
// `POST /api/v2/sync/push`, puis par `metre_utm` (PostGIS) dans un clone jetable. Les valeurs attendues
// viennent de `lib/geodesie.ts`, ecrit SANS PostGIS ni PROJ (series de Kruger, Vincenty, aire
// authalique) et lui-meme confronte a PROJ et a un cas publie (`lib/geodesie.test.ts`).
//
// Deux familles de references, pour que l'une ne puisse pas excuser l'autre :
//   - figures CONSTRUITES en metres UTM (un carre de 100 m a 10 000 m2 par construction) ;
//   - figures definies en degres, dont la grandeur vraie vient de l'ELLIPSOIDE (aire d'un rectangle de
//     graticule, longueur de Vincenty) et pas de la projection que le code utilise.
//
// Les lignes sont relues en SQL : le client Prisma genere par ce poste ne connait pas encore la valeur
// d'enumeration EMPRISE_UTM (voir la migration 20261024300000), il ne sait pas relire ces lignes.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";
import { aireRectangleEllipsoide, fuseauDeLongitude, longueurLigneGeodesique, utmVersLonLat } from "./lib/geodesie.ts";
import { randomUUID } from "node:crypto";

const banc = await ouvrirBancClone("essai_metre", {
  migrations: ["20261024300000_defaut_methode_emprise_utm", "20261024310000_defaut_emprise_coherence"],
});
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
type LonLat = [number, number];
const ecartRelatif = (mesure: number, attendu: number) => Math.abs(mesure - attendu) / attendu;
const pc = (x: number) => `${(x * 100).toFixed(4)} %`;

const lignes: string[] = [];
let pireEcart = 0;
function consigner(nom: string, attendu: number, mesure: number, unite: string) {
  const e = ecartRelatif(mesure, attendu);
  pireEcart = Math.max(pireEcart, e);
  lignes.push(`  ${nom.padEnd(58)} attendu ${attendu.toFixed(3).padStart(14)} ${unite}  mesure ${mesure.toFixed(3).padStart(14)}  ecart ${pc(e)}`);
}

async function main() {
  const admin = await prisma.user.create({ data: { email: "admin@banc.invalid", nomComplet: "Admin banc", passwordHash: "x", role: "ADMIN" } });
  const jeton = signAccessToken({ sub: admin.id, role: "ADMIN", email: admin.email });
  const appareil = await prisma.appareil.create({ data: { userId: admin.id, nom: "tel", plateforme: "android" } });
  for (const [code, unite, requises, graviteMax] of [
    ["FISS_B", "METRE", ["LONGUEUR"], 4], ["FAIEN_B", "METRE_CARRE", ["LONGUEUR", "LARGEUR"], 4],
    ["NID_B", "METRE_CUBE", ["LONGUEUR", "LARGEUR", "PROFONDEUR"], 4], ["SIGN_B", "UNITE", ["NOMBRE"], null],
  ] as const) {
    await prisma.catalogueDefaut.create({ data: { code, libelle: code, famille: "CHAUSSEE", unite, mesuresRequises: [...requises], graviteMax } });
  }

  const poster = (corps: Record<string, unknown>) => request(app).post("/api/v2/defauts").set("Authorization", `Bearer ${jeton}`).send(corps);
  const pousser = (operations: unknown[]) => request(app).post("/api/v2/sync/push").set("Authorization", `Bearer ${jeton}`).send({ appareilId: appareil.id, operations });
  const ligneBase = async (id: string) => (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT quantite, "uniteQuantite"::text AS unite, "methodeQuantite"::text AS methode, emprise IS NOT NULL AS "aEmprise", ST_GeometryType(emprise) AS type FROM defauts WHERE id='${id}'`))[0];

  /** Cree un defaut a contour et rend [mesure retournee, ligne relue en base]. */
  const creer = async (catalogueCode: string, emprise: unknown, mesures: Record<string, number> = {}) => {
    const g = emprise as { coordinates: unknown };
    const premier = (function p(c: unknown): LonLat { return Array.isArray(c) && typeof c[0] === "number" ? [c[0] as number, c[1] as number] : p((c as unknown[])[0]); })(g.coordinates);
    const r = await poster({ catalogueCode, lon: premier[0], lat: premier[1], gravite: catalogueCode === "SIGN_B" ? undefined : 2, mesures, emprise });
    return { r, ligne: r.body?.id ? await ligneBase(r.body.id) : null };
  };
  const polygone = (pts: LonLat[]) => ({ type: "Polygon", coordinates: [[...pts, pts[0]]] });
  const ligneGJ = (pts: LonLat[]) => ({ type: "LineString", coordinates: pts });
  const carreUtm = (e: number, n: number, cote: number, fuseau: number): LonLat[] =>
    [[e, n], [e + cote, n], [e + cote, n + cote], [e, n + cote]].map(([x, y]) => { const p = utmVersLonLat(x, y, fuseau); return [p.lon, p.lat] as LonLat; });

  console.log("\n== A5 : le metre geometrique branche sur la saisie du defaut ==");

  // ---------------------------------------------------------------- 1. Figures construites en metres UTM
  for (const [fuseau, e0, n0] of [[28, 653600, 1061500], [29, 554700, 1127500]] as const) {
    for (const cote of [10, 100, 500, 2000]) {
      const { r, ligne } = await creer("FAIEN_B", polygone(carreUtm(e0, n0, cote, fuseau)));
      const attendu = cote * cote;
      consigner(`carre de ${cote} m construit en UTM ${fuseau}N`, attendu, ligne?.quantite as number, "m2");
      verifier(`1. carre de ${cote} m (UTM ${fuseau}N) : ${attendu} m2 a moins de 1 % (A5), EPSG ${32600 + fuseau}`,
        r.status === 201 && ecartRelatif(ligne?.quantite as number, attendu) < 0.01 && r.body.metreEmprise?.epsg === 32600 + fuseau, { statut: r.status, corps: r.body });
      verifier(`1. ... et meme a 1 ppm pres (la mesure est fidele, pas seulement dans la tolerance)`, ecartRelatif(ligne?.quantite as number, attendu) < 1e-5, ecartRelatif(ligne?.quantite as number, attendu));
    }
  }
  const trait1000 = [[653600, 1061500], [654600, 1061500]].map(([x, y]) => { const p = utmVersLonLat(x, y, 28); return [p.lon, p.lat] as LonLat; });
  const l1 = await creer("FISS_B", ligneGJ(trait1000));
  consigner("ligne de 1 000 m construite en UTM 28N", 1000, l1.ligne?.quantite as number, "m");
  verifier("1. ligne de 1 000 m construite en UTM : 1 000 m a moins de 1 ppm", ecartRelatif(l1.ligne?.quantite as number, 1000) < 1e-5, l1.ligne);
  const poly = [[653600, 1061500], [653900, 1061900], [653900, 1062500]].map(([x, y]) => { const p = utmVersLonLat(x, y, 28); return [p.lon, p.lat] as LonLat; });
  const l2 = await creer("FISS_B", ligneGJ(poly));
  consigner("polyligne de 2 segments (500 m + 600 m) en UTM 28N", 1100, l2.ligne?.quantite as number, "m");
  verifier("1. polyligne (500 m + 600 m) : 1 100 m a moins de 1 ppm", ecartRelatif(l2.ligne?.quantite as number, 1100) < 1e-5);

  // ---------------------------------------------------------------- 2. Figures definies en degres : l'ellipsoide fait foi
  const villes: [string, number, number][] = [
    ["Conakry", -13.68, 9.55], ["Boke", -14.29, 10.94], ["Labe (pres de 12 deg O)", -12.28, 11.32],
    ["Kankan", -9.30, 10.38], ["Siguiri", -9.17, 11.42], ["Nzerekore", -8.82, 7.75], ["Faranah", -10.75, 10.04],
  ];
  for (const [nom, lon, lat] of villes) {
    for (const cote of [0.001, 0.01, 0.05]) {
      const pts: LonLat[] = [[lon, lat], [lon + cote, lat], [lon + cote, lat + cote], [lon, lat + cote]];
      const attendu = aireRectangleEllipsoide(lon, lon + cote, lat, lat + cote);
      const { r, ligne } = await creer("FAIEN_B", polygone(pts));
      consigner(`rectangle ${cote} deg a ${nom}`, attendu, ligne?.quantite as number, "m2");
      const fuseauAttendu = fuseauDeLongitude(lon + cote / 2);
      verifier(`2. rectangle de ${cote} deg a ${nom} : aire ellipsoidale a moins de 1 % (A5), fuseau ${fuseauAttendu}N`,
        r.status === 201 && ecartRelatif(ligne?.quantite as number, attendu) < 0.01 && r.body.metreEmprise?.epsg === 32600 + fuseauAttendu,
        { attendu, mesure: ligne?.quantite, epsg: r.body.metreEmprise?.epsg });
    }
  }
  const lignesDegres: [string, LonLat[]][] = [
    ["meridien 0,1 deg a Conakry (11 km)", [[-13.6, 9.6], [-13.6, 9.7]]],
    ["parallele 0,1 deg a Kankan (11 km)", [[-9.35, 10.38], [-9.25, 10.38]]],
    ["diagonale de 25 km autour de Faranah", [[-10.9, 9.9], [-10.7, 10.1]]],
    ["trace de 80 km a plusieurs sommets (Kankan - Siguiri)", [[-9.31, 10.38], [-9.25, 10.55], [-9.2, 10.8], [-9.15, 11.05], [-9.17, 11.42]]],
    ["ligne de 300 km a cheval sur 12 deg O (zone choisie par son point interieur)", [[-13.4, 10.0], [-12.6, 10.0], [-12.0, 10.0], [-11.2, 10.0], [-10.7, 10.0]]],
    ["traversee du pays, 790 km (-14,9 a -7,7 a 10 deg N)", [[-14.9, 10.0], [-13.0, 10.0], [-11.0, 10.0], [-9.0, 10.0], [-7.7, 10.0]]],
  ];
  for (const [nom, pts] of lignesDegres) {
    const attendu = longueurLigneGeodesique(pts);
    const { r, ligne } = await creer("FISS_B", ligneGJ(pts));
    consigner(nom, attendu, ligne?.quantite as number, "m");
    verifier(`2. ${nom} : longueur de Vincenty a moins de 1 % (A5)`, r.status === 201 && ecartRelatif(ligne?.quantite as number, attendu) < 0.01, { attendu, mesure: ligne?.quantite, corps: r.body });
  }

  // ---------------------------------------------------------------- 3. Le fuseau suit le point interieur, de part et d'autre de 12 deg O
  const ouest = await creer("FAIEN_B", polygone([[-12.0105, 9.0], [-12.0005, 9.0], [-12.0005, 9.01], [-12.0105, 9.01]]));
  const est = await creer("FAIEN_B", polygone([[-11.9995, 9.0], [-11.9895, 9.0], [-11.9895, 9.01], [-11.9995, 9.01]]));
  verifier("3. de part et d'autre de 12 deg O : 28N a l'ouest, 29N a l'est (meme regle que epsg_utm, ecrite independamment)",
    ouest.r.body.metreEmprise?.epsg === 32628 && est.r.body.metreEmprise?.epsg === 32629, [ouest.r.body.metreEmprise?.epsg, est.r.body.metreEmprise?.epsg]);
  verifier("3. ... et la surface reste juste des deux cotes (deformation voisine de la limite)",
    ecartRelatif(ouest.ligne?.quantite as number, aireRectangleEllipsoide(-12.0105, -12.0005, 9.0, 9.01)) < 0.01
    && ecartRelatif(est.ligne?.quantite as number, aireRectangleEllipsoide(-11.9995, -11.9895, 9.0, 9.01)) < 0.01);

  // ---------------------------------------------------------------- 4. Ce que la saisie en fait
  const carre = polygone(carreUtm(653600, 1061500, 100, 28));
  const c4 = await creer("FAIEN_B", carre);
  verifier("4. un defaut surfacique sans longueur ni largeur saisies est ACCEPTE grace au contour (releve complet)", c4.r.status === 201);
  verifier("4. la ligne porte quantite, unite METRE_CARRE et methode EMPRISE_UTM, et le contour (Polygon) est stocke",
    c4.ligne?.unite === "METRE_CARRE" && c4.ligne?.methode === "EMPRISE_UTM" && c4.ligne?.aEmprise === true && c4.ligne?.type === "ST_Polygon", c4.ligne);
  const stocke = JSON.parse((await prisma.$queryRawUnsafe<{ g: string }[]>(`SELECT ST_AsGeoJSON(emprise, 15) g FROM defauts WHERE id='${c4.r.body.id}'`))[0].g) as { coordinates: number[][][] };
  const ecartSommets = Math.max(...stocke.coordinates[0].flatMap((p, i) => [Math.abs(p[0] - carre.coordinates[0][i][0]), Math.abs(p[1] - carre.coordinates[0][i][1])]));
  verifier("4. le contour stocke est celui qui a ete envoye (5 sommets, ecart maximal < 1e-9 degre)", stocke.coordinates[0].length === 5 && ecartSommets < 1e-9, ecartSommets);
  const sansContour = await poster({ catalogueCode: "FAIEN_B", lat: 9.5, lon: -13.7, gravite: 2 });
  verifier("4. SANS contour, le meme defaut reste refuse : releve incomplet, longueur et largeur nommees", sansContour.status === 422 && sansContour.body.motif === "RELEVE_INCOMPLET"
    && JSON.stringify(sansContour.body.manquantes) === '["LONGUEUR","LARGEUR"]', sansContour.body);
  const qual = await prisma.$queryRawUnsafe<{ statut: string; methode: string | null }[]>(`SELECT statut::text, methode FROM valeurs_qualite WHERE "entityType"='Defaut' AND "entityId"='${c4.r.body.id}' AND champ='quantite'`);
  verifier("4. la provenance de la quantite est DERIVED / EMPRISE_UTM (un contour mesure n'est pas un constat saisi)", qual[0]?.statut === "DERIVED" && qual[0]?.methode === "EMPRISE_UTM", qual);
  const aud = await prisma.$queryRawUnsafe<{ after: { emprise?: { type: string; epsg: number } } }[]>(`SELECT after FROM audit_logs WHERE "entityType"='Defaut' AND "entityId"='${c4.r.body.id}'`);
  verifier("4. la creation est auditee avec le type de contour et le fuseau", aud.length === 1 && aud[0].after.emprise?.epsg === 32628 && aud[0].after.emprise?.type === "Polygon", aud);

  const c5 = await creer("FAIEN_B", carre, { quantiteSaisie: 7 });
  verifier("4. la quantite SAISIE l'emporte (SAISIE, 7 m2) mais le contour est conserve", c5.ligne?.methode === "SAISIE" && Number(c5.ligne?.quantite) === 7 && c5.ligne?.aEmprise === true, c5.ligne);
  const c6 = await creer("FISS_B", carre);
  verifier("4. un polygone pour un type en METRE ne donne pas de longueur : releve incomplet (la longueur reste exigee), rien d'invente", c6.r.status === 422 && c6.r.body.motif === "RELEVE_INCOMPLET", c6.r.body);
  const c7 = await creer("NID_B", carre, { profondeurM: 0.06 });
  verifier("4. un METRE_CUBE : surface du contour x profondeur saisie (10 000 x 0,06 = 600 m3)", c7.r.status === 201 && ecartRelatif(Number(c7.ligne?.quantite), 600) < 1e-5 && c7.ligne?.unite === "METRE_CUBE", c7.ligne);
  const c8 = await creer("NID_B", carre);
  verifier("4. ... la profondeur n'est JAMAIS remplacee par un contour : elle est exigee", c8.r.status === 422 && JSON.stringify(c8.r.body.manquantes) === '["PROFONDEUR"]', c8.r.body);
  const c9 = await creer("SIGN_B", carre, { nombre: 3 });
  verifier("4. un type qui se compte garde son comptage (3), le contour n'est que de la localisation", c9.r.status === 201 && Number(c9.ligne?.quantite) === 3 && c9.ligne?.methode === "COMPTAGE" && c9.ligne?.aEmprise === true, c9.ligne);

  // ---------------------------------------------------------------- 5. Refus : rien n'est ecrit
  const avant = [await compter(`SELECT count(*) n FROM defauts`), await compter(`SELECT count(*) n FROM observations`)].join("/");
  const noeud = await creer("FAIEN_B", polygone([[-13.6, 9.6], [-13.59, 9.61], [-13.59, 9.6], [-13.6, 9.61]]));   // noeud papillon
  verifier("5. un contour en noeud papillon est refuse avec la raison de PostGIS (EMPRISE_INVALIDE), jamais repare",
    noeud.r.status === 422 && noeud.r.body.motif === "EMPRISE_INVALIDE" && /Self-intersection/i.test(noeud.r.body.message), noeud.r.body);
  const nul = await creer("FISS_B", ligneGJ([[-13.6, 9.6], [-13.6, 9.6]]));
  verifier("5. une ligne de longueur nulle est refusee (EMPRISE_INVALIDE)", nul.r.status === 422 && nul.r.body.motif === "EMPRISE_INVALIDE", nul.r.body);
  const enUtm = { r: await poster({ catalogueCode: "FISS_B", lat: 9.6, lon: -13.6, gravite: 2, emprise: ligneGJ([[653632, 1061500], [654632, 1061500]]) }) };
  verifier("5. un contour en metres UTM envoye comme du 4326 est refuse (EMPRISE_ILLISIBLE), pas mesure dans l'Atlantique", enUtm.r.status === 422 && enUtm.r.body.motif === "EMPRISE_ILLISIBLE", enUtm.r.body);
  const trop = await creer("FISS_B", { type: "LineString", coordinates: Array.from({ length: 20001 }, (_, i) => [-13.6 + i * 1e-6, 9.6 + (i % 2) * 1e-6]) });
  verifier("5. un contour de plus de 20 000 positions est refuse", trop.r.status === 422 && trop.r.body.motif === "EMPRISE_ILLISIBLE", trop.r.body.motif);
  verifier("5. aucun refus n'a laisse la moindre ligne : memes nombres de defauts et d'observations", [await compter(`SELECT count(*) n FROM defauts`), await compter(`SELECT count(*) n FROM observations`)].join("/") === avant, avant);
  const sortie = await creer("FISS_B", ligneGJ([[-13.6, 9.6], [-13.0, 9.6]]), {});
  verifier("5. controle de la figure precedente : 60 km tracees sans troncon sont mesurees (pas de troncon, pas de depassement)", sortie.r.status === 201);

  // ---------------------------------------------------------------- 6. La base tient la coherence methode <-> contour
  const sansContourCree = await poster({ catalogueCode: "FISS_B", lat: 9.6, lon: -13.6, gravite: 2, mesures: { longueurM: 12 } });   // un defaut SANS contour
  let refuse = false, code = "";
  try { await prisma.$executeRawUnsafe(`UPDATE defauts SET "methodeQuantite" = 'EMPRISE_UTM' WHERE id = '${sansContourCree.body.id}' AND emprise IS NULL`); }
  catch (e) { refuse = true; code = String((e as { meta?: { code?: string } }).meta?.code ?? (e as { code?: string }).code); }
  verifier("6. la base refuse la methode EMPRISE_UTM sur un defaut sans contour (CHECK, code 23514)", refuse && code === "23514", code);
  verifier("6. toute ligne portant EMPRISE_UTM a un contour en base",
    await compter(`SELECT count(*) n FROM defauts WHERE "methodeQuantite"::text = 'EMPRISE_UTM' AND emprise IS NULL`) === 0
    && await compter(`SELECT count(*) n FROM defauts WHERE "methodeQuantite"::text = 'EMPRISE_UTM'`) > 20);

  // ---------------------------------------------------------------- 7. Hors ligne : le contour passe par la synchronisation
  const idOp = randomUUID();
  const op = (id: string, emprise: unknown, extra: Record<string, unknown> = {}) => ({
    operationId: id, entityType: "Defaut", entityId: id, operation: "CREATE", baseVersion: null,
    payload: { catalogueCode: "FAIEN_B", lat: 9.6, lon: -13.6, gravite: 2, emprise, ...extra },
  });
  const p1 = await pousser([op(idOp, carre)]);
  const l7 = await ligneBase(idOp);
  verifier("7. un defaut a contour remonte du terrain : SYNCHRONISE, quantite 10 000 m2 (EMPRISE_UTM), contour stocke",
    p1.body.synchronisees === 1 && ecartRelatif(Number(l7?.quantite), 10000) < 1e-5 && l7?.methode === "EMPRISE_UTM" && l7?.aEmprise === true, { corps: p1.body, l7 });
  const p2 = await pousser([op(idOp, carre)]);
  verifier("7. le rejeu rend REJOUEE sans rien reecrire : 1 seul defaut, 1 seul contour", p2.body.rejouees === 1
    && await compter(`SELECT count(*) n FROM defauts WHERE id='${idOp}'`) === 1);
  const idMauvais = randomUUID();
  const p3 = await pousser([op(idMauvais, polygone([[-13.6, 9.6], [-13.59, 9.61], [-13.59, 9.6], [-13.6, 9.61]]))]);
  verifier("7. un contour invalide remonte du terrain est REJETE (EMPRISE_INVALIDE), sans defaut ni conteneur d'observation",
    p3.body.resultats?.[0]?.motif === "EMPRISE_INVALIDE" && await compter(`SELECT count(*) n FROM defauts WHERE id='${idMauvais}'`) === 0
    && await compter(`SELECT count(*) n FROM observations WHERE "clientOperationId" LIKE '${idMauvais}%'`) === 0, p3.body);
  const idInconnu = randomUUID();
  const p4 = await pousser([op(idInconnu, carre, { empriseM2: 12 })]);
  verifier("7. un champ voisin non declare reste refuse par le contrat du payload", /PAYLOAD_INVALIDE/.test(p4.body.resultats?.[0]?.motif ?? ""), p4.body);
  const audSync = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='Defaut' AND "entityId"='${idOp}'`);
  verifier("7. le defaut synchronise est audite une fois", audSync === 1, audSync);
  const qualSync = await prisma.$queryRawUnsafe<{ statut: string }[]>(`SELECT statut::text FROM valeurs_qualite WHERE "entityType"='Defaut' AND "entityId"='${idOp}' AND champ='quantite'`);
  verifier("7. sa quantite est DERIVED", qualSync[0]?.statut === "DERIVED", qualSync);

  // ---------------------------------------------------------------- Bilan
  console.log("\nFigures de reference :");
  for (const l of lignes) console.log(l);
  console.log(`\nPire ecart relatif sur ${lignes.length} figures : ${pc(pireEcart)} (seuil A5 : 1 %)`);
  verifier(`8. bilan : le pire ecart sur ${lignes.length} figures de reference est ${pc(pireEcart)}, sous le seuil de 1 % (A5)`, pireEcart < 0.01 && lignes.length >= 35, pireEcart);

  conclure();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); await banc.fermer(); });
