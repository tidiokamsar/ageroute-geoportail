import { useId, type ReactNode } from "react";
import { Download, X } from "lucide-react";
import { Button } from "../ui/Button";
import { ApercuEchantillon, type ParamsApercu } from "./ApercuEchantillon";
import { formaterDate, formatTaille, rendreVisible } from "./CompteursLot";
import { HistoriqueLot } from "./HistoriqueLot";
import { RapportControle } from "./RapportControle";
import { ResumeEmpreinte } from "./ResumeEmpreinte";
import type { ActionPermise, CodeAction, Etape, EtatEtape, LotDetail, ReponseApercu } from "./types";

/**
 * Panneau de détail d'un lot : ce que le serveur sait de lui, dans un ordre qui répond aux questions
 * dans l'ordre où on se les pose (quel lot, quel fichier, quelle empreinte, quel contrôle, qu'y a-t-il
 * dedans, qu'est-il arrivé, et que peut-on faire).
 *
 * CE QUE LE PANNEAU NE FAIT PAS : aucune approbation, aucun import, aucun bouton qui les promette. Le
 * contrat n'expose que deux actions (TELECHARGER_ERREURS, VOIR_APERCU), et c'est le SERVEUR qui dit si
 * elles sont permises : un bouton inactif montre la raison donnée, il n'en invente pas une.
 *
 * ÉTATS : squelette (chargement), erreur (distincte du vide, avec « Réessayer »), vide (aucun lot choisi).
 * Un changement de lot est annoncé dans une région `aria-live` toujours montée.
 */

export interface PanneauDetailLotProps {
  detail: LotDetail | undefined;
  chargement?: boolean;
  /** Toute valeur vraie = échec du chargement. Une chaîne est affichée telle quelle (message du serveur). */
  erreur?: unknown;
  onFermer: () => void;
  /** Relance le chargement du détail. Sans lui, l'état d'erreur n'a pas de bouton « Réessayer ». */
  onReessayer?: () => void;
  onTelechargerErreurs: () => void;
  telechargementEnCours?: boolean;
  /** Badge de statut fourni par l'intégrateur. */
  renderStatut: (lot: LotDetail) => ReactNode;
  /** Indicateur d'étapes fourni par l'intégrateur. Sans lui, les raisons du serveur sont listées en texte. */
  renderEtapes?: (etapes: Etape[], detail: LotDetail) => ReactNode;
  chargerApercu: (params: ParamsApercu) => Promise<ReponseApercu>;
}

const CIBLE = "min-h-[44px]";

const LIBELLE_ETAT_ETAPE: Record<EtatEtape, string> = {
  TERMINEE: "Terminée",
  TERMINEE_AVEC_RESERVES: "Terminée avec réserves",
  ECHEC: "En échec",
  EN_COURS: "En cours",
  NON_DISPONIBLE: "Non disponible",
  NON_COMMENCEE: "Non commencée",
};

const LIBELLE_FORMAT: Record<string, string> = { csv: "CSV", geojson: "GeoJSON" };

function action(actions: ActionPermise[], code: CodeAction): ActionPermise | undefined {
  return actions.find((a) => a.code === code);
}

function messageErreur(erreur: unknown): string {
  return typeof erreur === "string" && erreur.trim() !== ""
    ? erreur
    : "Le détail du lot n'a pas pu être chargé. Aucune donnée n'a été modifiée.";
}

function Metadonnee({ libelle, children }: { libelle: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-slate-700">{libelle}</dt>
      <dd className="min-w-0 break-words text-slate-900">{children}</dd>
    </>
  );
}

function Texte({ valeur, absent = "Non renseigné" }: { valeur: string | null | undefined; absent?: string }) {
  return valeur && valeur.trim() !== "" ? <>{rendreVisible(valeur)}</> : <span className="italic text-slate-700">{absent}</span>;
}

