import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Download, Play, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { downloadViaApi } from "../lib/download";
import { messageErreur } from "../lib/exploitation";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";

/**
 * Audit du référentiel des tronçons (BDRI, lot C) : registre persistant des anomalies, sur
 * `/api/v2/referentiel/troncons`.
 *
 * Une anomalie est un CONSTAT, pas une erreur prouvée. L'écran ne corrige rien de lui-même : une correction
 * est PROPOSÉE avec sa valeur, sa justification et sa source, VALIDÉE par une autre personne, PRÉVISUALISÉE,
 * puis appliquée. Le serveur vérifie que la valeur n'a pas bougé entre-temps et garde l'ancienne valeur ;
 * une correction appliquée s'annule. Le catalogue des règles et les transitions viennent du serveur : l'écran
 * n'en tient pas de copie.
 */

const BASE = "/v2/referentiel/troncons";
type Statut = "A_EXAMINER" | "CORRECTION_PROPOSEE" | "VALIDEE" | "REJETEE" | "CORRIGEE";
export const LIBELLE_STATUT: Record<Statut, string> = {
  A_EXAMINER: "À examiner", CORRECTION_PROPOSEE: "Correction proposée", VALIDEE: "Validée", REJETEE: "Rejetée", CORRIGEE: "Corrigée",
};
const COULEUR_STATUT: Record<Statut, string> = {
  A_EXAMINER: "border-amber-300 bg-amber-50 text-amber-900", CORRECTION_PROPOSEE: "border-sky-300 bg-sky-50 text-sky-900",
  VALIDEE: "border-indigo-300 bg-indigo-50 text-indigo-900", REJETEE: "border-gray-300 bg-gray-50 text-gray-700",
  CORRIGEE: "border-green-300 bg-green-50 text-green-900",
};
const LIBELLE_CHAMP: Record<string, string> = { pkDebut: "PK début", pkFin: "PK fin", longueurKm: "Longueur déclarée (km)", classe: "Classe", revetement: "Revêtement" };
const CLASSES = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"];
const REVETEMENTS = ["BITUME", "TERRE", "LATERITE", "PAVE", "NON_RENSEIGNE"];

interface Regle { code: string; libelle: string; gravite: string; regle: string; champs: string[] }
interface Catalogue { regles: Regle[]; statuts: Statut[]; transitions: Record<Statut, Statut[]> }
interface Correction { champ: string; ancienne: unknown; nouvelle: unknown; justification: string; source: string; proposeeParId: string }
interface Anomalie {
  id: string; tronconId: string; regle: string; gravite: string; statut: Statut; valeurs: Record<string, unknown>; source: string;
  correction: Correction | null; detecteeLe: string; derniereDetectionLe: string; disparueLe: string | null;
  troncon: { id: string; code: string; nom: string; region: { nom: string } | null; deletedAt: string | null };
}
interface Decision { id: string; statutAvant: Statut | null; statutApres: Statut; commentaire: string | null; correction: Correction | null; decideLe: string; auteur: { nomComplet: string } }
interface Region { id: number; nom: string }
interface LignePrev { anomalieId: string; code: string; champ: string | null; constatee: unknown; actuelle: unknown; nouvelle: unknown; applicable: boolean; motif: string | null }

const dateFr = (v: string | null) => (v ? new Date(v).toLocaleString("fr-FR") : "—");
const valeur = (v: unknown) => (v === null || v === undefined || v === "" ? "non renseigné" : String(v));

function useCatalogue() {
  return useQuery({ queryKey: ["referentiel", "regles"], queryFn: async () => (await api.get<Catalogue>(`${BASE}/regles`)).data, staleTime: 60 * 60_000 });
}

