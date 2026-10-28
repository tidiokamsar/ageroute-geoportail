import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";
import { controle, ETAPES_SANS_CIRCUIT, lotDetail, lotListe, reponseApercu } from "../components/imports/lotsDeTest";
import type { Etape, LotDetail, LotListe } from "../components/imports/types";

/**
 * Page « Lots d'import » : ce que ces tests défendent (API simulée par `vi.mock("../lib/api")`, serveur en mémoire).
 *
 * - Le parcours de l'annexe A du cahier, côté client : réception, lot sélectionné, étapes qui REFLÈTENT le serveur,
 *   détail, et aucun texte de réussite d'import (rien n'est importé).
 * - La liste distingue chargement, vide, vide filtré et ERREUR (dont 403) ; une erreur n'est jamais un vide.
 * - Les filtres et le lot vivent dans l'adresse : ils survivent à la sélection et au rechargement.
 * - Un fichier déjà reçu, un lot rejeté, un refus 400, une réponse perdue : chacun est dit pour ce qu'il est.
 * - Aucune action d'import, d'approbation ou d'autorisation n'existe sur l'écran.
 */

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), download: vi.fn() }));

vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post } }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: h.download }));

import { ImportsPage, DELAI_FRAPPE_MS } from "./ImportsPage";
import { toast } from "../lib/toast";
import { MESSAGE_LOT_INCONNU } from "./imports/useLotsImport";

// ---------------------------------------------------------------------------------------------------
// Serveur simulé
// ---------------------------------------------------------------------------------------------------

const META = {
  formats: [
    { code: "csv", libelle: "CSV pivot", aide: "Séparateur point-virgule, première ligne = en-tête, UTF-8." },
    { code: "geojson", libelle: "GeoJSON pivot", aide: "FeatureCollection en WGS 84." },
  ],
  tailleMaxOctets: 50 * 1024 * 1024,
  limiteLignes: 100000,
  statuts: ["RECU", "VALIDE_SCHEMA", "IMPORTE_TEST", "IMPORTE", "REJETE"],
};

// Contrat : pour un lot REJETE, echantillon et import_autorise sont NON_COMMENCEE (pas NON_DISPONIBLE).
const ETAPES_REJETE: Etape[] = [
  { id: "reception", titre: "Réception du fichier", etat: "TERMINEE", raison: "Fichier reçu et empreinte calculée." },
  { id: "controle_schema", titre: "Contrôle du schéma", etat: "ECHEC", raison: "Le fichier n'est pas conforme au contrat." },
  { id: "echantillon", titre: "Échantillon à valider", etat: "NON_COMMENCEE", raison: "Aucun circuit d'approbation n'existe encore." },
  { id: "import_autorise", titre: "Import autorisé", etat: "NON_COMMENCEE", raison: "L'écriture au référentiel n'a pas de circuit." },
];

interface Serveur {
  lots: LotListe[];
  surcharges: Record<string, Partial<LotDetail>>;
  meta: unknown;
  sources: { valeur: string; nombreLots: number }[];
  /** Erreurs à lever, dans l'ordre, à la prochaine requête de chaque route. */
  echecs: { liste: unknown[]; meta: unknown[]; detail: unknown[]; sources: unknown[] };
}

let serveur: Serveur;

function detailDe(lot: LotListe, over: Partial<LotDetail> = {}): LotDetail {
  const { motifRejetLot, ...reste } = lot;
  const rejete = lot.statut === "REJETE";
  return lotDetail({
    ...reste,
    controle: controle(rejete ? { motifRejetLot, compteurs: { lues: 0, validees: 0, rejetees: 0, enConflit: 0, ignorees: 0, importees: 0 }, premiersRejets: [], colonnes: null } : {}),
    etapes: rejete ? ETAPES_REJETE : ETAPES_SANS_CIRCUIT,
    ...over,
  });
}

function reponseSource() {
  const parNom = new Map<string, number>();
  for (const l of serveur.lots) parNom.set(l.systemeSource, (parNom.get(l.systemeSource) ?? 0) + 1);
  return [...parNom].map(([valeur, nombreLots]) => ({ valeur, nombreLots }));
}

function leverSiEchec(route: keyof Serveur["echecs"]) {
  const e = serveur.echecs[route].shift();
  if (e !== undefined) throw e;
}

async function simulerGet(url: string, config?: { params?: Record<string, string | number> }) {
  const p = config?.params ?? {};
  if (url === "/v2/imports/meta") { leverSiEchec("meta"); return { data: serveur.meta }; }
  if (url === "/v2/imports/sources") { leverSiEchec("sources"); return { data: { sources: serveur.sources.length > 0 ? serveur.sources : reponseSource() } }; }
  if (url === "/v2/imports") {
    leverSiEchec("liste");
    const q = typeof p.q === "string" ? p.q.toLowerCase() : "";
    const filtres = serveur.lots.filter((l) => (!p.statut || l.statut === p.statut) && (!p.source || l.systemeSource === p.source)
      && (q === "" || [l.reference, l.nomFichier, l.systemeSource].some((t) => t.toLowerCase().includes(q))));
    const debut = p.curseur ? Number(p.curseur) : 0;
    const limite = Number(p.limite ?? 25);
    return { data: { lots: filtres.slice(debut, debut + limite), suivant: debut + limite < filtres.length ? String(debut + limite) : null, total: filtres.length } };
  }
  const apercu = /^\/v2\/imports\/([^/]+)\/apercu$/.exec(url);
  if (apercu) return { data: reponseApercu() };
  const un = /^\/v2\/imports\/([^/]+)$/.exec(url);
  if (un) {
    leverSiEchec("detail");
    const id = decodeURIComponent(un[1]);
    const lot = serveur.lots.find((l) => l.id === id);
    if (!lot) throw { response: { status: 404, data: { error: "lot introuvable" } } };
    return { data: detailDe(lot, serveur.surcharges[id]) };
  }
  throw new Error(`Route non simulée : ${url}`);
}

