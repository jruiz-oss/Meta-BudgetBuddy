import React, { useState, useEffect, useCallback } from 'react';
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

  const navigate = useNavigate();

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      const [allRes, acctRes] = await Promise.all([
        axios.get('/api/campaigns/all'),
        axios.get('/api/accounts'),
      ]);
      setAccountBlocks(allRes.data.accounts || []);
      setAllAccounts(acctRes.data.accounts || acctRes.data || []);
    } catch {
      setError('Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

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
          <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {loading ? (
          <div className="bb-card bb-section bb-muted">Loading campaigns…</div>
        ) : accountBlocks.length === 0 ? (
          <div className="bb-card bb-section bb-muted">
            No campaigns tracked yet. Go to <Link to="/accounts">Accounts</Link> to add one.
          </div>
        ) : accountBlocks.map((acct) => (
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
