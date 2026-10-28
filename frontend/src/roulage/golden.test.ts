import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { alimenter, demarrerBanc } from "./aide-test";
import { construirePayload } from "./contrat";

/**
 * LE POINT D'ACCORD ENTRE L'APPAREIL ET LE SERVEUR.
 *
 * Les deux codes vivent dans deux paquets qui ne s'importent pas. Pour qu'ils ne divergent pas sans
 * que personne ne le voie, cette charge d'exemple est ecrite UNE FOIS dans docs/roulage/ par le noyau de
 * l'appareil (ce test), puis RELUE par le test du serveur, qui la fait passer par son schema zod
 * (backend/src/roulage/contrat.test.ts). Modifier le format d'un cote fait echouer l'autre test.
 *
 * Pour la regenerer apres un changement voulu du contrat : REGENERER_CONTRAT=1 npx vitest run golden
 */
const CHEMIN = join(__dirname, "..", "..", "..", "docs", "roulage", "exemple-session.json");

function scenario() {
  const b = demarrerBanc();
  alimenter(b, 0, 14);
  b.session.poserMarqueur("NID_DE_POULE", { note: "devant l'ecole" });
  const d = b.session.debutEvenement("ETAT_CHAUSSEE", { qualification: { etat: "MAUVAIS" }, note: "section degradee" });
  alimenter(b, 15, 44);
  if (d.ok) b.session.finEvenement(d.evenement.id);
  b.session.signalerSysteme({ type: "APPEL_ENTRANT" });
  b.horloge.avancer(2000);
  b.session.signalerSysteme({ type: "APPEL_TERMINE" });
  alimenter(b, 47, 60);
  b.session.arreter();
  const r = construirePayload(b.session.etat);
  if (!r.ok) throw new Error("payload");
  return r.payload;
}

describe("charge d'exemple partagee avec le serveur", () => {
  it("le noyau produit exactement la charge versionnee dans docs/roulage/exemple-session.json", () => {
    const payload = scenario();
    if (process.env.REGENERER_CONTRAT === "1") {
      mkdirSync(dirname(CHEMIN), { recursive: true });
      writeFileSync(CHEMIN, `${JSON.stringify(payload, null, 1)}\n`);
    }
    expect(existsSync(CHEMIN), "lancer une fois avec REGENERER_CONTRAT=1").toBe(true);
    const attendu = JSON.parse(readFileSync(CHEMIN, "utf8"));
    expect(JSON.parse(JSON.stringify(payload))).toEqual(attendu);
  });

  it("le scenario contient ce que le contrat doit transporter : un marqueur, un evenement clos, un trou, une interruption", () => {
    const p = scenario();
    expect(p.marqueurs).toHaveLength(1);
    expect(p.evenements).toHaveLength(1);
    expect(p.evenements[0].statut).toBe("CLOS");
    expect(p.interruptions).toHaveLength(1);
    expect(p.trous).toHaveLength(0);
    expect(p.points.length).toBeGreaterThan(50);
  });
});
