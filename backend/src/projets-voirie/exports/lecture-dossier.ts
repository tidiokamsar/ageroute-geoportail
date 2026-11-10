/**
 * LECTURES DU DOSSIER TECHNIQUE (lot X1 ; contrat CONTRAT-EXPORTS.md, sections 2.3 et 4.2) : projet, jeux non retires, territoire et ancetres, region,
 * derniere analyse de conflits, dossiers par statut, documents (vues du lot D1) et historique de leurs lignees. Toutes dans UNE transaction READ ONLY
 * avec ses delais cote base (`poserDelais`) : une table verrouillee ou une lecture lente coupe l'export (504), elle ne le suspend pas.
 *
 * Memes regles que les routes de lecture : jeux hors RETIRE (le compte qui exporte decide), documents non retires (VALIDE seulement pour un compte qui ne
 * decide pas, comme `listerDocuments`), jeu lie a un document rendu seulement s'il est lisible (`vueDocument` du lot D1).
 */

import { prisma } from "../../lib/prisma";
import { estDelaiDepasse, poserDelais } from "../bd";
import { delaiAnalyseMs, delaiVerrouMs } from "../config";
import { filtreConflits } from "../conflits/dossiers.service";
import { STATUTS_CONFLIT, estDecideur } from "../conflits/types.noyau";
import { vueDocument } from "../documents/vues";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur } from "../projets.service";
import { ancetresDe } from "../territoires/territoires.service";
import { INCLURE_JEU, INCLURE_PROJET, vueJeu, vueProjet } from "../vues";
import type { JeuVu } from "./fiche.noyau";
import type { LigneHistoriqueDoc, VueDocumentJournal } from "./journal-documents.noyau";

export const DOCUMENTS_EXPORT_MAX = 5_000;
export const HISTORIQUE_EXPORT_MAX = 20_000;

type Bbox = [number, number, number, number];
function bboxDesJeux(jeux: { resume: unknown }[]): Bbox | null {
  let b: Bbox | null = null;
  for (const j of jeux) {
    const r = (j.resume as { bbox?: unknown } | null)?.bbox;
    if (!Array.isArray(r) || r.length !== 4 || !r.every((x) => typeof x === "number")) continue;
    const [w, s, e, n] = r as Bbox;
    b = b ? [Math.min(b[0], w), Math.min(b[1], s), Math.max(b[2], e), Math.max(b[3], n)] : [w, s, e, n];
  }
  return b;
}

