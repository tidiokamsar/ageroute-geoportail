import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeft, FilePlus2, Pencil, Plus } from "lucide-react";
import { Button } from "../../ui/Button";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { useRestitutionFocus } from "../focusDialogue";
import { BadgeEcheanceDepassee, BadgeSimple, BadgeWorkflow, Liste, Ligne, LigneBouton, ListePaginee, nomPersonne, PucesStatut, SectionFiche } from "./commun";
import { DialogueCreationTache, DialogueModifTache, DialogueTransitionTache } from "./DialoguesTache";
import { DialoguePreuveWorkflow, HistoriqueWorkflow, ListePreuves } from "./PreuvesEtHistorique";
import type { FicheTache, Tache, TransitionTache } from "../../../lib/projetsVoirieWorkflowApi";
import {
  useAjouterPreuveWorkflow, useConflitsVue, useCreerTache, useDemandes, useFicheTache, useModifierTache, useReferents, useStatutTache, useTaches,
} from "../../../lib/projetsVoirieWorkflowHooks";
import {
  CLASSES_PRIORITE, FILTRES_DEMANDES_VIDES, FILTRES_TACHES_VIDES, LIBELLE_PRIORITE, LIBELLE_STATUT_TACHE, STATUTS_TACHE, STATUTS_TACHE_TERMINAUX, STYLE_STATUT_TACHE, aLeDroit,
  classerErreurWorkflow, libelleTransitionTache, type FiltresTaches, type StatutTache,
} from "../../../lib/projetsVoirieWorkflow";
import { LIBELLE_TYPE_CONFLIT } from "../../../lib/projetsVoirieConflits";
import { formaterDate } from "../../../lib/projetsVoirie";
import { formaterDateHeure } from "../../../lib/projetsVoirieConflits";
import type { PropsSection } from "./SectionDemandes";

/**
 * Taches : liste (statut, priorite, echeance, « mes taches »), fiche, transitions, preuves, historique. Les transitions proposees sont celles que le serveur
 * renvoie pour ce compte et cette tache (`transitionsPossibles`). Valider une tache exige un tiers (separation des taches), sauf derogation d'un administrateur.
 */

type Dialogue = { genre: "transition"; transition: TransitionTache } | { genre: "modifier" } | { genre: "preuve" };

export interface PropsSectionTaches extends PropsSection { userId: string | undefined; nomUtilisateur: string | undefined; estAdmin: boolean }

