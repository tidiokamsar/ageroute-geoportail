import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 30 s et non les 5 s par defaut.
    //
    // Le hachage Argon2id est lent PAR CONSTRUCTION : c'est ce qui protege les mots
    // de passe. Sous les 5 s par defaut, password.test.ts echouait par intermittence
    // — mesure sur ce poste : 3,7 s a vide, 5,2 s sous charge, soit 2 echecs sur
    // 7 executions. Un test instable est pire qu'un test absent : il ferait echouer
    // des livraisons au hasard, et apprendrait a l'equipe a passer outre le rouge.
    //
    // Le plafond reste utile : il attrape une attente infinie, pas une lenteur
    // legitime.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
