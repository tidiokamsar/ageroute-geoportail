import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModuleKey } from "../lib/modules";
import { requireAuth } from "../middleware/auth.middleware";
import { prisma } from "../lib/prisma";
import { moduleAutorise, modulesAutorisesDe } from "../lib/access";
import { droitMontantsContractuels } from "../modules/chantiers/chantiers.confidentialite";
import { perimetreDe } from "../territoire/territoire.service";
import { logAuditTransactionnelle } from "../utils/audit";
import {
  MENTION_CONSULTATIVE, rendreCsv, type Cellule, type EnteteExport, type JeuDonnees,
} from "../aide-decision/export.noyau";

/**
 * `/api/v2/export/selection` — exporter CE QUE L'AGENT A CHOISI, pas toute la table. Durci par le lot 6 (aide a la
 * decision) : le geste et le contrat de requete ne changent pas, ce que le serveur remet change.
 *
 * Ce que l'audit du 26/10/2026 reprochait a cette route, et ce qui est corrige ici :
 *   - AUCUN CONTROLE TERRITORIAL : un compte regional exportait par identifiant les lignes d'une autre region. Desormais
 *     la region de CHAQUE LIGNE est controlee en base (`regionId` du patrimoine ; pour un marche, la region de TOUS ses
 *     chantiers, un marche sans chantier n'a pas de region et n'est pas remis a un compte regional) ;
 *   - `row_to_json(t.*)` : TOUTES les colonnes, montants des marches compris, photos, geometrie. Remplace par une liste
 *     BLANCHE de colonnes par table (`TABLES`) ; les colonnes financieres ne sont meme pas lues pour un compte sans droit
 *     financier (module `marches`, PROVISOIRE) ;
 *   - LIGNES ARCHIVEES (`deletedAt`) : exclues (une suppression logique est une decision, l'export ne la contredit pas) ;
 *   - AUCUN JOURNAL, ni filtres ni date dans le fichier : le fichier porte maintenant date, auteur, perimetre, nombre de
 *     lignes demandees et exportees, colonnes retirees, mention ; un journal d'export (avec l'empreinte SHA-256 du
 *     fichier) et l'audit sont ecrits AVANT la remise, dans une transaction ;
 *   - GEOJSON EN ERREUR SQL : `row_to_json(...)::text - 'geom'` (operateur `-` inexistant sur du texte) ; plus de geometrie
 *     dans les proprietes puisque la liste blanche ne la contient pas ;
 *   - PROMESSE JAMAIS RESOLUE : `requireModuleAccess` refuse en repondant 403 sans appeler `next`, la promesse qui
 *     l'enveloppait restait pendante (requete suspendue). Le droit se lit maintenant directement (`modulesAutorisesDe`).
 *
 * LISTE BLANCHE, PAS TABLE OUVERTE : le nom de table vient du client ; il n'est accepte que s'il figure ci-dessous. Les
 * identifiants de table et de colonne ne viennent QUE de cette liste (jamais du client) ; les valeurs (identifiants,
 * regions) sont liees (`$1`, `$2`), jamais interpolees.
 *
 * Le droit se controle sur le MODULE de la table demandee. Les marches (donnees contractuelles) exigent en plus le role
 * ADMIN ou GESTIONNAIRE (CONTRAT-AD paragraphe 2, PROVISOIRE). Les colonnes financieres (montants, bailleur, numero de contrat,
 * entreprise) suivent la regle unique `droitMontantsContractuels`.
 *
 * Le CSV sort en point-virgule avec BOM UTF-8 (Excel francophone), precede d'un bloc d'en-tete `# cle;valeur`. Le GeoJSON
 * porte la geometrie en WGS84 (SRID 4326) et, en membre etranger `metadonnees`, le meme en-tete.
 *
 * Plafond : 2 000 identifiants par appel — l'export massif reste le travail de l'export global.
 */

