// Turns ChatGPT and Claude export files into the hub's /api/ingest/conversation shape.
// Pure functions, no I/O, so they can be tested without any real chat data.

const MAX_MESSAGE_CHARS = 300_000; // a single message longer than this is cut, with a marker
const MAX_CHUNK_BYTES = 900_000; // the hub refuses request bodies over 1.5 MB
const MAX_CHUNK_MESSAGES = 1500; // the hub accepts at most 2000 messages per request

const iso = (value) => {
  if (value == null || value === '') return undefined;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

const clip = (text) =>
  text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n[cut: message was longer than ${MAX_MESSAGE_CHARS} characters]` : text;

/** Which service produced this list of conversations. */
export function detectSource(conversations) {
  const first = Array.isArray(conversations) ? conversations.find((c) => c && typeof c === 'object') : undefined;
  if (!first) return undefined;
  if (first.mapping && typeof first.mapping === 'object') return 'chatgpt';
  if (Array.isArray(first.chat_messages) || (Array.isArray(first.messages) && first.uuid)) return 'claude';
  return undefined;
}

// ---------------------------------------------------------------------------- ChatGPT

function chatgptText(message) {
  const content = message.content;
  if (!content || typeof content !== 'object') return '';
  const type = content.content_type;
  if (type === 'code') return typeof content.text === 'string' ? `\`\`\`${content.language ?? ''}\n${content.text}\n\`\`\`` : '';
  if (type !== 'text' && type !== 'multimodal_text') return ''; // thoughts, tool output, browsing: not conversation
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.filter((part) => typeof part === 'string').join('\n').trim();
}

/** The path from the root to current_node: the branch the user actually kept. */
function chatgptPath(conversation) {
  const mapping = conversation.mapping ?? {};
  const path = [];
  const seen = new Set();
  let id = conversation.current_node;
  if (!id || !mapping[id]) {
    // No usable pointer: fall back to the newest leaf.
    const leaves = Object.entries(mapping).filter(([, node]) => !node.children || node.children.length === 0);
    leaves.sort(([, a], [, b]) => (b.message?.create_time ?? 0) - (a.message?.create_time ?? 0));
    id = leaves[0]?.[0];
  }
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    path.push(mapping[id]);
    id = mapping[id].parent;
  }
  return path.reverse();
}

export function parseChatGPT(conversation) {
  const externalId = String(conversation.conversation_id ?? conversation.id ?? '');
  if (!externalId) return undefined;
  const messages = [];
  let skipped = 0;
  for (const node of chatgptPath(conversation)) {
    const message = node.message;
    if (!message) continue;
    const role = message.author?.role;
    const hidden = message.metadata?.is_visually_hidden_from_conversation === true;
    if (hidden || (role !== 'user' && role !== 'assistant')) {
      skipped++;
      continue;
    }
    const text = chatgptText(message);
    if (!text) {
      skipped++;
      continue;
    }
    messages.push({ seq: messages.length, role, text: clip(text) });
  }
  return {
    source: 'chatgpt',
    external_id: externalId,
    title: typeof conversation.title === 'string' ? conversation.title : '',
    url: `https://chatgpt.com/c/${externalId}`,
    started_at: iso(conversation.create_time),
    messages,
    skipped,
  };
}

// ----------------------------------------------------------------------------- Claude

function claudeText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

export function parseClaude(conversation) {
  const externalId = String(conversation.uuid ?? conversation.id ?? '');
  if (!externalId) return undefined;
  const raw = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : (conversation.messages ?? []);
  const messages = [];
  let skipped = 0;
  for (const message of raw) {
    const who = message.sender ?? message.role;
    const role = who === 'human' || who === 'user' ? 'user' : who === 'assistant' ? 'assistant' : undefined;
    const text = role ? claudeText(message) : '';
    if (!text) {
      skipped++;
      continue;
    }
    messages.push({ seq: messages.length, role, text: clip(text) });
  }
  return {
    source: 'claude',
    external_id: externalId,
    title: typeof conversation.name === 'string' ? conversation.name : '',
    url: `https://claude.ai/chat/${externalId}`,
    started_at: iso(conversation.created_at),
    messages,
    skipped,
  };
}

export function parseConversations(conversations, source = detectSource(conversations)) {
  const parse = source === 'chatgpt' ? parseChatGPT : source === 'claude' ? parseClaude : undefined;
  if (!parse) return { source, parsed: [], unreadable: Array.isArray(conversations) ? conversations.length : 0 };
  const parsed = [];
  let unreadable = 0;
  for (const conversation of conversations) {
    const result = conversation && typeof conversation === 'object' ? parse(conversation) : undefined;
    if (result) parsed.push(result);
    else unreadable++;
  }
  return { source, parsed, unreadable };
}

// ----------------------------------------------------------------------------- upload

/**
 * Splits one parsed conversation into request bodies the hub will accept. Every piece keeps
 * the same external_id and the original message numbers, so the hub stitches them together.
 */
export function toRequests(conversation) {
  const { skipped: _skipped, messages, ...head } = conversation;
  const bodies = [];
  let current = [];
  let bytes = 0;
  const flush = () => {
    bodies.push({ ...head, messages: current });
    current = [];
    bytes = 0;
  };
  for (const message of messages) {
    const size = Buffer.byteLength(message.text) + 80;
    if (current.length > 0 && (bytes + size > MAX_CHUNK_BYTES || current.length >= MAX_CHUNK_MESSAGES)) flush();
    current.push(message);
    bytes += size;
  }
  if (current.length > 0 || bodies.length === 0) flush();
  return bodies.map((body, index) => (index === 0 ? body : { ...body, title: undefined, url: undefined, started_at: undefined }));
}
