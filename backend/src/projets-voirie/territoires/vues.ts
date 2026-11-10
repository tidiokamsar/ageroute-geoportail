/**
 * Mise en forme des territoires et des valeurs de referentiel pour l'API (CONTRAT-TERRITOIRES.md, section 7). L'emprise d'un territoire est lue
 * en SQL brut (GeoJSON et boite englobante) : les lignes Prisma ne la portent pas (`Unsupported`).
 */

export interface LigneTerritoire {
  id: string; parentId: string | null; niveau: string; code: string; nom: string; chemin: string; profondeur: number;
  crsMetriqueEpsg: number | null; regionId: number | null; regionEffectiveId: number | null; source: string | null; actif: boolean; version: number;
  creeParId: string | null; createdAt: Date; updatedAt: Date; deletedAt: Date | null;
  creePar?: { id: string; nomComplet: string } | null;
}

/** Emprise lue a part : GeoJSON (objet) et boite englobante, nuls sans emprise. */
export interface EmpriseLue { geojson: unknown | null; bbox: [number, number, number, number] | null; md5: string | null }

/** Vue d'un territoire (fiche, ecritures) : emprise GeoJSON complete et boite englobante. */
export function vueTerritoire(t: LigneTerritoire, emprise: EmpriseLue | null) {
  return { ...vueTerritoireListe(t, emprise), emprise: emprise?.geojson ?? null };
}

/**
 * Vue d'un territoire dans une LISTE (correctifs T1+S1, m2) : boite englobante seulement, jamais l'emprise complete (jusqu'a 10 000 sommets par
 * territoire, 500 territoires par page) ; `aEmprise` dit si la fiche en porte une.
 */
export function vueTerritoireListe(t: LigneTerritoire, emprise: Pick<EmpriseLue, "bbox"> | null) {
  return {
    id: t.id, code: t.code, nom: t.nom, niveau: t.niveau, parentId: t.parentId, chemin: t.chemin, profondeur: t.profondeur,
    regionId: t.regionId, regionEffectiveId: t.regionEffectiveId, crsMetriqueEpsg: t.crsMetriqueEpsg,
    aEmprise: (emprise?.bbox ?? null) !== null, bbox: emprise?.bbox ?? null,
    source: t.source, actif: t.actif, version: t.version,
    creePar: t.creePar ? { id: t.creePar.id, nomComplet: t.creePar.nomComplet } : null,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

/** Resume d'un territoire porte par un projet (liste, fiche). */
export const resumeTerritoire = (t: { id: string; code: string; nom: string; niveau: string } | null | undefined) => (t ? { id: t.id, code: t.code, nom: t.nom, niveau: t.niveau } : null);

/** Ligne d'historique SANS geometrie : la ligne, la boite englobante et l'empreinte de l'emprise. */
export function instantaneTerritoire(t: LigneTerritoire, emprise: EmpriseLue | null): Record<string, unknown> {
  return {
    id: t.id, parentId: t.parentId, niveau: t.niveau, code: t.code, nom: t.nom, chemin: t.chemin, profondeur: t.profondeur,
    crsMetriqueEpsg: t.crsMetriqueEpsg, regionId: t.regionId, regionEffectiveId: t.regionEffectiveId, source: t.source, actif: t.actif,
    version: t.version, deletedAt: t.deletedAt, bbox: emprise?.bbox ?? null, empriseMd5: emprise?.md5 ?? null,
  };
}

export interface LigneReferentiel {
  id: string; domaine: string; code: string; libelle: string; ordre: number; actif: boolean; parametres: unknown; version: number;
  approuveParId: string | null; approuveLe: Date | null; creeParId: string | null; createdAt: Date; updatedAt: Date; deletedAt: Date | null;
  approuvePar?: { id: string; nomComplet: string } | null;
}

export function vueReferentiel(r: LigneReferentiel) {
  return {
    id: r.id, domaine: r.domaine, code: r.code, libelle: r.libelle, ordre: r.ordre, actif: r.actif, parametres: r.parametres, version: r.version,
    systeme: r.creeParId === null, approuvePar: r.approuvePar ? { id: r.approuvePar.id, nomComplet: r.approuvePar.nomComplet } : null, approuveLe: r.approuveLe,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export const instantaneReferentiel = (r: LigneReferentiel): Record<string, unknown> => ({
  id: r.id, domaine: r.domaine, code: r.code, libelle: r.libelle, ordre: r.ordre, actif: r.actif, parametres: r.parametres, version: r.version, deletedAt: r.deletedAt,
});
