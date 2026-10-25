import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Satellite } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { messageErreur } from "../lib/exploitation";
import { DepotModal, ProduitModal } from "./teledetection/Saisies";

/**
 * Observation de la Terre (partie E) : propositions de télédétection et verdict du terrain.
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **Une proposition n'est pas un fait.** Elle reste « à vérifier » jusqu'à ce qu'un constat de
 * terrain la confirme ou l'infirme ; le verdict cite ce constat et ne se reprend pas.
 *
 * **Un score n'est pas une probabilité.** C'est ce que la méthode rend ; la précision se lit en
 * bas de l'écran, mesurée contre les verdicts, et elle est vide tant qu'aucun verdict n'existe.
 *
 * **Rien n'est téléchargé ni traité ici.** Les produits et propositions arrivent par l'API, depuis
 * un traitement extérieur au dépôt.
 */

interface Proposition {
  id: string;
  type: string;
  methode: string;
  score: number | null;
  statut: "A_VERIFIER" | "CONFIRMEE" | "INFIRMEE";
  distanceTronconM: number | null;
  missionId: string | null;
  motifVerdict: string | null;
  constatRef: string | null;
  produit: { code: string; source: string; dateAcquisition: string };
  troncon: { code: string; nom: string } | null;
}
interface LignePrecision { type: string; methode: string; total: number; aVerifier: number; confirmees: number; infirmees: number; precision: number | null }
interface Produit {
  id: string; code: string; palier: number; source: string; nature: string; dateAcquisition: string; dateFin: string | null; resolutionM: number;
  couvertureNuagesPct: number | null; incertitude: string; provenance: string; licence: string; versionTraitement: string; autorisationDepenseRef: string | null;
}

const LIBELLE_TYPE: Record<string, string> = {
  NOUVELLE_ROUTE: "Nouvelle route", COUPURE_PROBABLE: "Coupure probable", VEGETATION: "Végétation", INONDATION: "Inondation",
};

