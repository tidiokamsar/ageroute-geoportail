import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { EntityListPage } from "./EntityListPage";
import { FilterSelect } from "./EntityListPage";
import { api } from "../lib/api";
import { posteFields } from "../lib/fieldConfigs";
import type { Poste, Region, TypePoste, StatutPoste } from "../types";

// ── Méta (badges, libellés) : spécifique postes, conservées telles quelles ────

const TYPE_META: Record<TypePoste, { label: string; pill: string; dot: string }> = {
  PEAGE:  { label: "Péage",   pill: "bg-blue-100 text-blue-700",   dot: "bg-blue-500" },
  PESAGE: { label: "Pesage",  pill: "bg-purple-100 text-purple-700", dot: "bg-purple-500" },
};

const STATUT_META: Record<StatutPoste, { label: string; pill: string; dot: string }> = {
  EN_SERVICE:      { label: "En service",      pill: "bg-green-100 text-green-700", dot: "bg-green-500" },
  HORS_SERVICE:    { label: "Hors service",    pill: "bg-red-100 text-red-700",     dot: "bg-red-500" },
  EN_CONSTRUCTION: { label: "En construction", pill: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
};

function TypeBadge({ type }: { type: TypePoste }) {
  const m = TYPE_META[type];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function StatutBadge({ statut }: { statut: StatutPoste }) {
  const m = STATUT_META[statut];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

// ── Page : enveloppe fine autour d'EntityListPage (pilote de consolidation) ───
//
// 428 lignes → ~130 : tout le squelette (pagination, tri, recherche, sélection,
// bulk archive/restore, modale CRUD avec garde anti-perte, historique audit,
// import/export) vit une seule fois dans EntityListPage. Restent ici les
// éléments réellement spécifiques : colonnes/badges, filtres région/type/statut,
// l'action "Carte" par ligne et le filtre client du statut (comportement
// historique conservé à l'identique).

export function PostesPage() {
  const navigate = useNavigate();
  const [regionFilter, setRegion] = useState("");
  const [typeFilter, setType] = useState("");
  const [statutFilter, setStatut] = useState("");

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const columns: ColumnDef<Poste, unknown>[] = [
    {
      id: "nom",
      header: "Nom",
      cell: ({ row: { original: p } }) => (
        <span className="text-sm font-bold text-navy">{p.nom}</span>
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
  ];

  return (
    <EntityListPage<Poste>
      endpoint="postes"
      title="Postes de péage & pesage"
      subtitle="Gestion des points de contrôle routier"
      pageIcon={<Gauge className="h-4 w-4 text-purple-600" />}
      searchPlaceholder="Rechercher un poste..."
      columns={columns}
      fields={posteFields}
      importExport
      auditEntityType="Poste"
      extraParams={{ region: regionFilter || undefined, type: typeFilter || undefined }}
      rowFilter={statutFilter ? (p) => p.statut === statutFilter : undefined}
      filters={
        <>
          <FilterSelect value={regionFilter} onChange={setRegion}>
            <option value="">Toutes les régions</option>
            {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
          </FilterSelect>
          <FilterSelect value={typeFilter} onChange={setType}>
            <option value="">Tous les types</option>
            <option value="PEAGE">Péage</option>
            <option value="PESAGE">Pesage</option>
          </FilterSelect>
          <FilterSelect value={statutFilter} onChange={setStatut}>
            <option value="">Tous les statuts</option>
            <option value="EN_SERVICE">En service</option>
            <option value="HORS_SERVICE">Hors service</option>
            <option value="EN_CONSTRUCTION">En construction</option>
          </FilterSelect>
        </>
      }
      rowExtraActions={[
        { label: "Carte", onClick: (p) => navigate(`/geoportail?select=poste&id=${p.id}`) },
      ]}
    />
  );
}
