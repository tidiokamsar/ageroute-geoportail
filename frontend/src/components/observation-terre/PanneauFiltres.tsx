import { X } from "lucide-react";
import type { SourceObservation } from "../../lib/teledetectionApi";
import { FILTRES_VIDES, intervalleIncoherent, nombreFiltresActifs, type FiltresEcran } from "../../lib/teledetectionFiltres";
import { libelleType, TYPES_CONNUS } from "../../lib/teledetectionAffichage";
import { TronconPicker } from "../TronconPicker";
import { Button } from "../ui/Button";

/**
 * Filtres des propositions : date, source, type, region, troncon, priorite, rattachee ou non.
 * Un filtre dont la liste d'options n'a pas pu etre chargee est desactive et le dit, au lieu de
 * proposer une liste vide.
 */

const CHAMP = "mt-1 block h-11 w-full rounded-md border border-input bg-white px-2 text-sm xl:h-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy";

export function PanneauFiltres({ filtres, onChange, sources, sourcesIndisponibles, regions, regionsIndisponibles }: {
  filtres: FiltresEcran;
  onChange: (f: FiltresEcran) => void;
  sources: SourceObservation[] | undefined;
  sourcesIndisponibles: boolean;
  regions: { id: number; nom: string }[] | undefined;
  regionsIndisponibles: boolean;
}) {
  const maj = (p: Partial<FiltresEcran>) => onChange({ ...filtres, ...p });
  const incoherent = intervalleIncoherent(filtres);

  return (
    <div id="panneau-filtres" role="group" aria-label="Filtres des propositions" className="mt-2 grid grid-cols-1 gap-2 rounded-md border border-gray-200 bg-gray-50 p-3 min-[480px]:grid-cols-2">
      <label className="block text-xs font-medium text-gray-700">
        Source
        <select className={CHAMP} value={filtres.source} disabled={sourcesIndisponibles} onChange={(e) => maj({ source: e.target.value })}>
          <option value="">{sourcesIndisponibles ? "Sources indisponibles" : "Toutes les sources"}</option>
          {sources?.map((s) => <option key={s.code} value={s.code}>{s.nom}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium text-gray-700">
        Type de changement
        <select className={CHAMP} value={filtres.type} onChange={(e) => maj({ type: e.target.value })}>
          <option value="">Tous les types</option>
          {TYPES_CONNUS.map((t) => <option key={t} value={t}>{libelleType(t)}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium text-gray-700">
        Région
        <select className={CHAMP} value={filtres.regionId} disabled={regionsIndisponibles} onChange={(e) => maj({ regionId: e.target.value })}>
          <option value="">{regionsIndisponibles ? "Régions indisponibles" : "Toutes les régions"}</option>
          {regions?.map((r) => <option key={r.id} value={String(r.id)}>{r.nom}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium text-gray-700">
        Priorité
        <select className={CHAMP} value={filtres.priorite} onChange={(e) => maj({ priorite: e.target.value })}>
          <option value="">Toutes les priorités</option>
          <option value="HAUTE">Haute</option>
          <option value="MOYENNE">Moyenne</option>
          <option value="FAIBLE">Faible</option>
        </select>
      </label>
      <label className="block text-xs font-medium text-gray-700">
        Rattachement au tronçon
        <select className={CHAMP} value={filtres.rattachee} onChange={(e) => maj({ rattachee: e.target.value })}>
          <option value="">Rattachées ou non</option>
          <option value="oui">Rattachées à un tronçon</option>
          <option value="non">Anomalies non rattachées</option>
        </select>
      </label>
      <div className="text-xs font-medium text-gray-700">
        {filtres.tronconId ? <p>Tronçon</p> : <label htmlFor="filtre-troncon">Tronçon</label>}
        {filtres.tronconId ? (
          <p className="mt-1 flex min-h-[44px] items-center justify-between gap-2 rounded-md border border-input bg-white px-2 text-sm xl:min-h-9">
            <span className="min-w-0 truncate">{filtres.tronconLibelle || filtres.tronconId}</span>
            <button type="button" aria-label="Retirer le filtre de tronçon" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 xl:h-7 xl:w-7" onClick={() => maj({ tronconId: "", tronconLibelle: "" })}>
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </p>
        ) : (
          <div className="mt-1">
            <TronconPicker id="filtre-troncon" value={undefined} onChange={() => {}} onChoisirObjet={(t) => maj({ tronconId: t.id, tronconLibelle: `${t.code} — ${t.nom}` })} />
          </div>
        )}
      </div>
      <label className="block text-xs font-medium text-gray-700">
        Observée à partir du
        <input type="date" className={CHAMP} value={filtres.depuis} max={filtres.jusqua || undefined} onChange={(e) => maj({ depuis: e.target.value })} />
      </label>
      <label className="block text-xs font-medium text-gray-700">
        Observée jusqu&apos;au
        <input type="date" className={CHAMP} value={filtres.jusqua} min={filtres.depuis || undefined} onChange={(e) => maj({ jusqua: e.target.value })} />
      </label>
      {incoherent && <p role="alert" className="text-xs font-medium text-red-700 min-[480px]:col-span-2">La date de début est postérieure à la date de fin : aucun résultat ne peut correspondre.</p>}
      <div className="min-[480px]:col-span-2">
        <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-0" disabled={nombreFiltresActifs(filtres) === 0} onClick={() => onChange(FILTRES_VIDES)}>
          Réinitialiser les filtres
        </Button>
      </div>
    </div>
  );
}
