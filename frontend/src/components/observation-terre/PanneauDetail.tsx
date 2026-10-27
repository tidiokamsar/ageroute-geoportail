import { forwardRef, useRef, useState, type KeyboardEvent } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeft, X } from "lucide-react";
import { classerErreur, type PropositionDetail } from "../../lib/teledetectionApi";
import {
  affichageRattachement, affichageResolution, formaterDate, formaterResolution, libelleType, limitesNonRenseignees, MESSAGE_LIMITES_NON_RENSEIGNEES,
} from "../../lib/teledetectionAffichage";
import { Button } from "../ui/Button";
import { ActionsProposition } from "./ActionsProposition";
import { BandeauPerime, EtatChargement, EtatErreur } from "./EtatsPanneau";
import { OngletApercu, OngletComparaison, OngletHistorique, OngletTerrain } from "./OngletsDetail";
import { PastilleStatut } from "./Pastilles";
import { QualiteProposition } from "./QualiteProposition";

/**
 * Panneau « Detail de la proposition » : ce que c'est, d'ou ca vient, ce que cela vaut ET ce que
 * cela ne dit pas (limites), puis les decisions possibles. Sur mobile et tablette il occupe la
 * place de la liste, avec un retour clair.
 */

const ONGLETS = [
  { id: "apercu", libelle: "Aperçu" },
  { id: "comparaison", libelle: "Comparaison" },
  { id: "terrain", libelle: "Terrain" },
  { id: "historique", libelle: "Historique" },
] as const;
type IdOnglet = (typeof ONGLETS)[number]["id"];

