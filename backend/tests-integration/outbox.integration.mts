// Banc d'integration de l'outbox des integrations sortantes : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/outbox.integration.mts
//
// CE QUE CE BANC PROUVE ET CE QU'IL NE PROUVE PAS
//
// Il exerce le service d'outbox, ses requetes SQL et les declencheurs de la base CONTRE UNE VRAIE BASE
// PostgreSQL / PostGIS, et contre des SIMULATEURS HTTP ECRITS PAR AGEROUTE sur 127.0.0.1. Il ne
// prouve RIEN sur DigitalRoad, SharePoint ou la BDR / L2R : aucun n'est atteint, aucun contrat reel
// n'est connu (B-11, B-12). `fetchBoucleLocale` refuse tout hote hors de la boucle locale.
//
// Les services committent et se voient entre eux, et la concurrence est reelle : le banc travaille
// dans un CLONE jetable de `replay` (essai_outbox), cree puis detruit par lui-meme. `replay` n'est
// jamais ecrite. Tant que la migration 20261024200000 n'est pas dans `replay`, le banc l'applique AU
// CLONE seulement.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import pgPkg from "pg";
import { evaluerCible } from "./lib/garde.ts";
import { creerClone, supprimerClone, urlClone } from "./lib/clone.ts";
import { verifier, conclure } from "./lib/verdict.ts";

const ORIGINE = process.env.DATABASE_URL;
const cible = evaluerCible(ORIGINE);
if (!cible.ok || cible.base !== "replay") {
  console.error("Banc d'integration refuse : DATABASE_URL doit etre une base locale nommee replay (le clone est cree par le banc).");
  process.exit(3);
}
const NOM_CLONE = "essai_outbox";
await creerClone(ORIGINE!, NOM_CLONE);
const URL_CLONE = urlClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = URL_CLONE;
console.log("Cible du banc : clone jetable " + NOM_CLONE);

// La migration, appliquee au CLONE si `replay` ne la porte pas encore (protocole simple : plusieurs instructions).
{
  const client = new pgPkg.Client({ connectionString: URL_CLONE });
  await client.connect();
  const present = await client.query(`SELECT to_regclass('outbox_evenements') AS t`);
  if (!present.rows[0].t) {
    const chemin = new URL("../prisma/migrations/20261024200000_outbox_integrations/migration.sql", import.meta.url);
    await client.query(readFileSync(fileURLToPath(chemin), "utf8"));
    console.log("Migration 20261024200000_outbox_integrations appliquee au clone (absente de replay).");
  }
  await client.end();
}

const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const svc = await imp("integrations/outbox.service");
const { depotSql } = await imp("integrations/outbox.depot");
const { lecteurSourcesSql } = await imp("integrations/sources.depot");
const { lireConfigIntegrations } = await imp("integrations/config");
const { creerAdaptateurs } = await imp("integrations/adaptateurs/index");
const { canonique, cleIdempotence, sha256Hex } = await imp("integrations/canonique");
const { demarrerSimulateur, fetchBoucleLocale } = await imp("integrations/simulateurs/simulateur");
const { trouverChampInterne } = await imp("integrations/sources.noyau");

const JETON = "jeton-du-banc-0123456789";
const CHEMIN = "/entrees/banc";
const INTERNE = ["NOTE-INTERNE-OBSERVATIONS", "PREFECTURE-INTERNE", "REF-SOURCE-INTERNE", "987654.321", "REMARQUE-INTERNE-OUVRAGE", "u-gest-interne"];

const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);
const lignes = <T = Record<string, unknown>>(q: string, ...a: unknown[]) => prisma.$queryRawUnsafe(q, ...a) as Promise<T[]>;
const n = async (q: string, ...a: unknown[]) => Number((await lignes<{ n: bigint }>(q, ...a))[0].n);

/** SQLSTATE du refus d'une instruction, ou 'ok'. */
async function etat(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "ok"; } catch (e) {
    const x = e as { meta?: { code?: string }; code?: string; message?: string };
    return x.meta?.code ?? x.code ?? String(x.message).slice(0, 80);
  }
}
async function refus(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "aucun refus"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
}

const simulateurs = {
  BDR_L2R: await demarrerSimulateur({ destination: "BDR_L2R", jeton: JETON, chemin: CHEMIN }),
  SHAREPOINT: await demarrerSimulateur({ destination: "SHAREPOINT", jeton: JETON, chemin: CHEMIN }),
  DIGITALROAD: await demarrerSimulateur({ destination: "DIGITALROAD", jeton: JETON, chemin: CHEMIN }),
};
const BDR = simulateurs.BDR_L2R;
const env: Record<string, string> = { INTEGRATIONS_SORTANTES_ACTIVES: "true", OUTBOX_TENTATIVES_MAX: "3", OUTBOX_DELAI_BASE_MS: "1000" };
for (const [d, s] of Object.entries(simulateurs)) {
  env[`OUTBOX_${d}_ACTIF`] = "true"; env[`OUTBOX_${d}_URL`] = s.url; env[`OUTBOX_${d}_CHEMIN`] = CHEMIN;
  env[`OUTBOX_${d}_JETON`] = JETON; env[`OUTBOX_${d}_TIMEOUT_MS`] = "2000";
}
const config = lireConfigIntegrations(env);
const fetchLocal = fetchBoucleLocale();
const horloge = { t: new Date("2026-10-24T08:00:00.000Z") };
const depsDe = (travailleur: string) => ({
  depot: depotSql(prisma), sources: lecteurSourcesSql(prisma), adaptateurs: creerAdaptateurs(config, fetchLocal),
  politique: config.politique, verrouMs: config.verrouMs, horloge: () => horloge.t, travailleur,
});
const deps = depsDe("w-banc");
const avancer = (ms: number) => { horloge.t = new Date(horloge.t.getTime() + ms); };

