import { useMemo } from "react";
import { Button } from "../../ui/Button";
import { EtatErreur, EtatVide } from "../EtatsPv";
import { BadgeSimple, Liste, Ligne } from "./commun";
import { useConflitsVue, useJeuxVue } from "../../../lib/projetsVoirieWorkflowHooks";
import type { ProfilWorkflow } from "../../../lib/projetsVoirieWorkflowApi";
import { ACTIONS_WORKFLOW, BANDEAU_WORKFLOW, LIBELLE_ACTION_WORKFLOW, LIBELLE_PROFIL, classerErreurWorkflow } from "../../../lib/projetsVoirieWorkflow";
import { LIBELLE_OPTION_DECISION, LIBELLE_TYPE_CONFLIT, STYLE_STATUT_CONFLIT } from "../../../lib/projetsVoirieConflits";
import { LIBELLE_ROLE, LIBELLE_STATUT_JEU, formaterDate, formaterNombre, type RoleJeu, type StatutJeu } from "../../../lib/projetsVoirie";

/**
 * « Mon profil » : le role, le profil de workflow, les rattachements et les droits RENVOYES par le serveur. Seules les actions permises sont listees : une action
 * non permise n'est pas affichee (et son bouton n'existe pas ailleurs dans l'ecran). Puis « Dossiers et jeux » : la vue concessionnaire des dossiers de conflit
 * (sans geometrie, sans mesure, sans cout) et les metadonnees des jeux, en lecture seule.
 */

