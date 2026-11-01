import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  getAllPendingDefauts, getAllPendingObservations, getAllPendingPortions, STATUT_REFUS_DROITS,
  type CauseRefusDroits, type PendingDefaut, type PendingObservation, type PendingPortion, type SansPhotos,
} from "../../lib/offlineDb";
import {
  etatSynchronisation, MESSAGES_REFUS_DROITS, relancerRefusDroits, type FileRelancable, type IssueRelanceDroits,
} from "../../lib/offlineSync";
import { LIBELLES_TYPE } from "../../lib/observationsTerrain";
import { useOfflineSync } from "../../hooks/useOfflineSync";
import { AlerteStockageLocal, messageStockageLocal } from "../AlerteStockageLocal";
import { Button } from "../ui/Button";

/**
 * Les saisies refusees par le serveur parce que les DROITS du compte ont change (statut `refus_droits`, quarantaine) : liste, cause en
 * mots clairs, et un seul geste, « Renvoyer ». Contrat serveur : docs/securite/SESSION-HORS-LIGNE-SERVEUR.md 2.3 ; client :
 * `relancerRefusDroits` (lib/offlineSync.ts).
 *
 * CE QUE LE PANNEAU GARANTIT
 *   - AUCUNE suppression d'une saisie en quarantaine n'est proposee : elle n'existe nulle part ailleurs que sur ce telephone, et l'agent
 *     n'a pas a decider de la perdre parce qu'un droit lui a ete retire. Le seul geste est de la renvoyer.
 *   - « Renvoyer » envoie UNE saisie (jamais la file entiere). Le serveur la rejuge sur les droits d'aujourd'hui : acceptee si les droits
 *     sont rendus, refusee de nouveau sinon (elle reste ici, rien n'est perdu). Chaque issue est traduite en une phrase.
 *   - les erreurs typees du stockage local (coffre verrouille, aucun compte...) sont dites par `AlerteStockageLocal`.
 *
 * REUTILISABLE : le panneau couvre par defaut les TROIS files qui passent par `/v2/sync/push` (defauts, portions, observations).
 * `files` en restreint la liste. Il se monte dans n'importe quelle page de saisie ; `compteId` est le compte courant (les saisies d'un
 * autre compte ne sont jamais montrees).
 *
 * Il recharge la liste quand les compteurs du magasin de synchronisation changent et apres chaque renvoi. Le compte rendu des renvois
 * reste affiche meme si la derniere saisie vient de partir : monter le panneau de facon qu'il ne disparaisse pas des que la quarantaine
 * se vide (voir ObservationsTerrainPage).
 */

const TOUTES_LES_FILES: readonly FileRelancable[] = ["defauts", "portions", "observations"];

interface LigneRefus {
  readonly cle: string;
  readonly file: FileRelancable;
  readonly localId: string;
  readonly titre: string;
  /** Date du CONSTAT (pas de l'envoi), ISO 8601. */
  readonly date: string;
  readonly nbPhotos: number;
  readonly cause: CauseRefusDroits;
}

interface Retour {
  readonly cle: string;
  readonly titre: string;
  readonly message: string;
  readonly ok: boolean;
}

const LIBELLES_FILE: Record<FileRelancable, string> = { defauts: "Défaut", portions: "Portion", observations: "Observation" };

