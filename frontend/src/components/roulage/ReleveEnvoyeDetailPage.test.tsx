import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { violationsAccessibilite } from "../../test/accessibilite";
import { DETAIL_REEL_ECR1, DETAIL_REEL_ECR2, DETAIL_REEL_ECR3 } from "../../lib/roulageEnvoyes.reel.fixture";

/**
 * Detail d'un releve envoye : ce que ces tests defendent.
 *   - la trace, les reperes (code, heure, troncon et abscisse, ou motif), les segments et les troncons sont ceux du serveur, rien d'autre ;
 *   - une trace SIMPLIFIEE, ABSENTE, ou des positions detaillees manquantes sont DITES a cote de la carte ;
 *   - les avertissements de l'analyse du serveur sont montres tels quels ;
 *   - un repere dont la position vient d'un dernier point GPS ancien du telephone est signale (liste et carte), mais pas un repere retrouve
 *     SUR LA TRACE ; un repere sans position n'est pas place sur la carte mais reste liste ;
 *   - un taux non evalue se lit « non évalué », jamais « 0 % » ; « 0 % » reel est donne avec son denominateur ; un compte inconnu se lit « non communiqué » ;
 *   - 404, 403, reseau et reponse illisible ont chacun leur message, et seuls les echecs recuperables proposent « Réessayer » ;
 *   - la fiche d'un troncon rattache s'ouvre depuis la liste ;
 *   - zero violation d'accessibilite (axe-core) sur chaque vue.
 * DONNEES : les reponses REELLES du serveur (roulageEnvoyes.reel.fixture.ts : ECR-1 sur le reseau, ECR-2 hors reseau, ECR-3 de 25 000 positions),
 * modifiees seulement dans les cas qui le disent. jsdom ne rend pas Leaflet : la carte est un DOUBLE qui expose ce qu'on lui confie (lignes,
 * reperes). Le rendu reel est verifie dans un navigateur, contre l'API lancee sur PostGIS (voir docs/roulage/CONSULTATION.md, « Integration »).
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  user: { id: "agent-1", role: "INSPECTEUR" as string, nomComplet: "Agent Un", modulesAutorises: [] as string[] },
}));
vi.mock("../../lib/api", () => ({ api: { get: h.get } }));
vi.mock("../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("./CarteReleveEnvoye", () => ({
  CarteReleveEnvoye: ({ lignes, marqueurs }: { lignes: unknown[][]; marqueurs: { etiquette: string; approximative: boolean }[] }) => (
    <div data-testid="carte" data-lignes={lignes.length} data-points={lignes.reduce((n, l) => n + l.length, 0)}>
      Carte double : {lignes.length} ligne(s)
      <ul>{marqueurs.map((m) => <li key={m.etiquette}>{m.etiquette}{m.approximative ? " [approximatif]" : ""}</li>)}</ul>
    </div>
  ),
}));
vi.mock("../TronconFicheModal", () => ({
  TronconFicheModal: ({ tronconId, onClose }: { tronconId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Fiche tronçon (double)">Fiche du tronçon {tronconId}<button onClick={onClose}>Fermer la fiche</button></div>
  ),
}));

import { ReleveEnvoyeDetailPage } from "./ReleveEnvoyeDetailPage";

const ID = DETAIL_REEL_ECR1.id;
const AGENT = DETAIL_REEL_ECR1.agent;
const copie = <T,>(v: T): T => structuredClone(v);
/** Le releve ECR-1 reel, avec les seules modifications demandees. */
const ecr1 = (sur: Record<string, unknown> = {}) => ({ ...copie(DETAIL_REEL_ECR1), ...sur });
const marqueur = (sur: Record<string, unknown>) => ({ ...copie(DETAIL_REEL_ECR1.marqueurs[0]), ...sur });

const erreurHttp = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { error: "x", code: "X" } } });

