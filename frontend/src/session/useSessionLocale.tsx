/**
 * Hote de la session locale hors ligne (conception : docs/securite/SESSION-HORS-LIGNE.md, sections 1 a 9).
 *
 * Le NOYAU (`noyauSession.ts`) est pur : il calcule des transitions. Ce module est l'HOTE : il possede l'instance du noyau
 * (etat et contexte), les minuteurs, les evenements du navigateur, le coffre (`coffreSession.ts`), le compte courant du
 * stockage (`compteCourant.ts`) et le journal des evenements locaux, et il execute les EFFETS que le noyau rend
 * (OUBLIER_DEK, REJOUER_DECONNEXION, JOURNALISER). Tout ce qui touche le reseau, le temps ou le stockage entre par
 * `DepsControleur` : les tests rejouent sept jours avec de faux minuteurs et le vrai coffre.
 *
 * DEUX COUCHES DANS CE FICHIER
 *   1. `ControleurSession` : classe sans React. C'est un magasin externe (`abonner`, `instantane`).
 *   2. `SessionLocaleProvider`, `useSessionLocale`, `useSessionLocaleOptionnelle`, `brancherNavigateur` : la colle React et DOM.
 *
 * DECISIONS DE CONDUITE (a connaitre avant de modifier)
 *   - L'identite affichee hors ligne est RECONSTRUITE du profil du coffre (role, modules) ; l'e-mail est inconnu.
 *   - Le deverrouillage n'est EXIGE que sur les routes qui utilisent la file locale (`routeUtiliseLaFile`). Ailleurs, un
 *     coffre verrouille ne gene pas ; hors ligne, les autres routes sont indisponibles (`routeDisponibleHorsLigne`).
 *   - Un changement de droits (role, modules, regions) constate a la reconnexion invalide la session locale : la cle est
 *     oubliee, le coffre reste intact, et l'agent la renouvelle avec son PIN (`revalider`) une fois en ligne. L'avis est
 *     persiste : un redemarrage hors ligne avant le renouvellement donne EXPIRE, pas une ouverture avec les anciens droits.
 *   - Les issues de rafraichissement viennent de DEUX sources (le demarrage et l'ecouteur de api.ts) ; un meme objet n'est
 *     traite qu'une fois (`traites`).
 *   - L'indicateur « reseau perdu » d'une requete qui echoue n'est PAS cru sur parole : il declenche une sonde reelle
 *     (un rafraichissement), au plus une par 10 secondes. L'evenement `offline` du navigateur, lui, est cru.
 *   - Au verrou, la cle est oubliee mais les pages restent montees (cachees) : un releve de roulage en cours continue de
 *     tourner et une saisie commencee n'est pas perdue. Voir ProtectedRoute.
 *
 * CE QUE LE VERROU FAIT, ET NE FAIT PAS (decision de conduite, a connaitre avant de la juger)
 *   Le verrou MASQUE l'interface (le contenu est inert, invisible, hors lecteurs d'ecran, et l'ecran de PIN passe au-dessus de
 *   tout, portails compris) et OUBLIE la cle de donnees. Il NE PURGE PAS le DOM NI LA MEMOIRE : le texte, les valeurs de champs
 *   et les donnees deja dechiffrees restent dans les pages montees (ils sont lisibles par un script de l'origine ou par les
 *   outils de developpement), et le ramasse-miettes n'a aucun delai garanti. Choix assume : demonter les pages arreterait un
 *   releve de roulage en cours et perdrait une saisie commencee. Seules les URL d'apercu enregistrees dans `urlsApercu.ts` sont
 *   revoquees au verrou. Le cache de requetes (React Query) n'est vide qu'en SORTIE de session ou au changement de compte.
 *
 * ACTIVITE
 *   `signalerActivite` = interaction reelle de l'agent (evenement ACTIVITE). `signalerActiviteExterne` = pont du releve
 *   (point GNSS) : evenement ACTIVITE_EXTERNE, plafonne et sans effet sur le verrou d'arriere-plan (noyauSession.ts).
 *
 * ONGLETS
 *   Le coffre et les bases sont partages par les onglets, pas la cle. Reinitialisation du PIN, effacement local, fermeture de
 *   session et changement de compte sont annonces aux AUTRES onglets (`canalOnglets.ts`), qui verrouillent et ferment le compte.
 */
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { User } from "../types";
import { ouvrirCompte, fermerCompte, resumeAutresComptes, type ResumeAutresComptes } from "../lib/compteCourant";
import { surEtatSynchronisation, type EtatSynchronisation } from "../lib/offlineSync";
import {
  effacerDonneesLocales, lireIndice, noterCompteDansIndice, retirerCompteDeIndice, supprimerStockageDuCompte,
  type ResultatEffacement,
} from "../lib/effacementLocal";
import { analyserPin } from "../components/session/pinTrivial";
import { surActivite } from "./activiteExterne";
import type { CanalOnglets, MessageCanal, TypeMessageCanal } from "./canalOnglets";
import { revoquerToutesLesUrlsApercu } from "./urlsApercu";
import {
  creerCoffre, ErreurCoffre, listerComptesAvecCoffre, ouvrirCoffre,
  type CoffreSession, type IdentiteProfil, type ResultatDeverrouillage, type StockageCoffre,
} from "./coffreSession";
import { cleLocalStorage, empreinteCompte, type PortSha256 } from "./compteLocal";
import {
  creerJournal, envoyerJournal, type CorpsLotEvenements, type StockageTexte,
} from "./journalEvenementsLocaux";
import {
  contexteInitial, differencesDeDroits, PARAMETRES_SESSION, tentativePinPossible, transition,
  type ContexteSession, type EffetSession, type EtatRafraichissement, type EtatSession, type EvenementSession, type ParametresSession,
  type ProfilSession,
} from "./noyauSession";
import {
  decisionDeconnexion, decisionSuppressionLocale,
  type ComptesFile, type DecisionDeconnexion, type DecisionSuppression,
} from "./politiqueDeconnexion";

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------

/**
 * Routes qui utilisent la file locale chiffree (saisies, photos, journal de roulage) : les cinq pages que
 * App.tsx declare et qui importent offlineDb, offlineSync ou roulageHote. Ce sont les SEULES qui fonctionnent hors ligne,
 * et les seules qui exigent le deverrouillage. `ReleveVehiculePage` (`/inspections/releve`) ne touche pas la file : elle
 * n'en fait pas partie.
 */
export const ROUTES_FILE_LOCALE: readonly string[] = [
  "/inspections/terrain",
  "/inspections/terrain/defauts",
  "/inspections/terrain/portions",
  "/inspections/terrain/observations",
  "/inspections/releve/enregistrer",
];

/**
 * Forme canonique d'un chemin pour la comparaison : le routeur ne distingue pas la casse (`caseSensitive` est faux par defaut),
 * decode le chemin et ignore la barre finale. Comparer le texte brut laissait `/Inspections/Terrain` afficher une page de file
 * SANS ecran de PIN. Un chemin non decodable est compare tel quel (limite : non verifie contre le routeur reel).
 */
export function cheminCanonique(pathname: string): string {
  let chemin = pathname;
  try { chemin = decodeURIComponent(pathname); } catch { /* chemin mal forme : compare tel quel */ }
  chemin = chemin.toLowerCase().replace(/\/{2,}/g, "/");
  return chemin.length > 1 ? chemin.replace(/\/+$/, "") : chemin;
}

export function routeUtiliseLaFile(pathname: string): boolean {
  return ROUTES_FILE_LOCALE.includes(cheminCanonique(pathname));
}

/** Hors ligne, seules les routes de la file locale fonctionnent (le reste a besoin du serveur). */
export const routeDisponibleHorsLigne = routeUtiliseLaFile;

/** Ce que le mode hors ligne ne peut pas verifier (conception, section 9) : affiche tel quel dans le bandeau. */
export const NON_VERIFIABLE_HORS_LIGNE: readonly string[] = [
  "l'existence et le statut de votre compte",
  "la révocation du compte ou de ce téléphone",
  "un changement de rôle ou de périmètre",
  "le second facteur (code à usage unique)",
  "l'heure exacte : seule l'horloge du téléphone fait foi",
];

// ---------------------------------------------------------------------------------------------------
// Dependances
// ---------------------------------------------------------------------------------------------------

/** Ce que le serveur renvoie a la connexion et a `GET /auth/me` : l'utilisateur plus son perimetre territorial. */
export interface UtilisateurServeur extends User {
  regions?: number[];
  perimetreNational?: boolean;
}

export type ResultatRafraichissement =
  | { readonly etat: "OK"; readonly token: string }
  | { readonly etat: "RESEAU_COUPE" }
  | { readonly etat: "INDISPONIBLE"; readonly statut: number }
  | { readonly etat: "REFUSE"; readonly statut: 401 | 403 };

