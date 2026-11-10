/**
 * TERRITOIRES HIERARCHIQUES : liste filtree par perimetre, fiche, creation, modification, retrait logique (ADMIN), comptes par territoire.
 * Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md, sections 3.1, 4 et 7. Regles pures : hierarchie.noyau.ts ; la base applique les memes
 * regles par declencheur (chemin, profondeur, region effective, immuabilite, coherence des niveaux).
 *
 * L'emprise (`Unsupported`) s'ecrit et se lit en SQL brut parametre. AUCUN NOM DE LIEU ICI.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { avecErreurDelai, poserDelais } from "../bd";
import { comptesParMinuteMax, delaiAnalyseMs, delaiVerrouMs } from "../config";
import { ErreurMetier, introuvable } from "../erreurs";
import { CadenceParCompte, limiteurAnalyses } from "../limiteurs";
import type { Acteur, Portee, Tx } from "../projets.service";
import { configurationCourante, listeBlancheEffective } from "./configuration.service";
import { CODE_TERRITOIRE, NIVEAUX, bboxContient, lireEmprise, parentAdmissible, type EmpriseGeoJson, type NiveauTerritoire } from "./hierarchie.noyau";
import { instantaneTerritoire, vueTerritoire, vueTerritoireListe, type EmpriseLue } from "./vues";

const INCLURE = { creePar: { select: { id: true, nomComplet: true } } } as const;
type Lecteur = Pick<Tx, "$queryRaw" | "territoireVoirie">;

export interface Avertissement { code: "EMPRISE_HORS_PARENT" | "EMPRISE_HORS_EMPRISE_NATIONALE"; message: string }

// ------------------------------------------------------------------------------------------------
// Emprises (SQL brut)
// ------------------------------------------------------------------------------------------------

interface LigneEmprise { id: string; geojson: string | null; ouest: number | null; sud: number | null; est: number | null; nord: number | null; md5: string | null }

/** Emprises d'un lot de territoires : GeoJSON, boite englobante, empreinte. */
export async function lireEmprises(lecteur: Pick<Tx, "$queryRaw">, ids: readonly string[]): Promise<Map<string, EmpriseLue>> {
  const sortie = new Map<string, EmpriseLue>();
  if (ids.length === 0) return sortie;
  const lignes = await lecteur.$queryRaw<LigneEmprise[]>`
    SELECT "id", ST_AsGeoJSON("emprise", 7) AS "geojson", ST_XMin("emprise") AS "ouest", ST_YMin("emprise") AS "sud", ST_XMax("emprise") AS "est", ST_YMax("emprise") AS "nord",
           md5(ST_AsEWKB("emprise")::text) AS "md5"
      FROM "territoires_voirie" WHERE "id" = ANY(${[...ids]}::text[])`;
  for (const l of lignes) {
    sortie.set(l.id, l.geojson === null
      ? { geojson: null, bbox: null, md5: null }
      : { geojson: JSON.parse(l.geojson) as unknown, bbox: [Number(l.ouest), Number(l.sud), Number(l.est), Number(l.nord)], md5: l.md5 });
  }
  return sortie;
}

/** Boites englobantes seules d'un lot de territoires (liste : jamais l'emprise complete, correctifs T1+S1, m2). */
async function lireBoites(lecteur: Pick<Tx, "$queryRaw">, ids: readonly string[]): Promise<Map<string, { bbox: [number, number, number, number] | null }>> {
  const sortie = new Map<string, { bbox: [number, number, number, number] | null }>();
  if (ids.length === 0) return sortie;
  const lignes = await lecteur.$queryRaw<{ id: string; ouest: number | null; sud: number | null; est: number | null; nord: number | null }[]>`
    SELECT "id", ST_XMin("emprise") AS "ouest", ST_YMin("emprise") AS "sud", ST_XMax("emprise") AS "est", ST_YMax("emprise") AS "nord"
      FROM "territoires_voirie" WHERE "id" = ANY(${[...ids]}::text[])`;
  for (const l of lignes) sortie.set(l.id, { bbox: l.ouest === null ? null : [Number(l.ouest), Number(l.sud), Number(l.est), Number(l.nord)] });
  return sortie;
}

