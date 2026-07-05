/**
 * ActionError — throw from a form action to surface a user-facing error.
 *
 * Throwing an ActionError makes the error message available in the template
 * as `actionName.error` (e.g. `signIn.error`). Throwing a plain Error in
 * production shows a generic "Action failed" message instead.
 */
export class ActionError extends Error {
  readonly isActionError = true;
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export interface AugmentedActionState {
  readonly __kozeAction?: string;
  error: string | undefined;
  pending: boolean;
  success: boolean;
}

export interface AugmentedActionHookContext<T = unknown> {
  action: string;
  form?: HTMLFormElement;
  response?: Response;
  result?: T;
  error?: string;
  redirectTo?: string | null;
  redirectStatus?: number | null;
}

export interface AugmentedActionHooks<T = unknown> {
  pending?: (ctx: AugmentedActionHookContext<T>) => void;
  success?: (ctx: AugmentedActionHookContext<T>) => void;
  error?: (ctx: AugmentedActionHookContext<T>) => void;
  settled?: (ctx: AugmentedActionHookContext<T>) => void;
}

export function augment<TAction extends (...args: any[]) => unknown, TResult = unknown>(
  _action: TAction,
  _hooks?: AugmentedActionHooks<TResult>,
): AugmentedActionState {
  return {
    error: undefined,
    pending: false,
    success: false,
  };
}
