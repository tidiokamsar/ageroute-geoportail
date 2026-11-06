/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { forwardRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeft, ClipboardPlus, FilePlus2, Gavel, UserCog } from "lucide-react";
import { Button } from "../ui/Button";
import { EtatChargement, EtatErreur } from "./EtatsPv";
import { BadgeEcheanceDepassee, BadgeReexamen, BadgeRisque, BadgeStatutConflit, BadgeStatutDecision, BadgeTypeConflit } from "./BadgesConflit";
import { DialogueApprobation, DialogueAttribution, DialogueDecision, DialoguePreuve, DialogueTransition } from "./ActionsConflit";
import { texteValeur } from "./FicheObjet";
import type {
  ConflitFiche, CorpsApprobation, CorpsAttribution, CorpsDecision, CorpsPreuve, CorpsStatut, DecisionConflit, TransitionPossible,
} from "../../lib/projetsVoirieConflitsApi";
import { transitionsAffichees } from "../../lib/projetsVoirieConflitsApi";
import {
  AIDE_MOTIF_REEXAMEN, AIDE_TYPE_CONFLIT, LIBELLE_ACTION_HISTORIQUE, LIBELLE_OPTION_DECISION, LIBELLE_TYPE_CONFLIT, LIBELLE_TYPE_PREUVE, MENTION_VERTICAL, STYLE_STATUT_CONFLIT,
  classerErreurConflit, echeanceDepassee, formaterDateHeure, libelleAction, libelleTransition,
} from "../../lib/projetsVoirieConflits";
import {
  AIDE_CLASSE, LIBELLE_ROLE, STYLE_RESEAU, classeIncertaine, formaterDate, formaterMetres, formaterNombre,
  type RoleJeu,
} from "../../lib/projetsVoirie";

/**
 * Fiche d'un dossier de conflit : mesure, regle et sa version, sources et versions des jeux, classe de precision, « vertical non evalue »,
 * troncons proches du referentiel (lecture seule), historique (chronologique, acteur, justification), preuves, decisions.
 *
 * ACTIONS : seules celles que le SERVEUR propose pour le compte et l'etat (transitions possibles). Si la reponse n'en porte pas, la table du
 * contrat sert d'affichage de secours et la fiche le dit ; le serveur refuse de toute facon une transition interdite. AUCUNE action
 * « deplacer », « ordonner » ou « executer » : une decision est PROPOSEE puis APPROUVEE par des humains. Tout est rendu en TEXTE (aucun HTML).
 */

export interface ActionsFiche {
  attribuer: (c: CorpsAttribution) => Promise<unknown>;
  changerStatut: (c: CorpsStatut) => Promise<unknown>;
  ajouterPreuve: (c: CorpsPreuve) => Promise<unknown>;
  proposerDecision: (c: CorpsDecision) => Promise<unknown>;
  decider: (decisionId: string, verdict: "approuver" | "refuser", corps: CorpsApprobation) => Promise<unknown>;
}

export interface PropsFicheConflit {
  requete: UseQueryResult<ConflitFiche, unknown>;
  onRetour: () => void;
  role: string | undefined;
  userId: string | undefined;
  nomUtilisateur: string | undefined;
  peutEcrire: boolean;
  estAdmin: boolean;
  enLigne: boolean;
  actions: ActionsFiche;
}

type Dialogue =
  | { genre: "transition"; transition: TransitionPossible }
  | { genre: "attribution" }
  | { genre: "preuve" }
  | { genre: "decision" }
  | { genre: "approbation"; decision: DecisionConflit; verdict: "approuver" | "refuser" };

function Ligne({ libelle, children }: { libelle: string; children: React.ReactNode }) {
  return (<><dt className="text-gray-700">{libelle}</dt><dd className="break-words text-gray-900">{children}</dd></>);
}

const Section = ({ id, titre, children }: { id: string; titre: string; children: React.ReactNode }) => (
  <section aria-labelledby={id} className="space-y-1.5 border-t border-gray-200 pt-2">
    <h4 id={id} className="text-xs font-semibold uppercase tracking-wide text-gray-800">{titre}</h4>
    {children}
  </section>
);

