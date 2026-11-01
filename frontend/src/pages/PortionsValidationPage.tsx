import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RotateCcw, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";

/**
 * Validation des portions proposées.
 *
 * LE MAILLON QUI MANQUAIT
 *
 * Les portions se créaient depuis le terrain et ne pouvaient jamais devenir officielles :
 * la route `POST /api/v2/portions/:id/validation` existait, et rien ne l'appelait. Le
 * parcours « qualifier → proposer → valider → mettre à jour » s'arrêtait donc à la
 * troisième étape, ce qui faisait de toute la chaîne une collecte sans débouché.
 *
 * TROIS CHOSES QUE CET ÉCRAN DOIT DIRE, ET QUI NE VONT PAS DE SOI
 *
 * **Valider resserre le référentiel.** Une portion validée interdit, par contrainte de
 * base, toute autre portion validée sur les mêmes mètres. Le validateur ne coche pas une
 * case : il tranche, et ferme.
 *
 * **Le serveur refuse l'auto-validation.** Un agent qui a relevé ne valide pas son propre
 * relevé, même avec le rôle. L'écran l'affiche AVANT le clic, parce qu'un 403 après coup
 * donne l'impression d'une panne.
 *
 * **« À corriger » n'est pas un rejet.** Elle renvoie la portion à son auteur en lui disant
 * quoi reprendre. Confondre les deux ferait perdre un relevé que l'agent aurait pu sauver.
 *
 * CE QUE L'ÉCRAN NE FAIT PAS
 *
 * Il ne modifie aucune portion. Requalifier, découper ou fusionner sont des opérations de
 * terrain, avec leurs propres routes et leur propre validation : les offrir ici donnerait au
 * validateur le pouvoir de réécrire ce qu'il doit juger.
 */

interface Portion {
  id: string;
  debutM: number;
  finM: number;
  revetement: string | null;
  etat: string | null;
  praticabilite: string | null;
  statutValidation: string;
  origine: string;
  source: string | null;
  observeeLe: string | null;
  confiance: string | null;
  createdAt: string;
  clientOperationId: string | null;
  troncon: { id: string; code: string; nom: string | null; classe: string } | null;
  creePar: { id: string; nomComplet: string } | null;
  revetementRef: { libelle: string; bitumineux: boolean } | null;
  etatRef: { libelle: string; critique: boolean } | null;
  praticabiliteRef: { libelle: string } | null;
}

type Decision = "VALIDE" | "REJETE" | "A_CORRIGER";

function metres(v: number): string {
  return v >= 1_000 ? `${(v / 1_000).toFixed(2)} km` : `${Math.round(v)} m`;
}

