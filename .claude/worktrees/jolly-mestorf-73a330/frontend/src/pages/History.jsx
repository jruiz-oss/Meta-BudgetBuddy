import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';

function History({ user, onLogout }) {
  const { accountId } = useParams();
  const navigate = useNavigate();

  const [accounts, setAccounts]       = useState([]);
  const [summary, setSummary]         = useState(null);
  const [runs, setRuns]               = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [activeTab, setActiveTab]     = useState('runs');
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');

  // Filters
  const [runTypeFilter, setRunTypeFilter] = useState('all');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [accountsRes, summaryRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/history/${accountId}/summary`),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setSummary(summaryRes.data);

      if (activeTab === 'runs') {
        const runsRes = await axios.get(`/api/history/${accountId}/pacing-runs`);
        setRuns(runsRes.data.runs || []);
      } else {
        const adjRes = await axios.get(`/api/history/${accountId}/adjustments`);
        setAdjustments(adjRes.data.adjustments || []);
      }
    } catch (err) {
      setError('Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [accountId, activeTab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch { /* ignore */ }
    onLogout();
    navigate('/login');
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  const formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  };

  const runTypePill = (type) => {
    const t = (type || '').toUpperCase();
    if (t === 'MANUAL') return <span className="bb-pill bb-pill-up">Manual</span>;
    if (t === 'AUTO')   return <span className="bb-pill bb-pill-on">Auto</span>;
    return <span className="bb-pill bb-pill-muted">{type || '—'}</span>;
  };

  const runStatusPill = (status, errorMsg) => {
    if (status === 'COMPLETED') return <span className="bb-pill bb-pill-on">Completed</span>;
    if (status === 'PARTIAL')   return <span className="bb-pill bb-pill-up" title={errorMsg}>Partial</span>;
    if (status === 'FAILED')    return <span className="bb-pill bb-pill-down" title={errorMsg}>Failed</span>;
    return <span className="bb-pill bb-pill-muted">{status || '—'}</span>;
  };

  // ── Derived data ──────────────────────────────────────────────────────────

  const filteredRuns = runs.filter((r) => {
    if (runTypeFilter === 'all') return true;
    return (r.run_type || '').toUpperCase() === runTypeFilter;
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} variant="account" />

      <main className="bb-main">
        {/* Breadcrumb */}
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link>{' / '}
          <Link to={`/account/${accountId}`}>Dashboard</Link>{' / History'}
        </div>

        {/* Page header */}
        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Activity History</div>
            <div className="bb-page-subtitle">Pacing runs and budget adjustments for this account.</div>
          </div>
          <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Summary stat tiles */}
        {summary && (
          <div className="bb-grid bb-grid-4" style={{ marginBottom: 20 }}>
            <div className="bb-stat">
              <span className="bb-stat-label">Total Runs</span>
              <span className="bb-stat-value">{summary.total_runs ?? 0}</span>
            </div>
            <div className="bb-stat">
              <span className="bb-stat-label">Manual Runs</span>
              <span className="bb-stat-value">{summary.manual_runs ?? 0}</span>
            </div>
            <div className="bb-stat">
              <span className="bb-stat-label">Auto Runs</span>
              <span className="bb-stat-value">{summary.auto_runs ?? 0}</span>
            </div>
            <div className="bb-stat">
              <span className="bb-stat-label">Total Adjustments</span>
              <span className="bb-stat-value">{summary.total_adjustments ?? 0}</span>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="bb-tabs">
          <button
            className={`bb-tab-btn ${activeTab === 'runs' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('runs')}
          >
            Pacing Runs
          </button>
          <button
            className={`bb-tab-btn ${activeTab === 'adjustments' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('adjustments')}
          >
            Budget Adjustments
          </button>
        </div>

        {loading ? (
          <div className="bb-card bb-section bb-muted">Loading…</div>

        /* ── Pacing Runs tab ── */
        ) : activeTab === 'runs' ? (
          <div className="bb-card">
            <div className="bb-section" style={{ paddingBottom: 0 }}>
              <div className="bb-row-between" style={{ marginBottom: 12 }}>
                <div className="bb-section-title">Pacing Run History</div>
                {/* Filter pills */}
                <div className="bb-row" style={{ gap: 6 }}>
                  {[['all', 'All'], ['MANUAL', 'Manual'], ['AUTO', 'Auto']].map(([val, label]) => (
                    <button
                      key={val}
                      className={`bb-filter-btn ${runTypeFilter === val ? 'is-active' : ''}`}
                      onClick={() => setRunTypeFilter(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredRuns.length === 0 ? (
              <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>No pacing runs yet.</div>
            ) : (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Date &amp; Time</th>
                    <th>Type</th>
                    <th>Triggered By</th>
                    <th>Campaigns</th>
                    <th>Adjustments</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRuns.map((run) => (
                    <tr key={run.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(run.run_at)}</td>
                      <td>{runTypePill(run.run_type)}</td>
                      <td className="bb-muted" style={{ fontSize: 12 }}>{run.triggered_by || '—'}</td>
                      <td className="num">{run.campaigns_processed ?? '—'}</td>
                      <td className="num">{run.adjustments_made ?? '—'}</td>
                      <td>{runStatusPill(run.status, run.error_message)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

        /* ── Budget Adjustments tab ── */
        ) : (
          <div className="bb-card">
            <div className="bb-section" style={{ paddingBottom: 0 }}>
              <div className="bb-section-title" style={{ marginBottom: 12 }}>Budget Adjustment Log</div>
            </div>

            {adjustments.length === 0 ? (
              <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>No adjustments yet.</div>
            ) : (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Date &amp; Time</th>
                    <th>Campaign</th>
                    <th>Previous Budget</th>
                    <th>New Budget</th>
                    <th>Change</th>
                    <th>Applied By</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((adj) => {
                    const up   = adj.change_percent > 0;
                    const flat = Math.abs(adj.change_percent || 0) < 0.5;
                    return (
                      <tr
                        key={adj.id}
                        className={!flat ? (up ? 'bb-table-row-tint-up' : 'bb-table-row-tint-down') : ''}
                      >
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(adj.applied_at)}</td>
                        <td style={{ fontWeight: 600 }}>{adj.campaign_name || '—'}</td>
                        <td className="num">${(adj.old_budget || 0).toFixed(2)}</td>
                        <td className="num">${(adj.new_budget || 0).toFixed(2)}</td>
                        <td>
                          <span className={`bb-change ${flat ? 'bb-change-flat' : up ? 'bb-change-up' : 'bb-change-down'}`}>
                            {up ? '↗ +' : flat ? '' : '↘ '}{(adj.change_percent || 0).toFixed(1)}%
                          </span>
                        </td>
                        <td className="bb-muted" style={{ fontSize: 12 }}>{adj.applied_by || '—'}</td>
                        <td className="bb-muted" style={{ fontSize: 12 }}>{adj.reason || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default History;
