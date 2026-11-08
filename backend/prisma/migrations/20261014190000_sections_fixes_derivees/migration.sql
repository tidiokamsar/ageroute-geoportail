-- SECTIONS FIXES DERIVEES DES PORTIONS HOMOGENES (IO-03 / IO-04)
--
-- L'arbitrage D6 du prompt maitre V10 tranche : « Portions homogenes = verite ; sections fixes
-- = vue derivee parametrable (IO-03/IO-04) ; JAMAIS de saisie au niveau section ».
--
-- POURQUOI UNE FONCTION ET AUCUNE TABLE
--
-- Ce fichier ne cree AUCUNE table de sections, et c'est le coeur de la decision. Une table de
-- sections serait un second endroit ou l'etat du reseau existe, donc un endroit ou il peut
-- diverger. Elle rendrait aussi techniquement possible la saisie au niveau section, que D6
-- interdit : une interdiction tenue par l'absence de l'objet vaut mieux qu'une interdiction
-- tenue par une consigne.
--
-- L'ordre importe et il est irreversible. Agreger des portions homogenes en sections de 100 m
-- est une operation bien definie et repetable. L'inverse -- reconstituer des portions depuis des
-- sections -- perd de l'information sans retour. Mettre la verite du mauvais cote aurait ete
-- une faute sans remede.
--
-- POURQUOI UNE FONCTION ET AUCUNE VUE NON PARAMETREE
--
-- D6 exige un pas PARAMETRABLE. Une vue SQL ne prend pas de parametre : il faudrait figer 100
-- ou 200, c'est-a-dire choisir a la place de l'ONR. Et une vue sur tout le registre serait un
-- piege de performance -- 185 264 km au pas de 100 m font plus de 1,85 million de lignes qu'un
-- `SELECT *` distrait materialiserait. La fonction rend le pas et le perimetre explicites.
--
-- QUELLE LONGUEUR FAIT FOI, ET POURQUOI CE N'EST PAS CELLE QUI EST PUBLIEE
--
-- `portions.debutM` est documente « en metres depuis le debut de la GEOMETRIE de reference ».
-- Le systeme d'abscisses est donc geometrique, et les sections doivent l'etre aussi : avec la
-- longueur declaree `troncons.longueurKm`, une portion pourrait tomber au-dela de la derniere
-- section si les deux valeurs divergent.
--
-- La fonction rend DONC les deux longueurs cote a cote, `longueurTronconM` (geometrique, en
-- `geography` comme le paragraphe 7.1 l'impose) et `longueurDeclareeM`. Leur ecart n'est pas
-- masque : il devient un signal de qualite lisible.
--
-- Un troncon SANS GEOMETRIE est exclu, et ce refus est voulu. Sans geometrie il n'a pas de
-- systeme d'abscisses, donc ses sections fixes ne sont pas definies. Se replier en silence sur
-- la longueur declaree fabriquerait des sections dont les portions ne parlent pas la meme
-- langue.
--
-- CE QUE CE FICHIER NE FAIT PAS : LA NOTE UEMOA
--
-- Le critere B11 attend que chaque section porte « l'etat de la portion dominante ET la note
-- UEMOA ». La premiere moitie est ici. LA SECONDE EST ABSENTE, volontairement.
--
-- `RCI_METHOD_DECISION.md` a etabli que je n'ai pas le texte de la directive n* 11/2009 ni ses
-- neuf indices -- seulement des tableaux en images. Le garde-fou du mandat est explicite :
-- aucune nomenclature ni seuil officiel inventes. Une colonne `noteUemoa` remplie par une
-- formule devinee serait pire qu'absente : elle aurait l'air d'une note sous-regionale
-- comparable. IO-04 est donc livre, IO-03 reste suspendu a la demande consignee en D-01.
--
-- ADDITIVE ET SANS DONNEE : cette migration cree une fonction. Elle n'ecrit, ne modifie et ne
-- supprime aucune ligne, et ne touche aucune table existante.

CREATE OR REPLACE FUNCTION reseau_sections_fixes(
  pas_m         double precision,
  troncon_ids   text[] DEFAULT NULL,
  a_la_date     date   DEFAULT NULL
)
RETURNS TABLE (
  "tronconId"          text,
  "indexSection"       integer,
  "debutM"             double precision,
  "finM"               double precision,
  "longueurM"          double precision,
  "longueurTronconM"   double precision,
  "longueurDeclareeM"  double precision,
  "etat"               text,
  "revetement"         text,
  "dominanteM"         double precision,
  "dominanteTaux"      double precision,
  "couvertureM"        double precision,
  "couvertureTaux"     double precision,
  "portionsCouvrantes" integer
)
LANGUAGE plpgsql
STABLE
AS $fn$
BEGIN
  -- Un pas nul ou negatif ne produit pas « aucune section », il produit une boucle infinie ou
  -- un resultat absurde. On refuse bruyamment plutot que de rendre un tableau vide, qu'un
  -- appelant lirait comme « ce troncon n'a pas de section ».
  IF pas_m IS NULL OR pas_m <= 0 THEN
    RAISE EXCEPTION 'reseau_sections_fixes : le pas doit etre strictement positif (recu : %)', pas_m
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH bornes AS (
    SELECT t.id                              AS troncon_id,
           ST_Length(t.geom::geography)      AS longueur_m,
           t."longueurKm" * 1000             AS longueur_declaree_m
      FROM troncons t
     WHERE t."deletedAt" IS NULL
       AND t.geom IS NOT NULL
       AND (troncon_ids IS NULL OR t.id = ANY (troncon_ids))
  ),
  sections AS (
    -- La DERNIERE section est un reste, jamais un paquet complet : `LEAST` la borne a la
    -- longueur du troncon. C'est ce qui fait tenir le critere B11 -- la somme des sections
    -- egale la longueur -- au lieu de la depasser du rembourrage de la derniere.
    SELECT b.troncon_id,
           k::integer                                  AS index_section,
           k * pas_m                                   AS debut_m,
           LEAST((k + 1) * pas_m, b.longueur_m)        AS fin_m,
           b.longueur_m,
           b.longueur_declaree_m
      FROM bornes b
      CROSS JOIN LATERAL generate_series(
        0,
        GREATEST(ceil(b.longueur_m / pas_m)::integer - 1, 0)
      ) AS k
     WHERE b.longueur_m > 0
  ),
  sections_utiles AS (
    -- Garde-fou de virgule flottante : `ceil` peut rendre une section de trop quand la division
    -- tombe juste au-dessus d'un entier. Une section vide ou inversee est alors ecartee, et la
    -- somme reste exacte.
    SELECT * FROM sections WHERE fin_m > debut_m
  ),
  portions_faisant_foi AS (
    -- LE MEME PREDICAT QUE LA CONTRAINTE D'EXCLUSION de `portions`, et ce n'est pas un hasard :
    -- `portion_validee_sans_chevauchement` ne porte que sur VALIDE, non remplacee, non
    -- supprimee. Sur cet ensemble, et sur lui seul, deux portions ne peuvent pas se chevaucher.
    -- La somme des recouvrements d'une section ne peut donc pas depasser sa longueur, et
    -- `couvertureTaux` reste dans [0, 1] par CONSTRUCTION et non par confiance.
    --
    -- Une proposition de terrain non validee n'entre pas : le critere A9 exige qu'elle
    -- n'apparaisse jamais comme officielle, et un export de sections fixes vers la BDR
    -- nationale est aussi officiel qu'un chiffre peut l'etre.
    SELECT p.id, p."tronconId", p."debutM", p."finM", p.etat, p.revetement
      FROM portions p
     WHERE p."statutValidation" = 'VALIDE'
       AND p."remplaceeLe" IS NULL
       AND p."deletedAt" IS NULL
       -- Axe TERRAIN de la bitemporalite, intervalle semi-ouvert [valideDu, valideAu).
       -- Une borne nulle n'est pas une borne fermee : elle signifie « on ne sait pas depuis
       -- quand », donc elle n'exclut pas.
       AND (
         a_la_date IS NULL
         OR (
           (p."valideDu" IS NULL OR p."valideDu" <= a_la_date)
           AND (p."valideAu" IS NULL OR p."valideAu" > a_la_date)
         )
       )
  ),
  chevauchements AS (
    -- Les colonnes portent ici des noms SUFFIXES, et ce n'est pas une coquetterie :
    -- `RETURNS TABLE` declare `etat` et `revetement` comme des VARIABLES plpgsql, qui entrent
    -- en collision avec les colonnes homonymes et font echouer la fonction sur un
    -- « column reference is ambiguous ». La directive `#variable_conflict use_column`
    -- resoudrait le conflit, mais en silence et pour toute la fonction : le jour ou un
    -- parametre porterait le nom d'une colonne, le bogue serait muet. Des noms distincts
    -- suppriment la question.
    SELECT s.troncon_id,
           s.index_section,
           pf.id          AS portion_id,
           pf.etat        AS etat_portion,
           pf.revetement  AS revetement_portion,
           LEAST(s.fin_m, pf."finM") - GREATEST(s.debut_m, pf."debutM") AS chevauchement_m
      FROM sections_utiles s
      JOIN portions_faisant_foi pf
        ON pf."tronconId" = s.troncon_id
       -- Intersection d'intervalles semi-ouverts : une portion qui FINIT ou la section COMMENCE
       -- ne la touche pas. Avec des bornes fermees, chaque frontiere de section compterait deux
       -- fois et la couverture depasserait 1.
       AND pf."debutM" < s.fin_m
       AND pf."finM"   > s.debut_m
  ),
  par_qualification AS (
    -- Regroupe par QUALIFICATION et non par portion : deux portions voisines de meme etat et
    -- meme revetement decrivent la meme chose, et les separer pourrait faire gagner la
    -- dominance a une qualification minoritaire mais d'un seul tenant.
    SELECT troncon_id, index_section, etat_portion, revetement_portion,
           SUM(chevauchement_m) AS chevauchement_m
      FROM chevauchements
     GROUP BY 1, 2, 3, 4
  ),
  dominante AS (
    SELECT DISTINCT ON (troncon_id, index_section)
           troncon_id, index_section, etat_portion, revetement_portion, chevauchement_m
      FROM par_qualification
     -- Depart au cordeau en cas d'egalite parfaite, pour que le resultat soit DETERMINISTE :
     -- un export reproductible ne peut pas dependre de l'ordre de lecture des lignes.
     ORDER BY troncon_id, index_section, chevauchement_m DESC,
              etat_portion NULLS LAST, revetement_portion NULLS LAST
  ),
  couverture AS (
    SELECT troncon_id, index_section,
           SUM(chevauchement_m)              AS couverture_m,
           COUNT(DISTINCT portion_id)::integer AS portions_couvrantes
      FROM chevauchements
     GROUP BY 1, 2
  )
  SELECT s.troncon_id,
         s.index_section,
         s.debut_m,
         s.fin_m,
         s.fin_m - s.debut_m,
         s.longueur_m,
         s.longueur_declaree_m,
         d.etat_portion,
         d.revetement_portion,
         d.chevauchement_m,
         CASE WHEN d.chevauchement_m IS NULL THEN NULL
              ELSE d.chevauchement_m / (s.fin_m - s.debut_m) END,
         COALESCE(c.couverture_m, 0),
         COALESCE(c.couverture_m, 0) / (s.fin_m - s.debut_m),
         COALESCE(c.portions_couvrantes, 0)
    FROM sections_utiles s
    LEFT JOIN dominante  d ON d.troncon_id = s.troncon_id AND d.index_section = s.index_section
    LEFT JOIN couverture c ON c.troncon_id = s.troncon_id AND c.index_section = s.index_section
   ORDER BY s.troncon_id, s.index_section;
END;
$fn$;

COMMENT ON FUNCTION reseau_sections_fixes(double precision, text[], date) IS
  'Sections fixes derivees des portions homogenes (IO-04, arbitrage D6). Le pas est '
  'parametrable (100 ou 200 m cote ONR). Aucune table de sections n''existe : la verite reste '
  'la portion homogene, et rien ne peut etre saisi au niveau section. La note UEMOA (IO-03) est '
  'volontairement absente, faute du texte de la directive n* 11/2009 -- voir D-01.';
