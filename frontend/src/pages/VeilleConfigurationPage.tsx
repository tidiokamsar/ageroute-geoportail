import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { messageErreur, type Personne } from "../lib/exploitation";

/**
 * Configuration de la cellule de veille (paragraphe 7.17, EX-04) : mode, règles d'escalade,
 * astreintes. Réservée à ADMIN et GESTIONNAIRE.
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **Aucun délai n'est proposé.** Le champ est vide : un délai d'escalade est une décision
 * d'organisation qu'AGEROUTE prend, pas une valeur que l'application suggère.
 *
 * **Une règle ne s'efface pas, elle se désactive** : les escalades passées la citent.
 *
 * **Le mode se déclare et se motive.** La saison des pluies n'est pas calculée d'un calendrier.
 */

interface Regle { id: string; typeCode: string | null; mode: string; niveau: number; delaiMinutes: number; actif: boolean }
interface Astreinte { id: string; niveau: number; debut: string; fin: string; user: Personne; region: { id: number; nom: string } | null }
interface Ref { code: string; libelle: string }
interface Region { id: number; nom: string }

const LIBELLE_MODE: Record<string, string> = { NORMAL: "Normal", SAISON_PLUIES: "Saison des pluies", TOUS: "Tous modes" };

function Mode() {
  const client = useQueryClient();
  const [mode, setMode] = useState("");
  const [motif, setMotif] = useState("");
  const courant = useQuery({
    queryKey: ["veille", "mode"],
    queryFn: async () => (await api.get<{ mode: string; declare: boolean; motif: string | null }>("/v2/exploitation/veille/mode")).data,
  });
  const declarer = useMutation({
    mutationFn: async () => (await api.post("/v2/exploitation/veille/mode", { mode, motif: motif.trim() })).data,
    onSuccess: () => { toast.success("Mode déclaré."); setMotif(""); client.invalidateQueries({ queryKey: ["veille"] }); },
    onError: (e) => toast.error(messageErreur(e, "Déclaration refusée.")),
  });
  return (
    <section className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
      <h2 className="font-semibold">Mode de la cellule</h2>
      <p className="text-sm">Actuel : <strong>{courant.data ? LIBELLE_MODE[courant.data.mode] : "…"}</strong>
        {courant.data && !courant.data.declare ? " (aucun mode déclaré)" : courant.data?.motif ? ` — ${courant.data.motif}` : ""}</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (mode && motif.trim()) declarer.mutate(); }}>
        <label className="text-sm">Nouveau mode
          <select className="ml-2 rounded border px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">—</option><option value="NORMAL">Normal</option><option value="SAISON_PLUIES">Saison des pluies</option>
          </select>
        </label>
        <label className="flex-1 text-sm">Motif
          <input className="ml-2 w-full rounded border px-2 py-1" maxLength={500} value={motif} onChange={(e) => setMotif(e.target.value)} />
        </label>
        <Button type="submit" disabled={!mode || !motif.trim() || declarer.isPending}>Déclarer</Button>
      </form>
    </section>
  );
}