export const PanneauDetail = forwardRef<HTMLHeadingElement, {
  detail: UseQueryResult<PropositionDetail, unknown>;
  role: string | undefined;
  onFermer: () => void;
  className?: string;
}>(function PanneauDetail({ detail: q, role, onFermer, className = "" }, refTitre) {
  const [onglet, setOnglet] = useState<IdOnglet>("apercu");
  const refOnglets = useRef<Array<HTMLButtonElement | null>>([]);
  const d = q.data;
  const erreur = q.isError ? classerErreur(q.error) : null;

  function surTouche(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let cible = i;
    if (e.key === "ArrowRight") cible = (i + 1) % ONGLETS.length;
    else if (e.key === "ArrowLeft") cible = (i - 1 + ONGLETS.length) % ONGLETS.length;
    else if (e.key === "Home") cible = 0;
    else if (e.key === "End") cible = ONGLETS.length - 1;
    else return;
    e.preventDefault();
    setOnglet(ONGLETS[cible].id);
    refOnglets.current[cible]?.focus();
  }

  const r = d ? affichageRattachement(d) : null;
  const res = d ? affichageResolution(d.source) : null;
  const limitesAbsentes = d ? limitesNonRenseignees(d) : false;

  return (
    <section aria-labelledby="titre-detail" className={`rounded-lg border border-gray-200 bg-white p-3 shadow-sm ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" className="min-h-[44px] xl:hidden" onClick={onFermer}>
          <ArrowLeft aria-hidden="true" />
          Retour à la liste
        </Button>
        <h2 id="titre-detail" ref={refTitre} tabIndex={-1} className="text-base font-semibold text-navy focus:outline-none">Détail de la proposition</h2>
        <Button type="button" variant="ghost" size="icon" className="hidden xl:inline-flex" aria-label="Fermer le détail de la proposition" onClick={onFermer}>
          <X aria-hidden="true" />
        </Button>
      </div>

      {q.isPending && <EtatChargement libelle="Chargement de la proposition…" />}
      {erreur && !d && <div className="mt-2"><EtatErreur panneau="Détail de la proposition" erreur={erreur} onReessayer={() => void q.refetch()} reessaiEnCours={q.isFetching} /></div>}
      {erreur && d && <div className="mt-2"><BandeauPerime panneau="Détail" misAJourLe={q.dataUpdatedAt} onReessayer={() => void q.refetch()} /></div>}

      {d && r && (
        <div className="mt-2 space-y-3">
          <header>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-lg font-bold text-gray-900">{libelleType(d.type)}</p>
              <PastilleStatut statut={d.statut} />
            </div>
            <p className={`text-sm ${r.fiable ? "text-gray-800" : "font-medium text-amber-800"}`}>{r.titre}{r.zone ? <span className="font-normal text-gray-600"> · {r.zone}</span> : null}</p>
            {r.reserve && <p className="text-xs text-gray-600">{r.reserve}</p>}
            {d.synthetique && <p className="text-xs font-semibold text-amber-800">Donnée synthétique (démonstration) : ne pas utiliser comme constat.</p>}
          </header>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-gray-600">Source</dt>
            <dd>{d.source.nom}{d.source.capteur ? ` · ${d.source.capteur}` : ""}</dd>
            <dt className="text-gray-600">Date d&apos;acquisition</dt>
            <dd>{formaterDate(d.dateObservation)}</dd>
            <dt className="text-gray-600">Image de référence</dt>
            <dd>{d.dateReference ? formaterDate(d.dateReference) : "Non renseignée"}</dd>
            <dt className="text-gray-600">{res?.intitule}</dt>
            <dd>{res?.valeur}{res?.note && <span className="block text-xs text-amber-900" data-testid="origine-resolution">{res.note}</span>}</dd>
            <dt className="text-gray-600">Méthode</dt>
            <dd>{d.methode.nom} (version {d.methode.version})</dd>
          </dl>

          <QualiteProposition p={d} />

          <section aria-labelledby="titre-limites" className="rounded-md border border-amber-200 bg-amber-50 p-3">
            <h3 id="titre-limites" className="text-sm font-semibold text-amber-900">Limites connues</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-900">
              {d.source.resolutionM !== null && (
                <li>
                  Rien n&apos;est affirmé au-delà de la résolution {res?.native ? "native" : "du produit livré (qui n'est pas la résolution native)"} de {formaterResolution(d.source.resolutionM)} : les détails plus fins (nids-de-poule, fissures) ne sont pas détectables.
                </li>
              )}
              {(d.limites ?? []).map((l, i) => <li key={`${i}-${l}`}>{l}</li>)}
              {/* null = non renseignees (ligne d'avant la migration) : ce n'est PAS « aucune limite ». */}
              {limitesAbsentes && <li data-testid="limites-non-renseignees" className="font-medium">{MESSAGE_LIMITES_NON_RENSEIGNEES} : ne pas en conclure qu&apos;il n&apos;y en a pas.</li>}
              {!limitesAbsentes && (d.limites ?? []).length === 0 && <li>Le serveur n&apos;a fourni aucune limite propre à cette proposition : ne rien en déduire au-delà de ce qui précède.</li>}
            </ul>
          </section>

          <details className="rounded-md border border-gray-200 p-2 text-sm">
            <summary className="flex min-h-[44px] cursor-pointer items-center py-1 font-medium text-navy xl:min-h-0">Provenance</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-gray-600">Fournisseur</dt><dd>{d.provenance?.fournisseur ?? "Non renseigné"}</dd>
              <dt className="text-gray-600">Identifiant</dt><dd className="break-all">{d.provenance?.identifiantFournisseur ?? "Non renseigné"}</dd>
              <dt className="text-gray-600">Licence</dt><dd>{d.provenance?.licence ?? "Non renseignée"}</dd>
              <dt className="text-gray-600">Attribution</dt><dd>{d.provenance?.attribution ?? "Non renseignée"}</dd>
              <dt className="text-gray-600">Traitement</dt><dd>{d.provenance?.versionTraitement ?? "Non renseigné"}</dd>
              <dt className="text-gray-600">Empreinte SHA-256</dt><dd className="break-all font-mono">{d.provenance?.empreinteSha256 ?? "Non calculée"}</dd>
            </dl>
          </details>

          <div>
            <div role="tablist" aria-label="Contenu de la proposition" className="flex flex-wrap gap-1">
              {ONGLETS.map((o, i) => (
                <button
                  key={o.id} ref={(el) => { refOnglets.current[i] = el; }} type="button" role="tab" id={`onglet-detail-${o.id}`}
                  aria-selected={onglet === o.id} aria-controls="panneau-detail" tabIndex={onglet === o.id ? 0 : -1}
                  onClick={() => setOnglet(o.id)} onKeyDown={(e) => surTouche(e, i)}
                  className={`min-h-[44px] rounded-md px-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-9 ${onglet === o.id ? "bg-navy text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"}`}
                >
                  {o.libelle}
                </button>
              ))}
            </div>
            <div role="tabpanel" id="panneau-detail" aria-labelledby={`onglet-detail-${onglet}`} className="mt-2">
              {onglet === "apercu" && <OngletApercu detail={d} />}
              {onglet === "comparaison" && <OngletComparaison detail={d} />}
              {onglet === "terrain" && <OngletTerrain detail={d} />}
              {onglet === "historique" && <OngletHistorique detail={d} />}
            </div>
          </div>

          <ActionsProposition key={d.id} detail={d} role={role} />
        </div>
      )}
    </section>
  );
});
