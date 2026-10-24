import { useId, useState } from "react";
import {
  LIBELLE_EXCLUSION, LIBELLE_FACTEUR, formaterGnf,
  type FacteurTrace, type LigneScenario, type Scenario,
} from "../../lib/moteurProgrammation";

/**
 * Lecture d'un scenario LIGNE PAR LIGNE, avec sa justification : entrees, facteurs, formules, version des
 * parametres, motif d'exclusion. Aucune valeur n'est calculee ici : tout vient du resultat du moteur.
 */

const PAS = 25;

function Facteurs({ facteurs }: { facteurs: FacteurTrace[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Facteurs du risque</caption>
        <thead className="uppercase text-gray-600">
          <tr><th scope="col" className="py-1 pr-2">Facteur</th><th scope="col" className="pr-2">Poids</th><th scope="col" className="pr-2">Disponible</th><th scope="col" className="pr-2">Valeur (0 à 100)</th><th scope="col" className="pr-2">Donnée brute</th><th scope="col">Origine et note</th></tr>
        </thead>
        <tbody>
          {facteurs.map((f) => (
            <tr key={f.facteur} className="border-t align-top">
              <td className="py-1 pr-2">{LIBELLE_FACTEUR[f.facteur] ?? f.facteur}</td>
              <td className="pr-2 tabular-nums">{f.poids}</td>
              <td className="pr-2">{f.disponible ? "oui" : "non"}</td>
              <td className="pr-2 tabular-nums">{f.valeur === null ? "absent" : f.valeur}</td>
              <td className="pr-2">{f.brut === null ? "absent" : String(f.brut)}</td>
              <td>{f.origine ? `${f.origine} : ` : ""}{f.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bloc({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h5 className="text-xs font-semibold uppercase text-gray-600">{titre}</h5>
      {children}
    </section>
  );
}

export function DetailLigne({ ligne, parametres }: { ligne: LigneScenario; parametres: Scenario["parametres"] }) {
  const t = ligne.troncon;
  return (
    <div className="space-y-3 text-sm" data-testid={`detail-${t.code}`}>
      <p className="rounded bg-gray-50 p-2 text-gray-800">{ligne.justification}</p>

      <Bloc titre="Entrées">
        <p>
          Tronçon {t.code}{t.nom ? ` (${t.nom})` : ""} · région {t.regionId ?? "non renseignée"} · classe {t.classe ?? "non renseignée"} · revêtement {t.revetement ?? "non renseigné"} · état {t.etat ?? "non renseigné"}
        </p>
        <p>
          Longueur : {t.longueurM === null ? "non renseignée" : `${t.longueurM.toLocaleString("fr-FR")} m`}
          {t.longueurOrigine === "GEOMETRIE" ? " (calculée sur la géométrie, non saisie)" : t.longueurOrigine === "LONGUEUR_KM" ? " (colonne longueur du tronçon)" : ""}
        </p>
      </Bloc>

      <Bloc titre="Risque">
        {ligne.risque.ok ? (
          <>
            <p>Score {ligne.risque.score} sur 100 · {ligne.risque.facteursDisponibles} facteur(s) disponible(s) sur {ligne.risque.facteursPonderes} pondérés · couverture du poids {ligne.risque.couverture}</p>
            <p className="text-xs text-gray-700">Formule : {ligne.risque.formule}</p>
          </>
        ) : (
          <p role="note" className="text-amber-900">Risque non calculé ({ligne.risque.code}) : {ligne.risque.motif}</p>
        )}
        <Facteurs facteurs={ligne.risque.facteurs} />
      </Bloc>

      {ligne.risqueAttendu && (
        <Bloc titre="Risque attendu et projection de dégradation">
          <p>Risque attendu : {ligne.risqueAttendu.score}</p>
          <p className="text-xs text-gray-700">Formule : {ligne.risqueAttendu.formule}</p>
          {ligne.projection?.ok ? (
            <p>
              Projection : {ligne.projection.etatCourant} vers {ligne.projection.etatSuivant ?? "aucun état suivant (CRITIQUE est absorbant)"}, probabilité annuelle {ligne.projection.pAnnuelle}, sur {ligne.projection.horizonAnnees} an(s) : {ligne.projection.pHorizon}. Matrice {ligne.projection.matrice.familleRevetement} / {ligne.projection.matrice.classeTrafic}{ligne.projection.matrice.approuvee ? " (approuvée)" : " (non approuvée)"}.
            </p>
          ) : ligne.projection ? <p>Aucune projection : {ligne.projection.motif}</p> : null}
        </Bloc>
      )}

      {ligne.traitement && (
        <Bloc titre="Traitement">
          {ligne.traitement.ok ? (
            <p>
              {ligne.traitement.traitement.libelle} ({ligne.traitement.traitement.code}, famille {ligne.traitement.traitement.famille}){ligne.traitement.traitement.approuve ? ", approuvé" : ", non approuvé"} · condition {ligne.traitement.condition.portee}
              {ligne.traitement.condition.classeTrafic ? ` (classe de trafic ${ligne.traitement.condition.classeTrafic})` : ""}
              {ligne.traitement.attributsNonRenseignes.length > 0 ? ` · attributs du catalogue non renseignés et non utilisés : ${ligne.traitement.attributsNonRenseignes.join(", ")}` : ""}
            </p>
          ) : <p>Aucun traitement ({ligne.traitement.code}) : {ligne.traitement.motif}</p>}
        </Bloc>
      )}

      {ligne.cout && (
        <Bloc titre="Coût">
          {ligne.cout.ok ? (
            <>
              <p>{formaterGnf(ligne.cout.montantGnf)} · classe de précision {ligne.cout.classePrecision}{ligne.cout.margePct !== null ? ` (plus ou moins ${ligne.cout.margePct} %)` : ""}{ligne.cout.provisoire ? " · provisoire" : ""}</p>
              <p className="text-xs text-gray-700">Calcul : {ligne.cout.calcul}</p>
              <p className="text-xs text-gray-700">
                Barème {ligne.cout.bareme.code ?? `n° ${ligne.cout.bareme.id}`} ({ligne.cout.bareme.typeIntervention}) : {formaterGnf(ligne.cout.bareme.coutKmGnf)} par km, millésime {ligne.cout.bareme.anneeReference ?? "non renseigné"}, largeur {ligne.cout.bareme.largeurChausseeM ?? "non renseignée"}, {ligne.cout.bareme.approuve ? "approuvé" : "non approuvé"}.
                {ligne.cout.hypothesesManquantes.length > 0 ? ` Hypothèses manquantes : ${ligne.cout.hypothesesManquantes.join(", ")}.` : ""}
              </p>
            </>
          ) : <p>Coût non estimé ({ligne.cout.code}) : {ligne.cout.motif}</p>}
        </Bloc>
      )}

      {ligne.priorite && (
        <Bloc titre="Priorité et enveloppe">
          <p>Rang de priorité {ligne.rangPriorite} · {ligne.priorite.ratioPointsParMilliardGnf} point(s) de risque par milliard de GNF</p>
          <p className="text-xs text-gray-700">Formule : {ligne.priorite.formule}</p>
          {ligne.budget && <p>Reste de l'enveloppe : {formaterGnf(ligne.budget.resteAvantGnf)} avant, {formaterGnf(ligne.budget.resteApresGnf)} après.</p>}
        </Bloc>
      )}

      {ligne.motifExclusion && (
        <Bloc titre="Motif d'exclusion">
          <p><strong>{LIBELLE_EXCLUSION[ligne.motifExclusion.code] ?? ligne.motifExclusion.code}</strong> ({ligne.motifExclusion.code}) : {ligne.motifExclusion.detail}</p>
        </Bloc>
      )}

      <Bloc titre="Version des paramètres">
        <p>{parametres.version} (source {parametres.source}) · <strong>{ligne.etiquette}</strong></p>
      </Bloc>
    </div>
  );
}

type Filtre = "TOUTES" | "RETENUE" | "ECARTEE";

export function LignesScenario({ lignes, parametres, titre }: { lignes: LigneScenario[]; parametres: Scenario["parametres"]; titre: string }) {
  const idFiltre = useId();
  const [filtre, setFiltre] = useState<Filtre>("TOUTES");
  const [affiches, setAffiches] = useState(PAS);
  const [ouverte, setOuverte] = useState<string | null>(null);

  const visibles = lignes.filter((l) => filtre === "TOUTES" || l.decision === filtre);
  const montres = visibles.slice(0, affiches);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={idFiltre} className="block text-xs text-gray-700">Lignes à afficher</label>
          <select id={idFiltre} value={filtre} onChange={(e) => { setFiltre(e.target.value as Filtre); setAffiches(PAS); }} className="rounded border px-2 py-1 text-sm">
            <option value="TOUTES">Toutes ({lignes.length})</option>
            <option value="RETENUE">Retenues ({lignes.filter((l) => l.decision === "RETENUE").length})</option>
            <option value="ECARTEE">Écartées ({lignes.filter((l) => l.decision === "ECARTEE").length})</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{titre}</caption>
          <thead className="text-xs uppercase text-gray-600">
            <tr>
              <th scope="col" className="py-1 pr-2">Rang</th><th scope="col" className="pr-2">Tronçon</th><th scope="col" className="pr-2">Décision</th>
              <th scope="col" className="pr-2">Risque</th><th scope="col" className="pr-2">Coût</th><th scope="col" className="pr-2">Traitement</th>
              <th scope="col" className="pr-2">Motif</th><th scope="col"><span className="sr-only">Justification</span></th>
            </tr>
          </thead>
          <tbody>
            {montres.map((l) => {
              const cle = l.troncon.id;
              const ouvert = ouverte === cle;
              return (
                <RangeeLigne key={cle} l={l} ouvert={ouvert} parametres={parametres} basculer={() => setOuverte(ouvert ? null : cle)} />
              );
            })}
          </tbody>
        </table>
      </div>
      {visibles.length === 0 && <p className="text-sm text-gray-700">Aucune ligne pour ce filtre.</p>}
      {visibles.length > montres.length && (
        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => setAffiches(affiches + PAS)}>
          Afficher {Math.min(PAS, visibles.length - montres.length)} ligne(s) de plus ({montres.length} sur {visibles.length})
        </button>
      )}
    </div>
  );
}

function RangeeLigne({ l, ouvert, basculer, parametres }: { l: LigneScenario; ouvert: boolean; basculer: () => void; parametres: Scenario["parametres"] }) {
  const id = useId();
  return (
    <>
      <tr className="border-t align-top">
        <td className="py-1 pr-2 tabular-nums">{l.rangRetenu ?? (l.rangPriorite !== null ? `(${l.rangPriorite})` : "")}</td>
        <td className="pr-2">{l.troncon.code}{l.troncon.nom ? <span className="block text-xs text-gray-600">{l.troncon.nom}</span> : null}</td>
        <td className="pr-2">
          <span className={l.decision === "RETENUE" ? "font-semibold text-green-800" : "text-gray-800"}>{l.decision === "RETENUE" ? "Retenue" : "Écartée"}</span>
        </td>
        <td className="pr-2 tabular-nums">{l.risque.ok ? l.risque.score : "non calculé"}</td>
        <td className="pr-2 tabular-nums whitespace-nowrap">{l.cout?.ok ? formaterGnf(l.cout.montantGnf) : "non estimé"}</td>
        <td className="pr-2">{l.traitement?.ok ? l.traitement.traitement.code : "aucun"}</td>
        <td className="pr-2 text-xs">{l.motifExclusion ? (LIBELLE_EXCLUSION[l.motifExclusion.code] ?? l.motifExclusion.code) : ""}</td>
        <td>
          <button type="button" aria-expanded={ouvert} aria-controls={id} className="rounded border px-2 py-0.5 text-xs" onClick={basculer}>
            {ouvert ? "Masquer" : "Justification"}<span className="sr-only"> de {l.troncon.code}</span>
          </button>
        </td>
      </tr>
      {ouvert && (
        <tr id={id} className="bg-white">
          <td colSpan={8} className="p-3"><DetailLigne ligne={l} parametres={parametres} /></td>
        </tr>
      )}
    </>
  );
}
