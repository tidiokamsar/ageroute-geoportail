/**
 * SERVICE DE LA PRIORITE TECHNIQUE EXPLICABLE (lot AD-3). Orchestre : lit la base (depot), fait calculer le noyau, met en forme.
 *
 * LECTURE SEULE pour les interventions : aucune table n'est ecrite, aucun troncon, chantier, marche ni budget n'est touche.
 * Les seules ecritures sont celles des PARAMETRES, et elles sont DELEGUEES a `moteur.service` (qui les audite dans la meme
 * transaction) : ce fichier ne contient aucune logique d'approbation.
 *
 * POINT D'ACCROCHE DE LA SEPARATION DES TACHES (lot 7). L'interdiction d'approuver ses propres parametres se pose dans
 * `moteur.service.approuverParametres` (lecture de `creeParId` de la version, refus AUTO_VALIDATION via
 * `governance/validation.ts`). Ce fichier et les routes ne font qu'appeler cette fonction : le jour ou elle refuse, les
 * routes de priorite refusent aussi, sans autre modification. Rien n'est a ajouter ici.
 *
 * LE CLASSEMENT N'EST PAS STOCKE. Il est recalcule a chaque lecture, sur un instantane unique de la base (transaction en
 * lecture repetable), borne a `MAX_CANDIDATS` troncons. Au-dela, la demande est refusee (422) avec la consigne de
 * restreindre le perimetre : pas de classement partiel, qui serait un classement faux.
 */

import { Prisma } from "@prisma/client";
import * as moteurDepot from "./moteur.depot";
import { RefusMoteur, creerParametres, approuverParametres, desapprouverParametres, choisirParametres, parametresApi, type Client, type Contexte } from "./moteur.service";
import { validerBlocPriorite, BLOC_PRIORITE_AMORCAGE, MODELE_PRIORITE, type BlocPriorite } from "./priorite.parametres";
import { CRITERES, FORMULE_PRIORITE_TECHNIQUE, DEFINITION_ARBITRAGE, LIMITES_MODELE, AVERTISSEMENT_CONSULTATIF, ORDRE_EXCLUSIONS, classerInterventions, cleTri, comparerCles, motifDeLaLigne, type LigneClassee, type ResultatPriorite } from "./priorite.noyau";
import * as depot from "./priorite.depot";
import type { FiltresGeo, FiltresListe, FiltresSelection } from "./priorite.requete";
import { encoderCurseur } from "./priorite.requete";
import { TRANSITIONS, ORIGINE_REQUISE, type StatutIntervention } from "./cycle-vie.noyau";
import { MAX_CANDIDATS } from "./scenario.noyau";
import type { ParametresProgrammation } from "./parametres.noyau";

export interface ContexteLecture {
  /** Regions visibles du compte ; `null` = toutes (compte national). */
  regions: readonly number[] | null;
  maintenant: Date;
}

const ISOLATION = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000, maxWait: 10_000 } as const;

const dateIso = (d: Date): string => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Classement d'un perimetre
// ---------------------------------------------------------------------------------------------

interface Classement {
  resultat: ResultatPriorite;
  ligneParametres: moteurDepot.LigneParametres;
  dansBbox: Set<string>;
}

/** Une transaction en lecture repetable : un seul instantane pour les parametres, les faits et les baremes. */
async function dansUnInstantane<T>(client: Client, fn: (tx: moteurDepot.Db) => Promise<T>): Promise<T> {
  return client.$transaction((tx) => fn(tx as unknown as moteurDepot.Db), ISOLATION);
}

