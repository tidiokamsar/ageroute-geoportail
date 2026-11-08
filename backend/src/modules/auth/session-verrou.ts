import type { PrismaClient } from "@prisma/client";

/**
 * Verrou de LIGNE sur le compte propriétaire des sessions de rafraîchissement (chantier D9, point 1).
 *
 * LA COURSE QUE CE VERROU FERME
 *
 * La révocation (d'un appareil, d'un compte) fait `UPDATE refresh_tokens SET revokedAt ... WHERE userId = X AND
 * revokedAt IS NULL`. Une rotation en vol (`refresh()`) a, elle, déjà « consommé » le jeton A (UPDATE non
 * commité) et inséré le jeton B (INSERT non commité). Sous PostgreSQL en READ COMMITTED, la révocation attend le
 * verrou de la ligne A, voit A révoqué à la reprise et l'ignore, mais B n'était pas visible dans l'instantané de
 * SON instruction : elle répond 200 `sessions: 0` et B reste VIVANT, alors que le porteur du téléphone volé tient
 * un jeton de rafraîchissement valide sept jours. Reproduit par un banc déterministe (transaction PostgreSQL
 * tenue ouverte) et par répétition HTTP parallèle : voir `tests-integration/session-appareil.integration.mts`.
 *
 * Rejouer la révocation en fin de transaction n'aurait fait que RÉTRÉCIR la fenêtre (un client qui reçoit B et le
 * présente aussitôt ouvre une nouvelle rotation entre les deux instructions). Le verrou la SUPPRIME : la rotation
 * et la révocation d'un même compte se SÉRIALISENT.
 *
 *  - la rotation prend `FOR SHARE` sur la ligne du compte AVANT toute autre lecture ou écriture ;
 *  - la révocation prend `FOR UPDATE` sur la même ligne, en PREMIER (avant la révocation de l'appareil et des jetons).
 *
 * `FOR SHARE` et `FOR UPDATE` se contredisent : la révocation attend la fin de la rotation en vol, puis ses
 * instructions suivantes (nouvel instantané en READ COMMITTED) voient B et le révoquent ; ou la rotation attend la
 * fin de la révocation, puis relit son jeton A, le trouve révoqué et suit le chemin de réutilisation (401).
 * Deux rotations (jetons différents ou même jeton) ne se contredisent pas entre elles : `FOR SHARE` est compatible
 * avec `FOR SHARE`, et la concurrence de deux rafraîchissements du MÊME jeton reste réglée, comme avant, par la
 * mise à jour conditionnelle `revokedAt IS NULL`.
 *
 * ORDRE DES VERROUS, ET POURQUOI IL FAUT LE RESPECTER : le verrou du compte est toujours le PREMIER pris. Sans
 * lui, une rotation qui a déjà consommé A, puis insère B (l'insertion prend `FOR KEY SHARE` sur le compte à cause
 * de la clé étrangère), croiserait une révocation qui tient `FOR UPDATE` et attend A : interblocage détecté par
 * PostgreSQL, donc un des deux en erreur 500.
 *
 * Coût : une lecture de ligne par rotation et par révocation, rien sur les requêtes ordinaires (`requireAuth` lit
 * sans verrou). Une connexion (`login`) ne prend pas ce verrou : elle ouvre une NOUVELLE famille après avoir vérifié
 * le mot de passe, ce que la révocation d'un appareil n'a pas à empêcher ; sa propre insertion se sérialise de
 * toute façon avec `FOR UPDATE` par la clé étrangère.
 */
type ClientSql = Pick<PrismaClient, "$queryRaw">;

/** Verrou de la REVOCATION : à prendre en premier dans la transaction qui coupe les sessions d'un compte. */
export function verrouillerPourRevocation(client: ClientSql, userId: string) {
  return client.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
}

/** Verrou de la ROTATION : à prendre en premier dans la transaction de `refresh()`. */
export function verrouillerPourRotation(client: ClientSql, userId: string) {
  return client.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR SHARE`;
}
