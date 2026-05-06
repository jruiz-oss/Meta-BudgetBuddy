import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';

/**
 * Unified Home — every tracked campaign across every account.
 * CBO = one row. ABO = parent rollup + indented adset rows.
 * Apply/Skip actions work directly from this page.
 */
function Home({ user, onLogout }) {
  const [accountBlocks, setAccountBlocks] = useState([]);
  const [allAccounts,   setAllAccounts]   = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');

  const [applying, setApplying] = useState({});
  const [skipped,  setSkipped]  = useState({});
  const [results,  setResults]  = useState({});

  // Search filter — case-insensitive substring match against account / campaign / ad set name.
  const [search, setSearch] = useState('');

  // Manual "Run Pacing for All" state — fires /api/pacing/:id/run for every account.
  // Pacing pulls MTD spend through yesterday only, so this gives a clean as-of-prior-day view.
  const [runningAll, setRunningAll]   = useState(false);
  const [runAllResult, setRunAllResult] = useState(null);

  const navigate = useNavigate();

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      // Fetch accounts first, then campaigns + pacing summary for each in parallel.
      const acctRes = await axios.get('/api/accounts');
      const accounts = acctRes.data.accounts || acctRes.data || [];
      setAllAccounts(accounts);

      if (accounts.length === 0) {
        setAccountBlocks([]);
        return;
      }

      // For each account, fetch its campaigns and pacing summary.
      const blocks = await Promise.all(
        accounts.map(async (acct) => {
          const [campRes, summaryRes] = await Promise.all([
            axios.get(`/api/campaigns/${acct.id}`),
            axios.get(`/api/pacing/${acct.id}/summary`).catch(() => ({ data: {} })),
          ]);
          const campaigns = campRes.data.campaigns || [];
          const lastRun   = summaryRes.data?.last_run || null;

          // For ABO campaigns, fetch adsets (they're already in to_dict via the campaign endpoint)
          return {
            id: acct.id,
            account_name: acct.account_name,
            last_run: lastRun,
            campaigns,
          };
        })
      );
      setAccountBlocks(blocks);
    } catch (err) {
      setError('Failed to load campaigns: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Manually run pacing for every account in parallel. Each /run call also triggers the
  // Google Sheet write-back (handled server-side), so a single click refreshes both
  // recommendations and the sheet's MTD column.
  const handleRunAll = async () => {
    if (runningAll || allAccounts.length === 0) return;
    setRunningAll(true);
    setRunAllResult(null);
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
      setRunAllResult({ succeeded, total: allAccounts.length, totalCampaigns, failures });
      // Refresh the displayed data so cards + tables reflect the new pacing rows.
      fetchAll();
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
      fetchAll();
    } catch (err) {
      setResults((p) => ({ ...p, [rowKey]: { ok: false, msg: err.response?.data?.error || 'Failed' } }));
    } finally {
      setApplying((p) => ({ ...p, [rowKey]: false }));
    }
  };

  const handleApplyCbo = (accountId, campaign) => {
    const lp = campaign.latest_pacing;
    if (!lp) return;
    applyAdjustment(accountId, {
      level: 'campaign',
      campaign_id: campaign.id,
      campaign_name: campaign.campaign_name,
      current_daily_budget: lp.current_daily_budget,
      recommended_daily_budget: lp.recommended_daily_budget,
      change_percent: lp.change_percent,
      action: lp.status,
    }, `c-${campaign.id}`);
  };

  const handleApplyAdset = (accountId, campaign, adset) => {
    const alp = adset.latest_pacing;
    if (!alp) return;
    applyAdjustment(accountId, {
      level: 'adset',
      campaign_id: campaign.id,
      campaign_name: campaign.campaign_name,
      adset_id: adset.id,
      adset_name: adset.adset_name,
      current_daily_budget: alp.current_daily_budget,
      recommended_daily_budget: alp.recommended_daily_budget,
      change_percent: alp.change_percent,
      action: alp.action || alp.status,
    }, `a-${adset.id}`);
  };

  const fmt$ = (n, dec = 0) =>
    `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

  const pillForStatus = (s) => {
    const u = (s || '').toUpperCase();
    if (u === 'ON_PACE')  return { cls: 'bb-pill bb-pill-on',   label: 'On Pace' };
    if (u === 'INCREASE') return { cls: 'bb-pill bb-pill-up',   label: 'Increase' };
    if (u === 'DECREASE') return { cls: 'bb-pill bb-pill-down', label: 'Decrease' };
    return { cls: 'bb-pill bb-pill-muted', label: '—' };
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

  // ── Totals across every account block ──────────────────────────────────────
  // Sums the *campaign* monthly budget once (not the ad sets — those are slices of it).
  // For MTD spend we use latest_pacing.actual_spend on each campaign, which is already a
  // rollup from Campaign.to_dict() (sums latest-date adset rows for ABO).
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

  // ── Search-filtered view of the account blocks ──────────────────────────────
  // Three rules:
  //  1. Empty query → show everything.
  //  2. If the query matches an account name, that whole account stays unchanged.
  //  3. Otherwise, keep accounts that have at least one matching campaign or ad set,
  //     and trim each account's campaigns/ad sets to only the matching ones.
  const filteredBlocks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accountBlocks;

    const out = [];
    accountBlocks.forEach((acct) => {
      const acctMatches = acct.account_name.toLowerCase().includes(q);
      if (acctMatches) {
        out.push(acct);
        return;
      }
      const trimmedCampaigns = [];
      acct.campaigns.forEach((c) => {
        const cMatches = (c.campaign_name || '').toLowerCase().includes(q);
        if ((c.budget_mode || 'CBO') === 'ABO') {
          const adsetMatches = (c.adsets || []).filter(
            (a) => (a.adset_name || '').toLowerCase().includes(q),
          );
          if (cMatches) {
            // Whole campaign matches → keep all its ad sets.
            trimmedCampaigns.push(c);
          } else if (adsetMatches.length > 0) {
            // Only some ad sets match → keep the campaign as a parent rollup but
            // drop the ad sets that don't match.
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
    if (res?.ok) return <span style={{ color: '#10b981', fontSize: 12, fontWeight: 600 }}>✓ Applied</span>;
    if (res?.msg) return <span style={{ color: '#ef4444', fontSize: 11 }}>{res.msg}</span>;
    if (isSkipped) return (
      <span style={{ fontSize: 12 }}>
        <span className="bb-muted">Skipped</span>
        {' · '}
        <button style={{ background: 'none', border: 'none', color: 'var(--bb-primary)', cursor: 'pointer', fontSize: 12, padding: 0 }}
          onClick={() => setSkipped((p) => ({ ...p, [rowKey]: false }))}>Undo</button>
      </span>
    );
    if (!needsAction) return <span className="bb-muted" style={{ fontSize: 12 }}>—</span>;
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="bb-btn bb-btn-primary" style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={onApply} disabled={isApplying}>{isApplying ? '…' : 'Apply'}</button>
        <button className="bb-btn" style={{ fontSize: 11, padding: '3px 8px' }}
          onClick={() => setSkipped((p) => ({ ...p, [rowKey]: true }))} disabled={isApplying}>Skip</button>
      </div>
    );
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
              {runningAll
                ? `Running ${allAccounts.length} accounts…`
                : `Run Pacing (All ${allAccounts.length})`}
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Run-all result banner — auto-clears whenever the user runs again. */}
        {runAllResult && (
          <div
            className={
              runAllResult.failures.length === 0
                ? 'bb-alert bb-alert-success'
                : runAllResult.succeeded > 0
                  ? 'bb-alert bb-alert-warn'
                  : 'bb-alert bb-alert-error'
            }
            style={{ marginBottom: 12 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <strong>
                  {runAllResult.succeeded === runAllResult.total
                    ? 'All accounts refreshed.'
                    : `${runAllResult.succeeded} of ${runAllResult.total} accounts refreshed.`}
                </strong>{' '}
                <span style={{ fontSize: 13 }}>
                  {runAllResult.totalCampaigns} campaign{runAllResult.totalCampaigns === 1 ? '' : 's'} processed.
                  Spend reflects activity through yesterday.
                </span>
                {runAllResult.failures.length > 0 && (
                  <ul style={{ margin: '6px 0 0 18px', fontSize: 12 }}>
                    {runAllResult.failures.map((f, i) => (
                      <li key={i}><strong>{f.account}:</strong> {f.error}</li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                className="bb-btn bb-btn-ghost"
                style={{ fontSize: 11, padding: '4px 8px' }}
                onClick={() => setRunAllResult(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Top stat cards — compact totals across every account / campaign on this Home view */}
        {!loading && accountBlocks.length > 0 && (
          <div
            className="bb-grid bb-grid-3"
            style={{ marginBottom: 12, gap: 10 }}
          >
            {/* Compact override: smaller padding + smaller value font than the default bb-stat */}
            <div className="bb-stat" style={{ padding: '10px 14px', gap: 2 }}>
              <span className="bb-stat-label" style={{ fontSize: 10 }}>Monthly Budget</span>
              <span className="bb-stat-value" style={{ fontSize: 20 }}>{fmt$(totals.monthly)}</span>
              <span className="bb-stat-sub" style={{ fontSize: 11 }}>
                {totals.campaignCount} campaign{totals.campaignCount === 1 ? '' : 's'}
              </span>
            </div>

            <div className="bb-stat" style={{ padding: '10px 14px', gap: 2 }}>
              <span className="bb-stat-label" style={{ fontSize: 10 }}>Spend (MTD)</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span className="bb-stat-value" style={{ fontSize: 20 }}>{fmt$(totals.spent)}</span>
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
                  marginTop: 4,
                  height: 4, width: '100%',
                  background: 'rgba(0,0,0,0.06)', borderRadius: 999,
                  overflow: 'hidden',
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

            <div className="bb-stat" style={{ padding: '10px 14px', gap: 2 }}>
              <span className="bb-stat-label" style={{ fontSize: 10 }}>Tracked Units</span>
              <span className="bb-stat-value" style={{ fontSize: 20 }}>
                {totals.campaignCount}
                {totals.adsetCount > 0 && (
                  <span style={{ fontSize: 13, color: 'var(--bb-text-muted)', fontWeight: 600 }}>
                    {' '}/ {totals.adsetCount} ad sets
                  </span>
                )}
              </span>
              <span className="bb-stat-sub" style={{ fontSize: 11 }}>
                {accountBlocks.length} account{accountBlocks.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        )}

        {/* Search bar — filters the account blocks below by account / campaign / ad set name */}
        {!loading && accountBlocks.length > 0 && (
          <div style={{ marginBottom: 18, position: 'relative' }}>
            <input
              type="search"
              className="bb-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts, campaigns, or ad sets…"
              style={{ paddingLeft: 36 }}
            />
            <span
              aria-hidden="true"
              style={{
                position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--bb-text-muted)', fontSize: 14, pointerEvents: 'none',
              }}
            >
              ⌕
            </span>
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="bb-btn bb-btn-ghost"
                style={{
                  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                  fontSize: 12, padding: '4px 8px',
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {loading ? (
          <div className="bb-card bb-section bb-muted">Loading campaigns…</div>
        ) : accountBlocks.length === 0 ? (
          <div className="bb-card bb-section bb-muted">
            No campaigns tracked yet. Go to <Link to="/accounts">Accounts</Link> to add one.
          </div>
        ) : filteredBlocks.length === 0 ? (
          <div className="bb-card bb-section bb-muted">
            No accounts, campaigns, or ad sets match "{search}".
          </div>
        ) : filteredBlocks.map((acct) => (
          <div key={acct.id} className="bb-card" style={{ marginBottom: 20 }}>
            <div className="bb-section bb-row-between" style={{ paddingBottom: 12 }}>
              <div>
                <div className="bb-section-title">{acct.account_name}</div>
                <div className="bb-section-meta">
                  Last pacing run: <strong>{timeAgo(acct.last_run)}</strong>
                </div>
              </div>
              <Link to={`/account/${acct.id}`} className="bb-btn bb-btn-secondary">Dashboard →</Link>
            </div>

            {acct.campaigns.length === 0 ? (
              <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>No tracked campaigns.</div>
            ) : (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Campaign / Ad Set</th>
                    <th>Mode</th>
                    <th>Budget</th>
                    <th>MTD Spend</th>
                    <th>Pace</th>
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
                          <td className="num">{lp ? fmt$(lp.actual_spend) : '—'}</td>
                          <td className="num">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                          <td className="num bb-muted">—</td>
                          <td><span className="bb-pill bb-pill-muted">rollup</span></td>
                          <td><span className="bb-muted" style={{ fontSize: 12 }}>per ad set →</span></td>
                        </tr>
                      );

                      const adsetRows = (campaign.adsets || []).map((adset) => {
                        const alp        = adset.latest_pacing;
                        const aStatus    = alp?.action || alp?.status || '';
                        const aPill      = pillForStatus(aStatus);
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
                              {alp?.recommended_daily_budget != null ? fmt$(alp.recommended_daily_budget, 2) : '—'}
                            </td>
                            <td>{alp ? <span className={aPill.cls}>{aPill.label}</span> : <span className="bb-muted">No data</span>}</td>
                            <td>{actionCell(rowKey, needsAction && !skipped[rowKey], () => handleApplyAdset(acct.id, campaign, adset))}</td>
                          </tr>
                        );
                      });

                      return [parentRow, ...adsetRows];
                    }

                    // CBO
                    const status     = lp?.status || '';
                    const pill       = pillForStatus(status);
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
                        <td className="num">{lp ? fmt$(lp.actual_spend) : '—'}</td>
                        <td className="num">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                        <td className="num">
                          {lp?.recommended_daily_budget != null ? fmt$(lp.recommended_daily_budget, 2) : '—'}
                        </td>
                        <td>{lp ? <span className={pill.cls}>{pill.label}</span> : <span className="bb-muted">No data</span>}</td>
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
    </div>
  );
}

export default Home;
