# Fixtures des lots d'import (tests de bout en bout)

Fichiers d'essai de `e2e/specs/08-imports.spec.ts`. Le jeton `{{SOURCE}}` est remplace par la source du test (unique), de sorte que le
meme fichier, recu par deux tests, ne soit pas pris pour un doublon. Aucun fichier ne contient de donnee reelle. Les fichiers trop
gros pour etre commites (plafond de taille) sont generes a la volee par le test et ne sont jamais ecrits dans le depot.

| Fichier | Sert a |
|---|---|
| lot-valide.csv, lot-valide.geojson | reception d'un lot valide (3 / 2 lignes) |
| crs-3857.geojson | CRS refuse : lot rejete avec son motif |
| sans-colonne.csv | colonne obligatoire absente : lot rejete |
| vide.csv | en-tete seul |
| binaire.csv | octets de controle renommes en .csv : 400 `FORMAT_INCOHERENT` |
| bom-crlf.csv | BOM UTF-8 et fins de ligne CRLF : accepte |
| hostile.csv | HTML, `<script>`, formules (`=`, `+`, `-`, `@`) : texte inerte a l'ecran, neutralise dans l'export |
| lot-v1/lot.csv, lot-v2/lot.csv | meme nom de fichier, contenus differents : deux lots |
| windows-1252.csv | octets non UTF-8 : 400 `ENCODAGE_NON_UTF8` |
