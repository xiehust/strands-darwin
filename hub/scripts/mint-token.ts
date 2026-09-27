/** `pnpm mint-token [--note <text>]`: one 10-minute, single-use enrollment token; only its hash is stored. */
import { ENROLL_TOKEN_TTL_MS, mintToken } from '../../src/collaboration/hub-wire.js';
import { mint } from '../src/handlers.js';
import { operatorContext } from './operator.js';

const args = process.argv.slice(2);
const noteIndex = args.indexOf('--note');
const note = noteIndex >= 0 ? args[noteIndex + 1] ?? '' : '';
const { ctx, outputs } = operatorContext();
const token = mintToken();
await mint(ctx, token, ENROLL_TOKEN_TTL_MS, note);
console.log(`Enrollment token (single use, expires in ${ENROLL_TOKEN_TTL_MS / 60_000} minutes; shown once):\n\n  ${token}\n`);
console.log(`On the machine to enroll:\n\n  darwin collaborate hub enroll ${outputs['HubUrl']} ${token} --name <label>\n`);
