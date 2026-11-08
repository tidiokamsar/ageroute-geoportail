import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeft, FilePlus2, Pencil, Plus } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { useRestitutionFocus } from "../focusDialogue";
import { BadgeWorkflow, Liste, Ligne, LigneBouton, ListePaginee, nomPersonne, PucesStatut, SectionFiche } from "./commun";
import { DialoguePreuveWorkflow, HistoriqueWorkflow, ListePreuves } from "./PreuvesEtHistorique";
import type { PropsSection } from "./SectionDemandes";
import type { CorpsCreationRecolement, CorpsModifRecolement, CorpsStatutRecolement, FicheRecolement, JeuVue, Recolement, TransitionRecolement } from "../../../lib/projetsVoirieWorkflowApi";
import {
  useAjouterPreuveWorkflow, useConflitsVue, useCreerRecolement, useFicheRecolement, useJeuxVue, useModifierRecolement, useRecolements, useStatutRecolement,
} from "../../../lib/projetsVoirieWorkflowHooks";
import {
  FILTRES_RECOLEMENTS_VIDES, LIBELLE_STATUT_RECOLEMENT, MENTION_RECOLEMENT, RAPPEL_SEPARATION_WORKFLOW, SAISIE_RECOLEMENT_VIDE, STATUTS_RECOLEMENT, STYLE_STATUT_RECOLEMENT, aLeDroit,
  classerErreurWorkflow, erreursRecolement, libelleTransitionRecolement, manquePourSoumettre,
  type FiltresRecolements, type SaisieRecolement, type StatutRecolement,
} from "../../../lib/projetsVoirieWorkflow";
import { LIBELLE_OPTION_DECISION, LIBELLE_TYPE_CONFLIT, STYLE_STATUT_CONFLIT, formaterDateHeure, justificationValide } from "../../../lib/projetsVoirieConflits";
import { formaterDate } from "../../../lib/projetsVoirie";

/**
 * Recolements (as-built) : brouillon, soumission, validation PAR UN TIERS, rejet. Lies a un dossier de conflit dont un deplacement est decide, ou a un jeu recu.
 * Valider atteste le dossier : cela ne met a jour ni le referentiel officiel, ni un jeu, ni le conflit. Toute modification d'un brouillon exige une justification
 * et est historisee AVANT et APRES. Les transitions proposees sont celles que le serveur renvoie pour ce compte.
 */

type Dialogue = { genre: "transition"; transition: TransitionRecolement } | { genre: "modifier" } | { genre: "preuve" };

