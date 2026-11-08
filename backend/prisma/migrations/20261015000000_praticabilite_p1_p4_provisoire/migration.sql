-- NIVEAUX DE PRATICABILITE P1 A P4 -- PROPOSITION DU MANDAT, SEMEE PROVISOIRE ET NON APPROUVEE
--
-- `referentiel_praticabilites` est vide depuis sa creation, et c'etait voulu : le cahier des
-- charges demandait le referentiel sans enoncer une seule valeur, et le script de peuplement
-- refuse d'en inventer (D-02). Le paragraphe 7.17 du prompt maitre V10 change la situation sans
-- la renverser : il PROPOSE quatre niveaux, et l'arbitrage D7 range cette proposition en fiche de
-- decision -- « moteurs parametrables, resultats provisoires jusqu'a approbation ».
--
-- CE QUE CETTE MIGRATION FAIT : semer les quatre niveaux TELS QUE LE MANDAT LES ENONCE, avec
-- `source = 'mandat_v10_proposition'` et `approuveeLe` NUL. Le mecanisme devient eprouvable --
-- une portion peut porter un niveau, la carte peut l'afficher -- sans qu'aucun niveau fasse
-- foi. C'est exactement le statut des neuf baremes et des trois traitements.
--
-- CE QU'ELLE NE FAIT PAS : fixer les criteres d'attribution (quand une piste passe de P2 a P3),
-- le tonnage de P3, qui attribue et qui leve, la duree de validite. Ces quatre manques sont
-- ceux de la fiche D-02, et les combler ici serait inventer la norme. `saisonniere` reste a sa
-- valeur par defaut (false) pour les quatre : le mandat ne dit pas qu'un niveau est saisonnier
-- par nature, c'est la cause d'une attribution qui l'est.
--
-- `franchissable` est le seul champ ou une lecture est faite, et elle est litterale : P1, P2 et
-- P3 decrivent une circulation possible (P3 : « passage a vos risques »), P4 une route
-- « impraticable / coupee ». Rien de plus n'est deduit.
--
-- NATURE : additive, quatre lignes de referentiel. Aucune table existante touchee. Le script
-- `peupler-referentiels.ts` continue de ne rien inventer : il n'est pas modifie.

INSERT INTO "referentiel_praticabilites"
  ("code", "libelle", "description", "ordre", "franchissable", "source", "updatedAt")
VALUES
  ('P1', 'Circulation normale',
   'Circulation normale, sans restriction ni precaution particuliere. Proposition du paragraphe 7.17 du mandat V10, non approuvee.',
   1, true, 'mandat_v10_proposition', CURRENT_TIMESTAMP),
  ('P2', 'Circulation delicate',
   'Circulation delicate : vehicule 4x4 conseille, vitesse reduite. Proposition du paragraphe 7.17 du mandat V10, non approuvee.',
   2, true, 'mandat_v10_proposition', CURRENT_TIMESTAMP),
  ('P3', 'Circulation difficile',
   'Circulation difficile : poids lourds interdits ou restriction de tonnage, passage a vos risques. Le tonnage n''est pas fixe par le mandat. Proposition du paragraphe 7.17 du mandat V10, non approuvee.',
   3, true, 'mandat_v10_proposition', CURRENT_TIMESTAMP),
  ('P4', 'Impraticable ou coupee',
   'Route impraticable ou coupee : deviation. Proposition du paragraphe 7.17 du mandat V10, non approuvee.',
   4, false, 'mandat_v10_proposition', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

COMMENT ON TABLE "referentiel_praticabilites" IS
  'Niveaux de praticabilite, distincts de l''etat physique de la chaussee. Les quatre lignes '
  'P1-P4 sont la PROPOSITION du paragraphe 7.17 du mandat V10 (source = mandat_v10_proposition), '
  'semees le 15/10/2026 sans approbation : criteres d''attribution, tonnage de P3, autorite '
  'd''attribution et duree de validite restent a decider (D-02). Tant qu''approuveeLe est nul, '
  'aucun niveau ne fait foi.';
