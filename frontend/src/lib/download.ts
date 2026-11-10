import { api } from "./api";

// Les routes /documents/:id/download et /photos/:filename exigent une authentification
// Bearer (pas de cookies) : un simple <a href> ne porte pas ce header et echoue en 401
// pour un vrai utilisateur dans le navigateur (seul un curl avec le token manuel "marche").
// On passe donc par l'instance axios authentifiee, puis on declenche le telechargement
// via un blob local.
export async function downloadViaApi(url: string, filename: string): Promise<void> {
  const res = await api.get(url, { responseType: "blob" });
  enregistrerBlob(res.data as Blob, filename);
}

/**
 * Remet un blob deja recu au navigateur comme un fichier a enregistrer (lien temporaire, revoque aussitot). Rien n'est conserve par
 * l'application : ni stockage local, ni cache ; le fichier va ou l'utilisateur l'enregistre.
 */
export function enregistrerBlob(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

/**
 * Une requete `responseType: "blob"` en erreur porte son corps JSON (`{ error, code, ... }`) sous forme de Blob : on le relit en objet pour que le
 * classeur d'erreurs voie le code. Un corps illisible (pas du JSON, plus de 64 Ko) est remplace par un objet vide. Ne leve jamais.
 */
export async function erreurAvecCorpsJson(e: unknown): Promise<unknown> {
  const r = e && typeof e === "object" ? (e as { response?: { data?: unknown } }).response : undefined;
  const corps = r?.data;
  if (!r || typeof Blob === "undefined" || !(corps instanceof Blob)) return e;
  let lu: unknown = {};
  try {
    if (corps.size <= 64 * 1024) lu = JSON.parse(await texteDuBlob(corps));
  } catch {
    lu = {};
  }
  r.data = lu && typeof lu === "object" ? lu : {};
  return e;
}

/** Texte d'un petit corps d'erreur (`Blob.text()` si le navigateur l'a, sinon `FileReader`). Ne sert qu'aux corps d'ERREUR JSON du serveur. */
function texteDuBlob(b: Blob): Promise<string> {
  if (typeof b.text === "function") return b.text();
  return new Promise((ok, ko) => {
    const l = new FileReader();
    l.onload = () => ok(typeof l.result === "string" ? l.result : "");
    l.onerror = () => ko(l.error);
    l.readAsText(b);
  });
}
