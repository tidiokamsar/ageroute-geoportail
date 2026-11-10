/**
 * EXPORT DU DOSSIER TECHNIQUE D'UN PROJET (lot X1 ; contrat docs/projets-voirie/CONTRAT-EXPORTS.md, section 4). Archive ZIP produite par le serveur,
 * bornee, auditee AVANT la remise, reservee aux decideurs (la route l'impose), deroulee dans l'ordre de la section 4.5.
 *
 * REGLES
 *   - rien d'un jeu RETIRE (fiche, GeoJSON, CSV, journal des documents) ; GeoJSON des seuls jeux AUTORISE d'un niveau exportable, ou couverts par une
 *     derogation ADMIN citee, valide et consommee dans la transaction de remise (usage unique garanti aussi par la base) ;
 *   - chaque lecture a son delai cote base (`poserDelais`) ; le delai total de fabrication est borne (504) ; volumes comptes AVANT de lire une geometrie ;
 *   - la remise (journal, consommation de la derogation, audits) est UNE transaction : tout ou rien ; aucun octet n'est rendu avant qu'elle reussisse ;
 *   - aucune geometrie dans l'audit ni dans le journal (empreintes, tailles, identifiants, niveaux, nombres).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { Budget, estDelaiDepasse, poserDelais } from "../bd";
import { delaiAnalyseMs, delaiDepotMs, delaiVerrouMs } from "../config";
import { calculer } from "../analyse.service";
import { exigerProjetActif, produireCsvConflits } from "../conflits/dossiers.service";
import { completudeProjet } from "../documents/completude.service";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur } from "../projets.service";
import { verifierCadence } from "./cadence.noyau";
import {
  exportCadenceFenetreS, exportCadenceMax, exportDelaiMs, exportObjetsMax, exportSommetsMax, exportTailleMaxOctets, niveauxExportables,
} from "./config";
import { selectionGeojson, verifierDerogationCitee, type JeuCandidat } from "./confidentialite.noyau";
import { agregatsAnalyse, jeuDeFiche, lignesFichePdf, lisezMoi, type EntreePdf } from "./fiche.noyau";
import { journalCsv, masquerDetails } from "./journal-documents.noyau";
import { DOCUMENTS_EXPORT_MAX, HISTORIQUE_EXPORT_MAX, lireDossier } from "./lecture-dossier";
import { limiteurExports, reserverExportCompte, sousLimiteur } from "./limiteurs";
import { FORMAT_MANIFESTE, assembler, jsonStable, nomGeojson, racineDossier, sha256 } from "./manifeste.noyau";
import { produirePdf } from "./pdf.noyau";
import { produireZip } from "./zip-ecriture.noyau";


export interface DemandeExport { geojson: boolean; derogationId?: string }

export interface ArchiveRemise {
  archive: Buffer; nomFichier: string; exportId: string; sha256: string; nbFichiers: number; nbJeuxGeojson: number;
}

const tropLong = () => new ErreurMetier(504, "EXPORT_TROP_LONG", `La fabrication du dossier a dépassé ${Math.round(exportDelaiMs() / 1000)} s et a été interrompue : réessayez, ou exportez sans GeoJSON.`);

/** Echeance totale : verifiee entre deux etapes ; chaque lecture a en plus son propre `statement_timeout` cote base. */
class Echeance {
  private readonly fin = Date.now() + exportDelaiMs();
  verifier(): void { if (Date.now() > this.fin) throw tropLong(); }
  resteMs(): number { return this.fin - Date.now(); }
}

async function cadenceOuErreur(lecteur: Pick<typeof prisma, "exportDossierProjetVoirie">, acteurId: string, maintenant: Date): Promise<void> {
  const fenetreS = exportCadenceFenetreS();
  const plafond = exportCadenceMax();
  const recents = await lecteur.exportDossierProjetVoirie.findMany({
    where: { acteurId, createdAt: { gt: new Date(maintenant.getTime() - fenetreS * 1000) } }, select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: plafond,
  });
  const v = verifierCadence({ horodatages: recents.map((r) => r.createdAt), maintenant, fenetreS, plafond });
  if (!v.ok) {
    throw new ErreurMetier(429, "EXPORT_TROP_FREQUENT", `Au plus ${plafond} dossiers exportés par compte en ${fenetreS} s : réessayez dans ${v.retryAfterS} s.`, { retryAfterS: v.retryAfterS });
  }
}

