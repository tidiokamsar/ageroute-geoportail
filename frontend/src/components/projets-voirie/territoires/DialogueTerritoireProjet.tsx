import { useCallback, useId, useState } from "react";
import { CadreDialogue, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { Select } from "../../ui/Input";
import { SelecteurTerritoire } from "./SelecteurTerritoire";
import { useReferentiel } from "../../../lib/projetsVoirieTerritoiresHooks";
import type { ProjetFiche } from "../../../lib/projetsVoirieApi";
import { classerErreurTerritoires, optionsDeChoix, type Territoire } from "../../../lib/projetsVoirieTerritoires";

/**
 * Modification du territoire et de la categorie d'un projet (PATCH /:id, lot T1). Seuls les champs changes partent. Le serveur refuse un
 * territoire d'une autre region que celle du projet (400 TERRITOIRE_REGION_INCOHERENTE) : un deplacement ne change jamais le perimetre.
 * Une categorie desactivee portee par le projet reste affichee (et conservee si l'on ne la change pas), mais n'est pas proposee.
 */
export function DialogueTerritoireProjet({ projet, enLigne, onFermer, onValider }: {
  projet: ProjetFiche; enLigne: boolean; onFermer: () => void;
  onValider: (corps: { territoireId?: string; categorieCode?: string | null }) => Promise<unknown>;
}) {
  const id = useId();
  const categories = useReferentiel("CATEGORIE_PROJET");
  const [territoire, setTerritoire] = useState<Territoire | null>(null);
  const [categorie, setCategorie] = useState(projet.categorieCode ?? "");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);

  const territoireChange = territoire !== null && territoire.id !== projet.territoireId;
  const categorieChange = categorie !== (projet.categorieCode ?? "");
  const corps = {
    ...(territoireChange && territoire ? { territoireId: territoire.id } : {}),
    ...(categorieChange ? { categorieCode: categorie || null } : {}),
  };
  const options = optionsDeChoix(categories.data?.valeurs, projet.categorieCode);
  // Revue m8 : ne proposer que les territoires de la region du projet (nationale : sans region) ; region inconnue (serveur ancien) : aucun filtre.
  const regionConnue = projet.regionId !== undefined;
  const memeRegion = useCallback((t: Territoire) => t.regionEffectiveId === (projet.regionId ?? null), [projet.regionId]);

  return (
    <CadreDialogue
      titre="Territoire et catégorie du projet"
      description={<>
        <p>Le nouveau territoire doit appartenir à la même région que le projet : changer de territoire ne déplace jamais un projet d&apos;une région à une autre. La commune et la préfecture du projet sont recalculées par le serveur.</p>
        <p>Changer de catégorie ne modifie pas les largeurs déjà enregistrées.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={territoireChange || categorieChange} libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      aide={["Choisissez un autre territoire ou une autre catégorie."]}
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(corps))} enLigne={enLigne} large
    >
      <SelecteurTerritoire
        libelle="Territoire" valeur={territoire?.id ?? projet.territoireId} courant={projet.territoire} actifsSeulement desactive={enCours}
        filtre={regionConnue ? memeRegion : undefined}
        aide={regionConnue ? "Seuls les territoires de la région du projet sont proposés." : undefined}
        onChange={(t) => setTerritoire(t)}
      />
      <div>
        <label htmlFor={`${id}-cat`} className={LIBELLE_CHAMP}>Catégorie de projet</label>
        <Select id={`${id}-cat`} value={categorie} onChange={(e) => setCategorie(e.target.value)} disabled={enCours || categories.isPending} className="mt-1 border-gray-300">
          <option value="">Sans catégorie</option>
          {options.map((o) => <option key={o.code} value={o.code} disabled={o.desactivee && o.code !== projet.categorieCode}>{o.libelle}</option>)}
        </Select>
        {categories.isError && <p role="alert" className="mt-0.5 text-xs text-red-700">Les catégories n&apos;ont pas pu être chargées : {classerErreurTerritoires(categories.error).message}</p>}
      </div>
    </CadreDialogue>
  );
}
