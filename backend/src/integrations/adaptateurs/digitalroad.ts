/**
 * ADAPTATEUR DIGITALROAD : la fiche d'intervention programmee.
 *
 * Contrat : ChargeFicheIntervention (contrats.ts), tire de MAINTENANCE_PROGRAMMING_DESIGN.md 5.3.
 * Teste contre simulateurs/simulateur.ts, ecrit par AGEROUTE. Jamais contre DigitalRoad (B-11).
 *
 * Cet adaptateur n'ecrit AUCUN statut de fiche. Le passage APPROUVE > TRANSMIS est un fait recu de
 * DigitalRoad (cycle-vie.noyau.ts) : l'accuse de cet appel est conserve dans l'outbox, mais ne
 * declenche aucune transition. Voir CHAMPS_A_CONFIRMER, « accuse de reception ».
 */
import type { ConfigDestination } from "../config";
import type { Adaptateur } from "../types";
import { fabriquerAdaptateur } from "./fabrique";
import type { FetchLike } from "./transport";

export function creerAdaptateurDigitalRoad(cfg: ConfigDestination, fetchImpl: FetchLike): Adaptateur {
  return fabriquerAdaptateur("DIGITALROAD", cfg, fetchImpl);
}
