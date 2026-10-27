import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth, canWrite } from "../lib/auth";
import { toast } from "../lib/toast";
import { messageErreur } from "../lib/exploitation";
import { libelleSection } from "../lib/travaux";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { TronconPicker } from "./TronconPicker";

/**
 * Tronçons et sections d'un chantier (BDRI, lot G), sur `/api/v2/chantiers/:id/sections`.
 *
 * Lier le tronçon entier, ou un intervalle en mètres le long du tracé (vérifié contre la longueur du tracé par le
 * serveur ; refusé sans tracé). Un lien se retire avec un motif ; il reste dans l'historique. Le tronçon principal
 * du chantier n'est pas modifié ici.
 */

interface Section {
  id: string; debutM: number | null; finM: number | null; portionId: string | null; commentaire: string | null; creeLe: string;
  retireLe: string | null; motifRetrait: string | null;
  troncon: { id: string; code: string; nom: string }; creePar: { nomComplet: string }; retirePar: { nomComplet: string } | null;
}

export function ChantierSectionsModal({ chantier, onClose }: { chantier: { id: string; intitule: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const peutEcrire = canWrite(user?.role);
  const [tronconId, setTronconId] = useState<string | undefined>();
  const [mode, setMode] = useState<"entier" | "intervalle">("entier");
  const [debut, setDebut] = useState("");
  const [fin, setFin] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [retrait, setRetrait] = useState<{ id: string; motif: string } | null>(null);

  const cle = ["chantiers", "sections", chantier.id];
  const sections = useQuery({ queryKey: cle, queryFn: async () => (await api.get<{ sections: Section[] }>(`/v2/chantiers/${chantier.id}/sections`)).data.sections });
  const d = Number(debut.replace(",", ".")), f = Number(fin.replace(",", "."));
  const intervalleValide = mode === "entier" || (debut.trim() !== "" && fin.trim() !== "" && d >= 0 && f > d);
  const ajouter = useMutation({
    mutationFn: async () => (await api.post(`/v2/chantiers/${chantier.id}/sections`, {
      tronconId, ...(mode === "intervalle" ? { debutM: d, finM: f } : {}), commentaire: commentaire.trim() || null,
    })).data,
    onSuccess: () => { toast.success("Section liée au chantier"); setTronconId(undefined); setDebut(""); setFin(""); setCommentaire(""); qc.invalidateQueries({ queryKey: ["chantiers"] }); },
    onError: (e) => toast.error(messageErreur(e, "Lien refusé")),
  });
  const retirer = useMutation({
    mutationFn: async (r: { id: string; motif: string }) => (await api.post(`/v2/chantiers/sections/${r.id}/retrait`, { motif: r.motif })).data,
    onSuccess: () => { toast.success("Lien retiré"); setRetrait(null); qc.invalidateQueries({ queryKey: ["chantiers"] }); },
    onError: (e) => toast.error(messageErreur(e, "Retrait refusé")),
  });

  return (
    <Modal open onClose={onClose} title={`Tronçons et sections — ${chantier.intitule}`} sale={() => !!tronconId || (retrait?.motif ?? "") !== ""}>
      <div className="space-y-3 text-sm">
        {sections.isLoading ? <p className="text-gray-500">Chargement…</p>
          : sections.isError ? <p className="text-red-700">{messageErreur(sections.error, "Liens indisponibles.")}</p>
          : (sections.data ?? []).length === 0 ? <p className="text-gray-600">Aucune section liée (en dehors du tronçon principal du chantier).</p>
          : (
            <ul className="divide-y text-xs">
              {sections.data!.map((s) => (
                <li key={s.id} className={`py-1.5 ${s.retireLe ? "text-gray-500" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><strong>{s.troncon.code}</strong> {s.troncon.nom} · {libelleSection(s)}{s.commentaire ? ` · ${s.commentaire}` : ""}</span>
                    {peutEcrire && !s.retireLe && retrait?.id !== s.id && <Button size="sm" variant="ghost" onClick={() => setRetrait({ id: s.id, motif: "" })}>Retirer</Button>}
                  </div>
                  <p>Lié le {new Date(s.creeLe).toLocaleDateString("fr-FR")} par {s.creePar.nomComplet}{s.retireLe ? ` · retiré le ${new Date(s.retireLe).toLocaleDateString("fr-FR")} par ${s.retirePar?.nomComplet ?? "?"} : ${s.motifRetrait}` : ""}</p>
                  {retrait?.id === s.id && (
                    <form className="mt-1 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (retrait.motif.trim().length >= 3) retirer.mutate(retrait); }}>
                      <label className="flex-1">Motif du retrait<input className="mt-1 w-full rounded border px-2 py-1" value={retrait.motif} onChange={(e) => setRetrait({ ...retrait, motif: e.target.value })} /></label>
                      <Button type="submit" size="sm" variant="danger" disabled={retrait.motif.trim().length < 3 || retirer.isPending}>Confirmer le retrait</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRetrait(null)}>Annuler</Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}

        {peutEcrire && (
          <form className="space-y-2 rounded border border-gray-200 p-2" onSubmit={(e) => { e.preventDefault(); if (tronconId && intervalleValide) ajouter.mutate(); }}>
            <h3 className="font-medium">Lier une section</h3>
            <div><label htmlFor="section-troncon" className="mb-1 block">Tronçon</label><TronconPicker id="section-troncon" value={tronconId} onChange={setTronconId} /></div>
            <fieldset className="flex flex-wrap gap-3 text-xs">
              <legend className="mb-1 text-sm">Étendue</legend>
              <label className="flex items-center gap-1"><input type="radio" name="etendue" checked={mode === "entier"} onChange={() => setMode("entier")} />Tronçon entier</label>
              <label className="flex items-center gap-1"><input type="radio" name="etendue" checked={mode === "intervalle"} onChange={() => setMode("intervalle")} />Intervalle (mètres le long du tracé)</label>
            </fieldset>
            {mode === "intervalle" && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">Début (m)<input className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={debut} onChange={(e) => setDebut(e.target.value)} /></label>
                <label className="block">Fin (m)<input className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={fin} onChange={(e) => setFin(e.target.value)} /></label>
              </div>
            )}
            <label className="block">Commentaire<input className="mt-1 w-full rounded border px-2 py-1" maxLength={1000} value={commentaire} onChange={(e) => setCommentaire(e.target.value)} /></label>
            <p className="text-xs text-gray-600">Les quantités, montants et statuts du chantier restent dans le module des travaux : ce lien dit seulement où il intervient.</p>
            <div className="flex justify-end"><Button type="submit" size="sm" disabled={!tronconId || !intervalleValide || ajouter.isPending}>Lier</Button></div>
          </form>
        )}
      </div>
    </Modal>
  );
}