export function PanneauDetailLot({
  detail, chargement = false, erreur, onFermer, onReessayer, onTelechargerErreurs, telechargementEnCours = false,
  renderStatut, renderEtapes, chargerApercu,
}: PanneauDetailLotProps) {
  const id = useId();
  const idTitre = `${id}-titre`;
  const enErreur = Boolean(erreur);

  // Un seul message d'annonce, calculé : il ne change que quand le lot, le chargement ou l'erreur changent.
  const annonce = enErreur
    ? "Le détail du lot n'a pas pu être chargé."
    : detail
      ? `Détail du lot ${rendreVisible(detail.reference)} affiché.`
      : chargement
        ? "Chargement du détail du lot."
        : "Aucun lot sélectionné.";

  let contenu: ReactNode;
  let titre = "Détail du lot";

  if (enErreur) {
    contenu = (
      <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
        <p className="font-medium">Le détail du lot n'a pas pu être chargé.</p>
        <p className="mt-1">{messageErreur(erreur)}</p>
        <p className="mt-1">Vous pouvez réessayer, ou choisir un autre lot dans la liste.</p>
        {onReessayer && (
          <Button type="button" variant="outline" className={`mt-2 ${CIBLE}`} onClick={onReessayer}>Réessayer</Button>
        )}
      </div>
    );
  } else if (detail) {
    titre = rendreVisible(detail.reference);
    contenu = <ContenuDetail
      detail={detail} idBase={id} onTelechargerErreurs={onTelechargerErreurs} telechargementEnCours={telechargementEnCours}
      renderStatut={renderStatut} renderEtapes={renderEtapes} chargerApercu={chargerApercu}
    />;
  } else if (chargement) {
    contenu = (
      <div aria-hidden="true" className="space-y-3">
        <div className="h-6 w-2/3 animate-pulse rounded bg-slate-200" />
        <div className="h-4 w-full animate-pulse rounded bg-slate-200" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-slate-200" />
        <div className="h-24 w-full animate-pulse rounded bg-slate-200" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-slate-200" />
      </div>
    );
  } else {
    contenu = <p className="text-sm text-slate-700">Sélectionnez un lot pour voir ses contrôles.</p>;
  }

  const afficherFermer = enErreur || Boolean(detail) || chargement;

  return (
    <div
      role="region"
      aria-labelledby={idTitre}
      aria-busy={chargement}
      className="min-w-0 space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{annonce}</div>

      <div className="flex items-start justify-between gap-3">
        <h2 id={idTitre} className={`min-w-0 break-all text-base font-semibold text-slate-900 ${detail && !enErreur ? "font-mono" : ""}`}>{titre}</h2>
        {afficherFermer && (
          <Button type="button" variant="outline" size="sm" className={`shrink-0 ${CIBLE}`} onClick={onFermer}>
            <X aria-hidden="true" /> Fermer le détail
          </Button>
        )}
      </div>

      {contenu}
    </div>
  );
}

