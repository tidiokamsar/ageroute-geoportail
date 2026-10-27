import { useId, useState } from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import {
  CLASSES_ROUTE, COUCHES_INDISPONIBLES, ETATS_PHYSIQUES, MODES_VUE, STATUTS_CHANTIER,
  basculerDansListe, couchesPourMode, messageIgnores,
  type CouchesCarte, type ModeVue,
} from "../../../lib/aideDecisionCarte";
import { FILTRES_INDISPONIBLES, nombreFiltresActifs } from "../../../lib/decision";
import { ecranEtroit } from "../../../pages/geoportail/affichageTroncon";
import type { FiltresDecision } from "../types";
import { FONDS, type CleFond } from "./fonds";
import { LIBELLE_COUCHE, type CouchesContexte, type EtatCouche } from "./useCouchesContexte";

/**
 * Panneau « Filtres de la carte » : type d'affichage, donnees a afficher, niveau geographique, region, classe, etat, statut de chantier,
 * periode, fond de carte. Les filtres partages (`FiltresDecision`) sont ceux de TOUS les onglets (AD-11) : changer un filtre ici change la
 * liste, la carte et la fiche ensemble.
 *
 * CE QUI N'EST PAS DISPONIBLE EST DIT : prefecture, axe, bailleur, gravite, type d'intervention (donnees non structurees, contrat paragraphe 3),
 * vues Chantiers et Budget, limites regionales. Chaque controle est DESACTIVE avec sa raison, relie par `aria-describedby` : on ne retire rien
 * en silence, et aucune vue vide ne laisse croire a l'absence de donnees.
 *
 * La periode agit sur les INTERVENTIONS (c'est le serveur qui la lit) ; elle ne filtre pas le trace du reseau. Le panneau le dit.
 */

interface Props {
  mode: ModeVue;
  onMode: (m: ModeVue) => void;
  couches: CouchesCarte;
  onCouches: (c: CouchesCarte) => void;
  filtres: FiltresDecision;
  onFiltres: (f: FiltresDecision) => void;
  regions: { id: number; nom: string }[] | undefined;
  regionsEnErreur: boolean;
  fond: CleFond;
  onFond: (f: CleFond) => void;
  contexte: CouchesContexte;
}

const CASE = "h-5 w-5 shrink-0 accent-navy";
const LIGNE = "flex min-h-11 cursor-pointer items-center gap-2 xl:min-h-8";
// Deux constantes plutot qu'un ternaire de litteraux : le test de contraste (test/contraste.ts) lit une chaine par ligne et prendrait
// le blanc du choix actif pour le texte du choix inactif (faux positif « gray-800 sur navy »).
const FOND_ACTIF = "border-navy bg-navy text-white";
const FOND_INACTIF = "border-gray-300 text-gray-800 hover:bg-gray-50";
const TITRE_GROUPE = "text-xs font-semibold uppercase tracking-wide text-gray-700";
const CHAMP = "h-11 w-full rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 xl:h-9";

function StatutCouche({ etat, couche }: { etat: EtatCouche<unknown>; couche: boolean }) {
  if (!couche) return null;
  if (etat.statut === "chargement") return <span className="text-xs text-gray-700">Chargement…</span>;
  if (etat.statut === "erreur") {
    return (
      <span role="alert" className="block text-xs text-red-700">
        {etat.message ?? "Chargement impossible."}{" "}
        {!etat.invalide && <button type="button" onClick={etat.reessayer} className="min-h-11 font-medium underline xl:min-h-0">Réessayer</button>}
      </span>
    );
  }
  if (etat.statut !== "pret") return null;
  return etat.ignores > 0 ? <span className="block text-xs font-medium text-amber-900">{messageIgnores(etat.ignores)}</span> : null;
}

