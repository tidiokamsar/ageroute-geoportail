/**
 * Fiche 360 : les volets PORTION et PROGRAMMATION d'un tronçon (MAINTENANCE_PROGRAMMING_DESIGN.md, Fiche 360).
 *
 * Ils S'AJOUTENT a la fiche existante (`/troncons/:id/fiche`) : ni remplacement ni seconde verite. La
 * fiche v1 donne l'etat COURANT des portions, leur couverture et leurs trous ; ce service donne ce
 * qu'elle ne dit pas : l'histoire des versions, et ce qui est programme sur le tronçon.
 *
 * L'ETAT A UNE DATE N'EST PAS RECALCULE ICI : le curseur temporel (`reseau/curseur.service.ts`, route
 * `/api/v2/portions/a-la-date`) en est la seule definition de « vrai a cette date ». Le volet l'appelle
 * tel quel, pour ne pas avoir deux definitions qui divergeraient au premier changement de regle.
 *
 * LES INTERVENTIONS FIGEES sont lues dans `fiches_intervention_courantes` (migration 20261023100000) : les fiches
 * que le moteur de programmation a FIGEES pour ce troncon, avec leur statut courant et l'historique complet de
 * leur cycle de vie (table en ajout seul). Le volet ne calcule rien et n'invente aucune fiche. Si la table
 * n'existe pas (migration non appliquee), il le dit (`disponible: false`) au lieu de rendre une liste vide muette.
 * Une fiche figee est une decision de programmation PROVISOIRE tant que ses parametres ne sont pas approuves : le
 * volet reprend l'etiquette que la fiche porte elle-meme.
 */

import type { PrismaClient } from "@prisma/client";

export type DepotFiche = Pick<PrismaClient, "troncon" | "portion" | "programmeBudgetaire" | "chantier" | "$queryRaw">;

/** Au-dela, la liste des fiches figees d'un troncon est tronquee et le dit. */
export const PLAFOND_FICHES_FIGEES = 100;

export interface StatutFiche {
  rang: number; de: string | null; vers: string; origine: string; motif: string | null; enregistreLe: string;
}

export interface InterventionFigee {
  id: string;
  reference: string;
  scenarioId: string;
  annee: number;
  parametresVersion: string;
  /** SHA-256 du texte canonique de la fiche : sa « version figee ». */
  empreinteSha256: string;
  figeLe: string;
  statut: string;
  rangStatut: number;
  statutDepuis: string;
  traitement: string | null;
  montantGnf: string | null;
  provisoire: boolean | null;
  etiquette: string | null;
  /** Cycle de vie complet, en ajout seul, du plus ancien au plus recent. */
  historique: StatutFiche[];
}

export type InterventionsFigees =
  | { disponible: true; total: number; tronque: boolean; plafond: number; fiches: InterventionFigee[] }
  | { disponible: false; motif: string };

interface LigneFigee {
  id: string; reference: string; scenarioId: string; annee: number; parametresVersion: string; empreinteSha256: string; figeLe: Date;
  statut: string; rangStatut: number; statutDepuis: Date; traitement: string | null; montantGnf: string | null; provisoire: boolean | null; etiquette: string | null;
}
interface LigneStatutFiche {
  ficheId: string; rang: number; de: string | null; vers: string; origine: string; motif: string | null; enregistreLe: Date;
}

