import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const h = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: h.user, loading: false, logout: vi.fn() }) }));

import { ProtectedRoute } from "./ProtectedRoute";

/**
 * Garde de route : ce que ces tests defendent.
 *
 * La route /gouvernance est ouverte a ADMIN ET a tout compte portant `peutDeleguerValidation`
 * (la Direction Technique est GESTIONNAIRE), car le serveur l'autorise ainsi. Une route
 * reservee au role, sans l'option, reste fermee a ce meme compte : le droit de designer ne
 * donne aucun autre acces.
 */
function rendre(garde: JSX.Element) {
  return render(
    <MemoryRouter initialEntries={["/gouvernance"]}>
      <Routes>
        <Route path="/" element={<p>Accueil</p>} />
        <Route element={garde}>
          <Route path="/gouvernance" element={<p>Ecran protege</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedRoute : droit de designer un validateur", () => {
  it("laisse entrer un GESTIONNAIRE qui porte peutDeleguerValidation sur une route ouverte aux delegants", () => {
    h.user = { id: "dt", role: "GESTIONNAIRE", peutDeleguerValidation: true };
    rendre(<ProtectedRoute roles={["ADMIN"]} ouvertAuxDelegants />);
    expect(screen.getByText("Ecran protege")).toBeInTheDocument();
  });

  it("renvoie un GESTIONNAIRE sans le droit vers l'accueil, meme sur une route ouverte aux delegants", () => {
    h.user = { id: "g", role: "GESTIONNAIRE", peutDeleguerValidation: false };
    rendre(<ProtectedRoute roles={["ADMIN"]} ouvertAuxDelegants />);
    expect(screen.getByText("Accueil")).toBeInTheDocument();
  });

  it("n'ouvre pas une route reservee au role a un compte delegant quand l'option n'est pas demandee", () => {
    h.user = { id: "dt", role: "GESTIONNAIRE", peutDeleguerValidation: true };
    rendre(<ProtectedRoute roles={["ADMIN"]} />);
    expect(screen.getByText("Accueil")).toBeInTheDocument();
  });

  it("laisse toujours entrer un ADMIN", () => {
    h.user = { id: "a", role: "ADMIN" };
    rendre(<ProtectedRoute roles={["ADMIN"]} ouvertAuxDelegants />);
    expect(screen.getByText("Ecran protege")).toBeInTheDocument();
  });
});
