/**
 * Volet « constats » de la fiche 360 d'un tronçon, et classement « à contrôler » (SMART FIELD, phase 6).
 *
 * Lecture seule. Aucune règle de calcul n'est ici : elles vivent dans `historique.noyau.ts`, éprouvé sans base. Ce service lit
 * les défauts et les observations RATTACHÉS à un tronçon (un constat sans tronçon n'entre dans l'histoire d'aucune section :
 * le rattachement se fait sur proposition, par un responsable, voir `/v2/observations/:id/appariement`), les passe au noyau, et
 * dit ce qu'il n'a pas pu lire (plafond atteint).
 */

import type { PrismaClient } from "@prisma/client";
import {
  classerAControler, estRetenu, historiqueDeConstats, POIDS_PROVISOIRES,
  type Constat, type HistoriqueSection, type LigneAControler, type PoidsClassement,
} from "./historique.noyau";

export type DepotHistorique = Pick<PrismaClient, "troncon" | "defaut" | "observation">;

/** Au-dela, la liste detaillee des constats d'un troncon est tronquee et le dit. L'historique agrege, lui, lit tout. */
export const PLAFOND_CONSTATS_LISTE = 100;
/** Au-dela, un troncon n'est pas lu en entier : la reponse le dit plutot que de calculer sur un morceau. */
export const PLAFOND_CONSTATS_LUS = 5000;
/** Plafond de constats lus pour le classement, par nature. */
export const PLAFOND_CLASSEMENT = 20_000;

export interface ConstatListe {
  nature: Constat["nature"];
  id: string;
  type: string;
  libelle: string;
  gravite: Constat["gravite"];
  statut: string;
  etatDefaut: string | null;
  constateA: string;
  confirme: boolean;
  grave: boolean;
}

export interface VoletConstats {
  tronconId: string;
  tronconCode: string;
  tronconNom: string;
  regionId: number;
  historique: HistoriqueSection;
  liste: ConstatListe[];
  /** Vrai si plus de constats existent que la liste n'en porte (l'historique agrege, lui, les compte tous). */
  listeTronquee: boolean;
  plafondListe: number;
  /** Vrai si le troncon porte plus de constats que le plafond de lecture : l'historique est alors PARTIEL et le dit. */
  lectureIncomplete: boolean;
  avertissements: string[];
}

async function lireConstatsDuTroncon(depot: DepotHistorique, tronconId: string): Promise<{ constats: Constat[]; incomplet: boolean }> {
  const [defauts, observations] = await Promise.all([
    depot.defaut.findMany({
      where: { tronconId, deletedAt: null },
      select: { id: true, gravite: true, statutValidation: true, etat: true, constateA: true, catalogue: { select: { code: true, libelle: true } } },
      orderBy: { constateA: "desc" },
      take: PLAFOND_CONSTATS_LUS + 1,
    }),
    depot.observation.findMany({
      // Hors observations CONTENEURS : chaque defaut materialise sa propre observation (`field/observation-conteneur.ts`), au meme
      // troncon. La compter ferait compter DEUX FOIS chaque defaut. Une observation qui porte un defaut est lue par son defaut.
      where: { tronconId, deletedAt: null, defauts: { none: {} } },
      select: { id: true, type: true, gravite: true, statut: true, observeA: true },
      orderBy: { observeA: "desc" },
      take: PLAFOND_CONSTATS_LUS + 1,
    }),
  ]);
  const incomplet = defauts.length > PLAFOND_CONSTATS_LUS || observations.length > PLAFOND_CONSTATS_LUS;
  const constats: Constat[] = [
    ...defauts.slice(0, PLAFOND_CONSTATS_LUS).map((d): Constat => ({
      nature: "DEFAUT", id: d.id, type: d.catalogue.code, libelle: d.catalogue.libelle, gravite: d.gravite,
      statut: d.statutValidation, etatDefaut: d.etat, constateA: d.constateA,
    })),
    ...observations.slice(0, PLAFOND_CONSTATS_LUS).map((o): Constat => ({
      nature: "OBSERVATION", id: o.id, type: o.type, libelle: o.type, gravite: o.gravite, statut: o.statut, constateA: o.observeA,
    })),
  ];
  return { constats, incomplet };
}

export async function voletConstats(depot: DepotHistorique, tronconId: string): Promise<VoletConstats | null> {
  const troncon = await depot.troncon.findFirst({ where: { id: tronconId, deletedAt: null }, select: { id: true, code: true, nom: true, regionId: true } });
  if (!troncon) return null;
  const { constats, incomplet } = await lireConstatsDuTroncon(depot, tronconId);
  const historique = historiqueDeConstats(constats);
  const recents = constats.filter(estRetenu).sort((a, b) => b.constateA.getTime() - a.constateA.getTime());
  const confirme = (c: Constat) => ["VALIDE", "VALIDEE", "CONVERTIE"].includes(c.statut);
  const grave = (c: Constat) => (c.nature === "DEFAUT" ? typeof c.gravite === "number" && c.gravite >= 3 : c.gravite === "FORTE");
  const avertissements: string[] = [
    "Un constat sans tronçon rattaché n'apparaît dans l'histoire d'aucune section : les observations prises en roulant sont rattachées, sur proposition, par un responsable.",
    "Confirmés (validés par un tiers) et proposés (pas encore tranchés) sont comptés à part : un constat proposé n'est pas un fait officiel.",
  ];
  if (incomplet) avertissements.unshift(`Ce tronçon porte plus de ${PLAFOND_CONSTATS_LUS} constats d'une nature : l'historique est PARTIEL (les plus récents seulement).`);
  return {
    tronconId: troncon.id, tronconCode: troncon.code, tronconNom: troncon.nom, regionId: troncon.regionId,
    historique,
    liste: recents.slice(0, PLAFOND_CONSTATS_LISTE).map((c) => ({
      nature: c.nature, id: c.id, type: c.type, libelle: c.libelle, gravite: c.gravite, statut: c.statut, etatDefaut: c.etatDefaut ?? null,
      constateA: c.constateA.toISOString(), confirme: confirme(c), grave: grave(c),
    })),
    listeTronquee: recents.length > PLAFOND_CONSTATS_LISTE,
    plafondListe: PLAFOND_CONSTATS_LISTE,
    lectureIncomplete: incomplet,
    avertissements,
  };
}

