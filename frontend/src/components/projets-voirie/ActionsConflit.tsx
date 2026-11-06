import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input, Select } from "../ui/Input";
import { BadgeStatutConflit } from "./BadgesConflit";
import type {
  ConflitFiche, CorpsApprobation, CorpsAttribution, CorpsDecision, CorpsPreuve, CorpsStatut, DecisionConflit, TransitionPossible,
} from "../../lib/projetsVoirieConflitsApi";
import {
  AVERTISSEMENT_COUTS, JUSTIFICATION_MIN, LIBELLE_OPTION_DECISION, LIBELLE_RISQUE, LIBELLE_TYPE_PREUVE, MENTION_RECOLEMENT, OPTIONS_DECISION, RAPPEL_SEPARATION, RISQUES_CONFLIT,
  TYPES_PREUVE, classerErreurConflit, erreursDecision, exigencesTransition, justificationValide, lireMontant, libelleTransition,
  type OptionDecision, type RisqueConflit, type SaisieDecision, type TypePreuve,
} from "../../lib/projetsVoirieConflits";
import type { ErreurPv } from "../../lib/projetsVoirie";

/**
 * Formulaires d'action d'un dossier de conflit : transition de statut, attribution, preuve, proposition de decision, approbation ou refus.
 *
 * AUCUNE action « deplacer », « ordonner » ou « executer » : on PROPOSE, puis des humains approuvent. Chaque formulaire montre les exigences
 * du serveur AVANT l'envoi, mais le serveur reste l'autorite : son refus est affiche en clair (TRANSITION_INTERDITE, SEPARATION_DES_TACHES,
 * DECISION_REQUISE, PREUVE_REQUISE, JUSTIFICATION_REQUISE, REGLE_IMMUABLE).
 */

const CHAMP = "mt-1 w-full rounded-md border border-gray-400 p-2 text-sm";

function Compteur({ id, texte, min = JUSTIFICATION_MIN }: { id: string; texte: string; min?: number }) {
  const n = texte.trim().length;
  return <p id={id} className={`text-xs ${n >= min ? "text-green-800" : "text-gray-700"}`}>{n} / {min} caractères minimum</p>;
}

