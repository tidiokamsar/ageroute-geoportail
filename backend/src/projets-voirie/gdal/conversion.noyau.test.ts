import { describe, expect, it } from "vitest";
import { ErreurLecture } from "../lecture.types";
import { assembler, avertissementsDuConteneur, documentGeoJson, resumer, selectionner, type CoucheLue, type EntreeAssemblage } from "./conversion.noyau";
import { ErreurSortie, LIMITES_COUCHE_DEFAUT, validerCoucheTexte, validerResultat, type AttendusJob, type InventaireDxf } from "./sortie.noyau";
import { DEUX_AXES, SHA_A, ligne, resultatValide, texteCouche } from "./fixtures.gdal";

/** Assemblage du resultat valide : couches du wizard, calques DXF, CRS source, unites, resume SANS geometrie (lot B2). */

const ID = "123e4567-e89b-42d3-a456-426614174000-t1";
const LIM = { sommetsParObjet: 100_000, sommetsParFichier: 2_000_000, objetsMax: 50_000, ...LIMITES_COUCHE_DEFAUT };
const attendus = (format: AttendusJob["format"]): AttendusJob => ({ spoolId: ID, format, sha256: SHA_A, tailleOctets: 1000, objetsMax: 50_000, sortieOctetsMax: 80 * 1024 * 1024 });
const refus = (f: () => unknown): string => { try { f(); } catch (e) { return e instanceof ErreurSortie || e instanceof ErreurLecture ? e.code : `AUTRE:${String(e)}`; } return "AUCUN"; };

function lue(texte: string, o: { dxf?: boolean; octets?: number } = {}): CoucheLue {
  const v = validerCoucheTexte(texte, { limites: LIM, coordonnees: "wgs84", retenir: true, ...(o.dxf ? { grouperPar: "Layer" } : {}) });
  return { v, sha256: "c".repeat(64), octets: o.octets ?? Buffer.byteLength(texte) };
}

function gpkg(over: Partial<EntreeAssemblage> = {}, resultat: Record<string, unknown> = {}): EntreeAssemblage {
  const t = texteCouche(DEUX_AXES);
  return {
    format: "GPKG", resultat: validerResultat(resultatValide({ spoolId: ID, octets: 1000, octetsCouche: Buffer.byteLength(t), ...resultat })), attendus: attendus("GPKG"), parametres: {},
    lues: new Map([["axes", lue(t)]]), insunits: null, uniteCrsSource: null, ...over,
  };
}

const INV_DXF: InventaireDxf = {
  version: "AC1015", codepage: null, entitesSupportees: ["LINE", "LWPOLYLINE", "POLYLINE", "3DPOLYLINE"], lues: { LINE: 2, LWPOLYLINE: 1 },
  ignorees: { TEXT: 1, HATCH: 1, INSERT: 1 }, blocs: { definitions: 1, entitesDansBlocs: 1 },
  calques: [{ nom: "AXES", lues: 2, ignorees: 1 }, { nom: "RESEAU", lues: 1, ignorees: 2 }], nbEntitesTotal: 6,
};

function dxf(over: Partial<EntreeAssemblage> = {}): EntreeAssemblage {
  const t = texteCouche([
    { props: { Layer: "AXES", EntityHandle: "A1" }, geom: ligne([-9, 10.8], [-8.9, 10.8]) }, { props: { Layer: "AXES", EntityHandle: "A2" }, geom: ligne([-9, 10.9], [-8.9, 10.9]) },
    { props: { Layer: "RESEAU", EntityHandle: "A3" }, geom: ligne([-9, 10.7], [-8.9, 10.7]) },
  ]);
  return {
    format: "DXF",
    resultat: validerResultat(resultatValide({ spoolId: ID, format: "DXF", slug: "entities", nbObjets: 3, octetsCouche: Buffer.byteLength(t), octets: 1000, crsSource: { origine: "demande", epsg: 32629, nom: null }, dxf: INV_DXF })),
    attendus: attendus("DXF"), parametres: { epsgSource: 32629, unitesDxf: "metre" }, lues: new Map([["entities", lue(t, { dxf: true })]]), insunits: 6, uniteCrsSource: "metre", ...over,
  };
}

describe("GeoPackage et Shapefile : une couche par fichier converti", () => {
  it("couche du wizard = nom ASCII du conteneur ; comptes, CRS source et attributs repris du résultat validé", () => {
    const c = assembler(gpkg());
    expect(c.couches).toHaveLength(1);
    expect(c.couches[0]).toMatchObject({ id: "axes", nbObjets: 2, parTypeGeom: { LIGNE: 2, POINT: 0, POLYGONE: 0 }, coordonnees: "wgs84", reprojete: true, crsSource: { origine: "fichier", epsg: 32629 } });
    expect(c.champsDisponibles).toEqual(["n", "nom"]);
    expect(c.source).toMatchObject({ sha256: SHA_A, octets: 1000 });
    expect(c.gdal).toEqual({ version: "3.13.3", proj: "9.8.1" });
    expect(c.integrite).toEqual([{ slug: "axes", sha256: "c".repeat(64), octets: expect.any(Number) }]);
  });

  it("refuse un fichier de couche dont la taille diffère de celle annoncée", () => {
    expect(refus(() => assembler(gpkg({ lues: new Map([["axes", lue(texteCouche(DEUX_AXES), { octets: 1 })]]) })))).toBe("SORTIE_INCOHERENTE");
  });

  it("refuse un résultat incohérent avec le fichier envoyé (garde du lot : empreinte)", () => {
    expect(refus(() => assembler(gpkg({ attendus: { ...attendus("GPKG"), sha256: "d".repeat(64) } })))).toBe("SORTIE_INCOHERENTE");
  });
});

