/**
 * ADAPTATEUR SHAREPOINT : le depot du bulletin routier archive.
 *
 * Contrat : ChargeDepotBulletin (contrats.ts). Le contenu, sa taille et son empreinte SHA-256 sont
 * verifies AVANT l'emission (la base verifie deja l'empreinte du bulletin archive).
 * Teste contre simulateurs/simulateur.ts, ecrit par AGEROUTE. Jamais contre SharePoint (B-12).
 *
 * L'emission du bulletin n'est autorisee par aucun document du depot : l'adaptateur existe et reste
 * desactive tant qu'AGEROUTE n'a pas donne une autorisation ecrite de diffusion (voir
 * CHAMPS_A_CONFIRMER, « autorisation de diffusion »).
 */
import type { ConfigDestination } from "../config";
import type { Adaptateur } from "../types";
import { fabriquerAdaptateur } from "./fabrique";
import type { FetchLike } from "./transport";

export function creerAdaptateurSharePoint(cfg: ConfigDestination, fetchImpl: FetchLike): Adaptateur {
  return fabriquerAdaptateur("SHAREPOINT", cfg, fetchImpl);
}
