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
import { brut, conflit, decision, fiche, pageConflits, preuve, serveurPage, transition } from "../components/projets-voirie/conflitsSynthetiques.testutil";
import { BASE, erreurHttp, rendrePage, reponseApi, type SurchargesApi } from "../components/projets-voirie/conflitsPage.testutil";
import type { ConflitFiche } from "../lib/projetsVoirieConflitsApi";
import { RAPPEL_SEPARATION, libelleTransition, type StatutConflit } from "../lib/projetsVoirieConflits";

/**
 * Actions d'un dossier de conflit : chaque transition valide du contrat (section 4), chaque refus type, justification obligatoire,
 * separation des taches et derogation ADMIN, attribution, preuve, proposition de decision (couts distincts), approbation, role lecteur.
 */

configure({ asyncUtilTimeout: 8000 });

function installer(over: SurchargesApi = {}) {
  h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApi(url, opts?.params, over));
}
const bouton = (id: string) => document.querySelector<HTMLButtonElement>(`button[data-conflit-id="${id}"]`)!;
const appelsFiche = () => h.get.mock.calls.filter((c) => c[0] === `${BASE}/conflits/cf-1`).length;

/** Ouvre la fiche de `cf-1` avec la fiche donnee, sous le role donne. */
async function ouvrir(f: ConflitFiche, role = "GESTIONNAIRE", userId = "u-gest") {
  h.role = role; h.userId = userId;
  installer({ fiches: { "cf-1": f }, liste: brut(serveurPage(pageConflits([conflit({ statut: f.statut })]))) });
  rendrePage();
  await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
  await screen.findByRole("list", { name: "Liste des conflits" });
  await userEvent.click(bouton("cf-1"));
  return screen.findByTestId("fiche-conflit");
}
async function dialogue() { return screen.findByRole("dialog"); }
async function saisir(d: HTMLElement, label: RegExp | string, texte: string) { await userEvent.type(within(d).getByLabelText(label), texte); }

beforeEach(() => {
  for (const f of [h.get, h.post, h.patch, h.delete]) f.mockReset();
  h.post.mockResolvedValue({ data: {} }); h.patch.mockResolvedValue({ data: {} });
  h.role = "GESTIONNAIRE"; h.userId = "u-gest";
  reinitialiserCarte();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => { Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true }); });

const T = (vers: StatutConflit, over: Parameters<typeof transition>[1] = {}) => transition(vers, over);