export async function lireDossier(acteur: Acteur, projetId: string, trop: () => ErreurMetier, delaiMaxMs = Number.POSITIVE_INFINITY) {
  const decideur = estDecideur(acteur.role);
  // Revue du lot X1, M4 : au plus ce qui reste du budget de fabrication.
  const delai = Math.max(1_000, Math.min(delaiAnalyseMs(), delaiMaxMs));
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await poserDelais(tx, delai, delaiVerrouMs());
      const p = await tx.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, include: INCLURE_PROJET });
      if (!p) throw introuvable("Projet", "PROJET_INTROUVABLE");
      const lignesJeux = await tx.jeuDonneesProjet.findMany({ where: { projetId, statut: { not: "RETIRE" } }, include: INCLURE_JEU, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const chemin = p.territoire ? (await tx.territoireVoirie.findUnique({ where: { id: p.territoire.id }, select: { chemin: true } }))?.chemin ?? null : null;
      const ancetres = chemin ? await ancetresDe(tx, chemin) : [];
      const region = p.regionId === null ? null : await tx.region.findUnique({ where: { id: p.regionId }, select: { id: true, nom: true } });
      const acteurLu = await tx.user.findUnique({ where: { id: acteur.id }, select: { nomComplet: true } });
      const derniere = await tx.analyseConflitProjet.findFirst({
        where: { projetId, statut: "TERMINEE" }, orderBy: { numero: "desc" },
        select: { id: true, numero: true, createdAt: true, versionAlgorithme: true, largeurEmpriseM: true, largeurChausseeM: true, resume: true },
      });
      const groupes = await tx.conflitProjet.groupBy({ by: ["statut"], where: filtreConflits(projetId, {}, acteur.role), _count: { _all: true } });
      const conflitsParStatut: Record<string, number> = Object.fromEntries(STATUTS_CONFLIT.map((s) => [s, 0]));
      for (const g of groupes) conflitsParStatut[g.statut] = g._count._all;

      // Documents : memes lectures et meme vue que `listerDocuments` (lot D1), dans la transaction.
      const lignesDocs = await tx.documentProjetVoirie.findMany({
        where: { projetId, deletedAt: null, ...(decideur ? {} : { statut: "VALIDE" as const }) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: DOCUMENTS_EXPORT_MAX + 1,
      });
      const docs = lignesDocs.slice(0, DOCUMENTS_EXPORT_MAX);
      const codes = [...new Set(docs.map((l) => l.typeCode))];
      const concs = [...new Set(docs.map((l) => l.concessionnaireId).filter((x): x is string => !!x))];
      const jeuxDocs = [...new Set(docs.map((l) => l.jeuId).filter((x): x is string => !!x))];
      const lignees = [...new Set(docs.map((l) => l.ligneeId))];
      const histo = lignees.length ? await tx.documentProjetVoirieHistorique.findMany({ where: { projetId, ligneeId: { in: lignees } }, orderBy: { id: "asc" }, take: HISTORIQUE_EXPORT_MAX + 1 }) : [];
      const idsPersonnes = [...new Set([...docs.flatMap((l) => [l.creeParId, l.deposeParId, l.valideParId, l.derniereActionParId]), ...histo.map((h) => h.acteurId)].filter((x): x is string => !!x))];
      const types = codes.length ? await tx.referentielVoirie.findMany({ where: { domaine: "TYPE_DOCUMENT", code: { in: codes } }, select: { code: true, libelle: true, actif: true, deletedAt: true } }) : [];
      const cs = concs.length ? await tx.concessionnaireReseau.findMany({ where: { id: { in: concs } }, select: { id: true, nom: true } }) : [];
      const js = jeuxDocs.length ? await tx.jeuDonneesProjet.findMany({ where: { id: { in: jeuxDocs } }, select: { id: true, statut: true, role: true, version: true, format: true } }) : [];
      const us = idsPersonnes.length ? await tx.user.findMany({ where: { id: { in: idsPersonnes } }, select: { id: true, nomComplet: true } }) : [];
      const personnes = new Map(us.map((u) => [u.id, u]));
      const documents = docs.map((l) => vueDocument(l, {
        role: acteur.role, type: types.find((t) => t.code === l.typeCode) ?? null, concessionnaire: cs.find((c) => c.id === l.concessionnaireId) ?? null,
        jeu: js.find((j) => j.id === l.jeuId) ?? null, personnes,
      }));
      const historique: LigneHistoriqueDoc[] = histo.slice(0, HISTORIQUE_EXPORT_MAX).map((h) => ({
        id: Number(h.id), documentId: h.documentId, version: h.version, action: h.action, statutAvant: h.statutAvant, statutApres: h.statutApres,
        par: personnes.get(h.acteurId) ?? { id: h.acteurId, nomComplet: null }, justification: h.justification, details: h.details, le: h.createdAt,
      }));

      const vue = vueProjet(p);
      return {
        projet: {
          ...vue, territoire: vue.territoire ? { ...vue.territoire, ancetres } : null, region,
          parametres: { largeurEmpriseM: Number(p.largeurEmpriseM), largeurChausseeM: Number(p.largeurChausseeM), statut: p.statutParametres },
          bbox: bboxDesJeux(lignesJeux.filter((j) => j.statut === "AUTORISE")),
        },
        jeux: lignesJeux.map((j) => vueJeu(j)) as unknown as JeuVu[],
        acteurNom: acteurLu?.nomComplet ?? null,
        derniere: derniere
          ? { id: derniere.id, numero: derniere.numero, createdAt: derniere.createdAt, versionAlgorithme: derniere.versionAlgorithme, largeurEmpriseM: Number(derniere.largeurEmpriseM), largeurChausseeM: Number(derniere.largeurChausseeM), resume: derniere.resume }
          : null,
        conflitsParStatut,
        documents: documents as unknown as (VueDocumentJournal & Record<string, unknown>)[],
        historique,
        tronques: { documents: lignesDocs.length > DOCUMENTS_EXPORT_MAX, historique: histo.length > HISTORIQUE_EXPORT_MAX },
      };
    }, { timeout: delai + 10_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDelaiDepasse(e)) throw trop();
    throw e;
  }
}
