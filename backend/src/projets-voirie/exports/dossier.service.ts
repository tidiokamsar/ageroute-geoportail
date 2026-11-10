/**
 * EXPORT DU DOSSIER TECHNIQUE D'UN PROJET (lot X1 ; contrat docs/projets-voirie/CONTRAT-EXPORTS.md, section 4). Archive ZIP produite par le serveur,
 * bornee, reservee aux decideurs (la route l'impose), deroulee dans l'ordre de la section 4.5.
 *
 * REGLES
 *   - rien d'un jeu RETIRE (fiche, GeoJSON, CSV, journal des documents) ; GeoJSON des seuls jeux AUTORISE d'un niveau exportable, ou couverts par une
 *     derogation ADMIN citee, RESERVEE par la tentative des son ouverture et CONSOMMEE seulement apres l'ecriture complete de la reponse ;
 *   - TENTATIVE (revue du lot X1, M3 et M4) : une ligne EN_COURS est ecrite des que la cadence est passee (toutes les tentatives comptent dans la cadence,
 *     echecs tardifs compris) ; elle se termine REMIS (apres l'ecriture complete de la reponse), ECHEC (code) ou ECHEC_ENVOI (client parti) ;
 *   - budget total sous le delai du mandataire nginx (50 s au plus) ; chaque lecture recoit au plus ce qui reste ; volumes et octets non compresses estimes
 *     AVANT la lecture des geometries, puis comptes PENDANT la fabrication (arret des le depassement, 422) ; GeoJSON lu par lots ;
 *   - toute ecriture auditee, sans geometrie (empreintes, tailles, identifiants, niveaux, nombres).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { ServiceOccupe } from "../../import/limiteur";
import { Budget, estDelaiDepasse, poserDelais } from "../bd";
import { delaiAnalyseMs, delaiDepotMs, delaiVerrouMs } from "../config";
import { calculer } from "../analyse.service";
import { exigerProjetActif, produireCsvConflits } from "../conflits/dossiers.service";
import { completudeProjet } from "../documents/completude.service";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur, Tx } from "../projets.service";
import { verifierCadence } from "./cadence.noyau";
import {
  LOT_GEOJSON, NOM_EXPORT_MAX, exportCadenceFenetreS, exportCadenceMax, exportDelaiMs, exportObjetsMax, exportSommetsMax, exportTailleMaxOctets,
  niveauxExportables, reservationPerimeeS,
} from "./config";
import { selectionGeojson, verifierDerogationCitee, type JeuCandidat } from "./confidentialite.noyau";
import { lireDerogations, versLue } from "./derogations.service";
import { agregatsAnalyse, jeuDeFiche, lignesFichePdf, lisezMoi, type EntreePdf } from "./fiche.noyau";
import { journalCsv, masquerDetails } from "./journal-documents.noyau";
import { DOCUMENTS_EXPORT_MAX, HISTORIQUE_EXPORT_MAX, lireDossier } from "./lecture-dossier";
import { limiteurExports, reserverExportCompte, sousLimiteur } from "./limiteurs";
import { FORMAT_MANIFESTE, assembler, jsonStable, nomGeojson, racineDossier, sha256 } from "./manifeste.noyau";
import { produirePdf } from "./pdf.noyau";
import { produireZip } from "./zip-ecriture.noyau";

export interface DemandeExport { geojson: boolean; derogationId?: string }

/** Archive fabriquee ; `consigner(envoye)` est appele par la route APRES l'ecriture complete de la reponse (true) ou au depart du client (false). */
export interface ExportFabrique {
  archive: Buffer; nomFichier: string; exportId: string; sha256: string; nbFichiers: number; nbJeuxGeojson: number;
  consigner: (envoye: boolean) => Promise<void>;
}

const tropLong = () => new ErreurMetier(504, "EXPORT_TROP_LONG", `La fabrication du dossier a dépassé ${Math.round(exportDelaiMs() / 1000)} s et a été interrompue : réessayez, ou exportez sans GeoJSON.`);

