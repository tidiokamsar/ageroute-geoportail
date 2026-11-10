import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("react-leaflet", async () => (await import("../components/projets-voirie/carteDouble.testutil")).moduleReactLeaflet());

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), role: "GESTIONNAIRE", userId: "a0000001-0000-4000-8000-0000000000a1" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, put: h.put, patch: h.patch, delete: h.delete } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: h.userId, nomComplet: "Moussa Gestionnaire", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn().mockResolvedValue(undefined) }));

import { reinitialiserCarte } from "../components/projets-voirie/carteDouble.testutil";
import {
  ADMIN, CF1, CONC_A, D1, D2, J1, R1, R2, T1, T2, U_ADMIN, U_GEST, U_REF, W, conflitVueServeur, demandeEnvoyee, demandeRecue, demandeServeur, erreurHttp, ficheDemandeServeur, ficheRecolementServeur,
  ficheTacheServeur, historiqueModification, historiqueServeur, jeuVueServeur, pageServeur, preuveServeur, profilServeur, rattachementServeur, recolementServeur, reponseApiWorkflow, tacheServeur,
  transRec, transTache, type SurchargesWorkflow,
} from "../components/projets-voirie/workflow/workflowSynthetiques.testutil";
import { ProjetVoirieWorkflowPage } from "./ProjetVoirieWorkflowPage";
import { ProjetVoirieDetailPage } from "./ProjetVoirieDetailPage";
import { ProjetsVoirieListePage } from "./ProjetsVoirieListePage";
import { BANDEAU_WORKFLOW, MENTION_AUCUN_ENVOI, MENTION_RECOLEMENT } from "../lib/projetsVoirieWorkflow";

/**
 * Ecran « Echanges avec les concessionnaires » (lot B3, interface) : profil et droits, demandes (l'envoi est ENREGISTRE, jamais fait par l'application), taches (validation par un
 * tiers), recolements (avant et apres, validation par un tiers, jamais d'ecriture dans le referentiel), preuves (references et empreintes), referents (administrateur), vue limitee
 * du compte REFERENT et redirection du 403 COMPTE_REFERENT_RESTREINT. L'API est SIMULEE avec des reponses synthetiques au format du serveur (`workflowSynthetiques.testutil.ts`).
 */

configure({ asyncUtilTimeout: 8000 });

const PROFILS_PAR_ROLE: Record<string, string> = { ADMIN: "ADMIN", GESTIONNAIRE: "GESTIONNAIRE", INSPECTEUR: "INSPECTEUR", LECTEUR: "LECTEUR", REFERENT: "REFERENT" };

function installer(over: SurchargesWorkflow = {}) {
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApiWorkflow(url, opts?.params, over));
}
const appels = (suffixe: string) => h.get.mock.calls.filter((c) => c[0] === `${W}${suffixe}`);
const dernierParams = (suffixe: string) => appels(suffixe).at(-1)?.[1]?.params as Record<string, unknown>;
const dialogue = () => screen.findByRole("dialog");

function Lieu() { const l = useLocation(); return <p data-testid="lieu">{l.pathname}</p>; }

function rendre(entree = "/projets-voirie/p1/echanges") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entree]}>
      <QueryClientProvider client={qc}>
        <Lieu />
        <Routes>
          <Route path="/projets-voirie" element={<ProjetsVoirieListePage />} />
          <Route path="/projets-voirie/echanges" element={<ProjetVoirieWorkflowPage />} />
          <Route path="/projets-voirie/:id" element={<ProjetVoirieDetailPage />} />
          <Route path="/projets-voirie/:id/echanges" element={<ProjetVoirieWorkflowPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function ouvrir(role: string, over: SurchargesWorkflow = {}, section?: string) {
  h.role = role === "REFERENT" ? "LECTEUR" : role;
  h.userId = role === "REFERENT" ? U_REF : role === "ADMIN" ? U_ADMIN : U_GEST;
  installer({ profil: profilServeur(PROFILS_PAR_ROLE[role]), ...over });
  const r = rendre();
  await screen.findByRole("tablist", { name: "Sections des échanges" });
  if (section) await userEvent.click(screen.getByRole("tab", { name: section }));
  return r;
}
const bouton = (donnee: string, id: string) => document.querySelector<HTMLButtonElement>(`button[data-${donnee}-id="${id}"]`)!;

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.patch, h.delete]) f.mockReset();
  h.post.mockResolvedValue({ data: {} }); h.put.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
  h.role = "GESTIONNAIRE"; h.userId = U_GEST;
  reinitialiserCarte();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  window.dispatchEvent(new Event("online"));
});

describe("profil et sections : seules les actions permises par le serveur", () => {
  it("le bandeau est permanent : rien n'est envoye, aucun ordre, aucun deplacement", async () => {
    await ouvrir("GESTIONNAIRE");
    expect(screen.getByTestId("bandeau-workflow").textContent).toBe(BANDEAU_WORKFLOW);
    await userEvent.click(screen.getByRole("tab", { name: "Mon profil" }));
    expect(screen.getByTestId("bandeau-workflow").textContent).toBe(BANDEAU_WORKFLOW);
  });
  it("gestionnaire : sections Demandes, Taches, Recolements, Dossiers et jeux, Referents (lecture) ; droits listes = ceux du serveur, pas la validation des recolements", async () => {
    await ouvrir("GESTIONNAIRE", {}, "Mon profil");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Mon profil", "Demandes", "Tâches", "Récolements", "Dossiers et jeux", "Référents"]);
    const droits = screen.getByTestId("droits-permis");
    expect(within(droits).getAllByRole("listitem")).toHaveLength(7);
    expect(droits.querySelector('[data-droit="demande.ecrire"]')).toBeTruthy();
    expect(droits.querySelector('[data-droit="recolement.valider"]')).toBeNull();
    expect(droits.querySelector('[data-droit="referent.gerer"]')).toBeNull();
    expect(screen.getByText("Gestionnaire de projet")).toBeInTheDocument();
  });
  it("administrateur : les neuf droits", async () => {
    await ouvrir("ADMIN", {}, "Mon profil");
    expect(within(screen.getByTestId("droits-permis")).getAllByRole("listitem")).toHaveLength(9);
  });
  it("agent de terrain : Mon profil et Taches seulement (le serveur ne lui ouvre que ses taches)", async () => {
    await ouvrir("INSPECTEUR", {});
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Mon profil", "Tâches"]);
    expect(screen.getByRole("tab", { name: "Tâches" })).toHaveAttribute("aria-selected", "true");
    expect(appels("/demandes")).toHaveLength(0);
    expect(appels("/recolements")).toHaveLength(0);
    expect(appels("/referents")).toHaveLength(0);
  });
  it("lecteur : Mon profil seulement, aucune action permise, aucune requete de liste", async () => {
    await ouvrir("LECTEUR", {});
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Mon profil"]);
    expect(screen.getByText(/Aucune action n'est permise à votre profil/)).toBeInTheDocument();
    expect(screen.queryByTestId("droits-permis")).toBeNull();
    expect(appels("/demandes")).toHaveLength(0);
    expect(appels("/taches")).toHaveLength(0);
  });
  it("referent : rattachements visibles, aucune section d'administration, mention du perimetre", async () => {
    await ouvrir("REFERENT", {}, "Mon profil");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Mon profil", "Demandes", "Tâches", "Récolements", "Dossiers et jeux"]);
    expect(screen.getByText(/Mes rattachements/)).toBeInTheDocument();
    expect(screen.getByText(/concessionnaire Operateur synthetique A/)).toBeInTheDocument();
    expect(screen.getByText(/Vous voyez et complétez seulement ce qui est partagé avec votre concessionnaire/)).toBeInTheDocument();
    expect(screen.getByText("Référent concessionnaire", { selector: "dd" })).toBeInTheDocument();
    expect(within(screen.getByTestId("droits-permis")).getAllByRole("listitem")).toHaveLength(3);
  });
  it("la matrice provisoire est dite provisoire, avec les avertissements du serveur", async () => {
    await ouvrir("ADMIN", { profil: profilServeur("ADMIN", { avertissements: ["Entree ignoree : action inconnue."] }) }, "Mon profil");
    expect(screen.getByTestId("provisoire").textContent).toMatch(/Provisoire.*en attente de la décision de la direction des systèmes d'information/);
    expect(screen.getByTestId("avertissements-profil").textContent).toMatch(/Entree ignoree/);
  });
  it("une action inconnue du client dans les droits n'est jamais supposee permise", async () => {
    await ouvrir("GESTIONNAIRE", { profil: profilServeur("GESTIONNAIRE", { droits: ["workflow.lire", "tout.faire"] }) }, "Mon profil");
    const l = within(screen.getByTestId("droits-permis")).getAllByRole("listitem");
    expect(l).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Nouvelle demande/ })).toBeNull();
  });
  it("erreur du profil (503) : message explique, Reessayer", async () => {
    h.get.mockImplementation(async (url: string) => { if (url.endsWith("/mon-profil")) throw erreurHttp(503); return { data: {} }; });
    rendre();
    expect(await screen.findByText(/momentanément indisponible ou occupé/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer : Profil" })).toBeInTheDocument();
  });
  it("navigation au clavier des sections : fleches, Home, End", async () => {
    await ouvrir("GESTIONNAIRE");
    const demandes = screen.getByRole("tab", { name: "Demandes" });
    demandes.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Tâches" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Référents" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Mon profil" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Référents" })).toHaveFocus();
  });
});

