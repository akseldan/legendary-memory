import { describe, expect, it } from 'vitest';
import type { Db } from "../src/core/db";
import { resolveProject, type Project } from '../src/core/store';

function project(name: string, aliases = ''): Project {
  return {
    id: name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    aliases,
    status: 'active',
    brief: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** A stand-in for D1 that returns a fixed project list. */
const dbWith = (...projects: Project[]) =>
  ({ prepare: () => ({ all: async () => ({ results: projects }) }) }) as unknown as Db;

describe('resolveProject', () => {
  const cooling = project('Cooling System');
  const rocket = project('Rocket Flight Computer', 'avionics, flight computer');
  const db = dbWith(cooling, rocket);

  it('matches the exact name', async () => {
    const r = await resolveProject(db, 'Cooling System');
    expect(r.match?.name).toBe('Cooling System');
    expect(r.fuzzy).toBe(false);
  });
  it('matches case-insensitively', async () => {
    const r = await resolveProject(db, 'cooling system');
    expect(r.match?.name).toBe('Cooling System');
    expect(r.fuzzy).toBe(false);
  });
  it('matches a loose phrase', async () => {
    const r = await resolveProject(db, 'the cooling project');
    expect(r.match?.name).toBe('Cooling System');
  });
  it('matches an alias', async () => {
    const r = await resolveProject(db, 'avionics');
    expect(r.match?.name).toBe('Rocket Flight Computer');
  });
  it('flags a one-letter typo as fuzzy', async () => {
    const r = await resolveProject(db, 'Coolng System');
    expect(r.match?.name).toBe('Cooling System');
    expect(r.fuzzy).toBe(true);
  });
  it('flags "cooking project" as fuzzy', async () => {
    const r = await resolveProject(db, 'cooking project');
    expect(r.match?.name).toBe('Cooling System');
    expect(r.fuzzy).toBe(true);
  });
  it('finds nothing for an unrelated name', async () => {
    const r = await resolveProject(db, 'Tax filing');
    expect(r.match).toBeUndefined();
    expect(r.candidates).toEqual([]);
  });
  it('does not pick a winner between two close projects', async () => {
    const both = dbWith(project('Rocket Avionics'), project('Rocket Airframe'));
    const r = await resolveProject(both, 'rocket');
    expect(r.match).toBeUndefined();
    expect(r.candidates.length).toBe(2);
  });
  it('returns nothing for an empty reference', async () => {
    const r = await resolveProject(db, '   ');
    expect(r.match).toBeUndefined();
  });
});
