import { CircleAlert, FileText, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/Button";
import {
  abregerTexte, AIDE_AUCUN_RESULTAT, MESSAGE_AUCUN_LOT, MESSAGE_AUCUN_RESULTAT, messageErreurListe, TONS,
} from "./imports.noyau";

/**
 * Les trois etats d'une liste qui n'a rien a montrer, et qu'il ne faut JAMAIS confondre (cahier AT-13, AT-14) :
 *
 *   - EtatChargement : la liste arrive. Squelette `role="status"` + `aria-busy`, texte pour le lecteur d'ecran.
 *   - EtatVide       : la liste est vide. Deux cas : aucun lot recu (message du cahier), ou aucun lot pour les
 *                      filtres actifs (bouton « Effacer les filtres »).
 *   - EtatErreur     : la liste n'a PAS pu etre chargee. `role="alert"`, message distinct d'un vide, bouton
 *                      « Réessayer ». Un 403 dit que le profil n'a pas le droit, pas qu'il n'y a rien.
 *
 * Aucune logique reseau ici : l'appelant fournit `onEffacerFiltres` et `onReessayer`. Les boutons mesurent au
 * moins 44 px de haut (`min-h-cible`).
 */

const BOUTON = "h-auto min-h-cible px-j4";

export interface EtatChargementProps {
  /** Texte lu par le lecteur d'ecran. */
  libelle?: string;
  /** Nombre de lignes du squelette (defaut 4). */
  lignes?: number;
  className?: string;
}

export function EtatChargement({ libelle = "Chargement de la liste des lots en cours.", lignes = 4, className }: EtatChargementProps) {
  const n = Number.isFinite(lignes) ? Math.min(10, Math.max(1, Math.floor(lignes))) : 4;
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-etat-liste="chargement" className={cn("flex flex-col gap-j2 p-j4", className)}>
      <span className="sr-only">{libelle}</span>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex items-center gap-j3 rounded-jeton-md border bg-card p-j3">
          <div className="size-8 shrink-0 rounded-jeton-sm bg-muted motion-safe:animate-pulse" />
          <div className="flex-1 space-y-j2">
            <div className="h-3 w-2/3 rounded-jeton-sm bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-1/3 rounded-jeton-sm bg-muted motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

export type EtatVideProps = { className?: string } & (
  | { filtresActifs?: false; onEffacerFiltres?: never }
  /** Filtres actifs : l'appelant DOIT fournir de quoi les effacer, sinon l'agent est dans une impasse. */
  | { filtresActifs: true; onEffacerFiltres: () => void }
);

export function EtatVide(props: EtatVideProps) {
  const { className } = props;
  const Icone = props.filtresActifs ? SearchX : FileText;
  return (
    <div
      role="status"
      data-etat-liste={props.filtresActifs ? "aucun-resultat" : "vide"}
      className={cn("flex flex-col items-center gap-j3 p-j6 text-center", className)}
    >
      <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-jeton-md bg-muted text-muted-foreground">
        <Icone focusable="false" className="size-7" />
      </span>
      {props.filtresActifs ? (
        <>
          <p className="text-section font-semibold text-foreground">{MESSAGE_AUCUN_RESULTAT}</p>
          <p className="max-w-prose text-corps text-muted-foreground">{AIDE_AUCUN_RESULTAT}</p>
          <Button type="button" variant="outline" className={BOUTON} onClick={props.onEffacerFiltres}>
            Effacer les filtres
          </Button>
        </>
      ) : (
        <p className="max-w-prose text-section font-semibold text-foreground">{MESSAGE_AUCUN_LOT}</p>
      )}
    </div>
  );
}

export interface EtatErreurProps {
  /** Code HTTP de la reponse en erreur, s'il y en a un (403 : droits). Absent : erreur reseau ou inattendue. */
  statutHttp?: number | null;
  /** Detail technique NON SENSIBLE (ex. « Délai dépassé »). Nettoye et abrege a l'affichage. Jamais de jeton, de chemin serveur ni de trace. */
  detail?: string | null;
  /** Relance du chargement. Appelee a chaque clic ; ne fait rien d'autre. */
  onReessayer: () => void;
  /** Une relance est en cours : le bouton est inactif et annonce l'attente. */
  reessaiEnCours?: boolean;
  className?: string;
}

export function EtatErreur({ statutHttp, detail, onReessayer, reessaiEnCours = false, className }: EtatErreurProps) {
  const { message, aide, droits } = messageErreurListe(statutHttp);
  const detailPropre = abregerTexte(detail ?? "", 200);
  return (
    <div
      role="alert"
      data-etat-liste={droits ? "erreur-droits" : "erreur"}
      className={cn("flex flex-col gap-j3 rounded-jeton-md border p-j4", TONS.echec.classes.puce, className)}
    >
      <div className="flex items-start gap-j2">
        <CircleAlert aria-hidden="true" focusable="false" className="mt-j1 size-5 shrink-0" />
        <p className="min-w-0 text-section font-semibold [overflow-wrap:anywhere]">{message}</p>
      </div>
      <p className="text-corps text-foreground">{aide}</p>
      {detailPropre !== "" && (
        <p className="text-legende text-foreground [overflow-wrap:anywhere]">
          Détail technique : <span>{detailPropre}</span>
        </p>
      )}
      <div>
        <Button type="button" variant="default" className={BOUTON} onClick={onReessayer} disabled={reessaiEnCours} aria-busy={reessaiEnCours}>
          {reessaiEnCours ? "Nouvelle tentative en cours" : "Réessayer"}
        </Button>
      </div>
    </div>
  );
}
