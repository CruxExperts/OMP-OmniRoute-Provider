#!/usr/bin/env python3
"""Build and observe two research-only OMP hosts on a disposable Windows runner."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

COMMIT = "d5cd750e41fede277f9eb933455da92a0738915e"
SOURCE_SHA = "db286adf6c8cce6fdf7037c40ffef97429e75753b9644bd1aeefda4772f51bf1"
PATCH_SHA = "ff725e605e067e7a90449f98d0e15565554228440bc80263b24c02aa8e6d34ae"
NATIVE_ARCHIVE_SHA = "ad0813556575d77b80cb765b8a9d5bd55aa4068274c4496fc59bdc3e9cc4f9ce"
NATIVE_SRI = "vnaPvnIxojxUmewfX5X57OUnWgd5bjR76j38nw+KogUayrapI/edbGr7XFx/6AQsrCfZLZJ0f/19G3JZ6Hh2GQ=="
NATIVE_SHA = "c511ffab8a070be6263d28f0bc5985fc160c7ad70f0ceb1b56ef97ff4d396da7"
BUN_ARCHIVE_SHA = "3a4f6d0453afcc1ed1f736e3a4356306ff359efe75fa11c9a0d82c59f76d4801"
BUN_SRI = "lq82LqVjSXAx9gNUcibCdfQdtrelh86FxQqlhpOdiV4SZQAP8HHUxWhnfbjx2fqz+jzglwBvjmlEs7xFyONBZw=="
BUN_TEMPLATE_SHA = "15277c59ccd6c6c20f8dc9716c2b59c1776320d606b6a8658f70be8799519ca4"
PROVIDER_SHA = "487c6214d4f7048f4399755ac06768ba8770113fa3abd03c041c0cb674fcb837"
PROVIDER_PATCH_SHA = "f0e4af389e54933ea76e619da16c6a70446f3ad298a17ac782b97e8fd5e8382b"
OVERLAY_FILES = {
    "src/index.ts": PROVIDER_SHA,
    "src/config.ts": "a7655f0f85e7d7b5241c307a0fbe7800ac40dca0ba6d0a2752bdb7670f190564",
    "src/private-path.ts": "2276066f365400488e3ff64256ef2084d470107805886b8f093a82deb250e2d9",
}
ROOT = Path(__file__).resolve().parent.parent


def digest(path: Path, algorithm: str = "sha256") -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def download(url: str, path: Path, expected: str, sri: str | None = None) -> None:
    with urllib.request.urlopen(url, timeout=120) as response, path.open("xb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 512 * 1024 * 1024:
                raise ValueError("download exceeds bound")
            output.write(chunk)
    if digest(path) != expected:
        raise ValueError("download SHA-256 mismatch")
    if sri and base64.b64encode(bytes.fromhex(digest(path, "sha512"))).decode() != sri:
        raise ValueError("download integrity mismatch")


def extract_source(archive: Path, destination: Path) -> Path:
    prefix = f"oh-my-pi-{COMMIT}"
    seen: set[str] = set()
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) > 100_000 or sum(m.size for m in members) > 2 * 1024**3:
            raise ValueError("source extraction bound exceeded")
        for member in members:
            path = PurePosixPath(member.name)
            if (not member.name or path.is_absolute() or "\\" in member.name
                    or any(part in (".", "..") for part in member.name.split("/"))
                    or not path.parts or path.parts[0] != prefix
                    or not (member.isfile() or member.isdir())):
                raise ValueError("unsafe source member")
            key = member.name.rstrip("/").casefold()
            if key in seen:
                raise ValueError("duplicate source member")
            seen.add(key)
        bundle.extractall(destination, members=members, filter="data")
    return destination / prefix


def extract_member(archive: Path, name: str, destination: Path, expected: str) -> None:
    with tarfile.open(archive, "r:gz") as bundle:
        matches = [member for member in bundle.getmembers() if member.name == name]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 512 * 1024 * 1024:
            raise ValueError("invalid package member")
        source = bundle.extractfile(matches[0])
        if source is None:
            raise ValueError("missing package member")
        with source, destination.open("xb") as output:
            shutil.copyfileobj(source, output)
    if digest(destination) != expected:
        raise ValueError("package member digest mismatch")
def input_tree_sha256(root: Path) -> str:
    """Bind installed and source bytes while excluding only build outputs."""
    tree = hashlib.sha256()
    for current, directories, files in os.walk(root, followlinks=False):
        base = Path(current)
        relative = base.relative_to(root).as_posix()
        if relative == "packages/coding-agent":
            directories[:] = [item for item in directories if item != "binaries"]
        # The pinned stats build.ts recreates dist/client as a compiler output.
        if relative == "packages/stats/dist":
            directories[:] = [item for item in directories if item != "client"]
        for name in sorted(directories + files):
            path = base / name
            key = path.relative_to(root).as_posix()
            if path.is_symlink():
                tree.update(f"link\0{key}\0{os.readlink(path)}\0".encode())
            elif path.is_file():
                tree.update(f"file\0{key}\0{digest(path)}\0".encode())
        directories.sort()
    return tree.hexdigest()




class CommandFailure(Exception):
    def __init__(self, returncode: int | None, timed_out: bool = False) -> None:
        super().__init__("research command failed")
        self.returncode = returncode
        self.timed_out = timed_out


def command(args: list[str], cwd: Path, environment: dict[str, str]) -> None:
    # Build output can contain paths or other untrusted data; do not publish it.
    try:
        result = subprocess.run(args, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1100, check=False)
    except subprocess.TimeoutExpired as error:
        raise CommandFailure(None, timed_out=True) from error
    if result.returncode:
        raise CommandFailure(result.returncode)


def main() -> None:
    if sys.platform != "win32" or os.environ.get("PROCESSOR_ARCHITECTURE") != "AMD64":
        raise RuntimeError("native Windows x64 runner required")
    output = Path(os.environ["RUNNER_TEMP"]) / "windows-login-research-observations"
    output.mkdir(exist_ok=False)
    metadata = {"researchOnly": True, "officialQualification": False, "sourceCommit": COMMIT,
                "sourceArchiveSha256": SOURCE_SHA, "patchSha256": PATCH_SHA,
                "nativeArchiveSha256": NATIVE_ARCHIVE_SHA, "nativeSha256": NATIVE_SHA,
                "compilerVersion": "1.4.2", "compilerOriginalProvenanceKnown": False,
                "compilerTemplateSha256": BUN_TEMPLATE_SHA, "status": "started"}
    metadata.update({"overlayOriginalSha256": OVERLAY_FILES, "providerOverlaySha256": PROVIDER_PATCH_SHA})
    stage = "initialization"
    try:
        bun = shutil.which("bun")
        release = Path(os.environ["RUNNER_TEMP"]) / "windows-research-release"
        manifest = json.loads((release / "release-manifest.json").read_text(encoding="utf-8"))
        if manifest.get("sourceRevision") != os.environ.get("GITHUB_SHA"):
            raise ValueError("export source revision mismatch")
        packages = [item for item in manifest["artifacts"] if item["name"].startswith("cruxexperts-cruxomni-omp-client-") and item["name"].endswith(".tgz")]
        if len(packages) != 1 or Path(packages[0]["name"]).name != packages[0]["name"]:
            raise ValueError("invalid exported package")
        package = release / packages[0]["name"]
        package_sha = digest(package)
        if package_sha != packages[0]["sha256"]:
            raise ValueError("export package digest mismatch")
        metadata["checkoutSourceRevision"] = manifest["sourceRevision"]
        metadata["packageArchiveSha256"] = package_sha
        git = shutil.which("git")
        if not bun or not git:
            raise RuntimeError("required runner tools unavailable")
        # Do not pass the Actions token, caller credentials, or model settings to package code.
        allowed = ("PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA")
        environment = {key: os.environ[key] for key in allowed if key in os.environ}
        environment.update({"CI": "true", "npm_config_ignore_scripts": "true", "GH_PROMPT_DISABLED": "1"})
        environment["RUNNER_TEMP"] = os.environ["RUNNER_TEMP"]
        environment.update({"OMP_SMOKE_PACKAGE_ARCHIVE": str(package), "OMP_SMOKE_PACKAGE_SHA256": package_sha})
        patch = ROOT / "scripts/windows-research-input-instrumentation.patch"
        if digest(patch) != PATCH_SHA:
            raise ValueError("instrumentation patch digest mismatch")
        if (digest(ROOT / "scripts/windows-research-provider-overlay.patch") != PROVIDER_PATCH_SHA
                or any(digest(ROOT / file) != expected for file, expected in OVERLAY_FILES.items())):
            raise ValueError("provider overlay input mismatch")
        with tempfile.TemporaryDirectory(prefix="omp-windows-research-", dir=os.environ["RUNNER_TEMP"]) as tmp:
            work = Path(tmp)
            home = work / "home"
            home.mkdir()
            environment.update({"USERPROFILE": str(home), "APPDATA": str(home), "LOCALAPPDATA": str(home), "TEMP": str(work), "TMP": str(work)})
            stage = "source-acquisition"
            source_archive = work / "source.tar.gz"
            download(f"https://codeload.github.com/can1357/oh-my-pi/tar.gz/{COMMIT}", source_archive, SOURCE_SHA)
            source = extract_source(source_archive, work)
            stage = "native-acquisition"
            native_archive = work / "native.tgz"
            download("https://registry.npmjs.org/@oh-my-pi/pi-natives-win32-x64/-/pi-natives-win32-x64-18.12.5.tgz", native_archive, NATIVE_ARCHIVE_SHA, NATIVE_SRI)
            native = source / "packages/natives/native/pi_natives.win32-x64-baseline.node"
            extract_member(native_archive, "package/pi_natives.win32-x64-baseline.node", native, NATIVE_SHA)
            stage = "compiler-template-acquisition"
            compiler_archive = work / "bun.tgz"
            download("https://registry.npmjs.org/@oven/bun-windows-x64-baseline/-/bun-windows-x64-baseline-1.4.2.tgz", compiler_archive, BUN_ARCHIVE_SHA, BUN_SRI)
            template = source / "bun-windows-x64-baseline-v1.4.2"
            extract_member(compiler_archive, "package/bin/bun.exe", template, BUN_TEMPLATE_SHA)
            lock = source / "bun.lock"
            lock_sha = digest(lock)
            metadata["upstreamLockSha256"] = lock_sha
            stage = "filtered-install"
            command([bun, "install", "--filter", "@oh-my-pi/pi-coding-agent...", "--filter", "@oh-my-pi/omp-stats...", "--filter", "@oh-my-pi/collab-web...", "--filter", "!./", "--frozen-lockfile", "--ignore-scripts"], source, environment)
            if digest(lock) != lock_sha:
                raise ValueError("upstream lock changed")
            stage = "generated-input"
            command([bun, "--cwd=packages/collab-web", "run", "gen:tool-views"], source, environment)
            binaries: dict[str, Path] = {}
            for variant in ("baseline", "instrumented"):
                stage = f"{variant}-build"
                if variant == "instrumented":
                    command([git, "apply", "--whitespace=nowarn", str(patch)], source, environment)
                if digest(native) != NATIVE_SHA or digest(template) != BUN_TEMPLATE_SHA or digest(lock) != lock_sha:
                    raise ValueError("build input changed")
                inputs = input_tree_sha256(source)
                metadata[f"{variant}InputTreeSha256"] = inputs
                command([bun, "scripts/ci-release-build-binaries.ts", "--targets", "win32-x64"], source, environment)
                if digest(native) != NATIVE_SHA or digest(template) != BUN_TEMPLATE_SHA or digest(lock) != lock_sha:
                    raise ValueError("build input changed")
                if input_tree_sha256(source) != inputs:
                    metadata["buildInputChanged"] = True
                    raise ValueError("build modified its source or installed inputs")
                binary = source / "packages/coding-agent/binaries/omp-windows-x64.exe"
                binaries[variant] = work / f"{variant}.exe"
                shutil.copyfile(binary, binaries[variant])
                metadata[f"{variant}BinarySha256"] = digest(binaries[variant])
            stage = "baseline-observation"
            command([bun, "scripts/windows-login-research.ts", "baseline", str(binaries["baseline"]), str(metadata["baselineBinarySha256"]), str(output / "baseline.json")], ROOT, environment)
            observation = json.loads((output / "baseline.json").read_text(encoding="utf-8"))
            setup = observation.get("observations", {}).get("setup", {})
            effects = setup.get("setupEffects", [])
            setup_reproduced = (
                setup.get("completed") is False and setup.get("timedOut") is True
                and setup.get("dialogueCompleted") == 7
                and effects == [
                    {"route": "key-verification", "finished": True, "closed": True, "status": 200},
                    {"route": "models", "finished": True, "closed": True, "status": 200},
                ]
            )
            if (observation.get("researchOnly") is not True
                    or not (observation.get("reproducedSubmissionFailure") is True or setup_reproduced)
                    or observation.get("packageArchiveSha256") != package_sha
                    or observation.get("binarySha256") != metadata["baselineBinarySha256"]):
                raise RuntimeError("unmodified baseline did not reproduce submission or setup failure with the exact inputs")
            metadata["baselineFailure"] = "setup-after-validation" if setup_reproduced else "submission"
            stage = "instrumented-observation"
            command([bun, "scripts/windows-login-research.ts", "instrumented", str(binaries["instrumented"]), str(metadata["instrumentedBinarySha256"]), str(output / "instrumented.json")], ROOT, environment)
            instrumented = json.loads((output / "instrumented.json").read_text(encoding="utf-8"))
            if (instrumented.get("researchOnly") is not True or instrumented.get("packageArchiveSha256") != package_sha
                    or instrumented.get("binarySha256") != metadata["instrumentedBinarySha256"]):
                raise RuntimeError("instrumented observation input mismatch")
            overlay = instrumented.get("providerOverlay", {})
            overlay_files = overlay.get("files")
            if (overlay.get("researchOnly") is not True or overlay.get("archiveStillVerifiedAfterOverlay") is not False
                    or overlay.get("patchSha256") != PROVIDER_PATCH_SHA or not isinstance(overlay_files, list)
                    or len(overlay_files) != len(OVERLAY_FILES)):
                raise RuntimeError("installed provider overlay binding mismatch")
            observed = {}
            for item in overlay_files:
                if not isinstance(item, dict) or item.get("file") not in OVERLAY_FILES or item["file"] in observed:
                    raise RuntimeError("installed provider overlay file mismatch")
                result = item.get("resultingSha256")
                if (item.get("originalSha256") != OVERLAY_FILES[item["file"]] or not isinstance(result, str)
                        or not re.fullmatch(r"[a-f0-9]{64}", result) or result == item["originalSha256"]):
                    raise RuntimeError("installed provider overlay digest mismatch")
                observed[item["file"]] = result
            metadata["overlayResultingSha256"] = observed
            metadata["status"] = "observed"
    except Exception as error:
        metadata["status"] = "failed"
        metadata["failedStage"] = stage
        metadata["failureType"] = type(error).__name__
        if isinstance(error, CommandFailure):
            metadata["commandFailure"] = {
                "returnCode": error.returncode,
                "signal": -error.returncode if os.name != "nt" and error.returncode is not None and error.returncode < 0 else None,
                "timedOut": error.timed_out,
            }
        raise
    finally:
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Windows research stopped: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
