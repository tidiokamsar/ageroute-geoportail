import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import { AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown, ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { Card, KpiCard } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { printReport } from "../lib/print";
import type { RapportRegionLigne } from "../types";

// ── Constantes ────────────────────────────────────────────────────────────────

const ETAT_CONFIG = [
  { key: "kmBon",       label: "Bon",      color: "#16a34a", textColor: "text-green-700" },
  { key: "kmMoyen",     label: "Moyen",    color: "#84cc16", textColor: "text-lime-600"  },
  { key: "kmMauvais",   label: "Mauvais",  color: "#f97316", textColor: "text-orange-600"},
  { key: "kmCritique",  label: "Critique", color: "#dc2626", textColor: "text-red-600"   },
  { key: "kmNonEvalue", label: "Non éval.", color: "#9ca3af", textColor: "text-gray-400" },
] as const;

type SortKey = "region" | "troncons" | "longueurKm" | "ouvrages" | "chantiersEnCours" | keyof typeof ETAT_CONFIG[number];
type SortDir = "asc" | "desc";

// ── Utilitaires ───────────────────────────────────────────────────────────────

function km(v: number): string {
  return v.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

function pct(val: number, total: number): number {
  return total > 0 ? Math.round((val / total) * 100) : 0;
}

function computeTotaux(data: RapportRegionLigne[]) {
  return data.reduce(
    (acc, l) => ({
      troncons: acc.troncons + l.troncons,
      longueurKm: acc.longueurKm + l.longueurKm,
      ouvrages: acc.ouvrages + l.ouvrages,
      chantiersEnCours: acc.chantiersEnCours + l.chantiersEnCours,
      kmBon: acc.kmBon + l.kmBon,
      kmMoyen: acc.kmMoyen + l.kmMoyen,
      kmMauvais: acc.kmMauvais + l.kmMauvais,
      kmCritique: acc.kmCritique + l.kmCritique,
      kmNonEvalue: acc.kmNonEvalue + l.kmNonEvalue,
    }),
    { troncons: 0, longueurKm: 0, ouvrages: 0, chantiersEnCours: 0, kmBon: 0, kmMoyen: 0, kmMauvais: 0, kmCritique: 0, kmNonEvalue: 0 }
  );
}

function exportCsv(lignes: RapportRegionLigne[], totaux: ReturnType<typeof computeTotaux>) {
  const headers = ["Région", "Tronçons", "Linéaire (km)", "Ouvrages", "Chantiers en cours", "Bon (km)", "Moyen (km)", "Mauvais (km)", "Critique (km)", "Non évalué (km)"];
  const rows = lignes.map((l) => [l.region, l.troncons, km(l.longueurKm), l.ouvrages, l.chantiersEnCours, km(l.kmBon), km(l.kmMoyen), km(l.kmMauvais), km(l.kmCritique), km(l.kmNonEvalue)]);
  rows.push(["TOTAL", totaux.troncons, km(totaux.longueurKm), totaux.ouvrages, totaux.chantiersEnCours, km(totaux.kmBon), km(totaux.kmMoyen), km(totaux.kmMauvais), km(totaux.kmCritique), km(totaux.kmNonEvalue)]);
  const csv = [headers, ...rows].map((r) => r.join(";")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rapport-reseau-routier-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Composants visuels ────────────────────────────────────────────────────────

function MiniBar({ bon, moyen, mauvais, critique, total }: { bon: number; moyen: number; mauvais: number; critique: number; total: number }) {
  if (total === 0) return <span className="text-gray-300 text-xs">—</span>;
  const segs = [
    { v: bon,     c: "#16a34a" },
    { v: moyen,   c: "#84cc16" },
    { v: mauvais, c: "#f97316" },
    { v: critique,c: "#dc2626" },
  ].filter(s => s.v > 0);
  return (
    <div className="flex h-2 w-16 rounded-full overflow-hidden gap-px" title={`Bon ${pct(bon,total)}% · Moyen ${pct(moyen,total)}% · Mauvais ${pct(mauvais,total)}% · Critique ${pct(critique,total)}%`}>
      {segs.map((s, i) => (
        <div key={i} style={{ width: `${pct(s.v, total)}%`, backgroundColor: s.c, minWidth: s.v > 0 ? 2 : 0 }} />
      ))}
    </div>
  );
}

function SortIcon({ col, active, dir }: { col: string; active: string; dir: SortDir }) {
  if (col !== active) return <ArrowUpDown className="h-3 w-3 opacity-30" />;
  return dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
}

// Tooltip recharts personnalisé
function CustomBarTooltip({ active, payload, label }: { active?: boolean; payload?: {name: string; value: number; fill: string}[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + p.value, 0);
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs space-y-1">
      <p className="font-semibold text-navy mb-1">{label} — {km(total)} km</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: p.fill }} />
          <span className="text-gray-600 flex-1">{p.name}</span>
          <span className="font-medium">{km(p.value)} km</span>
          <span className="text-gray-400">({pct(p.value, total)}%)</span>
        </div>
      ))}
    </div>
  );
}

