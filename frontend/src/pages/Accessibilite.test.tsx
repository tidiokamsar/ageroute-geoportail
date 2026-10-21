import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Mesure d'accessibilite des ecrans (paragraphe 7.11) par axe-core, regles WCAG 2.1 A et AA,
 * contraste exclu (jsdom ne le calcule pas, voir `test/accessibilite.ts`).
 *
 * Chaque test rend l'ecran avec des donnees, puis exige ZERO violation. Un echec liste les
 * violations : elles se corrigent, elles ne se taisent pas.
 */

const h = vi.hoisted(() => ({ get: {} as Record<string, unknown> }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: "GESTIONNAIRE", modulesAutorises: [] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn() }));
vi.mock("../components/CarteReleve", () => ({ CarteReleve: () => <div data-testid="carte" /> }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => ({ data: h.get[url] ?? {} })),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

import { CelluleVeillePage } from "./CelluleVeillePage";
import { PatrouillesPage } from "./PatrouillesPage";
import { InfoRoutePage } from "./InfoRoutePage";
import { VeilleConfigurationPage } from "./VeilleConfigurationPage";
import { TeledetectionPage } from "./TeledetectionPage";
import { Sidebar } from "../components/layout/Sidebar";
import { LoginPage } from "./LoginPage";
import { ImportsPage } from "./ImportsPage";
import { ReleveVehiculePage } from "./ReleveVehiculePage";
import { api } from "../lib/api";
import userEvent from "@testing-library/user-event";

function rendre(el: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{el}</QueryClientProvider></MemoryRouter>);
}

beforeEach(() => {
  h.get = {
    "/v2/exploitation/veille/tableau": {
      genereLe: "2026-10-20T08:00:00Z",
      mode: { mode: "SAISON_PLUIES", declare: true, motif: "Crues", declareLe: "2026-10-20T06:00:00Z", declarePar: { id: "u", nomComplet: "Chef" } },
      evenements: [{ evenementId: "e1", typeCode: "COUPURE", statut: "OUVERT", ouvertLe: "2026-10-20T06:00:00Z", texte: "Radier", tronconCode: "GN N0001", ageMinutes: 125, escalade: { niveau: 1, declencheeLe: "2026-10-20T07:00:00Z", destinataire: null, sansDestinataire: true } }],
      astreintes: [{ id: "a", niveau: 1, debut: "2026-10-20T00:00:00Z", fin: "2026-10-21T00:00:00Z", user: { id: "u", nomComplet: "Agent" }, region: null }],
      regles: { actives: 1, incoherences: [], aucuneRegle: false }, infoRouteEnCours: 1, signalementsNouveaux: 2, alertesSatelliteAVerifier: 1,
      patrouilles: [{ id: "p", code: "PAT-1", libelle: "RN1", echeance: { statut: "EN_RETARD", prochaine: "2026-10-16T00:00:00Z", joursRetard: 4 } }],
    },
    "/v2/exploitation/patrouilles/programmes": { programmes: [{
      id: "p1", code: "PAT-RN1", libelle: "RN1", classeAxe: "RN", periodiciteJours: 7, moisActifs: [6, 7], actif: true, dernierPassage: null,
      responsable: { id: "u", nomComplet: "Chef" }, _count: { troncons: 2 }, echeance: { statut: "A_JOUR", prochaine: "2026-10-27T00:00:00Z", joursRetard: 0 },
    }] },
    "/v2/exploitation/veille/personnes": { personnes: [{ id: "u", nomComplet: "Chef" }] },
    "/v2/exploitation/main-courante/evenements": { evenements: [{ evenementId: "ev", typeCode: "COUPURE", texte: "x", statut: "PRIS_EN_COMPTE", ouvertLe: "2026-10-20T06:00:00Z" }] },
    "/v2/exploitation/info-route/courante": { publications: [] },
    "/v2/exploitation/info-route/bulletins": { bulletins: [{ id: "b", numero: "BR-20261020-1", situationA: "2026-10-20T06:00:00Z", empreinteSha256: "a".repeat(64), publicationsIds: [] }] },
    "/v2/exploitation/veille/mode": { mode: "NORMAL", declare: false, motif: null },
    "/v2/exploitation/veille/regles": { regles: [{ id: "r", typeCode: null, mode: "TOUS", niveau: 1, delaiMinutes: 30, actif: true }] },
    "/v2/exploitation/veille/astreintes": { astreintes: [] },
    "/v2/exploitation/referentiels": { types: [{ code: "COUPURE", libelle: "Coupure" }] },
    "/regions": [{ id: 1, nom: "Conakry" }],
    "/v2/teledetection/propositions": { propositions: [{
      id: "pr", type: "INONDATION", methode: "seuil v0", score: 0.7, statut: "A_VERIFIER", distanceTronconM: 11, missionId: null, motifVerdict: null, constatRef: null,
      produit: { code: "S1", source: "Sentinel-1", dateAcquisition: "2026-10-02T00:00:00Z" }, troncon: { code: "GN N0001", nom: "Conakry" },
    }] },
    "/v2/teledetection/precision": { lignes: [{ type: "INONDATION", methode: "seuil v0", total: 1, aVerifier: 1, confirmees: 0, infirmees: 0, precision: null }] },
    "/v2/teledetection/produits": { produits: [] },
    "/v2/imports": { lots: [{
      id: "l1", reference: "IMP-2026-0001", systemeSource: "ANASUR", format: "CSV", nomFichier: "releve.csv", statut: "VALIDE_SCHEMA",
      importeLe: "2026-10-20T08:00:00Z", lignesLues: 10, lignesValidees: 9, lignesImportees: 0, lignesRejetees: 1, lignesEnConflit: 0, lignesIgnorees: 0,
    }] },
  };
});

