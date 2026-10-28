import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Observation rapide pendant l'enregistrement. Ce que ces tests défendent :
 *   - deux appuis suffisent (type puis gravité), sans texte à saisir ;
 *   - la position envoyée est celle du dernier fix, avec sa précision : jamais inventée, et sans position rien n'est posé ;
 *   - une position ancienne est DITE dans la description ;
 *   - la session est rappelée dans la description (le contrat serveur n'a pas de champ session) ;
 *   - un stockage refusé est dit, jamais avalé ;
 *   - zéro violation d'accessibilité.
 */
const h = vi.hoisted(() => ({
  appels: [] as { saisie: Record<string, unknown>; userId: string }[],
  resultat: "ok" as "ok" | "refus" | "stockage" | "plein" | "photos" | "verrou" | "aucun_compte",
}));
vi.mock("../lib/observationsTerrain", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/observationsTerrain")>();
  return {
    ...reel,
    enregistrerObservation: vi.fn(async (saisie: Record<string, unknown>, userId: string) => {
      h.appels.push({ saisie, userId });
      if (h.resultat === "stockage") throw new Error("QuotaExceededError");
      if (h.resultat === "plein") throw new ErreurStockageLocal("STOCKAGE_PLEIN");
      if (h.resultat === "photos") throw new ErreurStockageLocal("TROP_DE_PHOTOS");
      if (h.resultat === "verrou") throw new ErreurStockageLocal("COFFRE_VERROUILLE");
      if (h.resultat === "aucun_compte") throw new ErreurStockageLocal("AUCUN_COMPTE");
      if (h.resultat === "refus") return { ok: false as const, erreurs: ["Choisissez le type d'observation."] };
      return { ok: true as const, observation: {} };
    }),
  };
});
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ObservationRapideRoulage } from "./ObservationRapideRoulage";
import { toast } from "../lib/toast";
import { ErreurStockageLocal } from "../lib/compteCourant";

const POSITION = { lat: 9.64, lon: -13.6, precisionM: 7, ageMs: 800 };
const MISSION = "11111111-1111-4111-8111-111111111111";

function rendre(surcharge: Partial<Parameters<typeof ObservationRapideRoulage>[0]> = {}) {
  return render(<ObservationRapideRoulage position={POSITION} userId="agent-1" sessionId="abcdef12-0000-4000-8000-000000000000" missionId={null} {...surcharge} />);
}

beforeEach(() => { h.appels = []; h.resultat = "ok"; vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear(); });
afterEach(cleanup);

