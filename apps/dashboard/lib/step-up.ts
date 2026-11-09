/**
 * Step-up (docs/PRODUCT.md section 10.6): a sensitive action answered 403 STEP_UP_REQUIRED, so the dashboard asks for
 * the password once and retries. The HTTP layer calls `requestStepUp`; the dialog in the shell renders the request.
 */
export type StepUpRequest = { verify: (password: string) => Promise<void>; resolve: (ok: boolean) => void };

let pending: StepUpRequest | null = null;
let waiting: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function requestStepUp(verify: (password: string) => Promise<void>): Promise<boolean> {
  // Parallel requests share one prompt.
  if (waiting) return waiting;
  waiting = new Promise<boolean>((resolve) => {
    pending = {
      verify,
      resolve: (ok) => {
        pending = null;
        waiting = null;
        emit();
        resolve(ok);
      },
    };
    emit();
  });
  return waiting;
}

export function getStepUp(): StepUpRequest | null {
  return pending;
}

export function subscribeStepUp(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