/** Echeance totale : verifiee entre deux etapes ; chaque lecture recoit au plus ce qui reste (et son propre `statement_timeout` cote base). */
class Echeance {
  private readonly fin = Date.now() + exportDelaiMs();
  verifier(): void { if (Date.now() > this.fin) throw tropLong(); }
  resteMs(): number { this.verifier(); return Math.max(1_000, this.fin - Date.now()); }
}

/** Octets NON compresses de l'archive, comptes au fil de la fabrication (revue du lot X1, M3) : arret des que le plafond est depasse. */
export class CompteurOctets {
  total = 0;
  constructor(private readonly max: number) {}
  ajouter(n: number): void {
    this.total += n;
    if (this.total > this.max) {
      throw new ErreurMetier(422, "EXPORT_TROP_VOLUMINEUX", `Le dossier dépasse ${this.max} octets non compressés : fabrication interrompue ; exportez sans GeoJSON (geojson=false).`, { octets: this.total, octetsMax: this.max });
    }
  }
}

const estDerogationRefusee = (e: unknown) => /derogations_export_projet_voirie/.test(e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------------------------------------ Tentative : ouverture, issue

interface Tentative { exportId: string; derogationId: string | null; jeuxDerogation: Set<string> }

/**
 * Ouvre la tentative (une transaction, sous verrou consultatif du compte) : projet actif, cadence comptee sur TOUTES les tentatives (horloge de la base),
 * derogation citee verifiee puis RESERVEE par une mise a jour conditionnelle (une seule tentative la tient), ligne EN_COURS, audits.
 */
async function ouvrirTentative(acteur: Acteur, projetId: string, d: DemandeExport): Promise<Tentative> {
  const exportId = randomUUID();
  try {
    return await prisma.$transaction(async (tx) => {
      await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
      await tx.$queryRaw`SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`pv-export-dossier|${acteur.id}`}, 0))) v`;
      const p = await tx.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true } });
      if (!p) throw introuvable("Projet", "PROJET_INTROUVABLE");
      const fenetreS = exportCadenceFenetreS();
      const plafond = exportCadenceMax();
      const recents = await tx.$queryRaw<{ t: Date; maintenant: Date }[]>`
        SELECT "createdAt" AS "t", (now() AT TIME ZONE 'UTC') AS "maintenant" FROM "exports_dossier_projet_voirie"
         WHERE "acteurId" = ${acteur.id} AND "createdAt" > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${fenetreS}::int)
         ORDER BY "createdAt" DESC LIMIT ${plafond}`;
      if (recents.length) {
        const v = verifierCadence({ horodatages: recents.map((r) => r.t), maintenant: recents[0].maintenant, fenetreS, plafond });
        if (!v.ok) throw new ErreurMetier(429, "EXPORT_TROP_FREQUENT", `Au plus ${plafond} tentatives d'export par compte en ${fenetreS} s : réessayez dans ${v.retryAfterS} s.`, { retryAfterS: v.retryAfterS });
      }
      let jeuxDerogation = new Set<string>();
      if (d.derogationId) {
        const [lue] = await lireDerogations(tx, { id: d.derogationId });
        const v = verifierDerogationCitee(lue ? versLue(lue) : null, { projetId, acteurId: acteur.id });
        if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message, v.extra);
        jeuxDerogation = new Set(lue.jeuxIds);
      }
      await tx.$executeRaw`
        INSERT INTO "exports_dossier_projet_voirie" ("id", "projetId", "acteurId", "statut", "derogationId", "createdAt")
        VALUES (${exportId}, ${projetId}, ${acteur.id}, 'EN_COURS', ${d.derogationId ?? null}, (now() AT TIME ZONE 'UTC'))`;
      if (d.derogationId) {
        // Reservation conditionnelle (horloge de la base) : libre, ou tenue par une tentative terminee ou perimee (processus arrete en cours d'export).
        const n = await tx.$executeRaw`
          UPDATE "derogations_export_projet_voirie" SET "exportId" = ${exportId}
           WHERE "id" = ${d.derogationId} AND "projetId" = ${projetId} AND "beneficiaireId" = ${acteur.id} AND "utiliseeLe" IS NULL
             AND "expireLe" > (now() AT TIME ZONE 'UTC')
             AND ("exportId" IS NULL OR "exportId" IN (SELECT e."id" FROM "exports_dossier_projet_voirie" e
                   WHERE e."statut" <> 'EN_COURS' OR e."createdAt" <= (now() AT TIME ZONE 'UTC') - make_interval(secs => ${reservationPerimeeS()}::int)))`;
        if (n !== 1) throw new ErreurMetier(409, "DEROGATION_INDISPONIBLE", "Cette dérogation vient d'être réservée par une autre tentative ou a expiré.", { etat: "RESERVEE" });
        await logAuditTransactionnelle(tx, {
          userId: acteur.id, action: "UPDATE", entityType: "DerogationExportProjetVoirie", entityId: d.derogationId,
          after: { reserveePar: exportId, projetId }, ipAddress: acteur.ip,
        });
      }
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "CREATE", entityType: "ExportDossierProjetVoirie", entityId: projetId,
        after: { exportId, statut: "EN_COURS", geojson: d.geojson, derogationId: d.derogationId ?? null }, ipAddress: acteur.ip,
      });
      return { exportId, derogationId: d.derogationId ?? null, jeuxDerogation };
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDerogationRefusee(e)) throw new ErreurMetier(409, "DEROGATION_INDISPONIBLE", "Cette dérogation n'est plus disponible (déjà utilisée, réservée ou expirée).", { etat: "INDISPONIBLE" });
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "La tentative d'export n'a pas pu être enregistrée à temps : réessayez dans quelques instants.");
    throw e;
  }
}

