import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Clock, Map, ClipboardList, Download, ChevronDown, AlertCircle, Tag } from "lucide-react";
import { api } from "../lib/api";
import type { AlertesData, EtatPatrimoine } from "../types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "Jamais inspecté";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function joursRetard(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

const ETAT_BADGE: Record<EtatPatrimoine, { bg: string; text: string; label: string }> = {
  CRITIQUE: { bg: "bg-red-100", text: "text-red-700", label: "Critique" },
  MAUVAIS:  { bg: "bg-orange-100", text: "text-orange-700", label: "Mauvais" },
  MOYEN:    { bg: "bg-yellow-100", text: "text-yellow-700", label: "Moyen" },
  BON:      { bg: "bg-green-100", text: "text-green-700", label: "Bon" },
  NON_EVALUE: { bg: "bg-gray-100", text: "text-gray-600", label: "Non évalué" },
};

const ETAT_BORDER: Record<EtatPatrimoine, string> = {
  CRITIQUE: "border-l-red-500",
  MAUVAIS:  "border-l-orange-400",
  MOYEN:    "border-l-yellow-300",
  BON:      "",
  NON_EVALUE: "",
};

const ETAT_ORDER: Record<EtatPatrimoine, number> = {
  CRITIQUE: 0, MAUVAIS: 1, MOYEN: 2, BON: 3, NON_EVALUE: 4,
};

