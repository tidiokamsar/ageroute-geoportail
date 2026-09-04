import { describe, expect, it } from "vitest";
import { deduireRegion } from "./rattacher-chantiers-region";

/**
 * Deduction de region a partir d'un intitule de chantier.
 *
 * Cette fonction decide du classement de 50 dossiers de marche publics. Se tromper
 * ne casse rien visiblement : le chantier apparait simplement dans la mauvaise
 * region, et plus personne ne le remet en question. Les tests portent donc surtout
 * sur ce qu'elle doit REFUSER de trancher.
 */

describe("Une mention explicite fait foi", () => {
  it("lit « dans la Préfecture de Forécariah »", () => {
    const v = deduireRegion(
      "Travaux d'aménagement de tronçons de route au Camp militaire de Kaléah, dans la Préfecture de Forécariah",
    );
    expect(v.region).toBe("Kindia");
    expect(v.motif).toBe("mention explicite");
  });

  it("lit « commune Urbaine de Labé »", () => {
    const v = deduireRegion(
      "Lot 9: Travaux d'achèvement du pont de Mangalabé situé dans la commune Urbaine de Labé",
    );
    expect(v.region).toBe("Labé");
  });

  it("l'emporte sur les autres localités citées", () => {
    // Sans cette priorite, « Tanéné » (Kindia) et « Dubréka » (Kindia) pourraient
    // se disputer avec un autre lieu et rendre le cas ambigu a tort.
    const v = deduireRegion(
      "Travaux d'entretien des quatre ponts métalliques de Tanéné, dans la Préfecture de Dubréka",
    );
    expect(v.region).toBe("Kindia");
    expect(v.motif).toBe("mention explicite");
  });
});

describe("Le piège des faux quartiers de Conakry", () => {
  it("place Manéah en Kindia, pas en Conakry", () => {
    // Manéah est a Coyah. Ses chantiers voisinent avec ceux de Bambeto dans la
    // liste, ce qui invite a les traiter comme de la voirie de Conakry.
    expect(deduireRegion("Rond-point Marché Manéah-face à la 1ère Station STAR (PK12+80)").region)
      .toBe("Kindia");
  });

  it("place Kagbélén en Kindia", () => {
    expect(deduireRegion("Route le Prince, Carrefour George Fofana-Banue BSIC-Carrefour Kagbélén").region)
      .not.toBe("Conakry");
  });

  it("reconnaît les quartiers qui sont vraiment de Conakry", () => {
    expect(deduireRegion("Intersection Darsalam (Marché) -Rond-point Bambéto").region).toBe("Conakry");
    expect(deduireRegion("T2 -Rond-point Bambéto-Centre Emetteur Kipé").region).toBe("Conakry");
  });
});

describe("Ce qu'il refuse de trancher", () => {
  it("laisse sans région un intitulé sans indice", () => {
    const v = deduireRegion("Programme d'Urgence Entretien Routier");
    expect(v.region).toBeNull();
    expect(v.motif).toMatch(/aucun indice/i);
  });

  it("laisse sans région un axe qui traverse deux régions", () => {
    const v = deduireRegion("Route Kankan - Kissidougou");
    expect(v.region).toBeNull();
    expect(v.motif).toMatch(/ambigu/i);
    expect(v.motif).toContain("Kankan");
    expect(v.motif).toContain("Faranah");
  });

  it("ne devine pas sur un simple point kilométrique", () => {
    expect(deduireRegion("Face à la 1ère Station STAR (PK12+80)-Dalot (PK13+80)").region).toBeNull();
  });
});

describe("Le découpage appliqué est celui du 20 août 2026", () => {
  it("envoie Siguiri vers la région Siguiri, plus vers Kankan", () => {
    expect(deduireRegion("Travaux de voirie urbaine à Siguiri").region).toBe("Siguiri");
  });

  it("envoie Beyla vers la région Beyla, plus vers Nzérékoré", () => {
    expect(deduireRegion("Réhabilitation de la route de Beyla").region).toBe("Beyla");
  });

  it("reconnaît une préfecture créée en 2026", () => {
    expect(deduireRegion("Aménagement de la voirie de Kamsar").region).toBe("Boké");
  });
});

describe("Les accents et l'orthographe libre", () => {
  it("reconnaît Nzérékoré quelle que soit la graphie", () => {
    for (const g of ["Nzérékoré", "N'Zérékoré", "NZEREKORE", "nzerekore"]) {
      expect(deduireRegion(`Entretien de la route ${g} - Diécké`).region, g).toBe("Nzérékoré");
    }
  });

  it("ne confond pas un mot qui contient une localité", () => {
    // « Labé » ne doit pas se declencher sur « Kolaboué » ni « Labékoura » : la
    // reconnaissance porte sur des mots entiers.
    expect(deduireRegion("Travaux à Kolaboué").region).toBeNull();
  });
});

describe("La voirie structurante de Conakry", () => {
  it("reconnaît les transversales numérotées", () => {
    expect(deduireRegion("Rond-point T5-Cité ENCO5").region).toBe("Conakry");
    expect(deduireRegion("Transversal T6 (Fossidet)-Rond-point T6").region).toBe("Conakry");
  });

  it("reconnaît la Route le Prince et la Route Niger", () => {
    expect(deduireRegion("Marché Avaria (SOBRAGUI)-Carrefour Constantin (Route Niger)").region)
      .toBe("Conakry");
  });

  it("ne se déclenche pas sur un T isolé dans un autre mot", () => {
    expect(deduireRegion("Travaux de reprofilage T").region).toBeNull();
  });
});
