import { useId } from "react";
import { AlertTriangle, ArrowRight, CircleHelp, Clock, FileQuestion } from "lucide-react";
import type { Kpi } from "./types";
import type { KpiLu } from "../../lib/aideDecisionApi";
import { InfoBulle } from "./InfoBulle";
import { affichageKpi, formaterDateHeure, LIBELLE_ETAT_KPI, libelleOnglet, texteCouverture, textePeriode } from "../../lib/decision";

/**
 * Une vignette d'indicateur (contrat paragraphe 5 et cahier paragraphes 4.2 et 9.1).
 *
 * - elle montre valeur + unite, ou, quand l'etat l'interdit, « Non disponible » avec la RAISON : jamais 0 ;
 * - elle porte periode, perimetre, source, date de calcul et couverture ;
 * - elle dit si la definition est PROVISOIRE ;
 * - elle est un BOUTON qui ouvre l'onglet ou la liste qui explique le chiffre (`kpi.ouvre`) ;
 * - sa definition est lisible au clavier (info-bulle) et par un lien « Voir la definition ».
 *
 * Structure : l'element interactif principal (bouton) recouvre toute la vignette par un pseudo-element ; les
 * commandes secondaires (definition) sont des freres, au-dessus (`z-10`), et non des enfants du bouton : un controle
 * imbrique dans un bouton est invalide et illisible au clavier.
 */

function Pastille({ children, ton }: { children: React.ReactNode; ton: "ambre" | "gris" | "vert" | "rouge" }) {
  const classes = {
    ambre: "bg-amber-100 text-amber-900 border-amber-300",
    gris: "bg-gray-100 text-gray-800 border-gray-300",
    vert: "bg-green-100 text-green-900 border-green-300",
    rouge: "bg-red-50 text-red-900 border-red-300",
  }[ton];
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${classes}`}>{children}</span>;
}

export function KpiDecision({ kpi, onOuvrir, onDefinition, definitionOuverte }: {
  kpi: KpiLu;
  onOuvrir: (k: Kpi) => void;
  onDefinition: (code: string) => void;
  definitionOuverte?: boolean;
}) {
  const id = useId();
  const a = affichageKpi(kpi);
  const idValeur = `${id}-valeur`;
  const cible = libelleOnglet(kpi.ouvre.onglet);
  const couverture = texteCouverture(kpi.couverture);
  // Un montant exact en GNF fait 15 chiffres ou plus : corps reduit pour qu'il tienne sur la vignette sans etre tronque.
  const grandMontant = a.unite === "GNF";
  const aTitre = a.valeur === null;

  return (
    <article data-kpi={kpi.code} data-etat={kpi.etat} className="relative flex min-w-0 flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm focus-within:ring-2 focus-within:ring-navy/40">
      <button
        type="button"
        onClick={() => onOuvrir(kpi)}
        // Pas d'aria-labelledby : le nom vient du contenu, donc contient tout le texte visible (WCAG 2.5.3, regle axe
        // label-content-name-mismatch mesuree en navigateur reel) et COMMENCE par le libelle.
        className="flex min-h-[44px] w-full flex-col items-start gap-1 rounded text-left after:absolute after:inset-0 after:rounded-lg focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-navy"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-700">{kpi.libelle}</span>
        <span id={idValeur} className="min-w-0 break-words">
          {aTitre ? (
            <span className="text-lg font-bold text-gray-800">{kpi.etat === "NON_DISPONIBLE" ? "Non disponible" : "Valeur indisponible"}</span>
          ) : (
            <span className={`${grandMontant ? "text-lg" : "text-2xl"} font-bold leading-tight text-navy tabular-nums`}>
              {a.valeur}
              {a.unite && <span className="text-base font-semibold text-gray-800">{" "}{a.unite}</span>}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-navy">
          Voir : {cible}
          <ArrowRight aria-hidden="true" className="h-3 w-3" />
        </span>
      </button>

      <div className="flex flex-wrap gap-1">
        {kpi.etat !== "DISPONIBLE" && (
          <Pastille ton={kpi.etat === "NON_DISPONIBLE" ? "gris" : "ambre"}>
            {kpi.etat === "PERIME" ? <Clock aria-hidden="true" className="h-3 w-3" /> : kpi.etat === "NON_DISPONIBLE" ? <FileQuestion aria-hidden="true" className="h-3 w-3" /> : <AlertTriangle aria-hidden="true" className="h-3 w-3" />}
            {LIBELLE_ETAT_KPI[kpi.etat]}
          </Pastille>
        )}
        {kpi.statutDefinition === "PROVISOIRE" ? (
          <Pastille ton="ambre"><CircleHelp aria-hidden="true" className="h-3 w-3" />Définition provisoire</Pastille>
        ) : (
          <Pastille ton="vert">Définition validée</Pastille>
        )}
      </div>

      {aTitre ? (
        <p data-testid="raison-kpi" className="text-xs font-medium text-amber-900">{kpi.libelle} : {a.raison}</p>
      ) : (
        kpi.avertissements.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-900">
            {kpi.avertissements.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )
      )}

      <dl className="space-y-0.5 text-xs text-gray-700">
        <div className="flex gap-1"><dt className="shrink-0 font-medium">Périmètre :</dt><dd className="min-w-0 break-words">{kpi.perimetre.libelle || "non précisé"}</dd></div>
        <div className="flex gap-1"><dt className="shrink-0 font-medium">Période :</dt><dd className="min-w-0 break-words">{textePeriode(kpi.periode)}</dd></div>
        <div className="flex gap-1"><dt className="shrink-0 font-medium">Source :</dt><dd className="min-w-0 break-words">{kpi.source || "non précisée"}</dd></div>
        <div className="flex gap-1"><dt className="shrink-0 font-medium">Calculé le :</dt><dd className="min-w-0 break-words">{formaterDateHeure(kpi.calculeLe)}</dd></div>
        {couverture && <div className="flex gap-1"><dt className="shrink-0 font-medium">Couverture :</dt><dd className="min-w-0 break-words">{couverture}</dd></div>}
      </dl>

      <div className="relative z-10 mt-auto flex flex-wrap items-center gap-1">
        <InfoBulle libelle={kpi.libelle}>
          <span className="block">{kpi.definition || "Définition non fournie par le serveur."}</span>
          {kpi.formule && <span className="mt-1 block"><strong>Formule :</strong> {kpi.formule}</span>}
        </InfoBulle>
        <button
          type="button"
          data-definition={kpi.code}
          aria-expanded={!!definitionOuverte}
          aria-controls={definitionOuverte ? "panneau-definition" : undefined}
          aria-label={`Voir la définition : ${kpi.libelle}`}
          onClick={() => onDefinition(kpi.code)}
          className="inline-flex min-h-[44px] items-center rounded px-1 text-xs font-medium text-navy underline underline-offset-2 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-7"
        >
          Voir la définition
        </button>
      </div>
    </article>
  );
}
