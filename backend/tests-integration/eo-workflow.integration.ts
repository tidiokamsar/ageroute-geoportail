// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/eo-workflow.integration.ts
// Ce banc exige les migrations 20261028* (a appliquer d'abord a la base cible : `replay` ou un clone `essai_<nom>`), dont 20261028130000 (gardes du journal).
// Derniere section : de VRAIS COMMIT sur un clone de la base du banc (`essai_eo_workflow_commit`, cree puis detruit).
import "./lib/garde";
// Epreuve du workflow de l'observation de la Terre (Lot 1, EO-DB) contre PostGIS, transaction ANNULEE.
//
// Mode des contraintes differees : IMMEDIATE pendant tout le banc. Une transaction annulee ne declenche jamais les
// declencheurs differes (ils se jouent au COMMIT) : en les passant en IMMEDIATE, chaque ecriture est controlee
// tout de suite, ce qui est PLUS strict que la production. Le test dedie « ordre libre dans la transaction »
// repasse en DEFERRED pour prouver l'autre sens.
import { PrismaClient } from "@prisma/client";
import {
  enregistrerProduit, enregistrerProduits, deposerPropositions, changerStatut, ajouterPreuves, dispatcherVerification,
  changerEtatSource, calculerSynthese, qualiteMethodes, precision, RefusTeledetection,
} from "../src/teledetection/teledetection.service";
import { SEUIL_ECHANTILLON_TAUX, STATUTS_PROPOSITION, type StatutProposition } from "../src/teledetection/teledetection.noyau";
import { verifier, conclure, proche } from "./lib/verdict";

const prisma = new PrismaClient();
class Annulation extends Error {}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Execute `sql` sous point de sauvegarde ; rend le message de refus de la base, ou null si elle a accepte (et defait). */
async function refusDeLaBase(tx: Tx, sql: string): Promise<string | null> {
  await tx.$executeRawUnsafe("SAVEPOINT essai");
  try {
    await tx.$executeRawUnsafe(sql);
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT essai");
    return null;
  } catch (e) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT essai");
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Appelle le service sous point de sauvegarde et rend son refus metier (code, http), ou null s'il a reussi. Le point de
 * sauvegarde est INDISPENSABLE : un refus rendu par la base (declencheur, contrainte) abandonnerait sinon toute la
 * transaction du banc (« current transaction is aborted »).
 */
async function refusDuService(tx: Tx, f: () => Promise<unknown>): Promise<{ code: string; http: number } | null> {
  await tx.$executeRawUnsafe("SAVEPOINT service");
  try {
    await f();
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT service");
    return null;
  } catch (e) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT service");
    if (e instanceof RefusTeledetection) return { code: e.code, http: e.http };
    throw e;
  }
}

/** Empreinte du referentiel officiel : tout changement d'une ligne de troncons, portions ou ouvrages la change. */
async function empreinteReferentiel(tx: Tx) {
  const l = await tx.$queryRawUnsafe<{ t: string; p: string; o: string; n: number }[]>(`
    SELECT (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) FROM troncons x) AS t,
           (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) FROM portions x) AS p,
           (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) FROM ouvrages x) AS o,
           ((SELECT count(*) FROM troncons) + (SELECT count(*) FROM portions) + (SELECT count(*) FROM ouvrages))::int AS n`);
  return l[0];
}