export function PanneauFiltresCarte(p: Props) {
  const { mode, onMode, couches, onCouches, filtres, onFiltres, regions, regionsEnErreur, fond, onFond, contexte } = p;
  const id = useId();
  const [ouvert, setOuvert] = useState(() => !ecranEtroit());
  const actifs = nombreFiltresActifs(filtres);
  const maj = (suite: Partial<FiltresDecision>) => onFiltres({ ...filtres, ...suite });
  const bascule = (cle: keyof CouchesCarte) => onCouches({ ...couches, [cle]: !couches[cle] });

  const lignesCouches: { cle: keyof CouchesCarte; libelle: string; etat?: EtatCouche<unknown> }[] = [
    { cle: "reseau", libelle: `${LIBELLE_COUCHE.reseau}${mode === "etat" ? " (coloré par l'état physique)" : " (fond gris)"}`, etat: contexte.reseau },
    { cle: "priorites", libelle: "Priorités (interventions)" },
    { cle: "chantiers", libelle: LIBELLE_COUCHE.chantiers, etat: contexte.chantiers },
    { cle: "ouvrages", libelle: LIBELLE_COUCHE.ouvrages, etat: contexte.ouvrages },
    { cle: "pointsNoirs", libelle: LIBELLE_COUCHE.pointsNoirs, etat: contexte.pointsNoirs },
    { cle: "limites", libelle: `${LIBELLE_COUCHE.limites} (repère simplifié)`, etat: contexte.limites },
  ];

  return (
    <section aria-labelledby={`${id}-titre`} className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 px-3">
        <h2 id={`${id}-titre`} className="min-w-0 flex-1 text-sm font-semibold text-navy">
          <button
            type="button"
            aria-expanded={ouvert}
            aria-controls={`${id}-corps`}
            onClick={() => setOuvert((o) => !o)}
            className="flex min-h-11 w-full items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">Filtres de la carte</span>
            {actifs > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{actifs} actif{actifs > 1 ? "s" : ""}</span>}
            {ouvert ? <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />}
          </button>
        </h2>
        <button
          type="button"
          onClick={() => onFiltres({})}
          disabled={actifs === 0}
          aria-label="Réinitialiser les filtres de la carte"
          className="min-h-11 shrink-0 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-navy hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8"
        >
          Réinitialiser
        </button>
      </div>

      {ouvert && (
        <div id={`${id}-corps`} className="space-y-4 border-t border-gray-100 px-3 py-3 text-sm text-gray-900">
          <fieldset>
            <legend className={TITRE_GROUPE}>Type d&apos;affichage</legend>
            <div className="mt-1 space-y-0.5">
              {MODES_VUE.map((m) => (
                <div key={m.id}>
                  <label className={`${LIGNE} ${m.disponible ? "" : "cursor-not-allowed text-gray-700"}`}>
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      className={CASE}
                      checked={mode === m.id}
                      disabled={!m.disponible}
                      aria-describedby={m.disponible ? undefined : `${id}-mode-${m.id}`}
                      onChange={() => { onMode(m.id); onCouches(couchesPourMode(m.id, couches)); }}
                    />
                    {m.libelle}
                    {!m.disponible && <span className="text-xs">(non disponible)</span>}
                  </label>
                  {!m.disponible && <p id={`${id}-mode-${m.id}`} className="pl-7 text-xs text-gray-700">Non disponible : {m.raison}.</p>}
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>Données à afficher</legend>
            <div className="mt-1 space-y-0.5">
              {lignesCouches.map((l) => (
                <div key={l.cle}>
                  <label className={LIGNE}>
                    <input type="checkbox" className={CASE} checked={couches[l.cle]} onChange={() => bascule(l.cle)} />
                    {l.libelle}
                  </label>
                  <div className="pl-7" aria-live="polite">{l.etat && <StatutCouche etat={l.etat} couche={couches[l.cle]} />}</div>
                </div>
              ))}
              {COUCHES_INDISPONIBLES.map((c) => (
                <div key={c.cle}>
                  <label className={`${LIGNE} cursor-not-allowed text-gray-700`}>
                    <input type="checkbox" className={CASE} checked={false} disabled aria-describedby={`${id}-${c.cle}`} onChange={() => undefined} />
                    {c.libelle}
                  </label>
                  <p id={`${id}-${c.cle}`} className="pl-7 text-xs text-gray-700">{c.raison.replace(/^./, (x) => x.toUpperCase())}.</p>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>Niveau géographique</legend>
            <div className="mt-1 space-y-2">
              <div>
                <label htmlFor={`${id}-region`} className="mb-0.5 block text-xs text-gray-800">Région</label>
                <select
                  id={`${id}-region`}
                  className={CHAMP}
                  value={filtres.regionId ?? ""}
                  onChange={(e) => maj({ regionId: e.target.value === "" ? undefined : Number(e.target.value) })}
                >
                  <option value="">Tout le pays</option>
                  {regions?.map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
                </select>
                {regionsEnErreur && <p role="alert" className="mt-0.5 text-xs text-red-700">Liste des régions indisponible : le filtre de région n&apos;est pas proposé.</p>}
              </div>
              {FILTRES_INDISPONIBLES.filter((f) => f.cle === "prefecture" || f.cle === "axe").map((f) => (
                <div key={f.cle}>
                  <label htmlFor={`${id}-${f.cle}`} className="mb-0.5 block text-xs text-gray-700">{f.libelle}</label>
                  <select id={`${id}-${f.cle}`} className={`${CHAMP} cursor-not-allowed bg-gray-100 text-gray-700`} disabled aria-describedby={`${id}-${f.cle}-raison`}>
                    <option>Non disponible</option>
                  </select>
                  <p id={`${id}-${f.cle}-raison`} className="mt-0.5 text-xs text-gray-700">Non disponible : {f.raison}.</p>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>Classe de route</legend>
            <div className="mt-1 space-y-0.5">
              {CLASSES_ROUTE.map((c) => (
                <label key={c.code} className={LIGNE}>
                  <input type="checkbox" className={CASE} checked={filtres.classe?.includes(c.code) ?? false} onChange={() => maj({ classe: basculerDansListe(filtres.classe, c.code) })} />
                  {c.libelle}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>État physique</legend>
            <div className="mt-1 space-y-0.5">
              {ETATS_PHYSIQUES.map((e) => (
                <label key={e.code} className={LIGNE}>
                  <input type="checkbox" className={CASE} checked={filtres.etat?.includes(e.code) ?? false} onChange={() => maj({ etat: basculerDansListe(filtres.etat, e.code) })} />
                  {e.libelle}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>Statut des chantiers</legend>
            <div className="mt-1 space-y-0.5">
              {STATUTS_CHANTIER.map((c) => (
                <label key={c.code} className={LIGNE}>
                  <input type="checkbox" className={CASE} checked={filtres.statutChantier?.includes(c.code) ?? false} onChange={() => maj({ statutChantier: basculerDansListe(filtres.statutChantier, c.code) })} />
                  {c.libelle}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-700">Ce filtre agit sur la couche Chantiers seulement : le serveur ne l'applique pas aux interventions (aucun lien structuré entre une intervention et un chantier).</p>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>Période de référence</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={`${id}-depuis`} className="mb-0.5 block text-xs text-gray-800">Du</label>
                <input id={`${id}-depuis`} type="date" className={CHAMP} value={filtres.depuis ?? ""} max={filtres.jusqua || undefined} onChange={(e) => maj({ depuis: e.target.value || undefined })} />
              </div>
              <div>
                <label htmlFor={`${id}-jusqua`} className="mb-0.5 block text-xs text-gray-800">Au</label>
                <input id={`${id}-jusqua`} type="date" className={CHAMP} value={filtres.jusqua ?? ""} min={filtres.depuis || undefined} onChange={(e) => maj({ jusqua: e.target.value || undefined })} />
              </div>
            </div>
            <p className="mt-1 text-xs text-gray-700">La période s&apos;applique aux interventions (liste, carte, constats), pas au tracé du réseau.</p>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>Autres filtres</legend>
            <div className="mt-1 space-y-2">
              {FILTRES_INDISPONIBLES.filter((f) => f.cle !== "prefecture" && f.cle !== "axe").map((f) => (
                <div key={f.cle}>
                  <label htmlFor={`${id}-${f.cle}`} className="mb-0.5 block text-xs text-gray-700">{f.libelle}</label>
                  <select id={`${id}-${f.cle}`} className={`${CHAMP} cursor-not-allowed bg-gray-100 text-gray-700`} disabled aria-describedby={`${id}-${f.cle}-raison`}>
                    <option>Non disponible</option>
                  </select>
                  <p id={`${id}-${f.cle}-raison`} className="mt-0.5 text-xs text-gray-700">Non disponible : {f.raison}.</p>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className={TITRE_GROUPE}>Fond de carte</legend>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {(Object.keys(FONDS) as CleFond[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={fond === k}
                  onClick={() => onFond(k)}
                  className={`min-h-11 rounded-md border px-1.5 text-center text-xs leading-tight xl:min-h-9 ${fond === k ? FOND_ACTIF : FOND_INACTIF}`}
                >
                  {FONDS[k].label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </section>
  );
}
