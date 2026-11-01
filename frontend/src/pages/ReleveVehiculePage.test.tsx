import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnalyseTrace } from "../lib/releve";

/**
 * Releve en vehicule : ce que ces tests defendent.
 *   - l'ecran dit ce qu'il ne fait PAS (pas d'enregistrement en roulage, rien d'ecrit en base) ;
 *   - le guide pas a pas est present, avec ses liens vers les ecrans de saisie ;
 *   - aucune requete ne part sans fichier, ni avec une option hors bornes ;
 *   - les reserves du serveur (avertissements, transitions non verifiees, passage tres court) sont montrees ;
 *   - un echec du serveur est rendu avec SON message, jamais un faux succes.
 */

const h = vi.hoisted(() => ({ appels: [] as { url: string; corps: Record<string, unknown> }[], reponse: null as unknown, erreur: null as unknown }));
vi.mock("../lib/api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: Record<string, unknown>) => {
      h.appels.push({ url, corps });
      if (h.erreur) throw h.erreur;
      return { data: h.reponse };
    }),
  },
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("../lib/toast", () => ({ toast }));
vi.mock("../components/CarteReleve", () => ({ CarteReleve: () => <div data-testid="carte" /> }));

import { ReleveVehiculePage } from "./ReleveVehiculePage";

const analyse: AnalyseTrace = {
  parametres: { reseau: "reference", distanceMaxM: 50, pasMinM: 15, incertitudeParDefautM: 15, pointsMax: 3000, graphe: null },
  indicateurs: {
    pointsLus: 300, pointsIgnores: 2, pointsRetenus: 276, retiresParPas: 22, pointsRattaches: 224, tauxRattachement: 0.812,
    pointsPrecisionInsuffisante: 0, transitionsNonVerifiees: 3, chaines: 1, distanceParcourueM: 5511, dureeS: 552,
    vitesseMoyenneKmH: 35.9, longueurSurReseauM: 4392,
  },
  passages: [
    { tronconId: "t-a", code: "GN N0001", nom: "Conakry - Coyah", indexDebut: 0, indexFin: 109, nombrePoints: 110, deM: 0, aM: 2180.19, longueurM: 2180.2, sens: "CROISSANT", court: false, geojson: null },
    { tronconId: "t-c", code: "GN N0009", nom: null, indexDebut: 110, indexFin: 110, nombrePoints: 1, deM: 40, aM: 40, longueurM: 0, sens: "INDETERMINE", court: true, geojson: null },
  ],
  horsReferentiel: [{ indexDebut: 224, indexFin: 275, nombrePoints: 52, longueurM: 1021.6, coordonnees: [[-13.58, 9.66], [-13.57, 9.66]] }],
  trace: [[-13.6, 9.64], [-13.58, 9.64]],
  rattache: [true, false],
  avertissements: ["Aucune precision annoncee par le fichier : l'incertitude par defaut de 15 m est appliquee a chaque point.", "3 changement(s) de troncon n'ont pas pu etre verifies sur le reseau."],
};

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><ReleveVehiculePage /></QueryClientProvider></MemoryRouter>);
}
const fichier = (nom: string, contenu = "<gpx></gpx>") => new File([contenu], nom, { type: "text/plain" });

beforeEach(() => { h.appels.length = 0; h.reponse = analyse; h.erreur = null; toast.error.mockClear(); });

