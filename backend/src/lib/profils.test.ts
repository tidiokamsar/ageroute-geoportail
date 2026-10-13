import { describe, expect, it } from "vitest";
import { PROFILS_METIER, profilParCode, effetDuProfil, profilsAArbitrer } from "./profils";
import { MODULE_KEYS } from "./modules";

/**
 * Les onze profils metier : ce que ces tests defendent.
 *
 * LE PROBLEME
 *
 * Le paragraphe 5 du cahier RAI V3.1 decrit ONZE profils. L'application connait QUATRE
 * roles. Aucun mapping n'etait ecrit nulle part : creer un compte « Ingenieur reseau »
 * consistait a choisir un role au jugement, sans trace de ce qu'on avait voulu dire.
 *
 * CE QUI EST VERBATIM, ET CE QUI EST UNE PROPOSITION
 *
 * Les libelles et les usages sont repris MOT POUR MOT du cahier : ils disent ce qui a ete
 * commande, et un test les fige pour qu'une reecriture bien intentionnee ne les deforme
 * pas. Les roles et les modules sont des PROPOSITIONS, et les tests ci-dessous verifient
 * leur coherence interne — pas leur justesse metier, que seul AGEROUTE peut trancher.
 */

describe("Les onze profils du cahier, et seulement eux", () => {
  it("en compte exactement onze", () => {
    expect(PROFILS_METIER).toHaveLength(11);
  });

  it("reprend les libelles MOT POUR MOT du paragraphe 5", () => {
    // Fige le verbatim. Si quelqu'un « ameliore » un libelle, le lien avec le document
    // contractuel se rompt sans que rien ne le signale.
    expect(PROFILS_METIER.map((p) => p.libelle)).toEqual([
      "Administrateur plateforme",
      "Administrateur SIG",
      "Agent terrain",
      "Coordonnateur",
      "Ingénieur réseau",
      "Entretien & Maintenance",
      "Planification",
      "Contrôle de gestion",
      "Direction Technique",
      "Direction Générale",
      "Auditeur",
    ]);
  });

  it("porte pour chacun la phrase d'usage du cahier", () => {
    for (const p of PROFILS_METIER) {
      expect(p.usages.length, p.code).toBeGreaterThan(10);
      // Le cahier ponctue chaque usage ; une phrase tronquee se verrait ici.
      expect(p.usages.endsWith("."), p.code).toBe(true);
    }
  });

  it("donne a chacun un code stable et distinct", () => {
    const codes = PROFILS_METIER.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c, c).toMatch(/^[A-Z][A-Z_]*$/);
  });

  it("se retrouve par son code, et refuse un code inconnu", () => {
    expect(profilParCode("AGENT_TERRAIN")?.libelle).toBe("Agent terrain");
    expect(profilParCode("AGENT")).toBeUndefined();
    expect(profilParCode("")).toBeUndefined();
  });
});

describe("Les propositions de correspondance sont coherentes", () => {
  it("n'utilise QUE des modules qui existent", () => {
    // Un module mal orthographie n'echouerait nulle part : il serait simplement absent de
    // la liste autorisee, et le compte perdrait un acces sans qu'on comprenne pourquoi.
    for (const p of PROFILS_METIER) {
      for (const m of p.modules) {
        expect(MODULE_KEYS, `${p.code} / ${m}`).toContain(m);
      }
    }
  });

  it("n'attribue aucun module a l'administrateur plateforme", () => {
    // Son role ne connait AUCUNE restriction de module : lui en lister serait trompeur,
    // et laisserait croire qu'on peut lui en retirer.
    const admin = profilParCode("ADMIN_PLATEFORME");
    expect(admin?.role).toBe("ADMIN");
    expect(admin?.modules).toEqual([]);
  });

  it("n'accorde le role ADMIN qu'a l'administrateur plateforme", () => {
    // C'est le seul profil dont l'usage est « utilisateurs, roles, parametres, securite ».
    // Tout autre profil ADMIN serait une elevation de privilege deguisee en prereglage.
    const admins = PROFILS_METIER.filter((p) => p.role === "ADMIN");
    expect(admins.map((p) => p.code)).toEqual(["ADMIN_PLATEFORME"]);
  });

  it("DONNE GESTIONNAIRE A LA DIRECTION TECHNIQUE, parce que le code l'exige", () => {
    // `ROLES_VALIDATEURS` dans `governance/validation.ts` n'admet que ADMIN et
    // GESTIONNAIRE. Un profil dont l'usage est « validation et arbitrage technique » ne
    // peut pas etre LECTEUR sans etre contredit par le code au premier clic.
    expect(profilParCode("DIRECTION_TECHNIQUE")?.role).toBe("GESTIONNAIRE");
  });

  it("donne a tout profil non-ADMIN au moins un module", () => {
    // Une liste vide vaut « aucun acces » depuis la correction du 05/09/2026. Un profil
    // sans module creerait donc un compte qui ne peut rien ouvrir, ce qui n'est le voeu
    // d'aucune des onze lignes du cahier.
    for (const p of PROFILS_METIER) {
      if (p.role === "ADMIN") continue;
      expect(p.modules.length, p.code).toBeGreaterThan(0);
    }
  });

  it("ne liste jamais deux fois le meme module", () => {
    for (const p of PROFILS_METIER) {
      expect(new Set(p.modules).size, p.code).toBe(p.modules.length);
    }
  });

  it("donne a tous l'acces au tableau de bord et au geoportail", () => {
    // Aucune des onze lignes ne decrit un usage qui se passerait de voir la carte.
    for (const p of PROFILS_METIER) {
      if (p.role === "ADMIN") continue;
      expect(p.modules, p.code).toContain("geoportail");
      expect(p.modules, p.code).toContain("dashboard");
    }
  });
});

