/**
 * The workspace-trust modal (SER-090): the one question asked before the runtime
 * exists in a project whose checkout would arm hook commands, MCP servers or legacy
 * allow rules. Rendered by `runInteractive` in place of the startup screen, so it
 * owns the terminal alone — there is no header, tool panel or composer to share the
 * frame with — and resolves exactly once through `onDecision`.
 *
 * Every row is one `<Text wrap="truncate-end">`: the row count is the row count, and
 * `trustPromptRows` has already bounded it to the viewport. Keys mirror the permission
 * box (`y` / `n`, Escape as the "not now" answer) so the user learns one vocabulary.
 */
import { Box, Text, useInput, useWindowSize } from 'ink';
import React, { useRef } from 'react';

import type { WorkspaceTrust } from '../agent/workspace-trust.js';
import { trustPromptRows } from './trust-format.js';
import { visualColor, visualMarker } from './visual-language.js';

export type TrustAnswer = 'accept' | 'decline' | 'decline-session';

export function WorkspaceTrustPrompt({
  trust,
  projectRoot,
  onDecision,
}: {
  readonly trust: WorkspaceTrust;
  readonly projectRoot: string;
  readonly onDecision: (answer: TrustAnswer) => void;
}): React.JSX.Element {
  const { rows: terminalRows } = useWindowSize();
  const answered = useRef(false);
  const decide = (answer: TrustAnswer): void => {
    if (answered.current) return;
    answered.current = true;
    onDecision(answer);
  };
  useInput((typed, key) => {
    if (typed === 'y' || typed === 'Y' || key.return) decide('accept');
    else if (typed === 'n' || typed === 'N') decide('decline');
    else if (key.escape) decide('decline-session');
  });

  const rows = trustPromptRows(trust, projectRoot, terminalRows);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={visualColor.identity} bold>{visualMarker.permission} </Text>
        <Text bold>{rows.title}</Text>
      </Text>
      <Text wrap="truncate-end">  {rows.intro}</Text>
      {rows.items.map((item, index) => (
        <Text key={index} wrap="truncate-end" color={visualColor.warning}>  {item}</Text>
      ))}
      <Text wrap="truncate-end" dimColor>  {rows.consequence}</Text>
      <Text wrap="truncate-end">
        <Text bold>  trust? </Text>
        <Text color={visualColor.success} bold>y</Text>
        <Text> accept · </Text>
        <Text color={visualColor.danger} bold>n</Text>
        <Text> decline · </Text>
        <Text bold>esc</Text>
        <Text> decline for this session only (nothing stored)</Text>
      </Text>
    </Box>
  );
}
