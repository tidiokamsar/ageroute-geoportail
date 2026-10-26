import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";
import { FormulaireReception, type FormulaireReceptionProps, type OptionsEnvoi } from "./FormulaireReception";
import type { MetaImport, ReceptionReponse, SourceConnue } from "./types";

/**
 * Formulaire de réception : ce que ces tests défendent.
 *
 * - Le bouton « Recevoir et contrôler le lot » ne s'active que quand tout est réuni, et une phrase dit ce qui manque.
 * - Un seul envoi à la fois ; la progression est dite ; le serveur seul décide du statut affiché.
 * - Un lot REJETÉ est un résultat ; un fichier déjà reçu dit que rien n'a été écrit et que les nouvelles
 *   informations n'ont pas été appliquées.
 * - Un refus du serveur (400 + code) se distingue d'une réception non confirmée (réseau coupé).
 * - Après un échec, rien n'est perdu ; après un succès, le fichier part et les informations restent.
 * - Clavier seul ; zéro violation axe dans cinq états.
 */

const META: MetaImport = {
  formats: [
    { code: "csv", libelle: "CSV (pivot, séparateur ;)", aide: "Fichier texte au format pivot, séparateur point-virgule." },
    { code: "geojson", libelle: "GeoJSON (4326)", aide: "Collection de points ou de tronçons en WGS 84." },
  ],
  tailleMaxOctets: 50 * 1024 * 1024,
  limiteLignes: 100000,
  statuts: [],
};
const SOURCES: SourceConnue[] = [{ valeur: "ONR_BDR", nombreLots: 3 }, { valeur: "L2R_MESURE", nombreLots: 1 }];

const REPONSE: ReceptionReponse = {
  id: "lot-2", reference: "IMP-2026-00002", statut: "VALIDE_SCHEMA", dejaRecu: false, motifRejetLot: null,
  compteurs: { lues: 4, validees: 2, rejetees: 1, ignorees: 1 },
};

const COMPLETES = { methodeSource: "export L2R", autorisationRef: "AUT-2026-01" };

function fichier(nom = "lot.csv", taille = 1500) {
  const f = new File(["systeme_source;type_objet\n"], nom, { type: "text/csv" });
  Object.defineProperty(f, "size", { value: taille });
  return f;
}

function erreurHttp(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
  return { response: { status, data, headers } };
}

type Soumettre = FormulaireReceptionProps["onSoumettre"];

function rendre(over: Partial<FormulaireReceptionProps> = {}) {
  const onSoumettre = vi.fn<Soumettre>(async () => REPONSE);
  const utilisateur = userEvent.setup({ applyAccept: false });
  const rendu = render(<FormulaireReception meta={META} sourcesConnues={SOURCES} onSoumettre={onSoumettre} {...over} />);
  return { onSoumettre, utilisateur, ...rendu };
}

const bouton = () => screen.getByRole("button", { name: "Recevoir et contrôler le lot" });
const champ = (re: RegExp) => screen.getByLabelText(re);
const entreeFichier = () => screen.getByLabelText(/Fichier à recevoir/) as HTMLInputElement;

/** Un envoi suspendu, qu'on résout ou rejette à la main. */
function envoiSuspendu() {
  let options!: OptionsEnvoi;
  let resoudre!: (r: ReceptionReponse) => void;
  let rejeter!: (e: unknown) => void;
  const onSoumettre = vi.fn<Soumettre>((_d, _f, o) => {
    options = o;
    return new Promise<ReceptionReponse>((res, rej) => { resoudre = res; rejeter = rej; });
  });
  return { onSoumettre, options: () => options, resoudre: (r: ReceptionReponse = REPONSE) => resoudre(r), rejeter: (e: unknown) => rejeter(e) };
}

