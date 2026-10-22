import { useEffect, useMemo, useState } from "react";
import { symbole } from "../../features/geoportail/map/symbology";
import {
  aujourdhui, avertissements, bornes, decaler, etiquetteJour, indexVersJour, jourValide, jourVersIndex,
  messageVide, resume, type Chronologie, type EtatCurseur,
} from "../../lib/curseur";
import { ZOOM_MINIMUM_CURSEUR, type EtatCouchePortions } from "./PortionsDateLayer";

/**
 * Le panneau du curseur temporel : voir le réseau à une date.
 *
 * CE QUE LE PANNEAU DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * Que l'état montré est celui des PORTIONS à cette date, pas celui du tronçon aujourd'hui ; que le
 * tracé gris est une géométrie sans état ; qu'il n'y a pas de dates futures ; et, quand l'écran est
 * vide, POURQUOI : « personne n'a saisi la date d'effet » n'est pas « le réseau était vide ».
 *
 * Le curseur propose des dates au jour près, avec un champ de date pour y aller directement :
 * faire glisser un curseur sur trois cents jours ne se fait pas au doigt en bord de route.
 */

/** Pas des boutons de décalage : trente jours, un mois à peu près. Choix d'interface, non métier. */
const PAS_MOIS_JOURS = 30;

/** Délai avant de relancer le chargement pendant qu'on fait glisser le curseur. */
const DELAI_GLISSEMENT_MS = 250;

