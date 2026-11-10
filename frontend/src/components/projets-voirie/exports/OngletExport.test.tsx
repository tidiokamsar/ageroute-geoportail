import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), enregistrer: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock("../../../lib/download", async (orig) => ({ ...(await orig<typeof import("../../../lib/download")>()), enregistrerBlob: h.enregistrer }));

import { OngletExport } from "./OngletExport";
import { violationsAccessibilite } from "../../../test/accessibilite";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";

/**
 * Onglet « Export » (lot X1, interface UI-D). Donnees 100 % SYNTHETIQUES. On verifie : ce que l'archive contiendra et ce qui en sera exclu (prevision
 * selon le contrat, le manifeste faisant foi), la fabrication (parametres, attente bornee et annulable, telechargement, en-tetes), les erreurs typees
 * relues dans un corps Blob (422 volumes, 504, 429 Retry-After, 503, 409 derogation), le journal, les derogations (ADMIN : autre personne, separation des
 * taches ; beneficiaire : exporter avec la sienne), les roles (sur contenu charge, contre-epreuve ADMIN), le hors ligne et axe.
 */

configure({ asyncUtilTimeout: 8000 });
const B = "/v2/projets-voirie/p1";
const MOI = "u-moi";
const UUID_DER = "0d2c8a6e-3b1f-4c5d-9e7a-1234567890ab";

const JEUX = [
  { id: "j-axes", nomFichier: "axes-synth.geojson", role: "AXES_TRAVAUX", version: 1, statut: "AUTORISE", confidentialite: "RESTREINT_PROJET" },
  { id: "j-tel", nomFichier: "telecom-synth.geojson", role: "RESEAU_TIERS", version: 2, statut: "AUTORISE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" },
  { id: "j-eau", nomFichier: "eau-synth.geojson", role: "RESEAU_TIERS", version: 1, statut: "CONTROLE", confidentialite: "INFRASTRUCTURE_SENSIBLE" },
] as unknown as JeuProjet[];

const derogation = (id: string, over: Record<string, unknown> = {}) => ({
  id, projetId: "p1", jeuxIds: ["j-tel"], beneficiaire: { id: "u-gest", nomComplet: "Gestionnaire Synth" }, accordeePar: { id: "u-autre-admin", nomComplet: "Admin Synth" },
  justification: "Transmission au bureau d'études pour reprise", createdAt: "2026-11-10T06:00:00Z", expireLe: "2026-11-11T06:00:00Z", utiliseeLe: null, exportId: null, etat: "DISPONIBLE", ...over,
});

interface Etat { journal: unknown[]; derogations: unknown[]; miennes: unknown[]; erreurs: Record<string, unknown> }
let e: Etat;
const blobJson = (o: unknown) => new Blob([JSON.stringify(o)], { type: "application/json" });
const ZIP_OK = () => ({
  data: new Blob(["PK synthetique"], { type: "application/zip" }),
  headers: { "content-disposition": 'attachment; filename="dossier-syn-01-2026-11-10.zip"', "x-export-id": "exp-1", "x-empreinte-sha256": "e".repeat(64), "x-fichiers": "11", "x-jeux-geojson": "1" },
});

function installer() {
  h.get.mockImplementation(async (url: string, cfg: { params?: Record<string, unknown> } = {}) => {
    const err = e.erreurs[url];
    if (err) { delete e.erreurs[url]; throw err; }
    if (url === `${B}/export/journal`) return { data: { exports: e.journal } };
    if (url === `${B}/export/derogations`) return { data: { derogations: e.derogations } };
    if (url === `${B}/export/derogations/miennes`) return { data: { derogations: e.miennes } };
    if (url === "/users" && cfg.params?.role === "ADMIN") return { data: { data: [{ id: MOI, nomComplet: "Moi Admin", email: "moi@example.test", modulesAutorises: [] }], total: 1 } };
    if (url === "/users" && cfg.params?.role === "GESTIONNAIRE") return { data: { data: [
      { id: "u-gest", nomComplet: "Gestionnaire Synth", email: "g@example.test", modulesAutorises: ["projets-voirie"] },
      { id: "u-sans", nomComplet: "Sans Cle", email: "s@example.test", modulesAutorises: ["autre"] },
    ], total: 2 } };
    if (url === `${B}/export/dossier`) return ZIP_OK();
    return { data: {} };
  });
}