export interface ServeurSession {
  connexion(email: string, motDePasse: string): Promise<{ requires2FA: true; challengeToken: string } | { accessToken: string; user: UtilisateurServeur }>;
  verifierDeuxFacteurs(challengeToken: string, code: string): Promise<{ accessToken: string; user: UtilisateurServeur }>;
  /** `GET /auth/me`. Leve l'erreur du transport (avec `response` si le serveur a repondu). */
  moi(): Promise<UtilisateurServeur>;
  /** `POST /auth/logout` ou `/auth/logout-all`. Vrai si le serveur a REPONDU (meme 401), faux sinon. Ne leve jamais. */
  deconnexion(tous: boolean): Promise<boolean>;
  /** Rafraichissement au demarrage de l'application. */
  rafraichirAuDemarrage(): Promise<ResultatRafraichissement>;
  /** Rafraichissement REEL (un jeton deja en memoire ne doit pas le court-circuiter) : sonde de reseau. */
  sonder(): Promise<ResultatRafraichissement>;
  envoyerEvenements(corps: CorpsLotEvenements): Promise<void>;
  poserJeton(jeton: string | null): void;
  /** Identifiant d'appareil enregistre aupres du serveur, quand l'appareil l'a deja obtenu. */
  appareilServeurId(): string | null;
}

export type StockageComplet = StockageTexte & Pick<Storage, "length" | "key">;

export interface DepsControleur {
  readonly serveur: ServeurSession;
  readonly stockageCoffre: StockageCoffre;
  readonly stockageTexte?: StockageComplet | null;
  readonly idAppareilLocal: () => string;
  readonly maintenant: () => number;
  readonly marqueur: { present(): boolean; poser(): void; purger(): void };
  readonly sha256: PortSha256;
  readonly optionsCoffre?: { iterations?: number; iterationsDeTest?: boolean };
  readonly parametres?: ParametresSession;
  readonly decompteFile: () => Promise<ComptesFile>;
  /** Migration de l'heritage (`migrerHeritage`), appelee coffre ouvert. */
  readonly migrer?: () => Promise<unknown>;
  /** Appele apres chaque ouverture reussie : relever le compteur de la file, relancer l'envoi. */
  readonly apresDeverrouillage?: () => void;
  readonly effacer?: (options: Parameters<typeof effacerDonneesLocales>[0]) => Promise<ResultatEffacement>;
  readonly enLigneNavigateur?: () => boolean;
  /** Periode du nouvel essai de reseau tant qu'on est hors ligne. 0 : aucun. */
  readonly retourReseauMs?: number;
  /** Duree minimale entre deux sondes declenchees par un echec de requete. */
  readonly sondeMinMs?: number;
  /**
   * Canal entre les onglets de l'appareil. ABSENT par defaut (`depsReelles` le fournit) : un controleur de test ne parle pas aux
   * autres controleurs du meme processus.
   */
  readonly canal?: CanalOnglets | null;
}

// ---------------------------------------------------------------------------------------------------
// Instantane
// ---------------------------------------------------------------------------------------------------

export type EcranSession = "AUCUN" | "CHOIX_COMPTE" | "DEVERROUILLAGE" | "SESSION_EXPIREE";

export interface CandidatCompte {
  readonly compteId: string;
  readonly nom: string | null;
}

export interface InstantaneSession {
  /** Change a chaque modification visible : sert d'identite au snapshot de useSyncExternalStore. */
  readonly version: number;
  /** Faux jusqu'a la fin du demarrage (equivalent de `loading`). */
  readonly demarre: boolean;
  readonly etat: EtatSession;
  readonly utilisateur: User | null;
  readonly compteId: string | null;
  readonly nomCompte: string | null;
  readonly coffrePresent: boolean;
  /** La cle est en memoire : la file est lisible. */
  readonly deverrouille: boolean;
  readonly horsLigne: boolean;
  readonly ecran: EcranSession;
  readonly candidats: readonly CandidatCompte[];
  /** Aucune tentative de PIN avant cet instant (ms) ; `null` : libre. */
  readonly attenteJusquaMs: number | null;
  readonly echecsPin: number;
  /** Differences de droits constatees a la reconnexion et pas encore renouvelees. */
  readonly droitsAReverifier: readonly string[] | null;
  /** Message a montrer a l'ecran de connexion (session fermee par le serveur, etc.). */
  readonly messageFermeture: string | null;
  /** L'agent a demande l'ecran de deverrouillage hors des routes qui l'exigent (bandeau). */
  readonly deverrouillageDemande: boolean;
  /** En ligne, connecte, sans coffre : le PIN reste a creer. */
  readonly pinACreer: boolean;
  readonly autresComptes: ResumeAutresComptes;
  readonly envoiJournalEnAttente: number;
}

const MESSAGE_REFUS_SERVEUR =
  "Le serveur a fermé votre session (session expirée, révoquée ou compte verrouillé). Vos saisies non envoyées restent chiffrées sur ce téléphone et partiront à votre prochaine connexion.";

const MESSAGE_AUTRE_COMPTE =
  "Un autre compte s'est connecté sur ce téléphone, dans un autre onglet : la session de cet onglet a été fermée. Vos saisies non envoyées restent chiffrées sur ce téléphone et partiront à votre prochaine connexion avec votre compte.";
const MESSAGE_SESSION_FERMEE_AILLEURS =
  "Vous vous êtes déconnecté dans un autre onglet : la session de cet onglet a été fermée. Vos saisies non envoyées restent chiffrées sur ce téléphone.";
const MESSAGE_PIN_REINITIALISE_AILLEURS =
  "Le code PIN a été réinitialisé dans un autre onglet : la session de cet onglet a été fermée. Reconnectez-vous pour créer un nouveau code.";
const MESSAGE_EFFACEMENT_AILLEURS =
  "Les données locales ont été effacées dans un autre onglet : la session de cet onglet a été fermée. Reconnectez-vous pour continuer.";

const NOM_DRAPEAU_DROITS = "droitsModifies";
const CLE_MESSAGE_SESSION = "bdri.messageSession";

const estHorsLigneEtat = (e: EtatSession) => e === "HORS_LIGNE_OUVERT" || e === "HORS_LIGNE_VERROUILLE";

type SansTemps<E> = E extends unknown ? Omit<E, "maintenantMs"> : never;
type EvenementSansTemps = SansTemps<EvenementSession>;

export type ResultatAction =
  | { readonly ok: true }
  | { readonly ok: false; readonly erreur: string; readonly message: string; readonly reessayerDansMs?: number };

const echec = (erreur: string, message: string, reessayerDansMs?: number): ResultatAction =>
  reessayerDansMs === undefined ? { ok: false, erreur, message } : { ok: false, erreur, message, reessayerDansMs };

const MESSAGES_ERREUR: Record<string, string> = {
  PIN_INCORRECT: "Code incorrect.",
  EXPIRE: "La session locale a expiré. Reconnectez-vous avec le réseau pour la renouveler : vos saisies restent chiffrées sur ce téléphone.",
  AUTRE_APPAREIL: "Cette session locale a été créée par une autre installation de l'application : elle ne peut pas être ouverte ici.",
  AUTRE_COMPTE: "Cette session locale appartient à un autre compte.",
  COFFRE_ABSENT: "Aucune session locale n'existe pour ce compte sur ce téléphone.",
  COFFRE_ILLISIBLE: "La session locale est illisible. Vos saisies restent chiffrées sur ce téléphone ; si vous ne pouvez pas la rouvrir, réinitialisez le code.",
  VERROUILLE: "Le téléphone s'est verrouillé pendant l'opération. Recommencez.",
  PIN_INVALIDE: "Ce code ne convient pas.",
  WEBCRYPTO_INDISPONIBLE: "Ce navigateur ne permet pas le chiffrement local (connexion non sécurisée ou navigateur trop ancien) : la session hors ligne est indisponible.",
  PIN_TRIVIAL: "Ce code est trop prévisible.",
  COFFRE_EXISTANT: "Une session locale existe déjà pour ce compte.",
  INDISPONIBLE: "Opération impossible pour le moment.",
};
const messageErreur = (code: string) => MESSAGES_ERREUR[code] ?? MESSAGES_ERREUR.INDISPONIBLE;

/** `regions` du serveur (numeros) en profil (chaines). Compte national : un marqueur, car « aucune region » est un autre cas. */
const MARQUEUR_NATIONAL = "NATIONAL";

function identiteDe(u: UtilisateurServeur): { identite: IdentiteProfil; regionsConnues: boolean } {
  const regionsConnues = u.perimetreNational === true || Array.isArray(u.regions);
  const regions = u.perimetreNational === true ? [MARQUEUR_NATIONAL] : Array.isArray(u.regions) ? u.regions.map(String) : [];
  return {
    identite: { userId: u.id, nom: u.nomComplet ?? "", role: u.role, modules: [...(u.modulesAutorises ?? [])], regions },
    regionsConnues,
  };
}

/** Utilisateur reconstruit du profil du coffre (ouverture hors ligne). L'e-mail n'est pas conserve. */
export function utilisateurDepuisProfil(p: ProfilSession): User {
  return {
    id: p.userId, email: "", nomComplet: p.nom, role: p.role as User["role"], actif: true,
    modulesAutorises: [...p.modules], peutDeleguerValidation: false, createdAt: new Date(p.emisLe).toISOString(),
  };
}

function stockageNavigateur(): StockageComplet | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Controleur
// ---------------------------------------------------------------------------------------------------

export class ControleurSession {
  private readonly deps: DepsControleur;
  private readonly parametres: ParametresSession;
  private readonly stockage: StockageComplet | null;

  private etat: EtatSession = "DECONNECTE";
  private contexte: ContexteSession = contexteInitial();
  private coffre: CoffreSession | null = null;
  private compteId: string | null = null;
  private empreinte: string | null = null;
  private nomCompte: string | null = null;
  private utilisateur: User | null = null;
  private identiteServeur: IdentiteProfil | null = null;
  private regionsConnues = true;

