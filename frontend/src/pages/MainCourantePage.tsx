import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ClipboardList, Plus, BarChart3 } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { TronconPicker } from "../components/TronconPicker";
import { messageErreur } from "../lib/exploitation";
import {
  cleOperation, duree, GESTE_VERS, LIBELLE_NATURE, LIBELLE_STATUT, STATUTS, transitionsDepuis,
  type NatureEntree, type StatutEvenement,
} from "../lib/mainCourante";

/**
 * Main courante du réseau (paragraphe 7.17, EX-01) : déclarer un événement, le suivre, le clore.
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **La main courante est en ajout seul.** Rien ne s'efface ni ne se modifie : une erreur se corrige
 * par une entrée « Rectification » qui cite l'entrée fausse. L'écran ne propose donc ni « modifier »
 * ni « supprimer » — et le serveur les refuserait.
 *
 * **L'heure qui compte est celle du serveur.** Chaque entrée porte son auteur et l'heure de son
 * enregistrement ; l'heure saisie sur le terrain, quand il y en a une, est conservée à côté.
 *
 * **Seuls les gestes permis sont proposés** : rien ne recule, un événement clos ne se rouvre pas
 * (on en déclare un nouveau).
 */

interface Referentiel { code: string; libelle: string }
interface LigneEvenement {
  evenementId: string; typeCode: string; sourceCode: string; texte: string; tronconId: string | null;
  statut: StatutEvenement; ouvertLe: string; statutDepuis: string; nbEntrees: number; nbRectifications: number;
}
interface Entree {
  id: string; nature: NatureEntree; statut: StatutEvenement | null; texte: string; enregistreLe: string;
  horodatageClient: string | null; rectifieId: string | null; auteur: { nomComplet: string };
  typeRef: { libelle: string } | null; sourceRef: { libelle: string } | null;
}
interface Evenement { evenementId: string; statutCourant: StatutEvenement; entrees: Entree[] }
interface Distribution { n: number; medianeS: number | null; p90S: number | null; maxS: number | null }
interface Statistiques {
  nbEvenements: number; parStatut: Record<StatutEvenement, number>;
  priseEnCompte: Distribution & { jamaisPrisEnCompte: number };
  dureeCoupures: Distribution & { coupuresNonCloses: number };
  parType: { typeCode: string; n: number; priseEnCompte: Distribution }[];
  troncons: { tronconId: string; code: string | null; nom: string | null; n: number; coupures: number }[];
  horsTroncon: number;
}

const COULEUR_STATUT: Record<StatutEvenement, string> = {
  OUVERT: "bg-red-50 text-red-800 border-red-200",
  PRIS_EN_COMPTE: "bg-amber-50 text-amber-900 border-amber-200",
  EN_COURS: "bg-sky-50 text-sky-900 border-sky-200",
  CLOS: "bg-gray-100 text-gray-700 border-gray-200",
};
const dateHeure = (s: string) => new Date(s).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

function useReferentiels() {
  return useQuery({
    queryKey: ["exploitation", "referentiels"],
    queryFn: async () => (await api.get<{ types: Referentiel[]; sources: Referentiel[] }>("/v2/exploitation/referentiels")).data,
  });
}

// ---------------------------------------------------------------------------------------------

