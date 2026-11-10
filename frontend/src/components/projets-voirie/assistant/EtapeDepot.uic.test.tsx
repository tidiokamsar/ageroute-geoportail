import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EtapeDepot } from "./EtapeDepot";
import { OPTIONS } from "./assistantImport.testutil";
import { SAISIE_VIDE, construireDonneesDepot, lireOptionsImport, type FormatsGdalApi, type Saisie } from "../../../lib/projetsVoirieImport";
import { classerErreur } from "../../../lib/projetsVoirie";
import { deposerJeu } from "../../../lib/projetsVoirieApi";
import { violationsAccessibilite } from "../../../test/accessibilite";

/**
 * Assistant d'import, etape 1, lot UI-C : formats GDAL desactives annonces avec la marche a suivre (et refuses localement), 415
 * FORMAT_GDAL_DESACTIVE explique, type de reseau par typeReseauCode (referentiel), methode d'acquisition et date des donnees.
 * Donnees 100 % SYNTHETIQUES.
 */

configure({ asyncUtilTimeout: 8000 });
const B = "/v2/projets-voirie";
const GDAL_COUPE = {
  actif: false, disponible: false, raison: "interrupteur PROJETS_VOIRIE_GDAL coupé", spoolConfigure: false, limites: null,
  formats: [
    { format: "GPKG", extensions: [".gpkg"], etat: "INDISPONIBLE", raison: "interrupteur coupé" },
    { format: "SHAPEFILE", extensions: [".zip"], etat: "INDISPONIBLE", raison: "interrupteur coupé" },
    { format: "DXF", extensions: [".dxf"], etat: "INDISPONIBLE", raison: "interrupteur coupé" },
  ],
};
const OPTIONS_B2 = { ...OPTIONS, formatsGdal: GDAL_COUPE, nonSupportes: [{ format: "DWG", raison: "convertisseur approuve requis" }] };
const TYPES = [
  { id: "t1", domaine: "TYPE_RESEAU", code: "FIBRE_OPTIQUE", libelle: "Fibre optique", ordre: 10, actif: true, parametres: { famille: "TELECOM" } },
  { id: "t2", domaine: "TYPE_RESEAU", code: "CUIVRE", libelle: "Cuivre (ancien)", ordre: 20, actif: false, parametres: { famille: "TELECOM" } },
];
const METHODES = [
  { id: "m1", domaine: "METHODE_ACQUISITION", code: "GNSS", libelle: "Relevé GNSS", ordre: 10, actif: true, parametres: {} },
  { id: "m2", domaine: "METHODE_ACQUISITION", code: "NUMERISATION_PLAN", libelle: "Numérisation d'un plan", ordre: 20, actif: true, parametres: {} },
  { id: "m3", domaine: "METHODE_ACQUISITION", code: "ANCIENNE", libelle: "Méthode retirée", ordre: 30, actif: false, parametres: {} },
];
const CONCESSIONNAIRES = [
  { id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM", typeReseauCode: "FIBRE_OPTIQUE" },
  { id: "c2", nom: "Operateur synthetique B", typeReseau: "TELECOM" },
  { id: "c3", nom: "Societe des eaux synthetique", typeReseau: "EAU_POTABLE" },
];

function installer() {
  h.get.mockImplementation(async (url: string) => {
    if (url === `${B}/concessionnaires`) return { data: CONCESSIONNAIRES };
    if (url === `${B}/referentiels/TYPE_RESEAU`) return { data: { domaine: "TYPE_RESEAU", valeurs: TYPES } };
    if (url === `${B}/referentiels/METHODE_ACQUISITION`) return { data: { domaine: "METHODE_ACQUISITION", valeurs: METHODES } };
    return { data: {} };
  });
}

function Banc({ options, surSaisie }: { options: ReturnType<typeof lireOptionsImport>; surSaisie: (s: Saisie) => void }) {
  const [s, setS] = useState<Saisie>(SAISIE_VIDE);
  return <EtapeDepot saisie={s} erreurs={{}} options={options} occupe={false} enLigne onSaisie={(p) => setS((x) => { const n = { ...x, ...p }; surSaisie(n); return n; })} onFichier={(f) => setS((x) => { const n = { ...x, fichier: f }; surSaisie(n); return n; })} />;
}

function rendre(options = lireOptionsImport(OPTIONS_B2)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const saisies: Saisie[] = [];
  const r = render(<QueryClientProvider client={qc}><Banc options={options} surSaisie={(s) => saisies.push(s)} /></QueryClientProvider>);
  return { ...r, derniere: () => saisies.at(-1) ?? SAISIE_VIDE };
}

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); installer(); });

