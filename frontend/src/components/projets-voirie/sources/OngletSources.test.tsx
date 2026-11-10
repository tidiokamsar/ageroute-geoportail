import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

import { OngletSources } from "./OngletSources";
import { violationsAccessibilite } from "../../../test/accessibilite";

/**
 * Onglet « Sources » (lot S1, interface UI-C). Donnees 100 % SYNTHETIQUES. On verifie : la source unique est un etat NORMAL (jamais une
 * erreur) ; la comparaison et ses resultats par statut ; la mesure d'une divergence et l'absence de toute distance pour un rapprochement incertain ;
 * l'objet B masque ; la pagination par curseur ; l'ouverture d'un dossier par action humaine justifiee ; les regles (auteur, autre ADMIN) ; les
 * roles (un lecteur ne voit aucun bouton d'ecriture) ; les erreurs typees ; l'absence de toute proposition de fusion.
 */

configure({ asyncUtilTimeout: 8000 });
const B = "/v2/projets-voirie/p1";

const source = (jeuId: string, over: Record<string, unknown> = {}) => ({
  jeuId, role: "RESEAU_TIERS", version: 1, methodeAcquisition: "GNSS", dateDonnees: "2026-10-01", dateDepot: "2026-10-02T08:00:00Z", nomFichier: `${jeuId}.geojson`,
  classePrecision: null, precisionHorizontaleM: 1, nbObjets: 4, confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", ...over,
});
const UNIQUE = { role: "RESEAU_TIERS", concessionnaire: { id: "c1", nom: "Operateur A" }, typeReseau: "TELECOM", statut: "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", nbSources: 1, sources: [source("j1")], derniereComparaison: null, mention: "Une seule source." };
const COMPARABLE = {
  role: "RESEAU_TIERS", concessionnaire: { id: "c2", nom: "Societe B" }, typeReseau: "EAU_POTABLE", typeReseauCode: "EAU_BRUTE", statut: "COMPARABLE", nbSources: 2,
  sources: [source("j2", { methodeAcquisition: "NUMERISATION_PLAN" }), source("j3", { methodeAcquisition: "ANCIENNE", precisionHorizontaleM: null, classePrecision: "C" })],
  derniereComparaison: null, versionsCandidates: [], mention: null,
};
const COMPARAISON = {
  id: "cmp1", numero: 4, statut: "TERMINEE", mode: "SOURCES", role: "RESEAU_TIERS", jeuAId: "j2", jeuBId: "j3",
  // Comparaison calculee AVANT les correctifs serveur avec la regle SYSTEME S1-CORRIDOR-0.1 (bareme provisoire, jamais approuve) : aucun champ d'attestation.
  regle: { regleId: "r0", code: "S1-CORRIDOR-0.1", version: 0, margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 0, precisionParClasseM: { A: 0.5, B: 1, C: 2, D: 5 } },
  versionAlgorithme: "S1-CORRIDOR-UTM-1", epsg: 32629,
  jeux: [{ role: "A", jeuId: "j2", nomFichier: "j2.geojson", version: 1, methodeAcquisition: "NUMERISATION_PLAN", dateDonnees: "2026-10-01" }, { role: "B", jeuId: "j3", nomFichier: "j3.geojson", version: 1, methodeAcquisition: "ANCIENNE" }],
  donneesMasquees: false, declenchePar: { id: "u2", nomComplet: "Gestionnaire Test" }, duree: 120, createdAt: "2026-11-09T09:00:00Z", limites: [],
  resume: { totaux: { CONCORDANCE: 1, DIVERGENCE: 1, RAPPROCHEMENT_INCERTAIN: 1, SANS_CORRESPONDANCE_A: 0, SANS_CORRESPONDANCE_B: 1 }, corridor: { minM: 2, maxM: 2, couplesSansCorridor: 1 } },
};
const o = (id: string, nom: string, precisionM: number | null, originePrecision: string) => ({ id, nom, precisionM, originePrecision });
const RESULTATS_P1 = [
  { id: "res1", ordre: 1, statut: "CONCORDANCE", objetA: o("1", "Conduite 1", 1, "OBJET"), objetB: o("11", "Conduite 1 bis", 1, "JEU"), corridorM: 2, mesure: { hausdorffM: 0.5, longueurHorsCorridorM: 0, longueurAM: 100, partHorsCorridor: 0 }, conflitId: null },
  { id: "res2", ordre: 2, statut: "DIVERGENCE", objetA: o("2", "Conduite 2", 1, "OBJET"), objetB: o("12", "Conduite 2 bis", 2, "CLASSE"), corridorM: 3, mesure: { hausdorffM: 3.2, longueurHorsCorridorM: 40, longueurAM: 100, partHorsCorridor: 0.4 }, conflitId: null },
];
const RESULTATS_P2 = [
  // Revue m12 : un incertain dont le serveur rendrait (a tort) une mesure et un corridor : ni l'une ni l'autre ne doivent s'afficher.
  { id: "res3", ordre: 3, statut: "RAPPROCHEMENT_INCERTAIN", objetA: o("3", "Conduite 3", null, "INCONNUE"), objetB: o("13", "Conduite 3 bis", 1, "JEU"), corridorM: 7.77, mesure: { hausdorffM: 9.87, longueurHorsCorridorM: 55.5, longueurAM: 100, partHorsCorridor: 0.555 }, conflitId: null },
  { id: "res4", ordre: 4, statut: "DIVERGENCE", objetA: o("4", "Conduite 4", 1, "OBJET"), objetB: null, corridorM: 2, mesure: null, conflitId: null },
  { id: "res5", ordre: 5, statut: "SANS_CORRESPONDANCE_B", objetA: null, objetB: o("15", "Conduite isolee", 1, "JEU"), corridorM: null, mesure: null, conflitId: null },
];

