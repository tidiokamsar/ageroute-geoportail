import { useEffect, useMemo, useRef, useState } from "react";
import type { Geometry } from "geojson";
import { Download, Loader2, Play } from "lucide-react";
import { Button } from "../ui/Button";
import { useAuth } from "../../lib/auth";
import { AnalysesConflits } from "./AnalysesConflits";
import { FicheConflit } from "./FicheConflit";
import { CLASSES_BASCULE_ACTIF, CLASSES_BASCULE_INACTIF, ListeConflits } from "./ListeConflits";
import { ReglesConflits } from "./ReglesConflits";
import type { Concessionnaire, ProjetFiche } from "../../lib/projetsVoirieApi";
import { exporterConflitsCsv, type ConflitResume } from "../../lib/projetsVoirieConflitsApi";
import {
  useAcquitterReexamen, useAjouterPreuve, useAttribuer, useChangerStatut, useDecider, useFicheConflit, useLancerAnalyse, useListeConflits, useProposerDecision,
} from "../../lib/projetsVoirieConflitsHooks";
import { BANDEAU_GARDE_FOUS, DELAI_FILTRE_TEXTE_MS, FILTRES_VIDES, classerErreurConflit, nbFiltresActifs, type FiltresConflits } from "../../lib/projetsVoirieConflits";
import { useValeurDifferee } from "../../lib/projetsVoirieHooks";
import { formaterNombre } from "../../lib/projetsVoirie";

/**
 * Troisieme onglet de la page projet : « Conflits ». Le bandeau des garde-fous est PERMANENT (visible dans tous les etats : chargement, erreur,
 * liste vide, fiche ouverte). L'etat de l'onglet (filtres, conflit ouvert) vit ici, monte une fois visite et masque quand un autre onglet est
 * choisi : revenir sur « Conflits » retrouve la liste telle qu'on l'a laissee. Aucun stockage local.
 *
 * Trois vues : Dossiers (liste et fiche), Analyses (historique et comparaison), Regles. « Lancer une analyse » et l'export CSV sont reserves aux
 * ADMIN et GESTIONNAIRE (un lecteur ne voit ni l'un ni l'autre). Aucune action « deplacer », « ordonner » ou « executer ».
 */

export interface SurbrillanceConflit { cle: string; geometrie: Geometry }

export interface PropsOngletConflits {
  projet: ProjetFiche;
  actif: boolean;
  concessionnaires: Concessionnaire[];
  role: string | undefined;
  peutEcrire: boolean;
  estAdmin: boolean;
  enLigne: boolean;
  onSurbrillance: (s: SurbrillanceConflit | null) => void;
}

type Vue = "dossiers" | "analyses" | "regles";
const VUES: { id: Vue; libelle: string }[] = [{ id: "dossiers", libelle: "Dossiers" }, { id: "analyses", libelle: "Analyses" }, { id: "regles", libelle: "Règles" }];

export function BandeauGardeFous() {
  return (
    <p role="note" data-testid="bandeau-garde-fous" className="rounded-md border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">
      {BANDEAU_GARDE_FOUS}
    </p>
  );
}

