import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Landmark, ChevronDown, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { Card, KpiCard } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { printReport } from "../lib/print";
import type { Marche, Bailleur, PaginatedResult, StatutMarche } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtGnf(montant: string | number | null | undefined): string {
  if (montant == null) return "—";
  const n = Number(montant);
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Md GNF`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} M GNF`;
  return `${n.toLocaleString("fr-FR")} GNF`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

const STATUT_LABEL: Record<StatutMarche, string> = {
  PLANIFIE: "Planifié", EN_COURS: "En cours", SUSPENDU: "Suspendu", TERMINE: "Terminé", SOLDE: "Soldé",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export function RapportBailleurPage() {
  const [bailleurId, setBailleurId] = useState<string>("");

  const { data: bailleurs } = useQuery({
    queryKey: ["bailleurs"],
    queryFn: async () => (await api.get<Bailleur[]>("/bailleurs")).data,
    staleTime: 300_000,
  });

  const { data: marchesResult, isLoading } = useQuery({
    queryKey: ["marches", "rapport", bailleurId],
    queryFn: async () => (await api.get<PaginatedResult<Marche>>("/marches", {
      params: { bailleurId: bailleurId || undefined, pageSize: 200, sortBy: "createdAt", sortDir: "desc" },
    })).data,
    enabled: !!bailleurs,
  });

  const bailleur = bailleurs?.find((b) => String(b.id) === bailleurId);
  const marches = useMemo(() => marchesResult?.data ?? [], [marchesResult?.data]);

  const kpis = useMemo(() => {
    const montantEngage = marches.reduce((s, m) => s + Number(m.montantTotal ?? 0), 0);
    const montantDecaisse = marches.reduce((s, m) => s + Number(m.montantDecaisse ?? 0), 0);
    const enCours = marches.filter((m) => m.statut === "EN_COURS").length;
    const termines = marches.filter((m) => m.statut === "TERMINE" || m.statut === "SOLDE").length;
    const now = new Date();
    const enRetard = marches.filter((m) =>
      m.statut === "EN_COURS" && m.dateFinPrevue && new Date(m.dateFinPrevue) < now
    ).length;
    const avancementMoyen = marches.length > 0
      ? marches.reduce((s, m) => s + (m.avancements?.[0]?.avancementPhysiqueReel ?? 0), 0) / marches.filter((m) => m.avancements?.[0]).length || 0
      : 0;
    return { montantEngage, montantDecaisse, enCours, termines, enRetard, avancementMoyen };
  }, [marches]);

  const tauxDecaissement = kpis.montantEngage > 0 ? (kpis.montantDecaisse / kpis.montantEngage) * 100 : 0;

  if (!bailleurs) return <p className="text-gray-400 p-6">Chargement...</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between no-print flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
            <Landmark className="h-4 w-4 text-blue-600" />
          </div>
          <div>
            <h1 className="text-base font-bold text-navy">Rapport bailleur</h1>
            <p className="text-xs text-gray-500">Suivi physique et financier — format synthèse trimestrielle</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={bailleurId}
              onChange={(e) => setBailleurId(e.target.value)}
              className="appearance-none rounded-lg border border-gray-200 bg-white px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            >
              <option value="">Tous les bailleurs</option>
              {bailleurs.map((b) => <option key={b.id} value={b.id}>{b.nom}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          </div>
          <Button onClick={printReport}>🖨 Imprimer / PDF</Button>
        </div>
      </div>

      <div className="printable-report space-y-4">
        {/* Print header */}
        <div className="hidden print:flex items-center gap-3 mb-2">
          <img src="/ageroute-logo.svg" alt="AGEROUTE" className="h-12 w-auto" />
          <div>
            <h1 className="text-lg font-bold text-navy">
              Rapport de suivi — {bailleur ? bailleur.nom : "Tous bailleurs"}
            </h1>
            <p className="text-xs text-gray-500">
              AGEROUTE Guinée — édité le {new Date().toLocaleDateString("fr-FR")} — période cumulée depuis signature
            </p>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard label="Montant engagé" value={fmtGnf(kpis.montantEngage)} icon="💰" accent="#1a2942" />
          <KpiCard
            label="Montant décaissé"
            value={fmtGnf(kpis.montantDecaisse)}
            sub={`${tauxDecaissement.toFixed(0)}% de l'engagé`}
            icon="💸"
            accent={tauxDecaissement >= 60 ? "#16a34a" : tauxDecaissement >= 30 ? "#f5a623" : "#dc2626"}
          />
          <KpiCard label="Marchés en cours" value={kpis.enCours} sub={`${kpis.termines} terminés/soldés`} icon="🚧" accent="#0891b2" />
          <KpiCard
            label="Marchés en retard"
            value={kpis.enRetard}
            sub={`Avancement physique moyen : ${kpis.avancementMoyen.toFixed(0)}%`}
            icon="⏱"
            accent={kpis.enRetard > 0 ? "#dc2626" : "#16a34a"}
          />
        </div>

        {/* Tableau des marchés */}
        <Card>
          <h3 className="text-sm font-semibold text-navy mb-3">
            Détail des marchés {bailleur ? `— ${bailleur.nom}` : "(tous bailleurs)"}
          </h3>
          {isLoading ? (
            <p className="text-sm text-gray-400 py-6 text-center">Chargement...</p>
          ) : marches.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">Aucun marché pour ce bailleur.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 uppercase">
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 pr-3">Marché</th>
                    <th className="text-left py-2 pr-3">Statut</th>
                    <th className="text-right py-2 pr-3">Montant</th>
                    <th className="text-right py-2 pr-3">Décaissé</th>
                    <th className="text-right py-2 pr-3">Avanc. physique</th>
                    <th className="text-left py-2 pr-3">Fin prévue</th>
                    <th className="text-left py-2">Alerte</th>
                  </tr>
                </thead>
                <tbody>
                  {marches.map((m) => {
                    const now = new Date();
                    const enRetard = m.statut === "EN_COURS" && m.dateFinPrevue && new Date(m.dateFinPrevue) < now;
                    const dernierAv = m.avancements?.[0];
                    const pctDecaisse = m.montantTotal && Number(m.montantTotal) > 0
                      ? (Number(m.montantDecaisse ?? 0) / Number(m.montantTotal)) * 100
                      : 0;
                    return (
                      <tr key={m.id} className="border-b border-gray-50">
                        <td className="py-2 pr-3 font-medium text-navy max-w-[240px] truncate" title={m.intitule}>{m.intitule}</td>
                        <td className="py-2 pr-3 text-gray-600">{STATUT_LABEL[m.statut]}</td>
                        <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{fmtGnf(m.montantTotal)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                          {fmtGnf(m.montantDecaisse)} <span className="text-gray-400">({pctDecaisse.toFixed(0)}%)</span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {dernierAv ? `${dernierAv.avancementPhysiqueReel}%` : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{fmtDate(m.dateFinPrevue)}</td>
                        <td className="py-2">
                          {enRetard ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                              <AlertTriangle className="h-3 w-3" /> Retard
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <p className="text-[10px] text-gray-400 text-center pb-2 no-print">
          Rapport généré automatiquement à partir des données réelles BDRI — méthodologie et pondérations disponibles sur demande.
        </p>
      </div>
    </div>
  );
}