function AnalyseModal({ onClose, regions, estAdmin }: { onClose: () => void; regions: Region[]; estAdmin: boolean }) {
  const qc = useQueryClient();
  const [regionId, setRegionId] = useState("");
  const [ecartLongueurPct, setEcartLongueur] = useState("10");
  const [ecartPkPct, setEcartPk] = useState("10");
  const national = regionId === "NATIONAL";
  const nombres = [Number(ecartLongueurPct), Number(ecartPkPct)];
  const valide = regionId !== "" && nombres.every((x) => Number.isFinite(x) && x >= 1 && x <= 500);
  const lancer = useMutation({
    mutationFn: async () => (await api.post(`${BASE}/analyse`, {
      ...(national ? { national: true } : { regionId: Number(regionId) }), ecartLongueurPct: nombres[0], ecartPkPct: nombres[1],
    })).data as { nouvelles: number; confirmees: number; disparues: number; tronconsExamines: number; tronque: boolean },
    onSuccess: (b) => {
      toast.success(`${b.tronconsExamines} tronçon(s) examiné(s) : ${b.nouvelles} nouvelle(s), ${b.confirmees} confirmée(s), ${b.disparues} disparue(s)${b.tronque ? " — analyse tronquée" : ""}`);
      qc.invalidateQueries({ queryKey: ["referentiel"] });
      onClose();
    },
    onError: (e) => toast.error(messageErreur(e, "Analyse refusée")),
  });
  return (
    <Modal open onClose={onClose} title="Lancer une analyse du référentiel">
      <form className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (valide) lancer.mutate(); }}>
        <label className="block">Portée
          <select className="mt-1 w-full rounded border px-2 py-1" value={regionId} onChange={(e) => setRegionId(e.target.value)}>
            <option value="">Choisir une région…</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
            {estAdmin && <option value="NATIONAL">Tout le réseau classé (administrateur)</option>}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">Écart longueur déclarée / tracé toléré (%)
            <input className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={ecartLongueurPct} onChange={(e) => setEcartLongueur(e.target.value)} />
          </label>
          <label className="block">Écart étendue des PK / longueur toléré (%)
            <input className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={ecartPkPct} onChange={(e) => setEcartPk(e.target.value)} />
          </label>
        </div>
        <p className="text-xs text-gray-600">Les seuils sont des paramètres de l'analyse, pas une norme AGEROUTE : ils sont enregistrés avec chaque constat. L'analyse ne modifie aucun tronçon ; relancée sur des données inchangées, elle ne crée rien.</p>
        <div className="flex justify-end"><Button type="submit" size="sm" disabled={!valide || lancer.isPending}><Play className="mr-1 h-4 w-4" aria-hidden="true" />Analyser</Button></div>
      </form>
    </Modal>
  );
}

function ChampValeur({ champ, value, onChange }: { champ: string; value: string; onChange: (v: string) => void }) {
  const options = champ === "classe" ? CLASSES : champ === "revetement" ? REVETEMENTS : null;
  return options ? (
    <select aria-label="Nouvelle valeur" className="mt-1 w-full rounded border px-2 py-1" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choisir…</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ) : (
    <input aria-label="Nouvelle valeur" className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
  );
}

