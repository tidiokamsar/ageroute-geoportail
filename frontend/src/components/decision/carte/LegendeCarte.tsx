import { ChevronDown } from "lucide-react";
import {
  COULEUR_RESEAU_NEUTRE, ETATS_PHYSIQUES, modeStyleReseau, styleMarqueurIntervention, svgMarqueurIntervention,
  type CouchesCarte, type ModeVue,
} from "../../../lib/aideDecisionCarte";
import { symbole } from "../../../features/geoportail/map/symbology";
import { TRAIT_ETAT_DECLARE } from "../../../pages/geoportail/affichageTroncon";

/**
 * Legende de la carte de decision : elle dit ce qui est DESSINE, et seulement cela.
 *
 * Deux echelles qui ne se melangent jamais :
 *  - l'ETAT PHYSIQUE du reseau (vert a rouge, echelle unique de `symbology.ts`, trait pointille = etat declare) ;
 *  - la PRIORITE des interventions (hexagone violet portant le rang ; contour pointille et « ? » = score incomplet).
 * La couleur n'est jamais seule : chaque ligne porte son libelle, chaque priorite son rang et sa teinte, le score incomplet son signe.
 * Le reseau n'est peint par l'etat que dans la vue « Etat actuel » ; ailleurs c'est un fond gris, et la legende le dit.
 */

const Pastille = ({ html }: { html: string }) => <span aria-hidden="true" className="inline-flex shrink-0" dangerouslySetInnerHTML={{ __html: html }} />;

function Trait({ couleur, tirets }: { couleur: string; tirets?: string }) {
  return (
    <svg width="26" height="10" viewBox="0 0 26 10" aria-hidden="true" className="shrink-0">
      <line x1="0" y1="5" x2="26" y2="5" stroke={couleur} strokeWidth="4" strokeDasharray={tirets} />
    </svg>
  );
}

const EXEMPLE = { rang: 12 } as const;

export function LegendeCarte({ mode, couches }: { mode: ModeVue; couches: CouchesCarte }) {
  const reseauEtat = couches.reseau && modeStyleReseau(mode) === "etat";
  const reseauNeutre = couches.reseau && !reseauEtat;
  return (
    <details open className="group rounded-lg border border-gray-200 bg-white text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 font-medium text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60">
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
        Légende
      </summary>
      <div className="grid gap-4 px-3 pb-3 sm:grid-cols-2">
        {reseauEtat && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-700">État physique du réseau</h3>
            <ul className="space-y-1">
              {ETATS_PHYSIQUES.map((e) => (
                <li key={e.code} className="flex items-center gap-2"><Trait couleur={symbole(e.code).trait} /> {e.libelle}</li>
              ))}
              <li className="flex items-start gap-2 border-t border-gray-100 pt-1.5">
                <Trait couleur="#6b7280" tirets={TRAIT_ETAT_DECLARE} />
                <span className="leading-snug">Trait pointillé : état déclaré, non constaté sur le terrain</span>
              </li>
            </ul>
          </div>
        )}
        {reseauNeutre && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-700">Réseau</h3>
            <p className="flex items-start gap-2"><Trait couleur={COULEUR_RESEAU_NEUTRE} /> <span className="leading-snug">Fond gris : l&apos;état physique n&apos;est pas peint dans cette vue, pour ne pas se lire comme une priorité</span></p>
          </div>
        )}
        {couches.priorites && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-700">Priorité des interventions</h3>
            <ul className="space-y-1">
              <li className="flex items-center gap-2">
                <Pastille html={svgMarqueurIntervention(styleMarqueurIntervention({ ...EXEMPLE, statutScore: "CALCULE", scoreIncomplet: false }), { taille: 26 })} />
                Classée, score complet
              </li>
              <li className="flex items-center gap-2">
                <Pastille html={svgMarqueurIntervention(styleMarqueurIntervention({ ...EXEMPLE, statutScore: "INCOMPLET", scoreIncomplet: true }), { taille: 26 })} />
                <span className="leading-snug">Contour pointillé et « ? » : score incomplet</span>
              </li>
              <li className="flex items-center gap-2">
                <Pastille html={svgMarqueurIntervention(styleMarqueurIntervention({ rang: null, statutScore: "EXCLU", scoreIncomplet: false }), { taille: 26 })} />
                <span className="leading-snug">Gris, sans rang : non classée (exclue du classement)</span>
              </li>
              <li className="flex items-center gap-2 border-t border-gray-100 pt-1.5">
                <Pastille html={svgMarqueurIntervention(styleMarqueurIntervention({ ...EXEMPLE, statutScore: "CALCULE", scoreIncomplet: false }), { selectionne: true, taille: 26 })} />
                Halo doré : intervention sélectionnée
              </li>
            </ul>
            <p className="mt-1 text-xs text-gray-700">Le nombre dans l&apos;hexagone est le rang (1 = la plus prioritaire). Le classement est calculé, consultatif : ce n&apos;est pas une décision.</p>
          </div>
        )}
        {(couches.chantiers || couches.ouvrages || couches.pointsNoirs || couches.limites) && (
          <div className="sm:col-span-2">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-700">Autres couches</h3>
            <ul className="space-y-0.5 text-xs text-gray-800">
              {couches.chantiers && <li>Chantiers : tracé ou carré ≈ (position approximative) à la couleur du statut ; trait plein = terminé.</li>}
              {couches.ouvrages && <li>Ouvrages d&apos;art : la forme dit le type, la couleur l&apos;état ; contour discontinu = repris d&apos;une source externe, jamais visité.</li>}
              {couches.pointsNoirs && <li>Points noirs : ▲ gravité forte, ◆ moyenne, ● faible.</li>}
              {couches.limites && <li>Contour du pays : repère simplifié tiré des limites des régions, pas une frontière officielle.</li>}
            </ul>
          </div>
        )}
        {!reseauEtat && !reseauNeutre && !couches.priorites && !couches.chantiers && !couches.ouvrages && !couches.pointsNoirs && !couches.limites && (
          <p className="text-xs text-gray-700 sm:col-span-2">Aucune couche n&apos;est affichée : cochez une couche dans le panneau des filtres.</p>
        )}
      </div>
    </details>
  );
}
