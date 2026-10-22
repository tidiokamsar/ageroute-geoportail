import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  adresseNonPublique, balayerArbre, balayerTexte, entropie, estValeurFactice, nomDeFichierSecret, racineDepot,
  type Regle,
} from "./balayage-secrets";
import { EXCEPTIONS_SECRETS, estExcusee } from "./exceptions-secrets";

/**
 * A25 : « aucun secret dans le depot ». Le volet DEPOT n'est plus une mesure faite une fois a la main : il
 * est rejoue a chaque `npm test`, sur les fichiers suivis par git.
 *
 * Trois choses sont eprouvees, et la deuxieme est celle qui compte :
 *   1. que le balayage VOIT ce qu'il doit voir (extraits fautifs fabriques ici, sans aucun vrai secret) ;
 *   2. qu'il NE VOIT RIEN dans le depot, hors des exceptions justifiees ;
 *   3. que la liste d'exceptions reste honnete (justifiee, sans entree perimee).
 *
 * LES EXTRAITS FAUTIFS SONT FABRIQUES A L'EXECUTION (concatenation), jamais ecrits en clair : ce fichier est
 * lui-meme balaye, et ne doit pas contenir ce qu'il cherche.
 */
const RACINE = racineDepot(__dirname);
const regles = (chemin: string, contenu: string): Regle[] => balayerTexte(chemin, contenu).map((t) => t.regle);

