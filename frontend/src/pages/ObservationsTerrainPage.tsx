import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Crosshair } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Input";
import { toast } from "../lib/toast";
import { useAuth } from "../lib/auth";
import { usePositionGps } from "../hooks/usePositionGps";
import { useOfflineSync } from "../hooks/useOfflineSync";
import { getAllPendingObservations, GRAVITES_OBSERVATION, TYPES_OBSERVATION, type PendingObservation } from "../lib/offlineDb";
import { relancerObservation, syncPendingOfflineData } from "../lib/offlineSync";
import {
  LIBELLES_GRAVITE, LIBELLES_TYPE, enregistrerObservation, libelleStatutObservation,
} from "../lib/observationsTerrain";

/**
 * Observations terrain : saisir sur place, remonter quand le réseau revient.
 *
 * CE QUE CET ÉCRAN GARANTIT
 *
 * La saisie est conservée sur le téléphone AVANT tout envoi. Une observation ne quitte la liste que sur la
 * confirmation du serveur ; un refus, un conflit ou une panne la laissent ici, avec son statut et sa raison.
 *
 * CE QU'IL DIT, ET QUI NE VA PAS DE SOI
 *
 * **Un conflit n'est pas une panne.** Le serveur porte déjà une version différente de cette saisie : un
 * responsable doit trancher, et réessayer ne change rien. L'écran l'écrit en haut de page, en rouge, au lieu
 * de laisser croire que « ça partira tout seul ».
 *
 * **Tout est une proposition.** Une observation de terrain n'est pas une donnée officielle.
 */