describe("formats GDAL (lot B2) desactives sur ce serveur", () => {
  it("annonce GeoPackage, Shapefile ZIP et DXF desactives, la raison et la marche a suivre (GeoJSON, KML, GPX, CSV)", async () => {
    rendre();
    const b = await screen.findByTestId("formats-gdal-desactives");
    expect(b).toHaveTextContent("Désactivés sur ce serveur : GeoPackage (.gpkg) ; Shapefile (archive ZIP) (.zip) ; DXF (dessin d'ingénierie) (.dxf).");
    expect(b).toHaveTextContent("interrupteur PROJETS_VOIRIE_GDAL coupé");
    expect(b).toHaveTextContent(/en GeoJSON, KML, GPX ou CSV/);
    expect(screen.getByTestId("formats-acceptes")).toHaveTextContent("Non lus : DWG (exportez un DWG en DXF)");
  });
  it("un fichier .gpkg est refuse LOCALEMENT, sans envoi, avec la marche a suivre", async () => {
    const r = rendre();
    await screen.findByTestId("formats-gdal-desactives");
    await userEvent.setup({ applyAccept: false }).upload(document.querySelector<HTMLInputElement>("input[type=file]")!, new File(["x"], "reseau.gpkg"));
    expect(await screen.findByText(/Le format GeoPackage est désactivé sur ce serveur/)).toBeInTheDocument();
    const { erreurs, donnees } = construireDonneesDepot({ ...r.derniere(), concessionnaireId: "c1" }, lireOptionsImport(OPTIONS_B2).formats, 25 * 1024 * 1024, {}, lireOptionsImport(OPTIONS_B2).formatsGdal);
    expect(donnees).toBeNull();
    expect(erreurs.fichier).toMatch(/Exportez le fichier .* en GeoJSON, KML, GPX ou CSV/);
    expect(h.post).not.toHaveBeenCalled();
  });
  it("GDAL actif : annonce une conversion en tache de fond, non pilotee par cette interface (refus local explique)", async () => {
    const actif: FormatsGdalApi = { actif: true, disponible: true, raison: null, formats: GDAL_COUPE.formats.map((f) => ({ ...f, etat: "SUPPORTE" as const, raison: null })) };
    rendre({ ...lireOptionsImport(OPTIONS_B2), formatsGdal: actif });
    expect(await screen.findByTestId("formats-gdal-actifs")).toHaveTextContent(/ne pilote pas encore/);
    const d = construireDonneesDepot({ ...SAISIE_VIDE, fichier: new File(["x"], "plan.dxf"), concessionnaireId: "c1" }, lireOptionsImport(OPTIONS).formats, 1e8, {}, actif);
    expect(d.erreurs.fichier).toMatch(/ne pilote pas encore/);
  });
  it("serveur anterieur a B2 (sans formatsGdal) : aucun bloc GDAL, rien n'est refuse a tort", async () => {
    rendre(lireOptionsImport(OPTIONS));
    await screen.findByTestId("formats-acceptes");
    expect(screen.queryByTestId("formats-gdal-desactives")).toBeNull();
    expect(lireOptionsImport(OPTIONS).formatsGdal).toBeNull();
  });
  it("415 FORMAT_GDAL_DESACTIVE du serveur : explique en clair, avec la marche a suivre", () => {
    const e = classerErreur({ response: { status: 415, data: { code: "FORMAT_GDAL_DESACTIVE", error: "Le format GPKG est desactive", format: "GPKG" } } });
    expect(e.message).toMatch(/désactivé sur ce serveur/);
    expect(e.message).toMatch(/GeoJSON, KML, GPX ou CSV/);
    expect(classerErreur({ response: { status: 503, data: { code: "GDAL_DESACTIVE" } } }).message).toMatch(/désactivée sur ce serveur/);
  });
});

