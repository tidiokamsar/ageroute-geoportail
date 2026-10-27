import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import type { IdOnglet, PropsOnglet } from "./types";
import { libelleOnglet } from "../../lib/decision";
import { EtatChargement } from "./EtatsDecision";
import { GardeOnglet } from "./GardeOnglet";

/**
 * Montage des composants `Onglet*` du contrat (docs/aide-decision/CONTRAT-AD.md paragraphe 8). Le shell ne depend
 * d'aucun detail interne : il ne leur donne que `{ filtres, onFiltres }`. Les onglets sont charges a la demande
 * (la carte embarque Leaflet, inutile tant qu'on n'ouvre pas l'onglet) et gardes : un onglet qui plante ne fait pas
 * tomber la page.
 */
const COMPOSANTS: Record<IdOnglet, LazyExoticComponent<ComponentType<PropsOnglet>>> = {
  carte: lazy(() => import("./onglets/OngletCarte").then((m) => ({ default: m.OngletCarte }))),
  liste: lazy(() => import("./onglets/OngletListe").then((m) => ({ default: m.OngletListe }))),
  simulation: lazy(() => import("./onglets/OngletSimulation").then((m) => ({ default: m.OngletSimulation }))),
  contractuel: lazy(() => import("./onglets/OngletContractuel").then((m) => ({ default: m.OngletContractuel }))),
  scenarios: lazy(() => import("./onglets/OngletScenarios").then((m) => ({ default: m.OngletScenarios }))),
  rapports: lazy(() => import("./onglets/OngletRapports").then((m) => ({ default: m.OngletRapports })) ),
};

export function ContenuOnglet({ onglet, ...props }: PropsOnglet & { onglet: IdOnglet }) {
  const Onglet = COMPOSANTS[onglet];
  const nom = libelleOnglet(onglet);
  return (
    <GardeOnglet key={onglet} nom={nom}>
      <Suspense fallback={<EtatChargement libelle={`Chargement de l'onglet ${nom}…`} />}>
        <Onglet {...props} />
      </Suspense>
    </GardeOnglet>
  );
}
