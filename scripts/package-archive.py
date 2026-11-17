#!/usr/bin/env python3
"""Preflight and extract npm package tarballs with portable path rules."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import unicodedata

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_MEMBER_COUNT = 100_000
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_PATH_LENGTH = 1024
EXACT_FILES = {
    "package.json",
    "VERSION",
    ".github/crux-experts-release-signing-key.asc",
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "ASSET_LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "SUPPORT.md",
    "LICENSE",
}
ALLOWED_PREFIXES = (
    "src/",
    "contracts/",
    "provenance/",
    "scripts/",
    "test/fixtures/",
    "assets/",
    "docs/",
    ".omp-plugin/",
)
WINDOWS_DEVICE_NAME = re.compile(r"(?i)^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$")
FIXTURE_NAME = "bottleneck"
FIXTURE_VERSION = "2.19.5"
FIXTURE_BYTES = 122422
FIXTURE_SHA256 = "a62dcc8a1260148fde067d36acc601a20532a34626e3b862b5f9eea140d97060"
FIXTURE_INTEGRITY = "sha512-VHiNCbI1lKdl44tGrhNfU3lup0Tj/ZBMJB5/2ZbNXRCPuRCO7ed2mgcK4r17y+KB2EfuYuRaVlwNbAeaWGSpbw=="
FIXTURE_MANIFEST = Path(__file__).resolve().parent.parent / "test/fixtures/pinned-ingress/dependencies.json"
FIXTURE_MAX_MEMBERS = 1000
FIXTURE_MAX_EXPANDED_BYTES = 2 * 1024 * 1024


def portable_component(component: str, raw_path: str) -> None:
    if component.endswith((".", " ")):
        raise ValueError(f"archive path is ambiguous on Windows: {raw_path}")
    if any(ord(character) < 32 or character in '<>:"|?*' for character in component):
        raise ValueError(f"archive path contains a Windows-invalid character: {raw_path}")
    if WINDOWS_DEVICE_NAME.fullmatch(component):
        raise ValueError(f"archive path uses a reserved Windows device name: {raw_path}")


def normalize_member(member: tarfile.TarInfo) -> tuple[str, bool]:
    raw_path = member.name
    if not raw_path or len(raw_path) > MAX_PATH_LENGTH or "\x00" in raw_path:
        raise ValueError("archive member has an empty, oversized, or NUL-containing path")
    if "\\" in raw_path or raw_path.startswith("/") or PurePosixPath(raw_path).is_absolute():
        raise ValueError(f"archive path is absolute or uses Windows separators: {raw_path}")
    is_directory = member.isdir()
    if raw_path.endswith("/"):
        if not is_directory:
            raise ValueError(f"non-directory archive path ends in a separator: {raw_path}")
        raw_path = raw_path[:-1]
    components = raw_path.split("/")
    if any(component in ("", ".", "..") for component in components):
        raise ValueError(f"archive path contains an unsafe component: {member.name}")
    if components[0] != "package":
        raise ValueError(f"archive entry is outside package/: {member.name}")
    for component in components:
        portable_component(component, member.name)
    relative_path = "/".join(components[1:])
    if not relative_path and not is_directory:
        raise ValueError("the package/ root entry must be a directory")
    return relative_path, is_directory


def allowed(relative_path: str, is_directory: bool) -> bool:
    if not relative_path:
        return is_directory
    if relative_path in EXACT_FILES:
        return not is_directory
    if any(relative_path.startswith(prefix) for prefix in ALLOWED_PREFIXES):
        return True
    if is_directory:
        prefix = relative_path.rstrip("/") + "/"
        return any(path.startswith(prefix) for path in EXACT_FILES) or any(
            allowed_prefix.startswith(prefix) for allowed_prefix in ALLOWED_PREFIXES
        )
    return False


def is_python_cache_path(relative_path: str) -> bool:
    components = relative_path.split("/")
    return any(component.casefold() == "__pycache__" for component in components) or (
        bool(components) and components[-1].casefold().endswith((".pyc", ".pyo"))
    )


def preflight(archive: Path | io.BytesIO, *, fixture: bool = False) -> tuple[list[tuple[tarfile.TarInfo, str, bool]], list[str]]:
    if not fixture:
        if archive.is_symlink() or not archive.is_file():
            raise ValueError("package archive must be a regular non-symlink file")
        if archive.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError(f"package archive exceeds {MAX_ARCHIVE_BYTES} bytes")
    with tarfile.open(fileobj=archive if fixture else None, name=None if fixture else str(archive), mode="r:*") as source:
        members: list[tarfile.TarInfo] = []
        for member in source:
            members.append(member)
            if len(members) > (FIXTURE_MAX_MEMBERS if fixture else MAX_MEMBER_COUNT):
                raise ValueError("package archive exceeds the member limit")
        if not members:
            raise ValueError("package archive has no members")
        total_size = sum(member.size for member in members if member.isfile())
        if total_size > (FIXTURE_MAX_EXPANDED_BYTES if fixture else MAX_EXPANDED_BYTES):
            raise ValueError("package archive exceeds the expanded size limit" if fixture else f"package archive expands beyond {MAX_EXPANDED_BYTES} bytes")

        checked: list[tuple[tarfile.TarInfo, str, bool]] = []
        seen_paths: set[str] = set()
        portable_paths: dict[str, str] = {}
        portable_prefixes: dict[str, str] = {}
        kinds: dict[str, str] = {}
        files: list[str] = []
        for member in members:
            if not (member.isfile() or member.isdir()):
                raise ValueError(f"archive links and special entries are not allowed: {member.name}")
            if member.size < 0 or (member.isdir() and member.size != 0):
                raise ValueError(f"archive member has invalid size metadata: {member.name}")
            path, is_directory = normalize_member(member)
            if not fixture and is_python_cache_path(path):
                raise ValueError(f"Python bytecode/cache paths are not allowed in package archives: {path}")
            if not fixture and not allowed(path, is_directory):
                raise ValueError(f"package archive entry is not allowlisted: {path}")
            if path in seen_paths:
                raise ValueError(f"package archive contains a duplicate entry: {member.name}")
            seen_paths.add(path)

            folded = unicodedata.normalize("NFKC", path).casefold()
            existing_path = portable_paths.get(folded)
            if existing_path is not None and existing_path != path:
                raise ValueError(f"package archive contains a Windows-ambiguous path: {path}")
            portable_paths[folded] = path

            components = path.split("/") if path else []
            for count in range(1, len(components) + 1):
                prefix = "/".join(components[:count])
                folded_prefix = unicodedata.normalize("NFKC", prefix).casefold()
                existing_prefix = portable_prefixes.get(folded_prefix)
                if existing_prefix is not None and existing_prefix != prefix:
                    raise ValueError(f"package archive has Windows-ambiguous directory casing: {prefix}")
                portable_prefixes[folded_prefix] = prefix

            kind = "directory" if is_directory else "file"
            if path and path in kinds and kinds[path] != kind:
                raise ValueError(f"package archive path is both a file and a directory: {path}")
            if not is_directory and any(existing.startswith(path + "/") for existing in kinds):
                raise ValueError(f"package archive file is also a parent directory: {path}")
            parent = path.rpartition("/")[0]
            while parent:
                if kinds.get(parent) == "file":
                    raise ValueError(f"package archive descends through a regular file: {path}")
                parent = parent.rpartition("/")[0]
            if path:
                kinds[path] = kind
            if not is_directory:
                files.append(path)
            checked.append((member, path, is_directory))

        if "package.json" not in files:
            raise ValueError("package archive is missing package/package.json")
        return checked, sorted(files)


def extract(archive: Path | io.BytesIO, destination: Path, *, fixture: bool = False) -> dict[str, object]:
    checked, files = preflight(archive, fixture=fixture)
    if destination.is_symlink():
        raise ValueError("extraction destination must not be a symbolic link")
    destination.mkdir(parents=True, exist_ok=True)
    if not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("extraction destination must be an empty directory")
    root = destination.resolve()
    package_root = root / "package"
    package_root.mkdir()

    if fixture:
        archive.seek(0)
    with tarfile.open(fileobj=archive if fixture else None, name=None if fixture else str(archive), mode="r:*") as source:
        source_members = {member.name: member for member in source.getmembers()}
        for member, relative_path, is_directory in checked:
            if not relative_path:
                continue
            target = package_root.joinpath(*relative_path.split("/"))
            try:
                target.resolve(strict=False).relative_to(package_root.resolve())
            except ValueError as error:
                raise ValueError(f"archive path escaped extraction directory: {member.name}") from error
            if is_directory:
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = 0o755 if member.mode & 0o111 else 0o644
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            extracted = source.extractfile(source_members[member.name])
            if extracted is None:
                os.close(descriptor)
                raise ValueError(f"could not read regular archive member: {member.name}")
            copied = 0
            with extracted, os.fdopen(descriptor, "wb") as output:
                while chunk := extracted.read(1024 * 1024):
                    output.write(chunk)
                    copied += len(chunk)
            if copied != member.size:
                raise ValueError(f"archive member size changed while extracting: {member.name}")

    return {"root": str(package_root), "entries": files}


def extract_fixture(archive: Path, destination: Path) -> dict[str, object]:
    manifest = json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))
    entries = [entry for entry in manifest["packages"] if entry.get("location") == "node_modules/bottleneck"]
    expected = {"name": FIXTURE_NAME, "version": FIXTURE_VERSION, "bytes": FIXTURE_BYTES,
                "sha256": FIXTURE_SHA256, "integrity": FIXTURE_INTEGRITY}
    if len(entries) != 1 or any(entries[0].get(key) != value for key, value in expected.items()):
        raise ValueError("approved fixture manifest identity mismatch")
    if archive.is_symlink():
        raise ValueError("fixture archive must be a regular non-symlink file")
    before = archive.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("fixture archive must be a regular non-symlink file")
    descriptor = os.open(archive, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(descriptor, "rb") as file:
        opened = os.fstat(file.fileno())
        if (not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(opened.st_mode)
                or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)):
            raise ValueError("fixture archive must be a regular non-symlink file")
        if opened.st_size != FIXTURE_BYTES:
            raise ValueError("fixture archive size mismatch")
        data = file.read(FIXTURE_BYTES + 1)
    if (len(data) != entries[0]["bytes"] or hashlib.sha256(data).hexdigest() != entries[0]["sha256"]
            or "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode("ascii") != entries[0]["integrity"]):
        raise ValueError("fixture archive digest mismatch")
    if destination.exists() or destination.is_symlink():
        raise ValueError("fixture destination must be a new directory")
    destination.mkdir()
    try:
        source = io.BytesIO(data)
        result = extract(source, destination, fixture=True)
        root = Path(result["root"])
        identity = json.loads((root / "package.json").read_text(encoding="utf-8"))
        if (identity.get("name") != FIXTURE_NAME or identity.get("version") != FIXTURE_VERSION
                or identity.get("license") != "MIT" or identity.get("dependencies", {}) != {}
                or identity.get("optionalDependencies", {}) != {} or not (root / "LICENSE").is_file()):
            raise ValueError("fixture package identity or license mismatch")
        actual = sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())
        if actual != result["entries"]:
            raise ValueError("fixture extraction inventory differs from files on disk")
        source.seek(0)
        inventory = []
        with tarfile.open(fileobj=source, mode="r:*") as tar:
            for path in actual:
                member = tar.getmember("package/" + path)
                expected_data = tar.extractfile(member).read()
                actual_data = (root / path).read_bytes()
                if actual_data != expected_data:
                    raise ValueError(f"fixture extracted content mismatch: {path}")
                inventory.append({"path": path, "bytes": len(actual_data), "sha256": hashlib.sha256(actual_data).hexdigest()})
        result["inventory"] = inventory
        result["archiveSha256"] = entries[0]["sha256"]
        return result
    except BaseException:
        shutil.rmtree(destination)
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("archive", type=Path)
    extract_parser.add_argument("destination", type=Path)
    fixture_parser = subparsers.add_parser("extract-approved-fixture")
    fixture_parser.add_argument("archive", type=Path)
    fixture_parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    if arguments.command == "extract":
        result = extract(arguments.archive, arguments.destination)
        print(json.dumps(result, separators=(",", ":")))
    elif arguments.command == "extract-approved-fixture":
        print(json.dumps(extract_fixture(arguments.archive, arguments.destination), separators=(",", ":")))


if __name__ == "__main__":
    main()
