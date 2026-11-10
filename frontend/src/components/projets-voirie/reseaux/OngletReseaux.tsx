import { useEffect, useMemo, useRef, useState } from "react";
import { CLASSES_BASCULE_ACTIF, CLASSES_BASCULE_INACTIF } from "../ListeConflits";
import { FicheObjetReseau, type ResultatLocalisation } from "./FicheObjetReseau";
import { ListeObjetsReseau } from "./ListeObjetsReseau";
import { VueComptage } from "./VueComptage";
import { VueRelations } from "./VueRelations";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";
import type { ObjetReseau } from "../../../lib/projetsVoirieReseauxApi";
import { useDeclarerDescripteur, useDeclarerRelation, useFicheObjetReseau, useObjetsReseau, useTransitionRelation } from "../../../lib/projetsVoirieReseauxHooks";
import { BANDEAU_RESEAUX, FILTRES_OBJETS_VIDES, MENTION_LIGNES_CABLES, type FiltresObjets } from "../../../lib/projetsVoirieReseaux";
import { useValeurDifferee } from "../../../lib/projetsVoirieHooks";
import { DELAI_FILTRE_TEXTE_MS } from "../../../lib/projetsVoirieConflits";

/**
 * Quatrieme onglet de la page projet : « Réseaux ». Objets (liste, fiche, qualification), Relations (propositions automatiques a valider, relations validees),
 * Comptage par nature. Le bandeau est PERMANENT : une association automatique n'est qu'une proposition ; un fichier de N lignes n'est pas N cables.
 *
 * L'etat de l'onglet (filtres, objet ouvert) vit ici, monte une fois visite et masque quand un autre onglet est choisi. Aucun stockage local.
 * Aucune route de ce volet ne rend de geometrie : la carte ne reçoit rien d'ici ; la mise en evidence d'un objet utilise la geometrie DEJA chargee par la carte.
 */

export interface PropsOngletReseaux {
  projet: { id: string; code: string };
  jeux: JeuProjet[];
  actif: boolean;
  peutEcrire: boolean;
  enLigne: boolean;
  localiser: (o: ObjetReseau) => ResultatLocalisation;
  enEvidence: boolean;
  onRetirerEvidence: () => void;
}

type Vue = "objets" | "relations" | "comptage";
const VUES: { id: Vue; libelle: string }[] = [{ id: "objets", libelle: "Objets" }, { id: "relations", libelle: "Relations" }, { id: "comptage", libelle: "Comptage" }];

export function BandeauReseaux() {
  return (
    <div role="note" data-testid="bandeau-reseaux" className="space-y-1 rounded-md border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">
      <p>{BANDEAU_RESEAUX}</p>
      <p>{MENTION_LIGNES_CABLES}</p>
    </div>
  );
}

export function OngletReseaux(p: PropsOngletReseaux) {
  const [vue, setVue] = useState<Vue>("objets");
  const [filtres, setFiltres] = useState<FiltresObjets>(FILTRES_OBJETS_VIDES);
  const [objetId, setObjetId] = useState<string | null>(null);
  const qDiffere = useValeurDifferee(filtres.q.trim(), DELAI_FILTRE_TEXTE_MS);
  const filtresRequete = useMemo(() => ({ ...filtres, q: qDiffere }), [filtres, qDiffere]);
  const liste = useObjetsReseau(p.projet.id, filtresRequete, p.actif || objetId !== null);
  const objets = useMemo(() => liste.data?.pages.flatMap((pg) => pg.objets) ?? [], [liste.data]);
  const ignores = liste.data?.pages.reduce((s, pg) => s + pg.ignores, 0) ?? 0;
  const fiche = useFicheObjetReseau(p.projet.id, objetId);
  const descripteur = useDeclarerDescripteur(p.projet.id, objetId ?? "");
  const transition = useTransitionRelation(p.projet.id);
  const declarer = useDeclarerRelation(p.projet.id);
  const racine = useRef<HTMLDivElement>(null);
  const refTitre = useRef<HTMLHeadingElement>(null);
  const dernierOuvert = useRef<string | null>(null);
  const { onRetirerEvidence } = p;

  // Ouvrir un objet : le titre de la fiche prend le focus (lecteur d'ecran et clavier).
  useEffect(() => { if (objetId && !fiche.isPending) refTitre.current?.focus(); }, [objetId, fiche.isPending]);
  // La mise en evidence ne survit ni a la fermeture de la fiche, ni a un autre onglet, ni a un autre objet.
  useEffect(() => { if (!p.actif || objetId === null || vue !== "objets") onRetirerEvidence(); }, [p.actif, objetId, vue, onRetirerEvidence]);
  useEffect(() => () => onRetirerEvidence(), [onRetirerEvidence]);

  function ouvrir(id: string) { dernierOuvert.current = id; setVue("objets"); setObjetId(id); }
  function retour() {
    const id = objetId;
    setObjetId(null);
    setTimeout(() => racine.current?.querySelector<HTMLElement>(`button[data-objet-reseau-id="${id}"]`)?.focus(), 0);
  }

  const ficheOuverte = objetId !== null && vue === "objets";

  return (
    <div ref={racine} className="space-y-3">
      <BandeauReseaux />

      <div role="group" aria-label="Sections de l'onglet Réseaux" hidden={ficheOuverte} className={ficheOuverte ? "hidden" : "flex flex-wrap gap-1"}>
        {VUES.map((v) => (
          <button key={v.id} type="button" aria-pressed={vue === v.id} data-vue={v.id} onClick={() => setVue(v.id)}
            className={`min-h-[44px] rounded border px-3 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${vue === v.id ? CLASSES_BASCULE_ACTIF : CLASSES_BASCULE_INACTIF}`}>
            {v.libelle}
          </button>
        ))}
      </div>

      <div hidden={vue !== "objets"} className="space-y-3">
        {objetId && (
          <FicheObjetReseau
            ref={refTitre} requete={fiche} projetId={p.projet.id} onRetour={retour} onOuvrirObjet={ouvrir} peutEcrire={p.peutEcrire} enLigne={p.enLigne}
            actions={{
              declarerDescripteur: (c) => descripteur.mutateAsync(c),
              transition: (relationId, action, justification) => transition.mutateAsync({ relationId, action, justification }),
              declarerRelation: (c) => declarer.mutateAsync(c),
            }}
            localiser={p.localiser} enEvidence={p.enEvidence} onRetirerEvidence={p.onRetirerEvidence}
          />
        )}
        <div hidden={objetId !== null}>
          <ListeObjetsReseau requete={liste} filtres={filtres} onFiltres={setFiltres} objets={objets} ignores={ignores} jeux={p.jeux} selectionId={objetId ?? dernierOuvert.current} onOuvrir={(o) => ouvrir(o.id)} />
        </div>
      </div>

      {vue === "relations" && <VueRelations projetId={p.projet.id} jeux={p.jeux} peutEcrire={p.peutEcrire} enLigne={p.enLigne} onOuvrirObjet={ouvrir} />}
      {vue === "comptage" && <VueComptage projetId={p.projet.id} jeux={p.jeux} peutEcrire={p.peutEcrire} actif={p.actif} />}
    </div>
  );
}
