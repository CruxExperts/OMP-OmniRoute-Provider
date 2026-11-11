#!/usr/bin/env python3
"""Run pinned ingress observations offline in the required isolated sandbox; not qualification evidence."""
import argparse
import base64
import hashlib
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
    missing = [path for path in ('/usr/bin/python3', '/usr/bin/systemd-run', '/usr/bin/systemctl', '/usr/bin/ip') if not os.access(path, os.X_OK)]
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
    require(manifest['schemaVersion'] == 1 and manifest['platform'] == 'linux-x64-glibc' and len(manifest['packages']) == 265, 'dependency manifest mismatch')
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



ROUTES = ('src/app/api/health/ping/route.ts', 'src/app/api/settings/cache-metrics/route.ts', 'src/lib/db/settings/cacheMetrics.ts')

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


def materialize():
    source = Path('/inputs/source.tar.gz')
    app = Path('/work/app')
    fixture = Path('/fixture-src')
    manifest = json.loads((fixture / 'source-manifest.json').read_text())
    runtime = json.loads((fixture / 'runtime.json').read_text())
    require(manifest['schemaVersion'] == runtime['schemaVersion'] == 1 and runtime['nodeVersion'] == '24.17.0' and runtime['nodeSha256'] == NODE_SHA, 'runtime manifest mismatch')
    require(manifest['commit'] == runtime['sourceCommit'] == COMMIT, 'source commit mismatch')
    require(file_sha(source) == manifest['archiveSha256'] == runtime['sourceArchiveSha256'] == ARCHIVE_SHA, 'source archive mismatch')
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
            if name not in selected and name not in additional and name not in wanted and not (name.startswith('scripts/build/') and name.endswith(('.mjs', '.cjs'))) and not name.startswith('src/i18n/') and name != 'config/cli-tools-manifest.json':
                continue
            require(member.isfile() and member.size <= 2 * 1024 * 1024 and name not in seen, 'invalid source member: ' + name)
            seen.add(name)
            data = archive.extractfile(member).read()
            require(len(data) == member.size, 'short source member: ' + name)
            blob = digest(b'blob ' + str(len(data)).encode() + b'\0' + data, 'sha1')
            for expected in (selected.get(name), additional.get(name), manifest['nextConfig'] if name == 'next.config.mjs' else None):
                if expected:
                    require(digest(data) == expected['sha256'] and blob == expected['gitBlob'], 'source identity mismatch: ' + name)
            support[name] = digest(data)
            put(app, 'next.config.upstream.mjs' if name == 'next.config.mjs' else name, data)
    require(set(selected) <= seen and set(additional) <= seen and wanted <= seen, 'missing source closure')
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
    shutil.copytree(fixture, '/work/fixture', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile('/driver.mjs', '/work/fixture/pinned-ingress-driver.mjs')
    (app / '.build').mkdir(exist_ok=True)
    (app / '.source').mkdir(exist_ok=True)
    (app / 'next-env.d.ts').touch()
    shutil.copyfile('/work/fixture/next.config.mjs', app / 'next.config.mjs')
    for route in ('src/app/api/ingress-control/route.ts', 'src/app/api/providers/fixture/models/route.ts'):
        put(app, route, Path('/work/fixture/routes/management.ts').read_bytes())
    (app / 'docs').mkdir(exist_ok=True)
    os.symlink('/work/app/node_modules', '/work/node_modules')
    return {'selectedSourceFiles': len(selected), 'configSupportSha256': support, 'packageCount': len(locations), 'archiveSha256': ARCHIVE_SHA, 'webpackDeviation': True}

def replace_once(text, before, after):
    require(text.count(before) == 1, 'fixture boundary changed: ' + before[:80])
    return text.replace(before, after, 1)


def provision():
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
    package = json.loads((app / 'package.json').read_text())
    require(package['version'] == '3.8.53', 'source version mismatch')
    source_core = (app / 'src/lib/db/core.ts').read_text()
    matches = re.findall(r'(?ms)^export function pingDb\(\): boolean \{\n.*?^\}', source_core)
    require(len(matches) == 1, 'source pingDb declaration unavailable or ambiguous')
    core = fixture / 'backend/core.ts'
    text = core.read_text()
    text = 'import { DatabaseSync } from "node:sqlite";\n' + text
    text = replace_once(text, 'export function getDbInstance() {',
        'let sqlite: DatabaseSync | undefined;\nexport function getDbInstance() {')
    text = replace_once(text, '      const normalized = sql.replace(/\\s+/g, " ").trim();',
        '      const normalized = sql.replace(/\\s+/g, " ").trim();\n'
        '      if (normalized === "SELECT 1 AS ok" || (/^SELECT /i.test(normalized) && /\\bFROM usage_history\\b/i.test(normalized))) {\n'
        '        event("sqlite:read");\n'
        '        sqlite ??= new DatabaseSync("/work/data/metrics.sqlite");\n'
        '        return sqlite.prepare(sql);\n'
        '      }')
    core.write_text(text + '\n' + matches[0] + '\n')
    settings = fixture / 'backend/settings.ts'
    settings.write_text(settings.read_text() + '\nexport { getCacheMetrics, resetCacheMetrics } from "@/lib/db/settings/cacheMetrics";\n')
    identities['src/lib/db/core.ts'] = sha((app / 'src/lib/db/core.ts').read_bytes())
    identities['src/lib/api/requireManagementAuth.ts'] = sha((app / 'src/lib/api/requireManagementAuth.ts').read_bytes())
    identities['src/app/api/health/route.ts'] = sha((app / 'src/app/api/health/route.ts').read_bytes())
    versions = {name: json.loads((app / 'node_modules' / name / 'package.json').read_text())['version'] for name in ('next', 'react', 'react-dom')}
    require(versions == {'next': '16.4.2', 'react': '19.2.8', 'react-dom': '19.2.8'}, 'runtime package mismatch')
    inputs = ('source-manifest.json', 'dependencies.json', 'runtime.json')
    identity = {
        'status': 'unreviewed-observation-not-qualification', 'sourceVersion': '3.8.53',
        'sourceCommit': COMMIT, 'archiveSha256': ARCHIVE_SHA, 'addedSourceSha256': identities,
        'pingDeclarationSha256': sha(matches[0].encode()),
        'fixtureSha256': {str(p.relative_to(fixture)): sha(p.read_bytes()) for p in sorted(fixture.rglob('*')) if p.is_file() and '__pycache__' not in p.parts},
        'nodeSha256': sha(Path('/runtime/node').read_bytes()),
        'runtime': {'node': '24.17.0', **versions},
        'runtimeInputSha256': {name: sha((Path('/fixture-src') / name).read_bytes()) for name in inputs},
        'boundary': 'Actual Next webpack ingress and pinned handlers; source pingDb and cache SQL use node:sqlite against disposable file. Auth/settings storage remains bounded in-memory fixture; not production persistence, native DB adapter, full application or production bundler.',
    }
    identity_path = Path('/work/data/pinned-ingress-identity.json')
    identity_path.write_text(json.dumps(identity, indent=2) + '\n')
    identity_path.chmod(0o600)

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
        require(code == 0, 'candidate command failed: ' + str(code))
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)


