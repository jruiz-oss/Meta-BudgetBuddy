/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import {
  Play, Check, X, LogOut, Download, Plus, Inbox, Loader2,
  TrendingUp, TrendingDown, Minus,
  History as HistoryIcon, Settings as SettingsIcon, DownloadCloud,
} from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { SkeletonStatTile, SkeletonTable } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import SpendChart from '../components/SpendChart';
import { useToast } from '../components/Toast';
import { getCached, isStale, setCached, invalidateCache } from '../cache';

/**
 * Single-account dashboard.
 *
 * Top:    4 stat tiles (On Pace / Need Increase / Need Decrease / Total Spend)
 * Then:   Spend-vs-target chart for the whole account
 * Middle: latest pacing run summary (when present) with Apply All button
 * Bottom: tracked campaigns table with current daily, recommended daily, and change indicator
 * Modal:  Import campaigns from Meta
 */
function AccountDashboard({ user, onLogout }) {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [hiddenCampaigns, setHiddenCampaigns] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Aggregated pacing history for the spend chart (sum of MTD-actual across this account's campaigns)
  const [accountHistory, setAccountHistory] = useState([]);

  const [pacingRunning, setPacingRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [applying, setApplying] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingAdjustments, setPendingAdjustments] = useState([]);

  // Remove-campaign confirmation modal (replaces window.confirm)
  const [removeTarget, setRemoveTarget] = useState(null);

  // Import-from-Meta modal state
  const [showImport, setShowImport] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSaving, setImportSaving] = useState(false);
  const [metaCampaigns, setMetaCampaigns] = useState([]);
  const [importSelections, setImportSelections] = useState({});

  useEffect(() => { fetchAll(); }, [accountId]);

  const fetchAll = async (force = false) => {
    const cacheKey = `dashboard-${accountId}`;
    const cached = getCached(cacheKey);

    if (cached && !force) {
      setAccounts(cached.accounts);
      setAccount(cached.account);
      setCampaigns(cached.campaigns);
      setHiddenCampaigns(cached.hiddenCampaigns || []);
      setAccountHistory(cached.history || []);
      setLoading(false);
      if (!isStale(cacheKey)) return;
      // stale — fall through and refresh silently
    }

    if (!cached) setLoading(true);

    try {
      const [accountsRes, accountRes, campaignsRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/accounts/${accountId}`),
        axios.get(`/api/campaigns/${accountId}`),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setAccount(accountRes.data.account || accountRes.data);
      const camps = campaignsRes.data.campaigns || [];
      const hiddenCamps = campaignsRes.data.hidden_campaigns || [];
      setCampaigns(camps);
      setHiddenCampaigns(hiddenCamps);

      // Fetch aggregated pacing history for the spend chart — one request instead
      // of one per campaign (the old N+1 pattern was the main cause of slow loads).
      try {
        const histRes = await axios.get(`/api/campaigns/${accountId}/history-aggregate`).catch(() => null);
        const aggregated = histRes?.data?.history || [];
        setAccountHistory(aggregated);

        // Cache the full set so navigating away and back is instant
        setCached(`dashboard-${accountId}`, {
          accounts: accountsRes.data.accounts || accountsRes.data || [],
          account: accountRes.data.account || accountRes.data,
          campaigns: camps,
          hiddenCampaigns: hiddenCamps,
          history: aggregated,
        });
      } catch {
        setAccountHistory([]);
      }
    } catch (err) {
      if (!cached) setError('Failed to load account data');
    } finally {
      setLoading(false);
    }
  };

  const handleRunPacing = async () => {
    setPacingRunning(true);
    setError('');
    try {
      // 3-minute timeout — pacing calls the Meta API once per campaign (now in
      // parallel), but a large account or slow Meta response can still take >60s.
      const response = await axios.post(
        `/api/pacing/${accountId}/run`,
        { run_type: 'MANUAL' },
        { timeout: 180000 },
      );
      setLastRun(response.data);
      toast.success(
        `${response.data.campaigns_processed || 0} campaigns processed, ${response.data.adjustments_needed || 0} need adjusting.`,
        { title: 'Pacing complete' }
      );
      if (response.data.failures && response.data.failures.length > 0) {
        toast.warn(`${response.data.failures.length} campaign(s) had errors.`);
      }

      // Bust cache so the post-run fetch gets live data
      // Surface sheet writeback result so the user can see what happened
      const sw = response.data.sheet_writeback;
      if (sw) {
        if (sw.error) {
          toast.error(`Sheet sync failed: ${sw.error}`, { title: 'Sheet not updated' });
        } else if (sw.written_count > 0) {
          const skipNote = sw.skipped_count > 0 ? ` (${sw.skipped_count} skipped)` : '';
          toast.success(`Wrote spend to ${sw.written_count} row(s) in "${sw.sheet_tab}"${skipNote}.`, { title: 'Sheet updated' });
        } else {
          // 0 written — tell the user the first skip reason so they can diagnose
          const firstReason = sw.skipped && sw.skipped.length > 0 ? ` Reason: ${sw.skipped[0].reason}` : '';
          toast.warn(`Sheet: nothing written — ${sw.skipped_count || 0} row(s) skipped.${firstReason}`, { title: 'Sheet not updated' });
        }
      }

      invalidateCache(`dashboard-${accountId}`, 'home-data');
      fetchAll(true);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to run pacing calculations';
      setError(msg);
      toast.error(msg, { title: 'Pacing failed' });
    } finally {
      setPacingRunning(false);
    }
  };

  const handleRemoveCampaign = async () => {
    if (!removeTarget) return;
    const { id, name } = removeTarget;
    setRemoveTarget(null);
    try {
      await axios.put(`/api/campaigns/${accountId}/${id}`, { is_active: false });
      toast.success(`Removed "${name}" from pacing.`);
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove campaign');
    }
  };

  const handleApplyAll = () => {
    if (!lastRun || !lastRun.recommendations) return;
    const adjustments = [];
    lastRun.recommendations.forEach((r) => {
      if ((r.budget_mode || 'CBO') === 'ABO') {
        (r.adset_level || []).forEach((a) => {
          if (a.action === 'ON_PACE') return;
          adjustments.push({
            level: 'adset',
            campaign_id: r.campaign_id,
            campaign_name: r.campaign_name,
            adset_id: a.adset_id,
            adset_name: a.adset_name,
            current_daily_budget: a.current_daily_budget,
            recommended_daily_budget: a.recommended_daily_budget,
            change_percent: a.change_percent,
            action: a.action,
          });
        });
      } else {
        if (r.action === 'ON_PACE') return;
        adjustments.push({
          level: 'campaign',
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          current_daily_budget: r.current_daily_budget,
          recommended_daily_budget: r.recommended_daily_budget,
          change_percent: r.change_percent,
          action: r.action,
        });
      }
    });

    if (adjustments.length === 0) {
      toast.info('Nothing to apply — everything is on pace.');
      return;
    }
    setPendingAdjustments(adjustments);
    setShowConfirm(true);
  };

  const handleConfirmApply = async () => {
    setShowConfirm(false);
    setApplying(true);
    setError('');
    try {
      const response = await axios.post(`/api/pacing/${accountId}/apply`, { adjustments: pendingAdjustments });
      toast.success(
        `${response.data.applied_count || pendingAdjustments.length} budget change${pendingAdjustments.length === 1 ? '' : 's'} pushed to Meta.`,
        { title: 'Applied' }
      );
      fetchAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to apply recommendations';
      setError(msg);
      toast.error(msg, { title: 'Apply failed' });
    } finally {
      setApplying(false);
      setPendingAdjustments([]);
    }
  };

  const openImport = async () => {
    setShowImport(true);
    setImportLoading(true);
    setImportError('');
    setMetaCampaigns([]);
    setImportSelections({});
    try {
      const response = await axios.get(`/api/campaigns/${accountId}/sync`);
      const list = response.data.campaigns || [];
      setMetaCampaigns(list);
      const seed = {};
      list.forEach((c) => {
        const adsetSeed = {};
        (c.adsets || []).forEach((a) => {
          adsetSeed[a.meta_adset_id] = {
            name: a.name,
            current_daily_budget: a.current_daily_budget,
            allocation_pct: a.allocation_pct,
          };
        });
        seed[c.meta_campaign_id] = {
          selected: !!c.already_tracked,
          monthly_budget: c.saved_monthly_budget != null
            ? c.saved_monthly_budget
            : (c.current_daily_budget ? Math.round(c.current_daily_budget * 30) : ''),
          adsets: adsetSeed,
        };
      });
      setImportSelections(seed);
    } catch (err) {
      setImportError(
        err.response?.data?.error ||
          'Could not fetch campaigns from Meta. Check the access token + ad account ID on this account.'
      );
    } finally {
      setImportLoading(false);
    }
  };

  const closeImport = () => { setShowImport(false); setImportError(''); };

  const toggleImportSelection = (metaId) => {
    setImportSelections((prev) => ({
      ...prev,
      [metaId]: { ...prev[metaId], selected: !prev[metaId]?.selected },
    }));
  };

  const updateImportBudget = (metaId, value) => {
    setImportSelections((prev) => ({
      ...prev,
      [metaId]: { ...prev[metaId], monthly_budget: value },
    }));
  };

  const updateAdsetAllocation = (metaCampaignId, metaAdsetId, value) => {
    setImportSelections((prev) => {
      const c = prev[metaCampaignId] || {};
      const adsets = { ...(c.adsets || {}) };
      adsets[metaAdsetId] = { ...(adsets[metaAdsetId] || {}), allocation_pct: value };
      return { ...prev, [metaCampaignId]: { ...c, adsets } };
    });
  };

  const allocationSumFor = (metaCampaignId) => {
    const sel = importSelections[metaCampaignId];
    if (!sel || !sel.adsets) return 0;
    return Object.values(sel.adsets).reduce((sum, a) => {
      const n = parseFloat(a.allocation_pct);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  };

  const evenSplitAllocations = (metaCampaignId) => {
    setImportSelections((prev) => {
      const c = prev[metaCampaignId] || {};
      const adsets = { ...(c.adsets || {}) };
      const keys = Object.keys(adsets);
      if (keys.length === 0) return prev;
      const even = Math.round((100 / keys.length) * 100) / 100;
      const remainder = 100 - even * keys.length;
      keys.forEach((k, i) => {
        adsets[k] = { ...adsets[k], allocation_pct: i === 0 ? +(even + remainder).toFixed(2) : even };
      });
      return { ...prev, [metaCampaignId]: { ...c, adsets } };
    });
  };

  const saveImport = async () => {
    const chosen = [];
    const validationErrors = [];
    metaCampaigns.forEach((c) => {
      const sel = importSelections[c.meta_campaign_id];
      if (!sel?.selected) return;
      const monthly = parseFloat(sel.monthly_budget) || 0;
      if (monthly <= 0) {
        validationErrors.push(`${c.name}: missing monthly budget`);
        return;
      }
      const mode = c.budget_mode || (c.is_cbo ? 'CBO' : 'ABO');
      const entry = {
        meta_campaign_id: c.meta_campaign_id,
        campaign_name: c.name,
        monthly_budget: monthly,
        flight_type: 'ALWAYS_ON',
        budget_mode: mode,
        adsets: [],
      };
      if (mode === 'ABO') {
        const liveAdsets = c.adsets || [];
        if (liveAdsets.length === 0) {
          validationErrors.push(`${c.name} (ABO): no ad sets returned by Meta`);
          return;
        }
        let total = 0;
        liveAdsets.forEach((a) => {
          const pctRaw = sel.adsets?.[a.meta_adset_id]?.allocation_pct;
          const pct = parseFloat(pctRaw);
          if (!Number.isFinite(pct) || pct < 0) {
            validationErrors.push(`${c.name}: ${a.name} has invalid allocation %`);
            return;
          }
          total += pct;
          entry.adsets.push({
            meta_adset_id: a.meta_adset_id,
            name: a.name,
            allocation_pct: pct,
          });
        });
        if (Math.abs(total - 100) > 1.5) {
          validationErrors.push(`${c.name} (ABO): allocations sum to ${total.toFixed(2)}%, must be ~100%`);
          return;
        }
      }
      chosen.push(entry);
    });

    if (validationErrors.length > 0) {
      setImportError(validationErrors.join(' • '));
      return;
    }
    if (chosen.length === 0) {
      setImportError('Pick at least one campaign and give it a monthly budget.');
      return;
    }

    setImportSaving(true);
    setImportError('');
    try {
      const seen_meta_ids = metaCampaigns.map((c) => c.meta_campaign_id);
      await axios.post(`/api/campaigns/${accountId}/sync`, { campaigns: chosen, seen_meta_ids });
      toast.success(`Imported ${chosen.length} campaign${chosen.length === 1 ? '' : 's'}.`, { title: 'Saved' });
      closeImport();
      fetchAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to save campaigns';
      const details = err.response?.data?.details;
      if (Array.isArray(details) && details.length > 0) {
        setImportError(`${msg}: ${details.map((d) => d.error || JSON.stringify(d)).join(' • ')}`);
      } else {
        setImportError(msg);
      }
    } finally {
      setImportSaving(false);
    }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout();
    navigate('/login');
  };

  // Derived stats
  const stats = useMemo(() => {
    const s = { onPace: 0, needIncrease: 0, needDecrease: 0, totalSpend: 0, monthlyBudget: 0 };
    campaigns.forEach((c) => {
      s.monthlyBudget += c.monthly_budget || 0;
      if (c.latest_pacing) {
        const status = (c.latest_pacing.status || '').toUpperCase();
        if (status === 'ON_PACE') s.onPace += 1;
        else if (status === 'INCREASE') s.needIncrease += 1;
        else if (status === 'DECREASE') s.needDecrease += 1;
        s.totalSpend += c.latest_pacing.actual_spend || 0;
      }
    });
    return s;
  }, [campaigns]);

  const pillForStatus = (status, paceRatio) => {
    const s = (status || '').toUpperCase();
    if (s === 'ON_PACE' || s === 'INCREASE' || s === 'DECREASE') {
      const ratio = paceRatio || 0;
      const pct   = Math.round(Math.abs((ratio - 1) * 100));
      const text  = ratio >= 1 ? `${pct}% over` : `${pct}% under`;
      const cls   = s === 'ON_PACE' ? 'bb-pill bb-pill-on' : 'bb-pill bb-pill-off';
      const Icon  = s === 'ON_PACE' ? Check : ratio >= 1 ? TrendingUp : TrendingDown;
      return { cls, text, Icon };
    }
    return { cls: 'bb-pill bb-pill-muted', text: '—', Icon: Minus };
  };

  const ChangeBadge = ({ pct }) => {
    if (pct == null || Math.abs(pct) < 0.5) return <span className="bb-change bb-change-flat"><Minus size={10} aria-hidden="true" /> No change</span>;
    if (pct > 0) return <span className="bb-change bb-change-up"><TrendingUp size={10} aria-hidden="true" /> +{pct.toFixed(1)}%</span>;
    return <span className="bb-change bb-change-down"><TrendingDown size={10} aria-hidden="true" /> {pct.toFixed(1)}%</span>;
  };

  if (loading) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} />
        <main className="bb-main">
          <div className="bb-row-between" style={{ marginBottom: 18 }}>
            <div>
              <div className="bb-page-title">Loading…</div>
            </div>
          </div>
          <div className="bb-grid bb-grid-4" style={{ marginBottom: 20 }}>
            <SkeletonStatTile /><SkeletonStatTile /><SkeletonStatTile /><SkeletonStatTile />
          </div>
          <SkeletonTable rows={5} cols={8} />
        </main>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} />
        <main className="bb-main">
          <div className="bb-card bb-section">
            <div className="bb-alert bb-alert-error">Account not found.</div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />

      <main className="bb-main">
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link> / {account.account_name}
        </div>

        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">{account.account_name}</div>
            <div className="bb-page-subtitle">Meta account ID: {account.meta_account_id || '—'}</div>
          </div>
          <div className="bb-row">
            <button className="bb-btn" onClick={openImport}>
              <DownloadCloud size={14} aria-hidden="true" /> Import from Meta
            </button>
            <Link to={`/account/${accountId}/history`} className="bb-btn">
              <HistoryIcon size={14} aria-hidden="true" /> History
            </Link>
            <Link to={`/account/${accountId}/settings`} className="bb-btn">
              <SettingsIcon size={14} aria-hidden="true" /> Settings
            </Link>
            <button
              className="bb-btn bb-btn-primary"
              onClick={handleRunPacing}
              disabled={pacingRunning}
            >
              {pacingRunning ? <Loader2 size={14} className="bb-spin" /> : <Play size={14} aria-hidden="true" />}
              {pacingRunning ? 'Running…' : 'Run Pacing'}
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>
              <LogOut size={14} aria-hidden="true" /> Log out
            </button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* 4 stat tiles */}
        <div className="bb-grid bb-grid-4" style={{ marginBottom: 20 }}>
          <div className="bb-stat bb-stat-on">
            <span className="bb-stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Check size={11} aria-hidden="true" /> On Pace
            </span>
            <span className="bb-stat-value">{stats.onPace}</span>
          </div>
          <div className="bb-stat bb-stat-under">
            <span className="bb-stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <TrendingUp size={11} aria-hidden="true" /> Need Increase
            </span>
            <span className="bb-stat-value">{stats.needIncrease}</span>
          </div>
          <div className="bb-stat bb-stat-over">
            <span className="bb-stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <TrendingDown size={11} aria-hidden="true" /> Need Decrease
            </span>
            <span className="bb-stat-value">{stats.needDecrease}</span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Total Spend (MTD)</span>
            <span className="bb-stat-value">${stats.totalSpend.toFixed(2)}</span>
            <span className="bb-stat-sub">of ${stats.monthlyBudget.toFixed(0)} monthly</span>
          </div>
        </div>

        {/* Pacing-in-progress banner */}
        {pacingRunning && (
          <div className="bb-card bb-pacing-banner" style={{ marginBottom: 20 }}>
            <div className="bb-section">
              <div className="bb-pacing-banner-inner">
                <Loader2 size={22} className="bb-spin" style={{ color: 'var(--bb-primary)' }} />
                <div className="bb-pacing-banner-text">
                  <div className="bb-pacing-banner-title">Running pacing calculations…</div>
                  <div className="bb-pacing-banner-sub">
                    Pulling MTD spend from Meta and computing recommendations for all tracked campaigns.
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Spend chart */}
        {stats.monthlyBudget > 0 && (
          <div className="bb-card" style={{ marginBottom: 20 }}>
            <div className="bb-section">
              <SpendChart
                monthlyBudget={stats.monthlyBudget}
                history={accountHistory}
                currentMtd={stats.totalSpend}
                title="Account spend vs. target"
                height={260}
              />
            </div>
          </div>
        )}

        {/* Latest run summary */}
        {lastRun && (
          <div className="bb-card" style={{ marginBottom: 20 }}>
            <div className="bb-section">
              <div className="bb-section-head">
                <div>
                  <div className="bb-section-title">
                    Latest pacing run — {lastRun.campaigns_processed} campaigns,{' '}
                    {lastRun.adjustments_needed} need adjusting
                  </div>
                  <div className="bb-section-meta">Recommendations from the most recent calculation.</div>
                </div>
                <div className="bb-row">
                  <button
                    className="bb-btn bb-btn-secondary"
                    title="Download full run data as JSON"
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(lastRun, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `pacing-run-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download size={13} aria-hidden="true" /> Download Run Log
                  </button>
                  <button
                    className="bb-btn bb-btn-apply"
                    onClick={handleApplyAll}
                    disabled={applying || lastRun.adjustments_needed === 0}
                  >
                    {applying ? <Loader2 size={14} className="bb-spin" /> : <Check size={14} aria-hidden="true" />}
                    {applying ? 'Applying…' : 'Apply all to Meta'}
                  </button>
                </div>
              </div>

              {lastRun.failures && lastRun.failures.length > 0 && (
                <div className="bb-alert bb-alert-error">
                  {lastRun.failures.length} campaign(s) failed:&nbsp;
                  {lastRun.failures.map((f) => `${f.campaign_name}: ${f.error}`).join(' — ')}
                </div>
              )}
            </div>

            {lastRun.recommendations && lastRun.recommendations.length > 0 && (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Campaign / Ad set</th>
                    <th>Mode</th>
                    <th>MTD Spend</th>
                    <th>Expected</th>
                    <th>Pace</th>
                    <th>Current Daily</th>
                    <th>Recommended</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRun.recommendations.flatMap((r) => {
                    const mode = r.budget_mode || 'CBO';
                    if (mode === 'ABO') {
                      const parentRow = (
                        <tr key={`c-${r.campaign_id}`} className="bb-row-abo-parent">
                          <td style={{ fontWeight: 600 }}>{r.campaign_name}</td>
                          <td><span className="bb-mode-badge bb-mode-abo">ABO</span></td>
                          <td className="num">${(r.actual_spend || 0).toFixed(2)}</td>
                          <td className="num">${(r.expected_spend || 0).toFixed(2)}</td>
                          <td className="num">{(r.pace_ratio || 0).toFixed(2)}x</td>
                          <td className="num bb-muted">—</td>
                          <td className="num bb-muted">—</td>
                          <td><span className="bb-pill bb-pill-muted">rollup</span></td>
                        </tr>
                      );
                      const adsetRows = (r.adset_level || []).map((a) => {
                        const action = (a.action || '').toUpperCase();
                        const tint =
                          action === 'INCREASE' ? 'bb-table-row-tint-up' :
                          action === 'DECREASE' ? 'bb-table-row-tint-down' : '';
                        const pill = pillForStatus(action, a.pace_ratio);
                        return (
                          <tr key={`a-${a.adset_id}`} className={tint}>
                            <td style={{ paddingLeft: 32, color: 'var(--bb-text-muted)' }}>
                              ↳ {a.adset_name} <span className="bb-muted">({a.allocation_pct}%)</span>
                            </td>
                            <td><span className="bb-mode-badge bb-mode-adset">ad&nbsp;set</span></td>
                            <td className="num">${(a.actual_spend || 0).toFixed(2)}</td>
                            <td className="num">${(a.expected_spend || 0).toFixed(2)}</td>
                            <td className="num">{(a.pace_ratio || 0).toFixed(2)}x</td>
                            <td className="num">${(a.current_daily_budget || 0).toFixed(2)}</td>
                            <td className="num">
                              ${(a.recommended_daily_budget || 0).toFixed(2)}
                              <div><ChangeBadge pct={a.change_percent} /></div>
                            </td>
                            <td><span className={pill.cls}><pill.Icon size={11} aria-hidden="true" /> {pill.text}</span></td>
                          </tr>
                        );
                      });
                      return [parentRow, ...adsetRows];
                    }
                    const action = (r.action || '').toUpperCase();
                    const rowTint =
                      action === 'INCREASE' ? 'bb-table-row-tint-up' :
                      action === 'DECREASE' ? 'bb-table-row-tint-down' : '';
                    const pill = pillForStatus(action, r.pace_ratio);
                    return [(
                      <tr key={`c-${r.campaign_id}`} className={rowTint}>
                        <td style={{ fontWeight: 600 }}>{r.campaign_name}</td>
                        <td><span className="bb-mode-badge bb-mode-cbo">CBO</span></td>
                        <td className="num">${(r.actual_spend || 0).toFixed(2)}</td>
                        <td className="num">${(r.expected_spend || 0).toFixed(2)}</td>
                        <td className="num">{(r.pace_ratio || 0).toFixed(2)}x</td>
                        <td className="num">${(r.current_daily_budget || 0).toFixed(2)}</td>
                        <td className="num">
                          ${(r.recommended_daily_budget || 0).toFixed(2)}
                          <div><ChangeBadge pct={r.change_percent} /></div>
                        </td>
                        <td><span className={pill.cls}><pill.Icon size={11} aria-hidden="true" /> {pill.text}</span></td>
                      </tr>
                    )];
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Tracked campaigns table */}
        <div className="bb-card">
          <div className="bb-section">
            <div className="bb-section-head">
              <div className="bb-section-title">Tracked campaigns ({campaigns.length})</div>
              <div className="bb-section-meta">Pulled from Meta via the Import button above.</div>
            </div>
            {hiddenCampaigns.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13, color: 'var(--bb-muted)' }}>
                <span>
                  {hiddenCampaigns.length} campaign{hiddenCampaigns.length !== 1 ? 's' : ''} hidden — no spend recorded this month.
                </span>
                <button
                  className="bb-btn bb-btn-ghost"
                  style={{ fontSize: 12, padding: '2px 10px' }}
                  onClick={() => setShowHidden(h => !h)}
                >
                  {showHidden ? 'Hide ended' : 'Show anyway'}
                </button>
              </div>
            )}
          </div>

          {campaigns.length === 0 && hiddenCampaigns.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No campaigns tracked yet"
              body="Click Import from Meta to pull in your campaigns and start pacing."
              action={{ label: 'Import from Meta', icon: DownloadCloud, onClick: openImport }}
            />
          ) : campaigns.length === 0 && !showHidden ? (
            <EmptyState
              icon={Inbox}
              title="No active campaigns this month"
              body={`${hiddenCampaigns.length} campaign${hiddenCampaigns.length !== 1 ? 's are' : ' is'} hidden because they show no spend this month.`}
              action={{ label: 'Show ended campaigns', icon: DownloadCloud, onClick: () => setShowHidden(true) }}
            />
          ) : (
            <table className="bb-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Mode</th>
                  <th>Flight</th>
                  <th>Monthly Budget</th>
                  <th>Current Daily</th>
                  <th>Pace</th>
                  <th>Recommended Daily</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const lp = c.latest_pacing;
                  const status = lp ? (lp.status || '').toUpperCase() : null;
                  const pill = pillForStatus(status, lp?.pace_ratio);
                  const flightStatus = (c.flight_status || '').toUpperCase();
                  const isLive = flightStatus === 'ACTIVE' || flightStatus === 'LIVE';
                  const mode = c.budget_mode || 'CBO';

                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {c.campaign_name}
                          {isLive && c.flight_type === 'LIMITED' && <span className="bb-flight-live">LIVE</span>}
                        </div>
                        {mode === 'ABO' && c.adset_count > 0 && (
                          <div className="bb-muted" style={{ fontSize: 11, marginTop: 2 }}>
                            {c.adset_count} ad set{c.adset_count === 1 ? '' : 's'}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`bb-mode-badge ${mode === 'ABO' ? 'bb-mode-abo' : 'bb-mode-cbo'}`}>
                          {mode}
                        </span>
                      </td>
                      <td>
                        <span className="bb-pill bb-pill-muted">{c.flight_status || c.flight_type || '—'}</span>
                      </td>
                      <td className="num">${(c.monthly_budget || 0).toFixed(0)}</td>
                      <td className="num">
                        {lp?.current_daily_budget !== undefined && lp?.current_daily_budget !== null
                          ? `$${(lp.current_daily_budget || 0).toFixed(2)}`
                          : (c.current_daily_budget !== undefined ? `$${c.current_daily_budget.toFixed(2)}` : '—')}
                      </td>
                      <td className="num">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                      <td className="num">
                        {lp?.recommended_daily_budget !== undefined && lp?.recommended_daily_budget !== null
                          ? <>${(lp.recommended_daily_budget).toFixed(2)}<div><ChangeBadge pct={lp.change_percent} /></div></>
                          : '—'}
                      </td>
                      <td>
                        {lp ? <span className={pill.cls}><pill.Icon size={11} aria-hidden="true" /> {pill.text}</span> : <span className="bb-muted">No data</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Link to={`/account/${accountId}/campaign/${c.id}`} className="bb-link">View →</Link>
                          <button
                            className="bb-btn bb-btn-danger"
                            style={{ fontSize: 11, padding: '3px 8px' }}
                            onClick={() => setRemoveTarget({ id: c.id, name: c.campaign_name })}
                            title="Remove from pacing"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {showHidden && hiddenCampaigns.map((c) => {
                  const mode = c.budget_mode || 'CBO';
                  return (
                    <tr key={`hidden-${c.id}`} style={{ opacity: 0.45 }}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.campaign_name}</div>
                        <div className="bb-muted" style={{ fontSize: 11, marginTop: 2 }}>No spend this month</div>
                      </td>
                      <td>
                        <span className={`bb-mode-badge ${mode === 'ABO' ? 'bb-mode-abo' : 'bb-mode-cbo'}`}>
                          {mode}
                        </span>
                      </td>
                      <td><span className="bb-pill bb-pill-muted">{c.flight_status || c.flight_type || '—'}</span></td>
                      <td className="num">${(c.monthly_budget || 0).toFixed(0)}</td>
                      <td className="num">—</td>
                      <td className="num">—</td>
                      <td className="num">—</td>
                      <td><span className="bb-pill bb-pill-muted">Ended</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Link to={`/account/${accountId}/campaign/${c.id}`} className="bb-link">View →</Link>
                          <button
                            className="bb-btn bb-btn-danger"
                            style={{ fontSize: 11, padding: '3px 8px' }}
                            onClick={() => setRemoveTarget({ id: c.id, name: c.campaign_name })}
                            title="Remove from pacing"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Apply confirmation modal */}
        {showConfirm && (
          <div className="bb-modal-backdrop" onClick={() => setShowConfirm(false)}>
            <div className="bb-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Confirm budget changes in Meta</div>
                <button className="bb-icon-btn" onClick={() => setShowConfirm(false)} aria-label="Close">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              <div className="bb-modal-body">
                <div className="bb-alert bb-alert-warn" style={{ marginBottom: 16 }}>
                  This will push <strong>{pendingAdjustments.length} budget change{pendingAdjustments.length !== 1 ? 's' : ''}</strong> directly
                  to Meta via the API. This cannot be undone automatically — you would need to revert manually in Ads Manager.
                </div>

                <table className="bb-table">
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>Current Daily</th>
                      <th>New Daily</th>
                      <th>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingAdjustments.map((adj, idx) => {
                      const up = adj.change_percent > 0;
                      const isAdset = adj.level === 'adset' || !!adj.adset_id;
                      return (
                        <tr key={`${adj.level || 'c'}-${adj.adset_id || adj.campaign_id}-${idx}`}>
                          <td>
                            <div style={{ fontWeight: 600 }}>
                              {isAdset ? adj.adset_name : adj.campaign_name}
                            </div>
                            {isAdset && (
                              <div className="bb-muted" style={{ fontSize: 11 }}>
                                Ad set in {adj.campaign_name}
                              </div>
                            )}
                          </td>
                          <td className="num">${(adj.current_daily_budget || 0).toFixed(2)}</td>
                          <td className="num">${(adj.recommended_daily_budget || 0).toFixed(2)}</td>
                          <td>
                            <span className={`bb-change ${up ? 'bb-change-up' : 'bb-change-down'}`}>
                              {up ? <TrendingUp size={11} aria-hidden="true" /> : <TrendingDown size={11} aria-hidden="true" />}
                              {up ? '+' : ''}{(adj.change_percent || 0).toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={() => setShowConfirm(false)}>Cancel</button>
                <button className="bb-btn bb-btn-apply" onClick={handleConfirmApply}>
                  <Check size={14} aria-hidden="true" /> Yes, push to Meta
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Remove campaign confirmation modal */}
        {removeTarget && (
          <div className="bb-modal-backdrop" onClick={() => setRemoveTarget(null)}>
            <div className="bb-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Remove from pacing?</div>
                <button className="bb-icon-btn" onClick={() => setRemoveTarget(null)} aria-label="Close">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <div className="bb-modal-body">
                <p style={{ margin: 0 }}>
                  Stop pacing <strong>{removeTarget.name}</strong>?
                </p>
                <p className="bb-muted" style={{ fontSize: 13, marginTop: 8 }}>
                  This won't change anything in Meta — it just stops BudgetBuddy from including
                  the campaign in future pacing runs. You can re-add it via Import from Meta.
                </p>
              </div>
              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={() => setRemoveTarget(null)}>Cancel</button>
                <button className="bb-btn bb-btn-danger" onClick={handleRemoveCampaign}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Import-from-Meta modal */}
        {showImport && (
          <div className="bb-modal-backdrop" onClick={closeImport}>
            <div className="bb-modal" onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Import campaigns from Meta</div>
                <button className="bb-icon-btn" onClick={closeImport} aria-label="Close">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              <div className="bb-modal-body">
                {importLoading && (
                  <p className="bb-muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 size={14} className="bb-spin" /> Fetching campaigns from Meta…
                  </p>
                )}
                {importError && <div className="bb-alert bb-alert-error">{importError}</div>}

                {!importLoading && metaCampaigns.length > 0 && (
                  <>
                    <p className="bb-muted" style={{ marginBottom: 12 }}>
                      Pick the campaigns you want to track and set a monthly budget for each.
                      The default monthly budget is current daily × 30.
                    </p>
                    <table className="bb-table">
                      <thead>
                        <tr>
                          <th></th>
                          <th>Campaign</th>
                          <th>Status</th>
                          <th>Mode</th>
                          <th>Current Daily</th>
                          <th>Monthly Budget</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metaCampaigns.flatMap((c) => {
                          const sel = importSelections[c.meta_campaign_id] || {};
                          const mode = c.budget_mode || (c.is_cbo ? 'CBO' : 'ABO');
                          const liveAdsets = c.adsets || [];
                          const allocSum = allocationSumFor(c.meta_campaign_id);
                          const allocOk = Math.abs(allocSum - 100) <= 1.5;

                          const mainRow = (
                            <tr key={c.meta_campaign_id}>
                              <td>
                                <input type="checkbox"
                                  checked={!!sel.selected}
                                  onChange={() => toggleImportSelection(c.meta_campaign_id)}
                                />
                              </td>
                              <td>
                                <div>{c.name}</div>
                                {c.already_tracked && <div className="bb-muted" style={{ fontSize: 11 }}>tracked</div>}
                              </td>
                              <td>{c.effective_status || c.status}</td>
                              <td>
                                <span className={`bb-mode-badge ${mode === 'ABO' ? 'bb-mode-abo' : 'bb-mode-cbo'}`}>
                                  {mode}
                                </span>
                              </td>
                              <td className="num">{c.current_daily_budget ? `$${c.current_daily_budget.toFixed(2)}` : '—'}</td>
                              <td>
                                <input
                                  type="number"
                                  step="1" min="0"
                                  className="bb-input"
                                  placeholder="0"
                                  value={sel.monthly_budget ?? ''}
                                  onChange={(e) => updateImportBudget(c.meta_campaign_id, e.target.value)}
                                  disabled={!sel.selected}
                                  style={{ width: 110 }}
                                />
                              </td>
                            </tr>
                          );

                          if (mode !== 'ABO' || !sel.selected || liveAdsets.length === 0) {
                            return [mainRow];
                          }

                          const allocRow = (
                            <tr key={`${c.meta_campaign_id}-alloc`}>
                              <td colSpan={6} style={{ padding: 0, background: '#fafbfb' }}>
                                <div style={{ padding: '12px 16px 16px 48px' }}>
                                  <div className="bb-row-between" style={{ marginBottom: 8 }}>
                                    <div className="bb-section-meta">
                                      Set how much of <strong>${(parseFloat(sel.monthly_budget) || 0).toFixed(0)}</strong> /mo
                                      goes to each ad set. Total must equal 100%.
                                    </div>
                                    <button
                                      type="button"
                                      className="bb-btn bb-btn-ghost"
                                      onClick={() => evenSplitAllocations(c.meta_campaign_id)}
                                      style={{ fontSize: 12 }}
                                    >
                                      Split evenly
                                    </button>
                                  </div>
                                  <table className="bb-table" style={{ marginBottom: 4 }}>
                                    <thead>
                                      <tr>
                                        <th style={{ width: '60%' }}>Ad set</th>
                                        <th>Current Daily</th>
                                        <th>Allocation %</th>
                                        <th>Allocated /mo</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {liveAdsets.map((a) => {
                                        const pct = parseFloat(sel.adsets?.[a.meta_adset_id]?.allocation_pct);
                                        const monthly = parseFloat(sel.monthly_budget) || 0;
                                        const allocated = Number.isFinite(pct) ? (monthly * pct / 100) : 0;
                                        return (
                                          <tr key={a.meta_adset_id}>
                                            <td>{a.name} {a.status !== 'ACTIVE' && <span className="bb-muted">({a.status})</span>}</td>
                                            <td className="num">{a.current_daily_budget ? `$${a.current_daily_budget.toFixed(2)}` : '—'}</td>
                                            <td>
                                              <input
                                                type="number"
                                                step="0.5" min="0" max="100"
                                                className="bb-input"
                                                value={sel.adsets?.[a.meta_adset_id]?.allocation_pct ?? ''}
                                                onChange={(e) => updateAdsetAllocation(c.meta_campaign_id, a.meta_adset_id, e.target.value)}
                                                style={{ width: 90 }}
                                              />
                                            </td>
                                            <td className="num">${allocated.toFixed(0)}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                  <div style={{ textAlign: 'right', fontSize: 12, marginTop: 6 }}>
                                    Total:{' '}
                                    <span style={{
                                      fontWeight: 700,
                                      color: allocOk ? '#0f5132' : '#b45309',
                                    }}>
                                      {allocSum.toFixed(2)}%
                                    </span>
                                    {!allocOk && <span className="bb-muted"> — must be 100%</span>}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );

                          return [mainRow, allocRow];
                        })}
                      </tbody>
                    </table>
                  </>
                )}

                {!importLoading && !importError && metaCampaigns.length === 0 && (
                  <EmptyState
                    icon={Inbox}
                    title="No active campaigns found"
                    body="There are no active campaigns in this Meta ad account."
                  />
                )}
              </div>

              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={closeImport} disabled={importSaving}>Cancel</button>
                <button className="bb-btn bb-btn-primary" onClick={saveImport} disabled={importSaving || importLoading}>
                  {importSaving ? <Loader2 size={14} className="bb-spin" /> : <Plus size={14} aria-hidden="true" />}
                  {importSaving ? 'Saving…' : 'Save selections'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default AccountDashboard;