  private demarre = false;
  private demarrage: Promise<void> | null = null;
  private actif = true;
  private versLogin = false;
  private choixEnAttente = false;
  private issueHorsLigne: ResultatRafraichissement | null = null;
  private candidats: CandidatCompte[] = [];
  private droitsAReverifier: string[] | null = null;
  private messageFermeture: string | null = null;
  private deverrouillageDemande = false;
  private deconnexionTous = false;

  private readonly migres = new Set<string>();
  private readonly traites = new WeakMap<object, Promise<void>>();
  private reconnexionEnCours: Promise<void> | null = null;
  private sondeEnCours: Promise<void> | null = null;
  private derniereSondeMs = Number.NEGATIVE_INFINITY;
  private derniereActiviteSignaleeMs = Number.NEGATIVE_INFINITY;
  private derniereMarqueMs = Number.NEGATIVE_INFINITY;

  private derniereActiviteExterneMs = Number.NEGATIVE_INFINITY;

  private minuteurTick: ReturnType<typeof setInterval> | null = null;
  private minuteurReseau: ReturnType<typeof setInterval> | null = null;
  private desabonnerSynchronisation: (() => void) | null = null;
  private desabonnerCanal: (() => void) | null = null;
  private readonly ecouteursSortie = new Set<() => void>();

  private abonnes = new Set<() => void>();
  private versionCourante = 0;
  private cle = "";
  private cache: InstantaneSession;

  constructor(deps: DepsControleur) {
    this.deps = deps;
    this.parametres = deps.parametres ?? PARAMETRES_SESSION;
    this.stockage = deps.stockageTexte === undefined ? stockageNavigateur() : deps.stockageTexte;
    this.cache = this.construire(0);
    this.cle = this.cleDe(this.cache);
  }

  // ---- magasin externe -----------------------------------------------------------------------------

  readonly abonner = (rappel: () => void): (() => void) => {
    this.abonnes.add(rappel);
    return () => { this.abonnes.delete(rappel); };
  };

  readonly instantane = (): InstantaneSession => this.cache;

  private emettre(): void {
    const prochain = this.construire(this.versionCourante + 1);
    const cle = this.cleDe(prochain);
    if (cle === this.cle) return;
    this.cle = cle;
    this.versionCourante += 1;
    this.cache = prochain;
    for (const a of [...this.abonnes]) {
      try { a(); } catch { /* un abonne defaillant ne bloque pas les autres */ }
    }
  }

  private cleDe(i: InstantaneSession): string {
    const { version: _v, utilisateur, ...reste } = i;
    return JSON.stringify({ ...reste, utilisateur: utilisateur === null ? null : [utilisateur.id, utilisateur.role, utilisateur.nomComplet, utilisateur.modulesAutorises] });
  }

  private construire(version: number): InstantaneSession {
    const horsLigne = estHorsLigneEtat(this.etat);
    let ecran: EcranSession = "AUCUN";
    if (this.demarre && !this.versLogin) {
      if (this.choixEnAttente) ecran = "CHOIX_COMPTE";
      else if (this.etat === "HORS_LIGNE_VERROUILLE") ecran = "DEVERROUILLAGE";
      else if (this.etat === "EXPIRE") ecran = "SESSION_EXPIREE";
    }
    const pasAvant = this.contexte.pasAvantMs;
    const deverrouille = this.coffre?.estDeverrouille() === true && this.contexte.cleEnMemoire;
    return {
      version,
      demarre: this.demarre,
      etat: this.etat,
      utilisateur: this.utilisateur,
      compteId: this.compteId,
      nomCompte: this.nomCompte,
      coffrePresent: this.contexte.coffrePresent,
      deverrouille,
      horsLigne,
      ecran,
      candidats: this.candidats,
      attenteJusquaMs: pasAvant !== null && pasAvant > this.deps.maintenant() ? pasAvant : null,
      echecsPin: this.contexte.echecsPin,
      droitsAReverifier: this.droitsAReverifier,
      messageFermeture: this.messageFermeture,
      deverrouillageDemande: this.deverrouillageDemande,
      pinACreer: this.etat === "EN_LIGNE" && this.utilisateur !== null && !this.contexte.coffrePresent,
      autresComptes: resumeAutresComptes(),
      envoiJournalEnAttente: this.empreinte === null ? 0 : this.journal()?.nombre() ?? 0,
    };
  }

  // ---- noyau ----------------------------------------------------------------------------------------

  private journal() {
    return this.empreinte === null ? null : creerJournal({ empreinte: this.empreinte, stockage: this.stockage, maintenant: this.deps.maintenant });
  }

  /** Applique un evenement au noyau, execute les effets, remet les minuteurs en accord, notifie. */
  private appliquer(evenement: EvenementSansTemps, options: { ignorerJournal?: ReadonlySet<string> } = {}) {
    const avant = this.etat;
    const cleAvant = this.contexte.cleEnMemoire;
    const maintenantMs = this.deps.maintenant();
    const r = transition(this.etat, { ...evenement, maintenantMs } as EvenementSession, this.contexte, this.parametres);
    this.etat = r.etat;
    this.contexte = r.contexte;
    for (const effet of r.effets) this.executerEffet(effet, maintenantMs, options.ignorerJournal);
    // Invariant : le coffre n'est ouvert que si le noyau le dit. Le noyau seul decide du verrou.
    if (!this.contexte.cleEnMemoire && this.coffre?.estDeverrouille()) this.coffre.verrouiller();
    if (this.etat === "FERME" && avant !== "FERME" && !this.contexte.deconnexionEnAttente) this.finDeSession();
    // Une session expiree est une sortie : plus rien de ce compte ne doit rester dans le cache de requetes.
    if (this.etat === "EXPIRE" && avant !== "EXPIRE") this.signalerSortie();
    const horloge = evenement.type === "ACTIVITE" || evenement.type === "ACTIVITE_EXTERNE" || evenement.type === "TICK";
    if (!horloge) this.synchroniserIndice();
    this.reevaluerMinuteurs();
    // Une activite ou un tick par seconde ne change rien de visible, sauf un verrou : on evite de relire le stockage pour rien.
    if (!horloge || avant !== this.etat || cleAvant !== this.contexte.cleEnMemoire || r.effets.length > 0) this.emettre();
    return r;
  }

  private executerEffet(effet: EffetSession, maintenantMs: number, ignorer?: ReadonlySet<string>): void {
    switch (effet.type) {
      case "OUBLIER_DEK":
        this.coffre?.verrouiller();
        // Les apercus de photos (URL `blob:`) n'ont pas a survivre a la cle : voir urlsApercu.ts.
        revoquerToutesLesUrlsApercu();
        void this.noterHorloge(maintenantMs, true);
        break;
      case "JOURNALISER":
        if (ignorer?.has(effet.motif)) break;
        this.journal()?.ajouterMotif(effet.motif, maintenantMs);
        break;
      case "REJOUER_DECONNEXION":
        void this.rejouerDeconnexion();
        break;
    }
  }

  /** Persiste la marque haute d'horloge du coffre (detection d'un recul au prochain demarrage). Au plus une par minute, sauf demande. */
  private async noterHorloge(maintenantMs: number, forcer = false): Promise<void> {
    if (!this.coffre || !this.contexte.coffrePresent) return;
    if (!forcer && maintenantMs - this.derniereMarqueMs < 60_000) return;
    this.derniereMarqueMs = maintenantMs;
    try { await this.coffre.noterInstant(maintenantMs); } catch { /* information : sa perte ne ferme rien */ }
  }

  private synchroniserIndice(): void {
    if (this.compteId === null) return;
    if (this.contexte.deconnexionEnAttente) {
      noterCompteDansIndice(this.compteId, this.nomCompte ?? "", { deconnexionEnAttente: true, tous: this.deconnexionTous }, this.stockage);
    } else if (this.etat === "FERME" || this.etat === "DECONNECTE") {
      retirerCompteDeIndice(this.compteId, this.stockage);
    }
  }

  private finDeSession(): void {
    this.coffre?.verrouiller();
    fermerCompte();
    this.utilisateur = null;
    this.identiteServeur = null;
    this.deps.serveur.poserJeton(null);
    this.deps.marqueur.purger();
    this.signalerSortie();
  }

  // ---- sortie de session et onglets -----------------------------------------------------------------

  /**
   * S'abonne aux SORTIES de session (deconnexion, fermeture par le serveur, expiration, reinitialisation, effacement) et aux
   * changements de compte : c'est l'instant ou le cache de requetes doit etre vide. Sans cela, le compte B recevait les donnees
   * de A, et si sa requete echouait elles restaient affichees (constat de la relecture independante).
   */
  surSortieDeSession(rappel: () => void): () => void {
    this.ecouteursSortie.add(rappel);
    return () => { this.ecouteursSortie.delete(rappel); };
  }

  private signalerSortie(): void {
    for (const r of [...this.ecouteursSortie]) {
      try { r(); } catch { /* un abonne defaillant ne bloque pas les autres */ }
    }
  }

  private publier(type: TypeMessageCanal): void {
    if (this.empreinte !== null) this.deps.canal?.publier(type, this.empreinte);
  }

