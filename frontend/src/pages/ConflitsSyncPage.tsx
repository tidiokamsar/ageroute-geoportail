import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { lignesComparatif, type ConflitSync, type ReponseConflits } from "../lib/conflitsSync";

/**
 * Conflits de synchronisation : deux versions, une décision humaine.
 *
 * POURQUOI CET ÉCRAN EXISTE
 *
 * Quand deux appareils (ou un appareil et le serveur) portent des versions différentes de la même
 * donnée, le serveur ne départage jamais par l'horloge d'un téléphone : il CONSERVE LES DEUX et ouvre un
 * conflit. La table, la route de résolution et le signalement au téléphone existaient ; aucun écran ne
 * montrait ces conflits à quelqu'un qui peut trancher. Ils s'accumulaient, invisibles.
 *
 * TROIS GESTES, ET CE QU'ILS FONT RÉELLEMENT
 *
 * **Garder la version du serveur** : ne modifie rien. La version du téléphone reste conservée dans le conflit.
 * **Retenir la version du téléphone** : écrit la modification ou la suppression (logique) sur l'observation,
 * auditée. Impossible pour une création ou un défaut : la liste le dit avant le clic, avec la raison,
 * parce qu'un 409 après coup passerait pour une panne.
 * **Demander une vérification** : ne tranche pas. Le conflit reste ouvert, avec qui l'a demandée et pourquoi.
 *
 * CE QUE L'ÉCRAN NE FAIT PAS
 *
 * Il ne fusionne pas, ne propose pas de « troisième version » et ne supprime rien : les deux versions
 * restent consultables après l'arbitrage, côté serveur.
 */

const LIBELLE_OPERATION: Record<string, string> = {
  CREATE: "Création", UPDATE: "Modification", DELETE: "Suppression",
};
const LIBELLE_TYPE: Record<string, string> = { Observation: "Observation", Defaut: "Défaut" };
const LIBELLE_MOTIF: Record<string, string> = {
  VERSION_PERIMEE: "Le serveur a changé depuis la dernière version connue du téléphone.",
  DEJA_EXISTANTE: "Le serveur porte déjà cet élément, créé sous une autre opération.",
  VERSION_MODIFIEE: "Le serveur a changé pendant la synchronisation.",
};

