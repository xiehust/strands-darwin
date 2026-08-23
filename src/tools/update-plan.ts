import { tool } from '@strands-agents/sdk';
import type { InvokableTool } from '@strands-agents/sdk';
import { z } from 'zod';

export const UPDATE_PLAN_TOOL_NAME = 'update_plan';
export const MAX_PLAN_ITEMS = 20;
export const MAX_PLAN_ITEM_CODE_POINTS = 200;
export const MAX_PLAN_CODE_POINTS = 2_000;

export const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export interface PlanItem {
  readonly item: string;
  readonly status: PlanStatus;
}

function codePoints(value: string): number {
  return [...value].length;
}

const itemSchema = z.object({
  item: z.string()
    .trim()
    .min(1, 'item must not be empty')
    .refine((value) => codePoints(value) <= MAX_PLAN_ITEM_CODE_POINTS, {
      message: `item must be at most ${MAX_PLAN_ITEM_CODE_POINTS} code points`,
    }),
  status: z.enum(PLAN_STATUSES),
}).strict();

export const updatePlanInputSchema = z.object({
  plan: z.array(itemSchema)
    .min(1, 'plan must contain at least one item')
    .max(MAX_PLAN_ITEMS, `plan must contain at most ${MAX_PLAN_ITEMS} items`)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      let total = 0;
      for (const [index, entry] of items.entries()) {
        total += codePoints(entry.item);
        if (seen.has(entry.item)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'plan items must be unique',
            path: [index, 'item'],
          });
        }
        seen.add(entry.item);
      }
      if (total > MAX_PLAN_CODE_POINTS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `plan item text must total at most ${MAX_PLAN_CODE_POINTS} code points`,
        });
      }
    }),
}).strict();

export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

/** Decode only values that satisfy the tool's complete public contract. */
export function parsePlanInput(value: unknown): readonly PlanItem[] | undefined {
  const parsed = updatePlanInputSchema.safeParse(value);
  return parsed.success ? parsed.data.plan : undefined;
}

/**
 * Parent-agent advisory state only. The callback intentionally performs no I/O;
 * the ordinary SDK call/result events are the sole durable evidence of an update.
 */
export function createUpdatePlanTool(): InvokableTool<UpdatePlanInput, string> {
  return tool<typeof updatePlanInputSchema, string>({
    name: UPDATE_PLAN_TOOL_NAME,
    description:
      'Replaces the parent agent progress checklist with this complete list. ' +
      'Use for non-trivial work and update it as progress changes. ' +
      'Statuses are pending, in_progress, and completed; completed means the item and its required verification are finished.',
    inputSchema: updatePlanInputSchema,
    callback: ({ plan }) => `Plan updated: ${plan.length} ${plan.length === 1 ? 'item' : 'items'}.`,
  });
}
