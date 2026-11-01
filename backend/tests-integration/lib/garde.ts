/**
 * Garde des bancs d'integration : refuse de s'executer ailleurs que sur une base LOCALE et JETABLE.
 *
 * Ces bancs ecrivent (dans une transaction annulee, ou dans un clone qu'ils detruisent). Ils ne
 * doivent jamais pouvoir toucher une base qui contient des donnees reelles, meme par une variable
 * DATABASE_URL laissee dans un terminal. Deux conditions, toutes deux necessaires :
 *   - l'hote est la machine locale ;
 *   - la base s'appelle `replay` (rejeu des migrations, vide) ou `essai_<nom>` (clone jetable).
 * Le mot de passe n'est jamais affiche.
 */
export type Cible = { ok: true; hote: string; base: string } | { ok: false; raison: string };

const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const BASE_AUTORISEE = /^(replay|essai_[a-z0-9_]+)$/;

export function evaluerCible(url: string | undefined): Cible {
  if (!url) return { ok: false, raison: "DATABASE_URL absente" };
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, raison: "DATABASE_URL illisible" }; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { ok: false, raison: "DATABASE_URL n'est pas une URL PostgreSQL" };
  if (!HOTES_LOCAUX.has(u.hostname)) return { ok: false, raison: `hote non local (${u.hostname})` };
  const base = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!BASE_AUTORISEE.test(base)) return { ok: false, raison: `base non jetable (${base || "vide"}) : attendu replay ou essai_<nom>` };
  return { ok: true, hote: u.hostname, base };
}

/** Termine le processus (code 3) si la cible n'est pas autorisee. */
export function exigerBaseJetable(url: string | undefined = process.env.DATABASE_URL): { hote: string; base: string } {
  const c = evaluerCible(url);
  if (!c.ok) {
    console.error(`Banc d'integration refuse : ${c.raison}.`);
    process.exit(3);
  }
  console.log(`Cible du banc : ${c.hote} / ${c.base}`);
  return { hote: c.hote, base: c.base };
}

// Effet de bord voulu : importer ce module suffit a poser la garde, avant toute connexion.
if (!process.env.VITEST) exigerBaseJetable();
