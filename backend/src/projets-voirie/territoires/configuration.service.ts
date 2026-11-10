/**
 * CONFIGURATION NATIONALE : lecture en base (avec cache court), ecriture ADMIN versionnee, historisee et auditee, invalidation du cache.
 * Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md, section 6. Regles pures : configuration.noyau.ts ; cache : configuration.cache.ts.
 */

import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { ErreurMetier } from "../erreurs";
import type { Acteur } from "../projets.service";
import { configurationEnCache, configurationParDefaut, estPerime, invalider, poser, type ConfigurationLue } from "./configuration.cache";
import {
  CLES, DEFAUTS, PROTECTIONS_BORNES, entierEnv, epsgHorsListe, estCle, listeCrsEnv, lireValeurBase, resoudre, validerValeur,
  type Cle, type Protection, type Source, type ValeurDe,
} from "./configuration.noyau";

interface LigneConfig { cle: string; valeur: unknown; version: number; approuveParId: string | null; approuveLe: Date | null; justification: string | null; updatedAt: Date; approuvePar?: { id: string; nomComplet: string } | null }

/** Relit la base et pose le cache. Une ligne absente ou illisible vaut le defaut (jamais une erreur). */
export async function chargerConfiguration(): Promise<ConfigurationLue> {
  const lignes = await prisma.configurationVoirie.findMany({ select: { cle: true, valeur: true } });
  const lue = configurationParDefaut();
  for (const l of lignes) {
    if (!estCle(l.cle)) continue;
    (lue as Record<string, unknown>)[l.cle] = lireValeurBase(l.cle, l.valeur).valeur;
  }
  poser(lue);
  return lue;
}

/** Configuration courante : le cache s'il est frais, sinon la base. */
export async function configurationCourante(): Promise<ConfigurationLue> {
  const c = configurationEnCache();
  if (c && !estPerime()) return c;
  return chargerConfiguration();
}

// ------------------------------------------------------------------------------------------------
// Valeurs effectives (environnement > base > defaut)
// ------------------------------------------------------------------------------------------------

export interface VueConfiguration {
  cle: Cle;
  valeur: unknown;
  source: Source | Record<string, Source>;
  valeurBase: unknown;
  valeurDefaut: unknown;
  variableEnvironnement: string | string[] | null;
  version: number;
  approuvePar: { id: string; nomComplet: string } | null;
  approuveLe: Date | null;
  justification: string | null;
  updatedAt: Date | null;
}

/** Liste blanche effective des CRS d'import (environnement > base > defaut). */
export function listeBlancheEffective(c: ConfigurationLue): { valeur: number[]; source: Source } {
  const r = resoudre(listeCrsEnv(process.env.PROJETS_VOIRIE_CRS_SOURCE_AUTORISES), c.CRS_IMPORT_LISTE_BLANCHE.epsg, [...DEFAUTS.CRS_IMPORT_LISTE_BLANCHE.epsg]);
  return { valeur: [...r.valeur], source: r.source };
}

/** Protections effectives, sous-cle par sous-cle. */
export function protectionsEffectives(c: ConfigurationLue): { valeur: Record<Protection, number>; sources: Record<Protection, Source> } {
  const valeur = {} as Record<Protection, number>;
  const sources = {} as Record<Protection, Source>;
  for (const [k, b] of Object.entries(PROTECTIONS_BORNES) as [Protection, (typeof PROTECTIONS_BORNES)[Protection]][]) {
    const r = resoudre(entierEnv(process.env[b.env], b.min, b.max), c.PROTECTIONS[k], b.defaut);
    valeur[k] = r.valeur;
    sources[k] = r.source;
  }
  return { valeur, sources };
}

