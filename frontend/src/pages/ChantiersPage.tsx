import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  HardHat, AlertTriangle, Ruler, CalendarX, Map, ClipboardList,
  Archive, RotateCcw, Plus, ChevronDown, Search,
} from "lucide-react";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { ImportExportBar } from "../components/ImportExportBar";
import { AuditHistoryModal } from "../components/AuditHistoryModal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, KpiCard } from "../components/ui/Card";
import { useAuth, canWrite, canDelete } from "../lib/auth";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";
import { api } from "../lib/api";
import { chantierFields } from "../lib/fieldConfigs";
import type { Chantier, Region } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date();

function isEnRetard(c: Chantier) {
  return c.statut === "EN_COURS" && !!c.dateFinPrevue && new Date(c.dateFinPrevue) < now;
}

function fmtEcheance(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
}

function fmtLineaire(c: Chantier): string {
  if (c.pkDebut != null && c.pkFin != null) {
    const km = Math.abs(c.pkFin - c.pkDebut);
    return km >= 1 ? `${km.toFixed(0)} km` : `${(km * 1000).toFixed(0)} m`;
  }
  return "—";
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUT_STYLES: Record<string, string> = {
  EN_COURS: "bg-blue-100 text-blue-700",
  PLANIFIE: "bg-gray-100 text-gray-600",
  SUSPENDU: "bg-orange-100 text-orange-700",
  TERMINE: "bg-green-100 text-green-700",
  EN_RETARD: "bg-red-100 text-red-700",
};
const STATUT_LABELS: Record<string, string> = {
  EN_COURS: "En cours", PLANIFIE: "Planifié", SUSPENDU: "Suspendu",
  TERMINE: "Terminé", EN_RETARD: "En retard",
};

const DOT_COLORS: Record<string, string> = {
  EN_COURS: "bg-blue-500",
  PLANIFIE: "bg-gray-400",
  SUSPENDU: "bg-orange-500",
  TERMINE: "bg-green-500",
  EN_RETARD: "bg-red-500",
};

function StatutPill({ chantier }: { chantier: Chantier }) {
  const key = isEnRetard(chantier) ? "EN_RETARD" : chantier.statut;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUT_STYLES[key] ?? "bg-gray-100 text-gray-600"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_COLORS[key] ?? "bg-gray-400"}`} />
      {STATUT_LABELS[key] ?? key}
    </span>
  );
}

function AvancementBar({ pct, enRetard }: { pct: number; enRetard: boolean }) {
  const color = enRetard ? "#dc2626" : pct >= 100 ? "#16a34a" : pct >= 50 ? "#1a2942" : "#9ca3af";
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs text-gray-500 w-9 text-right shrink-0">{pct}%</span>
    </div>
  );
}

// ── FilterSelect ─────────────────────────────────────────────────────────────

function FilterSelect({ value, onChange, children }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  const active = value !== "";
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none rounded-lg border px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20 transition-colors ${
          active
            ? "border-navy/40 bg-navy/5 text-navy font-medium"
            : "border-gray-200 bg-white text-gray-600"
        }`}
      >
        {children}
      </select>
      <ChevronDown className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 ${active ? "text-navy/60" : "text-gray-400"}`} />
    </div>
  );
}

// ── Stats hook ────────────────────────────────────────────────────────────────

function useChantierStats() {
  return useQuery({
    queryKey: ["chantiers", "stats"],
    queryFn: async () => (await api.get<{ total: number; enRetard: number; sansDates: number; linéaireTotalKm: number }>("/chantiers/stats")).data,
    staleTime: 30_000,
  });
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChantiersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Filters
  const [search, setSearch] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [statutFilter, setStatutFilter] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Modals
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Chantier | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [historyId, setHistoryId] = useState<string | null>(null);

  // Data
  const { data, isLoading } = useEntityList<Chantier>("chantiers", {
    page, pageSize: 20, search, region: regionFilter || undefined,
    etat: statutFilter || undefined, sortBy, sortDir, archived,
  });
  const { data: stats } = useChantierStats();
  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const { create, update, remove, bulkArchive, bulkRestore } = useEntityMutations("chantiers");

  // Selection helpers
  function toggleSelect(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleSelectAll() {
    const rows = data?.data ?? [];
    setSelected((prev) => {
      const allSel = rows.length > 0 && rows.every((r) => prev.has(r.id));
      const n = new Set(prev);
      allSel ? rows.forEach((r) => n.delete(r.id)) : rows.forEach((r) => n.add(r.id));
      return n;
    });
  }

  async function handleBulkArchive() {
    if (!(await confirm(`Archiver les ${selected.size} chantier(s) ?`, { danger: true }))) return;
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

  function openAdd() { setEditing(null); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function openEdit(c: Chantier) { setEditing(c); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  // ── Columns ─────────────────────────────────────────────────────────────────

  const columns: ColumnDef<Chantier, unknown>[] = [
    {
      accessorKey: "intitule",
      header: "Intitulé",
      cell: ({ row: { original: c } }) => (
        <div className="max-w-[200px]">
          <p className="truncate text-sm font-medium text-navy" title={c.intitule}>{c.intitule}</p>
          {c.troncon && <p className="text-[11px] text-gray-400 truncate">{(c.troncon as { code?: string }).code}</p>}
        </div>
      ),
    },
    {
      accessorKey: "region",
      header: "Région",
      cell: ({ row: { original: c } }) => (
        <span className="text-sm text-gray-600">{(c.region as { nom?: string } | undefined)?.nom ?? "—"}</span>
      ),
    },
    {
      id: "lineaire",
      header: "Linéaire",
      cell: ({ row: { original: c } }) => (
        <span className="text-sm text-gray-600 tabular-nums">{fmtLineaire(c)}</span>
      ),
    },
    {
      accessorKey: "statut",
      header: "Statut",
      cell: ({ row: { original: c } }) => <StatutPill chantier={c} />,
    },
    {
      accessorKey: "avancementPct",
      header: "Avancement",
      cell: ({ row: { original: c } }) => <AvancementBar pct={c.avancementPct} enRetard={isEnRetard(c)} />,
    },
    {
      id: "echeance",
      header: "Échéance",
      cell: ({ row: { original: c } }) => (
        <span className={`text-sm tabular-nums ${!c.dateFinPrevue ? "text-gray-300" : isEnRetard(c) ? "text-red-600 font-medium" : "text-gray-600"}`}>
          {fmtEcheance(c.dateFinPrevue)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row: { original: c } }) => (
        <div className="flex items-center gap-1 justify-end">
          <button
            title="Voir sur la carte"
            onClick={() => navigate(`/geoportail?select=chantier&id=${c.id}`)}
            className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
          >
            <Map className="h-3.5 w-3.5" />
          </button>
          {canWrite(user?.role) && !archived && (
            <button onClick={() => openEdit(c)} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors" title="Modifier">
              <ClipboardList className="h-3.5 w-3.5" />
            </button>
          )}
          {canDelete(user?.role) && !archived && (
            <button
              onClick={async () => { if (await confirm("Archiver ce chantier ?", { danger: true })) remove.mutate(c.id); }}
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="Archiver"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
          {archived && canWrite(user?.role) && (
            <button onClick={() => bulkRestore.mutate([c.id])} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors" title="Restaurer">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button onClick={() => setHistoryId(c.id)} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors" title="Historique">
            <span className="text-[10px]">⏱</span>
          </button>
        </div>
      ),
    },
  ];

  const enRetardCount = stats?.enRetard ?? 0;

  return (
    <div className="space-y-4">
      {/* ── Page header ── */}
      <div className="flex items-center gap-3 mb-2">
        <div className="h-8 w-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
          <HardHat className="h-4 w-4 text-amber-600" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Chantiers</h1>
          <p className="text-xs text-gray-500">Suivi des travaux routiers</p>
        </div>
      </div>

      {/* ── Header bar ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant={archived ? "secondary" : "ghost"}
            size="sm"
            onClick={() => { setArchived((a) => !a); setPage(1); setSelected(new Set()); }}
            className="flex items-center gap-1.5"
          >
            <Archive className="h-3.5 w-3.5" />
            {archived ? "← Actifs" : "Archivés"}
          </Button>
          {!archived && <ImportExportBar endpoint="chantiers" filenamePrefix="chantiers" />}
          {!archived && canWrite(user?.role) && (
            <Button
              onClick={openAdd}
              className="flex items-center gap-1.5 bg-gradient-to-r from-navy to-navy2 text-white hover:from-navy2 hover:to-navy shadow-sm shadow-navy/20"
            >
              <Plus className="h-4 w-4" /> Ajouter
            </Button>
          )}
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <Input
            placeholder="Rechercher un chantier…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        <FilterSelect value={regionFilter} onChange={(v) => { setRegionFilter(v); setPage(1); }}>
          <option value="">Toutes les régions</option>
          {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
        </FilterSelect>
        <FilterSelect value={statutFilter} onChange={(v) => { setStatutFilter(v); setPage(1); }}>
          <option value="">Tous les statuts</option>
          <option value="EN_COURS">En cours</option>
          <option value="EN_RETARD">En retard</option>
          <option value="PLANIFIE">Planifié</option>
          <option value="SUSPENDU">Suspendu</option>
          <option value="TERMINE">Terminé</option>
        </FilterSelect>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard
          label="Chantiers actifs"
          value={stats?.total ?? "—"}
          icon={<HardHat className="h-5 w-5" />}
          accent="#1a2942"
        />
        <Card className={`relative overflow-hidden p-4 transition-shadow hover:shadow-md ${enRetardCount > 0 ? "border-red-200 bg-red-50" : ""}`}>
          <span className="absolute inset-y-0 left-0 w-1 rounded-l-lg" style={{ backgroundColor: "#dc2626" }} />
          <div className="flex items-start justify-between gap-2 pl-1.5">
            <div className="min-w-0">
              <p className={`text-[11px] uppercase tracking-wide truncate ${enRetardCount > 0 ? "text-red-500" : "text-gray-400"}`}>
                En retard
              </p>
              <p className={`mt-1 text-2xl md:text-3xl font-bold leading-tight ${enRetardCount > 0 ? "text-red-600" : "text-gray-300"}`}>
                {stats?.enRetard ?? "—"}
              </p>
            </div>
            <span className={`shrink-0 flex items-center justify-center h-9 w-9 rounded-lg ${enRetardCount > 0 ? "bg-red-100 text-red-600" : "bg-gray-50 text-gray-300"}`}>
              <AlertTriangle className="h-5 w-5" />
            </span>
          </div>
        </Card>
        <KpiCard
          label="Linéaire total engagé"
          value={stats ? `${stats.linéaireTotalKm.toFixed(0)} km` : "—"}
          icon={<Ruler className="h-5 w-5" />}
          accent="#0891b2"
        />
        <KpiCard
          label="Sans dates renseignées"
          value={stats?.sansDates ?? "—"}
          icon={<CalendarX className="h-5 w-5" />}
          accent="#9ca3af"
          sub={stats?.sansDates ? "calcul retard impossible" : undefined}
        />
      </div>

      {/* ── Bulk action bar ── */}
      {selected.size > 0 && (
        <div className="rounded-xl bg-navy/5 border border-navy/15 px-4 py-2.5 flex items-center justify-between gap-3 mb-2">
          <span className="text-sm text-navy font-medium">{selected.size} chantier(s) sélectionné(s)</span>
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

      {/* ── Table ── */}
      <DataTable<Chantier>
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
          else { setSortBy(key); setSortDir("asc"); }
        }}
        selectedIds={selected}
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
      />

      {/* ── CRUD Modal ── */}
      <Modal open={modalOpen} onClose={closeModal} title={editing ? `Modifier — ${editing.intitule}` : "Ajouter un chantier"}>
        <EntityForm
          fields={chantierFields}
          defaultValues={(editing ?? {}) as Record<string, unknown>}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {/* ── History Modal ── */}
      {historyId && (
        <AuditHistoryModal
          open={!!historyId}
          onClose={() => setHistoryId(null)}
          entityType="Chantier"
          entityId={historyId}
          title="Chantier"
        />
      )}

      {confirmDialog}
    </div>
  );
}
