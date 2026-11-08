import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Accessibilite de l'ecran « Echanges avec les concessionnaires » (lot B3) par axe-core, regles WCAG 2.1 A et AA, contraste exclu (jsdom ne le calcule pas ; il est garde par
 * `test/contraste.test.ts`, qui parcourt les nouveaux dossiers). Chaque section, chaque etat cle et chaque dialogue est rendu avec des donnees SYNTHETIQUES, puis ZERO
 * violation est exigee. Les dialogues sont mesures sur tout le document (ils sont montes dans un portail).
 */

configure({ asyncUtilTimeout: 10_000 });

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), role: "GESTIONNAIRE", userId: "u0000001-0000-4000-8000-0000000000a1" }));
vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post, put: h.put, patch: h.patch, delete: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: h.userId, nomComplet: "Moussa Gestionnaire", role: h.role, modulesAutorises: ["projets-voirie"] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn() }));

import { ProjetVoirieWorkflowPage } from "./ProjetVoirieWorkflowPage";
import {
  CONC_A, D1, D2, R1, T1, U_ADMIN, U_GEST, U_REF, demandeEnvoyee, demandeServeur, erreurHttp, ficheDemandeServeur, ficheRecolementServeur, ficheTacheServeur, historiqueModification,
  historiqueServeur, pageServeur, preuveServeur, profilServeur, recolementServeur, reponseApiWorkflow, tacheServeur, transRec, transTache, type SurchargesWorkflow,
} from "../components/projets-voirie/workflow/workflowSynthetiques.testutil";

