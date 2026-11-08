import { useEffect, useId, useMemo, useState } from "react";
import { Loader2, Play, RotateCcw } from "lucide-react";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Input";
import { EtatErreur, EtatVide } from "../EtatsPv";
import { CLASSES_BASCULE_ACTIF, CLASSES_BASCULE_INACTIF } from "../ListeConflits";
import { nomDuJeu } from "../PanneauCouches";
import { useRestitutionFocus } from "../focusDialogue";
import { DialogueRelationAction } from "./DialoguesReseau";
import { ElementRelation } from "./ElementRelation";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";
import type { RelationReseau, ResultatProposition } from "../../../lib/projetsVoirieReseauxApi";
import { useProposerAssociations, useRelationsReseau, useTransitionRelation } from "../../../lib/projetsVoirieReseauxHooks";
import {
  AVERTISSEMENT_TOLERANCES, FILTRES_RELATIONS_VIDES, LIBELLE_ORIGINE_RELATION, LIBELLE_TYPE_RELATION, ORIGINES_RELATION, STATUTS_RELATION, STYLE_STATUT_RELATION, TYPES_RELATION,
  classerErreurReseau, type ActionRelation, type FiltresRelations, type OrigineRelation, type StatutRelation, type TypeRelation,
} from "../../../lib/projetsVoirieReseaux";
import { formaterNombre, formaterPourcent } from "../../../lib/projetsVoirie";

/**
 * Relations entre objets : liste filtrable (statut, type, origine) avec valider / refuser / revoquer, et lancement d'une PROPOSITION automatique.
 *
 * Une proposition automatique naît « Proposée » et n'a AUCUN effet tant qu'une personne ne l'a pas validee avec une justification : ce volet ne valide
 * jamais rien lui-meme. Le lancement gere les etats d'attente et les refus du serveur : 429 (delai a respecter, compte a rebours), 503 (projet ou service
 * occupe), 504 (delai depasse), 422 (trop de circuits), 409 (jeu non autorise).
 */

/** Compte a rebours en secondes : repart a chaque nouvelle valeur de `depart` (une erreur 429 avec son delai), jamais en dessous de zero. */
export function useCompteARebours(depart: number | null, cle: unknown): number {
  const [reste, setReste] = useState(0);
  useEffect(() => {
    if (depart === null || depart <= 0) { setReste(0); return; }
    setReste(depart);
    const t = setInterval(() => setReste((r) => (r <= 1 ? 0 : r - 1)), 1000);
    return () => clearInterval(t);
  }, [depart, cle]);
  return reste;
}