function EtatBadge({ etat }: { etat: EtatPatrimoine }) {
  const s = ETAT_BADGE[etat];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.bg} ${s.text}`}>
      {s.label}
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
        className={`w-full appearance-none rounded-lg border px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20 transition-colors ${
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

// ── Main ───────────────────────────────────────────────────────────────────────

export function AlertesPage() {
  const navigate = useNavigate();
  const tronconsSectionRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "alertes"],
    queryFn: async () => (await api.get<AlertesData>("/dashboard/alertes")).data,
  });

  const [regionFilter, setRegionFilter]   = useState("");
  const [severiteFilter, setSeveriteFilter] = useState("");   // "" | "CRITIQUE" | "MAUVAIS"
  const [inspectionFilter, setInspectionFilter] = useState(""); // "" | "JAMAIS" | "INSPECTE"

  const regions = useMemo(() => {
    if (!data) return [];
    const s = new Set<string>();
    data.ouvragesCritiques.forEach((o) => o.region && s.add(o.region));
    data.chantiersEnRetard.forEach((c) => c.region && s.add(c.region));
    data.tronconsCritiquesNonInspectes.forEach((t) => t.region && s.add(t.region));
    return Array.from(s).sort();
  }, [data]);

  // Filtered ouvrages
  const ouvrages = useMemo(() => {
    if (!data) return [];
    return data.ouvragesCritiques
      .filter((o) => !regionFilter   || o.region === regionFilter)
      .filter((o) => !severiteFilter || o.etat   === severiteFilter)
      .filter((o) => {
        if (!inspectionFilter) return true;
        if (inspectionFilter === "JAMAIS")   return !o.derniereInspection;
        if (inspectionFilter === "INSPECTE") return !!o.derniereInspection;
        return true;
      })
      .sort((a, b) => ETAT_ORDER[a.etat] - ETAT_ORDER[b.etat]);
  }, [data, regionFilter, severiteFilter, inspectionFilter]);

  // Chantiers en retard
  const chantiersEnRetard = useMemo(() => {
    if (!data) return [];
    return data.chantiersEnRetard
      .filter((c) => !regionFilter || c.region === regionFilter)
      .sort((a, b) => joursRetard(b.dateFinPrevue) - joursRetard(a.dateFinPrevue));
  }, [data, regionFilter]);

  // Tronçons jamais inspectés
  const tronconsJamaisInspectes = useMemo(() => {
    if (!data) return [];
    return (data.tronconsJamaisInspectes ?? data.tronconsCritiquesNonInspectes)
      .filter((t) => !regionFilter || t.region === regionFilter)
      .sort((a, b) => ETAT_ORDER[a.etat] - ETAT_ORDER[b.etat]);
  }, [data, regionFilter]);

  // Export CSV simple
  function exportCsv() {
    const rows = ouvrages.map((o) => [
      o.nom, o.code ?? "", o.troncon ?? "", o.region ?? "",
      o.etat, o.derniereInspection ? formatDate(o.derniereInspection) : "Jamais inspecté",
    ]);
    const header = ["Ouvrage", "Code", "Tronçon", "Région", "État", "Dernière inspection"];
    const csv = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(";")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "alertes-ouvrages.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading || !data) return (
    <div className="flex items-center gap-3 text-gray-400 p-8 text-sm">
      <div className="h-4 w-4 border-2 border-gray-200 border-t-navy rounded-full animate-spin" />
      Chargement des alertes…
    </div>
  );

  const nbOuvragesCritiques  = data.ouvragesCritiques.filter((o) => o.etat === "CRITIQUE").length;
  const nbTronconsNonInsp    = tronconsJamaisInspectes.length;
  const nbChantiersEnRetard  = chantiersEnRetard.length;

  return (
    <div className="space-y-5 max-w-5xl">

      {/* ── Page header ── */}
      <div className="rounded-2xl bg-gradient-to-r from-red-600 to-red-700 px-6 py-5 text-white shadow-lg shadow-red-600/20 flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <AlertCircle className="h-6 w-6 text-red-200 shrink-0" />
          <div>
            <h1 className="text-lg font-bold">Alertes Réseau</h1>
            <p className="text-sm text-red-100/70">Tronçons et ouvrages en état dégradé nécessitant une intervention</p>
          </div>
        </div>
      </div>

      {/* ── Filtres ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterSelect value={regionFilter} onChange={(v) => setRegionFilter(v)}>
          <option value="">Toutes les régions</option>
          {regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </FilterSelect>
        <FilterSelect value={severiteFilter} onChange={(v) => setSeveriteFilter(v)}>
          <option value="">Toutes les sévérités</option>
          <option value="CRITIQUE">Critique uniquement</option>
          <option value="MAUVAIS">Mauvais uniquement</option>
        </FilterSelect>
        <FilterSelect value={inspectionFilter} onChange={(v) => setInspectionFilter(v)}>
          <option value="">Inspection : tous</option>
          <option value="JAMAIS">Jamais inspectés</option>
          <option value="INSPECTE">Déjà inspectés</option>
        </FilterSelect>
        <button
          onClick={exportCsv}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors shrink-0"
        >
          <Download className="h-3.5 w-3.5" /> Exporter la liste
        </button>
      </div>

      {/* ── KPI Cards (3) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">

        {/* Ouvrages critiques */}
        <div className={`rounded-xl border p-4 ${nbOuvragesCritiques > 0 ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"}`}>
          <p className={`text-sm font-medium ${nbOuvragesCritiques > 0 ? "text-red-500" : "text-gray-400"}`}>
            Ouvrages critiques
          </p>
          <p className={`text-4xl font-bold mt-1 ${nbOuvragesCritiques > 0 ? "text-red-600" : "text-gray-300"}`}>
            {nbOuvragesCritiques}
          </p>
        </div>

        {/* Chantiers en retard */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="flex items-center gap-1.5 text-sm text-gray-500">
            <Clock className="h-3.5 w-3.5 shrink-0" /> Chantiers en retard
          </p>
          <p className={`text-4xl font-bold mt-1 ${nbChantiersEnRetard > 0 ? "text-orange-600" : "text-gray-800"}`}>
            {nbChantiersEnRetard}
          </p>
          {nbChantiersEnRetard === 0 && (
            <p className="text-xs text-gray-400 mt-1.5 leading-snug">
              Fiabilité à vérifier : dates de fin souvent absentes
            </p>
          )}
        </div>

        {/* Tronçons non inspectés */}
        <div className={`rounded-xl border p-4 ${nbTronconsNonInsp > 0 ? "bg-amber-50 border-amber-200" : "bg-gray-50 border-gray-200"}`}>
          <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700">
            <Tag className="h-3.5 w-3.5 shrink-0" /> Tronçons non inspectés
          </p>
          <p className={`text-4xl font-bold mt-1 ${nbTronconsNonInsp > 0 ? "text-amber-700" : "text-gray-300"}`}>
            {nbTronconsNonInsp}
          </p>
          {nbTronconsNonInsp > 0 && (
            <button
              onClick={() => tronconsSectionRef.current?.scrollIntoView({ behavior: "smooth" })}
              className="text-xs text-amber-700 underline mt-1.5 hover:text-amber-900"
            >
              Voir la liste
            </button>
          )}
        </div>
      </div>

      {/* ── Tableau ouvrages ── */}
      {ouvrages.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <span className="inline-block h-4 w-1 rounded-full bg-red-500 shrink-0" />
              Ouvrages d'art en mauvais / critique état{" "}
              <span className="text-gray-400 font-normal">({ouvrages.length})</span>
            </h3>
            <span className="text-xs text-gray-400">Triés par sévérité</span>
          </div>
          <div className="rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500 font-medium">
                  <th className="text-left px-4 py-3">Ouvrage</th>
                  <th className="text-left px-4 py-3">Tronçon</th>
                  <th className="text-left px-4 py-3">Région</th>
                  <th className="text-left px-4 py-3">État</th>
                  <th className="text-left px-4 py-3">Dernière inspection</th>
                  <th className="text-right px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {ouvrages.map((o) => (
                  <tr
                    key={o.id}
                    className={`border-l-4 hover:bg-gray-50/50 transition-colors ${ETAT_BORDER[o.etat]}`}
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-800">{o.nom}</span>
                      {o.code && (
                        <span className="ml-1.5 text-[11px] font-mono text-gray-400">{o.code}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {o.troncon ? (
                        <button
                          onClick={() => navigate(`/geoportail?select=troncon&q=${o.troncon}`)}
                          className="text-blue-600 hover:underline text-sm"
                        >
                          {o.troncon}
                        </button>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {o.region ?? <span className="text-gray-300">Non renseigné</span>}
                    </td>
                    <td className="px-4 py-3">
                      <EtatBadge etat={o.etat} />
                    </td>
                    <td className="px-4 py-3">
                      {!o.derniereInspection ? (
                        <span className="flex items-center gap-1.5 text-gray-400 text-xs">
                          <AlertCircle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                          Jamais inspecté
                        </span>
                      ) : (
                        <span className="text-gray-500 text-xs">{formatDate(o.derniereInspection)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => navigate(`/geoportail?select=ouvrage&id=${o.id}`)}
                          className="flex items-center gap-1 text-xs text-gray-500 hover:text-navy"
                        >
                          <Map className="h-3 w-3" /> Carte
                        </button>
                        <button
                          onClick={() => navigate("/inspections")}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                        >
                          <ClipboardList className="h-3 w-3" /> Planifier
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Chantiers en retard ── */}
      {chantiersEnRetard.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <span className="inline-block h-4 w-1 rounded-full bg-orange-400 shrink-0" />
            Chantiers en retard{" "}
            <span className="text-gray-400 font-normal">({chantiersEnRetard.length})</span>
          </h3>
          <div className="rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500 font-medium">
                  <th className="text-left px-4 py-3">Chantier</th>
                  <th className="text-left px-4 py-3">Entreprise</th>
                  <th className="text-left px-4 py-3">Région</th>
                  <th className="text-left px-4 py-3">Fin prévue</th>
                  <th className="text-left px-4 py-3">Retard</th>
                  <th className="text-left px-4 py-3">Avancement</th>
                  <th className="text-right px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {chantiersEnRetard.map((c) => {
                  const retard = joursRetard(c.dateFinPrevue);
                  return (
                    <tr key={c.id} className="border-l-4 border-l-orange-400 hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-800">{c.intitule}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{c.entreprise}</td>
                      <td className="px-4 py-3 text-gray-600">{c.region ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {c.dateFinPrevue ? new Date(c.dateFinPrevue).toLocaleDateString("fr-FR", { month: "short", year: "numeric" }) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${retard > 180 ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
                          {retard} j
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-2 rounded-full bg-gray-100 overflow-hidden">
                            <div className="h-full rounded-full bg-orange-400" style={{ width: `${c.avancementPct}%` }} />
                          </div>
                          <span className="text-xs text-gray-500">{c.avancementPct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => navigate(`/geoportail?select=chantier&id=${c.id}`)}
                          className="flex items-center gap-1 text-xs text-gray-500 hover:text-navy ml-auto"
                        >
                          <Map className="h-3 w-3" /> Carte
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tronçons jamais inspectés ── */}
      {tronconsJamaisInspectes.length > 0 && (
        <div ref={tronconsSectionRef}>
          <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <span className="inline-block h-4 w-1 rounded-full bg-amber-400 shrink-0" />
            Tronçons jamais inspectés{" "}
            <span className="text-gray-400 font-normal">({tronconsJamaisInspectes.length})</span>
          </h3>
          <div className="rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500 font-medium">
                  <th className="text-left px-4 py-3">Code</th>
                  <th className="text-left px-4 py-3">Nom</th>
                  <th className="text-left px-4 py-3">Classe</th>
                  <th className="text-left px-4 py-3">Région</th>
                  <th className="text-left px-4 py-3">État</th>
                  <th className="text-right px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {tronconsJamaisInspectes.map((t) => {
                  const classeLabels: Record<string, string> = {
                    RN: "Route Nationale", RR: "Route Préfectorale",
                    RU: "Voirie Urbaine", PISTE: "Piste Rurale",
                  };
                  return (
                    <tr key={t.id} className={`border-l-4 hover:bg-gray-50/50 transition-colors ${ETAT_BORDER[t.etat]}`}>
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">{t.code}</td>
                      <td className="px-4 py-3 font-medium text-gray-800 max-w-[200px]">
                        <span className="truncate block">{t.nom}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{classeLabels[t.classe] ?? t.classe}</td>
                      <td className="px-4 py-3 text-gray-600">{t.region ?? <span className="text-gray-300">Non renseigné</span>}</td>
                      <td className="px-4 py-3"><EtatBadge etat={t.etat} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => navigate(`/geoportail?select=troncon&id=${t.id}`)}
                            className="flex items-center gap-1 text-xs text-gray-500 hover:text-navy"
                          >
                            <Map className="h-3 w-3" /> Carte
                          </button>
                          <button
                            onClick={() => navigate("/inspections")}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                          >
                            <ClipboardList className="h-3 w-3" /> Planifier
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {ouvrages.length === 0 && chantiersEnRetard.length === 0 && tronconsJamaisInspectes.length === 0 && (
        <div className="rounded-xl border border-gray-100 bg-gray-50 py-12 text-center text-sm text-gray-400">
          Aucune alerte pour cette sélection.
        </div>
      )}
    </div>
  );
}
