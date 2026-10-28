/**
 * Trace des scripts d'exploitation dans `audit_logs` (regle 3 d'AGENTS.md : toute ecriture est
 * auditee) et mode simulation par defaut.
 *
 * POURQUOI CET UTILITAIRE EXISTE
 *
 * Vingt-neuf scripts de `backend/scripts/` ecrivent dans la base sans laisser de ligne dans
 * `audit_logs` (audit de lecture du 26/10/2026, `docs/qualite/AUDIT-SCRIPTS-ECRITURE.md`). Les
 * plus soignes laissent une ligne `valeurs_qualite` dont la note contient l'ancienne valeur ;
 * les autres ne laissent rien. Ce module est la brique commune pour y remedier SANS changer ce que
 * font les scripts : il decide du mode, nomme l'execution, choisit l'auteur et fabrique les lignes
 * d'audit. Il ne modifie aucun script : l'orchestrateur decide de les brancher.
 *
 * CE QU'IL GARANTIT
 *
 *   - SIMULATION PAR DEFAUT : sans `--apply`, `modeExecution` rend `ecriture: false`. `--dry-run`
 *     est accepte et explicite ; les deux ensemble sont refuses. `APPLIQUER=1` (variable
 *     d'environnement de `import-ouvrages-doaa.ts`) reste reconnu.
 *   - UNE EXECUTION A UN IDENTIFIANT (UUID) repris sur chaque ligne ecrite : retrouver tout ce
 *     qu'un lancement a touche se fait par `after->'_execution'->>'executionId'`.
 *   - UN AUTEUR RESPONSABLE : en ecriture, `--auteur=<email d'un ADMIN actif>` est exige (comme
 *     `retrograder-compte.ts`), ou `--auteur-systeme` pour une execution sans personne derriere
 *     (`userId` nul, que l'ecran d'audit affiche « Systeme »).
 *   - LA TRACE ENTRE DANS LA TRANSACTION qui porte l'ecriture : une panne d'audit annule
 *     l'ecriture (meme principe que `logAuditTransactionnelle`). Un journal de debut d'execution est
 *     ecrit AVANT, hors transaction, pour qu'un script interrompu laisse une trace « demarre »
 *     sans « termine ».
 *   - EN SIMULATION, RIEN N'EST ECRIT : aucune des methodes ne touche la base ; elles comptent ce
 *     qu'elles auraient trace.
 *
 * GRANULARITE : une ligne par entite jusqu'a `SEUIL_TRACE_PAR_ENTITE` (provisoire), au-dela une
 * ligne par lot de `TAILLE_LOT_TRACE` identifiants. 261 387 lignes d'audit pour une promotion de
 * voirie noieraient le journal ; le lot garde les identifiants (donc la reversibilite) sans cela.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Mode d'execution et options
// ─────────────────────────────────────────────────────────────────────────────

export interface ModeExecution {
  /** Vrai seulement si l'ecriture a ete demandee explicitement. */
  ecriture: boolean;
  origine: "defaut" | "--apply" | "--dry-run" | "APPLIQUER=1";
}