/** Ecrit (ou efface) l'emprise ; une geometrie refusee par PostGIS (anneau qui se croise...) devient 422 EMPRISE_INVALIDE. */
async function ecrireEmprise(tx: Tx, id: string, emprise: EmpriseGeoJson | null): Promise<void> {
  try {
    if (emprise === null) await tx.$executeRaw`UPDATE "territoires_voirie" SET "emprise" = NULL WHERE "id" = ${id}`;
    else await tx.$executeRaw`UPDATE "territoires_voirie" SET "emprise" = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(emprise)}), 4326) WHERE "id" = ${id}`;
  } catch (e) {
    const texte = e instanceof Error ? e.message : String(e);
    if (/tv_emprise|23514|GeomFromGeoJSON|invalid|parse error/i.test(texte)) {
      throw new ErreurMetier(422, "EMPRISE_INVALIDE", "Emprise invalide pour PostGIS : polygone ou multipolygone WGS 84 valide attendu (anneaux fermes, sans auto-intersection).");
    }
    throw e;
  }
}

/** Avertissements de contenance (jamais un refus : les emprises sont approximatives). */
async function avertissementsEmprise(tx: Tx, id: string, bbox: [number, number, number, number] | null): Promise<Avertissement[]> {
  if (!bbox) return [];
  const sortie: Avertissement[] = [];
  const c = await configurationCourante();
  if (!bboxContient(c.EMPRISE_PLAUSIBILITE.bbox, bbox)) {
    sortie.push({ code: "EMPRISE_HORS_EMPRISE_NATIONALE", message: `L'emprise sort de l'emprise nationale de plausibilite « ${c.EMPRISE_PLAUSIBILITE.nom} » : verifiez les coordonnees (longitude puis latitude, WGS 84).` });
  }
  // Plus proche ancetre qui porte une emprise : l'enfant doit y etre couvert (ST_Covers), sinon avertissement.
  const r = await tx.$queryRaw<{ couvert: boolean; code: string }[]>`
    SELECT ST_Covers(a."emprise", t."emprise") AS "couvert", a."code"
      FROM "territoires_voirie" t
      JOIN "territoires_voirie" a ON t."chemin" LIKE a."chemin" || '%' AND a."id" <> t."id" AND a."emprise" IS NOT NULL
     WHERE t."id" = ${id}
     ORDER BY a."profondeur" DESC LIMIT 1`;
  if (r.length && !r[0].couvert) sortie.push({ code: "EMPRISE_HORS_PARENT", message: `L'emprise n'est pas entierement couverte par celle du territoire parent « ${r[0].code} » (emprises approximatives : a verifier, pas bloquant).` });
  return sortie;
}

// ------------------------------------------------------------------------------------------------
// Lecture
// ------------------------------------------------------------------------------------------------

/** Filtre de perimetre : un compte regional ne voit que les territoires dont la region effective est l'une des siennes. */
const filtrePortee = (portee: Portee): Prisma.TerritoireVoirieWhereInput => (portee === null ? {} : { regionEffectiveId: { in: [...portee] } });

/** Region effective du territoire pour `requireTerritoireMasque` : `[]` s'il n'existe pas (ou est retire), `[null]` sans region. */
export async function regionsDuTerritoire(id: string): Promise<(number | null)[]> {
  const t = await prisma.territoireVoirie.findFirst({ where: { id, deletedAt: null }, select: { regionEffectiveId: true } });
  return t ? [t.regionEffectiveId] : [];
}

export interface FiltresTerritoires { niveau?: NiveauTerritoire; parentId?: string; q?: string; actifs?: boolean; limite: number; curseur?: string }

