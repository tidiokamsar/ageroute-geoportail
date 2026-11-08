/**
 * SIMULATEUR LOCAL D'UN DESTINATAIRE. CODE DE TEST, ECRIT PAR AGEROUTE.
 *
 * CE QUE C'EST, ET CE QUE ca NE PROUVE PAS
 *
 * Un serveur HTTP sur 127.0.0.1 qui IMPLEMENTE NOTRE HYPOTHESE de contrat (transport.ts) : il
 * authentifie un jeton, valide l'enveloppe et la charge contre contrats.ts, deduplique sur la cle
 * d'idempotence comme le ferait un destinataire sain, et rejoue sur demande les pannes qu'un
 * destinataire reel peut produire. Un test qui passe contre lui prouve que NOTRE code tient NOTRE
 * contrat. Il ne prouve RIEN sur DigitalRoad, SharePoint ou la BDR / L2R, dont aucun n'a ete
 * atteint (B-11, B-12) et dont aucun contrat n'est connu.
 *
 * LOOPBACK SEULEMENT : le serveur n'ecoute que 127.0.0.1, et `fetchBoucleLocale` refuse (leve) tout
 * appel vers un autre hote. Les tests de ce depot passent par ce garde-fou : aucune requete ne
 * peut quitter la machine.
 *
 * SCENARIOS programmables, consommes un par requete (file) puis `defaut` (succes) :
 *   succes            2xx + accuse ; effet applique une fois par cle d'idempotence
 *   doublon           2xx + accuse {doublon:true}, sans nouvel effet
 *   erreur5xx         503 (ou le statut demande), sans effet
 *   timeout           ne repond jamais (jusqu'a la fermeture du serveur ou l'abandon du client)
 *   lent              repond apres `ms`, puis succes
 *   accuse-invalide   2xx dont le corps n'est pas un accuse ; l'effet EST applique (cas realiste)
 *   refus4xx          4xx (422 par defaut), sans effet
 *   redirection       302 vers une autre URL : le transport ne doit PAS la suivre
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { canonique, sha256Hex } from "../canonique";
import { SchemaEnveloppe, verifierChargeContrat } from "../contrats";
import type { FetchLike } from "../adaptateurs/transport";
import type { Destination } from "../types";

export type Scenario =
  | { type: "succes" }
  | { type: "doublon" }
  | { type: "erreur5xx"; statut?: number }
  | { type: "timeout" }
  | { type: "lent"; ms: number }
  | { type: "accuse-invalide"; variante?: "texte" | "sans-reference" | "vide" | "trop-gros" }
  | { type: "refus4xx"; statut?: number }
  | { type: "redirection"; vers: string };

export interface RequeteRecue {
  methode: string;
  chemin: string;
  entetes: Record<string, string | string[] | undefined>;
  corps: string;
  /** Verdicts du simulateur sur ce qu'il a recu. */
  jetonValide: boolean;
  enveloppeConforme: boolean;
  cleCoherente: boolean;
  motifNonConforme: string | null;
  scenario: Scenario["type"];
}

export interface Simulateur {
  readonly destination: Destination;
  /** http://127.0.0.1:<port> */
  readonly url: string;
  readonly requetes: RequeteRecue[];
  /** Effets reellement appliques : cle d'idempotence -> reference d'accuse. */
  readonly effets: Map<string, string>;
  programmer(...scenarios: Scenario[]): void;
  definirDefaut(s: Scenario): void;
  reinitialiser(): void;
  fermer(): Promise<void>;
}

