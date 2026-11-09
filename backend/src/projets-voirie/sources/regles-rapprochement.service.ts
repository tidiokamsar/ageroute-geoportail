/**
 * REGLES DE RAPPROCHEMENT ENTRE SOURCES (versionnees, approuvees) : lecture, creation, approbation (lot S1 ; contrat CONTRAT-SOURCES.md, 3.2).
 *
 * Meme mecanisme que les regles de conflit (RC-3) : un brouillon n est jamais applique ; l approbation est reservee a l ADMIN ; l auteur n approuve
 * pas sa propre regle sans derogation motivee (tracee dans l audit) ; une regle approuvee est IMMUABLE (declencheur de la base) : on cree une
 * nouvelle version. Creer ou approuver une regle ne modifie aucune comparaison passee : elle s applique a la PROCHAINE comparaison, qui enregistre
 * la version utilisee.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { estDelaiDepasse } from "../bd";
import { verifierApprobationRegle } from "../conflits/regle.noyau";
import { exigerProjetActif } from "../conflits/dossiers.service";
import { ErreurMetier, introuvable } from "../erreurs";
import { verrouillerProjet, type Acteur } from "../projets.service";
import {
  baremeApprouve, lirePrecisionParClasse, prochaineVersionRegleRapprochement, resoudreRegleRapprochement, verifierCreationRegleRapprochement,
  type RegleRapprochementLue, type TablePrecisionParClasse,
} from "./regle-rapprochement.noyau";

export const FAMILLES_RESEAU = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"] as const;
export type FamilleReseau = (typeof FAMILLES_RESEAU)[number];

type LigneRegle = Prisma.RegleRapprochementSourcesGetPayload<Record<string, never>>;

/** Bareme d une ligne : sa table si elle est complete et bien formee, sinon AUCUN (`{}` = pas de bareme ; jamais une valeur par defaut : M6). */
const tableDe = (json: unknown): TablePrecisionParClasse | null => lirePrecisionParClasse(json);

export const regleLue = (r: LigneRegle): RegleRapprochementLue => ({
  regleId: r.id, projetId: r.projetId, famille: r.famille, code: r.code, version: r.version, margeM: Number(r.margeM), rayonAppariementM: Number(r.rayonAppariementM),
  partHorsCorridorMax: Number(r.partHorsCorridorMax), precisionParClasseM: tableDe(r.precisionParClasseM), statut: r.statut, approuveLe: r.approuveLe,
  creeParId: r.creeParId, approuveParId: r.approuveParId,
});

async function personnes(ids: (string | null)[]): Promise<Map<string, { id: string; nomComplet: string }>> {
  const uniques = [...new Set(ids.filter((x): x is string => x !== null))];
  if (uniques.length === 0) return new Map();
  const l = await prisma.user.findMany({ where: { id: { in: uniques } }, select: { id: true, nomComplet: true } });
  return new Map(l.map((u) => [u.id, u]));
}

export function vueRegleRapprochement(r: LigneRegle, p: ReadonlyMap<string, { id: string; nomComplet: string }>) {
  return {
    id: r.id, projetId: r.projetId, portee: r.projetId ? "PROJET" : "GENERALE", famille: r.famille, code: r.code, version: r.version,
    margeM: Number(r.margeM), rayonAppariementM: Number(r.rayonAppariementM), partHorsCorridorMax: Number(r.partHorsCorridorMax), precisionParClasseM: tableDe(r.precisionParClasseM),
    // M6 : le bareme ne s'applique que s'il a ete approuve par un ADMIN autre que l'auteur ; la vue le dit.
    baremeApplicable: baremeApprouve(regleLue(r)) !== null,
    statut: r.statut, justification: r.justification, systeme: r.creeParId === null,
    creePar: r.creeParId ? p.get(r.creeParId) ?? null : null, approuvePar: r.approuveParId ? p.get(r.approuveParId) ?? null : null, approuveLe: r.approuveLe,
    motifApprobation: r.motifApprobation, derogationApprobation: r.derogationApprobation, createdAt: r.createdAt,
  };
}

/** Regles du projet et regles generales (dont la regle par defaut), avec la regle EFFECTIVE de chaque famille de reseau. */
export async function listerReglesRapprochement(projetId: string) {
  await exigerProjetActif(projetId);
  const lignes = await prisma.regleRapprochementSources.findMany({ where: { OR: [{ projetId }, { projetId: null }] }, orderBy: [{ projetId: "asc" }, { code: "asc" }, { version: "desc" }] });
  const p = await personnes(lignes.flatMap((r) => [r.creeParId, r.approuveParId]));
  const lues = lignes.map(regleLue);
  const effectives = FAMILLES_RESEAU.map((famille) => {
    const r = resoudreRegleRapprochement(lues, projetId, famille);
    return {
      famille, regleId: r.regle.regleId, code: r.regle.code, version: r.regle.version, portee: r.portee,
      margeM: r.regle.margeM, rayonAppariementM: r.regle.rayonAppariementM, partHorsCorridorMax: r.regle.partHorsCorridorMax, precisionParClasseM: r.regle.precisionParClasseM,
      baremeApplicable: baremeApprouve(r.regle) !== null,
    };
  });
  return {
    regles: lignes.map((r) => vueRegleRapprochement(r, p)), effectives,
    avertissements: [
      "Les valeurs par défaut (marge 1 m, rayon d'appariement 10 m, concordance stricte) sont provisoires : à valider par le DSI (CONTRAT-SOURCES.md, section 7).",
      "Une classe de précision (A à E) n'est pas une précision en mètres : la règle système n'a aucun barème ; un barème par classe ne s'applique que dans une règle créée par une personne et approuvée par un autre administrateur.",
    ],
  };
}

