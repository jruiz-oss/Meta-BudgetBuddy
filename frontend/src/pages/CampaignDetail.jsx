import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';
import './DetailPages.css';

function CampaignDetail({ user, onLogout }) {
  const { campaignId, accountId } = useParams();
  const [accounts, setAccounts]       = useState([]);
  const [campaign, setCampaign]       = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [applying, setApplying]       = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [rejected, setRejected]       = useState(false);
  const [pacingRunning, setPacingRunning] = useState(false);
  const [pacingResult,  setPacingResult]  = useState(null);

  // Per-adset apply/reject (ABO only)
  const [adsetApplying,  setAdsetApplying]  = useState({});  // { [adset_id]: bool }
  const [adsetRejected,  setAdsetRejected]  = useState({});  // { [adset_id]: bool }
  const [adsetResults,   setAdsetResults]   = useState({});  // { [adset_id]: {ok,msg} }

  // Ad set allocation editing
  const [editingAdsets, setEditingAdsets]   = useState(false);
  const [adsetMode, setAdsetMode]           = useState('pct');   // 'pct' | 'daily'
  const [adsetDrafts, setAdsetDrafts]       = useState({});      // { [adset_id]: string }
  const [adsetSaving, setAdsetSaving]       = useState(false);
  const [adsetError, setAdsetError]         = useState('');

  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [accountsRes, campaignRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/campaigns/${accountId}/${campaignId}`),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setCampaign(campaignRes.data.campaign || campaignRes.data);
      setRejected(false);
      setApplyResult(null);
    } catch {
      setError('Failed to load campaign data');
    } finally {
      setLoading(false);
    }
  }, [campaignId, accountId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout();
    navigate('/login');
  };

  const handleApply = async () => {
    if (!lp || rejected || applying) return;
    setApplying(true);
    setError('');

    const mode = campaign.budget_mode || 'CBO';
    const adjustments = [];

    if (mode === 'ABO') {
      (campaign.adsets || []).forEach((a) => {
        const alp = a.latest_pacing;
        // AdSet.latest_pacing comes from PacingData.to_dict() which exposes `status`, not `action`.
        const aStatus = (alp?.status || '').toUpperCase();
        if (!alp || aStatus === 'ON_PACE') return;
        adjustments.push({
          level: 'adset',
          campaign_id: campaign.id,
          campaign_name: campaign.campaign_name,
          adset_id: a.id,
          adset_name: a.adset_name,
          current_daily_budget: alp.current_daily_budget,
          recommended_daily_budget: alp.recommended_daily_budget,
          change_percent: alp.change_percent,
          action: aStatus,
        });
      });
    } else {
      // CBO: campaign.latest_pacing comes from Campaign.to_dict() → PacingData.to_dict(),
      // which exposes the field as `status` (not `action`).
      const cboStatus = (lp.status || '').toUpperCase();
      if (cboStatus !== 'ON_PACE') {
        adjustments.push({
          level: 'campaign',
          campaign_id: campaign.id,
          campaign_name: campaign.campaign_name,
          current_daily_budget: lp.current_daily_budget,
          recommended_daily_budget: lp.recommended_daily_budget,
          change_percent: lp.change_percent,
          action: cboStatus,
        });
      }
    }

    if (adjustments.length === 0) {
      setApplyResult({ message: 'Already on pace — nothing to apply.' });
      setApplying(false);
      return;
    }

    try {
      const res = await axios.post(`/api/pacing/${accountId}/apply`, { adjustments });
      setApplyResult(res.data);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to apply recommendation');
    } finally {
      setApplying(false);
    }
  };

  // ── run pacing for this campaign only ────────────────────
  const handleRunPacing = async () => {
    setPacingRunning(true);
    setPacingResult(null);
    setAdsetApplying({});
    setAdsetRejected({});
    setAdsetResults({});
    try {
      await axios.post(`/api/pacing/${accountId}/run`, {
        run_type: 'MANUAL',
        campaign_id: campaignId,
      });
      await fetchData();   // refresh ad set pacing data from DB
      setPacingResult({ ok: true, msg: 'Pacing updated.' });
    } catch (err) {
      setPacingResult({ ok: false, msg: err.response?.data?.error || 'Pacing run failed' });
    } finally {
      setPacingRunning(false);
    }
  };

  // ── per-adset apply (ABO) ────────────────────────────────
  const handleApplyAdset = async (adset) => {
    const alp = adset.latest_pacing;
    if (!alp || adsetApplying[adset.id]) return;

    setAdsetApplying((p) => ({ ...p, [adset.id]: true }));
    setAdsetResults((p) => ({ ...p, [adset.id]: null }));

    const adjustment = {
      level: 'adset',
      campaign_id: campaign.id,
      campaign_name: campaign.campaign_name,
      adset_id: adset.id,
      adset_name: adset.adset_name,
      current_daily_budget: alp.current_daily_budget,
      recommended_daily_budget: alp.recommended_daily_budget,
      change_percent: alp.change_percent,
      action: alp.action || alp.status,
    };

    try {
      await axios.post(`/api/pacing/${accountId}/apply`, { adjustments: [adjustment] });
      setAdsetResults((p) => ({ ...p, [adset.id]: { ok: true, msg: `Applied — new daily: $${(alp.recommended_daily_budget || 0).toFixed(2)}` } }));
      fetchData();
    } catch (err) {
      setAdsetResults((p) => ({ ...p, [adset.id]: { ok: false, msg: err.response?.data?.error || 'Failed to apply' } }));
    } finally {
      setAdsetApplying((p) => ({ ...p, [adset.id]: false }));
    }
  };

  const handleRejectAdset = (adsetId) =>
    setAdsetRejected((p) => ({ ...p, [adsetId]: true }));

  const handleUndoRejectAdset = (adsetId) =>
    setAdsetRejected((p) => ({ ...p, [adsetId]: false }));

  // ── adset allocation editing ─────────────────────────────
  const enterEditMode = () => {
    // Seed drafts from current allocation_pct values.
    const drafts = {};
    (campaign?.adsets || []).forEach((a) => {
      drafts[a.id] = String((a.allocation_pct || 0).toFixed(2));
    });
    setAdsetDrafts(drafts);
    setAdsetMode('pct');
    setAdsetError('');
    setEditingAdsets(true);
  };

  const cancelEditMode = () => {
    setEditingAdsets(false);
    setAdsetDrafts({});
    setAdsetError('');
  };

  // Convert all drafts between % and $/day when toggling mode.
  const toggleAdsetMode = (newMode) => {
    if (newMode === adsetMode) return;
    const monthly = campaign?.monthly_budget || 0;
    const impliedDaily = monthly / 30;
    const converted = {};
    (campaign?.adsets || []).forEach((a) => {
      const raw = parseFloat(adsetDrafts[a.id]);
      if (!Number.isFinite(raw)) { converted[a.id] = ''; return; }
      if (newMode === 'daily') {
        // pct → $/day:  daily = monthly * pct/100 / 30
        converted[a.id] = ((monthly * raw) / 100 / 30).toFixed(2);
      } else {
        // $/day → pct:  pct = daily * 30 / monthly * 100
        converted[a.id] = impliedDaily > 0
          ? ((raw * 30 / monthly) * 100).toFixed(2)
          : '0';
      }
    });
    setAdsetDrafts(converted);
    setAdsetMode(newMode);
    setAdsetError('');
  };

  const updateDraft = (id, val) => {
    setAdsetDrafts((prev) => ({ ...prev, [id]: val }));
    setAdsetError('');
  };

  // Compute live % sum (always in % terms, regardless of current input mode).
  const liveAllocPcts = () => {
    const monthly = campaign?.monthly_budget || 0;
    return (campaign?.adsets || []).map((a) => {
      const raw = parseFloat(adsetDrafts[a.id]);
      if (!Number.isFinite(raw)) return 0;
      if (adsetMode === 'daily') {
        return monthly > 0 ? (raw * 30 / monthly) * 100 : 0;
      }
      return raw;
    });
  };

  const allocSum = liveAllocPcts().reduce((s, v) => s + v, 0);
  const allocOk  = Math.abs(allocSum - 100) <= 1.5;

  const saveAdsetAllocations = async () => {
    setAdsetError('');
    const monthly = campaign?.monthly_budget || 0;
    const adsets  = (campaign?.adsets || []).map((a) => {
      const raw = parseFloat(adsetDrafts[a.id]);
      let pct = Number.isFinite(raw) ? raw : 0;
      if (adsetMode === 'daily') {
        pct = monthly > 0 ? (raw * 30 / monthly) * 100 : 0;
      }
      return { id: a.id, allocation_pct: Math.round(pct * 100) / 100 };
    });

    const total = adsets.reduce((s, a) => s + a.allocation_pct, 0);
    if (Math.abs(total - 100) > 1.5) {
      setAdsetError(`Allocations sum to ${total.toFixed(2)}% — must be ~100%.`);
      return;
    }

    setAdsetSaving(true);
    try {
      await axios.put(`/api/campaigns/${accountId}/${campaignId}/adsets`, { adsets });
      await fetchData();   // refresh campaign so adsets reflect new allocations
      setEditingAdsets(false);
      setAdsetDrafts({});
    } catch (err) {
      setAdsetError(err.response?.data?.error || 'Failed to save allocations');
    } finally {
      setAdsetSaving(false);
    }
  };

  // ── helpers ───────────────────────────────────────────────
  const pillForStatus = (status) => {
    const s = (status || '').toUpperCase();
    if (s === 'ON_PACE')  return { cls: 'bb-pill bb-pill-on',   label: 'On Pace' };
    if (s === 'INCREASE') return { cls: 'bb-pill bb-pill-up',   label: 'Increase' };
    if (s === 'DECREASE') return { cls: 'bb-pill bb-pill-down', label: 'Decrease' };
    return { cls: 'bb-pill bb-pill-muted', label: '—' };
  };

  const fmt$ = (n, dec = 0) =>
    `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

  // ── derived values ────────────────────────────────────────
  const lp            = campaign?.latest_pacing;
  const mode          = campaign?.budget_mode || 'CBO';
  const hasPacing     = !!lp;
  // `latest_pacing` comes from Campaign.to_dict(); the field is `status` (PacingData column),
  // not `action`. Reading `action` here was the cause of the "Apply on ON_PACE campaigns" bug.
  const action        = (lp?.status || '').toUpperCase();
  const isOnPace      = action === 'ON_PACE';
  const pill          = pillForStatus(action);

  const today         = new Date();
  const daysInMonth   = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysElapsed   = today.getDate();
  const actualSpend   = lp?.actual_spend    || 0;
  const expectedSpend = lp?.expected_spend  || 0;
  const paceRatio     = lp?.pace_ratio      || 0;
  const gap           = actualSpend - expectedSpend;
  const gapColor      = gap >= 0 ? '#10b981' : '#3b82f6';

  const summaryText = () => {
    if (!lp) return null;
    const pct    = Math.abs((paceRatio - 1) * 100).toFixed(0);
    const gapAbs = Math.abs(gap).toFixed(0);
    if (isOnPace)              return 'Campaign is spending on pace. No budget change needed.';
    if (action === 'INCREASE') return `Campaign is ${pct}% behind expected pace. At current rate, will underspend by ~$${gapAbs} vs. target.`;
    if (action === 'DECREASE') return `Campaign is ${pct}% ahead of expected pace. At current rate, will overspend by ~$${gapAbs} vs. target.`;
    return null;
  };

  const showRec = hasPacing && !isOnPace && !rejected;

  // ── loading / error guards ────────────────────────────────
  if (loading) return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />
      <main className="bb-main">
        <div className="bb-card bb-section bb-muted">Loading campaign…</div>
      </main>
    </div>
  );

  if (!campaign) return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />
      <main className="bb-main">
        <div className="bb-alert bb-alert-error">Campaign not found.</div>
      </main>
    </div>
  );

  // ── render ────────────────────────────────────────────────
  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />

      <main className="bb-main">

        {/* Back + breadcrumb */}
        <div style={{ marginBottom: 16 }}>
          <button
            className="bb-btn bb-btn-ghost"
            style={{ padding: '4px 10px', fontSize: 13, marginBottom: 6 }}
            onClick={() => navigate(`/account/${accountId}`)}
          >
            ← Back to Dashboard
          </button>
          <div className="bb-breadcrumb">
            <Link to="/">Home</Link>
            {' / '}
            <Link to={`/account/${accountId}`}>Dashboard</Link>
            {' / '}{campaign.campaign_name}
          </div>
        </div>

        {/* Title row */}
        <div className="bb-row-between" style={{ marginBottom: 20 }}>
          <div>
            <div className="cd-eyebrow">Campaign Detail</div>
            <div className="bb-page-title" style={{ marginBottom: 4 }}>{campaign.campaign_name}</div>
            <div className="bb-page-subtitle">
              Campaign ID: {campaign.meta_campaign_id}
              {' · '}
              <span className={`bb-mode-badge ${mode === 'ABO' ? 'bb-mode-abo' : 'bb-mode-cbo'}`}>
                {mode}
              </span>
            </div>
          </div>
          <div className="bb-row">
            {hasPacing && <span className={pill.cls}>{pill.label}</span>}
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
          </div>
        </div>

        {error       && <div className="bb-alert bb-alert-error"   style={{ marginBottom: 16 }}>{error}</div>}
        {applyResult && <div className="bb-alert bb-alert-success" style={{ marginBottom: 16 }}>{applyResult.message || 'Applied successfully.'}</div>}

        {/* 4 stat tiles */}
        <div className="bb-grid bb-grid-4" style={{ marginBottom: 20 }}>
          <div className="bb-stat">
            <span className="bb-stat-label">Monthly Budget</span>
            <span className="bb-stat-value">{fmt$(campaign.monthly_budget)}</span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Daily Budget</span>
            <span className="bb-stat-value">{fmt$(lp?.current_daily_budget, 2)}</span>
          </div>
          <div className="bb-stat cd-stat-accent">
            <span className="bb-stat-label">Actual Spend</span>
            <span className="bb-stat-value cd-accent-value">{fmt$(actualSpend)}</span>
            <span className="bb-stat-sub">expected {fmt$(expectedSpend)}</span>
          </div>
          <div className="bb-stat cd-stat-accent">
            <span className="bb-stat-label">Pace Ratio</span>
            <span className="bb-stat-value cd-accent-value">
              {hasPacing ? `${(paceRatio * 100).toFixed(0)}%` : '—'}
            </span>
            {hasPacing && (
              <span className="bb-stat-sub">{paceRatio >= 1 ? 'ahead' : 'behind'} of target</span>
            )}
          </div>
        </div>

        {/* Pacing Breakdown + Recommended Action (CBO only for the action card) */}
        {hasPacing && (
          <div className="cd-two-col" style={{ marginBottom: 20 }}>

            {/* LEFT — Pacing Breakdown */}
            <div className="bb-card">
              <div className="bb-section">
                <div className="bb-section-title" style={{ marginBottom: 16 }}>Pacing Breakdown</div>
                <div className="cd-breakdown-grid">
                  <div className="cd-breakdown-item">
                    <span className="cd-breakdown-label">Days in Month</span>
                    <span className="cd-breakdown-value">{daysInMonth}</span>
                  </div>
                  <div className="cd-breakdown-item">
                    <span className="cd-breakdown-label">Days Elapsed</span>
                    <span className="cd-breakdown-value">{daysElapsed}</span>
                  </div>
                  <div className="cd-breakdown-item">
                    <span className="cd-breakdown-label">Expected Spend</span>
                    <span className="cd-breakdown-value">{fmt$(expectedSpend)}</span>
                  </div>
                  <div className="cd-breakdown-item">
                    <span className="cd-breakdown-label">Gap</span>
                    <span className="cd-breakdown-value" style={{ color: gapColor }}>
                      {gap >= 0 ? '+' : '-'}{fmt$(Math.abs(gap))}
                    </span>
                  </div>
                </div>
                {summaryText() && (
                  <div className="cd-summary-text">{summaryText()}</div>
                )}
              </div>
            </div>

            {/* RIGHT — Recommended Action (CBO only; ABO handles this per-adset in the table below) */}
            <div className={`bb-card cd-recommendation${showRec && mode !== 'ABO' ? ' cd-recommendation-active' : ''}`}>
              <div className="bb-section">
                <div className="bb-section-title" style={{ marginBottom: 16 }}>Recommended Action</div>

                {mode === 'ABO' ? (
                  // ABO: per-adset Apply/Reject are in the Ad Sets table below
                  <div style={{ fontSize: 13, color: 'var(--bb-text-muted)', lineHeight: 1.6 }}>
                    This is an <strong>ABO</strong> campaign — budgets are set per ad set.
                    Use the <strong>Apply</strong> / <strong>Reject</strong> buttons in the
                    Ad Sets table below to act on individual ad set recommendations.
                  </div>
                ) : rejected ? (
                  <p className="bb-muted" style={{ fontSize: 14 }}>
                    Recommendation rejected. Run pacing again to get a new one.
                  </p>
                ) : isOnPace ? (
                  <div className="cd-on-pace-msg">
                    <div className="cd-rec-label">Status</div>
                    <div className="cd-rec-amount" style={{ color: '#10b981', fontSize: 32 }}>On Pace ✓</div>
                    <div className="bb-muted" style={{ fontSize: 13, marginTop: 6 }}>No budget change needed.</div>
                  </div>
                ) : (
                  <>
                    <div className="cd-rec-center">
                      <div className="cd-rec-label">New Daily Budget</div>
                      <div className="cd-rec-amount">{fmt$(lp.recommended_daily_budget, 2)}</div>
                      <div
                        className="cd-rec-change"
                        style={{ color: (lp.change_percent || 0) > 0 ? '#10b981' : '#f59e0b' }}
                      >
                        {(lp.change_percent || 0) > 0 ? '+' : ''}
                        {fmt$(Math.abs((lp.recommended_daily_budget || 0) - (lp.current_daily_budget || 0)), 2)}/day
                        {' '}({(lp.change_percent || 0) > 0 ? '+' : ''}{(lp.change_percent || 0).toFixed(1)}%)
                      </div>
                    </div>
                    <button
                      className="bb-btn bb-btn-primary cd-apply-btn"
                      onClick={handleApply}
                      disabled={applying}
                    >
                      {applying ? 'Applying…' : '✓ Apply Recommendation'}
                    </button>
                    <button
                      className="bb-btn cd-reject-btn"
                      onClick={() => setRejected(true)}
                      disabled={applying}
                    >
                      × Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ABO ad-set table */}
        {mode === 'ABO' && Array.isArray(campaign.adsets) && campaign.adsets.length > 0 && (
          <div className="bb-card" style={{ marginBottom: 20 }}>
            <div className="bb-section">
              <div className="bb-section-head">
                <div>
                  <div className="bb-section-title">Ad Sets ({campaign.adsets.length})</div>
                  <div className="bb-section-meta">
                    Pacing runs per ad set. Use <strong>Edit Allocations</strong> to adjust splits.
                  </div>
                </div>
                {!editingAdsets && (
                  <div className="bb-row">
                    <button
                      className="bb-btn bb-btn-primary"
                      onClick={handleRunPacing}
                      disabled={pacingRunning}
                    >
                      {pacingRunning ? 'Running…' : 'Run Pacing'}
                    </button>
                    <button className="bb-btn bb-btn-secondary" onClick={enterEditMode}>
                      Edit Allocations
                    </button>
                  </div>
                )}
              </div>
              {pacingResult && (
                <div className={`bb-alert ${pacingResult.ok ? 'bb-alert-success' : 'bb-alert-error'}`}
                  style={{ margin: '8px 0 0' }}>
                  {pacingResult.msg}
                </div>
              )}
            </div>

            {/* Edit-mode toolbar */}
            {editingAdsets && (
              <div className="cd-alloc-toolbar">
                <div className="cd-alloc-toolbar-left">
                  <span className="bb-muted" style={{ fontSize: 13 }}>
                    Input mode:
                  </span>
                  <div className="bb-tabs" style={{ display: 'inline-flex', marginLeft: 8 }}>
                    <button
                      className={`bb-tab-btn${adsetMode === 'pct'   ? ' is-active' : ''}`}
                      onClick={() => toggleAdsetMode('pct')}
                    >% Allocation</button>
                    <button
                      className={`bb-tab-btn${adsetMode === 'daily' ? ' is-active' : ''}`}
                      onClick={() => toggleAdsetMode('daily')}
                    >$/day</button>
                  </div>
                  {adsetMode === 'daily' && (
                    <span className="bb-muted" style={{ fontSize: 12, marginLeft: 12 }}>
                      Campaign target: {fmt$(campaign.monthly_budget / 30, 2)}/day
                    </span>
                  )}
                </div>
                <div className="bb-row">
                  <span
                    className="cd-alloc-sum"
                    style={{ color: allocOk ? '#10b981' : '#f59e0b' }}
                  >
                    Total: {allocSum.toFixed(1)}%{allocOk ? ' ✓' : ' — must equal 100%'}
                  </span>
                  <button
                    className="bb-btn bb-btn-primary"
                    onClick={saveAdsetAllocations}
                    disabled={adsetSaving || !allocOk}
                  >
                    {adsetSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button className="bb-btn" onClick={cancelEditMode} disabled={adsetSaving}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {adsetError && (
              <div className="bb-alert bb-alert-error" style={{ margin: '0 0 0 0', borderRadius: 0 }}>
                {adsetError}
              </div>
            )}

            <table className="bb-table">
              <thead>
                <tr>
                  <th>Ad Set</th>
                  <th>{editingAdsets ? (adsetMode === 'pct' ? 'Allocation %' : '$/day target') : 'Allocation'}</th>
                  <th>Monthly Budget</th>
                  <th>MTD Spend</th>
                  <th>Pace</th>
                  <th>Current Daily</th>
                  <th>Rec. Daily</th>
                  <th>Status</th>
                  {!editingAdsets && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {campaign.adsets.map((a) => {
                  const alp          = a.latest_pacing;
                  const alpAction    = (alp?.action || alp?.status || '').toUpperCase();
                  const aPill        = pillForStatus(alpAction);
                  const adsetMonthly = campaign.monthly_budget * (a.allocation_pct / 100);
                  const isApplying   = !!adsetApplying[a.id];
                  const isRejected   = !!adsetRejected[a.id];
                  const result       = adsetResults[a.id];
                  const needsAction  = alp && alpAction !== 'ON_PACE';

                  return (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 600 }}>{a.adset_name}</td>
                      <td>
                        {editingAdsets ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {adsetMode === 'daily' && <span className="bb-muted" style={{ fontSize: 13 }}>$</span>}
                            <input
                              type="number"
                              min="0"
                              step={adsetMode === 'pct' ? '0.5' : '1'}
                              className="bb-input"
                              style={{ width: 90 }}
                              value={adsetDrafts[a.id] ?? ''}
                              onChange={(e) => updateDraft(a.id, e.target.value)}
                            />
                            {adsetMode === 'pct' && <span className="bb-muted" style={{ fontSize: 13 }}>%</span>}
                          </div>
                        ) : (
                          <span className="num">
                            {(a.allocation_pct || 0).toFixed(1)}%
                            <span className="bb-muted" style={{ fontSize: 11, marginLeft: 4 }}>
                              ({fmt$(adsetMonthly / 30, 2)}/day)
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="num">{fmt$(adsetMonthly)}/mo</td>
                      <td className="num">{alp ? fmt$(alp.actual_spend, 2) : '—'}</td>
                      <td className="num">{alp ? `${(alp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                      <td className="num">
                        {alp?.current_daily_budget != null ? fmt$(alp.current_daily_budget, 2) : '—'}
                      </td>
                      <td className="num">
                        {alp?.recommended_daily_budget != null ? fmt$(alp.recommended_daily_budget, 2) : '—'}
                      </td>
                      <td>
                        {alp
                          ? <span className={aPill.cls}>{aPill.label}</span>
                          : <span className="bb-muted">No data</span>}
                      </td>
                      {!editingAdsets && (
                        <td>
                          {result?.ok ? (
                            <span style={{ color: '#10b981', fontSize: 12, fontWeight: 600 }}>✓ Applied</span>
                          ) : result && !result.ok ? (
                            <span style={{ color: '#ef4444', fontSize: 12 }}>{result.msg}</span>
                          ) : isRejected ? (
                            <span style={{ fontSize: 12 }}>
                              <span className="bb-muted">Skipped</span>
                              {' · '}
                              <button
                                style={{ background: 'none', border: 'none', color: 'var(--bb-primary)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                                onClick={() => handleUndoRejectAdset(a.id)}
                              >
                                Undo
                              </button>
                            </span>
                          ) : needsAction ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                className="bb-btn bb-btn-primary"
                                style={{ fontSize: 11, padding: '3px 10px' }}
                                onClick={() => handleApplyAdset(a)}
                                disabled={isApplying}
                              >
                                {isApplying ? '…' : 'Apply'}
                              </button>
                              <button
                                className="bb-btn"
                                style={{ fontSize: 11, padding: '3px 8px' }}
                                onClick={() => handleRejectAdset(a.id)}
                                disabled={isApplying}
                              >
                                Skip
                              </button>
                            </div>
                          ) : (
                            <span className="bb-muted" style={{ fontSize: 12 }}>—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Recent Adjustments */}
        <div className="bb-card">
          <div className="bb-section">
            <div className="bb-section-head">
              <div className="bb-section-title">Recent Adjustments</div>
              <div className="bb-section-meta">Budget changes applied to this campaign.</div>
            </div>
          </div>
          {(!campaign.recent_adjustments || campaign.recent_adjustments.length === 0) ? (
            <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>
              No adjustments yet. Apply a recommendation to see history here.
            </div>
          ) : (
            <table className="bb-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Old Budget</th>
                  <th>New Budget</th>
                  <th>Change</th>
                  <th>Reason</th>
                  <th>Applied By</th>
                </tr>
              </thead>
              <tbody>
                {campaign.recent_adjustments.slice().reverse().map((adj, i) => {
                  const up = (adj.change_percent || 0) > 0;
                  return (
                    <tr key={i}>
                      <td>
                        {adj.applied_at
                          ? new Date(adj.applied_at).toLocaleDateString('en-US', {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })
                          : '—'}
                      </td>
                      <td className="num">{fmt$(adj.old_budget, 2)}/day</td>
                      <td className="num">{fmt$(adj.new_budget, 2)}/day</td>
                      <td>
                        <span style={{ fontWeight: 600, color: up ? '#10b981' : '#f59e0b' }}>
                          {up ? '+' : ''}{(adj.change_percent || 0).toFixed(1)}%
                        </span>
                      </td>
                      <td>{adj.reason || '—'}</td>
                      <td className="bb-muted">{adj.applied_by || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

      </main>
    </div>
  );
}

export default CampaignDetail;
