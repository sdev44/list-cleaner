// Jev (TypeSafe System One) client, plus a mock for tests and offline runs.
import { ClassifierAuthError, type Classifier, type ClassifierRequest, type ClassifierResponse } from './types.js';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface JevOptions { apiKey: string; url?: string; retries?: number; timeoutMs?: number; signal?: AbortSignal }

export class JevClient implements Classifier {
  tokens = 0;
  calls = 0;
  constructor(private opts: JevOptions) {
    if (!opts.apiKey) throw new Error('A Jev API key is required (set JEV_API_KEY).');
  }

  async ask(request: ClassifierRequest): Promise<ClassifierResponse> {
    const retries = this.opts.retries ?? 4;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (this.opts.signal?.aborted) throw new Error('Stopped');
      let res: Response;
      try {
        res = await fetch(this.opts.url || JEV_URL, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + this.opts.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30000)
        });
      } catch { await wait(2000 * 2 ** attempt); continue; }
      if (res.status === 401 || res.status === 403) throw new ClassifierAuthError('Jev rejected the API key.');
      if (res.status === 429 || res.status === 529 || res.status >= 500) { await wait(2000 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`Jev error ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const body = await res.json() as ClassifierResponse;
      this.calls++;
      this.tokens += body.usage?.input_tokens || 0;
      return body;
    }
    throw new Error('Jev was busy or unreachable after several tries');
  }
}

/** Answers from a function. Used in tests and for dry runs without a key. */
export class MockClassifier implements Classifier {
  requests: ClassifierRequest[] = [];
  constructor(private answer: (req: ClassifierRequest) => ClassifierResponse['answers']) {}
  async ask(request: ClassifierRequest): Promise<ClassifierResponse> {
    this.requests.push(request);
    return { answers: this.answer(request), model: 'mock', usage: { input_tokens: 0 } };
  }
}
