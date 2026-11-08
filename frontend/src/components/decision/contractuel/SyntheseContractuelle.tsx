import type { ReactNode } from "react";
import {
  LIBELLES, STATUTS_MARCHE, formaterMontantOrigine, libelleStatutMarche, phraseRetard, type MontantVue, type SyntheseVue,
} from "../../../lib/aideDecisionContractuel";
import { MontantEtiquete } from "./MontantEtiquete";

/**
 * Synthese du perimetre et des filtres : marches RECENSES (jamais « actifs »), quatre montants separes, retards, contractuel par
 * bailleur. Chaque carte dit ce qu'elle compte ; un montant sans valeur dit pourquoi. Aucun total n'est calcule ici.
 */

function Carte({ libelle, children, note }: { libelle: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <dt className="text-xs font-medium text-gray-700">{libelle}</dt>
      <dd className="mt-1 break-words text-base font-bold leading-tight text-navy">{children}</dd>
      {note && <dd className="mt-1 text-xs text-gray-700">{note}</dd>}
    </div>
  );
}

function noteMontant(m: MontantVue): ReactNode {
  return m.avertissement;
}

export function SyntheseContractuelle({ synthese }: { synthese: SyntheseVue }) {
  const f = synthese.financier;
  const statuts = STATUTS_MARCHE.map((s) => `${libelleStatutMarche(s)} ${synthese.parStatut[s]}`).join(", ");
  return (
    <section aria-labelledby="titre-synthese-contractuel" className="space-y-3">
      <h3 id="titre-synthese-contractuel" className="text-sm font-semibold text-navy">Synthèse du périmètre</h3>
      <dl className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 xl:grid-cols-3">
        <Carte libelle={LIBELLES.recenses} note={<>Par statut saisi : {statuts}. Pas un nombre de marchés actifs.</>}>
          {synthese.marchesRecenses.nombre.toLocaleString("fr-FR")}
        </Carte>
        <Carte libelle={`${LIBELLES.contractuel} (montant du marché)`} note={noteMontant(f.contractuel)}><MontantEtiquete montant={f.contractuel} /></Carte>
        <Carte libelle={`${LIBELLES.engage} (non disponible)`} note={noteMontant(f.engage)}><MontantEtiquete montant={f.engage} /></Carte>
        <Carte libelle={`${LIBELLES.decaisse} (décomptes payés)`} note={noteMontant(f.decaisse)}><MontantEtiquete montant={f.decaisse} /></Carte>
        <Carte libelle={`${LIBELLES.previsionnel} (programmes retenus liés)`} note={noteMontant(f.previsionnel)}><MontantEtiquete montant={f.previsionnel} /></Carte>
        <Carte libelle="Retard (règle provisoire)" note={<>{synthese.retard.regle}</>}>
          <span className="text-sm font-semibold">{phraseRetard(synthese.retard)}</span>
        </Carte>
      </dl>

      {/* Region qui defile : focalisable au clavier (axe : scrollable-region-focusable). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="overflow-x-auto" role="region" aria-label="Contractuel par bailleur, défilement horizontal" tabIndex={0}>
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <caption className="pb-1 text-left text-xs font-medium text-gray-700">
            Contractuel par bailleur : montants contractuels étiquetés, ni engagés ni décaissés. Un marché sans montant n&apos;est pas compté comme nul.
          </caption>
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs text-gray-700">
              <th scope="col" className="py-1 pr-3 font-semibold">Bailleur</th>
              <th scope="col" className="py-1 pr-3 font-semibold">Marchés recensés</th>
              <th scope="col" className="py-1 pr-3 font-semibold">Contractuel en GNF</th>
              <th scope="col" className="py-1 pr-3 font-semibold">Autres devises (non converties)</th>
              <th scope="col" className="py-1 font-semibold">Sans montant</th>
            </tr>
          </thead>
          <tbody>
            {synthese.totauxParBailleur.length === 0 && (
              <tr><td colSpan={5} className="py-2 text-gray-700">Aucun marché dans ce périmètre.</td></tr>
            )}
            {synthese.totauxParBailleur.map((b) => (
              <tr key={b.bailleurId ?? "aucun"} className="border-b border-gray-100 align-top">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium text-gray-900">{b.nom ?? "Bailleur non renseigné"}</th>
                <td className="py-1.5 pr-3 tabular-nums">{b.nombreMarches}{b.masques > 0 && <span className="block text-xs text-gray-600">{b.masques} au montant masqué</span>}</td>
                <td className="py-1.5 pr-3"><MontantEtiquete montant={b.contractuel} /></td>
                <td className="py-1.5 pr-3 tabular-nums">{b.autresDevises.length === 0 ? <span className="text-gray-600">Aucune</span> : b.autresDevises.map((d) => <span key={d.devise} className="block">{formaterMontantOrigine({ montant: d.montant, devise: d.devise })} ({d.nombre})</span>)}</td>
                <td className="py-1.5 tabular-nums">{b.sansMontant}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
