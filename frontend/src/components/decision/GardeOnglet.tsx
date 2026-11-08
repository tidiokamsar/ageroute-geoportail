import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

/**
 * Garde-fou autour du contenu d'un onglet : si un onglet leve une exception au rendu (ou si son chargement echoue),
 * elle s'arrete ICI. Sans elle, le routeur affiche son ecran d'erreur a la place de toute la page : indicateurs,
 * filtres et barre d'onglets, qui n'ont rien a voir avec l'onglet fautif, disparaitraient avec lui.
 * Copie adaptee de `GardeCarte` (module Observation de la Terre). « Reessayer » remonte l'onglet a neuf.
 */

interface Props {
  /** Libelle de l'onglet, pour le message et le nom accessible du bouton. */
  nom: string;
  children: ReactNode;
}
interface Etat { erreur: Error | null; essai: number }

export class GardeOnglet extends Component<Props, Etat> {
  state: Etat = { erreur: null, essai: 0 };

  static getDerivedStateFromError(erreur: unknown): Partial<Etat> {
    return { erreur: erreur instanceof Error ? erreur : new Error(String(erreur)) };
  }

  componentDidCatch(erreur: Error, info: ErrorInfo) {
    // Trace technique pour le support : l'utilisateur, lui, lit le message ci-dessous.
    console.error("[Aide a la decision] un onglet a echoue", erreur, info.componentStack);
  }

  private reessayer = () => {
    this.setState((e) => ({ erreur: null, essai: e.essai + 1 }));
  };

  render() {
    const { erreur, essai } = this.state;
    if (!erreur) return <Fragment key={essai}>{this.props.children}</Fragment>;
    return (
      <div role="alert" data-etat="erreur-onglet" className="flex flex-col items-start gap-2 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="flex items-start gap-2">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>L&apos;onglet « {this.props.nom} » n&apos;a pas pu s&apos;afficher.</strong> Les indicateurs, les filtres et les autres onglets restent utilisables.
          </span>
        </p>
        <p className="break-words text-xs text-red-900">Détail technique : {erreur.message || "erreur sans message"}</p>
        <button
          type="button"
          onClick={this.reessayer}
          aria-label={`Réessayer : onglet ${this.props.nom}`}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 xl:min-h-9"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Réessayer
        </button>
      </div>
    );
  }
}
