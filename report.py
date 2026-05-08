"""
ActBlue Daily Report
--------------------
Reads each active client's "Raw Actblue Data" tab and sends a nightly
email summary to jacob@goodmancampaigns.com.

Metrics per client:
  - Yesterday's new contributions from our pages (non-recurring only)
  - Yesterday's rentals
  - Month-to-date from our pages vs same point last month
  - Month-to-date rentals vs same point last month
  - Estimated commission this month (Tier1/Tier2/Flat/Exclusion logic)
  - Estimated flat fee this month (sends x rates)
  - Estimated total invoice so far this month

Clients sorted by: rental activity yesterday → page activity yesterday → everyone else

Mapping sheet columns used:
  keyword, sheet_id, active,
  Tier1Rate, Tier1Cap, Tier2Rate, ExcludeRentalRaised,
  EmailRate, TextRate, EmailsSentThisMonth, TextsSentThisMonth

Environment variables:
  MAPPING_SHEET_ID  — Google Sheet ID of your mapping sheet
  GOOGLE_CREDS_JSON — Service account credentials JSON string
  RESEND_API_KEY    — Resend API key
"""

import os
import json
import requests
import gspread
import pandas as pd
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
from google.oauth2.service_account import Credentials

# ── Configuration ─────────────────────────────────────────────────────────────

MAPPING_SHEET_ID  = os.environ.get("MAPPING_SHEET_ID", "YOUR_MAPPING_SHEET_ID_HERE")
RESEND_API_KEY    = os.environ.get("RESEND_API_KEY", "")
REPORT_TO         = "jacob@goodmancampaigns.com"
REPORT_FROM       = "onboarding@resend.dev"
MOUNTAIN_TZ       = ZoneInfo("America/Denver")
RAW_DATA_TAB      = "Raw Actblue Data"

OUR_PAGE_TAGS     = ["-email", "-text", "-rtext", "-ads"]
RENTAL_TAG        = "-rtext"

# ── Google Auth ───────────────────────────────────────────────────────────────

def get_gspread_client():
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.readonly",
    ]
    creds_json = os.environ.get("GOOGLE_CREDS_JSON")
    if creds_json:
        creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=scopes)
    else:
        creds = Credentials.from_service_account_file("google_creds.json", scopes=scopes)
    return gspread.authorize(creds)

# ── Load Clients ──────────────────────────────────────────────────────────────

def load_clients(gc):
    sh = gc.open_by_key(MAPPING_SHEET_ID)
    records = sh.sheet1.get_all_records()
    clients = []
    for row in records:
        if str(row.get("active", "")).strip().upper() != "TRUE":
            continue
        clients.append({
            "keyword":              row.get("keyword", ""),
            "sheet_id":             row.get("sheet_id", ""),
            "tier1_rate":           float(row.get("Tier1Rate", 0) or 0),
            "tier1_cap":            float(row.get("Tier1Cap", 0) or 0),
            "tier2_rate":           float(row.get("Tier2Rate", 0) or 0),
            "exclude_rental":       str(row.get("ExcludeRentalRaised", "")).strip().upper() == "TRUE",
            "email_rate":           float(row.get("EmailRate", 0) or 0),
            "text_rate":            float(row.get("TextRate", 0) or 0),
            "emails_sent":          float(row.get("EmailsSentThisMonth", 0) or 0),
            "texts_sent":           float(row.get("TextsSentThisMonth", 0) or 0),
        })
    return clients

# ── Load Client Data ──────────────────────────────────────────────────────────

def load_client_df(gc, sheet_id):
    """Load Raw Actblue Data tab into a cleaned DataFrame."""
    sh = gc.open_by_key(sheet_id)
    ws = sh.worksheet(RAW_DATA_TAB)
    data = ws.get_all_values()
    if len(data) < 2:
        return pd.DataFrame()

    df = pd.DataFrame(data[1:], columns=data[0])
    df["Amount"] = pd.to_numeric(df["Amount"], errors="coerce").fillna(0)
    df["Date"]   = pd.to_datetime(df["Date"], errors="coerce")
    df["Recurrence Number"] = pd.to_numeric(df["Recurrence Number"], errors="coerce").fillna(1)
    return df

# ── Date Helpers ──────────────────────────────────────────────────────────────

