-- AGEROUTE ROAD : la correspondance valeur-source vers score, dans la regle versionnee.
--
-- CE QUI BLOQUAIT
--
-- `engines/condition.ts` recoit des composantes DEJA normalisees entre 0 et 100 et refuse
-- de deviner comment un etat `BON` devient un nombre. Rien ne produisait ces valeurs :
-- `calculerRci` n'etait appele que par ses tests. La chaine s'arretait donc avant de
-- commencer.
--
-- POURQUOI LA TABLE DE CORRESPONDANCE EST UNE DONNEE ET NON DU CODE
--
-- Dire que `BON` vaut 85 plutot que 90 deplace le score de tout le reseau. C'est une
-- DECISION, pas un calcul, et ecrite en dur personne ne pourrait dire qui l'a prise.
--
-- Elle rejoint donc les poids dans la regle versionnee, sous le meme interrupteur : une
-- regle non approuvee produit des scores marques `publiable: false`. Le mecanisme est du
-- code ; les nombres sont une decision d'AGEROUTE.
--
-- UNE VALEUR DE SOURCE ABSENTE DE LA TABLE REND LA COMPOSANTE ABSENTE
--
-- Et non zero. « Je ne sais pas lire cette valeur » n'est pas « cette valeur est mauvaise ».
-- Un etat inconnu compte comme zero ferait chuter le score d'un troncon pour une raison qui
-- n'a rien a voir avec la route — exactement le mensonge que le moteur refuse ailleurs en
-- renormalisant sur les composantes disponibles.
--
-- FORME
--
--   { "<COMPOSANTE>": { "<valeur source>": <0 a 100> } }
--
-- Le defaut `{}` est deliberement vide : sans correspondance declaree, AUCUNE composante
-- n'est lisible, et le moteur refuse tout score. C'est l'etat correct avant arbitrage, et
-- il est bruyant plutot que silencieux.
--
-- CETTE MIGRATION EST ADDITIVE ET N'ECRIT AUCUNE LIGNE.
-- `regles_condition` est vide en production : aucune regle n'a encore ete semee.

ALTER TABLE "regles_condition"
  ADD COLUMN "normalisation" JSONB NOT NULL DEFAULT '{}';

-- Une correspondance doit etre un OBJET, pas un tableau ni un scalaire.
--
-- `jsonb_typeof` l'impose en base plutot que dans le code : une regle semee par un script
-- futur, ou corrigee a la main un soir, ne doit pas pouvoir porter `normalisation: 42`.
-- Le moteur lirait alors une table vide et refuserait tous les scores sans dire pourquoi.
ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regle_normalisation_est_un_objet"
  CHECK (jsonb_typeof("normalisation") = 'object');

-- Meme controle sur les poids, qui n'en avaient pas.
--
-- L'oubli etait reel : `poids` est `JSONB NOT NULL` depuis le 13/10 sans contrainte de
-- forme, donc `poids: "trente pourcent"` passait. Le moteur aurait lu zero composante
-- ponderee et rendu AUCUN_POIDS_DECLARE, ce qui est le bon refus pour la mauvaise raison.
ALTER TABLE "regles_condition"
  ADD CONSTRAINT "regle_poids_est_un_objet"
  CHECK (jsonb_typeof("poids") = 'object');
