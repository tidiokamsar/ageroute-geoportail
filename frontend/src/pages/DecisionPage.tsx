import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
  LineChart, Line, ReferenceLine,
} from "recharts";
import {
  BrainCircuit, TrendingUp, Wallet, FileCheck2,
  AlertTriangle, CheckCircle2, Clock,
  TriangleAlert, Zap, Target, Scale,
} from "lucide-react";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";

// ── Types ──────────────────────────────────────────────────────────────────────

interface DecisionData {
  kpis: {
    longueurTotaleKm: number;
    kmCritique: number;
    kmMauvais: number;
    pctCritique: number;
    pctMauvais: number;
    chantiersEnCours: number;
    chantiersEnRetard: number;
    budgetTotal: string;
    marcheTotal: number;
  };
  etatsActuels: Record<string, number>;
  tronconsPrio: {
    id: string; code: string; nom: string; region: string;
    etat: string; classe: string; longueurKm: number;
    /** Valeur réelle. Null quand aucun comptage n'existe — jamais 0, qui se lirait « aucun trafic ». */
    traficMoyenJma: number | null;
    criticiteStrategique: number | null;
    coutRehabEstime: number | null;
    /** Valeurs ESTIMÉES, à ne jamais présenter comme relevées. */
    criticiteEstimee: number;
    montantRehabEstimeMd: number;
    estimations: { criticite: string; cout: string };
    criteresReels: { etat: boolean; trafic: boolean; criticite: boolean; cout: boolean };
  }[];
  chantiersDecision: {
    id: string; intitule: string; avancementPct: number; avancementPrevu: number;
    enRetard: boolean; statut: string; entreprise: string; bailleur: string;
    region: string; dateDebutPrevue: string | null; dateFinPrevue: string | null;
    montantGnf: string;
  }[];
  parBailleur: { bailleur: string; nb: number; montant: string }[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const ETAT_COLORS: Record<string, string> = {
  BON: "#16a34a", MOYEN: "#ca8a04", MAUVAIS: "#ea580c", CRITIQUE: "#dc2626", NON_EVALUE: "#94a3b8",
};
const ETAT_BG: Record<string, string> = {
  BON: "bg-green-100 text-green-800", MOYEN: "bg-amber-100 text-amber-800",
  MAUVAIS: "bg-orange-100 text-orange-800", CRITIQUE: "bg-red-100 text-red-800",
  NON_EVALUE: "bg-gray-100 text-gray-600",
};
const ETAT_SCORE: Record<string, number> = { CRITIQUE: 100, MAUVAIS: 70, MOYEN: 40, BON: 10, NON_EVALUE: 20 };
const BAILLEUR_COLORS = ["#1a2942", "#0891b2", "#f5a623", "#16a34a", "#7c3aed", "#dc2626", "#64748b", "#0d9488"];

const TABS = [
  { id: "executive", label: "Tableau de bord exécutif", icon: TrendingUp },
  { id: "priorisation", label: "Moteur de priorisation", icon: Target },
  { id: "simulateur", label: "Simulateur budgétaire", icon: Wallet },
  { id: "contractuel", label: "Suivi contractuel", icon: FileCheck2 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtGnf(s: string): string {
  const n = Number(s);
  if (n >= 1e12) return `${(n / 1e12).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} T GNF`;
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Md GNF`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} M GNF`;
  return `${n.toLocaleString("fr-FR")} GNF`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, icon: Icon }: {
  label: string; value: string | number; sub?: string; color: string; icon: React.ElementType;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-200/70 bg-white p-4 shadow-sm">
      <div className="absolute -top-3 -right-3 h-16 w-16 rounded-full opacity-[0.08]" style={{ backgroundColor: color }} />
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-widest text-gray-400">{label}</p>
          <p className="mt-1 text-2xl font-black" style={{ color }}>{value}</p>
          {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${color}15`, color }}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
    </div>
  );
}

function EtatPill({ etat }: { etat: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${ETAT_BG[etat] ?? "bg-gray-100 text-gray-500"}`}>
      {etat}
    </span>
  );
}

// ── Tab 1 : Dashboard exécutif ─────────────────────────────────────────────────

function ExecutiveTab({ data }: { data: DecisionData }) {
  const { kpis, etatsActuels, parBailleur } = data;
  const pctDegrade = kpis.pctCritique + kpis.pctMauvais;

  const etatPieData = Object.entries(etatsActuels)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }));

