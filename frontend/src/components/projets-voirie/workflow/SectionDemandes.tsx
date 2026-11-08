import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeft, FilePlus2, Pencil, Plus } from "lucide-react";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Input";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { useRestitutionFocus } from "../focusDialogue";
import { BadgeEcheanceDepassee, BadgeWorkflow, nomPersonne, Liste, Ligne, LigneBouton, ListePaginee, PucesStatut, SectionFiche } from "./commun";
import { DialogueCreationDemande, DialogueEnvoi, DialogueFinDemande, DialogueModifDemande, DialogueReception } from "./DialoguesDemande";
import { DialoguePreuveWorkflow, HistoriqueWorkflow, ListePreuves } from "./PreuvesEtHistorique";
import type { Concessionnaire } from "../../../lib/projetsVoirieApi";
import type { Demande, FicheDemande, ProfilWorkflow } from "../../../lib/projetsVoirieWorkflowApi";
import {
  useAjouterPreuveWorkflow, useCreerDemande, useDemandes, useFicheDemande, useJeuxVue, useModifierDemande, useStatutDemande,
} from "../../../lib/projetsVoirieWorkflowHooks";
import {
  FILTRES_DEMANDES_VIDES, LIBELLE_STATUT_DEMANDE, MENTION_AUCUN_ENVOI, STATUTS_DEMANDE, STATUTS_DEMANDE_TERMINAUX, STYLE_STATUT_DEMANDE, aLeDroit, classerErreurWorkflow, libelleTransitionDemande,
  type FiltresDemandes, type StatutDemande,
} from "../../../lib/projetsVoirieWorkflow";
import { formaterDate, formaterNombre } from "../../../lib/projetsVoirie";
import { formaterDateHeure } from "../../../lib/projetsVoirieConflits";

/**
 * Demandes de donnees aux concessionnaires : liste (statut, echeance), fiche (envoi enregistre, reception, cloture), preuves, historique.
 * L'APPLICATION N'ENVOIE RIEN : « Enregistrer l'envoi » consigne un envoi fait hors application. Les actions proposees sont les transitions que le serveur
 * renvoie pour ce compte (`transitionsPossibles`), jamais une table locale.
 */

export interface PropsSection { projetId: string; profil: ProfilWorkflow; enLigne: boolean; concessionnaires: Concessionnaire[] }

type Dialogue =
  | { genre: "envoi" } | { genre: "reception" } | { genre: "fin"; vers: "CLOTUREE" | "ANNULEE" } | { genre: "modifier" } | { genre: "preuve" };