const codeDe = (e: unknown): string => (e instanceof ErreurMetier ? e.code : e instanceof ServiceOccupe ? "SERVICE_OCCUPE" : "ERREUR_INTERNE");

/** Issue negative : ligne terminee, derogation LIBEREE (non consommee), audit. N'echoue jamais vers l'appelant (l'erreur d'origine prime). */
async function terminerSansRemise(acteur: Acteur, projetId: string, t: Tentative, statut: "ECHEC" | "ECHEC_ENVOI", code: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
      await tx.$executeRaw`UPDATE "exports_dossier_projet_voirie" SET "statut" = ${statut}, "codeEchec" = ${code}, "termineLe" = (now() AT TIME ZONE 'UTC')
                            WHERE "id" = ${t.exportId} AND "statut" = 'EN_COURS'`;
      if (t.derogationId) {
        await tx.$executeRaw`UPDATE "derogations_export_projet_voirie" SET "exportId" = NULL WHERE "id" = ${t.derogationId} AND "exportId" = ${t.exportId} AND "utiliseeLe" IS NULL`;
      }
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "UPDATE", entityType: "ExportDossierProjetVoirie", entityId: projetId,
        before: { exportId: t.exportId, statut: "EN_COURS" }, after: { exportId: t.exportId, statut, codeEchec: code, derogationLiberee: t.derogationId }, ipAddress: acteur.ip,
      });
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    console.error(`[projets-voirie] export ${t.exportId} : issue ${statut} non consignee`, e instanceof Error ? e.message : e);
  }
}

interface Remise {
  code: string; empreinte: string; taille: number; nbFichiers: number; manifeste: Record<string, unknown>;
  inclus: { jeuId: string; version: number; confidentialite: string; nbObjets: number; derogation: boolean }[]; ecartes: { jeuId: string; raison: string }[];
}

