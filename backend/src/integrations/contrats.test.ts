import { describe, expect, it } from "vitest";
import {
  AccuseReception, CHAMPS_A_CONFIRMER, ChargeDepotBulletin, ChargeFicheIntervention, ChargePivot,
  CONTRAT_VERSION, SchemaEnveloppe, construireEnveloppe, verifierChargeContrat,
} from "./contrats";
import { canonique, cleIdempotence, sha256Hex } from "./canonique";
import { lireGeoJson, verifierLigne } from "../import/pivot.noyau";
import { chargeBulletinExemple, chargeFicheExemple, chargeOuvrage, chargePortion, chargeTroncon } from "./essais.support";
import { DESTINATIONS } from "./types";

/**
 * TESTS DE CONTRAT, contre les schemas ecrits par AGEROUTE (pas contre un systeme reel).
 *
 * Ce qu'ils defendent :
 *   - chaque schema est STRICT : une cle inconnue est refusee (un schema zod ordinaire l'ignore en
 *     silence, et une fuite de champ interne passerait) ;
 *   - ce que DigitalRoad, SharePoint et la BDR recevraient est conforme a ce que les documents du
 *     depot enoncent, et RIEN de plus ;
 *   - le pivot emis est relu et accepte par le lecteur du pivot d'import (X-02) ;
 *   - ce qui n'est pas specifie est LISTE comme a confirmer, jamais comble.
 */

describe("fiche d'intervention (DigitalRoad)", () => {
  const valide = () => JSON.parse(JSON.stringify(chargeFicheExemple()));

  it("accepte une fiche approuvee complete", () => {
    expect(ChargeFicheIntervention.safeParse(valide()).success).toBe(true);
  });

  it("porte exactement les champs du paragraphe 5.3 de MAINTENANCE_PROGRAMMING_DESIGN.md, et rien de plus", () => {
    expect(Object.keys(valide()).sort()).toEqual([
      "annee", "coutEstime", "ficheId", "identifiantsPatrimoniaux", "justification", "plageLineaire",
      "quantites", "score", "sourceFinancement", "statutGeoportail", "traitement", "versionFigee",
    ]);
  });

  it("refuse une cle inconnue a la racine et dans les objets imbriques (schema strict)", () => {
    expect(ChargeFicheIntervention.safeParse({ ...valide(), noteInterne: "x" }).success).toBe(false);
    const f = valide(); f.coutEstime.margeInterne = 12;
    expect(ChargeFicheIntervention.safeParse(f).success).toBe(false);
    const g = valide(); g.identifiantsPatrimoniaux[0].auteur = "u-1";
    expect(ChargeFicheIntervention.safeParse(g).success).toBe(false);
  });

  it("n'admet que le statut APPROUVE", () => {
    expect(ChargeFicheIntervention.safeParse({ ...valide(), statutGeoportail: "PROPOSE" }).success).toBe(false);
    expect(ChargeFicheIntervention.safeParse({ ...valide(), statutGeoportail: "TRANSMIS" }).success).toBe(false);
  });

  it("exige la version figee (SHA-256) : sans elle, ce qui est transmis pourrait changer de sens", () => {
    expect(ChargeFicheIntervention.safeParse({ ...valide(), versionFigee: "abc" }).success).toBe(false);
    const { versionFigee: _v, ...sans } = valide();
    expect(ChargeFicheIntervention.safeParse(sans).success).toBe(false);
  });

  it("le montant est une chaine de chiffres (un montant en GNF depasse 2^53)", () => {
    const f = valide(); f.coutEstime.montantGnf = 2400000000;
    expect(ChargeFicheIntervention.safeParse(f).success).toBe(false);
    const g = valide(); g.coutEstime.montantGnf = "12,5";
    expect(ChargeFicheIntervention.safeParse(g).success).toBe(false);
    const h = valide(); h.coutEstime.montantGnf = "9007199254740993123";
    expect(ChargeFicheIntervention.safeParse(h).success).toBe(true);
  });

  it("la plage lineaire doit etre croissante, ou nulle", () => {
    const f = valide(); f.plageLineaire = { debutM: 500, finM: 100 };
    expect(ChargeFicheIntervention.safeParse(f).success).toBe(false);
    const g = valide(); g.plageLineaire = null;
    expect(ChargeFicheIntervention.safeParse(g).success).toBe(true);
  });

  it("n'invente pas de vocabulaire : la classe de precision est un texte libre, a confirmer", () => {
    const f = valide(); f.coutEstime.classePrecision = "NIVEAU_QUE_PERSONNE_N_A_DEFINI";
    expect(ChargeFicheIntervention.safeParse(f).success).toBe(true);
    expect(CHAMPS_A_CONFIRMER.DIGITALROAD.map((c) => c.champ)).toContain("coutEstime.classePrecision");
  });

  it("refuse une fiche sans bien patrimonial identifie", () => {
    expect(ChargeFicheIntervention.safeParse({ ...valide(), identifiantsPatrimoniaux: [] }).success).toBe(false);
  });
});

