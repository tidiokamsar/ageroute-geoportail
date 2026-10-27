import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock3, Eye, RefreshCw, Send, XCircle } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { api } from "../lib/api";
import { parseApiError } from "../lib/errors";
import { toast } from "../lib/toast";

type DecisionDefaut = "VALIDE" | "REJETE" | "A_CORRIGER";
type DecisionObservation = "VALIDEE" | "REJETEE";
export type Historique = {
  id: string;
  statutAvant: string | null;
  statutApres: string;
  commentaire: string | null;
  source: string | null;
  decideA: string;
  decidePar?: { nomComplet: string } | null;
};
export type Defaut = {
  id: string;
  code: string | null;
  tronconId: string | null;
  statutValidation: string;
  constateA: string;
  lat: number | null;
  lon: number | null;
  abscisseM: number | null;
  pk: number | null;
  gravite: number | null;
  etendue: string | null;
  quantite: number | null;
  uniteQuantite: string | null;
  methodeQuantite: string | null;
  nombre: number | null;
  longueurM: number | null;
  largeurM: number | null;
  profondeurM: number | null;
  quantiteSaisie: number | null;
  catalogue: { code: string; libelle: string; unite: string };
  constatePar?: { id: string; nomComplet: string } | null;
  mission?: { id: string; code: string; intitule: string } | null;
  validations?: Historique[];
  medias?: { id: string; chemin: string; sha256: string; mimeType: string; tailleOctets: number; lat: number | null; lon: number | null; precisionM: number | null; capturedA: string | null }[];
};
type AppariementSuggestion = {
  tronconId: string;
  code: string;
  nom: string | null;
  distanceM: number;
  abscisseM: number;
  pk: number | null;
  confiance: number;
  ambigu: boolean;
};
type Observation = {
  id: string;
  type: string;
  statut: string;
  description: string | null;
  observeA: string;
  lat: number | null;
  lon: number | null;
  pk: number | null;
  agentId: string;
  /** Tronçon auquel un responsable a rattaché l'observation ; nul tant que personne ne l'a fait. */
  tronconId?: string | null;
  mission?: { id: string; code: string; intitule: string } | null;
  validations?: Historique[];
  /** Preuves photo jointes depuis le terrain (`POST /v2/observations/:id/photos`). */
  medias?: Defaut["medias"];
};

const UNITES: Record<string, string> = {
  UNITE: "unité(s)", METRE: "m", METRE_CARRE: "m²", METRE_CUBE: "m³",
};

function dateFr(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date inconnue" : date.toLocaleString("fr-FR");
}

export function DetailHistorique({ lignes }: { lignes?: Historique[] }) {
  if (!lignes?.length) return <p className="text-xs text-gray-500">Aucune décision précédente.</p>;
  return (
    <ol className="space-y-2">
      {lignes.map((ligne) => (
        <li key={ligne.id} className="border-l-2 border-navy/20 pl-3 text-xs">
          <p className="font-semibold text-navy">{ligne.statutAvant ?? "Création"} → {ligne.statutApres}</p>
          <p className="text-gray-500">{dateFr(ligne.decideA)} · {ligne.decidePar?.nomComplet ?? ligne.source ?? "Acteur non renseigné"}</p>
          {ligne.commentaire && <p className="mt-1 text-gray-700">{ligne.commentaire}</p>}
        </li>
      ))}
    </ol>
  );
}