interface ObjetLu { id: string; nom: string | null; typeGeom: string; longueurM: number | null; ordre: number; g: string }

/** GeoJSON d'un jeu, construit sans re-analyser les geometries (chaine de PostGIS inseree telle quelle). Rend null si le jeu n'est plus AUTORISE. */
async function geojsonDuJeu(jeu: JeuCandidat & { sha256: string; nbObjets: number }, derogation: boolean, echeance: Echeance): Promise<{ contenu: Buffer; nbObjets: number } | null> {
  echeance.verifier();
  const delai = Math.max(1_000, Math.min(delaiAnalyseMs(), echeance.resteMs()));
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const budget = new Budget(tx, delai, delaiVerrouMs(), tropLong);
      const statut = await budget.etape(() => tx.$queryRaw<{ s: string }[]>`SELECT "statut"::text AS "s" FROM "projets_voirie_jeux" WHERE "id" = ${jeu.id}`);
      if (statut[0]?.s !== "AUTORISE") return null;
      const objets = await budget.etape(() => tx.$queryRaw<ObjetLu[]>`
        SELECT "id"::text AS "id", "nom", "typeGeom"::text AS "typeGeom", "longueurM", "ordre", ST_AsGeoJSON("geom", 7) AS "g"
          FROM "projets_voirie_objets" WHERE "jeuId" = ${jeu.id} ORDER BY "ordre", "id"`, "geojson");
      const entete = JSON.stringify({ jeuId: jeu.id, role: jeu.role, version: jeu.version, sha256Source: jeu.sha256, confidentialite: jeu.confidentialite, derogation });
      const features = objets.map((o) => `{"type":"Feature","geometry":${o.g},"properties":${JSON.stringify({ objetId: o.id, nom: o.nom, typeGeom: o.typeGeom, longueurM: o.longueurM === null ? null : Math.round(Number(o.longueurM) * 100) / 100, ordre: o.ordre })}}`);
      return { contenu: Buffer.from(`{"type":"FeatureCollection","bdri":${entete},"features":[\n${features.join(",\n")}\n]}\n`, "utf8"), nbObjets: objets.length };
    }, { timeout: delai + 10_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDelaiDepasse(e)) throw tropLong();
    throw e;
  }
}

/** Volumes des jeux a exporter, comptes en base AVANT toute lecture de geometrie. */
async function volumes(ids: string[]): Promise<{ objets: number; sommets: number }> {
  if (ids.length === 0) return { objets: 0, sommets: 0 };
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await poserDelais(tx, delaiAnalyseMs(), delaiVerrouMs());
      const r = await tx.$queryRaw<{ n: bigint; s: bigint }[]>`
        SELECT count(*)::bigint AS "n", coalesce(sum(ST_NPoints("geom")), 0)::bigint AS "s" FROM "projets_voirie_objets" WHERE "jeuId" = ANY(${ids}::text[])`;
      return { objets: Number(r[0].n), sommets: Number(r[0].s) };
    }, { timeout: delaiAnalyseMs() + 10_000, maxWait: 10_000 });
  } catch (e) {
    if (estDelaiDepasse(e)) throw tropLong();
    throw e;
  }
}

export async function exporterDossier(acteur: Acteur, projetId: string, d: DemandeExport): Promise<ArchiveRemise> {
  await exigerProjetActif(projetId);
  const liberer = reserverExportCompte(acteur.id);
  try {
    return await sousLimiteur(limiteurExports, "Le service fabrique déjà d'autres dossiers : réessayez dans quelques instants.", () => fabriquer(acteur, projetId, d));
  } finally {
    liberer();
  }
}

