import { lazy, Suspense, useId } from "react";
import { Input } from "../../ui/Input";
import { CHAMP_TEXTE } from "../CadreDialogue";
import { EtatChargement } from "../EtatsPv";
import { empriseDepuisSaisie, formaterBbox, type EmpriseGeoJson, type ModeEmprise, type SaisieEmprise } from "../../../lib/projetsVoirieTerritoires";
import type { Bbox } from "../../../lib/projetsVoirie";

// Leaflet ne se charge que si l'administrateur choisit de dessiner.
const CarteEmprise = lazy(() => import("./CarteEmprise").then((m) => ({ default: m.CarteEmprise })));

/**
 * Emprise OPTIONNELLE et APPROXIMATIVE d'un territoire : aucune, rectangle par ses quatre bornes, GeoJSON colle, ou rectangle dessine sur la carte.
 * Le serveur valide la geometrie (PostGIS, 422 EMPRISE_INVALIDE) et avertit sans refuser si elle deborde du parent ou de l'emprise nationale.
 */
export function EditeurEmprise({ saisie, onChange, modification, actuelle, bboxActuelle, parent, cadrage, desactive }: {
  saisie: SaisieEmprise; onChange: (s: SaisieEmprise) => void; modification: boolean;
  actuelle: EmpriseGeoJson | null; bboxActuelle: Bbox | null; parent: Bbox | null; cadrage: Bbox | null; desactive?: boolean;
}) {
  const id = useId();
  const r = empriseDepuisSaisie(saisie);
  const modes: { m: ModeEmprise; libelle: string }[] = [
    ...(modification ? [{ m: "conserver" as const, libelle: bboxActuelle ? `Conserver l'emprise actuelle (${formaterBbox(bboxActuelle)})` : "Conserver l'état actuel (aucune emprise)" }] : []),
    { m: "aucune", libelle: modification ? "Retirer l'emprise" : "Aucune emprise" },
    { m: "bornes", libelle: "Rectangle par ses quatre bornes" },
    { m: "geojson", libelle: "Coller un GeoJSON (Polygon ou MultiPolygon)" },
    { m: "carte", libelle: "Dessiner un rectangle sur la carte" },
  ];
  const maj = (p: Partial<SaisieEmprise>) => onChange({ ...saisie, ...p });
  return (
    <fieldset className="space-y-2 rounded border border-gray-300 p-2" aria-describedby={`${id}-aide`}>
      <legend className="px-1 text-sm font-medium text-gray-900">Emprise (facultative, approximative)</legend>
      <p id={`${id}-aide`} className="text-xs text-gray-700">En degrés WGS 84, longitude puis latitude. L&apos;emprise d&apos;un territoire ne fait que signaler les éléments déposés en dehors ; seule l&apos;emprise nationale les écarte.</p>
      {modes.map((x) => (
        <label key={x.m} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
          <input type="radio" name={`${id}-mode`} className="h-4 w-4" checked={saisie.mode === x.m} disabled={desactive} onChange={() => maj({ mode: x.m })} />{x.libelle}
        </label>
      ))}
      {saisie.mode === "bornes" && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["ouest", "sud", "est", "nord"] as const).map((k) => (
            <div key={k}>
              <label htmlFor={`${id}-${k}`} className="block text-xs font-medium text-gray-900">{k === "ouest" ? "Ouest (longitude min.)" : k === "est" ? "Est (longitude max.)" : k === "sud" ? "Sud (latitude min.)" : "Nord (latitude max.)"}</label>
              <Input id={`${id}-${k}`} inputMode="decimal" value={saisie[k]} onChange={(e) => maj({ [k]: e.target.value } as Partial<SaisieEmprise>)} autoComplete="off" disabled={desactive} className="mt-0.5 border-gray-300" />
            </div>
          ))}
        </div>
      )}
      {saisie.mode === "geojson" && (
        <div>
          <label htmlFor={`${id}-geo`} className="block text-xs font-medium text-gray-900">GeoJSON de l&apos;emprise</label>
          <textarea id={`${id}-geo`} value={saisie.texte} onChange={(e) => maj({ texte: e.target.value })} rows={6} spellCheck={false} disabled={desactive} className={`${CHAMP_TEXTE} font-mono text-xs`} />
        </div>
      )}
      {saisie.mode === "carte" && (
        <Suspense fallback={<EtatChargement libelle="Chargement de la carte…" />}>
          <CarteEmprise actuelle={actuelle} parent={parent} cadrage={bboxActuelle ?? parent ?? cadrage} dessin={saisie.dessin} onDessin={(b) => maj({ dessin: b })} />
        </Suspense>
      )}
      {r.erreur && saisie.mode !== "conserver" && saisie.mode !== "aucune" && <p data-testid="erreur-emprise" className="text-xs text-red-700">{r.erreur}</p>}
      {r.bbox && <p className="text-xs text-green-900">Rectangle englobant : {formaterBbox(r.bbox)}.</p>}
    </fieldset>
  );
}
