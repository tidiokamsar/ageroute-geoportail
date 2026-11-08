import { useCallback, useEffect, useRef, useState } from "react";
import { useOfflineSync } from "../../hooks/useOfflineSync";
import { syncPendingOfflineData } from "../../lib/offlineSync";
import { toast } from "../../lib/toast";
import type { DecisionSuppression } from "../../session/politiqueDeconnexion";
import { useSessionLocale } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

const MESSAGES_REFUS: Record<string, string> = {
  AUCUN_COMPTE: "Aucun compte n'est ouvert : il n'y a rien à effacer.",
  DECOMPTE_INDISPONIBLE: "L'état de la file de ce téléphone n'a pas pu être vérifié : rien n'a été effacé.",
  COMPTE_CHANGE: "Le compte a changé pendant la vérification : rien n'a été effacé.",
  ECHEC_SUPPRESSION: "L'effacement n'a pas pu aller au bout (fermez les autres onglets de l'application et réessayez). Votre session reste ouverte.",
};

/**
 * Effacement des donnees locales du compte COURANT, distinct de la deconnexion. REFUSE tant qu'il reste une saisie, une
 * photo ou un releve non confirme : le texte et les actions viennent de `decisionSuppressionLocale`. Aucun autre compte du
 * telephone n'est concerne.
 */
export function DialogueEffacementLocal({ ouvert, surFermer }: { ouvert: boolean; surFermer: () => void }) {
  const { controleur } = useSessionLocale();
  const [decision, setDecision] = useState<DecisionSuppression | null>(null);
  const [charge, setCharge] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState("");

  const evaluer = useCallback(async (silencieux = false) => {
    if (!silencieux) setCharge(false);
    try { setDecision(await controleur.apercuPerte()); } catch { setDecision(null); }
    setCharge(true);
  }, [controleur]);

  // L'etat de la file est LU en direct : une synchronisation deja en cours (automatique) peut vider la file apres le clic sur
  // « Synchroniser maintenant » (syncPendingOfflineData rend la main tout de suite quand une synchronisation tourne). Sans cette
  // relecture, la decision « refusee » restait affichee alors que la file etait vide (defaut (i) du test de bout en bout).
  const { pendingCount, syncing, conflitCount, abandonCount, refusDroitsCount } = useOfflineSync();
  const empreinteFile = `${pendingCount}|${syncing}|${conflitCount}|${abandonCount}|${refusDroitsCount ?? 0}`;

  // Une seule lecture a l'ouverture (avec « Verification... »), puis des relectures silencieuses a chaque changement de la file.
  const dejaCharge = useRef(false);
  useEffect(() => {
    if (!ouvert) { dejaCharge.current = false; return; }
    void evaluer(dejaCharge.current);
    dejaCharge.current = true;
  }, [ouvert, evaluer, empreinteFile]);

  if (!ouvert) return null;

  async function synchroniser() {
    setOccupe(true);
    // « Synchroniser maintenant » est un geste de l'agent : il reessaie l'enregistrement de l'appareil meme pendant un delai de revocation recente.
    try { await syncPendingOfflineData({ manuel: true }); } finally { setOccupe(false); }
    await evaluer(true);
  }

  async function effacer() {
    setOccupe(true);
    setErreur("");
    try {
      const r = await controleur.effacerDonneesLocales();
      if (r.ok) {
        toast.success("Les données de ce téléphone ont été effacées pour votre compte.");
        surFermer();
      } else if (r.raison === "FILE_NON_VIDE" && r.decision) {
        setDecision(r.decision);
      } else {
        setErreur(MESSAGES_REFUS[r.raison] ?? "Effacement impossible.");
      }
    } finally {
      setOccupe(false);
    }
  }

  const refuse = decision === null || decision.refusee;

  return (
    <Modal open onClose={surFermer} title="Effacer les données de ce téléphone">
      <div className="space-y-3 text-sm text-gray-700">
        <p>
          Cette action supprime, pour <strong>votre compte seulement</strong>, les saisies, les photos, les relevés, les copies de référentiels
          et la session locale (code PIN) enregistrés sur ce téléphone. Ce n'est pas la même chose que se déconnecter : la déconnexion n'efface rien.
        </p>
        {!charge ? (
          <p role="status">Vérification de la file de ce téléphone...</p>
        ) : decision === null ? (
          <p role="alert" className="rounded-md bg-red-50 p-2 text-red-800">{MESSAGES_REFUS.DECOMPTE_INDISPONIBLE}</p>
        ) : decision.refusee ? (
          <>
            <p role="alert" className="rounded-md bg-amber-50 p-2 text-amber-900">{decision.texte}</p>
            <div className="flex flex-wrap gap-2">
              {decision.actions.includes("SYNCHRONISER_MAINTENANT") && (
                <Button type="button" variant="outline" size="sm" onClick={() => void synchroniser()} disabled={occupe}>
                  Synchroniser maintenant
                </Button>
              )}
              {decision.actions.includes("EXPORTER") && (
                <Button type="button" variant="outline" size="sm" disabled aria-describedby="note-export">Exporter</Button>
              )}
              {decision.actions.includes("LAISSER_TELLES_QUELLES") && (
                <Button type="button" variant="ghost" size="sm" onClick={surFermer}>Laisser telles quelles</Button>
              )}
            </div>
            {decision.actions.includes("EXPORTER") && (
              <p id="note-export" className="text-xs text-gray-600">L'export des saisies n'est pas encore disponible dans cette version.</p>
            )}
          </>
        ) : (
          <p role="status">{decision.texte} Vous devrez créer un nouveau code PIN à votre prochaine connexion en ligne.</p>
        )}
        {erreur && <p role="alert" className="text-red-700">{erreur}</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={surFermer} disabled={occupe}>Annuler</Button>
        <Button type="button" variant="danger" onClick={() => void effacer()} disabled={occupe || !charge || refuse}>
          {occupe ? "Effacement..." : "Effacer les données"}
        </Button>
      </div>
    </Modal>
  );
}