/** Issue positive, APRES l'ecriture complete de la reponse : derogation consommee (par la tentative qui la reserve), ligne REMIS, audits. */
async function consignerRemise(acteur: Acteur, projetId: string, t: Tentative, r: Remise): Promise<void> {
  try {
    await prisma.$transaction(async (tx: Tx) => {
      await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
      if (t.derogationId) {
        const n = await tx.$executeRaw`UPDATE "derogations_export_projet_voirie" SET "utiliseeLe" = (now() AT TIME ZONE 'UTC')
                                        WHERE "id" = ${t.derogationId} AND "exportId" = ${t.exportId} AND "utiliseeLe" IS NULL`;
        await logAuditTransactionnelle(tx, {
          userId: acteur.id, action: "UPDATE", entityType: "DerogationExportProjetVoirie", entityId: t.derogationId,
          before: { utiliseeLe: null, exportId: t.exportId }, after: { consommee: n === 1, exportId: t.exportId, projetId, jeuxExportes: r.inclus.filter((i) => i.derogation).map((i) => i.jeuId) },
          ipAddress: acteur.ip,
        });
      }
      await tx.$executeRaw`UPDATE "exports_dossier_projet_voirie" SET "statut" = 'REMIS', "sha256" = ${r.empreinte}, "tailleOctets" = ${r.taille}, "nbFichiers" = ${r.nbFichiers},
                             "nbJeuxGeojson" = ${r.inclus.length}, "manifeste" = ${JSON.stringify(r.manifeste)}::jsonb, "termineLe" = (now() AT TIME ZONE 'UTC')
                            WHERE "id" = ${t.exportId} AND "statut" = 'EN_COURS'`;
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "UPDATE", entityType: "ExportDossierProjetVoirie", entityId: projetId,
        before: { exportId: t.exportId, statut: "EN_COURS" },
        after: {
          format: "zip", exportId: t.exportId, statut: "REMIS", projet: r.code, sha256: r.empreinte, tailleOctets: r.taille, nbFichiers: r.nbFichiers,
          geojson: r.inclus.map((i) => ({ jeuId: i.jeuId, version: i.version, confidentialite: i.confidentialite, nbObjets: i.nbObjets, derogation: i.derogation })),
          ecartes: r.ecartes.map((e) => ({ jeuId: e.jeuId, raison: e.raison })), derogationId: t.derogationId, geometries: r.inclus.length > 0,
        },
        ipAddress: acteur.ip,
      });
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    console.error(`[projets-voirie] export ${t.exportId} : remise ecrite mais non consignee`, e instanceof Error ? e.message : e);
  }
}

// ------------------------------------------------------------------------------------------------ Lectures bornees

interface ObjetLu { id: string; nom: string | null; tronque: boolean; typeGeom: string; longueurM: number | null; ordre: number; g: string }

/**
 * GeoJSON d'un jeu, LU PAR LOTS (`LOT_GEOJSON` objets par requete, curseur sur ordre puis identifiant), octets comptes au fil de l'eau ; polygones
 * orientes selon la RFC 7946 (anneau exterieur dans le sens trigonometrique ; lignes et points inchanges, `ST_ForcePolygonCCW` inversant aussi une ligne) ; noms bornes a `NOM_EXPORT_MAX` caracteres. Null si le jeu n'est plus AUTORISE.
 */
