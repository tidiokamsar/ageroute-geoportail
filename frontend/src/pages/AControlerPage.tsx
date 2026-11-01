import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { api } from "../lib/api";
import { messageErreur } from "../lib/exploitation";
import { csvAControler, type ResultatAControler } from "../lib/historiqueSection";
import { TronconFicheModal } from "../components/TronconFicheModal";
import { Button } from "../components/ui/Button";
import type { Region } from "../types";

/**
 * Points à contrôler : les tronçons où un humain doit regarder EN PREMIER, avec la raison de chaque rang.
 *
 * Ce que l'écran garantit :
 *   - chaque ligne dit ses facteurs et ses points (rien n'est une boîte noire) ;
 *   - c'est une AIDE AU CONTRÔLE, jamais une décision d'intervention (la programmation reste au moteur de programmation) ;
 *   - les poids sont PROVISOIRES et affichés ;
 *   - un tronçon sans constat n'est pas classé : leur nombre est donné à part, comme une absence de donnée ;
 *   - l'export CSV et l'impression reprennent l'étiquette « provisoire ».
 */
export function AControlerPage() {
  const [region, setRegion] = useState("");
  const [limite, setLimite] = useState(50);
  const [ficheId, setFicheId] = useState<string | null>(null);

  const { data: regions } = useQuery<Region[]>({ queryKey: ["regions"], queryFn: async () => (await api.get<Region[]>("/regions")).data });
  const { data, isLoading, error } = useQuery({
    queryKey: ["fiche360", "a-controler", region, limite],
    queryFn: async () => (await api.get<ResultatAControler>("/v2/fiche-360/a-controler", { params: { limite, ...(region ? { region } : {}) } })).data,
    retry: false,
  });

  function exporter() {
    if (!data) return;
    // BOM : un tableur lit alors correctement les accents.
    const blob = new Blob(["﻿", csvAControler(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `points-a-controler-${data.genereLe.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Points à contrôler</h1>
        <p className="mt-1 text-sm text-gray-700">
          Les tronçons à regarder en premier, d'après les constats de terrain. <strong>C'est une aide au contrôle, pas une décision :</strong> un
          responsable vérifie, puis décide.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div>
          <label htmlFor="ac-region" className="block text-xs text-gray-700">Région</label>
          <select id="ac-region" value={region} onChange={(e) => setRegion(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
            <option value="">Toutes mes régions</option>
            {(regions ?? []).map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="ac-limite" className="block text-xs text-gray-700">Nombre de lignes</label>
          <select id="ac-limite" value={limite} onChange={(e) => setLimite(Number(e.target.value))} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
            {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <Button variant="outline" onClick={exporter} disabled={!data || data.lignes.length === 0}><Download className="h-4 w-4" aria-hidden="true" />Exporter en CSV</Button>
        <Button variant="outline" onClick={() => window.print()} disabled={!data}><Printer className="h-4 w-4" aria-hidden="true" />Imprimer</Button>
      </div>

      {isLoading && <p role="status" className="text-sm text-gray-600">Calcul du classement…</p>}
      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">Le classement n'a pas pu être calculé. {messageErreur(error, "Réessayez dans un instant.")}</p>}

      {data && (
        <>
          {data.avertissements.map((a) => <p key={a} role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{a}</p>)}
          <p className="text-sm">
            {data.totalClasses} tronçon(s) classé(s), dont {data.lignes.length} affiché(s) · {data.constatsLus} constat(s) lus ·{" "}
            <strong>{data.sansConstatSurLeReseau}</strong> tronçon(s) sans aucun constat : une absence de donnée, pas un risque mesuré.
          </p>
          <p className="text-xs text-gray-600">
            Poids {data.poids.provenance === "PROVISOIRE_NON_CALIBRE" ? "PROVISOIRES, non calibrés" : data.poids.provenance} : grave récent ({data.poids.joursFenetreRecente} j) {data.poids.parConstatGrave} point(s),
            proposé non tranché {data.poids.parConstatEnAttente}, récurrence {data.poids.parRecurrence}, dernier constat de plus de {data.poids.joursSansConstat} j {data.poids.siInformationAncienne}.
          </p>

          {data.lignes.length === 0 ? (
            <p className="text-sm text-gray-700">Aucun tronçon à contrôler d'après les constats rattachés. Les observations prises en roulant n'y entrent qu'une fois rattachées à un tronçon par un responsable.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Tronçons à contrôler, du plus prioritaire au moins prioritaire, avec le détail du score</caption>
                <thead className="text-xs uppercase text-gray-600">
                  <tr><th scope="col" className="py-1 pr-3">Rang</th><th scope="col" className="pr-3">Tronçon</th><th scope="col" className="pr-3">Région</th><th scope="col" className="pr-3">Score</th><th scope="col" className="pr-3">Pourquoi</th><th scope="col">Dernier constat</th></tr>
                </thead>
                <tbody>
                  {data.lignes.map((l, i) => (
                    <tr key={l.tronconId} className="border-t align-top">
                      <td className="py-1 pr-3 tabular-nums">{i + 1}</td>
                      <td className="pr-3">
                        <button type="button" onClick={() => setFicheId(l.tronconId)} className="font-mono text-xs font-semibold text-navy underline">{l.tronconCode}</button>
                        <div className="text-xs text-gray-700">{l.tronconNom}</div>
                      </td>
                      <td className="pr-3">{l.regionNom}</td>
                      <td className="pr-3 font-semibold tabular-nums">{l.score}</td>
                      <td className="pr-3 text-xs">
                        <ul className="space-y-0.5">
                          {l.facteurs.map((f) => <li key={f.facteur}>{f.nombre} × {f.pointsParUnite} = {f.points} : {f.nombre} {f.libelle}</li>)}
                        </ul>
                      </td>
                      <td>{l.dernierConstat}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {ficheId && <TronconFicheModal open={!!ficheId} onClose={() => setFicheId(null)} tronconId={ficheId} />}
    </div>
  );
}