  /** Message d'un AUTRE onglet : si le compte est le notre (ou, pour un changement de compte, n'est PAS le notre), on ferme. */
  private surMessageCanal(m: MessageCanal): void {
    if (this.empreinte === null || this.compteId === null || this.etat === "DECONNECTE") return;
    if (m.type === "COMPTE_CHANGE") {
      if (m.empreinte === this.empreinte) return;
      this.fermerLocalement(MESSAGE_AUTRE_COMPTE, { coffreDetruit: false, marqueur: "GARDER", journaliser: true, garderDansIndice: true });
      return;
    }
    if (m.empreinte !== this.empreinte) return;
    switch (m.type) {
      case "SESSION_FERMEE":
        this.fermerLocalement(MESSAGE_SESSION_FERMEE_AILLEURS, { coffreDetruit: false, marqueur: "PURGER", journaliser: false, garderDansIndice: false });
        break;
      case "PIN_REINITIALISE":
        this.fermerLocalement(MESSAGE_PIN_REINITIALISE_AILLEURS, { coffreDetruit: true, marqueur: "GARDER", journaliser: false, garderDansIndice: false });
        break;
      case "EFFACEMENT_LOCAL":
        this.fermerLocalement(MESSAGE_EFFACEMENT_AILLEURS, { coffreDetruit: true, marqueur: "GARDER", journaliser: false, garderDansIndice: false });
        break;
    }
  }

  /**
   * Verrouille ET ferme le compte de cet onglet (cle oubliee, stockage du compte ferme, jeton retire, session locale FERME ou
   * DECONNECTE), avec un message pour l'ecran de connexion. N'efface rien : la file chiffree reste.
   *   - `coffreDetruit` : un autre onglet a detruit l'enveloppe (PIN reinitialise, effacement) : plus de coffre a ouvrir ;
   *   - `marqueur` : le cookie de rafraichissement est partage. Il reste valide (autre compte, PIN reinitialise) sauf si la
   *     session a ete fermee ailleurs : GARDER evite de casser la reprise de l'onglet qui l'utilise.
   */
  private fermerLocalement(
    message: string,
    options: { coffreDetruit: boolean; marqueur: "GARDER" | "PURGER"; journaliser: boolean; garderDansIndice: boolean },
  ): void {
    const compteId = this.compteId;
    if (compteId === null) return;
    this.coffre?.verrouiller();
    fermerCompte();
    this.messageFermeture = message;
    this.deps.serveur.poserJeton(null);
    this.droitsAReverifier = null;
    if (options.coffreDetruit) {
      this.coffre = this.nouveauCoffre(compteId);
      this.contexte = { ...this.contexte, coffrePresent: false };
    }
    this.appliquer({ type: "REFRAICHISSEMENT", issue: "REFUSE" }, options.journaliser ? {} : { ignorerJournal: new Set(["FERMETURE_SESSION"]) });
    this.finDeSession();
    if (options.marqueur === "GARDER") this.deps.marqueur.poser();
    if (options.garderDansIndice) noterCompteDansIndice(compteId, this.nomCompte ?? "", {}, this.stockage);
    this.emettre();
  }

  // ---- minuteurs ------------------------------------------------------------------------------------

  /** TICK seulement quand une cle est en memoire (rien a verrouiller sinon) ; nouvel essai de reseau seulement hors ligne. */
  private reevaluerMinuteurs(): void {
    const tick = this.actif && this.contexte.cleEnMemoire;
    if (tick && this.minuteurTick === null) {
      this.minuteurTick = setInterval(() => this.tick(), 1000);
    } else if (!tick && this.minuteurTick !== null) {
      clearInterval(this.minuteurTick);
      this.minuteurTick = null;
    }
    const periode = this.deps.retourReseauMs ?? 30_000;
    const reseau = this.actif && periode > 0 && (estHorsLigneEtat(this.etat) || this.etat === "EXPIRE");
    if (reseau && this.minuteurReseau === null) {
      this.minuteurReseau = setInterval(() => {
        if ((this.deps.enLigneNavigateur?.() ?? true) !== false) void this.reseauRevenu();
      }, periode);
    } else if (!reseau && this.minuteurReseau !== null) {
      clearInterval(this.minuteurReseau);
      this.minuteurReseau = null;
    }
  }

  activer(): void {
    this.actif = true;
    // Une seule inscription, meme si l'activation est repetee (StrictMode monte, demonte, remonte).
    this.desabonnerSynchronisation ??= surEtatSynchronisation((etat) => this.surArretSynchronisation(etat));
    if (this.desabonnerCanal === null && this.deps.canal) this.desabonnerCanal = this.deps.canal.ecouter((m) => this.surMessageCanal(m));
    this.reevaluerMinuteurs();
  }

  desactiver(): void {
    this.actif = false;
    this.desabonnerSynchronisation?.();
    this.desabonnerSynchronisation = null;
    this.desabonnerCanal?.();
    this.desabonnerCanal = null;
    this.reevaluerMinuteurs();
  }

  /**
   * La synchronisation vient de s'ARRETER (appareil retire, compte inactif : `etatSynchronisation`). Le journal local en garde
   * une trace, deposee a la reconnexion avec les autres evenements de la session.
   *
   * CHOIX DE NOM, A CONNAITRE. La liste du serveur est fermee (`backend/src/modules/auth/evenements-locaux.ts`) et ne connait
   * aucun evenement « synchronisation arretee ». Le plus proche est SESSION_LOCALE_FERMEE, qui regroupe deja FERMETURE_SESSION,
   * DECONNEXION_HORS_LIGNE et DROITS_MODIFIES : le serveur refuse l'appareil ou le compte, l'application ne peut plus rien lui
   * envoyer. Ce n'est PAS une fermeture du coffre (rien ici n'oublie la cle ni ne ferme le compte local) : l'evenement ne dit pas
   * laquelle des deux causes, ni qu'il s'agit d'un arret de synchronisation. Un evenement dedie demanderait une valeur de plus dans
   * la liste du serveur (decision a prendre).
   *
   * Un seul evenement par PASSAGE a l'arret (l'etat n'emet que sur un changement) ; la levee de l'arret n'en journalise aucun. Il
   * n'y a pas de regroupement en `occurrences` : plusieurs arrets successifs (rechargements de la page) donnent plusieurs lignes,
   * bornees par le plafond du journal.
   */
  private surArretSynchronisation(etat: EtatSynchronisation): void {
    if (etat.message === null) return;
    this.journal()?.ajouter("SESSION_LOCALE_FERMEE", this.deps.maintenant());
    this.emettre();
  }

  // ---- evenements d'interface -----------------------------------------------------------------------

  tick(): void { this.appliquer({ type: "TICK" }); void this.noterHorloge(this.deps.maintenant()); }

  /** Interaction REELLE de l'agent (pointeur, clavier, tactile, defilement) : au plus une par seconde. */
  signalerActivite(): void {
    const t = this.deps.maintenant();
    if (t - this.derniereActiviteSignaleeMs < 1000) return;
    this.derniereActiviteSignaleeMs = t;
    this.appliquer({ type: "ACTIVITE" });
  }

  /**
   * Activite qui n'est PAS une interaction (point GNSS du releve, pont `activiteExterne.ts`) : au plus une par seconde. Differe le
   * verrou d'inactivite, dans la limite du plafond du noyau, et jamais celui d'arriere-plan.
   */
  signalerActiviteExterne(): void {
    const t = this.deps.maintenant();
    if (t - this.derniereActiviteExterneMs < 1000) return;
    this.derniereActiviteExterneMs = t;
    this.appliquer({ type: "ACTIVITE_EXTERNE" });
  }

  signalerArrierePlan(): void { this.appliquer({ type: "ARRIERE_PLAN" }); }
  signalerPremierPlan(): void { this.appliquer({ type: "PREMIER_PLAN" }); }

  verrouiller(): void { this.appliquer({ type: "VERROU_MANUEL" }); }

  // ---- reseau ---------------------------------------------------------------------------------------

  /**
   * `EVENEMENT` : le navigateur annonce `offline` (cru). `REQUETE` : une requete a echoue sans reponse (pas cru : sonde reelle).
   */
  reseauPerdu(source: "EVENEMENT" | "REQUETE"): Promise<void> {
    if (this.etat !== "EN_LIGNE" || !this.contexte.coffrePresent) return Promise.resolve();
    if (source === "EVENEMENT") return this.traiter({ etat: "RESEAU_COUPE" });
    const maintenant = this.deps.maintenant();
    if (this.sondeEnCours !== null || maintenant - this.derniereSondeMs < (this.deps.sondeMinMs ?? 10_000)) return this.sondeEnCours ?? Promise.resolve();
    this.derniereSondeMs = maintenant;
    this.sondeEnCours = (async () => {
      const issue = await this.deps.serveur.sonder();
      await this.traiter(issue);
    })().catch(() => undefined).finally(() => { this.sondeEnCours = null; });
    return this.sondeEnCours;
  }