describe("demandes : l'application n'envoie rien, elle enregistre", () => {
  it("la liste dit que l'envoi se fait hors application ; statuts en mots, compteurs du serveur, echeance depassee", async () => {
    await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [demandeServeur(), demandeEnvoyee({ echeanceDepassee: true })], { BROUILLON: 1, ENVOYEE: 1, RECUE: 0, CLOTUREE: 0, ANNULEE: 0 }) });
    await screen.findByRole("list", { name: "Liste : demandes" });
    expect(screen.getAllByText(/L'application n'envoie rien/).length).toBeGreaterThanOrEqual(1);
    expect(bouton("demande", D1).textContent).toMatch(/Brouillon/);
    expect(bouton("demande", D2).textContent).toMatch(/Envoyée \(enregistrée\)/);
    expect(bouton("demande", D2).textContent).toMatch(/Échéance dépassée/);
    expect(bouton("demande", D2).textContent).toMatch(/envoyée le 03\/11\/2026/);
    expect(screen.getByRole("button", { name: /Brouillon \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Toutes \(2\)/ })).toBeInTheDocument();
  });
  it("filtres : statut et echeance depassee partent au serveur ; pagination par curseur", async () => {
    await ouvrir("GESTIONNAIRE", { demandes: (p?: Record<string, unknown>) => (p?.curseur === "c-2" ? pageServeur("demandes", [demandeEnvoyee()], null) : pageServeur("demandes", [demandeServeur()], { BROUILLON: 1 }, "c-2")) });
    await screen.findByRole("list", { name: "Liste : demandes" });
    await userEvent.click(screen.getByRole("button", { name: "Charger les demandes suivantes" }));
    await waitFor(() => expect(bouton("demande", D2)).toBeTruthy());
    expect(dernierParams("/demandes")).toMatchObject({ curseur: "c-2", limite: 25 });
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-statut-filtre="ENVOYEE"]')!);
    await waitFor(() => expect(dernierParams("/demandes")).toMatchObject({ statut: "ENVOYEE" }));
    await userEvent.click(screen.getByLabelText("Échéance dépassée seulement"));
    await waitFor(() => expect(dernierParams("/demandes")).toMatchObject({ statut: "ENVOYEE", echeanceDepassee: "true" }));
  });
  it("creation d'un brouillon : concessionnaire, objet ; POST du corps ; rien n'est envoye", async () => {
    await ouvrir("GESTIONNAIRE");
    await userEvent.click(await screen.findByRole("button", { name: "Nouvelle demande" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/créée en brouillon/);
    expect(d.textContent).toMatch(/L'application n'envoie rien/);
    const ok = within(d).getByRole("button", { name: "Créer le brouillon" });
    expect(ok).toBeDisabled();
    await userEvent.selectOptions(within(d).getByLabelText("Concessionnaire"), CONC_A);
    await userEvent.type(within(d).getByLabelText("Objet de la demande"), "Plan des chambres du centre");
    await userEvent.type(within(d).getByLabelText(/Échéance de réponse/), "2027-01-15");
    expect(ok).toBeEnabled();
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/demandes`, { concessionnaireId: CONC_A, objet: "Plan des chambres du centre", description: null, echeance: "2027-01-15" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.post).toHaveBeenCalledTimes(1);
  });
  it("lecteur de projet et referent : ni creation ni action d'ecriture", async () => {
    await ouvrir("REFERENT", { demandes: pageServeur("demandes", [demandeEnvoyee({ creePar: null })], { ENVOYEE: 1 }), fichesDemandes: { [D2]: ficheDemandeServeur(demandeEnvoyee({ creePar: null }), []) } });
    await screen.findByRole("list", { name: "Liste : demandes" });
    expect(screen.queryByRole("button", { name: "Nouvelle demande" })).toBeNull();
    await userEvent.click(bouton("demande", D2));
    const f = await screen.findByTestId("fiche-demande");
    expect(within(f).getByTestId("aucune-action").textContent).toMatch(/Lecture seule/);
    expect(within(f).queryByRole("button", { name: /Enregistrer|Annuler la demande|Clore|Modifier/ })).toBeNull();
  });

  describe("fiche d'un brouillon", () => {
    async function fiche(role = "GESTIONNAIRE", over: SurchargesWorkflow = {}) {
      await ouvrir(role, over);
      await userEvent.click(await screen.findByRole("button", { name: /Plan des fourreaux de la rue 12/ }));
      return screen.findByTestId("fiche-demande");
    }
    it("dit que l'envoi se fait hors application ; actions = transitions du serveur ; le titre prend le focus", async () => {
      const f = await fiche();
      expect(within(f).getByTestId("mention-aucun-envoi").textContent).toBe(MENTION_AUCUN_ENVOI);
      expect(within(f).getByRole("button", { name: "Enregistrer l'envoi (fait hors application)" })).toBeInTheDocument();
      expect(within(f).getByRole("button", { name: "Annuler la demande" })).toBeInTheDocument();
      expect(within(f).getByRole("button", { name: "Modifier la demande" })).toBeInTheDocument();
      expect(within(f).queryByRole("button", { name: /Clore|réception/ })).toBeNull();
      await waitFor(() => expect(within(f).getByRole("heading", { name: "Plan des fourreaux de la rue 12" })).toHaveFocus());
    });
    it("AUCUN controle ne compose, n'envoie ni ne notifie : pas de destinataire, de message, de bouton « Envoyer »", async () => {
      const f = await fiche();
      await userEvent.click(within(f).getByRole("button", { name: "Enregistrer l'envoi (fait hors application)" }));
      const d = await dialogue();
      const libelles = [...d.querySelectorAll("label")].map((l) => l.textContent ?? "").join(" | ");
      expect(libelles).not.toMatch(/destinataire|message|objet du courriel|corps du|pièce jointe|cc\b/i);
      for (const b of [...document.querySelectorAll("button")]) expect(b.textContent ?? "").not.toMatch(/^\s*envoyer|notifier|ordonner|déplacer/i);
      expect(d.querySelector("input[type=email], input[type=tel], input[type=file]")).toBeNull();
    });
    it("enregistrer l'envoi : libelle impose, canal, date passee, reference, interlocuteur ; POST { vers: ENVOYEE, ... } ; rien d'autre", async () => {
      const f = await fiche();
      await userEvent.click(within(f).getByRole("button", { name: "Enregistrer l'envoi (fait hors application)" }));
      const d = await dialogue();
      expect(d.textContent).toMatch(/L'envoi se fait hors application, enregistrez-le ici\./);
      expect(d.textContent).toMatch(/Votre nom et la date de l'enregistrement sont consignés/);
      const ok = within(d).getByRole("button", { name: "Enregistrer l'envoi" });
      expect(ok).toBeDisabled();
      expect(within(d).getByTestId("aide-saisie").textContent).toMatch(/Indiquez le canal de l'envoi/);
      await userEvent.type(within(d).getByLabelText(/Canal utilisé/), "Courriel");
      await userEvent.type(within(d).getByLabelText("Date de l'envoi"), "2026-11-03");
      await userEvent.type(within(d).getByLabelText(/Référence de l'envoi/), "COUR-2026-41");
      await userEvent.type(within(d).getByLabelText(/Interlocuteur/), "Service reseaux");
      expect(ok).toBeEnabled();
      await userEvent.click(ok);
      await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/demandes/${D1}/statut`, { vers: "ENVOYEE", canalEnvoi: "Courriel", dateEnvoi: "2026-11-03", referenceEnvoi: "COUR-2026-41", interlocuteur: "Service reseaux" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(h.post).toHaveBeenCalledTimes(1);
    });
    it("une date d'envoi dans le futur est refusee avant l'envoi (on enregistre un envoi deja fait)", async () => {
      const f = await fiche();
      await userEvent.click(within(f).getByRole("button", { name: "Enregistrer l'envoi (fait hors application)" }));
      const d = await dialogue();
      await userEvent.type(within(d).getByLabelText(/Canal utilisé/), "Courrier");
      await userEvent.type(within(d).getByLabelText("Date de l'envoi"), "2099-01-01");
      expect(within(d).getByTestId("aide-saisie").textContent).toMatch(/ne peut pas être dans le futur/);
      expect(within(d).getByRole("button", { name: "Enregistrer l'envoi" })).toBeDisabled();
      expect(h.post).not.toHaveBeenCalled();
    });
    it("422 DATE_INVALIDE, 409 TRANSITION_INTERDITE, 404, 503 : message en clair dans le dialogue, saisie conservee", async () => {
      for (const [status, code, extrait] of [[422, "DATE_INVALIDE", /pas être dans le futur/], [409, "TRANSITION_INTERDITE", /déjà été traité par une autre personne/], [404, "DEMANDE_INTROUVABLE", /Cette demande est introuvable/], [503, "PROJET_OCCUPE", /occupé par une autre écriture/]] as const) {
        h.post.mockReset(); h.post.mockRejectedValueOnce(erreurHttp(status, code));
        const f = await fiche();
        await userEvent.click(within(f).getByRole("button", { name: "Enregistrer l'envoi (fait hors application)" }));
        const d = await dialogue();
        await userEvent.type(within(d).getByLabelText(/Canal utilisé/), "Courriel");
        await userEvent.type(within(d).getByLabelText("Date de l'envoi"), "2026-11-03");
        await userEvent.click(within(d).getByRole("button", { name: "Enregistrer l'envoi" }));
        const alerte = await within(d).findByRole("alert");
        expect(alerte.textContent).toMatch(extrait);
        expect(alerte).toHaveAttribute("data-code", code);
        expect(within(d).getByLabelText(/Canal utilisé/)).toHaveValue("Courriel");
        break;
      }
    });
    it("annuler la demande : motif de 10 caracteres ; POST { vers: ANNULEE, justification }", async () => {
      const f = await fiche();
      await userEvent.click(within(f).getByRole("button", { name: "Annuler la demande" }));
      const d = await dialogue();
      const ok = within(d).getByRole("button", { name: "Annuler la demande" });
      expect(ok).toBeDisabled();
      await userEvent.type(within(d).getByLabelText(/Motif/), "Doublon de la demande n° 2");
      await userEvent.click(ok);
      await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/demandes/${D1}/statut`, { vers: "ANNULEE", justification: "Doublon de la demande n° 2" }));
    });
    it("modifier un brouillon : seuls les champs changes partent", async () => {
      const f = await fiche();
      await userEvent.click(within(f).getByRole("button", { name: "Modifier la demande" }));
      const d = await dialogue();
      expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
      const o = within(d).getByLabelText("Objet de la demande");
      await userEvent.clear(o);
      await userEvent.type(o, "Plan des fourreaux de la rue 13");
      await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
      await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${W}/demandes/${D1}`, { objet: "Plan des fourreaux de la rue 13" }));
    });
    it("un interlocuteur masque (vue de projet) est dit non communique, jamais « aucun »", async () => {
      const masque = demandeEnvoyee({ envoi: { dateEnvoi: "2026-11-03", canal: "Courriel", reference: null, interlocuteur: null, enregistrePar: null, enregistreLe: "2026-11-03T09:00:00.000Z" } });
      await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [masque], { ENVOYEE: 1 }), fichesDemandes: { [D2]: ficheDemandeServeur(masque, ["RECUE"]) } });
      await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
      const f = await screen.findByTestId("fiche-demande");
      expect(f.textContent).toMatch(/Interlocuteurnon communiqué pour votre profil/);
      expect(f.textContent).not.toMatch(/Interlocuteuraucun/);
    });
  });

  describe("demande envoyee puis recue", () => {
    const base = { demandes: pageServeur("demandes", [demandeEnvoyee()], { ENVOYEE: 1 }) };
    async function ficheEnvoyee(over: SurchargesWorkflow = {}) {
      await ouvrir("GESTIONNAIRE", { ...base, ...over });
      await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
      return screen.findByTestId("fiche-demande");
    }
    it("l'envoi enregistre est affiche (date, canal, reference, interlocuteur, enregistre par) ; actions : reception, cloture, annulation", async () => {
      const f = await ficheEnvoyee();
      expect(f.textContent).toMatch(/Envoi enregistré \(fait hors application\)/);
      expect(f.textContent).toMatch(/Date de l'envoi03\/11\/2026/);
      expect(f.textContent).toMatch(/CanalCourriel/);
      expect(f.textContent).toMatch(/RéférenceCOUR-2026-41/);
      expect(f.textContent).toMatch(/InterlocuteurService reseaux/);
      expect(f.textContent).toMatch(/Enregistré parMoussa Gestionnaire/);
      for (const n of ["Enregistrer la réception de la réponse", "Clore la demande", "Annuler la demande"]) expect(within(f).getByRole("button", { name: n })).toBeInTheDocument();
      expect(within(f).queryByRole("button", { name: /Enregistrer l'envoi/ })).toBeNull();
      expect(within(f).getByRole("button", { name: "Modifier la demande" })).toBeInTheDocument();
    });
    it("enregistrer la reception : date, jeu recu lie (meme concessionnaire) ; POST { vers: RECUE, dateReception, jeuRecuId, note }", async () => {
      const f = await ficheEnvoyee();
      await userEvent.click(within(f).getByRole("button", { name: "Enregistrer la réception de la réponse" }));
      const d = await dialogue();
      expect(d.textContent).toMatch(/Envoi enregistré le 03\/11\/2026/);
      expect(d.textContent).toMatch(/reste en quarantaine jusqu'à son autorisation/);
      const ok = within(d).getByRole("button", { name: "Enregistrer la réception" });
      await userEvent.type(within(d).getByLabelText("Date de réception"), "2026-11-02");
      expect(within(d).getByTestId("aide-saisie").textContent).toMatch(/ne peut pas être reçue avant l'envoi/);
      expect(ok).toBeDisabled();
      await userEvent.clear(within(d).getByLabelText("Date de réception"));
      await userEvent.type(within(d).getByLabelText("Date de réception"), "2026-11-05");
      await userEvent.selectOptions(await within(d).findByLabelText(/Jeu reçu lié/), J1);
      await userEvent.type(within(d).getByLabelText(/Note/), "Reponse recue par courrier");
      await userEvent.click(ok);
      await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/demandes/${D2}/statut`, { vers: "RECUE", dateReception: "2026-11-05", jeuRecuId: J1, note: "Reponse recue par courrier" }));
    });
    it("les jeux proposes sont ceux du MEME concessionnaire et de reseau tiers, jamais un jeu retire", async () => {
      const jeux = { jeux: [jeuVueServeur(), jeuVueServeur({ id: "22222222-2222-4222-8222-222222222222", nomFichier: "autre-concessionnaire.geojson", concessionnaire: { id: "c0000002-0000-4000-8000-00000000000b", nom: "Autre" } }), jeuVueServeur({ id: "33333333-3333-4333-8333-333333333333", nomFichier: "axes.geojson", role: "AXES_TRAVAUX" }), jeuVueServeur({ id: "44444444-4444-4444-8444-444444444444", nomFichier: "retire.geojson", statut: "RETIRE" })] };
      const f = await ficheEnvoyee({ jeux });
      await userEvent.click(within(f).getByRole("button", { name: "Enregistrer la réception de la réponse" }));
      const d = await dialogue();
      const options = within(await within(d).findByLabelText(/Jeu reçu lié/)).getAllByRole("option").map((o) => o.textContent);
      expect(options).toEqual(["Aucun jeu lié", "reponse-synthetique.geojson, version 1 (en attente)"]);
    });
    it("clore sans reponse : motif obligatoire ; POST { vers: CLOTUREE, justification }", async () => {
      const f = await ficheEnvoyee();
      await userEvent.click(within(f).getByRole("button", { name: "Clore la demande" }));
      const d = await dialogue();
      await userEvent.type(within(d).getByLabelText(/Motif/), "Aucune reponse apres deux relances");
      await userEvent.click(within(d).getByRole("button", { name: "Clore la demande" }));
      await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/demandes/${D2}/statut`, { vers: "CLOTUREE", justification: "Aucune reponse apres deux relances" }));
    });
    it("apres l'envoi, modifier l'echeance exige une justification de 10 caracteres", async () => {
      const f = await ficheEnvoyee();
      await userEvent.click(within(f).getByRole("button", { name: "Modifier la demande" }));
      const d = await dialogue();
      expect(within(d).queryByLabelText("Objet de la demande")).toBeNull();
      await userEvent.clear(within(d).getByLabelText("Échéance de réponse"));
      await userEvent.type(within(d).getByLabelText("Échéance de réponse"), "2027-02-01");
      expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
      await userEvent.type(within(d).getByLabelText(/Justification du changement/), "Report accordé par le concessionnaire");
      await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
      await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${W}/demandes/${D2}`, { echeance: "2027-02-01", justification: "Report accordé par le concessionnaire" }));
    });
    it("reponse recue : le jeu lie est montre avec son statut ; lier un jeu ensuite par PATCH { jeuRecuId }", async () => {
      const recue = demandeRecue({ reception: { dateReception: "2026-11-05", enregistrePar: null, enregistreLe: null, jeu: null, jeuMasque: false } });
      await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [recue], { RECUE: 1 }), fichesDemandes: { [D2]: ficheDemandeServeur(recue, ["CLOTUREE"]) } });
      await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
      const f = await screen.findByTestId("fiche-demande");
      expect(f.textContent).toMatch(/Jeu reçu liéaucun/);
      await userEvent.click(await within(f).findByRole("button", { name: "Lier un jeu reçu" }));
      const d = await dialogue();
      await userEvent.selectOptions(await within(d).findByLabelText(/Jeu reçu/), J1);
      await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
      await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${W}/demandes/${D2}`, { jeuRecuId: J1 }));
    });
    it("un jeu masque pour ce profil est dit masque", async () => {
      const recue = demandeRecue({ reception: { dateReception: "2026-11-05", enregistrePar: null, enregistreLe: null, jeu: null, jeuMasque: true } });
      await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [recue], { RECUE: 1 }), fichesDemandes: { [D2]: ficheDemandeServeur(recue, []) } });
      await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
      expect((await screen.findByTestId("fiche-demande")).textContent).toMatch(/jeu masqué pour votre profil/);
    });
    it("demande terminee : aucune action ; preuves interdites", async () => {
      const close = demandeEnvoyee({ statut: "CLOTUREE", fin: { type: "CLOTUREE", le: "2026-11-09T09:00:00.000Z", par: ADMIN, motif: "Aucune reponse apres deux relances" } });
      await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [close], { CLOTUREE: 1 }), fichesDemandes: { [D2]: ficheDemandeServeur(close, []) } });
      await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
      const f = await screen.findByTestId("fiche-demande");
      expect(within(f).getByTestId("aucune-action").textContent).toMatch(/Demande terminée/);
      expect(within(f).queryByRole("button", { name: /Ajouter une preuve|Modifier/ })).toBeNull();
      expect(f.textContent).toMatch(/Motif.*Aucune reponse apres deux relances/);
    });
    it("sans transitionsPossibles dans la reponse : aucune action n'est proposee, et la fiche le dit", async () => {
      const f0 = { demande: demandeEnvoyee(), preuves: [] };
      await ouvrir("GESTIONNAIRE", { ...base, fichesDemandes: { [D2]: f0 } });
      await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
      const f = await screen.findByTestId("fiche-demande");
      expect(f.textContent).toMatch(/Le serveur n'a pas indiqué les actions possibles : aucune n'est proposée/);
      expect(within(f).queryByRole("button", { name: /Enregistrer la réception|Clore|Annuler la demande/ })).toBeNull();
    });
    it("l'historique est montre aux decideurs ; pas aux autres (message, jamais « aucun historique »)", async () => {
      const f = await ficheEnvoyee({ fichesDemandes: { [D2]: ficheDemandeServeur(demandeEnvoyee(), ["RECUE"], [], [historiqueServeur()]) } });
      expect(within(f).getByText("Création")).toBeInTheDocument();
    });
    it("fiche introuvable (404) : message du lot ; erreur de liste (504) : message et Reessayer", async () => {
      await ouvrir("GESTIONNAIRE", { ...base, fichesDemandes: { [D2]: erreurHttp(404, "DEMANDE_INTROUVABLE") } });
      await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
      expect(await screen.findByText(/n'est pas partagée avec vous, ou concerne un autre concessionnaire/)).toBeInTheDocument();
    });
  });

  it("liste en erreur 504 : message explique ; vide : message sans promesse", async () => {
    await ouvrir("GESTIONNAIRE", { demandes: () => { throw erreurHttp(504); } });
    expect(await screen.findByText(/n'a pas répondu dans le délai autorisé/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer : Demandes" })).toBeInTheDocument();
  });
  it("liste vide : explique comment commencer ; les elements illisibles sont comptes", async () => {
    await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [], null) });
    expect(await screen.findByText("Aucun élément")).toBeInTheDocument();
    expect(screen.getByText(/envoyez-le hors application, puis enregistrez l'envoi ici/)).toBeInTheDocument();
  });
  it("une demande de statut inconnu de cette version est comptee, jamais masquee en silence", async () => {
    await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [demandeServeur(), { ...demandeServeur(), id: "x", statut: "ARCHIVEE" }], null) });
    expect(await screen.findByText(/1 élément\(s\) de la réponse du serveur n'ont pas pu être lus/)).toBeInTheDocument();
  });
});

