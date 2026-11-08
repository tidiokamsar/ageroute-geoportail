// Banc d'integration des INTERVENTIONS PRIORISEES du module d'aide a la decision (lot AD-3). Voir tests-integration/README.md
// et docs/aide-decision/PRIORISATION.md. Lancer (DATABASE_URL pointe sur `replay`, jamais ecrite : le banc travaille dans le
// clone `essai_ad_l3_priorites`, cree puis detruit par lui) :
//   npx tsx tests-integration/aide-decision-priorites.integration.mts
//
// CE QUE LE BANC FAIT
//   Il monte le VRAI routeur `aide-decision.interventions.routes` (vrais requireAuth / requireModuleAccess / requireRole / gardes
//   territoriales, jetons signes par des secrets aleatoires, module et perimetre lus en base) devant la VRAIE base PostGIS (un clone
//   de `replay`), avec un jeu de troncons, points noirs, inspections et qualite de donnee ecrit a la main.
//
// L'ORACLE : le score de priorite technique, la couverture, le statut, l'urgence, le cout et l'ordre d'arbitrage sont recalcules par
// des REQUETES SQL qui ne partagent aucun code avec le TypeScript (arithmetique NUMERIC, parametres lus dans la table
// `parametres_programmation`), puis compares a ce que l'API rend. Les ensembles de la carte (emprise, validite de la geometrie), du
// territoire et des filtres de date sont eux aussi comptes par SQL.
//
// CE QUE LE BANC PROUVE
//   - score, couverture, statut (CALCULE / INCOMPLET / EXCLU), rang, urgence, cout et ordre d'arbitrage egaux a l'oracle ;
//   - « zero point noir » (registre de la region exploite) distinct de « registre non fiable » ; une alerte non confirmee et un
//     point rejete ou supprime ne comptent pas ;
//   - la priorite technique et l'ordre d'arbitrage sont deux classements distincts : un troncon critique et tres cher reste premier
//     de la priorite technique et n'est pas premier de l'arbitrage ;
//   - troncon supprime, a valider ou de voirie promue : absents ; geometrie absente : dans la liste (localisation invalide), pas sur la carte ;
//   - pagination par curseur sans doublon ni saut ; filtres region / classe / etat / dates egaux a l'oracle ;
//   - GeoJSON : emprise, plafond, `tronque`, `total` egaux a l'oracle ;
//   - un compte regional ne voit que sa region, aucun total national, 404 de meme corps hors perimetre ;
//   - parametres : creation et approbation par les routes, audit de l'auteur de la SESSION, version immuable en base ;
//   - AUCUNE ecriture : empreintes des tables de patrimoine, de marches, de chantiers, de budgets, de scenarios et de fiches
//     identiques avant et apres toutes les lectures ; seuls `parametres_programmation` et `audit_logs` bougent, par les routes de parametres ;
//   - entrees hostiles : jamais de 500 ;
//   - MESURE de la duree du classement de 3 000 candidats generes dans une TRANSACTION ANNULEE (le clone n'est pas modifie).
//
// CE QUE LE BANC NE PROUVE PAS : les donnees sont synthetiques (aucune donnee de production) ; les durees sont celles d'un poste de
// developpement charge par d'autres processus ; la pertinence metier des poids et des seuils (provisoires, sans source).
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure, proche } from "./lib/verdict.ts";

// server.ts pose ce correctif au demarrage (les montants BigInt sortent en chaine).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_ad_l3_priorites");
const { prisma } = await banc.imp("lib/prisma");
const { aideDecisionInterventionsRouter } = await banc.imp("api-v2/aide-decision.interventions.routes");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const service = await banc.imp("programmation/priorite.service");
const depot = await banc.imp("programmation/priorite.depot");
const noyau = await banc.imp("programmation/priorite.noyau");
const moteurDepot = await banc.imp("programmation/moteur.depot");
const request = (await import("supertest")).default;
const express = (await import("express")).default;

const app = express();
app.use(express.json());
app.use("/api/v2/aide-decision", aideDecisionInterventionsRouter);
app.use(errorHandler);