function Verdict({ p, onFait }: { p: Proposition; onFait: () => void }) {
  const [statut, setStatut] = useState("");
  const [motif, setMotif] = useState("");
  const [constat, setConstat] = useState("");
  const poser = useMutation({
    mutationFn: async () => (await api.post(`/v2/teledetection/propositions/${p.id}/verdict`, { statut, motif: motif.trim(), constatRef: constat.trim() })).data,
    onSuccess: () => { toast.success("Verdict du terrain enregistré."); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Verdict refusé.")),
  });
  const depecher = useMutation({
    mutationFn: async () => (await api.post<{ code: string }>(`/v2/teledetection/propositions/${p.id}/verification`, {})).data,
    onSuccess: (m) => { toast.success(`Mission ${m.code} créée en brouillon.`); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Mission refusée.")),
  });
  const complet = statut && motif.trim() && constat.trim();
  return (
    <div className="mt-2 space-y-2 border-t pt-2 text-sm">
      {!p.missionId && <Button size="sm" variant="secondary" disabled={depecher.isPending} onClick={() => depecher.mutate()}>Dépêcher une vérification</Button>}
      {p.missionId && <p className="text-gray-600">Mission de vérification dépêchée.</p>}
      <form className="grid gap-2 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (complet) poser.mutate(); }}>
        <label>Verdict
          <select className="mt-1 w-full rounded border px-2 py-1" value={statut} onChange={(e) => setStatut(e.target.value)}>
            <option value="">—</option><option value="CONFIRMEE">Confirmée par le terrain</option><option value="INFIRMEE">Infirmée par le terrain</option>
          </select>
        </label>
        <label className="md:col-span-2">Ce que le terrain a constaté
          <input className="mt-1 w-full rounded border px-2 py-1" maxLength={1000} value={motif} onChange={(e) => setMotif(e.target.value)} />
        </label>
        <label>Référence du constat
          <input className="mt-1 w-full rounded border px-2 py-1" maxLength={200} placeholder="mission, observation…" value={constat} onChange={(e) => setConstat(e.target.value)} />
        </label>
        <div className="md:col-span-4"><Button size="sm" type="submit" disabled={!complet || poser.isPending}>Enregistrer le verdict</Button></div>
      </form>
    </div>
  );
}

interface Anomalie { propositionId: string; regle: string; detail: string | null; gravite: "BLOQUANTE" | "A_EXAMINER" }
interface Coherence { bloquantes: number; aExaminer: number; tronquee: boolean; anomalies: Anomalie[] }

const LIBELLE_REGLE: Record<string, string> = {
  HORS_EMPRISE_PRODUIT: "Hors de l'emprise du produit",
  HORS_EMPRISE_REFERENCE: "Hors de l'emprise du produit de référence",
  REFERENCE_NON_ANTERIEURE: "Référence non antérieure au produit",
  VERDICT_AVANT_DEPOT: "Verdict antérieur au dépôt",
  TRONCON_SUPPRIME: "Tronçon retiré depuis le rattachement",
  PRODUIT_RETIRE_EN_ATTENTE: "Produit retiré, proposition en attente",
  MISSION_SANS_VERDICT: "Mission close sans verdict",
  VERDICT_AVANT_FIN_MISSION: "Verdict avant la fin de la mission",
};

export function TeledetectionPage() {
  const { user } = useAuth();
  const peutEcrire = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const client = useQueryClient();
  const [filtre, setFiltre] = useState<"A_VERIFIER" | "CONFIRMEE" | "INFIRMEE">("A_VERIFIER");

  const propositions = useQuery({
    queryKey: ["teledetection", "propositions", filtre],
    queryFn: async () => (await api.get<{ propositions: Proposition[] }>("/v2/teledetection/propositions", { params: { statut: filtre } })).data.propositions,
  });
  const precision = useQuery({
    queryKey: ["teledetection", "precision"],
    queryFn: async () => (await api.get<{ lignes: LignePrecision[] }>("/v2/teledetection/precision")).data.lignes,
  });
  const produits = useQuery({
    queryKey: ["teledetection", "produits"],
    queryFn: async () => (await api.get<{ produits: Produit[] }>("/v2/teledetection/produits")).data.produits,
  });
  const [saisieProduit, setSaisieProduit] = useState(false);
  const [saisieLot, setSaisieLot] = useState(false);
  const coherence = useQuery({
    queryKey: ["teledetection", "coherence"],
    queryFn: async () => (await api.get<Coherence>("/v2/teledetection/coherence")).data,
  });
  const rafraichir = () => client.invalidateQueries({ queryKey: ["teledetection"] });

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
        <Satellite className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Ces détections sont des <strong>propositions</strong>, jamais des données officielles. Seul le terrain les confirme ou les infirme ; aucune ne modifie le référentiel.</span>
      </p>

      <section className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Propositions</h2>
          {(["A_VERIFIER", "CONFIRMEE", "INFIRMEE"] as const).map((s) => (
            <Button key={s} size="sm" variant={filtre === s ? "default" : "ghost"} onClick={() => setFiltre(s)}>
              {s === "A_VERIFIER" ? "À vérifier" : s === "CONFIRMEE" ? "Confirmées" : "Infirmées"}
            </Button>
          ))}
        </div>
        {propositions.isLoading ? <p className="mt-2 text-gray-500">Chargement…</p>
          : !propositions.data?.length ? <p className="mt-2 text-gray-500">Aucune proposition dans cette catégorie.</p>
          : (
            <ul className="mt-2 space-y-2">
              {propositions.data.map((p) => (
                <li key={p.id} className="rounded border p-2">
                  <div className="flex flex-wrap justify-between gap-2 text-sm">
                    <span className="font-medium">{LIBELLE_TYPE[p.type] ?? p.type}</span>
                    <span className="text-gray-600">{p.produit.source} du {new Date(p.produit.dateAcquisition).toLocaleDateString("fr-FR")} · méthode {p.methode}{p.score !== null ? ` · score ${p.score.toFixed(2)}` : ""}</span>
                  </div>
                  <div className="text-sm text-gray-700">
                    {p.troncon ? `Rattachée à ${p.troncon.code} (${p.troncon.nom}), à ${Math.round(p.distanceTronconM ?? 0)} m` : "Non rattachée à un tronçon"}
                  </div>
                  {p.statut !== "A_VERIFIER" && <div className="text-sm">Terrain : {p.motifVerdict} ({p.constatRef})</div>}
                  {peutEcrire && p.statut === "A_VERIFIER" && <Verdict p={p} onFait={rafraichir} />}
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-3">
        <h2 className="font-semibold">Précision mesurée contre le terrain</h2>
        <p className="text-xs text-gray-500">Confirmées ÷ (confirmées + infirmées). Vide tant qu'aucun verdict n'existe : une méthode jamais jugée n'a pas de précision.</p>
        {!precision.data?.length ? <p className="mt-2 text-sm text-gray-500">Aucune proposition déposée.</p> : (
          <div className="overflow-x-auto">
          <table className="mt-2 w-full min-w-[28rem] text-sm">
            <thead><tr className="text-left text-gray-500"><th>Type</th><th>Méthode</th><th>À vérifier</th><th>Confirmées</th><th>Infirmées</th><th>Précision</th></tr></thead>
            <tbody>
              {precision.data.map((l) => (
                <tr key={`${l.type}-${l.methode}`} className="border-t">
                  <td>{LIBELLE_TYPE[l.type] ?? l.type}</td><td>{l.methode}</td><td>{l.aVerifier}</td><td>{l.confirmees}</td><td>{l.infirmees}</td>
                  <td>{l.precision === null ? "— (aucun verdict)" : `${Math.round(l.precision * 100)} %`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-3" aria-labelledby="titre-coherence">
        <h2 id="titre-coherence" className="font-semibold">Cohérence du registre, des propositions et des verdicts</h2>
        <p className="text-xs text-gray-500">« Bloquante » : la précision mesurée est faussée. « À examiner » : quelque chose reste en suspens. Rien n'est corrigé automatiquement.</p>
        {coherence.isLoading ? <p className="mt-2 text-sm text-gray-500">Chargement…</p>
          : coherence.isError ? <p className="mt-2 text-sm text-red-700">Contrôle de cohérence indisponible.</p>
          : !coherence.data?.anomalies?.length ? <p className="mt-2 text-sm text-gray-700">Aucune anomalie.</p>
          : (
            <>
              <p className="mt-2 text-sm"><strong>{coherence.data.bloquantes}</strong> bloquante(s), <strong>{coherence.data.aExaminer}</strong> à examiner{coherence.data.tronquee ? " (liste limitée aux 1 000 premières)" : ""}.</p>
              <ul className="mt-1 divide-y text-sm">
                {coherence.data.anomalies.map((a) => (
                  <li key={`${a.regle}-${a.propositionId}`} className="py-1">
                    <span className={a.gravite === "BLOQUANTE" ? "font-medium text-red-700" : "font-medium text-amber-800"}>{a.gravite === "BLOQUANTE" ? "Bloquante" : "À examiner"}</span>
                    {" · "}{LIBELLE_REGLE[a.regle] ?? a.regle}{a.detail ? ` — ${a.detail}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Registre des produits</h2>
          {peutEcrire && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setSaisieProduit(true)}>Enregistrer un produit</Button>
              <Button size="sm" variant="outline" disabled={!produits.data?.length} onClick={() => setSaisieLot(true)}>Déposer un lot de propositions</Button>
            </div>
          )}
        </div>
        {!produits.data?.length ? <p className="mt-2 text-sm text-gray-500">Aucun produit enregistré : aucune source n'a encore été choisie (voir EARTH_OBSERVATION_PLAN.md).</p> : (
          <ul className="mt-2 divide-y text-sm">
            {produits.data.map((p) => (
              <li key={p.id} className="py-1">
                <details>
                  <summary className="cursor-pointer">
                    {p.code} — {p.source} ({p.nature}, palier {p.palier}) du {new Date(p.dateAcquisition).toLocaleDateString("fr-FR")}, {p.resolutionM} m
                    {p.couvertureNuagesPct !== null ? `, ${p.couvertureNuagesPct} % de nuages` : ""} · licence : {p.licence}
                  </summary>
                  <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 pl-4 text-xs text-gray-700">
                    <dt>Provenance</dt><dd className="break-all">{p.provenance}</dd>
                    <dt>Incertitude</dt><dd>{p.incertitude}</dd>
                    <dt>Version de traitement</dt><dd>{p.versionTraitement}</dd>
                    {p.dateFin && (<><dt>Fin de période</dt><dd>{new Date(p.dateFin).toLocaleDateString("fr-FR")}</dd></>)}
                    {p.autorisationDepenseRef && (<><dt>Autorisation de dépense</dt><dd>{p.autorisationDepenseRef}</dd></>)}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
        {saisieProduit && <ProduitModal open onClose={() => setSaisieProduit(false)} onFait={() => { setSaisieProduit(false); rafraichir(); }} />}
        {saisieLot && <DepotModal open produits={produits.data ?? []} onClose={() => setSaisieLot(false)} onFait={() => { setSaisieLot(false); rafraichir(); }} />}
      </section>
    </div>
  );
}
