import { beforeEach, describe, expect, it, vi } from "vitest";
import { MENTION_SIMULATION } from "./aideDecisionScenarios";
import { CANDIDATS, OPTIONS, comparaisonSim, detailSim, resumeSim, scenarioSim } from "../components/decision/simulation/simulation.fixtures";

const h = vi.hoisted(() => ({
  gets: [] as { url: string; config?: { params?: unknown; responseType?: string } }[],
  posts: [] as { url: string; corps?: unknown }[],
  blob: null as Blob | null,
  entetes: {} as Record<string, string>,
  /** Remplace le corps de la prochaine reponse (JSON) : sert a fabriquer une reponse mal formee. */
  corps: undefined as unknown,
  erreur: null as unknown,
  optionsReponse: null as unknown, candidatsReponse: null as unknown, resumeReponse: null as unknown, detailReponse: null as unknown, scenarioReponse: null as unknown, comparaisonReponse: null as unknown,
}));
vi.mock("./api", () => ({
  api: {
    get: vi.fn(async (url: string, config?: { params?: unknown; responseType?: string }) => {
      h.gets.push({ url, config });
      if (h.erreur) throw h.erreur;
      if (config?.responseType === "blob") return { data: h.blob, headers: h.entetes };
      if (h.corps !== undefined) return { data: h.corps };
      if (url.endsWith("/options")) return { data: h.optionsReponse };
      if (url.endsWith("/candidats")) return { data: h.candidatsReponse };
      if (/\/scenarios$/.test(url)) return { data: { data: [h.resumeReponse], total: 1, page: 1, pageSize: 20 } };
      return { data: h.detailReponse };
    }),
    post: vi.fn(async (url: string, corps?: unknown) => {
      h.posts.push({ url, corps });
      if (h.corps !== undefined) return { data: h.corps };
      if (url.endsWith("/simuler")) return { data: { resultat: h.scenarioReponse, empreinteEntrees: "e", empreinteResultat: "r", enregistre: false } };
      if (url.endsWith("/comparer")) return { data: h.comparaisonReponse };
      if (url.endsWith("/rejouer")) return { data: { identique: true, entreesIntegres: true, empreinteStockee: "a", empreinteRecalculee: "a", explication: "ok" } };
      if (url.endsWith("/supprimer")) return { data: { ok: true, id: "s1" } };
      return { data: { scenario: { id: "s1", intitule: "PAE 2027", creeParId: "u1", creeLe: "2026-10-26T09:00:00.000Z", empreinteEntrees: "e", empreinteResultat: "r", budgetGnf: "5000000000" }, resultat: h.scenarioReponse } };
    }),
  },
}));
// Les reponses valides viennent des fixtures (hors du hoisted : elles importent des modules).
Object.assign(h, { optionsReponse: OPTIONS, candidatsReponse: CANDIDATS, resumeReponse: resumeSim("s1"), detailReponse: detailSim("s1"), scenarioReponse: scenarioSim(), comparaisonReponse: comparaisonSim() });

import {
  ExportSansMention, ReponseInvalide, chargerCandidats, chargerOptions, comparerScenarios, enregistrerScenario, listerScenarios, lireScenario, normaliserErreurBlob, rejouerScenario, simuler,
  supprimerScenario, telechargerExport,
} from "./aideDecisionScenariosApi";

/**
 * Appels du simulateur : bons chemins, bons parametres ; une reponse mal formee est refusee (ReponseInvalide) ; l'erreur d'un export
 * (corps Blob) est relue et dite en francais ; un export qui ne porte pas la mention « simulation non engageante » n'est JAMAIS remis.
 */
beforeEach(() => { h.gets = []; h.posts = []; h.blob = null; h.entetes = {}; h.corps = undefined; h.erreur = null; });

const BASE = "/v2/aide-decision/scenarios";

