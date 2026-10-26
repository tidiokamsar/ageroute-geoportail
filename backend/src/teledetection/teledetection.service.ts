/**
 * Service de l'observation de la Terre (partie E) : registre des produits et des sources, depot des
 * propositions, transitions de statut, verdict du terrain, mission de verification, indicateurs.
 *
 * IL NE TELECHARGE RIEN ET NE TRAITE AUCUNE IMAGE. Le moteur de changement est hors de ce depot ;
 * ce service recoit ce qu'il produit -- des geometries avec un type, une methode et un score --
 * et les tient pour des PROPOSITIONS. AUCUNE n'ecrit dans le referentiel (`troncons`, `portions`,
 * `ouvrages`) : le banc `eo-workflow` le prouve en comparant des empreintes avant et apres.
 *
 * LE RATTACHEMENT A UN TRONCON n'est fait que si l'appelant donne une tolerance, en metres : le
 * troncon vivant le plus proche dans ce rayon, avec sa confiance et les concurrents dans le rayon.
 * Aucune tolerance n'est supposee ; sans elle, la proposition reste non rattachee, et c'est dit.
 *
 * Toute ecriture est auditee dans la meme transaction. Tout changement de statut a sa ligne de
 * journal dans cette transaction : le service l'ecrit, la base l'exige (declencheur differe).
 *
 * LE PERIMETRE TERRITORIAL est un parametre (`perimetre`) des fonctions qui decident : un compte
 * regional n'agit que sur les propositions de ses regions (refus `HORS_PERIMETRE`, 403). Sans
 * perimetre, aucun controle : c'est a l'appelant (la route) de le fournir.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import { observationDansPortee } from "./observation.perimetre";
import {
  CANDIDATS_CONCURRENTS_MAX, MARGE_EMPRISE_MISSION_DEG,
  calculerTauxConfirmation, ageEnJours, codeMissionTeledetection, codeProduitCatalogue, compterSourcesParEtat, construireConstatRef,
  estDefinitif, evaluerRattachement, verifierChangementEtatSource, verifierDepecheVerification, verifierDeuxDates,
  verifierPerimetreProposition, verifierProduit, verifierProduitCatalogue, verifierPropositionDeposee, verifierTracabilite,
  verifierTransition,
  type CandidatTroncon, type ChangementEtatSource, type PerimetreEo, type ProduitCatalogueSaisi, type ProduitSaisi,
  type StatutProposition, type TracabiliteProduit, type TypeProposition, type Verdict,
} from "./teledetection.noyau";

/** Client Prisma ou client de transaction : seulement ce que ce service utilise. */
type ClientTx = Pick<
  Prisma.TransactionClient,
  | "$queryRaw" | "$executeRaw" | "earthObservationProduct" | "propositionTeledetection" | "mission" | "sourceObservation"
  | "sourceObservationEtat" | "propositionTeledetectionTransition" | "propositionTeledetectionPreuve" | "observation" | "auditLog"
>;
/** `$transaction` est facultatif : un client DEJA dans une transaction (EO-API, bancs) n'en ouvre pas de seconde. */
export type DepotTeledetection = ClientTx & { $transaction?: PrismaClient["$transaction"] };

/** Delai technique des transactions de lot (milliers de lignes) ; la valeur par defaut de Prisma (5 s) est trop courte. */
const OPTIONS_LOT = { timeout: 120_000, maxWait: 10_000 } as const;

async function dansTransaction<T>(depot: DepotTeledetection, f: (tx: ClientTx) => Promise<T>, lot = false): Promise<T> {
  return depot.$transaction ? depot.$transaction((tx) => f(tx), lot ? OPTIONS_LOT : undefined) : f(depot);
}

export class RefusTeledetection extends Error {
  constructor(public readonly code: string, message: string, public readonly http: 400 | 403 | 404 | 409 = 409) { super(message); }
}

const HTTP_PAR_CODE: Record<string, 400 | 403 | 404 | 409> = {
  VERDICT_DEFINITIF: 409, VERDICT_DEJA_RENDU: 409, TRANSITION_INTERDITE: 409, MISSION_DEJA_DEPECHEE: 409, HORS_PERIMETRE: 403,
};

function exiger(v: Verdict): void {
  if (!v.ok) throw new RefusTeledetection(v.code, v.motif, HTTP_PAR_CODE[v.code] ?? 400);
}

interface Contexte { auteurId: string; ipAddress?: string; perimetre?: PerimetreEo }

/**
 * GeoJSON minimal : le service n'en juge que le type. Des coordonnees absentes ou fausses font
 * echouer `ST_GeomFromGeoJSON`, puis la contrainte `ST_IsValid` : c'est la base qui tranche.
 */
export interface GeometrieGeoJson { type: string; coordinates?: unknown }

// ============================================================ produits

type ProduitAEnregistrer = ProduitSaisi & TracabiliteProduit & { code: string; emprise: GeometrieGeoJson };

/**
 * Insere un produit. En mode `dedupliquer`, un produit deja connu du meme fournisseur (meme identifiant
 * fournisseur) n'est pas reinsere : la base le tient par l'unicite (fournisseur, identifiantFournisseur).
 * La geometrie n'est pas geree par Prisma : une seule insertion parametree, emprise comprise.
 */
