import { describe, expect, it } from "vitest";
import { perimetre, transitionPermise, TRANSITIONS } from "../field/missions.regles";

/**
 * Le controle de PERIMETRE et le cycle de vie des missions.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Section 16 du cahier des charges : les API v2 sont « protegees par RBAC et controle
 * de perimetre ». Les deux ne sont pas la meme chose, et c'est la confusion entre les
 * deux qui produit les fuites.
 *
 * Le ROLE dit ce qu'on a le droit de faire. Le PERIMETRE dit sur quoi. Deux agents de
 * terrain portent le meme role et ne doivent pas voir les missions l'un de l'autre :
 * aucune verification de role ne les separera jamais.
 *
 * Cette regle ne se voit pas en lisant une route — elle tient a un objet `where`
 * passe a Prisma, qu'on oublie facilement sur un acces direct par identifiant alors
 * qu'on y a pense pour la liste. Elle est donc testee a part.
 */

const agent = { id: "agent-1", role: "INSPECTEUR" };
const autre = { id: "agent-2", role: "INSPECTEUR" };
const gestionnaire = { id: "g-1", role: "GESTIONNAIRE" };
const admin = { id: "a-1", role: "ADMIN" };

describe("Qui voit quelles missions", () => {
  it("un ADMIN voit tout, sans restriction de propriete", () => {
    expect(perimetre(admin)).toEqual({ deletedAt: null });
  });

  it("un GESTIONNAIRE pilote, donc voit tout aussi", () => {
    expect(perimetre(gestionnaire)).toEqual({ deletedAt: null });
  });

  it("un agent ne voit QUE ce qui le concerne", () => {
    const p = perimetre(agent) as unknown as { OR: Array<Record<string, string>> };
    expect(p.OR).toEqual([{ assigneId: "agent-1" }, { createurId: "agent-1" }]);
  });

  it("le perimetre d'un agent ne mentionne jamais un autre agent", () => {
    // Formule naive mais decisive : si l'identifiant d'un tiers apparaissait dans la
    // clause, la fuite serait ouverte.
    expect(JSON.stringify(perimetre(agent))).not.toContain(autre.id);
  });

  it("ecarte toujours les missions archivees", () => {
    // Une mission supprimee logiquement reste en base. L'oublier ici la ferait
    // reapparaitre dans les listes, et la suppression ne voudrait plus rien dire.
    for (const u of [agent, gestionnaire, admin]) {
      expect(perimetre(u)).toHaveProperty("deletedAt", null);
    }
  });

  it("ne laisse pas un role inconnu passer pour un pilote", () => {
    // Un role ajoute demain — le cahier des charges en decrit neuf, le systeme en
    // connait quatre — doit tomber du cote restreint, jamais du cote ouvert.
    const p = perimetre({ id: "x", role: "CHEF_DE_SERVICE" }) as unknown as { OR?: unknown };
    expect(p.OR).toBeDefined();
  });
});

describe("Le cycle de vie d'une mission", () => {
  it("laisse une mission suivre son cours normal", () => {
    const chemin = ["BROUILLON", "PLANIFIEE", "TELECHARGEE", "EN_COURS", "TERMINEE"];
    for (let i = 1; i < chemin.length; i++) {
      expect(transitionPermise(chemin[i - 1], chemin[i]), `${chemin[i - 1]} vers ${chemin[i]}`).toBe(true);
    }
  });

  it("interdit de ressusciter une mission terminee ou annulee", () => {
    // Une mission « terminee » qui repasse « en cours » sans trace fait mentir tout
    // tableau de bord qui la compte.
    expect(transitionPermise("TERMINEE", "EN_COURS")).toBe(false);
    expect(transitionPermise("ANNULEE", "PLANIFIEE")).toBe(false);
    expect(TRANSITIONS.ANNULEE).toEqual([]);
  });

  it("interdit de sauter la planification", () => {
    expect(transitionPermise("BROUILLON", "EN_COURS")).toBe(false);
    expect(transitionPermise("BROUILLON", "TERMINEE")).toBe(false);
  });

  it("permet le va-et-vient entre terminee et synchronisation en attente", () => {
    // Une mission peut etre finie sur le terrain alors que l'appareil n'a pas encore
    // vide sa file. Les deux etats doivent pouvoir s'enchainer dans les deux sens.
    expect(transitionPermise("TERMINEE", "SYNC_EN_ATTENTE")).toBe(true);
    expect(transitionPermise("SYNC_EN_ATTENTE", "TERMINEE")).toBe(true);
  });

  it("laisse annuler depuis tout etat actif, et seulement ceux-la", () => {
    for (const actif of ["BROUILLON", "PLANIFIEE", "TELECHARGEE", "EN_COURS", "SUSPENDUE"]) {
      expect(transitionPermise(actif, "ANNULEE"), `annuler depuis ${actif}`).toBe(true);
    }
    expect(transitionPermise("TERMINEE", "ANNULEE")).toBe(false);
  });

  it("refuse un statut inconnu plutot que de le laisser passer", () => {
    expect(transitionPermise("EN_COURS", "TERMINE")).toBe(false);  // faute de frappe
    expect(transitionPermise("INVENTE", "EN_COURS")).toBe(false);
  });

  it("ne permet aucune transition vers soi-meme", () => {
    // Rejouer un statut semble anodin, mais cela reecrirait les horodatages reels
    // poses par la transition : un second passage « EN_COURS » effacerait l'heure du
    // vrai depart.
    for (const s of Object.keys(TRANSITIONS)) {
      expect(transitionPermise(s, s), `${s} vers lui-meme`).toBe(false);
    }
  });
});
