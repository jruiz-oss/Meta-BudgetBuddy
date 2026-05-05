/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';

/**
 * Single-account dashboard.
 *
 * Top: 4 stat tiles (On Pace / Need Increase / Need Decrease / Total Spend)
 * Middle: latest pacing run summary (when present) with Apply All button
 * Bottom: tracked campaigns table with current daily, recommended daily, and change indicator
 * Modal: Import campaigns from Meta
 */
function AccountDashboard({ user, onLogout }) {
  const { accountId } = useParams();
  const navigate = useNavigate();

  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [pacingRunning, setPacingRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);

  // Import-from-Meta modal state
  const [showImport, setShowImport] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSaving, setImportSaving] = useState(false);
  const [metaCampaigns, setMetaCampaigns] = useState([]);
  const [importSelections, setImportSelections] = useState({});

  useEffect(() => {
    fetchAll();
  }, [accountId]);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [accountsRes, accountRes, campaignsRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/accounts/${accountId}`),
        axios.get(`/api/campaigns/${accountId}`),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setAccount(accountRes.data.account || accountRes.data);
      setCampaigns(campaignsRes.data.campaigns || []);
    } catch (err) {
      setError('Failed to load account data');
    } finally {
      setLoading(false);
    }
  };

  const handleRunPacing = async () => {
    setPacingRunning(true);
    setError('');
    setApplyResult(null);
    try {
      const response = await axios.post(`/api/pacing/${accountId}/run`, { run_type: 'MANUAL' });
      setLastRun(response.data);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to run pacing calculations');
    } finally {
      setPacingRunning(false);
    }
  };

  const handleApplyAll = async () => {
    if (!lastRun || !lastRun.recommendations) return;
    const adjustments = lastRun.recommendations
      .filter((r) => r.action !== 'ON_PACE')
      .map((r) => ({
        campaign_id: r.campaign_id,
        current_daily_budget: r.current_daily_budget,
        recommended_daily_budget: r.recommended_daily_budget,
        change_percent: r.change_percent,
        action: r.action,
      }));

    if (adjustments.length === 0) {
      setApplyResult({ message: 'Nothing to apply — everything is on pace.' });
      return;
    }

    setApplying(true);
    setError('');
    try {
      const response = await axios.post(`/api/pacing/${accountId}/apply`, { adjustments });
      setApplyResult(response.data);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to apply recommendations');
    } finally {
      setApplying(false);
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
        seed[c.meta_campaign_id] = {
          selected: !!c.already_tracked,
          monthly_budget: c.current_daily_budget ? Math.round(c.current_daily_budget * 30) : '',
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

  const closeImport = () => {
    setShowImport(false);
    setImportError('');
  };

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

  const saveImport = async () => {
    const chosen = metaCampaigns
      .filter((c) => importSelections[c.meta_campaign_id]?.selected)
      .map((c) => {
        const sel = importSelections[c.meta_campaign_id];
        return {
          meta_campaign_id: c.meta_campaign_id,
          campaign_name: c.name,
          monthly_budget: parseFloat(sel.monthly_budget) || 0,
          flight_type: 'ALWAYS_ON',
        };
      })
      .filter((c) => c.monthly_budget > 0);

    if (chosen.length === 0) {
      setImportError('Pick at least one campaign and give it a monthly budget.');
      return;
    }

    setImportSaving(true);
    setImportError('');
    try {
      await axios.post(`/api/campaigns/${accountId}/sync`, { campaigns: chosen });
      closeImport();
      fetchAll();
    } catch (err) {
      setImportError(err.response?.data?.error || 'Failed to save campaigns');
    } finally {
      setImportSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch { /* ignore */ }
    onLogout();
    navigate('/login');
  };

  // ---- Derived stats ----
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

  const pillForStatus = (status) => {
    const s = (status || '').toUpperCase();
    if (s === 'ON_PACE')  return { cls: 'bb-pill bb-pill-on',   text: 'ON_PACE' };
    if (s === 'INCREASE') return { cls: 'bb-pill bb-pill-up',   text: 'INCREASE' };
    if (s === 'DECREASE') return { cls: 'bb-pill bb-pill-down', text: 'DECREASE' };
    return { cls: 'bb-pill bb-pill-muted', text: '—' };
  };

  const changeIndicator = (changePct) => {
    if (changePct === undefined || changePct === null) {
      return <span className="bb-change bb-change-flat">No change</span>;
    }
    if (Math.abs(changePct) < 0.5) {
      return <span className="bb-change bb-change-flat">No change</span>;
    }
    if (changePct > 0) {
      return <span className="bb-change bb-change-up">↗ +{changePct.toFixed(1)}%</span>;
    }
    return <span className="bb-change bb-change-down">↘ {changePct.toFixed(1)}%</span>;
  };

  if (loading) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} variant="account" />
        <main className="bb-main">
          <div className="bb-card bb-section bb-muted">Loading account...</div>
        </main>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} variant="account" />
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
      <Sidebar user={user} accounts={accounts} variant="account" />

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
            <button className="bb-btn" onClick={openImport}>Import from Meta</button>
            <Link to={`/account/${accountId}/history`} className="bb-btn">History</Link>
            <Link to={`/account/${accountId}/settings`} className="bb-btn">Settings</Link>
            <button
              className="bb-btn bb-btn-primary"
              onClick={handleRunPacing}
              disabled={pacingRunning}
            >
              {pacingRunning ? 'Running...' : 'Run Pacing'}
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* 4 stat tiles */}
        <div className="bb-grid bb-grid-4" style={{ marginBottom: 20 }}>
          <div className="bb-stat">
            <span className="bb-stat-label">On Pace</span>
            <span className="bb-stat-value">{stats.onPace}</span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Need Increase</span>
            <span className="bb-stat-value">{stats.needIncrease}</span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Need Decrease</span>
            <span className="bb-stat-value">{stats.needDecrease}</span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Total Spend (MTD)</span>
            <span className="bb-stat-value">${stats.totalSpend.toFixed(0)}</span>
            <span className="bb-stat-sub">of ${stats.monthlyBudget.toFixed(0)} monthly</span>
          </div>
        </div>

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
                <button
                  className="bb-btn bb-btn-primary"
                  onClick={handleApplyAll}
                  disabled={applying || lastRun.adjustments_needed === 0}
                >
                  {applying ? 'Applying...' : 'Apply all to Meta'}
                </button>
              </div>

              {lastRun.failures && lastRun.failures.length > 0 && (
                <div className="bb-alert bb-alert-error">
                  {lastRun.failures.length} campaign(s) failed:&nbsp;
                  {lastRun.failures.map((f) => `${f.campaign_name}: ${f.error}`).join(' — ')}
                </div>
              )}
              {applyResult && (
                <div className="bb-alert bb-alert-success">{applyResult.message || 'Applied to Meta.'}</div>
              )}
            </div>

            {lastRun.recommendations && lastRun.recommendations.length > 0 && (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>MTD Spend</th>
                    <th>Expected</th>
                    <th>Pace</th>
                    <th>Current Daily</th>
                    <th>Recommended</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRun.recommendations.map((r) => {
                    const action = (r.action || '').toUpperCase();
                    const rowTint =
                      action === 'INCREASE' ? 'bb-table-row-tint-up' :
                      action === 'DECREASE' ? 'bb-table-row-tint-down' : '';
                    return (
                      <tr key={r.campaign_id} className={rowTint}>
                        <td>{r.campaign_name}</td>
                        <td className="num">${(r.actual_spend || 0).toFixed(2)}</td>
                        <td className="num">${(r.expected_spend || 0).toFixed(2)}</td>
                        <td className="num">{(r.pace_ratio || 0).toFixed(2)}x</td>
                        <td className="num">${(r.current_daily_budget || 0).toFixed(2)}</td>
                        <td className="num">
                          ${(r.recommended_daily_budget || 0).toFixed(2)}
                          <div>{changeIndicator(r.change_percent)}</div>
                        </td>
                        <td><span className={pillForStatus(action).cls}>{pillForStatus(action).text}</span></td>
                      </tr>
                    );
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
          </div>

          {campaigns.length === 0 ? (
            <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>
              No campaigns tracked yet. Click <strong>Import from Meta</strong> above to pull them in.
            </div>
          ) : (
            <table className="bb-table">
              <thead>
                <tr>
                  <th>Campaign</th>
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
                  const pill = pillForStatus(status);
                  const flightStatus = (c.flight_status || '').toUpperCase();
                  const isLive = flightStatus === 'ACTIVE' || flightStatus === 'LIVE';

                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {c.campaign_name}
                          {isLive && c.flight_type === 'LIMITED' && <span className="bb-flight-live">LIVE</span>}
                        </div>
                      </td>
                      <td>
                        <span className="bb-pill bb-pill-muted">{c.flight_status || c.flight_type || '—'}</span>
                      </td>
                      <td className="num">${(c.monthly_budget || 0).toFixed(0)}</td>
                      <td className="num">
                        {lp?.current_daily_budget !== undefined
                          ? `$${(lp.current_daily_budget || 0).toFixed(2)}`
                          : (c.current_daily_budget !== undefined ? `$${c.current_daily_budget.toFixed(2)}` : '—')}
                      </td>
                      <td className="num">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                      <td className="num">
                        {lp?.recommended_daily_budget !== undefined
                          ? <>${(lp.recommended_daily_budget).toFixed(2)}<div>{changeIndicator(lp.change_percent)}</div></>
                          : '—'}
                      </td>
                      <td>{lp ? <span className={pill.cls}>{pill.text}</span> : <span className="bb-muted">No data</span>}</td>
                      <td>
                        <Link to={`/account/${accountId}/campaign/${c.id}`} className="bb-link">View →</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Import-from-Meta modal */}
        {showImport && (
          <div className="bb-modal-backdrop" onClick={closeImport}>
            <div className="bb-modal" onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Import campaigns from Meta</div>
                <button className="bb-icon-btn" onClick={closeImport}>×</button>
              </div>

              <div className="bb-modal-body">
                {importLoading && <p className="bb-muted">Fetching campaigns from Meta...</p>}
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
                          <th>CBO?</th>
                          <th>Current Daily</th>
                          <th>Monthly Budget</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metaCampaigns.map((c) => {
                          const sel = importSelections[c.meta_campaign_id] || {};
                          return (
                            <tr key={c.meta_campaign_id}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={!!sel.selected}
                                  onChange={() => toggleImportSelection(c.meta_campaign_id)}
                                />
                              </td>
                              <td>
                                {c.name}
                                {c.already_tracked && <span className="bb-muted"> (tracked)</span>}
                              </td>
                              <td>{c.effective_status || c.status}</td>
                              <td>{c.is_cbo ? 'Yes' : 'No'}</td>
                              <td className="num">{c.current_daily_budget ? `$${c.current_daily_budget.toFixed(2)}` : '—'}</td>
                              <td>
                                <input
                                  type="number"
                                  step="1"
                                  min="0"
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
                        })}
                      </tbody>
                    </table>
                  </>
                )}

                {!importLoading && !importError && metaCampaigns.length === 0 && (
                  <p className="bb-muted">No active campaigns found in this Meta ad account.</p>
                )}
              </div>

              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={closeImport} disabled={importSaving}>Cancel</button>
                <button className="bb-btn bb-btn-primary" onClick={saveImport} disabled={importSaving || importLoading}>
                  {importSaving ? 'Saving...' : 'Save selections'}
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
