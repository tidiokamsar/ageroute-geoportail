import { forwardRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowLeft, Link2, MapPin, MapPinOff, PenLine } from "lucide-react";
import { Button } from "../../ui/Button";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { useRestitutionFocus } from "../focusDialogue";
import { BadgeClasse, BadgeNature } from "./BadgesReseau";
import { DialogueDescripteur, DialogueNouvelleRelation, DialogueRelationAction, sensPossibles } from "./DialoguesReseau";
import { ElementRelation } from "./ElementRelation";
import type { CorpsRelation, FicheObjetReseau as FicheLue, ObjetReseau, RelationReseau } from "../../../lib/projetsVoirieReseauxApi";
import {
  AIDE_NATURE_COURTE, LIBELLE_CONFIANCE, LIBELLE_ETAT_VERTICAL, LIBELLE_ORIGINE_VALEUR, LIBELLE_STATUT_JEU_COURT, LIBELLE_STATUT_QUALITE, MENTION_3D, MENTION_LIGNES_CABLES,
  ROLES_JEU_QUALIFIABLES, STATUTS_JEU_QUALIFIABLES, classerErreurReseau, libelleTypeObjet, texteMetres, type ActionRelation, type CorpsDescripteur, LIBELLE_ETAT_CONNEXION, MENTION_CONNEXION,
} from "../../../lib/projetsVoirieReseaux";
import { AIDE_CLASSE, LIBELLE_CONFIDENTIALITE, LIBELLE_ROLE, formaterDate, formaterMetres, type Confidentialite, type RoleJeu } from "../../../lib/projetsVoirie";
import { formaterDateHeure } from "../../../lib/projetsVoirieConflits";

/**
 * Fiche d'un objet de reseau : nature, type, source (jeu, version, confidentialite du jeu), qualite declaree, vertical (valeurs affichees SEULEMENT si le
 * serveur les fournit, jamais de conclusion 3D), circuits superposes, descripteur (auteur, justification), relations. Aucune geometrie.
 *
 * Actions : qualifier l'objet et declarer une relation (ADMIN et GESTIONNAIRE, jeu en controle ou autorise) ; valider, refuser, revoquer : celles que le
 * serveur offre pour chaque relation. Rien ici n'ordonne, ne deplace ni ne decide quoi que ce soit.
 */

export type ResultatLocalisation = "TROUVE" | "HORS_VUE" | "JEU_NON_AFFICHE";

export interface ActionsFicheReseau {
  declarerDescripteur: (c: CorpsDescripteur) => Promise<unknown>;
  transition: (relationId: string, action: ActionRelation, justification: string) => Promise<unknown>;
  declarerRelation: (c: CorpsRelation) => Promise<unknown>;
}

export interface PropsFicheObjetReseau {
  requete: UseQueryResult<FicheLue, unknown>;
  projetId: string;
  onRetour: () => void;
  onOuvrirObjet: (objetId: string) => void;
  peutEcrire: boolean;
  enLigne: boolean;
  actions: ActionsFicheReseau;
  /** Met l'objet en evidence sur la carte a partir de la geometrie DEJA chargee par la carte (aucune geometrie n'est demandee par ce volet). */
  localiser: (o: ObjetReseau) => ResultatLocalisation;
  enEvidence: boolean;
  onRetirerEvidence: () => void;
}

type Dialogue = { genre: "descripteur" } | { genre: "relation-action"; relation: RelationReseau; action: ActionRelation } | { genre: "nouvelle-relation" };

function Ligne({ libelle, children }: { libelle: string; children: React.ReactNode }) {
  return (<><dt className="text-gray-700">{libelle}</dt><dd className="break-words text-gray-900">{children}</dd></>);
}
const Section = ({ id, titre, children }: { id: string; titre: string; children: React.ReactNode }) => (
  <section aria-labelledby={id} className="space-y-1.5 border-t border-gray-200 pt-2">
    <h4 id={id} className="text-xs font-semibold uppercase tracking-wide text-gray-800">{titre}</h4>
    {children}
  </section>
);

