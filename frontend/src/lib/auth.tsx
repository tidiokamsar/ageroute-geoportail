import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import axios from "axios";
import { api, setAccessToken, rafraichirJeton, surIssueRafraichissement } from "./api";
import { lireLegacyRefreshToken, poserMarqueurSession, purgerMarqueurSession, marqueurSessionPresent } from "./session";
import { lireStockageLocal, NOM_CLE_APPAREIL_SYNC } from "./compteCourant";
import { migrerHeritage } from "./migrationHeritage";
import { decompteFileLocale, refreshPendingCount, syncPendingOfflineData } from "./offlineSync";
import { toast } from "./toast";
import { sha256WebCrypto, stockageIndexedDb } from "../session/coffreSession";
import { creerCanalOnglets } from "../session/canalOnglets";
import { genererUuid, estUuid } from "../session/journalEvenementsLocaux";
import {
  ControleurSession, SessionLocaleProvider, useDemarrageSession,
  type DepsControleur, type ServeurSession,
} from "../session/useSessionLocale";
import type { User } from "../types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ requires2FA: true; challengeToken: string } | void>;
  verifyTwoFa: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------------------------------
// Branchement reel du controleur de session locale (src/session/useSessionLocale.tsx)
// ---------------------------------------------------------------------------------------------------

/** Echec d'envoi du journal : seul le code HTTP importe (le journal distingue « pas de reponse » d'un refus du lot). */
function erreurEnvoi(e: unknown): { statut?: number } {
  return axios.isAxiosError(e) && e.response ? { statut: e.response.status } : {};
}

/**
 * Une erreur de `POST /auth/logout` veut-elle dire « le serveur est joint et la session n'existe plus » ?
 *   - 401 / 403 : le cookie n'ouvre plus de session (deja fermee, revoquee) : il n'y a plus rien a revoquer, c'est joint ;
 *   - toute autre reponse (5xx, 429, 400...) ET toute absence de reponse (reseau coupe) : le serveur n'a PAS revoque le cookie.
 *     Compter ces cas comme « joints » fermait la session locale, purgeait le marqueur et annoncait « Session fermee » alors que
 *     le cookie de rafraichissement restait valide (constat de la relecture independante). Ils passent en deconnexion EN ATTENTE
 *     (verrou local et drapeau rejoue au retour du reseau).
 */
export function deconnexionJointeApresErreur(e: unknown): boolean {
  if (!axios.isAxiosError(e) || e.response === undefined) return false;
  return e.response.status === 401 || e.response.status === 403;
}

export function serveurReel(): ServeurSession {
  return {
    async connexion(email, password) {
      const { data } = await api.post("/auth/login", { email, password });
      if (data.requires2FA) return { requires2FA: true as const, challengeToken: data.challengeToken as string };
      // Le refresh est arrive en cookie HttpOnly : data.refreshToken (anciens clients) n'est jamais stocke.
      return { accessToken: data.accessToken as string, user: data.user };
    },
    async verifierDeuxFacteurs(challengeToken, code) {
      const { data } = await api.post("/auth/2fa/login-verify", { challengeToken, code });
      return { accessToken: data.accessToken as string, user: data.user };
    },
    async moi() {
      const { data } = await api.get("/auth/me");
      return data.user;
    },
    async deconnexion(tous) {
      try {
        // Le cookie HttpOnly voyage seul : plus de token dans le body.
        await api.post(tous ? "/auth/logout-all" : "/auth/logout", {});
        return true;
      } catch (e) {
        return deconnexionJointeApresErreur(e);
      }
    },
    rafraichirAuDemarrage: () => rafraichirJeton(),
    async sonder() {
      // Sans cela, un jeton d'acces deja en memoire court-circuiterait le rafraichissement et rien ne serait sonde.
      setAccessToken(null);
      return rafraichirJeton();
    },
    async envoyerEvenements(corps) {
      try {
        await api.post("/auth/evenements-locaux", corps);
      } catch (e) {
        throw erreurEnvoi(e);
      }
    },
    poserJeton: setAccessToken,
    appareilServeurId: () => {
      const id = lireStockageLocal(NOM_CLE_APPAREIL_SYNC);
      return estUuid(id) ? id : null;
    },
  };
}

const CLE_APPAREIL_LOCAL = "bdri.appareilLocal";
let appareilLocalVolatil: string | null = null;