function FicheTacheVue({ requete, projetId, profil, userId, estAdmin, enLigne, referents, onRetour }: {
  requete: UseQueryResult<FicheTache, unknown>; projetId: string; profil: PropsSection["profil"]; userId: string | undefined; estAdmin: boolean; enLigne: boolean;
  referents: ReturnType<typeof useReferents>["data"]; onRetour: () => void;
}, refTitre: React.Ref<HTMLHeadingElement>) {
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const { memoriser, restituer } = useRestitutionFocus("pv-titre-fiche-tache");
  const tacheId = requete.data?.tache.id ?? "";
  const statut = useStatutTache(projetId, tacheId);
  const modifier = useModifierTache(projetId, tacheId);
  const preuve = useAjouterPreuveWorkflow(projetId);
  const fermer = () => { setDialogue(null); restituer(); };
  const ouvrir = (d: Dialogue) => { memoriser(); setDialogue(d); };
  const f = requete.data;
  const retour = <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" onClick={onRetour}><ArrowLeft aria-hidden="true" /> Retour à la liste des tâches</Button>;

  if (requete.isPending) return <div className="space-y-2">{retour}<EtatChargement libelle="Chargement de la tâche…" /></div>;
  if (requete.isError || !f) {
    return (
      <div className="space-y-2">
        {retour}
        <h3 id="pv-titre-fiche-tache" ref={refTitre} tabIndex={-1} className="text-sm font-semibold text-navy focus:outline-none">Tâche</h3>
        <EtatErreur erreur={classerErreurWorkflow(requete.error)} sujet="Tâche" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />
      </div>
    );
  }
  const t = f.tache;
  const terminal = STATUTS_TACHE_TERMINAUX.includes(t.statut);
  const transitions = t.transitions;
  const peutGerer = aLeDroit(profil.droits, "tache.gerer") && !terminal;
  const peutPreuve = aLeDroit(profil.droits, "preuve.ajouter") && !terminal;

  return (
    <article aria-labelledby="pv-titre-fiche-tache" data-testid="fiche-tache" data-tache-id={t.id} className="space-y-3 rounded-md border border-navy/30 bg-white p-3 shadow-sm">
      {retour}
      <header className="space-y-1.5">
        <h3 id="pv-titre-fiche-tache" ref={refTitre} tabIndex={-1} className="break-words text-sm font-semibold text-navy focus:outline-none">{t.titre}</h3>
        <p className="flex flex-wrap items-center gap-1">
          <BadgeWorkflow style={STYLE_STATUT_TACHE[t.statut]} donnee="statut-tache" valeur={t.statut} />
          {t.priorite && <BadgeSimple classes={CLASSES_PRIORITE[t.priorite]} donnee={`priorite-${t.priorite}`}>{LIBELLE_PRIORITE[t.priorite]}</BadgeSimple>}
          {t.echeanceDepassee === true && <BadgeEcheanceDepassee />}
          {t.validationRequise && <BadgeSimple classes="border-purple-300 bg-purple-50 text-purple-900" donnee="validation-requise">Validation par un tiers requise</BadgeSimple>}
        </p>
        <p className="text-xs text-gray-800">{STYLE_STATUT_TACHE[t.statut].aide}</p>
      </header>
      <Liste>
        <Ligne libelle="Responsable">{t.responsableEstMoi ? "vous" : nomPersonne(t.responsable)}{t.responsableEstMoi && t.responsable?.nom ? ` (${t.responsable.nom})` : ""}</Ligne>
        <Ligne libelle="Échéance">{t.echeance ? formaterDate(t.echeance) : "non fixée"}</Ligne>
        {t.description && <Ligne libelle="Description"><span className="whitespace-pre-wrap">{t.description}</span></Ligne>}
        <Ligne libelle="Concessionnaire">{t.concessionnaire?.nom ?? "aucun (tâche interne)"}</Ligne>
        <Ligne libelle="Lien">{t.demandeId ? "Liée à une demande de données" : t.conflitId ? "Liée à un dossier de conflit" : "aucun"}</Ligne>
        <Ligne libelle="Partage">{t.partagee ? "Partagée avec le référent du concessionnaire" : "Interne à AGEROUTE"}</Ligne>
        {t.termineLe && <Ligne libelle="Terminée le">{formaterDateHeure(t.termineLe)}</Ligne>}
        {t.creePar && <Ligne libelle="Créée par">{nomPersonne(t.creePar)}{t.createdAt ? `, ${formaterDateHeure(t.createdAt)}` : ""}</Ligne>}
      </Liste>

      <SectionFiche id="pv-ft-actions" titre="Actions">
        {transitions === null ? (
          <p className="text-xs text-gray-700">Le serveur n&apos;a pas indiqué les actions possibles : aucune n&apos;est proposée.</p>
        ) : transitions.length === 0 && !peutGerer ? (
          <p data-testid="aucune-action" className="text-xs text-gray-800">{terminal ? "Tâche terminée ou annulée : aucune action n'est possible." : "Aucune action n'est possible pour votre profil dans cet état : seul le responsable fait avancer sa tâche."}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {transitions.map((tr) => (
              <li key={tr.vers}>
                <Button type="button" variant={tr.vers === "TERMINEE" || tr.vers === "EN_COURS" ? "primary" : "outline"} className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => ouvrir({ genre: "transition", transition: tr })}>
                  {libelleTransitionTache(t.statut, tr.vers)}
                </Button>
              </li>
            ))}
            {peutGerer && <li><Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => ouvrir({ genre: "modifier" })}><Pencil aria-hidden="true" /> Modifier la tâche</Button></li>}
          </ul>
        )}
      </SectionFiche>

      <SectionFiche id="pv-ft-preuves" titre={`Preuves (${f.preuves.length})`}>
        <ListePreuves preuves={f.preuves} />
        {peutPreuve && <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => ouvrir({ genre: "preuve" })}><FilePlus2 aria-hidden="true" /> Ajouter une preuve</Button>}
      </SectionFiche>
      <SectionFiche id="pv-ft-historique" titre="Historique"><HistoriqueWorkflow historique={f.historique} /></SectionFiche>

      {dialogue?.genre === "transition" && <DialogueTransitionTache tache={t} transition={dialogue.transition} estAdmin={estAdmin} enLigne={enLigne} onFermer={fermer} onValider={(c) => statut.mutateAsync(c)} />}
      {dialogue?.genre === "modifier" && <DialogueModifTache tache={t} userId={userId} referents={referents?.rattachements ?? []} enLigne={enLigne} onFermer={fermer} onValider={(c) => modifier.mutateAsync(c)} />}
      {dialogue?.genre === "preuve" && <DialoguePreuveWorkflow profil={profil.profil} enLigne={enLigne} onFermer={fermer} onValider={(corps) => preuve.mutateAsync({ objet: "TACHE", objetId: t.id, corps })} />}
    </article>
  );
}
const FicheTacheAvecRef = forwardRef(FicheTacheVue);

