#!/usr/bin/env python3
"""Generate documentation from the index without consuming unstaged source edits."""
from pathlib import Path
import os
import subprocess
import tempfile


def git(*args: str, data: bytes | None = None) -> bytes:
    return subprocess.check_output(["git", *args], input=data)


def main() -> None:
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    os.chdir(root)
    outputs = ("docs/reference/generated.md", "docs/INDEX.md")
    # checkout-index materializes precisely the proposed commit, including additions.
    with tempfile.TemporaryDirectory(prefix="cruxomni-staged-docs-") as temporary:
        snapshot = Path(temporary)
        git("checkout-index", "--all", f"--prefix={snapshot}{os.sep}")
        if not (snapshot / "scripts/generate-docs.ts").is_file():
            raise RuntimeError("The documentation generator must be staged before installing the hook")
        dependencies = root / "node_modules"
        if not dependencies.is_dir():
            raise RuntimeError("Install locked development dependencies before committing")
        (snapshot / "node_modules").symlink_to(dependencies, target_is_directory=True)
        subprocess.run(["bun", "run", "scripts/generate-docs.ts"], cwd=snapshot, check=True)
        updates: list[tuple[str, bytes, bool]] = []
        for name in outputs:
            destination = root / name
            try:
                original = git("show", f":{name}")
            except subprocess.CalledProcessError:
                original = None
            generated = (snapshot / name).read_bytes()
            unchanged_worktree = not destination.exists() or destination.read_bytes() == original
            if generated != original:
                updates.append((name, generated, unchanged_worktree))
        # Update only owned generated paths; preserve all partially staged sources.
        for name, generated, update_worktree in updates:
            oid = git("hash-object", "-w", "--stdin", data=generated).decode().strip()
            git("update-index", "--add", "--cacheinfo", f"100644,{oid},{name}")
            if update_worktree:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_bytes(generated)


if __name__ == "__main__":
    main()