/**
 * Identifiant LOCAL et STABLE de cette installation (coffre : « un identifiant qui change rendrait le coffre illisible »).
 * Genere une fois, conserve en localStorage. LIMITE : si le stockage est refuse (mode prive strict), l'identifiant ne vit que
 * le temps de la page, et un coffre cree ainsi serait refuse a la reouverture (AUTRE_APPAREIL). Sans localStorage, rien ne
 * survit de toute facon hors ligne (indice de compte, journal, compteurs).
 */
export function identifiantAppareilLocal(): string {
  try {
    const existant = localStorage.getItem(CLE_APPAREIL_LOCAL);
    if (existant && existant.length > 0) return existant;
    const neuf = genererUuid();
    localStorage.setItem(CLE_APPAREIL_LOCAL, neuf);
    return neuf;
  } catch {
    appareilLocalVolatil ??= genererUuid();
    return appareilLocalVolatil;
  }
}

export function depsReelles(): DepsControleur {
  return {
    serveur: serveurReel(),
    stockageCoffre: stockageIndexedDb(),
    idAppareilLocal: identifiantAppareilLocal,
    maintenant: () => Date.now(),
    marqueur: {
      present: () => lireLegacyRefreshToken() !== null || marqueurSessionPresent(),
      poser: poserMarqueurSession,
      purger: purgerMarqueurSession,
    },
    sha256: sha256WebCrypto,
    decompteFile: decompteFileLocale,
    migrer: migrerHeritage,
    apresDeverrouillage: () => { void refreshPendingCount().then(() => syncPendingOfflineData()).catch(() => undefined); },
    enLigneNavigateur: () => (typeof navigator === "undefined" ? true : navigator.onLine),
    canal: creerCanalOnglets(),
  };
}

/**
 * `controleur` : injecte par les tests. En production, le controleur reel est cree une fois par fournisseur.
 */
export function AuthProvider({ children, controleur: injecte }: { children: ReactNode; controleur?: ControleurSession }) {
  const [controleur] = useState(() => injecte ?? new ControleurSession(depsReelles()));
  const session = useSyncExternalStore(controleur.abonner, controleur.instantane);

  // Cache de requetes (React Query) : vide a chaque SORTIE de session (deconnexion, fermeture, expiration, reinitialisation,
  // effacement) et a chaque changement de compte. Sans cela, le compte B recevait les donnees du compte A, et si sa requete
  // echouait elles restaient affichees. Le client vient du fournisseur de `main.tsx` ; sans fournisseur (tests), rien a vider.
  // Declare AVANT `useDemarrageSession` : l'abonnement existe quand le demarrage commence.
  const queryClient = useContext(QueryClientContext);
  useEffect(() => controleur.surSortieDeSession(() => { queryClient?.clear(); }), [controleur, queryClient]);

  useDemarrageSession(controleur);

  // Issue de chaque rafraichissement REEL, y compris ceux que declenche l'intercepteur 401 hors de la vue d'un composant.
  useEffect(() => surIssueRafraichissement((r) => { void controleur.surRafraichissement(r); }), [controleur]);

  // Une requete qui echoue SANS reponse est un indice de reseau coupe : le controleur le verifie par une sonde reelle.
  useEffect(() => {
    const id = api.interceptors.response.use(undefined, (erreur: unknown) => {
      if (axios.isAxiosError(erreur) && erreur.response === undefined && erreur.code !== "ERR_CANCELED") void controleur.reseauPerdu("REQUETE");
      return Promise.reject(erreur);
    });
    return () => api.interceptors.response.eject(id);
  }, [controleur]);

  const value: AuthContextValue = {
    user: session.utilisateur,
    loading: !session.demarre,
    login: (email, password) => controleur.connecter(email, password),
    verifyTwoFa: (challengeToken, code) => controleur.verifierDeuxFacteurs(challengeToken, code),
    logout: async () => { toast.info((await controleur.deconnecter({})).texte); },
    logoutAll: async () => { toast.info((await controleur.deconnecter({ tous: true })).texte); },
  };

  return (
    <SessionLocaleProvider controleur={controleur}>
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    </SessionLocaleProvider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit etre utilise dans AuthProvider");
  return ctx;
}

export function canWrite(role: User["role"] | undefined) {
  return role === "ADMIN" || role === "GESTIONNAIRE";
}

export function canDelete(role: User["role"] | undefined) {
  return role === "ADMIN" || role === "GESTIONNAIRE";
}