async function fabriquer(acteur: Acteur, projetId: string, d: DemandeExport): Promise<ArchiveRemise> {
  const echeance = new Echeance();
  const genereLe = new Date();
  await cadenceOuErreur(prisma, acteur.id, genereLe);

  // Derogation citee : verifiee AVANT la fabrication, consommee a la remise (sous condition : une autre requete ne peut pas l'avoir prise entre-temps).
  let jeuxDerogation = new Set<string>();
  if (d.derogationId) {
    const der = await prisma.derogationExportProjetVoirie.findUnique({ where: { id: d.derogationId } });
    const v = verifierDerogationCitee(der, { projetId, acteurId: acteur.id, maintenant: genereLe });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message, v.extra);
    jeuxDerogation = new Set(der!.jeuxIds);
  }

  // ---------------------------------------------------------------- Lectures (une transaction READ ONLY, delais cote base) et selection des jeux
  const lu = await lireDossier(acteur, projetId, tropLong);
  const fiche = lu.projet;
  const jeux = lu.jeux.filter((j) => j.statut !== "RETIRE");
  const jeuxLisibles = new Set(jeux.map((j) => j.id));
  const niveaux = niveauxExportables();
  const selection = selectionGeojson(jeux, { demande: d.geojson, niveaux, jeuxDerogation });
  const v = await volumes(selection.inclus.map((i) => i.jeu.id));
  if (v.objets > exportObjetsMax() || v.sommets > exportSommetsMax()) {
    throw new ErreurMetier(422, "EXPORT_TROP_VOLUMINEUX",
      `Les jeux à exporter en GeoJSON portent ${v.objets} objets et ${v.sommets} sommets (maximum ${exportObjetsMax()} objets et ${exportSommetsMax()} sommets) : exportez sans GeoJSON (geojson=false).`,
      { objets: v.objets, objetsMax: exportObjetsMax(), sommets: v.sommets, sommetsMax: exportSommetsMax() });
  }
  echeance.verifier();
  const region = fiche.region;
  const ficheJson = {
    projet: {
      id: fiche.id, code: fiche.code, nom: fiche.nom, description: fiche.description, commune: fiche.commune, prefecture: fiche.prefecture,
      region: region ? { id: region.id, nom: region.nom } : null, categorieCode: fiche.categorieCode, territoire: fiche.territoire,
      parametres: fiche.parametres, emprise: { bbox: fiche.bbox, source: "union des emprises declarees des jeux AUTORISE" }, createdAt: fiche.createdAt, updatedAt: fiche.updatedAt,
    },
    jeux: jeux.map(jeuDeFiche),
  };

  // ---------------------------------------------------------------- Agregats d'analyse (jeux AUTORISE seulement) : un refus n'arrete pas l'export
  let analyse: EntreePdf["analyse"];
  try {
    const a = await calculer({ projetId, inclureNonAutorises: false });
    analyse = { disponible: true, agregats: agregatsAnalyse(a.reponse) };
  } catch (e) {
    if (!(e instanceof ErreurMetier) || e.code === "PROJET_INTROUVABLE") throw e;
    analyse = { disponible: false, code: e.code, message: e.message };
  }
  echeance.verifier();
  const agregats = { analyse2D: analyse.disponible ? { disponible: true, ...analyse.agregats } : analyse, derniereAnalyseConflits: lu.derniere };

  // ---------------------------------------------------------------- Dossiers de conflit : le CSV existant (meme lisibilite, meme neutralisation)
  const csv = await produireCsvConflits(acteur, projetId, {});
  const conflitsParStatut = lu.conflitsParStatut;
  echeance.verifier();

  // ---------------------------------------------------------------- Documents (vues du lot D1, masquees pour le compte) et completude
  const documents = lu.documents;
  const historique = lu.historique;
  const completude = await completudeProjet(acteur, projetId);
  echeance.verifier();

  // ---------------------------------------------------------------- GeoJSON des jeux retenus
  const inclus: { jeuId: string; version: number; role: string; confidentialite: string; nbObjets: number; derogation: boolean; chemin: string }[] = [];
  const ecartes: { jeuId: string; version: number; role: string; confidentialite: string; raison: string }[] = selection.ecartes.map((x) => ({ jeuId: x.jeu.id, version: x.jeu.version, role: x.jeu.role, confidentialite: x.jeu.confidentialite, raison: x.raison }));
  const contenusGeo: { chemin: string; contenu: Buffer }[] = [];
  for (const { jeu, derogation } of selection.inclus) {
    const g = await geojsonDuJeu(jeu, derogation, echeance);
    if (!g) { ecartes.push({ jeuId: jeu.id, version: jeu.version, role: jeu.role, confidentialite: jeu.confidentialite, raison: "NON_AUTORISE" }); continue; }
    const chemin = nomGeojson(jeu);
    contenusGeo.push({ chemin, contenu: g.contenu });
    inclus.push({ jeuId: jeu.id, version: jeu.version, role: jeu.role, confidentialite: jeu.confidentialite, nbObjets: g.nbObjets, derogation, chemin });
  }
  echeance.verifier();

  // ---------------------------------------------------------------- Assemblage
  const exportId = randomUUID();
  const racine = racineDossier(fiche.code);
  const pdf = produirePdf(lignesFichePdf({
    projet: { code: fiche.code, nom: fiche.nom, commune: fiche.commune, prefecture: fiche.prefecture, region: region?.nom ?? null, categorieCode: fiche.categorieCode, description: fiche.description },
    territoire: fiche.territoire ? { nom: fiche.territoire.nom, niveau: fiche.territoire.niveau, ancetres: fiche.territoire.ancetres } : null,
    parametres: fiche.parametres, jeux: ficheJson.jeux, analyse, conflitsParStatut,
    completude: completude as unknown as EntreePdf["completude"],
    geojson: { demande: d.geojson, inclus, ecartes }, exportId, genereLe, acteur: lu.acteurNom ?? acteur.id,
  }), { titre: `Dossier technique du projet ${fiche.code}`, creeLe: genereLe, producteur: "Console BDRI, export du dossier technique (lot X1)" });
  const avertissements: string[] = [];
  if (lu.tronques.documents) avertissements.push(`Plus de ${DOCUMENTS_EXPORT_MAX} documents : le journal est tronque.`);
  if (lu.tronques.historique) avertissements.push(`Plus de ${HISTORIQUE_EXPORT_MAX} lignes d'historique des documents : le journal est tronque.`);
  if (!analyse.disponible) avertissements.push(`Analyse 2D indisponible (${analyse.code}) : les agregats l'indiquent, le reste du dossier est complet.`);
  const journal = {
    documents,
    historique: historique.map((h) => ({ ...h, details: masquerDetails(h.details, jeuxLisibles) })),
  };
  const contenus = [
    { chemin: "LISEZMOI.txt", contenu: Buffer.from(lisezMoi({ code: fiche.code, exportId, genereLe }), "utf8") },
    { chemin: "fiche-projet.json", contenu: jsonStable(ficheJson) },
    { chemin: "fiche-projet.pdf", contenu: pdf },
    { chemin: "analyse/agregats.json", contenu: jsonStable(agregats) },
    { chemin: "conflits/dossiers.csv", contenu: Buffer.from(csv.csv, "utf8") },
    { chemin: "documents/journal.json", contenu: jsonStable(journal) },
    { chemin: "documents/journal.csv", contenu: Buffer.from(journalCsv(documents, historique, jeuxLisibles), "utf8") },
    { chemin: "documents/completude.json", contenu: jsonStable(completude) },
    ...contenusGeo,
  ];
  const bornes = { objetsMax: exportObjetsMax(), sommetsMax: exportSommetsMax(), tailleMaxOctets: exportTailleMaxOctets(), delaiMs: exportDelaiMs() };
  const { fichiers, manifeste } = assembler(racine, contenus, {
    format: FORMAT_MANIFESTE, exportId, projet: { id: fiche.id, code: fiche.code }, acteur: { id: acteur.id, role: acteur.role }, genereLe: genereLe.toISOString(),
    geojson: { demande: d.geojson, niveauxExportables: niveaux, inclus: inclus.map(({ chemin: _c, ...r }) => { void _c; return r; }), ecartes },
    derogationId: d.derogationId ?? null, bornes, nbDossiersConflit: csv.nbLignes, avertissements,
  });
  const archive = produireZip(fichiers, genereLe);
  if (archive.length > exportTailleMaxOctets()) {
    throw new ErreurMetier(422, "EXPORT_TROP_VOLUMINEUX", `L'archive ferait ${archive.length} octets (maximum ${exportTailleMaxOctets()}) : exportez sans GeoJSON (geojson=false).`, { octets: archive.length, octetsMax: exportTailleMaxOctets() });
  }
  echeance.verifier();
  const empreinte = sha256(archive);

  // ---------------------------------------------------------------- Remise : journal, derogation, audits, en UNE transaction (avant l'envoi)
  const manifesteJournal = { ...manifeste };
  await remettre(acteur, { projetId, code: fiche.code, exportId, empreinte, taille: archive.length, nbFichiers: fichiers.length, inclus, ecartes, manifeste: manifesteJournal, derogationId: d.derogationId, genereLe });
  return { archive, nomFichier: `dossier-${fiche.code.toLowerCase()}-${genereLe.toISOString().slice(0, 10)}.zip`, exportId, sha256: empreinte, nbFichiers: fichiers.length, nbJeuxGeojson: inclus.length };
}

