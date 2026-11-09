import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-leaflet", async () => (await import("../carteDouble.testutil")).moduleReactLeaflet());
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssistantImport, type JeuReprise } from "./AssistantImport";
import {
  DELTA_AUTORISE_AVEC_RETOUR, DELTA_SANS_SUPPRESSION, ERREUR, OPTIONS, SHA, apercu, deltaDetail, inventaireCsv, inventaireGeojson, inventaireKml, inventaireKmlUneCouche,
  inventaireKmz, reponseDepot, CRS_UTM29,
} from "./assistantImport.testutil";

/**
 * Assistant d'import, de bout en bout contre une API SIMULEE (aucun backend). On verifie ce qui part sur le fil (URL, champs, ordre, parametres) et
 * ce qui s'affiche. Fixtures synthetiques ; formes de reponse du contrat A1 et du code reel du backend.
 */

const BASE = "/v2/projets-voirie";
const CONCESSIONNAIRES = [{ id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM", contact: null }];

interface Serveur {
  options: unknown; inventaire: unknown; apercu: unknown; simulation: unknown; depot: unknown; delta: unknown;
  erreurs: Record<string, unknown[]>;
  /** Comportement a la place de la reponse nominale (envoi qui n'aboutit pas, progression...). */
  surPost: Record<string, (corps: FormData, cfg: { params?: Record<string, string>; signal?: AbortSignal; onUploadProgress?: (e: { loaded: number; total?: number }) => void }) => Promise<unknown>>;
}
let s: Serveur;

function reinitialiserServeur() {
  s = { options: OPTIONS, inventaire: inventaireKml(), apercu: apercu(), simulation: reponseDepot(), depot: reponseDepot({}, false), delta: deltaDetail(), erreurs: {}, surPost: {} };
}
const piege = (cle: string, e: unknown) => { (s.erreurs[cle] ??= []).push(e); };
const echoue = (cle: string) => { const e = s.erreurs[cle]?.shift(); if (e) throw e; };

function installer() {
  h.get.mockImplementation(async (url: string) => {
    if (url === `${BASE}/concessionnaires`) return { data: CONCESSIONNAIRES };
    if (url === `${BASE}/p1/import/options`) { echoue("options"); return { data: s.options }; }
    if (/\/delta$/.test(url)) { echoue("delta"); return { data: s.delta }; }
    return { data: {} };
  });
  h.post.mockImplementation(async (url: string, corps: FormData | Record<string, unknown>, cfg: { params?: Record<string, string>; signal?: AbortSignal; onUploadProgress?: (e: { loaded: number; total?: number }) => void } = {}) => {
    const cle = /\/import\/inventaire$/.test(url) ? "inventaire" : /\/import\/apercu$/.test(url) ? "apercu" : /\/jeux$/.test(url) ? (cfg.params?.simuler ? "simulation" : "depot")
      : /\/revue-suppressions$/.test(url) ? "revue" : /\/autoriser$/.test(url) ? "autoriser" : /\/rejeter$/.test(url) ? "rejeter" : /\/retour-arriere$/.test(url) ? "retour" : "autre";
    if (s.surPost[cle]) return { data: await s.surPost[cle](corps as FormData, cfg) };
    echoue(cle);
    switch (cle) {
      case "inventaire": return { data: s.inventaire };
      case "apercu": return { data: s.apercu };
      case "simulation": return { data: s.simulation };
      case "depot": return { data: s.depot };
      case "revue": {
        const d = (corps as { decision: string; justification: string });
        s.delta = deltaDetail({ suppressions: { statut: d.decision === "ACCEPTER" ? "ACCEPTEES" : "REFUSEES", nb: 1, revue: { par: { id: "u1", nomComplet: "Sekou Gestionnaire" }, le: "2026-11-08T09:00:00Z", decision: d.decision, justification: d.justification } } });
        return { data: { jeu: {}, suppressions: (s.delta as { suppressions: unknown }).suppressions, evenement: { id: "e1" } } };
      }
      case "autoriser": s.delta = DELTA_AUTORISE_AVEC_RETOUR(); return { data: { jeu: { id: "jeu-nouveau", role: "RESEAU_TIERS", statut: "AUTORISE" } } };
      case "rejeter": s.delta = deltaDetail({ jeu: { id: "jeu-nouveau", version: 3, statut: "REJETE", role: "RESEAU_TIERS" } }); return { data: { jeu: { id: "jeu-nouveau", role: "RESEAU_TIERS", statut: "REJETE" } } };
      case "retour": s.delta = deltaDetail({ jeu: { id: "jeu-nouveau", version: 3, statut: "REMPLACE", role: "RESEAU_TIERS" } }); return { data: { jeuRestaure: { id: "ancien", version: 2 }, jeuRetire: { id: "jeu-nouveau", version: 3 }, evenement: { id: "e2" } } };
      default: return { data: {} };
    }
  });
}

function rendre(props: { enLigne?: boolean; onVoirJeu?: (id: string) => void; jeuReprise?: JeuReprise | null } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onFermer = vi.fn();
  const onVoirJeu = props.onVoirJeu ?? vi.fn();
  const r = render(<QueryClientProvider client={qc}><AssistantImport projetId="p1" enLigne={props.enLigne ?? true} onFermer={onFermer} onVoirJeu={onVoirJeu} jeuReprise={props.jeuReprise ?? null} /></QueryClientProvider>);
  return { ...r, onFermer, onVoirJeu };
}

const dialogue = () => screen.getByRole("dialog");
const champFichier = () => document.querySelector<HTMLInputElement>("input[type=file]")!;
const kml = (nom = "reseau-synthetique.kml") => new File(["<kml/>"], nom);
const bouton = (nom: string | RegExp) => screen.getByRole("button", { name: nom });
const etape = async (titre: string) => screen.findByRole("heading", { name: titre }, { timeout: 8000 });
const utilisateur = () => userEvent.setup({ applyAccept: false });
type U = ReturnType<typeof utilisateur>;

async function deposer(u: U, fichier: File = kml()) {
  await screen.findByTestId("formats-acceptes");
  await u.upload(champFichier(), fichier);
  await screen.findByRole("option", { name: /Operateur synthetique A/ });
  await u.selectOptions(within(dialogue()).getByLabelText("Concessionnaire propriétaire du réseau"), "c1");
}
async function analyser(u: U) { await u.click(bouton("Analyser le fichier")); await etape("Format et couches"); }
async function versCrs(u: U, couche = "Fibre / Chambres") {
  await deposer(u); await analyser(u);
  if (couche) await u.click(screen.getByRole("radio", { name: new RegExp(couche) }));
  await u.click(bouton("Continuer"));
  await etape("Système de coordonnées");
}
async function verifierCrs(u: U) { await u.click(bouton(/(Vérifier|Recalculer) la transformation/)); await screen.findByTestId("bloc-crs"); }
async function versMapping(u: U) { await versCrs(u); await verifierCrs(u); await u.click(bouton("Continuer")); await etape("Correspondance des champs"); }
async function versControles(u: U) { await versMapping(u); await u.click(bouton("Continuer vers les contrôles")); await etape("Contrôles et échantillon"); }
async function versDelta(u: U) { await versControles(u); await u.click(bouton("Simuler l'enregistrement")); await etape("Comparaison avec la version autorisée"); }
async function versDeltaDetaille(u: U) {
  await versDelta(u);
  await u.click(bouton("Enregistrer en quarantaine"));
  await screen.findByTestId("delta-detail");
}
const champs = (corps: FormData) => Object.fromEntries([...corps.entries()].filter(([k]) => k !== "fichier"));
const appels = (motif: RegExp) => h.post.mock.calls.filter((c) => motif.test(c[0] as string));

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset();
  reinitialiserServeur();
  installer();
});