interface ColonneTable { nom: string; financier?: boolean }
interface TableExport {
  table: string;
  geom: string | null;
  module: ModuleKey;
  colonnes: readonly ColonneTable[];
  /** Fragment SQL (constante du code) qui limite aux regions liees `$2::int[]` ; jamais construit a partir du client. */
  clauseRegion: string;
  /** Exiger ADMIN ou GESTIONNAIRE (donnees contractuelles). */
  reserveGestion?: boolean;
}

const c = (...noms: string[]): ColonneTable[] => noms.map((nom) => ({ nom }));
const f = (...noms: string[]): ColonneTable[] => noms.map((nom) => ({ nom, financier: true }));

const REGION_PROPRE = 't."regionId" = ANY($2::int[])';
const REGION_MARCHE = `(
  EXISTS (SELECT 1 FROM marches_chantiers mc JOIN chantiers cc ON cc.id = mc."chantierId" AND cc."deletedAt" IS NULL WHERE mc."marcheId" = t.id)
  AND NOT EXISTS (SELECT 1 FROM marches_chantiers mx JOIN chantiers cx ON cx.id = mx."chantierId" AND cx."deletedAt" IS NULL
                   WHERE mx."marcheId" = t.id AND NOT (cx."regionId" = ANY($2::int[]))))`;

export const TABLES: Record<string, TableExport> = {
  troncons: {
    table: "troncons", geom: "geom", module: "troncons", clauseRegion: REGION_PROPRE,
    colonnes: [
      ...c("id", "code", "nom", "classe", "regionId", "longueurKm", "revetement", "etat", "pkDebut", "pkFin", "sectionPk", "traficMoyenJma",
        "traficDateComptage", "criticiteStrategique"),
      ...f("coutRehabEstime"),
      ...c("dateDerniereEvaluation", "prefecture", "commune", "observations", "sourceType", "sourceReference", "sourceConfidence", "statutValidation", "createdAt", "updatedAt"),
    ],
  },
  ouvrages: {
    table: "ouvrages", geom: "geom", module: "ouvrages", clauseRegion: REGION_PROPRE,
    colonnes: c("id", "nom", "type", "etat", "regionId", "tronconId", "pk", "longueurM", "gabaritT", "anneeConstruction", "materiau", "derniereInspectionDate",
      "ficheNumero", "code", "largeurM", "hauteurM", "nbTravees", "longueurTravee", "materiauAppuis", "materiauTablier", "materiauPiles", "materiauAutre",
      "remarques", "travauxAPrevoir", "sourceType", "sourceReference", "sourceConfidence", "createdAt", "updatedAt"),
  },
  points_noirs: {
    table: "points_noirs", geom: "geom", module: "points-noirs", clauseRegion: REGION_PROPRE,
    colonnes: c("id", "description", "regionId", "tronconId", "pk", "gravite", "nbAccidents", "causes", "mesuresCorrectives", "statutValidation", "createdAt", "updatedAt"),
  },
  postes: {
    table: "postes", geom: "geom", module: "postes", clauseRegion: REGION_PROPRE,
    colonnes: [
      ...c("id", "nom", "type", "regionId", "tronconId", "pk", "statut"),
      ...f("recettesMensuellesGnf"),
      ...c("traficJma", "historicalRecovered", "recoveredFrom", "recoveryStatus", "statutValidation", "createdAt", "updatedAt"),
    ],
  },
  chantiers: {
    table: "chantiers", geom: "geom", module: "chantiers", clauseRegion: REGION_PROPRE,
    colonnes: [
      ...c("id", "intitule"),
      // L'entreprise (titulaire) est de la meme nature que le montant et le numero de contrat : colonne financiere.
      ...f("entreprise", "bailleur", "montantGnf", "numContrat"),
      ...c("regionId", "tronconId", "pkDebut", "pkFin", "avancementPct", "statut", "dateDebutPrevue", "dateFinPrevue", "dateDebutReelle", "dateFinReelle",
        "observations", "statutLocalisation", "statutValidation", "createdAt", "updatedAt"),
    ],
  },
  marches: {
    table: "marches", geom: null, module: "marches", clauseRegion: REGION_MARCHE, reserveGestion: true,
    colonnes: [
      ...c("id", "intitule"),
      ...f("bailleurId", "montantTotal", "devise"),
      ...c("dateSignature", "dateDebutPrevue", "dateFinPrevue", "dateReceptionProvisoire", "garantieBonneExecutionExp"),
      ...f("tauxPenaliteRetardPct"),
      ...c("statut", "createdAt", "updatedAt"),
    ],
  },
};

