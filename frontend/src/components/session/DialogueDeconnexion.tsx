import { useEffect, useState } from "react";
import { toast } from "../../lib/toast";
import { decisionSuppressionLocale, texteRefusDroits, type ComptesFile } from "../../session/politiqueDeconnexion";
import { useSessionLocale } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

const accorde = (n: number, singulier: string, pluriel: string) => `${n} ${n >= 2 ? pluriel : singulier}`;

/** « 2 saisies, 1 photo et 1 relevé de roulage » : ce qui reste sur le téléphone, en mots d'agent. */
export function resteSurLeTelephone(comptes: ComptesFile | null): string | null {
  if (comptes === null) return null;
  const d = decisionSuppressionLocale(comptes);
  if (!d.refusee || d.raisons.includes("DECOMPTE_INVALIDE")) return null;
  const el: string[] = [];
  if (d.nbSaisies > 0) el.push(accorde(d.nbSaisies, "saisie", "saisies"));
  if (d.nbPhotos > 0) el.push(accorde(d.nbPhotos, "photo", "photos"));
  if (d.nbReleves > 0) el.push(accorde(d.nbReleves, "relevé de roulage", "relevés de roulage"));
  return el.length <= 1 ? el.join("") : `${el.slice(0, -1).join(", ")} et ${el[el.length - 1]}`;
}

export type ResumeFileDeconnexion =
  | { readonly nature: "CHARGEMENT" }
  | { readonly nature: "INCONNU" }
  | { readonly nature: "VIDE" }
  | { readonly nature: "RESTE"; readonly texte: string };

/**
 * Ce que le dialogue dit de la file, SANS confondre quatre situations (constat de la relecture independante : « aucune saisie en
 * attente n'a ete trouvee » etait aussi affiche quand le decompte etait inconnu ou en chargement, et « elles partiront a votre
 * prochaine connexion » aussi pour des saisies refusees pour droits, qui ne partent PAS toutes seules) :
 *   - `undefined` : decompte en cours de lecture ; `null` ou decompte invalide : INCONNU (on ne pretend rien) ;
 *   - rien en file : VIDE ;
 *   - sinon RESTE : ce qui reste, ce qui partira seul, ce qui attend une decision (saisies refusees pour droits : « Renvoyer »),
 *     et le releve de roulage, qui ne part que par un geste de l'agent sur l'ecran de releve.
 */
export function resumeFileDeconnexion(comptes: ComptesFile | null | undefined): ResumeFileDeconnexion {
  if (comptes === undefined) return { nature: "CHARGEMENT" };
  if (comptes === null) return { nature: "INCONNU" };
  const d = decisionSuppressionLocale(comptes);
  if (d.raisons.includes("DECOMPTE_INVALIDE")) return { nature: "INCONNU" };
  if (!d.refusee) return { nature: "VIDE" };
  const refus = comptes.refusDroits ?? 0;
  const reste = resteSurLeTelephone(comptes) ?? "";
  const partentSeules = d.nbSaisies - refus > 0 || d.nbPhotos > 0;
  const phrases = [`Restent chiffrés sur ce téléphone : ${reste}.`];
  if (refus > 0) phrases.push(texteRefusDroits(refus));
  if (partentSeules) phrases.push(refus > 0 ? "Les autres partiront à votre prochaine connexion en ligne avec ce même compte." : "Elles partiront à votre prochaine connexion en ligne avec ce même compte.");
  if (d.nbReleves > 0) phrases.push("Un relevé de roulage ne part pas tout seul : il s'envoie depuis l'écran « Enregistrer un relevé ».");
  return { nature: "RESTE", texte: phrases.join(" ") };
}

/**
 * Se deconnecter ferme la session et N'EFFACE RIEN (conception, section 6). Le dialogue dit combien de saisies restent
 * chiffrees sur le telephone et qu'elles partiront a la prochaine connexion du MEME compte. Hors ligne, il annonce le
 * verrou local et la deconnexion rejouee au retour du reseau.
 */
export function DialogueDeconnexion({ ouvert, surFermer, tous = false }: { ouvert: boolean; surFermer: () => void; tous?: boolean }) {
  const { session, controleur } = useSessionLocale();
  // `undefined` : lecture en cours ; `null` : lecture impossible ; sinon le decompte.
  const [comptes, setComptes] = useState<ComptesFile | null | undefined>(undefined);
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    if (!ouvert) return;
    let vivant = true;
    controleur.decompte().then((c) => { if (vivant) setComptes(c); }).catch(() => { if (vivant) setComptes(null); });
    return () => { vivant = false; };
  }, [ouvert, controleur]);

  if (!ouvert) return null;
  const resume = resumeFileDeconnexion(comptes);
  const horsLigne = session.horsLigne || (typeof navigator !== "undefined" && navigator.onLine === false);

  async function confirmer() {
    setOccupe(true);
    try {
      const d = await controleur.deconnecter({ tous });
      toast.info(d.texte);
      surFermer();
    } finally {
      setOccupe(false);
    }
  }

  return (
    <Modal open onClose={surFermer} title={tous ? "Déconnecter tous les appareils ?" : "Se déconnecter ?"}>
      <div className="space-y-3 text-sm text-gray-700">
        {tous && (
          <p>Toutes vos sessions seront révoquées, y compris sur les autres navigateurs. Vous devrez vous reconnecter partout.</p>
        )}
        <p>Se déconnecter ferme votre session. <strong>Aucune donnée n'est supprimée de ce téléphone.</strong></p>
        {resume.nature === "RESTE" && <p role="status">{resume.texte}</p>}
        {resume.nature === "VIDE" && <p role="status">Aucune saisie en attente n'a été trouvée sur ce téléphone.</p>}
        {resume.nature === "CHARGEMENT" && <p role="status">Vérification de la file de ce téléphone...</p>}
        {resume.nature === "INCONNU" && (
          <p role="status">
            L'état de la file de ce téléphone n'a pas pu être vérifié. Rien n'est supprimé : ce qui n'est pas encore parti reste chiffré
            sur ce téléphone.
          </p>
        )}
        {horsLigne && (
          <p className="rounded-md bg-amber-50 p-2 text-amber-900">
            Vous êtes hors ligne : l'application se verrouille tout de suite, et la déconnexion sera confirmée au retour du réseau.
            {tous ? " La révocation de tous les appareils ne sera pas immédiate." : ""}
          </p>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={surFermer} disabled={occupe}>Annuler</Button>
        <Button type="button" variant={tous ? "danger" : "primary"} onClick={() => void confirmer()} disabled={occupe}>
          {occupe ? "Déconnexion..." : tous ? "Tout déconnecter" : "Se déconnecter"}
        </Button>
      </div>
    </Modal>
  );
}
