// Banc d'integration SECURITE / DROITS / AUDIT du module Aide a la decision (lot AD-7). Voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/aide-decision-securite.integration.mts
//
// CE QUE LE BANC FAIT PASSER PAR LE CODE REEL : l'application ENTIERE (`createApp()`), des jetons signes par des secrets
// aleatoires tires a chaque lancement, les modules, le role et le perimetre territorial LUS EN BASE a chaque requete, l'audit
// transactionnel, le moteur de programmation et PostGIS, dans un CLONE jetable de `replay` (`essai_ad_l7_securite`), cree puis
// detruit par le banc. `replay` n'est jamais ecrite. Chaque verification relit la BASE, pas seulement la reponse HTTP.
//
// CE QUE LE BANC PROUVE
//   A. SEPARATION DES TACHES, de bout en bout : un ADMIN ne peut pas approuver la version de poids qu'il a creee (403
//      AUTO_VALIDATION, la base reste non approuvee, aucun audit VALIDATE) mais un autre ADMIN le peut ; l'audit garde les
//      VALEURS avant/apres ;
//   B. un seul compte ne peut pas figer un scenario puis faire avancer sa fiche jusqu'a APPROUVE ; un autre le peut ; la
//      simulation, les fiches et leur cycle de vie ne modifient AUCUNE table source (empreintes md5 identiques : AD-08) ;
//   C. un seul compte ne peut pas saisir une prevision puis la retenir ; un autre le peut ;
//   D. l'audit ecrit est LISIBLE (parametres, scenario, fiche, prevision, bareme) par les seuls comptes qui ont le module ;
//   E. un compte REGIONAL ne recoit aucun total national : routes heritees refusees ou filtrees, montants de la region voisine
//      absents de TOUTES les reponses ; un compte national garde le comportement actuel ;
//   F. D-C1-1 : un LECTEUR sans module lit la carte des chantiers mais pas les montants, le bailleur, le contrat, l'entreprise ;
//   G. fiche-360 : un troncon d'une autre region est INTROUVABLE (404 identique a un inconnu), plus 403 ;
//   H. entrees invalides : 400 net.
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

// server.ts pose ce correctif au demarrage (les montants BigInt sortent en chaine) ; createApp() ne le porte pas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_ad_l7_securite", { migrations: ["20261023100000_moteur_programmation"] });
// Le plafond de debit de /api/v2 compterait les centaines d'appels du banc : il est desactive (0), comme le permet l'env.
process.env.RATE_LIMIT_V2_MAX = "0";
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const { parseImportBuffer } = await banc.imp("lib/excel");
const request = (await import("supertest")).default;
const app = createApp();

const sql = async <T = Record<string, unknown>>(texte: string, ...params: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...params);
const compter = async (texte: string, ...params: unknown[]): Promise<number> => Number((await sql<{ n: bigint }>(texte, ...params))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });

