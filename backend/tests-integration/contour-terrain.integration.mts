// Banc d'integration du CONTOUR RELEVE A PIED (scenario A5, ecran `DefautTerrainPage`) : le code de l'APPAREIL
// (frontend/src/lib/contourDefaut.ts, pur, importe tel quel) est confronte a la VRAIE validation du SERVEUR (PostGIS).
// Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`, jamais ecrite : le banc travaille dans un clone) :
//   npx tsx tests-integration/contour-terrain.integration.mts
//
// Ce que ce banc affirme, et pourquoi il existe :
//   1. FAUSSES ACCEPTATIONS : sur un corpus nomme puis 4 000 polygones tires au hasard (graine fixe), tout contour que
//      le client juge valide est valide pour `ST_IsValid` ; tout contour que le client refuse pour croisement l'est aussi
//      pour PostGIS. Le client est une garde, le serveur l'arbitre : le client ne doit jamais laisser passer ce que le
//      serveur refusera, et ne doit pas refuser ce que le serveur accepterait.
//   2. L'EMPRISE produite par le client est mesuree par le serveur a 0,02 % de la valeur construite (carre de 100 m en UTM ;
//      l'ecart vient de l'arrondi a 7 decimales des coordonnees envoyees, soit 1 cm par sommet : 13 ppm mesures le 23/10/2026,
//      tres en dessous du 1 % de A5), par la route reelle `POST /v2/defauts` ET par la file hors ligne `POST /v2/sync/push`.
//   3. LA REGLE DES MESURES EXIGEES (`mesuresRequisesAvecContour`) est celle du serveur, unite par unite : le serveur
//      accepte le releve avec exactement les mesures que le client exige, et refuse en nommant la mesure retiree quand
//      on en enleve une que le client exige.
//   4. Le client ne produit aucune surface : la seule surface du banc est celle que le serveur rend.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";
import { utmVersLonLat } from "./lib/geodesie.ts";
import { randomUUID } from "node:crypto";
import { mesuresRequisesAvecContour, validerContour, evaluerSommet, type SommetContour, type UniteDefaut } from "../../frontend/src/lib/contourDefaut.ts";