// ── Page principale ───────────────────────────────────────────────────────────

export function RapportsPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "rapport-regions"],
    queryFn: async () => (await api.get<RapportRegionLigne[]>("/dashboard/rapport-regions")).data,
  });

  const [sortKey, setSortKey] = useState<SortKey>("longueurKm");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // useMemo AVANT le early return — règle des hooks
  const sorted = useMemo(() => {
    if (!data) return [];
    const withoutNull = data.filter(l => l.region && l.region !== "Non renseigné" && l.region !== "");
    const nullLine = data.filter(l => !l.region || l.region === "Non renseigné" || l.region === "");
    const getValue = (l: RapportRegionLigne) => {
      const v = l[sortKey as keyof RapportRegionLigne];
      return typeof v === "string" ? v : (v as number);
    };
    withoutNull.sort((a, b) => {
      const va = getValue(a), vb = getValue(b);
      if (typeof va === "string" && typeof vb === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === "asc" ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
    return [...withoutNull, ...nullLine];
  }, [data, sortKey, sortDir]);

  function handleSort(col: SortKey) {
    if (col === sortKey) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(col); setSortDir("desc"); }
  }

  if (isLoading || !data) return <p className="p-4 text-gray-400">Chargement...</p>;

  const totaux = computeTotaux(data);
  const pctCritique = pct(totaux.kmCritique, totaux.longueurKm);
  const pctMauvaisCritique = pct(totaux.kmMauvais + totaux.kmCritique, totaux.longueurKm);

  // Données qualité
  const nonRenseigne = data.find(l => !l.region || l.region === "Non renseigné" || l.region === "");
  const pctNonRenseigne = nonRenseigne ? pct(nonRenseigne.troncons, totaux.troncons) : 0;
  const hasDataQualityIssue = pctNonRenseigne >= 10;

  // Données graphique barres empilées (top 8 régions par longueur, hors "Non renseigné")
  const barData = data
    .filter(l => l.region && l.region !== "Non renseigné" && l.region !== "" && l.longueurKm > 0)
    .sort((a, b) => b.longueurKm - a.longueurKm)
    .slice(0, 8)
    .map(l => ({
      name: l.region.length > 9 ? l.region.slice(0, 9) + "." : l.region,
      fullName: l.region,
      Bon: Math.round(l.kmBon),
      Moyen: Math.round(l.kmMoyen),
      Mauvais: Math.round(l.kmMauvais),
      Critique: Math.round(l.kmCritique),
    }));

  // Données donut état global
  const donutData = [
    { name: "Bon",       value: Math.round(totaux.kmBon),       color: "#16a34a" },
    { name: "Moyen",     value: Math.round(totaux.kmMoyen),     color: "#84cc16" },
    { name: "Mauvais",   value: Math.round(totaux.kmMauvais),   color: "#f97316" },
    { name: "Critique",  value: Math.round(totaux.kmCritique),  color: "#dc2626" },
    { name: "Non éval.", value: Math.round(totaux.kmNonEvalue), color: "#e5e7eb" },
  ].filter(d => d.value > 0);

  const thClass = "py-2 px-2 text-left text-xs text-gray-500 uppercase select-none cursor-pointer hover:text-navy whitespace-nowrap";
  const thRClass = `${thClass} text-right`;

  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="flex items-center justify-between no-print flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-navy">Rapports</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => exportCsv(data, totaux)}>📊 Exporter CSV</Button>
          <Button onClick={printReport}>🖨 Imprimer / PDF</Button>
        </div>
      </div>

      {/* Alerte qualité données */}
      {hasDataQualityIssue && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm no-print">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-amber-800">
              {pctNonRenseigne}% des tronçons ({nonRenseigne?.troncons ?? 0} sur {totaux.troncons}) n'ont pas de région renseignée
            </p>
            <p className="text-amber-700 text-xs mt-0.5">
              Ces tronçons ({km(nonRenseigne?.longueurKm ?? 0)} km) figurent dans la ligne «&nbsp;Non renseigné&nbsp;» et faussent l'analyse régionale.
              Un rattachement en masse via le SIG ou un import est recommandé avant exploitation.
            </p>
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 no-print">
        <KpiCard label="Linéaire total" value={`${km(totaux.longueurKm)} km`} icon="🛣" accent="#1a2942" />
        <KpiCard label="Tronçons" value={totaux.troncons} icon="📍" accent="#1a2942" />
        <KpiCard label="Ouvrages d'art" value={totaux.ouvrages} icon="🌉" accent="#7c3aed" />
        <KpiCard label="Réseau critique" value={`${pctCritique}%`} sub={`${km(totaux.kmCritique)} km`} icon="⚠" accent="#dc2626" />
      </div>

      {/* Graphiques */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 no-print">

        {/* Barres empilées par région */}
        <Card className="lg:col-span-2">
          <h3 className="text-sm font-semibold text-navy mb-1">État du réseau par région (top 8)</h3>
          <p className="text-[11px] text-gray-400 mb-3">En km — hors tronçons sans région</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData} margin={{ top: 0, right: 4, left: -10, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}`} />
              <Tooltip content={<CustomBarTooltip />} cursor={{ fill: "#f3f4f6" }} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              {ETAT_CONFIG.slice(0, 4).map(e => (
                <Bar key={e.key} dataKey={e.label} stackId="a" fill={e.color} radius={e.key === "kmCritique" ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Donut état global + qualité données */}
        <div className="space-y-4">
          <Card>
            <h3 className="text-sm font-semibold text-navy mb-3">État global du réseau</h3>
            <div className="flex items-center gap-3">
              <div className="relative shrink-0">
                <ResponsiveContainer width={110} height={110}>
                  <PieChart>
                    <Pie data={donutData} cx="50%" cy="50%" innerRadius={32} outerRadius={50} dataKey="value" strokeWidth={0}>
                      {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-lg font-bold text-navy leading-none">{pctMauvaisCritique}%</span>
                  <span className="text-[10px] text-gray-400 mt-0.5">dégradé</span>
                </div>
              </div>
              <div className="space-y-1.5 flex-1 min-w-0">
                {donutData.map(d => (
                  <div key={d.name} className="flex items-center gap-1.5 text-xs">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                    <span className="text-gray-600 flex-1 truncate">{d.name}</span>
                    <span className="font-medium tabular-nums">{pct(d.value, totaux.longueurKm)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Qualité des données */}
          <Card>
            <h3 className="text-sm font-semibold text-navy mb-2">Qualité des données</h3>
            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-600">Tronçons avec région</span>
                  <span className="font-medium">{100 - pctNonRenseigne}%</span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${100 - pctNonRenseigne}%`, backgroundColor: (100 - pctNonRenseigne) >= 80 ? "#16a34a" : (100 - pctNonRenseigne) >= 50 ? "#f97316" : "#dc2626" }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-600">Tronçons évalués</span>
                  <span className="font-medium">{pct(totaux.longueurKm - totaux.kmNonEvalue, totaux.longueurKm)}%</span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${pct(totaux.longueurKm - totaux.kmNonEvalue, totaux.longueurKm)}%` }}
                  />
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Tableau */}
      <div className="printable-report">
        <Card>
          <div className="hidden print:flex items-center gap-3 mb-4">
            <img src="/ageroute-logo.svg" alt="AGEROUTE" className="h-12 w-auto" />
            <div>
              <h1 className="text-lg font-bold text-navy">État du réseau routier par région</h1>
              <p className="text-xs text-gray-500">AGEROUTE Guinée — édité le {new Date().toLocaleDateString("fr-FR")}</p>
            </div>
          </div>

          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-navy">Détail par région</h3>
            <p className="text-[11px] text-gray-400 no-print">Cliquez sur une région pour voir sur le géoportail</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-gray-200">
                  <th className={thClass} onClick={() => handleSort("region")}>
                    <span className="flex items-center gap-1">Région <SortIcon col="region" active={sortKey} dir={sortDir} /></span>
                  </th>
                  <th className={thRClass} onClick={() => handleSort("troncons")}>
                    <span className="flex items-center justify-end gap-1">Tronçons <SortIcon col="troncons" active={sortKey} dir={sortDir} /></span>
                  </th>
                  <th className={thRClass} onClick={() => handleSort("longueurKm")}>
                    <span className="flex items-center justify-end gap-1">Linéaire <SortIcon col="longueurKm" active={sortKey} dir={sortDir} /></span>
                  </th>
                  <th className={thRClass} onClick={() => handleSort("ouvrages")}>
                    <span className="flex items-center justify-end gap-1">Ouvrages <SortIcon col="ouvrages" active={sortKey} dir={sortDir} /></span>
                  </th>
                  <th className={thRClass} onClick={() => handleSort("chantiersEnCours")}>
                    <span className="flex items-center justify-end gap-1">Chantiers <SortIcon col="chantiersEnCours" active={sortKey} dir={sortDir} /></span>
                  </th>
                  <th className="py-2 px-2 text-right text-xs text-green-700 uppercase">Bon</th>
                  <th className="py-2 px-2 text-right text-xs text-lime-600 uppercase">Moyen</th>
                  <th className="py-2 px-2 text-right text-xs text-orange-600 uppercase">Mauvais</th>
                  <th className="py-2 px-2 text-right text-xs text-red-600 uppercase">Critique</th>
                  <th className="py-2 px-2 text-right text-xs text-gray-400 uppercase hidden sm:table-cell">Non éval.</th>
                  <th className="py-2 px-2 text-xs text-gray-400 uppercase hidden md:table-cell">État</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((l) => {
                  const isNonRenseigne = !l.region || l.region === "Non renseigné" || l.region === "";
                  const evalTotal = l.kmBon + l.kmMoyen + l.kmMauvais + l.kmCritique;
                  return (
                    <tr
                      key={l.region || "__null"}
                      className={`border-b border-gray-50 transition-colors ${isNonRenseigne ? "bg-amber-50/50" : "hover:bg-blue-50/40 cursor-pointer"}`}
                      onClick={() => !isNonRenseigne && navigate(`/geoportail?region=${encodeURIComponent(l.region)}`)}
                    >
                      <td className="py-2 px-2">
                        <span className={`font-medium flex items-center gap-1.5 ${isNonRenseigne ? "text-amber-700" : "text-navy group-hover:underline"}`}>
                          {isNonRenseigne ? (
                            <><AlertTriangle className="h-3 w-3 text-amber-500" />{l.region || "Non renseigné"}</>
                          ) : (
                            <><span className="hover:underline">{l.region}</span><ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 text-gray-400" /></>
                          )}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">{l.troncons || <span className="text-gray-300">—</span>}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{l.longueurKm > 0 ? `${km(l.longueurKm)} km` : <span className="text-gray-300">—</span>}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{l.ouvrages || <span className="text-gray-300">—</span>}</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {l.chantiersEnCours > 0
                          ? <span className="inline-flex items-center justify-center bg-amber-100 text-amber-700 rounded px-1.5 py-0.5 text-xs font-medium">{l.chantiersEnCours}</span>
                          : <span className="text-gray-300">—</span>
                        }
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-green-700">{l.kmBon > 0 ? km(l.kmBon) : <span className="text-gray-200">—</span>}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-lime-600">{l.kmMoyen > 0 ? km(l.kmMoyen) : <span className="text-gray-200">—</span>}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-orange-600">{l.kmMauvais > 0 ? km(l.kmMauvais) : <span className="text-gray-200">—</span>}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-red-600 font-medium">{l.kmCritique > 0 ? km(l.kmCritique) : <span className="text-gray-200">—</span>}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-gray-400 hidden sm:table-cell">{l.kmNonEvalue > 0 ? km(l.kmNonEvalue) : <span className="text-gray-200">—</span>}</td>
                      <td className="py-2 px-2 hidden md:table-cell">
                        <MiniBar bon={l.kmBon} moyen={l.kmMoyen} mauvais={l.kmMauvais} critique={l.kmCritique} total={evalTotal} />
                      </td>
                    </tr>
                  );
                })}
                {/* Ligne TOTAL */}
                <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-navy sticky bottom-0">
                  <td className="py-2 px-2 text-xs uppercase tracking-wide">Total réseau</td>
                  <td className="py-2 px-2 text-right">{totaux.troncons}</td>
                  <td className="py-2 px-2 text-right">{km(totaux.longueurKm)} km</td>
                  <td className="py-2 px-2 text-right">{totaux.ouvrages}</td>
                  <td className="py-2 px-2 text-right">{totaux.chantiersEnCours}</td>
                  <td className="py-2 px-2 text-right text-green-700">{km(totaux.kmBon)}</td>
                  <td className="py-2 px-2 text-right text-lime-600">{km(totaux.kmMoyen)}</td>
                  <td className="py-2 px-2 text-right text-orange-600">{km(totaux.kmMauvais)}</td>
                  <td className="py-2 px-2 text-right text-red-600">{km(totaux.kmCritique)}</td>
                  <td className="py-2 px-2 text-right text-gray-400 hidden sm:table-cell">{km(totaux.kmNonEvalue)}</td>
                  <td className="py-2 px-2 hidden md:table-cell">
                    <MiniBar bon={totaux.kmBon} moyen={totaux.kmMoyen} mauvais={totaux.kmMauvais} critique={totaux.kmCritique} total={totaux.kmBon + totaux.kmMoyen + totaux.kmMauvais + totaux.kmCritique} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
