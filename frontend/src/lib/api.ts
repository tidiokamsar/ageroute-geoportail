import axios, { type AxiosError } from "axios";
import {
  lireLegacyRefreshToken, purgerLegacyRefreshToken, payloadRefresh,
  peutRetenter, marquerRetentee, verrouWebLocks, type Verrou,
} from "./session";

export const api = axios.create({ baseURL: "/api", withCredentials: true });

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
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
 * P3-B : le refresh token ne transite plus par ici — il vit dans le cookie
 * HttpOnly posé par l'API. Au premier lancement après mise à jour, un éventuel
 * ancien token localStorage sert UNE fois à migrer la session en cookie, puis
 * la clé est purgée pour toujours.
 */
async function refreshAccessToken(tokenPerime?: string | null): Promise<string | null> {
  return verrou.avecVerrou(async () => {
    // Verrou obtenu : un autre appel de cet onglet a peut-être déjà renouvelé le jeton pendant
    // l'attente. On ne le réutilise que s'il DIFFÈRE du jeton que la requête rejetée en 401 a
    // présenté. Réutiliser « n'importe quel jeton non nul » rejouait le même jeton périmé à
    // chaque 401 : un onglet ouvert plus de 15 minutes ne se rafraîchissait plus jamais.
    // Sans argument (démarrage de l'application), le comportement d'origine est conservé.
    if (accessToken && accessToken !== tokenPerime) return accessToken;

    const legacy = lireLegacyRefreshToken();
    try {
      const { data } = await axios.post("/api/auth/refresh", payloadRefresh(legacy), { withCredentials: true });
      setAccessToken(data.accessToken);
      // Le nouveau refresh est déjà parti en cookie (Set-Cookie de la réponse).
      // data.refreshToken (présent seulement en flux body/transition) est
      // volontairement ignoré : il ne sera jamais stocké côté client.
      if (legacy) purgerLegacyRefreshToken();
      return data.accessToken;
    } catch {
      setAccessToken(null);
      if (legacy) purgerLegacyRefreshToken(); // token périmé : inutile de le garder
      return null;
    }
  });
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
    if (error.response?.status === 401 && original && peutRetenter(original)) {
      marquerRetentee(original);
      // Un seul refresh à la fois dans l'onglet ; le verrou inter-onglets
      // (Web Locks) couvre le reste. Le perdant éventuel retrouve ici un
      // token déjà frais sans relancer de rotation.
      // `finally` libère le créneau dès que le refresh se termine, réussi ou non : un échec ne
      // bloque pas le suivant, et il n'y a jamais deux refresh en vol dans l'onglet.
      refreshing = refreshing ?? refreshAccessToken(jetonPresente(original)).finally(() => { refreshing = null; });
      const newToken = await refreshing;
      if (newToken) {
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
      window.location.assign("/login");
    }
    return Promise.reject(error);
  }
);

export { refreshAccessToken };
