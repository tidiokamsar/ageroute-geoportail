import { describe, expect, it } from "vitest";
import {
  delegationEnVigueur, delegationCouvre, validationDeleguee, domainesSansValidateur,
  domaineDeLEntite, DOMAINES_VALIDATION, EXPLICATIONS,
  type Delegation,
} from "./delegation";
import { ENTITES_VALIDABLES } from "./validation";

/**
 * La delegation de validation : ce que ces tests defendent.
 *
 * CE QUE LE CAHIER DEMANDE
 *
 * Paragraphe 35 : « Un validateur est designe pour chaque domaine. » Paragraphe 5 : le
 * Coordonnateur fait « validation selon delegation ». Avant, tout GESTIONNAIRE validait
 * tout, partout : ni domaine, ni perimetre, ni terme, ni delegant.
 *
 * LES DEUX ERREURS QUI COUTERAIENT LE PLUS CHER
 *
 * Qu'une delegation expiree continue d'agir : quelqu'un garderait un pouvoir qu'on croit
 * lui avoir retire, et le journal donnerait le change puisque la ligne existe toujours.
 *
 * Qu'une delegation regionale couvre un objet dont la region est INCONNUE : ce serait
 * deduire une localisation de l'absence de localisation, sur un systeme dont la regle
 * premiere est de ne jamais inventer un rattachement.
 */

const d = (p: Partial<Delegation> = {}): Delegation => ({
  domaine: "DEFAUT",
  validateurId: "gestionnaire-1",
  regionId: null,
  debutLe: new Date("2026-01-01T00:00:00.000Z"),
  finLe: null,
  revoqueeLe: null,
  ...p,
});

const MAINTENANT = new Date("2026-10-13T12:00:00.000Z");

describe("Une delegation a un debut, parfois un terme, et peut etre revoquee", () => {
  it("est en vigueur entre son debut et son terme", () => {
    expect(delegationEnVigueur(d(), MAINTENANT)).toBe(true);
    expect(delegationEnVigueur(d({ finLe: new Date("2026-12-31T00:00:00.000Z") }), MAINTENANT)).toBe(true);
  });

  it("N'AGIT PAS avant son debut", () => {
    // Une delegation preparee pour la semaine prochaine ne doit pas agir aujourd'hui.
    expect(delegationEnVigueur(d({ debutLe: new Date("2026-11-01T00:00:00.000Z") }), MAINTENANT)).toBe(false);
  });

  it("N'AGIT PLUS apres son terme", () => {
    // L'erreur la plus couteuse : quelqu'un garderait un pouvoir qu'on croit lui avoir
    // retire, et la ligne existant toujours, le journal donnerait le change.
    expect(delegationEnVigueur(d({ finLe: new Date("2026-06-30T00:00:00.000Z") }), MAINTENANT)).toBe(false);
  });

  it("cesse a l'instant exact du terme, pas une seconde apres", () => {
    expect(delegationEnVigueur(d({ finLe: MAINTENANT }), MAINTENANT)).toBe(false);
  });

  it("n'agit plus des sa revocation, meme sans terme", () => {
    expect(delegationEnVigueur(d({ revoqueeLe: new Date("2026-09-01T00:00:00.000Z") }), MAINTENANT)).toBe(false);
  });

  it("ignore une revocation future", () => {
    // Une revocation programmee ne retire rien avant son heure.
    expect(delegationEnVigueur(d({ revoqueeLe: new Date("2026-11-01T00:00:00.000Z") }), MAINTENANT)).toBe(true);
  });
});

describe("Le perimetre geographique, et le cas de la region inconnue", () => {
  it("une delegation nationale couvre toutes les regions", () => {
    expect(delegationCouvre(d({ regionId: null }), { domaine: "DEFAUT", regionId: 7 }, MAINTENANT)).toBe(true);
  });

  it("une delegation nationale couvre AUSSI un objet sans region", () => {
    // Elle couvre tout : rien a deduire.
    expect(delegationCouvre(d({ regionId: null }), { domaine: "DEFAUT", regionId: null }, MAINTENANT)).toBe(true);
  });

  it("une delegation regionale ne couvre que sa region", () => {
    const reg = d({ regionId: 7 });
    expect(delegationCouvre(reg, { domaine: "DEFAUT", regionId: 7 }, MAINTENANT)).toBe(true);
    expect(delegationCouvre(reg, { domaine: "DEFAUT", regionId: 8 }, MAINTENANT)).toBe(false);
  });

  it("une delegation regionale NE COUVRE PAS un objet dont la region est inconnue", () => {
    // Le cas qui compte. Un defaut peut n'avoir aucune region : son troncon n'est pas
    // apparie, ou sa mission n'en declare pas. L'accepter reviendrait a deduire une
    // localisation de l'ABSENCE de localisation, sur un systeme dont la regle premiere
    // est de ne jamais inventer un rattachement.
    expect(delegationCouvre(d({ regionId: 7 }), { domaine: "DEFAUT", regionId: null }, MAINTENANT)).toBe(false);
  });

  it("ne couvre jamais un autre domaine", () => {
    expect(delegationCouvre(d({ domaine: "DEFAUT" }), { domaine: "OUVRAGE", regionId: null }, MAINTENANT)).toBe(false);
  });

  it("ne couvre rien quand elle n'est plus en vigueur, meme sur son propre domaine", () => {
    const expiree = d({ finLe: new Date("2026-01-02T00:00:00.000Z") });
    expect(delegationCouvre(expiree, { domaine: "DEFAUT", regionId: null }, MAINTENANT)).toBe(false);
  });
});

