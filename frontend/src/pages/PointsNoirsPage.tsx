import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { EntityListPage, FilterSelect } from "./EntityListPage";
import { api } from "../lib/api";
import { pointNoirFields } from "../lib/fieldConfigs";
import type { PointNoir, Region, Gravite } from "../types";

// ── Badge gravité (spécifique points noirs) ───────────────────────────────────

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

// ── Page : enveloppe EntityListPage (consolidation, pattern PostesPage) ───────

export function PointsNoirsPage() {
  const navigate = useNavigate();
  const [regionFilter, setRegionFilter] = useState("");
  const [graviteFilter, setGraviteFilter] = useState("");

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const columns: ColumnDef<PointNoir, unknown>[] = [
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row: { original: p } }) => {
        const truncated = p.description.length > 80 ? p.description.slice(0, 80) + "…" : p.description;
        return (
          <span className="text-sm text-gray-800" title={p.description}>{truncated}</span>
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
        return <span className={`text-sm font-bold ${colorClass}`}>{p.nbAccidents}</span>;
      },
    },
  ];

  return (
    <EntityListPage<PointNoir>
      endpoint="points-noirs"
      title="Points Noirs"
      subtitle="Zones dangereuses et accidentogènes du réseau"
      pageIcon={<AlertTriangle className="h-4 w-4 text-red-600" />}
      searchPlaceholder="Rechercher un point noir…"
      columns={columns}
      fields={pointNoirFields}
      importExport
      auditEntityType="PointNoir"
      extraParams={{ region: regionFilter || undefined, etat: graviteFilter || undefined }}
      filters={
        <>
          <FilterSelect value={regionFilter} onChange={setRegionFilter}>
            <option value="">Toutes les régions</option>
            {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
          </FilterSelect>
          <FilterSelect value={graviteFilter} onChange={setGraviteFilter}>
            <option value="">Toutes les gravités</option>
            <option value="FAIBLE">Faible</option>
            <option value="MOYENNE">Moyenne</option>
            <option value="FORTE">Forte</option>
          </FilterSelect>
        </>
      }
      rowExtraActions={[
        { label: "Carte", onClick: (p) => navigate(`/geoportail?select=pointNoir&id=${p.id}`) },
      ]}
    />
  );
}
