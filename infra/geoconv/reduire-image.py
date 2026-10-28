"""Etape de construction : retire les binaires inutiles au worker (shells, apt/dpkg, setuid)."""
import os
import stat

A_SUPPRIMER = [
    "/bin/sh", "/bin/bash", "/bin/dash", "/bin/rbash", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/dash", "/usr/bin/rbash",
    "/usr/bin/apt", "/usr/bin/apt-get", "/usr/bin/apt-cache", "/usr/bin/apt-config", "/usr/bin/apt-mark",
    "/usr/bin/dpkg", "/usr/bin/dpkg-deb", "/usr/bin/dpkg-query", "/usr/bin/dpkg-divert", "/usr/bin/dpkg-statoverride",
    "/usr/bin/dpkg-trigger", "/usr/bin/dpkg-split", "/usr/bin/dpkg-realpath", "/usr/bin/dpkg-maintscript-helper",
    "/usr/bin/su", "/usr/bin/sudo", "/usr/bin/login", "/usr/bin/newgrp", "/usr/bin/sg",
    "/usr/bin/curl", "/usr/bin/wget", "/usr/bin/nc", "/usr/bin/ssh", "/usr/bin/scp", "/usr/bin/perl", "/usr/bin/unzip",
    "/tmp/reduire-image.py",
]
retires = []
for chemin in A_SUPPRIMER:
    if os.path.lexists(chemin):
        os.unlink(chemin)
        retires.append(chemin)
# Retire les bits setuid/setgid restants (inertes avec no-new-privileges, retires par precaution).
for racine, dossiers, fichiers in os.walk("/usr", followlinks=False):
    for n in fichiers:
        p = os.path.join(racine, n)
        try:
            st = os.lstat(p)
            if stat.S_ISREG(st.st_mode) and st.st_mode & (stat.S_ISUID | stat.S_ISGID):
                os.chmod(p, st.st_mode & ~(stat.S_ISUID | stat.S_ISGID))
        except OSError:
            pass
print("retires :", len(retires))