describe("etape 1 : depot", () => {
  it("formats acceptes et taille maximale viennent de l'API ; avertissement de confidentialite ; conservation de l'original", async () => {
    rendre();
    const f = await screen.findByTestId("formats-acceptes");
    expect(f).toHaveTextContent("KML : .kml");
    expect(f).toHaveTextContent("KMZ (archive KML) : .kmz");
    expect(f).toHaveTextContent("GeoJSON : .geojson, .json");
    expect(f).toHaveTextContent("GPX : .gpx");
    expect(f).toHaveTextContent("Tableau délimité (CSV, TSV, TXT) : .csv, .tsv, .txt");
    expect(f).toHaveTextContent("Pas encore lus : GEOPACKAGE, SHAPEFILE, DXF, DWG");
    expect(f).toHaveTextContent(/détecté par le contenu du fichier, pas par son extension/);
    expect(dialogue()).toHaveTextContent("Fichier (25 Mo maximum)");
    expect(dialogue()).toHaveTextContent(/données d'infrastructure sensibles/);
    expect(screen.getByTestId("conservation-original")).toHaveTextContent(/ne garde que l'empreinte \(SHA-256\) et la taille/);
    expect(dialogue()).toHaveTextContent("Un fichier reçu n'est pas un fichier importé");
    expect(screen.getByTestId("etape-texte")).toHaveTextContent("Étape 1 sur 7 : Dépôt du fichier");
  });
  it("conservation du fichier d'origine dite quand le serveur la garde", async () => {
    s.options = { ...OPTIONS, conservationOriginal: "STOCKE" };
    rendre();
    expect(await screen.findByTestId("conservation-original")).toHaveTextContent(/garde une copie/);
  });
  it("le role et l'origine du jeu se saisissent ; le role change les valeurs proposees ; l'origine est facultative", async () => {
    const u = utilisateur();
    rendre();
    await screen.findByTestId("formats-acceptes");
    await u.selectOptions(within(dialogue()).getByLabelText("Rôle du fichier"), "AXES_TRAVAUX");
    expect(within(dialogue()).getByLabelText("Confidentialité")).toHaveValue("RESTREINT_PROJET");
    expect(within(dialogue()).getByLabelText("Nature des objets")).toHaveValue("AXE");
    expect(within(dialogue()).queryByLabelText("Concessionnaire propriétaire du réseau")).toBeNull();
    expect(within(dialogue()).getByLabelText(/Origine du fichier \(facultatif\)/)).toHaveValue("");
  });
  it("sans fichier ou sans concessionnaire : message, aucun envoi", async () => {
    const u = utilisateur();
    rendre();
    await screen.findByTestId("formats-acceptes");
    await u.click(bouton("Analyser le fichier"));
    expect(await screen.findByText("Choisissez un fichier.")).toBeInTheDocument();
    expect(within(dialogue()).getByText("Corrigez les champs signalés avant de lancer l'analyse du fichier.")).toBeInTheDocument();
    await u.upload(champFichier(), kml());
    await u.click(bouton("Analyser le fichier"));
    expect(await screen.findByText(/Choisissez le concessionnaire propriétaire/)).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("un fichier de plus que la taille de l'API est refuse en clair, sans envoi", async () => {
    s.options = { ...OPTIONS, limites: { ...OPTIONS.limites, tailleMaxOctets: 1000 } };
    const u = utilisateur();
    rendre();
    await screen.findByTestId("formats-acceptes");
    await u.upload(champFichier(), new File([new Uint8Array(2000)], "gros.kml"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/maximum est de 1000 o/);
    await u.click(bouton("Analyser le fichier"));
    expect(h.post).not.toHaveBeenCalled();
  });
  it("un PDF ou un HTML est refuse localement (pas une donnee SIG), sans envoi", async () => {
    const u = utilisateur();
    rendre();
    await screen.findByTestId("formats-acceptes");
    for (const nom of ["plan.pdf", "carte.html"]) {
      await u.upload(champFichier(), new File(["x"], nom));
      expect(await screen.findByRole("alert")).toHaveTextContent(/pas une donnée SIG/);
    }
    expect(h.post).not.toHaveBeenCalled();
  });
  it("une extension d'un format hors lot (GeoPackage) part au serveur, qui decide par le contenu : 415 dit en clair", async () => {
    piege("inventaire", ERREUR(415, "FORMAT_NON_SUPPORTE"));
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["x"], "plan.gpkg"));
    expect(dialogue()).toHaveTextContent(/ne lit pas/);
    await u.click(bouton("Analyser le fichier"));
    const alerte = await screen.findByText(/Code : FORMAT_NON_SUPPORTE/).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent(/GeoPackage, Shapefile, DXF et DWG sont prévus à un lot suivant/);
    expect(screen.getByRole("heading", { name: "Dépôt du fichier" })).toBeInTheDocument();
  });
  it("hors ligne : on ne peut pas analyser", async () => {
    rendre({ enLigne: false });
    await screen.findByTestId("formats-acceptes");
    expect(bouton("Analyser le fichier")).toBeDisabled();
    expect(screen.getByText(/hors ligne : l'assistant a besoin du réseau/)).toBeInTheDocument();
  });
  it("les options de l'API en erreur : message et nouvel essai ; rien d'autre", async () => {
    piege("options", ERREUR(403, "ROLE_INSUFFISANT"));
    rendre();
    expect(await screen.findByText(/action refusée/)).toBeInTheDocument();
    expect(screen.queryByText("Analyser le fichier")).toBeNull();
  });
});

describe("etape 2 : format detecte par le contenu, couches", () => {
  it("l'inventaire part avec le fichier seul, sans option ; format, empreinte, extension et couches s'affichent ; la couche se choisit explicitement", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u);
    await analyser(u);
    const [url, corps] = h.post.mock.calls[0];
    expect(url).toBe(`${BASE}/p1/import/inventaire`);
    expect([...(corps as FormData).keys()]).toEqual(["fichier"]);
    expect(screen.getByTestId("detection")).toHaveTextContent("Format détecté par le contenu : KML (extension déclarée : .kml)");
    expect(screen.getByTestId("detection")).toHaveTextContent(/SHA-256 abababababab…/);
    expect(screen.getByRole("radio", { name: /Fibre \/ Principal/ })).not.toBeChecked();
    expect(dialogue()).toHaveTextContent("3 objet(s), 3 ligne(s)");
    expect(dialogue()).toHaveTextContent("2 objet(s), 2 point(s)");
    expect(dialogue()).toHaveTextContent(/Le fichier contient plusieurs couches/);
    expect(bouton("Continuer")).toBeDisabled();
    expect(screen.getByTestId("blocage-format")).toHaveTextContent(/plusieurs couches/);
    await u.click(screen.getByRole("radio", { name: /Fibre \/ Principal/ }));
    expect(bouton("Continuer")).toBeEnabled();
  });
  it("« toutes les couches » est un choix explicite", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u); await analyser(u);
    await u.click(screen.getByRole("radio", { name: /Toutes les couches/ }));
    expect(bouton("Continuer")).toBeEnabled();
  });
  it("une seule couche : aucun choix a faire", async () => {
    s.inventaire = inventaireKmlUneCouche();
    const u = utilisateur();
    rendre();
    await deposer(u); await analyser(u);
    expect(bouton("Continuer")).toBeEnabled();
  });
  it("l'extension qui ne correspond pas au contenu est signalee : le contenu fait foi", async () => {
    s.inventaire = inventaireKmlUneCouche({ detection: { methode: "contenu", extensionDeclaree: "kmz", extensionCoherente: false } });
    const u = utilisateur();
    rendre();
    await deposer(u); await analyser(u);
    expect(screen.getByRole("status")).toHaveTextContent(/le contenu fait foi/);
  });
  it("KMZ a plusieurs KML : entrees listees, jamais extraites, choix de l'entree puis relance de la detection avec entreeKml", async () => {
    s.inventaire = inventaireKmz();
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["PK"], "archive-synthetique.kmz"));
    await analyser(u);
    expect(dialogue()).toHaveTextContent("a/premier.kml");
    expect(dialogue()).toHaveTextContent("icone.png");
    expect(dialogue()).toHaveTextContent(/jamais extraite/);
    expect(bouton("Continuer")).toBeDisabled();
    s.inventaire = inventaireKmz({ archive: { ...(inventaireKmz().archive as object), kmlPrincipal: "b/second.kml", choixRequis: false }, couches: [{ id: "c0", nom: "Second", nbObjets: 2, parTypeGeom: { LIGNE: 2 } }] });
    await u.selectOptions(within(dialogue()).getByLabelText("Entrée KML à lire"), "b/second.kml");
    expect(screen.getByTestId("inventaire-perime")).toBeInTheDocument();
    await u.click(bouton("Relancer la détection avec cette entrée"));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    expect(champs(h.post.mock.calls[1][1])).toEqual({ entreeKml: "b/second.kml" });
    await waitFor(() => expect(screen.queryByTestId("inventaire-perime")).toBeNull());
  });
});

