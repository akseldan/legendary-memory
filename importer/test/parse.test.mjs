import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSource, parseChatGPT, parseClaude, parseConversations, toRequests } from '../parse.mjs';

const node = (id, parent, children, message) => ({ id, parent, children, message });
const msg = (role, parts, extra = {}) => ({
  author: { role },
  create_time: 1,
  content: { content_type: 'text', parts },
  metadata: {},
  ...extra,
});

/** root -> sys(hidden) -> user -> [assistant A (abandoned), assistant B -> user2 -> assistant2 (current)] */
function chatgptFixture() {
  return {
    id: 'abc',
    conversation_id: 'conv-1',
    title: 'Cooling plan',
    create_time: 1700000000.5,
    current_node: 'a2',
    mapping: {
      root: node('root', null, ['sys'], null),
      sys: node('sys', 'root', ['u1'], msg('system', [''], { metadata: { is_visually_hidden_from_conversation: true } })),
      u1: node('u1', 'sys', ['aA', 'aB'], msg('user', ['How do I cool the bay?'])),
      aA: node('aA', 'u1', [], msg('assistant', ['ABANDONED branch'])),
      aB: node('aB', 'u1', ['u2'], msg('assistant', ['Use a thermistor fan.'])),
      u2: node('u2', 'aB', ['t1'], msg('user', ['Which fan?', {}])),
      t1: node('t1', 'u2', ['a2'], msg('assistant', [''], { content: { content_type: 'thoughts', thoughts: [] } })),
      a2: node('a2', 't1', [], msg('assistant', ['A 40mm PWM fan.'], { create_time: 9 })),
    },
  };
}

test('ChatGPT: follows the kept branch, skips hidden, empty and non-text nodes', () => {
  const c = parseChatGPT(chatgptFixture());
  assert.deepEqual(
    c.messages.map((m) => [m.seq, m.role, m.text]),
    [
      [0, 'user', 'How do I cool the bay?'],
      [1, 'assistant', 'Use a thermistor fan.'],
      [2, 'user', 'Which fan?'],
      [3, 'assistant', 'A 40mm PWM fan.'],
    ],
  );
  assert.equal(c.external_id, 'conv-1');
  assert.equal(c.title, 'Cooling plan');
  assert.equal(c.source, 'chatgpt');
  assert.equal(c.url, 'https://chatgpt.com/c/conv-1');
  assert.equal(c.started_at, '2023-11-14T22:13:20.500Z');
  assert.ok(!c.messages.some((m) => /ABANDONED/.test(m.text)));
});

test('ChatGPT: survives a missing current_node and a cycle', () => {
  const fixture = chatgptFixture();
  delete fixture.current_node;
  assert.equal(parseChatGPT(fixture).messages.at(-1).text, 'A 40mm PWM fan.');
  const loop = chatgptFixture();
  loop.mapping.root.parent = 'a2';
  assert.ok(parseChatGPT(loop).messages.length > 0);
});

test('ChatGPT: code blocks are kept as fenced text', () => {
  const fixture = chatgptFixture();
  fixture.mapping.a2.message.content = { content_type: 'code', language: 'python', text: 'print(1)' };
  assert.match(parseChatGPT(fixture).messages.at(-1).text, /^```python\nprint\(1\)\n```$/);
});

test('ChatGPT: a conversation with no id is rejected', () => {
  assert.equal(parseChatGPT({ mapping: {} }), undefined);
});

const claudeFixture = () => ({
  uuid: 'u-1',
  name: 'Fan chat',
  created_at: '2026-01-15T10:30:00.000Z',
  chat_messages: [
    { sender: 'human', text: 'Hello' },
    { sender: 'assistant', text: '', content: [{ type: 'text', text: 'Hi there' }, { type: 'tool_use' }] },
    { sender: 'assistant', text: '' },
    { sender: 'system', text: 'ignored' },
  ],
});

test('Claude: maps senders, falls back to content blocks, drops empties', () => {
  const c = parseClaude(claudeFixture());
  assert.deepEqual(c.messages, [
    { seq: 0, role: 'user', text: 'Hello' },
    { seq: 1, role: 'assistant', text: 'Hi there' },
  ]);
  assert.equal(c.skipped, 2);
  assert.equal(c.url, 'https://claude.ai/chat/u-1');
  assert.equal(c.started_at, '2026-01-15T10:30:00.000Z');
});

test('Claude: accepts the messages/role variant', () => {
  const c = parseClaude({ uuid: 'x', messages: [{ role: 'user', text: 'hi' }] });
  assert.equal(c.messages[0].role, 'user');
});

test('detectSource tells the two apart', () => {
  assert.equal(detectSource([chatgptFixture()]), 'chatgpt');
  assert.equal(detectSource([claudeFixture()]), 'claude');
  assert.equal(detectSource([{ foo: 1 }]), undefined);
  assert.equal(detectSource([]), undefined);
});

test('parseConversations counts unreadable entries', () => {
  const r = parseConversations([chatgptFixture(), null, { mapping: {} }]);
  assert.equal(r.parsed.length, 1);
  assert.equal(r.unreadable, 2);
});

test('toRequests: short chat is one request without the skipped counter', () => {
  const [body, ...rest] = toRequests(parseClaude(claudeFixture()));
  assert.equal(rest.length, 0);
  assert.equal('skipped' in body, false);
  assert.equal(body.messages.length, 2);
});

test('toRequests: long chat is split, numbering and id preserved, head sent once', () => {
  const messages = Array.from({ length: 3200 }, (_, seq) => ({ seq, role: 'user', text: 'x' }));
  const bodies = toRequests({ source: 'claude', external_id: 'big', title: 'T', url: 'https://claude.ai/chat/big', started_at: '2026-01-01T00:00:00.000Z', messages, skipped: 0 });
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((b) => b.messages.length <= 1500 && b.external_id === 'big'));
  assert.deepEqual(bodies.flatMap((b) => b.messages.map((m) => m.seq)), messages.map((m) => m.seq));
  assert.equal(bodies[0].title, 'T');
  assert.equal(bodies[1].title, undefined);
});

test('toRequests: splits by size, and cuts a huge single message', () => {
  const big = 'y'.repeat(400_000);
  const bodies = toRequests({ source: 'chatgpt', external_id: 'sz', messages: [0, 1, 2, 3].map((seq) => ({ seq, role: 'user', text: big })) });
  assert.ok(bodies.length >= 2);
  assert.ok(bodies.every((b) => Buffer.byteLength(JSON.stringify(b)) < 1_400_000));
  const cut = parseChatGPT({ conversation_id: 'z', current_node: 'm', mapping: { m: node('m', null, [], msg('user', ['z'.repeat(400_000)])) } });
  assert.match(cut.messages[0].text, /\[cut: message was longer/);
});
