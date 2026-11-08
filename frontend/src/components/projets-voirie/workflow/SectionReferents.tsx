/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useState } from "react";
import { Loader2, UserMinus, UserPlus } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatErreur, EtatVide } from "../EtatsPv";
import { useRestitutionFocus } from "../focusDialogue";
import { BadgeSimple, Liste, Ligne, nomPersonne } from "./commun";
import type { Concessionnaire } from "../../../lib/projetsVoirieApi";
import type { ProfilWorkflow, RattachementReferent } from "../../../lib/projetsVoirieWorkflowApi";
import { useCreerRattachement, useRechercheComptes, useReferents, useRevoquerRattachement } from "../../../lib/projetsVoirieWorkflowHooks";
import { aLeDroit, classerErreurWorkflow, estUuid, justificationValide } from "../../../lib/projetsVoirieWorkflow";
import { useValeurDifferee } from "../../../lib/projetsVoirieHooks";
import { formaterDateHeure } from "../../../lib/projetsVoirieConflits";

/**
 * Referents concessionnaires. Un referent n'est PAS un role : c'est un compte lecteur qui porte la cle de module « Projets de voirie » et un rattachement
 * (compte, concessionnaire, projet) pose par un administrateur. Il n'ouvre que les echanges de son concessionnaire. Un rattachement se revoque, il ne se supprime pas.
 * Poser et revoquer : administrateur seulement (droit `referent.gerer` renvoye par le serveur) ; lire : administrateur et gestionnaire.
 */