const banc = await ouvrirBancClone("essai_contour_terrain", {
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

type LonLat = [number, number];
const ecartRelatif = (mesure: number, attendu: number) => Math.abs(mesure - attendu) / attendu;

// ------------------------------------------------------------------ figures en metres locaux autour d'un point
const LAT0 = 9.64;
const LON0 = -13.6;
const M_LAT = 1 / 111_320;
const M_LON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const MAINTENANT = 1_790_000_000_000;
const sommet = (dx: number, dy: number, precisionM = 4): SommetContour => ({ lat: LAT0 + dy * M_LAT, lon: LON0 + dx * M_LON, precisionM, poseLe: MAINTENANT });
const sommets = (pts: [number, number][], precisionM = 4) => pts.map(([x, y]) => sommet(x, y, precisionM));

/** Ce que le serveur dit d'un anneau (sommets dans l'ordre, ferme par le premier) : l'ARBITRE. */
async function verdictServeur(pts: SommetContour[]): Promise<{ valide: boolean; raison: string }> {
  const anneau = [...pts, pts[0]].map((s) => [s.lon, s.lat]);
  const geojson = JSON.stringify({ type: "Polygon", coordinates: [anneau] });
  const r = await prisma.$queryRaw<{ valide: boolean; raison: string }[]>`
    SELECT ST_IsValid(g) AS "valide", ST_IsValidReason(g) AS "raison" FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) AS g) s`;
  return r[0];
}

/** Graine fixe : le corpus aleatoire est le meme a chaque lancement (mulberry32). */
function prng(graine: number) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  console.log("\n== A5 : le contour releve a pied, confronte au serveur ==");

  // ---------------------------------------------------------------- 1. Corpus nomme
  const corpus: [string, [number, number][], boolean][] = [
    ["carre de 10 m", [[0, 0], [10, 0], [10, 10], [0, 10]], true],
    ["carre pose dans le sens horaire", [[0, 0], [0, 10], [10, 10], [10, 0]], true],
    ["triangle", [[0, 0], [10, 0], [5, 8]], true],
    ["forme en L (concave)", [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]], true],
    ["peigne a 3 dents (tres concave)", [[0, 0], [30, 0], [30, 20], [25, 20], [25, 5], [20, 5], [20, 20], [15, 20], [15, 5], [10, 5], [10, 20], [5, 20], [5, 5], [0, 5]], true],
    ["etoile a 5 branches", Array.from({ length: 10 }, (_, i): [number, number] => { const r = i % 2 === 0 ? 10 : 4; const a = (Math.PI * i) / 5; return [r * Math.cos(a), r * Math.sin(a)]; }), true],
    ["cercle de 12 m a 48 sommets", Array.from({ length: 48 }, (_, i): [number, number] => [6 * Math.cos((2 * Math.PI * i) / 48), 6 * Math.sin((2 * Math.PI * i) / 48)]), true],
    ["rectangle fin (0,5 m x 30 m)", [[0, 0], [30, 0], [30, 0.5], [0, 0.5]], true],
    ["noeud papillon", [[0, 0], [10, 10], [10, 0], [0, 10]], false],
    ["noeud papillon symetrique (aire signee nulle)", [[-10, -10], [10, 10], [10, -10], [-10, 10]], false],
    ["demi-tour sur place (un cote recouvre le precedent)", [[0, 0], [10, 0], [10, 10], [10, 5]], false],
    ["fermeture qui croise un cote", [[0, 0], [10, 0], [10, 10], [20, 10]], false],
    ["sommet pose sur un cote deja pose (contact)", [[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]], false],
    ["sommets alignes", [[0, 0], [10, 0], [20, 0]], false],
    ["trois sommets dont deux confondus", [[0, 0], [10, 0], [0, 0]], false],
  ];
  for (const [nom, pts, attendu] of corpus) {
    const s = sommets(pts);
    const client = validerContour(s);
    const serveur = await verdictServeur([...new Map(s.map((x) => [`${x.lat.toFixed(7)}|${x.lon.toFixed(7)}`, x])).values()]);
    verifier(`1. ${nom} : le client dit ${client.ok ? "valide" : client.motif}, attendu ${attendu ? "valide" : "refuse"}`, client.ok === attendu, client);
    if (client.ok) verifier(`1. ${nom} : le serveur (ST_IsValid) est du meme avis : valide`, serveur.valide, serveur);
    else if (client.motif === "AUTO_INTERSECTION") verifier(`1. ${nom} : refuse par le client pour croisement, ET invalide pour PostGIS (${serveur.raison})`, !serveur.valide, serveur);
  }

  // ---------------------------------------------------------------- 2. Fuzz : jamais de fausse acceptation
  const alea = prng(20261026);
  const comptes = { accepteAccepte: 0, fausseAcceptation: 0, croisementAccorde: 0, croisementContredit: 0, autres: 0 };
  const contredits: unknown[] = [];
  const fausses: unknown[] = [];
  // 4 000 par defaut (environ 10 minutes sur un poste charge) ; CONTOUR_FUZZ=600 pour une contre-epreuve rapide.
  const N = Number(process.env.CONTOUR_FUZZ ?? 4000);
  for (let i = 0; i < N; i += 1) {
    const n = 3 + Math.floor(alea() * 6);
    const pts: [number, number][] = Array.from({ length: n }, () => [Math.round(alea() * 6000) / 100, Math.round(alea() * 6000) / 100]);
    const s = sommets(pts);
    const client = validerContour(s);
    const serveur = await verdictServeur(s);
    if (client.ok) {
      if (serveur.valide) comptes.accepteAccepte += 1;
      else { comptes.fausseAcceptation += 1; fausses.push({ pts, raison: serveur.raison }); }
    } else if (client.motif === "AUTO_INTERSECTION") {
      if (!serveur.valide) comptes.croisementAccorde += 1;
      else { comptes.croisementContredit += 1; contredits.push({ pts, message: client.message }); }
    } else comptes.autres += 1;
  }
  console.log(`  fuzz de ${N} polygones : ${JSON.stringify(comptes)}`);
  verifier(`2. ${N} polygones aleatoires : AUCUNE fausse acceptation (client valide, ST_IsValid faux)`, comptes.fausseAcceptation === 0, fausses.slice(0, 3));
  verifier("2. ... aucun refus pour croisement que PostGIS jugerait valide (le client n'est pas plus strict sur les croisements)", comptes.croisementContredit === 0, contredits.slice(0, 3));
  const plancher = Math.floor(N / 14);
  verifier(`2. ... le corpus est utile : au moins ${plancher} contours acceptes ET ${plancher} refus pour croisement`, comptes.accepteAccepte >= plancher && comptes.croisementAccorde >= plancher, comptes);

  // ---------------------------------------------------------------- 3. Controle incremental : un sommet refuse a la pose ne peut qu'etre un croisement reel
  let refusPose = 0;
  let refusPoseJustifie = 0;
  const POSES = Math.min(600, N);
  for (let i = 0; i < POSES; i += 1) {
    const n = 4 + Math.floor(alea() * 4);
    const pts: [number, number][] = Array.from({ length: n }, () => [Math.round(alea() * 6000) / 100, Math.round(alea() * 6000) / 100]);
    const poses: SommetContour[] = [];
    for (const [x, y] of pts) {
      const s = sommet(x, y);
      const d = evaluerSommet({ lat: s.lat, lon: s.lon, precisionM: 4, releveeLe: MAINTENANT - 500 }, poses, MAINTENANT);
      if (d.ok) { poses.push(d.sommet); continue; }
      if (d.motif !== "CROISE_LE_CONTOUR") continue;
      refusPose += 1;
      // Si le sommet refuse avait ete pose, le contour PARTIEL (ligne brisee) + fermeture serait-il invalide pour PostGIS ?
      // On teste la ligne brisee posee + le sommet refuse : au moins trois sommets, on demande au serveur si l'anneau est valide.
      if (poses.length >= 2) {
        const v = await verdictServeur([...poses, s]);
        if (!v.valide) refusPoseJustifie += 1;
      }
    }
  }
  console.log(`  sommets refuses a la pose pour croisement : ${refusPose}, dont ${refusPoseJustifie} dont l'anneau serait invalide pour PostGIS`);
  verifier("3. les sommets refuses pour croisement a la pose sont nombreux dans le corpus (le controle sert)", refusPose >= Math.floor(POSES / 6), refusPose);
  verifier("3. ... et chacun d'eux ferait un anneau invalide pour PostGIS : aucun refus a la pose n'est injustifie", refusPoseJustifie === refusPose, { refusPose, refusPoseJustifie });

  // ---------------------------------------------------------------- 4. Le contour du client traverse les routes reelles
  const admin = await prisma.user.create({ data: { email: "admin@banc.invalid", nomComplet: "Admin banc", passwordHash: "x", role: "ADMIN" } });
  const jeton = signAccessToken({ sub: admin.id, role: "ADMIN", email: admin.email });
  const appareil = await prisma.appareil.create({ data: { userId: admin.id, nom: "tel", plateforme: "android" } });
  const types = [
    ["FISS_T", "METRE", ["LONGUEUR"], 4], ["FAIEN_T", "METRE_CARRE", ["LONGUEUR", "LARGEUR"], 4],
    ["NID_T", "METRE_CUBE", ["LONGUEUR", "LARGEUR", "PROFONDEUR"], 4], ["SIGN_T", "UNITE", ["NOMBRE"], null],
  ] as const;
  for (const [code, unite, requises, graviteMax] of types) {
    await prisma.catalogueDefaut.create({ data: { code, libelle: code, famille: "CHAUSSEE", unite, mesuresRequises: [...requises], graviteMax } });
  }
  const poster = (corps: Record<string, unknown>) => request(app).post("/api/v2/defauts").set("Authorization", `Bearer ${jeton}`).send(corps);
  const pousser = (operations: unknown[]) => request(app).post("/api/v2/sync/push").set("Authorization", `Bearer ${jeton}`).send({ appareilId: appareil.id, operations });
  const metre = (geometrie: unknown) => request(app).post("/api/v2/geo/metre").set("Authorization", `Bearer ${jeton}`).send({ geometrie });
  const ligneBase = async (id: string) => (await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT quantite, "uniteQuantite"::text AS unite, "methodeQuantite"::text AS methode, emprise IS NOT NULL AS "aEmprise" FROM defauts WHERE id = ${id}`)[0];

  // Un carre de 100 m CONSTRUIT en UTM 28N, releve "a pied" : sommets pris par le client (precision 4 m), puis emprise du client.
  const carreUtm = [[653600, 1061500], [653700, 1061500], [653700, 1061600], [653600, 1061600]].map(([e, n]) => utmVersLonLat(e, n, 28));
  const poses = carreUtm.map((p): SommetContour => ({ lat: p.lat, lon: p.lon, precisionM: 4, poseLe: MAINTENANT }));
  const contour = validerContour(poses);
  verifier("4. le carre de 100 m construit en UTM est un contour valide pour le client", contour.ok, contour);
  if (!contour.ok) return conclure();
  const emprise = contour.emprise;
  const mesureServeur = await metre(emprise);
  // Tolerance : l'arrondi a 7 decimales (1 cm par sommet) borne l'ecart a perimetre x 0,55 cm = 2,2 m2 sur 400 m, soit 2,2e-4.
  const TOLERANCE_ARRONDI = 2.2e-4;
  verifier("4. POST /v2/geo/metre : surface du serveur a 0,02 % de 10 000 m2 (fuseau 28N, arrondi des coordonnees a 1 cm)", mesureServeur.status === 200 && ecartRelatif(Number(mesureServeur.body.surfaceM2), 10000) < TOLERANCE_ARRONDI && Number(mesureServeur.body.epsg) === 32628, mesureServeur.body);

  const enLigne = await poster({ catalogueCode: "FAIEN_T", lat: carreUtm[0].lat, lon: carreUtm[0].lon, gravite: 2, emprise });
  const ligneEnLigne = await ligneBase(enLigne.body.id);
  verifier("4. POST /v2/defauts avec l'emprise du client, SANS longueur ni largeur : 201, 10 000 m2 a 0,02 %, methode EMPRISE_UTM, contour stocke",
    enLigne.status === 201 && ecartRelatif(Number(ligneEnLigne?.quantite), 10000) < TOLERANCE_ARRONDI && ligneEnLigne?.methode === "EMPRISE_UTM" && ligneEnLigne?.aEmprise === true, { statut: enLigne.status, corps: enLigne.body, ligne: ligneEnLigne });

  const idOp = randomUUID();
  const sync = await pousser([{ operationId: idOp, entityType: "Defaut", entityId: idOp, operation: "CREATE", baseVersion: null,
    payload: { catalogueCode: "FAIEN_T", lat: carreUtm[0].lat, lon: carreUtm[0].lon, precisionM: 4, constateA: new Date().toISOString(), gravite: 2, emprise } }]);
  const ligneSync = await ligneBase(idOp);
  verifier("4. la MEME emprise par la file hors ligne (POST /v2/sync/push) : SYNCHRONISE, 10 000 m2 a 0,02 %, EMPRISE_UTM",
    sync.body.synchronisees === 1 && ecartRelatif(Number(ligneSync?.quantite), 10000) < TOLERANCE_ARRONDI && ligneSync?.methode === "EMPRISE_UTM", { corps: sync.body, ligne: ligneSync });

  const bowtie = [[-13.6, 9.6], [-13.59, 9.61], [-13.59, 9.6], [-13.6, 9.61]];
  const idMauvais = randomUUID();
  const refusSync = await pousser([{ operationId: idMauvais, entityType: "Defaut", entityId: idMauvais, operation: "CREATE", baseVersion: null,
    payload: { catalogueCode: "FAIEN_T", lat: 9.6, lon: -13.6, gravite: 2, emprise: { type: "Polygon", coordinates: [[...bowtie, bowtie[0]]] } } }]);
  const bowtieClient = validerContour(sommets([[0, 0], [10, 10], [10, 0], [0, 10]]));
  verifier("4. un contour que le client refuserait (noeud papillon) est AUSSI refuse par le serveur (EMPRISE_INVALIDE) s'il lui parvenait",
    !bowtieClient.ok && refusSync.body.resultats?.[0]?.motif === "EMPRISE_INVALIDE", { client: bowtieClient, serveur: refusSync.body });

  // ---------------------------------------------------------------- 5. La regle des mesures exigees, unite par unite
  type Mesure = "NOMBRE" | "LONGUEUR" | "LARGEUR" | "PROFONDEUR";
  const cle: Record<Mesure, string> = { NOMBRE: "nombre", LONGUEUR: "longueurM", LARGEUR: "largeurM", PROFONDEUR: "profondeurM" };
  for (const [code, unite, requises] of types) {
    const exigees = mesuresRequisesAvecContour(unite as UniteDefaut, requises as unknown as Mesure[], true) as Mesure[];
    const tout = (m: Mesure[]) => Object.fromEntries(m.map((x) => [cle[x], x === "NOMBRE" ? 3 : x === "PROFONDEUR" ? 0.06 : 2]));
    const corps = (mesures: Record<string, number>) => ({ catalogueCode: code, lat: carreUtm[0].lat, lon: carreUtm[0].lon, gravite: code === "SIGN_T" ? undefined : 2, mesures, emprise });
    const accepte = await poster(corps(tout(exigees)));
    verifier(`5. ${code} (${unite}) : le serveur ACCEPTE le releve avec EXACTEMENT les mesures que le client exige [${exigees.join(", ") || "aucune"}]`, accepte.status === 201, { statut: accepte.status, corps: accepte.body });
    for (const retiree of exigees) {
      const refus = await poster(corps(tout(exigees.filter((m) => m !== retiree))));
      verifier(`5. ${code} : sans ${retiree}, que le client exige, le serveur REFUSE et la nomme (RELEVE_INCOMPLET)`,
        refus.status === 422 && refus.body.motif === "RELEVE_INCOMPLET" && (refus.body.manquantes ?? []).includes(retiree), { statut: refus.status, corps: refus.body });
    }
    // Les mesures que le client NE demande PLUS sont bien celles que le serveur ne demande pas : meme ensemble, ni plus ni moins.
    const retirees = (requises as unknown as Mesure[]).filter((m) => !exigees.includes(m));
    if (retirees.length > 0) verifier(`5. ${code} : les mesures que le contour remplace (${retirees.join(", ")}) ne sont pas exigees par le serveur`, accepte.status === 201);
  }

  // ---------------------------------------------------------------- 6. Aucune surface ne vient du client
  verifier("6. l'emprise produite par le client ne contient que type et coordonnees : aucune surface, aucune aire", Object.keys(emprise).sort().join() === "coordinates,type" && !/surface|aire/i.test(JSON.stringify(contour)), contour);
  verifier("6. la seule surface du banc est celle rendue par le serveur : le client n'en expose aucune", !("surfaceM2" in contour) && !("aire" in contour));

  conclure();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); await banc.fermer(); });
