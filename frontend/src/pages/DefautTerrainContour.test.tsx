import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Releve d'un contour GPS autour d'un defaut surfacique (scenario A5) : ce que ces tests defendent.
 *   - « Commencer le contour », « Poser un sommet ici », « Fermer le contour » pilotent un releve a pied ; un sommet est
 *     REFUSE avec sa raison (precision au-dessus du seuil, position perimee, croisement) et rien n'est corrige en douce ;
 *   - fermer exige trois sommets distincts et refuse un contour qui se croise ;
 *   - la surface affichee est celle que le SERVEUR rend (ici une valeur volontairement differente de la vraie aire du
 *     carre : si l'ecran en calculait une lui-meme, le test le verrait) ; hors ligne, il dit qu'aucune surface n'existe encore ;
 *   - le contour part dans la charge (file hors ligne, donc aussi en ligne : l'ecran enregistre toujours dans la file puis synchronise),
 *     tel quel, sans surface ; longueur et largeur cessent d'etre exigees pour un m2 ou un m3, pas pour un metre lineaire ;
 *   - un contour refuse par le serveur bloque l'enregistrement et montre la raison ; un contour commence mais non ferme aussi ;
 *   - zero violation d'accessibilite (axe-core) a chaque etape.
 * Rien ici ne prouve le comportement sur un vrai telephone : la geolocalisation est SIMULEE.
 */

const LAT0 = 9.64;
const LON0 = -13.6;
const M_LAT = 1 / 111_320;
const M_LON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));

const h = vi.hoisted(() => ({
  online: true,
  ajoute: vi.fn(async (_item: Record<string, unknown>) => undefined),
  met_a_jour: vi.fn(async (_item: Record<string, unknown>) => undefined),
  brouillons: [] as Record<string, unknown>[],
  sync: vi.fn(async () => undefined),
  metre: { statut: "ok" as "ok" | "refus" | "panne", appels: [] as unknown[] },
  suivi: { ok: null as ((p: unknown) => void) | null, err: null as ((e: { code: number }) => void) | null },
}));

vi.mock("../hooks/useOfflineSync", () => ({
  useOfflineSync: () => ({ online: h.online, syncing: false, pendingCount: 0, syncNow: vi.fn() }),
}));
vi.mock("../lib/defautsTerrain", () => ({
  chargerReferentielsDefautsTerrain: async () => ({
    troncons: [{ id: "troncon-1", code: "RN1", nom: "Conakry — Kindia" }],
    catalogue: [
      { code: "FAIENCAGE", libelle: "Faïençage", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4 },
      { code: "NID", libelle: "Nid-de-poule", famille: "CHAUSSEE", unite: "METRE_CUBE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4 },
      { code: "FISSURE", libelle: "Fissure longitudinale", famille: "CHAUSSEE", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4 },
    ],
    tronconsEnCache: true,
    catalogueEnCache: true,
  }),
}));
vi.mock("../lib/offlineDb", () => ({
  addPendingDefaut: h.ajoute,
  getAllPendingDefauts: vi.fn(async () => h.brouillons),
  removePendingDefaut: vi.fn(async () => undefined),
  updatePendingDefaut: h.met_a_jour,
}));
vi.mock("../lib/offlineSync", () => ({
  refreshPendingCount: vi.fn(async () => undefined),
  syncPendingOfflineData: h.sync,
}));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "INSPECTEUR" } }) }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async (url: string, corps: unknown) => {
      if (url !== "/v2/geo/metre") throw new Error(`POST inattendu : ${url}`);
      h.metre.appels.push(corps);
      if (h.metre.statut === "refus") throw Object.assign(new Error("400"), { response: { status: 400, data: { error: "geometrie invalide : Self-intersection[-13.5999 9.6401]" } } });
      if (h.metre.statut === "panne") throw Object.assign(new Error("500"), { response: { status: 500, data: {} } });
      // 123,45 m2 : volontairement different de l'aire reelle du carre de 10 m (100 m2).
      return { data: { epsg: 32628, longueurM: 40.02, surfaceM2: 123.45, ecartSurface: 0.0002, longueurGeodesiqueM: 40.01, surfaceGeodesiqueM2: 123.4 } };
    }),
  },
}));