// Fragments assembles : aucun ne ressemble a un secret tant qu'il n'est pas recolle.
const BLOC = (type: string) => ["-----BEGIN ", type, "-----"].join("");
const aws = () => ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
const gh = () => ["gh", "p_", "a".repeat(10) + "B".repeat(10) + "1".repeat(10) + "z".repeat(6)].join("");
const jwt = () => ["ey", "JhbGciOiJIUzI1NiJ9", ".ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkoifQ", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"].join("");
const ipPublique = () => ["185", "199", "108", "153"].join(".");

describe("le balayage VOIT ce qu'il doit voir", () => {
  it("une cle privee, quel qu'en soit le type", () => {
    for (const t of ["RSA PRIVATE KEY", "PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
      expect(regles("doc.md", `${BLOC(t)}\nMIIE...`), t).toContain("CLE_PRIVEE");
    }
    expect(regles("doc.md", "-----BEGIN CERTIFICATE-----")).not.toContain("CLE_PRIVEE");     // un certificat est public
  });

  it("un fichier dont le NOM trahit un secret, meme vide", () => {
    for (const nom of [".env", ".env.production", "infra/.env.local", "cle.pem", "prod.key", "x/id_rsa", "credentials.json", "service-account-prod.json", ".pgpass", "sauvegarde.dump", "base.sqlite"]) {
      expect(nomDeFichierSecret(nom), nom).not.toBeNull();
      expect(regles(nom, ""), nom).toContain("FICHIER_SECRET");
    }
    for (const nom of [".env.example", "backend/.env.example", ".env.sample", "id_rsa.pub", "README.md", "src/env.ts", "environnement.ts"]) {
      expect(nomDeFichierSecret(nom), nom).toBeNull();
    }
  });

  it("des jetons au format reconnaissable", () => {
    expect(regles("a.ts", `const k = "${aws()}";`)).toContain("JETON_CONNU");
    expect(regles("a.ts", `const t = "${gh()}";`)).toContain("JETON_CONNU");
    expect(regles("a.md", `Authorization: Bearer ${jwt()}`)).toContain("JETON_CONNU");
    expect(regles("a.md", `slack ${["xo", "xb"].join("")}-123456789012-abcdefghij`)).toContain("JETON_CONNU");
  });

  it("un mot de passe dans une URL de connexion, mais pas un marqueur", () => {
    const url = (mdp: string) => `DATABASE_URL="postgresql://bdri_app:${mdp}@db.interne:5432/console"`;
    expect(regles(".env", url("Vq7!rT9zLp2mXw"))).toContain("IDENTIFIANTS_URL");
    expect(regles("README.md", url("Vq7!rT9zLp2mXw"))).toContain("IDENTIFIANTS_URL");
    for (const ok of ["changeme", "motdepasse", "${MDP_DB}", "<mot-de-passe>", "x", "xxxxxxxx", "password"]) {
      expect(regles("README.md", url(ok)), ok).not.toContain("IDENTIFIANTS_URL");
    }
    expect(regles("README.md", "https://carte.ageroute.gov.gn/api/health")).not.toContain("IDENTIFIANTS_URL");
  });

  it("une affectation de secret a une vraie valeur, en configuration comme en code", () => {
    expect(regles(".env.production", "JWT_ACCESS_SECRET=k8s9Dj2LmQ7xVb3NpR5tYw1ZcA4fGh6u")).toContain("AFFECTATION_SECRETE");
    expect(regles("infra/deploy.sh", 'export SEED_ADMIN_PASSWORD="Zq8!mT4vLx9pWc2R"')).toContain("AFFECTATION_SECRETE");
    expect(regles("compose.yml", "      POSTGRES_PASSWORD: s3cr3tValue9XyZab")).toContain("AFFECTATION_SECRETE");
    expect(regles("src/config.ts", 'const apiKey = "k8s9Dj2LmQ7xVb3NpR5tYw1ZcA4fGh6u";')).toContain("AFFECTATION_SECRETE");
  });

  it("une adresse IPv4 publique, dans le code comme dans un script ou un document", () => {
    expect(regles("infra/envoyer.sh", `scp archive.tgz agent@${ipPublique()}:/data`)).toContain("IP_SERVEUR");
    expect(regles("docs/x.md", `Le serveur ${ipPublique()} heberge la base.`)).toContain("IP_SERVEUR");
    expect(regles("src/a.ts", `const h = "${ipPublique()}";`)).toContain("IP_SERVEUR");
  });

  it("rapporte OU, jamais QUOI : la valeur secrete est masquee dans l'extrait", () => {
    const [t] = balayerTexte("infra/deploiement.conf", "JWT_ACCESS_SECRET=k8s9Dj2LmQ7xVb3NpR5tYw1ZcA4fGh6u");
    expect(t.extrait).not.toContain("k8s9Dj2LmQ7xVb3NpR5tYw1ZcA4fGh6u");
    expect(t.extrait).toContain("***");
  });
});

describe("le balayage NE crie PAS au loup", () => {
  it("adresses de bouclage, privees, de documentation, reservees et numeros de version", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.10", "169.254.0.1", "100.64.0.1", "192.0.2.7", "198.51.100.9", "203.0.113.4", "255.255.255.255", "224.0.0.1"]) {
      expect(adresseNonPublique(ip), ip).toBe(true);
    }
    expect(adresseNonPublique("172.32.0.1")).toBe(false);            // juste hors du bloc prive
    expect(regles("README.md", "Postgres 17.2 et la version 1.2.3.4.5 de x")).not.toContain("IP_SERVEUR");
    expect(regles("README.md", "listen 127.0.0.1:5434 et 192.168.0.12")).not.toContain("IP_SERVEUR");
  });

  it("coordonnees et decimaux ne sont pas des adresses", () => {
    expect(regles("a.ts", "const p = [-13.6012, 9.6411];")).not.toContain("IP_SERVEUR");
    expect(regles("a.sql", "ST_MakePoint(-13.60, 9.64)")).not.toContain("IP_SERVEUR");
  });

  it("des marqueurs de valeur factice ne sont pas des secrets", () => {
    for (const v of ["changeme-access-secret-min-32-chars", "<votre-mot-de-passe>", "${MDP}", "xxxxxxxxxxxxxxxx", "REDACTED", "process.env.JWT_SECRET", "exemple-de-jeton-long"]) {
      expect(estValeurFactice(v), v).toBe(true);
    }
    expect(regles(".env.example", 'JWT_ACCESS_SECRET="changeme-access-secret-min-32-chars"')).toEqual([]);
    expect(regles(".env.example", 'SEED_ADMIN_PASSWORD="changeme-mot-de-passe-admin-initial"')).toEqual([]);
  });

  it("dans le CODE, un nom ou un message entre guillemets n'est pas un secret", () => {
    for (const l of ['const tokenHash = "tokenHash";', 'password: z.string().min(12)', 'const MSG_TOKEN = "jeton expire ou invalide";', 'type: "refresh-token-reuse"', 'passwordHash: "x"']) {
      expect(regles("src/a.ts", l), l).not.toContain("AFFECTATION_SECRETE");
    }
  });

  it("un fichier de TEST n'est pas soumis a l'affectation de secret (ses mots de passe sont factices), mais l'est au reste", () => {
    expect(regles("src/a.test.ts", 'const motDePasse = "Zq8!mT4vLx9pWc2R-token";')).not.toContain("AFFECTATION_SECRETE");
    expect(regles("src/a.test.ts", `${BLOC("RSA PRIVATE KEY")}`)).toContain("CLE_PRIVEE");
    expect(regles("src/a.test.ts", `ip ${ipPublique()}`)).toContain("IP_SERVEUR");
  });

  it("l'entropie separe un texte lisible d'une valeur aleatoire", () => {
    expect(entropie("aaaaaaaaaaaa")).toBe(0);
    expect(entropie("k8s9Dj2LmQ7xVb3NpR5tYw1ZcA4fGh6u")).toBeGreaterThan(4);
    expect(entropie("jeton expire ou invalide")).toBeLessThan(4);
  });
});

