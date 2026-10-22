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
 * LES INTERVENTIONS FIGEES N'EXISTENT PAS ENCORE : `programmation/cycle-vie.noyau.ts` est une regle sans
 * table. Le volet le dit (`interventionsFigees.disponible: false`) et n'invente aucune fiche d'intervention.
 */

import type { PrismaClient } from "@prisma/client";

export type DepotFiche = Pick<PrismaClient, "troncon" | "portion" | "programmeBudgetaire" | "chantier">;

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
  interventionsFigees: { disponible: false; motif: string };
}

export async function voletProgrammation(depot: DepotFiche, tronconId: string): Promise<VoletProgrammation | null> {
  const troncon = await depot.troncon.findFirst({ where: { id: tronconId, deletedAt: null }, select: { id: true, code: true, regionId: true } });
  if (!troncon) return null;

  const [lignes, chantiers] = await Promise.all([
    depot.programmeBudgetaire.findMany({ where: { tronconId, deletedAt: null }, orderBy: [{ annee: "asc" }, { priorite: "asc" }, { createdAt: "asc" }] }),
    depot.chantier.findMany({ where: { tronconId, deletedAt: null }, orderBy: [{ createdAt: "desc" }], take: 100 }),
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
    interventionsFigees: {
      disponible: false,
      motif: "Aucune table de fiches d'intervention : le cycle de vie (brouillon à évalué) n'existe que comme règle (programmation/cycle-vie.noyau.ts). Aucune intervention figée ni transmise n'est connue de cette base.",
    },
  };
}
