// Checks site/install.sh, the one-command installer, against a made-up home folder and a
// local stand-in for nodejs.org and the GitHub release: it must install a private Node.js
// and the program, check both downloads, refuse tampered ones, update in place, leave the
// memory alone, and uninstall cleanly. Builds are done by `npm run test:install`.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER = fileURLToPath(new URL('../../site/install.sh', import.meta.url));
const BUNDLE = fileURLToPath(new URL('../dist/legendary-memory.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NODE_VERSION = /NODE_VERSION='([\d.]+)'/.exec(readFileSync(INSTALLER, 'utf8'))[1];
const OS = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const TARBALL = `node-v${NODE_VERSION}-${OS}-${ARCH}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 700)}` : ''}`);
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'lm-install-'));

// The stand-in for nodejs.org: a Node.js archive laid out like the real one, holding this
// machine's own node binary.
const stage = join(work, 'stage', TARBALL);
mkdirSync(join(stage, 'bin'), { recursive: true });
copyFileSync(process.execPath, join(stage, 'bin', 'node'));
writeFileSync(join(stage, 'LICENSE'), 'Node.js license\n');
const tar = spawnSync('tar', ['-czf', join(work, 'node.tar.gz'), '-C', join(work, 'stage'), TARBALL]);
if (tar.status !== 0) throw new Error(`could not build the test archive: ${tar.stderr}`);
const nodeArchive = readFileSync(join(work, 'node.tar.gz'));
const nodeSha = sha256(nodeArchive);

// The stand-in for the GitHub release. `release` can be swapped to simulate an update or tampering.
const bundle = readFileSync(BUNDLE);
let release = { mjs: bundle, sums: `${sha256(bundle)}  legendary-memory.mjs\n` };
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  const send = (body) => res.writeHead(200, { 'Content-Length': body.length }).end(body);
  if (req.url === `/node/v${NODE_VERSION}/${TARBALL}.tar.gz`) return send(nodeArchive);
  if (req.url === '/release/legendary-memory.mjs') return send(release.mjs);
  if (req.url === '/release/SHA256SUMS') return send(Buffer.from(release.sums));
  res.writeHead(404).end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** Runs the installer (or any program) with a clean environment for `home`. */
function run(home, args, extra = {}, program = 'sh', programArgs = [INSTALLER]) {
  return new Promise((resolve) => {
    const child = spawn(program, [...programArgs, ...args], {
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        SHELL: '/bin/zsh',
        LM_INSTALL_NODE_MIRROR: `${base}/node`,
        LM_INSTALL_RELEASE_URL: `${base}/release`,
        LM_TEST_NODE_SHA256: nodeSha,
        ...extra,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}
const newHome = (name) => {
  const home = join(work, name);
  mkdirSync(home, { recursive: true });
  return home;
};
const lm = (home) => join(home, '.legendary-memory');
const launcher = (home) => join(lm(home), 'bin', 'legendary-memory');
const count = (text, part) => text.split(part).length - 1;
const nodeFetches = () => requests.filter((url) => url.startsWith('/node/')).length;

try {
  console.log('Before installing');
  {
    const home = newHome('plan');
    const plans = {
      'Darwin arm64': ['darwin-arm64', 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd'],
      'Darwin x86_64': ['darwin-x64', '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7'],
      'Linux x86_64': ['linux-x64', '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2'],
      'Linux aarch64': ['linux-arm64', '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8'],
    };
    let right = true;
    let shown = '';
    for (const [platform, [name, sum]] of Object.entries(plans)) {
      const [os, arch] = platform.split(' ');
      const r = await run(home, ['--dry-run'], { LM_TEST_OS: os, LM_TEST_ARCH: arch, LM_INSTALL_NODE_MIRROR: '', LM_INSTALL_RELEASE_URL: '' });
      shown = r.out;
      right &&= r.code === 0 && r.out.includes(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${name}.tar.gz`) && r.out.includes(sum);
    }
    check('a dry run picks the right Node.js build and pinned checksum for each Mac and Linux', right, shown);
    check('a dry run points at the latest GitHub release', shown.includes('https://github.com/akseldan/legendary-memory/releases/latest/download/legendary-memory.mjs'), shown);
    const tagged = await run(home, ['--dry-run', '--version', 'v9.9.9'], { LM_INSTALL_RELEASE_URL: '' });
    check('--version picks that release', tagged.out.includes('/releases/download/v9.9.9/legendary-memory.mjs'), tagged.out);
    check('a dry run changes nothing', !existsSync(lm(home)) && requests.length === 0, requests.join(' '));
    const windows = await run(home, [], { LM_TEST_OS: 'MINGW64_NT-10.0' });
    check('Windows gets a plain no with somewhere to go', windows.code !== 0 && /macOS and Linux/.test(windows.out), windows.out);
    if (process.getuid?.() === 0) {
      const sudo = await run(home, [], { SUDO_USER: 'someone' });
      check('it refuses to run under sudo', sudo.code !== 0 && /without sudo/.test(sudo.out) && !existsSync(lm(home)), sudo.out);
    }
  }

  console.log('\nInstalling');
  const home = newHome('main');
  mkdirSync(join(home, '.cursor'));
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }));
  const zshrc = join(home, '.zshrc');
  const zshrcBefore = "alias ll='ls -l'\nexport EDITOR=vim\n";
  writeFileSync(zshrc, zshrcBefore);
  mkdirSync(lm(home), { recursive: true });
  writeFileSync(join(lm(home), 'memory.db'), 'my memory, do not touch');

  let r = await run(home, []);
  check('it installs', r.code === 0, r.out);
  const node = join(lm(home), 'runtime', 'bin', 'node');
  const version = spawnSync(node, ['--version'], { encoding: 'utf8' });
  check('a private Node.js runs from the data folder', version.status === 0 && /^v\d+/.test(version.stdout), version.stderr);
  check('it records which Node.js it installed', readFileSync(join(lm(home), 'runtime', 'VERSION'), 'utf8').trim() === NODE_VERSION);
  check('it keeps only the program, not npm', !existsSync(join(lm(home), 'runtime', 'lib')));
  check('the program is the released file', readFileSync(join(lm(home), 'bin', 'legendary-memory.mjs')).equals(bundle));
  const said = spawnSync(launcher(home), ['version'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  check('the legendary-memory command works without any other Node.js on PATH', said.status === 0 && said.stdout.trim() === VERSION, said.stdout + said.stderr);
  check('the data folder is private to you', (statSync(lm(home)).mode & 0o777) === 0o700);
  check('it adds itself to PATH once, after what was there', readFileSync(zshrc, 'utf8').startsWith(zshrcBefore) && count(readFileSync(zshrc, 'utf8'), '# >>> legendary-memory >>>') === 1);
  check('it did not change any app by itself', !readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8').includes('legendary-memory'));
  check('the memory is untouched', readFileSync(join(lm(home), 'memory.db'), 'utf8') === 'my memory, do not touch');
  check('without a terminal it says what to run instead of opening a page', /legendary-memory start/.test(r.out) && !/Opening the welcome page/.test(r.out), r.out);
  check('no temporary files are left', !spawnSync('ls', ['-A', lm(home)], { encoding: 'utf8' }).stdout.includes('.install.'));

  console.log('\nConnecting through the installed command');
  const setup = spawnSync(launcher(home), ['setup'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1' } });
  const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers;
  check('setup connects Cursor', setup.status === 0 && /Cursor\s+connected/.test(setup.stdout), setup.stdout + setup.stderr);
  check('the app runs the private Node.js, which no upgrade of another Node.js can break', cursor['legendary-memory']?.command === node, JSON.stringify(cursor));
  check('and the installed program', cursor['legendary-memory']?.args?.[0] === join(lm(home), 'bin', 'legendary-memory.mjs'), JSON.stringify(cursor));
  check("the app's other servers are kept", cursor.other?.command === 'other-server');

  console.log('\nThe welcome page, started by the installed command');
  {
    const child = spawn(launcher(home), ['start', '--no-open', '--port', '18797'], {
      // The memory file in this home is a stand-in that must stay untouched, so the page gets its own.
      env: { HOME: home, PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1', LEGENDARY_MEMORY_DB: join(work, 'page.db') },
    });
    let printed = '';
    child.stderr.on('data', (d) => (printed += d));
    const deadline = Date.now() + 20_000;
    while (!/#t=([0-9a-f]+)/.test(printed) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const token = /#t=([0-9a-f]+)/.exec(printed)?.[1] ?? '';
    const port = /127\.0\.0\.1:(\d+)/.exec(printed)?.[1] ?? '18797';
    check('start opens the page from the installed command', token.length === 48, printed);
    const memory = token
      ? await (await fetch(`http://127.0.0.1:${port}/ui/memory`, { headers: { Authorization: `Bearer ${token}` } })).json()
      : {};
    check('the page offers the installed command for undoing, which needs no other Node.js', memory.undoCommand === '~/.legendary-memory/bin/legendary-memory setup --undo', JSON.stringify(memory.undoCommand));
    child.kill();
  }

  console.log('\nRunning it again');
  const fetchedBefore = nodeFetches();
  r = await run(home, []);
  check('a second run succeeds', r.code === 0, r.out);
  check('it does not download Node.js again', nodeFetches() === fetchedBefore && /already there/.test(r.out), r.out);
  check('it says the program is up to date', /already up to date/.test(r.out), r.out);
  check('the PATH line is still there once', count(readFileSync(zshrc, 'utf8'), '# >>> legendary-memory >>>') === 1);

  const newer = Buffer.concat([bundle, Buffer.from('\n// a newer release\n')]);
  release = { mjs: newer, sums: `${sha256(newer)}  legendary-memory.mjs\n` };
  r = await run(home, []);
  check('a new release replaces the program in place', r.code === 0 && readFileSync(join(lm(home), 'bin', 'legendary-memory.mjs')).equals(newer), r.out);
  check('apps stay connected through the update', JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers['legendary-memory']?.command === node);

  console.log('\nTampered downloads');
  release = { mjs: Buffer.from('console.log("not the real program")'), sums: `${sha256(bundle)}  legendary-memory.mjs\n` };
  r = await run(home, []);
  check('a program that does not match its checksum is refused', r.code !== 0 && /does not match its checksum/.test(r.out), r.out);
  check('and the installed program is left as it was', readFileSync(join(lm(home), 'bin', 'legendary-memory.mjs')).equals(newer));
  release = { mjs: bundle, sums: `${sha256(bundle)}  something-else.mjs\n` };
  r = await run(home, []);
  check('a release without a checksum for the program is refused', r.code !== 0 && /no checksum/.test(r.out), r.out);
  release = { mjs: bundle, sums: `${sha256(bundle)}  legendary-memory.mjs\n` };

  const other = newHome('tampered-node');
  r = await run(other, [], { LM_TEST_NODE_SHA256: '0'.repeat(64) });
  check('a Node.js download that does not match the pinned checksum is refused', r.code !== 0 && /published checksum/.test(r.out), r.out);
  check('and nothing runnable is left behind', !existsSync(join(lm(other), 'runtime')) && !existsSync(launcher(other)));

  const quiet = newHome('no-path');
  r = await run(quiet, ['--no-modify-path'], { SHELL: '/bin/bash' });
  check('--no-modify-path leaves the shell startup files alone', r.code === 0 && !existsSync(join(quiet, '.bashrc')) && !existsSync(join(quiet, '.bash_profile')), r.out);
  check('and prints the full command instead', r.out.includes(launcher(quiet)) || r.out.includes('legendary-memory start'), r.out);

  console.log('\nUninstalling');
  r = await run(home, [], {}, launcher(home), ['uninstall']);
  const after = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers;
  check('uninstall succeeds', r.code === 0 && /uninstalled/.test(r.out), r.out);
  check('it disconnects the apps it connected', !('legendary-memory' in after) && after.other?.command === 'other-server', JSON.stringify(after));
  check('it removes the program and the private Node.js', !existsSync(join(lm(home), 'runtime')) && !existsSync(join(lm(home), 'bin')));
  check('it puts the shell startup file back exactly as it was', readFileSync(zshrc, 'utf8') === zshrcBefore, JSON.stringify(readFileSync(zshrc, 'utf8')));
  check('it keeps the memory', readFileSync(join(lm(home), 'memory.db'), 'utf8') === 'my memory, do not touch');
  r = await run(quiet, ['--uninstall']);
  check('install.sh --uninstall does the same', r.code === 0 && !existsSync(launcher(quiet)), r.out);
  r = await run(quiet, ['--uninstall']);
  check('uninstalling twice says there is nothing to remove', r.code !== 0 && /no installed copy/.test(r.out), r.out);
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