describe("le depot suivi par git ne contient aucun secret", () => {
  const resultat = balayerArbre(RACINE);
  const nonExcusees = resultat.trouvailles.filter((t) => !estExcusee(t));

  it("aucune cle privee, fichier secret, jeton, mot de passe en URL ou en affectation, adresse IP publique hors exceptions justifiees", () => {
    expect(
      nonExcusees.map((t) => `${t.regle} ${t.chemin}${t.ligne ? `:${t.ligne}` : ""} -> ${t.extrait}`),
      "UN SECRET OU UNE ADRESSE DE SERVEUR EST DANS LE DEPOT. Ne l'excusez pas : retirez-le (regle 1 d'AGENTS.md), " +
        "faites tourner la valeur si elle etait reelle, et lisez docs/rai-v3/AUDIT_SECURITE_DEPOT_PUBLIC.md.",
    ).toEqual([]);
  });

  it("a lu l'essentiel du depot : plus de 800 fichiers, et la liste de ce qui n'a pas ete lu est connue", () => {
    expect(resultat.fichiersLus).toBeGreaterThan(800);
    // Les seuls fichiers qu'on ne lit pas sont des binaires ou des donnees volumineuses. Un nouveau venu doit etre examine.
    const attendus = new Set(["frontend/public/favicon.ico"]);
    const inattendus = resultat.ignores.filter((i) => !attendus.has(i.chemin));
    expect(inattendus.map((i) => `${i.chemin} (${i.raison})`)).toEqual([]);
  });

  it("aucun fichier d'environnement reel n'est suivi (seul .env.example l'est), et .gitignore les ecarte", () => {
    const suivis = execFileSync("git", ["ls-files"], { cwd: RACINE, encoding: "utf8" }).split("\n");
    expect(suivis.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !/\.(example|sample)$/.test(f))).toEqual([]);
    const ignore = execFileSync("git", ["check-ignore", "-v", "backend/.env", "backend/.env.production"], { cwd: RACINE, encoding: "utf8" });
    expect(ignore).toContain(".gitignore");
  });

  it("les valeurs du .env.example sont des marqueurs, pas des valeurs", () => {
    const t = balayerTexte("backend/.env.example", execFileSync("git", ["show", "HEAD:backend/.env.example"], { cwd: RACINE, encoding: "utf8" }));
    expect(t).toEqual([]);
  });
});

describe("la liste d'exceptions reste honnete", () => {
  const resultat = balayerArbre(RACINE);

  it("chaque exception est justifiee en une vraie phrase", () => {
    for (const e of EXCEPTIONS_SECRETS) {
      expect(e.justification.length, `${e.chemin} : justification trop courte`).toBeGreaterThanOrEqual(60);
      expect(path.isAbsolute(e.chemin)).toBe(false);
    }
  });

  it("aucune exception n'est PERIMEE : chacune excuse encore au moins une trouvaille", () => {
    const perimees = EXCEPTIONS_SECRETS.filter((e) => !resultat.trouvailles.some((t) => estExcusee(t, [e])));
    expect(perimees.map((e) => `${e.regle} ${e.chemin}`), "retirez les exceptions devenues inutiles").toEqual([]);
  });

  it("aucune exception ne couvre une cle privee, un fichier secret ou un jeton reconnu : on les retire, on ne les excuse pas", () => {
    const interdites: Regle[] = ["CLE_PRIVEE", "FICHIER_SECRET", "JETON_CONNU"];
    expect(EXCEPTIONS_SECRETS.filter((e) => interdites.includes(e.regle))).toEqual([]);
  });

  it("un secret excuse par erreur au meme endroit qu'une exception reste VU : l'exception est etroite (fichier et regle)", () => {
    const t = balayerTexte("infra/verifier-en-local.sh", "SEED_ADMIN_PASSWORD=Zq8mT4vLx9pWc2R7nB");
    expect(t.length).toBeGreaterThan(0);
    // L'exception existante couvre le fichier pour la regle AFFECTATION_SECRETE ; elle ne couvre pas un autre fichier.
    expect(estExcusee({ ...t[0], chemin: "infra/autre-script.sh" })).toBe(false);
    expect(estExcusee({ regle: "IP_SERVEUR", chemin: "infra/verifier-en-local.sh", ligne: 1, extrait: ipPublique() })).toBe(false);
  });
});
