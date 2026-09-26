/** Pure canonical user grammar; safe to import from bounded local help. */
export const COLLABORATION_GRAMMAR = [
  '/collaborate [status|list|pending|relations|on|off]',
  '/collaborate send <endpoint-uuid> <literal text>',
  '/collaborate confirm <pending-id> --persist; /collaborate revoke <pair-id>',
] as const;
export const COLLABORATE_USAGE = COLLABORATION_GRAMMAR.join('; ');