export function PreuvePhoto({ media }: { media: NonNullable<Defaut["medias"]>[number] }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    api.get(`/photos/${encodeURIComponent(media.chemin)}`, { responseType: "blob" })
      .then(({ data }) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(data as Blob);
        setSource(objectUrl);
      })
      .catch(() => { if (active) setSource(null); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media.chemin]);
  return (
    <figure className="overflow-hidden rounded-md border border-gray-200">
      {source ? <a href={source} target="_blank" rel="noreferrer"><img src={source} alt={`Preuve du relevé, ${media.capturedA ? dateFr(media.capturedA) : "sans date"}`} className="h-36 w-full object-cover" /></a>
        : <div className="flex h-36 items-center justify-center bg-gray-50 text-xs text-gray-500">Photo indisponible</div>}
      <figcaption className="space-y-1 p-2 text-[11px] text-gray-500">
        <p>{media.capturedA ? dateFr(media.capturedA) : "Date de prise non renseignée"} · {(media.tailleOctets / 1024).toFixed(0)} Ko</p>
        <p>{media.lat != null && media.lon != null ? `GPS ${media.lat.toFixed(5)}, ${media.lon.toFixed(5)}${media.precisionM != null ? ` ±${media.precisionM} m` : ""}` : "GPS non enregistré"}</p>
        <p className="break-all">SHA-256 {media.sha256}</p>
      </figcaption>
    </figure>
  );
}

