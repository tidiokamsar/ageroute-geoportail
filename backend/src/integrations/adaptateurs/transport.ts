/**
 * TRANSPORT HTTP COMMUN DES ADAPTATEURS. LE SEUL ENDROIT OU UN JETON EST LU.
 *
 * L'APPEL EST UNE HYPOTHESE DE TRAVAIL, PAS LE PROTOCOLE D'UN SYSTEME REEL
 *
 * Aucune documentation de DigitalRoad, de SharePoint ou de l'ONR n'est disponible (B-11, B-12).
 * Cet appel est donc celui que le simulateur d'AGEROUTE implemente :
 *
 *   POST {OUTBOX_<DEST>_URL}{OUTBOX_<DEST>_CHEMIN}
 *   Content-Type: application/json            corps = l'enveloppe canonique (contrats.ts)
 *   Idempotency-Key: <cle d'idempotence>      en-tete supposee ; a confirmer
 *   Authorization: Bearer <jeton>             mecanisme suppose ; a confirmer
 *
 *   2xx + {"reference": "...", "doublon"?: bool}  -> ACCEPTE (ou DOUBLON_RECONNU si doublon)
 *   2xx sans accuse lisible                      -> ACCUSE_INVALIDE (on ne sait pas si c'est traite)
 *   408, 425, 429, 5xx, reseau, delai depasse    -> ECHEC_TEMPORAIRE
 *   autres 4xx, 3xx                              -> ECHEC_DEFINITIF
 *
 * GARDE-FOUS, TENUS ICI ET TESTES
 *   - les redirections ne sont JAMAIS suivies (`redirect: "manual"`) : une reponse ne peut pas
 *     envoyer l'emission, et le jeton, vers un autre hote ;
 *   - le delai est borne, corps de reponse compris ;
 *   - le corps de la reponse est lu jusqu'a 64 Kio et n'est JAMAIS conserve ni journalise : seuls
 *     le code HTTP et un message assaini sortent ;
 *   - aucun message ne contient le jeton ni l'URL (`assainir`) ;
 *   - la fonction ne leve jamais : toute panne devient un ResultatEmission.
 */
import { canonique } from "../canonique";
import type { ConfigDestination } from "../config";
import { AccuseReception, construireEnveloppe } from "../contrats";
import type { DemandeEmission, ResultatEmission } from "../types";

/** Sous-ensemble de `fetch` dont le transport a besoin : remplacable en test pour tout controler. */
export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal;
}) => Promise<Response>;

const TAILLE_MAX_REPONSE = 64 * 1024;

/** Retire les secrets, les caracteres de controle, et borne la longueur. */
export function assainir(texte: string, secrets: readonly string[] = []): string {
  let s = texte;
  for (const secret of secrets) if (secret.length >= 4) s = s.split(secret).join("[SECRET]");
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

async function lireBornee(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const lecteur = res.body.getReader();
  const morceaux: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.byteLength;
    if (total > TAILLE_MAX_REPONSE) { await lecteur.cancel(); return null; }
    morceaux.push(value);
  }
  return Buffer.concat(morceaux).toString("utf8");
}

function causeReseau(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string }; code?: string };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "TIMEOUT";
  return e?.cause?.code ?? e?.code ?? "RESEAU";
}

export async function posterEnveloppe(
  cfg: ConfigDestination, demande: DemandeEmission, fetchImpl: FetchLike,
): Promise<ResultatEmission> {
  if (!cfg.actif || !cfg.baseUrl || !cfg.chemin || !cfg.jeton) {
    return { issue: "ECHEC_DEFINITIF", codeErreur: "DESTINATION_INACTIVE", message: cfg.raison ?? "destination inactive" };
  }
  const jeton = cfg.jeton.valeur();
  const secrets = [jeton, cfg.baseUrl];
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), cfg.timeoutMs);
  try {
    const corps = canonique(construireEnveloppe(demande));
    let res: Response;
    try {
      res = await fetchImpl(cfg.baseUrl + cfg.chemin, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": demande.cleIdempotence,
          Authorization: `Bearer ${jeton}`,
        },
        body: corps,
        redirect: "manual",
        signal: controleur.signal,
      });
    } catch (err) {
      const code = causeReseau(err);
      return { issue: "ECHEC_TEMPORAIRE", codeErreur: code, message: assainir(code === "TIMEOUT" ? `delai de ${cfg.timeoutMs} ms depasse` : `echec reseau (${code})`, secrets) };
    }

    const statut = res.status;
    if (statut >= 200 && statut < 300) {
      let texte: string | null;
      try { texte = await lireBornee(res); } catch (err) {
        const code = causeReseau(err);
        return { issue: "ACCUSE_INVALIDE", codeErreur: code === "TIMEOUT" ? "TIMEOUT" : "REPONSE_ILLISIBLE", message: "reponse interrompue avant la fin de l'accuse", codeHttp: statut };
      }
      if (texte === null) return { issue: "ACCUSE_INVALIDE", codeErreur: "REPONSE_TROP_GROSSE", message: `reponse de plus de ${TAILLE_MAX_REPONSE} octets`, codeHttp: statut };
      let json: unknown;
      try { json = JSON.parse(texte); } catch {
        return { issue: "ACCUSE_INVALIDE", codeErreur: "ACCUSE_ILLISIBLE", message: "la reponse 2xx n'est pas du JSON", codeHttp: statut };
      }
      const accuse = AccuseReception.safeParse(json);
      if (!accuse.success) {
        return { issue: "ACCUSE_INVALIDE", codeErreur: "ACCUSE_NON_CONFORME", message: "la reponse 2xx ne porte pas de reference d'accuse de reception", codeHttp: statut };
      }
      return {
        issue: accuse.data.doublon === true ? "DOUBLON_RECONNU" : "ACCEPTE",
        accuseReference: assainir(accuse.data.reference, secrets),
        codeHttp: statut,
      };
    }

    try { await res.body?.cancel(); } catch { /* le corps n'est pas lu : rien a perdre */ }
    if (statut >= 300 && statut < 400) {
      return { issue: "ECHEC_DEFINITIF", codeErreur: "REDIRECTION_REFUSEE", message: `redirection ${statut} non suivie`, codeHttp: statut };
    }
    if (statut === 408 || statut === 425 || statut === 429 || statut >= 500) {
      return { issue: "ECHEC_TEMPORAIRE", codeErreur: `HTTP_${statut}`, message: `reponse HTTP ${statut}`, codeHttp: statut };
    }
    if (statut >= 400) {
      return { issue: "ECHEC_DEFINITIF", codeErreur: `HTTP_${statut}`, message: `refus HTTP ${statut}`, codeHttp: statut };
    }
    return { issue: "ECHEC_TEMPORAIRE", codeErreur: `HTTP_${statut}`, message: `reponse HTTP inattendue ${statut}`, codeHttp: statut };
  } catch (err) {
    // Rien ne doit s'echapper : une exception ici ferait perdre le verrou sans journal.
    return { issue: "ECHEC_TEMPORAIRE", codeErreur: "EXCEPTION_TRANSPORT", message: assainir(err instanceof Error ? err.name : "erreur", secrets) };
  } finally {
    clearTimeout(minuteur);
  }
}
