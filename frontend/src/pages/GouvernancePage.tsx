import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Save, Ban, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { parseApiError } from "../lib/errors";
import { toast } from "../lib/toast";
import { useConfirm } from "../hooks/useConfirm";
import { useAuth } from "../lib/auth";
import type { Region, User } from "../types";
import { PerimetresTerritoriaux } from "./gouvernance/PerimetresTerritoriaux";

/**
 * Désignation des validateurs (§35 du cahier : « un validateur est désigné pour chaque
 * domaine »).
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * Cinq des sept domaines n'ont **aucune route de validation** : la colonne
 * `statutValidation` leur a été ajoutée et rien ne l'écrit. Y désigner un validateur
 * serait sans effet. Les présenter à l'identique inviterait à cocher des cases qui ne
 * changent rien — ce qui est pire qu'un manque affiché, puisque cela donne le sentiment du
 * travail fait. Ils sont donc séparés et marqués.
 *
 * La règle est un RESSERREMENT PAR DOMAINE : tant que personne n'est désigné, tout
 * gestionnaire valide. C'est écrit en haut de l'écran, parce qu'un administrateur qui
 * désigne la première personne resserre le domaine sans forcément s'en rendre compte.
 *
 * Et une délégation révoquée reste affichée : des validations ont été rendues sous son
 * autorité.
 */

const DOMAINE_LIBELLES: Record<string, string> = {
  DEFAUT: "Défauts",
  OBSERVATION: "Observations terrain",
  TRONCON: "Tronçons",
  OUVRAGE: "Ouvrages d'art",
  POINT_NOIR: "Points noirs",
  POSTE: "Péages et pesages",
  CHANTIER: "Chantiers",
};

interface EtatGouvernance {
  domaines: number;
  designes: number;
  nonDesignes: string[];
  sansChemindeValidation: string[];
  domainesActifs: string[];
  aDesigner: string[];
  delegationsEnVigueur: number;
}

interface Delegation {
  id: string;
  domaine: string;
  regionId: number | null;
  debutLe: string;
  finLe: string | null;
  revoqueeLe: string | null;
  motif: string | null;
  enVigueur: boolean;
  validateur: { id: string; nomComplet: string; role: string };
  deleguePar: { id: string; nomComplet: string };
  region: { id: number; nom: string } | null;
}

function etatLisible(d: Delegation): { texte: string; classe: string } {
  if (d.revoqueeLe) return { texte: "Révoquée", classe: "bg-red-50 text-red-700 border-red-200" };
  if (!d.enVigueur && d.finLe && new Date(d.finLe) <= new Date()) {
    return { texte: "Échue", classe: "bg-gray-100 text-gray-600 border-gray-200" };
  }
  if (!d.enVigueur) return { texte: "À venir", classe: "bg-amber-50 text-amber-700 border-amber-200" };
  return { texte: "En vigueur", classe: "bg-green-50 text-green-700 border-green-200" };
}