def get_date_context():
    """
    Returns key dates for filtering.
    ActBlue day runs 10:01 PM MT → 10:00 PM MT.
    'Yesterday' in ActBlue terms = the calendar day that just completed.
    """
    now_mt    = datetime.now(MOUNTAIN_TZ)
    today     = now_mt.date()
    yesterday = today - timedelta(days=1)

    # Month-to-date: current month
    mtd_start = today.replace(day=1)
    mtd_end   = today

    # Same point last month
    last_month_same_day = (today.replace(day=1) - timedelta(days=1)).replace(day=min(today.day, 28))
    last_month_start    = last_month_same_day.replace(day=1)

    return {
        "yesterday":           yesterday,
        "today":               today,
        "mtd_start":           mtd_start,
        "mtd_end":             mtd_end,
        "last_month_start":    last_month_start,
        "last_month_same_day": last_month_same_day,
    }

# ── Filtering Helpers ─────────────────────────────────────────────────────────

def is_our_page(series):
    return series.astype(str).apply(lambda x: any(tag in x for tag in OUR_PAGE_TAGS))

def is_rental(series):
    return series.astype(str).str.contains(RENTAL_TAG, na=False)

def is_new(df):
    """Non-recurring: Recurrence Number == 1"""
    return df["Recurrence Number"] == 1

def filter_date_range(df, start, end):
    mask = (df["Date"].dt.date >= start) & (df["Date"].dt.date <= end)
    return df[mask]

# ── Commission Calculator ─────────────────────────────────────────────────────

def calculate_commission(mtd_commissionable, client):
    """
    Normal:    all commissionable × Tier1Rate
    Cap:       first Tier1Cap × Tier1Rate, remainder × Tier2Rate
    Flat:      Tier1Rate == 0, no commission
    Exclusion: handled before this call (rentals already excluded from commissionable)
    """
    rate1 = client["tier1_rate"]
    cap   = client["tier1_cap"]
    rate2 = client["tier2_rate"]

    if rate1 == 0:
        return 0.0

    if cap > 0 and rate2 > 0:
        # Cap setup
        below_cap = min(mtd_commissionable, cap)
        above_cap = max(mtd_commissionable - cap, 0)
        return (below_cap * rate1) + (above_cap * rate2)

    return mtd_commissionable * rate1

# ── Per-Client Metrics ────────────────────────────────────────────────────────

def compute_metrics(df, client, dates):
    if df.empty:
        return None

    our_page_mask = is_our_page(df["Fundraiser Recipient ID"])
    rental_mask   = is_rental(df["Fundraiser Recipient ID"])
    new_mask      = is_new(df)

    # ── Yesterday ────────────────────────────────────────────────────────────
    yest = filter_date_range(df, dates["yesterday"], dates["yesterday"])
    yest_our   = yest[our_page_mask.reindex(yest.index, fill_value=False) & new_mask.reindex(yest.index, fill_value=False)]
    yest_rental = yest[rental_mask.reindex(yest.index, fill_value=False) & new_mask.reindex(yest.index, fill_value=False)]

    yest_page_count  = len(yest_our[~rental_mask.reindex(yest_our.index, fill_value=False)])
    yest_page_amt    = yest_our[~rental_mask.reindex(yest_our.index, fill_value=False)]["Amount"].sum()
    yest_rental_count = len(yest_rental)
    yest_rental_amt   = yest_rental["Amount"].sum()

    # ── Month-to-date (current month) ────────────────────────────────────────
    mtd = filter_date_range(df, dates["mtd_start"], dates["mtd_end"])
    mtd_our    = mtd[our_page_mask.reindex(mtd.index, fill_value=False) & new_mask.reindex(mtd.index, fill_value=False)]
    mtd_rental = mtd[rental_mask.reindex(mtd.index, fill_value=False) & new_mask.reindex(mtd.index, fill_value=False)]

    mtd_page_amt   = mtd_our[~rental_mask.reindex(mtd_our.index, fill_value=False)]["Amount"].sum()
    mtd_rental_amt = mtd_rental["Amount"].sum()

    # ── Same point last month ─────────────────────────────────────────────────
    lm = filter_date_range(df, dates["last_month_start"], dates["last_month_same_day"])
    lm_our    = lm[our_page_mask.reindex(lm.index, fill_value=False) & new_mask.reindex(lm.index, fill_value=False)]
    lm_rental = lm[rental_mask.reindex(lm.index, fill_value=False) & new_mask.reindex(lm.index, fill_value=False)]

    lm_page_amt   = lm_our[~rental_mask.reindex(lm_our.index, fill_value=False)]["Amount"].sum()
    lm_rental_amt = lm_rental["Amount"].sum()

    # ── Commission ────────────────────────────────────────────────────────────
    if client["exclude_rental"]:
        commissionable = mtd_page_amt  # Rentals excluded
    else:
        commissionable = mtd_page_amt + mtd_rental_amt

    estimated_commission = calculate_commission(commissionable, client)

    # ── Flat fee ──────────────────────────────────────────────────────────────
    flat_fee = (client["emails_sent"] * client["email_rate"]) + \
               (client["texts_sent"] * client["text_rate"])

    # ── Total invoice estimate ────────────────────────────────────────────────
    estimated_invoice = estimated_commission + flat_fee

    return {
        "keyword":              client["keyword"],
        "yest_page_count":      yest_page_count,
        "yest_page_amt":        yest_page_amt,
        "yest_rental_count":    yest_rental_count,
        "yest_rental_amt":      yest_rental_amt,
        "mtd_page_amt":         mtd_page_amt,
        "lm_page_amt":          lm_page_amt,
        "mtd_rental_amt":       mtd_rental_amt,
        "lm_rental_amt":        lm_rental_amt,
        "estimated_commission": estimated_commission,
        "flat_fee":             flat_fee,
        "estimated_invoice":    estimated_invoice,
        "tier1_rate":           client["tier1_rate"],
        "exclude_rental":       client["exclude_rental"],
    }