const appelsListe = () => h.get.mock.calls.filter(([url]) => url === "/v2/imports");
const paramsListe = () => appelsListe().map(([, config]) => (config as { params: Record<string, unknown> }).params);

function lot(n: number, over: Partial<LotListe> = {}): LotListe {
  const rang = String(n).padStart(5, "0");
  return lotListe({ id: `lot-${n}`, reference: `IMP-2026-${rang}`, nomFichier: `releve-${n}.csv`, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockReset(); h.post.mockReset(); h.download.mockReset();
  serveur = { lots: [lot(1)], surcharges: {}, meta: META, sources: [], echecs: { liste: [], meta: [], detail: [], sources: [] } };
  h.get.mockImplementation(simulerGet);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "matchMedia");
});

// ---------------------------------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------------------------------

function Sonde() {
  const l = useLocation();
  return <span data-testid="url" hidden>{`${l.pathname}${l.search}`}</span>;
}

function rendre(entree = "/imports") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utilisateur = userEvent.setup({ applyAccept: false });
  const rendu = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entree]}>
        <ImportsPage />
        <Sonde />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { utilisateur, ...rendu };
}

/** Le message de l'état vide : « Aucun lot reçu. » seul est aussi la phrase du filtre, il ne désigne pas l'état vide. */
const AUCUN_LOT = /Aucun lot reçu\. Sélectionnez un fichier et renseignez les informations obligatoires/;
const lignesListe = () => within(screen.getByRole("region", { name: "Tableau des lots reçus" })).getAllByRole("rowheader");
const urlCourante = () => screen.getByTestId("url").textContent ?? "";
const parametresUrl = () => new URLSearchParams(urlCourante().split("?")[1] ?? "");
const ligneDe = (reference: string) => screen.getByRole("rowheader", { name: reference }).closest("tr") as HTMLElement;
const boutonVoir = (reference: string) => screen.getByRole("button", { name: new RegExp(`Voir le détail du lot ${reference}`) });
const etapesAffichees = () => document.querySelector("ol[data-variante]") as HTMLElement;

/** Écran simulé : le composant lit `matchMedia`, absent de jsdom (sans lui, la page se croit sur grand écran, en tableau). */
function simulerEcran(largeur: number) {
  const evaluer = (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    if (max) return largeur <= Number(max[1]);
    if (min) return largeur >= Number(min[1]);
    return false;
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: evaluer(q), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null }),
  });
}

async function attendreFormulaire() {
  // Le formulaire est remonté quand /meta arrive : on n'écrit dedans qu'une fois les formats connus.
  await screen.findByRole("option", { name: "CSV pivot" });
  return screen.getByRole("form", { name: "Recevoir un lot" });
}

function fichierCsv(nom = "lot.csv") {
  return new File(["systeme_source;type_objet;identifiant_source\nONR_BDR;TRONCON;RN1-001\n"], nom, { type: "text/csv" });
}

