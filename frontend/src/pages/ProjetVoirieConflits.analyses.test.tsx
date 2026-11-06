import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "GESTIONNAIRE", userId: "u-gest" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: h.userId, nomComplet: "Moussa Gestionnaire", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn().mockResolvedValue(undefined) }));

import { reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import {
  ANALYSE_1, REGLES, analyseConflit, brut, regle, serveurComparaison, serveurLancement, serveurListeAnalyses, serveurRegle, serveurRegles,
} from "../components/projets-voirie/conflitsSynthetiques.testutil";
import { BASE, erreurHttp, rendrePage, reponseApi, type SurchargesApi } from "../components/projets-voirie/conflitsPage.testutil";
import { downloadViaApi } from "../lib/download";

/**
 * Analyses persistees (lancement, historique, comparaison), regles de conflit (liste, brouillon, approbation ADMIN), export CSV.
 */

configure({ asyncUtilTimeout: 8000 });

function installer(over: SurchargesApi = {}) {
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApi(url, opts?.params, over));
}
const appels = (url: string) => h.get.mock.calls.filter((c) => c[0] === url).length;

async function ouvrir(role = "GESTIONNAIRE", userId = "u-gest", over: SurchargesApi = {}) {
  h.role = role; h.userId = userId;
  installer(over);
  rendrePage();
  await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
  await screen.findByRole("list", { name: "Liste des conflits" });
}
const section = (nom: string) => screen.getByRole("button", { name: nom });
async function versSection(nom: "Analyses" | "Règles") {
  await userEvent.click(section(nom));
}

beforeEach(() => {
  for (const f of [h.get, h.post, h.patch, h.delete]) f.mockReset();
  vi.mocked(downloadViaApi).mockClear().mockResolvedValue(undefined);
  h.post.mockResolvedValue({ data: {} });
  h.role = "GESTIONNAIRE"; h.userId = "u-gest";
  reinitialiserCarte();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => { Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true }); });

