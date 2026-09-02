import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronDown, Pencil, Archive, RotateCcw, Clock } from "lucide-react";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm, type FieldConfig } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { ImportExportBar } from "../components/ImportExportBar";
import { AuditHistoryModal } from "../components/AuditHistoryModal";
import { EntityDetailModal } from "../components/EntityDetailModal";
import { useAuth, canWrite, canDelete } from "../lib/auth";
import { parseApiError } from "../lib/errors";
import { useConfirm } from "../hooks/useConfirm";

// Composant dropdown filtre réutilisable (pattern TronconsPage)
export function FilterSelect({ value, onChange, children }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-lg border border-gray-200 bg-white px-3 py-1.5 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
    </div>
  );
}

interface Props<T extends { id: string }> {
  endpoint: string;
  title: string;
  columns: ColumnDef<T, unknown>[];
  fields: FieldConfig[];
  searchPlaceholder?: string;
  importExport?: boolean;
  /** Nom de l'entite cote audit_logs (ex "Troncon") pour afficher l'historique. */
  auditEntityType?: string;
  /** Boutons d'action supplementaires par ligne (ex "Fiche" pour les troncons, "Photos" pour les ouvrages). */
  rowExtraActions?: { label: string; onClick: (row: T) => void }[];
  /** JSX de filtres horizontaux à afficher en ligne 2 sous la barre de recherche.
   *  L'état des filtres appartient à la page appelante ; voir extraParams. */
  filters?: React.ReactNode;
  /** Paramètres de requête supplémentaires (filtres serveur : region, type, …).
   *  Le retour à la page 1 est automatique quand ces paramètres changent. */
  extraParams?: Record<string, string | undefined>;
  /** Filtre CLIENT appliqué aux lignes affichées (parité avec les pages
   *  historiques — attention : la pagination reste celle du serveur). */
  rowFilter?: (row: T) => boolean;
  /** En-tête de page : icône et sous-titre optionnels (parité visuelle). */
  pageIcon?: React.ReactNode;
  subtitle?: string;
}

