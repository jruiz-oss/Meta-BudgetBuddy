import React from 'react';
import { NavLink, useParams } from 'react-router-dom';

// Deterministic hue from account ID so each account gets a consistent color dot
function acctHue(id) {
  const n = parseInt(id, 10) || 0;
  return (n * 137 + 43) % 360;
}

// Inline SVG icons
const IHome = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/>
  </svg>
);
const IBuilding = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>
  </svg>
);
const IGrid = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
  </svg>
);
const IHistory = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>
  </svg>
);
const ISettings = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>
  </svg>
);

function Sidebar({ user, accounts = [], onAddAccount }) {
  const { accountId } = useParams();
  const email = user?.email || '';
  const initials = email ? email.slice(0, 2).toUpperCase() : 'BB';

  return (
    <aside className="bb-sidebar">
      {/* Brand */}
      <NavLink to="/" className="bb-brand" style={{ textDecoration: 'none' }}>
        <img src="/logo.svg" alt="" style={{ width: 36, height: 'auto', flexShrink: 0 }} />
        <span>BudgetBuddy</span>
      </NavLink>

      {/* Accounts list — scrollable, takes available space */}
      <div className="bb-sidebar-accounts">
        <div className="bb-side-section">Accounts</div>
        {accounts.map((acc) => (
          <NavLink
            key={acc.id}
            to={`/account/${acc.id}`}
            className={({ isActive }) => 'bb-nav-item' + (isActive ? ' is-active' : '')}
            style={{ '--acct-hue': acctHue(acc.id) }}
          >
            <span className="bb-acct-dot" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {acc.account_name}
            </span>
          </NavLink>
        ))}
      </div>

      <div className="bb-nav-divider" />

      {/* Navigation */}
      <div className="bb-side-section">Navigation</div>
      <NavLink to="/" end className={({ isActive }) => 'bb-nav-item' + (isActive ? ' is-active' : '')}>
        <IHome /><span>Home</span>
      </NavLink>
      <NavLink to="/accounts" className={({ isActive }) => 'bb-nav-item' + (isActive ? ' is-active' : '')}>
        <IBuilding /><span>Accounts</span>
      </NavLink>

      {accountId ? (
        <NavLink to={`/account/${accountId}`} end className={({ isActive }) => 'bb-nav-item' + (isActive ? ' is-active' : '')}>
          <IGrid /><span>Dashboard</span>
        </NavLink>
      ) : (
        <span className="bb-nav-item" style={{ opacity: 0.4, cursor: 'default' }}>
          <IGrid /><span>Dashboard</span>
        </span>
      )}

      <NavLink to="/history" className={({ isActive }) => 'bb-nav-item' + (isActive ? ' is-active' : '')}>
        <IHistory /><span>History</span>
      </NavLink>

      {accountId && (
        <NavLink to={`/account/${accountId}/history`} className={({ isActive }) => 'bb-nav-item bb-nav-item-sub' + (isActive ? ' is-active' : '')}>
          <span style={{ marginLeft: 8, opacity: 0.6, fontSize: 11 }}>↳ This account</span>
        </NavLink>
      )}

      {accountId ? (
        <NavLink to={`/account/${accountId}/settings`} className={({ isActive }) => 'bb-nav-item' + (isActive ? ' is-active' : '')}>
          <ISettings /><span>Settings</span>
        </NavLink>
      ) : (
        <span className="bb-nav-item" style={{ opacity: 0.4, cursor: 'default' }}>
          <ISettings /><span>Settings</span>
        </span>
      )}

      {/* User block */}
      <div className="bb-user">
        <div className="bb-avatar">{initials}</div>
        <div className="bb-flex-col" style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--bb-fg)', fontWeight: 500, fontSize: 'var(--bb-text-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {email || 'User'}
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