async function classerPerimetre(tx: moteurDepot.Db, ctx: ContexteLecture, f: FiltresSelection & { bbox?: FiltresGeo["bbox"] }): Promise<Classement> {
  const ligneParametres = await choisirParametres(tx, f.parametresId ?? null);
  const parametres: ParametresProgrammation = moteurDepot.parametresDeLigne(ligneParametres);
  const dateReference = dateIso(ctx.maintenant);
  const { faits, dansBbox } = await depot.chargerFaits(tx, {
    regions: ctx.regions, regionId: f.regionId, classe: f.classe, etat: f.etat, depuis: f.depuis, jusqua: f.jusqua,
    dateReference, limite: MAX_CANDIDATS + 1, bbox: f.bbox,
  });
  if (faits.length > MAX_CANDIDATS) {
    throw new RefusMoteur("PERIMETRE_TROP_LARGE", `plus de ${MAX_CANDIDATS} tronçons candidats : restreignez le périmètre (région, classe de route ou état)`, 422);
  }
  const annee = ctx.maintenant.getUTCFullYear();
  const r = classerInterventions({
    dateReference, parametres, candidats: faits,
    baremes: await moteurDepot.chargerBaremes(tx, annee),
    catalogue: await moteurDepot.chargerCatalogue(tx),
    conditions: await moteurDepot.chargerConditions(tx),
    matrices: await moteurDepot.chargerMatrices(tx),
    validitesBaremes: await depot.chargerValiditesBaremes(tx),
  });
  if (!r.ok) throw new RefusMoteur(r.code, r.erreurs.join(" ; "), 422);
  return { resultat: r.resultat, ligneParametres, dansBbox };
}

// ---------------------------------------------------------------------------------------------
// Description du modele (rendue avec chaque reponse : l'ecran n'a rien a supposer)
// ---------------------------------------------------------------------------------------------

export function decrireModele(r: ResultatPriorite) {
  const bloc = r.parametres.bloc;
  return {
    id: r.modele.id, version: r.modele.version,
    formule: FORMULE_PRIORITE_TECHNIQUE,
    arbitrage: DEFINITION_ARBITRAGE,
    criteres: CRITERES.map((c) => {
      const poids = c.role === "PRIORITE_TECHNIQUE" ? bloc.poids[c.code as keyof BlocPriorite["poids"]] : null;
      return { ...c, poids, ponderee: poids !== null && poids > 0 };
    }),
    regles: {
      criteresEssentiels: ["ETAT_GRAVITE"],
      exclusions: [...ORDRE_EXCLUSIONS],
      couvertureMinimale: bloc.couvertureMinimale,
      registrePointsNoirsMinimum: bloc.registrePointsNoirsMinimum,
      urgenceAnciennetePlafondJours: bloc.urgenceAnciennetePlafondJours,
    },
    limites: [...LIMITES_MODELE],
  };
}

function enteteParametres(c: Classement) {
  const r = c.resultat;
  return {
    id: c.ligneParametres.id, version: r.parametres.version, source: r.parametres.source,
    auteurId: c.ligneParametres.creeParId, creeLe: c.ligneParametres.createdAt, motif: c.ligneParametres.motif,
    approuveeLe: r.parametres.approuveeLe, approuveeParId: r.parametres.approuveeParId, etiquette: r.parametres.etiquette,
    blocOrigine: r.parametres.blocOrigine, validite: r.parametres.validite,
  };
}

/** Echo des filtres recus, et de ceux qui ne s'appliquent pas (dits, jamais ignores en silence). */
function echoFiltres(f: FiltresSelection) {
  const { statutChantier, ...appliques } = f;
  const nonAppliques = statutChantier && statutChantier.length > 0
    ? [{ filtre: "statutChantier", valeurs: statutChantier, raison: "aucun lien structure entre une intervention candidate et un chantier : ce filtre ne peut pas etre applique" }]
    : [];
  return { appliques: JSON.parse(JSON.stringify(appliques)) as Record<string, unknown>, nonAppliques };
}

// ---------------------------------------------------------------------------------------------
// GET /interventions
// ---------------------------------------------------------------------------------------------

const statutScoreDe = (l: LigneClassee): "CALCULE" | "INCOMPLET" | "EXCLU" => l.prioriteTechnique.statut;

