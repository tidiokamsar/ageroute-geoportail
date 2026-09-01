import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { BookOpen, ChevronDown, DollarSign, ListFilter, TrendingUp, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { Card, KpiCard } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { DataTable } from "../components/DataTable";
import { printReport } from "../lib/print";
import type { ProgrammationData, PaginatedResult } from "../types";

interface ProgrammationLigne {
  id: string;
  intitule: string;
  entreprise: string;
  bailleur: string;
  montantGnf: string;
  statut: "PLANIFIE" | "EN_COURS" | "SUSPENDU" | "TERMINE";
  avancementPct: number;
  dateDebutPrevue: string | null;
  dateFinPrevue: string | null;
  region: string;
  troncon: string | null;
}

const STATUT_LABEL: Record<ProgrammationLigne["statut"], string> = {
  PLANIFIE: "Planifié", EN_COURS: "En cours", SUSPENDU: "Suspendu", TERMINE: "Terminé",
};
const STATUT_PILL: Record<ProgrammationLigne["statut"], string> = {
  PLANIFIE: "bg-slate-100 text-slate-700", EN_COURS: "bg-blue-100 text-blue-700",
  SUSPENDU: "bg-amber-100 text-amber-700", TERMINE: "bg-green-100 text-green-700",
};

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
          active ? "border-navy/40 bg-navy/5 text-navy font-medium" : "border-gray-200 bg-white text-gray-600"
        }`}
      >
        {children}
      </select>
      <ChevronDown className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 ${active ? "text-navy/60" : "text-gray-400"}`} />
    </div>
  );
}

function formatGnf(montant: string): string {
  const n = Number(montant);
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Md GNF`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} M GNF`;
  return `${n.toLocaleString("fr-FR")} GNF`;
}

const COLORS = ["#1a2942", "#0891b2", "#f5a623", "#16a34a", "#7c3aed", "#dc2626", "#64748b"];

type PieLabelProps = {
  cx?: number; cy?: number; midAngle?: number;
  innerRadius?: number; outerRadius?: number; percent?: number;
};

