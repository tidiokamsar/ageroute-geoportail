/**
 * CONFIGURATION DES ADAPTATEURS SORTANTS. LUE DANS L'ENVIRONNEMENT, JAMAIS ECRITE NULLE PART.
 *
 * TOUT EST DESACTIVE PAR DEFAUT, ET AUCUNE VALEUR PAR DEFAUT N'ACTIVE UN ENVOI REEL
 *
 * Une destination n'est active que si les CINQ conditions sont reunies :
 *
 *   1. INTEGRATIONS_SORTANTES_ACTIVES=true            (interrupteur general)
 *   2. OUTBOX_<DEST>_ACTIF=true                       (la destination, nommement)
 *   3. OUTBOX_<DEST>_URL                              (base, https ; http seulement vers la boucle locale)
 *   4. OUTBOX_<DEST>_CHEMIN                           (chemin d'appel : A CONFIRMER, donc sans defaut)
 *   5. OUTBOX_<DEST>_JETON                            (secret, jamais journalise)
 *
 * <DEST> vaut DIGITALROAD, SHAREPOINT ou BDR_L2R. L'URL, le chemin et le jeton n'ont AUCUNE
 * valeur par defaut : le depot ne connait ni l'adresse, ni le chemin, ni le mecanisme
 * d'authentification de ces systemes (B-11, B-12). Une valeur par defaut serait une adresse
 * inventee, et l'inventer reviendrait a decider ou partent les donnees.
 *
 * LE JETON est enveloppe dans `Secret` : il ne sort ni par JSON.stringify, ni par console.log,
 * ni par String(). Il n'est lisible que par `valeur()`, appelee par le seul transport.
 *
 * Reglages de reprise (valeurs par defaut sures, modifiables) :
 *   OUTBOX_TENTATIVES_MAX (8), OUTBOX_DELAI_BASE_MS (30000), OUTBOX_DELAI_PLAFOND_MS (3600000),
 *   OUTBOX_VERROU_MS (120000), OUTBOX_LOT_MAX (20), OUTBOX_<DEST>_TIMEOUT_MS (10000).
 * Une valeur illisible n'arrete rien : elle est ignoree, remplacee par la valeur par defaut, et
 * signalee dans `avertissements`.
 */
import { inspect } from "node:util";
import { DESTINATIONS, type Destination } from "./types";
import { POLITIQUE_PAR_DEFAUT, type PolitiqueReprise } from "./etat.noyau";

