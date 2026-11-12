#!/usr/bin/env python3
"""Acquire the immutable OmniRoute source needed for clean contract verification."""
import argparse
import os
import subprocess
from pathlib import PurePosixPath
from pathlib import Path
import hashlib
import json
import re
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def _closed(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(f"Invalid {label} fields")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def _git(repo, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    return subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env=env).stdout


def _path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValueError("Invalid derivation path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in (".", "..") for part in value.split("/")) or str(path) != value:
        raise ValueError("Invalid derivation path")
    return value


def derive(archive, release, digest, record_path, repo, output):
    """Build from the verified archive, never from the mutable official extraction."""
    with archive.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != digest:
            raise ValueError("Cached source archive digest mismatch")
    raw = record_path.read_bytes()
    if len(raw) > 1024 * 1024:
        raise ValueError("Derivation record exceeds 1 MiB")
    record = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    _closed(record, ("schema_version", "base", "repair_commit", "signature_evidence", "changes"), "record")
    _closed(record["base"], ("repository", "tag", "commit", "archive_sha256"), "base")
    _closed(record["signature_evidence"], ("kind", "fingerprint", "evidence"), "signature evidence")
    if type(record["schema_version"]) is not int or record["schema_version"] != 1:
        raise ValueError("Unsupported derivation schema")
    if record["base"] != {"repository": "diegosouzapw/OmniRoute", "tag": release["tag"],
                          "commit": release["peeled_commit"], "archive_sha256": digest}:
        raise ValueError("Derivation base differs from official pin")
    commit = record["repair_commit"]
    evidence = record["signature_evidence"]
    if not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid repair commit")
    if (evidence["kind"] != "prior-independent-verification" or
            not isinstance(evidence["fingerprint"], str) or not re.fullmatch(r"[A-F0-9]{40}", evidence["fingerprint"]) or
            not isinstance(evidence["evidence"], str) or not evidence["evidence"] or len(evidence["evidence"]) > 1024):
        raise ValueError("Invalid signature evidence")
    changes = record["changes"]
    if not isinstance(changes, list) or not changes or len(changes) > 1000:
        raise ValueError("Invalid derivation changes")
    expected = {}
    for change in changes:
        _closed(change, ("path", "input_sha256", "output_sha256"), "change")
        name = _path(change["path"])
        if name in expected:
            raise ValueError("Duplicate derivation path")
        for key in ("input_sha256", "output_sha256"):
            value = change[key]
            if not (key == "input_sha256" and value is None) and (not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)):
                raise ValueError("Invalid change digest")
        expected[name] = change
    parents = _git(repo, "rev-list", "--parents", "-n", "1", commit).decode("ascii").strip().split()
    if parents != [commit, release["peeled_commit"]]:
        raise ValueError("Repair must be a direct child of the official commit")
    diff = _git(repo, "diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", "-z", parents[1], commit).split(b"\0")
    if not diff or diff[-1] != b"" or len(diff) % 2 != 1:
        raise ValueError("Invalid repair diff")
    actual = {diff[i + 1].decode("utf-8"): diff[i].decode("ascii") for i in range(0, len(diff) - 1, 2)}
    if actual != {name: "A" if item["input_sha256"] is None else "M" for name, item in expected.items()}:
        raise ValueError("Repair changes differ from record")
    if output.exists() or output.is_symlink():
        raise ValueError("Derived output already exists")
    output = output.resolve()
    protected = (archive.resolve(), repo.resolve(), record_path.resolve(), ROOT.resolve())
    if any(output == path or output in path.parents or path in output.parents for path in protected):
        raise ValueError("Derived output overlaps a protected input or checkout")
    if output.exists():
        raise ValueError("Derived output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        extraction = Path(temporary) / "archive"
        extraction.mkdir()
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
        tree = children[0]
        if json.loads((tree / "package.json").read_text())["version"] != release["version"]:
            raise ValueError("Extracted source version differs from pin")
        for name, change in expected.items():
            entry = _git(repo, "ls-tree", commit, "--", name).decode("utf-8").strip()
            if not re.fullmatch(r"100644 blob [a-f0-9]{40}\t" + re.escape(name), entry):
                raise ValueError("Repair entry must be a regular non-executable file")
            if change["input_sha256"] is not None:
                base_entry = _git(repo, "ls-tree", parents[1], "--", name).decode("utf-8").strip()
                if not re.fullmatch(r"100644 blob [a-f0-9]{40}\t" + re.escape(name), base_entry):
                    raise ValueError("Base entry must be a regular non-executable file")
            data = _git(repo, "show", f"{commit}:{name}")
            if hashlib.sha256(data).hexdigest() != change["output_sha256"]:
                raise ValueError("Repair output digest mismatch")
            target = tree.joinpath(*PurePosixPath(name).parts)
            if change["input_sha256"] is None:
                if target.exists() or target.is_symlink():
                    raise ValueError("Added repair file already exists in archive")
            elif not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != change["input_sha256"]:
                raise ValueError("Repair input digest mismatch")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
        tree.rename(output)
    return {"status": "derived", "base_commit": release["peeled_commit"], "repair_commit": commit,
            "archive_sha256": digest, "record_sha256": hashlib.sha256(raw).hexdigest(),
            "source": str(output), "signature": "prior independent evidence recorded; not reverified by preparation"}


def prepare(args=None) -> None:
    provenance = json.loads((ROOT / "provenance/upstreams.json").read_text())
    upstream = next(item for item in provenance["upstreams"] if item["id"] == "omniroute")
    release, integrity = upstream["release"], upstream["artifact_integrity"]
    version, commit = release["version"], release["peeled_commit"]
    digest = integrity["source_archive_sha256"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid pinned OmniRoute source identity")
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or upstream["repository"] != "diegosouzapw/OmniRoute":
        raise ValueError("Invalid pinned source digest or repository")
    url = f"https://github.com/{upstream['repository']}/releases/download/v{version}/OmniRoute-v{version}.source.tar.gz"
    if integrity["source_archive_url"] != url:
        raise ValueError("Source URL differs from the pinned release asset")
    state = ROOT / ".agents/state/omp-provider-release/upstream"
    state.mkdir(parents=True, exist_ok=True)
    archive = state / f"omniroute-v{version}-{commit}.tar.gz"
    source = state / f"omniroute-v{version}"
    if not archive.exists():
        with tempfile.NamedTemporaryFile(dir=state, delete=False) as temporary:
            staging = Path(temporary.name)
        try:
            # Close the temporary handle before rename: Windows forbids renaming an open file.
            with staging.open("wb") as output:
                with urllib.request.urlopen(url, timeout=60) as response:
                    total = 0
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > 512 * 1024 * 1024:
                            raise ValueError("Pinned source archive exceeds 512 MiB")
                        output.write(chunk)
            with staging.open("rb") as handle:
                if hashlib.file_digest(handle, "sha256").hexdigest() != digest:
                    raise ValueError("Downloaded source archive digest mismatch")
            staging.rename(archive)
        finally:
            staging.unlink(missing_ok=True)
    with archive.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != digest:
            raise ValueError("Cached source archive digest mismatch")
    if args and args.derivation_record:
        print(json.dumps(derive(archive, release, digest, args.derivation_record,
                                args.repair_repository, args.derived_output)))
        return
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--derivation-record", type=Path)
    parser.add_argument("--repair-repository", type=Path)
    parser.add_argument("--derived-output", type=Path)
    args = parser.parse_args()
    if any((args.derivation_record, args.repair_repository, args.derived_output)) and not all(
            (args.derivation_record, args.repair_repository, args.derived_output)):
        parser.error("derivation requires --derivation-record, --repair-repository and --derived-output")
    prepare(args)
