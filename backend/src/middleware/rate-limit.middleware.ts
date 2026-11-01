import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

/**
 * Limiteurs de debit complementaires a ceux de /auth/login et /auth/2fa/login-verify
 * (qui protegent contre le bruteforce d'un mot de passe ou d'un code TOTP).
 *
 * Les plafonds sont comptes PAR ADRESSE : derriere Traefik, `trust proxy` = 1 fait lire a
 * express-rate-limit la vraie adresse cliente dans X-Forwarded-For. Le compteur est en
 * memoire du processus : il se remet a zero au redemarrage et n'est pas partage entre
 * plusieurs instances. Aujourd'hui l'API tourne dans un seul conteneur ; si elle etait
 * repliquee, le plafond effectif serait multiplie par le nombre d'instances.
 *
 * Un plafond a 0 desactive le limiteur (voir config/env.ts).
 */

export interface PlafondDebit {
  max: number;
  fenetreMs: number;
}

const inerte: RequestHandler = (_req, _res, next) => next();

/**
 * /auth/refresh : le client le sollicite une fois par expiration du jeton d'acces (15 min)
 * et par onglet. Aucun jeton de rafraichissement n'est devinable (JWT signe), donc ce
 * plafond ne vise pas le bruteforce : il borne le rejeu en boucle d'un jeton vole ou
 * d'un client defaillant, qui ecrit en base a chaque appel (rotation + revocation).
 *
 * Defaut : 60 par 15 min et par adresse. Un bureau entier derriere une seule adresse
 * sortante (50 agents, un rafraichissement chacun par quart d'heure) reste sous le plafond ;
 * un client qui boucle est coupe en quelques secondes.
 */
export function limiteurRefresh({ max, fenetreMs }: PlafondDebit): RequestHandler {
  if (max <= 0) return inerte;
  return rateLimit({
    windowMs: fenetreMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Trop de rafraichissements de session, reessayez plus tard" },
  });
}

/**
 * Plafond GLOBAL sur /api/v2. Ce n'est pas une protection fine (chaque route a ses propres
 * controles) : c'est un filet contre une boucle de rejeu ou un client emballe, qui sinon
 * sature la base sans qu'aucun humain regarde.
 *
 * Defaut : 1200 requetes par minute et par adresse, soit 20 par seconde. Valeur LARGE a
 * dessein : un agent de terrain qui reprend la connexion pousse sa file hors ligne (dizaines
 * d'operations, photos une a une) en rafale, et plusieurs agents peuvent partager une adresse
 * (partage de connexion, NAT d'operateur). Le but est d'ecarter l'absurde, pas de rationner
 * l'usage normal. A resserrer apres mesure du trafic reel, via RATE_LIMIT_V2_MAX.
 */
export function limiteurApiV2({ max, fenetreMs }: PlafondDebit): RequestHandler {
  if (max <= 0) return inerte;
  return rateLimit({
    windowMs: fenetreMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Trop de requetes, reessayez dans un instant" },
  });
}
