import {describe, expect, it} from 'vitest';
import {
  collectionPath,
  elementFieldPath,
  elementPath,
  fieldPath,
  isResolvableSource,
} from './evidence.js';

describe('path builders', () => {
  it('builds the shapes the harness resolves', () => {
    expect(collectionPath('labs')).toBe('labs');
    expect(elementPath('documents', 4)).toBe('documents[4]');
    expect(elementFieldPath('labs', 0, 'effective_at')).toBe(
      'labs[0].effective_at'
    );
    expect(fieldPath('procedure', 'procedure_date')).toBe(
      'procedure.procedure_date'
    );
  });

  // The worked example in the brief cites `documents[4]` for the fifth document
  // and `medications[1]` for the second medication, which only lines up under
  // zero-based indexing.
  it('indexes from zero', () => {
    expect(elementPath('documents', 0)).toBe('documents[0]');
    expect(elementPath('medications', 1)).toBe('medications[1]');
  });
});

describe('isResolvableSource', () => {
  it.each([
    'documents',
    'documents[0]',
    'documents[4]',
    'labs',
    'labs[0].effective_at',
    'vitals[2]',
    'medications[1]',
    'conditions',
    'procedure.procedure_date',
    'procedure.procedure_risk',
    'patient.dob',
    'metadata.source_system',
  ])('accepts %j', source => {
    expect(isResolvableSource(source)).toBe(true);
  });

  it.each([
    // A field on a list requires an index — the harness rejects this outright.
    'documents.text',
    'labs.code',
    // An index on a top-level object is meaningless.
    'procedure[0]',
    // Unknown bases resolve to nothing.
    'encounters[0]',
    'foo.bar',
    // Nested traversal is beyond the grammar (one `.field` only).
    'patient.name.given',
    // Malformed brackets.
    'documents[]',
    'documents[x]',
    'documents[0',
    '',
  ])('rejects %j', source => {
    expect(isResolvableSource(source)).toBe(false);
  });
});
