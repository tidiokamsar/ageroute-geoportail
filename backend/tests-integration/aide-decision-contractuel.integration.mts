// Banc d'integration du SUIVI CONTRACTUEL de l'aide a la decision (AD-LOT-5). Voir tests-integration/README.md et
// docs/aide-decision/CONTRACTUEL.md. Lancer (DATABASE_URL pointe sur `replay`, jamais ecrite : le banc travaille dans le
// clone `essai_ad_l5_contractuel`, cree puis detruit par lui) :
//   npx tsx tests-integration/aide-decision-contractuel.integration.mts
//
// CE QUE LE BANC PROUVE, contre PostGIS reel, avec les VRAIS requireAuth, requireModuleAccess, perimetreDe, depot, service et
// noyau (seul le montage Express est local : le routeur n'est pas encore monte dans api-v2/index.ts) :
//   - seize marches fabriques, avec des liens MANQUANTS (marche sans chantier, chantier sans troncon, chantier archive), AMBIGUS
//     (deux troncons differents, chantier partage), un marche en USD, sans montant, sans bailleur, a montants > 2^53, avec
//     decomptes payes / emis / rejetes, un marche supprime, un marche multi-regional, un marche dont le seul chantier est
//     rattache a « Non renseigne » ;
//   - nombre de marches recenses, contractuel total, decaisse total, totaux par bailleur, comptes de CHAQUE controle de
//     coherence : egaux a des requetes SQL ecrites a part (oracles), ET a un modele ecrit a la main ;
//   - un compte regional : l'ensemble de marches visibles egal a l'oracle SQL, les montants du marche multi-regional masques,
//     aucun intitule ni montant d'une autre region dans le corps, aucun total national, 404 identique pour inexistant, supprime,
//     hors perimetre et identifiant mal forme ; contre-epreuve (le perimetre en base decide : retire, le meme jeton voit tout) ;
//   - matrice d'acces reelle (anonyme, sans module marches, sans module decision, LECTEUR, GESTIONNAIRE national, ADMIN) ;
//   - pagination par curseur sans doublon ni saut, ordre egal a ORDER BY SQL ; entrees hostiles en 400 ;
//   - AUCUNE ECRITURE : des declencheurs de base qui refusent toute ecriture sur neuf tables sont poses AVANT les lectures
//     (contre-epreuve : une ecriture directe est bien refusee), et les empreintes md5 des tables sont identiques avant/apres ;
//   - cout : 400 marches de plus, liste de 100 mesuree (poste de developpement, pas un serveur de production).
//
// CE QUE LE BANC NE PROUVE PAS : la production (volumes, donnees reelles, DigitalRoad non integre), l'interface (voir les tests
// frontend et la verification Chromium), les bailleurs ecrits en sigle contre developpe (signales a tort, dit dans la definition).
import { randomUUID } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_ad_l5_contractuel");
process.env.RATE_LIMIT_V2_MAX = "0";
const { prisma } = await banc.imp("lib/prisma");
const { signAccessToken } = await banc.imp("utils/jwt");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { aideDecisionContractuelRouter } = await banc.imp("api-v2/aide-decision.contractuel.routes");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use("/api/v2/aide-decision", aideDecisionContractuelRouter);
app.use(errorHandler);