async function insererProduit(tx: ClientTx, id: string, p: ProduitAEnregistrer, ctx: Contexte, dedupliquer: boolean): Promise<boolean> {
  const emprise = JSON.stringify(p.emprise);
  // `$executeRaw` rend le nombre de lignes inserees : 0 quand le produit etait deja connu (ON CONFLICT DO NOTHING).
  const inseres = await tx.$executeRaw`INSERT INTO "earth_observation_products"
      ("id", "code", "palier", "source", "nature", "dateAcquisition", "dateFin", "resolutionM", "couvertureNuagesPct",
       "incertitude", "provenance", "licence", "versionTraitement", "autorisationDepenseRef", "emprise", "enregistreParId",
       "sourceCode", "fournisseur", "identifiantFournisseur", "collection", "capteur", "orbite", "scene", "niveauTraitement",
       "resolutionNativeM", "empreinteSha256", "stockageChemin", "cycleVie", "licenceCode", "licenceAttribution", "synthetique")
      VALUES (${id}, ${p.code}, ${p.palier}, ${p.source.trim()}, ${p.nature}, ${p.dateAcquisition}, ${p.dateFin ?? null}, ${p.resolutionM},
              ${p.couvertureNuagesPct ?? null}, ${p.incertitude.trim()}, ${p.provenance.trim()}, ${p.licence.trim()}, ${p.versionTraitement.trim()},
              ${p.autorisationDepenseRef?.trim() || null}, ST_SetSRID(ST_GeomFromGeoJSON(${emprise}), 4326), ${ctx.auteurId},
              ${p.sourceCode ?? null}, ${p.fournisseur?.trim() ?? null}, ${p.identifiantFournisseur?.trim() ?? null}, ${p.collection?.trim() ?? null},
              ${p.capteur?.trim() ?? null}, ${p.orbite?.trim() ?? null}, ${p.scene?.trim() ?? null}, ${p.niveauTraitement?.trim() ?? null},
              ${p.resolutionNativeM ?? null}, ${p.empreinteSha256 ?? null}, ${p.stockageChemin?.trim() ?? null}, ${p.cycleVie ?? "CATALOGUE"},
              ${p.licenceCode?.trim() ?? null}, ${p.licenceAttribution?.trim() ?? null}, ${p.synthetique ?? false})
      ${dedupliquer ? Prisma.sql`ON CONFLICT ("fournisseur", "identifiantFournisseur") DO NOTHING` : Prisma.empty}`;
  return inseres === 1;
}

/** Enregistre un produit (une ligne). Le code est donne par l'appelant et doit etre libre. */
export async function enregistrerProduit(depot: DepotTeledetection, p: ProduitAEnregistrer, ctx: Contexte) {
  exiger(verifierProduit(p));
  exiger(verifierTracabilite(p));
  if (p.emprise?.type !== "Polygon") throw new RefusTeledetection("EMPRISE_INVALIDE", "L'emprise est un Polygon GeoJSON en EPSG:4326.", 400);
  if (await depot.earthObservationProduct.findUnique({ where: { code: p.code } })) {
    throw new RefusTeledetection("CODE_EXISTANT", `Le code ${p.code} est deja pris.`, 409);
  }
  const id = randomUUID();
  return dansTransaction(depot, async (tx) => {
    await inserer(() => insererProduit(tx, id, p, ctx, false));
    const produit = await tx.earthObservationProduct.findUniqueOrThrow({ where: { id } });
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "CREATE", entityType: "EarthObservationProduct", entityId: id,
      after: { code: p.code, palier: p.palier, source: p.source, nature: p.nature, licence: p.licence, provenance: p.provenance },
      ipAddress: ctx.ipAddress,
    });
    return produit;
  });
}

export interface RapportProduits {
  nouveaux: number;
  dejaConnus: number;
  /** Un produit par entree du lot, dans l'ordre : son identifiant en base et s'il vient d'etre cree. */
  produits: { fournisseur: string; identifiantFournisseur: string; id: string; nouveau: boolean }[];
}

/**
 * Enregistre un lot de produits issus du catalogue d'un fournisseur, SANS DOUBLON : un produit deja connu
 * (meme fournisseur, meme identifiant fournisseur) n'est ni reinsere ni modifie, et compte dans `dejaConnus`.
 * Le lot est atomique : un produit invalide fait refuser tout le lot. Rien n'est telecharge (cycle de vie
 * CATALOGUE par defaut). La date d'acquisition la plus recente de la source est tenue a jour.
 */
