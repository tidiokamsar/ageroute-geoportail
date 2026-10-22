/**
 * SERVICE DU MOTEUR DE PROGRAMMATION (paragraphe 7.7, A22).
 *
 * Ce module orchestre : il lit la base (depot), fait calculer les noyaux, et ecrit. Toute ecriture
 * est une INSERTION ou un UPDATE audite dans la MEME transaction que l'ecriture : une panne d'audit
 * annule l'ecriture (`logAuditTransactionnelle`). Les declencheurs de la base refusent de toute
 * facon la modification d'un scenario fige, d'une fiche ou d'un statut ; les noyaux jugent avant
 * eux pour rendre un message clair.
 *
 * ELLE NE CREE AUCUN ENGAGEMENT. Ni marche, ni contrat, ni ordre de travaux, ni chantier, ni
 * decompte, ni certification de paiement (paragraphe 7.7) : aucun de ces objets n'est touche ici.
 * Les statuts a partir de TRANSMIS ne se saisissent pas : `changerStatutFiche` pose l'origine
 * GEOPORTAIL, et `transiter` refuse le reste.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import { canonique, sha256Hex } from "./canonique";
import { contenuFiche, figer, verifierFiche, type VerdictFiche } from "./fiche.noyau";
import { validerParametres, validerValeurs, versionValide, type ParametresProgrammation } from "./parametres.noyau";
import { MAX_CANDIDATS, construireScenario, entreesDepuisJson, entreesVersJson, type EntreesScenario, type Scenario } from "./scenario.noyau";
import { transiter } from "./cycle-vie.noyau";
import * as depot from "./moteur.depot";

export type Client = Pick<PrismaClient, "$transaction" | "$queryRaw" | "$executeRaw">;

export class RefusMoteur extends Error {
  constructor(public readonly code: string, message: string, public readonly http: 400 | 403 | 404 | 409 | 422 = 409) { super(message); }
}

export interface Contexte { userId: string; email?: string | null; ipAddress?: string }

/** Violation d'unicite (23505) ou d'integrite (23000) remontee par le pilote, quelle que soit l'enveloppe. */
function codeSql(e: unknown): string | null {
  const meta = (e as { meta?: { code?: string } } | null)?.meta;
  if (meta?.code) return meta.code;
  const m = /\b(23\d{3})\b/.exec(String((e as Error | null)?.message ?? ""));
  return m ? m[1] : null;
}
const estUnicite = (e: unknown) => codeSql(e) === "23505" || /duplicate key|unique constraint/i.test(String((e as Error | null)?.message ?? ""));

const ISOLATION = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 } as const;

// ---------------------------------------------------------------------------------------------
// Parametres
// ---------------------------------------------------------------------------------------------

export function parametresApi(l: depot.LigneParametres) {
  return {
    id: l.id, version: l.version, source: l.source, valeurs: l.valeurs, motif: l.motif,
    creeParId: l.creeParId, createdAt: l.createdAt, approuveeLe: l.approuveeLe, approuveeParId: l.approuveeParId,
    provisoire: l.approuveeLe === null,
    etiquette: l.approuveeLe === null ? "PROVISOIRE, non approuvé" : "paramètres approuvés",
  };
}

export async function listerParametres(client: Client) {
  return (await depot.listerParametres(client)).map(parametresApi);
}

export async function creerParametres(client: Client, d: { version: string; valeurs: unknown; motif?: string | null }, ctx: Contexte) {
  if (!versionValide(d.version)) throw new RefusMoteur("VERSION_INVALIDE", "version : 3 a 64 caracteres parmi a-z 0-9 . _ -, commencant par une lettre ou un chiffre", 400);
  const v = validerValeurs(d.valeurs);
  if (!v.ok) throw new RefusMoteur("PARAMETRES_INVALIDES", `valeurs invalides : ${v.erreurs.join(" ; ")}`, 422);
  try {
    return await client.$transaction(async (tx) => {
      const ligne = await depot.insererParametres(tx, { id: randomUUID(), version: d.version, valeursJson: canonique(v.valeurs), motif: d.motif ?? null, creeParId: ctx.userId });
      await logAuditTransactionnelle(tx, {
        userId: ctx.userId, action: "CREATE", entityType: "ParametresProgrammation", entityId: ligne.id,
        after: { version: ligne.version, source: ligne.source, provisoire: true, motif: ligne.motif }, ipAddress: ctx.ipAddress,
      });
      return parametresApi(ligne);
    });
  } catch (e) {
    if (e instanceof RefusMoteur) throw e;
    if (estUnicite(e)) throw new RefusMoteur("VERSION_EXISTANTE", `la version ${d.version} existe deja : une version est immuable, creez-en une nouvelle`, 409);
    throw e;
  }
}

