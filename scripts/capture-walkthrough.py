#!/usr/bin/env python3
"""Capture the real OMP terminal flow through an isolated PTY and tmux server."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT_PARENT = ROOT / "assets" / "native"
OUT_PATH = OUT_PARENT / "omp-18.12.5"
PRIVATE_PARENT = ROOT / ".agents" / "state" / "omp-provider-release" / "media"
OWNER = "Copyright © 2026 Crux Experts LLC"
WEBSITE = "https://www.cruxexperts.com/"
RIGHTS = (
    "Private asset. Property of Crux Experts LLC. Use, reproduction, modification, "
    "distribution, or publication without prior written permission is prohibited."
)
THIRD_PARTY = (
    "The terminal interface shown is Oh My Pi (OMP) 18.12.5, Copyright (c) 2025 "
    "Mario Zechner, Copyright (c) 2025-2026 Can Bölük, and Copyright (c) 2026 "
    "Stencil Labs, Inc.; it is licensed under the MIT License. The rendering font "
    "is CaskaydiaCove Nerd Font Mono, Copyright (c) 2019-Present Microsoft "
    "Corporation, under SIL Open Font License 1.1. Crux Experts LLC owns only "
    "this captured and rendered media artifact."
)
OMP_COMMIT = "d5cd750e41fede277f9eb933455da92a0738915e"
OMP_LICENSE_URL = f"https://github.com/can1357/oh-my-pi/blob/{OMP_COMMIT}/LICENSE"
FONT_LICENSE_URL = "https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0"
EXPECTED_OMP_SHA256 = "fdbc8136084c9a10439569157b2af62312e2b0d801cab54c73e89476da798e7e"
EXPECTED_BUN_VERSION = "1.4.2"
FRAME_INTERVAL_SECONDS = 0.20
MAX_CAPTURE_SECONDS = 240
PROCESS_TERM_GRACE_SECONDS = 2.0
PROCESS_KILL_WAIT_SECONDS = 2.0
PTY_COLUMNS = 160
PTY_ROWS = 50
CSI = re.compile(r"\x1b\[([0-?]*)([ -/]*)([@-~])")
OSC = re.compile(r"\x1b\].*?(?:\x07|\x1b\\)", re.DOTALL)
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]")
SECRET_TEXT = ("fixture-only-runtime-key", "fixture-only-admin-key", "fixture-only-metadata-key")

BASE_COLORS = [
    (18, 20, 27), (204, 73, 82), (154, 198, 120), (230, 193, 99),
    (106, 159, 181), (187, 133, 181), (126, 192, 171), (206, 216, 226),
    (65, 72, 84), (241, 93, 104), (176, 220, 137), (250, 210, 111),
    (122, 181, 203), (210, 151, 205), (146, 218, 194), (242, 245, 250),
]
DEFAULT_FG = (220, 230, 242)
DEFAULT_BG = (13, 17, 25)


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def source_manifest(root: Path = ROOT) -> dict[str, str]:
    """Hash package inputs before smoke; generated walkthrough output is excluded."""
    root = root.resolve(strict=True)
    package_path = root / "package.json"
    manifest = json.loads(package_path.read_text(encoding="utf-8"))
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries or not all(isinstance(entry, str) for entry in entries):
        raise RuntimeError("package.json files must be a non-empty list of package paths")

    excluded_output = PurePosixPath("assets/native/omp-18.12.5")
    paths: set[Path] = {package_path}

    def add_file(path: Path) -> None:
        relative_path = PurePosixPath(path.relative_to(root).as_posix())
        if relative_path == excluded_output or excluded_output in relative_path.parents:
            return
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(info.st_mode):
            raise RuntimeError(f"package source input is not a regular file: {relative_path}")
        paths.add(path)

    required_inputs = {"VERSION", "bun.lock"}
    for required in sorted(required_inputs):
        path = root / required
        if not path.exists() or path.is_symlink() or not path.is_file():
            raise RuntimeError(f"required package source input is missing or unsafe: {required}")
        add_file(path)

    for entry in entries:
        portable = PurePosixPath(entry)
        if portable.is_absolute() or ".." in portable.parts or "\\" in entry or not portable.parts:
            raise RuntimeError(f"package.json contains an unsafe package file path: {entry}")
        candidate = root.joinpath(*portable.parts)
        if not candidate.exists():
            raise RuntimeError(f"package source input is missing: {entry}")
        if candidate.is_symlink():
            raise RuntimeError(f"package source input is a symbolic link: {entry}")
        if candidate.is_file():
            add_file(candidate)
            continue
        if not candidate.is_dir():
            raise RuntimeError(f"package source input is not a regular file or directory: {entry}")
        for nested in sorted(candidate.rglob("*")):
            if nested.is_symlink():
                raise RuntimeError(f"package source input is a symbolic link: {nested.relative_to(root).as_posix()}")
            if nested.is_file():
                add_file(nested)
            elif not nested.is_dir():
                raise RuntimeError(f"package source input is a special filesystem entry: {nested.relative_to(root).as_posix()}")

    return {
        path.relative_to(root).as_posix(): digest_file(path)
        for path in sorted(paths, key=lambda item: item.relative_to(root).as_posix())
    }


def assert_source_unchanged(before: dict[str, str], root: Path = ROOT) -> None:
    after = source_manifest(root)
    if after != before:
        changed = sorted(set(before) | set(after))
        changed = [path for path in changed if before.get(path) != after.get(path)]
        sample = ", ".join(changed[:8])
        raise RuntimeError(f"package source inputs changed during capture: {sample}")


def verify_prior_outputs(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError(f"prior walkthrough output is not an ordinary directory: {path}")
    files: dict[str, Path] = {}
    for item in path.iterdir():
        if item.is_symlink() or not item.is_file():
            raise RuntimeError(f"prior walkthrough output contains a non-regular entry: {item.name}")
        if item.name != "SHA256SUMS":
            files[item.name] = item
    checksum_file = path / "SHA256SUMS"
    if checksum_file.is_symlink() or not checksum_file.is_file():
        raise RuntimeError("prior walkthrough output has no regular SHA256SUMS")
    recorded: dict[str, str] = {}
    for line in checksum_file.read_text(encoding="ascii").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9._-]+)", line)
        if not match or match.group(2) == "SHA256SUMS" or match.group(2) in recorded:
            raise RuntimeError("prior walkthrough checksum file is malformed")
        recorded[match.group(2)] = match.group(1)
    if set(recorded) != set(files):
        raise RuntimeError("prior walkthrough checksum file does not cover its exact regular-file set")
    for name, file_path in files.items():
        if digest_file(file_path) != recorded[name]:
            raise RuntimeError(f"prior walkthrough checksum mismatch: {name}")


def _process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_process_group(
    process: subprocess.Popen[Any],
    *,
    term_grace_seconds: float = PROCESS_TERM_GRACE_SECONDS,
    kill_wait_seconds: float = PROCESS_KILL_WAIT_SECONDS,
) -> None:
    """Boundedly stop an owned session group, even after its leader exited."""
    process_group = process.pid
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + term_grace_seconds
    while time.monotonic() < deadline and _process_group_exists(process_group):
        time.sleep(0.05)
    if _process_group_exists(process_group):
        try:
            os.killpg(process_group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + kill_wait_seconds
        while time.monotonic() < deadline and _process_group_exists(process_group):
            time.sleep(0.05)
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process_group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            raise RuntimeError("owned smoke process did not exit after process-group escalation")


def run_text(args: list[str], *, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(args, check=True, capture_output=True, text=True, env=env)
    return (completed.stdout + completed.stderr).strip()


def command_path(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(f"required local capture tool is unavailable: {name}")
    return str(Path(path).resolve())


def validate_inputs(bun: Path, omp: Path) -> dict[str, Any]:
    if sys.version_info < (3, 10):
        raise RuntimeError("capture requires Python 3.10 or newer")
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError("capture rendering requires Pillow 10.2.0") from error
    if Image.__version__ != "10.2.0":
        raise RuntimeError(f"capture requires the recorded Pillow 10.2.0 renderer; found {Image.__version__}")
    for path, label in ((bun, "Bun"), (omp, "OMP")):
        if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
            raise RuntimeError(f"{label} executable must be an absolute executable regular file")
    bun_version = run_text([str(bun), "--version"])
    if bun_version != EXPECTED_BUN_VERSION:
        raise RuntimeError(f"capture requires project-pinned Bun {EXPECTED_BUN_VERSION}, found {bun_version}")
    omp_digest = digest_file(omp)
    if omp_digest != EXPECTED_OMP_SHA256:
        raise RuntimeError(f"OMP binary digest does not match the pinned 18.12.5 asset: {omp_digest}")
    omp_version = run_text([str(omp), "--version"])
    if not re.search(r"\b18\.12\.5\b", omp_version):
        raise RuntimeError(f"OMP binary did not report 18.12.5: {omp_version}")
    tools = {
        "tmux": command_path("tmux"),
        "ffmpeg": command_path("ffmpeg"),
        "ffprobe": command_path("ffprobe"),
        "fc-match": command_path("fc-match"),
    }
    tmux_version = run_text([tools["tmux"], "-V"])
    ffmpeg_version = run_text([tools["ffmpeg"], "-version"]).splitlines()[0]
    ffmpeg_encoders = run_text([tools["ffmpeg"], "-hide_banner", "-encoders"])
    if not re.search(r"\bV\S*\s+mpeg4\s", ffmpeg_encoders):
        raise RuntimeError("the installed ffmpeg build lacks its native MPEG-4 video encoder")
    font_path = run_text([tools["fc-match"], "-f", "%{file}", "CaskaydiaCove Nerd Font Mono"])
    font = Path(font_path)
    if not font.is_file():
        raise RuntimeError("fontconfig did not resolve an installed CaskaydiaCove Nerd Font Mono file")
    font_license = font.parent / "LICENSE"
    if not font_license.is_file():
        raise RuntimeError("the selected CaskaydiaCove Nerd Font installation lacks its upstream LICENSE file")
    return {
        "bunVersion": bun_version,
        "ompVersion": "18.12.5",
        "ompBinarySha256": omp_digest,
        "ompVersionOutput": omp_version,
        "tools": tools,
        "tmuxVersion": tmux_version,
        "ffmpegVersion": ffmpeg_version,
        "pythonVersion": sys.version.split()[0],
        "pillowVersion": Image.__version__,
        "fontPath": str(font.resolve()),
        "fontSha256": digest_file(font),
        "fontLicensePath": str(font_license.resolve()),
        "fontLicenseSha256": digest_file(font_license),
    }


def scrub_terminal(text: str) -> str:
    result = OSC.sub("", text)
    for secret in SECRET_TEXT:
        result = result.replace(secret, "[redacted fixture credential]")
    result = re.sub(r"https?://127\.0\.0\.1:\d+", "http://127.0.0.1:[disposable fixture]", result)
    # Smoke output includes disposable profile paths and source paths. Replace
    # the most specific private root first, then the checkout root, before the
    # generic home/tmp rule so other absolute paths remain covered too.
    for private_path, label in (
        (PRIVATE_PARENT, "[private capture path]"),
        (ROOT, "[workspace]"),
    ):
        for spelling in {str(private_path), private_path.as_posix()}:
            result = result.replace(spelling, label)
    result = re.sub(r"/(?:home|tmp)/[^\s\x1b]+", "[private path]", result)
    result = re.sub(r"cruxomni-smoke-[A-Za-z0-9_-]+(?:/workspace)?", "[disposable workspace]", result)
    result = CONTROL.sub("", result)
    return result


def plain_text(ansi: str) -> str:
    value = OSC.sub("", ansi)
    value = CSI.sub("", value)
    value = value.replace("\x1b", "")
    value = value.replace("\r", "")
    value = CONTROL.sub("", value)
    return value


def color256(number: int) -> tuple[int, int, int]:
    if number < 16:
        return BASE_COLORS[number]
    if number >= 232:
        shade = 8 + (number - 232) * 10
        return shade, shade, shade
    value = number - 16
    levels = (0, 95, 135, 175, 215, 255)
    return levels[value // 36], levels[(value // 6) % 6], levels[value % 6]


def ansi_rows(ansi: str) -> list[list[tuple[str, tuple[int, int, int], tuple[int, int, int], bool]]]:
    ansi = OSC.sub("", ansi)
    rows: list[list[tuple[str, tuple[int, int, int], tuple[int, int, int], bool]]] = [[]]
    fg, bg, bold = DEFAULT_FG, DEFAULT_BG, False
    index = 0
    while index < len(ansi):
        if ansi[index] == "\x1b":
            match = CSI.match(ansi, index)
            if match:
                if match.group(3) == "m":
                    values = [int(item) if item else 0 for item in match.group(1).split(";")]
                    cursor = 0
                    while cursor < len(values):
                        code = values[cursor]
                        if code == 0:
                            fg, bg, bold = DEFAULT_FG, DEFAULT_BG, False
                        elif code == 1:
                            bold = True
                        elif code in (22,):
                            bold = False
                        elif code == 39:
                            fg = DEFAULT_FG
                        elif code == 49:
                            bg = DEFAULT_BG
                        elif 30 <= code <= 37:
                            fg = BASE_COLORS[code - 30]
                        elif 90 <= code <= 97:
                            fg = BASE_COLORS[code - 90 + 8]
                        elif 40 <= code <= 47:
                            bg = BASE_COLORS[code - 40]
                        elif 100 <= code <= 107:
                            bg = BASE_COLORS[code - 100 + 8]
                        elif code in (38, 48) and cursor + 2 < len(values):
                            mode, value = values[cursor + 1], values[cursor + 2]
                            chosen = fg if code == 38 else bg
                            if mode == 5:
                                chosen = color256(value)
                                cursor += 2
                            elif mode == 2 and cursor + 4 < len(values):
                                chosen = tuple(values[cursor + 2:cursor + 5])
                                cursor += 4
                            if code == 38:
                                fg = chosen
                            else:
                                bg = chosen
                        cursor += 1
                index = match.end()
                continue
            if index + 1 < len(ansi) and ansi[index + 1] == "]":
                osc_end = re.search(r"(?:\x07|\x1b\\)", ansi[index + 2:])
                index = len(ansi) if osc_end is None else index + 2 + osc_end.end()
                continue
            index += 1
            continue
        character = ansi[index]
        index += 1
        if character == "\r":
            continue
        if character == "\n":
            rows.append([])
            continue
        if ord(character) < 32 or ord(character) == 127:
            continue
        rows[-1].append((character, fg, bg, bold))
    return rows


def render_terminal(ansi: str, output: Path, font_path: Path, alt: str) -> tuple[int, int]:
    try:
        from PIL import Image, ImageDraw, ImageFont, PngImagePlugin
    except ImportError as error:
        raise RuntimeError("capture rendering requires Pillow 10.2.0") from error
    rows = ansi_rows(ansi)
    if not rows:
        raise RuntimeError("captured terminal image has no rows")
    font = ImageFont.truetype(str(font_path), 14)
    bold_font = ImageFont.truetype(str(font_path), 14)
    cell_width = max(1, round(font.getlength("M")))
    bbox = font.getbbox("Mg")
    cell_height = max(1, bbox[3] - bbox[1] + 4)
    rows = (rows[:PTY_ROWS] + [[] for _ in range(max(0, PTY_ROWS - len(rows)))])
    columns = PTY_COLUMNS
    width, height = columns * cell_width + 32, PTY_ROWS * cell_height + 32
    image = Image.new("RGB", (width, height), DEFAULT_BG)
    draw = ImageDraw.Draw(image)
    for row_index, row in enumerate(rows):
        y = 16 + row_index * cell_height
        for column_index, (character, fg, bg, bold) in enumerate(row[:columns]):
            x = 16 + column_index * cell_width
            draw.rectangle((x, y, x + cell_width, y + cell_height), fill=bg)
            draw.text((x, y - bbox[1] + 1), character, fill=fg, font=bold_font if bold else font)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Title", "CruxOmni native terminal capture — OMP 18.12.5")
    metadata.add_text("Description", alt)
    metadata.add_text("Copyright", OWNER)
    metadata.add_text("Website", WEBSITE)
    metadata.add_text("Rights", RIGHTS)
    metadata.add_text("ThirdPartyCredit", THIRD_PARTY)
    metadata.add_text("ThirdPartyLicense", f"OMP MIT: {OMP_LICENSE_URL}; CaskaydiaCove font SIL OFL 1.1: {FONT_LICENSE_URL}")
    metadata.add_text("Renderer", "Python Pillow ANSI-cell renderer fed by private tmux capture-pane -e frames from a Bun PTY")
    image.save(output, pnginfo=metadata, optimize=False)
    return width, height


class FrameRecorder(threading.Thread):
    def __init__(self, tmux: str, socket: Path, target: str, private_dir: Path, process: subprocess.Popen[str]):
        super().__init__(daemon=True)
        self.tmux = tmux
        self.socket = socket
        self.target = target
        self.private_dir = private_dir
        self.process = process
        self.stop_event = threading.Event()
        self.error: str | None = None
        self.frames_path = private_dir / "pty-frames.jsonl"
        self.started_at = time.monotonic()

    def run(self) -> None:
        previous_plain: str | None = None
        frame_count = 0
        try:
            with self.frames_path.open("x", encoding="utf-8") as record:
                while not self.stop_event.is_set() and self.process.poll() is None:
                    if frame_count >= MAX_CAPTURE_SECONDS / FRAME_INTERVAL_SECONDS:
                        raise RuntimeError("walkthrough exceeded the bounded PTY capture duration")
                    result = subprocess.run(
                        [self.tmux, "-f", "/dev/null", "-S", str(self.socket), "capture-pane", "-p", "-e", "-t", self.target],
                        capture_output=True,
                        env={"PATH": os.environ.get("PATH", ""), "TERM": "xterm-256color", "LANG": "C.UTF-8"},
                    )
                    if result.returncode != 0:
                        # The smoke closes the FIFO after its last PTY process, so
                        # tmux removes this one-shot reader pane as the run ends.
                        break
                    ansi = result.stdout.decode("utf-8", "replace")
                    plain = plain_text(ansi)
                    if plain and plain != previous_plain:
                        record.write(json.dumps({"elapsedSeconds": round(time.monotonic() - self.started_at, 3), "ansi": ansi}, ensure_ascii=False) + "\n")
                        record.flush()
                        previous_plain = plain
                        frame_count += 1
                    self.stop_event.wait(FRAME_INTERVAL_SECONDS)
        except Exception as error:  # preserve failure for the supervising process
            self.error = f"{type(error).__name__}: {error}"


def selected_frame(frames: list[dict[str, Any]], predicate: Any, label: str) -> dict[str, Any]:
    for frame in reversed(frames):
        scrubbed = scrub_terminal(frame["ansi"])
        if predicate(plain_text(scrubbed)):
            return {**frame, "safeAnsi": scrubbed, "label": label}
    raise RuntimeError(f"no genuine PTY frame matched the required {label} screen")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", required=True, type=Path, help="absolute private project-pinned Bun 1.4.2 executable")
    parser.add_argument("--omp-binary", required=True, type=Path, help="absolute checksum-verified OMP 18.12.5 release executable")
    args = parser.parse_args()
    bun, omp = args.bun.resolve(strict=True), args.omp_binary.resolve(strict=True)
    tool_evidence = validate_inputs(bun, omp)
    OUT_PARENT.mkdir(parents=True, exist_ok=True)
    private_root = PRIVATE_PARENT.resolve()
    private_root.mkdir(parents=True, exist_ok=True)
    os.chmod(private_root, 0o700)
    prior_backup: Path | None = None
    if OUT_PATH.exists():
        verify_prior_outputs(OUT_PATH)
        prior_backup = private_root / f"superseded-{OUT_PATH.name}-{int(time.time())}-{os.getpid()}"
        if prior_backup.exists():
            raise RuntimeError(f"private walkthrough recovery path already exists: {prior_backup}")
    private_dir = Path(tempfile.mkdtemp(prefix="capture-", dir=private_root))
    os.chmod(private_dir, 0o700)
    fifo = private_dir / "pty-output.fifo"
    os.mkfifo(fifo, 0o600)
    smoke_temp_root = private_dir / "smoke-roots"
    smoke_temp_root.mkdir(mode=0o700)
    socket = private_dir / "tmux.sock"
    target = "walkthrough:0.0"
    temp_output = Path(tempfile.mkdtemp(prefix="building-", dir=private_dir))
    os.chmod(temp_output, 0o700)
    started_utc = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    tmux = tool_evidence["tools"]["tmux"]
    tmux_env = {"PATH": os.environ.get("PATH", ""), "TERM": "xterm-256color", "LANG": "C.UTF-8"}
    server_started = False
    smoke: subprocess.Popen[str] | None = None
    recorder: FrameRecorder | None = None
    source_before: dict[str, str] | None = None
    published = False
    try:
        pane_command = "exec cat " + shlex.quote(str(fifo))
        subprocess.run(
            [tmux, "-f", "/dev/null", "-S", str(socket), "new-session", "-d", "-s", "walkthrough", "-x", "160", "-y", "50", pane_command],
            check=True,
            env=tmux_env,
            capture_output=True,
            text=True,
        )
        server_started = True
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current = subprocess.run(
                [tmux, "-f", "/dev/null", "-S", str(socket), "display-message", "-p", "-t", target, "#{pane_current_command}"],
                capture_output=True,
                text=True,
                env=tmux_env,
            )
            if current.returncode == 0 and current.stdout.strip() == "cat":
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("private tmux pane did not start its FIFO reader")

        smoke_env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(private_dir / "home"),
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "OMP_BINARY_PATH": str(omp),
            "OMP_SMOKE_CAPTURE_FIFO": str(fifo),
            "OMP_SMOKE_CAPTURE_ADMIN": "1",
            "OMP_SMOKE_HOST_MODE": "release-asset",
            "OMP_SMOKE_TRANSCRIPT_PATH": str(private_dir / "setup-transcript-raw.txt"),
            "OMP_SMOKE_TEMP_ROOT": str(smoke_temp_root),
        }
        Path(smoke_env["HOME"]).mkdir(mode=0o700)
        source_before = source_manifest()
        source_manifest_sha256 = hashlib.sha256(json.dumps(source_before, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        git_commit = run_text(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
        tracked_changes = bool(run_text(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"]))
        package_version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
        stdout_path, stderr_path = private_dir / "smoke.stdout.json", private_dir / "smoke.stderr.txt"
        deadline = time.monotonic() + MAX_CAPTURE_SECONDS
        timed_out = False
        with stdout_path.open("x", encoding="utf-8") as stdout_file, stderr_path.open("x", encoding="utf-8") as stderr_file:
            smoke = subprocess.Popen(
                [str(bun), "run", "scripts/smoke.ts"],
                cwd=ROOT,
                env=smoke_env,
                stdout=stdout_file,
                stderr=stderr_file,
                start_new_session=True,
                text=True,
            )
            recorder = FrameRecorder(tmux, socket, target, private_dir, smoke)
            recorder.start()
            while smoke.poll() is None:
                if recorder.error:
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                time.sleep(0.1)
            recorder.stop_event.set()
            recorder.join(timeout=10)
            if recorder.is_alive():
                raise RuntimeError("PTY frame recorder did not stop within its cleanup bound")
            # Stop orphaned descendants even when Bun has already exited.
            stop_process_group(smoke)
        stdout, stderr = stdout_path.read_text(encoding="utf-8"), stderr_path.read_text(encoding="utf-8")
        if timed_out:
            raise RuntimeError("native walkthrough smoke exceeded its four-minute bound")
        if recorder.error:
            raise RuntimeError(f"PTY frame recorder failed: {recorder.error}")
        if smoke.returncode != 0:
            safe_stderr = stderr.replace("fixture-only-runtime-key", "[redacted]").replace("fixture-only-admin-key", "[redacted]")
            raise RuntimeError(f"native OMP smoke failed with exit {smoke.returncode}: {safe_stderr[-4000:]}")
        try:
            smoke_result = json.loads(stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("native OMP smoke did not return its structured verification receipt") from error
        if not isinstance(smoke_result, dict) or smoke_result.get("status") != "verified":
            raise RuntimeError("native OMP smoke did not report a verified lifecycle result")
        installation = smoke_result.get("installation")
        if not isinstance(installation, dict):
            raise RuntimeError("native OMP smoke omitted its installed package receipt")
        package_archive_sha256 = installation.get("archiveSha256")
        if not isinstance(package_archive_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", package_archive_sha256):
            raise RuntimeError("native OMP smoke returned an invalid installed package archive digest")
        if installation.get("version") != package_version or installation.get("method") != "npm":
            raise RuntimeError("native OMP smoke installed package identity differs from the pre-capture package snapshot")
        assert_source_unchanged(source_before)

        frames = [json.loads(line) for line in recorder.frames_path.read_text(encoding="utf-8").splitlines()]
        wizard = selected_frame(
            frames,
            lambda value: "CruxOmni-OMP-Client" in value and "Setup" in value and "Connection" in value and "Administration (optional)" in value,
            "setup wizard",
        )
        fallback = selected_frame(
            frames,
            lambda value: "GET /api/fallback/chains [available]" in value and "Operation ID" in value,
            "fallback-chain administration browser",
        )
        capability = selected_frame(
            frames,
            lambda value: "GET /api/model-capability-overrides [available]" in value and "Operation ID" in value,
            "model-capability administration browser",
        )
        selected = [wizard, fallback, capability]
        screen_details: list[dict[str, Any]] = []
        for item in selected:
            safe_text = plain_text(item["safeAnsi"])
            if any(secret in safe_text for secret in SECRET_TEXT):
                raise RuntimeError("public transcript would contain fixture credentials")
            file_name = {
                "setup wizard": "setup-wizard.png",
                "fallback-chain administration browser": "admin-fallback-chains.png",
                "model-capability administration browser": "admin-model-capability-overrides.png",
            }[item["label"]]
            alt = {
                "setup wizard": "Oh My Pi terminal showing CruxOmni's setup wizard menu with Connection, Metadata, Catalogs, Administration, Pricing, Summary, and Finish choices. The walkthrough cancels before entering configuration.",
                "fallback-chain administration browser": "Oh My Pi terminal administration browser showing fallback-chain operations as available in this captured source snapshot, plus the operation prompt. The walkthrough cancels before sending a request; later release eligibility may differ.",
                "model-capability administration browser": "Oh My Pi terminal administration browser showing model-capability-override operations as available in this captured source snapshot, plus the operation prompt. The walkthrough cancels before sending a request; later release eligibility may differ.",
            }[item["label"]]
            size = render_terminal(item["safeAnsi"], temp_output / file_name, Path(tool_evidence["fontPath"]), alt)
            screen_details.append({
                "file": file_name,
                "alt": alt,
                "elapsedSeconds": item["elapsedSeconds"],
                "dimensions": {"width": size[0], "height": size[1]},
            })

        omp_license = """MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
        font_license = Path(tool_evidence["fontLicensePath"]).read_text(encoding="utf-8")
        third_party_notices = (
            "Third-party notices for captured UI and font rendering\n\n"
            f"Oh My Pi 18.12.5; source commit {OMP_COMMIT}; license: {OMP_LICENSE_URL}\n\n"
            f"{omp_license}\n\n"
            f"CaskaydiaCove Nerd Font Mono (Nerd Fonts v3.4.0); license source: {FONT_LICENSE_URL}; "
            f"installed license SHA-256: {tool_evidence['fontLicenseSha256']}\n\n"
            f"{font_license}\n"
        )
        (temp_output / "third-party-notices.txt").write_text(third_party_notices, encoding="utf-8")

        sampled: list[dict[str, Any]] = []
        for frame in selected:
            safe_ansi = frame["safeAnsi"]
            if any(secret in plain_text(safe_ansi) for secret in SECRET_TEXT):
                raise RuntimeError("walkthrough video frame contains a fixture credential")
            sampled.append(frame)
        video_dir = temp_output / "video-frames"
        video_dir.mkdir()
        frame_index = 0
        for frame in sampled:
            for _ in range(8):
                render_terminal(frame["safeAnsi"], video_dir / f"frame-{frame_index:05d}.png", Path(tool_evidence["fontPath"]), "Selected genuine terminal screen held for two seconds; public video has accessible text alternative.")
                frame_index += 1
        video_path = temp_output / "native-walkthrough.mp4"
        ffmpeg_cmd = [
            tool_evidence["tools"]["ffmpeg"], "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", "4", "-i", str(video_dir / "frame-%05d.png"),
            "-an", "-c:v", "mpeg4", "-q:v", "4", "-threads", "1", "-pix_fmt", "yuv420p", "-r", "4",
            "-movflags", "+faststart", "-metadata", "title=CruxOmni native setup and administration walkthrough",
            "-metadata", f"copyright={OWNER}", "-metadata", f"artist=Crux Experts LLC; {WEBSITE}",
            "-metadata", f"comment={RIGHTS} {THIRD_PARTY}", str(video_path),
        ]
        encoded = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
        if encoded.returncode != 0:
            raise RuntimeError(f"ffmpeg could not encode the captured PTY frames: {encoded.stderr[-2_000:]}")
        shutil.rmtree(video_dir)
        video_info = json.loads(run_text([tool_evidence["tools"]["ffprobe"], "-v", "error", "-show_entries", "format=duration:format_tags", "-of", "json", str(video_path)]))
        duration = float(video_info["format"]["duration"])
        if abs(duration - 6.0) > 0.01:
            raise RuntimeError(f"rendered walkthrough did not hold the three selected screens for two seconds each: {duration}")

        accessible = f"""# Native OMP setup and administration walkthrough

This walkthrough was captured from a real Oh My Pi (OMP) 18.12.5 process running the built CruxOmni plugin in an isolated native Linux x64 terminal. The terminal UI was mirrored from its Bun PTY into a private tmux 3.4 server, then rendered from captured terminal cells. It was not drawn from the fixture illustrations and it was not captured from a desktop.

The setup screenshot shows the actual setup menu: Connection, Metadata (optional), Catalogs (optional), Administration (optional), Pricing (optional), Summary, and Finish. The setup flow was cancelled before any credentials or configuration were entered.

The administration screenshots show the actual `/cruxomni-admin` browser after enabling administration in a disposable private profile. The six selected descriptors from two families appeared as available in the captured source snapshot: three fallback-chain operations and three model-capability-override operations. They are representative screens, not a complete operation inventory. Current release eligibility may differ; see [the captured provenance](provenance.json) and [the current eligibility inventory](../../../contracts/release-eligibility.json). Each screen was cancelled at the operation prompt. No administration operation was dispatched, and the local fixture server was not treated as a live OmniRoute server or as an oracle for management behavior.

## Screenshots

![Setup wizard menu: Connection, optional metadata and catalogs, optional administration and pricing, Summary, and Finish. The capture cancels before configuration.](setup-wizard.png)

![Native administration browser showing the available fallback-chain operations and the operation prompt. The request is cancelled before dispatch.](admin-fallback-chains.png)

![Native administration browser showing the available model-capability-override operations and the operation prompt. The request is cancelled before dispatch.](admin-model-capability-overrides.png)

## Video and text alternative

The short video has no audio. It holds three selected genuine screens for two seconds each, in this order: setup wizard, fallback-chain browser, model-capability browser. The descriptions above and this transcript provide a static text alternative.

The native UI confirms the setup menu, then displays the fallback-chain operation list and the model-capability-override operation list. Each shown descriptor was marked `[available]` in this captured source snapshot; later eligibility may differ. The human-facing operation prompt appears next; the walkthrough sends Escape and makes no request. This is evidence of what the client UI rendered in the private, disposable fixture run. It does not establish a live server response or production account result.

{OWNER}. {WEBSITE}

{RIGHTS}

{THIRD_PARTY}
"""
        (temp_output / "walkthrough.md").write_text(accessible, encoding="utf-8")
        transcript = "\n\n".join(
            f"### {item['label']}\n\n{plain_text(item['safeAnsi']).rstrip()}" for item in selected
        )
        transcript += f"\n\n{OWNER}. {WEBSITE}\n\n{RIGHTS}\n\n{THIRD_PARTY}\n"
        (temp_output / "terminal-transcript.txt").write_text(transcript, encoding="utf-8")

        provenance = {
            "schemaVersion": 1,
            "capturedAtUtc": started_utc,
            "source": {
                "gitCommit": git_commit,
                "trackedWorktreeChangesPresent": tracked_changes,
                "snapshotPhase": "immediately-before-native-smoke",
                "verifiedUnchangedThroughCapture": True,
                "packageInputManifestSha256": source_manifest_sha256,
                "fileSha256": source_before,
                "installedPackage": {
                    "name": json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["name"],
                    "version": package_version,
                    "method": installation["method"],
                    "archiveSha256": package_archive_sha256,
                },
            },
            "runtime": {
                "ompVersion": "18.12.5",
                "ompBinarySha256": tool_evidence["ompBinarySha256"],
                "ompUpstream": {
                    "repository": "https://github.com/can1357/oh-my-pi",
                    "commit": OMP_COMMIT,
                    "license": "MIT",
                    "licenseUrl": OMP_LICENSE_URL,
                },
                "bunVersion": tool_evidence["bunVersion"],
                "host": {"os": sys.platform, "architecture": os.uname().machine if hasattr(os, "uname") else "unknown", "libc": "glibc"},
                "captureMethod": "private Bun.Terminal PTY output mirrored through a named FIFO to a tmux 3.4 PTY; tmux capture-pane -e; no desktop or user tmux server was accessed",
                "fixtureBoundary": "local loopback fixture used by the existing smoke workflow; no admin request was dispatched and no live-server behavior was asserted",
            },
            "renderer": {
                "pythonVersion": tool_evidence["pythonVersion"],
                "pillowVersion": tool_evidence["pillowVersion"],
                "tmuxVersion": tool_evidence["tmuxVersion"],
                "ffmpegVersion": tool_evidence["ffmpegVersion"],
                "fontFile": Path(tool_evidence["fontPath"]).name,
                "fontFamily": "CaskaydiaCove Nerd Font Mono",
                "fontSha256": tool_evidence["fontSha256"],
                "fontLicenseSha256": tool_evidence["fontLicenseSha256"],
                "fontLicenseUrl": FONT_LICENSE_URL,
                "ompLicenseUrl": OMP_LICENSE_URL,
                "videoFramesPerSecond": 4,
                "videoCodec": "MPEG-4 Part 2 (native ffmpeg mpeg4 encoder)",
                "videoDurationSeconds": duration,
                "videoScreenOrder": [item["label"] for item in sampled],
                "videoFramesPerScreen": 8,
                "videoHoldSecondsPerScreen": 2,
            },
            "ownership": {"copyright": OWNER, "website": WEBSITE, "rights": RIGHTS, "thirdPartyCredit": THIRD_PARTY},
            "screenshots": screen_details,
            "files": {},
        }
        for path in sorted(item for item in temp_output.iterdir() if item.is_file()):
            provenance["files"][path.name] = {"sha256": digest_file(path), "bytes": path.stat().st_size}
        (temp_output / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        checksum_entries = []
        for path in sorted(item for item in temp_output.iterdir() if item.is_file()):
            checksum_entries.append(f"{digest_file(path)}  {path.name}")
        (temp_output / "SHA256SUMS").write_text("\n".join(checksum_entries) + "\n", encoding="ascii")
        if any(path.is_symlink() for path in temp_output.rglob("*")):
            raise RuntimeError("generated walkthrough output contains a symbolic link")
        assert_source_unchanged(source_before)
        os.chmod(temp_output, 0o755)
        if prior_backup is not None:
            # Leave the existing package inputs in place during smoke, then make
            # a private rollback copy only at the final output replacement step.
            verify_prior_outputs(OUT_PATH)
            os.replace(OUT_PATH, prior_backup)
        try:
            os.replace(temp_output, OUT_PATH)
        except BaseException:
            if prior_backup is not None and prior_backup.exists() and not OUT_PATH.exists():
                os.replace(prior_backup, OUT_PATH)
            raise
        published = True
        print(f"Native walkthrough created: {OUT_PATH}")
        print(f"Private raw PTY capture retained: {private_dir}")
        if prior_backup is not None:
            print(f"Prior version retained privately: {prior_backup}")
        print(f"OMP 18.12.5 binary SHA-256: {tool_evidence['ompBinarySha256']}")
        print(f"Video duration: {duration:.1f} seconds; frames: {len(sampled)}")
        return 0
    finally:
        try:
            if recorder is not None:
                recorder.stop_event.set()
                if recorder.is_alive():
                    recorder.join(timeout=10)
            if smoke is not None:
                stop_process_group(smoke)
            if server_started:
                subprocess.run([tmux, "-f", "/dev/null", "-S", str(socket), "kill-server"], capture_output=True, env=tmux_env)
            if smoke_temp_root.exists():
                shutil.rmtree(smoke_temp_root)
        finally:
            if temp_output.exists():
                shutil.rmtree(temp_output)
            if prior_backup is not None and not published and not OUT_PATH.exists() and prior_backup.exists():
                os.replace(prior_backup, OUT_PATH)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"capture failed: {error}", file=sys.stderr)
        raise SystemExit(1)
