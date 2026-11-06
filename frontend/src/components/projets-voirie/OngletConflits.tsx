import { useEffect, useMemo, useRef, useState } from "react";
import type { Geometry } from "geojson";
import { useAuth } from "../../lib/auth";
import { FicheConflit } from "./FicheConflit";
import { ListeConflits } from "./ListeConflits";
import type { Concessionnaire, ProjetFiche } from "../../lib/projetsVoirieApi";
import type { ConflitResume } from "../../lib/projetsVoirieConflitsApi";
import {
  useAjouterPreuve, useAttribuer, useChangerStatut, useDecider, useFicheConflit, useListeConflits, useProposerDecision,
} from "../../lib/projetsVoirieConflitsHooks";
import { BANDEAU_GARDE_FOUS, FILTRES_VIDES, type FiltresConflits } from "../../lib/projetsVoirieConflits";
import { useValeurDifferee } from "../../lib/projetsVoirieHooks";

/**
 * Troisieme onglet de la page projet : « Conflits ». Le bandeau des garde-fous est PERMANENT (visible dans tous les etats : chargement, erreur,
 * liste vide, fiche ouverte). L'etat de l'onglet (filtres, conflit ouvert) vit ici, monte une fois visite et masque quand un autre onglet est
 * choisi : revenir sur « Conflits » retrouve la liste telle qu'on l'a laissee. Aucun stockage local.
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

export function BandeauGardeFous() {
  return (
    <p role="note" data-testid="bandeau-garde-fous" className="rounded-md border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">
      {BANDEAU_GARDE_FOUS}
    </p>
  );
}

export function OngletConflits(p: PropsOngletConflits) {
  const { user } = useAuth();
  const [filtres, setFiltres] = useState<FiltresConflits>(FILTRES_VIDES);
  const [conflitId, setConflitId] = useState<string | null>(null);
  const qDiffere = useValeurDifferee(filtres.q.trim(), 300);
  const filtresRequete = useMemo(() => ({ ...filtres, q: qDiffere }), [filtres, qDiffere]);
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

  const racine = useRef<HTMLDivElement>(null);
  const refTitre = useRef<HTMLHeadingElement>(null);
  const dernierOuvert = useRef<string | null>(null);

  // Surbrillance sur la carte : la geometrie du conflit ouvert (la fiche d'abord, la liste sinon), seulement quand l'onglet est visible.
  const geometrie = (fiche.data && fiche.data.id === conflitId ? fiche.data.geom : null) ?? selectionResume?.geom ?? null;
  useEffect(() => {
    if (p.actif && conflitId && geometrie) p.onSurbrillance({ cle: conflitId, geometrie });
    else p.onSurbrillance(null);
  }, [p.actif, conflitId, geometrie]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => p.onSurbrillance(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Ouvrir un dossier : le titre de la fiche prend le focus (lecteur d'ecran et clavier).
  useEffect(() => { if (conflitId && !fiche.isPending) refTitre.current?.focus(); }, [conflitId, fiche.isPending]);

  function ouvrir(c: ConflitResume) { dernierOuvert.current = c.id; setConflitId(c.id); }
  function retour() {
    const id = conflitId;
    setConflitId(null);
    // Le focus revient au bouton du dossier qu'on vient de quitter.
    setTimeout(() => racine.current?.querySelector<HTMLElement>(`button[data-conflit-id="${id}"]`)?.focus(), 0);
  }

  return (
    <div ref={racine} className="space-y-3">
      <BandeauGardeFous />
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
  );
}