describe("observation rapide", () => {
  it("deux appuis : le type, puis la gravité ; la position du dernier fix part avec sa précision", async () => {
    rendre({ missionId: MISSION });
    fireEvent.click(screen.getByRole("button", { name: "Assainissement" }));
    expect(screen.getByText(/Gravité de « Assainissement »/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forte" }));
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].userId).toBe("agent-1");
    expect(h.appels[0].saisie).toMatchObject({ type: "ASSAINISSEMENT", gravite: "FORTE", lat: 9.64, lon: -13.6, precisionM: 7, missionId: MISSION });
    expect(String(h.appels[0].saisie.description)).toBe("Relevé en roulant, session abcdef12");
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
    // Retour au choix du type, compteur affiché.
    expect(await screen.findByText(/1 observation\(s\) rapide\(s\) pendant cette session/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dégradation" })).toBeInTheDocument();
  });

  it("« Sans gravité » est permis : la gravité n'est pas inventée", async () => {
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Chaussée" }));
    fireEvent.click(screen.getByRole("button", { name: "Sans gravité" }));
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].saisie.gravite).toBeUndefined();
    expect(h.appels[0].saisie.missionId).toBeUndefined();
  });

  it("sans position valide : rien n'est posé, et l'écran le dit", () => {
    rendre({ position: null });
    expect(screen.getByRole("status")).toHaveTextContent(/Rien n'est posé sans position/);
    expect(screen.queryByRole("button", { name: "Dégradation" })).not.toBeInTheDocument();
    expect(h.appels).toHaveLength(0);
  });

  it("une position ancienne est dite dans la description", async () => {
    rendre({ position: { ...POSITION, ageMs: 42_000 } });
    fireEvent.click(screen.getByRole("button", { name: "Sécurité" }));
    fireEvent.click(screen.getByRole("button", { name: "Faible" }));
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(String(h.appels[0].saisie.description)).toContain("position de 42 s avant l'observation");
  });

  it("un stockage refusé est dit : pas de faux « conservée », pas de compteur", async () => {
    h.resultat = "stockage";
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Incident" }));
    fireEvent.click(screen.getByRole("button", { name: "Moyenne" }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/stockage refusé/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(screen.queryByText(/observation\(s\) rapide\(s\)/)).not.toBeInTheDocument();
  });

  it("stockage plein : alerte FIXE avec le message du stockage (un toast s'efface), type conservé pour réessayer", async () => {
    h.resultat = "plein";
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Incident" }));
    fireEvent.click(screen.getByRole("button", { name: "Moyenne" }));
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(alerte).toHaveTextContent(/PAS enregistrée/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(screen.queryByText(/observation\(s\) rapide\(s\)/)).not.toBeInTheDocument();
    // L'agent peut reessayer sans tout ressaisir : on est toujours a l'etape de la gravite.
    expect(screen.getByText(/Gravité de « Incident »/)).toBeInTheDocument();
  });

  it("trop de photos : le message du stockage est affiché tel quel", async () => {
    h.resultat = "photos";
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Incident" }));
    fireEvent.click(screen.getByRole("button", { name: "Moyenne" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cinq photos au maximum par saisie/);
  });

  it("coffre verrouillé : « Déverrouillez avec votre PIN pour enregistrer », et l'alerte disparaît au nouvel essai réussi", async () => {
    h.resultat = "verrou";
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Incident" }));
    fireEvent.click(screen.getByRole("button", { name: "Moyenne" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Déverrouillez avec votre PIN pour enregistrer.");

    h.resultat = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Moyenne" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });

  it("aucun compte ouvert : le message du stockage est affiché", async () => {
    h.resultat = "aucun_compte";
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Incident" }));
    fireEvent.click(screen.getByRole("button", { name: "Moyenne" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Aucun compte n'est ouvert sur cet appareil/);
  });

  it("un refus de validation est rendu avec son motif", async () => {
    h.resultat = "refus";
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Autre" }));
    fireEvent.click(screen.getByRole("button", { name: "Faible" }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Choisissez le type d'observation."));
  });

  it("zéro violation d'accessibilité, au choix du type comme à celui de la gravité", async () => {
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Trafic" }));
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("observation rapide : photo facultative", () => {
  const fichier = (nom = "photo.jpg", type = "image/jpeg", octets = 100) => new File([new Uint8Array(octets)], nom, { type });
  const choisirPhoto = (f: File) => {
    const champ = document.getElementById("obs-rapide-photo") as HTMLInputElement;
    fireEvent.change(champ, { target: { files: [f] } });
  };

  it("la photo prise au moment de la gravité part avec l'observation, avec la position du GPS", async () => {
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Dégradation" }));
    choisirPhoto(fichier());
    expect(await screen.findByText(/1 photo\(s\) jointe\(s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forte" }));
    await waitFor(() => expect(h.appels).toHaveLength(1));
    const photos = h.appels[0].saisie.photos as { name: string; lat: number; lon: number; precisionM: number; capturedA: string }[];
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ name: "photo.jpg", lat: 9.64, lon: -13.6, precisionM: 7 });
    expect(photos[0].capturedA).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Retour au choix du type : plus aucune photo en attente.
    fireEvent.click(screen.getByRole("button", { name: "Chaussée" }));
    expect(screen.queryByText(/photo\(s\) jointe\(s\)/)).not.toBeInTheDocument();
  });

  it("sans photo, aucune photo n'est transmise", async () => {
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Chaussée" }));
    fireEvent.click(screen.getByRole("button", { name: "Faible" }));
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].saisie.photos).toEqual([]);
  });

  it("un format ou une taille refusés sont dits tout de suite, et la photo n'est pas jointe", async () => {
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Chaussée" }));
    choisirPhoto(fichier("scan.pdf", "application/pdf"));
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/seuls les formats JPG, PNG et WebP/);
    expect(screen.queryByText(/photo\(s\) jointe\(s\)/)).not.toBeInTheDocument();
  });

  it("« Retirer les photos » les enlève ; « Changer de type » aussi", async () => {
    rendre();
    fireEvent.click(screen.getByRole("button", { name: "Chaussée" }));
    choisirPhoto(fichier());
    fireEvent.click(await screen.findByRole("button", { name: "Retirer les photos" }));
    expect(screen.queryByText(/photo\(s\) jointe\(s\)/)).not.toBeInTheDocument();
  });

  it("zéro violation d'accessibilité à l'étape de la gravité, photo jointe", async () => {
    const { container } = rendre();
    fireEvent.click(screen.getByRole("button", { name: "Trafic" }));
    choisirPhoto(fichier());
    await screen.findByText(/photo\(s\) jointe\(s\)/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

