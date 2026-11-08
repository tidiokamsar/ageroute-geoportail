import { api } from "./api";
import { toast } from "./toast";
import { downloadViaApi } from "./download";

/**
 * Telechargement de l'application mobile terrain (APK). Le fichier n'est plus public : il passe par l'API, derriere
 * l'authentification (`GET /v2/mobile/apk`), comme les documents. Un simple lien `<a href>` ne porte pas le jeton.
 */
export const NOM_FICHIER_APK = "bdri-console-terrain.apk";

export async function telechargerApk(): Promise<void> {
  try {
    await downloadViaApi("/v2/mobile/apk", NOM_FICHIER_APK);
  } catch (e) {
    const statut = (e as { response?: { status?: number } }).response?.status;
    toast.error(statut === 404 ? "L'application mobile n'est pas publiée sur ce serveur." : "Téléchargement impossible : réessayer en ligne, connecté.");
  }
}

export interface InfoApk { disponible: boolean; tailleOctets?: number; modifieLe?: string; sha256?: string }

export async function lireInfoApk(): Promise<InfoApk> {
  try {
    return (await api.get<InfoApk>("/v2/mobile/apk/info")).data;
  } catch {
    return { disponible: false };
  }
}
