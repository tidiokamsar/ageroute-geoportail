import { useId, useState } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { LIBELLE_REGLES, PHRASE_GOUVERNANCE, REGLES_RECEPTION, TITRE_GOUVERNANCE, TON_BANDEAU } from "./imports.noyau";

/**
 * Bandeau de gouvernance : « Recevoir un lot n'est pas importer. » (cahier 6.1).
 *
 * Il dit, en une phrase, la difference entre reçu / validé techniquement / approuvé par le métier / autorisé à
 * écrire / importé, et ouvre sur les regles de reception. Ces regles sont celles que le code et les documents du
 * depot disent reellement (voir `REGLES_RECEPTION` dans imports.noyau.ts, qui cite ses sources) ; ce qui
 * n'existe pas y est ecrit « non disponible ».
 *
 * Le bandeau est une note (`role="note"`) nommee par son titre. Le bouton « Voir les règles de réception »
 * garde un libelle constant et porte `aria-expanded` + `aria-controls` ; il mesure au moins 44 px de haut
 * (cible tactile). Replie par defaut : la page reste courte, la regle essentielle reste visible.
 */

export interface BandeauGouvernanceProps {
  /** Regles depliees a l'affichage. Defaut : repliees. */
  reglesOuvertes?: boolean;
  className?: string;
}

export function BandeauGouvernance({ reglesOuvertes = false, className }: BandeauGouvernanceProps) {
  const [ouvert, setOuvert] = useState(reglesOuvertes);
  const base = useId();
  const idTitre = `${base}-titre`;
  const idRegles = `${base}-regles`;

  return (
    <div role="note" aria-labelledby={idTitre} className={cn("rounded-jeton-md border p-j4", TON_BANDEAU.classes.conteneur, className)}>
      <div className="flex flex-wrap items-start gap-x-j4 gap-y-j2">
        <TriangleAlert aria-hidden="true" focusable="false" className="mt-j1 size-5 shrink-0" />
        <div className="min-w-0 flex-1 basis-64">
          <p id={idTitre} className="text-corps font-semibold">{TITRE_GOUVERNANCE}</p>
          <p className="mt-j1 text-corps">{PHRASE_GOUVERNANCE}</p>
        </div>
        <button
          type="button"
          aria-expanded={ouvert}
          aria-controls={idRegles}
          onClick={() => setOuvert((v) => !v)}
          className="inline-flex min-h-cible items-center gap-j2 rounded-jeton-sm px-j3 text-corps font-semibold underline underline-offset-4 hover:bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {LIBELLE_REGLES}
          <ChevronDown aria-hidden="true" focusable="false" className={cn("size-4 shrink-0 transition-transform duration-rapide", ouvert && "rotate-180")} />
        </button>
      </div>

      <div id={idRegles} hidden={!ouvert} className="mt-j3 rounded-jeton-sm border border-etat-moyen-trait bg-card p-j4 text-foreground">
        <p className="text-corps font-semibold">Règles de réception</p>
        <ul className="mt-j2 list-disc space-y-j2 pl-j5 text-corps">
          {REGLES_RECEPTION.map((r) => (
            <li key={r.id} data-regle={r.id}>{r.texte}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