export function SectionTaches(p: PropsSectionTaches) {
  const [filtres, setFiltres] = useState<FiltresTaches>(FILTRES_TACHES_VIDES);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const [creation, setCreation] = useState(false);
  const requete = useTaches(p.projetId, filtres);
  const fiche = useFicheTache(p.projetId, ouverte);
  const creer = useCreerTache(p.projetId);
  const peutGerer = aLeDroit(p.profil.droits, "tache.gerer");
  const referents = useReferents(p.projetId, aLeDroit(p.profil.droits, "referent.lire") && (ouverte !== null || creation));
  const demandes = useDemandes(p.projetId, FILTRES_DEMANDES_VIDES, creation && aLeDroit(p.profil.droits, "workflow.lire"));
  const conflits = useConflitsVue(p.projetId, [], creation && aLeDroit(p.profil.droits, "workflow.lire"));
  const { memoriser, restituer } = useRestitutionFocus();
  const racine = useRef<HTMLDivElement>(null);
  const refTitre = useRef<HTMLHeadingElement>(null);
  const dernier = useRef<string | null>(null);
  const taches = useMemo(() => requete.data?.pages.flatMap((pg) => pg.taches) ?? [], [requete.data]);
  const compteurs = requete.data?.pages[0]?.compteurs ?? null;
  useEffect(() => { if (ouverte && !fiche.isPending) refTitre.current?.focus(); }, [ouverte, fiche.isPending]);
  const filtresActifs = filtres.statut !== "" || filtres.responsableId !== "" || filtres.echeanceDepassee;
  const choixDemandes = (demandes.data?.pages.flatMap((pg) => pg.demandes) ?? []).filter((d) => d.statut !== "ANNULEE").map((d) => ({ id: d.id, libelle: `${d.objet}${d.concessionnaire?.nom ? ` (${d.concessionnaire.nom})` : ""}` }));
  const choixConflits = (conflits.data?.pages.flatMap((pg) => pg.conflits) ?? []).map((c) => ({ id: c.id, libelle: `${LIBELLE_TYPE_CONFLIT[c.type]} : ${c.axe ?? "axe non précisé"}${c.concessionnaire?.nom ? ` (${c.concessionnaire.nom})` : ""}` }));

  function retour() {
    const id = ouverte;
    setOuverte(null);
    setTimeout(() => racine.current?.querySelector<HTMLElement>(`button[data-tache-id="${id}"]`)?.focus(), 0);
  }

  return (
    <div ref={racine} className="space-y-3">
      {ouverte && <FicheTacheAvecRef ref={refTitre} requete={fiche} projetId={p.projetId} profil={p.profil} userId={p.userId} estAdmin={p.estAdmin} enLigne={p.enLigne} referents={referents.data} onRetour={retour} />}
      <section hidden={ouverte !== null} aria-labelledby="pv-titre-taches" className="space-y-3">
        <h3 id="pv-titre-taches" className="text-sm font-semibold text-navy">Tâches</h3>
        {peutGerer && <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!p.enLigne} onClick={() => { memoriser(); setCreation(true); }}><Plus aria-hidden="true" /> Nouvelle tâche</Button>}
        <PucesStatut valeur={filtres.statut} onChange={(s) => setFiltres((f) => ({ ...f, statut: s as StatutTache | "" }))} statuts={STATUTS_TACHE} libelles={LIBELLE_STATUT_TACHE} compteurs={compteurs} libelleTous="Toutes" aria="Filtrer les tâches par statut" />
        <div className="flex flex-wrap gap-x-4">
          {p.userId && (
            <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
              <input type="checkbox" className="h-4 w-4" checked={filtres.responsableId === p.userId} onChange={(e) => setFiltres((f) => ({ ...f, responsableId: e.target.checked ? (p.userId as string) : "" }))} />
              Mes tâches seulement
            </label>
          )}
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
            <input type="checkbox" className="h-4 w-4" checked={filtres.echeanceDepassee} onChange={(e) => setFiltres((f) => ({ ...f, echeanceDepassee: e.target.checked }))} />
            Échéance dépassée seulement
          </label>
        </div>
        <ListePaginee
          requete={requete} sujet="Tâches" elements={taches} etiquette="taches" filtresActifs={filtresActifs} libelleChargement="Chargement des tâches…" libelleSuite="Charger les tâches suivantes"
          videAucun={<p>Aucune tâche visible pour votre profil.{peutGerer ? " Créez-en une et désignez son responsable." : ""}</p>}
          rendre={(t: Tache) => (
            <LigneBouton key={t.id} donnee="tache" id={t.id} actif={dernier.current === t.id} onOuvrir={() => { dernier.current = t.id; setOuverte(t.id); }}>
              <span className="flex flex-wrap items-center gap-1">
                <BadgeWorkflow style={STYLE_STATUT_TACHE[t.statut]} donnee="statut-tache" valeur={t.statut} />
                {t.priorite && <BadgeSimple classes={CLASSES_PRIORITE[t.priorite]} donnee={`priorite-${t.priorite}`}>{LIBELLE_PRIORITE[t.priorite]}</BadgeSimple>}
                {t.echeanceDepassee === true && <BadgeEcheanceDepassee />}
                {t.validationRequise && <BadgeSimple classes="border-purple-300 bg-purple-50 text-purple-900">Validation requise</BadgeSimple>}
              </span>
              <span className="break-words font-medium text-gray-900">{t.titre}</span>
              <span className="text-[11px] text-gray-700">Responsable : {t.responsableEstMoi ? "vous" : nomPersonne(t.responsable)} · échéance {t.echeance ? formaterDate(t.echeance) : "non fixée"}{t.concessionnaire?.nom ? ` · ${t.concessionnaire.nom}` : ""}</span>
            </LigneBouton>
          )}
        />
      </section>
      {creation && (
        <DialogueCreationTache
          userId={p.userId} nomUtilisateur={p.nomUtilisateur} referents={referents.data?.rattachements ?? []} demandes={choixDemandes} conflits={choixConflits} enLigne={p.enLigne}
          onFermer={() => { setCreation(false); restituer(); }} onValider={(c) => creer.mutateAsync(c)}
        />
      )}
    </div>
  );
}