function Montant({ valeur, devise }: { valeur: number | null; devise: string | null }) {
  return <>{valeur === null ? "non renseigné" : `${formaterNombre(valeur, 2)}${devise ? ` ${devise}` : ""}`}</>;
}

export const FicheConflit = forwardRef<HTMLHeadingElement, PropsFicheConflit>(function FicheConflit(p, refTitre) {
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const fermer = () => setDialogue(null);
  const f = p.requete.data;

  const retour = (
    <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" onClick={p.onRetour}>
      <ArrowLeft aria-hidden="true" /> Retour à la liste des conflits
    </Button>
  );

  if (p.requete.isPending) return <div className="space-y-2">{retour}<EtatChargement libelle="Chargement du dossier…" /></div>;
  if (p.requete.isError || !f) {
    return (
      <div className="space-y-2">
        {retour}
        <h3 ref={refTitre} tabIndex={-1} className="text-sm font-semibold text-navy focus:outline-none">Dossier de conflit</h3>
        <EtatErreur erreur={classerErreurConflit(p.requete.error)} sujet="Dossier de conflit" onReessayer={() => void p.requete.refetch()} enCours={p.requete.isFetching} />
      </div>
    );
  }

  const { liste: transitions, deSecours } = transitionsAffichees(f, p.role);
  const m = f.mesure;
  const depassee = echeanceDepassee(f.echeance, f.statut);
  const clos = f.statut === "CLOTURE";
  const peutProposer = p.peutEcrire && f.statut === "CONFIRME";

  return (
    <article aria-labelledby="pv-titre-fiche-conflit" data-testid="fiche-conflit" data-conflit-id={f.id} className="space-y-3 rounded-md border border-navy/30 bg-white p-3 shadow-sm">
      {retour}
      <header className="space-y-1.5">
        <h3 id="pv-titre-fiche-conflit" ref={refTitre} tabIndex={-1} className="break-words text-sm font-semibold text-navy focus:outline-none">
          {LIBELLE_TYPE_CONFLIT[f.type]} : {f.axe ?? "axe non précisé"}
        </h3>
        <p className="flex flex-wrap items-center gap-1">
          <BadgeStatutConflit statut={f.statut} />
          <BadgeTypeConflit type={f.type} />
          <BadgeRisque risque={f.risque} />
          {depassee && <BadgeEcheanceDepassee />}
        </p>
        <p className="text-xs text-gray-800">{STYLE_STATUT_CONFLIT[f.statut].aide}</p>
        <p className="text-xs text-gray-700">{AIDE_TYPE_CONFLIT[f.type]}</p>
        {f.aReexaminer && (
          <div role="note" className="space-y-1 rounded border-2 border-purple-400 bg-purple-50 p-2 text-xs text-purple-900">
            <BadgeReexamen motif={f.motifReexamen} />
            <p>{f.motifReexamen ? AIDE_MOTIF_REEXAMEN[f.motifReexamen] : "Une analyse demande un réexamen de ce dossier. Son verdict humain est conservé."}</p>
          </div>
        )}
        {f.geom === null && <p className="text-xs text-gray-700">La géométrie de ce conflit n&apos;est pas fournie par le serveur : la carte ne peut pas le mettre en évidence.</p>}
      </header>

      <Section id="pv-fc-mesure" titre="Mesure">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <Ligne libelle="Longueur dans la chaussée">{m.longueurChausseeM === null ? "non mesurée" : formaterMetres(m.longueurChausseeM)}</Ligne>
          <Ligne libelle="Longueur dans l'emprise">{m.longueurEmpriseM === null ? "non mesurée" : formaterMetres(m.longueurEmpriseM)}</Ligne>
          <Ligne libelle="Distance minimale">{m.distanceMinM === null ? "non mesurée" : formaterMetres(m.distanceMinM)}</Ligne>
          <Ligne libelle="Croisements">{m.nbCroisements === null ? "non comptés" : formaterNombre(m.nbCroisements, 0)}</Ligne>
        </dl>
      </Section>

      <Section id="pv-fc-precision" titre="Précision et limites">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <Ligne libelle="Classe de précision">{AIDE_CLASSE[f.classePrecision]}{classeIncertaine(f.classePrecision) ? " : position indicative, proximité à vérifier" : ""}</Ligne>
          <Ligne libelle="Vertical"><strong data-testid="mention-vertical">{f.verticalEvalue === true ? "Évalué" : f.verticalEvalue === false ? MENTION_VERTICAL : `${MENTION_VERTICAL} (le serveur ne précise pas son évaluation)`}</strong></Ligne>
        </dl>
      </Section>

      <Section id="pv-fc-regle" titre="Règle appliquée">
        {f.regle ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            <Ligne libelle="Règle">{f.regle.code ?? "code non fourni"}, <strong>version {f.regle.version === null ? "inconnue" : f.regle.version}</strong></Ligne>
            <Ligne libelle="Famille">{f.regle.famille ? STYLE_RESEAU[f.regle.famille].libelle : "toutes familles"}</Ligne>
            <Ligne libelle="Tolérance de proximité">{f.regle.toleranceProximiteM === null ? "non fournie" : formaterMetres(f.regle.toleranceProximiteM)}</Ligne>
            <Ligne libelle="Marge d'incertitude">{f.regle.margeIncertitude === null ? "non fournie" : `facteur ${formaterNombre(f.regle.margeIncertitude, 2)} sur la précision déclarée`}</Ligne>
          </dl>
        ) : <p className="text-xs text-gray-700">La règle appliquée n&apos;est pas fournie par le serveur.</p>}
        <p className="text-xs text-gray-700">
          Première analyse : {f.premiereAnalyse ? (f.premiereAnalyse.numero !== null ? `n° ${f.premiereAnalyse.numero}` : "référence fournie") : "inconnue"}
          {" · "}Dernière analyse : {f.derniereAnalyse ? (f.derniereAnalyse.numero !== null ? `n° ${f.derniereAnalyse.numero}` : "référence fournie") : "inconnue"}
        </p>
      </Section>

      <Section id="pv-fc-sources" titre="Sources et versions des jeux">
        {f.sources.length === 0 ? <p className="text-xs text-gray-700">Aucune source n&apos;est listée par le serveur pour ce conflit.</p> : (
          <ul className="space-y-1">
            {f.sources.map((s, i) => (
              <li key={`${s.jeuId ?? s.sha256}-${i}`} className="rounded border border-gray-200 p-1.5 text-xs text-gray-900">
                <span className="font-medium break-words">{s.nomFichier ?? s.concessionnaire ?? "Jeu sans nom"}</span>
                {" · version "}{s.version ?? "inconnue"}{s.role ? ` · ${LIBELLE_ROLE[s.role as RoleJeu] ?? s.role}` : ""}{s.concessionnaire ? ` · ${s.concessionnaire}` : ""}
                {s.classePrecision ? ` · ${AIDE_CLASSE[s.classePrecision]}` : ""}
                {s.sha256 && <span className="block break-all text-[11px] text-gray-700">empreinte SHA-256 : {s.sha256.slice(0, 16)}…</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="pv-fc-troncons" titre="Tronçons proches du référentiel (lecture seule)">
        {f.tronconsProches.length === 0 ? <p className="text-xs text-gray-700">Aucun tronçon du référentiel relevé à proximité. Le référentiel officiel n&apos;est jamais modifié par ces dossiers.</p> : (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-900">
            {f.tronconsProches.map((t) => <li key={t.code}>{t.code}{t.nom ? ` : ${t.nom}` : ""}</li>)}
          </ul>
        )}
      </Section>

      <Section id="pv-fc-attribution" titre="Attribution">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <Ligne libelle="Responsable">{f.responsable ? (f.responsable.nom ?? "compte sans nom") : "non attribué"}</Ligne>
          <Ligne libelle="Échéance">{f.echeance ? formaterDate(f.echeance) : "non fixée"}</Ligne>
          <Ligne libelle="Action proposée">{f.actionProposee ?? "aucune"}</Ligne>
          <Ligne libelle="Concessionnaire">{f.concessionnaire ? (f.concessionnaire.nom ?? "sans nom") : "aucun (zone sans jeu réseau)"}</Ligne>
        </dl>
        {p.peutEcrire && !clos && (
          <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} onClick={() => setDialogue({ genre: "attribution" })}>
            <UserCog aria-hidden="true" /> Attribuer ou modifier
          </Button>
        )}
      </Section>

      <Section id="pv-fc-statut" titre="Changer le statut">
        {transitions.length === 0 ? (
          <p data-testid="aucune-transition" className="text-xs text-gray-800">
            {clos ? "Dossier clos : aucune transition n'est possible."
              : p.peutEcrire ? "Aucune transition n'est possible pour votre compte dans cet état."
              : "Lecture seule : aucune action d'écriture n'est disponible pour votre compte."}
          </p>
        ) : (
          <>
            {deSecours && <p role="note" className="text-xs text-gray-700">Le serveur n&apos;a pas fourni la liste des transitions : celles-ci sont données à titre indicatif d&apos;après le contrat, et le serveur refusera toute transition interdite.</p>}
            <ul className="flex flex-wrap gap-2">
              {transitions.map((t) => (
                <li key={t.vers}>
                  <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!p.enLigne} onClick={() => setDialogue({ genre: "transition", transition: t })}>
                    {libelleTransition(f.statut, t.vers)}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="pv-fc-preuves" titre={`Preuves (${f.preuves.length})`}>
        {f.preuves.length === 0 ? <p className="text-xs text-gray-700">Aucune preuve au dossier. Au moins une est requise pour confirmer un conflit.</p> : (
          <ol className="space-y-1.5">
            {f.preuves.map((pr) => (
              <li key={pr.id} className="rounded border border-gray-200 p-1.5 text-xs text-gray-900">
                <p><strong>{LIBELLE_TYPE_PREUVE[pr.type]}</strong>{pr.reference ? ` · réf. ${pr.reference}` : ""}</p>
                <p className="whitespace-pre-wrap break-words">{pr.texte}</p>
                <p className="text-[11px] text-gray-700">{pr.auteur?.nom ?? "auteur inconnu"} · {formaterDateHeure(pr.createdAt)}</p>
              </li>
            ))}
          </ol>
        )}
        {p.peutEcrire && !clos && (
          <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} onClick={() => setDialogue({ genre: "preuve" })}>
            <FilePlus2 aria-hidden="true" /> Ajouter une preuve
          </Button>
        )}
      </Section>

      <Section id="pv-fc-decisions" titre={`Décisions (${f.decisions.length})`}>
        <p role="note" className="text-xs text-gray-700">Une décision est proposée, puis approuvée ou refusée par des personnes habilitées. Le système n&apos;ordonne et n&apos;exécute rien.</p>
        {f.decisions.length === 0 ? <p className="text-xs text-gray-700">Aucune décision proposée.</p> : (
          <ol className="space-y-2">
            {f.decisions.map((d) => (
              <li key={d.id} data-decision-id={d.id} className="space-y-1 rounded border border-gray-300 p-2 text-xs text-gray-900">
                <p className="flex flex-wrap items-center gap-1"><strong>{LIBELLE_OPTION_DECISION[d.option]}</strong> <BadgeStatutDecision statut={d.statut} /></p>
                {d.justification && <p className="whitespace-pre-wrap break-words">{d.justification}</p>}
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  {d.contraintes && <Ligne libelle="Contraintes">{d.contraintes}</Ligne>}
                  <Ligne libelle="Coût estimé"><Montant valeur={d.coutEstime} devise={d.deviseCout} /></Ligne>
                  <Ligne libelle="Coût réel"><Montant valeur={d.coutReel} devise={d.deviseCout} /></Ligne>
                  <Ligne libelle="Début prévu">{d.dateDebutPrevue ? formaterDate(d.dateDebutPrevue) : "non renseigné"}</Ligne>
                  <Ligne libelle="Fin prévue">{d.dateFinPrevue ? formaterDate(d.dateFinPrevue) : "non renseigné"}</Ligne>
                  <Ligne libelle="Proposée par">{d.proposePar?.nom ?? "inconnu"}</Ligne>
                  {d.approuvePar && <Ligne libelle={d.statut === "REFUSEE" ? "Refusée par" : "Décidée par"}>{d.approuvePar.nom ?? "compte sans nom"}{d.approuveLe ? `, ${formaterDateHeure(d.approuveLe)}` : ""}</Ligne>}
                  {d.motifDecision && <Ligne libelle="Motif">{d.motifDecision}</Ligne>}
                  {d.derogationSeparation && <Ligne libelle="Dérogation à la séparation des tâches"><strong>{d.derogationSeparation}</strong></Ligne>}
                </dl>
                {p.peutEcrire && d.statut === "PROPOSEE" && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} aria-label={`Approuver la décision : ${LIBELLE_OPTION_DECISION[d.option]}`} onClick={() => setDialogue({ genre: "approbation", decision: d, verdict: "approuver" })}>Approuver</Button>
                    <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} aria-label={`Refuser la décision : ${LIBELLE_OPTION_DECISION[d.option]}`} onClick={() => setDialogue({ genre: "approbation", decision: d, verdict: "refuser" })}>Refuser</Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {peutProposer && (
          <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} onClick={() => setDialogue({ genre: "decision" })}>
            <Gavel aria-hidden="true" /> Proposer une décision
          </Button>
        )}
      </Section>

      <Section id="pv-fc-historique" titre={`Historique (${f.historique.length})`}>
        {f.historique.length === 0 ? <p className="text-xs text-gray-700">Aucune entrée d&apos;historique.</p> : (
          <div role="region" aria-label="Historique du dossier, liste défilante" tabIndex={0} className="max-h-72 overflow-auto">
            <ol className="space-y-1.5">
              {f.historique.map((h) => (
                <li key={h.id} className="rounded border border-gray-200 p-1.5 text-xs text-gray-900">
                  <p className="font-medium">{libelleAction(h.action)}{!(h.action in LIBELLE_ACTION_HISTORIQUE) ? " (action inconnue de cette version)" : ""}</p>
                  <p className="text-[11px] text-gray-700">{formaterDateHeure(h.createdAt)} · {h.acteur ? (h.acteur.nom ?? "compte sans nom") : "calcul automatique, aucun acteur humain"}</p>
                  {(h.ancienStatut || h.nouveauStatut) && (
                    <p className="flex flex-wrap items-center gap-1">
                      {h.ancienStatut ? <BadgeStatutConflit statut={h.ancienStatut} /> : <span className="text-gray-700">création</span>}
                      <span aria-label="vers">vers</span>
                      {h.nouveauStatut && <BadgeStatutConflit statut={h.nouveauStatut} />}
                    </p>
                  )}
                  {h.justification && <p className="whitespace-pre-wrap break-words">Justification : {h.justification}</p>}
                  {h.donnees && Object.keys(h.donnees).length > 0 && (
                    <details className="text-[11px] text-gray-700">
                      <summary className="cursor-pointer">Données de l&apos;événement</summary>
                      <pre className="whitespace-pre-wrap break-all">{texteValeur(h.donnees)}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </Section>

      <p className="text-[11px] text-gray-700"><ClipboardPlus aria-hidden="true" className="mr-1 inline h-3 w-3" />Créé le {formaterDateHeure(f.createdAt)} · mis à jour le {formaterDateHeure(f.updatedAt)}.</p>

      {dialogue?.genre === "transition" && (
        <DialogueTransition fiche={f} transition={dialogue.transition} estAdmin={p.estAdmin} enLigne={p.enLigne} onFermer={fermer} onValider={p.actions.changerStatut} />
      )}
      {dialogue?.genre === "attribution" && (
        <DialogueAttribution fiche={f} userId={p.userId} nomUtilisateur={p.nomUtilisateur} enLigne={p.enLigne} onFermer={fermer} onValider={p.actions.attribuer} />
      )}
      {dialogue?.genre === "preuve" && <DialoguePreuve enLigne={p.enLigne} onFermer={fermer} onValider={p.actions.ajouterPreuve} />}
      {dialogue?.genre === "decision" && <DialogueDecision enLigne={p.enLigne} onFermer={fermer} onValider={p.actions.proposerDecision} />}
      {dialogue?.genre === "approbation" && (
        <DialogueApprobation
          decision={dialogue.decision} verdict={dialogue.verdict} userId={p.userId} estAdmin={p.estAdmin} enLigne={p.enLigne} onFermer={fermer}
          onValider={(corps) => p.actions.decider(dialogue.decision.id, dialogue.verdict, corps)}
        />
      )}
    </article>
  );
});