export function ProfilWorkflowVue({ profil }: { profil: ProfilWorkflow }) {
  const permises = ACTIONS_WORKFLOW.filter((a) => profil.droits.includes(a));
  return (
    <section aria-labelledby="pv-titre-profil" className="space-y-3">
      <h3 id="pv-titre-profil" className="text-sm font-semibold text-navy">Mon profil pour les échanges avec les concessionnaires</h3>
      <p role="note" data-testid="bandeau-workflow" className="rounded-md border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">{BANDEAU_WORKFLOW}</p>
      <Liste>
        <Ligne libelle="Profil">{profil.profil ? LIBELLE_PROFIL[profil.profil] : "non précisé par le serveur"}</Ligne>
        <Ligne libelle="Rôle du compte">{profil.role ?? "non précisé"}</Ligne>
        <Ligne libelle="Référent concessionnaire">{profil.referent ? "oui" : "non"}</Ligne>
      </Liste>
      {profil.referent && (
        <section aria-labelledby="pv-profil-rattachements" className="space-y-1">
          <h4 id="pv-profil-rattachements" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Mes rattachements</h4>
          {profil.rattachements.length === 0 ? <p className="text-xs text-gray-700">Aucun rattachement actif sur un projet visible pour votre compte.</p> : (
            <ul className="space-y-1">
              {profil.rattachements.map((r) => <li key={r.id} className="rounded border border-gray-200 p-1.5 text-xs text-gray-900">Projet <strong>{r.projet.nom ?? r.projet.code ?? "sans nom"}</strong>{r.projet.code ? ` (${r.projet.code})` : ""} · concessionnaire <strong>{r.concessionnaire.nom ?? "sans nom"}</strong></li>)}
            </ul>
          )}
          <p className="text-[11px] text-gray-700">Vous voyez et complétez seulement ce qui est partagé avec votre concessionnaire, sur les projets où vous êtes rattaché. Le reste du module (carte, analyses, dossiers internes) ne vous est pas ouvert.</p>
        </section>
      )}
      <section aria-labelledby="pv-profil-droits" className="space-y-1">
        <h4 id="pv-profil-droits" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Ce que votre profil permet ici</h4>
        {permises.length === 0 ? <p className="text-xs text-gray-700">Aucune action n&apos;est permise à votre profil pour les échanges de ce projet.</p> : (
          <ul data-testid="droits-permis" className="list-disc space-y-0.5 pl-5 text-xs text-gray-900">{permises.map((a) => <li key={a} data-droit={a}>{LIBELLE_ACTION_WORKFLOW[a]}</li>)}</ul>
        )}
        <p className="text-[11px] text-gray-700">Les actions qui ne figurent pas dans cette liste ne sont pas proposées dans cet écran. Le serveur contrôle chaque geste.</p>
      </section>
      {profil.socle.length > 0 && (
        <details className="text-xs text-gray-900">
          <summary className="cursor-pointer font-medium">Actes du module, décidés ailleurs (rappel du serveur)</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{profil.socle.map((s) => <li key={s.acte}><strong>{s.acte}</strong> : {s.roles.join(", ")}{s.separation ? `. Séparation : ${s.separation}` : ""}</li>)}</ul>
        </details>
      )}
      {profil.correspondance.length > 0 && (
        <details className="text-xs text-gray-900">
          <summary className="cursor-pointer font-medium">Correspondance des rôles du cahier des charges avec les comptes</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{profil.correspondance.map((c) => <li key={c.roleCahier}><strong>{c.roleCahier}</strong>{c.compte ? ` : compte ${c.compte}` : ""}{c.resume ? `. ${c.resume}` : ""}</li>)}</ul>
        </details>
      )}
      {profil.provisoire && (
        <p role="note" data-testid="provisoire" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <strong>Provisoire.</strong> La correspondance des rôles et la matrice des droits sont une proposition prudente, en attente de la décision de la direction des systèmes d&apos;information.
        </p>
      )}
      {profil.avertissements.length > 0 && <ul data-testid="avertissements-profil" className="list-disc space-y-0.5 pl-5 text-xs text-amber-900">{profil.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>}
    </section>
  );
}

export function SectionDossiersJeux({ projetId }: { projetId: string }) {
  const conflits = useConflitsVue(projetId, [], true);
  const jeux = useJeuxVue(projetId, true);
  const liste = useMemo(() => conflits.data?.pages.flatMap((pg) => pg.conflits) ?? [], [conflits.data]);
  const ignores = conflits.data?.pages.reduce((s, pg) => s + pg.ignores, 0) ?? 0;
  return (
    <section aria-labelledby="pv-titre-dossiers" className="space-y-4">
      <h3 id="pv-titre-dossiers" className="text-sm font-semibold text-navy">Dossiers de conflit et jeux (vue concessionnaire, lecture seule)</h3>
      <p role="note" className="text-xs text-gray-800">Cette vue ne montre ni géométrie, ni mesure, ni coût, ni justification interne. Un dossier est un signal de vérification : aucun déplacement n&apos;est décidé ni ordonné par le système.</p>

      <section aria-labelledby="pv-dossiers-liste" className="space-y-1.5">
        <h4 id="pv-dossiers-liste" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Dossiers de conflit</h4>
        {conflits.isPending && conflits.fetchStatus !== "idle" && <p role="status" className="text-xs text-gray-700">Chargement des dossiers…</p>}
        {conflits.isError && <EtatErreur erreur={classerErreurWorkflow(conflits.error)} sujet="Dossiers de conflit" onReessayer={() => void conflits.refetch()} enCours={conflits.isFetching} />}
        {conflits.isSuccess && (
          <>
            {ignores > 0 && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{ignores} dossier(s) de la réponse n&apos;ont pas pu être lus (statut ou type inconnu de cette version) et ne sont pas affichés.</p>}
            {liste.length === 0 ? <EtatVide titre="Aucun dossier visible pour votre profil"><p>Un référent ne voit que les dossiers confirmés par une personne, sur un jeu autorisé de son concessionnaire.</p></EtatVide> : (
              <ul aria-label="Liste : dossiers de conflit" className="space-y-1.5">
                {liste.map((c) => (
                  <li key={c.id} data-conflit-vue-id={c.id} className="space-y-0.5 rounded border border-gray-300 bg-white p-2 text-xs text-gray-900">
                    <p className="flex flex-wrap items-center gap-1">
                      <BadgeSimple classes={STYLE_STATUT_CONFLIT[c.statut].classes} donnee={`statut-conflit-${c.statut}`}>{STYLE_STATUT_CONFLIT[c.statut].libelle}</BadgeSimple>
                      <BadgeSimple classes="border-gray-400 bg-white text-gray-900">{LIBELLE_TYPE_CONFLIT[c.type]}</BadgeSimple>
                    </p>
                    <p className="break-words font-medium">{c.axe ?? "Axe non précisé"}{c.concessionnaire?.nom ? ` · ${c.concessionnaire.nom}` : ""}</p>
                    {c.objet && <p className="text-[11px] text-gray-700">Objet : {c.objet}</p>}
                    <p className="text-[11px] text-gray-700">
                      {c.decisionRetenue
                        ? `Décision approuvée : ${c.decisionRetenue.option ? LIBELLE_OPTION_DECISION[c.decisionRetenue.option] : "option non fournie"}${c.decisionRetenue.dateDebutPrevue ? `, début prévu le ${formaterDate(c.decisionRetenue.dateDebutPrevue)}` : ""}${c.decisionRetenue.dateFinPrevue ? `, fin prévue le ${formaterDate(c.decisionRetenue.dateFinPrevue)}` : ""}.`
                        : "Aucune décision approuvée."}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {conflits.hasNextPage && <Button type="button" variant="outline" className="min-h-[44px] w-full xl:min-h-9" disabled={conflits.isFetchingNextPage} onClick={() => void conflits.fetchNextPage()}>{conflits.isFetchingNextPage ? "Chargement…" : "Charger les dossiers suivants"}</Button>}
          </>
        )}
      </section>

      <section aria-labelledby="pv-jeux-liste" className="space-y-1.5">
        <h4 id="pv-jeux-liste" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Jeux de données (métadonnées seulement)</h4>
        {jeux.isPending && jeux.fetchStatus !== "idle" && <p role="status" className="text-xs text-gray-700">Chargement des jeux…</p>}
        {jeux.isError && <EtatErreur erreur={classerErreurWorkflow(jeux.error)} sujet="Jeux de données" onReessayer={() => void jeux.refetch()} enCours={jeux.isFetching} />}
        {jeux.isSuccess && (jeux.data.length === 0 ? <EtatVide titre="Aucun jeu visible pour votre profil"><p>Un référent ne voit que les jeux autorisés de son concessionnaire.</p></EtatVide> : (
          <ul aria-label="Liste : jeux" className="space-y-1.5">
            {jeux.data.map((j) => (
              <li key={j.id} data-jeu-vue-id={j.id} className="rounded border border-gray-300 bg-white p-2 text-xs text-gray-900">
                <p className="break-words font-medium">{j.nomFichier ?? "Jeu sans nom"}, version {j.version ?? "?"}</p>
                <p className="text-[11px] text-gray-700">
                  {j.role ? LIBELLE_ROLE[j.role as RoleJeu] ?? j.role : "rôle non précisé"}{j.concessionnaire?.nom ? ` · ${j.concessionnaire.nom}` : ""} · {j.statut ? LIBELLE_STATUT_JEU[j.statut as StatutJeu] ?? j.statut : "statut non précisé"}
                  {j.dateDonnees ? ` · données du ${formaterDate(j.dateDonnees)}` : ""}{j.nbObjets !== null ? ` · ${formaterNombre(j.nbObjets, 0)} circuit(s) ou objet(s) du fichier` : ""}
                  {j.classePrecision && j.classePrecision !== "INCONNUE" ? ` · classe ${j.classePrecision}` : " · classe non renseignée"}
                </p>
              </li>
            ))}
          </ul>
        ))}
      </section>
    </section>
  );
}