export async function listerInterventions(client: Client, ctx: ContexteLecture, f: FiltresListe) {
  const c = await dansUnInstantane(client, (tx) => classerPerimetre(tx, ctx, f));
  const r = c.resultat;
  if (f.curseur && f.curseur.v !== r.parametres.version) {
    throw new RefusMoteur("CURSEUR_INCOMPATIBLE", "curseur : il vient d'un classement calculé avec une autre version de paramètres ; repartez de la première page", 400);
  }
  // Filtre d'AFFICHAGE : les rangs sont ceux de la selection complete, ils ne bougent pas.
  const visibles = f.statutScore && f.statutScore.length > 0 ? r.lignes.filter((l) => f.statutScore!.includes(statutScoreDe(l))) : r.lignes;
  const apres = f.curseur ? visibles.filter((l) => comparerCles(cleTri(l), { g: f.curseur!.g, s: f.curseur!.s, c: f.curseur!.c, i: f.curseur!.i }) > 0) : visibles;
  const page = apres.slice(0, f.limite);
  const aSuivant = apres.length > page.length;
  const dernier = page[page.length - 1];
  const prochain = aSuivant && dernier ? encoderCurseur({ v: r.parametres.version, ...cleTri(dernier) }) : null;
  const { appliques, nonAppliques } = echoFiltres(f);
  return {
    data: page,
    page: { limite: f.limite, prochainCurseur: prochain, aSuivant },
    // Total de la SELECTION du compte (son perimetre, filtres compris), jamais un total national pour un compte regional.
    total: r.lignes.length,
    totalAffiche: visibles.length,
    resume: r.resume,
    perimetre: { national: ctx.regions === null, regions: ctx.regions === null ? null : [...ctx.regions] },
    filtres: { appliques, nonAppliques },
    modele: decrireModele(r),
    parametres: enteteParametres(c),
    dateReference: r.dateReference,
    provisoire: r.provisoire,
    motifsProvisoire: r.motifsProvisoire,
    avertissement: AVERTISSEMENT_CONSULTATIF,
    empreinte: r.empreinte,
  };
}

// ---------------------------------------------------------------------------------------------
// GET /interventions.geojson
// ---------------------------------------------------------------------------------------------

export const ORDRE_PLAFONNEMENT =
  "Au-dela du plafond, on garde les interventions dans l'ordre de la priorite technique (rang croissant), puis les non classees (par motif, code, identifiant) : la carte montre d'abord ce qui prime.";

export async function interventionsGeoJson(client: Client, ctx: ContexteLecture, f: FiltresGeo) {
  const { c, dansLaZone, horsGeometrie, features } = await dansUnInstantane(client, async (tx) => {
    const cl = await classerPerimetre(tx, ctx, f);
    // Une intervention sans geometrie exploitable n'est PAS un objet de la carte : elle reste dans la liste, avec un avertissement.
    const zone = cl.resultat.lignes.filter((l) => l.localisation === "valide" && cl.dansBbox.has(l.id));
    const retenues = zone.slice(0, f.limite);
    const [o, , e] = f.bbox;
    // Une tolerance d'environ un pixel pour une carte de 2 000 pixels de large, jamais sous 2 x 10^-5 degres (environ 2 m).
    const tolerance = Math.max((e - o) / 2000, 0.00002);
    const geometries = await depot.chargerGeometries(tx, retenues.map((l) => l.id), tolerance);
    const feats = retenues.flatMap((l) => {
      const geometry = geometries.get(l.id);
      if (!geometry) return [];
      const p = l.prioriteTechnique;
      return [{
        type: "Feature" as const,
        id: l.id,
        geometry,
        properties: {
          id: l.id, code: l.objet.code, nom: l.objet.nom, rang: p.rang, score: p.score, scoreIncomplet: p.scoreIncomplet, statutScore: p.statut,
          etatPhysique: l.etatPhysique, classe: l.classe, regionId: l.regionId, couverture: p.couverture, rangArbitrage: l.ordreArbitrage.rang,
        },
      }];
    });
    return { c: cl, dansLaZone: zone, horsGeometrie: cl.resultat.lignes.filter((l) => l.localisation === "invalide").length, features: feats };
  });
  const r = c.resultat;
  return {
    type: "FeatureCollection" as const,
    features,
    total: dansLaZone.length,
    tronque: dansLaZone.length > f.limite,
    limite: f.limite,
    ordrePlafonnement: ORDRE_PLAFONNEMENT,
    bbox: f.bbox,
    // Combien d'interventions de la selection n'ont pas de geometrie exploitable : elles restent dans la liste.
    horsGeometrie,
    selection: r.lignes.length,
    filtres: echoFiltres(f),
    parametresVersion: r.parametres.version,
    provisoire: r.provisoire,
    motifsProvisoire: r.motifsProvisoire,
    avertissement: AVERTISSEMENT_CONSULTATIF,
    dateReference: r.dateReference,
    empreinte: r.empreinte,
  };
}

