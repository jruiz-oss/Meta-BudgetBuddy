import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import Sidebar from '../components/Sidebar';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

function CampaignDetail({ user, onLogout }) {
  const { campaignId, accountId } = useParams();
  const [accounts, setAccounts] = useState([]);
  const [campaign, setCampaign] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [accountsRes, campaignRes, historyRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/campaigns/${campaignId}`),
        axios.get(`/api/campaigns/${campaignId}/pacing-history`),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setCampaign(campaignRes.data.campaign || campaignRes.data);
      setHistory(historyRes.data.history || []);
    } catch (err) {
      setError('Failed to load campaign data');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

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

  const lp = campaign?.latest_pacing;

  const pillForStatus = (status) => {
    const s = (status || '').toUpperCase();
    if (s === 'ON_PACE')      return { cls: 'bb-pill bb-pill-on',   text: 'ON_PACE' };
    if (s === 'INCREASE' || s === 'UNDER_PACING')  return { cls: 'bb-pill bb-pill-up', text: s };
    if (s === 'DECREASE' || s === 'OVER_PACING')   return { cls: 'bb-pill bb-pill-down', text: s };
    return { cls: 'bb-pill bb-pill-muted', text: s || '—' };
  };

  const chartData = {
    labels: history.map((h) => new Date(h.date).toLocaleDateString()),
    datasets: [
      {
        label: 'Pace Ratio',
        data: history.map((h) => h.pace_ratio),
        borderColor: '#0f3845',
        backgroundColor: 'rgba(15, 56, 69, 0.10)',
        tension: 0.4,
        fill: true,
        pointRadius: 3,
      },
      {
        label: 'On-pace target',
        data: history.map(() => 1.0),
        borderColor: '#9ca3af',
        borderDash: [4, 4],
        pointRadius: 0,
        tension: 0,
      },
    ],
  };

  if (loading) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} variant="account" />
        <main className="bb-main">
          <div className="bb-card bb-section bb-muted">Loading campaign...</div>
        </main>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} variant="account" />
        <main className="bb-main">
          <div className="bb-alert bb-alert-error">Campaign not found.</div>
        </main>
      </div>
    );
  }

  const pill = pillForStatus(lp?.status || lp?.recommendation);

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} variant="account" />

      <main className="bb-main">
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link>
          {accountId && <> / <Link to={`/account/${accountId}`}>Dashboard</Link></>}
          {!accountId && campaign.account_id && (
            <> / <Link to={`/account/${campaign.account_id}`}>Dashboard</Link></>
          )}
          {' / '}{campaign.campaign_name}
        </div>

        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">{campaign.campaign_name}</div>
            <div className="bb-page-subtitle">
              Meta campaign ID: {campaign.meta_campaign_id}
              {campaign.flight_type && <> · Flight: {campaign.flight_type}</>}
            </div>
          </div>
          <div className="bb-row">
            {pill.text !== '—' && <span className={pill.cls} style={{ fontSize: 12 }}>{pill.text}</span>}
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* 4 stat tiles */}
        <div className="bb-grid bb-grid-4" style={{ marginBottom: 20 }}>
          <div className="bb-stat">
            <span className="bb-stat-label">Monthly Budget</span>
            <span className="bb-stat-value">${(campaign.monthly_budget || 0).toFixed(0)}</span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Current Daily</span>
            <span className="bb-stat-value">
              ${(lp?.current_daily_budget ?? campaign.daily_budget ?? 0).toFixed(2)}
            </span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Spend to Date</span>
            <span className="bb-stat-value">${(lp?.actual_spend || 0).toFixed(0)}</span>
            <span className="bb-stat-sub">expected ${(lp?.expected_spend || 0).toFixed(0)}</span>
          </div>
          <div className="bb-stat">
            <span className="bb-stat-label">Pace Ratio</span>
            <span className="bb-stat-value">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</span>
            <span className="bb-stat-sub">
              recommended ${(lp?.recommended_daily_budget || 0).toFixed(2)}/day
            </span>
          </div>
        </div>

        {history.length > 0 && (
          <div className="bb-card" style={{ marginBottom: 20 }}>
            <div className="bb-section">
              <div className="bb-section-head">
                <div className="bb-section-title">30-Day Pacing History</div>
                <div className="bb-section-meta">Pace ratio over time. 1.0 = exactly on pace.</div>
              </div>
              <div style={{ height: 280 }}>
                <Line
                  data={chartData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: true, suggestedMax: 1.5 } },
                  }}
                />
              </div>
            </div>
          </div>
        )}

        <div className="bb-card">
          <div className="bb-section">
            <div className="bb-section-head">
              <div className="bb-section-title">Adjustment History</div>
              <div className="bb-section-meta">Every pacing snapshot for this campaign.</div>
            </div>
          </div>

          {history.length === 0 ? (
            <div className="bb-section bb-muted" style={{ paddingTop: 0 }}>
              No pacing history yet. Run pacing on the account to populate this.
            </div>
          ) : (
            <table className="bb-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Actual Spend</th>
                  <th>Expected</th>
                  <th>Pace Ratio</th>
                  <th>Recommended Daily</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.slice().reverse().map((entry, idx) => {
                  const p = pillForStatus(entry.status || entry.recommendation);
                  return (
                    <tr key={idx}>
                      <td>{new Date(entry.date).toLocaleDateString()}</td>
                      <td className="num">${(entry.actual_spend || 0).toFixed(2)}</td>
                      <td className="num">${(entry.expected_spend || 0).toFixed(2)}</td>
                      <td className="num">{(entry.pace_ratio || 0).toFixed(2)}x</td>
                      <td className="num">
                        {entry.recommended_daily_budget !== undefined && entry.recommended_daily_budget !== null
                          ? `$${entry.recommended_daily_budget.toFixed(2)}`
                          : '—'}
                      </td>
                      <td><span className={p.cls}>{p.text}</span></td>
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
