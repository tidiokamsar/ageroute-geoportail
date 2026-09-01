import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown, Plus, Search, Camera, UserPlus,
  ArrowRightCircle, Clock, AlertTriangle, Wrench,
} from "lucide-react";
import { useEntityMutations } from "../hooks/useEntity";
import { DataTable } from "../components/DataTable";
import { EntityForm } from "../components/EntityForm";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, KpiCard } from "../components/ui/Card";
import { useAuth, canWrite } from "../lib/auth";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";
import { toast } from "../lib/toast";
import { api } from "../lib/api";
import { otFields } from "../lib/fieldConfigs";
import type { OrdreTravaux, OtStats, PaginatedResult, PrioriteOT, StatutOT, TypePhotoOT } from "../types";

// ── Constantes ────────────────────────────────────────────────────────────────

const PRIORITE_META: Record<PrioriteOT, { label: string; pill: string; dot: string }> = {
  URGENTE: { label: "Urgente", pill: "bg-red-100 text-red-700", dot: "bg-red-500" },
  HAUTE: { label: "Haute", pill: "bg-orange-100 text-orange-700", dot: "bg-orange-500" },
  NORMALE: { label: "Normale", pill: "bg-blue-100 text-blue-700", dot: "bg-blue-500" },
  BASSE: { label: "Basse", pill: "bg-gray-100 text-gray-600", dot: "bg-gray-400" },
};

const STATUT_META: Record<StatutOT, { label: string; pill: string }> = {
  BROUILLON: { label: "Brouillon", pill: "bg-gray-100 text-gray-600" },
  ASSIGNE: { label: "Assigné", pill: "bg-indigo-100 text-indigo-700" },
  EN_COURS: { label: "En cours", pill: "bg-blue-100 text-blue-700" },
  SUSPENDU: { label: "Suspendu", pill: "bg-amber-100 text-amber-700" },
  TERMINE: { label: "Terminé", pill: "bg-green-100 text-green-700" },
  ANNULE: { label: "Annulé", pill: "bg-gray-100 text-gray-400" },
  CONVERTI_CHANTIER: { label: "Converti en chantier", pill: "bg-purple-100 text-purple-700" },
};

const TYPE_LABEL: Record<string, string> = {
  REPARATION_CHAUSSEE: "Réparation chaussée", CURAGE_ASSAINISSEMENT: "Curage assainissement",
  SIGNALISATION: "Signalisation", DEBROUSSAILLAGE: "Débroussaillage",
  OUVRAGE_ART_MINEUR: "Ouvrage d'art mineur", URGENCE_SECURITE: "Urgence sécurité", AUTRE: "Autre",
};

const TRANSITIONS: Record<StatutOT, StatutOT[]> = {
  BROUILLON: ["ASSIGNE", "ANNULE"],
  ASSIGNE: ["EN_COURS", "BROUILLON", "ANNULE"],
  EN_COURS: ["SUSPENDU", "TERMINE", "ANNULE"],
  SUSPENDU: ["EN_COURS", "ANNULE"],
  TERMINE: [],
  ANNULE: [],
  CONVERTI_CHANTIER: [],
};