export class Secret {
  readonly #valeur: string;
  constructor(valeur: string) { this.#valeur = valeur; }
  /** Reserve au transport. */
  valeur(): string { return this.#valeur; }
  toJSON(): string { return "[SECRET]"; }
  toString(): string { return "[SECRET]"; }
  [inspect.custom](): string { return "[SECRET]"; }
}

export interface ConfigDestination {
  destination: Destination;
  actif: boolean;
  /** Pourquoi la destination est inactive ; nul si elle est active. */
  raison: string | null;
  baseUrl: string | null;
  chemin: string | null;
  jeton: Secret | null;
  timeoutMs: number;
}

export interface ConfigIntegrations {
  interrupteurGeneral: boolean;
  destinations: Record<Destination, ConfigDestination>;
  politique: PolitiqueReprise;
  verrouMs: number;
  lotMax: number;
  avertissements: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const HOTES_BOUCLE = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TIMEOUT_DEFAUT_MS = 10_000;

function vrai(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().toLowerCase() === "true";
}

function entier(env: Env, nom: string, defaut: number, min: number, max: number, avert: string[]): number {
  const brut = env[nom];
  if (brut === undefined || brut.trim() === "") return defaut;
  const n = Number(brut);
  if (!Number.isInteger(n) || n < min || n > max) {
    avert.push(`${nom}=${JSON.stringify(brut)} ignore (entier entre ${min} et ${max} attendu) : ${defaut} retenu`);
    return defaut;
  }
  return n;
}

/** Valide l'URL de base. Rend l'URL normalisee (sans barre finale) ou le motif du refus. */
export function verifierUrlBase(brut: string): { ok: true; url: string } | { ok: false; motif: string } {
  let u: URL;
  try { u = new URL(brut); } catch { return { ok: false, motif: "URL illisible" }; }
  if (u.username || u.password) return { ok: false, motif: "l'URL ne doit porter aucun identifiant (le jeton se donne a part)" };
  if (u.search || u.hash) return { ok: false, motif: "l'URL de base ne porte ni requete ni fragment" };
  const boucle = HOTES_BOUCLE.has(u.hostname);
  if (u.protocol === "https:") return { ok: true, url: brut.replace(/\/+$/, "") };
  if (u.protocol === "http:" && boucle) return { ok: true, url: brut.replace(/\/+$/, "") };
  return { ok: false, motif: u.protocol === "http:" ? "http refuse hors de la boucle locale (https exige)" : `protocole ${u.protocol} refuse` };
}

function lireDestination(env: Env, destination: Destination, general: boolean, avert: string[]): ConfigDestination {
  const p = `OUTBOX_${destination}_`;
  const timeoutMs = entier(env, `${p}TIMEOUT_MS`, TIMEOUT_DEFAUT_MS, 100, 120_000, avert);
  const base: ConfigDestination = { destination, actif: false, raison: null, baseUrl: null, chemin: null, jeton: null, timeoutMs };

  const refus = (raison: string): ConfigDestination => ({ ...base, raison });
  if (!general) return refus("interrupteur general INTEGRATIONS_SORTANTES_ACTIVES absent ou different de true");
  if (!vrai(env[`${p}ACTIF`])) return refus(`destination non activee (${p}ACTIF different de true)`);

  const urlBrute = env[`${p}URL`]?.trim();
  if (!urlBrute) return refus(`${p}URL absente : aucune adresse par defaut`);
  const url = verifierUrlBase(urlBrute);
  if (!url.ok) return refus(`${p}URL refusee : ${url.motif}`);

  const chemin = env[`${p}CHEMIN`]?.trim();
  if (!chemin) return refus(`${p}CHEMIN absent : le chemin d'appel est a confirmer, sans valeur par defaut`);
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(chemin) || chemin.includes("//") || chemin.includes("..")) {
    return refus(`${p}CHEMIN refuse : commence par /, caracteres usuels d'un chemin seulement`);
  }

  const jeton = env[`${p}JETON`];
  if (!jeton || jeton.trim() === "") return refus(`${p}JETON absent`);

  return { destination, actif: true, raison: null, baseUrl: url.url, chemin, jeton: new Secret(jeton.trim()), timeoutMs };
}

export function lireConfigIntegrations(env: Env = process.env): ConfigIntegrations {
  const avertissements: string[] = [];
  const general = vrai(env.INTEGRATIONS_SORTANTES_ACTIVES);

  const destinations = Object.fromEntries(
    DESTINATIONS.map((d) => [d, lireDestination(env, d, general, avertissements)]),
  ) as Record<Destination, ConfigDestination>;

  const delaiBaseMs = entier(env, "OUTBOX_DELAI_BASE_MS", POLITIQUE_PAR_DEFAUT.delaiBaseMs, 1_000, 3_600_000, avertissements);
  let delaiPlafondMs = entier(env, "OUTBOX_DELAI_PLAFOND_MS", POLITIQUE_PAR_DEFAUT.delaiPlafondMs, 1_000, 86_400_000, avertissements);
  if (delaiPlafondMs < delaiBaseMs) {
    avertissements.push(`OUTBOX_DELAI_PLAFOND_MS (${delaiPlafondMs}) inferieur a OUTBOX_DELAI_BASE_MS (${delaiBaseMs}) : plafond releve`);
    delaiPlafondMs = delaiBaseMs;
  }
  const tentativesMax = entier(env, "OUTBOX_TENTATIVES_MAX", POLITIQUE_PAR_DEFAUT.tentativesMax, 1, 50, avertissements);

  // Un verrou plus court que deux delais d'attente laisserait un second travailleur reprendre un
  // evenement dont le premier attend encore la reponse : le verrou doit durer plus que l'attente.
  const plusLongTimeout = Math.max(...Object.values(destinations).map((c) => c.timeoutMs));
  let verrouMs = entier(env, "OUTBOX_VERROU_MS", 120_000, 1_000, 3_600_000, avertissements);
  if (verrouMs < 2 * plusLongTimeout) {
    avertissements.push(`OUTBOX_VERROU_MS (${verrouMs}) inferieur a deux fois le plus long delai d'attente : ${2 * plusLongTimeout} retenu`);
    verrouMs = 2 * plusLongTimeout;
  }
  const lotMax = entier(env, "OUTBOX_LOT_MAX", 20, 1, 200, avertissements);

  return {
    interrupteurGeneral: general,
    destinations,
    politique: { tentativesMax, delaiBaseMs, delaiPlafondMs },
    verrouMs,
    lotMax,
    avertissements,
  };
}

/** Vue publique de la configuration : ni jeton, ni URL complete. Sert aux routes d'administration. */
export function resumerConfig(c: ConfigIntegrations) {
  return {
    interrupteurGeneral: c.interrupteurGeneral,
    politique: c.politique,
    verrouMs: c.verrouMs,
    lotMax: c.lotMax,
    avertissements: c.avertissements,
    destinations: DESTINATIONS.map((d) => {
      const x = c.destinations[d];
      return { destination: d, actif: x.actif, raison: x.raison, timeoutMs: x.timeoutMs };
    }),
  };
}
