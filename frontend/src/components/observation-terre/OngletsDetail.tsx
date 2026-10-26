import { Loader2 } from "lucide-react";
import type { PropositionDetail } from "../../lib/teledetectionApi";
import { useApercu } from "../../lib/teledetectionHooks";
import { formaterDate, formaterDateHeure, libelleStatut, libelleType, messageObservationsMasquees } from "../../lib/teledetectionAffichage";
import { EtatVide } from "./EtatsPanneau";
import { ComparaisonAvantApres } from "./ComparaisonAvantApres";

/**
 * Contenus des onglets du detail : Apercu, Comparaison, Terrain, Historique.
 * Une image absente est dite absente : jamais d'image de remplacement (contrat, principe 7).
 */

export function OngletApercu({ detail }: { detail: PropositionDetail }) {
  const apres = useApercu(detail.apercus?.apres?.url ?? null);
  const date = detail.apercus?.apres?.date ?? detail.dateObservation;
  if (apres.etat === "chargement") return <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-600"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Chargement de l&apos;aperçu…</p>;
  // 404 APERCU_INDISPONIBLE : l'URL existe mais le fournisseur n'a rien rendu. Ce n'est pas une panne de l'application : on le dit tel quel.
  if (apres.etat === "indisponible") {
    return <EtatVide titre="Aperçu indisponible chez le fournisseur" detail="Le fournisseur n'a pas rendu d'image pour cette proposition. Aucune image de remplacement n'est affichée ; la décision peut se fonder sur les autres éléments du dossier." />;
  }
  if (apres.etat === "erreur") return <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">L&apos;aperçu n&apos;a pas pu être chargé. Réessayez en rouvrant la proposition.</p>;
  if (apres.etat === "aucun" || !apres.src) {
    return <EtatVide titre="Aucun aperçu disponible" detail="Le serveur n'a pas d'image pour cette proposition. Aucune image de remplacement n'est affichée." />;
  }
  return (
    <figure>
      <img src={apres.src} alt={`Vue satellite après le changement (${libelleType(detail.type).toLowerCase()}), acquise le ${formaterDate(date)}`} className="max-h-72 w-full rounded-md border object-contain bg-gray-100" />
      <figcaption className="mt-1 text-xs text-gray-600">Image du {formaterDate(date)} · {detail.source.nom}. Le changement est détecté sur l&apos;image ; seul le terrain le confirme.</figcaption>
    </figure>
  );
}

export function OngletComparaison({ detail }: { detail: PropositionDetail }) {
  const avant = useApercu(detail.apercus?.avant?.url ?? null);
  const apres = useApercu(detail.apercus?.apres?.url ?? null);
  if (avant.etat === "chargement" || apres.etat === "chargement") {
    return <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-600"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Chargement des images…</p>;
  }
  // Une image qui manque ne masque pas l'autre : le cote en panne est dit en panne, l'image disponible reste affichee
  // (le curseur est alors desactive par la comparaison elle-meme).
  const panne = (e: typeof avant.etat): "indisponible" | "echec" | undefined => (e === "indisponible" ? "indisponible" : e === "erreur" ? "echec" : undefined);
  return (
    <ComparaisonAvantApres
      avant={{ url: avant.src, date: detail.apercus?.avant?.date ?? detail.dateReference, panne: panne(avant.etat) }}
      apres={{ url: apres.src, date: detail.apercus?.apres?.date ?? detail.dateObservation, panne: panne(apres.etat) }}
      libelleZone={libelleType(detail.type)}
    />
  );
}

export function OngletTerrain({ detail }: { detail: PropositionDetail }) {
  const obs = detail.terrain?.observations ?? [];
  const masquees = messageObservationsMasquees(detail.terrain?.observationsMasquees);
  return (
    <div className="space-y-2 text-sm">
      {detail.mission ? (
        <p className="rounded border border-gray-200 bg-gray-50 p-2">
          Mission de vérification <strong>{detail.mission.id}</strong> : {detail.mission.statut}
          {detail.mission.assigneNom ? `, affectée à ${detail.mission.assigneNom}` : ", non assignée"}.
        </p>
      ) : (
        <p className="text-gray-600">Aucune mission de vérification n&apos;est liée à cette proposition.</p>
      )}
      {obs.length === 0 ? (
        masquees ? (
          <EtatVide titre="Aucune observation visible dans votre périmètre" detail="D'autres observations existent dans ce dossier : elles sont hors de votre périmètre." />
        ) : (
          <EtatVide titre="Aucune observation de terrain liée" detail="Un verdict cite un constat : une observation liée, ou la référence d'un constat saisie au moment de la décision." />
        )
      ) : (
        <ul className="space-y-1" aria-label="Observations de terrain liées">
          {obs.map((o) => (
            <li key={o.id} className="rounded border border-gray-200 p-2">
              <p className="text-xs text-gray-600">{formaterDate(o.date)}{o.auteur ? ` · ${o.auteur}` : ""}</p>
              <p>{o.resume || "Observation sans résumé."}</p>
            </li>
          ))}
        </ul>
      )}
      {masquees && <p role="note" data-testid="observations-masquees" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs font-medium text-amber-900">{masquees}.</p>}
    </div>
  );
}

export function OngletHistorique({ detail }: { detail: PropositionDetail }) {
  const h = detail.historique ?? [];
  if (h.length === 0) return <EtatVide titre="Aucune décision enregistrée" detail="L'historique se remplit à chaque changement de statut, avec son auteur et son motif." />;
  return (
    <ol className="space-y-2 text-sm" aria-label="Historique des décisions">
      {h.map((t, i) => (
        <li key={`${t.date}-${i}`} className="rounded border border-gray-200 p-2">
          <p className="text-xs text-gray-600">{formaterDateHeure(t.date)} · {t.auteur?.nom ?? "Auteur inconnu"}</p>
          <p className="font-medium">{t.de ? libelleStatut(t.de) : "Création"} vers {libelleStatut(t.vers)}</p>
          {t.motif && <p>Motif : {t.motif}</p>}
          {t.commentaire && <p className="text-gray-700">Commentaire : {t.commentaire}</p>}
        </li>
      ))}
    </ol>
  );
}
