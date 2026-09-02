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
async function refreshAccessToken(): Promise<string | null> {
  return verrou.avecVerrou(async () => {
    // Verrou obtenu : un autre onglet a peut-être déjà rafraîchi pendant l'attente.
    if (accessToken) return accessToken;

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

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config;
    if (error.response?.status === 401 && original && peutRetenter(original)) {
      marquerRetentee(original);
      // Un seul refresh à la fois dans l'onglet ; le verrou inter-onglets
      // (Web Locks) couvre le reste. Le perdant éventuel retrouve ici un
      // token déjà frais sans relancer de rotation.
      refreshing = refreshing ?? refreshAccessToken();
      const newToken = await refreshing;
      refreshing = null;
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
