import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { violationsAccessibilite } from "../../test/accessibilite";
import type { ControleurSession, InstantaneSession, ResultatAction } from "../../session/useSessionLocale";
import { SessionLocaleProvider } from "../../session/useSessionLocale";
import type { DecisionSuppression } from "../../session/politiqueDeconnexion";
import { decisionSuppressionLocale } from "../../session/politiqueDeconnexion";

// Etat de synchronisation pilotable : le dialogue d'effacement le LIT en direct (useOfflineSync).
const sync = vi.hoisted(() => ({
  etat: { pendingCount: 0, syncing: false, conflitCount: 0, abandonCount: 0, refusDroitsCount: 0 } as Record<string, number | boolean>,
  ecouteurs: new Set<() => void>(),
}));
vi.mock("../../lib/offlineSync", () => ({
  syncPendingOfflineData: vi.fn(async () => undefined),
  getSyncState: () => sync.etat,
  subscribeSync: (cb: () => void) => { sync.ecouteurs.add(cb); return () => { sync.ecouteurs.delete(cb); }; },
}));

import { syncPendingOfflineData } from "../../lib/offlineSync";
import { BandeauSession } from "./BandeauSession";
import { ConfigurationPin } from "./ConfigurationPin";
import { DialogueChangementPin } from "./DialogueChangementPin";
import { DialogueDeconnexion } from "./DialogueDeconnexion";
import { DialogueEffacementLocal } from "./DialogueEffacementLocal";
import { DialoguePinOublie } from "./DialoguePinOublie";
import { EcranDeverrouillage, formaterDelai } from "./EcranDeverrouillage";
import { IndisponibleHorsLigne } from "./IndisponibleHorsLigne";
import { PanneauSessionLocale } from "./PanneauSessionLocale";

/**
 * Ecrans de la session locale : libelles, focus, clavier, alertes annoncees, axe-core (contraste desactive sous jsdom : voir
 * src/test/accessibilite.ts). Le controleur est un faux : sa logique est eprouvee dans session/useSessionLocale.test.ts.
 */

const ok: ResultatAction = { ok: true };
const VIDE = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };

function instantane(p: Partial<InstantaneSession> = {}): InstantaneSession {
  return {
    version: 1, demarre: true, etat: "HORS_LIGNE_VERROUILLE", utilisateur: null, compteId: "agent-A", nomCompte: "Agent Diallo",
    coffrePresent: true, deverrouille: false, horsLigne: true, ecran: "DEVERROUILLAGE", candidats: [], attenteJusquaMs: null,
    echecsPin: 0, droitsAReverifier: null, messageFermeture: null, deverrouillageDemande: false, pinACreer: false,
    autresComptes: { comptes: 0, saisies: 0, releves: 0 }, envoiJournalEnAttente: 0, ...p,
  };
}

function faux(p: Partial<InstantaneSession> = {}, surcharge: Record<string, unknown> = {}) {
  let snap = instantane(p);
  const abonnes = new Set<() => void>();
  const c = {
    abonner: (f: () => void) => { abonnes.add(f); return () => { abonnes.delete(f); }; },
    instantane: () => snap,
    deverrouiller: vi.fn(async (): Promise<ResultatAction> => ok),
    creerPin: vi.fn(async (): Promise<ResultatAction> => ok),
    changerPin: vi.fn(async (): Promise<ResultatAction> => ok),
    reinitialiserPin: vi.fn(async (): Promise<ResultatAction> => ok),
    effacerDonneesLocales: vi.fn(async () => ({ ok: true, bases: [], cles: 0 })),
    deconnecter: vi.fn(async () => ({ fermeSession: true, verrouLocal: false, deconnexionEnAttente: false, efface: false as const, texte: "Session fermée." })),
    decompte: vi.fn(async () => VIDE),
    apercuPerte: vi.fn(async (): Promise<DecisionSuppression> => decisionSuppressionLocale(VIDE)),
    choisirCompte: vi.fn(async () => undefined),
    allerALaConnexion: vi.fn(),
    demanderDeverrouillage: vi.fn(),
    verrouiller: vi.fn(),
    ...surcharge,
  };
  return {
    c: c as unknown as ControleurSession & typeof c,
    maj(q: Partial<InstantaneSession>) { snap = { ...snap, ...q, version: snap.version + 1 }; abonnes.forEach((f) => f()); },
  };
}

