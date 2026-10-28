import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

/**
 * Garde-fou local autour de la carte : si Leaflet ou une donnee imprevue fait lever le rendu de la carte, l'exception s'arrete ICI.
 * Sans elle, React Router affiche son ecran d'erreur a la place de toute la page : filtres, liste, fiche et constats, qui n'ont rien a
 * voir avec la carte, disparaissent avec elle. Copie de `GardeCarte` d'Observation de la Terre (lecture seule), message adapte.
 *
 * Ce n'est qu'un dernier filet : la carte valide elle-meme ses couches avant de les confier a Leaflet (`lireGeoJsonCouche`). « Reessayer »
 * remonte la carte a neuf, et `onReessayer` laisse l'ecran remettre les couches optionnelles a leur etat d'origine.
 */

interface Props {
  children: ReactNode;
  className?: string;
  onReessayer?: () => void;
}
interface Etat { erreur: Error | null; essai: number }

export class GardeCarte extends Component<Props, Etat> {
  state: Etat = { erreur: null, essai: 0 };

  static getDerivedStateFromError(erreur: unknown): Partial<Etat> {
    return { erreur: erreur instanceof Error ? erreur : new Error(String(erreur)) };
  }

  componentDidCatch(erreur: Error, info: ErrorInfo) {
    console.error("[Aide à la décision] la carte a échoué", erreur, info.componentStack);
  }

  private reessayer = () => {
    this.props.onReessayer?.();
    this.setState((e) => ({ erreur: null, essai: e.essai + 1 }));
  };

  render() {
    const { erreur, essai } = this.state;
    if (!erreur) return <Fragment key={essai}>{this.props.children}</Fragment>;
    return (
      <div role="alert" data-etat="erreur-carte" className={`flex flex-col items-start justify-center gap-2 bg-red-50 p-4 text-sm text-red-900 ${this.props.className ?? ""}`}>
        <p className="flex items-start gap-2">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>La carte n&apos;a pas pu s&apos;afficher.</strong> Les filtres, la liste des interventions, la fiche et les constats restent utilisables.
          </span>
        </p>
        <p className="break-words text-xs text-red-800">Détail technique : {erreur.message || "erreur sans message"}</p>
        <button
          type="button"
          onClick={this.reessayer}
          aria-label="Réessayer : carte"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 xl:min-h-9"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Réessayer
        </button>
      </div>
    );
  }
}
