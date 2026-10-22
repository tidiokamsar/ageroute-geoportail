import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePositionGps } from "./usePositionGps";

/**
 * Le suivi GPS : ce que ces tests défendent.
 *
 * TROIS ÉCHECS DISTINCTS. Un refus d'autorisation et un signal absent appellent des gestes
 * opposés : aller dans les réglages, ou sortir du bâtiment. Les confondre en un seul
 * message fait perdre du temps sur le terrain, et c'est ce que font les trois pages qui
 * appellent `getCurrentPosition` aujourd'hui.
 *
 * LA PRÉCISION EST UNE INCERTITUDE. Elle s'améliore en DIMINUANT. Un signe inversé ferait
 * annoncer « précision dégradée » à un agent qui vient de sortir et dont le GPS s'est
 * verrouillé, donc l'inviterait à attendre alors qu'il peut relever.
 *
 * LA VEILLE DOIT S'ARRÊTER. Une veille oubliée consomme le GPS après que l'agent a quitté
 * l'écran, sur un téléphone qui doit tenir une journée de mission.
 */

type Succes = (p: { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }) => void;
type Echec = (e: { code: number }) => void;

const h = vi.hoisted(() => ({
  succes: null as Succes | null,
  echec: null as Echec | null,
  veilles: 0,
  effacees: [] as number[],
}));

function geolocation() {
  return {
    watchPosition: vi.fn((s: Succes, e: Echec) => {
      h.succes = s;
      h.echec = e;
      h.veilles += 1;
      return h.veilles;
    }),
    clearWatch: vi.fn((id: number) => { h.effacees.push(id); }),
    getCurrentPosition: vi.fn(),
  };
}

function point(accuracy: number, lat = 9.5, lon = -13.7) {
  return { coords: { latitude: lat, longitude: lon, accuracy }, timestamp: 1_000 };
}

beforeEach(() => {
  h.succes = null;
  h.echec = null;
  h.veilles = 0;
  h.effacees = [];
  Object.defineProperty(navigator, "geolocation", { value: geolocation(), configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Démarrer le suivi", () => {
  it("attend le premier point, puis le rend avec sa précision", () => {
    const { result } = renderHook(() => usePositionGps());
    expect(result.current.actif).toBe(false);

    act(() => result.current.demarrer());
    expect(result.current.enAttente).toBe(true);
    expect(result.current.position).toBeNull();

    act(() => h.succes?.(point(6.4)));
    expect(result.current.enAttente).toBe(false);
    expect(result.current.position).toMatchObject({ lat: 9.5, lon: -13.7, precisionM: 6 });
  });

  it("ne descend JAMAIS sous un mètre de précision annoncée", () => {
    // Aucun GPS grand public ne fait mieux, et zéro ferait diviser par zéro côté serveur.
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.succes?.(point(0.2)));
    expect(result.current.position?.precisionM).toBe(1);
  });

  it("n'ouvre PAS une seconde veille si une tourne déjà", () => {
    // La première resterait active sans personne pour l'arrêter.
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => result.current.demarrer());
    expect(h.veilles).toBe(1);
  });
});

describe("Les trois échecs ne se confondent pas", () => {
  it("distingue un REFUS d'autorisation", () => {
    // Celui-là se corrige dans les réglages du navigateur, nulle part ailleurs.
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.echec?.({ code: 1 }));
    expect(result.current.erreur).toBe("REFUSEE");
    expect(result.current.enAttente).toBe(false);
  });

  it("un REFUS termine la veille (le navigateur n'enverra plus de point) et permet de relancer", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.echec?.({ code: 1 }));
    expect(result.current.erreur).toBe("REFUSEE");
    expect(result.current.actif).toBe(false);
    expect(h.effacees).toEqual([1]);
    act(() => result.current.demarrer());                  // l'autorisation a ete rendue dans les reglages
    expect(h.veilles).toBe(2);
    expect(result.current.erreur).toBeNull();
    expect(result.current.actif).toBe(true);
  });

  it("un signal INDETERMINE ne termine PAS la veille : le point peut encore arriver", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.echec?.({ code: 3 }));
    expect(result.current.actif).toBe(true);
    expect(h.effacees).toEqual([]);
  });

  it("distingue un signal INDÉTERMINÉ", () => {
    // Celui-là se corrige en sortant ou en attendant.
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.echec?.({ code: 3 }));
    expect(result.current.erreur).toBe("INDETERMINEE");
  });

  it("distingue un appareil SANS géolocalisation, sans ouvrir de veille", () => {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    expect(result.current.erreur).toBe("INDISPONIBLE");
    expect(result.current.actif).toBe(false);
  });

  it("efface l'erreur dès qu'un point arrive", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.echec?.({ code: 3 }));
    act(() => h.succes?.(point(8)));
    expect(result.current.erreur).toBeNull();
  });
});

describe("L'évolution de la précision", () => {
  it("dit AMELIORE quand l'incertitude DIMINUE", () => {
    // Le signe compte : la précision est une incertitude, elle s'améliore en baissant.
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.succes?.(point(60)));
    act(() => h.succes?.(point(8)));
    expect(result.current.tendance).toBe("AMELIORE");
  });

  it("dit DEGRADE quand l'incertitude augmente", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.succes?.(point(6)));
    act(() => h.succes?.(point(45)));
    expect(result.current.tendance).toBe("DEGRADE");
  });

  it("dit STABLE pour une variation dans le bruit", () => {
    // Deux mètres d'écart sont le bruit normal : les annoncer ferait clignoter l'écran.
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.succes?.(point(7)));
    act(() => h.succes?.(point(8)));
    expect(result.current.tendance).toBe("STABLE");
  });

  it("dit INCONNUE sur un seul relevé, au lieu de supposer", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => h.succes?.(point(10)));
    expect(result.current.tendance).toBe("INCONNUE");
  });

  it("ne garde que les cinq derniers relevés", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    for (const p of [50, 40, 30, 20, 10, 9]) act(() => h.succes?.(point(p)));
    expect(result.current.historiquePrecisionM).toEqual([40, 30, 20, 10, 9]);
  });
});

describe("Arrêter le suivi", () => {
  it("efface la veille quand on l'arrête", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => result.current.arreter());
    expect(h.effacees).toEqual([1]);
    expect(result.current.actif).toBe(false);
  });

  it("efface la veille AU DÉMONTAGE, sans qu'on y pense", () => {
    // Le cas qui vide une batterie : l'agent quitte l'écran et le GPS continue.
    const { result, unmount } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    unmount();
    expect(h.effacees).toEqual([1]);
  });

  it("permet de redémarrer après un arrêt", () => {
    const { result } = renderHook(() => usePositionGps());
    act(() => result.current.demarrer());
    act(() => result.current.arreter());
    act(() => result.current.demarrer());
    expect(h.veilles).toBe(2);
    expect(result.current.actif).toBe(true);
  });
});