export function CurseurTemporel({
  etat, onChange, chronologie, couche, chargementChronologie, erreurChronologie, auj = aujourdhui(),
}: {
  etat: EtatCurseur;
  onChange: (e: EtatCurseur) => void;
  chronologie: Chronologie | undefined;
  couche: EtatCouchePortions | null;
  chargementChronologie?: boolean;
  erreurChronologie?: string | null;
  auj?: string;
}) {
  const b = useMemo(() => bornes(chronologie, auj), [chronologie, auj]);

  // Pendant qu'on fait glisser, on ne recharge pas à chaque jour traversé.
  const [local, setLocal] = useState(etat.date);
  useEffect(() => { setLocal(etat.date); }, [etat.date]);
  useEffect(() => {
    if (!etat.actif || local === etat.date || !jourValide(local)) return;
    const t = setTimeout(() => onChange({ ...etat, date: local }), DELAI_GLISSEMENT_MS);
    return () => clearTimeout(t);
  }, [local]); // eslint-disable-line react-hooks/exhaustive-deps

  const reponse = couche?.reponse ?? null;
  const vide = messageVide(chronologie, reponse);
  const avis = avertissements(chronologie, reponse);

  const etatsPresents = useMemo(() => {
    const vus = new Map<string, string>();
    for (const p of reponse?.portions ?? []) {
      const code = p.etat ?? "";
      if (!vus.has(code)) vus.set(code, p.etatLibelle ?? p.etat ?? "Non qualifié");
    }
    return [...vus.entries()];
  }, [reponse]);

  function activer(actif: boolean) {
    onChange(actif ? { ...etat, actif: true, date: etat.date || auj } : { ...etat, actif: false });
  }
  const aller = (date: string) => { setLocal(date); onChange({ ...etat, date }); };

  return (
    <div className="space-y-2.5 text-sm">
      <label className="flex cursor-pointer items-start gap-2 font-medium text-navy" htmlFor="curseur-actif">
        <input
          id="curseur-actif" type="checkbox" className="mt-0.5 h-4 w-4"
          checked={etat.actif} onChange={(e) => activer(e.target.checked)}
        />
        <span>Voir le réseau à une date</span>
      </label>

      {!etat.actif && (
        <p className="text-xs leading-snug text-gray-500">
          Montre l'état des portions tel qu'il était vrai sur le terrain à la date choisie.
        </p>
      )}

      {etat.actif && (
        <>
          <div>
            <label className="block text-xs font-semibold text-gray-600" htmlFor="curseur-glisseur">
              Date de terrain : <span className="text-navy">{etiquetteJour(local)}</span>
            </label>
            <input
              id="curseur-glisseur" type="range" className="mt-1 w-full"
              min={0} max={b.nbJours} step={1} value={jourVersIndex(b, local)}
              aria-valuetext={etiquetteJour(local)}
              onChange={(e) => setLocal(indexVersJour(b, Number(e.target.value)))}
            />
            <div className="flex justify-between text-[10px] text-gray-500" aria-hidden="true">
              <span>{etiquetteJour(b.min)}</span>
              <span>aujourd'hui</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button" className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
              onClick={() => aller(decaler(local, -PAS_MOIS_JOURS, b))}
            >
              − 1 mois
            </button>
            <label className="sr-only" htmlFor="curseur-date">Aller à une date</label>
            <input
              id="curseur-date" type="date" className="min-w-0 flex-1 rounded border border-gray-300 px-1.5 py-1 text-xs"
              min={b.min} max={b.max} value={local}
              onChange={(e) => { if (jourValide(e.target.value) && e.target.value <= b.max) aller(e.target.value); }}
            />
            <button
              type="button" className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
              onClick={() => aller(decaler(local, PAS_MOIS_JOURS, b))}
            >
              + 1 mois
            </button>
            <button
              type="button" className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
              onClick={() => aller(b.max)}
            >
              Aujourd'hui
            </button>
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-700" htmlFor="curseur-propositions">
            <input
              id="curseur-propositions" type="checkbox" className="mt-0.5 h-3.5 w-3.5"
              checked={etat.inclureAValider}
              onChange={(e) => onChange({ ...etat, inclureAValider: e.target.checked })}
            />
            <span>Inclure les propositions non validées (trait atténué)</span>
          </label>

          <details className="rounded border border-gray-200 px-2 py-1.5" open={Boolean(etat.connu)}>
            <summary className="cursor-pointer text-xs font-semibold text-gray-600">Ce que l'on savait alors</summary>
            <div className="mt-1.5 space-y-1.5">
              <p className="text-[11px] leading-snug text-gray-500">
                Remonte aussi l'axe du système : l'état tel que les données étaient ENREGISTRÉES et VALIDÉES
                ce jour-là. Une portion saisie ou validée après n'apparaît pas comme telle.
              </p>
              <label className="block text-xs text-gray-700" htmlFor="curseur-connu">
                Tel que connu le
                <input
                  id="curseur-connu" type="date" className="mt-0.5 block w-full rounded border border-gray-300 px-1.5 py-1 text-xs"
                  max={auj} value={etat.connu ?? ""}
                  onChange={(e) => onChange({ ...etat, connu: jourValide(e.target.value) && e.target.value <= auj ? e.target.value : null })}
                />
              </label>
              {etat.connu && (
                <button type="button" className="text-[11px] text-navy underline" onClick={() => onChange({ ...etat, connu: null })}>
                  Revenir à ce que l'on sait aujourd'hui
                </button>
              )}
            </div>
          </details>

          <div role="status" aria-live="polite" className="space-y-1.5">
            {couche && !couche.zoomSuffisant && (
              <p className="text-xs text-gray-600">Zoomez (niveau {ZOOM_MINIMUM_CURSEUR} ou plus) pour voir les portions.</p>
            )}
            {couche?.chargement && <p className="text-xs text-gray-500">Chargement…</p>}
            {chargementChronologie && !chronologie && <p className="text-xs text-gray-500">Chargement de la chronologie…</p>}
            {reponse && <p className="text-xs font-medium text-navy">{resume(reponse)}</p>}
            {vide && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs leading-snug text-amber-900">{vide}</p>}
          </div>
          {(couche?.erreur ?? erreurChronologie) && (
            <p role="alert" className="text-xs text-red-700">{couche?.erreur ?? erreurChronologie}</p>
          )}

          {avis.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-gray-600" aria-label="Ce que cette vue ne montre pas">
              {avis.map((a) => <li key={a}>{a}</li>)}
            </ul>
          )}

          <ul className="space-y-1 text-[11px] text-gray-700" aria-label="Légende du curseur temporel">
            {etatsPresents.map(([code, libelle]) => {
              const s = symbole(code || null);
              return (
                <li key={code || "—"} className="flex items-center gap-2">
                  <svg width="26" height="8" aria-hidden="true">
                    <line x1="0" y1="4" x2="26" y2="4" stroke={s.trait} strokeWidth="5" strokeDasharray={s.tirets} />
                  </svg>
                  {libelle}
                </li>
              );
            })}
            <li className="flex items-center gap-2 text-gray-500">
              <svg width="26" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="26" y2="4" stroke="#9aa0aa" strokeWidth="3" />
              </svg>
              Tracé de référence : aucune portion connue à cette date
            </li>
          </ul>

          <p className="text-[10px] leading-snug text-gray-500">
            Les couleurs des tronçons sont désactivées : elles montrent l'état d'aujourd'hui, qui n'est
            pas celui de la date choisie. Les dates futures ne sont pas proposées : une carte des années
            à venir suppose des scénarios de programmation, non arrêtés.
          </p>
        </>
      )}
    </div>
  );
}
