// Banc d'integration : correspondance EDITABLE d'identifiants externes (A23, critere B12). Voir
// tests-integration/README.md et docs/scenarios/A23-A24.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/correspondances.integration.mts
//
// CE QUE LE BANC PROUVE, SUR LES ROUTES REELLES ET UN CLONE POSTGIS JETABLE (il y applique la migration
// 20261026410000 si `replay` ne la porte pas) :
//   - la table est VIDE a l'arrivee : aucune valeur n'est semee, aucune n'est inventee ;
//   - toute correspondance naît « A_CONFIRMER » ; la confirmer est la decision d'une AUTRE personne ; la revue
//     humaine est elle-meme la decision ;
//   - le critere B12 : un export « a la version n » se regenere OCTET POUR OCTET apres que dix correspondances
//     ont change (corrigees, closes, confirmees), alors que l'export de la version courante differe, et ne differe
//     que par ces dix-la ;
//   - la base tient les regles seule (UPDATE, DELETE, score 1 sans identifiant officiel, auto-confirmation, cible
//     inexistante, un identifiant source pointant deux cibles) ;
//   - la serie des versions est SANS TROU, meme sous 12 envois simultanes et apres des refus ;
//   - chaque ecriture est auditee, aucun refus ne l'est.
//
// CE QU'IL NE PROUVE PAS : AUCUNE CORRESPONDANCE REELLE. Les identifiants source du banc sont des jetons de test
// (« BANC-0001 ») sans rapport avec un code de l'ONR, de L2R ou d'ANASUR, qu'aucun fichier du depot ne donne. Le
// banc ne prouve donc ni la forme des identifiants externes, ni l'exactitude d'un rapprochement : la table prouve
// qu'elle sait ne rien perdre et ne rien inventer, pas qu'elle est juste. Aucune interface de saisie n'existe
// (API seulement).
import { createHash } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_corresp", { migrations: ["20261026410000_correspondances_identifiants"] });
const { prisma } = await banc.imp("lib/prisma");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const { correspondancesV2Router } = await banc.imp("api-v2/correspondances.routes");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json());
app.use("/api/v2/correspondances", correspondancesV2Router);
app.use(errorHandler);

const sql = async <T = Record<string, unknown>>(texte: string, ...p: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...p);
const compter = async (texte: string, ...p: unknown[]) => Number((await sql<{ n: bigint }>(texte, ...p))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });
const SYS = "SYSTEME_BANC";

