import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { messageErreur } from "../lib/exploitation";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface LigneImport { row: number; code: string; action: "CREER" | "METTRE_A_JOUR" | "INCHANGE" | "ERREUR"; changements?: { champ: string; actuelle: unknown; nouvelle: unknown }[]; message?: string }
interface ImportReport {
  created: number;
  errors: { row: number; message: string }[];
  /** Rendus par un serveur qui sait simuler (tronçons, BDRI lot H). */
  simulation?: boolean;
  updated?: number;
  unchanged?: number;
  avertissements?: { row: number; message: string }[];
  lignes?: LigneImport[];
}

const LIBELLE_ACTION: Record<LigneImport["action"], string> = { CREER: "à créer", METTRE_A_JOUR: "à mettre à jour", INCHANGE: "inchangée", ERREUR: "en erreur" };
const val = (v: unknown) => (v === null || v === undefined || v === "" ? "non renseigné" : String(v));

/** Rapport d'import en CSV (point-virgule, BOM), formules neutralisées : pour corriger le fichier puis le rejouer. */
function rapportCsv(r: ImportReport): string {
  const cellule = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const source: LigneImport[] = r.lignes ?? r.errors.map((e) => ({ row: e.row, code: "", action: "ERREUR", message: e.message }));
  const lignes = source
    .map((l) => [l.row, l.code, LIBELLE_ACTION[l.action], l.message ?? (l.changements ?? []).map((c) => `${c.champ}: ${val(c.actuelle)} -> ${val(c.nouvelle)}`).join(" | ")].map(cellule).join(";"));
  const avert = (r.avertissements ?? []).map((a) => [a.row, "", "AVERTISSEMENT", a.message].map(cellule).join(";"));
  return `\uFEFFligne;code;action;detail\n${[...lignes, ...avert].join("\n")}\n`;
}

/**
 * `exportParams` : la recherche et les filtres courants de la liste. Le serveur qui les connait exporte ce qu'on
 * voit ; celui qui ne les connait pas les ignore et exporte tout, comme avant.
 *
 * `simulation` (tronçons) : le fichier est d'abord SIMULÉ (rien n'est écrit) ; l'écran montre ce qui serait créé,
 * modifié (champ par champ), laissé tel quel ou refusé, puis importe sur demande. Des mises à jour de fiches
 * existantes demandent une confirmation explicite. Sans `simulation`, l'import reste direct, comme avant.
 */