const corps = () => document.body;
const dialogue = () => screen.findByRole("dialog");
async function fermer(d: HTMLElement) {
  await userEvent.click(within(d).getByRole("button", { name: "Annuler" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
const T2 = "t0000002-0000-4000-8000-000000000002";
const R2 = "e0000002-0000-4000-8000-000000000002";

function rendre(entree: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entree]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projets-voirie/echanges" element={<ProjetVoirieWorkflowPage />} />
          <Route path="/projets-voirie/:id/echanges" element={<ProjetVoirieWorkflowPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
function installer(profil: unknown, role: string, userId: string, over: SurchargesWorkflow = {}) {
  h.role = role; h.userId = userId;
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApiWorkflow(url, opts?.params, { profil, ...over }));
}
async function ouvrir(profil: string, over: SurchargesWorkflow = {}, section?: string, entree = "/projets-voirie/p1/echanges") {
  installer(profilServeur(profil), profil === "REFERENT" ? "LECTEUR" : profil, profil === "REFERENT" ? U_REF : profil === "ADMIN" ? U_ADMIN : U_GEST, over);
  const r = rendre(entree);
  await screen.findByRole("tablist", { name: "Sections des échanges" });
  if (section) await userEvent.click(screen.getByRole("tab", { name: section }));
  return r;
}
const bouton = (donnee: string, id: string) => document.querySelector<HTMLButtonElement>(`button[data-${donnee}-id="${id}"]`)!;

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.patch]) f.mockReset();
  h.post.mockResolvedValue({ data: {} }); h.put.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => { window.dispatchEvent(new Event("online")); });

describe("Accessibilite de l'ecran Echanges avec les concessionnaires (lot B3)", () => {
  it("Mon profil : gestionnaire, administrateur, agent de terrain, lecteur, referent", async () => {
    for (const p of ["GESTIONNAIRE", "ADMIN", "INSPECTEUR", "LECTEUR", "REFERENT"]) {
      const r = await ouvrir(p, {}, "Mon profil");
      await screen.findByTestId("bandeau-workflow");
      expect(await violationsAccessibilite(r.container), p).toEqual([]);
      r.unmount();
    }
  }, 120_000);

  it("choix du projet (referent a plusieurs rattachements), absence de rattachement, projet non rattache, sans projet choisi", async () => {
    const deux = profilServeur("REFERENT", { rattachements: [
      { id: "ra1", projet: { id: "p1", code: "P1", nom: "Voirie un" }, concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" } },
      { id: "ra2", projet: { id: "p2", code: "P2", nom: "Voirie deux" }, concessionnaire: { id: "c2", nom: "Societe des eaux synthetique" } },
    ] });
    for (const [profil, role, entree, attendu] of [
      [deux, "LECTEUR", "/projets-voirie/echanges", "Choisissez un projet"],
      [profilServeur("REFERENT", { rattachements: [] }), "LECTEUR", "/projets-voirie/echanges", "Aucun rattachement actif"],
      [profilServeur("REFERENT"), "LECTEUR", "/projets-voirie/autre/echanges", "Vous n'êtes pas rattaché à ce projet"],
      [profilServeur("GESTIONNAIRE"), "GESTIONNAIRE", "/projets-voirie/echanges", "Choisissez d'abord un projet"],
    ] as const) {
      installer(profil, role, U_REF);
      const r = rendre(entree);
      await screen.findByText(attendu);
      expect(await violationsAccessibilite(r.container), attendu).toEqual([]);
      r.unmount();
    }
  }, 120_000);

  it("Demandes : liste, creation, envoi enregistre, modification, annulation, preuve, reception, cloture", async () => {
    const r = await ouvrir("ADMIN", { demandes: pageServeur("demandes", [demandeServeur(), demandeEnvoyee({ echeanceDepassee: true })], { BROUILLON: 1, ENVOYEE: 1, RECUE: 0, CLOTUREE: 0, ANNULEE: 0 }) }, "Demandes");
    await screen.findByRole("list", { name: "Liste : demandes" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Nouvelle demande" }));
    let d = await dialogue();
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await fermer(d);
    await userEvent.click(bouton("demande", D1));
    let f = await screen.findByTestId("fiche-demande");
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    for (const nom of ["Enregistrer l'envoi (fait hors application)", "Modifier la demande", "Annuler la demande", "Ajouter une preuve"]) {
      await userEvent.click(within(f).getByRole("button", { name: nom }));
      d = await dialogue();
      expect(await violationsAccessibilite(corps()), nom).toEqual([]);
      await fermer(d);
    }
    await userEvent.click(within(f).getByRole("button", { name: "Retour à la liste des demandes" }));
    await userEvent.click(bouton("demande", D2));
    f = await screen.findByTestId("fiche-demande");
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    for (const nom of ["Enregistrer la réception de la réponse", "Clore la demande"]) {
      await userEvent.click(within(f).getByRole("button", { name: nom }));
      d = await dialogue();
      expect(await violationsAccessibilite(corps()), nom).toEqual([]);
      await fermer(d);
    }
  }, 180_000);

  it("Demandes : dialogue d'envoi avec erreur typee ; liste en erreur et vide ; vue du referent (historique non communique)", async () => {
    h.post.mockRejectedValue(erreurHttp(422, "DATE_INVALIDE"));
    const a = await ouvrir("GESTIONNAIRE", {}, "Demandes");
    await userEvent.click(await screen.findByRole("button", { name: /Plan des fourreaux de la rue 12/ }));
    const f = await screen.findByTestId("fiche-demande");
    await userEvent.click(within(f).getByRole("button", { name: "Enregistrer l'envoi (fait hors application)" }));
    const d = await dialogue();
    await userEvent.type(within(d).getByLabelText(/Canal utilisé/), "Courriel");
    await userEvent.type(within(d).getByLabelText("Date de l'envoi"), "2026-11-03");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer l'envoi" }));
    await within(d).findByRole("alert");
    expect(await violationsAccessibilite(corps())).toEqual([]);
    a.unmount();
    const b = await ouvrir("GESTIONNAIRE", { demandes: () => { throw erreurHttp(504); } }, "Demandes");
    await screen.findByText(/n'a pas répondu dans le délai autorisé/);
    expect(await violationsAccessibilite(b.container)).toEqual([]);
    b.unmount();
    const c = await ouvrir("GESTIONNAIRE", { demandes: pageServeur("demandes", [], null) }, "Demandes");
    await screen.findByText("Aucun élément");
    expect(await violationsAccessibilite(c.container)).toEqual([]);
    c.unmount();
    const e = await ouvrir("REFERENT", { demandes: pageServeur("demandes", [demandeEnvoyee({ creePar: null })], { ENVOYEE: 1 }), fichesDemandes: { [D2]: ficheDemandeServeur(demandeEnvoyee({ creePar: null }), [], [preuveServeur({ objetType: "DEMANDE", objetId: D2 })]) } }, "Demandes");
    await userEvent.click(await screen.findByRole("button", { name: /Releve des chambres/ }));
    await screen.findByTestId("fiche-demande");
    expect(await violationsAccessibilite(e.container)).toEqual([]);
  }, 180_000);

  it("Taches : liste, fiche, creation, modification, preuve, transition avec derogation (administrateur)", async () => {
    const aValider = tacheServeur({ id: T2, statut: "A_VALIDER", responsableEstMoi: false, transitionsPossibles: [transTache("TERMINEE", true, true), transTache("EN_COURS"), transTache("ANNULEE")] });
    const r = await ouvrir("ADMIN", {
      taches: pageServeur("taches", [tacheServeur(), aValider], { A_FAIRE: 1, A_VALIDER: 1 }),
      fichesTaches: { [T1]: ficheTacheServeur(tacheServeur(), [preuveServeur({ objetType: "TACHE", objetId: T1, type: "RELEVE_TERRAIN" })], [historiqueServeur()]), [T2]: ficheTacheServeur(aValider) },
    }, "Tâches");
    await screen.findByRole("list", { name: "Liste : taches" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Nouvelle tâche" }));
    let d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Lien"), "DEMANDE");
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await fermer(d);
    await userEvent.click(bouton("tache", T1));
    let f = await screen.findByTestId("fiche-tache");
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    for (const nom of ["Commencer la tâche", "Modifier la tâche", "Ajouter une preuve"]) {
      await userEvent.click(within(f).getByRole("button", { name: nom }));
      d = await dialogue();
      expect(await violationsAccessibilite(corps()), nom).toEqual([]);
      await fermer(d);
    }
    await userEvent.click(within(f).getByRole("button", { name: "Retour à la liste des tâches" }));
    await userEvent.click(bouton("tache", T2));
    f = await screen.findByTestId("fiche-tache");
    await userEvent.click(within(f).getByRole("button", { name: "Valider la tâche (par un tiers)" }));
    await dialogue();
    expect(await violationsAccessibilite(corps())).toEqual([]);
  }, 180_000);

  it("Recolements : liste, fiche (avant et apres), creation, modification, soumission, validation, rejet, preuve", async () => {
    const soumis = recolementServeur({ id: R2, statut: "SOUMIS", transitionsPossibles: [transRec("VALIDE", "VALIDER"), transRec("REJETE", "VALIDER"), transRec("BROUILLON")] });
    const r = await ouvrir("ADMIN", {
      recolements: pageServeur("recolements", [recolementServeur(), soumis], { BROUILLON: 1, SOUMIS: 1, VALIDE: 0, REJETE: 0 }),
      fichesRecolements: { [R1]: ficheRecolementServeur(recolementServeur(), [], [historiqueServeur(), historiqueModification()]), [R2]: ficheRecolementServeur(soumis, [preuveServeur()], [historiqueServeur()]) },
    }, "Récolements");
    await screen.findByRole("list", { name: "Liste : recolements" });
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Nouveau récolement" }));
    let d = await dialogue();
    await within(d).findByLabelText("Dossier de conflit");
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await fermer(d);
    await userEvent.click(bouton("recolement", R1));
    let f = await screen.findByTestId("fiche-recolement");
    expect(await violationsAccessibilite(r.container)).toEqual([]);
    for (const nom of ["Soumettre pour validation", "Modifier le brouillon", "Ajouter une preuve"]) {
      await userEvent.click(within(f).getByRole("button", { name: nom }));
      d = await dialogue();
      expect(await violationsAccessibilite(corps()), nom).toEqual([]);
      await fermer(d);
    }
    await userEvent.click(within(f).getByRole("button", { name: "Retour à la liste des récolements" }));
    await userEvent.click(bouton("recolement", R2));
    f = await screen.findByTestId("fiche-recolement");
    for (const nom of ["Valider le récolement (par un tiers)", "Rejeter le récolement"]) {
      await userEvent.click(within(f).getByRole("button", { name: nom }));
      d = await dialogue();
      expect(await violationsAccessibilite(corps()), nom).toEqual([]);
      await fermer(d);
    }
  }, 180_000);

  it("Referents (administrateur : rattachement et revocation ; gestionnaire : lecture seule) ; Dossiers et jeux", async () => {
    const a = await ouvrir("ADMIN", {}, "Référents");
    await screen.findByRole("list", { name: "Liste : référents" });
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Rattacher un compte" }));
    let d = await dialogue();
    await within(d).findByRole("radio", { name: /Ibrahima Referent/ });
    expect(await violationsAccessibilite(corps())).toEqual([]);
    await fermer(d);
    await userEvent.click(screen.getByRole("button", { name: /Révoquer le rattachement de/ }));
    d = await dialogue();
    expect(await violationsAccessibilite(corps())).toEqual([]);
    a.unmount();
    const b = await ouvrir("GESTIONNAIRE", {}, "Référents");
    await screen.findByTestId("referents-lecture-seule");
    expect(await violationsAccessibilite(b.container)).toEqual([]);
    await userEvent.click(screen.getByRole("tab", { name: "Dossiers et jeux" }));
    await screen.findByRole("list", { name: "Liste : jeux" });
    await screen.findByRole("list", { name: "Liste : dossiers de conflit" });
    expect(await violationsAccessibilite(b.container)).toEqual([]);
    b.unmount();
    const c = await ouvrir("REFERENT", { conflits: { conflits: [], curseurSuivant: null }, jeux: { jeux: [] } }, "Dossiers et jeux");
    await screen.findByText("Aucun jeu visible pour votre profil");
    expect(await violationsAccessibilite(c.container)).toEqual([]);
  }, 180_000);

  it("hors ligne (bandeau) et profil en erreur COMPTE_REFERENT_RESTREINT", async () => {
    const a = await ouvrir("GESTIONNAIRE", {}, "Demandes");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    await screen.findByText(/Vous êtes hors ligne/);
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    window.dispatchEvent(new Event("online"));
    h.get.mockImplementation(async (url: string) => { if (url.endsWith("/mon-profil")) throw erreurHttp(403, "COMPTE_REFERENT_RESTREINT"); return { data: {} }; });
    const r = rendre("/projets-voirie/p1/echanges");
    await screen.findByText(/n'ouvre que l'écran des échanges/);
    expect(await violationsAccessibilite(r.container)).toEqual([]);
  }, 90_000);
});