export async function listerTerritoires(portee: Portee, f: FiltresTerritoires) {
  const and: Prisma.TerritoireVoirieWhereInput[] = [{ deletedAt: null }, filtrePortee(portee)];
  if (f.niveau) and.push({ niveau: f.niveau });
  if (f.parentId !== undefined) and.push({ parentId: f.parentId });
  if (f.actifs !== undefined) and.push({ actif: f.actifs });
  if (f.q) and.push({ OR: [{ nom: { contains: f.q, mode: "insensitive" } }, { code: { contains: f.q, mode: "insensitive" } }] });
  if (f.curseur) and.push({ chemin: { gt: f.curseur } });
  const lignes = await prisma.territoireVoirie.findMany({ where: { AND: and }, include: INCLURE, orderBy: { chemin: "asc" }, take: f.limite + 1 });
  const page = lignes.slice(0, f.limite);
  // m2 : la liste ne rend que la boite englobante ; l'emprise complete est sur la fiche (GET /territoires/:tid).
  const boites = await lireBoites(prisma, page.map((t) => t.id));
  return {
    territoires: page.map((t) => vueTerritoireListe(t, boites.get(t.id) ?? null)),
    curseurSuivant: lignes.length > f.limite ? page[page.length - 1].chemin : null,
  };
}

async function territoireOuErreur(lecteur: Lecteur, id: string) {
  const t = await lecteur.territoireVoirie.findFirst({ where: { id, deletedAt: null }, include: INCLURE });
  if (!t) throw introuvable("Territoire", "TERRITOIRE_INTROUVABLE");
  return t;
}

/** Ancetres d'un territoire (nation en premier), par son chemin. */
export async function ancetresDe(lecteur: Pick<Tx, "$queryRaw">, chemin: string): Promise<{ id: string; code: string; nom: string; niveau: string }[]> {
  return lecteur.$queryRaw<{ id: string; code: string; nom: string; niveau: string }[]>`
    SELECT "id", "code", "nom", "niveau"::text AS "niveau" FROM "territoires_voirie"
     WHERE ${chemin} LIKE "chemin" || '%' AND "chemin" <> ${chemin} ORDER BY "profondeur"`;
}

export async function ficheTerritoire(id: string) {
  const t = await territoireOuErreur(prisma, id);
  const [emprises, ancetres, nbEnfants] = await Promise.all([lireEmprises(prisma, [id]), ancetresDe(prisma, t.chemin), prisma.territoireVoirie.count({ where: { parentId: id, deletedAt: null } })]);
  return { territoire: { ...vueTerritoire(t, emprises.get(id) ?? null), ancetres, nbEnfants } };
}

/**
 * Territoire utilisable pour rattacher un projet (existe, non retire, actif), avec ses ancetres : sert au service des projets pour deriver
 * la region, la commune et la prefecture. 400 TERRITOIRE_INTROUVABLE sinon (la creation d'un projet n'a rien a masquer : le compte choisit).
 */
export async function territoirePourProjet(lecteur: Lecteur, id: string) {
  // Correctifs T1+S1 (m11) : verrou partage de la ligne du territoire jusqu'a la fin de la transaction : un retrait concurrent (qui la modifie)
  // attend, puis compte le projet cree (409 TERRITOIRE_UTILISE) ; un projet ne nait pas sur un territoire retire dans la meme seconde.
  await lecteur.$queryRaw`SELECT 1 AS "ok" FROM "territoires_voirie" WHERE "id" = ${id} FOR SHARE`;
  const t = await lecteur.territoireVoirie.findFirst({ where: { id, deletedAt: null, actif: true }, select: { id: true, code: true, nom: true, niveau: true, chemin: true, regionEffectiveId: true } });
  if (!t) throw new ErreurMetier(400, "TERRITOIRE_INTROUVABLE", "Territoire inconnu, retiré ou inactif.");
  const chaine = [...(await ancetresDe(lecteur, t.chemin)), { id: t.id, code: t.code, nom: t.nom, niveau: t.niveau }];
  const nomDe = (niveau: string) => chaine.find((x) => x.niveau === niveau)?.nom ?? null;
  return { territoire: t, commune: nomDe("COMMUNE"), prefecture: nomDe("PREFECTURE"), ancetres: chaine.slice(0, -1) };
}

