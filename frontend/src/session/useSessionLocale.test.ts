// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyserPin } from "../components/session/pinTrivial";
import { compteCourant, etatCompte, fermerCompte, resumeAutresComptes } from "../lib/compteCourant";
import { CLE_INDICE_COMPTES, lireIndice } from "../lib/effacementLocal";
import { addPendingObservation, compterFile, getAllPendingObservations, type PendingObservation } from "../lib/offlineDb";
import type { Role } from "../types";
import { listerComptesAvecCoffre, sha256WebCrypto, stockageEnMemoire, type CoffreSession, type StockageCoffre } from "./coffreSession";
import { cleLocalStorage, empreinteCompte, nomBaseOffline } from "./compteLocal";
import { creerJournal, type CorpsLotEvenements } from "./journalEvenementsLocaux";
import type { ComptesFile } from "./politiqueDeconnexion";
import {
  ControleurSession, routeDisponibleHorsLigne, routeUtiliseLaFile, ROUTES_FILE_LOCALE,
  type ResultatRafraichissement, type ServeurSession, type UtilisateurServeur,
} from "./useSessionLocale";

/**
 * Machine d'etats cote HOTE : le vrai noyau, le vrai coffre (1 000 iterations PBKDF2 de test), un vrai moteur IndexedDB
 * (fake-indexeddb), une horloge injectee. Le serveur est un faux scriptable. Aucun minuteur reel n'est attendu : le test fait
 * avancer l'horloge et appelle `tick()`, comme le ferait l'intervalle d'une seconde.
 */

const T0 = Date.parse("2026-10-25T08:00:00.000Z");
const MIN = 60_000;
const JOUR = 24 * 60 * MIN;
const PIN = "Zx-91-pin";
const VIDE: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

const agent = (id: string, sur: Partial<UtilisateurServeur> = {}): UtilisateurServeur => ({
  id, email: `${id}@ageroute.test`, nomComplet: `Agent ${id}`, role: "INSPECTEUR" as Role, actif: true,
  modulesAutorises: ["inspections", "troncons"], peutDeleguerValidation: false, createdAt: "2026-01-01T00:00:00.000Z",
  regions: [3, 1], perimetreNational: false, ...sur,
});

let compteur = 0;

/** Un serveur scriptable. `e` est l'etat visible et modifiable par le test. */
function fauxServeur(utilisateur: UtilisateurServeur) {
  const e = {
    reseau: true, refus: null as 401 | 403 | null, indisponible: false, moi: utilisateur,
    deconnexionJointe: true, echecEvenements: false as boolean | number,
    evenements: [] as CorpsLotEvenements[], deconnexions: [] as boolean[], sondes: 0, jeton: null as string | null,
  };
  const issue = (): ResultatRafraichissement => {
    if (!e.reseau) return { etat: "RESEAU_COUPE" };
    if (e.refus !== null) return { etat: "REFUSE", statut: e.refus };
    if (e.indisponible) return { etat: "INDISPONIBLE", statut: 503 };
    return { etat: "OK", token: `jeton-${++compteur}` };
  };
  const serveur: ServeurSession = {
    async connexion() { if (!e.reseau) throw {}; return { accessToken: "jeton-login", user: e.moi }; },
    async verifierDeuxFacteurs() { return { accessToken: "jeton-2fa", user: e.moi }; },
    async moi() {
      if (!e.reseau) throw {};
      if (e.refus !== null) throw { response: { status: e.refus } };
      return e.moi;
    },
    async deconnexion(tous) { e.deconnexions.push(tous); return e.reseau && e.deconnexionJointe; },
    async rafraichirAuDemarrage() { return issue(); },
    async sonder() { e.sondes += 1; return issue(); },
    async envoyerEvenements(corps) {
      if (!e.reseau || e.echecEvenements) throw typeof e.echecEvenements === "number" ? { statut: e.echecEvenements } : {};
      e.evenements.push(corps);
    },
    poserJeton(t) { e.jeton = t; },
    appareilServeurId: () => null,
  };
  return { serveur, e };
}

interface Env {
  h: { t: number };
  stockageCoffre: StockageCoffre;
  marqueur: { present: boolean };
  file: { courante: ComptesFile };
  migrer: ReturnType<typeof vi.fn>;
  apres: ReturnType<typeof vi.fn>;
  controleurs: ControleurSession[];
  nouveau(serveur: ServeurSession): ControleurSession;
}

function creerEnv(): Env {
  const h = { t: T0 };
  const stockageCoffre = stockageEnMemoire();
  const stockageTexte = localStorage as unknown as ReturnType<typeof fauxLocalStorage>;
  const marqueur = { present: true };
  const file = { courante: VIDE };
  const migrer = vi.fn(async () => undefined);
  const apres = vi.fn();
  const controleurs: ControleurSession[] = [];
  return {
    h, stockageCoffre, marqueur, file, migrer, apres, controleurs,
    nouveau(serveur) {
      const c = new ControleurSession({
        serveur, stockageCoffre, stockageTexte, idAppareilLocal: () => "tel-1", maintenant: () => h.t,
        marqueur: { present: () => marqueur.present, poser: () => { marqueur.present = true; }, purger: () => { marqueur.present = false; } },
        sha256: sha256WebCrypto, optionsCoffre: { iterations: 1000, iterationsDeTest: true },
        decompteFile: async () => file.courante, migrer, apresDeverrouillage: apres, retourReseauMs: 0,
      });
      controleurs.push(c);
      return c;
    },
  };
}

const coffreCourant = () => compteCourant()?.chiffreur as unknown as CoffreSession;
const evenementsJournal = (empreinte: string) => creerJournal({ empreinte, stockage: localStorage }).lire().map((x) => x.evenement);

let env: Env;

/** Fait avancer l'horloge de `ms` en gardant la session active (une interaction toutes les 4 minutes), comme un agent qui travaille. */
function avancerEnActivite(ctl: ControleurSession, ms: number): void {
  let reste = ms;
  while (reste > 0) {
    const pas = Math.min(reste, 4 * MIN);
    env.h.t += pas; reste -= pas;
    ctl.signalerActivite(); ctl.tick();
  }
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  fermerCompte();
  env = creerEnv();
});
afterEach(() => {
  for (const c of env.controleurs) c.desactiver();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fermerCompte();
});

