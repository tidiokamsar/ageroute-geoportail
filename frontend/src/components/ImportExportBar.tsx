import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface ImportReport {
  created: number;
  errors: { row: number; message: string }[];
}

export function ImportExportBar({ endpoint, filenamePrefix }: { endpoint: string; filenamePrefix: string }) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [exporting, setExporting] = useState(false);

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post<ImportReport>(`/${endpoint}/import`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data;
    },
    onSuccess: (data) => {
      setReport(data);
      qc.invalidateQueries({ queryKey: [endpoint] });
    },
  });

  async function handleExport() {
    setExporting(true);
    try {
      const res = await api.get(`/${endpoint}/export`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) importMutation.mutate(file);
    e.target.value = "";
  }

  return (
    <>
      <Button variant="ghost" onClick={handleExport} disabled={exporting}>
        {exporting ? "Export..." : "Exporter"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setReport(null);
          setImportOpen(true);
        }}
      >
        Importer
      </Button>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Importer un fichier Excel">
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Le fichier doit reprendre les colonnes du modèle exporté (mêmes en-têtes). Les lignes en erreur sont
            ignorées individuellement et détaillées ci-dessous ; les autres sont importées.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            disabled={importMutation.isPending}
            className="block w-full text-sm"
          />
          {importMutation.isPending && <p className="text-sm text-gray-500">Import en cours...</p>}
          {report && (
            <div className="rounded-lg border border-gray-200 p-3 text-sm space-y-2">
              <p className="font-semibold text-green-700">{report.created} ligne(s) importée(s) avec succès</p>
              {report.errors.length > 0 && (
                <div>
                  <p className="font-semibold text-red-600 mb-1">{report.errors.length} erreur(s) :</p>
                  <ul className="max-h-40 overflow-y-auto space-y-1 text-xs text-red-600">
                    {report.errors.map((e, i) => (
                      <li key={i}>Ligne {e.row} : {e.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
