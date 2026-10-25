import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { messageErreur } from "../lib/exploitation";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { DetailHistorique, PreuvePhoto, type Defaut, type Historique } from "./DefautsValidationPage";
import {
  corpsResoumission, GESTE_ETAT, LIBELLE_ETAT, LIBELLE_STATUT_DEFAUT, MESURES, transitionsEtat,
  type CleMesure, type EtatDefaut, type StatutDefaut,
} from "../lib/defauts";

/**
 * Registre des défauts (A5) : tous les relevés du périmètre, pas seulement ceux qui attendent une
 * décision. Ce que la validation ne couvre pas s'y fait :
 *   - **le cycle de vie physique** (actif, traité, disparu), distinct de la validation : un défaut
 *     validé se répare sans que sa validation soit remise en cause ; la date de traitement est
 *     posée par le serveur ;
 *   - **la resoumission** d'un relevé renvoyé « à corriger », par son auteur (ou un administrateur) ;
 *     elle repasse les contrôles de création.
 * Aucune suppression : un défaut est une donnée d'archive. Un relevé faux se rejette en validation.
 */

type Ligne = Defaut & { etat: EtatDefaut; traiteA: string | null; createdAt?: string };
type Fiche = Ligne & { catalogue: Defaut["catalogue"] & { mesuresRequises?: string[]; graviteMax?: number | null }; validations: Historique[]; commentaire?: string | null };
type Catalogue = { code: string; libelle: string };

const STATUTS: StatutDefaut[] = ["A_VALIDER", "A_CORRIGER", "VALIDE", "REJETE"];
const ETATS: EtatDefaut[] = ["ACTIF", "TRAITE", "DISPARU"];
const ETENDUES = ["PONCTUEL", "LOCALISE", "ETENDU", "GENERALISE"] as const;
const TAILLE_PAGE = 50;

const dateFr = (v: string | null | undefined) => (v ? new Date(v).toLocaleString("fr-FR") : "—");
const nombre = (v: number | null | undefined) => (v == null ? "" : String(v));

