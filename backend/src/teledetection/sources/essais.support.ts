/**
 * Outils des tests du moteur de catalogue : chargement des fixtures REELLES et faux `fetch`.
 * Ce fichier n'est pas un test (aucune assertion) et n'est importe que par les *.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "./http";

export interface EnteteFixture {
  capturee: string;
  reel: true;
  source: string;
  description?: string;
  params?: Record<string, unknown>;
  requete: { methode: string; url: string; corps: Record<string, unknown> | null };
  reduction: string;
}

export interface Fixture {
  _fixture: EnteteFixture;
  reponse: any;
  suite?: { requete: { methode: string; url: string; corps: Record<string, unknown> | null }; reponse: any };
}

const DOSSIER = join(__dirname, "__fixtures__");

export function charger(nom: string): Fixture {
  return JSON.parse(readFileSync(join(DOSSIER, nom), "utf8")) as Fixture;
}

export function reponseJson(corps: unknown, statut = 200, entetes: Record<string, string> = {}): Response {
  return new Response(typeof corps === "string" ? corps : JSON.stringify(corps), {
    status: statut, headers: { "content-type": "application/json", ...entetes },
  });
}

export interface Appel {
  url: string;
  methode: string;
  corps: any;
  entetes: Record<string, string>;
}

type Etape = Response | Error | ((appel: Appel) => Response | Promise<Response>);

/**
 * Faux fetch a scenario : chaque appel consomme l'etape suivante (la derniere se repete). Un test
 * qui declenche plus d'appels que prevu le voit dans `appels`.
 */
export function fetchScenario(...etapes: Etape[]): { fetch: FetchLike; appels: Appel[] } {
  const appels: Appel[] = [];
  const fetch: FetchLike = async (url, init) => {
    const appel: Appel = { url, methode: init.method, corps: init.body ? JSON.parse(init.body) : null, entetes: init.headers };
    appels.push(appel);
    const e = etapes[Math.min(appels.length - 1, etapes.length - 1)];
    if (e instanceof Error) throw e;
    if (typeof e === "function") return e(appel);
    // une Response ne se lit qu'une fois : on en rend une copie a chaque appel
    return e.clone();
  };
  return { fetch, appels };
}

/** Sommeil factice : ne dort pas, memorise les attentes demandees. */
export function sommeilFactice(): { sleep: (ms: number) => Promise<void>; attentes: number[] } {
  const attentes: number[] = [];
  return { sleep: async (ms) => { attentes.push(ms); }, attentes };
}

/** Horloge factice qui avance de `pas` ms a chaque lecture. */
export function horloge(depart: string, pas = 0): () => number {
  let t = Date.parse(depart);
  return () => { const v = t; t += pas; return v; };
}
