import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Map, Camera, ChevronDown, ImageOff, Plus, Archive, RotateCcw, Pencil, Clock, Search, Landmark } from "lucide-react";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { ImportExportBar } from "../components/ImportExportBar";
import { AuditHistoryModal } from "../components/AuditHistoryModal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EtatBadge } from "../components/ui/Badge";
import { PhotoGallery } from "../components/PhotoGallery";
import { useAuth, canWrite, canDelete } from "../lib/auth";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";
import { api } from "../lib/api";
import { ouvrageFields } from "../lib/fieldConfigs";
import type { Ouvrage, Region, TypeOuvrage, EtatPatrimoine } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_META: Record<TypeOuvrage, { label: string; pill: string }> = {
  PONT:            { label: "Pont",             pill: "bg-blue-100 text-blue-700" },
  DALOT:           { label: "Dalot",            pill: "bg-teal-100 text-teal-700" },
  BUSE:            { label: "Buse",             pill: "bg-teal-100 text-teal-700" },
  RADIER:          { label: "Radier",           pill: "bg-teal-100 text-teal-700" },
  PONCEAU:         { label: "Ponceau",          pill: "bg-teal-100 text-teal-700" },
  MUR_SOUTENEMENT: { label: "Mur soutènement",  pill: "bg-purple-100 text-purple-700" },
  TUNNEL:          { label: "Tunnel",           pill: "bg-purple-100 text-purple-700" },
  PASSERELLE:      { label: "Passerelle",       pill: "bg-purple-100 text-purple-700" },
  VIADUC:          { label: "Viaduc",           pill: "bg-purple-100 text-purple-700" },
};

const TYPE_DOTS: Record<TypeOuvrage, string> = {
  PONT:            "bg-blue-500",
  DALOT:           "bg-teal-500",
  BUSE:            "bg-teal-500",
  RADIER:          "bg-teal-500",
  PONCEAU:         "bg-teal-500",
  MUR_SOUTENEMENT: "bg-purple-500",
  TUNNEL:          "bg-purple-500",
  PASSERELLE:      "bg-purple-500",
  VIADUC:          "bg-purple-500",
};

// ── Sub-components ────────────────────────────────────────────────────────────

