import { useId, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input, Select } from "../ui/Input";
import { useCreerProjet } from "../../lib/projetsVoirieHooks";
import { useReferentiel } from "../../lib/projetsVoirieTerritoiresHooks";
import type { ProjetFiche } from "../../lib/projetsVoirieApi";
import { MOTIF_CODE_PROJET, erreurLargeurs, lireSaisieNombre, type ErreurPv } from "../../lib/projetsVoirie";
import { classerErreurTerritoires, detailsParChamp, largeursDeCategorie, optionsDeChoix, type Territoire } from "../../lib/projetsVoirieTerritoires";
import { SelecteurTerritoire } from "./territoires/SelecteurTerritoire";

/**
 * Creation d'un projet (lot T1) : code, nom, TERRITOIRE (obligatoire, choisi dans le perimetre du compte), categorie facultative (referentiel
 * CATEGORIE_PROJET, chargee depuis l'API) et largeurs. La commune et la prefecture sont deduites du territoire par le serveur.
 *
 * Largeurs (revue UI-C m2) : aucune valeur par defaut n'est codee ici. Sans saisie, rien n'est envoye et le SERVEUR applique son defaut
 * (theorique) ; avec une categorie, ses largeurs sont proposees telles quelles (sans arrondi) et, inchangees, laissees au serveur (source unique).
 * Une largeur saisie seule est refusee : les deux, ou aucune.
 */

const VIDE = { emprise: "", chaussee: "" };
/** Nombre en saisie francaise, SANS arrondi (une categorie a 7,125 m reste 7,125 m). */
const versTexte = (n: number) => String(n).replace(".", ",");

