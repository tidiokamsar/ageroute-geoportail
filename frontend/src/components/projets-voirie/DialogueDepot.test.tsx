import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { construireDonnees, DialogueDepot, SAISIE_VIDE } from "./DialogueDepot";
import { jeu } from "./synthetique.testutil";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Dialogue de depot : SIMULATION D'ABORD (le serveur lit, valide, n'ecrit rien), puis confirmation d'ecriture. On verifie ce qui part sur le fil
 * (api.post), pas seulement ce qui s'affiche. Fichiers et reponses synthetiques.
 */

const CONCESSIONNAIRES = [{ id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM", contact: null }, { id: "c2", nom: "Societe des eaux synthetique", typeReseau: "EAU_POTABLE" }];

const REPONSE = {
  simulation: true,
  jeu: { ...jeu({ id: "nouveau", statut: "CONTROLE", nonAutorise: true, version: 3 }) },
  resume: { nbObjets: 3, parTypeGeom: { LIGNE: 3 }, longueurTotaleM: 1200, longueurTraceFusionneM: 900, bbox: [-10.103, 9.177, -10.097, 9.183], attributsDetectes: [{ nom: "Name", nb: 3 }, { nom: "Circuit", nb: 3 }] },
  crs: { source: "WGS84 (EPSG:4326)", cible: "EPSG:4326", methode: "aucune transformation", justification: "WGS84 par norme KML 2.2, aucune transformation" },
  delta: { ajoutes: 1, retires: 0, identiques: 2 },
  remplace: { jeuId: "ancien", version: 2 },
  avertissements: [{ code: "ALTITUDE_IGNOREE", message: "L'altitude des points est ignorée.", nb: 12 }],
};

function rendre(over: { enLigne?: boolean; onVoirJeu?: (id: string) => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onFermer = vi.fn();
  const onVoirJeu = over.onVoirJeu ?? vi.fn();
  const r = render(<QueryClientProvider client={qc}><DialogueDepot projetId="p1" onFermer={onFermer} enLigne={over.enLigne ?? true} onVoirJeu={onVoirJeu} /></QueryClientProvider>);
  return { ...r, onFermer, onVoirJeu };
}

const champFichier = () => document.querySelector<HTMLInputElement>("input[type=file]")!;
const kml = (nom = "reseau-synthetique.kml") => new File(["<kml/>"], nom, { type: "application/vnd.google-earth.kml+xml" });
const dialogue = () => screen.getByRole("dialog");

async function preparer(fichier: File | null = kml()) {
  const u = userEvent.setup();
  const r = rendre();
  if (fichier) await u.upload(champFichier(), fichier);
  await screen.findByRole("option", { name: /Operateur synthetique A/ });
  await u.selectOptions(within(dialogue()).getByLabelText("Concessionnaire propriétaire du réseau"), "c1");
  return { u, ...r };
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset();
  h.get.mockResolvedValue({ data: CONCESSIONNAIRES });
});

describe("simulation d'abord, ecriture ensuite", () => {
  it("la simulation envoie ?simuler=true et n'ecrit rien ; le resume, le CRS, le delta et les avertissements s'affichent", async () => {
    h.post.mockResolvedValueOnce({ data: REPONSE });
    const { u } = await preparer();
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await screen.findByRole("heading", { name: "Résultat de la simulation" });

    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0][0]).toBe("/v2/projets-voirie/p1/jeux");
    expect(h.post.mock.calls[0][2].params).toEqual({ simuler: "true" });
    expect(dialogue()).toHaveTextContent(/rien n'a été écrit/);
    expect(dialogue()).toHaveTextContent("Un fichier reçu n'est pas un fichier importé : il n'alimente le projet qu'après autorisation.");

    const resume = dialogue();
    expect(resume).toHaveTextContent("Circuits ou objets du fichier");
    expect(resume).toHaveTextContent("Longueur du tracé fusionné (circuits superposés comptés une fois)");
    expect(resume).toHaveTextContent("900 m : 300 m de circuits superposés ne sont comptés qu'une fois");
    expect(resume).toHaveTextContent("Version prévue3");
    expect(resume).toHaveTextContent("Attributs détectésName, Circuit");
    expect(resume).toHaveTextContent("la version 2 autorisée, une fois cette version autorisée à son tour");
    expect(resume).not.toHaveTextContent(/câble/i);

    const crs = screen.getByTestId("bloc-crs");
    expect(crs).toHaveTextContent("EPSG:4326");
    expect(crs).toHaveTextContent("WGS84 par norme KML 2.2, aucune transformation");

    expect(screen.getByTestId("delta")).toHaveTextContent("1 ajouté(s), 0 retiré(s), 2 identique(s).");
    expect(screen.getByTestId("delta")).toHaveTextContent("les suppressions ne sont jamais appliquées automatiquement");

    expect(within(dialogue()).getByText(/L'altitude des points est ignorée\. \(12 concerné\(s\)\)/)).toBeInTheDocument();
  });

  it("la confirmation re-envoie le meme fichier SANS ?simuler ; le jeu naît en quarantaine (a autoriser)", async () => {
    h.post.mockResolvedValue({ data: REPONSE });
    const { u } = await preparer();
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await u.click(await screen.findByRole("button", { name: "Confirmer l'écriture" }));
    await screen.findByText("Fichier reçu et contrôlé.");

    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls[1][2].params).toBeUndefined();
    const fichierSimule = (h.post.mock.calls[0][1] as FormData).get("fichier") as File;
    const fichierEcrit = (h.post.mock.calls[1][1] as FormData).get("fichier") as File;
    expect(fichierEcrit.name).toBe(fichierSimule.name);
    expect(dialogue()).toHaveTextContent(/à autoriser/);
    expect(dialogue()).toHaveTextContent(/Autorisez-le ou rejetez-le depuis l'onglet Couches/);
  });

  it("modifier les parametres apres la simulation ramene au formulaire, rien n'est ecrit", async () => {
    h.post.mockResolvedValueOnce({ data: REPONSE });
    const { u } = await preparer();
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await u.click(await screen.findByRole("button", { name: "Modifier les paramètres" }));
    expect(screen.getByRole("button", { name: "Simuler le dépôt" })).toBeInTheDocument();
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("champs envoyes : defauts du contrat v2 (natureObjets, confidentialite), qualite, origine facultative, fichier en dernier", async () => {
    h.post.mockResolvedValueOnce({ data: REPONSE });
    const { u } = await preparer();
    const d = dialogue();
    await u.selectOptions(within(d).getByLabelText("Classe de précision"), "B");
    await u.type(within(d).getByLabelText("Précision horizontale, en mètres"), "2,5");
    await u.type(within(d).getByLabelText(/Méthode de levé/), "relevé GPS");
    await u.type(within(d).getByLabelText(/Origine du fichier/), "reçu de l'opérateur le 24/10/2026");
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await screen.findByRole("heading", { name: "Résultat de la simulation" });
    const entrees = [...(h.post.mock.calls[0][1] as FormData).entries()];
    expect(entrees[entrees.length - 1][0]).toBe("fichier");
    expect(Object.fromEntries(entrees.filter(([k]) => k !== "fichier"))).toEqual({
      role: "RESEAU_TIERS", concessionnaireId: "c1", typeReseau: "TELECOM", natureObjets: "INCONNUE", classePrecision: "B", precisionHorizontaleM: "2.5",
      methode: "relevé GPS", origineFichier: "reçu de l'opérateur le 24/10/2026", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE",
    });
  });

  it("l'origine du fichier est facultative : vide, la simulation part et le champ n'est pas envoye", async () => {
    h.post.mockResolvedValueOnce({ data: REPONSE });
    const { u } = await preparer();
    expect(within(dialogue()).getByLabelText(/Origine du fichier \(facultatif\)/)).toHaveValue("");
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await screen.findByRole("heading", { name: "Résultat de la simulation" });
    expect([...(h.post.mock.calls[0][1] as FormData).keys()]).not.toContain("origineFichier");
    expect(dialogue().textContent).not.toMatch(/convention|écrit requis|autorisation écrite/i);
  });

  it("le role change les valeurs proposees : axes => restreint au projet et nature « axe » imposee ; plus de champ concessionnaire", async () => {
    const u = userEvent.setup();
    rendre();
    await u.upload(champFichier(), kml());
    await u.selectOptions(within(dialogue()).getByLabelText("Rôle du fichier"), "AXES_TRAVAUX");
    expect(within(dialogue()).getByLabelText("Confidentialité")).toHaveValue("RESTREINT_PROJET");
    expect(within(dialogue()).getByLabelText("Nature des objets")).toHaveValue("AXE");
    expect(within(dialogue()).getByLabelText("Nature des objets")).toBeDisabled();
    expect(within(dialogue()).queryByLabelText("Concessionnaire propriétaire du réseau")).toBeNull();
    h.post.mockResolvedValueOnce({ data: REPONSE });
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await screen.findByRole("heading", { name: "Résultat de la simulation" });
    const corps = Object.fromEntries((h.post.mock.calls[0][1] as FormData).entries());
    expect(corps.concessionnaireId).toBeUndefined();
    expect(corps.role).toBe("AXES_TRAVAUX");
    expect(corps.natureObjets).toBe("AXE");
  });

  it("la confidentialite a cinq niveaux est proposee, « confidentiel concessionnaire » par defaut pour un reseau tiers", () => {
    rendre();
    const sel = within(dialogue()).getByLabelText("Confidentialité");
    expect(sel).toHaveValue("CONFIDENTIEL_CONCESSIONNAIRE");
    expect(within(sel).getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual(["PUBLIC", "INTERNE", "RESTREINT_PROJET", "CONFIDENTIEL_CONCESSIONNAIRE", "INFRASTRUCTURE_SENSIBLE"]);
  });

  it("la classe de precision par defaut est « inconnue », avec l'aide A a E", () => {
    rendre();
    const sel = within(dialogue()).getByLabelText("Classe de précision");
    expect(sel).toHaveValue("INCONNUE");
    expect(within(sel).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Inconnue (par défaut)", "A : levé contrôlé", "B : plan validé", "C : plan de conception", "D : approximation", "E : sans géométrie exploitable",
    ]);
  });
});

describe("controles locaux avant tout envoi", () => {
  it("un format non pris en charge est refuse en clair (« format prevu au lot suivant »), rien n'est envoye", async () => {
    // `applyAccept: false` : le navigateur laisse deposer n'importe quel fichier par glisser-deposer ; l'attribut `accept` n'est qu'un indice.
    const u = userEvent.setup({ applyAccept: false });
    rendre();
    for (const nom of ["plan.kmz", "plan.zip", "plan.shp", "plan.pdf", "plan.html"]) {
      await u.upload(champFichier(), new File(["x"], nom));
      expect(await screen.findByRole("alert")).toHaveTextContent(/format prévu au lot suivant/i);
      expect(screen.getByText(new RegExp(nom.replace(".", "\\."), "i"))).toBeInTheDocument();
    }
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    expect(h.post).not.toHaveBeenCalled();
    expect(within(dialogue()).getByText("Corrigez les champs signalés avant de lancer la simulation.")).toBeInTheDocument();
  });
  it("concessionnaire obligatoire pour un reseau tiers", async () => {
    const u = userEvent.setup();
    rendre();
    await u.upload(champFichier(), kml());
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    expect(await screen.findByText(/Choisissez le concessionnaire propriétaire/)).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("sans fichier : message, aucun envoi", async () => {
    const u = userEvent.setup();
    rendre();
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    expect(await screen.findByText("Choisissez un fichier KML ou GeoJSON.")).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("construireDonnees : precision hors bornes et dates futures refusees", () => {
    const f = new File(["x"], "a.kml");
    const { donnees, erreurs } = construireDonnees({ ...SAISIE_VIDE, fichier: f, concessionnaireId: "c1", precisionH: "-3", dateConstat: "2999-01-01" });
    expect(donnees).toBeNull();
    expect(Object.keys(erreurs).sort()).toEqual(["dateConstat", "precisionH"]);
  });
  it("hors ligne : on ne peut pas simuler", () => {
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><DialogueDepot projetId="p1" onFermer={vi.fn()} enLigne={false} /></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "Simuler le dépôt" })).toBeDisabled();
    expect(screen.getByText(/hors ligne : le dépôt a besoin du réseau/)).toBeInTheDocument();
  });
});

describe("erreurs du serveur, dites en clair", () => {
  async function simulerAvecErreur(status: number, data: Record<string, unknown>, onVoirJeu?: (id: string) => void) {
    h.post.mockRejectedValueOnce({ response: { status, data } });
    const u = userEvent.setup();
    const r = rendre({ onVoirJeu });
    await u.upload(champFichier(), kml());
    await screen.findByRole("option", { name: /Operateur synthetique A/ });
    await u.selectOptions(within(dialogue()).getByLabelText("Concessionnaire propriétaire du réseau"), "c1");
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    return { u, ...r, alerte: await screen.findByText(/Code : /).then((e) => e.closest("[role=alert]") as HTMLElement) };
  }

  it("409 JEU_DEJA_CHARGE : « Ce fichier est deja charge » et lien vers le jeu existant", async () => {
    const onVoirJeu = vi.fn();
    const { u, alerte } = await simulerAvecErreur(409, { error: "doublon", code: "JEU_DEJA_CHARGE", jeuId: "jeu-existant" }, onVoirJeu);
    expect(alerte).toHaveTextContent("Ce fichier est déjà chargé.");
    expect(alerte).toHaveTextContent("Code : JEU_DEJA_CHARGE");
    await u.click(within(alerte).getByRole("button", { name: "Voir le jeu existant" }));
    expect(onVoirJeu).toHaveBeenCalledWith("jeu-existant");
  });
  it("409 sans jeuId : pas de lien invente", async () => {
    const { alerte } = await simulerAvecErreur(409, { error: "doublon", code: "JEU_DEJA_CHARGE" });
    expect(within(alerte).queryByRole("button")).toBeNull();
  });
  it("409 DEPOT_EN_ATTENTE : un autre depot attend, avec le lien vers lui", async () => {
    const onVoirJeu = vi.fn();
    const { u, alerte } = await simulerAvecErreur(409, { error: "x", code: "DEPOT_EN_ATTENTE", jeuId: "jeu-attente" }, onVoirJeu);
    expect(alerte).toHaveTextContent(/attend déjà son autorisation/);
    await u.click(within(alerte).getByRole("button", { name: "Voir le jeu existant" }));
    expect(onVoirJeu).toHaveBeenCalledWith("jeu-attente");
  });
  it("FORMAT_NON_SUPPORTE : prevu au lot suivant", async () => {
    const { alerte } = await simulerAvecErreur(415, { error: "x", code: "FORMAT_NON_SUPPORTE" });
    expect(alerte).toHaveTextContent(/prévu au lot suivant/);
    expect(alerte).toHaveTextContent(/KML et GeoJSON/);
  });
  it("CONTENU_NON_RECONNU : le fichier n'a pas ete ouvert ni execute", async () => {
    const { alerte } = await simulerAvecErreur(422, { error: "x", code: "CONTENU_NON_RECONNU" });
    expect(alerte).toHaveTextContent(/n'a pas été ouvert ni exécuté/);
  });
  it("HORS_GUINEE : les bornes et la conduite a tenir", async () => {
    const { alerte } = await simulerAvecErreur(422, { error: "x", code: "HORS_GUINEE" });
    expect(alerte).toHaveTextContent(/longitude de -15,2 à -7,5/);
    expect(alerte).toHaveTextContent(/WGS 84, avec la longitude avant la latitude/);
  });
  it("CRS_NON_SUPPORTE : seul le WGS 84 est accepte, sans transformation", async () => {
    const { alerte } = await simulerAvecErreur(422, { error: "x", code: "CRS_NON_SUPPORTE" });
    expect(alerte).toHaveTextContent(/n'accepte que le WGS 84/);
    expect(alerte).toHaveTextContent(/sans transformation/);
  });
  it("413 FICHIER_TROP_GROS : la limite de 25 Mo", async () => {
    const { alerte } = await simulerAvecErreur(413, { error: "x", code: "FICHIER_TROP_GROS" });
    expect(alerte).toHaveTextContent(/25 Mo/);
  });
  it("panne reseau : dite comme telle, le formulaire est conserve", async () => {
    h.post.mockRejectedValueOnce(new Error("Network Error"));
    const u = userEvent.setup();
    rendre();
    await u.upload(champFichier(), kml());
    await screen.findByRole("option", { name: /Operateur synthetique A/ });
    await u.selectOptions(within(dialogue()).getByLabelText("Concessionnaire propriétaire du réseau"), "c1");
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    expect(await screen.findByText(/Le serveur est injoignable/)).toBeInTheDocument();
    expect(screen.getByText(/reseau-synthetique\.kml/)).toBeInTheDocument();
  });
  it("une erreur a la CONFIRMATION est dite, et le dialogue reste sur la simulation", async () => {
    h.post.mockResolvedValueOnce({ data: REPONSE }).mockRejectedValueOnce({ response: { status: 409, data: { code: "JEU_DEJA_CHARGE", jeuId: "j1" } } });
    const { u } = await preparer();
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await u.click(await screen.findByRole("button", { name: "Confirmer l'écriture" }));
    expect(await screen.findByText(/Ce fichier est déjà chargé\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmer l'écriture" })).toBeEnabled();
  });
});

describe("nouveau concessionnaire : un geste a part, annonce comme tel", () => {
  it("cree le concessionnaire (ecriture immediate), le selectionne ; ne depose rien", async () => {
    h.post.mockResolvedValueOnce({ data: { id: "c9", nom: "Nouveau concessionnaire", typeReseau: "ELECTRICITE" } });
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("option", { name: /Operateur synthetique A/ });
    await u.click(screen.getByRole("button", { name: /le créer/ }));
    const d = dialogue();
    expect(within(d).getByText(/enregistrée tout de suite, indépendamment du dépôt/)).toBeInTheDocument();
    await u.type(within(d).getByLabelText("Nom"), "Nouveau concessionnaire");
    await u.selectOptions(within(d).getAllByLabelText("Type de réseau")[1], "ELECTRICITE");
    h.get.mockResolvedValue({ data: [...CONCESSIONNAIRES, { id: "c9", nom: "Nouveau concessionnaire", typeReseau: "ELECTRICITE" }] });
    await u.click(within(d).getByRole("button", { name: "Créer le concessionnaire" }));
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("/v2/projets-voirie/concessionnaires", { nom: "Nouveau concessionnaire", typeReseau: "ELECTRICITE" });
    expect(await within(d).findByLabelText("Concessionnaire propriétaire du réseau")).toBeInTheDocument();
  });
  it("nom vide : refuse, rien n'est envoye", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("option", { name: /Operateur synthetique A/ });
    await u.click(screen.getByRole("button", { name: /le créer/ }));
    await u.click(screen.getByRole("button", { name: "Créer le concessionnaire" }));
    expect(screen.getByText("Saisissez le nom du concessionnaire.")).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
});

describe("accessibilite (axe) et clavier", () => {
  it("aucune violation : formulaire, nouveau concessionnaire, simulation", async () => {
    h.post.mockResolvedValueOnce({ data: REPONSE });
    const { u } = await preparer();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    await u.click(screen.getByRole("button", { name: /le créer/ }));
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    await u.click(screen.getByRole("button", { name: "Annuler la création" }));
    await u.click(screen.getByRole("button", { name: "Simuler le dépôt" }));
    await screen.findByRole("heading", { name: "Résultat de la simulation" });
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  }, 60_000);
  it("le fichier se choisit au clavier : le champ natif est un arret de Tab, lie a un libelle visible", () => {
    rendre();
    const champ = champFichier();
    expect(champ).not.toHaveAttribute("tabindex", "-1");
    expect(champ.closest("label")).toHaveTextContent(/choisissez-le/);
  });
  it("Echap ferme le dialogue (aucun piege clavier) quand rien n'est en cours", async () => {
    const u = userEvent.setup();
    const { onFermer } = rendre();
    await u.keyboard("{Escape}");
    expect(onFermer).toHaveBeenCalled();
  });
});
