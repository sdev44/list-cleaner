// Template registry. Adding a use case = add a folder here and register it.
import type { Template } from '../core/template.js';
import { directoryTemplate } from './directory/index.js';

export const TEMPLATES: Record<string, Template<any>> = {
  [directoryTemplate.id]: directoryTemplate
  // Next: 'web-design-leads' (businesses with no website, Facebook-only or a weak site).
};

export function getTemplate(id: string): Template<any> {
  const t = TEMPLATES[id];
  if (!t) throw new Error(`Unknown template "${id}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
  return t;
}
