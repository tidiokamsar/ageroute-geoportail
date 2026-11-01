import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Pencil, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { messageErreur } from "../lib/exploitation";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";

/**
 * Prévisions budgétaires (§ 7.9) — la saisie manuelle de ce qui est PROGRAMMÉ.
 *
 * AUCUN CHAMP N'EST PRÉREMPLI. Pas d'année courante par défaut, pas de montant à zéro :
 * le bouton reste inactif tant que l'année, l'intitulé et le montant ne sont pas posés
 * par la main qui décide. Une prévision naît PROPOSÉE ; RETENUE est un arbitrage que
 * l'écran n'offre qu'en édition, jamais à la création.
 *
 * Le montant se saisit et se transporte en CHAÎNE de chiffres : au-delà de 2^53 un
 * nombre JSON ment silencieusement, et un budget ne ment pas.
 */

export interface PrevisionLigne {
  id: string;
  annee: number;
  intitule: string;
  tronconId: string | null;
  tronconCode: string | null;
  bailleur: string | null;
  typeIntervention: string | null;
  montantPrevuGnf: string;
  priorite: number | null;
  statut: "PROPOSE" | "RETENU" | "REPORTE" | "ANNULE" | "REALISE";
  source: "SAISIE" | "MOTEUR";
  commentaire: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUT_LABEL: Record<PrevisionLigne["statut"], string> = {
  PROPOSE: "Proposée", RETENU: "Retenue", REPORTE: "Reportée", ANNULE: "Annulée", REALISE: "Réalisée",
};
const STATUT_PILL: Record<PrevisionLigne["statut"], string> = {
  PROPOSE: "bg-slate-100 text-slate-700", RETENU: "bg-green-100 text-green-700",
  REPORTE: "bg-amber-100 text-amber-700", ANNULE: "bg-gray-200 text-gray-600",
  REALISE: "bg-blue-100 text-blue-700",
};

function formatGnf(montant: string): string {
  const n = Number(montant);
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Md GNF`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} M GNF`;
  return `${n.toLocaleString("fr-FR")} GNF`;
}

const CHAMPS_VIDES = {
  annee: "", intitule: "", montant: "", bailleur: "", typeIntervention: "",
  tronconCode: "", priorite: "", commentaire: "",
};

export function PrevisionsBudgetaires() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const peutSaisir = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";

  const [saisie, setSaisie] = useState({ ...CHAMPS_VIDES });
  const [editionId, setEditionId] = useState<string | null>(null);
  const [statutSaisie, setStatutSaisie] = useState<string>("");

  const { data: troncons } = useQuery({
    queryKey: ["troncons", "options-previsions"],
    queryFn: async () => (await api.get<{ data: Array<{ id: string; code: string; nom: string | null }> }>("/troncons", {
      params: { pageSize: 100 },
    })).data,
    staleTime: 5 * 60 * 1000,
  });

  const { data: reponse, isLoading } = useQuery({
    queryKey: ["v2", "programmation"],
    queryFn: async () => (await api.get<{ data: PrevisionLigne[]; total: number }>("/v2/programmation", {
      params: { pageSize: 200 },
    })).data,
  });
  const lignes = reponse?.data ?? [];

  const invalider = () => { void qc.invalidateQueries({ queryKey: ["v2", "programmation"] }); };