function vue(cle: Cle, c: ConfigurationLue, ligne: LigneConfig | undefined): VueConfiguration {
  const commun = {
    cle, valeurDefaut: DEFAUTS[cle], version: ligne?.version ?? 0,
    approuvePar: ligne?.approuvePar ? { id: ligne.approuvePar.id, nomComplet: ligne.approuvePar.nomComplet } : null,
    approuveLe: ligne?.approuveLe ?? null, justification: ligne?.justification ?? null, updatedAt: ligne?.updatedAt ?? null,
  };
  const enBase = ligne ? lireValeurBase(cle, ligne.valeur) : null;
  const valeurBase = enBase?.valide ? enBase.valeur : null;
  if (cle === "CRS_IMPORT_LISTE_BLANCHE") {
    const e = listeBlancheEffective(c);
    return { ...commun, valeur: { epsg: e.valeur }, source: e.source, valeurBase, variableEnvironnement: "PROJETS_VOIRIE_CRS_SOURCE_AUTORISES" };
  }
  if (cle === "PROTECTIONS") {
    const p = protectionsEffectives(c);
    return { ...commun, valeur: p.valeur, source: p.sources, valeurBase, variableEnvironnement: Object.values(PROTECTIONS_BORNES).map((b) => b.env) };
  }
  // Emprise et bandes : aucune variable d'environnement ; la source est BASE si une ligne valide existe, DEFAUT sinon.
  return { ...commun, valeur: c[cle], source: valeurBase !== null ? "BASE" : "DEFAUT", valeurBase, variableEnvironnement: null };
}

const INCLURE = { approuvePar: { select: { id: true, nomComplet: true } } } as const;

export async function lireConfiguration(): Promise<{ configuration: VueConfiguration[] }> {
  const lignes = await prisma.configurationVoirie.findMany({ include: INCLURE });
  const c = await chargerConfiguration();
  return { configuration: CLES.map((cle) => vue(cle, c, lignes.find((l) => l.cle === cle))) };
}

export async function lireCle(cle: string): Promise<{ configuration: VueConfiguration }> {
  if (!estCle(cle)) throw new ErreurMetier(404, "CLE_INCONNUE", `Clé de configuration inconnue : ${CLES.join(", ")} attendues.`);
  const ligne = await prisma.configurationVoirie.findUnique({ where: { cle }, include: INCLURE });
  const c = await chargerConfiguration();
  return { configuration: vue(cle, c, ligne ?? undefined) };
}

// ------------------------------------------------------------------------------------------------
// Ecriture (ADMIN, la route le garantit)
// ------------------------------------------------------------------------------------------------

/** Les CRS d'une liste blanche ou d'une regle de bandes doivent etre connus de PostGIS (`spatial_ref_sys`). */
async function exigerCrsConnus(epsg: readonly number[]): Promise<void> {
  if (epsg.length === 0) return;
  const lignes = await prisma.$queryRaw<{ srid: number }[]>`SELECT "srid" FROM "spatial_ref_sys" WHERE "srid" = ANY(${[...epsg]}::int[])`;
  const connus = new Set(lignes.map((l) => Number(l.srid)));
  const absents = epsg.filter((e) => !connus.has(e));
  if (absents.length) throw new ErreurMetier(422, "CRS_NON_DISPONIBLE", `CRS inconnu(s) de la base PostGIS : ${absents.map((e) => `EPSG:${e}`).join(", ")}.`, { epsg: absents });
}

/** Longueur minimale d'une justification (meme valeur que JUSTIFICATION_MIN des conflits et des regles). */
export const JUSTIFICATION_MIN_CONFIGURATION = 10;

