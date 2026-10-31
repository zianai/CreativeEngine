import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Row = Record<string, any>;
type Section = 'dashboard' | 'workspace' | 'plan' | 'batches' | 'assets';
const navigation: { id: Section; label: string; detail: string; icon: string }[] = [
  { id: 'dashboard', label: '项目总览', detail: 'PROJECT', icon: '◫' },
  { id: 'workspace', label: '需求与素材', detail: 'BRIEF & SOURCES', icon: '＋' },
  { id: 'plan', label: '视觉生产计划', detail: 'VISUAL PLAN', icon: '≡' },
  { id: 'batches', label: '批次监控', detail: 'PRODUCTION', icon: '↗' },
  { id: 'assets', label: '审核与交付', detail: 'ASSET LIBRARY', icon: '▦' },
];
const states: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  reconciling: '等待核对',
  review_pending: '待审核',
  pending: '待审核',
  approved: '已批准',
  rejected: '已拒绝',
  completed: '已完成',
  failed: '失败',
  blocked: '已拦截',
  cancelled: '已取消',
  paused: '已暂停',
  planned: '已规划',
  qa_pending: '质检中',
  revision_pending: '待返工',
  needs_input: '待补充',
};
const workflows: Record<string, string> = {
  'buyer-proposal': '买家定制提案',
  'product-concept': '产品概念探索',
  'ecommerce-listing': '电商 Listing',
  'marketing-creative': '营销视觉',
};
const identityLabels: Record<string, string> = {
  source: '来源素材',
  real_product: '真实商品',
  concept: '概念预览',
  mock: 'MOCK · 离线样例',
};
const strategyLabels: Record<string, string> = {
  reuse: '复用真实素材',
  compose: '确定性合成',
  edit: '参考图编辑',
  generate: '概念生成',
  blocked: '需要补充资料',
};
function list(data: any): Row[] {
  return Array.isArray(data) ? data : (data?.items ?? []);
}
function money(v: unknown) {
  return v == null || !Number.isFinite(Number(v)) ? '未知' : `$${Number(v).toFixed(3)}`;
}
function batchCost(b: Row) {
  const summary = b.cost_summary;
  if (summary?.charge_status === 'unknown' || b.status === 'reconciling') return '待核对';
  return (
    money(summary?.actual_cost_usd ?? summary?.gross_spend_estimated_usd ?? b.cost_usd) +
    (summary?.charge_status === 'estimated' ? '（估算）' : '')
  );
}
function short(s: any) {
  return String(s ?? '—').slice(0, 18);
}
function textError(e: any) {
  return e?.message || String(e);
}
function lines(s: string) {
  return s
    .split(/[\n,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.error?.details)
      ? data.error.details.map((d: any) => `${d.path?.join('.') || ''}: ${d.message || ''}`).join('; ')
      : data.error?.details?.reasons?.join('; ');
    throw new Error(
      `${data.error?.message || data.message || response.statusText}${data.error?.code ? ` (${data.error.code})` : ''}${detail ? ` — ${detail}` : ''}`,
    );
  }
  return data;
}
function Pill({ state }: { state: string }) {
  return <span className={`pill ${state}`}>{states[state] || identityLabels[state] || state}</span>;
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  const id = React.useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string; 'aria-describedby'?: string }>, {
            id,
            'aria-describedby': hint ? `${id}-hint` : undefined,
          })
        : children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-symbol">◇</span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
function downloadUrl(asset: Row) {
  return asset.url || asset.file_url || `/v1/assets/${asset.id}/file`;
}

