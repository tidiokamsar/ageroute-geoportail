/**
 * LECTURE DES LOTS D'IMPORT : liste, detail, apercu, sources. Aucune ecriture, nulle part.
 *
 * Les formes rendues sont celles de docs/imports/CONTRAT-API-LOTS-IMPORT.md. Ce fichier assemble
 * (requetes) ; le jugement -- etapes, actions, colonnes, troncatures -- est dans
 * `lots.vue.noyau.ts`, pur et teste sans base.
 */

import type { Prisma, PrismaClient, StatutLigneImport, StatutLotImport } from "@prisma/client";
import {
  calculerActions, calculerEtapes, classerColonnes, detailsSobres, encoderCurseur, formaterLignePourApercu, lireRapport,
  tronquerIdentifiant, tronquerMotif, type EntreeVue, type PositionCurseur, type StatutLot,
} from "./lots.vue.noyau";
import { COLONNES_INCONNUES_MAX } from "./reception.noyau";

/** Le minimum de Prisma dont la lecture a besoin : un test le remplace sans base. */
export type DepotLecture = Pick<PrismaClient, "lotImport" | "ligneImport" | "auditLog" | "$queryRaw">;

/** Entrees d'historique rendues au plus (un lot n'a aujourd'hui qu'un evenement). */
const HISTORIQUE_MAX = 50;

/* ======================================== Liste ======================================== */

export interface FiltresListe {
  statut?: StatutLot;
  source?: string;
  q?: string;
  du?: Date;
  /** Borne EXCLUSIVE sur `importeLe` : la route l'a calculee (`au` date seule = fin de journee comprise). */
  auExclusif?: Date;
  limite: number;
  curseur?: PositionCurseur;
}

/**
 * Prisma `contains` ne neutralise PAS les jokers de LIKE (verifie sur la base reelle : `q=%` rendait
 * tous les lots, `q=gamm_` trouvait « gamma »). On echappe `\`, `%` et `_` : le texte cherche est
 * un texte, jamais un motif.
 */
