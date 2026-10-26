import { randomBytes } from "node:crypto";
import type { CompteRun } from "./donnees";
import { ORIGINE_API } from "./env";

/**
 * Client HTTP de l'API REELLE (port 3401), pour preparer des donnees (global-setup) et pour comparer l'ecran a ce que le serveur dit.
 * Ce n'est pas un contournement : les specs de l'ecran se connectent par l'interface ; ce client sert d'oracle et de moyen de
 * semis par les memes routes que l'administration.
 */

export function adresseAleatoire(): string {
  const o = randomBytes(3);
  return `10.${(o[0] % 250) + 1}.${(o[1] % 250) + 1}.${(o[2] % 250) + 1}`;
}

export interface Reponse<T = any> { status: number; corps: T; dureeMs: number }

export async function http<T = any>(methode: string, chemin: string, opts: { token?: string; corps?: unknown; adresse?: string } = {}): Promise<Reponse<T>> {
  const t0 = Date.now();
  const r = await fetch(`${ORIGINE_API}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      // Le plafond de connexion (10 par 15 min et par adresse) est fixe dans le code : chaque appel annonce une adresse.
      "X-Forwarded-For": opts.adresse ?? adresseAleatoire(),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.corps === undefined ? undefined : JSON.stringify(opts.corps),
  });
  const texte = await r.text();
  let corps: unknown = texte;
  try { corps = texte ? JSON.parse(texte) : null; } catch { /* corps non JSON : rendu tel quel */ }
  return { status: r.status, corps: corps as T, dureeMs: Date.now() - t0 };
}

/**
 * CONSTAT E2E-EO-D (hors module, pre-existant) : deux connexions du MEME compte dans la meme seconde rendent 409 « Une entree avec cette
 * valeur unique existe deja » (le jeton de rafraichissement est un JWT sans identifiant : meme seconde, meme jeton, meme empreinte,
 * contrainte d'unicite). Le harnais espace donc d'au moins 1,1 s deux connexions du meme compte ; le defaut est rapporte, pas contourne dans les assertions.
 */
const derniereConnexion = new Map<string, number>();
export async function espacerConnexion(email: string): Promise<void> {
  const attente = (derniereConnexion.get(email) ?? 0) + 1_100 - Date.now();
  if (attente > 0) await new Promise((r) => setTimeout(r, attente));
  derniereConnexion.set(email, Date.now());
}

/** Connexion par l'API (jeton d'acces). Les specs d'ecran se connectent, elles, par l'interface. */
export async function connecter(c: CompteRun): Promise<string> {
  await espacerConnexion(c.email);
  const r = await http<{ accessToken?: string; error?: string }>("POST", "/api/auth/login", { corps: { email: c.email, password: c.motDePasse } });
  if (r.status !== 200 || !r.corps.accessToken) throw new Error(`Connexion API refusee pour ${c.role} (HTTP ${r.status}).`);
  return r.corps.accessToken;
}

export const PREFIXE_TD = "/api/v2/teledetection";

/** Appel d'une route du module, avec jeton. */
export function td<T = any>(token: string, methode: string, chemin: string, corps?: unknown): Promise<Reponse<T>> {
  return http<T>(methode, `${PREFIXE_TD}${chemin}`, { token, corps });
}