function DeclarationModal({ open, onClose, onFait }: { open: boolean; onClose: () => void; onFait: (id: string) => void }) {
  const ref = useReferentiels();
  const [typeCode, setTypeCode] = useState("");
  const [sourceCode, setSourceCode] = useState("");
  const [texte, setTexte] = useState("");
  const [tronconId, setTronconId] = useState<string | undefined>();
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [cle] = useState(cleOperation);
  const point = lat.trim() && lon.trim() ? [Number(lon), Number(lat)] as [number, number] : null;
  const pointInvalide = (lat.trim() !== "" || lon.trim() !== "") && !(point && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
  const complet = typeCode && sourceCode && texte.trim() && !pointInvalide;

  const declarer = useMutation({
    mutationFn: async () => (await api.post<{ evenementId: string }>("/v2/exploitation/main-courante", {
      typeCode, sourceCode, texte: texte.trim(), tronconId: tronconId ?? null, point, clientOperationId: cle,
    })).data,
    onSuccess: (r) => { toast.success("Événement déclaré"); onFait(r.evenementId); },
    onError: (e) => toast.error(messageErreur(e, "Déclaration refusée")),
  });

  return (
    <Modal open={open} onClose={onClose} title="Déclarer un événement" sale={() => texte.trim() !== "" && !declarer.isSuccess}>
      <form className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (complet) declarer.mutate(); }}>
        <label className="block">Type d'événement
          <select className="mt-1 w-full rounded border px-2 py-1.5" value={typeCode} onChange={(e) => setTypeCode(e.target.value)}>
            <option value="">—</option>
            {(ref.data?.types ?? []).map((t) => <option key={t.code} value={t.code}>{t.libelle}</option>)}
          </select>
        </label>
        <label className="block">Source de l'information
          <select className="mt-1 w-full rounded border px-2 py-1.5" value={sourceCode} onChange={(e) => setSourceCode(e.target.value)}>
            <option value="">—</option>
            {(ref.data?.sources ?? []).map((s) => <option key={s.code} value={s.code}>{s.libelle}</option>)}
          </select>
        </label>
        <label className="block">Ce qui est constaté
          <textarea className="mt-1 w-full rounded border px-2 py-1.5" rows={3} maxLength={4000} value={texte} onChange={(e) => setTexte(e.target.value)} />
        </label>
        <div>
          <label htmlFor="mc-troncon">Tronçon concerné (facultatif)</label>
          <TronconPicker id="mc-troncon" value={tronconId} onChange={setTronconId} />
        </div>
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="col-span-2">Position (facultatif)</legend>
          <label>Latitude<input className="mt-1 w-full rounded border px-2 py-1.5" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} /></label>
          <label>Longitude<input className="mt-1 w-full rounded border px-2 py-1.5" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} /></label>
          {pointInvalide && <p className="col-span-2 text-xs text-red-700">Position incomplète ou hors bornes (latitude −90 à 90, longitude −180 à 180).</p>}
        </fieldset>
        <p className="text-xs text-gray-600">L'événement est enregistré à l'heure du serveur, avec votre nom. Il ne se modifie plus : une erreur se corrige par une rectification.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={!complet || declarer.isPending}>Déclarer</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

