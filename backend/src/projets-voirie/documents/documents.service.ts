/**
 * DOCUMENTS DU DOSSIER D'UN PROJET (lot D1 ; contrat : docs/projets-voirie/CONTRAT-DOCUMENTS.md, sections 3 a 5). Regles pures : etats.noyau.ts,
 * piece.noyau.ts.
 *
 * REGLES
 *   - AUCUN fichier n'est stocke : un fichier televerse est lu en memoire pour son format (signature) et son empreinte, puis abandonne ;
 *   - toute ecriture prend le VERROU DU PROJET (delais cote base, 404 pour un projet inexistant ou retire), et est auditee dans sa transaction ;
 *   - l'historique est ecrit PAR LA BASE (declencheur) a partir du dernier geste porte par la ligne (`derniereActionParId`, `derniereJustification`) ;
 *   - un compte qui ne decide pas ne voit que les documents VALIDE ; le jeu lie n'est rendu que s'il lui est lisible (jamais un jeu RETIRE).
 */

import { randomUUID } from "node:crypto";
import { Prisma, type AuditAction } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { estDecideur } from "../conflits/types.noyau";
import { estDelaiDepasse, poserDelais } from "../bd";
import { delaiCarteMs, delaiVerrouMs } from "../config";
import { jeuLisible } from "../conflits/visibilite.noyau";
import { ErreurMetier, introuvable } from "../erreurs";
import { verrouillerProjet, type Acteur, type Tx } from "../projets.service";
import { effetNouvelleVersion, estStatutDocument, verifierChangement, type StatutDocument } from "./etats.noyau";
import { avertissementsPiece, detecterFormatPiece, empreinteSha256, nomFichierSur, type AvertissementDocument } from "./piece.noyau";
import { bornerDecroissant, detailsHistoriqueVisibles, instantaneDocument, vueDocument, type LigneDocument } from "./vues";

const DOCUMENT_INTROUVABLE = () => introuvable("Document", "DOCUMENT_INTROUVABLE");
const JEU_INTROUVABLE = () => new ErreurMetier(404, "JEU_INTROUVABLE", "Jeu de données introuvable dans ce projet (ou retiré).");

/** Piece d'un depot : reference, jeu lie, fichier televerse (jamais conserve). */
export interface PieceDepot {
  reference?: string;
  jeuId?: string;
  fichier?: { contenu: Buffer; nom: string };
}

interface PieceResolue {
  reference: string | null; jeuId: string | null; jeuStatut: string | null; nomFichier: string | null; format: string | null; sha256: string | null; tailleOctets: number | null;
}

function aUnePiece(p: PieceDepot): boolean {
  return p.reference !== undefined || p.jeuId !== undefined || p.fichier !== undefined;
}

async function resoudrePiece(tx: Tx, projetId: string, p: PieceDepot): Promise<PieceResolue> {
  if (p.fichier && p.jeuId) throw new ErreurMetier(400, "PIECE_EXCLUSIVE", "Une piece est soit un fichier televerse (PDF, DWG), soit un jeu importe du projet, pas les deux.");
  let r: PieceResolue = { reference: p.reference?.trim() || null, jeuId: null, jeuStatut: null, nomFichier: null, format: null, sha256: null, tailleOctets: null };
  if (p.fichier) {
    const format = detecterFormatPiece(p.fichier.contenu);
    if (!format) {
      throw new ErreurMetier(415, "FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE",
        "Seuls un PDF (piece de reference) et un DWG (conserve, non exploitable) se deposent comme fichier d'un document, reconnus par leur contenu. Un plan geographique (GeoJSON, KML, DXF, LandXML...) s'importe comme jeu de donnees, puis se lie au document par jeuId.");
    }
    r = { ...r, format, nomFichier: nomFichierSur(p.fichier.nom), sha256: empreinteSha256(p.fichier.contenu), tailleOctets: p.fichier.contenu.length };
  }
  if (p.jeuId) {
    const j = await tx.jeuDonneesProjet.findFirst({ where: { id: p.jeuId, projetId, statut: { not: "RETIRE" } }, select: { id: true, statut: true, format: true, nomFichier: true } });
    if (!j) throw JEU_INTROUVABLE();
    r = { ...r, jeuId: j.id, jeuStatut: j.statut, format: j.format, nomFichier: j.nomFichier.slice(0, 255) };
  }
  return r;
}

