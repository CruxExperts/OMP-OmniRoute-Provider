#!/usr/bin/env python3
"""Focused regression checks for capture source binding and process cleanup."""

from __future__ import annotations

import json
import os
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


CAPTURE = Path(__file__).parents[1] / "scripts" / "capture-walkthrough.py"
CAPTURE_API = runpy.run_path(str(CAPTURE))


class CaptureWalkthroughSafetyTests(unittest.TestCase):
    def test_capture_module_import_does_not_require_pillow(self) -> None:
        script = """
import builtins, runpy, sys
original_import = builtins.__import__
def reject_pillow(name, *args, **kwargs):
    if name == 'PIL' or name.startswith('PIL.'):
        raise AssertionError('Pillow was imported during module load')
    return original_import(name, *args, **kwargs)
builtins.__import__ = reject_pillow
runpy.run_path(sys.argv[1])
"""
        subprocess.run(
            [sys.executable, "-c", script, str(CAPTURE)],
            check=True,
            timeout=10,
            capture_output=True,
            text=True,
        )

    def test_scrub_terminal_redacts_checkout_and_private_state_paths(self) -> None:
        workspace = Path(CAPTURE_API["ROOT"])
        private_root = Path(CAPTURE_API["PRIVATE_PARENT"])
        source_path = workspace / "src" / "index.ts"
        capture_path = private_root / "capture-fixture" / "smoke-roots" / "profile"
        self.assertTrue(source_path.is_absolute())
        self.assertTrue(capture_path.is_absolute())
        self.assertIn("/.agents/state/", capture_path.as_posix())

        scrubbed = CAPTURE_API["scrub_terminal"](
            f"source={source_path}\nprofile={capture_path}"
        )

        self.assertNotIn(str(workspace), scrubbed)
        self.assertNotIn(str(private_root), scrubbed)
        self.assertNotIn("/.agents/state/", scrubbed)
        self.assertIn("[workspace]/src/index.ts", scrubbed)
        self.assertIn("[private capture path]/capture-fixture/smoke-roots/profile", scrubbed)

    def test_source_snapshot_rejects_changes_and_ignores_generated_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "src").mkdir()
            (root / "assets/native/omp-18.12.5").mkdir(parents=True)
            (root / "src/index.ts").write_text("export const value = 1;\n", encoding="utf-8")
            (root / "assets/native/omp-18.12.5/generated.png").write_bytes(b"generated output")
            (root / "VERSION").write_text("1.2.3\n", encoding="utf-8")
            (root / "bun.lock").write_text("lock\n", encoding="utf-8")
            (root / "package.json").write_text(
                json.dumps({"files": ["src", "assets"]}), encoding="utf-8"
            )

            snapshot = CAPTURE_API["source_manifest"](root)
            CAPTURE_API["assert_source_unchanged"](snapshot, root)
            (root / "assets/native/omp-18.12.5/generated.png").write_bytes(b"new generated output")
            CAPTURE_API["assert_source_unchanged"](snapshot, root)

            (root / "src/index.ts").write_text("export const value = 2;\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "changed during capture: src/index.ts"):
                CAPTURE_API["assert_source_unchanged"](snapshot, root)

    @unittest.skipUnless(sys.platform.startswith("linux"), "process-group regression uses Linux /proc")
    def test_cleanup_kills_descendant_after_group_leader_exits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "child.pid"
            child_code = (
                "import os,signal,time; "
                "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                f"open({str(marker)!r}, 'w').write(str(os.getpid())); "
                "time.sleep(30)"
            )
            leader_code = "import subprocess,sys; subprocess.Popen([sys.executable, '-c', sys.argv[1]])"
            leader = subprocess.Popen([sys.executable, "-c", leader_code, child_code], start_new_session=True)
            leader.wait(timeout=5)
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists(), "descendant failed to start")
            child_pid = int(marker.read_text(encoding="ascii"))

            try:
                CAPTURE_API["stop_process_group"](
                    leader,
                    term_grace_seconds=0.1,
                    kill_wait_seconds=0.5,
                )
                deadline = time.monotonic() + 2
                child_stopped = False
                while time.monotonic() < deadline:
                    try:
                        state = Path(f"/proc/{child_pid}/stat").read_text(encoding="ascii").split()[2]
                    except FileNotFoundError:
                        child_stopped = True
                        break
                    if state == "Z":
                        child_stopped = True
                        break
                    time.sleep(0.02)
                self.assertTrue(child_stopped, "smoke descendant survived owned process-group cleanup")
            finally:
                try:
                    os.killpg(leader.pid, 9)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
