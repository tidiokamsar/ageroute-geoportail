import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { messageErreur } from "../lib/exploitation";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

/**
 * Avis d'un responsable sur une inspection (BDRI, lot F), sur `/api/v2/inspections/:id/validation`.
 *
 * Valider, rejeter ou renvoyer en correction, avec motif pour les deux derniers ; nul ne valide sa propre
 * inspection (l'écran le dit, le serveur le refuse). L'historique des avis est affiché.
 */

export const LIBELLE_AVIS: Record<string, string> = { A_VALIDER: "À valider", VALIDE: "Validée", REJETE: "Rejetée", A_CORRIGER: "À corriger" };

interface Ligne { id: string; statutAvant: string | null; statutApres: string; commentaire: string | null; decideA: string; decidePar: { nomComplet: string } | null }

export function AvisInspectionModal({ inspection, onClose }: { inspection: { id: string; inspecteurId: string; statutValidation?: string | null; libelle: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [decision, setDecision] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const historique = useQuery({
    queryKey: ["inspections", "validations", inspection.id],
    queryFn: async () => (await api.get<{ validations: Ligne[] }>(`/v2/inspections/${inspection.id}/validations`)).data.validations,
  });
  const envoyer = useMutation({
    mutationFn: async () => (await api.post(`/v2/inspections/${inspection.id}/validation`, { decision, commentaire: commentaire.trim() || null })).data,
    onSuccess: () => { toast.success("Avis enregistré"); qc.invalidateQueries({ queryKey: ["inspections"] }); onClose(); },
    onError: (e) => toast.error(messageErreur(e, "Avis refusé")),
  });
  const statut = inspection.statutValidation ?? "A_VALIDER";
  const terminal = statut === "VALIDE" || statut === "REJETE";
  const sienne = inspection.inspecteurId === user?.id;
  const valide = decision !== "" && (decision === "VALIDE" || commentaire.trim().length > 0);
  return (
    <Modal open onClose={onClose} title={`Avis — ${inspection.libelle}`} sale={() => decision !== "" || commentaire !== ""}>
      <div className="space-y-3 text-sm">
        <p>Statut : <strong>{LIBELLE_AVIS[statut] ?? statut}</strong>{inspection.statutValidation ? "" : " (inspection antérieure aux avis)"}</p>
        {sienne ? <p className="text-amber-800">C'est votre inspection : une autre personne doit donner l'avis.</p>
          : terminal ? <p className="text-gray-600">Avis définitif : pour revenir dessus, une nouvelle inspection est faite, et les deux restent.</p>
          : (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (valide) envoyer.mutate(); }}>
              <label className="block">Décision
                <select className="mt-1 w-full rounded border px-2 py-1" value={decision} onChange={(e) => setDecision(e.target.value)}>
                  <option value="">Choisir…</option>
                  {statut === "A_VALIDER" && <><option value="VALIDE">Valider</option><option value="A_CORRIGER">Renvoyer en correction</option><option value="REJETE">Rejeter</option></>}
                </select>
              </label>
              <label className="block">Commentaire{decision && decision !== "VALIDE" ? " (motif exigé)" : ""}
                <textarea className="mt-1 w-full rounded border px-2 py-1" rows={2} maxLength={2000} value={commentaire} onChange={(e) => setCommentaire(e.target.value)} />
              </label>
              {statut === "A_CORRIGER" && <p className="text-xs text-gray-600">Renvoyée en correction : l'inspecteur la reprend avant un nouvel avis.</p>}
              <div className="flex justify-end"><Button type="submit" size="sm" disabled={!valide || envoyer.isPending}>Enregistrer l'avis</Button></div>
            </form>
          )}
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Historique des avis</h3>
          {historique.isLoading ? <p className="text-xs text-gray-500">Chargement…</p>
            : (historique.data ?? []).length === 0 ? <p className="text-xs text-gray-600">Aucun avis.</p>
            : (
              <ol className="space-y-1 text-xs">
                {historique.data!.map((v) => (
                  <li key={v.id} className="border-l-2 border-navy/20 pl-2">
                    {LIBELLE_AVIS[v.statutAvant ?? "A_VALIDER"] ?? v.statutAvant} → <strong>{LIBELLE_AVIS[v.statutApres] ?? v.statutApres}</strong> · {new Date(v.decideA).toLocaleString("fr-FR")} · {v.decidePar?.nomComplet ?? "auteur non renseigné"}
                    {v.commentaire && <p className="text-gray-700">{v.commentaire}</p>}
                  </li>
                ))}
              </ol>
            )}
        </section>
      </div>
    </Modal>
  );
}