export interface CreationRegleRapprochement {
  famille?: FamilleReseau | null; code: string; margeM: number; rayonAppariementM: number; partHorsCorridorMax: number;
  precisionParClasseM?: TablePrecisionParClasse; justification: string;
}

export async function creerRegleRapprochement(acteur: Acteur, projetId: string, d: CreationRegleRapprochement) {
  const v = verifierCreationRegleRapprochement(d);
  if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
  // M6 : sans bareme demande, la regle n'en porte AUCUN (`{}`) ; une classe seule restera une precision inconnue.
  const table: TablePrecisionParClasse | Record<string, never> = d.precisionParClasseM ?? {};
  try {
    return await prisma.$transaction(async (tx) => {
      await verrouillerProjet(tx, projetId);
      const famille = d.famille ?? null;
      const code = d.code.trim();
      const max = await tx.regleRapprochementSources.aggregate({ where: { projetId, famille, code }, _max: { version: true } });
      const version = prochaineVersionRegleRapprochement(max._max.version === null ? [] : [max._max.version]);
      const r = await tx.regleRapprochementSources.create({
        data: {
          projetId, famille, code, version, margeM: d.margeM, rayonAppariementM: d.rayonAppariementM, partHorsCorridorMax: d.partHorsCorridorMax,
          precisionParClasseM: table as unknown as Prisma.InputJsonValue, justification: d.justification.trim(), creeParId: acteur.id, statut: "BROUILLON",
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "CREATE", entityType: "RegleRapprochementSources", entityId: r.id,
        after: { projetId, famille, code, version, margeM: d.margeM, rayonAppariementM: d.rayonAppariementM, partHorsCorridorMax: d.partHorsCorridorMax, precisionParClasseM: table, statut: "BROUILLON" },
        ipAddress: acteur.ip,
      });
      const p = await personnes([acteur.id]);
      return { regle: vueRegleRapprochement(r, p) };
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Le projet est occupé par une autre opération : réessayez dans quelques instants.");
    throw e;
  }
}

export async function approuverRegleRapprochement(acteur: Acteur, projetId: string, regleId: string, d: { justification?: string; derogation?: string }) {
  try {
    return await prisma.$transaction(async (tx) => {
      await verrouillerProjet(tx, projetId);
      const r = await tx.regleRapprochementSources.findFirst({ where: { id: regleId, OR: [{ projetId }, { projetId: null }] } });
      if (!r) throw introuvable("Règle", "REGLE_INTROUVABLE");
      const v = verifierApprobationRegle({ statut: r.statut, creeParId: r.creeParId, acteurId: acteur.id, justification: d.justification, derogation: d.derogation });
      if (!v.ok) throw new ErreurMetier(v.status, v.code, v.message);
      // M6 (decision de l'architecte) : un bareme classe vers metres n'est admis que s'il est approuve par un ADMIN AUTRE que l'auteur, sans derogation.
      if (lirePrecisionParClasse(r.precisionParClasseM) !== null && r.creeParId === acteur.id) {
        throw new ErreurMetier(409, "SEPARATION_DES_TACHES", "Une règle qui porte un barème par classe de précision ne s'approuve que par un administrateur autre que son auteur (aucune dérogation possible).", { bareme: true });
      }
      const n = await tx.regleRapprochementSources.updateMany({
        where: { id: regleId, statut: "BROUILLON" },
        data: { statut: "APPROUVEE", approuveParId: acteur.id, approuveLe: new Date(), motifApprobation: (d.justification ?? "").trim(), derogationApprobation: v.derogation },
      });
      if (n.count !== 1) throw new ErreurMetier(409, "REGLE_IMMUABLE", "Cette règle vient d'être approuvée : elle ne change plus.");
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "VALIDATE", entityType: "RegleRapprochementSources", entityId: regleId,
        before: { statut: "BROUILLON" },
        after: { statut: "APPROUVEE", code: r.code, version: r.version, justification: (d.justification ?? "").trim(), derogationSeparation: v.derogation, memePersonne: r.creeParId === acteur.id },
        ipAddress: acteur.ip,
      });
      const apres = await tx.regleRapprochementSources.findUniqueOrThrow({ where: { id: regleId } });
      const p = await personnes([apres.creeParId, apres.approuveParId]);
      return { regle: vueRegleRapprochement(apres, p) };
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Le projet est occupé par une autre opération : réessayez dans quelques instants.");
    throw e;
  }
}