export function OngletConflits(p: PropsOngletConflits) {
  const { user } = useAuth();
  const [vue, setVue] = useState<Vue>("dossiers");
  const [filtres, setFiltres] = useState<FiltresConflits>(FILTRES_VIDES);
  const [conflitId, setConflitId] = useState<string | null>(null);
  const [export_, setExport] = useState<{ etat: "repos" | "cours" | "erreur"; message?: string; code?: string | null }>({ etat: "repos" });
  // Les deux champs de texte (recherche et axe) ne partent au serveur qu'une fois la saisie posee : une requete par pause, pas une par touche.
  const qDiffere = useValeurDifferee(filtres.q.trim(), DELAI_FILTRE_TEXTE_MS);
  const axeDiffere = useValeurDifferee(filtres.axe.trim(), DELAI_FILTRE_TEXTE_MS);
  const filtresRequete = useMemo(() => ({ ...filtres, q: qDiffere, axe: axeDiffere }), [filtres, qDiffere, axeDiffere]);
  const liste = useListeConflits(p.projet.id, filtresRequete);

  const conflits = useMemo(() => liste.data?.pages.flatMap((pg) => pg.conflits) ?? [], [liste.data]);
  const premiere = liste.data?.pages[0];
  const ignores = liste.data?.pages.reduce((s, pg) => s + pg.ignores, 0) ?? 0;
  const selectionResume = conflits.find((c) => c.id === conflitId) ?? null;
  
  const fiche = useFicheConflit(p.projet.id, conflitId);
  const attribuer = useAttribuer(p.projet.id, conflitId ?? "");
  const statut = useChangerStatut(p.projet.id, conflitId ?? "");
  const preuve = useAjouterPreuve(p.projet.id, conflitId ?? "");
  const proposer = useProposerDecision(p.projet.id, conflitId ?? "");
  const decider = useDecider(p.projet.id, conflitId ?? "");
  const reexamen = useAcquitterReexamen(p.projet.id, conflitId ?? "");
  const lancer = useLancerAnalyse(p.projet.id);

  const racine = useRef<HTMLDivElement>(null);
  const refTitre = useRef<HTMLHeadingElement>(null);
  const dernierOuvert = useRef<string | null>(null);

  // Surbrillance sur la carte : la geometrie du conflit ouvert (la fiche d'abord, la liste sinon), seulement quand l'onglet est visible.
  const geometrie = (fiche.data && fiche.data.id === conflitId ? fiche.data.geom : null) ?? selectionResume?.geom ?? null;
  useEffect(() => {
    if (p.actif && conflitId && vue === "dossiers" && geometrie) p.onSurbrillance({ cle: conflitId, geometrie });
    else p.onSurbrillance(null);
  }, [p.actif, conflitId, vue, geometrie]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => p.onSurbrillance(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Ouvrir un dossier : le titre de la fiche prend le focus (lecteur d'ecran et clavier).
  useEffect(() => { if (conflitId && !fiche.isPending) refTitre.current?.focus(); }, [conflitId, fiche.isPending]);

  function ouvrir(c: Pick<ConflitResume, "id">) { dernierOuvert.current = c.id; setVue("dossiers"); setConflitId(c.id); }
  function retour() {
    const id = conflitId;
    setConflitId(null);
    // Le focus revient au bouton du dossier qu'on vient de quitter.
    setTimeout(() => racine.current?.querySelector<HTMLElement>(`button[data-conflit-id="${id}"]`)?.focus(), 0);
  }

  async function surExport() {
    setExport({ etat: "cours" });
    try { await exporterConflitsCsv(p.projet.id, p.projet.code, filtres); setExport({ etat: "repos" }); } catch (e) { const c = classerErreurConflit(e); setExport({ etat: "erreur", message: c.message, code: c.code }); }
  }

  const fichOuverte = conflitId !== null && vue === "dossiers";
  const erreurLancement = lancer.isError ? classerErreurConflit(lancer.error) : null;
  const resultat = lancer.data?.analyse ?? null;
  const rl = resultat?.resume;
  const nbFiltres = nbFiltresActifs(filtres);

  return (
    <div ref={racine} className="space-y-3">
      <BandeauGardeFous />

      {p.peutEcrire && !fichOuverte && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!p.enLigne || lancer.isPending} aria-busy={lancer.isPending} onClick={() => lancer.mutate()}>
            {lancer.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
            {lancer.isPending ? "Analyse en cours…" : "Lancer une analyse"}
          </Button>
          <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!p.enLigne || export_.etat === "cours"} onClick={() => void surExport()}>
            <Download aria-hidden="true" /> {export_.etat === "cours" ? "Export en cours…" : "Exporter les conflits (CSV)"}
          </Button>
          {nbFiltres > 0 && <span className="text-[11px] text-gray-700">L&apos;export suit vos filtres ({nbFiltres} actif{nbFiltres > 1 ? "s" : ""}).</span>}
        </div>
      )}

      <div aria-live="polite" className="space-y-2">
        {lancer.isPending && (
          <p role="status" data-testid="analyse-en-cours" className="flex items-start gap-2 rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-900">
            <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
            <span>Analyse en cours : le serveur calcule puis enregistre les conflits. Cela peut prendre quelques secondes ; une seule analyse à la fois est admise par projet. Ne quittez pas la page.</span>
          </p>
        )}
        {lancer.isSuccess && resultat && resultat.statut === "TERMINEE" && (
          <p role="status" data-testid="analyse-terminee" className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-900">
            <strong>Analyse {resultat.numero !== null ? `n° ${resultat.numero} ` : ""}terminée.</strong>{" "}
            {rl && rl.total !== null ? `${formaterNombre(rl.total, 0)} conflit(s)` : "Résultat enregistré"}
            {rl && rl.nouveaux !== null ? ` · ${formaterNombre(rl.nouveaux, 0)} nouveau(x)` : ""}
            {rl && rl.retrouves !== null ? ` · ${formaterNombre(rl.retrouves, 0)} retrouvé(s)` : ""}
            {rl && rl.disparus !== null ? ` · ${formaterNombre(rl.disparus, 0)} non retrouvé(s), marqués « à réexaminer » (ni fermés ni supprimés)` : ""}.
            {" "}Aucun verdict humain n&apos;a été modifié.
          </p>
        )}
        {/* Une analyse en echec (delai, volume) est repondue par une ERREUR HTTP (504, 422) et listee dans l'historique : le serveur ne repond jamais 2xx avec un statut ECHEC. */}
        {lancer.isSuccess && (!resultat || resultat.statut !== "TERMINEE") && (
          <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            Analyse lancée, mais le serveur n&apos;a pas détaillé son résultat : consultez l&apos;historique des analyses.
          </p>
        )}
        {erreurLancement && (
          <div role="alert" data-testid="analyse-erreur" data-code={erreurLancement.code ?? undefined} className="space-y-1 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
            <p><strong>L&apos;analyse n&apos;a pas abouti.</strong> {erreurLancement.message}</p>
            {erreurLancement.genre === "serveur" && p.peutEcrire && (
              <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne || lancer.isPending} onClick={() => lancer.mutate()}>Réessayer l&apos;analyse</Button>
            )}
          </div>
        )}
        {export_.etat === "erreur" && <p role="alert" data-testid="export-erreur" data-code={export_.code ?? undefined} className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">L&apos;export CSV a échoué. {export_.message}</p>}
      </div>

      <div role="group" aria-label="Sections de l'onglet Conflits" hidden={fichOuverte} className={fichOuverte ? "hidden" : "flex flex-wrap gap-1"}>
        {VUES.map((v) => (
          <button
            key={v.id} type="button" aria-pressed={vue === v.id} data-vue={v.id} onClick={() => setVue(v.id)}
            className={`min-h-[44px] rounded border px-3 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${vue === v.id ? CLASSES_BASCULE_ACTIF : CLASSES_BASCULE_INACTIF}`}
          >
            {v.libelle}
          </button>
        ))}
      </div>

      {/* Dossiers : toujours montes (filtres et defilement conserves), masques hors de leur vue. */}
      <div hidden={vue !== "dossiers"} className="space-y-3">
        {conflitId && (
          <FicheConflit
            ref={refTitre} requete={fiche} onRetour={retour} role={p.role} userId={user?.id} nomUtilisateur={user?.nomComplet}
            peutEcrire={p.peutEcrire} estAdmin={p.estAdmin} enLigne={p.enLigne}
            actions={{
              attribuer: (c) => attribuer.mutateAsync(c),
              changerStatut: (c) => statut.mutateAsync(c),
              ajouterPreuve: (c) => preuve.mutateAsync(c),
              proposerDecision: (c) => proposer.mutateAsync(c),
              decider: (decisionId, verdict, corps) => decider.mutateAsync({ decisionId, verdict, corps }),
              acquitterReexamen: (justification) => reexamen.mutateAsync(justification),
            }}
          />
        )}
        <div hidden={conflitId !== null}>
          <ListeConflits
            requete={liste} filtres={filtres} onFiltres={setFiltres} conflits={conflits} compteurs={premiere?.compteurs ?? null} ignores={ignores}
            selectionId={conflitId ?? dernierOuvert.current} onOuvrir={ouvrir} concessionnaires={p.concessionnaires} userId={user?.id} nomUtilisateur={user?.nomComplet}
          />
        </div>
      </div>

      {vue === "analyses" && <AnalysesConflits projetId={p.projet.id} onOuvrirConflit={(id) => ouvrir({ id })} />}
      {vue === "regles" && <ReglesConflits projetId={p.projet.id} peutEcrire={p.peutEcrire} estAdmin={p.estAdmin} userId={user?.id} enLigne={p.enLigne} />}
    </div>
  );
}
