import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Map, ChevronDown, Plus, Archive, RotateCcw, Pencil, Clock, Search, Gauge } from "lucide-react";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { ImportExportBar } from "../components/ImportExportBar";
import { AuditHistoryModal } from "../components/AuditHistoryModal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useAuth, canWrite, canDelete } from "../lib/auth";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";
import { api } from "../lib/api";
import { posteFields } from "../lib/fieldConfigs";
import type { Poste, Region, TypePoste, StatutPoste } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_META: Record<TypePoste, { label: string; pill: string }> = {
  PEAGE:  { label: "Péage",   pill: "bg-blue-100 text-blue-700" },
  PESAGE: { label: "Pesage",  pill: "bg-purple-100 text-purple-700" },
};

const STATUT_META: Record<StatutPoste, { label: string; pill: string }> = {
  EN_SERVICE:      { label: "En service",      pill: "bg-green-100 text-green-700" },
  HORS_SERVICE:    { label: "Hors service",    pill: "bg-red-100 text-red-700" },
  EN_CONSTRUCTION: { label: "En construction", pill: "bg-amber-100 text-amber-700" },
};

// ── Sub-components ────────────────────────────────────────────────────────────

const TYPE_DOTS: Record<TypePoste, string> = {
  PEAGE:  "bg-blue-500",
  PESAGE: "bg-purple-500",
};

const STATUT_DOTS: Record<StatutPoste, string> = {
  EN_SERVICE:      "bg-green-500",
  HORS_SERVICE:    "bg-red-500",
  EN_CONSTRUCTION: "bg-amber-500",
};

function TypeBadge({ type }: { type: TypePoste }) {
  const m = TYPE_META[type];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOTS[type]}`} />
      {m.label}
    </span>
  );
}

function StatutBadge({ statut }: { statut: StatutPoste }) {
  const m = STATUT_META[statut];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUT_DOTS[statut]}`} />
      {m.label}
    </span>
  );
}

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

// ── Main ──────────────────────────────────────────────────────────────────────