describe("chemins et parametres", () => {
  it("options (avec ou sans periode), candidats (parametres vides non envoyes)", async () => {
    await chargerOptions({ debut: "2027-01-01", fin: "2027-12-31" });
    await chargerOptions();
    await chargerCandidats({ regionId: 2, classe: "RN" });
    await chargerCandidats({});
    expect(h.gets.map((g) => [g.url, g.config?.params])).toEqual([
      [`${BASE}/options`, { debut: "2027-01-01", fin: "2027-12-31" }],
      [`${BASE}/options`, undefined],
      [`${BASE}/candidats`, { regionId: 2, classe: "RN" }],
      [`${BASE}/candidats`, {}],
    ]);
  });

  it("simuler et enregistrer envoient la demande telle quelle ; l'enregistrement ajoute seulement l'intitule", async () => {
    const d = { annee: 2027, budgetGnf: "5000000000", periode: { debut: "2027-01-01", fin: "2027-12-31" }, logique: "urgence" as const };
    await simuler(d);
    await enregistrerScenario(d, "PAE 2027");
    expect(h.posts).toEqual([{ url: `${BASE}/simuler`, corps: d }, { url: BASE, corps: { ...d, intitule: "PAE 2027" } }]);
    expect(typeof (h.posts[0].corps as { budgetGnf: unknown }).budgetGnf).toBe("string");
  });

  it("liste : filtres vides non envoyes, pagination par defaut", async () => {
    await listerScenarios({ q: "", logique: "" });
    await listerScenarios({ q: "boké", logique: "criticite", annee: 2027, page: 2, pageSize: 10 });
    expect(h.gets.map((g) => g.config?.params)).toEqual([{ page: 1, pageSize: 20 }, { q: "boké", logique: "criticite", annee: 2027, page: 2, pageSize: 10 }]);
  });

  it("detail, rejeu, suppression, comparaison", async () => {
    await lireScenario("s1");
    await rejouerScenario("s1");
    await supprimerScenario("s1");
    await comparerScenarios(["s1", "s2"]);
    expect(h.gets[0].url).toBe(`${BASE}/s1`);
    expect(h.posts.map((p) => p.url)).toEqual([`${BASE}/s1/rejouer`, `${BASE}/s1/supprimer`, `${BASE}/comparer`]);
    expect(h.posts[2].corps).toEqual({ ids: ["s1", "s2"] });
  });
});