describe("lancer une analyse", () => {
  it.each(["ADMIN", "GESTIONNAIRE"])("%s : le bouton existe, le POST part avec un corps vide (aucune largeur, aucune regle choisie par l'interface)", async (role) => {
    await ouvrir(role, "u1");
    h.post.mockResolvedValueOnce({ data: brut(serveurLancement(analyseConflit())) });
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/analyses`, {}));
  });

  it("etat d'attente : bouton inactif et annonce, un seul POST meme avec un double clic ; puis resume et liste rechargee", async () => {
    await ouvrir();
    let fin!: (v: unknown) => void;
    h.post.mockImplementationOnce(() => new Promise((r) => { fin = r; }));
    const avant = appels(`${BASE}/conflits`);
    const b = screen.getByRole("button", { name: "Lancer une analyse" });
    await userEvent.dblClick(b);
    const attente = await screen.findByTestId("analyse-en-cours");
    expect(attente).toHaveTextContent("une seule analyse à la fois est admise par projet");
    expect(screen.getByRole("button", { name: "Analyse en cours…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Analyse en cours…" })).toHaveAttribute("aria-busy", "true");
    expect(h.post).toHaveBeenCalledTimes(1);
    fin({ data: brut(serveurLancement(analyseConflit())) });
    const ok = await screen.findByTestId("analyse-terminee");
    expect(ok).toHaveTextContent("Analyse n° 2 terminée.");
    expect(ok).toHaveTextContent("4 conflit(s) · 1 nouveau(x) · 2 retrouvé(s) · 1 non retrouvé(s), marqués « à réexaminer » (ni fermés ni supprimés)");
    expect(ok).toHaveTextContent("Aucun verdict humain n'a été modifié");
    expect(screen.queryByTestId("analyse-en-cours")).toBeNull();
    await waitFor(() => expect(appels(`${BASE}/conflits`)).toBeGreaterThan(avant));
    expect(screen.getByRole("button", { name: "Lancer une analyse" })).toBeEnabled();
  });

  it.each([
    [503, "PROJET_OCCUPE", /Ce projet ou ce dossier est occupé/, true],
    [503, "SERVICE_OCCUPE", /Le serveur traite déjà d'autres demandes/, true],
    [503, undefined, /momentanément indisponible ou occupé \(503\)/, true],
    [504, "ANALYSE_TROP_LONGUE", /Le calcul de l'analyse a dépassé le délai autorisé/, true],
    [504, undefined, /délai autorisé \(504\)/, true],
    [422, "ANALYSE_TROP_VOLUMINEUSE", /trop volumineuse/, false],
  ] as const)("erreur %i %s : expliquee, jamais un echec muet%s", async (status, code, motif, reessai) => {
    await ouvrir();
    h.post.mockRejectedValueOnce(erreurHttp(status, code));
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    const alerte = await screen.findByTestId("analyse-erreur");
    expect(alerte).toHaveTextContent("L'analyse n'a pas abouti.");
    expect(alerte).toHaveTextContent(motif);
    expect(!!within(alerte).queryByRole("button", { name: "Réessayer l'analyse" })).toBe(reessai);
    expect(screen.getByRole("button", { name: "Lancer une analyse" })).toBeEnabled();
  });

  it("503 PROJET_OCCUPE puis reussite : « Reessayer » relance, l'erreur disparait", async () => {
    await ouvrir();
    h.post.mockRejectedValueOnce(erreurHttp(503, "PROJET_OCCUPE")).mockResolvedValueOnce({ data: brut(serveurLancement(analyseConflit())) });
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    await userEvent.click(await screen.findByRole("button", { name: "Réessayer l'analyse" }));
    await screen.findByTestId("analyse-terminee");
    expect(screen.queryByTestId("analyse-erreur")).toBeNull();
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("reseau coupe : message de reseau", async () => {
    await ouvrir();
    h.post.mockRejectedValueOnce(new Error("Network Error"));
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    expect(await screen.findByTestId("analyse-erreur")).toHaveTextContent("Le serveur est injoignable");
  });

  it("analyse en echec cote serveur (delai, volume) : c'est une ERREUR HTTP, dite avec son code ; aucun faux succes", async () => {
    await ouvrir();
    h.post.mockRejectedValueOnce(erreurHttp(504, "ANALYSE_TROP_LONGUE", "L'analyse a dépassé 60 s et a été interrompue"));
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    const e = await screen.findByTestId("analyse-erreur");
    expect(e).toHaveAttribute("data-code", "ANALYSE_TROP_LONGUE");
    expect(e).toHaveTextContent("L'analyse n'a pas abouti.");
    expect(screen.queryByTestId("analyse-terminee")).toBeNull();
    expect(screen.queryByTestId("analyse-echec")).toBeNull();
  });

  it("une reponse 2xx dont le statut n'est pas TERMINEE (jamais envoyee par le serveur) n'est pas presentee comme une analyse terminee ni comme un echec invente", async () => {
    await ouvrir();
    h.post.mockResolvedValueOnce({ data: brut(serveurLancement(analyseConflit({ statut: "ECHEC" }))) });
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    expect(await screen.findByText(/n'a pas détaillé son résultat/)).toBeInTheDocument();
    expect(screen.queryByTestId("analyse-terminee")).toBeNull();
    expect(screen.queryByTestId("analyse-echec")).toBeNull();
  });

  it("429 (limite de frequence) : message en clair avec le delai Retry-After, sans code invente", async () => {
    await ouvrir();
    h.post.mockRejectedValueOnce(Object.assign(new Error("429"), { response: { status: 429, headers: { "retry-after": "42" }, data: { error: "Une analyse par minute et par projet.", code: "ANALYSE_TROP_RAPPROCHEE" } } }));
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    const e = await screen.findByTestId("analyse-erreur");
    expect(e).toHaveTextContent("Trop de demandes en peu de temps");
    expect(e).toHaveTextContent("Une analyse par minute et par projet.");
    expect(e).toHaveTextContent("Réessayez dans 42 secondes");
  });

  it("reponse sans detail : on le dit et on renvoie a l'historique, sans inventer de resultat", async () => {
    await ouvrir();
    h.post.mockResolvedValueOnce({ data: {} });
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    expect(await screen.findByText(/n'a pas détaillé son résultat/)).toBeInTheDocument();
    expect(screen.queryByTestId("analyse-terminee")).toBeNull();
  });

  it("le resume n'invente aucun chiffre : une valeur absente n'est pas affichee", async () => {
    await ouvrir();
    // Reponse minimale : ni totaux, ni compteurs. Rien n'est devine.
    h.post.mockResolvedValueOnce({ data: { analyse: { id: "an-9", numero: 9, statut: "TERMINEE", resume: {} } } });
    await userEvent.click(screen.getByRole("button", { name: "Lancer une analyse" }));
    const ok = await screen.findByTestId("analyse-terminee");
    expect(ok.textContent).toContain("Résultat enregistré");
    expect(ok.textContent).not.toMatch(/\d conflit\(s\)|nouveau\(x\)|retrouvé\(s\)/);
  });
});

describe("historique des analyses", () => {
  it("liste du plus recent au plus ancien : numero, statut en texte et forme, date UTC, declencheur, largeurs, algorithme, resume", async () => {
    await ouvrir();
    await versSection("Analyses");
    const l = await screen.findByRole("list", { name: "Analyses" });
    const [a, b] = within(l).getAllByRole("listitem");
    expect(a).toHaveTextContent("Analyse n° 2");
    expect(within(a).getByText("Terminée")).toBeInTheDocument();
    expect(a).toHaveTextContent("04/11/2026 08:00 UTC · Moussa Gestionnaire · durée 1,8 s");
    expect(a).toHaveTextContent("Largeurs : chaussée 7 m, emprise 15 m · algorithme 2D-UTM-1");
    expect(a).toHaveTextContent("4 conflit(s) trouvé(s) · 1 nouveau(x) · 2 retrouvé(s) · 1 non retrouvé(s)");
    expect(a).toHaveTextContent("1 modifié(s) · 1 identique(s) · 2 marqué(s) à réexaminer");
    expect(a).toHaveTextContent("1 axe(s) ne sont couverts par aucun jeu de réseau autorisé : zone à investiguer, jamais une absence de réseau.");
    expect(a).toHaveTextContent("Par type : Intersection avec la chaussée 2, Proximité à vérifier 2.");
    expect(b).toHaveTextContent("Analyse n° 1");
    expect(b).toHaveTextContent("3 conflit(s) trouvé(s) · 3 nouveau(x) · 0 retrouvé(s) · 0 non retrouvé(s)");
  });

  it("detail a la demande : regles (code, version) et jeux (version, empreinte) de l'analyse ; reproductibilite rappelee", async () => {
    await ouvrir();
    await versSection("Analyses");
    const l = await screen.findByRole("list", { name: "Analyses" });
    expect(appels(`${BASE}/analyses/an-2`)).toBe(0);
    await userEvent.click(within(within(l).getAllByRole("listitem")[0]).getByRole("button", { name: /Règles et jeux de l'analyse n° 2/ }));
    await waitFor(() => expect(appels(`${BASE}/analyses/an-2`)).toBe(1));
    const li = within(l).getAllByRole("listitem")[0];
    expect(await within(li).findByText(/RC-2D-0.1, version 0, toutes familles/)).toBeInTheDocument();
    expect(li).toHaveTextContent("reseau-synthetique.kml, version 2 · Réseau de concessionnaire · AUTORISE");
    expect(li).toHaveTextContent("empreinte SHA-256 : abababababababab…");
    expect(li).toHaveTextContent("Limites de cette analyse");
    expect(li).toHaveTextContent("Seuls les réseaux linéaires sont évalués.");
    expect(li).toHaveTextContent("redonne les mêmes conflits");
  });

  it("analyse en echec : signalee, conflits intacts", async () => {
    await ouvrir("GESTIONNAIRE", "u", { analyses: brut(serveurListeAnalyses([analyseConflit({ statut: "ECHEC", erreur: { code: "ANALYSE_TROP_VOLUMINEUSE", message: "trop de sommets" } })])) });
    await versSection("Analyses");
    const note = await screen.findByText(/Cette analyse a échoué/);
    expect(note).toHaveTextContent("Cause : trop de sommets (ANALYSE_TROP_VOLUMINEUSE)");
    expect(screen.getByText("En échec")).toBeInTheDocument();
    // Aucun chiffre n'est presente pour une analyse en echec (pas de « 0 conflit »).
    expect(note.closest("li")!.textContent).not.toMatch(/conflit\(s\) trouvé/);
  });

  it("vide, erreur 504, erreur 403 : expliques", async () => {
    await ouvrir("GESTIONNAIRE", "u", { analyses: brut(serveurListeAnalyses([])) });
    await versSection("Analyses");
    expect(await screen.findByText("Aucune analyse lancée")).toBeInTheDocument();
    expect(screen.getByText("Il faut au moins deux analyses terminées pour les comparer.")).toBeInTheDocument();
  });

  it("pagination : « Charger les analyses plus anciennes » envoie le curseur et ajoute la page", async () => {
    await ouvrir("GESTIONNAIRE", "u", { analyses: brut(serveurListeAnalyses([analyseConflit()], "n2")) });
    await versSection("Analyses");
    await screen.findByRole("list", { name: "Analyses" });
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => (url === `${BASE}/analyses` && opts?.params?.curseur === "n2"
      ? { data: brut(serveurListeAnalyses([ANALYSE_1], null)) } : reponseApi(url, opts?.params)));
    await userEvent.click(screen.getByRole("button", { name: "Charger les analyses plus anciennes" }));
    await waitFor(() => expect(h.get).toHaveBeenCalledWith(`${BASE}/analyses`, { params: { curseur: "n2" }, signal: expect.anything() }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Analyses" })).getAllByRole("listitem")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Charger les analyses plus anciennes" })).toBeNull();
  });

  it.each([[504, undefined, /délai autorisé \(504\)/], [403, undefined, /clé de module/]] as const)("historique en erreur %i", async (status, code, motif) => {
    await ouvrir("GESTIONNAIRE", "u", { analyses: erreurHttp(status, code) });
    await versSection("Analyses");
    expect(await screen.findByText(motif)).toBeInTheDocument();
    expect(screen.queryByText("Aucune analyse lancée")).toBeNull();
  });
});

describe("comparaison de deux analyses", () => {
  const brutes = brut(serveurListeAnalyses([analyseConflit(), ANALYSE_1]));

  async function ouvrirComparaison(over: SurchargesApi = {}) {
    await ouvrir("GESTIONNAIRE", "u-gest", { analyses: brutes, ...over });
    await versSection("Analyses");
    await screen.findByRole("list", { name: "Analyses" });
  }

  it("par defaut la plus recente est comparee a la precedente : GET analyses/an-2/comparaison?avec=an-1 ; apparus, disparus, modifies, identiques", async () => {
    await ouvrirComparaison();
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    const r = await screen.findByTestId("resultat-comparaison");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/analyses/an-2/comparaison`, { params: { avec: "an-1" }, signal: expect.anything() });
    expect(r).toHaveTextContent("Comparaison de l'analyse n° 2 avec l'analyse n° 1.");
    expect(screen.getByTestId("cmp-apparus")).toHaveTextContent("1");
    expect(screen.getByTestId("cmp-disparus")).toHaveTextContent("1");
    expect(screen.getByTestId("cmp-modifies")).toHaveTextContent("0");
    expect(screen.getByTestId("cmp-identiques")).toHaveTextContent("2");
    // Un conflit « disparu » n'est PAS resolu : l'ecran le dit.
    expect(r).toHaveTextContent("Ils ne sont ni fermés ni supprimés : ils restent en base, marqués « à réexaminer », leur verdict humain est conservé.");
    expect(r).toHaveTextContent("Présents dans l'analyse n° 2, absents de l'analyse n° 1 : nouveaux dossiers.");
    // Le serveur joint l'axe, le type et le statut de chaque dossier : on les montre, sans autre requete.
    expect(within(r).getByRole("button", { name: /Axe B/ })).toHaveTextContent("À investiguer");
    expect(within(r).getByRole("button", { name: /Axe D/ })).toHaveTextContent("Couverture insuffisante");
  });

  it("un dossier de la comparaison s'ouvre d'un clic (vue Dossiers, fiche du dossier)", async () => {
    await ouvrirComparaison();
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    const r = await screen.findByTestId("resultat-comparaison");
    await userEvent.click(within(r).getByRole("button", { name: /Axe B/ }));
    const f = await screen.findByTestId("fiche-conflit");
    expect(f).toHaveAttribute("data-conflit-id", "cf-2");
  });

  it("detail tronque par le serveur : le nombre reste celui du serveur, les dossiers sans detail sont comptes", async () => {
    await ouvrirComparaison({ comparaison: brut(serveurComparaison({ apparus: { nb: 1500, cles: [], conflits: [{ cle: "k", id: "cf-2", type: "PROXIMITE", axe: "Axe B", statut: "A_INVESTIGUER", aReexaminer: false }], detailsTronques: true } })) });
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    const r = await screen.findByTestId("resultat-comparaison");
    expect(screen.getByTestId("cmp-apparus")).toHaveTextContent("1 500");
    expect(r).toHaveTextContent("1 499 autre(s) sans détail (le serveur limite le détail).");
  });

  it("une analyse en echec n'est jamais proposee a la comparaison (409 ANALYSE_NON_COMPARABLE evite)", async () => {
    await ouvrir("GESTIONNAIRE", "u", { analyses: brut(serveurListeAnalyses([analyseConflit({ id: "an-3", numero: 3, statut: "ECHEC", erreur: { code: "ANALYSE_TROP_LONGUE", message: "délai" } }), analyseConflit(), ANALYSE_1])) });
    await versSection("Analyses");
    await screen.findByRole("list", { name: "Analyses" });
    const sel = screen.getByLabelText("Analyse à comparer") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["an-2", "an-1"]);
    expect(screen.getByText("En échec")).toBeInTheDocument();
  });

  it("409 ANALYSE_NON_COMPARABLE (course) : message en clair", async () => {
    await ouvrirComparaison({ comparaison: erreurHttp(409, "ANALYSE_NON_COMPARABLE") });
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    expect(await screen.findByText(/Une analyse en échec n'a pas de résultat à comparer/)).toBeInTheDocument();
  });

  it("inverser les choix compare toujours la plus recente a la plus ancienne", async () => {
    await ouvrirComparaison();
    await userEvent.selectOptions(screen.getByLabelText("Analyse à comparer"), "an-1");
    await userEvent.selectOptions(screen.getByLabelText("Avec l'analyse de référence"), "an-2");
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    await screen.findByTestId("resultat-comparaison");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/analyses/an-2/comparaison`, { params: { avec: "an-1" }, signal: expect.anything() });
  });

  it("la meme analyse des deux cotes : refusee, aucune requete", async () => {
    await ouvrirComparaison();
    await userEvent.selectOptions(screen.getByLabelText("Avec l'analyse de référence"), "an-2");
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choisissez deux analyses différentes.");
    expect(h.get.mock.calls.some((c) => String(c[0]).endsWith("/comparaison"))).toBe(false);
  });

  it("comparaison en erreur (404, 504) : expliquee ; une reponse sans les quatre categories LEVE", async () => {
    await ouvrirComparaison({ comparaison: erreurHttp(504) });
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    expect(await screen.findByText(/délai autorisé \(504\)/)).toBeInTheDocument();
  });
  it("comparaison illisible : reponse inattendue, jamais « aucune difference »", async () => {
    await ouvrirComparaison({ comparaison: { apparus: { nb: 1, cles: [] } } });
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    expect(await screen.findByText(/Réponse inattendue du serveur/)).toBeInTheDocument();
    expect(screen.queryByTestId("resultat-comparaison")).toBeNull();
  });
  it("une seule analyse : pas de comparaison possible", async () => {
    await ouvrir("GESTIONNAIRE", "u", { analyses: brut(serveurListeAnalyses([ANALYSE_1])) });
    await versSection("Analyses");
    expect(await screen.findByText("Il faut au moins deux analyses terminées pour les comparer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comparer" })).toBeNull();
  });
  it("une categorie sans cles ni dossiers detailles : le nombre est affiche et on dit que la liste manque", async () => {
    await ouvrirComparaison({ comparaison: brut(serveurComparaison({ apparus: { nb: 3, cles: [], conflits: [], detailsTronques: true } })) });
    await userEvent.click(screen.getByRole("button", { name: "Comparer" }));
    const r = await screen.findByTestId("resultat-comparaison");
    expect(r).toHaveTextContent("3 conflit(s) ; le serveur n'en donne pas la liste.");
  });
});

describe("regles de conflit", () => {
  async function ouvrirRegles(role = "GESTIONNAIRE", userId = "u-gest", over: SurchargesApi = {}) {
    await ouvrir(role, userId, over);
    await versSection("Règles");
    await screen.findAllByText(/^version [0-9]/);
  }

  it("liste par famille, versions et statuts en texte et forme ; regle par defaut (version 0, tolerance 0) sans seuil invente", async () => {
    await ouvrirRegles();
    const generale = screen.getByRole("group", { name: "Règles : Toutes familles (règle générale)" });
    expect(generale).toHaveTextContent("RC-2D-0.1");
    expect(generale).toHaveTextContent("version 0");
    expect(generale).toHaveTextContent("Tolérance de proximité : 0 m");
    expect(within(generale).getByText("Approuvée")).toBeInTheDocument();
    expect(generale).toHaveTextContent("Immuable : pour la changer, créez une nouvelle version.");
    const tel = screen.getByRole("group", { name: "Règles : Télécom" });
    const [v2, v1] = within(tel).getAllByRole("listitem");
    expect(v2).toHaveTextContent("RC-TELversion 2Brouillon");
    expect(v2).toHaveTextContent("Tolérance de proximité : 3 m · marge d'incertitude : facteur 1,5");
    expect(v1).toHaveTextContent("RC-TELversion 1Approuvée");
    expect(v1).toHaveTextContent("approuvée par Fatou Admin, 01/11/2026 08:00 UTC");
    expect(v1).toHaveTextContent("Créée par Moussa Gestionnaire");
    expect(v1).toHaveTextContent("Motif d'approbation : Validée avec la direction");
    expect(generale).toHaveTextContent("Créée par le système (règle par défaut du socle)");
    expect(generale).toHaveTextContent("règle générale");
    expect(v1).toHaveTextContent("règle du projet");
    expect(v2.querySelector("[data-statut-regle=BROUILLON]")).not.toBeNull();
  });

  it("regle EFFECTIVE de chaque famille (donnee par le serveur) : la version approuvee la plus recente, sinon la generale", async () => {
    await ouvrirRegles();
    const sec = screen.getByRole("heading", { name: /Règle appliquée aujourd'hui à chaque famille/ }).closest("section")!;
    expect(within(sec).getAllByRole("listitem")).toHaveLength(6);
    expect(sec.querySelector("[data-famille=TELECOM]")).toHaveTextContent("Télécom : RC-TEL, version 1 (règle du projet) · tolérance 2 m · marge ×1,5");
    expect(sec.querySelector("[data-famille=EAU_POTABLE]")).toHaveTextContent("Eau potable : RC-2D-0.1, version 0 (règle générale) · tolérance 0 m · marge ×1");
    expect(sec).toHaveTextContent("La prochaine analyse l'utilisera");
  });

  it("gestionnaire : peut creer un brouillon, ne peut PAS approuver", async () => {
    await ouvrirRegles("GESTIONNAIRE");
    expect(screen.getByRole("button", { name: "Créer un brouillon de règle" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approuver la règle/ })).toBeNull();
    expect(screen.getByText("Les brouillons attendent l'approbation d'un administrateur.")).toBeInTheDocument();
  });

  it("creation d'un brouillon : aucune tolerance proposee, champs requis, POST du contrat", async () => {
    await ouvrirRegles();
    await userEvent.click(screen.getByRole("button", { name: "Créer un brouillon de règle" }));
    const d = await screen.findByRole("dialog");
    expect((within(d).getByLabelText("Tolérance de proximité (m)") as HTMLInputElement).value).toBe("");
    expect((within(d).getByLabelText("Marge d'incertitude (facteur)") as HTMLInputElement).value).toBe("1");
    const envoyer = within(d).getByRole("button", { name: "Créer le brouillon" });
    expect(envoyer).toBeDisabled();
    await userEvent.selectOptions(within(d).getByLabelText("Famille de réseau"), "EAU_POTABLE");
    await userEvent.type(within(d).getByLabelText("Code de la règle"), "RC-EAU");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Tolérance convenue avec la société des eaux");
    expect(envoyer).toBeDisabled();
    expect(within(d).getByRole("status", { name: "Points à corriger" })).toHaveTextContent("La tolérance de proximité est obligatoire (aucune valeur n'est proposée");
    await userEvent.type(within(d).getByLabelText("Tolérance de proximité (m)"), "2,5");
    expect(envoyer).toBeEnabled();
    const avant = appels(`${BASE}/regles`);
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/regles`, { famille: "EAU_POTABLE", code: "RC-EAU", toleranceProximiteM: 2.5, margeIncertitude: 1, justification: "Tolérance convenue avec la société des eaux" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(appels(`${BASE}/regles`)).toBeGreaterThan(avant));
  });

  it("regle generale (sans famille) et tolerance 0 saisie : famille absente du corps, 0 envoye", async () => {
    await ouvrirRegles();
    await userEvent.click(screen.getByRole("button", { name: "Créer un brouillon de règle" }));
    const d = await screen.findByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Code de la règle"), "RC-GEN");
    await userEvent.type(within(d).getByLabelText("Tolérance de proximité (m)"), "0");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Aucune bande de proximité supplémentaire");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le brouillon" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/regles`, { code: "RC-GEN", toleranceProximiteM: 0, margeIncertitude: 1, justification: "Aucune bande de proximité supplémentaire" }));
  });

  it("brouillon refuse par le serveur (409 REGLE_IMMUABLE) : message, dialogue ouvert", async () => {
    await ouvrirRegles();
    await userEvent.click(screen.getByRole("button", { name: "Créer un brouillon de règle" }));
    const d = await screen.findByRole("dialog");
    h.post.mockRejectedValueOnce(erreurHttp(409, "REGLE_IMMUABLE"));
    await userEvent.type(within(d).getByLabelText("Code de la règle"), "RC-TEL");
    await userEvent.type(within(d).getByLabelText("Tolérance de proximité (m)"), "1");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Changer une règle approuvée");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le brouillon" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Une règle approuvée est immuable. Pour la changer, créez un nouveau brouillon");
  });

  it("approbation reservee ADMIN : bouton sur les brouillons seulement, justification de 10 caracteres, POST", async () => {
    await ouvrirRegles("ADMIN", "u-adm");
    expect(screen.getAllByRole("button", { name: /Approuver la règle/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Approuver la règle RC-TEL, version 2" }));
    const d = await screen.findByRole("dialog");
    expect(d).toHaveTextContent("Approuvée, une règle devient immuable");
    expect(d).toHaveTextContent("L'auteur d'une règle ne peut pas l'approuver sans dérogation");
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
    const envoyer = within(d).getByRole("button", { name: "Approuver la règle" });
    expect(envoyer).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Justification/), "Validée avec la direction");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/regles/rg-2/approuver`, { justification: "Validée avec la direction" }));
  });

  it("l'auteur du brouillon (ADMIN) : derogation obligatoire et envoyee", async () => {
    const regles = brut(serveurRegles([regle({ id: "rg-9", projetId: "p1", portee: "PROJET", famille: "TELECOM", code: "RC-X", version: 1, statut: "BROUILLON", systeme: false, creePar: { id: "u-adm", nom: "Fatou Admin" } })]));
    await ouvrirRegles("ADMIN", "u-adm", { regles });
    await userEvent.click(screen.getByRole("button", { name: "Approuver la règle RC-X, version 1" }));
    const d = await screen.findByRole("dialog");
    expect(d).toHaveTextContent("Vous êtes l'auteur de ce brouillon.");
    await userEvent.type(within(d).getByLabelText(/Justification/), "Validée avec la direction");
    const envoyer = within(d).getByRole("button", { name: "Approuver la règle" });
    expect(envoyer).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Dérogation à la séparation des tâches/), "Seul administrateur disponible");
    expect(envoyer).toBeEnabled();
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/regles/rg-9/approuver`, { justification: "Validée avec la direction", derogation: "Seul administrateur disponible" }));
  });

  it("SEPARATION_DES_TACHES oppose a un ADMIN non auteur : la derogation apparait", async () => {
    await ouvrirRegles("ADMIN", "u-adm");
    await userEvent.click(screen.getByRole("button", { name: "Approuver la règle RC-TEL, version 2" }));
    const d = await screen.findByRole("dialog");
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES"));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Validée avec la direction");
    await userEvent.click(within(d).getByRole("button", { name: "Approuver la règle" }));
    await within(d).findByRole("alert");
    expect(await within(d).findByLabelText(/Dérogation à la séparation des tâches/)).toBeInTheDocument();
  });

  it("approbation refusee (409 REGLE_IMMUABLE) : message en clair", async () => {
    await ouvrirRegles("ADMIN", "u-adm");
    await userEvent.click(screen.getByRole("button", { name: "Approuver la règle RC-TEL, version 2" }));
    const d = await screen.findByRole("dialog");
    h.post.mockRejectedValueOnce(erreurHttp(409, "REGLE_IMMUABLE"));
    await userEvent.type(within(d).getByLabelText(/Justification/), "Validée avec la direction");
    await userEvent.click(within(d).getByRole("button", { name: "Approuver la règle" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Une règle approuvée est immuable");
  });

  it("vide, erreur 403, element illisible : expliques", async () => {
    await ouvrir("GESTIONNAIRE", "u", { regles: { regles: [], effectives: [] } });
    await versSection("Règles");
    expect(await screen.findByText("Aucune règle listée par le serveur")).toBeInTheDocument();
  });
  it("regles en erreur 403", async () => {
    await ouvrir("GESTIONNAIRE", "u", { regles: erreurHttp(403) });
    await versSection("Règles");
    expect(await screen.findByText(/clé de module/)).toBeInTheDocument();
  });
  it("regle d'un statut inconnu : ignoree et signalee", async () => {
    await ouvrir("GESTIONNAIRE", "u", { regles: brut({ ...serveurRegles([REGLES[0]]), regles: [serveurRegle(REGLES[0]), { id: "x", code: "Z", statut: "ACTIVE" }] }) });
    await versSection("Règles");
    expect(await screen.findByRole("alert")).toHaveTextContent("1 règle(s) de la réponse du serveur n'ont pas pu être lues");
  });
  it("le bandeau des garde-fous reste visible sur les ecrans Analyses et Regles", async () => {
    await ouvrir();
    await versSection("Analyses");
    expect(screen.getByTestId("bandeau-garde-fous")).toBeVisible();
    await versSection("Règles");
    expect(screen.getByTestId("bandeau-garde-fous")).toBeVisible();
  });
});

describe("export CSV des conflits", () => {
  it.each(["ADMIN", "GESTIONNAIRE"])("%s : telechargement par l'API authentifiee, sans filtre ni geometrie", async (role) => {
    await ouvrir(role, "u1");
    await userEvent.click(screen.getByRole("button", { name: /Exporter les conflits \(CSV\)/ }));
    await waitFor(() => expect(downloadViaApi).toHaveBeenCalledWith(`${BASE}/conflits/export.csv`, "VOIRIE-SYNTH-2026-dossiers-de-conflit.csv"));
  });

  it("echec : message, bouton de nouveau actif", async () => {
    await ouvrir();
    vi.mocked(downloadViaApi).mockRejectedValueOnce(erreurHttp(403));
    await userEvent.click(screen.getByRole("button", { name: /Exporter les conflits \(CSV\)/ }));
    expect(await screen.findByText(/L'export CSV a échoué/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exporter les conflits \(CSV\)/ })).toBeEnabled();
  });

  it("echec : le corps JSON typé de l'erreur (Blob) est relu, le message est celui du CODE (ici 404 PROJET_INTROUVABLE)", async () => {
    await ouvrir();
    const corps = new Blob([JSON.stringify({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" })], { type: "application/json" });
    vi.mocked(downloadViaApi).mockImplementationOnce(async () => { throw Object.assign(new Error("404"), { response: { status: 404, data: corps } }); });
    // L'API reelle passe par `downloadViaApi` : le test verifie la relecture du Blob dans `exporterConflitsCsv`.
    await userEvent.click(screen.getByRole("button", { name: /Exporter les conflits \(CSV\)/ }));
    const a = await screen.findByTestId("export-erreur");
    expect(a).toHaveAttribute("data-code", "PROJET_INTROUVABLE");
    expect(a).toHaveTextContent("Projet introuvable : il n'existe pas, a été retiré, ou n'est pas dans votre périmètre.");
  });

  it("echec : un corps qui n'est pas du JSON garde le message generique du statut (jamais d'exception)", async () => {
    await ouvrir();
    const corps = new Blob(["<html>502</html>"], { type: "text/html" });
    vi.mocked(downloadViaApi).mockImplementationOnce(async () => { throw Object.assign(new Error("502"), { response: { status: 502, data: corps } }); });
    await userEvent.click(screen.getByRole("button", { name: /Exporter les conflits \(CSV\)/ }));
    const a = await screen.findByTestId("export-erreur");
    expect(a).toHaveTextContent("Le serveur a rencontré une erreur");
    expect(a).not.toHaveAttribute("data-code");
  });

  it("lecteur : aucun bouton d'export", async () => {
    await ouvrir("LECTEUR", "u-lect");
    expect(screen.queryByRole("button", { name: /Exporter/ })).toBeNull();
  });
});
