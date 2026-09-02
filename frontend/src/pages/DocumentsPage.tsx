import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FileSpreadsheet, Image as ImageIcon, File as FileIcon, Download, Trash2, Inbox, ChevronDown, Search } from "lucide-react";
import { api } from "../lib/api";
import { useAuth, canWrite } from "../lib/auth";
import { parseApiError } from "../lib/errors";
import { downloadViaApi } from "../lib/download";
import { useConfirm } from "../hooks/useConfirm";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Input";
import { DocTypeBadge } from "../components/ui/Badge";
import { TronconPicker } from "../components/TronconPicker";
import type { Document, DocumentType, PaginatedResult } from "../types";

const TYPE_LABELS: Record<DocumentType, string> = {
  ARRETE: "Arrêté",
  CAHIER_CHARGES: "Cahier des charges",
  CAHIER_ENGAGEMENT: "Cahier d'engagement",
  AUTRE: "Autre",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function FileTypeIcon({ fileName, mimeType }: { fileName: string; mimeType: string }) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/") || ["jpg", "jpeg", "png", "webp"].includes(ext)) {
    return <ImageIcon className="h-4 w-4 text-purple-500" />;
  }
  if (ext === "pdf") return <FileText className="h-4 w-4 text-red-500" />;
  if (["doc", "docx"].includes(ext)) return <FileSpreadsheet className="h-4 w-4 text-blue-500" />;
  return <FileIcon className="h-4 w-4 text-gray-400" />;
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
        className={`appearance-none rounded-lg px-3 py-1.5 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20 ${
          active
            ? "border border-navy/40 bg-navy/5 text-navy font-medium"
            : "border border-gray-200 bg-white text-gray-600"
        }`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
    </div>
  );
}

export function DocumentsPage() {
  const { user } = useAuth();
  const writable = canWrite(user?.role);
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [typeFilter, setTypeFilter] = useState("");
  const [anneeFilter, setAnneeFilter] = useState("");
  const [tronconFilter, setTronconFilter] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [titre, setTitre] = useState("");
  const [type, setType] = useState<DocumentType>("ARRETE");
  const [annee, setAnnee] = useState("");
  const [tronconId, setTronconId] = useState<string | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["documents", typeFilter, anneeFilter, tronconFilter, search],
    queryFn: async () =>
      (
        await api.get<PaginatedResult<Document>>("/documents", {
          params: { type: typeFilter || undefined, annee: anneeFilter || undefined, tronconId: tronconFilter, search: search || undefined, pageSize: 100 },
        })
      ).data,
  });

  function resetForm() {
    setTitre("");
    setType("ARRETE");
    setAnnee("");
    setTronconId(undefined);
    setFile(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Veuillez sélectionner un fichier.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("titre", titre);
      formData.append("type", type);
      if (annee) formData.append("annee", annee);
      if (tronconId) formData.append("tronconId", tronconId);
      formData.append("file", file);
      await api.post("/documents", formData);
      await qc.invalidateQueries({ queryKey: ["documents"] });
      setModalOpen(false);
      resetForm();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!(await confirm("Supprimer ce document ?", { danger: true }))) return;
    await api.delete(`/documents/${id}`);
    await qc.invalidateQueries({ queryKey: ["documents"] });
  }

  return (
    <div className="space-y-3">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="h-8 w-8 rounded-lg bg-slate-50 flex items-center justify-center shrink-0">
          <FileText className="h-4 w-4 text-slate-600" />
        </div>
        <div>
          <h1 className="text-base font-bold text-navy">Documents</h1>
          <p className="text-xs text-gray-500">Bibliothèque des documents réglementaires et techniques</p>
        </div>
      </div>

      {/* Ligne 1 : recherche + bouton ajouter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher par titre..."
            className="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
          />
        </div>
        <div className="ml-auto">
          {writable && (
            <Button
              onClick={() => {
                resetForm();
                setModalOpen(true);
              }}
            >
              + Ajouter un document
            </Button>
          )}
        </div>
      </div>

      {/* Ligne 2 : filtres horizontaux */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterSelect value={typeFilter} onChange={setTypeFilter}>
          <option value="">Tous les types</option>
          {Object.entries(TYPE_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </FilterSelect>
        <div className="relative">
          <input
            value={anneeFilter}
            onChange={(e) => setAnneeFilter(e.target.value)}
            placeholder="Année..."
            type="number"
            className="appearance-none rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-navy/20"
          />
        </div>
        <div className="w-64">
          <TronconPicker value={tronconFilter} onChange={setTronconFilter} />
        </div>
      </div>

      {/* Count */}
      <div className="flex items-center justify-end px-1">
        <span className="text-sm text-gray-400">
          {(data?.total ?? 0).toLocaleString("fr-FR")} document{(data?.total ?? 0) !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="rounded-xl bg-white shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50/80 text-gray-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3 w-8"></th>
              <th className="text-left px-4 py-3">Titre</th>
              <th className="text-left px-4 py-3">Type</th>
              <th className="text-left px-4 py-3">Année</th>
              <th className="text-left px-4 py-3">Tronçon</th>
              <th className="text-left px-4 py-3">Taille</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={7} className="px-4 py-3.5">
                    <div className="h-3.5 rounded bg-gray-100 animate-pulse" style={{ width: `${80 - i * 8}%` }} />
                  </td>
                </tr>
              ))}
            {!isLoading && data?.data.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  <div className="flex flex-col items-center gap-2">
                    <Inbox className="h-8 w-8 text-gray-300" />
                    <span>Aucun document.</span>
                  </div>
                </td>
              </tr>
            )}
            {data?.data.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3"><FileTypeIcon fileName={d.fileName} mimeType={d.mimeType} /></td>
                <td className="px-4 py-3 font-medium text-navy">{d.titre}</td>
                <td className="px-4 py-3"><DocTypeBadge type={d.type} /></td>
                <td className="px-4 py-3">{d.annee ?? "—"}</td>
                <td className="px-4 py-3">{d.troncon ? `${d.troncon.code} — ${d.troncon.nom}` : "—"}</td>
                <td className="px-4 py-3 text-gray-500">{formatSize(d.sizeBytes)}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => downloadViaApi(`/documents/${d.id}/download`, d.fileName)}
                      title="Télécharger"
                      className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-navy hover:bg-navy/5 transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    {writable && (
                      <button onClick={() => handleDelete(d.id)} title="Supprimer" className="h-7 w-7 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Ajouter un document"
        sale={() => titre.trim() !== "" || !!file}
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Titre</label>
            <input
              value={titre}
              onChange={(e) => setTitre(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
            <Select value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
              {Object.entries(TYPE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Année</label>
            <input
              value={annee}
              onChange={(e) => setAnnee(e.target.value)}
              type="number"
              className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tronçon concerné</label>
            <TronconPicker value={tronconId} onChange={setTronconId} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Fichier (pdf, doc, image)</label>
            <input
              type="file"
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
              className="w-full text-sm"
            />
          </div>
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Envoi..." : "Enregistrer"}
          </Button>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  );
}
