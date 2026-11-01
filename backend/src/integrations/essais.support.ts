/**
 * OUTILS DE TEST COMMUNS (non lance par Vitest : pas de `.test.ts` dans le nom).
 *
 * Tout ce qui est construit ici sert a verifier NOTRE code contre des simulateurs ECRITS PAR
 * AGEROUTE. Rien n'atteint un systeme reel.
 */
import { lireConfigIntegrations, type ConfigIntegrations } from "./config";
import { creerAdaptateurs } from "./adaptateurs";
import { depotMemoire, type DepotMemoire } from "./outbox.depot.memoire";
import type { DepsOutbox } from "./outbox.service";
import type { LecteurSources, LectureSource } from "./sources.depot";
import {
  chargeBulletin, chargeFiche, chargePivotOuvrage, chargePivotPortion, chargePivotTroncon,
  empreinteTexte, type SnapshotFiche,
} from "./sources.noyau";
import { fetchBoucleLocale, demarrerSimulateur, type FetchSurveille, type Simulateur } from "./simulateurs/simulateur";
import type { Destination } from "./types";

export const JETON_DE_TEST = "jeton-de-test-0123456789";
export const CHEMIN_DE_TEST = "/entrees/test";

/** Variables d'environnement qui activent les trois destinations vers des simulateurs locaux. */
export function envPour(simulateurs: Partial<Record<Destination, Simulateur>>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { INTEGRATIONS_SORTANTES_ACTIVES: "true", OUTBOX_DELAI_BASE_MS: "1000", ...extra };
  for (const [dest, sim] of Object.entries(simulateurs)) {
    env[`OUTBOX_${dest}_ACTIF`] = "true";
    env[`OUTBOX_${dest}_URL`] = sim.url;
    env[`OUTBOX_${dest}_CHEMIN`] = CHEMIN_DE_TEST;
    env[`OUTBOX_${dest}_JETON`] = JETON_DE_TEST;
    // Large : sous la charge de la CI, un delai serre ferait echouer un appel normal. Les tests qui
    // PROVOQUENT un delai depasse utilisent `adaptateursRapides`.
    env[`OUTBOX_${dest}_TIMEOUT_MS`] = env[`OUTBOX_${dest}_TIMEOUT_MS`] ?? "3000";
  }
  return env;
}

/** Adaptateurs au delai court, pour les seuls tests qui provoquent un delai depasse (le serveur ne repond jamais). */
export function adaptateursRapides(simulateurs: Partial<Record<Destination, Simulateur>>, fetchImpl: FetchSurveille, ms = 250) {
  const extra: Record<string, string> = {};
  for (const d of Object.keys(simulateurs)) extra[`OUTBOX_${d}_TIMEOUT_MS`] = String(ms);
  return creerAdaptateurs(lireConfigIntegrations(envPour(simulateurs, extra)), fetchImpl);
}

export async function simulateursDeTest(destinations: Destination[] = ["DIGITALROAD", "SHAREPOINT", "BDR_L2R"]): Promise<Partial<Record<Destination, Simulateur>>> {
  const sortie: Partial<Record<Destination, Simulateur>> = {};
  for (const destination of destinations) sortie[destination] = await demarrerSimulateur({ destination, jeton: JETON_DE_TEST, chemin: CHEMIN_DE_TEST });
  return sortie;
}

/* ------------------------------- Sources en memoire ------------------------------- */

export interface SourceFictive {
  emissible: boolean;
  motif?: string;
  charge?: unknown;
}

export interface LecteurSourcesMemoire extends LecteurSources {
  sources: Map<string, SourceFictive>;
  lectures: string[];
  poser(sourceType: string, sourceId: string, s: SourceFictive): void;
}

export function lecteurSourcesMemoire(): LecteurSourcesMemoire {
  const sources = new Map<string, SourceFictive>();
  const lectures: string[] = [];
  return {
    sources, lectures,
    poser: (t, id, s) => { sources.set(`${t}:${id}`, s); },
    async lire(_destination, sourceType, sourceId): Promise<LectureSource> {
      lectures.push(`${sourceType}:${sourceId}`);
      const s = sources.get(`${sourceType}:${sourceId}`);
      if (!s) return { emissible: false, code: "SOURCE_INCONNUE", motif: `${sourceType} ${sourceId} introuvable` };
      if (!s.emissible) return { emissible: false, code: "SOURCE_NON_EMISSIBLE", motif: s.motif ?? "non emissible" };
      return { emissible: true, charge: s.charge };
    },
  };
}

/* --------------------------------- Charges d'exemple --------------------------------- */