export function PortionsValidationPage() {
  const client = useQueryClient();
  const [selection, setSelection] = useState<string | null>(null);
  const [commentaire, setCommentaire] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["portions", "a-valider"],
    queryFn: async () =>
      (await api.get<{ portions: Portion[]; curseurSuivant: string | null }>(
        "/v2/portions?statut=A_VALIDER&limite=100",
      )).data,
  });

  const decider = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: Decision }) =>
      api.post(`/v2/portions/${id}/validation`, {
        decision,
        ...(commentaire ? { commentaire } : {}),
      }),
    onSuccess: (_r, v) => {
      const mot = v.decision === "VALIDE" ? "validée"
        : v.decision === "REJETE" ? "rejetée" : "renvoyée pour correction";
      toast.success(`Portion ${mot}.`);
      setSelection(null);
      setCommentaire("");
      void client.invalidateQueries({ queryKey: ["portions", "a-valider"] });
    },
    onError: (e) => {
      const r = (e as { response?: { data?: { message?: string; motif?: string } } }).response;
      // Le serveur nomme le motif — AUTO_VALIDATION, HORS_DELEGATION, ROLE_INSUFFISANT.
      // L'afficher tel quel évite de traduire un refus d'autorité en « erreur ».
      toast.error(r?.data?.message ?? "Décision refusée.");
    },
  });

  const portions = data?.portions ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Valider resserre le référentiel.</strong> Une portion validée interdit toute
        autre portion validée sur les mêmes mètres, par contrainte de base. Et{" "}
        <strong>« à corriger » n'est pas un rejet</strong> : elle renvoie le relevé à son
        auteur avec votre commentaire, au lieu de le perdre.
      </div>

      {isLoading && <p className="text-sm text-slate-600">Chargement…</p>}

      {!isLoading && portions.length === 0 && (
        <p className="rounded-lg border bg-white p-6 text-center text-sm text-slate-600">
          Aucune portion en attente de validation.
        </p>
      )}

      <ul className="space-y-3">
        {portions.map((p) => {
          const ouvert = selection === p.id;
          return (
            <li key={p.id} className="rounded-lg border bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-sm">{p.troncon?.code ?? "tronçon inconnu"}</p>
                  <p className="text-sm text-slate-600">
                    {p.troncon?.nom ?? "—"} · {metres(p.debutM)} à {metres(p.finM)}
                    {" · "}{metres(p.finM - p.debutM)}
                  </p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <p>Proposée par {p.creePar?.nomComplet ?? "auteur inconnu"}</p>
                  <p>{new Date(p.createdAt).toLocaleDateString("fr-FR")}</p>
                  {/* L'ORIGINE compte pour juger : un relevé de terrain et un découpage
                      administratif ne s'apprécient pas de la même façon. */}
                  <p>Origine : {p.origine}</p>
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                <dt className="text-slate-500">Revêtement</dt>
                <dd className="sm:col-span-2">
                  {p.revetementRef?.libelle ?? (
                    <span className="text-slate-500">non relevé</span>
                  )}
                  {p.revetementRef?.bitumineux && <span className="text-slate-500"> · bitumineux</span>}
                </dd>
                <dt className="text-slate-500">État</dt>
                <dd className="sm:col-span-2">
                  {p.etatRef?.libelle ?? <span className="text-slate-500">non relevé</span>}
                  {p.etatRef?.critique && <span className="text-red-700"> · critique</span>}
                </dd>
                <dt className="text-slate-500">Praticabilité</dt>
                <dd className="sm:col-span-2">
                  {p.praticabiliteRef?.libelle ?? <span className="text-slate-500">non relevée</span>}
                </dd>
                <dt className="text-slate-500">Constatée le</dt>
                <dd className="sm:col-span-2">
                  {/* Une date de constat ABSENTE n'est pas une date récente. La dire vide
                      évite qu'un validateur suppose qu'elle vaut la date de proposition. */}
                  {p.observeeLe
                    ? new Date(p.observeeLe).toLocaleDateString("fr-FR")
                    : <span className="text-amber-700">date de constat non renseignée</span>}
                </dd>
                <dt className="text-slate-500">Confiance du relevé</dt>
                <dd className="sm:col-span-2">
                  {p.confiance ?? <span className="text-slate-500">non renseignée</span>}
                  {p.confiance === "LOW" && (
                    <span className="text-amber-700"> · appariement GPS douteux</span>
                  )}
                </dd>
                <dt className="text-slate-500">Provenance</dt>
                <dd className="sm:col-span-2">
                  {p.clientOperationId
                    ? <>Terrain, hors ligne ou en ligne</>
                    : <>Console</>}
                  {p.source ? ` · ${p.source}` : ""}
                </dd>
              </dl>

              {p.revetement === null && p.etat === null && (
                <p className="mt-3 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Cette portion n'affirme ni revêtement ni état. La valider ferait occuper
                    ces mètres du référentiel officiel sans rien y dire.
                  </span>
                </p>
              )}

              {!ouvert && (
                <Button variant="outline" className="mt-3" onClick={() => setSelection(p.id)}>
                  Trancher
                </Button>
              )}

              {ouvert && (
                <div className="mt-3 space-y-3 border-t pt-3">
                  <label className="block text-sm">
                    <span className="text-slate-600">
                      Commentaire — <strong>obligatoire pour rejeter ou renvoyer</strong>
                    </span>
                    <textarea
                      value={commentaire}
                      onChange={(e) => setCommentaire(e.target.value)}
                      rows={2}
                      className="mt-1 w-full rounded border px-2 py-1"
                      aria-label="Commentaire de décision"
                      placeholder="Ce que l'auteur doit savoir."
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => decider.mutate({ id: p.id, decision: "VALIDE" })}
                      disabled={decider.isPending}
                    >
                      <CheckCircle2 className="mr-1 h-4 w-4" /> Valider
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => decider.mutate({ id: p.id, decision: "A_CORRIGER" })}
                      disabled={decider.isPending || commentaire.trim() === ""}
                      title={commentaire.trim() === "" ? "Dites à l'auteur quoi reprendre." : undefined}
                    >
                      <RotateCcw className="mr-1 h-4 w-4" /> À corriger
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => decider.mutate({ id: p.id, decision: "REJETE" })}
                      disabled={decider.isPending || commentaire.trim() === ""}
                      title={commentaire.trim() === "" ? "Dites pourquoi vous rejetez." : undefined}
                    >
                      <XCircle className="mr-1 h-4 w-4" /> Rejeter
                    </Button>
                    <Button variant="outline" onClick={() => { setSelection(null); setCommentaire(""); }}>
                      Annuler
                    </Button>
                  </div>

                  <p className="text-xs text-slate-500">
                    Vous ne pouvez pas valider une portion que vous avez vous-même proposée :
                    le serveur le refuse, et c'est la séparation des rôles qui l'exige.
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {data?.curseurSuivant && (
        <p className="text-sm text-slate-600">
          Plus de cent portions en attente. Traitez celles-ci, les suivantes apparaîtront.
        </p>
      )}
    </div>
  );
}