export async function approuverParametres(client: Client, id: string, ctx: Contexte) {
  return client.$transaction(async (tx) => {
    const avant = await depot.lireParametresParId(tx, id);
    if (!avant) throw new RefusMoteur("INTROUVABLE", "version de paramètres introuvable", 404);
    if (avant.approuveeLe) throw new RefusMoteur("DEJA_APPROUVEE", "cette version est déjà approuvée", 409);
    const p = validerParametres({ ...depot.parametresDeLigne(avant), approuveeLe: null, approuveeParId: null });
    if (!p.ok) throw new RefusMoteur("PARAMETRES_INVALIDES", `approuver des paramètres invalides est refusé : ${p.erreurs.join(" ; ")}`, 422);
    const apres = await depot.poserApprobation(tx, id, ctx.userId);
    if (!apres) throw new RefusMoteur("INTROUVABLE", "version de paramètres introuvable", 404);
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "VALIDATE", entityType: "ParametresProgrammation", entityId: id,
      before: { version: avant.version, approuveeLe: null }, after: { version: apres.version, approuveeLe: apres.approuveeLe, approuvePar: ctx.email ?? ctx.userId }, ipAddress: ctx.ipAddress,
    });
    return parametresApi(apres);
  });
}

export async function desapprouverParametres(client: Client, id: string, motif: string, ctx: Contexte) {
  return client.$transaction(async (tx) => {
    const avant = await depot.lireParametresParId(tx, id);
    if (!avant) throw new RefusMoteur("INTROUVABLE", "version de paramètres introuvable", 404);
    if (!avant.approuveeLe) throw new RefusMoteur("NON_APPROUVEE", "cette version n'est pas approuvée : rien à retirer", 409);
    const apres = await depot.poserApprobation(tx, id, null);
    if (!apres) throw new RefusMoteur("INTROUVABLE", "version de paramètres introuvable", 404);
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "UPDATE", entityType: "ParametresProgrammation", entityId: id,
      before: { version: avant.version, approuveeLe: avant.approuveeLe, approuveeParId: avant.approuveeParId },
      after: { version: apres.version, approuveeLe: null, desapprouveeParId: ctx.userId, motif }, ipAddress: ctx.ipAddress,
    });
    return parametresApi(apres);
  });
}

// ---------------------------------------------------------------------------------------------
// Simulations (scenarios)
// ---------------------------------------------------------------------------------------------

export interface DemandeSimulation {
  annee: number;
  intitule: string;
  budgetGnf: bigint;
  regionId?: number | null;
  classe?: string | null;
  plafondsRegionauxGnf?: Record<string, bigint>;
  parametresId?: string | null;
}

export function resumeScenarioApi(s: depot.ResumeScenarioDb) {
  return {
    id: s.id, annee: s.annee, intitule: s.intitule, parametresVersion: s.parametresVersion, parametresId: s.parametresId,
    budgetGnf: s.budgetGnf.toString(), perimetre: s.perimetre, nbRetenues: s.nbRetenues, nbEcartees: s.nbEcartees,
    montantEngageGnf: s.montantEngageGnf.toString(), provisoire: s.provisoire,
    etiquette: s.provisoire ? "PROVISOIRE, non approuvé" : "paramètres et barèmes approuvés",
    empreinteEntrees: s.empreinteEntrees, empreinteResultat: s.empreinteResultat, creeParId: s.creeParId, creeLe: s.creeLe,
  };
}

