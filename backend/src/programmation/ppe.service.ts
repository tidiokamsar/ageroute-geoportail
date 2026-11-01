/**
 * SERVICE DE LA PROGRAMMATION PLURIANNUELLE (PPE) MINIMALE.
 *
 * Orchestre : il lit la base (moteur.depot), fait calculer le noyau (ppe.noyau) et ecrit (ppe.depot). Toute
 * ecriture est AUDITEE dans la MEME transaction (`logAuditTransactionnelle`) : une panne d'audit annule
 * l'ecriture. Le declencheur de la base refuse de toute facon la modification d'un plan fige.
 *
 * AUCUNE ENVELOPPE N'EST INVENTEE : chaque montant annuel vient de la demande de l'utilisateur. Le service ne
 * repartit pas un total, ne reporte pas un reste, n'indexe rien.
 *
 * ELLE NE CREE AUCUN ENGAGEMENT : ni marche, ni contrat, ni ordre de travaux, ni chantier, ni fiche. Les fiches
 * se figent depuis un scenario annuel (`moteur.service.figerFiches`).
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import { canonique, sha256Hex } from "./canonique";
import * as depot from "./moteur.depot";
import { RefusMoteur, choisirParametres, type Client, type Contexte } from "./moteur.service";
import { validerParametres } from "./parametres.noyau";
import {
  MAX_CANDIDATS_PPE, construirePlan, entreesPpeDepuisJson, entreesPpeVersJson,
  type EntreesPpe, type PlanPluriannuel,
} from "./ppe.noyau";
import * as ppe from "./ppe.depot";

const ISOLATION = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 } as const;

export interface DemandePpe {
  anneeDebut: number;
  intitule: string;
  /** Une enveloppe SAISIE par annee, dans l'ordre des annees a partir de `anneeDebut`. */
  enveloppes: { budgetGnf: bigint; plafondsRegionauxGnf?: Record<string, bigint> }[];
  regionId?: number | null;
  classe?: string | null;
  parametresId?: string | null;
}

export function resumePlanApi(p: ppe.ResumePlanDb) {
  return {
    id: p.id, intitule: p.intitule, anneeDebut: p.anneeDebut, nbAnnees: p.nbAnnees, anneeFin: p.anneeDebut + p.nbAnnees - 1,
    parametresVersion: p.parametresVersion, parametresId: p.parametresId,
    enveloppeTotaleGnf: p.enveloppeTotaleGnf.toString(), montantEngageGnf: p.montantEngageGnf.toString(),
    nbRetenus: p.nbRetenus, nbNonRetenus: p.nbNonRetenus, perimetre: p.perimetre, provisoire: p.provisoire,
    etiquette: p.provisoire ? "PROVISOIRE, non approuvé" : "paramètres et barèmes approuvés",
    empreinteEntrees: p.empreinteEntrees, empreinteResultat: p.empreinteResultat, creeParId: p.creeParId, creeLe: p.creeLe,
  };
}

/** Lit tout ce que le calcul consomme, dans la transaction appelante (un seul instantane de la base). */
export async function chargerEntreesPpe(db: depot.Db, d: DemandePpe, parametres: EntreesPpe["parametres"]): Promise<EntreesPpe> {
  const candidats = await depot.chargerCandidats(db, { regionId: d.regionId ?? null, classe: d.classe ?? null, limite: MAX_CANDIDATS_PPE + 1 });
  if (candidats.length > MAX_CANDIDATS_PPE) {
    throw new RefusMoteur("PERIMETRE_TROP_LARGE", `plus de ${MAX_CANDIDATS_PPE} tronçons candidats pour un plan pluriannuel : restreignez le périmètre (région ou classe de route)`, 422);
  }
  const enveloppes: EntreesPpe["enveloppes"] = [];
  for (let i = 0; i < d.enveloppes.length; i++) {
    const annee = d.anneeDebut + i;
    enveloppes.push({
      annee, budgetGnf: d.enveloppes[i].budgetGnf, plafondsRegionauxGnf: d.enveloppes[i].plafondsRegionauxGnf ?? {},
      baremes: await depot.chargerBaremes(db, annee),
    });
  }
  return {
    anneeDebut: d.anneeDebut, enveloppes, parametres, candidats,
    catalogue: await depot.chargerCatalogue(db), conditions: await depot.chargerConditions(db), matrices: await depot.chargerMatrices(db),
  };
}

