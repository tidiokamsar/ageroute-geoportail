import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { HardHat, AlertTriangle, Ruler, CalendarX } from "lucide-react";
import { EntityListPage, FilterSelect } from "./EntityListPage";
import { Card, KpiCard } from "../components/ui/Card";
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

// ── Stats hook ────────────────────────────────────────────────────────────────

function useChantierStats() {
  return useQuery({
    queryKey: ["chantiers", "stats"],
    queryFn: async () => (await api.get<{ total: number; enRetard: number; sansDates: number; linéaireTotalKm: number }>("/chantiers/stats")).data,
    staleTime: 30_000,
  });
}

// ── Page : enveloppe EntityListPage (consolidation) ──────────────────────────
// Spécifique conservé : KPI chantiers, colonnes métier (linéaire, statut retard,
// barre d'avancement, échéance), filtres région/statut, action Carte.

export function ChantiersPage() {
  const navigate = useNavigate();
  const [regionFilter, setRegionFilter] = useState("");
  const [statutFilter, setStatutFilter] = useState("");

  const { data: stats } = useChantierStats();
  const enRetardCount = stats?.enRetard ?? 0;
  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

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
  ];

  return (
    <EntityListPage<Chantier>
      endpoint="chantiers"
      title="Chantiers"
      subtitle="Suivi des travaux routiers"
      pageIcon={<HardHat className="h-4 w-4 text-orange-600" />}
      searchPlaceholder="Rechercher un chantier…"
      columns={columns}
      fields={chantierFields}
      importExport
      auditEntityType="Chantier"
      extraParams={{ region: regionFilter || undefined, etat: statutFilter || undefined }}
      filters={
        <>
          <FilterSelect value={regionFilter} onChange={setRegionFilter}>
            <option value="">Toutes les régions</option>
            {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
          </FilterSelect>
          <FilterSelect value={statutFilter} onChange={setStatutFilter}>
            <option value="">Tous les statuts</option>
            <option value="EN_COURS">En cours</option>
            <option value="EN_RETARD">En retard</option>
            <option value="PLANIFIE">Planifié</option>
            <option value="SUSPENDU">Suspendu</option>
            <option value="TERMINE">Terminé</option>
          </FilterSelect>
        </>
      }
      rowExtraActions={[
        { label: "Carte", onClick: (c) => navigate(`/geoportail?select=chantier&id=${c.id}`) },
      ]}
      aboveList={
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard label="Chantiers actifs" value={stats?.total ?? "—"} icon={<HardHat className="h-5 w-5" />} accent="#1a2942" />
          <Card className={`relative overflow-hidden p-4 transition-shadow hover:shadow-md ${enRetardCount > 0 ? "border-red-200 bg-red-50" : ""}`}>
            <span className="absolute inset-y-0 left-0 w-1 rounded-l-lg" style={{ backgroundColor: "#dc2626" }} />
            <div className="flex items-start justify-between gap-2 pl-1.5">
              <div className="min-w-0">
                <p className={`text-[11px] uppercase tracking-wide truncate ${enRetardCount > 0 ? "text-red-500" : "text-gray-400"}`}>En retard</p>
                <p className={`mt-1 text-2xl md:text-3xl font-bold leading-tight ${enRetardCount > 0 ? "text-red-600" : "text-gray-300"}`}>{stats?.enRetard ?? "—"}</p>
              </div>
              <span className={`shrink-0 flex items-center justify-center h-9 w-9 rounded-lg ${enRetardCount > 0 ? "bg-red-100 text-red-600" : "bg-gray-50 text-gray-300"}`}>
                <AlertTriangle className="h-5 w-5" />
              </span>
            </div>
          </Card>
          <KpiCard label="Linéaire total engagé" value={stats ? `${stats.linéaireTotalKm.toFixed(0)} km` : "—"} icon={<Ruler className="h-5 w-5" />} accent="#0891b2" />
          <KpiCard label="Sans dates renseignées" value={stats?.sansDates ?? "—"} icon={<CalendarX className="h-5 w-5" />} accent="#9ca3af" sub={stats?.sansDates ? "calcul retard impossible" : undefined} />
        </div>
      }
    />
  );
}