function FicheDemandeVue({ requete, projetId, profil, enLigne, onRetour }: { requete: UseQueryResult<FicheDemande, unknown>; projetId: string; profil: ProfilWorkflow; enLigne: boolean; onRetour: () => void }, refTitre: React.Ref<HTMLHeadingElement>) {
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const { memoriser, restituer } = useRestitutionFocus("pv-titre-fiche-demande");
  const demandeId = requete.data?.demande.id ?? "";
  const statut = useStatutDemande(projetId, demandeId);
  const modifier = useModifierDemande(projetId, demandeId);
  const preuve = useAjouterPreuveWorkflow(projetId);
  const jeux = useJeuxVue(projetId, requete.isSuccess && aLeDroit(profil.droits, "workflow.lire"));
  const fermer = () => { setDialogue(null); restituer(); };
  const ouvrir = (d: Dialogue) => { memoriser(); setDialogue(d); };
  const f = requete.data;
  const retour = <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" onClick={onRetour}><ArrowLeft aria-hidden="true" /> Retour à la liste des demandes</Button>;

  if (requete.isPending) return <div className="space-y-2">{retour}<EtatChargement libelle="Chargement de la demande…" /></div>;
  if (requete.isError || !f) {
    return (
      <div className="space-y-2">
        {retour}
        <h3 id="pv-titre-fiche-demande" ref={refTitre} tabIndex={-1} className="text-sm font-semibold text-navy focus:outline-none">Demande de données</h3>
        <EtatErreur erreur={classerErreurWorkflow(requete.error)} sujet="Demande" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />
      </div>
    );
  }
  const d = f.demande;
  const terminal = STATUTS_DEMANDE_TERMINAUX.includes(d.statut);
  const peutEcrire = aLeDroit(profil.droits, "demande.ecrire");
  const transitions = f.transitions;
  const jeuxLiables = (jeux.data ?? []).filter((j) => j.role === "RESEAU_TIERS" && j.statut !== "RETIRE" && (!d.concessionnaire || j.concessionnaire?.id === d.concessionnaire.id));
  const peutModifier = peutEcrire && !terminal && (d.statut !== "RECUE" || jeuxLiables.length > 0 || !!d.reception?.jeu);
  const peutPreuve = aLeDroit(profil.droits, "preuve.ajouter") && !terminal;
  const depassee = d.echeanceDepassee === true;

  return (
    <article aria-labelledby="pv-titre-fiche-demande" data-testid="fiche-demande" data-demande-id={d.id} className="space-y-3 rounded-md border border-navy/30 bg-white p-3 shadow-sm">
      {retour}
      <header className="space-y-1.5">
        <h3 id="pv-titre-fiche-demande" ref={refTitre} tabIndex={-1} className="break-words text-sm font-semibold text-navy focus:outline-none">{d.objet}</h3>
        <p className="flex flex-wrap items-center gap-1">
          <BadgeWorkflow style={STYLE_STATUT_DEMANDE[d.statut]} donnee="statut-demande" valeur={d.statut} />
          {depassee && <BadgeEcheanceDepassee />}
        </p>
        <p className="text-xs text-gray-800">{STYLE_STATUT_DEMANDE[d.statut].aide}</p>
        {(d.statut === "BROUILLON" || d.statut === "ENVOYEE") && <p role="note" data-testid="mention-aucun-envoi" className="rounded border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">{MENTION_AUCUN_ENVOI}</p>}
      </header>

      <Liste>
        <Ligne libelle="Concessionnaire">{d.concessionnaire?.nom ?? "non communiqué"}</Ligne>
        <Ligne libelle="Échéance de réponse">{d.echeance ? formaterDate(d.echeance) : "non fixée"}</Ligne>
        {d.description && <Ligne libelle="Description"><span className="whitespace-pre-wrap">{d.description}</span></Ligne>}
        {d.creePar && <Ligne libelle="Créée par">{nomPersonne(d.creePar)}{d.createdAt ? `, ${formaterDateHeure(d.createdAt)}` : ""}</Ligne>}
      </Liste>

      {d.envoi && (
        <SectionFiche id="pv-fd-envoi" titre="Envoi enregistré (fait hors application)">
          <Liste>
            <Ligne libelle="Date de l'envoi">{d.envoi.dateEnvoi ? formaterDate(d.envoi.dateEnvoi) : "non fournie"}</Ligne>
            <Ligne libelle="Canal">{d.envoi.canal ?? "non fourni"}</Ligne>
            <Ligne libelle="Référence">{d.envoi.reference ?? "aucune"}</Ligne>
            <Ligne libelle="Interlocuteur">{d.envoi.interlocuteur ?? "non communiqué pour votre profil"}</Ligne>
            {d.envoi.enregistrePar && <Ligne libelle="Enregistré par">{nomPersonne(d.envoi.enregistrePar)}{d.envoi.enregistreLe ? `, ${formaterDateHeure(d.envoi.enregistreLe)}` : ""}</Ligne>}
          </Liste>
        </SectionFiche>
      )}
      {d.reception && (
        <SectionFiche id="pv-fd-reception" titre="Réponse reçue">
          <Liste>
            <Ligne libelle="Date de réception">{d.reception.dateReception ? formaterDate(d.reception.dateReception) : "non fournie"}</Ligne>
            <Ligne libelle="Jeu reçu lié">
              {d.reception.jeu ? `${d.reception.jeu.nomFichier ?? "Jeu sans nom"}, version ${d.reception.jeu.version ?? "?"}${d.reception.jeu.statut ? ` (${d.reception.jeu.statut === "AUTORISE" ? "autorisé" : "en quarantaine"})` : ""}`
                : d.reception.jeuMasque ? "jeu masqué pour votre profil (non autorisé)" : "aucun"}
            </Ligne>
            {d.reception.enregistrePar && <Ligne libelle="Enregistrée par">{nomPersonne(d.reception.enregistrePar)}{d.reception.enregistreLe ? `, ${formaterDateHeure(d.reception.enregistreLe)}` : ""}</Ligne>}
          </Liste>
          <p className="text-[11px] text-gray-700">Un jeu reçu ne modifie rien : il reste en quarantaine jusqu&apos;à son autorisation depuis la page du projet.</p>
        </SectionFiche>
      )}
      {d.fin && (
        <SectionFiche id="pv-fd-fin" titre={d.fin.type === "ANNULEE" ? "Annulation" : "Clôture"}>
          <Liste>
            <Ligne libelle="Le">{d.fin.le ? formaterDateHeure(d.fin.le) : "date inconnue"}</Ligne>
            <Ligne libelle="Motif">{d.fin.motif ?? "non communiqué pour votre profil"}</Ligne>
            {d.fin.par && <Ligne libelle="Par">{nomPersonne(d.fin.par)}</Ligne>}
          </Liste>
        </SectionFiche>
      )}

      <SectionFiche id="pv-fd-actions" titre="Actions">
        {transitions === null ? (
          <p className="text-xs text-gray-700">Le serveur n&apos;a pas indiqué les actions possibles : aucune n&apos;est proposée.</p>
        ) : transitions.length === 0 && !peutModifier ? (
          <p data-testid="aucune-action" className="text-xs text-gray-800">{terminal ? "Demande terminée : aucune action n'est possible." : peutEcrire ? "Aucune action n'est possible dans cet état." : "Lecture seule : aucune action d'écriture n'est disponible pour votre profil."}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {transitions.map((v) => (
              <li key={v}>
                <Button type="button" variant={v === "ENVOYEE" ? "primary" : "outline"} className="min-h-[44px] xl:min-h-9" disabled={!enLigne}
                  onClick={() => ouvrir(v === "ENVOYEE" ? { genre: "envoi" } : v === "RECUE" ? { genre: "reception" } : { genre: "fin", vers: v === "ANNULEE" ? "ANNULEE" : "CLOTUREE" })}>
                  {libelleTransitionDemande(v)}
                </Button>
              </li>
            ))}
            {peutModifier && (
              <li>
                <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => ouvrir({ genre: "modifier" })}>
                  <Pencil aria-hidden="true" /> {d.statut === "RECUE" ? "Lier un jeu reçu" : "Modifier la demande"}
                </Button>
              </li>
            )}
          </ul>
        )}
      </SectionFiche>

      <SectionFiche id="pv-fd-preuves" titre={`Preuves (${f.preuves.length})`}>
        <ListePreuves preuves={f.preuves} />
        {peutPreuve && <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => ouvrir({ genre: "preuve" })}><FilePlus2 aria-hidden="true" /> Ajouter une preuve</Button>}
      </SectionFiche>

      <SectionFiche id="pv-fd-historique" titre="Historique"><HistoriqueWorkflow historique={f.historique} /></SectionFiche>

      {dialogue?.genre === "envoi" && <DialogueEnvoi demande={d} enLigne={enLigne} onFermer={fermer} onValider={(c) => statut.mutateAsync(c)} />}
      {dialogue?.genre === "reception" && <DialogueReception demande={d} jeuxLiables={jeuxLiables} enLigne={enLigne} onFermer={fermer} onValider={(c) => statut.mutateAsync(c)} />}
      {dialogue?.genre === "fin" && <DialogueFinDemande demande={d} vers={dialogue.vers} enLigne={enLigne} onFermer={fermer} onValider={(c) => statut.mutateAsync(c)} />}
      {dialogue?.genre === "modifier" && <DialogueModifDemande demande={d} jeuxLiables={jeuxLiables} enLigne={enLigne} onFermer={fermer} onValider={(c) => modifier.mutateAsync(c)} />}
      {dialogue?.genre === "preuve" && <DialoguePreuveWorkflow profil={profil.profil} enLigne={enLigne} onFermer={fermer} onValider={(corps) => preuve.mutateAsync({ objet: "DEMANDE", objetId: d.id, corps })} />}
    </article>
  );
}
const FicheDemandeAvecRef = forwardRef(FicheDemandeVue);