function ResultatProposition({ r, onVoir }: { r: ResultatProposition; onVoir: () => void }) {
  const b = r.bilan;
  const n = (v: number | null) => (v === null ? "non fourni" : formaterNombre(v, 0));
  return (
    <div role="status" data-testid="resultat-proposition" className="space-y-1.5 rounded border border-green-300 bg-green-50 p-2 text-xs text-green-900">
      <p><strong>Proposition automatique terminée.</strong> {b.creees === null ? "Le serveur n'indique pas le nombre de propositions créées." : `${n(b.creees)} proposition(s) créée(s)`} : elles sont « Proposées » et <strong>n&apos;ont aucun effet</strong> tant qu&apos;une personne ne les a pas validées.</p>
      <ul className="list-disc space-y-0.5 pl-5">
        <li>Circuits examinés : {n(b.circuitsExamines)} ; infrastructures examinées : {n(b.infrastructuresExaminees)}.</li>
        <li>Propositions calculées : {n(b.propositionsCalculees)} ; déjà connues (jamais réécrites, une refusée ne revient pas) : {n(b.dejaConnues)}.</li>
        <li>Classe E exclue : {n(b.classeEExclusCircuits)} circuit(s), {n(b.classeEExclusInfrastructures)} infrastructure(s) (pas de faux tracé).</li>
        {r.parametres.couvertureMin !== null && <li>Couverture minimale appliquée : {formaterPourcent(r.parametres.couvertureMin)}{r.parametres.parCircuitMax !== null ? ` ; au plus ${n(r.parametres.parCircuitMax)} propositions par circuit` : ""}.</li>}
      </ul>
      {b.tronque && <p className="font-semibold">Le résultat est tronqué : le serveur plafonne le nombre de propositions. Validez ou refusez celles qui existent, puis relancez.</p>}
      {r.avertissements.length > 0 && <ul className="list-disc space-y-0.5 pl-5">{r.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>}
      {r.parametres.provisoire && <p>{AVERTISSEMENT_TOLERANCES}</p>}
      <Button type="button" size="sm" variant="outline" className="min-h-[44px] bg-white xl:min-h-8" onClick={onVoir}>Voir les propositions à valider</Button>
    </div>
  );
}

function PanneauProposition({ projetId, jeux, enLigne, onVoirPropositions }: { projetId: string; jeux: JeuProjet[]; enLigne: boolean; onVoirPropositions: () => void }) {
  const idJeu = useId();
  const [jeuId, setJeuId] = useState("");
  const proposer = useProposerAssociations(projetId);
  const erreur = proposer.isError ? classerErreurReseau(proposer.error) : null;
  const reste = useCompteARebours(erreur?.status === 429 ? erreur.retryAfterS ?? null : null, proposer.error);
  const jeuxAutorises = jeux.filter((j) => (j.role === "RESEAU_TIERS" || j.role === "AUTRE") && j.statut === "AUTORISE");
  const occupe = proposer.isPending;

  return (
    <section aria-labelledby="pv-titre-proposition" className="space-y-2 rounded-md border border-gray-300 bg-gray-50 p-2">
      <h4 id="pv-titre-proposition" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Proposition automatique d&apos;associations</h4>
      <p className="text-xs text-gray-900">
        Le serveur compare les circuits logiques aux infrastructures physiques par superposition géométrique (jeux autorisés seulement, classe E exclue). Il ne crée que des
        <strong> propositions</strong> : rien n&apos;est appliqué sans une validation humaine justifiée.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[10rem] flex-1">
          <label htmlFor={idJeu} className="block text-xs font-medium text-gray-800">Restreindre à un jeu (facultatif)</label>
          <Select id={idJeu} value={jeuId} disabled={occupe} onChange={(e) => setJeuId(e.target.value)} className="border-gray-300">
            <option value="">Tous les jeux autorisés du projet</option>
            {jeuxAutorises.map((j) => <option key={j.id} value={j.id}>{nomDuJeu(j)}, version {j.version}</option>)}
          </Select>
        </div>
        <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!enLigne || occupe || reste > 0} aria-busy={occupe} onClick={() => proposer.mutate(jeuId || null)}>
          {occupe ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
          {occupe ? "Calcul en cours…" : reste > 0 ? `Réessayer dans ${reste} s` : "Lancer une proposition automatique"}
        </Button>
      </div>
      <p className="text-[11px] text-gray-700">{AVERTISSEMENT_TOLERANCES}</p>
      <div aria-live="polite" className="space-y-2">
        {occupe && (
          <p role="status" data-testid="proposition-en-cours" className="flex items-start gap-2 rounded border border-gray-300 bg-white p-2 text-xs text-gray-900">
            <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
            <span>Le serveur calcule les superpositions. Cela peut prendre quelques secondes (jusqu&apos;à 20 s) ; une seule exécution à la fois est admise par projet. Ne quittez pas la page.</span>
          </p>
        )}
        {proposer.isSuccess && proposer.data && <ResultatProposition r={proposer.data} onVoir={onVoirPropositions} />}
        {erreur && (
          <div role="alert" data-testid="proposition-erreur" data-code={erreur.code ?? undefined} data-status={erreur.status ?? undefined} className="space-y-1 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
            <p><strong>La proposition n&apos;a pas abouti.</strong> {erreur.message}</p>
            {(erreur.status === 503 || erreur.status === 504 || erreur.genre === "reseau") && (
              <Button type="button" size="sm" variant="outline" className="min-h-[44px] bg-white xl:min-h-8" disabled={!enLigne || occupe} onClick={() => proposer.mutate(jeuId || null)}>Réessayer</Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function VueRelations({ projetId, jeux, peutEcrire, enLigne, onOuvrirObjet }: {
  projetId: string; jeux: JeuProjet[]; peutEcrire: boolean; enLigne: boolean; onOuvrirObjet: (objetId: string) => void;
}) {
  const idType = useId();
  const idOrigine = useId();
  const [filtres, setFiltres] = useState<FiltresRelations>(FILTRES_RELATIONS_VIDES);
  const [action, setAction] = useState<{ relation: RelationReseau; action: ActionRelation } | null>(null);
  const { memoriser, restituer } = useRestitutionFocus();
  const requete = useRelationsReseau(projetId, filtres);
  const transition = useTransitionRelation(projetId);
  const relations = useMemo(() => requete.data?.pages.flatMap((pg) => pg.relations) ?? [], [requete.data]);
  const ignores = requete.data?.pages.reduce((s, pg) => s + pg.ignores, 0) ?? 0;
  const erreur = requete.isError ? classerErreurReseau(requete.error) : null;
  const aSuite = requete.hasNextPage === true;
  const maj = (p: Partial<FiltresRelations>) => setFiltres((f) => ({ ...f, ...p }));
  const filtresActifs = [filtres.statut, filtres.type, filtres.origine].filter(Boolean).length;

  return (
    <section aria-labelledby="pv-titre-relations" className="space-y-3">
      <h3 id="pv-titre-relations" className="text-sm font-semibold text-navy">Relations entre objets</h3>
      {peutEcrire && <PanneauProposition projetId={projetId} jeux={jeux} enLigne={enLigne} onVoirPropositions={() => setFiltres({ ...FILTRES_RELATIONS_VIDES, statut: "PROPOSEE", origine: "AUTOMATIQUE" })} />}

      <div role="group" aria-label="Filtrer par statut" className="flex flex-wrap gap-1">
        <button type="button" aria-pressed={filtres.statut === ""} onClick={() => maj({ statut: "" })}
          className={`min-h-[44px] rounded border px-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${filtres.statut === "" ? CLASSES_BASCULE_ACTIF : CLASSES_BASCULE_INACTIF}`}>Tous les statuts</button>
        {STATUTS_RELATION.map((s: StatutRelation) => {
          const on = filtres.statut === s;
          return (
            <button key={s} type="button" aria-pressed={on} data-statut-filtre={s} onClick={() => maj({ statut: on ? "" : s })}
              className={`min-h-[44px] rounded border px-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${on ? CLASSES_BASCULE_ACTIF : CLASSES_BASCULE_INACTIF}`}>
              {STYLE_STATUT_RELATION[s].libelle}
            </button>
          );
        })}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={idType} className="block text-xs font-medium text-gray-800">Type de relation</label>
          <Select id={idType} value={filtres.type} onChange={(e) => maj({ type: e.target.value as TypeRelation | "" })} className="border-gray-300">
            <option value="">Tous les types</option>
            {TYPES_RELATION.map((t) => <option key={t} value={t}>{LIBELLE_TYPE_RELATION[t]}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor={idOrigine} className="block text-xs font-medium text-gray-800">Origine</label>
          <Select id={idOrigine} value={filtres.origine} onChange={(e) => maj({ origine: e.target.value as OrigineRelation | "" })} className="border-gray-300">
            <option value="">Toutes les origines</option>
            {ORIGINES_RELATION.map((o) => <option key={o} value={o}>{LIBELLE_ORIGINE_RELATION[o]}</option>)}
          </Select>
        </div>
      </div>
      {filtresActifs > 0 && (
        <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" onClick={() => setFiltres(FILTRES_RELATIONS_VIDES)}><RotateCcw aria-hidden="true" /> Réinitialiser les filtres</Button>
      )}

      {requete.isPending && <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-700"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Chargement des relations…</p>}
      {erreur && <EtatErreur erreur={erreur} sujet="Relations" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}
      {requete.isSuccess && (
        <>
          <p role="status" className="text-xs text-gray-700" data-testid="etat-liste-relations">
            {relations.length === 0 ? "Aucune relation à afficher." : `${formaterNombre(relations.length, 0)} relation(s) chargée(s)${aSuite ? ", d'autres restent à charger" : ""}.`}
          </p>
          {ignores > 0 && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{ignores} relation(s) de la réponse n&apos;ont pas pu être lues (statut ou type inconnu de cette version) et ne sont pas affichées.</p>}
          {relations.length === 0 ? (
            filtresActifs > 0
              ? <EtatVide titre="Aucune relation ne correspond à ces filtres"><p>Modifiez ou réinitialisez les filtres.</p></EtatVide>
              : <EtatVide titre="Aucune relation pour ce projet"><p>Sans relation validée, le support physique d&apos;un circuit est inconnu, jamais supposé. Lancez une proposition automatique ou déclarez une relation depuis la fiche d&apos;un objet.</p></EtatVide>
          ) : (
            <ul aria-label="Liste des relations" className="space-y-1.5">
              {relations.map((r) => (
                <ElementRelation key={r.id} relation={r} enLigne={enLigne} onOuvrirObjet={onOuvrirObjet} onAction={(rel, a) => { memoriser(); setAction({ relation: rel, action: a }); }} />
              ))}
            </ul>
          )}
          {aSuite && (
            <Button type="button" variant="outline" className="min-h-[44px] w-full xl:min-h-9" disabled={requete.isFetchingNextPage} onClick={() => void requete.fetchNextPage()}>
              {requete.isFetchingNextPage ? "Chargement…" : "Charger les relations suivantes"}
            </Button>
          )}
        </>
      )}
      {action && (
        <DialogueRelationAction
          relation={action.relation} action={action.action} enLigne={enLigne} onFermer={() => { setAction(null); restituer(); }}
          onValider={(j) => transition.mutateAsync({ relationId: action.relation.id, action: action.action, justification: j })}
        />
      )}
    </section>
  );
}
