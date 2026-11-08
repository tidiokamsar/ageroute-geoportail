import { useId } from "react";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Input";
import { LIBELLE_CHAMP_CIBLE, exemplesColonne, texteAttribut, type Apercu, type Inventaire, type Lecture, type OptionsImportApi } from "../../../lib/projetsVoirieImport";
import { Encart, ListeAvertissements } from "./commun";

/**
 * Etape 4 : correspondance de champs, colonne source vers champ cible (liste blanche venue de l'API). Les valeurs d'exemple sont bornees a trois par
 * colonne. Un champ « de jeu » prend UNE valeur pour tout le fichier : proposee, jamais inventee ; elle ne remplace pas ce que le formulaire de
 * l'etape 1 a deja renseigne. Les propositions du serveur sont des boutons : rien n'est rempli sans votre geste.
 */
export function EtapeMapping({ inventaire, lecture, options, apercu, apercuExemples, occupe, onMapping }: {
  inventaire: Inventaire; lecture: Lecture; options: OptionsImportApi; apercu: Apercu | null; apercuExemples: Apercu | null; occupe: boolean;
  onMapping: (champ: string, colonne: string) => void;
}) {
  const id = useId();
  const colonnes = inventaire.champsDisponibles;
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-800">
        Associez une colonne ou un attribut du fichier aux champs de l&apos;application. Tout est facultatif : sans correspondance, le nom lu dans le fichier est conservé et
        les champs du jeu restent ceux de l&apos;étape « Dépôt du fichier ».
      </p>
      {colonnes.length === 0 && <Encart ton="attention">Le serveur n&apos;a trouvé aucun attribut ni aucune colonne à associer dans ce fichier.</Encart>}
      <ul className="space-y-3">
        {options.champsCibles.map((c) => {
          const choisie = lecture.mapping[c.champ] ?? "";
          const exemples = choisie ? exemplesColonne(choisie, inventaire, apercuExemples ?? apercu) : [];
          const suggestion = inventaire.suggestionsMapping[c.champ];
          const proposition = apercu?.mapping.propositionsJeu[c.champ];
          const idc = `${id}-${c.champ}`;
          return (
            <li key={c.champ} className="space-y-1 rounded border border-gray-200 bg-white p-2" data-champ={c.champ}>
              <label htmlFor={idc} className="block text-sm font-medium text-gray-900">
                {LIBELLE_CHAMP_CIBLE[c.champ] ?? c.champ}
                <span className="ml-1 text-xs font-normal text-gray-700">({c.portee === "objet" ? "propre à chaque objet" : "une seule valeur pour tout le jeu"})</span>
              </label>
              <Select id={idc} value={choisie} onChange={(e) => onMapping(c.champ, e.target.value)} disabled={occupe || colonnes.length === 0} aria-describedby={`${idc}-aide`} className="border-gray-300">
                <option value="">Aucune correspondance</option>
                {colonnes.map((col) => <option key={col} value={col}>{col}</option>)}
              </Select>
              <p id={`${idc}-aide`} className="text-xs text-gray-700">{c.description}</p>
              {suggestion && choisie !== suggestion && colonnes.includes(suggestion) && (
                <Button type="button" size="sm" variant="outline" className="min-h-[44px] sm:min-h-8" disabled={occupe} onClick={() => onMapping(c.champ, suggestion)}>
                  Utiliser la colonne proposée : {texteAttribut(suggestion, 40)}
                </Button>
              )}
              {choisie && (
                <p className="text-xs text-gray-800" data-testid={`exemples-${c.champ}`}>
                  Exemples de valeurs de « {texteAttribut(choisie, 40)} » : {exemples.length > 0 ? exemples.map((e) => `« ${e} »`).join(", ") : "aucun exemple dans les données déjà lues (voir l'étape suivante)."}
                </p>
              )}
              {proposition && (
                <p className="text-xs text-green-900" data-testid={`proposition-${c.champ}`}>
                  Valeur proposée au jeu : « {texteAttribut(proposition.valeur, 60)} » (colonne « {texteAttribut(proposition.colonne, 40)} »), appliquée au dépôt seulement si le champ n&apos;est pas déjà renseigné à l&apos;étape 1.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {apercu && apercu.mapping.avertissements.length > 0 && <ListeAvertissements liste={apercu.mapping.avertissements} titre="Avertissements de la correspondance" />}
    </div>
  );
}
