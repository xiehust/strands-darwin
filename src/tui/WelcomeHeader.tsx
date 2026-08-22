import { Box, Text } from 'ink';
import React from 'react';

import { visualColor } from './visual-language.js';

export type WelcomeVariant = 'wide' | 'medium' | 'compact';

export interface WelcomeLayout {
  readonly variant: WelcomeVariant;
  /** Immutable rows committed by the welcome's one-item Static owner. */
  readonly lines: readonly string[];
  /** Number of leading rows that belong to the geometric wordmark. */
  readonly brandRows: number;
  readonly marginBottom: 0 | 1;
}

export const WIDE_WELCOME_WORDMARK = [
  '██████╗  █████╗ ██████╗ ██╗    ██╗██╗███╗   ██╗',
  '██╔══██╗██╔══██╗██╔══██╗██║    ██║██║████╗  ██║',
  '██║  ██║███████║██████╔╝██║ █╗ ██║██║██╔██╗ ██║',
  '██║  ██║██╔══██║██╔══██╗██║███╗██║██║██║╚██╗██║',
  '██████╔╝██║  ██║██║  ██║╚███╔███╔╝██║██║ ╚████║',
] as const;

export const MEDIUM_WELCOME_WORDMARK = [
  '█▀▄  ▄▀█  █▀█  █ █ █  █  █▄ █',
  '█ █  █▀█  ██▄  █▄█▄█  █  █ ▀█',
  '▀▀   ▀ ▀  ▀ ▀   ▀ ▀   ▀  ▀  ▀',
] as const;

const WIDE_TAGLINE = '              coding through iteration';
const MEDIUM_TAGLINE = '       coding through iteration';
const COMPACT_WELCOME = '◆ DARWIN';

// These are terminal-cell thresholds, not JavaScript string lengths. The current
// hand-maintained rows are all single-cell glyphs, and the boundary render tests
// pin that fact so a future wordmark edit cannot silently reintroduce truncation.
const WIDE_MIN_COLUMNS = 47;
const MEDIUM_MIN_COLUMNS = 38;

/**
 * Chooses a complete hand-maintained welcome before Ink renders it.
 *
 * The vertical thresholds leave room for the ordinary ready header and prompt
 * during the initial handoff. The selected rows are never assembled or clipped
 * dynamically: each variant is a complete textual identity without colour.
 */
export function welcomeLayout(columns: number, rows: number): WelcomeLayout {
  if (columns >= WIDE_MIN_COLUMNS && rows >= 18) {
    return {
      variant: 'wide',
      lines: [...WIDE_WELCOME_WORDMARK, WIDE_TAGLINE],
      brandRows: WIDE_WELCOME_WORDMARK.length,
      marginBottom: 1,
    };
  }
  if (columns >= MEDIUM_MIN_COLUMNS && rows >= 10) {
    return {
      variant: 'medium',
      lines: [...MEDIUM_WELCOME_WORDMARK, MEDIUM_TAGLINE],
      brandRows: MEDIUM_WELCOME_WORDMARK.length,
      marginBottom: 1,
    };
  }
  return {
    variant: 'compact',
    lines: [COMPACT_WELCOME],
    brandRows: 1,
    marginBottom: 0,
  };
}

/**
 * One presentation-only ready-state welcome committed to terminal scrollback.
 *
 * It is the first presentation-only item in MessageList's existing Static owner:
 * not turn history, trajectory/replay content, measured header furniture, or a
 * frame-budget participant. The successor transcript omits it after `/clear`.
 */
export function WelcomeHeader({ layout }: { readonly layout: WelcomeLayout }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={layout.marginBottom}>
      {layout.lines.map((line, index) => {
        const branded = index < layout.brandRows;
        return (
          <Text
            key={index}
            {...(branded ? { color: visualColor.identity } : {})}
            bold={branded}
            dimColor={!branded}
            wrap="truncate-end"
          >
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
