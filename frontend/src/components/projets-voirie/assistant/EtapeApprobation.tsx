import { useId, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { JUSTIFICATION_MIN, formaterNombre } from "../../../lib/projetsVoirie";
import { justificationValide, raisonAutorisationBloquee, type DeltaDetail } from "../../../lib/projetsVoirieImport";
import { ChampJustification, Encart } from "./commun";

/**
 * Etape 7 : approbation. PROMOTION CONTROLEE en AUTORISE (ou rejet), avec justification obligatoire, auditee. Reservee aux comptes ADMIN et GESTIONNAIRE
 * (le serveur applique le role : 403 sinon). Une version qui retire des objets ne s'autorise qu'apres une revue acceptee. Apres l'autorisation, le
 * RETOUR ARRIERE remet la version precedente en service par une action justifiee et auditee, sans aucune perte : rien n'est supprime.
 */
export function EtapeApprobation({ delta, issue, retour, occupe, enLigne, onDecider, onRetour }: {
  delta: DeltaDetail | null; issue: "AUTORISE" | "REJETE" | null; retour: { version: number } | null; occupe: boolean; enLigne: boolean;
  onDecider: (d: "autoriser" | "rejeter", justification: string) => Promise<boolean>;
  onRetour: (justification: string) => Promise<boolean>;
}) {
  const id = useId();
  const [justif, setJustif] = useState("");
  const [justifRetour, setJustifRetour] = useState("");
  const [confirmeRetour, setConfirmeRetour] = useState(false);
  const statutServeur = delta?.jeu.statut ?? (issue === "AUTORISE" ? "AUTORISE" : issue === "REJETE" ? "REJETE" : "");
  // Apres un retour arriere, ce jeu est remplace : l'ecran ne propose plus rien dessus.
  const statut = retour ? "REMPLACE" : statutServeur;
  const enAttente = statut === "CONTROLE" || statut === "RECU";
  const blocage = enAttente ? raisonAutorisationBloquee(delta?.suppressions ?? null) : null;
  const ok = justificationValide(justif);
  const ra = delta?.retourArriere ?? null;

  async function decider(d: "autoriser" | "rejeter") {
    if (await onDecider(d, justif.trim())) setJustif("");
  }
  async function revenir() {
    if (await onRetour(justifRetour.trim())) { setJustifRetour(""); setConfirmeRetour(false); }
  }

  if (!delta && issue === null) return <p role="status" className="text-sm text-gray-700">Chargement de l&apos;état du jeu…</p>;

  return (
    <div className="space-y-4">
      {delta && (
        <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-gray-200 bg-white p-3 text-sm" data-testid="resume-approbation">
          <dt className="text-gray-700">Version</dt><dd>{delta.jeu.version}</dd>
          <dt className="text-gray-700">Statut du jeu</dt>
          <dd data-testid="statut-jeu">{statut === "CONTROLE" || statut === "RECU" ? "À autoriser (quarantaine)" : statut === "AUTORISE" ? "Autorisé" : statut === "REJETE" ? "Rejeté" : statut === "REMPLACE" ? "Remplacé" : statut}</dd>
          {delta.delta && (<><dt className="text-gray-700">Comparaison</dt><dd>{formaterNombre(delta.delta.ajoutes, 0)} ajouté(s), {formaterNombre(delta.delta.modifies, 0)} modifié(s), {formaterNombre(delta.delta.retires, 0)} retiré(s), {formaterNombre(delta.delta.identiques, 0)} identique(s)</dd></>)}
          <dt className="text-gray-700">Suppressions</dt>
          <dd>{delta.suppressions.statut === "AUCUNE" ? "Aucune" : delta.suppressions.statut === "A_REVOIR" ? `${formaterNombre(delta.suppressions.nb, 0)} à revoir` : delta.suppressions.statut === "ACCEPTEES" ? `${formaterNombre(delta.suppressions.nb, 0)} acceptée(s)` : `${formaterNombre(delta.suppressions.nb, 0)} refusée(s)`}</dd>
        </dl>
      )}

      {enAttente && (
        <section className="space-y-3" aria-label="Décision sur le jeu" data-testid="decision">
          <Encart titre="Promotion contrôlée">
            <p>Autoriser fait entrer cette version dans la carte et l&apos;analyse du projet ; rejeter l&apos;écarte pour toujours (elle reste conservée avec sa justification). Cette décision est réservée aux administrateurs et aux gestionnaires, et consignée dans le journal d&apos;audit.</p>
          </Encart>
          {blocage && <Encart ton="attention" testid="blocage-suppressions"><p>{blocage}</p></Encart>}
          <ChampJustification id={`${id}-justif`} libelle="Justification" valeur={justif} onChange={setJustif} disabled={occupe} minimum={JUSTIFICATION_MIN} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={occupe || !enLigne || !ok || blocage !== null} onClick={() => void decider("autoriser")}>Autoriser ce jeu</Button>
            <Button type="button" variant="outline" disabled={occupe || !enLigne || !ok} onClick={() => void decider("rejeter")}>Rejeter ce jeu</Button>
          </div>
        </section>
      )}

      {statut === "REJETE" && (
        <p role="status" data-testid="issue-rejete" className="flex items-start gap-2 rounded border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span><strong>Jeu rejeté.</strong> Il n&apos;alimente ni la carte ni l&apos;analyse ; il reste conservé avec sa justification. Un fichier corrigé peut être déposé de nouveau.</span>
        </p>
      )}

      {statut === "AUTORISE" && (
        <section className="space-y-3" aria-label="Jeu autorisé">
          {issue === "AUTORISE" && !retour && (
            <p role="status" data-testid="issue-autorise" className="flex items-start gap-2 rounded border border-green-300 bg-green-50 p-2 text-sm text-green-900">
              <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span><strong>Jeu autorisé.</strong> Il alimente maintenant la carte et l&apos;analyse du projet.</span>
            </p>
          )}
          {!retour && ra && (
            ra.possible ? (
              <div className="space-y-2 rounded-md border border-gray-300 p-3" data-testid="retour-arriere">
                <h4 className="text-sm font-semibold text-navy">Retour arrière</h4>
                <p className="text-sm text-gray-800">
                  Remettre en service la version {ra.restaureraVersion ?? "précédente"} : cette version ({delta?.jeu.version}) passe à « remplacé ». Aucun jeu, objet ni décision n&apos;est supprimé ; les analyses déjà enregistrées ne changent pas, il faudra relancer une analyse.
                </p>
                <ChampJustification id={`${id}-justif-retour`} libelle="Justification du retour arrière" valeur={justifRetour} onChange={setJustifRetour} disabled={occupe} minimum={JUSTIFICATION_MIN} />
                <label className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm text-gray-900 sm:min-h-0">
                  <input type="checkbox" checked={confirmeRetour} onChange={(e) => setConfirmeRetour(e.target.checked)} disabled={occupe} className="mt-1 h-4 w-4" />
                  <span>Je confirme le retour à la version {ra.restaureraVersion ?? "précédente"}.</span>
                </label>
                <Button type="button" variant="outline" disabled={occupe || !enLigne || !confirmeRetour || !justificationValide(justifRetour)} onClick={() => void revenir()}>Remettre la version précédente en service</Button>
              </div>
            ) : (
              <p className="text-sm text-gray-800" data-testid="retour-impossible">Retour arrière impossible : {ra.raison === "AUCUNE_VERSION_PRECEDENTE" ? "ce jeu ne remplaçait aucune version." : ra.raison === "VERSION_PRECEDENTE_INDISPONIBLE" ? "la version précédente n'est plus disponible (retirée)." : ra.raison === "DEPOT_EN_ATTENTE" ? "un dépôt de même rôle attend son autorisation : autorisez-le, rejetez-le ou retirez-le d'abord." : "raison non précisée."}</p>
            )
          )}
        </section>
      )}

      {retour && (
        <p role="status" data-testid="issue-retour" className="flex items-start gap-2 rounded border border-green-300 bg-green-50 p-2 text-sm text-green-900">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span><strong>Retour arrière effectué.</strong> La version {retour.version} est de nouveau autorisée ; la version retirée du service reste conservée, rien n&apos;est supprimé.</span>
        </p>
      )}
      {statut === "REMPLACE" && !retour && <p className="text-sm text-gray-800">Cette version est remplacée : elle n&apos;alimente plus la carte ni l&apos;analyse, et reste conservée.</p>}
    </div>
  );
}