describe("depot du bulletin (SharePoint)", () => {
  const valide = () => JSON.parse(JSON.stringify(chargeBulletinExemple()));

  it("accepte un bulletin dont l'empreinte et la taille sont celles du contenu", () => {
    expect(ChargeDepotBulletin.safeParse(valide()).success).toBe(true);
  });

  it("refuse un contenu retouche apres calcul de l'empreinte", () => {
    const b = valide(); b.contenu += " (retouche)";
    const r = ChargeDepotBulletin.safeParse(b);
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: { issues: unknown } }).error.issues)).toMatch(/empreinte/);
  });

  it("refuse une taille qui n'est pas celle du contenu (octets, pas caracteres)", () => {
    const b = valide();
    b.tailleOctets += 1;
    expect(ChargeDepotBulletin.safeParse(b).success).toBe(false);
  });

  it.each(["../etc/passwd", "a b.txt", "a/b.txt", "", "x".repeat(121)])("refuse le nom de fichier %j", (nom) => {
    const b = valide(); b.nomFichier = nom;
    expect(ChargeDepotBulletin.safeParse(b).success).toBe(false);
  });

  it("refuse une cle inconnue (par exemple l'auteur de la generation)", () => {
    expect(ChargeDepotBulletin.safeParse({ ...valide(), genereParId: "u-1" }).success).toBe(false);
  });

  it("le type MIME est fige : text/plain en UTF-8", () => {
    expect(ChargeDepotBulletin.safeParse({ ...valide(), typeMime: "application/pdf" }).success).toBe(false);
  });
});

describe("pivot (BDR / L2R)", () => {
  it.each([
    ["troncon", chargeTroncon()],
    ["ouvrage", chargeOuvrage()],
    ["portion", chargePortion()],
  ])("le pivot emis pour un(e) %s est RELU ET ACCEPTE par le lecteur du pivot d'import (X-02)", (_t, charge) => {
    expect(ChargePivot.safeParse(charge).success).toBe(true);
    const lecture = lireGeoJson(charge);
    expect(lecture.ok).toBe(true);
    if (lecture.ok) {
      expect(lecture.lignes).toHaveLength(1);
      expect(verifierLigne(lecture.lignes[0]).ok).toBe(true);
    }
  });

  it("declare le SRID 4326 (CRS84) et refuse une autre declaration", () => {
    const c = JSON.parse(JSON.stringify(chargeTroncon()));
    expect(c.crs.properties.name).toBe("urn:ogc:def:crs:OGC:1.3:CRS84");
    c.crs.properties.name = "urn:ogc:def:crs:EPSG::32628";
    expect(ChargePivot.safeParse(c).success).toBe(false);
  });

  it("refuse une coordonnee hors de l'etendue WGS 84 (fichier qui pretend etre en 4326)", () => {
    const c = JSON.parse(JSON.stringify(chargeTroncon()));
    c.features[0].geometry.coordinates[0] = [500000, 1000000];
    expect(ChargePivot.safeParse(c).success).toBe(false);
  });

  it("refuse un troncon sans geometrie (le pivot n'invente pas de localisation)", () => {
    const c = JSON.parse(JSON.stringify(chargeTroncon()));
    c.features[0].geometry = null;
    expect(ChargePivot.safeParse(c).success).toBe(false);
  });

  it("n'emet qu'UNE ligne par evenement", () => {
    const c = JSON.parse(JSON.stringify(chargeTroncon()));
    c.features.push(c.features[0]);
    expect(ChargePivot.safeParse(c).success).toBe(false);
  });

  it("n'est PAS un format L2R : il declare le pivot ouvert et rien de proprietaire", () => {
    const c = JSON.parse(JSON.stringify(chargeTroncon()));
    expect(c.type).toBe("FeatureCollection");
    expect(Object.keys(c.features[0].properties)).toEqual(expect.arrayContaining(["systeme_source", "type_objet", "identifiant_source"]));
    expect(CHAMPS_A_CONFIRMER.BDR_L2R.map((x) => x.champ)).toContain("format L2R (Mesure, Base, Programme)");
  });
});