describe("DXF : les calques sont les couches", () => {
  it("un calque = une couche `calque:<nom>`, comptes par calque, inventaire du conteneur conservé", () => {
    const c = assembler(dxf());
    expect(c.couches.map((x) => [x.id, x.nbObjets])).toEqual([["calque:AXES", 2], ["calque:RESEAU", 1]]);
    expect(c.couches[0].features!.map((f) => f.properties.EntityHandle)).toEqual(["A1", "A2"]);
    expect(c.dxf).toMatchObject({ unitesDeclarees: "metre", insunits: 6, lues: { LINE: 2, LWPOLYLINE: 1 }, ignorees: { TEXT: 1, HATCH: 1, INSERT: 1 }, blocs: { definitions: 1 } });
  });

  it("exige des unités déclarées et un CRS confirmé : jamais devinés", () => {
    expect(refus(() => assembler(dxf({ parametres: { epsgSource: 32629 } })))).toBe("CRS_REQUIS");
    expect(refus(() => assembler(dxf({ uniteCrsSource: null })))).toBe("CRS_REQUIS");
  });

  it("conflit d'unités : en-tête en millimètres, ou CRS en degrés pour des mètres déclarés : refus, sans mise à l'échelle", () => {
    expect(refus(() => assembler(dxf({ insunits: 4 })))).toBe("DXF_UNITES_CONFLIT");
    expect(refus(() => assembler(dxf({ uniteCrsSource: "degre" })))).toBe("DXF_UNITES_CONFLIT");
    expect(refus(() => assembler(dxf({ insunits: null })))).toBe("AUCUN");
    expect(refus(() => assembler(dxf({ insunits: 0 })))).toBe("AUCUN");
  });

  it("avertit si le nombre d'entités retenues diffère du nombre d'objets convertis, et seulement alors", () => {
    expect(assembler(dxf()).avertissements.map((a) => a.code)).not.toContain("COMPTE_DXF_DIVERGENT");
    const t = texteCouche([{ props: { Layer: "AXES" }, geom: ligne([-9, 10.8], [-8.9, 10.8]) }]);
    const e = dxf({
      resultat: validerResultat(resultatValide({ spoolId: ID, format: "DXF", slug: "entities", nbObjets: 1, octetsCouche: Buffer.byteLength(t), octets: 1000, crsSource: { origine: "demande", epsg: 32629, nom: null }, dxf: { ...INV_DXF, lues: { LINE: 9 } } })),
      lues: new Map([["entities", lue(t, { dxf: true })]]),
    });
    expect(assembler(e).avertissements.map((a) => a.code)).toContain("COMPTE_DXF_DIVERGENT");
  });
});

describe("sélection de couches pour le pipeline", () => {
  const c = assembler(dxf());

  it("sans choix : toutes les couches non vides ; un identifiant inconnu : COUCHE_INTROUVABLE", () => {
    expect(selectionner(c.couches, undefined).map((x) => x.id)).toEqual(["calque:AXES", "calque:RESEAU"]);
    expect(selectionner(c.couches, "calque:RESEAU").map((x) => x.id)).toEqual(["calque:RESEAU"]);
    expect(refus(() => selectionner(c.couches, "calque:INCONNU"))).toBe("COUCHE_INTROUVABLE");
  });

  it("des couches de CRS source différents ne sont jamais mélangées (CRS_MULTIPLES), mais s'importent une à une", () => {
    const a = { ...c.couches[0], id: "a", crsSource: { origine: "fichier" as const, epsg: 32629, nom: null } };
    const b = { ...c.couches[1], id: "b", crsSource: { origine: "fichier" as const, epsg: 4326, nom: null } };
    expect(refus(() => selectionner([a, b], undefined))).toBe("CRS_MULTIPLES");
    expect(selectionner([a, b], "a")).toHaveLength(1);
  });

  it("le document GeoJSON porte les features retenues, et la couche d'origine quand il y en a plusieurs", () => {
    const un = documentGeoJson(selectionner(c.couches, "calque:AXES")) as { features: { properties: Record<string, unknown> }[] };
    expect(un.features).toHaveLength(2);
    expect(un.features[0].properties._couche).toBeUndefined();
    const deux = documentGeoJson(selectionner(c.couches, undefined)) as { features: { properties: Record<string, unknown> }[] };
    expect(deux.features).toHaveLength(3);
    expect(deux.features.map((f) => f.properties._couche)).toEqual(["AXES", "AXES", "RESEAU"]);
  });
});

describe("résumé : jamais de coordonnée d'objet, jamais le texte libre du conteneur", () => {
  it("le résumé ne contient ni coordonnées, ni features", () => {
    const j = JSON.stringify(resumer(assembler(gpkg())));
    expect(j).not.toMatch(/coordinates|"features"|LineString"?,"coord/);
    expect(j).not.toContain("-8.999085058");
  });

  it("les avertissements du conteneur sont rendus avec un libellé FIXE, le texte libre est écarté", () => {
    const r = validerResultat(resultatValide({ spoolId: ID, octets: 1000, surcharge: { avertissements: [
      { code: "CRS_ABSENT", message: "Voir /tmp/geoconv/x/entree.gpkg ligne 12", nb: 2 }, { code: "CRS_ABSENT", message: "autre", nb: 1 }, { code: "CODE_INVENTE", message: "<script>alert(1)</script>" },
    ] } }));
    const a = avertissementsDuConteneur(r);
    expect(a.find((x) => x.code === "CRS_ABSENT")).toMatchObject({ nb: 3 });
    expect(JSON.stringify(a)).not.toMatch(/tmp|script|ligne 12/);
    expect(a.find((x) => x.code === ("CODE_INVENTE" as never))!.message).toBe("Avertissement du convertisseur.");
  });
});