export async function simulerPlan(client: Client, d: DemandePpe, ctx: Contexte) {
  return client.$transaction(async (tx) => {
    const ligneParams = await choisirParametres(tx, d.parametresId);
    const parametres = depot.parametresDeLigne(ligneParams);
    const valides = validerParametres(parametres);
    if (!valides.ok) throw new RefusMoteur("PARAMETRES_INVALIDES", valides.erreurs.join(" ; "), 422);

    const entrees = await chargerEntreesPpe(tx, d, parametres);
    const r = construirePlan(entrees);
    if (!r.ok) throw new RefusMoteur(r.code, r.erreurs.join(" ; "), 422);

    const entreesCanoniques = canonique(entreesPpeVersJson(entrees));
    const resultatCanonique = canonique(r.plan);
    const perimetre = canonique({ regionId: d.regionId ?? null, classe: d.classe ?? null });
    const s = r.plan.synthese;
    const id = randomUUID();
    const resume = await ppe.insererPlan(tx, {
      id, intitule: d.intitule, anneeDebut: d.anneeDebut, nbAnnees: d.enveloppes.length, parametresId: ligneParams.id, parametresVersion: parametres.version,
      enveloppeTotaleGnf: BigInt(s.enveloppeTotaleGnf), perimetreJson: perimetre, entreesCanoniques, empreinteEntrees: sha256Hex(entreesCanoniques),
      resultatCanonique, empreinteResultat: sha256Hex(resultatCanonique), nbRetenus: s.retenus, nbNonRetenus: s.nonRetenus,
      montantEngageGnf: BigInt(s.engageTotalGnf), provisoire: r.plan.provisoire, creeParId: ctx.userId,
    });
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "CREATE", entityType: "PlanPluriannuel", entityId: id,
      after: {
        anneeDebut: d.anneeDebut, nbAnnees: d.enveloppes.length, intitule: d.intitule, parametresVersion: parametres.version, provisoire: r.plan.provisoire,
        enveloppesGnf: d.enveloppes.map((e) => e.budgetGnf.toString()), candidats: s.candidats, retenus: s.retenus, engageGnf: s.engageTotalGnf,
        empreinteResultat: resume.empreinteResultat,
      },
      ipAddress: ctx.ipAddress,
    });
    return { plan: resumePlanApi(resume), resultat: r.plan };
  }, ISOLATION);
}

export async function lirePlanComplet(client: Client, id: string) {
  const p = await ppe.lirePlan(client, id);
  if (!p) throw new RefusMoteur("INTROUVABLE", "plan pluriannuel introuvable ou supprimé", 404);
  return { plan: resumePlanApi(p), resultat: JSON.parse(p.resultatCanonique) as PlanPluriannuel };
}

export interface RapportRejeuPpe {
  identique: boolean;
  empreinteStockee: string;
  empreinteRecalculee: string;
  entreesIntegres: boolean;
  explication: string;
}

/**
 * REJOUE le plan depuis ses seules entrees stockees et compare octet pour octet avec le resultat stocke. N'ecrit rien.
 * Un rejeu NON identique signale que le code du moteur a change depuis : le resultat stocke reste ce qui a ete decide.
 */
export async function rejouerPlan(client: Client, id: string): Promise<RapportRejeuPpe> {
  const p = await ppe.lirePlan(client, id);
  if (!p) throw new RefusMoteur("INTROUVABLE", "plan pluriannuel introuvable ou supprimé", 404);
  const entreesIntegres = sha256Hex(p.entreesCanoniques) === p.empreinteEntrees;
  let brut: unknown;
  try { brut = JSON.parse(p.entreesCanoniques); } catch { throw new RefusMoteur("ENTREES_ILLISIBLES", "les entrées stockées ne sont pas du JSON", 422); }
  const relu = entreesPpeDepuisJson(brut);
  if (!relu.ok) throw new RefusMoteur("ENTREES_ILLISIBLES", `les entrées stockées sont illisibles : ${relu.erreurs.join(" ; ")}`, 422);
  const r = construirePlan(relu.entrees);
  if (!r.ok) throw new RefusMoteur("ENTREES_ILLISIBLES", `les entrées stockées sont refusées par le moteur : ${r.erreurs.join(" ; ")}`, 422);
  const recalcule = canonique(r.plan);
  const identique = recalcule === p.resultatCanonique;
  return {
    identique, entreesIntegres, empreinteStockee: p.empreinteResultat, empreinteRecalculee: sha256Hex(recalcule),
    explication: identique
      ? "Le rejeu donne le même texte, octet pour octet."
      : "Le rejeu diffère du résultat stocké : le code du moteur n'est plus celui qui a calculé ce plan. Le résultat stocké reste ce qui a été décidé.",
  };
}