function DialogueRattachement({ concessionnaires, enLigne, onFermer, onValider }: { concessionnaires: Concessionnaire[]; enLigne: boolean; onFermer: () => void; onValider: (c: { userId: string; concessionnaireId: string; motif: string }) => Promise<unknown> }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [userId, setUserId] = useState("");
  const [conc, setConc] = useState("");
  const [motif, setMotif] = useState("");
  const qDiffere = useValeurDifferee(q, 300);
  const comptes = useRechercheComptes(qDiffere, true);
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  const erreurs: string[] = [];
  if (!estUuid(userId)) erreurs.push("Choisissez le compte à rattacher.");
  if (!estUuid(conc)) erreurs.push("Choisissez le concessionnaire.");
  if (!justificationValide(motif)) erreurs.push("Le motif doit faire au moins 10 caractères.");
  return (
    <CadreDialogue
      titre="Rattacher un compte comme référent" large
      description={<><p>Le compte doit être un <strong>lecteur actif</strong> qui a déjà la clé de module « Projets de voirie » (attribuée depuis la page Utilisateurs). Une fois rattaché, il n&apos;ouvre plus que les échanges de ce concessionnaire sur ce projet : plus la carte, plus les analyses.</p><p>Un référent ne voit que les éléments partagés avec son concessionnaire. Le rattachement est consigné avec votre nom et votre motif.</p></>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Rattacher le compte" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider({ userId, concessionnaireId: conc, motif: motif.trim() }))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-q`} className={LIBELLE_CHAMP}>Rechercher un compte lecteur (nom ou courriel)</label>
        <Input id={`${id}-q`} type="search" value={q} onChange={(e) => { setQ(e.target.value); setUserId(""); }} maxLength={100} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      {comptes.isPending && <p role="status" className="flex items-center gap-2 text-xs text-gray-700"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Recherche des comptes…</p>}
      {comptes.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">La recherche de comptes a échoué : {classerErreurWorkflow(comptes.error).message}</p>}
      {comptes.isSuccess && (
        <fieldset className="min-w-0 space-y-1 rounded border border-gray-300 p-2">
          <legend className="px-1 text-xs font-medium text-gray-800">{comptes.data.length === 0 ? "Aucun compte lecteur actif ne correspond" : `Comptes lecteurs actifs (${comptes.data.length})`}</legend>
          <div role="region" aria-label="Comptes proposés, liste défilante" tabIndex={0} className="max-h-48 space-y-1 overflow-auto">
            {comptes.data.map((c) => (
              <label key={c.id} className="flex min-h-[44px] items-start gap-2 rounded p-1 text-sm text-gray-900 hover:bg-gray-50 xl:min-h-0">
                <input type="radio" name={`${id}-compte`} className="mt-1 h-4 w-4 shrink-0" checked={userId === c.id} disabled={enCours} onChange={() => setUserId(c.id)} />
                <span className="min-w-0 break-words">{c.nom ?? "Compte sans nom"}{c.email ? <span className="text-xs text-gray-700"> ({c.email})</span> : null}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div>
        <label htmlFor={`${id}-c`} className={LIBELLE_CHAMP}>Concessionnaire</label>
        <Select id={`${id}-c`} value={conc} disabled={enCours} onChange={(e) => setConc(e.target.value)} className="mt-1 border-gray-300">
          <option value="">Choisir un concessionnaire</option>
          {concessionnaires.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
        </Select>
      </div>
      <div>
        <label htmlFor={`${id}-m`} className={LIBELLE_CHAMP}>Motif du rattachement (10 caractères minimum)</label>
        <textarea id={`${id}-m`} value={motif} onChange={(e) => setMotif(e.target.value)} rows={2} maxLength={2000} disabled={enCours} aria-describedby={`${id}-mn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-mn`} texte={motif} />
      </div>
    </CadreDialogue>
  );
}

function DialogueRevocation({ r, enLigne, onFermer, onValider }: { r: RattachementReferent; enLigne: boolean; onFermer: () => void; onValider: (motif: string) => Promise<unknown> }) {
  const id = useId();
  const [motif, setMotif] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurWorkflow);
  return (
    <CadreDialogue
      titre="Révoquer le rattachement"
      description={<><p><strong>{nomPersonne(r.compte, "Compte sans nom")}</strong> n&apos;aura plus accès aux échanges de {r.concessionnaire?.nom ?? "ce concessionnaire"}. Un rattachement se révoque, il ne se supprime pas : il reste dans l&apos;audit.</p><p>Attention : la révocation <strong>ne retire pas la clé de module</strong> du compte, qui redevient un lecteur ordinaire. Retirez-la depuis la page Utilisateurs pour couper tout accès.</p></>}
      enCours={enCours} erreur={erreur} peutValider={justificationValide(motif)} libelleValider="Révoquer le rattachement" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(motif.trim()))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-m`} className={LIBELLE_CHAMP}>Motif de la révocation (10 caractères minimum)</label>
        <textarea id={`${id}-m`} value={motif} onChange={(e) => setMotif(e.target.value)} rows={2} maxLength={2000} disabled={enCours} aria-describedby={`${id}-mn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-mn`} texte={motif} />
      </div>
    </CadreDialogue>
  );
}

export function SectionReferents(p: { projetId: string; profil: ProfilWorkflow; enLigne: boolean; concessionnaires: Concessionnaire[] }) {
  const requete = useReferents(p.projetId, true);
  const creer = useCreerRattachement(p.projetId);
  const revoquer = useRevoquerRattachement(p.projetId);
  const [dialogue, setDialogue] = useState<{ genre: "rattacher" } | { genre: "revoquer"; r: RattachementReferent } | null>(null);
  const [avertissements, setAvertissements] = useState<string[]>([]);
  const { memoriser, restituer } = useRestitutionFocus();
  const peutGerer = aLeDroit(p.profil.droits, "referent.gerer");
  const erreur = requete.isError ? classerErreurWorkflow(requete.error) : null;
  const fermer = () => { setDialogue(null); restituer(); };
  const liste = requete.data?.rattachements ?? [];
  return (
    <section aria-labelledby="pv-titre-referents" className="space-y-3">
      <h3 id="pv-titre-referents" className="text-sm font-semibold text-navy">Référents concessionnaires</h3>
      <p role="note" className="text-xs text-gray-800">Un référent est un compte lecteur rattaché à un concessionnaire pour ce projet : il lit et complète seulement ce qui est partagé avec son concessionnaire. Ce n&apos;est pas un rôle : le rattachement est un attribut du compte, posé par un administrateur.</p>
      {peutGerer ? (
        <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!p.enLigne} onClick={() => { memoriser(); setDialogue({ genre: "rattacher" }); }}><UserPlus aria-hidden="true" /> Rattacher un compte</Button>
      ) : (
        <p data-testid="referents-lecture-seule" className="text-xs text-gray-800">Lecture seule : seul un administrateur pose ou révoque un rattachement.</p>
      )}
      {avertissements.length > 0 && (
        <div role="status" data-testid="avertissements-revocation" className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <p><strong>Rattachement révoqué.</strong></p>
          <ul className="list-disc pl-5">{avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      {requete.isPending && <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-700"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Chargement des référents…</p>}
      {erreur && <EtatErreur erreur={erreur} sujet="Référents" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}
      {requete.isSuccess && (liste.length === 0 ? (
        <EtatVide titre="Aucun référent rattaché à ce projet"><p>Aucun concessionnaire n&apos;a d&apos;accès aux échanges de ce projet.</p></EtatVide>
      ) : (
        <ul aria-label="Liste : référents" className="space-y-1.5">
          {liste.map((r) => (
            <li key={r.id} data-rattachement-id={r.id} className="space-y-1 rounded border border-gray-300 bg-white p-2 text-xs text-gray-900">
              <p className="flex flex-wrap items-center gap-1">
                <strong>{nomPersonne(r.compte, "Compte sans nom")}</strong>
                <BadgeSimple classes={r.actif ? "border-green-400 bg-green-50 text-green-900" : "border-gray-400 bg-gray-100 text-gray-800"} donnee={r.actif ? "actif" : "revoque"}>{r.actif ? "Rattachement actif" : "Rattachement révoqué"}</BadgeSimple>
              </p>
              <Liste>
                <Ligne libelle="Concessionnaire">{r.concessionnaire?.nom ?? "non communiqué"}</Ligne>
                <Ligne libelle="Motif">{r.motif ?? "non communiqué"}</Ligne>
                <Ligne libelle="Posé par">{nomPersonne(r.creePar)}{r.createdAt ? `, ${formaterDateHeure(r.createdAt)}` : ""}</Ligne>
                {r.revocation && <Ligne libelle="Révoqué">{nomPersonne(r.revocation.par)}{r.revocation.le ? `, ${formaterDateHeure(r.revocation.le)}` : ""}. Motif : {r.revocation.motif ?? "non communiqué"}</Ligne>}
              </Liste>
              {peutGerer && r.actif && (
                <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} aria-label={`Révoquer le rattachement de ${nomPersonne(r.compte, "compte sans nom")}`} onClick={() => { memoriser(); setDialogue({ genre: "revoquer", r }); }}>
                  <UserMinus aria-hidden="true" /> Révoquer
                </Button>
              )}
            </li>
          ))}
        </ul>
      ))}
      {dialogue?.genre === "rattacher" && <DialogueRattachement concessionnaires={p.concessionnaires} enLigne={p.enLigne} onFermer={fermer} onValider={(c) => creer.mutateAsync(c)} />}
      {dialogue?.genre === "revoquer" && (
        <DialogueRevocation r={dialogue.r} enLigne={p.enLigne} onFermer={fermer} onValider={async (motif) => { setAvertissements(await revoquer.mutateAsync({ rattachementId: dialogue.r.id, motif }) as string[]); }} />
      )}
    </section>
  );
}
