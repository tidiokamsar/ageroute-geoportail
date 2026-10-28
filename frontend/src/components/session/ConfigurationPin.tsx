import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { useSessionLocale } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { analyserPin } from "./pinTrivial";

/**
 * Creation du code PIN apres une connexion en ligne (conception : SESSION-HORS-LIGNE.md, section 2). Le texte dit ce que le
 * PIN protege ET ne protege pas, qu'un PIN oublie fait perdre les saisies non envoyees, et conseille de synchroniser souvent.
 *
 * Le texte est EXACT sur la force de la protection (section 3) : le chiffrement ralentit une attaque sur une copie des donnees,
 * il ne la rend pas impossible ; un code plus long ou une phrase de passe protege mieux ; rien ne protege d'un appareil compromis.
 *
 * `autoComplete="off"` et non `new-password` : `new-password` demande au navigateur de proposer et d'ENREGISTRER un mot de passe,
 * ce que ce code local n'est pas. `one-time-code` (code recu par SMS) ne convient pas non plus. `off` n'EMPECHE pas tout
 * gestionnaire de mots de passe de proposer l'enregistrement (le navigateur reste libre de l'ignorer pour un champ mot de passe) :
 * a verifier sur appareil reel. `inputMode="text"` : le code peut etre une phrase de passe, un clavier numerique l'interdirait.
 */
export function ConfigurationPin({ surTermine }: { surTermine?: () => void }) {
  const { controleur } = useSessionLocale();
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);
  const champ = useRef<HTMLInputElement>(null);

  useEffect(() => { champ.current?.focus(); }, []);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    setErreur("");
    const a = analyserPin(pin);
    if (!a.acceptable) { setErreur(a.message); champ.current?.focus(); return; }
    if (pin !== confirmation) { setErreur("Les deux saisies ne sont pas identiques."); return; }
    setOccupe(true);
    try {
      const r = await controleur.creerPin(pin);
      if (r.ok) surTermine?.();
      else setErreur(r.message);
    } finally {
      setOccupe(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg p-4">
      <div className="rounded-2xl bg-white p-6 shadow">
        <div className="mb-3 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-navy/10"><KeyRound className="h-5 w-5 text-navy" aria-hidden="true" /></span>
          <h1 className="text-lg font-bold text-navy">Créez votre code PIN</h1>
        </div>
        <p className="mb-4 text-sm text-gray-700">
          Ce code protège les saisies de terrain enregistrées sur ce téléphone, y compris quand il n'y a pas de réseau.
        </p>

        <h2 className="text-sm font-semibold text-navy">Ce que le code protège</h2>
        <p className="mb-3 text-sm text-gray-700">
          Vos saisies, vos photos et votre session hors ligne sont chiffrées avec ce code. Si quelqu'un copie les données de ce
          téléphone, le chiffrement <strong>ralentit son attaque mais ne la rend pas impossible</strong> : plus le code est long et
          imprévisible, mieux il protège. Une phrase de passe protège beaucoup mieux que six chiffres.
        </p>
        <h2 className="text-sm font-semibold text-navy">Ce qu'il ne protège pas</h2>
        <p className="mb-3 text-sm text-gray-700">
          Un téléphone compromis (logiciel malveillant, navigateur ou application modifiés), ni un téléphone resté déverrouillé entre les
          mains d'un tiers. Il ne remplace pas votre mot de passe et ne permet pas de vérifier vos droits : ils sont revérifiés auprès du
          serveur à chaque reconnexion.
        </p>
        <h2 className="text-sm font-semibold text-navy">Si vous l'oubliez</h2>
        <p className="mb-3 text-sm text-gray-700">
          Personne ne peut le retrouver. Il faudra le réinitialiser, et <strong>les saisies non envoyées de ce téléphone seront perdues</strong>.
          Pensez à synchroniser souvent, dès que vous avez du réseau.
        </p>

        <form onSubmit={soumettre} noValidate className="space-y-3">
          <p id="conseil-pin" className="text-xs text-gray-600">
            Au moins 6 caractères. Une courte phrase est plus sûre que six chiffres. Évitez 123456, 000000, une date de naissance ou un motif répété.
          </p>
          <div>
            <label htmlFor="pin-creation" className="mb-1 block text-sm font-medium text-navy">Code PIN</label>
            <Input id="pin-creation" ref={champ} type="password" autoComplete="off" inputMode="text" spellCheck={false} value={pin} onChange={(e) => setPin(e.target.value)} aria-describedby="conseil-pin" />
          </div>
          <div>
            <label htmlFor="pin-creation-confirmation" className="mb-1 block text-sm font-medium text-navy">Confirmez le code</label>
            <Input id="pin-creation-confirmation" type="password" autoComplete="off" inputMode="text" spellCheck={false} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          </div>
          <p role="alert" className="min-h-[1.25rem] text-xs font-medium text-red-700">{erreur}</p>
          <Button type="submit" className="w-full" disabled={occupe || pin.length === 0}>
            {occupe ? "Création..." : "Créer mon code"}
          </Button>
        </form>
      </div>
    </div>
  );
}