/** Controleur connecte en ligne, PIN cree : coffre ouvert, EN_LIGNE. */
async function ouvrirSession(utilisateur = agent("agent-A")) {
  const { serveur, e } = fauxServeur(utilisateur);
  const ctl = env.nouveau(serveur);
  await ctl.demarrer();
  await ctl.connecter(utilisateur.email, "motdepasse");
  const r = await ctl.creerPin(PIN);
  expect(r).toEqual({ ok: true });
  const empreinte = await empreinteCompte(utilisateur.id, sha256WebCrypto);
  return { ctl, serveur, e, empreinte };
}

describe("routes", () => {
  it("la liste des routes de la file locale est explicite et fermee aux autres pages", () => {
    expect([...ROUTES_FILE_LOCALE].sort()).toEqual([
      "/inspections/releve/enregistrer", "/inspections/terrain", "/inspections/terrain/defauts",
      "/inspections/terrain/observations", "/inspections/terrain/portions",
    ]);
    for (const p of ROUTES_FILE_LOCALE) { expect(routeUtiliseLaFile(p)).toBe(true); expect(routeUtiliseLaFile(`${p}/`)).toBe(true); }
    for (const p of ["/", "/troncons", "/geoportail", "/inspections", "/inspections/releve", "/inspections/terrain/autre", "/utilisateurs"]) {
      expect(routeUtiliseLaFile(p), p).toBe(false);
      expect(routeDisponibleHorsLigne(p), p).toBe(false);
    }
  });
});

describe("PIN : regles de choix", () => {
  it.each(["000000", "111111", "123456", "654321", "abcdef", "890123", "121212", "123123", "112233", "147258", "696969"])("refuse %s", (pin) => {
    expect(analyserPin(pin).acceptable).toBe(false);
  });
  it("refuse trop court et trop long, accepte une phrase de passe et un code non prevu", () => {
    expect(analyserPin("12345")).toMatchObject({ acceptable: false, motif: "TROP_COURT" });
    expect(analyserPin("a".repeat(129))).toMatchObject({ acceptable: false, motif: "TROP_LONG" });
    expect(analyserPin("tracteur bleu 17").acceptable).toBe(true);
    expect(analyserPin("482915").acceptable).toBe(true);
  });
});

describe("connexion en ligne et creation du coffre", () => {
  it("sans coffre : EN_LIGNE, le PIN est a creer, le compte du stockage n'est pas ouvert tant qu'il n'existe pas", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const ctl = env.nouveau(serveur);
    await ctl.demarrer();
    await ctl.connecter("a@x", "pw");
    const s = ctl.instantane();
    expect(s).toMatchObject({ etat: "EN_LIGNE", coffrePresent: false, pinACreer: true, deverrouille: false, ecran: "AUCUN" });
    expect(s.utilisateur?.id).toBe("agent-A");
    expect(compteCourant()).toBeNull();
  });

  it("refuse un PIN trivial ou trop court sans rien creer, puis cree le coffre, ouvre le compte et migre l'heritage", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const ctl = env.nouveau(serveur);
    await ctl.connecter("a@x", "pw");
    for (const pin of ["123456", "000000", "abc", ""]) {
      const r = await ctl.creerPin(pin);
      expect(r.ok, pin).toBe(false);
    }
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual([]);
    expect(await ctl.creerPin(PIN)).toEqual({ ok: true });
    const s = ctl.instantane();
    expect(s).toMatchObject({ etat: "EN_LIGNE", coffrePresent: true, deverrouille: true, pinACreer: false });
    expect(etatCompte()).toBe("OUVERT");
    expect(compteCourant()?.compteId).toBe("agent-A");
    expect(env.migrer).toHaveBeenCalledTimes(1);
    expect(env.apres).toHaveBeenCalled();
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A"]);
  });

  it("le profil du coffre est celui de /auth/me : role, modules, regions (le compte national a son marqueur)", async () => {
    const { ctl } = await ouvrirSession(agent("agent-A", { role: "GESTIONNAIRE" as Role }));
    const p = coffreCourant().profilCourant();
    expect(p).toMatchObject({ userId: "agent-A", role: "GESTIONNAIRE", modules: ["inspections", "troncons"], regions: ["3", "1"], nom: "Agent agent-A" });
    ctl.desactiver();
    const national = await (async () => {
      fermerCompte();
      const { serveur } = fauxServeur(agent("agent-N", { regions: [], perimetreNational: true }));
      const c = env.nouveau(serveur);
      await c.connecter("n@x", "pw");
      await c.creerPin(PIN);
      return coffreCourant().profilCourant();
    })();
    expect(national?.regions).toEqual(["NATIONAL"]);
  });

  it("un coffre existant : EN_LIGNE mais verrouille, il se deverrouille avec le PIN (et seulement lui)", async () => {
    const premier = await ouvrirSession();
    premier.ctl.verrouiller();
    premier.ctl.desactiver();
    fermerCompte();
    // Nouvelle visite : connexion en ligne, le coffre existe.
    const { serveur } = fauxServeur(agent("agent-A"));
    const ctl = env.nouveau(serveur);
    await ctl.connecter("a@x", "pw");
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", coffrePresent: true, deverrouille: false, pinACreer: false });
    expect(etatCompte()).toBe("VERROUILLE");
    expect(await ctl.deverrouiller("mauvais-pin")).toMatchObject({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    expect(ctl.instantane().deverrouille).toBe(true);
    expect(etatCompte()).toBe("OUVERT");
  });
});

