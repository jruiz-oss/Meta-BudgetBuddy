import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import './Dashboard.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function AccountDashboard({ user, onLogout }) {
  const { accountId } = useParams();
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [runningPacing, setRunningPacing] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchData();
  }, [accountId]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [accountRes, campaignsRes] = await Promise.all([
        axios.get(`${API_URL}/accounts/${accountId}`, { withCredentials: true }),
        axios.get(`${API_URL}/campaigns/account/${accountId}`, { withCredentials: true })
      ]);
      setAccount(accountRes.data.account);
      setCampaigns(campaignsRes.data.campaigns || []);
    } catch (err) {
      setError('Failed to load account data');
    } finally {
      setLoading(false);
    }
  };

  const handleRunPacing = async () => {
    setRunningPacing(true);
    setError('');
    try {
      await axios.post(`${API_URL}/pacing/${accountId}/run`, {}, { withCredentials: true });
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to run pacing');
    } finally {
      setRunningPacing(false);
    }
  };

  const getStatusColor = (recommendation) => {
    if (recommendation === 'on_track') return '#28a745';
    if (recommendation === 'over_pacing') return '#dc3545';
    if (recommendation === 'under_pacing') return '#ffc107';
    return '#6c757d';
  };

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
          <div className="loading">Loading account...</div>
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
          <button className="link-btn" onClick={() => navigate('/')}>Home</button> / {account?.account_name}
        </div>

        <div className="dashboard-header">
          <div>
            <h2>{account?.account_name}</h2>
            <p className="dashboard-subtitle">Meta Account ID: {account?.meta_account_id}</p>
          </div>
          <div className="dashboard-actions">
            <button
              className="btn btn-primary"
              onClick={handleRunPacing}
              disabled={runningPacing}
            >
              {runningPacing ? 'Running Pacing...' : 'Run Pacing Check'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => navigate(`/account/${accountId}/settings`)}
            >
              Settings
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => navigate(`/account/${accountId}/history`)}
            >
              History
            </button>
          </div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Campaigns</h3>
          </div>

          {campaigns.length === 0 ? (
            <p style={{ color: '#666', margin: '16px 0' }}>No campaigns found</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign Name</th>
                  <th>Daily Budget</th>
                  <th>Flight Status</th>
                  <th>Pace Ratio</th>
                  <th>Status</th>
                  <th>Spend / Expected</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td className="campaign-name">{campaign.campaign_name}</td>
                    <td>${campaign.daily_budget.toFixed(2)}</td>
                    <td>
                      <span className={`badge badge-${campaign.flight_status}`}>
                        {campaign.flight_status}
                      </span>
                    </td>
                    <td>
                      {campaign.latest_pacing
                        ? campaign.latest_pacing.pace_ratio.toFixed(3)
                        : 'N/A'}
                    </td>
                    <td>
                      {campaign.latest_pacing && (
                        <span
                          className="badge"
                          style={{ backgroundColor: getStatusColor(campaign.latest_pacing.recommendation) }}
                        >
                          {campaign.latest_pacing.recommendation}
                        </span>
                      )}
                    </td>
                    <td>
                      {campaign.latest_pacing
                        ? `$${campaign.latest_pacing.actual_spend.toFixed(2)} / $${campaign.latest_pacing.expected_spend.toFixed(2)}`
                        : 'N/A'}
                    </td>
                    <td>
                      <button
                        className="btn btn-secondary btn-small"
                        onClick={() => navigate(`/campaign/${campaign.id}`)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default AccountDashboard;