const ATTENDU: Record<StatutProposition, StatutProposition[]> = {
  // Oracle ECRIT A LA MAIN, independant de TRANSITIONS_AUTORISEES (noyau) : contrat, section 3 et brief du chantier.
  A_VERIFIER: ["EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"],
  EN_ATTENTE: ["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"],
  NON_CONCLUANTE: ["A_VERIFIER", "EN_ATTENTE", "CONFIRMEE", "INFIRMEE"],
  CONFIRMEE: [],
  INFIRMEE: [],
};

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const depot = new Proxy(tx as unknown as Record<string, unknown>, {
        get: (t, k) => (k === "$transaction" ? (fn: (x: unknown) => unknown) => fn(tx) : t[k as string]),
      }) as never;
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");

      // ------------------------------------------------------------ jeu d'essai
      await tx.$executeRawUnsafe(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES
        ('u-eo','eo@local.invalid','Integ EO','x','GESTIONNAIRE',now()), ('u-eo2','eo2@local.invalid','Integ EO 2','x','INSPECTEUR',now())`);
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region EO 1'), ('Region EO 2')`);
      const [{ id: r1 }] = await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom = 'Region EO 1'`);
      const [{ id: r2 }] = await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom = 'Region EO 2'`);
      // A : est-ouest a la latitude 9,64 (region 1). B : parallele 55 m plus au nord, de -13,595 a -13,585 (region 2).
      await tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt") VALUES
        ('t-eoa', 'EO-A', 'Troncon A', 'RN', ${r1}, 1.1, 'BITUME', 0, 1.1, ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), now()),
        ('t-eob', 'EO-B', 'Troncon B', 'RN', ${r2}, 1.1, 'BITUME', 0, 1.1, ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.595, 9.6405), ST_MakePoint(-13.585, 9.6405)), 4326), now())`);
      await tx.$executeRawUnsafe(`INSERT INTO observations (id, "clientOperationId", "agentId", type, "observeA", "updatedAt") VALUES
        ('o-eo1','op-eo1','u-eo2','DEGRADATION',now(),now()), ('o-eo2','op-eo2','u-eo2','DEGRADATION',now(),now())`);
      const ctx = { auteurId: "u-eo" };
      const emprise = { type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.4, 9.5], [-13.4, 9.8], [-13.7, 9.8], [-13.7, 9.5]]] };
      const base = { palier: 0, source: "Sentinel-1 GRD", nature: "RADAR", resolutionM: 10, incertitude: "chatoiement radar", provenance: "scene-eo", licence: "relevee a la source", versionTraitement: "v0", emprise };
      const pRef = await enregistrerProduit(depot, { ...base, code: "EO-REF", dateAcquisition: new Date("2026-09-01") }, ctx);
      const pNew = await enregistrerProduit(depot, { ...base, code: "EO-NEW", dateAcquisition: new Date("2026-10-02") }, ctx);
      const pSyn = await enregistrerProduit(depot, { ...base, code: "EO-SYN", dateAcquisition: new Date("2026-10-03"), synthetique: true }, ctx);
      const ref0 = await empreinteReferentiel(tx);
      const limites = ["Resolution native 10 m : les nids-de-poule et les fissures fines ne sont pas detectables."];
      const lot = (type: "INONDATION" | "NOUVELLE_ROUTE" = "INONDATION") => (coords: [number, number][]) => coords.map((c) => ({ type, geometrie: { type: "Point", coordinates: c }, limites }));

      // ------------------------------------------------------------ 1. Sources : amorce et echelle
      const sources = await tx.sourceObservation.findMany({ orderBy: { code: "asc" } });
      verifier("l'amorce pose les quatre sources du produit", sources.map((s) => s.code).join(",") === "LANDSAT89,PLANETSCOPE,SENTINEL2,SPOT", sources.map((s) => s.code));
      verifier("aucune source amorcee n'est « active » (TRAITEMENT_OPERATIONNEL) ni meme verifiee", sources.every((s) => s.etat !== "TRAITEMENT_OPERATIONNEL" && s.derniereVerificationLe === null), sources.map((s) => [s.code, s.etat]));
      verifier("etats d'amorce : NON_CONFIGUREE (catalogue ouvert) ou EN_ATTENTE_CONFIGURATION (identifiants requis)",
        sources.every((s) => s.etat === (s.requiertIdentifiants ? "EN_ATTENTE_CONFIGURATION" : "NON_CONFIGUREE")), sources.map((s) => [s.code, s.etat, s.requiertIdentifiants]));
      const histo = await tx.sourceObservationEtat.groupBy({ by: ["sourceId"], _count: true });
      verifier("chaque source amorcee a exactement une ligne d'historique (creation)", histo.length === 4 && histo.every((h) => h._count === 1), histo);
      const synth0 = await calculerSynthese(depot);
      verifier("la synthese compte 4 sources, 0 active, tous les etats presents", synth0.sources.total === 4 && synth0.sources.actives === 0 && Object.keys(synth0.sources.parEtat).length === 8, synth0.sources);
      verifier("sans verdict ni proposition : taux nul (pas 0 %), echantillon insuffisant, propositions a zero",
        synth0.tauxConfirmation.valeur === null && synth0.tauxConfirmation.jugees === 0 && !synth0.tauxConfirmation.echantillonSuffisant && synth0.propositions.aVerifier === 0, synth0);
      verifier("la derniere acquisition est celle du produit reel le plus recent : le produit synthetique, plus recent, est ecarte", synth0.derniereAcquisition?.produitId === pNew.id, synth0.derniereAcquisition);

      const refusActive = await refusDeLaBase(tx, `UPDATE sources_observation SET etat = 'TRAITEMENT_OPERATIONNEL' WHERE code = 'SENTINEL2'`);
      verifier("la base refuse « active » sans date ni message de verification (contrainte src_obs_verification_requise)", !!refusActive && /src_obs_verification_requise/.test(refusActive), refusActive);
      const refusSecret = await refusDeLaBase(tx, `UPDATE sources_observation SET "configJson" = '{"apiKey":"x"}' WHERE code = 'SENTINEL2'`);
      verifier("la base refuse une cle d'apparence secrete dans la configuration d'une source", !!refusSecret && /src_obs_config_sans_secret/.test(refusSecret), refusSecret);
      const refusSupprSource = await refusDeLaBase(tx, `DELETE FROM sources_observation WHERE code = 'SPOT'`);
      verifier("une source ne se supprime pas physiquement", !!refusSupprSource && /suppression refusee/.test(refusSupprSource), refusSupprSource);
      const refusSansJournal = await refusDeLaBase(tx, `UPDATE sources_observation SET etat = 'CONFIGUREE' WHERE code = 'SENTINEL2'`);
      verifier("un changement d'etat sans ligne d'historique dans la meme transaction est refuse par la base", !!refusSansJournal && /pas de ligne d'historique/.test(refusSansJournal), refusSansJournal);

      const e1 = await changerEtatSource(depot, "SENTINEL2", { vers: "ACCESSIBLE", message: "Recherche anonyme du catalogue : reponse 200 (essai)" }, ctx);
      verifier("changerEtatSource : NON_CONFIGUREE vers ACCESSIBLE ecrit l'etat, le message, la date et l'historique",
        e1.changement && e1.source.etat === "ACCESSIBLE" && e1.source.derniereVerificationLe instanceof Date && !!e1.source.dernierMessage
        && (await tx.sourceObservationEtat.count({ where: { sourceId: e1.source.id } })) === 2, e1.source);
      const hist = await tx.sourceObservationEtat.findFirst({ where: { sourceId: e1.source.id, vers: "ACCESSIBLE" } });
      verifier("la ligne d'historique porte de, vers, auteur et message", hist?.de === "NON_CONFIGUREE" && hist.auteurId === "u-eo" && !!hist.message, hist);
      const e1b = await changerEtatSource(depot, "SENTINEL2", { vers: "ACCESSIBLE", message: "Nouveau test identique" }, ctx);
      verifier("un test qui ne change pas l'etat met a jour le message sans ecrire d'historique",
        !e1b.changement && e1b.source.dernierMessage === "Nouveau test identique" && (await tx.sourceObservationEtat.count({ where: { sourceId: e1.source.id } })) === 2);
      const r1a = await refusDuService(tx, () => changerEtatSource(depot, "SENTINEL2", { vers: "TRAITEMENT_OPERATIONNEL", message: "x", preuveTraitement: "run-1" }, ctx));
      verifier("TRAITEMENT_OPERATIONNEL est refuse depuis ACCESSIBLE (echelon non atteint)", r1a?.code === "ECHELON_NON_ATTEINT" && r1a.http === 400, r1a);
      await changerEtatSource(depot, "SENTINEL2", { vers: "PRODUIT_DISPONIBLE", message: "2 produits dans la fenetre (essai)" }, ctx);
      const r1b = await refusDuService(tx, () => changerEtatSource(depot, "SENTINEL2", { vers: "TRAITEMENT_OPERATIONNEL", message: "x" }, ctx));
      verifier("TRAITEMENT_OPERATIONNEL exige la reference d'un traitement reel reussi", r1b?.code === "PREUVE_TRAITEMENT_REQUISE", r1b);
      const r1c = await refusDuService(tx, () => changerEtatSource(depot, "LANDSAT89", { vers: "AUTHENTIFIEE", message: "x" }, ctx));
      verifier("AUTHENTIFIEE est refusee pour une source sans identifiants requis", r1c?.code === "ETAT_NON_APPLICABLE", r1c);
      const e2 = await changerEtatSource(depot, "PLANETSCOPE", { vers: "AUTHENTIFIEE", message: "Jeton valide (essai)" }, ctx);
      verifier("AUTHENTIFIEE est acceptee pour une source qui exige des identifiants", e2.source.etat === "AUTHENTIFIEE");
      const r1d = await refusDuService(tx, () => changerEtatSource(depot, "INCONNUE", { vers: "ACCESSIBLE", message: "x" }, ctx));
      verifier("une source inconnue : 404 SOURCE_INEXISTANTE", r1d?.code === "SOURCE_INEXISTANTE" && r1d.http === 404, r1d);
      const e3 = await changerEtatSource(depot, "SENTINEL2", { vers: "TRAITEMENT_OPERATIONNEL", message: "Traitement reel reussi (essai)", preuveTraitement: "run-essai-1" }, ctx);
      const synth1 = await calculerSynthese(depot);
      verifier("une source n'est active que par TRAITEMENT_OPERATIONNEL : la synthese en compte 1 apres ce passage (essai, annule ensuite)", e3.source.etat === "TRAITEMENT_OPERATIONNEL" && synth1.sources.actives === 1 && synth1.sources.parEtat.AUTHENTIFIEE === 1, synth1.sources);
      await changerEtatSource(depot, "SENTINEL2", { vers: "EN_ERREUR", message: "Essai : echec simule" }, ctx);

      // ------------------------------------------------------------ 2. Produits : tracabilite et deduplication
      const cat = (id: string, dateAcq: string, extra: Record<string, unknown> = {}) => ({
        palier: 0, source: "Sentinel-2 L2A", nature: "OPTIQUE", dateAcquisition: new Date(dateAcq), resolutionM: 10, couvertureNuagesPct: 12,
        incertitude: "non evaluee (produit catalogue)", provenance: `catalogue-essai/${id}`, licence: "relevee a la source (essai)", versionTraitement: "L2A",
        sourceCode: "SENTINEL2", fournisseur: "COPERNICUS", identifiantFournisseur: id, collection: "SENTINEL-2", capteur: "MSI", niveauTraitement: "L2A",
        orbite: "R138", scene: "T28PEB", resolutionNativeM: 10, licenceCode: "ESSAI", licenceAttribution: "Contient des donnees d'essai", emprise, ...extra,
      });
      const lotProduits = [cat("S2A_ESSAI_1", "2026-10-05"), cat("S2A_ESSAI_2", "2026-10-09"), cat("S2A_ESSAI_1", "2026-10-05")];
      const rap1 = await enregistrerProduits(depot, lotProduits, ctx);
      verifier("enregistrerProduits : 2 nouveaux, 1 deja connu (doublon dans le lot lui-meme)", rap1.nouveaux === 2 && rap1.dejaConnus === 1, rap1);
      verifier("le doublon du lot pointe le meme produit que le premier", rap1.produits[0].id === rap1.produits[2].id && rap1.produits[2].nouveau === false && rap1.produits[0].nouveau === true, rap1.produits);
      const rap2 = await enregistrerProduits(depot, lotProduits, ctx);
      verifier("un second import du meme lot : 0 nouveau, 3 deja connus, memes identifiants, aucune ligne ajoutee",
        rap2.nouveaux === 0 && rap2.dejaConnus === 3 && rap2.produits[0].id === rap1.produits[0].id && (await tx.earthObservationProduct.count({ where: { fournisseur: "COPERNICUS" } })) === 2, rap2);
      const prod1 = await tx.earthObservationProduct.findUniqueOrThrow({ where: { id: rap1.produits[0].id } });
      verifier("les champs de tracabilite sont ecrits (fournisseur, collection, capteur, orbite, scene, niveau, resolution native, licence, cycle de vie CATALOGUE)",
        prod1.collection === "SENTINEL-2" && prod1.capteur === "MSI" && prod1.orbite === "R138" && prod1.scene === "T28PEB" && prod1.niveauTraitement === "L2A"
        && prod1.resolutionNativeM === 10 && prod1.licenceCode === "ESSAI" && prod1.cycleVie === "CATALOGUE" && prod1.sourceCode === "SENTINEL2" && prod1.empreinteSha256 === null, prod1);
      const src2 = await tx.sourceObservation.findUniqueOrThrow({ where: { code: "SENTINEL2" } });
      verifier("la derniere acquisition de la source suit le produit le plus recent enregistre", src2.derniereAcquisitionLe?.toISOString().slice(0, 10) === "2026-10-09", src2.derniereAcquisitionLe);
      const avant = await tx.earthObservationProduct.count();
      const mauvais = await refusDuService(tx, () => enregistrerProduits(depot, [cat("S2A_ESSAI_3", "2026-10-10"), cat("S2A_ESSAI_4", "2026-10-11", { empreinteSha256: "pas-un-sha" })], ctx));
      verifier("un produit invalide fait refuser tout le lot (EMPREINTE_INVALIDE), rien n'est insere", mauvais?.code === "EMPREINTE_INVALIDE" && (await tx.earthObservationProduct.count()) === avant, mauvais);
      const inconnue = await refusDuService(tx, () => enregistrerProduits(depot, [cat("S2A_ESSAI_5", "2026-10-10", { sourceCode: "FANTOME" })], ctx));
      verifier("une source inconnue au registre est refusee (404 SOURCE_INCONNUE)", inconnue?.code === "SOURCE_INCONNUE" && inconnue.http === 404, inconnue);
      const sansFournisseur = await refusDuService(tx, () => enregistrerProduits(depot, [cat("S2A_ESSAI_6", "2026-10-10", { identifiantFournisseur: "" })], ctx));
      verifier("un produit de catalogue sans identifiant fournisseur est refuse", sansFournisseur?.code === "CHAMP_MANQUANT", sansFournisseur);
      const dupBase = await refusDeLaBase(tx, `INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId", fournisseur, "identifiantFournisseur")
        VALUES ('dup-1','dup-1',0,'s','RADAR',now(),10,'i','p','l','v',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326),'u-eo','COPERNICUS','S2A_ESSAI_1')`);
      verifier("la base refuse un doublon (fournisseur, identifiant fournisseur) meme par acces direct", !!dupBase && /already exists|23505/.test(dupBase), dupBase);
      const telSansSha = await refusDeLaBase(tx, `UPDATE earth_observation_products SET "cycleVie" = 'TELECHARGE' WHERE code = 'EO-REF'`);
      verifier("la base refuse « TELECHARGE » sans empreinte ni chemin de stockage", !!telSansSha && /eo_cycle_vie_coherent/.test(telSansSha), telSansSha);
      const sha = "a".repeat(64);
      const dl = await enregistrerProduits(depot, [cat("S2A_ESSAI_7", "2026-10-12", { cycleVie: "TELECHARGE", empreinteSha256: sha, stockageChemin: "eo/2026/S2A_ESSAI_7.zip" })], ctx);
      verifier("un produit TELECHARGE avec empreinte SHA-256 et chemin est accepte", dl.nouveaux === 1);
      const secret = await refusDuService(tx, () => enregistrerProduits(depot, [cat("S2A_ESSAI_8", "2026-10-12", { cycleVie: "TELECHARGE", empreinteSha256: sha, stockageChemin: "https://u:p@hote/f.zip" })], ctx));
      verifier("un chemin de stockage portant des identifiants de connexion est refuse", secret?.code === "STOCKAGE_AVEC_SECRET", secret);

      // ------------------------------------------------------------ 3. Depot : rattachement, confiance, candidats, region
      const pts = lot()([[-13.5975, 9.6401], [-13.5925, 9.6402], [-13.5925, 9.64005], [-13.45, 9.75]]);
      const sansLimites = await refusDuService(tx, () => deposerPropositions(depot, { produitId: pNew.id, methodeNom: "essai", methodeVersion: "v1", propositions: [{ ...pts[0], limites: undefined }] }, ctx));
      verifier("un depot sans limites est refuse (LIMITES_REQUISES) : une detection sans limites laisse croire qu'elle n'en a pas", sansLimites?.code === "LIMITES_REQUISES", sansLimites);
      const limBlanche = await refusDuService(tx, () => deposerPropositions(depot, { produitId: pNew.id, methodeNom: "essai", methodeVersion: "v1", propositions: [{ ...pts[0], limites: ["  "] }] }, ctx));
      verifier("une limite blanche est refusee", limBlanche?.code === "LIMITES_REQUISES", limBlanche);
      const dep = await deposerPropositions(depot, {
        produitId: pNew.id, produitReferenceId: pRef.id, methodeNom: "seuil-sar", methodeVersion: "v1", toleranceRattachementM: 100,
        propositions: pts.map((p, i) => ({ ...p, score: 0.9 - i * 0.1, confianceDetection: 0.8, priorite: i === 0 ? { niveau: "HAUTE" as const, regle: "essai : proche d'un troncon" } : null, imageCouvertureNuagesPct: 5, imageNote: "scene nette (essai)" })),
      }, ctx);
      const rows = await tx.propositionTeledetection.findMany({ where: { id: { in: dep.ids } } });
      const par = (i: number) => rows.find((r) => r.id === dep.ids[i])!;
      verifier("le lot est depose : 4 propositions, 3 rattachees, 1 non rattachee", dep.deposees === 4 && dep.rattachees === 3 && dep.nonRattachees === 1, dep);
      const oracle = await tx.$queryRawUnsafe<{ a: number; b: number }[]>(`SELECT ST_Distance(t.geom::geography, ST_SetSRID(ST_MakePoint(-13.5925, 9.6402),4326)::geography) AS a, (SELECT ST_Distance(u.geom::geography, ST_SetSRID(ST_MakePoint(-13.5925, 9.6402),4326)::geography) FROM troncons u WHERE u.id='t-eob') AS b FROM troncons t WHERE t.id='t-eoa'`);
      verifier("distance au troncon retenu = oracle SQL (geography)", proche(par(1).distanceTronconM ?? -1, Number(oracle[0].a), 0.001) && par(1).tronconId === "t-eoa", { lu: par(1).distanceTronconM, oracle: oracle[0].a });
      verifier("un seul troncon dans la tolerance : confiance HAUTE, aucun concurrent", par(0).rattachementConfiance === "HAUTE" && Array.isArray(par(0).rattachementCandidats) && (par(0).rattachementCandidats as unknown[]).length === 0, par(0).rattachementCandidats);
      const cand1 = par(1).rattachementCandidats as { tronconId: string; distanceM: number }[];
      verifier("deux troncons proches (22 m et 33 m) : confiance FAIBLE (ambiguite) et le concurrent est nomme, a sa vraie distance",
        par(1).rattachementConfiance === "FAIBLE" && cand1.length === 1 && cand1[0].tronconId === "t-eob" && proche(cand1[0].distanceM, Number(oracle[0].b), 0.001), { confiance: par(1).rattachementConfiance, cand1 });
      verifier("un concurrent nettement plus loin (> 2 fois) : confiance MOYENNE", par(2).rattachementConfiance === "MOYENNE" && par(2).tronconId === "t-eoa", par(2).rattachementConfiance);
      verifier("aucun troncon dans la tolerance : AUCUN, pas de troncon, pas de region", par(3).rattachementConfiance === "AUCUN" && par(3).tronconId === null && par(3).regionId === null && par(3).distanceTronconM === null, par(3));
      verifier("la region est denormalisee depuis le troncon retenu (region 1)", par(0).regionId === r1 && par(1).regionId === r1, [par(0).regionId, par(1).regionId, r1]);
      verifier("l'algorithme du rattachement est trace", par(0).rattachementAlgorithme === "PLUS_PROCHE_DANS_TOLERANCE_V1", par(0).rattachementAlgorithme);
      verifier("methode en deux champs et chaine composee", par(0).methodeNom === "seuil-sar" && par(0).methodeVersion === "v1" && par(0).methode === "seuil-sar v1", [par(0).methodeNom, par(0).methodeVersion, par(0).methode]);
      verifier("priorite (niveau + regle), confiance de detection non calibree, qualite d'image et limites sont ecrites",
        par(0).prioriteNiveau === "HAUTE" && !!par(0).prioriteRegle && par(1).prioriteNiveau === null && par(0).confianceDetection === 0.8 && par(0).confianceCalibree === false
        && par(0).imageCouvertureNuagesPct === 5 && par(0).imageNote === "scene nette (essai)" && par(0).limites.length === 1, par(0));
      verifier("les produits avant et apres sont lies (reference = avant, produit = apres)", par(0).produitId === pNew.id && par(0).produitReferenceId === pRef.id);
      const cen = await tx.$queryRawUnsafe<{ ok: boolean; pt: boolean }[]>(`SELECT ST_Intersects(geom, centre) AS ok, GeometryType(centre) = 'POINT' AS pt FROM propositions_teledetection WHERE id = '${dep.ids[0]}'`);
      verifier("le centre est un point calcule par la base, sur la geometrie", cen[0].ok && cen[0].pt, cen);
      const ligne = await deposerPropositions(depot, { produitId: pNew.id, methodeNom: "ligne", methodeVersion: "v1", propositions: [{ type: "NOUVELLE_ROUTE", geometrie: { type: "LineString", coordinates: [[-13.60, 9.70], [-13.59, 9.71]] }, limites }] }, ctx);
      const cenL = await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT ST_Intersects(geom, centre) AS ok FROM propositions_teledetection WHERE id = '${ligne.ids[0]}'`);
      verifier("sans tolerance : AUCUN rattachement tente (algorithme NON_DEMANDE), candidats nuls ; le centre d'une ligne est sur la ligne",
        (await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: ligne.ids[0] } })).rattachementAlgorithme === "NON_DEMANDE" && ligne.rattachees === 0 && cenL[0].ok);
      const horsEmprise = await refusDuService(tx, () => deposerPropositions(depot, { produitId: pNew.id, methodeNom: "x", methodeVersion: "v", propositions: lot()([[10, 10]]) }, ctx));
      verifier("une detection hors de l'emprise du produit est refusee (HORS_EMPRISE)", horsEmprise?.code === "HORS_EMPRISE", horsEmprise);
      const refNonAnt = await refusDuService(tx, () => deposerPropositions(depot, { produitId: pRef.id, produitReferenceId: pNew.id, methodeNom: "x", methodeVersion: "v", propositions: lot()([[-13.5, 9.7]]) }, ctx));
      verifier("une reference posterieure est refusee (REFERENCE_NON_ANTERIEURE)", refNonAnt?.code === "REFERENCE_NON_ANTERIEURE", refNonAnt);
      const synthSurReel = await refusDuService(tx, () => deposerPropositions(depot, { produitId: pNew.id, synthetique: true, methodeNom: "x", methodeVersion: "v", propositions: lot()([[-13.5, 9.7]]) }, ctx));
      verifier("un lot synthetique sur un produit reel est refuse (SYNTHETIQUE_INCOHERENT)", synthSurReel?.code === "SYNTHETIQUE_INCOHERENT", synthSurReel);
      const synthDirect = await refusDeLaBase(tx, `INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId", synthetique)
        VALUES ('syn-bad','${pNew.id}','INONDATION','m',ST_GeomFromText('POINT(-13.5 9.7)',4326),'u-eo',true)`);
      verifier("la base refuse aussi ce melange par acces direct", !!synthDirect && /synthetique et produit/.test(synthDirect), synthDirect);
      const directVerdict = await refusDeLaBase(tx, `INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId", statut, "verifieeParId", "verifieeLe", "motifVerdict", "constatRef")
        VALUES ('dir-bad','${pNew.id}','INONDATION','m',ST_GeomFromText('POINT(-13.5 9.7)',4326),'u-eo','CONFIRMEE','u-eo',now(),'m','c')`);
      verifier("la base refuse d'inserer une proposition directement avec un verdict", !!directVerdict && /entre A_VERIFIER/.test(directVerdict), directVerdict);
      const synLot = await deposerPropositions(depot, { produitId: pSyn.id, methodeNom: "demo", methodeVersion: "v0", propositions: lot()([[-13.5, 9.7], [-13.51, 9.71]]) }, ctx);
      const synRow = await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: synLot.ids[0] } });
      verifier("un lot sur un produit synthetique est marque synthetique par defaut", synRow.synthetique === true);

      // Ligne « d'avant la migration » (colonnes du workflow nulles) : le client la lit sans erreur.
      await tx.$executeRawUnsafe(`INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId") VALUES ('ancienne-1','${pNew.id}','INONDATION','seuil-sar v0',ST_GeomFromText('POINT(-13.5 9.7)',4326),'u-eo')`);
      const ancienne = await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: "ancienne-1" } });
      verifier("une ligne sans les colonnes du workflow se lit : limites NULL lue comme liste vide, rattachement non evalue (NULL), non synthetique",
        Array.isArray(ancienne.limites) && ancienne.limites.length === 0 && ancienne.rattachementConfiance === null && ancienne.prioriteNiveau === null && ancienne.synthetique === false && ancienne.statut === "A_VERIFIER", ancienne);

      // ------------------------------------------------------------ 4. Le referentiel n'est jamais touche par le depot
      const ref1 = await empreinteReferentiel(tx);
      verifier("PROUVE : troncons, portions et ouvrages sont inchanges apres produits, depots, rattachements (empreintes avant/apres)", ref1.t === ref0.t && ref1.p === ref0.p && ref1.o === ref0.o && ref1.n === ref0.n, { avant: ref0, apres: ref1 });
      await tx.$executeRawUnsafe("SAVEPOINT temoin");
      await tx.$executeRawUnsafe(`UPDATE troncons SET nom = 'modifie' WHERE id = 't-eoa'`);
      const refTemoin = await empreinteReferentiel(tx);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT temoin");
      verifier("temoin : modifier un troncon CHANGE l'empreinte (la comparaison n'est pas aveugle)", refTemoin.t !== ref0.t);

      // ------------------------------------------------------------ 5. Immuabilite de la detection (declencheur)
      const id0 = dep.ids[0];
      for (const [nom, sql, motif] of [
        ["la geometrie", `UPDATE propositions_teledetection SET geom = ST_GeomFromText('POINT(-13.5 9.7)',4326) WHERE id = '${id0}'`, /detection est figee/],
        ["le score", `UPDATE propositions_teledetection SET score = 0.1 WHERE id = '${id0}'`, /detection est figee/],
        ["la confiance de detection", `UPDATE propositions_teledetection SET "confianceDetection" = 0.2 WHERE id = '${id0}'`, /detection est figee/],
        ["les limites", `UPDATE propositions_teledetection SET limites = ARRAY['autre'] WHERE id = '${id0}'`, /detection est figee/],
        ["le rattachement (confiance)", `UPDATE propositions_teledetection SET "rattachementConfiance" = 'FAIBLE' WHERE id = '${id0}'`, /detection est figee/],
        ["le drapeau synthetique", `UPDATE propositions_teledetection SET synthetique = true WHERE id = '${id0}'`, /detection est figee/],
        ["la priorite", `UPDATE propositions_teledetection SET "prioriteNiveau" = 'FAIBLE' WHERE id = '${id0}'`, /detection est figee/],
        ["la region", `UPDATE propositions_teledetection SET "regionId" = ${r2} WHERE id = '${id0}'`, /region de la proposition est figee/],
        ["le produit", `UPDATE propositions_teledetection SET "produitId" = '${pRef.id}' WHERE id = '${id0}'`, /detection est figee/],
        ["la suppression", `DELETE FROM propositions_teledetection WHERE id = '${id0}'`, /suppression refusee/],
      ] as const) {
        const r = await refusDeLaBase(tx, sql);
        verifier(`le declencheur fige ${nom}`, !!r && motif.test(r), r);
      }

      // ------------------------------------------------------------ 6. Matrice des transitions (25 couples)
      const matrice = await deposerPropositions(depot, { produitId: pNew.id, methodeNom: "matrice", methodeVersion: "v1", propositions: lot()(Array.from({ length: 25 }, (_, i) => [-13.65 + i * 0.001, 9.6] as [number, number])) }, ctx);
      const demande = (propositionId: string, vers: string) => ({
        propositionId, vers, auteur: "u-eo", motif: `essai ${vers}`, commentaire: "commentaire d'essai",
        ...(vers === "EN_ATTENTE" ? { motifAttente: "INFO_DEMANDEE" } : {}), ...(vers === "CONFIRMEE" || vers === "INFIRMEE" ? { constatRef: "mission:ESSAI" } : {}),
      });
      let k = 0;
      for (const de of STATUTS_PROPOSITION) {
        for (const vers of STATUTS_PROPOSITION) {
          const id = matrice.ids[k++];
          if (de !== "A_VERIFIER") await changerStatut(depot, demande(id, de));
          const nJournal = await tx.propositionTeledetectionTransition.count({ where: { propositionId: id } });
          const r = await refusDuService(tx, () => changerStatut(depot, demande(id, vers)));
          const apres = await tx.propositionTeledetection.findUniqueOrThrow({ where: { id } });
          const nApres = await tx.propositionTeledetectionTransition.count({ where: { propositionId: id } });
          const permis = ATTENDU[de].includes(vers);
          if (permis) {
            const l = await tx.propositionTeledetectionTransition.findFirst({ where: { propositionId: id, de, vers } });
            verifier(`${de} vers ${vers} : autorisee, statut change et UNE ligne de journal (de, vers, auteur, motif)`,
              r === null && apres.statut === vers && nApres === nJournal + 1 && l?.de === de && l.vers === vers && l.auteurId === "u-eo" && l.motif === `essai ${vers}`, { r, statut: apres.statut, nJournal, nApres, l });
          } else {
            const codeAttendu = de === "CONFIRMEE" || de === "INFIRMEE" ? "VERDICT_DEFINITIF" : "TRANSITION_INTERDITE";
            verifier(`${de} vers ${vers} : interdite (${codeAttendu}, 409), statut inchange, aucune ligne de journal`,
              r?.code === codeAttendu && r.http === 409 && apres.statut === de && nApres === nJournal, { r, statut: apres.statut, nJournal, nApres });
          }
        }
      }
      // La base tient la meme regle, sans passer par le service : tout depart d'un verdict est refuse.
      const ids = { C: matrice.ids[15], I: matrice.ids[20] };
      const refusBase = [] as (string | null)[];
      for (const [de, id] of [["CONFIRMEE", ids.C], ["INFIRMEE", ids.I]] as const) {
        for (const vers of ["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"]) {
          if (vers === de) continue;
          refusBase.push(await refusDeLaBase(tx, `UPDATE propositions_teledetection SET statut = '${vers}', "verifieeParId" = NULL, "verifieeLe" = NULL, "motifVerdict" = NULL, "constatRef" = NULL WHERE id = '${id}'`));
        }
      }
      verifier("la base refuse toute sortie d'un verdict (8 essais directs, sans service)", refusBase.every((m) => !!m && /ne se reprend pas/.test(m)), refusBase);
      const rMotif = await refusDeLaBase(tx, `UPDATE propositions_teledetection SET "motifVerdict" = 'autre' WHERE id = '${ids.C}'`);
      verifier("la base refuse de modifier le motif d'un verdict", !!rMotif && /ne se reprend pas/.test(rMotif), rMotif);

      // ------------------------------------------------------------ 7. Journal exige par la base dans la meme transaction
      const libre = matrice.ids[0]; // A_VERIFIER (la case A -> A de la matrice n'a rien change)
      const sansLigne = await refusDeLaBase(tx, `UPDATE propositions_teledetection SET statut = 'NON_CONCLUANTE' WHERE id = '${libre}'`);
      verifier("PROUVE : un changement de statut par acces direct, sans ligne de journal dans la transaction, est refuse par la base", !!sansLigne && /ligne de journal dans la meme transaction/.test(sansLigne), sansLigne);
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
      await tx.$executeRawUnsafe("SAVEPOINT ordre");
      await tx.$executeRawUnsafe(`UPDATE propositions_teledetection SET statut = 'NON_CONCLUANTE' WHERE id = '${libre}'`);
      await tx.$executeRawUnsafe(`INSERT INTO propositions_teledetection_transitions (id, "propositionId", de, vers, "auteurId", motif) VALUES ('tr-ordre','${libre}','A_VERIFIER','NON_CONCLUANTE','u-eo','journal ecrit apres le changement')`);
      let ordreLibre: string | null = null;
      try { await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); } catch (e) { ordreLibre = e instanceof Error ? e.message : String(e); }
      verifier("l'ordre est libre dans la transaction : changement puis journal, controle a la validation, accepte", ordreLibre === null, ordreLibre);
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT ordre");
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      // Une ligne de journal portant d'autres statuts ne couvre pas le changement.
      await tx.$executeRawUnsafe("SAVEPOINT autre");
      let mauvaiseLigne: string | null = null;
      try {
        await tx.$executeRawUnsafe(`INSERT INTO propositions_teledetection_transitions (id, "propositionId", de, vers, "auteurId", motif) VALUES ('tr-x','${libre}','EN_ATTENTE','A_VERIFIER','u-eo','autres statuts')`);
        await tx.$executeRawUnsafe(`UPDATE propositions_teledetection SET statut = 'NON_CONCLUANTE' WHERE id = '${libre}'`);
      } catch (e) { mauvaiseLigne = e instanceof Error ? e.message : String(e); }
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT autre");
      verifier("une ligne de journal portant d'autres statuts (EN_ATTENTE vers A_VERIFIER au lieu de A_VERIFIER vers NON_CONCLUANTE) ne couvre pas le changement", !!mauvaiseLigne, mauvaiseLigne);

      // ------------------------------------------------------------ 8. Preuves de terrain
      const preuveLot = await deposerPropositions(depot, { produitId: pNew.id, methodeNom: "preuves", methodeVersion: "v1", toleranceRattachementM: 100, propositions: lot()([[-13.5970, 9.6401], [-13.5971, 9.6401], [-13.5972, 9.6401], [-13.45, 9.7]]) }, ctx);
      const sansConstat = await refusDuService(tx, () => changerStatut(depot, { propositionId: preuveLot.ids[0], vers: "CONFIRMEE", auteur: "u-eo", motif: "m" }));
      verifier("un verdict sans reference de constat ni observation est refuse (CONSTAT_REQUIS)", sansConstat?.code === "CONSTAT_REQUIS", sansConstat);
      const obsInconnue = await refusDuService(tx, () => changerStatut(depot, { propositionId: preuveLot.ids[0], vers: "CONFIRMEE", auteur: "u-eo", motif: "m", observationIds: ["o-inconnue"] }));
      verifier("une observation inexistante est refusee (OBSERVATION_INEXISTANTE) et rien n'est ecrit",
        obsInconnue?.code === "OBSERVATION_INEXISTANTE" && (await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: preuveLot.ids[0] } })).statut === "A_VERIFIER" && (await tx.propositionTeledetectionPreuve.count({ where: { propositionId: preuveLot.ids[0] } })) === 0, obsInconnue);
      const conf = await changerStatut(depot, { propositionId: preuveLot.ids[0], vers: "CONFIRMEE", auteur: "u-eo", motif: "Eau constatee sur la chaussee", observationIds: ["o-eo1", "o-eo2"] });
      const prs = await tx.propositionTeledetectionPreuve.findMany({ where: { propositionId: preuveLot.ids[0] } });
      verifier("un verdict cite des observations existantes : 2 preuves liees a la transition, constat derive des observations",
        prs.length === 2 && prs.every((p) => p.transitionId === conf.transitionId) && conf.proposition.constatRef === "observation:o-eo1;observation:o-eo2" && conf.proposition.verifieeParId === "u-eo" && conf.proposition.verifieeLe instanceof Date, { prs, constat: conf.proposition.constatRef });
      const apresV = await refusDuService(tx, () => ajouterPreuves(depot, { propositionId: preuveLot.ids[0], observationIds: ["o-eo1"], auteur: "u-eo2" }));
      verifier("ajouter une preuve a une proposition jugee est refuse (VERDICT_DEFINITIF)", apresV?.code === "VERDICT_DEFINITIF", apresV);
      const ap1 = await ajouterPreuves(depot, { propositionId: preuveLot.ids[1], observationIds: ["o-eo1", "o-eo1", "o-eo2"], auteur: "u-eo2" });
      const ap2 = await ajouterPreuves(depot, { propositionId: preuveLot.ids[1], observationIds: ["o-eo1"], auteur: "u-eo2" });
      verifier("un inspecteur ajoute des preuves sans decider : statut inchange, doublons ignores et comptes", ap1.ajoutees === 2 && ap2.ajoutees === 0 && ap2.dejaCitees === 1 && (await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: preuveLot.ids[1] } })).statut === "A_VERIFIER", { ap1, ap2 });
      const contenu = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'propositions_teledetection_preuves' AND column_name IN ('description','geom','lat','lon','type')`);
      verifier("les preuves ne copient aucun contenu d'observation (cle etrangere seule)", contenu[0].n === 0, contenu);
      const attente = await changerStatut(depot, { propositionId: preuveLot.ids[2], vers: "EN_ATTENTE", auteur: "u-eo", motif: "Photo illisible", motifAttente: "INFO_DEMANDEE" });
      const encore = await changerStatut(depot, { propositionId: preuveLot.ids[2], vers: "EN_ATTENTE", auteur: "u-eo", motif: "Seconde demande", motifAttente: "AUTRE" });
      verifier("EN_ATTENTE garde son motif d'attente ; une seconde demande sur une proposition deja en attente est une transition journalisee",
        attente.proposition.motifAttente === "INFO_DEMANDEE" && encore.proposition.motifAttente === "AUTRE" && (await tx.propositionTeledetectionTransition.count({ where: { propositionId: preuveLot.ids[2] } })) === 2, [attente.proposition.motifAttente, encore.proposition.motifAttente]);
      const sansMotifAttente = await refusDuService(tx, () => changerStatut(depot, { propositionId: preuveLot.ids[3], vers: "EN_ATTENTE", auteur: "u-eo", motif: "m" }));
      verifier("EN_ATTENTE sans motif d'attente est refuse", sansMotifAttente?.code === "MOTIF_ATTENTE_REQUIS", sansMotifAttente);
      const sortie = await changerStatut(depot, { propositionId: preuveLot.ids[2], vers: "A_VERIFIER", auteur: "u-eo", motif: "Information recue" });
      verifier("la sortie d'EN_ATTENTE efface le motif d'attente", sortie.proposition.motifAttente === null && sortie.proposition.statut === "A_VERIFIER");
      const audits = await tx.auditLog.groupBy({ by: ["action", "entityType"], where: { entityId: preuveLot.ids[2] }, _count: true });
      verifier("chaque transition est auditee dans la meme transaction (UPDATE x3 sur la proposition)", audits.length === 1 && audits[0].action === "UPDATE" && audits[0]._count === 3, audits);

      const rj = await refusDeLaBase(tx, `UPDATE propositions_teledetection_transitions SET motif = 'x'`);
      const rj2 = await refusDeLaBase(tx, `DELETE FROM propositions_teledetection_transitions`);
      const rp = await refusDeLaBase(tx, `UPDATE propositions_teledetection_preuves SET "ajouteeParId" = 'u-eo'`);
      const re = await refusDeLaBase(tx, `UPDATE sources_observation_etats SET message = 'x'`);
      verifier("journal des transitions, preuves et historique des etats de source : ajout seul (UPDATE et DELETE refuses)",
        [rj, rj2, rp, re].every((m) => !!m && /ajout seul/.test(m)), [rj, rj2, rp, re]);

      // ------------------------------------------------------------ 9. Perimetre territorial
      const regional2 = { national: false as const, regions: new Set([r2]) };
      const regional1 = { national: false as const, regions: new Set([r1]) };
      const pHors = preuveLot.ids[1]; // rattachee, region 1
      const horsA = await refusDuService(tx, () => changerStatut(depot, { propositionId: pHors, vers: "NON_CONCLUANTE", auteur: "u-eo", motif: "m", perimetre: regional2 }));
      verifier("un compte de la region 2 ne decide pas une proposition de la region 1 (403 HORS_PERIMETRE), statut inchange",
        horsA?.code === "HORS_PERIMETRE" && horsA.http === 403 && (await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: pHors } })).statut === "A_VERIFIER", horsA);
      const horsB = await refusDuService(tx, () => changerStatut(depot, { propositionId: preuveLot.ids[3], vers: "NON_CONCLUANTE", auteur: "u-eo", motif: "m", perimetre: regional1 }));
      verifier("une proposition non rattachee (region inconnue) n'est decidee que par un compte national", horsB?.code === "HORS_PERIMETRE", horsB);
      const horsC = await refusDuService(tx, () => dispatcherVerification(depot, pHors, {}, { ...ctx, perimetre: regional2 }));
      verifier("la mission de verification est refusee hors perimetre", horsC?.code === "HORS_PERIMETRE", horsC);
      const horsD = await refusDuService(tx, () => ajouterPreuves(depot, { propositionId: pHors, observationIds: ["o-eo2"], auteur: "u-eo2", perimetre: regional2 }));
      verifier("l'ajout de preuves est refuse hors perimetre", horsD?.code === "HORS_PERIMETRE", horsD);
      const okR = await changerStatut(depot, { propositionId: pHors, vers: "NON_CONCLUANTE", auteur: "u-eo", motif: "Terrain impraticable", perimetre: regional1 });
      verifier("un compte de la bonne region decide", okR.proposition.statut === "NON_CONCLUANTE");
      const okN = await changerStatut(depot, { propositionId: preuveLot.ids[3], vers: "NON_CONCLUANTE", auteur: "u-eo", motif: "m", perimetre: { national: true } });
      verifier("un compte national decide une proposition non rattachee", okN.proposition.statut === "NON_CONCLUANTE");

      // ------------------------------------------------------------ 10. Mission de verification : region, emprise, troncon
      const mRegion = await dispatcherVerification(depot, dep.ids[0], {}, ctx);
      const mInfo = await tx.$queryRawUnsafe<{ geotype: string; contient: boolean; aire: number; region: number | null }[]>(
        `SELECT GeometryType(m.emprise) AS geotype, ST_Contains(m.emprise, p.geom) AS contient, ST_Area(m.emprise) AS aire, m."regionId" AS region
           FROM missions m, propositions_teledetection p WHERE m.id = '${mRegion.id}' AND p.id = '${dep.ids[0]}'`);
      verifier("la mission de verification porte la REGION de la proposition", mInfo[0].region === r1 && mRegion.regionId === r1, mInfo);
      verifier("la mission porte une EMPRISE (polygone non degenere) qui contient la detection", mInfo[0].geotype === "POLYGON" && mInfo[0].contient && mInfo[0].aire > 0, mInfo);
      verifier("l'intitule de la mission nomme le troncon, et la proposition pointe la mission", mRegion.intitule.includes("EO-A") && (await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: dep.ids[0] } })).missionId === mRegion.id && /^VER-TD-[0-9A-Z]{8}$/.test(mRegion.code), mRegion.intitule);
      const deux = await refusDuService(tx, () => dispatcherVerification(depot, dep.ids[0], {}, ctx));
      verifier("une seconde mission est refusee (MISSION_DEJA_DEPECHEE)", deux?.code === "MISSION_DEJA_DEPECHEE" && deux.http === 409, deux);
      const mNon = await dispatcherVerification(depot, dep.ids[3], {}, ctx);
      const mNonInfo = await tx.$queryRawUnsafe<{ geotype: string }[]>(`SELECT GeometryType(emprise) AS geotype FROM missions WHERE id = '${mNon.id}'`);
      verifier("une proposition non rattachee : mission sans region (inconnue, dite telle) mais avec emprise", mNon.regionId === null && mNonInfo[0].geotype === "POLYGON", [mNon.regionId, mNonInfo]);
      const mJugee = await refusDuService(tx, () => dispatcherVerification(depot, preuveLot.ids[0], {}, ctx));
      verifier("pas de mission sur une proposition deja jugee", mJugee?.code === "VERDICT_DEJA_RENDU", mJugee);

      // ------------------------------------------------------------ 11. Taux de confirmation : 0, 1, 2, 29 et 30 verdicts
      const jeu = async (nom: string, confirmees: number, infirmees: number, enPlus = 1) => {
        const n = confirmees + infirmees + enPlus;
        const d = await deposerPropositions(depot, { produitId: pNew.id, methodeNom: nom, methodeVersion: "v1", propositions: lot()(Array.from({ length: n }, (_, i) => [-13.55 + i * 0.0005, 9.55] as [number, number])) }, ctx);
        for (let i = 0; i < confirmees; i++) await changerStatut(depot, { propositionId: d.ids[i], vers: "CONFIRMEE", auteur: "u-eo", motif: "ok", constatRef: "essai" });
        for (let i = 0; i < infirmees; i++) await changerStatut(depot, { propositionId: d.ids[confirmees + i], vers: "INFIRMEE", auteur: "u-eo", motif: "non", constatRef: "essai" });
        return d;
      };
      await jeu("taux-0", 0, 0, 3);
      await jeu("taux-1", 1, 0);
      await jeu("taux-2", 1, 1);
      await jeu("taux-29", 20, 9);
      await jeu("taux-30", 20, 10);
      const q = await qualiteMethodes(depot);
      const lq = (nom: string) => q.find((l) => l.methodeNom === nom)!;
      verifier("0 verdict : taux NUL (pas 0 %), effectif juge 0, echantillon insuffisant", lq("taux-0").tauxConfirmation === null && lq("taux-0").jugees === 0 && lq("taux-0").echantillonSuffisant === false && lq("taux-0").aVerifier === 3, lq("taux-0"));
      verifier("1 verdict (1 confirmee) : taux 1, effectif 1, echantillon insuffisant", lq("taux-1").tauxConfirmation === 1 && lq("taux-1").jugees === 1 && lq("taux-1").echantillonSuffisant === false, lq("taux-1"));
      verifier("2 verdicts (1 confirmee, 1 infirmee) : taux 0,5, echantillon insuffisant", lq("taux-2").tauxConfirmation === 0.5 && lq("taux-2").jugees === 2 && lq("taux-2").echantillonSuffisant === false, lq("taux-2"));
      verifier("29 verdicts (20 + 9) : echantillon insuffisant (seuil 30)", lq("taux-29").jugees === 29 && lq("taux-29").echantillonSuffisant === false && proche(lq("taux-29").tauxConfirmation ?? -1, 20 / 29, 1e-12), lq("taux-29"));
      verifier("30 verdicts (20 + 10) : echantillon suffisant, taux = 20/30", lq("taux-30").jugees === 30 && lq("taux-30").echantillonSuffisant === true && proche(lq("taux-30").tauxConfirmation ?? -1, 20 / 30, 1e-12), lq("taux-30"));
      verifier("le seuil de la base est egal a la constante de l'application (30, PROVISOIRE)", lq("taux-0").seuilEchantillon === SEUIL_ECHANTILLON_TAUX && SEUIL_ECHANTILLON_TAUX === 30, lq("taux-0").seuilEchantillon);
      verifier("les donnees synthetiques sont absentes de la vue de qualite", !q.some((l) => l.methodeNom === "demo"), q.map((l) => l.methodeNom));
      const prec = (await precision(depot)).find((l) => l.methode === "taux-2 v1");
      verifier("la vue historique `precision_teledetection` est conservee et coherente (1 / 2)", prec?.precision === 0.5 && prec.total === 3, prec);

      // ------------------------------------------------------------ 12. Synthese : compteurs, taux, perimetre, fraicheur
      const maintenant = new Date("2026-10-25T12:00:00Z");
      const s = await calculerSynthese(depot, { maintenant });
      const gb = await tx.propositionTeledetection.groupBy({ by: ["statut"], where: { synthetique: false }, _count: true });
      const gn = (st: string) => gb.find((g) => g.statut === st)?._count ?? 0;
      verifier("la synthese egale les comptes de la table, par statut (hors synthetiques)",
        s.propositions.aVerifier === gn("A_VERIFIER") && s.propositions.enAttente === gn("EN_ATTENTE") && s.propositions.nonConcluantes === gn("NON_CONCLUANTE")
        && s.propositions.confirmees === gn("CONFIRMEE") && s.propositions.infirmees === gn("INFIRMEE"), { s: s.propositions, gb });
      verifier("le taux de la synthese = confirmees / (confirmees + infirmees) des comptes de la table",
        s.tauxConfirmation.jugees === gn("CONFIRMEE") + gn("INFIRMEE") && proche(s.tauxConfirmation.valeur ?? -1, gn("CONFIRMEE") / (gn("CONFIRMEE") + gn("INFIRMEE")), 1e-12) && s.tauxConfirmation.seuil === 30, s.tauxConfirmation);
      verifier("prioritaires = HAUTE encore a decider", s.propositions.prioritaires === 1, s.propositions);
      // Oracle : le produit reel le plus recent est le produit de catalogue du 12/10/2026 ; le 25/10 a midi, il a 13 jours.
      verifier("derniere acquisition = produit reel le plus recent (12/10/2026) et fraicheur = 13 jours",
        s.derniereAcquisition?.date.slice(0, 10) === "2026-10-12" && s.fraicheur.ageDerniereAcquisitionJours === 13 && s.fraicheur.dateCalcul === maintenant.toISOString(), { d: s.derniereAcquisition, f: s.fraicheur });
      const sR2 = await calculerSynthese(depot, { maintenant, perimetre: regional2 });
      verifier("un compte de la region 2 ne compte aucune proposition (les rattachees sont en region 1, les autres sont nationales)", Object.values(sR2.propositions).every((v) => v === 0) && sR2.tauxConfirmation.valeur === null && sR2.tauxConfirmation.jugees === 0, sR2.propositions);
      const sR1 = await calculerSynthese(depot, { maintenant, perimetre: regional1 });
      const r1Compte = await tx.propositionTeledetection.count({ where: { regionId: r1, synthetique: false } });
      verifier("un compte de la region 1 ne compte que les propositions de sa region",
        Object.entries(sR1.propositions).filter(([k]) => k !== "prioritaires").reduce((a, [, v]) => a + (v as number), 0) === r1Compte && r1Compte > 0 && r1Compte < Object.entries(s.propositions).filter(([k]) => k !== "prioritaires").reduce((a, [, v]) => a + (v as number), 0), { sR1: sR1.propositions, r1Compte });
      const horsSynth = await refusDuService(tx, () => calculerSynthese(depot, { perimetre: regional1, regionId: r2 }));
      verifier("demander une region hors de son perimetre est refuse (HORS_PERIMETRE)", horsSynth?.code === "HORS_PERIMETRE" && horsSynth.http === 403, horsSynth);
      const sPeriode = await calculerSynthese(depot, { maintenant, depuis: new Date("2030-01-01"), jusqua: new Date("2030-12-31") });
      verifier("une periode sans propositions : zeros vrais, taux nul, echantillon insuffisant", Object.values(sPeriode.propositions).every((v) => v === 0) && sPeriode.tauxConfirmation.valeur === null && sPeriode.periode.depuis !== null, sPeriode);

      // ------------------------------------------------------------ 13. Le referentiel, a la fin de tout
      const ref2 = await empreinteReferentiel(tx);
      verifier("PROUVE (fin de banc) : troncons, portions et ouvrages toujours inchanges apres transitions, missions, preuves, synthese", ref2.t === ref0.t && ref2.p === ref0.p && ref2.o === ref0.o, { avant: ref0, apres: ref2 });
      const ecrits = await tx.auditLog.groupBy({ by: ["entityType"], where: { userId: { in: ["u-eo", "u-eo2"] } }, _count: true });
      const types = new Set(ecrits.map((e) => e.entityType));
      verifier("l'audit ne nomme que des entites de teledetection et des missions (jamais Troncon, Portion, Ouvrage)", ![...types].some((t) => ["Troncon", "Portion", "Ouvrage"].includes(t)) && types.has("PropositionTeledetection") && types.has("Mission") && types.has("SourceObservation") && types.has("EarthObservationProduct"), [...types]);
      throw new Annulation();
    }, { timeout: 300_000, maxWait: 20_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  verifier("rien ne subsiste apres l'annulation (0 proposition, 0 ligne de journal, sources d'amorce a 4)",
    (await prisma.propositionTeledetection.count()) === 0 && (await prisma.propositionTeledetectionTransition.count()) === 0 && (await prisma.sourceObservation.count()) === 4
    && (await prisma.sourceObservation.count({ where: { etat: "TRAITEMENT_OPERATIONNEL" } })) === 0);
  await sectionCommits();
  conclure();
}

// ================================================================ SECTION COMMITS REELS (EO-FIX-BACK 6) : un clone qui COMMITTE
//
// Tout ce qui precede tourne dans UNE transaction annulee, avec les contraintes differees passees en IMMEDIATE : un declencheur differe n'y est
// jamais joue au COMMIT. Les gardes du journal (migration 20261028130000) se jouent AU COMMIT : elles ne se prouvent qu'avec de vrais COMMIT.
// Cette section clone la base du banc (`essai_eo_workflow_commit`, autorisee par la garde), y committe pour de vrai, puis detruit le clone.
// Le clone ne peut pas se faire pendant que le banc est connecte a son modele : la connexion Prisma est fermee avant.
async function sectionCommits() {
  await prisma.$disconnect();
  const { Client } = (await import("pg")).default;
  const origine = process.env.DATABASE_URL!;
  const versBase = (base: string) => { const u = new URL(origine); u.pathname = `/${base}`; return u.toString(); };
  const NOM = "essai_eo_workflow_commit";
  const admin = new Client({ connectionString: versBase("postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${NOM} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${NOM} TEMPLATE ${new URL(origine).pathname.slice(1)}`);
  const c = new Client({ connectionString: versBase(NOM) });
  await c.connect();
  const clonePrisma = new PrismaClient({ datasourceUrl: versBase(NOM) });
  try {
    const q = async (texte: string, p: unknown[] = []) => (await c.query(texte, p)).rows;
    /** Une transaction REELLE : BEGIN, les ordres, COMMIT. Rend le message de refus (a l'ordre ou au COMMIT differe), ou null. */
    const tenter = async (ordres: string[]): Promise<string | null> => {
      await c.query("BEGIN");
      try {
        for (const o of ordres) await c.query(o);
        await c.query("COMMIT");
        return null;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        return e instanceof Error ? e.message : String(e);
      }
    };
    const statut = async (id: string) => (await q(`SELECT statut, "motifAttente", "verifieeParId" FROM propositions_teledetection WHERE id = $1`, [id]))[0];
    const nJournal = async (id: string) => Number((await q(`SELECT count(*) n FROM propositions_teledetection_transitions WHERE "propositionId" = $1`, [id]))[0].n);
    let sequence = 0;
    const jr = (id: string, de: string, vers: string, auteur: string, motifAttente: string | null = null) =>
      `INSERT INTO propositions_teledetection_transitions (id, "propositionId", de, vers, "auteurId", motif, "motifAttente") VALUES ('j-${++sequence}', '${id}', '${de}', '${vers}', '${auteur}', 'essai', ${motifAttente ? `'${motifAttente}'` : "NULL"})`;
    const maj = (id: string, set: string) => `UPDATE propositions_teledetection SET ${set} WHERE id = '${id}'`;
    const VERDICT = (auteur: string) => `statut = 'CONFIRMEE', "verifieeParId" = '${auteur}', "motifVerdict" = 'm', "constatRef" = 'c'`;

    await q(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('c-u1','c1@local.invalid','C1','x','GESTIONNAIRE',now()), ('c-u2','c2@local.invalid','C2','x','GESTIONNAIRE',now())`);
    await q(`INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
      VALUES ('c-p','c-p',0,'s','RADAR','2026-10-01',10,'i','p','l','v',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326),'c-u1')`);
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]) {
      await q(`INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId", limites) VALUES ('${id}','c-p','INONDATION','m',ST_GeomFromText('POINT(0.5 0.5)',4326),'c-u1',ARRAY['l'])`);
    }

    // ---- les parcours LEGITIMES passent avec de vrais COMMIT
    verifier("COMMIT reel : un verdict avec sa ligne de journal et son auteur est accepte",
      (await tenter([jr("c1", "A_VERIFIER", "CONFIRMEE", "c-u1"), maj("c1", VERDICT("c-u1"))])) === null && (await statut("c1")).statut === "CONFIRMEE");
    verifier("COMMIT reel : l'ordre est libre (changement puis ligne de journal)",
      (await tenter([maj("c2", "statut = 'NON_CONCLUANTE'"), jr("c2", "A_VERIFIER", "NON_CONCLUANTE", "c-u1")])) === null && (await statut("c2")).statut === "NON_CONCLUANTE");

    // ---- (a) le motif d'attente est journalise
    await tenter([jr("c3", "A_VERIFIER", "EN_ATTENTE", "c-u1", "INFO_DEMANDEE"), maj("c3", `statut = 'EN_ATTENTE', "motifAttente" = 'INFO_DEMANDEE'`)]);
    const a1 = await tenter([maj("c3", `"motifAttente" = 'AUTRE'`)]);
    verifier("(a) changer le motif d'attente SANS ligne de journal est refuse au COMMIT, le motif est inchange, aucune ligne ajoutee",
      !!a1 && /n'a pas SA ligne de journal/.test(a1) && (await statut("c3")).motifAttente === "INFO_DEMANDEE" && (await nJournal("c3")) === 1, a1);
    const a2 = await tenter([jr("c3", "EN_ATTENTE", "EN_ATTENTE", "c-u1", "AUTRE"), maj("c3", `"motifAttente" = 'AUTRE'`)]);
    verifier("(a) avec sa ligne (EN_ATTENTE vers EN_ATTENTE, motif AUTRE), le changement de motif est accepte", a2 === null && (await statut("c3")).motifAttente === "AUTRE" && (await nJournal("c3")) === 2, a2);
    const a3 = await tenter([jr("c3", "EN_ATTENTE", "EN_ATTENTE", "c-u1", "AUTRE")]);
    verifier("(a) la nouvelle demande SANS changement de colonne (meme motif) garde sa ligne de journal : acceptee", a3 === null && (await nJournal("c3")) === 3, a3);

    // ---- (b) le comptage est exact
    const b1 = await tenter([
      jr("c4", "A_VERIFIER", "NON_CONCLUANTE", "c-u1"), jr("c4", "NON_CONCLUANTE", "A_VERIFIER", "c-u1"),
      maj("c4", "statut = 'NON_CONCLUANTE'"), maj("c4", "statut = 'A_VERIFIER'"), maj("c4", "statut = 'NON_CONCLUANTE'")]);
    verifier("(b) trois changements de statut et DEUX lignes de journal : refuse au COMMIT, statut et journal inchanges",
      !!b1 && /n'a pas SA ligne de journal/.test(b1) && (await statut("c4")).statut === "A_VERIFIER" && (await nJournal("c4")) === 0, b1);
    const b2 = await tenter([
      jr("c4", "A_VERIFIER", "NON_CONCLUANTE", "c-u1"), jr("c4", "NON_CONCLUANTE", "A_VERIFIER", "c-u1"), jr("c4", "A_VERIFIER", "NON_CONCLUANTE", "c-u1"),
      maj("c4", "statut = 'NON_CONCLUANTE'"), maj("c4", "statut = 'A_VERIFIER'"), maj("c4", "statut = 'NON_CONCLUANTE'")]);
    verifier("(b) trois changements et TROIS lignes : accepte", b2 === null && (await statut("c4")).statut === "NON_CONCLUANTE" && (await nJournal("c4")) === 3, b2);
    const b3 = await tenter([jr("c5", "A_VERIFIER", "NON_CONCLUANTE", "c-u1"), jr("c5", "A_VERIFIER", "NON_CONCLUANTE", "c-u1"), maj("c5", "statut = 'NON_CONCLUANTE'")]);
    verifier("(b) deux lignes de journal pour un seul changement : refuse (la ligne en trop est un mensonge du journal)", !!b3 && /ne correspond a aucun changement/.test(b3) && (await nJournal("c5")) === 0, b3);
    const b4 = await tenter(["SAVEPOINT s", maj("c5", "statut = 'NON_CONCLUANTE'"), "ROLLBACK TO SAVEPOINT s"]);
    verifier("un changement annule par ROLLBACK TO SAVEPOINT n'est pas compte : la transaction passe sans ligne de journal", b4 === null && (await statut("c5")).statut === "A_VERIFIER", b4);
    const b5 = await tenter([maj("c5", "statut = 'NON_CONCLUANTE'"), "SAVEPOINT s", maj("c5", "statut = 'A_VERIFIER'"), "ROLLBACK TO SAVEPOINT s", jr("c5", "A_VERIFIER", "NON_CONCLUANTE", "c-u1")]);
    verifier("un changement garde AVANT un point de sauvegarde, un autre annule : seul le garde exige sa ligne", b5 === null && (await statut("c5")).statut === "NON_CONCLUANTE", b5);

    // ---- (c) l'auteur du verdict est l'auteur de la ligne de journal
    const c1 = await tenter([jr("c6", "A_VERIFIER", "CONFIRMEE", "c-u1"), maj("c6", VERDICT("c-u2"))]);
    verifier("(c) un verdict signe c-u2 alors que la ligne de journal est de c-u1 est refuse au COMMIT",
      !!c1 && /pas signe par l'auteur/.test(c1) && (await statut("c6")).statut === "A_VERIFIER", c1);
    const c2 = await tenter([jr("c6", "A_VERIFIER", "CONFIRMEE", "c-u2"), maj("c6", VERDICT("c-u2"))]);
    verifier("(c) signe par l'auteur de sa ligne : accepte", c2 === null && (await statut("c6")).verifieeParId === "c-u2", c2);

    // ---- (d) produits : provenance, dates et emprise figees
    const anomalies = async () => Number((await q(`SELECT count(*) n FROM coherence_teledetection`))[0].n);
    const avantAnomalies = await anomalies();
    for (const [nom, set] of [
      ["synthetique", "synthetique = true"], ["emprise", `emprise = ST_GeomFromText('POLYGON((10 10,11 10,11 11,10 11,10 10))',4326)`], ["dateAcquisition", `"dateAcquisition" = '2026-08-01'`],
      ["identifiantFournisseur", `fournisseur = 'X', "identifiantFournisseur" = 'Y'`], ["resolutionM", `"resolutionM" = 30`], ["code", `code = 'autre'`],
    ] as const) {
      const r = await tenter([`UPDATE earth_observation_products SET ${set} WHERE id = 'c-p'`]);
      verifier(`(d) modifier ${nom} d'un produit est refuse (COMMIT reel) et la colonne est nommee`, !!r && /sont figees/.test(r) && r.includes(nom), r);
    }
    verifier("(d) la vue de coherence reste a son compte apres ces tentatives", (await anomalies()) === avantAnomalies, { avantAnomalies, apres: await anomalies() });
    const d1 = await tenter([`UPDATE earth_observation_products SET "cycleVie" = 'TELECHARGE', "empreinteSha256" = '${"a".repeat(64)}', "stockageChemin" = 'eo/c-p.zip', incertitude = 'revisee' WHERE id = 'c-p'`]);
    verifier("(d) le cycle de vie, l'empreinte, le chemin de stockage et l'incertitude restent modifiables (le produit est telecharge)", d1 === null, d1);
    const d2 = await tenter([`SET LOCAL bdri.correction_produit_motif = 'court'`, `SET LOCAL bdri.correction_produit_auteur = 'c-u1'`, `UPDATE earth_observation_products SET synthetique = true WHERE id = 'c-p'`]);
    verifier("(d) une correction exige un motif de 10 caracteres au moins", !!d2 && /sont figees/.test(d2), d2);
    const d3 = await tenter([`SET LOCAL bdri.correction_produit_motif = 'Date corrigee apres releve du fournisseur'`, `SET LOCAL bdri.correction_produit_auteur = 'inconnu'`, `UPDATE earth_observation_products SET "dateAcquisition" = '2026-10-02' WHERE id = 'c-p'`]);
    verifier("(d) une correction exige un auteur connu", !!d3 && /n'est pas un compte connu/.test(d3), d3);
    const compterAudit = async () => Number((await q(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'EarthObservationProduct' AND "entityId" = 'c-p'`))[0].n);
    const auditAvant = await compterAudit();
    const d4 = await tenter([`SET LOCAL bdri.correction_produit_motif = 'Date corrigee apres releve du fournisseur'`, `SET LOCAL bdri.correction_produit_auteur = 'c-u1'`, `UPDATE earth_observation_products SET "dateAcquisition" = '2026-10-02' WHERE id = 'c-p'`]);
    const aud = await q(`SELECT "userId", action, before, after FROM audit_logs WHERE "entityType" = 'EarthObservationProduct' AND "entityId" = 'c-p' ORDER BY "createdAt" DESC LIMIT 1`);
    verifier("(d) la correction explicite passe ET est journalisee : auteur, motif, ancienne et nouvelle valeur dans audit_logs",
      d4 === null && (await compterAudit()) === auditAvant + 1 && aud[0].userId === "c-u1" && aud[0].action === "UPDATE" && /Date corrigee/.test(aud[0].after.motif)
      && String(aud[0].before.colonnes.dateAcquisition).startsWith("2026-10-01") && String(aud[0].after.colonnes.dateAcquisition).startsWith("2026-10-02"), { d4, aud });
    const d5 = await tenter([`UPDATE earth_observation_products SET "dateAcquisition" = '2026-10-03' WHERE id = 'c-p'`]);
    verifier("(d) la variable de correction ne survit pas a sa transaction : la modification suivante, sans motif, est de nouveau refusee", !!d5 && /sont figees/.test(d5), d5);

    // ---- le SERVICE, de bout en bout, avec de vrais COMMIT (une transaction par appel, comme en production)
    const att = await changerStatut(clonePrisma as never, { propositionId: "c7", vers: "EN_ATTENTE", auteur: "c-u1", motif: "Information demandee", motifAttente: "INFO_DEMANDEE" });
    const att2 = await changerStatut(clonePrisma as never, { propositionId: "c7", vers: "EN_ATTENTE", auteur: "c-u1", motif: "Seconde demande identique", motifAttente: "INFO_DEMANDEE" });
    const att3 = await changerStatut(clonePrisma as never, { propositionId: "c7", vers: "EN_ATTENTE", auteur: "c-u1", motif: "Motif change", motifAttente: "AUTRE" });
    const fin = await changerStatut(clonePrisma as never, { propositionId: "c7", vers: "INFIRMEE", auteur: "c-u2", motif: "Chaussee seche", constatRef: "mission:ESSAI" });
    verifier("SERVICE, COMMIT reels : mise en attente, nouvelle demande identique, changement de motif, verdict : tout passe les gardes du COMMIT, 4 lignes de journal, verdict signe de son auteur",
      att.vers === "EN_ATTENTE" && att2.vers === "EN_ATTENTE" && att3.proposition.motifAttente === "AUTRE" && fin.proposition.statut === "INFIRMEE" && fin.proposition.verifieeParId === "c-u2" && (await nJournal("c7")) === 4, { n: await nJournal("c7") });
  } finally {
    await clonePrisma.$disconnect();
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${NOM} WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
