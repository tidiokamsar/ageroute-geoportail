import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Map, AlertTriangle, Plus, Archive, RotateCcw, ChevronDown, Search, Route } from "lucide-react";
import { useEntityList, useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { ImportExportBar } from "../components/ImportExportBar";
import { AuditHistoryModal } from "../components/AuditHistoryModal";
import { TronconFicheModal } from "../components/TronconFicheModal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EtatBadge } from "../components/ui/Badge";
import { useAuth, canWrite, canDelete } from "../lib/auth";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";
import { api } from "../lib/api";
import { tronconFields } from "../lib/fieldConfigs";
import type { Troncon, Region, ClasseRoute, EtatPatrimoine } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTechnicalCode(code: string): boolean {
  return /^[wnrWNR]\d{5,}$/.test(code) || /^\d{6,}$/.test(code);
}

function axisCode(code: string): string {
  const m = code.match(/^([A-Z]{1,3}[-_.]\d{3})/i);
  return m ? m[1] : code;
}

const CLASSE_META: Record<ClasseRoute, { short: string; label: string; pill: string }> = {
  RN:    { short: "RN", label: "Route nationale",    pill: "bg-slate-100 text-slate-700" },
  RR:    { short: "RP", label: "Route préfectorale", pill: "bg-blue-100 text-blue-700" },
  RU:    { short: "VU", label: "Voirie urbaine",     pill: "bg-teal-100 text-teal-700" },
  PISTE: { short: "PR", label: "Piste rurale",       pill: "bg-amber-100 text-amber-700" },
};

const REVETEMENT_LABELS: Record<string, string> = {
  BITUME: "Bitume", TERRE: "Terre", LATERITE: "Latérite", PAVE: "Pavé",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ClassePill({ classe }: { classe: ClasseRoute }) {
  const m = CLASSE_META[classe];
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${m.pill}`}>
      {m.short}
    </span>
  );
}

function CodeCell({ code, onOpen }: { code: string; onOpen: () => void }) {
  const isTech = isTechnicalCode(code);
  return (
    <div className="min-w-0">
      <button
        onClick={onOpen}
        className={`text-left font-mono leading-tight hover:underline focus:outline-none ${
          isTech
            ? "text-[11px] text-gray-400"
            : "text-sm font-semibold text-navy"
        }`}
      >
        {isTech ? `réf. import: ${code}` : code}
      </button>
    </div>
  );
}

function NomCell({ nom, segmentCount }: { nom: string; segmentCount: number }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-gray-800 leading-tight">{nom}</p>
      {segmentCount > 1 && (
        <span className="inline-flex items-center text-[10px] bg-indigo-50 text-indigo-600 rounded px-1.5 py-0.5 mt-0.5 font-medium">
          segment
        </span>
      )}
    </div>
  );
}

// PK notation métier francophone : 1+400 = km 1, m 400
function fmtPk(v: number): string {
  const km = Math.floor(v);
  const m = Math.round((v - km) * 1000);
  return `${km}+${String(m).padStart(3, "0")}`;
}

function PkCell({ pkDebut, pkFin, onEdit, canEdit }: {
  pkDebut: number; pkFin: number; onEdit: () => void; canEdit: boolean;
}) {
  if (pkDebut === 0 && pkFin === 0) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-orange-500 font-medium whitespace-nowrap">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        Non renseigné
        {canEdit && (
          <button onClick={onEdit} className="underline text-orange-600 hover:text-orange-800 ml-0.5">
            Renseigner
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="text-xs font-mono text-gray-600 whitespace-nowrap tabular-nums">
      {fmtPk(pkDebut)} → {fmtPk(pkFin)}
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

function ClasseLegend({ missingPk, total, onFilterMissing }: {
  missingPk: number; total: number; onFilterMissing: () => void;
}) {
  return (
    <div className="space-y-1 pt-1">
      <div className="mt-3 flex flex-wrap gap-2 items-center text-xs text-gray-500">
        {(Object.entries(CLASSE_META) as [ClasseRoute, typeof CLASSE_META[ClasseRoute]][]).map(([, m]) => (
          <span key={m.short} className="flex items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${m.pill}`}>{m.short}</span>
            <span>{m.label}</span>
          </span>
        ))}
      </div>
      {missingPk > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-orange-500">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          PK non renseigné sur {missingPk} des {total} tronçons affichés —{" "}
          <button onClick={onFilterMissing} className="underline hover:text-orange-700 font-medium">
            Voir uniquement ces {missingPk} tronçons
          </button>
        </p>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function TronconsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [search, setSearch]       = useState("");
  const [regionFilter, setRegion] = useState("");
  const [classeFilter, setClasse] = useState("");
  const [etatFilter, setEtat]     = useState("");
  const [archived, setArchived]   = useState(false);
  const [page, setPage]           = useState(1);
  const [sortBy, setSortBy]       = useState("createdAt");
  const [sortDir, setSortDir]     = useState<"asc" | "desc">("desc");
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing]     = useState<Troncon | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [historyId, setHistoryId]     = useState<string | null>(null);
  const [ficheId, setFicheId]         = useState<string | null>(null);
  const [pkManquantOnly, setPkManquant] = useState(false);

  const { data, isLoading } = useEntityList<Troncon>("troncons", {
    page, pageSize: 20, search,
    region: regionFilter || undefined,
    etat: etatFilter || undefined,
    type: classeFilter || undefined,
    sortBy, sortDir, archived,
  });

  // Filtre PK manquant appliqué côté client sur la page courante
  // (évite un aller-retour serveur pour un cas simple — la page est déjà chargée)
  const rows = useMemo(() => {
    const all = data?.data ?? [];
    return pkManquantOnly ? all.filter((t) => t.pkDebut === 0 && t.pkFin === 0) : all;
  }, [data?.data, pkManquantOnly]);

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const { create, update, remove, bulkArchive, bulkRestore } = useEntityMutations("troncons");

  // Segment counts per code (business codes only)
  const segmentCounts = useMemo(() => {
    const axisCounts: Record<string, number> = {};
    rows.forEach((t) => {
      if (!isTechnicalCode(t.code)) {
        const ax = axisCode(t.code);
        axisCounts[ax] = (axisCounts[ax] ?? 0) + 1;
      }
    });
    const result: Record<string, number> = {};
    rows.forEach((t) => { result[t.code] = axisCounts[axisCode(t.code)] ?? 1; });
    return result;
  }, [rows]);

  // Top axis for the stats line
  const topAxis = useMemo(() => {
    const axisCounts: Record<string, number> = {};
    rows.forEach((t) => {
      if (!isTechnicalCode(t.code)) {
        const ax = axisCode(t.code);
        axisCounts[ax] = (axisCounts[ax] ?? 0) + 1;
      }
    });
    const top = Object.entries(axisCounts).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] > 1 ? { axis: top[0], count: top[1] } : null;
  }, [rows]);

  // Missing PK count for the legend
  const missingPkCount = useMemo(
    () => rows.filter((t) => t.pkDebut === 0 && t.pkFin === 0).length,
    [rows],
  );

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
    if (!(await confirm(`Archiver les ${selected.size} tronçon(s) ?`, { danger: true }))) return;
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
  function openEdit(t: Troncon) { setEditing(t); setFormError(null); setFieldErrors({}); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditing(null); }

  // ── Columns ──────────────────────────────────────────────────────────────────

  const columns: ColumnDef<Troncon, unknown>[] = [
    {
      accessorKey: "code",
      header: "Code",
      cell: ({ row: { original: t } }) => <CodeCell code={t.code} onOpen={() => setFicheId(t.id)} />,
    },
    {
      accessorKey: "nom",
      header: "Nom",
      cell: ({ row: { original: t } }) => (
        <NomCell nom={t.nom} segmentCount={segmentCounts[t.code] ?? 1} />
      ),
    },
    {
      accessorKey: "classe",
      header: "Classe",
      cell: ({ row: { original: t } }) => <ClassePill classe={t.classe} />,
    },
    {
      accessorKey: "region",
      header: "Région",
      cell: ({ row: { original: t } }) => (
        <span className="text-sm text-gray-600">{(t.region as { nom?: string } | undefined)?.nom ?? "—"}</span>
      ),
    },
    {
      accessorKey: "longueurKm",
      header: () => <span className="block text-right w-full">Longueur</span>,
      cell: ({ row: { original: t } }) => (
        <span className="block text-right text-sm text-gray-600 tabular-nums pr-2">{t.longueurKm.toFixed(1)} km</span>
      ),
    },
    {
      id: "pk",
      header: "PK début → fin",
      cell: ({ row: { original: t } }) => (
        <PkCell
          pkDebut={t.pkDebut}
          pkFin={t.pkFin}
          canEdit={!!canWrite(user?.role)}
          onEdit={() => openEdit(t)}
        />
      ),
    },
    {
      accessorKey: "revetement",
      header: "Revêtement",
      cell: ({ row: { original: t } }) => (
        <span className="text-xs text-gray-500">{REVETEMENT_LABELS[t.revetement] ?? t.revetement}</span>
      ),
    },
    {
      accessorKey: "etat",
      header: "État",
      cell: ({ row: { original: t } }) => <EtatBadge etat={t.etat as EtatPatrimoine} />,
    },
    {
      id: "carte",
      header: "Carte",
      cell: ({ row: { original: t } }) => (
        <button
          onClick={() => navigate(`/geoportail?select=troncon&id=${t.id}`)}
          className="flex flex-col items-center gap-0.5 text-gray-400 hover:text-navy group"
          title="Voir sur la carte"
        >
          <Map className="h-4 w-4 group-hover:text-navy" />
          <span className="text-[10px] group-hover:text-navy">Voir</span>
        </button>
      ),
    },
    {
      id: "row-actions",
      header: "",
      cell: ({ row: { original: t } }) => (
        <div className="flex items-center gap-1 justify-end">
          <button onClick={() => setFicheId(t.id)} className="px-2 py-1 rounded text-xs text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors">
            Fiche
          </button>
          {canWrite(user?.role) && !archived && (
            <button onClick={() => openEdit(t)} className="px-2 py-1 rounded text-xs text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors">
              Modifier
            </button>
          )}
          {canDelete(user?.role) && !archived && (
            <button
              onClick={async () => { if (await confirm("Archiver ce tronçon ?", { danger: true })) remove.mutate(t.id); }}
              className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
          {archived && canWrite(user?.role) && (
            <button onClick={() => bulkRestore.mutate([t.id])} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button onClick={() => setHistoryId(t.id)} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors text-xs" title="Historique">
            ⏱
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
        <div className="h-8 w-8 rounded-lg bg-navy/10 flex items-center justify-center shrink-0">
          <Route className="h-4 w-4 text-navy" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Tronçons</h1>
          <p className="text-xs text-gray-500">Gestion du réseau routier</p>
        </div>
      </div>

      {/* Ligne 1 : recherche + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <Input
            placeholder="Rechercher un tronçon (code, nom)…"
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
          {!archived && <ImportExportBar endpoint="troncons" filenamePrefix="troncons" />}
          {!archived && canWrite(user?.role) && (
            <Button
              onClick={() => { setEditing(null); setFormError(null); setFieldErrors({}); setModalOpen(true); }}
              className="bg-gradient-to-r from-navy to-navy2 text-white hover:from-navy2 hover:to-navy shadow-sm shadow-navy/20"
            >
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
        <FilterSelect value={classeFilter} onChange={(v) => { setClasse(v); setPage(1); }}>
          <option value="">Toutes les classes</option>
          <option value="RN">Route Nationale (RN)</option>
          <option value="RR">Route Préfectorale (RP)</option>
          <option value="RU">Voirie Urbaine (VU)</option>
          <option value="PISTE">Piste Rurale (PR)</option>
        </FilterSelect>
        <FilterSelect value={etatFilter} onChange={(v) => { setEtat(v); setPage(1); }}>
          <option value="">Tous les états</option>
          <option value="BON">Bon</option>
          <option value="MOYEN">Moyen</option>
          <option value="MAUVAIS">Mauvais</option>
          <option value="CRITIQUE">Critique</option>
          <option value="NON_EVALUE">Non évalué</option>
        </FilterSelect>
        {pkManquantOnly && (
          <span className="flex items-center gap-1.5 rounded-full bg-orange-100 text-orange-700 text-xs px-3 py-1 font-medium">
            <AlertTriangle className="h-3 w-3" /> PK manquant
            <button onClick={() => setPkManquant(false)} className="ml-1 hover:text-orange-900 font-bold">×</button>
          </span>
        )}
      </div>

      {/* Ligne 3 : select-all + stats */}
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
          {(data?.total ?? 0).toLocaleString("fr-FR")} tronçons
          {topAxis && (
            <>
              {" · "}
              <span className="text-gray-500 font-medium">{topAxis.axis}</span>
              {" : "}{topAxis.count} segments regroupés
            </>
          )}
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="rounded-xl bg-navy/5 border border-navy/15 px-4 py-2.5 flex items-center justify-between gap-3 mb-2">
          <span className="text-sm text-navy font-medium">{selected.size} tronçon(s) sélectionné(s)</span>
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
      <DataTable<Troncon>
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

      {/* Class legend + PK filter */}
      <ClasseLegend
        missingPk={missingPkCount}
        total={rows.length}
        onFilterMissing={() => { setPkManquant((v) => !v); setPage(1); }}
      />

      <Modal open={modalOpen} onClose={closeModal} title={editing ? `Modifier — ${editing.code}` : "Ajouter un tronçon"}>
        <EntityForm
          fields={tronconFields}
          defaultValues={(editing ?? {}) as Record<string, unknown>}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {historyId && (
        <AuditHistoryModal
          open={!!historyId}
          onClose={() => setHistoryId(null)}
          entityType="Troncon"
          entityId={historyId}
          title="Tronçon"
        />
      )}

      {ficheId && (
        <TronconFicheModal
          open={!!ficheId}
          onClose={() => setFicheId(null)}
          tronconId={ficheId}
        />
      )}

      {confirmDialog}
    </div>
  );
}