async function geojsonDuJeu(jeu: JeuCandidat & { sha256: string }, derogation: boolean, echeance: Echeance, compteur: CompteurOctets): Promise<{ contenu: Buffer; nbObjets: number; nomsTronques: number } | null> {
  const entete = JSON.stringify({ jeuId: jeu.id, role: jeu.role, version: jeu.version, sha256Source: jeu.sha256, confidentialite: jeu.confidentialite, derogation });
  const morceaux: Buffer[] = [Buffer.from(`{"type":"FeatureCollection","bdri":${entete},"features":[\n`, "utf8")];
  compteur.ajouter(morceaux[0].length);
  let apresOrdre = -2_147_483_648, apresId = "0", nb = 0, tronques = 0;
  for (;;) {
    const delai = Math.min(delaiAnalyseMs(), echeance.resteMs());
    let lot: ObjetLu[] | null;
    try {
      lot = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const budget = new Budget(tx, delai, delaiVerrouMs(), tropLong);
        if (nb === 0) {
          const statut = await budget.etape(() => tx.$queryRaw<{ s: string }[]>`SELECT "statut"::text AS "s" FROM "projets_voirie_jeux" WHERE "id" = ${jeu.id}`);
          if (statut[0]?.s !== "AUTORISE") return null;
        }
        return budget.etape(() => tx.$queryRaw<ObjetLu[]>`
          SELECT "id"::text AS "id", left("nom", ${NOM_EXPORT_MAX}::int) AS "nom", coalesce(length("nom") > ${NOM_EXPORT_MAX}::int, false) AS "tronque",
                 "typeGeom"::text AS "typeGeom", "longueurM", "ordre", ST_AsGeoJSON(CASE WHEN "typeGeom"::text = 'POLYGONE' THEN ST_ForcePolygonCCW("geom") ELSE "geom" END, 7) AS "g"
            FROM "projets_voirie_objets"
           WHERE "jeuId" = ${jeu.id} AND ("ordre" > ${apresOrdre}::int OR ("ordre" = ${apresOrdre}::int AND "id" > ${apresId}::bigint))
           ORDER BY "ordre", "id" LIMIT ${LOT_GEOJSON}::int`, "geojson");
      }, { timeout: delai + 10_000, maxWait: 10_000 });
    } catch (e) {
      if (e instanceof ErreurMetier) throw e;
      if (estDelaiDepasse(e)) throw tropLong();
      throw e;
    }
    if (lot === null) return null;
    for (const o of lot) {
      const proprietes = { objetId: o.id, nom: o.nom, typeGeom: o.typeGeom, longueurM: o.longueurM === null ? null : Math.round(Number(o.longueurM) * 100) / 100, ordre: o.ordre, ...(o.tronque ? { nomTronque: true } : {}) };
      const b = Buffer.from(`${nb > 0 ? ",\n" : ""}{"type":"Feature","geometry":${o.g},"properties":${JSON.stringify(proprietes)}}`, "utf8");
      compteur.ajouter(b.length);
      morceaux.push(b);
      nb += 1;
      if (o.tronque) tronques += 1;
    }
    if (lot.length < LOT_GEOJSON) break;
    apresOrdre = lot[lot.length - 1].ordre;
    apresId = lot[lot.length - 1].id;
  }
  const fin = Buffer.from("\n]}\n", "utf8");
  compteur.ajouter(fin.length);
  morceaux.push(fin);
  return { contenu: Buffer.concat(morceaux), nbObjets: nb, nomsTronques: tronques };
}

/** Estimation PREALABLE (en base, avant de lire une geometrie cote Node) : objets, sommets et octets des noms (bornes) des jeux a exporter. */
async function volumes(ids: string[], delaiMaxMs: number): Promise<{ objets: number; sommets: number; octetsNoms: number }> {
  if (ids.length === 0) return { objets: 0, sommets: 0, octetsNoms: 0 };
  const delai = Math.min(delaiAnalyseMs(), delaiMaxMs);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await poserDelais(tx, delai, delaiVerrouMs());
      const r = await tx.$queryRaw<{ n: bigint; s: bigint; o: bigint }[]>`
        SELECT count(*)::bigint AS "n", coalesce(sum(ST_NPoints("geom")), 0)::bigint AS "s", coalesce(sum(octet_length(left("nom", ${NOM_EXPORT_MAX}::int))), 0)::bigint AS "o"
          FROM "projets_voirie_objets" WHERE "jeuId" = ANY(${ids}::text[])`;
      return { objets: Number(r[0].n), sommets: Number(r[0].s), octetsNoms: Number(r[0].o) };
    }, { timeout: delai + 10_000, maxWait: 10_000 });
  } catch (e) {
    if (estDelaiDepasse(e)) throw tropLong();
    throw e;
  }
}

/** Octets d'un sommet et d'un objet dans le GeoJSON (7 decimales, separateurs, proprietes) : majorants prudents de l'estimation prealable. */
export const OCTETS_PAR_SOMMET = 24;
export const OCTETS_PAR_OBJET = 180;

// ------------------------------------------------------------------------------------------------ Export

