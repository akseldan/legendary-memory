import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKER, ownedByMirror, render, safeName } from '../render.mjs';

const project = (over = {}) => ({
  id: 'p1', slug: 'cooling', name: 'Cooling project', aliases: 'peltier, fridge', status: 'active',
  brief: 'Build a peltier cooler.', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-12T10:00:00Z', ...over,
});

test('safeName strips characters vaults and file systems reject', () => {
  assert.equal(safeName('a/b\\c:d*e?"f<g>h|i#j^k[l]m'), 'a b c d e f g h i j k l m');
  assert.equal(safeName('..hidden'), 'hidden');
  assert.equal(safeName('trailing. '), 'trailing');
  assert.equal(safeName('   '), 'Untitled');
  assert.equal(safeName('x'.repeat(300)).length, 100);
});

test('project note has brief, newest session first, files and chats', () => {
  const files = render({
    projects: [project()],
    checkpoints: [
      { id: 'c1', project_id: 'p1', source: 'claude', title: 'Old', summary: 'first', decisions: '', next_steps: '', created_at: '2026-11-02T00:00:00Z' },
      { id: 'c2', project_id: 'p1', source: 'chatgpt', title: 'New', summary: 'second', decisions: '- use 12V', next_steps: '- buy parts', created_at: '2026-11-10T00:00:00Z' },
    ],
    artifacts: [{ id: 'a1', project_id: 'p1', name: 'wiring.py', kind: 'code', version: 2, source: 'claude', content: 'print(1)', updated_at: '2026-11-11T00:00:00Z' }],
    conversations: [{ id: 'v1', project_id: 'p1', title: 'Kickoff', source: 'chatgpt', started_at: '2024-11-07T00:00:00Z', updated_at: '2026-11-12T00:00:00Z', message_count: 2 }],
    profile: [],
  });
  const note = files.get('Projects/Cooling project.md');
  assert.ok(ownedByMirror(note));
  assert.match(note, /status: "active"/);
  assert.match(note, /aliases:\n {2}- "peltier"\n {2}- "fridge"/);
  assert.match(note, /Build a peltier cooler\./);
  assert.ok(note.indexOf('New') < note.indexOf('Old'), 'newest session first');
  assert.match(note, /\*\*Decisions\*\*\n\n- use 12V/);
  assert.match(note, /\[\[Legendary Memory\/Artifacts\/Cooling project\/wiring\.py\|wiring\.py\]\]/);
  assert.match(note, /Kickoff \(chatgpt, 2024-11-07, 2 messages\)/);
  const artifact = files.get('Artifacts/Cooling project/wiring.py.md');
  assert.match(artifact, /```python\nprint\(1\)\n```/);
  assert.match(artifact, /\[\[Legendary Memory\/Projects\/Cooling project\|Cooling project\]\]/);
});

test('markdown artifacts are not fenced; backticks inside code get a longer fence', () => {
  const files = render({
    projects: [project()],
    artifacts: [
      { id: 'a1', project_id: 'p1', name: 'notes.md', kind: 'markdown', version: 1, content: '# Hi\n\ntext', updated_at: '' },
      { id: 'a2', project_id: 'p1', name: 'readme.txt', kind: 'text', version: 1, content: 'has ``` inside', updated_at: '' },
    ],
  });
  assert.match(files.get('Artifacts/Cooling project/notes.md'), /\n# Hi\n\ntext\n$/);
  assert.match(files.get('Artifacts/Cooling project/readme.txt.md'), /````\nhas ``` inside\n````/);
});

test('projects whose names clash after cleaning get distinct notes', () => {
  const files = render({
    projects: [project(), project({ id: 'p2', slug: 'cooling-2', name: 'Cooling/project', created_at: '2026-11-05T00:00:00Z' })],
  });
  assert.ok(files.has('Projects/Cooling project.md'));
  assert.ok(files.has('Projects/Cooling project (cooling-2).md'));
});

test('about me, index, empty states, and custom root folder', () => {
  const files = render({ projects: [], profile: [{ key: 'answer-style', value: 'short\nand direct' }] }, 'AI Memory');
  assert.match(files.get('About me.md'), /- \*\*answer-style:\*\* short and direct/);
  assert.match(files.get('Projects.md'), /_No projects yet\._/);
  const withProject = render({ projects: [project()] }, 'AI Memory');
  assert.match(withProject.get('Projects.md'), /\[\[AI Memory\/Projects\/Cooling project\|Cooling project\]\]/);
  assert.match(withProject.get('Projects/Cooling project.md'), /_No checkpoints yet\._/);
});

test('ownership marker is required on the first frontmatter line', () => {
  assert.ok(ownedByMirror(`---\n${MARKER}\nstatus: "x"\n---\n`));
  assert.ok(!ownedByMirror('# my own note\nlegendary-memory: mirror'));
  assert.ok(!ownedByMirror('---\ntitle: mine\nlegendary-memory: mirror\n---\n'));
});