def worker():
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
    material = materialize()
    provision()
    save(Path('/work/materialization.json'), material)
    state = {'bypass': 'disabled', 'settings': {'requireLogin': True, 'password': 'fixture-configured', 'setupComplete': True}, 'tokens': []}
    save(Path('/work/data/state.json'), state)
    Path('/work/data/events.jsonl').write_text('')
    env = {'PATH': '/runtime', 'HOME': '/work/home', 'TMPDIR': '/work/tmp', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1', 'OMNIROUTE_BUILDING': '1', 'DATA_DIR': '/work/data', 'INGRESS_STATE_FILE': '/work/data/state.json', 'INGRESS_EVENT_FILE': '/work/data/events.jsonl', 'JWT_SECRET': 'research-only-jwt-secret-32-byte-minimum'}
    # Keep source, overlay and exact installed dependency bytes read-only while
    # allowing only Next's and the source plugins' owned output directories.
    isolate = ['/runtime/bwrap', '--cap-drop', 'ALL', '--die-with-parent', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--ro-bind', '/work/app', '/work/app', '--bind', '/work/app/.build', '/work/app/.build', '--bind', '/work/app/.source', '/work/app/.source', '--bind', '/work/app/next-env.d.ts', '/work/app/next-env.d.ts', '--ro-bind', '/work/fixture', '/work/fixture', '--chdir', '/work/app', '--']
    run_bounded(isolate + ['/runtime/node', '/work/app/node_modules/next/dist/bin/next', 'build', '--webpack'], Path('/work/build.private'), deadline, env)
    env['INGRESS_APPROVED_SANDBOX'] = '1'
    run_bounded(isolate + ['/runtime/node', '/work/fixture/driver.mjs'], Path('/work/http.private'), deadline, env)
    run_bounded(isolate + ['/runtime/node', '/work/fixture/pinned-ingress-driver.mjs'], Path('/work/pinned-http.private'), deadline, env)
    save(Path('/work/result.json'), {'status': 'research-observed', 'qualification': False, 'materialization': material})


def bridge(output):
    group = next(line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    memory = Path('/sys/fs/cgroup') / group.lstrip('/') / 'memory.max'
    require(memory.read_text().strip() == str(MEMORY), 'systemd memory boundary unavailable')
    command = ['/usr/bin/bwrap', '--unshare-all', '--uid', '0', '--gid', '0', '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SYS_ADMIN', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/etc', '--clearenv', '--dir', '/runtime', '--ro-bind', str(NODE), '/runtime/node', '--ro-bind', str(FIXTURE), '/fixture-src', '--dir', '/inputs', '--ro-bind', str(SOURCE), '/inputs/source.tar.gz', '--ro-bind', str(DEPENDENCIES), '/inputs/dependencies', '--ro-bind', str(ROOT / 'scripts/pinned-ingress-driver.mjs'), '/driver.mjs', '--ro-bind', str(ROOT / 'scripts/pinned-ingress.py'), '/runner.py', '--bind', str(output), '/work', '--dir', '/limits', '--ro-bind', str(memory), '/limits/memory.max', '--setenv', 'PATH', '/runtime:/usr/bin', '--setenv', 'HOME', '/work/home', '--setenv', 'TMPDIR', '/work/tmp', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8', '--chdir', '/work/app', '/usr/bin/python3', '/runner.py', '--worker']
    command[0] = str(BWRAP)
    runtime = command.index('/runtime/node') + 1
    command[runtime:runtime] = ['--ro-bind', str(BWRAP), '/runtime/bwrap']
    os.execv(command[0], command)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
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
        worker()
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
        bridge(args.bridge)
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
    cpus = sorted(os.sched_getaffinity(0))[:2]
    require(cpus, 'CPU affinity unavailable')
    unit = 'omp-ingress-' + uuid.uuid4().hex[:12]
    command = ['/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect', '--unit', unit, '--property=MemoryMax=' + str(MEMORY), '--property=RuntimeMaxSec=600', '--property=KillMode=control-group', '--property=CPUQuota=200%', '--property=AllowedCPUs=' + ','.join(map(str, cpus)), '--property=CPUAffinity=' + ' '.join(map(str, cpus)), '/usr/bin/python3', str(ROOT / 'scripts/pinned-ingress.py'), '--bridge', str(output), '--node', str(NODE), '--source-archive', str(SOURCE), '--dependency-dir', str(DEPENDENCIES)]
    command.extend(['--bwrap', str(BWRAP)])
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 610
    count = 0
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
        print(json.dumps({'output': str(output), 'exitCode': code, 'researchOnly': True}))
        require(code == 0, 'isolated ingress run failed; inspect private logs')
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