export async function exporterDossier(acteur: Acteur, projetId: string, d: DemandeExport): Promise<ExportFabrique> {
  await exigerProjetActif(projetId);
  const liberer = reserverExportCompte(acteur.id);
  let rendu = false;
  try {
    const { r, t, remise } = await sousLimiteur(limiteurExports, "Le service fabrique déjà d'autres dossiers : réessayez dans quelques instants.", async () => {
      const echeance = new Echeance();
      const tentative = await ouvrirTentative(acteur, projetId, d);
      try {
        const f = await fabriquer(acteur, projetId, d, tentative, echeance);
        return { r: f.resultat, t: tentative, remise: f.remise };
      } catch (e) {
        await terminerSansRemise(acteur, projetId, tentative, "ECHEC", codeDe(e));
        throw e;
      }
    });
    rendu = true;
    let fait = false;
    return {
      ...r,
      consigner: async (envoye: boolean) => {
        if (fait) return;
        fait = true;
        try {
          if (envoye) await consignerRemise(acteur, projetId, t, remise);
          else await terminerSansRemise(acteur, projetId, t, "ECHEC_ENVOI", "CLIENT_DECONNECTE");
        } finally { liberer(); }
      },
    };
  } finally {
    if (!rendu) liberer();
  }
}

async function fabriquer(acteur: Acteur, projetId: string, d: DemandeExport, t: Tentative, echeance: Echeance) {
  const genereLe = new Date();
  const compteur = new CompteurOctets(exportTailleMaxOctets());

  // ---------------------------------------------------------------- Lectures (une transaction READ ONLY, delais cote base) et selection des jeux
  const lu = await lireDossier(acteur, projetId, tropLong, echeance.resteMs());
  const fiche = lu.projet;
  const jeux = lu.jeux.filter((j) => j.statut !== "RETIRE");
  const jeuxLisibles = new Set(jeux.map((j) => j.id));
  const niveaux = niveauxExportables();
  const selection = selectionGeojson(jeux, { demande: d.geojson, niveaux, jeuxDerogation: t.jeuxDerogation });
  const v = await volumes(selection.inclus.map((i) => i.jeu.id), echeance.resteMs());
  const estimation = v.sommets * OCTETS_PAR_SOMMET + v.objets * OCTETS_PAR_OBJET + v.octetsNoms;
  if (v.objets > exportObjetsMax() || v.sommets > exportSommetsMax() || estimation > exportTailleMaxOctets()) {
    throw new ErreurMetier(422, "EXPORT_TROP_VOLUMINEUX",
      `Les jeux à exporter en GeoJSON portent ${v.objets} objets, ${v.sommets} sommets et environ ${estimation} octets (maximum ${exportObjetsMax()} objets, ${exportSommetsMax()} sommets, ${exportTailleMaxOctets()} octets) : exportez sans GeoJSON (geojson=false).`,
      { objets: v.objets, objetsMax: exportObjetsMax(), sommets: v.sommets, sommetsMax: exportSommetsMax(), octetsEstimes: estimation, octetsMax: exportTailleMaxOctets() });
  }
  const region = fiche.region;
  const ficheJson = {
    projet: {
      id: fiche.id, code: fiche.code, nom: fiche.nom, description: fiche.description, commune: fiche.commune, prefecture: fiche.prefecture,
      region: region ? { id: region.id, nom: region.nom } : null, categorieCode: fiche.categorieCode, territoire: fiche.territoire,
      parametres: fiche.parametres, emprise: { bbox: fiche.bbox, source: "union des emprises declarees des jeux AUTORISE" }, createdAt: fiche.createdAt, updatedAt: fiche.updatedAt,
    },
    jeux: jeux.map(jeuDeFiche),
  };

  // ---------------------------------------------------------------- Agregats d'analyse (jeux AUTORISE seulement, ni croisements ni zones) : un refus n'arrete pas l'export
  let analyse: EntreePdf["analyse"];
  try {
    const a = await calculer({ projetId, inclureNonAutorises: false, sansGeometries: true, delaiMaxMs: echeance.resteMs() });
    analyse = { disponible: true, agregats: agregatsAnalyse(a.reponse) };
  } catch (e) {
    if (!(e instanceof ErreurMetier) || e.code === "PROJET_INTROUVABLE") throw e;
    analyse = { disponible: false, code: e.code, message: e.message };
  }
  const agregats = { analyse2D: analyse.disponible ? { disponible: true, ...analyse.agregats } : analyse, derniereAnalyseConflits: lu.derniere };

  // ---------------------------------------------------------------- Dossiers de conflit (le CSV existant), documents, completude
  const csv = await produireCsvConflits(acteur, projetId, {}, { delaiMaxMs: echeance.resteMs() });
  const documents = lu.documents;
  const historique = lu.historique;
  const completude = await completudeProjet(acteur, projetId, { delaiMaxMs: echeance.resteMs() });
  echeance.verifier();

  const exportId = t.exportId;
  const journal = { documents, historique: historique.map((h) => ({ ...h, details: masquerDetails(h.details, jeuxLisibles) })) };
  const contenus: { chemin: string; contenu: Buffer }[] = [];
  const ajouter = (chemin: string, contenu: Buffer) => { compteur.ajouter(contenu.length); contenus.push({ chemin, contenu }); };
  ajouter("LISEZMOI.txt", Buffer.from(lisezMoi({ code: fiche.code, exportId, genereLe }), "utf8"));
  ajouter("fiche-projet.json", jsonStable(ficheJson));

  // ---------------------------------------------------------------- GeoJSON des jeux retenus (par lots, octets comptes)
  const inclus: { jeuId: string; version: number; role: string; confidentialite: string; nbObjets: number; derogation: boolean; nomsTronques: number }[] = [];
  const ecartes: { jeuId: string; version: number; role: string; confidentialite: string; raison: string }[] = selection.ecartes.map((x) => ({ jeuId: x.jeu.id, version: x.jeu.version, role: x.jeu.role, confidentialite: x.jeu.confidentialite, raison: x.raison }));
  const contenusGeo: { chemin: string; contenu: Buffer }[] = [];
  for (const { jeu, derogation } of selection.inclus) {
    const g = await geojsonDuJeu(jeu, derogation, echeance, compteur);
    if (!g) { ecartes.push({ jeuId: jeu.id, version: jeu.version, role: jeu.role, confidentialite: jeu.confidentialite, raison: "NON_AUTORISE" }); continue; }
    contenusGeo.push({ chemin: nomGeojson(jeu), contenu: g.contenu });
    inclus.push({ jeuId: jeu.id, version: jeu.version, role: jeu.role, confidentialite: jeu.confidentialite, nbObjets: g.nbObjets, derogation, nomsTronques: g.nomsTronques });
  }
  echeance.verifier();

  // ---------------------------------------------------------------- Assemblage
  const racine = racineDossier(fiche.code);
  ajouter("fiche-projet.pdf", produirePdf(lignesFichePdf({
    projet: { code: fiche.code, nom: fiche.nom, commune: fiche.commune, prefecture: fiche.prefecture, region: region?.nom ?? null, categorieCode: fiche.categorieCode, description: fiche.description },
    territoire: fiche.territoire ? { nom: fiche.territoire.nom, niveau: fiche.territoire.niveau, ancetres: fiche.territoire.ancetres } : null,
    parametres: fiche.parametres, jeux: ficheJson.jeux, analyse, conflitsParStatut: lu.conflitsParStatut,
    completude: completude as unknown as EntreePdf["completude"],
    geojson: { demande: d.geojson, inclus, ecartes }, exportId, genereLe, acteur: lu.acteurNom ?? acteur.id,
  }), { titre: `Dossier technique du projet ${fiche.code}`, creeLe: genereLe, producteur: "Console BDRI, export du dossier technique (lot X1)" }));
  ajouter("analyse/agregats.json", jsonStable(agregats));
  ajouter("conflits/dossiers.csv", Buffer.from(csv.csv, "utf8"));
  ajouter("documents/journal.json", jsonStable(journal));
  ajouter("documents/journal.csv", Buffer.from(journalCsv(documents, historique, jeuxLisibles), "utf8"));
  ajouter("documents/completude.json", jsonStable(completude));
  const avertissements: string[] = [];
  if (lu.tronques.documents) avertissements.push(`Plus de ${DOCUMENTS_EXPORT_MAX} documents : le journal est tronque.`);
  if (lu.tronques.historique) avertissements.push(`Plus de ${HISTORIQUE_EXPORT_MAX} lignes d'historique des documents : le journal est tronque.`);
  if (!analyse.disponible) avertissements.push(`Analyse 2D indisponible (${analyse.code}) : les agregats l'indiquent, le reste du dossier est complet.`);
  const nomsTronques = inclus.reduce((s, i) => s + i.nomsTronques, 0);
  if (nomsTronques > 0) avertissements.push(`${nomsTronques} nom(s) d'objet de plus de ${NOM_EXPORT_MAX} caracteres tronque(s) dans les GeoJSON (propriete nomTronque).`);
  const ordre = ["LISEZMOI.txt", "fiche-projet.json", "fiche-projet.pdf", "analyse/agregats.json", "conflits/dossiers.csv", "documents/journal.json", "documents/journal.csv", "documents/completude.json"];
  const tries = [...ordre.map((c) => contenus.find((x) => x.chemin === c)!), ...contenusGeo];
  const bornes = { objetsMax: exportObjetsMax(), sommetsMax: exportSommetsMax(), octetsNonCompressesMax: exportTailleMaxOctets(), delaiMs: exportDelaiMs() };
  const { fichiers, manifeste } = assembler(racine, tries, {
    format: FORMAT_MANIFESTE, exportId, projet: { id: fiche.id, code: fiche.code }, acteur: { id: acteur.id, role: acteur.role }, genereLe: genereLe.toISOString(),
    geojson: { demande: d.geojson, niveauxExportables: niveaux, inclus, ecartes, nomsTronques },
    derogationId: t.derogationId, bornes, octetsNonCompresses: compteur.total, nbDossiersConflit: csv.nbLignes, avertissements,
  });
  const archive = produireZip(fichiers, genereLe);
  echeance.verifier();
  const empreinte = sha256(archive);
  return {
    resultat: { archive, nomFichier: `dossier-${fiche.code.toLowerCase()}-${genereLe.toISOString().slice(0, 10)}.zip`, exportId, sha256: empreinte, nbFichiers: fichiers.length, nbJeuxGeojson: inclus.length },
    remise: { code: fiche.code, empreinte, taille: archive.length, nbFichiers: fichiers.length, manifeste, inclus, ecartes } as Remise,
  };
}

