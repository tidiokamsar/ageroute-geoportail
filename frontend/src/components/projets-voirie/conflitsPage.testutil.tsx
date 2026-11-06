import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjetVoirieDetailPage } from "../../pages/ProjetVoirieDetailPage";
import { analyse, projetFiche } from "./synthetique.testutil";
import {
  ANALYSE_1, REGLES, analyseConflit, brut, conflit, fiche, pageConflits,
} from "./conflitsSynthetiques.testutil";
import type { ConflitFiche } from "../../lib/projetsVoirieConflitsApi";

/**
 * Aide commune des tests de l'onglet « Conflits » : une API SIMULEE (reponses synthetiques au format lu par `projetsVoirieConflitsApi`) et le rendu
 * de la page projet. Les `vi.mock` restent dans chaque fichier de test (ils sont hisses par vitest).
 */

export const BASE = "/v2/projets-voirie/p1";

export type Params = Record<string, unknown> | undefined;
export interface SurchargesApi {
  liste?: unknown | ((params: Params) => unknown);
  fiches?: Record<string, ConflitFiche | Error>;
  analyses?: unknown;
  detailAnalyse?: unknown;
  comparaison?: unknown | ((params: Params) => unknown);
  regles?: unknown;
  fiche?: unknown;
}

const estErreur = (v: unknown) => v instanceof Error || (!!v && typeof v === "object" && "response" in (v as object));
const rendu = (v: unknown) => { if (estErreur(v)) throw v; return { data: v }; };

export function erreurHttp(status: number, code?: string, error = "erreur du serveur") {
  return Object.assign(new Error(String(status)), { response: { status, data: { error, ...(code ? { code } : {}) } } });
}

function brutAnalyseSocle() {
  const a = JSON.parse(JSON.stringify(analyse()));
  a.regle = { version: "1.0" };
  for (const l of [...a.conflits.parAxe, ...a.conflits.parConcessionnaire]) { l.statut = "A_VERIFIER"; delete l.verification; }
  return a;
}

export const FICHES_PAR_DEFAUT: Record<string, ConflitFiche> = {
  "cf-1": fiche(),
};

export function ficheDe(id: string, over: Partial<ConflitFiche> = {}): ConflitFiche {
  const base = pageConflits().conflits.find((c) => c.id === id) ?? conflit({ id });
  return fiche({ ...base, ...over });
}

export function reponseApi(url: string, params: Params, over: SurchargesApi = {}): { data: unknown } {
  if (url === BASE) return rendu(over.fiche ?? brut(projetFiche()));
  if (url === `${BASE}/analyse`) return rendu(brutAnalyseSocle());
  if (url === `${BASE}/carte`) return rendu([]);
  if (url === "/v2/projets-voirie/concessionnaires") return rendu([{ id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM" }, { id: "c2", nom: "Societe des eaux synthetique", typeReseau: "EAU_POTABLE" }]);
  if (url === `${BASE}/conflits`) {
    const l = over.liste;
    return rendu(typeof l === "function" ? (l as (p: Params) => unknown)(params) : l !== undefined ? l : brut(pageConflits()));
  }
  if (url.startsWith(`${BASE}/conflits/`)) {
    const id = decodeURIComponent(url.slice(`${BASE}/conflits/`.length));
    const f = over.fiches?.[id] ?? (id === "cf-1" ? FICHES_PAR_DEFAUT["cf-1"] : ficheDe(id));
    return rendu(f instanceof Error ? f : brut(f));
  }
  if (url === `${BASE}/analyses`) return rendu(over.analyses ?? { analyses: [brut(analyseConflit()), brut(ANALYSE_1)] });
  if (url.startsWith(`${BASE}/analyses/`) && url.endsWith("/comparaison")) {
    const c = over.comparaison;
    return rendu(typeof c === "function" ? (c as (p: Params) => unknown)(params) : c ?? { apparus: { nb: 1, cles: ["cle-bbbb"] }, disparus: { nb: 1, cles: ["cle-dddd"] }, modifies: { nb: 0, cles: [] }, identiques: { nb: 2, cles: [] } });
  }
  if (url.startsWith(`${BASE}/analyses/`)) return rendu(over.detailAnalyse ?? brut(analyseConflit()));
  if (url === `${BASE}/regles`) return rendu(over.regles ?? { regles: REGLES.map((r) => brut(r)) });
  return rendu({});
}

export function rendrePage(entree = "/projets-voirie/p1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entree]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projets-voirie/:id" element={<ProjetVoirieDetailPage />} />
          <Route path="/projets-voirie" element={<p>Liste des projets</p>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