export const LIGNE_TRACE = { type: "LineString", coordinates: [[-13.6, 9.64], [-13.58, 9.65]] };

export function chargeTroncon(id = "t-1", surcharge: Partial<{ longueurKm: number; nom: string }> = {}) {
  const c = chargePivotTroncon({
    id, code: "RN1-001", nom: surcharge.nom ?? "Conakry - Coyah", classe: "RN", longueurKm: surcharge.longueurKm ?? 2.5,
    revetement: "BITUME", etat: "BON", regionNom: "Conakry", dateDerniereEvaluation: "2026-10-01", geometrie: LIGNE_TRACE,
  });
  if (!c.ok) throw new Error(c.motif);
  return c.charge;
}

export function chargeOuvrage(id = "o-1") {
  const c = chargePivotOuvrage({ id, code: "RN1-PONT-12.4", nom: "Pont de la Fatala", type: "PONT", etat: "BON", pk: 12.4, tronconCode: "RN1-001", geometrie: { type: "Point", coordinates: [-13.6, 9.64] } });
  if (!c.ok) throw new Error(c.motif);
  return c.charge;
}

export function chargePortion(id = "p-1") {
  const c = chargePivotPortion({
    id, tronconId: "t-1", tronconCode: "RN1-001", debutM: 0, finM: 500, etat: "BON", revetement: "BITUME", praticabilite: null,
    valideDu: "2026-01-01", valideAu: null, observeeLe: "2026-09-30T08:00:00Z", geometrie: null,
  });
  if (!c.ok) throw new Error(c.motif);
  return c.charge;
}

export function chargeBulletinExemple(numero = "BR-20261024-1") {
  const texte = "Bulletin routier du 24/10/2026\nRN1 : circulation normale.";
  const c = chargeBulletin({ id: "b-1", numero, jour: "2026-10-24", texte, empreinteSha256: empreinteTexte(texte) });
  if (!c.ok) throw new Error(c.motif);
  return c.charge;
}

export const FICHE_APPROUVEE: SnapshotFiche = {
  id: "fiche-2027-001",
  versionFigee: "a".repeat(64),
  statut: "APPROUVE",
  identifiantsPatrimoniaux: [{ typeObjet: "troncon", identifiant: "t-1", codeEchange: null }, { typeObjet: "ouvrage", identifiant: "o-1", codeEchange: "RN1-PONT-12.4" }],
  plageLineaire: { debutM: 0, finM: 500 },
  traitement: { code: "REHAB", libelle: "Rehabilitation" },
  quantites: [{ valeur: 500, unite: "m" }],
  coutEstime: { montantGnf: "2400000000", classePrecision: "ESTIMATION_RESEAU" },
  score: 0.82,
  justification: "Etat MAUVAIS sur 500 m, trafic eleve.",
  annee: 2027,
  sourceFinancement: "BUDGET_NATIONAL",
};

export function chargeFicheExemple() {
  const c = chargeFiche(FICHE_APPROUVEE);
  if (!c.ok) throw new Error(c.motif);
  return c.charge;
}

/* ---------------------------------- Assemblage ---------------------------------- */

export interface BancDeTest {
  deps: DepsOutbox;
  depot: DepotMemoire;
  sources: LecteurSourcesMemoire;
  simulateurs: Partial<Record<Destination, Simulateur>>;
  fetch: FetchSurveille;
  config: ConfigIntegrations;
  /** Horloge pilotable. */
  horloge: { maintenant: Date; avancer(ms: number): void };
  fermer(): Promise<void>;
}

/** Banc complet : trois simulateurs loopback, depot memoire, horloge pilotable, `fetch` surveille. */
export async function bancDeTest(extraEnv: Record<string, string> = {}, travailleur = "w-test"): Promise<BancDeTest> {
  const simulateurs = await simulateursDeTest();
  const config = lireConfigIntegrations(envPour(simulateurs, extraEnv));
  const fetchSurveille = fetchBoucleLocale();
  const depot = depotMemoire();
  const sources = lecteurSourcesMemoire();
  const horloge = {
    maintenant: new Date("2026-10-24T08:00:00.000Z"),
    avancer(ms: number) { this.maintenant = new Date(this.maintenant.getTime() + ms); },
  };
  const deps: DepsOutbox = {
    depot, sources, adaptateurs: creerAdaptateurs(config, fetchSurveille),
    politique: config.politique, verrouMs: config.verrouMs, horloge: () => horloge.maintenant, travailleur,
  };
  return {
    deps, depot, sources, simulateurs, fetch: fetchSurveille, config, horloge,
    fermer: async () => { for (const s of Object.values(simulateurs)) await s?.fermer(); },
  };
}
