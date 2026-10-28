import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IndicateurEvalue, RapportControle, ReponseIndicateurs } from "../lib/tableauDeBord";

/**
 * Indicateurs du tableau de bord (A12) : ce que ces tests defendent.
 *   - chaque chiffre affiche porte son perimetre, et « reseau classe saisi » n'est jamais dit « reseau national » ;
 *   - le bouton de rapprochement est reserve a ADMIN et GESTIONNAIRE, et un ecart est montre avec les deux valeurs ;
 *   - un compte regional lit sa portee, et un indicateur refuse n'affiche pas de valeur ;
 *   - une table vide dit « aucune donnee », pas 0 ; chargement, erreur et vide sont soignes.
 */

const h = vi.hoisted(() => ({ role: "GESTIONNAIRE", reponse: null as unknown, erreur: false, controle: null as unknown }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role, modulesAutorises: [] } }) }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === "/v2/tableau-de-bord/indicateurs") {
        if (h.erreur) throw { response: { data: { error: "Accès à ce module non autorisé pour votre compte" } } };
        return { data: h.reponse };
      }
      if (url === "/v2/tableau-de-bord/controle") return { data: h.controle };
      throw new Error(`URL inattendue ${url}`);
    }),
  },
}));

import { IndicateursControles } from "./IndicateursControles";

const perimetre = { code: "RESEAU_CLASSE_SAISI", libelle: "Réseau classé saisi", definition: "Tronçons non supprimés hors voirie rattachée." };
function ind(code: string, libelle: string, groupe: IndicateurEvalue["groupe"], valeur: IndicateurEvalue["valeur"], over: Partial<IndicateurEvalue> = {}): IndicateurEvalue {
  return { code, libelle, groupe, unite: "nombre", perimetre, statut: "CALCULE", valeur, motif: null, aucuneDonnee: false, sourceLibelle: null, ...over };
}
const base: ReponseIndicateurs = {
  genereLe: "2026-10-22T10:00:00Z",
  portee: { national: true, regions: [] },
  indicateurs: [
    ind("troncons_classes", "Tronçons classés", "reseau", 1691),
    ind("longueur_geometrique_km", "Longueur géométrique du réseau classé saisi", "reseau", 21156.6, { unite: "km" }),
    ind("portions_validees", "Portions validées (état constaté)", "portions", 0, { aucuneDonnee: true, sourceLibelle: "portions" }),
    ind("portions_chevauchantes", "Paires de portions courantes qui se chevauchent", "qualite", 3),
  ],
};
const egal: RapportControle = {
  genereLe: "2026-10-22T10:00:00Z", total: 4, egaux: 4, ecarts: 0, erreurs: 0, indisponibles: 0,
  resultats: base.indicateurs.map((i) => ({ code: i.code, libelle: i.libelle, unite: i.unite, statut: "EGAL" as const, calcul: i.valeur, controle: i.valeur, motif: null })),
};

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><IndicateursControles /></QueryClientProvider>);
}
const n = (s: string | null) => (s ?? "").replace(/\s/g, " ");

beforeEach(() => { h.role = "GESTIONNAIRE"; h.reponse = base; h.erreur = false; h.controle = egal; });

describe("IndicateursControles", () => {
  it("affiche chaque indicateur avec son perimetre, sans jamais dire « reseau national »", async () => {
    const { container } = rendre();
    expect(await screen.findByText("Tronçons classés")).toBeInTheDocument();
    expect(screen.getAllByText("Périmètre : Réseau classé saisi")).toHaveLength(4);
    expect(n(container.textContent)).toContain("21 156,6 km");
    expect(container.textContent).not.toMatch(/r[eé]seau national/i);
    expect(screen.getByText(/Votre périmètre : national/)).toBeInTheDocument();
  });

  it("une table vide dit « aucune donnee » et non 0", async () => {
    rendre();
    const carte = (await screen.findByText("Portions validées (état constaté)")).closest("li")!;
    expect(within(carte).getByText(/Aucune donnée \(portions/)).toBeInTheDocument();
    expect(within(carte).queryByText("0")).not.toBeInTheDocument();
  });

  it("signale « à traiter » une valeur positive d'un indicateur de traitement", async () => {
    rendre();
    const carte = (await screen.findByText("Paires de portions courantes qui se chevauchent")).closest("li")!;
    expect(within(carte).getByText("À traiter")).toBeInTheDocument();
  });

  it("liste les perimetres et leur definition", async () => {
    rendre();
    await screen.findByText("Tronçons classés");
    expect(screen.getByText("Définition des périmètres")).toBeInTheDocument();
    expect(screen.getByText("Tronçons non supprimés hors voirie rattachée.")).toBeInTheDocument();
  });

  it("le gestionnaire rapproche les chiffres de leurs requetes de controle : tous egaux", async () => {
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: "Rapprocher des requêtes de contrôle" }));
    expect(await screen.findByRole("status")).toHaveTextContent("4 indicateurs rapprochés de leur requête de contrôle : 4 égaux, 0 écarts.");
    expect(screen.getAllByText("Égal à sa requête de contrôle")).toHaveLength(4);
  });

  it("un ecart est montre avec le calcul et le controle", async () => {
    h.controle = {
      ...egal, egaux: 3, ecarts: 1,
      resultats: egal.resultats.map((r) => (r.code === "troncons_classes" ? { ...r, statut: "ECART", calcul: 1691, controle: 1690 } : r)),
    };
    rendre();
    await userEvent.click(await screen.findByRole("button", { name: /Rapprocher/ }));
    expect(await screen.findByText(/Écart : calcul 1 691, contrôle 1 690/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 égaux, 1 écart");
  });

  it("un lecteur ne voit pas le bouton de rapprochement", async () => {
    h.role = "LECTEUR";
    rendre();
    await screen.findByText("Tronçons classés");
    expect(screen.queryByRole("button", { name: /Rapprocher/ })).not.toBeInTheDocument();
  });

  it("compte regional : sa portee est dite, et un indicateur refuse n'affiche pas de valeur", async () => {
    h.reponse = {
      ...base,
      portee: { national: false, regions: [{ id: 3, nom: "Kankan" }] },
      indicateurs: [ind("documents", "Documents", "reseau", null, { statut: "INDISPONIBLE", motif: "Cet indicateur n'existe qu'au niveau national." })],
    };
    rendre();
    expect(await screen.findByText(/Votre périmètre : région Kankan/)).toBeInTheDocument();
    expect(screen.getByText("Indisponible hors périmètre national")).toBeInTheDocument();
    expect(screen.getByText("Cet indicateur n'existe qu'au niveau national.")).toBeInTheDocument();
  });

  it("une liste vide est dite", async () => {
    h.reponse = { ...base, indicateurs: [] };
    rendre();
    expect(await screen.findByText("Aucun indicateur à afficher.")).toBeInTheDocument();
  });

  it("chargement puis erreur : le message du serveur est restitue", async () => {
    h.erreur = true;
    rendre();
    expect(screen.getByRole("status")).toHaveTextContent("Chargement des indicateurs");
    const alerte = await screen.findByRole("alert");
    await waitFor(() => expect(alerte).toHaveTextContent("Accès à ce module non autorisé pour votre compte"));
  });
});