export async function enregistrerProduits(
  depot: DepotTeledetection, produits: (ProduitCatalogueSaisi & { code?: string; emprise: GeometrieGeoJson })[], ctx: Contexte,
): Promise<RapportProduits> {
  if (produits.length === 0) throw new RefusTeledetection("LOT_VIDE", "Aucun produit dans le lot.", 400);
  produits.forEach((p, i) => {
    const v = verifierProduitCatalogue(p);
    if (!v.ok) throw new RefusTeledetection(v.code, `Produit n°${i + 1} : ${v.motif}`, 400);
    if (p.emprise?.type !== "Polygon") throw new RefusTeledetection("EMPRISE_INVALIDE", `Produit n°${i + 1} : l'emprise est un Polygon GeoJSON en EPSG:4326.`, 400);
  });
  return dansTransaction(depot, async (tx) => {
    for (const code of new Set(produits.map((p) => p.sourceCode).filter((c): c is string => !!c))) {
      if (!(await tx.sourceObservation.findFirst({ where: { code, deletedAt: null }, select: { id: true } }))) {
        throw new RefusTeledetection("SOURCE_INCONNUE", `La source ${code} n'existe pas au registre des sources.`, 404);
      }
    }
    const rapport: RapportProduits = { nouveaux: 0, dejaConnus: 0, produits: [] };
    const plusRecente = new Map<string, Date>();
    for (const p of produits) {
      const id = randomUUID();
      const code = p.code?.trim() || codeProduitCatalogue(p.fournisseur, p.identifiantFournisseur);
      const cree = await inserer(() => insererProduit(tx, id, { ...p, code }, ctx, true));
      let idRetenu: string = id;
      if (cree) {
        rapport.nouveaux++;
        if (p.sourceCode && !p.synthetique) {
          const vue = plusRecente.get(p.sourceCode);
          if (!vue || p.dateAcquisition > vue) plusRecente.set(p.sourceCode, p.dateAcquisition);
        }
        await logAuditTransactionnelle(tx, {
          userId: ctx.auteurId, action: "CREATE", entityType: "EarthObservationProduct", entityId: id,
          after: { code, fournisseur: p.fournisseur, identifiantFournisseur: p.identifiantFournisseur, collection: p.collection, sourceCode: p.sourceCode ?? null, cycleVie: p.cycleVie ?? "CATALOGUE" },
          ipAddress: ctx.ipAddress,
        });
      } else {
        rapport.dejaConnus++;
        const connu = await tx.earthObservationProduct.findFirst({
          where: { fournisseur: p.fournisseur.trim(), identifiantFournisseur: p.identifiantFournisseur.trim() }, select: { id: true },
        });
        if (!connu) throw new RefusTeledetection("PRODUIT_INTROUVABLE", "Un produit deja connu n'a pas pu etre relu.", 409);
        idRetenu = connu.id;
      }
      rapport.produits.push({ fournisseur: p.fournisseur.trim(), identifiantFournisseur: p.identifiantFournisseur.trim(), id: idRetenu, nouveau: cree });
    }
    for (const [code, date] of plusRecente) {
      // GREATEST ignore les valeurs nulles : la premiere acquisition fixe la date.
      await tx.$executeRaw`UPDATE "sources_observation"
        SET "derniereAcquisitionLe" = GREATEST("derniereAcquisitionLe", ${date}::timestamp), "updatedAt" = CURRENT_TIMESTAMP
        WHERE "code" = ${code}`;
    }
    return rapport;
  }, true);
}

/** Traduit les refus d'emprise et de melange synthetique du declencheur en refus metier (400) ; le reste remonte tel quel. */
async function inserer<T>(insertion: () => Promise<T>): Promise<T> {
  try {
    return await insertion();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("hors de l'emprise")) {
      throw new RefusTeledetection("HORS_EMPRISE", "Une detection est hors de l'emprise de son produit (ou du produit de reference) : le lot est refuse.", 400);
    }
    if (message.includes("synthetique et produit")) {
      throw new RefusTeledetection("SYNTHETIQUE_INCOHERENT", "Une donnee synthetique ne se melange pas a un produit reel (ni l'inverse) : le lot est refuse.", 400);
    }
    throw e;
  }
}

// ============================================================ sources

export interface ChangementEtatDemande extends ChangementEtatSource {
  /** Date d'acquisition la plus recente constatee par le test (facultatif). */
  derniereAcquisitionLe?: Date | null;
}

/**
 * Change l'etat d'une source (reserve a ADMIN cote route). Un test reussi ou echoue donne un etat, un message
 * et une date de verification ; si l'etat CHANGE, l'historique recoit sa ligne dans la meme transaction (la base
 * l'exige). Un etat inchange met seulement a jour le message et la date du dernier test.
 */