import { DefautTerrainPage } from "./DefautTerrainPage";

function installerGeolocalisation() {
  const watchPosition = vi.fn((ok: (p: unknown) => void, err: (e: { code: number }) => void, _options?: unknown) => { h.suivi.ok = ok; h.suivi.err = err; return 9; });
  const clearWatch = vi.fn();
  const getCurrentPosition = vi.fn((ok: (p: unknown) => void) => ok({ timestamp: Date.now(), coords: { latitude: LAT0, longitude: LON0, accuracy: 5 } }));
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { watchPosition, clearWatch, getCurrentPosition } });
  return { watchPosition, clearWatch };
}

/** Une position a (dx, dy) metres du point d'essai ; `ageMs` la vieillit (signal perdu). */
function emettre(dx: number, dy: number, precision = 4, ageMs = 0) {
  act(() => {
    h.suivi.ok?.({ timestamp: Date.now() - ageMs, coords: { latitude: LAT0 + dy * M_LAT, longitude: LON0 + dx * M_LON, accuracy: precision } });
  });
}

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>);
}

const bouton = (nom: string | RegExp) => screen.getByRole("button", { name: nom });

async function ouvrir() {
  installerGeolocalisation();
  const rendu = rendre();
  await screen.findByRole("option", { name: /Faïençage/ });
  return rendu;
}

/** Commence un contour et pose les sommets donnes (positions emises puis geste). */
function poser(sommets: [number, number][], precision = 4) {
  fireEvent.click(bouton("Commencer le contour"));
  for (const [dx, dy] of sommets) {
    emettre(dx, dy, precision);
    fireEvent.click(bouton("Poser un sommet ici"));
  }
}

const CARRE: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];

async function renseignerEtEnregistrer(user: ReturnType<typeof userEvent.setup>, { profondeur }: { profondeur?: string } = {}) {
  fireEvent.click(bouton(/Capturer la position GPS/));
  if (profondeur) await user.type(screen.getByLabelText(/Profondeur/), profondeur);
  await user.selectOptions(screen.getByLabelText("Gravité (1 à 4)"), "2");
  await user.click(bouton("Enregistrer le défaut"));
}

