import { useId, useRef, useState } from "react";
import { CheckCircle2, ClipboardList, Clock, HelpCircle, Loader2, RotateCcw, UserCheck, XCircle } from "lucide-react";
import { toast } from "../../lib/toast";
import type { CorpsTransition, PropositionDetail } from "../../lib/teledetectionApi";
import { useAffectation, useTransition } from "../../lib/teledetectionHooks";
import {
  actionsOffertes, CONSTAT_REF_MAX, estVerdictDefinitif, etatConstat, exigeConstat, libelleStatut, messageObservationsMasquees, nomProposition, peutDecider,
  type ActionDecision, type DefinitionAction,
} from "../../lib/teledetectionAffichage";
import { Button } from "../ui/Button";

/**
 * Decision sur une proposition : Confirmer, Infirmer, Mettre en attente, Demander des informations,
 * Non concluante, Remettre a verifier, Affecter a une inspection.
 *
 * - Un MOTIF est obligatoire pour toute transition (le bouton d'envoi reste inactif sans lui) ;
 *   commentaire et preuves de terrain (observations liees) sont facultatifs.
 * - Un VERDICT (Confirmer, Infirmer) cite son constat : au moins une observation liee OU la reference d'un constat
 *   (`constatRef`), comme le serveur l'exige (`CONSTAT_REQUIS`). Sans l'un des deux, le bouton reste inactif et dit pourquoi.
 * - Un seul envoi a la fois : un verrou SYNCHRONE (`useRef`), pose avant tout etat React, ecarte le double clic et les clics
 *   du meme tick (`isPending` n'est lu qu'au rendu suivant).
 * - Les actions ne sont OFFERTES que si le role le permet, mais c'est le SERVEUR qui decide : son
 *   refus (403, 409 verdict definitif, transition interdite) est affiche tel quel, et les donnees
 *   sont rechargees.
 * - L'affectation cree une mission de verification : le contrat ne lui donne ni motif ni preuve.
 */

const ICONES: Record<ActionDecision, typeof CheckCircle2> = {
  CONFIRMER: CheckCircle2, INFIRMER: XCircle, METTRE_EN_ATTENTE: Clock, DEMANDER_INFORMATIONS: HelpCircle,
  NON_CONCLUANTE: HelpCircle, REMETTRE_A_VERIFIER: RotateCcw, AFFECTER: UserCheck,
};

/** Nom accessible distinct par proposition ; il COMMENCE par le libelle visible (WCAG 2.5.3). */
function nomAccessible(a: DefinitionAction, nom: string): string {
  switch (a.action) {
    case "DEMANDER_INFORMATIONS": return `Demander des informations sur la proposition ${nom}`;
    case "AFFECTER": return `Affecter à une inspection la proposition ${nom}`;
    case "NON_CONCLUANTE": return `Non concluante : classer la proposition ${nom}`;
    default: return `${a.libelle} la proposition ${nom}`;
  }
}

const COULEUR: Partial<Record<ActionDecision, string>> = {
  CONFIRMER: "bg-green-700 text-white hover:bg-green-800",
  INFIRMER: "bg-red-700 text-white hover:bg-red-800",
};

