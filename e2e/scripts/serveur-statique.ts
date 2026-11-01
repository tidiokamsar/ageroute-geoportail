/**
 * Serveur statique du build de production, qui reproduit `frontend/nginx.conf` pour ce qui compte aux essais :
 *   - `try_files $uri $uri/ /index.html` : un chemin qui n'est pas un fichier rend l'index (routes de l'application) ;
 *   - `Cache-Control: no-cache` pour index.html, sw.js, sw-policy.js, precache-manifest.json et manifest.webmanifest ;
 *     `public, immutable` (1 an) pour /assets/ ; les quatre fichiers du worker portent aussi X-Content-Type-Options et Referrer-Policy ;
 *   - `/api/` transmis a l'API de test (proxy_pass), avec X-Real-IP comme nginx.
 * Ce n'est PAS nginx : pas de gzip, pas de CSP (nginx n'en envoie pas non plus aux pages HTML, constat du fichier), pas de limite de
 * corps. Un vrai nginx n'est pas essaye ici (voir docs/e2e/README.md).
 *
 * Interrupteur : tant que le fichier FICHIER_SERVEUR_COUPE existe, TOUTE connexion est coupee net. C'est « le serveur est injoignable »
 * pour un navigateur dont le service worker a garde l'application : la reouverture a froid hors ligne ne peut alors venir QUE du cache.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DOSSIER_BUILD, FICHIER_SERVEUR_COUPE, PORT_API, PORT_BUILD } from "../lib/env";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".geojson": "application/geo+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};
const REVALIDES = new Set(["/index.html", "/sw.js", "/sw-policy.js", "/precache-manifest.json", "/manifest.webmanifest"]);
const FICHIERS_WORKER = new Set(["/sw.js", "/sw-policy.js", "/precache-manifest.json", "/manifest.webmanifest"]);

function servirFichier(res: http.ServerResponse, fichier: string, chemin: string): void {
  const ext = path.extname(fichier).toLowerCase();
  const entetes: Record<string, string> = { "Content-Type": TYPES[ext] ?? "application/octet-stream" };
  if (chemin.startsWith("/assets/")) entetes["Cache-Control"] = "public, immutable, max-age=31536000";
  else if (REVALIDES.has(chemin)) entetes["Cache-Control"] = "no-cache";
  if (FICHIERS_WORKER.has(chemin)) {
    entetes["X-Content-Type-Options"] = "nosniff";
    entetes["Referrer-Policy"] = "strict-origin-when-cross-origin";
  }
  entetes["Content-Length"] = String(fs.statSync(fichier).size);
  res.writeHead(200, entetes);
  fs.createReadStream(fichier).pipe(res);
}

const serveur = http.createServer((req, res) => {
  if (fs.existsSync(FICHIER_SERVEUR_COUPE)) { req.socket.destroy(); return; }
  const url = new URL(req.url ?? "/", "http://x");
  const chemin = decodeURIComponent(url.pathname);

  if (chemin.startsWith("/api/") || chemin === "/api") {
    const amont = http.request(
      { host: "127.0.0.1", port: PORT_API, method: req.method, path: req.url, headers: { ...req.headers, "x-real-ip": req.socket.remoteAddress ?? "" } },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
    );
    amont.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(amont);
    return;
  }

  const candidat = path.normalize(path.join(DOSSIER_BUILD, chemin));
  if (!candidat.startsWith(DOSSIER_BUILD)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(candidat) && fs.statSync(candidat).isFile()) { servirFichier(res, candidat, chemin); return; }
  // try_files ... /index.html (nginx traite alors la requete comme `location = /index.html` : no-cache).
  servirFichier(res, path.join(DOSSIER_BUILD, "index.html"), "/index.html");
});

export function demarrerServeurStatique(): void {
  serveur.listen(PORT_BUILD, "127.0.0.1", () => console.error(`[statique] ${DOSSIER_BUILD} sur le port ${PORT_BUILD}`));
}