describe("reponses mal formees : ReponseInvalide, jamais une exception de rendu", () => {
  const mauvaises: [string, () => Promise<unknown>][] = [
    ["options", () => chargerOptions()],
    ["candidats", () => chargerCandidats({})],
    ["simulation", () => simuler({ annee: 2027, budgetGnf: "1", periode: { debut: "2027-01-01", fin: "2027-12-31" }, logique: "urgence" })],
    ["enregistrement", () => enregistrerScenario({ annee: 2027, budgetGnf: "1", periode: { debut: "2027-01-01", fin: "2027-12-31" }, logique: "urgence" }, "abc")],
    ["liste", () => listerScenarios({})],
    ["detail", () => lireScenario("s1")],
    ["rejeu", () => rejouerScenario("s1")],
    ["comparaison", () => comparerScenarios(["a", "b"])],
  ];
  it.each(mauvaises)("%s : une reponse vide, un texte ou un objet sans les cles attendues est refuse avec une phrase", async (_nom, appel) => {
    for (const corps of [{}, "<html>erreur</html>", null, [], { data: "x" }]) {
      h.corps = corps === null ? null : corps;
      await expect(appel()).rejects.toBeInstanceOf(ReponseInvalide);
    }
    h.corps = {};
    await expect(appel()).rejects.toThrow(/mal formée : elle n'est pas affichée/);
  });

  it("une reponse conforme passe (contre-epreuve : les memes appels reussissent avec des donnees valides)", async () => {
    await expect(chargerOptions()).resolves.toBe(OPTIONS);
    await expect(lireScenario("s1")).resolves.toMatchObject({ simulateur: true });
    await expect(comparerScenarios(["a", "b"])).resolves.toMatchObject({ devise: "GNF" });
  });
});

describe("erreur d'un export (corps Blob) : le message du serveur est relu et dit en francais", () => {
  const erreurBlob = (status: number, corps: string) => ({ message: `Request failed with status code ${status}`, response: { status, data: new Blob([corps], { type: "application/json" }) } });

  it("403 : la phrase du serveur remplace « Request failed with status code 403 »", async () => {
    h.erreur = erreurBlob(403, JSON.stringify({ error: "Accès à ce module non autorisé pour votre compte" }));
    const e = await telechargerExport("abcd1234-0000", "csv").catch((x) => x);
    expect(e.message).toBe("Accès à ce module non autorisé pour votre compte");
    expect(e.message).not.toMatch(/Request failed/);
    expect(e.response).toEqual({ status: 403, data: { error: "Accès à ce module non autorisé pour votre compte" } });
  });

  it("404 et 422 : phrase du serveur (champ error) ; corps non JSON ou sans phrase : phrase par statut, en francais", async () => {
    h.erreur = erreurBlob(422, JSON.stringify({ error: "ce scénario a été calculé avant le simulateur", code: "SCENARIO_SANS_SIMULATION" }));
    expect((await telechargerExport("a", "csv").catch((x) => x)).message).toBe("ce scénario a été calculé avant le simulateur");
    h.erreur = erreurBlob(404, "<html>Not Found</html>");
    expect((await telechargerExport("a", "csv").catch((x) => x)).message).toBe("Scénario introuvable ou supprimé.");
    h.erreur = erreurBlob(403, JSON.stringify({ code: "X" }));
    expect((await telechargerExport("a", "csv").catch((x) => x)).message).toMatch(/module Rapports/);
    h.erreur = erreurBlob(500, "");
    expect((await telechargerExport("a", "csv").catch((x) => x)).message).toBe("L'export a échoué : réessayez dans un instant.");
  });

  it("une erreur sans reponse (reseau) est rendue telle quelle ; une erreur dont le corps est deja du JSON n'est pas modifiee", async () => {
    const reseau = new Error("Network Error");
    expect(await normaliserErreurBlob(reseau)).toBe(reseau);
    const deja = { response: { status: 403, data: { error: "déjà dit" } } };
    expect(await normaliserErreurBlob(deja)).toBe(deja);
  });
});

describe("telechargerExport : refuse un export sans la mention", () => {
  it("remet le fichier avec son nom lorsque la mention est presente (CSV avec BOM, puis JSON)", async () => {
    h.blob = new Blob([`\uFEFF${MENTION_SIMULATION}\nSection;Clé;Valeur`], { type: "text/csv" });
    h.entetes = { "content-disposition": 'attachment; filename="simulation-abcd1234-2026-10-27.csv"' };
    const r = await telechargerExport("abcd1234-0000", "csv");
    expect(r.nom).toBe("simulation-abcd1234-2026-10-27.csv");
    expect(r.blob).toBe(h.blob);
    expect(h.gets[0]).toMatchObject({ url: `${BASE}/abcd1234-0000/export`, config: { params: { format: "csv" }, responseType: "blob" } });
    h.blob = new Blob([JSON.stringify({ mention: MENTION_SIMULATION })], { type: "application/json" });
    h.entetes = {};
    expect((await telechargerExport("abcd1234-0000", "json")).nom).toBe("simulation-abcd1234.json");
  });

  it("MUTATION DE CONTROLE : le meme export sans la mention est refuse (ExportSansMention)", async () => {
    h.blob = new Blob(["Section;Clé;Valeur\nBilan;Déficit (GNF);0"], { type: "text/csv" });
    await expect(telechargerExport("abcd1234-0000", "csv")).rejects.toBeInstanceOf(ExportSansMention);
    await expect(telechargerExport("abcd1234-0000", "csv")).rejects.toThrow(/simulation non engageante/);
    h.blob = new Blob([JSON.stringify({ mention: "simulation approuvée" })], { type: "application/json" });
    await expect(telechargerExport("abcd1234-0000", "json")).rejects.toBeInstanceOf(ExportSansMention);
  });
});