export function GouvernancePage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const [domaine, setDomaine] = useState("");
  const [validateurId, setValidateurId] = useState("");
  const [regionId, setRegionId] = useState("");
  const [finLe, setFinLe] = useState("");
  const [motif, setMotif] = useState("");

  const { data: etat } = useQuery<EtatGouvernance>({
    queryKey: ["gouvernance", "etat"],
    queryFn: async () => (await api.get<EtatGouvernance>("/admin/gouvernance/validation")).data,
    // Réservé à ADMIN côté serveur : la Direction Technique voit les désignations, pas le
    // décompte des domaines non désignés, qui est une carte des points faibles.
    enabled: user?.role === "ADMIN",
  });

  const { data: delegations, isLoading } = useQuery<Delegation[]>({
    queryKey: ["gouvernance", "delegations"],
    queryFn: async () => (await api.get<Delegation[]>("/gouvernance/delegations")).data,
  });

  /**
   * Les domaines viennent d'une route que la Direction Technique peut lire.
   *
   * « Aucune route ne valide un tronçon » est une propriété du logiciel, identique pour
   * tout le monde. Le rapport `/admin/gouvernance/validation`, lui, reste réservé à ADMIN :
   * il dit où PERSONNE n'est désigné, ce qui est une carte des points faibles.
   *
   * Les deux étaient d'abord confondus, et la Direction Technique — celle qui désigne —
   * n'aurait rien vu de l'avertissement qui la concerne le plus.
   */
  const { data: domaines } = useQuery<{ actifs: string[]; sansChemindeValidation: string[] }>({
    queryKey: ["gouvernance", "domaines"],
    queryFn: async () =>
      (await api.get<{ actifs: string[]; sansChemindeValidation: string[] }>("/gouvernance/domaines")).data,
  });

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
  });

  /**
   * Les candidats viennent d'une route dédiée, et non de `/api/users`.
   *
   * Ce routeur est réservé à ADMIN : la Direction Technique n'aurait pu désigner personne
   * depuis l'écran — le droit lui aurait été accordé sans moyen de l'exercer. Et l'ouvrir
   * aurait divulgué les adresses, les dernières connexions et l'état du second facteur de
   * tous les comptes.
   *
   * Le serveur exclut déjà les lecteurs et les inspecteurs, que `ROLES_VALIDATEURS`
   * n'admet pas, ainsi que le demandeur lui-même.
   */
  const { data: validateursPossibles } = useQuery<Pick<User, "id" | "nomComplet" | "role">[]>({
    queryKey: ["gouvernance", "validateurs-possibles"],
    queryFn: async () =>
      (await api.get<Pick<User, "id" | "nomComplet" | "role">[]>("/gouvernance/validateurs-possibles")).data,
  });

  const designer = useMutation({
    mutationFn: () =>
      api.post("/gouvernance/delegations", {
        domaine,
        validateurId,
        regionId: regionId ? Number(regionId) : null,
        finLe: finLe ? new Date(finLe).toISOString() : null,
        motif: motif || undefined,
      }),
    onSuccess: () => {
      toast.success("Validateur désigné");
      qc.invalidateQueries({ queryKey: ["gouvernance"] });
      setDomaine(""); setValidateurId(""); setRegionId(""); setFinLe(""); setMotif("");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const revoquer = useMutation({
    mutationFn: (id: string) => api.post(`/gouvernance/delegations/${id}/revocation`, {}),
    onSuccess: () => {
      toast.success("Désignation révoquée");
      qc.invalidateQueries({ queryKey: ["gouvernance"] });
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const actifs = domaines?.actifs ?? [];
  const sansChemin = domaines?.sansChemindeValidation ?? [];

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-navy" />
        <h1 className="text-lg font-medium text-gray-800">Désignation des validateurs</h1>
      </header>

      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-2 text-sm text-gray-700">
        <p>
          Tant qu'<strong>aucun</strong> validateur n'est désigné sur un domaine, tout
          gestionnaire y valide. Dès qu'un seul est désigné, le domaine lui est réservé —
          désigner la première personne <strong>resserre</strong> donc le domaine.
        </p>
        <p className="text-xs text-gray-500">
          Une délégation sans région porte sur tout le pays. Une délégation régionale ne
          couvre pas un objet dont la région est inconnue : un défaut dont le tronçon n'est
          pas apparié, par exemple.
        </p>
      </div>

      {sansChemin.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              <strong>Désigner un validateur sur ces domaines serait sans effet aujourd'hui.</strong>{" "}
              Aucune route ne les valide encore :{" "}
              {sansChemin.map((d) => DOMAINE_LIBELLES[d] ?? d).join(", ")}.
            </span>
          </p>
        </div>
      )}

      {etat && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Domaines qui valident", valeur: actifs.length },
            { label: "Désignations en vigueur", valeur: etat.delegationsEnVigueur },
            { label: "Restent à désigner", valeur: etat.aDesigner.length },
            { label: "Sans route de validation", valeur: sansChemin.length },
          ].map((c) => (
            <div key={c.label} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
              <p className="text-xl text-gray-800">{c.valeur}</p>
              <p className="text-xs text-gray-500">{c.label}</p>
            </div>
          ))}
        </div>
      )}

      <form
        className="rounded-lg border border-gray-200 bg-white p-4 space-y-3"
        onSubmit={(e) => { e.preventDefault(); designer.mutate(); }}
      >
        <h2 className="text-sm font-medium text-gray-800">Désigner un validateur</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-sm text-gray-700">
            Domaine
            <select
              required
              value={domaine}
              onChange={(e) => setDomaine(e.target.value)}
              className="mt-1 w-full rounded-md border-gray-300 text-sm focus:border-navy focus:ring-navy/30"
            >
              <option value="">Choisir…</option>
              {actifs.map((d) => (
                <option key={d} value={d}>{DOMAINE_LIBELLES[d] ?? d}</option>
              ))}
              {sansChemin.map((d) => (
                <option key={d} value={d}>{DOMAINE_LIBELLES[d] ?? d} — sans effet aujourd'hui</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-700">
            Validateur
            <select
              required
              value={validateurId}
              onChange={(e) => setValidateurId(e.target.value)}
              className="mt-1 w-full rounded-md border-gray-300 text-sm focus:border-navy focus:ring-navy/30"
            >
              <option value="">Choisir…</option>
              {(validateursPossibles ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.nomComplet} — {u.role}</option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-gray-400">
              Seuls les comptes qui peuvent valider sont proposés, et jamais vous-même.
            </span>
          </label>

          <label className="text-sm text-gray-700">
            Périmètre
            <select
              value={regionId}
              onChange={(e) => setRegionId(e.target.value)}
              className="mt-1 w-full rounded-md border-gray-300 text-sm focus:border-navy focus:ring-navy/30"
            >
              <option value="">Tout le pays</option>
              {(regions ?? []).map((r) => (
                <option key={r.id} value={String(r.id)}>{r.nom}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-700">
            Fin (facultative)
            <Input type="date" value={finLe} onChange={(e) => setFinLe(e.target.value)} className="mt-1" />
            <span className="mt-1 block text-xs text-gray-400">
              Sans date, la désignation n'a pas de terme — c'est un choix, pas un oubli.
            </span>
          </label>
        </div>

        <label className="block text-sm text-gray-700">
          Motif
          <Input
            maxLength={2000}
            value={motif}
            onChange={(e) => setMotif(e.target.value)}
            placeholder="Pourquoi cette désignation — lu lors d'un audit, des années après."
            className="mt-1"
          />
        </label>

        <Button type="submit" disabled={designer.isPending}>
          <Save className="h-4 w-4" />
          {designer.isPending ? "Enregistrement…" : "Désigner"}
        </Button>
      </form>

      <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <h2 className="px-4 py-2 text-sm font-medium text-gray-800 border-b border-gray-100">
          Désignations
          <span className="ml-2 text-xs font-normal text-gray-400">
            révoquées et échues comprises — des validations ont été rendues sous leur autorité
          </span>
        </h2>
        {isLoading && <p className="px-4 py-3 text-sm text-gray-400">Chargement…</p>}
        {delegations?.length === 0 && (
          <p className="px-4 py-3 text-sm text-gray-500">
            Aucune désignation. Tout gestionnaire valide donc sur l'ensemble des domaines.
          </p>
        )}
        <ul className="divide-y divide-gray-100">
          {delegations?.map((d) => {
            const etatD = etatLisible(d);
            return (
              <li key={d.id} className="px-4 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="text-gray-800">
                    {DOMAINE_LIBELLES[d.domaine] ?? d.domaine} — {d.validateur.nomComplet}
                    <span className={`ml-2 inline-block rounded border px-1.5 py-0.5 text-xs ${etatD.classe}`}>
                      {etatD.texte}
                    </span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {d.region ? d.region.nom : "Tout le pays"} · désignée par {d.deleguePar.nomComplet}
                    {" · depuis "}{new Date(d.debutLe).toLocaleDateString("fr-FR")}
                    {d.finLe && ` jusqu'au ${new Date(d.finLe).toLocaleDateString("fr-FR")}`}
                  </p>
                  {d.motif && <p className="text-xs text-gray-400 mt-0.5">{d.motif}</p>}
                </div>
                {!d.revoqueeLe && (
                  <button
                    title="Révoquer"
                    className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                    onClick={async () => {
                      if (await confirm(
                        "Révoquer cette désignation ? La ligne est conservée avec sa date : des validations ont pu être rendues sous son autorité.",
                        { danger: true },
                      )) revoquer.mutate(d.id);
                    }}
                  >
                    <Ban className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {user?.role === "ADMIN" && <PerimetresTerritoriaux />}

      {dialog}
    </div>
  );
}