function heure(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export function ObservationsTerrainPage() {
  const { user } = useAuth();
  const { pendingCount, conflitCount, abandonCount, syncing, online } = useOfflineSync();
  const gps = usePositionGps();

  const [type, setType] = useState("");
  const [gravite, setGravite] = useState("");
  const [description, setDescription] = useState("");
  const [erreurs, setErreurs] = useState<string[]>([]);
  const [enCours, setEnCours] = useState(false);
  const [file, setFile] = useState<PendingObservation[]>([]);

  const charger = useCallback(async () => {
    const toutes = await getAllPendingObservations();
    setFile(
      toutes
        .filter((o) => o.ownerUserId === user?.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }, [user?.id]);

  // Le magasin change hors de React (synchronisation, autre onglet) : les compteurs du store en sont le signal.
  useEffect(() => { void charger(); }, [charger, pendingCount, conflitCount, abandonCount, syncing]);

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setEnCours(true);
    try {
      const r = await enregistrerObservation(
        {
          type, gravite: gravite || undefined, description,
          lat: gps.position?.lat ?? null, lon: gps.position?.lon ?? null, precisionM: gps.position?.precisionM ?? null,
        },
        user.id,
      );
      if (!r.ok) {
        setErreurs(r.erreurs);
        return;
      }
      setErreurs([]);
      setType(""); setGravite(""); setDescription("");
      toast.success("Observation conservée sur ce téléphone. Elle partira dès que le réseau le permet.");
      await charger();
    } catch {
      // Le stockage local a refuse (espace, mode prive) : la saisie N'EST PAS conservee, il faut le dire.
      setErreurs(["La saisie n'a pas pu être conservée sur ce téléphone (stockage refusé). Ne quittez pas l'écran : notez-la autrement."]);
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="space-y-4 pb-24">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Tout ce qui est saisi ici est une proposition.</strong> Une observation n'est pas une donnée
        officielle tant qu'un responsable ne l'a pas retenue.
      </div>

      {conflitCount > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <strong>{conflitCount} saisie(s) en conflit de synchronisation.</strong> Le serveur porte déjà une
            version différente : un responsable doit trancher. Vos saisies sont conservées sur ce téléphone,
            réessayer n'y change rien.
          </span>
        </div>
      )}

      {abandonCount > 0 && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>{abandonCount} saisie(s) n'est plus retentée automatiquement</strong> (refus du serveur ou
          échecs répétés). Elle reste dans la liste ci-dessous, avec le motif.
        </div>
      )}

      <form onSubmit={enregistrer} noValidate className="space-y-3 rounded-lg border bg-white p-4" aria-label="Nouvelle observation">
        <h2 className="font-semibold">Nouvelle observation</h2>

        <div>
          <label htmlFor="obs-type" className="mb-1 block text-sm font-medium">Type</label>
          <Select id="obs-type" value={type} onChange={(e) => setType(e.target.value)} required>
            <option value="">Choisir…</option>
            {TYPES_OBSERVATION.map((t) => <option key={t} value={t}>{LIBELLES_TYPE[t]}</option>)}
          </Select>
        </div>

        <div>
          <label htmlFor="obs-gravite" className="mb-1 block text-sm font-medium">Gravité (facultative)</label>
          <Select id="obs-gravite" value={gravite} onChange={(e) => setGravite(e.target.value)}>
            <option value="">Non précisée</option>
            {GRAVITES_OBSERVATION.map((g) => <option key={g} value={g}>{LIBELLES_GRAVITE[g]}</option>)}
          </Select>
        </div>

        <div>
          <label htmlFor="obs-description" className="mb-1 block text-sm font-medium">Description</label>
          <textarea
            id="obs-description"
            className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm md:text-sm"
            value={description}
            maxLength={5000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <fieldset className="rounded border p-3">
          <legend className="flex items-center gap-1 px-1 text-sm font-medium"><Crosshair className="h-4 w-4" aria-hidden="true" /> Position</legend>
          {gps.position ? (
            <p className="text-sm">
              {gps.position.lat.toFixed(6)}, {gps.position.lon.toFixed(6)} (précision {gps.position.precisionM} m)
            </p>
          ) : (
            <p className="text-sm text-slate-600">Aucune position jointe.</p>
          )}
          {gps.erreur === "REFUSEE" && <p className="mt-1 text-sm text-red-700">Autorisation refusée : rouvrez-la dans les réglages du navigateur.</p>}
          {gps.erreur === "INDISPONIBLE" && <p className="mt-1 text-sm text-red-700">Cet appareil n'a pas de géolocalisation.</p>}
          {gps.erreur === "INDETERMINEE" && <p className="mt-1 text-sm text-red-700">Signal introuvable : sortez à découvert.</p>}
          <div className="mt-2">
            {gps.actif
              ? <Button type="button" variant="outline" onClick={gps.arreter}>Arrêter le suivi</Button>
              : <Button type="button" variant="outline" onClick={gps.demarrer}>Me localiser</Button>}
          </div>
        </fieldset>

        {erreurs.length > 0 && (
          // Le role `alert` va sur un conteneur, pas sur la liste : il retirerait sa semantique de liste
          // aux elements (axe : listitem).
          <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <ul className="list-disc space-y-1 pl-4">
              {erreurs.map((m) => <li key={m}>{m}</li>)}
            </ul>
          </div>
        )}

        <Button type="submit" disabled={enCours}>Enregistrer sur ce téléphone</Button>
      </form>

      <section aria-labelledby="obs-file-titre" className="space-y-2 rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="obs-file-titre" className="font-semibold">Saisies sur ce téléphone ({file.length})</h2>
          <Button type="button" variant="outline" onClick={() => void syncPendingOfflineData()} disabled={syncing || !online || pendingCount === 0}>
            {syncing ? "Envoi en cours…" : "Envoyer maintenant"}
          </Button>
        </div>
        {!online && <p className="text-sm text-amber-800">Hors ligne : les saisies partiront au retour du réseau.</p>}

        {file.length === 0 && <p className="text-sm text-slate-600">Aucune observation en attente sur ce téléphone.</p>}

        <ul className="space-y-2">
          {file.map((o) => {
            const s = libelleStatutObservation(o);
            return (
              <li key={o.localId} className="rounded border p-3 text-sm" data-statut={o.status}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{LIBELLES_TYPE[o.payload.type]}</span>
                  <span
                    className={
                      o.status === "conflit" ? "rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
                        : o.status === "abandonnee" ? "rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
                        : "rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700"
                    }
                  >
                    {s.libelle}
                  </span>
                </div>
                <p className="text-slate-500">Constatée le {heure(o.payload.observeA)}</p>
                {o.payload.description && <p className="mt-1">{o.payload.description}</p>}
                <p className="mt-1 text-slate-700">{s.action}</p>
                {o.errorMessage && <p className="mt-1 text-red-800">{o.errorMessage}</p>}
                {o.status === "conflit" && o.conflitId && (
                  <p className="mt-1 text-xs text-slate-500">Conflit n° <span className="font-mono">{o.conflitId}</span></p>
                )}
                {o.status === "abandonnee" && (
                  <div className="mt-2">
                    <Button
                      type="button" size="sm" variant="outline"
                      onClick={async () => { await relancerObservation(o); await charger(); void syncPendingOfflineData(); }}
                    >
                      Relancer l'envoi
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