describe("etape 3 : systeme de coordonnees et unites", () => {
  it("KML : WGS 84 impose par la norme, aucun choix ; « Verifier » envoie la couche et rend source, cible, unites, methode, plausibilite", async () => {
    const u = utilisateur();
    rendre();
    await versCrs(u);
    expect(screen.getByTestId("crs-impose")).toHaveTextContent("EPSG:4326 (WGS 84, degrés)");
    expect(within(dialogue()).queryByLabelText("Système de coordonnées source")).toBeNull();
    expect(screen.getByTestId("crs-cible")).toHaveTextContent("EPSG:4326 (WGS 84, degrés)");
    expect(bouton("Continuer")).toBeDisabled();
    await verifierCrs(u);
    expect(champs(h.post.mock.calls[1][1])).toEqual({ couche: "c1" });
    const crs = screen.getByTestId("bloc-crs");
    expect(crs).toHaveTextContent("Système sourceWGS84 (EPSG:4326)");
    expect(crs).toHaveTextContent("Système cibleEPSG:4326");
    expect(crs).toHaveTextContent("Unitésdegrés (source), degrés (cible)");
    expect(crs).toHaveTextContent("Méthodeaucune transformation");
    expect(crs).toHaveTextContent("Imposé par la norme du format");
    expect(screen.getByTestId("plausibilite")).toHaveTextContent("Conforme : les 3 objet(s) tombent dans la zone attendue.");
    expect(bouton("Continuer")).toBeEnabled();
  });

  async function versCrsCsv(u: U) {
    s.inventaire = inventaireCsv();
    s.apercu = apercu({ format: "CSV", resume: { ...apercu().resume, crs: CRS_UTM29, import: { couche: null, entreeKml: null, csv: { delimiteur: ";", encodage: "utf-8", separateurDecimal: ",", mode: "lignes", nbLignes: 13, nbLignesRejetees: 0 }, rejets: [], rejetsTronques: false } } });
    await deposer(u, new File(["a;b"], "plan-axes-synthetique.csv"));
    await analyser(u);
    await u.click(screen.getByRole("radio", { name: /Lignes : des points regroupés/ }));
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne X"), "x");
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne Y"), "y");
    await u.selectOptions(within(dialogue()).getByLabelText(/Colonne clé/), "axe");
    await u.selectOptions(within(dialogue()).getByLabelText(/Colonne d'ordre/), "ordre");
    await u.click(bouton("Continuer"));
    await etape("Système de coordonnées");
  }

  it("CSV : choix OBLIGATOIRE, champ vide au depart, aucune valeur par defaut ; la verification est impossible tant que rien n'est choisi", async () => {
    const u = utilisateur();
    rendre();
    await versCrsCsv(u);
    const sel = within(dialogue()).getByLabelText("Système de coordonnées source") as HTMLSelectElement;
    expect(sel.value).toBe("");
    expect(within(sel).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choisir un système",
      "EPSG:4326 : WGS 84, unité : degrés",
      "EPSG:32628 : WGS 84 / UTM zone 28N, unité : mètres",
      "EPSG:32629 : WGS 84 / UTM zone 29N, unité : mètres",
    ]);
    expect(screen.getByTestId("crs-obligatoire")).toHaveTextContent(/jamais deviné ni rempli par défaut/);
    expect(bouton("Vérifier la transformation")).toBeDisabled();
    expect(h.post).toHaveBeenCalledTimes(1);
    await u.selectOptions(sel, "32629");
    await u.click(bouton("Vérifier la transformation"));
    const crs = await screen.findByTestId("bloc-crs");
    expect(champs(h.post.mock.calls[1][1])).toEqual({
      epsgSource: "32629", colonneX: "x", colonneY: "y", colonneCle: "axe", colonneOrdre: "ordre",
    });
    expect(crs).toHaveTextContent("EPSG:32629 (WGS 84 / UTM zone 29N)");
    expect(crs).toHaveTextContent("Unitésmètres (source), degrés (cible)");
    expect(crs).toHaveTextContent("ST_Transform (PostGIS, PROJ 7.2.1), PROJ 7.2.1");
    expect(crs).toHaveTextContent("Choisi par vous");
  });

  it("GeoJSON qui declare un systeme projete : seul ce systeme est propose, a CONFIRMER", async () => {
    s.inventaire = inventaireGeojson("EPSG:32629");
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["{}"], "axes-synthetiques.geojson"));
    await analyser(u);
    await u.click(screen.getByRole("radio", { name: /Entites/ }));
    await u.click(bouton("Continuer"));
    await etape("Système de coordonnées");
    const sel = within(dialogue()).getByLabelText("Système de coordonnées source");
    expect(within(sel).getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual(["", "32629"]);
    expect(screen.getByTestId("crs-obligatoire")).toHaveTextContent(/déclare lui-même EPSG:32629/);
    expect(bouton("Vérifier la transformation")).toBeDisabled();
    // Defaut D5 du pilote : un CRS declare par le fichier puis confirme n'est pas presente comme un choix inverifiable.
    s.apercu = apercu({ resume: { ...apercu().resume, crs: { ...CRS_UTM29, origine: "declare_dans_le_fichier" } } });
    await u.selectOptions(sel, "32629");
    await u.click(bouton("Vérifier la transformation"));
    const crs = await screen.findByTestId("bloc-crs");
    expect(crs).toHaveTextContent("Déclaré par le fichier lui-même");
    expect(crs).not.toHaveTextContent("Choisi par vous");
  });

  it("GeoJSON sans systeme declare : WGS 84 par la norme, choix facultatif", async () => {
    s.inventaire = inventaireGeojson(null);
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["{}"], "axes.geojson"));
    await analyser(u);
    await u.click(screen.getByRole("radio", { name: /Entites/ }));
    await u.click(bouton("Continuer"));
    await etape("Système de coordonnées");
    expect(screen.getByTestId("crs-facultatif")).toBeInTheDocument();
    expect(bouton("Vérifier la transformation")).toBeEnabled();
  });

  it("409 CONFIRMATION_HORS_ZONE_REQUISE : avertissement BLOQUANT, confirmation explicite requise, puis l'apercu est refait avec confirmerHorsZone", async () => {
    const u = utilisateur();
    rendre();
    await versCrsCsv(u);
    await u.selectOptions(within(dialogue()).getByLabelText("Système de coordonnées source"), "32629");
    piege("apercu", ERREUR(409, "CONFIRMATION_HORS_ZONE_REQUISE", { nbElementsHorsZone: 4, nbObjets: 10 }));
    await u.click(bouton("Vérifier la transformation"));
    const alerte = await screen.findByTestId("alerte-hors-zone");
    expect(alerte).toHaveTextContent("4 élément(s) sur 10 tombent hors de la Guinée");
    expect(alerte).toHaveTextContent("avancement bloqué");
    expect(bouton("Continuer")).toBeDisabled();
    const confirmer = within(alerte).getByRole("button", { name: "Confirmer et recalculer l'aperçu" });
    expect(confirmer).toBeDisabled();
    await u.click(within(alerte).getByRole("checkbox", { name: /Je confirme que ces 4 élément\(s\) hors zone seront écartés/ }));
    expect(confirmer).toBeEnabled();
    s.apercu = apercu({ resume: { ...apercu().resume, crs: { ...CRS_UTM29, plausibilite: { ...CRS_UTM29.plausibilite, nbElementsHorsZone: 4, nbObjets: 6, statut: "PARTIELLEMENT_HORS_ZONE", confirmationRequise: true, confirmee: true } } } });
    await u.click(confirmer);
    await screen.findByTestId("bloc-crs");
    expect(champs(h.post.mock.calls[2][1])).toMatchObject({ epsgSource: "32629", confirmerHorsZone: "true" });
    expect(screen.queryByTestId("alerte-hors-zone")).toBeNull();
    expect(screen.getByTestId("plausibilite")).toHaveTextContent("4 élément(s) hors de la zone attendue, écartés sur votre confirmation explicite (jamais stockés).");
    expect(bouton("Continuer")).toBeEnabled();
  });

  it("changer de systeme apres une confirmation annule la confirmation (elle ne vaut que pour le systeme qui l'a motivee)", async () => {
    const u = utilisateur();
    rendre();
    await versCrsCsv(u);
    const sel = within(dialogue()).getByLabelText("Système de coordonnées source");
    await u.selectOptions(sel, "32629");
    piege("apercu", ERREUR(409, "CONFIRMATION_HORS_ZONE_REQUISE", { nbElementsHorsZone: 4, nbObjets: 10 }));
    await u.click(bouton("Vérifier la transformation"));
    await screen.findByTestId("alerte-hors-zone");
    await u.click(screen.getByRole("checkbox"));
    await u.click(bouton("Confirmer et recalculer l'aperçu"));
    await screen.findByTestId("bloc-crs");
    await u.selectOptions(sel, "32628");
    await u.click(bouton("Vérifier la transformation"));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(4));
    expect(champs(h.post.mock.calls[3][1])).toEqual(expect.not.objectContaining({ confirmerHorsZone: "true" }));
    expect(champs(h.post.mock.calls[3][1]).epsgSource).toBe("32628");
  });

  it.each([
    ["HORS_GUINEE", 422, /Vérifiez le système de coordonnées choisi et l'ordre des colonnes/],
    ["CRS_INCOHERENT", 422, /ne sont pas des degrés/],
    ["CRS_NON_AUTORISE", 422, /validée par le DSI/],
    ["CRS_NON_DISPONIBLE", 422, /ne le connaît pas/],
    ["CRS_INCOMPATIBLE_FORMAT", 422, /WGS 84 par la norme/],
    ["CRS_CONFLIT", 422, /ne se remplace pas/],
    ["TRANSFORMATION_ECHEC", 422, /transformation de coordonnées a échoué/],
  ])("%s a la verification : dit en clair avec son code, rien n'avance", async (code, status, motif) => {
    const u = utilisateur();
    rendre();
    await versCrsCsv(u);
    await u.selectOptions(within(dialogue()).getByLabelText("Système de coordonnées source"), "32629");
    piege("apercu", ERREUR(status as number, code as string));
    await u.click(bouton("Vérifier la transformation"));
    const alerte = await screen.findByText(new RegExp(`Code : ${code}`)).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent(motif as RegExp);
    expect(alerte).not.toHaveTextContent("texte brut");
    expect(bouton("Continuer")).toBeDisabled();
    expect(screen.queryByTestId("bloc-crs")).toBeNull();
  });
});