export function FicheAnomalie({ id, onClose, catalogue }: { id: string; onClose: () => void; catalogue: Catalogue | undefined }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const peutDecider = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const [statut, setStatut] = useState<Statut | "">("");
  const [commentaire, setCommentaire] = useState("");
  const [champ, setChamp] = useState("");
  const [nouvelle, setNouvelle] = useState("");
  const [justification, setJustification] = useState("");
  const [source, setSource] = useState("");
  const [motifAnnulation, setMotifAnnulation] = useState("");
  const fiche = useQuery({
    queryKey: ["referentiel", "anomalie", id],
    queryFn: async () => (await api.get<Anomalie & { decisions: Decision[]; definition: Regle | null }>(`${BASE}/anomalies/${id}`)).data,
  });
  const rafraichir = () => qc.invalidateQueries({ queryKey: ["referentiel"] });
  const decider = useMutation({
    mutationFn: async () => (await api.post(`${BASE}/anomalies/${id}/decision`, {
      statut, commentaire: commentaire.trim() || null,
      correction: statut === "CORRECTION_PROPOSEE" ? { champ, nouvelle: champ === "classe" || champ === "revetement" ? nouvelle : nouvelle.replace(",", "."), justification, source } : null,
    })).data,
    onSuccess: () => { toast.success("Décision enregistrée"); setStatut(""); setCommentaire(""); rafraichir(); },
    onError: (e) => toast.error(messageErreur(e, "Décision refusée")),
  });
  const appliquer = useMutation({
    mutationFn: async () => (await api.post(`${BASE}/anomalies/application`, { ids: [id] })).data,
    onSuccess: () => { toast.success("Correction appliquée au tronçon"); rafraichir(); },
    onError: (e) => toast.error(messageErreur(e, "Application refusée")),
  });
  const annuler = useMutation({
    mutationFn: async () => (await api.post(`${BASE}/anomalies/${id}/annulation`, { motif: motifAnnulation })).data,
    onSuccess: () => { toast.success("Correction annulée : l'ancienne valeur est rendue"); setMotifAnnulation(""); rafraichir(); },
    onError: (e) => toast.error(messageErreur(e, "Annulation refusée")),
  });

  const a = fiche.data;
  const definition = a?.definition ?? catalogue?.regles.find((r) => r.code === a?.regle) ?? null;
  const possibles = a && catalogue ? catalogue.transitions[a.statut] ?? [] : [];
  const proposer = statut === "CORRECTION_PROPOSEE";
  const motifExige = statut === "REJETEE" || (a?.statut === "REJETEE" && statut === "A_EXAMINER");
  const decisionValide = statut !== "" && (!motifExige || commentaire.trim().length >= 5)
    && (!proposer || (champ !== "" && nouvelle.trim() !== "" && justification.trim().length >= 5 && source.trim().length >= 3));
  const autoValidation = a?.statut === "CORRECTION_PROPOSEE" && statut === "VALIDEE" && a.correction?.proposeeParId === user?.id;

  return (
    <Modal open onClose={onClose} title={a ? `${definition?.libelle ?? a.regle} — ${a.troncon.code}` : "Anomalie"} sale={() => statut !== "" || motifAnnulation !== ""}>
      {fiche.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : fiche.isError || !a ? <p className="text-sm text-red-700">{messageErreur(fiche.error, "Anomalie introuvable.")}</p>
        : (
          <div className="space-y-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${COULEUR_STATUT[a.statut]}`}>{LIBELLE_STATUT[a.statut]}</span>
              <span className="text-xs text-gray-700">Gravité {a.gravite.toLowerCase()} · {a.troncon.nom}{a.troncon.region ? ` · ${a.troncon.region.nom}` : ""}{a.troncon.deletedAt ? " · tronçon archivé" : ""}</span>
            </p>
            {definition && <p className="text-xs text-gray-700">{definition.regle}</p>}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-gray-200 p-2 text-xs">
              {Object.entries(a.valeurs).map(([k, v]) => (<Fragment key={k}><dt className="text-gray-600">{k}</dt><dd className="break-all">{typeof v === "object" ? JSON.stringify(v) : valeur(v)}</dd></Fragment>))}
              <dt className="text-gray-600">Règle</dt><dd>{a.source}</dd>
              <dt className="text-gray-600">Constatée</dt><dd>{dateFr(a.detecteeLe)} (dernière fois {dateFr(a.derniereDetectionLe)})</dd>
              {a.disparueLe && <><dt className="text-gray-600">Ne se constate plus</dt><dd>depuis le {dateFr(a.disparueLe)}</dd></>}
            </dl>
            {a.correction && (
              <section className="rounded border border-sky-200 bg-sky-50 p-2 text-xs">
                <h3 className="font-medium">Correction {a.statut === "CORRIGEE" ? "appliquée" : "proposée"}</h3>
                <p>{LIBELLE_CHAMP[a.correction.champ] ?? a.correction.champ} : {valeur(a.correction.ancienne)} → <strong>{valeur(a.correction.nouvelle)}</strong></p>
                <p>Justification : {a.correction.justification} · Source : {a.correction.source}</p>
              </section>
            )}

            {peutDecider && a.statut === "VALIDEE" && a.correction && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={appliquer.isPending} onClick={() => appliquer.mutate()}>Appliquer la correction au tronçon</Button>
                <span className="text-xs text-gray-600">Refusée si la valeur a changé depuis la proposition.</span>
              </div>
            )}
            {peutDecider && a.statut === "CORRIGEE" && (
              <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); if (motifAnnulation.trim().length >= 5) annuler.mutate(); }}>
                <label className="block text-xs">Annuler la correction (rend l'ancienne valeur) — motif
                  <input className="mt-1 w-full rounded border px-2 py-1" value={motifAnnulation} maxLength={2000} onChange={(e) => setMotifAnnulation(e.target.value)} />
                </label>
                <div className="flex justify-end"><Button type="submit" size="sm" variant="danger" disabled={motifAnnulation.trim().length < 5 || annuler.isPending}>Annuler la correction</Button></div>
              </form>
            )}

            {peutDecider && possibles.length > 0 && (
              <form className="space-y-2 rounded border border-gray-200 p-2" onSubmit={(e) => { e.preventDefault(); if (decisionValide && !autoValidation) decider.mutate(); }}>
                <label className="block">Décision
                  <select className="mt-1 w-full rounded border px-2 py-1" value={statut} onChange={(e) => setStatut(e.target.value as Statut)}>
                    <option value="">Choisir…</option>
                    {possibles.map((s) => <option key={s} value={s}>{LIBELLE_STATUT[s]}</option>)}
                  </select>
                </label>
                {proposer && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="block">Champ
                      <select className="mt-1 w-full rounded border px-2 py-1" value={champ} onChange={(e) => { setChamp(e.target.value); setNouvelle(""); }}>
                        <option value="">Choisir…</option>
                        {(definition?.champs ?? []).map((c) => <option key={c} value={c}>{LIBELLE_CHAMP[c] ?? c}</option>)}
                      </select>
                    </label>
                    <div>{champ && <><span className="block" aria-hidden="true">Nouvelle valeur</span><ChampValeur champ={champ} value={nouvelle} onChange={setNouvelle} /></>}</div>
                    <label className="block">Justification<input className="mt-1 w-full rounded border px-2 py-1" value={justification} maxLength={2000} onChange={(e) => setJustification(e.target.value)} /></label>
                    <label className="block">Source de la valeur<input className="mt-1 w-full rounded border px-2 py-1" value={source} maxLength={500} placeholder="PV, relevé, référence…" onChange={(e) => setSource(e.target.value)} /></label>
                    {(definition?.champs.length ?? 0) === 0 && <p className="text-xs text-amber-800">Cette anomalie s'examine ; elle ne se corrige pas depuis le registre.</p>}
                  </div>
                )}
                <label className="block">Commentaire{motifExige ? " (motif exigé)" : ""}
                  <textarea className="mt-1 w-full rounded border px-2 py-1" rows={2} maxLength={2000} value={commentaire} onChange={(e) => setCommentaire(e.target.value)} />
                </label>
                {autoValidation && <p className="text-xs text-red-700">Vous avez proposé cette correction : une autre personne doit la valider.</p>}
                <div className="flex justify-end"><Button type="submit" size="sm" disabled={!decisionValide || autoValidation || decider.isPending}>Enregistrer la décision</Button></div>
              </form>
            )}

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Historique des décisions</h3>
              <ol className="space-y-1 text-xs">
                {a.decisions.map((d) => (
                  <li key={d.id} className="border-l-2 border-navy/20 pl-2">
                    <span className="font-medium">{d.statutAvant ? LIBELLE_STATUT[d.statutAvant] : "Constat"} → {LIBELLE_STATUT[d.statutApres]}</span>
                    <span className="text-gray-600"> · {dateFr(d.decideLe)} · {d.auteur.nomComplet}</span>
                    {d.commentaire && <p className="text-gray-700">{d.commentaire}</p>}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
    </Modal>
  );
}

function ApplicationGroupeeModal({ ids, onClose, onFait }: { ids: string[]; onClose: () => void; onFait: () => void }) {
  const prev = useQuery({
    queryKey: ["referentiel", "previsualisation", ids],
    queryFn: async () => (await api.post<{ lignes: LignePrev[] }>(`${BASE}/anomalies/previsualisation`, { ids })).data.lignes,
  });
  const appliquer = useMutation({
    mutationFn: async () => (await api.post(`${BASE}/anomalies/application`, { ids })).data as { appliquees: number },
    onSuccess: (r) => { toast.success(`${r.appliquees} correction(s) appliquée(s)`); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Application refusée : rien n'a été écrit")),
  });
  const lignes = prev.data ?? [];
  const toutes = lignes.length > 0 && lignes.every((l) => l.applicable);
  return (
    <Modal open onClose={onClose} title={`Prévisualiser ${ids.length} correction(s)`}>
      {prev.isLoading ? <p className="text-sm text-gray-500">Calcul…</p> : (
        <div className="space-y-2 text-sm">
          <table className="w-full text-xs">
            <caption className="sr-only">Corrections à appliquer</caption>
            <thead><tr className="text-left text-gray-600"><th>Tronçon</th><th>Champ</th><th>Constatée</th><th>Actuelle</th><th>Nouvelle</th><th>État</th></tr></thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={l.anomalieId} className="border-t">
                  <td>{l.code}</td><td>{l.champ ? LIBELLE_CHAMP[l.champ] ?? l.champ : "—"}</td><td>{valeur(l.constatee)}</td><td>{valeur(l.actuelle)}</td><td><strong>{valeur(l.nouvelle)}</strong></td>
                  <td className={l.applicable ? "text-green-800" : "text-red-700"}>{l.applicable ? "applicable" : l.motif}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-600">Tout ou rien : si une seule ligne n'est plus applicable, aucune n'est écrite. Chaque tronçon garde l'ancienne valeur dans son journal d'audit.</p>
          <div className="flex justify-end"><Button size="sm" disabled={!toutes || appliquer.isPending} onClick={() => appliquer.mutate()}>Appliquer {ids.length} correction(s)</Button></div>
        </div>
      )}
    </Modal>
  );
}

export function AuditReferentielPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const peutDecider = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const [params, setParams] = useSearchParams();
  const filtre = (k: string) => params.get(k) ?? "";
  const changer = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); n.delete("page"); return n; }, { replace: true });
  const page = Number(params.get("page") ?? "1") || 1;
  const [analyse, setAnalyse] = useState(false);
  const [fiche, setFiche] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [groupe, setGroupe] = useState<string[] | null>(null);
  const catalogue = useCatalogue();
  const regions = useQuery({ queryKey: ["regions"], queryFn: async () => (await api.get<Region[]>("/regions")).data });

  const requete = useMemo(() => {
    const q: Record<string, string> = {};
    for (const k of ["statut", "regle", "gravite", "regionId"]) if (filtre(k)) q[k] = filtre(k);
    if (filtre("disparues") === "1") q.inclureDisparues = "true";
    return q;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const liste = useQuery({
    queryKey: ["referentiel", "anomalies", requete, page],
    queryFn: async () => (await api.get<{ data: Anomalie[]; total: number; totalPages: number; parStatut: Record<string, number> }>(`${BASE}/anomalies`, { params: { ...requete, page, pageSize: 50 } })).data,
  });
  const libelle = (code: string) => catalogue.data?.regles.find((r) => r.code === code)?.libelle ?? code;
  const lignes = liste.data?.data ?? [];
  const applicables = lignes.filter((a) => a.statut === "VALIDEE" && a.correction);
  const basculer = (id: string) => setSelection((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-gray-700"><ShieldCheck className="h-4 w-4" aria-hidden="true" />Une anomalie est un constat à examiner, pas une erreur prouvée. Rien n'est corrigé sans décision tracée.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void downloadViaApi(`${BASE}/anomalies.csv?${new URLSearchParams(requete).toString()}`, "anomalies-referentiel-troncons.csv").catch(() => toast.error("Export impossible"))}>
            <Download className="mr-1 h-4 w-4" aria-hidden="true" />Exporter (CSV)
          </Button>
          {peutDecider && <Button size="sm" onClick={() => setAnalyse(true)}><Play className="mr-1 h-4 w-4" aria-hidden="true" />Lancer une analyse</Button>}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
        <label>Statut
          <select className="ml-2 rounded border px-2 py-1" value={filtre("statut")} onChange={(e) => changer("statut", e.target.value)}>
            <option value="">Tous</option>
            {(Object.keys(LIBELLE_STATUT) as Statut[]).map((s) => <option key={s} value={s}>{LIBELLE_STATUT[s]}{liste.data?.parStatut[s] !== undefined ? ` (${liste.data.parStatut[s]})` : ""}</option>)}
          </select>
        </label>
        <label>Règle
          <select className="ml-2 rounded border px-2 py-1" value={filtre("regle")} onChange={(e) => changer("regle", e.target.value)}>
            <option value="">Toutes</option>
            {(catalogue.data?.regles ?? []).map((r) => <option key={r.code} value={r.code}>{r.libelle}</option>)}
          </select>
        </label>
        <label>Gravité
          <select className="ml-2 rounded border px-2 py-1" value={filtre("gravite")} onChange={(e) => changer("gravite", e.target.value)}>
            <option value="">Toutes</option>
            {["BLOQUANTE", "MAJEURE", "MINEURE", "INFO"].map((g) => <option key={g} value={g}>{g.toLowerCase()}</option>)}
          </select>
        </label>
        <label>Région
          <select className="ml-2 rounded border px-2 py-1" value={filtre("regionId")} onChange={(e) => changer("regionId", e.target.value)}>
            <option value="">Toutes</option>
            {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={filtre("disparues") === "1"} onChange={(e) => changer("disparues", e.target.checked ? "1" : "")} />Inclure celles qui ne se constatent plus</label>
        <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Réinitialiser les filtres</Button>
      </div>

      {peutDecider && selection.size > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <span>{selection.size} correction(s) validée(s) sélectionnée(s)</span>
          <Button size="sm" onClick={() => setGroupe([...selection])}>Prévisualiser et appliquer</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>Vider la sélection</Button>
        </div>
      )}

      {liste.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : liste.isError ? <p className="text-sm text-red-700">{messageErreur(liste.error, "Registre indisponible.")}</p>
        : lignes.length === 0 ? <p className="text-sm text-gray-600">Aucune anomalie pour ces filtres{peutDecider ? ". Lancez une analyse pour alimenter le registre." : "."}</p>
        : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <caption className="sr-only">Anomalies du référentiel</caption>
              <thead>
                <tr className="text-left text-gray-600">
                  <th className="p-2">{peutDecider && applicables.length > 0 && <span className="sr-only">Sélection</span>}</th>
                  <th>Tronçon</th><th>Anomalie</th><th>Gravité</th><th>Statut</th><th>Constatée</th><th><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((a) => (
                  <tr key={a.id} className={`border-t ${a.disparueLe ? "text-gray-500" : ""}`}>
                    <td className="p-2">
                      {peutDecider && a.statut === "VALIDEE" && a.correction && (
                        <input type="checkbox" aria-label={`Sélectionner la correction de ${a.troncon.code}`} checked={selection.has(a.id)} onChange={() => basculer(a.id)} />
                      )}
                    </td>
                    <td><span className="font-medium">{a.troncon.code}</span><span className="block text-xs text-gray-600">{a.troncon.region?.nom ?? "région non renseignée"}</span></td>
                    <td>{libelle(a.regle)}{a.disparueLe ? <span className="block text-xs">ne se constate plus</span> : null}</td>
                    <td>{a.gravite.toLowerCase()}</td>
                    <td><span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${COULEUR_STATUT[a.statut]}`}>{LIBELLE_STATUT[a.statut]}</span></td>
                    <td className="whitespace-nowrap">{new Date(a.detecteeLe).toLocaleDateString("fr-FR")}</td>
                    <td><Button size="sm" variant="outline" onClick={() => setFiche(a.id)}>Examiner</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {(liste.data?.totalPages ?? 1) > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set("page", String(page - 1)); return n; })}>Précédente</Button>
          <span>Page {page} / {liste.data?.totalPages}</span>
          <Button size="sm" variant="outline" disabled={page >= (liste.data?.totalPages ?? 1)} onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set("page", String(page + 1)); return n; })}>Suivante</Button>
        </div>
      )}

      {analyse && <AnalyseModal onClose={() => setAnalyse(false)} regions={regions.data ?? []} estAdmin={user?.role === "ADMIN"} />}
      {fiche && <FicheAnomalie id={fiche} catalogue={catalogue.data} onClose={() => setFiche(null)} />}
      {groupe && <ApplicationGroupeeModal ids={groupe} onClose={() => setGroupe(null)} onFait={() => { setGroupe(null); setSelection(new Set()); qc.invalidateQueries({ queryKey: ["referentiel"] }); }} />}
    </div>
  );
}
