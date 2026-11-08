import type { PropositionDetail } from "../../lib/teledetectionApi";
import {
  affichageConfianceDetection, libelleConfianceRattachement, libelleQualiteImage,
} from "../../lib/teledetectionAffichage";
import { PastillePriorite } from "./Pastilles";

/**
 * Les QUATRE dimensions de la qualite d'une proposition, separees et jamais fusionnees en un seul
 * « score » (contrat, principe 5) : confiance de detection, qualite de l'image, confiance du
 * rattachement au troncon, priorite d'inspection. Chacune dit ce qu'elle mesure.
 */
export function QualiteProposition({ p }: { p: PropositionDetail }) {
  const c = affichageConfianceDetection(p.confianceDetection);
  const rat = p.rattachement;
  return (
    <section aria-labelledby="titre-qualite" className="rounded-md border border-gray-200 p-3">
      <h3 id="titre-qualite" className="text-sm font-semibold text-navy">Indicateurs de qualité</h3>
      <p className="mt-0.5 text-xs text-gray-600">Quatre mesures distinctes : elles ne se résument pas en une note unique.</p>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-3 min-[480px]:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-gray-600">Confiance de détection</dt>
          <dd className="text-sm font-semibold text-gray-900">{c.texte} <span className="text-xs font-normal text-gray-600">({c.nature.toLowerCase()})</span></dd>
          <dd className="text-xs text-gray-600">{c.signification || "Signification non fournie par le serveur : ne pas lire cette valeur comme une probabilité."}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-gray-600">Qualité de l&apos;image</dt>
          <dd className="text-sm font-semibold text-gray-900">{libelleQualiteImage(p.qualiteImage)}</dd>
          <dd className="text-xs text-gray-600">Concerne l&apos;image source, pas la fiabilité de la détection.</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-gray-600">Confiance du rattachement au tronçon</dt>
          <dd className="text-sm font-semibold text-gray-900">{libelleConfianceRattachement(rat.confiance)}</dd>
          <dd className="text-xs text-gray-600">
            {rat.distanceM !== null ? `Distance au tronçon : ${Math.round(rat.distanceM).toLocaleString("fr-FR")} m. ` : "Distance non renseignée. "}
            Algorithme : {rat.algorithme || "non renseigné"}.
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-gray-600">Priorité d&apos;inspection</dt>
          <dd className="text-sm font-semibold text-gray-900"><PastillePriorite niveau={p.priorite.niveau} /></dd>
          <dd className="text-xs text-gray-600">Règle : {p.priorite.regle || "non renseignée"}.</dd>
        </div>
      </dl>
    </section>
  );
}
