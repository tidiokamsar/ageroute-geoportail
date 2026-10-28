"""Execution d'un outil GDAL en processus enfant BORNE.

Aucun shell : les arguments sont passes en LISTE. Chaque enfant a son propre groupe de
processus (tue en bloc au delai), des limites POSIX (CPU, taille de fichier ecrit, espace
d'adressage, descripteurs, pas de core), des sorties redirigees vers des fichiers (jamais de
tube illimite en memoire) et son pic de memoire est mesure (wait4).
"""
import os
import resource
import signal
import subprocess
import time
from dataclasses import dataclass

from erreurs import Interruption

interruption_demandee = False  # positionne par le gestionnaire de signaux du worker


@dataclass
class Execution:
    code_retour: int | None
    signal: int | None
    delai_depasse: bool
    stdout: str
    stderr: str
    pic_memoire_ko: int
    duree_ms: int

    @property
    def ok(self):
        return self.code_retour == 0 and not self.delai_depasse


def _lire_fin(chemin, octets=4096):
    try:
        with open(chemin, "rb") as f:
            f.seek(0, os.SEEK_END)
            taille = f.tell()
            f.seek(max(0, taille - octets))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def lancer(args, *, env, cwd, delai_s, stdout_chemin, fsize_octets, as_octets, nofile=256):
    """Lance `args` (liste). Retourne une Execution ; ne leve jamais pour un echec de l'outil."""
    stderr_chemin = stdout_chemin + ".err"
    delai_s = max(1, int(delai_s))

    def preparer():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (delai_s, delai_s + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize_octets, fsize_octets))
        resource.setrlimit(resource.RLIMIT_NOFILE, (nofile, nofile))
        if as_octets:
            resource.setrlimit(resource.RLIMIT_AS, (as_octets, as_octets))

    debut = time.monotonic()
    with open(stdout_chemin, "wb") as fo, open(stderr_chemin, "wb") as fe:
        p = subprocess.Popen(
            args, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe, env=env, cwd=cwd,
            preexec_fn=preparer, start_new_session=True, close_fds=True,
        )
        depasse = False
        statut = None
        rusage = None
        while True:
            pid, st, ru = os.wait4(p.pid, os.WNOHANG)
            if pid:
                statut, rusage = st, ru
                break
            if interruption_demandee:
                _tuer(p.pid)
                os.wait4(p.pid, 0)
                raise Interruption()
            if time.monotonic() - debut > delai_s:
                depasse = True
                _tuer(p.pid)
                _, statut, rusage = os.wait4(p.pid, 0)
                break
            time.sleep(0.02)
        # Plus aucun processus du groupe ne doit survivre.
        _tuer(p.pid)
        p.returncode = 0  # evite que Popen ne tente de re-attendre un pid deja recolte
    code = sig = None
    if os.WIFEXITED(statut):
        code = os.WEXITSTATUS(statut)
    elif os.WIFSIGNALED(statut):
        sig = os.WTERMSIG(statut)
    return Execution(
        code_retour=code, signal=sig, delai_depasse=depasse,
        stdout=stdout_chemin, stderr=_lire_fin(stderr_chemin),
        pic_memoire_ko=int(getattr(rusage, "ru_maxrss", 0)),
        duree_ms=int((time.monotonic() - debut) * 1000),
    )


def _tuer(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