/** Type du referentiel : actif exige pour une NOUVELLE saisie (creation) ; une nouvelle version d'un document existant n'exige qu'un type non retire. */
async function exigerType(tx: Tx, code: string, actif: boolean): Promise<void> {
  const t = await tx.referentielVoirie.findFirst({ where: { domaine: "TYPE_DOCUMENT", code, deletedAt: null, ...(actif ? { actif: true } : {}) }, select: { id: true } });
  if (!t) throw new ErreurMetier(400, "TYPE_DOCUMENT_INCONNU", `Le type de document « ${code} » est inconnu, retiré${actif ? " ou désactivé" : ""} (référentiel TYPE_DOCUMENT).`);
}

async function ligneOuErreur(tx: Pick<Tx, "documentProjetVoirie">, projetId: string, docId: string) {
  const d = await tx.documentProjetVoirie.findFirst({ where: { id: docId, projetId, deletedAt: null } });
  if (!d) throw DOCUMENT_INTROUVABLE();
  return d;
}

async function audit(tx: Tx, acteur: Acteur, action: AuditAction, id: string, avant: LigneDocument | null, apres: LigneDocument) {
  await logAuditTransactionnelle(tx, {
    userId: acteur.id, action, entityType: "DocumentProjetVoirie", entityId: id,
    before: avant ? instantaneDocument(avant) : undefined, after: instantaneDocument(apres), ipAddress: acteur.ip,
  });
}

/**
 * Traduit une erreur de la base en erreur typee, jamais un 500 (revue D1, m9) : unicite (course malgre le verrou), reference de referentiel retiree
 * entre la verification du service et l'ecriture (23503), contrainte ou declencheur (23514, 23001 : defaut du service, defense en profondeur), delai.
 */
export function traduireErreurBase(e: unknown): never {
  if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Le projet est occupe par une autre operation : reessayez dans quelques instants.");
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    throw new ErreurMetier(409, "VERSION_EN_COURS", "Une version de ce document est deja en cours d'examen (ou validee) : une seule a la fois.");
  }
  const meta = e instanceof Prisma.PrismaClientKnownRequestError ? (e.meta as { code?: unknown } | undefined)?.code : undefined;
  const texte = e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError ? e.message : "";
  const sqlstate = typeof meta === "string" ? meta : /code: "(23\d{3})"/.exec(texte)?.[1];
  if (sqlstate === "23505") throw new ErreurMetier(409, "VERSION_EN_COURS", "Une version de ce document est deja en cours d'examen (ou validee) : une seule a la fois.");
  // Prisma 5.22 rend une cle etrangere refusee en P2003 et une contrainte en P2004 (sans SQLSTATE) ; une erreur d'un declencheur porte le SQLSTATE dans le message.
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") throw new ErreurMetier(409, "REFERENCE_INVALIDE", "Une reference du document (type du referentiel, concessionnaire, jeu, compte) n'existe plus ou a ete retiree : rechargez et recommencez.");
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2004") throw new ErreurMetier(409, "CONTRAINTE_DOCUMENT", "La base refuse cette ecriture (regle des documents : transition, piece figee, version, separation des taches) : rechargez le document.");
  if (sqlstate === "23503") throw new ErreurMetier(409, "REFERENCE_INVALIDE", "Une reference du document (type du referentiel, concessionnaire, jeu, compte) n'existe plus ou a ete retiree : rechargez et recommencez.");
  if (sqlstate === "23514" || sqlstate === "23001") throw new ErreurMetier(409, "CONTRAINTE_DOCUMENT", "La base refuse cette ecriture (regle des documents : transition, piece figee, version, separation des taches) : rechargez le document.");
  throw e;
}

async function enTransaction<T>(travail: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(travail, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    return traduireErreurBase(e);
  }
}

/**
 * Revue D1, m8 : toute lecture des documents dans une transaction READ ONLY, `statement_timeout` de la carte et `lock_timeout` poses par la base ;
 * un depassement repond 504 type. Le projet inexistant ou retire repond 404 a tous (lu dans la meme transaction).
 */
async function lectureBornee<T>(projetId: string, travail: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await poserDelais(tx, delaiCarteMs(), delaiVerrouMs());
      const p = await tx.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true } });
      if (!p) throw introuvable("Projet", "PROJET_INTROUVABLE");
      return travail(tx);
    }, { timeout: delaiCarteMs() + 5_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDelaiDepasse(e)) throw new ErreurMetier(504, "DOCUMENTS_LECTURE_TROP_LONGUE", "La lecture des documents a depasse le delai : reessayez.");
    throw e;
  }
}

