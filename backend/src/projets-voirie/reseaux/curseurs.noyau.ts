/**
 * CURSEUR DE PAGINATION DES OBJETS (noyau pur, lot B1). Opaque pour le client, LU par le serveur : tout ce qui n'est pas un identifiant d'objet
 * valide est refuse (`null`, que la route rend en 400 CURSEUR_INVALIDE), jamais envoye a la base (revue RC-3, m7).
 */

import { ID_OBJET } from "./types.noyau";

export const encoderCurseurObjet = (i: string): string => Buffer.from(JSON.stringify({ i }), "utf8").toString("base64url");

export function decoderCurseurObjet(s: string): string | null {
  try {
    const o: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const i = (o as { i?: unknown }).i;
    return typeof i === "string" && ID_OBJET.test(i) ? i : null;
  } catch { return null; }
}
