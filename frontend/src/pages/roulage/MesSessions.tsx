import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { messageErreur } from "../../lib/exploitation";
import { libelleDuree, libelleKm } from "../../lib/releve";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";

/**
 * Sessions de roulage déjà envoyées (GET /api/v2/roulage/mes-sessions) : liste et analyse de chacune.
 * Lecture seule. Chargée à la demande : sur la route, l'écran d'enregistrement ne doit dépendre
 * d'aucun appel réseau.
 */

interface Mission { id: string; code: string; intitule: string }
interface Resume { id: string; debutA: string; finA: string; nbPoints: number; tauxRattachement: number | null; mission: Mission | null }
interface Detail extends Resume {
  trous: unknown[]; interruptions: unknown[]; pauses: unknown[];
  analyse: { indicateurs?: Record<string, number | null>; avertissements?: string[] } | null;
}

const LIBELLES: Record<string, string> = {
  pointsRecus: "Points reçus", pointsRetenus: "Points retenus", pointsRattaches: "Points rattachés au réseau",
  segments: "Segments", segmentsAnalyses: "Segments analysés", segmentsIgnores: "Segments ignorés",
  passages: "Passages sur tronçon", horsReferentiel: "Parties hors référentiel", transitionsNonVerifiees: "Changements de tronçon non vérifiés",
};
const pct = (t: number | null | undefined) => (t == null ? "—" : `${Math.round(t * 1000) / 10} %`);
const dureeS = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
const longueur = (v: unknown[] | null | undefined) => (Array.isArray(v) ? v.length : 0);

function FicheSession({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ["roulage", "session", id], queryFn: async () => (await api.get<Detail>(`/v2/roulage/mes-sessions/${id}`)).data });
  const s = d.data;
  const ind = s?.analyse?.indicateurs ?? {};
  return (
    <Modal open onClose={onClose} title="Session de roulage">
      {d.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : d.isError || !s ? <p className="text-sm text-red-700">{messageErreur(d.error, "Session introuvable.")}</p>
        : (
          <div className="space-y-3 text-sm">
            <p>{new Date(s.debutA).toLocaleString("fr-FR")} · {libelleDuree(dureeS(s.debutA, s.finA))}{s.mission ? ` · mission ${s.mission.code}` : " · sans mission"}</p>
            <p>Distance parcourue : {typeof ind.distanceParcourueM === "number" ? libelleKm(ind.distanceParcourueM) : "—"} · rattachement {pct(s.tauxRattachement)}</p>
            <table className="w-full text-xs">
              <caption className="sr-only">Indicateurs de la session</caption>
              <tbody>
                {Object.entries(LIBELLES).filter(([k]) => ind[k] != null).map(([k, l]) => <tr key={k} className="border-t"><th scope="row" className="py-0.5 text-left font-normal text-gray-600">{l}</th><td>{ind[k]}</td></tr>)}
                <tr className="border-t"><th scope="row" className="py-0.5 text-left font-normal text-gray-600">Trous de signal</th><td>{longueur(s.trous)}</td></tr>
                <tr className="border-t"><th scope="row" className="py-0.5 text-left font-normal text-gray-600">Interruptions</th><td>{longueur(s.interruptions)}</td></tr>
                <tr className="border-t"><th scope="row" className="py-0.5 text-left font-normal text-gray-600">Pauses</th><td>{longueur(s.pauses)}</td></tr>
              </tbody>
            </table>
            {!!s.analyse?.avertissements?.length && (
              <ul className="list-disc pl-5 text-xs text-amber-900">{s.analyse.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
            )}
          </div>
        )}
    </Modal>
  );
}

export function MesSessions() {
  const [ouvert, setOuvert] = useState(false);
  const [fiche, setFiche] = useState<string | null>(null);
  const liste = useQuery({
    queryKey: ["roulage", "sessions"],
    enabled: ouvert,
    queryFn: async () => (await api.get<{ sessions: Resume[] }>("/v2/roulage/mes-sessions", { params: { limite: 50 } })).data.sessions,
  });
  return (
    <section aria-labelledby="titre-mes-sessions" className="space-y-2">
      <h2 id="titre-mes-sessions" className="font-semibold">Mes sessions envoyées</h2>
      {!ouvert ? <Button size="sm" variant="outline" onClick={() => setOuvert(true)}>Afficher mes sessions envoyées</Button>
        : liste.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : liste.isError ? <p className="text-sm text-red-700">{messageErreur(liste.error, "Sessions indisponibles (réseau ?).")}</p>
        : (liste.data ?? []).length === 0 ? <p className="text-sm text-gray-600">Aucune session envoyée.</p>
        : (
          <table className="w-full text-sm">
            <caption className="sr-only">Sessions de roulage envoyées</caption>
            <thead><tr className="text-left text-gray-600"><th>Début</th><th>Durée</th><th>Points</th><th>Rattachement</th><th>Mission</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {(liste.data ?? []).map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="whitespace-nowrap">{new Date(s.debutA).toLocaleString("fr-FR")}</td>
                  <td>{libelleDuree(dureeS(s.debutA, s.finA))}</td>
                  <td>{s.nbPoints}</td>
                  <td>{pct(s.tauxRattachement)}</td>
                  <td>{s.mission?.code ?? "—"}</td>
                  <td><Button size="sm" variant="outline" onClick={() => setFiche(s.id)}>Analyse</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {fiche && <FicheSession id={fiche} onClose={() => setFiche(null)} />}
    </section>
  );
}
