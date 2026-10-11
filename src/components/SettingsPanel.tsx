import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiSettings } from '../domain/types';
import { testConnection } from '../services/client';
import RequestLogPanel from './RequestLogPanel';

interface SettingsPanelProps {
  settings: ApiSettings;
  onSave: (settings: ApiSettings) => Promise<ApiSettings>;
  busy: boolean;
}

export default function SettingsPanel({ settings, onSave, busy }: SettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const connectionRequest = useRef<AbortController | null>(null);

  useEffect(() => { setDraft(settings); }, [settings]);
  useEffect(() => () => { connectionRequest.current?.abort(); }, []);

  function update(field: keyof ApiSettings, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setStatus(null);
  }

  function normalizedSettings(): ApiSettings | null {
    const normalized = { baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''), apiKey: draft.apiKey.trim(), model: draft.model.trim() };
    const canReuseKey = settings.configured && normalized.baseUrl === settings.baseUrl.trim().replace(/\/+$/, '');
    if (!normalized.baseUrl || (!normalized.apiKey && !canReuseKey) || !normalized.model) {
      setStatus({ kind: 'error', text: '请填写 Base URL、API Key 和模型名。' });
      return null;
    }
    try {
      const url = new URL(normalized.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid-url');
    } catch {
      setStatus({ kind: 'error', text: 'Base URL 需要是有效的 http 或 https 地址，且不能包含用户名或密码。' });
      return null;
    }
    return normalized;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || testing || saving) return;
    const normalized = normalizedSettings();
    if (!normalized) return;
    setSaving(true);
    try {
      const saved = await onSave(normalized);
      setDraft(saved);
      setStatus({ kind: 'success', text: 'API 设置已保存到本机后端，重开浏览器或重启服务后仍可使用。' });
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : '保存设置失败，请重试。' });
    } finally {
      setSaving(false);
    }
  }

  async function connect() {
    if (busy || testing || saving) return;
    const normalized = normalizedSettings();
    if (!normalized) return;
    const controller = new AbortController();
    connectionRequest.current = controller;
    setTesting(true);
    setStatus({ kind: 'info', text: '正在测试连接…' });
    try {
      await testConnection(normalized, controller.signal);
      if (!controller.signal.aborted) setStatus({ kind: 'success', text: '后端连接模型成功。修改过配置时请保存后再生成文章。' });
    } catch (error) {
      if (!controller.signal.aborted) setStatus({ kind: 'error', text: error instanceof Error ? error.message : '连接失败，请检查配置。' });
    } finally {
      if (connectionRequest.current === controller) {
        connectionRequest.current = null;
        setTesting(false);
      }
    }
  }

  function cancelTest() {
    connectionRequest.current?.abort();
    connectionRequest.current = null;
    setTesting(false);
    setStatus({ kind: 'info', text: '连接测试已取消。' });
  }

  const disabled = busy || testing || saving;

  return (
    <section className="settings-panel" aria-labelledby="settings-heading">
      <div className="section-heading"><p className="eyebrow">YOUR LANGUAGE MODEL</p><h2 id="settings-heading">连接你的语言模型</h2><p className="muted">使用支持 OpenAI Chat Completions 格式的服务，生成文章、拆分词义和查询释义。</p></div>
      <form className="settings-form" onSubmit={save}>
        <div className="form-field"><label htmlFor="api-base-url">Base URL</label><input id="api-base-url" type="url" value={draft.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} disabled={disabled} required /><p className="field-hint">填写 API 根地址，例如 https://api.openai.com/v1。</p></div>
        <div className="form-field"><label htmlFor="api-model">模型名</label><input id="api-model" value={draft.model} onChange={(event) => update('model', event.target.value)} placeholder="填写服务支持的模型名" autoComplete="off" spellCheck={false} disabled={disabled} required /></div>
        <div className="form-field"><label htmlFor="api-key">API Key</label><div className="key-input-row"><input id="api-key" type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder={settings.configured ? '已保存在后端，留空保留原 Key' : 'sk-…'} autoComplete="off" spellCheck={false} disabled={disabled} required={!settings.configured || draft.baseUrl.trim().replace(/\/+$/, '') !== settings.baseUrl} /><button type="button" className="secondary-button" onClick={() => setShowKey((previous) => !previous)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showKey}>{showKey ? '隐藏' : '显示'}</button></div><p className="field-hint">{settings.configured ? 'API Key 已保存在后端。留空可沿用；更换服务地址时需要重新填写。' : 'Key 保存到本机后端的 data/settings.json，保存后不回显。'} 浏览器不再存储 API 配置。</p></div>
        <div className="settings-note"><strong>本机后端代理</strong><p>模型请求由后端转发，服务无需允许浏览器跨域访问。重新打开应用会读取后端保存的配置。DeepSeek 已开启思考模式，文章创作和独立词义语境审核均使用思考。</p></div>
        {status && <p className={`status-message ${status.kind}-message`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p>}
        <div className="settings-actions"><button type="submit" className="primary-button" disabled={disabled}>{saving ? '正在保存…' : '保存设置'}</button>{testing ? <button type="button" className="secondary-button" onClick={cancelTest}>取消测试</button> : <button type="button" className="secondary-button" disabled={busy || saving} onClick={() => void connect()}>测试连接</button>}</div>
      </form>
      <RequestLogPanel />
    </section>
  );
}
