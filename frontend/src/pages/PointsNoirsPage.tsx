import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Map, ChevronDown, Plus, Archive, RotateCcw, Pencil, Clock, Search, AlertTriangle } from "lucide-react";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { AuditHistoryModal } from "../components/AuditHistoryModal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useAuth, canWrite, canDelete } from "../lib/auth";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";
import { api } from "../lib/api";
import { pointNoirFields } from "../lib/fieldConfigs";
import type { PointNoir, Region, Gravite } from "../types";

// ── FilterSelect ───────────────────────────────────────────────────────────────

function FilterSelect({ value, onChange, children }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  const active = value !== "";
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none rounded-lg px-3 py-1.5 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20 ${
          active
            ? "border border-navy/40 bg-navy/5 text-navy font-medium"
            : "border border-gray-200 bg-white text-gray-600"
        }`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
    </div>
  );
}

// ── Gravité badge ─────────────────────────────────────────────────────────────

const GRAVITE_STYLES: Record<Gravite, string> = {
  FAIBLE:  "bg-yellow-100 text-yellow-700",
  MOYENNE: "bg-orange-100 text-orange-700",
  FORTE:   "bg-red-100 text-red-700",
};
const GRAVITE_LABELS: Record<Gravite, string> = {
  FAIBLE: "Faible", MOYENNE: "Moyenne", FORTE: "Forte",
};
const GRAVITE_DOTS: Record<Gravite, string> = {
  FAIBLE:  "bg-green-500",
  MOYENNE: "bg-orange-500",
  FORTE:   "bg-red-500",
};

function GraviteBadge({ gravite }: { gravite: Gravite }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${GRAVITE_STYLES[gravite] ?? "bg-gray-100 text-gray-600"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${GRAVITE_DOTS[gravite] ?? "bg-gray-400"}`} />
      {GRAVITE_LABELS[gravite] ?? gravite}
    </span>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function PointsNoirsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Filters
  const [search, setSearch]           = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [graviteFilter, setGraviteFilter] = useState("");
  const [archived, setArchived]       = useState(false);
  const [page, setPage]               = useState(1);
  const [sortBy, setSortBy]           = useState("createdAt");
  const [sortDir, setSortDir]         = useState<"asc" | "desc">("desc");

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Modals
  const [modalOpen, setModalOpen]   = useState(false);
  const [editing, setEditing]       = useState<PointNoir | null>(null);
  const [formError, setFormError]   = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [historyId, setHistoryId]   = useState<string | null>(null);

  // Data
  const { data, isLoading } = useEntityList<PointNoir>("points-noirs", {
    page, pageSize: 20, search,
    region: regionFilter || undefined,
    etat: graviteFilter || undefined,
    sortBy, sortDir, archived,
  });

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const { create, update, remove, bulkArchive, bulkRestore } = useEntityMutations("points-noirs");

  // Selection helpers
  const rows = data?.data ?? [];
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleSelect(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      const allSel = rows.length > 0 && rows.every((r) => prev.has(r.id));
      const n = new Set(prev);
      allSel ? rows.forEach((r) => n.delete(r.id)) : rows.forEach((r) => n.add(r.id));
      return n;
    });
  }

  async function handleBulkArchive() {
    if (!(await confirm(`Archiver les ${selected.size} point(s) noir(s) ?`, { danger: true }))) return;
    await bulkArchive.mutateAsync(Array.from(selected));
    setSelected(new Set());
  }
  async function handleBulkRestore() {
    await bulkRestore.mutateAsync(Array.from(selected));
    setSelected(new Set());
  }

  async function handleSubmit(values: Record<string, unknown>) {
    setFormError(null); setFieldErrors({});
    try {
      if (editing) await update.mutateAsync({ id: editing.id, payload: values });
      else await create.mutateAsync(values);
      setModalOpen(false); setEditing(null);
    } catch (err) {
      const { message, fieldErrors } = parseApiError(err);
      setFormError(message); setFieldErrors(fieldErrors);
    }
  }

  function openEdit(p: PointNoir) { setEditing(p); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function openAdd() { setEditing(null); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  // ── Columns ─────────────────────────────────────────────────────────────────

  const columns: ColumnDef<PointNoir, unknown>[] = [
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row: { original: p } }) => {
        const truncated = p.description.length > 80
          ? p.description.slice(0, 80) + "…"
          : p.description;
        return (
          <span className="text-sm text-gray-800" title={p.description}>
            {truncated}
          </span>
        );
      },
    },
    {
      id: "region",
      header: "Région",
      cell: ({ row: { original: p } }) => (
        <span className="text-sm text-gray-600">{p.region?.nom ?? "—"}</span>
      ),
    },
    {
      id: "troncon",
      header: "Tronçon",
      cell: ({ row: { original: p } }) =>
        p.troncon
          ? <span className="text-sm font-semibold text-navy">{p.troncon.code}</span>
          : <span className="text-sm text-gray-300">—</span>,
    },
    {
      id: "pk",
      header: "PK",
      cell: ({ row: { original: p } }) =>
        p.pk != null
          ? <span className="text-sm text-gray-600">PK {p.pk}</span>
          : <span className="text-sm text-gray-300">—</span>,
    },
    {
      accessorKey: "gravite",
      header: "Gravité",
      cell: ({ row: { original: p } }) => <GraviteBadge gravite={p.gravite} />,
    },
    {
      accessorKey: "nbAccidents",
      header: "Accidents",
      cell: ({ row: { original: p } }) => {
        const colorClass =
          p.nbAccidents > 5 ? "text-red-600"
          : p.nbAccidents >= 1 ? "text-orange-500"
          : "text-gray-600";
        return (
          <span className={`text-sm font-bold ${colorClass}`}>
            {p.nbAccidents}
          </span>
        );
      },
    },
    {
      id: "row-actions",
      header: "",
      cell: ({ row: { original: p } }) => (
        <div className="flex items-center gap-1 justify-end">
          <button
            onClick={() => navigate(`/geoportail?select=pointNoir&id=${p.id}`)}
            title="Voir sur la carte"
            className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
          >
            <Map className="h-3.5 w-3.5" />
          </button>
          {canWrite(user?.role) && !archived && (
            <button
              onClick={() => openEdit(p)}
              title="Modifier"
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {canDelete(user?.role) && !archived && (
            <button
              onClick={async () => { if (await confirm("Archiver ce point noir ?", { danger: true })) remove.mutate(p.id); }}
              title="Archiver"
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
          {archived && canWrite(user?.role) && (
            <button
              onClick={() => bulkRestore.mutate([p.id])}
              title="Restaurer"
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setHistoryId(p.id)}
            title="Historique"
            className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
          >
            <Clock className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="h-8 w-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
          <AlertTriangle className="h-4 w-4 text-red-600" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Points Noirs</h1>
          <p className="text-xs text-gray-500">Zones dangereuses et accidentogènes du réseau</p>
        </div>
      </div>

      {/* Ligne 1 : recherche + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-grow min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <Input
            placeholder="Rechercher un point noir…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant={archived ? "secondary" : "ghost"}
            size="sm"
            onClick={() => { setArchived((a) => !a); setPage(1); setSelected(new Set()); }}
          >
            <Archive className="h-3.5 w-3.5 mr-1" />
            {archived ? "← Actifs" : "Voir les archivés"}
          </Button>
          {!archived && canWrite(user?.role) && (
            <Button onClick={openAdd}>
              <Plus className="h-4 w-4 mr-1" /> Ajouter
            </Button>
          )}
        </div>
      </div>

      {/* Ligne 2 : filtres */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterSelect value={regionFilter} onChange={(v) => { setRegionFilter(v); setPage(1); }}>
          <option value="">Toutes les régions</option>
          {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
        </FilterSelect>
        <FilterSelect value={graviteFilter} onChange={(v) => { setGraviteFilter(v); setPage(1); }}>
          <option value="">Toutes les gravités</option>
          <option value="FAIBLE">Faible</option>
          <option value="MOYENNE">Moyenne</option>
          <option value="FORTE">Forte</option>
        </FilterSelect>
      </div>

      {/* Ligne 3 : select-all + compteur */}
      <div className="flex items-center justify-between px-1">
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allOnPageSelected}
            onChange={toggleSelectAll}
            className="rounded border-gray-300 text-navy focus:ring-navy/30"
          />
          Tout sélectionner
        </label>
        <span className="text-sm text-gray-400">
          {(data?.total ?? 0).toLocaleString("fr-FR")} points noirs
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-navy/5 border border-navy/10 px-4 py-2">
          <span className="text-sm text-navy font-medium">{selected.size} point(s) noir(s) sélectionné(s)</span>
          <div className="flex gap-2">
            {archived ? (
              <Button variant="secondary" size="sm" onClick={handleBulkRestore} disabled={bulkRestore.isPending}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restaurer
              </Button>
            ) : (
              <Button variant="danger" size="sm" onClick={handleBulkArchive} disabled={bulkArchive.isPending}>
                <Archive className="h-3.5 w-3.5 mr-1" /> Archiver la sélection
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <DataTable<PointNoir>
        data={rows}
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
          else { setSortBy(key); setSortDir("asc"); }
        }}
        selectedIds={selected}
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
      />

      {/* CRUD Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Modifier — ${editing.description.slice(0, 40)}${editing.description.length > 40 ? "…" : ""}` : "Ajouter un point noir"}
      >
        <EntityForm
          fields={pointNoirFields}
          defaultValues={(editing ?? {}) as Record<string, unknown>}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {/* History Modal */}
      {historyId && (
        <AuditHistoryModal
          open={!!historyId}
          onClose={() => setHistoryId(null)}
          entityType="PointNoir"
          entityId={historyId}
          title="Point noir"
        />
      )}

      {confirmDialog}
    </div>
  );
}