function date(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function message(e: unknown): string {
  const r = (e as { response?: { status?: number; data?: { message?: string } } }).response;
  return r?.data?.message ?? "Le serveur n'a pas répondu. Réessayez.";
}

function CarteConflit({ conflit }: { conflit: ConflitSync }) {
  const client = useQueryClient();
  const [choix, setChoix] = useState<"SERVEUR" | "LOCAL" | "VERIFICATION" | null>(null);
  const [motifVerification, setMotifVerification] = useState("");
  const lignes = lignesComparatif(conflit);
  const idTitre = `conflit-${conflit.id}`;

  const trancher = useMutation({
    mutationFn: (resolution: "SERVEUR" | "LOCAL") => api.post("/v2/sync/resolve", { conflitId: conflit.id, resolution }),
    onSuccess: (_r, resolution) => {
      toast.success(resolution === "SERVEUR"
        ? "Version du serveur retenue. La version du téléphone reste conservée."
        : "Version du téléphone retenue.");
      setChoix(null);
      void client.invalidateQueries({ queryKey: ["sync", "conflits"] });
    },
    onError: (e) => toast.error(message(e)),
  });

  const verifier = useMutation({
    mutationFn: () => api.post(`/v2/sync/conflits/${conflit.id}/verification`, { motif: motifVerification.trim() }),
    onSuccess: () => {
      toast.success("Vérification demandée. Le conflit reste ouvert.");
      setChoix(null);
      setMotifVerification("");
      void client.invalidateQueries({ queryKey: ["sync", "conflits"] });
    },
    onError: (e) => toast.error(message(e)),
  });

  const occupe = trancher.isPending || verifier.isPending;
  const { LOCAL: localPossible, motifLocalImpossible } = conflit.resolutionsPossibles;

  return (
    <article aria-labelledby={idTitre} className="space-y-3 rounded-lg border bg-white p-4">
      <header>
        <h2 id={idTitre} className="font-semibold">
          {LIBELLE_TYPE[conflit.entityType] ?? conflit.entityType}
          {" "}<span className="font-mono text-xs text-slate-500">{conflit.entityId}</span>
        </h2>
        <p className="text-sm text-slate-600">
          {conflit.operation ? LIBELLE_OPERATION[conflit.operation] : "Opération inconnue"} demandée par{" "}
          <strong>{conflit.agent?.nomComplet ?? "un agent inconnu"}</strong>
          {conflit.appareil && <> depuis « {conflit.appareil.nom} »</>}, conflit ouvert le {date(conflit.creeLe)}.
        </p>
        {conflit.motif && (
          <p className="text-sm text-slate-600">
            {LIBELLE_MOTIF[conflit.motif] ?? conflit.motif}
          </p>
        )}
        {conflit.operation === "DELETE" && (
          <p className="mt-1 text-sm font-medium text-amber-900">Le téléphone demande la SUPPRESSION de cet élément (suppression logique, la ligne est conservée).</p>
        )}
      </header>

      <table className="w-full border-collapse text-sm">
        <caption className="mb-1 text-left text-xs text-slate-500">
          Les deux versions côte à côte. « différent » marque un champ où le téléphone et le serveur ne disent pas la même chose.
        </caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-1 pr-3">Champ</th>
            <th scope="col" className="py-1 pr-3">Version du téléphone</th>
            <th scope="col" className="py-1">Version du serveur</th>
          </tr>
        </thead>
        <tbody>
          {lignes.length === 0 && (
            <tr><td colSpan={3} className="py-2 text-slate-600">Le téléphone n'a envoyé aucun champ (suppression).</td></tr>
          )}
          {lignes.map((l) => (
            <tr key={l.champ} className={`border-b align-top ${l.different ? "bg-amber-50" : ""}`}>
              <th scope="row" className="py-1 pr-3 text-left font-mono text-xs font-normal">
                {l.champ}{l.different && <span className="ml-2 rounded bg-amber-200 px-1 text-[11px] font-semibold text-amber-900">différent</span>}
              </th>
              <td className="py-1 pr-3 break-words">{l.local}</td>
              <td className="py-1 break-words">{l.serveur}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {conflit.verificationDemandee && (
        <p className="rounded border border-sky-300 bg-sky-50 p-2 text-sm text-sky-900">
          <strong>Vérification demandée</strong> le {date(conflit.verificationDemandee.le)}
          {conflit.verificationDemandee.motif && <> : {conflit.verificationDemandee.motif}</>}. Le conflit reste ouvert.
        </p>
      )}

      {choix === null && (
        <div className="flex flex-wrap items-start gap-2">
          <Button type="button" variant="outline" disabled={occupe} onClick={() => setChoix("SERVEUR")}>
            Garder la version du serveur
          </Button>
          <div>
            <Button
              type="button" variant="outline" disabled={occupe || !localPossible}
              aria-describedby={localPossible ? undefined : `${idTitre}-local`}
              onClick={() => setChoix("LOCAL")}
            >
              Retenir la version du téléphone
            </Button>
            {!localPossible && motifLocalImpossible && (
              <p id={`${idTitre}-local`} className="mt-1 max-w-sm text-xs text-slate-600">{motifLocalImpossible}</p>
            )}
          </div>
          {!conflit.verificationDemandee && (
            <Button type="button" variant="outline" disabled={occupe} onClick={() => setChoix("VERIFICATION")}>
              Demander une vérification
            </Button>
          )}
        </div>
      )}

      {(choix === "SERVEUR" || choix === "LOCAL") && (
        <div role="group" aria-label="Confirmer l'arbitrage" className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>
            {choix === "SERVEUR"
              ? "Garder la version du serveur : rien n'est modifié. La version du téléphone reste conservée dans le conflit, et le téléphone apprendra que sa saisie n'a pas été retenue."
              : conflit.operation === "DELETE"
                ? "Retenir la version du téléphone : l'élément sera supprimé LOGIQUEMENT (la ligne est conservée), au nom de l'arbitre, avec une trace d'audit."
                : "Retenir la version du téléphone : sa modification sera écrite sur le serveur, au nom de l'arbitre, avec une trace d'audit."}
            {" "}Cette décision est définitive.
          </p>
          <div className="flex gap-2">
            <Button type="button" disabled={occupe} onClick={() => trancher.mutate(choix)}>Confirmer</Button>
            <Button type="button" variant="outline" disabled={occupe} onClick={() => setChoix(null)}>Annuler</Button>
          </div>
        </div>
      )}

      {choix === "VERIFICATION" && (
        <form
          aria-label="Demander une vérification"
          className="space-y-2 rounded border border-sky-300 bg-sky-50 p-3 text-sm"
          onSubmit={(e) => { e.preventDefault(); if (motifVerification.trim().length >= 3) verifier.mutate(); }}
        >
          <label htmlFor={`${idTitre}-motif`} className="block font-medium">Pourquoi une vérification ?</label>
          <textarea
            id={`${idTitre}-motif`}
            className="min-h-20 w-full rounded-md border border-input bg-white px-3 py-2 text-base md:text-sm"
            value={motifVerification}
            maxLength={1000}
            onChange={(e) => setMotifVerification(e.target.value)}
          />
          <p className="text-xs text-slate-600">Le conflit n'est pas tranché : il reste ouvert, avec votre demande.</p>
          <div className="flex gap-2">
            <Button type="submit" disabled={occupe || motifVerification.trim().length < 3}>Envoyer la demande</Button>
            <Button type="button" variant="outline" disabled={occupe} onClick={() => setChoix(null)}>Annuler</Button>
          </div>
        </form>
      )}
    </article>
  );
}

export function ConflitsSyncPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["sync", "conflits"],
    queryFn: async () => (await api.get<ReponseConflits>("/v2/sync/conflits?limite=100")).data,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
        <strong>Les deux versions sont toujours conservées.</strong> Trancher ne supprime rien : la version non
        retenue reste consultable dans le conflit. Aucune fusion automatique n'existe, le serveur ne départage
        jamais par l'horloge d'un téléphone.
      </div>

      {isLoading && <p role="status" className="text-sm text-slate-600">Chargement des conflits…</p>}

      {isError && (
        <p role="alert" className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {message(error)}
        </p>
      )}

      {data && data.conflits.length === 0 && (
        <p className="text-sm text-slate-700">Aucun conflit ouvert. Toutes les synchronisations reçues ont été appliquées ou tranchées.</p>
      )}

      {data && data.conflits.length > 0 && (
        <p className="text-sm text-slate-700">
          {data.total} conflit(s) ouvert(s){data.tronque && ` (les ${data.conflits.length} plus anciens sont affichés)`}.
        </p>
      )}

      {data?.conflits.map((c) => <CarteConflit key={c.id} conflit={c} />)}
    </div>
  );
}