// ------------------------------------------------------------------------------------------------ Journal des exports

export async function journalExports(projetId: string, limite: number) {
  await exigerProjetActif(projetId);
  const lignes = await prisma.exportDossierProjetVoirie.findMany({
    where: { projetId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite,
    select: { id: true, acteurId: true, statut: true, codeEchec: true, derogationId: true, createdAt: true, termineLe: true, sha256: true, tailleOctets: true, nbFichiers: true, nbJeuxGeojson: true },
  });
  const us = lignes.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(lignes.map((l) => l.acteurId))] } }, select: { id: true, nomComplet: true } }) : [];
  return {
    exports: lignes.map((l) => ({
      id: l.id, acteur: us.find((u) => u.id === l.acteurId) ?? { id: l.acteurId, nomComplet: null }, statut: l.statut, codeEchec: l.codeEchec, createdAt: l.createdAt, termineLe: l.termineLe,
      sha256: l.sha256, tailleOctets: l.tailleOctets, nbFichiers: l.nbFichiers, nbJeuxGeojson: l.nbJeuxGeojson, derogationId: l.derogationId,
    })),
  };
}

/** Banc d'integration seulement (revue du lot X1, m5) : ouverture de tentative appelee depuis deux connexions, sans la place unique du compte. */
export const _ouvrirTentativePourBanc = ouvrirTentative;
