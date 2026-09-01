import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { parseApiError } from "../lib/errors";
import { downloadViaApi } from "../lib/download";
import { useConfirm } from "../hooks/useConfirm";
import { Button } from "./ui/Button";
import { Select } from "./ui/Input";
import type { Document, DocumentType, PaginatedResult } from "../types";

const TYPE_LABELS: Record<DocumentType, string> = {
  ARRETE: "Arrêté",
  CAHIER_CHARGES: "Cahier des charges",
  CAHIER_ENGAGEMENT: "Cahier d'engagement",
  AUTRE: "Autre",
};

// Vue compacte de la base documentaire filtree sur un seul troncon, depuis sa fiche -
// reutilise l'API /documents (memes routes que le module "Base documentaire" complet),
// avec le tronconId fixe par le contexte comme dans FicheChildManager.
export function TronconDocumentsTab({ tronconId, canWrite }: { tronconId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [formOpen, setFormOpen] = useState(false);
  const [titre, setTitre] = useState("");
  const [type, setType] = useState<DocumentType>("ARRETE");
  const [annee, setAnnee] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["documents", "troncon", tronconId],
    queryFn: async () => (await api.get<PaginatedResult<Document>>("/documents", { params: { tronconId, pageSize: 50 } })).data,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setError("Veuillez sélectionner un fichier."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("titre", titre);
      formData.append("type", type);
      if (annee) formData.append("annee", annee);
      formData.append("tronconId", tronconId);
      formData.append("file", file);
      await api.post("/documents", formData);
      await qc.invalidateQueries({ queryKey: ["documents", "troncon", tronconId] });
      setFormOpen(false);
      setTitre("");
      setType("ARRETE");
      setAnnee("");
      setFile(null);
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!(await confirm("Supprimer ce document ?", { danger: true }))) return;
    await api.delete(`/documents/${id}`);
    await qc.invalidateQueries({ queryKey: ["documents", "troncon", tronconId] });
  }

  return (
    <div>
      {canWrite && (
        <div className="flex justify-end mb-2">
          <Button className="px-2 py-1 text-xs" onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? "Annuler" : "+ Ajouter un document"}
          </Button>
        </div>
      )}

      {formOpen && (
        <form onSubmit={handleSubmit} className="space-y-2 mb-3 p-2 bg-gray-50 rounded-lg">
          {error && <p className="text-xs text-red-600">{error}</p>}
          <input
            value={titre}
            onChange={(e) => setTitre(e.target.value)}
            placeholder="Titre"
            required
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <Select value={type} onChange={(e) => setType(e.target.value as DocumentType)} className="flex-1">
              {Object.entries(TYPE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </Select>
            <input
              value={annee}
              onChange={(e) => setAnnee(e.target.value)}
              type="number"
              placeholder="Année"
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>
          <input
            type="file"
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
            className="w-full text-sm"
          />
          <Button type="submit" disabled={submitting} className="w-full px-2 py-1 text-xs">
            {submitting ? "Envoi..." : "Enregistrer"}
          </Button>
        </form>
      )}

      {isLoading ? (
        <p className="text-gray-400">Chargement...</p>
      ) : data?.data.length === 0 ? (
        <p className="text-gray-400">Aucun document.</p>
      ) : (
        <ul className="space-y-1">
          {data?.data.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 border-b border-gray-50 py-1 text-gray-700">
              <span>{d.titre} — {TYPE_LABELS[d.type]}{d.annee ? ` (${d.annee})` : ""}</span>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => downloadViaApi(`/documents/${d.id}/download`, d.titre)} className="text-navy hover:underline text-xs">
                  Télécharger
                </button>
                {canWrite && (
                  <button onClick={() => handleDelete(d.id)} className="text-red-600 hover:underline text-xs">
                    Supprimer
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </div>
  );
}
