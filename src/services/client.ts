import type { ApiSettings, ChatMessage } from '../domain/types';
import { startRequestLog, updateRequestLog, type RequestContext, type RequestLog } from './requestLogs';

export type ApiErrorKind =
  | 'auth'
  | 'model'
  | 'network'
  | 'format'
  | 'timeout'
  | 'server'
  | 'config'
  | 'cancelled';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }
}

const requestTimeout = 150_000;

function endpointFor(settings: ApiSettings): string {
  if (!settings.baseUrl.trim() || !settings.model.trim()) {
    throw new ApiError('config', '请先填写 Base URL 和模型名称。');
  }
  let endpoint: URL;
  try {
    const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '');
    endpoint = new URL(baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`);
  } catch {
    throw new ApiError('config', 'Base URL 必须是完整的 HTTP 或 HTTPS 地址。');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new ApiError('config', 'Base URL 必须是 HTTP 或 HTTPS 地址，且不能包含用户名或密码。');
  }
  return endpoint.toString();
}

function parseJson<T>(content: string): T {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  try {
    return JSON.parse(fenced ? fenced[1].trim() : trimmed) as T;
  } catch {
    throw new ApiError('format', '模型没有返回有效 JSON，请重试或选择支持 JSON 输出的模型。');
  }
}

function httpError(status: number, content: string): ApiError {
  let detail = '';
  let backendKind: unknown;
  try {
    const payload = JSON.parse(content) as { error?: { message?: unknown; code?: unknown; kind?: unknown } };
    if (typeof payload.error?.message === 'string') detail = payload.error.message.slice(0, 300);
    backendKind = payload.error?.kind;
  } catch {
    detail = '';
  }
  const suffix = detail ? ` 服务返回：${detail}` : '';
  if (backendKind === 'timeout' || backendKind === 'network' || backendKind === 'config' || backendKind === 'format') {
    return new ApiError(backendKind, detail || `后端请求失败（HTTP ${status}）。`);
  }
  if (status === 401 || status === 403) {
    return new ApiError('auth', `鉴权失败（HTTP ${status}），请检查 API Key 和服务权限。${suffix}`);
  }
  if (status === 404 || ((status === 400 || status === 422) && /model/i.test(detail))) {
    return new ApiError('model', `接口或模型不可用（HTTP ${status}），请检查 Base URL 和模型名。${suffix}`);
  }
  return new ApiError('server', `模型服务请求失败（HTTP ${status}）。${suffix}`);
}

export async function chatJson<T>(
  settings: ApiSettings,
  messages: ChatMessage[],
  signal?: AbortSignal,
  context: RequestContext = {},
): Promise<T> {
  const endpoint = endpointFor(settings);
  if (signal?.aborted) throw new ApiError('cancelled', '已取消请求，学习进度保持不变。');
  const operation = context.operation ?? '模型请求';
  const startedAt = Date.now();
  const logId = startRequestLog({
    operation,
    model: settings.model.trim(),
    endpointOrigin: new URL(endpoint).origin,
    targetCount: context.targetCount,
    targetWordCount: context.targetWordCount,
  });
  let waitingFor: RequestLog['waitingFor'] = 'headers';
  let httpStatus: number | undefined;
  const record = (state: RequestLog['state'], errorKind?: string) => updateRequestLog(logId, {
    durationMs: Math.max(0, Date.now() - startedAt), state, waitingFor, httpStatus, errorKind,
  });
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeout);
  try {
    const testing = context.operation === '连接测试';
    const response = await fetch(testing ? '/api/settings/test' : '/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        ...(testing ? { settings: { baseUrl: settings.baseUrl.trim(), model: settings.model.trim(), apiKey: settings.apiKey.trim() } } : {}),
      }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    waitingFor = 'body';
    record('pending');
    const content = await response.text();
    waitingFor = 'parsing';
    if (!response.ok) throw httpError(response.status, content);
    let payload: { choices?: { message?: { content?: unknown } }[] };
    try {
      payload = JSON.parse(content) as typeof payload;
    } catch {
      throw new ApiError('format', '服务返回的响应不是有效 JSON。');
    }
    const modelContent = payload?.choices?.[0]?.message?.content;
    if (typeof modelContent !== 'string' || !modelContent.trim()) {
      throw new ApiError('format', '服务响应中缺少 choices[0].message.content。');
    }
    const result = parseJson<T>(modelContent);
    waitingFor = 'complete';
    record('success');
    return result;
  } catch (error) {
    let failure: ApiError;
    if (timedOut) {
      const detail = httpStatus === undefined ? '尚未收到 HTTP 响应' : `已收到 HTTP ${httpStatus}，未收完响应内容`;
      failure = new ApiError('timeout', `${operation}请求超过 150 秒（${detail}），应用已中断等待。请重试或换用响应更快的模型；连接设置中可查看请求日志。`);
    } else if (signal?.aborted) failure = new ApiError('cancelled', '已取消请求，学习进度保持不变。');
    else if (error instanceof ApiError) failure = error;
    else failure = new ApiError('network', '无法连接本机后端，请确认应用服务正在运行。模型服务的网络错误会由后端返回。');
    record('error', failure.kind);
    throw failure;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function testConnection(settings: ApiSettings, signal?: AbortSignal): Promise<void> {
  const result = await chatJson<unknown>(settings, [
    { role: 'system', content: 'Return only valid JSON without commentary.' },
    { role: 'user', content: 'Connection test. Return exactly {"ok":true}.' },
  ], signal, { operation: '连接测试' });
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
    throw new ApiError('format', '连接成功，但模型没有按要求返回 JSON；请检查模型是否支持指令遵循。');
  }
}