function App() {
  const [section, setSection] = useState<Section>('dashboard');
  const [projects, setProjects] = useState<Row[]>([]);
  const [projectId, setProjectId] = useState(() => localStorage.getItem('creative-project') || '');
  const [assets, setAssets] = useState<Row[]>([]);
  const [batches, setBatches] = useState<Row[]>([]);
  const [truths, setTruths] = useState<Row[]>([]);
  const [providers, setProviders] = useState<Row[]>([]);
  const [skills, setSkills] = useState<Row[]>([]);
  const [deliveryRules, setDeliveryRules] = useState<Row[]>([]);
  const [plan, setPlan] = useState<Row | null>(null);
  const [batch, setBatch] = useState<Row | null>(null);
  const [assetDetail, setAssetDetail] = useState<Row | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false),
    [localToken, setLocalToken] = useState('');
  const [compare, setCompare] = useState<string[]>([]);
  const [assetQuery, setAssetQuery] = useState(''),
    [assetState, setAssetState] = useState('all'),
    [assetIdentity, setAssetIdentity] = useState('all');
  const [exports, setExports] = useState<Row[]>([]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [section, projectId]);
  const project = projects.find((p) => p.id === projectId);
  const sources = assets.filter((a) => a.identity === 'source' || !a.task_id);
  const outputs = assets.filter((a) => a.identity !== 'source' && a.task_id);
  const filteredOutputs = outputs.filter(
    (a) =>
      (assetState === 'all' || a.review_status === assetState) &&
      (assetIdentity === 'all' || a.identity === assetIdentity) &&
      JSON.stringify([a.id, a.filename, a.provider, a.truth_snapshot_id, a.allowed_uses, a.prompt])
        .toLowerCase()
        .includes(assetQuery.toLowerCase()),
  );
  const load = useCallback(async () => {
    try {
      const p = await api('/v1/projects?limit=200');
      setProjects(list(p));
      setConnected(true);
      if (!projectId && list(p).length) setProjectId(list(p)[0].id);
      if (projectId) {
        const query = `?project_id=${encodeURIComponent(projectId)}&limit=200`;
        const [a, b, t, x] = await Promise.all([
          api('/v1/assets' + query),
          api('/v1/batches' + query),
          api('/v1/truth-snapshots' + query),
          api('/v1/exports' + query),
        ]);
        setAssets(list(a).filter((x) => x.project_id === projectId));
        setBatches(list(b).filter((x) => x.project_id === projectId));
        setTruths(list(t));
        setExports(list(x));
      }
    } catch (e) {
      setConnected(false);
      setError(textError(e));
    }
  }, [projectId]);
  useEffect(() => {
    void Promise.all([api('/v1/providers'), api('/v1/skills'), api('/v1/delivery-rules')])
      .then(([p, s, r]) => {
        setProviders(list(p));
        setSkills(list(s));
        setDeliveryRules(list(r));
      })
      .catch((e) => setError(textError(e)));
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const stream = new EventSource('/v1/events');
    const update = () => {
      void load();
      if (batch)
        void api(`/v1/batches/${batch.id}`)
          .then(setBatch)
          .catch(() => {});
    };
    stream.onmessage = update;
    stream.addEventListener('update', update);
    stream.addEventListener('event', update);
    return () => stream.close();
  }, [load, batch?.id]);
  useEffect(() => {
    if (projectId) {
      localStorage.setItem('creative-project', projectId);
      const saved = localStorage.getItem(`creative-plan-${projectId}`);
      if (saved)
        void api(`/v1/plans/${saved}`)
          .then((p) => {
            if (p.project_id === projectId) setPlan(p);
          })
          .catch(() => {});
    }
  }, [projectId]);
  useEffect(() => {
    if (plan?.id && plan.project_id === projectId)
      localStorage.setItem(`creative-plan-${projectId}`, plan.id);
  }, [plan?.id, projectId]);
  useEffect(() => {
    if (!batch) return;
    const timer = setInterval(() => {
      void api(`/v1/batches/${batch.id}`)
        .then(setBatch)
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [batch?.id]);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      return await fn();
    } catch (e) {
      setError(textError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  function chooseProject(id: string) {
    setProjectId(id);
    setAssets([]);
    setBatches([]);
    setTruths([]);
    setBatch(null);
    setPlan(null);
    setExports([]);
    setCompare([]);
    setAssetDetail(null);
    setAssetQuery('');
    setAssetState('all');
    setAssetIdentity('all');
  }
  async function inspectAsset(id: string) {
    await run(async () => {
      setAssetDetail(await api(`/v1/assets/${id}`));
    });
  }
  async function inspectBatch(id: string) {
    await run(async () => {
      setBatch(await api(`/v1/batches/${id}`));
      setSection('batches');
    });
  }
  async function reviewAsset(id: string, decision: string, reviewer: string, notes: string) {
    await run(async () => {
      const result = await api(`/v1/assets/${id}/review`, { decision, reviewer, notes });
      setNotice(
        decision === 'approved' ? '素材已批准，可纳入交付包。' : '已记录拒绝意见，原图与审核记录保留。',
      );
      await load();
      setAssetDetail(await api(`/v1/assets/${id}`));
      return result;
    });
  }
  async function exportBatch(id: string) {
    await run(async () => {
      const result = await api('/v1/exports', { batch_id: id });
      setExports((x) => [result, ...x]);
      setNotice('交付包已生成，仅包含通过人工批准的资产。');
    });
  }
  const currentNav = navigation.find((x) => x.id === section)!;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setSection('dashboard');
          }}
        >
          <span className="brand-mark">
            c<span>e</span>
          </span>
          <span>
            CREATIVE
            <br />
            <b>ENGINE</b>
          </span>
        </a>
        <p className="sidebar-label">
          视觉生产工作台 <span>LOCAL</span>
        </p>
        <label className="project-picker">
          <span>当前项目</span>
          <select aria-label="当前项目" value={projectId} onChange={(e) => chooseProject(e.target.value)}>
            <option value="">选择项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="new-project" onClick={() => setNewProject(true)}>
          ＋ 新建独立项目
        </button>
        <nav aria-label="工作区导航">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={section === n.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setSection(n.id)}
              aria-current={section === n.id ? 'page' : undefined}
            >
              <span className="nav-icon">{n.icon}</span>
              <span>
                {n.label}
                <small>{n.detail}</small>
              </span>
              {n.id === 'assets' && outputs.some((a) => a.review_status === 'pending') && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`connection-dot ${connected ? 'online' : ''}`} />
          <span>
            {connected ? '本地服务已连接' : '正在连接本地服务'}
            <small>资产留在本机 · 执行可追溯</small>
          </span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            工作区 <span>/</span> {project?.name || '尚未选择项目'}
          </div>
          <div className="topbar-right">
            <span className="local-tag">LOCAL FIRST</span>
            <button className="text-button" onClick={() => setConnectOpen(true)}>
              连接本地服务
            </button>
            <button className="text-button" onClick={() => void load()} aria-label="刷新数据">
              ↻ 刷新
            </button>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{currentNav.detail}</p>
              <h1>{currentNav.label}</h1>
            </div>
            <p className="page-caption">
              从事实与素材出发，
              <br />
              让每一次视觉生产有据可循。
            </p>
          </div>
          {error && (
            <div className="feedback error" role="alert">
              <strong>操作未完成</strong>
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="关闭错误">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="feedback notice" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice('')} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
          {!project && (
            <Empty
              title="建立第一个视觉项目"
              body="每个项目独立保存产品事实、来源素材、生产批次和审核交付记录。"
              action={
                <button className="primary" onClick={() => setNewProject(true)}>
                  新建项目
                </button>
              }
            />
          )}
          {project && section === 'dashboard' && (
            <>
              <div className="hero-panel">
                <div>
                  <span className="eyebrow">YOUR PRODUCTION SPACE</span>
                  <h2>{project.name}</h2>
                  <p>{project.description || '上传真实素材，明确可修改范围，然后开始有约束的视觉生产。'}</p>
                  <button className="primary" onClick={() => setSection('workspace')}>
                    开始制作 <span>↗</span>
                  </button>
                </div>
                <div className="hero-notes">
                  <span>01 / 来源可信</span>
                  <p>真实商品优先复用与确定性合成</p>
                  <span>02 / 创意有边界</span>
                  <p>概念探索保留多样性与清晰标识</p>
                  <span>03 / 交付有审核</span>
                  <p>每张输出保留版本、质检与批准记录</p>
                </div>
              </div>
              <div className="metrics">
                <div>
                  <span>来源素材</span>
                  <strong>{sources.length.toString().padStart(2, '0')}</strong>
                  <small>照片、Logo 与证据文件</small>
                </div>
                <div>
                  <span>生产批次</span>
                  <strong>{batches.length.toString().padStart(2, '0')}</strong>
                  <small>
                    {batches.filter((b) => ['running', 'queued'].includes(b.status)).length} 个执行中
                  </small>
                </div>
                <div>
                  <span>等待审核</span>
                  <strong>
                    {outputs
                      .filter((a) => ['pending', 'review_pending'].includes(a.review_status || a.status))
                      .length.toString()
                      .padStart(2, '0')}
                  </strong>
                  <small>进入交付前的人工确认</small>
                </div>
                <div>
                  <span>费用记录</span>
                  <strong className="cost">
                    {batches.some(
                      (b) => b.cost_summary?.charge_status === 'unknown' || b.status === 'reconciling',
                    )
                      ? '待核对'
                      : money(batches.reduce((n, b) => n + Number(b.cost_usd ?? 0), 0))}
                  </strong>
                  <small>付费记录为估算；未知账单需核对</small>
                </div>
              </div>
              <div className="section-title">
                <h2>最近批次</h2>
                <button className="text-button" onClick={() => setSection('batches')}>
                  查看全部 ↗
                </button>
              </div>
              <BatchTable batches={batches.slice(0, 5)} onSelect={inspectBatch} />
              <div className="section-title">
                <h2>执行能力</h2>
                <span className="muted">按配置与运行时探测显示</span>
              </div>
              <div className="provider-list">
                {providers.map((p) => (
                  <div key={p.id || p.name}>
                    <span className="provider-monogram">
                      {String(p.id || p.name || '?')
                        .slice(0, 1)
                        .toUpperCase()}
                    </span>
                    <div>
                      <strong>{p.id || p.name}</strong>
                      <p>
                        {p.capabilities?.paid ? '付费服务 · 每批次需授权' : '本地 / 离线执行'}
                        {p.health?.status ? ` · ${p.health.status}` : ''}
                      </p>
                    </div>
                    <details>
                      <summary>能力详情</summary>
                      <Json value={p} />
                    </details>
                  </div>
                ))}
              </div>
            </>
          )}
          {project && section === 'workspace' && (
            <Workspace
              key={project.id}
              project={project}
              sources={sources}
              truths={truths}
              providers={providers}
              skills={skills}
              deliveryRules={deliveryRules}
              busy={busy}
              run={run}
              onReload={load}
              onPlan={(p) => {
                setPlan(p);
                setSection('plan');
              }}
              onInspect={inspectAsset}
            />
          )}
          {project &&
            section === 'plan' &&
            (plan ? (
              <PlanView
                key={plan.id}
                plan={plan}
                assets={assets}
                busy={busy}
                onEdit={() => setSection('workspace')}
                onStart={(budget, paid, vision) =>
                  run(async () => {
                    const result = await api('/v1/batches', {
                      plan_id: plan.id,
                      budget_usd: budget,
                      authorize_paid: paid,
                      vision_review: vision,
                      idempotency_key: `studio-${plan.id}`,
                    });
                    setBatch(await api(`/v1/batches/${result.id}`));
                    setSection('batches');
                    await load();
                  })
                }
              />
            ) : (
              <Empty
                title="先形成一份生产计划"
                body="选择业务 Skill，填写需求与约束。规划不会调用付费图像服务。"
                action={
                  <button className="primary" onClick={() => setSection('workspace')}>
                    编写需求 ↗
                  </button>
                }
              />
            ))}
          {project && section === 'batches' && (
            <>
              <div className="section-title">
                <h2>
                  批次队列 <span>{batches.length}</span>
                </h2>
                <button className="secondary" onClick={() => setSection('workspace')}>
                  ＋ 新建批次
                </button>
              </div>
              <BatchTable batches={batches} onSelect={inspectBatch} />
              {batch && (
                <BatchDetail
                  batch={batch}
                  busy={busy}
                  onAction={(action) =>
                    run(async () => {
                      await api(`/v1/batches/${batch.id}/${action}`, {});
                      setBatch(await api(`/v1/batches/${batch.id}`));
                      await load();
                    })
                  }
                  onReconcile={(taskId, data) =>
                    run(async () => {
                      await api(`/v1/tasks/${taskId}/reconcile`, data);
                      setBatch(await api(`/v1/batches/${batch.id}`));
                      setNotice('核对结论已记录。确认未收费的任务可由操作人恢复批次；系统不会自动重发。');
                      await load();
                    })
                  }
                  onGallery={() => setSection('assets')}
                  onPlan={() =>
                    run(async () => {
                      setPlan(await api(`/v1/plans/${batch.plan_id}`));
                      setSection('plan');
                    })
                  }
                />
              )}
            </>
          )}
          {project && section === 'assets' && (
            <>
              <div className="section-title">
                <div>
                  <h2>
                    输出资产 <span>{outputs.length}</span>
                  </h2>
                  <p className="muted">选择图像并排比较；批准后方可进入交付包。</p>
                </div>
                <button className="secondary" disabled={!compare.length} onClick={() => setCompare([])}>
                  清空比较 ({compare.length})
                </button>
              </div>
              <div className="asset-filters">
                <Field label="搜索资产">
                  <input
                    type="search"
                    value={assetQuery}
                    onChange={(e) => setAssetQuery(e.target.value)}
                    placeholder="名称、场景、服务或来源"
                  />
                </Field>
                <Field label="审核状态">
                  <select value={assetState} onChange={(e) => setAssetState(e.target.value)}>
                    <option value="all">全部状态</option>
                    <option value="pending">待审核</option>
                    <option value="approved">已批准</option>
                    <option value="rejected">已拒绝</option>
                  </select>
                </Field>
                <Field label="资产身份">
                  <select value={assetIdentity} onChange={(e) => setAssetIdentity(e.target.value)}>
                    <option value="all">全部身份</option>
                    <option value="real_product">真实商品</option>
                    <option value="concept">概念预览</option>
                    <option value="mock">Mock 样例</option>
                  </select>
                </Field>
              </div>
              {compare.length > 1 && (
                <div className="compare-strip" aria-label="并排比较">
                  {compare
                    .map((id) => assets.find((a) => a.id === id))
                    .filter(Boolean)
                    .map((a) => (
                      <figure key={a!.id}>
                        <img src={downloadUrl(a!)} alt={a!.filename || a!.id} />
                        <figcaption>
                          {short(a!.id)} <Pill state={a!.review_status || 'pending'} />
                        </figcaption>
                      </figure>
                    ))}
                </div>
              )}
              {!filteredOutputs.length ? (
                <Empty
                  title={outputs.length ? '没有符合筛选条件的资产' : '输出资产将在这里归档'}
                  body={
                    outputs.length
                      ? '调整搜索文字或筛选条件。'
                      : '完成一个生产批次后，可查看图片、质检结果与来源，作出审核决定或发起定向返工。'
                  }
                />
              ) : (
                <div className="asset-grid">
                  {filteredOutputs.map((a) => (
                    <article className="asset-card" key={a.id}>
                      <button
                        className="image-button"
                        onClick={() => void inspectAsset(a.id)}
                        aria-label={`查看资产 ${a.filename || a.id}`}
                      >
                        <img src={downloadUrl(a)} alt={a.filename || '视觉输出'} loading="lazy" />
                        <span className={`identity ${a.identity}`}>
                          {identityLabels[a.identity] || a.identity}
                        </span>
                      </button>
                      <div className="asset-card-body">
                        <div className="asset-card-title">
                          <strong title={a.filename || a.id}>{a.filename || short(a.id)}</strong>
                          <input
                            aria-label={`比较 ${a.id}`}
                            type="checkbox"
                            checked={compare.includes(a.id)}
                            onChange={(e) =>
                              setCompare((ids) =>
                                e.target.checked ? [...ids, a.id].slice(-4) : ids.filter((id) => id !== a.id),
                              )
                            }
                          />
                        </div>
                        <div className="asset-meta">
                          <Pill state={a.review_status || 'pending'} />
                          <span>
                            {a.width} × {a.height}
                          </span>
                        </div>
                        <button className="text-button" onClick={() => void inspectAsset(a.id)}>
                          检查与审核 ↗
                        </button>
                        {a.parent_asset_id && (
                          <small className="parent-note">派生自 {short(a.parent_asset_id)}</small>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <div className="section-title">
                <h2>交付包</h2>
                <span className="muted">PNG + Manifest · ZIP</span>
              </div>
              <div className="export-panel">
                <p>按批次导出已批准资产，清单保留事实快照、来源、版本、质检和审核记录。</p>
                <div className="export-actions">
                  {batches.map((b) => (
                    <button
                      key={b.id}
                      className="secondary"
                      disabled={busy}
                      onClick={() => void exportBatch(b.id)}
                    >
                      导出 {short(b.id)}
                    </button>
                  ))}
                </div>
                {exports.map((e) => (
                  <a
                    className="download-link"
                    key={e.id}
                    href={e.download_url || `/v1/exports/${e.id}/file`}
                    download
                  >
                    ↓ 下载交付包 {short(e.id)}
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
      {connectOpen && (
        <Modal
          title="连接本地服务"
          onClose={() => {
            setLocalToken('');
            setConnectOpen(false);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                try {
                  const response = await fetch('/v1/session', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${localToken}` },
                  });
                  if (!response.ok) throw new Error('连接失败，请检查本地服务令牌。');
                  setLocalToken('');
                  window.location.reload();
                } finally {
                  setLocalToken('');
                }
              });
            }}
          >
            <p className="muted">
              使用本机服务配置的访问令牌。它不会写入浏览器存储；会话一小时后失效。此连接不授予模型付费或对外发布权限。
            </p>
            <Field label="本地访问令牌">
              <input
                type="password"
                autoComplete="off"
                required
                value={localToken}
                onChange={(e) => setLocalToken(e.target.value)}
              />
            </Field>
            {error && <p role="alert">{error}</p>}
            <button className="primary" disabled={busy || !localToken}>
              连接
            </button>
          </form>
        </Modal>
      )}
      {newProject && (
        <ProjectModal
          error={error}
          busy={busy}
          onClose={() => setNewProject(false)}
          onCreate={(name, description, product_id) =>
            run(async () => {
              const p = await api('/v1/projects', { name, description, product_id });
              await load();
              chooseProject(p.id);
              setNewProject(false);
              setSection('workspace');
            })
          }
        />
      )}
      {assetDetail && (
        <AssetModal
          error={error}
          asset={assetDetail}
          busy={busy}
          onClose={() => setAssetDetail(null)}
          onReview={reviewAsset}
          onRevise={(instructions, budget, paid) =>
            run(async () => {
              const result = await api(`/v1/tasks/${assetDetail.task_id}/revise`, {
                instructions,
                budget_usd: budget,
                authorize_paid: paid,
              });
              setAssetDetail(null);
              setNotice('已创建新的修订任务，原始资产和审核记录保持不变。');
              setSection('batches');
              await load();
              if (result.batch_id || result.id)
                setBatch(await api(`/v1/batches/${result.batch_id || result.id}`));
            })
          }
        />
      )}
    </div>
  );
}

function ProjectModal({
  error,
  busy,
  onClose,
  onCreate,
}: {
  error: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, description: string, sku: string) => unknown;
}) {
  const [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [sku, setSku] = useState('');
  return (
    <Modal title="新建视觉项目" onClose={onClose}>
      {error && (
        <div className="feedback error" role="alert">
          {error}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(name, description, sku);
        }}
      >
        <p className="muted">产品事实与视觉资产将保存在独立的项目空间。</p>
        <Field label="项目名称">
          <input
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：桌面灯 · 买家定制提案"
          />
        </Field>
        <Field label="产品编号">
          <input required value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU / 产品代号" />
        </Field>
        <Field label="项目说明">
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个项目要解决什么业务问题？"
          />
        </Field>
        <div className="form-footer">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            创建项目
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null),
    titleId = React.useId();
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button onClick={onClose} className="icon-button" aria-label="关闭弹窗">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

function Workspace({
  project,
  sources,
  truths,
  providers,
  skills,
  deliveryRules,
  busy,
  run,
  onReload,
  onPlan,
  onInspect,
}: {
  project: Row;
  sources: Row[];
  truths: Row[];
  providers: Row[];
  skills: Row[];
  deliveryRules: Row[];
  busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  onReload: () => Promise<void>;
  onPlan: (p: Row) => void;
  onInspect: (id: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [kind, setKind] = useState('product_photo'),
    [authorized, setAuthorized] = useState(false),
    [verified, setVerified] = useState(false),
    [cleared, setCleared] = useState(false);
  const [references, setReferences] = useState<string[]>([]),
    [workflow, setWorkflow] = useState('buyer-proposal'),
    [stage, setStage] = useState('existing_sku'),
    [fidelity, setFidelity] = useState('strict'),
    [requirements, setRequirements] = useState(''),
    [intent, setIntent] = useState('product-showcase');
  const [truthId, setTruthId] = useState(''),
    [truthSource, setTruthSource] = useState(''),
    [factName, setFactName] = useState(''),
    [factValue, setFactValue] = useState(''),
    [factStatus, setFactStatus] = useState('verified'),
    [factExternal, setFactExternal] = useState(false);
  const [scenes, setScenes] = useState('白色摄影棚'),
    [variants, setVariants] = useState(3),
    [ratio, setRatio] = useState('1:1'),
    [target, setTarget] = useState('buyer_review'),
    [provider, setProvider] = useState('mock'),
    [mode, setMode] = useState('independent'),
    [budget, setBudget] = useState(0),
    [changes, setChanges] = useState('background'),
    [forbidden, setForbidden] = useState('product_structure, dimensions, unverified_features'),
    [logo, setLogo] = useState(''),
    [backgroundAsset, setBackgroundAsset] = useState(''),
    [deliveryRuleId, setDeliveryRuleId] = useState('');
  useEffect(() => {
    setReferences([]);
    setTruthId('');
  }, [project.id]);
  useEffect(() => {
    if (!truthId && truths.length) setTruthId(truths[0].id);
  }, [truths, truthId]);
  function selectWorkflow(value: string) {
    setWorkflow(value);
    if (value === 'product-concept') {
      setStage('concept');
      setFidelity('exploratory');
      setTarget('internal_review');
      setIntent('concept-exploration');
      setChanges('shape, color, material');
      setForbidden('unverified_features');
    } else if (value === 'ecommerce-listing') {
      setStage('existing_sku');
      setFidelity('strict');
      setTarget('listing');
      setIntent('listing');
      setChanges('background');
    } else if (value === 'marketing-creative') {
      setTarget('marketing');
      setIntent('marketing');
    } else {
      setTarget('buyer_review');
      setIntent('product-showcase');
    }
  }
  async function upload() {
    if (!file) return;
    await run(async () => {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const source = await api('/v1/assets/import', {
        project_id: project.id,
        filename: file.name,
        data_base64: base64,
        kind,
        authorized,
        verified,
        source_version: '1',
        sensitive_data_cleared: cleared,
      });
      setReferences((ids) => [...ids, source.id]);
      setTruthSource(source.id);
      setFile(null);
      setAuthorized(false);
      setVerified(false);
      setCleared(false);
      await onReload();
    });
  }
  async function createTruth() {
    await run(async () => {
      const result = await api('/v1/truth-snapshots', {
        project_id: project.id,
        product_id: project.product_id || project.id,
        version: `v${truths.length + 1}`,
        facts: [
          ...(truths.find((t) => t.id === truthId)?.facts || []).filter((f: Row) => f.name !== factName),
          {
            name: factName,
            value: factValue,
            source_asset_id: truthSource,
            source_version: sources.find((a) => a.id === truthSource)?.source_version || '1',
            evidence_status: factStatus,
            confirmed_at: new Date().toISOString(),
            external_allowed: factExternal,
          },
        ],
      });
      setTruthId(result.id);
      setFactName('');
      setFactValue('');
      await onReload();
    });
  }
  async function makePlan() {
    await run(async () => {
      const brief = await api('/v1/briefs', {
        project_id: project.id,
        workflow,
        intent,
        requirements,
        product: {
          product_id: project.product_id || project.id,
          stage,
          ...(truthId ? { truth_snapshot_id: truthId } : {}),
        },
        reference_asset_ids: references,
        fidelity,
        allowed_changes: lines(changes),
        forbidden_changes: lines(forbidden),
        variants,
        scenes: lines(scenes),
        aspect_ratio: ratio,
        delivery_target: target,
        provider,
        mode,
        budget_usd: budget,
        ...(logo ? { authorized_logo_asset_id: logo } : {}),
        ...(backgroundAsset ? { background_asset_id: backgroundAsset } : {}),
        ...(deliveryRuleId ? { delivery_rule_id: deliveryRuleId } : {}),
      });
      onPlan(await api(`/v1/briefs/${brief.id}/plan`, {}));
    });
  }
  return (
    <div className="workspace-layout">
      <div className="brief-column">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void makePlan();
          }}
          className="panel brief-form"
        >
          <div className="section-kicker">01 / 业务需求</div>
          <h2>你希望这组图片完成什么？</h2>
          <div className="skill-selector">
            {Object.entries(workflows).map(([id, title]) => (
              <button
                type="button"
                className={workflow === id ? 'selected' : ''}
                key={id}
                onClick={() => selectWorkflow(id)}
              >
                <span>{title}</span>
                <small>{id}</small>
              </button>
            ))}
          </div>
          <Field
            label="视觉需求"
            hint="明确目标人群、使用场景与希望呈现的内容。系统会根据事实与素材选择生产策略。"
          >
            <textarea
              rows={5}
              required
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder="例如：为买家展示这款桌面灯的真实外观，使用明亮背景，保留产品结构和比例。"
            />
          </Field>
          <div className="form-grid">
            <Field label="产品阶段">
              <select value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="existing_sku">现有量产 SKU</option>
                <option value="prototype">样机 / 开发中</option>
                <option value="concept">早期设计概念</option>
              </select>
            </Field>
            <Field label="保真要求">
              <select value={fidelity} onChange={(e) => setFidelity(e.target.value)}>
                <option value="strict">Strict · 严格保真</option>
                <option value="controlled">Controlled · 授权修改</option>
                <option value="exploratory">Exploratory · 创意探索</option>
              </select>
            </Field>
          </div>
          <Field label="产品事实快照">
            <select value={truthId} onChange={(e) => setTruthId(e.target.value)}>
              <option value="">未选择事实快照</option>
              {truths.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.version} · {t.facts?.length || 0} 条事实 · {short(t.id)}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="允许修改的属性" hint="逗号分隔；例如 background, authorized_logo, color">
              <input value={changes} onChange={(e) => setChanges(e.target.value)} />
            </Field>
            <Field label="禁止修改的属性">
              <input value={forbidden} onChange={(e) => setForbidden(e.target.value)} />
            </Field>
          </div>
          <Field
            label="场景背景素材"
            hint="选择已提供的场景照片。严格保真合成需要经过验证的透明产品抠图，保留产品主体，不重画商品；允许修改范围中须包含 background。"
          >
            <select
              value={backgroundAsset}
              onChange={(e) => {
                const id = e.target.value;
                setBackgroundAsset(id);
                if (id) setReferences((ids) => (ids.includes(id) ? ids : [...ids, id]));
              }}
            >
              <option value="">使用默认画布，不指定场景图</option>
              {sources
                .filter((s) => s.kind === 'reference')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.filename}
                    {s.authorized ? '' : '（未授权）'}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="已授权 Logo">
            <select value={logo} onChange={(e) => setLogo(e.target.value)}>
              <option value="">不使用 Logo</option>
              {sources
                .filter((s) => s.kind === 'logo')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.filename}
                    {s.authorized ? '' : '（未授权）'}
                  </option>
                ))}
            </select>
          </Field>
          <div className="form-separator" />
          <div className="section-kicker">02 / 交付规格</div>
          <Field label="场景列表" hint="每行一个场景。总任务数 = 场景数 × 每场景变体数。">
            <textarea rows={3} value={scenes} onChange={(e) => setScenes(e.target.value)} required />
          </Field>
          <div className="form-grid three">
            <Field label="每场景变体数">
              <input
                type="number"
                min={1}
                max={24}
                value={variants}
                onChange={(e) => setVariants(Number(e.target.value))}
                required
              />
            </Field>
            <Field label="画面比例">
              <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
                {['1:1', '4:3', '3:4', '16:9', '9:16'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="交付用途">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="buyer_review">买家评审</option>
                <option value="internal_review">内部评审</option>
                <option value="listing">Listing</option>
                <option value="marketing">营销素材</option>
              </select>
            </Field>
          </div>
          <Field
            label="交付规格配置"
            hint="选择带版本与来源的规格。自定义规则用于内部交付检查，不代表已符合某个平台的政策。"
          >
            <select value={deliveryRuleId} onChange={(e) => setDeliveryRuleId(e.target.value)}>
              <option value="">不附加交付规则</option>
              {deliveryRules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || r.id} · v{r.version}
                </option>
              ))}
            </select>
          </Field>
          {deliveryRuleId && <DeliveryRuleInfo rule={deliveryRules.find((r) => r.id === deliveryRuleId)} />}
          <details className="advanced">
            <summary>高级执行设置</summary>
            <div className="form-grid">
              <Field label="图像服务">
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {providers.length ? (
                    providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                        {p.capabilities?.paid ? ' · 付费' : ' · 本地'}
                      </option>
                    ))
                  ) : (
                    <option value="mock">mock · 离线样例</option>
                  )}
                </select>
              </Field>
              <Field label="批次预算 (USD)">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </Field>
              <Field label="任务模式">
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="independent">独立任务</option>
                  <option value="base_variants">基准图 + 变体</option>
                  <option value="iterative">迭代修订</option>
                </select>
              </Field>
              <Field label="视觉意图">
                <input value={intent} onChange={(e) => setIntent(e.target.value)} />
              </Field>
            </div>
            {skills.find((s) => s.id === workflow) && (
              <details>
                <summary>Skill 配置</summary>
                <Json value={skills.find((s) => s.id === workflow)} />
              </details>
            )}
          </details>
          <div className="form-footer">
            <span className="muted">
              {references.length} 项参考素材 · {lines(scenes).length * variants} 个任务
              <br />
              规划本身不会产生图像 API 费用
            </span>
            <button className="primary" disabled={busy}>
              形成视觉计划 ↗
            </button>
          </div>
        </form>
      </div>
      <div className="sources-column">
        <section className="panel">
          <div className="section-kicker">SOURCE OF TRUTH</div>
          <h2>来源素材</h2>
          <p className="muted">真实商品使用已授权、已验证的照片或抠图。</p>
          <div className="source-list">
            {sources.map((s) => (
              <div className="source-row" key={s.id}>
                <input
                  type="checkbox"
                  aria-label={`引用 ${s.filename}`}
                  checked={references.includes(s.id)}
                  onChange={(e) =>
                    setReferences((ids) =>
                      e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                    )
                  }
                />
                {s.kind === 'document' ? (
                  <span className="document-thumb">DOC</span>
                ) : (
                  <img src={downloadUrl(s)} alt="" />
                )}
                <button onClick={() => onInspect(s.id)}>
                  <strong>{s.filename}</strong>
                  <small>
                    {s.kind} · {s.verified ? '已验证' : '未验证'}
                  </small>
                </button>
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void upload();
            }}
            className="upload-form"
          >
            <Field label="上传文件">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf,text/plain"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                required
              />
            </Field>
            <Field label="素材类别">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="product_photo">真实产品照片</option>
                <option value="cutout">产品透明抠图</option>
                <option value="logo">品牌 Logo</option>
                <option value="reference">设计参考图</option>
                <option value="document">事实来源文档</option>
              </select>
            </Field>
            <label className="check">
              <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
              我确认拥有使用授权
            </label>
            <label className="check">
              <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
              已核实素材与真实产品相符
            </label>
            <label className="check">
              <input type="checkbox" checked={cleared} onChange={(e) => setCleared(e.target.checked)} />
              已检查并清除敏感信息
            </label>
            <button className="secondary full" disabled={busy || !file || !authorized || !cleared}>
              导入素材
            </button>
          </form>
        </section>
        <section className="panel">
          <h2>添加有依据的产品事实</h2>
          <p className="muted">事实需要可追溯来源。生成图片与视觉分析不会自动改写事实。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createTruth();
            }}
          >
            <Field label="事实名称">
              <input
                required
                value={factName}
                onChange={(e) => setFactName(e.target.value)}
                placeholder="例如：材质"
              />
            </Field>
            <Field label="事实值">
              <input
                required
                value={factValue}
                onChange={(e) => setFactValue(e.target.value)}
                placeholder="例如：铝合金"
              />
            </Field>
            <Field label="证据来源">
              <select required value={truthSource} onChange={(e) => setTruthSource(e.target.value)}>
                <option value="">选择来源素材</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.filename}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="证据状态">
              <select value={factStatus} onChange={(e) => setFactStatus(e.target.value)}>
                <option value="verified">已验证</option>
                <option value="supplier_claim">供应商声明</option>
                <option value="unverified">未确认</option>
                <option value="concept">设计设想</option>
              </select>
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={factExternal}
                onChange={(e) => setFactExternal(e.target.checked)}
              />
              允许出现在对外交付物中
            </label>
            <button className="secondary full" disabled={busy || !truthSource}>
              保存事实快照
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function DeliveryRuleInfo({ rule }: { rule?: Row }) {
  if (!rule) return null;
  const r = rule.rules || {};
  return (
    <div className="delivery-rule-info">
      <strong>
        {rule.scope === 'user_defined' ? '自定义交付规则' : '附官方来源的规则配置'} · {rule.name || rule.id}
      </strong>
      <p>
        版本 {rule.version} · 资料日期 {rule.source_date || rule.review_date || '未提供'}
      </p>
      <p>
        来源：
        {String(rule.source).startsWith('https://') ? (
          <a href={rule.source} target="_blank" rel="noreferrer">
            {rule.source}
          </a>
        ) : (
          rule.source
        )}
      </p>
      <p>
        {[
          r.min_width || r.min_height ? `最小尺寸 ${r.min_width || '—'} × ${r.min_height || '—'}` : '',
          r.formats?.length ? `格式 ${r.formats.join(' / ').toUpperCase()}` : '',
          r.max_bytes ? `最大 ${(r.max_bytes / 1048576).toFixed(1)} MB` : '',
          r.required_ratio ? `比例 ${r.required_ratio}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </div>
  );
}

function PlanView({
  plan,
  assets,
  busy,
  onStart,
  onEdit,
}: {
  plan: Row;
  assets: Row[];
  busy: boolean;
  onStart: (budget: number, paid: boolean, vision: boolean) => unknown;
  onEdit: () => void;
}) {
  const [accepted, setAccepted] = useState(false),
    [paid, setPaid] = useState(false),
    [vision, setVision] = useState(false),
    [budget, setBudget] = useState(Number(plan.budget_usd || 0));
  const count = (plan.scenes?.length || 1) * (plan.variants || 1);
  return (
    <div className="plan-layout">
      <section className="panel">
        <div className="section-kicker">
          PLAN / {plan.version} · {plan.skill_version}
        </div>
        <h2>{strategyLabels[plan.strategy] || plan.strategy}</h2>
        <p className="plan-intro">{plan.requirements}</p>
        <div className="plan-facts">
          <div>
            <span>保真等级</span>
            <strong>{plan.fidelity}</strong>
          </div>
          <div>
            <span>生产数量</span>
            <strong>{count} 张</strong>
          </div>
          <div>
            <span>执行服务</span>
            <strong>{plan.provider}</strong>
          </div>
          <div>
            <span>交付用途</span>
            <strong>{plan.delivery_target}</strong>
          </div>
        </div>
        {(plan.reference_asset_ids?.length || plan.background_asset_id || plan.authorized_logo_asset_id) && (
          <>
            <h3>本次使用的来源素材</h3>
            <div className="plan-sources">
              {[
                ...new Set(
                  [
                    ...(plan.reference_asset_ids || []),
                    plan.background_asset_id,
                    plan.authorized_logo_asset_id,
                  ].filter(Boolean),
                ),
              ]
                .map((id) => assets.find((a) => a.id === id))
                .filter(Boolean)
                .map((a) => (
                  <a
                    key={a!.id}
                    href={downloadUrl(a!)}
                    target="_blank"
                    rel="noreferrer"
                    className="plan-source"
                  >
                    {a!.kind === 'document' ? (
                      <span className="document-thumb">DOC</span>
                    ) : (
                      <img src={downloadUrl(a!)} alt={a!.filename} />
                    )}
                    <span>
                      {a!.id === plan.background_asset_id
                        ? '场景背景'
                        : a!.id === plan.authorized_logo_asset_id
                          ? '授权 Logo'
                          : a!.kind === 'cutout'
                            ? '透明产品主体'
                            : '参考来源'}
                      <small>{a!.filename}</small>
                    </span>
                  </a>
                ))}
            </div>
          </>
        )}
        <h3>策略依据</h3>
        <ul className="reason-list">
          {plan.reasons?.map((r: string) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {plan.blocked_reasons?.length > 0 && (
          <div className="block-box">
            <strong>需要补充资料后重新规划</strong>
            <ul>
              {plan.blocked_reasons.map((r: string) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="constraint-columns">
          <div>
            <h3>允许修改</h3>
            {plan.allowed_changes?.map((r: string) => (
              <span className="token" key={r}>
                {r}
              </span>
            ))}
          </div>
          <div>
            <h3>禁止修改</h3>
            {plan.forbidden_changes?.map((r: string) => (
              <span className="token prohibited" key={r}>
                {r}
              </span>
            ))}
          </div>
        </div>
        {plan.delivery_rule_snapshot && (
          <>
            <h3>本次交付规则</h3>
            <DeliveryRuleInfo rule={plan.delivery_rule_snapshot} />
          </>
        )}{' '}
        <h3>设计方向与任务展开</h3>
        <div className="direction-list">
          {(plan.directions || []).map((d: any, i: number) => (
            <div key={i}>
              <span>{String(i + 1).padStart(2, '0')}</span>
              <p>{typeof d === 'string' ? d : JSON.stringify(d)}</p>
            </div>
          ))}
        </div>
        <details className="advanced">
          <summary>查看结构化 VisualPlan</summary>
          <Json value={plan} />
        </details>
      </section>
      <aside className="panel plan-approval">
        <div className="section-kicker">REVIEW BEFORE RUN</div>
        <h2>确认并启动生产</h2>
        <p className="muted">执行后所有输出进入质检与人工审核。概念方案与 Mock 样例有明确标识。</p>
        <Field label="本批次最高预算 (USD)">
          <input
            type="number"
            min={0}
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          已确认生产策略、参考素材与修改范围
        </label>
        <details className="advanced">
          <summary>可选视觉模型质检</summary>
          <label className="check">
            <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
            调用已配置的视觉模型检查画面（费用计入本批预算）
          </label>
          <p className="fine-print">需要服务端配置 Vision 模型。未启用时保留确定性检查与人工审核。</p>
        </details>
        {((plan.provider !== 'mock' && ['edit', 'generate'].includes(plan.strategy)) || vision) && (
          <label className="check">
            <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
            授权在上述预算内调用付费图像或视觉质检服务
          </label>
        )}
        <button
          className="primary full"
          disabled={busy || !accepted || plan.strategy === 'blocked'}
          onClick={() => onStart(budget, paid, vision)}
        >
          启动 {count} 个任务 ↗
        </button>
        <button className="text-button full" onClick={onEdit}>
          返回修改需求
        </button>
        <p className="fine-print">
          计划 ID：{plan.id}
          <br />
          事实快照：{plan.product?.truth_snapshot_id || '无'}
          <br />
          原始素材与事实快照不会被生成结果覆盖。
        </p>
      </aside>
    </div>
  );
}
function BatchTable({ batches, onSelect }: { batches: Row[]; onSelect: (id: string) => unknown }) {
  return batches.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>批次</th>
            <th>状态</th>
            <th>任务数</th>
            <th>费用</th>
            <th>创建时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td>
                <button className="table-link" onClick={() => onSelect(b.id)}>
                  {short(b.id)}
                </button>
                <small>{b.workflow || b.provider || '视觉生产'}</small>
              </td>
              <td>
                <Pill state={b.status} />
              </td>
              <td>{b.task_count ?? b.tasks?.length ?? b.total_tasks ?? '—'}</td>
              <td>{batchCost(b)}</td>
              <td>{b.created_at ? new Date(b.created_at).toLocaleString('zh-CN') : '—'}</td>
              <td>
                <button
                  className="text-button"
                  aria-label={`查看批次 ${b.id}`}
                  onClick={() => onSelect(b.id)}
                >
                  查看 ↗
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="还没有生产批次" body="形成并确认视觉计划后，任务会进入持久化队列。" />
  );
}
function BatchDetail({
  batch,
  busy,
  onAction,
  onGallery,
  onPlan,
  onReconcile,
}: {
  batch: Row;
  busy: boolean;
  onAction: (action: string) => unknown;
  onGallery: () => void;
  onPlan: () => unknown;
  onReconcile: (taskId: string, data: Row) => unknown;
}) {
  const tasks = batch.tasks || [],
    done = tasks.filter((t: Row) => ['review_pending', 'approved', 'completed'].includes(t.status)).length;
  return (
    <section className="panel batch-detail">
      <div className="section-title">
        <div>
          <span className="eyebrow">BATCH DETAIL</span>
          <h2>
            {short(batch.id)} <Pill state={batch.status} />
          </h2>
        </div>
        <button className="primary" onClick={onGallery}>
          查看输出资产 ↗
        </button>
      </div>
      <div className="progress-label">
        <span>
          {done} / {tasks.length} 个任务已产出
        </span>
        <span>
          预算 {money(batch.budget_usd)} · 已记录 {batchCost(batch)}
        </span>
      </div>
      <progress max={Math.max(tasks.length, 1)} value={done} />
      <div className="batch-actions">
        <button className="secondary" onClick={onPlan}>
          查看生产计划
        </button>
        <button className="secondary" disabled={busy} onClick={() => onAction('pause')}>
          暂停批次
        </button>
        <button className="secondary" disabled={busy} onClick={() => onAction('resume')}>
          恢复 / 重试失败任务
        </button>
        <button className="danger-outline" disabled={busy} onClick={() => onAction('cancel')}>
          取消待执行任务
        </button>
      </div>
      <div className="task-list">
        {tasks.map((t: Row, i: number) => (
          <details key={t.id}>
            <summary>
              <span className="task-number">{String(i + 1).padStart(2, '0')}</span>
              <span>{t.scene || t.direction || short(t.id)}</span>
              <span>变体 {(t.variant ?? t.variant_index ?? 0) + 1}</span>
              <Pill state={t.status} />
              <span>{t.status === 'reconciling' ? '待核对' : money(t.cost_usd)}</span>
            </summary>
            {(t.error || t.last_error) && (
              <div className="task-error">
                {typeof (t.error || t.last_error) === 'string'
                  ? t.error || t.last_error
                  : JSON.stringify(t.error || t.last_error)}
              </div>
            )}
            <Json value={t} />
            {t.status === 'reconciling' && <ReconcileForm taskId={t.id} busy={busy} onSubmit={onReconcile} />}
          </details>
        ))}
      </div>
      <details className="advanced">
        <summary>执行与成本原始记录</summary>
        <Json value={batch} />
      </details>
    </section>
  );
}

function ReconcileForm({
  taskId,
  busy,
  onSubmit,
}: {
  taskId: string;
  busy: boolean;
  onSubmit: (id: string, data: Row) => unknown;
}) {
  const [outcome, setOutcome] = useState(''),
    [reviewer, setReviewer] = useState(''),
    [evidence, setEvidence] = useState(''),
    [cost, setCost] = useState(0);
  return (
    <form
      className="reconcile-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(taskId, { outcome, reviewer, evidence, cost_usd: outcome === 'no_charge' ? 0 : cost });
      }}
    >
      <h3>核对不明确的请求</h3>
      <p className="muted">
        先向 Provider
        核对本次请求与收费记录，再提交结论。若已有可恢复结果，系统优先恢复结果；不会据此自动重发付费请求。
      </p>
      <Field label="核对结论">
        <select required value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">选择已有证据支持的结论</option>
          <option value="no_charge">已确认未收费、未生成</option>
          <option value="failed_charged">请求失败但已收费</option>
        </select>
      </Field>
      {outcome === 'failed_charged' && (
        <Field label="实际费用 (USD)">
          <input
            required
            type="number"
            min={0}
            step="0.001"
            value={cost}
            onChange={(e) => setCost(Number(e.target.value))}
          />
        </Field>
      )}
      <Field label="核对人">
        <input required value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
      </Field>
      <Field label="核对证据" hint="填写 Provider 请求编号、账单记录或支持答复，至少 12 个字符。">
        <textarea
          required
          minLength={12}
          rows={3}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </Field>
      <button
        className="secondary"
        disabled={busy || !outcome || !reviewer.trim() || evidence.trim().length < 12}
      >
        记录核对结论
      </button>
    </form>
  );
}

function AssetModal({
  error,
  asset,
  busy,
  onClose,
  onReview,
  onRevise,
}: {
  error: string;
  asset: Row;
  busy: boolean;
  onClose: () => void;
  onReview: (id: string, decision: string, reviewer: string, notes: string) => unknown;
  onRevise: (instructions: string, budget: number, paid: boolean) => unknown;
}) {
  const [reviewer, setReviewer] = useState(''),
    [notes, setNotes] = useState(''),
    [revision, setRevision] = useState(''),
    [budget, setBudget] = useState(0),
    [paid, setPaid] = useState(false);
  const qa = asset.qa || asset.qa_report || asset.quality;
  return (
    <Modal title="资产检查与审核" wide onClose={onClose}>
      {error && (
        <div className="feedback error" role="alert">
          {error}
        </div>
      )}
      <div className="asset-detail-layout">
        <div className="asset-preview">
          {asset.kind === 'document' ? (
            <div className="empty">
              <h3>来源文档</h3>
              <a href={downloadUrl(asset)} target="_blank" rel="noreferrer">
                打开文档 ↗
              </a>
            </div>
          ) : (
            <img src={downloadUrl(asset)} alt={asset.filename || '待审核图像'} />
          )}
          <div className="asset-preview-caption">
            <Pill state={asset.identity} />
            <Pill state={asset.review_status || 'pending'} />
            <span>
              {asset.width} × {asset.height}
            </span>
          </div>
          <p className="fine-print">
            {asset.filename}
            <br />
            SHA-256: {asset.sha256}
          </p>
        </div>
        <div className="asset-inspector">
          <h3>质量与来源</h3>
          {qa ? (
            <>
              <Pill state={qa.status || 'unknown'} />
              <ul className="reason-list">
                {qa.issues?.map((i: any, n: number) => (
                  <li key={n}>
                    {typeof i === 'string' ? i : i.message || i.description || JSON.stringify(i)}
                  </li>
                ))}
              </ul>
              <details open>
                <summary>质检报告</summary>
                <Json value={qa} />
              </details>
            </>
          ) : (
            <p className="muted">
              {asset.identity === 'source' ? '原始导入素材。' : '当前未返回质检报告，请检查执行状态。'}
            </p>
          )}
          <details>
            <summary>完整来源、版本与审核记录</summary>
            <Json value={asset} />
          </details>
          {asset.task_id && (
            <>
              <div className="form-separator" />
              <h3>人工审核</h3>
              <p className="fine-print">
                此操作仅审核当前图片，不确认产品事实、业务试点或对外发布许可。合成测试审核不构成人工业务验收。
              </p>
              <Field label="审核人">
                <input
                  required
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  placeholder="填写审核人姓名"
                />
              </Field>
              <Field label="审核意见">
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="检查产品外观、文字、事实与使用授权。拒绝时请说明原因。"
                />
              </Field>
              <div className="review-actions">
                <button
                  className="danger-outline"
                  disabled={busy || !reviewer.trim() || !notes.trim()}
                  onClick={() => onReview(asset.id, 'rejected', reviewer, notes)}
                >
                  拒绝
                </button>
                <button
                  className="primary"
                  disabled={busy || !reviewer.trim()}
                  onClick={() => onReview(asset.id, 'approved', reviewer, notes)}
                >
                  批准此资产
                </button>
              </div>
              <div className="form-separator" />
              <h3>定向返工</h3>
              <p className="muted">创建新的版本，原始图像与审核历史保留。</p>
              <Field label="修改要求">
                <textarea
                  rows={3}
                  value={revision}
                  onChange={(e) => setRevision(e.target.value)}
                  placeholder="例如：背景改为暖白，保持产品主体和比例。"
                />
              </Field>
              <Field label="修订预算 (USD)">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </Field>
              <label className="check">
                <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
                若需付费，授权在修订预算内执行
              </label>
              <button
                className="secondary full"
                disabled={busy || !revision.trim()}
                onClick={() => onRevise(revision, budget, paid)}
              >
                创建修订任务 ↗
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