describe("Le resserrement se fait par domaine", () => {
  it("laisse valider tant que PERSONNE n'est designe sur le domaine", () => {
    // Exiger une delegation des le premier jour arreterait la validation tant que
    // personne n'en a cree : les releves s'accumuleraient en A_VALIDER et la chaine de
    // decision resterait vide. Designer des validateurs est un acte d'organisation.
    const v = validationDeleguee({
      delegationsDuDomaine: [], validateurId: "gestionnaire-1",
      domaine: "DEFAUT", regionId: 7, maintenant: MAINTENANT,
    });
    expect(v).toEqual({ permis: true, motif: "DOMAINE_NON_DESIGNE" });
  });

  it("RESERVE le domaine aux designes des qu'un seul l'est", () => {
    const v = validationDeleguee({
      delegationsDuDomaine: [d({ validateurId: "autre" })],
      validateurId: "gestionnaire-1",
      domaine: "DEFAUT", regionId: 7, maintenant: MAINTENANT,
    });
    expect(v).toEqual({ permis: false, motif: "HORS_DELEGATION" });
  });

  it("laisse passer le designe", () => {
    const v = validationDeleguee({
      delegationsDuDomaine: [d({ validateurId: "gestionnaire-1" })],
      validateurId: "gestionnaire-1",
      domaine: "DEFAUT", regionId: 7, maintenant: MAINTENANT,
    });
    expect(v).toEqual({ permis: true, motif: "DELEGATION_COUVRANTE" });
  });

  it("refuse le designe HORS de sa region", () => {
    const v = validationDeleguee({
      delegationsDuDomaine: [d({ validateurId: "gestionnaire-1", regionId: 7 })],
      validateurId: "gestionnaire-1",
      domaine: "DEFAUT", regionId: 8, maintenant: MAINTENANT,
    });
    expect(v).toEqual({ permis: false, motif: "HORS_DELEGATION" });
  });

  it("ROUVRE le domaine quand la derniere delegation expire", () => {
    // Consequence a connaitre du resserrement par domaine : laisser toutes les
    // delegations expirer ramene le domaine a la regle d'avant, sans que personne ne
    // l'ait decide. C'est pour cela que les domaines non designes sont COMPTES.
    const v = validationDeleguee({
      delegationsDuDomaine: [d({ validateurId: "autre", finLe: new Date("2026-06-30T00:00:00.000Z") })],
      validateurId: "gestionnaire-1",
      domaine: "DEFAUT", regionId: 7, maintenant: MAINTENANT,
    });
    expect(v).toEqual({ permis: true, motif: "DOMAINE_NON_DESIGNE" });
  });

  it("DISTINGUE les deux raisons d'autoriser", () => {
    // « Personne n'est designe » et « vous etes designe » autorisent la meme action pour
    // des raisons opposees. Sans ce motif, on ne saura pas dans un an si une validation
    // reposait sur une designation ou sur son absence.
    const sans = validationDeleguee({
      delegationsDuDomaine: [], validateurId: "g1", domaine: "DEFAUT", regionId: null, maintenant: MAINTENANT,
    });
    const avec = validationDeleguee({
      delegationsDuDomaine: [d({ validateurId: "g1" })],
      validateurId: "g1", domaine: "DEFAUT", regionId: null, maintenant: MAINTENANT,
    });
    expect(sans.motif).not.toBe(avec.motif);
  });
});

describe("L'etat de la gouvernance se lit, il ne se devine pas", () => {
  it("compte les domaines sur lesquels personne n'est designe", () => {
    // La mesure qui empeche le resserrement progressif de devenir un oubli permanent.
    const manquants = domainesSansValidateur([d({ domaine: "DEFAUT" })], MAINTENANT);
    expect(manquants).not.toContain("DEFAUT");
    expect(manquants).toContain("TRONCON");
    expect(manquants).toHaveLength(DOMAINES_VALIDATION.length - 1);
  });

  it("recompte un domaine dont la delegation a expire", () => {
    const manquants = domainesSansValidateur(
      [d({ domaine: "DEFAUT", finLe: new Date("2026-06-30T00:00:00.000Z") })],
      MAINTENANT,
    );
    expect(manquants).toContain("DEFAUT");
  });

  it("les compte tous quand rien n'est designe", () => {
    expect(domainesSansValidateur([], MAINTENANT)).toEqual([...DOMAINES_VALIDATION]);
  });
});

describe("Les domaines correspondent aux entites qui se valident", () => {
  it("traduit chaque entite validable en domaine", () => {
    // Un domaine qui ne correspondrait a aucune entite validable designerait un
    // validateur pour quelque chose qui ne se valide pas.
    for (const e of ENTITES_VALIDABLES) {
      expect(domaineDeLEntite(e), e).not.toBeNull();
    }
  });

  it("couvre exactement les entites validables, ni plus ni moins", () => {
    expect(DOMAINES_VALIDATION).toHaveLength(ENTITES_VALIDABLES.size);
  });

  it("rend null pour une entite qui ne se valide pas", () => {
    expect(domaineDeLEntite("User")).toBeNull();
    expect(domaineDeLEntite("Region")).toBeNull();
  });
});

describe("Le refus s'explique a un agent, pas a un developpeur", () => {
  it("dit que le domaine est reserve et que la zone compte", () => {
    expect(EXPLICATIONS.HORS_DELEGATION.length).toBeGreaterThan(20);
    expect(EXPLICATIONS.HORS_DELEGATION).not.toMatch(/_|\bundefined\b|\bnull\b|[A-Z]{4,}/);
    expect(EXPLICATIONS.HORS_DELEGATION).toMatch(/désign/i);
  });
});