interface Etat { sources: unknown; regles: unknown; comparaisons: unknown[]; erreurs: Record<string, unknown>; comparaison?: unknown }
let e: Etat;
const REGLES = {
  regles: [
    { id: "r0", code: "S1-CORRIDOR-0.1", version: 0, statut: "APPROUVEE", portee: "GENERALE", systeme: true, margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 0, precisionParClasseM: null },
    { id: "r1", code: "R-PROJET", version: 1, statut: "BROUILLON", portee: "PROJET", famille: "EAU_POTABLE", margeM: 0.5, rayonAppariementM: 5, partHorsCorridorMax: 0, precisionParClasseM: { A: 0.5, B: 1, C: 2, D: 5 }, creePar: { id: "u-auteur", nomComplet: "Auteur Test" } },
  ],
  effectives: [{ famille: "EAU_POTABLE", code: "S1-CORRIDOR-0.1", version: 0, portee: "GENERALE", margeM: 1 }],
  avertissements: ["Valeurs par défaut provisoires."],
};

function installer() {
  h.get.mockImplementation(async (url: string, cfg: { params?: Record<string, string> } = {}) => {
    const err = e.erreurs[url];
    if (err) { delete e.erreurs[url]; throw err; }
    if (url === `${B}/sources`) return { data: e.sources };
    if (url === `${B}/regles-rapprochement`) return { data: e.regles };
    if (url === `${B}/comparaisons`) return { data: { comparaisons: e.comparaisons, curseurSuivant: null } };
    if (url === `${B}/comparaisons/cmp1`) return { data: { comparaison: e.comparaison ?? COMPARAISON } };
    if (url === `${B}/comparaisons/cmp1/objets`) return { data: { resultats: cfg.params?.curseur ? RESULTATS_P2 : RESULTATS_P1, masque: false, curseurSuivant: cfg.params?.curseur ? null : "c-2" } };
    if (url.startsWith("/v2/projets-voirie/referentiels/")) {
      return { data: { valeurs: url.endsWith("METHODE_ACQUISITION")
        ? [{ id: "m1", domaine: "METHODE_ACQUISITION", code: "GNSS", libelle: "Relevé GNSS", actif: true, parametres: {} }, { id: "m2", domaine: "METHODE_ACQUISITION", code: "NUMERISATION_PLAN", libelle: "Numérisation d'un plan", actif: true, parametres: {} }, { id: "m3", domaine: "METHODE_ACQUISITION", code: "ANCIENNE", libelle: "Méthode ancienne", actif: false, parametres: {} }]
        : [{ id: "t1", domaine: "TYPE_RESEAU", code: "EAU_BRUTE", libelle: "Eau brute", actif: true, parametres: { famille: "EAU_POTABLE" } }] } };
    }
    return { data: {} };
  });
}