describe("EN_LIGNE -> coupure -> HORS_LIGNE_OUVERT -> inactivite -> VERROUILLE -> PIN -> OUVERT", () => {
  it("parcourt tout le cycle avec une horloge injectee", async () => {
    const { ctl, empreinte } = await ouvrirSession();
    expect(ctl.instantane().etat).toBe("EN_LIGNE");

    await ctl.reseauPerdu("EVENEMENT");
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_OUVERT", deverrouille: true, horsLigne: true });

    // 4 min 59 s sans interaction : toujours ouvert. 5 min : verrouille.
    env.h.t += 5 * MIN - 1000; ctl.tick();
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    env.h.t += 1000; ctl.tick();
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_VERROUILLE", deverrouille: false, ecran: "DEVERROUILLAGE" });
    expect(etatCompte()).toBe("VERROUILLE"); // plus aucun contenu lisible
    expect(coffreCourant().estDeverrouille()).toBe(false);

    // PIN faux puis juste.
    expect(await ctl.deverrouiller("faux-pin-1")).toMatchObject({ ok: false, erreur: "PIN_INCORRECT" });
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_VERROUILLE", echecsPin: 1 });
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_OUVERT", deverrouille: true, echecsPin: 0, ecran: "AUCUN" });
    expect(etatCompte()).toBe("OUVERT");

    expect(evenementsJournal(empreinte)).toEqual(["OUVERTURE_HORS_LIGNE", "VERROU_INACTIVITE", "ECHEC_DEVERROUILLAGE", "DEVERROUILLAGE"]);
  });

  it("une interaction repousse le verrou ; l'activite est limitee a une par seconde", async () => {
    const { ctl } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    for (let i = 0; i < 10; i += 1) { env.h.t += 4 * MIN; ctl.signalerActivite(); ctl.tick(); }
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    env.h.t += 5 * MIN; ctl.tick();
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_VERROUILLE");
  });

  it("le pont des ecrans (releve en cours) compte comme une activite : signalerActivite repousse le verrou", async () => {
    const { ctl } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    env.h.t += 4 * MIN; ctl.signalerActivite();
    env.h.t += 4 * MIN; ctl.tick();
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
  });

  it("arriere-plan de 2 minutes : verrouille au retour au premier plan ; 1 min 59 s : non", async () => {
    const { ctl } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    ctl.signalerArrierePlan();
    env.h.t += 2 * MIN - 1000; ctl.signalerPremierPlan();
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    ctl.signalerArrierePlan();
    env.h.t += 2 * MIN; ctl.signalerPremierPlan();
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_VERROUILLE", deverrouille: false });
  });

  it("en ligne, le verrou n'efface que la cle : l'etat reste EN_LIGNE et le PIN est redemande", async () => {
    const { ctl } = await ouvrirSession();
    env.h.t += 5 * MIN; ctl.tick();
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", deverrouille: false, coffrePresent: true });
    expect(etatCompte()).toBe("VERROUILLE");
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    expect(ctl.instantane().deverrouille).toBe(true);
  });

  it("verrou manuel", async () => {
    const { ctl } = await ouvrirSession();
    ctl.verrouiller();
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", deverrouille: false });
  });
});