export async function changerEtatSource(depot: DepotTeledetection, code: string, d: ChangementEtatDemande, ctx: Contexte) {
  return dansTransaction(depot, async (tx) => {
    const lignes = await tx.$queryRaw<{ id: string; etat: string; requiertIdentifiants: boolean }[]>`
      SELECT "id", "etat", "requiertIdentifiants" FROM "sources_observation" WHERE "code" = ${code} AND "deletedAt" IS NULL FOR UPDATE`;
    const s = lignes[0];
    if (!s) throw new RefusTeledetection("SOURCE_INEXISTANTE", "Source introuvable.", 404);
    exiger(verifierChangementEtatSource(s, d));
    const message = (d.message as string).trim();
    const maintenant = new Date();
    const change = d.vers !== s.etat;
    if (change) {
      await tx.sourceObservationEtat.create({ data: { id: randomUUID(), sourceId: s.id, de: s.etat, vers: d.vers, message, auteurId: ctx.auteurId } });
    }
    const source = await tx.sourceObservation.update({
      where: { id: s.id },
      data: {
        etat: d.vers, dernierMessage: message, derniereVerificationLe: maintenant,
        ...(d.derniereAcquisitionLe ? { derniereAcquisitionLe: d.derniereAcquisitionLe } : {}),
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "UPDATE", entityType: "SourceObservation", entityId: s.id,
      before: { etat: s.etat }, after: { etat: d.vers, message, changement: change }, ipAddress: ctx.ipAddress,
    });
    return { source, changement: change, de: s.etat, vers: d.vers };
  });
}

// ============================================================ depot des propositions

export interface PropositionDeposee {
  type: TypeProposition;
  geometrie: GeometrieGeoJson;
  /** Score brut de la methode (0 a 1). Ce n'est pas une probabilite d'exactitude. */
  score?: number | null;
  /** Indice de detection (0 a 1). Jamais presente comme probabilite : `confianceCalibree` reste faux. */
  confianceDetection?: number | null;
  /** Priorite d'inspection ET la regle qui l'a produite (les deux, ou aucune). */
  priorite?: { niveau: "HAUTE" | "MOYENNE" | "FAIBLE"; regle: string } | null;
  imageCouvertureNuagesPct?: number | null;
  imageNote?: string | null;
  /**
   * OBLIGATOIRE A L'EXECUTION, au moins une : resolution native, nuages, ce qui n'est pas detectable. Le refus
   * `LIMITES_REQUISES` est rendu par le service ; le type reste facultatif pour que l'ancienne route (qui n'en
   * envoie pas) compile jusqu'a sa refonte, en echouant franchement au lieu de deposer une detection sans limites.
   */
  limites?: string[];
}

export interface DepotPropositions {
  produitId: string;
  produitReferenceId?: string | null;
  /** Nom et version de la methode, separes. */
  methodeNom?: string;
  methodeVersion?: string;
  /** Ancienne forme (une chaine « nom version ») : acceptee, mais nom et version restent alors non renseignes. */
  methode?: string;
  toleranceRattachementM?: number | null;
  /** Par defaut, celui du produit. Un lot synthetique n'a pour produit qu'un produit synthetique. */
  synthetique?: boolean;
  propositions: PropositionDeposee[];
}

/**
 * Depose un lot de propositions issues d'une meme methode sur un meme produit. Rattachement au troncon
 * le plus proche seulement si `toleranceRattachementM` est donnee ; la decision porte sa confiance, son
 * algorithme et les troncons concurrents dans la tolerance. N'ecrit JAMAIS dans le referentiel.
 */
export async function deposerPropositions(depot: DepotTeledetection, d: DepotPropositions, ctx: Contexte) {
  const nom = d.methodeNom?.trim() ?? "";
  const version = d.methodeVersion?.trim() ?? "";
  if ((nom.length === 0) !== (version.length === 0)) throw new RefusTeledetection("METHODE_INCOMPLETE", "Le nom et la version de la methode vont ensemble.", 400);
  const methode = nom ? `${nom} ${version}` : (d.methode?.trim() ?? "");
  if (!methode) throw new RefusTeledetection("METHODE_REQUISE", "La methode (nom et version) est obligatoire : la qualite se mesure par methode.", 400);
  if (d.propositions.length === 0) throw new RefusTeledetection("LOT_VIDE", "Aucune proposition dans le lot.", 400);
  const tol = d.toleranceRattachementM ?? null;
  if (tol !== null && !(tol > 0 && tol <= 5000)) throw new RefusTeledetection("TOLERANCE_INVALIDE", "Tolerance de rattachement : metres, strictement positive, au plus 5 000.", 400);
  d.propositions.forEach((p, i) => {
    const v = verifierPropositionDeposee(p);
    if (!v.ok) throw new RefusTeledetection(v.code, `Proposition n°${i + 1} : ${v.motif}`, 400);
  });
  const produit = await depot.earthObservationProduct.findFirst({ where: { id: d.produitId, deletedAt: null } });
  if (!produit) throw new RefusTeledetection("PRODUIT_INEXISTANT", "Produit introuvable au registre.", 404);
  const reference = d.produitReferenceId
    ? await depot.earthObservationProduct.findFirst({ where: { id: d.produitReferenceId, deletedAt: null } })
    : null;
  if (d.produitReferenceId && !reference) throw new RefusTeledetection("REFERENCE_INEXISTANTE", "Produit de reference introuvable au registre.", 404);
  exiger(verifierDeuxDates(produit, reference));
  const synthetique = d.synthetique ?? produit.synthetique;
  if (synthetique !== produit.synthetique || (reference && reference.synthetique !== synthetique)) {
    throw new RefusTeledetection("SYNTHETIQUE_INCOHERENT", "Une donnee synthetique ne se melange pas a un produit reel (ni l'inverse).", 400);
  }

  return dansTransaction(depot, async (tx) => {
    const ids: string[] = [];
    const parConfiance: Record<string, number> = { HAUTE: 0, MOYENNE: 0, FAIBLE: 0, AUCUN: 0 };
    for (const p of d.propositions) {
      const id = randomUUID();
      const geojson = JSON.stringify(p.geometrie);
      // Les troncons vivants dans le rayon, du plus proche au plus loin, en geography (metres). Sans
      // tolerance, aucun : le rattachement n'est pas tente.
      const trouves = tol === null ? [] : await tx.$queryRaw<{ id: string; code: string; d: number }[]>`
        WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) AS geom)
        SELECT t."id", t."code", ST_Distance(t."geom"::geography, g.geom::geography) AS d
          FROM "troncons" t, g
         WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
           AND ST_DWithin(t."geom"::geography, g.geom::geography, ${tol}::double precision)
         ORDER BY d ASC, t."id" ASC LIMIT ${CANDIDATS_CONCURRENTS_MAX + 1}`;
      const candidats: CandidatTroncon[] = trouves.map((t) => ({ tronconId: t.id, code: t.code, distanceM: Number(t.d) }));
      const r = evaluerRattachement(tol, candidats);
      parConfiance[r.confiance]++;
      // L'emprise est tenue par la base (declencheur `propositions_teledetection_coherence`) : une
      // detection hors de la scene de son produit fait echouer tout le lot, rien n'est depose. La region
      // est posee par le meme declencheur, depuis le troncon.
      await inserer(() => tx.$executeRaw`
        INSERT INTO "propositions_teledetection"
          ("id", "produitId", "produitReferenceId", "type", "methode", "methodeNom", "methodeVersion", "score", "confianceDetection",
           "imageCouvertureNuagesPct", "imageNote", "prioriteNiveau", "prioriteRegle", "limites", "synthetique", "geom",
           "tronconId", "distanceTronconM", "rattachementConfiance", "rattachementAlgorithme", "rattachementCandidats", "creeParId")
        VALUES (${id}, ${d.produitId}, ${d.produitReferenceId ?? null}, ${p.type}, ${methode}, ${nom || null}, ${version || null},
                ${p.score ?? null}::double precision, ${p.confianceDetection ?? null}::double precision,
                ${p.imageCouvertureNuagesPct ?? null}::double precision, ${p.imageNote?.trim() ?? null}::text,
                ${p.priorite?.niveau ?? null}::text, ${p.priorite?.regle.trim() ?? null}::text, ${(p.limites ?? []).map((l) => l.trim())}::text[], ${synthetique},
                ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326),
                ${r.retenu?.tronconId ?? null}::text, ${r.retenu?.distanceM ?? null}::double precision,
                ${r.confiance}, ${r.algorithme}, ${tol === null ? null : JSON.stringify(r.concurrents)}::jsonb, ${ctx.auteurId})`);
      ids.push(id);
    }
    const rattachees = await tx.propositionTeledetection.count({ where: { id: { in: ids }, tronconId: { not: null } } });
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "CREATE", entityType: "PropositionTeledetection", entityId: d.produitId,
      after: { produitId: d.produitId, methode, nombre: ids.length, rattachees, toleranceRattachementM: tol, synthetique, parConfiance },
      ipAddress: ctx.ipAddress,
    });
    return { deposees: ids.length, rattachees, nonRattachees: ids.length - rattachees, ids, toleranceRattachementM: tol, parConfianceRattachement: parConfiance };
  }, true);
}