# ── Email Builder ─────────────────────────────────────────────────────────────

def fmt_currency(val):
    return f"${val:,.2f}"

def fmt_change(current, previous):
    if previous == 0:
        return "no prior data"
    change = ((current - previous) / previous) * 100
    arrow  = "▲" if change >= 0 else "▼"
    return f"{arrow} {abs(change):.1f}% vs last month"

def build_email(all_metrics, dates):
    today      = dates["today"]
    yesterday  = dates["yesterday"]
    is_early   = today.day <= 7

    lines = []

    # ── Header ────────────────────────────────────────────────────────────────
    lines.append(f"<h2>Daily Fundraising Report — {yesterday.strftime('%B %d, %Y')}</h2>")

    # ── Early month reminder ──────────────────────────────────────────────────
    if is_early:
        lines.append(
            f'<div style="background:#fff3cd;padding:12px;border-radius:6px;margin-bottom:16px;">'
            f'<strong>⚠ Reminder:</strong> It\'s day {today.day} of the month. '
            f'Please update <strong>EmailsSentThisMonth</strong> and <strong>TextsSentThisMonth</strong> '
            f'in your mapping sheet to keep invoice estimates accurate.'
            f'</div>'
        )

    # ── Sort clients ──────────────────────────────────────────────────────────
    # Priority: had rentals yesterday → had page contributions yesterday → everyone else
    def sort_key(m):
        if m["yest_rental_count"] > 0:
            return (0, -m["yest_rental_amt"])
        if m["yest_page_count"] > 0:
            return (1, -m["yest_page_amt"])
        return (2, 0)

    sorted_metrics = sorted(all_metrics, key=sort_key)

    # ── Per-client blocks ─────────────────────────────────────────────────────
    for m in sorted_metrics:
        has_activity = m["yest_page_count"] > 0 or m["yest_rental_count"] > 0
        bg = "#f0f7ff" if has_activity else "#fafafa"

        lines.append(f'<div style="background:{bg};border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:12px;">')
        lines.append(f'<h3 style="margin:0 0 8px 0;">{m["keyword"]}</h3>')

        # Yesterday
        lines.append('<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">')
        lines.append('<tr><td colspan="2"><strong>Yesterday</strong></td></tr>')

        if m["yest_page_count"] > 0:
            lines.append(f'<tr><td>Page contributions</td><td>{m["yest_page_count"]} donors / {fmt_currency(m["yest_page_amt"])}</td></tr>')
        else:
            lines.append(f'<tr><td>Page contributions</td><td style="color:#999;">None</td></tr>')

        if m["yest_rental_count"] > 0:
            lines.append(f'<tr><td>Rentals</td><td>{m["yest_rental_count"]} donors / {fmt_currency(m["yest_rental_amt"])}</td></tr>')
        else:
            lines.append(f'<tr><td>Rentals</td><td style="color:#999;">None</td></tr>')

        # Month-to-date
        lines.append('<tr><td colspan="2" style="padding-top:8px;"><strong>Month-to-date</strong></td></tr>')
        lines.append(f'<tr><td>Page contributions</td><td>{fmt_currency(m["mtd_page_amt"])} &nbsp;<span style="color:#666;font-size:0.9em;">{fmt_change(m["mtd_page_amt"], m["lm_page_amt"])}</span></td></tr>')
        lines.append(f'<tr><td>Rentals</td><td>{fmt_currency(m["mtd_rental_amt"])} &nbsp;<span style="color:#666;font-size:0.9em;">{fmt_change(m["mtd_rental_amt"], m["lm_rental_amt"])}</span></td></tr>')

        # Invoice estimate
        lines.append('<tr><td colspan="2" style="padding-top:8px;"><strong>Invoice estimate</strong></td></tr>')
        if m["tier1_rate"] > 0:
            lines.append(f'<tr><td>Commission</td><td>{fmt_currency(m["estimated_commission"])}</td></tr>')
        else:
            lines.append(f'<tr><td>Commission</td><td style="color:#999;">Flat client — no commission</td></tr>')
        lines.append(f'<tr><td>Flat fee (sends)</td><td>{fmt_currency(m["flat_fee"])}</td></tr>')
        lines.append(f'<tr><td><strong>Total estimate</strong></td><td><strong>{fmt_currency(m["estimated_invoice"])}</strong></td></tr>')

        lines.append('</table>')
        lines.append('</div>')

    # ── Footer ────────────────────────────────────────────────────────────────
    lines.append(f'<p style="color:#999;font-size:0.85em;">Generated {datetime.now(MOUNTAIN_TZ).strftime("%Y-%m-%d %I:%M %p MT")} · Commission estimates based on month-to-date page contributions · Flat fee based on send counts in mapping sheet</p>')

    return "\n".join(lines)

