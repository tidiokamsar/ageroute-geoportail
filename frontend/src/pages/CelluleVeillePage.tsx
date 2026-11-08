import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CloudRain, Maximize2, Minimize2, Radio, ShieldAlert, UserX } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";

/**
 * Cellule de veille (paragraphe 7.17, EX-04) : la vue murale et mobile.
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **Sans règle, rien ne monte.** Aucun délai d'escalade n'est semé : c'est une décision
 * d'organisation. Tant qu'AGEROUTE n'en a saisi aucune, l'écran l'affiche en tête, au lieu de
 * laisser croire qu'un événement oublié finira par alerter quelqu'un.
 *
 * **Un trou de permanence se voit.** Une escalade sans personne d'astreinte au niveau voulu est
 * inscrite sans destinataire ; elle est montrée en rouge, pas masquée.
 *
 * **Aucune notification n'est envoyée.** L'escalade est inscrite et affichée ; ni courriel ni SMS.
 *
 * **L'écran évalue les escalades à chaque rafraîchissement** (toutes les 30 s) : le serveur n'a pas
 * d'ordonnanceur. L'évaluation est idempotente, deux écrans ouverts n'inscrivent rien deux fois.
 */

interface Personne { id: string; nomComplet: string }
interface Evenement {
  evenementId: string;
  typeCode: string;
  statut: "OUVERT" | "PRIS_EN_COMPTE" | "EN_COURS";
  ouvertLe: string;
  texte: string;
  tronconCode: string | null;
  ageMinutes: number;
  escalade: { niveau: number; declencheeLe: string; destinataire: Personne | null; sansDestinataire: boolean } | null;
}
interface Echeance { statut: string; prochaine: string | null; joursRetard: number }
export interface Tableau {
  genereLe: string;
  mode: { mode: "NORMAL" | "SAISON_PLUIES"; declare: boolean; motif: string | null; declareLe: string | null; declarePar: Personne | null };
  evenements: Evenement[];
  astreintes: { id: string; niveau: number; debut: string; fin: string; user: Personne; region: { id: number; nom: string } | null }[];
  regles: { actives: number; incoherences: string[]; aucuneRegle: boolean };
  infoRouteEnCours: number;
  signalementsNouveaux: number;
  /** Propositions de teledetection a verifier : des propositions, jamais des faits. */
  alertesSatelliteAVerifier?: number;
  patrouilles: { id: string; code: string; libelle: string; echeance: Echeance }[];
}

const LIBELLE_STATUT: Record<Evenement["statut"], string> = {
  OUVERT: "Ouvert — non pris en compte",
  PRIS_EN_COMPTE: "Pris en compte",
  EN_COURS: "En cours",
};