export function EntityListPage<T extends { id: string }>({ endpoint, title, columns, fields, searchPlaceholder, importExport, auditEntityType, rowExtraActions, filters, extraParams, rowFilter, pageIcon, subtitle }: Props<T>) {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  // P3-B : la modale de saisie prévient avant de perdre des modifications.
  const [formDirty, setFormDirty] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [viewingRow, setViewingRow] = useState<T | null>(null);

  const { data, isLoading } = useEntityList<T>(endpoint, { page, pageSize: 20, search, sortBy, sortDir, archived, ...extraParams });

  // Un changement de filtre serveur rend la page courante probablement vide :
  // retour systematique a la premiere page (parite avec les pages historiques).
  const cleFiltres = JSON.stringify(extraParams ?? {});
  const pageRef = useRef(page);
  useEffect(() => {
    if (pageRef.current !== 1) setPage(1);
    pageRef.current = 1;
  }, [cleFiltres]);
  const { create, update, remove, bulkArchive, bulkRestore } = useEntityMutations(endpoint);
  const { confirm, dialog: confirmDialog } = useConfirm();

  function toggleArchivedView() {
    setArchived((a) => !a);
    setPage(1);
    setSelected(new Set());
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const rows = data?.data ?? [];
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((r) => prev.has(r.id));
      if (allSelected) {
        const next = new Set(prev);
        rows.forEach((r) => next.delete(r.id));
        return next;
      }
      const next = new Set(prev);
      rows.forEach((r) => next.add(r.id));
      return next;
    });
  }

  async function handleBulkArchive() {
    if (!(await confirm(`Archiver les ${selected.size} élément(s) sélectionné(s) ?`, { danger: true }))) return;
    await bulkArchive.mutateAsync(Array.from(selected));
    setSelected(new Set());
  }

  async function handleBulkRestore() {
    await bulkRestore.mutateAsync(Array.from(selected));
    setSelected(new Set());
  }

  const rows = rowFilter ? (data?.data ?? []).filter(rowFilter) : (data?.data ?? []);
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const actionColumn: ColumnDef<T, unknown> = {
    id: "actions",
    header: "",
    cell: ({ row }) =>
      archived ? (
        canWrite(user?.role) && (
          <div className="flex items-center gap-1 justify-end">
            <button
              onClick={() => bulkRestore.mutate([row.original.id])}
              title="Restaurer"
              className="p-1.5 rounded text-gray-400 hover:text-green-600 hover:bg-green-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      ) : (
        <div className="flex items-center gap-1 justify-end">
          {canWrite(user?.role) && (
            <button
              title="Modifier"
              className="p-1.5 rounded text-gray-400 hover:text-navy hover:bg-gray-100"
              onClick={() => {
                setEditing(row.original);
                setFormError(null);
                setFieldErrors({});
                setModalOpen(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {canDelete(user?.role) && (
            <button
              title="Archiver"
              className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"
              onClick={async () => {
                if (await confirm("Archiver cet élément ?", { danger: true })) remove.mutate(row.original.id);
              }}
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
          {rowExtraActions?.map((action) => (
            <button
              key={action.label}
              className="px-2 py-1 rounded text-xs text-gray-400 hover:text-navy hover:bg-gray-100"
              onClick={() => action.onClick(row.original)}
            >
              {action.label}
            </button>
          ))}
          {auditEntityType && (
            <button
              title="Historique"
              className="p-1.5 rounded text-gray-400 hover:text-navy hover:bg-gray-100"
              onClick={() => setHistoryId(row.original.id)}
            >
              <Clock className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ),
  };

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setFormError(null);
    setFieldErrors({});
  }

  async function handleSubmit(values: Record<string, unknown>) {
    setFormError(null);
    setFieldErrors({});
    try {
      if (editing) await update.mutateAsync({ id: editing.id, payload: values });
      else await create.mutateAsync(values);
      setModalOpen(false);
      setEditing(null);
    } catch (err) {
      const { message, fieldErrors } = parseApiError(err);
      setFormError(message);
      setFieldErrors(fieldErrors);
    }
  }

  return (
    <div className="space-y-3">
      {/* En-tête de page (parité visuelle avec les pages historiques) */}
      {(pageIcon || subtitle) && (
        <div className="flex items-center gap-3 mb-2">
          {pageIcon && <div className="h-8 w-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">{pageIcon}</div>}
          <div>
            <h1 className="text-base font-bold text-navy">{title}</h1>
            {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
          </div>
        </div>
      )}
      {/* Ligne 1 : recherche + actions droite */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder={searchPlaceholder ?? "Rechercher..."}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="flex-1 min-w-[220px] max-w-sm"
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button variant={archived ? "secondary" : "ghost"} size="sm" onClick={toggleArchivedView}>
            <Archive className="h-3.5 w-3.5 mr-1" />
            {archived ? "← Actifs" : "Voir les archivés"}
          </Button>
          {importExport && !archived && <ImportExportBar endpoint={endpoint} filenamePrefix={endpoint} />}
          {!archived && canWrite(user?.role) && (
            <Button
              onClick={() => {
                setEditing(null);
                setFormError(null);
                setFieldErrors({});
                setModalOpen(true);
              }}
            >
              + Ajouter
            </Button>
          )}
        </div>
      </div>

      {/* Ligne 2 : filtres horizontaux (optionnels) */}
      {filters && (
        <div className="flex items-center gap-2 flex-wrap">
          {filters}
        </div>
      )}

      {/* Ligne 3 : Tout sélectionner + count */}
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
          {(data?.total ?? 0).toLocaleString("fr-FR")} élément{(data?.total ?? 0) !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-navy/5 border border-navy/10 px-4 py-2">
          <span className="text-sm text-navy font-medium">{selected.size} élément(s) sélectionné(s)</span>
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
      )}

      <DataTable
        data={data?.data ?? []}
        columns={[...columns, actionColumn]}
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
        selectedIds={selected}
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
        onRowClick={(row) => setViewingRow(row)}
      />

      <Modal open={modalOpen} onClose={closeModal} title={editing ? `Modifier — ${title}` : `Ajouter — ${title}`} sale={() => formDirty}>
        <EntityForm
          fields={fields}
          defaultValues={editing ?? {}}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
          onDirtyChange={setFormDirty}
        />
      </Modal>

      {viewingRow && (
        <EntityDetailModal
          open={!!viewingRow}
          onClose={() => setViewingRow(null)}
          title={`${title} — détail`}
          row={viewingRow}
          columns={columns}
          actions={[
            ...(canWrite(user?.role) && !archived
              ? [
                  {
                    label: "Modifier",
                    onClick: () => {
                      setEditing(viewingRow);
                      setFormError(null);
                      setFieldErrors({});
                      setModalOpen(true);
                      setViewingRow(null);
                    },
                  },
                ]
              : []),
            ...(canDelete(user?.role) && !archived
              ? [
                  {
                    label: "Archiver",
                    variant: "danger" as const,
                    onClick: async () => {
                      if (await confirm("Archiver cet élément ?", { danger: true })) {
                        remove.mutate(viewingRow.id);
                        setViewingRow(null);
                      }
                    },
                  },
                ]
              : []),
            ...(canWrite(user?.role) && archived
              ? [
                  {
                    label: "Restaurer",
                    variant: "secondary" as const,
                    onClick: () => {
                      bulkRestore.mutate([viewingRow.id]);
                      setViewingRow(null);
                    },
                  },
                ]
              : []),
            ...(rowExtraActions ?? []).map((action) => ({
              label: action.label,
              onClick: () => { action.onClick(viewingRow); setViewingRow(null); },
            })),
            ...(auditEntityType
              ? [{ label: "Historique", onClick: () => { setHistoryId(viewingRow.id); setViewingRow(null); } }]
              : []),
          ]}
        />
      )}

      {auditEntityType && historyId && (
        <AuditHistoryModal
          open={!!historyId}
          onClose={() => setHistoryId(null)}
          entityType={auditEntityType}
          entityId={historyId}
          title={title}
        />
      )}
      {confirmDialog}
    </div>
  );
}