export function PostesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [search, setSearch]           = useState("");
  const [regionFilter, setRegion]     = useState("");
  const [typeFilter, setType]         = useState("");
  const [statutFilter, setStatut]     = useState("");
  const [archived, setArchived]       = useState(false);
  const [page, setPage]               = useState(1);
  const [sortBy, setSortBy]           = useState("createdAt");
  const [sortDir, setSortDir]         = useState<"asc" | "desc">("desc");
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen]     = useState(false);
  const [editing, setEditing]         = useState<Poste | null>(null);
  const [formError, setFormError]     = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [historyId, setHistoryId]     = useState<string | null>(null);

  const { data, isLoading } = useEntityList<Poste>("postes", {
    page, pageSize: 20, search,
    region: regionFilter || undefined,
    type: typeFilter || undefined,
    // statut passé via type côté backend (filtre générique)
    archived,
    sortBy, sortDir,
  });

  const rows = useMemo(() => data?.data ?? [], [data?.data]);

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const { create, update, remove, bulkArchive, bulkRestore } = useEntityMutations("postes");

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleSelect(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleSelectAll() {
    const n = new Set(selected);
    allOnPageSelected ? rows.forEach((r) => n.delete(r.id)) : rows.forEach((r) => n.add(r.id));
    setSelected(n);
  }
  async function handleBulkArchive() {
    if (!(await confirm(`Archiver les ${selected.size} poste(s) ?`, { danger: true }))) return;
    await bulkArchive.mutateAsync(Array.from(selected));
    setSelected(new Set());
  }
  async function handleSubmit(values: Record<string, unknown>) {
    setFormError(null); setFieldErrors({});
    try {
      if (editing) await update.mutateAsync({ id: editing.id, payload: values });
      else await create.mutateAsync(values);
      setModalOpen(false); setEditing(null);
    } catch (err) {
      const { message, fieldErrors: fe } = parseApiError(err);
      setFormError(message); setFieldErrors(fe);
    }
  }
  function openEdit(p: Poste) { setEditing(p); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  // ── Columns ──────────────────────────────────────────────────────────────────

  const columns: ColumnDef<Poste, unknown>[] = [
    {
      id: "nom",
      header: "Nom",
      cell: ({ row: { original: p } }) => (
        <button
          onClick={() => openEdit(p)}
          className="text-sm font-bold text-navy hover:underline focus:outline-none"
        >
          {p.nom}
        </button>
      ),
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row: { original: p } }) => <TypeBadge type={p.type} />,
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
        p.troncon ? (
          <span className="text-sm font-medium text-navy">{p.troncon.code}</span>
        ) : (
          <span className="text-sm text-gray-300">—</span>
        ),
    },
    {
      accessorKey: "statut",
      header: "Statut",
      cell: ({ row: { original: p } }) => <StatutBadge statut={p.statut} />,
    },
    {
      accessorKey: "traficJma",
      header: () => <span className="block text-right w-full">Trafic (v/j)</span>,
      cell: ({ row: { original: p } }) => {
        if (p.traficJma == null) {
          return <span className="block text-right text-gray-300 pr-2">—</span>;
        }
        const colorCls =
          p.traficJma > 10000 ? "text-green-700" :
          p.traficJma < 1000  ? "text-orange-600" :
          "text-gray-700";
        return (
          <span className={`block text-right text-sm tabular-nums pr-2 ${colorCls}`}>
            {p.traficJma.toLocaleString("fr-FR")} v/j
          </span>
        );
      },
    },
    {
      id: "row-actions",
      header: "",
      cell: ({ row: { original: p } }) => (
        <div className="flex items-center gap-1 justify-end">
          {/* Carte */}
          <button
            onClick={() => navigate(`/geoportail?select=poste&id=${p.id}`)}
            className="flex flex-col items-center gap-0.5 text-gray-400 hover:text-navy group px-1"
            title="Voir sur la carte"
          >
            <Map className="h-4 w-4 group-hover:text-navy" />
            <span className="text-[10px] group-hover:text-navy">Carte</span>
          </button>
          {/* Modifier */}
          {canWrite(user?.role) && !archived && (
            <button
              onClick={() => openEdit(p)}
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
              title="Modifier"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Archiver */}
          {canDelete(user?.role) && !archived && (
            <button
              onClick={async () => {
                if (await confirm("Archiver ce poste ?", { danger: true })) remove.mutate(p.id);
              }}
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              title="Archiver"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Restaurer */}
          {archived && canWrite(user?.role) && (
            <button
              onClick={() => bulkRestore.mutate([p.id])}
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
              title="Restaurer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Historique */}
          <button
            onClick={() => setHistoryId(p.id)}
            className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
            title="Historique"
          >
            <Clock className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────────────────

  // Filtrage client du statut (si le backend ne supporte pas encore ce param)
  const filteredRows = statutFilter
    ? rows.filter((p) => p.statut === statutFilter)
    : rows;

  return (
    <div className="space-y-3">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="h-8 w-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
          <Gauge className="h-4 w-4 text-purple-600" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Postes de péage &amp; pesage</h1>
          <p className="text-xs text-gray-500">Gestion des points de contrôle routier</p>
        </div>
      </div>

      {/* Ligne 1 : recherche + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <Input
            placeholder="Rechercher un poste..."
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
            {archived ? "← Actifs" : "Voir archivés"}
          </Button>
          {!archived && <ImportExportBar endpoint="postes" filenamePrefix="postes" />}
          {!archived && canWrite(user?.role) && (
            <Button onClick={() => { setEditing(null); setFormError(null); setFieldErrors({}); setModalOpen(true); }}>
              <Plus className="h-4 w-4 mr-1" /> Ajouter
            </Button>
          )}
        </div>
      </div>

      {/* Ligne 2 : filtres horizontaux */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterSelect value={regionFilter} onChange={(v) => { setRegion(v); setPage(1); }}>
          <option value="">Toutes les régions</option>
          {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
        </FilterSelect>
        <FilterSelect value={typeFilter} onChange={(v) => { setType(v); setPage(1); }}>
          <option value="">Tous les types</option>
          <option value="PEAGE">Péage</option>
          <option value="PESAGE">Pesage</option>
        </FilterSelect>
        <FilterSelect value={statutFilter} onChange={(v) => { setStatut(v); setPage(1); }}>
          <option value="">Tous les statuts</option>
          <option value="EN_SERVICE">En service</option>
          <option value="HORS_SERVICE">Hors service</option>
          <option value="EN_CONSTRUCTION">En construction</option>
        </FilterSelect>
      </div>

      {/* Ligne 3 : select-all + total */}
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
          {(data?.total ?? 0).toLocaleString("fr-FR")} poste(s)
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-navy/5 border border-navy/10 px-4 py-2">
          <span className="text-sm text-navy font-medium">{selected.size} poste(s) sélectionné(s)</span>
          {archived ? (
            <Button variant="secondary" size="sm" onClick={() => { void bulkRestore.mutateAsync(Array.from(selected)); setSelected(new Set()); }}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restaurer
            </Button>
          ) : (
            <Button variant="danger" size="sm" onClick={handleBulkArchive} disabled={bulkArchive.isPending}>
              <Archive className="h-3.5 w-3.5 mr-1" /> Archiver la sélection
            </Button>
          )}
        </div>
      )}

      {/* Table */}
      <DataTable<Poste>
        data={filteredRows}
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

      {/* Modal formulaire */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Modifier — ${editing.nom}` : "Ajouter un poste"}
      >
        <EntityForm
          fields={posteFields}
          defaultValues={(editing ?? {}) as Record<string, unknown>}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {/* Modal historique */}
      {historyId && (
        <AuditHistoryModal
          open={!!historyId}
          onClose={() => setHistoryId(null)}
          entityType="Poste"
          entityId={historyId}
          title="Poste péage/pesage"
        />
      )}

      {confirmDialog}
    </div>
  );
}