const sql = async <T = Record<string, unknown>>(texte: string, ...params: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...params);
const exec = (texte: string, ...params: unknown[]) => prisma.$executeRawUnsafe(texte, ...params);
const compter = async (texte: string, ...params: unknown[]): Promise<number> => Number((await sql<{ n: bigint }>(texte, ...params))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
type Rep = { status: number; body: any; headers: Record<string, string> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (token: string | null, url: string): Promise<Rep> => {
  let r = request(app).get(url);
  if (token) r = r.set("Authorization", `Bearer ${token}`);
  return r as unknown as Promise<Rep>;
};
const post = (token: string, url: string, corps?: object): Promise<Rep> => {
  const r = request(app).post(url).set("Authorization", `Bearer ${token}`);
  return (corps ? r.send(corps) : r) as unknown as Promise<Rep>;
};
const B = "/api/v2/aide-decision";
const AUJOURDHUI = new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ geometrie des fixtures

const LAT0 = 9.6;
const LON0 = -13.7;
const ligne = (rang: number): [number, number][] => [[LON0, LAT0 + rang * 0.01], [LON0 + 0.02, LAT0 + rang * 0.01]]; // environ 2,2 km
const wkt = (pts: [number, number][]) => `LINESTRING(${pts.map(([x, y]) => `${x} ${y}`).join(", ")})`;

interface Fix {
  code: string; etat: string; rev?: string; classe?: string; region: number; jma?: number | null; crit?: number | null; longueurKm: number;
  geom?: "ok" | "null" | "papillon"; src?: string | null; statut?: string | null; supprime?: boolean; dateEval?: string | null; rang: number;
}

async function main() {
  // ------------------------------------------------------------------ fixtures
  await exec(`INSERT INTO regions (nom) VALUES ('Region AD3 1'), ('Region AD3 2')`);
  const regionId = async (n: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, n))[0].id);
  const [R1, R2] = [await regionId("Region AD3 1"), await regionId("Region AD3 2")];
  const mk = (email: string, role: string, modulesAutorises: string[]) =>
    prisma.user.create({ data: { email: `${email}@ad3.invalid`, nomComplet: email, passwordHash: "x", role, modulesAutorises } });
  const admin = await mk("admin", "ADMIN", []);
  const gest = await mk("gest", "GESTIONNAIRE", ["decision"]);
  const lecteur = await mk("lecteur", "LECTEUR", ["decision"]);
  const gestR1 = await mk("gest-r1", "GESTIONNAIRE", ["decision"]);
  const gestR2 = await mk("gest-r2", "GESTIONNAIRE", ["decision"]);
  const sansModule = await mk("sans-module", "GESTIONNAIRE", ["programmation", "dashboard"]);
  const inspecteur = await mk("inspecteur", "INSPECTEUR", ["inspections"]);
  await exec(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $3, $5), ($2, $4, $5)`, gestR1.id, gestR2.id, R1, R2, admin.id);
  const T = { admin: jeton(admin), gest: jeton(gest), lect: jeton(lecteur), r1: jeton(gestR1), r2: jeton(gestR2), sans: jeton(sansModule) };

  const troncon = async (f: Fix) => {
    const geom = f.geom === "null" ? null : f.geom === "papillon" ? "LINESTRING(0 0, 0 0)" : wkt(ligne(f.rang));
    await exec(
      `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "traficMoyenJma", "criticiteStrategique", "sourceReference", "statutValidation", "deletedAt", "dateDerniereEvaluation", geom, "updatedAt")
       VALUES ($1, $2, $3, $4::"ClasseRoute", $5, $6, $7::"Revetement", $8::"EtatPatrimoine", 0, $6, $9, $10, $11, $12::"StatutValidation", $13, $14::timestamp, ${geom ? "ST_GeomFromText($15, 4326)" : "NULL"}, now())`,
      ...[`t-${f.code}`, f.code, `Troncon ${f.code}`, f.classe ?? "RN", f.region, f.longueurKm, f.rev ?? "BITUME", f.etat, f.jma ?? null, f.crit ?? null, f.src ?? null,
        f.statut ?? null, f.supprime ? new Date() : null, f.dateEval ?? null, ...(geom ? [geom] : [])]);
  };
  const pn = async (tronconCode: string | null, region: number, n: number, o: { statut?: string | null; supprime?: boolean } = {}) => {
    for (let i = 0; i < n; i++) {
      await exec(
        `INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "statutValidation", "deletedAt", "updatedAt")
         VALUES (gen_random_uuid()::text, 'pn ad3', $1, ${tronconCode ? `(SELECT id FROM troncons WHERE code = $4)` : "NULL"}, 'FORTE'::"Gravite", $2::"StatutValidation", $3, now())`,
        ...[region, o.statut ?? null, o.supprime ? new Date() : null, ...(tronconCode ? [tronconCode] : [])]);
    }
  };
  const inspection = async (code: string, date: string, etat: string) =>
    exec(`INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "createdAt") VALUES (gen_random_uuid()::text, (SELECT id FROM troncons WHERE code = $1), $2, $3::timestamp, $4::"EtatPatrimoine", now())`, code, inspecteur.id, date, etat);

  const FIX: Fix[] = [
    { code: "AD3-A1", etat: "CRITIQUE", region: R1, jma: 4000, longueurKm: 2.2, rang: 1 },
    { code: "AD3-A2", etat: "MAUVAIS", region: R1, jma: null, crit: 60, longueurKm: 2.2, rang: 2 },
    { code: "AD3-A3", etat: "NON_EVALUE", region: R1, jma: 3000, longueurKm: 2.2, rang: 3 },
    { code: "AD3-A4", etat: "MOYEN", region: R1, jma: 800, longueurKm: 2.2, rang: 4, dateEval: "2026-02-01" },
    { code: "AD3-A5", etat: "BON", region: R2, jma: 300, longueurKm: 2.2, rang: 5, classe: "RR" },
    { code: "AD3-A6", etat: "CRITIQUE", region: R1, jma: 1500, longueurKm: 2.2, rang: 6 },
    { code: "AD3-A7", etat: "MAUVAIS", region: R1, jma: 2500, longueurKm: 2.2, rang: 7 },
    { code: "AD3-A8", etat: "MAUVAIS", region: R1, jma: 2500, longueurKm: 3, rang: 8, geom: "null" },
    { code: "AD3-A9", etat: "MAUVAIS", region: R1, jma: 1000, longueurKm: 10, rang: 9 },
    { code: "AD3-A10", etat: "MAUVAIS", region: R1, jma: 1000, longueurKm: 0, rang: 10 },
    { code: "AD3-DEL", etat: "CRITIQUE", region: R1, jma: 5000, longueurKm: 2.2, rang: 11, supprime: true },
    { code: "AD3-AVAL", etat: "CRITIQUE", region: R1, jma: 5000, longueurKm: 2.2, rang: 12, statut: "A_VALIDER" },
    { code: "AD3-VOIRIE", etat: "CRITIQUE", region: R1, jma: 5000, longueurKm: 2.2, rang: 13, src: "voirie_locale:z" },
    { code: "AD3-T1", etat: "MAUVAIS", region: R1, jma: 2000, longueurKm: 2.2, rang: 14 },
    { code: "AD3-T2", etat: "MAUVAIS", region: R1, jma: 2000, longueurKm: 2.2, rang: 15 },
    { code: "AD3-CHER", etat: "CRITIQUE", region: R1, jma: 1000, longueurKm: 20, rang: 16 },
    { code: "AD3-PEU", etat: "MOYEN", region: R1, jma: 1000, longueurKm: 1, rang: 17 },
    { code: "AD3-FUT", etat: "MAUVAIS", region: R1, jma: 1500, longueurKm: 2.2, rang: 18 },
    { code: "AD3-B2", etat: "MAUVAIS", region: R2, jma: 2000, longueurKm: 2.2, rang: 19, classe: "RR" },
    { code: "AD3-B3", etat: "CRITIQUE", region: R2, jma: 1200, longueurKm: 2.2, rang: 20, classe: "RR" },
    { code: "AD3-TERRE", etat: "MAUVAIS", region: R1, jma: 200, longueurKm: 2.2, rang: 21, rev: "TERRE", classe: "PISTE" },
    { code: "AD3-NONREN", etat: "MAUVAIS", region: R1, jma: 1500, longueurKm: 2.2, rang: 22, rev: "NON_RENSEIGNE" },
    { code: "AD3-INVALIDE", etat: "MAUVAIS", region: R1, jma: 1500, longueurKm: 1, rang: 23, geom: "papillon" },
  ];
  for (const f of FIX) await troncon(f);
  // Points noirs. Registre de la region 1 : 2 + 3 + 3 + 1 = 9 CONFIRMES (>= 5, donc exploite) ; region 2 : 1 seul (< 5, non exploite).
  await pn("AD3-A1", R1, 2);
  await pn("AD3-CHER", R1, 3);
  await pn("AD3-PEU", R1, 1);
  await pn(null, R1, 3); // rattaches a la region seulement
  await pn("AD3-A6", R1, 3, { statut: "A_VALIDER" }); // alertes NON confirmees : ne comptent ni dans le score ni dans le registre
  await pn("AD3-A7", R1, 2, { statut: "REJETE" });
  await pn("AD3-A4", R1, 2, { supprime: true });
  await pn("AD3-B3", R2, 1);
  // Inspections. A1 : degradee depuis 2024-03-01 (serie ininterrompue) ; A2 : redevenue BON ; FUT : un seul constat, DANS LE FUTUR.
  await inspection("AD3-A1", "2024-03-01", "MAUVAIS");
  await inspection("AD3-A1", "2025-04-01", "CRITIQUE");
  await inspection("AD3-A2", "2024-01-01", "MAUVAIS");
  await inspection("AD3-A2", "2024-09-01", "BON");
  await inspection("AD3-FUT", "2030-01-01", "CRITIQUE");
  // T1 et T2 ont les MEMES faits (egalite parfaite) : aucune inspection sur T2, sinon son urgence les departagerait.
  await inspection("AD3-B3", "2023-01-01", "BON");
  await inspection("AD3-B3", "2023-06-01", "MAUVAIS");
  await exec(`INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, source, methode, "observedAt", confiance, "updatedAt")
              VALUES (gen_random_uuid()::text, 'Troncon', 't-AD3-A1', 'etat', 'OBSERVED', 'INSPECTION_TERRAIN', 'RELEVE_TERRAIN', '2025-04-01', 'HIGH', now())`);
  // A9 : longueur metier 10 km contre une geometrie d'environ 2,2 km => divergence au-dela du seuil ; A10 : longueur metier nulle.
  const nTroncons = await compter(`SELECT count(*) n FROM troncons WHERE code LIKE 'AD3-%'`);
  verifier(`fixtures : ${FIX.length} troncons, 17 points noirs, 7 inspections, une valeur de qualite ecrits (${nTroncons} troncons AD3 en base)`, nTroncons === FIX.length);

  // ------------------------------------------------------------------ AD-3 / AD-4 (revue, item 5) : le simulateur et la liste chargent LES MEMES candidats
  // `moteur.depot.chargerCandidats` (simulateur, moteur v2, PPE) avait l'ancien chargement : « 0 point noir des que le registre national n'est pas vide »,
  // alertes A_VALIDER et points REJETES comptes. Il applique maintenant `resoudreSecurite` comme la liste. Le jeu ci-dessus est MIXTE a dessein :
  // region 1 au registre exploite (9 confirmes), region 2 au registre trop petit (1), alertes non confirmees, points rejetes ou supprimes.
  {
    const MIN = (await banc.imp("programmation/priorite.parametres")).BLOC_PRIORITE_AMORCAGE.registrePointsNoirsMinimum;
    const duSimulateur = (await moteurDepot.chargerCandidats(prisma, { limite: 3001, registrePointsNoirsMinimum: MIN })).filter((c: { code: string }) => c.code.startsWith("AD3-"));
    const { faits: tousLesFaits } = await depot.chargerFaits(prisma, { regions: null, dateReference: AUJOURDHUI, limite: 3001 });
    const deLaListe = tousLesFaits.filter((f: { code: string }) => f.code.startsWith("AD3-")).map((f: { pointsNoirs: unknown }) => noyau.candidatDepuisMesures(f, noyau.resoudreSecurite(f.pointsNoirs, MIN).nb));
    type C = { id: string; code: string; nbPointsNoirs: number | null; longueurM: number | null; longueurOrigine: string | null; etat: string | null; traficMoyenJma: number | null; criticiteStrategique: number | null; regionId: number | null; classe: string | null; revetement: string | null };
    const cle = (c: C) => JSON.stringify([c.nbPointsNoirs, c.longueurM, c.longueurOrigine, c.etat, c.traficMoyenJma, c.criticiteStrategique, c.regionId, c.classe, c.revetement]);
    const a = new Map<string, string>(duSimulateur.map((c: C) => [c.id, cle(c)]));
    const b = new Map<string, string>(deLaListe.map((c: C) => [c.id, cle(c)]));
    const ecarts = [...a].filter(([id, k]) => b.get(id) !== k).map(([id, k]) => ({ id, simulateur: k, liste: b.get(id) }));
    verifier("EQUIVALENCE (SQL reel) : le simulateur et la liste chargent les MEMES troncons, avec le meme nombre de points noirs, la meme longueur et la meme origine", a.size === b.size && a.size === FIX.length - 3 && ecarts.length === 0, { nSimulateur: a.size, nListe: b.size, ecarts });
    const nb = (code: string) => (duSimulateur.find((c: C) => c.code === code) as C | undefined)?.nbPointsNoirs;
    verifier("points noirs du simulateur : 2 confirmes (A1) ; zero DONNEE en region 1 au registre exploite (A2, A7 aux points rejetes, A6 aux alertes non confirmees) ; ABSENT (null, jamais 0) en region 2 au registre de 1 point (A5, B2) ; 1 pour B3",
      nb("AD3-A1") === 2 && nb("AD3-A2") === 0 && nb("AD3-A6") === 0 && nb("AD3-A7") === 0 && nb("AD3-A5") === null && nb("AD3-B2") === null && nb("AD3-B3") === 1,
      Object.fromEntries(["AD3-A1", "AD3-A2", "AD3-A5", "AD3-A6", "AD3-A7", "AD3-B2", "AD3-B3"].map((c) => [c, nb(c)])));
    const longueur = (code: string) => (duSimulateur.find((c: C) => c.code === code) as C | undefined);
    verifier("longueur du simulateur = celle de la liste : A9 (10 km metier, geometrie de 2 km) garde la longueur metier ; A10 (longueur metier nulle) lit la geometrie, origine GEOMETRIE",
      longueur("AD3-A9")?.longueurOrigine === "LONGUEUR_KM" && longueur("AD3-A9")?.longueurM === 10000 && longueur("AD3-A10")?.longueurOrigine === "GEOMETRIE" && (longueur("AD3-A10")?.longueurM ?? 0) > 0);
  }

  // ------------------------------------------------------------------ empreintes des tables que le module ne doit JAMAIS ecrire
  const TABLES_INTACTES = ["troncons", "chantiers", "marches", "decomptes", "programmes_budgetaires", "scenarios_programmation", "fiches_intervention", "points_noirs", "inspections", "valeurs_qualite"];
  const empreinteTables = async () => {
    const o: Record<string, string> = {};
    for (const t of TABLES_INTACTES) o[t] = (await sql<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x`))[0].h;
    return o;
  };
  const nAudit = () => compter(`SELECT count(*) n FROM audit_logs`);
  const avant = await empreinteTables();
  const auditAvant = await nAudit();
  const parametresAvant = await compter(`SELECT count(*) n FROM parametres_programmation`);

  // ------------------------------------------------------------------ parametres : creation, approbation, audit, immuabilite
  const liste0 = await get(T.lect, `${B}/priorites/parametres`);
  verifier("parametres : la version semee ne porte pas de bloc de priorite, et la reponse le dit (amorcage du code, provisoire)",
    liste0.status === 200 && liste0.body.data.length === 1 && liste0.body.data[0].priorite.present === false && liste0.body.data[0].priorite.origine === "AMORCAGE_CODE" && liste0.body.data[0].provisoire === true, liste0.body);
  const sansParam = await get(T.gest, `${B}/interventions?limite=100`);
  verifier("sans version approuvee, une seule version existante : le moteur la prend ; le resultat dit « bloc d'amorcage du code » et PROVISOIRE",
    sansParam.status === 200 && sansParam.body.provisoire === true && sansParam.body.parametres.blocOrigine === "AMORCAGE_CODE" && sansParam.body.motifsProvisoire.length >= 2, sansParam.body.motifsProvisoire);

  const BLOC = { poids: { ETAT_GRAVITE: 40, IMPORTANCE_AXE: 25, SECURITE_CRITICITE: 20, URGENCE_TEMPORELLE: 15 }, couvertureMinimale: 0.3, registrePointsNoirsMinimum: 5, urgenceAnciennetePlafondJours: 730 };
  const cree = await post(T.gest, `${B}/priorites/parametres`, { version: "ad3-prio-1", motif: "banc AD-3", priorite: BLOC });
  verifier("POST /priorites/parametres : 201, version provisoire, auteur = la SESSION du gestionnaire", cree.status === 201 && cree.body.provisoire === true && cree.body.creeParId === gest.id, cree.body);
  const idParams: string = cree.body.id;
  const ligneP = (await sql<{ valeurs: any; creeParId: string; approuveeLe: Date | null }>(`SELECT valeurs, "creeParId", "approuveeLe" FROM parametres_programmation WHERE id = $1`, idParams))[0];
  verifier("la ligne en base porte le bloc de priorite ET les valeurs du risque reprises de la version de base (dix cles + priorite)",
    ligneP.valeurs.priorite?.modele === "priorite-technique-1" && ligneP.valeurs.poidsRisque?.ETAT === 40 && Object.keys(ligneP.valeurs).length === 11 && ligneP.approuveeLe === null, Object.keys(ligneP.valeurs));
  const deux = await get(T.gest, `${B}/interventions`);
  verifier("deux versions provisoires et aucune approuvee : le moteur ne choisit pas (422 PARAMETRES_A_PRECISER), il ne prend pas « la derniere creee »", deux.status === 422 && deux.body.code === "PARAMETRES_A_PRECISER", deux.body);
  const choisie = await get(T.gest, `${B}/interventions?parametresId=${idParams}&limite=100`);
  verifier("avec parametresId : calcule, PROVISOIRE (version non approuvee), bloc de la VERSION", choisie.status === 200 && choisie.body.provisoire === true && choisie.body.parametres.blocOrigine === "VERSION" && choisie.body.parametres.version === "ad3-prio-1", choisie.body.parametres);

  const appr = await post(T.admin, `${B}/priorites/parametres/${idParams}/approuver`);
  verifier("POST .../approuver (ADMIN) : 200, plus provisoire, approbateur = la session", appr.status === 200 && appr.body.provisoire === false && appr.body.approuveeParId === admin.id, appr.body);
  const audits = await sql<{ action: string; userId: string }>(`SELECT action::text, "userId" FROM audit_logs WHERE "entityType" = 'ParametresProgrammation' AND "entityId" = $1 ORDER BY "createdAt", action::text`, idParams);
  verifier("audit des ecritures de parametres : CREATE par le gestionnaire, VALIDATE par l'administrateur, dans la transaction", audits.length === 2 && audits.some((a) => a.action === "CREATE" && a.userId === gest.id) && audits.some((a) => a.action === "VALIDATE" && a.userId === admin.id), audits);
  let refuse: string | null = null;
  try { await exec(`UPDATE parametres_programmation SET valeurs = valeurs || '{"x":1}'::jsonb WHERE id = $1`, idParams); } catch (e) { refuse = String((e as Error).message); }
  verifier("la base REFUSE de modifier les valeurs d'une version (declencheur d'immuabilite) : un bloc de priorite ne change pas sous un classement", refuse !== null && /immuable/.test(refuse), refuse);
  const dejaApprouvee = await post(T.admin, `${B}/priorites/parametres/${idParams}/approuver`);
  verifier("approuver deux fois : 409", dejaApprouvee.status === 409, dejaApprouvee.body);
  const sansBloc = await post(T.admin, `${B}/priorites/parametres/${(await sql<{ id: string }>(`SELECT id FROM parametres_programmation WHERE version = 'prog-provisoire-1'`))[0].id}/approuver`);
  verifier("approuver une version SANS bloc de priorite par ces routes : 409 BLOC_PRIORITE_ABSENT", sansBloc.status === 409 && sansBloc.body.code === "BLOC_PRIORITE_ABSENT", sansBloc.body);
  const refusRole = [
    await post(T.gest, `${B}/priorites/parametres/${idParams}/approuver`),
    await post(T.lect, `${B}/priorites/parametres`, { version: "ad3-prio-x", priorite: {} }),
    await post(T.sans, `${B}/priorites/parametres`, { version: "ad3-prio-x", priorite: {} }),
  ];
  verifier("un gestionnaire n'approuve pas (403), un lecteur ne cree pas (403), sans le module `decision` rien (403)", refusRole.every((r) => r.status === 403), refusRole.map((r) => r.status));
  const incoherent = await post(T.gest, `${B}/priorites/parametres`, { version: "ad3-prio-bad", priorite: { couvertureMinimale: 2, registrePointsNoirsMinimum: 0 } });
  verifier("valeurs incoherentes : 422 avec toutes les erreurs, rien en base", incoherent.status === 422 && /couvertureMinimale/.test(incoherent.body.error) && /registrePointsNoirsMinimum/.test(incoherent.body.error)
    && (await compter(`SELECT count(*) n FROM parametres_programmation WHERE version = 'ad3-prio-bad'`)) === 0, incoherent.body);
  verifier("la creation de parametres n'a ajoute qu'UNE ligne ; audit +2 (CREATE, VALIDATE)", (await compter(`SELECT count(*) n FROM parametres_programmation`)) === parametresAvant + 1 && (await nAudit()) === auditAvant + 2);

  // ------------------------------------------------------------------ oracle SQL independant
  const V = (await sql<{ v: any }>(`SELECT valeurs v FROM parametres_programmation WHERE id = $1`, idParams))[0].v;
  const ORACLE_PRIORITE = `
    WITH p AS (SELECT valeurs v FROM parametres_programmation WHERE id = $1),
    c AS (
      SELECT tr.id, tr.code, tr."regionId", tr.etat::text etat, tr."traficMoyenJma" jma, tr."criticiteStrategique" crit,
             (SELECT count(*) FROM points_noirs x WHERE x."tronconId" = tr.id AND x."deletedAt" IS NULL AND (x."statutValidation" IS NULL OR x."statutValidation" = 'VALIDE')) conf,
             (SELECT count(*) FROM points_noirs x WHERE x."regionId" = tr."regionId" AND x."deletedAt" IS NULL AND (x."statutValidation" IS NULL OR x."statutValidation" = 'VALIDE')) reg,
             tr.classe::text classe, tr."dateDerniereEvaluation"::date dateeval
        FROM troncons tr
       WHERE tr.code LIKE 'AD3-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE')
         AND (tr."sourceReference" IS NULL OR NOT (tr."sourceReference" LIKE 'voirie_locale:%' OR tr."sourceReference" LIKE 'hors_territoire:%'))
    ),
    ins AS (
      SELECT i."tronconId" t, i."dateInspection"::date d,
             CASE i."etatObserve"::text WHEN 'BON' THEN 0 WHEN 'MOYEN' THEN 1 WHEN 'MAUVAIS' THEN 2 WHEN 'CRITIQUE' THEN 3 END rk
        FROM inspections i WHERE i."deletedAt" IS NULL AND i."etatObserve"::text <> 'NON_EVALUE' AND i."dateInspection"::date <= $2::date
    ),
    ord AS (
      SELECT t, d, rk, (rk >= 2) deg,
             sum(CASE WHEN rk < 2 THEN 1 ELSE 0 END) OVER (PARTITION BY t ORDER BY d, rk ROWS UNBOUNDED PRECEDING) nd,
             row_number() OVER (PARTITION BY t ORDER BY d DESC, rk DESC) rn
        FROM ins
    ),
    urg AS (
      SELECT l.t, CASE WHEN NOT l.deg THEN 0 ELSE (SELECT ($2::date - min(o.d)) FROM ord o WHERE o.t = l.t AND o.deg AND o.nd = l.nd) END jours,
             (SELECT max(d) FROM ord o WHERE o.t = l.t) dernier
        FROM ord l WHERE l.rn = 1
    ),
    f AS (
      SELECT c.*, u.dernier,
             (p.v->'etatVersRisque'->>c.etat)::numeric ve,
             CASE WHEN c.jma IS NOT NULL THEN round(least(c.jma::numeric / (p.v->>'traficPlafondJma')::numeric, 1) * 100, 4)
                  WHEN c.crit BETWEEN 0 AND 100 THEN c.crit::numeric END vi,
             CASE WHEN c.conf > 0 THEN round(least(c.conf::numeric / (p.v->>'pointsNoirsPlafond')::numeric, 1) * 100, 4)
                  WHEN c.reg >= (p.v->'priorite'->>'registrePointsNoirsMinimum')::int THEN 0 END vs,
             CASE WHEN u.jours IS NULL THEN NULL ELSE round(least(u.jours::numeric / (p.v->'priorite'->>'urgenceAnciennetePlafondJours')::numeric, 1) * 100, 4) END vu,
             (p.v->'priorite'->'poids'->>'ETAT_GRAVITE')::numeric we, (p.v->'priorite'->'poids'->>'IMPORTANCE_AXE')::numeric wi,
             (p.v->'priorite'->'poids'->>'SECURITE_CRITICITE')::numeric ws, (p.v->'priorite'->'poids'->>'URGENCE_TEMPORELLE')::numeric wu,
             (p.v->'priorite'->'poids'->>'ACCESSIBILITE_SERVICE')::numeric wa, (p.v->'priorite'->'poids'->>'MATURITE_FAISABILITE')::numeric wm,
             (p.v->'priorite'->>'couvertureMinimale')::numeric cmin
        FROM c CROSS JOIN p LEFT JOIN urg u ON u.t = c.id
    ),
    g AS (
      SELECT f.*, (we + wi + ws + wu + wa + wm) wt,
             (CASE WHEN ve IS NOT NULL THEN we ELSE 0 END + CASE WHEN vi IS NOT NULL THEN wi ELSE 0 END + CASE WHEN vs IS NOT NULL THEN ws ELSE 0 END + CASE WHEN vu IS NOT NULL THEN wu ELSE 0 END) wd,
             (coalesce(we * ve, 0) + coalesce(wi * vi, 0) + coalesce(ws * vs, 0) + coalesce(wu * vu, 0)) num
        FROM f
    )
    SELECT code, ve::text, vi::text, vs::text, vu::text, round(wd / wt, 4)::text couv,
           CASE WHEN ve IS NULL THEN 'EXCLU' WHEN wd = 0 OR round(wd / wt, 4) < cmin THEN 'EXCLU' WHEN round(wd / wt, 4) < 1 THEN 'INCOMPLET' ELSE 'CALCULE' END statut,
           CASE WHEN ve IS NOT NULL AND wd > 0 AND round(wd / wt, 4) >= cmin THEN round(num / wd, 4)::text END score,
           to_char(dernier, 'YYYY-MM-DD') dernier
      FROM g ORDER BY code`;
  const oracle = await sql<{ code: string; ve: string | null; vi: string | null; vs: string | null; vu: string | null; couv: string; statut: string; score: string | null; dernier: string | null }>(ORACLE_PRIORITE, idParams, AUJOURDHUI);
  const oraParCode = new Map(oracle.map((o) => [o.code, o]));

  // ------------------------------------------------------------------ liste complete (version approuvee choisie par defaut)
  const L = await get(T.admin, `${B}/interventions?limite=100`);
  verifier("liste nationale (ADMIN) : 200, version approuvee choisie, plus provisoire, 20 interventions (supprime, a valider et voirie promue ABSENTS)",
    L.status === 200 && L.body.parametres.version === "ad3-prio-1" && L.body.provisoire === false && L.body.data.length === 20 && L.body.total === 20, { s: L.status, n: L.body.data?.length, p: L.body.parametres });
  const lignes: any[] = L.body.data; // eslint-disable-line @typescript-eslint/no-explicit-any
  const parCode = new Map(lignes.map((l) => [l.objet.code, l]));
  verifier("troncon supprime, troncon a valider et voirie promue n'apparaissent pas ; la geometrie absente (A8) et invalide restent dans la liste",
    !parCode.has("AD3-DEL") && !parCode.has("AD3-AVAL") && !parCode.has("AD3-VOIRIE") && parCode.has("AD3-A8") && parCode.has("AD3-INVALIDE"));
  verifier("l oracle SQL et l API portent les memes 20 troncons", oracle.length === 20 && oracle.every((o) => parCode.has(o.code)), oracle.map((o) => o.code));

  let ecarts: string[] = [];
  for (const o of oracle) {
    const l = parCode.get(o.code);
    const p = l.prioriteTechnique;
    const memeStatut = p.statut === o.statut;
    const memeCouv = proche(p.couverture, Number(o.couv), 0.0002);
    const memeScore = o.score === null ? p.score === null : p.score !== null && proche(p.score, Number(o.score), 0.0006);
    const val = (c: string) => p.contributions.find((x: any) => x.critere === c)?.valeurNormalisee ?? null; // eslint-disable-line @typescript-eslint/no-explicit-any
    const eq = (a: number | null, b: string | null) => (b === null ? a === null : a !== null && proche(a, Number(b), 0.0002));
    const memesValeurs = o.ve === null ? true : eq(val("ETAT_GRAVITE"), o.ve) && eq(val("IMPORTANCE_AXE"), o.vi) && eq(val("SECURITE_CRITICITE"), o.vs) && eq(val("URGENCE_TEMPORELLE"), o.vu);
    if (!(memeStatut && memeCouv && memeScore && memesValeurs)) ecarts.push(`${o.code}: api=${p.statut}/${p.couverture}/${p.score} oracle=${o.statut}/${o.couv}/${o.score} valeurs=${memesValeurs}`);
  }
  verifier(`PRIORITE TECHNIQUE : statut, couverture, score et valeur de chaque critere de ${oracle.length} troncons egaux a l'oracle SQL (tolerance 0,0006)`, ecarts.length === 0, ecarts);

  const attenduOrdre = oracle.filter((o) => o.score !== null).sort((a, b) => Number(b.score) - Number(a.score) || (a.code < b.code ? -1 : 1)).map((o) => o.code);
  const ordreApi = lignes.filter((l) => l.prioriteTechnique.rang !== null).sort((a, b) => a.prioriteTechnique.rang - b.prioriteTechnique.rang).map((l) => l.objet.code);
  verifier("ORDRE de la priorite technique egal a l'oracle (score decroissant, egalites par code) : T1 avant T2 a score egal", JSON.stringify(ordreApi) === JSON.stringify(attenduOrdre) && ordreApi.indexOf("AD3-T1") === ordreApi.indexOf("AD3-T2") - 1, { api: ordreApi, oracle: attenduOrdre });
  verifier("les rangs sont 1..n sans trou, les lignes exclues n'en ont pas et sont listees APRES les classees",
    ordreApi.length === lignes.filter((l) => l.prioriteTechnique.score !== null).length && lignes.slice(ordreApi.length).every((l) => l.prioriteTechnique.rang === null)
    && lignes.slice(0, ordreApi.length).map((l) => l.prioriteTechnique.rang).join() === ordreApi.map((_, i) => i + 1).join());

  // regles nommees
  const g = (c: string) => parCode.get(c).prioriteTechnique;
  verifier("A3 (etat NON_EVALUE) : EXCLU ETAT_NON_EVALUE, sans score ni rang, jamais classe ni bonne ni faible", g("AD3-A3").exclusion?.code === "ETAT_NON_EVALUE" && g("AD3-A3").score === null && g("AD3-A3").rang === null);
  const secu = (c: string) => g(c).contributions.find((x: any) => x.critere === "SECURITE_CRITICITE"); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("« 0 point noir » : A4 (region 1, registre de 9 confirmes) a une securite = 0 DONNEE ; A5 (region 2, registre de 1) a une securite ABSENTE, listee parmi les criteres manquants",
    secu("AD3-A4").valeurNormalisee === 0 && secu("AD3-A4").points === 0 && secu("AD3-A5").valeurNormalisee === null && secu("AD3-A5").points === null
    && g("AD3-A5").criteresManquants.some((m: any) => m.critere === "SECURITE_CRITICITE" && /pas zero/.test(m.raison)) && g("AD3-A5").scoreIncomplet === true, { a4: secu("AD3-A4"), a5: secu("AD3-A5") });
  verifier("alertes A_VALIDER (A6) et points REJETE (A7) ne comptent pas : securite = 0 (donnee), l'alerte est dite ; point supprime (A4) non compte",
    secu("AD3-A6").valeurNormalisee === 0 && /3 alerte\(s\) non confirmee\(s\)/.test(secu("AD3-A6").note) && secu("AD3-A7").valeurNormalisee === 0 && secu("AD3-A4").valeurNormalisee === 0);
  verifier("A1 : 2 points noirs confirmes = 66,6667 ; B3 (region 2, 1 confirme rattache) : securite PRESENTE malgre un registre pauvre = 33,3333",
    proche(secu("AD3-A1").valeurNormalisee, 66.6667, 0.0002) && proche(secu("AD3-B3").valeurNormalisee, 33.3333, 0.0002));
  const imp = (c: string) => g(c).contributions.find((x: any) => x.critere === "IMPORTANCE_AXE"); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("A2 (sans trafic) : importance lue dans la criticite strategique (60) et sa provenance le dit ; A1 : provenance = trafic",
    imp("AD3-A2").valeurNormalisee === 60 && /criticiteStrategique/.test(imp("AD3-A2").provenance) && /traficMoyenJma/.test(imp("AD3-A1").provenance), imp("AD3-A2"));
  const urg = (c: string) => g(c).contributions.find((x: any) => x.critere === "URGENCE_TEMPORELLE"); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("urgence : A1 degradee depuis 2024-03-01 (serie ininterrompue), A2 redevenue BON = 0 (un constat), FUT (constat futur seulement) ABSENTE, A5 (sans inspection) ABSENTE",
    urg("AD3-A1").valeurNormalisee > 0 && urg("AD3-A2").valeurNormalisee === 0 && urg("AD3-FUT").valeurNormalisee === null && urg("AD3-A5").valeurNormalisee === null);
  verifier("dernier constat : A1 = inspection du 2025-04-01 (source inspections), A4 = date d'evaluation du troncon, FUT = aucun (le futur n'est pas un constat)",
    parCode.get("AD3-A1").dernierConstat.date === "2025-04-01" && parCode.get("AD3-A1").dernierConstat.source === "inspections.dateInspection"
    && parCode.get("AD3-A4").dernierConstat.date === "2026-02-01" && parCode.get("AD3-A4").dernierConstat.source === "troncons.dateDerniereEvaluation" && parCode.get("AD3-FUT").dernierConstat.date === null);
  verifier("confiance de la donnee d'etat (valeurs_qualite) rendue pour A1 : OBSERVED / HIGH ; absente (null) ailleurs, pas inventee",
    parCode.get("AD3-A1").confiance.niveau === "HIGH" && parCode.get("AD3-A1").confiance.statutEtat === "OBSERVED" && parCode.get("AD3-A2").confiance.niveau === null);

  // localisation et longueurs
  verifier("localisation : A8 (geometrie nulle) et INVALIDE (ligne degeneree) = invalide avec motif ; les autres = valide, motif nul",
    parCode.get("AD3-A8").localisation === "invalide" && parCode.get("AD3-A8").localisationMotif === "GEOMETRIE_ABSENTE" && parCode.get("AD3-INVALIDE").localisation === "invalide"
    && lignes.filter((l) => l.localisation === "valide").length === 18 && lignes.filter((l) => l.localisation === "valide").every((l) => l.localisationMotif === null), parCode.get("AD3-INVALIDE").localisationMotif);
  const geomM = Number((await sql<{ m: number }>(`SELECT ST_Length(geom::geography) m FROM troncons WHERE code = 'AD3-A9'`))[0].m);
  const lg9 = parCode.get("AD3-A9").longueur, lg10 = parCode.get("AD3-A10").longueur;
  verifier("longueur : A9 garde ses 10 km metier ET ses " + geomM.toFixed(0) + " m geometriques (egaux a ST_Length), divergence SIGNALEE et non corrigee ; A1 non signalee",
    lg9.metierKm === 10 && proche(lg9.geometriqueM, geomM, 0.1) && lg9.divergence.signalee === true && lg9.utiliseeM === 10000 && lg9.longueurOrigine === "LONGUEUR_KM" && parCode.get("AD3-A1").longueur.divergence.signalee === false, lg9);
  verifier("longueur : A10 (longueur metier nulle) utilise la GEOMETRIE et le dit (longueurOrigine) ; metierKm nul, pas 0",
    lg10.metierKm === null && lg10.longueurOrigine === "GEOMETRIE" && lg10.utiliseeM === Math.round(Number((await sql<{ m: number }>(`SELECT ST_Length(geom::geography) m FROM troncons WHERE code = 'AD3-A10'`))[0].m)), lg10);

  // ------------------------------------------------------------------ cout : oracle SQL
  const ORACLE_COUT = `
    SELECT tr.code, (b."coutKmGnf" * (CASE WHEN tr."longueurKm" > 0 THEN round(tr."longueurKm" * 1000) ELSE round(ST_Length(tr.geom::geography)) END)::bigint / 1000)::text cout, c."traitementCode" traitement
      FROM troncons tr
      JOIN conditions_traitement c ON c."familleRevetement" = CASE tr.revetement::text WHEN 'BITUME' THEN 'bitume' WHEN 'TERRE' THEN 'terre_laterite' WHEN 'LATERITE' THEN 'terre_laterite' WHEN 'PAVE' THEN 'pave' END
                                  AND c."etatDepart" = tr.etat::text AND c."classeTrafic" IS NULL AND c.actif
      JOIN baremes_intervention b ON b."familleRevetement" = c."familleRevetement" AND b."etatDepart" = c."etatDepart" AND b."typeIntervention" = c."traitementCode" AND b.actif
     WHERE tr.code LIKE 'AD3-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE') AND tr.geom IS NOT NULL
       AND (tr."sourceReference" IS NULL OR NOT (tr."sourceReference" LIKE 'voirie_locale:%' OR tr."sourceReference" LIKE 'hors_territoire:%'))`;
  const oraCout = new Map((await sql<{ code: string; cout: string; traitement: string }>(ORACLE_COUT)).map((x) => [x.code, x]));
  const erCout: string[] = [];
  for (const l of lignes) {
    const o = oraCout.get(l.objet.code);
    if (l.objet.code === "AD3-A8") continue; // geometrie absente mais longueur metier 3 km : chiffre sur la colonne (verifie plus bas)
    if (o) { if (!l.coutEstime || l.coutEstime.montantGnf !== o.cout || l.coutEstime.traitement.code !== o.traitement) erCout.push(`${l.objet.code}: api=${l.coutEstime?.montantGnf} oracle=${o.cout}`); }
    else if (l.coutEstime !== null || l.coutNonEstimable === null) erCout.push(`${l.objet.code}: cout attendu non estimable, api=${JSON.stringify(l.coutEstime)}`);
  }
  verifier(`COUT : montant et traitement de ${oraCout.size} troncons egaux a l'oracle SQL (NUMERIC, bareme et conditions lus dans les tables) ; les autres sont « coutNonEstimable » motives`, erCout.length === 0, erCout);
  const a8 = parCode.get("AD3-A8");
  verifier("A8 (sans geometrie, longueur metier 3 km) : chiffre sur la colonne metier (350 M... le bareme MAUVAIS bitume x 3 km), localisation invalide", a8.coutEstime?.montantGnf === String(BigInt(1_100_000_000) * 3n), a8.coutEstime);
  verifier("cout non estimable motive : BON (AUCUNE_CONDITION), NON_EVALUE (ETAT_NON_EVALUE), revetement non renseigne (FAMILLE_COUT_ABSENTE)",
    parCode.get("AD3-A5").coutNonEstimable?.code === "AUCUNE_CONDITION" && parCode.get("AD3-A3").coutNonEstimable?.code === "ETAT_NON_EVALUE" && parCode.get("AD3-NONREN").coutNonEstimable?.code === "FAMILLE_COUT_ABSENTE");
  const cA1 = parCode.get("AD3-A1").coutEstime;
  verifier("le cout porte unite (KM), devise, classe de precision, validite du bareme, caractere provisoire et hypotheses manquantes",
    cA1.unite === "KM" && cA1.devise === "GNF" && cA1.classePrecision === "RESEAU_30" && cA1.provisoire === true && cA1.hypothesesManquantes.length >= 1 && "validDe" in cA1.bareme && "validA" in cA1.bareme && cA1.bareme.version === 1, cA1);

  // ------------------------------------------------------------------ ordre d'arbitrage : oracle SQL (ratio risque attendu / cout)
  const ORACLE_ARBITRAGE = `
    WITH p AS (SELECT valeurs v FROM parametres_programmation WHERE id = $1),
    c AS (
      SELECT tr.id, tr.code, tr."regionId", tr.etat::text etat, tr."traficMoyenJma" jma, tr."criticiteStrategique" crit,
             (SELECT count(*) FROM points_noirs x WHERE x."tronconId" = tr.id AND x."deletedAt" IS NULL AND (x."statutValidation" IS NULL OR x."statutValidation" = 'VALIDE')) conf,
             (SELECT count(*) FROM points_noirs x WHERE x."regionId" = tr."regionId" AND x."deletedAt" IS NULL AND (x."statutValidation" IS NULL OR x."statutValidation" = 'VALIDE')) reg,
             CASE tr.revetement::text WHEN 'BITUME' THEN 'bitume' WHEN 'TERRE' THEN 'terre_laterite' WHEN 'LATERITE' THEN 'terre_laterite' WHEN 'PAVE' THEN 'pave' END fam,
             (CASE WHEN tr."longueurKm" > 0 THEN round(tr."longueurKm" * 1000) ELSE round(ST_Length(tr.geom::geography)) END)::bigint len_m
        FROM troncons tr
       WHERE tr.code LIKE 'AD3-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE')
         AND (tr."sourceReference" IS NULL OR NOT (tr."sourceReference" LIKE 'voirie_locale:%' OR tr."sourceReference" LIKE 'hors_territoire:%'))
         AND tr.etat::text IN ('BON', 'MOYEN', 'MAUVAIS', 'CRITIQUE')
    ),
    f AS (
      SELECT c.*, p.v,
             (p.v->'poidsRisque'->>'ETAT')::numeric we, (p.v->'poidsRisque'->>'TRAFIC_IMPORTANCE')::numeric wt, (p.v->'poidsRisque'->>'SECURITE')::numeric ws,
             ((p.v->'poidsRisque'->>'ETAT')::numeric + (p.v->'poidsRisque'->>'TRAFIC_IMPORTANCE')::numeric + (p.v->'poidsRisque'->>'SECURITE')::numeric
              + (p.v->'poidsRisque'->>'CLIMAT')::numeric + (p.v->'poidsRisque'->>'POPULATION')::numeric) wtot,
             (p.v->'etatVersRisque'->>c.etat)::numeric fe,
             CASE WHEN c.jma IS NOT NULL THEN round(least(c.jma::numeric / (p.v->>'traficPlafondJma')::numeric, 1) * 100, 4) WHEN c.crit BETWEEN 0 AND 100 THEN c.crit::numeric END ft,
             CASE WHEN c.conf > 0 THEN round(least(c.conf::numeric / (p.v->>'pointsNoirsPlafond')::numeric, 1) * 100, 4)
                  WHEN c.reg >= (p.v->'priorite'->>'registrePointsNoirsMinimum')::int THEN 0 END fs,
             CASE c.etat WHEN 'BON' THEN 'MOYEN' WHEN 'MOYEN' THEN 'MAUVAIS' WHEN 'MAUVAIS' THEN 'CRITIQUE' END suivant,
             CASE WHEN c.jma IS NULL THEN NULL WHEN c.jma < (p.v->'seuilsClasseTrafic'->>'t1MaxJma')::numeric THEN 'T1_faible'
                  WHEN c.jma < (p.v->'seuilsClasseTrafic'->>'t2MaxJma')::numeric THEN 'T2_moyen' ELSE 'T3_fort' END classe
        FROM c CROSS JOIN p
    ),
    r AS (
      SELECT f.*, (1 + (ft IS NOT NULL)::int + (fs IS NOT NULL)::int) navail,
             (we + CASE WHEN ft IS NOT NULL THEN wt ELSE 0 END + CASE WHEN fs IS NOT NULL THEN ws ELSE 0 END) wavail
        FROM f
    ),
    k AS (
      SELECT r.*, round((we * fe + coalesce(wt * ft, 0) + coalesce(ws * fs, 0)) / wavail, 4) risque,
             round((we * (v->'etatVersRisque'->>suivant)::numeric + coalesce(wt * ft, 0) + coalesce(ws * fs, 0)) / wavail, 4) risque_suivant
        FROM r WHERE navail >= (v->>'facteursMinimum')::int AND round(wavail / wtot, 4) >= (v->>'couvertureMinimale')::numeric
    ),
    m AS (
      SELECT k.*, CASE k.etat WHEN 'BON' THEN d."pBonVersMoyen" WHEN 'MOYEN' THEN d."pMoyenVersMauvais" WHEN 'MAUVAIS' THEN d."pMauvaisVersCritique" ELSE 0 END ph
        FROM k LEFT JOIN matrices_degradation d ON d."familleRevetement" = k.fam AND d."classeTrafic" = k.classe
    ),
    z AS (
      SELECT m.code, m.risque, round(CASE WHEN m.suivant IS NULL OR m.classe IS NULL THEN m.risque ELSE m.risque + m.ph::numeric * (m.risque_suivant - m.risque) END, 4) attendu,
             (b."coutKmGnf" * m.len_m / 1000) cout
        FROM m
        JOIN conditions_traitement cd ON cd."familleRevetement" = m.fam AND cd."etatDepart" = m.etat AND cd."classeTrafic" IS NULL AND cd.actif
        JOIN baremes_intervention b ON b."familleRevetement" = m.fam AND b."etatDepart" = m.etat AND b."typeIntervention" = cd."traitementCode" AND b.actif
       WHERE m.fam IS NOT NULL AND m.len_m > 0
    )
    SELECT code, risque::text, attendu::text, cout::text, (attendu * 10000 * 1000000000 / cout)::text ratio FROM z ORDER BY (attendu * 10000 / cout::numeric) DESC, risque DESC, cout ASC, code ASC`;
  const oraArb = await sql<{ code: string; risque: string; attendu: string; cout: string; ratio: string }>(ORACLE_ARBITRAGE, idParams);
  const rangsApi = lignes.filter((l) => l.ordreArbitrage.rang !== null).sort((a, b) => a.ordreArbitrage.rang - b.ordreArbitrage.rang);
  verifier(`ORDRE D'ARBITRAGE : les ${oraArb.length} troncons que le simulateur peut classer le sont dans l'ordre exact de l'oracle SQL (risque attendu / cout), 1..n sans trou`,
    JSON.stringify(rangsApi.map((l) => l.objet.code)) === JSON.stringify(oraArb.map((o) => o.code)) && rangsApi.every((l, i) => l.ordreArbitrage.rang === i + 1), { api: rangsApi.map((l) => l.objet.code), oracle: oraArb.map((o) => o.code) });
  verifier("ratio et risque attendu de l'arbitrage egaux a l'oracle (points de risque par milliard de GNF, 4 decimales)",
    oraArb.every((o) => { const l = parCode.get(o.code); return proche(l.ordreArbitrage.risqueAttendu, Number(o.attendu), 0.0002) && proche(Number(l.ordreArbitrage.ratioPointsParMilliardGnf), Number(o.ratio) / 10000, 0.002); }),
    oraArb.map((o) => [o.code, o.ratio, parCode.get(o.code).ordreArbitrage.ratioPointsParMilliardGnf]));
  const motifsArb = lignes.filter((l) => l.ordreArbitrage.rang === null).map((l) => l.ordreArbitrage.motifAbsence?.code);
  verifier("un troncon que le simulateur ne classe pas dit POURQUOI (code du simulateur), il n'est pas « dernier » : rang nul", motifsArb.length === 20 - oraArb.length && motifsArb.every((m) => typeof m === "string"), motifsArb);
  const cher = parCode.get("AD3-CHER"), peu = parCode.get("AD3-PEU");
  verifier("DEUX CLASSEMENTS : CHER (critique, 20 km, ~70 Md GNF) est avant PEU (moyen, 1 km) en priorite technique, et APRES PEU dans l'ordre d'arbitrage",
    cher.prioriteTechnique.rang < peu.prioriteTechnique.rang && cher.ordreArbitrage.rang > peu.ordreArbitrage.rang && cher.ordreArbitrage.rang !== null, { cher: [cher.prioriteTechnique.rang, cher.ordreArbitrage.rang], peu: [peu.prioriteTechnique.rang, peu.ordreArbitrage.rang] });
  verifier("une priorite technique ne depend pas du cout : CHER garde un score superieur a PEU malgre un cout 20 fois plus grand", cher.prioriteTechnique.score > peu.prioriteTechnique.score);

  // ------------------------------------------------------------------ reproductibilite par HTTP
  const L2 = await get(T.admin, `${B}/interventions?limite=100`);
  verifier("reproductibilite : deux appels successifs rendent la meme empreinte SHA-256 et les memes lignes", L2.body.empreinte === L.body.empreinte && /^[0-9a-f]{64}$/.test(L.body.empreinte) && JSON.stringify(L2.body.data) === JSON.stringify(L.body.data));
  const etroit = await get(T.admin, `${B}/interventions?limite=5`);
  verifier("l'empreinte porte sur le classement ENTIER, pas sur la page", etroit.body.empreinte === L.body.empreinte && etroit.body.data.length === 5);

  // ------------------------------------------------------------------ pagination
  const vus: string[] = [];
  let curseur: string | null = null, pages = 0;
  do {
    const r: Rep = await get(T.admin, `${B}/interventions?limite=4${curseur ? `&curseur=${curseur}` : ""}`);
    if (r.status !== 200) { verifier("pagination : page lisible", false, r.body); break; }
    vus.push(...r.body.data.map((l: any) => l.objet.code)); // eslint-disable-line @typescript-eslint/no-explicit-any
    curseur = r.body.page.prochainCurseur; pages += 1;
  } while (curseur && pages < 20);
  verifier(`pagination par curseur (limite 4) : ${pages} pages, 20 lignes, aucun doublon, aucun saut, meme ordre que la liste entiere`, pages === 5 && vus.length === 20 && new Set(vus).size === 20 && JSON.stringify(vus) === JSON.stringify(lignes.map((l) => l.objet.code)), vus);

  // ------------------------------------------------------------------ filtres
  const codesDe = (r: Rep) => (r.body.data as any[]).map((l) => l.objet.code).sort(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const attendus = async (cond: string, ...params: unknown[]) => (await sql<{ code: string }>(`SELECT code FROM troncons tr WHERE tr.code LIKE 'AD3-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE') AND (tr."sourceReference" IS NULL OR tr."sourceReference" NOT LIKE 'voirie_locale:%') AND ${cond} ORDER BY code`, ...params)).map((x) => x.code);
  const fR = await get(T.admin, `${B}/interventions?regionId=${R2}&limite=100`);
  verifier("filtre regionId : egal a l'oracle (3 troncons de la region 2), et le total est celui de la selection", JSON.stringify(codesDe(fR)) === JSON.stringify(await attendus(`tr."regionId" = ${R2}`)) && fR.body.total === 3, codesDe(fR));
  const fC = await get(T.admin, `${B}/interventions?classe=RR,PISTE&limite=100`);
  verifier("filtre classe (RR, PISTE) : egal a l'oracle", JSON.stringify(codesDe(fC)) === JSON.stringify(await attendus(`tr.classe::text IN ('RR','PISTE')`)), codesDe(fC));
  const fE = await get(T.admin, `${B}/interventions?etat=CRITIQUE&etat=NON_EVALUE&limite=100`);
  verifier("filtre etat (CRITIQUE, NON_EVALUE) : egal a l'oracle ; un etat non evalue reste visible quand on le demande", JSON.stringify(codesDe(fE)) === JSON.stringify(await attendus(`tr.etat::text IN ('CRITIQUE','NON_EVALUE')`)) && codesDe(fE).includes("AD3-A3"), codesDe(fE));
  const fD = await get(T.admin, `${B}/interventions?depuis=2025-01-01&jusqua=2025-12-31&limite=100`);
  const attDates = oracle.filter((o) => o.dernier !== null || o.code === "AD3-A4").map((o) => o.code); // reconstruit ci-dessous par SQL
  const sqlDates = (await sql<{ code: string }>(`
    SELECT tr.code FROM troncons tr
     WHERE tr.code LIKE 'AD3-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE') AND (tr."sourceReference" IS NULL OR tr."sourceReference" NOT LIKE 'voirie_locale:%')
       AND greatest(CASE WHEN tr."dateDerniereEvaluation"::date <= $1::date THEN tr."dateDerniereEvaluation"::date END,
                    (SELECT max(i."dateInspection")::date FROM inspections i WHERE i."tronconId" = tr.id AND i."deletedAt" IS NULL AND i."dateInspection"::date <= $1::date)) BETWEEN '2025-01-01' AND '2025-12-31'
     ORDER BY tr.code`, AUJOURDHUI)).map((x) => x.code);
  void attDates;
  verifier("filtre depuis / jusqua sur la date du dernier constat : egal a l'oracle (A1 seul : inspection du 2025-04-01) ; un troncon SANS constat date est ecarte, pas suppose recent",
    JSON.stringify(codesDe(fD)) === JSON.stringify(sqlDates) && sqlDates.length === 1 && sqlDates[0] === "AD3-A1", { api: codesDe(fD), oracle: sqlDates });
  const fS = await get(T.admin, `${B}/interventions?statutScore=EXCLU&limite=100`);
  verifier("filtre d'affichage statutScore=EXCLU : une seule ligne (A3), total de la selection inchange, rangs des autres inchanges", fS.body.data.length === 1 && fS.body.totalAffiche === 1 && fS.body.total === 20);
  const fCh = await get(T.admin, `${B}/interventions?statutChantier=EN_COURS&limite=100`);
  verifier("statutChantier accepte mais declare NON APPLIQUE (jamais ignore en silence) ; la liste n'est pas filtree", fCh.status === 200 && fCh.body.data.length === 20 && fCh.body.filtres.nonAppliques[0]?.filtre === "statutChantier");

  // ------------------------------------------------------------------ fiche
  const det = await get(T.lect, `${B}/interventions/t-AD3-A1`);
  verifier("fiche A1 : 200, meme ligne que la liste (priorite, arbitrage, cout), motif, limites, actions honnetes, historique dit son absence",
    det.status === 200 && JSON.stringify(det.body.intervention.prioriteTechnique) === JSON.stringify(parCode.get("AD3-A1").prioriteTechnique) && JSON.stringify(det.body.intervention.ordreArbitrage) === JSON.stringify(parCode.get("AD3-A1").ordreArbitrage)
    && /Priorite technique \d+\/\d+/.test(det.body.motif) && det.body.limites.length >= 5 && det.body.actions.disponibles.length === 0 && det.body.actions.nonDisponibles.length === 5 && det.body.historique.recalculs.disponible === false, det.body.motif);
  const detA3 = await get(T.lect, `${B}/interventions/t-AD3-A3`);
  verifier("fiche d'une intervention exclue : motif d'exclusion, aucun rang", detA3.status === 200 && /^Non classee \(ETAT_NON_EVALUE\)/.test(detA3.body.motif) && detA3.body.intervention.prioriteTechnique.rang === null);

  // ------------------------------------------------------------------ GeoJSON
  const BBOX = [LON0 - 0.1, LAT0 - 0.1, LON0 + 0.3, LAT0 + 0.5].map((n) => Number(n.toFixed(4)));
  const bboxQ = BBOX.join(",");
  const geo = await get(T.admin, `${B}/interventions.geojson?bbox=${bboxQ}`);
  const sqlGeo = (await sql<{ code: string }>(`
    SELECT tr.code FROM troncons tr
     WHERE tr.code LIKE 'AD3-%' AND tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE') AND (tr."sourceReference" IS NULL OR tr."sourceReference" NOT LIKE 'voirie_locale:%')
       AND tr.geom IS NOT NULL AND NOT ST_IsEmpty(tr.geom) AND ST_IsValid(tr.geom) AND ST_NPoints(tr.geom) >= 2 AND ST_Length(tr.geom::geography) >= 0.01
       AND ST_Intersects(tr.geom, ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))
     ORDER BY tr.code`, ...BBOX)).map((x) => x.code);
  const codesGeo = (geo.body.features as any[]).map((f) => f.properties.code).sort(); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier(`GeoJSON : les ${sqlGeo.length} troncons a geometrie exploitable dans l'emprise (oracle PostGIS) sont servis, ni plus ni moins ; A8 (sans geometrie) et INVALIDE n'y sont PAS`,
    geo.status === 200 && JSON.stringify(codesGeo) === JSON.stringify(sqlGeo) && !codesGeo.includes("AD3-A8") && !codesGeo.includes("AD3-INVALIDE") && geo.body.total === sqlGeo.length && geo.body.tronque === false, { api: codesGeo, oracle: sqlGeo });
  verifier("GeoJSON : horsGeometrie = 2 (compte de la selection), selection = 20, geometries LineString d'au moins 2 sommets, proprietes minimales, rang egal a celui de la liste",
    geo.body.horsGeometrie === 2 && geo.body.selection === 20 && geo.body.features.every((f: any) => f.geometry.type === "LineString" && f.geometry.coordinates.length >= 2 && f.properties.rang === parCode.get(f.properties.code).prioriteTechnique.rang), geo.body.horsGeometrie); // eslint-disable-line @typescript-eslint/no-explicit-any
  const geo3 = await get(T.admin, `${B}/interventions.geojson?bbox=${bboxQ}&limite=3`);
  const rangsGeo3 = (geo3.body.features as any[]).map((f) => f.properties.rang); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("plafond (3) : tronque = true, total = " + sqlGeo.length + ", les 3 mieux classes (rangs 1, 2, 3) sont gardes dans l'ordre de la priorite technique", geo3.body.tronque === true && geo3.body.total === sqlGeo.length && JSON.stringify(rangsGeo3) === JSON.stringify([1, 2, 3]) && geo3.body.limite === 3, rangsGeo3);
  const petit = [LON0 - 0.001, LAT0 + 0.0095, LON0 + 0.021, LAT0 + 0.0105].map((n) => Number(n.toFixed(4))); // coupe uniquement le troncon de rang 1 (latitude 9,61)
  const geoP = await get(T.admin, `${B}/interventions.geojson?bbox=${petit.join(",")}`);
  const sqlP = (await sql<{ code: string }>(`SELECT tr.code FROM troncons tr WHERE tr.code LIKE 'AD3-%' AND tr."deletedAt" IS NULL AND tr.geom IS NOT NULL AND ST_IsValid(tr.geom) AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE') AND (tr."sourceReference" IS NULL OR tr."sourceReference" NOT LIKE 'voirie_locale:%') AND ST_Intersects(tr.geom, ST_MakeEnvelope($1::float8,$2::float8,$3::float8,$4::float8,4326)) ORDER BY 1`, ...petit)).map((x) => x.code);
  verifier("emprise etroite : seul le troncon qui la traverse est servi (oracle ST_Intersects), avec son rang de la LISTE nationale", JSON.stringify((geoP.body.features as any[]).map((f) => f.properties.code)) === JSON.stringify(sqlP) && sqlP.length === 1 && geoP.body.selection === 20, sqlP); // eslint-disable-line @typescript-eslint/no-explicit-any

  // ------------------------------------------------------------------ territoire
  const r1 = await get(T.r1, `${B}/interventions?limite=100`);
  const sqlR1 = await attendus(`tr."regionId" = ${R1}`);
  verifier("compte regional (region 1) : exactement les troncons de SA region (oracle SQL), total = celui de son perimetre (pas 20), aucun nom de la region 2",
    r1.status === 200 && JSON.stringify(codesDe(r1)) === JSON.stringify(sqlR1) && r1.body.total === sqlR1.length && sqlR1.length === 17 && !JSON.stringify(r1.body).includes("Region AD3 2"), { n: sqlR1.length, total: r1.body.total });
  verifier("compte regional : perimetre annonce (non national), resume du perimetre seulement", r1.body.perimetre.national === false && r1.body.resume.candidats === 17);
  const r1HorsZone = await get(T.r1, `${B}/interventions?regionId=${R2}`);
  verifier("regionId d'une autre region : 403 HORS_PERIMETRE", r1HorsZone.status === 403 && r1HorsZone.body.code === "HORS_PERIMETRE", r1HorsZone.body);
  const r1Geo = await get(T.r1, `${B}/interventions.geojson?bbox=${bboxQ}`);
  verifier("GeoJSON d'un compte regional : seulement sa region, selection = 17 (pas 20)", r1Geo.status === 200 && r1Geo.body.selection === 17 && (r1Geo.body.features as any[]).every((f) => f.properties.regionId === R1)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const voisine = await get(T.r1, `${B}/interventions/t-AD3-B2`);
  const inconnu = await get(T.r1, `${B}/interventions/n-existe-pas`);
  const supprime = await get(T.r1, `${B}/interventions/t-AD3-DEL`);
  const malForme = await get(T.r1, `${B}/interventions/a%20b`);
  const natInconnu = await get(T.gest, `${B}/interventions/n-existe-pas`);
  const natSupprime = await get(T.gest, `${B}/interventions/t-AD3-DEL`);
  const natAValider = await get(T.gest, `${B}/interventions/t-AD3-AVAL`);
  verifier("ORACLE D'EXISTENCE FERME : autre region, inconnu, supprime et mal forme repondent le MEME 404 (meme corps) ; pour un compte national, inconnu, supprime et a valider aussi",
    [voisine, inconnu, supprime, malForme, natInconnu, natSupprime, natAValider].every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify(inconnu.body)), [voisine.status, inconnu.status, supprime.status, malForme.status, natInconnu.status, natSupprime.status, natAValider.status]);
  verifier("contre-epreuve : le compte regional voit sa propre fiche (200), le compte national voit celle de la region 2 (200)", (await get(T.r1, `${B}/interventions/t-AD3-A1`)).status === 200 && (await get(T.gest, `${B}/interventions/t-AD3-B2`)).status === 200);
  const r2 = await get(T.r2, `${B}/interventions?limite=100`);
  verifier("compte regional de la region 2 : 3 troncons, tous classes, rangs 1 a 3 recalcules dans SON perimetre", r2.body.total === 3 && r2.body.data.map((l: any) => l.prioriteTechnique.rang).join() === "1,2,3", r2.body.resume); // eslint-disable-line @typescript-eslint/no-explicit-any
  const acces = [await get(null, `${B}/interventions`), await get(T.sans, `${B}/interventions`), await get(T.sans, `${B}/interventions/t-AD3-A1`), await get(T.sans, `${B}/interventions.geojson?bbox=${bboxQ}`), await get(T.sans, `${B}/priorites/parametres`)];
  verifier("anonyme : 401 ; sans le module `decision` : 403 sur chaque route de lecture", acces[0].status === 401 && acces.slice(1).every((r) => r.status === 403), acces.map((r) => r.status));

  // ------------------------------------------------------------------ entrees hostiles
  const hostiles = [
    `${B}/interventions?limite=0`, `${B}/interventions?limite=1000`, `${B}/interventions?classe=AUTOROUTE`, `${B}/interventions?regionId=abc`, `${B}/interventions?depuis=2026-02-30`,
    `${B}/interventions?curseur=!!!`, `${B}/interventions?curseur=${Buffer.from('{"v":"x","g":9,"s":1,"c":"a","i":"b"}').toString("base64url")}`, `${B}/interventions?zzz=1`,
    `${B}/interventions?parametresId=x'%20OR%20'1'='1`, `${B}/interventions?etat[]=BON&etat[]=INCONNU`, `${B}/interventions.geojson`, `${B}/interventions.geojson?bbox=-20,0,0,5`,
    `${B}/interventions.geojson?bbox=${bboxQ}&limite=99999`, `${B}/interventions.geojson?bbox=NaN,0,1,1`,
  ];
  const repHostiles: number[] = [];
  for (const u of hostiles) repHostiles.push((await get(T.gest, u)).status);
  verifier(`entrees hostiles : ${hostiles.length} requetes, TOUTES en 400 (jamais 500)`, repHostiles.every((s) => s === 400), repHostiles);
  const sqlInjection = await get(T.gest, `${B}/interventions/t-AD3-A1'%3B%20DROP%20TABLE%20troncons%3B--`);
  verifier("identifiant detail avec injection SQL : 404 de meme corps, table intacte", sqlInjection.status === 404 && JSON.stringify(sqlInjection.body) === JSON.stringify(inconnu.body) && (await compter(`SELECT count(*) n FROM troncons WHERE code LIKE 'AD3-%'`)) === FIX.length);
  const corpsHostiles = [{}, { version: "ab", priorite: {} }, { version: "ad3-x-1", priorite: {}, creeParId: admin.id }, { version: "ad3-x-1", priorite: { poids: { INVENTE: 1 } } }, { version: "ad3-x-1", priorite: { poids: { ETAT_GRAVITE: "40" } } }];
  const repCorps: number[] = [];
  for (const c of corpsHostiles) repCorps.push((await post(T.gest, `${B}/priorites/parametres`, c)).status);
  verifier("corps hostiles de POST /priorites/parametres (vide, version courte, auteur dans le corps, poids inconnu, poids texte) : 400, rien ecrit", repCorps.every((s) => s === 400) && (await compter(`SELECT count(*) n FROM parametres_programmation`)) === parametresAvant + 1, repCorps);

  // ------------------------------------------------------------------ aucune ecriture
  const apres = await empreinteTables();
  const diff = TABLES_INTACTES.filter((t) => apres[t] !== avant[t]);
  verifier("AUCUNE ECRITURE : troncons, chantiers, marches, decomptes, budgets, scenarios, fiches, points noirs, inspections et valeurs de qualite ont la meme empreinte md5 avant et apres toutes les requetes", diff.length === 0, diff);
  verifier("audit_logs : +2 lignes seulement (CREATE et VALIDATE des parametres) ; aucune lecture n'est auditee, aucune ecriture refusee n'a laisse de trace", (await nAudit()) === auditAvant + 2);

  // ------------------------------------------------------------------ mesure : 3 000 candidats dans une transaction ANNULEE
  class Annulation extends Error {}
  const mesures: { facts: number[]; noyau: number[]; total: number[]; nbCandidats: number; octets: number } = { facts: [], noyau: [], total: [], nbCandidats: 0, octets: 0 };
  let refusPlafond: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    await prisma.$transaction(async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const n0 = Number((await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM troncons tr WHERE tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE') AND (tr."sourceReference" IS NULL OR NOT (tr."sourceReference" LIKE 'voirie_locale:%' OR tr."sourceReference" LIKE 'hors_territoire:%'))`))[0].n);
      const reste = 3000 - n0;
      await tx.$executeRawUnsafe(`
        INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "traficMoyenJma", "criticiteStrategique", geom, "updatedAt")
        SELECT 'perf-' || g, 'PERF-' || lpad(g::text, 5, '0'), 'Troncon perf ' || g,
               (ARRAY['RN','RR','RU','PISTE'])[1 + g % 4]::"ClasseRoute", $1 + (g % 2) * ($2 - $1), 1 + (g % 20),
               (ARRAY['BITUME','TERRE','PAVE','LATERITE','NON_RENSEIGNE'])[1 + g % 5]::"Revetement",
               (ARRAY['BON','MOYEN','MAUVAIS','CRITIQUE','NON_EVALUE'])[1 + (g * 7) % 5]::"EtatPatrimoine", 0, 1 + (g % 20),
               CASE g % 3 WHEN 0 THEN NULL ELSE (g * 37) % 6000 END, CASE WHEN g % 7 = 0 THEN (g % 101) ELSE NULL END,
               ST_GeomFromText('LINESTRING(' || (-13.9 + (g % 60) * 0.01) || ' ' || (9.0 + (g / 60) * 0.01) || ', ' || (-13.88 + (g % 60) * 0.01) || ' ' || (9.0 + (g / 60) * 0.01) || ')', 4326), now()
          FROM generate_series(1, $3) g`, R1, R2, reste);
      await tx.$executeRawUnsafe(`
        INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "createdAt")
        SELECT gen_random_uuid()::text, 'perf-' || g, $1, (date '2024-01-01' + (g % 700)::int)::timestamp, (ARRAY['BON','MAUVAIS','CRITIQUE'])[1 + g % 3]::"EtatPatrimoine", now()
          FROM generate_series(1, $2) g WHERE g % 3 = 0`, inspecteur.id, reste);
      await tx.$executeRawUnsafe(`
        INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "updatedAt")
        SELECT gen_random_uuid()::text, 'pn perf', $1, 'perf-' || g, 'FORTE'::"Gravite", now() FROM generate_series(1, $2) g WHERE g % 11 = 0`, R1, reste);
      mesures.nbCandidats = Number((await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM troncons tr WHERE tr."deletedAt" IS NULL AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE') AND (tr."sourceReference" IS NULL OR NOT (tr."sourceReference" LIKE 'voirie_locale:%' OR tr."sourceReference" LIKE 'hors_territoire:%'))`))[0].n);
      const faux = { $transaction: async (fn: any) => fn(tx), $queryRaw: tx.$queryRaw.bind(tx), $executeRaw: tx.$executeRaw.bind(tx) }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const ctx = { regions: null, maintenant: new Date() };
      // 1 execution a blanc (compilation), puis 5 mesures par etape
      await service.listerInterventions(faux, ctx, { limite: 25, parametresId: idParams });
      const ligneParams = (await moteurDepot.lireParametresParId(tx, idParams));
      const parametres = moteurDepot.parametresDeLigne(ligneParams);
      const annee = ctx.maintenant.getUTCFullYear();
      const [baremes, catalogue, conditions, matrices] = [await moteurDepot.chargerBaremes(tx, annee), await moteurDepot.chargerCatalogue(tx), await moteurDepot.chargerConditions(tx), await moteurDepot.chargerMatrices(tx)];
      const validitesBaremes = await depot.chargerValiditesBaremes(tx);
      for (let i = 0; i < 5; i++) {
        let t = performance.now();
        const { faits } = await depot.chargerFaits(tx, { regions: null, dateReference: AUJOURDHUI, limite: 3001 });
        mesures.facts.push(performance.now() - t);
        t = performance.now();
        const r = noyau.classerInterventions({ dateReference: AUJOURDHUI, parametres, candidats: faits, baremes, catalogue, conditions, matrices, validitesBaremes });
        mesures.noyau.push(performance.now() - t);
        if (!r.ok) throw new Error(`classement refuse : ${r.erreurs.join(";")}`);
        t = performance.now();
        const rep = await service.listerInterventions(faux, ctx, { limite: 25, parametresId: idParams });
        mesures.total.push(performance.now() - t);
        mesures.octets = JSON.stringify(rep).length;
        if (i === 0) {
          const res = r.resultat;
          verifier(`3 000 candidats (${mesures.nbCandidats} en base, generes dans la transaction annulee) : classement obtenu, ${res.resume.classes} classes dont ${res.resume.incomplets} incomplets, ${res.resume.exclus} exclus, empreinte reproductible`,
            mesures.nbCandidats === 3000 && res.resume.candidats === 3000 && res.resume.classes + res.resume.exclus === 3000 && rep.empreinte === res.empreinte, res.resume);
        }
      }
      // 3 001 candidats : refus net, pas de classement partiel
      await tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "updatedAt") VALUES ('perf-trop', 'PERF-TROP', 'trop', 'RN', $1, 1, 'BITUME', 'MAUVAIS', 0, 1, now())`, R1);
      try { await service.listerInterventions(faux, ctx, { limite: 25, parametresId: idParams }); } catch (e) { refusPlafond = e; }
      throw new Annulation();
    }, { timeout: 300_000, maxWait: 20_000 });
  } catch (e) { if (!(e instanceof Annulation)) throw e; }
  verifier("3 001 candidats : refus 422 PERIMETRE_TROP_LARGE (le plafond du moteur), pas de classement partiel", refusPlafond?.code === "PERIMETRE_TROP_LARGE" && refusPlafond?.http === 422, refusPlafond?.message);
  verifier("la transaction de mesure a ete ANNULEE : aucun troncon PERF en base, comptes des tables identiques", (await compter(`SELECT count(*) n FROM troncons WHERE code LIKE 'PERF-%'`)) === 0 && (await compter(`SELECT count(*) n FROM troncons`)) === FIX.length);
  const stat = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return `min ${s[0].toFixed(0)} / mediane ${s[Math.floor(s.length / 2)].toFixed(0)} / max ${s[s.length - 1].toFixed(0)} ms`; };
  console.log(`\nMESURE (3 000 candidats, 5 passes, poste de developpement charge) :\n  lecture SQL des faits          : ${stat(mesures.facts)}\n  calcul du noyau (classement)   : ${stat(mesures.noyau)}\n  service complet (page de 25)   : ${stat(mesures.total)}  (reponse de ${(mesures.octets / 1024).toFixed(0)} Ko)\n`);
  const mediane = [...mesures.total].sort((a, b) => a - b)[2];
  verifier(`duree du service complet a 3 000 candidats mesuree et consignee (mediane ${mediane.toFixed(0)} ms) ; garde-fou large : moins de 30 s`, mesures.total.length === 5 && mediane < 30_000);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
  await banc.fermer();
}
conclure();
