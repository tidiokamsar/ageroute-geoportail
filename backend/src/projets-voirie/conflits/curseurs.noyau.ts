/**
 * CURSEURS DE PAGINATION DES DOSSIERS ET DES ANALYSES (noyau pur ; revue RC-3, m7).
 *
 * Un curseur est opaque pour le client mais LU PAR LE SERVEUR : un curseur forge ne doit jamais atteindre la base avec une valeur que
 * PostgreSQL refuse (500) ni une chaine qui n'est pas un identifiant. Tout ce qui sort des formes que le serveur produit lui-meme est
 * refuse (`null`, que la route rend en 400 CURSEUR_INVALIDE) :
 *   - dossiers : `{ t, i }` ; `t` est l'horodatage ISO 8601 UTC a la milliseconde (la forme de `toISOString`, annee 1970 a 2200),
 *     `i` un UUID en minuscules ;
 *   - analyses : `{ n }` ; `n` est un entier de 1 a 2 147 483 647 (colonne `integer`).
 */

const NUMERO_MAX = 2_147_483_647;
const ANNEE_MIN = 1970;
const ANNEE_MAX = 2200;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const lire = (s: string): Record<string, unknown> | null => {
  try {
    const o: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch { return null; }
};

export const encoderCurseurConflit = (c: { t: string; i: string }): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

export function decoderCurseurConflit(s: string): { t: Date; i: string } | null {
  const o = lire(s);
  if (!o || typeof o.t !== "string" || typeof o.i !== "string") return null;
  if (!ISO.test(o.t) || !UUID.test(o.i)) return null;
  const t = new Date(o.t);
  if (Number.isNaN(t.getTime()) || t.toISOString() !== o.t) return null;
  const annee = t.getUTCFullYear();
  return annee >= ANNEE_MIN && annee <= ANNEE_MAX ? { t, i: o.i } : null;
}

export const encoderCurseurAnalyse = (n: number): string => Buffer.from(JSON.stringify({ n }), "utf8").toString("base64url");

export function decoderCurseurAnalyse(s: string): number | null {
  const o = lire(s);
  return o && typeof o.n === "number" && Number.isInteger(o.n) && o.n >= 1 && o.n <= NUMERO_MAX ? o.n : null;
}