describe("L'instrument mesure vraiment", () => {
  it("contre-epreuve : un fragment defectueux produit des violations", async () => {
    const { container } = render(
      <div>
        {/* Defaut VOLONTAIRE : c'est ce que la contre-epreuve doit faire detecter a axe. */}
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img src="x.png" />
        <input type="text" />
        <button type="button"></button>
      </div>,
    );
    const v = await violationsAccessibilite(container);
    const regles = v.map((x) => x.split(" ")[0]);
    expect(regles).toEqual(expect.arrayContaining(["image-alt", "label", "button-name"]));
  });
});

describe("Accessibilite des ecrans (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it.each([
    ["Cellule de veille", <CelluleVeillePage key="v" />, "cellule-veille"],
    ["Patrouilles", <PatrouillesPage key="p" />, /PAT-RN1/],
    ["Info Route", <InfoRoutePage key="i" />, /BR-20261020-1/],
    ["Configuration de la veille", <VeilleConfigurationPage key="c" />, /Tous modes · niveau 1/],
    ["Observation de la Terre", <TeledetectionPage key="t" />, /Rattachée à GN N0001/],
    ["Menu lateral", <Sidebar key="s" open />, /Cellule de veille/],
    ["Connexion", <LoginPage key="l" />, /./],
    ["Lots d'import", <ImportsPage key="im" />, /IMP-2026-0001/],
    ["Releve en vehicule (etat initial)", <ReleveVehiculePage key="rv" />, /État de la fonction/],
  ] as const)("%s : aucune violation", async (_nom, element, attente) => {
    const { container } = rendre(element);
    if (typeof attente === "string") await screen.findByTestId(attente, undefined, { timeout: 10_000 });
    else await screen.findAllByText(attente, undefined, { timeout: 10_000 });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});

describe("Accessibilite du releve en vehicule, resultat affiche", () => {
  it("aucune violation avec un resultat d'analyse (tableaux, avertissements, indicateurs)", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {
      parametres: { reseau: "reference", distanceMaxM: 50, pasMinM: 15, incertitudeParDefautM: 15, pointsMax: 3000 },
      indicateurs: { pointsLus: 300, pointsIgnores: 0, pointsRetenus: 276, retiresParPas: 24, pointsRattaches: 224, tauxRattachement: 0.812, pointsPrecisionInsuffisante: 0, transitionsNonVerifiees: 1, chaines: 1, distanceParcourueM: 5511, dureeS: 552, vitesseMoyenneKmH: 35.9, longueurSurReseauM: 4392 },
      passages: [{ tronconId: "t", code: "GN N0001", nom: "Conakry", indexDebut: 0, indexFin: 5, nombrePoints: 6, deM: 0, aM: 100, longueurM: 100, sens: "CROISSANT", court: false, geojson: null }],
      horsReferentiel: [{ indexDebut: 6, indexFin: 9, nombrePoints: 4, longueurM: 80, coordonnees: [[-13.6, 9.6]] }],
      trace: [[-13.6, 9.6], [-13.59, 9.6]], rattache: [true, false],
      avertissements: ["Aucune precision annoncee par le fichier."],
    } } as never);
    const { container } = rendre(<ReleveVehiculePage />);
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), new File(["<gpx></gpx>"], "sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    await screen.findByRole("table", { name: /Tronçons parcourus/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});
