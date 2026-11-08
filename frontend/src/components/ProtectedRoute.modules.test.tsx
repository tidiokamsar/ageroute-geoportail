import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const h = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: h.user, loading: false, logout: vi.fn() }) }));

import { ProtectedRoute } from "./ProtectedRoute";

/**
 * Garde de route et modules (E2E-EO-3). Le serveur lit une liste de modules VIDE comme « aucun module » (backend/src/lib/access.ts) ;
 * le garde-fou de l'ecran doit dire la meme chose, sinon un compte sans module ouvre l'ecran et n'y trouve que des refus de l'API.
 */
function rendre(chemin: string) {
  return render(
    <MemoryRouter initialEntries={[chemin]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/teledetection" element={<p>Ecran Observation de la Terre</p>} />
          <Route path="/troncons" element={<p>Ecran Troncons</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute : modules autorises", () => {
  it("un GESTIONNAIRE a la liste de modules vide est refuse (« aucun module »), comme par le serveur", () => {
    h.user = { id: "g", role: "GESTIONNAIRE", modulesAutorises: [] };
    rendre("/teledetection");
    expect(screen.getByRole("heading", { name: "Accès non autorisé" })).toBeInTheDocument();
    expect(screen.queryByText("Ecran Observation de la Terre")).not.toBeInTheDocument();
  });

  it("un profil sans le champ modulesAutorises est refuse aussi (on echoue ferme)", () => {
    h.user = { id: "g", role: "LECTEUR" };
    rendre("/troncons");
    expect(screen.getByRole("heading", { name: "Accès non autorisé" })).toBeInTheDocument();
  });

  it("un module present dans la liste est ouvert, un autre reste refuse", () => {
    h.user = { id: "g", role: "GESTIONNAIRE", modulesAutorises: ["teledetection"] };
    rendre("/teledetection");
    expect(screen.getByText("Ecran Observation de la Terre")).toBeInTheDocument();
    rendre("/troncons");
    expect(screen.getByRole("heading", { name: "Accès non autorisé" })).toBeInTheDocument();
  });

  it("un ADMIN n'est jamais restreint, meme avec une liste vide", () => {
    h.user = { id: "a", role: "ADMIN", modulesAutorises: [] };
    rendre("/teledetection");
    expect(screen.getByText("Ecran Observation de la Terre")).toBeInTheDocument();
  });
});