  /** Le reseau est (peut-etre) revenu : sonde reelle, puis rapprochement des droits et envoi du journal. */
  reseauRevenu(): Promise<void> {
    if (this.reconnexionEnCours !== null) return this.reconnexionEnCours;
    if (this.etat === "EN_LIGNE") {
      void this.envoyerJournal();
      return Promise.resolve();
    }
    if (!estHorsLigneEtat(this.etat) && this.etat !== "EXPIRE") return Promise.resolve();
    this.reconnexionEnCours = (async () => {
      const issue = await this.deps.serveur.sonder();
      await this.traiter(issue);
    })().catch(() => undefined).finally(() => { this.reconnexionEnCours = null; });
    return this.reconnexionEnCours;
  }

  /** Issue d'un rafraichissement (ecouteur de api.ts, demarrage, sonde). Un meme objet n'est traite qu'une fois. */
  surRafraichissement(issue: ResultatRafraichissement): Promise<void> { return this.traiter(issue); }

  private traiter(issue: ResultatRafraichissement): Promise<void> {
    const deja = this.traites.get(issue);
    if (deja) return deja;
    const p = this.traiterIssue(issue).catch(() => undefined);
    this.traites.set(issue, p);
    return p;
  }

  private async traiterIssue(issue: ResultatRafraichissement): Promise<void> {
    // Rien a faire tant qu'aucun compte n'est connu de l'hote (page de connexion, demarrage en cours).
    if (this.compteId === null) return;
    const kernel: EtatRafraichissement = issue.etat;
    const avant = this.etat;
    if (kernel === "OK") {
      // Une session fermee ne se rouvre pas sur un rafraichissement tardif (seule la deconnexion en attente a besoin de cette issue).
      if (avant === "DECONNECTE" || (avant === "FERME" && !this.contexte.deconnexionEnAttente)) return;
      if (this.contexte.deconnexionEnAttente) {
        this.appliquer({ type: "REFRAICHISSEMENT", issue: "OK" }); // deconnexion en attente rejouee : la session ne se rouvre pas
        return;
      }
      // Le cookie de rafraichissement est PARTAGE entre les onglets : un « OK » dit seulement qu'un cookie est valide, pas que c'est
      // celui de CE compte. L'identite est donc relue AVANT toute prolongation, tout envoi du journal et tout renouvellement : si
      // elle differe, cet onglet ferme sa session locale (la file reste), il ne la prolonge pas et n'envoie rien sous l'autre compte.
      const compteAttendu = this.compteId;
      const identite = await this.lireIdentiteDuCookie(avant);
      if (identite === null) return; // refus, reseau ou serveur indisponible : deja traite (ou ignore en ligne)
      if (this.compteId !== compteAttendu || this.etat === "DECONNECTE" || this.etat === "FERME") return;
      if (identite.id !== compteAttendu) {
        this.fermerLocalement(MESSAGE_AUTRE_COMPTE, { coffreDetruit: false, marqueur: "GARDER", journaliser: true, garderDansIndice: true });
        return;
      }
      this.appliquer({ type: "REFRAICHISSEMENT", issue: "OK" });
      if (this.etat !== "EN_LIGNE") return; // deconnexion en attente posee pendant la verification
      // Un rafraichissement reussi prouve que le cookie de session est valide : le marqueur qui autorise une reprise (donc une
      // ouverture hors ligne) est renouvele avec lui. Sans cela il expirait 7 jours apres la connexion, meme session active.
      this.deps.marqueur.poser();
      if (avant === "EN_LIGNE") {
        if (this.coffre?.estDeverrouille()) await this.prolongerSiDroitsInchanges();
        void this.envoyerJournal();
        return;
      }
      await this.finaliserAccueil(identite);
      return;
    }
    if (kernel === "REFUSE") {
      this.droitsAReverifier = null;
      this.messageFermeture = MESSAGE_REFUS_SERVEUR;
      this.memoriserMessage(MESSAGE_REFUS_SERVEUR);
      this.deps.serveur.poserJeton(null);
      this.deps.marqueur.purger();
      this.appliquer({ type: "REFRAICHISSEMENT", issue: "REFUSE" });
      this.finDeSession();
      this.emettre();
      return;
    }
    this.appliquer({ type: "REFRAICHISSEMENT", issue: kernel });
    if (estHorsLigneEtat(this.etat) && this.droitsAReverifier !== null) this.appliquer({ type: "COFFRE_EXPIRE" });
  }

  /**
   * Relit l'identite portee par le cookie de session (`GET /auth/me`). Rend `null` si elle n'a pas pu etre lue : un refus 401/403
   * ferme la session, un reseau coupe ou un serveur indisponible est traite comme tel quand on etait hors ligne ; en ligne, on
   * ne conclut rien (la session n'est ni prolongee ni fermee, le prochain rafraichissement recommencera).
   */
  private async lireIdentiteDuCookie(avant: EtatSession): Promise<UtilisateurServeur | null> {
    try {
      return await this.deps.serveur.moi();
    } catch (e) {
      const statut = (e as { response?: { status?: number } } | null)?.response?.status;
      if (statut === 401 || statut === 403) await this.traiter({ etat: "REFUSE", statut });
      else if (avant !== "EN_LIGNE") await this.traiter(statut === undefined ? { etat: "RESEAU_COUPE" } : { etat: "INDISPONIBLE", statut });
      return null;
    }
  }

  // ---- demarrage ------------------------------------------------------------------------------------

  /** Demarrage a froid. Idempotent (StrictMode monte deux fois). */
  demarrer(): Promise<void> {
    // Un demarrage qui echoue (stockage ou WebCrypto indisponibles) ne doit pas laisser l'application sur « Chargement » :
    // elle se montre, sans session locale, comme avant l'existence du mode hors ligne.
    this.demarrage ??= this.demarrerInterne().catch(() => undefined).finally(() => { this.demarre = true; this.reevaluerMinuteurs(); this.emettre(); });
    return this.demarrage;
  }

  private async demarrerInterne(): Promise<void> {
    this.lireMessageMemorise();
    if (!this.deps.marqueur.present()) return;
    const issue = await this.deps.serveur.rafraichirAuDemarrage();
    this.traites.set(issue, Promise.resolve());
    if (issue.etat === "OK") {
      let u: UtilisateurServeur;
      try {
        u = await this.deps.serveur.moi();
      } catch (e) {
        const statut = (e as { response?: { status?: number } } | null)?.response?.status;
        if (statut === 401 || statut === 403) await this.demarrerSansServeur({ etat: "REFUSE", statut });
        else await this.demarrerSansServeur(statut === undefined ? { etat: "RESEAU_COUPE" } : { etat: "INDISPONIBLE", statut });
        return;
      }
      await this.accueillir(u, "RAFRAICHISSEMENT");
      return;
    }
    await this.demarrerSansServeur(issue);
  }

  /** Demarrage sans reponse favorable du serveur : coffre local, ou fermeture (refus). */
  private async demarrerSansServeur(issue: ResultatRafraichissement): Promise<void> {
    let coffres: string[] = [];
    try { coffres = await listerComptesAvecCoffre(this.deps.stockageCoffre); } catch { coffres = []; }
    const indice = lireIndice(this.stockage);
    const noms = indice.comptes;
    const indiques = Object.keys(noms);

    if (issue.etat === "REFUSE") {
      this.deps.marqueur.purger();
      this.deps.serveur.poserJeton(null);
      this.messageFermeture = MESSAGE_REFUS_SERVEUR;
      this.memoriserMessage(MESSAGE_REFUS_SERVEUR);
      const cible = indice.dernier !== null && coffres.includes(indice.dernier) ? indice.dernier : null;
      if (cible !== null) {
        await this.selectionnerCompte(cible);
        this.droitsAReverifier = null;
        this.appliquer({ type: "REFRAICHISSEMENT", issue: "REFUSE" });
        this.finDeSession();
        retirerCompteDeIndice(cible, this.stockage);
        this.emettre();
      }
      return;
    }

    const connus = coffres.filter((id) => indiques.length === 0 || id in noms);
    this.candidats = connus.map((id) => ({ compteId: id, nom: noms[id]?.nom ?? null }));
    if (connus.length === 0) { this.candidats = []; return; }
    this.issueHorsLigne = issue;
    const choisi = connus.length === 1 ? connus[0] : indice.dernier !== null && connus.includes(indice.dernier) ? indice.dernier : null;
    if (choisi === null) { this.choixEnAttente = true; return; }
    await this.selectionnerCompte(choisi);
    this.appliquerIssueHorsLigne();
  }

  private appliquerIssueHorsLigne(): void {
    const issue = this.issueHorsLigne;
    if (issue === null || issue.etat === "OK" || issue.etat === "REFUSE") return;
    this.appliquer({ type: "REFRAICHISSEMENT", issue: issue.etat });
    if (estHorsLigneEtat(this.etat) && this.droitsAReverifier !== null) this.appliquer({ type: "COFFRE_EXPIRE" });
  }

  /** Hors ligne : l'agent designe le compte a ouvrir (plusieurs coffres, ou autre compte que le dernier). */
  async choisirCompte(compteId: string): Promise<void> {
    if (!this.candidats.some((c) => c.compteId === compteId) || this.issueHorsLigne === null) return;
    this.choixEnAttente = false;
    this.utilisateur = null;
    await this.selectionnerCompte(compteId);
    this.appliquerIssueHorsLigne();
    this.emettre();
  }

  /** L'agent renonce au mode hors ligne : ecran de connexion. */
  allerALaConnexion(): void {
    this.versLogin = true;
    this.emettre();
  }

