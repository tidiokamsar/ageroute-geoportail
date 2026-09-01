import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setAccessToken, getRefreshToken, setRefreshToken, refreshAccessToken } from "./api";
import type { User } from "../types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ requires2FA: true; challengeToken: string } | void>;
  verifyTwoFa: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (getRefreshToken()) {
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
    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    setUser(data.user);
  }

  async function verifyTwoFa(challengeToken: string, code: string) {
    const { data } = await api.post("/auth/2fa/login-verify", { challengeToken, code });
    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    setUser(data.user);
  }

  async function logout() {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        await api.post("/auth/logout", { refreshToken });
      } catch {
        // deconnexion locale malgre tout
      }
    }
    setAccessToken(null);
    setRefreshToken(null);
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, verifyTwoFa, logout }}>{children}</AuthContext.Provider>;
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
