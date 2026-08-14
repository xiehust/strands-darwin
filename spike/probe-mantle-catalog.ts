/**
 * Lists the models Bedrock Mantle actually serves, per region and base path.
 *
 * The Mantle catalog is not documented per-region and the SDK's own base-path
 * table was verified against `us-east-1` only, so darwin's config layer needs
 * the real answer before it hard-codes a model id anywhere.
 *
 * Run: pnpm tsx spike/probe-mantle-catalog.ts [region ...]
 */
import { getTokenProvider } from '@aws/bedrock-token-generator';

const REGIONS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['us-west-2', 'us-east-1'];

for (const region of REGIONS) {
  for (const basePath of ['/openai/v1', '/v1']) {
    const url = `https://bedrock-mantle.${region}.api.aws${basePath}/models`;
    try {
      const token = await getTokenProvider({ region })();
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const body = (await response.json()) as { data?: { id: string }[] };
      const ids = (body.data ?? []).map((model) => model.id);
      console.log(`\n${region}${basePath} → HTTP ${response.status}, ${ids.length} models`);
      for (const id of ids.filter((id) => id.includes('gpt') || id.includes('openai'))) {
        console.log(`  ${id}`);
      }
    } catch (error) {
      console.log(`\n${region}${basePath} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
