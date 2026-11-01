import { enMilliards, formaterGnf, type AlertePraticabilite, type DiagnosticVide, type StatutPraticabilite } from "../../lib/moteurProgrammation";

/**
 * Bandeaux d'honnetete de l'ecran du moteur : l'etiquette PROVISOIRE, la praticabilite (D-02) et l'explication d'un
 * resultat vide. Un bandeau dit ce que le moteur ne sait pas ; il n'est pas decoratif.
 */

export function BandeauProvisoire({ etiquette, motifs, detail }: { etiquette: string; motifs?: string[]; detail?: string }) {
  return (
    <div role="status" data-testid="bandeau-provisoire" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p><strong>{etiquette}.</strong> {detail ?? "Aucun résultat n'est officiel tant que les paramètres du moteur ne sont pas approuvés : leurs valeurs n'ont pas de source arrêtée."}</p>
      {motifs && motifs.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {motifs.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
    </div>
  );
}

export function BandeauPraticabilite({ statut }: { statut: StatutPraticabilite | undefined }) {
  if (!statut) return null;
  return (
    <div role="note" data-testid="bandeau-praticabilite" className={`rounded-lg border p-3 text-sm ${statut.branchee ? "border-sky-300 bg-sky-50 text-sky-950" : "border-gray-300 bg-gray-50 text-gray-900"}`}>
      <p><strong>Praticabilité : {statut.libelle}.</strong> {statut.motif}.</p>
      <p className="text-xs">{statut.effet}</p>
    </div>
  );
}

export function AlertesPraticabilite({ alertes }: { alertes: AlertePraticabilite[] }) {
  if (alertes.length === 0) return null;
  return (
    <div className="overflow-x-auto" data-testid="alertes-praticabilite">
      <table className="w-full text-left text-sm">
        <caption className="text-left text-xs font-semibold uppercase text-gray-700">Lignes retenues dont une portion courante validée porte un niveau approuvé non franchissable</caption>
        <thead className="text-xs uppercase text-gray-600"><tr><th scope="col" className="py-1 pr-2">Tronçon</th><th scope="col" className="pr-2">Niveau</th><th scope="col" className="pr-2">Emprise</th><th scope="col">Saisonnier</th></tr></thead>
        <tbody>
          {alertes.map((a, i) => (
            <tr key={`${a.tronconId}-${i}`} className="border-t">
              <td className="py-1 pr-2">{a.tronconId}</td><td className="pr-2">{a.code} ({a.libelle})</td><td className="pr-2">{a.debutM} m à {a.finM} m</td><td>{a.saisonniere ? "oui" : "non"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Un resultat sans ligne retenue ne se lit jamais comme une liste vide muette : il dit pourquoi. */
export function ResultatVide({ diagnostic }: { diagnostic: DiagnosticVide }) {
  if (!diagnostic.vide) return null;
  return (
    <div role="alert" data-testid="resultat-vide" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-950">
      <p><strong>Aucune intervention retenue.</strong> {diagnostic.phrase}</p>
      {diagnostic.parMotif.length > 0 && (
        <ul className="list-disc pl-5 text-xs">
          {diagnostic.parMotif.map((m) => <li key={m.code}>{m.libelle} : {m.nb}</li>)}
        </ul>
      )}
      {diagnostic.facteurs && (
        <div>
          <p className="text-xs">
            Facteurs absents (aucun poids n'est inventé pour les remplacer) :
          </p>
          <ul className="list-disc pl-5 text-xs">
            {diagnostic.facteurs.absents.map((f) => <li key={f.facteur}>{f.libelle} : absent sur {f.troncons} tronçon(s) ({f.note})</li>)}
          </ul>
          <p className="mt-1 text-xs">
            Pour que le moteur calcule, il faut renseigner ces facteurs, ou baisser le minimum de facteurs dans les paramètres : un acte de paramétrage visible et audité, jamais fait ici.
          </p>
        </div>
      )}
    </div>
  );
}

export function TotauxScenario({ candidats, eligibles, retenues, ecartees, engageGnf, resteGnf, budgetGnf }: {
  candidats: number; eligibles: number; retenues: number; ecartees: number; engageGnf: string; resteGnf: string; budgetGnf: string;
}) {
  const cases: [string, string][] = [
    ["Enveloppe saisie", `${formaterGnf(budgetGnf)} (${enMilliards(budgetGnf)})`],
    ["Tronçons candidats", String(candidats)], ["Chiffrables et classés", String(eligibles)], ["Retenues", String(retenues)], ["Écartées", String(ecartees)],
    ["Montant engagé", formaterGnf(engageGnf)], ["Reste de l'enveloppe", formaterGnf(resteGnf)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
      {cases.map(([k, v]) => (<div key={k}><dt className="text-xs text-gray-600">{k}</dt><dd className="font-medium tabular-nums">{v}</dd></div>))}
    </dl>
  );
}
