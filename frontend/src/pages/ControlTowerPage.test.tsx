import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { IndicateurEvalue, ModuleControlTower, ReponseControlTower } from "../lib/tableauDeBord";

/**
 * Control Tower : ce que ces tests defendent.
 *   - rien n'est invente : un module sans donnee dit « aucune donnee » avec son perimetre, pas 0 ;
 *   - un compte regional lit sa portee, et un module non ventile est declare non communique ;
 *   - une valeur positive d'un indicateur de traitement est « a traiter », zero ne l'est pas ;
 *   - ce que la synthese ne couvre pas est affiche ; chargement et erreur sont soignes.
 */

const h = vi.hoisted(() => ({ reponse: null as unknown, erreur: null as null | { response?: { data?: { error?: string } } } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url !== "/v2/tableau-de-bord/control-tower") throw new Error(`URL inattendue ${url}`);
      if (h.erreur) throw h.erreur;
      return { data: h.reponse };
    }),
  },
}));

import { ControlTowerPage } from "./ControlTowerPage";

const perimetre = { code: "MAIN_COURANTE_ACTIFS", libelle: "Événements de la main courante non clos", definition: "Événements dont le dernier statut n'est pas CLOS." };
function ind(code: string, libelle: string, valeur: IndicateurEvalue["valeur"], over: Partial<IndicateurEvalue> = {}): IndicateurEvalue {
  return { code, libelle, groupe: "veille", unite: "nombre", perimetre, statut: "CALCULE", valeur, motif: null, aucuneDonnee: false, sourceLibelle: null, ...over };
}
function mod(code: string, libelle: string, indicateurs: IndicateurEvalue[], over: Partial<ModuleControlTower> = {}): ModuleControlTower {
  return { code, libelle, lien: `/${code}`, indicateurs, aucuneDonnee: false, indisponible: false, ...over };
}
const base: ReponseControlTower = {
  genereLe: "2026-10-22T10:00:00Z",
  portee: { national: true, regions: [] },
  modules: [
    mod("veille", "Cellule de veille", [ind("evenements_actifs", "Événements actifs de la main courante", 4), ind("trous_de_permanence", "Événements escaladés sans personne d'astreinte", 2), ind("evenements_escalades", "Événements actifs escaladés", 0)]),
    mod("teledetection", "Observation de la Terre", [ind("propositions_a_verifier", "Propositions de télédétection en attente de verdict", 0, { aucuneDonnee: true, sourceLibelle: "propositions de télédétection" })], { aucuneDonnee: true }),
  ],
  nonCouvert: ["Doublons de géométrie : balayage national, non rejoué à chaque rafraîchissement.", "Aucune notification n'est envoyée."],
};

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><ControlTowerPage /></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => { h.reponse = base; h.erreur = null; });

describe("ControlTowerPage", () => {
  it("affiche chaque module, ses indicateurs, leur perimetre, et un lien vers la page de traitement", async () => {
    rendre();
    const veille = await screen.findByTestId("module-veille");
    expect(within(veille).getByRole("heading", { name: "Cellule de veille" })).toBeInTheDocument();
    expect(within(veille).getByText("Événements actifs de la main courante")).toBeInTheDocument();
    expect(within(veille).getAllByText("Périmètre : Événements de la main courante non clos")).toHaveLength(3);
    expect(within(veille).getByRole("link", { name: "Ouvrir la page" })).toHaveAttribute("href", "/veille");
  });

  it("marque « a traiter » une valeur positive, pas un zero", async () => {
    rendre();
    const veille = await screen.findByTestId("module-veille");
    const trous = within(veille).getByText("Événements escaladés sans personne d'astreinte").closest("li")!;
    const zero = within(veille).getByText("Événements actifs escaladés").closest("li")!;
    expect(within(trous).getByText("À traiter")).toBeInTheDocument();
    expect(within(zero).queryByText("À traiter")).not.toBeInTheDocument();
  });

  it("un module sans donnee le dit, avec son perimetre, au lieu d'un zero", async () => {
    rendre();
    const mt = await screen.findByTestId("module-teledetection");
    expect(within(mt).getByText("Aucune donnée.")).toBeInTheDocument();
    expect(within(mt).getByText(/rien n'a encore été enregistré/)).toBeInTheDocument();
    expect(within(mt).getByText("Périmètre : Événements de la main courante non clos")).toBeInTheDocument();
    expect(within(mt).queryByText("0")).not.toBeInTheDocument();
  });

  it("compte regional : sa portee est dite, un module non ventile est declare non communique", async () => {
    h.reponse = {
      ...base,
      portee: { national: false, regions: [{ id: 3, nom: "Kankan" }] },
      modules: [mod("veille", "Cellule de veille", [ind("regles_escalade_actives", "Règles d'escalade actives", null, { statut: "INDISPONIBLE" })], { indisponible: true })],
    };
    rendre();
    expect(await screen.findByText(/Votre périmètre : région Kankan/)).toBeInTheDocument();
    expect(screen.getByText(/n'est pas communiqué à un compte régional/)).toBeInTheDocument();
  });

  it("affiche ce que la synthese ne couvre pas", async () => {
    rendre();
    expect(await screen.findByRole("heading", { name: "Ce que cette synthèse ne couvre pas" })).toBeInTheDocument();
    expect(screen.getByText(/Doublons de géométrie/)).toBeInTheDocument();
  });

  it("aucun module : le dit", async () => {
    h.reponse = { ...base, modules: [] };
    rendre();
    expect(await screen.findByText("Aucun module à afficher.")).toBeInTheDocument();
  });

  it("chargement puis erreur avec le message du serveur", async () => {
    h.erreur = { response: { data: { error: "Accès à ce module non autorisé pour votre compte" } } };
    rendre();
    expect(screen.getByRole("status")).toHaveTextContent("Chargement de la Control Tower");
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("La Control Tower n'a pas pu être chargée.");
    expect(alerte).toHaveTextContent("Accès à ce module non autorisé pour votre compte");
  });
});
