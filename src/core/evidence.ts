/**
 * Evidence path construction.
 *
 * The harness resolves `evidence.source` with this regex (see `run_evals.py`):
 *
 *   ^(?P<base>[a-z_]+)(?:\[(?P<index>\d+)\])?(?:\.(?P<field>[a-z_][\w]*))?$
 *
 * so a path is at most `collection[index].field`, all lowercase, with no nested
 * object traversal. Anything that fails to parse resolves to `None` and drops
 * the issue's grounding score. Building paths through these helpers rather than
 * by string concatenation keeps every emitted source inside that grammar.
 */

export const LIST_BASES = [
  'documents',
  'labs',
  'vitals',
  'medications',
  'conditions',
] as const;

export const OBJECT_BASES = ['procedure', 'patient', 'metadata'] as const;

export type ListBase = (typeof LIST_BASES)[number];
export type ObjectBase = (typeof OBJECT_BASES)[number];

/** Point at a whole collection — used when the required item is absent entirely. */
export function collectionPath(base: ListBase): string {
  return base;
}

/** Point at a specific element of a collection. */
export function elementPath(base: ListBase, index: number): string {
  return `${base}[${index}]`;
}

/** Point at a field of a specific element. */
export function elementFieldPath(
  base: ListBase,
  index: number,
  field: string
): string {
  return `${base}[${index}].${field}`;
}

/** Point at a field of a top-level object. */
export function fieldPath(base: ObjectBase, field: string): string {
  return `${base}.${field}`;
}

const SOURCE_GRAMMAR = /^[a-z_]+(?:\[\d+\])?(?:\.[a-z_][\w]*)?$/;

/**
 * Mirror of the harness's parser, used in tests to assert that every source we
 * emit is resolvable before we ever spend an eval run finding out.
 */
export function isResolvableSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  if (!SOURCE_GRAMMAR.test(normalized)) return false;

  const base = /^[a-z_]+/.exec(normalized)?.[0] ?? '';
  const hasIndex = normalized.includes('[');
  const hasField = normalized.includes('.');

  if ((LIST_BASES as readonly string[]).includes(base)) {
    // The harness rejects `documents.text` — a field on a list requires an index.
    return !(hasField && !hasIndex);
  }
  if ((OBJECT_BASES as readonly string[]).includes(base)) {
    return !hasIndex;
  }
  return false;
}
