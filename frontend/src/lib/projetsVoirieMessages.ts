/**
 * Messages en clair des codes d'erreur typés de l'assistant d'import (lot A1, docs/projets-voirie/CONTRAT-IMPORT.md, sections 5, 6 et 11).
 * Le texte du serveur n'est jamais affiché pour un code connu : il peut citer une valeur du fichier ou un détail technique.
 * Données seulement : aucune logique ici.
 */

const RIEN_ECRIT = " Rien n'a été écrit.";

export const MESSAGE_CODE_IMPORT: Record<string, string> = {
  // Archives (KMZ)
  ARCHIVE_INVALIDE: "L'archive est corrompue, tronquée ou incohérente : elle n'a pas été ouverte." + RIEN_ECRIT + " Exportez de nouveau le fichier KMZ depuis l'outil d'origine.",
  ARCHIVE_TROP_D_ENTREES: "L'archive contient trop d'entrées (plus de 100 par défaut). Elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_CHEMIN_DANGEREUX: "L'archive contient un chemin dangereux (remontée de dossier, chemin absolu ou caractère de contrôle). Elle est refusée en entier et n'a pas été extraite." + RIEN_ECRIT,
  ARCHIVE_NOMS_AMBIGUS: "L'archive contient deux entrées de même nom. Elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_LIEN_SYMBOLIQUE: "L'archive contient un lien symbolique. Elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_ENTREE_SPECIALE: "L'archive contient une entrée spéciale (périphérique, tube). Elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_CHIFFREE: "L'archive contient une entrée chiffrée, qui ne peut pas être lue. Fournissez une archive non chiffrée." + RIEN_ECRIT,
  ARCHIVE_METHODE_NON_SUPPORTEE: "L'archive utilise une méthode de compression non prise en charge (seuls « stocké » et « deflate » sont lus)." + RIEN_ECRIT,
  ARCHIVE_IMBRIQUEE: "L'archive contient une autre archive : elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_TROP_GROSSE: "Une fois décompressée, l'archive dépasse la taille autorisée (25 Mo par entrée, 100 Mo au total par défaut). Elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_TAUX_COMPRESSION: "Le taux de compression de l'archive est anormalement élevé (risque de bombe de décompression). Elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_CHEVAUCHEMENT: "Les données de plusieurs entrées de l'archive se recouvrent (archive piégée). Elle est refusée en entier." + RIEN_ECRIT,
  ARCHIVE_TROP_PROFONDE: "L'archive contient trop de niveaux de dossiers. Elle est refusée en entier." + RIEN_ECRIT,
  KMZ_SANS_KML: "L'archive ne contient aucun fichier KML. Un KMZ doit en contenir au moins un." + RIEN_ECRIT,
  KMZ_PLUSIEURS_KML: "L'archive contient plusieurs fichiers KML et aucun « doc.kml » à la racine : choisissez l'entrée à lire à l'étape « Format et couches ».",
  ENTREE_KML_INTROUVABLE: "L'entrée KML choisie n'existe pas dans l'archive : choisissez-en une dans la liste.",
  // CSV
  ENCODAGE_AMBIGU: "L'encodage du fichier ne peut pas être lu sans ambiguïté (ni UTF-8 valide, ni UTF-16 avec marque d'ordre). Choisissez l'encodage dans les options de lecture du tableau, ou enregistrez le fichier en UTF-8.",
  ENCODAGE_NON_SUPPORTE: "L'encodage déclaré ne correspond pas au contenu du fichier. Choisissez un autre encodage ou enregistrez le fichier en UTF-8.",
  DELIMITEUR_AMBIGU: "Plusieurs délimiteurs sont cohérents dans ce fichier : choisissez le délimiteur (virgule, point-virgule, tabulation ou barre verticale) dans les options de lecture du tableau.",
  SEPARATEUR_DECIMAL_AMBIGU: "Les colonnes de coordonnées mélangent le point et la virgule décimaux : choisissez le séparateur décimal dans les options de lecture du tableau.",
  CSV_STRUCTURE_INVALIDE: "La structure du tableau est invalide (guillemet non fermé ou caractère inattendu après un champ entre guillemets). Corrigez le fichier dans l'outil d'origine." + RIEN_ECRIT,
  CSV_TROP_DE_LIGNES: "Le tableau contient trop de lignes (plus de 500 000 par défaut). Découpez le fichier." + RIEN_ECRIT,
  CSV_TROP_DE_COLONNES: "Le tableau contient trop de colonnes (plus de 200). Retirez les colonnes inutiles." + RIEN_ECRIT,
  CSV_CELLULE_TROP_LONGUE: "Une cellule du tableau dépasse 10 000 caractères. Corrigez le fichier." + RIEN_ECRIT,
  CSV_COLONNES_REQUISES: "Désignez les colonnes de coordonnées (X et Y) ou une colonne de géométrie WKT, jamais les deux : rien n'est deviné. Les colonnes clé et ordre n'existent que pour construire des lignes à partir de points.",
  CSV_COLONNE_INTROUVABLE: "Une colonne désignée n'existe pas dans le fichier. Choisissez-la de nouveau dans la liste des colonnes.",
  GPX_INVALIDE: "Le fichier GPX est invalide ou ne contient aucun élément exploitable." + RIEN_ECRIT,
  // Couches, mapping
  COUCHE_INTROUVABLE: "La couche choisie n'existe pas dans ce fichier. Relancez la détection et choisissez une couche de la liste.",
  MAPPING_INVALIDE: "La correspondance de champs est invalide (champ cible inconnu ou colonne source mal formée). Corrigez-la à l'étape « Correspondance des champs ».",
  MAPPING_COLONNE_INTROUVABLE: "Une colonne source de la correspondance n'existe pas dans le fichier (ou dans la couche choisie). Corrigez-la à l'étape « Correspondance des champs ».",
  // CRS
  CRS_REQUIS: "Le système de coordonnées doit être choisi par vous : il n'est jamais deviné. Choisissez-le à l'étape « Système de coordonnées ».",
  CRS_NON_AUTORISE: "Ce système de coordonnées n'est pas dans la liste validée par le DSI. Choisissez l'un des systèmes proposés.",
  CRS_NON_DISPONIBLE: "Ce système de coordonnées est autorisé mais la base de données ne le connaît pas : il ne peut pas être utilisé pour l'instant. Signalez-le à l'administrateur.",
  CRS_INCOMPATIBLE_FORMAT: "Un fichier KML, KMZ ou GPX est en WGS 84 par la norme du format : un autre système ne peut pas lui être appliqué. Pour des coordonnées projetées, utilisez un GeoJSON ou un tableau CSV.",
  CRS_CONFLIT: "Le système choisi diffère de celui que déclare le fichier : un système déclaré ne se remplace pas. Choisissez celui que le fichier déclare.",
  CRS_INCOHERENT: "Les valeurs ne sont pas des degrés : ce sont probablement des mètres d'un système projeté (par exemple l'UTM 29N). Aucun système n'est deviné : choisissez le bon système à l'étape « Système de coordonnées ».",
  TRANSFORMATION_ECHEC: "La transformation de coordonnées a échoué pour une valeur du fichier avec ce système. Vérifiez le système choisi et l'ordre des colonnes X et Y.",
  CONFIRMATION_HORS_ZONE_REQUISE: "Des éléments tombent hors de la zone attendue (la Guinée) avec le système choisi. Vérifiez le système, ou confirmez explicitement que ces éléments seront écartés.",
  // Fichier, envoi
  EMPREINTE_DIVERGENTE: "Le fichier envoyé n'est pas celui qui a été contrôlé (empreinte SHA-256 différente) : le fichier a changé depuis l'aperçu. Reprenez l'assistant avec ce fichier." + RIEN_ECRIT,
  FICHIER_MANQUANT: "Aucun fichier n'a été reçu par le serveur. Choisissez de nouveau le fichier." + RIEN_ECRIT,
  TELEVERSEMENT_INVALIDE: "Le téléversement est invalide ou a été interrompu. Réessayez." + RIEN_ECRIT,
  CHAMPS_INVALIDES: "Les options envoyées sont incohérentes ou refusées par le serveur. Vérifiez les étapes précédentes, puis réessayez.",
  PARAMETRES_INVALIDES: "Les paramètres envoyés sont invalides. Rouvrez l'assistant puis réessayez.",
  CONCESSIONNAIRE_REQUIS: "Un réseau de concessionnaire exige un concessionnaire connu : choisissez-le (ou créez-le) à l'étape « Dépôt du fichier ». Un concessionnaire n'est jamais créé par un import.",
  CONCESSIONNAIRE_INTROUVABLE: "Le concessionnaire choisi n'existe plus. Choisissez-en un autre à l'étape « Dépôt du fichier ».",
  NATURE_INCOMPATIBLE: "La nature des objets choisie n'est pas compatible avec le rôle du fichier. Corrigez-la à l'étape « Dépôt du fichier ».",
  JUSTIFICATION_INVALIDE: "La justification doit comporter 10 caractères au moins.",
  // Versions, suppressions, retour arrière
  JEU_INTROUVABLE: "Ce jeu de données est introuvable (retiré, ou hors de votre périmètre). Rechargez la page.",
  SUPPRESSIONS_A_REVOIR: "Cette version retire des objets de la version autorisée : une revue humaine justifiée des suppressions est exigée avant l'autorisation. Aucune suppression n'est appliquée sans revue.",
  SUPPRESSIONS_REFUSEES: "Les suppressions de cette version ont été refusées à la revue : elle ne peut plus être autorisée. Rejetez-la ou déposez un fichier corrigé.",
  AUCUNE_SUPPRESSION: "Cette version ne retire aucun objet de la version autorisée : il n'y a rien à revoir.",
  AUCUNE_VERSION_PRECEDENTE: "Ce jeu ne remplaçait aucune version : il n'y a rien à remettre en service.",
  VERSION_PRECEDENTE_INDISPONIBLE: "La version précédente n'est plus disponible (elle a été retirée) : le retour arrière est impossible.",
  // Délais et charge
  APERCU_TROP_LONG: "Le calcul a dépassé le délai autorisé et a été interrompu : le fichier est trop volumineux pour un contrôle immédiat. Découpez-le ou simplifiez-le, puis réessayez.",
  TROP_DE_REQUETES: "Trop de demandes en peu de temps. Attendez quelques instants avant de réessayer.",
  // Contenu du fichier (lecteurs historiques)
  JSON_TROP_PROFOND: "Le document JSON est trop imbriqué pour être lu." + RIEN_ECRIT,
  XML_INVALIDE: "Le document XML est invalide ou tronqué." + RIEN_ECRIT,
  DTD_REFUSEE: "Le document contient une déclaration de type de document (DTD), refusée par sécurité." + RIEN_ECRIT,
  ENTITE_REFUSEE: "Le document contient une entité XML, refusée par sécurité." + RIEN_ECRIT,
  XML_TROP_PROFOND: "Le document XML est trop imbriqué pour être lu." + RIEN_ECRIT,
  JSON_INVALIDE: "Le document JSON est invalide ou tronqué." + RIEN_ECRIT,
  // Lot B2 : chaine GDAL (GeoPackage, Shapefile ZIP, DXF), DESACTIVEE par defaut
  FORMAT_GDAL_DESACTIVE: "Ce format (GeoPackage, Shapefile ZIP ou DXF) est désactivé sur ce serveur : la chaîne de conversion isolée n'est pas en service. Exportez le fichier en GeoJSON, KML, GPX ou CSV depuis votre logiciel SIG ou de dessin, puis déposez ce fichier." + RIEN_ECRIT,
  GDAL_DESACTIVE: "La conversion des formats GeoPackage, Shapefile ZIP et DXF est désactivée sur ce serveur. Déposez le fichier en GeoJSON, KML, GPX ou CSV." + RIEN_ECRIT,
  CONVERSION_ASYNCHRONE_REQUISE: "Ce format est lu par la chaîne de conversion isolée, en tâche de fond : cette interface ne pilote pas encore cette conversion. Déposez le fichier en GeoJSON, KML, GPX ou CSV." + RIEN_ECRIT,
  METHODE_ACQUISITION_INCONNUE: "Cette méthode d'acquisition n'est pas acceptée par le serveur : choisissez-en une autre dans la liste, ou laissez-la non renseignée." + RIEN_ECRIT,
  TYPE_RESEAU_INCONNU: "Ce type de réseau est inconnu ou retiré du référentiel : choisissez-en un dans la liste." + RIEN_ECRIT,
  TYPE_RESEAU_INCOHERENT: "Le type de réseau choisi n'appartient pas à la famille indiquée : choisissez le type seul, la famille en est déduite." + RIEN_ECRIT,
};