describe("transitions de statut : chaque transition valide du contrat", () => {
  const cas: Array<[StatutConflit, StatutConflit, string]> = [
    ["A_INVESTIGUER", "POTENTIEL", "GESTIONNAIRE"],
    ["A_INVESTIGUER", "INFIRME", "GESTIONNAIRE"],
    ["POTENTIEL", "CONFIRME", "GESTIONNAIRE"],
    ["POTENTIEL", "INFIRME", "GESTIONNAIRE"],
    ["POTENTIEL", "A_INVESTIGUER", "GESTIONNAIRE"],
    ["CONFIRME", "TRAITEMENT_DECIDE", "GESTIONNAIRE"],
    ["CONFIRME", "INFIRME", "ADMIN"],
    ["TRAITEMENT_DECIDE", "INFIRME", "ADMIN"],
    ["TRAITEMENT_DECIDE", "CLOTURE", "ADMIN"],
    ["INFIRME", "A_INVESTIGUER", "GESTIONNAIRE"],
  ];
  it.each(cas)("%s vers %s (%s) : bouton, justification de 10 caracteres, POST { vers, justification }", async (de, vers, role) => {
    const f = await ouvrir(fiche({ statut: de, transitions: [T(vers, { preuveRequise: de === "POTENTIEL" && vers === "CONFIRME", decisionRequise: de === "CONFIRME" && vers === "TRAITEMENT_DECIDE" })], preuves: [preuve()], decisions: de === "CONFIRME" || de === "TRAITEMENT_DECIDE" ? [decision({ statut: "APPROUVEE", option: "PROTEGER" })] : [] }), role);
    await userEvent.click(within(f).getByRole("button", { name: libelleTransition(de, vers) }));
    const d = await dialogue();
    const envoyer = within(d).getByRole("button", { name: "Enregistrer la transition" });
    expect(envoyer).toBeDisabled();
    await saisir(d, /Justification|Motif de la clôture/, "123456789");
    expect(envoyer).toBeDisabled();
    expect(within(d).getByText("9 / 10 caractères minimum")).toBeInTheDocument();
    await saisir(d, /Justification|Motif de la clôture/, "0");
    expect(envoyer).toBeEnabled();
    const avant = appelsFiche();
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/statut`, { vers, justification: "1234567890" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Le serveur est la source : la fiche est relue apres l'ecriture, aucun etat n'est devine.
    await waitFor(() => expect(appelsFiche()).toBeGreaterThan(avant));
  });

  it("seules les transitions du serveur sont proposees (pas celles du tableau) : POTENTIEL avec une seule transition", async () => {
    const f = await ouvrir(fiche({ statut: "POTENTIEL", transitions: [T("INFIRME")] }));
    const sec = within(f).getByRole("heading", { name: "Changer le statut" }).closest("section")!;
    expect(within(sec).getAllByRole("button").map((b) => b.textContent)).toEqual(["Infirmer ce conflit"]);
    expect(within(sec).queryByText(/à titre indicatif/)).toBeNull();
  });

  it("transition BLOQUEE pour l'instant (preuve manquante) : bouton inactif, raison dite en clair, aucune requete ; une decision manquante de meme", async () => {
    const f = await ouvrir(fiche({ statut: "POTENTIEL", preuves: [], transitions: [T("CONFIRME", { preuveRequise: true, bloquee: "PREUVE_REQUISE" }), T("INFIRME")] }));
    const b = within(f).getByRole("button", { name: "Confirmer ce conflit" });
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription(/Impossible pour l'instant : au moins une preuve est requise/);
    expect(within(f).getByTestId("transition-bloquee-CONFIRME")).toHaveTextContent("Ajoutez une preuve ci-dessous.");
    expect(within(f).getByRole("button", { name: "Infirmer ce conflit" })).toBeEnabled();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("transition bloquee faute de decision approuvee", async () => {
    const f = await ouvrir(fiche({ statut: "CONFIRME", decisions: [decision()], transitions: [T("TRAITEMENT_DECIDE", { decisionRequise: true, bloquee: "DECISION_REQUISE" })] }));
    expect(within(f).getByRole("button", { name: "Marquer le traitement décidé" })).toBeDisabled();
    expect(within(f).getByTestId("transition-bloquee-TRAITEMENT_DECIDE")).toHaveTextContent("une décision approuvée est requise");
  });
  it("la preuve ajoutee debloque la transition (la fiche est relue : le serveur redonne la liste)", async () => {
    const f = await ouvrir(fiche({ statut: "POTENTIEL", preuves: [], transitions: [T("CONFIRME", { preuveRequise: true, bloquee: "PREUVE_REQUISE" })] }));
    expect(within(f).getByRole("button", { name: "Confirmer ce conflit" })).toBeDisabled();
    h.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => reponseApi(url, opts?.params, { fiches: { "cf-1": fiche({ statut: "POTENTIEL", preuves: [preuve()], transitions: [T("CONFIRME", { preuveRequise: true })] }), } , liste: brut(serveurPage(pageConflits([conflit()]))) }));
    await userEvent.click(within(f).getByRole("button", { name: /Ajouter une preuve/ }));
    const d = await dialogue();
    await saisir(d, "Texte de la preuve", "Note de terrain");
    await userEvent.click(within(d).getByRole("button", { name: "Ajouter la preuve" }));
    await waitFor(() => expect(within(f).getByRole("button", { name: "Confirmer ce conflit" })).toBeEnabled());
  });

  it("le serveur n'en donne aucune : « aucune transition », jamais la table du contrat", async () => {
    const f = await ouvrir(fiche({ statut: "POTENTIEL", transitions: [] }));
    expect(within(f).getByTestId("aucune-transition")).toHaveTextContent("Aucune transition n'est possible pour votre compte dans cet état.");
    expect(within(f).queryByRole("button", { name: /Confirmer ce conflit/ })).toBeNull();
  });

  it("reponse sans liste de transitions : table de secours, signalee comme indicative", async () => {
    const f = await ouvrir(fiche({ statut: "POTENTIEL", transitions: null }));
    const sec = within(f).getByRole("heading", { name: "Changer le statut" }).closest("section")!;
    expect(within(sec).getAllByRole("button").map((b) => b.textContent)).toEqual(["Confirmer ce conflit", "Infirmer ce conflit", "Renvoyer à investiguer"]);
    expect(sec).toHaveTextContent("à titre indicatif d'après le contrat");
  });

  it("dossier clos : aucune transition ni action de modification", async () => {
    const f = await ouvrir(fiche({ statut: "CLOTURE", transitions: [] }), "ADMIN", "u-adm");
    expect(within(f).getByTestId("aucune-transition")).toHaveTextContent("Dossier clos");
    expect(within(f).queryByRole("button", { name: /Attribuer/ })).toBeNull();
    expect(within(f).queryByRole("button", { name: /Ajouter une preuve/ })).toBeNull();
    expect(within(f).queryByRole("button", { name: /Proposer une décision/ })).toBeNull();
  });

  it("la transition est un acte humain consigne : le dialogue le dit et n'ordonne aucun deplacement", async () => {
    const f = await ouvrir(fiche({ transitions: [T("CONFIRME", { preuveRequise: true })] }));
    await userEvent.click(within(f).getByRole("button", { name: "Confirmer ce conflit" }));
    const d = await dialogue();
    expect(d).toHaveTextContent("acte humain, consigné dans l'historique");
    expect(d).toHaveTextContent("n'ordonne aucun déplacement");
  });

  it("apres une transition acceptee, le focus ne retombe pas sur la page : il revient au bouton ou, a defaut, au titre de la fiche", async () => {
    const f = await ouvrir(fiche({ transitions: [T("INFIRME")] }));
    await userEvent.click(within(f).getByRole("button", { name: "Infirmer ce conflit" }));
    const d = await dialogue();
    await saisir(d, /Justification/, "Écarté après contrôle");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.body).not.toHaveFocus());
    expect(f.contains(document.activeElement)).toBe(true);
  });

  it("annuler ou Echap ferme sans rien envoyer et rend le focus au bouton d'origine", async () => {
    const f = await ouvrir(fiche({ transitions: [T("INFIRME")] }));
    const b = within(f).getByRole("button", { name: "Infirmer ce conflit" });
    await userEvent.click(b);
    await dialogue();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.post).not.toHaveBeenCalled();
    await waitFor(() => expect(b).toHaveFocus());
  });
});

describe("refus du serveur : messages clairs, le dialogue reste ouvert avec la saisie", () => {
  async function transitionRefusee(f: ConflitFiche, vers: StatutConflit, de: StatutConflit, erreur: unknown, role = "GESTIONNAIRE") {
    const racine = await ouvrir(f, role, role === "ADMIN" ? "u-adm" : "u-gest");
    h.post.mockRejectedValueOnce(erreur);
    await userEvent.click(within(racine).getByRole("button", { name: libelleTransition(de, vers) }));
    const d = await dialogue();
    await saisir(d, /Justification|Motif de la clôture/, "Justification suffisante");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    const alerte = await within(d).findByRole("alert");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect((within(d).getByLabelText(/Justification|Motif de la clôture/) as HTMLTextAreaElement).value).toBe("Justification suffisante");
    return { d, alerte };
  }

  it("409 TRANSITION_INTERDITE", async () => {
    const { alerte } = await transitionRefusee(fiche({ transitions: [T("CONFIRME", { preuveRequise: true })] }), "CONFIRME", "POTENTIEL", erreurHttp(409, "TRANSITION_INTERDITE"));
    expect(alerte).toHaveAttribute("data-code", "TRANSITION_INTERDITE");
    expect(alerte).toHaveTextContent("Cette transition n'est pas permise depuis le statut actuel");
    expect(alerte).toHaveTextContent("Rien n'a été modifié");
  });

  it("409 PREUVE_REQUISE : l'avertissement precede l'envoi (aucune preuve), le refus du serveur est affiche en clair", async () => {
    // Etat « perime » : le serveur proposait la transition comme faisable, puis a refuse (une preuve a pu etre ecartee entre-temps).
    const racine = await ouvrir(fiche({ statut: "POTENTIEL", preuves: [], transitions: [T("CONFIRME", { preuveRequise: true })] }));
    h.post.mockRejectedValueOnce(erreurHttp(409, "PREUVE_REQUISE"));
    await userEvent.click(within(racine).getByRole("button", { name: "Confirmer ce conflit" }));
    const d = await dialogue();
    expect(d).toHaveTextContent("Aucune preuve n'est au dossier");
    await saisir(d, /Justification/, "Confirmé sur le terrain");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    expect(await within(d).findByText(/Au moins une preuve est requise pour confirmer/)).toBeInTheDocument();
  });

  it("avec une preuve au dossier, le dialogue de confirmation la compte", async () => {
    const racine = await ouvrir(fiche({ statut: "POTENTIEL", preuves: [preuve()], transitions: [T("CONFIRME", { preuveRequise: true })] }));
    await userEvent.click(within(racine).getByRole("button", { name: "Confirmer ce conflit" }));
    expect(await dialogue()).toHaveTextContent("1 preuve(s) au dossier");
  });

  it("409 DECISION_REQUISE (CONFIRME vers TRAITEMENT_DECIDE sans decision approuvee)", async () => {
    const racine = await ouvrir(fiche({ statut: "CONFIRME", decisions: [decision()], transitions: [T("TRAITEMENT_DECIDE", { decisionRequise: true })] }));
    h.post.mockRejectedValueOnce(erreurHttp(409, "DECISION_REQUISE"));
    await userEvent.click(within(racine).getByRole("button", { name: "Marquer le traitement décidé" }));
    const d = await dialogue();
    expect(d).toHaveTextContent("Aucune décision approuvée");
    await saisir(d, /Justification/, "Traitement décidé en comité");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    expect(await within(d).findByText(/Une décision approuvée est requise avant de passer à « Traitement décidé »/)).toBeInTheDocument();
  });

  it("422 JUSTIFICATION_REQUISE", async () => {
    const { alerte } = await transitionRefusee(fiche({ transitions: [T("INFIRME")] }), "INFIRME", "POTENTIEL", erreurHttp(422, "JUSTIFICATION_REQUISE"));
    expect(alerte).toHaveTextContent("Une justification d'au moins 10 caractères est obligatoire");
  });

  it("409 SEPARATION_DES_TACHES a la cloture : un ADMIN voit alors le champ de derogation", async () => {
    const f = fiche({ statut: "TRAITEMENT_DECIDE", decisions: [decision({ statut: "APPROUVEE" })], transitions: [T("CLOTURE")] });
    const racine = await ouvrir(f, "ADMIN", "u-adm");
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES"));
    await userEvent.click(within(racine).getByRole("button", { name: "Clore le dossier" }));
    const d = await dialogue();
    await saisir(d, /Motif de la clôture/, "Clôture après contrôle");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    expect(await within(d).findByText(/Séparation des tâches : la personne qui a proposé/)).toBeInTheDocument();
    expect(within(d).getByLabelText(/Dérogation à la séparation des tâches/)).toBeInTheDocument();
    await saisir(d, /Dérogation à la séparation des tâches/, "Seul compte habilité disponible");
    h.post.mockResolvedValueOnce({ data: {} });
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/statut`, { vers: "CLOTURE", justification: "Clôture après contrôle", derogation: "Seul compte habilité disponible" }));
  });

  it("un gestionnaire ne voit JAMAIS le champ de derogation, meme apres SEPARATION_DES_TACHES", async () => {
    const { d } = await transitionRefusee(fiche({ transitions: [T("CONFIRME", { preuveRequise: true })] }), "CONFIRME", "POTENTIEL", erreurHttp(409, "SEPARATION_DES_TACHES"));
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
  });

  it("erreur reseau : message de reseau, saisie conservee", async () => {
    const { alerte } = await transitionRefusee(fiche({ transitions: [T("INFIRME")] }), "INFIRME", "POTENTIEL", new Error("Network Error"));
    expect(alerte).toHaveTextContent("Le serveur est injoignable");
  });

  it("503 PROJET_OCCUPE et 504 sur une ecriture : expliques", async () => {
    const a = await transitionRefusee(fiche({ transitions: [T("INFIRME")] }), "INFIRME", "POTENTIEL", erreurHttp(503, "PROJET_OCCUPE"));
    expect(a.alerte).toHaveTextContent("Ce projet ou ce dossier est occupé");
  });
});