/** Plafonds des listes d'une fiche (revue D1, m7) : les plus recentes sont gardees, la troncature est dite. */
export const VERSIONS_FICHE_MAX = 200;
export const HISTORIQUE_FICHE_MAX = 500;

// ------------------------------------------------------------------------------------------------ Lecture

const visible = (role: string) => (estDecideur(role) ? {} : { statut: "VALIDE" as const });

export interface FiltresDocuments { statuts?: StatutDocument[]; typeCode?: string; toutesVersions: boolean; limite: number; curseur?: { t: Date; i: string } }

export function encoderCurseurDocuments(d: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: d.createdAt.toISOString(), i: d.id }), "utf8").toString("base64url");
}
export function decoderCurseurDocuments(s: string): { t: Date; i: string } | null {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof o.t !== "string" || typeof o.i !== "string" || o.i.length > 64) return null;
    const t = new Date(o.t);
    return Number.isNaN(t.getTime()) ? null : { t, i: o.i };
  } catch { return null; }
}

export async function listerDocuments(acteur: Acteur, projetId: string, f: FiltresDocuments) {
  return lectureBornee(projetId, async (tx) => {
    const and: Prisma.DocumentProjetVoirieWhereInput[] = [{ projetId, deletedAt: null }, visible(acteur.role)];
    if (f.statuts?.length) and.push({ statut: { in: f.statuts } });
    // Versions courantes : tout sauf REMPLACE, et la DERNIERE version non retiree de sa lignee meme si elle est REMPLACE (remplacante retiree, revue D1, M1).
    if (!f.toutesVersions) {
      const orphelines = await tx.$queryRaw<{ id: string }[]>`
        SELECT d."id" FROM "documents_projet_voirie" d
         WHERE d."projetId" = ${projetId} AND d."deletedAt" IS NULL AND d."statut"::text = 'REMPLACE'
           AND NOT EXISTS (SELECT 1 FROM "documents_projet_voirie" n WHERE n."ligneeId" = d."ligneeId" AND n."version" > d."version" AND n."deletedAt" IS NULL)`;
      and.push({ OR: [{ statut: { not: "REMPLACE" } }, { id: { in: orphelines.map((o) => o.id) } }] });
    }
    if (f.typeCode) and.push({ typeCode: f.typeCode });
    if (f.curseur) and.push({ OR: [{ createdAt: { lt: f.curseur.t } }, { createdAt: f.curseur.t, id: { lt: f.curseur.i } }] });
    const lignes = await tx.documentProjetVoirie.findMany({ where: { AND: and }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.limite + 1 });
    const page = lignes.slice(0, f.limite);
    const vues = await vuesDe(tx, acteur, page);
    const dernier = page[page.length - 1];
    return { documents: vues, curseurSuivant: lignes.length > f.limite && dernier ? encoderCurseurDocuments(dernier) : null };
  });
}

/** Vues d'un lot de lignes : types, concessionnaires, personnes et jeux lus en une requete chacun, sur le client donne (transaction). */
async function vuesDe(tx: Tx, acteur: Acteur, lignes: LigneDocument[]) {
  if (lignes.length === 0) return [];
  const codes = [...new Set(lignes.map((l) => l.typeCode))];
  const concs = [...new Set(lignes.map((l) => l.concessionnaireId).filter((x): x is string => !!x))];
  const jeux = [...new Set(lignes.map((l) => l.jeuId).filter((x): x is string => !!x))];
  const personnes = [...new Set(lignes.flatMap((l) => [l.creeParId, l.deposeParId, l.valideParId, l.derniereActionParId]).filter((x): x is string => !!x))];
  const types = await tx.referentielVoirie.findMany({ where: { domaine: "TYPE_DOCUMENT", code: { in: codes } }, select: { code: true, libelle: true, actif: true, deletedAt: true } });
  const cs = concs.length ? await tx.concessionnaireReseau.findMany({ where: { id: { in: concs } }, select: { id: true, nom: true } }) : [];
  const js = jeux.length ? await tx.jeuDonneesProjet.findMany({ where: { id: { in: jeux } }, select: { id: true, statut: true, role: true, version: true, format: true } }) : [];
  const us = await tx.user.findMany({ where: { id: { in: personnes } }, select: { id: true, nomComplet: true } });
  return lignes.map((l) => vueDocument(l, {
    role: acteur.role,
    type: types.find((t) => t.code === l.typeCode) ?? null,
    concessionnaire: cs.find((c) => c.id === l.concessionnaireId) ?? null,
    jeu: js.find((j) => j.id === l.jeuId) ?? null,
    personnes: new Map(us.map((u) => [u.id, u])),
  }));
}

