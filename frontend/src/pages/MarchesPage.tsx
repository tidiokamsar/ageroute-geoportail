import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, TrendingUp, X, Search, Wallet, Trash2, Briefcase } from "lucide-react";
import { EntityListPage, FilterSelect } from "./EntityListPage";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { parseApiError } from "../lib/errors";
import { toast } from "../lib/toast";
import { api } from "../lib/api";
import { marcheFields } from "../lib/fieldConfigs";
import type { Marche, Bailleur, PaginatedResult, Chantier, AvancementMarche, StatutMarche, Decompte, DecompteType, DecompteStatut } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUT_META: Record<StatutMarche, { label: string; pill: string; dot: string }> = {
  PLANIFIE:  { label: "Planifié",  pill: "bg-slate-100 text-slate-700",  dot: "bg-slate-500" },
  EN_COURS:  { label: "En cours",  pill: "bg-blue-100 text-blue-700",    dot: "bg-blue-500" },
  SUSPENDU:  { label: "Suspendu",  pill: "bg-amber-100 text-amber-700",  dot: "bg-amber-500" },
  TERMINE:   { label: "Terminé",   pill: "bg-green-100 text-green-700",  dot: "bg-green-500" },
  SOLDE:     { label: "Soldé",     pill: "bg-purple-100 text-purple-700",dot: "bg-purple-500" },
};

