import axios, { type AxiosError } from "axios";
import {
  lireLegacyRefreshToken, purgerLegacyRefreshToken, payloadRefresh,
  peutRetenter, marquerRetentee, verrouWebLocks, type Verrou,
} from "./session";

export const api = axios.create({ baseURL: "/api", withCredentials: true });

let accessToken: string | null = null;
let refreshing: Promise<ResultatRafraichissement> | null = null;
let verrou: Verrou = verrouWebLocks();

/** Test uniquement : injecte un verrou déterministe. */
export function _fixerVerrouRefresh(v: Verrou) {
  verrou = v;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

/**
 * Issue typée d'un rafraîchissement (session hors ligne, étape 2 : docs/securite/SESSION-HORS-LIGNE.md).
 *
 * - `OK`            le serveur a répondu 2xx avec un jeton d'accès.
 * - `RESEAU_COUPE`  AUCUNE réponse HTTP (réseau coupé, DNS, délai dépassé, requête avortée).
 * - `INDISPONIBLE`  une réponse HTTP qui n'est ni un succès ni un refus d'identité : 5xx, 429, 4xx autre que
 *                   401/403, ou 2xx sans jeton. Le serveur n'a PAS dit non au compte : même conduite que
 *                   RESEAU_COUPE, mais distinguée (c'est un serveur en panne, pas un téléphone sans réseau).
 * - `REFUSE`        401 ou 403 : le serveur refuse le cookie de rafraîchissement (expiré, révoqué, compte
 *                   verrouillé). Seul cas où la session se ferme.
 *
 * `etat` reprend exactement `EtatRafraichissement` du noyau de session (src/session/noyauSession.ts) : un
 * intégrateur passe `issue: resultat.etat` à l'événement REFRAICHISSEMENT.
 */
export type ResultatRafraichissement =
  | { readonly etat: "OK"; readonly token: string }
  | { readonly etat: "RESEAU_COUPE" }
  | { readonly etat: "INDISPONIBLE"; readonly statut: number }
  | { readonly etat: "REFUSE"; readonly statut: 401 | 403 };

type EcouteurRafraichissement = (resultat: ResultatRafraichissement) => void;
const ecouteurs = new Set<EcouteurRafraichissement>();

/**
 * S'abonne à l'issue de CHAQUE rafraîchissement réellement tenté (pas à la réutilisation d'un jeton déjà
 * renouvelé par un autre appel). C'est ainsi qu'un composant apprend ce qui s'est passé quand le
 * rafraîchissement a été déclenché par l'intercepteur 401, hors de sa vue. Rend la fonction de désabonnement.
 * Une erreur levée par un écouteur est ignorée : elle ne doit pas casser la requête en cours.
 */
export function surIssueRafraichissement(ecouteur: EcouteurRafraichissement): () => void {
  ecouteurs.add(ecouteur);
  return () => { ecouteurs.delete(ecouteur); };
}

function annoncer(resultat: ResultatRafraichissement) {
  for (const e of [...ecouteurs]) {
    try { e(resultat); } catch { /* un écouteur défaillant ne doit pas altérer le rafraîchissement */ }
  }
}

/**
 * P3-B : le refresh token ne transite plus par ici — il vit dans le cookie
 * HttpOnly posé par l'API. Au premier lancement après mise à jour, un éventuel
 * ancien token localStorage sert UNE fois à migrer la session en cookie, puis
 * la clé est purgée pour toujours.
 *
 * Version TYPÉE : dit ce qui s'est passé au lieu de tout replier sur `null`. Seul REFUSE vide le jeton en
 * mémoire et purge l'ancien jeton localStorage ; une coupure réseau ou un serveur en panne ne détruisent
 * rien (le jeton d'accès, même périmé, reste ; l'ancien jeton localStorage n'a pas été consommé).
 */
export async function rafraichirJeton(tokenPerime?: string | null): Promise<ResultatRafraichissement> {
  return verrou.avecVerrou(async (): Promise<ResultatRafraichissement> => {
    // Verrou obtenu : un autre appel de cet onglet a peut-être déjà renouvelé le jeton pendant
    // l'attente. On ne le réutilise que s'il DIFFÈRE du jeton que la requête rejetée en 401 a
    // présenté. Réutiliser « n'importe quel jeton non nul » rejouait le même jeton périmé à
    // chaque 401 : un onglet ouvert plus de 15 minutes ne se rafraîchissait plus jamais.
    // Sans argument (démarrage de l'application), le comportement d'origine est conservé.
    if (accessToken && accessToken !== tokenPerime) return { etat: "OK", token: accessToken };

    const legacy = lireLegacyRefreshToken();
    let resultat: ResultatRafraichissement;
    try {
      const { data } = await axios.post("/api/auth/refresh", payloadRefresh(legacy), { withCredentials: true });
      if (typeof data?.accessToken === "string" && data.accessToken.length > 0) {
        setAccessToken(data.accessToken);
        // Le nouveau refresh est déjà parti en cookie (Set-Cookie de la réponse).
        // data.refreshToken (présent seulement en flux body/transition) est
        // volontairement ignoré : il ne sera jamais stocké côté client.
        if (legacy) purgerLegacyRefreshToken();
        resultat = { etat: "OK", token: data.accessToken };
      } else {
        // 2xx sans jeton : le serveur répond mal, il n'a pas refusé le compte.
        resultat = { etat: "INDISPONIBLE", statut: 200 };
      }
    } catch (e) {
      const statut = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (statut === undefined) {
        resultat = { etat: "RESEAU_COUPE" };
      } else if (statut === 401 || statut === 403) {
        setAccessToken(null);
        if (legacy) purgerLegacyRefreshToken(); // token périmé : inutile de le garder
        resultat = { etat: "REFUSE", statut };
      } else {
        resultat = { etat: "INDISPONIBLE", statut };
      }
    }
    annoncer(resultat);
    return resultat;
  });
}

/**
 * Forme historique, conservée pour les appelants actuels (auth.tsx) : le jeton, ou `null` si le
 * rafraîchissement n'a pas abouti, QUELLE QU'EN SOIT LA RAISON. Différence avec l'ancien comportement : une
 * coupure réseau ou un serveur indisponible ne vident plus le jeton en mémoire. Pour distinguer les cas,
 * utiliser `rafraichirJeton`.
 */
async function refreshAccessToken(tokenPerime?: string | null): Promise<string | null> {
  const r = await rafraichirJeton(tokenPerime);
  return r.etat === "OK" ? r.token : null;
}

/** Jeton porté par la requête rejetée (entête Authorization), ou `null` si elle n'en portait pas. */
function jetonPresente(config: AxiosError["config"]): string | null {
  const brut = (config?.headers as { Authorization?: unknown } | undefined)?.Authorization;
  return typeof brut === "string" && brut.startsWith("Bearer ") ? brut.slice(7) : null;
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config;
    // Un 401 sur la connexion ou sur le rafraichissement n'est PAS un jeton expire : c'est « identifiants refuses » ou
    // « session refusee ». Tenter un rafraichissement puis recharger /login faisait disparaitre le message d'erreur du
    // formulaire (defaut E2E-1 : un mauvais mot de passe ne montrait rien).
    const url = original?.url ?? "";
    const estAuthentification = /\/auth\/(login|refresh|2fa\/login-verify)(?:[/?]|$)/.test(url);
    if (error.response?.status === 401 && original && !estAuthentification && peutRetenter(original)) {
      marquerRetentee(original);
      // Un seul refresh à la fois dans l'onglet ; le verrou inter-onglets
      // (Web Locks) couvre le reste. Le perdant éventuel retrouve ici un
      // token déjà frais sans relancer de rotation.
      // `finally` libère le créneau dès que le refresh se termine, réussi ou non : un échec ne
      // bloque pas le suivant, et il n'y a jamais deux refresh en vol dans l'onglet.
      refreshing = refreshing ?? rafraichirJeton(jetonPresente(original)).finally(() => { refreshing = null; });
      const issue = await refreshing;
      if (issue.etat === "OK") {
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${issue.token}`;
        return api(original);
      }
      // Seul un refus du serveur (401/403) ferme la session. Réseau coupé ou serveur en panne : la requête
      // échoue avec son 401 d'origine, sans redirection ni purge (l'agent peut être hors ligne, session locale).
      if (issue.etat === "REFUSE") window.location.assign("/login");
    }
    return Promise.reject(error);
  }
);

export { refreshAccessToken };