// Identifiants de la liste blanche : verification au chargement, pour qu'une faute de frappe ne devienne jamais une injection.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const t of Object.values(TABLES)) {
  if (!IDENT.test(t.table) || (t.geom && !IDENT.test(t.geom)) || t.colonnes.some((k) => !IDENT.test(k.nom))) {
    throw new Error(`export.routes : identifiant SQL invalide dans la liste blanche (${t.table})`);
  }
}

const corpsExport = z.object({
  table: z.string().min(1),
  format: z.enum(["csv", "geojson"]),
  ids: z.array(z.string().min(1).max(64)).min(1).max(2000),
}).strict();

export const exportV2Router = Router();
exportV2Router.use(requireAuth);

exportV2Router.post("/selection", async (req, res, next) => {
  try {
    const p = corpsExport.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: "corps invalide : table, format (csv|geojson) et ids (1 à 2000) sont exigés", details: p.error.flatten().fieldErrors });
      return;
    }
    const def = Object.prototype.hasOwnProperty.call(TABLES, p.data.table) ? TABLES[p.data.table] : undefined;
    if (!def) {
      res.status(400).json({ error: "table non exportable par sélection", code: "TABLE_REFUSEE", tables: Object.keys(TABLES) });
      return;
    }
    if (p.data.format === "geojson" && !def.geom) {
      res.status(422).json({ error: `la table ${def.table} n'a pas de géométrie : seul le CSV est exportable`, code: "SANS_GEOMETRIE" });
      return;
    }

    const user = req.user!;
    // Le droit se controle sur le MODULE de la table demandee, lu directement : une garde qui repond sans appeler `next`
    // laissait la promesse qui l'enveloppait pendante.
    const modules = await modulesAutorisesDe(user);
    if (!moduleAutorise(modules, def.module)) {
      res.status(403).json({ error: "Accès à ce module non autorisé pour votre compte", code: "MODULE_NON_AUTORISE" });
      return;
    }
    if (def.reserveGestion && user.role !== "ADMIN" && user.role !== "GESTIONNAIRE") {
      res.status(403).json({ error: "L'export des données contractuelles est réservé aux rôles ADMIN et GESTIONNAIRE", code: "ROLE_INSUFFISANT" });
      return;
    }
    // Regle UNIQUE des montants contractuels et du titulaire (D-C1-1, PROVISOIRE) : la meme que les lectures de chantiers, la synthese et le suivi contractuel.
    const droitFinancier = droitMontantsContractuels(modules);
    const perimetre = await perimetreDe(user);
    const regions = perimetre.national ? null : [...perimetre.regions].sort((a, b) => a - b);

    const colonnes = def.colonnes.filter((k) => droitFinancier || !k.financier);
    const retirees = def.colonnes.filter((k) => !droitFinancier && k.financier).map((k) => k.nom);
    // Les noms viennent de la liste blanche (verifiee au chargement) ; ils sont cites entre guillemets.
    const paires = colonnes.map((k) => `'${k.nom}', t."${k.nom}"`).join(", ");
    const params: unknown[] = [p.data.ids];
    // LIGNES ARCHIVEES EXCLUES, controle territorial PAR LIGNE, valeurs liees.
    let ou = `t.id::text = ANY($1::text[]) AND t."deletedAt" IS NULL`;
    if (regions !== null) { ou += ` AND ${def.clauseRegion}`; params.push(regions); }
    const geomSql = def.geom ? `, ST_AsGeoJSON(t."${def.geom}") AS geojson` : "";
    const lignes = await prisma.$queryRawUnsafe(
      `SELECT t.id::text AS fid, json_build_object(${paires})::text AS props${geomSql} FROM ${def.table} t WHERE ${ou} ORDER BY t.id`,
      ...params,
    ) as Array<{ fid: string; props: string; geojson?: string | null }>;

    const exportees = lignes.length;
    const maintenant = new Date();
    const exportId = randomUUID();
    const libellePerimetre = regions === null ? "National (toutes les regions)" : `Regions du compte (identifiants : ${regions.join(", ")})`;
    const entete: EnteteExport = {
      titre: `Selection ${def.table} (export par identifiants)`, type: `selection:${def.table}`, format: p.data.format, exportId,
      genereLe: maintenant.toISOString(), auteur: { id: user.id, email: user.email ?? "", role: user.role },
      filtresDemandes: {}, filtresAppliques: {},
      filtresNonAppliques: [{ filtre: "selection", raison: `la selection part par identifiants, jamais par filtre : ${p.data.ids.length} identifiant(s) demande(s)` }],
      perimetre: { libelle: libellePerimetre, national: regions === null, regionIds: regions },
      unites: {}, sources: [{ code: def.table, libelle: `Table ${def.table} (etat courant)`, dateReference: maintenant.toISOString() }],
      definitions: [],
      avertissements: [
        `${p.data.ids.length} identifiant(s) demande(s), ${exportees} ligne(s) exportee(s) : les identifiants inconnus, archives ou hors de votre perimetre ne sont pas exportes.`,
        ...(retirees.length > 0 ? ["Compte sans droit financier : colonnes financieres retirees."] : []),
      ],
      mention: MENTION_CONSULTATIVE, nbLignes: exportees, limiteLignes: 2000,
      droitFinancier, colonnesFinancieresRetirees: retirees,
    };

    let contenu: string;
    let contentType: string;
    let extension: string;
    if (p.data.format === "csv") {
      const parsed = lignes.map((r) => JSON.parse(r.props) as Record<string, Cellule | object>);
      const jeu: JeuDonnees = {
        colonnes: colonnes.map((k) => ({ cle: k.nom, libelle: k.nom, unite: null, financier: k.financier })),
        // Un objet imbrique (rare : aucune colonne de la liste blanche n'en porte) serait serialise, jamais perdu.
        lignes: parsed.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v as Cellule]))),
      };
      contenu = rendreCsv(entete, jeu);
      contentType = "text/csv; charset=utf-8"; extension = "csv";
    } else {
      const features = lignes.map((r) => ({
        type: "Feature", id: r.fid,
        geometry: r.geojson ? JSON.parse(r.geojson) : null,
        properties: JSON.parse(r.props) as Record<string, unknown>,
      }));
      contenu = JSON.stringify({ type: "FeatureCollection", metadonnees: entete, features });
      contentType = "application/geo+json; charset=utf-8"; extension = "geojson";
    }
    const octets = Buffer.from(contenu, "utf8");
    const empreinte = createHash("sha256").update(octets).digest("hex");

    // JOURNAL + AUDIT AVANT REMISE : pas de fichier sans trace.
    await prisma.$transaction(async (tx) => {
      await tx.exportJournal.create({
        data: {
          id: exportId, type: `selection:${def.table}`, format: p.data.format, auteurId: user.id, auteurEmail: user.email ?? "", auteurRole: user.role,
          filtres: { selection: "identifiants", demandes: p.data.ids.length } as never,
          perimetre: { libelle: libellePerimetre, national: regions === null, regionIds: regions } as never,
          nbLignes: exportees, tailleOctets: octets.length, empreinteSha256: empreinte, droitFinancier, colonnesRetirees: retirees as never,
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "CREATE", entityType: "ExportJournal", entityId: exportId,
        after: { type: `selection:${def.table}`, format: p.data.format, nbLignes: exportees, empreinteSha256: empreinte },
        ipAddress: req.ip,
      });
    });

    res.set({
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="selection-${def.table}.${extension}"`,
      "Cache-Control": "no-store",
      "X-Export-Id": exportId,
      "X-Export-Empreinte-Sha256": empreinte,
      "X-Export-Nb-Lignes": String(exportees),
      "X-Content-Type-Options": "nosniff",
    });
    res.send(contenu);
  } catch (err) { next(err); }
});