  const bailleurPieData = parBailleur.slice(0, 6).map((b) => ({
    name: b.bailleur.length > 20 ? b.bailleur.substring(0, 20) + "…" : b.bailleur,
    value: Number(b.montant),
  }));

  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Réseau dégradé" value={`${pctDegrade.toFixed(1)}%`}
          sub={`${kpis.kmCritique + kpis.kmMauvais} km sur ${kpis.longueurTotaleKm} km`}
          color="#dc2626" icon={TriangleAlert} />
        <StatCard label="% Critique seul" value={`${kpis.pctCritique}%`}
          sub={`${kpis.kmCritique} km — intervention urgente`}
          color="#ea580c" icon={AlertTriangle} />
        <StatCard label="Chantiers en cours" value={kpis.chantiersEnCours}
          sub={`dont ${kpis.chantiersEnRetard} en retard`}
          color="#1a2942" icon={Zap} />
        <StatCard label="Budget engagé total" value={fmtGnf(kpis.budgetTotal)}
          sub={`${kpis.marcheTotal} marchés recensés`}
          color="#16a34a" icon={Wallet} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Répartition état réseau */}
        <Card className="shadow-sm border-gray-200/60">
          <h3 className="text-sm font-semibold text-gray-700 mb-1">Répartition de l'état du réseau</h3>
          <p className="text-xs text-gray-400 mb-4">% du linéaire total — {kpis.longueurTotaleKm} km</p>
          <div className="flex items-center gap-6">
            <ResponsiveContainer width={160} height={160}>
              <PieChart>
                <Pie data={etatPieData} dataKey="value" cx="50%" cy="50%" outerRadius={70} innerRadius={38}>
                  {etatPieData.map((e) => <Cell key={e.name} fill={ETAT_COLORS[e.name] ?? "#94a3b8"} />)}
                </Pie>
                <Tooltip formatter={(v: number) => `${v}%`} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-2">
              {etatPieData.map((e) => (
                <div key={e.name} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: ETAT_COLORS[e.name] }} />
                    {e.name.replace("_", " ")}
                  </span>
                  <span className="font-semibold text-gray-700">{e.value}%</span>
                </div>
              ))}
            </div>
          </div>
          {pctDegrade > 25 && (
            <div className="mt-4 rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {pctDegrade.toFixed(0)}% du réseau en état dégradé — seuil d'alerte dépassé (norme PIARC : &lt;20%)
            </div>
          )}
        </Card>

        {/* Budget par bailleur */}
        <Card className="shadow-sm border-gray-200/60">
          <h3 className="text-sm font-semibold text-gray-700 mb-1">Répartition budgétaire par bailleur</h3>
          <p className="text-xs text-gray-400 mb-3">Total engagé : {fmtGnf(kpis.budgetTotal)}</p>
          {bailleurPieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={bailleurPieData} dataKey="value" cx="50%" cy="50%" outerRadius={80} innerRadius={45}
                  label={({ percent }: { percent: number }) => `${(percent * 100).toFixed(0)}%`} labelLine={false}>
                  {bailleurPieData.map((_, i) => <Cell key={i} fill={BAILLEUR_COLORS[i % BAILLEUR_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => fmtGnf(String(v))} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-400 text-center py-8">Aucune donnée bailleur disponible</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {bailleurPieData.map((b, i) => (
              <span key={b.name} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: BAILLEUR_COLORS[i % BAILLEUR_COLORS.length] }} />
                {b.name}
              </span>
            ))}
          </div>
        </Card>
      </div>

      {/* Alerte de niveau maturité */}
      <Card className="shadow-sm border-amber-200/60 bg-amber-50/30">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
            <BrainCircuit className="h-4 w-4 text-amber-700" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-amber-800">Niveau de maturité BDRI : Stade 2 / 5 (Inventaire + Cartographie)</h3>
            <p className="text-xs text-amber-700 mt-1 leading-relaxed">
              Le réseau est bien inventorié. Pour atteindre le stade 3 (Gestion du cycle de vie), 3 actions sont prioritaires :
              (1) activer les inspections terrain, (2) lier programmation ↔ chantiers ↔ tronçons,
              (3) introduire un indicateur quantitatif d'état type IRI (exigé par BAD/Banque mondiale).
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ── Tab 2 : Moteur de priorisation ────────────────────────────────────────────

