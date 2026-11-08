import { useId, useState } from "react";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { Input, Select } from "../../ui/Input";
import type { Concessionnaire } from "../../../lib/projetsVoirieApi";
import type { CorpsCreationDemande, CorpsModifDemande, CorpsStatutDemande, Demande, JeuVue } from "../../../lib/projetsVoirieWorkflowApi";
import {
  LIBELLE_ENVOI_HORS_APPLICATION, MENTION_AUCUN_ENVOI, aujourdhuiUtc, classerErreurWorkflow, erreursDemande, erreursEnvoi, erreursReception, justificationValide,
  type SaisieDemande, type SaisieEnvoi, type SaisieReception,
} from "../../../lib/projetsVoirieWorkflow";
import { formaterDate } from "../../../lib/projetsVoirie";

/**
 * Dialogues d'une demande de donnees. L'envoi N'EST PAS fait par l'application : « Enregistrer l'envoi » consigne un envoi deja fait par une personne
 * (canal, date, reference, interlocuteur). Aucun champ ne sert a composer ni a transmettre un message.
 */

const CANAUX = ["Courriel", "Courrier", "Remise en main propre", "Messagerie professionnelle", "Plateforme du concessionnaire"];

function Justification({ id, valeur, onChange, libelle, desactive }: { id: string; valeur: string; onChange: (v: string) => void; libelle: string; desactive: boolean }) {
  return (
    <div>
      <label htmlFor={id} className={LIBELLE_CHAMP}>{libelle} (10 caractères minimum)</label>
      <textarea id={id} value={valeur} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={2000} disabled={desactive} aria-describedby={`${id}-n`} className={CHAMP_TEXTE} />
      <Compteur id={`${id}-n`} texte={valeur} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------------

export function DialogueCreationDemande({ concessionnaires, enLigne, onFermer, onValider }: {
  concessionnaires: Concessionnaire[]; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsCreationDemande) => Promise<unknown>;
}) {
  const id = useId();
  const [s, setS] = useState<SaisieDemande>({ concessionnaireId: "", objet: "", description: "", echeance: "" });
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const erreurs = erreursDemande(s, true);
  const maj = (p: Partial<SaisieDemande>) => setS((x) => ({ ...x, ...p }));
  return (
    <CadreDialogue
      titre="Nouvelle demande de données"
      description={<><p>La demande est créée en <strong>brouillon</strong>. {MENTION_AUCUN_ENVOI}</p></>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Créer le brouillon" libelleEnCours="Création…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider({ concessionnaireId: s.concessionnaireId, objet: s.objet.trim(), description: s.description.trim() || null, echeance: s.echeance || null }))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-c`} className={LIBELLE_CHAMP}>Concessionnaire</label>
        <Select id={`${id}-c`} value={s.concessionnaireId} disabled={enCours} onChange={(e) => maj({ concessionnaireId: e.target.value })} className="mt-1 border-gray-300">
          <option value="">Choisir un concessionnaire</option>
          {concessionnaires.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
        </Select>
        <p className="mt-0.5 text-xs text-gray-700">Le concessionnaire d&apos;une demande ne change plus ensuite.</p>
      </div>
      <div>
        <label htmlFor={`${id}-o`} className={LIBELLE_CHAMP}>Objet de la demande</label>
        <Input id={`${id}-o`} value={s.objet} onChange={(e) => maj({ objet: e.target.value })} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <div>
        <label htmlFor={`${id}-d`} className={LIBELLE_CHAMP}>Description (facultatif)</label>
        <textarea id={`${id}-d`} value={s.description} onChange={(e) => maj({ description: e.target.value })} rows={3} maxLength={4000} disabled={enCours} className={CHAMP_TEXTE} />
      </div>
      <div>
        <label htmlFor={`${id}-e`} className={LIBELLE_CHAMP}>Échéance de réponse (facultatif)</label>
        <Input id={`${id}-e`} type="date" value={s.echeance} onChange={(e) => maj({ echeance: e.target.value })} disabled={enCours} className="mt-1 border-gray-300" />
      </div>
    </CadreDialogue>
  );
}

// ---------------------------------------------------------------------------------------------------
// Modification
// ---------------------------------------------------------------------------------------------------

/** Ce qui se modifie depend de l'etat : brouillon (objet, description, echeance), envoyee (echeance avec justification), recue (jeu lie). */
export function DialogueModifDemande({ demande, jeuxLiables, enLigne, onFermer, onValider }: {
  demande: Demande; jeuxLiables: JeuVue[]; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsModifDemande) => Promise<unknown>;
}) {
  const id = useId();
  const [s, setS] = useState<SaisieDemande>({ concessionnaireId: demande.concessionnaire?.id ?? "", objet: demande.objet, description: demande.description ?? "", echeance: demande.echeance?.slice(0, 10) ?? "" });
  const [jeu, setJeu] = useState(demande.reception?.jeu?.id ?? "");
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const brouillon = demande.statut === "BROUILLON";
  const envoyee = demande.statut === "ENVOYEE";
  const recue = demande.statut === "RECUE";
  const erreurs = [...erreursDemande(s, false), ...(envoyee && !justificationValide(j) ? ["La justification de la modification d'échéance doit faire au moins 10 caractères."] : [])];
  const echeanceInitiale = demande.echeance?.slice(0, 10) ?? "";
  const corps: CorpsModifDemande = {};
  if (brouillon) {
    if (s.objet.trim() !== demande.objet) corps.objet = s.objet.trim();
    if (s.description.trim() !== (demande.description ?? "")) corps.description = s.description.trim() || null;
    if (s.echeance !== echeanceInitiale) corps.echeance = s.echeance || null;
  } else if (envoyee) {
    if (s.echeance !== echeanceInitiale) { corps.echeance = s.echeance || null; corps.justification = j.trim(); }
  } else if (recue && jeu && jeu !== (demande.reception?.jeu?.id ?? "")) corps.jeuRecuId = jeu;
  const aChange = Object.keys(corps).filter((k) => k !== "justification").length > 0;
  return (
    <CadreDialogue
      titre={recue ? "Lier un jeu reçu" : "Modifier la demande"}
      description={<p>{brouillon ? "En brouillon, l'objet, la description et l'échéance se modifient." : envoyee ? "Après l'envoi enregistré, seule l'échéance se modifie, avec une justification." : "Après la réception, seul le lien vers un jeu reçu se modifie. Le lien est une information : le jeu reste en quarantaine jusqu'à son autorisation."}</p>}
      enCours={enCours} erreur={erreur} peutValider={aChange && erreurs.length === 0} aide={aChange ? erreurs : ["Aucune modification n'a été saisie."]} libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(corps))} enLigne={enLigne}
    >
      {brouillon && (
        <>
          <div>
            <label htmlFor={`${id}-o`} className={LIBELLE_CHAMP}>Objet de la demande</label>
            <Input id={`${id}-o`} value={s.objet} onChange={(e) => setS({ ...s, objet: e.target.value })} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
          </div>
          <div>
            <label htmlFor={`${id}-d`} className={LIBELLE_CHAMP}>Description</label>
            <textarea id={`${id}-d`} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} rows={3} maxLength={4000} disabled={enCours} className={CHAMP_TEXTE} />
          </div>
        </>
      )}
      {(brouillon || envoyee) && (
        <div>
          <label htmlFor={`${id}-e`} className={LIBELLE_CHAMP}>Échéance de réponse</label>
          <Input id={`${id}-e`} type="date" value={s.echeance} onChange={(e) => setS({ ...s, echeance: e.target.value })} disabled={enCours} className="mt-1 border-gray-300" />
          <p className="mt-0.5 text-xs text-gray-700">Vider le champ retire l&apos;échéance.</p>
        </div>
      )}
      {envoyee && <Justification id={`${id}-j`} valeur={j} onChange={setJ} libelle="Justification du changement d'échéance" desactive={enCours} />}
      {recue && (
        <div>
          <label htmlFor={`${id}-jeu`} className={LIBELLE_CHAMP}>Jeu reçu (même concessionnaire, réseau tiers)</label>
          <Select id={`${id}-jeu`} value={jeu} disabled={enCours} onChange={(e) => setJeu(e.target.value)} className="mt-1 border-gray-300">
            <option value="">Aucun jeu lié</option>
            {jeuxLiables.map((x) => <option key={x.id} value={x.id}>{x.nomFichier ?? "Jeu sans nom"}, version {x.version ?? "?"}{x.statut ? ` (${x.statut === "AUTORISE" ? "autorisé" : "en attente"})` : ""}</option>)}
          </Select>
        </div>
      )}
    </CadreDialogue>
  );
}

// ---------------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------------

export function DialogueEnvoi({ demande, enLigne, onFermer, onValider }: { demande: Demande; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsStatutDemande) => Promise<unknown> }) {
  const id = useId();
  const [s, setS] = useState<SaisieEnvoi>({ canalEnvoi: "", dateEnvoi: "", referenceEnvoi: "", interlocuteur: "" });
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const erreurs = erreursEnvoi(s);
  const maj = (p: Partial<SaisieEnvoi>) => setS((x) => ({ ...x, ...p }));
  return (
    <CadreDialogue
      titre="Enregistrer l'envoi"
      description={<>
        <p className="font-semibold text-gray-900">{LIBELLE_ENVOI_HORS_APPLICATION}.</p>
        <p>{MENTION_AUCUN_ENVOI}</p>
        <p>Demande : <strong>{demande.objet}</strong>{demande.concessionnaire?.nom ? ` (${demande.concessionnaire.nom})` : ""}. Votre nom et la date de l&apos;enregistrement sont consignés.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Enregistrer l'envoi" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider({ vers: "ENVOYEE", canalEnvoi: s.canalEnvoi.trim(), dateEnvoi: s.dateEnvoi, referenceEnvoi: s.referenceEnvoi.trim() || null, interlocuteur: s.interlocuteur.trim() || null }))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-canal`} className={LIBELLE_CHAMP}>Canal utilisé pour l&apos;envoi</label>
        <Input id={`${id}-canal`} list={`${id}-canaux`} value={s.canalEnvoi} onChange={(e) => maj({ canalEnvoi: e.target.value })} maxLength={100} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
        <datalist id={`${id}-canaux`}>{CANAUX.map((c) => <option key={c} value={c} />)}</datalist>
      </div>
      <div>
        <label htmlFor={`${id}-date`} className={LIBELLE_CHAMP}>Date de l&apos;envoi</label>
        <Input id={`${id}-date`} type="date" max={aujourdhuiUtc()} value={s.dateEnvoi} onChange={(e) => maj({ dateEnvoi: e.target.value })} disabled={enCours} className="mt-1 border-gray-300" />
        <p className="mt-0.5 text-xs text-gray-700">Un envoi déjà fait : la date ne peut pas être dans le futur.</p>
      </div>
      <div>
        <label htmlFor={`${id}-ref`} className={LIBELLE_CHAMP}>Référence de l&apos;envoi (facultatif)</label>
        <Input id={`${id}-ref`} value={s.referenceEnvoi} onChange={(e) => maj({ referenceEnvoi: e.target.value })} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <div>
        <label htmlFor={`${id}-int`} className={LIBELLE_CHAMP}>Interlocuteur (facultatif)</label>
        <Input id={`${id}-int`} value={s.interlocuteur} onChange={(e) => maj({ interlocuteur: e.target.value })} maxLength={200} autoComplete="off" disabled={enCours} aria-describedby={`${id}-int-aide`} className="mt-1 border-gray-300" />
        <p id={`${id}-int-aide`} className="mt-0.5 text-xs text-gray-700">Un nom ou une fonction suffit : ni courriel ni téléphone ne sont demandés (minimiser les données personnelles).</p>
      </div>
    </CadreDialogue>
  );
}

