import { api } from "./api";

// Les routes /documents/:id/download et /photos/:filename exigent une authentification
// Bearer (pas de cookies) : un simple <a href> ne porte pas ce header et echoue en 401
// pour un vrai utilisateur dans le navigateur (seul un curl avec le token manuel "marche").
// On passe donc par l'instance axios authentifiee, puis on declenche le telechargement
// via un blob local.
export async function downloadViaApi(url: string, filename: string): Promise<void> {
  const res = await api.get(url, { responseType: "blob" });
  const blobUrl = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}
