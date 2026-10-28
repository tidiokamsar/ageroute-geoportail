/**
 * FABRIQUE COMMUNE DES ADAPTATEURS. Chaque destination a son fichier, son contrat et sa verification ;
 * la mecanique d'emission (verifier avant d'emettre, ne jamais lever) est ici, une seule fois.
 */
import type { ConfigDestination } from "../config";
import { verifierChargeContrat } from "../contrats";
import type { Adaptateur, DemandeEmission, Destination, ResultatEmission } from "../types";
import { posterEnveloppe, type FetchLike } from "./transport";

export function fabriquerAdaptateur(
  destination: Destination,
  cfg: ConfigDestination,
  fetchImpl: FetchLike,
): Adaptateur {
  const verifierCharge = (charge: unknown) => verifierChargeContrat(destination, charge);
  return {
    destination,
    verifierCharge,
    async emettre(demande: DemandeEmission): Promise<ResultatEmission> {
      try {
        const v = verifierCharge(demande.charge);
        // Une charge non conforme n'atteint jamais le reseau : le refus est local et definitif.
        if (!v.ok) return { issue: "ECHEC_DEFINITIF", codeErreur: "CHARGE_NON_CONFORME", message: v.motif.slice(0, 300) };
        return await posterEnveloppe(cfg, demande, fetchImpl);
      } catch {
        return { issue: "ECHEC_TEMPORAIRE", codeErreur: "EXCEPTION_ADAPTATEUR", message: "exception inattendue dans l'adaptateur" };
      }
    },
  };
}