// ------------------------------------------------------------------------------------------------
// Ecriture (ADMIN : la route le garantit)
// ------------------------------------------------------------------------------------------------

export interface CreationTerritoire {
  code: string; nom: string; niveau: NiveauTerritoire; parentId?: string | null; regionId?: number | null; crsMetriqueEpsg?: number | null;
  emprise?: unknown; source?: string | null;
}

async function verifierRegion(tx: Tx, regionId: number | null | undefined): Promise<void> {
  if (regionId === null || regionId === undefined) return;
  const r = await tx.region.findUnique({ where: { id: regionId }, select: { id: true } });
  if (!r) throw new ErreurMetier(400, "REGION_INCONNUE", "Région inconnue.");
}

async function verifierCrs(crs: number | null | undefined): Promise<void> {
  if (crs === null || crs === undefined) return;
  const liste = listeBlancheEffective(await configurationCourante()).valeur;
  if (crs === 4326 || !liste.includes(crs)) {
    throw new ErreurMetier(400, "CRS_NON_AUTORISE", `Le CRS métrique d'un territoire doit être projeté et dans la liste blanche des CRS (${liste.filter((e) => e !== 4326).join(", ")}).`, { epsg: crs });
  }
}

function lireEmpriseOuErreur(brut: unknown) {
  const e = lireEmprise(brut);
  if (!e.ok) throw new ErreurMetier(422, e.code, e.message);
  return e;
}

/**
 * Correctifs T1+S1 (m4) : une region propre doit etre celle du parent quand le parent en a une (une prefecture d'une region R ne porte pas la
 * region R2). 400 TERRITOIRE_REGION_INCOHERENTE sinon.
 */
function verifierRegionDuParent(regionId: number | null | undefined, regionParent: number | null | undefined): void {
  if (regionId === null || regionId === undefined || regionParent === null || regionParent === undefined) return;
  if (regionId !== regionParent) {
    throw new ErreurMetier(400, "TERRITOIRE_REGION_INCOHERENTE", "La région d'un territoire doit être celle de son parent quand le parent en porte une : créez le territoire sous la bonne région.", { regionParent });
  }
}

export async function creerTerritoire(acteur: Acteur, d: CreationTerritoire) {
  const code = d.code.trim().toUpperCase();
  if (!CODE_TERRITOIRE.test(code)) throw new ErreurMetier(400, "CHAMPS_INVALIDES", "Code : lettres majuscules, chiffres, tirets et soulignés, 2 à 64 caractères.");
  if (!(NIVEAUX as readonly string[]).includes(d.niveau)) throw new ErreurMetier(400, "CHAMPS_INVALIDES", `Niveau inconnu : ${NIVEAUX.join(", ")} attendus.`);
  const emprise = d.emprise === undefined || d.emprise === null ? null : lireEmpriseOuErreur(d.emprise);
  await verifierCrs(d.crsMetriqueEpsg);
  try {
    return await prisma.$transaction(async (tx) => {
      let parent: { id: string; niveau: string; deletedAt: Date | null; actif: boolean; regionEffectiveId: number | null } | null = null;
      if (d.parentId) {
        parent = await tx.territoireVoirie.findFirst({ where: { id: d.parentId, deletedAt: null }, select: { id: true, niveau: true, deletedAt: true, actif: true, regionEffectiveId: true } });
        if (!parent) throw new ErreurMetier(400, "TERRITOIRE_PARENT_INTROUVABLE", "Territoire parent inconnu ou retiré.");
      }
      const admissible = parentAdmissible(d.niveau, parent ? (parent.niveau as NiveauTerritoire) : null);
      if (!admissible.ok) throw new ErreurMetier(400, admissible.code, admissible.message);
      if (d.niveau === "NATION" && (await tx.territoireVoirie.count({ where: { niveau: "NATION", deletedAt: null } })) > 0) {
        throw new ErreurMetier(409, "NATION_DEJA_DEFINIE", "Une nation existe déjà : un seul territoire de niveau NATION à la fois.");
      }
      await verifierRegion(tx, d.regionId);
      verifierRegionDuParent(d.regionId, parent?.regionEffectiveId);
      // Chemin et profondeur sont calcules par la base (declencheur) : des valeurs provisoires sont ecrites puis remplacees.
      const cree = await tx.territoireVoirie.create({
        data: {
          code, nom: d.nom.trim(), niveau: d.niveau, parentId: parent?.id ?? null, regionId: d.regionId ?? null, crsMetriqueEpsg: d.crsMetriqueEpsg ?? null,
          source: d.source?.trim() || null, creeParId: acteur.id, chemin: "", profondeur: 0,
        },
      });
      if (emprise) await ecrireEmprise(tx, cree.id, emprise.geojson);
      const t = await tx.territoireVoirie.findUniqueOrThrow({ where: { id: cree.id }, include: INCLURE });
      const emprises = await lireEmprises(tx, [t.id]);
      const inst = instantaneTerritoire(t, emprises.get(t.id) ?? null);
      await tx.territoireVoirieHistorique.create({ data: { territoireId: t.id, action: "CREATION", version: 1, apres: inst as object, acteurId: acteur.id } });
      await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "TerritoireVoirie", entityId: t.id, after: inst, ipAddress: acteur.ip });
      const avertissements = await avertissementsEmprise(tx, t.id, emprise ? emprise.bbox : null);
      return { territoire: vueTerritoire(t, emprises.get(t.id) ?? null), avertissements };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ErreurMetier(409, "CODE_DEJA_UTILISE", `Le code « ${code} » est déjà utilisé (y compris par un territoire retiré).`);
    throw e;
  }
}