/** Lit tout ce que le calcul consomme, dans la transaction appelante (un seul instantane de la base). */
export async function chargerEntrees(db: depot.Db, d: DemandeSimulation, parametres: ParametresProgrammation): Promise<EntreesScenario> {
  const candidats = await depot.chargerCandidats(db, { regionId: d.regionId ?? null, classe: d.classe ?? null, limite: MAX_CANDIDATS + 1 });
  if (candidats.length > MAX_CANDIDATS) {
    throw new RefusMoteur("PERIMETRE_TROP_LARGE", `plus de ${MAX_CANDIDATS} tronçons candidats : restreignez le périmètre (région ou classe de route)`, 422);
  }
  return {
    annee: d.annee,
    budgetGnf: d.budgetGnf,
    plafondsRegionauxGnf: d.plafondsRegionauxGnf ?? {},
    parametres,
    candidats,
    baremes: await depot.chargerBaremes(db, d.annee),
    catalogue: await depot.chargerCatalogue(db),
    conditions: await depot.chargerConditions(db),
    matrices: await depot.chargerMatrices(db),
  };
}

/**
 * Quelle version des parametres ? Celle qu'on demande. A defaut : la version APPROUVEE la plus
 * recemment approuvee ; faute d'approbation, l'unique version existante. S'il y a plusieurs
 * versions et aucune approuvee, le moteur ne choisit pas : choisir « la derniere creee » ferait
 * calculer un scenario sous des valeurs que personne n'a designees.
 */
export async function choisirParametres(db: depot.Db, parametresId: string | null | undefined): Promise<depot.LigneParametres> {
  if (parametresId) {
    const l = await depot.lireParametresParId(db, parametresId);
    if (!l) throw new RefusMoteur("PARAMETRES_INTROUVABLES", "version de paramètres introuvable", 422);
    return l;
  }
  const toutes = await depot.listerParametres(db);
  if (toutes.length === 0) throw new RefusMoteur("PARAMETRES_INTROUVABLES", "aucune version de paramètres : le moteur ne calcule pas sans paramètres", 422);
  const approuvees = toutes
    .filter((p) => p.approuveeLe !== null)
    .sort((a, b) => (b.approuveeLe as Date).getTime() - (a.approuveeLe as Date).getTime() || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  if (approuvees.length > 0) return approuvees[0];
  if (toutes.length === 1) return toutes[0];
  throw new RefusMoteur("PARAMETRES_A_PRECISER", `aucune version approuvée et ${toutes.length} versions provisoires (${toutes.map((p) => p.version).join(", ")}) : précisez parametresId`, 422);
}

export async function simuler(client: Client, d: DemandeSimulation, ctx: Contexte) {
  return client.$transaction(async (tx) => {
    const ligneParams = await choisirParametres(tx, d.parametresId);
    const parametres = depot.parametresDeLigne(ligneParams);
    const valides = validerParametres(parametres);
    if (!valides.ok) throw new RefusMoteur("PARAMETRES_INVALIDES", valides.erreurs.join(" ; "), 422);

    const entrees = await chargerEntrees(tx, d, parametres);
    const r = construireScenario(entrees);
    if (!r.ok) throw new RefusMoteur(r.code, r.erreurs.join(" ; "), 422);

    const entreesCanoniques = canonique(entreesVersJson(entrees));
    const resultatCanonique = canonique(r.scenario);
    const perimetre = canonique({
      regionId: d.regionId ?? null, classe: d.classe ?? null,
      plafondsRegionauxGnf: Object.fromEntries(Object.entries(d.plafondsRegionauxGnf ?? {}).map(([k, v]) => [k, v.toString()])),
    });
    const id = randomUUID();
    const resume = await depot.insererScenario(tx, {
      id, annee: d.annee, intitule: d.intitule, parametresId: ligneParams.id, parametresVersion: parametres.version, budgetGnf: d.budgetGnf,
      perimetreJson: perimetre, entreesCanoniques, empreinteEntrees: sha256Hex(entreesCanoniques), resultatCanonique, empreinteResultat: sha256Hex(resultatCanonique),
      nbRetenues: r.scenario.totaux.retenues, nbEcartees: r.scenario.totaux.ecartees, montantEngageGnf: BigInt(r.scenario.totaux.engageGnf),
      provisoire: r.scenario.provisoire, creeParId: ctx.userId,
    });
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "CREATE", entityType: "ScenarioProgrammation", entityId: id,
      after: {
        annee: d.annee, intitule: d.intitule, budgetGnf: d.budgetGnf.toString(), parametresVersion: parametres.version, provisoire: r.scenario.provisoire,
        candidats: r.scenario.totaux.candidats, retenues: r.scenario.totaux.retenues, engageGnf: r.scenario.totaux.engageGnf, empreinteResultat: resume.empreinteResultat,
      },
      ipAddress: ctx.ipAddress,
    });
    return { scenario: resumeScenarioApi(resume), resultat: r.scenario };
  }, ISOLATION);
}