const sql = async <T = Record<string, unknown>>(texte: string, ...params: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...params);
const un = async (texte: string, ...params: unknown[]): Promise<string> => String(Object.values((await sql(texte, ...params))[0] ?? { v: null })[0]);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
type Rep = { status: number; body: any; headers: Record<string, string>; text: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = "/api/v2/aide-decision/contractuel";
const get = (token: string | null, url: string): Promise<Rep> => {
  const r = request(app).get(url);
  return (token ? r.set("Authorization", `Bearer ${token}`) : r) as unknown as Promise<Rep>;
};
const ids = (r: Rep): string[] => r.body.marches.map((m: { id: string }) => m.id);
const trie = (a: string[]) => [...a].sort();
const memes = (a: string[], b: string[]) => JSON.stringify(trie(a)) === JSON.stringify(trie(b));

const TABLES_LECTURE = ["marches", "decomptes", "avancement_marche", "marches_chantiers", "chantiers", "troncons", "programmes_budgetaires", "bailleurs", "audit_logs"];
const empreintes = async (): Promise<Record<string, string>> => {
  const o: Record<string, string> = {};
  for (const t of TABLES_LECTURE) o[t] = await un(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM ${t} x`) + ":" + await un(`SELECT count(*) FROM ${t}`);
  return o;
};

async function main() {
  // ---------------------------------------------------------------------------------------------- comptes et regions
  await sql(`INSERT INTO regions (nom) VALUES ('Region contractuel 1'), ('Region contractuel 2') ON CONFLICT (nom) DO NOTHING`);
  await sql(`INSERT INTO regions (nom) SELECT 'Non renseigné' WHERE NOT EXISTS (SELECT 1 FROM regions WHERE nom = 'Non renseigné')`);
  const regionId = async (n: string) => Number(await un(`SELECT id FROM regions WHERE nom = $1`, n));
  const [R1, R2, RNR] = [await regionId("Region contractuel 1"), await regionId("Region contractuel 2"), await regionId("Non renseigné")];

  const mkUser = (email: string, role: string, modulesAutorises: string[]) =>
    prisma.user.create({ data: { email: `${email}@ad-l5.invalid`, nomComplet: email, passwordHash: "x", role, modulesAutorises } });
  const TOUS = ["marches", "decision"];
  const admin = await mkUser("admin", "ADMIN", []);
  const nat = await mkUser("gest-national", "GESTIONNAIRE", TOUS);
  const lecteur = await mkUser("lecteur", "LECTEUR", TOUS);
  const gR1 = await mkUser("gest-r1", "GESTIONNAIRE", TOUS);
  const gR2 = await mkUser("gest-r2", "GESTIONNAIRE", TOUS);
  const sansMarches = await mkUser("sans-marches", "GESTIONNAIRE", ["decision"]);
  const sansDecision = await mkUser("sans-decision", "GESTIONNAIRE", ["marches"]);
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $3, $5), ($2, $4, $5)`, gR1.id, gR2.id, R1, R2, admin.id);
  const T = { admin: jeton(admin), nat: jeton(nat), lect: jeton(lecteur), r1: jeton(gR1), r2: jeton(gR2), sansMarches: jeton(sansMarches), sansDecision: jeton(sansDecision) };

  // ---------------------------------------------------------------------------------------------- fabrication
  const bad = await prisma.bailleur.create({ data: { nom: "BAD essai ad-l5", type: "multilateral" } });
  const bm = await prisma.bailleur.create({ data: { nom: "Banque mondiale essai ad-l5", type: "multilateral" } });
  let nT = 0;
  const troncon = (region: number) => { nT += 1; return prisma.troncon.create({ data: { code: `ADL5-T${nT}`, nom: `Troncon ad-l5 ${nT}`, classe: "RN", regionId: region, longueurKm: 10, revetement: "BITUME", etat: "MOYEN", pkDebut: 0, pkFin: 10 } }); };
  let nC = 0;
  const chantier = (region: number, extra: Record<string, unknown> = {}) => { nC += 1; return prisma.chantier.create({ data: { intitule: `Chantier ad-l5 ${nC}`, entreprise: `Entreprise ${nC}`, regionId: region, ...extra } }); };
  const marche = (intitule: string, minutes: number, extra: Record<string, unknown> = {}) =>
    prisma.marche.create({ data: { intitule, bailleurId: bad.id, montantTotal: BigInt(1000), createdAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 0) - minutes * 60_000), ...extra } });
  const lier = (marcheId: string, chantierId: string, tronconId: string | null = null) => prisma.marcheChantier.create({ data: { marcheId, chantierId, tronconId } });
  const decompte = (marcheId: string, numero: number, statut: string, montant: bigint, extra: Record<string, unknown> = {}) =>
    prisma.decompte.create({ data: { marcheId, numero, statut, montantGnf: montant, ...extra } });
  const avancement = (marcheId: string, prevu: number, reel: number, finPrevu: number, finReel: number) =>
    prisma.avancementMarche.create({ data: { marcheId, periode: new Date("2026-09-01T00:00:00Z"), avancementPhysiquePrevu: prevu, avancementPhysiqueReel: reel, avancementFinancierPrevu: finPrevu, avancementFinancierReel: finReel } });
  const FUTUR = new Date("2099-01-01T00:00:00Z");

  const GRAND = BigInt("9007199254740993"); // 2^53 + 1
  const PAYE_GRAND = BigInt("4000000000000001");
  const tR1A = await troncon(R1);
  const tShared = await troncon(R1);
  const chR1A = await chantier(R1, { tronconId: tR1A.id, numContrat: "C-001", bailleur: "BAD essai ad-l5" });
  const chShared = await chantier(R1, { tronconId: tShared.id });
  const mR1OK = await marche("BANC R1 OK", 1, { montantTotal: GRAND, dateFinPrevue: FUTUR });
  await lier(mR1OK.id, chR1A.id); await lier(mR1OK.id, chShared.id);
  await decompte(mR1OK.id, 1, "PAYE", PAYE_GRAND, { datePaiement: new Date("2026-06-01") });
  await decompte(mR1OK.id, 2, "EMIS", BigInt("5000000000000000"));
  await decompte(mR1OK.id, 3, "REJETE", BigInt(1));
  await avancement(mR1OK.id, 60, 55, 50, 30);
  const progRetenu = await prisma.programmeBudgetaire.create({ data: { annee: 2026, intitule: "Programme retenu ad-l5", tronconId: tR1A.id, montantPrevuGnf: BigInt(700), statut: "RETENU", createdById: admin.id } });
  await prisma.programmeBudgetaire.create({ data: { annee: 2026, intitule: "Programme propose ad-l5", tronconId: tR1A.id, montantPrevuGnf: BigInt(999), statut: "PROPOSE", createdById: admin.id } });
  await prisma.programmeBudgetaire.create({ data: { annee: 2026, intitule: "Programme ambigu ad-l5", tronconId: tShared.id, montantPrevuGnf: BigInt(555), statut: "RETENU", createdById: admin.id } });

  const mPartage = await marche("BANC PARTAGE", 2, { montantTotal: BigInt(3000) });
  await lier(mPartage.id, chShared.id);

  const tR2 = await troncon(R2);
  const chR2 = await chantier(R2);
  const mR2 = await marche("BANC R2 OK", 3, { montantTotal: BigInt(2222222) });
  await lier(mR2.id, chR2.id, tR2.id); // lien DIRECT : le troncon est porte par le lien, pas par le chantier

  const tM1 = await troncon(R1); const tM2 = await troncon(R2);
  const chM1 = await chantier(R1, { tronconId: tM1.id, intitule: "Chantier multi chez R1" });
  const chM2 = await chantier(R2, { tronconId: tM2.id, intitule: "Chantier multi chez R2" });
  const mMulti = await marche("BANC MULTI REGIONAL", 4, { montantTotal: BigInt(5555555) });
  await lier(mMulti.id, chM1.id); await lier(mMulti.id, chM2.id);
  await decompte(mMulti.id, 1, "PAYE", BigInt(777777));

  const mSansChantier = await marche("BANC SANS CHANTIER", 5, { montantTotal: BigInt(6666666) });

  const chNT = await chantier(R1, { intitule: "Chantier sans troncon" });
  const mCHSansTroncon = await marche("BANC CHANTIER SANS TRONCON", 6, { montantTotal: BigInt(1111) });
  await lier(mCHSansTroncon.id, chNT.id);

  const tAmbL = await troncon(R1); const tAmbC = await troncon(R1);
  const chAmb = await chantier(R1, { tronconId: tAmbC.id });
  const mAmbigu = await marche("BANC AMBIGU", 7, { montantTotal: BigInt(2000) });
  await lier(mAmbigu.id, chAmb.id, tAmbL.id);

  const chNR = await chantier(RNR, { intitule: "Chantier non renseigne" });
  const mNR = await marche("BANC NON RENSEIGNE", 8, { montantTotal: BigInt(4444444) });
  await lier(mNR.id, chNR.id);

  const tUsd = await troncon(R1);
  const chUsd = await chantier(R1, { tronconId: tUsd.id });
  const mUsd = await marche("BANC USD", 9, { montantTotal: BigInt(3333333), devise: "USD" });
  await lier(mUsd.id, chUsd.id);

  const tDS = await troncon(R1); const chDS = await chantier(R1, { tronconId: tDS.id });
  const mDecSup = await marche("BANC DECOMPTE SUPERIEUR", 10, { montantTotal: BigInt(1000) });
  await lier(mDecSup.id, chDS.id);
  await decompte(mDecSup.id, 1, "EMIS", BigInt(1500));
  await decompte(mDecSup.id, 2, "REJETE", BigInt(99_999_999)); // rejete : ne compte pas

  const tDt = await troncon(R1); const chDt = await chantier(R1, { tronconId: tDt.id });
  const mDates = await marche("BANC DATES", 11, { montantTotal: BigInt(4000), dateDebutPrevue: new Date("2026-05-01"), dateFinPrevue: new Date("2026-01-01") });
  await lier(mDates.id, chDt.id);

  const tAv = await troncon(R2); const chAv = await chantier(R2, { tronconId: tAv.id });
  const mAv = await marche("BANC AVANCEMENT", 12, { montantTotal: BigInt(5000) });
  await lier(mAv.id, chAv.id);
  await avancement(mAv.id, 50, 120, 10, 10);

  const tBl = await troncon(R1); const chBl = await chantier(R1, { tronconId: tBl.id, bailleur: "Banque mondiale essai ad-l5" });
  const mBailleur = await marche("BANC BAILLEUR", 13, { montantTotal: BigInt(6000) });
  await lier(mBailleur.id, chBl.id);

  const tSup = await troncon(R1); const chSup = await chantier(R1, { tronconId: tSup.id });
  const mSupprime = await marche("BANC SUPPRIME", 14, { montantTotal: BigInt(7777777), deletedAt: new Date("2026-06-02") });
  await lier(mSupprime.id, chSup.id);

  const tArch = await troncon(R1);
  const chArch = await chantier(R1, { tronconId: tArch.id, deletedAt: new Date("2026-06-02") });
  const mArchive = await marche("BANC CHANTIER ARCHIVE", 15, { montantTotal: BigInt(7000) });
  await lier(mArchive.id, chArch.id);

  const tRt = await troncon(R1); const chRt = await chantier(R1, { tronconId: tRt.id });
  const mRetard = await marche("BANC RETARD", 16, { montantTotal: BigInt(8000), dateFinPrevue: new Date("2020-01-01") });
  await lier(mRetard.id, chRt.id);

  const tSm = await troncon(R2); const chSm = await chantier(R2, { tronconId: tSm.id });
  const mSansMontant = await marche("BANC SANS MONTANT", 17, { montantTotal: null, bailleurId: null });
  await lier(mSansMontant.id, chSm.id);

  // chantiers qu'aucun marche ne rattache : trois vivants, un archive (ignore)
  await chantier(R1, { intitule: "Orphelin R1 a" }); await chantier(R1, { intitule: "Orphelin R1 b" }); await chantier(R2, { intitule: "Orphelin R2" });
  await chantier(R1, { intitule: "Orphelin archive", deletedAt: new Date("2026-06-02") });

  const NOMS: Record<string, string> = Object.fromEntries(Object.entries({ mR1OK, mPartage, mR2, mMulti, mSansChantier, mCHSansTroncon, mAmbigu, mNR, mUsd, mDecSup, mDates, mAv, mBailleur, mSupprime, mArchive, mRetard, mSansMontant }).map(([k, v]) => [k, v.id]));
  const idDe = (k: string) => NOMS[k];
  const VIVANTS = Object.keys(NOMS).filter((k) => k !== "mSupprime");
  console.log(`Fixtures : ${VIVANTS.length} marches vivants, 1 supprime, ${nC} chantiers, ${nT} troncons`);

  // ---------------------------------------------------------------------------------------------- A. matrice d'acces
  console.log("\nA. Matrice d'acces");
  verifier("anonyme : 401", (await get(null, BASE)).status === 401);
  verifier("anonyme : fiche 401", (await get(null, `${BASE}/marches/${idDe("mR1OK")}`)).status === 401);
  verifier("sans le module marches : 403 (liste et fiche)", (await get(T.sansMarches, BASE)).status === 403 && (await get(T.sansMarches, `${BASE}/marches/${idDe("mR1OK")}`)).status === 403);
  verifier("sans le module decision : 403 (liste et fiche)", (await get(T.sansDecision, BASE)).status === 403 && (await get(T.sansDecision, `${BASE}/marches/${idDe("mR1OK")}`)).status === 403);
  const rLect = await get(T.lect, BASE);
  verifier("LECTEUR avec les deux modules : 200, droit financier rendu (module marches = droit financier tant que D-C1-1 est ouverte)", rLect.status === 200 && rLect.body.droitFinancier === true);
  const rAdmin = await get(T.admin, `${BASE}?limite=100`);
  const rNat = await get(T.nat, `${BASE}?limite=100`);
  verifier("ADMIN et GESTIONNAIRE national : 200, perimetre national, no-store", rAdmin.status === 200 && rNat.status === 200 && rAdmin.body.perimetre.national === true && rAdmin.headers["cache-control"] === "no-store");
  verifier("ADMIN voit TOUS les marches vivants (le supprime est absent)", memes(ids(rAdmin), VIVANTS.map(idDe)) && !ids(rAdmin).includes(idDe("mSupprime")), { vus: ids(rAdmin).length });
  verifier("national et ADMIN voient le meme ensemble", memes(ids(rAdmin), ids(rNat)));

  // ---------------------------------------------------------------------------------------------- B. nombres contre oracles SQL
  console.log("\nB. Agregats contre des requetes SQL ecrites a part");
  const sy = rAdmin.body.synthese;
  verifier("marches recenses = SELECT count(*) sur marches non supprimes", String(sy.marchesRecenses.nombre) === await un(`SELECT count(*) FROM marches WHERE "deletedAt" IS NULL`), { api: sy.marchesRecenses.nombre });
  verifier("marches recenses = 16 (modele a la main), pas le nombre de chantiers", sy.marchesRecenses.nombre === 16 && sy.marchesRecenses.nombre !== Number(await un(`SELECT count(*) FROM chantiers WHERE "deletedAt" IS NULL`)));
  verifier("libelle « Marchés recensés » (jamais actifs)", sy.marchesRecenses.libelle === "Marchés recensés" && !/actifs?\b/i.test(sy.marchesRecenses.libelle));
  const attenduContractuel = await un(`SELECT sum("montantTotal") FROM marches WHERE "deletedAt" IS NULL AND devise = 'GNF' AND "montantTotal" IS NOT NULL`);
  verifier("contractuel total GNF = SELECT sum() (chaine exacte au-dela de 2^53)", sy.financier.contractuel.valeurGnf === attenduContractuel, { api: sy.financier.contractuel.valeurGnf, sql: attenduContractuel });
  const modeleContractuel = [GRAND, 3000, 2222222, 5555555, 6666666, 1111, 2000, 4444444, 1000, 4000, 5000, 6000, 7000, 8000].reduce((s: bigint, x) => s + BigInt(x), BigInt(0));
  verifier("contractuel total = modele ecrit a la main", sy.financier.contractuel.valeurGnf === modeleContractuel.toString(), { modele: modeleContractuel.toString() });
  verifier("contractuel PARTIEL : USD et sans montant exclus et dits, couverture 14 sur 16", sy.financier.contractuel.etat === "PARTIEL" && sy.financier.contractuel.couverture.pris === 14 && sy.financier.contractuel.couverture.total === 16);
  const attenduDecaisse = await un(`SELECT sum("montantGnf") FROM decomptes d JOIN marches m ON m.id = d."marcheId" WHERE d.statut = 'PAYE' AND d."deletedAt" IS NULL AND m."deletedAt" IS NULL`);
  verifier("decaisse total = SELECT sum() des seuls decomptes PAYE", sy.financier.decaisse.valeurGnf === attenduDecaisse && attenduDecaisse === (PAYE_GRAND + BigInt(777777)).toString(), { api: sy.financier.decaisse.valeurGnf, sql: attenduDecaisse });
  verifier("engage NON_DISPONIBLE partout (synthese et chaque marche), valeur nulle, jamais egal au contractuel", sy.financier.engage.etat === "NON_DISPONIBLE" && sy.financier.engage.valeurGnf === null && rAdmin.body.marches.every((m: any) => m.montants.engage.etat === "NON_DISPONIBLE" && m.montants.engage.valeurGnf === null)); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("constate NON_DISPONIBLE pour chaque marche, meme quand un declare existe", rAdmin.body.marches.every((m: any) => m.avancement.constate.etat === "NON_DISPONIBLE" && m.avancement.constate.valeurPct === null)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const fiche = (k: string) => rAdmin.body.marches.find((m: any) => m.id === idDe(k)); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("marche R1 OK : declare 55 %, constate non disponible, financier declare 30 % (trois choses distinctes)", fiche("mR1OK").avancement.declare.physiqueReelPct === 55 && fiche("mR1OK").avancement.constate.valeurPct === null && fiche("mR1OK").avancement.financier.reelPct === 30);
  verifier("marche R1 OK : contractuel 2^53+1 exact en chaine, decaisse = seul le PAYE (EMIS et REJETE exclus)", fiche("mR1OK").montants.contractuel.valeurGnf === GRAND.toString() && fiche("mR1OK").montants.decaisse.valeurGnf === PAYE_GRAND.toString() && fiche("mR1OK").decomptes.parStatut.PAYE === 1 && fiche("mR1OK").decomptes.parStatut.EMIS === 1 && fiche("mR1OK").decomptes.parStatut.REJETE === 1);
  verifier("previsionnel : programme RETENU lie par troncon unique compte ; PROPOSE ignore ; programme sur troncon partage = ambigu, non impute", fiche("mR1OK").montants.previsionnel.valeurGnf === "700" && fiche("mR1OK").programmes.retenusLies.length === 1 && fiche("mR1OK").programmes.retenusLies[0].id === progRetenu.id && fiche("mR1OK").programmes.ambigus === 1 && fiche("mPartage").montants.previsionnel.valeurGnf === null && fiche("mPartage").montants.previsionnel.motif === "LIEN_AMBIGU");
  verifier("marche en USD : valeur GNF nulle, montant d'origine conserve, jamais converti", fiche("mUsd").montants.contractuel.valeurGnf === null && fiche("mUsd").montants.contractuel.motif === "DEVISE_NON_GNF" && fiche("mUsd").montants.contractuel.valeurOrigine.montant === "3333333" && fiche("mUsd").montants.contractuel.valeurOrigine.devise === "USD");
  verifier("marche sans montant : MONTANT_ABSENT, pas 0 ; marche sans decompte : decaisse AUCUN_DECOMPTE, pas 0", fiche("mSansMontant").montants.contractuel.motif === "MONTANT_ABSENT" && fiche("mSansMontant").montants.contractuel.valeurGnf === null && fiche("mSansChantier").montants.decaisse.motif === "AUCUN_DECOMPTE" && fiche("mSansChantier").montants.decaisse.valeurGnf === null);
  verifier("retard : date de fin 2020 = EN_RETARD ; date de fin 2099 = A_JOUR ; sans date ni avancement = NON_EVALUABLE ; avertissement avenants dans chaque marche", fiche("mRetard").retard.etat === "EN_RETARD" && fiche("mRetard").retard.joursRetardCalendaire > 1000 && fiche("mR1OK").retard.etat === "A_JOUR" && fiche("mPartage").retard.etat === "NON_EVALUABLE" && rAdmin.body.marches.every((m: any) => /Avenants et suspensions ignorés/.test(m.retard.avertissements.join(" ")))); // eslint-disable-line @typescript-eslint/no-explicit-any
  const parBailleur = await sql<{ id: number | null; s: string | null; n: bigint }>(`SELECT "bailleurId" AS id, sum("montantTotal") FILTER (WHERE devise = 'GNF')::text AS s, count(*) AS n FROM marches WHERE "deletedAt" IS NULL GROUP BY "bailleurId"`);
  verifier("totaux par bailleur = GROUP BY SQL (contractuel GNF et nombre de marches)", parBailleur.every((p) => {
    const t = sy.totauxParBailleur.find((b: any) => b.bailleurId === p.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    return t && t.nombreMarches === Number(p.n) && t.contractuel.valeurGnf === p.s;
  }) && sy.totauxParBailleur.length === parBailleur.length, { api: sy.totauxParBailleur.map((b: any) => [b.bailleurId, b.contractuel.valeurGnf, b.nombreMarches]), sql: parBailleur.map((p) => [p.id, p.s, Number(p.n)]) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("bailleur sans nom regroupe les marches sans bailleur (1 marche, sans montant GNF compte)", sy.totauxParBailleur.some((b: any) => b.bailleurId === null && b.nombreMarches === 1 && b.sansMontant === 1)); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("le marche en USD apparait en « autres devises » du bailleur, pas dans le total GNF", sy.totauxParBailleur.find((b: any) => b.bailleurId === bad.id).autresDevises.some((d: any) => d.devise === "USD" && d.montant === "3333333")); // eslint-disable-line @typescript-eslint/no-explicit-any

  // ---------------------------------------------------------------------------------------------- C. controles contre oracles SQL
  console.log("\nC. Controles de coherence : API = oracle SQL = modele a la main");
  const ctrl = (code: string) => rAdmin.body.controles.find((c: any) => c.code === code); // eslint-disable-line @typescript-eslint/no-explicit-any
  const JOINT = `FROM marches m JOIN marches_chantiers mc ON mc."marcheId" = m.id JOIN chantiers c ON c.id = mc."chantierId" AND c."deletedAt" IS NULL
    LEFT JOIN troncons tl ON tl.id = mc."tronconId" AND tl."deletedAt" IS NULL LEFT JOIN troncons tc ON tc.id = c."tronconId" AND tc."deletedAt" IS NULL`;
  const oracles: Record<string, { sql: string; modele: number }> = {
    MARCHE_SANS_CHANTIER: { modele: 2, sql: `SELECT count(*) FROM marches m WHERE m."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM marches_chantiers mc JOIN chantiers c ON c.id = mc."chantierId" AND c."deletedAt" IS NULL WHERE mc."marcheId" = m.id)` },
    CHANTIER_SANS_TRONCON: { modele: 2, sql: `SELECT count(DISTINCT c.id) ${JOINT} WHERE m."deletedAt" IS NULL AND tl.id IS NULL AND tc.id IS NULL` },
    ASSOCIATION_AMBIGUE: { modele: 3, sql: `SELECT count(DISTINCT m.id) ${JOINT} WHERE m."deletedAt" IS NULL AND ((mc."tronconId" IS NOT NULL AND c."tronconId" IS NOT NULL AND mc."tronconId" <> c."tronconId")
      OR (SELECT count(*) FROM marches_chantiers mc2 JOIN marches m2 ON m2.id = mc2."marcheId" AND m2."deletedAt" IS NULL WHERE mc2."chantierId" = c.id) > 1)` },
    BAILLEUR_INCOHERENT: { modele: 1, sql: `SELECT count(DISTINCT m.id) ${JOINT} JOIN bailleurs b ON b.id = m."bailleurId" WHERE m."deletedAt" IS NULL AND btrim(coalesce(c.bailleur, '')) <> '' AND lower(btrim(c.bailleur)) <> lower(btrim(b.nom))` },
    DECOMPTE_SUPERIEUR_MARCHE: { modele: 1, sql: `SELECT count(*) FROM marches m WHERE m."deletedAt" IS NULL AND m.devise = 'GNF' AND m."montantTotal" IS NOT NULL AND (
      EXISTS (SELECT 1 FROM decomptes d WHERE d."marcheId" = m.id AND d."deletedAt" IS NULL AND d.statut <> 'REJETE' AND d."montantGnf" > m."montantTotal")
      OR (SELECT coalesce(sum(d."montantGnf"), 0) FROM decomptes d WHERE d."marcheId" = m.id AND d."deletedAt" IS NULL AND d.statut <> 'REJETE') > m."montantTotal")` },
    DATES_INCOHERENTES: { modele: 1, sql: `SELECT count(*) FROM marches m WHERE m."deletedAt" IS NULL AND m."dateDebutPrevue" > m."dateFinPrevue"` },
    AVANCEMENT_HORS_BORNES: { modele: 1, sql: `SELECT count(*) FROM marches m WHERE m."deletedAt" IS NULL AND (EXISTS (SELECT 1 FROM avancement_marche a WHERE a."marcheId" = m.id AND (a."avancementPhysiquePrevu" NOT BETWEEN 0 AND 100 OR a."avancementPhysiqueReel" NOT BETWEEN 0 AND 100 OR a."avancementFinancierPrevu" NOT BETWEEN 0 AND 100 OR a."avancementFinancierReel" NOT BETWEEN 0 AND 100))
      OR EXISTS (SELECT 1 FROM marches_chantiers mc JOIN chantiers c ON c.id = mc."chantierId" AND c."deletedAt" IS NULL WHERE mc."marcheId" = m.id AND c."avancementPct" NOT BETWEEN 0 AND 100))` },
    CHANTIER_SANS_MARCHE: { modele: 4, sql: `SELECT count(*) FROM chantiers c WHERE c."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM marches_chantiers mc JOIN marches m ON m.id = mc."marcheId" AND m."deletedAt" IS NULL WHERE mc."chantierId" = c.id)` },
    REFERENCES_DIVERGENTES: { modele: 0, sql: `SELECT count(*) FROM marches m WHERE m."deletedAt" IS NULL AND (SELECT count(DISTINCT lower(btrim(c."numContrat"))) FROM marches_chantiers mc JOIN chantiers c ON c.id = mc."chantierId" AND c."deletedAt" IS NULL WHERE mc."marcheId" = m.id AND btrim(coalesce(c."numContrat", '')) <> '') > 1` },
  };
  for (const [code, o] of Object.entries(oracles)) {
    const attenduSql = Number(await un(o.sql));
    verifier(`controle ${code} : API ${ctrl(code).nombre} = SQL ${attenduSql} = modele ${o.modele}`, ctrl(code).nombre === attenduSql && attenduSql === o.modele, { api: ctrl(code).nombre, sql: attenduSql, modele: o.modele });
  }
  verifier("chaque controle porte sa population, ses exemples sont bornes a 5 et les controles a zero sont conserves", rAdmin.body.controles.length === 9 && rAdmin.body.controles.every((c: any) => c.exemples.length <= 5 && c.surTotal >= 0 && c.statutDefinition === "PROVISOIRE") && ctrl("REFERENCES_DIVERGENTES").nombre === 0); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("qualite des liens : DIRECT, PAR_CHANTIER, MANQUANT, AMBIGU lus sur les marches fabriques", fiche("mR2").liens.troncons.qualite === "DIRECT" && fiche("mRetard").liens.troncons.qualite === "PAR_CHANTIER" && fiche("mCHSansTroncon").liens.troncons.qualite === "MANQUANT" && fiche("mSansChantier").liens.chantiers.qualite === "MANQUANT" && fiche("mAmbigu").liens.troncons.qualite === "AMBIGU" && fiche("mPartage").liens.chantiers.qualite === "AMBIGU");
  verifier("un chantier archive lie est ignore et compte : marche sans chantier actif", fiche("mArchive").liens.chantiers.total === 0 && fiche("mArchive").liens.chantiers.archivesIgnores === 1 && fiche("mArchive").anomalies.includes("MARCHE_SANS_CHANTIER"));
  verifier("donnees partielles toujours dites, avec la source externe non integree, copie gelee et synchronisation inconnue", rAdmin.body.donneesPartielles.partiel === true && /non intégrée \(DigitalRoad\)/.test(rAdmin.body.donneesPartielles.message) && rAdmin.body.source.integree === false && rAdmin.body.source.copieGelee === true && rAdmin.body.fraicheur.derniereSynchronisation === null);

  // ---------------------------------------------------------------------------------------------- D. compte regional
  console.log("\nD. Compte regional : perimetre, masquage, 404, jamais de total national");
  const rR1 = await get(T.r1, `${BASE}?limite=100`);
  const rR2 = await get(T.r2, `${BASE}?limite=100`);
  const visibles = async (region: number) => (await sql<{ id: string }>(`SELECT DISTINCT m.id ${JOINT} WHERE m."deletedAt" IS NULL AND ($1 = c."regionId" OR $1 = tl."regionId" OR $1 = tc."regionId")`, region)).map((x) => x.id);
  verifier("GESTIONNAIRE region 1 : 200 et ensemble de marches = oracle SQL", rR1.status === 200 && memes(ids(rR1), await visibles(R1)), { api: ids(rR1).length, sql: (await visibles(R1)).length });
  verifier("GESTIONNAIRE region 1 : ensemble = modele a la main (10 marches)", memes(ids(rR1), ["mR1OK", "mMulti", "mCHSansTroncon", "mAmbigu", "mPartage", "mUsd", "mDecSup", "mDates", "mBailleur", "mRetard"].map(idDe)));
  verifier("GESTIONNAIRE region 2 : ensemble = oracle SQL = modele (R2, multi, avancement, sans montant)", rR2.status === 200 && memes(ids(rR2), await visibles(R2)) && memes(ids(rR2), ["mR2", "mMulti", "mAv", "mSansMontant"].map(idDe)));
  const invisibleR1 = ["mR2", "mSansChantier", "mNR", "mAv", "mSansMontant", "mArchive", "mSupprime"].map(idDe);
  verifier("region 1 ne voit NI marche d'une autre region, NI marche sans territoire, NI marche « Non renseigne », NI archive, NI supprime", invisibleR1.every((i) => !ids(rR1).includes(i)));
  const corps1 = rR1.text ?? JSON.stringify(rR1.body);
  const interdits = ["BANC R2 OK", "BANC SANS CHANTIER", "BANC NON RENSEIGNE", "BANC AVANCEMENT", "BANC SANS MONTANT", "BANC SUPPRIME", "Chantier multi chez R2", "2222222", "4444444", "6666666", "7777777", "Region contractuel 2"];
  verifier("le corps region 1 ne contient aucun intitule, chantier, montant ni region d'une autre region", interdits.every((s) => !corps1.includes(s)), interdits.filter((s) => corps1.includes(s)));
  verifier("aucun total national : le contractuel national ne figure nulle part dans le corps region 1", !corps1.includes(attenduContractuel) && rR1.body.perimetre.totalNationalFourni === false && rR1.body.perimetre.national === false && /aucun total national/.test(rR1.body.perimetre.libelle));
  const multi1 = rR1.body.marches.find((m: any) => m.id === idDe("mMulti")); // eslint-disable-line @typescript-eslint/no-explicit-any
  verifier("marche multi-regional vu de la region 1 : montants et decomptes MASQUES (TERRITOIRE), chantier de la region 2 absent, 5555555 et 777777 absents", multi1.territoire.montantsMasques === true && ["contractuel", "decaisse", "previsionnel"].every((k) => multi1.montants[k].valeurGnf === null && multi1.montants[k].motif === "TERRITOIRE") && multi1.liens.chantiers.liste.length === 1 && multi1.liens.chantiers.liste[0].intitule === "Chantier multi chez R1" && !corps1.includes("5555555") && !corps1.includes("777777"));
  const maskR1 = (await sql<{ id: string }>(`SELECT m.id FROM marches m WHERE m."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM marches_chantiers mc JOIN chantiers c ON c.id = mc."chantierId" AND c."deletedAt" IS NULL
    LEFT JOIN troncons tl ON tl.id = mc."tronconId" AND tl."deletedAt" IS NULL LEFT JOIN troncons tc ON tc.id = c."tronconId" AND tc."deletedAt" IS NULL
    WHERE mc."marcheId" = m.id AND (c."regionId" <> $1 OR tl."regionId" <> $1 OR tc."regionId" <> $1))`, R1)).map((x) => x.id);
  verifier("marches masques pour la region 1 = oracle SQL (marche qui deborde du perimetre)", memes(rR1.body.marches.filter((m: any) => m.territoire.montantsMasques).map((m: any) => m.id), maskR1.filter((i) => ids(rR1).includes(i)))); // eslint-disable-line @typescript-eslint/no-explicit-any
  const totalR1 = await un(`SELECT sum(m."montantTotal") FROM marches m WHERE m."deletedAt" IS NULL AND m.devise = 'GNF' AND m.id = ANY($1::uuid[]) AND NOT (m.id = ANY($2::uuid[]))`, await visibles(R1), maskR1);
  verifier("contractuel region 1 = somme SQL des marches visibles ET non masques en GNF (multi et USD exclus)", rR1.body.synthese.financier.contractuel.valeurGnf === totalR1, { api: rR1.body.synthese.financier.contractuel.valeurGnf, sql: totalR1 });
  verifier("marches recenses region 1 = 10 ; page.total = 10 (pas le total national)", rR1.body.synthese.marchesRecenses.nombre === 10 && rR1.body.page.total === 10);
  const orphelinsR1 = Number(await un(`SELECT count(*) FROM chantiers c WHERE c."deletedAt" IS NULL AND c."regionId" = $1 AND NOT EXISTS (SELECT 1 FROM marches_chantiers mc JOIN marches m ON m.id = mc."marcheId" AND m."deletedAt" IS NULL WHERE mc."chantierId" = c.id)`, R1));
  verifier("chantiers sans marche region 1 = oracle SQL sur SA region (3 : deux orphelins et le chantier du marche supprime)", rR1.body.controles.find((c: any) => c.code === "CHANTIER_SANS_MARCHE").nombre === orphelinsR1 && orphelinsR1 === 3, { sql: orphelinsR1 }); // eslint-disable-line @typescript-eslint/no-explicit-any

  // 404 identique
  const f404 = [
    await get(T.r1, `${BASE}/marches/${idDe("mR2")}`),                   // hors perimetre
    await get(T.r1, `${BASE}/marches/${randomUUID()}`),                  // inexistant
    await get(T.r1, `${BASE}/marches/${idDe("mSupprime")}`),             // supprime
    await get(T.r1, `${BASE}/marches/${idDe("mSansChantier")}`),         // territoire inconnu
    await get(T.r1, `${BASE}/marches/pas-un-uuid`),                      // mal forme
    await get(T.admin, `${BASE}/marches/${randomUUID()}`),               // inexistant, vu d'un ADMIN
    await get(T.admin, `${BASE}/marches/${idDe("mSupprime")}`),          // supprime, vu d'un ADMIN
  ];
  verifier("404 IDENTIQUE (statut et corps) : hors perimetre, inexistant, supprime, territoire inconnu, mal forme, et pour un ADMIN inexistant/supprime", f404.every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify(f404[0].body)), f404.map((r) => r.status));
  const ficheMulti = await get(T.r1, `${BASE}/marches/${idDe("mMulti")}`);
  verifier("fiche du marche multi-regional pour la region 1 : 200, montants des decomptes masques", ficheMulti.status === 200 && ficheMulti.body.decomptes.liste.every((d: any) => d.montantGnf === null) && !ficheMulti.text.includes("777777")); // eslint-disable-line @typescript-eslint/no-explicit-any
  const ficheAdmin = await get(T.admin, `${BASE}/marches/${idDe("mR1OK")}`);
  verifier("fiche ADMIN : decomptes listes avec montant exact, ce qui compte dans le decaisse", ficheAdmin.status === 200 && ficheAdmin.body.decomptes.liste.length === 3 && ficheAdmin.body.decomptes.liste.find((d: any) => d.numero === 1).montantGnf === PAYE_GRAND.toString() && ficheAdmin.body.decomptes.liste.filter((d: any) => d.compteDansDecaisse).length === 1); // eslint-disable-line @typescript-eslint/no-explicit-any

  // region demandee
  const hors = await get(T.r1, `${BASE}?regionId=${R2}`);
  verifier("region demandee hors perimetre : 403 HORS_PERIMETRE", hors.status === 403 && hors.body.code === "HORS_PERIMETRE");
  const dansP = await get(T.r1, `${BASE}?regionId=${R1}&limite=100`);
  verifier("region demandee dans le perimetre : 200 et meme ensemble", dansP.status === 200 && memes(ids(dansP), ids(rR1)));
  const natR2 = await get(T.nat, `${BASE}?regionId=${R2}&limite=100`);
  verifier("filtre regionId d'un national : les marches qui touchent cette region (oracle SQL)", memes(ids(natR2), await visibles(R2)));
  const statutF = await get(T.admin, `${BASE}?statutMarche=PLANIFIE&limite=100`);
  verifier("filtre statutMarche = oracle SQL", memes(ids(statutF), (await sql<{ id: string }>(`SELECT id FROM marches WHERE "deletedAt" IS NULL AND statut = 'PLANIFIE'`)).map((x) => x.id)));
  const bailF = await get(T.admin, `${BASE}?bailleurId=${bm.id}&limite=100`);
  verifier("filtre bailleurId = oracle SQL (aucun marche du bailleur 2 : liste vide, pas une erreur)", bailF.status === 200 && ids(bailF).length === Number(await un(`SELECT count(*) FROM marches WHERE "deletedAt" IS NULL AND "bailleurId" = $1`, bm.id)));
  const retardF = await get(T.admin, `${BASE}?depuis=2019-01-01&jusqua=2021-01-01&limite=100`);
  verifier("filtre de periode : chevauchement avec la periode contractuelle ; marches sans date exclus et comptes", ids(retardF).includes(idDe("mRetard")) && !ids(retardF).includes(idDe("mR1OK")) && retardF.body.perimetre.exclusParFiltre.sansDate > 0, { exclus: retardF.body.perimetre.exclusParFiltre });
  const clsF = await get(T.admin, `${BASE}?classe=PISTE&limite=100`);
  verifier("filtre classe sans correspondance : liste vide (200), pas une erreur", clsF.status === 200 && ids(clsF).length === 0);

  // ---------------------------------------------------------------------------------------------- E. pagination
  console.log("\nE. Pagination par curseur");
  const attenduOrdre = (await sql<{ id: string }>(`SELECT id FROM marches WHERE "deletedAt" IS NULL ORDER BY "createdAt" DESC, id ASC`)).map((x) => x.id);
  const vus: string[] = [];
  let curseur: string | null = null; let pages = 0; let totaux = new Set<number>();
  do {
    const r: Rep = await get(T.admin, `${BASE}?limite=5${curseur ? `&curseur=${curseur}` : ""}`);
    if (r.status !== 200) break;
    vus.push(...ids(r)); totaux.add(r.body.page.total); curseur = r.body.page.curseurSuivant; pages += 1;
  } while (curseur && pages < 20);
  verifier("pagination limite=5 : 4 pages, aucun doublon, aucun saut, ordre egal a ORDER BY \"createdAt\" DESC, id ASC", pages === 4 && vus.length === 16 && new Set(vus).size === 16 && JSON.stringify(vus) === JSON.stringify(attenduOrdre), { pages, vus: vus.length });
  verifier("le total est constant d'une page a l'autre", totaux.size === 1 && totaux.has(16));
  const apresFin = await get(T.admin, `${BASE}?curseur=${Buffer.from(JSON.stringify({ c: "1999-01-01T00:00:00.000Z", i: randomUUID() })).toString("base64url")}`);
  verifier("curseur apres la derniere ligne : page vide, pas de premiere page", apresFin.status === 200 && apresFin.body.marches.length === 0 && apresFin.body.page.curseurSuivant === null);

  // ---------------------------------------------------------------------------------------------- F. entrees hostiles
  console.log("\nF. Entrees hostiles");
  const HOSTILES = ["regionId=abc", "regionId=1&regionId=2", "regionId=-1", "regionId=0", "regionId=1e3", "regionId=99999999999", "regionId=2147483648", "regionId=%00", "regionId=1%3BDROP%20TABLE%20marches", "classe=XX", "classe[a]=b", "etat=ENORME",
    "statutChantier=ACTIF", "statutMarche=ACTIF", "bailleurId=x", "depuis=2026-02-30", "jusqua=hier", "depuis=2026-10-01&jusqua=2026-01-01", "limite=0", "limite=101", "limite=1.5", "limite=1&limite=2", "curseur=!!!",
    `curseur=${"a".repeat(301)}`, `curseur=${Buffer.from("pas du json").toString("base64url")}`, `curseur=${Buffer.from(JSON.stringify({ c: "2026-10-01T00:00:00.000Z", i: "'; DROP TABLE marches;--" })).toString("base64url")}`];
  const reponses: [string, number][] = [];
  for (const q of HOSTILES) for (const t of [T.admin, T.r1]) reponses.push([q, (await get(t, `${BASE}?${q}`)).status]);
  verifier(`${HOSTILES.length} entrees hostiles x ADMIN et region 1 : toutes en 400, aucun 500`, reponses.every(([, s]) => s === 400), reponses.filter(([, s]) => s !== 400));
  const injections = ["1'%20OR%20'1'='1", "..%2F..%2Fetc%2Fpasswd", "%00", "%E2%80%AE"];
  const rInj = await Promise.all(injections.map((i) => get(T.admin, `${BASE}/marches/${i}`)));
  verifier("identifiant de fiche hostile : 404 au meme corps, jamais 500", rInj.every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify(f404[0].body)), rInj.map((r) => r.status));
  verifier("cles inconnues (filtres des autres onglets) ignorees : 200", (await get(T.admin, `${BASE}?bailleur=BAD&axe=RN1&prefecture=Kindia&limite=5`)).status === 200);
  verifier("tables toujours vivantes apres les entrees hostiles (marches non supprimes = 16)", await un(`SELECT count(*) FROM marches WHERE "deletedAt" IS NULL`) === "16");

  // ---------------------------------------------------------------------------------------------- G. contre-epreuve du perimetre lu en base
  console.log("\nG. Contre-epreuve : le perimetre en base decide");
  await sql(`DELETE FROM perimetres_comptes WHERE "userId" = $1`, gR1.id);
  const devenuNational = await get(T.r1, `${BASE}?limite=100`);
  verifier("meme jeton, meme requete, SANS rattachement : le compte est national et voit tout (comportement D-11 documente)", devenuNational.status === 200 && devenuNational.body.perimetre.national === true && memes(ids(devenuNational), VIVANTS.map(idDe)));
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, gR1.id, R1, admin.id);
  const reRegional = await get(T.r1, `${BASE}?limite=100`);
  verifier("rattachement retabli : le meme jeton retombe sur le perimetre regional sans nouveau jeton", reRegional.body.perimetre.national === false && memes(ids(reRegional), ids(rR1)));

  // ---------------------------------------------------------------------------------------------- H. aucune ecriture
  console.log("\nH. Aucune ecriture");
  const avant = await empreintes();
  await sql(`CREATE OR REPLACE FUNCTION essai_interdit_ecriture() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'ecriture interdite pendant la lecture (banc AD-L5)' USING ERRCODE = '25006'; END $$ LANGUAGE plpgsql`);
  for (const t of TABLES_LECTURE) await sql(`CREATE TRIGGER essai_ro BEFORE INSERT OR UPDATE OR DELETE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION essai_interdit_ecriture()`);
  let refus = "";
  try { await sql(`UPDATE marches SET intitule = intitule`); } catch (e) { refus = String((e as { message?: string }).message ?? e); }
  verifier("contre-epreuve : une ecriture directe est bien refusee par le declencheur (la preuve n'est pas vide)", /ecriture interdite pendant la lecture/.test(refus), refus.slice(0, 120));
  const statuts: number[] = [];
  for (const t of [T.admin, T.nat, T.lect, T.r1, T.r2]) {
    statuts.push((await get(t, `${BASE}?limite=100`)).status, (await get(t, `${BASE}?statutMarche=EN_COURS&classe=RN&depuis=2020-01-01&limite=3`)).status, (await get(t, `${BASE}/marches/${idDe("mR1OK")}`)).status, (await get(t, `${BASE}/marches/${idDe("mMulti")}`)).status);
  }
  verifier("20 lectures (listes filtrees, fiches, tous profils) sous declencheurs refusant toute ecriture : aucune 500", statuts.every((s) => s === 200 || s === 404 || s === 403), statuts);
  const apres = await empreintes();
  verifier("empreintes md5 et comptes de neuf tables (marches, decomptes, avancement_marche, marches_chantiers, chantiers, troncons, programmes_budgetaires, bailleurs, audit_logs) identiques avant et apres", JSON.stringify(avant) === JSON.stringify(apres), { avant, apres });
  for (const t of TABLES_LECTURE) await sql(`DROP TRIGGER IF EXISTS essai_ro ON ${t}`);

  // ---------------------------------------------------------------------------------------------- I. cout
  console.log("\nI. Cout (poste de developpement)");
  const N = 400;
  const mids = Array.from({ length: N }, () => randomUUID());
  const cids = Array.from({ length: N }, () => randomUUID());
  await prisma.marche.createMany({ data: mids.map((id, i) => ({ id, intitule: `BANC PERF ${i}`, bailleurId: i % 2 ? bad.id : bm.id, montantTotal: BigInt(1_000_000 + i), createdAt: new Date(Date.UTC(2026, 4, 1) - i * 60_000) })) });
  await prisma.chantier.createMany({ data: cids.map((id, i) => ({ id, intitule: `Chantier perf ${i}`, entreprise: "ENT PERF", regionId: i % 3 === 0 ? R2 : R1, tronconId: tR1A.id })) });
  await prisma.marcheChantier.createMany({ data: mids.map((marcheId, i) => ({ marcheId, chantierId: cids[i] })) });
  await prisma.decompte.createMany({ data: mids.flatMap((marcheId, i) => [1, 2, 3].map((numero) => ({ marcheId, numero, statut: numero === 1 ? "PAYE" : "EMIS", montantGnf: BigInt(1000 * numero + i) }))) });
  const t0 = Date.now();
  const grande = await get(T.admin, `${BASE}?limite=100`);
  const ms = Date.now() - t0;
  const t1 = Date.now();
  const regionale = await get(T.r1, `${BASE}?limite=100`);
  const msR = Date.now() - t1;
  console.log(`  liste de 100 sur ${16 + N} marches : ADMIN ${ms} ms, region 1 ${msR} ms`);
  verifier(`${16 + N} marches : liste de 100 en moins de 20 s (ADMIN ${ms} ms, region 1 ${msR} ms ; poste de developpement, pas un serveur de production)`, grande.status === 200 && regionale.status === 200 && ms < 20_000 && msR < 20_000);
  verifier("volume : agregats toujours egaux aux oracles SQL (recenses et contractuel GNF)", String(grande.body.synthese.marchesRecenses.nombre) === await un(`SELECT count(*) FROM marches WHERE "deletedAt" IS NULL`) && grande.body.synthese.financier.contractuel.valeurGnf === await un(`SELECT sum("montantTotal") FROM marches WHERE "deletedAt" IS NULL AND devise = 'GNF' AND "montantTotal" IS NOT NULL`));
  verifier("volume : la page est bornee a 100 lignes et annonce la suite", grande.body.marches.length === 100 && grande.body.page.curseurSuivant !== null && grande.body.page.total === 16 + N);
}

try {
  await main();
} catch (e) {
  console.error("ERREUR DU BANC", e);
  process.exitCode = 1;
} finally {
  conclure();
  await prisma.$disconnect();
  await banc.fermer();
}
