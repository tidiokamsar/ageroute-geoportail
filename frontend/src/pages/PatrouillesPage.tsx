import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { MOIS, libelleMois, messageErreur, type Personne } from "../lib/exploitation";
import type { PaginatedResult } from "../types";

/**
 * Patrouilles programmées (paragraphe 7.17, EX-03) : saisie des programmes et suivi des échéances.
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **Rien n'est prérempli.** La périodicité et les mois actifs sont saisis par AGEROUTE : le champ
 * de périodicité est vide au départ, et l'exemple du mandat (« RN hebdomadaires en saison des
 * pluies ») n'est pas proposé comme valeur par défaut.
 *
 * **Aucun mois coché, c'est toute l'année** : l'écran le dit en toutes lettres sous les cases.
 *
 * **Un passage engendré est une mission en brouillon.** Le planifier, le clore passe par le cycle
 * de vie des missions ; l'écran ne promet pas plus.
 */

interface Programme {
  id: string;
  code: string;
  libelle: string;
  classeAxe: string | null;
  periodiciteJours: number;
  moisActifs: number[];
  actif: boolean;
  dernierPassage: string | null;
  responsable: Personne;
  _count: { troncons: number };
  echeance: { statut: string; prochaine: string | null; joursRetard: number };
}
interface TronconCourt { id: string; code: string; nom: string }

const LIBELLE_ECHEANCE: Record<string, string> = {
  INACTIF: "Inactif",
  HORS_SAISON: "Hors saison",
  JAMAIS_REALISE: "Jamais réalisé",
  A_JOUR: "À jour",
  DUE: "Dû aujourd'hui",
  EN_RETARD: "En retard",
};

function Echeance({ e }: { e: Programme["echeance"] }) {
  const style = e.statut === "EN_RETARD" || e.statut === "JAMAIS_REALISE" ? "bg-red-100 text-red-800"
    : e.statut === "DUE" ? "bg-amber-100 text-amber-900"
    : e.statut === "A_JOUR" ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-700";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${style}`}>
      {LIBELLE_ECHEANCE[e.statut] ?? e.statut}
      {e.statut === "EN_RETARD" ? ` de ${e.joursRetard} j` : ""}
      {e.prochaine && e.statut !== "INACTIF" ? ` — prochain le ${new Date(e.prochaine).toLocaleDateString("fr-FR", { timeZone: "UTC" })}` : ""}
    </span>
  );
}

