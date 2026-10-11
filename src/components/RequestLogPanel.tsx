import { useSyncExternalStore } from 'react';
import { clearRequestLogs, getRequestLogs, subscribeRequestLogs, type RequestLog } from '../services/requestLogs';

const stateLabels: Record<RequestLog['state'], string> = {
  pending: '进行中',
  success: '成功',
  error: '失败',
};

const waitingLabels: Record<RequestLog['waitingFor'], string> = {
  headers: '等待响应头',
  body: '读取响应内容',
  parsing: '解析模型响应',
  complete: '请求完成',
};

const errorLabels: Record<string, string> = {
  auth: '鉴权失败',
  model: '模型或接口不可用',
  network: '网络或跨域错误',
  format: '响应格式错误',
  timeout: '请求超时',
  server: '服务错误',
  config: '配置错误',
  cancelled: '已取消',
  interrupted: '页面刷新中断',
};

export default function RequestLogPanel() {
  const logs = useSyncExternalStore(subscribeRequestLogs, getRequestLogs, getRequestLogs);

  return (
    <details className="request-log-panel">
      <summary>最近模型请求日志<span>{logs.length} 条</span></summary>
      <div className="request-log-content">
        <div className="request-log-toolbar">
          <p>仅保存在本机浏览器，最多记录 30 条。不记录 API Key、词库或文章内容。</p>
          <button type="button" className="secondary-button" disabled={logs.length === 0} onClick={clearRequestLogs}>清空日志</button>
        </div>
        {logs.length === 0 ? <p className="request-log-empty">暂无记录。下次模型请求会显示在这里。</p> : (
          <ol className="request-log-list">
            {logs.map((log) => (
              <li className="request-log-entry" key={log.id}>
                <div className="request-log-heading">
                  <strong>{log.operation}</strong>
                  <span className={`request-log-state ${log.state}`}>{stateLabels[log.state]}</span>
                  <span>{(log.durationMs / 1000).toFixed(1)} 秒</span>
                </div>
                <div className="request-log-meta">
                  <time dateTime={log.startedAt}>{new Date(log.startedAt).toLocaleString('zh-CN', { hour12: false })}</time>
                  <span>模型：{log.model}</span>
                  {log.targetCount !== undefined && <span>目标词义：{log.targetCount} 个</span>}
                  {log.targetWordCount !== undefined && <span>预期篇幅：{log.targetWordCount} 词</span>}
                  <span>{log.httpStatus === undefined ? '未收到响应头' : `HTTP ${log.httpStatus}`}</span>
                </div>
                <p className="request-log-endpoint">{log.endpointOrigin}</p>
                {log.state !== 'success' && <p className="request-log-detail">{log.state === 'error' ? '失败前阶段：' : '当前阶段：'}{waitingLabels[log.waitingFor]}{log.errorKind && ` · ${errorLabels[log.errorKind] ?? log.errorKind}`}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
