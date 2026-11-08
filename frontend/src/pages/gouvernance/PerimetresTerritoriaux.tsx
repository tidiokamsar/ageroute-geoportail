import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPinned } from "lucide-react";
import { api } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { parseApiError } from "../../lib/errors";
import { toast } from "../../lib/toast";
import type { Region } from "../../types";

/**
 * Périmètres territoriaux d'écriture (scénario A10, décision D-11), sur `/api/v2/perimetres`.
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **La règle est provisoire.** Un compte sans région écrit dans toutes les régions, comme avant :
 * AGEROUTE n'a pas fourni la liste des comptes et de leur territoire. Le nombre de comptes
 * « nationaux par défaut » est affiché en premier, pour que l'état se lise au lieu de se deviner.
 *
 * **Rattacher une région RESSERRE le compte.** Dès sa première région, il n'écrit plus que là, et
 * plus du tout sur une fiche dont la région est inconnue. C'est écrit au-dessus du formulaire.
 *
 * **Un administrateur reste national** : le serveur refuse de le restreindre, l'écran ne le propose pas.
 */

interface Compte {
  id: string;
  email: string;
  nomComplet: string;
  role: string;
  regions: { id: number; nom: string }[];
  perimetre: "NATIONAL" | "REGIONAL";
  nationalParDefaut: boolean;
}
interface Etat { comptes: Compte[]; comptesNationauxParDefaut: number }

function libellePerimetre(c: Compte): string {
  if (c.role === "ADMIN") return "National (administrateur)";
  if (c.nationalParDefaut) return "National par défaut";
  return c.regions.map((r) => r.nom).join(", ");
}

export function PerimetresTerritoriaux() {
  const qc = useQueryClient();
  const [userId, setUserId] = useState("");
  const [choix, setChoix] = useState<number[]>([]);

  const etat = useQuery<Etat>({
    queryKey: ["perimetres"],
    queryFn: async () => (await api.get<Etat>("/v2/perimetres")).data,
  });
  const regions = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
  });

  const enregistrer = useMutation({
    mutationFn: () => api.put(`/v2/perimetres/${userId}`, { regionIds: choix }),
    onSuccess: () => {
      toast.success(choix.length === 0 ? "Compte remis au périmètre national" : "Périmètre enregistré");
      qc.invalidateQueries({ queryKey: ["perimetres"] });
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const restreignables = (etat.data?.comptes ?? []).filter((c) => c.role !== "ADMIN");
  const choisir = (id: string) => {
    setUserId(id);
    setChoix(restreignables.find((c) => c.id === id)?.regions.map((r) => r.id) ?? []);
  };
  const basculer = (id: number) => setChoix((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

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
              <strong>{etat.data.comptesNationauxParDefaut}</strong> compte(s) national(aux) par défaut, sans région rattachée :
              ils écrivent dans toutes les régions (règle provisoire, décision D-11 attendue).
            </p>
            <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (userId) enregistrer.mutate(); }}>
              <p className="text-xs text-gray-600">
                Rattacher une première région <strong>restreint</strong> le compte : il n'écrira plus que dans ses régions, et plus du tout sur une fiche de région inconnue. Aucune case cochée : le compte redevient national.
              </p>
              <label className="block">Compte
                <select className="mt-1 w-full rounded border px-2 py-1 md:w-96" value={userId} onChange={(e) => choisir(e.target.value)}>
                  <option value="">—</option>
                  {restreignables.map((c) => <option key={c.id} value={c.id}>{c.nomComplet} ({c.role})</option>)}
                </select>
              </label>
              {userId && (
                <fieldset className="grid gap-1 sm:grid-cols-2 md:grid-cols-4">
                  <legend className="mb-1">Régions</legend>
                  {(regions.data ?? []).map((r) => (
                    <label key={r.id} className="flex items-center gap-2">
                      <input type="checkbox" checked={choix.includes(r.id)} onChange={() => basculer(r.id)} /> {r.nom}
                    </label>
                  ))}
                </fieldset>
              )}
              <Button size="sm" type="submit" disabled={!userId || enregistrer.isPending}>Enregistrer le périmètre</Button>
            </form>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500"><th>Compte</th><th>Rôle</th><th>Périmètre</th></tr></thead>
              <tbody>
                {etat.data.comptes.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td>{c.nomComplet}</td><td>{c.role}</td>
                    <td className={c.nationalParDefaut ? "text-amber-800" : ""}>{libellePerimetre(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
    </section>
  );
}
