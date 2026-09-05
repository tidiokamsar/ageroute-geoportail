import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Route, Landmark, AlertOctagon, Gauge, HardHat, FileText, Clock,
} from "lucide-react";
import { api } from "../lib/api";
import { KpiCard, Card } from "../components/ui/Card";
import { LongueurReseauCard } from "../components/LongueurReseauCard";
import { ETAT_COLORS } from "./geoportail/types";
import type { ActivityEntry, DashboardKpis } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  CREATE: "a créé",
  UPDATE: "a modifié",
  DELETE: "a archivé",
  RESTORE: "a restauré",
  LOGIN: "s'est connecté",
  LOGIN_FAILED: "a échoué à se connecter",
};

const ENTITY_LABELS: Record<string, string> = {
  Troncon: "un tronçon",
  Ouvrage: "un ouvrage d'art",
  PointNoir: "un point noir",
  Poste: "un poste",
  Chantier: "un chantier",
  Inspection: "une inspection",
  Document: "un document",
  User: "un utilisateur",
};

// Badge coloré par type d'action pour l'activité récente
const ACTION_BADGE: Record<string, { cls: string; symbol: string }> = {
  CREATE:       { cls: "bg-green-100 text-green-700",  symbol: "+" },
  UPDATE:       { cls: "bg-amber-100 text-amber-700",  symbol: "~" },
  DELETE:       { cls: "bg-red-100 text-red-700",      symbol: "−" },
  LOGIN:        { cls: "bg-blue-100 text-blue-700",    symbol: "→" },
  RESTORE:      { cls: "bg-green-100 text-green-700",  symbol: "↺" },
  LOGIN_FAILED: { cls: "bg-orange-100 text-orange-700", symbol: "✕" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "kpis"],
    queryFn: async () => (await api.get<DashboardKpis>("/dashboard/kpis")).data,
  });
  const { data: activity } = useQuery({
    queryKey: ["dashboard", "activity"],
    queryFn: async () => (await api.get<ActivityEntry[]>("/dashboard/activity")).data,
  });

  if (isLoading || !data) return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-gray-100" />
        ))}
      </div>
      <div className="h-16 rounded-xl bg-gray-100" />
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-72 rounded-xl bg-gray-100" />)}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* ── Bandeau de bienvenue ──────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] px-6 py-5 text-white shadow-lg shadow-navy/20 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Base de Données Routières Intégrées</h1>
          <p className="mt-1 text-sm text-white/60">
            Tableau de bord —{" "}
            {new Date().toLocaleDateString("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {/* « Reseau total : 7 933 km » etait faux — c'etait la longueur SAISIE, et le
              champ n'est renseigne que sur 662 troncons sur 1 690. Voir
              components/LongueurReseauCard.tsx. */}
          {data.reseau ? (
            <LongueurReseauCard reseau={data.reseau} voirieRattachee={data.voirieRattachee?.troncons}
              ouvragesRepris={data.voirieRattachee?.ouvrages} />
          ) : (
            <div className="text-right">
              <p className="text-2xl font-black">
                {data.longueurTotaleKm.toFixed(0)}{" "}
                <span className="text-base font-semibold text-white/70">km</span>
              </p>
              <p className="text-xs text-white/50 uppercase tracking-wider">Longueur renseignée</p>
            </div>
          )}
        </div>
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <Link to="/troncons">
          {/* « Tronçons » designe le RESEAU CLASSE. Le registre en compte 261 386,
              dont 259 696 issus de la promotion de voirie : les fondre ferait
              annoncer 185 000 km de reseau routier la ou la Guinee en a 21 000. */}
          <KpiCard
            label="Tronçons classés"
            value={data.tronconsCount}
            icon={<Route className="h-5 w-5" />}
            accent="#1a2942"
          />
        </Link>
        <Link to="/ouvrages">
          {/* L'inventaire AGEROUTE seul. Les franchissements repris d'une source
              externe sont comptes a part : « ouvrages d'art » doit continuer a
              designer ce que l'agence a visite. */}
          <KpiCard label="Ouvrages inventoriés" value={data.ouvragesCount} icon={<Landmark className="h-5 w-5" />} accent="#0891b2" />
        </Link>
        <Link to="/points-noirs">
          <KpiCard label="Points noirs" value={data.pointsNoirsCount} icon={<AlertOctagon className="h-5 w-5" />} accent="#dc2626" />
        </Link>
        <Link to="/postes">
          <KpiCard label="Péages / Pesages" value={data.postesCount} icon={<Gauge className="h-5 w-5" />} accent="#7c3aed" />
        </Link>
        <Link to="/chantiers">
          <KpiCard label="Chantiers en cours" value={data.chantiersEnCours} icon={<HardHat className="h-5 w-5" />} accent="#f5a623" />
        </Link>
        <Link to="/documents">
          <KpiCard label="Documents" value={data.documentsCount} icon={<FileText className="h-5 w-5" />} accent="#64748b" />
        </Link>
      </div>

      {/* ── Bandeau alerte ────────────────────────────────────────────────── */}
      {data.alertesCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl border-l-4 border-l-red-500 border border-red-200 bg-red-50 px-4 py-3">
          <AlertOctagon className="h-5 w-5 text-red-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-800">
              {data.alertesCount} alerte(s) critique(s)
            </p>
            <p className="text-xs text-red-600">
              Tronçons ou ouvrages en état mauvais/critique — action requise
            </p>
          </div>
          <Link
            to="/alertes"
            className="text-xs text-red-700 font-medium underline hover:text-red-900 shrink-0"
          >
            Voir les alertes →
          </Link>
        </div>
      )}

      {/* ── Graphiques ────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-widest mb-4">Analyse du réseau</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Tronçons par état */}
          <Card className="shadow-sm border-gray-200/60">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <Route className="h-4 w-4 text-navy" />
              Tronçons par état
            </h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.tronconsParEtat}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="etat" fontSize={11} />
                <YAxis fontSize={11} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="total" radius={[6, 6, 0, 0]}>
                  {data.tronconsParEtat.map((entry) => (
                    <Cell key={entry.etat} fill={ETAT_COLORS[entry.etat] ?? "#1a2942"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Ouvrages d'art par état */}
          <Card className="shadow-sm border-gray-200/60">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <Landmark className="h-4 w-4 text-navy" />
              Ouvrages d'art par état
            </h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.ouvragesParEtat}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="etat" fontSize={11} />
                <YAxis fontSize={11} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="total" radius={[6, 6, 0, 0]}>
                  {data.ouvragesParEtat.map((entry) => (
                    <Cell key={entry.etat} fill={ETAT_COLORS[entry.etat] ?? "#1a2942"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Chantiers par statut */}
          <Card className="shadow-sm border-gray-200/60">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <HardHat className="h-4 w-4 text-navy" />
              Chantiers par statut
            </h3>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={data.chantiersParStatut} dataKey="total" nameKey="statut" outerRadius={90} label>
                  {data.chantiersParStatut.map((entry, i) => (
                    <Cell key={entry.statut} fill={["#9ca3af", "#f5a623", "#dc2626", "#16a34a"][i % 4]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </Card>

          {/* Activité récente */}
          <Card className="shadow-sm border-gray-200/60">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-6 w-6 rounded-full bg-navy/10 flex items-center justify-center">
                <Clock className="h-3.5 w-3.5 text-navy" />
              </div>
              <h3 className="text-sm font-semibold text-gray-700">Activité récente</h3>
            </div>
            {!activity || activity.length === 0 ? (
              <p className="text-sm text-gray-400">Aucune activité récente.</p>
            ) : (
              <ul className="max-h-[260px] overflow-y-auto">
                {activity.map((a) => {
                  const badge = ACTION_BADGE[a.action] ?? { cls: "bg-gray-100 text-gray-500", symbol: "·" };
                  return (
                    <li key={a.id} className="flex items-start gap-2.5 py-1.5 border-b border-gray-50 last:border-0">
                      <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${badge.cls}`}>
                        {badge.symbol}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-600 leading-snug">
                          <strong className="text-navy font-semibold">{a.auteur}</strong>{" "}
                          {ACTION_LABELS[a.action] ?? a.action}{" "}
                          {ENTITY_LABELS[a.entityType] ?? a.entityType}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5">{timeAgo(a.createdAt)}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
