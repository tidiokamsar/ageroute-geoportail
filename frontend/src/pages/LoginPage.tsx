import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { isAxiosError } from "axios";
import { ShieldCheck } from "lucide-react";

export function LoginPage() {
  const { login, verifyTwoFa } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmitCredentials(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await login(email, password);
      if (result?.requires2FA) {
        setChallengeToken(result.challengeToken);
      } else {
        navigate("/", { replace: true });
      }
    } catch (err) {
      setError(isAxiosError(err) ? err.response?.data?.error ?? "Connexion impossible" : "Connexion impossible");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    if (!challengeToken) return;
    setError("");
    setSubmitting(true);
    try {
      await verifyTwoFa(challengeToken, code);
      navigate("/", { replace: true });
    } catch (err) {
      setError(isAxiosError(err) ? err.response?.data?.error ?? "Code invalide" : "Code invalide");
    } finally {
      setSubmitting(false);
    }
  }

  if (challengeToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-navy to-navy2">
        <form onSubmit={onSubmitCode} className="bg-white rounded-2xl shadow-2xl p-9 w-[360px]">
          <div className="flex justify-center mb-3">
            <div className="h-12 w-12 rounded-full bg-navy/10 flex items-center justify-center">
              <ShieldCheck className="h-6 w-6 text-navy" />
            </div>
          </div>
          <h1 className="text-center text-navy text-lg font-bold mb-1">Vérification en deux étapes</h1>
          <p className="text-center text-gray-500 text-xs mb-6">Saisissez le code à 6 chiffres de votre application d'authentification</p>
          <Input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="text-center text-xl tracking-[0.4em] font-mono"
            autoFocus
            required
          />
          {error && <p className="text-red-600 text-xs text-center mt-3">{error}</p>}
          <Button type="submit" disabled={submitting || code.length !== 6} className="w-full mt-5">
            {submitting ? "Vérification..." : "Valider"}
          </Button>
          <button
            type="button"
            onClick={() => { setChallengeToken(null); setCode(""); setError(""); }}
            className="w-full mt-3 text-xs text-gray-400 hover:text-navy"
          >
            ← Retour
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-navy to-navy2">
      <form onSubmit={onSubmitCredentials} className="bg-white rounded-2xl shadow-2xl p-9 w-[360px]">
        <img src="/ageroute-logo.svg" alt="AGEROUTE" className="h-14 w-auto mx-auto mb-3" />
        <h1 className="text-center text-navy text-lg font-bold mb-1">BDRI</h1>
        <p className="text-center text-gray-500 text-xs mb-6">AGEROUTE Guinée</p>
        <div className="space-y-3">
          <Input type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Input
            type="password"
            placeholder="Mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-red-600 text-xs text-center mt-3">{error}</p>}
        <Button type="submit" disabled={submitting} className="w-full mt-5">
          {submitting ? "Connexion..." : "Se connecter"}
        </Button>
      </form>
    </div>
  );
}