const inscrire = (destination: string, sourceType: string, sourceId: string, d = deps) =>
  svc.enregistrerEvenement(d, { destination, sourceType, sourceId, creeParId: "u-admin" });
const evenement = async (id: string) => (await lignes(`SELECT * FROM outbox_evenements WHERE id = $1`, id))[0] as Record<string, any>;

async function main() {
  // ---------------------------------------------------------------- Fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region banc outbox')`);
  for (const [id, mail] of [["u-admin", "admin@banc.invalid"], ["u-gest-interne", "gest@banc.invalid"]] as const) {
    await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ($1, $2, 'Banc', 'x', 'ADMIN', now())`, id, mail);
  }
  const troncon = (id: string, statut: string | null, o: { supprime?: boolean; geom?: boolean; lat?: number } = {}) => sql(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", "statutValidation", "deletedAt",
                           observations, "coutRehabEstime", prefecture, "sourceReference", geom, "updatedAt")
     VALUES ($1, $2, $3, 'RN', (SELECT id FROM regions WHERE nom = 'Region banc outbox'), 2.5, 'BITUME', 0, 2.5, $4::"StatutValidation", $5::timestamp,
             'NOTE-INTERNE-OBSERVATIONS', 987654.321, 'PREFECTURE-INTERNE', 'REF-SOURCE-INTERNE',
             ${o.geom === false ? "NULL" : `ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, ${o.lat ?? 9.64}), ST_MakePoint(-13.58, ${o.lat ?? 9.64})), 4326)`}, now())`,
    id, `BANC-${id}`, `Troncon ${id}`, statut, o.supprime ? "2026-10-01T00:00:00" : null);
  await troncon("t-ok", "VALIDE", { lat: 9.64 });
  await troncon("t-av", "A_VALIDER", { lat: 9.65 });
  await troncon("t-rej", "REJETE", { lat: 9.66 });
  await troncon("t-cor", "A_CORRIGER", { lat: 9.67 });
  await troncon("t-nul", null, { lat: 9.68 });
  await troncon("t-sup", "VALIDE", { supprime: true, lat: 9.69 });
  await troncon("t-sansgeom", "VALIDE", { geom: false });
  for (const id of ["t-conc", "t-echec", "t-morte", "t-refus", "t-relance", "t-abandon", "t-lent", "t-tard", "t-tard2", "t-bail", "t-v2", "t-fuite", "t-rejeu"]) {
    await troncon(id, "VALIDE", { lat: 9.7 });
  }

  const ouvrage = (id: string, statut: string) => sql(
    `INSERT INTO ouvrages (id, nom, type, "regionId", code, pk, remarques, "statutValidation", geom, "updatedAt")
     VALUES ($1, 'Pont du banc', 'PONT', (SELECT id FROM regions WHERE nom = 'Region banc outbox'), 'RN1-PONT-1.0', 1.0, 'REMARQUE-INTERNE-OUVRAGE',
             $2::"StatutValidation", ST_SetSRID(ST_MakePoint(-13.6, 9.7), 4326), now())`, id, statut);
  await ouvrage("o-ok", "VALIDE");
  await ouvrage("o-av", "A_VALIDER");

  const portion = (id: string, tronconId: string, debut: number, fin: number, statut: string, o: { supprime?: boolean; remplacee?: boolean } = {}) => sql(
    `INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, "statutValidation", origine, "remplaceeLe", "deletedAt", "creeParId", "updatedAt")
     VALUES ($1, $2, $3, $4, NULL, $5::"StatutValidation", 'SAISIE_TERRAIN', $6::timestamp, $7::timestamp, 'u-gest-interne', now())`,
    id, tronconId, debut, fin, statut, o.remplacee ? "2026-10-02T00:00:00" : null, o.supprime ? "2026-10-03T00:00:00" : null);
  await portion("p-ok", "t-ok", 0, 100, "VALIDE");
  await portion("p-av", "t-av", 0, 100, "A_VALIDER");
  await portion("p-sup", "t-ok", 100, 200, "VALIDE", { supprime: true });
  await portion("p-rem", "t-ok", 200, 300, "VALIDE", { remplacee: true });

  await sql(`INSERT INTO bulletins_routiers (id, numero, jour, "situationA", "genereParId", gabarit, texte, "empreinteSha256")
             VALUES ('b-ok', 'BR-20261024-1', '2026-10-24', '2026-10-24 06:00:00', 'u-gest-interne', 'GABARIT-INTERNE', 'Bulletin routier du 24/10/2026. RN1 : circulation normale.',
                     encode(sha256(convert_to('Bulletin routier du 24/10/2026. RN1 : circulation normale.', 'UTF8')), 'hex'))`);

  // ---------------------------------------------------------------- 1. SEULES LES DONNEES VALIDEES ENTRENT
  const ok = await inscrire("BDR_L2R", "Troncon", "t-ok");
  verifier("un troncon VALIDE est inscrit EN_ATTENTE, version 1", ok.evenement.statut === "EN_ATTENTE" && ok.evenement.version === 1 && !ok.dejaEnregistre, ok.evenement);

  const refusesTroncons: [string, string][] = [["A_VALIDER", "t-av"], ["REJETE", "t-rej"], ["A_CORRIGER", "t-cor"], ["sans statut (NULL)", "t-nul"], ["supprime logiquement", "t-sup"]];
  for (const [nom, id] of refusesTroncons) {
    verifier(`un troncon ${nom} est refuse par le service (SOURCE_NON_EMISSIBLE)`, (await refus(() => inscrire("BDR_L2R", "Troncon", id))) === "SOURCE_NON_EMISSIBLE");
  }
  verifier("un troncon VALIDE sans trace n'est pas inscrit : le pivot n'invente pas de geometrie (CHARGE_NON_CONSTRUISIBLE)",
    (await refus(() => inscrire("BDR_L2R", "Troncon", "t-sansgeom"))) === "CHARGE_NON_CONSTRUISIBLE");
  verifier("un troncon inexistant est refuse (SOURCE_NON_EMISSIBLE)", (await refus(() => inscrire("BDR_L2R", "Troncon", "fantome"))) === "SOURCE_NON_EMISSIBLE");

  verifier("un ouvrage A_VALIDER est refuse", (await refus(() => inscrire("BDR_L2R", "Ouvrage", "o-av"))) === "SOURCE_NON_EMISSIBLE");
  verifier("une portion A_VALIDER est refusee", (await refus(() => inscrire("BDR_L2R", "Portion", "p-av"))) === "SOURCE_NON_EMISSIBLE");
  verifier("une portion supprimee logiquement est refusee", (await refus(() => inscrire("BDR_L2R", "Portion", "p-sup"))) === "SOURCE_NON_EMISSIBLE");
  verifier("une portion remplacee (version close) est refusee", (await refus(() => inscrire("BDR_L2R", "Portion", "p-rem"))) === "SOURCE_NON_EMISSIBLE");
  verifier("une fiche d'intervention est refusee : aucune table de fiches n'existe",
    (await refus(() => inscrire("DIGITALROAD", "FicheIntervention", "fiche-1"))) === "SOURCE_NON_EMISSIBLE");
  verifier("un troncon ne se route pas vers SharePoint (SOURCE_INCONNUE)", (await refus(() => inscrire("SHAREPOINT", "Troncon", "t-ok"))) === "SOURCE_INCONNUE");

  const oo = await inscrire("BDR_L2R", "Ouvrage", "o-ok");
  const pp = await inscrire("BDR_L2R", "Portion", "p-ok");
  const bb = await inscrire("SHAREPOINT", "BulletinRoutier", "b-ok");
  verifier("un ouvrage VALIDE, une portion VALIDE et un bulletin archive sont inscrits",
    [oo, pp, bb].every((x) => x.evenement.statut === "EN_ATTENTE"), [oo.evenement.id, pp.evenement.id, bb.evenement.id]);

  // Le filet : on contourne le service, la BASE refuse.
  const insertionDirecte = (destination: string, typeEvenement: string, sourceType: string, sourceId: string) => {
    const charge = canonique({ contournement: sourceId });
    const empreinte = sha256Hex(charge);
    const cle = cleIdempotence({ destination, typeEvenement, sourceType, sourceId, empreinteCharge: empreinte });
    return sql(`INSERT INTO outbox_evenements (destination, "typeEvenement", "sourceType", "sourceId", "cleIdempotence", "chargeCanonique", "empreinteCharge", "creeParId")
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'u-admin')`, destination, typeEvenement, sourceType, sourceId, cle, charge, empreinte);
  };
  const attendus: [string, string, string, string][] = [
    ["troncon A_VALIDER", "Troncon", "t-av", "BDR_L2R"], ["troncon REJETE", "Troncon", "t-rej", "BDR_L2R"],
    ["troncon A_CORRIGER", "Troncon", "t-cor", "BDR_L2R"], ["troncon sans statut", "Troncon", "t-nul", "BDR_L2R"],
    ["troncon supprime", "Troncon", "t-sup", "BDR_L2R"], ["ouvrage A_VALIDER", "Ouvrage", "o-av", "BDR_L2R"],
    ["portion A_VALIDER", "Portion", "p-av", "BDR_L2R"], ["portion supprimee", "Portion", "p-sup", "BDR_L2R"],
    ["portion remplacee", "Portion", "p-rem", "BDR_L2R"],
  ];
  for (const [nom, type, id, dest] of attendus) {
    const code = await etat(() => insertionDirecte(dest, "PIVOT_OBJET_VALIDE", type, id));
    verifier(`contournement du service : la BASE refuse l'insertion directe d'un(e) ${nom} (23514)`, code === "23514", code);
  }
  verifier("contournement du service : la BASE refuse une fiche d'intervention (23514)",
    (await etat(() => insertionDirecte("DIGITALROAD", "FICHE_INTERVENTION_PROGRAMMEE", "FicheIntervention", "fiche-1"))) === "23514");

  const nonValidees = ["t-av", "t-rej", "t-cor", "t-nul", "t-sup", "t-sansgeom", "fantome", "o-av", "p-av", "p-sup", "p-rem", "fiche-1"];
  verifier("AUCUNE ligne de l'outbox ne vise une donnee non validee",
    (await n(`SELECT count(*) AS n FROM outbox_evenements WHERE "sourceId" = ANY($1::text[])`, nonValidees)) === 0);
  verifier("l'outbox ne contient que les quatre evenements valides inscrits jusqu'ici",
    (await n(`SELECT count(*) AS n FROM outbox_evenements`)) === 4);

  // ---------------------------------------------------------------- 2. IDEMPOTENCE
  const bis = await inscrire("BDR_L2R", "Troncon", "t-ok");
  verifier("inscrire deux fois le meme contenu rend le meme evenement (dejaEnregistre)", bis.dejaEnregistre && bis.evenement.id === ok.evenement.id);
  verifier("et n'ajoute ni ligne ni audit",
    (await n(`SELECT count(*) AS n FROM outbox_evenements WHERE "sourceId" = 't-ok'`)) === 1
    && (await n(`SELECT count(*) AS n FROM audit_logs WHERE "entityType" = 'OutboxEvenement' AND "entityId" = $1`, ok.evenement.id)) === 1);

  const course = await Promise.all(Array.from({ length: 8 }, () => inscrire("BDR_L2R", "Troncon", "t-conc", depsDe("w-course"))));
  verifier("huit inscriptions SIMULTANEES du meme contenu n'en font qu'une (une seule creation)",
    new Set(course.map((c) => c.evenement.id)).size === 1 && course.filter((c) => !c.dejaEnregistre).length === 1
    && (await n(`SELECT count(*) AS n FROM outbox_evenements WHERE "sourceId" = 't-conc'`)) === 1);
  verifier("un seul audit CREATE pour cet evenement",
    (await n(`SELECT count(*) AS n FROM audit_logs WHERE "entityType" = 'OutboxEvenement' AND "entityId" = $1`, course[0].evenement.id)) === 1);

  verifier("la cle d'idempotence stockee est le SHA-256 deterministe recalcule par la base",
    (await n(`SELECT count(*) AS n FROM outbox_evenements WHERE "cleIdempotence" <> encode(sha256(convert_to("destination" || '|' || "typeEvenement" || '|' || "sourceType" || '|' || "sourceId" || '|' || "empreinteCharge", 'UTF8')), 'hex')`)) === 0);
  verifier("la cle calculee par le code est celle de la base",
    cleIdempotence({ destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", sourceType: "Troncon", sourceId: "t-ok", empreinteCharge: ok.evenement.empreinteCharge }) === ok.evenement.cleIdempotence);

  const v1 = await inscrire("BDR_L2R", "Troncon", "t-v2");
  await sql(`UPDATE troncons SET "longueurKm" = 9.9, "updatedAt" = now() WHERE id = 't-v2'`);
  const v2 = await inscrire("BDR_L2R", "Troncon", "t-v2");
  verifier("un contenu modifie cree un NOUVEL evenement (version 2, autre cle) et ne touche pas le premier",
    v2.evenement.version === 2 && v1.evenement.version === 1 && v2.evenement.cleIdempotence !== v1.evenement.cleIdempotence
    && (await evenement(v1.evenement.id)).chargeCanonique === v1.evenement.chargeCanonique);

  // ---------------------------------------------------------------- 3. EMISSION ET REJEU SANS EFFET DE BORD
  const r1 = await svc.traiterEvenement(deps, ok.evenement.id);
  const envoye = await evenement(ok.evenement.id);
  verifier("traiter emet : ENVOYE, accuse enregistre, verrou rendu", r1.traite && envoye.statut === "ENVOYE" && /^SIM-/.test(envoye.accuseReference) && envoye.verrouPar === null && envoye.envoyeLe !== null, envoye);
  verifier("le simulateur de la BDR a recu EXACTEMENT une requete, conforme, avec le jeton et la cle",
    BDR.requetes.length === 1 && BDR.requetes[0].enveloppeConforme && BDR.requetes[0].jetonValide && BDR.requetes[0].cleCoherente && BDR.effets.size === 1);
  verifier("une tentative archivee (ACCEPTE, 200) et trois transitions auditees",
    (await n(`SELECT count(*) AS n FROM outbox_tentatives WHERE "evenementId" = $1 AND issue = 'ACCEPTE' AND "codeHttp" = 200`, ok.evenement.id)) === 1
    && (await lignes<{ t: string }>(`SELECT "after"->>'transition' AS t FROM audit_logs WHERE "entityType" = 'OutboxEvenement' AND "entityId" = $1 ORDER BY "createdAt", id`, ok.evenement.id))
        .map((x) => x.t).join(" ") === "(nouveau)>EN_ATTENTE EN_ATTENTE>EN_COURS EN_COURS>ENVOYE");

  // Mesures PAR EVENEMENT : un lot rejoue plus bas emet legitimement d'AUTRES evenements en attente.
  const mesure = async () => ({
    ligne: JSON.stringify(await evenement(ok.evenement.id)),
    audits: await n(`SELECT count(*) AS n FROM audit_logs WHERE "entityType" = 'OutboxEvenement' AND "entityId" = $1`, ok.evenement.id),
    tentatives: await n(`SELECT count(*) AS n FROM outbox_tentatives WHERE "evenementId" = $1`, ok.evenement.id),
    requetes: BDR.requetes.filter((q: any) => q.entetes["idempotency-key"] === ok.evenement.cleIdempotence).length,
  });
  const avant = await mesure();
  const rejeux = [await svc.rejouerEvenement(deps, ok.evenement.id), await svc.traiterEvenement(deps, ok.evenement.id), await svc.rejouerEvenement(depsDe("w-autre"), ok.evenement.id)];
  const lotRejoue = await svc.traiterLot(deps, 50);
  const apres = await mesure();
  verifier("REJEU : rejouer un evenement ENVOYE repond DEJA_ENVOYE", rejeux.every((r: any) => !r.traite && r.raison === "DEJA_ENVOYE"), rejeux);
  verifier("REJEU : un lot ne reprend pas l'evenement ENVOYE", lotRejoue.resultats.every((r: any) => r.id !== ok.evenement.id));
  verifier("REJEU : aucune requete de plus pour cet evenement vers le simulateur", avant.requetes === 1 && apres.requetes === 1, { avant: avant.requetes, apres: apres.requetes });
  verifier("REJEU : la ligne est strictement identique (updatedAt compris)", apres.ligne === avant.ligne);
  verifier("REJEU : aucun audit et aucune tentative de plus pour cet evenement", apres.audits === avant.audits && apres.tentatives === avant.tentatives, { avant, apres });

  verifier("la BASE refuse de modifier un evenement ENVOYE (UPDATE)", (await etat(() => sql(`UPDATE outbox_evenements SET "dernierMessage" = 'x' WHERE id = $1`, ok.evenement.id))) === "23000", await etat(() => sql(`UPDATE outbox_evenements SET "dernierMessage" = 'x' WHERE id = $1`, ok.evenement.id)));
  verifier("la BASE refuse de remettre un evenement ENVOYE en attente",
    (await etat(() => sql(`UPDATE outbox_evenements SET statut = 'EN_ATTENTE', "envoyeLe" = NULL, "accuseReference" = NULL WHERE id = $1`, ok.evenement.id))) === "23000");
  verifier("la BASE refuse de supprimer un evenement (DELETE)", (await etat(() => sql(`DELETE FROM outbox_evenements WHERE id = $1`, pp.evenement.id))) === "23000");
  verifier("la BASE refuse de modifier la charge d'un evenement encore EN_ATTENTE",
    (await etat(() => sql(`UPDATE outbox_evenements SET "chargeCanonique" = '{"a":1}', "empreinteCharge" = encode(sha256(convert_to('{"a":1}','UTF8')),'hex') WHERE id = $1`, pp.evenement.id))) === "23000");
  verifier("la BASE refuse d'inscrire une tentative modifiee (journal en ajout seul)",
    (await etat(() => sql(`UPDATE outbox_tentatives SET message = 'retouche' WHERE "evenementId" = $1`, ok.evenement.id))) === "23000");

  // ---------------------------------------------------------------- 4. REPRISE APRES ECHEC
  const e1 = await inscrire("BDR_L2R", "Troncon", "t-echec");
  BDR.programmer({ type: "erreur5xx" });
  const echec = await svc.traiterEvenement(deps, e1.evenement.id);
  const eEchec = await evenement(e1.evenement.id);
  verifier("un 503 passe l'evenement a ECHEC, tentatives = 1, code HTTP_503", echec.statut === "ECHEC" && eEchec.statut === "ECHEC" && eEchec.tentatives === 1 && eEchec.dernierCode === "HTTP_503");
  verifier("la reprise est programmee dans le futur, a base * 2^0 = 1 s",
    new Date(eEchec.prochaineTentativeLe).getTime() === horloge.t.getTime() + 1_000, eEchec.prochaineTentativeLe);
  const requetesAvant = BDR.requetes.length;
  const tropTot = await svc.traiterEvenement(deps, e1.evenement.id);
  const lotTropTot = await svc.traiterLot(deps, 50);
  verifier("avant l'echeance, ni traiter ni le lot ne re-emettent", !tropTot.traite && lotTropTot.resultats.every((r: any) => r.id !== e1.evenement.id) && BDR.requetes.length === requetesAvant);
  avancer(1_000);
  const repris = await svc.traiterLot(deps, 50);
  verifier("a l'echeance, le lot reprend l'evenement : ENVOYE a la deuxieme tentative",
    repris.resultats.some((r: any) => r.id === e1.evenement.id && r.statut === "ENVOYE") && (await evenement(e1.evenement.id)).tentatives === 2);
  verifier("le destinataire n'a applique qu'un effet pour cet evenement", BDR.effets.has(e1.evenement.cleIdempotence) && [...BDR.effets.keys()].filter((k) => k === e1.evenement.cleIdempotence).length === 1);

  // Rejouer un evenement en ECHEC l'emet sans attendre son echeance (le rejeu n'est un no-op que pour ENVOYE).
  const eRejeu = await inscrire("BDR_L2R", "Troncon", "t-rejeu");
  BDR.programmer({ type: "erreur5xx" });
  await svc.traiterEvenement(deps, eRejeu.evenement.id);
  const rejeuAnticipe = await svc.rejouerEvenement(deps, eRejeu.evenement.id);
  verifier("rejouer un evenement ECHEC l'emet sans attendre l'echeance : ENVOYE, deuxieme tentative",
    rejeuAnticipe.traite && rejeuAnticipe.statut === "ENVOYE" && (await evenement(eRejeu.evenement.id)).tentatives === 2);

  // File morte : tentativesMax = 3, destinataire en panne durable.
  const e2 = await inscrire("BDR_L2R", "Troncon", "t-morte");
  BDR.definirDefaut({ type: "erreur5xx" });
  for (let i = 0; i < 3; i += 1) { avancer(3_600_000); await svc.traiterEvenement(deps, e2.evenement.id); }
  BDR.definirDefaut({ type: "succes" });
  const morte = await evenement(e2.evenement.id);
  verifier("apres 3 echecs l'evenement est en FILE MORTE (ABANDONNE) avec son motif",
    morte.statut === "ABANDONNE" && morte.tentatives === 3 && /TENTATIVES_EPUISEES/.test(morte.motifAbandon) && morte.abandonneLe !== null, morte);
  const apresMorte = BDR.requetes.length;
  avancer(86_400_000);
  const reprisMorte = await svc.traiterLot(deps, 50);
  verifier("la file morte n'est plus jamais reprise par le travailleur", reprisMorte.resultats.every((r: any) => r.id !== e2.evenement.id) && BDR.requetes.length === apresMorte);
  verifier("trois tentatives archivees, numerotees 1 a 3",
    (await lignes<{ numero: number }>(`SELECT numero FROM outbox_tentatives WHERE "evenementId" = $1 ORDER BY numero`, e2.evenement.id)).map((x) => x.numero).join() === "1,2,3");

  // Refus definitif.
  const e3 = await inscrire("BDR_L2R", "Troncon", "t-refus");
  BDR.programmer({ type: "refus4xx", statut: 422 });
  await svc.traiterEvenement(deps, e3.evenement.id);
  const refuse = await evenement(e3.evenement.id);
  verifier("un 422 envoie DIRECTEMENT en file morte apres UNE tentative", refuse.statut === "ABANDONNE" && refuse.tentatives === 1 && /REFUS_DEFINITIF/.test(refuse.motifAbandon));

  // Relance humaine de la file morte.
  const relance = await svc.relancerEvenement(deps, e2.evenement.id, { utilisateurId: "u-admin", motif: "destinataire retabli" });
  verifier("la relance remet l'evenement EN_ATTENTE, tentatives a 0, relances a 1, motif d'abandon efface",
    relance.statut === "EN_ATTENTE" && relance.tentatives === 0 && relance.relances === 1 && relance.motifAbandon === null);
  const apresRelance = await svc.traiterEvenement(deps, e2.evenement.id);
  verifier("l'evenement relance part et passe a ENVOYE", apresRelance.traite && (await evenement(e2.evenement.id)).statut === "ENVOYE");
  verifier("la numerotation des tentatives continue apres une relance (1 a 4)",
    (await lignes<{ numero: number }>(`SELECT numero FROM outbox_tentatives WHERE "evenementId" = $1 ORDER BY numero`, e2.evenement.id)).map((x) => x.numero).join() === "1,2,3,4");
  verifier("la relance est auditee avec l'auteur humain et le motif",
    (await n(`SELECT count(*) AS n FROM audit_logs WHERE "entityType" = 'OutboxEvenement' AND "entityId" = $1 AND "userId" = 'u-admin' AND "after"->>'transition' = 'ABANDONNE>EN_ATTENTE' AND "after"->>'motif' = 'destinataire retabli'`, e2.evenement.id)) === 1);
  verifier("relancer un evenement ENVOYE est refuse (DEJA_ENVOYE)", (await refus(() => svc.relancerEvenement(deps, e2.evenement.id, { utilisateurId: "u-admin", motif: "essai" }))) === "DEJA_ENVOYE");

  // Abandon humain.
  const e4 = await inscrire("BDR_L2R", "Troncon", "t-abandon");
  verifier("abandonner sans motif est refuse", (await refus(() => svc.abandonnerEvenement(deps, e4.evenement.id, { utilisateurId: "u-admin", motif: " " }))) === "MOTIF_REQUIS");
  const ab = await svc.abandonnerEvenement(deps, e4.evenement.id, { utilisateurId: "u-admin", motif: "remplace par une autre donnee" });
  verifier("abandonner avec motif : ABANDONNE, ligne conservee, motif porte",
    ab.statut === "ABANDONNE" && /ABANDON_HUMAIN/.test(ab.motifAbandon) && (await n(`SELECT count(*) AS n FROM outbox_evenements WHERE id = $1`, e4.evenement.id)) === 1);

  // ---------------------------------------------------------------- 5. VERROU ANTI-DOUBLE-ENVOI
  const e5 = await inscrire("BDR_L2R", "Troncon", "t-lent");
  BDR.programmer({ type: "lent", ms: 400 });
  const avantLent = BDR.requetes.length;
  const lents = await Promise.all(Array.from({ length: 6 }, (_, i) => svc.traiterEvenement(depsDe(`w-${i}`), e5.evenement.id)));
  verifier("six travailleurs simultanes sur le meme evenement : UN SEUL envoi",
    lents.filter((r: any) => r.traite).length === 1 && BDR.requetes.length - avantLent === 1, lents);
  verifier("une seule tentative archivee, et un seul effet chez le destinataire",
    (await n(`SELECT count(*) AS n FROM outbox_tentatives WHERE "evenementId" = $1`, e5.evenement.id)) === 1 && BDR.effets.has(e5.evenement.cleIdempotence));

  // Bail expire : un travailleur mort. On reclame a la main puis on laisse le bail passer.
  const e6 = await inscrire("BDR_L2R", "Troncon", "t-bail");
  const port = deps.depot.lecture;
  const pris = await port.reclamer({ id: e6.evenement.id, travailleur: "w-mort", maintenant: horloge.t, verrouJusqua: new Date(horloge.t.getTime() + 60_000), ignorerEcheance: false });
  verifier("un evenement EN_COURS porte son bail", pris?.statut === "EN_COURS" && pris.verrouPar === "w-mort");
  verifier("tant que le bail court, un autre travailleur ne le reprend pas", (await svc.traiterEvenement(depsDe("w-vivant"), e6.evenement.id)).raison === "NON_DU_OU_VERROUILLE");
  verifier("et un abandon humain est refuse (VERROU_ACTIF)", (await refus(() => svc.abandonnerEvenement(deps, e6.evenement.id, { utilisateurId: "u-admin", motif: "essai" }))) === "VERROU_ACTIF");
  avancer(61_000);
  const reprise = await svc.traiterEvenement(depsDe("w-vivant"), e6.evenement.id);
  verifier("bail expire : un autre travailleur reprend et envoie", reprise.traite && reprise.statut === "ENVOYE");

  // ---------------------------------------------------------------- 6. LA SOURCE EST RELUE A L'ENVOI
  const e7 = await inscrire("BDR_L2R", "Troncon", "t-tard");
  await sql(`UPDATE troncons SET "statutValidation" = 'REJETE', "updatedAt" = now() WHERE id = 't-tard'`);
  const avantTard = BDR.requetes.length;
  const tard = await svc.traiterEvenement(deps, e7.evenement.id);
  const eTard = await evenement(e7.evenement.id);
  verifier("une donnee REJETEE entre l'inscription et l'envoi n'est PAS emise : ABANDONNE, aucun appel",
    tard.statut === "ABANDONNE" && eTard.statut === "ABANDONNE" && /SOURCE_NON_VALIDE_A_L_ENVOI/.test(eTard.motifAbandon) && BDR.requetes.length === avantTard, eTard);

  const e8 = await inscrire("BDR_L2R", "Troncon", "t-tard2");
  await sql(`UPDATE troncons SET "deletedAt" = now(), "updatedAt" = now() WHERE id = 't-tard2'`);
  const avantTard2 = BDR.requetes.length;
  const tard2 = await svc.traiterEvenement(deps, e8.evenement.id);
  verifier("une donnee SUPPRIMEE logiquement entre-temps n'est pas emise non plus", tard2.statut === "ABANDONNE" && BDR.requetes.length === avantTard2);

  // ---------------------------------------------------------------- 7. SHAREPOINT ET LES TROIS TYPES DE PIVOT
  // Ces trois evenements ont ete emis par le lot du rejeu plus haut : on verifie leur etat en base.
  const spBulletin = await evenement(bb.evenement.id);
  verifier("SharePoint : le bulletin archive est emis une fois, conforme au contrat",
    spBulletin.statut === "ENVOYE" && simulateurs.SHAREPOINT.requetes.length === 1 && simulateurs.SHAREPOINT.requetes[0].enveloppeConforme && simulateurs.SHAREPOINT.effets.size === 1);
  const pivots = [await evenement(oo.evenement.id), await evenement(pp.evenement.id)];
  verifier("BDR : le pivot d'un ouvrage et d'une portion est emis et accepte (ENVOYE, accuse enregistre)",
    pivots.every((p) => p.statut === "ENVOYE" && /^SIM-/.test(p.accuseReference)));
  verifier("le rejeu du bulletin est sans effet : toujours une requete chez SharePoint",
    (await svc.rejouerEvenement(deps, bb.evenement.id)).raison === "DEJA_ENVOYE" && simulateurs.SHAREPOINT.requetes.length === 1);

  // ---------------------------------------------------------------- 7 bis. LECTURE (ce que les routes d'administration appellent)
  const comptes = await svc.etatOutbox(deps);
  const sqlComptes = await lignes<{ statut: string; n: bigint }>(`SELECT statut, count(*) AS n FROM outbox_evenements GROUP BY 1`);
  verifier("etatOutbox compte les evenements par statut comme la base",
    sqlComptes.every((c) => comptes[c.statut] === Number(c.n)) && Object.values(comptes).reduce((a: number, b: any) => a + b, 0) === (await n(`SELECT count(*) AS n FROM outbox_evenements`)));
  const page = await svc.listerEvenements(deps, { limite: 2, decalage: 0 });
  verifier("listerEvenements : pagination et total",
    page.evenements.length === 2 && page.total === (await n(`SELECT count(*) AS n FROM outbox_evenements`)));
  const abandonnes = await svc.listerEvenements(deps, { statut: "ABANDONNE", limite: 50, decalage: 0 });
  verifier("listerEvenements : filtre par statut", abandonnes.total >= 3 && abandonnes.evenements.every((x: any) => x.statut === "ABANDONNE"));
  const sharepoint = await svc.listerEvenements(deps, { destination: "SHAREPOINT", limite: 50, decalage: 0 });
  verifier("listerEvenements : filtre par destination", sharepoint.total === 1 && sharepoint.evenements[0].destination === "SHAREPOINT");
  const detail = await svc.detailEvenement(deps, ok.evenement.id);
  verifier("detailEvenement : l'evenement, sa tentative et ses trois transitions auditees, dans l'ordre",
    detail.evenement.statut === "ENVOYE" && detail.tentatives.length === 1 && detail.tentatives[0].issue === "ACCEPTE"
    && detail.journal.map((j: any) => j.after.transition).join(" ") === "(nouveau)>EN_ATTENTE EN_ATTENTE>EN_COURS EN_COURS>ENVOYE");
  verifier("detailEvenement ne montre ni jeton ni corps de reponse",
    !JSON.stringify(detail).includes(JETON) && !JSON.stringify(detail).includes("127.0.0.1"));

  // ---------------------------------------------------------------- 8. AUCUNE FUITE DE CHAMP INTERNE
  const toutes = await lignes<{ chargeCanonique: string; sourceId: string }>(`SELECT "chargeCanonique", "sourceId" FROM outbox_evenements`);
  verifier(`aucune charge ne contient un marqueur interne (${INTERNE.length} marqueurs, ${toutes.length} charges)`,
    toutes.every((c) => INTERNE.every((m) => !c.chargeCanonique.includes(m))), toutes.filter((c) => INTERNE.some((m) => c.chargeCanonique.includes(m))).map((c) => c.sourceId));
  verifier("aucune charge ne porte de cle de la liste noire", toutes.every((c) => trouverChampInterne(JSON.parse(c.chargeCanonique)) === null));
  const corpsRecus = [...BDR.requetes, ...simulateurs.SHAREPOINT.requetes].map((q) => q.corps).join("\n");
  verifier("aucun corps recu par un simulateur ne contient de marqueur interne ni d'identifiant d'evenement",
    INTERNE.every((m) => !corpsRecus.includes(m)) && !corpsRecus.includes(ok.evenement.id) && !corpsRecus.includes("GABARIT-INTERNE"));
  verifier("le pivot d'un troncon ne porte que les attributs listes (nom, classe, longueur, revetement, etat, region)",
    (() => { const c = JSON.parse(ok.evenement.chargeCanonique); return Object.keys(c.features[0].properties).sort().join() === ["classe", "code_route", "date_source", "debut_m", "etat", "fin_m", "identifiant_source", "longueur_km", "nom", "region", "revetement", "systeme_source", "type_objet"].sort().join(); })());

  // ---------------------------------------------------------------- 9. SECRETS, CONFORMITE, BOUCLE LOCALE
  const tables = await n(`SELECT (
      (SELECT count(*) FROM outbox_evenements e WHERE to_jsonb(e)::text LIKE '%' || $1 || '%')
    + (SELECT count(*) FROM outbox_tentatives t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%')
    + (SELECT count(*) FROM audit_logs a WHERE a."entityType" = 'OutboxEvenement' AND to_jsonb(a)::text LIKE '%' || $1 || '%')) AS n`, JETON);
  verifier("le jeton n'apparait dans AUCUNE colonne de l'outbox, de ses tentatives ni de l'audit", tables === 0);
  verifier("aucune adresse de destinataire n'est stockee",
    (await n(`SELECT count(*) AS n FROM outbox_tentatives WHERE message LIKE '%127.0.0.1%'`)) === 0);
  const toutesRequetes = [...Object.values(simulateurs)].flatMap((s: any) => s.requetes);
  verifier(`les ${toutesRequetes.length} requetes recues par les simulateurs etaient toutes conformes au contrat, jeton valide`,
    toutesRequetes.every((q: any) => q.enveloppeConforme && q.jetonValide && q.cleCoherente), toutesRequetes.filter((q: any) => !q.enveloppeConforme).map((q: any) => q.motifNonConforme));
  verifier("tous les appels sortants du banc sont alles vers 127.0.0.1, aucun hote externe n'a ete tente",
    fetchLocal.refus.length === 0 && new Set(fetchLocal.hotesContactes).size === 1 && fetchLocal.hotesContactes[0] === "127.0.0.1", { refus: fetchLocal.refus });
  verifier("l'etat final de l'outbox ne contient que des statuts valides, sans verrou orphelin",
    (await n(`SELECT count(*) AS n FROM outbox_evenements WHERE statut = 'EN_COURS' OR "verrouPar" IS NOT NULL`)) === 0);
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 2;
} finally {
  conclure();
  for (const s of Object.values(simulateurs)) await (s as { fermer(): Promise<void> }).fermer();
  await prisma.$disconnect();
  await supprimerClone(ORIGINE!, NOM_CLONE);
  console.log("clone " + NOM_CLONE + " supprime");
}
// Evite un avertissement sur un import utilise seulement pour son effet de typage.
void createHash;
