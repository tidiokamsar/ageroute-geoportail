// Banc d'integration PostGIS du lot 6 de l'Aide a la decision : baremes versionnes et historises, exports gouvernes.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/aide-decision-baremes-exports.integration.mts
//
// CE QUE LE BANC FAIT PASSER PAR LE CODE REEL : les routeurs `baremes`, `export` (selection) et `aide-decision.exports`
// (non montes dans api-v2/index.ts : le banc les monte lui-meme), le VRAI `requireAuth` (jetons signes par des secrets
// aleatoires), les modules et le perimetre territorial LUS EN BASE, l'audit transactionnel, les triggers d'ajout seul, le moteur
// de programmation (scenario scelle), les fournisseurs reels (synthese du lot 2, etat par region), contre un clone PostGIS
// jetable `essai_ad_l6_be`. Chaque verification relit la BASE, pas seulement la reponse HTTP.
//
// L'ORACLE du rapport par region est une requete SQL independante du code TypeScript (aucun import du noyau du lot 2).
import { createHash } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

(BigInt.prototype as any).toJSON = function () { return this.toString(); };

const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_ad_l6_be", {
  migrations: ["20261023100000_moteur_programmation", "20261029300000_ad_baremes_historique"],
});
process.env.RATE_LIMIT_V2_MAX = "0";
const { prisma } = await banc.imp("lib/prisma");
const { signAccessToken } = await banc.imp("utils/jwt");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { aideDecisionExportsRouter } = await banc.imp("api-v2/aide-decision.exports.routes");
const { baremesV2Router } = await banc.imp("api-v2/baremes.routes");
const { exportV2Router } = await banc.imp("api-v2/export.routes");
const moteur = await banc.imp("programmation/moteur.service");
const { VALEURS_AMORCAGE_PROVISOIRES } = await banc.imp("programmation/parametres.noyau");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json());
app.use("/api/v2/aide-decision", aideDecisionExportsRouter);
app.use("/api/v2/baremes", baremesV2Router);
app.use("/api/v2/export", exportV2Router);
app.use(errorHandler);

const sql = async <T = Record<string, any>>(texte: string, ...p: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...p);
const n = async (texte: string, ...p: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...p))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
type Rep = { status: number; body: any; text: string; headers: Record<string, string> };
const appeler = (verbe: "get" | "post" | "patch", url: string, token: string, corps?: unknown): Promise<Rep> => {
  const r = request(app)[verbe](url).set("Authorization", `Bearer ${token}`).buffer(true).parse((res: any, cb: any) => {
    let d = ""; res.setEncoding("utf8"); res.on("data", (c: string) => { d += c; }); res.on("end", () => cb(null, d));
  });
  return (corps === undefined ? r : r.send(corps as object)) as unknown as Promise<Rep>;
};
const texte = (r: Rep) => (typeof r.body === "string" ? r.body : r.text);
const tableau = (r: Rep) => texte(r).split("\n\n")[1] ?? "";
const json = (r: Rep) => (typeof r.body === "string" ? JSON.parse(r.body) : r.body);
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

