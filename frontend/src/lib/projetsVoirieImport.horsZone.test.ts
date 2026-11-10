import { describe, expect, it } from "vitest";
import { OPTIONS } from "../components/projets-voirie/assistant/assistantImport.testutil";
import { lireOptionsImport, precisionHorsZone } from "./projetsVoirieImport";
import { classerErreur } from "./projetsVoirie";

/** Revue UI-C m7 : le message hors zone lit l'emprise nationale renvoyee par le serveur (options d'import), jamais des bornes codees. Donnees synthetiques. */
describe("message hors zone", () => {
  const e = classerErreur({ response: { status: 422, data: { code: "HORS_GUINEE", error: "texte brut" } } });
  it("la zone nationale des options est citee (nom et bornes) ; sans elle, le message generique seul", () => {
    const o = lireOptionsImport({ ...OPTIONS, crs: { ...OPTIONS.crs, zoneNationale: { nom: "Zone test", bbox: [-11, 8, -9, 10] } } });
    expect(o.crs.zoneNationale).toEqual({ nom: "Zone test", bbox: [-11, 8, -9, 10] });
    expect(precisionHorsZone(e, o).message).toMatch(/Emprise nationale configurée sur ce serveur : « Zone test » \(ouest -11,0000, sud 8,0000, est -9,0000, nord 10,0000\)/);
    const sans = lireOptionsImport({ ...OPTIONS, crs: { ...OPTIONS.crs, zoneAttendue: null } });
    expect(precisionHorsZone(e, sans).message).toBe(e.message);
  });
  it("une autre erreur n'est pas touchee", () => {
    const autre = classerErreur({ response: { status: 422, data: { code: "CRS_REQUIS" } } });
    const o = lireOptionsImport({ ...OPTIONS, crs: { ...OPTIONS.crs, zoneNationale: { nom: "Zone test", bbox: [-11, 8, -9, 10] } } });
    expect(precisionHorsZone(autre, o)).toBe(autre);
  });
});
