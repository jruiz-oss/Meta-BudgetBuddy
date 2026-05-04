import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import './History.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function History({ user, onLogout }) {
  const { accountId } = useParams();
  const [summary, setSummary] = useState(null);
  const [runs, setRuns] = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [activeTab, setActiveTab] = useState('summary');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const summaryRes = await axios.get(
        `${API_URL}/history/${accountId}/summary`,
        { withCredentials: true }
      );
      setSummary(summaryRes.data);

      if (activeTab === 'runs') {
        const runsRes = await axios.get(
          `${API_URL}/history/${accountId}/pacing-runs`,
          { withCredentials: true }
        );
        setRuns(runsRes.data.runs || []);
      } else if (activeTab === 'adjustments') {
        const adjRes = await axios.get(
          `${API_URL}/history/${accountId}/adjustments`,
          { withCredentials: true }
        );
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

  const handleLogout = () => {
    onLogout();
    navigate('/login');
  };

  if (loading) {
    return (
      <div className="page">
        <div className="header">
          <h1>Meta BudgetBuddy</h1>
          <div className="header-actions">
            <span className="header-user">{user.email}</span>
            <button className="btn btn-secondary btn-small" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
        <div className="container" style={{ textAlign: 'center', paddingTop: '60px' }}>
          <div className="loading">Loading history...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="header">
        <h1>Meta BudgetBuddy</h1>
        <div className="header-actions">
          <span className="header-user">{user.email}</span>
          <button className="btn btn-secondary btn-small" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      <div className="container">
        <div className="breadcrumb">
          <button className="link-btn" onClick={() => navigate('/')}>Home</button> /
          <button className="link-btn" onClick={() => navigate(`/account/${accountId}`)}>
            Account
          </button> / History
        </div>

        <h2 style={{ marginBottom: '24px', color: '#1a1a1a' }}>Activity History</h2>

        {error && <div className="alert alert-error">{error}</div>}

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-4">
            <div className="metric-card">
              <div className="metric-label">Total Runs</div>
              <div className="metric-value">{summary.total_runs}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Calculate Runs</div>
              <div className="metric-value">{summary.calculate_runs}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Apply Runs</div>
              <div className="metric-value">{summary.apply_runs}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Total Adjustments</div>
              <div className="metric-value">{summary.total_adjustments}</div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="settings-tabs" style={{ marginTop: '24px' }}>
          <button
            className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`}
            onClick={() => setActiveTab('summary')}
          >
            Summary
          </button>
          <button
            className={`tab-btn ${activeTab === 'runs' ? 'active' : ''}`}
            onClick={() => setActiveTab('runs')}
          >
            Pacing Runs
          </button>
          <button
            className={`tab-btn ${activeTab === 'adjustments' ? 'active' : ''}`}
            onClick={() => setActiveTab('adjustments')}
          >
            Budget Adjustments
          </button>
        </div>

        {activeTab === 'runs' && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Pacing Run History</h3>
            </div>
            {runs.length === 0 ? (
              <p style={{ color: '#666', margin: '16px 0' }}>No pacing runs yet</p>
            ) : (
              <table className="table">
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
                        <span className="badge" style={{
                          backgroundColor: run.run_type === 'calculate' ? '#d1ecf1' : '#d4edda',
                          color: run.run_type === 'calculate' ? '#0c5460' : '#155724'
                        }}>
                          {run.run_type}
                        </span>
                      </td>
                      <td>{run.campaigns_checked}</td>
                      <td>{run.adjustments_made}</td>
                      <td>
                        {run.errors ? (
                          <span style={{ color: '#dc3545', fontSize: '12px' }}>Error</span>
                        ) : (
                          <span style={{ color: '#28a745', fontSize: '12px' }}>Success</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'adjustments' && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Budget Adjustment Log</h3>
            </div>
            {adjustments.length === 0 ? (
              <p style={{ color: '#666', margin: '16px 0' }}>No adjustments yet</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Applied At</th>
                    <th>Previous Budget</th>
                    <th>New Budget</th>
                    <th>Change (%)</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((adj) => (
                    <tr key={adj.id}>
                      <td>{new Date(adj.applied_at).toLocaleString()}</td>
                      <td>${adj.previous_budget.toFixed(2)}</td>
                      <td>${adj.new_budget.toFixed(2)}</td>
                      <td style={{
                        color: adj.change_percent > 0 ? '#dc3545' : '#28a745',
                        fontWeight: '600'
                      }}>
                        {adj.change_percent > 0 ? '+' : ''}{adj.change_percent.toFixed(2)}%
                      </td>
                      <td style={{ fontSize: '12px', color: '#666' }}>{adj.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default History;
