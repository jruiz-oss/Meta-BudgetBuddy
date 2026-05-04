import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  Legend
} from 'chart.js';
import './DetailPages.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function CampaignDetail({ user, onLogout }) {
  const { campaignId } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchData();
  }, [campaignId]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [campaignRes, historyRes] = await Promise.all([
        axios.get(`${API_URL}/campaigns/${campaignId}`, { withCredentials: true }),
        axios.get(`${API_URL}/campaigns/${campaignId}/pacing-history`, { withCredentials: true })
      ]);
      setCampaign(campaignRes.data.campaign);
      setHistory(historyRes.data.history || []);
    } catch (err) {
      setError('Failed to load campaign data');
    } finally {
      setLoading(false);
    }
  };

  const chartData = {
    labels: history.map(h => new Date(h.date).toLocaleDateString()),
    datasets: [
      {
        label: 'Pace Ratio',
        data: history.map(h => h.pace_ratio),
        borderColor: '#0073e6',
        backgroundColor: 'rgba(0, 115, 230, 0.1)',
        tension: 0.4
      }
    ]
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
          <div className="loading">Loading campaign...</div>
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
          <button className="link-btn" onClick={() => navigate(`/account/${campaign?.account_id}`)}>
            Account
          </button> / {campaign?.campaign_name}
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{campaign?.campaign_name}</h2>
          </div>

          <div className="campaign-overview">
            <div className="overview-stat">
              <span className="stat-label">Daily Budget</span>
              <span className="stat-value">${campaign?.daily_budget.toFixed(2)}</span>
            </div>
            <div className="overview-stat">
              <span className="stat-label">Flight Status</span>
              <span className={`badge badge-${campaign?.flight_status}`}>
                {campaign?.flight_status}
              </span>
            </div>
            <div className="overview-stat">
              <span className="stat-label">Flight Type</span>
              <span>{campaign?.flight_type}</span>
            </div>
            {campaign?.latest_pacing && (
              <>
                <div className="overview-stat">
                  <span className="stat-label">Current Pace Ratio</span>
                  <span className="stat-value" style={{ color: '#0073e6' }}>
                    {campaign.latest_pacing.pace_ratio.toFixed(3)}
                  </span>
                </div>
                <div className="overview-stat">
                  <span className="stat-label">Status</span>
                  <span className="badge"
                    style={{
                      backgroundColor:
                        campaign.latest_pacing.recommendation === 'on_track' ? '#28a745' :
                        campaign.latest_pacing.recommendation === 'over_pacing' ? '#dc3545' :
                        '#ffc107'
                    }}
                  >
                    {campaign.latest_pacing.recommendation}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {campaign?.latest_pacing && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Latest Pacing Data</h3>
            </div>
            <div className="pacing-metrics">
              <div className="metric-card">
                <div className="metric-label">Actual Spend</div>
                <div className="metric-value">${campaign.latest_pacing.actual_spend.toFixed(2)}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Expected Spend</div>
                <div className="metric-value">${campaign.latest_pacing.expected_spend.toFixed(2)}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Recommended Budget</div>
                <div className="metric-value">${campaign.latest_pacing.recommended_daily_budget?.toFixed(2) || 'N/A'}</div>
              </div>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">30-Day Pacing History</h3>
            </div>
            <div style={{ height: '300px', marginBottom: '20px' }}>
              <Line
                data={chartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: { display: true, position: 'top' }
                  },
                  scales: {
                    y: { beginAtZero: true }
                  }
                }}
              />
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Actual Spend</th>
                  <th>Expected Spend</th>
                  <th>Pace Ratio</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry, idx) => (
                  <tr key={idx}>
                    <td>{new Date(entry.date).toLocaleDateString()}</td>
                    <td>${entry.actual_spend.toFixed(2)}</td>
                    <td>${entry.expected_spend.toFixed(2)}</td>
                    <td>{entry.pace_ratio.toFixed(3)}</td>
                    <td>
                      <span className="badge" style={{
                        backgroundColor:
                          entry.recommendation === 'on_track' ? '#28a745' :
                          entry.recommendation === 'over_pacing' ? '#dc3545' :
                          '#ffc107'
                      }}>
                        {entry.recommendation}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default CampaignDetail;
