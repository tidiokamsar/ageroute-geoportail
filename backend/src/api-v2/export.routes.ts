import { Router } from "express";
import { z } from "zod";
import type { ModuleKey } from "../lib/modules";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";

/**
 * `/api/v2/export/selection` — exporter CE QUE L'AGENT A CHOISI, pas toute la table.
 *
 * L'export global existant sert les sauvegardes de jeu complet ; ici c'est le geste
 * métier : « ces 40 ouvrages critiques de Kindia », en CSV pour le tableur, en
 * GeoJSON pour le SIG. La sélection part par identifiants, jamais par filtre
 * recréé côté serveur : ce qui est exporté est exactement ce qui est coché.
 *
 * LISTE BLANCHE, PAS TABLE OUVERTE : le nom de table vient du client ; il n'est
 * accepté que s'il figure ci-dessous, avec sa colonne géométrique et son module.
 * Aucune autre table ne passe — pas de contournement par /api/v2/export.
 *
 * Le CSV sort en point-virgule avec BOM UTF-8 : c'est ce qu'Excel francophone
 * ouvre proprement d'un double-clic. Le GeoJSON porte la géométrie en WGS84
 * (SRID 4326, celui du dépôt) et TOUTES les autres colonnes en propriétés.
 *
 * Plafond : 2 000 identifiants par appel — l'export massif reste le travail de
 * l'export global, pas de la sélection.
 */

type TableExport = { table: string; geom: string | null; module: ModuleKey };

const TABLES: Record<string, TableExport> = {
  troncons: { table: "troncons", geom: "geom", module: "troncons" },
  ouvrages: { table: "ouvrages", geom: "geom", module: "ouvrages" },
  points_noirs: { table: "points_noirs", geom: "geom", module: "points-noirs" },
  postes: { table: "postes", geom: "geom", module: "postes" },
  chantiers: { table: "chantiers", geom: "geom", module: "chantiers" },
  marches: { table: "marches", geom: null, module: "marches" },
};

const corpsExport = z.object({
  table: z.string().min(1),
  format: z.enum(["csv", "geojson"]),
  ids: z.array(z.string().min(1)).min(1).max(2000),
}).strict();

function csvEchapper(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function versCsv(lignes: Array<Record<string, unknown>>): string {
  if (lignes.length === 0) return "\uFEFF;\n";
  const colonnes = Object.keys(lignes[0]);
  const entete = colonnes.map(csvEchapper).join(";");
  const corps = lignes.map((l) => colonnes.map((c) => csvEchapper(l[c])).join(";")).join("\n");
  return `\uFEFF${entete}\n${corps}\n`;
}

export const exportV2Router = Router();
exportV2Router.use(requireAuth);

exportV2Router.post("/selection", async (req, res, next) => {
  try {
    const p = corpsExport.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: "corps invalide : table, format (csv|geojson) et ids (1 à 2000) sont exigés", details: p.error.flatten().fieldErrors });
      return;
    }
    const def = TABLES[p.data.table];
    if (!def) {
      res.status(400).json({ error: "table non exportable par sélection", code: "TABLE_REFUSEE", tables: Object.keys(TABLES) });
      return;
    }
    // Le droit se contrôle sur le MODULE de la table demandée, pas sur un module « export ».
    await new Promise<void>((resolve, reject) => {
      requireModuleAccess(def.module)(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
    });

    const ids = p.data.ids;
    if (p.data.format === "csv") {
      const lignes = await prisma.$queryRawUnsafe(
        `SELECT row_to_json(t.*)::text AS ligne FROM ${def.table} t WHERE t.id::text = ANY($1::text[])`,
        ids,
      );
      const parsed = (lignes as Array<{ ligne: string }>).map((r) => JSON.parse(r.ligne) as Record<string, unknown>);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="selection-${def.table}.csv"`);
      res.send(versCsv(parsed));
      return;
    }

    if (!def.geom) {
      res.status(422).json({ error: `la table ${def.table} n'a pas de géométrie : seul le CSV est exportable`, code: "SANS_GEOMETRIE" });
      return;
    }
    const lignes = await prisma.$queryRawUnsafe(
      `SELECT t.id::text AS fid, row_to_json(t.*)::text - 'geom' AS props, ST_AsGeoJSON(t.${def.geom}) AS geojson
         FROM ${def.table} t WHERE t.id::text = ANY($1::text[])`,
      ids,
    );
    const features = (lignes as Array<{ fid: string; props: string; geojson: string | null }>).map((r) => ({
      type: "Feature",
      id: r.fid,
      geometry: r.geojson ? JSON.parse(r.geojson) : null,
      properties: JSON.parse(r.props) as Record<string, unknown>,
    }));
    res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="selection-${def.table}.geojson"`);
    res.json({ type: "FeatureCollection", features });
  } catch (err) { next(err); }
});
