#!/usr/bin/env python3
"""Acquire the immutable OmniRoute source needed for clean contract verification."""
from pathlib import Path
import hashlib
import json
import re
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def prepare() -> None:
    provenance = json.loads((ROOT / "provenance/upstreams.json").read_text())
    upstream = next(item for item in provenance["upstreams"] if item["id"] == "omniroute")
    release, integrity = upstream["release"], upstream["artifact_integrity"]
    version, commit = release["version"], release["peeled_commit"]
    digest = integrity["source_archive_sha256"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid pinned OmniRoute source identity")
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or upstream["repository"] != "diegosouzapw/OmniRoute":
        raise ValueError("Invalid pinned source digest or repository")
    url = f"https://github.com/{upstream['repository']}/archive/{commit}.tar.gz"
    if integrity["source_archive_url"] != url:
        raise ValueError("Source URL differs from the immutable repository commit")
    state = ROOT / ".agents/state/omp-provider-release/upstream"
    state.mkdir(parents=True, exist_ok=True)
    archive = state / f"omniroute-v{version}-{commit}.tar.gz"
    source = state / f"omniroute-v{version}"
    if not archive.exists():
        with tempfile.NamedTemporaryFile(dir=state, delete=False) as temporary:
            staging = Path(temporary.name)
            try:
                # codeload serves the exact immutable GitHub archive and avoids HTML redirects.
                with urllib.request.urlopen(f"https://codeload.github.com/{upstream['repository']}/tar.gz/{commit}", timeout=60) as response:
                    total = 0
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > 512 * 1024 * 1024:
                            raise ValueError("Pinned source archive exceeds 512 MiB")
                        temporary.write(chunk)
                temporary.flush()
                with staging.open("rb") as handle:
                    if hashlib.file_digest(handle, "sha256").hexdigest() != digest:
                        raise ValueError("Downloaded source archive digest mismatch")
                staging.rename(archive)
            finally:
                staging.unlink(missing_ok=True)
    with archive.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != digest:
            raise ValueError("Cached source archive digest mismatch")
    if not source.exists():
        with tempfile.TemporaryDirectory(dir=state) as temporary:
            extraction = Path(temporary)
            with tarfile.open(archive, "r:gz") as bundle:
                members = bundle.getmembers()
                if len(members) > 100_000 or sum(member.size for member in members) > 2 * 1024**3:
                    raise ValueError("Pinned source exceeds extraction limits")
                if any(not (member.isdir() or member.isfile()) for member in members):
                    raise ValueError("Source archive contains links or special entries")
                bundle.extractall(extraction, members=members, filter="data")
            children = list(extraction.iterdir())
            if len(children) != 1 or not children[0].is_dir():
                raise ValueError("Source archive must have one top-level directory")
            children[0].rename(source)
    if json.loads((source / "package.json").read_text())["version"] != version:
        raise ValueError("Extracted source version differs from pin")
    print(json.dumps({"status": "prepared", "tag": release["tag"], "commit": commit, "sha256": digest}))


if __name__ == "__main__":
    prepare()