export interface ModifTerritoire { nom?: string; regionId?: number | null; crsMetriqueEpsg?: number | null; emprise?: unknown; actif?: boolean; source?: string | null }

export async function modifierTerritoire(acteur: Acteur, id: string, m: ModifTerritoire) {
  const emprise = m.emprise === undefined ? undefined : m.emprise === null ? null : lireEmpriseOuErreur(m.emprise);
  if (m.crsMetriqueEpsg !== undefined) await verifierCrs(m.crsMetriqueEpsg);
  return prisma.$transaction(async (tx) => {
    const avant = await territoireOuErreur(tx, id);
    const empAvant = (await lireEmprises(tx, [id])).get(id) ?? null;
    if (m.regionId !== undefined) await verifierRegion(tx, m.regionId);
    const version = avant.version + 1;
    await tx.territoireVoirie.update({
      where: { id },
      data: {
        ...(m.nom !== undefined ? { nom: m.nom.trim() } : {}), ...(m.regionId !== undefined ? { regionId: m.regionId } : {}),
        ...(m.crsMetriqueEpsg !== undefined ? { crsMetriqueEpsg: m.crsMetriqueEpsg } : {}), ...(m.actif !== undefined ? { actif: m.actif } : {}),
        ...(m.source !== undefined ? { source: m.source?.trim() || null } : {}), version,
      },
    });
    if (emprise !== undefined) await ecrireEmprise(tx, id, emprise === null ? null : emprise.geojson);
    const apres = await tx.territoireVoirie.findUniqueOrThrow({ where: { id }, include: INCLURE });
    if (m.regionId !== undefined && m.regionId !== avant.regionId) await verifierChangementRegion(tx, apres);
    const empApres = (await lireEmprises(tx, [id])).get(id) ?? null;
    const instAvant = instantaneTerritoire(avant, empAvant);
    const instApres = instantaneTerritoire(apres, empApres);
    await tx.territoireVoirieHistorique.create({ data: { territoireId: id, action: "MODIFICATION", version, avant: instAvant as object, apres: instApres as object, acteurId: acteur.id } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "UPDATE", entityType: "TerritoireVoirie", entityId: id, before: instAvant, after: instApres, ipAddress: acteur.ip });
    const avertissements = emprise !== undefined ? await avertissementsEmprise(tx, id, empApres?.bbox ?? null) : [];
    return { territoire: vueTerritoire(apres, empApres), avertissements };
  });
}