function Regles() {
  const client = useQueryClient();
  const [typeCode, setTypeCode] = useState("");
  const [mode, setMode] = useState("");
  const [niveau, setNiveau] = useState("");
  const [delai, setDelai] = useState("");
  const regles = useQuery({ queryKey: ["veille", "regles"], queryFn: async () => (await api.get<{ regles: Regle[] }>("/v2/exploitation/veille/regles")).data.regles });
  const refs = useQuery({ queryKey: ["exploitation", "referentiels"], queryFn: async () => (await api.get<{ types: Ref[] }>("/v2/exploitation/referentiels")).data });
  const invalider = () => client.invalidateQueries({ queryKey: ["veille"] });
  const creer = useMutation({
    mutationFn: async () => (await api.post("/v2/exploitation/veille/regles", { typeCode: typeCode || null, mode, niveau: Number(niveau), delaiMinutes: Number(delai) })).data,
    onSuccess: () => { toast.success("Règle créée."); setDelai(""); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Règle refusée.")),
  });
  const desactiver = useMutation({
    mutationFn: async (id: string) => (await api.post(`/v2/exploitation/veille/regles/${id}/desactivation`)).data,
    onSuccess: () => { toast.success("Règle désactivée."); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Désactivation refusée.")),
  });
  const delaiValide = /^\d+$/.test(delai) && Number(delai) >= 1 && Number(delai) <= 10080;
  const libelleType = (c: string | null) => c === null ? "Tous types" : refs.data?.types.find((t) => t.code === c)?.libelle ?? c;

  return (
    <section className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
      <h2 className="font-semibold">Règles d'escalade</h2>
      <p className="text-xs text-gray-500">Un événement encore OUVERT monte au niveau indiqué une fois le délai écoulé depuis son ouverture. Sans règle, rien ne monte.</p>
      {!regles.data?.length ? <p className="text-sm text-amber-800">Aucune règle saisie.</p> : (
        <ul className="divide-y text-sm">
          {regles.data.map((r) => (
            <li key={r.id} className={`flex flex-wrap items-center justify-between gap-2 py-1 ${r.actif ? "" : "text-gray-500"}`}>
              <span>{libelleType(r.typeCode)} · {LIBELLE_MODE[r.mode]} · niveau {r.niveau} après {r.delaiMinutes} min{r.actif ? "" : " (désactivée)"}</span>
              {r.actif && <Button size="sm" variant="ghost" onClick={() => desactiver.mutate(r.id)}>Désactiver</Button>}
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-2 md:grid-cols-5" onSubmit={(e) => { e.preventDefault(); if (mode && niveau && delaiValide) creer.mutate(); }}>
        <label className="text-sm">Type
          <select className="mt-1 w-full rounded border px-2 py-1" value={typeCode} onChange={(e) => setTypeCode(e.target.value)}>
            <option value="">Tous types</option>
            {refs.data?.types.map((t) => <option key={t.code} value={t.code}>{t.libelle}</option>)}
          </select>
        </label>
        <label className="text-sm">Mode
          <select className="mt-1 w-full rounded border px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">—</option><option value="TOUS">Tous modes</option><option value="NORMAL">Normal</option><option value="SAISON_PLUIES">Saison des pluies</option>
          </select>
        </label>
        <label className="text-sm">Niveau
          <select className="mt-1 w-full rounded border px-2 py-1" value={niveau} onChange={(e) => setNiveau(e.target.value)}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-sm">Délai (minutes)
          <input className="mt-1 w-full rounded border px-2 py-1" inputMode="numeric" placeholder="à saisir" value={delai} onChange={(e) => setDelai(e.target.value)} />
        </label>
        <div className="flex items-end"><Button type="submit" disabled={!mode || !niveau || !delaiValide || creer.isPending}>Ajouter</Button></div>
      </form>
    </section>
  );
}

function Astreintes() {
  const client = useQueryClient();
  const [userId, setUserId] = useState("");
  const [niveau, setNiveau] = useState("");
  const [regionId, setRegionId] = useState("");
  const [debut, setDebut] = useState("");
  const [fin, setFin] = useState("");
  const astreintes = useQuery({ queryKey: ["veille", "astreintes"], queryFn: async () => (await api.get<{ astreintes: Astreinte[] }>("/v2/exploitation/veille/astreintes")).data.astreintes });
  const personnes = useQuery({ queryKey: ["veille", "personnes"], queryFn: async () => (await api.get<{ personnes: Personne[] }>("/v2/exploitation/veille/personnes")).data.personnes });
  const regions = useQuery({ queryKey: ["regions"], queryFn: async () => (await api.get<Region[]>("/regions")).data });
  const invalider = () => client.invalidateQueries({ queryKey: ["veille"] });
  const creer = useMutation({
    mutationFn: async () => (await api.post("/v2/exploitation/veille/astreintes", {
      userId, niveau: Number(niveau), regionId: regionId ? Number(regionId) : null,
      debut: new Date(debut).toISOString(), fin: new Date(fin).toISOString(),
    })).data,
    onSuccess: () => { toast.success("Astreinte enregistrée."); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Astreinte refusée.")),
  });
  const retirer = useMutation({
    mutationFn: async (id: string) => (await api.post(`/v2/exploitation/veille/astreintes/${id}/retrait`)).data,
    onSuccess: () => { toast.success("Astreinte retirée."); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Retrait refusé.")),
  });
  const periodeValide = debut && fin && new Date(fin) > new Date(debut);

  return (
    <section className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
      <h2 className="font-semibold">Astreintes en cours et à venir</h2>
      {!astreintes.data?.length ? <p className="text-sm text-amber-800">Aucune astreinte en cours ni à venir.</p> : (
        <ul className="divide-y text-sm">
          {astreintes.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span>Niveau {a.niveau} — {a.user.nomComplet} ({a.region ? a.region.nom : "national"}) du {new Date(a.debut).toLocaleString("fr-FR")} au {new Date(a.fin).toLocaleString("fr-FR")}</span>
              <Button size="sm" variant="ghost" onClick={() => retirer.mutate(a.id)}>Retirer</Button>
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-2 md:grid-cols-6" onSubmit={(e) => { e.preventDefault(); if (userId && niveau && periodeValide) creer.mutate(); }}>
        <label className="text-sm md:col-span-2">Personne
          <select className="mt-1 w-full rounded border px-2 py-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">—</option>
            {personnes.data?.map((p) => <option key={p.id} value={p.id}>{p.nomComplet}</option>)}
          </select>
        </label>
        <label className="text-sm">Niveau
          <select className="mt-1 w-full rounded border px-2 py-1" value={niveau} onChange={(e) => setNiveau(e.target.value)}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-sm">Région
          <select className="mt-1 w-full rounded border px-2 py-1" value={regionId} onChange={(e) => setRegionId(e.target.value)}>
            <option value="">National</option>
            {regions.data?.map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
          </select>
        </label>
        <label className="text-sm">Début
          <input type="datetime-local" className="mt-1 w-full rounded border px-2 py-1" value={debut} onChange={(e) => setDebut(e.target.value)} />
        </label>
        <label className="text-sm">Fin
          <input type="datetime-local" className="mt-1 w-full rounded border px-2 py-1" value={fin} onChange={(e) => setFin(e.target.value)} />
        </label>
        <div className="md:col-span-6"><Button type="submit" disabled={!userId || !niveau || !periodeValide || creer.isPending}>Enregistrer l'astreinte</Button></div>
      </form>
    </section>
  );
}

export function VeilleConfigurationPage() {
  return (
    <div className="space-y-4">
      <Mode />
      <Regles />
      <Astreintes />
    </div>
  );
}
