import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { messageErreur } from "../lib/exploitation";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import {
  LIBELLE_STATUT_MISSION, LIBELLE_TYPE_MISSION, STATUTS_MISSION, transitionsMission, TYPES_MISSION, versIso,
  type StatutMission,
} from "../lib/missions";

/**
 * Missions terrain (api/v2/missions) : liste du périmètre, création, fiche et cycle de vie.
 *
 * Le PÉRIMÈTRE est celui du serveur : un agent ne voit que les missions qu'il a créées ou qui lui
 * sont assignées. Créer est réservé à un gestionnaire ou un administrateur. Le serveur ne sait ni
 * modifier ni supprimer une mission : une mission caduque s'ANNULE, et l'écran ne propose pas
 * davantage.
 */

interface Mission {
  id: string; code: string; intitule: string; type: keyof typeof LIBELLE_TYPE_MISSION; statut: StatutMission;
  assigneId: string | null; createurId: string; regionId: number | null; vehicule: string | null; equipe: string | null;
  debutPrevu: string | null; finPrevue: string | null; debutReel: string | null; finReelle: string | null;
}
interface Fiche extends Mission { traces: { id: string; debutA: string; finA: string | null; distanceKm: number | null }[] }
interface Personne { id: string; nomComplet: string }
interface Region { id: number; nom: string }

const dateFr = (v: string | null) => (v ? new Date(v).toLocaleString("fr-FR") : "—");

function CreationModal({ onClose, onFait }: { onClose: () => void; onFait: (id: string) => void }) {
  const [f, setF] = useState({ code: "", intitule: "", type: "", assigneId: "", regionId: "", vehicule: "", equipe: "", debutPrevu: "", finPrevue: "" });
  const personnes = useQuery({
    queryKey: ["missions", "personnes"],
    queryFn: async () => (await api.get<{ personnes: Personne[] }>("/v2/exploitation/veille/personnes")).data.personnes,
  });
  const regions = useQuery({ queryKey: ["regions"], queryFn: async () => (await api.get<Region[]>("/regions")).data });
  const debut = versIso(f.debutPrevu), fin = versIso(f.finPrevue);
  const erreurs = [
    ...(debut === null || fin === null ? ["Date illisible."] : []),
    ...(debut && fin && fin < debut ? ["La fin prévue doit suivre le début prévu."] : []),
  ];
  const valide = f.code.trim() && f.intitule.trim() && f.type && erreurs.length === 0;
  const creer = useMutation({
    mutationFn: async () => (await api.post<Mission>("/v2/missions", {
      code: f.code.trim(), intitule: f.intitule.trim(), type: f.type,
      ...(f.assigneId ? { assigneId: f.assigneId } : {}),
      ...(f.regionId ? { regionId: Number(f.regionId) } : {}),
      ...(f.vehicule.trim() ? { vehicule: f.vehicule.trim() } : {}),
      ...(f.equipe.trim() ? { equipe: f.equipe.trim() } : {}),
      ...(debut ? { debutPrevu: debut } : {}),
      ...(fin ? { finPrevue: fin } : {}),
    })).data,
    onSuccess: (m) => { toast.success(`Mission ${m.code} créée (brouillon)`); onFait(m.id); },
    onError: (e) => toast.error(messageErreur(e, "Création refusée")),
  });
  const champ = (cle: keyof typeof f, libelle: string, props: Record<string, unknown> = {}) => (
    <label className="block">{libelle}<input className="mt-1 w-full rounded border px-2 py-1" value={f[cle]} onChange={(e) => setF({ ...f, [cle]: e.target.value })} {...props} /></label>
  );
  return (
    <Modal open onClose={onClose} title="Nouvelle mission" sale={() => !creer.isSuccess && (f.code !== "" || f.intitule !== "")}>
      <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (valide) creer.mutate(); }}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {champ("code", "Code (unique)", { maxLength: 64 })}
          <label className="block">Type
            <select className="mt-1 w-full rounded border px-2 py-1" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="">Choisir…</option>
              {TYPES_MISSION.map((t) => <option key={t} value={t}>{LIBELLE_TYPE_MISSION[t]}</option>)}
            </select>
          </label>
        </div>
        {champ("intitule", "Intitulé", { maxLength: 300 })}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block">Agent assigné
            <select className="mt-1 w-full rounded border px-2 py-1" value={f.assigneId} onChange={(e) => setF({ ...f, assigneId: e.target.value })}>
              <option value="">Personne pour l'instant</option>
              {(personnes.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nomComplet}</option>)}
            </select>
          </label>
          <label className="block">Région
            <select className="mt-1 w-full rounded border px-2 py-1" value={f.regionId} onChange={(e) => setF({ ...f, regionId: e.target.value })}>
              <option value="">Non précisée</option>
              {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
            </select>
          </label>
          {champ("debutPrevu", "Début prévu", { type: "datetime-local" })}
          {champ("finPrevue", "Fin prévue", { type: "datetime-local" })}
          {champ("vehicule", "Véhicule", { maxLength: 60 })}
          {champ("equipe", "Équipe", { maxLength: 300 })}
        </div>
        {personnes.isError && <p className="text-xs text-amber-800">Liste des agents indisponible pour votre compte : la mission peut être créée sans agent.</p>}
        {erreurs.map((x) => <p key={x} className="text-xs text-red-700">{x}</p>)}
        <p className="text-xs text-gray-600">La mission naît en brouillon. Le serveur ne sait ni la modifier ni la supprimer ensuite : vérifier avant de créer, annuler si elle devient caduque.</p>
        <div className="flex justify-end"><Button type="submit" size="sm" disabled={!valide || creer.isPending}>Créer la mission</Button></div>
      </form>
    </Modal>
  );
}