/**
 * Correctifs T1+S1 (m4) : apres un changement de region (propage par la base aux descendants sans region propre), refus (la transaction est annulee) :
 *   - 400 TERRITOIRE_REGION_INCOHERENTE si la nouvelle region propre n'est pas celle du parent ;
 *   - 409 TERRITOIRE_REGION_PROJETS si un projet non retire du sous-arbre porte une autre region que la region effective de son territoire (la region
 *     d'un projet decide du perimetre des comptes : elle ne change pas par un geste sur le territoire ; deplacez ou recreez d'abord les projets) ;
 *   - 409 TERRITOIRE_REGION_DESCENDANTS si un descendant porte une region propre differente de la nouvelle.
 */
async function verifierChangementRegion(tx: Tx, t: { id: string; chemin: string; parentId: string | null; regionId: number | null; regionEffectiveId: number | null }): Promise<void> {
  if (t.parentId) {
    const parent = await tx.territoireVoirie.findUnique({ where: { id: t.parentId }, select: { regionEffectiveId: true } });
    verifierRegionDuParent(t.regionId, parent?.regionEffectiveId);
  }
  const r = await tx.$queryRaw<{ projets: number; descendants: number }[]>`
    SELECT (SELECT count(*)::int FROM "projets_voirie" p JOIN "territoires_voirie" s ON s."id" = p."territoireId"
             WHERE p."deletedAt" IS NULL AND s."chemin" LIKE ${t.chemin} || '%' AND p."regionId" IS DISTINCT FROM s."regionEffectiveId") AS "projets",
           (SELECT count(*)::int FROM "territoires_voirie" s
             WHERE s."deletedAt" IS NULL AND s."chemin" LIKE ${t.chemin} || '%' AND s."id" <> ${t.id} AND s."regionId" IS NOT NULL AND s."regionId" IS DISTINCT FROM ${t.regionEffectiveId}::int) AS "descendants"`;
  if (r[0].projets > 0) {
    throw new ErreurMetier(409, "TERRITOIRE_REGION_PROJETS", `${r[0].projets} projet(s) non retiré(s) de ce territoire ou de ses descendants porteraient une autre région que leur territoire : la région d'un projet ne change pas par un geste sur le territoire (déplacez ou recréez d'abord ces projets).`, { projets: r[0].projets });
  }
  if (r[0].descendants > 0) {
    throw new ErreurMetier(409, "TERRITOIRE_REGION_DESCENDANTS", `${r[0].descendants} territoire(s) descendant(s) portent une autre région propre : corrigez-les d'abord.`, { descendants: r[0].descendants });
  }
}

export async function retirerTerritoire(acteur: Acteur, id: string) {
  return prisma.$transaction(async (tx) => {
    // m11 : verrou exclusif AVANT de compter : une creation de projet en cours (verrou partage) se termine d'abord, et son projet est compte.
    await tx.$queryRaw`SELECT 1 AS "ok" FROM "territoires_voirie" WHERE "id" = ${id} FOR UPDATE`;
    const avant = await territoireOuErreur(tx, id);
    const [enfants, projets] = await Promise.all([tx.territoireVoirie.count({ where: { parentId: id, deletedAt: null } }), tx.projetVoirie.count({ where: { territoireId: id, deletedAt: null } })]);
    if (enfants > 0 || projets > 0) {
      throw new ErreurMetier(409, "TERRITOIRE_UTILISE", `Le territoire porte encore ${enfants} territoire(s) enfant(s) et ${projets} projet(s) non retirés : retirez-les ou rattachez-les d'abord, ou désactivez le territoire.`, { enfants, projets });
    }
    const empAvant = (await lireEmprises(tx, [id])).get(id) ?? null;
    const version = avant.version + 1;
    const apres = await tx.territoireVoirie.update({ where: { id }, data: { deletedAt: new Date(), actif: false, version }, include: INCLURE });
    const instAvant = instantaneTerritoire(avant, empAvant);
    const instApres = instantaneTerritoire(apres, empAvant);
    await tx.territoireVoirieHistorique.create({ data: { territoireId: id, action: "RETRAIT", version, avant: instAvant as object, apres: instApres as object, acteurId: acteur.id } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "DELETE", entityType: "TerritoireVoirie", entityId: id, before: instAvant, after: instApres, ipAddress: acteur.ip });
    return { id, retire: true };
  });
}

