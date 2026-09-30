import React from 'react';

// Small building blocks used by the docs content. Styles live in pages/Docs.css (dx-*).

export function Callout({ tone = 'info', title, children }) {
  return (
    <div className={`dx-callout is-${tone}`}>
      {title && <div className="dx-callout-title">{title}</div>}
      <div className="dx-callout-body">{children}</div>
    </div>
  );
}

export function Steps({ children }) {
  return <ol className="dx-steps">{children}</ol>;
}

export function Step({ title, children }) {
  return (
    <li className="dx-step">
      <div className="dx-step-title">{title}</div>
      {children && <div className="dx-step-body">{children}</div>}
    </li>
  );
}

// Wide tables scroll inside the wrapper only, never the page.
export function DocTable({ head, rows }) {
  return (
    <div className="bb-table-scroll dx-table">
      <table className="bb-table">
        <thead>
          <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Problem / cause / fix block for the troubleshooting page.
export function Issue({ symptom, children }) {
  return (
    <div className="dx-issue">
      <div className="dx-issue-symptom">{symptom}</div>
      <div className="dx-issue-body">{children}</div>
    </div>
  );
}
