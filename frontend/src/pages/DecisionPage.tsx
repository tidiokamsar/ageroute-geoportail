import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Scale } from "lucide-react";
import type { FiltresDecision, IdOnglet, Kpi } from "../components/decision/types";
import { BarreOnglets, idOnglet, idPanneauOnglets } from "../components/decision/BarreOnglets";
import { ContenuOnglet } from "../components/decision/OngletsDecision";
import { PanneauDefinition } from "../components/decision/PanneauDefinition";
import { PanneauFiltres, type RegionsLues } from "../components/decision/PanneauFiltres";
import { RangeeKpi } from "../components/decision/RangeeKpi";
import { BoutonExportDecision } from "../components/decision/rapports/BoutonExportDecision";
import { ZoneSynthese } from "../components/decision/ZoneSynthese";
import { useRegionsDecision, useSynthese } from "../lib/aideDecisionHooks";
import { ecrireUrl, lireFiltres, lireOnglet, normaliserFiltres, serialiserFiltres } from "../lib/decision";

/**
 * Page « Aide a la decision » : SHELL mince (lot 1). Il porte l'en-tete, la mention consultative, les filtres globaux
 * synchronises avec l'URL, la rangee d'indicateurs cliquables, la barre d'onglets et la zone de synthese. Il ne depend
 * d'aucun detail interne des onglets : il leur passe `{ filtres, onFiltres }` et rien d'autre.
 *
 * Titre : l'unique titre de la page est celui du bandeau d'en-tete de l'application (`Header`, « Aide a la decision »).
 * Cette page n'ajoute pas de second titre de meme niveau ; ses sections portent des titres de rang inferieur.
 */
export function DecisionPage() {
  const [params, setParams] = useSearchParams();
  const onglet = lireOnglet(params);
  // `params` change d'identite a chaque navigation : la cle serialisee evite de reconstruire des filtres identiques
  // (et donc de relancer les onglets) quand seul l'onglet change.
  const cleFiltres = serialiserFiltres(lireFiltres(params)).toString();
  const filtres = useMemo(() => lireFiltres(cleFiltres), [cleFiltres]);

  const requete = useSynthese(filtres);
  const regions = useRegionsDecision();
  // Instant de reference de la fraicheur : renouvele a chaque lecture, pas a chaque rendu.
  const maintenant = useMemo(() => new Date(requete.dataUpdatedAt || Date.now()), [requete.dataUpdatedAt]);

  const prefixe = useId();
  const panneau = useRef<HTMLDivElement>(null);
  const titreDefinition = useRef<HTMLHeadingElement>(null);
  const [definitionCode, setDefinitionCode] = useState<string | null>(null);
  const [focusPanneau, setFocusPanneau] = useState(false);

  const changerFiltres = useCallback((f: FiltresDecision) => {
    setParams((p) => ecrireUrl(p, lireOnglet(p), normaliserFiltres(f)), { replace: true });
  }, [setParams]);

  const changerOnglet = useCallback((id: IdOnglet) => {
    setParams((p) => ecrireUrl(p, id, lireFiltres(p)));
  }, [setParams]);

  // Un indicateur ouvre l'onglet qui l'explique, avec ses filtres par-dessus ceux de la page.
  const ouvrirKpi = useCallback((k: Kpi) => {
    setParams((p) => ecrireUrl(p, k.ouvre.onglet, { ...lireFiltres(p), ...k.ouvre.filtres }));
    setFocusPanneau(true);
  }, [setParams]);

  // Le focus suit l'ouverture : sans lui, un utilisateur au clavier reste sur la vignette et doit retraverser la page.
  useEffect(() => {
    if (!focusPanneau) return;
    setFocusPanneau(false);
    panneau.current?.focus();
    panneau.current?.scrollIntoView?.({ block: "start" });
  }, [focusPanneau, onglet]);

  useEffect(() => {
    if (definitionCode) titreDefinition.current?.focus();
  }, [definitionCode]);

  const kpiDefinition = requete.data?.kpis.find((k) => k.code === definitionCode) ?? null;
  // La reponse a pu changer (nouveau perimetre) : une definition dont l'indicateur a disparu se ferme.
  useEffect(() => {
    if (definitionCode && requete.data && !kpiDefinition) setDefinitionCode(null);
  }, [definitionCode, requete.data, kpiDefinition]);

  const basculerDefinition = (code: string) => setDefinitionCode((c) => (c === code ? null : code));
  const fermerDefinition = () => {
    const code = definitionCode;
    setDefinitionCode(null);
    // Retour du focus sur le controle qui a ouvert la definition.
    if (code) requestAnimationFrame(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-definition]")).find((b) => b.dataset.definition === code)?.focus());
  };

  const etatRegions: RegionsLues = regions.isPending ? { etat: "chargement" } : regions.isError || !Array.isArray(regions.data) ? { etat: "erreur" } : { etat: "ok", regions: regions.data };

  const allerAuContenu = (e: React.MouseEvent) => {
    e.preventDefault();
    panneau.current?.focus();
  };

  return (
    <div className="space-y-4">
      <a
        href={`#${idPanneauOnglets(prefixe)}`}
        onClick={allerAuContenu}
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-modale focus:rounded-md focus:bg-navy focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Aller au contenu de l&apos;onglet
      </a>

      <p className="max-w-3xl text-sm text-gray-700">
        Priorisation des interventions, simulation budgétaire et suivi contractuel.
      </p>

      <div role="note" data-testid="mention-consultative" className="flex items-start gap-2 rounded-md border border-navy/30 bg-white px-3 py-2 text-sm text-gray-900">
        <Scale aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-navy" />
        <p>
          <strong>Consultatif :</strong> les priorités et simulations ne sont ni des ordres de travaux ni des autorisations financières.
        </p>
      </div>

      <PanneauFiltres filtres={filtres} onFiltres={changerFiltres} regions={etatRegions} />

      <RangeeKpi requete={requete} onOuvrir={ouvrirKpi} onDefinition={basculerDefinition} definitionCode={definitionCode} maintenant={maintenant} />

      {kpiDefinition && <PanneauDefinition ref={titreDefinition} kpi={kpiDefinition} onFermer={fermerDefinition} />}

      <div className="space-y-1">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1 basis-[24rem]">
            <BarreOnglets actif={onglet} onChoisir={changerOnglet} prefixe={prefixe} />
          </div>
          <BoutonExportDecision filtres={filtres} />
        </div>
      </div>

      <div
        ref={panneau}
        role="tabpanel"
        id={idPanneauOnglets(prefixe)}
        aria-labelledby={idOnglet(prefixe, onglet)}
        tabIndex={0}
        className="min-w-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-navy"
      >
        <ContenuOnglet onglet={onglet} filtres={filtres} onFiltres={changerFiltres} />
      </div>

      {onglet === "carte" && <ZoneSynthese requete={requete} filtres={filtres} onFiltres={changerFiltres} />}
    </div>
  );
}