export async function lireScenarioComplet(client: Client, id: string) {
  const s = await depot.lireScenario(client, id);
  if (!s) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou supprimé", 404);
  return { scenario: resumeScenarioApi(s), resultat: JSON.parse(s.resultatCanonique) as Scenario };
}

export interface RapportRejeu {
  identique: boolean;
  empreinteStockee: string;
  empreinteRecalculee: string;
  entreesIntegres: boolean;
  explication: string;
}

/**
 * REJOUE le scenario depuis ses seules entrees stockees (aucune lecture de la base de patrimoine)
 * et compare octet pour octet avec le resultat stocke. N'ecrit rien.
 *
 * Un rejeu NON identique ne veut pas dire que le scenario est faux : cela veut dire que le code du
 * moteur n'est plus celui qui l'a calcule. Le resultat stocke reste ce qui a ete decide.
 */
export async function rejouer(client: Client, id: string): Promise<RapportRejeu> {
  const s = await depot.lireScenario(client, id);
  if (!s) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou supprimé", 404);
  const entreesIntegres = sha256Hex(s.entreesCanoniques) === s.empreinteEntrees;
  let brut: unknown;
  try { brut = JSON.parse(s.entreesCanoniques); } catch { throw new RefusMoteur("ENTREES_ILLISIBLES", "les entrées stockées ne sont pas du JSON", 422); }
  const relu = entreesDepuisJson(brut);
  if (!relu.ok) throw new RefusMoteur("ENTREES_ILLISIBLES", `les entrées stockées sont illisibles : ${relu.erreurs.join(" ; ")}`, 422);
  const r = construireScenario(relu.entrees);
  if (!r.ok) throw new RefusMoteur("ENTREES_ILLISIBLES", `les entrées stockées sont refusées par le moteur : ${r.erreurs.join(" ; ")}`, 422);
  const recalcule = canonique(r.scenario);
  const identique = recalcule === s.resultatCanonique;
  return {
    identique, entreesIntegres,
    empreinteStockee: s.empreinteResultat, empreinteRecalculee: sha256Hex(recalcule),
    explication: identique
      ? "Le rejeu donne le même texte, octet pour octet."
      : "Le rejeu diffère du résultat stocké : le code du moteur n'est plus celui qui a calculé ce scénario. Le résultat stocké reste ce qui a été décidé.",
  };
}

export async function supprimerScenario(client: Client, id: string, ctx: Contexte) {
  return client.$transaction(async (tx) => {
    const s = await depot.lireScenario(tx, id);
    if (!s) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou déjà supprimé", 404);
    const fiches = await depot.fichesDuScenario(tx, id);
    if (fiches.length > 0) throw new RefusMoteur("SCENARIO_UTILISE", `${fiches.length} fiche(s) figée(s) citent ce scénario : il ne se retire pas`, 409);
    await depot.supprimerScenarioLogiquement(tx, id);
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "DELETE", entityType: "ScenarioProgrammation", entityId: id,
      after: { supprimee: true, annee: s.annee, intitule: s.intitule }, ipAddress: ctx.ipAddress,
    });
    return { ok: true as const, id };
  });
}

// ---------------------------------------------------------------------------------------------
// Fiches d'intervention
// ---------------------------------------------------------------------------------------------

export interface DemandeFiches {
  /** Troncons a figer ; absent = toutes les lignes retenues du scenario. */
  tronconIds?: string[];
  sourceFinancement?: string | null;
}

