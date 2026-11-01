/**
 * Serveur de mesure du RENDU sous reseau limite (A20 : « rendu < 3 s en 3G »).
 *
 * Il sert, sur UNE origine, ce que servirait la production : le frontend compile (`frontend/dist`,
 * gzip, comme nginx.conf) et l'API (`/api` -> la vraie application Express, branchee sur un clone
 * `essai_<nom>`). Toute la reponse passe par un limiteur applicatif :
 *
 *   - latence : chaque requete attend `rttMs` avant le premier octet, et la premiere requete d'une
 *     connexion TCP paie 2 RTT de plus (TCP + TLS 1.3), ce que fait un navigateur a froid ;
 *   - debit : un seau commun, `kbps` kilobits par seconde pour TOUTES les reponses (lien descendant
 *     partage), emission par blocs de 4 Ko.
 *
 * CE QUE CE LIMITEUR N'EST PAS : un emulateur de paquets. Pas de demarrage lent TCP, pas de perte,
 * pas de gigue, pas d'effet de la taille de fenetre. Il rend le temps de transfert d'un fichier
 * AU MIEUX : un reseau reel fait au moins aussi mal. Les tuiles OpenStreetMap, servies par un tiers,
 * ne passent pas ici et ne sont pas comptees.
 *
 *   DATABASE_URL=postgresql://.../essai_perf npx tsx tests-integration/perf/serveur-3g.ts \
 *       --kbps 1600 --rtt 150 [--port 4310] [--dist ../frontend/dist]
 *
 * Le processus affiche `PRET <url>` puis attend ; Ctrl-C pour l'arreter. La garde exige que
 * DATABASE_URL vise un clone `essai_<nom>` local.
 */
import "../lib/garde";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const arg = (nom: string, defaut: string) => { const i = process.argv.indexOf(`--${nom}`); return i >= 0 ? process.argv[i + 1] : defaut; };
const KBPS = Number(arg("kbps", "1600"));
const RTT_MS = Number(arg("rtt", "150"));
const PORT = Number(arg("port", "4310"));
const DIST = path.resolve(arg("dist", path.join(__dirname, "../../../frontend/dist")));

const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.max(0, ms)));