beforeEach(() => {
  h.online = true;
  h.ajoute.mockClear();
  h.met_a_jour.mockClear();
  h.sync.mockClear();
  h.brouillons.length = 0;
  h.metre.statut = "ok";
  h.metre.appels.length = 0;
  h.suivi.ok = null; h.suivi.err = null;
  // jsdom n'implemente pas le defilement que la correction d'un brouillon declenche.
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => cleanup());

describe("poser les sommets", () => {
  it("le contour se commence, la position vient du suivi GPS et chaque sommet pose est compte", async () => {
    const g = installerGeolocalisation();
    rendre();
    await screen.findByRole("option", { name: /Faïençage/ });
    expect(screen.getByRole("group", { name: /Contour GPS du défaut/ })).toHaveTextContent(/aucune\s+surface|ne calcule aucune surface/);
    fireEvent.click(bouton("Commencer le contour"));
    expect(g.watchPosition).toHaveBeenCalledTimes(1);
    expect(g.watchPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    expect(screen.getByText(/Recherche du signal/)).toBeInTheDocument();
    emettre(0, 0, 4);
    expect(screen.getByText(/Position actuelle : précision ± 4 m\./)).toBeInTheDocument();
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.getByText(/1 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
    emettre(10, 0, 4);
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.getByText(/2 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
  });

  it("REFUSE un sommet dont la precision depasse le seuil, avec la raison, et n'en pose aucun ; accepte des que la precision revient", async () => {
    await ouvrir();
    fireEvent.click(bouton("Commencer le contour"));
    emettre(0, 0, 25);
    expect(screen.getByText(/au-dessus du seuil de 10 m : attendre/)).toBeInTheDocument();
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.getByRole("alert")).toHaveTextContent(/Précision ± 25 m : au-dessus du seuil de 10 m/);
    expect(screen.getByText(/0 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
    emettre(0, 0, 6);
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/1 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
  });

  it("REFUSE une position perimee (signal perdu) et l'absence de position", async () => {
    await ouvrir();
    fireEvent.click(bouton("Commencer le contour"));
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.getByRole("alert")).toHaveTextContent(/Aucune position GPS/);
    emettre(0, 0, 4, 30_000);
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.getByRole("alert")).toHaveTextContent(/date de plus de 10 s : le signal est perdu/);
    expect(screen.getByText(/0 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
  });

  it("REFUSE un sommet qui ferait croiser le contour, et « Retirer le dernier sommet » defait la pose", async () => {
    await ouvrir();
    poser([[0, 0], [10, 10], [10, 0]]);
    emettre(0, 10, 4);
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.getByRole("alert")).toHaveTextContent(/croiser ou toucher le contour/);
    expect(screen.getByText(/3 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
    fireEvent.click(bouton("Retirer le dernier sommet"));
    expect(screen.getByText(/2 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("« Fermer le contour » reste desactive sous trois sommets, et le dit", async () => {
    await ouvrir();
    poser([[0, 0], [10, 0]]);
    expect(bouton("Fermer le contour")).toBeDisabled();
    expect(screen.getByText(/Il faut au moins 3 sommets pour fermer le contour/)).toBeInTheDocument();
    emettre(10, 10, 4);
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(bouton("Fermer le contour")).toBeEnabled();
  });

  it("« Abandonner le contour » arrete le suivi et efface les sommets", async () => {
    const g = installerGeolocalisation();
    rendre();
    await screen.findByRole("option", { name: /Faïençage/ });
    poser([[0, 0], [10, 0]]);
    fireEvent.click(bouton("Abandonner le contour"));
    expect(g.clearWatch).toHaveBeenCalled();
    expect(bouton("Commencer le contour")).toBeInTheDocument();
  });

  it("zero violation d'accessibilite : contour inactif, en cours avec un refus affiche", async () => {
    const { container } = await ouvrir();
    expect(await violationsAccessibilite(container)).toEqual([]);
    fireEvent.click(bouton("Commencer le contour"));
    emettre(0, 0, 4);
    fireEvent.click(bouton("Poser un sommet ici"));
    emettre(0, 0, 30);
    fireEvent.click(bouton("Poser un sommet ici"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("fermer le contour : la surface est celle du SERVEUR", () => {
  it("en ligne, montre la surface mesuree par le serveur (123,45 m2, pas l'aire du carre) et envoie le Polygon ferme", async () => {
    await ouvrir();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    expect(screen.getByText(/Contour fermé : 4 sommets/)).toBeInTheDocument();
    await waitFor(() => expect(h.metre.appels).toHaveLength(1));
    const envoye = h.metre.appels[0] as { geometrie: { type: string; coordinates: number[][][] } };
    expect(envoye.geometrie.type).toBe("Polygon");
    expect(envoye.geometrie.coordinates[0]).toHaveLength(5);
    expect(envoye.geometrie.coordinates[0][0]).toEqual(envoye.geometrie.coordinates[0][4]);
    const etat = await screen.findByText(/Surface mesurée par le serveur/);
    expect(etat).toHaveTextContent(/123,45\s*m²/);
    expect(etat).toHaveTextContent(/EPSG:32628/);
    expect(etat).toHaveTextContent(/recalculée par le serveur à la réception/);
    expect(screen.getByRole("group", { name: /Contour GPS du défaut/ })).not.toHaveTextContent(/100\s*m²/);
  });

  it("hors ligne, ne calcule RIEN : dit que le serveur mesurera a la synchronisation, et n'appelle pas le serveur", async () => {
    h.online = false;
    await ouvrir();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    expect(await screen.findByText(/Hors ligne : la surface sera mesurée par le serveur à la synchronisation. Aucune surface n'est calculée sur ce téléphone/)).toBeInTheDocument();
    expect(h.metre.appels).toHaveLength(0);
  });

  it("refuse de fermer un contour dont la FERMETURE croise un cote, bien que chaque sommet ait ete accepte a la pose", async () => {
    // (0,0) (10,0) (10,10) (20,10) : aucune arete posee n'en croise une autre, mais le retour (20,10) -> (0,0) coupe le cote (10,0)-(10,10).
    await ouvrir();
    poser([[0, 0], [10, 0], [10, 10], [20, 10]]);
    expect(screen.getByText(/4 sommet\(s\) posé\(s\)/)).toBeInTheDocument();
    fireEvent.click(bouton("Fermer le contour"));
    expect(screen.getByRole("alert")).toHaveTextContent(/Le contour se croise lui-même/);
    expect(screen.queryByText(/Contour fermé/)).not.toBeInTheDocument();
    expect(h.metre.appels).toHaveLength(0);
  });

  it("zero violation d'accessibilite : contour ferme avec la mesure du serveur, puis hors ligne", async () => {
    const { container } = await ouvrir();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    await screen.findByText(/Surface mesurée par le serveur/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("enregistrer le defaut avec son contour", () => {
  it("surface (m2) : longueur et largeur ne sont plus exigees ; le contour part TEL QUEL dans la file, sans surface ni mesure inventee", async () => {
    const user = userEvent.setup({ delay: null });
    await ouvrir();
    expect(screen.getByLabelText("Longueur *")).toBeRequired();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    await screen.findByText(/Surface mesurée par le serveur/);
    expect(screen.getByLabelText(/Longueur \(couvert par le contour, facultatif\)/)).not.toBeRequired();
    expect(screen.getByLabelText(/Largeur \(couvert par le contour, facultatif\)/)).not.toBeRequired();
    await renseignerEtEnregistrer(user);

    await waitFor(() => expect(h.ajoute).toHaveBeenCalledOnce());
    const item = h.ajoute.mock.calls[0][0] as { status: string; payload: Record<string, unknown> };
    expect(item.status).toBe("pending");
    expect(item.payload.emprise).toMatchObject({ type: "Polygon" });
    const anneau = (item.payload.emprise as { coordinates: number[][][] }).coordinates[0];
    expect(anneau).toHaveLength(5);
    expect(anneau[0]).toEqual(anneau[4]);
    expect(item.payload.mesures).toBeUndefined();
    expect(JSON.stringify(item.payload)).not.toMatch(/surface|quantite/i);
    // en ligne : la file part tout de suite vers le serveur
    expect(h.sync).toHaveBeenCalled();
  });

  it("hors ligne : le meme contour est mis dans la file locale (c'est elle qui le portera a la synchronisation)", async () => {
    h.online = false;
    const user = userEvent.setup({ delay: null });
    await ouvrir();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    await screen.findByText(/Hors ligne : la surface sera mesurée/);
    await renseignerEtEnregistrer(user);
    await waitFor(() => expect(h.ajoute).toHaveBeenCalledOnce());
    expect((h.ajoute.mock.calls[0][0] as { payload: { emprise: { type: string } } }).payload.emprise.type).toBe("Polygon");
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("volume (m3) : longueur et largeur facultatives, PROFONDEUR toujours exigee", async () => {
    const user = userEvent.setup({ delay: null });
    await ouvrir();
    await user.selectOptions(screen.getByLabelText("Type de défaut"), "NID");
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    await screen.findByText(/Surface mesurée par le serveur/);
    expect(screen.getByLabelText(/Longueur \(couvert/)).not.toBeRequired();
    expect(screen.getByLabelText("Profondeur *")).toBeRequired();
    expect(screen.getByRole("group", { name: /Contour GPS du défaut/ })).toHaveTextContent(/multipliée par la profondeur saisie/);
    await renseignerEtEnregistrer(user, { profondeur: "0.1" });
    await waitFor(() => expect(h.ajoute).toHaveBeenCalledOnce());
    expect((h.ajoute.mock.calls[0][0] as { payload: { mesures: unknown; emprise: unknown } })).toMatchObject({ payload: { mesures: { profondeurM: 0.1 }, emprise: { type: "Polygon" } } });
  });

  it("metre lineaire : le polygone ne donne pas la longueur, la LONGUEUR reste exigee, et l'ecran le dit", async () => {
    const user = userEvent.setup({ delay: null });
    await ouvrir();
    await user.selectOptions(screen.getByLabelText("Type de défaut"), "FISSURE");
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    await screen.findByText(/Surface mesurée par le serveur/);
    expect(screen.getByLabelText("Longueur *")).toBeRequired();
    expect(screen.getByRole("group", { name: /Contour GPS du défaut/ })).toHaveTextContent(/n'est pas converti en quantité/);
  });

  it("un contour REFUSE par le serveur bloque l'enregistrement et montre la raison du serveur ; le retirer debloque", async () => {
    h.metre.statut = "refus";
    const user = userEvent.setup({ delay: null });
    await ouvrir();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    expect(await screen.findByText(/Le serveur refuse ce contour : geometrie invalide : Self-intersection/)).toBeInTheDocument();
    await renseignerEtEnregistrer(user);
    expect(await screen.findByText(/Le serveur a refusé ce contour \(geometrie invalide : Self-intersection/)).toBeInTheDocument();
    expect(h.ajoute).not.toHaveBeenCalled();
    fireEvent.click(bouton("Retirer le contour"));
    await user.type(screen.getByLabelText("Longueur *"), "2");
    await user.type(screen.getByLabelText("Largeur *"), "1");
    await user.click(bouton("Enregistrer le défaut"));
    await waitFor(() => expect(h.ajoute).toHaveBeenCalledOnce());
    expect((h.ajoute.mock.calls[0][0] as { payload: Record<string, unknown> }).payload.emprise).toBeUndefined();
  });

  it("une panne du serveur a l'apercu ne juge pas le contour : il est dit non mesure et l'enregistrement reste possible", async () => {
    h.metre.statut = "panne";
    const user = userEvent.setup({ delay: null });
    await ouvrir();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    expect(await screen.findByText(/Mesure du serveur indisponible \(réponse 500\) : la surface sera mesurée à l'enregistrement/)).toBeInTheDocument();
    await renseignerEtEnregistrer(user);
    await waitFor(() => expect(h.ajoute).toHaveBeenCalledOnce());
  });

  it("un contour COMMENCE mais pas ferme bloque l'enregistrement et dit quoi faire", async () => {
    const user = userEvent.setup({ delay: null });
    await ouvrir();
    poser([[0, 0], [10, 0]]);
    await renseignerEtEnregistrer(user);
    // longueur et largeur sont encore exigees (aucun contour ferme) : on les renseigne pour atteindre le controle du contour
    await user.type(screen.getByLabelText("Longueur *"), "2");
    await user.type(screen.getByLabelText("Largeur *"), "1");
    await user.click(bouton("Enregistrer le défaut"));
    expect(await screen.findByText(/Le contour est commencé mais pas fermé/)).toBeInTheDocument();
    expect(h.ajoute).not.toHaveBeenCalled();
  });

  it("corriger un brouillon qui porte un contour le GARDE : il n'est pas perdu en silence", async () => {
    const user = userEvent.setup({ delay: null });
    const emprise = { type: "Polygon", coordinates: [[[-13.6, 9.64], [-13.599, 9.64], [-13.599, 9.641], [-13.6, 9.64]]] };
    h.brouillons.push({
      localId: "brouillon-1", ownerUserId: "agent-1", status: "error", createdAt: "2026-10-23T08:00:00.000Z", errorMessage: "reseau",
      payload: { catalogueCode: "FAIENCAGE", constateA: "2026-10-23T08:00:00.000Z", lat: LAT0, lon: LON0, precisionM: 5, gravite: 2, emprise },
    });
    installerGeolocalisation();
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: /Corriger/ }));
    expect(await screen.findByText(/Contour fermé : 3 sommets/)).toHaveTextContent(/repris du brouillon/);
    await user.click(bouton("Mettre à jour le brouillon"));
    await waitFor(() => expect(h.met_a_jour).toHaveBeenCalledOnce());
    expect((h.met_a_jour.mock.calls[0][0] as { payload: { emprise: unknown } }).payload.emprise).toEqual(emprise);
  });

  it("zero violation d'accessibilite : contour refuse par le serveur, formulaire complet", async () => {
    h.metre.statut = "refus";
    const { container } = await ouvrir();
    poser(CARRE);
    fireEvent.click(bouton("Fermer le contour"));
    await screen.findByText(/Le serveur refuse ce contour/);
    expect(await violationsAccessibilite(container)).toEqual([]);
    expect(within(screen.getByRole("group", { name: /Contour GPS du défaut/ })).getByRole("status")).toBeInTheDocument();
  });
});