async function main() {
  const mk = (email: string, role: string) => prisma.user.create({ data: { email, nomComplet: email, passwordHash: "x", role } });
  const [proposeur, reviseur, lecteur] = [await mk("proposeur@corr.invalid", "GESTIONNAIRE"), await mk("reviseur@corr.invalid", "GESTIONNAIRE"), await mk("lecteur@corr.invalid", "LECTEUR")];
  const T = { p: jeton(proposeur), r: jeton(reviseur), l: jeton(lecteur) };
  const get = (url: string, t = T.p) => request(app).get(`/api/v2/correspondances${url}`).set("Authorization", `Bearer ${t}`);
  const post = (url: string, corps: unknown, t = T.p) => request(app).post(`/api/v2/correspondances${url}`).set("Authorization", `Bearer ${t}`).send(corps as object);

  await sql(`INSERT INTO regions (nom) VALUES ('Region banc correspondances')`);
  const regionId = Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = 'Region banc correspondances'`))[0].id);
  const troncons: string[] = [];
  for (let i = 0; i < 70; i++) {
    const r = await prisma.troncon.create({ data: { code: `CORR-T${i}`, nom: `Troncon ${i}`, classe: "RR", regionId, longueurKm: 1, revetement: "BITUME", pkDebut: 0, pkFin: 1 } });
    troncons.push(r.id);
  }
  const prop = (i: number, extra: Record<string, unknown> = {}) => ({
    systemeSource: SYS, typeObjet: "TRONCON", identifiantSource: `BANC-${String(i).padStart(4, "0")}`, identifiantCible: troncons[i],
    methode: "CODE_ROUTE_NOMENCLATURE", score: 0.9, valideDu: "2026-01-01", ...extra,
  });

  // ------------------------------------------------------------------ 1. Vide a l'arrivee
  const vide = await get("");
  verifier("la table est VIDE a l'arrivee : aucune correspondance semee, version courante 0",
    vide.status === 200 && vide.body.correspondances.length === 0 && vide.body.versionCourante === 0
    && await compter(`SELECT count(*) n FROM correspondances_identifiants`) === 0 && await compter(`SELECT count(*) n FROM versions_correspondance`) === 0, vide.body);
  const exportVide = await get("/export");
  verifier("l'export de la table vide ne porte que son en-tete (version 0)", exportVide.status === 200 && exportVide.text.startsWith("# versionTable=0\nsysteme_source;") && exportVide.text.trim().split("\n").length === 2, exportVide.text);

  // ------------------------------------------------------------------ 2. Proposer : refus et acceptation
  const lect = await post("", prop(0), T.l);
  verifier("un LECTEUR ne propose pas (403) ; il lit (200)", lect.status === 403 && (await get("", T.l)).status === 200);
  const surUn = await post("", prop(0, { score: 1 }));
  const sansTol = await post("", prop(0, { methode: "GEOMETRIE_CALCULEE", score: 0.7 }));
  const nomSeul = await post("", prop(0, { methode: "NOM_SEUL", score: 0.4 }));
  const cibleInconnue = await post("", prop(0, { identifiantCible: "n-existe-pas" }));
  verifier("refus clairs : score 1 hors identifiant officiel (400 SCORE_UN_RESERVE), geometrie sans tolerances (400), methode « nom seul » (400 METHODE_INCONNUE), cible inexistante (404 CIBLE_INTROUVABLE)",
    surUn.body.code === "SCORE_UN_RESERVE" && sansTol.body.code === "TOLERANCES_REQUISES" && nomSeul.body.code === "METHODE_INCONNUE"
    && cibleInconnue.status === 404 && cibleInconnue.body.code === "CIBLE_INTROUVABLE", [surUn.body, sansTol.body, nomSeul.body, cibleInconnue.body]);
  verifier("aucun refus n'a consomme une version ni laisse de trace : version 0, aucune ligne, aucun audit",
    (await get("/versions")).body.versionCourante === 0 && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'CorrespondanceIdentifiant'`) === 0);

  const p0 = await post("", prop(0));
  verifier("proposition acceptee : 201, A_CONFIRMER, version 1, proposee par ce compte",
    p0.status === 201 && p0.body.ligne.statut === "A_CONFIRMER" && p0.body.version === 1 && p0.body.ligne.proposeParId === proposeur.id && p0.body.ligne.decisionReviseurId === null, p0.body);
  const doublon = await post("", prop(0, { identifiantCible: troncons[1] }));
  verifier("un identifiant source ne pointe qu'UNE cible a la fois : une seconde cible sur la meme periode est refusee (409 SOURCE_DEJA_CORRESPONDUE), sans version consommee",
    doublon.status === 409 && doublon.body.code === "SOURCE_DEJA_CORRESPONDUE" && (await get("/versions")).body.versionCourante === 1, doublon.body);
  const memeCibleAutreSource = await post("", prop(0, { identifiantSource: "BANC-AUTRE-SOURCE" }));
  verifier("plusieurs sources peuvent pointer la meme cible (un troncon decoupe en plusieurs identifiants) : 201", memeCibleAutreSource.status === 201, memeCibleAutreSource.body);

  // ------------------------------------------------------------------ 3. Confirmer : une autre personne
  const auto = await post(`/${p0.body.ligne.id}/confirmer`, { motif: "Je confirme" }, T.p);
  const sansMotif = await post(`/${p0.body.ligne.id}/confirmer`, { motif: "" }, T.r);
  verifier("on ne confirme pas sa propre proposition (403 AUTO_CONFIRMATION) ; une confirmation sans motif est refusee (400)",
    auto.status === 403 && auto.body.code === "AUTO_CONFIRMATION" && sansMotif.status === 400, [auto.body, sansMotif.body]);
  const vAvant = (await get("/versions")).body.versionCourante as number;
  const conf = await post(`/${p0.body.ligne.id}/confirmer`, { motif: "Verifie sur la carte" }, T.r);
  verifier("confirmation par une autre personne : 200, nouvelle ligne CONFIRMEE (decision nominative, datee, motivee), nouvelle version",
    conf.status === 200 && conf.body.ligne.statut === "CONFIRMEE" && conf.body.ligne.decisionReviseurId === reviseur.id
    && conf.body.ligne.decisionMotif === "Verifie sur la carte" && conf.body.ligne.decisionLe && conf.body.version === vAvant + 1, conf.body);
  const apres = await get("");
  const avantConf = await get(`?version=${vAvant}`);
  verifier("a la version courante, la ligne est CONFIRMEE ; a la version d'avant, elle se relit A_CONFIRMER, intacte (rien n'est modifie en place)",
    apres.body.correspondances.find((c: { identifiantSource: string }) => c.identifiantSource === "BANC-0000")?.statut === "CONFIRMEE"
    && avantConf.body.correspondances.find((c: { identifiantSource: string }) => c.identifiantSource === "BANC-0000")?.statut === "A_CONFIRMER"
    && await compter(`SELECT count(*) n FROM correspondances_identifiants WHERE "identifiantSource" = 'BANC-0000'`) === 2);
  const reconf = await post(`/${conf.body.ligne.id}/confirmer`, { motif: "encore" }, T.r);
  const confFermee = await post(`/${p0.body.ligne.id}/confirmer`, { motif: "x" }, T.r);
  verifier("deja confirmee : 409 DEJA_CONFIRMEE ; ligne fermee : 409 CORRESPONDANCE_FERMEE", reconf.body.code === "DEJA_CONFIRMEE" && confFermee.body.code === "CORRESPONDANCE_FERMEE", [reconf.body, confFermee.body]);

  const revue = await post("", prop(2, { methode: "REVUE_HUMAINE", score: 0.5, decisionMotif: "Constate sur place" }));
  const revueSansMotif = await post("", prop(3, { methode: "REVUE_HUMAINE", score: 0.5 }));
  verifier("la revue humaine EST la decision : acceptee d'emblee CONFIRMEE, par son auteur, avec son motif ; sans motif elle est refusee (400)",
    revue.status === 201 && revue.body.ligne.statut === "CONFIRMEE" && revue.body.ligne.decisionReviseurId === proposeur.id && revueSansMotif.status === 400, [revue.body, revueSansMotif.body]);
  const officiel = await post("", prop(4, { methode: "IDENTIFIANT_OFFICIEL", score: 1 }));
  verifier("meme un identifiant officiel (score 1) naît A_CONFIRMER : rien n'est confirme sans une personne", officiel.status === 201 && officiel.body.ligne.statut === "A_CONFIRMER", officiel.body);

  // ------------------------------------------------------------------ 4. La base tient les regles seule
  const refus = async (texte: string, ...p: unknown[]) => sql(texte, ...p).then(() => "accepte", (e: Error) => e.message);
  const ligne0 = conf.body.ligne.id as string;
  const r = {
    update: await refus(`UPDATE correspondances_identifiants SET "identifiantCible" = $1 WHERE id = $2`, troncons[9], ligne0),
    statut: await refus(`UPDATE correspondances_identifiants SET statut = 'A_CONFIRMER', "decisionReviseurId" = NULL, "decisionLe" = NULL, "decisionMotif" = NULL WHERE id = $1`, ligne0),
    del: await refus(`DELETE FROM correspondances_identifiants WHERE id = $1`, ligne0),
    version: await refus(`UPDATE versions_correspondance SET motif = 'x' WHERE version = 1`),
    versionDel: await refus(`DELETE FROM versions_correspondance WHERE version = 1`),
  };
  verifier("la base refuse UPDATE de contenu, retour en arriere du statut, DELETE d'une correspondance, UPDATE et DELETE du journal des versions",
    Object.values(r).every((m) => m !== "accepte"), r);
  const ins = (extra: Record<string, unknown>) => {
    const c = { ...prop(40), ...extra } as Record<string, unknown>;
    return refus(
      `INSERT INTO correspondances_identifiants ("systemeSource","typeObjet","identifiantSource","identifiantCible","methode","score","statut","proposeParId","decisionReviseurId","decisionLe","decisionMotif","valideDu","versionOuverture")
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,CASE WHEN $9::text IS NULL THEN NULL ELSE 'm' END,$10::date,1)`,
      c.systemeSource, c.typeObjet, c.identifiantSource, c.identifiantCible, c.methode, c.score, c.statut ?? "A_CONFIRMER", proposeur.id, c.decideur ?? null, c.valideDu);
  };
  const direct = {
    scoreUn: await ins({ score: 1 }),
    officielSous1: await ins({ methode: "IDENTIFIANT_OFFICIEL", score: 0.9 }),
    cibleInconnue: await ins({ identifiantCible: "n-existe-pas" }),
    autoConfirmation: await ins({ statut: "CONFIRMEE", decideur: proposeur.id }),
    revueNonDecidee: await ins({ methode: "REVUE_HUMAINE", score: 0.5 }),
    systemeMinuscule: await ins({ systemeSource: "onr bdr" }),
    typeRoute: await ins({ typeObjet: "ROUTE" }),
    nomSeul: await ins({ methode: "NOM_SEUL" }),
    periodeVide: await refus(`INSERT INTO correspondances_identifiants ("systemeSource","typeObjet","identifiantSource","identifiantCible","methode","score","proposeParId","valideDu","valideAu","versionOuverture") VALUES ('SYS','TRONCON','x',$1,'CODE_ROUTE_NOMENCLATURE',0.5,$2,'2026-02-01','2026-01-01',1)`, troncons[40], proposeur.id),
  };
  verifier("un INSERT direct est refuse par la base : score 1 hors officiel, officiel sous 1, cible inexistante, auto-confirmation, revue non decidee, systeme mal forme, type « route », methode « nom seul », periode vide",
    Object.values(direct).every((m) => m !== "accepte"), direct);
  // ------------------------------------------------------------------ 5. Corriger, clore
  const aCorriger = memeCibleAutreSource.body.ligne;
  const vC = (await get("/versions")).body.versionCourante as number;
  const corr = await post(`/${aCorriger.id}/corriger`, { identifiantCible: troncons[5], score: 0.8 });
  verifier("corriger : la ligne est fermee, une nouvelle A_CONFIRMER (nouvelle cible, nouveau score) est ouverte, la correction est a reconfirmer",
    corr.status === 200 && corr.body.ligne.identifiantCible === troncons[5] && corr.body.ligne.score === "0.800" && corr.body.ligne.statut === "A_CONFIRMER" && corr.body.version === vC + 1, corr.body);
  const corrFermee = await post(`/${aCorriger.id}/corriger`, { score: 0.5 });
  verifier("corriger une ligne deja fermee : 409 CORRESPONDANCE_FERMEE", corrFermee.status === 409 && corrFermee.body.code === "CORRESPONDANCE_FERMEE", corrFermee.body);
  const corrInvalide = await post(`/${corr.body.ligne.id}/corriger`, { score: 1 });
  verifier("corriger vers un score 1 sans identifiant officiel : 400, rien n'est ferme", corrInvalide.status === 400 && (await get("/versions")).body.versionCourante === corr.body.version);
  const clos = await post(`/${corr.body.ligne.id}/clore`, { motif: "Source retiree par l'ONR" });
  const sansMotifClore = await post(`/${officiel.body.ligne.id}/clore`, {});
  verifier("clore : la ligne cesse d'etre en vigueur, sans remplacement, motif obligatoire (400 sans motif)",
    clos.status === 200 && sansMotifClore.status === 400
    && !(await get("")).body.correspondances.some((c: { identifiantSource: string }) => c.identifiantSource === "BANC-AUTRE-SOURCE"), [clos.body, sansMotifClore.body]);
  verifier("la ligne close se relit pourtant a la version ou elle etait en vigueur",
    (await get(`?version=${corr.body.version}`)).body.correspondances.some((c: { identifiantSource: string }) => c.identifiantSource === "BANC-AUTRE-SOURCE"));

  // ------------------------------------------------------------------ 6. Serie sans trou, sous concurrence
  const avantRafale = (await get("/versions")).body.versionCourante as number;
  const rafale = await Promise.all(Array.from({ length: 12 }, (_, i) => post("", prop(10 + i))));
  const versions = rafale.filter((x) => x.status === 201).map((x) => x.body.version as number).sort((a, b) => a - b);
  verifier("12 propositions simultanees : 12 acceptees, 12 versions DISTINCTES et CONSECUTIVES a la suite de la precedente",
    versions.length === 12 && versions.every((v, i) => v === avantRafale + 1 + i), versions);
  const memeSource = await Promise.all(Array.from({ length: 6 }, () => post("", prop(30))));
  const gagnants = memeSource.filter((x) => x.status === 201).length;
  verifier("6 propositions simultanees du MEME identifiant source : une seule gagne, les cinq autres 409, aucune erreur serveur",
    gagnants === 1 && memeSource.filter((x) => x.status === 409).length === 5, memeSource.map((x) => x.status));
  const vf = await sql<{ n: bigint; m: number }>(`SELECT count(*) n, max(version) m FROM versions_correspondance`);
  verifier("la serie des versions est SANS TROU apres les refus et la concurrence : nombre de versions = numero maximal",
    Number(vf[0].n) === Number(vf[0].m), vf[0]);

  // ------------------------------------------------------------------ 7. Critere B12 : un export de la version n se regenere a l'identique
  for (let i = 40; i < 60; i++) await post("", prop(i));
  const propres = (await get("")).body.correspondances as { id: string; identifiantSource: string; statut: string }[];
  for (const l of propres.filter((x) => x.statut === "A_CONFIRMER").slice(0, 8)) await post(`/${l.id}/confirmer`, { motif: "Verifie" }, T.r);
  const n = (await get("/versions")).body.versionCourante as number;
  const exportN = await get(`/export?version=${n}`);
  const empreinteN = createHash("sha256").update(exportN.text, "utf8").digest("hex");
  verifier(`export de la version ${n} : en-tete de version, empreinte SHA-256 annoncee egale a celle que le banc recalcule`,
    exportN.status === 200 && exportN.text.startsWith(`# versionTable=${n}\n`) && exportN.headers["x-empreinte-sha256"] === empreinteN && exportN.headers["x-version-table"] === String(n), exportN.headers);
  const lignesN = new Set(exportN.text.split("\n").filter((l: string) => l && !l.startsWith("#") && !l.startsWith("systeme_source")));

  // Dix changements : 4 corrections, 3 clotures, 3 confirmations
  const courantes = (await get("")).body.correspondances as { id: string; identifiantSource: string; statut: string; identifiantCible: string }[];
  const cibles = courantes.filter((c) => c.identifiantSource >= "BANC-0010").slice(0, 10);
  const modifiees: string[] = [];
  for (const l of cibles.slice(0, 4)) { const x = await post(`/${l.id}/corriger`, { identifiantCible: troncons[65 + (modifiees.length % 5)], score: 0.75 }); modifiees.push(l.identifiantSource); if (x.status !== 200) throw new Error(JSON.stringify(x.body)); }
  for (const l of cibles.slice(4, 7)) { const x = await post(`/${l.id}/clore`, { motif: "Retiree" }); modifiees.push(l.identifiantSource); if (x.status !== 200) throw new Error(JSON.stringify(x.body)); }
  const aConfirmer = courantes.filter((c) => c.statut === "A_CONFIRMER" && !modifiees.includes(c.identifiantSource) && c.identifiantSource >= "BANC-0040");
  for (const l of aConfirmer.slice(0, 3)) { const x = await post(`/${l.id}/confirmer`, { motif: "Verifie" }, T.r); modifiees.push(l.identifiantSource); if (x.status !== 200) throw new Error(JSON.stringify(x.body)); }
  verifier("dix correspondances ont change apres la version " + n + " (4 corrigees, 3 closes, 3 confirmees)", modifiees.length === 10 && new Set(modifiees).size === 10, modifiees);

  const apresChangements = await get(`/export?version=${n}`);
  verifier("B12 : l'export de la version " + n + " regenere apres les dix changements est IDENTIQUE OCTET POUR OCTET (meme texte, meme empreinte)",
    apresChangements.text === exportN.text && apresChangements.headers["x-empreinte-sha256"] === empreinteN, [apresChangements.headers["x-empreinte-sha256"], empreinteN]);

  const exportCourant = await get("/export");
  const nCourant = Number(exportCourant.headers["x-version-table"]);
  const lignesCourant = new Set(exportCourant.text.split("\n").filter((l: string) => l && !l.startsWith("#") && !l.startsWith("systeme_source")));
  const retirees = [...lignesN].filter((l) => !lignesCourant.has(l)), ajoutees = [...lignesCourant].filter((l) => !lignesN.has(l));
  const sources = (ls: string[]) => ls.map((l) => l.split(";")[2]).sort();
  verifier(`B12 : la version courante (${nCourant}) differe de la version ${n}, et ne differe QUE par ces dix correspondances : ${retirees.length} lignes retirees, ${ajoutees.length} ajoutees, sur exactement les dix identifiants`,
    exportCourant.headers["x-empreinte-sha256"] !== empreinteN && retirees.length === 10 && ajoutees.length === 7
    && JSON.stringify(sources(retirees)) === JSON.stringify([...modifiees].sort())
    && sources(ajoutees).every((s) => modifiees.includes(s)) && !sources(ajoutees).some((s) => cibles.slice(4, 7).some((c) => c.identifiantSource === s)), { retirees: retirees.length, ajoutees: ajoutees.length });
  const futur = await get(`/export?version=${nCourant + 1}`);
  const parametresInvalides = await get("/export?version=abc");
  verifier("une version qui n'existe pas : 404 VERSION_INCONNUE ; un parametre mal forme : 400", futur.status === 404 && futur.body.code === "VERSION_INCONNUE" && parametresInvalides.status === 400, [futur.body, parametresInvalides.status]);

  // ------------------------------------------------------------------ 8. Audit
  const audits = await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'CorrespondanceIdentifiant'`);
  const lignesEcrites = await compter(`SELECT count(*) n FROM correspondances_identifiants`);
  const fermees = await compter(`SELECT count(*) n FROM correspondances_identifiants WHERE "versionFermeture" IS NOT NULL`);
  // une ecriture reussie = un audit : lignes ouvertes par proposition (hors copies de confirmation/correction) + fermetures
  const ecritures = (await sql<{ n: bigint }>(`SELECT count(*) n FROM versions_correspondance`))[0].n;
  verifier(`chaque ecriture reussie est auditee : ${ecritures} versions = ${audits} traces d'audit (et aucun refus n'en a laisse)`, Number(ecritures) === audits, { ecritures: Number(ecritures), audits, lignesEcrites, fermees });
  verifier("aucune ligne n'a jamais ete supprimee ni modifiee : chaque ligne fermee l'a ete par une version posterieure a son ouverture",
    await compter(`SELECT count(*) n FROM correspondances_identifiants WHERE "versionFermeture" IS NOT NULL AND "versionFermeture" <= "versionOuverture"`) === 0);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });
