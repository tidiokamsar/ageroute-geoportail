import { useEffect, useMemo, useState } from "react";
import type { Geometry } from "geojson";
import { useAuth } from "../../lib/auth";
import { ListeConflits } from "./ListeConflits";
import type { Concessionnaire, ProjetFiche } from "../../lib/projetsVoirieApi";
import type { ConflitResume } from "../../lib/projetsVoirieConflitsApi";
import { useListeConflits } from "../../lib/projetsVoirieConflitsHooks";
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

  // Surbrillance sur la carte : la geometrie du conflit ouvert, seulement quand l'onglet est visible.
  useEffect(() => {
    if (p.actif && selectionResume?.geom) p.onSurbrillance({ cle: selectionResume.id, geometrie: selectionResume.geom });
    else p.onSurbrillance(null);
  }, [p.actif, selectionResume]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => p.onSurbrillance(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  function ouvrir(c: ConflitResume) { setConflitId(c.id); }

  return (
    <div className="space-y-3">
      <BandeauGardeFous />
      <ListeConflits
        requete={liste} filtres={filtres} onFiltres={setFiltres} conflits={conflits} compteurs={premiere?.compteurs ?? null} ignores={ignores}
        selectionId={conflitId} onOuvrir={ouvrir} concessionnaires={p.concessionnaires} userId={user?.id} nomUtilisateur={user?.nomComplet}
      />
    </div>
  );
}
