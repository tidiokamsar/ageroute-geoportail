import { prisma } from "./prisma";
import type { ModuleKey } from "./modules";

export interface CompteAuthentifie {
  id: string;
  role: string;
}

/**
 * Modules auxquels un compte a droit.
 *
 * Renvoie `null` lorsqu'il n'y a AUCUNE restriction — c'est le cas d'un ADMIN, et
 * celui d'un compte dont `modulesAutorises` est vide (comportement historique
 * conserve pour ne pas casser les comptes existants). Renvoie sinon l'ensemble des
 * cles autorisees.
 *
 * Cette fonction est la source unique de la regle : `requireModuleAccess` s'appuie
 * dessus, comme les routes qui doivent filtrer plusieurs types d'entites a la fois
 * (recherche globale, journal d'audit). Deux implementations separees finiraient par
 * diverger, et c'est exactement ainsi que /api/search s'est retrouve sans controle.
 */
export async function modulesAutorisesDe(user: CompteAuthentifie): Promise<Set<ModuleKey> | null> {
  if (user.role === "ADMIN") return null;
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { modulesAutorises: true },
  });
  // Compte introuvable (supprime entre l'emission du jeton et l'appel) : on n'accorde
  // rien plutot que tout.
  if (!row) return new Set<ModuleKey>();
  if (row.modulesAutorises.length === 0) return null;
  return new Set(row.modulesAutorises as ModuleKey[]);
}

export function moduleAutorise(modules: Set<ModuleKey> | null, cle: ModuleKey): boolean {
  return modules === null || modules.has(cle);
}

/**
 * Module dont releve chaque type d'entite journalise, pour aligner la lecture du
 * journal d'audit sur les droits deja accordes sur l'entite elle-meme.
 *
 * `null` signifie « reserve au role ADMIN » : ni les comptes utilisateurs ni les
 * parametres applicatifs ne relevent d'un module configurable (cf. lib/modules.ts).
 * Un type absent de cette table est refuse — on echoue fermé.
 */
export const MODULE_PAR_ENTITE: Record<string, ModuleKey | null> = {
  Troncon: "troncons",
  Ouvrage: "ouvrages",
  PointNoir: "points-noirs",
  Poste: "postes",
  Chantier: "chantiers",
  Inspection: "inspections",
  OrdreTravaux: "ordres-travaux",
  OtPhoto: "ordres-travaux",
  Marche: "marches",
  Decompte: "marches",
  Bailleur: "marches",
  Document: "documents",
  SignalementCitoyen: "signalements",
  User: null,
  AppSetting: null,
};