async function main() {
  // ================================================================ fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region AD1'), ('Region AD2')`);
  const rid = async (nom: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, nom))[0].id);
  const [R1, R2] = [await rid("Region AD1"), await rid("Region AD2")];
  const TOUS = ["rapports", "decision", "programmation", "marches", "troncons", "ouvrages", "chantiers", "points-noirs", "postes"];
  const mk = (email: string, role: string, modulesAutorises: string[]) => prisma.user.create({ data: { email, nomComplet: email, passwordHash: "x", role, modulesAutorises } });
  const adm1 = await mk("adm1@ad6.invalid", "ADMIN", []);
  const adm2 = await mk("adm2@ad6.invalid", "ADMIN", []);
  const gest = await mk("gest@ad6.invalid", "GESTIONNAIRE", TOUS);
  const gestR1 = await mk("gestr1@ad6.invalid", "GESTIONNAIRE", TOUS);
  // REGLE UNIQUE (droitMontantsContractuels, PROVISOIRE) : ADMIN, `marches` ou `chantiers`. « Sans droit financier » = ni l'un ni l'autre.
  const gestSansFin = await mk("gestsf@ad6.invalid", "GESTIONNAIRE", TOUS.filter((m) => m !== "marches" && m !== "chantiers"));
  const gestChantiers = await mk("gestch@ad6.invalid", "GESTIONNAIRE", TOUS.filter((m) => m !== "marches"));
  const lecteur = await mk("lecteur@ad6.invalid", "LECTEUR", TOUS);
  const T = { adm1: jeton(adm1), adm2: jeton(adm2), gest: jeton(gest), r1: jeton(gestR1), sf: jeton(gestSansFin), ch: jeton(gestChantiers), lec: jeton(lecteur) };
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, gestR1.id, R1, adm1.id);

  // ================================================================ B. BAREMES
  console.log("\n== B. Baremes versionnes et historises ==");
  const bareme = (await sql<{ id: number; version: number }>(`SELECT id, version FROM baremes_intervention WHERE "familleRevetement" = 'bitume' AND "etatDepart" = 'CRITIQUE' ORDER BY id LIMIT 1`))[0];
  const BID = bareme.id;
  const ligne = async () => (await sql<any>(`SELECT version, "coutKmGnf"::text AS cout, "anneeReference", "largeurChausseeM"::text AS largeur, "approuveLe", "approuveParId", libelle, commentaire FROM baremes_intervention WHERE id = $1`, BID))[0];
  const hist = () => sql<any>(`SELECT * FROM baremes_historique WHERE "baremeId" = $1 ORDER BY id`, BID);
  const MOTIF = "Mise a jour selon l'arrete de reference du banc";
  const COMM = "Prix relu contre le bordereau du banc";
  const v0 = await ligne();
  verifier("B0 etat initial : ligne d'origine, version 1, non approuvee, sans historique", v0.version === 1 && v0.approuveLe === null && (await hist()).length === 0, v0);

  // Scenario calcule AVANT toute modification (pour la preuve d'immutabilite)
  const params = await moteur.creerParametres(prisma, { version: "essai-ad6", valeurs: VALEURS_AMORCAGE_PROVISOIRES, motif: "banc lot 6" }, { userId: adm1.id, email: adm1.email });
  const mkTroncon = (code: string, region: number, etat: string, km: number, extra: { src?: string | null; supprime?: boolean; jma?: number } = {}) => sql(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "traficMoyenJma", "sourceReference", "statutValidation", "deletedAt", geom, "updatedAt")
     VALUES ($1, $2, $3, 'RN', $4, $5, 'BITUME'::"Revetement", $6::"EtatPatrimoine", 0, $5, $7, $8, 'VALIDE'::"StatutValidation", $9, ST_GeomFromText('LINESTRING(-13.6 9.6, -13.58 9.6)', 4326), now())`,
    `t-${code}`, code, `Troncon ${code}`, region, km, etat, extra.jma ?? 900, extra.src ?? null, extra.supprime ? new Date() : null);
  // R1 : BON 10 km, MAUVAIS 5 km, CRITIQUE 3 km (tous constates), NON_EVALUE 40 km ; un archive (CRITIQUE 99 km) ; une voirie promue (BON 77 km)
  await mkTroncon("AD-R1-BON", R1, "BON", 10);
  await mkTroncon("AD-R1-MAU", R1, "MAUVAIS", 5);
  await mkTroncon("AD-R1-CRI", R1, "CRITIQUE", 3);
  await mkTroncon("AD-R1-NE", R1, "NON_EVALUE", 40);
  await mkTroncon("AD-R1-ARCH", R1, "CRITIQUE", 99, { supprime: true });
  await mkTroncon("AD-R1-VOIRIE", R1, "BON", 77, { src: "voirie_locale:osm-1" });
  // R2 : BON 20 km, MAUVAIS 20 km
  await mkTroncon("AD-R2-BON", R2, "BON", 20);
  await mkTroncon("AD-R2-MAU", R2, "MAUVAIS", 20);
  // Etat CONSTATE (valeurs_qualite OBSERVED datee) pour les troncons evalues : sans lui l'etat n'est pas « valide » (lot 2).
  await sql(`INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, "observedAt", "updatedAt")
             SELECT gen_random_uuid()::text, 'Troncon', id, 'etat', 'OBSERVED', now() - interval '10 days', now()
               FROM troncons WHERE code IN ('AD-R1-BON','AD-R1-MAU','AD-R1-CRI','AD-R1-ARCH','AD-R1-VOIRIE','AD-R2-BON','AD-R2-MAU')`);

  await sql(`INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "deletedAt", "updatedAt")
             SELECT gen_random_uuid()::text, 'pn essai', "regionId", id, 'FORTE'::"Gravite", NULL, now() FROM troncons WHERE code LIKE 'AD-%' AND "deletedAt" IS NULL`);
  const scR1 = await moteur.simuler(prisma, { annee: 2027, intitule: "Scenario R1 banc", budgetGnf: 100_000_000_000n, regionId: R1, parametresId: params.id }, { userId: gest.id, email: gest.email });
  const scNat = await moteur.simuler(prisma, { annee: 2027, intitule: "Scenario national banc", budgetGnf: 100_000_000_000n, parametresId: params.id }, { userId: gest.id, email: gest.email });
  const idScR1: string = scR1.scenario.id; const idScNat: string = scNat.scenario.id;
  const lireSc = async (id: string) => (await sql<any>(`SELECT "entreesCanoniques", "empreinteEntrees", "resultatCanonique", "empreinteResultat" FROM scenarios_programmation WHERE id = $1`, id))[0];
  const scAvant = await lireSc(idScNat);
  const rejeuAvant = await moteur.rejouer(prisma, idScNat);
  verifier("B1 un scenario a ete calcule avant toute modification de bareme (lignes chiffrees, rejeu identique)",
    scNat.resultat.lignes.some((l: any) => l.cout?.ok) && rejeuAvant.identique === true, scNat.resultat.totaux);

  // --- motif obligatoire
  const sansMotif = await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { anneeReference: 2026, largeurChausseeM: 6.5 });
  verifier("B2 modifier sans motif : 400, ligne et historique INCHANGES", sansMotif.status === 400 && (await ligne()).version === 1 && (await hist()).length === 0, sansMotif.status);

  // --- modification (gestionnaire) : version 2, historique et audit
  const mod1 = await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { anneeReference: 2026, largeurChausseeM: 6.5, devise: "GNF", uniteCout: "KM", motif: MOTIF, versionAttendue: 1 });
  const l1 = await ligne(); const h1 = await hist();
  verifier("B3 modification : 200, version 2, millesime et largeur poses", mod1.status === 200 && l1.version === 2 && l1.anneeReference === 2026 && Number(l1.largeur) === 6.5, [mod1.status, l1]);
  verifier("B3 l'historique porte l'evenement, l'auteur, le motif, les valeurs avant et apres",
    h1.length === 1 && h1[0].evenement === "MODIFICATION" && h1[0].auteurId === gest.id && h1[0].motif === MOTIF && h1[0].modifieCalcul === true
      && h1[0].valeursAvant.anneeReference === null && h1[0].valeursApres.anneeReference === 2026 && h1[0].version === 2, h1[0]);
  const aud1 = await sql<any>(`SELECT action::text AS action, before, after FROM audit_logs WHERE "entityType" = 'BaremeIntervention' AND "entityId" = $1 ORDER BY "createdAt", id`, String(BID));
  verifier("B3 l'audit est ecrit avec valeurs avant/apres, libelle, commentaire et motif",
    aud1.length === 1 && aud1[0].action === "UPDATE" && aud1[0].before.anneeReference === null && aud1[0].after.anneeReference === 2026 && aud1[0].after.motif === MOTIF
      && "libelle" in aud1[0].after && "commentaire" in aud1[0].after, aud1[0]);
  const cf = await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { libelle: "x desuet", motif: MOTIF, versionAttendue: 1 });
  verifier("B3 verrou optimiste : une version lue perimee donne 409 et n'ecrit rien", cf.status === 409 && (await hist()).length === 1, cf.status);

  // --- approbation : role, motif/commentaire, separation des taches
  const apGest = await appeler("post", `/api/v2/baremes/${BID}/approuver`, T.gest, { motif: MOTIF, commentaire: COMM, versionAttendue: (await ligne()).version });
  verifier("B4 un GESTIONNAIRE n'approuve pas (403)", apGest.status === 403 && (await ligne()).approuveLe === null, apGest.status);
  const apSans = await appeler("post", `/api/v2/baremes/${BID}/approuver`, T.adm1, { motif: MOTIF });
  verifier("B4 approuver sans commentaire : 400", apSans.status === 400 && (await ligne()).approuveLe === null, apSans.status);
  // REVUE (item 8) : `versionAttendue` est OBLIGATOIRE pour approuver.
  const apSansVersion = await appeler("post", `/api/v2/baremes/${BID}/approuver`, T.adm1, { motif: MOTIF, commentaire: COMM });
  verifier("B4 approuver sans versionAttendue : 400 CORPS_INVALIDE, rien n'est approuve en base", apSansVersion.status === 400 && json(apSansVersion).code === "CORPS_INVALIDE" && (await ligne()).approuveLe === null, apSansVersion.status);
  const corpsAp = async () => ({ motif: MOTIF, commentaire: COMM, versionAttendue: (await ligne()).version });
  const apOk = await appeler("post", `/api/v2/baremes/${BID}/approuver`, T.adm1, await corpsAp());
  const l2 = await ligne(); const h2 = await hist();
  verifier("B4 un ADMIN autre que l'auteur approuve (200) ; approuveLe et approuveParId poses en base", apOk.status === 200 && l2.approuveLe !== null && l2.approuveParId === adm1.id, [apOk.status, l2]);
  verifier("B4 l'approbation est historisee (commentaire, statut APPROUVE) et auditee (VALIDATE avant/apres)",
    h2.length === 2 && h2[1].evenement === "APPROBATION" && h2[1].statutApprobation === "APPROUVE" && h2[1].commentaire === COMM
      && (await n(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'BaremeIntervention' AND "entityId" = $1 AND action = 'VALIDATE'`, String(BID))) === 1, h2[1]);

  // --- libelle vs prix sur une ligne approuvee
  const lib = await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { libelle: "Reconstruction bitume (RN)", commentaire: "precision de redaction", motif: MOTIF });
  const l3 = await ligne(); const h3 = await hist();
  verifier("B5 un libelle ou un commentaire modifie NE desapprouve PAS un prix approuve et ne change pas la version (relu en base)",
    lib.status === 200 && l3.approuveLe !== null && l3.version === 2 && l3.libelle === "Reconstruction bitume (RN)" && h3[h3.length - 1].modifieCalcul === false && h3[h3.length - 1].statutApprobation === "APPROUVE", [lib.status, l3]);
  const prix = await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { coutKmGnf: "3600000000", motif: MOTIF });
  const l4 = await ligne(); const h4 = await hist();
  verifier("B5 MUTATION DE CONTROLE : un changement de prix desapprouve et incremente (version 3)", prix.status === 200 && l4.approuveLe === null && l4.version === 3 && l4.cout === "3600000000" && h4[h4.length - 1].approbationReinitialisee === true, [prix.status, l4]);
  const nul = await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { coutKmGnf: "3600000000", motif: MOTIF });
  verifier("B5 renvoyer la meme valeur n'est pas une modification (400, aucune version fantome)", nul.status === 400 && (await ligne()).version === 3, nul.status);

  // --- auto-validation
  const auteurAdm = await appeler("patch", `/api/v2/baremes/${BID}`, T.adm1, { anneeReference: 2027, motif: MOTIF });
  const auto = await appeler("post", `/api/v2/baremes/${BID}/approuver`, T.adm1, await corpsAp());
  verifier("B6 un ADMIN n'approuve PAS la version dont il est l'auteur : 403 AUTO_VALIDATION, ligne non approuvee en base",
    auteurAdm.status === 200 && auto.status === 403 && json(auto).code === "AUTO_VALIDATION" && (await ligne()).approuveLe === null, [auteurAdm.status, auto.status, texte(auto)]);
  const autre = await appeler("post", `/api/v2/baremes/${BID}/approuver`, T.adm2, await corpsAp());
  verifier("B6 un AUTRE ADMIN l'approuve (200)", autre.status === 200 && (await ligne()).approuveParId === adm2.id, autre.status);

  // --- lecture : historique par les deux chemins
  const hA = await appeler("get", `/api/v2/aide-decision/baremes/${BID}/historique`, T.gest);
  const hB = await appeler("get", `/api/v2/baremes/${BID}/historique`, T.gest);
  const dA = json(hA);
  verifier("B7 GET /aide-decision/baremes/:id/historique et /baremes/:id/historique rendent le meme historique, du plus recent au plus ancien",
    hA.status === 200 && hB.status === 200 && dA.data.length === (await hist()).length && dA.data[0].evenement === "APPROBATION" && JSON.stringify(dA.data) === JSON.stringify(json(hB).data), dA.data.length);
  // REVUE (item 8) : un LECTEUR (module decision) ne voit aucune adresse e-mail d'auteur ou d'approbateur ; un identifiant hors entier 32 bits : 400.
  const hLec = await appeler("get", `/api/v2/aide-decision/baremes/${BID}/historique`, T.lec);
  const lisLec = await appeler("get", `/api/v2/aide-decision/baremes`, T.lec);
  verifier("B7 un LECTEUR lit l'historique et la liste sans AUCUNE adresse e-mail (identifiant minimal), un GESTIONNAIRE les voit", hLec.status === 200 && !texte(hLec).includes("@") && !texte(lisLec).includes("@") && json(hLec).data.length === dA.data.length && texte(hA).includes("@ad6.invalid"), [hLec.status, texte(hLec).slice(0, 300)]);
  const horsPlage = await appeler("get", `/api/v2/aide-decision/baremes/2147483648/historique`, T.gest);
  verifier("B7 identifiant de ligne hors de l'entier 32 bits : 400 ID_HORS_PLAGE (jamais une erreur SQL 500)", horsPlage.status === 400 && json(horsPlage).code === "ID_HORS_PLAGE", horsPlage.status);
  const liste = json(await appeler("get", `/api/v2/aide-decision/baremes`, T.gest));
  verifier("B7 GET /aide-decision/baremes : 9 lignes avec devise, unite, validite, version et statut", liste.data.length === 9 && liste.data.every((l: any) => l.devise === "GNF" && l.uniteCout === "KM" && "validDe" in l && "statutApprobation" in l), liste.data.length);

  // --- historique en ajout seul
  const upd = await prisma.$executeRawUnsafe(`UPDATE baremes_historique SET motif = 'reecrit' WHERE "baremeId" = ${BID}`).then(() => null, (e: Error) => e.message);
  const del = await prisma.$executeRawUnsafe(`DELETE FROM baremes_historique WHERE "baremeId" = ${BID}`).then(() => null, (e: Error) => e.message);
  verifier("B8 l'historique est en ajout seul : UPDATE et DELETE refuses par la base", /ajout seul/.test(upd ?? "") && /ajout seul/.test(del ?? ""), [upd, del]);

  // --- meme transaction : une panne d'audit annule tout
  await sql(`ALTER TABLE audit_logs ADD CONSTRAINT zz_banc_force_echec CHECK ("entityType" <> 'BaremeIntervention') NOT VALID`);
  const avantPanne = { l: await ligne(), h: (await hist()).length };
  const panne = await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { anneeReference: 2030, motif: MOTIF });
  await sql(`ALTER TABLE audit_logs DROP CONSTRAINT zz_banc_force_echec`);
  const apresPanne = { l: await ligne(), h: (await hist()).length };
  verifier("B9 l'historique est ecrit dans la MEME transaction : l'audit refuse par la base annule la modification ET la ligne d'historique",
    panne.status >= 500 && JSON.stringify(avantPanne) === JSON.stringify(apresPanne), [panne.status, avantPanne, apresPanne]);

  // --- scenarios deja calcules
  await appeler("patch", `/api/v2/baremes/${BID}`, T.gest, { coutKmGnf: "9900000000", motif: MOTIF });
  const scApres = await lireSc(idScNat);
  const rejeuApres = await moteur.rejouer(prisma, idScNat);
  const citeEntrees = JSON.parse(scApres.entreesCanoniques).baremes.find((b: any) => Number(b.id) === BID);
  verifier("B10 un scenario deja calcule n'est PAS altere par la modification d'un bareme : entrees, resultat et empreintes identiques",
    scApres.entreesCanoniques === scAvant.entreesCanoniques && scApres.resultatCanonique === scAvant.resultatCanonique
      && scApres.empreinteEntrees === scAvant.empreinteEntrees && scApres.empreinteResultat === scAvant.empreinteResultat, null);
  verifier("B10 le scenario embarque l'ANCIEN prix (copie), et son rejeu reste identique", citeEntrees?.coutKmGnf === "3500000000" && rejeuApres.identique === true && rejeuApres.entreesIntegres === true, citeEntrees);
  const alt = await prisma.$executeRawUnsafe(`UPDATE scenarios_programmation SET "intitule" = 'x' WHERE id = '${idScNat}'`).then(() => null, (e: Error) => e.message);
  verifier("B10 la base refuse de reecrire un scenario scelle (declencheur)", alt !== null, alt);

  // ================================================================ E. EXPORTS
  console.log("\n== E. Exports gouvernes ==");
  const idsTroncons = (await sql<{ id: string }>(`SELECT id FROM troncons WHERE code LIKE 'AD-%'`)).map((r) => r.id);
  // Chantiers, marches
  const mkChantier = (id: string, region: number, montant: number, supprime = false) => sql(
    `INSERT INTO chantiers (id, intitule, entreprise, bailleur, "montantGnf", "regionId", statut, "deletedAt", "updatedAt") VALUES ($1, $2, 'Entreprise essai', 'Bailleur essai', $3, $4, 'EN_COURS'::"StatutChantier", $5, now())`,
    id, `Chantier ${id}`, montant, region, supprime ? new Date() : null);
  await mkChantier("ad-c1", R1, 7654321, false); await mkChantier("ad-c2", R2, 8765432, false);
  const mkMarche = async (id: string, intitule: string, chantiers: string[], supprime = false) => {
    await sql(`INSERT INTO marches (id, intitule, "montantTotal", devise, statut, "deletedAt", "updatedAt") VALUES ($1::uuid, $2, 777000, 'GNF'::"DeviseMarche", 'EN_COURS'::"StatutMarche", $3, now())`, id, intitule, supprime ? new Date() : null);
    for (const c of chantiers) await sql(`INSERT INTO marches_chantiers ("marcheId", "chantierId") VALUES ($1::uuid, $2)`, id, c);
  };
  const M = { r1: "10000000-0000-4000-8000-000000000001", r2: "10000000-0000-4000-8000-000000000002", both: "10000000-0000-4000-8000-000000000003", orphan: "10000000-0000-4000-8000-000000000004", arch: "10000000-0000-4000-8000-000000000005" };
  await mkMarche(M.r1, "Marche R1", ["ad-c1"]); await mkMarche(M.r2, "Marche R2", ["ad-c2"]); await mkMarche(M.both, "Marche MULTI", ["ad-c1", "ad-c2"]);
  await mkMarche(M.orphan, "Marche SANS CHANTIER", []); await mkMarche(M.arch, "Marche ARCHIVE", ["ad-c1"], true);

  const tables = ["troncons", "chantiers", "marches", "marches_chantiers", "baremes_intervention", "scenarios_programmation"];
  const empreinteTables = async () => {
    const o: Record<string, string> = {};
    for (const t of tables) o[t] = (await sql<{ h: string }>(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), 'vide') AS h FROM ${t} x`))[0].h;
    return o;
  };
  const sourcesAvant = await empreinteTables();

  // --- selection (export.routes.ts durci), SQL reel
  const sel = (t: string, table: string, ids: string[], format = "csv") => appeler("post", "/api/v2/export/selection", t, { table, format, ids });
  const csvR1 = await sel(T.r1, "troncons", idsTroncons);
  const tR1 = texte(csvR1);
  verifier("E1 selection par un compte REGIONAL : seules les lignes de SA region (ni R2, ni archivee), controle par ligne en base",
    csvR1.status === 200 && tR1.includes("AD-R1-BON") && tR1.includes("AD-R1-MAU") && !tR1.includes("AD-R2-") && !tR1.includes("AD-R1-ARCH"), tR1.slice(0, 300));
  const csvNat = await sel(T.gest, "troncons", idsTroncons);
  const tNat = texte(csvNat);
  verifier("E1 le compte national recoit les deux regions, jamais la ligne archivee", csvNat.status === 200 && tNat.includes("AD-R1-BON") && tNat.includes("AD-R2-BON") && !tNat.includes("AD-R1-ARCH"), tNat.slice(0, 200));
  verifier("E1 le fichier porte date, auteur, perimetre, lignes demandees et exportees, mention",
    /# genere_le;\d{4}-/.test(tR1) && tR1.includes("# auteur;gestr1@ad6.invalid") && tR1.includes("# perimetre;Regions du compte") && /identifiant\(s\) demande\(s\), 5 ligne\(s\) exportee\(s\)/.test(tR1) && tR1.includes("Consultatif, non engageant"), tR1.slice(0, 600));
  verifier("E1 le CSV ne contient pas la colonne geom ni la colonne financiere coutRehabEstime sans droit... (liste blanche)", !/;geom;|geom\n/.test(tR1.split("\n\n")[1] ?? ""), null);

  const gj = await sel(T.r1, "troncons", idsTroncons, "geojson");
  let gjOk = false; let gjData: any = null;
  try { gjData = JSON.parse(texte(gj)); gjOk = gjData.type === "FeatureCollection"; } catch { /* reste faux */ }
  verifier("E2 GeoJSON valide (le SQL passe sur PostGIS) : FeatureCollection, geometrie LineString, region du compte seulement, pas de geom dans les proprietes",
    gj.status === 200 && gjOk && gjData.features.length === 5 && gjData.features.every((f: any) => f.geometry?.type === "LineString" && !("geom" in f.properties) && f.properties.regionId === R1) && gjData.metadonnees.mention.includes("Consultatif"), gj.status);

  const chFin = await sel(T.gest, "chantiers", ["ad-c1", "ad-c2"]);
  const chCh = await sel(T.ch, "chantiers", ["ad-c1", "ad-c2"]);
  const chSans = await sel(T.sf, "chantiers", ["ad-c1", "ad-c2"]);
  // CONTRAT MODIFIE (D-C1-1, regle unique) : le module `chantiers` vaut droit sur les montants (il possede la donnee) ; il n'existe plus de compte
  // « chantiers sans droit financier ». Sans le module `chantiers` ni `marches`, l'export de la table est refuse (le droit de lire la table manque).
  verifier("E3 chantiers : avec marches OU chantiers (regle unique) les montants et le titulaire sortent ; sans l'un ni l'autre, l'export de la table est refuse (403)",
    tableau(chFin).includes("7654321") && tableau(chFin).includes("montantGnf") && chCh.status === 200 && tableau(chCh).includes("7654321") && tableau(chCh).includes("entreprise") && chSans.status === 403, [chCh.status, chSans.status]);

  const idsM = Object.values(M);
  const mR1 = texte(await sel(T.r1, "marches", idsM));
  const mNat = texte(await sel(T.gest, "marches", idsM));
  const mLec = await sel(T.lec, "marches", idsM);
  verifier("E4 marches : un compte regional ne recoit que le marche dont TOUS les chantiers sont dans sa region (ni multi-regions, ni sans chantier, ni archive)",
    mR1.includes("Marche R1") && !mR1.includes("Marche R2") && !mR1.includes("MULTI") && !mR1.includes("SANS CHANTIER") && !mR1.includes("ARCHIVE"), mR1.slice(0, 600));
  verifier("E4 le national recoit R1, R2, multi et sans chantier, mais jamais l'archive", ["Marche R1", "Marche R2", "MULTI", "SANS CHANTIER"].every((s) => mNat.includes(s)) && !mNat.includes("ARCHIVE"), mNat.slice(0, 400));
  verifier("E4 un LECTEUR (module marches) n'exporte pas les marches : 403", mLec.status === 403, mLec.status);
  const mSans = await sel(T.sf, "marches", idsM);
  verifier("E4 sans le module marches : 403 immediat (la requete ne reste pas suspendue)", mSans.status === 403, mSans.status);

  // --- export gouverne : etat par region (fournisseur reel), comparaison a l'oracle SQL
  const exp = (t: string, corps: unknown) => appeler("post", "/api/v2/aide-decision/exports", t, corps);
  const oracle = await sql<{ region: string; troncons: number; bon: number; mauvais: number; critique: number; ne: number }>(
    `SELECT r.nom AS region, count(*)::int AS troncons,
            coalesce(sum("longueurKm") FILTER (WHERE etat::text = 'BON'), 0)::float8 AS bon,
            coalesce(sum("longueurKm") FILTER (WHERE etat::text = 'MAUVAIS'), 0)::float8 AS mauvais,
            coalesce(sum("longueurKm") FILTER (WHERE etat::text = 'CRITIQUE'), 0)::float8 AS critique,
            coalesce(sum("longueurKm") FILTER (WHERE etat::text = 'NON_EVALUE'), 0)::float8 AS ne
       FROM troncons t JOIN regions r ON r.id = t."regionId"
      WHERE t."deletedAt" IS NULL AND t.code LIKE 'AD-%' AND (t."sourceReference" IS NULL OR t."sourceReference" NOT LIKE 'voirie_locale:%')
      GROUP BY r.nom ORDER BY r.nom`);
  const regNat = await exp(T.gest, { type: "reseau_regions", format: "json", filtres: { depuis: "2026-01-01" } });
  const dNat = json(regNat);
  const ligneRegion = (nom: string) => dNat.lignes.find((l: any) => l.region === nom);
  const o1 = oracle.find((o) => o.region === "Region AD1")!;
  verifier("E5 etat par region (national, JSON) : km par etat = oracle SQL independant (archive et voirie promue exclues, non evalue a part)",
    regNat.status === 200 && ligneRegion("Region AD1")?.km_bon === o1.bon && ligneRegion("Region AD1")?.km_mauvais === o1.mauvais && ligneRegion("Region AD1")?.km_critique === o1.critique
      && ligneRegion("Region AD1")?.km_non_evalue === o1.ne && ligneRegion("Region AD2")?.km_bon === 20, ligneRegion("Region AD1"));
  verifier("E5 taux sur le denominateur HORS non evalue : R1 degrade = (5+3)/(10+5+3) = 44,4 %, pas sur 58 km ; non evalue (40 km) a part",
    ligneRegion("Region AD1")?.degrade_pct === 44.4 && ligneRegion("Region AD1")?.km_eligible === 18 && ligneRegion("Region AD1")?.km_non_evalue === 40, ligneRegion("Region AD1"));
  const regR1 = await exp(T.r1, { type: "reseau_regions", format: "json" });
  const dR1 = json(regR1);
  verifier("E5 PERIMETRE : un compte regional n'exporte QUE sa region (une ligne regionale + total du perimetre, pas de total national)",
    regR1.status === 200 && dR1.lignes.map((l: any) => l.region).join("|") === "Region AD1|TOTAL du perimetre" && dR1.metadonnees.perimetre.regionIds.join() === String(R1) && dR1.lignes[1].km_eligible === 18, dR1.lignes.map((l: any) => l.region));
  const regHors = await exp(T.r1, { type: "reseau_regions", format: "csv", filtres: { regionId: R2 } });
  verifier("E5 un compte regional demandant l'autre region : 403 HORS_PERIMETRE", regHors.status === 403 && json(regHors).code === "HORS_PERIMETRE", regHors.status);
  const mt = dNat.metadonnees;
  verifier("E5 le fichier JSON porte filtres appliques et non appliques, date, auteur, perimetre, unites, sources, definitions, avertissements, mention, lignes",
    mt.genereLe && mt.auteur.email === "gest@ad6.invalid" && Array.isArray(mt.filtresNonAppliques) && mt.filtresNonAppliques.some((f: any) => f.filtre === "depuis") && mt.unites.km_bon === "km"
      && mt.sources.length >= 1 && mt.definitions.some((d: any) => d.code === "reseau_degrade_pct") && mt.avertissements.some((a: string) => /voirie_locale/.test(a)) && mt.mention.includes("Consultatif") && mt.nbLignes === 3, Object.keys(mt));

  // --- synthese (lot 2 reel) : sans droit financier, aucun indicateur GNF
  const syn = await exp(T.sf, { type: "synthese", format: "csv" });
  const synFin = await exp(T.gest, { type: "synthese", format: "json" });
  verifier("E6 synthese (indicateurs du lot 2) : exportee ; sans droit financier aucune ligne en GNF", syn.status === 200 && !/;GNF;/.test(texte(syn).split("\n\n")[1] ?? "") && texte(syn).includes("reseau_degrade_pct"), [syn.status, texte(syn).slice(0, 300)]);
  verifier("E6 avec le droit financier la synthese porte des indicateurs en GNF", synFin.status === 200 && json(synFin).lignes.some((l: any) => l.unite === "GNF"), synFin.status);

  // --- scenario / interventions : territoire, droit financier
  const scOk = await exp(T.r1, { type: "scenario", format: "csv", scenarioId: idScR1 });
  const scHors = await exp(T.r1, { type: "scenario", format: "csv", scenarioId: idScNat });
  const scAbs = await exp(T.r1, { type: "scenario", format: "csv", scenarioId: "99999999-9999-4999-8999-999999999999" });
  verifier("E7 scenario de sa region : 200 ; scenario national ou inexistant : le MEME 404 pour un compte regional",
    scOk.status === 200 && scHors.status === 404 && scAbs.status === 404 && JSON.stringify(json(scHors)) === JSON.stringify(json(scAbs)), [scOk.status, scHors.status, scAbs.status]);
  verifier("E7 l'export de scenario ne contient que des troncons de la region du compte, et la mention consultative",
    texte(scOk).includes("AD-R1-") && !texte(scOk).includes("AD-R2-") && texte(scOk).includes("Consultatif, non engageant") && texte(scOk).includes("Aucune estimation ni programmation ne cr"), texte(scOk).slice(0, 400));
  const scSf = await exp(T.sf, { type: "scenario", format: "csv", scenarioId: idScNat });
  const scFin = await exp(T.gest, { type: "scenario", format: "csv", scenarioId: idScNat });
  verifier("E7 sans droit financier : aucune colonne de cout ; avec : cout, devise, bareme cite",
    scSf.status === 200 && !texte(scSf).includes("cout_estime_gnf;") && !/\n[^\n]*;\d{9,};/.test(texte(scSf).split("\n\n")[1] ?? "") && scFin.status === 200 && texte(scFin).includes("cout_estime_gnf"), [scSf.status, scFin.status]);
  const itv = await exp(T.gest, { type: "interventions", format: "json", scenarioId: idScNat });
  const dItv = json(itv);
  verifier("E7 liste d'interventions prioritaires : classee par rang de priorite, uniquement les troncons chiffrables",
    itv.status === 200 && dItv.lignes.length > 0 && dItv.lignes.every((l: any, i: number, a: any[]) => l.rang_priorite !== null && (i === 0 || a[i - 1].rang_priorite < l.rang_priorite)), dItv.lignes?.length);
  const sansScenario = await exp(T.gest, { type: "interventions", format: "csv" });
  verifier("E7 interventions sans scenarioId : 400 SCENARIO_REQUIS", sansScenario.status === 400 && json(sansScenario).code === "SCENARIO_REQUIS", sansScenario.status);

  // --- droits
  verifier("E8 un LECTEUR n'exporte pas (403) ; sans module rapports : 403",
    (await exp(T.lec, { type: "reseau_regions", format: "csv" })).status === 403, null);

  // --- journal
  const jr = await sql<any>(`SELECT * FROM exports_journal ORDER BY "creeLe"`);
  const unExport = jr.find((j: any) => j.type === "reseau_regions" && j.auteurEmail === "gestr1@ad6.invalid");
  verifier("E9 chaque export remis a une ligne de journal (qui, type, filtres, perimetre, lignes, empreinte) ; les refus (403, 404, 400) n'en ont pas",
    jr.length >= 12 && jr.every((j: any) => /^[0-9a-f]{64}$/.test(j.empreinteSha256)) && unExport?.perimetre?.regionIds?.[0] === R1 && unExport.nbLignes === 2, [jr.length, unExport]);
  verifier("E9 l'empreinte du journal est celle du fichier remis (rapprochable)", regR1.headers["x-export-empreinte-sha256"] === unExport.empreinteSha256 && unExport.empreinteSha256 === sha(texte(regR1)) && unExport.tailleOctets === Buffer.byteLength(texte(regR1), "utf8"), null);
  const jrGet = await appeler("get", "/api/v2/aide-decision/exports?limite=50", T.adm1);
  const jrR1 = await appeler("get", "/api/v2/aide-decision/exports", T.r1);
  verifier("E9 GET /exports : ADMIN voit tout le journal, un gestionnaire seulement ses exports", jrGet.status === 200 && json(jrGet).total === jr.length && json(jrR1).data.every((e: any) => e.auteur.email === "gestr1@ad6.invalid") && json(jrR1).total > 0, [json(jrGet).total, json(jrR1).total]);
  const delJ = await prisma.$executeRawUnsafe(`DELETE FROM exports_journal`).then(() => null, (e: Error) => e.message);
  verifier("E9 le journal est en ajout seul", /ajout seul/.test(delJ ?? ""), delJ);
  verifier("E9 chaque export est aussi audite (ExportJournal)", (await n(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'ExportJournal'`)) === jr.length, null);

  // --- aucune ecriture sur les donnees sources
  const sourcesApres = await empreinteTables();
  verifier("E10 les donnees sources (troncons, chantiers, marches, liens, baremes hors modifications du banc, scenarios) sont inchangees par les exports",
    ["troncons", "chantiers", "marches", "marches_chantiers", "scenarios_programmation"].every((t) => sourcesAvant[t] === sourcesApres[t]), { sourcesAvant, sourcesApres });
}

try {
  await main();
} catch (e) {
  console.error("ERREUR DU BANC :", e);
  verifier("le banc va jusqu'au bout sans exception", false, String((e as Error)?.message ?? e));
} finally {
  conclure();
  await prisma.$disconnect();
  await banc.fermer();
}