  /** Revient a l'ecran de deverrouillage apres `allerALaConnexion` (le reseau n'est pas revenu). */
  retourAuDeverrouillage(): void {
    this.versLogin = false;
    this.emettre();
  }

  /**
   * Prend le compte `compteId` pour le noyau : coffre (verrouille), empreinte, contexte lu dans l'enveloppe. Un autre compte
   * deja pris est verrouille et ferme AVANT (le second agent ne voit rien du premier).
   */
  private async selectionnerCompte(compteId: string): Promise<void> {
    if (this.compteId === compteId && this.coffre !== null) return;
    this.coffre?.verrouiller();
    fermerCompte();
    this.utilisateur = null;
    this.identiteServeur = null;
    this.droitsAReverifier = null;
    // Changement de compte : rien du compte precedent ne doit rester dans le cache de requetes du suivant.
    this.signalerSortie();
    this.compteId = compteId;
    this.coffre = this.nouveauCoffre(compteId);
    this.empreinte = await empreinteCompte(compteId, this.deps.sha256);
    const meta = await this.coffre.lireMeta();
    const indice = lireIndice(this.stockage);
    const entree = indice.comptes[compteId];
    this.nomCompte = entree?.nom ?? null;
    this.deconnexionTous = entree?.tous === true;
    this.etat = "DECONNECTE";
    this.contexte = contexteInitial({
      coffrePresent: meta.existe,
      dernierInstantMs: meta.dernierInstantMs,
      echecsPin: meta.echecs,
      pasAvantMs: meta.pasAvantMs,
      deconnexionEnAttente: entree?.deconnexionEnAttente === true,
    });
    this.droitsAReverifier = this.lireDrapeauDroits();
    this.reouvrirCompte();
    this.reevaluerMinuteurs();
    this.emettre();
    // Les autres onglets d'un AUTRE compte ferment leur session : le cookie de rafraichissement est partage, et la file de
    // l'ancien compte n'est plus a eux de manipuler sous celui-ci.
    this.publier("COMPTE_CHANGE");
  }

  private nouveauCoffre(compteId: string): CoffreSession {
    return ouvrirCoffre({
      stockage: this.deps.stockageCoffre, compteId, appareilId: this.deps.idAppareilLocal(),
      parametres: this.parametres, ...this.deps.optionsCoffre,
    });
  }

  /**
   * Ouvre (ou rouvre, sans cout) le compte du stockage local sur le coffre courant, verrouille ou non. Sans coffre, rien
   * a ouvrir : le stockage repond alors AUCUN_COMPTE, qui dit vrai (la creation du PIN ouvrira le compte).
   */
  private reouvrirCompte(): void {
    if (this.compteId === null || this.empreinte === null || this.coffre === null || !this.contexte.coffrePresent) return;
    try { ouvrirCompte({ compteId: this.compteId, empreinte: this.empreinte, chiffreur: this.coffre }); } catch { /* chiffreur d'un autre compte : impossible ici */ }
  }

  // ---- connexion en ligne ---------------------------------------------------------------------------

  async connecter(email: string, motDePasse: string): Promise<{ requires2FA: true; challengeToken: string } | void> {
    const r = await this.deps.serveur.connexion(email, motDePasse);
    if ("requires2FA" in r) return r;
    await this.apresConnexion(r);
  }

  async verifierDeuxFacteurs(challengeToken: string, code: string): Promise<void> {
    await this.apresConnexion(await this.deps.serveur.verifierDeuxFacteurs(challengeToken, code));
  }

  private async apresConnexion(r: { accessToken: string; user: UtilisateurServeur }): Promise<void> {
    this.deps.serveur.poserJeton(r.accessToken);
    this.deps.marqueur.poser();
    let u = r.user;
    try { u = await this.deps.serveur.moi(); } catch { /* perimetre inconnu : la comparaison l'ignorera */ }
    this.versLogin = false;
    await this.accueillir(u, "CONNEXION");
  }

  /** Une session reseau valide existe pour `u` : le noyau passe EN_LIGNE, le compte du stockage s'ouvre. */
  private async accueillir(u: UtilisateurServeur, evenement: "CONNEXION" | "RAFRAICHISSEMENT"): Promise<void> {
    if (this.compteId !== u.id || this.coffre === null) {
      try {
        await this.selectionnerCompte(u.id);
      } catch {
        // WebCrypto ou IndexedDB indisponibles (page non securisee, navigateur ancien) : la connexion reste possible, sans
        // session locale. Le PIN ne pourra pas etre cree (message dedie) ; tout le reste de l'application fonctionne.
        this.coffre = null;
        this.empreinte = null;
        this.compteId = u.id;
        this.etat = "DECONNECTE";
        this.contexte = contexteInitial();
      }
    }
    this.messageFermeture = null;
    this.choixEnAttente = false;
    this.candidats = [];
    this.appliquer(evenement === "CONNEXION" ? { type: "CONNEXION_REUSSIE" } : { type: "REFRAICHISSEMENT", issue: "OK" });
    if (this.etat !== "EN_LIGNE") { this.emettre(); return; } // deconnexion en attente rejouee
    await this.finaliserAccueil(u);
  }

  private async finaliserAccueil(u: UtilisateurServeur): Promise<void> {
    const { identite, regionsConnues } = identiteDe(u);
    this.deps.marqueur.poser(); // session reseau valide (connexion ou reprise) : voir traiterIssue
    this.utilisateur = u;
    this.identiteServeur = identite;
    this.regionsConnues = regionsConnues;
    this.nomCompte = u.nomComplet ?? this.nomCompte;
    noterCompteDansIndice(u.id, this.nomCompte ?? "", {}, this.stockage);
    this.reouvrirCompte();
    this.emettre();
    if (this.coffre?.estDeverrouille()) await this.rapprocherDroits();
    void this.envoyerJournal();
  }

  /** Coffre ouvert, session en ligne : droits inchanges -> validite repoussee ; droits changes -> session locale invalidee. */
  private async rapprocherDroits(): Promise<void> {
    const coffre = this.coffre;
    const identite = this.identiteServeur;
    const profil = coffre?.profilCourant() ?? null;
    if (!coffre || !identite || !profil || this.etat !== "EN_LIGNE") return;
    const serveur = this.regionsConnues ? identite : { ...identite, regions: [...profil.regions] };
    const diff = differencesDeDroits(profil, serveur);
    if (diff.length === 0) { await this.prolongerSiDroitsInchanges(); return; }
    this.invaliderPourDroits(diff);
  }

  private async prolongerSiDroitsInchanges(): Promise<void> {
    const coffre = this.coffre;
    const profil = coffre?.profilCourant() ?? null;
    if (!coffre || !profil || !this.identiteServeur || this.etat !== "EN_LIGNE") return;
    const serveur = this.regionsConnues ? this.identiteServeur : { ...this.identiteServeur, regions: [...profil.regions] };
    if (differencesDeDroits(profil, serveur).length > 0) { this.invaliderPourDroits(differencesDeDroits(profil, serveur)); return; }
    const r = await coffre.prolonger({ maintenantMs: this.deps.maintenant(), identite: serveur });
    if (r.ok) this.appliquer({ type: "PROFIL_REVALIDE" });
  }

  private invaliderPourDroits(diff: string[]): void {
    this.appliquer({ type: "DROITS_MODIFIES" });
    this.appliquer({ type: "VERROU_MANUEL" });
    this.coffre?.verrouiller();
    this.droitsAReverifier = diff;
    this.ecrireDrapeauDroits(diff);
    this.emettre();
  }

  // ---- PIN et coffre --------------------------------------------------------------------------------

  /** Creation du coffre apres une connexion en ligne. */
  async creerPin(pin: string): Promise<ResultatAction> {
    if (this.etat !== "EN_LIGNE" || this.utilisateur === null || this.identiteServeur === null || this.compteId === null) {
      return echec("INDISPONIBLE", "Connectez-vous d'abord : le code se crée juste après une connexion en ligne.");
    }
    if (this.empreinte === null) return echec("WEBCRYPTO_INDISPONIBLE", messageErreur("WEBCRYPTO_INDISPONIBLE"));
    const a = analyserPin(pin);
    if (!a.acceptable) return echec(a.motif === "TROP_COURT" || a.motif === "TROP_LONG" || a.motif === "VIDE" ? "PIN_INVALIDE" : "PIN_TRIVIAL", a.message);
    try {
      const coffre = await creerCoffre({
        stockage: this.deps.stockageCoffre, compteId: this.compteId, appareilId: this.deps.idAppareilLocal(), pin,
        profil: this.identiteServeur, maintenantMs: this.deps.maintenant(), parametres: this.parametres, ...this.deps.optionsCoffre,
      });
      this.coffre = coffre;
    } catch (e) {
      const code = e instanceof ErreurCoffre ? e.code : "INDISPONIBLE";
      if (code === "COFFRE_EXISTANT") {
        // Un coffre existe deja (autre onglet) : le noyau doit le savoir pour demander le PIN existant.
        this.contexte = { ...this.contexte, coffrePresent: true };
        this.emettre();
      }
      return echec(code, messageErreur(code));
    }
    this.appliquer({ type: "COFFRE_CREE" });
    this.reouvrirCompte();
    await this.apresOuverture();
    return { ok: true };
  }

