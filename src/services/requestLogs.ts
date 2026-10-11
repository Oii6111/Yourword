export type RequestOperation =
  | '模型请求'
  | '文章创作'
  | '文章修复'
  | '词义验证'
  | '修复后词义验证'
  | '词义拆分'
  | '词义拆分重试'
  | '语境查义'
  | '连接测试';

export interface RequestContext {
  operation?: RequestOperation;
  targetCount?: number;
  targetWordCount?: number;
}

export interface RequestLog {
  id: string;
  startedAt: string;
  durationMs: number;
  operation: RequestOperation;
  model: string;
  endpointOrigin: string;
  state: 'pending' | 'success' | 'error';
  waitingFor: 'headers' | 'body' | 'parsing' | 'complete';
  httpStatus?: number;
  errorKind?: string;
  targetCount?: number;
  targetWordCount?: number;
}

const storageKey = 'context-words-request-logs';
const logLimit = 30;
const listeners = new Set<() => void>();

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function loadRequestLogs(): RequestLog[] {
  try {
    const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((entry): entry is RequestLog => entry && typeof entry.id === 'string'
      && typeof entry.startedAt === 'string' && typeof entry.operation === 'string'
      && typeof entry.model === 'string' && typeof entry.endpointOrigin === 'string'
      && Number.isFinite(entry.durationMs) && entry.durationMs >= 0 && ['pending', 'success', 'error'].includes(entry.state)
      && ['headers', 'body', 'parsing', 'complete'].includes(entry.waitingFor))
      .slice(0, logLimit).map(entry => ({
        id: entry.id,
        startedAt: entry.startedAt,
        durationMs: entry.durationMs,
        operation: entry.operation,
        model: entry.model,
        endpointOrigin: entry.endpointOrigin,
        state: entry.state === 'pending' ? 'error' : entry.state,
        waitingFor: entry.waitingFor,
        httpStatus: typeof entry.httpStatus === 'number' && Number.isInteger(entry.httpStatus)
          && entry.httpStatus >= 100 && entry.httpStatus <= 599 ? entry.httpStatus : undefined,
        errorKind: entry.state === 'pending' ? 'interrupted'
          : typeof entry.errorKind === 'string' ? entry.errorKind : undefined,
        targetCount: optionalCount(entry.targetCount),
        targetWordCount: optionalCount(entry.targetWordCount),
      }));
  } catch {
    return [];
  }
}

let logs: readonly RequestLog[] = loadRequestLogs();

function publish(next: readonly RequestLog[]): void {
  logs = next;
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(logs));
  } catch {}
  for (const listener of listeners) {
    try { listener(); } catch {}
  }
}

export function getRequestLogs(): readonly RequestLog[] {
  return logs;
}

export function subscribeRequestLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearRequestLogs(): void {
  publish([]);
}

export function startRequestLog(
  details: { operation: RequestOperation; model: string; endpointOrigin: string; targetCount?: number; targetWordCount?: number },
): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entry: RequestLog = {
    id,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    operation: details.operation,
    model: details.model,
    endpointOrigin: details.endpointOrigin,
    state: 'pending',
    waitingFor: 'headers',
    targetCount: details.targetCount,
    targetWordCount: details.targetWordCount,
  };
  publish([entry, ...logs].slice(0, logLimit));
  return id;
}

export function updateRequestLog(
  id: string,
  update: Pick<RequestLog, 'durationMs' | 'state' | 'waitingFor'> & Pick<Partial<RequestLog>, 'httpStatus' | 'errorKind'>,
): void {
  publish(logs.map(entry => entry.id === id ? {
    ...entry,
    durationMs: update.durationMs,
    state: update.state,
    waitingFor: update.waitingFor,
    httpStatus: update.httpStatus,
    errorKind: update.errorKind,
  } : entry));
}