function Texte({ id, libelle, valeur, onChange, desactive, rows = 3, max = 4000, minimum = false }: { id: string; libelle: string; valeur: string; onChange: (v: string) => void; desactive: boolean; rows?: number; max?: number; minimum?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className={LIBELLE_CHAMP}>{libelle}</label>
      <textarea id={id} value={valeur} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={max} disabled={desactive} aria-describedby={minimum ? `${id}-n` : undefined} className={CHAMP_TEXTE} />
      {minimum && <Compteur id={`${id}-n`} texte={valeur} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Dialogues
// ---------------------------------------------------------------------------------------------------

function DialogueCreationRecolement({ projetId, enLigne, onFermer, onValider }: { projetId: string; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsCreationRecolement) => Promise<unknown> }) {
  const id = useId();
  const [s, setS] = useState<SaisieRecolement>(SAISIE_RECOLEMENT_VIDE);
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const conflits = useConflitsVue(projetId, ["TRAITEMENT_DECIDE", "CLOTURE"], true);
  const jeux = useJeuxVue(projetId, true);
  const maj = (p: Partial<SaisieRecolement>) => setS((x) => ({ ...x, ...p }));
  const erreurs = erreursRecolement(s, true);
  const dossiers = conflits.data?.pages.flatMap((pg) => pg.conflits) ?? [];
  const jeuxRecus: JeuVue[] = (jeux.data ?? []).filter((j) => j.statut !== "RETIRE");
  return (
    <CadreDialogue
      titre="Nouveau récolement" large
      description={<><p>Un récolement se rattache à un dossier de conflit <strong>dont un déplacement de réseau est décidé</strong>, ou à un jeu reçu (plan de récolement déposé par le socle), ou aux deux. Le lien ne change plus ensuite.</p><p>{MENTION_RECOLEMENT}</p></>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Créer le brouillon" libelleEnCours="Création…"
      onFermer={onFermer} enLigne={enLigne}
      onValider={() => void envoyer(() => onValider({
        conflitId: s.lien !== "JEU" ? s.conflitId : null, jeuId: s.lien !== "CONFLIT" ? s.jeuId : null, objet: s.objet.trim(), constat: s.constat.trim() || null, ecarts: s.ecarts.trim() || null, dateRecolement: s.dateRecolement || null,
      }))}
    >
      <div>
        <label htmlFor={`${id}-l`} className={LIBELLE_CHAMP}>Rattachement</label>
        <Select id={`${id}-l`} value={s.lien} disabled={enCours} onChange={(e) => maj({ lien: e.target.value as SaisieRecolement["lien"] })} className="mt-1 border-gray-300">
          <option value="CONFLIT">Un dossier de conflit (déplacement décidé)</option>
          <option value="JEU">Un jeu reçu</option>
          <option value="LES_DEUX">Un dossier de conflit et un jeu reçu</option>
        </Select>
      </div>
      {s.lien !== "JEU" && (
        <div>
          <label htmlFor={`${id}-c`} className={LIBELLE_CHAMP}>Dossier de conflit</label>
          <Select id={`${id}-c`} value={s.conflitId} disabled={enCours} onChange={(e) => maj({ conflitId: e.target.value })} aria-describedby={`${id}-c-aide`} className="mt-1 border-gray-300">
            <option value="">Choisir un dossier</option>
            {dossiers.map((c) => (
              <option key={c.id} value={c.id}>
                {LIBELLE_TYPE_CONFLIT[c.type]} : {c.axe ?? "axe non précisé"} ({STYLE_STATUT_CONFLIT[c.statut].libelle}{c.decisionRetenue?.option ? `, décision : ${LIBELLE_OPTION_DECISION[c.decisionRetenue.option]}` : ""})
              </option>
            ))}
          </Select>
          <p id={`${id}-c-aide`} className="mt-0.5 text-xs text-gray-700">
            {conflits.isPending ? "Chargement des dossiers…" : conflits.isError ? classerErreurWorkflow(conflits.error).message : dossiers.length === 0 ? "Aucun dossier n'est « Traitement décidé » ou « Clos » : un récolement exige un déplacement de réseau décidé." : "Le serveur vérifie qu'une décision de déplacement de réseau est approuvée et en vigueur sur ce dossier."}
          </p>
        </div>
      )}
      {s.lien !== "CONFLIT" && (
        <div>
          <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Jeu reçu</label>
          <Select id={`${id}-j`} value={s.jeuId} disabled={enCours} onChange={(e) => maj({ jeuId: e.target.value })} className="mt-1 border-gray-300">
            <option value="">Choisir un jeu</option>
            {jeuxRecus.map((j) => <option key={j.id} value={j.id}>{j.nomFichier ?? "Jeu sans nom"}, version {j.version ?? "?"}{j.concessionnaire?.nom ? ` (${j.concessionnaire.nom})` : ""}</option>)}
          </Select>
        </div>
      )}
      <div>
        <label htmlFor={`${id}-o`} className={LIBELLE_CHAMP}>Objet du récolement</label>
        <Input id={`${id}-o`} value={s.objet} onChange={(e) => maj({ objet: e.target.value })} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <Texte id={`${id}-k`} libelle="Constat (obligatoire pour soumettre)" valeur={s.constat} onChange={(v) => maj({ constat: v })} desactive={enCours} />
      <Texte id={`${id}-e`} libelle="Écarts constatés entre le plan avant et le réseau après (facultatif)" valeur={s.ecarts} onChange={(v) => maj({ ecarts: v })} desactive={enCours} />
      <div>
        <label htmlFor={`${id}-d`} className={LIBELLE_CHAMP}>Date du récolement (facultatif)</label>
        <Input id={`${id}-d`} type="date" value={s.dateRecolement} onChange={(e) => maj({ dateRecolement: e.target.value })} disabled={enCours} className="mt-1 border-gray-300" />
      </div>
    </CadreDialogue>
  );
}

function DialogueModifRecolement({ recolement, enLigne, onFermer, onValider }: { recolement: Recolement; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsModifRecolement) => Promise<unknown> }) {
  const id = useId();
  const [objet, setObjet] = useState(recolement.objet);
  const [constat, setConstat] = useState(recolement.constat ?? "");
  const [ecarts, setEcarts] = useState(recolement.ecarts ?? "");
  const [date, setDate] = useState(recolement.dateRecolement?.slice(0, 10) ?? "");
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const corps: CorpsModifRecolement = { justification: j.trim() };
  if (objet.trim() !== recolement.objet) corps.objet = objet.trim();
  if (constat.trim() !== (recolement.constat ?? "")) corps.constat = constat.trim() || null;
  if (ecarts.trim() !== (recolement.ecarts ?? "")) corps.ecarts = ecarts.trim() || null;
  if (date !== (recolement.dateRecolement?.slice(0, 10) ?? "")) corps.dateRecolement = date || null;
  const aChange = Object.keys(corps).some((k) => k !== "justification");
  const erreurs = [...erreursRecolement({ ...SAISIE_RECOLEMENT_VIDE, objet, constat, ecarts, dateRecolement: date }, false), ...(!justificationValide(j) ? ["La justification doit faire au moins 10 caractères."] : []), ...(!aChange ? ["Aucune modification n'a été saisie."] : [])];
  return (
    <CadreDialogue
      titre="Modifier le brouillon du récolement" large
      description={<p>Toute modification exige une justification et est historisée, avec les valeurs <strong>avant</strong> et <strong>après</strong>, votre nom, votre profil et la date. La révision augmente de un (révision actuelle : {recolement.revision ?? "inconnue"}).</p>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Enregistrer la modification" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(corps))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-o`} className={LIBELLE_CHAMP}>Objet du récolement</label>
        <Input id={`${id}-o`} value={objet} onChange={(e) => setObjet(e.target.value)} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <Texte id={`${id}-k`} libelle="Constat" valeur={constat} onChange={setConstat} desactive={enCours} />
      <Texte id={`${id}-e`} libelle="Écarts constatés" valeur={ecarts} onChange={setEcarts} desactive={enCours} />
      <div>
        <label htmlFor={`${id}-d`} className={LIBELLE_CHAMP}>Date du récolement</label>
        <Input id={`${id}-d`} type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      <Texte id={`${id}-j`} libelle="Justification de la modification (10 caractères minimum)" valeur={j} onChange={setJ} desactive={enCours} rows={2} max={2000} minimum />
    </CadreDialogue>
  );
}

function DialogueTransitionRecolement({ fiche, transition, estAdmin, enLigne, onFermer, onValider }: {
  fiche: FicheRecolement; transition: TransitionRecolement; estAdmin: boolean; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsStatutRecolement) => Promise<unknown>;
}) {
  const id = useId();
  const [j, setJ] = useState("");
  const [derogation, setDerogation] = useState("");
  const { enCours, erreur, envoyer, codesVus } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const r = fiche.recolement;
  const valide = transition.vers === "VALIDE";
  const soumet = transition.vers === "SOUMIS";
  const manque = soumet ? manquePourSoumettre({ objet: r.objet, constat: r.constat }) : [];
  const preuvesSuffisantes = fiche.preuves.filter((p) => p.type !== "NOTE").length;
  const derogationVisible = estAdmin && valide;
  const obligatoire = codesVus.has("SEPARATION_DES_TACHES");
  const peutValider = justificationValide(j) && manque.length === 0 && (derogation.trim() === "" || justificationValide(derogation));
  return (
    <CadreDialogue
      titre={libelleTransitionRecolement(r.statut, transition.vers)}
      description={<>
        <p><strong>{r.objet}</strong> : {LIBELLE_STATUT_RECOLEMENT[r.statut]} vers {LIBELLE_STATUT_RECOLEMENT[transition.vers]}.</p>
        <p>Cet acte est consigné dans l&apos;historique avec votre nom et votre justification. Il n&apos;ordonne aucun travaux.</p>
        {valide && <p role="note" className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-900">{MENTION_RECOLEMENT}</p>}
        {valide && <p role="note" className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-900">{RAPPEL_SEPARATION_WORKFLOW} Le valideur n&apos;est ni le créateur, ni la personne qui a soumis, ni l&apos;auteur d&apos;une modification.</p>}
      </>}
      enCours={enCours} erreur={erreur} peutValider={peutValider}
      aide={[...(manque.length > 0 ? [`Pour soumettre, renseignez ${manque.join(" et ")} (modifiez le brouillon d'abord).`] : []), ...(!justificationValide(j) ? ["La justification doit faire au moins 10 caractères."] : [])]}
      libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      onFermer={onFermer} enLigne={enLigne} onValider={() => void envoyer(() => onValider({ vers: transition.vers, justification: j.trim(), ...(derogationVisible && derogation.trim() ? { derogation: derogation.trim() } : {}) }))}
    >
      {valide && (
        <p role="note" data-testid="preuves-suffisantes" className={`rounded border p-2 text-xs ${preuvesSuffisantes === 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-300 bg-gray-50 text-gray-800"}`}>
          Au moins une preuve qui n&apos;est pas une simple note est requise. {preuvesSuffisantes === 0 ? "Aucune n'est enregistrée : le serveur refusera la validation. Ajoutez un plan de récolement, un courrier ou une référence de document." : `${preuvesSuffisantes} preuve(s) suffisante(s).`}
        </p>
      )}
      <Texte id={`${id}-j`} libelle="Justification (10 caractères minimum)" valeur={j} onChange={setJ} desactive={enCours} rows={3} max={2000} minimum />
      {derogationVisible && (
        <div className="rounded border border-purple-300 bg-purple-50 p-2">
          <label htmlFor={`${id}-dg`} className={LIBELLE_CHAMP}>Dérogation à la séparation des tâches (réservée aux administrateurs){obligatoire ? " : motif obligatoire ici" : ", facultative"}</label>
          <p className="text-xs text-gray-800">À renseigner seulement pour valider un récolement que vous avez créé, soumis ou modifié. Elle est tracée dans l&apos;historique et dans l&apos;audit.</p>
          <textarea id={`${id}-dg`} value={derogation} onChange={(e) => setDerogation(e.target.value)} rows={2} maxLength={1000} disabled={enCours} className={CHAMP_TEXTE} />
          {derogation.trim() !== "" && <Compteur id={`${id}-dgn`} texte={derogation} />}
        </div>
      )}
    </CadreDialogue>
  );
}

// ---------------------------------------------------------------------------------------------------
// Fiche et section
// ---------------------------------------------------------------------------------------------------

function FicheRecolementVue({ requete, projetId, profil, estAdmin, enLigne, onRetour }: {
  requete: UseQueryResult<FicheRecolement, unknown>; projetId: string; profil: PropsSection["profil"]; estAdmin: boolean; enLigne: boolean; onRetour: () => void;
}, refTitre: React.Ref<HTMLHeadingElement>) {
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const { memoriser, restituer } = useRestitutionFocus("pv-titre-fiche-recolement");
  const rid = requete.data?.recolement.id ?? "";
  const statut = useStatutRecolement(projetId, rid);
  const modifier = useModifierRecolement(projetId, rid);
  const preuve = useAjouterPreuveWorkflow(projetId);
  const fermer = () => { setDialogue(null); restituer(); };
  const ouvrir = (d: Dialogue) => { memoriser(); setDialogue(d); };
  const f = requete.data;
  const retour = <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" onClick={onRetour}><ArrowLeft aria-hidden="true" /> Retour à la liste des récolements</Button>;

  if (requete.isPending) return <div className="space-y-2">{retour}<EtatChargement libelle="Chargement du récolement…" /></div>;
  if (requete.isError || !f) {
    return (
      <div className="space-y-2">
        {retour}
        <h3 id="pv-titre-fiche-recolement" ref={refTitre} tabIndex={-1} className="text-sm font-semibold text-navy focus:outline-none">Récolement</h3>
        <EtatErreur erreur={classerErreurWorkflow(requete.error)} sujet="Récolement" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />
      </div>
    );
  }
  const r = f.recolement;
  const transitions = r.transitions;
  const peutModifier = aLeDroit(profil.droits, "recolement.ecrire") && r.statut === "BROUILLON";
  // Un recolement valide ne recoit plus de preuve ; un referent n'en ajoute que sur un recolement soumis ou rejete (le serveur revalide).
  const peutPreuve = aLeDroit(profil.droits, "preuve.ajouter") && r.statut !== "VALIDE" && (!profil.referent || r.statut === "SOUMIS" || r.statut === "REJETE");

  return (
    <article aria-labelledby="pv-titre-fiche-recolement" data-testid="fiche-recolement" data-recolement-id={r.id} className="space-y-3 rounded-md border border-navy/30 bg-white p-3 shadow-sm">
      {retour}
      <header className="space-y-1.5">
        <h3 id="pv-titre-fiche-recolement" ref={refTitre} tabIndex={-1} className="break-words text-sm font-semibold text-navy focus:outline-none">{r.objet}</h3>
        <p className="flex flex-wrap items-center gap-1"><BadgeWorkflow style={STYLE_STATUT_RECOLEMENT[r.statut]} donnee="statut-recolement" valeur={r.statut} /></p>
        <p className="text-xs text-gray-800">{STYLE_STATUT_RECOLEMENT[r.statut].aide}</p>
        <p role="note" data-testid="mention-recolement" className="rounded border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">{MENTION_RECOLEMENT}</p>
      </header>
      <Liste>
        <Ligne libelle="Dossier de conflit lié">{r.conflit ? `${r.conflit.type ? LIBELLE_TYPE_CONFLIT[r.conflit.type] : "Dossier"} : ${r.conflit.axe ?? "axe non précisé"}${r.conflit.statut ? ` (${STYLE_STATUT_CONFLIT[r.conflit.statut].libelle})` : ""}` : "aucun"}</Ligne>
        <Ligne libelle="Jeu lié">{r.jeu ? `${r.jeu.nomFichier ?? "Jeu sans nom"}, version ${r.jeu.version ?? "?"}${r.jeu.statut ? ` (${r.jeu.statut === "AUTORISE" ? "autorisé" : "non autorisé"})` : ""}` : r.jeuMasque ? "jeu masqué pour votre profil (non autorisé)" : "aucun"}</Ligne>
        <Ligne libelle="Concessionnaire">{r.concessionnaire?.nom ?? "non communiqué"}</Ligne>
        <Ligne libelle="Date du récolement">{r.dateRecolement ? formaterDate(r.dateRecolement) : "non renseignée"}</Ligne>
        <Ligne libelle="Révision">{r.revision ?? "non fournie"}</Ligne>
      </Liste>
      <SectionFiche id="pv-fr-constat" titre="Constat et écarts (avant et après)">
        <Liste>
          <Ligne libelle="Constat"><span className="whitespace-pre-wrap">{r.constat ?? "non renseigné"}</span></Ligne>
          <Ligne libelle="Écarts"><span className="whitespace-pre-wrap">{r.ecarts ?? "non renseignés"}</span></Ligne>
        </Liste>
      </SectionFiche>
      {r.soumission && (
        <SectionFiche id="pv-fr-soumission" titre="Soumission">
          <p className="text-xs text-gray-900">Soumis{r.soumission.le ? ` le ${formaterDateHeure(r.soumission.le)}` : ""}{r.soumission.par ? ` par ${nomPersonne(r.soumission.par)}` : ""}.</p>
        </SectionFiche>
      )}
      {r.decision && (
        <SectionFiche id="pv-fr-decision" titre={r.statut === "REJETE" ? "Rejet" : "Validation par un tiers"}>
          <Liste>
            <Ligne libelle="Le">{r.decision.le ? formaterDateHeure(r.decision.le) : "date inconnue"}</Ligne>
            <Ligne libelle="Par">{nomPersonne(r.decision.par)}</Ligne>
            <Ligne libelle="Motif">{r.decision.motif ?? "non communiqué pour votre profil"}</Ligne>
            {r.decision.derogationSeparation && <Ligne libelle="Dérogation à la séparation des tâches"><strong>{r.decision.derogationSeparation}</strong></Ligne>}
          </Liste>
        </SectionFiche>
      )}
      <SectionFiche id="pv-fr-actions" titre="Actions">
        {transitions === null ? (
          <p className="text-xs text-gray-700">Le serveur n&apos;a pas indiqué les actions possibles : aucune n&apos;est proposée.</p>
        ) : transitions.length === 0 && !peutModifier ? (
          <p data-testid="aucune-action" className="text-xs text-gray-800">{r.statut === "VALIDE" ? "Récolement validé : il ne change plus. Pour une correction, créez un nouveau récolement." : "Aucune action n'est possible pour votre profil dans cet état."}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {transitions.map((tr) => (
              <li key={tr.vers}>
                <Button type="button" variant={tr.vers === "SOUMIS" || tr.vers === "VALIDE" ? "primary" : "outline"} className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => ouvrir({ genre: "transition", transition: tr })}>
                  {libelleTransitionRecolement(r.statut, tr.vers)}
                </Button>
              </li>
            ))}
            {peutModifier && <li><Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => ouvrir({ genre: "modifier" })}><Pencil aria-hidden="true" /> Modifier le brouillon</Button></li>}
          </ul>
        )}
      </SectionFiche>
      <SectionFiche id="pv-fr-preuves" titre={`Preuves (${f.preuves.length})`}>
        <ListePreuves preuves={f.preuves} />
        {peutPreuve && <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => ouvrir({ genre: "preuve" })}><FilePlus2 aria-hidden="true" /> Ajouter une preuve</Button>}
      </SectionFiche>
      <SectionFiche id="pv-fr-historique" titre="Historique (avant et après)"><HistoriqueWorkflow historique={f.historique} /></SectionFiche>

      {dialogue?.genre === "transition" && <DialogueTransitionRecolement fiche={f} transition={dialogue.transition} estAdmin={estAdmin} enLigne={enLigne} onFermer={fermer} onValider={(c) => statut.mutateAsync(c)} />}
      {dialogue?.genre === "modifier" && <DialogueModifRecolement recolement={r} enLigne={enLigne} onFermer={fermer} onValider={(c) => modifier.mutateAsync(c)} />}
      {dialogue?.genre === "preuve" && <DialoguePreuveWorkflow profil={profil.profil} enLigne={enLigne} onFermer={fermer} onValider={(corps) => preuve.mutateAsync({ objet: "RECOLEMENT", objetId: r.id, corps })} />}
    </article>
  );
}
const FicheRecolementAvecRef = forwardRef(FicheRecolementVue);

export function SectionRecolements(p: PropsSection & { estAdmin: boolean }) {
  const [filtres, setFiltres] = useState<FiltresRecolements>(FILTRES_RECOLEMENTS_VIDES);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const [creation, setCreation] = useState(false);
  const requete = useRecolements(p.projetId, filtres);
  const fiche = useFicheRecolement(p.projetId, ouverte);
  const creer = useCreerRecolement(p.projetId);
  const { memoriser, restituer } = useRestitutionFocus();
  const racine = useRef<HTMLDivElement>(null);
  const refTitre = useRef<HTMLHeadingElement>(null);
  const dernier = useRef<string | null>(null);
  const recolements = useMemo(() => requete.data?.pages.flatMap((pg) => pg.recolements) ?? [], [requete.data]);
  const compteurs = requete.data?.pages[0]?.compteurs ?? null;
  const peutEcrire = aLeDroit(p.profil.droits, "recolement.ecrire");
  useEffect(() => { if (ouverte && !fiche.isPending) refTitre.current?.focus(); }, [ouverte, fiche.isPending]);

  function retour() {
    const id = ouverte;
    setOuverte(null);
    setTimeout(() => racine.current?.querySelector<HTMLElement>(`button[data-recolement-id="${id}"]`)?.focus(), 0);
  }

  return (
    <div ref={racine} className="space-y-3">
      {ouverte && <FicheRecolementAvecRef ref={refTitre} requete={fiche} projetId={p.projetId} profil={p.profil} estAdmin={p.estAdmin} enLigne={p.enLigne} onRetour={retour} />}
      <section hidden={ouverte !== null} aria-labelledby="pv-titre-recolements" className="space-y-3">
        <h3 id="pv-titre-recolements" className="text-sm font-semibold text-navy">Récolements</h3>
        <p role="note" className="text-xs text-gray-800">{MENTION_RECOLEMENT}</p>
        {peutEcrire && <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!p.enLigne} onClick={() => { memoriser(); setCreation(true); }}><Plus aria-hidden="true" /> Nouveau récolement</Button>}
        <PucesStatut valeur={filtres.statut} onChange={(s) => setFiltres({ statut: s as StatutRecolement | "" })} statuts={STATUTS_RECOLEMENT} libelles={LIBELLE_STATUT_RECOLEMENT} compteurs={compteurs} libelleTous="Tous" aria="Filtrer les récolements par statut" />
        <ListePaginee
          requete={requete} sujet="Récolements" elements={recolements} etiquette="recolements" filtresActifs={filtres.statut !== ""} libelleChargement="Chargement des récolements…" libelleSuite="Charger les récolements suivants"
          videAucun={<p>Aucun récolement visible pour votre profil.{peutEcrire ? " Un récolement se crée pour un dossier dont un déplacement de réseau est décidé, ou pour un jeu reçu." : ""}</p>}
          rendre={(r: Recolement) => (
            <LigneBouton key={r.id} donnee="recolement" id={r.id} actif={dernier.current === r.id} onOuvrir={() => { dernier.current = r.id; setOuverte(r.id); }}>
              <span className="flex flex-wrap items-center gap-1"><BadgeWorkflow style={STYLE_STATUT_RECOLEMENT[r.statut]} donnee="statut-recolement" valeur={r.statut} /></span>
              <span className="break-words font-medium text-gray-900">{r.objet}</span>
              <span className="text-[11px] text-gray-700">
                {r.conflit ? `Dossier : ${r.conflit.axe ?? "axe non précisé"}` : r.jeu ? `Jeu : ${r.jeu.nomFichier ?? "sans nom"}` : "Lien non communiqué"}{r.concessionnaire?.nom ? ` · ${r.concessionnaire.nom}` : ""}{r.revision !== null ? ` · révision ${r.revision}` : ""}
              </span>
            </LigneBouton>
          )}
        />
      </section>
      {creation && <DialogueCreationRecolement projetId={p.projetId} enLigne={p.enLigne} onFermer={() => { setCreation(false); restituer(); }} onValider={(c) => creer.mutateAsync(c)} />}
    </div>
  );
}
