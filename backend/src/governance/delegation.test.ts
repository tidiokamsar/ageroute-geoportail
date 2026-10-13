import { describe, expect, it } from "vitest";
import {
  delegationEnVigueur, delegationCouvre, validationDeleguee, domainesSansValidateur,
  domaineDeLEntite, designationPermise, revocationPermise,
  domainesSansChemindeValidation, DOMAINES_AVEC_CHEMIN_DE_VALIDATION,
  DOMAINES_VALIDATION, EXPLICATIONS, EXPLICATIONS_DESIGNATION,
  type Delegation, type DemandeDesignation, type RefusDesignation,
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

describe("Qui peut DESIGNER un validateur", () => {
  /**
   * Le paragraphe 35 dit qu'un validateur est designe, PAS PAR QUI. AGEROUTE a tranche le
   * 13/10/2026 : la Direction Technique, dont l'usage au paragraphe 5 est « validation et
   * arbitrage technique ».
   *
   * Ce n'est pas un controle de role, et c'est le point a defendre : six profils sur onze
   * sont GESTIONNAIRE. Ouvrir la designation a tout GESTIONNAIRE la donnerait a
   * l'Ingenieur reseau, a l'Entretien, a la Planification, au Coordonnateur et a
   * l'Administrateur SIG — c'est-a-dire a presque tout le monde, ce qui vide la
   * designation de son sens.
   */
  const dd = (p: Partial<DemandeDesignation> = {}): DemandeDesignation => ({
    delegantId: "direction-1",
    delegantRole: "GESTIONNAIRE",
    delegantPeutDeleguer: true,
    validateurId: "gestionnaire-2",
    validateurRole: "GESTIONNAIRE",
    debutLe: new Date("2026-10-13T00:00:00.000Z"),
    finLe: null,
    ...p,
  });

  it("laisse designer qui porte le droit", () => {
    expect(designationPermise(dd())).toEqual({ permis: true });
  });

  it("REFUSE un gestionnaire qui ne porte pas le droit", () => {
    // Sans cela, cinq autres profils GESTIONNAIRE designeraient des validateurs.
    expect(designationPermise(dd({ delegantPeutDeleguer: false })))
      .toEqual({ permis: false, motif: "DROIT_DE_DELEGUER_ABSENT" });
  });

  it("dispense l'ADMIN du droit explicite", () => {
    // Il administre les comptes, donc il peut de toute facon se l'accorder : l'exiger
    // n'ajouterait qu'une etape, pas une garantie.
    expect(designationPermise(dd({ delegantRole: "ADMIN", delegantPeutDeleguer: false })).permis).toBe(true);
  });

  it("REFUSE L'AUTO-DESIGNATION", () => {
    // Un delegant qui se designe sur les sept domaines concentrerait l'arbitrage qu'on
    // voulait repartir. L'auto-validation reste par ailleurs interdite, donc il ne
    // pourrait pas valider ses propres releves — mais il pourrait valider TOUS LES
    // AUTRES, seul, ce qui est exactement ce que la designation par domaine evite.
    expect(designationPermise(dd({ validateurId: "direction-1" })))
      .toEqual({ permis: false, motif: "AUTO_DESIGNATION" });
  });

  it("REFUSE de designer un compte qui ne peut pas valider", () => {
    // `ROLES_VALIDATEURS` n'admet que ADMIN et GESTIONNAIRE. Designer un LECTEUR creerait
    // une delegation qui ne servirait JAMAIS, puisque le controle de role passe avant
    // celui de la delegation : elle aurait l'air de fonctionner et n'autoriserait rien.
    for (const role of ["LECTEUR", "INSPECTEUR"]) {
      expect(designationPermise(dd({ validateurRole: role })), role)
        .toEqual({ permis: false, motif: "VALIDATEUR_SANS_ROLE_VALIDATEUR" });
    }
  });

  it("accepte de designer un ADMIN comme validateur", () => {
    expect(designationPermise(dd({ validateurRole: "ADMIN" })).permis).toBe(true);
  });

  it("refuse une periode inversee", () => {
    // Meme defaut que la designation inutilisable, autre cause : une delegation qui
    // n'agit jamais.
    expect(designationPermise(dd({
      debutLe: new Date("2026-12-01T00:00:00.000Z"),
      finLe: new Date("2026-11-01T00:00:00.000Z"),
    }))).toEqual({ permis: false, motif: "PERIODE_INVALIDE" });
  });

  it("refuse un terme egal au debut", () => {
    const t = new Date("2026-12-01T00:00:00.000Z");
    expect(designationPermise(dd({ debutLe: t, finLe: t })).permis).toBe(false);
  });

  it("nomme le droit manquant AVANT l'auto-designation", () => {
    // Qui n'a pas le droit de deleguer n'a pas a apprendre qu'il aurait pu, mais pas sur
    // lui-meme.
    expect(designationPermise(dd({ delegantPeutDeleguer: false, validateurId: "direction-1" })))
      .toEqual({ permis: false, motif: "DROIT_DE_DELEGUER_ABSENT" });
  });
});

describe("Qui peut REVOQUER une delegation", () => {
  it("laisse un ADMIN revoquer n'importe laquelle", () => {
    expect(revocationPermise({
      revocateurId: "admin-1", revocateurRole: "ADMIN", delegueParId: "direction-1",
    })).toBe(true);
  });

  it("laisse un delegant revoquer CELLES QU'IL A ACCORDEES", () => {
    expect(revocationPermise({
      revocateurId: "direction-1", revocateurRole: "GESTIONNAIRE", delegueParId: "direction-1",
    })).toBe(true);
  });

  it("REFUSE a un delegant de defaire la designation d'un pair", () => {
    // Pouvoir defaire celle d'un autre permettrait de vider un domaine de ses validateurs
    // pour s'y substituer, sans jamais rien designer soi-meme.
    expect(revocationPermise({
      revocateurId: "direction-2", revocateurRole: "GESTIONNAIRE", delegueParId: "direction-1",
    })).toBe(false);
  });
});

describe("Les refus de designation s'expliquent a un administrateur", () => {
  it("donne un message pour chaque motif", () => {
    const motifs: RefusDesignation[] = [
      "DROIT_DE_DELEGUER_ABSENT", "AUTO_DESIGNATION",
      "VALIDATEUR_SANS_ROLE_VALIDATEUR", "PERIODE_INVALIDE",
    ];
    for (const m of motifs) {
      expect(EXPLICATIONS_DESIGNATION[m].length, m).toBeGreaterThan(30);
      expect(EXPLICATIONS_DESIGNATION[m], m).not.toMatch(/_|undefined|null|[A-Z]{4,}/);
    }
  });
});

describe("Tous les domaines ne valident pas, et le rapport doit le dire", () => {
  /**
   * CE QUE CE BLOC DEFEND
   *
   * Les sept domaines existent au schema, et `statutValidation` a ete ajoute aux cinq
   * entites patrimoniales. Mais AUCUNE route ne valide un troncon, un ouvrage, un point
   * noir, un poste ou un chantier : la colonne existe et rien ne l'ecrit.
   *
   * Y designer un validateur serait sans effet. Presenter les huit comme equivalents
   * inviterait a combler une case qui ne change rien — pire qu'un manque affiche,
   * puisque cela donnerait le sentiment du travail fait.
   */
  it("compte les defauts, les observations et desormais les PORTIONS", () => {
    // PORTION est entre le 13/10/2026 avec `/api/v2/portions/:id/validation`. Ce test
    // n'enregistre pas une preference : il enregistre un FAIT verifiable, et il doit etre
    // mis a jour le jour ou une route de validation apparait pour un autre domaine. Sans
    // cela, l'ecran de gouvernance continuerait d'annoncer « sans effet » une designation
    // qui en aurait un.
    expect([...DOMAINES_AVEC_CHEMIN_DE_VALIDATION]).toEqual(["DEFAUT", "OBSERVATION", "PORTION"]);
  });

  it("nomme les cinq domaines ou une designation serait sans effet", () => {
    // Toujours cinq, mais ce ne sont plus les memes : les portions en sont sorties.
    expect(domainesSansChemindeValidation()).toEqual([
      "TRONCON", "OUVRAGE", "POINT_NOIR", "POSTE", "CHANTIER",
    ]);
  });

  it("couvre exactement les sept domaines, sans trou ni doublon", () => {
    // Si un domaine etait ajoute sans etre range d'un cote ou de l'autre, le rapport le
    // tairait. Ce test force a y penser.
    const total = DOMAINES_AVEC_CHEMIN_DE_VALIDATION.length + domainesSansChemindeValidation().length;
    expect(total).toBe(DOMAINES_VALIDATION.length);
  });

  it("n'annonce aucun chemin pour un domaine qui n'en a pas", () => {
    for (const d of domainesSansChemindeValidation()) {
      expect(DOMAINES_AVEC_CHEMIN_DE_VALIDATION, d).not.toContain(d);
    }
  });
});
