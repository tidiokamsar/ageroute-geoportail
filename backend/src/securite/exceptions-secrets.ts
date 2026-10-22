import type { Regle, Trouvaille } from "./balayage-secrets";

/**
 * LES FAUX POSITIFS DU BALAYAGE, UN PAR UN, AVEC LEUR RAISON.
 *
 * Une exception est une promesse : « ce que le balayage signale ici n'est pas un secret ». Elle doit donc
 * dire POURQUOI, et le test refuse une exception sans justification, ou qui ne correspond plus a rien
 * (sinon la liste s'allonge, et un jour elle excuse ce qu'elle n'aurait pas du).
 *
 * Ajouter une exception n'est JAMAIS la bonne reponse a une adresse IP de serveur, a une cle ou a un mot de
 * passe reels : on les retire du depot (regle 1 d'AGENTS.md), on ne les excuse pas.
 */
export interface ExceptionSecret {
  regle: Regle;
  /** Chemin exact du fichier suivi. */
  chemin: string;
  /** Si fourni, l'extrait de la trouvaille doit contenir ce texte : l'exception ne couvre pas tout le fichier. */
  contient?: string;
  justification: string;
}

export const EXCEPTIONS_SECRETS: readonly ExceptionSecret[] = [
  {
    regle: "IP_SERVEUR", chemin: "backend/src/modules/auth/cookie.transport.test.ts", contient: "1.2.3.4",
    justification: "Adresse de client FACTICE (1.2.3.4) passee a un test du transport des cookies : c'est la valeur que le test attend en retour, pas un serveur.",
  },
  {
    regle: "IP_SERVEUR", chemin: "backend/src/modules/auth/refresh.security.test.ts", contient: "1.2.3.4",
    justification: "Adresse de client FACTICE (1.2.3.4) passee a un test de securite du rafraichissement : un argument de fonction, pas un serveur.",
  },
  {
    regle: "IDENTIFIANTS_URL", chemin: "backend/tests-integration/lib/garde.test.ts",
    justification: "URL de connexion FACTICES (utilisateur 'u', mot de passe 'p', ou un faux mot de passe long) qui servent a prouver que la garde des bancs refuse les bases non jetables et n'affiche jamais le mot de passe. Aucune ne designe une base reelle.",
  },
  {
    regle: "AFFECTATION_SECRETE", chemin: "infra/verifier-en-local.sh",
    justification: "Le script fabrique le `.env` d'une base JETABLE de verification locale (voir le commentaire du script : « aucune donnee de production, ce fichier est ignore par git »). Les deux secrets JWT portent 'verification-locale' et 'jetable' dans leur valeur : ils ne signent rien d'autre qu'une session de verification.",
  },
  {
    regle: "AFFECTATION_SECRETE", chemin: "docs/phase5/donnees/p3a-integrity-check.txt",
    justification: "Sortie d'un EXPLAIN de requete : la valeur de 64 caracteres est l'EMPREINTE SHA-256 d'un jeton d'essai (colonne tokenHash), qui ne permet pas de retrouver le jeton ; ce n'est pas un jeton.",
  },
];

export function estExcusee(t: Trouvaille, exceptions: readonly ExceptionSecret[] = EXCEPTIONS_SECRETS): boolean {
  return exceptions.some((e) => e.regle === t.regle && e.chemin === t.chemin && (!e.contient || t.extrait.includes(e.contient)));
}