export function FicheMission({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const fiche = useQuery({ queryKey: ["missions", "fiche", id], queryFn: async () => (await api.get<Fiche>(`/v2/missions/${id}`)).data });
  const changer = useMutation({
    mutationFn: async (statut: StatutMission) => (await api.post(`/v2/missions/${id}/statut`, { statut })).data,
    onSuccess: () => { toast.success("Statut mis à jour"); qc.invalidateQueries({ queryKey: ["missions"] }); },
    onError: (e) => toast.error(messageErreur(e, "Transition refusée")),
  });
  const m = fiche.data;
  const peutAgir = !!user && user.role !== "LECTEUR";
  return (
    <Modal open onClose={onClose} title={m ? `Mission ${m.code}` : "Mission"}>
      {fiche.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : fiche.isError || !m ? <p className="text-sm text-red-700">Mission introuvable ou hors de votre périmètre.</p>
        : (
          <div className="space-y-3 text-sm">
            <p>{m.intitule} · {LIBELLE_TYPE_MISSION[m.type] ?? m.type} · <strong>{LIBELLE_STATUT_MISSION[m.statut] ?? m.statut}</strong></p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-gray-600">Prévu</dt><dd>{dateFr(m.debutPrevu)} → {dateFr(m.finPrevue)}</dd>
              <dt className="text-gray-600">Réel (posé par le serveur)</dt><dd>{dateFr(m.debutReel)} → {dateFr(m.finReelle)}</dd>
              <dt className="text-gray-600">Véhicule, équipe</dt><dd>{m.vehicule ?? "—"}, {m.equipe ?? "—"}</dd>
            </dl>
            {peutAgir && transitionsMission(m.statut).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {transitionsMission(m.statut).map((s) => (
                  <Button key={s} size="sm" variant={s === "ANNULEE" ? "danger" : "outline"} disabled={changer.isPending} onClick={() => changer.mutate(s)}>
                    {s === "ANNULEE" ? "Annuler la mission" : `Passer à : ${LIBELLE_STATUT_MISSION[s].toLowerCase()}`}
                  </Button>
                ))}
              </div>
            )}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Traces</h3>
              {m.traces.length === 0 ? <p className="text-xs text-gray-600">Aucune trace rattachée.</p> : (
                <ul className="text-xs">{m.traces.map((t) => <li key={t.id}>{dateFr(t.debutA)} → {dateFr(t.finA)} · {t.distanceKm == null ? "distance inconnue" : `${t.distanceKm.toLocaleString("fr-FR")} km`}</li>)}</ul>
              )}
            </section>
          </div>
        )}
    </Modal>
  );
}

export function MissionsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const peutCreer = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const [statut, setStatut] = useState<StatutMission | "">("");
  const [creation, setCreation] = useState(false);
  const [fiche, setFiche] = useState<string | null>(null);
  const liste = useQuery({
    queryKey: ["missions", "liste", statut],
    queryFn: async () => (await api.get<Mission[]>("/v2/missions", { params: { limite: 200, ...(statut ? { statut } : {}) } })).data,
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-sm">Statut
          <select className="ml-2 rounded border px-2 py-1" value={statut} onChange={(e) => setStatut(e.target.value as StatutMission | "")}>
            <option value="">Tous</option>
            {STATUTS_MISSION.map((s) => <option key={s} value={s}>{LIBELLE_STATUT_MISSION[s]}</option>)}
          </select>
        </label>
        {peutCreer && <Button size="sm" onClick={() => setCreation(true)}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />Nouvelle mission</Button>}
      </div>
      {liste.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : liste.isError ? <p className="text-sm text-red-700">{messageErreur(liste.error, "Missions indisponibles.")}</p>
        : (liste.data ?? []).length === 0 ? <p className="text-sm text-gray-600">Aucune mission dans votre périmètre{statut ? " pour ce statut" : ""}.</p>
        : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <caption className="sr-only">Missions</caption>
              <thead><tr className="text-left text-gray-600"><th className="p-2">Code</th><th>Intitulé</th><th>Type</th><th>Statut</th><th>Début prévu</th><th><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {(liste.data ?? []).map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="p-2">{m.code}</td><td>{m.intitule}</td><td>{LIBELLE_TYPE_MISSION[m.type] ?? m.type}</td>
                    <td>{LIBELLE_STATUT_MISSION[m.statut] ?? m.statut}</td><td>{dateFr(m.debutPrevu)}</td>
                    <td><Button size="sm" variant="outline" onClick={() => setFiche(m.id)}>Fiche</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {(liste.data ?? []).length === 200 && <p className="text-xs text-amber-800">200 missions affichées : la liste est tronquée, filtrer par statut.</p>}
      {creation && <CreationModal onClose={() => setCreation(false)} onFait={(id) => { setCreation(false); qc.invalidateQueries({ queryKey: ["missions"] }); setFiche(id); }} />}
      {fiche && <FicheMission id={fiche} onClose={() => setFiche(null)} />}
    </div>
  );
}