function DetailModal({ evenementId, onClose }: { evenementId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [nature, setNature] = useState<"STATUT" | "COMPLEMENT" | "RECTIFICATION" | "">("");
  const [statut, setStatut] = useState<StatutEvenement | "">("");
  const [rectifieId, setRectifieId] = useState("");
  const [texte, setTexte] = useState("");
  const [cle, setCle] = useState(cleOperation);

  const ev = useQuery({
    queryKey: ["exploitation", "main-courante", evenementId],
    enabled: !!evenementId,
    queryFn: async () => (await api.get<Evenement>(`/v2/exploitation/main-courante/${evenementId}`)).data,
  });
  const possibles = transitionsDepuis(ev.data?.statutCourant);
  const complet = nature !== "" && texte.trim() !== ""
    && (nature !== "STATUT" || statut !== "") && (nature !== "RECTIFICATION" || rectifieId !== "");

  const ajouter = useMutation({
    mutationFn: async () => (await api.post(`/v2/exploitation/main-courante/${evenementId}/entrees`, {
      nature, texte: texte.trim(), statut: nature === "STATUT" ? statut : null,
      rectifieId: nature === "RECTIFICATION" ? rectifieId : null, clientOperationId: cle,
    })).data,
    onSuccess: () => {
      toast.success("Entrée ajoutée à la main courante");
      setNature(""); setStatut(""); setRectifieId(""); setTexte(""); setCle(cleOperation());
      qc.invalidateQueries({ queryKey: ["exploitation"] });
    },
    onError: (e) => toast.error(messageErreur(e, "Entrée refusée")),
  });

  const choisirGeste = (s: StatutEvenement) => { setNature("STATUT"); setStatut(s); };

  return (
    <Modal open={!!evenementId} onClose={onClose} title="Journal de l'événement" sale={() => texte.trim() !== ""}>
      {ev.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : ev.isError || !ev.data ? <p className="text-sm text-red-700">Événement introuvable.</p>
        : (
          <div className="space-y-3 text-sm">
            <p>Statut courant : <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${COULEUR_STATUT[ev.data.statutCourant]}`}>{LIBELLE_STATUT[ev.data.statutCourant]}</span></p>
            <ol className="space-y-2 border-l-2 border-gray-200 pl-3">
              {ev.data.entrees.map((e) => (
                <li key={e.id}>
                  <div className="text-xs text-gray-600">
                    {dateHeure(e.enregistreLe)} · {e.auteur.nomComplet} · <strong>{LIBELLE_NATURE[e.nature]}</strong>
                    {e.statut ? ` → ${LIBELLE_STATUT[e.statut]}` : ""}
                    {e.horodatageClient ? ` (saisi sur le terrain à ${dateHeure(e.horodatageClient)})` : ""}
                  </div>
                  {e.nature === "DECLARATION" && <div className="text-xs text-gray-600">{e.typeRef?.libelle ?? ""} · source : {e.sourceRef?.libelle ?? "—"}</div>}
                  {e.rectifieId && <div className="text-xs text-amber-800">Rectifie l'entrée du {dateHeure(ev.data!.entrees.find((x) => x.id === e.rectifieId)?.enregistreLe ?? e.enregistreLe)}</div>}
                  <p className="whitespace-pre-wrap">{e.texte}</p>
                </li>
              ))}
            </ol>

            <form className="space-y-2 rounded border border-gray-200 p-2" onSubmit={(e) => { e.preventDefault(); if (complet) ajouter.mutate(); }}>
              <p className="font-medium">Ajouter une entrée</p>
              {ev.data.statutCourant === "CLOS" && (
                <p className="text-xs text-gray-600">Événement clos : son statut ne change plus, et un nouveau fait se déclare comme un nouvel événement. Un complément ou une rectification restent possibles.</p>
              )}
              <div className="flex flex-wrap gap-2">
                {possibles.map((s) => (
                  <Button key={s} type="button" size="sm" variant={nature === "STATUT" && statut === s ? "default" : "outline"} onClick={() => choisirGeste(s)}>{GESTE_VERS[s]}</Button>
                ))}
                <Button type="button" size="sm" variant={nature === "COMPLEMENT" ? "default" : "outline"} onClick={() => { setNature("COMPLEMENT"); setStatut(""); }}>Compléter</Button>
                <Button type="button" size="sm" variant={nature === "RECTIFICATION" ? "default" : "outline"} onClick={() => { setNature("RECTIFICATION"); setStatut(""); }}>Rectifier une entrée</Button>
              </div>
              {nature === "RECTIFICATION" && (
                <label className="block">Entrée à rectifier
                  <select className="mt-1 w-full rounded border px-2 py-1.5" value={rectifieId} onChange={(e) => setRectifieId(e.target.value)}>
                    <option value="">—</option>
                    {ev.data.entrees.map((e) => <option key={e.id} value={e.id}>{dateHeure(e.enregistreLe)} — {LIBELLE_NATURE[e.nature]} — {e.texte.slice(0, 60)}</option>)}
                  </select>
                </label>
              )}
              {nature !== "" && (
                <label className="block">{nature === "STATUT" ? "Ce qui justifie le changement" : nature === "RECTIFICATION" ? "La correction" : "Le complément"}
                  <textarea className="mt-1 w-full rounded border px-2 py-1.5" rows={2} maxLength={4000} value={texte} onChange={(e) => setTexte(e.target.value)} />
                </label>
              )}
              <div className="flex justify-end"><Button type="submit" size="sm" disabled={!complet || ajouter.isPending}>Enregistrer l'entrée</Button></div>
            </form>
            {ev.data.statutCourant !== "OUVERT" && ev.data.statutCourant !== "CLOS" && (
              <p className="text-xs"><Link className="underline" to="/exploitation/info-route">Publier ou mettre à jour l'Info Route de cet événement</Link></p>
            )}
          </div>
        )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

function StatistiquesPanneau() {
  const aujourdHui = new Date().toISOString().slice(0, 10);
  const [du, setDu] = useState("");
  const [au, setAu] = useState(aujourdHui);
  const valide = du !== "" && au !== "" && au > du;
  const stats = useQuery({
    queryKey: ["exploitation", "statistiques", du, au],
    enabled: valide,
    queryFn: async () => (await api.get<Statistiques>("/v2/exploitation/statistiques", { params: { du, au } })).data,
  });
  const ref = useReferentiels();
  const libelleType = (c: string) => ref.data?.types.find((t) => t.code === c)?.libelle ?? c;
  return (
    <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-3" aria-labelledby="titre-stats">
      <h2 id="titre-stats" className="flex items-center gap-2 font-semibold"><BarChart3 className="h-4 w-4" aria-hidden="true" /> Statistiques d'exploitation</h2>
      <p className="text-xs text-gray-600">Sur les événements ouverts dans la période. Médiane et 90e centile par rang le plus proche ; aucune cible ni seuil n'est fixé.</p>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label>Du<input type="date" className="ml-1 rounded border px-2 py-1" value={du} onChange={(e) => setDu(e.target.value)} /></label>
        <label>Au (exclu)<input type="date" className="ml-1 rounded border px-2 py-1" value={au} onChange={(e) => setAu(e.target.value)} /></label>
        {!valide && <span className="text-xs text-gray-600">Choisissez une période : aucune n'est supposée.</span>}
      </div>
      {stats.isLoading && valide ? <p className="text-sm text-gray-500">Calcul…</p> : stats.data && (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded border p-2"><div className="text-xs text-gray-600">Événements</div><div className="text-lg font-semibold">{stats.data.nbEvenements}</div></div>
            <div className="rounded border p-2"><div className="text-xs text-gray-600">Prise en compte (médiane / 90e)</div><div className="font-semibold">{duree(stats.data.priseEnCompte.medianeS)} / {duree(stats.data.priseEnCompte.p90S)}</div></div>
            <div className="rounded border p-2"><div className="text-xs text-gray-600">Jamais pris en compte</div><div className="text-lg font-semibold">{stats.data.priseEnCompte.jamaisPrisEnCompte}</div></div>
            <div className="rounded border p-2"><div className="text-xs text-gray-600">Durée des coupures (médiane)</div><div className="font-semibold">{duree(stats.data.dureeCoupures.medianeS)}{stats.data.dureeCoupures.coupuresNonCloses ? ` · ${stats.data.dureeCoupures.coupuresNonCloses} non close(s)` : ""}</div></div>
          </div>
          <table className="w-full">
            <caption className="text-left text-xs text-gray-600">Par type</caption>
            <thead><tr className="text-left text-gray-600"><th>Type</th><th>Événements</th><th>Prise en compte (médiane)</th></tr></thead>
            <tbody>{stats.data.parType.map((t) => <tr key={t.typeCode} className="border-t"><td>{libelleType(t.typeCode)}</td><td>{t.n}</td><td>{duree(t.priseEnCompte.medianeS)}</td></tr>)}</tbody>
          </table>
          {stats.data.troncons.length > 0 && (
            <table className="w-full">
              <caption className="text-left text-xs text-gray-600">Tronçons les plus touchés{stats.data.horsTroncon ? ` (${stats.data.horsTroncon} événement(s) hors tronçon)` : ""}</caption>
              <thead><tr className="text-left text-gray-600"><th>Tronçon</th><th>Événements</th><th>Coupures</th></tr></thead>
              <tbody>{stats.data.troncons.map((t) => <tr key={t.tronconId} className="border-t"><td>{t.code ?? t.tronconId}{t.nom ? ` — ${t.nom}` : ""}</td><td>{t.n}</td><td>{t.coupures}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

export function MainCourantePage() {
  const qc = useQueryClient();
  const [filtre, setFiltre] = useState<StatutEvenement | "TOUS">("TOUS");
  const [recherche, setRecherche] = useState("");
  const [declarer, setDeclarer] = useState(false);
  // Un lien d'un autre écran (cellule de veille) peut ouvrir directement le journal d'un événement.
  const [params] = useSearchParams();
  const [detail, setDetail] = useState<string | null>(params.get("evenement"));
  const [onglet, setOnglet] = useState<"journal" | "statistiques">("journal");
  const ref = useReferentiels();
  const libelleType = (c: string) => ref.data?.types.find((t) => t.code === c)?.libelle ?? c;

  const evenements = useQuery({
    queryKey: ["exploitation", "main-courante", "liste", filtre],
    queryFn: async () => (await api.get<{ evenements: LigneEvenement[] }>("/v2/exploitation/main-courante/evenements", {
      params: filtre === "TOUS" ? {} : { statut: filtre },
    })).data.evenements,
  });
  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return (evenements.data ?? []).filter((e) => !q || e.texte.toLowerCase().includes(q) || libelleType(e.typeCode).toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evenements.data, recherche, ref.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-gray-700"><ClipboardList className="h-4 w-4" aria-hidden="true" /> Journal en ajout seul : chaque entrée porte son auteur et l'heure du serveur.</p>
        <div className="flex gap-2">
          <Button variant={onglet === "journal" ? "default" : "ghost"} size="sm" onClick={() => setOnglet("journal")}>Événements</Button>
          <Button variant={onglet === "statistiques" ? "default" : "ghost"} size="sm" onClick={() => setOnglet("statistiques")}>Statistiques</Button>
          <Button size="sm" onClick={() => setDeclarer(true)}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />Déclarer un événement</Button>
        </div>
      </div>

      {onglet === "statistiques" ? <StatistiquesPanneau /> : (
        <section className="rounded-lg border border-gray-200 bg-white p-3" aria-labelledby="titre-evenements">
          <h2 id="titre-evenements" className="sr-only">Événements</h2>
          <div className="flex flex-wrap items-center gap-2">
            {(["TOUS", ...STATUTS] as const).map((s) => (
              <Button key={s} size="sm" variant={filtre === s ? "default" : "ghost"} onClick={() => setFiltre(s)}>{s === "TOUS" ? "Tous" : LIBELLE_STATUT[s]}</Button>
            ))}
            <label className="ml-auto text-sm">Rechercher
              <input className="ml-2 rounded border px-2 py-1" value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="texte, type…" />
            </label>
          </div>
          {evenements.isLoading ? <p className="mt-2 text-sm text-gray-500">Chargement…</p>
            : evenements.isError ? <p className="mt-2 text-sm text-red-700">Main courante indisponible.</p>
            : visibles.length === 0 ? <p className="mt-2 text-sm text-gray-600">Aucun événement{filtre !== "TOUS" ? " dans ce statut" : ""}. Déclarez-en un avec le bouton ci-dessus.</p>
            : (
              <table className="mt-2 w-full text-sm">
                <thead><tr className="text-left text-gray-600"><th>Ouvert le</th><th>Type</th><th>Ce qui est constaté</th><th>Statut</th><th>Entrées</th><th><span className="sr-only">Action</span></th></tr></thead>
                <tbody>
                  {visibles.map((e) => (
                    <tr key={e.evenementId} className="border-t align-top">
                      <td className="whitespace-nowrap">{dateHeure(e.ouvertLe)}</td>
                      <td>{libelleType(e.typeCode)}</td>
                      <td className="max-w-md truncate" title={e.texte}>{e.texte}</td>
                      <td><span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${COULEUR_STATUT[e.statut]}`}>{LIBELLE_STATUT[e.statut]}</span></td>
                      <td>{e.nbEntrees}{e.nbRectifications ? ` (${e.nbRectifications} rect.)` : ""}</td>
                      <td><Button size="sm" variant="outline" onClick={() => setDetail(e.evenementId)}>Ouvrir</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </section>
      )}

      {declarer && <DeclarationModal open onClose={() => setDeclarer(false)} onFait={(id) => { setDeclarer(false); qc.invalidateQueries({ queryKey: ["exploitation"] }); setDetail(id); }} />}
      <DetailModal evenementId={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