/**
 * Fige les lignes RETENUES d'un scenario en fiches d'intervention : tout ou rien. Une ligne
 * ecartee, inconnue ou deja figee fait refuser l'ensemble (aucune fiche partielle).
 */
export async function figerFiches(client: Client, scenarioId: string, d: DemandeFiches, ctx: Contexte) {
  try {
    return await client.$transaction(async (tx) => {
      const s = await depot.lireScenario(tx, scenarioId);
      if (!s) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou supprimé", 404);
      const resultat = JSON.parse(s.resultatCanonique) as Scenario;
      const relu = entreesDepuisJson(JSON.parse(s.entreesCanoniques));
      if (!relu.ok) throw new RefusMoteur("ENTREES_ILLISIBLES", `les entrées stockées sont illisibles : ${relu.erreurs.join(" ; ")}`, 422);

      const retenues = resultat.lignes.filter((l) => l.decision === "RETENUE");
      let choisies = retenues;
      if (d.tronconIds && d.tronconIds.length > 0) {
        const demandes = [...new Set(d.tronconIds)];
        for (const id of demandes) {
          const ligne = resultat.lignes.find((l) => l.troncon.id === id);
          if (!ligne) throw new RefusMoteur("TRONCON_ABSENT_DU_SCENARIO", `le tronçon ${id} n'est pas dans ce scénario`, 422);
          if (ligne.decision !== "RETENUE") throw new RefusMoteur("LIGNE_NON_RETENUE", `le tronçon ${ligne.troncon.code} est écarté (${ligne.motifExclusion?.code ?? "?"}) : une fiche ne décrit qu'une intervention retenue`, 422);
        }
        choisies = retenues.filter((l) => demandes.includes(l.troncon.id));
      }
      if (choisies.length === 0) throw new RefusMoteur("AUCUNE_LIGNE_RETENUE", "ce scénario ne retient aucune intervention : il n'y a rien à figer", 422);

      const dejaFiges = new Set((await depot.fichesDuScenario(tx, scenarioId)).map((f) => f.tronconId));
      const doublons = choisies.filter((l) => dejaFiges.has(l.troncon.id));
      if (doublons.length > 0) throw new RefusMoteur("FICHE_DEJA_FIGEE", `déjà figé pour ce scénario : ${doublons.map((l) => l.troncon.code).join(", ")}`, 409);

      const creees: { id: string; reference: string; empreinteSha256: string; tronconId: string; code: string }[] = [];
      for (const ligne of choisies) {
        const c = contenuFiche(ligne, resultat, {
          scenarioId, empreinteScenario: s.empreinteResultat, sourceFinancement: d.sourceFinancement ?? null, parametres: relu.entrees.parametres,
        });
        if (!c.ok) throw new RefusMoteur(c.code, c.motif, 422);
        const f = figer(c.contenu);
        const id = randomUUID();
        await depot.insererFiche(tx, {
          id, reference: f.reference, scenarioId, tronconId: ligne.troncon.id, annee: resultat.annee,
          parametresVersion: relu.entrees.parametres.version, contenuCanonique: f.contenuCanonique, empreinteSha256: f.empreinteSha256, figeParId: ctx.userId,
        });
        await depot.insererStatut(tx, { id: randomUUID(), ficheId: id, rang: 1, de: null, vers: "BROUILLON", origine: "GEOPORTAIL", motif: null, auteurId: ctx.userId });
        await logAuditTransactionnelle(tx, {
          userId: ctx.userId, action: "CREATE", entityType: "FicheIntervention", entityId: id,
          after: { reference: f.reference, scenarioId, tronconId: ligne.troncon.id, empreinteSha256: f.empreinteSha256, parametresVersion: relu.entrees.parametres.version, provisoire: resultat.provisoire },
          ipAddress: ctx.ipAddress,
        });
        creees.push({ id, reference: f.reference, empreinteSha256: f.empreinteSha256, tronconId: ligne.troncon.id, code: ligne.troncon.code });
      }
      return { fiches: creees, etiquette: resultat.etiquette, provisoire: resultat.provisoire };
    });
  } catch (e) {
    if (e instanceof RefusMoteur) throw e;
    if (estUnicite(e)) throw new RefusMoteur("FICHE_DEJA_FIGEE", "une fiche identique existe déjà pour ce scénario et ce tronçon", 409);
    throw e;
  }
}

