import { AlertTriangle, CalendarOff, Calculator, HelpCircle, ShieldCheck, XCircle } from "lucide-react";

/**
 * Ce que l'on sait d'une valeur, affiche a cote de la valeur elle-meme.
 *
 * POURQUOI
 *
 * `revetement` vaut BITUME sur les 1 690 troncons, sans une seule exception. La fiche
 * l'affichait comme une caracteristique du reseau. Ce n'en est pas une : c'est une
 * valeur d'import que rien n'a jamais verifiee, et 29 intitules de chantiers decrivent
 * des routes « en terre » ou « laterite ».
 *
 * De meme, un etat sans date de constat n'est pas comparable a un autre : sur les 647
 * troncons dont l'etat est connu, aucun ne porte de date.
 *
 * CE QUE CE BADGE NE FAIT PAS
 *
 * Il ne corrige rien et ne cache rien. La valeur reste affichee telle qu'elle est en
 * base ; le badge dit seulement quel credit lui accorder. Remplacer BITUME par autre
 * chose demanderait une source, et il n'y en a pas.
 */

export type StatutValeur = "OBSERVED" | "IMPORTED_UNVERIFIED" | "DERIVED" | "CONFLICTING" | "UNKNOWN";

export interface QualiteChamp {
  champ: string;
  statut: StatutValeur | null;
  libelle: string;
  source: string | null;
  methode: string | null;
  observedAt: string | null;
  confiance: "HIGH" | "MEDIUM" | "LOW" | null;
  note: string | null;
  douteuse: boolean;
  datee: boolean;
}

const APPARENCE: Record<
  StatutValeur | "ABSENT",
  { icone: typeof AlertTriangle; classe: string }
> = {
  // Seul cas ou la valeur peut etre lue comme un fait etabli.
  OBSERVED: { icone: ShieldCheck, classe: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  IMPORTED_UNVERIFIED: { icone: AlertTriangle, classe: "bg-amber-50 text-amber-700 ring-amber-200" },
  DERIVED: { icone: Calculator, classe: "bg-sky-50 text-sky-700 ring-sky-200" },
  CONFLICTING: { icone: XCircle, classe: "bg-red-50 text-red-700 ring-red-200" },
  UNKNOWN: { icone: HelpCircle, classe: "bg-gray-100 text-gray-600 ring-gray-200" },
  ABSENT: { icone: HelpCircle, classe: "bg-gray-100 text-gray-500 ring-gray-200" },
};

export function QualiteBadge({ qualite }: { qualite: QualiteChamp | null | undefined }) {
  if (!qualite) return null;

  const { icone: Icone, classe } = APPARENCE[qualite.statut ?? "ABSENT"];

  // Un constat non date ne vaut pas mieux qu'une absence de constat : deux « BON »
  // non dates ne sont pas comparables. On le signale meme sur un statut OBSERVED.
  const dateManquante = qualite.statut === "OBSERVED" && !qualite.datee;

  const detail = [
    qualite.source ? `Source : ${qualite.source}` : null,
    qualite.methode ? `Méthode : ${qualite.methode}` : null,
    qualite.observedAt
      ? `Constaté le ${new Date(qualite.observedAt).toLocaleDateString("fr-FR")}`
      : "Aucune date de constat",
    qualite.note,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <span
        title={detail}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset ${classe}`}
      >
        <Icone className="h-3 w-3 shrink-0" aria-hidden="true" />
        {qualite.libelle}
      </span>
      {dateManquante && (
        <span
          title="Constat sans date : non comparable à un autre constat."
          className="inline-flex items-center rounded bg-amber-50 px-1 py-0.5 text-amber-700 ring-1 ring-inset ring-amber-200"
        >
          <CalendarOff className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">Constat non daté</span>
        </span>
      )}
    </span>
  );
}

/** Retrouve la qualite d'un champ dans la reponse de /api/qualite/:type/:id. */
export function qualiteDe(champs: QualiteChamp[] | undefined, champ: string): QualiteChamp | null {
  return champs?.find((c) => c.champ === champ) ?? null;
}