function rendre(p: { estAdmin?: boolean; enLigne?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OngletExport projetId="p1" code="SYN-01" jeux={JEUX} actif estAdmin={p.estAdmin ?? false} compteId={MOI} enLigne={p.enLigne ?? true} /></QueryClientProvider>);
}
const appelsExport = () => h.get.mock.calls.filter((c) => c[0] === `${B}/export/dossier`);

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.enregistrer.mockReset();
  e = { journal: [{ id: "t1", acteur: { id: "u-gest", nomComplet: "Gestionnaire Synth" }, statut: "ECHEC", codeEchec: "EXPORT_TROP_VOLUMINEUX", createdAt: "2026-11-09T10:00:00Z" }], derogations: [derogation("d-1")], miennes: [], erreurs: {} };
  installer();
});

describe("contenu annonce et prevision", () => {
  it("ce que l'archive contiendra ; GeoJSON : inclus et exclus avec leur raison (confidentiel, non autorise)", async () => {
    rendre();
    await screen.findByRole("list", { name: "Tentatives d'export" });
    expect(screen.getByText(/manifeste.json et manifeste.sha256/)).toBeInTheDocument();
    const a = screen.getByTestId("apercu-geojson");
    expect(a).toHaveTextContent(/Inclus : axes-synth.geojson, v1 \(Restreint au projet\)/);
    expect(a).toHaveTextContent(/Exclu : telecom-synth.geojson, v2 : niveau confidentiel : exclu sans dérogation/);
    expect(a).toHaveTextContent(/Exclu : eau-synth.geojson, v1 : jeu non autorisé/);
    expect(a).toHaveTextContent(/le manifeste de l'archive fait foi/);
  });
  it("GeoJSON decoche : rien n'est prevu, aucun choix de derogation, geojson=false envoye", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("list", { name: "Tentatives d'export" });
    await u.click(screen.getByLabelText("Inclure le tracé GeoJSON des jeux exportables"));
    expect(screen.getByTestId("apercu-geojson")).toHaveTextContent("Aucun jeu ne sortira en GeoJSON.");
    expect(screen.queryByRole("group", { name: /Dérogation/ })).toBeNull();
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    await waitFor(() => expect(appelsExport()[0][1]).toMatchObject({ params: { geojson: "false" } }));
  });
});