// ------------------------------------------------------------------------------------------------
// Comptes par territoire (agregats, filtres par perimetre ; base du tableau de bord du lot X1)
// ------------------------------------------------------------------------------------------------

export const TERRITOIRES_COMPTES_MAX = 2_000;

interface LigneCompte { id: string; code: string; nom: string; niveau: string; parentId: string | null; profondeur: number; projets: bigint | number; jeux: Record<string, number> | null; conflits: Record<string, number> | null }

/** Correctifs T1+S1 (m1) : cadence des comptes par compte (fenetre d'une minute). */
export const cadenceComptes = new CadenceParCompte(comptesParMinuteMax);

/** 429 COMPTES_TROP_FREQUENTS (avec `retryAfterS`, repris en Retry-After par la route) au-dela de la cadence du compte. */
export function exigerCadenceComptes(compteId: string): void {
  const attente = cadenceComptes.admettre(compteId);
  if (attente !== null) {
    throw new ErreurMetier(429, "COMPTES_TROP_FREQUENTS", `Trop de demandes de comptes par territoire (${comptesParMinuteMax()} par minute au plus) : réessayez dans ${attente} s.`, { retryAfterS: attente });
  }
}

/**
 * Pour chaque territoire visible (du sous-arbre de `territoireId` s'il est donne) : projets, jeux par statut et conflits par statut du
 * territoire ET de ses descendants. Perimetre : projets des regions du compte seulement ; un compte qui ne decide pas ne compte que les jeux
 * AUTORISE et les dossiers dont CHAQUE jeu lie (reseau, plan d'axes, jeu B d'une divergence) est AUTORISE (memes regles que les listes). Un jeu
 * RETIRE n'est jamais compte, ni un dossier qui depend d'un jeu RETIRE.
 *
 * COUT (correctifs T1+S1, m1) : agregat par PROJET d'abord, puis cumul par ancetre en UNE passe (chaque projet est ventile sur les identifiants de
 * son chemin), au lieu de sous-requetes correlees territoire par territoire. Transaction READ ONLY, delai cote base (504 COMPTES_TROP_LONGS),
 * 3 calculs simultanes au plus (limiteur des analyses, 503 SERVICE_OCCUPE), cadence par compte (route : 429 COMPTES_TROP_FREQUENTS).
 */
