import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';

function History({ user, onLogout }) {
  const { accountId } = useParams();
  const [accounts, setAccounts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [runs, setRuns] = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [activeTab, setActiveTab] = useState('runs');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const accountsRes = await axios.get('/api/accounts');
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);

      const summaryRes = await axios.get(`/api/history/${accountId}/summary`);
      setSummary(summaryRes.data);

      if (activeTab === 'runs') {
        const runsRes = await axios.get(`/api/history/${accountId}/pacing-runs`);
        setRuns(runsRes.data.runs || []);
      } else if (activeTab === 'adjustments') {
        const adjRes = await axios.get(`/api/history/${accountId}/adjustments`);
        setAdjustments(adjRes.data.adjustments || []);
      }
    } catch (err) {
      setError('Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [accountId, activeTab]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch { /* ignore */ }
    onLogout();
    navigate('/login');
  };

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} variant="account" />

      <main className="bb-main">
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link>
          {' / '}
          <Link to={`/account/${accountId}`}>Dashboard</Link>
          {' / History'}
        </div>

        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Activity History</div>
            <div className="bb-page-subtitle">Pacing runs and budget adjustments for this account.</div>
          </div>
          <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Top stats */}
        {summary && (
          <div className="bb-grid bb-grid-4" style={{ marginBottom: 20 }}>
            <div className="bb-stat">
              <span className="bb-stat-label">Total Runs</span>
              <span className="bb-stat-value">{summary.total_runs ?? 0}</span>
            </div>
            <div className="bb-stat">
              <span className="bb-stat-label">Calculate Runs</span>
              <span className="bb-stat-value">{summary.calculate_runs ?? 0}</span>
            </div>
            <div className="bb-stat">
              <span className="bb-stat-label">Apply Runs</span>
              <span className="bb-stat-value">{summary.apply_runs ?? 0}</span>
            </div>
            <div className="bb-stat">
              <span className="bb-stat-label">Total Adjustments</span>
              <span className="bb-stat-value">{summary.total_adjustments ?? 0}</span>
            </div>
          </div>
        )}

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
          <div className="bb-card bb-section bb-muted">Loading...</div>
        ) : activeTab === 'runs' ? (
          <div className="bb-card">
            <div className="bb-section">
              <div className="bb-section-title">Pacing Run History</div>
            </div>
            {runs.length === 0 ? (
              <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>No pacing runs yet.</div>
            ) : (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Executed At</th>
                    <th>Type</th>
                    <th>Campaigns Checked</th>
                    <th>Adjustments Made</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>{new Date(run.executed_at).toLocaleString()}</td>
                      <td>
                        <span className={`bb-pill ${run.run_type === 'apply' ? 'bb-pill-on' : 'bb-pill-up'}`}>
                          {run.run_type}
                        </span>
                      </td>
                      <td className="num">{run.campaigns_checked}</td>
                      <td className="num">{run.adjustments_made}</td>
                      <td>
                        {run.errors ? (
                          <span className="bb-pill bb-pill-down">Error</span>
                        ) : (
                          <span className="bb-pill bb-pill-on">Success</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div className="bb-card">
            <div className="bb-section">
              <div className="bb-section-title">Budget Adjustment Log</div>
            </div>
            {adjustments.length === 0 ? (
              <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>No adjustments yet.</div>
            ) : (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Applied At</th>
                    <th>Previous Budget</th>
                    <th>New Budget</th>
                    <th>Change</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((adj) => {
                    const up = adj.change_percent > 0;
                    const flat = Math.abs(adj.change_percent || 0) < 0.5;
                    return (
                      <tr key={adj.id} className={!flat ? (up ? 'bb-table-row-tint-up' : 'bb-table-row-tint-down') : ''}>
                        <td>{new Date(adj.applied_at).toLocaleString()}</td>
                        <td className="num">${adj.previous_budget.toFixed(2)}</td>
                        <td className="num">${adj.new_budget.toFixed(2)}</td>
                        <td>
                          <span className={`bb-change ${flat ? 'bb-change-flat' : up ? 'bb-change-up' : 'bb-change-down'}`}>
                            {up ? '↗ +' : flat ? '' : '↘ '}{adj.change_percent.toFixed(1)}%
                          </span>
                        </td>
                        <td className="bb-muted" style={{ fontSize: 12 }}>{adj.reason}</td>
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
