"""Erreur metier du worker : un code stable (contrat) + un message lisible."""
import re

_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def nettoyer(texte, maxi=300):
    """Rend une chaine issue d'un fichier inoffensive pour un journal ou un JSON :
    pas de caracteres de controle, longueur bornee. Les noms de couches, d'entrees
    d'archive, les messages d'erreur de GDAL sont des DONNEES hostiles possibles."""
    if texte is None:
        return None
    s = _CTRL.sub("?", str(texte))
    s = s.replace("\n", " ").replace("\r", " ").replace("\t", " ")
    return s if len(s) <= maxi else s[: maxi - 1] + "…"


class ErreurGeoconv(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class Interruption(BaseException):
    """Signal d'arret (SIGTERM/SIGINT) recu pendant un job."""