describe("cloture apres une decision de deplacement : le recolement reste a valider", () => {
  it("case obligatoire ; le champ explicite `recolementAValider` part avec la justification telle quelle", async () => {
    const f = fiche({ statut: "TRAITEMENT_DECIDE", decisions: [decision({ option: "DEPLACER_RESEAU", statut: "APPROUVEE" })], transitions: [T("CLOTURE")] });
    const racine = await ouvrir(f, "ADMIN", "u-adm");
    await userEvent.click(within(racine).getByRole("button", { name: "Clore le dossier" }));
    const d = await dialogue();
    await saisir(d, /Motif de la clôture/, "Réseau déplacé, contrôle fait");
    const envoyer = within(d).getByRole("button", { name: "Enregistrer la transition" });
    expect(envoyer).toBeDisabled();
    await userEvent.click(within(d).getByRole("checkbox", { name: /le récolement reste à valider/ }));
    expect(envoyer).toBeEnabled();
    await userEvent.click(envoyer);
    // Champ explicite du backend (`recolementAValider`), justification non alteree.
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/statut`, { vers: "CLOTURE", justification: "Réseau déplacé, contrôle fait", recolementAValider: true }));
  });

  it("autre option : pas de case de recolement", async () => {
    const f = fiche({ statut: "TRAITEMENT_DECIDE", decisions: [decision({ option: "PROTEGER", statut: "APPROUVEE" })], transitions: [T("CLOTURE")] });
    const racine = await ouvrir(f, "ADMIN", "u-adm");
    await userEvent.click(within(racine).getByRole("button", { name: "Clore le dossier" }));
    const d = await dialogue();
    expect(within(d).queryByRole("checkbox")).toBeNull();
    expect(d).toHaveTextContent("réservée aux administrateurs");
    await saisir(d, /Motif de la clôture/, "Traitement terminé et contrôlé");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/statut`, { vers: "CLOTURE", justification: "Traitement terminé et contrôlé" }));
    expect(h.post.mock.calls.at(-1)![1]).not.toHaveProperty("recolementAValider");
  });

  it("422 MENTION_RECOLEMENT_REQUISE (garde du serveur) : message en clair", async () => {
    const f = fiche({ statut: "TRAITEMENT_DECIDE", decisions: [decision({ option: "PROTEGER", statut: "APPROUVEE" })], transitions: [T("CLOTURE")] });
    const racine = await ouvrir(f, "ADMIN", "u-adm");
    h.post.mockRejectedValueOnce(erreurHttp(422, "MENTION_RECOLEMENT_REQUISE"));
    await userEvent.click(within(racine).getByRole("button", { name: "Clore le dossier" }));
    const d = await dialogue();
    await saisir(d, /Motif de la clôture/, "Clôture après contrôle");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("confirmez que le récolement reste à valider");
  });

  it("403 ROLE_INSUFFISANT (gestionnaire qui tente une transition reservee aux administrateurs) : message du lot, pas celui des largeurs", async () => {
    const f = fiche({ statut: "TRAITEMENT_DECIDE", decisions: [decision({ statut: "APPROUVEE" })], transitions: [T("CLOTURE")] });
    const racine = await ouvrir(f, "ADMIN", "u-adm");
    h.post.mockRejectedValueOnce(erreurHttp(403, "ROLE_INSUFFISANT"));
    await userEvent.click(within(racine).getByRole("button", { name: "Clore le dossier" }));
    const d = await dialogue();
    await saisir(d, /Motif de la clôture/, "Clôture après contrôle");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer la transition" }));
    const a = await within(d).findByRole("alert");
    expect(a).toHaveTextContent("clore un dossier et approuver une règle sont réservés aux administrateurs");
    expect(a).not.toHaveTextContent("largeurs");
  });

  it("la cloture montre un champ de derogation facultatif a l'ADMIN, jamais a un gestionnaire", async () => {
    const f = fiche({ statut: "TRAITEMENT_DECIDE", decisions: [decision({ statut: "APPROUVEE" })], transitions: [T("CLOTURE")] });
    const racine = await ouvrir(f, "ADMIN", "u-adm");
    await userEvent.click(within(racine).getByRole("button", { name: "Clore le dossier" }));
    const d = await dialogue();
    expect(within(d).getByLabelText(/Dérogation à la séparation des tâches \(réservée aux administrateurs\), facultative/)).toBeInTheDocument();
  });
});

