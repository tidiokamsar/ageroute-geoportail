import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { lire, RESEAU_STRUCTURANT, SEUIL_DOUBLON_M } from "./franchissements";

/**
 * La cle d'identite des ouvrages importes.
 *
 * CE QUE CE TEST DEFEND
 *
 * `sourceReference` porte un index d'unicite, et l'import insere avec
 * ON CONFLICT DO NOTHING pour rester rejouable. Les deux ensemble ont une propriete
 * desagreable : une cle qui n'identifie pas ne fait pas ECHOUER l'import, elle en
 * fait DISPARAITRE des lignes, sans une ligne de journal.
 *
 * C'est arrive le 05/09/2026. La cle etait `numero` quand il existait — pris pour un
 * identifiant d'ouvrage. C'est le numero de la ROUTE : 376 ponts retenus ne portent
 * que 27 valeurs, dont 110 sur « N1 ». 963 ponts presentes, 614 ecrits, 349 avales.
 * Rien dans la base, rien dans la sortie du script ne le signalait ; il a fallu
 * recompter la table pour s'en apercevoir.
 *
 * Aucune assertion sur la base ne pouvait attraper cela : du point de vue de
 * PostgreSQL, tout s'est bien passe. La garde doit donc etre ici, sur la source.
 */

const FICHIER = path.resolve(__dirname, "../../../frontend/public/data/ponts-osm.geojson");
const disponible = fs.existsSync(FICHIER);
const surSource = disponible ? describe : describe.skip;

surSource("La cle identifie un ouvrage, et un seul", () => {
  const { retenus } = lire(FICHIER);

  it("retient des ponts", () => {
    expect(retenus.length).toBeGreaterThan(0);
  });

  it("ne donne jamais la meme cle a deux ponts", () => {
    const vues = new Map<string, number>();
    for (const r of retenus) vues.set(r.cle, (vues.get(r.cle) ?? 0) + 1);
    const collisions = [...vues].filter(([, n]) => n > 1);
    // Le message compte : sans lui, l'echec dirait « 27 !== 0 » et il faudrait
    // rouvrir la source pour comprendre lesquels.
    expect(collisions, `cles partagees : ${JSON.stringify(collisions.slice(0, 5))}`).toEqual([]);
  });

  it("ecrira donc autant de lignes qu'il presente de ponts", () => {
    // La propriete qui compte reellement, dite dans les termes de l'import.
    expect(new Set(retenus.map((r) => r.cle)).size).toBe(retenus.length);
  });

  it("ne derive pas la cle du numero de route", () => {
    // Regression directe. `numero` vaut « N1 », « N2 », « A12 »... ; une cle qui en
    // descend est courte et ne contient pas de position.
    for (const r of retenus.slice(0, 50)) {
      expect(r.cle).toMatch(/^p-?\d+\.\d{7},-?\d+\.\d{7}$/);
    }
  });

  it("ne retient que le reseau structurant", () => {
    for (const r of retenus) expect(RESEAU_STRUCTURANT.has(r.nature)).toBe(true);
  });

  it("place chaque pont sur le territoire guineen", () => {
    // Une cle fondee sur la position ne vaut que si la position est bonne. Une
    // inversion lat/lon passerait tous les tests ci-dessus et aucun ici.
    for (const r of retenus) {
      expect(r.lat).toBeGreaterThan(7);
      expect(r.lat).toBeLessThan(13);
      expect(r.lon).toBeGreaterThan(-15.5);
      expect(r.lon).toBeLessThan(-7);
    }
  });

  it("ecarte les doublons d'ouvrages deja inventories", () => {
    expect(SEUIL_DOUBLON_M).toBe(250);
  });
});
