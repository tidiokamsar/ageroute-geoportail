import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { Camera, ChevronDown, Plus, Archive, RotateCcw, Pencil, Clock, Search, ClipboardList, Smartphone } from "lucide-react";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { AuditHistoryModal } from "../components/AuditHistoryModal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EtatBadge } from "../components/ui/Badge";
import { PhotoGallery } from "../components/PhotoGallery";
import { useAuth, canWrite, canDelete } from "../lib/auth";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";
import { inspectionFields } from "../lib/fieldConfigs";
import type { Inspection, EtatPatrimoine } from "../types";

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

// ── Main ──────────────────────────────────────────────────────────────────────

export function InspectionsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Filters
  const [search, setSearch]         = useState("");
  const [etatFilter, setEtatFilter] = useState("");
  const [archived, setArchived]     = useState(false);
  const [page, setPage]             = useState(1);
  const [sortBy, setSortBy]         = useState("dateInspection");
  const [sortDir, setSortDir]       = useState<"asc" | "desc">("desc");

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Modals
  const [modalOpen, setModalOpen]   = useState(false);
  const [editing, setEditing]       = useState<Inspection | null>(null);
  const [formError, setFormError]   = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [historyId, setHistoryId]   = useState<string | null>(null);
  const [photosInspection, setPhotosInspection] = useState<Inspection | null>(null);

  // Data
  const { data, isLoading } = useEntityList<Inspection>("inspections", {
    page, pageSize: 20, search,
    etat: etatFilter || undefined,
    sortBy, sortDir, archived,
  });

  const { create, update, remove, bulkArchive, bulkRestore } = useEntityMutations("inspections");

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
    if (!(await confirm(`Archiver les ${selected.size} inspection(s) ?`, { danger: true }))) return;
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

  function openEdit(i: Inspection) { setEditing(i); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function openAdd() { setEditing(null); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  // ── Columns ─────────────────────────────────────────────────────────────────

  const columns: ColumnDef<Inspection, unknown>[] = [
    {
      accessorKey: "dateInspection",
      header: "Date",
      cell: ({ row: { original: i } }) => (
        <span className="text-sm font-semibold text-navy">
          {new Date(i.dateInspection).toLocaleDateString("fr-FR")}
        </span>
      ),
    },
    {
      id: "objetInspecte",
      header: "Objet inspecté",
      cell: ({ row: { original: i } }) => {
        if (i.troncon) {
          return (
            <div className="min-w-0">
              <span className="text-sm font-semibold text-navy">{i.troncon.code}</span>
              <span className="ml-1.5 text-xs text-gray-400">{i.troncon.nom}</span>
            </div>
          );
        }
        if (i.ouvrage) {
          return (
            <div className="min-w-0 flex items-center gap-1.5">
              <span className="text-sm font-semibold text-gray-800">{i.ouvrage.nom}</span>
              <span className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                {i.ouvrage.type}
              </span>
            </div>
          );
        }
        return <span className="text-sm text-gray-300">—</span>;
      },
    },
    {
      id: "inspecteur",
      header: "Inspecteur",
      cell: ({ row: { original: i } }) => (
        <span className="text-sm text-gray-600">{i.inspecteur?.nomComplet ?? "—"}</span>
      ),
    },
    {
      accessorKey: "etatObserve",
      header: "État observé",
      cell: ({ row: { original: i } }) => <EtatBadge etat={i.etatObserve as EtatPatrimoine} />,
    },
    {
      id: "defauts",
      header: "Défauts",
      cell: ({ row: { original: i } }) => {
        if (!i.defautsConstates) return <span className="text-sm text-gray-300">—</span>;
        const truncated = i.defautsConstates.length > 60
          ? i.defautsConstates.slice(0, 60) + "…"
          : i.defautsConstates;
        return (
          <span className="text-sm text-gray-600" title={i.defautsConstates}>
            {truncated}
          </span>
        );
      },
    },
    {
      id: "row-actions",
      header: "",
      cell: ({ row: { original: i } }) => (
        <div className="flex items-center gap-1 justify-end">
          {canWrite(user?.role) && !archived && (
            <button
              onClick={() => openEdit(i)}
              title="Modifier"
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setPhotosInspection(i)}
            title="Photos"
            className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
          >
            <Camera className="h-3.5 w-3.5" />
          </button>
          {canDelete(user?.role) && !archived && (
            <button
              onClick={async () => { if (await confirm("Archiver cette inspection ?", { danger: true })) remove.mutate(i.id); }}
              title="Archiver"
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
          {archived && canWrite(user?.role) && (
            <button
              onClick={() => bulkRestore.mutate([i.id])}
              title="Restaurer"
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setHistoryId(i.id)}
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
        <div className="h-8 w-8 rounded-lg bg-teal-50 flex items-center justify-center shrink-0">
          <ClipboardList className="h-4 w-4 text-teal-600" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Inspections</h1>
          <p className="text-xs text-gray-500">Rapports d'inspection des tronçons et ouvrages</p>
        </div>
      </div>

      {/* Ligne 1 : recherche + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-grow min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <Input
            placeholder="Rechercher (tronçon, date)…"
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
            <Button variant="secondary" onClick={() => navigate("/inspections/terrain")}>
              <Smartphone className="h-4 w-4 mr-1" /> Mode terrain
            </Button>
          )}
          {!archived && canWrite(user?.role) && (
            <Button onClick={openAdd}>
              <Plus className="h-4 w-4 mr-1" /> Ajouter
            </Button>
          )}
        </div>
      </div>

      {/* Ligne 2 : filtres */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterSelect value={etatFilter} onChange={(v) => { setEtatFilter(v); setPage(1); }}>
          <option value="">Tous les états</option>
          <option value="BON">Bon</option>
          <option value="MOYEN">Moyen</option>
          <option value="MAUVAIS">Mauvais</option>
          <option value="CRITIQUE">Critique</option>
          <option value="NON_EVALUE">Non évalué</option>
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
          {(data?.total ?? 0).toLocaleString("fr-FR")} inspections
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-navy/5 border border-navy/10 px-4 py-2">
          <span className="text-sm text-navy font-medium">{selected.size} inspection(s) sélectionnée(s)</span>
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
      <DataTable<Inspection>
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
        title={editing ? `Modifier l'inspection du ${new Date(editing.dateInspection).toLocaleDateString("fr-FR")}` : "Ajouter une inspection"}
      >
        <EntityForm
          fields={inspectionFields}
          defaultValues={(editing ?? {}) as Record<string, unknown>}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {/* Photos Modal */}
      <Modal open={!!photosInspection} onClose={() => setPhotosInspection(null)} title="Photos d'inspection">
        {photosInspection && (
          <>
            <PhotoGallery endpoint="inspections" entityId={photosInspection.id} canWrite={canWrite(user?.role)} />
            <div className="flex justify-end mt-4 pt-3 border-t border-gray-100">
              <Button onClick={() => setPhotosInspection(null)}>Fermer</Button>
            </div>
          </>
        )}
      </Modal>

      {/* History Modal */}
      {historyId && (
        <AuditHistoryModal
          open={!!historyId}
          onClose={() => setHistoryId(null)}
          entityType="Inspection"
          entityId={historyId}
          title="Inspection"
        />
      )}

      {confirmDialog}
    </div>
  );
}