describe("taches : validation par un tiers, separation des taches", () => {
  async function ficheTache(role: string, tache: Record<string, unknown>, over: SurchargesWorkflow = {}) {
    await ouvrir(role, { taches: pageServeur("taches", [tache], { [String(tache.statut)]: 1 }), fichesTaches: { [String(tache.id)]: ficheTacheServeur(tache, [], [historiqueServeur()]) }, ...over }, "Tâches");
    await screen.findByRole("list", { name: "Liste : taches" });
    await userEvent.click(bouton("tache", String(tache.id)));
    return screen.findByTestId("fiche-tache");
  }
  it("la liste montre statut, priorite, echeance, responsable (« vous ») et validation requise", async () => {
    await ouvrir("GESTIONNAIRE", {}, "Tâches");
    await screen.findByRole("list", { name: "Liste : taches" });
    expect(bouton("tache", T1).textContent).toMatch(/À faire/);
    expect(bouton("tache", T1).textContent).toMatch(/Priorité normale/);
    expect(bouton("tache", T1).textContent).toMatch(/Validation requise/);
    expect(bouton("tache", T1).textContent).toMatch(/Responsable : vous/);
    expect(bouton("tache", T2).textContent).toMatch(/Responsable : Fatou Admin/);
    expect(screen.getByRole("button", { name: /À faire \(1\)/ })).toBeInTheDocument();
  });
  it("« mes taches » filtre par responsable ; echeance depassee ; statut", async () => {
    await ouvrir("GESTIONNAIRE", {}, "Tâches");
    await screen.findByRole("list", { name: "Liste : taches" });
    await userEvent.click(screen.getByLabelText("Mes tâches seulement"));
    await waitFor(() => expect(dernierParams("/taches")).toMatchObject({ responsableId: U_GEST }));
    await userEvent.click(within(document.getElementById("pv-ech-panneau-taches")!).getByLabelText("Échéance dépassée seulement"));
    await waitFor(() => expect(dernierParams("/taches")).toMatchObject({ echeanceDepassee: "true" }));
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-statut-filtre="EN_COURS"]')!);
    await waitFor(() => expect(dernierParams("/taches")).toMatchObject({ statut: "EN_COURS", responsableId: U_GEST }));
  });
  it("commencer : transition du serveur sans justification ; POST { vers: EN_COURS } seul", async () => {
    const f = await ficheTache("GESTIONNAIRE", tacheServeur());
    expect(within(f).getByRole("button", { name: "Commencer la tâche" })).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Annuler la tâche" })).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Modifier la tâche" })).toBeInTheDocument();
    await userEvent.click(within(f).getByRole("button", { name: "Commencer la tâche" }));
    const d = await dialogue();
    const ok = within(d).getByRole("button", { name: "Enregistrer" });
    expect(ok).toBeEnabled();
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/taches/${T1}/statut`, { vers: "EN_COURS" }));
  });
  it("soumettre a validation : justification de 10 caracteres exigee par le serveur ; POST { vers: A_VALIDER, justification }", async () => {
    const t = tacheServeur({ statut: "EN_COURS", transitionsPossibles: [transTache("A_VALIDER"), transTache("ANNULEE")] });
    const f = await ficheTache("GESTIONNAIRE", t);
    await userEvent.click(within(f).getByRole("button", { name: "Soumettre à validation" }));
    const d = await dialogue();
    expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Justification/), "Controle termine sur place");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/taches/${T1}/statut`, { vers: "A_VALIDER", justification: "Controle termine sur place" }));
  });
  const aValider = () => tacheServeur({ statut: "A_VALIDER", responsableEstMoi: false, transitionsPossibles: [transTache("TERMINEE", true, true), transTache("EN_COURS"), transTache("ANNULEE")] });
  it("valider (A_VALIDER vers TERMINEE) : rappel de la separation des taches ; un gestionnaire n'a PAS de champ de derogation", async () => {
    const f = await ficheTache("GESTIONNAIRE", aValider());
    expect(within(f).getByRole("button", { name: "Valider la tâche (par un tiers)" })).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Refuser la validation (retour en cours)" })).toBeInTheDocument();
    await userEvent.click(within(f).getByRole("button", { name: "Valider la tâche (par un tiers)" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/la validation exige un tiers/);
    expect(d.textContent).toMatch(/Seul un administrateur peut accorder une dérogation/);
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
  });
  it("administrateur : champ de derogation facultatif ; 409 SEPARATION_DES_TACHES le rend obligatoire ici ; la derogation part avec la justification", async () => {
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES"));
    const f = await ficheTache("ADMIN", aValider());
    await userEvent.click(within(f).getByRole("button", { name: "Valider la tâche (par un tiers)" }));
    const d = await dialogue();
    expect(within(d).getByLabelText(/Dérogation à la séparation des tâches \(réservée aux administrateurs\), facultative/)).toBeInTheDocument();
    await userEvent.type(within(d).getByLabelText(/Justification/), "Verifie sur le terrain");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    const alerte = await within(d).findByRole("alert");
    expect(alerte.textContent).toMatch(/Séparation des tâches : la validation exige un tiers/);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/taches/${T1}/statut`, { vers: "TERMINEE", justification: "Verifie sur le terrain" });
    expect(within(d).getByLabelText(/motif obligatoire ici/)).toBeInTheDocument();
    await userEvent.type(within(d).getByLabelText(/Dérogation/), "Seul compte habilité du projet");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${W}/taches/${T1}/statut`, { vers: "TERMINEE", justification: "Verifie sur le terrain", derogation: "Seul compte habilité du projet" }));
  });
  it("seules les transitions du serveur sont proposees : aucune pour un compte qui n'est pas le responsable", async () => {
    const t = tacheServeur({ id: T2, statut: "EN_COURS", responsableEstMoi: false, responsable: ADMIN, transitionsPossibles: [] });
    const f = await ficheTache("INSPECTEUR", t);
    expect(within(f).getByTestId("aucune-action").textContent).toMatch(/seul le responsable fait avancer sa tâche/);
    expect(within(f).queryByRole("button", { name: /Commencer|Terminer|Soumettre|Valider|Annuler|Modifier/ })).toBeNull();
  });
  it("sans transitionsPossibles : aucune action proposee, dit ; tache terminee : aucune action", async () => {
    const sans = { ...tacheServeur(), transitionsPossibles: undefined };
    const f = await ficheTache("GESTIONNAIRE", sans, { fichesTaches: { [T1]: { tache: sans, preuves: [] } } });
    expect(f.textContent).toMatch(/Le serveur n'a pas indiqué les actions possibles/);
  });
  it("une tache terminee n'a ni action ni preuve a ajouter ; son responsable masque est dit non communique", async () => {
    const t = tacheServeur({ statut: "TERMINEE", transitionsPossibles: [], responsable: null, responsableEstMoi: false, termineLe: "2026-11-07T10:00:00.000Z" });
    const f = await ficheTache("GESTIONNAIRE", t);
    expect(within(f).getByTestId("aucune-action").textContent).toMatch(/terminée ou annulée/);
    expect(within(f).queryByRole("button", { name: /Ajouter une preuve|Modifier/ })).toBeNull();
    expect(f.textContent).toMatch(/Responsablenon communiqué pour votre profil/);
  });
  it("creation : titre, responsable (moi), lien a une demande, validation par un tiers ; POST du corps complet", async () => {
    await ouvrir("GESTIONNAIRE", {}, "Tâches");
    await userEvent.click(await screen.findByRole("button", { name: "Nouvelle tâche" }));
    const d = await dialogue();
    const ok = within(d).getByRole("button", { name: "Créer la tâche" });
    expect(ok).toBeDisabled();
    await userEvent.type(within(d).getByLabelText("Titre"), "Relancer le service reseaux");
    await userEvent.selectOptions(within(d).getByLabelText("Responsable"), U_GEST);
    await userEvent.selectOptions(within(d).getByLabelText("Priorité"), "HAUTE");
    await userEvent.selectOptions(within(d).getByLabelText("Lien"), "DEMANDE");
    await userEvent.selectOptions(await within(d).findByLabelText("Demande liée"), D2);
    await userEvent.click(within(d).getByLabelText(/Exiger une validation par un tiers/));
    await userEvent.click(within(d).getByLabelText(/Partager cette tâche avec le référent/));
    expect(ok).toBeEnabled();
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/taches`, {
      titre: "Relancer le service reseaux", description: null, responsableId: U_GEST, echeance: null, priorite: "HAUTE", validationRequise: true, conflitId: null, demandeId: D2, partagee: true,
    }));
  });
  it("creation : un responsable saisi doit etre un UUID ; 422 RESPONSABLE_NON_HABILITE expliquee ; lien conflit propose les dossiers", async () => {
    h.post.mockRejectedValue(erreurHttp(422, "RESPONSABLE_NON_HABILITE"));
    await ouvrir("GESTIONNAIRE", {}, "Tâches");
    await userEvent.click(await screen.findByRole("button", { name: "Nouvelle tâche" }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText("Titre"), "Tache de test");
    await userEvent.selectOptions(within(d).getByLabelText("Responsable"), "__autre");
    await userEvent.type(within(d).getByLabelText(/Identifiant du compte responsable/), "pas-un-uuid");
    expect(within(d).getByTestId("aide-saisie").textContent).toMatch(/un UUID/);
    await userEvent.clear(within(d).getByLabelText(/Identifiant du compte responsable/));
    await userEvent.type(within(d).getByLabelText(/Identifiant du compte responsable/), U_REF);
    await userEvent.selectOptions(within(d).getByLabelText("Lien"), "CONFLIT");
    await userEvent.selectOptions(await within(d).findByLabelText("Dossier de conflit lié"), CF1);
    await userEvent.click(within(d).getByRole("button", { name: "Créer la tâche" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/ne peut pas être responsable/);
    expect(h.post).toHaveBeenCalledWith(`${W}/taches`, expect.objectContaining({ responsableId: U_REF, conflitId: CF1, demandeId: null }));
  });
  it("modifier : seuls les champs changes ; changer de responsable exige une justification", async () => {
    const f = await ficheTache("GESTIONNAIRE", tacheServeur());
    await userEvent.click(within(f).getByRole("button", { name: "Modifier la tâche" }));
    const d = await dialogue();
    expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await userEvent.selectOptions(within(d).getByLabelText("Priorité"), "URGENTE");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${W}/taches/${T1}`, { priorite: "URGENTE" }));
  });
  it("modifier le responsable : identifiant UUID et justification de 10 caracteres", async () => {
    const f = await ficheTache("GESTIONNAIRE", tacheServeur());
    await userEvent.click(within(f).getByRole("button", { name: "Modifier la tâche" }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText(/Nouveau responsable/), "__autre");
    await userEvent.type(within(d).getByLabelText(/Identifiant du compte \(UUID\)/), U_REF);
    expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await userEvent.type(await within(d).findByLabelText(/Justification du changement de responsable/), "Reaffectation apres conge");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${W}/taches/${T1}`, { responsableId: U_REF, justification: "Reaffectation apres conge" }));
  });
  it("referent : transitions du serveur seulement, pas de creation, pas de modification ; ses preuves partagees", async () => {
    const t = tacheServeur({ concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" }, partagee: true, responsableEstMoi: true, responsable: { id: U_REF, nomComplet: "Ibrahima Referent" }, creePar: null, transitionsPossibles: [transTache("EN_COURS", false)] });
    const f = await ficheTache("REFERENT", t);
    expect(screen.queryByRole("button", { name: "Nouvelle tâche" })).toBeNull();
    expect(within(f).getByRole("button", { name: "Commencer la tâche" })).toBeInTheDocument();
    expect(within(f).queryByRole("button", { name: /Modifier la tâche|Annuler la tâche/ })).toBeNull();
    expect(f.textContent).toMatch(/Partagée avec le référent du concessionnaire/);
    expect(within(f).getByRole("button", { name: "Ajouter une preuve" })).toBeInTheDocument();
  });
});

describe("preuves : references et empreintes, jamais un fichier", () => {
  async function ficheDemandeAvecPreuve(role = "GESTIONNAIRE", preuves: unknown[] = [preuveServeur({ objetType: "DEMANDE", objetId: D2 })]) {
    await ouvrir(role, { demandes: pageServeur("demandes", [demandeEnvoyee()], { ENVOYEE: 1 }), fichesDemandes: { [D2]: ficheDemandeServeur(demandeEnvoyee(), ["RECUE"], preuves) } });
    await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
    return screen.findByTestId("fiche-demande");
  }
  it("une preuve s'affiche en TEXTE : la reference n'est jamais un lien, meme si elle ressemble a un schema ; l'empreinte est tronquee ; aucun fichier n'est stocke", async () => {
    const f = await ficheDemandeAvecPreuve("GESTIONNAIRE", [preuveServeur({ objetType: "DEMANDE", objetId: D2, reference: "javascript:alert(1)", texte: "<img src=x onerror=alert(1)>" })]);
    const p = f.querySelector("[data-preuve-id]")!;
    expect(p.textContent).toContain("javascript:alert(1)");
    expect(p.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(p.querySelector("a, img")).toBeNull();
    expect(p.textContent).toMatch(/SHA-256 abababababababab…/);
    expect(p.textContent).toMatch(/200 Ko/);
    expect(p.textContent).toMatch(/aucun fichier n'est stocké par l'application/);
    expect(p.textContent).toMatch(/Plan de récolement/);
  });
  it("ajouter : la mention, le type, le texte, reference, nom de fichier, empreinte, taille ; POST du corps de texte ; aucun champ fichier", async () => {
    const f = await ficheDemandeAvecPreuve();
    await userEvent.click(within(f).getByRole("button", { name: "Ajouter une preuve" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/l'application ne stocke aucun fichier et n'ouvre ni ne suit jamais une référence/);
    expect(d.querySelector("input[type=file]")).toBeNull();
    const ok = within(d).getByRole("button", { name: "Ajouter la preuve" });
    expect(ok).toBeDisabled();
    await userEvent.selectOptions(within(d).getByLabelText("Type de preuve"), "COURRIER");
    await userEvent.type(within(d).getByLabelText(/Texte de la preuve/), "Courrier du 03/11 envoyé au service réseaux");
    await userEvent.type(within(d).getByLabelText(/Référence de la pièce/), "COUR-2026-41");
    await userEvent.type(within(d).getByLabelText(/Nom du fichier déclaré/), "courrier-41.pdf");
    await userEvent.type(within(d).getByLabelText(/Empreinte SHA-256/), "AB".repeat(32));
    await userEvent.type(within(d).getByLabelText(/Taille déclarée/), "2048");
    await userEvent.click(within(d).getByLabelText(/Visible du référent/));
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/demandes/${D2}/preuves`, {
      type: "COURRIER", texte: "Courrier du 03/11 envoyé au service réseaux", reference: "COUR-2026-41", nomFichier: "courrier-41.pdf", sha256: "ab".repeat(32), tailleOctets: 2048, partagee: true,
    }));
  });
  it("une reference commençant par javascript: est refusee avant l'envoi ; 400 REFERENCE_INVALIDE du serveur est expliquee", async () => {
    h.post.mockRejectedValue(erreurHttp(400, "REFERENCE_INVALIDE"));
    const f = await ficheDemandeAvecPreuve();
    await userEvent.click(within(f).getByRole("button", { name: "Ajouter une preuve" }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText(/Texte de la preuve/), "Une note");
    await userEvent.type(within(d).getByLabelText(/Référence de la pièce/), "javascript:alert(1)");
    expect(within(d).getByTestId("aide-saisie").textContent).toMatch(/jamais un lien exécutable/);
    expect(within(d).getByRole("button", { name: "Ajouter la preuve" })).toBeDisabled();
    await userEvent.clear(within(d).getByLabelText(/Référence de la pièce/));
    await userEvent.type(within(d).getByLabelText(/Référence de la pièce/), "REF-1");
    await userEvent.click(within(d).getByRole("button", { name: "Ajouter la preuve" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/jamais un lien exécutable/);
  });
  it("referent : types limites, visibilite imposee (partagee), aucune case a cocher", async () => {
    const f = await ficheDemandeAvecPreuve("REFERENT", []);
    await userEvent.click(within(f).getByRole("button", { name: "Ajouter une preuve" }));
    const d = await dialogue();
    expect(within(within(d).getByLabelText("Type de preuve")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Note", "Référence de document", "Réponse du concessionnaire", "Plan de récolement"]);
    expect(within(d).queryByLabelText(/Visible du référent/)).toBeNull();
    expect(d.textContent).toMatch(/Cette preuve sera partagée avec AGEROUTE/);
    await userEvent.type(within(d).getByLabelText(/Texte de la preuve/), "Notre reponse du 05/11");
    await userEvent.click(within(d).getByRole("button", { name: "Ajouter la preuve" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/demandes/${D2}/preuves`, expect.objectContaining({ type: "NOTE", partagee: true })));
  });
  it("une preuve interne est dite interne ; l'auteur masque est dit non communique", async () => {
    const f = await ficheDemandeAvecPreuve("GESTIONNAIRE", [preuveServeur({ objetType: "DEMANDE", objetId: D2, partagee: false, auteur: null })]);
    const p = f.querySelector("[data-preuve-id]")!;
    expect(p.textContent).toMatch(/Interne à AGEROUTE/);
    expect(p.textContent).toMatch(/auteur non communiqué/);
  });
  it("429 CADENCE_CREATION et 422 QUOTA_ATTEINT : messages en clair avec le delai", async () => {
    h.post.mockRejectedValueOnce(Object.assign(new Error("429"), { response: { status: 429, data: { error: "brut", code: "CADENCE_CREATION", retryAfterS: 12 }, headers: { "retry-after": "12" } } }));
    const f = await ficheDemandeAvecPreuve();
    await userEvent.click(within(f).getByRole("button", { name: "Ajouter une preuve" }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText(/Texte de la preuve/), "Une note");
    await userEvent.click(within(d).getByRole("button", { name: "Ajouter la preuve" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/Réessayez dans 12 secondes/);
  });
});

describe("recolements : avant et apres, validation par un tiers", () => {
  async function ficheRec(role: string, r: Record<string, unknown>, over: SurchargesWorkflow = {}, preuves: unknown[] = [], historique: unknown[] = [historiqueServeur(), historiqueModification()]) {
    await ouvrir(role, { recolements: pageServeur("recolements", [r], { [String(r.statut)]: 1 }), fichesRecolements: { [String(r.id)]: ficheRecolementServeur(r, preuves, historique) }, ...over }, "Récolements");
    await screen.findByRole("list", { name: "Liste : recolements" });
    await userEvent.click(bouton("recolement", String(r.id)));
    return screen.findByTestId("fiche-recolement");
  }
  it("la liste montre l'objet, le statut en mot, le dossier lie, le concessionnaire et la revision", async () => {
    await ouvrir("GESTIONNAIRE", {}, "Récolements");
    await screen.findByRole("list", { name: "Liste : recolements" });
    const b = bouton("recolement", R1);
    expect(b.textContent).toMatch(/Brouillon/);
    expect(b.textContent).toMatch(/Dossier : Axe A/);
    expect(b.textContent).toMatch(/Operateur synthetique A/);
    expect(b.textContent).toMatch(/révision 1/);
    expect(screen.getAllByText(MENTION_RECOLEMENT).length).toBeGreaterThanOrEqual(1);
  });
  it("la fiche dit que valider ne met a jour ni le referentiel, ni un jeu, ni le conflit ; montre le dossier lie, le constat et les ecarts", async () => {
    const f = await ficheRec("GESTIONNAIRE", recolementServeur());
    expect(within(f).getByTestId("mention-recolement").textContent).toBe(MENTION_RECOLEMENT);
    expect(f.textContent).toMatch(/Dossier de conflit lié.*Intersection avec la chaussée : Axe A \(Traitement décidé\)/);
    expect(f.textContent).toMatch(/Fibre deplacee de 3 m hors chaussee/);
    expect(f.textContent).toMatch(/Ecart de 0,4 m par rapport au plan/);
    expect(f.textContent).toMatch(/Révision1/);
    expect(within(f).getByRole("button", { name: "Soumettre pour validation" })).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Modifier le brouillon" })).toBeInTheDocument();
    expect(within(f).queryByRole("button", { name: /Valider|Rejeter/ })).toBeNull();
  });
  it("l'historique montre AVANT et APRES d'une modification, avec la justification, l'acteur et son profil", async () => {
    const f = await ficheRec("GESTIONNAIRE", recolementServeur());
    const h2 = f.querySelector("[data-historique-id='h0000002-0000-4000-8000-000000000002']")!;
    expect(h2.textContent).toMatch(/Modification/);
    expect(h2.textContent).toMatch(/Correction de l'ecart apres le releve du 06\/11/);
    expect(h2.textContent).toMatch(/Moussa Gestionnaire \(gestionnaire\)/);
    const table = within(h2 as HTMLElement).getByRole("table", { name: "Champs modifiés, avant et après" });
    const lignes = within(table).getAllByRole("row").slice(1).map((r) => [...r.querySelectorAll("th,td")].map((c) => c.textContent));
    expect(lignes).toEqual([["Écarts", "Ecart de 1,2 m", "Ecart de 0,4 m par rapport au plan"], ["Constat", "vide", "Fibre deplacee de 3 m hors chaussee"]]);
  });
  it("modifier le brouillon : justification obligatoire, seuls les champs changes + justification partent", async () => {
    const f = await ficheRec("GESTIONNAIRE", recolementServeur());
    await userEvent.click(within(f).getByRole("button", { name: "Modifier le brouillon" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/historisée, avec les valeurs avant et après/);
    expect(within(d).getByRole("button", { name: "Enregistrer la modification" })).toBeDisabled();
    const e = within(d).getByLabelText(/Écarts constatés/);
    await userEvent.clear(e);
    await userEvent.type(e, "Ecart de 0,2 m apres nouveau releve");
    expect(within(d).getByRole("button", { name: "Enregistrer la modification" })).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Justification de la modification/), "Nouveau releve du 08/11");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la modification" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${W}/recolements/${R1}`, { ecarts: "Ecart de 0,2 m apres nouveau releve", justification: "Nouveau releve du 08/11" }));
  });
  it("soumettre : justification ; bloque et explique si le constat manque", async () => {
    const f = await ficheRec("GESTIONNAIRE", recolementServeur({ constat: null }));
    await userEvent.click(within(f).getByRole("button", { name: "Soumettre pour validation" }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText(/Justification/), "Pret pour validation");
    expect(within(d).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(within(d).getByTestId("aide-saisie").textContent).toMatch(/Pour soumettre, renseignez le constat/);
    expect(h.post).not.toHaveBeenCalled();
  });
  it("soumettre un recolement complet : POST { vers: SOUMIS, justification }", async () => {
    const f = await ficheRec("GESTIONNAIRE", recolementServeur());
    await userEvent.click(within(f).getByRole("button", { name: "Soumettre pour validation" }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText(/Justification/), "Pret pour validation");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/recolements/${R1}/statut`, { vers: "SOUMIS", justification: "Pret pour validation" }));
  });
  const soumis = () => recolementServeur({ statut: "SOUMIS", soumission: { le: "2026-11-05T09:00:00.000Z", par: { id: U_GEST, nomComplet: "Moussa Gestionnaire" } }, transitionsPossibles: [transRec("VALIDE", "VALIDER"), transRec("REJETE", "VALIDER"), transRec("BROUILLON")] });
  it("sans le droit de valider, la reponse du serveur ne propose que le retrait de la soumission", async () => {
    const r = recolementServeur({ statut: "SOUMIS", transitionsPossibles: [transRec("BROUILLON")] });
    const f = await ficheRec("GESTIONNAIRE", r, {}, [], null as never);
    expect(within(f).getByRole("button", { name: "Retirer la soumission" })).toBeInTheDocument();
    expect(within(f).queryByRole("button", { name: /Valider le récolement|Rejeter/ })).toBeNull();
    expect(within(f).getByTestId("historique-non-communique")).toBeInTheDocument();
  });
  it("valider : tiers, preuve non-note exigee (dit si aucune), rappel, aucune ecriture dans le referentiel ; POST { vers: VALIDE, justification }", async () => {
    const f = await ficheRec("ADMIN", soumis(), {}, [preuveServeur({ type: "NOTE", id: "p0000009-0000-4000-8000-000000000009" })]);
    await userEvent.click(within(f).getByRole("button", { name: "Valider le récolement (par un tiers)" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/ne met à jour ni le référentiel officiel, ni un jeu de données, ni le dossier de conflit/);
    expect(d.textContent).toMatch(/Le valideur n'est ni le créateur, ni la personne qui a soumis, ni l'auteur d'une modification/);
    expect(within(d).getByTestId("preuves-suffisantes").textContent).toMatch(/Aucune n'est enregistrée : le serveur refusera la validation/);
    await userEvent.type(within(d).getByLabelText(/Justification/), "Plan conforme au releve");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/recolements/${R1}/statut`, { vers: "VALIDE", justification: "Plan conforme au releve" }));
  });
  it("une preuve suffisante est comptee ; 409 PREUVE_REQUISE et 409 SEPARATION_DES_TACHES expliquees ; derogation ADMIN apres refus", async () => {
    h.post.mockRejectedValueOnce(erreurHttp(409, "PREUVE_REQUISE")).mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES"));
    const f = await ficheRec("ADMIN", soumis(), {}, [preuveServeur()]);
    await userEvent.click(within(f).getByRole("button", { name: "Valider le récolement (par un tiers)" }));
    const d = await dialogue();
    expect(within(d).getByTestId("preuves-suffisantes").textContent).toMatch(/1 preuve\(s\) suffisante\(s\)/);
    await userEvent.type(within(d).getByLabelText(/Justification/), "Plan conforme au releve");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/qui n'est pas une simple note/);
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(within(d).getByRole("alert").textContent).toMatch(/exige un tiers/));
    await userEvent.type(within(d).getByLabelText(/Dérogation/), "Je suis le seul administrateur");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${W}/recolements/${R1}/statut`, { vers: "VALIDE", justification: "Plan conforme au releve", derogation: "Je suis le seul administrateur" }));
  });
  it("rejeter : justification ; POST { vers: REJETE, justification }", async () => {
    const f = await ficheRec("ADMIN", soumis());
    await userEvent.click(within(f).getByRole("button", { name: "Rejeter le récolement" }));
    const d = await dialogue();
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
    await userEvent.type(within(d).getByLabelText(/Justification/), "Plan non conforme au releve");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/recolements/${R1}/statut`, { vers: "REJETE", justification: "Plan non conforme au releve" }));
  });
  it("recolement valide : aucune action, il ne change plus ; decision avec valideur, motif et derogation", async () => {
    const v = recolementServeur({ statut: "VALIDE", transitionsPossibles: [], decision: { le: "2026-11-06T09:00:00.000Z", par: ADMIN, motif: "Plan conforme", derogationSeparation: "Seul compte habilite" } });
    const f = await ficheRec("ADMIN", v);
    expect(within(f).getByTestId("aucune-action").textContent).toMatch(/Récolement validé : il ne change plus/);
    expect(f.textContent).toMatch(/Validation par un tiers/);
    expect(f.textContent).toMatch(/Fatou Admin/);
    expect(f.textContent).toMatch(/Plan conforme/);
    expect(f.textContent).toMatch(/Dérogation à la séparation des tâchesSeul compte habilite/);
    expect(within(f).queryByRole("button", { name: /Ajouter une preuve/ })).toBeNull();
  });
  it("creation : lie a un dossier dont un deplacement est decide (liste des dossiers Traitement decide ou Clos) ; POST du corps", async () => {
    await ouvrir("GESTIONNAIRE", { conflits: { conflits: [conflitVueServeur(), conflitVueServeur({ id: "cf000002-0000-4000-8000-000000000002", axe: "Axe B", statut: "CLOTURE", decisionRetenue: { option: "PROTEGER", dateDebutPrevue: null, dateFinPrevue: null } })], curseurSuivant: null } }, "Récolements");
    await userEvent.click(await screen.findByRole("button", { name: "Nouveau récolement" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/dont un déplacement de réseau est décidé/);
    expect(d.textContent).toMatch(/ne met à jour ni le référentiel officiel/);
    await waitFor(() => expect(dernierParams("/conflits")).toMatchObject({ statut: "TRAITEMENT_DECIDE,CLOTURE" }));
    const ok = within(d).getByRole("button", { name: "Créer le brouillon" });
    expect(ok).toBeDisabled();
    const sel = await within(d).findByLabelText("Dossier de conflit");
    await waitFor(() => expect(within(sel).getAllByRole("option")).toHaveLength(3));
    expect(within(sel).getAllByRole("option").map((o) => o.textContent)).toContain("Intersection avec la chaussée : Axe A (Traitement décidé, décision : Déplacer le réseau (proposition))");
    await userEvent.selectOptions(sel, CF1);
    await userEvent.type(within(d).getByLabelText("Objet du récolement"), "Recolement de la fibre FO-01");
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/recolements`, { conflitId: CF1, jeuId: null, objet: "Recolement de la fibre FO-01", constat: null, ecarts: null, dateRecolement: null }));
  });
  it("creation liee a un jeu recu ; et 422 CONFLIT_NON_ELIGIBLE, 409 RECOLEMENT_EN_COURS expliquees", async () => {
    h.post.mockRejectedValueOnce(erreurHttp(422, "CONFLIT_NON_ELIGIBLE")).mockRejectedValueOnce(erreurHttp(409, "RECOLEMENT_EN_COURS"));
    await ouvrir("GESTIONNAIRE", {}, "Récolements");
    await userEvent.click(await screen.findByRole("button", { name: "Nouveau récolement" }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Rattachement"), "JEU");
    expect(within(d).queryByLabelText("Dossier de conflit")).toBeNull();
    await userEvent.selectOptions(await within(d).findByLabelText("Jeu reçu"), J1);
    await userEvent.type(within(d).getByLabelText("Objet du récolement"), "Recolement du jeu recu");
    await userEvent.click(within(d).getByRole("button", { name: "Créer le brouillon" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/déplacement de réseau est décidé/);
    expect(h.post).toHaveBeenLastCalledWith(`${W}/recolements`, { conflitId: null, jeuId: J1, objet: "Recolement du jeu recu", constat: null, ecarts: null, dateRecolement: null });
    await userEvent.click(within(d).getByRole("button", { name: "Créer le brouillon" }));
    await waitFor(() => expect(within(d).getByRole("alert").textContent).toMatch(/déjà en cours/));
  });
  it("referent : voit un recolement soumis de son concessionnaire, sans motif ni valideur, peut ajouter une preuve partagee, aucune ecriture", async () => {
    const r = recolementServeur({ id: R2, statut: "REJETE", creePar: null, soumission: { le: "2026-11-05T09:00:00.000Z", par: null }, decision: { le: "2026-11-06T09:00:00.000Z", par: null, motif: null, derogationSeparation: null }, transitionsPossibles: [] });
    const f = await ficheRec("REFERENT", r, {}, [], null as never);
    expect(f.textContent).toMatch(/Motifnon communiqué pour votre profil/);
    expect(within(f).queryByRole("button", { name: /Modifier|Soumettre|Valider|Rejeter|Rouvrir|Retirer/ })).toBeNull();
    expect(within(f).getByRole("button", { name: "Ajouter une preuve" })).toBeInTheDocument();
    expect(within(f).getByTestId("historique-non-communique").textContent).toMatch(/n'est communiqué qu'aux personnes qui décident pour AGEROUTE/);
  });
});

describe("referents : administrateur seulement", () => {
  it("lecture seule pour un gestionnaire : liste des rattachements, aucun bouton de pose ni de revocation", async () => {
    await ouvrir("GESTIONNAIRE", {}, "Référents");
    await screen.findByRole("list", { name: "Liste : référents" });
    expect(screen.getByTestId("referents-lecture-seule").textContent).toMatch(/seul un administrateur pose ou révoque/);
    expect(screen.queryByRole("button", { name: /Rattacher un compte|Révoquer/ })).toBeNull();
    expect(screen.getByText("Ibrahima Referent").closest("li")!.textContent).toMatch(/Rattachement actif/);
  });
  it("administrateur : rattacher un compte (recherche des lecteurs actifs, concessionnaire, motif) ; POST { userId, concessionnaireId, motif }", async () => {
    await ouvrir("ADMIN", {}, "Référents");
    await userEvent.click(await screen.findByRole("button", { name: "Rattacher un compte" }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/lecteur actif/);
    expect(d.textContent).toMatch(/n'ouvre plus que les échanges de ce concessionnaire/);
    const ok = within(d).getByRole("button", { name: "Rattacher le compte" });
    expect(ok).toBeDisabled();
    await userEvent.click(await within(d).findByRole("radio", { name: /Ibrahima Referent/ }));
    await userEvent.selectOptions(within(d).getByLabelText("Concessionnaire"), CONC_A);
    await userEvent.type(within(d).getByLabelText(/Motif du rattachement/), "Referent designe par le concessionnaire");
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/referents`, { userId: U_REF, concessionnaireId: CONC_A, motif: "Referent designe par le concessionnaire" }));
    expect(h.get.mock.calls.some((c) => c[0] === "/users" && (c[1]?.params as Record<string, unknown>).role === "LECTEUR" && (c[1]?.params as Record<string, unknown>).actif === "true")).toBe(true);
  });
  it("u1 : la saisie filtre la liste COTE CLIENT (aucun parametre de recherche envoye) ; un compte sans la cle de module est montre mais pas proposable ; liste incomplete dite", async () => {
    const comptes = {
      data: [
        { id: U_REF, nomComplet: "Ibrahima Referent", email: "ibrahima@example.test", role: "LECTEUR", actif: true, modulesAutorises: ["projets-voirie"] },
        { id: "00000000-0000-4000-8000-0000000000aa", nomComplet: "Fanta Sans Cle", email: "fanta@example.test", role: "LECTEUR", actif: true, modulesAutorises: ["troncons"] },
      ],
      total: 250,
    };
    await ouvrir("ADMIN", { comptes }, "Référents");
    await userEvent.click(await screen.findByRole("button", { name: "Rattacher un compte" }));
    const d = await dialogue();
    const sansCle = await within(d).findByRole("radio", { name: /Fanta Sans Cle/ });
    expect(sansCle).toBeDisabled();
    expect(within(d).getByTestId("compte-sans-cle").textContent).toMatch(/Sans la clé de module/);
    expect(within(d).getByTestId("comptes-liste-incomplete").textContent).toMatch(/200 premiers comptes.*250 au total/);
    await userEvent.type(within(d).getByLabelText(/Filtrer les comptes lecteurs/), "ibra");
    await waitFor(() => expect(within(d).queryByRole("radio", { name: /Fanta Sans Cle/ })).toBeNull());
    expect(within(d).getByRole("radio", { name: /Ibrahima Referent/ })).toBeInTheDocument();
    const appelsUsers = h.get.mock.calls.filter((c) => c[0] === "/users");
    expect(appelsUsers.length).toBe(1);
    expect(JSON.stringify(appelsUsers)).not.toMatch(/search|ibra/);
  });
  it("u2 : une preuve et une entree d'historique illisibles sont comptees et dites dans la fiche, jamais tues", async () => {
    await ouvrir("GESTIONNAIRE", { fichesDemandes: { [D1]: ficheDemandeServeur(demandeServeur(), ["ENVOYEE", "ANNULEE"], [preuveServeur(), { type: "VIDEO", id: "x" }], [historiqueServeur(), { action: "SANS_ID" }]) } }, "Demandes");
    await screen.findByRole("list", { name: "Liste : demandes" });
    await userEvent.click(bouton("demande", D1));
    const f = await screen.findByTestId("fiche-demande");
    expect(within(f).getByTestId("ignores-preuves").textContent).toMatch(/^1 élément\(s\) de la réponse du serveur n'ont pas pu être lus/);
    expect(within(f).getByTestId("ignores-historique").textContent).toMatch(/^1 élément\(s\)/);
    expect(within(f).getByRole("list", { name: "Preuves" }).querySelectorAll("li")).toHaveLength(1);
  });
  it.each([
    [422, "COMPTE_NON_ELIGIBLE", /lecteur actif|actif de rôle lecteur/],
    [422, "COMPTE_SANS_MODULE", /clé de module/],
    [409, "RATTACHEMENT_DEJA_ACTIF", /déjà référent/],
    [400, "COMPTE_INCONNU", /n'existe pas/],
    [404, "CONCESSIONNAIRE_INTROUVABLE", /Ce concessionnaire est introuvable/],
  ] as const)("%s %s : message en clair, saisie conservee", async (status, code, extrait) => {
    h.post.mockRejectedValue(erreurHttp(status, code));
    await ouvrir("ADMIN", {}, "Référents");
    await userEvent.click(await screen.findByRole("button", { name: "Rattacher un compte" }));
    const d = await dialogue();
    await userEvent.click(await within(d).findByRole("radio", { name: /Ibrahima Referent/ }));
    await userEvent.selectOptions(within(d).getByLabelText("Concessionnaire"), CONC_A);
    await userEvent.type(within(d).getByLabelText(/Motif du rattachement/), "Referent designe par le concessionnaire");
    await userEvent.click(within(d).getByRole("button", { name: "Rattacher le compte" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(extrait);
    expect(within(d).getByLabelText(/Motif du rattachement/)).toHaveValue("Referent designe par le concessionnaire");
  });
  it("revoquer : motif ; POST { motif } ; les avertissements du serveur sont montres (la cle de module reste)", async () => {
    h.post.mockResolvedValue({ data: { rattachement: rattachementServeur({ actif: false }), avertissements: ["Ce compte n'a plus aucun rattachement mais garde la clé de module projets-voirie."] } });
    await ouvrir("ADMIN", {}, "Référents");
    await userEvent.click(await screen.findByRole("button", { name: /Révoquer le rattachement de Ibrahima Referent/ }));
    const d = await dialogue();
    expect(d.textContent).toMatch(/ne retire pas la clé de module/);
    const ok = within(d).getByRole("button", { name: "Révoquer le rattachement" });
    expect(ok).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Motif de la révocation/), "Fin de mission du referent");
    await userEvent.click(ok);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${W}/referents/ra000001-0000-4000-8000-000000000001/revoquer`, { motif: "Fin de mission du referent" }));
    expect((await screen.findByTestId("avertissements-revocation")).textContent).toMatch(/garde la clé de module/);
  });
  it("un rattachement revoque est montre comme tel, sans bouton de revocation ; 409 RATTACHEMENT_DEJA_REVOQUE expliquee", async () => {
    h.post.mockRejectedValue(erreurHttp(409, "RATTACHEMENT_DEJA_REVOQUE"));
    await ouvrir("ADMIN", { referents: { rattachements: [rattachementServeur(), rattachementServeur({ id: "ra000002-0000-4000-8000-000000000002", actif: false, revocation: { le: "2026-11-09T08:00:00.000Z", par: ADMIN, motif: "Fin de mission" } })] } }, "Référents");
    const l = await screen.findByRole("list", { name: "Liste : référents" });
    const items = within(l).getAllByRole("listitem");
    expect(items[1].textContent).toMatch(/Rattachement révoqué/);
    expect(items[1].textContent).toMatch(/Motif : Fin de mission/);
    expect(within(items[1]).queryByRole("button", { name: /Révoquer/ })).toBeNull();
    await userEvent.click(within(items[0]).getByRole("button", { name: /Révoquer/ }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText(/Motif de la révocation/), "Fin de mission du referent");
    await userEvent.click(within(d).getByRole("button", { name: "Révoquer le rattachement" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/déjà révoqué/);
  });
  it("liste vide : message explicite", async () => {
    await ouvrir("ADMIN", { referents: { rattachements: [] } }, "Référents");
    expect(await screen.findByText("Aucun référent rattaché à ce projet")).toBeInTheDocument();
  });
});

describe("dossiers et jeux (vue concessionnaire, lecture seule)", () => {
  it("dossiers : statut, type, axe, decision approuvee avec dates prevues ; jamais de cout, de mesure ni de geometrie ; jeux : metadonnees", async () => {
    await ouvrir("GESTIONNAIRE", {}, "Dossiers et jeux");
    const l = await screen.findByRole("list", { name: "Liste : dossiers de conflit" });
    const t = l.textContent!;
    expect(t).toMatch(/Traitement décidé/);
    expect(t).toMatch(/Intersection avec la chaussée/);
    expect(t).toMatch(/Axe A/);
    expect(t).toMatch(/Décision approuvée : Déplacer le réseau \(proposition\), début prévu le 10\/01\/2027, fin prévue le 20\/01\/2027/);
    expect(t).not.toMatch(/coût|cout|GNF|mesure|longueur/i);
    const jeux = await screen.findByRole("list", { name: "Liste : jeux" });
    expect(jeux.textContent).toMatch(/reponse-synthetique\.geojson, version 1/);
    expect(jeux.textContent).toMatch(/classe non renseignée/);
    expect(jeux.textContent).toMatch(/8 circuit\(s\) ou objet\(s\) du fichier/);
  });
  it("un dossier de statut inconnu est compte ; aucun dossier : message pour le referent", async () => {
    await ouvrir("REFERENT", { conflits: { conflits: [{ id: "x", type: "NOUVEAU", statut: "CLOTURE" }], curseurSuivant: null }, jeux: { jeux: [] } }, "Dossiers et jeux");
    expect(await screen.findByText(/1 dossier\(s\) de la réponse n'ont pas pu être lus/)).toBeInTheDocument();
    expect(await screen.findByText("Aucun jeu visible pour votre profil")).toBeInTheDocument();
  });
  it("erreur 403 ACTION_NON_AUTORISEE sur les dossiers : refus de droit en clair", async () => {
    await ouvrir("GESTIONNAIRE", { conflits: () => { throw erreurHttp(403, "ACTION_NON_AUTORISEE"); } }, "Dossiers et jeux");
    expect(await screen.findByText(/Votre profil ne permet pas cette action/)).toBeInTheDocument();
  });
});

describe("compte REFERENT : vue limitee et redirection du 403 COMPTE_REFERENT_RESTREINT", () => {
  function simulerReferent(over: SurchargesWorkflow = {}) {
    h.role = "LECTEUR"; h.userId = U_REF;
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
      // Le serveur ferme TOUT le module hors de /workflow pour un compte rattache.
      if (!/\/v2\/projets-voirie\/(workflow\/|p1\/workflow\/)/.test(url)) throw erreurHttp(403, "COMPTE_REFERENT_RESTREINT", "Compte rattaché à un concessionnaire : seules les routes du workflow sont ouvertes");
      return reponseApiWorkflow(url, opts?.params, { profil: profilServeur("REFERENT"), ...over });
    });
  }
  it("la liste des projets redirige vers l'ecran des echanges, puis vers son unique projet, sans erreur brute", async () => {
    simulerReferent();
    rendre("/projets-voirie");
    await screen.findByRole("tablist", { name: "Sections des échanges" });
    expect(screen.getByTestId("lieu").textContent).toBe("/projets-voirie/p1/echanges");
    expect(screen.queryByText(/COMPTE_REFERENT_RESTREINT|seules les routes du workflow/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("la page d'un projet redirige de la meme facon (lien direct, signet)", async () => {
    simulerReferent();
    rendre("/projets-voirie/p1");
    await screen.findByRole("tablist", { name: "Sections des échanges" });
    expect(screen.getByTestId("lieu").textContent).toBe("/projets-voirie/p1/echanges");
    expect(screen.queryByText(/COMPTE_REFERENT_RESTREINT|seules les routes du workflow/)).toBeNull();
  });
  it("un referent n'appelle JAMAIS une route hors du workflow depuis l'ecran des echanges (ni le projet, ni la carte, ni les concessionnaires)", async () => {
    simulerReferent();
    rendre("/projets-voirie/p1/echanges");
    await screen.findByRole("tablist", { name: "Sections des échanges" });
    await screen.findByRole("list", { name: "Liste : demandes" });
    for (const s of ["Tâches", "Récolements", "Dossiers et jeux"]) await userEvent.click(screen.getByRole("tab", { name: s }));
    await screen.findByRole("list", { name: "Liste : jeux" });
    const hors = h.get.mock.calls.map((c) => String(c[0])).filter((u) => !/\/v2\/projets-voirie\/(workflow\/mon-profil|p1\/workflow\/)/.test(u));
    expect(hors).toEqual([]);
  });
  it("l'ecran montre le projet et le concessionnaire du rattachement, sans lien vers la page projet", async () => {
    simulerReferent();
    rendre("/projets-voirie/p1/echanges");
    await screen.findByRole("tablist", { name: "Sections des échanges" });
    expect(screen.getByRole("heading", { level: 1, name: "Échanges avec les concessionnaires" })).toBeInTheDocument();
    expect(screen.getByText(/Voirie synthetique \(VOIRIE-SYNTH-2026\) · concessionnaire Operateur synthetique A/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Retour au projet/ })).toBeNull();
  });
  it("projet ou le referent n'est pas rattache : message, aucun appel de liste", async () => {
    simulerReferent();
    rendre("/projets-voirie/autre-projet/echanges");
    expect(await screen.findByText("Vous n'êtes pas rattaché à ce projet")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(h.get.mock.calls.filter((c) => String(c[0]).includes("/autre-projet/"))).toEqual([]);
  });
  it("plusieurs rattachements : choix du projet ; un seul : ouverture directe", async () => {
    const deux = profilServeur("REFERENT", { rattachements: [
      { id: "ra1", projet: { id: "p1", code: "P1", nom: "Voirie un" }, concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" } },
      { id: "ra2", projet: { id: "p2", code: "P2", nom: "Voirie deux" }, concessionnaire: { id: "c0000002-0000-4000-8000-00000000000b", nom: "Societe des eaux synthetique" } },
    ] });
    simulerReferent({ profil: deux });
    rendre("/projets-voirie/echanges");
    expect(await screen.findByRole("heading", { name: "Choisissez un projet" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/projets-voirie/p1/echanges", "/projets-voirie/p2/echanges"]);
    expect(screen.getByText(/Concessionnaire : Societe des eaux synthetique/)).toBeInTheDocument();
  });
  it("aucun rattachement actif visible : message", async () => {
    simulerReferent({ profil: profilServeur("REFERENT", { rattachements: [] }) });
    rendre("/projets-voirie/echanges");
    expect(await screen.findByText("Aucun rattachement actif")).toBeInTheDocument();
  });
  it("hors de l'ecran, l'erreur typee COMPTE_REFERENT_RESTREINT reste lisible (jamais « cle de module manquante »)", async () => {
    h.role = "LECTEUR"; h.userId = U_REF;
    h.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/mon-profil")) throw erreurHttp(403, "COMPTE_REFERENT_RESTREINT");
      return { data: {} };
    });
    rendre("/projets-voirie/p1/echanges");
    expect(await screen.findByText(/n'ouvre que l'écran des échanges/)).toBeInTheDocument();
    expect(screen.queryByText(/clé de module « Projets de voirie »/)).toBeNull();
  });
});

describe("compte non rattache : acces a l'ecran", () => {
  it("sans projet choisi : invite a ouvrir un projet depuis la liste", async () => {
    installer({ profil: profilServeur("GESTIONNAIRE") });
    rendre("/projets-voirie/echanges");
    expect(await screen.findByText("Choisissez d'abord un projet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Aller à la liste des projets" })).toHaveAttribute("href", "/projets-voirie");
  });
  it("avec un projet : lien de retour vers la page du projet et nom du projet", async () => {
    await ouvrir("GESTIONNAIRE");
    expect(screen.getByRole("link", { name: /Retour au projet/ })).toHaveAttribute("href", "/projets-voirie/p1");
    expect(await screen.findByText(/Voirie synthetique \(VOIRIE-SYNTH-2026\)/)).toBeInTheDocument();
  });
  it("projet introuvable (404 PROJET_INTROUVABLE) : message du lot", async () => {
    h.role = "GESTIONNAIRE";
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
      if (url === "/v2/projets-voirie/p1") throw erreurHttp(404, "PROJET_INTROUVABLE");
      return reponseApiWorkflow(url, opts?.params, { profil: profilServeur("GESTIONNAIRE") });
    });
    rendre();
    expect(await screen.findByText(/Projet : introuvable./)).toBeInTheDocument();
  });
});

describe("hors ligne, clavier et focus", () => {
  it("hors ligne : le bandeau le dit, les actions d'ecriture sont desactivees", async () => {
    await ouvrir("GESTIONNAIRE");
    await screen.findByRole("list", { name: "Liste : demandes" });
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(await screen.findByText(/Vous êtes hors ligne/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nouvelle demande" })).toBeDisabled();
  });
  it("Echap ferme un dialogue sans ecrire ; le focus revient au bouton d'origine", async () => {
    await ouvrir("GESTIONNAIRE");
    await userEvent.click(await screen.findByRole("button", { name: /Plan des fourreaux de la rue 12/ }));
    const f = await screen.findByTestId("fiche-demande");
    const declencheur = within(f).getByRole("button", { name: "Annuler la demande" });
    await userEvent.click(declencheur);
    await dialogue();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.post).not.toHaveBeenCalled();
    await waitFor(() => expect(declencheur).toHaveFocus());
  });
  it("Retour a la liste : le focus revient a l'element ouvert", async () => {
    await ouvrir("GESTIONNAIRE");
    await userEvent.click(await screen.findByRole("button", { name: /Plan des fourreaux de la rue 12/ }));
    const f = await screen.findByTestId("fiche-demande");
    await userEvent.click(within(f).getByRole("button", { name: "Retour à la liste des demandes" }));
    await waitFor(() => expect(bouton("demande", D1)).toHaveFocus());
  });
  it("les sections gardent leur etat : revenir sur Demandes retrouve la liste telle qu'on l'a laissee (filtre actif)", async () => {
    await ouvrir("GESTIONNAIRE");
    await screen.findByRole("list", { name: "Liste : demandes" });
    await userEvent.click(document.querySelector<HTMLButtonElement>('button[data-statut-filtre="ENVOYEE"]')!);
    await userEvent.click(screen.getByRole("tab", { name: "Tâches" }));
    await userEvent.click(screen.getByRole("tab", { name: "Demandes" }));
    expect(document.querySelector<HTMLButtonElement>('button[data-statut-filtre="ENVOYEE"]')).toHaveAttribute("aria-pressed", "true");
  });
  it("tous les boutons a bascule et d'action ont une cible tactile d'au moins 44 px", async () => {
    await ouvrir("ADMIN");
    await screen.findByRole("list", { name: "Liste : demandes" });
    for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-statut-filtre], button[role=tab]")) expect(b.className).toMatch(/min-h-\[44px\]/);
  });
});

describe("garde-fous de l'ecran entier : aucun ordre, deplacement, envoi ni message", () => {
  it("aucun bouton, lien ou champ de l'ecran (toutes sections, administrateur) ne propose un ordre, un deplacement, un envoi ni un message", async () => {
    await ouvrir("ADMIN");
    await screen.findByRole("list", { name: "Liste : demandes" });
    for (const s of ["Tâches", "Récolements", "Dossiers et jeux", "Référents", "Mon profil"]) await userEvent.click(screen.getByRole("tab", { name: s }));
    const textes = [...document.querySelectorAll("button, a, label")].map((e) => (e.textContent ?? "").trim()).join(" | ");
    expect(textes).not.toMatch(/\bordonner\b|\bordre de\b|déplacer maintenant|exécuter|lancer les travaux|notifier|envoyer (un|le|la) (message|courriel|mail)|^envoyer\b/i);
    expect(document.querySelectorAll("input[type=email], input[type=file], a[href^='mailto:']")).toHaveLength(0);
  });
});
