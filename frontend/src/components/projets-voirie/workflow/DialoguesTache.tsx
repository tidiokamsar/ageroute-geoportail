import { useId, useState } from "react";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { Input, Select } from "../../ui/Input";
import type { CorpsCreationTache, CorpsModifTache, CorpsStatutTache, RattachementReferent, Tache, TransitionTache } from "../../../lib/projetsVoirieWorkflowApi";
import {
  LIBELLE_PRIORITE, LIBELLE_STATUT_TACHE, PRIORITES_TACHE, RAPPEL_SEPARATION_WORKFLOW, SAISIE_TACHE_VIDE, classerErreurWorkflow, erreursTache, estUuid, justificationValide, libelleTransitionTache,
  type PrioriteTache, type SaisieTache,
} from "../../../lib/projetsVoirieWorkflow";

/**
 * Dialogues d'une tache : creation, modification, transition. La justification et la derogation suivent ce que le serveur annonce pour CETTE transition
 * (`justificationRequise`, `separation`) ; la validation exige un tiers, sauf derogation motivee d'un administrateur.
 */

export interface ChoixLie { id: string; libelle: string }

function Texte({ id, libelle, valeur, onChange, desactive, rows = 3, max = 2000, minimum = true }: { id: string; libelle: string; valeur: string; onChange: (v: string) => void; desactive: boolean; rows?: number; max?: number; minimum?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className={LIBELLE_CHAMP}>{libelle}</label>
      <textarea id={id} value={valeur} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={max} disabled={desactive} aria-describedby={minimum ? `${id}-n` : undefined} className={CHAMP_TEXTE} />
      {minimum && <Compteur id={`${id}-n`} texte={valeur} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------------

export function DialogueCreationTache({ userId, nomUtilisateur, referents, demandes, conflits, enLigne, onFermer, onValider }: {
  userId: string | undefined; nomUtilisateur: string | undefined; referents: RattachementReferent[]; demandes: ChoixLie[]; conflits: ChoixLie[]; enLigne: boolean; onFermer: () => void;
  onValider: (c: CorpsCreationTache) => Promise<unknown>;
}) {
  const id = useId();
  const [s, setS] = useState<SaisieTache>({ ...SAISIE_TACHE_VIDE, responsableId: userId ?? "" });
  const [autre, setAutre] = useState(false);
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const erreurs = erreursTache(s);
  const maj = (p: Partial<SaisieTache>) => setS((x) => ({ ...x, ...p }));
  const actifs = referents.filter((r) => r.actif && r.compte?.id);
  const valeurSelect = autre ? "__autre" : s.responsableId;
  function valider() {
    void envoyer(() => onValider({
      titre: s.titre.trim(), description: s.description.trim() || null, responsableId: s.responsableId.trim(), echeance: s.echeance || null, priorite: s.priorite, validationRequise: s.validationRequise,
      conflitId: s.lien === "CONFLIT" ? s.conflitId : null, demandeId: s.lien === "DEMANDE" ? s.demandeId : null, partagee: s.lien !== "AUCUN" && s.partagee,
    }));
  }
  return (
    <CadreDialogue
      titre="Nouvelle tâche" large
      description={<p>Une tâche a un responsable, une priorité et une échéance. Elle se lie à une demande ou à un dossier de conflit, jamais aux deux. Elle n&apos;ordonne aucun déplacement ni aucun travaux.</p>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Créer la tâche" libelleEnCours="Création…" onFermer={onFermer} onValider={valider} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-t`} className={LIBELLE_CHAMP}>Titre</label>
        <Input id={`${id}-t`} value={s.titre} onChange={(e) => maj({ titre: e.target.value })} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <Texte id={`${id}-d`} libelle="Description (facultatif)" valeur={s.description} onChange={(v) => maj({ description: v })} desactive={enCours} rows={2} max={4000} minimum={false} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-r`} className={LIBELLE_CHAMP}>Responsable</label>
          <Select id={`${id}-r`} value={valeurSelect} disabled={enCours} onChange={(e) => { if (e.target.value === "__autre") { setAutre(true); maj({ responsableId: "" }); } else { setAutre(false); maj({ responsableId: e.target.value }); } }} className="mt-1 border-gray-300">
            <option value="">Choisir un responsable</option>
            {userId && <option value={userId}>Moi-même{nomUtilisateur ? ` (${nomUtilisateur})` : ""}</option>}
            {actifs.filter((r) => r.compte?.id !== userId).map((r) => <option key={r.id} value={r.compte?.id ?? ""}>{r.compte?.nom ?? "Compte sans nom"} (référent{r.concessionnaire?.nom ? `, ${r.concessionnaire.nom}` : ""})</option>)}
            <option value="__autre">Un autre compte (saisir son identifiant)</option>
          </Select>
          {autre && (
            <div className="mt-1">
              <label htmlFor={`${id}-ra`} className="block text-xs font-medium text-gray-800">Identifiant du compte responsable (UUID)</label>
              <Input id={`${id}-ra`} value={s.responsableId} onChange={(e) => maj({ responsableId: e.target.value })} autoComplete="off" maxLength={64} disabled={enCours} className="border-gray-300" />
              <p className="text-xs text-gray-700">L&apos;interface ne liste pas tous les comptes : saisissez l&apos;identifiant fourni par un administrateur. Le serveur refuse un compte inconnu ou non habilité.</p>
            </div>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-p`} className={LIBELLE_CHAMP}>Priorité</label>
          <Select id={`${id}-p`} value={s.priorite} disabled={enCours} onChange={(e) => maj({ priorite: e.target.value as PrioriteTache })} className="mt-1 border-gray-300">
            {PRIORITES_TACHE.map((x) => <option key={x} value={x}>{LIBELLE_PRIORITE[x]}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor={`${id}-e`} className={LIBELLE_CHAMP}>Échéance (facultatif)</label>
          <Input id={`${id}-e`} type="date" value={s.echeance} onChange={(e) => maj({ echeance: e.target.value })} disabled={enCours} className="mt-1 border-gray-300" />
        </div>
        <div>
          <label htmlFor={`${id}-l`} className={LIBELLE_CHAMP}>Lien</label>
          <Select id={`${id}-l`} value={s.lien} disabled={enCours} onChange={(e) => maj({ lien: e.target.value as SaisieTache["lien"], demandeId: "", conflitId: "" })} className="mt-1 border-gray-300">
            <option value="AUCUN">Aucun lien</option>
            <option value="DEMANDE">Liée à une demande</option>
            <option value="CONFLIT">Liée à un dossier de conflit</option>
          </Select>
        </div>
      </div>
      {s.lien === "DEMANDE" && (
        <div>
          <label htmlFor={`${id}-ld`} className={LIBELLE_CHAMP}>Demande liée</label>
          <Select id={`${id}-ld`} value={s.demandeId} disabled={enCours} onChange={(e) => maj({ demandeId: e.target.value })} className="mt-1 border-gray-300">
            <option value="">Choisir une demande</option>
            {demandes.map((x) => <option key={x.id} value={x.id}>{x.libelle}</option>)}
          </Select>
          {demandes.length === 0 && <p className="text-xs text-gray-700">Aucune demande n&apos;est disponible : créez-en une d&apos;abord.</p>}
        </div>
      )}
      {s.lien === "CONFLIT" && (
        <div>
          <label htmlFor={`${id}-lc`} className={LIBELLE_CHAMP}>Dossier de conflit lié</label>
          <Select id={`${id}-lc`} value={s.conflitId} disabled={enCours} onChange={(e) => maj({ conflitId: e.target.value })} className="mt-1 border-gray-300">
            <option value="">Choisir un dossier</option>
            {conflits.map((x) => <option key={x.id} value={x.id}>{x.libelle}</option>)}
          </Select>
        </div>
      )}
      <label className="flex min-h-[44px] items-start gap-2 text-sm text-gray-900 xl:min-h-0">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={s.validationRequise} disabled={enCours} onChange={(e) => maj({ validationRequise: e.target.checked })} />
        <span>Exiger une validation par un tiers avant de la terminer (séparation des tâches)</span>
      </label>
      {s.lien !== "AUCUN" && (
        <label className="flex min-h-[44px] items-start gap-2 text-sm text-gray-900 xl:min-h-0">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={s.partagee} disabled={enCours} onChange={(e) => maj({ partagee: e.target.checked })} />
          <span>Partager cette tâche avec le référent du concessionnaire du dossier ou de la demande</span>
        </label>
      )}
    </CadreDialogue>
  );
}

// ---------------------------------------------------------------------------------------------------
// Modification
// ---------------------------------------------------------------------------------------------------

export function DialogueModifTache({ tache, userId, referents, enLigne, onFermer, onValider }: {
  tache: Tache; userId: string | undefined; referents: RattachementReferent[]; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsModifTache) => Promise<unknown>;
}) {
  const id = useId();
  const [titre, setTitre] = useState(tache.titre);
  const [description, setDescription] = useState(tache.description ?? "");
  const [echeance, setEcheance] = useState(tache.echeance?.slice(0, 10) ?? "");
  const [priorite, setPriorite] = useState<PrioriteTache>(tache.priorite ?? "NORMALE");
  const [partagee, setPartagee] = useState(tache.partagee);
  const [choix, setChoix] = useState("");
  const [autreId, setAutreId] = useState("");
  const responsable = choix === "__autre" ? autreId : choix;
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const corps: CorpsModifTache = {};
  if (titre.trim() !== tache.titre) corps.titre = titre.trim();
  if (description.trim() !== (tache.description ?? "")) corps.description = description.trim() || null;
  if (echeance !== (tache.echeance?.slice(0, 10) ?? "")) corps.echeance = echeance || null;
  if (tache.priorite && priorite !== tache.priorite) corps.priorite = priorite;
  if (partagee !== tache.partagee) corps.partagee = partagee;
  if (responsable.trim()) { corps.responsableId = responsable.trim(); corps.justification = j.trim(); }
  const aChange = Object.keys(corps).filter((k) => k !== "justification").length > 0;
  const erreurs: string[] = [];
  if (titre.trim() === "") erreurs.push("Le titre de la tâche est obligatoire.");
  if (responsable.trim() && !estUuid(responsable.trim())) erreurs.push("L'identifiant du nouveau responsable doit être un UUID.");
  if (responsable.trim() && !justificationValide(j)) erreurs.push("Changer de responsable exige une justification de 10 caractères au moins.");
  if (echeance !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(echeance)) erreurs.push("L'échéance doit être une date valide.");
  const actifs = referents.filter((r) => r.actif && r.compte?.id);
  return (
    <CadreDialogue
      titre="Modifier la tâche" large description={<p>Chaque modification est historisée, avec l&apos;avant et l&apos;après. Changer de responsable exige une justification.</p>}
      enCours={enCours} erreur={erreur} peutValider={aChange && erreurs.length === 0} aide={aChange ? erreurs : ["Aucune modification n'a été saisie."]} libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(corps))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-t`} className={LIBELLE_CHAMP}>Titre</label>
        <Input id={`${id}-t`} value={titre} onChange={(e) => setTitre(e.target.value)} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <Texte id={`${id}-d`} libelle="Description" valeur={description} onChange={setDescription} desactive={enCours} rows={2} max={4000} minimum={false} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-e`} className={LIBELLE_CHAMP}>Échéance</label>
          <Input id={`${id}-e`} type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} disabled={enCours} className="mt-1 border-gray-300" />
          <p className="mt-0.5 text-xs text-gray-700">Vider le champ retire l&apos;échéance.</p>
        </div>
        <div>
          <label htmlFor={`${id}-p`} className={LIBELLE_CHAMP}>Priorité</label>
          <Select id={`${id}-p`} value={priorite} disabled={enCours} onChange={(e) => setPriorite(e.target.value as PrioriteTache)} className="mt-1 border-gray-300">
            {PRIORITES_TACHE.map((x) => <option key={x} value={x}>{LIBELLE_PRIORITE[x]}</option>)}
          </Select>
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-r`} className={LIBELLE_CHAMP}>Nouveau responsable (facultatif)</label>
        <Select id={`${id}-r`} value={choix} disabled={enCours} onChange={(e) => setChoix(e.target.value)} className="mt-1 border-gray-300">
          <option value="">Inchangé : {tache.responsable?.nom ?? "responsable non communiqué"}</option>
          {userId && <option value={userId}>Moi-même</option>}
          {actifs.filter((r) => r.compte?.id !== userId).map((r) => <option key={r.id} value={r.compte?.id ?? ""}>{r.compte?.nom ?? "Compte sans nom"} (référent)</option>)}
          <option value="__autre">Un autre compte (saisir son identifiant)</option>
        </Select>
        {choix === "__autre" && (
          <div className="mt-1">
            <label htmlFor={`${id}-ra`} className="block text-xs font-medium text-gray-800">Identifiant du compte (UUID)</label>
            <Input id={`${id}-ra`} value={autreId} onChange={(e) => setAutreId(e.target.value)} autoComplete="off" maxLength={64} disabled={enCours} className="border-gray-300" />
          </div>
        )}
      </div>
      {responsable.trim() && <Texte id={`${id}-j`} libelle="Justification du changement de responsable (10 caractères minimum)" valeur={j} onChange={setJ} desactive={enCours} />}
      {tache.concessionnaire && (
        <label className="flex min-h-[44px] items-start gap-2 text-sm text-gray-900 xl:min-h-0">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={partagee} disabled={enCours} onChange={(e) => setPartagee(e.target.checked)} />
          <span>Partager cette tâche avec le référent du concessionnaire</span>
        </label>
      )}
    </CadreDialogue>
  );
}

// ---------------------------------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------------------------------

export function DialogueTransitionTache({ tache, transition, estAdmin, enLigne, onFermer, onValider }: {
  tache: Tache; transition: TransitionTache; estAdmin: boolean; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsStatutTache) => Promise<unknown>;
}) {
  const id = useId();
  const [j, setJ] = useState("");
  const [derogation, setDerogation] = useState("");
  const { enCours, erreur, envoyer, codesVus } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const libelle = libelleTransitionTache(tache.statut, transition.vers);
  const derogationVisible = estAdmin && transition.separation;
  const obligatoire = codesVus.has("SEPARATION_DES_TACHES");
  const peutValider = (!transition.justificationRequise || justificationValide(j)) && (derogation.trim() === "" || justificationValide(derogation)) && (!obligatoire || !derogationVisible || derogation.trim() === "" || justificationValide(derogation));
  return (
    <CadreDialogue
      titre={libelle}
      description={<>
        <p><strong>{tache.titre}</strong> : {LIBELLE_STATUT_TACHE[tache.statut]} vers {LIBELLE_STATUT_TACHE[transition.vers]}.</p>
        <p>Cet acte est consigné dans l&apos;historique avec votre nom et {transition.justificationRequise ? "votre justification" : "l'ancien et le nouvel état"}. Il n&apos;ordonne aucun travaux.</p>
        {transition.separation && <p role="note" className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-900">{RAPPEL_SEPARATION_WORKFLOW}</p>}
      </>}
      enCours={enCours} erreur={erreur} peutValider={peutValider} libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider({ vers: transition.vers, ...(j.trim() ? { justification: j.trim() } : {}), ...(derogationVisible && derogation.trim() ? { derogation: derogation.trim() } : {}) }))} enLigne={enLigne}
    >
      <Texte id={`${id}-j`} libelle={transition.justificationRequise ? "Justification (10 caractères minimum)" : "Justification (facultative)"} valeur={j} onChange={setJ} desactive={enCours} minimum={transition.justificationRequise} />
      {derogationVisible && (
        <div className="rounded border border-purple-300 bg-purple-50 p-2">
          <label htmlFor={`${id}-dg`} className={LIBELLE_CHAMP}>Dérogation à la séparation des tâches (réservée aux administrateurs){obligatoire ? " : motif obligatoire ici" : ", facultative"}</label>
          <p className="text-xs text-gray-800">À renseigner seulement si vous validez ce que vous avez vous-même soumis ou dont vous êtes responsable. Elle est tracée dans l&apos;historique et dans l&apos;audit.</p>
          <textarea id={`${id}-dg`} value={derogation} onChange={(e) => setDerogation(e.target.value)} rows={2} maxLength={1000} disabled={enCours} className={CHAMP_TEXTE} />
          {derogation.trim() !== "" && <Compteur id={`${id}-dgn`} texte={derogation} />}
        </div>
      )}
    </CadreDialogue>
  );
}
