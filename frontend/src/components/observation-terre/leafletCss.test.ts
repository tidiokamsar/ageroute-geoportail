// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Non-regression du bout en bout reel apres la fusion : `index.html` ne charge plus la feuille de style de Leaflet (le Lot 1 l'a remplacee par
 * un import local). Tout composant qui monte une carte Leaflet doit donc l'importer LUI-MEME, sans quoi la page ouverte directement
 * (`/teledetection`) affiche une carte sans mise en page. jsdom ne rend pas Leaflet : on verifie la source.
 */
const dossier = __dirname;
const COMPOSANTS_CARTE = ["CarteObservationTerre.tsx"];

describe("feuille de style de Leaflet", () => {
  it.each(COMPOSANTS_CARTE)("%s importe leaflet/dist/leaflet.css", (nom) => {
    expect(readFileSync(path.join(dossier, nom), "utf8")).toMatch(/import\s+["']leaflet\/dist\/leaflet\.css["']/);
  });
});
