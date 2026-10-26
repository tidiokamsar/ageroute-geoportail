import { cn } from "@/lib/utils";
import { IconeLot, classesPuce } from "./BadgeStatutLot";
import {
  descripteurEtat, etapesAucunLot, indiceEtapeEnCours, nomAccessibleEtape, raisonAffichee, resumeEtapes, TONS,
} from "./imports.noyau";
import type { Etape } from "./types";

/**
 * Les quatre etapes du cycle d'un lot (Reception, Controle du schema, Echantillon a valider, Import autorise).
 *
 * PUREMENT INFORMATIF : ni bouton, ni lien, ni clic, ni etat interne. Les etats et leurs RAISONS viennent du
 * serveur (`Etape[]`) ; ce composant les affiche, il n'en decide aucun. Une etape que le serveur dit
 * `NON_DISPONIBLE` (echantillon, import autorise : aucun circuit n'existe) est montree comme telle, avec sa
 * raison, jamais comme « a venir » ni comme terminee.
 *
 * ACCESSIBILITE : liste ordonnee `<ol>` ; chaque etape porte un nom accessible complet (« Étape 3 sur 4, non
 * disponible : ... ») ; la raison est du TEXTE visible (pas une infobulle), donc lue au clavier, au lecteur
 * d'ecran et au toucher ; `aria-current="step"` n'est pose que sur l'etape `EN_COURS`. Chaque etat se lit par
 * son icone, son texte et son trait (tirets pour « non disponible »), pas par la couleur seule.
 *
 * AUCUN LOT (`etapes` absent ou vide) : variante a quatre etapes `NON_COMMENCEE`, la premiere disant que le
 * formulaire est disponible. Aucune etape n'y est jamais terminee.
 *
 * MISE EN PAGE : empilee en dessous de 1280 px (la barre laterale mange 280 px, quatre colonnes de texte ne
 * tiendraient pas en tablette), en ligne au-dela ; `min-w-0` et retour a la ligne force : pas de debordement.
 */

export interface IndicateurEtapesProps {
  /** Etapes du lot selectionne (champ `etapes` du detail). Absent ou vide : aucun lot selectionne. */
  etapes?: readonly Etape[] | null;
  className?: string;
}

export function IndicateurEtapes({ etapes, className }: IndicateurEtapesProps) {
  const aucunLot = !etapes || etapes.length === 0;
  const liste: readonly Etape[] = aucunLot ? etapesAucunLot() : etapes;
  const total = liste.length;
  const enCours = indiceEtapeEnCours(liste);
  const resume = resumeEtapes(liste, { aucunLot });

  return (
    // `role="list"` explicite : `list-none` fait perdre la semantique de liste a Safari/VoiceOver.
    // eslint-disable-next-line jsx-a11y/no-redundant-roles
    <ol
      role="list"
      aria-label={resume.phrase}
      data-variante={aucunLot ? "aucun-lot" : "lot"}
      className={cn("m-0 flex list-none flex-col gap-j2 p-0 xl:flex-row xl:gap-j3", className)}
    >
      {liste.map((etape, i) => {
        const d = descripteurEtat(etape.etat);
        const ton = TONS[d.ton];
        const raison = raisonAffichee(etape);
        // Aucun lot : la premiere etape est celle a laquelle l'agent peut agir, on la distingue d'un trait navy.
        const miseEnAvant = aucunLot && i === 0;
        return (
          <li
            key={`${i}-${etape.id}`}
            data-etape={etape.id}
            data-etat={d.code}
            aria-label={nomAccessibleEtape(i + 1, total, etape)}
            aria-current={i === enCours ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-start gap-j3 rounded-jeton-md border bg-card p-j3 xl:flex-1",
              miseEnAvant ? TONS.info.classes.trait : ton.classes.trait,
              d.pointille && "border-dashed",
              (i === enCours || miseEnAvant) && "border-2",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("flex size-8 shrink-0 items-center justify-center rounded-full border text-corps font-semibold", classesPuce(d.ton))}
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-corps font-semibold text-foreground [overflow-wrap:anywhere]">{etape.titre}</p>
              <p className={cn("mt-j1 inline-flex max-w-full items-center gap-j1 rounded-jeton-sm border px-j2 py-j1 text-legende font-medium", ton.classes.puce)}>
                <IconeLot nom={d.icone} className={d.icone === "chargement" ? "motion-safe:animate-spin" : undefined} />
                <span>{d.libelle}</span>
              </p>
              {raison !== "" && (
                <p className="mt-j1 text-legende text-muted-foreground [overflow-wrap:anywhere]">{raison}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