/** Cadre commun : titre, description, erreur typee (role alert), annulation, validation. Monte seulement quand il est ouvert : l'etat repart a zero. */
function Cadre({ titre, description, enCours, erreur, peutValider, libelleValider, libelleEnCours, onFermer, onValider, enLigne = true, children }: {
  titre: string; description: ReactNode; enCours: boolean; erreur: ErreurPv | null; peutValider: boolean; libelleValider: string; libelleEnCours: string;
  onFermer: () => void; onValider: () => void; enLigne?: boolean; children: ReactNode;
}) {
  function soumettre(e: FormEvent) { e.preventDefault(); if (peutValider && !enCours && enLigne) onValider(); }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !enCours) onFermer(); }}>
      <DialogContent masquerCroix className="max-h-[92vh] max-w-[540px] overflow-y-auto">
        <DialogTitle className="text-base font-semibold text-primary">{titre}</DialogTitle>
        <DialogDescription asChild><div className="space-y-1 text-sm text-gray-700">{description}</div></DialogDescription>
        <form onSubmit={soumettre} className="grid gap-3" noValidate>
          {children}
          {!enLigne && <p role="alert" className="text-sm text-amber-900">Vous êtes hors ligne : l&apos;enregistrement est impossible tant que la connexion n&apos;est pas revenue.</p>}
          {erreur && <p role="alert" data-code={erreur.code ?? undefined} className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">{erreur.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" className="min-h-[44px] xl:min-h-9" disabled={enCours} onClick={onFermer}>Annuler</Button>
            <Button type="submit" className="min-h-[44px] xl:min-h-9" disabled={enCours || !peutValider || !enLigne}>{enCours ? libelleEnCours : libelleValider}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Execute l'ecriture ; en cas d'echec, garde le formulaire ouvert avec l'erreur typee. */
function useEnvoi(onFermer: () => void) {
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<ErreurPv | null>(null);
  async function envoyer(f: () => Promise<unknown>) {
    setEnCours(true); setErreur(null);
    try { await f(); onFermer(); } catch (e) { setErreur(classerErreurConflit(e)); } finally { setEnCours(false); }
  }
  return { enCours, erreur, envoyer };
}

function ChampDerogation({ valeur, onChange, obligatoire }: { valeur: string; onChange: (v: string) => void; obligatoire: boolean }) {
  const id = useId();
  return (
    <div className="rounded border border-purple-300 bg-purple-50 p-2">
      <label htmlFor={id} className="block text-sm font-medium text-gray-900">Dérogation à la séparation des tâches (réservée aux administrateurs){obligatoire ? " : motif obligatoire ici" : ", facultative"}</label>
      <p className="text-xs text-gray-800">À renseigner seulement pour approuver ce que vous avez vous-même proposé, ou s&apos;il n&apos;existe aucun autre compte habilité. Elle est tracée dans l&apos;historique et dans l&apos;audit.</p>
      <textarea id={id} value={valeur} onChange={(e) => onChange(e.target.value)} rows={2} maxLength={1000} className={CHAMP} />
      {valeur.trim() !== "" && <Compteur id={`${id}-n`} texte={valeur} />}
    </div>
  );
}

const derogationOk = (d: string) => d.trim() === "" || justificationValide(d);

// ---------------------------------------------------------------------------------------------------
// Transition de statut
// ---------------------------------------------------------------------------------------------------

export function DialogueTransition({ fiche, transition, estAdmin, enLigne, onFermer, onValider }: {
  fiche: ConflitFiche; transition: TransitionPossible; estAdmin: boolean; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsStatut) => Promise<unknown>;
}) {
  const idJ = useId();
  const idR = useId();
  const [justification, setJustification] = useState("");
  const [derogation, setDerogation] = useState("");
  const [recolement, setRecolement] = useState(false);
  const { enCours, erreur, envoyer } = useEnvoi(onFermer);
  const ex = exigencesTransition(fiche.statut, transition.vers);
  const approuvees = fiche.decisions.filter((d) => d.statut === "APPROUVEE");
  const deplacement = approuvees.some((d) => d.option === "DEPLACER_RESEAU");
  const recolementExige = ex.cloture && deplacement;
  const derogationVisible = estAdmin && (ex.cloture || transition.derogationPossible || erreur?.code === "SEPARATION_DES_TACHES");
  const peutValider = justificationValide(justification) && (!recolementExige || recolement) && derogationOk(derogation);

  function valider() {
    const j = justification.trim();
    void envoyer(() => onValider({
      vers: transition.vers,
      justification: recolementExige ? `${MENTION_RECOLEMENT} : ${j}` : j,
      ...(derogationVisible && derogation.trim() ? { derogation: derogation.trim() } : {}),
    }));
  }

  return (
    <Cadre
      titre={libelleTransition(fiche.statut, transition.vers)}
      description={<>
        <p className="flex flex-wrap items-center gap-1">Statut : <BadgeStatutConflit statut={fiche.statut} /> vers <BadgeStatutConflit statut={transition.vers} /></p>
        <p>Cette transition est un acte humain, consigné dans l&apos;historique avec votre nom, l&apos;ancien et le nouveau statut et votre justification. Elle n&apos;ordonne aucun déplacement.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={peutValider} libelleValider="Enregistrer la transition" libelleEnCours="Enregistrement…" onFermer={onFermer} onValider={valider} enLigne={enLigne}
    >
      {ex.preuveRequise && (
        <p role="note" className={`rounded border p-2 text-xs ${fiche.preuves.length === 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-300 bg-gray-50 text-gray-800"}`}>
          Pour confirmer, au moins une preuve est requise. {fiche.preuves.length === 0 ? "Aucune preuve n'est au dossier : ajoutez-en une d'abord, le serveur refusera sinon." : `${fiche.preuves.length} preuve(s) au dossier.`}
        </p>
      )}
      {ex.decisionApprouveeRequise && (
        <p role="note" className={`rounded border p-2 text-xs ${approuvees.length === 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-300 bg-gray-50 text-gray-800"}`}>
          Une décision approuvée est requise. {approuvees.length === 0 ? "Aucune décision approuvée : proposez-en une, puis faites-la approuver, le serveur refusera sinon." : `${approuvees.length} décision(s) approuvée(s).`}
        </p>
      )}
      {ex.cloture && (
        <p role="note" className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-800">
          La clôture est réservée aux administrateurs : un motif et un acteur identifié sont consignés. Un dossier clos n&apos;a plus de transition possible.
        </p>
      )}
      {transition.exigences.length > 0 && <p className="text-xs text-gray-700">Exigences indiquées par le serveur : {transition.exigences.join(" ; ")}.</p>}
      <div>
        <label htmlFor={idJ} className="block text-sm font-medium text-gray-900">{ex.cloture ? "Motif de la clôture" : "Justification"} ({JUSTIFICATION_MIN} caractères minimum)</label>
        <textarea id={idJ} value={justification} onChange={(e) => setJustification(e.target.value)} rows={3} maxLength={950} disabled={enCours} aria-describedby={`${idJ}-n`} className={CHAMP} />
        <Compteur id={`${idJ}-n`} texte={justification} />
      </div>
      {recolementExige && (
        <label htmlFor={idR} className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          <input id={idR} type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={recolement} onChange={(e) => setRecolement(e.target.checked)} />
          <span>Une décision « Déplacer le réseau » est approuvée. Je reconnais que <strong>le récolement reste à valider</strong> : il n&apos;est pas géré dans cet outil et cette clôture ne le remplace pas.</span>
        </label>
      )}
      {derogationVisible && <ChampDerogation valeur={derogation} onChange={setDerogation} obligatoire={erreur?.code === "SEPARATION_DES_TACHES"} />}
    </Cadre>
  );
}

// ---------------------------------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------------------------------

export function DialogueAttribution({ fiche, userId, nomUtilisateur, enLigne, onFermer, onValider }: {
  fiche: ConflitFiche; userId: string | undefined; nomUtilisateur: string | undefined; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsAttribution) => Promise<unknown>;
}) {
  const id = useId();
  const [resp, setResp] = useState<"inchange" | "moi" | "aucun" | "autre">("inchange");
  const [autreId, setAutreId] = useState("");
  const [echeance, setEcheance] = useState(fiche.echeance?.slice(0, 10) ?? "");
  const [risque, setRisque] = useState<RisqueConflit | "">("");
  const [action, setAction] = useState(fiche.actionProposee ?? "");
  const { enCours, erreur, envoyer } = useEnvoi(onFermer);

  const corps: CorpsAttribution = {};
  if (resp === "moi" && userId && fiche.responsable?.id !== userId) corps.responsableId = userId;
  if (resp === "aucun" && fiche.responsable) corps.responsableId = null;
  if (resp === "autre" && autreId.trim() && autreId.trim() !== fiche.responsable?.id) corps.responsableId = autreId.trim();
  if (echeance !== (fiche.echeance?.slice(0, 10) ?? "")) corps.echeance = echeance === "" ? null : echeance;
  if (risque && risque !== fiche.risque) corps.risque = risque;
  if (action.trim() !== (fiche.actionProposee ?? "")) corps.actionProposee = action.trim() === "" ? null : action.trim();
  const nbChangements = Object.keys(corps).length;

  return (
    <Cadre
      titre="Attribuer le dossier"
      description={<p>Responsable, échéance, risque et action proposée. Chaque changement est consigné dans l&apos;historique. L&apos;action proposée est un texte libre : elle n&apos;ordonne rien.</p>}
      enCours={enCours} erreur={erreur} peutValider={nbChangements > 0 && !(resp === "autre" && !autreId.trim())} libelleValider="Enregistrer l'attribution" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(corps))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-r`} className="block text-sm font-medium text-gray-900">Responsable</label>
        <Select id={`${id}-r`} value={resp} onChange={(e) => setResp(e.target.value as typeof resp)} disabled={enCours} className="border-gray-300">
          <option value="inchange">{fiche.responsable ? `Inchangé : ${fiche.responsable.nom ?? "compte sans nom"}` : "Inchangé : non attribué"}</option>
          {userId && <option value="moi">Moi-même{nomUtilisateur ? ` (${nomUtilisateur})` : ""}</option>}
          {fiche.responsable && <option value="aucun">Retirer le responsable</option>}
          <option value="autre">Un autre compte (saisir son identifiant)</option>
        </Select>
        {resp === "autre" && (
          <div className="mt-1">
            <label htmlFor={`${id}-a`} className="block text-xs font-medium text-gray-800">Identifiant du compte responsable</label>
            <Input id={`${id}-a`} value={autreId} onChange={(e) => setAutreId(e.target.value)} autoComplete="off" maxLength={64} disabled={enCours} className="border-gray-300" />
            <p className="text-xs text-gray-700">L&apos;interface ne liste pas les comptes : saisissez l&apos;identifiant fourni par un administrateur. Le serveur refuse un compte inconnu.</p>
          </div>
        )}
      </div>
      <div>
        <label htmlFor={`${id}-e`} className="block text-sm font-medium text-gray-900">Échéance</label>
        <Input id={`${id}-e`} type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} disabled={enCours} className="border-gray-300" />
        <p className="text-xs text-gray-700">Vider le champ retire l&apos;échéance.</p>
      </div>
      <div>
        <label htmlFor={`${id}-k`} className="block text-sm font-medium text-gray-900">Risque</label>
        <Select id={`${id}-k`} value={risque} onChange={(e) => setRisque(e.target.value as RisqueConflit | "")} disabled={enCours} className="border-gray-300">
          <option value="">{fiche.risque ? `Inchangé : ${LIBELLE_RISQUE[fiche.risque]}` : "Inchangé : non renseigné"}</option>
          {RISQUES_CONFLIT.map((r) => <option key={r} value={r}>{LIBELLE_RISQUE[r]}</option>)}
        </Select>
        <p className="text-xs text-gray-700">« Risque inconnu » est un niveau à part : il ne vaut pas « faible ».</p>
      </div>
      <div>
        <label htmlFor={`${id}-t`} className="block text-sm font-medium text-gray-900">Action proposée (texte libre)</label>
        <textarea id={`${id}-t`} value={action} onChange={(e) => setAction(e.target.value)} rows={3} maxLength={1000} disabled={enCours} className={CHAMP} />
      </div>
      {nbChangements === 0 && <p className="text-xs text-gray-700">Aucun changement à enregistrer.</p>}
    </Cadre>
  );
}

// ---------------------------------------------------------------------------------------------------
// Preuve
// ---------------------------------------------------------------------------------------------------

export function DialoguePreuve({ enLigne, onFermer, onValider }: { enLigne: boolean; onFermer: () => void; onValider: (c: CorpsPreuve) => Promise<unknown> }) {
  const id = useId();
  const [type, setType] = useState<TypePreuve>("NOTE");
  const [texte, setTexte] = useState("");
  const [reference, setReference] = useState("");
  const { enCours, erreur, envoyer } = useEnvoi(onFermer);
  return (
    <Cadre
      titre="Ajouter une preuve"
      description={<p>Une preuve est un texte et une référence (numéro de courrier, nom de plan). Aucun fichier n&apos;est joint dans ce lot. Une preuve ajoutée ne peut plus être modifiée ni supprimée.</p>}
      enCours={enCours} erreur={erreur} peutValider={texte.trim().length > 0} libelleValider="Ajouter la preuve" libelleEnCours="Enregistrement…" onFermer={onFermer} enLigne={enLigne}
      onValider={() => void envoyer(() => onValider({ type, texte: texte.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) }))}
    >
      <div>
        <label htmlFor={`${id}-t`} className="block text-sm font-medium text-gray-900">Type de preuve</label>
        <Select id={`${id}-t`} value={type} onChange={(e) => setType(e.target.value as TypePreuve)} disabled={enCours} className="border-gray-300">
          {TYPES_PREUVE.map((t) => <option key={t} value={t}>{LIBELLE_TYPE_PREUVE[t]}</option>)}
        </Select>
      </div>
      <div>
        <label htmlFor={`${id}-x`} className="block text-sm font-medium text-gray-900">Texte de la preuve</label>
        <textarea id={`${id}-x`} value={texte} onChange={(e) => setTexte(e.target.value)} rows={4} maxLength={2000} disabled={enCours} className={CHAMP} />
      </div>
      <div>
        <label htmlFor={`${id}-r`} className="block text-sm font-medium text-gray-900">Référence (facultative)</label>
        <Input id={`${id}-r`} value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" maxLength={200} disabled={enCours} className="border-gray-300" />
      </div>
    </Cadre>
  );
}

// ---------------------------------------------------------------------------------------------------
// Proposition de decision
// ---------------------------------------------------------------------------------------------------

const SAISIE_VIDE: SaisieDecision = { option: "", justification: "", contraintes: "", coutEstime: "", deviseCout: "", coutReel: "", dateDebutPrevue: "", dateFinPrevue: "" };

export function DialogueDecision({ enLigne, onFermer, onValider }: { enLigne: boolean; onFermer: () => void; onValider: (c: CorpsDecision) => Promise<unknown> }) {
  const id = useId();
  const [s, setS] = useState<SaisieDecision>(SAISIE_VIDE);
  const { enCours, erreur, envoyer } = useEnvoi(onFermer);
  const maj = (p: Partial<SaisieDecision>) => setS((x) => ({ ...x, ...p }));
  const erreurs = erreursDecision(s);

  function valider() {
    const est = lireMontant(s.coutEstime);
    const reel = lireMontant(s.coutReel);
    const corps: CorpsDecision = { option: s.option as OptionDecision, justification: s.justification.trim() };
    if (s.contraintes.trim()) corps.contraintes = s.contraintes.trim();
    if (est !== null) corps.coutEstime = est;
    if (reel !== null) corps.coutReel = reel;
    if (est !== null || reel !== null) corps.deviseCout = s.deviseCout.trim();
    if (s.dateDebutPrevue) corps.dateDebutPrevue = s.dateDebutPrevue;
    if (s.dateFinPrevue) corps.dateFinPrevue = s.dateFinPrevue;
    void envoyer(() => onValider(corps));
  }

  return (
    <Cadre
      titre="Proposer une décision"
      description={<p>Une proposition n&apos;ordonne et n&apos;exécute rien. Elle devra être approuvée par une autre personne habilitée avant que le dossier puisse passer à « Traitement décidé ».</p>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} libelleValider="Proposer la décision" libelleEnCours="Enregistrement…" onFermer={onFermer} onValider={valider} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-o`} className="block text-sm font-medium text-gray-900">Option</label>
        <Select id={`${id}-o`} value={s.option} onChange={(e) => maj({ option: e.target.value as OptionDecision | "" })} disabled={enCours} className="border-gray-300">
          <option value="">Choisir une option</option>
          {OPTIONS_DECISION.map((o) => <option key={o} value={o}>{LIBELLE_OPTION_DECISION[o]}</option>)}
        </Select>
        {s.option === "DEPLACER_RESEAU" && (
          <p role="note" className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            Proposer le déplacement d&apos;un réseau n&apos;ordonne rien. Cette décision ne pourra pas être approuvée par vous (séparation des tâches, sauf dérogation d&apos;un administrateur), et le récolement restera à valider hors de cet outil.
          </p>
        )}
      </div>
      <div>
        <label htmlFor={`${id}-j`} className="block text-sm font-medium text-gray-900">Justification ({JUSTIFICATION_MIN} caractères minimum)</label>
        <textarea id={`${id}-j`} value={s.justification} onChange={(e) => maj({ justification: e.target.value })} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP} />
        <Compteur id={`${id}-jn`} texte={s.justification} />
      </div>
      <div>
        <label htmlFor={`${id}-c`} className="block text-sm font-medium text-gray-900">Contraintes (facultatif)</label>
        <textarea id={`${id}-c`} value={s.contraintes} onChange={(e) => maj({ contraintes: e.target.value })} rows={2} maxLength={2000} disabled={enCours} className={CHAMP} />
      </div>
      <fieldset className="grid gap-2 rounded border border-gray-300 p-2">
        <legend className="px-1 text-sm font-medium text-gray-900">Coûts (facultatifs, saisis à la main)</legend>
        <p className="text-xs text-gray-700">{AVERTISSEMENT_COUTS}</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={`${id}-ce`} className="block text-xs font-medium text-gray-800">Coût estimé</label>
            <Input id={`${id}-ce`} inputMode="decimal" value={s.coutEstime} onChange={(e) => maj({ coutEstime: e.target.value })} autoComplete="off" disabled={enCours} className="border-gray-300" />
          </div>
          <div>
            <label htmlFor={`${id}-cr`} className="block text-xs font-medium text-gray-800">Coût réel</label>
            <Input id={`${id}-cr`} inputMode="decimal" value={s.coutReel} onChange={(e) => maj({ coutReel: e.target.value })} autoComplete="off" disabled={enCours} className="border-gray-300" />
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-cd`} className="block text-xs font-medium text-gray-800">Devise des coûts (par exemple GNF)</label>
          <Input id={`${id}-cd`} value={s.deviseCout} onChange={(e) => maj({ deviseCout: e.target.value })} autoComplete="off" maxLength={8} disabled={enCours} className="border-gray-300" />
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${id}-d1`} className="block text-xs font-medium text-gray-800">Début prévu</label>
          <Input id={`${id}-d1`} type="date" value={s.dateDebutPrevue} onChange={(e) => maj({ dateDebutPrevue: e.target.value })} disabled={enCours} className="border-gray-300" />
        </div>
        <div>
          <label htmlFor={`${id}-d2`} className="block text-xs font-medium text-gray-800">Fin prévue</label>
          <Input id={`${id}-d2`} type="date" value={s.dateFinPrevue} onChange={(e) => maj({ dateFinPrevue: e.target.value })} disabled={enCours} className="border-gray-300" />
        </div>
      </div>
      {erreurs.length > 0 && (s.option !== "" || s.justification !== "" || s.coutEstime !== "" || s.coutReel !== "") && (
        <ul role="status" aria-label="Points à corriger" className="list-disc space-y-0.5 pl-5 text-xs text-gray-800">
          {erreurs.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </Cadre>
  );
}

// ---------------------------------------------------------------------------------------------------
// Approbation ou refus d'une decision
// ---------------------------------------------------------------------------------------------------

export function DialogueApprobation({ decision, verdict, userId, estAdmin, enLigne, onFermer, onValider }: {
  decision: DecisionConflit; verdict: "approuver" | "refuser"; userId: string | undefined; estAdmin: boolean; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsApprobation) => Promise<unknown>;
}) {
  const id = useId();
  const [motif, setMotif] = useState("");
  const [derogation, setDerogation] = useState("");
  const { enCours, erreur, envoyer } = useEnvoi(onFermer);
  const proposeParMoi = !!userId && decision.proposePar?.id === userId;
  const approuver = verdict === "approuver";
  const deplacement = decision.option === "DEPLACER_RESEAU";
  const derogationVisible = approuver && estAdmin && (proposeParMoi || erreur?.code === "SEPARATION_DES_TACHES");
  const derogationExigee = derogationVisible && proposeParMoi && deplacement;
  const peutValider = justificationValide(motif) && derogationOk(derogation) && (!derogationExigee || derogation.trim() !== "");

  return (
    <Cadre
      titre={`${approuver ? "Approuver" : "Refuser"} la décision : ${LIBELLE_OPTION_DECISION[decision.option]}`}
      description={<>
        <p>{approuver ? "L'approbation est un acte humain consigné dans l'historique : elle ne déclenche aucun déplacement ni aucun ordre." : "Le refus est consigné dans l'historique avec votre motif."}</p>
        <p role="note" className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-800">{RAPPEL_SEPARATION}</p>
        {approuver && proposeParMoi && <p role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">Vous avez proposé cette décision{deplacement ? " de déplacement de réseau" : ""} : {estAdmin ? "seule une dérogation motivée d'un administrateur permet de l'approuver vous-même." : "un autre compte habilité doit l'approuver."}</p>}
      </>}
      enCours={enCours} erreur={erreur} peutValider={peutValider} libelleValider={approuver ? "Approuver la décision" : "Refuser la décision"} libelleEnCours="Enregistrement…"
      onFermer={onFermer} enLigne={enLigne}
      onValider={() => void envoyer(() => onValider({ motif: motif.trim(), ...(derogationVisible && derogation.trim() ? { derogation: derogation.trim() } : {}) }))}
    >
      <div>
        <label htmlFor={`${id}-m`} className="block text-sm font-medium text-gray-900">Motif ({JUSTIFICATION_MIN} caractères minimum)</label>
        <textarea id={`${id}-m`} value={motif} onChange={(e) => setMotif(e.target.value)} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-mn`} className={CHAMP} />
        <Compteur id={`${id}-mn`} texte={motif} />
      </div>
      {derogationVisible && <ChampDerogation valeur={derogation} onChange={setDerogation} obligatoire={derogationExigee} />}
    </Cadre>
  );
}