export function duree(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} h ${String(minutes % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

async function chargerTableau(): Promise<Tableau> {
  // L'évaluation d'abord : le tableau montre alors les escalades qu'elle vient d'inscrire. Un
  // échec de l'évaluation n'empêche pas d'afficher le tableau.
  try { await api.post("/v2/exploitation/veille/escalades/evaluer"); } catch { /* le tableau reste lisible */ }
  return (await api.get<Tableau>("/v2/exploitation/veille/tableau")).data;
}

function Compteur({ libelle, valeur, alerte }: { libelle: string; valeur: number; alerte?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${alerte && valeur > 0 ? "border-red-300 bg-red-50" : "border-gray-200 bg-white"}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{libelle}</div>
      <div className={`text-3xl font-semibold ${alerte && valeur > 0 ? "text-red-700" : "text-navy"}`}>{valeur}</div>
    </div>
  );
}

export function CelluleVeillePage() {
  const [mural, setMural] = useState(false);
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["veille", "tableau"],
    queryFn: chargerTableau,
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="p-6 text-gray-500">Chargement de la cellule de veille…</div>;
  if (isError || !data) return <div className="p-6 text-red-700">La cellule de veille n'a pas pu être chargée.</div>;

  const ouverts = data.evenements.filter((e) => e.statut === "OUVERT");
  const trous = data.evenements.filter((e) => e.escalade?.sansDestinataire);

  return (
    <div className={mural ? "fixed inset-0 z-50 overflow-auto bg-slate-50 p-6 text-lg" : "space-y-4"} data-testid="cellule-veille">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {data.mode.mode === "SAISON_PLUIES" ? (
            <span className="inline-flex items-center gap-2 rounded bg-sky-700 px-3 py-1 font-semibold text-white">
              <CloudRain className="h-5 w-5" /> SAISON DES PLUIES
            </span>
          ) : (
            <span className="rounded bg-gray-200 px-3 py-1 font-semibold text-gray-800">
              Mode normal{data.mode.declare ? "" : " (aucun mode déclaré)"}
            </span>
          )}
          {data.mode.declare && data.mode.declarePar && (
            <span className="text-sm text-gray-600">
              déclaré par {data.mode.declarePar.nomComplet}{data.mode.motif ? ` — ${data.mode.motif}` : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>Mis à jour à {new Date(dataUpdatedAt).toLocaleTimeString("fr-FR")}</span>
          {!mural && <Link className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-primary hover:bg-muted" to="/exploitation/main-courante">Main courante</Link>}
          <Button variant="secondary" onClick={() => setMural((m) => !m)}>
            {mural ? <><Minimize2 className="h-4 w-4" /> Quitter le mode mural</> : <><Maximize2 className="h-4 w-4" /> Mode mural</>}
          </Button>
        </div>
      </div>

      {data.regles.aucuneRegle && (
        <div role="alert" className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span><strong>Aucune règle d'escalade n'est saisie.</strong> Aucun événement ne montera, quel que soit son âge. Les délais sont à fixer par AGEROUTE.</span>
        </div>
      )}
      {data.regles.incoherences.map((i) => (
        <div key={i} role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">Règles incohérentes : {i}</div>
      ))}
      {trous.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-red-800">
          <UserX className="mt-0.5 h-5 w-5 shrink-0" />
          <span><strong>Trou de permanence :</strong> {trous.length} escalade(s) sans personne d'astreinte au niveau voulu.</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Compteur libelle="Non pris en compte" valeur={ouverts.length} alerte />
        <Compteur libelle="Événements actifs" valeur={data.evenements.length} />
        <Compteur libelle="Info Route en cours" valeur={data.infoRouteEnCours} />
        <Compteur libelle="Signalements nouveaux" valeur={data.signalementsNouveaux} alerte />
        <Compteur libelle="Patrouilles à faire" valeur={data.patrouilles.length} alerte />
        <Compteur libelle="Alertes satellite à vérifier" valeur={data.alertesSatelliteAVerifier ?? 0} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-lg border border-gray-200 bg-white">
          <h2 className="flex items-center gap-2 border-b px-3 py-2 font-semibold"><ShieldAlert className="h-4 w-4" /> Événements actifs</h2>
          {data.evenements.length === 0 ? (
            <p className="p-3 text-gray-500">Aucun événement actif dans la main courante.{!mural && <> <Link className="underline" to="/exploitation/main-courante">Déclarer un événement</Link>.</>}</p>
          ) : (
            <ul className="divide-y">
              {data.evenements.map((e) => (
                <li key={e.evenementId} className={`p-3 ${e.statut === "OUVERT" ? "bg-red-50/40" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{e.typeCode}{e.tronconCode ? ` — ${e.tronconCode}` : ""}</span>
                    <span className="flex items-center gap-2 text-sm text-gray-600">
                      depuis {duree(e.ageMinutes)}
                      {!mural && <Link className="text-xs underline" to={`/exploitation/main-courante?evenement=${encodeURIComponent(e.evenementId)}`} aria-label={`Ouvrir le journal de l'événement ${e.typeCode}`}>Journal</Link>}
                    </span>
                  </div>
                  <div className="text-sm text-gray-700">{e.texte}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs">
                    <span className={`rounded px-2 py-0.5 ${e.statut === "OUVERT" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-700"}`}>{LIBELLE_STATUT[e.statut]}</span>
                    {e.escalade && (
                      <span className={`rounded px-2 py-0.5 ${e.escalade.sansDestinataire ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"}`}>
                        Escalade niveau {e.escalade.niveau} — {e.escalade.destinataire ? e.escalade.destinataire.nomComplet : "PERSONNE D'ASTREINTE"}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-4">
          <section className="rounded-lg border border-gray-200 bg-white">
            <h2 className="flex items-center gap-2 border-b px-3 py-2 font-semibold"><Radio className="h-4 w-4" /> Astreintes en cours</h2>
            {data.astreintes.length === 0 ? (
              <p className="p-3 text-red-700">Personne n'est d'astreinte en ce moment.</p>
            ) : (
              <ul className="divide-y text-sm">
                {data.astreintes.map((a) => (
                  <li key={a.id} className="p-2">
                    <span className="font-medium">Niveau {a.niveau}</span> — {a.user.nomComplet}
                    <span className="text-gray-500"> ({a.region ? a.region.nom : "national"}, jusqu'à {new Date(a.fin).toLocaleString("fr-FR")})</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b px-3 py-2 font-semibold">Patrouilles à faire</h2>
            {data.patrouilles.length === 0 ? (
              <p className="p-3 text-gray-500">Aucune patrouille due.</p>
            ) : (
              <ul className="divide-y text-sm">
                {data.patrouilles.map((p) => (
                  <li key={p.id} className="p-2">
                    <span className="font-medium">{p.code}</span> — {p.libelle}
                    <span className={p.echeance.statut === "EN_RETARD" ? " text-red-700" : " text-gray-600"}>
                      {p.echeance.statut === "EN_RETARD" ? ` en retard de ${p.echeance.joursRetard} j`
                        : p.echeance.statut === "JAMAIS_REALISE" ? " jamais réalisée" : " due aujourd'hui"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <p className="text-xs text-gray-500">Aucune notification n'est envoyée par cet écran : les escalades sont inscrites et affichées.</p>
    </div>
  );
}