// ============================================================ transitions de statut

export interface DemandeChangementStatut {
  propositionId: string;
  vers: string;
  /** Identifiant du compte authentifie qui decide. */
  auteur: string;
  motif: string;
  commentaire?: string | null;
  /** INFO_DEMANDEE ou AUTRE ; exige pour EN_ATTENTE, interdit sinon. */
  motifAttente?: string | null;
  /** Observations de terrain citees a l'appui (preuves). */
  observationIds?: string[];
  /** Reference libre du constat ; a defaut, un verdict cite les observations. */
  constatRef?: string | null;
  perimetre?: PerimetreEo;
  ipAddress?: string;
}

/**
 * Change le statut d'une proposition. Transitions : voir `TRANSITIONS_AUTORISEES` (noyau, testee
 * exhaustivement) ; un verdict (CONFIRMEE, INFIRMEE) est definitif (`VERDICT_DEFINITIF`). Dans UNE transaction :
 * verrou de la ligne, controle du perimetre, ligne de journal, preuves, mise a jour, audit. Sans perimetre
 * fourni, aucun controle territorial.
 */
export async function changerStatut(depot: DepotTeledetection, d: DemandeChangementStatut) {
  return dansTransaction(depot, async (tx) => {
    const lignes = await tx.$queryRaw<{ statut: string; regionId: number | null; motifAttente: string | null }[]>`
      SELECT "statut", "regionId", "motifAttente" FROM "propositions_teledetection" WHERE "id" = ${d.propositionId} FOR UPDATE`;
    const p = lignes[0];
    if (!p) throw new RefusTeledetection("PROPOSITION_INEXISTANTE", "Proposition introuvable.", 404);
    // Le perimetre d'abord : un compte hors zone ne doit rien apprendre du statut d'une proposition qui n'est pas la sienne.
    exiger(verifierPerimetreProposition(d.perimetre, p.regionId));
    const de = p.statut as StatutProposition;
    exiger(verifierTransition({ de, vers: d.vers, motif: d.motif, commentaire: d.commentaire, motifAttente: d.motifAttente, constatRef: d.constatRef, observationIds: d.observationIds }));
    const vers = d.vers as StatutProposition;
    const ids = d.observationIds ?? [];
    await exigerObservations(tx, ids, d.perimetre);

    const transitionId = randomUUID();
    const motif = d.motif.trim();
    const commentaire = d.commentaire?.trim() || null;
    const motifAttente = vers === "EN_ATTENTE" ? (d.motifAttente as string) : null;
    await tx.propositionTeledetectionTransition.create({
      data: { id: transitionId, propositionId: d.propositionId, de, vers, auteurId: d.auteur, motif, commentaire, motifAttente },
    });
    const preuves = ids.length === 0 ? { count: 0 } : await tx.propositionTeledetectionPreuve.createMany({
      data: ids.map((observationId) => ({ id: randomUUID(), propositionId: d.propositionId, observationId, transitionId, ajouteeParId: d.auteur })),
      skipDuplicates: true,
    });
    const verdict = estDefinitif(vers);
    // Mise a jour conditionnee au statut lu (et verrouille) : deux decisions simultanees ne passent pas toutes les deux.
    const maj = await tx.propositionTeledetection.updateMany({
      where: { id: d.propositionId, statut: de },
      data: {
        statut: vers, motifAttente,
        ...(verdict ? { verifieeParId: d.auteur, verifieeLe: new Date(), motifVerdict: motif, constatRef: construireConstatRef(d.constatRef, ids) } : {}),
      },
    });
    if (maj.count !== 1) throw new RefusTeledetection("STATUT_CHANGE_ENTRE_TEMPS", "Le statut de la proposition a change entre-temps.", 409);
    await logAuditTransactionnelle(tx, {
      userId: d.auteur, action: vers === "CONFIRMEE" ? "VALIDATE" : vers === "INFIRMEE" ? "REJECT" : "UPDATE",
      entityType: "PropositionTeledetection", entityId: d.propositionId,
      before: { statut: de, motifAttente: p.motifAttente },
      after: { statut: vers, motif, commentaire, motifAttente, observationIds: ids, transitionId },
      ipAddress: d.ipAddress,
    });
    const proposition = await tx.propositionTeledetection.findUniqueOrThrow({ where: { id: d.propositionId } });
    return { proposition, transitionId, de, vers, preuvesAjoutees: preuves.count };
  });
}