describe("expiration et horloge", () => {
  it("expire apres 7 jours sans validation : cle oubliee, rien n'est supprime, le PIN ne rouvre plus", async () => {
    const { ctl, empreinte } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    avancerEnActivite(ctl, 7 * JOUR - 1000);
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    env.h.t += 1000; ctl.tick();
    expect(ctl.instantane()).toMatchObject({ etat: "EXPIRE", deverrouille: false, ecran: "SESSION_EXPIREE" });
    expect(await ctl.deverrouiller(PIN)).toMatchObject({ ok: false, erreur: "EXPIRE" });
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A"]); // le coffre est intact
    expect(evenementsJournal(empreinte)).toContain("SESSION_LOCALE_EXPIREE");
  });

  it("un coffre verrouille et perime : le PIN juste revele l'expiration (EXPIRE), pas un PIN faux", async () => {
    const { ctl, empreinte } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    ctl.verrouiller();
    env.h.t += 8 * JOUR;
    expect(await ctl.deverrouiller("faux-pin-x")).toMatchObject({ erreur: "PIN_INCORRECT" });
    expect(await ctl.deverrouiller(PIN)).toMatchObject({ ok: false, erreur: "EXPIRE" });
    expect(ctl.instantane().etat).toBe("EXPIRE");
    expect(evenementsJournal(empreinte)).toContain("SESSION_LOCALE_EXPIREE");
  });

  it("une horloge qui recule de plus de 5 minutes est une falsification : EXPIRE ; 5 minutes exactement est toleree", async () => {
    const a = await ouvrirSession();
    await a.ctl.reseauPerdu("EVENEMENT");
    avancerEnActivite(a.ctl, 12 * MIN);
    env.h.t -= 5 * MIN; a.ctl.signalerActivite(); a.ctl.tick();
    expect(a.ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    env.h.t -= 1; a.ctl.tick();
    expect(a.ctl.instantane().etat).toBe("EXPIRE");
    expect(evenementsJournal(a.empreinte)).toContain("SESSION_LOCALE_EXPIREE");
  });

  it("un cycle ouvert, perdu puis revenu avec droits inchanges repousse l'expiration (prolonger)", async () => {
    const { ctl, e } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    avancerEnActivite(ctl, 3 * JOUR);
    await ctl.reseauRevenu();
    expect(e.sondes).toBe(1);
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", deverrouille: true, droitsAReverifier: null });
    // Six jours plus tard (9 depuis la creation), hors ligne : la validite repart de la reconnexion, pas de la creation.
    await ctl.reseauPerdu("EVENEMENT");
    avancerEnActivite(ctl, 6 * JOUR);
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
  });
});

describe("reconnexion", () => {
  it("droits changes : la session locale est invalidee, le coffre reste intact, le PIN la renouvelle", async () => {
    const { ctl, e } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    e.moi = agent("agent-A", { role: "GESTIONNAIRE" as Role, modulesAutorises: ["inspections"], regions: [3] });
    await ctl.reseauRevenu();
    const s = ctl.instantane();
    expect(s.etat).toBe("EN_LIGNE");
    expect(s.droitsAReverifier).toEqual(expect.arrayContaining(["role", "modules", "regions"]));
    expect(s.deverrouille).toBe(false);
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A"]);
    await vi.waitFor(() => expect(e.evenements.flatMap((l) => l.evenements.map((x) => x.evenement))).toContain("SESSION_LOCALE_FERMEE"));

    // Renouvellement : le PIN suffit, le profil prend les droits du serveur.
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    expect(ctl.instantane().droitsAReverifier).toBeNull();
    expect(coffreCourant().profilCourant()).toMatchObject({ role: "GESTIONNAIRE", modules: ["inspections"], regions: ["3"] });
  });

  it("droits changes puis redemarrage HORS LIGNE avant le renouvellement : EXPIRE, jamais une ouverture avec les anciens droits", async () => {
    const { ctl, e } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    e.moi = agent("agent-A", { role: "ADMIN" as Role });
    await ctl.reseauRevenu();
    expect(ctl.instantane().droitsAReverifier).not.toBeNull();
    ctl.desactiver();
    fermerCompte();

    const { serveur, e: e2 } = fauxServeur(agent("agent-A"));
    e2.reseau = false;
    const apres = env.nouveau(serveur);
    await apres.demarrer();
    expect(apres.instantane()).toMatchObject({ etat: "EXPIRE", ecran: "SESSION_EXPIREE", deverrouille: false });
    expect(await apres.deverrouiller(PIN)).toMatchObject({ ok: false, erreur: "EXPIRE" });
  });

  it("jeton refuse (401) a la reconnexion : la session se ferme, la file chiffree et le coffre sont conserves", async () => {
    const { ctl, e, serveur } = await ouvrirSession();
    void serveur;
    await ctl.reseauPerdu("EVENEMENT");
    e.refus = 401;
    await ctl.reseauRevenu();
    const s = ctl.instantane();
    expect(s).toMatchObject({ etat: "FERME", utilisateur: null, deverrouille: false });
    expect(s.messageFermeture).toMatch(/fermé votre session/);
    expect(env.marqueur.present).toBe(false);
    expect(e.jeton).toBeNull();
    expect(compteCourant()).toBeNull();
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A"]);
    expect(lireIndice().comptes["agent-A"]).toBeUndefined();
  });

  it("403 : meme conduite que 401", async () => {
    const { ctl, e } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    e.refus = 403;
    await ctl.reseauRevenu();
    expect(ctl.instantane().etat).toBe("FERME");
  });

  it("reseau coupe ou serveur en panne (5xx) : PAS de deconnexion, l'agent reste hors ligne et connecte", async () => {
    const { ctl, e } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    e.reseau = false;
    await ctl.reseauRevenu();
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_OUVERT", deverrouille: true });
    expect(ctl.instantane().utilisateur?.id).toBe("agent-A");
    e.reseau = true; e.indisponible = true;
    await ctl.reseauRevenu();
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_OUVERT", deverrouille: true });
    expect(env.marqueur.present).toBe(true);
    e.indisponible = false;
    await ctl.reseauRevenu();
    expect(ctl.instantane().etat).toBe("EN_LIGNE");
  });

  it("une requete qui echoue sans reponse declenche une SONDE reelle, au plus une par 10 secondes", async () => {
    const { ctl, e } = await ouvrirSession();
    e.reseau = false;
    await ctl.reseauPerdu("REQUETE");
    expect(e.sondes).toBe(1);
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    // Deja hors ligne : plus rien a sonder cote requete.
    await ctl.reseauPerdu("REQUETE");
    expect(e.sondes).toBe(1);
  });

  it("une requete qui echoue alors que le reseau va bien ne fait pas basculer hors ligne", async () => {
    const { ctl, e } = await ouvrirSession();
    await ctl.reseauPerdu("REQUETE"); // sonde -> OK
    expect(e.sondes).toBe(1);
    expect(ctl.instantane().etat).toBe("EN_LIGNE");
    env.h.t += 5000;
    await ctl.reseauPerdu("REQUETE"); // trop tot : pas de nouvelle sonde
    expect(e.sondes).toBe(1);
    env.h.t += 10_000;
    await ctl.reseauPerdu("REQUETE");
    expect(e.sondes).toBe(2);
  });

  it("sans coffre, une coupure ne change rien (comportement d'avant)", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const ctl = env.nouveau(serveur);
    await ctl.connecter("a@x", "pw");
    await ctl.reseauPerdu("EVENEMENT");
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", horsLigne: false });
  });
});