async function remettre(acteur: Acteur, r: {
  projetId: string; code: string; exportId: string; empreinte: string; taille: number; nbFichiers: number; derogationId?: string; genereLe: Date;
  inclus: { jeuId: string; version: number; confidentialite: string; nbObjets: number; derogation: boolean }[];
  ecartes: { jeuId: string; raison: string }[]; manifeste: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
      // Verrou consultatif par compte : deux remises simultanees d'un meme compte (deux instances) ne depassent pas ensemble la cadence.
      await tx.$queryRaw`SELECT 1 AS "ok" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`pv-export-dossier|${acteur.id}`}, 0))) v`;
      const p = await tx.projetVoirie.findFirst({ where: { id: r.projetId, deletedAt: null }, select: { id: true } });
      if (!p) throw introuvable("Projet", "PROJET_INTROUVABLE");
      const maintenant = new Date();
      await cadenceOuErreur(tx, acteur.id, maintenant);
      await tx.exportDossierProjetVoirie.create({
        data: { id: r.exportId, projetId: r.projetId, acteurId: acteur.id, sha256: r.empreinte, tailleOctets: r.taille, nbFichiers: r.nbFichiers, nbJeuxGeojson: r.inclus.length, manifeste: r.manifeste as object, createdAt: maintenant },
      });
      if (r.derogationId) {
        const n = await tx.derogationExportProjetVoirie.updateMany({
          where: { id: r.derogationId, projetId: r.projetId, beneficiaireId: acteur.id, utiliseeLe: null, expireLe: { gt: maintenant } },
          data: { utiliseeLe: maintenant, exportId: r.exportId },
        });
        if (n.count !== 1) throw new ErreurMetier(409, "DEROGATION_INDISPONIBLE", "Cette dérogation vient d'être utilisée ou a expiré : aucune archive n'a été remise.", { etat: "UTILISEE_OU_EXPIREE" });
        await logAuditTransactionnelle(tx, {
          userId: acteur.id, action: "UPDATE", entityType: "DerogationExportProjetVoirie", entityId: r.derogationId,
          before: { utiliseeLe: null, exportId: null }, after: { utiliseeLe: maintenant, exportId: r.exportId, projetId: r.projetId, jeuxExportes: r.inclus.filter((i) => i.derogation).map((i) => i.jeuId) },
          ipAddress: acteur.ip,
        });
      }
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "CREATE", entityType: "ExportDossierProjetVoirie", entityId: r.projetId,
        after: {
          format: "zip", exportId: r.exportId, projet: r.code, sha256: r.empreinte, tailleOctets: r.taille, nbFichiers: r.nbFichiers,
          geojson: r.inclus.map((i) => ({ jeuId: i.jeuId, version: i.version, confidentialite: i.confidentialite, nbObjets: i.nbObjets, derogation: i.derogation })),
          ecartes: r.ecartes.map((e) => ({ jeuId: e.jeuId, raison: e.raison })), derogationId: r.derogationId ?? null, geometries: r.inclus.length > 0,
        },
        ipAddress: acteur.ip,
      });
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "La remise du dossier n'a pas pu être enregistrée à temps : réessayez dans quelques instants.");
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ Journal des exports

export async function journalExports(projetId: string, limite: number) {
  await exigerProjetActif(projetId);
  const lignes = await prisma.exportDossierProjetVoirie.findMany({
    where: { projetId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite,
    select: { id: true, acteurId: true, createdAt: true, sha256: true, tailleOctets: true, nbFichiers: true, nbJeuxGeojson: true },
  });
  const [us, ders] = lignes.length
    ? await Promise.all([
      prisma.user.findMany({ where: { id: { in: [...new Set(lignes.map((l) => l.acteurId))] } }, select: { id: true, nomComplet: true } }),
      prisma.derogationExportProjetVoirie.findMany({ where: { exportId: { in: lignes.map((l) => l.id) } }, select: { id: true, exportId: true } }),
    ])
    : [[], []];
  return {
    exports: lignes.map((l) => ({
      id: l.id, acteur: us.find((u) => u.id === l.acteurId) ?? { id: l.acteurId, nomComplet: null }, createdAt: l.createdAt, sha256: l.sha256,
      tailleOctets: l.tailleOctets, nbFichiers: l.nbFichiers, nbJeuxGeojson: l.nbJeuxGeojson, derogationId: ders.find((x) => x.exportId === l.id)?.id ?? null,
    })),
  };
}
