import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { messageErreur } from "../../lib/exploitation";
import { jourFr } from "../../lib/tableauDeBord";
import {
  LIBELLE_ORIGINE, LIBELLE_STATUT_FICHE, empreinteCourte, formaterGnf,
  type FicheComplete, type FicheCourante, type VerificationFiche,
} from "../../lib/moteurProgrammation";

/** Consultation des fiches d'intervention figees : statut courant, historique en ajout seul, empreinte verifiee. */

const BASE = "/v2/programmation/moteur/fiches";
const STATUTS = ["BROUILLON", "PROPOSE", "ARBITRE", "APPROUVE", "TRANSMIS", "EN_EXECUTION", "ACHEVE", "EVALUE"] as const;

function DetailFiche({ id }: { id: string }) {
  const fiche = useQuery({ queryKey: ["v2", "moteur", "fiche", id], queryFn: async () => (await api.get<FicheComplete>(`${BASE}/${id}`)).data });
  const verif = useQuery({ queryKey: ["v2", "moteur", "fiche", id, "verification"], queryFn: async () => (await api.get<VerificationFiche>(`${BASE}/${id}/verification`)).data });

  if (fiche.isLoading) return <p role="status" className="text-sm text-gray-700">Chargement de la fiche…</p>;
  if (fiche.isError || !fiche.data) return <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">La fiche n'a pas pu être chargée. {messageErreur(fiche.error, "Réessayez dans un instant.")}</p>;
  const { fiche: f, contenu, historique } = fiche.data;
  return (
    <div className="space-y-3 text-sm" data-testid="detail-fiche">
      <h4 className="font-semibold">{f.reference}</h4>
      {contenu.etiquette && <p role="status" className="rounded bg-amber-50 p-2 text-amber-950"><strong>{contenu.etiquette}</strong> : l'étiquette est figée dans la fiche.</p>}
      {contenu.justification && <p className="rounded bg-gray-50 p-2">{contenu.justification}</p>}
      <p>Tronçon {contenu.patrimoine?.code ?? f.tronconCode ?? f.tronconId} · année {f.annee} · paramètres {f.parametresVersion} · figée le {jourFr(f.figeLe)} · montant {formaterGnf(contenu.cout?.montantGnf)}</p>
      <p>
        Empreinte SHA-256 figée : <code className="break-all">{f.empreinteSha256}</code>
        {verif.data && (
          <span data-testid="verdict-fiche" className={verif.data.verdict.ok ? " font-semibold text-green-800" : " font-semibold text-red-800"}>
            {" "}{verif.data.verdict.ok ? "Recalculée à l'identique : le texte stocké est intact." : `ÉCART : ${verif.data.verdict.motif}`}
          </span>
        )}
      </p>
      <table className="w-full text-left text-xs">
        <caption className="text-left font-semibold uppercase text-gray-700">Cycle de vie (ajout seul)</caption>
        <thead className="uppercase text-gray-600"><tr><th scope="col" className="py-1 pr-2">Rang</th><th scope="col" className="pr-2">Passage</th><th scope="col" className="pr-2">Origine</th><th scope="col" className="pr-2">Motif</th><th scope="col">Enregistré le</th></tr></thead>
        <tbody>
          {historique.map((h) => (
            <tr key={h.rang} className="border-t">
              <td className="py-1 pr-2 tabular-nums">{h.rang}</td>
              <td className="pr-2">{h.de ? `${LIBELLE_STATUT_FICHE[h.de] ?? h.de} vers ` : "ouverture à "}{LIBELLE_STATUT_FICHE[h.vers] ?? h.vers}</td>
              <td className="pr-2">{LIBELLE_ORIGINE[h.origine] ?? h.origine}</td><td className="pr-2">{h.motif ?? ""}</td><td>{jourFr(h.enregistreLe)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="text-xs">
        <summary className="cursor-pointer">Contenu figé complet</summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-2">{JSON.stringify(contenu, null, 2)}</pre>
      </details>
    </div>
  );
}

export function FichesFigeesPanel() {
  const idAnnee = useId(); const idStatut = useId();
  const [annee, setAnnee] = useState("");
  const [statut, setStatut] = useState("");
  const [page, setPage] = useState(1);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const anneeNum = annee === "" ? null : Number(annee);
  const anneeOk = anneeNum === null || (Number.isInteger(anneeNum) && anneeNum >= 2000 && anneeNum <= 2100);

  const liste = useQuery({
    queryKey: ["v2", "moteur", "fiches", anneeOk ? anneeNum : null, statut, page],
    queryFn: async () => (await api.get<{ data: FicheCourante[]; total: number; page: number; pageSize: number }>(BASE, {
      params: { page, pageSize: 20, ...(anneeOk && anneeNum !== null ? { annee: anneeNum } : {}), ...(statut ? { statut } : {}) },
    })).data,
  });
  const total = liste.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-700">
        Une fiche figée est immuable : texte canonique et empreinte SHA-256 sont verrouillés par la base. Seul son statut avance, en ajout seul ; les statuts à partir de « Transmise » viennent de DigitalRoad ou d'une inspection et ne se saisissent pas ici.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={idAnnee} className="block text-xs text-gray-700">Année</label>
          <input id={idAnnee} inputMode="numeric" value={annee} onChange={(e) => { setAnnee(e.target.value); setPage(1); }} className="w-24 rounded border px-2 py-1 text-sm tabular-nums" aria-invalid={!anneeOk} />
        </div>
        <div>
          <label htmlFor={idStatut} className="block text-xs text-gray-700">Statut courant</label>
          <select id={idStatut} value={statut} onChange={(e) => { setStatut(e.target.value); setPage(1); }} className="rounded border px-2 py-1 text-sm">
            <option value="">Tous</option>
            {STATUTS.map((s) => <option key={s} value={s}>{LIBELLE_STATUT_FICHE[s]}</option>)}
          </select>
        </div>
      </div>
      {!anneeOk && <p role="alert" className="text-sm text-red-800">L'année doit être un entier entre 2000 et 2100 : le filtre n'est pas appliqué.</p>}
      {liste.isLoading && <p role="status" className="text-sm text-gray-700">Chargement des fiches…</p>}
      {liste.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">Les fiches n'ont pas pu être chargées. {messageErreur(liste.error, "Réessayez dans un instant.")}</p>}
      {liste.data && (liste.data.data.length === 0 ? (
        <p className="text-sm text-gray-700" data-testid="aucune-fiche">Aucune fiche figée{anneeNum !== null || statut ? " pour ce filtre" : " : aucun scénario n'a encore été figé"}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Fiches d'intervention figées</caption>
            <thead className="text-xs uppercase text-gray-600"><tr><th scope="col" className="py-1 pr-2">Référence</th><th scope="col" className="pr-2">Tronçon</th><th scope="col" className="pr-2">Année</th><th scope="col" className="pr-2">Statut</th><th scope="col" className="pr-2">Paramètres</th><th scope="col" className="pr-2">Empreinte</th><th scope="col" className="pr-2">Figée le</th><th scope="col"><span className="sr-only">Détail</span></th></tr></thead>
            <tbody>
              {liste.data.data.map((f) => (
                <tr key={f.id} className="border-t align-top">
                  <td className="py-1 pr-2">{f.reference}</td><td className="pr-2">{f.tronconCode ?? f.tronconId}</td><td className="pr-2 tabular-nums">{f.annee}</td>
                  <td className="pr-2">{LIBELLE_STATUT_FICHE[f.statut] ?? f.statut}</td><td className="pr-2">{f.parametresVersion}</td>
                  <td className="pr-2"><code title={f.empreinteSha256}>{empreinteCourte(f.empreinteSha256)}</code></td><td className="pr-2">{jourFr(f.figeLe)}</td>
                  <td><button type="button" className="rounded border px-2 py-0.5 text-xs" aria-pressed={ouverte === f.id} onClick={() => setOuverte(ouverte === f.id ? null : f.id)}>
                    {ouverte === f.id ? "Masquer" : "Consulter"}<span className="sr-only"> {f.reference}</span></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {total > 20 && (
        <div className="flex items-center gap-2 text-sm">
          <button type="button" className="rounded border px-2 py-0.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>Page précédente</button>
          <span>Page {page} sur {pages} ({total} fiches)</span>
          <button type="button" className="rounded border px-2 py-0.5" disabled={page >= pages} onClick={() => setPage(page + 1)}>Page suivante</button>
        </div>
      )}
      {ouverte && <DetailFiche id={ouverte} />}
    </div>
  );
}