async function toutRemplir(u: ReturnType<typeof userEvent.setup>, nom = "lot.csv") {
  await u.type(champ(/Méthode de la source/), COMPLETES.methodeSource);
  await u.type(champ(/Référence de l'autorisation écrite/), COMPLETES.autorisationRef);
  await u.upload(entreeFichier(), fichier(nom));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Saisie : champs explicites, obligatoires, aidés", () => {
  it("affiche les cinq champs et la zone de dépôt avec leurs valeurs par défaut (celles de l'ancienne page)", () => {
    rendre();
    expect(champ(/Système source/)).toHaveValue("ONR_BDR");
    expect(champ(/^Format/)).toHaveValue("csv");
    expect(champ(/Méthode de la source/)).toHaveValue("");
    expect(champ(/Version du mapping/)).toHaveValue("v0");
    expect(champ(/Référence de l'autorisation écrite/)).toHaveValue("");
    expect(entreeFichier()).toHaveAttribute("type", "file");
    expect(screen.getByRole("form", { name: "Recevoir un lot" })).toBeInTheDocument();
  });

  it("chaque champ obligatoire a un * visible, aria-required et une aide reliée par aria-describedby", () => {
    rendre();
    for (const re of [/Système source/, /^Format/, /Méthode de la source/, /Version du mapping/, /Référence de l'autorisation écrite/, /Fichier à recevoir/]) {
      const c = champ(re);
      expect(c).toHaveAttribute("aria-required", "true");
      expect(c.getAttribute("aria-describedby")).toBeTruthy();
      const etiquette = (c as HTMLElement & { labels: NodeListOf<HTMLLabelElement> }).labels[0];
      expect(etiquette.textContent).toContain("*");
    }
    expect(champ(/Référence de l'autorisation écrite/)).toHaveAccessibleDescription(/Obligatoire \(§ B\.4\)/);
    expect(champ(/Version du mapping/)).toHaveAccessibleDescription(/conservée avec le lot/);
    expect(screen.getByText(/Les champs marqués d'un \* sont obligatoires/)).toBeInTheDocument();
  });

  it("le format est une liste native avec les libellés du serveur, et son aide cite celle du serveur", async () => {
    const { utilisateur } = rendre();
    const liste = champ(/^Format/) as HTMLSelectElement;
    expect(liste.tagName).toBe("SELECT");
    expect(within(liste).getAllByRole("option").map((o) => o.textContent)).toEqual(["CSV (pivot, séparateur ;)", "GeoJSON (4326)"]);
    expect(liste).toHaveAccessibleDescription(/Fichier texte au format pivot/);
    await utilisateur.selectOptions(liste, "geojson");
    expect(liste).toHaveAccessibleDescription(/Collection de points ou de tronçons en WGS 84/);
    expect(liste).toHaveAccessibleDescription(/Seuls les formats de cette liste sont pris en charge/);
  });

  it("les sources déjà reçues sont des suggestions, la source reste un texte libre", async () => {
    const { utilisateur, container } = rendre();
    const entree = champ(/Système source/) as HTMLInputElement;
    expect(entree).toHaveAttribute("list");
    const liste = container.querySelector(`datalist#${CSS.escape(entree.getAttribute("list")!)}`)!;
    expect(Array.from(liste.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["ONR_BDR", "L2R_MESURE"]);
    await utilisateur.clear(entree);
    await utilisateur.type(entree, "NOUVELLE_SOURCE");
    expect(entree).toHaveValue("NOUVELLE_SOURCE");
  });

  it("sans source connue, l'aide le dit", () => {
    rendre({ sourcesConnues: [] });
    expect(champ(/Système source/)).toHaveAccessibleDescription(/Aucune source n'a encore été reçue/);
  });

  it("les valeurs initiales sont respectées", () => {
    rendre({ valeursInitiales: { systemeSource: "AUTRE", versionMapping: "v3", format: "geojson" } });
    expect(champ(/Système source/)).toHaveValue("AUTRE");
    expect(champ(/Version du mapping/)).toHaveValue("v3");
    expect(champ(/^Format/)).toHaveValue("geojson");
  });

  it("si csv n'est pas annoncé, le premier format du serveur est choisi", () => {
    rendre({ meta: { ...META, formats: [META.formats[1]] } });
    expect(champ(/^Format/)).toHaveValue("geojson");
  });
});

describe("Le bouton principal et la phrase qui dit ce qui manque", () => {
  it("à vide : inactif, la phrase énumère ce qui manque", () => {
    rendre();
    expect(bouton()).toBeDisabled();
    expect(screen.getByText(/il manque : la méthode de la source, la référence de l'autorisation écrite et un fichier\./)).toBeInTheDocument();
    expect(bouton()).toHaveAccessibleDescription(/il manque/);
  });

  it("ne s'active qu'une fois tout réuni, et la phrase suit chaque étape", async () => {
    const { utilisateur } = rendre();
    await utilisateur.type(champ(/Méthode de la source/), "export L2R");
    expect(bouton()).toBeDisabled();
    expect(screen.getByText(/il manque : la référence de l'autorisation écrite et un fichier\./)).toBeInTheDocument();
    await utilisateur.type(champ(/Référence de l'autorisation écrite/), "AUT-2026-01");
    expect(bouton()).toBeDisabled();
    expect(screen.getByText(/il manque : un fichier\./)).toBeInTheDocument();
    await utilisateur.upload(entreeFichier(), fichier());
    expect(bouton()).toBeEnabled();
    expect(screen.queryByText(/Pour activer/)).not.toBeInTheDocument();
  });

  it.each([
    ["systemeSource", /Système source/, "le système source"],
    ["methodeSource", /Méthode de la source/, "la méthode de la source"],
    ["versionMapping", /Version du mapping/, "la version du mapping"],
    ["autorisationRef", /Référence de l'autorisation écrite/, "la référence de l'autorisation écrite"],
  ])("vider %s désactive le bouton et le nomme", async (_cle, re, phrase) => {
    const { utilisateur } = rendre({ valeursInitiales: { ...COMPLETES } });
    await utilisateur.upload(entreeFichier(), fichier());
    expect(bouton()).toBeEnabled();
    await utilisateur.clear(champ(re));
    expect(bouton()).toBeDisabled();
    expect(screen.getByText(new RegExp(`il manque : ${phrase}\\.`))).toBeInTheDocument();
    // Des espaces seuls ne comptent pas.
    await utilisateur.type(champ(re), "    ");
    expect(bouton()).toBeDisabled();
  });

  it("retirer le fichier désactive le bouton", async () => {
    const { utilisateur } = rendre({ valeursInitiales: { ...COMPLETES } });
    await utilisateur.upload(entreeFichier(), fichier());
    expect(bouton()).toBeEnabled();
    await utilisateur.click(screen.getByRole("button", { name: "Retirer le fichier" }));
    expect(bouton()).toBeDisabled();
    expect(screen.getByText(/il manque : un fichier\./)).toBeInTheDocument();
  });

  it("une référence d'autorisation de moins de 5 caractères est à corriger : bouton inactif, erreur près du champ", async () => {
    const { utilisateur } = rendre({ valeursInitiales: { methodeSource: "export" } });
    await utilisateur.upload(entreeFichier(), fichier());
    const ref = champ(/Référence de l'autorisation écrite/);
    await utilisateur.type(ref, "ab");
    expect(bouton()).toBeDisabled();
    expect(screen.getByText(/corrigez : la référence de l'autorisation écrite/)).toBeInTheDocument();
    await utilisateur.tab(); // blur : l'erreur apparaît
    expect(ref).toBeInvalid();
    expect(ref).toHaveAccessibleDescription(/La référence doit comporter au moins 5 caractères \(contrat, courrier, numéro de référence\.\.\.\)/);
    await utilisateur.type(ref, "cde");
    expect(bouton()).toBeEnabled();
    expect(ref).not.toBeInvalid();
  });

  it("fichier trop gros : refusé avant l'envoi, bouton inactif, message et correction demandée", async () => {
    const { utilisateur, onSoumettre } = rendre({ valeursInitiales: { ...COMPLETES } });
    await utilisateur.upload(entreeFichier(), fichier("gros.csv", META.tailleMaxOctets + 1));
    expect(bouton()).toBeDisabled();
    expect(screen.getByText(/le maximum accepté est 50 Mo/)).toBeInTheDocument();
    expect(screen.getByText(/corrigez : le fichier choisi/)).toBeInTheDocument();
    fireEvent.submit(screen.getByRole("form", { name: "Recevoir un lot" }));
    expect(onSoumettre).not.toHaveBeenCalled();
  });

  it("extension incohérente avec le format déclaré : avertissement, bouton ACTIF (le serveur décide)", async () => {
    const { utilisateur } = rendre({ valeursInitiales: { ...COMPLETES } });
    await utilisateur.upload(entreeFichier(), fichier("lot.geojson"));
    expect(screen.getByText(/Le nom du fichier évoque le format GeoJSON \(4326\)/)).toBeInTheDocument();
    expect(bouton()).toBeEnabled();
    // Changer le format pour qu'il corresponde fait disparaître l'avertissement.
    await utilisateur.selectOptions(champ(/^Format/), "geojson");
    expect(screen.queryByText(/Le nom du fichier évoque/)).not.toBeInTheDocument();
  });

  it("dit en toute situation que la réception n'écrit rien dans le référentiel", () => {
    rendre();
    expect(screen.getByText(/Le serveur calcule l'empreinte du fichier reçu\. Aucune donnée du référentiel n'est modifiée/)).toBeInTheDocument();
  });

  it("formulaire désactivé par le parent : tout est inactif et la raison est dite", () => {
    rendre({ desactive: true, raisonDesactive: "Chargement des formats acceptés…", valeursInitiales: { ...COMPLETES } });
    expect(bouton()).toBeDisabled();
    expect(champ(/Système source/)).toBeDisabled();
    expect(champ(/^Format/)).toBeDisabled();
    expect(entreeFichier()).toBeDisabled();
    expect(screen.getByText("Chargement des formats acceptés…")).toBeInTheDocument();
  });
});

describe("Soumission invalide (par programme) : résumé d'erreurs, liens, focus", () => {
  it("résume les erreurs avec des liens vers les champs, met le focus sur le premier, n'envoie rien", async () => {
    const { onSoumettre, utilisateur } = rendre();
    fireEvent.submit(screen.getByRole("form", { name: "Recevoir un lot" }));
    expect(onSoumettre).not.toHaveBeenCalled();
    const resume = screen.getByText(/Le formulaire contient 3 erreurs à corriger avant l'envoi/).parentElement!.parentElement!;
    const liens = within(resume).getAllByRole("link").map((l) => l.textContent);
    expect(liens).toEqual(["Méthode de la source", "Référence de l'autorisation écrite", "Fichier à recevoir"]);
    await waitFor(() => expect(champ(/Méthode de la source/)).toHaveFocus());
    // Les erreurs sont aussi près des champs.
    expect(champ(/Méthode de la source/)).toBeInvalid();
    expect(champ(/Méthode de la source/)).toHaveAccessibleDescription(/Indiquez la méthode de la source/);
    expect(entreeFichier()).toHaveAccessibleDescription(/Choisissez le fichier à recevoir/);
    // Un lien envoie le focus sur son champ.
    await utilisateur.click(within(resume).getByRole("link", { name: "Référence de l'autorisation écrite" }));
    expect(champ(/Référence de l'autorisation écrite/)).toHaveFocus();
    await utilisateur.click(within(resume).getByRole("link", { name: "Fichier à recevoir" }));
    expect(entreeFichier()).toHaveFocus();
  });

  it("le résumé local disparaît quand on corrige", async () => {
    const { utilisateur } = rendre();
    fireEvent.submit(screen.getByRole("form", { name: "Recevoir un lot" }));
    expect(screen.getByText(/Le formulaire contient/)).toBeInTheDocument();
    await utilisateur.type(champ(/Méthode de la source/), "x");
    expect(screen.queryByText(/Le formulaire contient/)).not.toBeInTheDocument();
  });
});

describe("Envoi, progression, double envoi", () => {
  it("envoie les données nettoyées et le fichier choisi", async () => {
    const { utilisateur, onSoumettre } = rendre();
    await utilisateur.clear(champ(/Système source/));
    await utilisateur.type(champ(/Système source/), "  L2R_MESURE ");
    await toutRemplir(utilisateur, "releve.csv");
    await utilisateur.click(bouton());
    await waitFor(() => expect(onSoumettre).toHaveBeenCalledTimes(1));
    const [donnees, f, options] = onSoumettre.mock.calls[0];
    expect(donnees).toEqual({
      systemeSource: "L2R_MESURE", format: "csv", methodeSource: "export L2R", versionMapping: "v0", autorisationRef: "AUT-2026-01",
    });
    expect(f.name).toBe("releve.csv");
    expect(typeof options.onProgression).toBe("function");
  });

  it("pendant l'envoi : bouton et champs inactifs, barre de progression alimentée par onProgression", async () => {
    const envoi = envoiSuspendu();
    const { utilisateur } = rendre({ onSoumettre: envoi.onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const barre = await screen.findByRole("progressbar", { name: "Envoi du fichier" });
    expect(bouton()).toBeDisabled();
    expect(champ(/Méthode de la source/)).toBeDisabled();
    expect(entreeFichier()).toBeDisabled();
    expect(screen.getByRole("form", { name: "Recevoir un lot" })).toHaveAttribute("aria-busy", "true");
    // Avant toute mesure : progression indéterminée, dite comme telle.
    expect(barre).not.toHaveAttribute("aria-valuenow");
    expect(barre).toHaveAttribute("aria-valuetext", "Progression inconnue");

    act(() => envoi.options().onProgression({ envoye: 1024, total: 4096 }));
    expect(barre).toHaveAttribute("aria-valuenow", "25");
    expect(barre).toHaveAttribute("aria-valuemin", "0");
    expect(barre).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByText("25 % transmis.")).toBeInTheDocument();

    act(() => envoi.options().onProgression({ envoye: 4096, total: 4096 }));
    expect(barre).toHaveAttribute("aria-valuenow", "100");
    // 100 % transmis n'est pas « reçu et contrôlé » : le serveur travaille encore.
    expect(screen.getByText(/Fichier envoyé\. Le serveur calcule l'empreinte et contrôle le fichier/)).toBeInTheDocument();
    expect(screen.queryByText(/Reçu et contrôlé/)).not.toBeInTheDocument();

    await act(async () => { envoi.resoudre(); });
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("le bouton revient à l'issue de l'envoi pour un envoi suivant", async () => {
    const envoi = envoiSuspendu();
    const { utilisateur } = rendre({ onSoumettre: envoi.onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await act(async () => { envoi.resoudre(); });
    await screen.findByTestId("resultat-reception");
    expect(bouton()).toBeDisabled(); // plus de fichier : il en faut un autre
    await utilisateur.upload(entreeFichier(), fichier("suite.csv"));
    expect(bouton()).toBeEnabled();
  });

  it("empêche le double envoi : clic répété et soumission répétée n'appellent qu'une fois", async () => {
    const envoi = envoiSuspendu();
    const { utilisateur } = rendre({ onSoumettre: envoi.onSoumettre });
    await toutRemplir(utilisateur);
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    await utilisateur.click(bouton());
    await utilisateur.click(bouton());
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(envoi.onSoumettre).toHaveBeenCalledTimes(1);
    await act(async () => { envoi.resoudre(); });
    await screen.findByTestId("resultat-reception");
    expect(envoi.onSoumettre).toHaveBeenCalledTimes(1);
  });

  it("deux soumissions dans le même tick (avant tout rendu) n'envoient qu'une fois", async () => {
    const envoi = envoiSuspendu();
    const { utilisateur } = rendre({ onSoumettre: envoi.onSoumettre });
    await toutRemplir(utilisateur);
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(envoi.onSoumettre).toHaveBeenCalledTimes(1);
    await act(async () => { envoi.resoudre(); });
  });

  it("une progression tardive d'un envoi terminé est ignorée", async () => {
    const envoi = envoiSuspendu();
    const { utilisateur } = rendre({ onSoumettre: envoi.onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const options = envoi.options();
    await act(async () => { envoi.resoudre(); });
    await screen.findByTestId("resultat-reception");
    act(() => options.onProgression({ envoye: 1, total: 2 }));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("Entrée dans un champ envoie le formulaire quand il est complet", async () => {
    const { utilisateur, onSoumettre } = rendre({ valeursInitiales: { methodeSource: "export" } });
    await utilisateur.upload(entreeFichier(), fichier());
    await utilisateur.type(champ(/Référence de l'autorisation écrite/), "AUT-2026-01{Enter}");
    await waitFor(() => expect(onSoumettre).toHaveBeenCalledTimes(1));
  });

  it("Entrée dans un champ ne fait rien tant que le bouton est inactif", async () => {
    const { utilisateur, onSoumettre } = rendre();
    await utilisateur.type(champ(/Méthode de la source/), "export{Enter}");
    expect(onSoumettre).not.toHaveBeenCalled();
  });
});

describe("Succès : le lot est résumé avec son statut et sa référence", () => {
  it("VALIDE_SCHEMA : référence, statut, compteurs, phrase « Reçu et contrôlé », fichier vidé, informations conservées", async () => {
    const onRecu = vi.fn();
    const { utilisateur } = rendre({ onRecu });
    await toutRemplir(utilisateur, "releve.csv");
    await utilisateur.click(bouton());
    const resultat = await screen.findByTestId("resultat-reception");
    expect(within(resultat).getByRole("heading", { name: "Lot reçu." })).toBeInTheDocument();
    expect(within(resultat).getByText("IMP-2026-00002")).toBeInTheDocument();
    expect(within(resultat).getByText("Schéma validé, non appliqué")).toBeInTheDocument();
    expect(within(resultat).getByText("Reçu et contrôlé. Aucune donnée du référentiel n'a été modifiée.")).toBeInTheDocument();
    expect(within(resultat).getByText(/Fichier : releve\.csv/)).toBeInTheDocument();
    expect(within(resultat).getByText(/Le lot n'est pas importé/)).toBeInTheDocument();
    const compteurs = within(resultat).getAllByRole("definition").map((d) => d.textContent);
    expect(compteurs).toEqual(["4", "2", "1", "1"]);
    expect(onRecu).toHaveBeenCalledWith(REPONSE, "releve.csv");
    // Le fichier est vide, les informations restent.
    expect(screen.queryByRole("button", { name: "Retirer le fichier" })).not.toBeInTheDocument();
    expect(entreeFichier().files).toHaveLength(0);
    expect(champ(/Méthode de la source/)).toHaveValue("export L2R");
    expect(champ(/Référence de l'autorisation écrite/)).toHaveValue("AUT-2026-01");
    expect(champ(/Système source/)).toHaveValue("ONR_BDR");
    // Le focus va au résultat, et le bouton attend un nouveau fichier sans reprocher de champ vide.
    await waitFor(() => expect(resultat).toHaveFocus());
    expect(screen.queryByText(/Erreur :/)).not.toBeInTheDocument();
  });

  it("VALIDE_SCHEMA n'est pas présenté comme une réussite verte : l'import n'a pas eu lieu", async () => {
    const { utilisateur } = rendre();
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const resultat = await screen.findByTestId("resultat-reception");
    expect(resultat.textContent).not.toMatch(/importé avec succès|Importé\b/);
  });

  it("REJETE : présenté comme un résultat avec son motif, pas comme une panne", async () => {
    const rejet: ReceptionReponse = {
      ...REPONSE, id: "lot-3", reference: "IMP-2026-00003", statut: "REJETE",
      motifRejetLot: "GeoJSON : CRS urn:ogc:def:crs:EPSG::32628 refusé, le pivot impose le SRID 4326",
      compteurs: { lues: 0, validees: 0, rejetees: 0, ignorees: 0 },
    };
    const onEchec = vi.fn();
    const { utilisateur } = rendre({ onSoumettre: vi.fn<Soumettre>(async () => rejet), onEchec });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const resultat = await screen.findByTestId("resultat-reception");
    expect(within(resultat).getByRole("heading", { name: /Lot rejeté par le contrôle : c'est un résultat, pas une panne/ })).toBeInTheDocument();
    expect(within(resultat).getByText("IMP-2026-00003")).toBeInTheDocument();
    expect(within(resultat).getByText("Rejeté")).toBeInTheDocument();
    expect(within(resultat).getByText(/CRS urn:ogc:def:crs:EPSG::32628 refusé/)).toBeInTheDocument();
    expect(within(resultat).getByText("Reçu et contrôlé. Aucune donnée du référentiel n'a été modifiée.")).toBeInTheDocument();
    expect(within(resultat).getByText(/envoyé pour la même source, serait reconnu comme déjà reçu/)).toBeInTheDocument();
    // Ce n'est ni une alerte ni un échec.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onEchec).not.toHaveBeenCalled();
  });

  it("REJETE sans motif : dit « aucune ligne conforme » (comme l'ancienne page)", async () => {
    const rejet: ReceptionReponse = { ...REPONSE, statut: "REJETE", motifRejetLot: null };
    const { utilisateur } = rendre({ onSoumettre: vi.fn<Soumettre>(async () => rejet) });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    expect(await screen.findByText(/aucune ligne conforme/)).toBeInTheDocument();
  });

  it("dejaRecu avec métadonnées différentes : rien n'a été écrit, les nouvelles informations ne sont pas appliquées", async () => {
    const deja: ReceptionReponse = {
      ...REPONSE, id: "lot-1", reference: "IMP-2026-00001", dejaRecu: true,
      metadonneesDifferentes: [
        { champ: "methodeSource", recu: "export L2R", conserve: "relevé tablette" },
        { champ: "autorisationRef", recu: "AUT-2026-01", conserve: "AUT-2025-77" },
      ],
      memeEmpreinteAutresSources: [{ reference: "IMP-2026-00009", systemeSource: "L2R_MESURE" }],
      avertissements: ["colonne inconnue : couleur"],
    };
    const { utilisateur } = rendre({ onSoumettre: vi.fn<Soumettre>(async () => deja) });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const resultat = await screen.findByTestId("resultat-reception");
    expect(within(resultat).getByRole("heading", { name: "Ce fichier avait déjà été reçu : rien n'a été écrit." })).toBeInTheDocument();
    expect(within(resultat).getByText("IMP-2026-00001")).toBeInTheDocument();
    expect(within(resultat).getByText("Vos nouvelles informations n'ont pas été appliquées : le lot conserve les anciennes.")).toBeInTheDocument();
    expect(within(resultat).getByText(/vous avez saisi « export L2R », le lot conserve « relevé tablette »/)).toBeInTheDocument();
    expect(within(resultat).getByText(/vous avez saisi « AUT-2026-01 », le lot conserve « AUT-2025-77 »/)).toBeInTheDocument();
    expect(within(resultat).getByText("Méthode de la source")).toBeInTheDocument();
    expect(within(resultat).getByText(/Ce même contenu a aussi été reçu sous une autre source/)).toBeInTheDocument();
    expect(within(resultat).getByText("IMP-2026-00009")).toBeInTheDocument();
    expect(within(resultat).getByText("colonne inconnue : couleur")).toBeInTheDocument();
    // « Reçu et contrôlé » parlerait d'un envoi qui n'a rien écrit : on ne le dit pas ici.
    expect(within(resultat).queryByText(/^Reçu et contrôlé/)).not.toBeInTheDocument();
  });

  it("dejaRecu sans différence : pas de bloc « informations non appliquées »", async () => {
    const { utilisateur } = rendre({ onSoumettre: vi.fn<Soumettre>(async () => ({ ...REPONSE, dejaRecu: true })) });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const resultat = await screen.findByTestId("resultat-reception");
    expect(within(resultat).queryByText(/nouvelles informations/)).not.toBeInTheDocument();
  });

  it("les valeurs renvoyées par le serveur sont du texte : jamais interprétées comme du HTML", async () => {
    const piege: ReceptionReponse = {
      ...REPONSE, dejaRecu: true,
      metadonneesDifferentes: [{ champ: "methodeSource", recu: "<img src=x onerror=alert(1)>", conserve: "<b>gras</b>" }],
    };
    const { utilisateur, container } = rendre({ onSoumettre: vi.fn<Soumettre>(async () => piege) });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByTestId("resultat-reception");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  it("un résultat reste jusqu'au prochain envoi, puis laisse la place au nouveau", async () => {
    const reponses = [REPONSE, { ...REPONSE, id: "lot-4", reference: "IMP-2026-00004" }];
    const onSoumettre = vi.fn<Soumettre>(async () => reponses.shift()!);
    const { utilisateur } = rendre({ onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByText("IMP-2026-00002");
    await utilisateur.upload(entreeFichier(), fichier("suite.csv"));
    expect(screen.getByText("IMP-2026-00002")).toBeInTheDocument();
    await utilisateur.click(bouton());
    await screen.findByText("IMP-2026-00004");
    expect(screen.queryByText("IMP-2026-00002")).not.toBeInTheDocument();
  });
});

describe("Refus du serveur (400 avec code) : on corrige, rien n'est enregistré", () => {
  const cas: Array<[string, RegExp, RegExp]> = [
    ["FICHIER_MANQUANT", /Le serveur n'a reçu aucun fichier/, /Fichier à recevoir/],
    ["FICHIER_VIDE", /Le serveur a reçu un fichier vide/, /Fichier à recevoir/],
    ["FICHIER_TROP_GROS", /dépasse la taille maximale acceptée par le serveur \(50 Mo\)/, /Fichier à recevoir/],
    ["TROP_DE_LIGNES", /plus de lignes que le serveur n'en accepte \(100 000 lignes au plus\)/, /Fichier à recevoir/],
    ["ENCODAGE_NON_UTF8", /Le fichier n'est pas encodé en UTF-8 : réenregistrez-le en UTF-8 puis réessayez/, /Fichier à recevoir/],
    ["FORMAT_INCOHERENT", /contenu du fichier ne correspond pas au format déclaré/, /^Format$/],
  ];

  it.each(cas)("%s : message dédié, rattaché au bon champ, saisies conservées", async (code, texte, lien) => {
    const onEchec = vi.fn();
    const onSoumettre = vi.fn<Soumettre>(async () => { throw erreurHttp(400, { error: "brut", code }); });
    const { utilisateur } = rendre({ onSoumettre, onEchec });
    await toutRemplir(utilisateur, "mon_lot.csv");
    await utilisateur.click(bouton());
    const titre = await screen.findByText("Le serveur a refusé la réception. Rien n'a été enregistré.");
    const bloc = titre.closest("div")!;
    expect(within(bloc).getByRole("link", { name: lien })).toBeInTheDocument();
    expect(bloc).toHaveTextContent(texte);
    // Aucune perte : informations ET fichier sont là.
    expect(champ(/Méthode de la source/)).toHaveValue("export L2R");
    expect(champ(/Référence de l'autorisation écrite/)).toHaveValue("AUT-2026-01");
    expect(screen.getByTestId("nom-fichier")).toHaveTextContent("mon_lot.csv");
    // Le bouton et la page restent utilisables, et ce n'est pas présenté comme une réception incertaine.
    expect(screen.queryByText(/pas pu être confirmée/)).not.toBeInTheDocument();
    expect(onEchec).toHaveBeenCalledWith(expect.objectContaining({ nature: "refus", code }));
    // Le message est près du champ concerné.
    const concerne = code === "FORMAT_INCOHERENT" ? champ(/^Format/) : entreeFichier();
    expect(concerne).toBeInvalid();
    expect(concerne).toHaveAccessibleDescription(texte);
    await waitFor(() => expect(concerne).toHaveFocus());
  });

  it("TELEVERSEMENT_INVALIDE : alerte sans champ, saisies conservées", async () => {
    const onSoumettre = vi.fn<Soumettre>(async () => { throw erreurHttp(400, { error: "televersement invalide", code: "TELEVERSEMENT_INVALIDE" }); });
    const { utilisateur } = rendre({ onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("Rien n'a été enregistré");
    expect(alerte).toHaveTextContent(/interrompu ou était mal formé/);
    await waitFor(() => expect(alerte).toHaveFocus());
    expect(screen.getByTestId("nom-fichier")).toHaveTextContent("lot.csv");
    expect(bouton()).toBeEnabled();
  });

  it("CHAMPS_INVALIDES : les détails du serveur sont rattachés à chaque champ, en français", async () => {
    const onSoumettre = vi.fn<Soumettre>(async () => {
      throw erreurHttp(400, {
        error: "champs invalides", code: "CHAMPS_INVALIDES",
        details: { systemeSource: ["Required"], versionMapping: ["String must contain at most 64 character(s)"], dateSource: ["Invalid date"] },
      });
    });
    const { utilisateur } = rendre({ onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByText("Le serveur a refusé la réception. Rien n'a été enregistré.");
    expect(champ(/Système source/)).toBeInvalid();
    expect(champ(/Système source/)).toHaveAccessibleDescription(/Le serveur refuse cette valeur : valeur manquante\./);
    expect(champ(/Version du mapping/)).toHaveAccessibleDescription(/valeur trop longue \(64 caractères au maximum\)/);
    expect(screen.getByText(/dateSource : date non valide/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/String must|Required/);
    await waitFor(() => expect(champ(/Système source/)).toHaveFocus());
    // Corriger un champ efface SON erreur du serveur, pas celles des autres.
    await utilisateur.type(champ(/Système source/), "X");
    expect(champ(/Système source/)).not.toBeInvalid();
    expect(champ(/Version du mapping/)).toBeInvalid();
    expect(screen.getByTestId("nom-fichier")).toHaveTextContent("lot.csv");
  });

  it("refuse sans code connu : reprend le texte du serveur sans l'enjoliver", async () => {
    const onSoumettre = vi.fn<Soumettre>(async () => { throw erreurHttp(400, { error: "motif inattendu" }); });
    const { utilisateur } = rendre({ onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Le serveur a répondu : motif inattendu.");
  });

  it("403 : profil non autorisé, rien n'est perdu", async () => {
    const onSoumettre = vi.fn<Soumettre>(async () => { throw erreurHttp(403, { error: "interdit" }); });
    const { utilisateur } = rendre({ onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Votre profil n'est pas autorisé/);
    expect(screen.getByTestId("nom-fichier")).toBeInTheDocument();
  });

  it("503 SERVICE_OCCUPE avec Retry-After : le serveur affirme que rien n'a été créé, le délai est proposé", async () => {
    const onSoumettre = vi.fn<Soumettre>(async () => { throw erreurHttp(503, { error: "occupé", code: "SERVICE_OCCUPE" }, { "retry-after": "20" }); });
    const onEchec = vi.fn();
    const { utilisateur } = rendre({ onSoumettre, onEchec });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("Le serveur est occupé. Rien n'a été enregistré pour ce fichier.");
    expect(alerte).toHaveTextContent(/Le serveur traite déjà d'autres lots\. Rien n'a été enregistré pour ce fichier : réessayez dans quelques instants\./);
    expect(alerte).toHaveTextContent("Délai conseillé par le serveur : 20 secondes.");
    expect(document.body.textContent).not.toMatch(/pas pu être confirmée/);
    expect(onEchec).toHaveBeenCalledWith(expect.objectContaining({ nature: "refus", code: "SERVICE_OCCUPE", delaiSecondes: 20 }));
    // Données conservées, réessai possible.
    expect(screen.getByTestId("nom-fichier")).toHaveTextContent("lot.csv");
    expect(bouton()).toBeEnabled();
  });
});

describe("Réception non confirmée (réseau, délai, 5xx) : le lot a peut-être été enregistré", () => {
  it.each([
    ["réseau coupé", { code: "ERR_NETWORK", message: "Network Error" }],
    ["délai dépassé", { code: "ECONNABORTED", message: "timeout of 30000ms exceeded" }],
    ["500", erreurHttp(500, { error: "boom" })],
    ["503 sans code (passerelle)", erreurHttp(503, "<html>Service Unavailable</html>")],
  ])("%s : message distinct, informations et fichier conservés, aucun résultat affiché", async (_nom, erreur) => {
    const onEchec = vi.fn();
    const onSoumettre = vi.fn<Soumettre>(async () => { throw erreur; });
    const { utilisateur } = rendre({ onSoumettre, onEchec });
    await toutRemplir(utilisateur, "important.csv");
    await utilisateur.click(bouton());
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("La réception n'a pas pu être confirmée.");
    expect(alerte).toHaveTextContent(/Consultez la liste des lots avant de réessayer : le lot a peut-être été enregistré/);
    expect(alerte).not.toHaveTextContent(/Le serveur a refusé/);
    expect(screen.queryByTestId("resultat-reception")).not.toBeInTheDocument();
    expect(champ(/Méthode de la source/)).toHaveValue("export L2R");
    expect(champ(/Référence de l'autorisation écrite/)).toHaveValue("AUT-2026-01");
    expect(champ(/Système source/)).toHaveValue("ONR_BDR");
    expect(screen.getByTestId("nom-fichier")).toHaveTextContent("important.csv");
    expect(onEchec).toHaveBeenCalledWith(expect.objectContaining({ nature: "incertain" }));
    await waitFor(() => expect(alerte).toHaveFocus());
    expect(bouton()).toBeEnabled();
  });

  it("un nouvel essai réussit : le résultat remplace l'alerte", async () => {
    const onSoumettre = vi.fn<Soumettre>()
      .mockRejectedValueOnce({ code: "ERR_NETWORK" })
      .mockResolvedValueOnce({ ...REPONSE, dejaRecu: true });
    const { utilisateur } = rendre({ onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByRole("alert");
    await utilisateur.click(bouton());
    await screen.findByTestId("resultat-reception");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSoumettre).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: /déjà été reçu/ })).toBeInTheDocument();
  });
});

describe("Clavier seul", () => {
  it("Tab parcourt les champs dans l'ordre, puis la zone de dépôt, et Entrée/Espace actionnent les boutons", async () => {
    const clic = vi.spyOn(HTMLInputElement.prototype, "click");
    const { utilisateur } = rendre({ valeursInitiales: { ...COMPLETES } });
    await utilisateur.tab();
    expect(champ(/Système source/)).toHaveFocus();
    await utilisateur.tab();
    expect(champ(/^Format/)).toHaveFocus();
    await utilisateur.tab();
    expect(champ(/Méthode de la source/)).toHaveFocus();
    await utilisateur.tab();
    expect(champ(/Version du mapping/)).toHaveFocus();
    await utilisateur.tab();
    expect(champ(/Référence de l'autorisation écrite/)).toHaveFocus();
    await utilisateur.tab();
    expect(entreeFichier()).toHaveFocus();
    await utilisateur.tab();
    const parcourir = screen.getByRole("button", { name: "Parcourir vos fichiers" });
    expect(parcourir).toHaveFocus();
    await utilisateur.keyboard("{Enter}");
    expect(clic).toHaveBeenCalledTimes(1);
    await utilisateur.keyboard(" ");
    expect(clic).toHaveBeenCalledTimes(2);
    // Le bouton principal inactif n'est pas dans l'ordre de tabulation : on n'y tombe pas à vide.
    await utilisateur.tab();
    expect(document.body).toHaveFocus();
  });

  it("clavier seul de bout en bout : saisie, choix, Espace sur le bouton principal", async () => {
    const { utilisateur, onSoumettre } = rendre();
    await utilisateur.tab(); await utilisateur.tab(); await utilisateur.tab();
    await utilisateur.keyboard("export L2R");
    await utilisateur.tab(); await utilisateur.tab();
    await utilisateur.keyboard("AUT-2026-01");
    // Le choix du fichier passe par le sélecteur du système : on le simule sur l'input déjà focalisé par Tab.
    await utilisateur.upload(entreeFichier(), fichier());
    bouton().focus();
    await utilisateur.keyboard(" ");
    await waitFor(() => expect(onSoumettre).toHaveBeenCalledTimes(1));
    expect(onSoumettre.mock.calls[0][0].methodeSource).toBe("export L2R");
  });
});

describe("Mise en page responsive", () => {
  it("grille 1 colonne, 2 dès lg, 3 dès xl, 2 dès 2xl (colonne principale plus étroite) ; aucune largeur fixe en pixels", () => {
    const { container } = rendre();
    const grille = container.querySelector(".grid.grid-cols-1")!;
    // La barre latérale prend 256 px : les seuils sont ceux de la largeur UTILE (mesuré au navigateur, page /imports).
    expect(grille).toHaveClass("lg:grid-cols-2", "xl:grid-cols-3", "2xl:grid-cols-2");
    expect(grille.children).toHaveLength(5);
    const fautifs = Array.from(container.querySelectorAll("[class]")).filter((e) => /(^|\s)(min-|max-)?w-\[\d+(px|rem)\]/.test(e.getAttribute("class") ?? ""));
    expect(fautifs).toHaveLength(0);
  });

  it("le bouton principal prend toute la largeur sur mobile", () => {
    rendre();
    expect(bouton()).toHaveClass("w-full", "sm:w-auto");
  });

  it("les contrôles ont une hauteur d'au moins 44 px (h-11)", async () => {
    const { utilisateur } = rendre();
    await utilisateur.upload(entreeFichier(), fichier());
    for (const re of [/Système source/, /^Format/, /Méthode de la source/, /Version du mapping/, /Référence de l'autorisation écrite/]) {
      expect(champ(re)).toHaveClass("h-11");
    }
    for (const nom of ["Recevoir et contrôler le lot", "Parcourir vos fichiers", "Retirer le fichier"]) {
      expect(screen.getByRole("button", { name: nom })).toHaveClass("h-11");
    }
  });
});

describe("Style des textes", () => {
  it("aucun tiret cadratin ni demi-cadratin, aucun emoji dans le rendu", async () => {
    const { utilisateur, container } = rendre();
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByTestId("resultat-reception");
    expect(container.textContent).not.toMatch(/[–—]/);
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("Accessibilité (axe)", () => {
  it("formulaire vide", async () => {
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("erreurs de champ et résumé d'erreurs", async () => {
    const { container } = rendre();
    fireEvent.submit(screen.getByRole("form", { name: "Recevoir un lot" }));
    await screen.findByText(/Le formulaire contient 3 erreurs/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("erreurs du serveur rattachées aux champs", async () => {
    const onSoumettre = vi.fn<Soumettre>(async () => {
      throw erreurHttp(400, { code: "CHAMPS_INVALIDES", details: { systemeSource: ["Required"], methodeSource: ["Required"] } });
    });
    const { container, utilisateur } = rendre({ onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByText(/Rien n'a été enregistré/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("fichier choisi", async () => {
    const { container, utilisateur } = rendre({ valeursInitiales: { ...COMPLETES } });
    await utilisateur.upload(entreeFichier(), fichier("export_releves_RN1_2026_octobre_version_finale_corrigee.geojson"));
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("envoi en cours", async () => {
    const envoi = envoiSuspendu();
    const { container, utilisateur } = rendre({ onSoumettre: envoi.onSoumettre });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByRole("progressbar");
    act(() => envoi.options().onProgression({ envoye: 10, total: 100 }));
    expect(await violationsAccessibilite(container)).toEqual([]);
    await act(async () => { envoi.resoudre(); });
  });

  it("succès (lot reçu)", async () => {
    const { container, utilisateur } = rendre();
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByTestId("resultat-reception");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("succès (déjà reçu, informations différentes) et lot rejeté", async () => {
    const deja: ReceptionReponse = {
      ...REPONSE, dejaRecu: true, statut: "REJETE", motifRejetLot: "motif",
      metadonneesDifferentes: [{ champ: "methodeSource", recu: "a", conserve: "b" }],
      memeEmpreinteAutresSources: [{ reference: "IMP-9", systemeSource: "X" }], avertissements: ["w"],
    };
    const { container, utilisateur } = rendre({ onSoumettre: vi.fn<Soumettre>(async () => deja) });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByTestId("resultat-reception");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("réception non confirmée", async () => {
    const { container, utilisateur } = rendre({ onSoumettre: vi.fn<Soumettre>(async () => { throw { code: "ERR_NETWORK" }; }) });
    await toutRemplir(utilisateur);
    await utilisateur.click(bouton());
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