function Resoumission({ fiche, onFait }: { fiche: Fiche; onFait: () => void }) {
  const [s, setS] = useState(() => ({
    mesures: Object.fromEntries(MESURES.map((m) => [m.cle, nombre(fiche[m.cle])])) as Record<CleMesure, string>,
    gravite: nombre(fiche.gravite), etendue: fiche.etendue ?? "", commentaire: "",
  }));
  const requises = fiche.catalogue.mesuresRequises ?? [];
  const { corps, erreurs } = corpsResoumission(s, requises, fiche.catalogue.graviteMax ?? null);
  const envoyer = useMutation({
    mutationFn: async () => (await api.post(`/v2/defauts/${fiche.id}/resoumettre`, corps)).data,
    onSuccess: () => { toast.success("Relevé resoumis à la validation"); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Resoumission refusée")),
  });
  const derniereDemande = [...fiche.validations].reverse().find((v) => v.statutApres === "A_CORRIGER");
  return (
    <form className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (erreurs.length === 0) envoyer.mutate(); }}>
      <h3 className="font-medium">Corriger et resoumettre</h3>
      {derniereDemande?.commentaire && <p className="text-xs">Demande du validateur : « {derniereDemande.commentaire} »</p>}
      <p className="text-xs text-gray-700">Une mesure laissée vide garde la valeur relevée. Requises pour ce type : {requises.length ? requises.join(", ").toLowerCase() : "aucune"}.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {MESURES.map((m) => (
          <label key={m.cle} className="block text-xs">{m.libelle}{requises.includes(m.code) ? " *" : ""}
            <input className="mt-1 w-full rounded border bg-white px-2 py-1" inputMode="decimal" value={s.mesures[m.cle]}
              onChange={(e) => setS({ ...s, mesures: { ...s.mesures, [m.cle]: e.target.value } })} />
          </label>
        ))}
        <label className="block text-xs">Gravité{fiche.catalogue.graviteMax ? ` (1 à ${fiche.catalogue.graviteMax})` : ""}
          <input className="mt-1 w-full rounded border bg-white px-2 py-1" inputMode="numeric" value={s.gravite} onChange={(e) => setS({ ...s, gravite: e.target.value })} />
        </label>
        <label className="block text-xs">Étendue
          <select className="mt-1 w-full rounded border bg-white px-2 py-1" value={s.etendue} onChange={(e) => setS({ ...s, etendue: e.target.value })}>
            <option value="">Inchangée</option>
            {ETENDUES.map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-xs">Réponse au validateur
        <textarea className="mt-1 w-full rounded border bg-white px-2 py-1" rows={2} maxLength={2000} value={s.commentaire} onChange={(e) => setS({ ...s, commentaire: e.target.value })} />
      </label>
      {erreurs.length > 0 && <ul className="text-xs text-red-700">{erreurs.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="flex justify-end"><Button type="submit" size="sm" disabled={erreurs.length > 0 || envoyer.isPending}>Resoumettre</Button></div>
    </form>
  );
}

export function FicheDefaut({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const fiche = useQuery({
    queryKey: ["defauts", "fiche", id],
    queryFn: async () => (await api.get<Fiche>(`/v2/defauts/${id}`)).data,
  });
  const rafraichir = () => qc.invalidateQueries({ queryKey: ["defauts"] });
  const changerEtat = useMutation({
    mutationFn: async (etat: EtatDefaut) => (await api.post(`/v2/defauts/${id}/etat`, { etat })).data,
    onSuccess: () => { toast.success("État mis à jour"); rafraichir(); },
    onError: (e) => toast.error(messageErreur(e, "Changement d'état refusé")),
  });
  const d = fiche.data;
  const peutAgir = !!user && user.role !== "LECTEUR";
  const peutResoumettre = !!d && d.statutValidation === "A_CORRIGER" && !!user && (user.role === "ADMIN" || user.id === d.constatePar?.id);

  return (
    <Modal open onClose={onClose} title={d ? `Défaut ${d.code ?? d.catalogue.libelle}` : "Défaut"}>
      {fiche.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : fiche.isError || !d ? <p className="text-sm text-red-700">Défaut introuvable ou hors de votre périmètre.</p>
        : (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-gray-600">Type</dt><dd>{d.catalogue.libelle} ({d.catalogue.code})</dd>
              <dt className="text-gray-600">Validation</dt><dd>{LIBELLE_STATUT_DEFAUT[d.statutValidation as StatutDefaut] ?? d.statutValidation}</dd>
              <dt className="text-gray-600">État physique</dt><dd>{LIBELLE_ETAT[d.etat] ?? d.etat}{d.traiteA ? `, traité le ${dateFr(d.traiteA)}` : ""}</dd>
              <dt className="text-gray-600">Constaté</dt><dd>{dateFr(d.constateA)}{d.constatePar ? ` par ${d.constatePar.nomComplet}` : ""}</dd>
              <dt className="text-gray-600">Position</dt><dd>{d.lat != null && d.lon != null ? `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` : "non relevée"}{d.pk != null ? ` · PK ${d.pk}` : ""}</dd>
              <dt className="text-gray-600">Mesures</dt>
              <dd>{MESURES.filter((m) => d[m.cle] != null).map((m) => `${m.libelle.toLowerCase()} ${d[m.cle]}`).join(" · ") || "aucune"}</dd>
              <dt className="text-gray-600">Quantité retenue</dt><dd>{d.quantite != null ? `${d.quantite} ${d.uniteQuantite ?? ""}` : "—"}{d.methodeQuantite ? ` (${d.methodeQuantite.toLowerCase()})` : ""}</dd>
              <dt className="text-gray-600">Gravité, étendue</dt><dd>{d.gravite ?? "—"}, {d.etendue?.toLowerCase() ?? "—"}</dd>
            </dl>
            {peutAgir && transitionsEtat(d.etat).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {transitionsEtat(d.etat).map((e) => (
                  <Button key={e} size="sm" variant="outline" disabled={changerEtat.isPending} onClick={() => changerEtat.mutate(e)}>{GESTE_ETAT[e]}</Button>
                ))}
                <p className="w-full text-xs text-gray-600">L'état physique ne touche pas à la validation. « Traité » est daté par le serveur.</p>
              </div>
            )}
            {peutResoumettre && <Resoumission fiche={d} onFait={() => { rafraichir(); }} />}
            {!!d.medias?.length && (
              <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Photos de preuve</h3>
                <div className="grid grid-cols-2 gap-2">{d.medias.map((m) => <PreuvePhoto key={m.id} media={m} />)}</div>
              </section>
            )}
            <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Historique de validation</h3><DetailHistorique lignes={d.validations} /></section>
          </div>
        )}
    </Modal>
  );
}

export function DefautsRegistrePage() {
  const { user } = useAuth();
  const [statut, setStatut] = useState<StatutDefaut | "">("");
  const [etat, setEtat] = useState<EtatDefaut | "">("");
  const [catalogueCode, setCatalogueCode] = useState("");
  const [mesReleves, setMesReleves] = useState(false);
  const [fiche, setFiche] = useState<string | null>(null);

  const catalogue = useQuery({
    queryKey: ["defauts", "catalogue"],
    queryFn: async () => (await api.get<{ catalogue: Catalogue[] }>("/v2/defauts/catalogue")).data.catalogue,
  });
  const types = catalogue.data ?? [];

  const liste = useInfiniteQuery({
    queryKey: ["defauts", "registre", statut, etat, catalogueCode],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => (await api.get<{ defauts: Ligne[]; curseurSuivant: string | null }>("/v2/defauts", {
      params: { limite: TAILLE_PAGE, ...(statut ? { statut } : {}), ...(etat ? { etat } : {}), ...(catalogueCode ? { catalogueCode } : {}), ...(pageParam ? { curseur: pageParam } : {}) },
    })).data,
    getNextPageParam: (p) => p.curseurSuivant,
  });
  const lignes = (liste.data?.pages.flatMap((p) => p.defauts) ?? []).filter((d) => !mesReleves || d.constatePar?.id === user?.id);

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-gray-700"><ListChecks className="h-4 w-4" aria-hidden="true" /> Tous les défauts de votre périmètre. Aucune suppression : un relevé faux se rejette en validation.</p>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
        <label>Validation
          <select className="ml-2 rounded border px-2 py-1" value={statut} onChange={(e) => setStatut(e.target.value as StatutDefaut | "")}>
            <option value="">Toutes</option>
            {STATUTS.map((s) => <option key={s} value={s}>{LIBELLE_STATUT_DEFAUT[s]}</option>)}
          </select>
        </label>
        <label>État physique
          <select className="ml-2 rounded border px-2 py-1" value={etat} onChange={(e) => setEtat(e.target.value as EtatDefaut | "")}>
            <option value="">Tous</option>
            {ETATS.map((s) => <option key={s} value={s}>{LIBELLE_ETAT[s]}</option>)}
          </select>
        </label>
        <label>Type
          <select className="ml-2 rounded border px-2 py-1" value={catalogueCode} onChange={(e) => setCatalogueCode(e.target.value)}>
            <option value="">Tous</option>
            {types.map((t) => <option key={t.code} value={t.code}>{t.libelle}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={mesReleves} onChange={(e) => setMesReleves(e.target.checked)} />Mes relevés seulement</label>
      </div>

      {liste.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : liste.isError ? <p className="text-sm text-red-700">{messageErreur(liste.error, "Registre indisponible.")}</p>
        : lignes.length === 0 ? <p className="text-sm text-gray-600">Aucun défaut pour ces filtres.</p>
        : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <caption className="sr-only">Registre des défauts</caption>
              <thead><tr className="text-left text-gray-600"><th className="p-2">Constaté le</th><th>Type</th><th>Validation</th><th>État</th><th>Auteur</th><th>Photos</th><th><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {lignes.map((d) => (
                  <tr key={d.id} className="border-t">
                    <td className="whitespace-nowrap p-2">{dateFr(d.constateA)}</td>
                    <td>{d.catalogue.libelle}</td>
                    <td>{LIBELLE_STATUT_DEFAUT[d.statutValidation as StatutDefaut] ?? d.statutValidation}</td>
                    <td>{LIBELLE_ETAT[d.etat] ?? d.etat}</td>
                    <td>{d.constatePar?.nomComplet ?? "—"}</td>
                    <td>{d.medias?.length ?? 0}</td>
                    <td><Button size="sm" variant="outline" onClick={() => setFiche(d.id)}>Fiche</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {liste.hasNextPage && <Button size="sm" variant="outline" disabled={liste.isFetchingNextPage} onClick={() => liste.fetchNextPage()}>Charger la suite</Button>}
      {mesReleves && <p className="text-xs text-gray-600">« Mes relevés » filtre les pages déjà chargées.</p>}
      {fiche && <FicheDefaut id={fiche} onClose={() => setFiche(null)} />}
    </div>
  );
}