/**
 * Les observations citees existent ET sont lisibles du compte. Un compte REGIONAL ne cite que les observations de son perimetre (region
 * derivee de leur troncon, ouvrage, chantier ou mission : `observation.perimetre.ts`) ; une observation sans region determinable n'est
 * visible que d'un compte national. Sans perimetre fourni, aucun controle territorial (voir l'en-tete du fichier).
 *
 * L'observation INEXISTANTE et l'observation HORS PERIMETRE donnent la MEME reponse (404, meme code, meme texte, aucun identifiant dans
 * le message) : sinon la reponse dirait au compte quelles observations d'autres regions existent.
 */
async function exigerObservations(tx: ClientTx, ids: readonly string[], perimetre?: PerimetreEo): Promise<void> {
  if (ids.length === 0) return;
  const uniques = [...new Set(ids)];
  let visibles: { id: string }[];
  if (perimetre && !perimetre.national) {
    visibles = await tx.$queryRaw<{ id: string }[]>`
      SELECT o."id" FROM "observations" o
       WHERE o."id" = ANY(${uniques}::text[]) AND o."deletedAt" IS NULL AND ${observationDansPortee("o", [...perimetre.regions])}`;
  } else {
    visibles = await tx.observation.findMany({ where: { id: { in: uniques }, deletedAt: null }, select: { id: true } });
  }
  const connues = new Set(visibles.map((o) => o.id));
  if (uniques.some((i) => !connues.has(i))) {
    throw new RefusTeledetection("OBSERVATION_INEXISTANTE", "Observation de terrain introuvable.", 404);
  }
}

/**
 * Ajoute des preuves de terrain (observations existantes) a une proposition SANS decider : le geste d'un
 * inspecteur sur une mission qui lui est affectee. Refuse sur un verdict definitif (une proposition jugee
 * ne gagne pas de pieces apres coup). Une observation deja citee est ignoree et comptee a part.
 */
export async function ajouterPreuves(
  depot: DepotTeledetection,
  d: { propositionId: string; observationIds: string[]; auteur: string; perimetre?: PerimetreEo; ipAddress?: string },
) {
  if (d.observationIds.length === 0 || d.observationIds.some((i) => !i.trim())) {
    throw new RefusTeledetection("OBSERVATION_INVALIDE", "Citer au moins une observation, par son identifiant.", 400);
  }
  const uniques = [...new Set(d.observationIds)];
  return dansTransaction(depot, async (tx) => {
    const lignes = await tx.$queryRaw<{ statut: string; regionId: number | null }[]>`
      SELECT "statut", "regionId" FROM "propositions_teledetection" WHERE "id" = ${d.propositionId} FOR UPDATE`;
    const p = lignes[0];
    if (!p) throw new RefusTeledetection("PROPOSITION_INEXISTANTE", "Proposition introuvable.", 404);
    exiger(verifierPerimetreProposition(d.perimetre, p.regionId));
    if (estDefinitif(p.statut)) throw new RefusTeledetection("VERDICT_DEFINITIF", `Le terrain a deja juge (${p.statut}) : on n'ajoute plus de pieces.`, 409);
    await exigerObservations(tx, uniques, d.perimetre);
    const res = await tx.propositionTeledetectionPreuve.createMany({
      data: uniques.map((observationId) => ({ id: randomUUID(), propositionId: d.propositionId, observationId, ajouteeParId: d.auteur })),
      skipDuplicates: true,
    });
    await logAuditTransactionnelle(tx, {
      userId: d.auteur, action: "CREATE", entityType: "PropositionTeledetectionPreuve", entityId: d.propositionId,
      after: { observationIds: uniques, ajoutees: res.count }, ipAddress: d.ipAddress,
    });
    return { ajoutees: res.count, dejaCitees: uniques.length - res.count };
  });
}

/**
 * Ancienne API (route `/verdict`) : le terrain confirme ou infirme, une fois. Passe par `changerStatut`, donc
 * journalise. Conserve ses anciens codes d'erreur (`VERDICT_DEJA_RENDU`). Les nouvelles routes appellent `changerStatut`.
 */