  const creer = useMutation({
    mutationFn: async (corps: Record<string, unknown>) => (await api.post("/v2/programmation", corps)).data,
    onSuccess: () => { toast.success("Prévision enregistrée (proposée)."); setSaisie({ ...CHAMPS_VIDES }); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Création refusée.")),
  });

  const modifier = useMutation({
    mutationFn: async ({ id, corps }: { id: string; corps: Record<string, unknown> }) =>
      (await api.patch(`/v2/programmation/${id}`, corps)).data,
    onSuccess: () => { toast.success("Prévision révisée."); setEditionId(null); setSaisie({ ...CHAMPS_VIDES }); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Révision refusée.")),
  });

  const supprimer = useMutation({
    mutationFn: async (id: string) => (await api.post(`/v2/programmation/${id}/supprimer`)).data,
    onSuccess: () => { toast.success("Prévision retirée (suppression logique)."); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Suppression refusée.")),
  });

  const tronconIdDepuisCode = (code: string): string | null =>
    troncons?.data.find((t) => t.code === code.trim())?.id ?? null;

  const anneeValide = /^\d{4}$/.test(saisie.annee) && Number(saisie.annee) >= 2000 && Number(saisie.annee) <= 2100;
  const intituleValide = saisie.intitule.trim().length >= 3;
  const montantValide = /^\d+$/.test(saisie.montant.trim());
  const formulaireValide = anneeValide && intituleValide && montantValide;

  const corpsDepuisSaisie = (): Record<string, unknown> => {
    const idTroncon = tronconIdDepuisCode(saisie.tronconCode);
    return {
      annee: Number(saisie.annee),
      intitule: saisie.intitule.trim(),
      montantPrevuGnf: saisie.montant.trim(),
      bailleur: saisie.bailleur.trim() || null,
      typeIntervention: saisie.typeIntervention.trim() || null,
      tronconId: idTroncon,
      priorite: saisie.priorite.trim() ? Number(saisie.priorite) : null,
      commentaire: saisie.commentaire.trim() || null,
    };
  };

  const soumettre = () => {
    if (!formulaireValide) return;
    if (editionId) {
      modifier.mutate({ id: editionId, corps: { ...corpsDepuisSaisie(), ...(statutSaisie ? { statut: statutSaisie } : {}) } });
    } else {
      creer.mutate(corpsDepuisSaisie());
    }
  };

  const ouvrirEdition = (l: PrevisionLigne) => {
    setEditionId(l.id);
    setStatutSaisie(l.statut);
    setSaisie({
      annee: String(l.annee),
      intitule: l.intitule,
      montant: l.montantPrevuGnf,
      bailleur: l.bailleur ?? "",
      typeIntervention: l.typeIntervention ?? "",
      tronconCode: l.tronconCode ?? "",
      priorite: l.priorite != null ? String(l.priorite) : "",
      commentaire: l.commentaire ?? "",
    });
  };

  const totalPrevu = lignes.reduce((s, l) => (l.statut === "ANNULE" ? s : s + BigInt(l.montantPrevuGnf)), 0n);

  return (
    <Card className="no-print">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-navy flex items-center gap-2">
            <CalendarPlus className="h-4 w-4 text-navy/60" />
            Prévisions budgétaires (saisie)
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Ce qui est programmé avant de devenir chantier · {lignes.length} prévision(s) · {formatGnf(totalPrevu.toString())} hors annulées
          </p>
        </div>
      </div>

      {peutSaisir && (
        <form
          className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4 items-end"
          onSubmit={(e) => { e.preventDefault(); soumettre(); }}
        >
          <div>
            <label htmlFor="prev-annee" className="block text-xs font-medium text-gray-600 mb-1">Année *</label>
            <input
              id="prev-annee" inputMode="numeric" value={saisie.annee}
              onChange={(e) => setSaisie({ ...saisie, annee: e.target.value })}
              placeholder="2027" aria-required="true"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="prev-intitule" className="block text-xs font-medium text-gray-600 mb-1">Intitulé *</label>
            <input
              id="prev-intitule" value={saisie.intitule}
              onChange={(e) => setSaisie({ ...saisie, intitule: e.target.value })}
              placeholder="Réhabilitation RN1 Conakry–Kindia" aria-required="true"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          <div>
            <label htmlFor="prev-montant" className="block text-xs font-medium text-gray-600 mb-1">Montant prévu (GNF) *</label>
            <input
              id="prev-montant" inputMode="numeric" value={saisie.montant}
              onChange={(e) => setSaisie({ ...saisie, montant: e.target.value })}
              placeholder="2400000000" aria-required="true"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          <div>
            <label htmlFor="prev-bailleur" className="block text-xs font-medium text-gray-600 mb-1">Bailleur</label>
            <input
              id="prev-bailleur" value={saisie.bailleur}
              onChange={(e) => setSaisie({ ...saisie, bailleur: e.target.value })}
              placeholder="AFD, BAD, Budget national…" aria-required="false"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          <div>
            <label htmlFor="prev-type" className="block text-xs font-medium text-gray-600 mb-1">Type d'intervention</label>
            <input
              id="prev-type" value={saisie.typeIntervention}
              onChange={(e) => setSaisie({ ...saisie, typeIntervention: e.target.value })}
              placeholder="Réhabilitation, entretien périodique…" aria-required="false"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          <div>
            <label htmlFor="prev-troncon" className="block text-xs font-medium text-gray-600 mb-1">Tronçon (code)</label>
            <input
              id="prev-troncon" list="prev-troncons-options" value={saisie.tronconCode}
              onChange={(e) => setSaisie({ ...saisie, tronconCode: e.target.value })}
              placeholder="GN N0001" aria-required="false"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
            <datalist id="prev-troncons-options">
              {(troncons?.data ?? []).map((t) => (
                <option key={t.id} value={t.code}>{t.nom}</option>
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="prev-priorite" className="block text-xs font-medium text-gray-600 mb-1">Priorité (rang)</label>
            <input
              id="prev-priorite" inputMode="numeric" value={saisie.priorite}
              onChange={(e) => setSaisie({ ...saisie, priorite: e.target.value })}
              placeholder="1, 2, 3…" aria-required="false"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          {editionId && (
            <div>
              <label htmlFor="prev-statut" className="block text-xs font-medium text-gray-600 mb-1">Statut (arbitrage)</label>
              <select
                id="prev-statut" value={statutSaisie}
                onChange={(e) => setStatutSaisie(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
              >
                {Object.entries(STATUT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          )}
          <div className="md:col-span-3">
            <label htmlFor="prev-commentaire" className="block text-xs font-medium text-gray-600 mb-1">Commentaire</label>
            <input
              id="prev-commentaire" value={saisie.commentaire}
              onChange={(e) => setSaisie({ ...saisie, commentaire: e.target.value })}
              placeholder="Hypothèses, référence d'arbitrage…" aria-required="false"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={!formulaireValide || creer.isPending || modifier.isPending}>
              {editionId ? "Réviser la prévision" : "Poser la prévision"}
            </Button>
            {editionId && (
              <Button
                type="button" variant="outline"
                onClick={() => { setEditionId(null); setStatutSaisie(""); setSaisie({ ...CHAMPS_VIDES }); }}
              >
                Annuler
              </Button>
            )}
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-sm text-gray-400">Chargement…</p>
      ) : lignes.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center">
          Aucune prévision saisie. {peutSaisir ? "La première se pose ci-dessus : rien n'est prérempli." : "Aucune saisie n'est possible depuis un compte lecteur."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase">
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 pr-3">Année</th>
                <th className="text-left py-2 pr-3">Intitulé</th>
                <th className="text-left py-2 pr-3">Bailleur</th>
                <th className="text-left py-2 pr-3">Type</th>
                <th className="text-right py-2 pr-3">Montant prévu</th>
                <th className="text-right py-2 pr-3">Priorité</th>
                <th className="text-left py-2 pr-3">Statut</th>
                <th className="text-right py-2 w-24 no-print">Actions</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={l.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="py-2 pr-3 font-semibold text-navy tabular-nums">{l.annee}</td>
                  <td className="py-2 pr-3 text-gray-700">
                    {l.intitule}
                    {l.tronconCode && <span className="text-xs text-gray-400"> · {l.tronconCode}</span>}
                  </td>
                  <td className="py-2 pr-3 text-gray-600">{l.bailleur ?? "—"}</td>
                  <td className="py-2 pr-3 text-gray-500">{l.typeIntervention ?? "—"}</td>
                  <td className="py-2 pr-3 text-right text-gray-700 tabular-nums whitespace-nowrap">{formatGnf(l.montantPrevuGnf)}</td>
                  <td className="py-2 pr-3 text-right text-gray-500 tabular-nums">{l.priorite ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUT_PILL[l.statut]}`}>
                      {STATUT_LABEL[l.statut]}
                    </span>
                  </td>
                  <td className="py-2 text-right no-print">
                    {peutSaisir && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button" aria-label={`Modifier la prévision ${l.intitule}`}
                          onClick={() => ouvrirEdition(l)}
                          className="p-1.5 rounded-md hover:bg-navy/10 text-navy/70"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button" aria-label={`Retirer la prévision ${l.intitule}`}
                          onClick={() => { if (window.confirm(`Retirer la prévision « ${l.intitule} » ? Suppression logique : elle reste dans l'audit.`)) supprimer.mutate(l.id); }}
                          className="p-1.5 rounded-md hover:bg-red-100 text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