// Vignette de la première photo (authentifiée via Bearer, même mécanisme que PhotoGallery)
function ThumbCell({ photos }: { photos?: string[] | null }) {
  const filename = photos?.[0];
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!filename) return;
    let url: string | null = null;
    api.get(`/photos/${filename}`, { responseType: "blob" }).then((res) => {
      url = URL.createObjectURL(res.data as Blob);
      setSrc(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [filename]);

  if (!filename) {
    return (
      <div className="h-9 w-9 rounded-md bg-gray-100 flex items-center justify-center text-gray-300">
        <ImageOff className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className="h-9 w-9 rounded-md overflow-hidden bg-gray-100 border border-gray-200">
      {src && <img src={src} alt="" className="w-full h-full object-cover" />}
    </div>
  );
}

function TypeBadge({ type }: { type: TypeOuvrage }) {
  const m = TYPE_META[type];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOTS[type]}`} />
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

export function OuvragesPage() {
  const { user } = useAuth();
  const navigate  = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [search, setSearch]         = useState("");
  const [regionFilter, setRegion]   = useState("");
  const [typeFilter, setType]       = useState("");
  const [etatFilter, setEtat]       = useState("");
  const [archived, setArchived]     = useState(false);
  const [page, setPage]             = useState(1);
  const [sortBy, setSortBy]         = useState("createdAt");
  const [sortDir, setSortDir]       = useState<"asc" | "desc">("desc");
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen]   = useState(false);
  const [editing, setEditing]       = useState<Ouvrage | null>(null);
  const [formError, setFormError]   = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [photosOuvrage, setPhotosOuvrage] = useState<Ouvrage | null>(null);
  const [historyId, setHistoryId]   = useState<string | null>(null);

  const { data, isLoading } = useEntityList<Ouvrage>("ouvrages", {
    page, pageSize: 20, search,
    region: regionFilter || undefined,
    etat: etatFilter || undefined,
    type: typeFilter || undefined,
    sortBy, sortDir, archived,
  });

  const rows = useMemo(() => data?.data ?? [], [data?.data]);

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const { create, update, remove, bulkArchive, bulkRestore } = useEntityMutations("ouvrages");

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
    if (!(await confirm(`Archiver les ${selected.size} ouvrage(s) ?`, { danger: true }))) return;
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
      const { message, fieldErrors } = parseApiError(err);
      setFormError(message); setFieldErrors(fieldErrors);
    }
  }
  function openEdit(o: Ouvrage) { setEditing(o); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  // ── Columns ──────────────────────────────────────────────────────────────────

  const columns: ColumnDef<Ouvrage, unknown>[] = [
    {
      id: "photo",
      header: "",
      cell: ({ row: { original: o } }) => <ThumbCell photos={o.photos} />,
    },
    {
      id: "code_nom",
      header: "Code / Nom",
      cell: ({ row: { original: o } }) => (
        <div className="min-w-0">
          {o.code ? (
            <>
              <button
                onClick={() => openEdit(o)}
                className="text-sm font-bold text-navy hover:underline focus:outline-none leading-tight block"
              >
                {o.code}
              </button>
              <span className="text-xs text-gray-500 leading-tight block">{o.nom}</span>
            </>
          ) : (
            <span className="text-sm font-semibold text-gray-800">{o.nom}</span>
          )}
        </div>
      ),
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row: { original: o } }) => <TypeBadge type={o.type} />,
    },
    {
      id: "region",
      header: "Région",
      cell: ({ row: { original: o } }) => (
        <span className="text-sm text-gray-600">{o.region?.nom ?? "—"}</span>
      ),
    },
    {
      id: "troncon",
      header: "Tronçon",
      cell: ({ row: { original: o } }) =>
        o.troncon ? (
          <button
            onClick={() => navigate(`/geoportail?select=ouvrage&id=${o.id}`)}
            className="text-sm font-medium text-navy hover:underline focus:outline-none"
          >
            {o.troncon.code}
          </button>
        ) : (
          <span className="text-sm text-gray-300">—</span>
        ),
    },
    {
      id: "pk",
      header: "PK",
      cell: ({ row: { original: o } }) =>
        o.pk != null ? (
          <span className="text-xs font-mono text-gray-600 whitespace-nowrap tabular-nums">PK {o.pk}</span>
        ) : (
          <span className="text-sm text-gray-300">—</span>
        ),
    },
    {
      accessorKey: "longueurM",
      header: () => <span className="block text-right w-full">Longueur</span>,
      cell: ({ row: { original: o } }) => (
        <span className="block text-right text-sm text-gray-600 tabular-nums pr-2">
          {o.longueurM != null ? `${o.longueurM} m` : <span className="text-gray-300">—</span>}
        </span>
      ),
    },
    {
      accessorKey: "anneeConstruction",
      header: "Année",
      cell: ({ row: { original: o } }) => (
        <span className="text-sm text-gray-600">
          {o.anneeConstruction ?? <span className="text-gray-300">—</span>}
        </span>
      ),
    },
    {
      accessorKey: "etat",
      header: "État",
      cell: ({ row: { original: o } }) => <EtatBadge etat={o.etat as EtatPatrimoine} />,
    },
    {
      id: "row-actions",
      header: "",
      cell: ({ row: { original: o } }) => (
        <div className="flex items-center gap-1 justify-end">
          {/* Carte */}
          <button
            onClick={() => navigate(`/geoportail?select=ouvrage&id=${o.id}`)}
            className="flex flex-col items-center gap-0.5 text-gray-400 hover:text-navy group px-1"
            title="Voir sur la carte"
          >
            <Map className="h-4 w-4 group-hover:text-navy" />
            <span className="text-[10px] group-hover:text-navy">Carte</span>
          </button>
          {/* Photos */}
          <button
            onClick={() => setPhotosOuvrage(o)}
            className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 transition-colors"
            title="Photos"
          >
            <Camera className="h-4 w-4" />
          </button>
          {/* Modifier */}
          {canWrite(user?.role) && !archived && (
            <button
              onClick={() => openEdit(o)}
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
                if (await confirm("Archiver cet ouvrage ?", { danger: true })) remove.mutate(o.id);
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
              onClick={() => bulkRestore.mutate([o.id])}
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
              title="Restaurer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Historique */}
          <button
            onClick={() => setHistoryId(o.id)}
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

  return (
    <div className="space-y-3">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="h-8 w-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <Landmark className="h-4 w-4 text-blue-600" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Ouvrages d'art</h1>
          <p className="text-xs text-gray-500">Ponts, dalots, buses et ouvrages hydrauliques</p>
        </div>
      </div>

      {/* Ligne 1 : recherche + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <Input
            placeholder="Rechercher un ouvrage (nom, code)..."
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
          {!archived && <ImportExportBar endpoint="ouvrages" filenamePrefix="ouvrages" />}
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
          <option value="PONT">Pont</option>
          <option value="DALOT">Dalot</option>
          <option value="BUSE">Buse</option>
          <option value="RADIER">Radier</option>
          <option value="PONCEAU">Ponceau</option>
          <option value="MUR_SOUTENEMENT">Mur soutènement</option>
          <option value="TUNNEL">Tunnel</option>
          <option value="PASSERELLE">Passerelle</option>
          <option value="VIADUC">Viaduc</option>
        </FilterSelect>
        <FilterSelect value={etatFilter} onChange={(v) => { setEtat(v); setPage(1); }}>
          <option value="">Tous les états</option>
          <option value="BON">Bon</option>
          <option value="MOYEN">Moyen</option>
          <option value="MAUVAIS">Mauvais</option>
          <option value="CRITIQUE">Critique</option>
          <option value="NON_EVALUE">Non évalué</option>
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
          {(data?.total ?? 0).toLocaleString("fr-FR")} ouvrages
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-navy/5 border border-navy/10 px-4 py-2">
          <span className="text-sm text-navy font-medium">{selected.size} ouvrage(s) sélectionné(s)</span>
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
      <DataTable<Ouvrage>
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

      {/* Modal formulaire */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Modifier — ${editing.code ?? editing.nom}` : "Ajouter un ouvrage d'art"}
      >
        <EntityForm
          fields={ouvrageFields}
          defaultValues={(editing ?? {}) as Record<string, unknown>}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {/* Modal photos */}
      <Modal
        open={!!photosOuvrage}
        onClose={() => setPhotosOuvrage(null)}
        title={`Photos — ${photosOuvrage?.code ? `${photosOuvrage.code} · ` : ""}${photosOuvrage?.nom ?? ""}`}
      >
        {photosOuvrage && (
          <>
            <PhotoGallery endpoint="ouvrages" entityId={photosOuvrage.id} canWrite={canWrite(user?.role)} />
            <div className="flex justify-end mt-4 pt-3 border-t border-gray-100">
              <Button onClick={() => setPhotosOuvrage(null)}>Fermer</Button>
            </div>
          </>
        )}
      </Modal>

      {/* Modal historique */}
      {historyId && (
        <AuditHistoryModal
          open={!!historyId}
          onClose={() => setHistoryId(null)}
          entityType="Ouvrage"
          entityId={historyId}
          title="Ouvrage d'art"
        />
      )}

      {confirmDialog}
    </div>
  );
}
