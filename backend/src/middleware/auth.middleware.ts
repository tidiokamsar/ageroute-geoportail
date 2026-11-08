import type { Request, Response, NextFunction } from "express";
import type { Role } from "@prisma/client";
import { verifyAccessToken } from "../utils/jwt";
import { prisma } from "../lib/prisma";

/**
 * Authentification d'une requete : le jeton prouve QUI, la BASE dit CE QUE LE COMPTE EST AUJOURD'HUI.
 *
 * POURQUOI LA BASE EST RELUE A CHAQUE REQUETE (chantier D4, defaut 1 ; D-C1-10 de `docs/securite/CONTROLE-ACCES.md`)
 *
 * Avant, l'identite ET LE ROLE venaient du jeton d'acces (15 minutes, `JWT_ACCESS_EXPIRES_IN`) et rien ne
 * consultait `users` : un compte desactive ou verrouille gardait ses droits jusqu'a l'expiration du jeton,
 * `sync/push` compris, et un compte retrograde de GESTIONNAIRE a LECTEUR ecrivait encore pendant ce delai.
 * Le rafraichissement, lui, verifiait deja `actif` : le trou se limitait a la fenetre du jeton, mais cette
 * fenetre est celle d'un telephone perdu ou d'un agent licencie.
 *
 * CE QUE CETTE GARDE DECIDE
 *
 *  - compte absent, `actif = false` ou `lockedUntil` dans le futur : 401 `COMPTE_INACTIF`, immediatement.
 *    Le meme code pour les trois cas : un client n'a pas a savoir si un compte existe.
 *  - le ROLE et l'adresse de `req.user` sont ceux de la base, pas ceux du jeton : une retrogradation ou une
 *    promotion s'applique a la requete suivante.
 *  - base indisponible OU trop lente (`DELAI_RESOLVEUR_COMPTE_MS`) : 503 `SERVICE_INDISPONIBLE`, JAMAIS 401. Un 401 fait fermer la session locale du
 *    telephone (`docs/securite/SESSION-HORS-LIGNE-SERVEUR.md`) ; une panne de base ne doit pas deconnecter
 *    tous les agents. On echoue ferme (la requete est refusee), mais on ne ment pas sur la cause.
 *
 * LE COUT, ET POURQUOI IL N'Y A PAS DE CACHE
 *
 * Une lecture par cle primaire de quatre colonnes par requete authentifiee (`requireModuleAccess` en fait
 * deja une autre pour les comptes non ADMIN). Mesure sur la base locale : voir `SESSION-HORS-LIGNE-SERVEUR.md`.
 * Un cache, meme d'une seconde, rouvrirait une fenetre ou un compte desactive agit encore, et c'est
 * exactement ce que cette garde ferme. Si la charge l'exigeait un jour, le point d'entree est
 * `_installerResolveurCompte` (un resolveur injectable) et la duree du cache devrait etre ecrite en
 * toutes lettres dans le document de securite.
 *
 * COUVERTURE : toutes les routes montees derriere `requireAuth`, c'est-a-dire toutes les routes
 * authentifiees (`securite/routes-authentifiees.test.ts` prouve qu'aucune ne s'en passe). Ne sont PAS
 * couvertes, par conception : `/auth/refresh`, `/auth/logout` et `/auth/2fa/login-verify`, qui n'utilisent pas
 * de jeton d'acces (le rafraichissement verifie `actif` et `lockedUntil` lui-meme).
 */

export interface EtatCompte {
  actif: boolean;
  lockedUntil: Date | null;
  role: Role;
  email: string;
}

/** Lit l'etat courant d'un compte ; `null` si le compte n'existe plus. */
export type ResolveurCompte = (userId: string) => Promise<EtatCompte | null>;

const resolveurPrisma: ResolveurCompte = (userId) =>
  prisma.user.findUnique({
    where: { id: userId },
    select: { actif: true, lockedUntil: true, role: true, email: true },
  });

let resolveur: ResolveurCompte = resolveurPrisma;

/**
 * Delai maximal de la lecture du compte (D9, point 7b). PROVISOIRE : 3 secondes, choisies sans mesure de production
 * (la lecture mesuree sur le poste de developpement est de l'ordre de 10 a 15 ms, p99 de quelques centaines).
 *
 * POURQUOI UN DELAI : sans lui, une base qui accepte la connexion mais ne repond plus (verrou, reseau a moitie
 * coupe) laisse chaque requete authentifiee PENDANTE jusqu'au delai du client ou du proxy, et epuise les
 * connexions du processus. Le delai transforme cette attente en un refus net : 503 `SERVICE_INDISPONIBLE`, le meme
 * que pour une base en erreur, jamais 401 (un 401 ferme la session locale d'un telephone).
 * Une lecture tardive qui finit apres le delai est ignoree (la requete a deja recu son 503).
 */
export const DELAI_RESOLVEUR_COMPTE_MS = 3000;

/** Reserve aux tests et a un eventuel cache : remplace le resolveur, ou le remet par defaut avec `null`. */
export function _installerResolveurCompte(r: ResolveurCompte | null): void {
  resolveur = r ?? resolveurPrisma;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentification requise", code: "NON_AUTHENTIFIE" });
    return;
  }

  let sub: string;
  try {
    sub = verifyAccessToken(header.slice("Bearer ".length)).sub;
  } catch {
    res.status(401).json({ error: "Jeton invalide ou expire", code: "JETON_INVALIDE" });
    return;
  }

  let compte: EtatCompte | null;
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  try {
    const delai = new Promise<never>((_, rejeter) => {
      minuteur = setTimeout(() => rejeter(new Error("Lecture du compte trop lente")), DELAI_RESOLVEUR_COMPTE_MS);
    });
    compte = await Promise.race([resolveur(sub), delai]);
  } catch {
    res.status(503).json({ error: "Service momentanement indisponible", code: "SERVICE_INDISPONIBLE" });
    return;
  } finally {
    clearTimeout(minuteur);
  }

  if (!compte || !compte.actif || (compte.lockedUntil !== null && compte.lockedUntil > new Date())) {
    res.status(401).json({ error: "Compte desactive ou verrouille", code: "COMPTE_INACTIF" });
    return;
  }

  req.user = { id: sub, role: compte.role, email: compte.email };
  next();
}
