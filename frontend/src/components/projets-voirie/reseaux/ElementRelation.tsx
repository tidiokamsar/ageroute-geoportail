import { Button } from "../../ui/Button";
import { BadgeNature, BadgeOrigineRelation, BadgeStatutRelation } from "./BadgesReseau";
import type { ExtremiteRelation, RelationReseau } from "../../../lib/projetsVoirieReseauxApi";
import {
  LIBELLE_ACTION_RELATION, LIBELLE_PREUVE, LIBELLE_TYPE_RELATION, STYLE_STATUT_RELATION, libelleTypeObjet, texteMetres, type ActionRelation, type TypeRelation,
} from "../../../lib/projetsVoirieReseaux";
import { formaterDateHeure } from "../../../lib/projetsVoirieConflits";
import { formaterPourcent } from "../../../lib/projetsVoirie";

/**
 * Une relation entre deux objets de reseau. Les boutons d'action sont ceux que le SERVEUR offre a ce compte (`actionsPossibles`) : un lecteur n'en a
 * aucun. Une proposition automatique est presentee comme PROPOSEE, avec ce que l'association automatique a calcule ; elle n'a aucun effet tant
 * qu'une personne ne l'a pas validee.
 */

function Extremite({ e, libelle, ouvert, onOuvrir }: { e: ExtremiteRelation | null; libelle: string; ouvert: boolean; onOuvrir?: (objetId: string) => void }) {
  if (!e) return <p className="text-gray-700">{libelle} : objet masqué ou non fourni.</p>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-gray-700">{libelle} :</span>
      {e.nature && <BadgeNature nature={e.nature} />}
      <span className="break-words font-medium">{e.nom ?? "objet sans nom"}</span>
      {e.typeObjet && <span className="text-gray-700">({libelleTypeObjet(e.typeObjet)})</span>}
      {ouvert ? <span className="text-gray-700">(objet ouvert)</span> : onOuvrir && (
        <Button type="button" variant="ghost" size="sm" className="min-h-[44px] underline xl:min-h-8" aria-label={`Ouvrir l'objet ${e.nom ?? "sans nom"}`} onClick={() => onOuvrir(e.objetId)}>Ouvrir</Button>
      )}
    </div>
  );
}

const LIBELLE_SOURCE: Record<TypeRelation, string> = { PORTE_PAR: "Circuit", CONTENU_DANS: "Équipement", CONNECTE_A: "Objet" };
const LIBELLE_CIBLE: Record<TypeRelation, string> = { PORTE_PAR: "Porté par", CONTENU_DANS: "Contenu dans", CONNECTE_A: "Connecté à" };

export function ElementRelation({ relation: r, objetOuvertId, onAction, onOuvrirObjet, enLigne }: {
  relation: RelationReseau; objetOuvertId?: string; onAction: (r: RelationReseau, a: ActionRelation) => void; onOuvrirObjet?: (objetId: string) => void; enLigne: boolean;
}) {
  const p = r.proposition;
  return (
    <li data-relation-id={r.id} className="space-y-1.5 rounded border border-gray-300 bg-white p-2 text-xs text-gray-900">
      <p className="flex flex-wrap items-center gap-1">
        <BadgeStatutRelation statut={r.statut} />
        <BadgeOrigineRelation origine={r.origine} />
        <strong>{LIBELLE_TYPE_RELATION[r.typeRelation]}</strong>
      </p>
      <p className="text-[11px] text-gray-700">{STYLE_STATUT_RELATION[r.statut].aide}</p>
      <Extremite e={r.source} libelle={LIBELLE_SOURCE[r.typeRelation]} ouvert={!!objetOuvertId && r.source?.objetId === objetOuvertId} onOuvrir={onOuvrirObjet} />
      <Extremite e={r.cible} libelle={LIBELLE_CIBLE[r.typeRelation]} ouvert={!!objetOuvertId && r.cible?.objetId === objetOuvertId} onOuvrir={onOuvrirObjet} />
      {r.typeRelation === "CONNECTE_A" && (
        <p data-testid="preuve-connexion" className="text-gray-900"><strong>Preuve :</strong> {r.preuve ? LIBELLE_PREUVE[r.preuve] : "non fournie par le serveur"}. Connexion déclarée, jamais déduite d&apos;une proximité.</p>
      )}
      {p && (
        <div data-testid="detail-proposition" className="rounded border border-amber-300 bg-amber-50 p-1.5 text-amber-900">
          <p><strong>Calcul de la proposition automatique</strong> (superposition géométrique{p.methode ? `, méthode ${p.methode}` : ""}{p.version ? ` ${p.version}` : ""})</p>
          <p>
            {p.couverture !== null ? `Couverture : ${formaterPourcent(p.couverture)}` : "Couverture non fournie"}
            {p.couvertureMin !== null ? ` (seuil ${formaterPourcent(p.couvertureMin)})` : ""}
            {" · "}Tolérance : {texteMetres(p.toleranceM, "non fournie")}
            {p.longueurDansToleranceM !== null && p.longueurCircuitM !== null ? ` · ${texteMetres(p.longueurDansToleranceM)} sur ${texteMetres(p.longueurCircuitM)} du circuit dans la tolérance` : ""}
          </p>
          {p.provisoire && <p>Tolérances et seuil provisoires, en attente de validation par la DSI. Une superposition ne prouve pas que le circuit est porté par l&apos;infrastructure.</p>}
        </div>
      )}
      {r.decision && (
        <p className="break-words text-[11px] text-gray-800">
          Dernier acte : {r.decision.par ?? "personne non nommée"}{r.decision.le ? `, ${formaterDateHeure(r.decision.le)}` : ""}
          {r.decision.justification ? `. Justification : ${r.decision.justification}` : ""}
        </p>
      )}
      <p className="text-[11px] text-gray-700">{r.creePar ? `Créée par ${r.creePar}` : "Créée par le système"}{r.createdAt ? `, ${formaterDateHeure(r.createdAt)}` : ""}.</p>
      {r.actionsPossibles.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {r.actionsPossibles.map((a) => (
            <Button key={a} type="button" size="sm" variant={a === "valider" ? "primary" : "outline"} className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => onAction(r, a)}
              aria-label={`${LIBELLE_ACTION_RELATION[a]} : ${r.source?.nom ?? "objet"} et ${r.cible?.nom ?? "objet"}`}>
              {LIBELLE_ACTION_RELATION[a]}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