describe("attribution : responsable, echeance, risque, action proposee", () => {
  it("seuls les champs modifies partent ; rien a envoyer = bouton inactif", async () => {
    const f = await ouvrir(fiche());
    await userEvent.click(within(f).getByRole("button", { name: /Attribuer ou modifier/ }));
    const d = await dialogue();
    const envoyer = within(d).getByRole("button", { name: "Enregistrer l'attribution" });
    expect(envoyer).toBeDisabled();
    expect(d).toHaveTextContent("Aucun changement à enregistrer");
    fireDate(within(d).getByLabelText("Échéance"), "2026-12-15");
    await userEvent.selectOptions(within(d).getByLabelText("Risque"), "ELEVE");
    await userEvent.selectOptions(within(d).getByLabelText("Responsable"), "moi");
    await userEvent.clear(within(d).getByLabelText(/Action proposée/));
    await userEvent.type(within(d).getByLabelText(/Action proposée/), "Faire sonder le fourreau");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { responsableId: "u-gest", echeance: "2026-12-15", risque: "ELEVE", actionProposee: "Faire sonder le fourreau" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("retirer le responsable et vider l'echeance : null explicite", async () => {
    const f = await ouvrir(fiche());
    await userEvent.click(within(f).getByRole("button", { name: /Attribuer ou modifier/ }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Responsable"), "aucun");
    fireDate(within(d).getByLabelText("Échéance"), "");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer l'attribution" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { responsableId: null, echeance: null }));
  });

  it("autre compte : identifiant saisi, vide refuse ; « risque inconnu » est un niveau a part", async () => {
    const f = await ouvrir(fiche({ responsable: null, risque: null }));
    await userEvent.click(within(f).getByRole("button", { name: /Attribuer ou modifier/ }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Responsable"), "autre");
    const envoyer = within(d).getByRole("button", { name: "Enregistrer l'attribution" });
    expect(envoyer).toBeDisabled();
    await userEvent.type(within(d).getByLabelText("Identifiant du compte responsable"), "u-autre");
    await userEvent.selectOptions(within(d).getByLabelText("Risque"), "INCONNU");
    expect(d).toHaveTextContent("« Risque inconnu » est un niveau à part : il ne vaut pas « faible ».");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { responsableId: "u-autre", risque: "INCONNU" }));
  });

  it("effacer le risque : null explicite (le backend l'accepte)", async () => {
    const f = await ouvrir(fiche());
    await userEvent.click(within(f).getByRole("button", { name: /Attribuer ou modifier/ }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Risque"), "aucun");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer l'attribution" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { risque: null }));
  });

  it("400 RESPONSABLE_INCONNU : message en clair", async () => {
    const f = await ouvrir(fiche());
    await userEvent.click(within(f).getByRole("button", { name: /Attribuer ou modifier/ }));
    const d = await dialogue();
    h.patch.mockRejectedValueOnce(erreurHttp(400, "RESPONSABLE_INCONNU"));
    await userEvent.selectOptions(within(d).getByLabelText("Responsable"), "autre");
    await userEvent.type(within(d).getByLabelText("Identifiant du compte responsable"), "u-fantome");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer l'attribution" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("n'existe pas ou n'est pas actif");
  });

  it("refus du serveur : message en clair, dialogue ouvert", async () => {
    const f = await ouvrir(fiche());
    await userEvent.click(within(f).getByRole("button", { name: /Attribuer ou modifier/ }));
    const d = await dialogue();
    h.patch.mockRejectedValueOnce(erreurHttp(409, "TRANSITION_INTERDITE"));
    await userEvent.selectOptions(within(d).getByLabelText("Risque"), "FAIBLE");
    await userEvent.click(within(d).getByRole("button", { name: "Enregistrer l'attribution" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("n'est pas permise");
  });
});

function fireDate(el: HTMLElement, valeur: string) {
  // `userEvent.type` ne sait pas saisir une date : on pose la valeur comme le ferait le selecteur du navigateur.
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, valeur);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("acquittement d'un re-examen (aReexaminer: false)", () => {
  const aReexaminer = (over = {}) => fiche({ statut: "CONFIRME", transitions: [], aReexaminer: true, motifReexamen: "NON_RETROUVE", ...over });

  it("un dossier a reexaminer propose « Marquer comme reexamine » : justification de 10 caracteres, PATCH { aReexaminer: false, justification }", async () => {
    const f = await ouvrir(aReexaminer());
    await userEvent.click(within(f).getByRole("button", { name: "Marquer comme réexaminé" }));
    const d = await dialogue();
    expect(d).toHaveTextContent("Cela ne change ni le statut ni aucun autre verdict du dossier");
    const envoyer = within(d).getByRole("button", { name: "Marquer comme réexaminé" });
    expect(envoyer).toBeDisabled();
    await saisir(d, /Justification/, "Revu avec le concessionnaire");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith(`${BASE}/conflits/cf-1`, { aReexaminer: false, justification: "Revu avec le concessionnaire" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("refus 422 JUSTIFICATION_REQUISE : message du lot", async () => {
    const f = await ouvrir(aReexaminer());
    await userEvent.click(within(f).getByRole("button", { name: "Marquer comme réexaminé" }));
    const d = await dialogue();
    h.patch.mockRejectedValueOnce(erreurHttp(422, "JUSTIFICATION_REQUISE"));
    await saisir(d, /Justification/, "Revu avec le concessionnaire");
    await userEvent.click(within(d).getByRole("button", { name: "Marquer comme réexaminé" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("justification d'au moins 10 caractères");
  });
  it("pas de bouton pour un dossier qui n'est pas a reexaminer, ni pour un lecteur", async () => {
    const a = await ouvrir(fiche());
    expect(within(a).queryByRole("button", { name: "Marquer comme réexaminé" })).toBeNull();
  });
  it("lecteur : le dossier a reexaminer est signale mais aucun bouton d'acquittement", async () => {
    const f = await ouvrir(aReexaminer(), "LECTEUR", "u-lect");
    expect(within(f).getByText(/Une nouvelle analyse ne l'a pas retrouvé/)).toBeInTheDocument();
    expect(within(f).queryByRole("button", { name: "Marquer comme réexaminé" })).toBeNull();
  });
});

describe("preuve", () => {
  it("type, texte, reference : POST ; texte vide refuse ; aucun fichier", async () => {
    const f = await ouvrir(fiche());
    await userEvent.click(within(f).getByRole("button", { name: /Ajouter une preuve/ }));
    const d = await dialogue();
    expect(d).toHaveTextContent("Aucun fichier n'est joint dans ce lot");
    const envoyer = within(d).getByRole("button", { name: "Ajouter la preuve" });
    expect(envoyer).toBeDisabled();
    expect(d.querySelector("input[type=file]")).toBeNull();
    await userEvent.selectOptions(within(d).getByLabelText("Type de preuve"), "RELEVE_TERRAIN");
    await saisir(d, "Texte de la preuve", "Fourreau visible à 0,8 m");
    await saisir(d, /Référence/, "Plan 3");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/preuves`, { type: "RELEVE_TERRAIN", texte: "Fourreau visible à 0,8 m", reference: "Plan 3" }));
  });

  it("sans reference : le champ n'est pas envoye", async () => {
    const f = await ouvrir(fiche());
    await userEvent.click(within(f).getByRole("button", { name: /Ajouter une preuve/ }));
    const d = await dialogue();
    await saisir(d, "Texte de la preuve", "Note de terrain");
    await userEvent.click(within(d).getByRole("button", { name: "Ajouter la preuve" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/preuves`, { type: "NOTE", texte: "Note de terrain" }));
  });

  it("le contenu d'une preuve est rendu en TEXTE (aucun HTML injecte)", async () => {
    const f = await ouvrir(fiche({ preuves: [preuve({ texte: "<img src=x onerror=alert(1)> note", reference: "<b>réf</b>" })] }));
    expect(within(f).getByText(/<img src=x onerror=alert\(1\)> note/)).toBeInTheDocument();
    expect(f.querySelector("img")).toBeNull();
    expect(f.querySelector("b")).toBeNull();
  });
});

describe("proposition de decision : couts estime et reel distincts, jamais calcules", () => {
  async function ouvrirProposition(role = "GESTIONNAIRE") {
    const f = await ouvrir(fiche({ statut: "CONFIRME", transitions: [], decisions: [] }), role, role === "ADMIN" ? "u-adm" : "u-gest");
    await userEvent.click(within(f).getByRole("button", { name: /Proposer une décision/ }));
    return dialogue();
  }

  it("le bouton n'existe que pour un dossier CONFIRME et un compte qui ecrit", async () => {
    const f = await ouvrir(fiche({ statut: "POTENTIEL" }));
    expect(within(f).queryByRole("button", { name: /Proposer une décision/ })).toBeNull();
  });

  it("option, justification : POST ; aucun cout n'est envoye s'il n'est pas saisi (pas de zero invente)", async () => {
    const d = await ouvrirProposition();
    const envoyer = within(d).getByRole("button", { name: "Proposer la décision" });
    expect(envoyer).toBeDisabled();
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "ADAPTER_PROJET");
    await saisir(d, /Justification/, "Décaler la bordure de 2 m");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/decisions`, { option: "ADAPTER_PROJET", justification: "Décaler la bordure de 2 m" }));
    const corps = h.post.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(corps).not.toHaveProperty("coutEstime");
    expect(corps).not.toHaveProperty("coutReel");
  });

  it("estime seul : coutReel absent ; les deux : deux champs distincts ; un reel a 0 est envoye (saisi, pas calcule)", async () => {
    const d = await ouvrirProposition();
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "PROTEGER");
    await saisir(d, /Justification/, "Protection mécanique du fourreau");
    await saisir(d, "Coût estimé", "12000,5");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeDisabled();
    expect(d).toHaveTextContent("Indiquez la devise des coûts saisis");
    await saisir(d, /Devise des coûts/, "GNF");
    await saisir(d, "Coût réel", "0");
    fireDate(within(d).getByLabelText("Début prévu"), "2027-01-10");
    fireDate(within(d).getByLabelText("Fin prévue"), "2027-01-20");
    await saisir(d, /Contraintes/, "Travaux de nuit");
    await userEvent.click(within(d).getByRole("button", { name: "Proposer la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/decisions`, {
      option: "PROTEGER", justification: "Protection mécanique du fourreau", contraintes: "Travaux de nuit", coutEstime: 12000.5, coutReel: 0, deviseCout: "GNF", dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20",
    }));
  });

  it("l'avertissement le dit : aucun cout n'est calcule ni somme ; aucun champ « total »", async () => {
    const d = await ouvrirProposition();
    expect(d).toHaveTextContent("l'outil ne calcule, ne déduit et ne somme aucun coût");
    expect(within(d).queryByLabelText(/total|écart/i)).toBeNull();
  });

  it("erreurs de saisie dites en clair : cout negatif, texte, dates inversees", async () => {
    const d = await ouvrirProposition();
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "A_ETUDIER");
    await saisir(d, /Justification/, "À étudier avec le bureau");
    await saisir(d, "Coût réel", "-3");
    await saisir(d, /Devise des coûts/, "GNF");
    expect(within(d).getByRole("status", { name: "Points à corriger" })).toHaveTextContent("Le coût réel ne peut pas être négatif.");
    await userEvent.clear(within(d).getByLabelText("Coût réel"));
    await saisir(d, "Coût estimé", "beaucoup");
    expect(within(d).getByRole("status", { name: "Points à corriger" })).toHaveTextContent("Le coût estimé n'est pas un nombre.");
    await userEvent.clear(within(d).getByLabelText("Coût estimé"));
    fireDate(within(d).getByLabelText("Début prévu"), "2027-02-10");
    fireDate(within(d).getByLabelText("Fin prévue"), "2027-02-01");
    expect(within(d).getByRole("status", { name: "Points à corriger" })).toHaveTextContent("La date de fin prévue ne peut pas précéder");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeDisabled();
  });

  it("devise : trois lettres majuscules (saisie mise en majuscules, limitee a 3), exigee des qu'un cout est saisi", async () => {
    const d = await ouvrirProposition();
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "PROTEGER");
    await saisir(d, /Justification/, "Protection mécanique du fourreau");
    await saisir(d, "Coût estimé", "100");
    const devise = within(d).getByLabelText(/Devise des coûts/) as HTMLInputElement;
    await userEvent.type(devise, "gnfx");
    expect(devise.value).toBe("GNF");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeEnabled();
    await userEvent.clear(devise);
    await userEvent.type(devise, "gn");
    expect(within(d).getByRole("status", { name: "Points à corriger" })).toHaveTextContent("trois lettres majuscules");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeDisabled();
  });

  it("deplacer un reseau exige un planning complet ; sans responsable sur le dossier, la proposition est refusee d'emblee avec la marche a suivre", async () => {
    const d = await ouvrirProposition();
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "DEPLACER_RESEAU");
    await saisir(d, /Justification/, "Le réseau est sous la future chaussée");
    expect(within(d).getByRole("status", { name: "Points à corriger" })).toHaveTextContent("planning complet");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeDisabled();
    fireDate(within(d).getByLabelText("Début prévu"), "2027-01-10");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeDisabled();
    fireDate(within(d).getByLabelText("Fin prévue"), "2027-01-20");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeEnabled();
    await userEvent.click(within(d).getByRole("button", { name: "Proposer la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/decisions`, { option: "DEPLACER_RESEAU", justification: "Le réseau est sous la future chaussée", dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20" }));
  });

  it("deplacer un reseau sur un dossier SANS responsable : bouton inactif, on dit d'attribuer d'abord", async () => {
    const f = await ouvrir(fiche({ statut: "CONFIRME", transitions: [], decisions: [], responsable: null }));
    await userEvent.click(within(f).getByRole("button", { name: /Proposer une décision/ }));
    const d = await dialogue();
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "DEPLACER_RESEAU");
    await saisir(d, /Justification/, "Le réseau est sous la future chaussée");
    fireDate(within(d).getByLabelText("Début prévu"), "2027-01-10");
    fireDate(within(d).getByLabelText("Fin prévue"), "2027-01-20");
    expect(within(d).getByRole("status", { name: "Points à corriger" })).toHaveTextContent("Désignez d'abord un responsable sur le dossier");
    expect(within(d).getByRole("button", { name: "Proposer la décision" })).toBeDisabled();
  });

  it("422 RESPONSABLE_REQUIS et PLANNING_REQUIS (gardes du serveur) : messages en clair", async () => {
    const d = await ouvrirProposition();
    h.post.mockRejectedValueOnce(erreurHttp(422, "PLANNING_REQUIS"));
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "PROTEGER");
    await saisir(d, /Justification/, "Protection mécanique");
    await userEvent.click(within(d).getByRole("button", { name: "Proposer la décision" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Le planning est incomplet ou incohérent");
    h.post.mockRejectedValueOnce(erreurHttp(422, "RESPONSABLE_REQUIS"));
    await userEvent.click(within(d).getByRole("button", { name: "Proposer la décision" }));
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent("responsable doit être désigné"));
  });

  it("409 STATUT_INCOMPATIBLE : le dossier n'est plus confirme, message du lot (pas celui des jeux)", async () => {
    const d = await ouvrirProposition();
    h.post.mockRejectedValueOnce(erreurHttp(409, "STATUT_INCOMPATIBLE"));
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "PROTEGER");
    await saisir(d, /Justification/, "Protection mécanique");
    await userEvent.click(within(d).getByRole("button", { name: "Proposer la décision" }));
    const a = await within(d).findByRole("alert");
    expect(a).toHaveTextContent("une décision ne se propose et ne se tranche que pour un conflit confirmé");
    expect(a).not.toHaveTextContent("Ce jeu");
  });

  it("« Deplacer le reseau » : une PROPOSITION, avertissement de separation des taches et de recolement", async () => {
    const d = await ouvrirProposition();
    const sel = within(d).getByLabelText("Option") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      "Choisir une option", "Protéger le réseau en place", "Adapter le projet", "Déplacer le réseau (proposition)", "Sans intervention", "À étudier",
    ]);
    await userEvent.selectOptions(sel, "DEPLACER_RESEAU");
    expect(d).toHaveTextContent("Proposer le déplacement d'un réseau n'ordonne rien");
    expect(d).toHaveTextContent("Il exige un responsable désigné sur le dossier et un planning complet");
    expect(d).toHaveTextContent("le récolement restera à valider hors de cet outil");
    expect(d).toHaveTextContent("n'ordonne et n'exécute rien");
  });

  it("refus du serveur (409 TRANSITION_INTERDITE) : message, dialogue ouvert", async () => {
    const d = await ouvrirProposition();
    h.post.mockRejectedValueOnce(erreurHttp(409, "TRANSITION_INTERDITE"));
    await userEvent.selectOptions(within(d).getByLabelText("Option"), "PROTEGER");
    await saisir(d, /Justification/, "Protection mécanique");
    await userEvent.click(within(d).getByRole("button", { name: "Proposer la décision" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("n'est pas permise");
  });
});

describe("approbation et refus d'une decision : separation des taches, derogation proposee selon la reponse du serveur", () => {
  const proposee = (over = {}) => decision({ id: "d1", statut: "PROPOSEE", option: "DEPLACER_RESEAU", proposePar: { id: "u-gest", nom: "Moussa Gestionnaire" }, ...over });

  const ouvrirFicheAvecDecision = () => ouvrir(fiche({ statut: "CONFIRME", transitions: [], decisions: [proposee()] }), "GESTIONNAIRE", "u-autre");

  async function ouvrirApprobation(role: string, userId: string, d = proposee(), verdict: "Approuver" | "Refuser" = "Approuver") {
    const f = await ouvrir(fiche({ statut: "CONFIRME", transitions: [], decisions: [d] }), role, userId);
    await userEvent.click(within(f).getByRole("button", { name: new RegExp(`^${verdict} la décision`) }));
    return dialogue();
  }

  it("le dialogue rappelle la separation des taches", async () => {
    const d = await ouvrirApprobation("GESTIONNAIRE", "u-autre");
    expect(d).toHaveTextContent(RAPPEL_SEPARATION);
    expect(d).toHaveTextContent("ne déclenche aucun déplacement ni aucun ordre");
  });

  it("approuver une decision proposee par quelqu'un d'autre : motif de 10 caracteres, POST { motif }, pas de champ de derogation (gestionnaire)", async () => {
    const d = await ouvrirApprobation("GESTIONNAIRE", "u-autre");
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
    const envoyer = within(d).getByRole("button", { name: "Approuver la décision" });
    expect(envoyer).toBeDisabled();
    await saisir(d, /Motif/, "Approuvé en comité technique");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/decisions/d1/approuver`, { motif: "Approuvé en comité technique" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuser : POST sur /refuser", async () => {
    const d = await ouvrirApprobation("GESTIONNAIRE", "u-autre", proposee(), "Refuser");
    expect(d).toHaveTextContent("Le refus est consigné dans l'historique");
    await saisir(d, /Motif/, "Option non retenue par le comité");
    await userEvent.click(within(d).getByRole("button", { name: "Refuser la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/decisions/d1/refuser`, { motif: "Option non retenue par le comité" }));
  });

  it("gestionnaire qui approuve SA proposition : on ne devine pas son droit ; le serveur oppose SEPARATION_DES_TACHES, le champ de derogation apparait, l'envoi est rejoue avec elle", async () => {
    const d = await ouvrirApprobation("GESTIONNAIRE", "u-gest", proposee({ option: "PROTEGER" }));
    expect(d).toHaveTextContent("Vous avez proposé cette décision : un autre compte habilité doit en principe l'approuver. Si vous essayez quand même, le serveur dit si votre compte peut déroger");
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES", "La personne qui a proposé une décision ne peut pas la trancher elle-même sans dérogation motivée (10 caractères au moins)."));
    await saisir(d, /Motif/, "Je suis le seul compte habilité");
    await userEvent.click(within(d).getByRole("button", { name: "Approuver la décision" }));
    const alerte = await within(d).findByRole("alert");
    expect(alerte).toHaveAttribute("data-code", "SEPARATION_DES_TACHES");
    expect(alerte).toHaveTextContent("Séparation des tâches");
    // La précision du serveur complète le message en clair.
    expect(alerte).toHaveTextContent("Précision du serveur : La personne qui a proposé une décision ne peut pas la trancher elle-même");
    const champ = await within(d).findByLabelText(/Dérogation à la séparation des tâches : motif obligatoire ici/);
    expect(within(d).queryByText(/réservée aux administrateurs/)).toBeNull();
    const envoyer = within(d).getByRole("button", { name: "Approuver la décision" });
    expect(envoyer).toBeDisabled();
    await userEvent.type(champ, "Seul compte habilité du périmètre");
    expect(envoyer).toBeEnabled();
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/decisions/d1/approuver`, { motif: "Je suis le seul compte habilité", derogation: "Seul compte habilité du périmètre" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("REFUS de sa propre proposition : meme parcours (SEPARATION_DES_TACHES, champ de derogation, rejeu sur /refuser avec la derogation)", async () => {
    const d = await ouvrirApprobation("GESTIONNAIRE", "u-gest", proposee({ option: "A_ETUDIER" }), "Refuser");
    expect(d).toHaveTextContent("un autre compte habilité doit en principe la refuser");
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES"));
    await saisir(d, /Motif/, "Option abandonnée, étude faite");
    await userEvent.click(within(d).getByRole("button", { name: "Refuser la décision" }));
    await within(d).findByRole("alert");
    const champ = await within(d).findByLabelText(/Dérogation à la séparation des tâches : motif obligatoire ici/);
    await userEvent.type(champ, "Seul compte habilité");
    await userEvent.click(within(d).getByRole("button", { name: "Refuser la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${BASE}/conflits/cf-1/decisions/d1/refuser`, { motif: "Option abandonnée, étude faite", derogation: "Seul compte habilité" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("le champ de derogation reste affiche pendant l'envoi rejoue ; si le serveur refuse encore, sa precision est dite et le champ reste", async () => {
    const d = await ouvrirApprobation("GESTIONNAIRE", "u-gest", proposee({ option: "PROTEGER" }));
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES"));
    await saisir(d, /Motif/, "Je suis le seul compte habilité");
    await userEvent.click(within(d).getByRole("button", { name: "Approuver la décision" }));
    const champ = await within(d).findByLabelText(/Dérogation à la séparation des tâches/);
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES", "Plusieurs comptes habilités existent : seul un administrateur peut déroger à la séparation des tâches."));
    await userEvent.type(champ, "Je suis le seul compte habilité");
    await userEvent.click(within(d).getByRole("button", { name: "Approuver la décision" }));
    const alerte = await within(d).findByRole("alert");
    expect(alerte).toHaveTextContent("Précision du serveur : Plusieurs comptes habilités existent : seul un administrateur peut déroger");
    expect(within(d).getByLabelText(/Dérogation à la séparation des tâches/)).toBeInTheDocument();
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("l'aide dit qu'une decision tranchee ne s'annule pas mais se remplace par une nouvelle proposition (dialogue et fiche)", async () => {
    const f = await ouvrirFicheAvecDecision();
    expect(within(f).getByTestId("aide-decision-fiche")).toHaveTextContent("ne peut être ni annulée ni modifiée, coûts compris : elle ne peut qu'être remplacée par une nouvelle proposition");
    await userEvent.click(within(f).getByRole("button", { name: /^Approuver la décision/ }));
    const d = await dialogue();
    expect(within(d).getByTestId("aide-decision-tranchee")).toHaveTextContent("Tant que le dossier est « Confirmé », proposez-en une nouvelle");
  });

  it("ADMIN qui approuve SA proposition de deplacement : champ de derogation, motif obligatoire, envoye", async () => {
    const d = await ouvrirApprobation("ADMIN", "u-gest");
    expect(d).toHaveTextContent("Vous avez proposé cette décision de déplacement de réseau : seule une dérogation motivée permet de l'approuver vous-même");
    const envoyer = within(d).getByRole("button", { name: "Approuver la décision" });
    await saisir(d, /Motif/, "Approuvé en comité technique");
    expect(envoyer).toBeDisabled();
    await saisir(d, /Dérogation à la séparation des tâches : motif obligatoire ici/, "Un seul compte habilité");
    expect(envoyer).toBeEnabled();
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/decisions/d1/approuver`, { motif: "Approuvé en comité technique", derogation: "Un seul compte habilité" }));
  });

  it("ADMIN qui approuve SA proposition (autre option que le deplacement) : la derogation est exigee aussi", async () => {
    const d = await ouvrirApprobation("ADMIN", "u-gest", proposee({ option: "PROTEGER" }));
    expect(d).toHaveTextContent("Vous avez proposé cette décision : seule une dérogation motivée permet de l'approuver vous-même.");
    await saisir(d, /Motif/, "Approuvé en comité technique");
    const envoyer = within(d).getByRole("button", { name: "Approuver la décision" });
    expect(envoyer).toBeDisabled();
    await saisir(d, /Dérogation à la séparation des tâches/, "Un seul compte habilité");
    expect(envoyer).toBeEnabled();
  });

  it("409 DECISION_DEJA_TRANCHEE : message en clair", async () => {
    const d = await ouvrirApprobation("GESTIONNAIRE", "u-autre");
    h.post.mockRejectedValueOnce(erreurHttp(409, "DECISION_DEJA_TRANCHEE"));
    await saisir(d, /Motif/, "Approuvé en comité technique");
    await userEvent.click(within(d).getByRole("button", { name: "Approuver la décision" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("vient d'être tranchée");
  });

  it("on ne tranche une decision que pour un conflit CONFIRME : dossier decide, aucun bouton Approuver ou Refuser", async () => {
    const f = await ouvrir(fiche({ statut: "TRAITEMENT_DECIDE", transitions: [], decisions: [proposee()] }), "ADMIN", "u-adm");
    expect(within(f).queryByRole("button", { name: /Approuver la décision|Refuser la décision/ })).toBeNull();
  });

  it("ADMIN qui approuve la proposition d'un autre : pas de derogation d'emblee ; elle apparait si le serveur oppose la separation", async () => {
    const d = await ouvrirApprobation("ADMIN", "u-adm");
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
    h.post.mockRejectedValueOnce(erreurHttp(409, "SEPARATION_DES_TACHES"));
    await saisir(d, /Motif/, "Approuvé en comité technique");
    await userEvent.click(within(d).getByRole("button", { name: "Approuver la décision" }));
    await within(d).findByRole("alert");
    expect(await within(d).findByLabelText(/Dérogation à la séparation des tâches/)).toBeInTheDocument();
  });

  it("ADMIN qui REFUSE SA proposition : le champ de derogation est propose d'emblee, motif obligatoire, envoye sur /refuser", async () => {
    const d = await ouvrirApprobation("ADMIN", "u-gest", proposee(), "Refuser");
    expect(d).toHaveTextContent("seule une dérogation motivée permet de la refuser vous-même");
    await saisir(d, /Motif/, "Option abandonnée par le comité");
    const envoyer = within(d).getByRole("button", { name: "Refuser la décision" });
    expect(envoyer).toBeDisabled();
    await saisir(d, /Dérogation à la séparation des tâches : motif obligatoire ici/, "Un seul compte habilité");
    await userEvent.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${BASE}/conflits/cf-1/decisions/d1/refuser`, { motif: "Option abandonnée par le comité", derogation: "Un seul compte habilité" }));
  });

  it("refuser la proposition d'un autre : aucun champ de derogation tant que le serveur ne l'oppose pas", async () => {
    const d = await ouvrirApprobation("ADMIN", "u-adm", proposee(), "Refuser");
    expect(within(d).queryByLabelText(/Dérogation/)).toBeNull();
  });

  it("les decisions deja approuvees ou refusees n'ont plus de bouton", async () => {
    const f = await ouvrir(fiche({ statut: "CONFIRME", transitions: [], decisions: [proposee({ id: "d1", statut: "APPROUVEE" }), proposee({ id: "d2", statut: "REFUSEE" }), proposee({ id: "d3", statut: "ANNULEE" })] }), "ADMIN", "u-adm");
    expect(within(f).queryByRole("button", { name: /Approuver la décision|Refuser la décision/ })).toBeNull();
  });
});

describe("role lecteur : aucune action d'ecriture", () => {
  const NOMS_ECRITURE = /Lancer une analyse|Exporter|Attribuer|Ajouter une preuve|Proposer une décision|Approuver|Refuser|Confirmer ce conflit|Infirmer|Clore|Marquer le traitement|Renvoyer|Rouvrir|Qualifier|Créer un brouillon/;

  it("liste : ni lancement d'analyse, ni export CSV", async () => {
    h.role = "LECTEUR";
    installer();
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    await screen.findByRole("list", { name: "Liste des conflits" });
    const panneau = document.getElementById("pv-panneau-conflits")!;
    expect(within(panneau).queryAllByRole("button", { name: NOMS_ECRITURE })).toEqual([]);
    expect(within(panneau).queryByRole("button", { name: "Lancer une analyse" })).toBeNull();
    expect(within(panneau).queryByRole("button", { name: /Exporter les conflits/ })).toBeNull();
  });

  it("fiche : la lecture est complete (mesure, historique, preuves, decisions) mais aucun bouton d'ecriture, meme avec une decision proposee", async () => {
    const f = await ouvrir(fiche({ statut: "CONFIRME", transitions: [], decisions: [decision()], preuves: [preuve()] }), "LECTEUR", "u-lect");
    expect(within(f).getByRole("heading", { name: /Historique/ })).toBeInTheDocument();
    expect(within(f).getByRole("heading", { name: /Décisions \(1\)/ })).toBeInTheDocument();
    expect(within(f).queryAllByRole("button", { name: NOMS_ECRITURE })).toEqual([]);
    expect(within(f).getByTestId("aucune-transition")).toHaveTextContent("Lecture seule : aucune action d'écriture n'est disponible pour votre compte.");
  });

  it("fiche sans liste de transitions du serveur : la table de secours est VIDE pour un lecteur", async () => {
    const f = await ouvrir(fiche({ statut: "POTENTIEL", transitions: null }), "LECTEUR", "u-lect");
    expect(within(f).getByTestId("aucune-transition")).toBeInTheDocument();
    expect(within(f).queryByRole("button", { name: /Confirmer ce conflit/ })).toBeNull();
  });

  it("regles et analyses : lecture seule (pas de creation, pas d'approbation)", async () => {
    h.role = "LECTEUR";
    installer();
    rendrePage();
    await userEvent.click(await screen.findByRole("tab", { name: "Conflits" }));
    await userEvent.click(await screen.findByRole("button", { name: "Règles", pressed: false }));
    await screen.findAllByText("RC-TEL");
    const panneau = document.getElementById("pv-panneau-conflits")!;
    expect(within(panneau).queryByRole("button", { name: /Créer un brouillon|Approuver/ })).toBeNull();
  });
});

describe("aucune action « deplacer », « ordonner » ou « executer »", () => {
  it("dans aucun etat de la fiche d'un dossier decide (ADMIN, decision de deplacement approuvee) : aucun bouton ni lien de ce nom", async () => {
    const f = await ouvrir(fiche({ statut: "TRAITEMENT_DECIDE", transitions: [T("CLOTURE"), T("INFIRME")], decisions: [decision({ option: "DEPLACER_RESEAU", statut: "APPROUVEE" }), decision({ id: "d2", option: "DEPLACER_RESEAU" })], preuves: [preuve()] }), "ADMIN", "u-adm");
    const noms = within(document.getElementById("pv-panneau-conflits")!).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
    expect(noms.filter((n) => /ordonn|exécut|execut|^déplacer|lancer le déplacement|lancer les travaux/i.test(n))).toEqual([]);
    expect(within(f).queryAllByRole("link", { name: /ordonn|exécut|déplacer/i })).toEqual([]);
  });
});

describe("hors ligne : les ecritures sont desactivees", () => {
  it("transition, attribution, preuve : boutons inactifs hors ligne", async () => {
    const f = await ouvrir(fiche({ transitions: [T("CONFIRME", { preuveRequise: true })] }));
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    await waitFor(() => expect(within(f).getByRole("button", { name: "Confirmer ce conflit" })).toBeDisabled());
    expect(within(f).getByRole("button", { name: /Attribuer ou modifier/ })).toBeDisabled();
    expect(within(f).getByRole("button", { name: /Ajouter une preuve/ })).toBeDisabled();
  });
});
