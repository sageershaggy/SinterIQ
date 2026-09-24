import fs from 'node:fs';
import type { CriteriaTemplate } from '../shared/types';

/**
 * The qualification criteria documents in docs/qualification-criteria, offered in the Training
 * library so a project can start from one instead of a blank page. Added to a project, a
 * template is an ordinary training document: Train AI reads it into draft rules, and nothing
 * qualifies a lead until someone publishes.
 *
 * Read on request, never at startup: an image built without the folder offers no templates
 * rather than failing to boot. Only files named in this folder can be read, by an id that
 * cannot leave it.
 */
const folder = new URL('../docs/qualification-criteria/', import.meta.url);
/** The owner's categories first, the blank template last; anything added later in between. */
const order = [
  'ai-app-development',
  'marketing-assistant',
  'event-participants',
  'funded-companies',
];
const blank = 'criteria-template';
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function describe(id: string, content: string): CriteriaTemplate {
  if (id === blank)
    return {
      id,
      title: 'Blank template',
      summary: 'Every section with prompts, for a category that has no document yet.',
    };
  const heading = /^#\s+(.+)$/m.exec(content)?.[1] || id;
  const summary = /^##\s+Summary\s*\n+([\s\S]*?)(?:\n\s*\n|$)/m.exec(content)?.[1] || '';
  const title = heading.replace(/^Qualification criteria:\s*/i, '').trim();
  return {
    id,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    summary: summary.replace(/\s+/g, ' ').trim().slice(0, 400),
  };
}

function read(id: string) {
  if (!idPattern.test(id) || id === 'readme') return null;
  try {
    return fs.readFileSync(new URL(id + '.md', folder), 'utf8');
  } catch {
    return null;
  }
}

export function listCriteriaTemplates(): CriteriaTemplate[] {
  let ids: string[];
  try {
    ids = fs
      .readdirSync(folder)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .filter((id) => idPattern.test(id) && id !== 'README' && id !== 'readme');
  } catch {
    return [];
  }
  const rank = (id: string) =>
    id === blank ? order.length + 1 : order.includes(id) ? order.indexOf(id) : order.length;
  return ids
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .flatMap((id) => {
      const content = read(id);
      return content ? [describe(id, content)] : [];
    });
}

export function criteriaTemplate(id: string): (CriteriaTemplate & { content: string }) | null {
  const content = read(id);
  return content ? { ...describe(id, content), content } : null;
}