# ── Send Email ────────────────────────────────────────────────────────────────

def send_email(subject, html_body):
    resp = requests.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type":  "application/json",
        },
        json={
            "from":    REPORT_FROM,
            "to":      [REPORT_TO],
            "subject": subject,
            "html":    html_body,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"\nActBlue Daily Report — {datetime.now(MOUNTAIN_TZ).strftime('%Y-%m-%d %I:%M %p MT')}")
    print("=" * 55)

    dates = get_date_context()
    print(f"Reporting on: {dates['yesterday']}")
    print(f"MTD window:   {dates['mtd_start']} → {dates['mtd_end']}")
    print(f"Last month:   {dates['last_month_start']} → {dates['last_month_same_day']}\n")

    gc      = get_gspread_client()
    clients = load_clients(gc)
    print(f"Active clients: {len(clients)}\n")

    all_metrics = []
    errors      = []

    for client in clients:
        print(f"▶ {client['keyword']}")
        try:
            df = load_client_df(gc, client["sheet_id"])
            if df.empty:
                print(f"  ⚠ No data in sheet — skipping\n")
                continue
            metrics = compute_metrics(df, client, dates)
            if metrics:
                all_metrics.append(metrics)
                print(f"  ✓ Computed\n")
        except Exception as e:
            print(f"  ✗ Error: {e}\n")
            errors.append(client["keyword"])

    if not all_metrics:
        print("No metrics computed — skipping email.")
        return

    print("Building email...")
    html   = build_email(all_metrics, dates)
    subject = f"Fundraising Report — {dates['yesterday'].strftime('%b %d')}"
    if errors:
        subject += f" ({len(errors)} client error{'s' if len(errors) > 1 else ''})"

    print("Sending email...")
    result = send_email(subject, html)
    print(f"✓ Email sent: {result}\n")

    print("=" * 55)
    print(f"Report complete — {len(all_metrics)} clients included")
    if errors:
        print(f"⚠ Errors: {', '.join(errors)}")
    print("=" * 55)

if __name__ == "__main__":
    main()
