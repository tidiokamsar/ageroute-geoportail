import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, WifiOff } from "lucide-react";
import { useSessionLocale } from "../../session/useSessionLocale";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { DialogueDeconnexion } from "./DialogueDeconnexion";
import { DialoguePinOublie } from "./DialoguePinOublie";
import { masquerHorsDe } from "./masqueHorsEcran";

/** « 1 min 05 s », « 28 s » : de quoi montrer une attente a l'agent. */
export function formaterDelai(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Temps restant avant la fin de l'attente imposee apres des echecs, actualise chaque seconde (seulement tant qu'il y en a une). */
function useAttente(jusqua: number | null): number {
  const [maintenant, setMaintenant] = useState(() => Date.now());
  useEffect(() => {
    if (jusqua === null) return;
    setMaintenant(Date.now());
    const t = setInterval(() => setMaintenant(Date.now()), 1000);
    return () => clearInterval(t);
  }, [jusqua]);
  return jusqua === null ? 0 : Math.max(0, jusqua - maintenant);
}

function Cadre({ titre, children }: { titre: string; children: React.ReactNode }) {
  const racine = useRef<HTMLDivElement>(null);
  // Tout ce qui est HORS de cet ecran (le contenu de la page, mais aussi les portails sous `body` : un dialogue Radix ouvert au
  // moment du verrou) devient inert, invisible et hors lecteurs d'ecran. Effet de MISE EN PAGE : il passe avant l'effet qui
  // met le focus dans le champ du PIN, de sorte que le piege a focus d'un dialogue masque ne le reprenne pas.
  useLayoutEffect(() => (racine.current ? masquerHorsDe(racine.current) : undefined), []);
  return (
    <div
      ref={racine}
      role="dialog"
      aria-modal="true"
      aria-labelledby="titre-session-verrouillee"
      // z-40 VOLONTAIREMENT sous les dialogues Radix (z-50) : ceux que cet ecran ouvre lui-meme (code oublie, deconnexion) doivent
      // passer AU-DESSUS. Un dialogue deja ouvert au verrou n'est pas recouvert par le z-index mais masque (masquerHorsDe).
      // `pointer-events: auto` : un dialogue Radix modal ouvert pose `pointer-events: none` sur `body`, ce qui rendrait cet ecran
      // insensible aux clics.
      style={{ pointerEvents: "auto" }}
      className="fixed inset-0 z-40 overflow-y-auto bg-gradient-to-br from-navy to-navy2"
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-[380px] rounded-2xl bg-white p-6 shadow-2xl sm:p-8">
          <div className="mb-3 flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-navy/10">
              <Lock className="h-6 w-6 text-navy" aria-hidden="true" />
            </div>
          </div>
          <h1 id="titre-session-verrouillee" className="mb-1 text-center text-lg font-bold text-navy">{titre}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Ecran qui remplace tout contenu tant que la session locale est verrouillee (PIN), ou qu'il faut choisir un compte, ou
 * que la session a expire. Il n'affiche AUCUNE donnee de saisie : seulement le nom du compte, tel que memorise en clair
 * pour cet usage. La cle est deja oubliee quand il apparait.
 */
export function EcranDeverrouillage({ retour }: { retour?: () => void }) {
  const { session, controleur } = useSessionLocale();
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [oubli, setOubli] = useState(false);
  const [deconnexion, setDeconnexion] = useState(false);
  const champ = useRef<HTMLInputElement>(null);
  const attenteRestante = useAttente(session.attenteJusquaMs);

  const ecran = session.ecran;
  const afficherPin = ecran === "DEVERROUILLAGE" || ecran === "AUCUN";

  useEffect(() => { if (afficherPin) champ.current?.focus(); }, [afficherPin, session.compteId]);

  // Apres un PIN faux, le focus doit REVENIR au champ. L'ancien code appelait `focus()` alors que le champ etait encore
  // `disabled` (pendant `occupe`) : sans effet, et le focus tombait sur BODY (lecteurs d'ecran et clavier perdus). On attend
  // que le champ soit reactive (`occupe` repasse a faux) pour le refocaliser.
  const etaitOccupe = useRef(false);
  useEffect(() => {
    if (etaitOccupe.current && !occupe && afficherPin) champ.current?.focus();
    etaitOccupe.current = occupe;
  }, [occupe, afficherPin]);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (occupe || attenteRestante > 0 || pin.length === 0) return;
    setOccupe(true);
    setErreur("");
    try {
      const r = await controleur.deverrouiller(pin);
      if (!r.ok) {
        setErreur(r.message);
        setPin("");
      }
    } finally {
      setOccupe(false);
    }
  }

  if (ecran === "CHOIX_COMPTE") {
    return (
      <Cadre titre="Choisissez votre compte">
        <p className="mb-4 text-center text-xs text-gray-600">
          Vous êtes hors ligne. Plusieurs comptes ont une session enregistrée sur ce téléphone.
        </p>
        <ul className="space-y-2">
          {session.candidats.map((c, i) => (
            <li key={c.compteId}>
              <Button type="button" variant="outline" className="w-full" onClick={() => void controleur.choisirCompte(c.compteId)}>
                {c.nom && c.nom.length > 0 ? c.nom : `Compte enregistré n° ${i + 1}`}
              </Button>
            </li>
          ))}
        </ul>
        <Button type="button" variant="ghost" className="mt-4 w-full" onClick={() => { controleur.allerALaConnexion(); navigate("/login", { replace: true }); }}>
          Me connecter avec mon mot de passe
        </Button>
      </Cadre>
    );
  }

  if (ecran === "SESSION_EXPIREE") {
    return (
      <Cadre titre="Session locale expirée">
        <p role="alert" className="mb-4 text-center text-sm text-gray-600">
          {session.droitsAReverifier
            ? "Vos droits ont changé sur le serveur : la session locale n'est plus valable. "
            : "La durée maximale sans connexion est dépassée. "}
          Reconnectez-vous avec le réseau pour la renouveler. Vos saisies non envoyées restent chiffrées sur ce téléphone et ne sont pas perdues.
        </p>
        <Button type="button" className="w-full" onClick={() => { controleur.allerALaConnexion(); navigate("/login", { replace: true }); }}>
          Aller à la connexion
        </Button>
      </Cadre>
    );
  }

  return (
    <>
      <Cadre titre="Session verrouillée">
        <form onSubmit={soumettre} noValidate>
          <p className="mb-4 text-center text-xs text-gray-600">
            {session.nomCompte ? <>Compte : <strong>{session.nomCompte}</strong>. </> : null}
            Saisissez votre code PIN pour accéder aux saisies de ce téléphone.
          </p>
          {session.horsLigne && (
            <p className="mb-4 flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Vous êtes hors ligne : vos droits seront revérifiés à la reconnexion.</span>
            </p>
          )}
          {session.droitsAReverifier && !session.horsLigne && (
            <p role="alert" className="mb-4 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              Vos droits ont changé sur le serveur. Saisissez votre code pour renouveler la session locale avec vos droits actuels.
            </p>
          )}
          <label htmlFor="champ-pin-deverrouillage" className="mb-1 block text-sm font-medium text-navy">Code PIN</label>
          <Input
            id="champ-pin-deverrouillage"
            ref={champ}
            type="password"
            // `off` : ce code n'est pas un mot de passe de compte, le navigateur n'a pas a le proposer ni a l'enregistrer.
            // Clavier texte : le code peut etre une phrase de passe (voir ConfigurationPin).
            autoComplete="off"
            inputMode="text"
            spellCheck={false}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            aria-invalid={erreur.length > 0}
            aria-describedby={erreur ? "erreur-pin-deverrouillage" : undefined}
            disabled={occupe}
          />
          <div className="mt-2 min-h-[2.5rem]">
            {erreur && <p id="erreur-pin-deverrouillage" role="alert" className="text-xs font-medium text-red-700">{erreur}</p>}
            {attenteRestante > 0 && (
              <p role="status" className="text-xs text-gray-600">
                Trop d'essais : patientez <span aria-hidden="true">{formaterDelai(attenteRestante)}</span><span className="sr-only">quelques instants</span> avant de réessayer.
              </p>
            )}
          </div>
          <Button type="submit" className="mt-2 w-full" disabled={occupe || attenteRestante > 0 || pin.length === 0}>
            {occupe ? "Vérification..." : "Déverrouiller"}
          </Button>
        </form>

        {session.autresComptes.comptes > 0 && (
          <p className="mt-4 text-center text-xs text-gray-600">
            Des saisies d'un autre compte sont en attente sur ce téléphone. Elles ne sont pas visibles ici.
          </p>
        )}

        <div className="mt-4 flex flex-col gap-1">
          {session.candidats.length > 1 && session.horsLigne && (
            <details className="text-center text-xs text-gray-600">
              <summary className="cursor-pointer py-1">Ce n'est pas votre compte ?</summary>
              <ul className="mt-2 space-y-1">
                {session.candidats.filter((c) => c.compteId !== session.compteId).map((c, i) => (
                  <li key={c.compteId}>
                    <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => void controleur.choisirCompte(c.compteId)}>
                      {c.nom && c.nom.length > 0 ? c.nom : `Autre compte n° ${i + 1}`}
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setOubli(true)}>Code oublié ?</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeconnexion(true)}>Se déconnecter</Button>
          {retour && <Button type="button" variant="ghost" size="sm" onClick={retour}>Quitter le mode terrain</Button>}
        </div>
      </Cadre>
      {oubli && <DialoguePinOublie ouvert surFermer={() => setOubli(false)} />}
      {deconnexion && <DialogueDeconnexion ouvert surFermer={() => setDeconnexion(false)} />}
    </>
  );
}
