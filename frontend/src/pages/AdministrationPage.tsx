import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2, Mail, Landmark, Plus, Pencil, Trash2, Send, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { useConfirm } from "../hooks/useConfirm";
import { toast } from "../lib/toast";
import { parseApiError } from "../lib/errors";
import type { SmtpConfig, Bailleur } from "../types";

const TABS = [
  { id: "smtp", label: "Email (SMTP)", icon: Mail },
  { id: "bailleurs", label: "Bailleurs", icon: Landmark },
] as const;

// ── Onglet SMTP ──────────────────────────────────────────────────────────────────

function SmtpTab() {
  const qc = useQueryClient();
  const { data: config, isLoading } = useQuery({
    queryKey: ["admin", "settings", "smtp"],
    queryFn: async () => (await api.get<SmtpConfig | null>("/admin/settings/smtp")).data,
  });

  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("BDRI AGEROUTE <no-reply@ageroute.gov.gn>");
  const [testEmail, setTestEmail] = useState("");

  useEffect(() => {
    if (config) {
      setHost(config.host); setPort(config.port); setSecure(config.secure);
      setUser(config.user); setFrom(config.from);
    }
  }, [config]);

  const save = useMutation({
    mutationFn: () => api.put("/admin/settings/smtp", {
      host, port, secure, user: user || undefined,
      password: password || undefined,
      from,
    }),
    onSuccess: () => {
      toast.success("Configuration SMTP enregistrée");
      setPassword("");
      qc.invalidateQueries({ queryKey: ["admin", "settings", "smtp"] });
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const test = useMutation({
    mutationFn: () => api.post("/admin/settings/smtp/test", { to: testEmail }),
    onSuccess: () => toast.success(`Email de test envoyé à ${testEmail}`),
    onError: (err) => toast.error(parseApiError(err).message),
  });

  if (isLoading) return <p className="text-gray-400 text-sm py-6 text-center">Chargement...</p>;

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-sm font-semibold text-navy mb-1">Serveur d'envoi (SMTP)</h3>
        <p className="text-xs text-gray-500 mb-4">
          Utilisé pour les notifications automatiques (alertes contractuelles quotidiennes). Sans configuration, les emails ne partent pas — le système continue de fonctionner normalement.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Hôte SMTP</label>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.gmail.com" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
            <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} placeholder="587" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Utilisateur</label>
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="notifications@ageroute.gov.gn" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Mot de passe {config?.hasPassword && <span className="text-green-600 font-normal">(déjà enregistré)</span>}
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={config?.hasPassword ? "•••••••• (laisser vide pour conserver)" : "Mot de passe ou clé d'application"}
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Adresse d'expédition</label>
            <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="BDRI AGEROUTE <no-reply@ageroute.gov.gn>" />
          </div>
          <label className="flex items-center gap-2 md:col-span-2 text-sm text-gray-600">
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="rounded border-gray-300 text-navy focus:ring-navy/30" />
            Connexion SSL/TLS directe (port 465 généralement)
          </label>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !host || !from} className="mt-4">
          {save.isPending ? "Enregistrement…" : "Enregistrer"}
        </Button>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-navy mb-1 flex items-center gap-2">
          <Send className="h-4 w-4 text-navy/60" /> Tester l'envoi
        </h3>
        <p className="text-xs text-gray-500 mb-3">Envoie un email de test avec la configuration actuellement enregistrée.</p>
        <div className="flex gap-2">
          <Input type="email" placeholder="votre-email@exemple.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
          <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !testEmail}>
            {test.isPending ? "Envoi…" : "Envoyer"}
          </Button>
        </div>
        {test.isSuccess && (
          <p className="mt-2 text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Email envoyé avec succès.</p>
        )}
      </Card>
    </div>
  );
}

// ── Onglet Bailleurs ─────────────────────────────────────────────────────────────

function BailleursTab() {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Bailleur | null>(null);
  const [nom, setNom] = useState("");
  const [type, setType] = useState("autre");
  const [error, setError] = useState<string | null>(null);

  const { data: bailleurs, isLoading } = useQuery({
    queryKey: ["bailleurs", "admin"],
    queryFn: async () => (await api.get<Bailleur[]>("/bailleurs")).data,
  });

  const create = useMutation({
    mutationFn: () => api.post("/bailleurs", { nom, type }),
    onSuccess: () => { toast.success("Bailleur créé"); closeModal(); qc.invalidateQueries({ queryKey: ["bailleurs"] }); },
    onError: (err) => setError(parseApiError(err).message),
  });

  const update = useMutation({
    mutationFn: () => api.put(`/bailleurs/${editing!.id}`, { nom, type }),
    onSuccess: () => { toast.success("Bailleur modifié"); closeModal(); qc.invalidateQueries({ queryKey: ["bailleurs"] }); },
    onError: (err) => setError(parseApiError(err).message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/bailleurs/${id}`),
    onSuccess: () => { toast.success("Bailleur supprimé"); qc.invalidateQueries({ queryKey: ["bailleurs"] }); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  function openAdd() { setEditing(null); setNom(""); setType("autre"); setError(null); setModalOpen(true); }
  function openEdit(b: Bailleur) { setEditing(b); setNom(b.nom); setType(b.type); setError(null); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  const TYPE_LABEL: Record<string, string> = { etat: "État", multilateral: "Multilatéral", bilateral: "Bilatéral", autre: "Autre" };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-navy">Bailleurs de fonds</h3>
        <Button onClick={openAdd}><Plus className="h-4 w-4 mr-1" /> Ajouter</Button>
      </div>
      {isLoading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Chargement...</p>
      ) : (
        <div className="space-y-1.5">
          {(bailleurs ?? []).map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-navy">{b.nom}</p>
                <p className="text-xs text-gray-400">{TYPE_LABEL[b.type] ?? b.type} · {b._count?.marches ?? 0} marché(s)</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => openEdit(b)} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={async () => { if (await confirm(`Supprimer "${b.nom}" ?`, { danger: true })) remove.mutate(b.id); }}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={closeModal} title={editing ? `Modifier — ${editing.nom}` : "Nouveau bailleur"}>
        <div className="space-y-3">
          {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nom</label>
            <Input value={nom} onChange={(e) => setNom(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm">
              <option value="etat">État</option>
              <option value="multilateral">Multilatéral</option>
              <option value="bilateral">Bilatéral</option>
              <option value="autre">Autre</option>
            </select>
          </div>
          <Button
            onClick={() => (editing ? update.mutate() : create.mutate())}
            disabled={!nom || create.isPending || update.isPending}
            className="w-full"
          >
            {create.isPending || update.isPending ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </Modal>
      {confirmDialog}
    </Card>
  );
}

// ── Page principale ────────────────────────────────────────────────────────────

export function AdministrationPage() {
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]["id"]>("smtp");

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3 mb-2">
        <div className="h-9 w-9 rounded-lg bg-navy/10 flex items-center justify-center shrink-0">
          <Settings2 className="h-4 w-4 text-navy" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Administration</h1>
          <p className="text-xs text-gray-500">Paramètres système et référentiels</p>
        </div>
      </div>

      <div className="flex gap-1 bg-gray-100/70 rounded-xl p-1 w-fit">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === id ? "bg-white text-navy shadow-sm" : "text-gray-500 hover:text-navy"
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {activeTab === "smtp" && <SmtpTab />}
      {activeTab === "bailleurs" && <BailleursTab />}
    </div>
  );
}
