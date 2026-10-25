import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Route, RotateCcw } from "lucide-react";
import { EntityListPage, FilterSelect } from "./EntityListPage";
import { TronconFicheModal } from "../components/TronconFicheModal";
import { RouteEntreVilles } from "../components/RouteEntreVilles";
import { SyntheseReferentiel } from "../components/SyntheseReferentiel";
import { EtatBadge } from "../components/ui/Badge";
import { api } from "../lib/api";
import { tronconFields } from "../lib/fieldConfigs";
import type { Troncon, Region, ClasseRoute, EtatPatrimoine } from "../types";
import { formaterPk } from "../lib/pk";

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
  NON_CLASSEE: { short: "NC", label: "Non classée",  pill: "bg-gray-100 text-gray-600" },
};

/**
 * Repli pour une classe absente de la table.
 *
 * Le 05/09/2026, la page est tombee en production sur « Cannot read properties of
 * undefined (reading pill) » : `NON_CLASSEE` avait ete ajoute a l'enum de la base
 * sans l'etre ici. Le type est desormais aligne, donc le compilateur l'aurait
 * signale — mais une page de consultation ne doit pas s'effondrer parce qu'une valeur
 * lui est inconnue. Elle affiche ce qu'elle recoit.
 */
const REPLI_CLASSE = { short: "?", label: "Classe inconnue", pill: "bg-gray-100 text-gray-600" };

