import { AlertTriangle, CheckCircle2, Scale } from "lucide-react";
import { enMilliardsTexte, formaterPct, formaterSolde, formaterPart, lireDeficit, partDe, type BilanBudgetaire } from "../../../lib/aideDecisionScenarios";
import { formaterGnf } from "../../../lib/moteurProgrammation";

/**
 * Bilan budgetaire d'une simulation : enveloppe, consomme, reste, besoin chiffre, deficit, solde SIGNE.
 *
 * Le deficit est TOUJOURS dit : en alerte quand il est positif (avec son montant), comme un excedent ou une egalite sinon.
 * Il n'est jamais remplace par un « 0 » nu ni masque par un maximum avec zero. S'il manque des couts, il est dit minorant.
 */
export function BilanBudgetaireVue({ bilan }: { bilan: BilanBudgetaire }) {
  const d = lireDeficit(bilan);
  const Icone = d.niveau === "deficit" ? AlertTriangle : d.niveau === "excedent" ? CheckCircle2 : Scale;
  const cases: [string, string, string?][] = [
    ["Enveloppe saisie", formaterGnf(bilan.enveloppeGnf), enMilliardsTexte(bilan.enveloppeGnf)],
    ["Consommé (interventions retenues)", formaterGnf(bilan.consommeGnf), `${formaterPart(partDe(bilan.consommeGnf, bilan.enveloppeGnf))} de l'enveloppe`],
    ["Reste de l'enveloppe", formaterGnf(bilan.resteGnf)],
    ["Besoin chiffré des candidats", formaterGnf(bilan.besoinTotalGnf), `${bilan.nbCoutsFiables} coût(s) fiable(s)`],
    ["Solde (enveloppe moins besoin)", formaterSolde(bilan.soldeGnf), "signé : négatif = déficit"],
    ["Part du besoin couverte", formaterPct(bilan.couvertureBesoinPct)],
  ];
  return (
    <section aria-labelledby="bilan-titre" data-testid="bilan-budgetaire" className="space-y-3">
      <h4 id="bilan-titre" className="text-sm font-semibold text-navy">Bilan budgétaire</h4>
      <div
        role={d.niveau === "deficit" ? "alert" : "status"} data-testid="lecture-deficit" data-niveau={d.niveau}
        className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${d.niveau === "deficit" ? "border-red-300 bg-red-50 text-red-950" : "border-green-300 bg-green-50 text-green-950"}`}
      >
        <Icone aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div><p className="font-semibold">{d.titre}</p><p className="text-xs">{d.detail}</p></div>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {cases.map(([k, v, aide]) => (
          <div key={k}>
            <dt className="text-xs text-gray-700">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
            {aide && <dd className="text-xs text-gray-700">{aide}</dd>}
          </div>
        ))}
      </dl>
      {bilan.besoinObligatoiresGnf !== "0" && (
        <p className="text-xs text-gray-800">
          Interventions obligatoires : besoin {formaterGnf(bilan.besoinObligatoiresGnf)}
          {bilan.deficitObligatoiresGnf !== "0" ? `, soit un déficit de ${formaterGnf(bilan.deficitObligatoiresGnf)} sur les seules obligatoires.` : "."}
        </p>
      )}
    </section>
  );
}
