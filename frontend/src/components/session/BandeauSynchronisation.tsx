import { useEffect, useId, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { useOfflineSync } from "../../hooks/useOfflineSync";
import {
  etatEnregistrementAppareil, etatSynchronisation, leverArretSynchronisation, MESSAGE_APPAREIL_REVOQUE, MESSAGE_COMPTE_INACTIF,
  syncPendingOfflineData,
} from "../../lib/offlineSync";
import { Button } from "../ui/Button";

/**
 * Bandeau PERSISTANT de l'arret de la synchronisation (chantier D7 ; contrat serveur : docs/securite/SESSION-HORS-LIGNE-SERVEUR.md
 * 2.1 et 2.2). Il se montre tant que le serveur a dit que CET APPAREIL est retire (403 APPAREIL_REVOQUE) ou que le COMPTE est
 * desactive, verrouille ou supprime (401 COMPTE_INACTIF), et seulement alors.
 *
 * CE QU'IL FAIT
 *   - `role="alert"`, jamais masquable : tant que l'arret dure, rien ne part, et l'agent doit pouvoir le lire sur n'importe quelle page.
 *   - dit que les saisies sont CONSERVEES, qu'elles ne partent pas, et qu'il faut contacter le responsable (le serveur est l'autorite :
 *     seule une decision humaine y met fin).
 *   - propose UN geste, « Réessayer maintenant », avec son explication : il leve l'arret et tente UN envoi. Si le serveur refuse encore,
 *     l'arret revient tout seul. Ce n'est pas une relance automatique : un clic, un essai, et le bouton reste inactif pendant l'essai.
 *
 * CE QU'IL NE FAIT PAS
 *   - aucune relance en boucle, aucun minuteur qui leve l'arret, aucun enregistrement d'un appareil neuf (ce serait annuler la decision
 *     de l'administrateur : `offlineSync.ts` ne le fait pas non plus).
 *   - il ne touche pas aux saisies : ni statut, ni suppression, ni compteur de tentatives.
 *   - l'arret tombe aussi tout seul quand le compte change (`configurerUtilisateurSync`) : apres une reconnexion complete du meme
 *     agent, `AppLayout` remet le compte a zero.
 *
 * LIMITE DITE : un essai sans saisie a envoyer ne fait aucune requete ; le serveur n'a alors rien pu confirmer ni infirmer. Le message
 * de fin d'essai le dit au lieu d'annoncer une reprise.
 *
 * DEUXIEME BANDEAU, D'UNE AUTRE NATURE : l'enregistrement d'un appareil NEUF est suspendu (403 APPAREIL_REVOCATION_RECENTE ; voir
 * `etatEnregistrementAppareil`). Ce n'est ni le retrait de l'appareil courant ni un echec : un AUTRE appareil du compte vient d'etre
 * retire et le serveur demande d'attendre quelques minutes. Il a donc `role="status"` (pas `alert`), un ton neutre (ambre, horloge)
 * et un texte qui ne dit JAMAIS que cet appareil est retire. Il n'est montre que si l'arret ci-dessus ne l'est pas. Le reessai
 * automatique a l'echeance est dans `offlineSync` (un seul minuteur, borne) : l'interface n'en pose aucun ; elle offre le geste
 * manuel, qui reessaie tout de suite, delai ou non.
 */

const DUREE_MESSAGE_ESSAI_MS = 10_000;

type Essai = "AUCUN" | "EN_COURS" | "TOUJOURS_ARRETEE" | "ARRET_LEVE";

export function BandeauSynchronisation() {
  const { appareilRevoque, compteInactif, enregistrementSuspendu = false } = useOfflineSync();
  const [essai, setEssai] = useState<Essai>("AUCUN");
  // Causes au moment du clic : pendant l'essai l'arret est leve, et le bandeau doit rester lisible (et garder le bouton) jusqu'au verdict.
  const [figees, setFigees] = useState({ appareilRevoque: false, compteInactif: false });
  const idExplication = useId();
  const arretee = appareilRevoque || compteInactif;
  const enEssai = essai === "EN_COURS";
  const causes = arretee ? { appareilRevoque, compteInactif } : figees;

  // Le compte rendu d'un essai disparait de lui-meme : il ne doit pas rester affiche des heures.
  useEffect(() => {
    if (essai !== "TOUJOURS_ARRETEE" && essai !== "ARRET_LEVE") return;
    const t = setTimeout(() => setEssai("AUCUN"), DUREE_MESSAGE_ESSAI_MS);
    return () => clearTimeout(t);
  }, [essai]);

  async function reessayer() {
    setFigees({ appareilRevoque, compteInactif });
    setEssai("EN_COURS");
    leverArretSynchronisation();
    try {
      // Geste de l'agent : un cycle manuel (il reessaie aussi l'enregistrement de l'appareil pendant un delai de revocation recente).
      await syncPendingOfflineData({ manuel: true });
    } catch {
      // Le cycle ne leve pas pour un arret ; une erreur inattendue ne doit pas laisser le bouton inactif.
    }
    setEssai(etatSynchronisation().message !== null ? "TOUJOURS_ARRETEE" : "ARRET_LEVE");
  }

  if (!arretee && essai === "AUCUN") return enregistrementSuspendu ? <BandeauEnregistrementSuspendu /> : null;
  const alerte = arretee || enEssai;

  return (
    <div className="no-print">
      {alerte && (
        <div role="alert" data-testid="bandeau-synchronisation" className="border-b border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              {causes.appareilRevoque && <p className="font-semibold">{MESSAGE_APPAREIL_REVOQUE}</p>}
              {causes.compteInactif && <p className="font-semibold">{MESSAGE_COMPTE_INACTIF}</p>}
              <p>
                L'envoi de vos saisies est arrêté : rien ne part tant que cette situation dure, et rien n'est supprimé de ce
                téléphone. Contactez votre responsable : lui seul peut y mettre fin.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button type="button" size="sm" variant="outline" onClick={() => void reessayer()} disabled={enEssai} aria-describedby={idExplication}>
                  {enEssai ? "Essai en cours…" : "Réessayer maintenant"}
                </Button>
                <p id={idExplication} className="max-w-prose text-xs">
                  « Réessayer » lève l'arrêt et tente un seul envoi. Si le serveur refuse encore, l'arrêt revient et vos saisies restent
                  en place. À utiliser seulement après avoir été prévenu que la situation est réglée.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      {!arretee && essai === "ARRET_LEVE" && (
        <p role="status" className="border-b border-gray-200 bg-gray-100 px-4 py-2 text-xs text-gray-800">
          L'arrêt est levé. Il reviendra si le serveur refuse encore le prochain envoi ; sans saisie à envoyer, rien n'a été vérifié.
        </p>
      )}
      {arretee && essai === "TOUJOURS_ARRETEE" && (
        <p role="status" className="border-b border-gray-200 bg-gray-100 px-4 py-2 text-xs text-gray-800">
          Essai fait : le serveur refuse toujours. Vos saisies sont conservées.
        </p>
      )}
    </div>
  );
}

/** Heure locale « 14:35 » d'un instant (ms epoch), ou `null` quand l'echeance n'est pas connue. Pur : ne lit pas l'horloge. */
function heureEcheance(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Bandeau de l'enregistrement d'appareil SUSPENDU (voir l'en-tete du fichier). Ni alerte ni echec : un etat d'attente, dit comme tel.
 * Le geste « Réessayer maintenant » lance UN cycle manuel ; s'il aboutit, la suspension tombe et ce bandeau disparait avec elle.
 */
function BandeauEnregistrementSuspendu() {
  const { online = true } = useOfflineSync();
  const [essai, setEssai] = useState<"AUCUN" | "EN_COURS" | "TOUJOURS_SUSPENDU">("AUCUN");
  const idExplication = useId();
  const etat = etatEnregistrementAppareil();
  const heure = heureEcheance(etat.reessayerLeMs);
  const enEssai = essai === "EN_COURS";

  // Le compte rendu d'un essai disparait de lui-meme : il ne doit pas rester affiche des heures.
  useEffect(() => {
    if (essai !== "TOUJOURS_SUSPENDU") return;
    const t = setTimeout(() => setEssai("AUCUN"), DUREE_MESSAGE_ESSAI_MS);
    return () => clearTimeout(t);
  }, [essai]);

  async function reessayer() {
    setEssai("EN_COURS");
    try {
      await syncPendingOfflineData({ manuel: true });
    } catch {
      // Le cycle ne leve pas pour une suspension ; une erreur inattendue ne doit pas laisser le bouton inactif.
    }
    // Suspension levee : ce composant n'est plus rendu, rien a dire. Sinon, on le dit sans pretendre que le serveur a repondu.
    setEssai(etatEnregistrementAppareil().suspendu ? "TOUJOURS_SUSPENDU" : "AUCUN");
  }

  return (
    <div className="no-print">
      <div role="status" data-testid="bandeau-enregistrement-suspendu" className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <div className="flex items-start gap-2">
          <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold">Enregistrement de ce téléphone en attente</p>
            <p>{etat.message}</p>
            <p>
              Vos saisies sont conservées sur ce téléphone et partiront dès que l'enregistrement sera accepté.
              {heure !== null && ` Un nouvel essai aura lieu automatiquement vers ${heure}.`}
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button type="button" size="sm" variant="outline" onClick={() => void reessayer()} disabled={enEssai || !online} aria-describedby={idExplication}>
                {enEssai ? "Essai en cours…" : "Réessayer maintenant"}
              </Button>
              <p id={idExplication} className="max-w-prose text-xs">
                {online
                  ? "Un seul essai, à votre demande. Si le serveur demande encore d'attendre, le délai reprend et vos saisies restent en place."
                  : "Pas de réseau : l'essai est impossible pour l'instant."}
              </p>
            </div>
            {essai === "TOUJOURS_SUSPENDU" && (
              <p className="pt-1 text-xs font-medium">Essai fait : l'enregistrement reste en attente. Vos saisies sont conservées.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
