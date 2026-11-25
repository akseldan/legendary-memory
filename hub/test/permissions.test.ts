import { describe, expect, it } from 'vitest';
import { SCOPE_DELETE, SCOPE_READ, SCOPE_WRITE, canDelete } from '../src/core/constants';

describe('canDelete', () => {
  it('lets connections approved before 2026-11-24 keep deleting with write (no v)', () => {
    expect(canDelete([SCOPE_READ, SCOPE_WRITE], { client: 'Claude' })).toBe(true);
  });
  it('needs the delete permission for connections approved since (v 2)', () => {
    expect(canDelete([SCOPE_READ, SCOPE_WRITE], { client: 'Claude', v: 2 })).toBe(false);
    expect(canDelete([SCOPE_READ, SCOPE_WRITE, SCOPE_DELETE], { client: 'Claude', v: 2 })).toBe(true);
  });
  it('never lets a read-only connection delete', () => {
    expect(canDelete([SCOPE_READ], { client: '' })).toBe(false);
    expect(canDelete([SCOPE_READ], { client: '', v: 2 })).toBe(false);
  });
});
