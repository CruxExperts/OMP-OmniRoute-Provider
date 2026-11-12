import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/prepare-upstream.py"
spec = importlib.util.spec_from_file_location("prepare_upstream", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class DerivedSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repair"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        (self.repo / "file.txt").write_bytes(b"base\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").decode().strip()
        (self.repo / "file.txt").write_bytes(b"repaired\n")
        (self.repo / "added.txt").write_bytes(b"added\n")
        self.git("add", ".")
        self.git("commit", "-qm", "repair")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.archive = self.root / "base.tar.gz"
        self.make_archive()
        self.digest = sha(self.archive.read_bytes())
        self.release = {"tag": "v1.2.3", "version": "1.2.3", "peeled_commit": self.base}
        self.record = {
            "schema_version": 1,
            "base": {"repository": "diegosouzapw/OmniRoute", "tag": "v1.2.3", "commit": self.base, "archive_sha256": self.digest},
            "repair_commit": self.commit,
            "signature_evidence": {"kind": "prior-independent-verification", "fingerprint": "A" * 40, "evidence": "synthetic; no signature claim"},
            "changes": [
                {"path": "file.txt", "input_sha256": sha(b"base\n"), "output_sha256": sha(b"repaired\n")},
                {"path": "added.txt", "input_sha256": None, "output_sha256": sha(b"added\n")},
            ],
        }
        self.record_path = self.root / "record.json"
        self.output = self.root / "derived"

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def make_archive(self, extra=None):
        with tarfile.open(self.archive, "w:gz") as bundle:
            for name, data in [("root/package.json", b'{"version":"1.2.3"}'), ("root/file.txt", b"base\n"), ("root/unchanged.txt", b"original\n")]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                bundle.addfile(info, io.BytesIO(data))
            if extra:
                bundle.addfile(extra)

    def derive(self):
        self.record_path.write_text(json.dumps(self.record))
        return module.derive(self.archive, self.release, self.digest, self.record_path, self.repo, self.output)

    def test_reproduces_archive_with_exact_repair(self):
        result = self.derive()
        self.assertEqual((self.output / "file.txt").read_bytes(), b"repaired\n")
        self.assertEqual((self.output / "added.txt").read_bytes(), b"added\n")
        self.assertEqual((self.output / "unchanged.txt").read_bytes(), b"original\n")
        self.assertEqual(result["repair_commit"], self.commit)
        self.assertIn("not reverified", result["signature"])
        with self.assertRaises(ValueError):
            self.derive()

    def test_rejects_dangling_output_symlink(self):
        target = self.root / "missing-target"
        self.output.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "output already exists"):
            self.derive()
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(self.output.readlink(), target)
        self.assertFalse(target.exists())

    def test_rejects_archive_and_record_tampering(self):
        for field in ("input_sha256", "output_sha256"):
            with self.subTest(field=field):
                original = self.record["changes"][0][field]
                self.record["changes"][0][field] = "0" * 64
                with self.assertRaises(ValueError):
                    self.derive()
                self.record["changes"][0][field] = original
        self.record["unexpected"] = True
        with self.assertRaises(ValueError):
            self.derive()
        del self.record["unexpected"]
        self.archive.write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            self.derive()
        self.assertFalse(self.output.exists())

    def test_rejects_unexpected_changes_and_unsafe_paths(self):
        self.record["changes"].pop()
        with self.assertRaisesRegex(ValueError, "changes differ"):
            self.derive()
        for name in ("../escape", "/absolute", "x//y", "x/../y", "x\\y"):
            with self.subTest(name=name):
                self.record["changes"][0]["path"] = name
                with self.assertRaises(ValueError):
                    self.derive()
        self.assertFalse(self.output.exists())

    def test_rejects_archive_links_and_escape(self):
        for name, kind in (("root/link", tarfile.SYMTYPE), ("../escape", tarfile.REGTYPE)):
            with self.subTest(name=name):
                info = tarfile.TarInfo(name)
                info.type = kind
                info.linkname = "../../outside"
                self.make_archive(info)
                self.digest = sha(self.archive.read_bytes())
                self.record["base"]["archive_sha256"] = self.digest
                with self.assertRaises((ValueError, tarfile.TarError)):
                    self.derive()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