export async function poserVerdict(
  depot: DepotTeledetection, id: string, v: { statut: string; motif: string; constatRef: string }, ctx: Contexte,
) {
  if (v.statut !== "CONFIRMEE" && v.statut !== "INFIRMEE") throw new RefusTeledetection("VERDICT_INVALIDE", "Verdict : CONFIRMEE ou INFIRMEE.", 400);
  try {
    const r = await changerStatut(depot, { propositionId: id, vers: v.statut, auteur: ctx.auteurId, motif: v.motif, constatRef: v.constatRef, perimetre: ctx.perimetre, ipAddress: ctx.ipAddress });
    return r.proposition;
  } catch (e) {
    if (e instanceof RefusTeledetection && e.code === "VERDICT_DEFINITIF") throw new RefusTeledetection("VERDICT_DEJA_RENDU", e.message, 409);
    throw e;
  }
}

// ============================================================ mission de verification

/**
 * Depeche une mission SURVEILLANCE de verification sur la proposition (export vers EX-03). La mission recoit la
 * REGION de la proposition (celle de son troncon) et une EMPRISE : l'enveloppe de la detection elargie d'une marge
 * (`MARGE_EMPRISE_MISSION_DEG`, PROVISOIRE). Le troncon est nomme dans l'intitule (la table des missions n'a pas de
 * colonne de troncon) et reste lisible par `propositions_teledetection.missionId`. Possible tant que la proposition
 * n'a pas de verdict et pas de mission.
 */
export async function dispatcherVerification(
  depot: DepotTeledetection, id: string, d: { assigneId?: string | null; debutPrevu?: Date | null }, ctx: Contexte,
) {
  return dansTransaction(depot, async (tx) => {
    const lignes = await tx.$queryRaw<{ statut: string; missionId: string | null; type: string; regionId: number | null; tronconCode: string | null }[]>`
      SELECT pt."statut", pt."missionId", pt."type", pt."regionId", t."code" AS "tronconCode"
        FROM "propositions_teledetection" pt LEFT JOIN "troncons" t ON t."id" = pt."tronconId"
       WHERE pt."id" = ${id} FOR UPDATE OF pt`;
    const p = lignes[0];
    if (!p) throw new RefusTeledetection("PROPOSITION_INEXISTANTE", "Proposition introuvable.", 404);
    exiger(verifierPerimetreProposition(ctx.perimetre, p.regionId));
    exiger(verifierDepecheVerification({ statut: p.statut as StatutProposition, missionId: p.missionId }));
    const racine = codeMissionTeledetection(id);
    const pris = new Set((await tx.mission.findMany({ where: { code: { startsWith: racine } }, select: { code: true } })).map((m) => m.code));
    let code = racine;
    for (let n = 2; pris.has(code); n++) code = `${racine}-${n}`;
    const mission = await tx.mission.create({
      data: {
        code, type: "SURVEILLANCE", createurId: ctx.auteurId, assigneId: d.assigneId ?? null, debutPrevu: d.debutPrevu ?? null,
        intitule: `Verification d'une proposition de teledetection (${p.type})${p.tronconCode ? ` sur le troncon ${p.tronconCode}` : ""}`,
        regionId: p.regionId,
      },
    });
    // L'emprise est un Polygon (colonne geometrique, hors Prisma) : l'enveloppe de la detection elargie d'une marge.
    await tx.$executeRaw`UPDATE "missions" SET "emprise" = ST_Envelope(ST_Expand((SELECT "geom" FROM "propositions_teledetection" WHERE "id" = ${id}), ${MARGE_EMPRISE_MISSION_DEG}::double precision))
      WHERE "id" = ${mission.id}`;
    await tx.propositionTeledetection.update({ where: { id }, data: { missionId: mission.id } });
    await logAuditTransactionnelle(tx, {
      userId: ctx.auteurId, action: "CREATE", entityType: "Mission", entityId: mission.id,
      after: { code, type: "SURVEILLANCE", statut: mission.statut, regionId: p.regionId, tronconCode: p.tronconCode, propositionTeledetectionId: id }, ipAddress: ctx.ipAddress,
    });
    return tx.mission.findUniqueOrThrow({ where: { id: mission.id } });
  });
}

/** Ancien nom de `dispatcherVerification` (route en place), conserve pour ne pas casser les appelants. */
export const depecherVerificationTeledetection = dispatcherVerification;

// ============================================================ indicateurs

export interface PorteeSynthese {
  /** Perimetre du compte ; sans lui, l'ensemble du territoire. */
  perimetre?: PerimetreEo;
  /** Restriction a une region ; hors du perimetre d'un compte regional, elle est refusee (`HORS_PERIMETRE`). */
  regionId?: number | null;
  /** Bornes de la date d'observation (date d'acquisition du produit analyse), incluses. */
  depuis?: Date | null;
  jusqua?: Date | null;
  /** Horloge injectee (tests) ; sinon l'heure du serveur. */
  maintenant?: Date;
}

export interface SyntheseTeledetection {
  periode: { depuis: string | null; jusqua: string | null };
  propositions: { aVerifier: number; enAttente: number; nonConcluantes: number; confirmees: number; infirmees: number; prioritaires: number };
  tauxConfirmation: ReturnType<typeof calculerTauxConfirmation>;
  sources: ReturnType<typeof compterSourcesParEtat>;
  derniereAcquisition: { produitId: string; source: string; date: string; resolutionM: number } | null;
  fraicheur: { dateCalcul: string; ageDerniereAcquisitionJours: number | null };
}