function fmtMontant(montant: string | null | undefined, devise: string): string {
  if (!montant) return "—";
  const n = Number(montant);
  if (devise === "GNF") {
    if (n >= 1e9) return `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Md GNF`;
    if (n >= 1e6) return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} M GNF`;
    return `${n.toLocaleString("fr-FR")} GNF`;
  }
  return `${n.toLocaleString("fr-FR")} ${devise}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function StatutPill({ statut }: { statut: StatutMarche }) {
  const m = STATUT_META[statut];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

// ── Modal : liaison chantiers ───────────────────────────────────────────────────

function ChantiersLinkModal({ marche, onClose }: { marche: Marche; onClose: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: fullMarche } = useQuery({
    queryKey: ["marches", "detail", marche.id],
    queryFn: async () => (await api.get<Marche>(`/marches/${marche.id}`)).data,
  });
  const attached = fullMarche?.chantiers ?? [];
  const attachedIds = new Set(attached.map((l) => l.chantierId));

  const { data: candidates } = useQuery({
    queryKey: ["chantiers", "search", search],
    queryFn: async () => (await api.get<PaginatedResult<Chantier>>("/chantiers", { params: { search: search || undefined, pageSize: 15 } })).data,
    enabled: search.length >= 2,
  });

  const attach = useMutation({
    mutationFn: (chantierId: string) => api.post(`/marches/${marche.id}/chantiers`, { chantierId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marches"] });
      toast.success("Chantier lié");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const detach = useMutation({
    mutationFn: (chantierId: string) => api.delete(`/marches/${marche.id}/chantiers/${chantierId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marches"] });
      toast.success("Chantier détaché");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  return (
    <Modal open onClose={onClose} title={`Chantiers liés — ${marche.intitule}`}>
      <div className="space-y-4">
        <div>
          <p className="text-xs font-medium text-gray-500 mb-2">Chantiers actuellement liés ({attached.length})</p>
          {attached.length === 0 ? (
            <p className="text-sm text-gray-400 italic">Aucun chantier lié à ce marché.</p>
          ) : (
            <div className="space-y-1.5">
              {attached.map((l) => (
                <div key={l.chantierId} className="flex items-center justify-between rounded-lg bg-navy/5 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-navy truncate">{l.chantier?.intitule ?? l.chantierId}</p>
                    {l.troncon && <p className="text-xs text-gray-500">{l.troncon.code} — {l.troncon.nom}</p>}
                  </div>
                  <button
                    onClick={() => detach.mutate(l.chantierId)}
                    className="h-6 w-6 shrink-0 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                    title="Détacher"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 mb-2">Lier un nouveau chantier</p>
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <Input
              placeholder="Rechercher un chantier (min. 2 caractères)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {search.length >= 2 && (
            <div className="max-h-48 overflow-y-auto space-y-1">
              {(candidates?.data ?? []).filter((c) => !attachedIds.has(c.id)).map((c) => (
                <button
                  key={c.id}
                  onClick={() => attach.mutate(c.id)}
                  disabled={attach.isPending}
                  className="w-full text-left rounded-lg border border-gray-200 px-3 py-2 hover:border-navy/40 hover:bg-navy/5 transition-colors flex items-center justify-between gap-2"
                >
                  <span className="text-sm text-gray-700 truncate">{c.intitule}</span>
                  <Link2 className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                </button>
              ))}
              {candidates && candidates.data.filter((c) => !attachedIds.has(c.id)).length === 0 && (
                <p className="text-xs text-gray-400 italic py-2">Aucun résultat.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Modal : avancement mensuel (courbe en S) ───────────────────────────────────

function AvancementModal({ marche, onClose }: { marche: Marche; onClose: () => void }) {
  const qc = useQueryClient();
  const today = new Date();
  const [periode, setPeriode] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);
  const [physiquePrevu, setPhysiquePrevu] = useState(0);
  const [physiqueReel, setPhysiqueReel] = useState(0);
  const [financierPrevu, setFinancierPrevu] = useState(0);
  const [financierReel, setFinancierReel] = useState(0);

  const { data: avancements } = useQuery({
    queryKey: ["marches", marche.id, "avancement"],
    queryFn: async () => (await api.get<AvancementMarche[]>(`/marches/${marche.id}/avancement`)).data,
  });

  const save = useMutation({
    mutationFn: () => api.post(`/marches/${marche.id}/avancement`, {
      periode: `${periode}-01`,
      avancementPhysiquePrevu: physiquePrevu,
      avancementPhysiqueReel: physiqueReel,
      avancementFinancierPrevu: financierPrevu,
      avancementFinancierReel: financierReel,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marches", marche.id, "avancement"] });
      toast.success("Avancement enregistré");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  return (
    <Modal open onClose={onClose} title={`Avancement mensuel — ${marche.intitule}`}>
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-200 p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500">Saisir / mettre à jour un mois</p>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Période</label>
            <input
              type="month"
              value={periode}
              onChange={(e) => setPeriode(e.target.value)}
              className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Physique prévu (%)", value: physiquePrevu, set: setPhysiquePrevu },
              { label: "Physique réel (%)", value: physiqueReel, set: setPhysiqueReel },
              { label: "Financier prévu (%)", value: financierPrevu, set: setFinancierPrevu },
              { label: "Financier réel (%)", value: financierReel, set: setFinancierReel },
            ].map(({ label, value, set }) => (
              <div key={label}>
                <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                <Input type="number" min={0} max={100} value={value} onChange={(e) => set(Number(e.target.value))} />
              </div>
            ))}
          </div>
          <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
            {save.isPending ? "Enregistrement…" : "Enregistrer ce mois"}
          </Button>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 mb-2">Historique ({avancements?.length ?? 0} mois)</p>
          {avancements && avancements.length > 0 ? (
            <div className="overflow-x-auto max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-gray-400 uppercase">
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-1.5">Période</th>
                    <th className="text-right py-1.5">Phys. prévu</th>
                    <th className="text-right py-1.5">Phys. réel</th>
                    <th className="text-right py-1.5">Fin. prévu</th>
                    <th className="text-right py-1.5">Fin. réel</th>
                  </tr>
                </thead>
                <tbody>
                  {avancements.map((a) => (
                    <tr key={a.id} className="border-b border-gray-50">
                      <td className="py-1.5 font-medium text-navy">{a.periode.slice(0, 7)}</td>
                      <td className="py-1.5 text-right tabular-nums">{a.avancementPhysiquePrevu}%</td>
                      <td className="py-1.5 text-right tabular-nums">{a.avancementPhysiqueReel}%</td>
                      <td className="py-1.5 text-right tabular-nums text-gray-500">{a.avancementFinancierPrevu}%</td>
                      <td className="py-1.5 text-right tabular-nums text-gray-500">{a.avancementFinancierReel}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">Aucune saisie d'avancement pour ce marché.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Modal : décaissements (décomptes) ───────────────────────────────────────────

const DECOMPTE_TYPE_LABEL: Record<DecompteType, string> = {
  AVANCE: "Avance", DECOMPTE: "Décompte", RETENUE_GARANTIE: "Retenue de garantie", SOLDE: "Solde",
};
const DECOMPTE_STATUT_META: Record<DecompteStatut, { label: string; pill: string }> = {
  EMIS:   { label: "Émis",  pill: "bg-slate-100 text-slate-700" },
  PAYE:   { label: "Payé",  pill: "bg-green-100 text-green-700" },
  REJETE: { label: "Rejeté",pill: "bg-red-100 text-red-700" },
};

function DecaissementsModal({ marche, onClose }: { marche: Marche; onClose: () => void }) {
  const qc = useQueryClient();
  const [numero, setNumero] = useState(1);
  const [type, setType] = useState<DecompteType>("DECOMPTE");
  const [montant, setMontant] = useState(0);
  const [statut, setStatut] = useState<DecompteStatut>("EMIS");
  const [datePaiement, setDatePaiement] = useState("");

  const { data: decomptes } = useQuery({
    queryKey: ["marches", marche.id, "decomptes"],
    queryFn: async () => (await api.get<Decompte[]>(`/marches/${marche.id}/decomptes`)).data,
  });

  const totalDecaisse = (decomptes ?? []).filter((d) => d.statut === "PAYE").reduce((s, d) => s + Number(d.montantGnf), 0);
  const montantTotal = Number(marche.montantTotal ?? 0);
  const tauxPct = montantTotal > 0 ? Math.min(100, (totalDecaisse / montantTotal) * 100) : 0;

  const create = useMutation({
    mutationFn: () => api.post(`/marches/${marche.id}/decomptes`, {
      numero, type, montantGnf: montant, statut,
      datePaiement: statut === "PAYE" && datePaiement ? datePaiement : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marches"] });
      qc.invalidateQueries({ queryKey: ["marches", marche.id, "decomptes"] });
      toast.success("Décompte enregistré");
      setNumero((n) => n + 1); setMontant(0); setDatePaiement("");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/decomptes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marches"] });
      qc.invalidateQueries({ queryKey: ["marches", marche.id, "decomptes"] });
      toast.success("Décompte supprimé");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  return (
    <Modal open onClose={onClose} title={`Décaissements — ${marche.intitule}`}>
      <div className="space-y-4">
        <div className="rounded-lg bg-navy/5 border border-navy/10 p-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-gray-500">Décaissé sur montant engagé</span>
            <span className="font-semibold text-navy">{tauxPct.toFixed(0)}%</span>
          </div>
          <div className="h-2 rounded-full bg-white overflow-hidden">
            <div className="h-full rounded-full bg-green-500" style={{ width: `${tauxPct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-gray-500">
            {fmtMontant(String(totalDecaisse), marche.devise)} décaissés sur {fmtMontant(marche.montantTotal, marche.devise)}
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 p-3 space-y-3">
          <p className="text-xs font-medium text-gray-500">Nouveau décompte</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">N° décompte</label>
              <Input type="number" min={1} value={numero} onChange={(e) => setNumero(Number(e.target.value))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as DecompteType)}
                className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
              >
                {(Object.entries(DECOMPTE_TYPE_LABEL) as [DecompteType, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Montant (GNF)</label>
              <Input type="number" min={0} value={montant} onChange={(e) => setMontant(Number(e.target.value))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Statut</label>
              <select
                value={statut}
                onChange={(e) => setStatut(e.target.value as DecompteStatut)}
                className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
              >
                {(Object.entries(DECOMPTE_STATUT_META) as [DecompteStatut, { label: string }][]).map(([v, m]) => (
                  <option key={v} value={v}>{m.label}</option>
                ))}
              </select>
            </div>
            {statut === "PAYE" && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Date de paiement</label>
                <input
                  type="date"
                  value={datePaiement}
                  onChange={(e) => setDatePaiement(e.target.value)}
                  className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
                />
              </div>
            )}
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || montant <= 0} className="w-full">
            {create.isPending ? "Enregistrement…" : "Ajouter le décompte"}
          </Button>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 mb-2">Historique ({decomptes?.length ?? 0})</p>
          {decomptes && decomptes.length > 0 ? (
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {decomptes.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-navy">
                      N°{d.numero} — {DECOMPTE_TYPE_LABEL[d.type]}
                    </p>
                    <p className="text-xs text-gray-500">
                      {fmtMontant(d.montantGnf, marche.devise)} {d.datePaiement && `· payé le ${fmtDate(d.datePaiement)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${DECOMPTE_STATUT_META[d.statut].pill}`}>
                      {DECOMPTE_STATUT_META[d.statut].label}
                    </span>
                    <button
                      onClick={() => remove.mutate(d.id)}
                      className="h-6 w-6 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                      title="Supprimer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">Aucun décompte enregistré.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Page : enveloppe EntityListPage (consolidation) ──────────────────────────
// Spécifique conservé : colonnes financières (montant, % décaissé cliquable,
// chantiers liés, mois d'avancement) ouvrant les trois modales métier
// (liaison chantiers, courbe en S, décaissements/décomptes), filtres
// statut/bailleur.

export function MarchesPage() {
  const [statutFilter, setStatutFilter] = useState("");
  const [bailleurFilter, setBailleurFilter] = useState("");
  const [chantiersFor, setChantiersFor] = useState<Marche | null>(null);
  const [avancementFor, setAvancementFor] = useState<Marche | null>(null);
  const [decaissementsFor, setDecaissementsFor] = useState<Marche | null>(null);

  const { data: bailleurs } = useQuery({
    queryKey: ["bailleurs"],
    queryFn: async () => (await api.get<Bailleur[]>("/bailleurs")).data,
  });

  const columns: ColumnDef<Marche, unknown>[] = [
    {
      id: "intitule",
      header: "Marché",
      cell: ({ row: { original: m } }) => (
        <span className="text-left text-sm font-semibold text-navy">{m.intitule}</span>
      ),
    },
    {
      id: "bailleur",
      header: "Bailleur",
      cell: ({ row: { original: m } }) => <span className="text-sm text-gray-600">{m.bailleur?.nom ?? "—"}</span>,
    },
    {
      id: "montant",
      header: () => <span className="block text-right w-full">Montant</span>,
      cell: ({ row: { original: m } }) => (
        <span className="block text-right text-sm text-gray-700 tabular-nums pr-2">{fmtMontant(m.montantTotal, m.devise)}</span>
      ),
    },
    {
      accessorKey: "statut",
      header: "Statut",
      cell: ({ row: { original: m } }) => <StatutPill statut={m.statut} />,
    },
    {
      id: "dateFinPrevue",
      header: "Fin prévue",
      cell: ({ row: { original: m } }) => <span className="text-xs text-gray-500">{fmtDate(m.dateFinPrevue)}</span>,
    },
    {
      id: "decaisse",
      header: "Décaissé",
      cell: ({ row: { original: m } }) => {
        const pct = m.montantTotal && Number(m.montantTotal) > 0
          ? Math.min(100, (Number(m.montantDecaisse ?? 0) / Number(m.montantTotal)) * 100)
          : 0;
        return (
          <button onClick={() => setDecaissementsFor(m)} className="flex items-center gap-1.5 group" title="Voir les décaissements">
            <Wallet className="h-3 w-3 text-gray-400 group-hover:text-navy" />
            <div className="w-12 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs font-medium text-gray-600 group-hover:text-navy tabular-nums">{pct.toFixed(0)}%</span>
          </button>
        );
      },
    },
    {
      id: "chantiers",
      header: "Chantiers",
      cell: ({ row: { original: m } }) => (
        <button
          onClick={() => setChantiersFor(m)}
          className="inline-flex items-center gap-1 text-xs font-medium text-navy hover:underline"
        >
          <Link2 className="h-3 w-3" /> {m.chantiers?.length ?? 0} lié(s)
        </button>
      ),
    },
    {
      id: "avancement",
      header: "Avancement",
      cell: ({ row: { original: m } }) => (
        <button
          onClick={() => setAvancementFor(m)}
          className="inline-flex items-center gap-1 text-xs font-medium text-navy hover:underline"
        >
          <TrendingUp className="h-3 w-3" /> {m._count?.avancements ?? 0} mois
        </button>
      ),
    },
  ];

  return (
    <EntityListPage<Marche>
      endpoint="marches"
      title="Marchés"
      subtitle="Marchés, décomptes et avancement"
      pageIcon={<Briefcase className="h-4 w-4 text-emerald-600" />}
      searchPlaceholder="Rechercher un marché…"
      columns={columns}
      fields={marcheFields}
      auditEntityType="Marche"
      extraParams={{
        statut: statutFilter || undefined,
        bailleurId: bailleurFilter || undefined,
      }}
      filters={
        <>
          <FilterSelect value={statutFilter} onChange={setStatutFilter}>
            <option value="">Tous les statuts</option>
            {(Object.entries(STATUT_META) as [StatutMarche, { label: string }][]).map(([v, m]) => (
              <option key={v} value={v}>{m.label}</option>
            ))}
          </FilterSelect>
          <FilterSelect value={bailleurFilter} onChange={setBailleurFilter}>
            <option value="">Tous les bailleurs</option>
            {(bailleurs ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.nom}</option>)}
          </FilterSelect>
        </>
      }
    >
      {chantiersFor && <ChantiersLinkModal marche={chantiersFor} onClose={() => setChantiersFor(null)} />}
      {avancementFor && <AvancementModal marche={avancementFor} onClose={() => setAvancementFor(null)} />}
      {decaissementsFor && <DecaissementsModal marche={decaissementsFor} onClose={() => setDecaissementsFor(null)} />}
    </EntityListPage>
  );
}