describe("demarrage SANS reseau", () => {
  async function preparer(...ids: string[]) {
    for (const id of ids) {
      const { ctl } = await ouvrirSession(agent(id));
      ctl.verrouiller();
      ctl.desactiver();
      fermerCompte();
    }
  }
  const demarrerHorsLigne = async (indisponible = false) => {
    const { serveur, e } = fauxServeur(agent("x"));
    if (indisponible) e.indisponible = true; else e.reseau = false;
    const ctl = env.nouveau(serveur);
    await ctl.demarrer();
    return { ctl, e };
  };

  it("un coffre, reseau coupe : ecran de deverrouillage ; apres le PIN, l'utilisateur est reconstruit du profil du coffre", async () => {
    await preparer("agent-A");
    const { ctl } = await demarrerHorsLigne();
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_VERROUILLE", ecran: "DEVERROUILLAGE", utilisateur: null, nomCompte: "Agent agent-A" });
    expect(etatCompte()).toBe("VERROUILLE");
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    const s = ctl.instantane();
    expect(s).toMatchObject({ etat: "HORS_LIGNE_OUVERT", deverrouille: true, ecran: "AUCUN" });
    expect(s.utilisateur).toMatchObject({ id: "agent-A", role: "INSPECTEUR", modulesAutorises: ["inspections", "troncons"], nomComplet: "Agent agent-A" });
    expect(env.migrer).toHaveBeenCalled();
  });

  it("serveur en panne (5xx) au demarrage : meme conduite qu'un reseau coupe", async () => {
    await preparer("agent-A");
    const { ctl } = await demarrerHorsLigne(true);
    expect(ctl.instantane().ecran).toBe("DEVERROUILLAGE");
  });

  it("aucun coffre : ecran de connexion (rien a deverrouiller)", async () => {
    const { ctl } = await demarrerHorsLigne();
    expect(ctl.instantane()).toMatchObject({ etat: "DECONNECTE", ecran: "AUCUN", utilisateur: null, demarre: true });
  });

  it("sans marqueur de session (deconnexion en ligne faite), aucune ouverture hors ligne : la conception l'interdit", async () => {
    await preparer("agent-A");
    env.marqueur.present = false;
    const { ctl } = await demarrerHorsLigne();
    expect(ctl.instantane()).toMatchObject({ etat: "DECONNECTE", ecran: "AUCUN" });
  });

  it("deux coffres : l'indice du dernier compte designe celui a ouvrir, l'autre reste proposable", async () => {
    await preparer("agent-A", "agent-B"); // B est le dernier connecte
    const { ctl } = await demarrerHorsLigne();
    expect(ctl.instantane()).toMatchObject({ ecran: "DEVERROUILLAGE", compteId: "agent-B", nomCompte: "Agent agent-B" });
    expect(ctl.instantane().candidats.map((c) => c.compteId).sort()).toEqual(["agent-A", "agent-B"]);
    await ctl.choisirCompte("agent-A");
    expect(ctl.instantane()).toMatchObject({ ecran: "DEVERROUILLAGE", compteId: "agent-A", nomCompte: "Agent agent-A" });
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    expect(ctl.instantane().utilisateur?.id).toBe("agent-A");
  });

  it("deux coffres sans indice : choix du compte, puis deverrouillage", async () => {
    await preparer("agent-A", "agent-B");
    localStorage.removeItem(CLE_INDICE_COMPTES);
    const { ctl } = await demarrerHorsLigne();
    expect(ctl.instantane().ecran).toBe("CHOIX_COMPTE");
    expect(ctl.instantane().candidats).toHaveLength(2);
    await ctl.choisirCompte("agent-B");
    expect(ctl.instantane()).toMatchObject({ ecran: "DEVERROUILLAGE", compteId: "agent-B" });
  });

  it("un compte qui n'est pas propose ne peut pas etre choisi", async () => {
    await preparer("agent-A", "agent-B");
    localStorage.removeItem(CLE_INDICE_COMPTES);
    const { ctl } = await demarrerHorsLigne();
    await ctl.choisirCompte("agent-Z");
    expect(ctl.instantane().ecran).toBe("CHOIX_COMPTE");
    expect(compteCourant()).toBeNull();
  });

  it("refus du serveur (401) au demarrage : la session est fermee, le coffre conserve, le marqueur purge", async () => {
    await preparer("agent-A");
    const { serveur, e } = fauxServeur(agent("agent-A"));
    e.refus = 401;
    const ctl = env.nouveau(serveur);
    await ctl.demarrer();
    expect(ctl.instantane()).toMatchObject({ etat: "FERME", ecran: "AUCUN", utilisateur: null });
    expect(ctl.instantane().messageFermeture).toMatch(/fermé votre session/);
    expect(env.marqueur.present).toBe(false);
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A"]);
  });

  it("le message de fermeture survit a un rechargement de page (le garde-fou de api.ts recharge vers /login)", async () => {
    const { ctl, e } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    e.refus = 401;
    await ctl.reseauRevenu();
    ctl.desactiver();
    env.marqueur.present = false;
    const { serveur } = fauxServeur(agent("agent-A"));
    const apres = env.nouveau(serveur);
    await apres.demarrer();
    expect(apres.instantane().messageFermeture).toMatch(/fermé votre session/);
    apres.acquitterMessage();
    expect(apres.instantane().messageFermeture).toBeNull();
  });

  it("en ligne au demarrage : session reprise, utilisateur du serveur, coffre verrouille", async () => {
    await preparer("agent-A");
    const { serveur } = fauxServeur(agent("agent-A"));
    const ctl = env.nouveau(serveur);
    await ctl.demarrer();
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", coffrePresent: true, deverrouille: false, demarre: true });
    expect(ctl.instantane().utilisateur?.id).toBe("agent-A");
  });
});

describe("PIN : essais successifs", () => {
  it("5 echecs sans delai, le 6e impose 30 s, l'attente est refusee sans compter un echec de plus, puis tout repart", async () => {
    const { ctl } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    ctl.verrouiller();
    for (let i = 1; i <= 5; i += 1) expect(await ctl.deverrouiller(`faux-pin-${i}`)).toMatchObject({ erreur: "PIN_INCORRECT" });
    expect(ctl.instantane().attenteJusquaMs).toBeNull();
    const sixieme = await ctl.deverrouiller("faux-pin-6");
    expect(sixieme).toMatchObject({ erreur: "PIN_INCORRECT", reessayerDansMs: 30_000 });
    expect(ctl.instantane().attenteJusquaMs).toBe(env.h.t + 30_000);
    expect(await ctl.deverrouiller(PIN)).toMatchObject({ ok: false, erreur: "DELAI_EN_COURS" });
    expect(ctl.instantane().echecsPin).toBe(6);
    env.h.t += 30_000;
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    expect(ctl.instantane().echecsPin).toBe(0);
  });

  it("les echecs sont aggreges dans le journal (un evenement, son nombre) et ne contiennent aucun PIN", async () => {
    const { ctl, empreinte } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    ctl.verrouiller();
    for (let i = 0; i < 4; i += 1) await ctl.deverrouiller(`faux-pin-${i}`);
    const entrees = creerJournal({ empreinte, stockage: localStorage }).lire();
    const echecs = entrees.filter((x) => x.evenement === "ECHEC_DEVERROUILLAGE");
    expect(echecs).toHaveLength(1);
    expect(echecs[0].occurrences).toBe(4);
    expect(JSON.stringify(entrees)).not.toContain("faux-pin");
    expect(localStorage.getItem(cleLocalStorage(empreinte, "evenementsLocaux"))).not.toContain(PIN);
  });
});