/**
 * Compteurs de l'ecran de synthese. Aucune constante metier inventee : les nombres sont des comptes de lignes,
 * le taux suit la formule du contrat (nul a zero verdict, `echantillonSuffisant` contre le seuil PROVISOIRE).
 * Les donnees synthetiques sont exclues. `prioritaires` = propositions de priorite HAUTE encore a decider
 * (A_VERIFIER, EN_ATTENTE, NON_CONCLUANTE). Les sources et la derniere acquisition ne sont pas regionalisees.
 */
export async function calculerSynthese(depot: Pick<DepotTeledetection, "$queryRaw">, portee: PorteeSynthese = {}): Promise<SyntheseTeledetection> {
  const maintenant = portee.maintenant ?? new Date();
  let regions: number[] | null = null;
  if (portee.perimetre && !portee.perimetre.national) {
    regions = [...portee.perimetre.regions];
    if (portee.regionId != null) {
      exiger(verifierPerimetreProposition(portee.perimetre, portee.regionId));
      regions = [portee.regionId];
    }
  } else if (portee.regionId != null) {
    regions = [portee.regionId];
  }
  const conditions: Prisma.Sql[] = [Prisma.sql`NOT pt."synthetique"`];
  if (regions) conditions.push(Prisma.sql`pt."regionId" = ANY(${regions}::int[])`);
  if (portee.depuis) conditions.push(Prisma.sql`p."dateAcquisition" >= ${portee.depuis}::timestamp`);
  if (portee.jusqua) conditions.push(Prisma.sql`p."dateAcquisition" <= ${portee.jusqua}::timestamp`);

  const parStatut = await depot.$queryRaw<{ statut: string; n: number; prioritaires: number }[]>`
    SELECT pt."statut", count(*)::int AS "n",
           count(*) FILTER (WHERE pt."prioriteNiveau" = 'HAUTE' AND pt."statut" IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE'))::int AS "prioritaires"
      FROM "propositions_teledetection" pt JOIN "earth_observation_products" p ON p."id" = pt."produitId"
     WHERE ${Prisma.join(conditions, " AND ")}
     GROUP BY pt."statut"`;
  const n = (statut: string) => parStatut.find((l) => l.statut === statut)?.n ?? 0;
  const etats = await depot.$queryRaw<{ etat: string }[]>`SELECT "etat" FROM "sources_observation" WHERE "deletedAt" IS NULL`;
  const derniere = (await depot.$queryRaw<{ id: string; source: string; date: Date; resolutionM: number }[]>`
    SELECT p."id", coalesce(p."sourceCode", p."source") AS "source", p."dateAcquisition" AS "date", p."resolutionM"
      FROM "earth_observation_products" p
     WHERE p."deletedAt" IS NULL AND NOT p."synthetique"
     ORDER BY p."dateAcquisition" DESC, p."id" ASC LIMIT 1`)[0] ?? null;

  return {
    periode: { depuis: portee.depuis?.toISOString() ?? null, jusqua: portee.jusqua?.toISOString() ?? null },
    propositions: {
      aVerifier: n("A_VERIFIER"), enAttente: n("EN_ATTENTE"), nonConcluantes: n("NON_CONCLUANTE"),
      confirmees: n("CONFIRMEE"), infirmees: n("INFIRMEE"),
      prioritaires: parStatut.reduce((s, l) => s + l.prioritaires, 0),
    },
    tauxConfirmation: calculerTauxConfirmation(n("CONFIRMEE"), n("INFIRMEE")),
    sources: compterSourcesParEtat(etats.map((e) => e.etat)),
    derniereAcquisition: derniere ? { produitId: derniere.id, source: derniere.source, date: new Date(derniere.date).toISOString(), resolutionM: Number(derniere.resolutionM) } : null,
    fraicheur: { dateCalcul: maintenant.toISOString(), ageDerniereAcquisitionJours: ageEnJours(maintenant, derniere ? new Date(derniere.date) : null) },
  };
}

// ============================================================ lectures conservees

export interface LignePrecision { type: string; methode: string; total: number; aVerifier: number; confirmees: number; infirmees: number; precision: number | null }

/** Vue historique : rapport confirmees / jugees, SANS effectif ni seuil. Preferer `qualiteMethodes`. */
export async function precision(depot: Pick<DepotTeledetection, "$queryRaw">) {
  return depot.$queryRaw<LignePrecision[]>`SELECT * FROM "precision_teledetection" ORDER BY "type", "methode"`;
}

export interface LigneQualiteMethode {
  type: string; methode: string; methodeNom: string | null; methodeVersion: string | null;
  total: number; aVerifier: number; enAttente: number; nonConcluantes: number; confirmees: number; infirmees: number; jugees: number;
  /** Nul tant qu'aucun verdict n'est rendu. Taux de confirmation terrain, PAS la precision statistique. */
  tauxConfirmation: number | null;
  echantillonSuffisant: boolean;
  seuilEchantillon: number;
}

/** Taux de confirmation par type et methode, avec effectif et indicateur d'echantillon (vue `qualite_methodes_eo`). Non regionalise. */
export async function qualiteMethodes(depot: Pick<DepotTeledetection, "$queryRaw">) {
  return depot.$queryRaw<LigneQualiteMethode[]>`SELECT * FROM "qualite_methodes_eo" ORDER BY "type", "methode"`;
}
