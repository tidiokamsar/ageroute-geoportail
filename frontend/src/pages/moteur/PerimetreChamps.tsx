import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ParametresVersion } from "../../lib/moteurProgrammation";
import type { Region } from "../../types";

/**
 * Champs communs au scenario annuel et au plan pluriannuel : perimetre (region, classe de route) et version des
 * parametres. « Choix automatique » laisse le serveur designer la version (approuvee la plus recente, sinon l'unique) ;
 * avec plusieurs versions provisoires et aucune approuvee, il REFUSE de choisir : l'ecran ne choisit pas a sa place.
 */

export const CLASSES_ROUTE = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] as const;

export function useParametresMoteur() {
  return useQuery({
    queryKey: ["v2", "moteur", "parametres"],
    queryFn: async () => (await api.get<{ data: ParametresVersion[] }>("/v2/programmation/moteur/parametres")).data.data,
  });
}

export interface ChampsPerimetre { regionId: string; classe: string; parametresId: string }
export const PERIMETRE_VIDE: ChampsPerimetre = { regionId: "", classe: "", parametresId: "" };

export function PerimetreChamps({ valeur, onChange, parametres }: { valeur: ChampsPerimetre; onChange: (v: ChampsPerimetre) => void; parametres: ParametresVersion[] }) {
  const idRegion = useId(); const idClasse = useId(); const idParams = useId();
  const regions = useQuery({ queryKey: ["regions"], queryFn: async () => (await api.get<Region[]>("/regions")).data });
  return (
    <>
      <div>
        <label htmlFor={idRegion} className="block text-xs text-gray-700">Région</label>
        <select id={idRegion} value={valeur.regionId} onChange={(e) => onChange({ ...valeur, regionId: e.target.value })} className="rounded border px-2 py-1.5 text-sm">
          <option value="">Toutes les régions</option>
          {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={idClasse} className="block text-xs text-gray-700">Classe de route</label>
        <select id={idClasse} value={valeur.classe} onChange={(e) => onChange({ ...valeur, classe: e.target.value })} className="rounded border px-2 py-1.5 text-sm">
          <option value="">Toutes les classes</option>
          {CLASSES_ROUTE.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={idParams} className="block text-xs text-gray-700">Version des paramètres</label>
        <select id={idParams} value={valeur.parametresId} onChange={(e) => onChange({ ...valeur, parametresId: e.target.value })} className="rounded border px-2 py-1.5 text-sm">
          <option value="">Choix automatique par le serveur</option>
          {parametres.map((p) => <option key={p.id} value={p.id}>{p.version} : {p.etiquette}</option>)}
        </select>
      </div>
    </>
  );
}

/** Corps de requete du perimetre : une saisie vide n'est pas envoyee (aucun filtre), jamais convertie en 0. */
export function corpsPerimetre(p: ChampsPerimetre): { regionId?: number; classe?: string; parametresId?: string } {
  return {
    ...(p.regionId ? { regionId: Number(p.regionId) } : {}),
    ...(p.classe ? { classe: p.classe } : {}),
    ...(p.parametresId ? { parametresId: p.parametresId } : {}),
  };
}
