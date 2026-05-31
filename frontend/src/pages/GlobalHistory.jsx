import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { TrendingUp, TrendingDown, Minus, Inbox } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';

function GlobalHistory({ user }) {
  const [accounts, setAccounts]       = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [accountFilter, setAccountFilter] = useState('all');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [accountsRes, adjRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get('/api/history/global/adjustments'),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setAdjustments(adjRes.data.adjustments || []);
    } catch (err) {
      setError('Failed to load history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  };

  const filtered = accountFilter === 'all'
    ? adjustments
    : adjustments.filter((a) => String(a.account_id) === accountFilter);

  // Build unique account options from the adjustments list
  const accountOptions = Array.from(
    new Map(
      adjustments
        .filter((a) => a.account_id && a.account_name)
        .map((a) => [String(a.account_id), a.account_name])
    ).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />

      <main className="bb-main">
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link>{' / History'}
        </div>

        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Global Budget History</div>
            <div className="bb-page-subtitle">Every budget change pushed to Meta, across all accounts.</div>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        <div className="bb-card">
          <div className="bb-section" style={{ paddingBottom: 0 }}>
            <div className="bb-section-title" style={{ marginBottom: 12 }}>Budget Adjustment Log</div>

            {/* Account filter — horizontal scroll so chips don't squash */}
            {accountOptions.length > 1 && (
              <div
                className="bb-row"
                style={{
                  gap: 6,
                  marginBottom: 12,
                  flexWrap: 'nowrap',
                  overflowX: 'auto',
                  paddingBottom: 4,
                }}
              >
                <button
                  className={`bb-filter-btn ${accountFilter === 'all' ? 'is-active' : ''}`}
                  onClick={() => setAccountFilter('all')}
                  style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                >
                  All accounts
                </button>
                {accountOptions.map(([id, name]) => (
                  <button
                    key={id}
                    className={`bb-filter-btn ${accountFilter === id ? 'is-active' : ''}`}
                    onClick={() => setAccountFilter(id)}
                    style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {loading ? (
            <SkeletonTable rows={8} cols={7} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No budget adjustments yet"
              body="When you apply a recommendation, it will be logged here."
            />
          ) : (
            <table className="bb-table">
              <thead>
                <tr>
                  <th>Date &amp; Time</th>
                  <th>Account</th>
                  <th>Campaign</th>
                  <th>Previous</th>
                  <th>New</th>
                  <th>Change</th>
                  <th>Applied By</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((adj) => {
                  const up   = adj.change_percent > 0;
                  const flat = Math.abs(adj.change_percent || 0) < 0.5;
                  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
                  return (
                    <tr
                      key={adj.id}
                      className={!flat ? (up ? 'bb-table-row-tint-up' : 'bb-table-row-tint-down') : ''}
                    >
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(adj.applied_at)}</td>
                      <td>
                        {adj.account_id ? (
                          <Link
                            to={`/account/${adj.account_id}`}
                            style={{ color: 'var(--bb-accent)', textDecoration: 'none', fontWeight: 500 }}
                          >
                            {adj.account_name || '—'}
                          </Link>
                        ) : (
                          <span className="bb-muted">{adj.account_name || '—'}</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{adj.campaign_name || '—'}</td>
                      <td className="num">${(adj.old_budget || 0).toFixed(2)}</td>
                      <td className="num">${(adj.new_budget || 0).toFixed(2)}</td>
                      <td>
                        <span className={`bb-change ${flat ? 'bb-change-flat' : up ? 'bb-change-up' : 'bb-change-down'}`}>
                          <Icon size={11} aria-hidden="true" />
                          {up ? '+' : ''}{(adj.change_percent || 0).toFixed(1)}%
                        </span>
                      </td>
                      <td className="bb-muted" style={{ fontSize: 12 }}>{adj.applied_by || '—'}</td>
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

export default GlobalHistory;