class LienDescendant {
  private libreA = 0;
  constructor(private readonly octetsParSeconde: number) {}
  async emettre(octets: number): Promise<void> {
    const maintenant = Date.now();
    const debut = Math.max(maintenant, this.libreA);
    this.libreA = debut + (octets / this.octetsParSeconde) * 1000;
    await dormir(this.libreA - maintenant);
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".geojson": "application/geo+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
const COMPRESSIBLES = new Set([".html", ".js", ".css", ".json", ".geojson", ".svg"]);

async function main() {
  const { createApp } = await import("../../src/app");
  const api = http.createServer(createApp());
  await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
  const portApi = (api.address() as import("node:net").AddressInfo).port;

  const lien = new LienDescendant((KBPS * 1000) / 8);
  const connexionsVues = new WeakSet<object>();
  const journal: { chemin: string; octets: number; ms: number }[] = [];

  const front = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const neuve = !connexionsVues.has(req.socket);
    connexionsVues.add(req.socket);
    await dormir(RTT_MS * (neuve ? 3 : 1));

    const envoyer = async (statut: number, entetes: http.OutgoingHttpHeaders, corps: Buffer) => {
      res.writeHead(statut, { ...entetes, "Content-Length": corps.length });
      for (let i = 0; i < corps.length; i += 4096) {
        const bloc = corps.subarray(i, Math.min(corps.length, i + 4096));
        await lien.emettre(bloc.length);
        res.write(bloc);
      }
      res.end();
      journal.push({ chemin: req.url ?? "", octets: corps.length, ms: Date.now() - t0 });
    };

    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/__journal") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(journal)); return; }
    if (url.pathname === "/__reinit") { journal.length = 0; res.end("ok"); return; }

    const accepteGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    if (url.pathname.startsWith("/api/")) {
      // Proxy vers l'application, en laissant la compression de l'application faire son travail.
      const amont = http.request({ host: "127.0.0.1", port: portApi, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": "10.9.9.9" } }, (r) => {
        const morceaux: Buffer[] = [];
        r.on("data", (c: Buffer) => morceaux.push(c));
        r.on("end", () => { const { "content-length": _l, ...autres } = r.headers; void _l; void envoyer(r.statusCode ?? 502, autres, Buffer.concat(morceaux)); });
      });
      amont.on("error", () => void envoyer(502, {}, Buffer.from("amont indisponible")));
      req.pipe(amont);
      return;
    }

    let fichier = path.join(DIST, decodeURIComponent(url.pathname));
    if (!fichier.startsWith(DIST) || !fs.existsSync(fichier) || fs.statSync(fichier).isDirectory()) fichier = path.join(DIST, "index.html");
    const ext = path.extname(fichier).toLowerCase();
    let corps = fs.readFileSync(fichier);
    // INSTRUMENT DE MESURE, injecte dans la page d'entree uniquement (le bundle n'est pas modifie) :
    //   donneesMs  fin de la reponse XHR de /api/public/carte/geo, depuis le debut de la navigation ;
    //   interfaceMs  premier instant ou la legende de la page affiche une longueur de reseau non nulle
    //                (« 19 355 km de routes classees ») : l'interface a ete mise a jour avec les donnees,
    //                dans le meme cycle de rendu React que les traces. C'est un PROXY du rendu des traces,
    //                pas une mesure de leur dessin : le canvas Leaflet n'etait pas lisible dans le
    //                navigateur de mesure. Les tuiles du fond de plan (externes) ne comptent pas.
    if (path.basename(fichier) === "index.html") {
      const instrument = `<script>(function(){var m=window.__mesure={};
var send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){var x=this;x.addEventListener('loadend',function(){if(/carte\\/geo/.test(x.responseURL||'')&&!m.donneesMs)m.donneesMs=Math.round(performance.now())});return send.apply(this,arguments)};
new MutationObserver(function(){if(m.interfaceMs||!document.body)return;if(/[1-9][0-9\\s\\u202f\\u00a0]*km de routes/.test(document.body.textContent||''))m.interfaceMs=Math.round(performance.now())}).observe(document,{childList:true,subtree:true,characterData:true});
})();</script>`;
      corps = Buffer.from(corps.toString("utf8").replace("</head>", `${instrument}</head>`));
    }
    const entetes: http.OutgoingHttpHeaders = { "Content-Type": TYPES[ext] ?? "application/octet-stream" };
    // Comme nginx.conf : gzip niveau 6 des textes de plus de 1 Ko ; assets a empreinte gardes un an.
    if (accepteGzip && COMPRESSIBLES.has(ext) && corps.length >= 1024) { corps = zlib.gzipSync(corps, { level: 6 }); entetes["Content-Encoding"] = "gzip"; entetes.Vary = "Accept-Encoding"; }
    if (url.pathname.startsWith("/assets/")) entetes["Cache-Control"] = "public, max-age=31536000, immutable";
    await envoyer(200, entetes, corps);
  });
  await new Promise<void>((ok) => front.listen(PORT, "127.0.0.1", ok));
  console.log(`PRET http://127.0.0.1:${PORT}  (debit ${KBPS} kbit/s, RTT ${RTT_MS} ms, dist ${DIST})`);
}

// Secrets JWT aleatoires AVANT l'import de l'application (config/env les exige).
if (!process.env.JWT_ACCESS_SECRET) process.env.JWT_ACCESS_SECRET = require("node:crypto").randomBytes(32).toString("hex");
if (!process.env.JWT_REFRESH_SECRET) process.env.JWT_REFRESH_SECRET = require("node:crypto").randomBytes(32).toString("hex");
main().catch((e) => { console.error(e); process.exitCode = 1; });
