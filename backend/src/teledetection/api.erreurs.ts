/**
 * Contrat des erreurs de l'API d'observation de la Terre : TOUTE erreur du module a la forme `{ error, code }`
 * (CONTRAT-API-UI.md, section 5). L'interface se fonde sur `code`, jamais sur le texte.
 *
 *   400 ENTREE_INVALIDE (et les codes precis du service)   403 ROLE_INSUFFISANT, MODULE_NON_AUTORISE, HORS_PERIMETRE
 *   404 INTROUVABLE (ressource inexistante OU hors perimetre : reponse identique), APERCU_INDISPONIBLE
 *   409 TRANSITION_INTERDITE, VERDICT_DEFINITIF, ...       429 LIMITE_ATTEINTE, QUOTA_SOURCE   503 SOURCE_INDISPONIBLE
 *
 * Aucune erreur serveur n'est rendue comme un resultat vide ; une erreur imprevue donne 500 ERREUR_INTERNE, sans detail
 * (le detail va au journal du serveur, pas au client).
 */

import { Prisma } from "@prisma/client";
import { ErreurSource } from "./sources/contrat";
import { RefusTeledetection } from "./teledetection.service";

export class RefusApi extends Error {
  constructor(
    public readonly http: 400 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
    message: string,
    /** Membres en plus dans le corps (par exemple l'etat enregistre d'une source). */
    public readonly extra: Record<string, unknown> = {},
  ) { super(message); }
}

export interface ReponseErreur { http: number; corps: { error: string; code: string } & Record<string, unknown> }

/** Corps unique d'une ressource inexistante ou hors perimetre. */
export const INTROUVABLE: ReponseErreur = { http: 404, corps: { error: "Ressource introuvable", code: "INTROUVABLE" } };

const MESSAGES_GENERIQUES_404 = new Set(["PROPOSITION_INEXISTANTE"]);
/** Refus de la base qui sont des entrees invalides (geometrie, contrainte) quand la route le declare. */
const REFUS_BASE_ENTREE = /geometr|geojson|st_[a-z]+|violates check constraint|invalid input syntax|out of range/i;

export function reponseErreur(err: unknown, options: { erreurBaseEstEntree?: boolean } = {}): ReponseErreur {
  if (err instanceof RefusApi) return { http: err.http, corps: { ...err.extra, error: err.message, code: err.code } };
  if (err instanceof RefusTeledetection) {
    if (err.http === 404 && MESSAGES_GENERIQUES_404.has(err.code)) return INTROUVABLE;
    return { http: err.http, corps: { error: err.message, code: err.code } };
  }
  if (err instanceof ErreurSource) {
    switch (err.categorie) {
      case "QUOTA":
        return { http: 429, corps: { error: "Le fournisseur limite le debit : reessayer plus tard.", code: "QUOTA_SOURCE", ...(err.retryApresMs ? { retryApresS: Math.ceil(err.retryApresMs / 1000) } : {}) } };
      case "ENTREE":
        return { http: 400, corps: { error: err.message, code: "ENTREE_INVALIDE" } };
      case "NON_SUPPORTE":
        return { http: 409, corps: { error: "Cette source n'est pas configuree pour cette operation.", code: "SOURCE_NON_CONFIGUREE" } };
      default:
        return { http: 503, corps: { error: "Le catalogue du fournisseur ne repond pas ou repond de facon inexploitable.", code: "SOURCE_INDISPONIBLE" } };
    }
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return { http: 409, corps: { error: "Une entree avec cette valeur unique existe deja.", code: "CONFLIT" } };
    if (err.code === "P2025") return INTROUVABLE;
    if (err.code === "P2003") return { http: 409, corps: { error: "Reference inconnue ou encore utilisee.", code: "CONFLIT" } };
  }
  if (options.erreurBaseEstEntree && err instanceof Error && REFUS_BASE_ENTREE.test(err.message)) {
    return { http: 400, corps: { error: "Une valeur deposee est refusee par la base (geometrie ou donnee invalide).", code: "ENTREE_INVALIDE" } };
  }
  console.error("[teledetection] erreur imprevue", err instanceof Error ? err.message : err);
  return { http: 500, corps: { error: "Erreur interne du serveur", code: "ERREUR_INTERNE" } };
}
