import { useState } from "react";
import { useSessionLocale } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { DialogueChangementPin } from "./DialogueChangementPin";
import { DialogueEffacementLocal } from "./DialogueEffacementLocal";
import { DialoguePinOublie } from "./DialoguePinOublie";

/**
 * Panneau « Session locale » (menu de l'en-tete) : verrouiller maintenant, changer le code, reinitialiser le code oublie,
 * effacer les donnees de ce telephone. Chaque geste destructif est un dialogue a part, avec son decompte.
 */
export function PanneauSessionLocale({ ouvert, surFermer }: { ouvert: boolean; surFermer: () => void }) {
  const { session, controleur } = useSessionLocale();
  const [dialogue, setDialogue] = useState<"PIN" | "OUBLI" | "EFFACER" | null>(null);

  if (!ouvert) return null;
  return (
    <>
      <Modal open={dialogue === null} onClose={surFermer} title="Session locale">
        <div className="space-y-3 text-sm text-gray-700">
          <p>
            {session.coffrePresent
              ? session.deverrouille ? "La session locale est déverrouillée." : "La session locale est verrouillée."
              : "Aucun code PIN n'est encore créé sur ce téléphone."}
          </p>
          <div className="flex flex-col gap-2">
            {session.coffrePresent && session.deverrouille && (
              <Button type="button" variant="outline" onClick={() => { controleur.verrouiller(); surFermer(); }}>Verrouiller maintenant</Button>
            )}
            {session.coffrePresent && (
              <>
                <Button type="button" variant="outline" onClick={() => setDialogue("PIN")}>Changer le code PIN</Button>
                <Button type="button" variant="outline" onClick={() => setDialogue("OUBLI")}>Code oublié : réinitialiser</Button>
              </>
            )}
            <Button type="button" variant="outline" onClick={() => setDialogue("EFFACER")}>Effacer les données de ce téléphone</Button>
          </div>
        </div>
      </Modal>
      <DialogueChangementPin ouvert={dialogue === "PIN"} surFermer={() => setDialogue(null)} />
      <DialoguePinOublie ouvert={dialogue === "OUBLI"} surFermer={() => { setDialogue(null); surFermer(); }} />
      <DialogueEffacementLocal ouvert={dialogue === "EFFACER"} surFermer={() => { setDialogue(null); surFermer(); }} />
    </>
  );
}
