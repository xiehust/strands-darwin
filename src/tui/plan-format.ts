import type { PlanItem, PlanStatus } from '../tools/update-plan.js';

export const PLAN_HISTORY_MAX_ITEMS = 10;

const marker: Record<PlanStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  completed: '[x]',
};

export function planItemText(item: PlanItem): string {
  return `${marker[item.status]} ${item.item}`;
}

/**
 * A plan block consumes one title row and item rows. If the grant cannot show the
 * complete list, its final row states exactly how many items are omitted.
 */
export function planRows(
  plan: readonly PlanItem[],
  maxRows: number,
  title = 'plan',
): readonly string[] {
  if (plan.length === 0 || maxRows <= 0) return [];
  if (maxRows === 1) return [`${title} · ${plan.length} items`];

  const itemCapacity = maxRows - 1;
  const needsNotice = plan.length > itemCapacity;
  const shown = needsNotice ? Math.max(0, itemCapacity - 1) : plan.length;
  const rows = [`${title} · ${plan.length} items`, ...plan.slice(0, shown).map(planItemText)];
  if (needsNotice) rows.push(`… ${plan.length - shown} more plan items`);
  return rows;
}

export function finalPlanRows(plan: readonly PlanItem[]): readonly string[] {
  return planRows(plan, PLAN_HISTORY_MAX_ITEMS + 2, 'plan final');
}
