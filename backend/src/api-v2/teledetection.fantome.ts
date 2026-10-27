/**
 * Base SIMULEE de l'API d'observation de la Terre pour les tests Vitest (aucune base reelle). Les VRAIES gardes
 * (`requireAuth`, `requireModuleAccess`, `requireRole`), les VRAIS services (EO-DB) et le VRAI routeur tournent ; seul `lib/prisma`
 * est remplace par ce faux, qui repond aux requetes que ces services emettent (reconnues par un fragment de leur SQL).
 *
 * CE QUE CE FAUX NE PROUVE PAS : le comportement de PostGIS, des declencheurs et des contraintes. Le banc
 * `tests-integration/eo-api.integration.ts` le prouve sur une vraie base.
 */

export type Ligne = Record<string, unknown>;

/**
 * Le compte simule est ce que `requireAuth` RELIT en base a chaque requete : role, `actif`, `lockedUntil`, courriel (le role du jeton
 * n'est pas lu). Un compte absent de `etat.comptes` est un compte supprime : 401 COMPTE_INACTIF.
 */
export interface CompteSimule { id: string; role: string; email: string; actif: boolean; lockedUntil: Date | null; modulesAutorises: string[]; regions: number[] }

export const etat = {
  comptes: new Map<string, CompteSimule>(),
  propositions: [] as Ligne[],
  produits: [] as Ligne[],
  missions: [] as Ligne[],
  observations: [] as Ligne[],
  /** Preuves rendues par la lecture du detail : { id, date, auteur, type, description, regionId } ; `regionId` sert au calcul de `visible`. */
  lignesPreuves: [] as Ligne[],
  sources: [] as Ligne[],
  audits: [] as Ligne[],
  journal: [] as Ligne[],
  preuves: [] as Ligne[],
  executions: [] as { sql: string; valeurs: unknown[] }[],
  requetes: [] as { sql: string; valeurs: unknown[] }[],
  /** Lignes que rendent les requetes de liste, de detail et de synthese. */
  lignesListe: [] as Ligne[],
  lignesDetail: [] as Ligne[],
  /** Lignes de la vue `coherence_teledetection` (route `/coherence`, reportee du lot 17). */
  lignesCoherence: [] as Ligne[],
  total: 0,
  /** Message de l'erreur que la base leve a la prochaine ecriture (refus de geometrie, panne...). */
  erreurBase: null as string | null,
  /** Panne des LECTURES (liste, synthese...) : doit donner une erreur, jamais un resultat vide. */
  panneLecture: false,
  idsProduitsConnus: new Set<string>(),
};

export function reinitialiser(): void {
  etat.comptes.clear();
  for (const k of ["propositions", "produits", "missions", "observations", "lignesPreuves", "sources", "audits", "journal", "preuves", "executions", "requetes", "lignesListe", "lignesDetail", "lignesCoherence"] as const) etat[k].length = 0;
  etat.total = 0; etat.erreurBase = null; etat.panneLecture = false; etat.idsProduitsConnus.clear();
}

export function ajouterCompte(c: Partial<CompteSimule> & { id: string; role: string }): CompteSimule {
  const compte: CompteSimule = { email: `${c.id}@essai.invalid`, actif: true, lockedUntil: null, modulesAutorises: ["teledetection"], regions: [], ...c };
  etat.comptes.set(compte.id, compte);
  return compte;
}

/** Aplatit les fragments `Prisma.sql` imbriques comme le fait le vrai client : texte avec « ? » et valeurs a plat. */
function aplatir(strings: readonly string[], valeurs: readonly unknown[]): { sql: string; valeurs: unknown[] } {
  let sql = strings[0];
  const sortie: unknown[] = [];
  valeurs.forEach((v, i) => {
    if (v && typeof v === "object" && "strings" in v && "values" in v) {
      const sous = aplatir((v as { strings: string[] }).strings, (v as { values: unknown[] }).values);
      sql += sous.sql; sortie.push(...sous.valeurs);
    } else { sql += "?"; sortie.push(v); }
    sql += strings[i + 1];
  });
  return { sql: sql.replace(/\s+/g, " ").trim(), valeurs: sortie };
}

