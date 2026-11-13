#!/usr/bin/env python3
"""Run pinned ingress observations offline in the required isolated sandbox; not qualification evidence."""
import argparse
import base64
import hashlib
from datetime import datetime, timezone
import io
import json
import re
import os
from pathlib import Path, PurePosixPath
import selectors
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'test/fixtures/pinned-ingress'
NODE = None
SOURCE = None
DEPENDENCIES = None
BWRAP = None
COMMIT = '191dce8d534ceb56c28a08e71381284a9a87838f'
NODE_SHA = '62d66443847de1f527f74afe715900b12884ace52136dc9cd8e91e61acc2f527'
ARCHIVE_SHA = '2fcdb68b59e67abefa207841605b7fbd4569df596b9c900aeb93905ae325fc3b'
MEMORY = 8 * 1024**3
DISK = 12 * 1024**3
NODE_ARCHIVE_SHA = 'ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917'
NODE_ARCHIVE_URL = 'https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-x64.tar.xz'
SOURCE_URL = 'https://github.com/diegosouzapw/OmniRoute/releases/download/v3.8.53/OmniRoute-v3.8.53.source.tar.gz'
BWRAP_SHA = '70aca4fa8daeacb677ec00e8063eb586f08ae3d94b1f11e684370b5524c43431'
BWRAP_URL = 'https://ftp.debian.org/debian/pool/main/b/bubblewrap/bubblewrap_0.12.0-1~deb13u1_amd64.deb'
BWRAP_LIMIT = 1024**2


class RestrictedRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts):
        super().__init__()
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl, self.hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_url(url, hosts):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname in hosts and parsed.port in (None, 443)
            and not parsed.username and not parsed.password and not parsed.fragment, 'unapproved download URL')


def download(url, destination, maximum, expected_size=None):
    hosts = {'nodejs.org'} if url == NODE_ARCHIVE_URL else ({'github.com'} if url == SOURCE_URL else ({'ftp.debian.org'} if url == BWRAP_URL else {'registry.npmjs.org'}))
    validate_url(url, hosts)
    redirect_hosts = {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'} if url == SOURCE_URL else hosts
    opener = urllib.request.build_opener(RestrictedRedirect(redirect_hosts))
    total = 0
    with opener.open(url, timeout=60) as response, destination.open('xb') as output:
        while True:
            block = response.read(min(1024 * 1024, maximum - total + 1))
            if not block:
                break
            total += len(block)
            require(total <= maximum, 'download exceeds byte limit')
            output.write(block)
    require(expected_size is None or total == expected_size, 'download size mismatch')


def acquisition_preflight():
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'requires Linux x86_64')
    for executable in ('/usr/bin/dpkg-query', '/usr/bin/dpkg', '/usr/bin/dpkg-deb'):
        require(os.access(executable, os.X_OK), 'missing prerequisite executable: ' + executable)
    for package, minimum in (('libc6', '2.38'), ('libcap2', '1:2.10'), ('libselinux1', '3.1~')):
        result = subprocess.run(['/usr/bin/dpkg-query', '-W', '-f=${Status}\t${Version}', package], capture_output=True, text=True, timeout=15)
        fields = result.stdout.strip().split('\t')
        require(result.returncode == 0 and len(fields) == 2 and fields[0] == 'install ok installed', 'required installed library unavailable: ' + package)
        result = subprocess.run(['/usr/bin/dpkg', '--compare-versions', fields[1], 'ge', minimum], timeout=15)
        require(result.returncode == 0, 'required installed library too old: ' + package + ' >= ' + minimum)


def bwrap_members(package):
    require(package.is_file() and not package.is_symlink() and package.stat().st_size == 56876 and file_sha(package) == BWRAP_SHA, 'bubblewrap package identity mismatch')
    process = subprocess.Popen(['/usr/bin/dpkg-deb', '--fsys-tarfile', str(package)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        data = process.stdout.read(BWRAP_LIMIT + 1)
        require(len(data) <= BWRAP_LIMIT, 'bubblewrap archive output exceeds byte limit')
        require(process.wait(timeout=30) == 0, 'bubblewrap archive extraction failed')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
    wanted = {'./usr/bin/bwrap': 'bwrap', './usr/share/doc/bubblewrap/copyright': 'copyright'}
    found = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive:
            if member.name not in wanted:
                continue
            require(member.name not in found and member.isfile() and 0 < member.size <= BWRAP_LIMIT, 'invalid bubblewrap archive member')
            total += member.size
            require(total <= BWRAP_LIMIT, 'bubblewrap extracted bytes exceed limit')
            stream = archive.extractfile(member)
            require(stream is not None, 'bubblewrap member unavailable')
            found[member.name] = stream.read(member.size + 1)
            require(len(found[member.name]) == member.size, 'bubblewrap member size mismatch')
    require(set(found) == set(wanted), 'bubblewrap archive members missing')
    return {wanted[name]: value for name, value in found.items()}


def stage_bwrap(root, approval):
    require(approval == BWRAP_SHA, 'explicit approval of exact bubblewrap package SHA256 required')
    acquisition_preflight()
    require(not root.exists() and not root.is_symlink(), 'bubblewrap stage directory already exists')
    parent = root.parent.resolve(strict=True)
    if os.environ.get('CI') == 'true':
        temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        require(parent == temp or temp in parent.parents, 'CI bubblewrap stage directory must be under RUNNER_TEMP')
    root = parent / root.name
    root.mkdir(mode=0o700)
    package = root / 'bubblewrap.deb'
    download(BWRAP_URL, package, 56876, 56876)
    for name, data in bwrap_members(package).items():
        put(root, name, data, executable=name == 'bwrap')
    return root / 'bwrap'


def validate_bwrap(path):
    require(path is not None and path.is_absolute() and not path.is_symlink() and path.is_file() and os.access(path, os.X_OK), 'explicit staged bubblewrap executable required')
    require(path.name == 'bwrap' and not path.parent.is_symlink(), 'invalid bubblewrap path')
    members = bwrap_members(path.parent / 'bubblewrap.deb')
    require(path.stat().st_size == len(members['bwrap']) and path.read_bytes() == members['bwrap'], 'bubblewrap executable identity mismatch')
    return path.resolve(strict=True)


def ci_profile_context(approved):
    require(approved and os.environ.get('CI') == 'true' and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('RUNNER_OS') == 'Linux' and sys.platform == 'linux'
            and os.uname().machine == 'x86_64', 'explicit approval and GitHub-hosted Linux x64 required')
    run = os.environ.get('GITHUB_RUN_ID', '')
    attempt = os.environ.get('GITHUB_RUN_ATTEMPT', '')
    require(re.fullmatch(r'[0-9]{1,20}', run) and re.fullmatch(r'[0-9]{1,10}', attempt), 'invalid workflow identity')
    temp = Path(os.environ.get('RUNNER_TEMP', '')).resolve(strict=True)
    path = temp / 'pinned-bwrap' / 'bwrap'
    require(re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) and '..' not in path.parts, 'unsafe AppArmor attachment path')
    name = 'omp-ingress-' + run + '-' + attempt
    source = f'abi <abi/4.0>,\nprofile {name} {path} flags=(unconfined) {{\n  userns,\n}}\n'
    return path, name, source, temp / 'pinned-bwrap-apparmor-state.json'


def ci_profiles(name):
    process = subprocess.Popen(['/usr/bin/sudo', '-n', '/usr/bin/cat', '/sys/kernel/security/apparmor/profiles'],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    buffers = {process.stdout: bytearray(), process.stderr: bytearray()}
    deadline = time.monotonic() + 10
    try:
        with selectors.DefaultSelector() as selector:
            for stream in buffers:
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'AppArmor profile listing timed out')
                events = selector.select(remaining)
                require(events, 'AppArmor profile listing timed out')
                for key, _ in events:
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        buffers[key.fileobj].extend(chunk)
                        require(len(buffers[key.fileobj]) <= 1024 * 1024, 'AppArmor profile listing too large')
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'AppArmor profile listing timed out')
            require(process.wait(timeout=remaining) == 0, 'AppArmor profile listing failed')
        text = buffers[process.stdout].decode('utf-8', errors='strict')
        lines = text.splitlines()
        require(all(re.fullmatch(r'[^\x00-\x1f\x7f]+ \((?:enforce|complain|unconfined|kill|prompt)\)', line) for line in lines),
                'invalid AppArmor profile listing')
        matches = [line for line in lines if line.startswith(name + ' (')]
        require(len(matches) <= 1, 'ambiguous AppArmor profile identity')
        return matches
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()


def ci_profile(approved, cleanup=False):
    path, name, source, state = ci_profile_context(approved)
    require(os.access('/usr/sbin/apparmor_parser', os.X_OK) and os.access('/usr/bin/sudo', os.X_OK), 'AppArmor parser or sudo unavailable')
    if cleanup:
        if not state.exists() and not state.is_symlink():
            require(not ci_profiles(name), 'profile exists without trusted cleanup state')
            return
        require(not state.is_symlink() and state.is_file(), 'invalid AppArmor cleanup state')
        record = json.loads(state.read_text())
        require(record == {'name': name, 'path': str(path), 'sourceSha256': digest(source.encode()), 'status': 'attempted'}, 'AppArmor cleanup state uncertain')
        if ci_profiles(name):
            result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/sbin/apparmor_parser', '-R'], input=source, text=True, capture_output=True, timeout=30)
            require(result.returncode == 0 and not ci_profiles(name), 'AppArmor profile cleanup uncertain')
        state.unlink()
        return
    require(not state.exists() and not state.is_symlink(), 'AppArmor state already exists')
    require(validate_bwrap(path) == path, 'staged helper path mismatch')
    require(not ci_profiles(name), 'AppArmor profile already exists')
    record = {'name': name, 'path': str(path), 'sourceSha256': digest(source.encode()), 'status': 'attempted'}
    # Publish a complete intent without replacing an existing state file.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=state.parent, prefix='.pinned-bwrap-intent-', delete=False) as output:
            temporary = Path(output.name)
            json.dump(record, output)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, state)
    finally:
        if temporary is not None:
            temporary.unlink()
    result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/sbin/apparmor_parser', '-a'], input=source, text=True, capture_output=True, timeout=30)
    require(result.returncode == 0, 'AppArmor profile load failed; cleanup state uncertain')
    require(ci_profiles(name), 'AppArmor profile load not confirmed')
    print(json.dumps({'profile': name, 'attachment': str(path), 'profileSha256': digest(source.encode()), 'packageSha256': BWRAP_SHA, 'binarySha256': file_sha(path)}))


def preflight():
    missing = [path for path in ('/usr/bin/python3', '/usr/bin/systemd-run', '/usr/bin/systemctl', '/usr/bin/ip', '/usr/bin/gpg', '/usr/bin/git') if not os.access(path, os.X_OK)]
    require(not missing, 'missing prerequisite executables: ' + ', '.join(missing))
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'requires Linux x86_64')
    require(Path('/sys/fs/cgroup/cgroup.controllers').is_file(), 'cgroup v2 unavailable')
    cpus = sorted(os.sched_getaffinity(0))[:2]
    require(cpus, 'CPU affinity unavailable')
    status = subprocess.run(['/usr/bin/systemctl', '--user', 'show-environment'], capture_output=True, text=True, timeout=15)
    require(status.returncode == 0, 'user-systemd unavailable: ' + status.stderr.strip()[:500])
    unit = 'omp-ingress-preflight-' + uuid.uuid4().hex[:12]
    command = ['/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect', '--unit', unit,
               '--property=MemoryMax=' + str(MEMORY), '--property=RuntimeMaxSec=45', '--property=KillMode=control-group',
               '--property=CPUQuota=200%', '--property=AllowedCPUs=' + ','.join(map(str, cpus)),
               '--property=CPUAffinity=' + ' '.join(map(str, cpus)), '/usr/bin/python3', str(Path(__file__).resolve()), '--preflight-probe', '--bwrap', str(BWRAP)]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        require(result.returncode == 0, 'user-systemd/cgroup/namespace preflight failed: ' + (result.stderr + result.stdout)[-2000:])
    finally:
        subprocess.run(['/usr/bin/systemctl', '--user', 'stop', unit], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)


