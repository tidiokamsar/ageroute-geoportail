import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import type { ErreurPv } from "../../lib/projetsVoirie";

/**
 * Cadre commun des dialogues d'ecriture des lots B1 (reseaux) et B3 (workflow) : titre, description, erreur typee (role alert), annulation, validation.
 * Monte seulement quand il est ouvert : l'etat repart a zero. Le dialogue ne se ferme ni par un clic a l'exterieur ni pendant l'envoi.
 */

export const CHAMP_TEXTE = "mt-1 w-full rounded-md border border-gray-400 p-2 text-sm";
export const LIBELLE_CHAMP = "block text-sm font-medium text-gray-900";

export function Compteur({ id, texte, min = 10 }: { id: string; texte: string; min?: number }) {
  const n = texte.trim().length;
  return <p id={id} className={`text-xs ${n >= min ? "text-green-800" : "text-gray-700"}`}>{n} / {min} caractères minimum</p>;
}

export interface PropsCadre {
  titre: string;
  description: ReactNode;
  enCours: boolean;
  erreur: ErreurPv | null;
  peutValider: boolean;
  libelleValider: string;
  libelleEnCours: string;
  onFermer: () => void;
  onValider: () => void;
  enLigne?: boolean;
  /** Raison, dite en clair, pour laquelle l'enregistrement est impossible (liste des erreurs de saisie). */
  aide?: string[];
  large?: boolean;
  children: ReactNode;
}

export function CadreDialogue({ titre, description, enCours, erreur, peutValider, libelleValider, libelleEnCours, onFermer, onValider, enLigne = true, aide, large, children }: PropsCadre) {
  const idAide = useId();
  function soumettre(e: FormEvent) { e.preventDefault(); if (peutValider && !enCours && enLigne) onValider(); }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !enCours) onFermer(); }}>
      <DialogContent masquerCroix className={`max-h-[92vh] overflow-y-auto ${large ? "max-w-[680px]" : "max-w-[540px]"}`} onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle className="text-base font-semibold text-primary">{titre}</DialogTitle>
        <DialogDescription asChild><div className="space-y-1 text-sm text-gray-700">{description}</div></DialogDescription>
        <form onSubmit={soumettre} className="grid gap-3" noValidate aria-label={titre}>
          {children}
          {aide && aide.length > 0 && !peutValider && (
            <ul id={idAide} data-testid="aide-saisie" className="list-disc space-y-0.5 rounded border border-gray-300 bg-gray-50 p-2 pl-6 text-xs text-gray-900">
              {aide.map((a) => <li key={a}>{a}</li>)}
            </ul>
          )}
          {!enLigne && <p role="alert" className="text-sm text-amber-900">Vous êtes hors ligne : l&apos;enregistrement est impossible tant que la connexion n&apos;est pas revenue.</p>}
          {erreur && <p role="alert" data-code={erreur.code ?? undefined} className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">{erreur.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" className="min-h-[44px] xl:min-h-9" disabled={enCours} onClick={onFermer}>Annuler</Button>
            <Button type="submit" className="min-h-[44px] xl:min-h-9" disabled={enCours || !peutValider || !enLigne} aria-describedby={aide && aide.length > 0 && !peutValider ? idAide : undefined}>{enCours ? libelleEnCours : libelleValider}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Execute l'ecriture ; en cas d'echec, garde le formulaire ouvert avec l'erreur typee. `classer` est le classeur d'erreurs de l'ecran
 * (`classerErreurReseau`, `classerErreurWorkflow`). `codesMemorises` : codes d'erreur que le formulaire doit se rappeler (par exemple la separation des taches).
 */
export function useEnvoiDialogue(onFermer: () => void, classer: (e: unknown) => ErreurPv) {
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<ErreurPv | null>(null);
  const [codesVus, setCodesVus] = useState<ReadonlySet<string>>(new Set());
  async function envoyer(f: () => Promise<unknown>) {
    setEnCours(true); setErreur(null);
    try { await f(); onFermer(); } catch (e) {
      const c = classer(e);
      if (c.code) setCodesVus((s) => new Set(s).add(c.code as string));
      setErreur(c);
    } finally { setEnCours(false); }
  }
  return { enCours, erreur, envoyer, codesVus };
}