export function creerPrisma() {
  const delegues = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const c = etat.comptes.get(where.id);
        return c ? { modulesAutorises: c.modulesAutorises, actif: c.actif, lockedUntil: c.lockedUntil, role: c.role, email: c.email } : null;
      },
    },
    earthObservationProduct: {
      findUnique: async ({ where }: { where: { code?: string; id?: string } }) => etat.produits.find((p) => (where.code ? p.code === where.code : p.id === where.id)) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => etat.produits.find((p) => p.id === where.id) ?? { id: where.id },
      findFirst: async ({ where }: { where: { id?: string; identifiantFournisseur?: string } }) =>
        etat.produits.find((p) => (where.id ? p.id === where.id : p.identifiantFournisseur === where.identifiantFournisseur)) ?? (where.identifiantFournisseur ? { id: `connu-${where.identifiantFournisseur}` } : null),
    },
    propositionTeledetection: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => etat.propositions.find((p) => p.id === where.id),
      count: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length,
      updateMany: async ({ where, data }: { where: { id: string; statut: string }; data: Ligne }) => {
        const p = etat.propositions.find((x) => x.id === where.id && x.statut === where.statut);
        if (!p) return { count: 0 };
        Object.assign(p, data); return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Ligne }) => { const p = etat.propositions.find((x) => x.id === where.id)!; Object.assign(p, data); return p; },
    },
    mission: {
      findMany: async () => etat.missions.map((m) => ({ code: m.code })),
      create: async ({ data }: { data: Ligne }) => { const m = { id: `00000000-0000-4000-8000-00000000a${etat.missions.length}`, statut: "BROUILLON", ...data }; etat.missions.push(m); return m; },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => etat.missions.find((m) => m.id === where.id),
    },
    propositionTeledetectionTransition: { create: async ({ data }: { data: Ligne }) => { etat.journal.push(data); return data; } },
    propositionTeledetectionPreuve: {
      createMany: async ({ data }: { data: Ligne[] }) => { etat.preuves.push(...data); return { count: data.length }; },
    },
    observation: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => etat.observations.filter((o) => where.id.in.includes(o.id as string)).map((o) => ({ id: o.id })),
    },
    sourceObservation: {
      findFirst: async ({ where }: { where: { code: string } }) => etat.sources.find((s) => s.code === where.code) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Ligne }) => { const s = etat.sources.find((x) => x.id === where.id)!; Object.assign(s, data); return s; },
    },
    sourceObservationEtat: { create: async ({ data }: { data: Ligne }) => data },
    auditLog: { create: async ({ data }: { data: Ligne }) => { etat.audits.push(data); return data; } },
  };

  const queryRaw = async (strings0: readonly string[], ...valeurs0: unknown[]): Promise<unknown[]> => {
    const { sql, valeurs } = aplatir(strings0, valeurs0);
    etat.requetes.push({ sql, valeurs });
    if (sql.includes('FROM "perimetres_comptes"')) return (etat.comptes.get(valeurs[0] as string)?.regions ?? []).map((regionId) => ({ regionId }));

    // ----- lectures
    if (sql.startsWith('SELECT pt."id", pt."regionId", pt."statut", pt."missionId" FROM "propositions_teledetection" pt WHERE')) {
      const p = etat.propositions.find((x) => x.id === valeurs[0]);
      if (!p) return [];
      if (sql.includes('ANY(') && !(valeurs[1] as number[]).includes(p.regionId as number)) return [];
      return [{ id: p.id, regionId: p.regionId ?? null, statut: p.statut, missionId: p.missionId ?? null }];
    }
    if (etat.panneLecture && (sql.includes("count(*)") || sql.includes('FROM "sources_observation"') || sql.includes("precision_teledetection") || sql.includes("qualite_methodes_eo") || sql.includes("coherence_teledetection"))) {
      throw new Error("panne de lecture simulee");
    }
    if (sql.includes('FROM "propositions_teledetection" pt JOIN "earth_observation_products" p') && sql.includes("GROUP BY pt")) return [];
    if (sql.includes("count(*)::int AS")) return [{ n: etat.total }];
    if (sql.includes('ST_AsGeoJSON(pt."geom", 6)')) return etat.lignesListe;
    if (sql.includes('ST_AsGeoJSON(pt."geom", 7)')) return etat.lignesDetail.filter((l) => l.id === valeurs[0]);
    if (sql.includes('FROM "propositions_teledetection_transitions"')) return [];
    if (sql.includes('FROM "propositions_teledetection_preuves"')) {
      // la requete du detail porte le perimetre (`visible`) : on le calcule ici comme PostgreSQL le ferait, sur la region de l'observation
      const regions = sql.includes("ANY(") ? (valeurs.find((v) => Array.isArray(v)) as number[]) : null;
      return etat.lignesPreuves.map((o) => ({ ...o, visible: regions === null ? true : regions.includes(o.regionId as number) }));
    }
    // citation d'observations par un compte REGIONAL : seules celles dont la region est dans son perimetre existent pour lui
    if (sql.includes('FROM "observations" o WHERE o."id" = ANY(')) {
      const [ids, regions] = valeurs as [string[], number[]];
      return etat.observations.filter((o) => ids.includes(o.id as string) && regions.includes(o.regionId as number)).map((o) => ({ id: o.id }));
    }
    if (sql.includes('FROM "missions" m LEFT JOIN')) return [];
    if (sql.includes("FROM \"propositions_teledetection\" pt JOIN")) return etat.lignesListe;
    if (sql.includes('FROM "earth_observation_products" p LEFT JOIN "sources_observation"')) return etat.lignesListe;
    if (sql.includes('FROM "earth_observation_products" p WHERE p."id"')) return etat.produits.filter((p) => p.id === valeurs[0]);
    if (sql.includes('FROM "sources_observation" WHERE "deletedAt" IS NULL ORDER BY "code"')) return etat.sources;
    if (sql.includes('SELECT "etat" FROM "sources_observation"')) return etat.sources.map((s) => ({ etat: s.etat }));
    if (sql.includes("coherence_teledetection")) return etat.lignesCoherence;
    if (sql.includes("precision_teledetection")) return [];
    if (sql.includes("qualite_methodes_eo")) return [];
    if (sql.includes('FROM "earth_observation_products" p WHERE p."deletedAt" IS NULL AND NOT p."synthetique" ORDER BY')) return [];

    // ----- ecritures du service (lecture verrouillee)
    if (sql.startsWith('SELECT "statut", "regionId", "motifAttente" FROM "propositions_teledetection"') || sql.startsWith('SELECT "statut", "regionId" FROM "propositions_teledetection"')) {
      const p = etat.propositions.find((x) => x.id === valeurs[0]);
      return p ? [{ statut: p.statut, regionId: p.regionId ?? null, motifAttente: p.motifAttente ?? null }] : [];
    }
    if (sql.includes('SELECT pt."statut", pt."missionId", pt."type", pt."regionId"')) {
      const p = etat.propositions.find((x) => x.id === valeurs[0]);
      return p ? [{ statut: p.statut, missionId: p.missionId ?? null, type: p.type ?? "INONDATION", regionId: p.regionId ?? null, tronconCode: null }] : [];
    }
    if (sql.includes('FROM "missions" WHERE "id"')) return etat.missions.filter((m) => m.id === valeurs[0]).map((m) => ({ assigneId: m.assigneId ?? null }));
    if (sql.includes('FROM "observations" WHERE "id" = ANY')) {
      const ids = valeurs[0] as string[];
      return etat.observations.filter((o) => ids.includes(o.id as string) && o.agentId === valeurs[1]).map((o) => ({ id: o.id }));
    }
    if (sql.includes('SELECT "id", "etat", "requiertIdentifiants" FROM "sources_observation"')) {
      return etat.sources.filter((s) => s.code === valeurs[0]);
    }
    if (sql.includes("ST_Distance")) return [];
    return [];
  };

  const executeRaw = async (strings0: readonly string[], ...valeurs0: unknown[]): Promise<number> => {
    const { sql, valeurs } = aplatir(strings0, valeurs0);
    etat.executions.push({ sql, valeurs });
    if (etat.erreurBase) throw new Error(etat.erreurBase);
    if (sql.includes('INSERT INTO "earth_observation_products"')) {
      const ident = valeurs.find((v) => typeof v === "string" && etat.idsProduitsConnus.has(v as string));
      if (sql.includes("ON CONFLICT") && ident) return 0;
      etat.produits.push({ id: valeurs[0], code: valeurs[1] });
      return 1;
    }
    return 1;
  };

  const tx = { ...delegues, $queryRaw: queryRaw, $executeRaw: executeRaw };
  return { ...tx, $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
}

