import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { parseApiError } from "../lib/errors";
import { Button } from "./ui/Button";

/**
 * ChangerEtatCorridor — l'état d'une route ENTIERE, d'une ville à l'autre, en UNE
 * décision (besoin du 23/10 : « de Coyah à Kindia il y a beaucoup de tronçons,
 * comment faire en une fois ? »).
 *
 * Le corridor est déjà sélectionné (RechercheVille) ; ce panneau applique le nouvel
 * état à TOUS les tronçons affichés. La transaction serveur est unique, chaque
 * tronçon porte son avant dans l'audit, et le MOTIF est exigé : changer l'état de
 * 80 tronçons d'un geste est un acte de gestion, il se motive et se trace.
 *
 * DEUX TEMPS : « Vérifier » puis « Confirmer ». Un clic ne modifie jamais 80 tronçons : le
 * premier affiche un récapitulatif (combien, de quel état vers lequel, quel motif), le
 * second seul envoie. Le focus se pose sur « Revenir », le choix sans conséquence.
 *
 * Le résultat compte ce qui a vraiment bougé : un tronçon déjà dans l'état demandé
 * n'est ni réécrit ni compté — l'écran le dit, pour qu'un compte « 0 modifié » ne
 * ressemble pas à une panne.
 */

const ETATS = [
  { valeur: "BON", libellé: "Bon" },
  { valeur: "MOYEN", libellé: "Moyen" },
  { valeur: "MAUVAIS", libellé: "Mauvais" },
  { valeur: "CRITIQUE", libellé: "Critique" },
  { valeur: "NON_EVALUE", libellé: "Non évalué" },
] as const;

/** « 2 bon, 1 moyen » : l'état d'AVANT des tronçons concernés, tel que la carte le connaît. */
function repartitionActuelle(etatsActuels: string[]): string {
  const comptes = new Map<string, number>();
  for (const e of etatsActuels) comptes.set(e, (comptes.get(e) ?? 0) + 1);
  return ETATS.filter((x) => comptes.has(x.valeur))
    .map((x) => `${comptes.get(x.valeur)} ${x.libellé.toLowerCase()}`)
    .join(", ");
}

export function ChangerEtatCorridor({
  ids, libelle, onApplique, etatsActuels,
}: {
  ids: string[];
  libelle: string;
  onApplique?: () => void;
  /** États actuels des tronçons de `ids` (un par tronçon), pour le récapitulatif de confirmation. */
  etatsActuels?: string[];
}) {
  const [ouvert, setOuvert] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const revenirRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmation) revenirRef.current?.focus(); }, [confirmation]);
  const [etat, setEtat] = useState("");
  const [motif, setMotif] = useState("");
  const [resultat, setResultat] = useState<{ modifie: number; inchanges: number } | null>(null);

  const mutation = useMutation({
    mutationFn: async () => (await api.post<{ modifie: number; inchanges: number; introuvables: string[] }>(
      "/v2/troncons-corridor/bulk-etat",
      { ids, etat, motif: motif.trim() },
    )).data,
    onSuccess: (r) => {
      toast.success(`${r.modifie} tronçon(s) passé(s) à l'état choisi, ${r.inchanges} déjà à jour.`);
      setResultat({ modifie: r.modifie, inchanges: r.inchanges });
      setEtat(""); setMotif(""); setConfirmation(false);
      onApplique?.();
    },
    onError: (e) => { toast.error(parseApiError(e).message); setConfirmation(false); },
  });

  const pret = etat !== "" && motif.trim().length >= 5;
  const etatChoisi = ETATS.find((e) => e.valeur === etat)?.libellé ?? etat;
  const avant = etatsActuels && etatsActuels.length > 0 ? repartitionActuelle(etatsActuels) : null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {!ouvert ? (
        <button
          type="button"
          onClick={() => { setOuvert(true); setResultat(null); }}
          className="flex items-center gap-1.5 rounded-full bg-gold px-3 py-1 text-xs font-semibold text-navy shadow-md hover:bg-gold/90"
        >
          <Layers className="h-3 w-3" />
          Changer l'état du corridor ({ids.length})
        </button>
      ) : (
        <div className="rounded-lg border border-gold/60 bg-white p-3 shadow-lg space-y-2 w-full max-w-72">
          <p className="text-xs font-semibold text-navy">
            Corridor {libelle} — {ids.length} tronçon(s)
          </p>
          {!confirmation && (<>
          <div>
            <label htmlFor="corridor-etat" className="block text-xs text-gray-600 mb-1">Nouvel état *</label>
            <select
              id="corridor-etat" value={etat} required
              onChange={(e) => setEtat(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            >
              <option value="">— Choisir —</option>
              {ETATS.map((e) => <option key={e.valeur} value={e.valeur}>{e.libellé}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="corridor-motif" className="block text-xs text-gray-600 mb-1">Motif de la décision *</label>
            <input
              id="corridor-motif" value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder="Campagne de reconnaissance, constat régional…"
              aria-required="true"
              className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20"
            />
          </div>
          </>)}
          {resultat && !confirmation && (
            <p role="status" className="rounded-md bg-navy/5 px-2 py-1.5 text-xs text-navy">
              {resultat.modifie} modifié(s), {resultat.inchanges} déjà à jour. Chaque changement est dans l'audit.
            </p>
          )}
          {confirmation ? (
            <>
              <div role="group" aria-label="Récapitulatif avant application" className="rounded-md border border-amber-300 bg-amber-50 px-2 py-2 text-xs text-amber-950 space-y-1">
                <p>
                  <strong>{ids.length} tronçon(s)</strong>, de l'état {avant ? `actuel (${avant})` : "actuel de chacun"} vers
                  l'état <strong>{etatChoisi}</strong>.
                </p>
                <p>Motif : « {motif.trim()} ».</p>
                <p>L'état précédent de chaque tronçon reste dans l'audit.</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                  {mutation.isPending ? "Application…" : "Confirmer"}
                </Button>
                <Button ref={revenirRef} variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setConfirmation(false)}>
                  Revenir
                </Button>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" disabled={!pret} onClick={() => setConfirmation(true)}>
                {`Vérifier avant d'appliquer à ${ids.length} tronçon(s)`}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setOuvert(false); setResultat(null); }}>
                Fermer
              </Button>
            </div>
          )}
          <p className="text-[11px] text-gray-500">Chaque tronçon garde son état d'avant dans l'audit, avec votre motif.</p>
        </div>
      )}
    </div>
  );
}