export async function ficheDocument(acteur: Acteur, projetId: string, docId: string) {
  return lectureBornee(projetId, async (tx) => {
    const d = await tx.documentProjetVoirie.findFirst({ where: { id: docId, projetId, deletedAt: null, ...visible(acteur.role) } });
    if (!d) throw DOCUMENT_INTROUVABLE();
    const [vue] = await vuesDe(tx, acteur, [d]);
    const v = bornerDecroissant(await tx.documentProjetVoirie.findMany({
      where: { ligneeId: d.ligneeId, projetId, deletedAt: null, ...visible(acteur.role) }, orderBy: { version: "desc" }, take: VERSIONS_FICHE_MAX + 1,
      select: { id: true, version: true, statut: true, createdAt: true },
    }), VERSIONS_FICHE_MAX);
    if (!estDecideur(acteur.role)) return { document: vue, versions: v.lignes, versionsTronquees: v.tronque };
    // L'historique de la lignee reste visible des decideurs, versions retirees comprises (trace du retrait) ; les details d'un jeu illisible sont retires.
    const h = bornerDecroissant(await tx.documentProjetVoirieHistorique.findMany({ where: { ligneeId: d.ligneeId, projetId }, orderBy: { id: "desc" }, take: HISTORIQUE_FICHE_MAX + 1 }), HISTORIQUE_FICHE_MAX);
    const ids = [...new Set(h.lignes.map((x) => x.acteurId))];
    const us = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, nomComplet: true } }) : [];
    const jeuxHisto = [...new Set(h.lignes.map((x) => (x.details as { jeuId?: unknown } | null)?.jeuId).filter((x): x is string => typeof x === "string"))];
    const statutsJeux = jeuxHisto.length ? await tx.jeuDonneesProjet.findMany({ where: { id: { in: jeuxHisto } }, select: { id: true, statut: true } }) : [];
    const lisible = (details: unknown) => {
      const j = (details as { jeuId?: unknown } | null)?.jeuId;
      return typeof j !== "string" || jeuLisible(acteur.role, statutsJeux.find((x) => x.id === j)?.statut ?? "RETIRE");
    };
    return {
      document: vue, versions: v.lignes, versionsTronquees: v.tronque, historiqueTronque: h.tronque,
      historique: h.lignes.map((x) => ({
        id: Number(x.id), documentId: x.documentId, version: x.version, action: x.action, statutAvant: x.statutAvant, statutApres: x.statutApres,
        par: us.find((u) => u.id === x.acteurId) ?? { id: x.acteurId, nomComplet: null }, justification: x.justification,
        details: detailsHistoriqueVisibles(x.details, lisible(x.details)), le: x.createdAt,
      })),
    };
  });
}

// ------------------------------------------------------------------------------------------------ Ecritures

export interface CreationDocument { typeCode: string; titre: string; description?: string; dateDocument?: string; concessionnaireId?: string }

export async function creerDocument(acteur: Acteur, projetId: string, d: CreationDocument, piece: PieceDepot) {
  return enTransaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    await exigerType(tx, d.typeCode, true);
    if (d.concessionnaireId) {
      const c = await tx.concessionnaireReseau.findFirst({ where: { id: d.concessionnaireId, deletedAt: null }, select: { id: true } });
      if (!c) throw new ErreurMetier(400, "CONCESSIONNAIRE_INCONNU", "Concessionnaire inconnu ou retiré.");
    }
    const avecPiece = aUnePiece(piece);
    const p = avecPiece ? await resoudrePiece(tx, projetId, piece) : null;
    const maintenant = new Date();
    const id = randomUUID();
    const ligne = await tx.documentProjetVoirie.create({
      data: {
        id, projetId, ligneeId: id, version: 1, typeCode: d.typeCode, titre: d.titre.trim(), description: d.description?.trim() || null,
        dateDocument: d.dateDocument ? new Date(`${d.dateDocument}T00:00:00.000Z`) : null, concessionnaireId: d.concessionnaireId ?? null,
        statut: p ? "RECU" : "ATTENDU",
        ...(p ? { reference: p.reference, jeuId: p.jeuId, nomFichier: p.nomFichier, format: p.format, sha256: p.sha256, tailleOctets: p.tailleOctets, deposeParId: acteur.id, deposeLe: maintenant } : {}),
        creeParId: acteur.id, derniereActionParId: acteur.id, derniereActionLe: maintenant, derniereJustification: null,
      },
    });
    await audit(tx, acteur, "CREATE", id, null, ligne);
    const [vue] = await vuesDe(tx, acteur, [ligne]);
    return { document: vue, avertissements: p ? avertissementsPiece(p) : [] as AvertissementDocument[] };
  });
}

