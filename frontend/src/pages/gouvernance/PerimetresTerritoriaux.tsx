import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPinned, Ban } from "lucide-react";
import { api } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { parseApiError } from "../../lib/errors";
import { toast } from "../../lib/toast";
import type { Region } from "../../types";

/**
 * Périmètres territoriaux d'écriture (scénario A10, décision D-11).
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **La règle est provisoire.** Un compte sans périmètre écrit dans toutes les régions, comme
 * avant : AGEROUTE n'a pas fourni la liste des comptes et de leur territoire. Le nombre de comptes
 * sans périmètre est affiché en premier, pour que l'état se lise au lieu de se deviner.
 *
 * **Attribuer une région RESSERRE le compte.** Dès sa première région, il n'écrit plus que là, et
 * plus du tout sur un objet dont la région est inconnue. C'est écrit au-dessus du formulaire.
 *
 * **Une attribution révoquée reste affichée** : des écritures ont été faites sous elle.
 */

interface Perimetre {
  id: string;
  userId: string;
  regionId: number;
  debutLe: string;
  finLe: string | null;
  revoqueLe: string | null;
  motif: string;
  enVigueur: boolean;
  user: { nomComplet: string; role: string };
  region: { nom: string };
}
interface Etat {
  regle: string;
  comptesActifs: number;
  comptesRestreints: number;
  comptesSansPerimetre: number;
  comptes: { id: string; nomComplet: string; role: string }[];
  perimetres: Perimetre[];
}

export function PerimetresTerritoriaux() {
  const qc = useQueryClient();
  const [userId, setUserId] = useState("");
  const [regionId, setRegionId] = useState("");
  const [finLe, setFinLe] = useState("");
  const [motif, setMotif] = useState("");

  const etat = useQuery<Etat>({
    queryKey: ["perimetres"],
    queryFn: async () => (await api.get<Etat>("/v2/perimetres")).data,
  });
  const regions = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
  });

  const attribuer = useMutation({
    mutationFn: () => api.post("/v2/perimetres", {
      userId, regionId: Number(regionId), motif: motif.trim(), ...(finLe ? { finLe: new Date(finLe).toISOString() } : {}),
    }),
    onSuccess: () => {
      toast.success("Région attribuée");
      qc.invalidateQueries({ queryKey: ["perimetres"] });
      setUserId(""); setRegionId(""); setFinLe(""); setMotif("");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });
  const revoquer = useMutation({
    mutationFn: (p: { id: string; motif: string }) => api.post(`/v2/perimetres/${p.id}/revocation`, { motif: p.motif }),
    onSuccess: () => { toast.success("Attribution révoquée"); qc.invalidateQueries({ queryKey: ["perimetres"] }); },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const complet = userId !== "" && regionId !== "" && motif.trim().length >= 3;

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-3" aria-labelledby="titre-perimetres">
      <h2 id="titre-perimetres" className="flex items-center gap-2 font-semibold">
        <MapPinned className="h-4 w-4" aria-hidden="true" /> Périmètres territoriaux d'écriture
      </h2>
      {etat.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : etat.isError ? <p className="text-sm text-red-700">Périmètres indisponibles (réservés aux administrateurs).</p>
        : etat.data && (
          <>
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
              <strong>{etat.data.comptesSansPerimetre}</strong> compte(s) actif(s) sur {etat.data.comptesActifs} sans périmètre :
              ils écrivent dans toutes les régions (règle provisoire, décision D-11 attendue).
            </p>
            <form
              className="grid gap-2 text-sm md:grid-cols-5"
              onSubmit={(e) => { e.preventDefault(); if (complet) attribuer.mutate(); }}
            >
              <p className="text-xs text-gray-600 md:col-span-5">
                Attribuer une première région <strong>restreint</strong> le compte : il n'écrira plus que dans ses régions, et plus du tout sur un objet de région inconnue.
              </p>
              <label>Compte
                <select className="mt-1 w-full rounded border px-2 py-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">—</option>
                  {etat.data.comptes.map((c) => <option key={c.id} value={c.id}>{c.nomComplet} ({c.role})</option>)}
                </select>
              </label>
              <label>Région
                <select className="mt-1 w-full rounded border px-2 py-1" value={regionId} onChange={(e) => setRegionId(e.target.value)}>
                  <option value="">—</option>
                  {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
                </select>
              </label>
              <label>Terme (facultatif)
                <input type="date" className="mt-1 w-full rounded border px-2 py-1" value={finLe} onChange={(e) => setFinLe(e.target.value)} />
              </label>
              <label className="md:col-span-2">Motif (note de service, décision…)
                <input className="mt-1 w-full rounded border px-2 py-1" maxLength={1000} value={motif} onChange={(e) => setMotif(e.target.value)} />
              </label>
              <div className="md:col-span-5">
                <Button size="sm" type="submit" disabled={!complet || attribuer.isPending}>Attribuer la région</Button>
              </div>
            </form>
            {etat.data.perimetres.length === 0 ? <p className="text-sm text-gray-600">Aucun périmètre attribué.</p> : (
              <ul className="divide-y text-sm">
                {etat.data.perimetres.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                    <span className={p.enVigueur ? "" : "text-gray-500 line-through"}>
                      {p.user.nomComplet} — {p.region.nom}{p.finLe ? ` jusqu'au ${new Date(p.finLe).toLocaleDateString("fr-FR")}` : ""} · {p.motif}
                      {p.revoqueLe ? ` (révoquée le ${new Date(p.revoqueLe).toLocaleDateString("fr-FR")})` : ""}
                    </span>
                    {!p.revoqueLe && (
                      <button
                        type="button"
                        className="rounded p-1 text-red-700 hover:bg-red-50"
                        aria-label={`Révoquer ${p.region.nom} pour ${p.user.nomComplet}`}
                        onClick={() => {
                          const m = window.prompt("Motif de la révocation");
                          if (m && m.trim().length >= 3) revoquer.mutate({ id: p.id, motif: m.trim() });
                        }}
                      >
                        <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </section>
  );
}