export function DialogueReception({ demande, jeuxLiables, enLigne, onFermer, onValider }: {
  demande: Demande; jeuxLiables: JeuVue[]; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsStatutDemande) => Promise<unknown>;
}) {
  const id = useId();
  const [s, setS] = useState<SaisieReception>({ dateReception: "", jeuRecuId: "", note: "" });
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const dateEnvoi = demande.envoi?.dateEnvoi?.slice(0, 10) ?? null;
  const erreurs = erreursReception(s, dateEnvoi);
  const maj = (p: Partial<SaisieReception>) => setS((x) => ({ ...x, ...p }));
  return (
    <CadreDialogue
      titre="Enregistrer la réception de la réponse"
      description={<>
        <p>La réponse est arrivée hors application : vous l&apos;enregistrez ici. {dateEnvoi ? `Envoi enregistré le ${formaterDate(dateEnvoi)}.` : ""}</p>
        <p>Recevoir une réponse ne modifie ni le référentiel, ni un jeu : un jeu reçu reste en quarantaine jusqu&apos;à son autorisation.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Enregistrer la réception" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider({ vers: "RECUE", dateReception: s.dateReception, jeuRecuId: s.jeuRecuId || null, note: s.note.trim() || null }))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-date`} className={LIBELLE_CHAMP}>Date de réception</label>
        <Input id={`${id}-date`} type="date" max={aujourdhuiUtc()} min={dateEnvoi ?? undefined} value={s.dateReception} onChange={(e) => maj({ dateReception: e.target.value })} disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <div>
        <label htmlFor={`${id}-jeu`} className={LIBELLE_CHAMP}>Jeu reçu lié (facultatif)</label>
        <Select id={`${id}-jeu`} value={s.jeuRecuId} disabled={enCours} onChange={(e) => maj({ jeuRecuId: e.target.value })} aria-describedby={`${id}-jeu-aide`} className="mt-1 border-gray-300">
          <option value="">Aucun jeu lié</option>
          {jeuxLiables.map((x) => <option key={x.id} value={x.id}>{x.nomFichier ?? "Jeu sans nom"}, version {x.version ?? "?"}{x.statut ? ` (${x.statut === "AUTORISE" ? "autorisé" : "en attente"})` : ""}</option>)}
        </Select>
        <p id={`${id}-jeu-aide`} className="mt-0.5 text-xs text-gray-700">Seuls les jeux de réseau tiers du même concessionnaire sont proposés. Déposez d&apos;abord le fichier reçu depuis la page du projet.</p>
      </div>
      <div>
        <label htmlFor={`${id}-note`} className={LIBELLE_CHAMP}>Note (facultatif)</label>
        <textarea id={`${id}-note`} value={s.note} onChange={(e) => maj({ note: e.target.value })} rows={2} maxLength={2000} disabled={enCours} className={CHAMP_TEXTE} />
      </div>
    </CadreDialogue>
  );
}

export function DialogueFinDemande({ demande, vers, enLigne, onFermer, onValider }: {
  demande: Demande; vers: "CLOTUREE" | "ANNULEE"; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsStatutDemande) => Promise<unknown>;
}) {
  const id = useId();
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const cloture = vers === "CLOTUREE";
  return (
    <CadreDialogue
      titre={cloture ? "Clore la demande" : "Annuler la demande"}
      description={<p>{cloture ? "La demande est close, avec un motif (par exemple « aucune réponse après relance »). Elle ne change plus." : "La demande est abandonnée, avec un motif. Elle ne change plus."} <strong>{demande.objet}</strong></p>}
      enCours={enCours} erreur={erreur} peutValider={justificationValide(j)} libelleValider={cloture ? "Clore la demande" : "Annuler la demande"} libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider({ vers, justification: j.trim() }))} enLigne={enLigne}
    >
      <Justification id={`${id}-j`} valeur={j} onChange={setJ} libelle="Motif" desactive={enCours} />
    </CadreDialogue>
  );
}