function DonutLabel({ cx = 0, cy = 0, midAngle = 0, innerRadius = 0, outerRadius = 0, percent = 0 }: PieLabelProps) {
  if (percent < 0.06) return null;
  const RADIAN = Math.PI / 180;
  const r = innerRadius + (outerRadius - innerRadius) * 0.55;
  const x = cx + r * Math.cos(-midAngle * RADIAN);
  const y = cy + r * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight="700">
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

export function ProgrammationPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "programmation"],
    queryFn: async () => (await api.get<ProgrammationData>("/dashboard/programmation")).data,
  });

  const [anneeFilter, setAnneeFilter] = useState("");
  const [bailleurFilter, setBailleurFilter] = useState("");
  const [statutFilter, setStatutFilter] = useState("");
  const [page, setPage] = useState(1);

  const { data: lignes, isLoading: lignesLoading } = useQuery({
    queryKey: ["dashboard", "programmation", "lignes", { anneeFilter, bailleurFilter, statutFilter, page }],
    queryFn: async () => (await api.get<PaginatedResult<ProgrammationLigne>>("/dashboard/programmation/lignes", {
      params: {
        annee: anneeFilter || undefined,
        bailleur: bailleurFilter || undefined,
        statut: statutFilter || undefined,
        page, pageSize: 20,
      },
    })).data,
  });

  const columns: ColumnDef<ProgrammationLigne, unknown>[] = [
    {
      id: "intitule",
      header: "Marché / ligne budgétaire",
      cell: ({ row: { original: l } }) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-navy truncate max-w-[280px]" title={l.intitule}>{l.intitule}</p>
          <p className="text-xs text-gray-400">{l.entreprise}</p>
        </div>
      ),
    },
    {
      id: "bailleur",
      header: "Bailleur",
      cell: ({ row: { original: l } }) => <span className="text-sm text-gray-600">{l.bailleur}</span>,
    },
    {
      id: "region",
      header: "Région",
      cell: ({ row: { original: l } }) => <span className="text-sm text-gray-500">{l.region}{l.troncon ? ` · ${l.troncon}` : ""}</span>,
    },
    {
      id: "montant",
      header: () => <span className="block text-right w-full">Montant</span>,
      cell: ({ row: { original: l } }) => (
        <span className="block text-right text-sm text-gray-700 tabular-nums pr-2">{formatGnf(l.montantGnf)}</span>
      ),
    },
    {
      id: "statut",
      header: "Statut",
      cell: ({ row: { original: l } }) => (
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUT_PILL[l.statut]}`}>
          {STATUT_LABEL[l.statut]}
        </span>
      ),
    },
    {
      id: "avancement",
      header: "Avancement",
      cell: ({ row: { original: l } }) => (
        <div className="flex items-center gap-1.5">
          <div className="w-14 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full rounded-full bg-gold" style={{ width: `${l.avancementPct}%` }} />
          </div>
          <span className="text-xs text-gray-500 tabular-nums">{l.avancementPct}%</span>
        </div>
      ),
    },
    {
      id: "periode",
      header: "Période",
      cell: ({ row: { original: l } }) => (
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {l.dateDebutPrevue ? new Date(l.dateDebutPrevue).toLocaleDateString("fr-FR") : "—"}
          {" → "}
          {l.dateFinPrevue ? new Date(l.dateFinPrevue).toLocaleDateString("fr-FR") : "—"}
        </span>
      ),
    },
  ];

  if (isLoading || !data) return <p className="text-gray-400 p-6">Chargement...</p>;

  const chartData = [...data.parAnnee]
    .sort((a, b) => a.annee - b.annee)
    .map((r) => ({ annee: String(r.annee), montantMd: Number(r.montant) / 1e9 }));

  const totalTermine = data.parAnnee.reduce((s, r) => s + r.termine, 0);
  const txExecution = data.total.nb > 0 ? Math.round((totalTermine / data.total.nb) * 100) : 0;

  const pieData = data.parBailleur.map((r) => ({
    name: r.bailleur || "Non renseigné",
    value: Number(r.montant),
  }));

  const topBailleur = data.parBailleur.length
    ? data.parBailleur.reduce((m, r) => (Number(r.montant) > Number(m.montant) ? r : m), data.parBailleur[0])
    : null;

  return (
    <div className="space-y-4">
      {/* Gradient banner */}
      <div className="bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] rounded-xl p-5 text-white flex items-center justify-between no-print">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-gold" />
            Programmation budgétaire
          </h2>
          <p className="text-white/60 text-sm mt-1">
            {data.total.nb.toLocaleString("fr-FR")} marchés · {formatGnf(data.total.montant)}
          </p>
        </div>
        <Button onClick={printReport}>🖨 Imprimer / PDF</Button>
      </div>

      <div className="printable-report space-y-4">
        {/* Print header */}
        <div className="hidden print:flex items-center gap-3 mb-2">
          <img src="/ageroute-logo.svg" alt="AGEROUTE" className="h-12 w-auto" />
          <div>
            <h1 className="text-lg font-bold text-navy">Programmation budgétaire des travaux</h1>
            <p className="text-xs text-gray-500">AGEROUTE Guinée — édité le {new Date().toLocaleDateString("fr-FR")}</p>
          </div>
        </div>

        {/* 4 KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Marchés recensés"
            value={data.total.nb.toLocaleString("fr-FR")}
            icon={<BookOpen className="h-5 w-5" />}
            accent="#1a2942"
          />
          <KpiCard
            label="Montant total"
            value={formatGnf(data.total.montant)}
            icon={<DollarSign className="h-5 w-5" />}
            accent="#16a34a"
          />
          <KpiCard
            label="Sources de financement"
            value={data.parBailleur.length}
            icon={<Wallet className="h-5 w-5" />}
            accent="#0891b2"
          />
          <KpiCard
            label="Taux d'exécution"
            value={`${txExecution} %`}
            sub={`${totalTermine} marchés terminés`}
            icon={<TrendingUp className="h-5 w-5" />}
            accent={txExecution >= 60 ? "#16a34a" : txExecution >= 30 ? "#f5a623" : "#dc2626"}
          />
        </div>

        {/* Bar chart */}
        <Card>
          <h3 className="text-sm font-semibold text-navy mb-3">Montant programmé par année (Md GNF)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} barSize={32}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="annee" fontSize={11} tick={{ fill: "#64748b" }} />
              <YAxis fontSize={11} tick={{ fill: "#64748b" }} />
              <Tooltip
                contentStyle={{ borderRadius: 8, fontSize: 12 }}
                formatter={(v: number) =>
                  [`${v.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Md GNF`, "Montant"]
                }
              />
              <Bar dataKey="montantMd" radius={[6, 6, 0, 0]} fill="#1a2942" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Années avec mini progress bars */}
          <Card>
            <h3 className="text-sm font-semibold text-navy mb-3">Détail par année</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 uppercase">
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-2 pr-3">Année</th>
                    <th className="text-right py-2 pr-3">Nb</th>
                    <th className="text-right py-2 pr-3">Montant</th>
                    <th className="text-right py-2 w-32">Exécution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.parAnnee.map((r) => {
                    const pctT = r.nb > 0 ? (r.termine / r.nb) * 100 : 0;
                    const pctC = r.nb > 0 ? (r.enCours / r.nb) * 100 : 0;
                    return (
                      <tr key={r.annee} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                        <td className="py-2 pr-3 font-semibold text-navy">{r.annee}</td>
                        <td className="py-2 pr-3 text-right text-gray-600">{r.nb}</td>
                        <td className="py-2 pr-3 text-right text-gray-700 whitespace-nowrap">{formatGnf(r.montant)}</td>
                        <td className="py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden flex">
                              <div
                                className="h-full bg-green-500 transition-all"
                                style={{ width: `${pctT}%` }}
                              />
                              <div
                                className="h-full bg-gold transition-all"
                                style={{ width: `${pctC}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-500 w-9 text-right shrink-0">{Math.round(pctT)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                <span className="flex items-center gap-1"><span className="h-2 w-4 rounded-sm bg-green-500 inline-block" />Terminés</span>
                <span className="flex items-center gap-1"><span className="h-2 w-4 rounded-sm bg-gold inline-block" />En cours</span>
              </div>
            </div>
          </Card>

          {/* Donut bailleurs */}
          <Card>
            <h3 className="text-sm font-semibold text-navy mb-1">Répartition par bailleur</h3>
            {topBailleur && (
              <p className="text-xs text-gray-500 mb-2">
                Principal :{" "}
                <span className="font-semibold text-navy">{topBailleur.bailleur || "Non renseigné"}</span>
                {" · "}{formatGnf(topBailleur.montant)}
              </p>
            )}
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="48%"
                  innerRadius={52}
                  outerRadius={82}
                  dataKey="value"
                  labelLine={false}
                  label={DonutLabel}
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="white" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ borderRadius: 8, fontSize: 12 }}
                  formatter={(v: unknown) =>
                    typeof v === "number" ? [formatGnf(String(v)), "Montant"] : [String(v), "Montant"]
                  }
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>

        {/* Référentiel : détail ligne par ligne des marchés */}
        <Card className="no-print">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-navy flex items-center gap-2">
              <ListFilter className="h-4 w-4 text-navy/60" />
              Référentiel des marchés
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              <FilterSelect value={anneeFilter} onChange={(v) => { setAnneeFilter(v); setPage(1); }}>
                <option value="">Toutes les années</option>
                {[...data.parAnnee].sort((a, b) => b.annee - a.annee).map((r) => (
                  <option key={r.annee} value={r.annee}>{r.annee}</option>
                ))}
              </FilterSelect>
              <FilterSelect value={bailleurFilter} onChange={(v) => { setBailleurFilter(v); setPage(1); }}>
                <option value="">Tous les bailleurs</option>
                {data.parBailleur.map((r) => (
                  <option key={r.bailleur} value={r.bailleur}>{r.bailleur}</option>
                ))}
              </FilterSelect>
              <FilterSelect value={statutFilter} onChange={(v) => { setStatutFilter(v); setPage(1); }}>
                <option value="">Tous les statuts</option>
                <option value="PLANIFIE">Planifié</option>
                <option value="EN_COURS">En cours</option>
                <option value="SUSPENDU">Suspendu</option>
                <option value="TERMINE">Terminé</option>
              </FilterSelect>
            </div>
          </div>

          <DataTable<ProgrammationLigne>
            data={lignes?.data ?? []}
            columns={columns}
            page={lignes?.page ?? 1}
            totalPages={lignes?.totalPages ?? 1}
            total={lignes?.total ?? 0}
            loading={lignesLoading}
            onPageChange={setPage}
            onSortChange={() => {}}
          />
        </Card>
      </div>
    </div>
  );
}