function ContenuDetail({
  detail, idBase, onTelechargerErreurs, telechargementEnCours, renderStatut, renderEtapes, chargerApercu,
}: {
  detail: LotDetail; idBase: string; onTelechargerErreurs: () => void; telechargementEnCours: boolean;
  renderStatut: (lot: LotDetail) => ReactNode; renderEtapes?: (etapes: Etape[], detail: LotDetail) => ReactNode;
  chargerApercu: (params: ParamsApercu) => Promise<ReponseApercu>;
}) {
  const taille = formatTaille(detail.tailleOctets);
  const telecharger = action(detail.actionsPermises, "TELECHARGER_ERREURS");
  const apercu = action(detail.actionsPermises, "VOIR_APERCU");

  const telechargementPermis = telecharger?.permise === true;
  const raisonTelechargement = telechargementPermis
    ? null
    : telecharger?.raison?.trim() || "Le serveur ne propose pas ce téléchargement pour ce lot.";
  const idRaison = `${idBase}-raison-telechargement`;
  const bloque = !telechargementPermis || telechargementEnCours;

  const etapesNonDisponibles = detail.etapes.filter((e) => e.etat === "NON_DISPONIBLE");

  return (
    <>
      <div className="space-y-2">
        <div>{renderStatut(detail)}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <Metadonnee libelle="Source">{rendreVisible(detail.systemeSource)}</Metadonnee>
          <Metadonnee libelle="Format">{LIBELLE_FORMAT[detail.format] ?? rendreVisible(detail.format)}</Metadonnee>
          <Metadonnee libelle="Fichier"><span className="break-all">{rendreVisible(detail.nomFichier)}</span></Metadonnee>
          <Metadonnee libelle="Taille">
            {taille ? <span title={taille.exact}>{taille.lisible}</span> : <span className="italic text-slate-700">Taille inconnue</span>}
          </Metadonnee>
          <Metadonnee libelle="Importé par">
            {detail.importePar?.nomComplet ? rendreVisible(detail.importePar.nomComplet) : <span className="italic text-slate-700">Non renseigné</span>}
            {" le "}<time dateTime={detail.importeLe}>{formaterDate(detail.importeLe)}</time>
          </Metadonnee>
        </dl>
      </div>

      <ResumeEmpreinte empreinte={detail.empreinte} idTitre={`${idBase}-empreinte`} />

      <div>
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Métadonnées de la source</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <Metadonnee libelle="Méthode"><Texte valeur={detail.methodeSource} /></Metadonnee>
          <Metadonnee libelle="Version du mapping"><Texte valeur={detail.versionMapping} /></Metadonnee>
          <Metadonnee libelle="Autorisation écrite"><Texte valeur={detail.autorisationRef} /></Metadonnee>
          {detail.auteurSource && <Metadonnee libelle="Auteur de la source">{rendreVisible(detail.auteurSource)}</Metadonnee>}
          {detail.dateSource && <Metadonnee libelle="Date de la source"><time dateTime={detail.dateSource}>{formaterDate(detail.dateSource, false)}</time></Metadonnee>}
        </dl>
      </div>

      <RapportControle controle={detail.controle} statut={detail.statut} idTitre={`${idBase}-controle`} />

      <div>
        <Button
          type="button"
          variant="outline"
          className={`${CIBLE} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
          // aria-disabled et non disabled : le bouton reste atteignable au clavier, donc sa raison aussi.
          aria-disabled={bloque}
          aria-describedby={raisonTelechargement ? idRaison : undefined}
          aria-busy={telechargementEnCours}
          onClick={() => { if (!bloque) onTelechargerErreurs(); }}
        >
          <Download aria-hidden="true" />
          {telechargementEnCours ? "Téléchargement en cours…" : "Télécharger le rapport des erreurs"}
        </Button>
        {raisonTelechargement && (
          <p id={idRaison} className="mt-1 text-sm text-slate-700">{rendreVisible(raisonTelechargement)}</p>
        )}
      </div>

      <ApercuEchantillon
        key={detail.id}
        lotId={detail.id}
        chargerApercu={chargerApercu}
        action={apercu ?? { permise: false, raison: "Le serveur ne propose pas l'aperçu pour ce lot." }}
      />

      <HistoriqueLot historique={detail.historique} idTitre={`${idBase}-historique`} />

      <div className="rounded border border-slate-300 bg-slate-50 p-3">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">État des validations</h3>
        <p className="text-sm text-slate-800">
          Aucune action d'approbation de l'échantillon ni d'écriture au référentiel n'est proposée sur cet écran.
        </p>
        {renderEtapes ? (
          <div className="mt-2">{renderEtapes(detail.etapes, detail)}</div>
        ) : (
          etapesNonDisponibles.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-slate-800">
              {etapesNonDisponibles.map((e) => (
                <li key={e.id}>
                  <strong>{rendreVisible(e.titre)}</strong> ({LIBELLE_ETAT_ETAPE[e.etat]}) : {rendreVisible(e.raison)}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </>
  );
}