def preflight_probe():
    group = next((line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')), None)
    require(group is not None, 'cgroup v2 process membership unavailable')
    group_path = Path('/sys/fs/cgroup') / group.lstrip('/')
    require((group_path / 'memory.max').read_text().strip() == str(MEMORY), 'cgroup memory delegation unavailable')
    require(0 < len(os.sched_getaffinity(0)) <= 2, 'cgroup CPU affinity delegation unavailable')
    require((group_path / 'cpu.max').read_text().split()[0] != 'max', 'cgroup CPU quota delegation unavailable')
    namespaces = [os.readlink('/proc/self/ns/' + name) for name in ('user', 'mnt', 'net', 'pid')]
    code = "import os,subprocess,json,sys; names=('user','mnt','net','pid'); assert all(os.readlink('/proc/self/ns/'+n)!=v for n,v in zip(names,sys.argv[1:])), 'namespace isolation unavailable'; subprocess.run(['/usr/bin/ip','link','set','lo','up'],check=True); assert {x['ifname'] for x in json.loads(subprocess.check_output(['/usr/bin/ip','-j','link','show']))}=={'lo'}, 'network isolation unavailable'"
    command = [str(BWRAP), '--unshare-all', '--uid', '0', '--gid', '0', '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SYS_ADMIN', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--', '/usr/bin/python3', '-c', code, *namespaces]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=25)
    require(result.returncode == 0, 'bubblewrap/namespace/ip prerequisite unavailable: ' + (result.stderr + result.stdout)[-1500:])


def stage(root, approval):
    require(approval == NODE_ARCHIVE_SHA, 'explicit approval of exact Node archive SHA256 required')
    require(not root.exists() and not root.is_symlink(), 'stage directory already exists')
    parent = root.parent.resolve(strict=True)
    if os.environ.get('CI') == 'true':
        temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        require(parent == temp or temp in parent.parents, 'CI stage directory must be under RUNNER_TEMP')
    root = parent / root.name
    root.mkdir(mode=0o700)
    dependencies = root / 'dependencies'
    dependencies.mkdir(mode=0o700)
    manifest = json.loads((FIXTURE / 'dependencies.json').read_text())
    require(manifest['schemaVersion'] == 1 and manifest['platform'] == 'linux-x64-glibc' and len(manifest['packages']) == 267, 'dependency manifest mismatch')
    seen = {}
    total = 0
    for item in manifest['packages']:
        filename = item['file']
        require(re.fullmatch(r'[a-f0-9]{64}\.tgz', filename) is not None, 'invalid package file identity')
        require(isinstance(item['bytes'], int) and 0 < item['bytes'] <= 128 * 1024**2, 'invalid dependency size')
        validate_url(item['url'], {'registry.npmjs.org'})
        identity = (item['bytes'], item['sha256'], item['integrity'], item['url'])
        require(filename not in seen or seen[filename] == identity, 'conflicting dependency identity')
        if filename in seen:
            continue
        seen[filename] = identity
        total += item['bytes']
        require(total <= 512 * 1024**2, 'aggregate dependency download limit exceeded')
    for item in manifest['packages']:
        filename = item['file']
        if (dependencies / filename).exists():
            continue
        download(item['url'], dependencies / filename, item['bytes'], item['bytes'])
        verified_dependency(dependencies, item)
    source = root / 'source.tar.gz'
    download(SOURCE_URL, source, 512 * 1024**2)
    require(file_sha(source) == ARCHIVE_SHA, 'source archive mismatch')
    archive = root / 'node.tar.xz'
    download(NODE_ARCHIVE_URL, archive, 64 * 1024**2, 31426020)
    require(file_sha(archive) == NODE_ARCHIVE_SHA, 'Node archive mismatch')
    node = root / 'node'
    with tarfile.open(archive, 'r:xz') as bundle:
        members = [member for member in bundle if member.name == 'node-v24.17.0-linux-x64/bin/node']
        require(len(members) == 1 and members[0].isfile() and 0 < members[0].size <= 150 * 1024**2, 'invalid Node archive executable')
        with bundle.extractfile(members[0]) as source_stream, node.open('xb') as output:
            shutil.copyfileobj(source_stream, output, 1024 * 1024)
    require(file_sha(node) == NODE_SHA, 'Node runtime mismatch')
    node.chmod(0o755)
    print(json.dumps({'node': str(node), 'sourceArchive': str(source), 'dependencyDir': str(dependencies), 'outputDir': str(root)}))


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(data, algorithm='sha256'):
    return hashlib.new(algorithm, data).hexdigest()


def file_sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path, obj):
    path.write_text(json.dumps(obj, indent=2) + '\n', encoding='utf-8')
    path.chmod(0o600)


def safe_parts(name):
    require(isinstance(name, str) and '\\' not in name and '\x00' not in name, 'invalid archive path')
    parts = PurePosixPath(name).parts
    require(parts and not name.startswith('/') and all(x not in ('', '.', '..') for x in parts), 'unsafe archive path')
    return parts


def put(root, name, data, executable=False):
    parts = safe_parts(name)
    target = root.joinpath(*parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    require(not target.exists() and not target.is_symlink(), 'duplicate archive path: ' + name)
    with target.open('xb') as stream:
        stream.write(data)
    target.chmod(0o755 if executable else 0o644)


def disk_usage(root):
    total = 0
    for directory, _, names in os.walk(root, followlinks=False):
        for name in names:
            try:
                total += (Path(directory) / name).lstat().st_size
            except FileNotFoundError:
                pass
    require(total <= DISK, 'scratch disk limit exceeded')
    return total



ROUTES = ('src/app/api/health/ping/route.ts', 'src/app/api/settings/cache-metrics/route.ts', 'src/lib/db/settings/cacheMetrics.ts', 'src/app/api/health/degradation/route.ts', 'src/domain/degradation.ts', 'src/app/api/agent-skills/route.ts', 'src/app/api/agent-skills/[id]/route.ts', 'src/app/api/agent-skills/coverage/route.ts', 'src/lib/agentSkills/catalog.ts', 'src/lib/agentSkills/schemas.ts', 'src/lib/agentSkills/types.ts', 'src/shared/constants/agentSkills.ts')
POLICY_SOURCES = ('src/app/api/model-combo-mappings/route.ts', 'src/app/api/model-combo-mappings/[id]/route.ts', 'src/app/api/combos/route.ts', 'src/app/api/combos/[id]/route.ts', 'src/app/api/combos/auto/route.ts', 'src/app/api/combos/builder/options/route.ts', 'src/app/api/combos/metrics/route.ts', 'src/app/api/model-capability-overrides/route.ts')
POLICY_SOURCES += ('src/app/api/fallback/chains/route.ts', 'src/app/api/providers/[id]/cc-alias/route.ts', 'src/app/api/provider-nodes/route.ts')
LIVE_ROUTE = 'src/app/livez/route.ts'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def verified_dependency(directory, item):
    name = item['name']
    filename = item['file']
    require(re.fullmatch(r'[a-f0-9]{64}\.tgz', filename) is not None, 'invalid package file identity')
    path = directory / filename
    require(not path.is_symlink() and path.is_file() and path.stat().st_size == item['bytes'], 'missing or wrong-size dependency: ' + name)
    raw = path.read_bytes()
    require(digest(raw) == item['sha256'] and 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode() == item['integrity'], 'dependency integrity mismatch: ' + name)
    return raw


def effective_source(archive, root, output):
    """Reconstruct the declared source with the preparation owner's verifier."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('prepare_upstream', root / 'scripts/prepare-upstream.py')
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    pin = json.loads((root / 'provenance/upstreams.json').read_text())
    upstream = next(item for item in pin['upstreams'] if item['id'] == 'omniroute')
    release = upstream['release']
    require(release['peeled_commit'] == COMMIT and release['version'] == '3.8.53' and upstream['artifact_integrity']['source_archive_sha256'] == ARCHIVE_SHA, 'base source pin mismatch')
    derivation = owner.resolve_qualification_source(root)
    if derivation is None:
        require(file_sha(archive) == ARCHIVE_SHA, 'source archive mismatch')
        with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
            with tarfile.open(archive, 'r:gz') as bundle:
                members = bundle.getmembers()
                require(len(members) <= 100000 and sum(member.size for member in members) <= 2 * 1024**3 and all(member.isdir() or member.isfile() for member in members), 'unsafe source archive')
                bundle.extractall(temporary, members=members, filter='data')
            children = list(Path(temporary).iterdir())
            require(len(children) == 1 and children[0].is_dir(), 'invalid source archive root')
            require(json.loads((children[0] / 'package.json').read_text())['version'] == release['version'], 'source version mismatch')
            receipt = owner._receipt(children[0], ARCHIVE_SHA, None)
            children[0].rename(output)
        return {'effectiveTreeSha256': receipt['treeSha256']}
    old_path = os.environ.get('PATH')
    try:
        os.environ['PATH'] = '/usr/bin:/bin'
        receipt = owner.derive_portable(archive, release, ARCHIVE_SHA, root / derivation['record'], output, derivation, root=root)
    finally:
        if old_path is None:
            os.environ.pop('PATH', None)
        else:
            os.environ['PATH'] = old_path
    return {'sourceDerivation': derivation, 'effectiveTreeSha256': receipt['treeSha256']}


def effective_source_identities(archive, root=ROOT):
    """Return the verified identity for independent expected-ingress consumers."""
    with tempfile.TemporaryDirectory() as temporary:
        return effective_source(archive, root, Path(temporary) / 'source')


def expected_core_lifecycle_input_key(archive, node, dependency_dir, bwrap, root=ROOT):
    """Hash verified input bytes for a caller-owned, before-and-after checked cache."""
    require(Path(root).resolve(strict=True) == ROOT, 'unexpected producer root')
    archive, node, dependency_dir, bwrap = map(Path, (archive, node, dependency_dir, bwrap))
    require(archive.is_file() and not archive.is_symlink() and file_sha(archive) == ARCHIVE_SHA, 'source archive mismatch')
    require(node.is_file() and not node.is_symlink() and file_sha(node) == NODE_SHA, 'Node runtime mismatch')
    require(dependency_dir.is_dir() and not dependency_dir.is_symlink(), 'dependency directory unavailable')
    validate_bwrap(bwrap)
    manifest = bounded_json(FIXTURE / 'dependencies.json')
    require(manifest['schemaVersion'] == 1 and manifest['platform'] == 'linux-x64-glibc' and len(manifest['packages']) == 267, 'dependency manifest mismatch')
    dependencies = {}
    for item in manifest['packages']:
        raw = verified_dependency(dependency_dir, item)
        dependencies[item['file']] = sha(raw)
    value = {'inputs': input_hashes(), 'archive': file_sha(archive), 'node': file_sha(node),
             'bwrap': file_sha(bwrap), 'bwrapPackage': file_sha(bwrap.parent / 'bubblewrap.deb'),
             'dependencies': dependencies}
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def expected_core_lifecycle_identities(archive, node, dependency_dir, bwrap, root=ROOT):
    """Recompute expectations by executing the current producer in fresh isolated scratch."""
    with tempfile.TemporaryDirectory(prefix='pinned-lifecycle-expect-') as temporary:
        command = ['/usr/bin/python3', str(root / 'scripts/pinned-ingress.py'), '--real-core',
                   '--source-archive', str(Path(archive).resolve(strict=True)),
                   '--node', str(Path(node).resolve(strict=True)),
                   '--dependency-dir', str(Path(dependency_dir).resolve(strict=True)),
                   '--bwrap', str(Path(bwrap).resolve(strict=True)), '--output-dir', temporary]
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=660, check=True)
        response = json.loads(result.stdout)
        output = Path(response['output'])
        require(output.parent == Path(temporary) and not output.is_symlink(), 'unexpected identity output')
        artifact = bounded_json(output / 'export/core-lifecycle.json')
        return {key: artifact[key] for key in ('identity', 'inputSha256', 'isolation', 'cold', 'warm')}


def materialize(real_core=False):
    source = Path('/inputs/source.tar.gz')
    app = Path('/work/app')
    fixture = Path('/fixture-src')
    manifest = json.loads((fixture / 'source-manifest.json').read_text())
    runtime = json.loads((fixture / 'runtime.json').read_text())
    require(manifest['schemaVersion'] == runtime['schemaVersion'] == 1 and runtime['nodeVersion'] == '24.17.0' and runtime['nodeSha256'] == NODE_SHA, 'runtime manifest mismatch')
    require(manifest['commit'] == runtime['sourceCommit'] == COMMIT, 'source commit mismatch')
    require(file_sha(source) == manifest['archiveSha256'] == runtime['sourceArchiveSha256'] == ARCHIVE_SHA, 'source archive mismatch')
    effective = Path('/work/effective-source')
    source_identity = effective_source(source, Path('/source-input'), effective)
    changes = json.loads((Path('/source-input') / source_identity['sourceDerivation']['record']).read_text())['changes'] if 'sourceDerivation' in source_identity else []
    changed = {item['path']: item for item in changes}
    selected = manifest['selectedFiles']
    additional = manifest['additionalFiles']
    require(len(selected) == 509, 'selected source coverage mismatch')
    wanted = {'next.config.mjs', 'source.config.ts', 'tsconfig.json', 'package.json', 'open-sse/package.json'}
    support = {}
    seen = set()
    with tarfile.open(source, 'r:gz') as archive:
        for member in archive:
            parts = safe_parts(member.name)
            if len(parts) < 2 or parts[0] != 'OmniRoute-v3.8.53' or member.isdir():
                continue
            name = '/'.join(parts[1:])
            lifecycle_source = real_core and name.startswith(('src/', 'open-sse/', 'packages/')) and name.endswith(('.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sql'))
            if name not in selected and name not in additional and name not in wanted and not (name.startswith('scripts/build/') and name.endswith(('.mjs', '.cjs'))) and not name.startswith('src/i18n/') and name != 'config/cli-tools-manifest.json' and not lifecycle_source:
                continue
            require(member.isfile() and member.size <= 2 * 1024 * 1024 and name not in seen, 'invalid source member: ' + name)
            seen.add(name)
            data = archive.extractfile(member).read()
            require(len(data) == member.size, 'short source member: ' + name)
            blob = digest(b'blob ' + str(len(data)).encode() + b'\0' + data, 'sha1')
            for expected in (selected.get(name), additional.get(name), manifest['nextConfig'] if name == 'next.config.mjs' else None):
                if expected:
                    require(digest(data) == expected['sha256'] and blob == expected['gitBlob'], 'source identity mismatch: ' + name)
            effective_data = (effective / name).read_bytes()
            if name in changed:
                require(digest(data) == changed[name]['input_sha256'] and digest(effective_data) == changed[name]['output_sha256'], 'derived source identity mismatch: ' + name)
            else:
                require(data == effective_data, 'effective source differs from base: ' + name)
            support[name] = digest(effective_data)
            put(app, 'next.config.upstream.mjs' if name == 'next.config.mjs' else name, effective_data)
    require(set(selected) <= seen and set(additional) <= seen and wanted <= seen, 'missing source closure')
    if real_core:
        regression = 'tests/unit/db-async-fresh-startup.test.ts'
        require(regression in changed, 'signed startup regression missing')
        data = (effective / regression).read_bytes()
        require(sha(data) == changed[regression]['output_sha256'], 'startup regression identity mismatch')
        if regression not in seen:
            put(app, regression, data)
        support[regression] = sha(data)
    dependencies = json.loads((fixture / 'dependencies.json').read_text())
    require(dependencies['schemaVersion'] == 1 and dependencies['platform'] == 'linux-x64-glibc', 'unsupported dependency manifest')
    locations = set()
    for item in dependencies['packages']:
        location, name = item['location'], item['name']
        parts = safe_parts(location)
        require(parts[0] == 'node_modules' and location.rsplit('node_modules/', 1)[-1] == name and location not in locations, 'invalid package location: ' + location)
        locations.add(location)
        raw = verified_dependency(Path('/inputs/dependencies'), item)
        package_root = app.joinpath(*parts)
        members = set()
        root = None
        with tarfile.open(fileobj=__import__('io').BytesIO(raw), mode='r:gz') as archive:
            for member in archive:
                member_parts = safe_parts(member.name)
                if root is None:
                    root = member_parts[0]
                require(member_parts[0] == root, 'multiple package archive roots')
                if len(member_parts) == 1:
                    require(member.isdir(), 'invalid package root')
                    continue
                rel = '/'.join(member_parts[1:])
                require(rel not in members, 'duplicate package member')
                members.add(rel)
                if member.isdir():
                    continue
                require(member.isfile() and member.size <= DISK, 'unsafe package member')
                data = archive.extractfile(member).read()
                require(len(data) == member.size, 'short package member')
                put(package_root, rel, data, bool(member.mode & 0o111))
        package = json.loads((package_root / 'package.json').read_text())
        require(package.get('name') == name and package.get('version') == item['version'], 'package manifest mismatch: ' + name)
    if real_core:
        versions = {name: json.loads((app / 'node_modules' / name / 'package.json').read_text())['version'] for name in ('tsx', 'sql.js', 'esbuild', '@esbuild/linux-x64')}
        require(versions == {'tsx': '4.23.13', 'sql.js': '1.14.2', 'esbuild': '0.28.2', '@esbuild/linux-x64': '0.28.2'}, 'startup dependency version mismatch')
    shutil.copytree(fixture, '/work/fixture', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile('/driver.mjs', '/work/fixture/pinned-ingress-driver.mjs')
    (app / '.build').mkdir(exist_ok=True)
    (app / '.source').mkdir(exist_ok=True)
    (app / 'next-env.d.ts').touch()
    if not real_core:
        shutil.copyfile('/work/fixture/next.config.mjs', app / 'next.config.mjs')
        for route in ('src/app/api/ingress-control/route.ts', 'src/app/api/providers/fixture/models/route.ts', *POLICY_SOURCES):
            put(app, route, Path('/work/fixture/routes/management.ts').read_bytes())
    (app / 'docs').mkdir(exist_ok=True)
    os.symlink('/work/app/node_modules', '/work/node_modules')
    return {'selectedSourceFiles': len(selected), 'configSupportSha256': support, 'packageCount': len(locations), 'archiveSha256': ARCHIVE_SHA, **source_identity}

def replace_once(text, before, after):
    require(text.count(before) == 1, 'fixture boundary changed: ' + before[:80])
    return text.replace(before, after, 1)

def ping_declaration(source_core):
    matches = re.findall(r'(?ms)^export function pingDb\(\): boolean \{\n.*?^\}', source_core)
    require(len(matches) == 1, 'source pingDb declaration unavailable or ambiguous')
    return matches[0]


READ_CLOSURES = {
    'src/lib/db/apiKeys.ts': '4e9bc2be404d6c74e1fbf9fc1d62b03853a84eead453ce70e2fc8cadd33673eb',
    'src/lib/db/featureFlags.ts': '62adb42a37ad5e437e36e4e0df4bb702739932aa1b63e46fc1d00da7cc273bc1',
    'src/lib/db/readCache.ts': '97cb59fb5767005900c575e8f6db450c3b94abaa7a7058671dda1717da223448',
    'src/lib/db/encryption.ts': '630c8e0e3061bc634fcbeb1b1eb6e1443a52b76c7404af5964c1de9c411aa2ed',
    'src/lib/compliance/index.ts': 'd8a2607d81db1d717286868a8114571af8308a4d6e0700e93f223d320aec0c30',
    'src/lib/db/backup.ts': '044878af22ecd3c8ef1bb43819c6a9dc7a5fa2025bc0c83309922949ab7ca574',
}

def read_closures(app, manifest):
    """Extract only pinned declarations; reject any source or boundary drift."""
    sources = {}
    for name, expected in READ_CLOSURES.items():
        data = (app / name).read_bytes()
        recorded = manifest['selectedFiles'].get(name) or manifest['additionalFiles'].get(name)
        require(recorded and sha(data) == expected == recorded['sha256'], 'read closure identity mismatch: ' + name)
        sources[name] = data.decode('utf-8')

    def span(name, start, end):
        source = sources[name]
        require(source.count(start) == 1 and source.count(end) == 1, 'read closure boundary changed: ' + name)
        first, last = source.index(start), source.index(end)
        require(first < last, 'read closure boundary order changed: ' + name)
        return source[first:last]

    def suffix(name, start):
        source = sources[name]
        require(source.count(start) == 1, 'read closure boundary changed: ' + name)
        return source[source.index(start):]


    api = 'src/lib/db/apiKeys.ts'
    flags = 'src/lib/db/featureFlags.ts'
    cache = 'src/lib/db/readCache.ts'
    encryption = 'src/lib/db/encryption.ts'
    compliance = 'src/lib/compliance/index.ts'
    backup = 'src/lib/db/backup.ts'
    imports = '''import { parseApiKeyCodexServiceMode, type ApiKeyCodexServiceMode } from "../../shared/constants/codexServiceMode";
import { opaqueTokenFingerprint } from "@omniroute/open-sse/utils/opaqueTokenFingerprint.ts";
import { v4 as uuidv4 } from "uuid";
import { backupDbFile } from "./backup";
import { invalidateReasoningRoutingRuleCache } from "./reasoningRoutingRules";
import { normalizeApiKeyPermissionsUpdate } from "./apiKeys/permissionsUpdate";
import { getDbInstance } from "./core";
import { registerDbStateResetter } from "./stateReset";
import { ensureApiKeyFallbackColumns } from "./apiKeyColumnFallbacks";
import { SYNTHETIC_ENV_API_KEY_ID } from "@/shared/constants/apiKeyIdentities";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";
import { parseApiKeyUsageLimitFields } from "./apiKeyUsageLimitFields";
import { setNoLog } from "../compliance/noLog";
import { isSelfLoopBearer, selfLoopKeyOverrides } from "./apiKeys/selfLoopKey";
import { backfillApiKeySecretsAtRest, encryptApiKeySecret } from "./apiKeys/secretAtRest";
import { ALL_COMBOS_ACCESS_RULE } from "@/shared/constants/comboAccess";
import { parseAllowedModels, parseAllowedCombos, parseNoLog, parseAutoResolve, parseDisableNonPublicModels, parseAllowUsageCommand, parseIsActive, parseAccessSchedule, parseRateLimits, parseAllowedConnections, parseAllowedQuotas, parseStringList, parseNullableTimestamp, parseIsBanned, parseStreamDefaultMode, parseCacheDefaultMode, parseChaosModeEnabled, parseCompressionEnabled, parseAllowAutoCombos, parseAllowCcDiscoveryAliases, parseCatalogScope, parseForcedModel, parseModelAccessMode } from "./apiKeys/rowParsers";
import { clearModelPermissionCache } from "./apiKeys/modelPermissionCache";
import type { ModelAccessMode } from "./apiKeys/modelAccessMode";
import type { AccessSchedule, RateLimitRule } from "./apiKeys/types";
'''
    api_text = (imports + span(api, 'let _schemaChecked = false;', 'function markApiKeyUsed(')
        + span(api, 'function markApiKeyUsed(', 'async function getModelPermissionCandidates(')
        + span(api, 'function ensureApiKeysColumns(', 'export async function getApiKeys(')
        + span(api, 'async function hashKey(', 'export async function createApiKey(')
        + span(api, 'export async function createApiKey(', 'export async function regenerateApiKey(')
        + span(api, 'export async function deleteApiKey(', '/**\n * Revoke an API key by id.')
        + span(api, 'export async function validateApiKey(', '/**\n * Check if a model is allowed for a given API key')
        + suffix(api, 'function clearPreparedStatementCache()'))
    flag_text = ('import { getDbInstance } from "./core";\n'
        + span(flags, 'const NAMESPACE =', 'const CATALOG_RELEVANT_FEATURE_FLAGS =')
        + span(flags, 'export function getFeatureFlagOverrides()', '/**\n * Persists (or replaces) an override'))
    cache_text = (span(cache, 'type CacheEntry<T> =', '/**\n * Cached wrapper for getSettings.')
        + span(cache, 'export async function getCachedSettings()', '/**\n * Cached wrapper for getPricing.')
        + span(cache, 'const rawConnectionsCache =', '/**\n * Cached wrapper for getRawProviderConnections.')
        + span(cache, 'const connectionByIdCache =', '/**\n * Cached wrapper for getProviderConnectionById.')
        + span(cache, 'let combosCacheVersion =', '/**\n * Current combo-cache version.')
        + span(cache, 'let modelCatalogCacheVersion =', '/**\n * Connection fields written by the chat path')
        + suffix(cache, 'export function invalidateDbCache('))
    encryption_text = (span(encryption, 'import { createCipheriv,', '/** Connection object with potentially encrypted credential fields.')
        + span(encryption, 'import fs from "fs";', 'import { mapProviderSpecificDataSecrets')
        + span(encryption, 'function ensureSecretLoaded()', '/**\n * Loud production warning')
        + span(encryption, 'export function looksEncrypted(', '/**\n * #11500'))
    compliance_text = ('import { getDbInstance } from "../db/core";\n'
        + 'import type { SqliteAdapter } from "@/lib/db/adapters/types";\n'
        + 'import { isNoLog } from "./noLog";\n'
        + span(compliance, 'function getDb()', 'type AuditLogWriteEntry')
        + span(compliance, 'const AUDIT_LOG_REQUIRED_COLUMNS:', 'type AuditLogQuery')
        + span(compliance, 'type ApiKeyAuthTouchDbState =', '/**\n * Query audit log entries.'))
    backup_text = ('''import path from "path";
import fs from "fs";
import { getDbInstance, isBuildPhase, isCloud, SQLITE_FILE, DB_BACKUPS_DIR, DATA_DIR } from "./core";
import { listBackupIds, resolveBackupFile } from "./backupPaths";
import { chmodQuiet, DB_SECRET_DIR_MODE, DB_SECRET_FILE_MODE } from "./filePermissions";
import { pruneBackupDirectory, resolveDbBackupRetention } from "./backupRetention";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";
'''
        + span(backup, 'let _lastBackupAt =', 'function setStoredDbBackupInteger(')
        + span(backup, 'export function getDbBackupMaxFiles()', '/** Persist the operator-chosen age-based')
        + span(backup, 'export function getDbBackupRetentionDays()', 'function sleep(')
        + span(backup, 'export function backupDbFile(', '// ──────────────── List Backups'))
    return {api: api_text.encode(), flags: flag_text.encode(), cache: cache_text.encode(),
            encryption: encryption_text.encode(), compliance: compliance_text.encode(), backup: backup_text.encode()}

def verify_flag_cache_fixture(flag_source, flag_fixture):
    prefix, marker, suffix = flag_fixture.partition('export function getFeatureFlagOverride(key: string)')
    require(marker and prefix and suffix and flag_fixture.count(marker) == 1
            and flag_source.count(prefix) == 1 and flag_source.count(marker + suffix) == 1,
            'feature flag fixture drift')



def overlay_bytes(core, settings, declaration):
    text = 'import { DatabaseSync } from "node:sqlite";\nimport path from "node:path";\n' + core.decode('utf-8')
    text = replace_once(text, 'const db = {',
        'let sqlite: DatabaseSync | undefined;\nconst db = {')
    text = replace_once(text, '      const normalized = sql.replace(/\\s+/g, " ").trim();',
        '      const normalized = sql.replace(/\\s+/g, " ").trim();\n'
        '      if (normalized === "SELECT 1 AS ok" || (/^SELECT /i.test(normalized) && /\\bFROM usage_history\\b/i.test(normalized))) {\n'
        '        event("sqlite:read");\n'
        '        sqlite ??= new DatabaseSync("/work/data/metrics.sqlite");\n'
        '        return sqlite.prepare(sql);\n'
        '      }')
    return {
        'backend/core.ts': (text + '\nexport const DB_BACKUPS_DIR = isCloud ? null : path.join(DATA_DIR, "db_backups");\n' + declaration + '\n').encode(),
        'backend/settings.ts': settings + b'\nexport { getCacheMetrics, resetCacheMetrics } from "@/lib/db/settings/cacheMetrics";\n',
    }


def overlay_plan(app, fixture, manifest, changes=None):
    """Verify all original and replacement bytes before modifying disposable source."""
    mapping = json.loads((fixture / 'alias-map.json').read_text())
    require(file_sha(app / 'next.config.upstream.mjs') == mapping['originalConfigSha256'] == manifest['nextConfig']['sha256'], 'config identity mismatch')
    aliases = mapping['aliases']
    expected = {'src/lib/db/core.ts', 'src/lib/db/settings.ts', 'src/sse/services/auth.ts', 'src/lib/config/runtimeSettings.ts', 'src/shared/services/modelSyncScheduler.ts', 'src/lib/gracefulShutdown.ts'}
    require(isinstance(aliases, list) and len(aliases) == len(expected) and {a['source'] for a in aliases} == expected, 'overlay boundary mismatch')
    replacements = set()
    for alias in aliases:
        name, replacement = alias['source'], alias['replacement']
        safe_parts(name)
        safe_parts(replacement)
        require(replacement not in replacements, 'duplicate overlay replacement')
        replacements.add(replacement)
        original = (app / name).read_bytes()
        data = (fixture / replacement).read_bytes()
        recorded = manifest['selectedFiles'].get(name) or manifest['additionalFiles'].get(name)
        require(recorded and alias['sourceSha256'] == recorded['sha256'] and sha(data) == alias['replacementSha256'], 'overlay base identity mismatch: ' + name)
        change = (changes or {}).get(name)
        expected_source = alias['sourceSha256']
        if change:
            require(change['input_sha256'] == expected_source, 'overlay derivation base mismatch: ' + name)
            expected_source = change['output_sha256']
        require(sha(original) == expected_source, 'overlay effective identity mismatch: ' + name)
        alias['sourceSha256'] = expected_source
        if alias['kind'] == 'declaration-extraction':
            text = '\n'.join(line for line in data.decode('utf-8').split('\n') if not line.startswith('import '))
            declarations = [part.strip() for part in re.split(r'(?=^(?:export |type |interface |const |let |function ))', text, flags=re.M) if part.strip()]
            require(declarations and all(part in original.decode('utf-8') for part in declarations), 'overlay declaration mismatch: ' + name)
        else:
            require(alias['kind'] == 'storage-boundary' and name in {'src/lib/db/core.ts', 'src/lib/db/settings.ts'}, 'overlay kind mismatch')
    return aliases


def apply_overlays(app, fixture, aliases):
    identities = {}
    for alias in aliases:
        target = app / alias['source']
        require(sha(target.read_bytes()) == alias['sourceSha256'], 'overlay original changed: ' + alias['source'])
        data = (fixture / alias['replacement']).read_bytes()
        target.write_bytes(data)
        identities[alias['source']] = {'originalSha256': alias['sourceSha256'], 'replacement': alias['replacement'], 'executedSha256': sha(data)}
    return identities


def approved_source(with_identity=False):
    raw = SOURCE.read_bytes()
    require(sha(raw) == ARCHIVE_SHA, 'source archive mismatch')
    names = set(ROUTES) | set(POLICY_SOURCES) | set(READ_CLOSURES) | {LIVE_ROUTE, 'src/lib/db/core.ts', 'src/lib/api/requireManagementAuth.ts', 'src/app/api/health/route.ts', 'src/proxy.ts'} | {a['source'] for a in json.loads((FIXTURE / 'alias-map.json').read_text())['aliases']}
    found = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            parts = safe_parts(member.name)
            if len(parts) < 2 or parts[0] != 'OmniRoute-v3.8.53':
                continue
            name = '/'.join(parts[1:])
            if name not in names:
                continue
            require(name not in found and member.isfile() and member.size <= 2 * 1024 * 1024, 'invalid source member: ' + name)
            data = archive.extractfile(member).read()
            require(len(data) == member.size, 'short source member: ' + name)
            found[name] = data
    require(set(found) == names, 'missing source identity member')
    with tempfile.TemporaryDirectory() as temporary:
        tree = Path(temporary) / 'source'
        identity = effective_source(SOURCE, ROOT, tree)
        found = {name: (tree / name).read_bytes() for name in names}
    return (found, identity) if with_identity else found



def provision(material):
    """Executed only in the baseline runner's isolated worker after materialization."""
    app, fixture = Path('/work/app'), Path('/work/fixture')
    archive_path = Path('/inputs/source.tar.gz')
    require(sha(archive_path.read_bytes()) == ARCHIVE_SHA, 'archive mismatch')
    identities = {}
    with tarfile.open(archive_path, 'r:gz') as archive:
        for name in ROUTES:
            member = archive.getmember('OmniRoute-v3.8.53/' + name)
            require(member.isfile() and member.size <= 2 * 1024 * 1024, 'invalid source member: ' + name)
            data = archive.extractfile(member).read()
            require(len(data) == member.size, 'short source member: ' + name)
            target = app / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                require(target.read_bytes() == data, 'materialized source mismatch: ' + name)
            else:
                target.write_bytes(data)
            identities[name] = sha(data)
    degradation_route = app / 'src/app/api/health/degradation/route.ts'
    original = degradation_route.read_bytes()
    control = (fixture / 'extracted/degradation-control.ts').read_bytes()
    put(app, 'src/app/api/health/degradation/fixture-control.ts', control)
    executed = b'import "./fixture-control";\n' + original
    degradation_route.write_bytes(executed)
    identities['src/app/api/health/degradation/route.ts'] = {'originalSha256': sha(original), 'executedSha256': sha(executed)}
    identities['src/domain/degradation.ts'] = {'originalSha256': identities['src/domain/degradation.ts'], 'executedSha256': sha((app / 'src/domain/degradation.ts').read_bytes())}
    package = json.loads((app / 'package.json').read_text())
    require(package['version'] == '3.8.53', 'source version mismatch')
    derivation = material.get('sourceDerivation')
    changes = json.loads((Path('/source-input') / derivation['record']).read_text())['changes'] if derivation else []
    aliases = overlay_plan(app, fixture, json.loads((fixture / 'source-manifest.json').read_text()), {item['path']: item for item in changes})
    declaration = ping_declaration((app / 'src/lib/db/core.ts').read_text())
    for name, data in overlay_bytes((fixture / 'backend/core.ts').read_bytes(), (fixture / 'backend/settings.ts').read_bytes(), declaration).items():
        (fixture / name).write_bytes(data)
    identities['src/lib/db/core.ts'] = sha((app / 'src/lib/db/core.ts').read_bytes())
    identities['src/lib/api/requireManagementAuth.ts'] = sha((app / 'src/lib/api/requireManagementAuth.ts').read_bytes())
    with tarfile.open(archive_path, 'r:gz') as archive:
        for name in POLICY_SOURCES:
            member = archive.getmember('OmniRoute-v3.8.53/' + name)
            require(member.isfile() and member.size <= 2 * 1024 * 1024, 'invalid policy source member: ' + name)
            identities[name] = sha(archive.extractfile(member).read())
    identities['src/app/api/health/route.ts'] = sha((app / 'src/app/api/health/route.ts').read_bytes())
    live_bytes = (app / LIVE_ROUTE).read_bytes()
    live_expected = json.loads((fixture / 'source-manifest.json').read_text())['additionalFiles'][LIVE_ROUTE]['sha256']
    require(sha(live_bytes) == live_expected, 'liveness source mismatch')
    identities[LIVE_ROUTE] = {'originalSha256': live_expected, 'executedSha256': sha(live_bytes)}
    proxy_bytes = (app / 'src/proxy.ts').read_bytes()
    proxy_expected = json.loads((fixture / 'source-manifest.json').read_text())['selectedFiles']['src/proxy.ts']['sha256']
    require(sha(proxy_bytes) == proxy_expected, 'proxy executed source mismatch')
    closure = read_closures(app, json.loads((fixture / 'source-manifest.json').read_text()))
    verify_flag_cache_fixture(closure['src/lib/db/featureFlags.ts'].decode(),
                              (fixture / 'extracted/feature-flag-cache.ts').read_text())
    for name, data in closure.items():
        (app / name).write_bytes(data)
        identities[name] = {'originalSha256': READ_CLOSURES[name], 'executedSha256': sha(data)}
    executed_overlays = apply_overlays(app, fixture, aliases)
    versions = {name: json.loads((app / 'node_modules' / name / 'package.json').read_text())['version'] for name in ('next', 'react', 'react-dom')}
    require(versions == {'next': '16.4.2', 'react': '19.2.8', 'react-dom': '19.2.8'}, 'runtime package mismatch')
    inputs = ('source-manifest.json', 'dependencies.json', 'runtime.json')
    identity = {
        'status': 'unreviewed-observation-not-qualification', 'sourceVersion': '3.8.53',
        'sourceCommit': COMMIT, 'archiveSha256': ARCHIVE_SHA, 'addedSourceSha256': identities,
        **{key: material[key] for key in ('sourceDerivation', 'effectiveTreeSha256') if key in material},
        'proxyIdentity': {'originalSha256': proxy_expected, 'executedSha256': sha(proxy_bytes)},
        'pingDeclarationSha256': sha(declaration.encode()),
        'sourceOverlaySha256': executed_overlays,
        'fixtureSha256': {str(p.relative_to(fixture)): sha(p.read_bytes()) for p in sorted(fixture.rglob('*')) if p.is_file() and '__pycache__' not in p.parts},
        'nodeSha256': sha(Path('/runtime/node').read_bytes()),
        'runtime': {'node': '24.17.0', **versions},
        'runtimeInputSha256': {name: sha((Path('/fixture-src') / name).read_bytes()) for name in inputs},
        'boundary': 'Actual Next default-bundler ingress and pinned handlers with disposable source overlays; source pingDb and cache SQL use node:sqlite against disposable file. Auth/settings storage remains bounded in-memory fixture; not production persistence, native DB adapter or full application.',
    }
    identity_path = Path('/work/data/pinned-ingress-identity.json')
    identity_path.write_text(json.dumps(identity, indent=2) + '\n')
    identity_path.chmod(0o600)

FAILURE_STAGES = ('preflight', 'materialize', 'provision', 'build', 'authHTTP', 'pinnedHTTP', 'coldLifecycle', 'warmLifecycle', 'export')
FAILURE_CLASSES = ('RuntimeError', 'CalledProcessError', 'TimeoutExpired', 'OSError', 'ValueError', 'KeyError', 'Other')
WORKER_STAGE = 'preflight'


class CandidateFailed(RuntimeError):
    def __init__(self, returncode):
        super().__init__('candidate command failed')
        self.returncode = returncode


def failure_class(exc):
    if isinstance(exc, (CandidateFailed, subprocess.CalledProcessError)):
        return 'CalledProcessError'
    if isinstance(exc, subprocess.TimeoutExpired):
        return 'TimeoutExpired'
    for cls in (RuntimeError, OSError, ValueError, KeyError):
        if isinstance(exc, cls):
            return cls.__name__
    return 'Other'


def failure_code(exc):
    code = getattr(exc, 'returncode', None) if isinstance(exc, (CandidateFailed, subprocess.CalledProcessError)) else None
    return code if type(code) is int and -255 <= code <= 255 and code != 0 else None


def worker_stage(stage):
    global WORKER_STAGE
    require(stage in FAILURE_STAGES[:-1], 'invalid worker stage')
    WORKER_STAGE = stage
    save(Path('/work/failure-state.json'), {'stage': stage, 'exceptionClass': None, 'returnCode': None})


def compiler_failure_signals(output):
    path = output / 'build.private'
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 2 * 1024**2:
        return []
    text = path.read_text(encoding='utf-8', errors='replace').lower()
    markers = {
        'module-not-found': ('module not found', 'cannot find module', "can't resolve", 'could not resolve'),
        'read-only-output': ('read-only file system', 'erofs'),
        'turbopack-panic': ('turbopack panic', 'turbopack internal error', 'fatal: an unexpected turbopack error'),
        'next-package-root': ('next.js package not found', 'next.js package could not be found', 'failed to find next.js package'),
        'configuration-load': ('failed to load next.config', 'error loading next.config'),
        'typescript-error': ('type error:', 'error ts'),
        'process-spawn': ('spawn eagain', 'spawn eperm', 'failed to spawn'),
    }
    signals = {name for name, values in markers.items() if any(value in text for value in values)}
    # Match diagnostic lines, not source excerpts or comments containing these words.
    if re.search(r'(?m)^[ \t]*(?:error:[ \t]*)?eacces[ \t]*:', text):
        signals.add('permission-denied')
    return sorted(signals)


def lifecycle_failure_signals(output, stage):
    """Map bounded private phase output to fixed, non-sensitive diagnostic categories."""
    phase = {'coldLifecycle': 'cold', 'warmLifecycle': 'warm'}.get(stage)
    if phase is None:
        return []
    path = output / (phase + '-lifecycle.private')
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 2 * 1024**2:
        return []
    text = path.read_text(encoding='utf-8', errors='replace').lower()
    markers = {
        'module-resolution': ('err_module_not_found', 'cannot find module', 'err_package_path_not_exported'),
        'worker-failure': ('health worker resolution mismatch', 'health worker result missing', 'database health worker is missing', 'database health worker failed', 'database health worker timed out', 'database health worker exited without a result', 'database health worker communication failed'),
        'health-check-in-progress': ('database health check already in progress',),
        'migration-safety': ('migrationsafetyaborterror',),
        'database-initialization': ('database is not initialized', 'database not initialized', 'sqlite_error', 'sqlite_cantopen', 'sqlite_busy'),
        'read-only-filesystem': ('erofs:', 'read-only file system'),
        'permission-denied': ('eacces:', 'eperm:'),
        'settings-persistence': ('settings persistence failed',),
        'database-lifecycle': ('cold database already exists', 'warm database missing'),
        'phase-isolation': ('lifecycle isolation or phase mismatch',),
        'unsettled-top-level-await': ('warning: unsettled top-level await', 'warning: detected unsettled top-level await'),
        'migration-metadata': ('migration metadata missing', 'empty migration ledger'),
        'driver-or-ping': ('core driver or ping failed',),
    }
    return sorted(name for name, patterns in markers.items() if any(pattern in text for pattern in patterns))


LIFECYCLE_CHECKPOINTS = frozenset(('before-files', 'before-initialize', 'after-initialize',
    'before-worker', 'after-worker', 'before-settings-read', 'after-settings-read',
    'before-settings-write', 'after-settings-write', 'before-settings-verify',
    'after-settings-verify', 'before-close', 'after-close'))
MODULE_ERROR_CODES = frozenset(('MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND',
    'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_UNSUPPORTED_DIR_IMPORT'))


def lifecycle_diagnostics(output, stage):
    """Export only checkpoint and known public module identities, never child messages."""
    phase = {'coldLifecycle': 'cold', 'warmLifecycle': 'warm'}.get(stage)
    result = {'checkpoint': None, 'moduleErrors': [], 'moduleErrorCodes': []}
    if phase is None:
        return result
    try:
        progress = bounded_json(output / 'lifecycle-progress.json')
        if (isinstance(progress, dict) and set(progress) == {'phase', 'stage'}
                and progress['phase'] == phase and progress['stage'] in LIFECYCLE_CHECKPOINTS):
            result['checkpoint'] = progress['stage']
    except (OSError, ValueError, TypeError, RuntimeError):
        pass
    path = output / (phase + '-lifecycle.private')
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 2 * 1024**2:
        return result
    try:
        manifest = bounded_json(FIXTURE / 'dependencies.json')
        packages = {item['name'] for item in manifest['packages']}
        package = bounded_json(output / 'app/package.json')
        for key in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
            dependencies = package.get(key, {})
            if isinstance(dependencies, dict):
                packages.update(dependencies)
        sources = bounded_json(FIXTURE / 'source-manifest.json')
        names = set(sources['selectedFiles']) | set(sources['additionalFiles'])
        paths = {'/work/app/' + name for name in names
                 if isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_./@+-]{1,512}', name)
                 and not name.startswith('/') and all(part not in ('', '.', '..') for part in name.split('/'))}
        paths.update(('/work/app/src/lib/db/pinned-lifecycle.mjs', '/work/app/src/lib/db/healthCheckWorker.js'))
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        return result
    text = path.read_text(encoding='utf-8', errors='replace')
    targets = re.findall(r"(?:Cannot find (?:module|package)|Package subpath) ['\"]([^'\"\r\n]{1,512})['\"]", text)
    codes = sorted({code for code in MODULE_ERROR_CODES if re.search(r'(?<![A-Z_])' + code + r'(?![A-Z_])', text)})
    modules = set()
    for target in targets:
        if target.startswith('file://'):
            target = target[7:]
        if target in paths or target in packages or target in ('node:sqlite', 'bun:sqlite'):
            modules.add(target)
    result['moduleErrors'] = sorted(modules)[:16]
    result['moduleErrorCodes'] = codes
    return result


def write_failure(output, hashes, stage, exception_class, returncode):
    require(stage in FAILURE_STAGES and exception_class in FAILURE_CLASSES, 'invalid failure classification')
    require(returncode is None or (type(returncode) is int and -255 <= returncode <= 255 and returncode != 0), 'invalid failure return code')
    require(input_hashes() == hashes, 'input bytes changed during run')
    tracked = sha(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode())
    artifact = {'schemaVersion': 1, 'classification': 'research-only-not-qualification',
        'stage': stage, 'exceptionClass': exception_class,
        'exitCode': returncode if returncode is not None and returncode > 0 else None,
        'signal': -returncode if returncode is not None and returncode < 0 else None,
        'sourceCommit': COMMIT, 'sourceArchiveSha256': ARCHIVE_SHA, 'nodeSha256': NODE_SHA,
        'trackedInputsSha256': tracked}
    if stage == 'build':
        artifact['compilerSignals'] = compiler_failure_signals(output)
    if stage in ('coldLifecycle', 'warmLifecycle'):
        artifact['lifecyclePhase'] = 'cold' if stage == 'coldLifecycle' else 'warm'
        artifact['lifecycleSignals'] = lifecycle_failure_signals(output, stage)
        artifact['lifecycleDiagnostics'] = lifecycle_diagnostics(output, stage)
    fd = os.open(output.parent / 'failure.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as destination:
        json.dump(artifact, destination, indent=2)
        destination.write('\n')


def worker_failure_state(output):
    path = output / 'failure-state.json'
    try:
        state = bounded_json(path)
        require(set(state) == {'stage', 'exceptionClass', 'returnCode'}, 'invalid failure state')
        stage, cls, code = state['stage'], state['exceptionClass'], state['returnCode']
        require(stage in FAILURE_STAGES[:-1] and (cls is None or cls in FAILURE_CLASSES), 'invalid failure state')
        require(code is None or (type(code) is int and -255 <= code <= 255 and code != 0), 'invalid failure state')
        return stage, cls, code
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        return 'preflight', None, None

def run_bounded(command, log_path, deadline, env):
    child = subprocess.Popen(command, cwd='/work/app', env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    count = 0
    try:
        with log_path.open('xb') as output:
            while selector.get_map():
                require(time.monotonic() < deadline, 'wall deadline exceeded')
                disk_usage(Path('/work'))
                for key, _ in selector.select(timeout=0.2):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    count += len(data)
                    require(count <= 2 * 1024**2, 'output limit exceeded')
                    output.write(data)
        code = child.wait(timeout=5)
        if code != 0:
            raise CandidateFailed(code)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)


def validate_lifecycle_log(path):
    """Reject caught runtime reload failures in the bounded process output."""
    require(path.stat().st_size <= 2 * 1024**2, 'lifecycle log exceeds output limit')
    require(b'[HOT_RELOAD]' not in path.read_bytes(), 'runtime settings reload warning')


def core_lifecycle(material, deadline):
    """Observe direct source DB initialization twice, without ingress overlays."""
    app = Path('/work/app')
    fixture = Path('/work/fixture/database-lifecycle.mjs')
    entry = app / 'src/lib/db/pinnedLifecycleFixture.mjs'
    require(not entry.exists(), 'lifecycle fixture collides with source')
    shutil.copyfile(fixture, entry)
    source = material['configSupportSha256']
    migrations = {name: value for name, value in source.items() if name.startswith('src/lib/db/migrations/') and name.endswith('.sql')}
    worker_source = 'src/lib/db/healthCheckWorker.ts'
    recipe = 'scripts/build/colocate-standalone.mjs'
    require(len(migrations) == 222 and worker_source in source and recipe in source, 'pinned migration or worker source closure missing')
    env = {'PATH': '/runtime', 'HOME': '/work/home', 'TMPDIR': '/work/tmp', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'NODE_ENV': 'production', 'DATA_DIR': '/work/data', 'INGRESS_APPROVED_SANDBOX': '1'}
    esbuild = '/work/app/node_modules/@esbuild/linux-x64/bin/esbuild'
    common = ['--bundle', '--platform=node', '--packages=external', '--format=esm']
    worker_stage('build')
    run_bounded([esbuild, worker_source, *common, '--outfile=src/lib/db/healthCheckWorker.js'], Path('/work/worker-build.private'), deadline, env)
    runner_arguments = ['/runtime/node', '--import', 'tsx/esm', '/work/app/src/lib/db/pinnedLifecycleFixture.mjs']
    identity = {'sourceArchiveSha256': ARCHIVE_SHA, 'nodeSha256': NODE_SHA, 'sourceFilesSha256': source, 'migrationSqlSha256': migrations, 'workerSourceSha256': source[worker_source], 'productionRecipeSha256': source[recipe], 'workerBuildArguments': common, 'workerOutputSha256': file_sha(app / 'src/lib/db/healthCheckWorker.js'), 'runnerSourceSha256': file_sha(fixture), 'runnerArguments': runner_arguments}
    identity.update({key: material[key] for key in ('sourceDerivation', 'effectiveTreeSha256') if key in material})
    save(Path('/work/core-identity.json'), identity)
    isolate = ['/runtime/bwrap', '--cap-drop', 'ALL', '--die-with-parent', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--ro-bind', '/work/app', '/work/app', '--ro-bind', '/work/fixture', '/work/fixture', '--chdir', '/work/app', '--']
    worker_stage('build')
    import_check = """import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
for (const [name, version, entry] of [['tsx', '4.23.13', 'tsx/esm'], ['sql.js', '1.14.2', 'sql.js']]) {
  const root = `/work/app/node_modules/${name}`;
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  if (pkg.name !== name || pkg.version !== version || !realpathSync(fileURLToPath(import.meta.resolve(entry))).startsWith(realpathSync(root) + '/')) throw new Error(`unexpected ${name} resolution`);
  await import(entry);
}"""
    run_bounded(isolate + ['/runtime/node', '--input-type=module', '-e', import_check], Path('/work/startup-imports.private'), deadline, env)
    run_bounded(isolate + ['/runtime/node', '--import', 'tsx/esm', '--test', 'tests/unit/db-async-fresh-startup.test.ts'], Path('/work/startup-regression.private'), deadline, env)
    for phase in ('cold', 'warm'):
        worker_stage('coldLifecycle' if phase == 'cold' else 'warmLifecycle')
        log = Path('/work/' + phase + '-lifecycle.private')
        run_bounded(isolate + runner_arguments + [phase], log, deadline, env)
        validate_lifecycle_log(log)
    save(Path('/work/result.json'), {'status': 'research-observed', 'qualification': False, 'scenario': 'actual-core-cold-warm'})


def export_core_lifecycle(output, hashes):
    """Export only bounded, validated lifecycle facts, never database contents."""
    cold = bounded_json(output / 'cold-lifecycle.json')
    warm = bounded_json(output / 'warm-lifecycle.json')
    identity = bounded_json(output / 'core-identity.json')
    observations = []
    for phase, value in (('cold', cold), ('warm', warm)):
        validate_lifecycle_log(output / (phase + '-lifecycle.private'))
        require(isinstance(value, dict) and value.get('phase') == phase and value.get('driver') == 'node:sqlite'
                and value.get('ping') is True and value.get('healthWorker') is True
                and type(value.get('healthy')) is bool and value.get('settingsMarker') == 'cold-written'
                and value.get('runtimeSettingApplied') is (phase == 'cold'), 'lifecycle observations incomplete')
        tables, migrations = value.get('tables'), value.get('migrations')
        require(isinstance(tables, list) and 0 < len(tables) <= 4096 and all(isinstance(x, str) and re.fullmatch(r'[A-Za-z0-9_]{1,128}', x) for x in tables)
                and '_omniroute_migrations' in tables and 'db_meta' in tables, 'invalid table observation')
        require(isinstance(migrations, list) and 0 < len(migrations) <= 4096 and all(isinstance(x, dict) and set(x) == {'version', 'name'} and isinstance(x['version'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', x['version']) and isinstance(x['name'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', x['name']) for x in migrations), 'invalid migration observation')
        for key in ('before', 'after'):
            entries = value.get(key)
            require(isinstance(entries, list) and len(entries) <= 4096 and all(isinstance(x, dict) and isinstance(x.get('name'), str) and x.get('kind') in ('file', 'directory') for x in entries), 'invalid file observation')
        existed = any(x['name'] == 'storage.sqlite' and x['kind'] == 'file' for x in value['before'])
        require(existed == (phase == 'warm') and any(x['name'] == 'storage.sqlite' and x['kind'] == 'file' for x in value['after']), 'database lifecycle mismatch')
        observations.append({'phase': phase, 'driver': 'node:sqlite', 'ping': True, 'healthWorker': True, 'healthy': value['healthy'], 'settingsPersisted': True, 'runtimeSettingApplied': phase == 'cold', 'hotReloadFailure': False, 'databaseExistedBefore': existed, 'tableCount': len(tables), 'migrationCount': len(migrations), 'tableSha256': sha(json.dumps(tables, separators=(',', ':'), ensure_ascii=False).encode()), 'migrationSha256': sha(json.dumps(migrations, separators=(',', ':'), ensure_ascii=False).encode())})
    require(cold['migrations'] == warm['migrations'] and cold['tables'] == warm['tables'], 'warm lifecycle differs')
    require(isinstance(identity, dict) and identity.get('sourceArchiveSha256') == ARCHIVE_SHA and identity.get('nodeSha256') == NODE_SHA, 'lifecycle identity mismatch')
    expected_source = effective_source_identities(SOURCE)
    require(all(identity.get(k) == v for k, v in expected_source.items()) and all(k in expected_source or k not in identity for k in ('sourceDerivation', 'effectiveTreeSha256')), 'lifecycle effective source mismatch')
    source, migrations = identity.get('sourceFilesSha256'), identity.get('migrationSqlSha256')
    require(isinstance(source, dict) and 0 < len(source) <= 50000 and all(isinstance(k, str) and 0 < len(k) <= 512 and not any(ord(c) < 32 for c in k) and isinstance(v, str) and re.fullmatch(r'[0-9a-f]{64}', v) for k, v in source.items()), 'invalid source identities')
    require(isinstance(migrations, dict) and migrations == {k: v for k, v in source.items() if k.startswith('src/lib/db/migrations/') and k.endswith('.sql')} and len(migrations) == 222, 'invalid migration identities')
    worker_source, recipe = 'src/lib/db/healthCheckWorker.ts', 'scripts/build/colocate-standalone.mjs'
    require(identity.get('workerSourceSha256') == source.get(worker_source) and worker_source in source and identity.get('productionRecipeSha256') == source.get(recipe) and recipe in source, 'worker identity mismatch')
    arguments = ['--bundle', '--platform=node', '--packages=external', '--format=esm']
    runner_arguments = ['/runtime/node', '--import', 'tsx/esm', '/work/app/src/lib/db/pinnedLifecycleFixture.mjs']
    require(identity.get('workerBuildArguments') == arguments and identity.get('runnerArguments') == runner_arguments and 'runnerOutputSha256' not in identity and all(isinstance(identity.get(k), str) and re.fullmatch(r'[0-9a-f]{64}', identity[k]) for k in ('workerOutputSha256', 'runnerSourceSha256')), 'invalid build identity')
    public_identity = {k: identity[k] for k in ('sourceArchiveSha256', 'nodeSha256', 'workerSourceSha256', 'productionRecipeSha256', 'workerBuildArguments', 'workerOutputSha256', 'runnerSourceSha256', 'runnerArguments')}
    public_identity.update(expected_source)
    public_identity['sourceFilesManifestSha256'] = sha(json.dumps(source, sort_keys=True, separators=(',', ':')).encode())
    public_identity['migrationSqlManifestSha256'] = sha(json.dumps(migrations, sort_keys=True, separators=(',', ':')).encode())
    public_identity['sourceFileCount'] = len(source)
    public_identity['migrationSqlCount'] = len(migrations)
    export = output / 'export'
    export.mkdir(mode=0o700)
    save(export / 'core-lifecycle.json', {'status': 'research-observed', 'qualification': False, 'boundary': 'Direct pinned core and settings in two isolated Node processes; no HTTP, authorization, packaged application or operation qualification.', 'inputSha256': hashes, 'identity': public_identity, 'isolation': {'network': 'private-loopback-only', 'capabilities': 'dropped', 'source': 'read-only', 'processes': 'separate-cold-warm', 'startupRegressions': 'passed'}, 'cold': observations[0], 'warm': observations[1]})


def worker(real_core=False):
    worker_stage('preflight')
    require(Path.cwd() == Path('/work/app'), 'unexpected workspace')
    require(Path('/limits/memory.max').read_text().strip() == str(MEMORY), 'memory limit unavailable')
    require(0 < len(os.sched_getaffinity(0)) <= 2, 'CPU limit unavailable')
    original = json.loads(Path('/work/host-namespaces.json').read_text())
    actual = {name: os.readlink('/proc/self/ns/' + name) for name in original}
    require(all(actual[name] != original[name] for name in actual), 'namespace isolation unavailable')
    require(not any(Path('/home').iterdir()) and not Path('/etc/passwd').exists(), 'host home or configuration visible')
    require(set(os.environ) <= {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PWD'}, 'unexpected inherited environment')
    require(file_sha(Path('/runtime/node')) == NODE_SHA, 'runtime identity mismatch')
    subprocess.run(['/usr/bin/ip', 'link', 'set', 'lo', 'up'], check=True, timeout=10)
    interfaces = json.loads(subprocess.check_output(['/usr/bin/ip', '-j', 'link', 'show'], timeout=10))
    require({x['ifname'] for x in interfaces} == {'lo'}, 'external network interface visible')
    save(Path('/work/preflight.json'), {'namespaces': actual, 'memoryMax': MEMORY, 'cpuAffinity': sorted(os.sched_getaffinity(0)), 'network': 'private-loopback-only', 'mountInfo': Path('/proc/self/mountinfo').read_text(), 'environmentKeys': sorted(os.environ), 'nodeSha256': NODE_SHA})
    deadline = time.monotonic() + 540
    worker_stage('materialize')
    material = materialize(real_core)
    if real_core:
        return core_lifecycle(material, deadline)
    worker_stage('provision')
    provision(material)
    state = {'bypass': 'disabled', 'settings': {'requireLogin': True, 'password': 'fixture-configured', 'setupComplete': True}, 'tokens': []}
    save(Path('/work/data/state.json'), state)
    Path('/work/data/events.jsonl').write_text('')
    env = {'PATH': '/runtime', 'HOME': '/work/home', 'TMPDIR': '/work/tmp', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1', 'OMNIROUTE_BUILDING': '1', 'DATA_DIR': '/work/data', 'INGRESS_STATE_FILE': '/work/data/state.json', 'INGRESS_EVENT_FILE': '/work/data/events.jsonl', 'JWT_SECRET': 'research-only-jwt-secret-32-byte-minimum'}
    # Keep source, overlay and exact installed dependency bytes read-only while
    # allowing only Next's and the source plugins' owned output directories.
    isolate = ['/runtime/bwrap', '--cap-drop', 'ALL', '--die-with-parent', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--ro-bind', '/work/app', '/work/app', '--bind', '/work/app/.build', '/work/app/.build', '--bind', '/work/app/.source', '/work/app/.source', '--bind', '/work/app/next-env.d.ts', '/work/app/next-env.d.ts', '--ro-bind', '/work/fixture', '/work/fixture', '--chdir', '/work/app', '--']
    worker_stage('build')
    run_bounded(isolate + ['/runtime/node', '/work/app/node_modules/next/dist/bin/next', 'build'], Path('/work/build.private'), deadline, env)
    material['webpackDeviation'] = False
    material['bundler'] = 'next-default'
    save(Path('/work/materialization.json'), material)
    env['INGRESS_APPROVED_SANDBOX'] = '1'
    worker_stage('authHTTP')
    run_bounded(isolate + ['/runtime/node', '/work/fixture/driver.mjs'], Path('/work/http.private'), deadline, env)
    worker_stage('pinnedHTTP')
    run_bounded(isolate + ['/runtime/node', '/work/fixture/pinned-ingress-driver.mjs'], Path('/work/pinned-http.private'), deadline, env)
    save(Path('/work/result.json'), {'status': 'research-observed', 'qualification': False, 'materialization': material})


AUTH_CASES = (
    ('default-bypass-health', 'source-default', '/api/health', 'none', 200),
    ('disabled-bypass-health', 'disabled', '/api/health', 'none', 200),
    ('default-bypass-management-denied', 'source-default', '/api/ingress-control', 'none', 401),
    ('disabled-bypass-management-denied', 'disabled', '/api/ingress-control', 'none', 401),
    ('session-allowed', 'disabled', '/api/ingress-control', 'valid-session', 200),
    ('access-allowed', 'disabled', '/api/ingress-control', 'valid-admin-token', 200),
    ('access-invalid', 'disabled', '/api/ingress-control', 'unknown-token', 401),
    ('access-expired', 'disabled', '/api/ingress-control', 'expired-admin-token', 401),
    ('access-revoked', 'disabled', '/api/ingress-control', 'revoked-admin-token', 401),
    ('access-backend-error', 'disabled', '/api/ingress-control', 'admin-token-backend-error', 503),
    ('sync-valid', 'disabled', '/api/providers/fixture/models', 'valid-internal-sync', 200),
    ('sync-invalid', 'disabled', '/api/providers/fixture/models', 'invalid-internal-sync', 401),
)


def bounded_json(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 2 * 1024 * 1024, 'missing or oversized observation input')
    return json.loads(path.read_text(encoding='utf-8'))


def input_hashes():
    declared = bounded_json(ROOT / 'test/pinned-ingress.test.ts.inputs.json')
    require(set(declared) == {'schemaVersion', 'files'} and declared['schemaVersion'] == 1 and isinstance(declared['files'], list) and 0 < len(declared['files']) <= 256, 'invalid input declaration')
    names = ['test/pinned-ingress.test.ts', 'test/pinned-ingress.test.ts.inputs.json'] + declared['files']
    require(len(names) == len(set(names)), 'duplicate input declaration')
    hashes = {}
    for name in names:
        require(isinstance(name, str) and not name.startswith('/') and '\\' not in name and all(part not in ('', '.', '..', '.git', '.agents', 'node_modules') for part in name.split('/')), 'invalid input path')
        path = ROOT / name
        require(path.is_file() and not path.is_symlink() and path.resolve() == path, 'unsafe input file')
        hashes[name] = file_sha(path)
    fixture_names = {p.relative_to(ROOT).as_posix() for p in FIXTURE.rglob('*') if p.is_file() and '__pycache__' not in p.parts}
    require(fixture_names == {name for name in hashes if name.startswith('test/fixtures/pinned-ingress/')}, 'fixture input closure mismatch')
    return hashes


def auth_state_sha(name, bypass):
    token = '_'.join(('oma', 'live', 'fixture-secret'))
    row = {'id': 'fixture-token', 'token_hash': sha(token.encode()), 'token_prefix': 'oma_live_resea', 'name': 'fixture', 'scope': 'admin', 'created_at': '2025-01-01T00:00:00.000Z', 'last_used_at': None, 'expires_at': None, 'revoked_at': None}
    if name == 'access-expired':
        row['expires_at'] = '2020-01-01T00:00:00.000Z'
    if name == 'access-revoked':
        row['revoked_at'] = '2020-01-01T00:00:00.000Z'
    state = {'bypass': bypass, 'syncToken': 'research-only-internal-sync-token', 'settings': {'requireLogin': True, 'password': 'fixture-configured', 'setupComplete': True}, 'tokens': [row] if name in ('access-allowed', 'access-expired', 'access-revoked', 'access-backend-error') else [], 'failTokenRead': name == 'access-backend-error'}
    if name == 'disabled-bypass-health':
        state['ipFilter'] = {'enabled': True, 'mode': 'blacklist', 'blacklist': ['198.51.100.23'], 'whitelist': []}
    return sha(json.dumps(state, separators=(',', ':'), ensure_ascii=False).encode())


def validate_public_health(response):
    body = json.loads(response['body'])
    require(response['status'] == 200 and response['routeClass'] == 'PUBLIC' and response['requestIdUuid'] is True, 'public health status or stamp mismatch')
    require(set(body) == {'status', 'timestamp'} and body['status'] == 'ok' and isinstance(body['timestamp'], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', body['timestamp']), 'public health body mismatch')
    timestamp = datetime.strptime(body['timestamp'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc).timestamp() * 1000
    require(type(response['started']) is int and type(response['ended']) is int and response['started'] <= timestamp <= response['ended'] and 0 <= response['ended'] - response['started'] <= 10000, 'public health timestamp outside request window')
    require(response['cacheControl'] == 'no-store, no-cache, must-revalidate' and response['contentType'] == 'application/json', 'public health headers mismatch')


def validate_public_cors(response, origin):
    require(response['allowOrigin'] == origin and response['allowCredentials'] is None, 'public CORS origin mismatch')
    vary = {part.strip().lower() for part in (response['vary'] or '').split(',')}
    require(('origin' in vary) == (origin is not None), 'public CORS vary mismatch')
    require(response['allowMethods'] == 'GET, POST, PUT, DELETE, PATCH, OPTIONS' and response['allowHeaders'] == 'Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, X-OmniRoute-Lease-Owner, X-OmniRoute-Lease-Generation, x-internal-test, accept', 'public CORS headers mismatch')

def validate_public_health_evidence(auth):
    observed = next(row for row in auth['results'] if row['name'] == 'disabled-bypass-health')
    require(any(event.get('event') == 'ip-filter:read' for event in observed['requestEvents']), 'public IP filter config read missing')
    validate_public_health(observed['response'])
    during, after = observed['draining']['during'], observed['draining']['after']
    body = json.loads(during['body'])
    require(during['status'] == 503 and during['routeClass'] == 'PUBLIC' and during['contentType'] == 'application/json' and during['retryAfter'] == '5' and during['requestIdUuid'] is True and during['correlationMatchesRequestId'] is True, 'public drain headers mismatch')
    require(body == {'error': {'code': 'SERVICE_UNAVAILABLE', 'message': 'Server is shutting down', 'correlation_id_present': True}, 'errorKeys': ['code', 'correlation_id', 'message'], 'bodyKeys': ['error']}, 'public drain body mismatch')
    validate_public_health(after)
    cors = observed['cors']
    require(set(cors) == {'allowed', 'unlisted'}, 'public CORS cases incomplete')
    for name, origin in (('allowed', 'https://allowed.example'), ('unlisted', None)):
        response = cors[name]
        validate_public_health(response)
        validate_public_cors(response, origin)
    forwarded = observed['forwardedIp']
    require(set(forwarded) == {'denied', 'recovered'}, 'forwarded IP cases incomplete')
    denied, recovered = forwarded['denied'], forwarded['recovered']
    require(denied['status'] == 403 and denied['routeClass'] == 'PUBLIC' and denied['requestIdUuid'] is True and denied['contentType'] == 'application/json', 'forwarded IP denial headers mismatch')
    require(isinstance(denied['body'], str) and len(denied['body']) <= 65536 and json.loads(denied['body']) == {'error': 'IP blacklisted'}, 'forwarded IP denial body mismatch')
    validate_public_cors(denied, 'https://allowed.example')
    validate_public_health(recovered)
    validate_public_cors(recovered, 'https://allowed.example')
    return {'method': 'GET', 'path': '/api/health', 'anonymous': True, 'status': 200, 'bodyKeys': ['status', 'timestamp'], 'timestampFormatAndRequestWindowValid': True, 'cacheControl': 'no-store, no-cache, must-revalidate', 'contentType': 'application/json', 'routeClass': 'PUBLIC', 'requestIdUuid': True, 'drain': {'status': 503, 'code': 'SERVICE_UNAVAILABLE', 'message': 'Server is shutting down', 'requestIdUuid': True, 'correlationMatchesRequestId': True, 'retryAfter': '5', 'contentType': 'application/json', 'routeClass': 'PUBLIC', 'recoveryStatus': 200}, 'cors': {'configuredAllowedOrigin': 'https://allowed.example', 'allowedOriginEchoed': True, 'unlistedOriginOmitted': True, 'credentialsOmitted': True}}


def validate_degradation(row, events):
    denied, invalid = row['denied'], row['invalid']
    require(denied['status'] in (401, 403) and invalid['status'] in (401, 403) and denied['routeClass'] == invalid['routeClass'] == 'MANAGEMENT', 'degradation authorization mismatch')
    require([e.get('event') for e in events if str(e.get('event', '')).startswith('degradation:')] == ['degradation:populate', 'degradation:recover'], 'degradation control evidence mismatch')
    empty = {'active': False, 'summary': {'full': 0, 'reduced': 0, 'minimal': 0, 'default': 0}, 'features': []}
    summary = {'full': 1, 'reduced': 1, 'minimal': 0, 'default': 1}
    for name in ('empty', 'populated', 'summary', 'falseSummary', 'capitalSummary', 'recovery'):
        require(row[name]['status'] == 200 and row[name]['routeClass'] == 'MANAGEMENT', 'degradation status or route class mismatch: ' + name)
    require(row['empty']['body'] == empty, 'degradation empty mismatch')
    body = row['populated']['body']
    require(set(body) == {'active', 'summary', 'features'} and body['active'] is True and body['summary'] == summary, 'degradation populated mismatch')
    features = body['features']
    require(isinstance(features, list) and len(features) == 3, 'degradation feature count mismatch')
    expected = [('fixture-default', 'default', 'Safe default', 'Error: primary unavailable → Error: fallback unavailable'), ('fixture-reduced', 'reduced', 'Reduced capability', 'primary unavailable'), ('fixture-full', 'full', 'Full capability', '')]
    for feature, (name, level, capability, reason) in zip(features, expected):
        require(set(feature) == {'feature', 'level', 'capability', 'reason', 'since'} and (feature['feature'], feature['level'], feature['capability'], feature['reason']) == (name, level, capability, reason) and isinstance(feature['since'], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', feature['since']), 'degradation feature mismatch')
    require(row['summary']['body'] == {'summary': summary, 'isDegraded': True} and row['falseSummary']['body'] == body and row['capitalSummary']['body'] == body, 'degradation query mismatch')
    recovery = row['recovery']['body']
    require(set(recovery) == {'active', 'summary', 'features'} and recovery['active'] is False and recovery['summary'] == {'full': 3, 'reduced': 0, 'minimal': 0, 'default': 0} and len(recovery['features']) == 3, 'degradation recovery mismatch')
    for feature, name in zip(recovery['features'], ('fixture-full', 'fixture-reduced', 'fixture-default')):
        require(set(feature) == {'feature', 'level', 'capability', 'reason', 'since'} and (feature['feature'], feature['level'], feature['capability'], feature['reason']) == (name, 'full', 'Full capability', '') and isinstance(feature['since'], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', feature['since']), 'degradation recovery feature mismatch')
    return {'method': 'GET', 'path': '/api/health/degradation', 'routeClass': 'MANAGEMENT', 'anonymousStatus': denied['status'], 'invalidCredentialStatus': invalid['status'], 'empty': {'status': 200, 'summary': empty['summary']}, 'populated': {'status': 200, 'summary': summary, 'levels': [entry['level'] for entry in features]}, 'summaryTrue': {'status': 200, 'bodyKeys': ['isDegraded', 'summary']}, 'summaryFalseAndCapitalTrueReturnFullReport': True, 'recovery': {'status': 200, 'summary': recovery['summary'], 'active': False}, 'handlerFailure': 'unobserved'}


def export_observations(output, hashes):
    """Produce an allowlisted research artifact only after the complete isolated run."""
    result = bounded_json(output / 'result.json')
    material = bounded_json(output / 'materialization.json')
    preflight = bounded_json(output / 'preflight.json')
    host = bounded_json(output / 'host-namespaces.json')
    auth = bounded_json(output / 'data/observations.json')
    ingress = bounded_json(output / 'data/pinned-ingress-observations.json')
    identity = ingress['identity']
    require(result['status'] == 'research-observed' and result['qualification'] is False and result['materialization'] == material, 'incomplete run')
    require(material['archiveSha256'] == ARCHIVE_SHA and material['webpackDeviation'] is False and material['bundler'] == 'next-default' and material['selectedSourceFiles'] == 509, 'materialization mismatch')
    require(identity['sourceCommit'] == COMMIT and identity['sourceVersion'] == '3.8.53' and identity['archiveSha256'] == ARCHIVE_SHA and identity['nodeSha256'] == NODE_SHA, 'source identity mismatch')
    require(identity['runtime'] == {'node': '24.17.0', 'next': '16.4.2', 'react': '19.2.8', 'react-dom': '19.2.8'}, 'runtime mismatch')
    source_identity = effective_source_identities(SOURCE)
    require(all(material.get(key) == value and identity.get(key) == value for key, value in source_identity.items()) and all(key in source_identity or (key not in material and key not in identity) for key in ('sourceDerivation', 'effectiveTreeSha256')), 'effective source identity mismatch')
    source = approved_source()
    identity_names = set(ROUTES) | set(POLICY_SOURCES) | {'src/lib/db/core.ts', 'src/lib/api/requireManagementAuth.ts', 'src/app/api/health/route.ts'}
    source_hashes = {name: sha(source[name]) for name in identity_names}
    for name in ('src/app/api/health/degradation/route.ts', 'src/domain/degradation.ts'):
        data = source[name]
        executed = b'import "./fixture-control";\n' + data if name.endswith('/route.ts') else data
        source_hashes[name] = {'originalSha256': sha(data), 'executedSha256': sha(executed)}
    live_sha = sha(source[LIVE_ROUTE])
    source_hashes[LIVE_ROUTE] = {'originalSha256': live_sha, 'executedSha256': live_sha}
    declaration = ping_declaration(source['src/lib/db/core.ts'].decode('utf-8'))
    with tempfile.TemporaryDirectory() as temporary:
        app = Path(temporary)
        for name in READ_CLOSURES:
            put(app, name, source[name])
        manifest_for_closures = json.loads((FIXTURE / 'source-manifest.json').read_bytes())
        closure = read_closures(app, manifest_for_closures)
    source_hashes.update({name: {'originalSha256': READ_CLOSURES[name], 'executedSha256': sha(data)} for name, data in closure.items()})
    require(identity['addedSourceSha256'] == source_hashes and identity['pingDeclarationSha256'] == sha(declaration.encode()), 'source identity mismatch')
    manifest_bytes = (FIXTURE / 'source-manifest.json').read_bytes()
    require(sha(manifest_bytes) == hashes['test/fixtures/pinned-ingress/source-manifest.json'], 'manifest bytes changed')
    manifest = json.loads(manifest_bytes)
    proxy_sha = sha(source['src/proxy.ts'])
    require(manifest['selectedFiles']['src/proxy.ts']['sha256'] == proxy_sha and material['configSupportSha256']['src/proxy.ts'] == proxy_sha, 'proxy source mismatch')
    require(manifest['additionalFiles'][LIVE_ROUTE]['sha256'] == live_sha and material['configSupportSha256'][LIVE_ROUTE] == live_sha, 'liveness source mismatch')
    require(identity['proxyIdentity'] == {'originalSha256': proxy_sha, 'executedSha256': proxy_sha}, 'proxy executed identity mismatch')
    source_hashes['src/proxy.ts'] = proxy_sha
    namespaces = preflight['namespaces']
    require(set(host) == set(namespaces) == {'user', 'mnt', 'net', 'pid'} and all(host[k] != namespaces[k] for k in host), 'namespace evidence mismatch')
    require(preflight['memoryMax'] == MEMORY and 0 < len(preflight['cpuAffinity']) <= 2 and preflight['network'] == 'private-loopback-only' and preflight['nodeSha256'] == NODE_SHA, 'isolation evidence mismatch')
    require(set(preflight['environmentKeys']) <= {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PWD'}, 'environment evidence mismatch')
    require(auth['fixture'] == 'research-only' and len(auth['results']) == len(AUTH_CASES), 'authentication cases incomplete')
    cases = []
    for observed, (name, bypass, path, credential, status) in zip(auth['results'], AUTH_CASES):
        response = observed['response']
        route = 'PUBLIC' if path == '/api/health' else 'MANAGEMENT'
        require(observed['name'] == name and observed['stateSha256'] == auth_state_sha(name, bypass) and response['status'] == status and response['routeClass'] == route, 'authentication outcome mismatch')
        body = response['body']
        require(isinstance(body, str) and len(body) <= 65536, 'authentication body invalid')
        success_marker = '"status":"ok"' in body or 'management-handler-reached' in body
        usage_stamp = any(e.get('event') == 'access-token:usage-stamp' for e in observed['events'])
        require(success_marker == (status == 200), 'authentication marker mismatch')
        if status == 200:
            require(('"status":"ok"' if route == 'PUBLIC' else 'management-handler-reached') in body, 'authentication marker missing')
        require(usage_stamp == (name == 'access-allowed'), 'authentication usage stamp mismatch')
        require(not any(str(e.get('event', '')).startswith('unsupported:') for e in observed['events']), 'unsupported authentication boundary')
        cases.append({'name': name, 'input': {'method': 'GET', 'path': path, 'bypass': bypass, 'credential': credential, 'requireLogin': True, 'setupComplete': True}, 'observed': {'status': response['status'], 'routeClass': response['routeClass'], 'successMarkerPresent': success_marker, 'usageStampObserved': usage_stamp}})
    public_health = validate_public_health_evidence(auth)
    expected_live = {'status': 200, 'body': 'ok\n', 'contentType': 'text/plain; charset=utf-8', 'cacheControl': 'no-store', 'contentLength': '3', 'routeClass': None}
    require(ingress['livenessMatcherMatched'] is False and set(ingress['liveness']) == {'anonymous', 'invalidCredential', 'session'}, 'liveness matcher or cases mismatch')
    require(all(ingress['liveness'][name] == expected_live for name in ('anonymous', 'invalidCredential', 'session')), 'liveness response mismatch')
    expected_live_head = {**expected_live, 'body': ''}
    require(set(ingress['livenessHead']) == {'anonymous', 'invalidCredential', 'session'}, 'liveness HEAD cases mismatch')
    require(all(ingress['livenessHead'][name] == expected_live_head for name in ('anonymous', 'invalidCredential', 'session')), 'liveness HEAD response mismatch')
    rows = ingress['results']
    require(len(rows) == 25 and [r['case'] for r in rows] == ['public GET /api/health', 'public GET /api/health/ping', 'GET /api/settings/cache-metrics', 'DELETE /api/settings/cache-metrics', 'GET cache-metrics missing usage_history', 'drain-transition GET /api/health', 'GET /api/health/degradation', 'GET /api/agent-skills', 'GET /api/agent-skills/config-codex-cli', 'GET /api/agent-skills/coverage', 'GET /api/model-combo-mappings', 'POST /api/model-combo-mappings', 'GET /api/model-combo-mappings/fixture-id', 'PUT /api/model-combo-mappings/fixture-id', 'DELETE /api/model-combo-mappings/fixture-id', 'GET /api/combos', 'GET /api/combos/fixture-id', 'GET /api/combos/auto', 'GET /api/combos/builder/options', 'GET /api/combos/metrics', 'DELETE /api/combos/metrics', 'GET /api/model-capability-overrides', 'GET /api/fallback/chains', 'GET /api/providers/fixture-id/cc-alias', 'GET /api/provider-nodes'], 'ingress cases incomplete')
    health = []
    for row, path in zip(rows[:2], ('/api/health', '/api/health/ping')):
        response, body = row['response'], row['response']['body']
        require(response['status'] == 200 and body['status'] == 'ok' and isinstance(body['timestamp'], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', body['timestamp']) and isinstance(response['cacheControl'], str) and 'no-store' in response['cacheControl'], 'health outcome mismatch')
        require(set(body) == ({'status', 'timestamp', 'latencyMs'} if path.endswith('/ping') else {'status', 'timestamp'}), 'unexpected health response keys')
        if path.endswith('/ping'):
            require(type(body.get('latencyMs')) in (int, float) and body['latencyMs'] >= 0, 'invalid latency')
        cache = response['cacheControl']
        require(len(cache) <= 128 and all(re.fullmatch(r'(?:no-store|no-cache|private|public|must-revalidate|proxy-revalidate|max-age=\d+|s-maxage=\d+)', part.strip()) for part in cache.split(',')), 'unsupported cache control')
        health.append({'method': 'GET', 'path': path, 'status': response['status'], 'bodyKeys': sorted(body), 'timestamp': body['timestamp'], 'cacheControl': cache, **({'latencyMs': body['latencyMs']} if 'latencyMs' in body else {})})
    metrics = []
    for row, method in zip(rows[2:4], ('GET', 'DELETE')):
        denied, invalid, allowed = row['denied'], row['invalid'], row['allowed']
        body = allowed['body']
        expected = {'totalRequests': 3, 'requestsWithCacheControl': 2, 'totalInputTokens': 300, 'totalCachedTokens': 150, 'totalCacheCreationTokens': 10}
        require(denied['status'] in (401, 403) and invalid['status'] in (401, 403) and allowed['status'] == 200 and all(body.get(k) == v for k, v in expected.items()) and body['byProvider']['alpha']['totalRequests'] == 2 and body['byStrategy']['direct']['cachedTokens'] == 50 and row['usageRowsAfter'] == 3, 'metrics outcome mismatch')
        metrics.append({'method': method, 'path': '/api/settings/cache-metrics', 'unauthenticatedStatus': denied['status'], 'invalidTokenStatus': invalid['status'], 'sessionStatus': allowed['status'], 'selectedValues': {**expected, 'alphaRequests': 2, 'directCachedTokens': 50}, 'usageRowsAfter': 3})
    fallback = rows[4]['response']
    require(fallback['status'] == 200 and fallback['body']['totalRequests'] == 0 and fallback['body']['totalCachedTokens'] == 0 and fallback['body']['byProvider'] == {}, 'fallback mismatch')
    drain = rows[5]
    require(drain['draining']['status'] == 503 and drain['recovered']['status'] == 200, 'drain transition mismatch')
    degradation = validate_degradation(rows[6], ingress['events'])
    skills_row = rows[7]
    denied, invalid, allowed = skills_row['denied'], skills_row['invalid'], skills_row['allowed']
    require(denied['status'] == 401 and invalid['status'] == 401 and all(item['routeClass'] == 'MANAGEMENT' for item in (denied, invalid, allowed)), 'agent-skills authorization mismatch')
    body = allowed['body']
    require(allowed['status'] == 200 and body['count'] == 1 and len(body['skills']) == 1 and body['skills'][0]['id'] == 'config-codex-cli' and body['skills'][0]['category'] == 'config' and body['skills'][0]['area'] == 'config-codex-cli', 'agent-skills authorized query mismatch')
    require(body['skills'][0]['rawUrl'] == 'https://raw.githubusercontent.com/cheaper-inference/OmniRoute/refs/heads/main/skills/config-codex-cli/SKILL.md' and body['skills'][0]['githubUrl'] == 'https://github.com/cheaper-inference/OmniRoute/blob/main/skills/config-codex-cli/SKILL.md', 'agent-skills URL mismatch')
    skills = {'method': 'GET', 'path': '/api/agent-skills', 'routeClass': 'MANAGEMENT', 'anonymousStatus': denied['status'], 'invalidCredentialStatus': invalid['status'], 'query': 'category=config&area=config-codex-cli', 'authorizedStatus': allowed['status'], 'ids': ['config-codex-cli']}
    skills_reads = []
    for row, path in zip(rows[8:10], ('/api/agent-skills/config-codex-cli', '/api/agent-skills/coverage')):
        denied, invalid, allowed = row['denied'], row['invalid'], row['allowed']
        require(denied['status'] == 401 and invalid['status'] == 401 and allowed['status'] == 200 and all(item['routeClass'] == 'MANAGEMENT' for item in (denied, invalid, allowed)), 'agent-skills read authorization mismatch')
        body = allowed['body']
        if path.endswith('/coverage'):
            require(all(type(body.get(key)) is dict and type(body[key].get('have')) is int and type(body[key].get('total')) is int and 0 <= body[key]['have'] <= body[key]['total'] for key in ('api', 'cli', 'config')) and type(body.get('totalSkills')) is int and body['totalSkills'] == sum(body[key]['have'] for key in ('api', 'cli', 'config')), 'agent-skills coverage mismatch')
        else:
            require(body.get('id') == 'config-codex-cli' and body.get('category') == 'config' and body.get('area') == 'config-codex-cli', 'agent-skills detail mismatch')
        skills_reads.append({'method': 'GET', 'path': path, 'routeClass': 'MANAGEMENT', 'anonymousStatus': 401, 'invalidCredentialStatus': 401, 'authorizedStatus': 200})
    mapping_policy = []
    for row, method, path in zip(rows[10:15], ('GET', 'POST', 'GET', 'PUT', 'DELETE'), ('/api/model-combo-mappings', '/api/model-combo-mappings', '/api/model-combo-mappings/fixture-id', '/api/model-combo-mappings/fixture-id', '/api/model-combo-mappings/fixture-id')):
        denied, invalid, allowed = row['denied'], row['invalid'], row['allowed']
        require(denied['status'] == 401 and invalid['status'] == 401 and allowed['status'] == 200 and allowed['body'] == {'fixture': 'management-handler-reached'} and all(item['routeClass'] == 'MANAGEMENT' for item in (denied, invalid, allowed)), 'mapping policy outcome mismatch')
        mapping_policy.append({'method': method, 'path': path, 'routeClass': 'MANAGEMENT', 'anonymousStatus': denied['status'], 'invalidCredentialStatus': invalid['status'], 'authorizedStatus': allowed['status']})
    combo_policy = []
    for row, method, path in zip(rows[15:21], ('GET', 'GET', 'GET', 'GET', 'GET', 'DELETE'), ('/api/combos', '/api/combos/fixture-id', '/api/combos/auto', '/api/combos/builder/options', '/api/combos/metrics', '/api/combos/metrics')):
        denied, invalid, allowed = row['denied'], row['invalid'], row['allowed']
        require(denied['status'] == 401 and invalid['status'] == 401 and allowed['status'] == 200 and allowed['body'] == {'fixture': 'management-handler-reached'} and all(item['routeClass'] == 'MANAGEMENT' for item in (denied, invalid, allowed)), 'combo policy outcome mismatch')
        combo_policy.append({'method': method, 'path': path, 'routeClass': 'MANAGEMENT', 'anonymousStatus': denied['status'], 'invalidCredentialStatus': invalid['status'], 'authorizedStatus': allowed['status']})
    denied, invalid, allowed = rows[21]['denied'], rows[21]['invalid'], rows[21]['allowed']
    require(denied['status'] == 401 and invalid['status'] == 401 and allowed['status'] == 200 and allowed['body'] == {'fixture': 'management-handler-reached'} and all(item['routeClass'] == 'MANAGEMENT' for item in (denied, invalid, allowed)), 'capability policy outcome mismatch')
    capability_policy = {'method': 'GET', 'path': '/api/model-capability-overrides', 'routeClass': 'MANAGEMENT', 'anonymousStatus': denied['status'], 'invalidCredentialStatus': invalid['status'], 'authorizedStatus': allowed['status']}
    read_policy = []
    for row, path in zip(rows[22:25], ('/api/fallback/chains', '/api/providers/fixture-id/cc-alias', '/api/provider-nodes')):
        denied, invalid, allowed = row['denied'], row['invalid'], row['allowed']
        require(denied['status'] == 401 and invalid['status'] == 401 and allowed['status'] == 200 and allowed['body'] == {'fixture': 'management-handler-reached'} and all(item['routeClass'] == 'MANAGEMENT' for item in (denied, invalid, allowed)), 'read policy outcome mismatch')
        read_policy.append({'method': 'GET', 'path': path, 'routeClass': 'MANAGEMENT', 'anonymousStatus': denied['status'], 'invalidCredentialStatus': invalid['status'], 'authorizedStatus': allowed['status']})
    require(any(e.get('event') == 'sqlite:read' for e in ingress['events']) and not any(str(e.get('event', '')).startswith('unsupported:') for e in ingress['events']), 'SQLite boundary evidence mismatch')
    fixture_hashes = {name.removeprefix('test/fixtures/pinned-ingress/'): value for name, value in hashes.items() if name.startswith('test/fixtures/pinned-ingress/')}
    require(all(identity['runtimeInputSha256'][n] == fixture_hashes[n] for n in ('source-manifest.json', 'dependencies.json', 'runtime.json')), 'manifest bytes changed')
    executed_fixture = identity['fixtureSha256']
    overlay_inputs = {}
    for name in ('backend/core.ts', 'backend/settings.ts'):
        data = (FIXTURE / name).read_bytes()
        require(sha(data) == fixture_hashes[name], 'fixture bytes changed: ' + name)
        overlay_inputs[name] = data
    overlays = {name: sha(data) for name, data in overlay_bytes(overlay_inputs['backend/core.ts'], overlay_inputs['backend/settings.ts'], declaration).items()}
    require(all(executed_fixture[name] == value for name, value in overlays.items()), 'executed overlay mismatch')
    require(executed_fixture['pinned-ingress-driver.mjs'] == hashes['scripts/pinned-ingress-driver.mjs'], 'executed driver mismatch')
    require(all(executed_fixture[name] == value for name, value in fixture_hashes.items() if name not in ('backend/core.ts', 'backend/settings.ts')), 'executed fixture mismatch')
    map_bytes = (FIXTURE / 'alias-map.json').read_bytes()
    require(sha(map_bytes) == fixture_hashes['alias-map.json'], 'alias map bytes changed')
    aliases = json.loads(map_bytes)['aliases']
    require(len(aliases) == 6 and len({a['source'] for a in aliases}) == 6, 'overlay boundary mismatch')
    expected_overlays = {}
    for alias in aliases:
        name, replacement = alias['source'], alias['replacement']
        original = sha(source[name])
        changes = json.loads((ROOT / source_identity['sourceDerivation']['record']).read_text())['changes'] if 'sourceDerivation' in source_identity else []
        change = next((item for item in changes if item['path'] == name), None)
        require((original == alias['sourceSha256'] if change is None else change['input_sha256'] == alias['sourceSha256'] and original == change['output_sha256']) and fixture_hashes[replacement] == alias['replacementSha256'], 'overlay input mismatch: ' + name)
        expected_overlays[name] = {'originalSha256': original, 'replacement': replacement, 'executedSha256': overlays.get(replacement, fixture_hashes[replacement])}
    require(identity['sourceOverlaySha256'] == expected_overlays, 'executed source overlay mismatch')
    artifact = {'schemaVersion': 1, 'classification': 'research-only-not-qualification', 'source': {'version': '3.8.53', 'commit': COMMIT, 'archiveSha256': ARCHIVE_SHA, 'addedSourceSha256': source_hashes, 'pingDeclarationSha256': identity['pingDeclarationSha256']}, 'inputs': {'sha256': hashes, 'nodeSha256': NODE_SHA, 'runtime': identity['runtime']}, 'isolation': {'namespacesDistinct': True, 'memoryLimitEnforced': True, 'cpuLimitEnforced': True, 'privateLoopbackOnly': True, 'environmentAllowlisted': True}, 'sharedAuthentication': cases, 'health': health, 'cacheMetrics': metrics, 'missingUsageHistory': {'status': fallback['status'], 'totalRequests': 0, 'totalCachedTokens': 0, 'providerCount': 0}, 'drain': {'path': '/api/health', 'statuses': [503, 200]}, 'limitations': ['Research observation only; not operation qualification.', 'Default Next bundler uses disposable source overlays; runtime observation is not production database qualification.', 'Selected SQLite reads use a disposable database; authentication and settings use fixture storage, not production persistence or the native database adapter.']}
    artifact['source'].update(source_identity)
    artifact['inputs']['sourceOverlaySha256'] = expected_overlays
    artifact['publicHealthHttp'] = public_health
    artifact['publicHealthIpFilter'] = {'enabled': True, 'mode': 'blacklist', 'configReadObserved': True, 'forwardedAddressFallback': {'deniedStatus': 403, 'error': 'IP blacklisted', 'recoveryStatus': 200, 'routeClass': 'PUBLIC', 'requestIdUuid': True, 'allowedOriginEchoed': True}}
    artifact['publicLivenessHttp'] = {'method': 'GET', 'path': '/livez', 'matcher': 'not-matched', 'proxyIdentity': {'originalSha256': proxy_sha, 'executedSha256': proxy_sha}, 'cases': {name: dict(expected_live) for name in ('anonymous', 'invalidCredential', 'session')}}
    artifact['publicLivenessHeadHttp'] = {'method': 'HEAD', 'path': '/livez', 'matcher': 'not-matched', 'proxyIdentity': {'originalSha256': proxy_sha, 'executedSha256': proxy_sha}, 'cases': {name: dict(expected_live_head) for name in ('anonymous', 'invalidCredential', 'session')}}
    artifact['limitations'].append('Liveness observes only GET and HEAD on isolated Next with the pinned matcher and handler; it does not establish full application or production persistence behavior.')
    artifact['degradation'] = degradation
    artifact['agentSkills'] = skills
    artifact['agentSkillsReads'] = skills_reads
    artifact['modelComboMappingPolicy'] = mapping_policy
    artifact['comboPolicy'] = combo_policy
    artifact['modelCapabilityOverridesPolicy'] = capability_policy
    artifact['readPolicy'] = read_policy
    artifact['limitations'].append('Fallback chains, provider cc-alias and provider nodes ingress exercises management policy using reachability controls, not the pinned handlers or their semantics.')
    artifact['limitations'].append('Capability overrides ingress exercises policy with a reachability control at the exact GET path; it does not execute the capability overrides handler or establish write safety.')
    artifact['limitations'].append('Combo ingress exercises policy with a reachability control at the exact method and path; it does not execute combo handlers or cold database initialization.')
    artifact['limitations'].append('Mapping ingress exercises policy with a reachability control at the exact method and path; it does not execute mapping handlers or cold database initialization.')
    artifact['limitations'].append('Agent-skills ingress coverage observes management denial and a dashboard-session query, not every credential alternative or hosted failures.')
    artifact['limitations'].append('Degradation handler failure was not induced; fixture signals control only the disposable in-process source registry.')
    artifact['limitations'].append('The IP filter denial and recovery exercise forwarding-header fallback with unknown peer locality under bare Next start. They do not demonstrate authenticated peer-stamp denial, peer locality, or reverse-proxy trust.')
    artifact['inputs']['executedOverlaySha256'] = overlays
    export = output / 'export'
    export.mkdir(mode=0o700)
    save(export / 'observed-outcomes.json', artifact)


def bridge(output, real_core=False):
    group = next(line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    memory = Path('/sys/fs/cgroup') / group.lstrip('/') / 'memory.max'
    require(memory.read_text().strip() == str(MEMORY), 'systemd memory boundary unavailable')
    command = ['/usr/bin/bwrap', '--unshare-all', '--uid', '0', '--gid', '0', '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SYS_ADMIN', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/etc', '--clearenv', '--dir', '/runtime', '--ro-bind', str(NODE), '/runtime/node', '--ro-bind', str(FIXTURE), '/fixture-src', '--dir', '/inputs', '--ro-bind', str(SOURCE), '/inputs/source.tar.gz', '--ro-bind', str(DEPENDENCIES), '/inputs/dependencies', '--ro-bind', str(ROOT / 'scripts/pinned-ingress-driver.mjs'), '/driver.mjs', '--ro-bind', str(ROOT / 'scripts/pinned-ingress.py'), '/runner.py', '--bind', str(output), '/work', '--dir', '/limits', '--ro-bind', str(memory), '/limits/memory.max', '--setenv', 'PATH', '/runtime:/usr/bin', '--setenv', 'HOME', '/work/home', '--setenv', 'TMPDIR', '/work/tmp', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8', '--chdir', '/work/app', '/usr/bin/python3', '/runner.py', '--worker']
    command[0] = str(BWRAP)
    inputs = command.index('--bind')
    command[inputs:inputs] = ['--dir', '/source-input', '--dir', '/source-input/scripts', '--dir', '/source-input/provenance', '--dir', '/source-input/.github', '--ro-bind', str(ROOT / 'scripts/prepare-upstream.py'), '/source-input/scripts/prepare-upstream.py', '--ro-bind', str(ROOT / 'provenance/upstreams.json'), '/source-input/provenance/upstreams.json', '--ro-bind', str(ROOT / '.github/crux-experts-release-signing-key.asc'), '/source-input/.github/crux-experts-release-signing-key.asc', '--ro-bind', str(ROOT / 'provenance/derivations'), '/source-input/provenance/derivations']
    runtime = command.index('/runtime/node') + 1
    command[runtime:runtime] = ['--ro-bind', str(BWRAP), '/runtime/bwrap']
    if real_core:
        command.append('--real-core')
    os.execv(command[0], command)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--real-core', action='store_true', help='run separate direct real-core cold/warm research observation')
    parser.add_argument('--bridge', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--preflight-only', action='store_true', help='check sandbox prerequisites; optional approved helper staging downloads one package')
    parser.add_argument('--preflight-probe', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--stage-dir', type=Path, help='stage exact approved inputs in a new directory')
    parser.add_argument('--bwrap-stage-dir', type=Path, help='stage the approved bubblewrap package in a new directory')
    parser.add_argument('--approve-bwrap-sha256', help='explicit approval of the pinned bubblewrap package')
    parser.add_argument('--bwrap-stage-only', action='store_true', help='stage helper without running preflight')
    parser.add_argument('--ci-apparmor-load', action='store_true', help='load explicitly approved hosted CI profile')
    parser.add_argument('--ci-apparmor-cleanup', action='store_true', help='remove approved hosted CI profile')
    parser.add_argument('--approve-ci-apparmor', action='store_true', help='authorize temporary hosted CI AppArmor profile')
    parser.add_argument('--bwrap', type=Path, help='path to the staged bubblewrap executable')
    parser.add_argument('--approve-node-archive-sha256', help='explicit approval of the pinned Node archive')
    parser.add_argument('--node', type=Path, help='exact Node 24.17.0 executable')
    parser.add_argument('--source-archive', type=Path, help='pinned OmniRoute source release archive')
    parser.add_argument('--dependency-dir', type=Path, help='directory of exact digest-named dependency tarballs')
    parser.add_argument('--output-dir', type=Path, help='private scratch parent')
    args = parser.parse_args()
    global NODE, SOURCE, DEPENDENCIES, BWRAP
    NODE, SOURCE, DEPENDENCIES, BWRAP = args.node, args.source_archive, args.dependency_dir, args.bwrap
    if args.worker:
        try:
            worker(args.real_core)
        except Exception as exc:
            save(Path('/work/failure-state.json'), {'stage': WORKER_STAGE, 'exceptionClass': failure_class(exc), 'returnCode': failure_code(exc)})
            raise
        return
    require(not (args.ci_apparmor_load and args.ci_apparmor_cleanup), 'choose one AppArmor action')
    if args.ci_apparmor_load or args.ci_apparmor_cleanup:
        ci_profile(args.approve_ci_apparmor, cleanup=args.ci_apparmor_cleanup)
        return
    if args.bwrap_stage_dir:
        require((args.preflight_only != args.bwrap_stage_only) and BWRAP is None, 'bubblewrap staging requires exactly one staging mode and no --bwrap')
        BWRAP = stage_bwrap(args.bwrap_stage_dir, args.approve_bwrap_sha256)
        if args.bwrap_stage_only:
            print(json.dumps({'bwrap': str(validate_bwrap(BWRAP))}))
            return
    require(not args.bwrap_stage_only, 'stage-only requires --bwrap-stage-dir')
    if args.preflight_probe or args.preflight_only or args.stage_dir or args.bridge:
        BWRAP = validate_bwrap(BWRAP)
    if args.preflight_probe:
        preflight_probe()
        return
    if args.preflight_only:
        preflight()
        print(json.dumps({'preflight': 'passed', 'researchOnly': True}))
        return
    if args.stage_dir:
        preflight()
        stage(args.stage_dir, args.approve_node_archive_sha256)
        return
    if args.bridge:
        bridge(args.bridge, args.real_core)
        return
    require(all((NODE, SOURCE, DEPENDENCIES, args.output_dir)), 'provide --node, --source-archive, --dependency-dir and --output-dir')
    NODE, SOURCE, DEPENDENCIES = (p.resolve(strict=True) for p in (NODE, SOURCE, DEPENDENCIES))
    require(DEPENDENCIES.is_dir(), 'dependency directory unavailable')
    require(file_sha(NODE) == NODE_SHA, 'Node runtime mismatch')
    require(file_sha(SOURCE) == ARCHIVE_SHA, 'source archive mismatch')
    BWRAP = validate_bwrap(BWRAP)
    output = args.output_dir.resolve(strict=True) / ('ingress-run-' + uuid.uuid4().hex[:12])
    output.mkdir(mode=0o700)
    for name in ('app', 'data', 'home', 'tmp'):
        (output / name).mkdir(mode=0o700)
    save(output / 'host-namespaces.json', {x: os.readlink('/proc/self/ns/' + x) for x in ('user', 'mnt', 'net', 'pid')})
    hashes = input_hashes()
    cpus = sorted(os.sched_getaffinity(0))[:2]
    require(cpus, 'CPU affinity unavailable')
    unit = 'omp-ingress-' + uuid.uuid4().hex[:12]
    command = ['/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect', '--unit', unit, '--property=MemoryMax=' + str(MEMORY), '--property=RuntimeMaxSec=600', '--property=KillMode=control-group', '--property=CPUQuota=200%', '--property=AllowedCPUs=' + ','.join(map(str, cpus)), '--property=CPUAffinity=' + ' '.join(map(str, cpus)), '/usr/bin/python3', str(ROOT / 'scripts/pinned-ingress.py'), '--bridge', str(output), '--node', str(NODE), '--source-archive', str(SOURCE), '--dependency-dir', str(DEPENDENCIES)]
    command.extend(['--bwrap', str(BWRAP)])
    if args.real_core:
        command.append('--real-core')
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 610
    count = 0
    failed = False
    exporting = False
    try:
        with (output / 'supervisor.private').open('xb') as log:
            while selector.get_map():
                require(time.monotonic() < deadline, 'supervisor deadline exceeded')
                disk_usage(output)
                for key, _ in selector.select(timeout=0.2):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    count += len(block)
                    require(count <= 1024**2, 'supervisor output limit exceeded')
                    log.write(block)
        code = process.wait(timeout=5)
        if code != 0:
            failed_stage, cls, worker_code = worker_failure_state(output)
            write_failure(output, hashes, failed_stage, cls or 'Other', worker_code if worker_code is not None else (code if -255 <= code <= 255 else None))
            failed = True
            raise RuntimeError('isolated ingress run failed at ' + failed_stage + '; inspect private logs')
        exporting = True
        require(input_hashes() == hashes, 'input bytes changed during run')
        if args.real_core:
            export_core_lifecycle(output, hashes)
        else:
            export_observations(output, hashes)
        print(json.dumps({'output': str(output), 'exitCode': code, 'researchOnly': True, 'scenario': 'actual-core-cold-warm' if args.real_core else 'pinned-ingress'}))
    except Exception as exc:
        if not failed:
            failed_stage = 'export' if exporting else worker_failure_state(output)[0]
            write_failure(output, hashes, failed_stage, failure_class(exc), failure_code(exc))
        raise
    finally:
        subprocess.run(['/usr/bin/systemctl', '--user', 'stop', unit], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(type(exc).__name__ + ': ' + str(exc), file=sys.stderr)
        sys.exit(1)