describe("enveloppe et accuse", () => {
  const charge = chargeTroncon();
  const chargeCanonique = canonique(charge);
  const empreinteCharge = sha256Hex(chargeCanonique);
  const cle = cleIdempotence({ destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", sourceType: "Troncon", sourceId: "t-1", empreinteCharge });
  const env = construireEnveloppe({
    evenementId: "e-1", destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", version: 1, cleIdempotence: cle, empreinteCharge, charge,
  });

  it("porte la version de contrat BROUILLON : aucun tiers ne l'a confirmee", () => {
    expect(env.contrat).toBe(CONTRAT_VERSION);
    expect(CONTRAT_VERSION).toMatch(/brouillon/);
  });

  it("ne porte pas l'identifiant interne de l'evenement ni aucun autre champ interne", () => {
    expect(Object.keys(env).sort()).toEqual(["charge", "cleIdempotence", "contrat", "destination", "empreinteCharge", "typeEvenement", "version"]);
    expect(SchemaEnveloppe.safeParse(env).success).toBe(true);
  });

  it("l'enveloppe est stricte", () => {
    expect(SchemaEnveloppe.safeParse({ ...env, evenementId: "e-1" }).success).toBe(false);
  });

  it("l'accuse n'exige que la reference, et ignore le reste de la reponse", () => {
    expect(AccuseReception.safeParse({ reference: "R-1", extra: "ignore" }).success).toBe(true);
    expect(AccuseReception.safeParse({ reference: "" }).success).toBe(false);
    expect(AccuseReception.safeParse({ statut: "ok" }).success).toBe(false);
    expect(AccuseReception.safeParse({ reference: "R", doublon: "oui" }).success).toBe(false);
  });
});

describe("verifierChargeContrat", () => {
  it("rend un motif lisible, borne a cinq anomalies", () => {
    const v = verifierChargeContrat("DIGITALROAD", {});
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motif.split(" ; ").length).toBeLessThanOrEqual(5);
  });

  it("chaque destination refuse la charge d'une autre", () => {
    expect(verifierChargeContrat("SHAREPOINT", chargeFicheExemple()).ok).toBe(false);
    expect(verifierChargeContrat("BDR_L2R", chargeBulletinExemple()).ok).toBe(false);
    expect(verifierChargeContrat("DIGITALROAD", chargeTroncon()).ok).toBe(false);
  });
});

describe("ce qui reste a confirmer", () => {
  it.each(DESTINATIONS)("%s : la liste n'est jamais vide, et chaque entree cite sa reference", (d) => {
    expect(CHAMPS_A_CONFIRMER[d].length).toBeGreaterThanOrEqual(5);
    for (const c of CHAMPS_A_CONFIRMER[d]) {
      expect(c.champ.length).toBeGreaterThan(2);
      expect(c.constat.length).toBeGreaterThan(20);
      expect(c.reference.length).toBeGreaterThan(5);
    }
  });

  it.each(DESTINATIONS)("%s : le transport et l'authentification sont declares non confirmes", (d) => {
    const champs = CHAMPS_A_CONFIRMER[d].map((c) => c.champ);
    expect(champs.some((c) => /transport|mecanisme/.test(c))).toBe(true);
  });

  it("DigitalRoad : l'accuse ne vaut pas le statut TRANSMIS, et aucune fiche ne peut etre inscrite", () => {
    const constats = CHAMPS_A_CONFIRMER.DIGITALROAD.map((c) => c.constat).join(" ");
    expect(constats).toMatch(/JAMAIS passer une fiche en TRANSMIS/);
    expect(constats).toMatch(/aucune table de fiches/);
  });
});