export function ImportExportBar({ endpoint, filenamePrefix, exportParams, simulation }: {
  endpoint: string; filenamePrefix: string; exportParams?: Record<string, string | undefined>; simulation?: boolean;
}) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fichier, setFichier] = useState<File | null>(null);
  const [confirme, setConfirme] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const importMutation = useMutation({
    mutationFn: async ({ file, mode }: { file: File; mode: "direct" | "simulation" | "reel" }) => {
      const form = new FormData();
      form.append("file", file);
      const params = mode === "simulation" ? { simulation: "true" } : mode === "reel" && confirme ? { confirmer: "true" } : undefined;
      const { data } = await api.post<ImportReport>(`/${endpoint}/import`, form, { headers: { "Content-Type": "multipart/form-data" }, params });
      return data;
    },
    onSuccess: (data) => {
      setReport(data);
      setErreur(null);
      if (!data.simulation) { setFichier(null); qc.invalidateQueries({ queryKey: [endpoint] }); }
    },
    onError: (e) => setErreur(messageErreur(e, "Import refusé")),
  });

  async function handleExport() {
    setExporting(true);
    try {
      const res = await api.get(`/${endpoint}/export`, { responseType: "blob", params: exportParams });
      telecharger(res.data as Blob, `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      setExporting(false);
    }
  }

  function telecharger(blob: Blob, nom: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nom;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setReport(null); setConfirme(false); setErreur(null);
      if (simulation) { setFichier(file); importMutation.mutate({ file, mode: "simulation" }); }
      else importMutation.mutate({ file, mode: "direct" });
    }
    e.target.value = "";
  }

  const aEcrire = report?.simulation ? (report.created ?? 0) + (report.updated ?? 0) : 0;
  const misesAJour = report?.simulation ? report.updated ?? 0 : 0;

  return (
    <>
      <Button variant="ghost" onClick={handleExport} disabled={exporting}>
        {exporting ? "Export..." : "Exporter"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setReport(null); setFichier(null); setErreur(null);
          setImportOpen(true);
        }}
      >
        Importer
      </Button>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Importer un fichier Excel">
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Le fichier doit reprendre les colonnes du modèle exporté (mêmes en-têtes).
            {simulation
              ? " Il est d'abord simulé : rien n'est écrit avant que vous confirmiez. Les lignes en erreur sont ignorées ; une ligne inchangée n'est pas réécrite."
              : " Les lignes en erreur sont ignorées individuellement et détaillées ci-dessous ; les autres sont importées."}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            aria-label="Fichier Excel à importer"
            onChange={handleFileChange}
            disabled={importMutation.isPending}
            className="block w-full text-sm"
          />
          {importMutation.isPending && <p className="text-sm text-gray-500">{fichier && !report ? "Simulation en cours..." : "Import en cours..."}</p>}
          {erreur && <p role="alert" className="text-sm text-red-700">{erreur}</p>}
          {report && (
            <div className="rounded-lg border border-gray-200 p-3 text-sm space-y-2">
              {report.simulation ? (
                <p className="font-semibold text-navy">
                  Simulation : {report.created} à créer, {report.updated ?? 0} à mettre à jour, {report.unchanged ?? 0} inchangée(s), {report.errors.length} en erreur. Rien n'a été écrit.
                </p>
              ) : (
                <p className="font-semibold text-green-700">
                  {report.created} ligne(s) créée(s){report.updated !== undefined ? `, ${report.updated} mise(s) à jour, ${report.unchanged ?? 0} inchangée(s)` : " avec succès"}
                </p>
              )}
              {(report.avertissements ?? []).length > 0 && (
                <ul className="max-h-24 overflow-y-auto space-y-1 text-xs text-amber-800">
                  {report.avertissements!.map((a, i) => <li key={i}>Ligne {a.row} : {a.message}</li>)}
                </ul>
              )}
              {report.simulation && (report.lignes ?? []).some((l) => l.action === "METTRE_A_JOUR") && (
                <ul className="max-h-32 overflow-y-auto space-y-1 text-xs text-gray-700">
                  {report.lignes!.filter((l) => l.action === "METTRE_A_JOUR").slice(0, 200).map((l) => (
                    <li key={l.row}>Ligne {l.row} ({l.code}) : {(l.changements ?? []).map((c) => `${c.champ} ${val(c.actuelle)} → ${val(c.nouvelle)}`).join(", ")}</li>
                  ))}
                </ul>
              )}
              {report.errors.length > 0 && (
                <div>
                  <p className="font-semibold text-red-700 mb-1">{report.errors.length} erreur(s) :</p>
                  <ul className="max-h-40 overflow-y-auto space-y-1 text-xs text-red-700">
                    {report.errors.map((e, i) => (
                      <li key={i}>Ligne {e.row} : {e.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => telecharger(new Blob([rapportCsv(report)], { type: "text/csv;charset=utf-8" }), `${filenamePrefix}-rapport-import.csv`)}>
                  Télécharger le rapport (CSV)
                </Button>
                {report.simulation && fichier && (
                  <>
                    {misesAJour > 0 && (
                      <label className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={confirme} onChange={(e) => setConfirme(e.target.checked)} />
                        Je confirme les {misesAJour} mise(s) à jour de fiches existantes
                      </label>
                    )}
                    <Button size="sm" disabled={aEcrire === 0 || (misesAJour > 0 && !confirme) || importMutation.isPending} onClick={() => importMutation.mutate({ file: fichier, mode: "reel" })}>
                      Importer {aEcrire} ligne(s)
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
