import { describe, expect, it } from "vitest";
import { hasModuleAccess, moduleForPath, MODULES } from "./modules";

/**
 * Garde-fou de navigation cote interface.
 *
 * Il ne remplace PAS le controle du serveur — c'est le backend qui fait autorite,
 * et trois failles y ont ete corrigees precisement parce que l'interface seule ne
 * protege rien. Mais sa semantique doit rester identique a celle du serveur : une
 * divergence entre les deux produirait soit un ecran refuse a tort, soit un menu
 * promettant un module que l'API refusera.
 */

describe("hasModuleAccess — même règle que le serveur", () => {
  it("un ADMIN n'est jamais restreint, quelle que soit sa liste", () => {
    expect(hasModuleAccess(["troncons"], "ADMIN", "marches")).toBe(true);
    expect(hasModuleAccess([], "ADMIN", "marches")).toBe(true);
  });

  it("une liste vide vaut AUCUN module pour un non-ADMIN (serveur : backend/src/lib/access.ts, correction du 05/09/2026)", () => {
    // E2E-EO-3 : le client lisait « vide = tout autorise » alors que le serveur refuse tout. Un compte dont personne n'a
    // encore choisi les modules voyait donc tous les menus et ne recevait que des refus.
    for (const role of ["GESTIONNAIRE", "INSPECTEUR", "LECTEUR"]) {
      for (const m of MODULES) expect(hasModuleAccess([], role, m.key), `${role} ${m.key}`).toBe(false);
    }
  });

  it("une liste absente (profil sans le champ) vaut aucun module : on echoue ferme, comme le serveur pour un compte inconnu", () => {
    expect(hasModuleAccess(undefined, "GESTIONNAIRE", "marches")).toBe(false);
    expect(hasModuleAccess(undefined, undefined, "marches")).toBe(false);
    expect(hasModuleAccess([], undefined, "dashboard")).toBe(false);
  });

  it("ADMIN reste le seul role exempte, y compris liste absente", () => {
    expect(hasModuleAccess(undefined, "ADMIN", "teledetection")).toBe(true);
    for (const role of ["GESTIONNAIRE", "INSPECTEUR", "LECTEUR", "admin", ""]) expect(hasModuleAccess([], role, "teledetection")).toBe(false);
  });

  it("l'acces a un module ne depend que de la presence de sa cle (pas de prefixe, pas de casse)", () => {
    expect(hasModuleAccess(["teledetection"], "LECTEUR", "teledetection")).toBe(true);
    expect(hasModuleAccess(["tele"], "LECTEUR", "teledetection")).toBe(false);
    expect(hasModuleAccess(["Teledetection"], "LECTEUR", "teledetection")).toBe(false);
  });

  it("une liste renseignée restreint à ce qu'elle contient", () => {
    expect(hasModuleAccess(["troncons"], "GESTIONNAIRE", "troncons")).toBe(true);
    expect(hasModuleAccess(["troncons"], "GESTIONNAIRE", "marches")).toBe(false);
  });

  it("un module absent de la liste est refusé quel que soit le rôle non-ADMIN", () => {
    for (const role of ["GESTIONNAIRE", "INSPECTEUR", "LECTEUR"]) {
      expect(hasModuleAccess(["troncons"], role, "ouvrages")).toBe(false);
    }
  });
});

describe("moduleForPath — résolution du module depuis l'URL", () => {
  it("associe la racine au tableau de bord", () => {
    expect(moduleForPath("/")).toBe("dashboard");
  });

  it("associe chaque module déclaré à son chemin", () => {
    for (const m of MODULES) {
      if (m.path === "/") continue;
      expect(moduleForPath(m.path)).toBe(m.key);
    }
  });

  it("retient le préfixe le plus long", () => {
    // "/rapports/bailleur" ne doit pas etre resolu par un prefixe plus court qui
    // matcherait aussi : c'est ainsi qu'une sous-page se retrouverait rattachee au
    // mauvais module, donc gardee par le mauvais droit.
    expect(moduleForPath("/rapports/bailleur")).toBe("rapports");
    expect(moduleForPath("/inspections/terrain")).toBe("inspections");
  });

  it("ne rattache à aucun module les pages gérées par le rôle seul", () => {
    // utilisateurs et administration sont strictement ADMIN, sans module
    // configurable — cf. backend/src/lib/modules.ts.
    expect(moduleForPath("/utilisateurs")).toBeUndefined();
    expect(moduleForPath("/administration")).toBeUndefined();
    expect(moduleForPath("/login")).toBeUndefined();
  });

  it("ne rattache pas une URL inconnue à un module au hasard", () => {
    expect(moduleForPath("/page-inexistante")).toBeUndefined();
  });

  it("ne confond pas un chemin qui commence par le même texte", () => {
    // "/tronconsXYZ" n'est pas "/troncons" : sans la verification du separateur,
    // une URL voisine heriterait du droit d'un autre module.
    expect(moduleForPath("/tronconsXYZ")).toBeUndefined();
  });
});