describe("deconnexion : rien n'est efface", () => {
  async function avecFileNonVide() {
    const s = await ouvrirSession();
    // Une vraie saisie dans la vraie base du compte.
    await addPendingObservation({
      localId: "o1", createdAt: "2026-10-25T08:03:00.000Z", status: "pending",
      payload: { type: "DEGRADATION", description: "x", observeA: "2026-10-25T08:03:00.000Z", lat: 9.6, lon: -13.5 },
    } as PendingObservation);
    env.file.courante = { ...VIDE, enAttente: 2, photosEnFile: 3 };
    return s;
  }
  const basesDuCompte = async (empreinte: string) =>
    ((await indexedDB.databases()) as { name?: string }[]).map((d) => d.name).includes(nomBaseOffline(empreinte));

  it("en ligne : session fermee, marqueur purge, coffre ET base du compte intacts, le texte dit ce qui reste", async () => {
    const { ctl, e, empreinte } = await avecFileNonVide();
    const d = await ctl.deconnecter();
    expect(d).toMatchObject({ fermeSession: true, efface: false });
    expect(d.texte).toMatch(/Aucune donnée locale n'a été supprimée/);
    expect(d.texte).toMatch(/2 saisies/);
    expect(d.texte).toMatch(/3 photos/);
    expect(ctl.instantane()).toMatchObject({ etat: "FERME", utilisateur: null });
    expect(env.marqueur.present).toBe(false);
    expect(e.jeton).toBeNull();
    expect(e.deconnexions).toEqual([false]);
    expect(await basesDuCompte(empreinte)).toBe(true);
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A"]);
    // Le meme compte, a la prochaine connexion, retrouve sa saisie.
    const { serveur } = fauxServeur(agent("agent-A"));
    const apres = env.nouveau(serveur);
    await apres.connecter("a@x", "pw");
    expect(await apres.deverrouiller(PIN)).toEqual({ ok: true });
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["o1"]);
  });

  it("hors ligne : verrou local immediat, drapeau persiste, rejoue au retour du reseau ; le compte ne se rouvre pas", async () => {
    const { ctl, e, empreinte } = await avecFileNonVide();
    e.reseau = false;
    const d = await ctl.deconnecter();
    expect(d).toMatchObject({ fermeSession: false, verrouLocal: true, deconnexionEnAttente: true, efface: false });
    expect(ctl.instantane()).toMatchObject({ etat: "HORS_LIGNE_VERROUILLE", deverrouille: false, ecran: "DEVERROUILLAGE" });
    expect(lireIndice().comptes["agent-A"]).toMatchObject({ deconnexionEnAttente: true });
    expect(env.marqueur.present).toBe(true); // le cookie de rafraichissement n'est pas revoque : on s'en souvient
    expect(await basesDuCompte(empreinte)).toBe(true);

    e.reseau = true;
    await ctl.reseauRevenu();
    await vi.waitFor(() => expect(e.deconnexions).toEqual([false, false]));
    await vi.waitFor(() => expect(ctl.instantane().etat).toBe("FERME"));
    expect(env.marqueur.present).toBe(false);
    expect(lireIndice().comptes["agent-A"]).toBeUndefined();
    expect(ctl.instantane().utilisateur).toBeNull();
  });

  it("hors ligne puis redemarrage hors ligne : le drapeau est relu, la deconnexion reste en attente", async () => {
    const { ctl, e } = await avecFileNonVide();
    e.reseau = false;
    await ctl.deconnecter();
    ctl.desactiver();
    fermerCompte();
    const { serveur, e: e2 } = fauxServeur(agent("agent-A"));
    e2.reseau = false;
    const apres = env.nouveau(serveur);
    await apres.demarrer();
    expect(apres.instantane().etat).toBe("HORS_LIGNE_VERROUILLE");
    // Le reseau revient : la session ne se rouvre pas, la deconnexion est rejouee.
    e2.reseau = true;
    await apres.reseauRevenu();
    await vi.waitFor(() => expect(apres.instantane().etat).toBe("FERME"));
    expect(e2.deconnexions).toContain(false);
    expect(env.marqueur.present).toBe(false);
  });

  it("tous les appareils : la demande est transmise, hors ligne elle est rejouee avec le meme perimetre", async () => {
    const { ctl, e } = await ouvrirSession();
    e.reseau = false;
    await ctl.deconnecter({ tous: true });
    expect(lireIndice().comptes["agent-A"]).toMatchObject({ deconnexionEnAttente: true, tous: true });
    e.reseau = true;
    await ctl.reseauRevenu();
    await vi.waitFor(() => expect(e.deconnexions).toEqual([true, true]));
  });

  it("une connexion neuve apres une deconnexion hors ligne annule la deconnexion en attente (elle fermerait la neuve)", async () => {
    const { ctl, e } = await ouvrirSession();
    e.reseau = false;
    await ctl.deconnecter();
    e.reseau = true;
    await ctl.connecter("a@x", "pw");
    expect(ctl.instantane().etat).toBe("EN_LIGNE");
    expect(lireIndice().comptes["agent-A"]).toEqual({ nom: "Agent agent-A" });
    await ctl.reseauRevenu();
    expect(e.deconnexions).toEqual([false]); // une seule tentative, la premiere
  });
});

