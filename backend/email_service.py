"""
Email service — sends the daily pacing digest after the scheduled run.

SMTP-based so it works with any provider (Resend, SendGrid, Postmark, Gmail, SES).
Configured by env vars (all required, otherwise sending is skipped silently):

    SMTP_HOST   smtp.resend.com / smtp.sendgrid.net / smtp.gmail.com / ...
    SMTP_PORT   typically 587 (STARTTLS) or 465 (SSL)
    SMTP_USER   provider username — for Resend it's "resend", for SendGrid "apikey"
    SMTP_PASS   provider password / API key
    SMTP_FROM   from address — must be on a verified domain

If any of these are missing, send_digest() returns ``False`` and logs a single
warning. The scheduled pacing job continues regardless.

Usage:
    from email_service import send_digest
    send_digest(to="user@example.com", subject="…", html_body="…", text_body="…")
"""

import html
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage


def _esc(value) -> str:
    """HTML-escape a value for safe interpolation into the digest body.

    Campaign / ad set names come from Meta and are surfaced in the email
    largely as-is. Without escaping, a name containing ``<img src=x ...>`` or
    a stray quote could break the HTML structure or render unintended markup
    in the recipient's mail client. Always run user/Meta-controlled strings
    through this before f-stringing into the HTML body.
    """
    if value is None:
        return ""
    return html.escape(str(value), quote=True)

logger = logging.getLogger(__name__)


def _smtp_config():
    cfg = {
        "host": os.getenv("SMTP_HOST"),
        "port": int(os.getenv("SMTP_PORT") or 0) or None,
        "user": os.getenv("SMTP_USER"),
        "password": os.getenv("SMTP_PASS"),
        "from_": os.getenv("SMTP_FROM"),
    }
    if not all(cfg.values()):
        return None
    return cfg


def smtp_configured():
    """Cheap probe: are all the SMTP env vars set?"""
    return _smtp_config() is not None


def send_digest(to, subject, html_body, text_body):
    """Send a single digest email. Returns True on success, False otherwise.

    Never raises — failures are logged and swallowed so a scheduler crash is impossible.
    """
    cfg = _smtp_config()
    if cfg is None:
        logger.info("SMTP not configured — skipping digest email to %s.", to)
        return False

    msg = EmailMessage()
    msg["From"] = cfg["from_"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text_body or "(see HTML version)")
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    try:
        ctx = ssl.create_default_context()
        if cfg["port"] == 465:
            with smtplib.SMTP_SSL(cfg["host"], cfg["port"], context=ctx, timeout=30) as smtp:
                smtp.login(cfg["user"], cfg["password"])
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(cfg["host"], cfg["port"], timeout=30) as smtp:
                smtp.ehlo()
                smtp.starttls(context=ctx)
                smtp.ehlo()
                smtp.login(cfg["user"], cfg["password"])
                smtp.send_message(msg)
        logger.info("Digest email sent to %s.", to)
        return True
    except Exception:
        logger.exception("Failed to send digest email to %s.", to)
        return False


# ── Digest body builder ──────────────────────────────────────────────────────

def _fmt_money(n):
    try:
        return f"${float(n):,.2f}"
    except (TypeError, ValueError):
        return "—"