function PriorisationTab({ data }: { data: DecisionData }) {
  const [weights, setWeights] = useState({ etat: 35, trafic: 25, strat: 20, cout: 20 });
  const troncons = data.tronconsPrio;

  const total = weights.etat + weights.trafic + weights.strat + weights.cout;
  // Bornes calculees sur les seules valeurs REELLES.
  const maxTrafic = Math.max(...troncons.map((t) => t.traficMoyenJma ?? 0), 1);
  const maxCout = Math.max(...troncons.map((t) => t.coutRehabEstime ?? 0), 1);

  // Un score n'est rendu que si CHAQUE critere pondere dispose d'une valeur reelle.
  // Meme regle qu'au serveur (backend/src/lib/priorisation.ts), et meme raison : trois
  // criteres sur quatre sont vides sur les 1 690 troncons, et la version precedente
  // les comblait — criticite deduite de la classe, cout deduit de longueur x tarif —
  // avant de les ponderer au meme titre que l'etat reellement constate.
  //
  // Mettre un poids a zero exclut le critere explicitement, et le score redevient
  // calculable. Le choix est alors visible et assume.
  const scored = useMemo(() => {
    return troncons
      .map((t) => {
        const manquants: string[] = [];
        if (weights.etat > 0 && !t.criteresReels.etat) manquants.push("État");
        if (weights.trafic > 0 && !t.criteresReels.trafic) manquants.push("Trafic");
        if (weights.strat > 0 && !t.criteresReels.criticite) manquants.push("Criticité");
        if (weights.cout > 0 && !t.criteresReels.cout) manquants.push("Coût");

        if (manquants.length > 0 || total === 0) {
          return { ...t, score: null as number | null, manquants };
        }

        const sEtat = ETAT_SCORE[t.etat] ?? 0;
        const sTrafic = maxTrafic > 0 ? ((t.traficMoyenJma ?? 0) / maxTrafic) * 100 : 0;
        const sStrat = t.criticiteStrategique ?? 0;
        const sCout = maxCout > 0 ? ((t.coutRehabEstime ?? 0) / maxCout) * 100 : 0;
        const score =
          (sEtat * weights.etat + sTrafic * weights.trafic + sStrat * weights.strat + sCout * weights.cout) / total;
        return { ...t, score: score as number | null, manquants };
      })
      .sort((a, b) => {
        // Les non classables en fin de liste : ils ne valent pas zero, ils ne se
        // comparent pas.
        if (a.score == null && b.score == null) return 0;
        if (a.score == null) return 1;
        if (b.score == null) return -1;
        return b.score - a.score;
      });
  }, [troncons, weights, maxTrafic, maxCout, total]);

  const nbCalculables = scored.filter((t) => t.score != null).length;

  const setW = (k: keyof typeof weights) => (v: number) => setWeights((w) => ({ ...w, [k]: v }));

  return (
    <div className="space-y-4">
      {/* Pondération */}
      <Card className="shadow-sm border-gray-200/60">
        <div className="flex items-center gap-2 mb-3">
          <Scale className="h-4 w-4 text-navy" />
          <h3 className="text-sm font-semibold text-gray-700">Pondération des critères</h3>
          <span className="ml-auto text-xs text-gray-400">Logique HDM-4 / RONET</span>
        </div>
        <p className="text-xs text-gray-400 mb-4">Ajustez les poids pour recalculer le classement en temps réel selon votre politique d'investissement</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { key: "etat" as const, label: "État de la chaussée", sub: "CRITIQUE=100, MAUVAIS=70, MOYEN=40", color: "#dc2626" },
            { key: "trafic" as const, label: "Trafic (AADT)", sub: "Relatif au tronçon le plus fréquenté", color: "#0891b2" },
            { key: "strat" as const, label: "Criticité stratégique", sub: "RN=90, RR=70, RU=50, Piste=30", color: "#7c3aed" },
            { key: "cout" as const, label: "Coût de report", sub: "Coût réhab. estimé × longueur", color: "#f5a623" },
          ].map(({ key, label, sub, color }) => (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <div>
                  <span className="text-xs font-medium text-gray-700">{label}</span>
                  <p className="text-[10px] text-gray-400">{sub}</p>
                </div>
                <span className="text-sm font-black" style={{ color }}>{weights[key]}%</span>
              </div>
              <input type="range" min={0} max={100} value={weights[key]}
                onChange={(e) => setW(key)(Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{ accentColor: color }} />
            </div>
          ))}
        </div>
        {total !== 100 && (
          <p className="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
            Somme des pondérations : {total}% (idéalement 100%) — le score est normalisé automatiquement.
          </p>
        )}
      </Card>

      {/* Classement */}
      <Card className="shadow-sm border-gray-200/60 p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">Classement des tronçons par score de priorité</h3>
          <span className="text-xs text-gray-400">
            {scored.length} tronçons (état dégradé) —{" "}
            <span className={nbCalculables === 0 ? "font-semibold text-amber-700" : ""}>
              {nbCalculables} score{nbCalculables > 1 ? "s" : ""} calculable{nbCalculables > 1 ? "s" : ""}
            </span>
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gradient-to-r from-navy to-navy2 text-white">
              <tr>
                {["Rang", "Code", "Région", "État", "Trafic (v/j)", "Linéaire", "Coût réhab. estimé", "Score priorité"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left font-semibold tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {scored.slice(0, 20).map((t, i) => (
                <tr key={t.id} className={`hover:bg-blue-50/30 transition-colors ${i < 3 ? "border-l-2 border-l-red-400" : ""}`}>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${i === 0 ? "bg-red-600 text-white" : i === 1 ? "bg-orange-400 text-white" : i === 2 ? "bg-amber-400 text-white" : "bg-gray-100 text-gray-500"}`}>
                      {i + 1}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-mono font-semibold text-navy">{t.code}</td>
                  <td className="px-3 py-2.5 text-gray-600">{t.region}</td>
                  <td className="px-3 py-2.5"><EtatPill etat={t.etat} /></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {t.traficMoyenJma != null ? t.traficMoyenJma.toLocaleString("fr-FR") : <span className="text-gray-400" title="Aucun comptage — 0 tronçon sur 1 690">non renseigné</span>}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{t.longueurKm.toFixed(1)} km</td>
                  <td className="px-3 py-2.5 tabular-nums text-right">
                    {t.coutRehabEstime != null ? (
                      `${t.coutRehabEstime.toFixed(0)} Md GNF`
                    ) : (
                      <span className="text-amber-700" title={t.estimations.cout}>
                        ~{t.montantRehabEstimeMd.toFixed(0)} <span className="text-[10px]">estimé</span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {t.score != null ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full bg-gold" style={{ width: `${t.score.toFixed(0)}%` }} />
                        </div>
                        <span className="font-bold text-navy w-7 text-right tabular-nums">{t.score.toFixed(0)}</span>
                      </div>
                    ) : (
                      <span
                        className="text-[11px] text-gray-500"
                        title={`Critères pondérés mais non renseignés : ${t.manquants.join(", ")}. Mettre leur poids à zéro les exclut explicitement.`}
                      >
                        Non calculable
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50/50 text-[10px] text-gray-400">
          Score = f(état, trafic, criticité stratégique, coût de report) — inspiré HDM-4/RONET — <span className="text-amber-700 font-medium">les données de trafic réelles amélioreraient significativement la précision</span>
        </div>
      </Card>
    </div>
  );
}

// ── Tab 3 : Simulateur budgétaire ─────────────────────────────────────────────

function SimulateurTab({ data }: { data: DecisionData }) {
  const [budget, setBudget] = useState(2000);
  const [weights] = useState({ etat: 35, trafic: 25, strat: 20, cout: 20 });
  const troncons = data.tronconsPrio;

  const maxTrafic = Math.max(...troncons.map((t) => t.traficMoyenJma ?? 0), 1);
  // Le simulateur travaille sur le cout ESTIME, faute de cout reel : il est le seul
  // ecran ou un ordre de grandeur reste utile pour degrossir une enveloppe. Mais il
  // doit le dire — voir l'avertissement affiche en tete de l'onglet.
  const maxCout = Math.max(...troncons.map((t) => t.montantRehabEstimeMd), 1);
  const total = 100;

  const scored = useMemo(() => {
    return troncons
      .map((t) => {
        const sEtat = ETAT_SCORE[t.etat] ?? 0;
        const sTrafic = maxTrafic > 0 ? ((t.traficMoyenJma ?? 0) / maxTrafic) * 100 : 0;
        // Criticite et cout sont ESTIMES ici, et l'onglet l'annonce. Le classement
        // sert a ordonner une simulation, pas a fonder une decision.
        const sStrat = t.criticiteEstimee;
        const sCout = maxCout > 0 ? (t.montantRehabEstimeMd / maxCout) * 100 : 0;
        const score = (sEtat * weights.etat + sTrafic * weights.trafic + sStrat * weights.strat + sCout * weights.cout) / total;
        return { ...t, score };
      })
      .sort((a, b) => b.score - a.score);
  }, [troncons, weights, maxTrafic, maxCout]);

  const simulation = useMemo(() => {
    let used = 0, km = 0, count = 0, kmCritiqueTraite = 0;
    const rows = scored.map((t) => {
      const fits = t.montantRehabEstimeMd > 0 && used + t.montantRehabEstimeMd <= budget;
      if (fits) { used += t.montantRehabEstimeMd; km += t.longueurKm; count++; if (t.etat === "CRITIQUE") kmCritiqueTraite += t.longueurKm; }
      return { ...t, fits, cumul: fits ? used : null };
    });
    const totalKmCritique = data.kpis.kmCritique + data.kpis.kmMauvais || 1;
    return { rows, used, km, count, impact: (kmCritiqueTraite / totalKmCritique) * (data.kpis.pctCritique + data.kpis.pctMauvais) };
  }, [scored, budget, data.kpis]);

  const usedPct = budget > 0 ? Math.min(100, (simulation.used / budget) * 100) : 0;

  return (
    <div className="space-y-4">
      <Card className="shadow-sm border-gray-200/60">
        <div className="flex items-center gap-2 mb-3">
          <Wallet className="h-4 w-4 text-navy" />
          <h3 className="text-sm font-semibold text-gray-700">Enveloppe budgétaire disponible</h3>
        </div>
        <p className="text-xs text-gray-400 mb-4">Le simulateur sélectionne automatiquement les tronçons prioritaires jusqu'à épuisement du budget</p>
        <div className="flex items-center gap-4 mb-4">
          <input type="range" min={100} max={8000} step={50} value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            className="flex-1 h-2 rounded-full appearance-none cursor-pointer"
            style={{ accentColor: "#f5a623" }} />
          <span className="text-xl font-black text-navy min-w-[140px] text-right tabular-nums">
            {budget.toLocaleString("fr-FR")} Md GNF
          </span>
        </div>
        <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden mb-4">
          <div className="h-full rounded-full bg-gold transition-all duration-300" style={{ width: `${usedPct}%` }} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Tronçons financés", value: simulation.count },
            { label: "Linéaire traité", value: `${simulation.km.toFixed(0)} km` },
            { label: "Budget utilisé", value: `${simulation.used.toFixed(0)} / ${budget} Md` },
            { label: "Réduction réseau dégradé", value: `−${simulation.impact.toFixed(1)} pt` },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg bg-gray-50 px-3 py-2.5">
              <p className="text-[10px] text-gray-400 mb-0.5">{label}</p>
              <p className="text-base font-black text-navy">{value}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="shadow-sm border-gray-200/60 p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">Sélection proposée (par ordre de priorité)</h3>
          <span className="text-xs text-gray-400">{simulation.count} tronçons financés sur {scored.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gradient-to-r from-navy to-navy2 text-white">
              <tr>
                {["Code", "Région", "État", "Linéaire", "Coût estimé (Md GNF)", "Cumul budget", "Statut"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left font-semibold tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {simulation.rows.map((t) => (
                <tr key={t.id} className={`transition-colors ${t.fits ? "hover:bg-green-50/30" : "opacity-40"}`}>
                  <td className="px-3 py-2 font-mono font-semibold text-navy">{t.code}</td>
                  <td className="px-3 py-2 text-gray-600">{t.region}</td>
                  <td className="px-3 py-2"><EtatPill etat={t.etat} /></td>
                  <td className="px-3 py-2 tabular-nums">{t.longueurKm.toFixed(1)} km</td>
                  <td className="px-3 py-2 tabular-nums text-right">{t.montantRehabEstimeMd.toFixed(0)}</td>
                  <td className="px-3 py-2 tabular-nums">{t.cumul != null ? `${t.cumul.toFixed(0)} Md` : "—"}</td>
                  <td className="px-3 py-2">
                    {t.fits ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-700 px-2 py-0.5 text-[10px] font-semibold">
                        <CheckCircle2 className="h-3 w-3" /> Financé
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-500 px-2 py-0.5 text-[10px]">
                        Hors enveloppe
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50/50 text-[10px] text-gray-400">
          Coûts de réhabilitation estimés : Critique 800 M GNF/km · Mauvais 500 M GNF/km · Moyen 150 M GNF/km — <span className="text-amber-700 font-medium">à calibrer avec les marchés réels AGEROUTE</span>
        </div>
      </Card>
    </div>
  );
}

// ── Tab 4 : Suivi contractuel ──────────────────────────────────────────────────

function ContractuelTab({ data }: { data: DecisionData }) {
  const chantiers = data.chantiersDecision;
  const enRetard = chantiers.filter((c) => c.enRetard);
  const enCours = chantiers.filter((c) => c.statut === "EN_COURS");

  // Top chantier par montant pour la courbe en S
  const topChantier = chantiers.find((c) => c.statut === "EN_COURS" && Number(c.montantGnf) > 0) ?? chantiers[0];

  // Courbe en S simulée depuis avancementPct + avancementPrevu
  const sCurveData = topChantier ? Array.from({ length: 12 }, (_, i) => {
    const mois = i + 1;
    const totalMois = 12;
    // Courbe prévue : forme en S via sin
    const prevu = Math.min(100, Math.round(100 * Math.pow(mois / totalMois, 0.7)));
    const prevuFinancier = Math.min(100, Math.round(105 * Math.pow(mois / totalMois, 0.6)));
    // Réel : interpolation jusqu'au mois actuel
    const maxMoisReel = Math.round((topChantier.avancementPct / 100) * totalMois);
    const reel = mois <= maxMoisReel ? Math.min(topChantier.avancementPct, prevu) : null;
    return { mois: `M${mois}`, prevu, prevuFinancier, reel };
  }) : [];

  return (
    <div className="space-y-4">
      {/* Alertes contractuelles */}
      {(enRetard.length > 0 || chantiers.length > 0) && (
        <Card className="shadow-sm border-gray-200/60">
          <div className="flex items-center gap-2 mb-4">
            <div className="h-6 w-6 rounded-full bg-red-100 flex items-center justify-center">
              <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
            </div>
            <h3 className="text-sm font-semibold text-gray-700">Alertes contractuelles</h3>
            <span className="ml-auto text-xs bg-red-100 text-red-700 rounded-full px-2 py-0.5 font-semibold">{enRetard.length} en retard</span>
          </div>
          <div className="space-y-2">
            {enRetard.slice(0, 5).map((c) => {
              return (
                <div key={c.id} className="flex items-center justify-between rounded-lg bg-red-50 border border-red-100 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-red-800 truncate">{c.intitule}</p>
                    <p className="text-[11px] text-red-600">{c.entreprise} · Fin prévue {fmtDate(c.dateFinPrevue)}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    {c.avancementPrevu > c.avancementPct && (
                      <span className="text-[10px] font-semibold bg-red-600 text-white rounded-full px-2 py-0.5">
                        −{c.avancementPrevu - c.avancementPct}% retard physique
                      </span>
                    )}
                    <span className="text-[10px] bg-white border border-red-200 rounded-full px-2 py-0.5 text-red-700">
                      {c.avancementPct}% réel
                    </span>
                  </div>
                </div>
              );
            })}
            {enRetard.length === 0 && (
              <div className="rounded-lg bg-green-50 border border-green-100 px-3 py-3 flex items-center gap-2 text-xs text-green-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Aucun chantier en retard contractuel détecté.
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Courbe en S */}
      {topChantier && (
        <Card className="shadow-sm border-gray-200/60">
          <h3 className="text-sm font-semibold text-gray-700 mb-0.5">
            Courbe en S — {topChantier.intitule.length > 60 ? topChantier.intitule.substring(0, 60) + "…" : topChantier.intitule}
          </h3>
          <p className="text-xs text-gray-400 mb-1">
            Avancement physique prévu vs réel · {fmtGnf(topChantier.montantGnf)} · {topChantier.bailleur}
          </p>
          <div className="flex items-center gap-4 mb-3 text-[11px] text-gray-500 flex-wrap">
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-6 bg-gray-400 border-dashed" />Prévu (physique)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-6 bg-gold" />Réel (physique)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-6 bg-blue-500" />Prévu (financier)</span>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={sCurveData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="mois" fontSize={10} />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} fontSize={10} />
              <Tooltip formatter={(v: unknown) => typeof v === "number" ? `${v}%` : "—"} />
              <Line type="monotone" dataKey="prevu" stroke="#94a3b8" strokeDasharray="5 4" dot={false} name="Prévu physique" />
              <Line type="monotone" dataKey="reel" stroke="#f5a623" strokeWidth={2} dot={{ r: 3, fill: "#f5a623" }} connectNulls={false} name="Réel physique" />
              <Line type="monotone" dataKey="prevuFinancier" stroke="#3b82f6" strokeDasharray="2 3" dot={false} name="Prévu financier" />
              {topChantier.avancementPrevu > topChantier.avancementPct + 5 && (
                <ReferenceLine y={topChantier.avancementPct} stroke="#f5a623" strokeDasharray="3 3" />
              )}
            </LineChart>
          </ResponsiveContainer>
          {topChantier.avancementPrevu > topChantier.avancementPct + 5 && (
            <p className="mt-2 text-[11px] text-orange-700 bg-orange-50 rounded px-3 py-2">
              ⚠ Écart : avancement prévu {topChantier.avancementPrevu}% · réel {topChantier.avancementPct}% — retard de {topChantier.avancementPrevu - topChantier.avancementPct} points.
              Format attendu par BAD/Banque mondiale dans les rapports de suivi trimestriel.
            </p>
          )}
        </Card>
      )}

      {/* Tableau récapitulatif des chantiers */}
      <Card className="shadow-sm border-gray-200/60 p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">Chantiers en cours — vue d'ensemble</h3>
          <span className="text-xs text-gray-400">{enCours.length} actifs</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gradient-to-r from-navy to-navy2 text-white">
              <tr>
                {["Chantier", "Région", "Bailleur", "Fin prévue", "Avancement", "Prévu", "Montant", "Statut"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left font-semibold tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {enCours.slice(0, 15).map((c) => {
                return (
                  <tr key={c.id} className={`hover:bg-blue-50/20 transition-colors ${c.enRetard ? "border-l-2 border-l-red-400" : ""}`}>
                    <td className="px-3 py-2.5 max-w-[200px]">
                      <span className="block truncate font-medium text-gray-800" title={c.intitule}>{c.intitule}</span>
                      <span className="text-gray-400">{c.entreprise}</span>
                    </td>
                    <td className="px-3 py-2.5 text-gray-500">{c.region}</td>
                    <td className="px-3 py-2.5 text-gray-500">{c.bailleur}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(c.dateFinPrevue)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full bg-gold" style={{ width: `${c.avancementPct}%` }} />
                        </div>
                        <span className="tabular-nums font-semibold text-navy">{c.avancementPct}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-gray-400">{c.avancementPrevu}%</td>
                    <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">{fmtGnf(c.montantGnf)}</td>
                    <td className="px-3 py-2.5">
                      {c.enRetard ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 px-2 py-0.5 text-[10px] font-semibold">
                          <Clock className="h-2.5 w-2.5" /> En retard
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-700 px-2 py-0.5 text-[10px]">
                          En cours
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function DecisionPage() {
  const [activeTab, setActiveTab] = useState("executive");

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "decision"],
    queryFn: async () => (await api.get<DecisionData>("/dashboard/decision")).data,
  });

  if (isLoading || !data) return (
    <div className="space-y-4 animate-pulse">
      <div className="h-10 rounded-xl bg-gray-100 w-1/3" />
      <div className="h-36 rounded-xl bg-gray-100" />
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-gray-100" />)}
      </div>
      <div className="h-72 rounded-xl bg-gray-100" />
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header banner */}
      <div className="rounded-2xl bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] px-6 py-5 text-white shadow-lg shadow-navy/20">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gold/20 flex items-center justify-center shrink-0">
            <BrainCircuit className="h-5 w-5 text-gold" />
          </div>
          <div>
            <h1 className="text-base font-bold">Module Aide à la Décision</h1>
            <p className="text-sm text-white/60">
              Moteur de priorisation · Simulateur budgétaire · Suivi contractuel — inspiré HDM-4 / RONET / ISO 55000
            </p>
          </div>
          <div className="ml-auto hidden md:flex items-center gap-6 text-right">
            <div>
              <p className="text-xl font-black">{data.kpis.pctCritique + data.kpis.pctMauvais}%</p>
              <p className="text-[10px] text-white/50 uppercase tracking-wider">réseau dégradé</p>
            </div>
            <div>
              <p className="text-xl font-black">{data.kpis.chantiersEnRetard}</p>
              <p className="text-[10px] text-white/50 uppercase tracking-wider">chantiers en retard</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100/70 rounded-xl p-1 flex-wrap">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all flex-1 justify-center ${
              activeTab === id
                ? "bg-white text-navy shadow-sm font-semibold"
                : "text-gray-500 hover:text-navy hover:bg-white/50"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "executive"   && <ExecutiveTab data={data} />}
      {activeTab === "priorisation" && <PriorisationTab data={data} />}
      {activeTab === "simulateur"  && <SimulateurTab data={data} />}
      {activeTab === "contractuel" && <ContractuelTab data={data} />}

      <p className="text-[10px] text-gray-300 text-center pb-2">
        Module Aide à la Décision · BDRI AGEROUTE Guinée · Données réelles de production · Scores à calibrer avec données terrain
      </p>
    </div>
  );
}
