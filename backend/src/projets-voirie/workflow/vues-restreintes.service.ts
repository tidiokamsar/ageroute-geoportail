/**
 * VUES RESTREINTES du workflow : jeux de reseau (metadonnees) et dossiers de conflit (vue concessionnaire), SANS GEOMETRIE, SANS MESURE.
 *
 * C'est la SEULE fenetre qu'un referent concessionnaire a sur les jeux et les conflits : le socle et les dossiers de conflit lui sont fermes
 * (403 COMPTE_REFERENT_RESTREINT), parce qu'ils rendent la carte et les analyses de tous les projets du perimetre. Un referent ne voit ici que ce qui
 * porte le concessionnaire de ses rattachements (contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, section 6) ; jamais la geometrie, jamais le tracé
 * d'un autre concessionnaire. Aucune consultation de geometrie : rien a tracer.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { decoderCurseurConflit, encoderCurseurConflit } from "../conflits/curseurs.noyau";
import { contexteDe, exigerProjetActif, jour, nomsDe, personneDe, type ActeurWorkflow } from "./communs";
import { clauseCurseur } from "./filtres";
import { filtreConflitsVue, jeuLieVisible, sorteDe } from "./visibilite.noyau";

export const decoderCurseurVue = decoderCurseurConflit;

/** Jeux du projet, metadonnees seulement. Referent : AUTORISE et de son concessionnaire. Decideur : tous sauf RETIRE. Autre lecteur : AUTORISE. */
export async function listerJeuxVue(acteur: ActeurWorkflow, projetId: string) {
  await exigerProjetActif(projetId);
  const ctx = contexteDe(acteur, projetId);
  const sorte = sorteDe(ctx);
  const where: Prisma.JeuDonneesProjetWhereInput = { projetId, statut: sorte === "DECIDEUR" ? { not: "RETIRE" } : "AUTORISE" };
  if (sorte === "REFERENT") { where.concessionnaireId = { in: [...ctx.concessionnaires] }; where.role = "RESEAU_TIERS"; }
  const jeux = await prisma.jeuDonneesProjet.findMany({
    where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 500,
    select: { id: true, role: true, concessionnaireId: true, version: true, nomFichier: true, format: true, dateDonnees: true, nbObjets: true, classePrecision: true, statut: true },
  });
  const conc = await prisma.concessionnaireReseau.findMany({ where: { id: { in: [...new Set(jeux.map((j) => j.concessionnaireId).filter((i): i is string => i !== null))] } }, select: { id: true, nom: true } });
  const noms = new Map(conc.map((c) => [c.id, c.nom]));
  return {
    jeux: jeux.filter((j) => jeuLieVisible(ctx, j.statut)).map((j) => ({
      id: j.id, role: j.role, concessionnaire: j.concessionnaireId ? { id: j.concessionnaireId, nom: noms.get(j.concessionnaireId) ?? "" } : null, version: j.version, nomFichier: j.nomFichier,
      format: j.format, dateDonnees: jour(j.dateDonnees), nbObjets: j.nbObjets, libelleNbObjets: "circuits ou objets du fichier", classePrecision: j.classePrecision, statut: j.statut,
    })),
  };
}

export interface FiltresConflitsVue { statuts?: string[]; types?: string[] }

/**
 * Vue concessionnaire des dossiers de conflit. Referent : ses dossiers CONFIRMES par une personne (une proposition du systeme est un signal interne),
 * dont le jeu est AUTORISE ; la decision approuvee (option, dates prevues) sans cout ni justification. Decideur : tous les dossiers, sans les donnees
 * d'un jeu RETIRE. Autre lecteur : rien (les dossiers se lisent par les routes des conflits, avec leurs propres regles).
 */
export async function listerConflitsVue(acteur: ActeurWorkflow, projetId: string, f: FiltresConflitsVue, limite: number, curseur?: { t: Date; i: string }) {
  await exigerProjetActif(projetId);
  const ctx = contexteDe(acteur, projetId);
  const filtre = filtreConflitsVue(ctx);
  const interne = sorteDe(ctx) === "DECIDEUR";
  const and: Prisma.ConflitProjetWhereInput[] = [{ projetId }];
  if (filtre.concessionnaires !== null) and.push({ concessionnaireId: { in: [...filtre.concessionnaires] } });
  if (filtre.statuts !== null) and.push({ statut: { in: [...filtre.statuts] as never[] } });
  if (f.statuts?.length) and.push({ statut: { in: f.statuts as never[] } });
  if (f.types?.length) and.push({ type: { in: f.types as never[] } });
  if (filtre.jeuxAutorisesSeulement) and.push({ jeuReseau: { is: { statut: "AUTORISE" } } }, { OR: [{ jeuAxesId: null }, { jeuAxes: { is: { statut: "AUTORISE" } } }] });
  const lignes = await prisma.conflitProjet.findMany({
    where: { AND: [...and, ...(clauseCurseur(curseur) as Prisma.ConflitProjetWhereInput[])] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limite + 1,
    select: {
      id: true, type: true, axe: true, statut: true, risque: true, echeance: true, aReexaminer: true, responsableId: true, concessionnaireId: true, createdAt: true, updatedAt: true,
      jeuReseau: { select: { statut: true } }, objet: { select: { nom: true } }, concessionnaire: { select: { id: true, nom: true } },
    },
  });
  const page = lignes.slice(0, limite);
  const [decisions, noms] = await Promise.all([
    page.length ? prisma.decisionConflit.findMany({ where: { conflitId: { in: page.map((c) => c.id) }, statut: "APPROUVEE" }, select: { conflitId: true, option: true, dateDebutPrevue: true, dateFinPrevue: true, approuveLe: true }, orderBy: { approuveLe: "desc" } }) : [],
    nomsDe(page.map((c) => c.responsableId)),
  ]);
  const retenue = new Map<string, (typeof decisions)[number]>();
  for (const d of decisions) if (!retenue.has(d.conflitId)) retenue.set(d.conflitId, d);
  const dernier = page[page.length - 1];
  return {
    conflits: page.map((c) => {
      // Les donnees tirees d'un jeu RETIRE ne sortent pour personne (regle du socle).
      const lisible = c.jeuReseau === null || c.jeuReseau.statut !== "RETIRE";
      const d = retenue.get(c.id);
      return {
        id: c.id, type: c.type, axe: c.axe, statut: c.statut,
        concessionnaire: lisible && c.concessionnaire ? { id: c.concessionnaire.id, nom: c.concessionnaire.nom } : null, objet: lisible && c.objet ? { nom: c.objet.nom } : null,
        decisionRetenue: d ? { option: d.option, dateDebutPrevue: jour(d.dateDebutPrevue), dateFinPrevue: jour(d.dateFinPrevue) } : null,
        ...(interne ? { risque: c.risque, echeance: jour(c.echeance), aReexaminer: c.aReexaminer, responsable: personneDe(noms, c.responsableId) } : {}),
        createdAt: c.createdAt, updatedAt: c.updatedAt,
      };
    }),
    curseurSuivant: lignes.length > limite && dernier ? encoderCurseurConflit({ t: dernier.createdAt.toISOString(), i: dernier.id }) : null,
  };
}
