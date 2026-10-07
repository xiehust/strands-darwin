/** Static Bash grammar projection. No parser/runtime/config imports: generation is local. */
import { localCliAnswer, usageErrorText } from './cli-usage.js';

interface CompletionState {
  /** Literal next words and their successor states. */
  words?: Readonly<Record<string, string>>;
  /** Consume one free operand without offering any values. */
  operand?: string;
  /** --resume accepts an id OR another option; never offer invented ids. */
  optionalOperand?: boolean;
}

// Deliberately explicit, not a second CLI parser. The fast suite pins this vocabulary
// to CLI_USAGE and the domain parsers. Unknown/unsupported shapes stop completion.
const ARGUMENTS = {
  '-p': 'prompt', '--print': 'prompt', '--resume': 'resume', '--session': 'session',
  '--permission-mode': 'permission', '--yolo': 'args', '--output-format': 'output',
  '--max-model-calls': 'count', '--context-offload': 'args', '--compact-before': 'args',
  '--continue': 'args', '--help': 'end', '-h': 'end', '--version': 'end', '-V': 'end',
};

export const COMPLETION_GRAMMAR: Readonly<Record<string, CompletionState>> = {
  root: { words: {
    completion: 'completion', sessions: 'end', 'list-agents': 'end',
    collaborate: 'collaborate', permissions: 'permissions', mcp: 'mcp',
    import: 'import', doctor: 'end', 'cloud-memory': 'cloud', trajectory: 'trajectory',
    ...ARGUMENTS,
  } },
  args: { words: ARGUMENTS },
  prompt: { operand: 'args' },
  session: { operand: 'args' },
  count: { operand: 'args' },
  resume: { words: ARGUMENTS, operand: 'args', optionalOperand: true },
  permission: { words: { default: 'args', auto: 'args', plan: 'args', yolo: 'args' } },
  output: { words: { text: 'args', json: 'args', 'stream-json': 'args' } },
  completion: { words: { bash: 'end' } },
  permissions: { words: { test: 'rule' } },
  rule: { operand: 'end' },
  mcp: { words: { login: 'serverLogin', logout: 'serverLogout' } },
  serverLogin: { operand: 'loginOptions' },
  serverLogout: { operand: 'end' },
  loginOptions: { words: { '--no-browser': 'end' } },
  import: { words: { '--from': 'importFrom', '--apply': 'importApplied' } },
  importFrom: { words: { 'claude-code': 'importOptions' } },
  importOptions: { words: { '--apply': 'end' } },
  importApplied: { words: { '--from': 'importAppliedFrom' } },
  importAppliedFrom: { words: { 'claude-code': 'end' } },
  trajectory: { words: { list: 'end', search: 'query', replay: 'replayId', fork: 'forkId' } },
  query: { operand: 'searchOptions' },
  searchOptions: { words: { '--session': 'searchSession', '--type': 'searchType', '--limit': 'searchLimit' } },
  searchSession: { operand: 'searchOptions' },
  searchType: { operand: 'searchOptions' },
  searchLimit: { operand: 'searchOptions' },
  replayId: { operand: 'replayOptions' },
  replayOptions: { words: { '--turn': 'replayTurn', '--json': 'replayOptions' } },
  replayTurn: { operand: 'replayOptions' },
  forkId: { operand: 'end' },
  cloud: { words: {
    status: 'end', preferences: 'end', list: 'cloudList', inspect: 'record',
    pending: 'cloudPending', preview: 'record',
  } },
  cloudList: { words: { preferences: 'cloudAfter', episodes: 'cloudAfter', reflections: 'cloudAfter', after: 'record' } },
  cloudPending: { words: { accepted: 'cloudAfter', after: 'record' } },
  cloudAfter: { words: { after: 'record' } },
  record: { operand: 'end' },
  collaborate: { words: {
    status: 'end', list: 'end', pending: 'end', relations: 'end', on: 'end', off: 'end',
    send: 'endpoint', confirm: 'pendingId', revoke: 'pairId', hub: 'hub',
  } },
  endpoint: { operand: 'literalText' },
  literalText: { operand: 'literalText' },
  pendingId: { operand: 'confirmOptions' },
  confirmOptions: { words: { '--persist': 'end' } },
  pairId: { operand: 'end' },
  hub: { words: {
    status: 'end', nodes: 'end', leave: 'end', publish: 'publish',
    block: 'node', unblock: 'node', enroll: 'url',
  } },
  publish: { words: { on: 'end', off: 'end' } },
  node: { operand: 'end' },
  url: { operand: 'token' },
  token: { operand: 'enrollOptions' },
  enrollOptions: { words: { '--name': 'label' } },
  label: { operand: 'end' },
  end: {},
};