function FormulaireProgramme({ onCree }: { onCree: () => void }) {
  const [code, setCode] = useState("");
  const [libelle, setLibelle] = useState("");
  const [classeAxe, setClasseAxe] = useState("");
  const [periodicite, setPeriodicite] = useState("");
  const [mois, setMois] = useState<number[]>([]);
  const [responsableId, setResponsableId] = useState("");
  const [recherche, setRecherche] = useState("");
  const [itineraire, setItineraire] = useState<TronconCourt[]>([]);

  const personnes = useQuery({
    queryKey: ["veille", "personnes"],
    queryFn: async () => (await api.get<{ personnes: Personne[] }>("/v2/exploitation/veille/personnes")).data.personnes,
  });
  const resultats = useQuery({
    queryKey: ["troncons", "recherche", recherche],
    enabled: recherche.trim().length >= 2,
    queryFn: async () => (await api.get<PaginatedResult<TronconCourt>>("/troncons", { params: { search: recherche.trim(), pageSize: 10 } })).data.data,
  });

  const creer = useMutation({
    mutationFn: async () => (await api.post("/v2/exploitation/patrouilles/programmes", {
      code: code.trim(), libelle: libelle.trim(), classeAxe: classeAxe || null,
      periodiciteJours: Number(periodicite), moisActifs: mois, responsableId,
      troncons: itineraire.map((t) => t.id),
    })).data,
    onSuccess: () => { toast.success(`Programme ${code.trim()} créé.`); onCree(); },
    onError: (e) => toast.error(messageErreur(e, "Création refusée.")),
  });

  const periodiciteValide = /^\d+$/.test(periodicite) && Number(periodicite) >= 1 && Number(periodicite) <= 366;
  const complet = code.trim() && libelle.trim() && periodiciteValide && responsableId && itineraire.length > 0;

  const deplacer = (i: number, d: -1 | 1) => setItineraire((it) => {
    const j = i + d;
    if (j < 0 || j >= it.length) return it;
    const copie = [...it];
    [copie[i], copie[j]] = [copie[j], copie[i]];
    return copie;
  });

  return (
    <form className="space-y-3 rounded-lg border border-gray-200 bg-white p-4" onSubmit={(e) => { e.preventDefault(); if (complet) creer.mutate(); }}>
      <h2 className="font-semibold">Nouveau programme de patrouille</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">Code
          <input className="mt-1 w-full rounded border px-2 py-1" value={code} onChange={(e) => setCode(e.target.value)} maxLength={64} />
        </label>
        <label className="block text-sm">Libellé
          <input className="mt-1 w-full rounded border px-2 py-1" value={libelle} onChange={(e) => setLibelle(e.target.value)} maxLength={200} />
        </label>
        <label className="block text-sm">Classe d'axe (facultatif)
          <select className="mt-1 w-full rounded border px-2 py-1" value={classeAxe} onChange={(e) => setClasseAxe(e.target.value)}>
            <option value="">—</option>
            {["RN", "RR", "RU", "PISTE", "NON_CLASSEE"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block text-sm">Périodicité (jours, 1 à 366)
          <input className="mt-1 w-full rounded border px-2 py-1" inputMode="numeric" value={periodicite} onChange={(e) => setPeriodicite(e.target.value)} placeholder="à saisir" />
        </label>
        <label className="block text-sm md:col-span-2">Responsable
          <select className="mt-1 w-full rounded border px-2 py-1" value={responsableId} onChange={(e) => setResponsableId(e.target.value)}>
            <option value="">—</option>
            {personnes.data?.map((p) => <option key={p.id} value={p.id}>{p.nomComplet}</option>)}
          </select>
        </label>
      </div>

      <fieldset className="text-sm">
        <legend>Mois actifs</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {MOIS.map((m, i) => (
            <label key={m} className="inline-flex items-center gap-1">
              <input type="checkbox" checked={mois.includes(i + 1)}
                onChange={(e) => setMois((ms) => e.target.checked ? [...ms, i + 1] : ms.filter((x) => x !== i + 1))} />
              {m}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-500">{mois.length === 0 ? "Aucun mois coché : le programme vaut toute l'année." : `Actif : ${libelleMois(mois)}.`}</p>
      </fieldset>

      <div className="text-sm">
        <label className="block">Itinéraire — rechercher un tronçon (code ou nom)
          <input className="mt-1 w-full rounded border px-2 py-1" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
        </label>
        {resultats.data && resultats.data.length > 0 && (
          <ul className="mt-1 max-h-40 overflow-auto rounded border">
            {resultats.data.filter((t) => !itineraire.some((x) => x.id === t.id)).map((t) => (
              <li key={t.id}>
                <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-gray-50"
                  onClick={() => setItineraire((it) => [...it, t])}>
                  <Plus className="h-3.5 w-3.5" /> {t.code} — {t.nom}
                </button>
              </li>
            ))}
          </ul>
        )}
        <ol className="mt-2 space-y-1" aria-label="Itinéraire ordonné">
          {itineraire.map((t, i) => (
            <li key={t.id} className="flex items-center gap-2 rounded bg-gray-50 px-2 py-1">
              <span className="w-6 text-right text-gray-500">{i + 1}.</span>
              <span className="flex-1">{t.code} — {t.nom}</span>
              <button type="button" aria-label={`Monter ${t.code}`} onClick={() => deplacer(i, -1)}><ArrowUp className="h-4 w-4" /></button>
              <button type="button" aria-label={`Descendre ${t.code}`} onClick={() => deplacer(i, 1)}><ArrowDown className="h-4 w-4" /></button>
              <button type="button" aria-label={`Retirer ${t.code}`} onClick={() => setItineraire((it) => it.filter((x) => x.id !== t.id))}><X className="h-4 w-4" /></button>
            </li>
          ))}
        </ol>
        {itineraire.length === 0 && <p className="mt-1 text-xs text-gray-500">L'itinéraire est obligatoire : au moins un tronçon.</p>}
      </div>

      <Button type="submit" disabled={!complet || creer.isPending}>Créer le programme</Button>
    </form>
  );
}

export function PatrouillesPage() {
  const { user } = useAuth();
  const peutEcrire = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const client = useQueryClient();
  const [formulaire, setFormulaire] = useState(false);
  const [jours, setJours] = useState<Record<string, string>>({});

  const programmes = useQuery({
    queryKey: ["patrouilles", "programmes"],
    queryFn: async () => (await api.get<{ programmes: Programme[] }>("/v2/exploitation/patrouilles/programmes")).data.programmes,
  });

  const engendrer = useMutation({
    mutationFn: async ({ id, jour }: { id: string; jour: string }) =>
      (await api.post<{ code: string }>(`/v2/exploitation/patrouilles/programmes/${id}/missions`, { debutPrevu: jour })).data,
    onSuccess: (m) => toast.success(`Mission ${m.code} créée en brouillon : planifiez-la depuis les missions.`),
    onError: (e) => toast.error(messageErreur(e, "Passage refusé.")),
  });

  return (
    <div className="space-y-4">
      {peutEcrire && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => setFormulaire((f) => !f)}>{formulaire ? "Fermer le formulaire" : "Nouveau programme"}</Button>
        </div>
      )}
      {formulaire && peutEcrire && (
        <FormulaireProgramme onCree={() => { setFormulaire(false); client.invalidateQueries({ queryKey: ["patrouilles"] }); }} />
      )}

      {programmes.isLoading ? <p className="text-gray-500">Chargement…</p>
        : programmes.isError ? <p className="text-red-700">Les programmes n'ont pas pu être chargés.</p>
        : programmes.data!.length === 0 ? <p className="text-gray-500">Aucun programme de patrouille n'est saisi.</p>
        : (
          <ul className="space-y-2">
            {programmes.data!.map((p) => (
              <li key={p.id} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{p.code} — {p.libelle}</span>
                  <Echeance e={p.echeance} />
                </div>
                <div className="text-sm text-gray-600">
                  Tous les {p.periodiciteJours} j, {libelleMois(p.moisActifs)} · {p._count.troncons} tronçon(s)
                  {p.classeAxe ? ` · ${p.classeAxe}` : ""} · responsable {p.responsable.nomComplet}
                  {p.dernierPassage ? ` · dernier passage le ${new Date(p.dernierPassage).toLocaleDateString("fr-FR")}` : " · aucun passage réalisé"}
                </div>
                {peutEcrire && p.actif && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    <label>Passage du
                      <input type="date" className="ml-2 rounded border px-2 py-0.5" aria-label={`Date du passage ${p.code}`}
                        value={jours[p.id] ?? ""} onChange={(e) => setJours((j) => ({ ...j, [p.id]: e.target.value }))} />
                    </label>
                    <Button size="sm" disabled={!jours[p.id] || engendrer.isPending}
                      onClick={() => engendrer.mutate({ id: p.id, jour: jours[p.id] })}>Engendrer le passage</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
