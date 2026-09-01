import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Pencil, KeyRound, PowerOff, Power, Search, Users, ShieldCheck } from "lucide-react";
import { DataTable } from "../components/DataTable";
import { EntityForm, type FieldConfig } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { RoleBadge } from "../components/ui/Badge";
import { EntityDetailModal } from "../components/EntityDetailModal";
import { useAuth } from "../lib/auth";
import { parseApiError } from "../lib/errors";
import { toast } from "../lib/toast";
import { useConfirm } from "../hooks/useConfirm";
import { MODULES } from "../lib/modules";
import type { User } from "../types";

const ROLE_OPTIONS = [
  { value: "ADMIN", label: "Administrateur" },
  { value: "GESTIONNAIRE", label: "Gestionnaire" },
  { value: "INSPECTEUR", label: "Inspecteur" },
  { value: "LECTEUR", label: "Lecteur" },
];

const CREATE_FIELDS: FieldConfig[] = [
  { name: "email", label: "E-mail", type: "text", required: true },
  { name: "nomComplet", label: "Nom complet", type: "text", required: true },
  { name: "password", label: "Mot de passe (min. 8 caractères)", type: "password", required: true },
  { name: "role", label: "Rôle", type: "select", options: ROLE_OPTIONS, required: true },
];

// ── Modal : accès par module ────────────────────────────────────────────────────