/** Telecharge l'export des chantiers (xlsx) et rend ses lignes lues par le meme lecteur que l'import. */
async function exportChantiers(token: string): Promise<{ status: number; lignes: Record<string, unknown>[] }> {
  const rep = await request(app).get("/api/chantiers/export").set("Authorization", `Bearer ${token}`)
    .buffer(true).parse((res: any, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
  return { status: rep.status, lignes: rep.status === 200 ? await parseImportBuffer(rep.body as Buffer) : [] };
}

type Verbe = "get" | "post" | "patch";
type Rep = { status: number; body: any; text: string };
const appeler = async (verbe: Verbe, url: string, token: string, corps?: unknown): Promise<Rep> => {
  const r = request(app)[verbe](url).set("Authorization", `Bearer ${token}`);
  const rep = await (corps === undefined ? r : r.send(corps as object));
  return { status: rep.status, body: rep.body, text: rep.text ?? "" };
};

async function main() {
  // ---------------------------------------------------------------- Fixtures : regions, comptes, perimetre
  await sql(`INSERT INTO regions (nom) VALUES ('AD7 Region 1'), ('AD7 Region 2')`);
  const regionId = async (nom: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, nom))[0].id);
  const [R1, R2] = [await regionId("AD7 Region 1"), await regionId("AD7 Region 2")];

  const TOUS = ["dashboard", "geoportail", "alertes", "rapports", "troncons", "ouvrages", "points-noirs", "postes", "chantiers", "programmation", "marches", "inspections", "documents", "decision", "ordres-travaux", "signalements"];
  const mkUser = (email: string, role: string, modulesAutorises: string[]) =>
    prisma.user.create({ data: { email, nomComplet: email, passwordHash: "x", role, modulesAutorises } });
  const admin = await mkUser("admin1@ad7.invalid", "ADMIN", []);
  const admin2 = await mkUser("admin2@ad7.invalid", "ADMIN", []);
  const gest = await mkUser("gest1@ad7.invalid", "GESTIONNAIRE", TOUS);      // national
  const gest2 = await mkUser("gest2@ad7.invalid", "GESTIONNAIRE", TOUS);     // national
  const gestR1 = await mkUser("gestr1@ad7.invalid", "GESTIONNAIRE", TOUS);   // region 1 seulement
  const lectSans = await mkUser("lectsans@ad7.invalid", "LECTEUR", []);
  const lectProg = await mkUser("lectprog@ad7.invalid", "LECTEUR", ["programmation"]);
  const lectDec = await mkUser("lectdec@ad7.invalid", "LECTEUR", ["decision"]);
  const lectCh = await mkUser("lectch@ad7.invalid", "LECTEUR", ["chantiers"]);
  const T = {
    admin: jeton(admin), admin2: jeton(admin2), gest: jeton(gest), gest2: jeton(gest2), r1: jeton(gestR1),
    sans: jeton(lectSans), prog: jeton(lectProg), dec: jeton(lectDec), ch: jeton(lectCh),
  };
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, gestR1.id, R1, admin.id);

  // Troncons avec geometrie (chiffrables), un en region 2. Baremes approuves dans le CLONE pour que le scenario retienne des lignes.
  const troncon = (code: string, rid: number, o: { etat: string; jma: number; km: number; lat: number }) =>
    sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", "traficMoyenJma", geom, "updatedAt")
         VALUES ($1, $2, $3, 'RN', $4, $5, 'BITUME'::"Revetement", $6::"EtatPatrimoine", 0, $5, $7, ST_GeomFromText($8, 4326), now())`,
      `t-${code}`, code, `Troncon ${code}`, rid, o.km, o.etat, o.jma, `LINESTRING(-13.6 ${o.lat}, -13.58 ${o.lat})`);
  await troncon("AD7-A", R1, { etat: "CRITIQUE", jma: 3000, km: 10, lat: 9.6 });
  await troncon("AD7-B", R1, { etat: "MAUVAIS", jma: 1500, km: 6, lat: 9.7 });
  await troncon("AD7-C", R2, { etat: "CRITIQUE", jma: 2500, km: 8, lat: 10.4 });
  // Le moteur exige au moins `facteursMinimum` facteurs : etat, trafic et points noirs (securite). Sans point noir, aucune ligne n'est chiffrable.
  for (const [code, n] of [["AD7-A", 2], ["AD7-B", 1], ["AD7-C", 2]] as const) {
    for (let i = 0; i < n; i++) {
      await sql(`INSERT INTO points_noirs (id, description, "regionId", "tronconId", gravite, "updatedAt")
                 VALUES (gen_random_uuid()::text, 'pn essai', (SELECT "regionId" FROM troncons WHERE code = $1), (SELECT id FROM troncons WHERE code = $1), 'FORTE'::"Gravite", now())`, code);
    }
  }
  await sql(`UPDATE baremes_intervention SET "anneeReference" = 2026, "largeurChausseeM" = 6, "approuveLe" = now(), "approuveParId" = $1`, admin.id);

  // Chantiers : un par region AVEC montant, bailleur, contrat, entreprise ; un sans localisation par region.
  const MONTANT_R1 = 1_000n, MONTANT_R2 = 987_654_321n;
  const chantier = async (intitule: string, rid: number, montant: bigint, geom: boolean) => {
    const c = await prisma.chantier.create({ data: { intitule, entreprise: `Entreprise ${intitule}`, bailleur: `Bailleur ${intitule}`, montantGnf: montant, numContrat: `NC-${intitule}`, regionId: rid, statut: "EN_COURS", dateDebutPrevue: new Date("2027-03-01") } });
    if (geom) await sql(`UPDATE chantiers SET geom = ST_GeomFromText('LINESTRING(-13.6 9.6, -13.5 9.65)', 4326) WHERE id = $1`, c.id);
    return c;
  };
  const c1 = await chantier("CH-R1", R1, MONTANT_R1, true);
  const c2 = await chantier("CH-R2", R2, MONTANT_R2, true);
  const c3 = await chantier("CH-R1-SANS", R1, MONTANT_R1, false);
  const c4 = await chantier("CH-R2-SANS", R2, MONTANT_R2, false);

  const EMPREINTE_TABLES = ["programmes_budgetaires", "marches", "decomptes", "chantiers", "baremes_intervention", "bailleurs", "troncons"];
  const empreintes = async () => {
    const o: Record<string, string> = {};
    for (const t of EMPREINTE_TABLES) {
      const r = await sql<{ n: string; h: string }>(`SELECT count(*)::text AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x`);
      o[t] = `${r[0].n}:${r[0].h}`;
    }
    return o;
  };
  const auditDe = (type: string, id: string) => sql<{ action: string; before: any; after: any }>(`SELECT action, before, after FROM audit_logs WHERE "entityType" = $1 AND "entityId" = $2 ORDER BY "createdAt", id`, type, id);

  // ================================================================ A. Poids : separation auteur / approbateur
  console.log("\n== A. Poids de priorisation : l'auteur n'approuve pas ==");
  const liste = await appeler("get", "/api/v2/programmation/moteur/parametres", T.admin);
  const valeursBase = liste.body.data[0].valeurs;
  const creation = await appeler("post", "/api/v2/programmation/moteur/parametres", T.admin, { version: "ad7-poids-1", valeurs: valeursBase, motif: "essai separation des taches" });
  verifier("un ADMIN cree une version de poids (201)", creation.status === 201 && creation.body.creeParId === admin.id, [creation.status, creation.body]);
  const pid = creation.body.id as string;
  const auto = await appeler("post", `/api/v2/programmation/moteur/parametres/${pid}/approuver`, T.admin);
  const ligneP = (await sql<{ approuveeLe: Date | null; approuveeParId: string | null }>(`SELECT "approuveeLe", "approuveeParId" FROM parametres_programmation WHERE id = $1`, pid))[0];
  verifier("le MEME ADMIN ne peut pas l'approuver : 403 AUTO_VALIDATION", auto.status === 403 && auto.body.code === "AUTO_VALIDATION", [auto.status, auto.body]);
  verifier("la base reste NON approuvee (relue) et aucun audit VALIDATE n'existe", ligneP.approuveeLe === null && ligneP.approuveeParId === null && (await auditDe("ParametresProgrammation", pid)).every((a) => a.action !== "VALIDATE"), ligneP);
  const autre = await appeler("post", `/api/v2/programmation/moteur/parametres/${pid}/approuver`, T.admin2);
  const ligneP2 = (await sql<{ approuveeParId: string | null }>(`SELECT "approuveeParId" FROM parametres_programmation WHERE id = $1`, pid))[0];
  verifier("un AUTRE ADMIN l'approuve (200) et la base le dit", autre.status === 200 && ligneP2.approuveeParId === admin2.id, [autre.status, ligneP2]);
  const gestApprouve = await appeler("post", `/api/v2/programmation/moteur/parametres/${pid}/approuver`, T.gest);
  verifier("un GESTIONNAIRE ne peut toujours pas approuver (403 de role, pas de regression)", gestApprouve.status === 403, gestApprouve.status);
  const auditP = await auditDe("ParametresProgrammation", pid);
  const creeAudit = auditP.find((a) => a.action === "CREATE");
  const valideAudit = auditP.find((a) => a.action === "VALIDATE");
  verifier("l'audit CREATE contient les VALEURS (poids) de la version", !!creeAudit?.after?.valeurs?.poidsRisque, creeAudit);
  verifier("l'audit VALIDATE contient les valeurs AVANT et APRES (identiques : une version est immuable)", !!valideAudit?.before?.valeurs?.poidsRisque && JSON.stringify(valideAudit.before.valeurs) === JSON.stringify(valideAudit.after.valeurs), valideAudit);

  // ================================================================ B. Scenario et fiches
  console.log("\n== B. Scenario, fiche d'intervention : l'auteur n'approuve pas ; aucune donnee source n'est modifiee ==");
  const avant = await empreintes();
  const sim = await appeler("post", "/api/v2/programmation/moteur/simulations", T.gest, { annee: 2027, intitule: "Essai AD-7", budgetGnf: "500000000000", regionId: R1, parametresId: pid });
  verifier("le gestionnaire calcule un scenario sur sa region (201) avec des lignes retenues", sim.status === 201 && sim.body.scenario.nbRetenues > 0, [sim.status, sim.body?.scenario ?? sim.body]);
  const sid = sim.body.scenario.id as string;
  const fig = await appeler("post", `/api/v2/programmation/moteur/simulations/${sid}/fiches`, T.gest, {});
  verifier("il fige les fiches (201)", fig.status === 201 && fig.body.fiches.length > 0, [fig.status, fig.body]);
  const fid = fig.body.fiches[0].id as string;
  const statut = async (id: string) => (await sql<{ vers: string }>(`SELECT vers FROM fiches_intervention_statuts WHERE "ficheId" = $1 ORDER BY rang DESC LIMIT 1`, id))[0].vers;
  const p1 = await appeler("post", `/api/v2/programmation/moteur/fiches/${fid}/statut`, T.gest, { vers: "PROPOSE" });
  const p2 = await appeler("post", `/api/v2/programmation/moteur/fiches/${fid}/statut`, T.gest, { vers: "ARBITRE" });
  verifier("le meme compte peut proposer et arbitrer (ce ne sont pas des approbations)", p1.status === 201 && p2.status === 201 && (await statut(fid)) === "ARBITRE", [p1.status, p2.status]);
  const appAuto = await appeler("post", `/api/v2/programmation/moteur/fiches/${fid}/statut`, T.gest, { vers: "APPROUVE" });
  verifier("le MEME compte ne peut pas approuver la fiche qu'il a figee : 403 AUTO_VALIDATION, statut relu = ARBITRE", appAuto.status === 403 && appAuto.body.code === "AUTO_VALIDATION" && (await statut(fid)) === "ARBITRE", [appAuto.status, appAuto.body]);
  const appAdminAuteur = await appeler("post", `/api/v2/programmation/moteur/fiches/${fid}/statut`, T.admin, { vers: "APPROUVE" });
  verifier("un ADMIN etranger a la chaine l'approuve : le role le plus eleve n'est pas un motif de refus quand il n'est pas l'auteur", appAdminAuteur.status === 201 && (await statut(fid)) === "APPROUVE", [appAdminAuteur.status, appAdminAuteur.body]);
  const apres = await empreintes();
  for (const t of EMPREINTE_TABLES) verifier(`AD-08 : ${t} identique avant/apres simulation, figeage et cycle de vie (${avant[t].split(":")[0]} lignes)`, avant[t] === apres[t], [avant[t], apres[t]]);
  const statutTransmis = await appeler("post", `/api/v2/programmation/moteur/fiches/${fid}/statut`, T.gest2, { vers: "TRANSMIS" });
  verifier("TRANSMIS reste refuse depuis le Geoportail (403 ORIGINE_INTERDITE) : la separation n'ouvre pas la frontiere DigitalRoad", statutTransmis.status === 403 && statutTransmis.body.code === "ORIGINE_INTERDITE", [statutTransmis.status, statutTransmis.body]);

  // ================================================================ C. Previsions : saisir n'est pas retenir
  console.log("\n== C. Previsions budgetaires : l'auteur ne retient pas sa propre saisie ==");
  const prev = await appeler("post", "/api/v2/programmation", T.gest, { annee: 2027, intitule: "Prevision essai AD-7", montantPrevuGnf: "1500000000", tronconId: "t-AD7-A" });
  verifier("saisie d'une prevision (201, statut PROPOSE)", prev.status === 201 && prev.body.statut === "PROPOSE", [prev.status, prev.body]);
  const prid = prev.body.id as string;
  const statutPrev = async () => (await sql<{ statut: string }>(`SELECT statut::text AS statut FROM programmes_budgetaires WHERE id = $1::uuid`, prid))[0].statut;
  const retenirAuto = await appeler("patch", `/api/v2/programmation/${prid}`, T.gest, { statut: "RETENU" });
  verifier("l'auteur ne peut pas la passer a RETENU : 403 AUTO_VALIDATION, statut relu = PROPOSE", retenirAuto.status === 403 && retenirAuto.body.code === "AUTO_VALIDATION" && (await statutPrev()) === "PROPOSE", [retenirAuto.status, retenirAuto.body]);
  const corriger = await appeler("patch", `/api/v2/programmation/${prid}`, T.gest, { montantPrevuGnf: "1600000000" });
  verifier("l'auteur corrige encore sa proposition (montant) : 200", corriger.status === 200, corriger.status);
  const retenirAutre = await appeler("patch", `/api/v2/programmation/${prid}`, T.gest2, { statut: "RETENU" });
  verifier("un autre compte la retient (200), statut relu = RETENU", retenirAutre.status === 200 && (await statutPrev()) === "RETENU", [retenirAutre.status, retenirAutre.body]);
  const auditPrev = await auditDe("ProgrammeBudgetaire", prid);
  verifier("l'audit de la prevision garde la creation et l'arbitrage (avant/apres)", auditPrev.some((a) => a.action === "CREATE") && auditPrev.some((a) => a.action === "UPDATE" && a.after?.statut === "RETENU" && a.before?.statut === "PROPOSE"), auditPrev);

  // ================================================================ D. Audit lisible, par module
  console.log("\n== D. Historique : lisible par les seuls comptes qui ont le module ==");
  const lecture = (type: string, id: string, token: string) => appeler("get", `/api/audit?entityType=${type}&entityId=${id}`, token);
  const bareme = (await sql<{ id: number }>(`SELECT id FROM baremes_intervention ORDER BY id LIMIT 1`))[0].id;
  // L'audit du bareme est ECRIT par la vraie route (modification d'un champ descriptif). Si cette route est en cours de refonte
  // (lot 6) et refuse, on insere la ligne d'audit directement et on le dit : la lecture de l'audit, elle, reste eprouvee.
  const patchBareme = await appeler("patch", `/api/v2/baremes/${bareme}`, T.gest, { commentaire: "essai audit AD-7" });
  if (patchBareme.status !== 200) {
    console.log(`  note : PATCH bareme -> ${patchBareme.status} ; ligne d'audit inseree directement pour eprouver la LECTURE`);
    await sql(`INSERT INTO audit_logs (id, "userId", action, "entityType", "entityId", after) VALUES (gen_random_uuid()::text, $1, 'UPDATE'::"AuditAction", 'BaremeIntervention', $2, '{"essai":true}'::jsonb)`, admin.id, String(bareme));
  }
  const CAS: [string, string, "programmation" | "decision"][] = [
    ["ParametresProgrammation", pid, "programmation"], ["ScenarioProgrammation", sid, "programmation"],
    ["FicheIntervention", fid, "programmation"], ["ProgrammeBudgetaire", prid, "programmation"], ["BaremeIntervention", String(bareme), "decision"],
  ];
  for (const [type, id, mod] of CAS) {
    const adm = await lecture(type, id, T.admin);
    const avecModule = await lecture(type, id, mod === "programmation" ? T.prog : T.dec);
    const sansModule = await lecture(type, id, T.sans);
    const mauvaisModule = await lecture(type, id, mod === "programmation" ? T.dec : T.prog);
    verifier(`audit ${type} : ADMIN lit (200, au moins une ligne ECRITE), module ${mod} lit, LECTEUR sans module et module voisin refuses (403)`,
      adm.status === 200 && adm.body.total >= 1 && avecModule.status === 200 && avecModule.body.total === adm.body.total && sansModule.status === 403 && mauvaisModule.status === 403,
      [adm.status, adm.body.total, avecModule.status, sansModule.status, mauvaisModule.status]);
  }

  // ================================================================ E. Compte regional : aucun total national
  console.log("\n== E. Compte regional : aucun total national ==");
  const reponsesRegional: Rep[] = [];
  const reg = async (url: string) => { const r = await appeler("get", url, T.r1); reponsesRegional.push(r); return r; };
  for (const url of ["/api/dashboard/decision", "/api/dashboard/programmation", "/api/dashboard/tendances"]) {
    const nat = await appeler("get", url, T.gest);
    const r = await reg(url);
    verifier(`${url} : refuse au compte regional (403 PERIMETRE_NATIONAL_REQUIS), inchange pour le compte national (200)`, r.status === 403 && r.body.code === "PERIMETRE_NATIONAL_REQUIS" && nat.status === 200, [r.status, r.body, nat.status]);
  }
  const lignesReg = await reg("/api/dashboard/programmation/lignes?pageSize=100");
  const lignesNat = await appeler("get", "/api/dashboard/programmation/lignes?pageSize=100", T.gest);
  verifier("programmation/lignes : le compte regional ne voit que les chantiers de sa region ; le national voit les deux",
    lignesReg.status === 200 && lignesReg.body.data.length === 2 && lignesReg.body.data.every((l: any) => l.region === "AD7 Region 1") && lignesNat.body.data.length === 4, [lignesReg.body.data?.length, lignesNat.body.data?.length]);
  const rapReg = await reg("/api/dashboard/rapport-regions");
  const rapNat = await appeler("get", "/api/dashboard/rapport-regions", T.gest);
  verifier("rapport-regions : le compte regional ne recoit que sa region ; le national recoit les deux", rapReg.status === 200 && rapReg.body.every((l: any) => l.region === "AD7 Region 1") && rapNat.body.some((l: any) => l.region === "AD7 Region 2"), [rapReg.body, rapNat.body.map((l: any) => l.region)]);
  const scReg = await reg("/api/priorisation/scores?limit=500");
  const scReg2 = await reg(`/api/priorisation/scores?region=${encodeURIComponent("AD7 Region 2")}`);
  const scNat = await appeler("get", "/api/priorisation/scores?limit=500", T.gest);
  const codes = (r: Rep) => (r.body.resultats ?? []).map((x: any) => x.code).filter((c: string) => c.startsWith("AD7-")).sort();
  verifier("priorisation/scores : le compte regional ne voit que ses troncons, meme en demandant la region voisine ; le national voit tout",
    JSON.stringify(codes(scReg)) === JSON.stringify(["AD7-A", "AD7-B"]) && codes(scReg2).length === 0 && JSON.stringify(codes(scNat)) === JSON.stringify(["AD7-A", "AD7-B", "AD7-C"]), [codes(scReg), codes(scReg2), codes(scNat)]);
  const geoReg = await reg("/api/chantiers/geo");
  const geoNat = await appeler("get", "/api/chantiers/geo", T.gest);
  verifier("chantiers/geo : region 1 seulement pour le compte regional ; les deux pour le national", geoReg.status === 200 && geoReg.body.map((c: any) => c.id).join() === c1.id && geoNat.body.length === 2, [geoReg.body?.length, geoNat.body?.length]);
  const sansLocReg = await reg("/api/chantiers/sans-localisation");
  const sansLocNat = await appeler("get", "/api/chantiers/sans-localisation", T.gest);
  verifier("chantiers/sans-localisation : filtre de region identique", sansLocReg.body.map((c: any) => c.id).join() === c3.id && sansLocNat.body.length === 2, [sansLocReg.body, sansLocNat.body?.length]);
  const listeReg = await reg("/api/chantiers?pageSize=100");
  const statsReg = await reg("/api/chantiers/stats");
  const statsNat = await appeler("get", "/api/chantiers/stats", T.gest);
  verifier("chantiers (liste) et /stats : le compte regional compte 2 chantiers (les siens), le national 4", listeReg.body.data.length === 2 && statsReg.body.total === 2 && statsNat.body.total === 4, [listeReg.body.data?.length, statsReg.body, statsNat.body]);
  const expReg = await exportChantiers(T.r1);
  const expNat = await exportChantiers(T.gest);
  verifier("chantiers/export : le fichier du gestionnaire regional ne contient que les 2 chantiers de sa region ; celui du national, les 4",
    expReg.status === 200 && expReg.lignes.length === 2 && expReg.lignes.every((l) => String(l["Intitulé"]).startsWith("CH-R1")) && expNat.lignes.length === 4, [expReg.status, expReg.lignes.map((l) => l["Intitulé"]), expNat.lignes.length]);
  const autreCh = await reg(`/api/chantiers/${c2.id}`);
  const inconnuCh = await reg("/api/chantiers/inexistant");
  verifier("un chantier d'une autre region est INTROUVABLE (404, meme corps qu'un identifiant inconnu)", autreCh.status === 404 && inconnuCh.status === 404 && JSON.stringify(autreCh.body) === JSON.stringify(inconnuCh.body), [autreCh.status, autreCh.body, inconnuCh.body]);
  const fuite = reponsesRegional.filter((r) => r.text.includes(String(MONTANT_R2)) || r.text.includes("CH-R2") || r.text.includes("Bailleur CH-R2"));
  verifier(`AUCUNE des ${reponsesRegional.length} reponses recues par le compte regional ne contient le montant, l'intitule ni le bailleur du chantier voisin`, fuite.length === 0, fuite.map((r) => r.text.slice(0, 120)));
  verifier("CONTRE-EPREUVE : le compte national, lui, recoit bien le montant de la region 2 (le filtre vient du perimetre, pas des donnees)", lignesNat.text.includes(String(MONTANT_R2)), lignesNat.text.slice(0, 160));

  // ================================================================ F. D-C1-1 : champs financiers des chantiers
  console.log("\n== F. D-C1-1 : champs financiers des chantiers ==");
  const CHAMPS = ["montantGnf", "bailleur", "numContrat", "entreprise"];
  const geoSans = await appeler("get", "/api/chantiers/geo", T.sans);
  verifier("LECTEUR sans aucun module : la carte des chantiers reste lisible (200, 2 chantiers, identite et geometrie)", geoSans.status === 200 && geoSans.body.length === 2 && geoSans.body.every((c: any) => c.intitule && c.geometry), [geoSans.status, geoSans.body?.length]);
  verifier("... mais montant, bailleur, contrat et entreprise valent null pour TOUS", geoSans.body.every((c: any) => CHAMPS.every((k) => c[k] === null)) && !geoSans.text.includes(String(MONTANT_R2)) && !geoSans.text.includes("Bailleur CH-R1"), geoSans.body?.[0]);
  const listeSans = await appeler("get", "/api/chantiers?pageSize=100", T.sans);
  verifier("la liste des chantiers masque les memes champs", listeSans.status === 200 && listeSans.body.data.length === 4 && listeSans.body.data.every((c: any) => CHAMPS.every((k) => c[k] === null)), [listeSans.status, listeSans.body.data?.[0]]);
  const sansLocSans = await appeler("get", "/api/chantiers/sans-localisation", T.sans);
  verifier("la liste sans localisation masque l'entreprise", sansLocSans.status === 200 && sansLocSans.body.every((c: any) => c.entreprise === null), sansLocSans.body);
  const expSans = await appeler("get", "/api/chantiers/export", T.sans);
  verifier("l'export (toutes les colonnes financieres) est refuse sans le module chantiers (403)", expSans.status === 403, expSans.status);
  const geoCh = await appeler("get", "/api/chantiers/geo", T.ch);
  verifier("CONTRE-EPREUVE : le module chantiers voit les montants (1000 et 987654321 en chaine)", geoCh.body.some((c: any) => c.montantGnf === String(MONTANT_R1)) && geoCh.body.some((c: any) => c.montantGnf === String(MONTANT_R2)), geoCh.body.map((c: any) => c.montantGnf));
  const geoAdmin = await appeler("get", "/api/chantiers/geo", T.admin);
  verifier("CONTRE-EPREUVE : ADMIN voit les montants et bailleurs", geoAdmin.body.every((c: any) => c.montantGnf !== null && c.bailleur !== null), geoAdmin.body?.[0]);
  void c4;

  // ================================================================ G. fiche-360 : oracle 403 / 404
  console.log("\n== G. fiche-360 : 404 masque ==");
  for (const volet of ["portions", "programmation", "constats"]) {
    const hors = await appeler("get", `/api/v2/fiche-360/troncons/t-AD7-C/${volet}`, T.r1);
    const inconnu = await appeler("get", `/api/v2/fiche-360/troncons/t-inexistant/${volet}`, T.r1);
    verifier(`fiche-360 ${volet} : troncon d'une autre region = 404 identique a un troncon inconnu`, hors.status === 404 && inconnu.status === 404 && JSON.stringify(hors.body) === JSON.stringify(inconnu.body), [hors.status, hors.body, inconnu.status, inconnu.body]);
  }
  const propre = await appeler("get", "/api/v2/fiche-360/troncons/t-AD7-A/portions", T.r1);
  verifier("fiche-360 : son propre troncon reste lisible (200)", propre.status === 200, propre.status);

  // ================================================================ H. Entrees invalides
  console.log("\n== H. Entrees invalides ==");
  for (const [url, attendu] of [
    ["/api/dashboard/programmation/lignes?annee=abc", 400], ["/api/dashboard/programmation/lignes?annee=99999999999", 400],
    ["/api/dashboard/programmation/lignes?statut=BIZARRE", 400], ["/api/dashboard/tendances?periode_debut=pas-une-date", 400],
    ["/api/dashboard/tendances?periode_fin=2026-13-45", 400], ["/api/dashboard/programmation/lignes?annee=2027", 200], ["/api/dashboard/tendances?periode_debut=2026-01-01", 200],
  ] as const) {
    const r = await appeler("get", url, T.gest);
    verifier(`${url} -> ${attendu}`, r.status === attendu, r.status);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });

