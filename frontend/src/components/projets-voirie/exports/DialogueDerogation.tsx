/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useMemo, useState } from "react";
import { Input } from "../../ui/Input";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { useComptesBeneficiaires } from "../../../lib/projetsVoirieExportsHooks";
import { filtrerComptes } from "../../../lib/projetsVoirieWorkflowApi";
import { LIBELLE_CONFIDENTIALITE, LIBELLE_ROLE, type Confidentialite, type RoleJeu } from "../../../lib/projetsVoirie";
import {
  DUREE_DEROGATION_DEFAUT_H, DUREE_DEROGATION_MAX_H, JUSTIFICATION_DEROGATION_MIN, beneficiairesProposables, classerErreurExports, jeuDerogeable, verifierSaisieDerogation,
} from "../../../lib/projetsVoirieExports";
import type { CorpsDerogation } from "../../../lib/projetsVoirieExportsApi";

/**
 * Octroi d'une derogation de confidentialite (ADMIN) : a une AUTRE personne que soi (separation des taches : l'administrateur connecte n'est pas dans
 * la liste, et le serveur le refuse en 409 de toute facon), justifiee (20 caracteres), bornee dans le temps (1 a 168 heures), pour des jeux nommes
 * AUTORISE d'un niveau confidentiel. A usage unique : un export de son beneficiaire, sur ce projet.
 */

export interface JeuDerogation { id: string; nomFichier: string; role: RoleJeu; version: number; statut: string; confidentialite: Confidentialite }

export function DialogueDerogation({ jeux, compteId, enLigne, onFermer, onValider }: {
  jeux: readonly JeuDerogation[]; compteId: string | undefined; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsDerogation) => Promise<unknown>;
}) {
  const id = useId();
  const comptes = useComptesBeneficiaires(true);
  const [choisis, setChoisis] = useState<string[]>([]);
  const [beneficiaireId, setBeneficiaireId] = useState<string | null>(null);
  const [recherche, setRecherche] = useState("");
  const [justification, setJustification] = useState("");
  const [duree, setDuree] = useState(String(DUREE_DEROGATION_DEFAUT_H));
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurExports);
  const eligibles = jeux.filter(jeuDerogeable);
  const dureeH = /^\d{1,3}$/.test(duree.trim()) ? Number(duree.trim()) : null;
  const erreurs = verifierSaisieDerogation({ jeuxIds: choisis, beneficiaireId, justification, dureeHeures: dureeH }, compteId);
  const candidats = useMemo(() => {
    const tous = beneficiairesProposables(comptes.data ?? [], compteId);
    const ids = new Set(filtrerComptes(tous.map((x) => ({ id: x.compte.id, nom: x.compte.nom, email: x.compte.email, modules: x.compte.modules })), recherche).map((c) => c.id));
    return tous.filter((x) => ids.has(x.compte.id));
  }, [comptes.data, compteId, recherche]);

  return (
    <CadreDialogue
      titre="Accorder une dérogation de confidentialité"
      description={<>
        <p>Une dérogation permet à <strong>une autre personne</strong>, nommément, d&apos;exporter une seule fois le tracé GeoJSON de jeux confidentiels de ce projet. Elle est consignée (vous, le bénéficiaire, la justification, les jeux) et expire d&apos;elle-même.</p>
        <p>Séparation des tâches : vous ne pouvez pas vous choisir comme bénéficiaire.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Accorder la dérogation" libelleEnCours="Enregistrement…"
      onFermer={onFermer} enLigne={enLigne} large
      onValider={() => void envoyer(() => onValider({ jeuxIds: choisis, beneficiaireId: beneficiaireId as string, justification: justification.trim(), dureeHeures: dureeH as number }))}
    >
      <fieldset className="space-y-1 rounded-md border border-gray-300 p-2">
        <legend className="px-1 text-sm font-medium text-gray-900">Jeux couverts (autorisés et confidentiels)</legend>
        {eligibles.length === 0 ? (
          <p className="text-xs text-gray-700">Aucun jeu de ce projet n&apos;est à la fois autorisé et d&apos;un niveau confidentiel (« confidentiel concessionnaire » ou « infrastructure sensible ») : les autres s&apos;exportent sans dérogation, ou ne s&apos;exportent pas du tout s&apos;ils ne sont pas autorisés.</p>
        ) : eligibles.map((j) => (
          <label key={j.id} className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm text-gray-900 xl:min-h-0">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={choisis.includes(j.id)} disabled={enCours}
              onChange={(e) => setChoisis((x) => (e.target.checked ? [...x, j.id] : x.filter((y) => y !== j.id)))} />
            <span className="break-words">{j.nomFichier}, v{j.version} <span className="text-xs text-gray-700">({LIBELLE_ROLE[j.role]}, {LIBELLE_CONFIDENTIALITE[j.confidentialite]})</span></span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1 rounded-md border border-gray-300 p-2">
        <legend className="px-1 text-sm font-medium text-gray-900">Bénéficiaire</legend>
        <label htmlFor={`${id}-q`} className="block text-xs font-medium text-gray-900">Rechercher un compte (nom ou courriel)</label>
        <Input id={`${id}-q`} type="search" value={recherche} maxLength={100} autoComplete="off" disabled={enCours} onChange={(e) => setRecherche(e.target.value)} className="border-gray-300" />
        {comptes.isPending && <p role="status" className="text-xs text-gray-700">Chargement des comptes administrateurs et gestionnaires…</p>}
        {comptes.isError && <p role="alert" className="text-xs text-red-900">{classerErreurExports(comptes.error).message}</p>}
        {comptes.isSuccess && (
          <div role="region" aria-label="Comptes bénéficiaires possibles, liste défilante" tabIndex={0} className="max-h-48 space-y-0.5 overflow-auto rounded border border-gray-200 p-1">
            {candidats.length === 0 && <p className="p-1 text-xs text-gray-700">Aucun autre compte administrateur ou gestionnaire actif ne correspond.</p>}
            {candidats.map(({ compte, proposable, raison }) => (
              <label key={compte.id} className={`flex min-h-[44px] items-start gap-2 rounded p-1 text-sm xl:min-h-0 ${proposable ? "cursor-pointer text-gray-900 hover:bg-gray-50" : "text-gray-700"}`}>
                <input type="radio" name={`${id}-b`} className="mt-1 h-4 w-4" checked={beneficiaireId === compte.id} disabled={enCours || !proposable} onChange={() => setBeneficiaireId(compte.id)} />
                <span className="min-w-0 break-words">{compte.nom ?? "Compte sans nom"} <span className="text-xs">({compte.role === "ADMIN" ? "administrateur" : "gestionnaire"}{compte.email ? `, ${compte.email}` : ""})</span>{raison && <span className="block text-xs">Non proposable : {raison}.</span>}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-700">Le serveur vérifie aussi que le périmètre du bénéficiaire couvre la région du projet.</p>
      </fieldset>

      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification</label>
        <textarea id={`${id}-j`} value={justification} maxLength={2000} rows={3} disabled={enCours} aria-describedby={`${id}-c`} onChange={(e) => setJustification(e.target.value)} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-c`} texte={justification} min={JUSTIFICATION_DEROGATION_MIN} />
      </div>
      <div>
        <label htmlFor={`${id}-d`} className={LIBELLE_CHAMP}>Durée de validité, en heures (1 à {DUREE_DEROGATION_MAX_H})</label>
        <Input id={`${id}-d`} inputMode="numeric" value={duree} maxLength={3} disabled={enCours} onChange={(e) => setDuree(e.target.value)} className="mt-1 w-32 border-gray-300" />
      </div>
    </CadreDialogue>
  );
}