export function ficheCouranteApi(f: depot.LigneFicheCourante) {
  return {
    id: f.id, reference: f.reference, scenarioId: f.scenarioId, tronconId: f.tronconId, annee: f.annee, parametresVersion: f.parametresVersion,
    empreinteSha256: f.empreinteSha256, figeLe: f.figeLe, figeParId: f.figeParId, statut: f.statut, rangStatut: f.rangStatut, statutDepuis: f.statutDepuis,
  };
}

export async function lireFicheComplete(client: Client, id: string) {
  const f = await depot.lireFiche(client, id);
  const courante = f ? await depot.lireFicheCourante(client, id) : null;
  if (!f || !courante) throw new RefusMoteur("INTROUVABLE", "fiche introuvable", 404);
  return {
    fiche: ficheCouranteApi(courante),
    contenu: JSON.parse(f.contenuCanonique) as unknown,
    historique: (await depot.historiqueStatuts(client, id)).map((h) => ({
      rang: h.rang, de: h.de, vers: h.vers, origine: h.origine, motif: h.motif, auteurId: h.auteurId, enregistreLe: h.enregistreLe,
    })),
  };
}

export async function verifierFicheStockee(client: Client, id: string): Promise<{ id: string; reference: string; empreinteStockee: string; verdict: VerdictFiche }> {
  const f = await depot.lireFiche(client, id);
  if (!f) throw new RefusMoteur("INTROUVABLE", "fiche introuvable", 404);
  return { id, reference: f.reference, empreinteStockee: f.empreinteSha256, verdict: verifierFiche(f.contenuCanonique, f.empreinteSha256) };
}

const HTTP_TRANSITION: Record<string, 400 | 403 | 409 | 422> = {
  STATUT_INCONNU: 400, TRANSITION_INEXISTANTE: 409, ORIGINE_INTERDITE: 403,
  MESSAGE_DIGITALROAD_REQUIS: 422, INSPECTION_REQUISE: 422, VERSION_FIGEE_REQUISE: 422, RETOUR_NON_MOTIVE: 400,
};

/**
 * Fait avancer une fiche dans son cycle de vie DEPUIS LE GEOPORTAIL : l'origine est posee ici,
 * jamais lue dans la requete. TRANSMIS, EN_EXECUTION, ACHEVE et EVALUE sont donc refuses
 * (ORIGINE_INTERDITE) : ils sont recus de DigitalRoad ou d'une inspection post-travaux.
 */
export async function changerStatutFiche(client: Client, ficheId: string, vers: string, motif: string | null, ctx: Contexte) {
  try {
    return await client.$transaction(async (tx) => {
      const courante = await depot.lireFicheCourante(tx, ficheId);
      if (!courante) throw new RefusMoteur("INTROUVABLE", "fiche introuvable", 404);
      const v = transiter(courante.statut, vers, { origine: "GEOPORTAIL", motif });
      if (!v.ok) throw new RefusMoteur(v.code, v.motif, HTTP_TRANSITION[v.code] ?? 409);
      await depot.insererStatut(tx, { id: randomUUID(), ficheId, rang: courante.rangStatut + 1, de: courante.statut, vers, origine: "GEOPORTAIL", motif, auteurId: ctx.userId });
      await logAuditTransactionnelle(tx, {
        userId: ctx.userId, action: "UPDATE", entityType: "FicheIntervention", entityId: ficheId,
        before: { statut: courante.statut }, after: { statut: vers, recule: v.recule, motif }, ipAddress: ctx.ipAddress,
      });
      return { id: ficheId, de: courante.statut, vers, recule: v.recule, rang: courante.rangStatut + 1 };
    });
  } catch (e) {
    if (e instanceof RefusMoteur) throw e;
    if (estUnicite(e)) throw new RefusMoteur("CONFLIT_DE_STATUT", "le statut a changé entre-temps : relisez la fiche", 409);
    throw e;
  }
}
