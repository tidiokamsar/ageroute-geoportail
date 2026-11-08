/**
 * Canal entre les ONGLETS d'un meme appareil (conception : docs/securite/SESSION-HORS-LIGNE.md, section 3).
 *
 * POURQUOI. Le coffre, les bases par compte et le cookie de rafraichissement sont partages par tous les onglets de l'appareil,
 * mais chaque onglet garde SA propre cle de donnees en memoire. Sans signal, un onglet qui a reinitialise le code (ou efface
 * les donnees locales, ou ferme la session, ou ouvert un autre compte) laissait les autres onglets ecrire dans une base
 * recreee, sous une cle desormais indechiffrable (constat de la relecture independante).
 *
 * CE QUE LE CANAL PORTE : un type de message de la liste fermee, l'empreinte du compte concerne (deja visible dans les noms de
 * bases et de cles localStorage) et un identifiant d'emetteur pour que l'onglet n'agisse pas sur son propre message. Jamais de
 * contenu de saisie, jamais d'identifiant de compte en clair, jamais de PIN.
 *
 * TRANSPORT. `BroadcastChannel` quand le navigateur l'a ; sinon l'evenement `storage` (ecriture puis retrait d'une cle
 * localStorage, qui previent les AUTRES documents seulement). Les deux ne livrent jamais un message a son emetteur ; le champ
 * `auteur` couvre en plus un transport qui le ferait.
 *
 * LIMITE. Un message est une demande de fermeture, pas une preuve : un script de la page peut en emettre (il peut deja tout
 * faire dans l'origine). Un onglet qui n'ecoute pas encore (page en cours de chargement) ne recoit rien : il verra l'etat
 * du stockage a son demarrage.
 */
import { empreinteValide } from "./compteLocal";
import { genererUuid } from "./journalEvenementsLocaux";

export const TYPES_MESSAGE_CANAL = ["SESSION_FERMEE", "PIN_REINITIALISE", "EFFACEMENT_LOCAL", "COMPTE_CHANGE"] as const;
export type TypeMessageCanal = (typeof TYPES_MESSAGE_CANAL)[number];

export interface MessageCanal {
  readonly type: TypeMessageCanal;
  /** Empreinte du compte concerne : pour `COMPTE_CHANGE`, celle du compte qui VIENT de s'ouvrir. */
  readonly empreinte: string;
  readonly auteur: string;
}

export interface CanalOnglets {
  readonly auteur: string;
  publier(type: TypeMessageCanal, empreinte: string): void;
  /** S'abonne aux messages des AUTRES onglets. Rend la fonction de desabonnement. */
  ecouter(rappel: (message: MessageCanal) => void): () => void;
  fermer(): void;
}

export const NOM_CANAL = "bdri-session";
export const CLE_CANAL_STORAGE = "bdri.canalSession";

/** Ce que le canal attend de `BroadcastChannel` : de quoi tester sans navigateur. */
export interface BroadcastLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", rappel: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", rappel: (e: { data: unknown }) => void): void;
  close(): void;
}

export interface OptionsCanal {
  /** `null` : pas de BroadcastChannel (repli sur `storage`). Defaut : celui du navigateur s'il existe. */
  readonly fabriqueBroadcast?: ((nom: string) => BroadcastLike) | null;
  /** Stockage du repli. Defaut : localStorage. */
  readonly stockage?: Pick<Storage, "setItem" | "removeItem"> | null;
  /** Cible de l'evenement `storage` du repli. Defaut : window. */
  readonly cible?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
  readonly auteur?: string;
}

const TYPES = new Set<string>(TYPES_MESSAGE_CANAL);

/** Un message venu du reseau local de l'appareil n'est cru que s'il a exactement la forme attendue. */
export function lireMessageCanal(brut: unknown): MessageCanal | null {
  let o: unknown = brut;
  if (typeof brut === "string") {
    try { o = JSON.parse(brut); } catch { return null; }
  }
  if (typeof o !== "object" || o === null) return null;
  const m = o as Record<string, unknown>;
  if (typeof m.type !== "string" || !TYPES.has(m.type) || !empreinteValide(m.empreinte) || typeof m.auteur !== "string" || m.auteur === "") return null;
  return { type: m.type as TypeMessageCanal, empreinte: m.empreinte, auteur: m.auteur };
}

function broadcastParDefaut(): ((nom: string) => BroadcastLike) | null {
  return typeof BroadcastChannel === "undefined" ? null : (nom) => new BroadcastChannel(nom) as unknown as BroadcastLike;
}

function stockageParDefaut(): Pick<Storage, "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function creerCanalOnglets(options: OptionsCanal = {}): CanalOnglets {
  const auteur = options.auteur ?? genererUuid();
  const fabrique = options.fabriqueBroadcast === undefined ? broadcastParDefaut() : options.fabriqueBroadcast;
  let bc: BroadcastLike | null = null;
  try { bc = fabrique ? fabrique(NOM_CANAL) : null; } catch { bc = null; }
  const stockage = options.stockage === undefined ? stockageParDefaut() : options.stockage;
  const cible = options.cible === undefined ? (typeof window === "undefined" ? null : window) : options.cible;
  const abonnes = new Set<(m: MessageCanal) => void>();

  const recevoir = (brut: unknown) => {
    const m = lireMessageCanal(brut);
    if (m === null || m.auteur === auteur) return;
    for (const a of [...abonnes]) {
      try { a(m); } catch { /* un abonne defaillant ne bloque pas les autres */ }
    }
  };
  const surMessage = (e: { data: unknown }) => recevoir(e.data);
  const surStorage = (e: Event) => {
    const s = e as unknown as { key?: string | null; newValue?: string | null };
    if (s.key === CLE_CANAL_STORAGE && typeof s.newValue === "string") recevoir(s.newValue);
  };

  if (bc) bc.addEventListener("message", surMessage);
  else cible?.addEventListener("storage", surStorage);

  return {
    auteur,
    publier(type, empreinte) {
      const message: MessageCanal = { type, empreinte, auteur };
      try {
        if (bc) {
          bc.postMessage(message);
        } else if (stockage) {
          // Un evenement `storage` n'est emis que si la valeur CHANGE : un nombre aleatoire garantit qu'elle change a chaque fois.
          stockage.setItem(CLE_CANAL_STORAGE, JSON.stringify({ ...message, n: genererUuid() }));
          stockage.removeItem(CLE_CANAL_STORAGE);
        }
      } catch { /* canal indisponible : les autres onglets verront l'etat du stockage a leur prochaine action */ }
    },
    ecouter(rappel) {
      abonnes.add(rappel);
      return () => { abonnes.delete(rappel); };
    },
    fermer() {
      abonnes.clear();
      if (bc) {
        bc.removeEventListener("message", surMessage);
        try { bc.close(); } catch { /* deja ferme */ }
      } else {
        cible?.removeEventListener("storage", surStorage);
      }
    },
  };
}