const messageDe = (e: unknown, repli: string) => (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string" ? (e as { message: string }).message : repli);

export function ActionsProposition({ detail, role }: { detail: PropositionDetail; role: string | undefined }) {
  const idMotif = useId();
  const idComm = useId();
  const idRef = useId();
  const idRaison = useId();
  const [ouverte, setOuverte] = useState<DefinitionAction | null>(null);
  const [motif, setMotif] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [preuves, setPreuves] = useState<string[]>([]);
  const [reference, setReference] = useState("");
  const [resultat, setResultat] = useState<string | null>(null);
  const transition = useTransition(detail.id);
  const affectation = useAffectation(detail.id);
  const refFormulaire = useRef<HTMLDivElement>(null);
  // Verrou d'envoi : leve a la fin de la requete (succes OU echec), jamais par un effet de rendu.
  const verrou = useRef(false);
  const observations = detail.terrain?.observations ?? [];
  const nom = nomProposition(detail);
  const offertes = actionsOffertes(role, detail.statut, detail.missionId);
  const enCours = transition.isPending || affectation.isPending;
  const erreur = ouverte?.action === "AFFECTER" ? affectation.error : transition.error;

  function ouvrir(a: DefinitionAction) {
    setOuverte(a); setMotif(""); setCommentaire(""); setPreuves([]); setReference(""); setResultat(null);
    transition.reset(); affectation.reset();
    // Le formulaire s'ouvre sous les boutons : on y amene le focus pour le clavier et les lecteurs d'ecran.
    setTimeout(() => refFormulaire.current?.querySelector<HTMLElement>("textarea, button")?.focus(), 0);
  }
  function fermer() { setOuverte(null); transition.reset(); affectation.reset(); }

  function envoyer() {
    // Verrou AVANT tout le reste : deux clics du meme tick lisent le meme rendu, `enCours` n'a pas encore change.
    if (verrou.current || !ouverte) return;
    if (ouverte.action === "AFFECTER") {
      verrou.current = true;
      affectation.mutateAsync().then(
        (m) => {
          setResultat(m.code ? `Mission ${m.code} créée en brouillon.` : "Mission de vérification créée en brouillon.");
          toast.success("Mission de vérification créée.");
          setOuverte(null);
        },
        (e: unknown) => { toast.error(messageDe(e, "Échec de la création de la mission.")); },
      ).finally(() => { verrou.current = false; });
      return;
    }
    if (!ouverte.vers || !motif.trim()) return;
    // Defense en profondeur : le bouton est deja inactif sans constat, mais le serveur refuserait de toute facon (CONSTAT_REQUIS).
    if (!etat.suffisant) return;
    const corps: CorpsTransition = { vers: ouverte.vers, motif: motif.trim() };
    if (commentaire.trim()) corps.commentaire = commentaire.trim();
    if (ouverte.motifAttente) corps.motifAttente = ouverte.motifAttente;
    if (preuves.length > 0) corps.observationIds = preuves;
    if (exigeConstat(ouverte.action) && reference.trim()) corps.constatRef = reference.trim();
    const cible = ouverte.vers;
    verrou.current = true;
    transition.mutateAsync(corps).then(
      () => {
        setResultat(`Décision enregistrée : la proposition est maintenant « ${libelleStatut(cible)} ».`);
        toast.success("Décision enregistrée.");
        setOuverte(null);
      },
      // Le refus peut faire basculer la fiche (verdict pose entre-temps) : le toast garde le message.
      (e: unknown) => { toast.error(messageDe(e, "Échec de l'enregistrement.")); },
    ).finally(() => { verrou.current = false; });
  }

  const verdict = !!ouverte && exigeConstat(ouverte.action);
  const etat = etatConstat({ action: ouverte?.action ?? "AFFECTER", nbObservations: preuves.length, reference });

  if (estVerdictDefinitif(detail.statut)) {
    // Le verdict qu'on vient de poser fait basculer la fiche (le detail est relu) AVANT que ce composant ne rende le succes : sans ce message,
    // la seule trace de l'enregistrement serait un toast qui disparait (constate par le test de bout en bout, parcours 3).
    return (
      <div className="space-y-2">
        {resultat && <p role="status" className="rounded border border-green-200 bg-green-50 p-2 text-sm text-green-900">{resultat}</p>}
        <p role="status" className="rounded border border-gray-200 bg-gray-50 p-2 text-sm text-gray-700">
          Verdict définitif : cette proposition est « {libelleStatut(detail.statut)} » et ne peut plus être modifiée. Chaque décision est conservée dans l&apos;historique.
        </p>
      </div>
    );
  }
  if (!peutDecider(role)) {
    return (
      <p role="note" className="rounded border border-gray-200 bg-gray-50 p-2 text-sm text-gray-700">
        Consultation seule : seuls les administrateurs et les gestionnaires décident du sort d&apos;une proposition.
        {role === "INSPECTEUR" && " Les preuves de terrain s'ajoutent depuis la mission d'inspection qui vous est affectée."}
      </p>
    );
  }

  const exigeMotif = !!ouverte && ouverte.action !== "AFFECTER";
  const peutEnvoyer = !!ouverte && !enCours && (!exigeMotif || motif.trim().length > 0) && etat.suffisant;
  const masquees = messageObservationsMasquees(detail.terrain?.observationsMasquees);
  // Pourquoi le bouton est inactif, dit en clair (le motif d'abord, puis le constat).
  const raison = !ouverte || enCours ? null : exigeMotif && motif.trim().length === 0 ? "Saisissez le motif de la décision." : etat.raison;

  return (
    <section aria-labelledby="titre-actions" className="space-y-2">
      <h3 id="titre-actions" className="text-sm font-semibold text-navy">Décision</h3>
      {detail.missionId && (
        <p className="text-xs text-gray-600">Une mission de vérification est déjà affectée à cette proposition.</p>
      )}
      {resultat && <p role="status" className="rounded border border-green-200 bg-green-50 p-2 text-sm text-green-900">{resultat}</p>}
      <div className="flex flex-wrap gap-2">
        {offertes.map((a) => {
          const Icone = ICONES[a.action];
          const actif = ouverte?.action === a.action;
          return (
            <Button
              key={a.action} type="button" size="sm"
              variant={COULEUR[a.action] ? "default" : "outline"}
              className={`min-h-[44px] xl:min-h-8 ${COULEUR[a.action] ?? ""}`}
              aria-label={nomAccessible(a, nom)} aria-pressed={actif} disabled={enCours}
              onClick={() => (actif ? fermer() : ouvrir(a))}
            >
              <Icone aria-hidden="true" />
              {a.libelle}
            </Button>
          );
        })}
      </div>

      {ouverte && (
        <div ref={refFormulaire} role="group" aria-label={`${ouverte.libelle} : formulaire de décision`} className="space-y-3 rounded-md border border-navy/30 bg-sky-50/50 p-3">
          <p className="text-sm font-medium text-navy"><ClipboardList aria-hidden="true" className="mr-1 inline h-4 w-4" />{ouverte.libelle}</p>
          <p className="text-xs text-gray-700">{ouverte.effet}</p>

          {ouverte.action !== "AFFECTER" && (
            <>
              <div>
                <label htmlFor={idMotif} className="block text-xs font-medium text-gray-800">Motif <span className="text-red-700">(obligatoire)</span></label>
                <textarea
                  id={idMotif} required aria-required="true" maxLength={1000} rows={3} value={motif} onChange={(e) => setMotif(e.target.value)}
                  className="mt-1 w-full rounded-md border border-input bg-white p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy"
                />
                <p className="text-right text-xs text-gray-600">{motif.length} / 1000</p>
              </div>
              <div>
                <label htmlFor={idComm} className="block text-xs font-medium text-gray-800">Commentaire (facultatif)</label>
                <textarea
                  id={idComm} maxLength={500} rows={2} value={commentaire} onChange={(e) => setCommentaire(e.target.value)} placeholder="Ajouter un commentaire, une observation terrain…"
                  className="mt-1 w-full rounded-md border border-input bg-white p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy"
                />
                <p className="text-right text-xs text-gray-600">{commentaire.length} / 500</p>
              </div>
              <fieldset>
                <legend className="text-xs font-medium text-gray-800">Preuves de terrain (observations liées)</legend>
                {observations.length === 0 ? (
                  <p className="mt-1 text-xs text-gray-600">
                    {verdict
                      ? "Aucune observation de terrain n'est liée à cette proposition : saisissez la référence du constat qui fonde le verdict."
                      : "Aucune observation de terrain n'est liée à cette proposition : la décision sera enregistrée sans preuve jointe."}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {observations.map((o) => (
                      <li key={o.id}>
                        <label className="flex min-h-[44px] items-start gap-2 text-sm xl:min-h-0">
                          <input
                            type="checkbox" className="mt-1 h-4 w-4" checked={preuves.includes(o.id)}
                            onChange={(e) => setPreuves((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))}
                          />
                          <span>{o.resume || "Observation sans résumé"} <span className="text-xs text-gray-600">({o.date.slice(0, 10)}{o.auteur ? `, ${o.auteur}` : ""})</span></span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {masquees && <p className="mt-1 text-xs text-amber-900">{masquees}.</p>}
              </fieldset>
              {verdict && (
                <div>
                  <label htmlFor={idRef} className="block text-xs font-medium text-gray-800">
                    Référence du constat <span className="font-normal text-gray-600">(obligatoire sans observation liée)</span>
                  </label>
                  <input
                    id={idRef} type="text" maxLength={CONSTAT_REF_MAX} value={reference} onChange={(e) => setReference(e.target.value)}
                    placeholder="Mission, rapport ou constat qui fonde le verdict"
                    className="mt-1 h-11 w-full rounded-md border border-input bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:h-9"
                  />
                  <p className="text-right text-xs text-gray-600">{reference.length} / {CONSTAT_REF_MAX}</p>
                </div>
              )}
            </>
          )}

          {enCours && <p role="status" className="flex items-center gap-2 text-sm text-gray-700"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Enregistrement en cours…</p>}
          {erreur && !enCours && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">
              {erreur.genre === "conflit" ? "Le serveur refuse cette décision : " : erreur.genre === "permission" ? "Le serveur refuse cette action pour votre compte : " : "Échec de l'enregistrement : "}
              {erreur.message}
              {erreur.genre === "conflit" && " Les données ont été actualisées."}
            </p>
          )}
          {raison && <p id={idRaison} data-testid="raison-inactif" className="text-xs font-medium text-amber-900">{raison}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!peutEnvoyer} aria-describedby={raison ? idRaison : undefined} onClick={envoyer}>
              {ouverte.action === "AFFECTER" ? "Créer la mission de vérification" : "Enregistrer la décision"}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-8" disabled={enCours} onClick={fermer}>Annuler</Button>
          </div>
        </div>
      )}
    </section>
  );
}