export function SectionDemandes(p: PropsSection) {
  const idConc = useId();
  const [filtres, setFiltres] = useState<FiltresDemandes>(FILTRES_DEMANDES_VIDES);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const [creation, setCreation] = useState(false);
  const requete = useDemandes(p.projetId, filtres);
  const fiche = useFicheDemande(p.projetId, ouverte);
  const creer = useCreerDemande(p.projetId);
  const { memoriser, restituer } = useRestitutionFocus();
  const racine = useRef<HTMLDivElement>(null);
  const refTitre = useRef<HTMLHeadingElement>(null);
  const dernier = useRef<string | null>(null);
  const demandes = useMemo(() => requete.data?.pages.flatMap((pg) => pg.demandes) ?? [], [requete.data]);
  const compteurs = requete.data?.pages[0]?.compteurs ?? null;
  const peutEcrire = aLeDroit(p.profil.droits, "demande.ecrire");
  useEffect(() => { if (ouverte && !fiche.isPending) refTitre.current?.focus(); }, [ouverte, fiche.isPending]);
  const filtresActifs = filtres.statut !== "" || filtres.concessionnaireId !== "" || filtres.echeanceDepassee;

  function retour() {
    const id = ouverte;
    setOuverte(null);
    setTimeout(() => racine.current?.querySelector<HTMLElement>(`button[data-demande-id="${id}"]`)?.focus(), 0);
  }

  return (
    <div ref={racine} className="space-y-3">
      {ouverte && <FicheDemandeAvecRef ref={refTitre} requete={fiche} projetId={p.projetId} profil={p.profil} enLigne={p.enLigne} onRetour={retour} />}
      <section hidden={ouverte !== null} aria-labelledby="pv-titre-demandes" className="space-y-3">
        <h3 id="pv-titre-demandes" className="text-sm font-semibold text-navy">Demandes de données aux concessionnaires</h3>
        <p role="note" className="text-xs text-gray-800">{MENTION_AUCUN_ENVOI}</p>
        {peutEcrire && (
          <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!p.enLigne} onClick={() => { memoriser(); setCreation(true); }}><Plus aria-hidden="true" /> Nouvelle demande</Button>
        )}
        <PucesStatut valeur={filtres.statut} onChange={(s) => setFiltres((f) => ({ ...f, statut: s as StatutDemande | "" }))} statuts={STATUTS_DEMANDE} libelles={LIBELLE_STATUT_DEMANDE} compteurs={compteurs} libelleTous="Toutes" aria="Filtrer les demandes par statut" />
        <div className="grid gap-2 sm:grid-cols-2">
          {peutEcrire && (
            <div>
              <label htmlFor={idConc} className="block text-xs font-medium text-gray-800">Concessionnaire</label>
              <Select id={idConc} value={filtres.concessionnaireId} onChange={(e) => setFiltres((f) => ({ ...f, concessionnaireId: e.target.value }))} className="border-gray-300">
                <option value="">Tous les concessionnaires</option>
                {p.concessionnaires.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
              </Select>
            </div>
          )}
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
            <input type="checkbox" className="h-4 w-4" checked={filtres.echeanceDepassee} onChange={(e) => setFiltres((f) => ({ ...f, echeanceDepassee: e.target.checked }))} />
            Échéance dépassée seulement
          </label>
        </div>
        <ListePaginee
          requete={requete} sujet="Demandes" elements={demandes} etiquette="demandes" filtresActifs={filtresActifs} libelleChargement="Chargement des demandes…" libelleSuite="Charger les demandes suivantes"
          videAucun={<p>Aucune demande pour ce projet.{peutEcrire ? " Créez un brouillon, envoyez-le hors application, puis enregistrez l'envoi ici." : ""}</p>}
          rendre={(d: Demande) => (
            <LigneBouton key={d.id} donnee="demande" id={d.id} actif={dernier.current === d.id} onOuvrir={() => { dernier.current = d.id; setOuverte(d.id); }}>
              <span className="flex flex-wrap items-center gap-1">
                <BadgeWorkflow style={STYLE_STATUT_DEMANDE[d.statut]} donnee="statut-demande" valeur={d.statut} />
                {d.echeanceDepassee === true && <BadgeEcheanceDepassee />}
              </span>
              <span className="break-words font-medium text-gray-900">{d.objet}</span>
              <span className="text-[11px] text-gray-700">{d.concessionnaire?.nom ?? "Concessionnaire non communiqué"} · échéance {d.echeance ? formaterDate(d.echeance) : "non fixée"}{d.envoi?.dateEnvoi ? ` · envoyée le ${formaterDate(d.envoi.dateEnvoi)}` : ""}</span>
            </LigneBouton>
          )}
        />
        <p className="text-[11px] text-gray-700">{formaterNombre(demandes.length, 0)} demande(s) chargée(s).</p>
      </section>
      {creation && (
        <DialogueCreationDemande concessionnaires={p.concessionnaires} enLigne={p.enLigne} onFermer={() => { setCreation(false); restituer(); }} onValider={(c) => creer.mutateAsync(c)} />
      )}
    </div>
  );
}
