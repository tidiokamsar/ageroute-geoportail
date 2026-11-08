import { forwardRef } from "react";
import { AlertTriangle, MapPinOff, X } from "lucide-react";
import {
  ecartLongueur, formaterDate, formaterNombre, libelleExclusion, presenterCout, presenterScore,
} from "../../../lib/aideDecisionCarte";
import { classerErreur, type FicheIntervention as Fiche } from "../../../lib/aideDecisionInterventions";
import { libelleTroncon } from "../../../lib/libelleTroncon";
import { symbole } from "../../../features/geoportail/map/symbology";
import { EtatChargement, EtatErreur } from "./EtatsCarte";

/**
 * Fiche d'une intervention (cahier 6.4) : motif de la priorite, contributions principales (barres ET chiffres), donnees disponibles, limites de
 * l'analyse, historique, actions possibles. Panneau lateral sur grand ecran, bloc sous la carte sur mobile (meme composant, meme ordre de lecture).
 *
 * RIEN N'EST INVENTE : un champ que le serveur ne porte pas est dit « non fourni » (jamais une valeur par defaut), un score INCOMPLET garde son
 * libelle et la liste en clair des criteres manquants, une ligne NON CLASSEE dit son motif, un cout absent est « non estimable » (avec le motif du
 * serveur) et jamais 0, une longueur metier et une longueur geometrique sont affichees separement (la divergence est celle du serveur, signalee,
 * jamais corrigee). Les actions sont affichees TELLES QUE L'API LES DONNE : le serveur n'en offre aucune aujourd'hui (aucun workflow n'existe pour
 * une intervention candidate), et sa raison est affichee. Une priorite calculee est consultative, ce n'est pas une decision.
 */

type Requete = { data: Fiche | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown; isFetching: boolean };

interface Props {
  requete: Requete;
  /** Date du jour AAAA-MM-JJ (parametre : le noyau n'a pas d'horloge) pour juger la validite du cout. */
  aujourdhui: string;
  onFermer: () => void;
  /** Present quand une carte existe a l'ecran ou dans un autre onglet. Le bouton n'est propose QUE pour une localisation valide. */
  onVoirSurCarte?: (id: string) => void;
  libelleBoutonCarte?: string;
}

function Section({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-700">{titre}</h3>
      {children}
    </section>
  );
}

function Ligne({ label, valeur }: { label: string; valeur: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-0.5">
      <dt className="shrink-0 text-xs text-gray-700">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-navy">{valeur}</dd>
    </div>
  );
}