const MESSAGE_LOCALISATION: Record<ResultatLocalisation, string> = {
  TROUVE: "Objet mis en évidence sur la carte (trait bleu nuit épais cerclé de blanc), à partir de la géométrie déjà chargée par la carte.",
  HORS_VUE: "La géométrie de cet objet n'est pas dans la vue chargée par la carte : ce volet ne charge aucune géométrie. Utilisez « Centrer sur le projet » ou déplacez la carte vers la zone du réseau, puis réessayez.",
  JEU_NON_AFFICHE: "Le jeu de cet objet n'est pas affiché sur la carte (jeu décoché dans l'onglet Couches, ou non autorisé et non demandé) : affichez-le, puis réessayez.",
};

export const FicheObjetReseau = forwardRef<HTMLHeadingElement, PropsFicheObjetReseau>(function FicheObjetReseau(p, refTitre) {
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const [localisation, setLocalisation] = useState<ResultatLocalisation | null>(null);
  const { memoriser, restituer } = useRestitutionFocus("pv-titre-fiche-objet-reseau");
  const fermer = () => { setDialogue(null); restituer(); };
  const ouvrir = (d: Dialogue) => { memoriser(); setDialogue(d); };
  const f = p.requete.data;

  const retour = (
    <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" onClick={p.onRetour}>
      <ArrowLeft aria-hidden="true" /> Retour à la liste des objets
    </Button>
  );

  if (p.requete.isPending) return <div className="space-y-2">{retour}<EtatChargement libelle="Chargement de l'objet…" /></div>;
  if (p.requete.isError || !f) {
    return (
      <div className="space-y-2">
        {retour}
        <h3 id="pv-titre-fiche-objet-reseau" ref={refTitre} tabIndex={-1} className="text-sm font-semibold text-navy focus:outline-none">Objet de réseau</h3>
        <EtatErreur erreur={classerErreurReseau(p.requete.error)} sujet="Objet de réseau" onReessayer={() => void p.requete.refetch()} enCours={p.requete.isFetching} />
      </div>
    );
  }

  const o = f.objet;
  const s = o.source;
  const q = o.qualite;
  const v = o.vertical;
  const qualifiable = !!s && !!s.role && ROLES_JEU_QUALIFIABLES.includes(s.role) && !!s.statut && STATUTS_JEU_QUALIFIABLES.includes(s.statut);
  const peutQualifier = p.peutEcrire && qualifiable;
  const peutRelier = peutQualifier && sensPossibles(o).length > 0;
  const nonQualifiable = p.peutEcrire && !qualifiable;
  const relations = f.relations;
  const propositions = relations.filter((r) => r.statut === "PROPOSEE").length;

  return (
    <article aria-labelledby="pv-titre-fiche-objet-reseau" data-testid="fiche-objet-reseau" data-objet-reseau-id={o.id} className="space-y-3 rounded-md border border-navy/30 bg-white p-3 shadow-sm">
      {retour}
      <header className="space-y-1.5">
        <h3 id="pv-titre-fiche-objet-reseau" ref={refTitre} tabIndex={-1} className="break-words text-sm font-semibold text-navy focus:outline-none">{o.nom ?? "Objet sans nom"}</h3>
        <p className="flex flex-wrap items-center gap-1">
          <BadgeNature nature={o.nature} origine={o.origineNature} />
          <span className="rounded border border-gray-400 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-gray-900">{libelleTypeObjet(o.typeObjet)}</span>
          <BadgeClasse classe={q.classePrecision} />
        </p>
        <p className="text-xs text-gray-800">{AIDE_NATURE_COURTE[o.nature]}</p>
        {o.nature === "CIRCUIT_LOGIQUE" && <p role="note" className="text-xs text-gray-800">{MENTION_LIGNES_CABLES}</p>}
        {f.connexions && (
          <p data-testid="etat-connexion" data-etat={f.connexions.etat} className="text-xs text-gray-900">
            <strong>{LIBELLE_ETAT_CONNEXION[f.connexions.etat]}</strong>
            {f.connexions.etat !== "NON_FOURNIE" && ` (${f.connexions.nbConfirmees ?? 0} confirmée(s) par le fournisseur, ${f.connexions.nbInconnues ?? 0} de preuve inconnue)`}. {MENTION_CONNEXION}
          </p>
        )}
      </header>

      <div className="flex flex-wrap gap-2">
        {peutQualifier && (
          <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} onClick={() => ouvrir({ genre: "descripteur" })}>
            <PenLine aria-hidden="true" /> {o.descripteur ? "Modifier le descripteur" : "Qualifier l'objet"}
          </Button>
        )}
        {peutRelier && (
          <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} onClick={() => ouvrir({ genre: "nouvelle-relation" })}>
            <Link2 aria-hidden="true" /> Déclarer une relation
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" onClick={() => setLocalisation(p.localiser(o))}>
          <MapPin aria-hidden="true" /> Mettre en évidence sur la carte
        </Button>
        {p.enEvidence && (
          <Button type="button" variant="ghost" size="sm" className="min-h-[44px] xl:min-h-8" onClick={() => { p.onRetirerEvidence(); setLocalisation(null); }}>
            <MapPinOff aria-hidden="true" /> Retirer la mise en évidence
          </Button>
        )}
      </div>
      {localisation && <p role="status" data-testid="etat-localisation" data-resultat={localisation} className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-900">{MESSAGE_LOCALISATION[localisation]}</p>}
      {nonQualifiable && (
        <p role="note" data-testid="objet-non-qualifiable" className="text-xs text-gray-800">
          Cet objet ne peut plus être qualifié ni relié : son jeu est {s?.statut ? LIBELLE_STATUT_JEU_COURT[s.statut] ?? s.statut.toLowerCase() : "d'un état inconnu"}{s?.role && !ROLES_JEU_QUALIFIABLES.includes(s.role) ? ` (rôle ${LIBELLE_ROLE[s.role as RoleJeu] ?? s.role})` : ""}. Seuls les objets d&apos;un jeu de réseau en contrôle ou autorisé se qualifient.
        </p>
      )}

      <Section id="pv-for-source" titre="Source (celle du jeu)">
        {s ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            <Ligne libelle="Fichier">{s.nomFichier ?? "non fourni"}{s.version !== null ? `, version ${s.version}` : ""}</Ligne>
            <Ligne libelle="Statut du jeu">{s.statut ? LIBELLE_STATUT_JEU_COURT[s.statut] ?? s.statut : "non fourni"}</Ligne>
            <Ligne libelle="Concessionnaire">{s.concessionnaire?.nom ?? "non renseigné"}</Ligne>
            <Ligne libelle="Données du">{s.dateDonnees ? formaterDate(s.dateDonnees) : "non renseignée"}</Ligne>
            <Ligne libelle="Confidentialité">{s.confidentialite ? LIBELLE_CONFIDENTIALITE[s.confidentialite as Confidentialite] ?? s.confidentialite : "non renseignée"}</Ligne>
            {o.longueurM !== null && <Ligne libelle="Longueur">{formaterMetres(o.longueurM)}</Ligne>}
          </dl>
        ) : <p className="text-xs text-gray-700">Source masquée ou non fournie par le serveur.</p>}
      </Section>

      <Section id="pv-for-qualite" titre="Qualité (déclarée, jamais déduite)">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <Ligne libelle="Classe de précision">{q.classePrecision ? `${AIDE_CLASSE[q.classePrecision]} (${LIBELLE_ORIGINE_VALEUR[q.origineClasse]})` : "non renseignée : aucune classe n'est déduite"}</Ligne>
          <Ligne libelle="Précision horizontale">{texteMetres(q.precisionHorizontaleM)}</Ligne>
          <Ligne libelle="Précision verticale">{texteMetres(q.precisionVerticaleM)}</Ligne>
          <Ligne libelle="Méthode de collecte">{q.methodeCollecte ?? "non renseignée"}</Ligne>
          <Ligne libelle="Date du constat">{q.dateConstat ? formaterDate(q.dateConstat) : "non renseignée"}</Ligne>
          <Ligne libelle="Niveau de confiance">{q.niveauConfiance ? LIBELLE_CONFIANCE[q.niveauConfiance] : "non renseigné"}</Ligne>
          <Ligne libelle="Statut de la qualité">{q.statutQualite ? LIBELLE_STATUT_QUALITE[q.statutQualite] : "non fourni"}</Ligne>
        </dl>
      </Section>

      <Section id="pv-for-vertical" titre="Vertical">
        <p data-testid="etat-vertical" className="text-xs font-medium text-gray-900">{v.etat ? LIBELLE_ETAT_VERTICAL[v.etat] : "Le serveur ne précise pas l'état vertical de cet objet : aucune conclusion 3D."}</p>
        {(v.profondeurM !== null || v.altitudeM !== null) && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            {v.profondeurM !== null && <Ligne libelle="Profondeur fournie">{texteMetres(v.profondeurM)} (positive vers le bas)</Ligne>}
            {v.altitudeM !== null && <Ligne libelle="Altitude fournie">{texteMetres(v.altitudeM)}</Ligne>}
            <Ligne libelle="Référence verticale">{v.referenceVerticale ?? "non précisée"}</Ligne>
          </dl>
        )}
        <p className="text-[11px] text-gray-700">{MENTION_3D}</p>
      </Section>

      {f.tracePartagee && (
        <Section id="pv-for-trace" titre="Circuits superposés">
          <p data-testid="trace-partagee" className="text-xs text-gray-900">
            {f.tracePartagee.nbAutresObjets === null ? "Le serveur ne précise pas combien d'autres objets suivent exactement la même trace."
              : f.tracePartagee.nbAutresObjets === 0 ? "Aucun autre objet du même jeu ne suit exactement la même trace."
              : `${f.tracePartagee.nbAutresObjets} autre(s) objet(s) du même jeu suivent exactement la même trace : ils restent séparés, ce ne sont pas des câbles distincts.`}
          </p>
        </Section>
      )}

      <Section id="pv-for-descripteur" titre="Descripteur">
        {o.descripteur ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            <Ligne libelle="Justification">{o.descripteur.justification ?? "non fournie"}</Ligne>
            <Ligne libelle="Déclaré par">{o.descripteur.declarePar ?? "compte inconnu"}{o.descripteur.declareLe ? `, ${formaterDateHeure(o.descripteur.declareLe)}` : ""}</Ligne>
            {o.descripteur.modifiePar && <Ligne libelle="Dernière modification">{o.descripteur.modifiePar}{o.descripteur.modifieLe ? `, ${formaterDateHeure(o.descripteur.modifieLe)}` : ""}</Ligne>}
          </dl>
        ) : <p className="text-xs text-gray-700">Aucun descripteur : nature, classe et précision sont celles du jeu, ou inconnues. Rien n&apos;est inventé.</p>}
      </Section>

      <Section id="pv-for-relations" titre={`Relations (${relations.length})`}>
        {propositions > 0 && <p role="note" className="text-xs text-amber-900">{propositions} proposition(s) automatique(s) à valider : tant qu&apos;une personne ne les a pas validées, elles n&apos;ont aucun effet.</p>}
        {f.ignoresRelations > 0 && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{f.ignoresRelations} relation(s) de la réponse n&apos;ont pas pu être lues (statut ou type inconnu de cette version) et ne sont pas affichées.</p>}
        {relations.length === 0 ? <p className="text-xs text-gray-700">Aucune relation connue pour cet objet : son support ou son contenant est inconnu, jamais supposé.</p> : (
          <ul className="space-y-1.5">
            {relations.map((r) => (
              <ElementRelation key={r.id} relation={r} objetOuvertId={o.id} enLigne={p.enLigne} onOuvrirObjet={p.onOuvrirObjet} onAction={(rel, action) => ouvrir({ genre: "relation-action", relation: rel, action })} />
            ))}
          </ul>
        )}
      </Section>

      {dialogue?.genre === "descripteur" && <DialogueDescripteur objet={o} enLigne={p.enLigne} onFermer={fermer} onValider={p.actions.declarerDescripteur} />}
      {dialogue?.genre === "relation-action" && (
        <DialogueRelationAction relation={dialogue.relation} action={dialogue.action} enLigne={p.enLigne} onFermer={fermer} onValider={(j) => p.actions.transition(dialogue.relation.id, dialogue.action, j)} />
      )}
      {dialogue?.genre === "nouvelle-relation" && <DialogueNouvelleRelation projetId={p.projetId} objet={o} enLigne={p.enLigne} onFermer={fermer} onValider={p.actions.declarerRelation} />}
    </article>
  );
});