function monter(ui: JSX.Element, f: ReturnType<typeof faux>) {
  return render(
    <MemoryRouter initialEntries={["/inspections/terrain"]}>
      <SessionLocaleProvider controleur={f.c}>
        <Routes>
          <Route path="/login" element={<p>Page de connexion</p>} />
          <Route path="*" element={ui} />
        </Routes>
      </SessionLocaleProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("formaterDelai", () => {
  it("secondes, puis minutes et secondes", () => {
    expect(formaterDelai(28_100)).toBe("29 s");
    expect(formaterDelai(0)).toBe("0 s");
    expect(formaterDelai(65_000)).toBe("1 min 05 s");
    expect(formaterDelai(15 * 60_000)).toBe("15 min 00 s");
  });
});

describe("EcranDeverrouillage : saisie du PIN", () => {
  it("a un libelle, prend le focus, n'a aucune violation axe et annonce le mode hors ligne", async () => {
    const f = faux();
    const { container } = monter(<EcranDeverrouillage />, f);
    const champ = screen.getByLabelText("Code PIN");
    expect(champ).toHaveAttribute("type", "password");
    expect(champ).toHaveAttribute("autocomplete", "off");
    expect(champ).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Session verrouillée" })).toBeInTheDocument();
    expect(screen.getByText(/Agent Diallo/)).toBeInTheDocument();
    expect(screen.getByText(/droits seront revérifiés à la reconnexion/)).toBeInTheDocument();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("au clavier : saisie puis Entree deverrouille avec ce PIN ; le bouton est inactif tant que le champ est vide", async () => {
    const f = faux();
    monter(<EcranDeverrouillage />, f);
    expect(screen.getByRole("button", { name: "Déverrouiller" })).toBeDisabled();
    const u = userEvent.setup({ delay: null });
    await u.type(screen.getByLabelText("Code PIN"), "Zx-91-pin{Enter}");
    await waitFor(() => expect(f.c.deverrouiller).toHaveBeenCalledWith("Zx-91-pin"));
  });

  it("un PIN faux : message annonce (role=alert), champ vide, focus rendu au champ", async () => {
    const f = faux({}, { deverrouiller: vi.fn(async (): Promise<ResultatAction> => ({ ok: false, erreur: "PIN_INCORRECT", message: "Code incorrect." })) });
    monter(<EcranDeverrouillage />, f);
    const u = userEvent.setup({ delay: null });
    await u.type(screen.getByLabelText("Code PIN"), "faux-pin{Enter}");
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("Code incorrect.");
    expect(screen.getByLabelText("Code PIN")).toHaveValue("");
    expect(screen.getByLabelText("Code PIN")).toHaveFocus();
    expect(screen.getByLabelText("Code PIN")).toHaveAttribute("aria-invalid", "true");
  });

  it("apres trop d'essais : l'attente est annoncee (status), le bouton inactif, le PIN non envoye", async () => {
    const f = faux({ attenteJusquaMs: Date.now() + 30_000, echecsPin: 6 });
    const { container } = monter(<EcranDeverrouillage />, f);
    expect(screen.getByRole("status")).toHaveTextContent(/Trop d'essais/);
    expect(screen.getByRole("button", { name: "Déverrouiller" })).toBeDisabled();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("droits changes en ligne : l'avis est une alerte et dit que le code renouvelle la session", () => {
    monter(<EcranDeverrouillage />, faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", droitsAReverifier: ["role"] }));
    expect(screen.getByRole("alert")).toHaveTextContent(/droits ont changé.*renouveler/);
  });

  it("des saisies d'un autre compte : un nombre d'information, jamais de contenu", () => {
    monter(<EcranDeverrouillage />, faux({ autresComptes: { comptes: 1, saisies: 3, releves: 0 } }));
    expect(screen.getByText(/saisies d'un autre compte sont en attente/)).toBeInTheDocument();
  });

  it("propose « Code oublié ? » et « Se déconnecter », chacun ouvre son dialogue", async () => {
    const f = faux();
    monter(<EcranDeverrouillage />, f);
    const u = userEvent.setup({ delay: null });
    await u.click(screen.getByRole("button", { name: "Code oublié ?" }));
    expect(await screen.findByRole("dialog", { name: "Code oublié : réinitialiser" })).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "J'essaie encore" }));
    await u.click(screen.getByRole("button", { name: "Se déconnecter" }));
    expect(await screen.findByRole("dialog", { name: "Se déconnecter ?" })).toBeInTheDocument();
  });

  it("route de terrain en ligne : « Quitter le mode terrain » est proposé", async () => {
    const retour = vi.fn();
    monter(<EcranDeverrouillage retour={retour} />, faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN" }));
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Quitter le mode terrain" }));
    expect(retour).toHaveBeenCalled();
  });
});

describe("EcranDeverrouillage : choix du compte et session expiree", () => {
  it("plusieurs comptes : liste de boutons nommes, aucune violation axe, le choix est transmis", async () => {
    const f = faux({
      ecran: "CHOIX_COMPTE", etat: "DECONNECTE", compteId: null, nomCompte: null,
      candidats: [{ compteId: "a", nom: "Agent Diallo" }, { compteId: "b", nom: null }],
    });
    const { container } = monter(<EcranDeverrouillage />, f);
    expect(screen.getByRole("heading", { name: "Choisissez votre compte" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compte enregistré n° 2" })).toBeInTheDocument();
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Agent Diallo" }));
    expect(f.c.choisirCompte).toHaveBeenCalledWith("a");
  });

  it("« Me connecter avec mon mot de passe » ouvre la page de connexion", async () => {
    const f = faux({ ecran: "CHOIX_COMPTE", etat: "DECONNECTE", candidats: [{ compteId: "a", nom: "A" }, { compteId: "b", nom: "B" }] });
    monter(<EcranDeverrouillage />, f);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Me connecter avec mon mot de passe" }));
    expect(f.c.allerALaConnexion).toHaveBeenCalled();
    expect(await screen.findByText("Page de connexion")).toBeInTheDocument();
  });

  it("session expiree : alerte claire (les saisies ne sont pas perdues), aucune violation axe, bouton vers la connexion", async () => {
    const f = faux({ ecran: "SESSION_EXPIREE", etat: "EXPIRE" });
    const { container } = monter(<EcranDeverrouillage />, f);
    expect(screen.getByRole("alert")).toHaveTextContent(/restent chiffrées sur ce téléphone et ne sont pas perdues/);
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Aller à la connexion" }));
    expect(await screen.findByText("Page de connexion")).toBeInTheDocument();
  });
});

describe("ConfigurationPin", () => {
  it("dit ce que le PIN protege ET ne protege pas, la perte en cas d'oubli et le conseil de synchroniser souvent ; aucune violation axe", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", coffrePresent: false, pinACreer: true });
    const { container } = monter(<ConfigurationPin />, f);
    expect(screen.getByRole("heading", { name: "Ce que le code protège" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ce qu'il ne protège pas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Si vous l'oubliez" })).toBeInTheDocument();
    expect(screen.getByText(/saisies non envoyées de ce téléphone seront perdues/)).toBeInTheDocument();
    expect(screen.getByText(/synchroniser souvent/)).toBeInTheDocument();
    expect(screen.getByLabelText("Code PIN")).toHaveFocus();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("refuse un PIN trivial, trop court ou mal confirme, et n'appelle pas la creation", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", coffrePresent: false });
    monter(<ConfigurationPin />, f);
    const u = userEvent.setup({ delay: null });
    const pin = screen.getByLabelText("Code PIN");
    const conf = screen.getByLabelText("Confirmez le code");
    await u.type(pin, "123456"); await u.type(conf, "123456"); await u.click(screen.getByRole("button", { name: "Créer mon code" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/suite/);
    await u.clear(pin); await u.type(pin, "abc"); await u.click(screen.getByRole("button", { name: "Créer mon code" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/au moins 6/);
    await u.clear(pin); await u.type(pin, "tracteur bleu 17"); await u.clear(conf); await u.type(conf, "autre chose");
    await u.click(screen.getByRole("button", { name: "Créer mon code" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/pas identiques/);
    expect(f.c.creerPin).not.toHaveBeenCalled();
  });

  it("un PIN accepte est transmis une fois, avec la saisie en double identique", async () => {
    const surTermine = vi.fn();
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", coffrePresent: false });
    monter(<ConfigurationPin surTermine={surTermine} />, f);
    const u = userEvent.setup({ delay: null });
    await u.type(screen.getByLabelText("Code PIN"), "tracteur bleu 17");
    await u.type(screen.getByLabelText("Confirmez le code"), "tracteur bleu 17{Enter}");
    await waitFor(() => expect(f.c.creerPin).toHaveBeenCalledWith("tracteur bleu 17"));
    expect(f.c.creerPin).toHaveBeenCalledTimes(1);
    expect(surTermine).toHaveBeenCalled();
  });

  it("une erreur du coffre est annoncee", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", coffrePresent: false }, {
      creerPin: vi.fn(async (): Promise<ResultatAction> => ({ ok: false, erreur: "COFFRE_EXISTANT", message: "Une session locale existe déjà pour ce compte." })),
    });
    monter(<ConfigurationPin />, f);
    const u = userEvent.setup({ delay: null });
    await u.type(screen.getByLabelText("Code PIN"), "tracteur bleu 17");
    await u.type(screen.getByLabelText("Confirmez le code"), "tracteur bleu 17{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/existe déjà/);
  });
});

describe("DialogueDeconnexion", () => {
  it("dit que rien n'est efface et combien de saisies, photos et releves restent chiffres ; aucune violation axe", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false }, { decompte: vi.fn(async () => ({ ...VIDE, enAttente: 2, enConflit: 1, photosEnFile: 1, relevesNonConfirmes: 1 })) });
    monter(<DialogueDeconnexion ouvert surFermer={() => undefined} />, f);
    expect(await screen.findByText(/Restent chiffrés sur ce téléphone : 3 saisies, 1 photo et 1 relevé de roulage/)).toBeInTheDocument();
    expect(screen.getByText(/Aucune donnée n'est supprimée de ce téléphone/)).toBeInTheDocument();
    expect(screen.getByText(/ce même compte/)).toBeInTheDocument();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });

  it("file vide : le dit sans inventer de chiffre ; hors ligne : annonce le verrou local et la deconnexion differee", async () => {
    const f = faux({ horsLigne: true });
    monter(<DialogueDeconnexion ouvert surFermer={() => undefined} />, f);
    expect(await screen.findByText(/Aucune saisie en attente/)).toBeInTheDocument();
    expect(screen.getByText(/se verrouille tout de suite.*retour du réseau/)).toBeInTheDocument();
  });

  it("confirmer appelle la deconnexion (sans option 'tous') et ferme ; « tous les appareils » la transmet", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false });
    const ferme = vi.fn();
    const { rerender } = monter(<DialogueDeconnexion ouvert surFermer={ferme} />, f);
    await userEvent.setup({ delay: null }).click(await screen.findByRole("button", { name: "Se déconnecter" }));
    await waitFor(() => expect(f.c.deconnecter).toHaveBeenCalledWith({ tous: false }));
    expect(ferme).toHaveBeenCalled();
    rerender(
      <MemoryRouter><SessionLocaleProvider controleur={f.c}><DialogueDeconnexion ouvert surFermer={ferme} tous /></SessionLocaleProvider></MemoryRouter>,
    );
    await userEvent.setup({ delay: null }).click(await screen.findByRole("button", { name: "Tout déconnecter" }));
    await waitFor(() => expect(f.c.deconnecter).toHaveBeenLastCalledWith({ tous: true }));
  });

  it("Annuler ne deconnecte pas", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false });
    const ferme = vi.fn();
    monter(<DialogueDeconnexion ouvert surFermer={ferme} />, f);
    await userEvent.setup({ delay: null }).click(await screen.findByRole("button", { name: "Annuler" }));
    expect(ferme).toHaveBeenCalled();
    expect(f.c.deconnecter).not.toHaveBeenCalled();
  });
});

describe("DialoguePinOublie : confirmation en deux temps", () => {
  const avecPerte = decisionSuppressionLocale({ ...VIDE, enAttente: 3, photosEnFile: 2 });

  it("temps 1 : annonce la perte avec le decompte ; rien n'est reinitialise", async () => {
    const f = faux({}, { apercuPerte: vi.fn(async () => avecPerte) });
    monter(<DialoguePinOublie ouvert surFermer={() => undefined} />, f);
    expect(await screen.findByText(/Seront perdus définitivement : 3 saisies non envoyées, 2 photos en attente/)).toBeInTheDocument();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    expect(f.c.reinitialiserPin).not.toHaveBeenCalled();
  });

  it("temps 2 : la case « Je comprends » est exigee, puis seulement la reinitialisation a lieu", async () => {
    const f = faux({}, { apercuPerte: vi.fn(async () => avecPerte) });
    const ferme = vi.fn();
    monter(<DialoguePinOublie ouvert surFermer={ferme} />, f);
    const u = userEvent.setup({ delay: null });
    await u.click(await screen.findByRole("button", { name: "Continuer" }));
    const bouton = screen.getByRole("button", { name: "Réinitialiser le code" });
    expect(bouton).toBeDisabled();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    await u.click(screen.getByRole("checkbox"));
    expect(bouton).toBeEnabled();
    await u.click(bouton);
    await waitFor(() => expect(f.c.reinitialiserPin).toHaveBeenCalledTimes(1));
    expect(ferme).toHaveBeenCalled();
  });

  it("file vide : l'annonce ne promet pas « rien ne sera perdu » (elle ne voit pas la memoire des pages) et la case n'est pas exigee", async () => {
    const f = faux();
    monter(<DialoguePinOublie ouvert surFermer={() => undefined} />, f);
    const u = userEvent.setup({ delay: null });
    expect(await screen.findByText(/Aucune saisie en attente n'a été comptée sur ce téléphone/)).toBeInTheDocument();
    expect(screen.getByText(/ne voit pas ce qu'une page ouverte retient encore en\s+mémoire/)).toBeInTheDocument();
    expect(screen.queryByText(/rien ne sera perdu/)).not.toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Continuer" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Réinitialiser le code" })).toBeEnabled();
  });

  it("decompte illisible : traite comme une perte possible, jamais comme zero", async () => {
    const f = faux({}, { apercuPerte: vi.fn(async () => { throw new Error("illisible"); }) });
    monter(<DialoguePinOublie ouvert surFermer={() => undefined} />, f);
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'a pas pu être vérifié/);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Continuer" }));
    expect(screen.getByRole("button", { name: "Réinitialiser le code" })).toBeDisabled();
  });

  it("« J'essaie encore » ferme sans rien faire", async () => {
    const f = faux();
    const ferme = vi.fn();
    monter(<DialoguePinOublie ouvert surFermer={ferme} />, f);
    await userEvent.setup({ delay: null }).click(await screen.findByRole("button", { name: "J'essaie encore" }));
    expect(ferme).toHaveBeenCalled();
    expect(f.c.reinitialiserPin).not.toHaveBeenCalled();
  });

  it("un echec de la reinitialisation est annonce", async () => {
    const f = faux({}, { reinitialiserPin: vi.fn(async (): Promise<ResultatAction> => ({ ok: false, erreur: "INDISPONIBLE", message: "Fermez les autres onglets." })) });
    monter(<DialoguePinOublie ouvert surFermer={() => undefined} />, f);
    const u = userEvent.setup({ delay: null });
    await u.click(await screen.findByRole("button", { name: "Continuer" }));
    await u.click(screen.getByRole("button", { name: "Réinitialiser le code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fermez les autres onglets.");
  });
});

describe("DialogueEffacementLocal", () => {
  it("file non vide : le texte de la politique, les actions, et le bouton d'effacement INACTIF ; l'export est dit indisponible", async () => {
    const refus = decisionSuppressionLocale({ ...VIDE, enAttente: 2, photosEnFile: 1 });
    const f = faux({}, { apercuPerte: vi.fn(async () => refus) });
    monter(<DialogueEffacementLocal ouvert surFermer={() => undefined} />, f);
    expect(await screen.findByRole("alert")).toHaveTextContent(refus.texte);
    expect(screen.getByRole("button", { name: "Effacer les données" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Synchroniser maintenant" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Exporter" })).toBeDisabled();
    expect(screen.getByText(/export des saisies n'est pas encore disponible/)).toBeInTheDocument();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    expect(f.c.effacerDonneesLocales).not.toHaveBeenCalled();
  });

  it("« Synchroniser maintenant » relance la synchronisation puis re-evalue la file", async () => {
    const refus = decisionSuppressionLocale({ ...VIDE, enAttente: 1 });
    const apercu = vi.fn().mockResolvedValueOnce(refus).mockResolvedValue(decisionSuppressionLocale(VIDE));
    const f = faux({}, { apercuPerte: apercu });
    monter(<DialogueEffacementLocal ouvert surFermer={() => undefined} />, f);
    await userEvent.setup({ delay: null }).click(await screen.findByRole("button", { name: "Synchroniser maintenant" }));
    await waitFor(() => expect(syncPendingOfflineData).toHaveBeenCalled());
    // Geste de l'agent : cycle MANUEL (il leve la suspension de l'enregistrement d'appareil).
    expect(syncPendingOfflineData).toHaveBeenLastCalledWith({ manuel: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Effacer les données" })).toBeEnabled());
  });

  it("relit la file quand la synchronisation change d'etat (une synchronisation deja en cours vide la file apres le clic)", async () => {
    // syncPendingOfflineData rend la main tout de suite quand une synchronisation tourne deja : le dialogue ne peut pas se fier
    // a une seule relecture juste apres le clic. Defaut (i) du test de bout en bout : « Effacer » restait inactif 60 s.
    const refus = decisionSuppressionLocale({ ...VIDE, enAttente: 1 });
    const apercu = vi.fn().mockResolvedValueOnce(refus).mockResolvedValue(decisionSuppressionLocale(VIDE));
    const f = faux({}, { apercuPerte: apercu });
    sync.etat = { pendingCount: 1, syncing: true, conflitCount: 0, abandonCount: 0, refusDroitsCount: 0 };
    try {
      monter(<DialogueEffacementLocal ouvert surFermer={() => undefined} />, f);
      expect(await screen.findByRole("alert")).toHaveTextContent(refus.texte);
      expect(screen.getByRole("button", { name: "Effacer les données" })).toBeDisabled();
      expect(apercu).toHaveBeenCalledTimes(1);
      // La synchronisation automatique se termine : l'etat publie change, SANS aucun clic de l'agent.
      sync.etat = { pendingCount: 0, syncing: false, conflitCount: 0, abandonCount: 0, refusDroitsCount: 0 };
      await act(async () => { for (const e of [...sync.ecouteurs]) e(); });
      await waitFor(() => expect(screen.getByRole("button", { name: "Effacer les données" })).toBeEnabled());
      expect(apercu).toHaveBeenCalledTimes(2);
    } finally {
      sync.etat = { pendingCount: 0, syncing: false, conflitCount: 0, abandonCount: 0, refusDroitsCount: 0 };
    }
  });

  it("file vide : explique la difference avec la deconnexion, puis efface le compte courant seulement", async () => {
    const f = faux();
    const ferme = vi.fn();
    monter(<DialogueEffacementLocal ouvert surFermer={ferme} />, f);
    expect(await screen.findByText(/votre compte seulement/)).toBeInTheDocument();
    expect(screen.getByText(/la déconnexion n'efface rien/)).toBeInTheDocument();
    const bouton = await screen.findByRole("button", { name: "Effacer les données" });
    await waitFor(() => expect(bouton).toBeEnabled());
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    await userEvent.setup({ delay: null }).click(bouton);
    await waitFor(() => expect(f.c.effacerDonneesLocales).toHaveBeenCalledTimes(1));
    expect(ferme).toHaveBeenCalled();
  });

  it("un refus rendu par le controleur est montre, pas avale", async () => {
    const f = faux({}, { effacerDonneesLocales: vi.fn(async () => ({ ok: false, raison: "ECHEC_SUPPRESSION" })) });
    monter(<DialogueEffacementLocal ouvert surFermer={() => undefined} />, f);
    const bouton = await screen.findByRole("button", { name: "Effacer les données" });
    await waitFor(() => expect(bouton).toBeEnabled());
    await userEvent.setup({ delay: null }).click(bouton);
    expect(await screen.findByText(/n'a pas pu aller au bout/)).toBeInTheDocument();
  });
});

describe("DialogueChangementPin", () => {
  it("exige l'ancien code, refuse un nouveau code trivial, identique a l'ancien ou mal confirme", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false });
    monter(<DialogueChangementPin ouvert surFermer={() => undefined} />, f);
    const u = userEvent.setup({ delay: null });
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    const ancien = screen.getByLabelText("Code actuel");
    const nouveau = screen.getByLabelText(/Nouveau code/);
    const conf = screen.getByLabelText("Confirmez le nouveau code");
    const envoyer = screen.getByRole("button", { name: "Changer le code" });
    await u.type(ancien, "ancien-pin-1"); await u.type(nouveau, "111111"); await u.type(conf, "111111"); await u.click(envoyer);
    expect(screen.getByRole("alert")).toHaveTextContent(/même caractère/);
    await u.clear(nouveau); await u.type(nouveau, "ancien-pin-1"); await u.clear(conf); await u.type(conf, "ancien-pin-1"); await u.click(envoyer);
    expect(screen.getByRole("alert")).toHaveTextContent(/différent de l'ancien/);
    await u.clear(nouveau); await u.type(nouveau, "nouveau-pin-77"); await u.clear(conf); await u.type(conf, "autre"); await u.click(envoyer);
    expect(screen.getByRole("alert")).toHaveTextContent(/pas identiques/);
    expect(f.c.changerPin).not.toHaveBeenCalled();
    await u.clear(conf); await u.type(conf, "nouveau-pin-77"); await u.click(envoyer);
    await waitFor(() => expect(f.c.changerPin).toHaveBeenCalledWith("ancien-pin-1", "nouveau-pin-77"));
  });
});

describe("BandeauSession", () => {
  it("hors ligne : le message de la conception et la liste de ce qui n'est pas verifiable ; aucune violation axe", async () => {
    const f = faux({ etat: "HORS_LIGNE_OUVERT", horsLigne: true, deverrouille: true, ecran: "AUCUN" });
    const { container } = monter(<BandeauSession />, f);
    expect(screen.getByRole("status")).toHaveTextContent("Mode hors ligne : vos droits seront revérifiés à la reconnexion.");
    const details = screen.getByText("Ce qui ne peut pas être vérifié hors ligne").closest("details") as HTMLElement;
    for (const t of [/existence et le statut de votre compte/, /révocation du compte/, /changement de rôle ou de périmètre/, /second facteur/, /horloge/]) {
      expect(within(details).getByText(t)).toBeInTheDocument();
    }
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("droits changes : alerte et bouton qui demande le deverrouillage", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", droitsAReverifier: ["role"] });
    monter(<BandeauSession />, f);
    expect(screen.getByRole("alert")).toHaveTextContent(/session locale a été invalidée/);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Renouveler" }));
    expect(f.c.demanderDeverrouillage).toHaveBeenCalled();
  });

  it("en ligne, coffre verrouille : rappel discret avec bouton ; coffre ouvert ou absent : rien", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN" });
    const { container } = monter(<BandeauSession />, f);
    expect(screen.getByRole("status")).toHaveTextContent(/Session terrain verrouillée/);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Déverrouiller" }));
    expect(f.c.demanderDeverrouillage).toHaveBeenCalled();
    act(() => f.maj({ deverrouille: true }));
    expect(container.textContent).toBe("");
    act(() => f.maj({ deverrouille: false, coffrePresent: false }));
    expect(container.textContent).toBe("");
  });

  it("ne rend rien hors fournisseur de session", () => {
    const { container } = render(<BandeauSession />);
    expect(container.textContent).toBe("");
  });
});

describe("PanneauSessionLocale", () => {
  it("coffre ouvert : verrouiller maintenant, changer le PIN, PIN oublie, effacer ; chacun ouvre son dialogue", async () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", deverrouille: true });
    const ferme = vi.fn();
    monter(<PanneauSessionLocale ouvert surFermer={ferme} />, f);
    expect(await violationsAccessibilite(document.body)).toEqual([]);
    const u = userEvent.setup({ delay: null });
    await u.click(screen.getByRole("button", { name: "Changer le code PIN" }));
    expect(await screen.findByRole("dialog", { name: "Changer le code PIN" })).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Annuler" }));
    await u.click(await screen.findByRole("button", { name: "Verrouiller maintenant" }));
    expect(f.c.verrouiller).toHaveBeenCalled();
    expect(ferme).toHaveBeenCalled();
  });

  it("sans coffre : pas de changement ni de reinitialisation du PIN", () => {
    monter(<PanneauSessionLocale ouvert surFermer={() => undefined} />, faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", coffrePresent: false }));
    expect(screen.queryByRole("button", { name: "Changer le code PIN" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Code oublié/ })).toBeNull();
    expect(screen.getByText(/Aucun code PIN n'est encore créé/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Effacer les données de ce téléphone" })).toBeInTheDocument();
  });
});

describe("IndisponibleHorsLigne", () => {
  it("dit « disponible en ligne seulement », renvoie vers les pages de terrain, aucune violation axe", async () => {
    const { container } = render(<MemoryRouter><IndisponibleHorsLigne /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Disponible en ligne seulement" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enregistrer en roulant" })).toHaveAttribute("href", "/inspections/releve/enregistrer");
    expect(screen.getByRole("link", { name: "Inspection terrain" })).toHaveAttribute("href", "/inspections/terrain");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
