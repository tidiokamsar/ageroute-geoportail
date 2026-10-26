import { useState, type FormEvent } from "react";
import { toast } from "../../lib/toast";
import { useSessionLocale } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { analyserPin } from "./pinTrivial";

/** Changement de PIN : l'ancien code est exige, le nouveau est saisi deux fois et refuse s'il est trivial. */
export function DialogueChangementPin({ ouvert, surFermer }: { ouvert: boolean; surFermer: () => void }) {
  const { controleur } = useSessionLocale();
  const [ancien, setAncien] = useState("");
  const [nouveau, setNouveau] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);

  if (!ouvert) return null;

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    setErreur("");
    const a = analyserPin(nouveau);
    if (!a.acceptable) { setErreur(a.message); return; }
    if (nouveau !== confirmation) { setErreur("Les deux saisies du nouveau code ne sont pas identiques."); return; }
    if (nouveau === ancien) { setErreur("Le nouveau code doit être différent de l'ancien."); return; }
    setOccupe(true);
    try {
      const r = await controleur.changerPin(ancien, nouveau);
      if (r.ok) {
        toast.success("Code PIN modifié.");
        surFermer();
      } else {
        setErreur(r.message);
        setAncien("");
      }
    } finally {
      setOccupe(false);
    }
  }

  return (
    <Modal open onClose={surFermer} title="Changer le code PIN">
      <form onSubmit={soumettre} noValidate className="space-y-3">
        <div>
          <label htmlFor="pin-ancien" className="mb-1 block text-sm font-medium text-navy">Code actuel</label>
          <Input id="pin-ancien" type="password" autoComplete="off" spellCheck={false} value={ancien} onChange={(e) => setAncien(e.target.value)} />
        </div>
        <div>
          <label htmlFor="pin-nouveau" className="mb-1 block text-sm font-medium text-navy">Nouveau code (6 caractères au moins)</label>
          <Input id="pin-nouveau" type="password" autoComplete="off" spellCheck={false} value={nouveau} onChange={(e) => setNouveau(e.target.value)} />
        </div>
        <div>
          <label htmlFor="pin-confirmation" className="mb-1 block text-sm font-medium text-navy">Confirmez le nouveau code</label>
          <Input id="pin-confirmation" type="password" autoComplete="off" spellCheck={false} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </div>
        <p className="min-h-[1.25rem] text-xs font-medium text-red-700" role="alert">{erreur}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={surFermer} disabled={occupe}>Annuler</Button>
          <Button type="submit" disabled={occupe || ancien.length === 0 || nouveau.length === 0}>
            {occupe ? "Modification..." : "Changer le code"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