export async function demarrerSimulateur(opts: { destination: Destination; jeton: string; chemin: string }): Promise<Simulateur> {
  const requetes: RequeteRecue[] = [];
  const effets = new Map<string, string>();
  const file: Scenario[] = [];
  let defaut: Scenario = { type: "succes" };
  let compteur = 0;
  const enAttente = new Set<ServerResponse>();

  function lireCorps(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const morceaux: Buffer[] = [];
      req.on("data", (c: Buffer) => morceaux.push(c));
      req.on("end", () => resolve(Buffer.concat(morceaux).toString("utf8")));
      req.on("error", reject);
    });
  }

  function json(res: ServerResponse, statut: number, corps: unknown) {
    const texte = typeof corps === "string" ? corps : JSON.stringify(corps);
    res.writeHead(statut, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(texte) });
    res.end(texte);
  }

  function appliquerEffet(cle: string): string {
    const existant = effets.get(cle);
    if (existant) return existant;
    compteur += 1;
    const reference = `SIM-${opts.destination}-${compteur}`;
    effets.set(cle, reference);
    return reference;
  }

  const serveur: Server = createServer(async (req, res) => {
    const corps = await lireCorps(req);
    const scenario = file.shift() ?? defaut;

    const jetonValide = req.headers.authorization === `Bearer ${opts.jeton}`;
    let enveloppeConforme = false;
    let cleCoherente = false;
    let motif: string | null = null;
    let cle: string | null = null;
    try {
      const analyse = SchemaEnveloppe.safeParse(JSON.parse(corps));
      if (!analyse.success) motif = `enveloppe : ${analyse.error.issues[0]?.message ?? "invalide"}`;
      else {
        const e = analyse.data;
        const charge = verifierChargeContrat(opts.destination, e.charge);
        if (e.destination !== opts.destination) motif = `destination ${e.destination} recue par le simulateur ${opts.destination}`;
        else if (!charge.ok) motif = `charge : ${charge.motif}`;
        else {
          enveloppeConforme = true;
          cle = e.cleIdempotence;
          cleCoherente = req.headers["idempotency-key"] === e.cleIdempotence && sha256Hex(canonique(e.charge)) === e.empreinteCharge;
          if (!cleCoherente) motif = "en-tete Idempotency-Key ou empreinte incoherentes";
        }
      }
    } catch { motif = "corps illisible"; }

    requetes.push({
      methode: req.method ?? "", chemin: req.url ?? "", entetes: { ...req.headers }, corps,
      jetonValide, enveloppeConforme, cleCoherente, motifNonConforme: motif, scenario: scenario.type,
    });

    if (req.method !== "POST" || req.url !== opts.chemin) return json(res, 404, { erreur: "chemin inconnu" });
    if (!jetonValide) return json(res, 401, { erreur: "jeton refuse" });
    if (!enveloppeConforme || !cleCoherente || !cle) return json(res, 422, { erreur: motif ?? "non conforme" });

    switch (scenario.type) {
      case "succes": {
        const deja = effets.has(cle);
        const reference = appliquerEffet(cle);
        return json(res, 200, deja ? { reference, doublon: true } : { reference });
      }
      case "doublon":
        return json(res, 200, { reference: effets.get(cle) ?? `SIM-${opts.destination}-DEJA`, doublon: true });
      case "erreur5xx":
        return json(res, scenario.statut ?? 503, { erreur: "indisponible" });
      case "timeout":
        enAttente.add(res);
        res.on("close", () => enAttente.delete(res));
        return; // aucune reponse
      case "lent": {
        await new Promise((r) => setTimeout(r, scenario.ms));
        if (res.destroyed) return;
        const reference = appliquerEffet(cle);
        return json(res, 200, { reference });
      }
      case "accuse-invalide": {
        appliquerEffet(cle); // le destinataire a traite, mais sa reponse est inexploitable
        switch (scenario.variante ?? "sans-reference") {
          case "texte": return json(res, 200, "OK recu");
          case "vide": res.writeHead(204); return void res.end();
          case "trop-gros": return json(res, 200, JSON.stringify({ reference: "x".repeat(100_000) }));
          default: return json(res, 200, { statut: "recu" });
        }
      }
      case "refus4xx":
        return json(res, scenario.statut ?? 422, { erreur: "refuse" });
      case "redirection":
        res.writeHead(302, { Location: scenario.vers });
        return void res.end();
    }
  });

  await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", resolve));
  const port = (serveur.address() as AddressInfo).port;

  return {
    destination: opts.destination,
    url: `http://127.0.0.1:${port}`,
    requetes,
    effets,
    programmer: (...s) => { file.push(...s); },
    definirDefaut: (s) => { defaut = s; },
    reinitialiser: () => { requetes.length = 0; effets.clear(); file.length = 0; defaut = { type: "succes" }; compteur = 0; },
    fermer: () => new Promise<void>((resolve) => {
      for (const r of enAttente) r.destroy();
      serveur.closeAllConnections();
      serveur.close(() => resolve());
    }),
  };
}

/* ============================ Garde-fou de boucle locale ============================ */

const HOTES_AUTORISES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface FetchSurveille extends FetchLike {
  /** Hotes contactes, dans l'ordre. */
  readonly hotesContactes: string[];
  /** URL refusees (hote non local). */
  readonly refus: string[];
}

/**
 * `fetch` qui REFUSE tout hote hors de la boucle locale. Aucun test du depot n'utilise un autre
 * `fetch` pour les adaptateurs : si un jour une configuration pointait ailleurs, le test echouerait
 * AVANT toute emission.
 */
export function fetchBoucleLocale(): FetchSurveille {
  const hotesContactes: string[] = [];
  const refus: string[] = [];
  const f = ((url, init) => {
    const hote = new URL(url).hostname;
    if (!HOTES_AUTORISES.has(hote)) {
      refus.push(hote);
      return Promise.reject(Object.assign(new Error(`appel sortant refuse hors boucle locale : ${hote}`), { code: "HOTE_NON_LOCAL" }));
    }
    hotesContactes.push(hote);
    return fetch(url, init);
  }) as FetchSurveille;
  Object.defineProperty(f, "hotesContactes", { value: hotesContactes });
  Object.defineProperty(f, "refus", { value: refus });
  return f;
}
