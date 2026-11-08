import { formaterMontantOrigine, libelleMotif, texteMontant, type MontantVue } from "../../../lib/aideDecisionContractuel";

/**
 * Un montant, avec son etat. La valeur vient du serveur en CHAINE ; sans valeur on lit « Non disponible » et la raison, jamais
 * 0 ni un tiret muet. Le marqueur « partiel » signale un agregat ou un lien indirect. Le libelle (contractuel, engage, decaisse,
 * previsionnel) est choisi par l'appelant : ce composant ne le deduit pas d'une autre grandeur.
 */
export function MontantEtiquete({ montant, compact = false }: { montant: MontantVue; compact?: boolean }) {
  const dispo = montant.valeurGnf !== null;
  return (
    <span className="block" data-etat-montant={montant.etat}>
      <span className={dispo ? "font-medium tabular-nums text-gray-900" : "text-gray-600"}>{texteMontant(montant)}</span>
      {montant.valeurOrigine && <span className="block text-xs tabular-nums text-gray-700">{formaterMontantOrigine(montant.valeurOrigine)}</span>}
      {montant.etat === "PARTIEL" && <span className="ml-1 text-xs font-medium text-amber-800">(partiel)</span>}
      {!dispo && <span className="block text-xs text-gray-600">{libelleMotif(montant.motif)}</span>}
      {!compact && montant.couverture && (
        <span className="block text-xs text-gray-600">{montant.couverture.pris} marché(s) sur {montant.couverture.total}</span>
      )}
    </span>
  );
}
