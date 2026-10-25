/**
 * Serveur HTTP local et client mesurant. Le niveau HTTP du banc passe par la VRAIE application
 * Express (`createApp()` : helmet, CORS, compression, limiteurs, authentification JWT, controle
 * d'acces aux modules, morgan) servie sur une socket de boucle locale, avec connexion persistante.
 *
 * Ce qui y est mesure : de l'envoi de la requete a la fin de reception du corps, en octets
 * transferes (donc COMPRESSES quand le client annonce gzip). Ce qui n'y est pas : le reseau reel,
 * TLS, le proxy Traefik, la decompression et le rendu cote navigateur.
 */
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

// Le plafond global de /api/v2 (1200 requetes par minute et par adresse) fausserait une mesure de debit : le banc vient d'une seule
// adresse. A poser AVANT le premier import de `config/env` ; si l'environnement est deja charge, exporter RATE_LIMIT_V2_MAX=0 a la main.
process.env.RATE_LIMIT_V2_MAX ??= "0";

export interface Reponse {
  statut: number;
  /** Octets du corps tels que transferes (gzip si `encodage` = gzip). */
  octets: number;
  encodage: string | null;
  corps: Buffer;
}

export interface Serveur {
  port: number;
  requete(o: { methode: "GET" | "POST"; chemin: string; corps?: unknown; jeton?: string; ip?: string; gzip?: boolean }): Promise<Reponse>;
  fermer(): Promise<void>;
}

/** Les lignes de journal de morgan (format combined) sont ecartees de la sortie du banc, pas desactivees. */
const LIGNE_MORGAN = /^\S+ - \S+ \[\d+\/\w+\/\d+:/;
const ecritureOrigine = process.stdout.write.bind(process.stdout);
let muet = false;
let lignesEcartees = 0;
process.stdout.write = ((chunk: string | Uint8Array, ...reste: unknown[]) => {
  if (muet && typeof chunk === "string" && LIGNE_MORGAN.test(chunk)) { lignesEcartees += 1; return true; }
  return (ecritureOrigine as (...a: unknown[]) => boolean)(chunk, ...reste);
}) as typeof process.stdout.write;

export function ecarterJournalHttp(oui: boolean): void { muet = oui; }
export function lignesJournalEcartees(): number { return lignesEcartees; }

export async function demarrerServeur(app: Express): Promise<Serveur> {
  const serveur = http.createServer(app);
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const port = (serveur.address() as AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  return {
    port,
    requete: ({ methode, chemin, corps, jeton, ip, gzip = true }) =>
      new Promise<Reponse>((ok, ko) => {
        const donnees = corps === undefined ? undefined : Buffer.from(JSON.stringify(corps));
        const entetes: Record<string, string | number> = { Accept: "application/json" };
        if (gzip) entetes["Accept-Encoding"] = "gzip";
        if (jeton) entetes.Authorization = `Bearer ${jeton}`;
        // Le limiteur de /api/public compte par IP ; `trust proxy` = 1 lit X-Forwarded-For.
        if (ip) entetes["X-Forwarded-For"] = ip;
        if (donnees) { entetes["Content-Type"] = "application/json"; entetes["Content-Length"] = donnees.length; }
        const r = http.request({ host: "127.0.0.1", port, method: methode, path: chemin, headers: entetes, agent }, (res) => {
          const morceaux: Buffer[] = [];
          res.on("data", (c: Buffer) => morceaux.push(c));
          res.on("end", () => {
            const b = Buffer.concat(morceaux);
            const enc = (res.headers["content-encoding"] as string | undefined) ?? null;
            ok({ statut: res.statusCode ?? 0, octets: b.length, encodage: enc, corps: b });
          });
          res.on("error", ko);
        });
        r.on("error", ko);
        if (donnees) r.write(donnees);
        r.end();
      }),
    fermer: async () => {
      agent.destroy();
      await new Promise<void>((ok) => serveur.close(() => ok()));
    },
  };
}

/** Corps JSON d'une reponse, decompresse si besoin. */
export function jsonDe(r: Reponse): unknown {
  const brut = r.encodage === "gzip" ? zlib.gunzipSync(r.corps) : r.corps;
  return JSON.parse(brut.toString("utf8"));
}

/** Taille du corps non compresse (pour rapporter le rapport de compression). */
export function octetsNonCompresses(r: Reponse): number {
  return r.encodage === "gzip" ? zlib.gunzipSync(r.corps).length : r.corps.length;
}
