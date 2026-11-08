/**
 * Conflits de synchronisation : types rendus par `GET /v2/sync/conflits` et comparatif des deux versions.
 *
 * Les formes sont celles de la route (`backend/src/api-v2/sync.routes.ts`) ; rien n'est ajoute ici.
 */

export interface ConflitSync {
  id: string;
  operationId: string;
  entityType: string;
  entityId: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | null;
  motif: string | null;
  creeLe: string;
  agent: { id: string; nomComplet: string | null } | null;
  appareil: { id: string; nom: string; plateforme: string | null } | null;
  /** Ce que le telephone a envoye, tel quel. */
  payloadLocal: Record<string, unknown>;
  /** Ce que le serveur portait au moment du conflit. */
  payloadServeur: Record<string, unknown>;
  resolutionsPossibles: { SERVEUR: true; LOCAL: boolean; motifLocalImpossible: string | null };
  verificationDemandee: { le: string; parId: string | null; motif: string | null } | null;
}

export interface ReponseConflits {
  conflits: ConflitSync[];
  total: number;
  tronque: boolean;
}

export function formaterValeur(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "(vide)";
  if (typeof v === "string") return v === "" ? "(vide)" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export interface LigneComparatif {
  champ: string;
  local: string;
  serveur: string;
  /** Vrai si le telephone affirme une valeur que le serveur ne porte pas. */
  different: boolean;
}

/**
 * Lignes du comparatif : chaque champ que le telephone a envoye, face a ce que le serveur porte, plus la
 * version du serveur. Pour une modification, le telephone n'envoie que ce qu'il change : les autres champs ne
 * sont pas listes (ils ne sont pas en jeu), et le serveur les garde.
 */
export function lignesComparatif(c: Pick<ConflitSync, "payloadLocal" | "payloadServeur" | "operation">): LigneComparatif[] {
  const local = c.payloadLocal ?? {};
  const serveur = c.payloadServeur ?? {};
  const noms = Object.keys(local);
  if (!noms.includes("version") && serveur.version !== undefined) noms.push("version");
  return noms.map((champ) => {
    const envoye = champ in local;
    return {
      champ,
      local: envoye ? formaterValeur(local[champ]) : "(non touché par le téléphone)",
      serveur: formaterValeur(serveur[champ]),
      different: envoye && formaterValeur(local[champ]) !== formaterValeur(serveur[champ]),
    };
  });
}