// ---------------------------------------------------------------------------------------------
// GET /interventions/:id
// ---------------------------------------------------------------------------------------------

const ACTIONS_NON_SUPPORTEES = ["examiner", "affecter", "proposer_a_la_programmation", "reporter", "rejeter"] as const;

const RAISON_ACTIONS =
  "Aucun workflow n'existe pour une intervention candidate : le cycle de vie du moteur (BROUILLON, PROPOSE, ARBITRE, APPROUVE) ne s'applique qu'aux fiches figees depuis un scenario retenu. Examiner, affecter, reporter et rejeter avec motif ne sont pas implementes ; aucune action fictive n'est offerte.";

export async function detailIntervention(client: Client, ctx: ContexteLecture, id: string, o: { parametresId?: string } = {}) {
  const { c, ligne, fiches, statuts, versions } = await dansUnInstantane(client, async (tx) => {
    const cl = await classerPerimetre(tx, ctx, { parametresId: o.parametresId });
    const l = cl.resultat.lignes.find((x) => x.id === id);
    if (!l) throw new RefusMoteur("INTROUVABLE", "intervention introuvable", 404);
    const fs = await depot.fichesDuTroncon(tx, id);
    return { c: cl, ligne: l, fiches: fs.fiches, statuts: fs.statuts, versions: await moteurDepot.listerParametres(tx) };
  });
  const r = c.resultat;
  const decisions = statuts.map((s) => ({
    ficheId: s.ficheId, rang: s.rang, de: s.de, vers: s.vers, origine: s.origine, motif: s.motif, auteurId: s.auteurId, enregistreLe: s.enregistreLe,
  }));
  return {
    intervention: ligne,
    motif: motifDeLaLigne(ligne, r.resume.classes),
    limites: [...LIMITES_MODELE],
    modele: decrireModele(r),
    parametres: enteteParametres(c),
    fiches: fiches.map((f) => ({
      id: f.id, reference: f.reference, scenarioId: f.scenarioId, annee: f.annee, parametresVersion: f.parametresVersion, statut: f.statut, rangStatut: f.rangStatut,
      statutDepuis: f.statutDepuis, figeLe: f.figeLe, figeParId: f.figeParId,
      // Ce que le Geoportail peut faire avancer lui-meme (les statuts recus de DigitalRoad ne se saisissent pas ; un recul exige un motif).
      transitionsPossibles: (TRANSITIONS[f.statut as StatutIntervention] ?? []).filter((v) => ORIGINE_REQUISE[v] === "GEOPORTAIL"),
    })),
    historique: {
      recalculs: { disponible: false, raison: "le classement est calculé à la volée et n'est pas enregistré : aucun historique de recalcul n'existe. L'empreinte permet de vérifier qu'un classement se reproduit à l'identique." },
      decisions,
      parametres: versions.map((v) => ({ version: v.version, creeLe: v.createdAt, auteurId: v.creeParId, approuveeLe: v.approuveeLe, approuveeParId: v.approuveeParId, utilisee: v.id === c.ligneParametres.id })),
    },
    actions: { disponibles: [] as string[], nonDisponibles: [...ACTIONS_NON_SUPPORTEES], raison: RAISON_ACTIONS },
    provisoire: r.provisoire,
    motifsProvisoire: r.motifsProvisoire,
    avertissement: AVERTISSEMENT_CONSULTATIF,
    dateReference: r.dateReference,
    empreinte: r.empreinte,
  };
}

