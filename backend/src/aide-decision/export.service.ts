/**
 * ORCHESTRATION d'un export gouverne (lot 6) : filtres, jeu de donnees, retrait des colonnes financieres, plafond,
 * en-tete, rendu, empreinte. Aucune lecture directe de la base : les jeux viennent de FOURNISSEURS injectes
 * (`export.fournisseurs.ts` pour les vrais), ce qui permet de tester chaque regle sans base.
 *
 * L'ORDRE COMPTE. Le plafond se verifie APRES le retrait des colonnes financieres (le nombre de lignes ne change pas, mais
 * un fichier refuse n'a jamais ete rendu) et AVANT le rendu : aucun fichier tronque n'est jamais remis, un fichier trop
 * gros est refuse en entier (413). Le journal, lui, est ecrit par la route avant la remise du fichier.
 */
import { createHash } from "node:crypto";
import {
  LIBELLE_TYPE, LIMITE_LIGNES_EXPORT, MENTION_CONSULTATIVE, libellePerimetre, nomFichier, partitionnerFiltres, rendre,
  retirerColonnesFinancieres, unitesDe, verifierPlafond,
  type DefinitionIndicateur, type EnteteExport, type FiltresExport, type FormatExport, type JeuDonnees, type SourceExport, type TypeExport,
} from "./export.noyau";

export interface Portee {
  national: boolean;
  /** Regions en portee ; `null` = pays entier (compte national sans filtre de region). */
  regions: readonly number[] | null;
  regionNoms: string[];
  regionDemandee: string | null;
}

export interface DroitsExport {
  /** Droit financier (PROVISOIRE, CONTRAT-AD paragraphe 2) : module `marches`. Sans lui, aucune colonne financiere. */
  financier: boolean;
  marches: boolean;
  programmation: boolean;
}

export interface ContexteProduction {
  compte: { id: string; role: string; email: string };
  maintenant: Date;
  exportId: string;
  type: TypeExport;
  format: FormatExport;
  filtres: FiltresExport;
  scenarioId: string | null;
  portee: Portee;
  droits: DroitsExport;
  limiteLignes?: number;
}

export interface ProduitExport {
  jeu: JeuDonnees;
  sources: SourceExport[];
  definitions: DefinitionIndicateur[];
  avertissements: string[];
}

/** Un fournisseur rend `null` quand la ressource demandee n'existe pas (ou n'est pas visible) : la route repond 404. */
export interface Fournisseurs {
  synthese(ctx: ContexteProduction, filtres: FiltresExport): Promise<ProduitExport>;
  reseauRegions(ctx: ContexteProduction, filtres: FiltresExport): Promise<ProduitExport>;
  interventions(ctx: ContexteProduction, filtres: FiltresExport, scenarioId: string): Promise<ProduitExport | null>;
  scenario(ctx: ContexteProduction, filtres: FiltresExport, scenarioId: string): Promise<ProduitExport | null>;
}

export type ResultatProduction =
  | {
      ok: true;
      contenu: string;
      contentType: string;
      nomFichier: string;
      empreinteSha256: string;
      tailleOctets: number;
      nbLignes: number;
      colonnesRetirees: string[];
      entete: EnteteExport;
    }
  | { ok: false; statut: 400 | 404 | 413; code: string; error: string };

export const CONTENT_TYPE: Record<FormatExport, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export function typeNecessiteScenario(t: TypeExport): boolean {
  return t === "interventions" || t === "scenario";
}

export async function produireExport(ctx: ContexteProduction, f: Fournisseurs): Promise<ResultatProduction> {
  const { appliques, nonAppliques } = partitionnerFiltres(ctx.type, ctx.filtres);

  let produit: ProduitExport | null;
  if (typeNecessiteScenario(ctx.type)) {
    if (!ctx.scenarioId) {
      return {
        ok: false, statut: 400, code: "SCENARIO_REQUIS",
        error: "scenarioId est requis : la liste d'interventions et le scenario exportes sont ceux d'un scenario de programmation calcule et scelle.",
      };
    }
    produit = ctx.type === "interventions"
      ? await f.interventions(ctx, appliques, ctx.scenarioId)
      : await f.scenario(ctx, appliques, ctx.scenarioId);
    if (!produit) return { ok: false, statut: 404, code: "INTROUVABLE", error: "scenario introuvable" };
  } else {
    produit = ctx.type === "synthese" ? await f.synthese(ctx, appliques) : await f.reseauRegions(ctx, appliques);
  }

  const { jeu, retirees } = retirerColonnesFinancieres(produit.jeu, ctx.droits.financier);
  const nbLignes = jeu.lignes.length;
  const plafond = verifierPlafond(nbLignes, ctx.limiteLignes ?? LIMITE_LIGNES_EXPORT);
  if (!plafond.ok) return { ok: false, statut: plafond.statut, code: plafond.code, error: plafond.message };

  const avertissements = [...produit.avertissements];
  if (!ctx.droits.financier) {
    avertissements.push("Compte sans droit financier : les colonnes et indicateurs financiers sont retires de ce fichier. Il est incomplet par construction.");
  }

  const entete: EnteteExport = {
    titre: LIBELLE_TYPE[ctx.type],
    type: ctx.type,
    format: ctx.format,
    exportId: ctx.exportId,
    genereLe: ctx.maintenant.toISOString(),
    auteur: { id: ctx.compte.id, email: ctx.compte.email, role: ctx.compte.role },
    filtresDemandes: ctx.filtres,
    filtresAppliques: appliques,
    filtresNonAppliques: nonAppliques,
    perimetre: {
      libelle: libellePerimetre(ctx.portee.national, ctx.portee.regionNoms, ctx.portee.regionDemandee),
      national: ctx.portee.national,
      regionIds: ctx.portee.regions === null ? null : [...ctx.portee.regions],
    },
    unites: unitesDe(jeu),
    sources: produit.sources,
    definitions: produit.definitions,
    avertissements,
    mention: MENTION_CONSULTATIVE,
    nbLignes,
    limiteLignes: ctx.limiteLignes ?? LIMITE_LIGNES_EXPORT,
    droitFinancier: ctx.droits.financier,
    colonnesFinancieresRetirees: retirees,
  };

  const contenu = rendre(ctx.format, entete, jeu);
  const octets = Buffer.from(contenu, "utf8");
  return {
    ok: true,
    contenu,
    contentType: CONTENT_TYPE[ctx.format],
    nomFichier: nomFichier(ctx.type, ctx.format, ctx.maintenant),
    empreinteSha256: createHash("sha256").update(octets).digest("hex"),
    tailleOctets: octets.length,
    nbLignes,
    colonnesRetirees: retirees,
    entete,
  };
}