export async function ecrireConfiguration(acteur: Acteur, cle: string, brut: unknown, justification: string | undefined): Promise<{ configuration: VueConfiguration }> {
  if (!estCle(cle)) throw new ErreurMetier(404, "CLE_INCONNUE", `Clé de configuration inconnue : ${CLES.join(", ")} attendues.`);
  // Decision de l'architecte (10/11/2026) : une ecriture de configuration est justifiee, comme les autres decisions du module (10 caracteres au moins).
  if ((justification ?? "").trim().length < JUSTIFICATION_MIN_CONFIGURATION) {
    throw new ErreurMetier(422, "JUSTIFICATION_REQUISE", `Une justification de ${JUSTIFICATION_MIN_CONFIGURATION} caractères au moins est requise pour modifier la configuration.`);
  }
  const v = validerValeur(cle, brut);
  if (!v.ok) throw new ErreurMetier(400, "VALEUR_INVALIDE", "La valeur ne respecte pas le schéma de cette clé.", { details: v.erreurs });
  const courante = await configurationCourante();
  if (cle === "CRS_METRIQUE_BANDES") {
    const liste = listeBlancheEffective(courante).valeur;
    const hors = epsgHorsListe(v.valeur as ValeurDe<"CRS_METRIQUE_BANDES">, liste);
    if (hors.length) throw new ErreurMetier(400, "CRS_NON_AUTORISE", `Les CRS métriques des bandes doivent être projetés et dans la liste blanche des CRS (${liste.join(", ")}) : ${hors.map((e) => `EPSG:${e}`).join(", ")} refusé(s).`, { epsg: hors });
    await exigerCrsConnus([...(v.valeur as ValeurDe<"CRS_METRIQUE_BANDES">).bandes.map((b) => b.epsg), (v.valeur as ValeurDe<"CRS_METRIQUE_BANDES">).epsgDefaut]);
  }
  if (cle === "CRS_IMPORT_LISTE_BLANCHE") {
    await exigerCrsConnus((v.valeur as ValeurDe<"CRS_IMPORT_LISTE_BLANCHE">).epsg);
    // Les bandes en vigueur doivent rester dans la nouvelle liste : sinon l'analyse tomberait sur un CRS non autorise.
    const hors = epsgHorsListe(courante.CRS_METRIQUE_BANDES, (v.valeur as ValeurDe<"CRS_IMPORT_LISTE_BLANCHE">).epsg);
    if (hors.length) throw new ErreurMetier(409, "CRS_NON_AUTORISE", `La règle des bandes de CRS métrique utilise ${hors.map((e) => `EPSG:${e}`).join(", ")} : modifiez-la avant de retirer ce code de la liste blanche.`, { epsg: hors });
  }
  if (cle === "CRS_IMPORT_LISTE_BLANCHE") {
    // Correctifs T1+S1 (m9) : un CRS impose par un territoire non retire reste dans la liste (sinon le contexte spatial l'ignorerait sans le dire).
    const nouvelle = (v.valeur as ValeurDe<"CRS_IMPORT_LISTE_BLANCHE">).epsg;
    const imposes = await prisma.territoireVoirie.findMany({ where: { deletedAt: null, crsMetriqueEpsg: { not: null } }, select: { code: true, crsMetriqueEpsg: true } });
    const orphelins = imposes.filter((t) => !nouvelle.includes(Number(t.crsMetriqueEpsg)));
    if (orphelins.length) {
      const codes = [...new Set(orphelins.map((t) => Number(t.crsMetriqueEpsg)))];
      throw new ErreurMetier(409, "CRS_NON_AUTORISE", `${orphelins.length} territoire(s) imposent ${codes.map((e) => `EPSG:${e}`).join(", ")} : changez leur CRS avant de retirer ce code de la liste blanche.`, { epsg: codes, territoires: orphelins.slice(0, 20).map((t) => t.code) });
    }
  }
  const texte = justification?.trim() || null;
  const resultat = await prisma.$transaction(async (tx) => {
    const avant = await tx.configurationVoirie.findUnique({ where: { cle } });
    const version = (avant?.version ?? 0) + 1;
    const maintenant = new Date();
    const apres = await tx.configurationVoirie.upsert({
      where: { cle },
      create: { cle, valeur: v.valeur as object, version, approuveParId: acteur.id, approuveLe: maintenant, justification: texte },
      update: { valeur: v.valeur as object, version, approuveParId: acteur.id, approuveLe: maintenant, justification: texte, updatedAt: maintenant },
      include: INCLURE,
    });
    await tx.configurationVoirieHistorique.create({ data: { cle, version, avant: (avant?.valeur ?? undefined) as object | undefined, apres: v.valeur as object, acteurId: acteur.id, justification: texte } });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "UPDATE", entityType: "ConfigurationVoirie", entityId: cle,
      before: avant ? { valeur: avant.valeur, version: avant.version } : undefined, after: { valeur: v.valeur, version, justification: texte }, ipAddress: acteur.ip,
    });
    return apres;
  });
  invalider();
  const c = await chargerConfiguration();
  return { configuration: vue(cle, c, resultat) };
}