const REVETEMENT_LABELS: Record<string, string> = {
  BITUME: "Bitume", TERRE: "Terre", LATERITE: "Latérite", PAVE: "Pavé",
  NON_RENSEIGNE: "Non renseigné",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ClassePill({ classe }: { classe: ClasseRoute }) {
  const m = CLASSE_META[classe] ?? REPLI_CLASSE;
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
            ? "text-[11px] text-gray-500"
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



function PkCell({ pkDebut, pkFin, onEdit, canEdit }: {
  pkDebut: number; pkFin: number; onEdit: () => void; canEdit: boolean;
}) {
  if (pkDebut === 0 && pkFin === 0) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-orange-700 font-medium whitespace-nowrap">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        Non renseigné
        {canEdit && (
          <button onClick={onEdit} className="underline text-orange-700 hover:text-orange-800 ml-0.5">
            Renseigner
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="text-xs font-mono text-gray-600 whitespace-nowrap tabular-nums">
      {formaterPk(pkDebut, { prefixe: false })} → {formaterPk(pkFin, { prefixe: false })}
    </span>
  );
}

// ── Page : enveloppe EntityListPage (consolidation) ──────────────────────────
// Spécifique conservé : cellules métier (code technique import, badge segment,
// pill classe RP/VU/PR, notation PK 1+400), fiche tronçon, stats d'axes segmentés.
//
// LES FILTRES VIVENT DANS L'URL (BDRI, lot B) : ouvrir la carte puis revenir les retrouve, un lien les partage.
// Ils sont tous SERVEUR, y compris « PK non renseignés » et « sans tracé » : l'ancien filtre PK s'appliquait aux
// 20 lignes de la page courante et faisait mentir la pagination. L'export reçoit les mêmes filtres.

const FILTRES = ["region", "type", "etat", "revetement", "pk", "geometrie"] as const;

export function TronconsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filtre = (k: (typeof FILTRES)[number]) => params.get(k) ?? "";
  const changer = (k: (typeof FILTRES)[number]) => (v: string) =>
    setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const filtresActifs = FILTRES.some((k) => params.get(k));
  const reinitialiser = () => setParams((p) => { const n = new URLSearchParams(p); FILTRES.forEach((k) => n.delete(k)); return n; }, { replace: true });
  const [ficheId, setFicheId] = useState<string | null>(null);
  const [pageRows, setPageRows] = useState<Troncon[]>([]);

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  // Segments par axe métier (calcul sur les lignes chargées, comme historiquement)
  const segmentCounts = useMemo(() => {
    const axisCounts: Record<string, number> = {};
    pageRows.forEach((t) => {
      if (!isTechnicalCode(t.code)) {
        const ax = axisCode(t.code);
        axisCounts[ax] = (axisCounts[ax] ?? 0) + 1;
      }
    });
    const result: Record<string, number> = {};
    pageRows.forEach((t) => { result[t.code] = axisCounts[axisCode(t.code)] ?? 1; });
    return result;
  }, [pageRows]);

  const topAxis = useMemo(() => {
    const axisCounts: Record<string, number> = {};
    pageRows.forEach((t) => {
      if (!isTechnicalCode(t.code)) {
        const ax = axisCode(t.code);
        axisCounts[ax] = (axisCounts[ax] ?? 0) + 1;
      }
    });
    const top = Object.entries(axisCounts).sort((a, b) => b[1] - a[1])[0];
    return top ? { axis: top[0], count: top[1] } : null;
  }, [pageRows]);

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
      header: () => <span className="block text-right w-full">Longueur déclarée</span>,
      cell: ({ row: { original: t } }) => (
        <span className="block text-right text-sm text-gray-600 tabular-nums pr-2">
          {t.longueurKm > 0 ? `${t.longueurKm.toFixed(1)} km` : "non renseignée"}
          <span className="block text-[11px] text-gray-500">
            {t.aGeometrie === false ? "sans tracé" : t.longueurGeometriqueKm != null ? `tracé ${t.longueurGeometriqueKm.toFixed(1)} km` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "pk",
      header: "PK début → fin",
      cell: ({ row: { original: t } }) => (
        <PkCell pkDebut={t.pkDebut} pkFin={t.pkFin} canEdit={false} onEdit={() => {}} />
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
  ];

  return (
    <EntityListPage<Troncon>
      endpoint="troncons"
      title="Tronçons"
      subtitle="Référentiel du réseau routier"
      pageIcon={<Route className="h-4 w-4 text-indigo-600" />}
      searchPlaceholder="Rechercher un tronçon…"
      columns={columns}
      fields={tronconFields}
      importExport
      exportTable="troncons"
      auditEntityType="Troncon"
      extraParams={Object.fromEntries(FILTRES.map((k) => [k, filtre(k) || undefined]))}
      onRowsLoaded={setPageRows}
      aboveList={
        <div className="space-y-3">
          <SyntheseReferentiel
            regionId={(regions ?? []).find((r) => r.nom === filtre("region"))?.id}
            onFiltre={(cle, valeur) => changer(cle)(valeur)}
          />
          <RouteEntreVilles />
        </div>
      }
      filters={
        <>
          <FilterSelect label="Région" value={filtre("region")} onChange={changer("region")}>
            <option value="">Toutes les régions</option>
            {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
          </FilterSelect>
          <FilterSelect label="Classe" value={filtre("type")} onChange={changer("type")}>
            <option value="">Toutes les classes</option>
            <option value="RN">Route Nationale (RN)</option>
            <option value="RR">Route Préfectorale (RP)</option>
            <option value="RU">Voirie Urbaine (VU)</option>
            <option value="PISTE">Piste Rurale (PR)</option>
            <option value="NON_CLASSEE">Non classée</option>
          </FilterSelect>
          <FilterSelect label="État" value={filtre("etat")} onChange={changer("etat")}>
            <option value="">Tous les états</option>
            <option value="BON">Bon</option>
            <option value="MOYEN">Moyen</option>
            <option value="MAUVAIS">Mauvais</option>
            <option value="CRITIQUE">Critique</option>
            <option value="NON_EVALUE">Non évalué</option>
          </FilterSelect>
          <FilterSelect label="Revêtement" value={filtre("revetement")} onChange={changer("revetement")}>
            <option value="">Tous les revêtements</option>
            {Object.entries(REVETEMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </FilterSelect>
          <FilterSelect label="PK" value={filtre("pk")} onChange={changer("pk")}>
            <option value="">PK : tous</option>
            <option value="non_renseigne">PK non renseignés</option>
            <option value="renseigne">PK renseignés</option>
          </FilterSelect>
          <FilterSelect label="Tracé" value={filtre("geometrie")} onChange={changer("geometrie")}>
            <option value="">Tracé : tous</option>
            <option value="absente">Sans tracé</option>
            <option value="presente">Avec tracé</option>
          </FilterSelect>
          {filtresActifs && (
            <button type="button" onClick={reinitialiser} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Réinitialiser les filtres
            </button>
          )}
          {topAxis && (
            <span className="text-xs text-gray-500 self-center ml-1 whitespace-nowrap">
              <span className="text-gray-500 font-medium">{topAxis.axis}</span>
              {" : "}{topAxis.count} segments regroupés
            </span>
          )}
        </>
      }
      rowExtraActions={[
        { label: "Carte", onClick: (t) => navigate(`/geoportail?select=troncon&id=${t.id}`), visible: (t) => t.aGeometrie !== false },
      ]}
    >
      {ficheId && (
        <TronconFicheModal open={!!ficheId} onClose={() => setFicheId(null)} tronconId={ficheId} />
      )}
    </EntityListPage>
  );
}