/** Une ligne de proposition telle que la rendent les requetes de liste et de detail (colonnes de `api.lecture.ts`). */
export function ligneProposition(id: string, extra: Ligne = {}): Ligne {
  return {
    id, type: "INONDATION", statut: "A_VERIFIER", prioriteNiveau: null, prioriteRegle: null, confianceDetection: null, confianceCalibree: false,
    imageCouvertureNuagesPct: null, imageNote: null, rattachementConfiance: null, rattachementAlgorithme: null, distanceTronconM: null,
    methode: "seuil-sar v0", methodeNom: "seuil-sar", methodeVersion: "v0", missionId: null, synthetique: false, regionId: null,
    produitId: "00000000-0000-4000-8000-000000000060", dateObservation: new Date("2026-10-02T00:00:00Z"), dateReference: null,
    sourceCode: null, sourceLibelle: "Sentinel-1 GRD", produitCapteur: null, resolutionM: 10, resolutionNativeM: null,
    fournisseur: null, identifiantFournisseur: null, collection: null, cycleVie: "CATALOGUE", produitSynthetique: false,
    sourceNom: null, sourceCapteur: null, sourceResolutionM: null, tronconId: null, tronconCode: null, tronconNom: null, regionNom: null,
    lat: 9.64, lon: -13.6, limites: ["Resolution native 10 m"], motifAttente: null, verifieeLe: null, motifVerdict: null, constatRef: null,
    rattachementCandidats: null, versionTraitement: "v0", licence: "relevee a la source", licenceCode: null, licenceAttribution: null,
    empreinteSha256: null, provenance: "scene-eo", geometrie: { type: "Point", coordinates: [-13.6, 9.64] },
    p_id: "00000000-0000-4000-8000-000000000060", p_code: "P", p_sourceCode: null, p_source: "Sentinel-1 GRD", p_fournisseur: null,
    p_identifiantFournisseur: null, p_collection: null, p_capteur: null, p_nature: "RADAR", p_niveauTraitement: null,
    p_dateAcquisition: new Date("2026-10-02T00:00:00Z"), p_resolutionM: 10, p_resolutionNativeM: null, p_couvertureNuagesPct: null,
    p_cycleVie: "CATALOGUE", p_scene: null, p_synthetique: false, ref_id: null,
    ...extra,
  };
}