function heure(iso: string | null | undefined): string {
  if (!iso) return "date inconnue";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

const accorde = (n: number, singulier: string, pluriel: string) => `${n} ${n >= 2 ? pluriel : singulier}`;

/** Une phrase par issue d'un renvoi. Exportee : les textes sont figes par le test. */
export function messageIssueRelance(issue: IssueRelanceDroits): { message: string; ok: boolean } {
  switch (issue) {
    case "ENVOYEE":
      return { ok: true, message: "Envoyée : le serveur a accepté cette saisie. Elle a quitté la liste de ce téléphone." };
    case "TOUJOURS_REFUSEE":
      return { ok: false, message: "Le serveur refuse toujours cette saisie : vos droits ne sont pas encore rétablis. Elle reste en quarantaine sur ce téléphone, rien n'est perdu." };
    case "EN_FILE":
      return { ok: false, message: "Cette saisie n'est plus refusée pour droits, mais l'envoi n'a pas abouti (réseau ou erreur passagère). Elle repartira avec la synchronisation normale." };
    case "ARRET":
      return { ok: false, message: `${etatSynchronisation().message ?? "L'envoi est arrêté."} Rien n'a été envoyé ; la saisie reste en quarantaine.` };
    case "HORS_LIGNE":
      return { ok: false, message: "Pas de réseau : rien n'a été envoyé. La saisie reste en quarantaine ; réessayez quand le réseau est revenu." };
    case "SYNCHRONISATION_EN_COURS":
      return { ok: false, message: "Une synchronisation est déjà en cours : rien n'a été changé. Réessayez dans un instant." };
    case "NON_EN_QUARANTAINE":
      return { ok: false, message: "Cette saisie n'est plus en quarantaine (déjà traitée ou introuvable). La liste a été actualisée." };
  }
}

type DefautLu = PendingDefaut | SansPhotos<PendingDefaut>;
type PortionLue = PendingPortion | SansPhotos<PendingPortion>;
type ObservationLue = PendingObservation | SansPhotos<PendingObservation>;

/** Photos d'une saisie lue avec ou sans leurs octets : `nbPhotos` quand les octets n'ont pas ete dechiffres. */
function photosDe(s: { photos?: readonly unknown[]; nbPhotos?: number }): number {
  return s.nbPhotos ?? s.photos?.length ?? 0;
}

const causeDe = (c: CauseRefusDroits | undefined): CauseRefusDroits => c ?? "NON_PRECISEE";

export function PanneauRefusDroits({ compteId, files = TOUTES_LES_FILES }: { compteId: string | undefined; files?: readonly FileRelancable[] }) {
  const { pendingCount, refusDroitsCount, syncing } = useOfflineSync();
  const [lignes, setLignes] = useState<LigneRefus[]>([]);
  const [retours, setRetours] = useState<Retour[]>([]);
  const [enCours, setEnCours] = useState<string | null>(null);
  // File illisible (coffre verrouille, aucun compte...) : dite, sans rejet non gere. Se leve a la prochaine lecture reussie.
  const [erreurLecture, setErreurLecture] = useState<string | null>(null);
  // Renvoi refuse par le stockage ou echoue : dit, et conserve apres la relecture de la liste. Se leve au renvoi suivant.
  const [erreurRenvoi, setErreurRenvoi] = useState<string | null>(null);

  // Cle stable : un tableau recree a chaque rendu relancerait la lecture a chaque rendu.
  const cleFiles = files.join(",");

  const charger = useCallback(async () => {
    const voulues = cleFiles.split(",");
    try {
      const [defauts, portions, observations] = await Promise.all([
        voulues.includes("defauts") ? getAllPendingDefauts({ sansPhotos: true }) : Promise.resolve([] as DefautLu[]),
        voulues.includes("portions") ? getAllPendingPortions({ sansPhotos: true }) : Promise.resolve([] as PortionLue[]),
        voulues.includes("observations") ? getAllPendingObservations({ sansPhotos: true }) : Promise.resolve([] as ObservationLue[]),
      ]);
      const miennes = <T extends { ownerUserId?: string; status: string }>(l: readonly T[]) =>
        l.filter((s) => s.ownerUserId === compteId && s.status === STATUT_REFUS_DROITS);
      const lues: LigneRefus[] = [
        ...miennes<DefautLu>(defauts).map((d): LigneRefus => ({
          cle: `defauts:${d.localId}`, file: "defauts", localId: d.localId, titre: `Défaut ${d.payload.catalogueCode}`,
          date: d.payload.constateA, nbPhotos: photosDe(d), cause: causeDe(d.causeRefusDroits),
        })),
        ...miennes<PortionLue>(portions).map((p): LigneRefus => ({
          cle: `portions:${p.localId}`, file: "portions", localId: p.localId, titre: `Portion de ${Math.round(p.payload.debutM)} m à ${Math.round(p.payload.finM)} m`,
          date: p.payload.observeeLe ?? p.createdAt, nbPhotos: 0, cause: causeDe(p.causeRefusDroits),
        })),
        ...miennes<ObservationLue>(observations).map((o): LigneRefus => ({
          cle: `observations:${o.localId}`, file: "observations", localId: o.localId, titre: `Observation ${LIBELLES_TYPE[o.payload.type] ?? o.payload.type}`,
          date: o.payload.observeA, nbPhotos: photosDe(o), cause: causeDe(o.causeRefusDroits),
        })),
      ].sort((a, b) => b.date.localeCompare(a.date));
      setLignes(lues);
      setErreurLecture(null);
    } catch (e) {
      setLignes([]);
      setErreurLecture(messageStockageLocal(e) ?? "Les saisies refusées de ce téléphone n'ont pas pu être lues. Elles ne sont pas perdues.");
    }
  }, [compteId, cleFiles]);

  useEffect(() => { void charger(); }, [charger, pendingCount, refusDroitsCount, syncing]);

  async function renvoyer(ligne: LigneRefus) {
    setEnCours(ligne.cle);
    setErreurRenvoi(null);
    let issue: IssueRelanceDroits;
    try {
      issue = await relancerRefusDroits(ligne.localId, ligne.file);
    } catch (e) {
      // Erreur typee du stockage (coffre verrouille, stockage plein...) : l'alerte la dit. Autre erreur : le dire aussi, sans rien supposer.
      setErreurRenvoi(messageStockageLocal(e, "enregistrer") ?? "Le renvoi n'a pas pu être fait. La saisie est conservée sur ce téléphone.");
      setEnCours(null);
      await charger();
      return;
    }
    const { message, ok } = messageIssueRelance(issue);
    setRetours((avant) => [{ cle: `${ligne.cle}:${avant.length}`, titre: `${ligne.titre} du ${heure(ligne.date)}`, message, ok }, ...avant].slice(0, 5));
    setEnCours(null);
    await charger();
  }

  if (lignes.length === 0 && retours.length === 0 && !erreurLecture && !erreurRenvoi) return null;

  return (
    <section id="refus-droits" aria-labelledby="refus-droits-titre" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <h2 id="refus-droits-titre" className="flex items-center gap-2 font-semibold">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        Saisies refusées : droits modifiés ({lignes.length})
      </h2>
      <p>
        Le serveur a refusé ces saisies parce que vos droits ont changé. Elles sont conservées sur ce téléphone et ne sont jamais
        renvoyées toutes seules. Contactez votre responsable ; une fois vos droits rendus, utilisez « Renvoyer ».
      </p>

      <AlerteStockageLocal message={erreurLecture} />
      <AlerteStockageLocal message={erreurRenvoi} />

      <div role="status" aria-live="polite">
        {retours.length > 0 && (
          <ul className="space-y-1">
            {retours.map((r) => (
              <li key={r.cle} className={r.ok ? "text-green-900" : "text-amber-950"}>
                <strong>{r.titre} :</strong> {r.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {lignes.length > 0 && (
        <ul className="space-y-2">
          {lignes.map((l) => (
            <li key={l.cle} className="rounded border border-amber-300 bg-white p-3 text-slate-900" data-file={l.file} data-cause={l.cause}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{l.titre}</span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950">{LIBELLES_FILE[l.file]} en quarantaine</span>
              </div>
              <p className="text-slate-700">
                Constaté le {heure(l.date)} · {l.nbPhotos > 0 ? accorde(l.nbPhotos, "photo", "photos") : "aucune photo"}
              </p>
              <p className="mt-1">{MESSAGES_REFUS_DROITS[l.cause]}</p>
              <div className="mt-2">
                <Button
                  type="button" size="sm" variant="outline"
                  disabled={enCours !== null}
                  aria-busy={enCours === l.cle}
                  aria-label={`Renvoyer cette saisie : ${l.titre}, constatée le ${heure(l.date)}`}
                  onClick={() => void renvoyer(l)}
                >
                  Renvoyer
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