function fmtGnf(v: string | null | undefined): string {
  if (!v) return "—";
  const n = Number(v);
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Md GNF`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} M GNF`;
  return `${n.toLocaleString("fr-FR")} GNF`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function PrioritePill({ p }: { p: PrioriteOT }) {
  const m = PRIORITE_META[p];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function StatutPill({ s }: { s: StatutOT }) {
  const m = STATUT_META[s];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>{m.label}</span>;
}

function FilterSelect({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
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

// ── Photo vignette authentifiée ──────────────────────────────────────────────

function OtPhotoThumb({ fileName, onDelete, canRemove }: { fileName: string; onDelete: () => void; canRemove: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    api.get(`/photos/${fileName}`, { responseType: "blob" }).then((res) => {
      url = URL.createObjectURL(res.data as Blob);
      setSrc(url);
    }).catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [fileName]);

  return (
    <div className="relative group rounded-lg overflow-hidden border border-gray-200 bg-gray-50 aspect-square">
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">…</div>}
      {canRemove && (
        <button onClick={onDelete} className="absolute top-1 right-1 bg-red-600/90 text-white rounded-full w-5 h-5 text-xs leading-none opacity-0 group-hover:opacity-100 transition">×</button>
      )}
    </div>
  );
}

// ── Modal détail : photos, historique, workflow ─────────────────────────────

function OtDetailModal({ ot, onClose }: { ot: OrdreTravaux; onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [photoType, setPhotoType] = useState<TypePhotoOT>("AVANT");
  const [commentaire, setCommentaire] = useState("");
  const [assigneId, setAssigneId] = useState("");

  const { data: detail } = useQuery({
    queryKey: ["ordres-travaux", "detail", ot.id],
    queryFn: async () => (await api.get<OrdreTravaux>(`/ordres-travaux/${ot.id}`)).data,
  });
  const current = detail ?? ot;

  const { data: assignables } = useQuery({
    queryKey: ["ordres-travaux", "assignables"],
    queryFn: async () => (await api.get<{ id: string; nomComplet: string; role: string }[]>("/ordres-travaux/assignables")).data,
    enabled: canWrite(user?.role),
  });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["ordres-travaux"] });
  }

  const changeStatut = useMutation({
    mutationFn: (statut: StatutOT) => api.post(`/ordres-travaux/${ot.id}/statut`, { statut, commentaire: commentaire || undefined }),
    onSuccess: () => { toast.success("Statut mis à jour"); setCommentaire(""); invalidateAll(); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const assigner = useMutation({
    mutationFn: () => api.post(`/ordres-travaux/${ot.id}/assigner`, { assigneAId: assigneId }),
    onSuccess: () => { toast.success("OT assigné"); setAssigneId(""); invalidateAll(); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const convertir = useMutation({
    mutationFn: () => api.post(`/ordres-travaux/${ot.id}/convertir-chantier`),
    onSuccess: () => { toast.success("Converti en chantier"); invalidateAll(); onClose(); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const uploadPhoto = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("photo", file);
      fd.append("type", photoType);
      return api.post(`/ordres-travaux/${ot.id}/photos`, fd);
    },
    onSuccess: () => { toast.success("Photo ajoutée"); qc.invalidateQueries({ queryKey: ["ordres-travaux", "detail", ot.id] }); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const deletePhoto = useMutation({
    mutationFn: (photoId: string) => api.delete(`/ordres-travaux/${ot.id}/photos/${photoId}`),
    onSuccess: () => { toast.success("Photo supprimée"); qc.invalidateQueries({ queryKey: ["ordres-travaux", "detail", ot.id] }); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const transitions = TRANSITIONS[current.statut];
  const photosByType: Record<TypePhotoOT, typeof current.photos> = { AVANT: [], PENDANT: [], APRES: [] };
  (current.photos ?? []).forEach((p) => photosByType[p.type]?.push(p));

  return (
    <Modal open onClose={onClose} title={`${current.numero} — ${current.titre}`}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <StatutPill s={current.statut} />
          <PrioritePill p={current.priorite} />
          <span className="text-xs text-gray-400">{TYPE_LABEL[current.typeIntervention]}</span>
        </div>

        {current.description && <p className="text-sm text-gray-600">{current.description}</p>}

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><span className="text-gray-400">Région</span><p className="font-medium text-navy">{current.region?.nom ?? "—"}</p></div>
          <div><span className="text-gray-400">Tronçon</span><p className="font-medium text-navy">{current.troncon?.code ?? "—"}</p></div>
          <div><span className="text-gray-400">Assigné à</span><p className="font-medium text-navy">{current.assigneA?.nomComplet ?? "Non assigné"}</p></div>
          <div><span className="text-gray-400">Échéance</span><p className="font-medium text-navy">{fmtDate(current.dateEcheance)}</p></div>
          <div><span className="text-gray-400">Coût estimé</span><p className="font-medium text-navy">{fmtGnf(current.coutEstimeGnf)}</p></div>
          <div><span className="text-gray-400">Coût réel</span><p className="font-medium text-navy">{fmtGnf(current.coutReelGnf)}</p></div>
        </div>

        {current.coutEstimeGnf && Number(current.coutEstimeGnf) > 50_000_000 && current.statut !== "CONVERTI_CHANTIER" && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-xs text-amber-700 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Coût estimé élevé — envisager un marché public</span>
            {canWrite(user?.role) && (
              <Button size="sm" variant="secondary" onClick={() => convertir.mutate()} disabled={convertir.isPending}>
                <ArrowRightCircle className="h-3.5 w-3.5 mr-1" /> Convertir en chantier
              </Button>
            )}
          </div>
        )}

        {/* Assignation */}
        {canWrite(user?.role) && ["BROUILLON", "ASSIGNE"].includes(current.statut) && (
          <div className="rounded-lg border border-gray-200 p-3 space-y-2">
            <p className="text-xs font-medium text-gray-500 flex items-center gap-1.5"><UserPlus className="h-3.5 w-3.5" /> Assigner</p>
            <div className="flex gap-2">
              <select value={assigneId} onChange={(e) => setAssigneId(e.target.value)} className="flex-1 rounded-md border border-gray-200 px-3 py-1.5 text-sm">
                <option value="">— Choisir un agent —</option>
                {(assignables ?? []).map((a) => <option key={a.id} value={a.id}>{a.nomComplet} ({a.role})</option>)}
              </select>
              <Button size="sm" onClick={() => assigner.mutate()} disabled={!assigneId || assigner.isPending}>Assigner</Button>
            </div>
          </div>
        )}

        {/* Transitions de statut */}
        {transitions.length > 0 && (
          <div className="rounded-lg border border-gray-200 p-3 space-y-2">
            <p className="text-xs font-medium text-gray-500">Changer le statut</p>
            <Input placeholder="Commentaire (optionnel)" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} />
            <div className="flex gap-2 flex-wrap">
              {transitions.map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={t === "ANNULE" ? "danger" : "secondary"}
                  onClick={async () => {
                    if (t === "ANNULE" && !(await confirm("Annuler cet ordre de travaux ?", { danger: true }))) return;
                    changeStatut.mutate(t);
                  }}
                  disabled={changeStatut.isPending}
                >
                  {STATUT_META[t].label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Photos */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-500">Photos</p>
            {canWrite(user?.role) && (
              <div className="flex items-center gap-2">
                <select value={photoType} onChange={(e) => setPhotoType(e.target.value as TypePhotoOT)} className="rounded-md border border-gray-200 px-2 py-1 text-xs">
                  <option value="AVANT">Avant</option>
                  <option value="PENDANT">Pendant</option>
                  <option value="APRES">Après</option>
                </select>
                <label className="inline-flex items-center gap-1.5 rounded-md bg-navy/5 text-navy px-2.5 py-1 text-xs cursor-pointer hover:bg-navy/10">
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto.mutate(f); e.target.value = ""; }} />
                  <Camera className="h-3.5 w-3.5" /> Ajouter
                </label>
              </div>
            )}
          </div>
          {(["AVANT", "PENDANT", "APRES"] as TypePhotoOT[]).map((t) => photosByType[t] && photosByType[t]!.length > 0 && (
            <div key={t}>
              <p className="text-[10px] text-gray-400 uppercase mb-1">{t === "AVANT" ? "Avant" : t === "PENDANT" ? "Pendant" : "Après"}</p>
              <div className="grid grid-cols-4 gap-2">
                {photosByType[t]!.map((p) => (
                  <OtPhotoThumb key={p.id} fileName={p.fileName} canRemove={canWrite(user?.role)} onDelete={() => deletePhoto.mutate(p.id)} />
                ))}
              </div>
            </div>
          ))}
          {(current.photos ?? []).length === 0 && <p className="text-xs text-gray-400 italic">Aucune photo.</p>}
        </div>

        {/* Historique */}
        <div>
          <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> Historique</p>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {(current.historique ?? []).map((h) => (
              <div key={h.id} className="text-xs border-l-2 border-navy/20 pl-2.5 py-0.5">
                <span className="font-medium text-navy">{h.action}</span>
                {h.commentaire && <span className="text-gray-500"> — {h.commentaire}</span>}
                <p className="text-[10px] text-gray-400">{h.user?.nomComplet ?? "Système"} · {new Date(h.createdAt).toLocaleString("fr-FR")}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      {confirmDialog}
    </Modal>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function OrdresTravauxPage() {
  const { user } = useAuth();
  const [statutFilter, setStatutFilter] = useState("");
  const [prioriteFilter, setPrioriteFilter] = useState("");
  const [vue, setVue] = useState<"mes-ot" | "tous">("tous");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailOt, setDetailOt] = useState<OrdreTravaux | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["ordres-travaux", "list", { page, statutFilter, prioriteFilter, search, vue }],
    queryFn: async () => (await api.get<PaginatedResult<OrdreTravaux>>("/ordres-travaux", {
      params: {
        page, pageSize: 20, search: search || undefined,
        etat: statutFilter || undefined, priorite: prioriteFilter || undefined,
        aTraiter: vue === "mes-ot" ? "1" : undefined,
      },
    })).data,
  });

  const { data: stats } = useQuery({
    queryKey: ["ordres-travaux", "stats"],
    queryFn: async () => (await api.get<OtStats>("/ordres-travaux/stats")).data,
  });

  const { create } = useEntityMutations("ordres-travaux");
  const rows = useMemo(() => data?.data ?? [], [data?.data]);

  async function handleSubmit(values: Record<string, unknown>) {
    setFormError(null); setFieldErrors({});
    try {
      const created = await create.mutateAsync(values) as unknown as { data: OrdreTravaux };
      setModalOpen(false);
      if (created?.data?.suggestionConversion) {
        toast.info("Coût estimé élevé — envisagez une conversion en chantier/marché");
      }
    } catch (err) {
      const { message, fieldErrors: fe } = parseApiError(err);
      setFormError(message); setFieldErrors(fe);
    }
  }

  const columns: ColumnDef<OrdreTravaux, unknown>[] = [
    {
      id: "numero",
      header: "N° / Titre",
      cell: ({ row: { original: o } }) => (
        <button onClick={() => setDetailOt(o)} className="text-left">
          <p className="text-sm font-semibold text-navy hover:underline">{o.numero}</p>
          <p className="text-xs text-gray-500 truncate max-w-[220px]">{o.titre}</p>
        </button>
      ),
    },
    {
      id: "type",
      header: "Type",
      cell: ({ row: { original: o } }) => <span className="text-xs text-gray-600">{TYPE_LABEL[o.typeIntervention]}</span>,
    },
    {
      id: "priorite",
      header: "Priorité",
      cell: ({ row: { original: o } }) => <PrioritePill p={o.priorite} />,
    },
    {
      id: "statut",
      header: "Statut",
      cell: ({ row: { original: o } }) => <StatutPill s={o.statut} />,
    },
    {
      id: "assigneA",
      header: "Assigné à",
      cell: ({ row: { original: o } }) => <span className="text-xs text-gray-600">{o.assigneA?.nomComplet ?? "—"}</span>,
    },
    {
      id: "echeance",
      header: "Échéance",
      cell: ({ row: { original: o } }) => <span className="text-xs text-gray-500">{fmtDate(o.dateEcheance)}</span>,
    },
    {
      id: "photos",
      header: "Photos",
      cell: ({ row: { original: o } }) => (
        <span className="inline-flex items-center gap-1 text-xs text-gray-400"><Camera className="h-3 w-3" /> {o._count?.photos ?? 0}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row: { original: o } }) => (
        <button onClick={() => setDetailOt(o)} className="text-xs text-navy hover:underline">Ouvrir</button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] rounded-xl p-5 text-white flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
            <Wrench className="h-5 w-5 text-gold" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Ordres de travaux</h1>
            <p className="text-white/60 text-sm">Interventions courtes entre l'alerte et le chantier</p>
          </div>
        </div>
        {canWrite(user?.role) && (
          <Button onClick={() => { setFormError(null); setFieldErrors({}); setModalOpen(true); }} className="bg-white/10 hover:bg-white/20 text-white border border-white/20">
            <Plus className="h-4 w-4 mr-1" /> Nouvel OT
          </Button>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard label="OT ouverts" value={stats.ouverts} icon="🛠" accent="#1a2942" />
          <KpiCard label="OT terminés" value={stats.termines} icon="✅" accent="#16a34a" />
          <KpiCard label="Délai moyen" value={stats.delaiMoyenJours != null ? `${stats.delaiMoyenJours} j` : "—"} icon="⏱" accent="#0891b2" />
          <KpiCard
            label="Preuve photo"
            value={stats.tauxPreuvePhotoPct != null ? `${stats.tauxPreuvePhotoPct}%` : "—"}
            sub={stats.deriveCoutMoyenPct != null ? `Dérive coût moy. ${stats.deriveCoutMoyenPct > 0 ? "+" : ""}${stats.deriveCoutMoyenPct}%` : undefined}
            icon="📸"
            accent="#f5a623"
          />
        </div>
      )}

      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button className={`px-3 py-1.5 text-xs font-semibold ${vue === "mes-ot" ? "bg-navy text-white" : "bg-white text-gray-500"}`} onClick={() => { setVue("mes-ot"); setPage(1); }}>Mes OT</button>
            <button className={`px-3 py-1.5 text-xs font-semibold ${vue === "tous" ? "bg-navy text-white" : "bg-white text-gray-500"}`} onClick={() => { setVue("tous"); setPage(1); }}>Tous</button>
          </div>
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <Input placeholder="Rechercher..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="pl-9" />
          </div>
          <FilterSelect value={statutFilter} onChange={(v) => { setStatutFilter(v); setPage(1); }}>
            <option value="">Tous statuts</option>
            {Object.entries(STATUT_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </FilterSelect>
          <FilterSelect value={prioriteFilter} onChange={(v) => { setPrioriteFilter(v); setPage(1); }}>
            <option value="">Toutes priorités</option>
            {Object.entries(PRIORITE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </FilterSelect>
        </div>
      </Card>

      <DataTable<OrdreTravaux>
        data={rows}
        columns={columns}
        page={data?.page ?? 1}
        totalPages={data?.totalPages ?? 1}
        total={data?.total ?? 0}
        loading={isLoading}
        onPageChange={setPage}
        onSortChange={() => {}}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nouvel ordre de travaux">
        <EntityForm
          fields={otFields}
          defaultValues={{ priorite: "NORMALE" }}
          onSubmit={handleSubmit}
          submitting={create.isPending}
          serverError={formError}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {detailOt && <OtDetailModal ot={detailOt} onClose={() => setDetailOt(null)} />}
    </div>
  );
}