// ---------------------------------------------------------------------------------------------
// Parametres de priorite : delegues au mecanisme du moteur
// ---------------------------------------------------------------------------------------------

export function parametresPrioriteApi(l: moteurDepot.LigneParametres) {
  const base = parametresApi(l);
  const brut = (l.valeurs as { priorite?: unknown } | null)?.priorite;
  const bloc = brut === undefined ? null : validerBlocPriorite(brut);
  return {
    ...base,
    modeleVersion: `${MODELE_PRIORITE}.1`,
    priorite: bloc === null
      ? { present: false, origine: "AMORCAGE_CODE" as const, bloc: structuredClone(BLOC_PRIORITE_AMORCAGE), raison: "cette version ne porte pas de bloc de priorité : le calcul utilise les valeurs d'amorçage du code (provisoires, sans source)" }
      : bloc.ok
        ? { present: true, origine: "VERSION" as const, bloc: bloc.bloc, raison: null }
        : { present: true, origine: "VERSION" as const, bloc: null, raison: `bloc de priorité invalide : ${bloc.erreurs.join(" ; ")}` },
  };
}

export async function listerParametresPriorite(client: Client) {
  return (await moteurDepot.listerParametres(client)).map(parametresPrioriteApi);
}

export interface DemandeParametresPriorite {
  version: string;
  motif?: string | null;
  /** Version dont on reprend les valeurs du RISQUE (poids, plafonds...). Absente : la version que le moteur choisirait. */
  baseParametresId?: string | null;
  /** Surcharges du bloc de priorite ; le reste vient de l'amorcage. */
  priorite: Partial<Omit<BlocPriorite, "modele" | "poids">> & { poids?: Partial<BlocPriorite["poids"]> };
}

/**
 * Cree une NOUVELLE version (provisoire) : valeurs du risque d'une version de base + bloc de priorite. Delegue a
 * `creerParametres` du moteur, qui valide tout (y compris le bloc), fait l'audit CREATE dans la meme transaction et refuse
 * une version existante (une version est immuable).
 */
export async function creerParametresPriorite(client: Client, d: DemandeParametresPriorite, ctx: Contexte) {
  const base = await choisirParametres(client, d.baseParametresId ?? null);
  const { priorite: _ancien, ...valeursRisque } = base.valeurs as Record<string, unknown>;
  void _ancien;
  const bloc: BlocPriorite = {
    ...structuredClone(BLOC_PRIORITE_AMORCAGE),
    ...(d.priorite as Partial<BlocPriorite>),
    modele: MODELE_PRIORITE,
    poids: { ...BLOC_PRIORITE_AMORCAGE.poids, ...(d.priorite.poids ?? {}) },
  };
  const cree = await creerParametres(client, { version: d.version, valeurs: { ...valeursRisque, priorite: bloc }, motif: d.motif ?? null }, ctx);
  return { ...cree, modeleVersion: `${MODELE_PRIORITE}.1`, priorite: { present: true, origine: "VERSION" as const, bloc, raison: null }, baseVersion: base.version };
}

async function exigerBloc(client: Client, id: string): Promise<void> {
  const l = await moteurDepot.lireParametresParId(client, id);
  if (!l) throw new RefusMoteur("INTROUVABLE", "version de paramètres introuvable", 404);
  if ((l.valeurs as { priorite?: unknown } | null)?.priorite === undefined) {
    throw new RefusMoteur("BLOC_PRIORITE_ABSENT", "cette version ne porte pas de bloc de priorité : l'approuver ici n'aurait pas de sens (créez une version avec POST /priorites/parametres)", 409);
  }
}

/** Approuver une version approuve TOUTES ses valeurs (risque et priorite) : elles forment un seul enregistrement immuable. */
export async function approuverParametresPriorite(client: Client, id: string, ctx: Contexte) {
  await exigerBloc(client, id);
  return approuverParametres(client, id, ctx);
}

export async function desapprouverParametresPriorite(client: Client, id: string, motif: string, ctx: Contexte) {
  await exigerBloc(client, id);
  return desapprouverParametres(client, id, motif, ctx);
}

export { RefusMoteur };
