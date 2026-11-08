import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { toast } from "../../lib/toast";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { MOIS, libelleMois, messageErreur, type Personne } from "../../lib/exploitation";

/**
 * Fiche d'un programme de patrouille (EX-03) : itinéraire, passages et leur couverture, modification
 * du rythme, suspension, retrait.
 *
 * **L'itinéraire ne se modifie pas** : la couverture des passages déjà réalisés se mesure contre lui.
 * Pour un autre itinéraire, on retire le programme et on en crée un autre ; la fiche le dit.
 *
 * **Le retrait est logique** et exige un motif : les passages engendrés restent.
 */

interface Passage { id: string; code: string; statut: string; debutPrevu: string | null; finReelle: string | null; assigne: { nomComplet: string } | null }
interface Fiche {
  id: string; code: string; libelle: string; periodiciteJours: number; moisActifs: number[]; actif: boolean;
  responsable: Personne; troncons: { ordre: number; troncon: { id: string; code: string; nom: string } }[];
  passages: Passage[]; dernierPassage: string | null;
}
interface Couverture {
  toleranceM: number; longueurItineraireM: number; couvertM: number; taux: number | null; horsItineraireM: number;
  tronconsNonVus: string[]; troncons: { tronconId: string; ordre: number | null; longueurM: number; couvertM: number; taux: number | null }[];
}

const pct = (t: number | null) => (t === null ? "—" : `${Math.round(t * 1000) / 10} %`);
const km = (m: number) => `${(m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} km`;

function CouverturePassage({ missionId, codes }: { missionId: string; codes: Map<string, string> }) {
  const [tolerance, setTolerance] = useState("30");
  const t = Number(tolerance);
  const valide = Number.isFinite(t) && t > 0 && t <= 500;
  const c = useQuery({
    queryKey: ["patrouilles", "couverture", missionId, tolerance],
    enabled: valide,
    queryFn: async () => (await api.get<Couverture>(`/v2/exploitation/patrouilles/missions/${missionId}/couverture`, { params: { tolerance: t } })).data,
  });
  return (
    <div className="mt-1 space-y-1 rounded border border-gray-200 p-2 text-xs">
      <label>Tolérance (m, 1 à 500)
        <input className="ml-2 w-20 rounded border px-1 py-0.5" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
      </label>
      {!valide ? <p className="text-red-700">Tolérance invalide.</p>
        : c.isLoading ? <p className="text-gray-600">Mesure…</p>
        : c.isError ? <p className="text-red-700">{messageErreur(c.error, "Couverture indisponible.")}</p>
        : c.data && (
          <>
            <p>Couvert : <strong>{km(c.data.couvertM)}</strong> sur {km(c.data.longueurItineraireM)} ({pct(c.data.taux)}) · hors itinéraire : {km(c.data.horsItineraireM)}</p>
            {c.data.tronconsNonVus.length > 0 && <p className="text-red-700">Non vus : {c.data.tronconsNonVus.map((id) => codes.get(id) ?? id).join(", ")}</p>}
            <table className="w-full">
              <thead><tr className="text-left text-gray-600"><th>Tronçon</th><th>Longueur</th><th>Couvert</th></tr></thead>
              <tbody>{c.data.troncons.map((x) => <tr key={x.tronconId} className="border-t"><td>{codes.get(x.tronconId) ?? x.tronconId}</td><td>{km(x.longueurM)}</td><td>{pct(x.taux)}</td></tr>)}</tbody>
            </table>
            <p className="text-gray-600">Aucun seuil : un tronçon couvert à 3 % est couvert à 3 %. Seul le zéro est nommé « non vu ».</p>
          </>
        )}
    </div>
  );
}

