import { vi } from "vitest";

/**
 * Espionne `addEventListener` / `removeEventListener` de `window` et de `document` : un ecouteur pose sans etre retire retient son
 * proprietaire (donc, apres le depart de la page, tout un arbre DOM). Ce fichier n'est importe que par des tests.
 */
export interface Espion { ajouts: { cible: string; type: string; fn: unknown; capture: boolean }[]; retraits: { cible: string; type: string; fn: unknown; capture: boolean }[] }

const capture = (o: unknown) => (typeof o === "boolean" ? o : typeof o === "object" && o !== null ? Boolean((o as { capture?: boolean }).capture) : false);

export function espionnerEcouteurs(): Espion {
  const espion: Espion = { ajouts: [], retraits: [] };
  for (const [nom, cible] of [["window", window], ["document", document]] as const) {
    const ajouter = cible.addEventListener.bind(cible) as typeof cible.addEventListener;
    const retirer = cible.removeEventListener.bind(cible) as typeof cible.removeEventListener;
    vi.spyOn(cible, "addEventListener").mockImplementation((type: string, fn: unknown, o?: unknown) => {
      espion.ajouts.push({ cible: nom, type, fn, capture: capture(o) });
      return (ajouter as (...a: unknown[]) => void)(type, fn, o);
    });
    vi.spyOn(cible, "removeEventListener").mockImplementation((type: string, fn: unknown, o?: unknown) => {
      espion.retraits.push({ cible: nom, type, fn, capture: capture(o) });
      return (retirer as (...a: unknown[]) => void)(type, fn, o);
    });
  }
  return espion;
}

/** Ecouteurs du cadre de test (React, Testing Library, jsdom) : poses une fois pour le document ou la fenetre, jamais par un composant de l'ecran. */
const BRUIT_DU_CADRE = new Set(["selectionchange", "error", "mouseover", "mouseout"]);

/** Les ajouts sans retrait correspondant (meme cible, type, fonction et phase). */
export function ecouteursOrphelins(e: Espion): string[] {
  const restants = [...e.retraits];
  const orphelins: string[] = [];
  for (const a of e.ajouts) {
    if (BRUIT_DU_CADRE.has(a.type)) continue;
    const i = restants.findIndex((r) => r.cible === a.cible && r.type === a.type && r.fn === a.fn && r.capture === a.capture);
    if (i === -1) orphelins.push(`${a.cible}.${a.type}`); else restants.splice(i, 1);
  }
  return orphelins;
}