export function DialogueProjet({ onFermer, onCree, enLigne }: { onFermer: () => void; onCree: (p: ProjetFiche) => void; enLigne: boolean }) {
  const id = useId();
  const creer = useCreerProjet();
  const categories = useReferentiel("CATEGORIE_PROJET");
  const [v, setV] = useState({ code: "", nom: "", categorie: "", emprise: VIDE.emprise, chaussee: VIDE.chaussee });
  const [territoire, setTerritoire] = useState<Territoire | null>(null);
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreurServeur, setErreurServeur] = useState<ErreurPv | null>(null);

  const maj = (p: Partial<typeof v>) => { setV((x) => ({ ...x, ...p })); setErreurs({}); setErreurServeur(null); };
  const valeursCategorie = categories.data?.valeurs;
  const largeursCat = v.categorie ? largeursDeCategorie(valeursCategorie?.find((c) => c.code === v.categorie)) : null;

  function choisirCategorie(code: string) {
    const l = code ? largeursDeCategorie(valeursCategorie?.find((c) => c.code === code)) : null;
    maj({ categorie: code, ...(l ? { emprise: versTexte(l.largeurEmpriseM), chaussee: versTexte(l.largeurChausseeM) } : code ? {} : VIDE) });
  }

  async function soumettre() {
    const e: Record<string, string> = {};
    const code = v.code.trim().toUpperCase();
    if (!MOTIF_CODE_PROJET.test(code)) e.code = "Le code compte 2 à 64 caractères : majuscules, chiffres, tiret ou souligné, en commençant par une lettre ou un chiffre (exemple : VOIRIE-2026-001).";
    if (v.nom.trim().length < 3) e.nom = "Saisissez le nom du projet (3 caractères minimum).";
    if (!territoire) e.territoireId = "Choisissez le territoire du projet : il est obligatoire.";
    const emprise = lireSaisieNombre(v.emprise);
    const chaussee = lireSaisieNombre(v.chaussee);
    const aucune = v.emprise.trim() === "" && v.chaussee.trim() === "";
    if (!aucune) {
      const el = v.emprise.trim() === "" || v.chaussee.trim() === "" ? "Saisissez les deux largeurs, ou aucune (le serveur applique alors ses largeurs par défaut)." : erreurLargeurs(emprise, chaussee);
      if (el) e.largeurs = el;
    }
    setErreurs(e);
    if (Object.keys(e).length > 0 || !territoire) return;
    // Aucune saisie, ou largeurs de la categorie gardees telles quelles (comparees aux VALEURS lues, pas a un texte arrondi) : rien n'est envoye.
    const largeursDeLaCategorie = aucune || (!!largeursCat && largeursCat.largeurEmpriseM === emprise && largeursCat.largeurChausseeM === chaussee);
    try {
      const p = await creer.mutateAsync({
        code, nom: v.nom.trim(), territoireId: territoire.id,
        ...(v.categorie ? { categorieCode: v.categorie } : {}),
        ...(largeursDeLaCategorie || emprise === null || chaussee === null ? {} : { largeurEmpriseM: emprise, largeurChausseeM: chaussee }),
      });
      onCree(p);
    } catch (err) {
      const c = classerErreurTerritoires(err);
      setErreurServeur(c);
      const champs: Record<string, string> = {};
      for (const [k, m] of Object.entries(detailsParChamp(err))) if (m[0]) champs[k] = m[0];
      if (c.code === "TERRITOIRE_REQUIS" || c.code === "TERRITOIRE_INTROUVABLE" || c.code === "TERRITOIRE_REGION_INCOHERENTE") champs.territoireId = c.message;
      if (Object.keys(champs).length > 0) setErreurs(champs);
    }
  }

  const champ = (cle: string, libelle: string, valeur: string, onChange: (s: string) => void, extra?: { aide?: string; erreur?: string; max?: number; mode?: "decimal" }) => (
    <div>
      <label htmlFor={`${id}-${cle}`} className="block text-sm font-medium text-gray-900">{libelle}</label>
      <Input id={`${id}-${cle}`} value={valeur} onChange={(e) => onChange(e.target.value)} disabled={creer.isPending} maxLength={extra?.max ?? 120} autoComplete="off" inputMode={extra?.mode}
        aria-invalid={extra?.erreur ? true : undefined} aria-describedby={extra?.erreur ? `${id}-${cle}-err` : extra?.aide ? `${id}-${cle}-aide` : undefined} className="mt-1 border-gray-300" />
      {extra?.aide && !extra.erreur && <p id={`${id}-${cle}-aide`} className="mt-0.5 text-xs text-gray-600">{extra.aide}</p>}
      {extra?.erreur && <p id={`${id}-${cle}-err`} role="alert" className="mt-0.5 text-xs text-red-700">{extra.erreur}</p>}
    </div>
  );

  const options = optionsDeChoix(valeursCategorie, v.categorie || null);

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !creer.isPending) onFermer(); }}>
      <DialogContent masquerCroix className="max-h-[92vh] max-w-xl overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle className="text-base font-semibold text-primary">Nouveau projet de voirie et réseaux</DialogTitle>
        <DialogDescription className="text-sm text-gray-700">Un projet réunit un plan d&apos;axes de travaux, les réseaux de concessionnaires et les limites de route, dans un territoire. Les données se chargent ensuite depuis la page du projet.</DialogDescription>
        <form className="space-y-3" aria-label="Nouveau projet" noValidate onSubmit={(ev) => { ev.preventDefault(); void soumettre(); }}>
          {champ("code", "Code du projet", v.code, (s) => maj({ code: s }), { aide: "Identifiant unique, par exemple VOIRIE-2026-001.", erreur: erreurs.code, max: 60 })}
          {champ("nom", "Nom du projet", v.nom, (s) => maj({ nom: s }), { erreur: erreurs.nom, max: 200 })}
          <SelecteurTerritoire
            libelle="Territoire du projet (obligatoire)" valeur={territoire?.id ?? null} actifsSeulement desactive={creer.isPending}
            aide="Seuls les territoires actifs de votre périmètre sont proposés. La commune et la préfecture du projet en sont déduites."
            onChange={(t) => { setTerritoire(t); setErreurs({}); setErreurServeur(null); }} erreur={erreurs.territoireId}
          />
          <div>
            <label htmlFor={`${id}-categorie`} className="block text-sm font-medium text-gray-900">Catégorie de projet (facultatif)</label>
            <Select id={`${id}-categorie`} value={v.categorie} onChange={(e) => choisirCategorie(e.target.value)} disabled={creer.isPending || categories.isPending} aria-describedby={`${id}-categorie-aide`} className="mt-1 border-gray-300">
              <option value="">{categories.isPending ? "Chargement des catégories…" : "Sans catégorie"}</option>
              {options.map((o) => <option key={o.code} value={o.code} disabled={o.desactivee}>{o.libelle}</option>)}
            </Select>
            <p id={`${id}-categorie-aide`} className="mt-0.5 text-xs text-gray-600">Une catégorie propose ses largeurs d&apos;emprise et de chaussée ; elles restent modifiables.</p>
            {categories.isError && <p role="alert" className="mt-0.5 text-xs text-red-700">Les catégories n&apos;ont pas pu être chargées : {classerErreurTerritoires(categories.error).message} Le projet peut être créé sans catégorie.</p>}
          </div>
          <fieldset className="space-y-2 rounded-md border border-gray-200 p-3">
            <legend className="px-1 text-sm font-semibold text-navy">Largeurs de calcul (théoriques)</legend>
            <p className="text-xs text-gray-700">
              {largeursCat ? "Largeurs de la catégorie choisie, " : "Laissez vide : le serveur applique ses largeurs par défaut, "}<strong>théoriques</strong> tant qu&apos;un administrateur ne les a pas validées. Modifiables ensuite.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {champ("chaussee", "Chaussée (m)", v.chaussee, (s) => maj({ chaussee: s }), { max: 8, mode: "decimal" })}
              {champ("emprise", "Emprise (m)", v.emprise, (s) => maj({ emprise: s }), { max: 8, mode: "decimal" })}
            </div>
            {erreurs.largeurs && <p role="alert" className="text-xs text-red-700">{erreurs.largeurs}</p>}
          </fieldset>
          {erreurServeur && <p role="alert" data-code={erreurServeur.code ?? undefined} className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">{erreurServeur.message}</p>}
          {!enLigne && <p role="alert" className="text-sm text-amber-900">Vous êtes hors ligne : la création a besoin du réseau.</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" className="min-h-[44px] xl:min-h-9" disabled={creer.isPending} onClick={onFermer}>Annuler</Button>
            <Button type="submit" className="min-h-[44px] xl:min-h-9" disabled={creer.isPending || !enLigne}>{creer.isPending ? "Création…" : "Créer le projet"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