describe("reinitialisation du PIN", () => {
  it("le decompte annonce la perte ; la reinitialisation detruit le coffre et les bases, journalise, ferme le compte, laisse recreer un PIN", async () => {
    const { ctl, empreinte } = await ouvrirSession();
    await addPendingObservation({
      localId: "o1", createdAt: "2026-10-25T08:03:00.000Z", status: "pending",
      payload: { type: "DEGRADATION", description: "x", observeA: "2026-10-25T08:03:00.000Z", lat: 9.6, lon: -13.5 },
    } as PendingObservation);
    env.file.courante = { ...VIDE, enAttente: 4, photosEnFile: 2 };
    const apercu = await ctl.apercuPerte();
    expect(apercu).toMatchObject({ refusee: true, nbSaisies: 4, nbPhotos: 2 });

    ctl.verrouiller();
    const r = await ctl.reinitialiserPin();
    expect(r).toEqual({ ok: true });
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual([]);
    expect(((await indexedDB.databases()) as { name?: string }[]).map((d) => d.name)).not.toContain(nomBaseOffline(empreinte));
    expect(compteCourant()).toBeNull();
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", coffrePresent: false, pinACreer: true, deverrouille: false });
    expect(evenementsJournal(empreinte)).toContain("PIN_REINITIALISE");

    // Un nouveau PIN repart de zero : la file est vide, plus aucune saisie illisible.
    expect(await ctl.creerPin("nouveau-pin-77")).toEqual({ ok: true });
    expect(await getAllPendingObservations()).toEqual([]);
  });

  it("sans saisie en attente, l'apercu dit que rien n'est perdu", async () => {
    const { ctl } = await ouvrirSession();
    expect(await ctl.apercuPerte()).toMatchObject({ refusee: false, nbSaisies: 0 });
  });

  it("hors ligne : plus rien a ouvrir, l'indice du compte est retire", async () => {
    const { ctl } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    ctl.verrouiller();
    expect(await ctl.reinitialiserPin()).toEqual({ ok: true });
    expect(ctl.instantane().etat).toBe("DECONNECTE");
    expect(lireIndice().comptes["agent-A"]).toBeUndefined();
  });

  it("changer le PIN : l'ancien est exige, le nouveau ne doit pas etre trivial, l'ancien ne marche plus ensuite", async () => {
    const { ctl } = await ouvrirSession();
    expect(await ctl.changerPin("mauvais", "nouveau-pin-77")).toMatchObject({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await ctl.changerPin(PIN, "123456")).toMatchObject({ ok: false, erreur: "PIN_TRIVIAL" });
    expect(await ctl.changerPin(PIN, "nouveau-pin-77")).toEqual({ ok: true });
    ctl.verrouiller();
    expect(await ctl.deverrouiller(PIN)).toMatchObject({ ok: false, erreur: "PIN_INCORRECT" });
    expect(await ctl.deverrouiller("nouveau-pin-77")).toEqual({ ok: true });
  });
});

describe("effacement local par le controleur", () => {
  it("refuse tant que la file n'est pas vide (rien n'est touche), accepte file vide, journalise UNE fois", async () => {
    const { ctl, empreinte } = await ouvrirSession();
    env.file.courante = { ...VIDE, enAttente: 1 };
    const refus = await ctl.effacerDonneesLocales();
    expect(refus).toMatchObject({ ok: false, raison: "FILE_NON_VIDE" });
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A"]);
    expect(compteCourant()?.compteId).toBe("agent-A");
    expect(ctl.instantane().deverrouille).toBe(true);

    env.file.courante = VIDE;
    expect((await ctl.effacerDonneesLocales()).ok).toBe(true);
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual([]);
    expect(ctl.instantane()).toMatchObject({ etat: "EN_LIGNE", coffrePresent: false, pinACreer: true, deverrouille: false });
    expect(evenementsJournal(empreinte).filter((x) => x === "EFFACEMENT_LOCAL")).toHaveLength(1);
    expect(lireIndice().comptes["agent-A"]).toBeUndefined();
  });
});

describe("deux comptes successifs sur le meme stockage", () => {
  it("le second ne voit rien du premier, et le premier retrouve ses saisies", async () => {
    const a = await ouvrirSession(agent("agent-A"));
    await addPendingObservation({
      localId: "obs-de-A", createdAt: "2026-10-25T08:03:00.000Z", status: "pending",
      payload: { type: "DEGRADATION", description: "secret de A", observeA: "2026-10-25T08:03:00.000Z", lat: 9.6, lon: -13.5 },
    } as PendingObservation);
    await compterFile(); // le badge de l'en-tete le fait a chaque rafraichissement : il pose le compteur d'information du compte
    await a.ctl.deconnecter();
    expect(compteCourant()).toBeNull();

    const b = await ouvrirSession(agent("agent-B"));
    expect(compteCourant()?.compteId).toBe("agent-B");
    expect(await getAllPendingObservations()).toEqual([]);
    expect(resumeAutresComptes()).toMatchObject({ comptes: 1, saisies: 1 }); // un nombre, jamais un contenu
    expect(b.ctl.instantane().autresComptes).toMatchObject({ comptes: 1, saisies: 1 });
    expect(JSON.stringify(b.ctl.instantane())).not.toContain("secret de A");
    // Le coffre de A ne s'ouvre pas avec le PIN de B (ici le meme PIN, mais c'est un autre coffre : autre sel, autre cle).
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual(["agent-A", "agent-B"]);
    await b.ctl.deconnecter();

    const retour = fauxServeur(agent("agent-A"));
    const ctl = env.nouveau(retour.serveur);
    await ctl.connecter("a@x", "pw");
    expect(await ctl.deverrouiller(PIN)).toEqual({ ok: true });
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["obs-de-A"]);
  });

  it("se connecter sous un autre compte dans le meme controleur verrouille et ferme le precedent avant d'ouvrir le suivant", async () => {
    const a = await ouvrirSession(agent("agent-A"));
    const coffreA = coffreCourant();
    expect(coffreA.estDeverrouille()).toBe(true);
    a.e.moi = agent("agent-B");
    await a.ctl.connecter("b@x", "pw");
    expect(coffreA.estDeverrouille()).toBe(false);
    expect(compteCourant()).toBeNull(); // B n'a pas encore de coffre : rien d'ouvert, surtout pas le compte de A
    expect(a.ctl.instantane()).toMatchObject({ compteId: "agent-B", pinACreer: true });
    expect(a.ctl.instantane().utilisateur?.id).toBe("agent-B");
  });
});

describe("journal des evenements locaux, de bout en bout", () => {
  it("les evenements d'une periode hors ligne partent au retour du reseau, une seule fois, et le journal se vide", async () => {
    const { ctl, e, empreinte } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    env.h.t += 5 * MIN; ctl.tick();
    await ctl.deverrouiller("faux-pin-1");
    await ctl.deverrouiller(PIN);
    e.reseau = true;
    await ctl.reseauRevenu();
    await vi.waitFor(() => expect(e.evenements.length).toBeGreaterThan(0));
    const envoyes = e.evenements.flatMap((l) => l.evenements.map((x) => x.evenement));
    expect(envoyes).toEqual(["OUVERTURE_HORS_LIGNE", "VERROU_INACTIVITE", "ECHEC_DEVERROUILLAGE", "DEVERROUILLAGE"]);
    expect(evenementsJournal(empreinte)).toEqual([]);
    // Chaque corps respecte le schema strict du serveur.
    for (const lot of e.evenements) {
      expect(Object.keys(lot).every((k) => k === "appareilId" || k === "evenements")).toBe(true);
      for (const x of lot.evenements) expect(Object.keys(x).every((k) => ["id", "evenement", "horodatageClient", "occurrences"].includes(k))).toBe(true);
    }
  });

  it("un envoi qui echoue ne perd rien ; le rejeu repart avec les memes identifiants", async () => {
    const { ctl, e, empreinte } = await ouvrirSession();
    await ctl.reseauPerdu("EVENEMENT");
    ctl.verrouiller();
    await ctl.deverrouiller(PIN);
    const avant = creerJournal({ empreinte, stockage: localStorage }).lire().map((x) => x.id);
    expect(avant.length).toBeGreaterThan(0);
    e.echecEvenements = 503;
    await ctl.reseauRevenu();
    await vi.waitFor(() => expect(ctl.instantane().etat).toBe("EN_LIGNE"));
    await ctl.envoyerJournal();
    expect(creerJournal({ empreinte, stockage: localStorage }).lire().map((x) => x.id)).toEqual(avant);
    e.echecEvenements = false;
    await ctl.envoyerJournal();
    expect(e.evenements.flatMap((l) => l.evenements.map((x) => x.id))).toEqual(avant);
  });
});

