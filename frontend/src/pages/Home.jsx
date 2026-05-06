import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { getCached, isStale, setCached, invalidateCache } from '../cache';
import {
  Search, X, Play, Check, LogOut, Inbox, Plus, Building2,
  TrendingUp, TrendingDown, Minus, ArrowRight, RotateCcw, Loader2,
  CheckCircle2, AlertCircle, DollarSign, BarChart3,
} from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { SkeletonStatTile, SkeletonAccountBlock } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

/**
 * Unified Home — every tracked campaign across every account.
 * CBO = one row. ABO = parent rollup + indented adset rows.
 * Apply/Skip actions work directly from this page.
 */
function Home({ user, onLogout }) {
  const toast = useToast();

  const [accountBlocks, setAccountBlocks] = useState([]);
  const [allAccounts,   setAllAccounts]   = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');

  const [applying, setApplying] = useState({});
  const [skipped,  setSkipped]  = useState({});
  const [results,  setResults]  = useState({});

  // Confirmation modal
  const [pendingConfirm, setPendingConfirm] = useState(null);

  // Search filter
  const [search, setSearch] = useState('');

  // Manual "Run Pacing for All" state
  const [runningAll, setRunningAll]   = useState(false);

  const navigate = useNavigate();

  const fetchAll = useCallback(async (force = false) => {
    const cached = getCached('home-data');

    if (cached && !force) {
      // Always paint cached data immediately — zero wait for the user
      setAllAccounts(cached.accounts);
      setAccountBlocks(cached.blocks);
      setLoading(false);

      // If data is still fresh, stop here — no background work needed
      if (!isStale('home-data')) return;

      // Data is stale: refresh silently in the background without showing a spinner
    }

    // Only show the loading spinner when there's nothing to display yet
    if (!cached) setLoading(true);

    try {
      // Single round-trip to the backend. Replaces the previous N+1 fan-out
      // (1 + 2*N requests) which was the main cause of the 1-2 minute load.
      const res = await axios.get('/api/campaigns/all');
      const blocks = res.data?.accounts || [];
      const accounts = blocks.map((b) => ({ id: b.id, account_name: b.account_name }));

      setAllAccounts(accounts);
      setAccountBlocks(blocks);
      setCached('home-data', { accounts, blocks });
    } catch (err) {
      // If we already showed cached data, swallow background-refresh errors silently
      if (!cached) setError('Failed to load campaigns: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Manually run pacing for every account in parallel.
  const handleRunAll = async () => {
    if (runningAll || allAccounts.length === 0) return;
    setRunningAll(true);
    try {
      const settled = await Promise.allSettled(
        allAccounts.map((a) =>
          axios.post(`/api/pacing/${a.id}/run`, { run_type: 'MANUAL' })
        )
      );
      let succeeded = 0;
      let totalCampaigns = 0;
      const failures = [];
      settled.forEach((res, i) => {
        const acct = allAccounts[i];
        if (res.status === 'fulfilled') {
          succeeded += 1;
          totalCampaigns += res.value?.data?.campaigns_processed || 0;
        } else {
          failures.push({
            account: acct.account_name,
            error: res.reason?.response?.data?.error || res.reason?.message || 'Unknown error',
          });
        }
      });
      const isFullSuccess = failures.length === 0;
      const isAllFail     = succeeded === 0;
      const summary = isFullSuccess
        ? `${succeeded} of ${allAccounts.length} accounts refreshed · ${totalCampaigns} campaigns processed.`
        : isAllFail
          ? `All ${allAccounts.length} accounts failed: ${failures[0].account} — ${failures[0].error}`
          : `${succeeded} of ${allAccounts.length} accounts refreshed · ${failures.length} failed (${failures[0].account}…)`;
      if (isFullSuccess)      toast.success(summary, { title: 'Pacing complete' });
      else if (!isAllFail)    toast.warn(summary, { title: 'Pacing finished with errors' });
      else                    toast.error(summary, { title: 'Pacing failed' });
      invalidateCache('home-data');
      fetchAll(true);
    } finally {
      setRunningAll(false);
    }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout();
    navigate('/login');
  };

  const applyAdjustment = async (accountId, adjustment, rowKey) => {
    setApplying((p) => ({ ...p, [rowKey]: true }));
    setResults((p) => ({ ...p, [rowKey]: null }));
    try {
      await axios.post(`/api/pacing/${accountId}/apply`, { adjustments: [adjustment] });
      setResults((p) => ({ ...p, [rowKey]: { ok: true } }));
      toast.success(
        `Pushed new daily of $${(adjustment.recommended_daily_budget || 0).toFixed(2)} to Meta.`,
        { title: 'Applied' }
      );
      fetchAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed';
      setResults((p) => ({ ...p, [rowKey]: { ok: false, msg } }));
      toast.error(msg, { title: 'Apply failed' });
    } finally {
      setApplying((p) => ({ ...p, [rowKey]: false }));
    }
  };

  const handleApplyCbo = (accountId, campaign) => {
    const lp = campaign.latest_pacing;
    if (!lp) return;
    setPendingConfirm({
      accountId,
      rowKey: `c-${campaign.id}`,
      adjustment: {
        level: 'campaign',
        campaign_id: campaign.id,
        campaign_name: campaign.campaign_name,
        current_daily_budget: lp.current_daily_budget,
        recommended_daily_budget: lp.recommended_daily_budget,
        change_percent: lp.change_percent,
        action: lp.status,
      },
    });
  };

  const handleApplyAdset = (accountId, campaign, adset) => {
    const alp = adset.latest_pacing;
    if (!alp) return;
    setPendingConfirm({
      accountId,
      rowKey: `a-${adset.id}`,
      adjustment: {
        level: 'adset',
        campaign_id: campaign.id,
        campaign_name: campaign.campaign_name,
        adset_id: adset.id,
        adset_name: adset.adset_name,
        current_daily_budget: alp.current_daily_budget,
        recommended_daily_budget: alp.recommended_daily_budget,
        change_percent: alp.change_percent,
        action: alp.action || alp.status,
      },
    });
  };

  const handleConfirmApply = () => {
    if (!pendingConfirm) return;
    const { accountId, adjustment, rowKey } = pendingConfirm;
    setPendingConfirm(null);
    applyAdjustment(accountId, adjustment, rowKey);
  };

  const fmt$ = (n, dec = 0) =>
    `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

  const pillForStatus = (s, paceRatio) => {
    const u = (s || '').toUpperCase();
    if (u === 'ON_PACE' || u === 'INCREASE' || u === 'DECREASE') {
      const ratio = paceRatio || 0;
      const pct   = Math.round(Math.abs((ratio - 1) * 100));
      const label = ratio >= 1 ? `${pct}% over` : `${pct}% under`;
      const cls   = u === 'ON_PACE' ? 'bb-pill bb-pill-on' : 'bb-pill bb-pill-off';
      const Icon  = u === 'ON_PACE' ? Check : ratio >= 1 ? TrendingUp : TrendingDown;
      return { cls, label, Icon };
    }
    return { cls: 'bb-pill bb-pill-muted', label: '—', Icon: Minus };
  };

  const timeAgo = (isoStr) => {
    if (!isoStr) return 'Never';
    const diff = Date.now() - new Date(isoStr + 'Z').getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2)  return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  // Totals across every account block
  const totals = useMemo(() => {
    let monthly = 0;
    let spent = 0;
    let campaignCount = 0;
    let adsetCount = 0;
    accountBlocks.forEach((acct) => {
      acct.campaigns.forEach((c) => {
        campaignCount += 1;
        monthly += Number(c.monthly_budget) || 0;
        const lp = c.latest_pacing;
        if (lp && Number.isFinite(Number(lp.actual_spend))) {
          spent += Number(lp.actual_spend);
        }
        if ((c.budget_mode || 'CBO') === 'ABO') {
          adsetCount += (c.adsets || []).length;
        }
      });
    });
    const pct = monthly > 0 ? Math.min(100, (spent / monthly) * 100) : 0;
    return { monthly, spent, pct, campaignCount, adsetCount };
  }, [accountBlocks]);

  // Filtered view
  const filteredBlocks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accountBlocks;
    const out = [];
    accountBlocks.forEach((acct) => {
      const acctMatches = acct.account_name.toLowerCase().includes(q);
      if (acctMatches) { out.push(acct); return; }
      const trimmedCampaigns = [];
      acct.campaigns.forEach((c) => {
        const cMatches = (c.campaign_name || '').toLowerCase().includes(q);
        if ((c.budget_mode || 'CBO') === 'ABO') {
          const adsetMatches = (c.adsets || []).filter(
            (a) => (a.adset_name || '').toLowerCase().includes(q),
          );
          if (cMatches) {
            trimmedCampaigns.push(c);
          } else if (adsetMatches.length > 0) {
            trimmedCampaigns.push({ ...c, adsets: adsetMatches });
          }
        } else if (cMatches) {
          trimmedCampaigns.push(c);
        }
      });
      if (trimmedCampaigns.length > 0) {
        out.push({ ...acct, campaigns: trimmedCampaigns });
      }
    });
    return out;
  }, [accountBlocks, search]);

  const actionCell = (rowKey, needsAction, onApply) => {
    const res = results[rowKey];
    const isApplying = !!applying[rowKey];
    const isSkipped  = !!skipped[rowKey];
    if (res?.ok) return (
      <span style={{ color: '#10b981', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <CheckCircle2 size={13} aria-hidden="true" /> Applied
      </span>
    );
    if (res?.msg) return (
      <span style={{ color: '#ef4444', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <AlertCircle size={12} aria-hidden="true" /> {res.msg}
      </span>
    );
    if (isSkipped) return (
      <span style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span className="bb-muted">Skipped</span>
        <button
          style={{ background: 'none', border: 'none', color: 'var(--bb-primary)', cursor: 'pointer', fontSize: 12, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}
          onClick={() => setSkipped((p) => ({ ...p, [rowKey]: false }))}
        >
          <RotateCcw size={11} aria-hidden="true" /> Undo
        </button>
      </span>
    );
    if (!needsAction) return <span className="bb-muted" style={{ fontSize: 12 }}>—</span>;
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="bb-btn bb-btn-apply" style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={onApply} disabled={isApplying}>
          {isApplying ? <Loader2 size={11} className="bb-spin" /> : <Check size={11} aria-hidden="true" />}
          {isApplying ? '…' : 'Apply'}
        </button>
        <button className="bb-btn" style={{ fontSize: 11, padding: '3px 8px' }}
          onClick={() => setSkipped((p) => ({ ...p, [rowKey]: true }))} disabled={isApplying}>
          Skip
        </button>
      </div>
    );
  };

  const ChangeBadge = ({ pct }) => {
    if (pct == null || Math.abs(pct) < 0.5) return <span className="bb-change bb-change-flat"><Minus size={10} aria-hidden="true" /> {(pct ?? 0).toFixed(1)}%</span>;
    if (pct > 0) return <span className="bb-change bb-change-up"><TrendingUp size={10} aria-hidden="true" /> +{pct.toFixed(1)}%</span>;
    return <span className="bb-change bb-change-down"><TrendingDown size={10} aria-hidden="true" /> {pct.toFixed(1)}%</span>;
  };

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={allAccounts} onAddAccount={() => navigate('/accounts')} />

      <main className="bb-main">
        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">All Campaigns</div>
            <div className="bb-page-subtitle">Every tracked campaign across all accounts. Apply recommendations here.</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="bb-btn bb-btn-primary"
              onClick={handleRunAll}
              disabled={runningAll || loading || allAccounts.length === 0}
              title="Pull fresh MTD spend (through yesterday) for every account"
            >
              {runningAll ? <Loader2 size={14} className="bb-spin" /> : <Play size={14} aria-hidden="true" />}
              {runningAll ? `Running ${allAccounts.length}…` : `Run Pacing (All ${allAccounts.length})`}
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>
              <LogOut size={14} aria-hidden="true" /> Log out
            </button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Top stat cards — skeleton or real */}
        {loading ? (
          <div className="bb-grid bb-grid-3" style={{ marginBottom: 12, gap: 10 }}>
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
        ) : accountBlocks.length > 0 && (
          <div className="bb-grid bb-grid-3" style={{ marginBottom: 12, gap: 10 }}>
            <div className="bb-stat bb-stat-compact">
              <span className="bb-stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <DollarSign size={11} aria-hidden="true" /> Monthly Budget
              </span>
              <span className="bb-stat-value">{fmt$(totals.monthly)}</span>
              <span className="bb-stat-sub">
                {totals.campaignCount} campaign{totals.campaignCount === 1 ? '' : 's'}
              </span>
            </div>

            <div className="bb-stat bb-stat-compact">
              <span className="bb-stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <BarChart3 size={11} aria-hidden="true" /> Spend (MTD)
              </span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span className="bb-stat-value">{fmt$(totals.spent, 2)}</span>
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: totals.pct > 100 ? '#ef4444' : '#10b981',
                }}>
                  {totals.pct.toFixed(1)}%
                </span>
              </div>
              <div
                aria-label="Percent of monthly budget spent so far"
                style={{
                  marginTop: 4, height: 4, width: '100%',
                  background: 'rgba(0,0,0,0.06)', borderRadius: 999, overflow: 'hidden',
                }}
              >
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, totals.pct)}%`,
                  background: totals.pct > 100 ? '#ef4444' : '#10b981',
                  transition: 'width 240ms ease',
                }} />
              </div>
            </div>

            <div className="bb-stat bb-stat-compact">
              <span className="bb-stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Building2 size={11} aria-hidden="true" /> Tracked Units
              </span>
              <span className="bb-stat-value">
                {totals.campaignCount}
                {totals.adsetCount > 0 && (
                  <span style={{ fontSize: 13, color: 'var(--bb-text-muted)', fontWeight: 600 }}>
                    {' '}/ {totals.adsetCount} ad sets
                  </span>
                )}
              </span>
              <span className="bb-stat-sub">
                {accountBlocks.length} account{accountBlocks.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        )}

        {/* Search bar */}
        {!loading && accountBlocks.length > 0 && (
          <div style={{ marginBottom: 18 }} className="bb-search-wrap">
            <Search size={14} className="bb-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="bb-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts, campaigns, or ad sets…"
              style={{ paddingLeft: 36 }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="bb-btn bb-btn-ghost bb-search-clear"
                style={{ fontSize: 12, padding: '4px 8px' }}
              >
                <X size={12} aria-hidden="true" /> Clear
              </button>
            )}
          </div>
        )}

        {loading ? (
          <>
            <SkeletonAccountBlock />
            <SkeletonAccountBlock />
          </>
        ) : accountBlocks.length === 0 ? (
          <div className="bb-card">
            <EmptyState
              icon={Inbox}
              title="No campaigns tracked yet"
              body="Connect a Meta ad account and import campaigns to start pacing recommendations."
              action={{
                label: 'Add Account',
                icon: Plus,
                onClick: () => navigate('/accounts'),
              }}
            />
          </div>
        ) : filteredBlocks.length === 0 ? (
          <div className="bb-card">
            <EmptyState
              icon={Search}
              title="Nothing matches your search"
              body={`No accounts, campaigns, or ad sets match "${search}".`}
              action={{ label: 'Clear search', icon: X, onClick: () => setSearch('') }}
            />
          </div>
        ) : filteredBlocks.map((acct) => (
          <div key={acct.id} className="bb-card" style={{ marginBottom: 20 }}>
            <div className="bb-row-between" style={{
              padding: '12px 20px',
              background: '#f0f2f4',
              borderRadius: '10px 10px 0 0',
              borderBottom: '1px solid #e2e5e8',
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#0d1f26', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Building2 size={15} aria-hidden="true" />
                  {acct.account_name}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  Last pacing run: <strong style={{ color: '#374151' }}>{timeAgo(acct.last_run)}</strong>
                </div>
              </div>
              <Link to={`/account/${acct.id}`} className="bb-btn bb-btn-secondary">
                Dashboard <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </div>

            {acct.campaigns.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No campaigns tracked"
                body="Open this account's dashboard and click Import from Meta to start tracking campaigns."
                action={{
                  label: 'Open dashboard',
                  icon: ArrowRight,
                  onClick: () => navigate(`/account/${acct.id}`),
                }}
              />
            ) : (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Campaign / Ad Set</th>
                    <th>Mode</th>
                    <th>Budget</th>
                    <th>MTD Spend</th>
                    <th>Pace</th>
                    <th>Current Daily</th>
                    <th>Rec. Daily</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {acct.campaigns.flatMap((campaign) => {
                    const lp   = campaign.latest_pacing;
                    const mode = campaign.budget_mode || 'CBO';

                    if (mode === 'ABO') {
                      const parentPill = lp ? pillForStatus(lp.status, lp.pace_ratio) : null;
                      const parentRow = (
                        <tr key={`c-${campaign.id}`} style={{ background: '#fafbfc' }}>
                          <td>
                            <Link to={`/account/${acct.id}/campaign/${campaign.id}`}
                              style={{ fontWeight: 700, textDecoration: 'none', color: 'var(--bb-text)' }}>
                              {campaign.campaign_name}
                            </Link>
                          </td>
                          <td><span className="bb-mode-badge bb-mode-abo">ABO</span></td>
                          <td className="num">{fmt$(campaign.monthly_budget)}/mo</td>
                          <td className="num">{lp ? fmt$(lp.actual_spend, 2) : '—'}</td>
                          <td className="num">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                          <td className="num bb-muted">—</td>
                          <td className="num bb-muted">—</td>
                          <td>
                            {parentPill ? (
                              <span className={parentPill.cls}>
                                <parentPill.Icon size={11} aria-hidden="true" /> {parentPill.label}
                              </span>
                            ) : <span className="bb-pill bb-pill-muted">rollup</span>}
                          </td>
                          <td><span className="bb-muted" style={{ fontSize: 12 }}>per ad set →</span></td>
                        </tr>
                      );

                      const adsetRows = (campaign.adsets || []).map((adset) => {
                        const alp        = adset.latest_pacing;
                        const aStatus    = alp?.action || alp?.status || '';
                        const aPill      = pillForStatus(aStatus, alp?.pace_ratio);
                        const needsAction = alp && aStatus.toUpperCase() !== 'ON_PACE';
                        const rowKey     = `a-${adset.id}`;
                        const adsetMo    = campaign.monthly_budget * (adset.allocation_pct / 100);

                        return (
                          <tr key={rowKey}>
                            <td style={{ paddingLeft: 32, color: 'var(--bb-text-muted)', fontSize: 13 }}>
                              ↳ {adset.adset_name}
                              <span className="bb-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                                {(adset.allocation_pct || 0).toFixed(0)}%
                              </span>
                            </td>
                            <td><span className="bb-mode-badge bb-mode-adset">ad set</span></td>
                            <td className="num">{fmt$(adsetMo)}/mo</td>
                            <td className="num">{alp ? fmt$(alp.actual_spend, 2) : '—'}</td>
                            <td className="num">{alp ? `${(alp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                            <td className="num">
                              {alp?.current_daily_budget != null ? fmt$(alp.current_daily_budget, 2) : '—'}
                            </td>
                            <td className="num">
                              {alp?.recommended_daily_budget != null ? (
                                <>
                                  {fmt$(alp.recommended_daily_budget, 2)}
                                  <div><ChangeBadge pct={alp.change_percent} /></div>
                                </>
                              ) : '—'}
                            </td>
                            <td>
                              {alp ? (
                                <span className={aPill.cls}>
                                  <aPill.Icon size={11} aria-hidden="true" /> {aPill.label}
                                </span>
                              ) : <span className="bb-muted">No data</span>}
                            </td>
                            <td>{actionCell(rowKey, needsAction && !skipped[rowKey], () => handleApplyAdset(acct.id, campaign, adset))}</td>
                          </tr>
                        );
                      });

                      return [parentRow, ...adsetRows];
                    }

                    // CBO
                    const status     = lp?.status || '';
                    const pill       = pillForStatus(status, lp?.pace_ratio);
                    const needsAction = lp && status.toUpperCase() !== 'ON_PACE';
                    const rowKey     = `c-${campaign.id}`;

                    return [(
                      <tr key={rowKey}>
                        <td>
                          <Link to={`/account/${acct.id}/campaign/${campaign.id}`}
                            style={{ fontWeight: 600, textDecoration: 'none', color: 'var(--bb-text)' }}>
                            {campaign.campaign_name}
                          </Link>
                        </td>
                        <td><span className="bb-mode-badge bb-mode-cbo">CBO</span></td>
                        <td className="num">{fmt$(campaign.monthly_budget)}/mo</td>
                        <td className="num">{lp ? fmt$(lp.actual_spend, 2) : '—'}</td>
                        <td className="num">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                        <td className="num">
                          {lp?.current_daily_budget != null ? fmt$(lp.current_daily_budget, 2) : '—'}
                        </td>
                        <td className="num">
                          {lp?.recommended_daily_budget != null ? (
                            <>
                              {fmt$(lp.recommended_daily_budget, 2)}
                              <div><ChangeBadge pct={lp.change_percent} /></div>
                            </>
                          ) : '—'}
                        </td>
                        <td>
                          {lp ? (
                            <span className={pill.cls}>
                              <pill.Icon size={11} aria-hidden="true" /> {pill.label}
                            </span>
                          ) : <span className="bb-muted">No data</span>}
                        </td>
                        <td>{actionCell(rowKey, needsAction && !skipped[rowKey], () => handleApplyCbo(acct.id, campaign))}</td>
                      </tr>
                    )];
                  })}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </main>

      {/* Apply confirmation modal */}
      {pendingConfirm && (() => {
        const adj = pendingConfirm.adjustment;
        const isAdset = adj.level === 'adset' || !!adj.adset_id;
        const up = (adj.change_percent || 0) > 0;
        return (
          <div className="bb-modal-backdrop" onClick={() => setPendingConfirm(null)}>
            <div className="bb-modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Confirm budget change in Meta</div>
                <button className="bb-icon-btn" onClick={() => setPendingConfirm(null)} aria-label="Close">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              <div className="bb-modal-body">
                <div className="bb-alert bb-alert-warn" style={{ marginBottom: 16 }}>
                  This will push <strong>1 budget change</strong> directly to Meta via the API.
                  This cannot be undone automatically — you'd need to revert manually in Ads Manager.
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
                    <tr>
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
                  </tbody>
                </table>
              </div>

              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={() => setPendingConfirm(null)}>Cancel</button>
                <button className="bb-btn bb-btn-apply" onClick={handleConfirmApply}>
                  <Check size={14} aria-hidden="true" /> Yes, push to Meta
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default Home;
