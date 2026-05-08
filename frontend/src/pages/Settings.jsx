import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import {
  LogOut, Save, Eye, ArrowDownToLine, ArrowUpFromLine, Loader2,
  SlidersHorizontal, Calendar, FileSpreadsheet, Mail, Inbox,
} from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { SkeletonCard } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

function Settings({ user, onLogout }) {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [accounts, setAccounts] = useState([]);
  const [activeTab, setActiveTab] = useState('pacing');
  const [settings, setSettings] = useState(null);
  const [flights, setFlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetSaving, setSheetSaving] = useState(false);
  const [sheetPreview, setSheetPreview] = useState(null);
  const [sheetPreviewLoading, setSheetPreviewLoading] = useState(false);
  const [sheetSyncLoading, setSheetSyncLoading] = useState(false);
  const [sheetWriteLoading, setSheetWriteLoading] = useState(false);

  // Per-account token override
  const [tokenOverride, setTokenOverride] = useState('');
  const [tokenSaving, setTokenSaving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [accountsRes, settingsRes, flightsRes, sheetConfigRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/settings/${accountId}`),
        axios.get(`/api/settings/${accountId}/flights`),
        axios.get(`/api/sheets/${accountId}/config`).catch(() => ({ data: { google_sheet_id: '' } })),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setSettings(settingsRes.data.settings || settingsRes.data);
      setFlights(flightsRes.data.flights || []);
      setSheetUrl(sheetConfigRes.data.google_sheet_id || '');
    } catch (err) {
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSettingsChange = (field, value) => {
    setSettings({ ...settings, [field]: value });
  };

  const handleSaveSettings = async () => {
    setError('');
    try {
      // Pacing math now mirrors the Google Sheet exactly: recommended daily =
      // (monthly_budget − MTD_spend) / days_remaining. The legacy tolerance/cap/floor
      // fields still exist on AccountSettings for backwards compatibility but no
      // longer affect anything, so the UI doesn't expose them.
      await axios.put(`/api/settings/${accountId}`, {
        daily_digest_enabled: !!settings.daily_digest_enabled,
      });
      toast.success('Settings saved.');
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to save settings';
      setError(msg);
      toast.error(msg);
    }
  };

  const handleSaveTokenOverride = async () => {
    setTokenSaving(true);
    try {
      await axios.put(`/api/accounts/${accountId}`, { meta_token: tokenOverride });
      toast.success(tokenOverride.trim() ? 'Token override saved.' : 'Token override cleared — using global token.');
      setTokenOverride('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save token');
    } finally {
      setTokenSaving(false);
    }
  };

  const handleFlightChange = (flightId, field, value) => {
    setFlights(flights.map((f) => (f.id === flightId ? { ...f, [field]: value } : f)));
  };

  const handleSaveFlights = async () => {
    setError('');
    try {
      const updates = flights.map((f) => ({
        id: f.id,
        flight_type: f.flight_type,
        flight_start_date: f.flight_start_date,
        flight_end_date: f.flight_end_date,
      }));
      await axios.put(`/api/settings/${accountId}/flights/batch`, { updates });
      toast.success('Flight settings updated.');
      fetchData();
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to update flights';
      setError(msg);
      toast.error(msg);
    }
  };

  const handleSaveSheetUrl = async () => {
    setError('');
    setSheetSaving(true);
    try {
      await axios.put(`/api/sheets/${accountId}/config`, { google_sheet_id: sheetUrl });
      toast.success('Sheet URL saved.');
      setSheetPreview(null);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to save Sheet URL';
      setError(msg);
      toast.error(msg);
    } finally {
      setSheetSaving(false);
    }
  };

  const handlePreviewSheet = async () => {
    setError('');
    setSheetPreviewLoading(true);
    setSheetPreview(null);
    try {
      const res = await axios.get(`/api/sheets/${accountId}/preview`);
      setSheetPreview(res.data);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to preview sheet';
      setError(msg);
      toast.error(msg);
    } finally {
      setSheetPreviewLoading(false);
    }
  };

  const handleSyncBudgets = async () => {
    setError('');
    setSheetSyncLoading(true);
    try {
      const res = await axios.post(`/api/sheets/${accountId}/sync-budgets`);
      toast.success(`${res.data.message} (${res.data.skipped_count} skipped).`);
      setSheetPreview(null);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to sync budgets';
      setError(msg);
      toast.error(msg);
    } finally {
      setSheetSyncLoading(false);
    }
  };

  const handleWriteSpend = async () => {
    setError('');
    setSheetWriteLoading(true);
    try {
      const res = await axios.post(`/api/sheets/${accountId}/write-spend`);
      toast.success(`${res.data.message} (${res.data.skipped_count} skipped).`);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to write spend to sheet';
      setError(msg);
      toast.error(msg);
    } finally {
      setSheetWriteLoading(false);
    }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout();
    navigate('/login');
  };

  const flightStatusPill = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'active' || s === 'live')       return <span className="bb-pill bb-pill-on">{status}</span>;
    if (s === 'scheduled' || s === 'pending') return <span className="bb-pill bb-pill-up">{status}</span>;
    if (s === 'ended')                        return <span className="bb-pill bb-pill-down">{status}</span>;
    return <span className="bb-pill bb-pill-muted">{status || '—'}</span>;
  };

  const matchQualityPill = (type) => {
    if (type === 'exact')            return <span className="bb-pill bb-pill-on">Exact</span>;
    if (type === 'case_insensitive') return <span className="bb-pill bb-pill-up">Case</span>;
    if (type === 'partial')          return <span className="bb-pill bb-pill-muted">Partial</span>;
    return <span className="bb-pill bb-pill-down">No match</span>;
  };

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />

      <main className="bb-main">
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link>{' / '}
          <Link to={`/account/${accountId}`}>Dashboard</Link>{' / Settings'}
        </div>

        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Account Settings</div>
            <div className="bb-page-subtitle">Pacing parameters, campaign flights, and Google Sheets sync.</div>
          </div>
          <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>
            <LogOut size={14} aria-hidden="true" /> Log out
          </button>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        <div className="bb-tabs">
          <button className={`bb-tab-btn ${activeTab === 'pacing'  ? 'is-active' : ''}`} onClick={() => setActiveTab('pacing')}>
            <SlidersHorizontal size={14} aria-hidden="true" /> Pacing Parameters
          </button>
          <button className={`bb-tab-btn ${activeTab === 'flights' ? 'is-active' : ''}`} onClick={() => setActiveTab('flights')}>
            <Calendar size={14} aria-hidden="true" /> Campaign Flights
          </button>
          <button className={`bb-tab-btn ${activeTab === 'sheets'  ? 'is-active' : ''}`} onClick={() => setActiveTab('sheets')}>
            <FileSpreadsheet size={14} aria-hidden="true" /> Google Sheets
          </button>
        </div>

        {loading ? (
          <SkeletonCard height={320} />

        ) : activeTab === 'pacing' && settings ? (
          <div className="bb-card">
            <div className="bb-section">
              <div style={{ marginBottom: 16 }}>
                <div className="bb-section-title">Pacing Configuration</div>
                <div className="bb-section-meta" style={{ marginTop: 2 }}>
                  Recommendations follow your "Social Budget Pacing" sheet:
                  recommended daily = (monthly budget − MTD spend) ÷ days remaining,
                  split by ABO allocation %.
                </div>
              </div>

              {/* Daily digest toggle — works only when SMTP env vars are set on the backend. */}
              <div style={{ marginTop: 8, padding: '12px 14px', background: '#f9fafb', border: '1px solid var(--bb-border)', borderRadius: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!settings.daily_digest_enabled}
                    onChange={(e) => handleSettingsChange('daily_digest_enabled', e.target.checked)}
                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                  />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <Mail size={14} aria-hidden="true" /> Email me a daily pacing digest
                  </span>
                </label>
                <div className="bb-muted" style={{ fontSize: 12, marginTop: 4, marginLeft: 26 }}>
                  After each automated pacing run, send a summary to <strong>{user?.email}</strong> with
                  campaigns that need adjusting. Requires SMTP to be configured on the server.
                </div>
              </div>

              <div className="bb-alert bb-alert-info" style={{ marginTop: 12 }}>
                Pacing runs nightly and writes recommendations. Budget changes are
                always pushed to Meta manually — review on the dashboard and click Apply.
              </div>

              <div style={{ marginTop: 16 }}>
                <button className="bb-btn bb-btn-primary" onClick={handleSaveSettings}>
                  <Save size={14} aria-hidden="true" /> Save settings
                </button>
              </div>

              {/* Per-account token override */}
              <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--bb-divider)' }}>
                <div className="bb-section-title" style={{ marginBottom: 4 }}>Meta Token Override</div>
                <div className="bb-section-meta" style={{ marginBottom: 12 }}>
                  Leave blank to use the global token. Only fill this in if this specific account uses a different token.
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="password"
                    className="bb-input"
                    placeholder="Paste new token, or leave blank to revert to global"
                    value={tokenOverride}
                    onChange={(e) => setTokenOverride(e.target.value)}
                    style={{ maxWidth: 400 }}
                  />
                  <button
                    className="bb-btn bb-btn-secondary"
                    onClick={handleSaveTokenOverride}
                    disabled={tokenSaving}
                  >
                    {tokenSaving ? <Loader2 size={14} className="bb-spin" /> : <Save size={14} aria-hidden="true" />}
                    {tokenOverride.trim() ? 'Save override' : 'Clear override'}
                  </button>
                </div>
              </div>
            </div>
          </div>

        ) : activeTab === 'flights' ? (
          <div className="bb-card">
            <div className="bb-section">
              <div style={{ marginBottom: 16 }}>
                <div className="bb-section-title">Campaign Flight Schedules</div>
                <div className="bb-section-meta" style={{ marginTop: 2 }}>
                  Always-on campaigns run continuously. Limited campaigns only pace inside their flight window.
                </div>
              </div>

              {flights.length === 0 ? (
                <EmptyState
                  icon={Inbox}
                  title="No campaigns to configure yet"
                  body="Import some campaigns from the dashboard first."
                />
              ) : (
                <table className="bb-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Flight Type</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flights.map((flight) => {
                      const isLimited = flight.flight_type === 'LIMITED';
                      return (
                        <tr key={flight.id}>
                          <td style={{ fontWeight: 600 }}>{flight.campaign_name}</td>
                          <td>
                            <select
                              className="bb-select"
                              value={flight.flight_type || 'ALWAYS_ON'}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_type', e.target.value)}
                            >
                              <option value="ALWAYS_ON">Always On</option>
                              <option value="LIMITED">Limited</option>
                            </select>
                          </td>
                          <td>
                            <input
                              type="datetime-local"
                              className="bb-input"
                              disabled={!isLimited}
                              value={flight.flight_start_date ? flight.flight_start_date.replace('Z', '') : ''}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_start_date', e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="datetime-local"
                              className="bb-input"
                              disabled={!isLimited}
                              value={flight.flight_end_date ? flight.flight_end_date.replace('Z', '') : ''}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_end_date', e.target.value)}
                            />
                          </td>
                          <td>{flightStatusPill(flight.flight_status)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {flights.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <button className="bb-btn bb-btn-primary" onClick={handleSaveFlights}>
                    <Save size={14} aria-hidden="true" /> Save flight settings
                  </button>
                </div>
              )}
            </div>
          </div>

        ) : activeTab === 'sheets' ? (
          <div className="bb-card">
            <div className="bb-section">
              <div style={{ marginBottom: 16 }}>
                <div className="bb-section-title">Google Sheets Connection</div>
                <div className="bb-section-meta" style={{ marginTop: 2 }}>
                  Connect your "Social Budget Pacing" sheet to pull monthly budgets and push MTD spend automatically.
                </div>
              </div>

              <div className="bb-alert bb-alert-info" style={{ marginBottom: 16 }}>
                <strong>Before you start:</strong> Make sure the service account email from your Google Cloud credentials
                has been added as an <strong>Editor</strong> on the sheet, and that
                {' '}<code>GOOGLE_CREDENTIALS_JSON</code> is set as an environment variable on Railway.
              </div>

              <div className="bb-form-group" style={{ maxWidth: 580 }}>
                <label className="bb-form-label">Sheet URL or ID</label>
                <input
                  type="text"
                  className="bb-input"
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={sheetUrl}
                  onChange={(e) => { setSheetUrl(e.target.value); setSheetPreview(null); }}
                />
                <span className="bb-form-help">
                  Paste the full Google Sheets URL — the ID is extracted automatically.
                </span>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  className="bb-btn bb-btn-primary"
                  onClick={handleSaveSheetUrl}
                  disabled={sheetSaving || !sheetUrl.trim()}
                >
                  {sheetSaving ? <Loader2 size={14} className="bb-spin" /> : <Save size={14} aria-hidden="true" />}
                  {sheetSaving ? 'Saving…' : 'Save URL'}
                </button>
                <button
                  className="bb-btn bb-btn-secondary"
                  onClick={handlePreviewSheet}
                  disabled={sheetPreviewLoading || !sheetUrl.trim()}
                >
                  {sheetPreviewLoading ? <Loader2 size={14} className="bb-spin" /> : <Eye size={14} aria-hidden="true" />}
                  {sheetPreviewLoading ? 'Loading…' : 'Preview Matches'}
                </button>
              </div>
            </div>

            {sheetPreview && (
              <div className="bb-section" style={{ borderTop: '1px solid var(--bb-divider)' }}>
                <div className="bb-row-between" style={{ marginBottom: 14 }}>
                  <div>
                    <div className="bb-section-title">Match Preview — {sheetPreview.sheet_tab}</div>
                    <div className="bb-section-meta" style={{ marginTop: 2 }}>
                      {sheetPreview.matched} of {sheetPreview.total_sheet_rows} rows matched to a tracked campaign
                      {sheetPreview.unmatched > 0 && (
                        <span style={{ color: '#b45309', marginLeft: 6 }}>
                          · {sheetPreview.unmatched} unmatched
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button
                      className="bb-btn bb-btn-primary"
                      onClick={handleSyncBudgets}
                      disabled={sheetSyncLoading}
                      title="Read column B budgets from sheet → update DB campaigns"
                    >
                      {sheetSyncLoading ? <Loader2 size={14} className="bb-spin" /> : <ArrowDownToLine size={14} aria-hidden="true" />}
                      {sheetSyncLoading ? 'Syncing…' : 'Sync Budgets'}
                    </button>
                    <button
                      className="bb-btn bb-btn-secondary"
                      onClick={handleWriteSpend}
                      disabled={sheetWriteLoading}
                      title="Write MTD spend to col C and today's date to col G"
                    >
                      {sheetWriteLoading ? <Loader2 size={14} className="bb-spin" /> : <ArrowUpFromLine size={14} aria-hidden="true" />}
                      {sheetWriteLoading ? 'Writing…' : 'Write Spend'}
                    </button>
                  </div>
                </div>

                <table className="bb-table">
                  <thead>
                    <tr>
                      <th>Sheet Campaign</th>
                      <th>Monthly Budget (sheet)</th>
                      <th>MTD Spend (sheet)</th>
                      <th>Matched Campaign</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheetPreview.matches.map((m, idx) => (
                      <tr key={idx} className={m.match_type === 'none' ? 'bb-table-row-tint-down' : ''}>
                        <td style={{ fontWeight: 600 }}>{m.sheet_name}</td>
                        <td className="num">
                          {m.monthly_budget != null
                            ? `$${Number(m.monthly_budget).toLocaleString()}`
                            : <span className="bb-muted">—</span>}
                        </td>
                        <td className="num">
                          {m.mtd_spend != null
                            ? `$${Number(m.mtd_spend).toLocaleString()}`
                            : <span className="bb-muted">—</span>}
                        </td>
                        <td style={{ color: m.match_type === 'none' ? '#b91c1c' : 'inherit' }}>
                          {m.matched_campaign_name || <span className="bb-muted">No match found</span>}
                        </td>
                        <td>{matchQualityPill(m.match_type)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="bb-form-help" style={{ marginTop: 10 }}>
                  <strong>Sync Budgets</strong> reads column B → updates monthly budget in the DB.{' '}
                  <strong>Write Spend</strong> writes MTD spend to column C and today's date to column G.
                  Run pacing first so there's spend data to write.
                </div>
              </div>
            )}
          </div>

        ) : null}
      </main>
    </div>
  );
}

export default Settings;
