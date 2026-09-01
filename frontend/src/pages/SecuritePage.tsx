import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { ShieldCheck, ShieldOff, KeyRound } from "lucide-react";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { toast } from "../lib/toast";
import { parseApiError } from "../lib/errors";
import type { User } from "../types";

export function SecuritePage() {
  const qc = useQueryClient();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [showDisableForm, setShowDisableForm] = useState(false);

  const { data: me, isLoading } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => (await api.get<{ user: User }>("/auth/me")).data.user,
  });

  const setup = useMutation({
    mutationFn: async () => (await api.post<{ secret: string; otpauthUrl: string }>("/auth/2fa/setup")).data,
    onSuccess: async (data) => {
      setSecret(data.secret);
      setQrDataUrl(await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 220 }));
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const confirm = useMutation({
    mutationFn: () => api.post("/auth/2fa/confirm", { code: confirmCode }),
    onSuccess: () => {
      toast.success("Authentification à deux facteurs activée");
      setQrDataUrl(null); setSecret(null); setConfirmCode("");
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const disable = useMutation({
    mutationFn: () => api.post("/auth/2fa/disable", { password: disablePassword }),
    onSuccess: () => {
      toast.success("2FA désactivée");
      setShowDisableForm(false); setDisablePassword("");
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  if (isLoading || !me) return <p className="text-gray-400 p-6">Chargement...</p>;

  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-center gap-3 mb-2">
        <div className="h-9 w-9 rounded-lg bg-navy/10 flex items-center justify-center shrink-0">
          <KeyRound className="h-4 w-4 text-navy" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Sécurité du compte</h1>
          <p className="text-xs text-gray-500">{me.email}</p>
        </div>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {me.totpEnabled ? <ShieldCheck className="h-5 w-5 text-green-600" /> : <ShieldOff className="h-5 w-5 text-gray-400" />}
            <div>
              <h3 className="text-sm font-semibold text-navy">Authentification à deux facteurs (2FA)</h3>
              <p className="text-xs text-gray-500">
                {me.totpEnabled ? "Activée — une application d'authentification est requise à la connexion." : "Désactivée — recommandée pour les comptes ADMIN et GESTIONNAIRE."}
              </p>
            </div>
          </div>
        </div>

        {me.totpEnabled ? (
          showDisableForm ? (
            <div className="space-y-2 pt-2 border-t border-gray-100">
              <label className="block text-xs font-medium text-gray-600">Confirmez votre mot de passe pour désactiver la 2FA</label>
              <Input type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => disable.mutate()} disabled={disable.isPending || !disablePassword}>
                  {disable.isPending ? "..." : "Désactiver la 2FA"}
                </Button>
                <Button variant="secondary" onClick={() => setShowDisableForm(false)}>Annuler</Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setShowDisableForm(true)}>Désactiver la 2FA</Button>
          )
        ) : qrDataUrl ? (
          <div className="space-y-3 pt-2 border-t border-gray-100">
            <p className="text-xs text-gray-600">
              1. Scannez ce code avec Google Authenticator, Authy ou une application équivalente.
            </p>
            <div className="flex justify-center">
              <img src={qrDataUrl} alt="QR code 2FA" className="rounded-lg border border-gray-200" />
            </div>
            {secret && (
              <p className="text-center text-xs text-gray-400">
                Ou saisissez la clé manuellement : <span className="font-mono text-gray-600">{secret}</span>
              </p>
            )}
            <p className="text-xs text-gray-600 mt-3">2. Saisissez le code à 6 chiffres généré pour confirmer :</p>
            <div className="flex gap-2">
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, ""))}
                className="text-center font-mono tracking-widest"
              />
              <Button onClick={() => confirm.mutate()} disabled={confirm.isPending || confirmCode.length !== 6}>
                {confirm.isPending ? "..." : "Confirmer"}
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setup.mutate()} disabled={setup.isPending}>
            {setup.isPending ? "..." : "Activer la 2FA"}
          </Button>
        )}
      </Card>
    </div>
  );
}
