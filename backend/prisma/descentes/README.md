# Scripts de retour arriere

Le paragraphe 9.4 du mandat v2.1 exige des migrations « additives, reversibles, **testees en
montee ET en descente** sur une base de developpement ». Prisma Migrate ne gere pas de
migrations descendantes : ces scripts sont ecrits a la main, un par migration reversible, et
nommes d'apres elle.

## Pourquoi ils ne sont PAS dans le dossier de la migration

Prisma lit `migration.sql` dans chaque dossier de `prisma/migrations/`. Un second fichier
`.sql` y est tres probablement ignore — le nom `migration.sql` est code en dur dans l'outil —
mais je n'ai pas pu l'etablir avec certitude, et le risque est asymetrique : si un
`descente.sql` etait execute pendant un `migrate deploy`, il SUPPRIMERAIT les colonnes que la
migration vient d'ajouter, en production.

Devant une incertitude dont le cout est une perte de donnees, le dossier separe est la
reponse. On y perd un peu de localite, on y gagne l'impossibilite de cet accident.

## Ils n'ont PAS ete executes

Aucune base de developpement n'existe : pas de PostgreSQL local, pas de Docker fonctionnel sur
le poste de travail, et le garde-fou 2.1 interdit toute operation sur la production. C'est le
blocage **B-13**.

L'exigence du paragraphe 9.4 n'est donc **pas tenue**, et ces scripts ne sont pas declares
testes. Ils sont relus, commentes, et attendent une base pour etre eprouves.

## Avant d'en executer un

Chaque script commence par les requetes de comptage a lancer. Une descente retire des
colonnes : si des lignes portent des valeurs, **leur contenu est perdu sans recours**. Une date
d'effet terrain ne se recalcule pas depuis les dates systeme, et un resultat d'analyse ne se
reconstitue pas.

Si un comptage n'est pas nul, la descente exige une sauvegarde verifiee et une autorisation
explicite (garde-fou 2.2), et le garde-fou 2.8 interdit par ailleurs toute suppression
silencieuse de donnees.
