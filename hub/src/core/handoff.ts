/**
 * A Markdown handoff for one project (execution plan P8.2.1): something a person can read, or
 * paste into an assistant that cannot connect to the memory. Built only from what is stored.
 */
import type { Db } from './db';
import * as store from './store';

const SESSIONS = 10;

export async function projectHandoff(db: Db, projectId: string, now = new Date()): Promise<{ name: string; markdown: string } | null> {
  const project = await store.getProject(db, projectId);
  if (!project) return null;
  const [checkpoints, files] = await Promise.all([store.recentCheckpoints(db, project.id, SESSIONS), store.listArtifacts(db, project.id)]);
  const day = (iso: string) => iso.slice(0, 10);
  const lines: string[] = [
    `# ${project.name}`,
    '',
    `Handoff from Legendary Memory, made ${day(now.toISOString())}. Status: ${project.status}. Last updated ${day(project.updated_at)}.`,
    'Paste this into an assistant to continue the project. Save a checkpoint afterwards so the memory stays current.',
    '',
    '## Brief',
    '',
    project.brief.trim() || '_No brief written yet._',
  ];
  lines.push('', `## Recent sessions${checkpoints.length === SESSIONS ? ` (newest ${SESSIONS})` : ''}`, '');
  if (!checkpoints.length) lines.push('_No sessions saved yet._');
  for (const c of checkpoints) {
    lines.push(`### ${day(c.created_at)} · ${c.source} · ${c.title}`, '', c.summary.trim());
    if (c.decisions.trim()) lines.push('', '**Decisions**', '', c.decisions.trim());
    if (c.next_steps.trim()) lines.push('', '**Next steps**', '', c.next_steps.trim());
    lines.push('');
  }
  if (files.length) {
    lines.push('## Saved files', '', ...files.map((f) => `- ${f.name} (${f.kind}, version ${f.version}, ${day(f.updated_at)})`), '');
  }
  return { name: project.name, markdown: `${lines.join('\n').trimEnd()}\n` };
}