export async function comptesParTerritoire(portee: Portee, tousLesJeux: boolean, territoireId?: string) {
  let prefixe = "/";
  if (territoireId) {
    const t = await prisma.territoireVoirie.findFirst({ where: { id: territoireId, deletedAt: null, ...filtrePortee(portee) }, select: { chemin: true } });
    if (!t) throw introuvable("Territoire", "TERRITOIRE_INTROUVABLE");
    prefixe = t.chemin;
  }
  const national = portee === null;
  const regions = portee === null ? [] : [...portee];
  const delai = delaiAnalyseMs();
  const trop = `Le calcul des comptes par territoire a dépassé ${Math.round(delai / 1000)} s et a été interrompu : restreignez-le à un territoire (territoireId).`;
  const lignes = await limiteurAnalyses.executer(() => avecErreurDelai("COMPTES_TROP_LONGS", trop, () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await poserDelais(tx, delai, delaiVerrouMs());
    return tx.$queryRaw<LigneCompte[]>`
    WITH visibles AS (
      SELECT t."id", t."code", t."nom", t."niveau"::text AS "niveau", t."parentId", t."profondeur", t."chemin"
        FROM "territoires_voirie" t
       WHERE t."deletedAt" IS NULL AND t."chemin" LIKE ${prefixe} || '%'
         AND (${national} OR t."regionEffectiveId" = ANY(${regions}::int[]))
       ORDER BY t."chemin" LIMIT ${TERRITOIRES_COMPTES_MAX + 1}
    ), projets AS MATERIALIZED (
      SELECT p."id", t."chemin"
        FROM "projets_voirie" p JOIN "territoires_voirie" t ON t."id" = p."territoireId"
       WHERE p."deletedAt" IS NULL AND t."chemin" LIKE ${prefixe} || '%' AND (${national} OR p."regionId" = ANY(${regions}::int[]))
    ), ancetres AS MATERIALIZED (
      -- Chaque projet ventile sur les identifiants de son chemin (son territoire et tous ses ancetres) : une seule passe.
      SELECT p."id" AS "pid", a."anc" FROM projets p CROSS JOIN LATERAL unnest(string_to_array(btrim(p."chemin", '/'), '/')) AS a("anc")
    ), jeux_p AS (
      SELECT j."projetId" AS "pid", j."statut"::text AS "s", count(*)::int AS "n"
        FROM "projets_voirie_jeux" j JOIN projets p ON p."id" = j."projetId"
       WHERE j."statut" <> 'RETIRE' AND (${tousLesJeux} OR j."statut" = 'AUTORISE')
       GROUP BY 1, 2
    ), conflits_p AS (
      SELECT c."projetId" AS "pid", c."statut"::text AS "s", count(*)::int AS "n"
        FROM "conflits_projet" c JOIN projets p ON p."id" = c."projetId"
        LEFT JOIN "projets_voirie_jeux" jr ON jr."id" = c."jeuReseauId"
        LEFT JOIN "projets_voirie_jeux" ja ON ja."id" = c."jeuAxesId"
        LEFT JOIN "projets_voirie_jeux" jb ON jb."id" = c."jeuSourceBId"
       WHERE (jr."id" IS NULL OR jr."statut" <> 'RETIRE') AND (ja."id" IS NULL OR ja."statut" <> 'RETIRE') AND (jb."id" IS NULL OR jb."statut" <> 'RETIRE')
         AND (${tousLesJeux} OR ((jr."id" IS NULL OR jr."statut" = 'AUTORISE') AND (ja."id" IS NULL OR ja."statut" = 'AUTORISE') AND (jb."id" IS NULL OR jb."statut" = 'AUTORISE')))
       GROUP BY 1, 2
    ), nb_projets AS (
      SELECT "anc", count(*) AS "n" FROM ancetres GROUP BY 1
    ), nb_jeux AS (
      SELECT q."anc", jsonb_object_agg(q."s", q."n") AS "agg" FROM (
        SELECT a."anc", jp."s", sum(jp."n")::int AS "n" FROM ancetres a JOIN jeux_p jp ON jp."pid" = a."pid" GROUP BY 1, 2) q GROUP BY 1
    ), nb_conflits AS (
      SELECT q."anc", jsonb_object_agg(q."s", q."n") AS "agg" FROM (
        SELECT a."anc", cp."s", sum(cp."n")::int AS "n" FROM ancetres a JOIN conflits_p cp ON cp."pid" = a."pid" GROUP BY 1, 2) q GROUP BY 1
    )
    SELECT v."id", v."code", v."nom", v."niveau", v."parentId", v."profondeur", COALESCE(np."n", 0) AS "projets", nj."agg" AS "jeux", nc."agg" AS "conflits"
      FROM visibles v
      LEFT JOIN nb_projets np ON np."anc" = v."id"
      LEFT JOIN nb_jeux nj ON nj."anc" = v."id"
      LEFT JOIN nb_conflits nc ON nc."anc" = v."id"
     ORDER BY v."chemin"`;
  }, { timeout: delai + 15_000, maxWait: 10_000 })));
  const tronque = lignes.length > TERRITOIRES_COMPTES_MAX;
  return {
    comptes: lignes.slice(0, TERRITOIRES_COMPTES_MAX).map((l) => ({
      territoireId: l.id, code: l.code, nom: l.nom, niveau: l.niveau, parentId: l.parentId, profondeur: l.profondeur,
      projets: Number(l.projets), jeux: l.jeux ?? {}, conflits: l.conflits ?? {},
    })),
    tronque,
  };
}