export const FicheIntervention = forwardRef<HTMLHeadingElement, Props>(function FicheIntervention({ requete, aujourdhui, onFermer, onVoirSurCarte, libelleBoutonCarte }, refTitre) {
  const f = requete.data;
  const entete = (
    <div className="flex items-start justify-between gap-2">
      <h2 ref={refTitre} tabIndex={-1} className="min-w-0 text-base font-semibold text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60">
        Fiche de l&apos;intervention
      </h2>
      <button
        type="button"
        onClick={onFermer}
        aria-label="Fermer la fiche de l'intervention"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 xl:h-8 xl:w-8"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );

  if (requete.isPending) {
    return <aside aria-label="Fiche de l'intervention" className="space-y-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">{entete}<EtatChargement libelle="Chargement de la fiche…" /></aside>;
  }
  if (requete.isError || !f) {
    const e = classerErreur(requete.error);
    return (
      <aside aria-label="Fiche de l'intervention" className="space-y-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        {entete}
        <EtatErreur panneau="Fiche de l'intervention" erreur={e} onReessayer={() => { void requete.refetch(); }} reessaiEnCours={requete.isFetching} />
      </aside>
    );
  }

  const score = presenterScore(f.score, f.scoreIncomplet, f.exclusion);
  const cout = presenterCout(f, aujourdhui);
  const ecart = ecartLongueur(f.longueur);
  const maxPoints = Math.max(0, ...f.contributions.map((c) => c.points ?? 0));
  const contributions = [...f.contributions].sort((a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity));
  const localisee = f.localisation === "valide";
  const nomTroncon = f.troncon ? libelleTroncon(f.troncon.code, f.troncon.nom ?? "") : null;
  const c = f.coutEstime;

  return (
    <aside aria-label="Fiche de l'intervention" data-intervention={f.id} className="space-y-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {entete}

      <div>
        <p className="text-sm font-semibold text-gray-900">{nomTroncon ?? "Tronçon non rattaché"}</p>
        <p className="text-xs text-gray-700">
          {f.troncon?.regionNom ?? "Région non renseignée"} · {f.rang === null ? "rang non établi" : `rang ${f.rang}`}
        </p>
      </div>

      {f.provisoire && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p><strong>Provisoire.</strong> Modèle et paramètres non validés par le métier : ce classement est consultatif, ce n&apos;est pas une décision.</p>
            {f.motifsProvisoire.length > 0 && <ul className="mt-1 list-disc pl-4">{f.motifsProvisoire.map((m) => <li key={m}>{m}</li>)}</ul>}
          </div>
        </div>
      )}

      {!localisee && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <strong>Sans localisation valide.</strong> Cette intervention ne peut pas être placée ni centrée sur la carte ; elle reste consultable ici et dans la liste.
            {f.localisationMotif ? ` Motif : ${f.localisationMotif}.` : ""}
          </span>
        </p>
      )}
      {localisee && onVoirSurCarte && (
        <button
          type="button"
          onClick={() => onVoirSurCarte(f.id)}
          className="min-h-11 rounded-md border border-navy bg-white px-3 text-sm font-medium text-navy hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 xl:min-h-9"
        >
          {libelleBoutonCarte ?? "Voir sur la carte"}
        </button>
      )}

      <Section titre="Score">
        {score.genre === "complet" && <p className="text-2xl font-bold tabular-nums text-navy">{score.valeur} <span className="text-sm font-normal text-gray-700">sur 100</span></p>}
        {score.genre === "exclu" && (
          <div data-score="exclu" className="space-y-1 rounded-md border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900">
            <p className="font-semibold">{score.libelle} : ni rang ni score</p>
            <p className="text-xs">{score.motif}</p>
          </div>
        )}
        {score.genre === "incomplet" && (
          <div data-score="incomplet" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
            <p className="font-semibold">{score.libelle}</p>
            <p className="text-xs">
              {score.valeur === null ? "Aucune valeur partielle calculée." : <>Valeur partielle <span className="tabular-nums">{score.valeur}</span> sur 100 : elle ne se lit pas comme un score complet.</>}
            </p>
            {f.criteresManquants.length > 0 ? (
              <>
                <p className="text-xs font-medium">Critères manquants :</p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs">
                  {f.criteresManquants.map((m) => <li key={m.critere}><strong>{m.libelle}</strong> : {m.raison}</li>)}
                </ul>
              </>
            ) : (
              <p className="text-xs">Le serveur ne détaille pas les critères manquants.</p>
            )}
          </div>
        )}
        {score.genre === "absent" && <p className="text-sm text-gray-800">{score.libelle}.</p>}
      </Section>

      <Section titre="Motif de la priorité">
        <p className="text-sm text-gray-900">{f.motif ?? "Motif non fourni par le serveur."}</p>
      </Section>

      <Section titre="Contributions des critères">
        {contributions.length === 0 ? (
          <p className="text-sm text-gray-800">Aucune contribution fournie par le serveur.</p>
        ) : (
          <ul className="space-y-2">
            {contributions.map((k) => (
              <li key={k.critere}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 font-medium text-gray-900">{k.libelle}</span>
                  <span className="shrink-0 tabular-nums text-navy">{k.points === null ? "critère manquant" : `${formaterNombre(k.points, 2)} pts`}</span>
                </div>
                <div aria-hidden="true" className="mt-0.5 h-2 overflow-hidden rounded bg-gray-100">
                  <div className="h-full rounded bg-violet-700" style={{ width: `${k.points !== null && maxPoints > 0 ? Math.max(2, Math.round((k.points / maxPoints) * 100)) : 0}%` }} />
                </div>
                <p className="mt-0.5 text-xs text-gray-700">
                  poids {k.poidsPct === null ? "inconnu" : `${formaterNombre(k.poidsPct, 2)} %`} · valeur normalisée {k.valeurNormalisee === null ? "inconnue" : `${formaterNombre(k.valeurNormalisee, 1)} sur 100`}
                  {k.brut !== null ? ` · mesure ${k.brut}` : ""}{k.provenance ? ` (${k.provenance})` : ""}
                </p>
                {k.note && <p className="text-xs text-gray-700">{k.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section titre="Données disponibles">
        <dl className="divide-y divide-gray-100">
          <Ligne
            label="État physique"
            valeur={f.etatPhysique ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: symbole(f.etatPhysique).trait }} />
                {symbole(f.etatPhysique).libelle}
              </span>
            ) : "inconnu"}
          />
          <Ligne label="Dernier constat" valeur={<>{formaterDate(f.dateDernierConstat) ?? "date inconnue"}{f.sourceDernierConstat && <span className="block text-xs font-normal text-gray-700">{f.sourceDernierConstat}</span>}</>} />
          <Ligne label="Complétude du score" valeur={f.completude === null ? "non renseignée" : `${formaterNombre(f.completude * 100, 0)} % du poids`} />
          <Ligne label="Confiance de l'état" valeur={f.confiance?.niveau ?? "non renseignée"} />
          <Ligne label="Longueur métier" valeur={f.longueur?.metierKm == null ? "non renseignée" : `${formaterNombre(f.longueur.metierKm, 2)} km`} />
          <Ligne label="Longueur géométrique" valeur={f.longueur?.geometriqueKm == null ? "non calculée" : `${formaterNombre(f.longueur.geometriqueKm, 2)} km`} />
          {f.longueur?.origine && <Ligne label="Longueur utilisée pour le coût" valeur={f.longueur.origine === "GEOMETRIE" ? "géométrique (colonne métier vide)" : "métier"} />}
          <Ligne
            label="Coût estimé"
            valeur={
              <span className={cout.genre === "estime" ? "" : "text-gray-800"}>
                {cout.libelle}
                {cout.detail && <span className="block text-xs font-normal text-gray-700">{cout.genre === "non-estimable" ? `motif : ${cout.detail}` : cout.detail}</span>}
              </span>
            }
          />
        </dl>
        {ecart?.signale && (
          <p role="note" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
            Écart de longueur signalé par le serveur{ecart.ecartKm !== null ? ` : ${formaterNombre(ecart.ecartKm, 2)} km` : ""}{ecart.ecartRelatif !== null ? ` (${formaterNombre(ecart.ecartRelatif * 100, 1)} %)` : ""}, au-dessus du seuil provisoire du détecteur de qualité. Les deux longueurs sont conservées, aucune n&apos;est corrigée.
          </p>
        )}
        {c && (
          <p className="text-xs text-gray-700">
            {c.traitement ? `Traitement : ${c.traitement}. ` : ""}{c.classePrecision ? `Précision : ${c.classePrecision}${c.margePct !== null ? ` (marge ${formaterNombre(c.margePct, 0)} %)` : ""}. ` : ""}
            {c.bareme ? `Barème ${c.bareme.version !== null ? `v${c.bareme.version}` : ""} ${c.bareme.approuve === false ? "non approuvé" : c.bareme.approuve === true ? "approuvé" : ""}. ` : ""}
            {c.hypothesesManquantes.length > 0 ? `Hypothèses manquantes : ${c.hypothesesManquantes.join(", ")}.` : ""}
          </p>
        )}
        {cout.validite === "perime" && (
          <p role="note" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">Ce coût est périmé : il ne doit pas être lu comme un coût fiable.</p>
        )}
        {f.arbitrage && (
          <p className="text-xs text-gray-700">
            Ordre d&apos;arbitrage coût/impact (distinct de la priorité technique) : {f.arbitrage.rang !== null ? `rang ${f.arbitrage.rang}` : `non classé${f.arbitrage.motifAbsence ? ` (${f.arbitrage.motifAbsence})` : ""}`}.
          </p>
        )}
      </Section>

      <Section titre="Limites de l'analyse">
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-800">
          {(f.limites ?? []).map((l) => <li key={l}>{l}</li>)}
          {f.limites === null && <li>Le serveur ne fournit pas de limites propres à cette intervention.</li>}
          <li>Consultatif, non engageant : {f.avertissement ?? "la priorité est calculée, elle ne remplace ni le jugement de l'ingénieur ni les procédures d'approbation."}</li>
        </ul>
      </Section>

      <Section titre="Historique">
        {f.historique === null ? (
          <p className="text-sm text-gray-800">Historique non fourni par le serveur.</p>
        ) : (
          <div className="space-y-2 text-sm text-gray-900">
            <p>{f.historique.recalculs ? (f.historique.recalculs.disponible ? "Historique des recalculs disponible." : `Historique des recalculs non disponible : ${f.historique.recalculs.raison ?? "raison non fournie"}`) : "Historique des recalculs non fourni."}</p>
            {f.historique.decisions.length === 0 ? (
              <p>Aucune décision humaine enregistrée pour cette intervention.</p>
            ) : (
              <ol className="space-y-1">
                {f.historique.decisions.map((d, i) => (
                  <li key={`${d.enregistreLe ?? "?"}-${i}`}>
                    <span className="text-xs text-gray-700">{formaterDate(d.enregistreLe) ?? "date inconnue"}</span>
                    <br />
                    {d.de ?? "?"} vers {d.vers ?? "?"}{d.motif ? ` : ${d.motif}` : ""}
                  </li>
                ))}
              </ol>
            )}
            {f.historique.parametres.length > 0 && (
              <p className="text-xs text-gray-700">
                Versions de paramètres : {f.historique.parametres.map((p) => `${p.version}${p.utilisee ? " (utilisée)" : ""}${p.approuveeLe ? "" : " (non approuvée)"}`).join(", ")}.
              </p>
            )}
            {f.fichesFigees.length > 0 && <p className="text-xs text-gray-700">Fiches figées : {f.fichesFigees.map((x) => `${x.reference ?? x.id}${x.statut ? ` (${x.statut})` : ""}`).join(", ")}.</p>}
          </div>
        )}
      </Section>

      <Section titre="Actions possibles">
        {f.actions === null ? (
          <p className="text-sm text-gray-800">Le serveur ne fournit pas d&apos;actions pour cette intervention.</p>
        ) : f.actions.disponibles.length === 0 ? (
          <div className="space-y-1 text-sm text-gray-800">
            <p>Aucune action possible : {f.actions.raison ?? "raison non fournie par le serveur"}</p>
            {f.actions.nonDisponibles.length > 0 && <p className="text-xs text-gray-700">Non disponibles : {f.actions.nonDisponibles.map((a) => a.replace(/_/g, " ")).join(", ")}.</p>}
          </div>
        ) : (
          <>
            <ul className="space-y-1 text-sm">{f.actions.disponibles.map((a) => <li key={a} className="font-medium text-gray-900">{a.replace(/_/g, " ")}</li>)}</ul>
            <p className="text-xs text-gray-700">Liste donnée par le serveur ; aucune de ces actions n&apos;est exécutée depuis cet écran.</p>
          </>
        )}
      </Section>

      <p className="border-t border-gray-100 pt-2 text-xs text-gray-700">
        Modèle {f.versionModele ?? "non renseigné"} · paramètres {f.versionParametres ?? "non renseignés"}
        {f.exclusion ? ` · exclusion : ${libelleExclusion(f.exclusion.code)}` : ""}
      </p>
    </aside>
  );
});