async function remplirEtEnvoyer(u: ReturnType<typeof userEvent.setup>, nom = "lot.csv") {
  const form = await attendreFormulaire();
  await u.type(within(form).getByLabelText(/Méthode de la source/), "export L2R");
  await u.type(within(form).getByLabelText(/Référence de l'autorisation écrite/), "AUT-2026-01");
  await u.upload(within(form).getByLabelText(/Fichier à recevoir/), fichierCsv(nom));
  const bouton = within(form).getByRole("button", { name: "Recevoir et contrôler le lot" });
  await waitFor(() => expect(bouton).toBeEnabled());
  await u.click(bouton);
  return form;
}

function reponseReception(l: LotListe, over: Record<string, unknown> = {}) {
  return {
    id: l.id, reference: l.reference, statut: l.statut, dejaRecu: false, motifRejetLot: l.motifRejetLot,
    compteurs: { lues: l.lignesLues, validees: l.lignesValidees, rejetees: l.lignesRejetees, ignorees: l.lignesIgnorees },
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------------

describe("Annexe A : réception d'un fichier valide, de bout en bout côté client", () => {
  it("le lot reçu est sélectionné, les étapes reflètent le serveur, le détail s'ouvre, rien n'est dit « importé »", async () => {
    serveur.lots = [];
    const { utilisateur } = rendre();

    // Avant : aucun lot, indicateur « aucun lot », la première étape n'est jamais « terminée ».
    expect(await screen.findByText(AUCUN_LOT)).toBeInTheDocument();
    expect(etapesAffichees()).toHaveAttribute("data-variante", "aucun-lot");
    expect(within(etapesAffichees()).queryByText("Terminée")).toBeNull();
    expect(screen.getByText(/Recevoir un lot n'est pas importer/)).toBeInTheDocument();

    // Le serveur enregistre le lot et le rend VALIDE_SCHEMA : la page n'en décide pas.
    const recu = lot(7, { statut: "VALIDE_SCHEMA", nomFichier: "lot.csv" });
    h.post.mockImplementation(async () => {
      serveur.lots = [recu];
      return { data: reponseReception(recu) };
    });
    await remplirEtEnvoyer(utilisateur);

    // Un seul multipart, avec les cinq champs et le fichier.
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    const [url, corps] = h.post.mock.calls[0] as [string, FormData];
    expect(url).toBe("/v2/imports");
    expect(corps.get("systemeSource")).toBe("ONR_BDR");
    expect(corps.get("format")).toBe("csv");
    expect(corps.get("methodeSource")).toBe("export L2R");
    expect(corps.get("versionMapping")).toBe("v0");
    expect(corps.get("autorisationRef")).toBe("AUT-2026-01");
    expect((corps.get("fichier") as File).name).toBe("lot.csv");

    // Le lot est sélectionné (adresse), listé, et son détail est montré.
    await waitFor(() => expect(parametresUrl().get("lot")).toBe("lot-7"));
    await waitFor(() => expect(within(ligneDe("IMP-2026-00007")).getByText("Schéma validé : non appliqué")).toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "IMP-2026-00007" })).toBeInTheDocument();

    // Les étapes sont CELLES DU SERVEUR : 3 et 4 non disponibles, avec leur raison ; rien n'est « terminé » par un clic.
    await waitFor(() => expect(etapesAffichees()).toHaveAttribute("data-variante", "lot"));
    const etapes = etapesAffichees();
    expect(etapes.querySelector('[data-etape="echantillon"]')).toHaveAttribute("data-etat", "NON_DISPONIBLE");
    expect(etapes.querySelector('[data-etape="import_autorise"]')).toHaveAttribute("data-etat", "NON_DISPONIBLE");
    expect(within(etapes).getByText("Aucun circuit d'approbation n'existe encore.")).toBeInTheDocument();
    expect(within(etapes).getByText("L'écriture au référentiel n'a pas de circuit.")).toBeInTheDocument();

    // Toast de réception existant, et AUCUN texte de réussite d'import.
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Lot IMP-2026-00007 reçu : 8 ligne\(s\) validée\(s\), 2 rejetée\(s\), 0 ignorée\(s\)\. Rien n'est encore appliqué\.$/));
    expect(screen.queryByText(/importé avec succès|import réussi|lot importé|import terminé/i)).toBeNull();
    expect(document.querySelector('[data-statut="IMPORTE"]')).toBeNull();
  });

  it("le toast de réussite n'est pas émis pour un fichier déjà reçu", async () => {
    const existant = lot(1);
    h.post.mockResolvedValue({ data: reponseReception(existant, { dejaRecu: true }) });
    const { utilisateur } = rendre();
    await remplirEtEnvoyer(utilisateur);
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("La liste : chargement, vide, chargée", () => {
  it("annonce le chargement, puis la liste avec le nombre de lots, les statuts et les compteurs du serveur", async () => {
    serveur.lots = [lot(1), lot(2, { statut: "REJETE", motifRejetLot: "CRS refuse", lignesLues: 0, lignesValidees: 0, lignesRejetees: 0 }), lot(3, { statut: "RECU" })];
    rendre();
    // Pendant le chargement : un état annoncé, ni liste ni « aucun lot ».
    expect(document.querySelector('[data-etat-liste="chargement"]')).not.toBeNull();
    expect(screen.queryByText(AUCUN_LOT)).toBeNull();
    expect(await screen.findByText("IMP-2026-00001")).toBeInTheDocument();
    expect(document.querySelector('[data-etat-liste="chargement"]')).toBeNull();
    expect(screen.getByText("3 lots sur 3")).toBeInTheDocument();
    expect(within(ligneDe("IMP-2026-00001")).getByText("8 conformes, 2 rejetées")).toBeInTheDocument();
    expect(within(ligneDe("IMP-2026-00001")).getByText("Schéma validé : non appliqué")).toBeInTheDocument();
    expect(within(ligneDe("IMP-2026-00002")).getByText("Rejeté")).toBeInTheDocument();
    expect(within(ligneDe("IMP-2026-00003")).getByText("Reçu")).toBeInTheDocument();
    // Aucun lot n'est sélectionné : détail vide sur grand écran, indicateur « aucun lot ».
    expect(screen.getByText("Sélectionnez un lot pour voir ses contrôles.")).toBeInTheDocument();
    expect(etapesAffichees()).toHaveAttribute("data-variante", "aucun-lot");
  });

  it("liste vide sans filtre : le message du cahier, sans bouton « effacer » dans l'état vide", async () => {
    serveur.lots = [];
    rendre();
    const vide = await screen.findByText(AUCUN_LOT);
    const etat = vide.closest("[data-etat-liste]") as HTMLElement;
    expect(etat).toHaveAttribute("data-etat-liste", "vide");
    expect(within(etat).queryByRole("button")).toBeNull();
  });

  it("liste vide avec des filtres : l'état « aucun résultat » propose d'effacer, et effacer rend la liste", async () => {
    serveur.lots = [lot(1)];
    const { utilisateur } = rendre("/imports?statut=REJETE");
    const vide = (await screen.findByText("Aucun résultat pour ces filtres.")).closest("[data-etat-liste]") as HTMLElement;
    expect(vide).toHaveAttribute("data-etat-liste", "aucun-resultat");
    await utilisateur.click(within(vide).getByRole("button", { name: "Effacer les filtres" }));
    expect(await screen.findByText("IMP-2026-00001")).toBeInTheDocument();
    expect(parametresUrl().has("statut")).toBe(false);
    expect(screen.getByLabelText("Statut")).toHaveValue("");
  });
});

describe("Une erreur n'est pas un vide", () => {
  it("erreur de liste : message distinct, aucun « aucun lot », et « Réessayer » recharge", async () => {
    serveur.echecs.liste = [{ response: { status: 500, data: {} } }];
    const { utilisateur } = rendre();
    const alerte = await screen.findByRole("alert");
    expect(within(alerte).getByText("La liste des lots n'a pas pu être chargée.")).toBeInTheDocument();
    expect(alerte).toHaveAttribute("data-etat-liste", "erreur");
    expect(screen.queryByText(AUCUN_LOT)).toBeNull();
    expect(screen.queryByText("Aucun résultat pour ces filtres.")).toBeNull();

    await utilisateur.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("IMP-2026-00001")).toBeInTheDocument();
    expect(document.querySelector('[data-etat-liste="erreur"]')).toBeNull();
    expect(appelsListe()).toHaveLength(2);
  });

  it("403 sur la liste : le profil n'a pas le droit, dit comme tel et jamais masqué", async () => {
    serveur.echecs.liste = [{ response: { status: 403, data: { error: "Accès refusé" } } }];
    rendre();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveAttribute("data-etat-liste", "erreur-droits");
    expect(within(alerte).getByText("Votre profil ne permet pas de consulter les lots d'import.")).toBeInTheDocument();
    expect(screen.queryByText(AUCUN_LOT)).toBeNull();
  });

  it("réponse de liste inattendue : une erreur, pas une liste vide", async () => {
    h.get.mockImplementation(async (url: string, config?: { params?: Record<string, string | number> }) => (url === "/v2/imports" ? { data: {} } : simulerGet(url, config)));
    rendre();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveAttribute("data-etat-liste", "erreur");
    expect(screen.queryByText(AUCUN_LOT)).toBeNull();
  });

  it("/meta en erreur : le formulaire est inactif avec sa raison, aucun format n'est inventé, et « Recharger » le réactive", async () => {
    serveur.echecs.meta = [{ response: { status: 503, data: {} } }];
    const { utilisateur } = rendre();
    const alerte = await screen.findByText("Les formats et plafonds du serveur n'ont pas pu être chargés.");
    const bloc = alerte.closest('[role="alert"]') as HTMLElement;
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    expect(within(form).getByRole("button", { name: "Recevoir et contrôler le lot" })).toBeDisabled();
    expect(within(form).getByText(/La réception est indisponible tant que les formats pris en charge/)).toBeInTheDocument();
    expect(within(form).queryByRole("option", { name: /CSV|GeoJSON/ })).toBeNull();
    expect(within(form).getByLabelText(/Méthode de la source/)).toBeDisabled();

    await utilisateur.click(within(bloc).getByRole("button", { name: "Recharger les formats" }));
    expect(await screen.findByRole("option", { name: "CSV pivot" })).toBeInTheDocument();
    expect(screen.queryByText("Les formats et plafonds du serveur n'ont pas pu être chargés.")).toBeNull();
    expect(within(screen.getByRole("form", { name: "Recevoir un lot" })).getByLabelText(/Méthode de la source/)).toBeEnabled();
  });

  it("/meta qui n'a pas encore répondu : le formulaire attend, sans rien annoncer d'erreur", async () => {
    let repondre!: () => void;
    h.get.mockImplementation(async (url: string, config?: { params?: Record<string, string | number> }) => {
      if (url === "/v2/imports/meta") await new Promise<void>((r) => { repondre = r; });
      return simulerGet(url, config);
    });
    rendre();
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    expect(within(form).getByRole("button", { name: "Recevoir et contrôler le lot" })).toBeDisabled();
    expect(within(form).getByText(/Chargement des formats pris en charge/)).toBeInTheDocument();
    expect(screen.queryByText("Les formats et plafonds du serveur n'ont pas pu être chargés.")).toBeNull();
    await act(async () => { repondre(); });
    expect(await screen.findByRole("option", { name: "CSV pivot" })).toBeInTheDocument();
  });

  it("sources en erreur : la saisie reste libre, la page le dit et propose de réessayer", async () => {
    serveur.echecs.sources = [{ response: { status: 500, data: {} } }];
    const { utilisateur } = rendre();
    const note = await screen.findByText(/Les sources déjà reçues n'ont pas pu être chargées/);
    expect(screen.getByLabelText(/Système source/)).toBeEnabled();
    await utilisateur.click(within(note.closest("div") as HTMLElement).getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(screen.queryByText(/Les sources déjà reçues n'ont pas pu être chargées/)).toBeNull());
  });
});

describe("Filtres et lot sélectionné : portés par l'adresse", () => {
  beforeEach(() => {
    serveur.lots = [
      lot(1, { statut: "REJETE", motifRejetLot: "CRS refuse", systemeSource: "ONR_BDR" }),
      lot(2, { statut: "VALIDE_SCHEMA", systemeSource: "ANASUR" }),
      lot(3, { statut: "REJETE", systemeSource: "ANASUR" }),
    ];
  });

  it("sélectionner un lot ne réinitialise pas les filtres ; recharger la page retrouve le même contexte", async () => {
    const { utilisateur, unmount } = rendre("/imports?statut=REJETE");
    await screen.findByText("IMP-2026-00001");
    expect(screen.queryByText("IMP-2026-00002")).toBeNull();
    expect(screen.getByText("2 lots sur 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Statut")).toHaveValue("REJETE");

    await utilisateur.click(boutonVoir("IMP-2026-00003"));
    await screen.findByRole("heading", { name: "IMP-2026-00003" });
    expect(parametresUrl().get("statut")).toBe("REJETE");
    expect(parametresUrl().get("lot")).toBe("lot-3");
    expect(screen.getByLabelText("Statut")).toHaveValue("REJETE");
    expect(screen.queryByText("IMP-2026-00002")).toBeNull();

    // « Recharger la page » : on rend de nouveau, avec l'adresse telle qu'elle est.
    const adresse = urlCourante();
    unmount();
    rendre(adresse);
    await screen.findByRole("heading", { name: "IMP-2026-00003" });
    expect(screen.getByLabelText("Statut")).toHaveValue("REJETE");
    expect(screen.getByText("2 lots sur 2")).toBeInTheDocument();
    expect(ligneDe("IMP-2026-00003")).toHaveAttribute("aria-current", "true");
  });

  it("changer de statut ou de source interroge le serveur et s'écrit dans l'adresse", async () => {
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00002");
    await utilisateur.selectOptions(screen.getByLabelText("Source"), "ANASUR");
    await waitFor(() => expect(screen.queryByText("IMP-2026-00001")).toBeNull());
    expect(parametresUrl().get("source")).toBe("ANASUR");
    expect(screen.getByText("2 lots correspondant aux filtres.")).toBeInTheDocument();
    await utilisateur.selectOptions(screen.getByLabelText("Statut"), "VALIDE_SCHEMA");
    await waitFor(() => expect(screen.queryByText("IMP-2026-00003")).toBeNull());
    expect(parametresUrl().get("statut")).toBe("VALIDE_SCHEMA");
    expect(parametresUrl().get("source")).toBe("ANASUR");
    expect(paramsListe().at(-1)).toMatchObject({ statut: "VALIDE_SCHEMA", source: "ANASUR" });
  });

  it("la recherche texte attend un délai sans frappe : une seule requête avec le texte complet", async () => {
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    const avant = appelsListe().length;
    await utilisateur.type(screen.getByLabelText("Rechercher"), "00003");
    // Le champ montre tout de suite ce qui est tapé ; le serveur n'a encore rien reçu.
    expect(screen.getByLabelText("Rechercher")).toHaveValue("00003");
    expect(appelsListe()).toHaveLength(avant);
    await waitFor(() => expect(paramsListe().at(-1)).toMatchObject({ q: "00003" }), { timeout: DELAI_FRAPPE_MS * 6 });
    // Une requête de plus, pas une par touche.
    expect(appelsListe()).toHaveLength(avant + 1);
    expect(paramsListe().filter((p) => "q" in p)).toHaveLength(1);
    await waitFor(() => expect(parametresUrl().get("q")).toBe("00003"));
    await waitFor(() => expect(screen.queryByText("IMP-2026-00001")).toBeNull());
    expect(screen.getByText("IMP-2026-00003")).toBeInTheDocument();
  });

  it("le retour arrière rend au champ de recherche la valeur de l'adresse", async () => {
    const { utilisateur } = rendre("/imports?q=00002");
    await screen.findByText("IMP-2026-00002");
    expect(screen.getByLabelText("Rechercher")).toHaveValue("00002");
    await utilisateur.click(screen.getByRole("button", { name: "Effacer les filtres" }));
    await waitFor(() => expect(screen.getByLabelText("Rechercher")).toHaveValue(""));
    expect(parametresUrl().has("q")).toBe(false);
    expect(await screen.findByText("IMP-2026-00001")).toBeInTheDocument();
  });

  it("un lot sélectionné qui ne correspond pas aux filtres est dit, avec de quoi effacer", async () => {
    const { utilisateur } = rendre("/imports?statut=REJETE&lot=lot-2");
    await screen.findByText("IMP-2026-00001");
    const note = await screen.findByText(/Le lot sélectionné ne correspond pas aux filtres actuels/);
    // Le détail du lot reste montré : il ne dépend pas des filtres.
    expect(await screen.findByRole("heading", { name: "IMP-2026-00002" })).toBeInTheDocument();
    await utilisateur.click(within(note.closest("div") as HTMLElement).getByRole("button", { name: "Effacer les filtres" }));
    await waitFor(() => expect(screen.queryByText(/Le lot sélectionné ne correspond pas/)).toBeNull());
    expect(parametresUrl().get("lot")).toBe("lot-2");
  });

  it("un statut inventé dans l'adresse est ignoré, le reste est conservé", async () => {
    rendre("/imports?statut=VALIDE&source=ANASUR");
    await screen.findByText("IMP-2026-00002");
    expect(paramsListe()[0]).toEqual({ limite: 25, source: "ANASUR" });
  });
});

describe("Détail du lot", () => {
  it("un lot inconnu dans l'adresse donne une erreur de détail claire, la liste reste utilisable", async () => {
    const { utilisateur } = rendre("/imports?lot=inconnu");
    const bloc = await screen.findByRole("alert");
    expect(within(bloc).getByText("Le détail du lot n'a pas pu être chargé.")).toBeInTheDocument();
    expect(within(bloc).getByText(MESSAGE_LOT_INCONNU)).toBeInTheDocument();
    expect(await screen.findByText("IMP-2026-00001")).toBeInTheDocument();
    // L'indicateur ne décrit aucun lot, et le dit.
    expect(etapesAffichees()).toHaveAttribute("data-variante", "aucun-lot");
    expect(screen.getByText(/Les étapes du lot sélectionné n'ont pas pu être chargées/)).toBeInTheDocument();
    // On peut passer à un lot qui existe.
    await utilisateur.click(boutonVoir("IMP-2026-00001"));
    expect(await screen.findByRole("heading", { name: "IMP-2026-00001" })).toBeInTheDocument();
    expect(screen.queryByText(MESSAGE_LOT_INCONNU)).toBeNull();
  });

  it("erreur de détail (500) : distincte du vide, avec « Réessayer »", async () => {
    serveur.echecs.detail = [{ response: { status: 500, data: {} } }];
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    await utilisateur.click(boutonVoir("IMP-2026-00001"));
    const alerte = await screen.findByRole("alert");
    expect(within(alerte).getByText("Le détail du lot n'a pas pu être chargé.")).toBeInTheDocument();
    expect(screen.queryByText("Sélectionnez un lot pour voir ses contrôles.")).toBeNull();
    await utilisateur.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("heading", { name: "IMP-2026-00001" })).toBeInTheDocument();
    expect(screen.queryByText("Le détail du lot n'a pas pu être chargé.")).toBeNull();
  });

  it("403 sur le détail : dit que le profil n'a pas le droit", async () => {
    serveur.echecs.detail = [{ response: { status: 403, data: {} } }];
    rendre("/imports?lot=lot-1");
    expect(await screen.findByText("Votre profil ne permet pas de consulter ce lot.")).toBeInTheDocument();
  });

  it("un lot rejeté montre son motif et ses étapes (contrôle en échec, 3 et 4 non commencées)", async () => {
    serveur.lots = [lot(2, { statut: "REJETE", motifRejetLot: "GeoJSON : CRS EPSG:32628 refusé, le pivot impose 4326", lignesLues: 0, lignesValidees: 0, lignesRejetees: 0 })];
    const { utilisateur } = rendre();
    await utilisateur.click(await screen.findByRole("button", { name: /Voir le détail du lot IMP-2026-00002/ }));
    await screen.findByRole("heading", { name: "IMP-2026-00002" });
    expect(await screen.findAllByText(/CRS EPSG:32628 refusé/)).not.toHaveLength(0);
    await waitFor(() => expect(etapesAffichees().querySelector('[data-etape="controle_schema"]')).toHaveAttribute("data-etat", "ECHEC"));
    expect(etapesAffichees().querySelector('[data-etape="import_autorise"]')).toHaveAttribute("data-etat", "NON_COMMENCEE");
    expect(within(screen.getByRole("region", { name: "IMP-2026-00002" })).getAllByText("Rejeté").length).toBeGreaterThan(0);
  });

  it("le même badge de statut sert à la liste et au détail", async () => {
    serveur.lots = [lot(1)];
    const { utilisateur } = rendre();
    await utilisateur.click(await screen.findByRole("button", { name: /Voir le détail du lot IMP-2026-00001/ }));
    const region = await screen.findByRole("region", { name: "IMP-2026-00001" });
    const badges = [...document.querySelectorAll('[data-statut="VALIDE_SCHEMA"]')];
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(within(region).getByText("Schéma validé : non appliqué").closest("[data-statut]")).toHaveAttribute("data-ton", "attention");
  });
});

describe("Télécharger les erreurs", () => {
  it("passe par l'API authentifiée, avec le nom du lot", async () => {
    h.download.mockResolvedValue(undefined);
    const { utilisateur } = rendre("/imports?lot=lot-1");
    await utilisateur.click(await screen.findByRole("button", { name: "Télécharger le rapport des erreurs" }));
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(h.download).toHaveBeenCalledWith("/v2/imports/lot-1/erreurs.csv", "IMP-2026-00001-erreurs.csv");
  });

  it("un échec de téléchargement est annoncé, sans rien casser", async () => {
    h.download.mockRejectedValue(new Error("boom"));
    const { utilisateur } = rendre("/imports?lot=lot-1");
    await utilisateur.click(await screen.findByRole("button", { name: "Télécharger le rapport des erreurs" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Téléchargement impossible."));
    expect(screen.getByRole("button", { name: "Télécharger le rapport des erreurs" })).toBeInTheDocument();
  });

  it("l'action refusée par le serveur reste refusée, avec sa raison, et n'appelle rien", async () => {
    serveur.surcharges["lot-1"] = { actionsPermises: [{ code: "TELECHARGER_ERREURS", permise: false, raison: "Aucune ligne rejetée ou ignorée." }, { code: "VOIR_APERCU", permise: true, raison: null }] };
    const { utilisateur } = rendre("/imports?lot=lot-1");
    const bouton = await screen.findByRole("button", { name: "Télécharger le rapport des erreurs" });
    expect(screen.getByText("Aucune ligne rejetée ou ignorée.")).toBeInTheDocument();
    await utilisateur.click(bouton);
    expect(h.download).not.toHaveBeenCalled();
  });
});

describe("Pagination par curseur", () => {
  it("« Charger plus de lots » ajoute la page suivante ; « N lots sur M » vient du serveur", async () => {
    serveur.lots = Array.from({ length: 30 }, (_, i) => lot(i + 1));
    const { utilisateur } = rendre();
    expect(await screen.findByText("25 lots sur 30")).toBeInTheDocument();
    expect(screen.queryByText("IMP-2026-00030")).toBeNull();
    await utilisateur.click(screen.getByRole("button", { name: "Charger plus de lots" }));
    expect(await screen.findByText("30 lots sur 30")).toBeInTheDocument();
    expect(screen.getByText("IMP-2026-00030")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Charger plus de lots" })).toBeNull();
    expect(paramsListe()[1]).toMatchObject({ curseur: "25" });
    // Aucun lot en double.
    expect(lignesListe()).toHaveLength(30);
  });

  it("la page suivante en échec est dite, les lots déjà affichés restent, et le bouton permet de réessayer", async () => {
    serveur.lots = Array.from({ length: 30 }, (_, i) => lot(i + 1));
    const { utilisateur } = rendre();
    await screen.findByText("25 lots sur 30");
    serveur.echecs.liste = [{ response: { status: 500, data: {} } }];
    await utilisateur.click(screen.getByRole("button", { name: "Charger plus de lots" }));
    expect(await screen.findByText(/Les lots suivants n'ont pas pu être chargés/)).toBeInTheDocument();
    expect(screen.getByText("IMP-2026-00001")).toBeInTheDocument();
    await utilisateur.click(screen.getByRole("button", { name: "Charger plus de lots" }));
    expect(await screen.findByText("30 lots sur 30")).toBeInTheDocument();
    expect(screen.queryByText(/Les lots suivants n'ont pas pu être chargés/)).toBeNull();
  });
});

describe("Réception : chaque issue est dite pour ce qu'elle est", () => {
  it("un fichier déjà reçu : message, toast d'information, lot existant sélectionné, aucun doublon", async () => {
    const existant = lot(1);
    h.post.mockResolvedValue({ data: reponseReception(existant, { dejaRecu: true }) });
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    await remplirEtEnvoyer(utilisateur);
    const resultat = await screen.findByTestId("resultat-reception");
    expect(within(resultat).getByText("Ce fichier avait déjà été reçu : rien n'a été écrit.")).toBeInTheDocument();
    await waitFor(() => expect(parametresUrl().get("lot")).toBe("lot-1"));
    expect(await screen.findByRole("heading", { name: "IMP-2026-00001" })).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith("Fichier déjà reçu : lot IMP-2026-00001. Rien n'a été écrit.");
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(lignesListe()).toHaveLength(1));
  });

  it("un lot rejeté est un résultat : toast d'erreur avec le motif, lot sélectionné, motif dans le détail", async () => {
    const rejete = lot(5, { statut: "REJETE", motifRejetLot: "CSV : colonne obligatoire absente de l'en-tête : type_objet", lignesLues: 0, lignesValidees: 0, lignesRejetees: 0 });
    h.post.mockImplementation(async () => { serveur.lots = [rejete, ...serveur.lots]; return { data: reponseReception(rejete) }; });
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    await remplirEtEnvoyer(utilisateur);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Lot IMP-2026-00005 rejeté : CSV : colonne obligatoire absente de l'en-tête : type_objet."));
    const resultat = await screen.findByTestId("resultat-reception");
    expect(within(resultat).getByText("Lot rejeté par le contrôle : c'est un résultat, pas une panne.")).toBeInTheDocument();
    await waitFor(() => expect(parametresUrl().get("lot")).toBe("lot-5"));
    expect((await screen.findAllByText(/colonne obligatoire absente de l'en-tête : type_objet/)).length).toBeGreaterThan(1);
    expect(await screen.findByRole("heading", { name: "IMP-2026-00005" })).toBeInTheDocument();
  });

  it("un refus 400 avec code : message du code près du champ, toast avec le texte du serveur, aucun lot sélectionné", async () => {
    h.post.mockRejectedValue({ response: { status: 400, data: { error: "fichier trop gros, maximum 52428800 octets", code: "FICHIER_TROP_GROS" } } });
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    const form = await remplirEtEnvoyer(utilisateur);
    expect(await within(form).findByText("Le serveur a refusé la réception. Rien n'a été enregistré.")).toBeInTheDocument();
    expect(within(form).getAllByText(/dépasse la taille maximale acceptée par le serveur/).length).toBeGreaterThan(0);
    expect(toast.error).toHaveBeenCalledWith("fichier trop gros, maximum 52428800 octets");
    expect(parametresUrl().has("lot")).toBe(false);
    // Rien n'est perdu : informations et fichier restent.
    expect(within(form).getByLabelText(/Méthode de la source/)).toHaveValue("export L2R");
    expect(within(form).getByText("Retirer le fichier")).toBeInTheDocument();
  });

  it("un refus sans texte du serveur garde l'ancien toast « Réception refusée. »", async () => {
    h.post.mockRejectedValue({ response: { status: 400, data: { code: "FICHIER_VIDE" } } });
    const { utilisateur } = rendre();
    await remplirEtEnvoyer(utilisateur);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Réception refusée."));
  });

  it("réponse perdue puis nouvelle tentative : la liste est rechargée, un seul lot, jamais deux envois à la fois", async () => {
    serveur.lots = [];
    const { utilisateur } = rendre();
    await screen.findByText(AUCUN_LOT);
    const recu = lot(9, { nomFichier: "lot.csv" });
    // 1er envoi : le serveur ENREGISTRE le lot, mais la réponse se perd.
    h.post.mockImplementationOnce(async () => { serveur.lots = [recu]; throw new Error("Network Error"); });
    const avant = appelsListe().length;
    const form = await remplirEtEnvoyer(utilisateur);

    expect(await within(form).findByText("La réception n'a pas pu être confirmée.")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/n'a pas pu être confirmée/));
    // La liste est rechargée SANS rien supposer : le lot est là, une seule fois, et rien n'est sélectionné.
    expect(await screen.findByText("IMP-2026-00009")).toBeInTheDocument();
    expect(appelsListe().length).toBeGreaterThan(avant);
    expect(lignesListe()).toHaveLength(1);
    expect(parametresUrl().has("lot")).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();

    // 2e envoi, suspendu : un second clic pendant l'attente ne part pas.
    let terminer!: () => void;
    h.post.mockImplementationOnce(() => new Promise((resoudre) => { terminer = () => resoudre({ data: reponseReception(recu, { dejaRecu: true }) }); }));
    const bouton = within(form).getByRole("button", { name: "Recevoir et contrôler le lot" });
    await waitFor(() => expect(bouton).toBeEnabled());
    await utilisateur.click(bouton);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    expect(bouton).toBeDisabled();
    await utilisateur.click(bouton);
    expect(h.post).toHaveBeenCalledTimes(2);
    await act(async () => { terminer(); });

    // Le serveur reconnaît le fichier : lot existant, toujours une seule ligne.
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Fichier déjà reçu : lot IMP-2026-00009. Rien n'a été écrit."));
    await waitFor(() => expect(parametresUrl().get("lot")).toBe("lot-9"));
    expect(lignesListe()).toHaveLength(1);
  });

  it("une réception réussie ne réinitialise pas les filtres ; le lot reçu est montré même s'il n'est pas dans la liste filtrée", async () => {
    const recu = lot(4, { statut: "VALIDE_SCHEMA" });
    h.post.mockImplementation(async () => { serveur.lots = [recu, ...serveur.lots]; return { data: reponseReception(recu) }; });
    serveur.lots = [lot(1, { statut: "REJETE", motifRejetLot: "x" })];
    const { utilisateur } = rendre("/imports?statut=REJETE");
    await screen.findByText("IMP-2026-00001");
    await remplirEtEnvoyer(utilisateur);
    await waitFor(() => expect(parametresUrl().get("lot")).toBe("lot-4"));
    expect(parametresUrl().get("statut")).toBe("REJETE");
    expect(await screen.findByRole("heading", { name: "IMP-2026-00004" })).toBeInTheDocument();
    expect(await screen.findByText(/Le lot sélectionné ne correspond pas aux filtres actuels/)).toBeInTheDocument();
  });
});

describe("Aucune action d'import, d'approbation ou d'autorisation", () => {
  it("ni bouton ni lien de ce genre, avec ou sans lot sélectionné, lot rejeté ou non", async () => {
    serveur.lots = [lot(1), lot(2, { statut: "REJETE", motifRejetLot: "CRS refusé" })];
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    const interdit = /approuv|autoris(?!ation écrite)|appliquer|valider l'échantillon|lancer l'import|importer|publier|écrire (dans|au)|confirmer l'import/i;
    const verifier = () => {
      const actions = [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")];
      const noms = actions.map((a) => a.getAttribute("aria-label") ?? a.textContent ?? "");
      for (const nom of noms) expect(nom, `action inattendue : « ${nom} »`).not.toMatch(interdit);
      expect(noms.length).toBeGreaterThan(3);
    };
    verifier();
    await utilisateur.click(boutonVoir("IMP-2026-00001"));
    await screen.findByRole("heading", { name: "IMP-2026-00001" });
    verifier();
    // Les étapes 3 et 4 le disent, avec la raison du serveur.
    await waitFor(() => expect(etapesAffichees().querySelector('[data-etape="echantillon"]')).toHaveAttribute("data-etat", "NON_DISPONIBLE"));
    expect(within(etapesAffichees()).getAllByText("Non disponible")).toHaveLength(2);
    await utilisateur.click(boutonVoir("IMP-2026-00002"));
    await screen.findByRole("heading", { name: "IMP-2026-00002" });
    verifier();
    // L'indicateur lui-même ne contient ni bouton ni lien.
    expect(within(etapesAffichees()).queryByRole("button")).toBeNull();
    expect(within(etapesAffichees()).queryByRole("link")).toBeNull();
  });
});

describe("Écran étroit : le détail s'ouvre sous la liste, le focus l'accompagne", () => {
  it("cartes au lieu du tableau ; le détail n'existe qu'une fois un lot choisi, reçoit le focus, et « Fermer » rend le focus au lot", async () => {
    simulerEcran(375);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    serveur.lots = [lot(1), lot(2)];
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    expect(screen.getByRole("list", { name: "Lots d'import reçus" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    // Sans lot choisi, pas de panneau vide sous la liste.
    expect(screen.queryByText("Sélectionnez un lot pour voir ses contrôles.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Aller au détail du lot sélectionné" })).toBeNull();

    const voir = boutonVoir("IMP-2026-00002");
    await utilisateur.click(voir);
    const region = await screen.findByRole("region", { name: "IMP-2026-00002" });
    const titre = within(region).getByRole("heading", { name: "IMP-2026-00002" });
    await waitFor(() => expect(titre).toHaveFocus());
    expect(scroll).toHaveBeenCalled();

    // Le détail est APRES la liste dans l'ordre du document (empilé), pas à côté.
    const liste = screen.getByRole("list", { name: "Lots d'import reçus" });
    expect(liste.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await utilisateur.click(within(region).getByRole("button", { name: "Fermer le détail" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "IMP-2026-00002" })).toBeNull());
    expect(boutonVoir("IMP-2026-00002")).toHaveFocus();
    expect(parametresUrl().has("lot")).toBe(false);
    // Le filtre ne bouge pas, ici aucun.
    expect(screen.getByText("IMP-2026-00001")).toBeInTheDocument();
  });

  it("un lot déjà ouvert : « Aller au détail » y ramène le focus", async () => {
    simulerEcran(375);
    Element.prototype.scrollIntoView = vi.fn();
    const { utilisateur } = rendre("/imports?lot=lot-1");
    const region = await screen.findByRole("region", { name: "IMP-2026-00001" });
    await utilisateur.click(screen.getByRole("button", { name: "Aller au détail du lot sélectionné" }));
    expect(within(region).getByRole("heading", { name: "IMP-2026-00001" })).toHaveFocus();
  });

  it("à 1280 px (table lisible, mais pas la place d'une 2e colonne) : tableau, détail sous la liste", async () => {
    simulerEcran(1280);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("Sélectionnez un lot pour voir ses contrôles.")).toBeNull();
    await utilisateur.click(boutonVoir("IMP-2026-00001"));
    const region = await screen.findByRole("region", { name: "IMP-2026-00001" });
    await waitFor(() => expect(within(region).getByRole("heading", { name: "IMP-2026-00001" })).toHaveFocus());
    expect(scroll).toHaveBeenCalled();
  });

  it("sur très grand écran (1536 px et plus), le détail est à côté : choisir un lot ne déplace pas le focus", async () => {
    simulerEcran(1600);
    Element.prototype.scrollIntoView = vi.fn();
    const { utilisateur } = rendre();
    await screen.findByText("IMP-2026-00001");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Sélectionnez un lot pour voir ses contrôles.")).toBeInTheDocument();
    const voir = boutonVoir("IMP-2026-00001");
    await utilisateur.click(voir);
    await screen.findByRole("heading", { name: "IMP-2026-00001" });
    expect(voir).toHaveFocus();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("Accessibilité (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("liste chargée avec le détail d'un lot", async () => {
    const { container } = rendre("/imports?lot=lot-1");
    await screen.findByRole("heading", { name: "IMP-2026-00001" });
    await screen.findByText("IMP-2026-00001", { selector: "th" });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("liste vide", async () => {
    serveur.lots = [];
    const { container } = rendre();
    await screen.findByText(AUCUN_LOT);
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("liste en erreur, détail en erreur et formats indisponibles en même temps", async () => {
    serveur.echecs.liste = [{ response: { status: 500, data: {} } }];
    serveur.echecs.meta = [{ response: { status: 500, data: {} } }];
    const { container } = rendre("/imports?lot=inconnu");
    await screen.findByText("La liste des lots n'a pas pu être chargée.");
    await screen.findByText("Les formats et plafonds du serveur n'ont pas pu être chargés.");
    await screen.findByText(MESSAGE_LOT_INCONNU);
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("écran étroit, détail ouvert", async () => {
    simulerEcran(375);
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = rendre("/imports?lot=lot-1");
    await screen.findByRole("region", { name: "IMP-2026-00001" });
    await screen.findByRole("list", { name: "Lots d'import reçus" });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});