function rendre(p: { peutEcrire?: boolean; estAdmin?: boolean; compteId?: string; enLigne?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OngletSources projetId="p1" actif peutEcrire={p.peutEcrire ?? true} estAdmin={p.estAdmin ?? false} compteId={p.compteId ?? "u2"} enLigne={p.enLigne ?? true} /></QueryClientProvider>);
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset();
  e = { sources: { reseaux: [UNIQUE, COMPARABLE], totaux: {}, limites: [] }, regles: REGLES, comparaisons: [COMPARAISON], erreurs: {} };
  installer();
});

describe("sources", () => {
  it("source unique : etat NORMAL, ton neutre, jamais une alerte ni un bouton de comparaison", async () => {
    rendre();
    const art = await screen.findByRole("article", { name: "Operateur A · Télécom" });
    const s = within(art).getByTestId("source-unique");
    expect(s).toHaveTextContent("Source unique : comparaison indisponible");
    expect(s).toHaveTextContent(/état normal/);
    expect(within(art).queryByRole("alert")).toBeNull();
    expect(within(art).queryByRole("button", { name: /Comparer/ })).toBeNull();
  });
  it("reseau comparable : type configurable (referentiel), methodes (une valeur desactivee reste lisible), precision", async () => {
    rendre();
    const art = await screen.findByRole("article", { name: "Societe B · Eau brute" });
    const t = within(art).getByRole("table");
    expect(within(t).getByText("j3.geojson").closest("tr")).toHaveTextContent("Méthode ancienne (valeur désactivée)");
    expect(within(t).getByText("j3.geojson").closest("tr")).toHaveTextContent("classe C, sans précision en mètres");
    expect(within(t).getByText("j2.geojson").closest("tr")).toHaveTextContent("Numérisation d'un plan");
  });
  it("aucune mention de fusion : la synthese n'est jamais une decision", async () => {
    rendre();
    await screen.findByRole("article", { name: "Societe B · Eau brute" });
    expect(screen.getAllByText(/aucune n'est modifiée, fusionnée ni privilégiée/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /fusion/i })).toBeNull();
  });
  it("lancer une comparaison entre deux jeux : corps { jeuAId, jeuBId } ; le resultat s'ouvre", async () => {
    h.post.mockResolvedValue({ data: { comparaison: COMPARAISON, resume: COMPARAISON.resume } });
    const u = userEvent.setup();
    rendre();
    const art = await screen.findByRole("article", { name: "Societe B · Eau brute" });
    await u.click(within(art).getByRole("button", { name: /Comparer deux sources/ }));
    const d = await screen.findByRole("dialog", { name: "Lancer une comparaison" });
    expect(within(d).getByText(/rapprochement incertain, sans aucune distance/)).toBeInTheDocument();
    await u.click(within(d).getByRole("button", { name: "Lancer la comparaison" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${B}/comparaisons`, { jeuAId: "j2", jeuBId: "j3" }));
    expect(await screen.findByRole("heading", { name: "Comparaison n° 4" })).toBeInTheDocument();
  });
  it("409 JEUX_NON_COMPARABLES et 429 : expliques dans le dialogue, qui reste ouvert", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 409, data: { code: "JEUX_NON_COMPARABLES", motif: "STATUT" } } })
      .mockRejectedValueOnce({ response: { status: 429, data: { code: "COMPARAISON_TROP_FREQUENTE", retryAfterS: 30 }, headers: {} } });
    const u = userEvent.setup();
    rendre();
    const art = await screen.findByRole("article", { name: "Societe B · Eau brute" });
    await u.click(within(art).getByRole("button", { name: /Comparer deux sources/ }));
    const d = await screen.findByRole("dialog");
    await u.click(within(d).getByRole("button", { name: "Lancer la comparaison" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/statuts ne permettent/);
    await u.click(within(d).getByRole("button", { name: "Lancer la comparaison" }));
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent(/30 secondes/));
  });
  it("lecteur : aucun bouton d'ecriture (ni comparer, ni brouillon de regle, ni dossier)", async () => {
    const u = userEvent.setup();
    rendre({ peutEcrire: false });
    await screen.findByRole("article", { name: "Societe B · Eau brute" });
    expect(screen.queryByRole("button", { name: /Comparer/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /brouillon/ })).toBeNull();
    await u.click(screen.getByRole("button", { name: /Voir le détail de la comparaison n° 4/ }));
    await screen.findByText(/Conduite 2 ;/);
    expect(screen.queryByRole("button", { name: /Ouvrir un dossier/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approuver/ })).toBeNull();
  });
  it("erreurs de chargement : 404 masque (introuvable), 503 avec reessai, hors ligne (reseau)", async () => {
    e.erreurs[`${B}/sources`] = { response: { status: 404, data: { code: "PROJET_INTROUVABLE" } } };
    const a = rendre();
    expect(await screen.findByText(/Sources : introuvable/)).toBeInTheDocument();
    a.unmount();
    e.erreurs[`${B}/sources`] = { response: { status: 503, data: {} } };
    const b = rendre();
    const al = await screen.findByText(/Sources : chargement impossible/);
    await userEvent.click(within(al.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Réessayer : Sources" }));
    expect(await screen.findByRole("article", { name: "Societe B · Eau brute" })).toBeInTheDocument();
    b.unmount();
    e.erreurs[`${B}/sources`] = new Error("Network Error");
    rendre({ enLigne: false });
    expect(await screen.findByText(/Sources : réseau indisponible/)).toBeInTheDocument();
  });
});

describe("resultats d'une comparaison", () => {
  async function ouvrir(p: Parameters<typeof rendre>[0] = {}) {
    const u = userEvent.setup();
    rendre(p);
    await u.click(await screen.findByRole("button", { name: /Voir le détail de la comparaison n° 4/ }));
    await screen.findByText(/Conduite 2 ;/);
    return u;
  }
  it("en-tete : mode, A et B, regle, corridor, totaux par statut", async () => {
    await ouvrir();
    const sec = screen.getByRole("region", { name: "Comparaison n° 4" });
    expect(sec).toHaveTextContent("Deux sources autorisées");
    expect(sec).toHaveTextContent("j2.geojson, v1, Numérisation d'un plan");
    expect(sec).toHaveTextContent("S1-CORRIDOR-0.1 v0, marge 1 m");
    expect(sec).toHaveTextContent("De 2 à 2 m sur cette comparaison. 1 couple(s) sans corridor");
    expect(within(sec).getByTestId("provenance-bareme")).toHaveTextContent("Le barème par classe de cette règle est le barème provisoire du système, jamais approuvé : A 0,5 m, B 1 m, C 2 m, D 5 m.");
    expect(sec).not.toHaveTextContent(/barème approuvé/);
    expect(within(sec).getByRole("list", { name: "Totaux par statut" })).toHaveTextContent("Divergence mesurée1");
  });
  it("divergence : Hausdorff et longueur hors corridor ; regle systeme : bareme provisoire, JAMAIS « approuve » (revue M1)", async () => {
    await ouvrir();
    const li = screen.getByText(/Conduite 2 ;/).closest("li")!;
    expect(within(li).getByTestId("mesure-divergence")).toHaveTextContent("distance de Hausdorff 3,2 m, 40 m hors corridor sur 100 m, soit 40 %, corridor 3 m");
    expect(li).toHaveTextContent("Conduite 2 bis ; précision 2 m, attribuée à la classe par le barème provisoire du système (règle S1-CORRIDOR-0.1 v0), jamais approuvé");
    expect(li).not.toHaveTextContent(/barème approuvé/);
  });
  it("serveur ancien, regle d'une personne sans attestation : « provenance du corridor non attestee »", async () => {
    e.comparaison = { ...COMPARAISON, regle: { ...COMPARAISON.regle, regleId: "r1", code: "R-PROJET", version: 1 } };
    await ouvrir();
    expect(screen.getByTestId("provenance-bareme")).toHaveAttribute("data-etat", "NON_ATTESTE");
    expect(screen.getByTestId("provenance-bareme")).toHaveTextContent(/Provenance du corridor non attestée/);
    expect(screen.getByText(/Conduite 2 ;/).closest("li")).toHaveTextContent("précision 2 m, attribuée à la classe par le barème de la règle R-PROJET v1 (provenance du corridor non attestée)");
  });
  it("serveur corrige : bareme atteste (source REGLE_APPROUVEE, approbateur) : « bareme approuve » avec la regle et la version", async () => {
    e.comparaison = {
      ...COMPARAISON,
      regle: { ...COMPARAISON.regle, regleId: "r5", code: "R-BAREME", version: 2, bareme: { applicable: true, applique: true, source: "REGLE_APPROUVEE", approuveParId: "u-autre" } },
      resume: { ...COMPARAISON.resume, corridor: { ...COMPARAISON.resume.corridor, origine: "BAREME_APPROUVE" }, bareme: { applique: true, couples: 1, regle: { regleId: "r5", code: "R-BAREME", version: 2, approuveParId: "u-autre" } } },
    };
    await ouvrir();
    expect(screen.getByTestId("provenance-bareme")).toHaveTextContent("vient du barème approuvé de la règle R-BAREME v2 (1 couple(s))");
    expect(screen.getByText(/Conduite 2 ;/).closest("li")).toHaveTextContent("précision 2 m, attribuée à la classe par le barème approuvé de la règle R-BAREME v2");
  });
  it("pagination par curseur ; rapprochement incertain : la raison, AUCUNE distance ; objet B masque ; sans correspondance", async () => {
    const u = await ouvrir();
    await u.click(screen.getByRole("button", { name: "Charger plus de résultats" }));
    const inc = (await screen.findByText(/Conduite 3 ;/)).closest("li")!;
    expect(within(inc).getByTestId("raison-incertain")).toHaveTextContent("La précision de l'objet de A est inconnue en mètres");
    expect(inc).not.toHaveTextContent(/Hausdorff|hors corridor sur|corridor [0-9]/);
    expect(inc).not.toHaveTextContent(/9,87|7,77|55,5|55,5 %/);
    const masque = screen.getByText(/Conduite 4 ;/).closest("li")!;
    expect(masque).toHaveTextContent("Source B : objet non communiqué (source non lisible pour votre compte)");
    expect(within(masque).getByTestId("mesure-divergence")).toHaveTextContent("non communiquée (mesure masquée pour votre compte)");
    expect(screen.getByText(/Conduite isolee/).closest("li")).toHaveTextContent("Source A : aucun objet apparié.");
    expect(h.get).toHaveBeenCalledWith(`${B}/comparaisons/cmp1/objets`, expect.objectContaining({ params: { limite: 50, curseur: "c-2" } }));
    expect(screen.queryByRole("button", { name: "Charger plus de résultats" })).toBeNull();
  });
  it("revue m4 : la derniere case cochee ne se decoche pas (aucun statut ne vaut jamais « tous ») ; le refus est dit", async () => {
    const u = await ouvrir();
    for (const nom of ["Concordance", "Divergence mesurée", "Rapprochement incertain", "Objet de A sans correspondance dans B"]) await u.click(screen.getByRole("checkbox", { name: nom }));
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith(`${B}/comparaisons/cmp1/objets`, expect.objectContaining({ params: { limite: 50, statut: "SANS_CORRESPONDANCE_B" } })));
    const derniere = screen.getByRole("checkbox", { name: "Objet de B sans correspondance dans A" });
    await u.click(derniere);
    expect(derniere).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Concordance" })).not.toBeChecked();
    expect(screen.getByTestId("filtre-statut-message")).toHaveTextContent("Au moins un statut doit rester coché.");
    expect(h.get).toHaveBeenLastCalledWith(`${B}/comparaisons/cmp1/objets`, expect.objectContaining({ params: { limite: 50, statut: "SANS_CORRESPONDANCE_B" } }));
  });
  it("filtre par statut : n'envoie que les statuts coches", async () => {
    const u = await ouvrir();
    await u.click(screen.getByRole("checkbox", { name: "Concordance" }));
    await waitFor(() => expect(h.get).toHaveBeenCalledWith(`${B}/comparaisons/cmp1/objets`, expect.objectContaining({ params: { limite: 50, statut: "DIVERGENCE,RAPPROCHEMENT_INCERTAIN,SANS_CORRESPONDANCE_A,SANS_CORRESPONDANCE_B" } })));
  });
  it("ouvrir un dossier de divergence : action humaine justifiee ; 409 DOSSIER_DEJA_OUVERT explique", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 409, data: { code: "DOSSIER_DEJA_OUVERT", conflitId: "k1" } } }).mockResolvedValueOnce({ data: { conflit: { id: "k2", type: "DIVERGENCE_SOURCES", statut: "A_INVESTIGUER" } } });
    const u = await ouvrir();
    const li = screen.getByText(/Conduite 2 ;/).closest("li")!;
    await u.click(within(li).getByRole("button", { name: /Ouvrir un dossier de divergence/ }));
    const d = await screen.findByRole("dialog", { name: "Ouvrir un dossier de divergence" });
    expect(d).toHaveTextContent(/ne modifie aucune des deux sources/);
    expect(within(d).getByRole("button", { name: "Ouvrir le dossier" })).toBeDisabled();
    await u.type(within(d).getByLabelText(/Justification/), "Ecart a verifier sur le terrain");
    await u.click(within(d).getByRole("button", { name: "Ouvrir le dossier" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/déjà ouvert/);
    await u.click(within(d).getByRole("button", { name: "Ouvrir le dossier" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${B}/comparaisons/cmp1/dossiers-conflit`, { resultatId: "res2", justification: "Ecart a verifier sur le terrain" }));
  });
  it("404 COMPARAISON_INTROUVABLE (masquee pour ce compte) : dite introuvable", async () => {
    e.erreurs[`${B}/comparaisons/cmp1`] = { response: { status: 404, data: { code: "COMPARAISON_INTROUVABLE" } } };
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Voir le détail de la comparaison n° 4/ }));
    expect(await screen.findByText(/Comparaison : introuvable/)).toBeInTheDocument();
  });
});