export function FicheProgramme({ id, peutEcrire, personnes, onClose }: { id: string; peutEcrire: boolean; personnes: Personne[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [edition, setEdition] = useState(false);
  const [couverture, setCouverture] = useState<string | null>(null);
  const [motif, setMotif] = useState("");
  const [f, setF] = useState<{ libelle: string; periodiciteJours: string; moisActifs: number[]; responsableId: string } | null>(null);

  const fiche = useQuery({
    queryKey: ["patrouilles", "programme", id],
    queryFn: async () => (await api.get<Fiche>(`/v2/exploitation/patrouilles/programmes/${id}`)).data,
  });
  const rafraichir = () => qc.invalidateQueries({ queryKey: ["patrouilles"] });
  const modifier = useMutation({
    mutationFn: async (corps: Record<string, unknown>) => (await api.patch(`/v2/exploitation/patrouilles/programmes/${id}`, corps)).data,
    onSuccess: () => { toast.success("Programme modifié"); setEdition(false); rafraichir(); },
    onError: (e) => toast.error(messageErreur(e, "Modification refusée")),
  });
  const retirer = useMutation({
    mutationFn: async () => (await api.post(`/v2/exploitation/patrouilles/programmes/${id}/retrait`, { motif: motif.trim() })).data,
    onSuccess: () => { toast.success("Programme retiré"); rafraichir(); onClose(); },
    onError: (e) => toast.error(messageErreur(e, "Retrait refusé")),
  });

  const ouvrirEdition = (p: Fiche) => { setF({ libelle: p.libelle, periodiciteJours: String(p.periodiciteJours), moisActifs: [...p.moisActifs], responsableId: p.responsable.id }); setEdition(true); };
  const p = fiche.data;
  const codes = new Map((p?.troncons ?? []).map((t) => [t.troncon.id, t.troncon.code]));
  const periodicite = f ? Number(f.periodiciteJours) : NaN;
  const editionValide = f && f.libelle.trim() && Number.isInteger(periodicite) && periodicite >= 1 && periodicite <= 366 && f.responsableId;

  return (
    <Modal open onClose={onClose} title={p ? `Programme ${p.code}` : "Programme"} sale={() => edition || motif.trim() !== ""}>
      {fiche.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : fiche.isError || !p ? <p className="text-sm text-red-700">Programme introuvable.</p>
        : (
          <div className="space-y-3 text-sm">
            <p>{p.libelle} · tous les {p.periodiciteJours} j, {libelleMois(p.moisActifs)} · responsable {p.responsable.nomComplet} · {p.actif ? "actif" : <strong>suspendu</strong>}</p>
            <section>
              <h3 className="font-medium">Itinéraire ({p.troncons.length} tronçon(s), dans l'ordre)</h3>
              <ol className="list-decimal pl-5 text-xs">{p.troncons.map((t) => <li key={t.troncon.id}>{t.troncon.code} — {t.troncon.nom}</li>)}</ol>
              <p className="text-xs text-gray-600">L'itinéraire ne se modifie pas : la couverture des passages réalisés se mesure contre lui. Pour un autre itinéraire, retirer ce programme et en créer un autre.</p>
            </section>
            <section>
              <h3 className="font-medium">Passages</h3>
              {p.passages.length === 0 ? <p className="text-xs text-gray-600">Aucun passage engendré.</p> : (
                <ul className="divide-y text-xs">
                  {p.passages.map((m) => (
                    <li key={m.id} className="py-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>{m.code} · {m.statut}{m.debutPrevu ? ` · prévu le ${new Date(m.debutPrevu).toLocaleDateString("fr-FR")}` : ""}{m.assigne ? ` · ${m.assigne.nomComplet}` : ""}</span>
                        <Button size="sm" variant="outline" onClick={() => setCouverture(couverture === m.id ? null : m.id)}>{couverture === m.id ? "Masquer la couverture" : "Couverture"}</Button>
                      </div>
                      {couverture === m.id && <CouverturePassage missionId={m.id} codes={codes} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {peutEcrire && !edition && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => ouvrirEdition(p)}>Modifier le rythme</Button>
                <Button size="sm" variant="outline" disabled={modifier.isPending} onClick={() => modifier.mutate({ actif: !p.actif })}>{p.actif ? "Suspendre" : "Réactiver"}</Button>
              </div>
            )}
            {peutEcrire && edition && f && (
              <form className="space-y-2 rounded border border-gray-200 p-2" onSubmit={(e) => {
                e.preventDefault();
                if (editionValide) modifier.mutate({ libelle: f.libelle.trim(), periodiciteJours: periodicite, moisActifs: f.moisActifs, responsableId: f.responsableId });
              }}>
                <label className="block">Libellé<input className="mt-1 w-full rounded border px-2 py-1" value={f.libelle} onChange={(e) => setF({ ...f, libelle: e.target.value })} /></label>
                <label className="block">Périodicité (jours, 1 à 366)<input className="mt-1 w-full rounded border px-2 py-1" inputMode="numeric" value={f.periodiciteJours} onChange={(e) => setF({ ...f, periodiciteJours: e.target.value })} /></label>
                <fieldset><legend>Mois actifs (aucun coché : toute l'année)</legend>
                  <div className="grid grid-cols-6 gap-1">
                    {MOIS.map((m, i) => (
                      <label key={m} className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={f.moisActifs.includes(i + 1)} onChange={() => setF({ ...f, moisActifs: f.moisActifs.includes(i + 1) ? f.moisActifs.filter((x) => x !== i + 1) : [...f.moisActifs, i + 1].sort((a, b) => a - b) })} />{m}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="block">Responsable
                  <select className="mt-1 w-full rounded border px-2 py-1" value={f.responsableId} onChange={(e) => setF({ ...f, responsableId: e.target.value })}>
                    {personnes.map((x) => <option key={x.id} value={x.id}>{x.nomComplet}</option>)}
                  </select>
                </label>
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEdition(false)}>Annuler</Button>
                  <Button type="submit" size="sm" disabled={!editionValide || modifier.isPending}>Enregistrer</Button>
                </div>
              </form>
            )}
            {peutEcrire && (
              <form className="space-y-1 border-t pt-2" onSubmit={(e) => { e.preventDefault(); if (motif.trim().length >= 3) retirer.mutate(); }}>
                <label className="block text-xs">Retirer ce programme (les passages restent) — motif
                  <input className="mt-1 w-full rounded border px-2 py-1" maxLength={1000} value={motif} onChange={(e) => setMotif(e.target.value)} />
                </label>
                <div className="flex justify-end"><Button type="submit" size="sm" variant="danger" disabled={motif.trim().length < 3 || retirer.isPending}>Retirer le programme</Button></div>
              </form>
            )}
          </div>
        )}
    </Modal>
  );
}
