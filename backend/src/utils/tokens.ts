import { createHash, randomUUID } from "crypto";

/**
 * Empreinte SHA-256 d'un refresh token, pour un stockage sans token brut.
 *
 * Pourquoi SHA-256 sans sel ni Argon2 : un refresh token est un JWT signe a
 * haute entropie (> 256 bits), pas un mot de passe choisi par un humain. Une
 * attaque par dictionnaire n'a pas de sens sur lui, et le service doit retrouver
 * la ligne en base par empreinte a chaque refresh — Argon2 (lent par conception)
 * rendrait ce parcours inutilement couteux. Le salage n'apporte rien non plus :
 * les tokens sont uniques par construction, donc impossibles a croiser entre
 * lignes. C'est le traitement standard des bearer tokens au repos.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf-8").digest("hex");
}

/** Identifiant de nouvelle ligne de refresh token, connu avant l'ecriture
 *  (necessaire pour poser replacedById de maniere atomique). */
export function newRefreshTokenId(): string {
  return randomUUID();
}