export async function supprimerPlan(client: Client, id: string, ctx: Contexte) {
  return client.$transaction(async (tx) => {
    const p = await ppe.lirePlan(tx, id);
    if (!p) throw new RefusMoteur("INTROUVABLE", "plan pluriannuel introuvable ou déjà supprimé", 404);
    await ppe.supprimerPlanLogiquement(tx, id);
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "DELETE", entityType: "PlanPluriannuel", entityId: id,
      after: { supprime: true, anneeDebut: p.anneeDebut, intitule: p.intitule }, ipAddress: ctx.ipAddress,
    });
    return { ok: true as const, id };
  });
}

// ---------------------------------------------------------------------------------------------
// Praticabilite (D-02)
// ---------------------------------------------------------------------------------------------

export interface StatutPraticabilite {
  branchee: boolean;
  valeursDeclarees: number;
  valeursApprouvees: number;
  libelle: string;
  motif: string;
  effet: string;
}

/**
 * Le moteur lit la praticabilite SEULEMENT si une valeur APPROUVEE existe dans `referentiel_praticabilites`.
 * Sinon il le dit (« non branchée : aucune valeur approuvée (D-02) ») et n'invente aucun critere.
 *
 * MEME BRANCHEE, la praticabilite n'ECARTE aucun troncon et ne change aucun rang : l'effet d'un niveau sur le
 * programme (a quel moment P3 ou P4 retire un troncon) est un critere d'attribution que D-02 n'a pas arrete.
 * Branchee veut dire : le moteur LIT la valeur approuvee et SIGNALE les lignes retenues dont une portion courante
 * validee porte un niveau approuve dit non franchissable. Un signal de lecture, pas une regle.
 */
export async function statutPraticabilite(db: depot.Db): Promise<StatutPraticabilite> {
  const l = await ppe.lirePraticabilites(db);
  const actives = l.filter((x) => x.actif);
  const approuvees = actives.filter((x) => x.approuveeLe !== null);
  if (approuvees.length === 0) {
    return {
      branchee: false, valeursDeclarees: actives.length, valeursApprouvees: 0,
      libelle: "non branchée : aucune valeur approuvée (D-02)",
      motif: actives.length === 0
        ? "le référentiel de praticabilité est vide : aucune valeur n'a été déclarée"
        : `${actives.length} valeur(s) déclarée(s), aucune approuvée : une valeur non approuvée ne sert pas au calcul`,
      effet: "Aucun critère n'est inventé : la praticabilité n'influe sur aucun facteur, aucun rang et aucune exclusion.",
    };
  }
  return {
    branchee: true, valeursDeclarees: actives.length, valeursApprouvees: approuvees.length,
    libelle: `branchée en lecture : ${approuvees.length} valeur(s) approuvée(s) (D-02)`,
    motif: "au moins une valeur est approuvée : le moteur la lit et signale les lignes retenues concernées",
    effet: "Signal seulement : aucun tronçon n'est écarté ni reclassé, car le critère d'attribution d'un niveau au programme n'est pas arrêté (D-02).",
  };
}

export interface AlertePraticabilite {
  tronconId: string; code: string; niveau: string; libelle: string; franchissable: boolean; saisonniere: boolean; debutM: number; finM: number;
}

/** Alertes de lecture pour ces troncons : uniquement les niveaux APPROUVES declares NON franchissables. */
export async function alertesPraticabilite(db: depot.Db, tronconIds: string[]): Promise<{ statut: StatutPraticabilite; alertes: AlertePraticabilite[] }> {
  const statut = await statutPraticabilite(db);
  if (!statut.branchee) return { statut, alertes: [] };
  const niveaux = new Map((await ppe.lirePraticabilites(db)).filter((x) => x.actif && x.approuveeLe !== null).map((x) => [x.code, x]));
  const portions = await ppe.portionsAvecPraticabiliteApprouvee(db, tronconIds);
  const alertes: AlertePraticabilite[] = [];
  for (const p of portions) {
    const n = niveaux.get(p.code);
    if (!n || n.franchissable) continue;
    alertes.push({ tronconId: p.tronconId, code: p.code, niveau: n.code, libelle: n.libelle, franchissable: false, saisonniere: n.saisonniere, debutM: p.debutM, finM: p.finM });
  }
  return { statut, alertes };
}

/** Identifiants des troncons RETENUS d'un scenario annuel ou d'un plan (texte canonique stocke). */
export function tronconsRetenusDe(resultat: { lignes?: { decision: string; troncon: { id: string } }[]; annees?: { scenario: { lignes: { decision: string; troncon: { id: string } }[] } }[] }): string[] {
  const lignes = resultat.annees ? resultat.annees.flatMap((a) => a.scenario.lignes) : (resultat.lignes ?? []);
  return [...new Set(lignes.filter((l) => l.decision === "RETENUE").map((l) => l.troncon.id))];
}