describe("Ce qui reste a arbitrer est DIT, pas enterre", () => {
  it("signale les profils dont la correspondance n'est pas tranchee", () => {
    // Le point le plus important de ce fichier. Un mapping propose qui se presenterait
    // comme etabli ferait prendre mes deductions pour des decisions d'AGEROUTE.
    const codes = profilsAArbitrer().map((p) => p.code);
    expect(codes).toEqual([
      "ADMIN_SIG",
      "COORDONNATEUR",
      "CONTROLE_GESTION",
      "DIRECTION_GENERALE",
      "AUDITEUR",
    ]);
  });

  it("explique CHAQUE arbitrage en toutes lettres", () => {
    for (const p of profilsAArbitrer()) {
      expect(p.aArbitrer!.length, p.code).toBeGreaterThan(60);
      // Une question, pas un code d'erreur : cette phrase s'affiche a un administrateur.
      expect(p.aArbitrer!, p.code).not.toMatch(/_|\bundefined\b|\bnull\b/);
    }
  });

  it("retient la delegation du coordonnateur comme non implementee", () => {
    // « Validation selon delegation » n'a aucun equivalent dans le code : la validation
    // est ouverte a tout GESTIONNAIRE, sans perimetre ni delegation.
    expect(profilParCode("COORDONNATEUR")?.aArbitrer).toMatch(/delegation/i);
  });

  it("retient l'absence de journal global pour l'auditeur", () => {
    // `/api/audit` exige entityType et entityId : l'historique se lit par entite. Aucune
    // vue de journal GLOBAL n'existe, que « consultation des journaux » suppose pourtant.
    expect(profilParCode("AUDITEUR")?.aArbitrer).toMatch(/global/i);
  });
});

describe("Un profil n'est qu'un prereglage de champs qui existent deja", () => {
  it("rend le role, les modules et le droit de deleguer, et rien d'autre", () => {
    // Aucune colonne `profil` n'est ajoutee au modele : un profil applique puis modifie a
    // la main ne doit pas continuer d'afficher un nom qui ne correspond plus a ce que le
    // compte peut faire. Le droit de deleguer a rejoint cette liste le 13/10/2026, pour la
    // meme raison : c'est un effet durable, pas une etiquette.
    const effet = effetDuProfil(profilParCode("AGENT_TERRAIN")!);
    expect(Object.keys(effet).sort()).toEqual([
      "modulesAutorises", "peutDeleguerValidation", "role",
    ]);
    expect(effet.role).toBe("INSPECTEUR");
    expect(effet.modulesAutorises).toContain("inspections");
  });

  it("n'accorde le droit de DESIGNER qu'a la Direction Technique", () => {
    // Le paragraphe 35 dit qu'un validateur est designe, pas par qui. AGEROUTE a tranche
    // le 13/10/2026. Ce test empeche le droit de se repandre : six profils sur onze sont
    // GESTIONNAIRE, et un controle de role l'aurait donne a tous.
    const avecDroit = PROFILS_METIER.filter((p) => p.peutDeleguerValidation === true);
    expect(avecDroit.map((p) => p.code)).toEqual(["DIRECTION_TECHNIQUE"]);
  });

  it("POSE TOUJOURS le droit, meme a false", () => {
    // Le cas qui compte. Omettre le `false` laisserait un compte conserver le droit de
    // deleguer apres qu'on lui a applique un profil qui ne l'accorde pas — un privilege
    // survivant a un changement de fonction, ce qu'un prereglage doit empecher.
    expect(effetDuProfil(profilParCode("AGENT_TERRAIN")!).peutDeleguerValidation).toBe(false);
    expect(effetDuProfil(profilParCode("AUDITEUR")!).peutDeleguerValidation).toBe(false);
    expect(effetDuProfil(profilParCode("DIRECTION_TECHNIQUE")!).peutDeleguerValidation).toBe(true);
  });

  it("rend une COPIE des modules, pas la liste partagee", () => {
    // Rendre la liste du profil permettrait a un appelant de la modifier et de changer le
    // prereglage pour tous les comptes suivants, dans le meme processus.
    const a = effetDuProfil(profilParCode("AGENT_TERRAIN")!);
    a.modulesAutorises.push("marches");
    const b = effetDuProfil(profilParCode("AGENT_TERRAIN")!);
    expect(b.modulesAutorises).not.toContain("marches");
  });
});