/** La table des fiches n'existe pas encore dans cette base (migration non appliquee) : code PostgreSQL 42P01. */
function tableAbsente(e: unknown): boolean {
  const meta = (e as { meta?: { code?: string; message?: string } } | null)?.meta;
  const msg = String((e as Error | null)?.message ?? "") + String(meta?.message ?? "");
  return meta?.code === "42P01" || (/fiches_intervention/.test(msg) && /does not exist|n'existe pas|42P01/.test(msg));
}

export async function interventionsFigeesDuTroncon(depot: DepotFiche, tronconId: string): Promise<InterventionsFigees> {
  let lignes: LigneFigee[];
  let statuts: LigneStatutFiche[];
  try {
    lignes = await depot.$queryRaw<LigneFigee[]>`
      SELECT c."id", c."reference", c."scenarioId", c."annee", c."parametresVersion", c."empreinteSha256", c."figeLe",
             c."statut", c."rangStatut", c."statutDepuis",
             f."contenuCanonique"::jsonb -> 'traitement' -> 'traitement' ->> 'code' AS "traitement",
             f."contenuCanonique"::jsonb -> 'cout' ->> 'montantGnf' AS "montantGnf",
             (f."contenuCanonique"::jsonb ->> 'provisoire')::boolean AS "provisoire",
             f."contenuCanonique"::jsonb ->> 'etiquette' AS "etiquette"
        FROM "fiches_intervention_courantes" c
        JOIN "fiches_intervention" f ON f."id" = c."id"
       WHERE c."tronconId" = ${tronconId}
       ORDER BY c."figeLe" DESC, c."id" ASC
       LIMIT ${PLAFOND_FICHES_FIGEES + 1}`;
    const gardees = lignes.slice(0, PLAFOND_FICHES_FIGEES);
    statuts = gardees.length === 0 ? [] : await depot.$queryRaw<LigneStatutFiche[]>`
      SELECT "ficheId", "rang", "de", "vers", "origine", "motif", "enregistreLe"
        FROM "fiches_intervention_statuts" WHERE "ficheId" = ANY(${gardees.map((l) => l.id)}::text[])
       ORDER BY "ficheId" ASC, "rang" ASC`;
  } catch (e) {
    if (tableAbsente(e)) {
      return { disponible: false, motif: "La table des fiches d'intervention n'existe pas dans cette base (migration 20261023100000 non appliquée) : aucune intervention figée n'est connue." };
    }
    throw e;
  }
  const tronque = lignes.length > PLAFOND_FICHES_FIGEES;
  const fiches: InterventionFigee[] = lignes.slice(0, PLAFOND_FICHES_FIGEES).map((l) => ({
    id: l.id, reference: l.reference, scenarioId: l.scenarioId, annee: l.annee, parametresVersion: l.parametresVersion,
    empreinteSha256: l.empreinteSha256, figeLe: l.figeLe.toISOString(), statut: l.statut, rangStatut: l.rangStatut,
    statutDepuis: l.statutDepuis.toISOString(), traitement: l.traitement, montantGnf: l.montantGnf, provisoire: l.provisoire, etiquette: l.etiquette,
    historique: statuts.filter((s) => s.ficheId === l.id).map((s) => ({
      rang: s.rang, de: s.de, vers: s.vers, origine: s.origine, motif: s.motif, enregistreLe: s.enregistreLe.toISOString(),
    })),
  }));
  return { disponible: true, total: fiches.length, tronque, plafond: PLAFOND_FICHES_FIGEES, fiches };
}

/** Au-dela, l'historique est tronque et le dit. Choix de protection, non mesure sur un troncon reel. */
export const PLAFOND_VERSIONS = 500;

export interface VersionPortion {
  id: string;
  debutM: number;
  finM: number;
  etat: string | null;
  etatLibelle: string | null;
  revetement: string | null;
  statutValidation: string;
  origine: string;
  /** Depuis quand c'est vrai sur le terrain (jour). Nul : personne ne l'a dit, ce n'est pas « depuis toujours ». */
  valideDu: string | null;
  valideAu: string | null;
  /** Quand le systeme a enregistre cette version. */
  enregistreLe: string;
  observeeLe: string | null;
  /** Date a laquelle cette version a cesse d'etre courante (decoupe, fusion, requalification). Nulle si courante. */
  remplaceeLe: string | null;
  courante: boolean;
  /** Versions dont celle-ci est issue (lignage). */
  issueDe: string[];
}

export interface VoletPortions {
  tronconId: string;
  tronconCode: string;
  tronconNom: string;
  regionId: number | null;
  courantes: VersionPortion[];
  historique: VersionPortion[];
  tronque: boolean;
  plafond: number;
  comptes: { courantes: number; remplacees: number; sansDateEffet: number };
}

const jour = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

export async function voletPortions(depot: DepotFiche, tronconId: string): Promise<VoletPortions | null> {
  const troncon = await depot.troncon.findFirst({ where: { id: tronconId, deletedAt: null }, select: { id: true, code: true, nom: true, regionId: true } });
  if (!troncon) return null;

  // Les versions supprimees LOGIQUEMENT sont ecartees : « n'aurait jamais du etre saisi » n'est pas de l'histoire.
  // Les versions REMPLACEES restent : c'est tout l'objet de l'historique.
  const lignes = await depot.portion.findMany({
    where: { tronconId, deletedAt: null },
    orderBy: [{ debutM: "asc" }, { createdAt: "asc" }],
    take: PLAFOND_VERSIONS + 1,
    include: {
      etatRef: { select: { libelle: true } },
      parents: { select: { parentId: true } },
    },
  });
  const tronque = lignes.length > PLAFOND_VERSIONS;
  const historique: VersionPortion[] = lignes.slice(0, PLAFOND_VERSIONS).map((p) => ({
    id: p.id, debutM: p.debutM, finM: p.finM,
    etat: p.etat, etatLibelle: p.etatRef?.libelle ?? null, revetement: p.revetement,
    statutValidation: p.statutValidation, origine: p.origine,
    valideDu: jour(p.valideDu), valideAu: jour(p.valideAu),
    enregistreLe: p.createdAt.toISOString(), observeeLe: p.observeeLe ? p.observeeLe.toISOString() : null,
    remplaceeLe: p.remplaceeLe ? p.remplaceeLe.toISOString() : null,
    courante: p.remplaceeLe === null,
    issueDe: p.parents.map((l) => l.parentId),
  }));
  const courantes = historique.filter((v) => v.courante);
  return {
    tronconId: troncon.id, tronconCode: troncon.code, tronconNom: troncon.nom, regionId: troncon.regionId,
    courantes, historique, tronque, plafond: PLAFOND_VERSIONS,
    comptes: {
      courantes: courantes.length,
      remplacees: historique.length - courantes.length,
      sansDateEffet: historique.filter((v) => v.valideDu === null).length,
    },
  };
}

export interface VoletProgrammation {
  tronconId: string;
  tronconCode: string;
  regionId: number | null;
  previsions: {
    id: string; annee: number; intitule: string; statut: string; source: string;
    bailleur: string | null; typeIntervention: string | null; priorite: number | null; montantPrevuGnf: string;
  }[];
  /** Montants par statut, en chaine de chiffres (GNF) : jamais un nombre JSON. */
  totaux: { statut: string; nb: number; montantGnf: string }[];
  chantiers: {
    id: string; intitule: string; statut: string; avancementPct: number; entreprise: string;
    montantGnf: string | null; dateDebutPrevue: string | null; dateFinPrevue: string | null;
  }[];
  interventionsFigees: InterventionsFigees;
}

export async function voletProgrammation(depot: DepotFiche, tronconId: string): Promise<VoletProgrammation | null> {
  const troncon = await depot.troncon.findFirst({ where: { id: tronconId, deletedAt: null }, select: { id: true, code: true, regionId: true } });
  if (!troncon) return null;

  const [lignes, chantiers, interventionsFigees] = await Promise.all([
    depot.programmeBudgetaire.findMany({ where: { tronconId, deletedAt: null }, orderBy: [{ annee: "asc" }, { priorite: "asc" }, { createdAt: "asc" }] }),
    depot.chantier.findMany({ where: { tronconId, deletedAt: null }, orderBy: [{ createdAt: "desc" }], take: 100 }),
    interventionsFigeesDuTroncon(depot, tronconId),
  ]);

  const parStatut = new Map<string, { nb: number; montant: bigint }>();
  for (const l of lignes) {
    const e = parStatut.get(l.statut) ?? { nb: 0, montant: 0n };
    e.nb += 1; e.montant += l.montantPrevuGnf;
    parStatut.set(l.statut, e);
  }
  return {
    tronconId: troncon.id, tronconCode: troncon.code, regionId: troncon.regionId,
    previsions: lignes.map((l) => ({
      id: l.id, annee: l.annee, intitule: l.intitule, statut: l.statut, source: l.source,
      bailleur: l.bailleur, typeIntervention: l.typeIntervention, priorite: l.priorite, montantPrevuGnf: l.montantPrevuGnf.toString(),
    })),
    totaux: [...parStatut.entries()].map(([statut, e]) => ({ statut, nb: e.nb, montantGnf: e.montant.toString() })),
    chantiers: chantiers.map((c) => ({
      id: c.id, intitule: c.intitule, statut: c.statut, avancementPct: c.avancementPct, entreprise: c.entreprise,
      montantGnf: c.montantGnf === null ? null : c.montantGnf.toString(),
      dateDebutPrevue: jour(c.dateDebutPrevue), dateFinPrevue: jour(c.dateFinPrevue),
    })),
    interventionsFigees,
  };
}