function ModuleAccessModal({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set(user.modulesAutorises ?? []));
  const restricted = (user.modulesAutorises?.length ?? 0) > 0;
  const [enabled, setEnabled] = useState(restricted);

  const save = useMutation({
    mutationFn: () => api.put(`/users/${user.id}`, { modulesAutorises: enabled ? Array.from(selected) : [] }),
    onSuccess: () => { toast.success("Accès mis à jour"); qc.invalidateQueries({ queryKey: ["users"] }); onClose(); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  function toggle(key: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  return (
    <Modal open onClose={onClose} title={`Accès aux modules — ${user.nomComplet}`}>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded border-gray-300 text-navy focus:ring-navy/30" />
          Restreindre l'accès à des modules spécifiques
        </label>
        <p className="text-xs text-gray-400">
          Décoché : l'utilisateur voit tout ce que son rôle ({user.role}) autorise déjà, sans restriction supplémentaire.
        </p>
        {enabled && (
          <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-gray-200 p-3 max-h-72 overflow-y-auto">
            {MODULES.map((m) => (
              <label key={m.key} className="flex items-center gap-2 text-sm text-gray-700 py-1">
                <input
                  type="checkbox"
                  checked={selected.has(m.key)}
                  onChange={() => toggle(m.key)}
                  className="rounded border-gray-300 text-navy focus:ring-navy/30"
                />
                {m.label}
              </label>
            ))}
          </div>
        )}
        <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
          {save.isPending ? "Enregistrement…" : "Enregistrer"}
        </Button>
      </div>
    </Modal>
  );
}

const EDIT_FIELDS: FieldConfig[] = [
  { name: "nomComplet", label: "Nom complet", type: "text", required: true },
  { name: "role", label: "Rôle", type: "select", options: ROLE_OPTIONS, required: true },
];

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [accessTarget, setAccessTarget] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [viewingUser, setViewingUser] = useState<User | null>(null);

  const { confirm, dialog: confirmDialog } = useConfirm();
  const { data, isLoading } = useEntityList<User>("users", { page, pageSize: 20, search, sortBy, sortDir });
  const { create, update } = useEntityMutations("users");

  const resetPassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.post(`/users/${id}/reset-password`, { password }),
  });

  async function handleSubmit(values: Record<string, unknown>) {
    setError(null);
    setFieldErrors({});
    try {
      if (editing) await update.mutateAsync({ id: editing.id, payload: values });
      else await create.mutateAsync(values);
      setModalOpen(false);
      setEditing(null);
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
      setFieldErrors(parsed.fieldErrors);
    }
  }

  async function toggleActif(u: User) {
    setError(null);
    try {
      await update.mutateAsync({ id: u.id, payload: { actif: !u.actif } });
    } catch (err) {
      setError(parseApiError(err).message);
    }
  }

  async function handleResetPassword() {
    if (!resetTarget) return;
    setError(null);
    try {
      await resetPassword.mutateAsync({ id: resetTarget.id, password: newPassword });
      setResetTarget(null);
      setNewPassword("");
    } catch (err) {
      setError(parseApiError(err).message);
    }
  }

  const dataColumns: ColumnDef<User, unknown>[] = [
    { accessorKey: "nomComplet", header: "Nom" },
    { accessorKey: "email", header: "E-mail" },
    {
      accessorKey: "role",
      header: "Rôle",
      cell: ({ row }) => <RoleBadge role={row.original.role} />,
    },
    {
      accessorKey: "actif",
      header: "Statut",
      cell: ({ row }) => (
        <span className={`inline-flex items-center gap-1.5 ${row.original.actif ? "text-green-700" : "text-gray-400"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${row.original.actif ? "bg-green-500" : "bg-gray-300"}`} />
          {row.original.actif ? "Actif" : "Désactivé"}
        </span>
      ),
    },
    {
      accessorKey: "derniereConnexion",
      header: "Dernière connexion",
      cell: ({ row }) =>
        row.original.derniereConnexion ? new Date(row.original.derniereConnexion).toLocaleString("fr-FR") : "—",
    },
  ];

  function userActions(u: User) {
    const isSelf = u.id === currentUser?.id;
    return (
      <div className="flex items-center gap-1 justify-end">
        <button
          title="Modifier"
          className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
          onClick={() => {
            setEditing(u);
            setError(null);
            setFieldErrors({});
            setModalOpen(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          title="Réinitialiser le mot de passe"
          className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
          onClick={() => setResetTarget(u)}
        >
          <KeyRound className="h-3.5 w-3.5" />
        </button>
        <button
          title="Accès aux modules"
          className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
          onClick={() => setAccessTarget(u)}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
        </button>
        <button
          title={u.actif ? "Désactiver" : "Réactiver"}
          className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${u.actif ? "text-gray-400 hover:text-red-500 hover:bg-red-50" : "text-gray-400 hover:text-green-600 hover:bg-green-50"}`}
          disabled={isSelf && u.actif}
          onClick={async () => {
            if (await confirm(u.actif ? "Désactiver ce compte ?" : "Réactiver ce compte ?", { danger: u.actif })) toggleActif(u);
          }}
        >
          {u.actif ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
        </button>
      </div>
    );
  }

  const columns: ColumnDef<User, unknown>[] = [
    ...dataColumns,
    { id: "actions", header: "", cell: ({ row }) => userActions(row.original) },
  ];

  return (
    <div className="space-y-3">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="h-8 w-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <Users className="h-4 w-4 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Utilisateurs</h1>
          <p className="text-xs text-gray-500">Gestion des accès et des rôles</p>
        </div>
      </div>

      {/* Ligne 1 : recherche + bouton ajouter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <Input
            placeholder="Rechercher un utilisateur (nom ou e-mail)..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <div className="ml-auto">
          <Button
            onClick={() => {
              setEditing(null);
              setError(null);
              setFieldErrors({});
              setModalOpen(true);
            }}
          >
            + Ajouter un utilisateur
          </Button>
        </div>
      </div>

      {/* Ligne 3 : count */}
      <div className="flex items-center justify-end px-1">
        <span className="text-sm text-gray-400">
          {(data?.total ?? 0).toLocaleString("fr-FR")} utilisateur{(data?.total ?? 0) !== 1 ? "s" : ""}
        </span>
      </div>

      <DataTable
        data={data?.data ?? []}
        columns={columns}
        page={data?.page ?? 1}
        totalPages={data?.totalPages ?? 1}
        total={data?.total ?? 0}
        sortBy={sortBy}
        sortDir={sortDir}
        loading={isLoading}
        onPageChange={setPage}
        onSortChange={(key) => {
          if (key === sortBy) setSortDir(sortDir === "asc" ? "desc" : "asc");
          else {
            setSortBy(key);
            setSortDir("asc");
          }
        }}
        onRowClick={(u) => setViewingUser(u)}
      />

      {viewingUser && (
        <EntityDetailModal
          open={!!viewingUser}
          onClose={() => setViewingUser(null)}
          title={`${viewingUser.nomComplet} — détail`}
          row={viewingUser}
          columns={dataColumns}
          actions={[
            {
              label: "Modifier",
              onClick: () => {
                setEditing(viewingUser);
                setError(null);
                setFieldErrors({});
                setModalOpen(true);
                setViewingUser(null);
              },
            },
            {
              label: "Réinit. mot de passe",
              onClick: () => {
                setResetTarget(viewingUser);
                setViewingUser(null);
              },
            },
            {
              label: viewingUser.actif ? "Désactiver" : "Réactiver",
              variant: viewingUser.actif ? "danger" : "secondary",
              onClick: async () => {
                if (viewingUser.id === currentUser?.id && viewingUser.actif) {
                  alert("Vous ne pouvez pas désactiver votre propre compte");
                  return;
                }
                if (await confirm(viewingUser.actif ? "Désactiver ce compte ?" : "Réactiver ce compte ?", { danger: viewingUser.actif })) {
                  toggleActif(viewingUser);
                  setViewingUser(null);
                }
              },
            },
          ]}
        />
      )}

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setError(null);
          setFieldErrors({});
        }}
        title={editing ? `Modifier — ${editing.nomComplet}` : "Ajouter un utilisateur"}
      >
        <EntityForm
          fields={editing ? EDIT_FIELDS : CREATE_FIELDS}
          defaultValues={editing ? { nomComplet: editing.nomComplet, role: editing.role } : {}}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={error}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      <Modal open={!!resetTarget} onClose={() => setResetTarget(null)} title={`Réinitialiser le mot de passe — ${resetTarget?.nomComplet ?? ""}`}>
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nouveau mot de passe (min. 8 caractères)</label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <Button onClick={handleResetPassword} disabled={resetPassword.isPending || newPassword.length < 8} className="w-full">
            {resetPassword.isPending ? "Enregistrement..." : "Réinitialiser"}
          </Button>
        </div>
      </Modal>
      {accessTarget && <ModuleAccessModal user={accessTarget} onClose={() => setAccessTarget(null)} />}

      {confirmDialog}
    </div>
  );
}
