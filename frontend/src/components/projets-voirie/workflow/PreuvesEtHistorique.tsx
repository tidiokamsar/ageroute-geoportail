/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useState } from "react";
import { CadreDialogue, CHAMP_TEXTE, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { Input, Select } from "../../ui/Input";
import { BadgeSimple, nomPersonne } from "./commun";
import { texteValeur } from "../FicheObjet";
import type { EntreeHistoriqueWorkflow, PreuveWorkflow } from "../../../lib/projetsVoirieWorkflowApi";
import {
  LIBELLE_STATUT_DEMANDE, LIBELLE_STATUT_RECOLEMENT, LIBELLE_STATUT_TACHE, LIBELLE_TYPE_PREUVE_WORKFLOW, MENTION_PREUVES, SAISIE_PREUVE_VIDE, classerErreurWorkflow, corpsPreuve, erreursPreuve,
  partageeImposee, typesPreuvePermis, type CorpsPreuveWorkflow, type ProfilEffectif, type SaisiePreuve, type TypePreuveWorkflow,
} from "../../../lib/projetsVoirieWorkflow";
import { formaterDateHeure } from "../../../lib/projetsVoirieConflits";
import { formaterTaille } from "../../../lib/projetsVoirie";

/**
 * Preuves (references et empreintes, JAMAIS un fichier) et historique en ajout seul. Tout est rendu en TEXTE : une reference n'est jamais un lien,
 * qu'elle ressemble a une adresse ou non (aucun `<a>`, aucun HTML d'un contenu saisi).
 */

/** Entrees de la reponse que cette version ne sait pas lire : dites, jamais tues (meme regle que les listes paginees). */
export function AvertissementIgnores({ ignores, sujet }: { ignores: number; sujet: string }) {
  if (ignores <= 0) return null;
  return <p role="alert" data-testid={`ignores-${sujet}`} className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{ignores} élément(s) de la réponse du serveur n&apos;ont pas pu être lus (forme ou type inconnu de cette version de l&apos;interface) et ne sont pas affichés.</p>;
}

export function ListePreuves({ preuves, ignores = 0 }: { preuves: PreuveWorkflow[]; ignores?: number }) {
  if (preuves.length === 0) return <><AvertissementIgnores ignores={ignores} sujet="preuves" /><p className="text-xs text-gray-700">Aucune preuve enregistrée.</p></>;
  return (
    <>
    <AvertissementIgnores ignores={ignores} sujet="preuves" />
    <ol aria-label="Preuves" className="space-y-1.5">
      {preuves.map((p) => (
        <li key={p.id} data-preuve-id={p.id} className="space-y-0.5 rounded border border-gray-200 p-1.5 text-xs text-gray-900">
          <p className="flex flex-wrap items-center gap-1">
            <strong>{LIBELLE_TYPE_PREUVE_WORKFLOW[p.type]}</strong>
            <BadgeSimple classes={p.partagee ? "border-blue-300 bg-blue-50 text-blue-900" : "border-gray-400 bg-white text-gray-900"} donnee={p.partagee ? "partagee" : "interne"}>{p.partagee ? "Partagée avec le référent" : "Interne à AGEROUTE"}</BadgeSimple>
          </p>
          <p className="whitespace-pre-wrap break-words">{p.texte}</p>
          {p.reference && <p className="break-all text-[11px] text-gray-800">Référence (texte, jamais suivie) : {p.reference}</p>}
          {(p.nomFichier || p.sha256 || p.tailleOctets !== null) && (
            <p className="break-all text-[11px] text-gray-800">
              {p.nomFichier ? `Fichier déclaré : ${p.nomFichier}` : "Fichier déclaré sans nom"}{p.tailleOctets !== null ? `, ${formaterTaille(p.tailleOctets)}` : ""}
              {p.sha256 ? ` · SHA-256 ${p.sha256.slice(0, 16)}…` : ""}
              {" "}(aucun fichier n&apos;est stocké par l&apos;application)
            </p>
          )}
          <p className="text-[11px] text-gray-700">{nomPersonne(p.auteur, "auteur non communiqué")}{p.auteurProfil ? ` (${p.auteurProfil.toLowerCase()})` : ""} · {formaterDateHeure(p.createdAt)}</p>
        </li>
      ))}
    </ol>
    </>
  );
}

export function DialoguePreuveWorkflow({ profil, enLigne, onFermer, onValider }: {
  profil: ProfilEffectif | null; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsPreuveWorkflow) => Promise<unknown>;
}) {
  const id = useId();
  const types = typesPreuvePermis(profil);
  const imposee = partageeImposee(profil);
  const [s, setS] = useState<SaisiePreuve>({ ...SAISIE_PREUVE_VIDE, type: types[0] });
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const erreurs = erreursPreuve(s);
  const maj = (p: Partial<SaisiePreuve>) => setS((x) => ({ ...x, ...p }));
  const champ = (cle: "reference" | "nomFichier" | "sha256" | "tailleOctets", libelle: string, max: number, aide?: string) => (
    <div>
      <label htmlFor={`${id}-${cle}`} className={LIBELLE_CHAMP}>{libelle}</label>
      <Input id={`${id}-${cle}`} value={s[cle]} maxLength={max} autoComplete="off" disabled={enCours} inputMode={cle === "tailleOctets" ? "numeric" : undefined}
        onChange={(e) => maj({ [cle]: e.target.value } as Partial<SaisiePreuve>)} aria-describedby={aide ? `${id}-${cle}-aide` : undefined} className="mt-1 border-gray-300" />
      {aide && <p id={`${id}-${cle}-aide`} className="mt-0.5 text-xs text-gray-700">{aide}</p>}
    </div>
  );
  return (
    <CadreDialogue
      titre="Ajouter une preuve" large
      description={<><p>{MENTION_PREUVES}</p><p>Une preuve s&apos;ajoute et ne se modifie pas ni ne se supprime : elle reste dans l&apos;historique.</p></>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Ajouter la preuve" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(corpsPreuve(s, profil)))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-type`} className={LIBELLE_CHAMP}>Type de preuve</label>
        <Select id={`${id}-type`} value={s.type} disabled={enCours} onChange={(e) => maj({ type: e.target.value as TypePreuveWorkflow })} className="mt-1 border-gray-300">
          {types.map((t) => <option key={t} value={t}>{LIBELLE_TYPE_PREUVE_WORKFLOW[t]}</option>)}
        </Select>
      </div>
      <div>
        <label htmlFor={`${id}-texte`} className={LIBELLE_CHAMP}>Texte de la preuve (ce que la pièce atteste et où la retrouver)</label>
        <textarea id={`${id}-texte`} value={s.texte} onChange={(e) => maj({ texte: e.target.value })} rows={3} maxLength={4000} disabled={enCours} className={CHAMP_TEXTE} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {champ("reference", "Référence de la pièce (facultatif)", 500, "Un texte qui localise la pièce : numéro de courrier, chemin d'archivage. Jamais ouvert ni suivi.")}
        {champ("nomFichier", "Nom du fichier déclaré (facultatif)", 255)}
        {champ("sha256", "Empreinte SHA-256 (facultatif)", 64, "64 caractères hexadécimaux, calculés hors application.")}
        {champ("tailleOctets", "Taille déclarée en octets (facultatif)", 10)}
      </div>
      {imposee === null ? (
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
          <input type="checkbox" className="h-4 w-4" checked={s.partagee} disabled={enCours} onChange={(e) => maj({ partagee: e.target.checked })} />
          Visible du référent du concessionnaire (sinon, note interne à AGEROUTE)
        </label>
      ) : (
        <p className="text-xs text-gray-800">{imposee ? "Cette preuve sera partagée avec AGEROUTE : c'est la règle pour un référent." : "Cette preuve restera interne : c'est la règle pour un agent de terrain."}</p>
      )}
    </CadreDialogue>
  );
}

// ---------------------------------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------------------------------

const LIBELLE_ACTION: Record<string, string> = { CREATION: "Création", MODIFICATION: "Modification", STATUT: "Changement d'état", PREUVE: "Preuve ajoutée" };
const LIBELLE_CHAMP_HISTORIQUE: Record<string, string> = {
  objet: "Objet", description: "Description", echeance: "Échéance", jeuRecuId: "Jeu reçu lié", constat: "Constat", ecarts: "Écarts", dateRecolement: "Date du récolement", titre: "Titre",
  priorite: "Priorité", responsableId: "Responsable (identifiant)", partagee: "Partagée avec le référent", concessionnaireId: "Concessionnaire (identifiant)",
};
const libelleStatut = (s: string | null): string => (s ? LIBELLE_STATUT_DEMANDE[s as keyof typeof LIBELLE_STATUT_DEMANDE] ?? LIBELLE_STATUT_TACHE[s as keyof typeof LIBELLE_STATUT_TACHE] ?? LIBELLE_STATUT_RECOLEMENT[s as keyof typeof LIBELLE_STATUT_RECOLEMENT] ?? s : "création");
const texteChamp = (v: unknown): string => (v === null || v === undefined || v === "" ? "vide" : texteValeur(v));

/** Historique en ajout seul : action, acteur et profil, etats, justification, et les champs AVANT et APRES d'une modification. `null` : le serveur ne l'envoie pas a ce profil. */
export function HistoriqueWorkflow({ historique, ignores = 0 }: { historique: EntreeHistoriqueWorkflow[] | null; ignores?: number }) {
  if (historique === null) return <p data-testid="historique-non-communique" className="text-xs text-gray-700">L&apos;historique n&apos;est communiqué qu&apos;aux personnes qui décident pour AGEROUTE : il n&apos;est pas disponible pour votre profil.</p>;
  if (historique.length === 0) return <><AvertissementIgnores ignores={ignores} sujet="historique" /><p className="text-xs text-gray-700">Aucune entrée d&apos;historique.</p></>;
  return (
    <>
    <AvertissementIgnores ignores={ignores} sujet="historique" />
    <div role="region" aria-label="Historique, liste défilante" tabIndex={0} className="max-h-72 overflow-auto">
      <ol className="space-y-1.5">
        {historique.map((h) => {
          const champs = [...new Set([...Object.keys(h.avant ?? {}), ...Object.keys(h.apres ?? {})])];
          return (
            <li key={h.id} data-historique-id={h.id} className="rounded border border-gray-200 p-1.5 text-xs text-gray-900">
              <p className="font-medium">{LIBELLE_ACTION[h.action] ?? h.action}{!(h.action in LIBELLE_ACTION) ? " (action inconnue de cette version)" : ""}</p>
              <p className="text-[11px] text-gray-700">{formaterDateHeure(h.createdAt)} · {nomPersonne(h.acteur, "acteur non communiqué")}{h.acteurProfil ? ` (${h.acteurProfil.toLowerCase()})` : ""}</p>
              {(h.ancienStatut || h.nouveauStatut) && <p>{libelleStatut(h.ancienStatut)} vers {libelleStatut(h.nouveauStatut)}</p>}
              {h.justification && <p className="whitespace-pre-wrap break-words">Justification : {h.justification}</p>}
              {champs.length > 0 && (
                <table className="mt-1 w-full text-[11px]">
                  <caption className="sr-only">Champs modifiés, avant et après</caption>
                  <thead><tr className="text-left text-gray-700"><th scope="col" className="pr-2 font-medium">Champ</th><th scope="col" className="pr-2 font-medium">Avant</th><th scope="col" className="font-medium">Après</th></tr></thead>
                  <tbody>
                    {champs.map((c) => (
                      <tr key={c} className="align-top">
                        <th scope="row" className="pr-2 text-left font-normal text-gray-800">{LIBELLE_CHAMP_HISTORIQUE[c] ?? c}</th>
                        <td className="break-words pr-2">{texteChamp(h.avant?.[c])}</td>
                        <td className="break-words">{texteChamp(h.apres?.[c])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {h.autres && (
                <details className="text-[11px] text-gray-700">
                  <summary className="cursor-pointer">Données de l&apos;événement</summary>
                  <pre className="whitespace-pre-wrap break-all">{texteValeur(h.autres)}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </div>
    </>
  );
}