/** Lit `--nom=valeur` ou `--nom valeur`. Rend null si absente ou sans valeur. */
export function lireOption(argv: readonly string[], nom: string): string | null {
  const prefixe = `--${nom}=`;
  const egal = argv.find((a) => a.startsWith(prefixe));
  if (egal !== undefined) return egal.slice(prefixe.length) || null;
  const i = argv.indexOf(`--${nom}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return null;
}

/**
 * Simulation par defaut. Refuse `--apply` et `--dry-run` ensemble (intention contradictoire) et
 * `APPLIQUER=1` avec `--dry-run`.
 */
export function modeExecution(argv: readonly string[], env: Record<string, string | undefined> = {}): ModeExecution {
  const apply = argv.includes("--apply");
  const dry = argv.includes("--dry-run");
  const envApply = env.APPLIQUER === "1";
  if (dry && (apply || envApply)) {
    throw new Error("--dry-run contredit --apply (ou APPLIQUER=1) : choisir l'un des deux.");
  }
  if (apply) return { ecriture: true, origine: "--apply" };
  if (envApply) return { ecriture: true, origine: "APPLIQUER=1" };
  if (dry) return { ecriture: false, origine: "--dry-run" };
  return { ecriture: false, origine: "defaut" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexte d'execution
// ─────────────────────────────────────────────────────────────────────────────

export interface ContexteExecution {
  script: string;
  executionId: string;
  mode: "ECRITURE" | "SIMULATION";
  debutLe: string;
  hote: string;
  /** Parametres du lancement (sans secret : l'appelant ne doit y mettre aucune URL de connexion). */
  parametres: Record<string, string | number | boolean | null>;
}

export interface OptionsContexte {
  script: string;
  argv: readonly string[];
  env?: Record<string, string | undefined>;
  parametres?: ContexteExecution["parametres"];
  /** Injectables pour les tests ; sinon horloge, UUID et nom de machine. */
  maintenant?: Date;
  executionId?: string;
  hote?: string;
}

export function creerContexte(o: OptionsContexte): { contexte: ContexteExecution; mode: ModeExecution } {
  const mode = modeExecution(o.argv, o.env);
  return {
    mode,
    contexte: {
      script: o.script,
      executionId: o.executionId ?? randomUUID(),
      mode: mode.ecriture ? "ECRITURE" : "SIMULATION",
      debutLe: (o.maintenant ?? new Date()).toISOString(),
      hote: o.hote ?? hostname(),
      parametres: o.parametres ?? {},
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auteur
// ─────────────────────────────────────────────────────────────────────────────

export interface Auteur {
  userId: string | null;
  /** « systeme » ou l'adresse du compte. */
  libelle: string;
}

export interface ClientUtilisateurs {
  user: {
    findUnique(args: { where: { email: string }; select: { id: true; role: true; actif: true } }):
      Promise<{ id: string; role: string; actif: boolean } | null>;
  };
}

/**
 * Choisit l'auteur de la trace.
 *   - simulation : personne n'ecrit, l'auteur peut rester vide ;
 *   - ecriture : `--auteur=<email>` d'un ADMIN actif, ou `--auteur-systeme` explicite. Rien d'autre.
 */
export async function choisirAuteur(
  db: ClientUtilisateurs, argv: readonly string[], ecriture: boolean,
): Promise<Auteur> {
  const email = lireOption(argv, "auteur");
  const systeme = argv.includes("--auteur-systeme");
  if (email !== null && systeme) throw new Error("--auteur et --auteur-systeme sont exclusifs.");
  if (systeme) return { userId: null, libelle: "systeme" };
  if (email === null) {
    if (!ecriture) return { userId: null, libelle: "systeme (simulation)" };
    throw new Error("Ecriture demandee sans auteur : preciser --auteur=<email d'un ADMIN actif> ou --auteur-systeme.");
  }
  const compte = await db.user.findUnique({ where: { email }, select: { id: true, role: true, actif: true } });
  if (!compte) throw new Error(`Auteur introuvable : ${email}`);
  if (compte.role !== "ADMIN" || !compte.actif) {
    throw new Error(`${email} n'est pas un administrateur actif : il ne peut pas lancer une ecriture en masse.`);
  }
  return { userId: compte.id, libelle: email };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fabrication des lignes d'audit
// ─────────────────────────────────────────────────────────────────────────────

/** Seuil PROVISOIRE : au-dela, une ligne par lot plutot que par entite. */
export const SEUIL_TRACE_PAR_ENTITE = 5000;
export const TAILLE_LOT_TRACE = 500;

/** Actions de `AuditAction` que ces scripts emploient. */
export type ActionScript = "CREATE" | "UPDATE" | "DELETE" | "RESTORE" | "SECURITY_EVENT";

export interface EntiteTracee {
  id: string;
  before?: unknown;
  after?: unknown;
}

export interface LigneAudit {
  userId: string | null;
  action: ActionScript;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

function marque(ctx: ContexteExecution, auteur: Auteur) {
  return { executionId: ctx.executionId, script: ctx.script, mode: ctx.mode, auteur: auteur.libelle };
}

/**
 * Plan des lignes d'audit d'un lot d'ecritures. Pur (pas de base). `after` d'une entite reste plat,
 * avec une cle reservee `_execution` : un lecteur de `audit_logs` qui ignore cette cle voit la meme
 * forme que pour une ecriture applicative.
 */
export function planifierTrace(
  ctx: ContexteExecution, auteur: Auteur,
  p: { action: ActionScript; entityType: string; entites: readonly EntiteTracee[] },
): LigneAudit[] {
  const m = marque(ctx, auteur);
  if (p.entites.length <= SEUIL_TRACE_PAR_ENTITE) {
    return p.entites.map((e) => ({
      userId: auteur.userId,
      action: p.action,
      entityType: p.entityType,
      entityId: e.id,
      before: e.before ?? null,
      after: { ...(isObjet(e.after) ? e.after : e.after === undefined ? {} : { valeur: e.after }), _execution: m },
    }));
  }
  const lignes: LigneAudit[] = [];
  for (let i = 0; i < p.entites.length; i += TAILLE_LOT_TRACE) {
    const lot = p.entites.slice(i, i + TAILLE_LOT_TRACE);
    lignes.push({
      userId: auteur.userId,
      action: p.action,
      entityType: p.entityType,
      entityId: null,
      // Les anciennes valeurs d'un lot tiennent dans `before` : sans elles le lot ne serait pas reversible.
      before: lot.some((e) => e.before !== undefined) ? lot.map((e) => ({ id: e.id, before: e.before ?? null })) : null,
      after: { lot: i / TAILLE_LOT_TRACE + 1, nombre: lot.length, ids: lot.map((e) => e.id), _execution: m },
    });
  }
  return lignes;
}

const isObjet = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// ─────────────────────────────────────────────────────────────────────────────
// Journal : ecriture dans audit_logs
// ─────────────────────────────────────────────────────────────────────────────

/** Ce dont le journal a besoin : un client ou un client de transaction Prisma. */
export interface ClientAudit {
  auditLog: {
    createMany(args: { data: never[] }): Promise<{ count: number }>;
    create(args: { data: never }): Promise<unknown>;
  };
}

const enDonnees = (l: LigneAudit): never => ({
  userId: l.userId, action: l.action, entityType: l.entityType, entityId: l.entityId ?? undefined,
  before: l.before ?? undefined, after: l.after ?? undefined,
}) as never;

export class JournalScript {
  /** Lignes d'audit ecrites (ecriture) ou qui l'auraient ete (simulation). */
  public lignes = 0;

  constructor(
    private readonly ctx: ContexteExecution,
    private readonly auteur: Auteur,
  ) {}

  get contexte(): ContexteExecution { return this.ctx; }
  get ecriture(): boolean { return this.ctx.mode === "ECRITURE"; }

  /**
   * Trace des entites ecrites. A appeler DANS la transaction qui porte l'ecriture (`tx`). En
   * simulation : ne touche pas la base, compte seulement.
   */
  async tracer(
    tx: ClientAudit,
    p: { action: ActionScript; entityType: string; entites: readonly EntiteTracee[] },
  ): Promise<number> {
    const lignes = planifierTrace(this.ctx, this.auteur, p);
    this.lignes += lignes.length;
    if (!this.ecriture || lignes.length === 0) return lignes.length;
    await tx.auditLog.createMany({ data: lignes.map(enDonnees) });
    return lignes.length;
  }

  /**
   * Ligne de debut ou de fin d'execution (entityType `ScriptExecution`). Le DEBUT s'ecrit avant
   * toute ecriture metier, hors de la transaction metier ; la FIN apres, avec le bilan.
   */
  async tracerExecution(db: ClientAudit, phase: "DEBUT" | "FIN", bilan: Record<string, string | number | boolean | null> = {}): Promise<void> {
    const ligne: LigneAudit = {
      userId: this.auteur.userId,
      action: "SECURITY_EVENT",
      entityType: "ScriptExecution",
      entityId: this.ctx.executionId,
      before: null,
      after: { phase, ...this.ctx, auteur: this.auteur.libelle, bilan },
    };
    this.lignes += 1;
    if (!this.ecriture) return;
    await db.auditLog.create({ data: enDonnees(ligne) });
  }
}