function afficher(id = ID) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/inspections/releve/envoyes/${id}`]}>
        <Routes><Route path="/inspections/releve/envoyes/:id" element={<ReleveEnvoyeDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** La valeur d'une ligne du resume, lue dans sa section. */
function valeurResume(libelle: string): string {
  const section = screen.getByRole("region", { name: "Résumé du relevé" });
  const dt = within(section).getByText(libelle, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
}

beforeEach(() => {
  h.get.mockReset();
  h.user = { id: AGENT.id, role: "INSPECTEUR", nomComplet: AGENT.nom, modulesAutorises: [] };
});

describe("releve reel sur le reseau (ECR-1)", () => {
  it("interroge le detail par son identifiant et titre la page avec la date du releve", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    expect(await screen.findByRole("heading", { level: 1, name: /^Relevé du \d{2}\/\d{2}\/2026 à \d{2}:\d{2}$/ })).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledWith(`/v2/roulage/sessions/${ID}`);
    expect(screen.getByRole("link", { name: /Relevés envoyés/ })).toHaveAttribute("href", "/inspections/releve/envoyes");
  });

  it("confie a la carte la ligne de la trace et les deux reperes, avec code et heure, sans les dire approximatifs", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    const carte = await screen.findByTestId("carte");
    expect(carte).toHaveAttribute("data-lignes", "1");
    expect(carte).toHaveAttribute("data-points", String(DETAIL_REEL_ECR1.geometrie.coordinates[0].length));
    expect(within(carte).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      expect.stringMatching(/^NID_DE_POULE à \d{2}:\d{2}:\d{2}$/),
      expect.stringMatching(/^NID_DE_POULE à \d{2}:\d{2}:\d{2}$/),
    ]);
    expect(screen.queryByText(/Trace non disponible/)).toBeNull();
    expect(screen.queryByText(/Trace simplifiée/)).toBeNull();
  });

  it("le resume chiffre vient du serveur : distance PARCOURUE, taux et son denominateur, trous, interruptions, pauses", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    await screen.findByTestId("carte");
    expect(valeurResume("Rattachement au réseau")).toBe("100 %");
    expect(valeurResume("Distance parcourue")).toBe("2,8 km");
    expect(screen.queryByText("Distance estimée")).toBeNull();
    expect(valeurResume("Durée")).toBe("4 min 40 s");
    expect(valeurResume("Positions enregistrées")).toBe("281");
    expect(valeurResume("Positions retenues par l'analyse")).toBe("141");
    expect(valeurResume("dont rattachées au réseau")).toBe("141");
    expect(valeurResume("Trous de signal")).toBe("0");
    expect(valeurResume("Interruptions")).toBe("0");
    expect(valeurResume("Pauses")).toBe("0");
    expect(valeurResume("Positions écartées par l'appareil")).toBe("0");
    expect(valeurResume("Tronçons rattachés")).toBe("2");
  });

  it("dit que la distance parcourue n'est pas la longueur du tracé dessiné", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    await screen.findByTestId("carte");
    expect(within(screen.getByRole("region", { name: "Résumé du relevé" })).getByText(/ce n'est pas la longueur du tracé dessiné sur la carte/)).toBeInTheDocument();
  });

  it("montre les avertissements du serveur tels quels, et la provenance des seuils en francais avec les seuils tels qu'enregistres", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    await screen.findByTestId("carte");
    const resume = screen.getByRole("region", { name: "Résumé du relevé" });
    expect(within(resume).getByText("Avertissements de l'analyse du serveur")).toBeInTheDocument();
    for (const a of DETAIL_REEL_ECR1.analyse.serveur.avertissements) expect(within(resume).getByText(a)).toBeInTheDocument();
    expect(within(resume).getByText("Paramètres de l'enregistrement : seuils provisoires, non calibrés (version du contrat 1).")).toBeInTheDocument();
    const details = within(resume).getByText(/Seuils appliqués par le téléphone \(15\)/);
    await userEvent.click(details);
    expect(within(resume).getByText("trouMs").nextElementSibling).toHaveTextContent("5000");
  });

  it("liste les reperes avec leur note, leur position et leur source, et leur rattachement au troncon avec la distance depuis son debut", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    const tableau = await screen.findByRole("table", { name: /Repères posés pendant le relevé/ });
    const lignes = within(tableau).getAllByRole("row").slice(1);
    expect(lignes).toHaveLength(2);
    expect(within(lignes[0]).getByText("premier repere")).toBeInTheDocument();
    expect(within(lignes[0]).getByText(/9\.64000, -13\.59453 \(± 5 m\)/)).toBeInTheDocument();
    expect(within(lignes[0]).getByText("position retrouvée sur la trace à l'instant de pose")).toBeInTheDocument();
    expect(within(lignes[0]).getByText("rattaché à un tronçon ECR-1, à 600 m du début du tronçon")).toBeInTheDocument();
    expect(within(lignes[1]).getByText("rattaché à un tronçon ECR-2, à 1,0 km du début du tronçon")).toBeInTheDocument();
    expect(within(lignes[0]).queryByText(/Position périmée/)).toBeNull();
  });

  it("liste les segments avec le choix de l'agent en codes et le resultat du serveur", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    const tableau = await screen.findByRole("table", { name: /Segments relevés/ });
    const lignes = within(tableau).getAllByRole("row").slice(1);
    expect(lignes).toHaveLength(2);
    expect(within(lignes[0]).getByText("état MAUVAIS")).toBeInTheDocument();
    expect(within(lignes[0]).getByText("portions proposées")).toBeInTheDocument();
    expect(within(lignes[0]).getByText("clos")).toBeInTheDocument();
    expect(screen.queryByText(/ne les détaille pas/)).toBeNull();
  });

  it("le compte de troncons detailles est celui du serveur : 2 troncons, portions ET reperes regroupes, sans note de manque", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    const section = await screen.findByRole("region", { name: /Tronçons rattachés \(2\)/ });
    expect(within(section).getByText("ECR-1 : Route ECR-1")).toBeInTheDocument();
    expect(within(section).getByText("ECR-2 : Route ECR-2")).toBeInTheDocument();
    expect(within(section).getAllByText(/^Segment ETAT_CHAUSSEE : de /)).toHaveLength(3);
    expect(within(section).getByText(/Segment ETAT_CHAUSSEE : de 400 m à 900 m depuis le début du tronçon, sens croissant/)).toBeInTheDocument();
    expect(within(section).getAllByText(/^Repère NID_DE_POULE à \d{2}:\d{2}:\d{2} : rattaché à un tronçon/)).toHaveLength(2);
    expect(within(section).queryByRole("status")).toBeNull();
  });

  it("ouvre la fiche du troncon depuis la liste", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    afficher();
    const section = await screen.findByRole("region", { name: /Tronçons rattachés \(2\)/ });
    await userEvent.click(within(section).getByRole("button", { name: "Ouvrir la fiche du tronçon ECR-1 : Route ECR-1" }));
    const fiche = screen.getByRole("dialog", { name: "Fiche tronçon (double)" });
    expect(fiche).toHaveTextContent("Fiche du tronçon t-ecr-1");
    await userEvent.click(within(fiche).getByRole("button", { name: "Fermer la fiche" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dit quand le serveur compte plus de troncons que ceux detailles", async () => {
    h.get.mockResolvedValue({ data: ecr1({ nbTronconsTraverses: 4 }) });
    afficher();
    expect(await screen.findByText(/4 tronçons rattachés ; 2 seulement sont détaillés/)).toBeInTheDocument();
  });

  it("l'agent n'est montre que s'il est utile : role multi-agents, ou releve d'un autre agent", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    const { unmount } = afficher();
    await screen.findByTestId("carte");
    expect(screen.queryByText("Agent", { selector: "dt" })).toBeNull();
    unmount();

    h.user = { ...h.user, id: "un-autre-compte" };
    afficher();
    await screen.findByTestId("carte");
    expect(screen.getByText("Agent", { selector: "dt" }).nextElementSibling).toHaveTextContent(AGENT.nom);
  });
});

describe("releve reel hors reseau (ECR-2)", () => {
  it("« 0 % » est une valeur reelle donnee avec son denominateur, avec l'avertissement du serveur", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR2 });
    afficher(DETAIL_REEL_ECR2.id);
    await screen.findByTestId("carte");
    expect(valeurResume("Rattachement au réseau")).toBe("0 %");
    expect(valeurResume("Positions retenues par l'analyse")).toBe("45");
    expect(valeurResume("dont rattachées au réseau")).toBe("0");
    expect(valeurResume("Distance parcourue")).toBe("878 m");
    expect(valeurResume("Tronçons rattachés")).toBe("0");
    expect(screen.getByText(/^Moins de la moitie des points sont expliques par le reseau choisi/)).toBeInTheDocument();
  });

  it("le repere non rattache dit POURQUOI (motif du serveur), sans troncon ni abscisse invente", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR2 });
    afficher(DETAIL_REEL_ECR2.id);
    const tableau = await screen.findByRole("table", { name: /Repères posés/ });
    const ligne = within(tableau).getAllByRole("row")[1];
    expect(within(ligne).getByText("non rattaché à un tronçon (aucun point de la trace n'était rattaché au réseau près de l'instant de pose)")).toBeInTheDocument();
    expect(within(ligne).queryByText(/du début du tronçon/)).toBeNull();
  });

  it("le segment non rattache dit pourquoi, et aucun troncon n'est liste", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR2 });
    afficher(DETAIL_REEL_ECR2.id);
    const tableau = await screen.findByRole("table", { name: /Segments relevés/ });
    const ligne = within(tableau).getAllByRole("row")[1];
    expect(within(ligne).getByText("non rattaché au réseau (aucun point de la trace rattaché au réseau au début du segment)")).toBeInTheDocument();
    expect(within(ligne).getByText("aucune qualification")).toBeInTheDocument();
    expect(screen.getByText("Aucun tronçon n'est rattaché à un segment ou à un repère de ce relevé.")).toBeInTheDocument();
  });
});

describe("releve reel de 25 000 positions (ECR-3)", () => {
  it("trace SIMPLIFIEE : la carte est montree avec la mention, et sans repere ni segment les sections le disent", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR3 });
    afficher(DETAIL_REEL_ECR3.id);
    expect(await screen.findByText(/Trace simplifiée pour l'affichage : le serveur a enregistré 25\s000 positions/)).toBeInTheDocument();
    expect(screen.getByTestId("carte")).toBeInTheDocument();
    expect(screen.getByText("Aucun repère n'a été posé pendant ce relevé.")).toBeInTheDocument();
    expect(screen.getByText("Aucun segment n'a été relevé pendant ce trajet.")).toBeInTheDocument();
    expect(valeurResume("Distance parcourue")).toBe("18,9 km");
  });
});

describe("variantes du releve reel (une modification a la fois)", () => {
  it("geometrie ABSENTE : « Trace non disponible », et les reperes places restent sur la carte", async () => {
    h.get.mockResolvedValue({ data: ecr1({ geometrie: null }) });
    afficher();
    expect(await screen.findByText(/Trace non disponible/)).toBeInTheDocument();
    const carte = screen.getByTestId("carte");
    expect(carte).toHaveAttribute("data-lignes", "0");
    expect(within(carte).getAllByRole("listitem")).toHaveLength(2);
  });

  it("ni trace ni repere place : pas de carte, une phrase", async () => {
    h.get.mockResolvedValue({ data: ecr1({ geometrie: null, marqueurs: [], nbMarqueurs: 0 }) });
    afficher();
    expect(await screen.findByText(/Aucune carte à afficher/)).toBeInTheDocument();
    expect(screen.queryByTestId("carte")).toBeNull();
    expect(screen.getByText("Aucun repère n'a été posé pendant ce relevé.")).toBeInTheDocument();
  });

  it("repere a position du TELEPHONE perimee : approximatif sur la carte, avec la note", async () => {
    h.get.mockResolvedValue({ data: ecr1({ marqueurs: [marqueur({ positionPerimee: true, sourcePosition: "APPAREIL" })] }) });
    afficher();
    const carte = await screen.findByTestId("carte");
    expect(within(carte).getByRole("listitem")).toHaveTextContent(/\[approximatif\]$/);
    const ligne = within(await screen.findByRole("table", { name: /Repères posés/ })).getAllByRole("row")[1];
    expect(within(ligne).getByText(/Position périmée.*l'emplacement est approximatif/)).toBeInTheDocument();
    expect(within(ligne).getByText("position du téléphone (pas de trace à cet instant)")).toBeInTheDocument();
  });

  it("repere retrouve SUR LA TRACE alors que le dernier point du telephone etait ancien : pas approximatif, la note l'explique", async () => {
    h.get.mockResolvedValue({ data: ecr1({ marqueurs: [marqueur({ positionPerimee: true, sourcePosition: "TRACE" })] }) });
    afficher();
    const carte = await screen.findByTestId("carte");
    expect(within(carte).getByRole("listitem")).not.toHaveTextContent(/approximatif/);
    const ligne = within(await screen.findByRole("table", { name: /Repères posés/ })).getAllByRole("row")[1];
    expect(within(ligne).getByText(/la position affichée est celle de la trace à cet instant/)).toBeInTheDocument();
    expect(within(ligne).queryByText(/Position périmée/)).toBeNull();
  });

  it("un repere sans position est liste mais n'est pas place sur la carte", async () => {
    h.get.mockResolvedValue({ data: ecr1({ marqueurs: [marqueur({ lat: null, lon: null, sourcePosition: null, precisionM: null, positionPerimee: true, statut: "NON_RATTACHE", motif: "POSITION_INCONNUE", tronconId: null, tronconCode: null, abscisseM: null })] }) });
    afficher();
    await screen.findByTestId("carte");
    expect(within(screen.getByTestId("carte")).queryAllByRole("listitem")).toHaveLength(0);
    const ligne = within(await screen.findByRole("table", { name: /Repères posés/ })).getAllByRole("row")[1];
    expect(within(ligne).getByText("aucune position")).toBeInTheDocument();
    expect(within(ligne).getByText(/Aucune position connue pour ce repère/)).toBeInTheDocument();
    expect(within(ligne).getByText("non rattaché à un tronçon (position inconnue à l'instant de pose)")).toBeInTheDocument();
    expect(screen.getByText(/1 repère\(s\) sans position ne sont pas placés sur la carte/)).toBeInTheDocument();
  });

  it("le taux null se lit « non évalué », la distance null « non calculée », jamais 0", async () => {
    h.get.mockResolvedValue({ data: ecr1({ tauxRattachement: null, longueurM: null, analyse: { compteurs: {}, trous: null, interruptions: null, pauses: null, serveur: null } }) });
    afficher();
    await screen.findByTestId("carte");
    expect(valeurResume("Rattachement au réseau")).toBe("non évalué");
    expect(valeurResume("Distance parcourue")).toBe("non calculée");
    expect(valeurResume("Trous de signal")).toBe("non communiqué");
    expect(screen.queryByText("Positions retenues par l'analyse")).toBeNull();
    expect(screen.queryByText("Avertissements de l'analyse du serveur")).toBeNull();
    expect(screen.getByRole("region", { name: "Résumé du relevé" }).textContent).not.toMatch(/\b0 %/);
  });

  it("des portions refusees par le serveur ne sont pas listees : la page le dit, et le motif du serveur est donne", async () => {
    const refusee = { ...copie(DETAIL_REEL_ECR1.evenements[0]), statutRattachement: "PORTIONS_REFUSEES", motif: "CODE_REFERENTIEL_INCONNU:etat", portions: [] };
    h.get.mockResolvedValue({ data: ecr1({ evenements: [refusee] }) });
    afficher();
    const ligne = within(await screen.findByRole("table", { name: /Segments relevés/ })).getAllByRole("row")[1];
    expect(within(ligne).getByText("portions refusées par le serveur (code de référentiel inconnu (etat))")).toBeInTheDocument();
    expect(screen.getByText(/ne les détaille pas/)).toBeInTheDocument();
  });

  it("un segment abandonne cite le motif ecrit par l'agent", async () => {
    const abandonne = { ...copie(DETAIL_REEL_ECR1.evenements[0]), statutAppareil: "ABANDONNE", finA: null, statutRattachement: "ABANDONNE", motif: "ABANDONNE_PAR_AGENT", portions: [] };
    h.get.mockResolvedValue({ data: ecr1({ evenements: [abandonne] }) });
    afficher();
    const ligne = within(await screen.findByRole("table", { name: /Segments relevés/ })).getAllByRole("row")[1];
    expect(within(ligne).getByText("abandonné par l'agent (motif écrit par l'agent : « ABANDONNE_PAR_AGENT »)")).toBeInTheDocument();
    expect(within(ligne).getByText("non terminé")).toBeInTheDocument();
  });

  it("les positions detaillees non conservees (pointsDisponibles faux) sont dites", async () => {
    h.get.mockResolvedValue({ data: ecr1({ trace: { nbPoints: 281, pointsDisponibles: false } }) });
    afficher();
    expect(await screen.findByText(/Les positions détaillées de ce relevé ne sont pas disponibles sur le serveur/)).toBeInTheDocument();
  });

  it("aucun segment, aucun repere : phrases honnetes, pas de tableau vide", async () => {
    h.get.mockResolvedValue({ data: ecr1({ evenements: [], nbEvenements: 0, marqueurs: [], nbMarqueurs: 0, nbTronconsTraverses: 0 }) });
    afficher();
    expect(await screen.findByText("Aucun segment n'a été relevé pendant ce trajet.")).toBeInTheDocument();
    expect(screen.getByText("Aucun tronçon n'est rattaché à un segment ou à un repère de ce relevé.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Segments relevés/ })).toBeNull();
  });
});

describe("etats", () => {
  it("chargement : un message de statut", async () => {
    h.get.mockReturnValue(new Promise(() => undefined));
    afficher();
    expect(await screen.findByRole("status")).toHaveTextContent("Chargement du relevé");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("404 : « introuvable », sans « Réessayer », avec le retour a la liste", async () => {
    h.get.mockRejectedValue(erreurHttp(404));
    afficher();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Relevé introuvable/);
    expect(within(alerte).queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(within(alerte).getByRole("link", { name: "Retour à la liste" })).toHaveAttribute("href", "/inspections/releve/envoyes");
  });

  it("403 : acces refuse, sans « Réessayer »", async () => {
    h.get.mockRejectedValue(erreurHttp(403));
    afficher();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Accès refusé/);
    expect(within(alerte).queryByRole("button", { name: "Réessayer" })).toBeNull();
  });

  it("reseau : une alerte, et « Réessayer » relance la requete", async () => {
    h.get.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValueOnce({ data: DETAIL_REEL_ECR1 });
    afficher();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/n'a pas répondu/);
    await userEvent.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByTestId("carte")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reponse illisible : une alerte, le releve n'est pas montre", async () => {
    h.get.mockResolvedValue({ data: { id: ID } });
    afficher();
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'a pas pu être lu/);
    expect(screen.queryByTestId("carte")).toBeNull();
  });

  it("un repere dont la forme n'est pas celle du contrat rend toute la reponse illisible (pas de page a moitie fausse)", async () => {
    h.get.mockResolvedValue({ data: ecr1({ marqueurs: [marqueur({ lat: "9.6" })] }) });
    afficher();
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'a pas pu être lu/);
    expect(screen.queryByRole("table", { name: /Repères posés/ })).toBeNull();
  });
});

describe("accessibilite (axe-core)", () => {
  it("releve reel sur le reseau, avertissements et seuils ouverts compris", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    const { container } = afficher();
    await userEvent.click(await screen.findByText(/Seuils appliqués par le téléphone/));
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("releve reel sur le reseau avec la fiche d'un troncon ouverte", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR1 });
    const { container } = afficher();
    await userEvent.click((await screen.findAllByRole("button", { name: /Ouvrir la fiche/ }))[0]);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("releve reel hors reseau (motifs, 0 %)", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR2 });
    const { container } = afficher(DETAIL_REEL_ECR2.id);
    await screen.findByTestId("carte");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("releve reel simplifie de 25 000 positions", async () => {
    h.get.mockResolvedValue({ data: DETAIL_REEL_ECR3 });
    const { container } = afficher(DETAIL_REEL_ECR3.id);
    await screen.findByText(/Trace simplifiée/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("trace absente, positions non conservees et reperes sans position", async () => {
    h.get.mockResolvedValue({ data: ecr1({ geometrie: null, simplifiee: true, marqueurs: [marqueur({ lat: null, lon: null, sourcePosition: null, positionPerimee: true, statut: "NON_RATTACHE", motif: "POSITION_INCONNUE", tronconId: null, tronconCode: null, abscisseM: null })], trace: { nbPoints: 9, pointsDisponibles: false } }) });
    const { container } = afficher();
    await screen.findByText(/Trace non disponible/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("sans segment ni repere", async () => {
    h.get.mockResolvedValue({ data: ecr1({ marqueurs: [], evenements: [], geometrie: null }) });
    const { container } = afficher();
    await screen.findByText(/Aucune carte à afficher/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
  it("erreur et introuvable", async () => {
    h.get.mockRejectedValue(erreurHttp(404));
    const { container } = afficher();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