  /** Deverrouille la session locale avec le PIN (ou la renouvelle, si l'expiration ou un changement de droits l'exige et qu'on est en ligne). */
  async deverrouiller(pin: string): Promise<ResultatAction> {
    const coffre = this.coffre;
    if (!coffre || !this.contexte.coffrePresent) return echec("COFFRE_ABSENT", messageErreur("COFFRE_ABSENT"));
    if (this.etat === "EXPIRE") return echec("EXPIRE", messageErreur("EXPIRE"));
    const maintenant = this.deps.maintenant();
    const t = tentativePinPossible(this.contexte, maintenant);
    if (!t.possible) return echec("DELAI_EN_COURS", "Trop d'essais. Patientez avant de réessayer.", t.resteMs);

    const enLigne = this.etat === "EN_LIGNE" && this.identiteServeur !== null;
    let revalide = false;
    let r: ResultatDeverrouillage;
    if (enLigne && this.droitsAReverifier !== null) {
      r = await coffre.revalider({ pin, identite: this.identiteServeur as IdentiteProfil, maintenantMs: maintenant });
      revalide = true;
    } else {
      r = await coffre.deverrouiller(pin, maintenant);
      if (!r.ok && r.erreur === "EXPIRE" && enLigne) {
        r = await coffre.revalider({ pin, identite: this.identiteServeur as IdentiteProfil, maintenantMs: this.deps.maintenant() });
        revalide = true;
      }
    }

    if (r.ok) {
      // Ouverture hors ligne : l'utilisateur est reconstruit du profil du coffre. En ligne, il vient du serveur.
      // ORDRE ESSENTIEL (defaut E2E-5) : l'utilisateur est pose AVANT `appliquer`. `appliquer` EMET un instantane (etat
      // HORS_LIGNE_OUVERT, ecran AUCUN) ; l'emission suivante n'a lieu qu'apres `await migrer()` (IndexedDB). Entre les deux,
      // React rend l'instantane courant : avec un utilisateur encore nul, ProtectedRoute y lisait « non connecte » et
      // redirigeait vers /login, alors que l'agent venait de donner le bon code. Les tests qui rendaient la migration
      // instantanee ne voyaient jamais cet instantane transitoire.
      const utilisateurAvant = this.utilisateur;
      if (utilisateurAvant === null) this.utilisateur = utilisateurDepuisProfil(r.profil);
      this.appliquer({ type: "DEVERROUILLAGE_REUSSI", valideLeMs: r.profil.valideLe, expireLeMs: r.profil.expireLe });
      if (!this.contexte.cleEnMemoire) {
        // Le noyau a refuse l'ouverture (validite depassee entre-temps, ou etat qui n'en permet pas) : la cle est reoubliee,
        // et l'identite reconstruite est retiree (rien n'est ouvert).
        this.utilisateur = utilisateurAvant;
        const etatApres = this.etat as EtatSession; // relu apres `appliquer` : le compilateur croit encore l'etat d'avant
        const code = etatApres === "EXPIRE" ? "EXPIRE" : "INDISPONIBLE";
        this.emettre();
        return echec(code, messageErreur(code));
      }
      this.reouvrirCompte();
      if (revalide) {
        this.droitsAReverifier = null;
        this.effacerDrapeauDroits();
        this.appliquer({ type: "PROFIL_REVALIDE" });
      } else if (this.etat === "EN_LIGNE") {
        await this.rapprocherDroits();
      }
      this.deverrouillageDemande = false;
      await this.apresOuverture();
      return { ok: true };
    }

    switch (r.erreur) {
      case "PIN_INCORRECT": {
        const meta = await coffre.lireMeta();
        this.appliquer({ type: "ECHEC_PIN", echecsPersistes: meta.echecs });
        const reste = this.contexte.pasAvantMs !== null ? Math.max(0, this.contexte.pasAvantMs - this.deps.maintenant()) : undefined;
        return echec("PIN_INCORRECT", messageErreur("PIN_INCORRECT"), reste && reste > 0 ? reste : undefined);
      }
      case "EXPIRE":
        this.appliquer({ type: "COFFRE_EXPIRE" });
        return echec("EXPIRE", messageErreur("EXPIRE"));
      case "DELAI_EN_COURS": {
        // Le delai a ete pose par un autre onglet : on l'adopte, sans compter d'echec de plus.
        const reste = "reessayerDansMs" in r ? r.reessayerDansMs ?? 0 : 0;
        this.contexte = { ...this.contexte, pasAvantMs: this.deps.maintenant() + reste };
        this.emettre();
        return echec("DELAI_EN_COURS", "Trop d'essais. Patientez avant de réessayer.", reste);
      }
      case "COFFRE_ABSENT":
        this.contexte = { ...this.contexte, coffrePresent: false };
        this.emettre();
        return echec("COFFRE_ABSENT", messageErreur("COFFRE_ABSENT"));
      default:
        return echec(r.erreur, messageErreur(r.erreur));
    }
  }

  /** Migration de l'heritage, relevement de la file, nouvel essai d'envoi : a la premiere ouverture du compte puis a chaque ouverture. */
  private async apresOuverture(): Promise<void> {
    if (this.compteId !== null && !this.migres.has(this.compteId) && this.deps.migrer) {
      this.migres.add(this.compteId);
      try { await this.deps.migrer(); } catch { this.migres.delete(this.compteId); /* rejouee a la prochaine ouverture */ }
    }
    this.deps.apresDeverrouillage?.();
    this.emettre();
  }

  async changerPin(ancien: string, nouveau: string): Promise<ResultatAction> {
    const coffre = this.coffre;
    if (!coffre || !this.contexte.coffrePresent) return echec("COFFRE_ABSENT", messageErreur("COFFRE_ABSENT"));
    const a = analyserPin(nouveau);
    if (!a.acceptable) return echec(a.motif === "TROP_COURT" || a.motif === "TROP_LONG" || a.motif === "VIDE" ? "PIN_INVALIDE" : "PIN_TRIVIAL", a.message);
    const t = tentativePinPossible(this.contexte, this.deps.maintenant());
    if (!t.possible) return echec("DELAI_EN_COURS", "Trop d'essais. Patientez avant de réessayer.", t.resteMs);
    const r = await coffre.changerPin(ancien, nouveau, this.deps.maintenant());
    if (r.ok) return { ok: true };
    if (r.erreur === "PIN_INCORRECT") {
      const meta = await coffre.lireMeta();
      this.appliquer({ type: "ECHEC_PIN", echecsPersistes: meta.echecs });
      return echec("PIN_INCORRECT", "L'ancien code est incorrect.");
    }
    if (r.erreur === "DELAI_EN_COURS") return echec("DELAI_EN_COURS", "Trop d'essais. Patientez avant de réessayer.", "reessayerDansMs" in r ? r.reessayerDansMs : undefined);
    return echec(r.erreur, messageErreur(r.erreur));
  }

  // ---- PIN oublie, effacement ---------------------------------------------------------------------

  /** Ce que la file contient, pour avertir AVANT une reinitialisation, un effacement ou une deconnexion. */
  decompte(): Promise<ComptesFile> { return this.deps.decompteFile(); }

  /** Decision de la politique sur le decompte courant : `refusee` = il reste des saisies qui seraient perdues. */
  async apercuPerte(): Promise<DecisionSuppression> {
    return decisionSuppressionLocale(await this.deps.decompteFile());
  }

  /**
   * PIN oublie : detruit l'enveloppe du coffre (les saisies chiffrees deviennent illisibles) ET les bases locales du compte
   * (qui ne serviraient plus a rien et bloqueraient pour toujours tout effacement), puis ferme le compte. A confirmer en
   * deux temps par l'appelant, avec le decompte de ce qui sera perdu. Journalise PIN_REINITIALISE.
   */
  async reinitialiserPin(): Promise<ResultatAction> {
    const coffre = this.coffre;
    const emp = this.empreinte;
    if (!coffre || emp === null || this.compteId === null) return echec("COFFRE_ABSENT", messageErreur("COFFRE_ABSENT"));
    fermerCompte();
    try {
      await coffre.reinitialiser();
      await supprimerStockageDuCompte(emp, { stockage: this.stockage });
    } catch {
      this.reouvrirCompte();
      return echec("INDISPONIBLE", "La réinitialisation n'a pas pu aller au bout : fermez les autres onglets de l'application et réessayez.");
    }
    this.coffre = this.nouveauCoffre(this.compteId);
    this.droitsAReverifier = null;
    this.effacerDrapeauDroits();
    this.appliquer({ type: "REINITIALISATION_PIN" });
    // Hors ligne il ne reste rien a ouvrir : l'indice est retire par synchroniserIndice (etat DECONNECTE), et l'agent n'est plus
    // « connecte » (sans cela `utilisateur` restait agent-A alors que l'etat etait DECONNECTE).
    this.apresDestructionLocale();
    this.publier("PIN_REINITIALISE");
    this.emettre();
    return { ok: true };
  }