export function echapperLike(texte: string): string {
  return texte.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Filtres de la liste, SANS la pagination : c'est aussi ce qui definit `total`. */
export function construireFiltres(f: Omit<FiltresListe, "limite" | "curseur">): Prisma.LotImportWhereInput[] {
  const et: Prisma.LotImportWhereInput[] = [];
  if (f.statut) et.push({ statut: f.statut as StatutLotImport });
  // La source est du texte libre sensible a la casse (`onr_bdr` et `ONR_BDR` sont deux lots) : le
  // FILTRE, lui, l'ignore, pour qu'un utilisateur retrouve les deux sans connaitre l'orthographe.
  if (f.source) et.push({ systemeSource: { equals: f.source, mode: "insensitive" } });
  if (f.q) {
    et.push({
      OR: [
        { reference: { contains: echapperLike(f.q), mode: "insensitive" } },
        { nomFichier: { contains: echapperLike(f.q), mode: "insensitive" } },
        { systemeSource: { contains: echapperLike(f.q), mode: "insensitive" } },
      ],
    });
  }
  if (f.du) et.push({ importeLe: { gte: f.du } });
  if (f.auExclusif) et.push({ importeLe: { lt: f.auExclusif } });
  return et;
}

/** Position suivante dans l'ordre (importeLe decroissant, id croissant). */
function apres(p: PositionCurseur): Prisma.LotImportWhereInput {
  return { OR: [{ importeLe: { lt: p.importeLe } }, { importeLe: p.importeLe, id: { gt: p.id } }] };
}

const SELECT_LISTE = {
  id: true, reference: true, systemeSource: true, format: true, nomFichier: true, tailleOctets: true, statut: true,
  importeLe: true, versionMapping: true, autorisationRef: true,
  lignesLues: true, lignesValidees: true, lignesImportees: true, lignesRejetees: true, lignesEnConflit: true, lignesIgnorees: true,
  rapport: true,
  importePar: { select: { id: true, nomComplet: true } },
} satisfies Prisma.LotImportSelect;

export async function listerLots(depot: DepotLecture, f: FiltresListe) {
  const filtres = construireFiltres(f);
  const [total, lignes] = await Promise.all([
    depot.lotImport.count({ where: { AND: filtres } }),
    // Une de plus que demande : sa seule presence dit qu'une page suit, sans second comptage.
    depot.lotImport.findMany({
      where: { AND: f.curseur ? [...filtres, apres(f.curseur)] : filtres },
      orderBy: [{ importeLe: "desc" }, { id: "asc" }],
      take: f.limite + 1,
      select: SELECT_LISTE,
    }),
  ]);
  const page = lignes.slice(0, f.limite);
  const dernier = page[page.length - 1];
  const lots = page.map((l) => ({
    id: l.id, reference: l.reference, systemeSource: l.systemeSource, format: l.format, nomFichier: l.nomFichier,
    tailleOctets: l.tailleOctets.toString(), statut: l.statut, importeLe: l.importeLe,
    importePar: l.importePar ? { id: l.importePar.id, nomComplet: l.importePar.nomComplet } : null,
    versionMapping: l.versionMapping, autorisationRef: l.autorisationRef,
    lignesLues: l.lignesLues, lignesValidees: l.lignesValidees, lignesImportees: l.lignesImportees,
    lignesRejetees: l.lignesRejetees, lignesEnConflit: l.lignesEnConflit, lignesIgnorees: l.lignesIgnorees,
    motifRejetLot: lireRapport(l.rapport).motifRejetLot,
  }));
  return {
    lots,
    suivant: lignes.length > f.limite && dernier ? encoderCurseur({ importeLe: dernier.importeLe, id: dernier.id }) : null,
    total,
  };
}

/* ======================================= Sources ======================================= */

/** Valeurs distinctes DEJA RECUES, jamais un referentiel : la source reste un texte libre. */
export async function sourcesDeLots(depot: DepotLecture) {
  const groupes = await depot.lotImport.groupBy({ by: ["systemeSource"], _count: { _all: true }, orderBy: { systemeSource: "asc" } });
  return { sources: groupes.map((g) => ({ valeur: g.systemeSource, nombreLots: g._count._all })) };
}

/* ======================================== Detail ======================================== */

/** Cles distinctes de toutes les charges originales du lot, plafonnees. */
async function clesDuLot(depot: DepotLecture, lotId: string): Promise<string[]> {
  const rangees = await depot.$queryRaw<{ cle: string }[]>`
    SELECT DISTINCT k.cle
    FROM lignes_import li,
         LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(li."chargeOriginale") = 'object' THEN li."chargeOriginale" ELSE '{}'::jsonb END) AS k(cle)
    WHERE li."lotId" = ${lotId}
    LIMIT 5000`;
  return rangees.map((r) => r.cle);
}

/**
 * Journal du lot, lu DIRECTEMENT dans `audit_logs` : `LotImport` n'est pas dans `MODULE_PAR_ENTITE`
 * (lib/access.ts), donc la route d'audit generique le refuse. Seuls la date, l'action, le nom de
 * l'acteur et des details sobres sortent : ni l'avant/apres brut, ni l'adresse IP.
 */
async function historiqueDuLot(depot: DepotLecture, lotId: string) {
  const lignes = await depot.auditLog.findMany({
    where: { entityType: "LotImport", entityId: lotId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: HISTORIQUE_MAX,
    select: { createdAt: true, action: true, after: true, user: { select: { nomComplet: true } } },
  });
  return lignes.map((l) => ({
    date: l.createdAt, action: l.action as string, acteur: l.user?.nomComplet ?? null, details: detailsSobres(l.action as string, l.after),
  }));
}

export async function detailDuLot(depot: DepotLecture, id: string, role: string) {
  const lot = await depot.lotImport.findUnique({ where: { id }, include: { importePar: { select: { id: true, nomComplet: true } } } });
  if (!lot) return null;

  const rapport = lireRapport(lot.rapport);
  const compteurs = {
    lues: lot.lignesLues, validees: lot.lignesValidees, rejetees: lot.lignesRejetees,
    enConflit: lot.lignesEnConflit, ignorees: lot.lignesIgnorees, importees: lot.lignesImportees,
  };
  const vue: EntreeVue = { statut: lot.statut as StatutLot, compteurs, motifRejetLot: rapport.motifRejetLot };

  const [cles, historique] = await Promise.all([lot.lignesLues > 0 ? clesDuLot(depot, lot.id) : Promise.resolve([]), historiqueDuLot(depot, lot.id)]);
  const classees = classerColonnes(cles);
  const avertissements = [...rapport.avertissements];
  if (classees?.inconnuesTronquees) avertissements.push(`Plus de ${COLONNES_INCONNUES_MAX} colonnes inconnues : seules les ${COLONNES_INCONNUES_MAX} premieres (ordre alphabetique) sont listees.`);

  const { importePar, ...champs } = lot;
  return {
    ...champs,
    tailleOctets: lot.tailleOctets.toString(),
    importePar: importePar ? { id: importePar.id, nomComplet: importePar.nomComplet } : null,
    empreinte: { algorithme: "sha256" as const, valeur: lot.empreinteFichier },
    controle: {
      motifRejetLot: rapport.motifRejetLot,
      compteurs,
      premiersRejets: rapport.premiersRejets,
      // `null` quand rien n'est calculable (lot sans ligne) : jamais deux listes vides qui ressembleraient a un resultat.
      colonnes: classees ? { reconnues: classees.reconnues, inconnues: classees.inconnues } : null,
      avertissements,
    },
    etapes: calculerEtapes(vue),
    actionsPermises: calculerActions(vue, role),
    historique,
  };
}

/* ======================================== Apercu ======================================== */

export interface FiltresApercu { limite: number; statut?: "VALIDEE" | "REJETEE" | "IGNOREE" | "EN_CONFLIT"; apres?: number }

export async function apercuDuLot(depot: DepotLecture, id: string, f: FiltresApercu) {
  const lot = await depot.lotImport.findUnique({ where: { id }, select: { id: true } });
  if (!lot) return null;
  const lignes = await depot.ligneImport.findMany({
    where: {
      lotId: id,
      ...(f.statut ? { statut: f.statut as StatutLigneImport } : {}),
      ...(f.apres !== undefined ? { numeroLigne: { gt: f.apres } } : {}),
    },
    orderBy: { numeroLigne: "asc" },
    take: f.limite + 1,
    select: { numeroLigne: true, statut: true, motifRejet: true, identifiantSource: true, chargeOriginale: true },
  });
  const page = lignes.slice(0, f.limite);
  let tronque = false;
  const sortie = page.map((l) => {
    const c = formaterLignePourApercu(l.chargeOriginale);
    const m = tronquerMotif(l.motifRejet);
    const i = tronquerIdentifiant(l.identifiantSource);
    if (c.tronque || m.coupe || i.coupe) tronque = true;
    return { numeroLigne: l.numeroLigne, statut: l.statut as string, motifRejet: m.motif, identifiantSource: i.id, charge: c.charge };
  });
  return {
    lignes: sortie,
    suivant: lignes.length > f.limite && page.length > 0 ? page[page.length - 1].numeroLigne : null,
    tronque,
  };
}
