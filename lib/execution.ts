import { DecisionError, LIMITS, object } from './decision.ts';

export const DIAGNOSTIC_PHASES = ['input-validation', 'preparation', 'builder', 'evidence', 'state-validation', 'classifier', 'answer-validation'] as const;
export const DIAGNOSTIC_CATEGORIES = ['extension-error', 'local-error', 'unknown', 'authentication', 'provider-rejection', 'rate-limit', 'transport', 'provider-error', 'provider-aborted'] as const;
export type DiagnosticPhase = typeof DIAGNOSTIC_PHASES[number];
export type DiagnosticCategory = typeof DIAGNOSTIC_CATEGORIES[number];
export type FailureDiagnostics = { phase: DiagnosticPhase; category: DiagnosticCategory };

function providerCategory(error: unknown): DiagnosticCategory {
  try {
    const status = Object.getOwnPropertyDescriptor(error, 'status')?.value;
    if ([401, 403].includes(status)) return 'authentication';
    if ([400, 404, 409, 413, 422].includes(status)) return 'provider-rejection';
    if (status === 429) return 'rate-limit';
    if ([408, 500, 502, 503, 504].includes(status)) return 'transport';
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'transport' : 'unknown';
  } catch { return 'unknown'; }
}

// One invocation owns all timers, attempts, and diagnostic state. Providers own remote cancellation.
export class Execution {
  readonly controller = new AbortController();
  readonly started = performance.now();
  phase: DiagnosticPhase = 'input-validation';
  private deadline: number;
  private timer?: ReturnType<typeof setTimeout>;
  private active = true;
  private pending = 0;
  private missingUsage = false;
  private category?: DiagnosticCategory;
  private abortKind: 'cancelled' | 'timeout' = 'cancelled';
  private readonly cancel = () => this.controller.abort();
  private readonly external?: AbortSignal;

  constructor(timeoutMs: number = LIMITS.timeoutMs, external?: AbortSignal) {
    this.deadline = this.started + timeoutMs;
    this.external = external;
    external?.addEventListener('abort', this.cancel, { once: true });
    if (external?.aborted) this.cancel();
    this.arm(timeoutMs);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  get usageComplete(): boolean { return !this.pending && !this.missingUsage; }
  get accepting(): boolean { return this.active && !this.signal.aborted; }
  private arm(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.abortKind = 'timeout'; this.controller.abort(); }, ms);
  }
  check(): void {
    if (!this.active) throw new DecisionError(this.abortKind);
    if (!this.signal.aborted && performance.now() >= this.deadline) { this.abortKind = 'timeout'; this.controller.abort(); }
    if (this.signal.aborted) throw new DecisionError(this.abortKind);
  }
  configure(timeoutMs: number): void {
    this.check();
    this.deadline = this.started + timeoutMs;
    this.check();
    this.arm(Math.max(1, Math.ceil(this.deadline - performance.now())));
  }
  remaining(): number { this.check(); return Math.max(1, Math.floor(this.deadline - performance.now())); }
  setPhase(phase: DiagnosticPhase): void { this.check(); this.phase = phase; this.category = undefined; }
  async provider<T>(phase: 'builder' | 'classifier', work: (timeoutMs: number) => Promise<T>): Promise<T> {
    this.setPhase(phase);
    const timeoutMs = this.remaining();
    this.pending++;
    try {
      const result = await work(timeoutMs);
      if (this.accepting) {
        this.pending--;
        if (!object(result) || !object(result.usage)) this.missingUsage = true;
        if (object(result) && result.stopReason === 'error') this.category = 'provider-error';
        if (object(result) && result.stopReason === 'aborted') this.category = 'provider-aborted';
      }
      this.check();
      return result;
    } catch (error) {
      if (this.accepting) { this.pending = Math.max(0, this.pending - 1); this.missingUsage = true; this.category = providerCategory(error); }
      throw error;
    }
  }
  diagnostics(error: unknown): FailureDiagnostics {
    return { phase: this.phase, category: this.category ?? (error instanceof DecisionError ? 'extension-error' : 'local-error') };
  }
  finish(): void {
    this.active = false;
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.cancel);
  }
}