describe("regles de rapprochement", () => {
  it("l'auteur d'un brouillon ne l'approuve pas : refus explique, aucun bouton", async () => {
    rendre({ estAdmin: true, compteId: "u-auteur" });
    const li = (await screen.findByText("R-PROJET v1")).closest("li")!;
    expect(within(li).getByTestId("raison-non-approbation")).toHaveTextContent(/Vous êtes l'auteur.*autre personne/);
    expect(within(li).queryByRole("button", { name: /Approuver/ })).toBeNull();
  });
  it("un gestionnaire voit qu'il faut un administrateur ; un autre ADMIN approuve avec justification ; 409 SEPARATION_DES_TACHES dit", async () => {
    const a = rendre({ estAdmin: false });
    expect(within((await screen.findByText("R-PROJET v1")).closest("li")!).getByTestId("raison-non-approbation")).toHaveTextContent(/réservée à un administrateur/);
    a.unmount();
    h.post.mockRejectedValueOnce({ response: { status: 409, data: { code: "SEPARATION_DES_TACHES" } } }).mockResolvedValueOnce({ data: { regle: { ...REGLES.regles[1], statut: "APPROUVEE" } } });
    const u = userEvent.setup();
    rendre({ estAdmin: true, compteId: "u-autre" });
    await u.click(await screen.findByRole("button", { name: "Approuver la règle R-PROJET v1" }));
    const d = await screen.findByRole("dialog");
    await u.type(within(d).getByLabelText(/Justification/), "Bareme valide avec la DSI");
    await u.click(within(d).getByRole("button", { name: "Approuver" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/Séparation des tâches/);
    await u.click(within(d).getByRole("button", { name: "Approuver" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${B}/regles-rapprochement/r1/approuver`, { justification: "Bareme valide avec la DSI" }));
  });
  it("brouillon : corps sans valeur inventee ; bareme affiche ; provisoire signale", async () => {
    h.post.mockResolvedValue({ data: { regle: { ...REGLES.regles[1], id: "r2" } } });
    const u = userEvent.setup();
    rendre();
    expect(await screen.findByText("Valeurs par défaut provisoires.")).toBeInTheDocument();
    expect((await screen.findByText("R-PROJET v1")).closest("li")).toHaveTextContent("Barème par classe : A 0,5 m, B 1 m, C 2 m, D 5 m.");
    await u.click(screen.getByRole("button", { name: /Créer un brouillon de règle/ }));
    const d = await screen.findByRole("dialog");
    await u.type(within(d).getByLabelText("Code de la règle"), "R-NOUVELLE");
    await u.type(within(d).getByLabelText("Marge (m)"), "0,5");
    await u.type(within(d).getByLabelText(/Justification/), "Marge convenue avec le concessionnaire");
    await u.click(within(d).getByRole("button", { name: "Créer le brouillon" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${B}/regles-rapprochement`, { code: "R-NOUVELLE", justification: "Marge convenue avec le concessionnaire", margeM: 0.5 }));
  });
});

describe("regles : bareme laisse vide (revue m3)", () => {
  it("l'aide ne promet rien que le serveur ne fasse : le bareme est celui que le serveur enregistre, relu dans la liste apres creation", async () => {
    // Serveur de cette branche : un brouillon sans bareme recoit le bareme provisoire ; l'ecran montre ce que le serveur a enregistre.
    const CREEE = { id: "r9", code: "R-SANS-BAREME", version: 1, statut: "BROUILLON", portee: "PROJET", margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 0, precisionParClasseM: { A: 0.5, B: 1, C: 2, D: 5 }, creePar: { id: "u2", nomComplet: "Gestionnaire Test" } };
    h.post.mockImplementation(async () => { e.regles = { ...REGLES, regles: [...REGLES.regles, CREEE] }; return { data: { regle: CREEE } }; });
    const u = userEvent.setup();
    rendre();
    await u.click(await screen.findByRole("button", { name: /Créer un brouillon de règle/ }));
    const d = await screen.findByRole("dialog");
    expect(d).toHaveTextContent(/Laissé vide, le barème est celui que le serveur enregistre : il est affiché dans la liste après la création/);
    expect(d).not.toHaveTextContent(/sans lui, un tel objet donne un rapprochement incertain/);
    await u.type(within(d).getByLabelText("Code de la règle"), "R-SANS-BAREME");
    await u.type(within(d).getByLabelText(/Justification/), "Regle sans bareme saisi");
    await u.click(within(d).getByRole("button", { name: "Créer le brouillon" }));
    const li = (await screen.findByText("R-SANS-BAREME v1")).closest("li")!;
    expect(li).toHaveTextContent("Barème par classe : A 0,5 m, B 1 m, C 2 m, D 5 m.");
    expect(li).toHaveTextContent(/ne s'applique qu'après approbation par un administrateur autre que l'auteur/);
  });
});

describe("accessibilite (axe)", () => {
  it("aucune violation : sources, resultats, dialogue de comparaison", async () => {
    const u = userEvent.setup();
    const r = rendre({ estAdmin: true });
    await screen.findByRole("article", { name: "Societe B · Eau brute" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    await u.click(screen.getByRole("button", { name: /Voir le détail de la comparaison n° 4/ }));
    await screen.findByText(/Conduite 2 ;/);
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    await u.click(screen.getByRole("button", { name: /Comparer deux sources/ }));
    await screen.findByRole("dialog");
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  }, 60_000);
});
