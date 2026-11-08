import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Onglet « Constats terrain » d'un tronçon. Ce que ces tests défendent :
 *   - confirmés et proposés sont affichés à part ; les récurrences sont dites avec leurs dates ;
 *   - un tronçon sans constat dit que cela ne prouve PAS un bon état ;
 *   - un refus du serveur (hors périmètre) est dit, pas masqué ; zéro violation d'accessibilité.
 */
const h = vi.hoisted(() => ({ mode: "plein" as "plein" | "vide" | "refus" }));

vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async () => {
      if (h.mode === "refus") throw { response: { status: 403, data: { error: "Ce tronçon est hors de votre périmètre." } } };
      const base = { tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry - Coyah", plafondListe: 100, listeTronquee: false, lectureIncomplete: false, avertissements: ["Un constat sans tronçon rattaché n'apparaît dans l'histoire d'aucune section."] };
      if (h.mode === "vide") return { data: { ...base, liste: [], historique: { total: 0, defauts: 0, observations: 0, confirmes: 0, proposes: 0, rejetesEcartes: 2, premierConstat: null, dernierConstat: null, parJour: [], recurrents: [] } } };
      return {
        data: {
          ...base,
          historique: {
            total: 4, defauts: 3, observations: 1, confirmes: 1, proposes: 3, rejetesEcartes: 1, premierConstat: "2026-09-25", dernierConstat: "2026-10-21",
            parJour: [{ date: "2026-09-25", defauts: 1, observations: 0, graves: 1, confirmes: 0, proposes: 1 }, { date: "2026-10-21", defauts: 2, observations: 1, graves: 2, confirmes: 1, proposes: 2 }],
            recurrents: [{ cle: "DEFAUT:NID", libelle: "Nid de poule", nature: "DEFAUT", nbDates: 2, premiereFois: "2026-09-25", derniereFois: "2026-10-21", nbConstats: 3 }],
          },
          liste: [
            { nature: "DEFAUT", id: "d1", type: "NID", libelle: "Nid de poule", gravite: 4, statut: "VALIDE", etatDefaut: "ACTIF", constateA: "2026-10-21T10:00:00.000Z", confirme: true, grave: true },
            { nature: "OBSERVATION", id: "o1", type: "DEGRADATION", libelle: "DEGRADATION", gravite: "FORTE", statut: "PROPOSEE", etatDefaut: null, constateA: "2026-10-20T10:00:00.000Z", confirme: false, grave: true },
            { nature: "DEFAUT", id: "d2", type: "FISSURE", libelle: "Fissure", gravite: 2, statut: "A_VALIDER", etatDefaut: "TRAITE", constateA: "2026-09-25T10:00:00.000Z", confirme: false, grave: false },
          ],
        },
      };
    }),
  },
}));

import { VoletConstatsTroncon } from "./VoletConstatsTroncon";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><VoletConstatsTroncon tronconId="t1" /></QueryClientProvider>);
}
beforeEach(() => { h.mode = "plein"; });
afterEach(cleanup);

describe("onglet Constats terrain", () => {
  it("compte à part les confirmés et les proposés, et dit les récurrences avec leurs dates", async () => {
    rendre();
    const resume = await screen.findByLabelText("Résumé des constats");
    expect(resume).toHaveTextContent(/Constats retenus\s*4/);
    expect(resume).toHaveTextContent(/Confirmés\s*1/);
    expect(resume).toHaveTextContent(/Proposés, à trancher\s*3/);
    expect(resume).toHaveTextContent(/Défauts · observations\s*3 · 1/);
    expect(screen.getByText(/1 constat\(s\) rejeté\(s\) écarté\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/constaté à 2 dates, du 2026-09-25 au 2026-10-21, 3 constat\(s\)/)).toBeInTheDocument();
  });

  it("liste les constats avec gravité et statut, dit « traité » pour un défaut traité, et regroupe par jour", async () => {
    rendre();
    await screen.findByLabelText("Résumé des constats");
    const liste = screen.getByRole("heading", { name: "Constats récents" }).parentElement!;
    expect(liste).toHaveTextContent(/Nid de poule \(défaut\).*gravité 4 sur 4 \(grave\).*validé/);
    expect(liste).toHaveTextContent(/DEGRADATION \(observation\).*gravité forte \(grave\).*proposée/);
    expect(liste).toHaveTextContent(/Fissure \(défaut\).*à valider.*traité/);
    const jours = screen.getByRole("table", { name: /regroupés par jour/ });
    expect(Array.from(jours.querySelectorAll("tbody tr")).map((l) => l.querySelector("td")?.textContent)).toEqual(["2026-10-21", "2026-09-25"]);
  });

  it("aucun constat : dit que ce n'est pas la preuve d'un bon état", async () => {
    h.mode = "vide";
    rendre();
    expect(await screen.findByText(/Cela ne veut pas dire que la route est en bon état/)).toBeInTheDocument();
    expect(screen.getByText(/2 rejeté\(s\) écarté\(s\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Résumé des constats")).not.toBeInTheDocument();
  });

  it("hors périmètre : le refus est dit", async () => {
    h.mode = "refus";
    rendre();
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'ont pas pu être chargés/);
  });

  it("zéro violation d'accessibilité", async () => {
    const { container } = rendre();
    await screen.findByLabelText("Résumé des constats");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