/** Depot de la piece d'un document ATTENDU : meme ligne, statut RECU. */
export async function deposerPiece(acteur: Acteur, projetId: string, docId: string, piece: PieceDepot) {
  if (!aUnePiece(piece)) throw new ErreurMetier(400, "PIECE_REQUISE", "Une piece est requise : reference, jeuId ou fichier (PDF, DWG).");
  return enTransaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const avant = await ligneOuErreur(tx, projetId, docId);
    if (avant.statut !== "ATTENDU") throw new ErreurMetier(409, "STATUT_INCOMPATIBLE", `Seul un document ATTENDU recoit sa piece par un depot (statut actuel : ${avant.statut}) : deposez une nouvelle version.`, { statut: avant.statut });
    const p = await resoudrePiece(tx, projetId, piece);
    const maintenant = new Date();
    const apres = await tx.documentProjetVoirie.update({
      where: { id: docId },
      data: {
        statut: "RECU", reference: p.reference, jeuId: p.jeuId, nomFichier: p.nomFichier, format: p.format, sha256: p.sha256, tailleOctets: p.tailleOctets,
        deposeParId: acteur.id, deposeLe: maintenant, derniereActionParId: acteur.id, derniereActionLe: maintenant, derniereJustification: null,
      },
    });
    await audit(tx, acteur, "UPDATE", docId, avant, apres);
    const [vue] = await vuesDe(tx, acteur, [apres]);
    return { document: vue, avertissements: avertissementsPiece(p) };
  });
}

/** Nouvelle version d'un document, deposee sur sa DERNIERE version (contrat, section 4 : effet sur la version precedente). */
export async function nouvelleVersion(acteur: Acteur, projetId: string, docId: string, piece: PieceDepot) {
  if (!aUnePiece(piece)) throw new ErreurMetier(400, "PIECE_REQUISE", "Une piece est requise : reference, jeuId ou fichier (PDF, DWG).");
  return enTransaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const precedente = await ligneOuErreur(tx, projetId, docId);
    // Revue D1, M1 : la derniere version est la derniere NON RETIREE ; une version retiree ne fige pas la lignee.
    const plusRecente = await tx.documentProjetVoirie.findFirst({ where: { ligneeId: precedente.ligneeId, version: { gt: precedente.version }, deletedAt: null }, select: { id: true } });
    if (plusRecente) throw new ErreurMetier(409, "VERSION_NON_COURANTE", "Cette version n'est pas la derniere du document : deposez la nouvelle version sur la derniere.", { derniereId: plusRecente.id });
    await exigerType(tx, precedente.typeCode, false);
    const effet = effetNouvelleVersion(precedente.statut);
    if (!effet.ok) throw new ErreurMetier(effet.status, effet.code, effet.message, effet.extra);
    const p = await resoudrePiece(tx, projetId, piece);
    const maintenant = new Date();
    // Numero suivant : le plus grand de la lignee, versions retirees comprises (l'index (lignee, version) les garde).
    const max = await tx.documentProjetVoirie.aggregate({ where: { ligneeId: precedente.ligneeId }, _max: { version: true } });
    const version = (max._max.version ?? precedente.version) + 1;
    let precedenteApres = precedente;
    if (effet.precedente === "REMPLACE") {
      // La precedente quitte l'index « une version en cours » AVANT l'insertion ; la base verifie a la fin de la transaction qu'une version plus recente existe.
      precedenteApres = await tx.documentProjetVoirie.update({
        where: { id: precedente.id },
        data: { statut: "REMPLACE", derniereActionParId: acteur.id, derniereActionLe: maintenant, derniereJustification: `Remplacee par la version ${version}.` },
      });
      await audit(tx, acteur, "UPDATE", precedente.id, precedente, precedenteApres);
    }
    const id = randomUUID();
    const ligne = await tx.documentProjetVoirie.create({
      data: {
        id, projetId, ligneeId: precedente.ligneeId, version, remplaceId: precedente.id, typeCode: precedente.typeCode, titre: precedente.titre,
        description: precedente.description, dateDocument: precedente.dateDocument, concessionnaireId: precedente.concessionnaireId, statut: "RECU",
        reference: p.reference, jeuId: p.jeuId, nomFichier: p.nomFichier, format: p.format, sha256: p.sha256, tailleOctets: p.tailleOctets,
        deposeParId: acteur.id, deposeLe: maintenant, creeParId: acteur.id, derniereActionParId: acteur.id, derniereActionLe: maintenant, derniereJustification: null,
      },
    });
    await audit(tx, acteur, "CREATE", id, null, ligne);
    const [vue] = await vuesDe(tx, acteur, [ligne]);
    return { document: vue, remplace: { id: precedenteApres.id, version: precedenteApres.version, statut: precedenteApres.statut }, avertissements: avertissementsPiece(p) };
  });
}