/** Compile only trusted vocabulary into case arms; COMP_WORDS is always quoted data. */
export function bashCompletion(): string {
  const transitions: string[] = [];
  const candidates: string[] = [];
  for (const [state, grammar] of Object.entries(COMPLETION_GRAMMAR)) {
    if (![state, grammar.operand ?? state].every(value => /^[A-Za-z0-9_-]+$/.test(value))) {
      throw new Error('Invalid completion state');
    }
    for (const [word, next] of Object.entries(grammar.words ?? {})) {
      // This is an internal table, not user input. Fail closed if a future edit adds
      // shell syntax rather than silently making the generated source executable.
      if (![state, word, next].every(value => /^[A-Za-z0-9_-]+$/.test(value))) {
        throw new Error('Invalid completion vocabulary');
      }
      transitions.push(`      '${state}:${word}') state='${next}' ;;`);
    }
    if (grammar.operand !== undefined) {
      transitions.push(`      '${state}:'*) [[ -n $word && $word != -* ]] || return 0; state='${grammar.operand}' ;;`);
    }
    const words = Object.keys(grammar.words ?? {}).map(word => `'${word}'`).join(' ');
    const optional = grammar.optionalOperand ? '[[ $cur == -* ]] || return 0; ' : '';
    candidates.push(`    '${state}') ${optional}candidates=(${words}) ;;`);
  }
  return [
    '# Bash completion for darwin. Generated static vocabulary; load manually.',
    '# No discovery, external commands, eval, or default/filename fallback.',
    '_darwin_completion() {',
    '  COMPREPLY=()',
    '  [[ ${COMP_CWORD-} =~ ^[0-9]+$ ]] || return 0',
    '  local state=root word cur key seen=" " sessionUsed=0 i=1',
    '  local -a candidates=()',
    '  cur=${COMP_WORDS[COMP_CWORD]}',
    '  if [[ ${COMP_WORDS[1]-} == -- ]] && (( COMP_CWORD > 1 )); then i=2; fi',
    '  for (( ; i < COMP_CWORD; i++ )); do',
    '    word=${COMP_WORDS[i]}',
    '    key=$word',
    '    [[ $key != --print ]] || key=-p',
    '    case "$state" in',
    '      root|args|resume)',
    '        if [[ $word == --session || ( $state == resume && $word != -* ) ]]; then',
    '          (( sessionUsed == 0 )) || return 0',
    '          sessionUsed=1',
    '        fi ;;',
    '    esac',
    '    if [[ $word == -* ]]; then',
    '      [[ $seen != *" $key "* ]] || return 0',
    '      seen+="$key "',
    '    fi',
    '    case "$state:$word" in',
    ...transitions,
    '      *) return 0 ;;',
    '    esac',
    '  done',
    '  case "$state" in',
    ...candidates,
    '    *) return 0 ;;',
    '  esac',
    '  for word in "${candidates[@]}"; do',
    '    key=$word',
    '    [[ $key != --print ]] || key=-p',
    '    [[ $word != -* || $seen != *" $key "* ]] || continue',
    '    if [[ $state == args || $state == resume ]]; then',
    '      [[ $word != --session || $sessionUsed == 0 ]] || continue',
    '    fi',
    '    [[ $word != "$cur"* ]] || COMPREPLY+=("$word")',
    '  done',
    '  return 0',
    '}',
    'complete -F _darwin_completion darwin',
    '',
  ].join('\n');
}

export function runCompletionCli(argv: readonly string[]): void {
  const local = localCliAnswer(argv);
  if (local !== undefined) { process.stdout.write(local); return; }
  if (argv.length !== 1 || argv[0] !== 'bash') {
    process.stderr.write(usageErrorText('usage: darwin completion bash'));
    process.exitCode = 2;
    return;
  }
  process.stdout.write(bashCompletion());
}