describe("etape 4 : correspondance des champs", () => {
  it("champs cibles de l'API ; exemples limites a trois ; la proposition du serveur est un bouton, rien n'est rempli d'office ; un changement force un nouvel apercu avec le mapping", async () => {
    const u = utilisateur();
    rendre();
    await versMapping(u);
    const nom = within(dialogue()).getByLabelText(/Nom de l'objet/);
    expect(nom).toHaveValue("");
    expect(within(nom).getAllByRole("option").map((o) => o.textContent)).toEqual(["Aucune correspondance", "Circuit", "Name", "Reseau"]);
    expect(dialogue()).toHaveTextContent("Type de réseau");
    expect(dialogue()).toHaveTextContent("Concessionnaire");
    await u.click(bouton("Utiliser la colonne proposée : Name"));
    expect(nom).toHaveValue("Name");
    expect(screen.getByTestId("exemples-nom")).toHaveTextContent("« Fibre FO-02 », « Fibre FO-01 »");
    expect(bouton("Contrôler le fichier")).toBeInTheDocument();
    s.apercu = apercu({ mapping: { applique: { nom: "Name" }, propositionsJeu: {}, avertissements: [] } });
    await u.click(bouton("Contrôler le fichier"));
    await etape("Contrôles et échantillon");
    expect(h.post).toHaveBeenCalledTimes(3);
    expect(champs(h.post.mock.calls[2][1])).toEqual({ couche: "c1", mapping: JSON.stringify({ nom: "Name" }) });
  });
  it("sans changement de mapping, l'apercu deja calcule est reutilise : aucun nouvel envoi du fichier", async () => {
    const u = utilisateur();
    rendre();
    await versControles(u);
    expect(h.post).toHaveBeenCalledTimes(2);
  });
  it("une valeur proposee au jeu par le mapping est annoncee comme telle", async () => {
    const u = utilisateur();
    rendre();
    await versMapping(u);
    await u.selectOptions(within(dialogue()).getByLabelText(/Type de réseau/), "Reseau");
    s.apercu = apercu({ mapping: { applique: { typeReseau: "Reseau" }, propositionsJeu: { typeReseau: { valeur: "TELECOM", colonne: "Reseau" } }, avertissements: [{ code: "MAPPING_VALEURS_MULTIPLES", message: "brut", nb: null }] } });
    await u.click(bouton("Contrôler le fichier"));
    await etape("Contrôles et échantillon");
    await u.click(bouton("Précédent"));
    await etape("Correspondance des champs");
    expect(screen.getByTestId("proposition-typeReseau")).toHaveTextContent("Valeur proposée au jeu : « TELECOM » (colonne « Reseau »), appliquée au dépôt seulement si le champ n'est pas déjà renseigné");
    expect(dialogue()).toHaveTextContent(/Un jeu a un seul concessionnaire/);
  });
  it("MAPPING_COLONNE_INTROUVABLE : dit en clair, avec le retour a l'etape de correction", async () => {
    const u = utilisateur();
    rendre();
    await versMapping(u);
    await u.selectOptions(within(dialogue()).getByLabelText(/Nom de l'objet/), "Name");
    piege("apercu", ERREUR(422, "MAPPING_COLONNE_INTROUVABLE"));
    await u.click(bouton("Contrôler le fichier"));
    const alerte = await screen.findByText(/Code : MAPPING_COLONNE_INTROUVABLE/).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent(/Correspondance des champs/);
    expect(within(alerte).queryByRole("button")).toBeNull();
  });
});

describe("etape 5 : controles, echantillon sur tableau ET carte", () => {
  it("statistiques, doublons, validation geometrique, elements ecartes, avertissements", async () => {
    const u = utilisateur();
    rendre();
    await versControles(u);
    const st = screen.getByTestId("statistiques");
    expect(st).toHaveTextContent("Objets du fichier3 (2 ligne(s), 1 point(s))");
    expect(st).toHaveTextContent("Longueur totale1,2 km");
    expect(st).toHaveTextContent("Sommets7");
    expect(screen.getByTestId("doublons")).toHaveTextContent("1 tracé(s) identique(s) répété(s) dans le fichier");
    const v = screen.getByTestId("validation-geometrique");
    expect(v).toHaveTextContent("1 géométrie(s) invalide(s) : la base les répare au dépôt");
    expect(within(v).getByRole("region", { name: "Géométries invalides" })).toHaveTextContent("Auto-intersection (sera réparée par la base au dépôt)");
    expect(within(v).getByRole("region", { name: "Éléments écartés du fichier" })).toHaveTextContent("Hors de la zone attendue (la Guinée)");
    expect(dialogue()).toHaveTextContent(/Altitude|altitude des points est ignorée/);
    expect(screen.getByTestId("bloc-crs")).toBeInTheDocument();
  });
  it("l'echantillon est borne : tableau (objets a probleme d'abord, noms et attributs en TEXTE) et carte qui ne montre que ces objets", async () => {
    const u = utilisateur();
    rendre();
    await versControles(u);
    const e = screen.getByTestId("echantillon");
    expect(e).toHaveTextContent("Échantillon : 3 objet(s) sur 3");
    expect(e).toHaveTextContent(/Le fichier entier n'est jamais affiché/);
    const tableau = within(e).getByRole("region", { name: "Échantillon d'objets du fichier" });
    const lignes = within(tableau).getAllByRole("row").slice(1);
    expect(lignes).toHaveLength(3);
    expect(lignes[0]).toHaveTextContent("Fibre FO-02");
    expect(lignes[0]).toHaveTextContent("Auto-intersection");
    expect(lignes[0]).toHaveTextContent("Circuit : C-2");
    expect(lignes[2]).toHaveTextContent("Objet sans nom");
    const carte = within(e).getByTestId("carte-echantillon");
    expect(await within(carte).findAllByTestId("objet-carte")).toHaveLength(3);
    expect(within(carte).getByTestId("tuiles").getAttribute("data-url")).toMatch(/openstreetmap/);
  });
  it("« Voir » met un objet en evidence sur la carte (aria-pressed, objet de surbrillance)", async () => {
    const u = utilisateur();
    rendre();
    await versControles(u);
    const e = screen.getByTestId("echantillon");
    const voir = within(e).getByRole("button", { name: "Voir sur la carte : Fibre FO-01, objet n° 1" });
    expect(voir).toHaveAttribute("aria-pressed", "false");
    await u.click(voir);
    expect(voir).toHaveAttribute("aria-pressed", "true");
    expect(within(e).getAllByTestId("couche-passive").length).toBeGreaterThan(0);
    await u.click(voir);
    expect(voir).toHaveAttribute("aria-pressed", "false");
  });
  it("aucun contenu de fichier n'est rendu en HTML : un nom d'objet piege reste du texte", async () => {
    const piegeNom = "<img src=x onerror=alert(1)>";
    s.apercu = apercu({ echantillon: { taille: 1, total: 1, objets: [{ ordre: 0, nom: piegeNom, typeGeom: "POINT", simplifiee: false, attributs: { [piegeNom]: piegeNom }, geometrie: { type: "Point", coordinates: [-10.1, 9.18] } }] } });
    const u = utilisateur();
    rendre();
    await versControles(u);
    expect(dialogue().querySelector("img")).toBeNull();
    expect(within(screen.getByTestId("echantillon")).getAllByText(piegeNom, { exact: false }).length).toBeGreaterThan(0);
  });
  it("un echantillon vide est dit, pas rendu comme un tableau vide", async () => {
    s.apercu = apercu({ echantillon: { taille: 0, total: 0, objets: [] } });
    const u = utilisateur();
    rendre();
    await versControles(u);
    expect(screen.getByTestId("echantillon")).toHaveTextContent("Aucun objet à afficher.");
  });
  it("lignes rejetees d'un tableau et elements ecartes : listes bornees avec leur raison en clair", async () => {
    const base = apercu();
    s.apercu = apercu({ resume: { ...base.resume, import: { ...base.resume.import, csv: { delimiteur: ";", encodage: "utf-8", separateurDecimal: ",", mode: "points", nbLignes: 20, nbLignesRejetees: 3 }, rejets: [{ ligne: 4, code: "COORDONNEES_ILLISIBLES", message: "x" }, { ligne: 9, code: "COORDONNEES_ABSENTES", message: "y" }], rejetsTronques: true } } });
    const u = utilisateur();
    rendre();
    await versControles(u);
    const v = screen.getByTestId("validation-geometrique");
    expect(v).toHaveTextContent("Lignes du tableau rejetées : 3 (les 2 premières sont listées).");
    expect(within(v).getByRole("region", { name: "Lignes rejetées du tableau" })).toHaveTextContent("Coordonnées illisibles");
  });
});

describe("etape 6 : comparaison avec la version autorisee, rien n'est ecrit avant le geste explicite", () => {
  it("la simulation envoie ?simuler=true, le meme fichier, les options et l'empreinte de l'apercu ; ni jeu ni ecriture", async () => {
    const u = utilisateur();
    rendre();
    await versDelta(u);
    const sim = appels(/\/jeux$/);
    expect(sim).toHaveLength(1);
    expect(sim[0][2].params).toEqual({ simuler: "true" });
    const corps = sim[0][1] as FormData;
    const entrees = [...corps.entries()];
    expect(entrees[entrees.length - 1][0]).toBe("fichier");
    expect(champs(corps)).toMatchObject({
      role: "RESEAU_TIERS", concessionnaireId: "c1", typeReseau: "TELECOM", natureObjets: "INCONNUE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE",
      couche: "c1", sha256Attendu: SHA,
    });
    // Classe de precision inconnue : le champ n'est PAS envoye (le serveur n'accepte que A a E ; defaut D1 du pilote local).
    expect(champs(corps)).not.toHaveProperty("classePrecision");
    expect(screen.getByTestId("simulation-seule")).toHaveTextContent("Simulation seulement : rien n'a été écrit");
    expect(dialogue()).toHaveTextContent("Version prévue3");
    expect(dialogue()).toHaveTextContent("la version 2 autorisée, une fois cette version autorisée à son tour");
    expect(appels(/\/jeux$/).filter((c) => !c[2].params)).toHaveLength(0);
  });
  it("delta : ajoutes, modifies, retires (a revoir), identiques ; les suppressions sont presentees comme A REVOIR, jamais appliquees", async () => {
    const u = utilisateur();
    rendre();
    await versDelta(u);
    expect(screen.getByTestId("delta-ajoutes")).toHaveTextContent("1");
    expect(screen.getByTestId("delta-modifies")).toHaveTextContent("1");
    expect(screen.getByTestId("delta-retires")).toHaveTextContent("1");
    expect(screen.getByTestId("delta-identiques")).toHaveTextContent("0");
    expect(dialogue()).toHaveTextContent("Retirés (à revoir)");
    const a = screen.getByTestId("suppressions-a-revoir");
    expect(a).toHaveTextContent("1 suppression(s) à revoir");
    expect(a).toHaveTextContent(/jamais supprimés d'office/);
    expect(a).toHaveTextContent(/revue humaine justifiée/);
  });
  it("premiere version : aucune comparaison, dit comme tel", async () => {
    s.simulation = reponseDepot({ remplace: null, delta: null, suppressions: null });
    const u = utilisateur();
    rendre();
    await versDelta(u);
    expect(dialogue()).toHaveTextContent("Première version de ce jeu : aucune version autorisée à comparer.");
    expect(screen.queryByTestId("delta")).toBeNull();
  });
  it("« Enregistrer en quarantaine » envoie le meme fichier SANS ?simuler ; le jeu naît en quarantaine ; les etapes precedentes sont gelees", async () => {
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    const reel = appels(/\/jeux$/).filter((c) => !c[2].params);
    expect(reel).toHaveLength(1);
    expect(((reel[0][1] as FormData).get("fichier") as File).name).toBe("reseau-synthetique.kml");
    expect(champs(reel[0][1])).toMatchObject({ sha256Attendu: SHA });
    expect(screen.getByTestId("depot-enregistre")).toHaveTextContent("Fichier enregistré en quarantaine, version 3");
    expect(screen.getByTestId("depot-enregistre")).toHaveTextContent(/ne peuvent plus être modifiées/);
    expect(h.get.mock.calls.map((c) => c[0])).toContain(`${BASE}/p1/jeux/jeu-nouveau/delta`);
    expect(screen.queryByRole("button", { name: "Précédent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enregistrer en quarantaine" })).toBeNull();
    expect(screen.getByTestId("delta-detail")).toHaveTextContent("Version 3 comparée à la version 2 (autorisée)");
    expect(screen.getByTestId("delta-detail")).toHaveTextContent("Regard 3");
    expect(screen.getByTestId("delta-detail")).toHaveTextContent("R1 : « Regard 1 » devient « Regard 1 (deplace) »");
    expect(screen.getByTestId("delta-detail")).toHaveTextContent("Regard 2");
  });
  it("revue des suppressions : justification de 10 caracteres, accepter ou refuser, auditee ; la derniere revue s'affiche", async () => {
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    const revue = screen.getByTestId("revue-suppressions");
    expect(revue).toHaveAttribute("data-statut", "A_REVOIR");
    const accepter = within(revue).getByRole("button", { name: "Accepter les suppressions" });
    const refuser = within(revue).getByRole("button", { name: "Refuser les suppressions" });
    expect(accepter).toBeDisabled(); expect(refuser).toBeDisabled();
    await u.type(within(revue).getByLabelText(/Justification de la revue/), "court");
    expect(accepter).toBeDisabled();
    await u.type(within(revue).getByLabelText(/Justification de la revue/), " et suffisante");
    expect(accepter).toBeEnabled();
    await u.click(accepter);
    await waitFor(() => expect(screen.getByTestId("revue-suppressions")).toHaveAttribute("data-statut", "ACCEPTEES"));
    const envoi = appels(/revue-suppressions$/);
    expect(envoi).toHaveLength(1);
    expect(envoi[0][0]).toBe(`${BASE}/p1/jeux/jeu-nouveau/revue-suppressions`);
    expect(envoi[0][1]).toEqual({ decision: "ACCEPTER", justification: "court et suffisante" });
    expect(screen.getByTestId("derniere-revue")).toHaveTextContent("Dernière revue : acceptée par Sekou Gestionnaire");
    expect(screen.getByTestId("derniere-revue")).toHaveTextContent("court et suffisante");
  });
  it("refuser les suppressions : decision REFUSER envoyee, statut « refusees »", async () => {
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    await u.type(within(screen.getByTestId("revue-suppressions")).getByLabelText(/Justification de la revue/), "Regard 2 existe toujours");
    await u.click(bouton("Refuser les suppressions"));
    await waitFor(() => expect(screen.getByTestId("revue-suppressions")).toHaveAttribute("data-statut", "REFUSEES"));
    expect(appels(/revue-suppressions$/)[0][1]).toMatchObject({ decision: "REFUSER" });
    // Defaut C1-02 (regle O1 du serveur) : apres un refus, accepter est impossible ; le bouton disparait, refuser de nouveau reste permis.
    const zone = within(screen.getByTestId("revue-suppressions"));
    expect(zone.queryByRole("button", { name: "Accepter les suppressions" })).toBeNull();
    expect(zone.getByRole("button", { name: "Refuser les suppressions" })).toBeInTheDocument();
    expect(screen.getByTestId("derniere-revue")).toHaveTextContent(/Ce refus est définitif/);
  });
  it("sans suppression : rien a revoir, pas de formulaire de revue", async () => {
    s.simulation = reponseDepot({ delta: { ajoutes: 2, modifies: 0, retires: 0, identiques: 3 }, suppressions: { statut: "AUCUNE", nb: 0 } });
    s.delta = DELTA_SANS_SUPPRESSION();
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    expect(screen.queryByTestId("revue-suppressions")).toBeNull();
    expect(screen.getByTestId("delta-detail")).toHaveTextContent("Aucune suppression : rien à revoir.");
  });
});

describe("etape 7 : approbation et retour arriere", () => {
  async function versApprobation(u: U) {
    await versDeltaDetaille(u);
    await u.click(bouton("Continuer vers l'approbation"));
    await etape("Approbation");
  }
  it("suppressions a revoir : l'autorisation est BLOQUEE avec la raison ; le rejet reste possible", async () => {
    const u = utilisateur();
    rendre();
    await versApprobation(u);
    expect(screen.getByTestId("blocage-suppressions")).toHaveTextContent(/acceptez ou refusez ces suppressions/);
    await u.type(screen.getByLabelText(/^Justification/), "Fichier non conforme au plan");
    expect(bouton("Autoriser ce jeu")).toBeDisabled();
    expect(bouton("Rejeter ce jeu")).toBeEnabled();
  });
  it("suppressions refusees : plus d'autorisation possible", async () => {
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    await u.type(within(screen.getByTestId("revue-suppressions")).getByLabelText(/Justification de la revue/), "Regard 2 existe toujours");
    await u.click(bouton("Refuser les suppressions"));
    await waitFor(() => expect(screen.getByTestId("revue-suppressions")).toHaveAttribute("data-statut", "REFUSEES"));
    await u.click(bouton("Continuer vers l'approbation"));
    await etape("Approbation");
    expect(screen.getByTestId("blocage-suppressions")).toHaveTextContent(/ne peut plus être autorisée/);
    expect(bouton("Autoriser ce jeu")).toBeDisabled();
  });
  it("revue acceptee puis autorisation avec justification : POST /autoriser, jeu autorise, alimente la carte", async () => {
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    await u.type(within(screen.getByTestId("revue-suppressions")).getByLabelText(/Justification de la revue/), "Regard 2 supprime sur le terrain");
    await u.click(bouton("Accepter les suppressions"));
    await waitFor(() => expect(screen.getByTestId("revue-suppressions")).toHaveAttribute("data-statut", "ACCEPTEES"));
    await u.click(bouton("Continuer vers l'approbation"));
    await etape("Approbation");
    expect(screen.queryByTestId("blocage-suppressions")).toBeNull();
    expect(bouton("Autoriser ce jeu")).toBeDisabled();
    await u.type(screen.getByLabelText(/^Justification/), "Autorise apres revue");
    await u.click(bouton("Autoriser ce jeu"));
    await screen.findByTestId("issue-autorise");
    expect(appels(/autoriser$/)[0]).toEqual([`${BASE}/p1/jeux/jeu-nouveau/autoriser`, { justification: "Autorise apres revue" }]);
    expect(screen.getByTestId("statut-jeu")).toHaveTextContent("Autorisé");
    expect(screen.getByTestId("retour-arriere")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminer" })).toBeInTheDocument();
  });
  it("rejet : POST /rejeter, jeu rejete, conserve", async () => {
    const u = utilisateur();
    rendre();
    await versApprobation(u);
    await u.type(screen.getByLabelText(/^Justification/), "Fichier non conforme au plan");
    await u.click(bouton("Rejeter ce jeu"));
    await screen.findByTestId("issue-rejete");
    expect(appels(/rejeter$/)[0][1]).toEqual({ justification: "Fichier non conforme au plan" });
    expect(screen.getByTestId("issue-rejete")).toHaveTextContent(/reste conservé avec sa justification/);
  });
  it("retour arriere : justification ET confirmation explicite, puis la version precedente redevient autorisee sans perte", async () => {
    s.delta = DELTA_SANS_SUPPRESSION();
    s.simulation = reponseDepot({ delta: { ajoutes: 2, modifies: 0, retires: 0, identiques: 3 }, suppressions: { statut: "AUCUNE", nb: 0 } });
    const u = utilisateur();
    rendre();
    await versApprobation(u);
    await u.type(screen.getByLabelText(/^Justification \(/), "Autorisation de la version");
    await u.click(bouton("Autoriser ce jeu"));
    await screen.findByTestId("retour-arriere");
    s.delta = DELTA_AUTORISE_AVEC_RETOUR();
    const panneau = screen.getByTestId("retour-arriere");
    const revenir = within(panneau).getByRole("button", { name: "Remettre la version précédente en service" });
    expect(revenir).toBeDisabled();
    await u.type(within(panneau).getByLabelText(/Justification du retour arrière/), "Version 3 erronee : retour");
    expect(revenir).toBeDisabled();
    await u.click(within(panneau).getByRole("checkbox", { name: /Je confirme le retour à la version 2/ }));
    expect(revenir).toBeEnabled();
    expect(panneau).toHaveTextContent(/Aucun jeu, objet ni décision n'est supprimé/);
    await u.click(revenir);
    await screen.findByTestId("issue-retour");
    expect(appels(/retour-arriere$/)[0]).toEqual([`${BASE}/p1/jeux/jeu-nouveau/retour-arriere`, { justification: "Version 3 erronee : retour" }]);
    expect(screen.getByTestId("issue-retour")).toHaveTextContent("La version 2 est de nouveau autorisée");
    expect(screen.queryByTestId("retour-arriere")).toBeNull();
  });
  it("retour arriere impossible : la raison est dite en clair", async () => {
    s.delta = deltaDetail({ jeu: { id: "jeu-nouveau", version: 1, statut: "AUTORISE", role: "RESEAU_TIERS" }, comparaison: null, delta: null, suppressions: { statut: "AUCUNE", nb: 0, revue: null }, retourArriere: { possible: false, raison: "AUCUNE_VERSION_PRECEDENTE", restaureraJeuId: null, restaureraVersion: null } });
    rendre({ jeuReprise: { id: "jeu-nouveau", version: 1 } });
    await etape("Comparaison avec la version autorisée");
    await screen.findByTestId("delta-detail");
    await userEvent.click(bouton("Continuer vers l'approbation"));
    expect(await screen.findByTestId("retour-impossible")).toHaveTextContent("ce jeu ne remplaçait aucune version");
  });
});

describe("reprise sur un jeu deja depose", () => {
  it("ouvre sur la comparaison, deux etapes seulement, charge le delta du jeu ; pas de « Precedent » en premiere etape ; revue possible", async () => {
    rendre({ jeuReprise: { id: "jeu-q", version: 3 } });
    await etape("Comparaison avec la version autorisée");
    await screen.findByTestId("delta-detail");
    expect(h.get.mock.calls.map((c) => c[0])).toContain(`${BASE}/p1/jeux/jeu-q/delta`);
    expect(h.get.mock.calls.map((c) => c[0])).not.toContain(`${BASE}/p1/import/options`);
    expect(screen.getByTestId("etape-texte")).toHaveTextContent("Étape 1 sur 2");
    expect(screen.queryByRole("button", { name: "Précédent" })).toBeNull();
    expect(screen.getByTestId("revue-suppressions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enregistrer en quarantaine" })).toBeNull();
    await userEvent.click(bouton("Continuer vers l'approbation"));
    await etape("Approbation");
    expect(screen.getByRole("button", { name: "Précédent" })).toBeEnabled();
    expect(champFichier()).toBeNull();
  });
  it("404 JEU_INTROUVABLE a la lecture du delta : dit en clair, nouvel essai propose", async () => {
    piege("delta", ERREUR(404, "JEU_INTROUVABLE"));
    rendre({ jeuReprise: { id: "jeu-q", version: 3 } });
    expect(await screen.findByText(/Code : JEU_INTROUVABLE/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Charger la comparaison" })).toBeInTheDocument();
  });
});

describe("erreurs typees de l'API, dites en clair a l'endroit ou elles arrivent", () => {
  it("409 JEU_DEJA_CHARGE a la simulation : « Ce fichier est deja charge », meme avec un autre CRS, lien vers le jeu existant", async () => {
    const onVoirJeu = vi.fn();
    const u = utilisateur();
    rendre({ onVoirJeu });
    await versControles(u);
    piege("simulation", ERREUR(409, "JEU_DEJA_CHARGE", { jeuId: "jeu-existant" }));
    await u.click(bouton("Simuler l'enregistrement"));
    const alerte = await screen.findByText(/Code : JEU_DEJA_CHARGE/).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent("Ce fichier est déjà chargé.");
    expect(alerte).toHaveTextContent(/même fichier avec un autre système de coordonnées est refusé/);
    await u.click(within(alerte).getByRole("button", { name: "Voir le jeu existant" }));
    expect(onVoirJeu).toHaveBeenCalledWith("jeu-existant");
    expect(screen.getByRole("heading", { name: "Contrôles et échantillon" })).toBeInTheDocument();
  });
  it("409 sans jeuId : pas de lien invente", async () => {
    const u = utilisateur();
    rendre();
    await versControles(u);
    piege("simulation", ERREUR(409, "JEU_DEJA_CHARGE"));
    await u.click(bouton("Simuler l'enregistrement"));
    const alerte = await screen.findByText(/Code : JEU_DEJA_CHARGE/).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(within(alerte).queryByRole("button")).toBeNull();
  });
  it("409 DEPOT_EN_ATTENTE : un autre depot attend, avec le lien vers lui", async () => {
    const onVoirJeu = vi.fn();
    const u = utilisateur();
    rendre({ onVoirJeu });
    await versControles(u);
    piege("simulation", ERREUR(409, "DEPOT_EN_ATTENTE", { jeuId: "jeu-attente" }));
    await u.click(bouton("Simuler l'enregistrement"));
    const alerte = await screen.findByText(/Code : DEPOT_EN_ATTENTE/).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent(/attend déjà son autorisation/);
    await u.click(within(alerte).getByRole("button", { name: "Voir le jeu existant" }));
    expect(onVoirJeu).toHaveBeenCalledWith("jeu-attente");
  });
  it("409 EMPREINTE_DIVERGENTE a la simulation", async () => {
    const u = utilisateur();
    rendre();
    await versControles(u);
    piege("simulation", ERREUR(409, "EMPREINTE_DIVERGENTE", { sha256: "c".repeat(64) }));
    await u.click(bouton("Simuler l'enregistrement"));
    expect(await screen.findByText(/empreinte SHA-256 différente/)).toBeInTheDocument();
  });
  it("400 CONCESSIONNAIRE_REQUIS a la simulation : bouton de retour a l'etape du depot", async () => {
    const u = utilisateur();
    rendre();
    await versControles(u);
    piege("simulation", ERREUR(400, "CONCESSIONNAIRE_REQUIS"));
    await u.click(bouton("Simuler l'enregistrement"));
    const alerte = await screen.findByText(/Code : CONCESSIONNAIRE_REQUIS/).then((e) => e.closest("[role=alert]") as HTMLElement);
    await u.click(within(alerte).getByRole("button", { name: /Corriger à l'étape « Dépôt du fichier »/ }));
    await etape("Dépôt du fichier");
    expect(screen.queryByText(/Code : CONCESSIONNAIRE_REQUIS/)).toBeNull();
  });
  it("422 SEPARATEUR_DECIMAL_AMBIGU a l'apercu : bouton de retour aux options de lecture du tableau", async () => {
    s.inventaire = inventaireCsv();
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["a;b"], "plan.csv"));
    await analyser(u);
    await u.click(screen.getByRole("radio", { name: /Points : une colonne X/ }));
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne X"), "x");
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne Y"), "y");
    await u.click(bouton("Continuer"));
    await etape("Système de coordonnées");
    await u.selectOptions(within(dialogue()).getByLabelText("Système de coordonnées source"), "32629");
    piege("apercu", ERREUR(422, "SEPARATEUR_DECIMAL_AMBIGU"));
    await u.click(bouton("Vérifier la transformation"));
    const alerte = await screen.findByText(/Code : SEPARATEUR_DECIMAL_AMBIGU/).then((e) => e.closest("[role=alert]") as HTMLElement);
    await u.click(within(alerte).getByRole("button", { name: /Corriger à l'étape « Format et couches »/ }));
    await etape("Format et couches");
    expect(within(dialogue()).getByLabelText("Séparateur décimal")).toBeInTheDocument();
  });
  it.each([
    [422, "ENCODAGE_AMBIGU", /Choisissez l'encodage/],
    [422, "DELIMITEUR_AMBIGU", /choisissez le délimiteur/],
  ])("CSV : %i %s a l'inventaire : l'assistant ouvre les options de lecture, l'utilisateur declare puis relance la detection", async (status, code, motif) => {
    const csv = inventaireCsv();
    piege("inventaire", ERREUR(status as number, code as string));
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["x"], "plan.csv"));
    await u.click(bouton("Analyser le fichier"));
    await etape("Format et couches");
    const alerte = await screen.findByText(new RegExp(`Code : ${code}`)).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent(motif as RegExp);
    expect(screen.getByTestId("lecture-tableau")).toBeInTheDocument();
    expect(bouton("Continuer")).toBeDisabled();
    s.inventaire = csv;
    await u.selectOptions(within(dialogue()).getByLabelText("Encodage"), "windows-1252");
    await u.selectOptions(within(dialogue()).getByLabelText("Délimiteur"), ";");
    await u.click(bouton("Relancer la détection avec ces options"));
    await screen.findByText(/Colonnes et exemples/);
    expect(champs(h.post.mock.calls[1][1])).toEqual({ delimiteur: ";", encodage: "windows-1252" });
    expect(screen.queryByText(new RegExp(`Code : ${code}`))).toBeNull();
  });
  it("CSV : changer une option de lecture rend l'inventaire perime, « Continuer » reste inactif jusqu'a la relance", async () => {
    s.inventaire = inventaireCsv();
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["x"], "plan.csv"));
    await analyser(u);
    await u.click(screen.getByRole("radio", { name: /Points : une colonne X/ }));
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne X"), "x");
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne Y"), "y");
    expect(bouton("Continuer")).toBeEnabled();
    expect(screen.getByTestId("csv-detecte")).toHaveTextContent("délimiteur point-virgule");
    await u.selectOptions(within(dialogue()).getByLabelText("Délimiteur"), "|");
    expect(screen.getByTestId("inventaire-perime")).toBeInTheDocument();
    expect(bouton("Continuer")).toBeDisabled();
    await u.click(bouton("Relancer la détection avec ces options"));
    await waitFor(() => expect(screen.queryByTestId("inventaire-perime")).toBeNull());
    expect(h.post).toHaveBeenCalledTimes(2);
  });
  it.each([
    [413, "FICHIER_TROP_GROS", /25 Mo/],
    [422, "CONTENU_NON_RECONNU", /n'a pas été exécuté ni interprété comme une page/],
    [422, "ARCHIVE_CHEMIN_DANGEREUX", /chemin dangereux/],
    [422, "ARCHIVE_TROP_GROSSE", /dépasse la taille autorisée/],
    [422, "KMZ_SANS_KML", /aucun fichier KML/],
    [422, "GPX_INVALIDE", /GPX est invalide/],
    [422, "CSV_STRUCTURE_INVALIDE", /structure du tableau est invalide/],
    [422, "FICHIER_VIDE", /vide/],
    [422, "TROP_D_OBJETS", /50 000 objets/],
  ])("%i %s a l'inventaire : dit en clair, l'assistant reste a l'etape du depot", async (status, code, motif) => {
    piege("inventaire", ERREUR(status as number, code as string));
    const u = utilisateur();
    rendre();
    await deposer(u);
    await u.click(bouton("Analyser le fichier"));
    const alerte = await screen.findByText(new RegExp(`Code : ${code}`)).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent(motif as RegExp);
    expect(alerte).not.toHaveTextContent("texte brut");
    expect(screen.getByRole("heading", { name: "Dépôt du fichier" })).toBeInTheDocument();
    expect(bouton("Analyser le fichier")).toBeEnabled();
  });
  it.each([
    [503, "SERVICE_OCCUPE", /Réessayez/],
    [504, "APERCU_TROP_LONG", /délai autorisé/],
    [403, "ROLE_INSUFFISANT", /Votre rôle ne permet pas cette action/],
  ])("%i %s a l'apercu : dit en clair, nouvel essai possible", async (status, code, motif) => {
    const u = utilisateur();
    rendre();
    await versCrs(u);
    piege("apercu", ERREUR(status as number, code as string));
    await u.click(bouton("Vérifier la transformation"));
    expect(await screen.findByText(motif as RegExp)).toBeInTheDocument();
    expect(bouton("Vérifier la transformation")).toBeEnabled();
  });
  it("504 DEPOT_TROP_LONG a l'enregistrement : rien n'a ete enregistre, on peut reessayer", async () => {
    const u = utilisateur();
    rendre();
    await versDelta(u);
    piege("depot", ERREUR(504, "DEPOT_TROP_LONG"));
    await u.click(bouton("Enregistrer en quarantaine"));
    expect(await screen.findByText(/rien n'a été enregistré/)).toBeInTheDocument();
    expect(bouton("Enregistrer en quarantaine")).toBeEnabled();
    expect(screen.queryByTestId("depot-enregistre")).toBeNull();
  });
  it("429 avec delai : message avec le delai, boutons inactifs le temps dit, puis reactives", async () => {
    const u = utilisateur();
    rendre();
    await versCrs(u);
    piege("apercu", ERREUR(429, "TROP_DE_REQUETES", {}, { "retry-after": "1" }));
    await u.click(bouton("Vérifier la transformation"));
    const alerte = await screen.findByText(/Code : TROP_DE_REQUETES/).then((e) => e.closest("[role=alert]") as HTMLElement);
    expect(alerte).toHaveTextContent("Nouvel essai possible dans 1 s.");
    expect(screen.getByTestId("attente")).toHaveTextContent("Nouvel essai possible dans 1 s.");
    expect(bouton("Vérifier la transformation")).toBeDisabled();
    await waitFor(() => expect(bouton("Vérifier la transformation")).toBeEnabled(), { timeout: 4000 });
    expect(screen.queryByTestId("attente")).toBeNull();
  });
  it("409 SUPPRESSIONS_A_REVOIR a l'autorisation (etat change entre-temps) : dit en clair, le delta est relu", async () => {
    s.delta = DELTA_SANS_SUPPRESSION();
    s.simulation = reponseDepot({ delta: { ajoutes: 2, modifies: 0, retires: 0, identiques: 3 }, suppressions: { statut: "AUCUNE", nb: 0 } });
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    await u.click(bouton("Continuer vers l'approbation"));
    await etape("Approbation");
    await u.type(screen.getByLabelText(/^Justification \(/), "Autorisation de la version");
    piege("autoriser", ERREUR(409, "SUPPRESSIONS_A_REVOIR", { jeuId: "jeu-nouveau", nb: 2 }));
    s.delta = deltaDetail();
    const avant = h.get.mock.calls.filter((c) => /delta$/.test(c[0])).length;
    await u.click(bouton("Autoriser ce jeu"));
    expect(await screen.findByText(/revue humaine justifiée des suppressions est exigée/)).toBeInTheDocument();
    await waitFor(() => expect(h.get.mock.calls.filter((c) => /delta$/.test(c[0])).length).toBe(avant + 1));
    await waitFor(() => expect(screen.getByTestId("blocage-suppressions")).toBeInTheDocument());
  });
  it("409 SUPPRESSIONS_REFUSEES et STATUT_INCOMPATIBLE a l'autorisation", async () => {
    s.delta = DELTA_SANS_SUPPRESSION();
    s.simulation = reponseDepot({ delta: { ajoutes: 2, modifies: 0, retires: 0, identiques: 3 }, suppressions: { statut: "AUCUNE", nb: 0 } });
    const u = utilisateur();
    rendre();
    await versDeltaDetaille(u);
    await u.click(bouton("Continuer vers l'approbation"));
    await etape("Approbation");
    await u.type(screen.getByLabelText(/^Justification \(/), "Autorisation de la version");
    piege("autoriser", ERREUR(409, "SUPPRESSIONS_REFUSEES", { jeuId: "jeu-nouveau", nb: 1 }));
    await u.click(bouton("Autoriser ce jeu"));
    expect(await screen.findByText(/refusées à la revue/)).toBeInTheDocument();
    piege("autoriser", ERREUR(409, "STATUT_INCOMPATIBLE", { statut: "AUTORISE" }));
    await u.click(bouton("Autoriser ce jeu"));
    expect(await screen.findByText(/n'est plus dans un état qui permet cette action/)).toBeInTheDocument();
  });
  it("409 VERSION_PRECEDENTE_INDISPONIBLE et DEPOT_EN_ATTENTE au retour arriere", async () => {
    s.delta = DELTA_AUTORISE_AVEC_RETOUR();
    rendre({ jeuReprise: { id: "jeu-nouveau", version: 3 } });
    await screen.findByTestId("delta-detail");
    const u = utilisateur();
    await u.click(bouton("Continuer vers l'approbation"));
    const panneau = await screen.findByTestId("retour-arriere");
    await u.type(within(panneau).getByLabelText(/Justification du retour arrière/), "Version 3 erronee : retour");
    await u.click(within(panneau).getByRole("checkbox"));
    piege("retour", ERREUR(409, "VERSION_PRECEDENTE_INDISPONIBLE"));
    await u.click(within(panneau).getByRole("button", { name: "Remettre la version précédente en service" }));
    expect(await screen.findByText(/le retour arrière est impossible/)).toBeInTheDocument();
    piege("retour", ERREUR(409, "DEPOT_EN_ATTENTE", { jeuId: "jeu-attente" }));
    await u.click(within(panneau).getByRole("button", { name: "Remettre la version précédente en service" }));
    expect(await screen.findByText(/attend déjà son autorisation/)).toBeInTheDocument();
    expect(within(screen.getByTestId("retour-arriere")).getByLabelText(/Justification du retour arrière/)).toHaveValue("Version 3 erronee : retour");
  });
  it("une erreur de reseau est dite comme telle", async () => {
    piege("apercu", new Error("Network Error"));
    const u = utilisateur();
    rendre();
    await versCrs(u);
    await u.click(bouton("Vérifier la transformation"));
    expect(await screen.findByText(/Le serveur est injoignable/)).toBeInTheDocument();
  });
  it("une reponse inattendue du serveur n'est pas rendue comme un vide", async () => {
    s.apercu = { nimporte: "quoi" };
    const u = utilisateur();
    rendre();
    await versCrs(u);
    await u.click(bouton("Vérifier la transformation"));
    expect(await screen.findByText(/Réponse inattendue du serveur/)).toBeInTheDocument();
    expect(screen.queryByTestId("bloc-crs")).toBeNull();
  });
});

describe("fichiers volumineux : progression, annulation, pas de double envoi", () => {
  const attendre = (cle: string, progression?: [number, number]) => {
    s.surPost[cle] = (_c, cfg) => new Promise((_ok, ko) => {
      if (progression) cfg.onUploadProgress?.({ loaded: progression[0], total: progression[1] });
      cfg.signal?.addEventListener("abort", () => ko(Object.assign(new Error("canceled"), { code: "ERR_CANCELED", name: "CanceledError" })));
    });
  };
  it("la progression de l'envoi s'affiche ; a 100 %, le serveur est dit au travail", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u);
    s.surPost.inventaire = async (_c, cfg) => { cfg.onUploadProgress?.({ loaded: 50, total: 100 }); return await new Promise(() => { /* en cours */ }); };
    await u.click(bouton("Analyser le fichier"));
    expect(await screen.findByText(/Envoi du fichier… 50 %/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Avancement de l'envoi du fichier" })).toHaveAttribute("value", "50");
  });
  it("a 100 % envoye : « lecture et controles en cours »", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u);
    s.surPost.inventaire = async (_c, cfg) => { cfg.onUploadProgress?.({ loaded: 100, total: 100 }); return await new Promise(() => { /* en cours */ }); };
    await u.click(bouton("Analyser le fichier"));
    expect(await screen.findByText(/Fichier reçu par le serveur : lecture et contrôles en cours/)).toBeInTheDocument();
  });
  it("annuler l'envoi : le signal est avorte, aucune erreur n'est affichee, l'assistant reste utilisable", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u);
    let signal: AbortSignal | undefined;
    attendre("inventaire", [20, 100]);
    const fn = s.surPost.inventaire;
    s.surPost.inventaire = (c, cfg) => { signal = cfg.signal; return fn(c, cfg); };
    await u.click(bouton("Analyser le fichier"));
    await u.click(await screen.findByRole("button", { name: "Annuler l'envoi" }));
    await waitFor(() => expect(bouton("Analyser le fichier")).toBeEnabled());
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/injoignable/)).toBeNull();
    delete s.surPost.inventaire;
    await analyser(u);
  });
  it("pas de double envoi : un double clic rapide n'envoie qu'une requete", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u);
    attendre("inventaire");
    await u.dblClick(bouton("Analyser le fichier"));
    expect(appels(/inventaire$/)).toHaveLength(1);
    expect(bouton("En cours…")).toBeDisabled();
  });
  it("annuler le DEPOT : message honnete (le serveur a pu l'enregistrer), idempotence par empreinte rappelee", async () => {
    const u = utilisateur();
    rendre();
    await versDelta(u);
    attendre("depot", [30, 100]);
    await u.click(bouton("Enregistrer en quarantaine"));
    await u.click(await screen.findByRole("button", { name: "Annuler l'envoi" }));
    const info = await screen.findByTestId("info-assistant");
    expect(info).toHaveTextContent(/Le serveur a pu enregistrer le fichier avant l'interruption/);
    expect(info).toHaveTextContent(/Le même fichier ne sera pas chargé deux fois/);
    expect(screen.queryByTestId("depot-enregistre")).toBeNull();
  });
  it("Echap pendant un envoi l'annule au lieu de fermer ; Echap au repos ferme", async () => {
    const u = utilisateur();
    const { onFermer } = rendre();
    await deposer(u);
    attendre("inventaire", [5, 100]);
    await u.click(bouton("Analyser le fichier"));
    await screen.findByRole("button", { name: "Annuler l'envoi" });
    await u.keyboard("{Escape}");
    await waitFor(() => expect(bouton("Analyser le fichier")).toBeEnabled());
    expect(onFermer).not.toHaveBeenCalled();
    await u.keyboard("{Escape}");
    expect(onFermer).toHaveBeenCalled();
  });
});

describe("navigation, etat en memoire, clavier et focus", () => {
  it("le titre de chaque etape prend le focus ; un seul element porte aria-current=step ; l'etat est conserve en revenant en arriere", async () => {
    const u = utilisateur();
    rendre();
    await versCrs(u);
    expect(screen.getByRole("heading", { name: "Système de coordonnées" })).toHaveFocus();
    expect(dialogue().querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(dialogue().querySelector('[aria-current="step"]')).toHaveTextContent("Système de coordonnées");
    await u.click(bouton("Précédent"));
    await etape("Format et couches");
    expect(screen.getByRole("heading", { name: "Format et couches" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: /Fibre \/ Chambres/ })).toBeChecked();
    await u.click(bouton("Précédent"));
    await etape("Dépôt du fichier");
    expect(screen.getByText(/reseau-synthetique\.kml \(/)).toBeInTheDocument();
    expect(within(dialogue()).getByLabelText("Concessionnaire propriétaire du réseau")).toHaveValue("c1");
    expect(screen.queryByRole("button", { name: "Précédent" })).toBeNull();
  });
  it("tout se fait au clavier : Tab, Espace et Entree conduisent de l'etape 1 a l'etape 3", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u);
    bouton("Analyser le fichier").focus();
    await u.keyboard("{Enter}");
    await etape("Format et couches");
    screen.getByRole("radio", { name: /Fibre \/ Principal/ }).focus();
    await u.keyboard(" ");
    expect(screen.getByRole("radio", { name: /Fibre \/ Principal/ })).toBeChecked();
    bouton("Continuer").focus();
    await u.keyboard("{Enter}");
    await etape("Système de coordonnées");
  });
  it("rien n'est conserve cote navigateur : le fichier n'est ni lu ni copie (aucun FileReader), aucun stockage", async () => {
    const lire = vi.spyOn(FileReader.prototype, "readAsText");
    const lireBin = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
    const set = vi.spyOn(Storage.prototype, "setItem");
    const u = utilisateur();
    rendre();
    await versControles(u);
    expect(lire).not.toHaveBeenCalled(); expect(lireBin).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("accessibilite (axe-core) : zero violation a chaque etape", () => {
  const axe = async () => (await import("../../../test/accessibilite")).violationsAccessibilite(document.body);

  it("parcours KML : depot (avec « nouveau concessionnaire »), format, CRS, correspondance, controles, simulation, delta detaille, approbation", async () => {
    const u = utilisateur();
    rendre();
    await deposer(u);
    expect(await axe()).toEqual([]);
    await u.click(bouton(/le créer/));
    expect(await axe()).toEqual([]);
    await u.click(bouton("Annuler la création"));
    await analyser(u);
    expect(await axe()).toEqual([]);
    await u.click(screen.getByRole("radio", { name: /Fibre \/ Chambres/ }));
    await u.click(bouton("Continuer"));
    await etape("Système de coordonnées");
    expect(await axe()).toEqual([]);
    await verifierCrs(u);
    expect(await axe()).toEqual([]);
    await u.click(bouton("Continuer"));
    await etape("Correspondance des champs");
    await u.selectOptions(within(dialogue()).getByLabelText(/Nom de l'objet/), "Name");
    expect(await axe()).toEqual([]);
    await u.click(bouton("Contrôler le fichier"));
    await etape("Contrôles et échantillon");
    await screen.findAllByTestId("objet-carte");
    expect(await axe()).toEqual([]);
    await u.click(bouton("Simuler l'enregistrement"));
    await etape("Comparaison avec la version autorisée");
    expect(await axe()).toEqual([]);
    await u.click(bouton("Enregistrer en quarantaine"));
    await screen.findByTestId("delta-detail");
    expect(await axe()).toEqual([]);
    await u.click(bouton("Continuer vers l'approbation"));
    await etape("Approbation");
    expect(await axe()).toEqual([]);
  }, 120_000);

  it("parcours CSV : options de lecture, choix du CRS, avertissement hors zone, erreur typee, KMZ a choisir", async () => {
    s.inventaire = inventaireCsv();
    const u = utilisateur();
    rendre();
    await deposer(u, new File(["a;b"], "plan.csv"));
    await analyser(u);
    expect(await axe()).toEqual([]);
    await u.click(screen.getByRole("radio", { name: /Points : une colonne X/ }));
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne X"), "x");
    await u.selectOptions(within(dialogue()).getByLabelText("Colonne Y"), "y");
    await u.click(bouton("Continuer"));
    await etape("Système de coordonnées");
    expect(await axe()).toEqual([]);
    await u.selectOptions(within(dialogue()).getByLabelText("Système de coordonnées source"), "32629");
    piege("apercu", ERREUR(409, "CONFIRMATION_HORS_ZONE_REQUISE", { nbElementsHorsZone: 4, nbObjets: 10 }));
    await u.click(bouton("Vérifier la transformation"));
    await screen.findByTestId("alerte-hors-zone");
    expect(await axe()).toEqual([]);
    piege("apercu", ERREUR(422, "CRS_INCOHERENT"));
    await u.click(screen.getByRole("checkbox"));
    await u.click(bouton("Confirmer et recalculer l'aperçu"));
    await screen.findByText(/Code : CRS_INCOHERENT/);
    expect(await axe()).toEqual([]);
  }, 120_000);

  it("KMZ a plusieurs KML, reprise sur un jeu autorise avec retour arriere possible, erreurs de depot", async () => {
    s.inventaire = inventaireKmz();
    const u = utilisateur();
    const a = rendre();
    await deposer(u, new File(["PK"], "archive.kmz"));
    await analyser(u);
    expect(await axe()).toEqual([]);
    a.unmount();
    s.delta = DELTA_AUTORISE_AVEC_RETOUR();
    rendre({ jeuReprise: { id: "jeu-nouveau", version: 3 } });
    await screen.findByTestId("delta-detail");
    expect(await axe()).toEqual([]);
    await userEvent.click(bouton("Continuer vers l'approbation"));
    await screen.findByTestId("retour-arriere");
    expect(await axe()).toEqual([]);
  }, 120_000);
});
