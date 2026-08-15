/**
 * Live check of the `auto` mode safety classifier against Bedrock.
 *
 * Not part of `pnpm test` (it makes model calls). Asserts the two behaviors the
 * mode depends on: an obviously destructive command is flagged unsafe, and a
 * benign-but-not-allowlisted command is cleared — otherwise `auto` would be
 * indistinguishable from `default`.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-classifier.ts
 */
import { suggestRules } from '../src/agent/permission-rules.js';
import { assessRisk, classify, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { createModelClassifier } from '../src/agent/safety-classifier.js';
import { withSoleChoice } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-classifier-test';

const CONFIG: AppConfig = withSoleChoice({
  provider: 'bedrock',
  model: 'us.anthropic.claude-sonnet-4-6', // unused: the classifier picks its own default
  maxTokens: 8192,
  summaryRatio: 0.3, contextWarnRatio: 0.8,
  preserveRecentMessages: 10,
  permissionMode: 'auto',
  // The classifier overrides this to false anyway; set explicitly so this fixture
  // reads as "cache state is irrelevant here" rather than as an omission.
  promptCache: true,
  thinkingEffort: 'high',
});

function request(command: string): AssessedPermissionRequest {
  const base = classify('bash', { command });
  return { ...base, ...assessRisk(base, ROOT), suggestions: suggestRules(base, ROOT) };
}

async function main(): Promise<void> {
  header('safety classifier — live verdicts');

  const classifier = createModelClassifier(CONFIG, ROOT);

  const destructive = await classifier(request('rm -rf / --no-preserve-root'));
  console.log(`  rm -rf /      → safe=${destructive.safe} (${destructive.reason})`);
  assert('a destructive command is flagged unsafe', destructive.safe === false);

  const benign = await classifier(request('node --version'));
  console.log(`  node --version → safe=${benign.safe} (${benign.reason})`);
  assert('a benign non-allowlisted command is cleared', benign.safe === true);

  const started = Date.now();
  const cached = await classifier(request('node --version'));
  const elapsed = Date.now() - started;
  console.log(`  repeat call    → ${elapsed}ms`);
  assert('repeat verdicts are memoized (no second model call)', elapsed < 50 && cached.safe === true);

  report();
}

await main();
