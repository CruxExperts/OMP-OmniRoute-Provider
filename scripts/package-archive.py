#!/usr/bin/env python3
"""Preflight and extract npm package tarballs with portable path rules."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import unicodedata

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_MEMBER_COUNT = 100_000
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_PATH_LENGTH = 1024
EXACT_FILES = {
    "package.json",
    "VERSION",
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


def preflight(archive: Path) -> tuple[list[tuple[tarfile.TarInfo, str, bool]], list[str]]:
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("package archive must be a regular non-symlink file")
    if archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError(f"package archive exceeds {MAX_ARCHIVE_BYTES} bytes")
    with tarfile.open(archive, mode="r:*") as source:
        members: list[tarfile.TarInfo] = []
        for member in source:
            members.append(member)
            if len(members) > MAX_MEMBER_COUNT:
                raise ValueError("package archive exceeds the member limit")
        if not members:
            raise ValueError("package archive has no members")
        total_size = sum(member.size for member in members if member.isfile())
        if total_size > MAX_EXPANDED_BYTES:
            raise ValueError(f"package archive expands beyond {MAX_EXPANDED_BYTES} bytes")

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
            if not allowed(path, is_directory):
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


def extract(archive: Path, destination: Path) -> dict[str, object]:
    checked, files = preflight(archive)
    if destination.is_symlink():
        raise ValueError("extraction destination must not be a symbolic link")
    destination.mkdir(parents=True, exist_ok=True)
    if not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("extraction destination must be an empty directory")
    root = destination.resolve()
    package_root = root / "package"
    package_root.mkdir()

    with tarfile.open(archive, mode="r:*") as source:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("archive", type=Path)
    extract_parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    if arguments.command == "extract":
        result = extract(arguments.archive, arguments.destination)
        print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
