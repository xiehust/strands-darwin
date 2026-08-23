import { Box, Text } from 'ink';
import React from 'react';

import type { PlanItem } from '../tools/update-plan.js';
import { planRows } from './plan-format.js';

/** Live-only checklist. Every row is one truncating Text and therefore one visual row. */
export function PlanChecklist({ plan, maxRows }: {
  readonly plan: readonly PlanItem[];
  readonly maxRows: number;
}): React.JSX.Element | null {
  const rows = planRows(plan, maxRows);
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => <Text key={`${index}:${row}`} wrap="truncate-end">{row}</Text>)}
    </Box>
  );
}