def build_digest(user_email, account_summaries):
    """Compose subject + HTML + text bodies for a per-user digest.

    account_summaries is a list of dicts:
        {
          "account_name": str,
          "campaigns_processed": int,
          "adjustments_needed": int,
          "off_pace": [
             {
               "campaign_name": str,
               "level": "campaign" | "ad set",
               "adset_name": str | None,    # only for ABO
               "actual_spend": float,
               "expected_spend": float,
               "pace_ratio": float,
               "current_daily": float,
               "recommended_daily": float,
               "change_percent": float,
               "action": "INCREASE" | "DECREASE",
             }, ...
          ],
        }

    Returns (subject, html, text). Returns (None, None, None) if there's
    nothing to report (no off-pace items across all accounts).
    """
    total_off_pace = sum(len(a.get("off_pace", [])) for a in account_summaries)
    total_processed = sum(a.get("campaigns_processed", 0) for a in account_summaries)

    if total_off_pace == 0 and total_processed == 0:
        return None, None, None  # nothing to send

    n_accounts = len(account_summaries)
    subject = f"BudgetBuddy daily digest — {total_off_pace} need attention" \
        if total_off_pace > 0 else "BudgetBuddy daily digest — all on pace"

    # ── Plain-text body ──
    lines = [
        f"BudgetBuddy daily pacing digest for {user_email}",
        "",
        f"{total_processed} campaign{'s' if total_processed != 1 else ''} processed across "
        f"{n_accounts} account{'s' if n_accounts != 1 else ''}.",
        f"{total_off_pace} need budget adjustment{'s' if total_off_pace != 1 else ''}.",
        "",
    ]
    for acct in account_summaries:
        lines.append(f"── {acct['account_name']} ──")
        off = acct.get("off_pace", [])
        if not off:
            lines.append("  All campaigns on pace.")
        for it in off:
            label = it["adset_name"] or it["campaign_name"]
            arrow = "↑" if it["action"] == "INCREASE" else "↓"
            lines.append(
                f"  {arrow} {label}: spend "
                f"{_fmt_money(it['actual_spend'])} vs expected {_fmt_money(it['expected_spend'])} · "
                f"current daily {_fmt_money(it['current_daily'])} → recommend {_fmt_money(it['recommended_daily'])} "
                f"({it['change_percent']:+.1f}%)"
            )
        lines.append("")
    lines.append("Open BudgetBuddy to apply or skip these recommendations.")
    text_body = "\n".join(lines)

    # ── HTML body ──
    rows_html = []
    for acct in account_summaries:
        rows_html.append(
            f'<tr><td colspan="6" style="padding:14px 12px 6px;background:#f0f2f4;'
            f'font-size:13px;font-weight:700;color:#0d1f26;border-top:1px solid #e2e5e8;">'
            f'{_esc(acct["account_name"])}</td></tr>'
        )
        off = acct.get("off_pace", [])
        if not off:
            rows_html.append(
                '<tr><td colspan="6" style="padding:8px 12px;font-size:12px;color:#10b981;">'
                '✓ All campaigns on pace.</td></tr>'
            )
        for it in off:
            label = _esc(it["adset_name"] or it["campaign_name"])
            color = "#10b981" if it["action"] == "INCREASE" else "#f59e0b"
            arrow = "▲" if it["action"] == "INCREASE" else "▼"
            sub = (
                f'<div style="font-size:11px;color:#6b7280;">in {_esc(it["campaign_name"])}</div>'
                if it["adset_name"] else ""
            )
            rows_html.append(
                "<tr>"
                f'<td style="padding:8px 12px;font-size:13px;">{label}{sub}</td>'
                f'<td style="padding:8px 12px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;">{_esc(_fmt_money(it["actual_spend"]))}</td>'
                f'<td style="padding:8px 12px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">{_esc(_fmt_money(it["expected_spend"]))}</td>'
                f'<td style="padding:8px 12px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;">{_esc(_fmt_money(it["current_daily"]))}</td>'
                f'<td style="padding:8px 12px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">{_esc(_fmt_money(it["recommended_daily"]))}</td>'
                f'<td style="padding:8px 12px;font-size:12px;text-align:right;color:{color};font-weight:700;white-space:nowrap;">{arrow} {it["change_percent"]:+.1f}%</td>'
                "</tr>"
            )

    html_body = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{_esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f9fafb;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:20px 24px;background:linear-gradient(135deg,#004359 0%,#0c5468 100%);color:#ffffff;">
        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;">BudgetBuddy</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px;">Daily pacing digest</div>
        <div style="font-size:13px;opacity:0.9;margin-top:4px;">
          {total_processed} campaign{'s' if total_processed != 1 else ''} processed ·
          <strong>{total_off_pace}</strong> need adjusting
        </div>
      </td></tr>
      <tr><td style="padding:0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <thead>
            <tr style="background:#fafbfb;">
              <th style="text-align:left;padding:8px 12px;font-size:10px;letter-spacing:0.04em;color:#6b7280;text-transform:uppercase;border-bottom:1px solid #eef0f2;">Campaign / Ad set</th>
              <th style="text-align:right;padding:8px 12px;font-size:10px;letter-spacing:0.04em;color:#6b7280;text-transform:uppercase;border-bottom:1px solid #eef0f2;">MTD</th>
              <th style="text-align:right;padding:8px 12px;font-size:10px;letter-spacing:0.04em;color:#6b7280;text-transform:uppercase;border-bottom:1px solid #eef0f2;">Expected</th>
              <th style="text-align:right;padding:8px 12px;font-size:10px;letter-spacing:0.04em;color:#6b7280;text-transform:uppercase;border-bottom:1px solid #eef0f2;">Current</th>
              <th style="text-align:right;padding:8px 12px;font-size:10px;letter-spacing:0.04em;color:#6b7280;text-transform:uppercase;border-bottom:1px solid #eef0f2;">Recommend</th>
              <th style="text-align:right;padding:8px 12px;font-size:10px;letter-spacing:0.04em;color:#6b7280;text-transform:uppercase;border-bottom:1px solid #eef0f2;">Change</th>
            </tr>
          </thead>
          <tbody>
            {''.join(rows_html)}
          </tbody>
        </table>
      </td></tr>
      <tr><td style="padding:18px 24px;background:#fafbfb;border-top:1px solid #eef0f2;font-size:12px;color:#6b7280;">
        Open BudgetBuddy to apply or skip these recommendations. You're receiving this because Daily Digest
        is enabled on at least one of your accounts. Disable it under
        <strong>Settings → Pacing Parameters → Email me a daily pacing digest</strong>.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""

    return subject, html_body, text_body
