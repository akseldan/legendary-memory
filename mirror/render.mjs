// Turns exported hub data into Markdown notes for an Obsidian vault. Pure: no file or
// network access, so it can be tested on its own. mirror.mjs does the reading and writing.

export const MARKER = 'legendary-memory: mirror';
const MAX_CHECKPOINTS = 20;
const MAX_CHATS = 50;

/** A file name Obsidian, macOS, Windows and iCloud all accept. */
export function safeName(name, fallback = 'Untitled') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 100)
    .trim();
  return cleaned || fallback;
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
const yaml = (value) => JSON.stringify(String(value ?? '')); // JSON strings are valid YAML

function frontmatter(fields) {
  const lines = ['---', MARKER]; // first line after --- marks files the mirror owns
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${key}:`, ...value.map((v) => `  - ${yaml(v)}`));
    } else if (value !== undefined && value !== '') {
      lines.push(`${key}: ${yaml(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

const NOTICE =
  '> [!info] Mirrored from Legendary Memory. Edits here are overwritten on the next mirror run;\n' +
  '> change things through your assistant (save_checkpoint, remember, forget) instead.\n';

const FENCE_LANG = {
  py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', rs: 'rust', go: 'go', sh: 'bash', json: 'json',
  jsonc: 'json', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css', sql: 'sql', csv: 'csv',
  toml: 'toml', xml: 'xml', swift: 'swift', kt: 'kotlin',
};

function fenced(text, lang) {
  // Use a fence longer than any run of backticks inside the text.
  const longest = Math.max(2, ...(String(text).match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}\n`;
}

/**
 * Builds the set of notes. `data` holds arrays from /api/export: projects, checkpoints,
 * artifacts (with content), profile, conversations. `root` is the folder name inside the
 * vault, used for links. Returns a Map of relative path → file text.
 */
export function render(data, root = 'Legendary Memory') {
  const files = new Map();
  const link = (path, label) => `[[${root}/${path.replace(/\.md$/, '')}|${label}]]`;

  // Give every project a unique note name, oldest project first so names stay stable.
  const projects = [...(data.projects ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const noteName = new Map();
  const taken = new Set();
  for (const p of projects) {
    let name = safeName(p.name);
    if (taken.has(name.toLowerCase())) name = `${name} (${safeName(p.slug || p.id).slice(0, 12)})`;
    taken.add(name.toLowerCase());
    noteName.set(p.id, name);
  }

  const byProject = (rows) => {
    const groups = new Map();
    for (const row of rows ?? []) {
      if (!groups.has(row.project_id)) groups.set(row.project_id, []);
      groups.get(row.project_id).push(row);
    }
    return groups;
  };
  const checkpoints = byProject(data.checkpoints);
  const artifacts = byProject(data.artifacts);
  const chats = byProject(data.conversations);

  for (const p of projects) {
    const name = noteName.get(p.id);
    const projectPath = `Projects/${name}.md`;
    const own = (checkpoints.get(p.id) ?? []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const files_ = (artifacts.get(p.id) ?? []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const convs = (chats.get(p.id) ?? []).sort((a, b) =>
      String(b.started_at || b.updated_at).localeCompare(String(a.started_at || a.updated_at)),
    );

    const out = [
      frontmatter({
        status: p.status,
        created: day(p.created_at),
        updated: day(p.updated_at),
        aliases: String(p.aliases ?? '').split(',').map((a) => a.trim()).filter(Boolean),
        tags: ['legendary-memory'],
      }),
      `# ${p.name}\n`,
      NOTICE,
      '## Brief\n',
      (p.brief?.trim() || '_No brief yet._') + '\n',
    ];

    // Artifact notes first, so the project note can link to their final names.
    const artifactLinks = [];
    const usedArtifactNames = new Set();
    for (const a of files_) {
      let base = safeName(a.name, 'file');
      if (usedArtifactNames.has(base.toLowerCase())) base = `${base} (${String(a.id).slice(0, 8)})`;
      usedArtifactNames.add(base.toLowerCase());
      const isMarkdown = /\.md$/i.test(base) || a.kind === 'markdown';
      const path = `Artifacts/${name}/${base.replace(/\.md$/i, '')}.md`;
      const ext = (String(a.name).match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
      const body = String(a.content ?? '');
      files.set(
        path,
        frontmatter({ project: p.name, kind: a.kind, version: a.version, source: a.source, updated: day(a.updated_at) }) +
          `# ${a.name}\n\nFrom ${link(projectPath, p.name)} · v${a.version} · ${day(a.updated_at)}\n\n` +
          (isMarkdown ? body.trim() + '\n' : fenced(body, FENCE_LANG[ext] ?? '')),
      );
      artifactLinks.push(`- ${link(path, a.name)} (${a.kind}, v${a.version}, ${day(a.updated_at)})`);
    }

    out.push('\n## Sessions\n');
    if (!own.length) out.push('_No checkpoints yet._\n');
    for (const c of own.slice(0, MAX_CHECKPOINTS)) {
      out.push(`### ${day(c.created_at)} · ${c.title}${c.source ? ` (${c.source})` : ''}\n`, c.summary.trim() + '\n');
      if (c.decisions?.trim()) out.push('**Decisions**\n', c.decisions.trim() + '\n');
      if (c.next_steps?.trim()) out.push('**Next steps**\n', c.next_steps.trim() + '\n');
    }
    if (own.length > MAX_CHECKPOINTS) out.push(`_${own.length - MAX_CHECKPOINTS} older sessions not shown; ask your assistant to recall them._\n`);

    if (artifactLinks.length) out.push('\n## Files\n', artifactLinks.join('\n') + '\n');
    if (convs.length) {
      out.push('\n## Linked chats\n');
      out.push(
        convs
          .slice(0, MAX_CHATS)
          .map((c) => `- ${c.title || 'Untitled'} (${c.source}, ${day(c.started_at || c.updated_at)}, ${c.message_count} messages)`)
          .join('\n') + '\n',
      );
    }
    files.set(projectPath, out.join('\n'));
  }

  // Facts about you.
  const profile = [...(data.profile ?? [])].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  files.set(
    'About me.md',
    frontmatter({ tags: ['legendary-memory'] }) +
      '# About me\n\n' +
      NOTICE +
      '\n' +
      (profile.length ? profile.map((f) => `- **${f.key}:** ${String(f.value).replace(/\n+/g, ' ')}`).join('\n') + '\n' : '_Nothing saved yet._\n'),
  );

  // An index of projects, newest activity first.
  const recent = [...projects].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  files.set(
    'Projects.md',
    frontmatter({ tags: ['legendary-memory'] }) +
      '# Projects\n\n' +
      NOTICE +
      '\n' +
      (recent.length
        ? recent.map((p) => `- ${link(`Projects/${noteName.get(p.id)}.md`, p.name)} · ${p.status} · updated ${day(p.updated_at)}`).join('\n') + '\n'
        : '_No projects yet._\n'),
  );

  return files;
}

/** True when a file's text was written by this mirror (so it may be replaced or removed). */
export function ownedByMirror(text) {
  return /^---\r?\n/.test(text) && text.split(/\r?\n/, 3)[1] === MARKER;
}