describe("fabrication et telechargement", () => {
  it("parametres, attente bornee (timeout), archive remise au navigateur, en-tetes lus, journal relu", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("list", { name: "Tentatives d'export" });
    const appelsJournal = () => h.get.mock.calls.filter((c) => c[0] === `${B}/export/journal`).length;
    const avant = appelsJournal();
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    const r = await screen.findByTestId("export-remis");
    expect(appelsExport()[0][1]).toMatchObject({ params: { geojson: "true" }, responseType: "blob", timeout: 70000 });
    expect(h.enregistrer).toHaveBeenCalledWith(expect.any(Blob), "dossier-syn-01-2026-11-10.zip");
    expect(r).toHaveTextContent(/11 fichiers, dont 1 GeoJSON/);
    expect(r).toHaveTextContent("e".repeat(64));
    expect(screen.queryByTestId("ecart-prevision")).toBeNull();
    await waitFor(() => expect(appelsJournal()).toBeGreaterThan(avant));
  });
  it("ecart entre la prevision et le serveur : dit, le manifeste fait foi", async () => {
    h.get.mockImplementation(async (url: string) => (url === `${B}/export/dossier` ? { ...ZIP_OK(), headers: { ...ZIP_OK().headers, "x-jeux-geojson": "0" } } : url === `${B}/export/journal` ? { data: { exports: [] } } : { data: {} }));
    const u = userEvent.setup();
    rendre();
    await screen.findByText(/Aucun export n'a encore été demandé/);
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    expect(await screen.findByTestId("ecart-prevision")).toHaveTextContent(/0 GeoJSON pour 1 prévu/);
  });
  it("attente : duree affichee et annulation (tentative non recue, derogation liberee)", async () => {
    h.get.mockImplementation(async (url: string, cfg: { signal?: AbortSignal } = {}) => {
      if (url === `${B}/export/dossier`) {
        return new Promise((_ok, ko) => cfg.signal?.addEventListener("abort", () => ko({ name: "CanceledError", code: "ERR_CANCELED" })));
      }
      return url === `${B}/export/journal` ? { data: { exports: [] } } : { data: {} };
    });
    const u = userEvent.setup();
    rendre();
    await screen.findByText(/Aucun export n'a encore été demandé/);
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    expect(await screen.findByTestId("attente-export")).toHaveTextContent(/au-delà de 50 s.*après 70 s/);
    expect(screen.getByRole("button", { name: /Fabrication en cours/ })).toBeDisabled();
    await u.click(screen.getByRole("button", { name: "Annuler" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/annulée.*libérée, non consommée/);
    expect(h.enregistrer).not.toHaveBeenCalled();
  });
  it.each([
    [422, { code: "EXPORT_TROP_VOLUMINEUX", objets: 60000, objetsMax: 50000 }, {}, /60 000 objets pour 50 000 au plus.*sans GeoJSON/],
    [504, { code: "EXPORT_TROP_LONG" }, {}, /délai autorisé/],
    [429, { code: "EXPORT_TROP_FREQUENT" }, { "retry-after": "1200" }, /1200 secondes/],
    [503, { code: "SERVICE_OCCUPE" }, {}, /attendez sa fin/],
    [409, { code: "DEROGATION_INDISPONIBLE", etat: "UTILISEE" }, {}, /usage unique/],
    [404, { code: "PROJET_INTROUVABLE" }, {}, /périmètre/],
    [400, { code: "PARAMETRES_INVALIDES" }, {}, /paramètres/],
    [403, {}, {}, /clé de module/],
  ])("erreur %s relue dans son corps Blob : expliquee, aucune archive", async (status, corps, headers, motif) => {
    e.erreurs[`${B}/export/dossier`] = { response: { status, data: blobJson(corps), headers } };
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("list", { name: "Tentatives d'export" });
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(motif);
    expect(h.enregistrer).not.toHaveBeenCalled();
  });
  it("504 du mandataire (corps HTML illisible) : explique sans planter", async () => {
    e.erreurs[`${B}/export/dossier`] = { response: { status: 504, data: new Blob(["<html>Gateway</html>"]), headers: {} } };
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("list", { name: "Tentatives d'export" });
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/mandataire/);
  });
  it("hors ligne : export impossible, dit", async () => {
    rendre({ enLigne: false });
    await screen.findByRole("list", { name: "Tentatives d'export" });
    expect(screen.getByRole("button", { name: /Fabriquer et télécharger/ })).toBeDisabled();
    expect(screen.getByText(/hors ligne : l'export est impossible/)).toBeInTheDocument();
  });
  it("journal : 404 masque introuvable, hors ligne reseau", async () => {
    e.erreurs[`${B}/export/journal`] = { response: { status: 404, data: { code: "PROJET_INTROUVABLE" } } };
    const a = rendre();
    expect(await screen.findByText(/Journal des exports : introuvable/)).toBeInTheDocument();
    a.unmount();
    e.erreurs[`${B}/export/journal`] = new Error("Network Error");
    rendre();
    expect(await screen.findByText(/Journal des exports : réseau indisponible/)).toBeInTheDocument();
  });
});

describe("derogations", () => {
  it("GESTIONNAIRE beneficiaire (ecart E1 du lot UI-D) : la derogation qui le designe est listee et utilisable, sans la liste ADMIN", async () => {
    const u = userEvent.setup();
    e.miennes = [derogation("0f0e0d0c-0b0a-4908-8706-050403020100", { beneficiaire: { id: MOI, nomComplet: "Moi Gestionnaire" } })];
    rendre({ estAdmin: false });
    const choix = await screen.findByLabelText(/Dérogation accordée par Admin Synth/);
    expect(h.get.mock.calls.some((c) => c[0] === `${B}/export/derogations`)).toBe(false);
    expect(h.get.mock.calls.some((c) => c[0] === `${B}/export/derogations/miennes`)).toBe(true);
    await u.click(choix);
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    await waitFor(() => expect(appelsExport()[0][1]).toMatchObject({ params: { geojson: "true", derogation: "0f0e0d0c-0b0a-4908-8706-050403020100" } }));
  });

  it("GESTIONNAIRE : une derogation renvoyee pour un AUTRE beneficiaire n'est jamais proposee (filtre client en plus du serveur)", async () => {
    e.miennes = [derogation("d-autre")];
    rendre({ estAdmin: false });
    await screen.findByRole("list", { name: "Tentatives d'export" });
    await waitFor(() => expect(h.get.mock.calls.some((c) => c[0] === `${B}/export/derogations/miennes`)).toBe(true));
    expect(screen.queryByLabelText(/Dérogation accordée par/)).toBeNull();
  });

  it("GESTIONNAIRE (sur contenu charge) : aucun bouton d'octroi ni liste ; il saisit l'identifiant communique", async () => {
    const u = userEvent.setup();
    rendre({ estAdmin: false });
    await screen.findByRole("list", { name: "Tentatives d'export" });
    expect(screen.queryByRole("button", { name: /Accorder une dérogation/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Dérogations du projet" })).toBeNull();
    expect(h.get.mock.calls.some((c) => c[0] === `${B}/export/derogations`)).toBe(false);
    await u.click(screen.getByLabelText(/m'a communiqué l'identifiant/));
    const champ = screen.getByLabelText("Identifiant de la dérogation");
    await u.type(champ, "pas-un-uuid");
    expect(screen.getByRole("button", { name: /Fabriquer et télécharger/ })).toBeDisabled();
    await u.clear(champ);
    await u.type(champ, UUID_DER);
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    await waitFor(() => expect(appelsExport()[0][1]).toMatchObject({ params: { geojson: "true", derogation: UUID_DER } }));
    // L'identifiant ne reste pas a l'ecran apres l'usage.
    await screen.findByTestId("export-remis");
    expect(screen.queryByLabelText("Identifiant de la dérogation")).toBeNull();
  });
  it("contre-epreuve ADMIN : liste avec etats et bouton d'octroi", async () => {
    e.derogations = [derogation("d-1"), derogation("d-2", { etat: "UTILISEE", utiliseeLe: "2026-11-10T07:00:00Z" }), derogation("d-3", { etat: "EXPIREE" }), derogation("d-4", { etat: "RESERVEE" })];
    rendre({ estAdmin: true });
    const l = await screen.findByRole("list", { name: "Dérogations du projet" });
    expect(within(l).getAllByRole("listitem").map((x) => x.getAttribute("data-etat-derogation"))).toEqual(["DISPONIBLE", "UTILISEE", "EXPIREE", "RESERVEE"]);
    expect(l).toHaveTextContent(/Réservée par un export en cours/);
    expect(l).toHaveTextContent(/telecom-synth.geojson/);
    expect(l).toHaveTextContent("d-1");
    expect(screen.getByRole("button", { name: /Accorder une dérogation/ })).toBeInTheDocument();
  });
  it("octroi : l'ADMIN ne peut pas se choisir ; jeux confidentiels autorises seulement ; corps du contrat ; 409 et 422 expliques", async () => {
    h.post
      .mockRejectedValueOnce({ response: { status: 422, data: { code: "BENEFICIAIRE_HORS_PERIMETRE" } } })
      .mockRejectedValueOnce({ response: { status: 409, data: { code: "SEPARATION_DES_TACHES" } } })
      .mockResolvedValueOnce({ data: { derogation: derogation("d-9") } });
    const u = userEvent.setup();
    rendre({ estAdmin: true });
    await screen.findByRole("list", { name: "Dérogations du projet" });
    await u.click(screen.getByRole("button", { name: /Accorder une dérogation/ }));
    const d = await screen.findByRole("dialog", { name: "Accorder une dérogation de confidentialité" });
    const comptes = await within(d).findByRole("region", { name: /Comptes bénéficiaires possibles/ });
    expect(within(comptes).queryByText(/Moi Admin/)).toBeNull();
    expect(within(comptes).getByRole("radio", { name: /Sans Cle/ })).toBeDisabled();
    expect(within(d).queryByRole("checkbox", { name: /axes-synth/ })).toBeNull();
    expect(within(d).queryByRole("checkbox", { name: /eau-synth/ })).toBeNull();
    expect(within(d).getByText(/ne pouvez pas vous choisir/)).toBeInTheDocument();
    await u.click(within(d).getByRole("checkbox", { name: /telecom-synth/ }));
    await u.click(within(comptes).getByRole("radio", { name: /Gestionnaire Synth/ }));
    await u.type(within(d).getByLabelText("Justification"), "Reprise des plans par le bureau d'études");
    await u.clear(within(d).getByLabelText(/Durée de validité/));
    await u.type(within(d).getByLabelText(/Durée de validité/), "48");
    await u.click(within(d).getByRole("button", { name: "Accorder la dérogation" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/région de ce projet/);
    expect(h.post).toHaveBeenCalledWith(`${B}/export/derogations`, { jeuxIds: ["j-tel"], justification: "Reprise des plans par le bureau d'études", beneficiaireId: "u-gest", dureeHeures: 48 });
    await u.click(within(d).getByRole("button", { name: "Accorder la dérogation" }));
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent(/jamais le bénéficiaire/));
    await u.click(within(d).getByRole("button", { name: "Accorder la dérogation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("beneficiaire ADMIN : sa derogation disponible est proposee ; la prevision inclut le jeu couvert ; le parametre part", async () => {
    e.derogations = [derogation("d-mienne", { beneficiaire: { id: MOI, nomComplet: "Moi Admin" } }), derogation("d-autre"), derogation("d-exp", { beneficiaire: { id: MOI, nomComplet: "Moi" }, etat: "EXPIREE" })];
    const u = userEvent.setup();
    rendre({ estAdmin: true });
    await screen.findByRole("list", { name: "Dérogations du projet" });
    const radios = within(screen.getByRole("group", { name: /Dérogation de confidentialité/ })).getAllByRole("radio");
    expect(radios.length).toBe(3);
    await u.click(screen.getByRole("radio", { name: /accordée par Admin Synth/ }));
    expect(screen.getByTestId("apercu-geojson")).toHaveTextContent(/Inclus : telecom-synth.geojson, v2 \(Confidentiel concessionnaire\), par dérogation/);
    await u.click(screen.getByRole("button", { name: /Fabriquer et télécharger/ }));
    await waitFor(() => expect(appelsExport()[0][1]).toMatchObject({ params: { geojson: "true", derogation: "d-mienne" } }));
  });
});

describe("accessibilite", () => {
  it("axe : onglet charge (ADMIN), dialogue d'octroi ouvert", async () => {
    const u = userEvent.setup();
    const { container } = rendre({ estAdmin: true });
    await screen.findByRole("list", { name: "Dérogations du projet" });
    expect(await violationsAccessibilite(container)).toEqual([]);
    await u.click(screen.getByRole("button", { name: /Accorder une dérogation/ }));
    await within(await screen.findByRole("dialog")).findByRole("region", { name: /Comptes bénéficiaires possibles/ });
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });
});
