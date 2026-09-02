import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setAccessToken, refreshAccessToken } from "./api";
import { lireLegacyRefreshToken, poserMarqueurSession, purgerMarqueurSession, marqueurSessionPresent } from "./session";
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // P3-B : la session vit dans le cookie HttpOnly. Un ancien token
      // localStorage (client d'avant la mise à jour) sert UNE fois à migrer
      // la session — refreshAccessToken l'envoie en body puis purge la clé.
      // Sans marqueur ni ancien token, inutile de lancer un refresh condamné.
      if (lireLegacyRefreshToken() || marqueurSessionPresent()) {
        const token = await refreshAccessToken();
        if (token) {
          try {
            const { data } = await api.get("/auth/me");
            setUser(data.user);
          } catch {
            setUser(null);
          }
        }
      }
      setLoading(false);
    })();
  }, []);

  async function login(email: string, password: string) {
    const { data } = await api.post("/auth/login", { email, password });
    if (data.requires2FA) {
      return { requires2FA: true as const, challengeToken: data.challengeToken as string };
    }
    // Le refresh est arrivé en cookie HttpOnly : data.refreshToken (présent
    // uniquement pour les anciens clients) n'est jamais stocké ni conservé.
    setAccessToken(data.accessToken);
    poserMarqueurSession();
    setUser(data.user);
  }

  async function verifyTwoFa(challengeToken: string, code: string) {
    const { data } = await api.post("/auth/2fa/login-verify", { challengeToken, code });
    setAccessToken(data.accessToken);
    poserMarqueurSession();
    setUser(data.user);
  }

  async function logout() {
    try {
      // Le cookie HttpOnly voyage seul — plus de token dans le body.
      await api.post("/auth/logout", {});
    } catch {
      // deconnexion locale malgre tout
    }
    setAccessToken(null);
    purgerMarqueurSession();
    setUser(null);
  }

  async function logoutAll() {
    try {
      await api.post("/auth/logout-all", {});
    } catch {
      // deconnexion locale malgre tout
    }
    setAccessToken(null);
    purgerMarqueurSession();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, verifyTwoFa, logout, logoutAll }}>
      {children}
    </AuthContext.Provider>
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
