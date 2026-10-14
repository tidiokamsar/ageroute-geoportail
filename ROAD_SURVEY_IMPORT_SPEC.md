# Contrat d'import unique des données externes

> Livrable 5 du § B.6, exigé par le § E.3 du prompt maître V10 : « Toute donnée importée […]
> conserve source, auteur/importateur, date, méthode, format, lot, validations, erreurs et
> transformations appliquées ». **Rédigé le 14/10/2026.**
>
> 🔒 Spécification, étiquetée **proposition**. L'importateur n'existe pas dans le code.

## 1. Un seul contrat pour toutes les sources

Le § E.3 énumère ce qui entre : comptages manuels, automatiques ou vidéo ; stations de mesure ;
pesage ; relevés de dégradations issus d'un traitement externe ; historiques d'une BDR ou d'un
logiciel tiers ; produits satellitaires ; télématique. Et ANASUR Collect, quand un export
existera.

**Un contrat unique**, parce que la question est toujours la même : *d'où vient cette ligne, qui
l'a fait entrer, qu'a-t-on changé, et qu'est-elle devenue ?* Un importateur par source
répondrait différemment à chaque fois, et c'est là que la provenance se perd.

## 2. Le lot — proposition

Table `lots_import`, non créée.

| Champ | Rôle | Obligatoire |
|---|---|---|
| `id`, `reference` | identifiant stable lisible (`IMP-2026-000012`) | oui |
| `systemeSource` | vocabulaire administrable | oui |
| `format` | tel que reçu, **jamais présumé** | oui |
| `empreinteFichier` | SHA-256 relevé **à la réception** | oui |
| `nomFichier`, `tailleOctets` | — | oui |
| `importeParId`, `importeLe` | l'importateur, pas l'auteur | oui |
| `auteurSource` | l'auteur chez la source, tel que déclaré | si connu |
| `dateSource` | date du relevé ou de l'export chez la source | si connue |
| `methodeSource` | comptage manuel, vidéo, profilomètre, satellite… | oui |
| `versionMapping` | version de `BDR_FIELD_MAPPING_TEMPLATE.csv` appliquée | oui |
| `autorisationRef` | référence de l'autorisation écrite (§ B.4) | oui |
| `statut` | `RECU`, `VALIDE_SCHEMA`, `IMPORTE_TEST`, `IMPORTE`, `REJETE` | oui |
| `compteurs` | lignes lues, importées, rejetées, en conflit, ignorées — **leur somme égale le total** (A28) | oui |

## 3. La ligne — proposition

Chaque ligne importée, quel que soit l'objet cible, porte :

| Champ | Rôle |
|---|---|
| `lotId` | — |
| `numeroLigne` | position dans le fichier source, pour retrouver l'original |
| `identifiantSource` | tel que reçu |
| `chargeOriginale` | **la ligne brute**, JSON, avant toute transformation |
| `transformations` | liste ordonnée : conversion d'unité, de SRID, de code — **jamais une valeur inventée** |
| `statut` | `IMPORTEE`, `REJETEE`, `EN_CONFLIT`, `IGNOREE` — **exactement un** |
| `motifRejet` | règle violée, obligatoire si `REJETEE` |
| `correspondanceId` | vers `correspondances_identifiants` (`BDR_ID_CROSSWALK_SPEC.md`) |
| `objetCibleId`, `objetCibleType` | ce qui a été créé — **toujours en `A_VALIDER`** |

Conserver la charge originale coûte de l'espace et rend l'import **contestable** : si un
rapprochement est faux, on repart de ce qui a été reçu, pas de ce qu'on en a fait.

## 4. Les règles qui ne se discutent pas

| Règle | Source | Tenue par |
|---|---|---|
| Les données importées sont **« importées / à vérifier »** et n'écrasent jamais le référentiel | § B.4 | `statutValidation = A_VALIDER`, existant |
| Les algorithmes de vision, d'IA ou de télédétection **ne produisent que des propositions** | § E.3 | `media_analyse_coherente`, existant ; aucun chemin d'écriture ne valide |
| **Idempotence** : même lot deux fois = aucune écriture | § B.4, A28 | empreinte du fichier + clé (lot, ligne) — à écrire |
| **100 % des lignes dans un statut** | A28 | contrainte sur les compteurs — à écrire |
| **Aucune fusion ni suppression automatique** | § B.4 | par construction : l'importateur ne possède aucune opération de suppression |
| **SRID 4326** en base, longueurs en `geography`, surfaces en UTM 28N/29N | § 7.1 | conversion déclarée dans `transformations` |

## 5. Ce que le contrat ne couvre pas

- Les **médias** volumineux de télématique ou d'imagerie 360° : le contrat enregistre
  l'empreinte et l'emplacement, pas le contenu — stockage à décider avec l'infrastructure.
- Les **produits satellitaires** (partie E) : même contrat, mais conçu pour **descendre** des
  produits ; aucun média d'AGEROUTE ne remonte vers un service externe sans analyse de
  confidentialité.
