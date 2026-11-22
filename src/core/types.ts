// Shared types. A Row is one business, keyed by canonical field names (see columns.ts).

export type Row = Record<string, string>;

/** Internal outcome. Each template gives these its own labels (e.g. Clean / Review / Rejected). */
export type Outcome = 'keep' | 'review' | 'remove';

export interface Decision {
  outcome: Outcome;
  reason: string;
  /** Extra output values, keyed by the template's column keys. */
  fields?: Record<string, string | number>;
  /** Review order: higher = look at it first (1–99). Sheets are sorted by it. */
  priority?: number;
}

export interface Link { href: string; text: string }

export interface Page { text: string; links: Link[]; base: string }

export type WebsiteKind = 'none' | 'social' | 'site';

export interface SiteRead {
  ok: boolean;
  kind: WebsiteKind;
  /** Human-readable, e.g. "Read homepage + /services". */
  status: string;
  text: string;
}

// ---------- classifier (Jev) ----------

export interface NoulQuestion { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
export interface ChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type Question = NoulQuestion | ChoiceQuestion;

export interface ClassifierRequest {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}

export interface Answer {
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
}

export interface ClassifierResponse {
  answers: Record<string, Answer>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anything that can answer typed questions about a business. Jev today; swappable later. */
export interface Classifier {
  ask(request: ClassifierRequest): Promise<ClassifierResponse>;
}

export class ClassifierAuthError extends Error {
  code = 'auth' as const;
}
