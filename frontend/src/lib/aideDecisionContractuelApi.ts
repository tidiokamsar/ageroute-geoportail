/**
 * Appels du suivi contractuel (lecture seule). Le serveur decide du role, des modules et du perimetre territorial ; ce module ne
 * fait que transporter. Une reponse absente est une ERREUR typee (`classerErreur`), jamais un tableau vide ni un zero.
 */
import { api } from "./api";
import type { FiltresDecision } from "../components/decision/types";
import { parametresContractuel, type ParametresContractuel, type ReponseContractuel, type ReponseMarche } from "./aideDecisionContractuel";

const BASE = "/v2/aide-decision/contractuel";

export async function lireContractuel(filtres: FiltresDecision, extras: ParametresContractuel = {}): Promise<ReponseContractuel> {
  return (await api.get<ReponseContractuel>(BASE, { params: parametresContractuel(filtres, extras) })).data;
}

export async function lireFicheMarche(id: string): Promise<ReponseMarche> {
  return (await api.get<ReponseMarche>(`${BASE}/marches/${encodeURIComponent(id)}`)).data;
}

export const CLES = {
  liste: (filtres: FiltresDecision, statutMarche: string[]) => ["aide-decision", "contractuel", "liste", filtres, statutMarche] as const,
  fiche: (id: string) => ["aide-decision", "contractuel", "fiche", id] as const,
};