export interface LigneAControlerDetail extends LigneAControler {
  tronconCode: string;
  tronconNom: string;
  regionId: number;
  regionNom: string;
}

export interface ResultatAControler {
  genereLe: string;
  perimetre: { regionIds: number[] | null };
  lignes: LigneAControlerDetail[];
  /** Total de tronçons classés avant le plafond d'affichage. */
  totalClasses: number;
  /** Tronçons du périmètre sans AUCUN constat : une absence de donnée, pas un risque mesuré. */
  sansConstatSurLeReseau: number;
  constatsLus: number;
  lectureIncomplete: boolean;
  poids: PoidsClassement;
  avertissements: string[];
}

export async function aControler(
  depot: DepotHistorique,
  options: { regionIds: number[] | null; limite: number; maintenant?: Date },
): Promise<ResultatAControler> {
  const maintenant = options.maintenant ?? new Date();
  const filtreRegion = options.regionIds ? { troncon: { regionId: { in: options.regionIds } } } : {};
  const [defauts, observations, nbTroncons] = await Promise.all([
    depot.defaut.findMany({
      where: { deletedAt: null, tronconId: { not: null }, ...filtreRegion },
      select: { id: true, tronconId: true, gravite: true, statutValidation: true, etat: true, constateA: true, catalogue: { select: { code: true, libelle: true } } },
      orderBy: { constateA: "desc" },
      take: PLAFOND_CLASSEMENT + 1,
    }),
    depot.observation.findMany({
      where: { deletedAt: null, tronconId: { not: null }, defauts: { none: {} }, ...filtreRegion },
      select: { id: true, tronconId: true, type: true, gravite: true, statut: true, observeA: true },
      orderBy: { observeA: "desc" },
      take: PLAFOND_CLASSEMENT + 1,
    }),
    depot.troncon.count({ where: { deletedAt: null, ...(options.regionIds ? { regionId: { in: options.regionIds } } : {}) } }),
  ]);
  const incomplet = defauts.length > PLAFOND_CLASSEMENT || observations.length > PLAFOND_CLASSEMENT;
  const parTroncon = new Map<string, Constat[]>();
  const ajouter = (id: string | null, c: Constat) => { if (id) (parTroncon.get(id) ?? parTroncon.set(id, []).get(id)!).push(c); };
  for (const d of defauts.slice(0, PLAFOND_CLASSEMENT)) {
    ajouter(d.tronconId, { nature: "DEFAUT", id: d.id, type: d.catalogue.code, libelle: d.catalogue.libelle, gravite: d.gravite, statut: d.statutValidation, etatDefaut: d.etat, constateA: d.constateA });
  }
  for (const o of observations.slice(0, PLAFOND_CLASSEMENT)) {
    ajouter(o.tronconId, { nature: "OBSERVATION", id: o.id, type: o.type, libelle: o.type, gravite: o.gravite, statut: o.statut, constateA: o.observeA });
  }
  const classement = classerAControler([...parTroncon.entries()].map(([tronconId, constats]) => ({ tronconId, constats })), maintenant);
  const retenues = classement.lignes.slice(0, options.limite);
  const infos = retenues.length === 0 ? [] : await depot.troncon.findMany({
    where: { id: { in: retenues.map((l) => l.tronconId) } },
    select: { id: true, code: true, nom: true, regionId: true, region: { select: { nom: true } } },
  });
  const parId = new Map(infos.map((t) => [t.id, t]));
  const lignes: LigneAControlerDetail[] = retenues.flatMap((l) => {
    const t = parId.get(l.tronconId);
    return t ? [{ ...l, tronconCode: t.code, tronconNom: t.nom, regionId: t.regionId, regionNom: t.region.nom }] : [];
  });
  const avecConstat = parTroncon.size;
  const avertissements = [
    "Classement d'AIDE AU CONTRÔLE : il dit où un humain doit regarder en premier, jamais quoi réparer. La programmation des interventions reste au moteur de programmation.",
    "Poids PROVISOIRES, non calibrés, non approuvés : ils sont rendus avec le résultat. Les changer est une décision datée.",
    "Seuls les constats RATTACHÉS à un tronçon sont lus. Les observations prises en roulant n'y entrent qu'une fois rattachées par un responsable.",
  ];
  if (incomplet) avertissements.unshift(`Plus de ${PLAFOND_CLASSEMENT} constats existent : le classement est calculé sur les plus récents seulement.`);
  return {
    genereLe: maintenant.toISOString(),
    perimetre: { regionIds: options.regionIds },
    lignes, totalClasses: classement.lignes.length,
    sansConstatSurLeReseau: Math.max(0, nbTroncons - avecConstat),
    constatsLus: Math.min(defauts.length, PLAFOND_CLASSEMENT) + Math.min(observations.length, PLAFOND_CLASSEMENT),
    lectureIncomplete: incomplet,
    poids: POIDS_PROVISOIRES,
    avertissements,
  };
}
