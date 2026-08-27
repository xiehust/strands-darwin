/** Offline regression for OpenAI Responses context-overflow classification. */
import {
  ContextWindowOverflowError,
  Message,
  ModelError,
  TextBlock,
} from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type OpenAI from 'openai';

import { assert, header, report } from './shared.js';

const INCIDENT_MESSAGE =
  'prompt tokens (1416135) exceed model maximum (1050000) for openai.gpt-5.6-sol';
const GENERIC_MESSAGE =
  'prompt tokens (1416135) exceed deployment maximum (1050000) for openai.gpt-5.6-sol';

function fakeResponsesClient(error: Error): OpenAI {
  return {
    responses: {
      create: async () => {
        throw error;
      },
    },
  } as unknown as OpenAI;
}

async function captureModelError(source: ModelError): Promise<unknown> {
  const model = new OpenAIModel({
    api: 'responses',
    modelId: 'openai.gpt-5.6-sol',
    client: fakeResponsesClient(source),
  });
  const input = [new Message({ role: 'user', content: [new TextBlock('continue')] })];

  try {
    const stream = model.streamAggregated(input);
    while (!(await stream.next()).done) {
      // The fake rejects before yielding; draining exercises the public Responses path.
    }
  } catch (error) {
    return error;
  }
  throw new Error('fake OpenAI Responses call unexpectedly succeeded');
}

header('context overflow — OpenAI Responses classifier');

const incidentSource = new ModelError(INCIDENT_MESSAGE);
const overflow = await captureModelError(incidentSource);
assert(
  'exact Mantle exceed-model-maximum incident becomes ContextWindowOverflowError',
  overflow instanceof ContextWindowOverflowError && overflow.message === INCIDENT_MESSAGE,
);

const genericSource = new ModelError(GENERIC_MESSAGE);
const generic = await captureModelError(genericSource);
assert(
  'nearby generic provider ModelError remains unchanged',
  generic === genericSource &&
    generic instanceof ModelError &&
    !(generic instanceof ContextWindowOverflowError) &&
    generic.message === GENERIC_MESSAGE,
);

report();