  /** Effacement volontaire des donnees locales du compte courant. Refuse (retour type) tant que la file n'est pas vide. */
  async effacerDonneesLocales(): Promise<ResultatEffacement> {
    const executer = this.deps.effacer ?? effacerDonneesLocales;
    const r = await executer({
      decompte: this.deps.decompteFile, stockage: this.stockage, stockageIndice: this.stockage, stockageJournal: this.stockage,
      maintenant: this.deps.maintenant,
    });
    if (!r.ok) {
      this.reouvrirCompte();
      return r;
    }
    if (this.compteId !== null) this.coffre = this.nouveauCoffre(this.compteId);
    this.droitsAReverifier = null;
    this.effacerDrapeauDroits();
    // L'effacement a deja journalise EFFACEMENT_LOCAL (le journal survit) : le noyau ne le journalise pas une seconde fois.
    this.appliquer({ type: "EFFACEMENT_LOCAL" }, { ignorerJournal: new Set(["EFFACEMENT_LOCAL"]) });
    this.apresDestructionLocale();
    this.publier("EFFACEMENT_LOCAL");
    this.emettre();
    return r;
  }

  /**
   * Apres une reinitialisation du PIN ou un effacement local : le cache de requetes est vide, et si le noyau est retombe a
   * DECONNECTE (hors ligne), l'utilisateur affiche est annule (il n'y a plus de session ni de coffre a ouvrir).
   */
  private apresDestructionLocale(): void {
    this.signalerSortie();
    if (this.etat === "DECONNECTE") {
      this.utilisateur = null;
      this.identiteServeur = null;
    }
  }

  // ---- deconnexion ---------------------------------------------------------------------------------

  /**
   * Ferme la session. N'efface RIEN. En ligne : le serveur revoque le cookie. Hors ligne (le serveur n'a pas repondu) :
   * verrou local immediat et drapeau « deconnexion en attente », rejoue au retour du reseau.
   */
  async deconnecter(options: { tous?: boolean } = {}): Promise<DecisionDeconnexion> {
    let comptes: ComptesFile | undefined;
    try { comptes = await this.deps.decompteFile(); } catch { comptes = undefined; }
    const joint = await this.deps.serveur.deconnexion(options.tous === true);
    this.deconnexionTous = options.tous === true;
    const decision = decisionDeconnexion(comptes === undefined ? { serveurJoint: joint } : { serveurJoint: joint, comptesFile: comptes });
    if (this.compteId === null) {
      // Aucun compte connu de l'hote : seul le jeton et le marqueur sont a retirer.
      this.deps.serveur.poserJeton(null);
      if (joint) this.deps.marqueur.purger();
      this.utilisateur = null;
      this.signalerSortie();
      this.emettre();
      return decision;
    }
    this.appliquer({ type: "DECONNEXION_DEMANDEE", serveurJoint: joint });
    if (joint) {
      this.droitsAReverifier = null;
      this.finDeSession();
      this.emettre();
    } else {
      // Verrou local : la session reseau n'est plus utilisee, les pages restent cachees derriere l'ecran de PIN.
      this.deps.serveur.poserJeton(null);
      if (!this.contexte.coffrePresent) this.finDeSessionSansServeur();
      // L'agent a demande a sortir : meme hors ligne, son cache de requetes ne doit pas servir au suivant.
      this.signalerSortie();
      this.emettre();
    }
    this.publier("SESSION_FERMEE");
    return decision;
  }

  /** Sans coffre et sans reseau : plus rien a deverrouiller, la deconnexion reste a rejouer (marqueur conserve). */
  private finDeSessionSansServeur(): void {
    fermerCompte();
    this.utilisateur = null;
    this.identiteServeur = null;
  }

  private async rejouerDeconnexion(): Promise<void> {
    const joint = await this.deps.serveur.deconnexion(this.deconnexionTous);
    if (!joint) return; // reessaye au prochain retour du reseau
    this.appliquer({ type: "DECONNEXION_REJOUEE" });
    this.finDeSession();
    retirerCompteDeIndice(this.compteId ?? "", this.stockage);
    this.emettre();
  }

  // ---- journal -------------------------------------------------------------------------------------

  /** Depose les evenements locaux en attente (lots bornes). Ne leve jamais. */
  async envoyerJournal(): Promise<void> {
    if (this.empreinte === null || this.etat !== "EN_LIGNE") return;
    try {
      await envoyerJournal(
        { empreinte: this.empreinte, stockage: this.stockage, maintenant: this.deps.maintenant },
        (corps) => this.deps.serveur.envoyerEvenements(corps),
        { appareilId: this.deps.serveur.appareilServeurId() },
      );
    } catch { /* jamais bloquant */ }
    this.emettre();
  }

  // ---- ecran a la demande ---------------------------------------------------------------------------

  demanderDeverrouillage(): void { this.deverrouillageDemande = true; this.emettre(); }
  annulerDeverrouillage(): void { this.deverrouillageDemande = false; this.emettre(); }

  // ---- drapeaux et message persistes ----------------------------------------------------------------

  private cleDrapeau(): string | null {
    return this.empreinte === null ? null : cleLocalStorage(this.empreinte, NOM_DRAPEAU_DROITS);
  }

  private ecrireDrapeauDroits(diff: string[]): void {
    const k = this.cleDrapeau();
    if (k === null || this.stockage === null) return;
    try { this.stockage.setItem(k, JSON.stringify(diff)); } catch { /* l'avis reste en memoire */ }
  }

  private effacerDrapeauDroits(): void {
    const k = this.cleDrapeau();
    if (k === null || this.stockage === null) return;
    try { this.stockage.removeItem(k); } catch { /* rien a faire */ }
  }

  private lireDrapeauDroits(): string[] | null {
    const k = this.cleDrapeau();
    if (k === null || this.stockage === null) return null;
    try {
      const brut = this.stockage.getItem(k);
      if (!brut) return null;
      const v = JSON.parse(brut) as unknown;
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : ["droits"];
    } catch {
      return ["droits"];
    }
  }

  private memoriserMessage(message: string): void {
    try { this.stockage?.setItem(CLE_MESSAGE_SESSION, message); } catch { /* information seulement */ }
  }

  private lireMessageMemorise(): void {
    try {
      const m = this.stockage?.getItem(CLE_MESSAGE_SESSION) ?? null;
      if (m) { this.messageFermeture = m; this.stockage?.removeItem(CLE_MESSAGE_SESSION); }
    } catch { /* rien a faire */ }
  }

  /** Efface le message de fermeture une fois montre. */
  acquitterMessage(): void { this.messageFermeture = null; this.emettre(); }
}

// ---------------------------------------------------------------------------------------------------
// Colle React et navigateur
// ---------------------------------------------------------------------------------------------------

const ContexteControleur = createContext<ControleurSession | null>(null);

export function SessionLocaleProvider({ controleur, children }: { controleur: ControleurSession; children: ReactNode }) {
  return <ContexteControleur.Provider value={controleur}>{children}</ContexteControleur.Provider>;
}

export interface SessionLocale {
  readonly session: InstantaneSession;
  readonly controleur: ControleurSession;
}

const abonnerVide = () => () => undefined;
const instantaneVide = (): InstantaneSession | null => null;

/** Comme `useSessionLocale`, mais rend `null` hors fournisseur (composants testes seuls, anciens tests). */
export function useSessionLocaleOptionnelle(): SessionLocale | null {
  const controleur = useContext(ContexteControleur);
  const session = useSyncExternalStore(controleur ? controleur.abonner : abonnerVide, controleur ? controleur.instantane : instantaneVide);
  return controleur && session ? { session, controleur } : null;
}

export function useSessionLocale(): SessionLocale {
  const s = useSessionLocaleOptionnelle();
  if (!s) throw new Error("useSessionLocale doit etre utilise dans SessionLocaleProvider");
  return s;
}

/**
 * Branche les evenements du navigateur au controleur : activite (pointeur, clavier, tactile, defilement) ET pont
 * `surActivite` des ecrans, arriere-plan / premier plan, reseau. Rend la fonction de debranchement.
 */
export function brancherNavigateur(
  c: ControleurSession,
  cible: { window: Window; document: Document } = { window, document },
): () => void {
  const { window: w, document: d } = cible;
  const activite = () => c.signalerActivite();
  // Le pont du releve (point GNSS) n'est PAS une interaction : evenement distinct, plafonne, sans effet sur l'arriere-plan.
  const activiteExterne = () => c.signalerActiviteExterne();
  const visibilite = () => { if (d.visibilityState === "hidden") c.signalerArrierePlan(); else c.signalerPremierPlan(); };
  const hors = () => { void c.reseauPerdu("EVENEMENT"); };
  const en = () => { void c.reseauRevenu(); };
  const evenementsActivite = ["pointerdown", "keydown", "touchstart"] as const;
  for (const e of evenementsActivite) w.addEventListener(e, activite, { passive: true, capture: true });
  d.addEventListener("scroll", activite, { passive: true, capture: true });
  d.addEventListener("visibilitychange", visibilite);
  w.addEventListener("offline", hors);
  w.addEventListener("online", en);
  const pont = surActivite(activiteExterne);
  return () => {
    for (const e of evenementsActivite) w.removeEventListener(e, activite, { capture: true });
    d.removeEventListener("scroll", activite, { capture: true });
    d.removeEventListener("visibilitychange", visibilite);
    w.removeEventListener("offline", hors);
    w.removeEventListener("online", en);
    pont();
  };
}

/** Demarre le controleur et branche le navigateur pour la duree de vie du composant. */
export function useDemarrageSession(c: ControleurSession): void {
  useEffect(() => {
    c.activer();
    void c.demarrer().catch(() => undefined);
    const debrancher = brancherNavigateur(c);
    return () => { debrancher(); c.desactiver(); };
  }, [c]);
}
