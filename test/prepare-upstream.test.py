import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

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


class PortableSourceTests(DerivedSourceTests):
    def setUp(self):
        super().setUp()
        self.home = self.root / "gpg"
        self.home.mkdir(mode=0o700)
        self.gpg("--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Fixture <fixture@example.invalid>", "ed25519", "sign", "0")
        listing = self.gpg("--with-colons", "--list-keys").decode()
        self.fingerprint = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
        self.old_fingerprint = module.SIGNING_FINGERPRINT
        module.SIGNING_FINGERPRINT = self.fingerprint
        self.addCleanup(setattr, module, "SIGNING_FINGERPRINT", self.old_fingerprint)
        self.key_root = self.root / "checkout"
        key = self.key_root / ".github/crux-experts-release-signing-key.asc"
        key.parent.mkdir(parents=True)
        key.write_bytes(self.gpg("--armor", "--export", self.fingerprint))
        self.capsule = self.root / "capsule"
        self.capsule.mkdir()
        self.record_path = self.capsule / "manifest.json"
        self.payload = self.capsule / "files"
        self.payload.mkdir()
        (self.payload / "file.txt").write_bytes(b"repaired\n")
        (self.payload / "added.txt").write_bytes(b"added\n")
        self.official = self.root / "official"
        self.official.mkdir()
        (self.official / "file.txt").write_bytes(b"base\n")

    def gpg(self, *args):
        return subprocess.run(["gpg", "--batch", "--yes", "--homedir", str(self.home), *args],
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def sign(self, raw=None):
        self.record_path.write_bytes(raw if raw is not None else json.dumps(self.record).encode())
        self.gpg("--armor", "--detach-sign", "--output", str(self.record_path) + ".asc", str(self.record_path))

    def portable(self):
        identity = {"record": "fixture/manifest.json", "sha256": sha(self.record_path.read_bytes())}
        return module.derive_portable(self.archive, self.release, self.digest, self.record_path,
                                      self.output, identity, self.key_root)

    def test_signed_capsule_and_tampered_reuse(self):
        self.sign()
        receipt = self.portable()
        self.assertEqual((self.output / "file.txt").read_bytes(), b"repaired\n")
        self.assertEqual(self.portable(), receipt)
        (self.output / "extra").write_bytes(b"unexpected")
        with self.assertRaises(ValueError):
            self.portable()
        self.assertEqual((self.official / "file.txt").read_bytes(), b"base\n")

    def test_invalid_manifest_and_signature(self):
        for mutation in ("base", "duplicate_path", "traversal", "duplicate_key", "signer"):
            with self.subTest(mutation=mutation):
                original = json.loads(json.dumps(self.record))
                if mutation == "base":
                    self.record["base"]["commit"] = "0" * 40
                elif mutation == "duplicate_path":
                    self.record["changes"].append(self.record["changes"][0])
                elif mutation == "traversal":
                    self.record["changes"][0]["path"] = "../escape"
                if mutation == "duplicate_key":
                    self.sign(b'{"schema_version":1,"schema_version":1}')
                else:
                    self.sign()
                if mutation == "signer":
                    module.SIGNING_FINGERPRINT = "0" * 40
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    self.portable()
                module.SIGNING_FINGERPRINT = self.fingerprint
                self.record = original
        self.assertEqual((self.official / "file.txt").read_bytes(), b"base\n")

    def test_invalid_payloads(self):
        self.sign()
        target = self.payload / "file.txt"
        for mutation in ("altered", "missing", "extra", "symlink", "executable", "fifo"):
            with self.subTest(mutation=mutation):
                if target.exists() or target.is_symlink():
                    target.unlink()
                extra = self.payload / "extra"
                extra.unlink(missing_ok=True)
                if mutation == "altered":
                    target.write_bytes(b"wrong")
                elif mutation == "extra":
                    target.write_bytes(b"repaired\n")
                    extra.write_bytes(b"extra")
                elif mutation == "symlink":
                    target.symlink_to(self.payload / "added.txt")
                elif mutation == "executable":
                    target.write_bytes(b"repaired\n")
                    target.chmod(0o755)
                elif mutation == "fifo":
                    import os
                    os.mkfifo(target)
                with self.assertRaises((ValueError, OSError)):
                    self.portable()
        self.assertEqual((self.official / "file.txt").read_bytes(), b"base\n")

    def test_receipt_and_output_conflicts(self):
        self.sign()
        self.output.mkdir()
        with self.assertRaises((ValueError, OSError)):
            self.portable()
        self.output.rmdir()
        outside = self.root / "outside"
        outside.mkdir()
        self.output.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.portable()
        self.output.unlink()
        self.portable()
        receipt = Path(str(self.output) + ".receipt.json")
        receipt.write_text('{}')
        with self.assertRaises(ValueError):
            self.portable()
        self.assertEqual((self.official / "file.txt").read_bytes(), b"base\n")

    def test_rejects_output_inside_checkout(self):
        self.sign()
        self.output = self.key_root / "arbitrary"
        with self.assertRaises(ValueError):
            self.portable()

    def test_verify_only_reconstructs_even_forged_receipt(self):
        self.sign()
        identity = {"record": "fixture/manifest.json", "sha256": sha(self.record_path.read_bytes())}
        def verify():
            return module.derive_portable(self.archive, self.release, self.digest, self.record_path,
                                          self.output, identity, self.key_root, verify_only=True)
        with self.assertRaises(ValueError):
            verify()
        self.assertFalse(self.output.exists())
        self.portable()
        verify()
        (self.output / "unchanged.txt").write_bytes(b"forged")
        forged = module._receipt(self.output, self.digest, identity)
        Path(str(self.output) + ".receipt.json").write_text(json.dumps(forged))
        with self.assertRaises(ValueError):
            verify()

    def test_configured_source_and_ancestor_symlink(self):
        record = self.key_root / module.DERIVATION_RECORD
        record.parent.mkdir(parents=True)
        record.write_bytes(b"manifest")
        provenance = self.key_root / "provenance/upstreams.json"
        source = {"kind": "signed-derivation", "record": module.DERIVATION_RECORD, "sha256": sha(b"manifest")}
        provenance.write_text(json.dumps({"upstreams": [{"id": "omniroute", "qualification_source": source}]}))
        self.assertEqual(module.resolve_qualification_source(self.key_root),
                         {"record": source["record"], "sha256": source["sha256"]})
        source["extra"] = True
        provenance.write_text(json.dumps({"upstreams": [{"id": "omniroute", "qualification_source": source}]}))
        with self.assertRaises(ValueError):
            module.resolve_qualification_source(self.key_root)
        self.sign()
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        self.output = link / "derived"
        with self.assertRaises(ValueError):
            self.portable()

    def test_failed_subtree_enumeration_rejects_incomplete_tree(self):
        self.sign()
        self.portable()
        walk = module.os.walk
        def partial_walk(root, **options):
            if Path(root) == self.output:
                options["onerror"](PermissionError("unreadable extra subtree"))
            yield from walk(root, **options)
        with patch.object(module.os, "walk", partial_walk):
            with self.assertRaisesRegex(PermissionError, "unreadable extra subtree"):
                module.verify_effective_tree(self.output, self.digest,
                    {"record": "fixture/manifest.json", "sha256": sha(self.record_path.read_bytes())})


if __name__ == "__main__":
    unittest.main()
