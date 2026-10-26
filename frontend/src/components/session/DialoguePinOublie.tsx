import { useEffect, useState } from "react";
import { toast } from "../../lib/toast";
import type { DecisionSuppression } from "../../session/politiqueDeconnexion";
import { useSessionLocale } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

const accorde = (n: number, singulier: string, pluriel: string) => `${n} ${n >= 2 ? pluriel : singulier}`;

function perte(d: DecisionSuppression): string[] {
  const el: string[] = [];
  if (d.nbSaisies > 0) el.push(accorde(d.nbSaisies, "saisie non envoyée", "saisies non envoyées"));
  if (d.nbPhotos > 0) el.push(accorde(d.nbPhotos, "photo en attente", "photos en attente"));
  if (d.nbReleves > 0) el.push(accorde(d.nbReleves, "relevé de roulage non confirmé", "relevés de roulage non confirmés"));
  return el;
}

/**
 * PIN oublie : « reinitialiser » est DISTINCT de la deconnexion. Action explicite en DEUX TEMPS : (1) ce que cela detruit et
 * le decompte de ce qui sera perdu ; (2) confirmation avec case a cocher quand des saisies seront perdues. La perte est
 * annoncee d'apres `decisionSuppressionLocale` : un decompte illisible est traite comme une perte possible, jamais comme zero.
 * Le decompte compte aussi un releve de roulage EN COURS (jamais arrete : une page tuee reste « en cours ») ; il ne voit pas ce
 * qu'une page ouverte retient en memoire, et le texte ne pretend pas le contraire.
 */
export function DialoguePinOublie({ ouvert, surFermer }: { ouvert: boolean; surFermer: () => void }) {
  const { controleur } = useSessionLocale();
  const [etape, setEtape] = useState<1 | 2>(1);
  const [decision, setDecision] = useState<DecisionSuppression | null>(null);
  const [charge, setCharge] = useState(false);
  const [compris, setCompris] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState("");

  useEffect(() => {
    if (!ouvert) return;
    let vivant = true;
    controleur.apercuPerte()
      .then((d) => { if (vivant) { setDecision(d); setCharge(true); } })
      .catch(() => { if (vivant) { setDecision(null); setCharge(true); } });
    return () => { vivant = false; };
  }, [ouvert, controleur]);

  if (!ouvert) return null;
  const decompteInvalide = decision === null || decision.raisons.includes("DECOMPTE_INVALIDE");
  const elements = decision && !decompteInvalide ? perte(decision) : [];
  const perteAnnoncee = decision !== null && decision.refusee;

  async function reinitialiser() {
    setOccupe(true);
    setErreur("");
    try {
      const r = await controleur.reinitialiserPin();
      if (r.ok) {
        toast.info("Code réinitialisé. Créez-en un nouveau à votre prochaine connexion en ligne.");
        surFermer();
      } else {
        setErreur(r.message);
      }
    } finally {
      setOccupe(false);
    }
  }

  return (
    <Modal open onClose={surFermer} title="Code oublié : réinitialiser">
      {etape === 1 ? (
        <>
          <div className="space-y-3 text-sm text-gray-700">
            <p>
              Personne ne peut retrouver votre code. La seule solution est de le <strong>réinitialiser</strong> : cela détruit la clé
              qui protège les saisies de ce téléphone. Ce n'est pas la même chose que se déconnecter.
            </p>
            {!charge ? (
              <p role="status">Vérification de la file de ce téléphone...</p>
            ) : decompteInvalide ? (
              <p role="alert" className="rounded-md bg-red-50 p-2 text-red-800">
                L'état de la file de ce téléphone n'a pas pu être vérifié : des saisies non envoyées pourraient être perdues.
              </p>
            ) : elements.length > 0 ? (
              <p role="alert" className="rounded-md bg-red-50 p-2 text-red-800">
                Seront perdus définitivement : {elements.join(", ")}. La synchronisation n'est possible qu'avec le code.
              </p>
            ) : (
              <p role="status">
                Aucune saisie en attente n'a été comptée sur ce téléphone. Ce décompte ne voit pas ce qu'une page ouverte retient encore en
                mémoire (un relevé en cours, une saisie commencée) : cela serait perdu aussi.
              </p>
            )}
            <p>Essayez encore de vous rappeler le code avant de continuer.</p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={surFermer}>J'essaie encore</Button>
            <Button type="button" variant="danger" onClick={() => setEtape(2)} disabled={!charge}>Continuer</Button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-3 text-sm text-gray-700">
            <p><strong>Dernière confirmation.</strong> Le code sera supprimé et les données chiffrées de ce téléphone seront détruites. Cette action est définitive.</p>
            {(perteAnnoncee || decompteInvalide) && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={compris}
                  onChange={(e) => setCompris(e.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  Je comprends que {elements.length > 0 ? elements.join(", ") : "les saisies non envoyées"} seront perdus et ne pourront pas être récupérés.
                </span>
              </label>
            )}
            {erreur && <p role="alert" className="text-red-700">{erreur}</p>}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={surFermer} disabled={occupe}>Annuler</Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => void reinitialiser()}
              disabled={occupe || ((perteAnnoncee || decompteInvalide) && !compris)}
            >
              {occupe ? "Réinitialisation..." : "Réinitialiser le code"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
