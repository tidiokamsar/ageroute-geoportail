import { AlertTriangle } from "lucide-react";
import {
  LIBELLES, AIDE_QUALITE_LIEN, formaterDate, formaterPourcent, libelleCodeControle, libelleQualiteLien, libelleRetard,
  type MarcheVue, type QualiteLien,
} from "../../../lib/aideDecisionContractuel";
import { MontantEtiquete } from "./MontantEtiquete";

/**
 * Tableau des marches recenses. Quatre colonnes de montants SEPARES (contractuel, engage, decaisse, previsionnel), deux
 * avancements SEPARES (declare, constate) plus le financier declare, la qualite des liens et les anomalies. Un en-tete par colonne
 * (`scope="col"`), l'intitule en en-tete de ligne (`scope="row"`), un nom accessible UNIQUE par bouton (le debut de l'identifiant
 * departage deux marches de meme intitule). Defilement horizontal dans une region focalisable : la page ne defile jamais en largeur.
 */

const PILULE_STATUT: Record<MarcheVue["statut"]["code"], string> = {
  PLANIFIE: "bg-slate-100 text-slate-900",
  EN_COURS: "bg-blue-100 text-blue-900",
  SUSPENDU: "bg-amber-100 text-amber-900",
  TERMINE: "bg-green-100 text-green-900",
  SOLDE: "bg-purple-100 text-purple-900",
};

function PastilleLien({ qualite, libelle }: { qualite: QualiteLien; libelle: string }) {
  const alerte = qualite === "MANQUANT" || qualite === "AMBIGU";
  return (
    <span title={AIDE_QUALITE_LIEN[qualite]} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${alerte ? "bg-amber-100 text-amber-900" : "bg-gray-100 text-gray-900"}`}>
      {alerte && <AlertTriangle aria-hidden="true" className="h-3 w-3" />}
      {libelle} : {libelleQualiteLien(qualite)}
    </span>
  );
}

export function TableauMarches({ marches, total, idSelectionne, onOuvrir }: {
  marches: MarcheVue[]; total: number; idSelectionne: string | null; onOuvrir: (id: string) => void;
}) {
  return (
    // Une region qui defile doit etre atteignable au clavier (axe : scrollable-region-focusable).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="overflow-x-auto rounded-md border border-gray-200" role="region" aria-label="Tableau des marchés recensés, défilement horizontal" tabIndex={0}>
      <table className="w-full min-w-[1280px] border-collapse text-sm">
        <caption className="p-2 text-left text-xs font-medium text-gray-700">
          Marchés recensés dans la copie gelée : {marches.length} affiché(s) sur {total}. Contractuel, engagé, décaissé et prévisionnel sont quatre grandeurs distinctes ; l&apos;avancement déclaré n&apos;est pas un avancement constaté.
        </caption>
        <thead className="bg-gray-50 text-left text-xs text-gray-800">
          <tr>
            {["Marché et référence", "Bailleur", "Entreprise (chantiers liés)", "Statut saisi", "Dates contractuelles", LIBELLES.contractuel, LIBELLES.engage, LIBELLES.decaisse, LIBELLES.previsionnel, "Avancement", "Retard", "Liens chantier et tronçon", "Anomalies"].map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap px-2 py-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {marches.map((m) => {
            const ouvert = m.id === idSelectionne;
            return (
              <tr key={m.id} data-marche-id={m.id} className={`border-t border-gray-100 align-top ${ouvert ? "bg-blue-50" : ""}`}>
                <th scope="row" className="max-w-[240px] px-2 py-2 text-left font-normal">
                  <button type="button" aria-controls="panneau-marche" aria-expanded={ouvert}
                    aria-label={`Ouvrir la fiche du marché ${m.intitule} (${m.id.slice(0, 8)})`}
                    onClick={() => onOuvrir(m.id)}
                    className="min-h-[44px] w-full text-left font-semibold text-navy underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 xl:min-h-0">
                    {m.intitule}
                  </button>
                  <span className="block text-xs text-gray-700">
                    {m.reference.valeur ? `Réf. ${m.reference.valeur.join(", ")}` : "Référence non disponible"}
                  </span>
                </th>
                <td className="px-2 py-2">{m.bailleur.nom ?? <span className="text-gray-600">Non renseigné</span>}</td>
                <td className="px-2 py-2">{m.entreprises.valeur ? m.entreprises.valeur.join(", ") : <span className="text-gray-600">Non disponible</span>}</td>
                <td className="px-2 py-2">
                  <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${PILULE_STATUT[m.statut.code]}`}>{m.statut.libelle}</span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-xs">
                  <span className="block">Début prévu : {formaterDate(m.dates.debutPrevu)}</span>
                  <span className="block">Fin prévue : {formaterDate(m.dates.finPrevue)}</span>
                  <span className="block text-gray-700">Avenants : non disponibles</span>
                </td>
                <td className="px-2 py-2"><MontantEtiquete montant={m.montants.contractuel} compact /></td>
                <td className="px-2 py-2"><MontantEtiquete montant={m.montants.engage} compact /></td>
                <td className="px-2 py-2"><MontantEtiquete montant={m.montants.decaisse} compact /></td>
                <td className="px-2 py-2"><MontantEtiquete montant={m.montants.previsionnel} compact /></td>
                <td className="whitespace-nowrap px-2 py-2 text-xs">
                  <span className="block">{LIBELLES.declare} : {m.avancement.declare.etat === "DISPONIBLE" ? formaterPourcent(m.avancement.declare.physiqueReelPct) : "non disponible"}</span>
                  <span className="block">{LIBELLES.constate} : non disponible</span>
                  <span className="block text-gray-700">Financier déclaré : {m.avancement.financier.etat === "DISPONIBLE" ? formaterPourcent(m.avancement.financier.reelPct) : "non disponible"}</span>
                </td>
                <td className="px-2 py-2 text-xs">
                  <span className={`block font-medium ${m.retard.etat === "EN_RETARD" ? "text-red-800" : "text-gray-900"}`}>{libelleRetard(m.retard.etat)}</span>
                  {m.retard.joursRetardCalendaire !== null && <span className="block">{m.retard.joursRetardCalendaire} jour(s) après la fin prévue</span>}
                  {m.retard.ecartPhysiquePoints !== null && m.retard.gravite && <span className="block">Écart physique {m.retard.ecartPhysiquePoints} points</span>}
                </td>
                <td className="space-y-1 px-2 py-2">
                  <PastilleLien qualite={m.liens.chantiers.qualite} libelle={`Chantiers (${m.liens.chantiers.total})`} />
                  <br />
                  <PastilleLien qualite={m.liens.troncons.qualite} libelle={`Tronçons (${m.liens.troncons.total})`} />
                </td>
                <td className="px-2 py-2 text-xs">
                  {m.anomalies.length === 0 ? <span className="text-gray-700">Aucune détectée</span> : (
                    <ul className="list-disc pl-4">{m.anomalies.map((a) => <li key={a}>{libelleCodeControle(a)}</li>)}</ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