describe("ReleveVehiculePage : ce qu'elle dit", () => {
  it("dit en tete ce qui n'existe pas encore, et que rien n'est ecrit en base", () => {
    rendre();
    const etat = screen.getByRole("region", { name: /État de la fonction/ });
    expect(within(etat).getByText(/Pas encore disponible/)).toBeInTheDocument();
    expect(within(etat).getByText(/application Android native, qui n'est pas encore développée/)).toBeInTheDocument();
    expect(within(etat).getByText(/n'enregistre rien dans la base/)).toBeInTheDocument();
  });

  it("donne le guide en cinq etapes, avec les liens vers les ecrans de saisie", () => {
    rendre();
    const guide = screen.getByRole("region", { name: /Comment faire un relevé/ });
    expect(within(guide).getAllByRole("listitem")).toHaveLength(5);
    expect(within(guide).getByRole("link", { name: "Patrouilles" })).toHaveAttribute("href", "/exploitation/patrouilles");
    expect(within(guide).getByRole("link", { name: "Défauts terrain" })).toHaveAttribute("href", "/inspections/terrain/defauts");
    expect(within(guide).getByRole("link", { name: "Portions terrain" })).toHaveAttribute("href", "/inspections/terrain/portions");
  });
});

describe("ReleveVehiculePage : validation avant envoi", () => {
  it("refuse sans fichier, sans rien envoyer", async () => {
    rendre();
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Choisir d'abord un fichier/);
    expect(h.appels).toHaveLength(0);
  });

  it("demande le format quand l'extension ne le dit pas", async () => {
    rendre();
    // Un vrai navigateur laisse choisir « tous les fichiers » malgre l'attribut accept.
    const utilisateur = userEvent.setup({ applyAccept: false });
    await utilisateur.upload(screen.getByLabelText(/Fichier de trace/), fichier("trace.kml"));
    await utilisateur.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Format non reconnu/);
    expect(h.appels).toHaveLength(0);
  });

  it.each([
    ["distance trop grande", "Distance maximale", "500", /entre 1 et 200 m/],
    ["distance non numerique", "Distance maximale", "abc", /entre 1 et 200 m/],
    ["pas trop petit", "Pas minimal", "1", /entre 5 et 500 m/],
  ])("refuse une option hors bornes : %s", async (_n, libelle, valeur, message) => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    const champ = screen.getByLabelText(new RegExp(libelle));
    await userEvent.clear(champ);
    await userEvent.type(champ, valeur);
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(h.appels).toHaveLength(0);
  });
});

describe("ReleveVehiculePage : analyse", () => {
  it("envoie le contenu, le format deduit et les options, puis montre le resultat", async () => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx", "<gpx>x</gpx>"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));

    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].url).toBe("/v2/geo/trace");
    expect(h.appels[0].corps).toEqual({ format: "gpx", contenu: "<gpx>x</gpx>", reseau: "reference", distanceMaxM: 50, pasMinM: 15 });

    const resultat = await screen.findByRole("region", { name: /Résultat de l'analyse/ });
    expect(within(resultat).getByText("81 %")).toBeInTheDocument();
    expect(within(resultat).getByText("5,5 km")).toBeInTheDocument();
    expect(within(resultat).getByText("9 min 12 s")).toBeInTheDocument();
    expect(within(resultat).getByText("35,9", { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId("carte")).toBeInTheDocument();
  });

  it("SANS tolerance : le champ est vide, et AUCUNE valeur n'est envoyee a la place", async () => {
    rendre();
    expect((screen.getByLabelText(/tolérance de fusion des extrémités/) as HTMLInputElement).value).toBe("");
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].corps).not.toHaveProperty("toleranceFusionM");
  });

  it("AVEC tolerance : elle est envoyee, virgule decimale comprise, et le resultat dit que le graphe a verifie", async () => {
    h.reponse = { ...analyse, parametres: { ...analyse.parametres, graphe: { toleranceFusionM: 2.5, margeM: 2000, nbTroncons: 14, plafondReseauM: 2000 } }, indicateurs: { ...analyse.indicateurs, transitionsNonVerifiees: 0 } };
    rendre();
    fireEvent.change(screen.getByLabelText(/tolérance de fusion des extrémités/), { target: { value: "2,5" } });
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    await waitFor(() => expect(h.appels).toHaveLength(1));
    expect(h.appels[0].corps.toleranceFusionM).toBe(2.5);
    expect(await screen.findByText("graphe : 14 tronçons, tolérance 2,5 m")).toBeInTheDocument();
  });

  it("SANS graphe, le resultat dit qu'il n'a pas ete utilise", async () => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    expect(await screen.findByText("graphe non utilisé : à lire avec le taux de rattachement")).toBeInTheDocument();
  });

  it.each([
    ["nulle", "0"],
    ["negative", "-3"],
    ["demesuree", "51"],
    ["non numerique", "deux"],
  ])("refuse une tolerance %s, sans rien envoyer", async (_n, valeur) => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    fireEvent.change(screen.getByLabelText(/tolérance de fusion des extrémités/), { target: { value: valeur } });
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("tolérance de fusion doit être comprise entre 0 (exclu) et 50 m");
    expect(h.appels).toHaveLength(0);
  });

  it("montre les avertissements du serveur AVANT les chiffres", async () => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    const avertissements = await screen.findByRole("status");
    expect(within(avertissements).getByText(/Aucune precision annoncee/)).toBeInTheDocument();
    expect(within(avertissements).getByText(/n'ont pas pu etre verifies/)).toBeInTheDocument();
    const resultat = screen.getByRole("region", { name: /Résultat de l'analyse/ });
    const indicateurs = within(resultat).getByText("Points rattachés au réseau");
    expect(avertissements.compareDocumentPosition(indicateurs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("liste les troncons parcourus, et signale le passage tres court sans le cacher", async () => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    const tableau = await screen.findByRole("table", { name: /Tronçons parcourus/ });
    expect(within(tableau).getByText("GN N0001")).toBeInTheDocument();
    expect(within(tableau).getByText("croissant")).toBeInTheDocument();
    expect(within(tableau).getByText("indéterminé")).toBeInTheDocument();
    expect(within(tableau).getAllByText(/Passage très court, à vérifier/)).toHaveLength(1);
  });

  it("liste les parties hors referentiel et dit qu'aucun troncon n'a ete cree", async () => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    expect(await screen.findByText(/Rien n'a été créé/)).toBeInTheDocument();
    expect(screen.getByText(/1,0 km, 52 points/)).toBeInTheDocument();
  });

  it("dit qu'aucun troncon n'explique la trace quand il n'y a aucun passage", async () => {
    h.reponse = { ...analyse, passages: [], horsReferentiel: [], avertissements: [] };
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    expect(await screen.findByText(/Aucun tronçon du réseau choisi n'explique cette trace/)).toBeInTheDocument();
    expect(screen.getByText(/Tout le trajet est expliqué/)).toBeInTheDocument();
  });

  it("rend l'echec du serveur avec son message, sans afficher de resultat", async () => {
    h.erreur = { response: { data: { error: "2000 points apres nettoyage, pour un maximum de 3000." } } };
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("2000 points apres nettoyage, pour un maximum de 3000."));
    expect(screen.queryByRole("region", { name: /Résultat de l'analyse/ })).not.toBeInTheDocument();
  });

  it("efface l'ancien resultat quand on change de fichier", async () => {
    rendre();
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    await screen.findByRole("region", { name: /Résultat de l'analyse/ });
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), fichier("autre.gpx"));
    expect(screen.queryByRole("region", { name: /Résultat de l'analyse/ })).not.toBeInTheDocument();
  });
});