describe("robustesse", () => {
  it("sans WebCrypto (page non securisee), la connexion reste possible ; seule la creation du PIN est refusee, avec un message clair", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const c = new ControleurSession({
      serveur, stockageCoffre: env.stockageCoffre, stockageTexte: localStorage as never, idAppareilLocal: () => "tel-1", maintenant: () => env.h.t,
      marqueur: { present: () => false, poser: () => undefined, purger: () => undefined },
      sha256: async () => { throw new Error("crypto.subtle indisponible"); },
      optionsCoffre: { iterations: 1000, iterationsDeTest: true }, decompteFile: async () => VIDE, retourReseauMs: 0,
    });
    env.controleurs.push(c);
    await c.demarrer();
    await c.connecter("a@x", "pw");
    expect(c.instantane()).toMatchObject({ etat: "EN_LIGNE", demarre: true });
    expect(c.instantane().utilisateur?.id).toBe("agent-A");
    expect(await c.creerPin(PIN)).toMatchObject({ ok: false, erreur: "WEBCRYPTO_INDISPONIBLE" });
    expect(await listerComptesAvecCoffre(env.stockageCoffre)).toEqual([]);
  });

  it("un rafraichissement tardif ne rouvre pas une session fermee", async () => {
    const { ctl } = await ouvrirSession();
    await ctl.deconnecter();
    expect(ctl.instantane().etat).toBe("FERME");
    await ctl.surRafraichissement({ etat: "OK", token: "jeton-tardif" });
    expect(ctl.instantane()).toMatchObject({ etat: "FERME", utilisateur: null });
  });

  it("un rafraichissement reussi renouvelle le marqueur de session (sinon il expire 7 jours apres la connexion)", async () => {
    const { ctl } = await ouvrirSession();
    env.marqueur.present = false; // le cookie marqueur a expire
    await ctl.surRafraichissement({ etat: "OK", token: "jeton-renouvele" });
    expect(env.marqueur.present).toBe(true);
  });

  it("un meme objet d'issue n'est traite qu'une fois (demarrage + ecouteur de api.ts)", async () => {
    const { ctl, e } = await ouvrirSession();
    const issue: ResultatRafraichissement = { etat: "RESEAU_COUPE" };
    await ctl.surRafraichissement(issue);
    expect(ctl.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    await ctl.reseauRevenu();
    expect(ctl.instantane().etat).toBe("EN_LIGNE");
    await ctl.surRafraichissement(issue); // meme objet : ignore
    expect(ctl.instantane().etat).toBe("EN_LIGNE");
    void e;
  });
});

describe("minuteurs", () => {
  it("TICK seulement quand une cle est en memoire ; le nouvel essai de reseau seulement hors ligne", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { serveur } = fauxServeur(agent("agent-A"));
    const h = { t: T0 };
    const c = new ControleurSession({
      serveur, stockageCoffre: env.stockageCoffre, stockageTexte: fauxLocalStorage(), idAppareilLocal: () => "tel-1", maintenant: () => h.t,
      marqueur: { present: () => true, poser: () => undefined, purger: () => undefined }, sha256: sha256WebCrypto,
      optionsCoffre: { iterations: 1000, iterationsDeTest: true }, decompteFile: async () => VIDE, retourReseauMs: 30_000,
    });
    env.controleurs.push(c);
    await c.connecter("a@x", "pw");
    expect(vi.getTimerCount()).toBe(0); // connecte sans coffre : rien a verrouiller
    await c.creerPin(PIN);
    expect(vi.getTimerCount()).toBe(1); // cle en memoire : TICK
    await c.reseauPerdu("EVENEMENT");
    expect(vi.getTimerCount()).toBe(2); // + nouvel essai de reseau
    c.verrouiller();
    expect(vi.getTimerCount()).toBe(1); // cle oubliee : plus de TICK, reste l'essai de reseau
    await c.reseauRevenu();
    expect(vi.getTimerCount()).toBe(0); // en ligne, verrouille : aucun minuteur
    c.desactiver();
  });

  it("l'intervalle fait vraiment avancer le noyau : une seconde par TICK, verrou a 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { serveur } = fauxServeur(agent("agent-A"));
    const h = { t: T0 };
    const c = new ControleurSession({
      serveur, stockageCoffre: env.stockageCoffre, stockageTexte: fauxLocalStorage(), idAppareilLocal: () => "tel-1", maintenant: () => h.t,
      marqueur: { present: () => true, poser: () => undefined, purger: () => undefined }, sha256: sha256WebCrypto,
      optionsCoffre: { iterations: 1000, iterationsDeTest: true }, decompteFile: async () => VIDE, retourReseauMs: 0,
    });
    env.controleurs.push(c);
    await c.connecter("a@x", "pw");
    await c.creerPin(PIN);
    for (let i = 0; i < 299; i += 1) { h.t += 1000; await vi.advanceTimersByTimeAsync(1000); }
    expect(c.instantane().deverrouille).toBe(true);
    h.t += 1000; await vi.advanceTimersByTimeAsync(1000);
    expect(c.instantane().deverrouille).toBe(false);
    c.desactiver();
  });
});