export function DefautsValidationPage() {
  const queryClient = useQueryClient();
  const [onglet, setOnglet] = useState<"defauts" | "observations">("defauts");
  const [selection, setSelection] = useState<{ type: "Defaut" | "Observation"; id: string } | null>(null);
  const [commentaires, setCommentaires] = useState<Record<string, string>>({});
  const [appariement, setAppariement] = useState<AppariementSuggestion | null>(null);
  const { data: defautsData, isPending: chargementDefauts, error: erreurDefauts, refetch: rechargerDefauts } = useQuery({
    queryKey: ["rai-v2", "defauts", "validation"],
    queryFn: async () => (await api.get<{ defauts: Defaut[]; curseurSuivant: string | null }>("/v2/defauts?statut=A_VALIDER&limite=100")).data,
  });
  const { data: observationsData, isPending: chargementObservations, error: erreurObservations, refetch: rechargerObservations } = useQuery({
    queryKey: ["rai-v2", "observations", "validation"],
    queryFn: async () => (await api.get<{ observations: Observation[]; curseurSuivant: string | null }>("/v2/observations?statut=PROPOSEE&limite=100")).data,
  });
  const { data: detail } = useQuery({
    queryKey: ["rai-v2", selection?.type, selection?.id],
    enabled: selection !== null,
    queryFn: async () => (await api.get<Defaut | Observation>(`/v2/${selection!.type === "Defaut" ? "defauts" : "observations"}/${selection!.id}`)).data,
  });
  const decisionDefaut = useMutation({
    mutationFn: async ({ id, decision, commentaire }: { id: string; decision: DecisionDefaut; commentaire: string }) =>
      api.post(`/v2/defauts/${id}/decision`, { decision, ...(commentaire ? { commentaire } : {}) }),
    onSuccess: async () => {
      toast.success("Décision enregistrée et historisée.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "defauts", "validation"] }),
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "Defaut"] }),
      ]);
    },
    onError: (error) => toast.error(parseApiError(error).message),
  });
  const decisionObservation = useMutation({
    mutationFn: async ({ id, decision, commentaire }: { id: string; decision: DecisionObservation; commentaire: string }) =>
      api.post(`/v2/observations/${id}/validate`, { decision, ...(commentaire ? { motif: commentaire } : {}) }),
    onSuccess: async () => {
      toast.success("Décision enregistrée et historisée.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "observations", "validation"] }),
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "Observation"] }),
      ]);
    },
    onError: (error) => toast.error(parseApiError(error).message),
  });
  const proposerAppariement = useMutation({
    mutationFn: async (id: string) => (await api.post<{ suggestion: AppariementSuggestion | null }>(`/v2/defauts/${id}/appariement/suggestion`, {})).data,
    onSuccess: (result) => {
      setAppariement(result.suggestion);
      if (!result.suggestion) toast.error("Aucun tronçon assez sûr autour de cette position. Le défaut reste sans rattachement.");
    },
    onError: (error) => toast.error(parseApiError(error).message),
  });
  const confirmerAppariement = useMutation({
    mutationFn: async ({ id, tronconId }: { id: string; tronconId: string }) =>
      api.post(`/v2/defauts/${id}/appariement/confirmation`, { tronconId }),
    onSuccess: async () => {
      setAppariement(null);
      toast.success("Tronçon et abscisse confirmés ; le défaut reste en attente de validation métier.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "Defaut"] }),
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "defauts", "validation"] }),
      ]);
    },
    onError: (error) => toast.error(parseApiError(error).message),
  });

  // Rattacher une OBSERVATION à un tronçon, sur proposition : le serveur propose, le responsable confirme (phase 6, historique par section).
  const proposerAppariementObs = useMutation({
    mutationFn: async (id: string) => (await api.post<{ suggestion: AppariementSuggestion | null }>(`/v2/observations/${id}/appariement/suggestion`, {})).data,
    onSuccess: (result) => {
      setAppariement(result.suggestion);
      if (!result.suggestion) toast.error("Aucun tronçon assez sûr autour de cette position. L'observation reste sans rattachement.");
    },
    onError: (error) => toast.error(parseApiError(error).message),
  });
  const confirmerAppariementObs = useMutation({
    mutationFn: async ({ id, tronconId }: { id: string; tronconId: string }) =>
      api.post(`/v2/observations/${id}/appariement/confirmation`, { tronconId }),
    onSuccess: async () => {
      setAppariement(null);
      toast.success("Observation rattachée au tronçon : elle entre dans l'historique de la section.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "Observation"] }),
        queryClient.invalidateQueries({ queryKey: ["rai-v2", "observations", "validation"] }),
      ]);
    },
    onError: (error) => toast.error(parseApiError(error).message),
  });

  const defauts = defautsData?.defauts ?? [];
  const observations = observationsData?.observations ?? [];
  const refreshing = decisionDefaut.isPending || decisionObservation.isPending;
  const commentaire = selection ? commentaires[selection.id] ?? "" : "";
  const detailDefaut = selection?.type === "Defaut" ? detail as Defaut | undefined : undefined;
  function choisirSelection(type: "Defaut" | "Observation", id: string) {
    setSelection({ type, id });
    setAppariement(null);
  }
  const action = (decision: DecisionDefaut) => {
    if (!selection || selection.type !== "Defaut") return;
    if (decision !== "VALIDE" && !commentaire.trim()) {
      toast.error("Indiquez le motif du rejet ou les corrections attendues.");
      return;
    }
    decisionDefaut.mutate({ id: selection.id, decision, commentaire: commentaire.trim() });
  };
  const actionObservation = (decision: DecisionObservation) => {
    if (!selection || selection.type !== "Observation") return;
    if (decision === "REJETEE" && !commentaire.trim()) {
      toast.error("Indiquez le motif du rejet.");
      return;
    }
    decisionObservation.mutate({ id: selection.id, decision, commentaire: commentaire.trim() });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Validation des relevés terrain</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">Chaque décision est réservée à un tiers habilité, enregistrée dans l’historique commun et protégée contre les décisions concurrentes.</p>
        </div>
        <Button variant="secondary" onClick={() => { void rechargerDefauts(); void rechargerObservations(); }}>
          <RefreshCw className="h-4 w-4" /> Actualiser
        </Button>
      </div>

      <div className="flex gap-2 border-b border-gray-200" role="tablist" aria-label="Type de relevé">
        <button type="button" role="tab" aria-selected={onglet === "defauts"} onClick={() => { setOnglet("defauts"); setSelection(null); }} className={`px-4 py-2 text-sm font-semibold ${onglet === "defauts" ? "border-b-2 border-navy text-navy" : "text-gray-500"}`}>
          Défauts <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs">{defauts.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={onglet === "observations"} onClick={() => { setOnglet("observations"); setSelection(null); }} className={`px-4 py-2 text-sm font-semibold ${onglet === "observations" ? "border-b-2 border-navy text-navy" : "text-gray-500"}`}>
          Observations <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs">{observations.length}</span>
        </button>
      </div>

      {onglet === "defauts" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
          <section aria-label="Défauts à valider" className="space-y-3">
            {chargementDefauts ? <Card><p className="text-sm text-gray-500">Chargement des défauts…</p></Card>
              : erreurDefauts ? <Card><p className="text-sm text-red-700">{parseApiError(erreurDefauts).message}</p></Card>
                : defauts.length === 0 ? <Card><div className="flex items-center gap-3 text-gray-600"><CheckCircle2 className="h-5 w-5 text-green-700" /><p>Aucun défaut en attente de validation.</p></div></Card>
                  : defauts.map((item) => (
                    <Card key={item.id} className={selection?.id === item.id ? "border-navy ring-1 ring-navy/20" : ""}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-navy">{item.catalogue.libelle}{item.code ? ` · ${item.code}` : ""}</p>
                          <p className="mt-1 text-xs text-gray-500">{item.constatePar?.nomComplet ?? "Agent non renseigné"} · {dateFr(item.constateA)}</p>
                        </div>
                        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800"><Clock3 className="mr-1 inline h-3.5 w-3.5" />À valider</span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-3">
                        <span>Gravité : {item.gravite ?? "non renseignée"}</span>
                        <span>Quantité : {item.quantite ?? "à mesurer"} {item.uniteQuantite ? UNITES[item.uniteQuantite] : ""}</span>
                        <span>Étendue : {item.etendue ?? "non renseignée"}</span>
                        <span>Mission : {item.mission?.code ?? "hors mission"}</span>
                        <span>Position : {item.lat != null && item.lon != null ? `${item.lat.toFixed(5)}, ${item.lon.toFixed(5)}` : item.abscisseM != null ? `${item.abscisseM} m sur le tronçon` : item.pk != null ? `PK ${item.pk}` : "non renseignée"}</span>
                        <span>Métré : {item.methodeQuantite ?? "non calculé"}</span>
                      </div>
                      <div className="mt-3 flex justify-end">
                        <Button size="sm" variant="secondary" onClick={() => choisirSelection("Defaut", item.id)}><Eye className="h-4 w-4" /> Examiner</Button>
                      </div>
                    </Card>
                  ))}
            {defautsData?.curseurSuivant && <Button variant="secondary" onClick={async () => {
              try {
                const next = (await api.get<{ defauts: Defaut[]; curseurSuivant: string | null }>(`/v2/defauts?statut=A_VALIDER&limite=100&curseur=${defautsData.curseurSuivant}`)).data;
                queryClient.setQueryData(["rai-v2", "defauts", "validation"], { defauts: [...defauts, ...next.defauts], curseurSuivant: next.curseurSuivant });
              } catch (error) { toast.error(parseApiError(error).message); }
            }}>Charger les défauts suivants</Button>}
          </section>
          <section aria-label="Détail et décision du défaut">
            {selection?.type === "Defaut" && detailDefaut ? (
              <Card className="space-y-4 xl:sticky xl:top-4">
                <div><h2 className="font-semibold text-navy">Revue du défaut</h2><p className="text-xs text-gray-500">Mesures saisies : {detailDefaut.nombre ?? "—"} unité(s), {detailDefaut.longueurM ?? "—"} m × {detailDefaut.largeurM ?? "—"} m, profondeur {detailDefaut.profondeurM ?? "—"} m.</p></div>
                {detailDefaut.lat != null && detailDefaut.lon != null && !detailDefaut.tronconId && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <h3 className="text-sm font-semibold text-blue-950">Rattachement géographique</h3>
                  <p className="mt-1 text-xs text-blue-900">La position GPS brute est conservée. Le moteur ne propose qu’un candidat assez sûr ; la confirmation reste humaine.</p>
                  {!appariement && <Button size="sm" variant="secondary" className="mt-2" disabled={proposerAppariement.isPending} onClick={() => proposerAppariement.mutate(detailDefaut.id)}><RefreshCw className="h-4 w-4" />{proposerAppariement.isPending ? "Recherche locale…" : "Proposer un tronçon"}</Button>}
                  {appariement && <div className="mt-3 rounded-md bg-white p-3 text-sm">
                    <p className="font-semibold text-navy">{appariement.code}{appariement.nom ? ` · ${appariement.nom}` : ""}</p>
                    <p className="mt-1 text-xs text-gray-600">À {appariement.distanceM} m · confiance {Math.round(appariement.confiance * 100)} %{appariement.ambigu ? " · candidat ambigu" : ""}</p>
                    <p className="text-xs text-gray-600">Abscisse locale {appariement.abscisseM} m · {appariement.pk == null ? "aucun PK calibré" : `PK ${appariement.pk}`}</p>
                    <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" disabled={confirmerAppariement.isPending} onClick={() => confirmerAppariement.mutate({ id: detailDefaut.id, tronconId: appariement.tronconId })}><CheckCircle2 className="h-4 w-4" /> Confirmer ce tronçon</Button><Button size="sm" variant="secondary" onClick={() => setAppariement(null)}>Garder le GPS brut</Button></div>
                  </div>}
                </div>}
                {!!detailDefaut.medias?.length && <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Photos de preuve</h3><div className="grid grid-cols-2 gap-2">{detailDefaut.medias.map((media) => <PreuvePhoto key={media.id} media={media} />)}</div></div>}
                <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Historique de validation</h3><DetailHistorique lignes={detailDefaut.validations} /></div>
                <label className="block text-xs font-medium text-gray-700" htmlFor="commentaire-defaut">Commentaire ou corrections attendues
                  <textarea id="commentaire-defaut" value={commentaire} onChange={(event) => setCommentaires((old) => ({ ...old, [selection.id]: event.target.value }))} rows={3} maxLength={2000} className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/20" placeholder="Obligatoire pour un rejet ou un retour en correction" />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={refreshing} onClick={() => action("VALIDE")}><CheckCircle2 className="h-4 w-4" /> Valider</Button>
                  <Button variant="secondary" disabled={refreshing || !commentaire.trim()} onClick={() => action("A_CORRIGER")}><Send className="h-4 w-4" /> Retour en correction</Button>
                  <Button variant="danger" disabled={refreshing || !commentaire.trim()} onClick={() => action("REJETE")}><XCircle className="h-4 w-4" /> Rejeter</Button>
                </div>
              </Card>
            ) : <Card><p className="text-sm text-gray-500">Sélectionnez un défaut pour examiner ses mesures et son historique.</p></Card>}
          </section>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
          <section aria-label="Observations à valider" className="space-y-3">
            {chargementObservations ? <Card><p className="text-sm text-gray-500">Chargement des observations…</p></Card>
              : erreurObservations ? <Card><p className="text-sm text-red-700">{parseApiError(erreurObservations).message}</p></Card>
                : observations.length === 0 ? <Card><div className="flex items-center gap-3 text-gray-600"><CheckCircle2 className="h-5 w-5 text-green-700" /><p>Aucune observation en attente de validation.</p></div></Card>
                  : observations.map((item) => (
                    <Card key={item.id} className={selection?.id === item.id ? "border-navy ring-1 ring-navy/20" : ""}>
                      <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-navy">{item.type}</p><p className="mt-1 text-xs text-gray-500">{dateFr(item.observeA)} · {item.mission?.code ?? "hors mission"}</p></div><span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">À valider</span></div>
                      <p className="mt-3 line-clamp-3 text-sm text-gray-700">{item.description ?? "Aucune description"}</p>
                      <div className="mt-3 flex items-center justify-between gap-3"><span className="text-xs text-gray-500">{item.lat != null && item.lon != null ? `${item.lat.toFixed(5)}, ${item.lon.toFixed(5)}` : item.pk != null ? `PK ${item.pk}` : "Position non renseignée"}</span><Button size="sm" variant="secondary" onClick={() => choisirSelection("Observation", item.id)}><Eye className="h-4 w-4" /> Examiner</Button></div>
                    </Card>
                  ))}
            {observationsData?.curseurSuivant && <Button variant="secondary" onClick={async () => {
              try {
                const next = (await api.get<{ observations: Observation[]; curseurSuivant: string | null }>(`/v2/observations?statut=PROPOSEE&limite=100&curseur=${observationsData.curseurSuivant}`)).data;
                queryClient.setQueryData(["rai-v2", "observations", "validation"], { observations: [...observations, ...next.observations], curseurSuivant: next.curseurSuivant });
              } catch (error) { toast.error(parseApiError(error).message); }
            }}>Charger les observations suivantes</Button>}
          </section>
          <section aria-label="Détail et décision de l'observation">
            {selection?.type === "Observation" && detail ? (
              <Card className="space-y-4 xl:sticky xl:top-4">
                <div><h2 className="font-semibold text-navy">Revue de l’observation</h2><p className="mt-2 text-sm text-gray-700">{(detail as Observation).description ?? "Aucune description"}</p></div>
                {!!(detail as Observation).medias?.length && <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Photos de preuve</h3><div className="grid grid-cols-2 gap-2">{(detail as Observation).medias!.map((media) => <PreuvePhoto key={media.id} media={media} />)}</div></div>}
                <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Historique de validation</h3><DetailHistorique lignes={(detail as Observation).validations} /></div>
                <section aria-label="Rattachement à un tronçon" className="rounded-md bg-gray-50 p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Rattachement à un tronçon</h3>
                  <p className="mt-1 text-sm">{(detail as Observation).tronconId ? "Rattachée à un tronçon : elle entre dans l'historique de sa section." : "Aucun tronçon : l'observation n'entre dans l'historique d'aucune section."}</p>
                  {(detail as Observation).lat == null || (detail as Observation).lon == null
                    ? <p className="mt-1 text-xs text-gray-600">Pas de position GPS : rien à proposer.</p>
                    : !appariement && <Button size="sm" variant="secondary" className="mt-2" disabled={proposerAppariementObs.isPending} onClick={() => proposerAppariementObs.mutate(selection!.id)}><RefreshCw className="h-4 w-4" />{proposerAppariementObs.isPending ? "Recherche locale…" : "Proposer un tronçon"}</Button>}
                  {appariement && <div className="mt-3 rounded-md bg-white p-3 text-sm">
                    <p className="font-semibold text-navy">{appariement.code}{appariement.nom ? ` · ${appariement.nom}` : ""}</p>
                    <p className="mt-1 text-xs text-gray-600">À {appariement.distanceM} m · confiance {Math.round(appariement.confiance * 100)} %{appariement.ambigu ? " · candidat ambigu : vérifier avant de confirmer" : ""}</p>
                    <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" disabled={confirmerAppariementObs.isPending} onClick={() => confirmerAppariementObs.mutate({ id: selection!.id, tronconId: appariement.tronconId })}><CheckCircle2 className="h-4 w-4" /> Confirmer ce tronçon</Button><Button size="sm" variant="secondary" onClick={() => setAppariement(null)}>Ne pas rattacher</Button></div>
                  </div>}
                </section>
                <label className="block text-xs font-medium text-gray-700" htmlFor="commentaire-observation">Motif du rejet (obligatoire pour rejeter)
                  <textarea id="commentaire-observation" value={commentaire} onChange={(event) => setCommentaires((old) => ({ ...old, [selection.id]: event.target.value }))} rows={3} maxLength={2000} className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/20" />
                </label>
                <div className="flex flex-wrap gap-2"><Button disabled={refreshing} onClick={() => actionObservation("VALIDEE")}><CheckCircle2 className="h-4 w-4" /> Valider</Button><Button variant="danger" disabled={refreshing || !commentaire.trim()} onClick={() => actionObservation("REJETEE")}><XCircle className="h-4 w-4" /> Rejeter</Button></div>
              </Card>
            ) : <Card><p className="text-sm text-gray-500">Sélectionnez une observation pour examiner son historique et la décider.</p></Card>}
          </section>
        </div>
      )}
    </div>
  );
}