/** Changement de statut demande (route `statut`) : regles du noyau, puis la base (meme matrice, separation des taches, DWG). */
export async function changerStatut(acteur: Acteur, projetId: string, docId: string, vers: string, justification: string | undefined) {
  return enTransaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const avant = await ligneOuErreur(tx, projetId, docId);
    const jeu = avant.jeuId ? await tx.jeuDonneesProjet.findUnique({ where: { id: avant.jeuId }, select: { statut: true } }) : null;
    const v = verifierChangement({
      de: avant.statut, vers, acteurId: acteur.id, deposeParId: avant.deposeParId, justification, format: avant.format, jeuId: avant.jeuId, jeuStatut: jeu?.statut ?? null,
    });
    if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message, v.extra);
    if (!estStatutDocument(vers)) throw new ErreurMetier(409, "TRANSITION_INTERDITE", "Statut inconnu.");
    const maintenant = new Date();
    const texte = justification?.trim() || null;
    if (vers === "VALIDE") {
      // Une seule version VALIDE par lignee : l'ancienne passe REMPLACE AVANT (index unique partiel).
      const anciennes = await tx.documentProjetVoirie.findMany({ where: { ligneeId: avant.ligneeId, statut: "VALIDE", deletedAt: null, id: { not: avant.id } } });
      for (const a of anciennes) {
        const apresA = await tx.documentProjetVoirie.update({
          where: { id: a.id },
          data: { statut: "REMPLACE", derniereActionParId: acteur.id, derniereActionLe: maintenant, derniereJustification: `Remplacee par la version ${avant.version} validee.` },
        });
        await audit(tx, acteur, "UPDATE", a.id, a, apresA);
      }
    }
    const apres = await tx.documentProjetVoirie.update({
      where: { id: docId },
      data: {
        statut: vers, derniereActionParId: acteur.id, derniereActionLe: maintenant, derniereJustification: texte,
        ...(vers === "VALIDE" ? { valideParId: acteur.id, valideLe: maintenant } : {}),
      },
    });
    await audit(tx, acteur, vers === "VALIDE" ? "VALIDATE" : vers === "REJETE" ? "REJECT" : "UPDATE", docId, avant, apres);
    const [vue] = await vuesDe(tx, acteur, [apres]);
    return { document: vue };
  });
}

/** Retrait logique d'une version (fige, montree a personne). Une version VALIDE ne se retire que par un ADMIN. */
export async function retirerDocument(acteur: Acteur, projetId: string, docId: string, justification: string) {
  const texte = justification.trim();
  if (texte.length < 10) throw new ErreurMetier(400, "JUSTIFICATION_INVALIDE", "Le retrait d'un document exige une justification de 10 caractères au moins.");
  return enTransaction(async (tx) => {
    await verrouillerProjet(tx, projetId);
    const avant = await ligneOuErreur(tx, projetId, docId);
    if (avant.statut === "VALIDE" && acteur.role !== "ADMIN") throw new ErreurMetier(403, "ROLE_INSUFFISANT", "Seul un administrateur retire une piece validee du dossier.");
    const maintenant = new Date();
    const apres = await tx.documentProjetVoirie.update({
      where: { id: docId }, data: { deletedAt: maintenant, derniereActionParId: acteur.id, derniereActionLe: maintenant, derniereJustification: texte },
    });
    await audit(tx, acteur, "DELETE", docId, avant, apres);
    return { id: docId, retire: true };
  });
}