describe("type de reseau et methode d'acquisition depuis les referentiels", () => {
  it("le type se choisit par code (referentiel) ; une valeur desactivee n'est pas proposee ; le type du concessionnaire est repris", async () => {
    const u = userEvent.setup();
    const r = rendre();
    const type = await screen.findByLabelText("Type de réseau");
    await within(type).findByRole("option", { name: "Fibre optique" });
    expect(within(type).queryByRole("option", { name: /Cuivre/ })).toBeNull();
    await within(screen.getByLabelText("Concessionnaire propriétaire du réseau")).findByRole("option", { name: /Operateur synthetique A \(Fibre optique\)/ });
    await u.selectOptions(screen.getByLabelText("Concessionnaire propriétaire du réseau"), "c1");
    expect(type).toHaveValue("FIBRE_OPTIQUE");
    expect(r.derniere()).toMatchObject({ typeReseauCode: "FIBRE_OPTIQUE", typeReseau: "TELECOM" });
  });
  it("revue m1 : revenir a « Non precise » ne garde pas la famille du type abandonne ; elle redevient celle du concessionnaire", async () => {
    const u = userEvent.setup();
    const r = rendre();
    const type = await screen.findByLabelText("Type de réseau");
    await within(type).findByRole("option", { name: "Fibre optique" });
    await u.selectOptions(type, "FIBRE_OPTIQUE");
    expect(r.derniere()).toMatchObject({ typeReseauCode: "FIBRE_OPTIQUE", typeReseau: "TELECOM" });
    await u.selectOptions(type, "");
    expect(r.derniere()).toMatchObject({ typeReseauCode: "", typeReseau: "" });
    await within(screen.getByLabelText("Concessionnaire propriétaire du réseau")).findByRole("option", { name: /Societe des eaux/ });
    await u.selectOptions(screen.getByLabelText("Concessionnaire propriétaire du réseau"), "c3");
    await u.selectOptions(type, "FIBRE_OPTIQUE");
    await u.selectOptions(type, "");
    expect(r.derniere()).toMatchObject({ typeReseauCode: "", typeReseau: "EAU_POTABLE" });
  });
  it("revue m1 : changer de concessionnaire reprend SON type (code et famille), jamais celui du precedent", async () => {
    const u = userEvent.setup();
    const r = rendre();
    const conc = screen.getByLabelText("Concessionnaire propriétaire du réseau");
    await within(conc).findByRole("option", { name: /Societe des eaux/ });
    await within(await screen.findByLabelText("Type de réseau")).findByRole("option", { name: "Fibre optique" });
    await u.selectOptions(conc, "c1");
    expect(r.derniere()).toMatchObject({ concessionnaireId: "c1", typeReseauCode: "FIBRE_OPTIQUE", typeReseau: "TELECOM" });
    await u.selectOptions(conc, "c3");
    expect(r.derniere()).toMatchObject({ concessionnaireId: "c3", typeReseauCode: "", typeReseau: "EAU_POTABLE" });
  });
  it("concessionnaire sans code : la famille est reprise et dite ; le depot envoie alors la famille seule", async () => {
    const u = userEvent.setup();
    const r = rendre();
    await within(screen.getByLabelText("Concessionnaire propriétaire du réseau")).findByRole("option", { name: /Operateur synthetique B/ });
    await u.selectOptions(screen.getByLabelText("Concessionnaire propriétaire du réseau"), "c2");
    await waitFor(() => expect(within(screen.getByLabelText("Type de réseau")).getByRole("option", { name: /famille du concessionnaire : Télécom/ })).toBeInTheDocument());
    const d = construireDonneesDepot({ ...r.derniere(), fichier: new File(["<kml/>"], "a.kml") }, lireOptionsImport(OPTIONS).formats, 1e8);
    expect(d.donnees).toMatchObject({ typeReseau: "TELECOM" });
    expect(d.donnees).not.toHaveProperty("typeReseauCode");
  });
  it("methode d'acquisition et date des donnees : saisies, envoyees au depot (le code prime sur la famille)", async () => {
    const u = userEvent.setup();
    const r = rendre();
    const m = await screen.findByLabelText("Méthode d'acquisition (facultatif)");
    await within(m).findByRole("option", { name: "Relevé GNSS" });
    expect(within(m).queryByRole("option", { name: /Méthode retirée/ })).toBeNull();
    await u.selectOptions(m, "NUMERISATION_PLAN");
    await u.type(screen.getByLabelText("Date des données (facultatif)"), "2026-10-15");
    await u.selectOptions(await screen.findByLabelText("Concessionnaire propriétaire du réseau"), "c1");
    const d = construireDonneesDepot({ ...r.derniere(), fichier: new File(["<kml/>"], "a.kml") }, lireOptionsImport(OPTIONS).formats, 1e8);
    expect(d.donnees).toMatchObject({ methodeAcquisition: "NUMERISATION_PLAN", dateDonnees: "2026-10-15", typeReseauCode: "FIBRE_OPTIQUE" });
    h.post.mockResolvedValue({ data: { simulation: true, resume: { nbObjets: 0 } } });
    await deposerJeu("p1", d.donnees!, { simuler: true });
    const champs = Object.fromEntries([...(h.post.mock.calls[0][1] as FormData).entries()].filter(([k]) => k !== "fichier"));
    expect(champs).toMatchObject({ typeReseauCode: "FIBRE_OPTIQUE", methodeAcquisition: "NUMERISATION_PLAN", dateDonnees: "2026-10-15" });
    expect(champs).not.toHaveProperty("typeReseau");
  });
  it("nouveau concessionnaire : type obligatoire, envoye par code (typeReseauCode) ; erreur 400 TYPE_RESEAU_INCONNU dite", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 400, data: { code: "TYPE_RESEAU_INCONNU" } } })
      .mockResolvedValueOnce({ data: { concessionnaire: { id: "c9", nom: "Nouveau synthetique", typeReseau: "TELECOM", typeReseauCode: "FIBRE_OPTIQUE" } } });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /le créer/ }));
    await u.type(screen.getByLabelText("Nom"), "Nouveau synthetique");
    await u.click(screen.getByRole("button", { name: "Créer le concessionnaire" }));
    expect(await screen.findByText(/Choisissez le type de réseau du concessionnaire/)).toBeInTheDocument();
    const nt = screen.getAllByLabelText("Type de réseau")[1];
    await within(nt).findByRole("option", { name: "Fibre optique" });
    await u.selectOptions(nt, "FIBRE_OPTIQUE");
    await u.click(screen.getByRole("button", { name: "Créer le concessionnaire" }));
    expect(await screen.findByText(/inconnu ou retiré du référentiel/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Créer le concessionnaire" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${B}/concessionnaires`, { nom: "Nouveau synthetique", typeReseauCode: "FIBRE_OPTIQUE" }));
  });
  it("referentiel indisponible (503) : dit dans l'aide du champ ; le depot reste possible sans type", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.startsWith(`${B}/referentiels/`)) throw { response: { status: 503, data: {} } };
      if (url === `${B}/concessionnaires`) return { data: CONCESSIONNAIRES };
      return { data: {} };
    });
    rendre();
    expect((await screen.findAllByText(/Liste indisponible : /)).length).toBe(2);
    expect(screen.getByLabelText("Type de réseau")).toHaveValue("");
  });
  it("axe : aucune violation", async () => {
    const r = rendre();
    await screen.findByTestId("formats-gdal-desactives");
    await within(await screen.findByLabelText("Type de réseau")).findByRole("option", { name: "Fibre optique" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 30_000);
});
