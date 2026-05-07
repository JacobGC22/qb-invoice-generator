
const data = { client: null, rental: null, hq: null, ads: null, qb: null, config: null };
let lastCSV = null;

try {
  (function autofill() {
    const now = new Date();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const yr = String(prevMonth.getFullYear()).slice(2);
    document.getElementById('month').value = monthNames[prevMonth.getMonth()] + " '" + yr;
    const invDate = (now.getMonth()+1) + '/' + now.getDate() + '/' + now.getFullYear();
    document.getElementById('invDate').value = invDate;
    const due = new Date(now);
    due.setDate(due.getDate() + 5);
    const dueDate = (due.getMonth()+1) + '/' + due.getDate() + '/' + due.getFullYear();
    document.getElementById('dueDate').value = dueDate;
    document.getElementById('terms').value = 'Net 5';
  })();
} catch(e) {}

document.getElementById('genBtn').addEventListener('click', function() { generate(); });
document.getElementById('copyBtn').addEventListener('click', function() { copyCSV(); });

function loadFile(key, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    data[key] = e.target.result;
    document.getElementById('name-' + key).textContent = file.name;
    document.getElementById('box-' + key).classList.add('loaded');
    document.getElementById('lbl-' + key).classList.add('loaded');
    if (key === 'qb') detectInvoiceNumber(e.target.result);
    checkReady();
  };
  reader.onerror = e => {
    alert('Error reading file ' + key + ': ' + e.target.error);
  };
  reader.readAsText(file);
}

function detectInvoiceNumber(text) {
  const lines = text.split('\n');
  let maxNum = 0;
  lines.forEach(line => {
    const cells = line.split(',');
    if (cells.length < 3) return;
    const raw = (cells[2] || '').replace(/"/g, '').trim();
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num > 0 && num < 100000 && num > maxNum) maxNum = num;
  });
  if (maxNum > 0) {
    const next = maxNum + 1;
    document.getElementById('invStart').value = next;
    const hint = document.getElementById('invHint');
    hint.textContent = 'Auto-detected: highest existing is ' + maxNum + ', starting at ' + next;
    hint.classList.add('detected');
  }
}

function checkReady() {
  const ready = !!(data.client && data.rental && data.hq && data.ads);
  const btn = document.getElementById('genBtn');
  btn.disabled = !ready;
  btn.style.opacity = ready ? '1' : '0.35';
  btn.style.cursor = ready ? 'pointer' : 'not-allowed';
  btn.style.pointerEvents = ready ? 'auto' : 'none';
  // Update status
  const missing = [];
  if (!data.client) missing.push('Client Billing');
  if (!data.rental) missing.push('Rental Billing');
  if (!data.hq) missing.push('HQ Services');
  if (!data.ads) missing.push('Ads Billing');
  const statusEl = document.getElementById('uploadStatus');
  if (statusEl) {
    if (ready) {
      statusEl.textContent = 'All required files loaded. Ready to generate.';
      statusEl.style.color = '#16a34a';
    } else {
      statusEl.textContent = 'Still needed: ' + missing.join(', ');
      statusEl.style.color = '#d97706';
    }
  }
}

function parseCSV(text) {
  const rows = [];
  let cur = '', inQ = false, cells = [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
    else if (c === '\n' && !inQ) {
      cells.push(cur.trim());
      if (cells.some(s => s !== '')) rows.push(cells);
      cells = []; cur = '';
    } else if (c === '\n' && inQ) { cur += ' '; }
    else { cur += c; }
  }
  if (cur.trim() || cells.length) { cells.push(cur.trim()); if (cells.some(s => s !== '')) rows.push(cells); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.replace(/^\uFEFF/, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = (r[i] || '').trim());
    return obj;
  });
}

function parseMoney(s) {
  if (!s) return 0;
  return parseFloat(s.replace(/[$,]/g, '')) || 0;
}

function formatMoney(n) {
  return '$' + Math.abs(n).toFixed(2);
}

function normName(s) {
  return (s || '').toLowerCase().trim();
}

function stripAccents(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Section-based log builder
const logSections = {};
const logOrder = [];

function logSection(key, type, icon, title) {
  if (!logSections[key]) {
    logSections[key] = { type, icon, title, rows: [] };
    logOrder.push(key);
  }
}

function logMsg(msg, type, section) {
  const sec = section || type || 'info';
  if (!logSections[sec]) {
    const defaults = {
      ok: { type: 'info', icon: '✓', title: 'Summary' },
      warn: { type: 'warn', icon: '⚠', title: 'Warnings' },
      err: { type: 'err', icon: '✕', title: 'Errors' },
      action: { type: 'action', icon: '◎', title: 'Manual Actions Required in QB' },
      'flag-over': { type: 'flag-over', icon: '▲', title: 'Invoice Exceeds Amount Raised' },
      'flag-close': { type: 'flag-close', icon: '◉', title: 'Invoice Within 5% of Amount Raised' },
      summary: { type: 'summary', icon: '≡', title: 'Revenue Summary' },
      info: { type: 'info', icon: '·', title: 'Info' },
    };
    const d = defaults[sec] || defaults.info;
    logSection(sec, d.type, d.icon, d.title);
  }
  logSections[sec].rows.push(msg);
}

function renderLog() {
  const el = document.getElementById('log');
  el.classList.add('show');
  el.innerHTML = logOrder.map(key => {
    const s = logSections[key];
    const rows = s.rows.map(r => '<div class="log-row">' + r + '</div>').join('');
    return '<div class="log-section section-' + s.type + '"><div class="log-section-header"><span>' + s.icon + '</span>' + s.title + '</div><div class="log-section-body">' + rows + '</div></div>';
  }).join('');
}

function clearLog() {
  const el = document.getElementById('log');
  el.innerHTML = '';
  el.classList.remove('show');
  Object.keys(logSections).forEach(k => delete logSections[k]);
  logOrder.length = 0;
}

function commissionProductName(pct) {
  const map = { 5: "5% of previous month's online fundraising", 9: "9% of previous month fundraising", 10: "10% of previous month's online fundraising", 12: "12% of previous month's online fundraising", 14: "14% of previous month's fundraising", 15: "15% of previous month's online fundraising", 25: "25% of previous month's online fundraising" };
  return map[Math.round(pct * 100)] || (Math.round(pct * 100) + "% of previous month's online fundraising");
}

function commissionDescription(pct) {
  const map = { 5: "5% of Email, SMS, and Direct-to-Donate Gross Fundraising", 9: "15% of Email, SMS, and Direct-to-Donate Gross Fundraising", 10: "10% of Email, SMS, and Direct-to-Donate Gross Fundraising", 12: "12% of Email, SMS, and Direct-to-Donate Gross Fundraising", 14: "14% of Email, SMS, and Direct-to-Donate Gross Fundraising", 15: "15% of Email, SMS, and Direct-to-Donate Gross Fundraising", 25: "25% of Email, SMS, and Direct-to-Donate Gross Fundraising" };
  return map[Math.round(pct * 100)] || (Math.round(pct * 100) + "% of Email, SMS, and Direct-to-Donate Gross Fundraising");
}

function hqProductName(product) {
  const p = (product || '').toLowerCase().trim();
  if (p === 'cell append') return 'Cell Append - HQ';
  if (p === 'email verification') return 'Email Verification - HQ';
  if (p === 'rental') return 'Text Rental - HQ';
  if (p === 'email append') return 'Email Append - HQ';
  if (p === 'cell and email append') return 'Cell and Email Append - HQ';
  if (p === 'model') return 'Model - HQ';
  return product;
}

function csvRow(arr) {
  return arr.map(v => {
    const s = String(v == null ? '' : v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

function copyCSV() {
  if (!lastCSV) return;
  navigator.clipboard.writeText(lastCSV).then(() => {
    logMsg('Copied to clipboard. Open a text editor, paste, and save as .csv', 'ok', 'ok');
  }).catch(() => { logMsg('Clipboard copy failed.', 'err', 'err'); });
}

function buildCommissionLines(totalRaised, rentalRaised, defaultPct, defaultBillings, flatFee, config) {
  const lines = [];
  if (!config) {
    if (defaultPct > 0) {
      const commAmt = defaultBillings - flatFee;
      lines.push({ product: commissionProductName(defaultPct), desc: commissionDescription(defaultPct), qty: formatMoney(totalRaised), rate: defaultPct, amount: formatMoney(commAmt) });
    }
    return lines;
  }

  const tier1Rate = parseFloat(config.Tier1Rate) || 0;
  const tier1Cap = parseMoney(config.Tier1Cap);
  const tier2Rate = parseFloat(config.Tier2Rate) || 0;
  const excludeRental = (config.ExcludeRentalRaised || '').toLowerCase() === 'yes';
  const thresholdIsFlatFee = (config.ThresholdIsFlatFee || '').toLowerCase() === 'yes';
  const commissionThreshold = parseMoney(config.CommissionThreshold);

  if (tier1Rate === 0) return lines;

  // Base raised amount, optionally excluding rental
  let commissionableRaised = totalRaised;
  if (excludeRental) commissionableRaised = Math.max(0, totalRaised - rentalRaised);

  // Apply commission threshold if set
  const threshold = thresholdIsFlatFee ? flatFee : commissionThreshold;
  if (threshold > 0) commissionableRaised = Math.max(0, commissionableRaised - threshold);

  if (tier1Cap > 0 && tier2Rate > 0) {
    const tier1Amount = Math.min(commissionableRaised, tier1Cap) * tier1Rate;
    if (tier1Amount > 0) {
      const tier1Base = Math.min(commissionableRaised, tier1Cap);
      lines.push({ product: commissionProductName(tier1Rate), desc: commissionDescription(tier1Rate), qty: formatMoney(tier1Base), rate: tier1Rate, amount: formatMoney(tier1Amount) });
    }
    const tier2Base = Math.max(0, commissionableRaised - tier1Cap);
    const tier2Amount = tier2Base * tier2Rate;
    if (tier2Amount > 0) {
      lines.push({ product: commissionProductName(tier2Rate), desc: commissionDescription(tier2Rate), qty: formatMoney(tier2Base), rate: tier2Rate, amount: formatMoney(tier2Amount) });
    }
  } else {
    const amount = commissionableRaised * tier1Rate;
    if (amount > 0) {
      lines.push({ product: commissionProductName(tier1Rate), desc: commissionDescription(tier1Rate), qty: formatMoney(commissionableRaised), rate: tier1Rate, amount: formatMoney(amount) });
    }
  }
  return lines;
}

function generate() {
  alert('STEP 1: Generate clicked');
  try {
    generateInner();
  } catch(e) {
    alert('FATAL ERROR: ' + e.message + ' stack: ' + e.stack);
    console.error(e);
  }
}

function generateInner() {
  alert('STEP 2: generateInner started');
  clearLog();
  lastCSV = null;
  document.getElementById('copyBtn').style.display = 'none';

  const month = document.getElementById('month').value.trim().replace(/[‘’]/g, "'");
  const invStart = parseInt(document.getElementById('invStart').value.trim());
  const invDate = document.getElementById('invDate').value.trim();
  const dueDate = document.getElementById('dueDate').value.trim();
  const terms = document.getElementById('terms').value.trim() || 'Net 5';
  const memo = 'This is your fundraising services invoice.';

  if (!month) { logMsg('Please enter a billing month.', 'err'); return; }
  if (!invStart || isNaN(invStart)) { logMsg('Please enter a starting invoice number.', 'err'); return; }
  if (!invDate || !dueDate) { logMsg('Please enter invoice and due dates.', 'err'); return; }

  // Validate month format e.g. "April '26"
  const validMonths = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthParts = month.match(/^([a-zA-Z]+)\s+['‘’](\d{2})$/);
  if (!monthParts || !validMonths.includes(monthParts[1].toLowerCase())) {
    logMsg('Month format looks wrong: "' + month + '". Expected format like "April \'26". Fix before continuing.', 'err');
    return;
  }

  // Validate dates — must be M/D/YYYY or MM/DD/YYYY with plausible year
  function validateDate(val, label) {
    const parts = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!parts) { logMsg(label + ' is not a valid date: "' + val + '". Use MM/DD/YYYY format.', 'err'); return false; }
    const y = parseInt(parts[3]);
    if (y < 2020 || y > 2035) { logMsg(label + ' has an implausible year: ' + y + '. Check the date.', 'err'); return false; }
    return true;
  }
  if (!validateDate(invDate, 'Invoice date')) return;
  if (!validateDate(dueDate, 'Due date')) return;

  // Warn (but don't block) on unusual terms
  const termsVal = document.getElementById('terms').value.trim() || 'Net 5';
  if (!/^net\s*\d+$/i.test(termsVal)) {
    logMsg('Terms "' + termsVal + '" doesn\'t look like a standard Net term (e.g. "Net 5"). Continuing anyway.', 'warn');
  }

  // Parse config into a map keyed by normalized client name
  const configMap = {};
  if (data.config) {
    parseCSV(data.config).forEach(r => {
      const name = normName(r['Client']);
      if (name) configMap[name] = r;
    });
  }

  const clientData = parseCSV(data.client);
  const filtered = clientData.filter(r => (r['Month'] || '').trim() === month.trim());
  alert('STEP 4: clientData rows=' + clientData.length + ' filtered=' + filtered.length + ' first month=[' + (clientData[0] ? Object.values(clientData[0])[7] : 'none') + ']');
  if (!filtered.length) { logMsg('No rows found for "' + month + '" in Client Billing Archive. Check the month format.', 'err'); renderLog(); return; }

  // Duplicate client detection in Client Billing Archive for this month
  const clientNameCount = {};
  filtered.forEach(r => {
    const n = (r['f'] || '').trim();
    if (n) clientNameCount[n] = (clientNameCount[n] || 0) + 1;
  });
  const duplicates = Object.entries(clientNameCount).filter(([,c]) => c > 1).map(([n]) => n);
  if (duplicates.length) {
    logMsg('Duplicate clients in Client Billing Archive for ' + month + ' — fix before continuing: ' + duplicates.join(', '), 'err', 'err');
    return;
  }

  const rentalData = parseCSV(data.rental).filter(r => (r['Month/Year'] || '').trim() === month.trim());
  const hqData = parseCSV(data.hq).filter(r => (r['Month'] || '').trim() === month.trim());
  const adsData = parseCSV(data.ads).filter(r => (r['Month'] || '').trim() === month.trim());

  logMsg('Found ' + filtered.length + ' client rows, ' + rentalData.length + ' rental rows, ' + hqData.length + ' HQ rows, ' + adsData.length + ' ads rows for ' + month + '.', 'info', 'ok');

  const clientNames = new Set(filtered.map(r => normName(r['f'])).filter(Boolean));

  // Rental — case-insensitive
  const rentalByClient = {};
  const rentalAllClients = new Set();
  const rentalMissingAmount = new Set();
  const rentalFirstDate = {};
  rentalData.forEach(r => {
    const client = normName(r['Client']);
    if (!client) return;
    rentalAllClients.add(client);
    const product = (r['Product'] || '').trim();
    const dayDelivered = (r['Day Delivered'] || '').trim();
    if (dayDelivered && !rentalFirstDate[client]) rentalFirstDate[client] = dayDelivered;
    let rawVal = '';
    let amount = 0;
    Object.keys(r).forEach(k => { if (k.includes('Cost to Client')) { rawVal = r[k]; const v = parseMoney(r[k]); if (v) amount = v; } });
    if (rawVal === '' || rawVal === undefined) { rentalMissingAmount.add((r['Client'] || '').trim()); return; }
    if (amount === 0) return;
    if (!rentalByClient[client]) rentalByClient[client] = { texting: 0, email: 0 };
    if (product === 'Email List Rental') rentalByClient[client].email += amount;
    else rentalByClient[client].texting += amount;
  });

  // HQ — case-insensitive
  const hqByClient = {};
  const hqAllClients = new Set();
  const hqMissingAmount = new Set();
  const hqSeenProductDate = {}; // track first date per client+product
  hqData.forEach(r => {
    const client = normName(r['Client']);
    if (!client) return;
    hqAllClients.add(client);
    const product = (r['Product'] || '').trim();
    const dayDelivered = (r['Day Delivered'] || '').trim();
    const rawCostToClient = r['Cost to Client'];
    if (rawCostToClient === '' || rawCostToClient === undefined) { hqMissingAmount.add((r['Client'] || '').trim()); return; }
    const costToClient = parseMoney(rawCostToClient || '0');
    if (costToClient === 0) return;
    if (!hqByClient[client]) hqByClient[client] = [];
    let billRate = 0;
    Object.keys(r).forEach(k => { if (k.includes('Bill/Record')) { const v = parseMoney(r[k]); if (v) billRate = v; } });
    if (!billRate) billRate = 0.10;

    const getHQDate = (productKey) => {
      const key = client + '||' + productKey;
      if (!hqSeenProductDate[key]) hqSeenProductDate[key] = dayDelivered || '';
      return hqSeenProductDate[key];
    };

    if (product === 'Combined Record Acquisition') {
      const emails = parseFloat((r['Emails'] || '0').replace(/,/g, '')) || 0;
      const cells = parseFloat((r['Cells'] || '0').replace(/,/g, '')) || 0;
      if (emails > 0 && cells > 0) {
        const emailAmt = parseFloat((emails * billRate).toFixed(2));
        const cellAmt = parseFloat((costToClient - emailAmt).toFixed(2));
        hqByClient[client].push({ product: 'Email Data Acquisition - HQ', qty: emails, rate: billRate, amount: emailAmt, desc: 'Purchase of emails', date: getHQDate('Email Data Acquisition - HQ') });
        hqByClient[client].push({ product: 'Cell Data Acquisition - HQ', qty: cells, rate: billRate, amount: cellAmt, desc: 'Purchase of cells', date: getHQDate('Cell Data Acquisition - HQ') });
      } else if (emails > 0) {
        hqByClient[client].push({ product: 'Email Data Acquisition - HQ', qty: emails, rate: billRate, amount: costToClient, desc: 'Purchase of emails', date: getHQDate('Email Data Acquisition - HQ') });
      } else if (cells > 0) {
        hqByClient[client].push({ product: 'Cell Data Acquisition - HQ', qty: cells, rate: billRate, amount: costToClient, desc: 'Purchase of cells', date: getHQDate('Cell Data Acquisition - HQ') });
      }
    } else {
      const emails = parseFloat((r['Emails'] || '0').replace(/,/g, '')) || 0;
      const cells = parseFloat((r['Cells'] || '0').replace(/,/g, '')) || 0;
      const qty = emails + cells || 1;
      const productKey = hqProductName(product);
      hqByClient[client].push({ product: productKey, qty, rate: billRate, amount: costToClient, desc: '', date: getHQDate(productKey) });
    }
  });

  // Ads — case-insensitive
  const adsByClient = {};
  const adsAllClients = new Set();
  const adsMissingAmount = new Set();
  const adsFirstDate = {};
  adsData.forEach(r => {
    const client = normName(r['Client']);
    if (!client) return;
    adsAllClients.add(client);
    const dateVal = (r['Date'] || '').trim();
    if (dateVal && !adsFirstDate[client]) adsFirstDate[client] = dateVal;
    const rawAmt = r['Billing Amount '] !== undefined ? r['Billing Amount '] : r['Billing Amount'];
    if (rawAmt === '' || rawAmt === undefined) { adsMissingAmount.add((r['Client'] || '').trim()); return; }
    const amount = parseMoney(rawAmt || '0');
    if (amount === 0) return;
    adsByClient[client] = (adsByClient[client] || 0) + amount;
  });

  // Build set of all clients ever seen in Client Billing Archive (any month)
  const allHistoricalClients = new Set(parseCSV(data.client).map(r => normName(r['f'])).filter(Boolean));

  // Deduplicated unmatched warnings grouped by client, suppressing historical clients
  const unmatchedMap = {};
  const addUnmatched = (client, sheet) => {
    if (clientNames.has(client)) return;
    if (allHistoricalClients.has(client)) return; // suppress — known historical client (Neil's)
    if (!unmatchedMap[client]) unmatchedMap[client] = [];
    if (!unmatchedMap[client].includes(sheet)) unmatchedMap[client].push(sheet);
  };
  [...rentalAllClients].forEach(c => addUnmatched(c, 'Rental'));
  [...hqAllClients].forEach(c => addUnmatched(c, 'HQ'));
  [...adsAllClients].forEach(c => addUnmatched(c, 'Ads'));

  const unmatchedEntries = Object.entries(unmatchedMap);
  if (unmatchedEntries.length) {
    logMsg('Clients on other sheets but not on this invoice run (possible typo):', 'warn', 'warn');
    unmatchedEntries.forEach(([client, sheets]) => logMsg(client + ' (' + sheets.join(', ') + ')', 'warn', 'warn'));
  }

  // Missing billing amount warnings
  const missingAmountMap = {};
  const addMissing = (client, sheet) => {
    if (!missingAmountMap[client]) missingAmountMap[client] = [];
    if (!missingAmountMap[client].includes(sheet)) missingAmountMap[client].push(sheet);
  };
  [...rentalMissingAmount].forEach(c => addMissing(c, 'Rental'));
  [...hqMissingAmount].forEach(c => addMissing(c, 'HQ'));
  [...adsMissingAmount].forEach(c => addMissing(c, 'Ads'));
  const missingEntries = Object.entries(missingAmountMap);
  if (missingEntries.length) {
    logMsg('Missing billing amounts — check before sending:', 'err', 'err');
    missingEntries.forEach(([client, sheets]) => logMsg(client + ' (' + sheets.join(', ') + ') — billing amount is blank', 'err', 'err'));
  }

  const headers = ['*InvoiceNo', '*Customer', '*InvoiceDate', '*DueDate', 'Terms', 'Location', 'Memo', 'Item(Product/Service)', 'ItemDescription', 'ItemQuantity', 'ItemRate', '*ItemAmount', 'Service Date'];
  const outputRows = [headers];
  let invoiceNum = invStart;
  let clientCount = 0;
  const manualActions = [];

  filtered.forEach(r => {
    const customer = (r['f'] || '').trim();
    if (!customer) return;
    const customerNorm = normName(customer);

    const flatFee = parseMoney(r['Flat Fee'] || '0');
    const pctRaw = (r['%'] || '').trim();
    let defaultPct = 0;
    if (pctRaw !== '0%' && pctRaw !== '0' && pctRaw !== '') {
      let p = parseFloat(pctRaw) || 0.15;
      if (p > 1) p = p / 100;
      defaultPct = p;
    }
    const billings = parseMoney(r['Billings'] || '0');
    const totalRaised = parseMoney(r['Total Raised'] || '0');
    const rentalRaised = parseMoney(r['Rental Raised'] || '0');

    const config = configMap[customerNorm] || null;

    // Check manual action flags
    if (config) {
      if ((config.NeedsCreditCard || '').toLowerCase() === 'yes') manualActions.push(customer + ': enable credit card feature in QB');
      if ((config.NeedsTextingCost || '').toLowerCase() === 'yes') manualActions.push(customer + ': add texting cost line item manually in QB');
    }

    const clientTerms = (config && config.Terms && config.Terms.trim()) ? config.Terms.trim() : terms;
    const customerOut = stripAccents(customer);

    // Service date for commission/fee = 1st of previous month
    const invDateObj = new Date(invDate);
    const prevMonthFirst = new Date(invDateObj.getFullYear(), invDateObj.getMonth() - 1, 1);
    const prevMonthFirstStr = (prevMonthFirst.getMonth()+1) + '/1/' + prevMonthFirst.getFullYear();

    const addLine = (product, desc, qty, rate, amount, serviceDate) => {
      outputRows.push([invoiceNum, customerOut, invDate, dueDate, clientTerms, '', memo, product, desc, qty, rate, amount, serviceDate || invDate]);
    };

    // Commission lines
    const commLines = buildCommissionLines(totalRaised, rentalRaised, defaultPct, billings, flatFee, config);
    commLines.forEach(cl => addLine(cl.product, cl.desc, cl.qty, cl.rate, cl.amount, prevMonthFirstStr));

    // Monthly fee
    addLine('Monthly Fee', 'Monthly fee for creation and analysis of direct-to-donate ads, fundraising emails, text messages and general fundraising consulting services.', 1, formatMoney(flatFee), formatMoney(flatFee), prevMonthFirstStr);

    // Rental
    const rental = rentalByClient[customerNorm];
    if (rental) {
      const rentalDate = rentalFirstDate[customerNorm] || invDate;
      if (rental.texting > 0) addLine('Texting List Rental', 'One-time texting list rental', 1, formatMoney(rental.texting), formatMoney(rental.texting), rentalDate);
      if (rental.email > 0) addLine('Email Rental Opt-in', 'One-time email rental, pay per opt-in', 1, formatMoney(rental.email), formatMoney(rental.email), rentalDate);
    }

    // HQ
    const hqLines = hqByClient[customerNorm];
    if (hqLines && hqLines.length) hqLines.forEach(hl => addLine(hl.product, hl.desc, hl.qty, hl.rate, formatMoney(hl.amount), hl.date || invDate));

    // Ads
    const adAmt = adsByClient[customerNorm];
    const adDate = adsFirstDate[customerNorm] || invDate;
    if (adAmt) addLine('Direct-to-Donate Ad Buy', 'Cost of Direct-to-Donate Ads', 1, formatMoney(adAmt), formatMoney(adAmt), adDate);

    invoiceNum++;
    clientCount++;
  });

  logMsg('Generated ' + clientCount + ' invoices (numbers ' + invStart + ' through ' + (invoiceNum - 1) + ').', 'ok', 'ok');

  // Summary by sheet
  let totalCommission = 0, totalFees = 0, totalRentalOut = 0, totalHQOut = 0, totalAdsOut = 0;
  filtered.forEach(r => {
    const pctRaw2 = (r['%'] || '').trim();
    let pct2 = (pctRaw2 === '0%' || pctRaw2 === '0' || pctRaw2 === '') ? 0 : (parseFloat(pctRaw2) || 0.15);
    if (pct2 > 1) pct2 = pct2 / 100;
    const billings2 = parseMoney(r['Billings'] || '0');
    const flatFee2 = parseMoney(r['Flat Fee'] || '0');
    const customerNorm2 = normName((r['f'] || '').trim());
    const config2 = configMap[customerNorm2] || null;
    if (config2) {
      const t1r = parseFloat(config2.Tier1Rate) || 0;
      const t1c = parseMoney(config2.Tier1Cap);
      const t2r = parseFloat(config2.Tier2Rate) || 0;
      const excl = (config2.ExcludeRentalRaised || '').toLowerCase() === 'yes';
      const tr2 = parseMoney(r['Total Raised'] || '0');
      const rr2 = parseMoney(r['Rental Raised'] || '0');
      let commBase = excl ? Math.max(0, tr2 - rr2) : tr2;
      if (t1c > 0 && t2r > 0) {
        totalCommission += Math.min(commBase, t1c) * t1r + Math.max(0, commBase - t1c) * t2r;
      } else {
        totalCommission += commBase * t1r;
      }
    } else if (pct2 > 0) {
      totalCommission += billings2 - flatFee2;
    }
    totalFees += flatFee2;
  });
  // Only sum amounts for clients who actually made it onto invoices
  clientNames.forEach(cn => {
    const rv = rentalByClient[cn];
    if (rv) totalRentalOut += rv.texting + rv.email;
    const hv = hqByClient[cn];
    if (hv) hv.forEach(l => { totalHQOut += l.amount; });
    const av = adsByClient[cn];
    if (av) totalAdsOut += av;
  });

  const matchedRentalClients = Object.keys(rentalByClient).filter(c => clientNames.has(c)).length;
  const matchedHQClients = Object.keys(hqByClient).filter(c => clientNames.has(c)).length;
  const matchedAdsClients = Object.keys(adsByClient).filter(c => clientNames.has(c)).length;

  const fmt = n => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const grandTotal = totalCommission + totalFees + totalRentalOut + totalHQOut + totalAdsOut;
  logSection('summary', 'summary', '≡', 'Revenue Summary — ' + month);
  logMsg('<div class="summary-grid"><div class="summary-item">Commission <span>' + fmt(totalCommission) + '</span></div><div class="summary-item">Monthly Fees <span>' + fmt(totalFees) + '</span></div><div class="summary-item">Rental (' + matchedRentalClients + ' clients) <span>' + fmt(totalRentalOut) + '</span></div><div class="summary-item">HQ Services (' + matchedHQClients + ' clients) <span>' + fmt(totalHQOut) + '</span></div><div class="summary-item">Ads (' + matchedAdsClients + ' clients) <span>' + fmt(totalAdsOut) + '</span></div><div class="summary-total"><span>Grand Total</span><span>' + fmt(grandTotal) + '</span></div></div>', 'summary', 'summary');

  if (manualActions.length) {
    
    manualActions.forEach(a => logMsg(a, 'action', 'action'));
  }

  // Flag clients whose Total Raised is within 5% of invoice total or lower
  // Use customer name as key for O(1) lookup
  const invoiceTotalsByCustomer = {};
  outputRows.slice(1).forEach(row => {
    const customerName = row[1];
    const amt = parseMoney(String(row[11]));
    if (customerName) invoiceTotalsByCustomer[customerName] = (invoiceTotalsByCustomer[customerName] || 0) + amt;
  });

  const flagOver = [];
  const flagClose = [];
  filtered.forEach(r => {
    const customer = (r['f'] || '').trim();
    if (!customer) return;
    const totalRaisedAmt = parseMoney(r['Total Raised'] || '0');
    const customerOut = stripAccents(customer);
    const invTotal = invoiceTotalsByCustomer[customerOut] || 0;
    if (!invTotal) return;
    const buffer = totalRaisedAmt * 0.05;
    if (invTotal >= totalRaisedAmt - buffer) {
      const diff = invTotal - totalRaisedAmt;
      if (diff >= 0) {
        flagOver.push({ name: customer, raised: totalRaisedAmt, invoiced: invTotal, diff });
      } else {
        flagClose.push({ name: customer, raised: totalRaisedAmt, invoiced: invTotal, diff });
      }
    }
  });

  flagOver.sort((a,b) => a.name.localeCompare(b.name));
  flagClose.sort((a,b) => a.name.localeCompare(b.name));

  if (flagOver.length) {
    flagOver.forEach(f => logMsg(f.name + ' — raised ' + fmt(f.raised) + ', invoiced ' + fmt(f.invoiced) + ' (' + fmt(f.diff) + ' over)', 'flag-over', 'flag-over'));
  }
  if (flagClose.length) {
    flagClose.forEach(f => logMsg(f.name + ' — raised ' + fmt(f.raised) + ', invoiced ' + fmt(f.invoiced) + ' (' + fmt(Math.abs(f.diff)) + ' under)', 'flag-close', 'flag-close'));
  }

  alert('STEP 5: About to render. sections=' + logOrder.length + ' outputRows=' + outputRows.length);
  try {
    renderLog();
  } catch(e) {
    document.getElementById('log').classList.add('show');
    document.getElementById('log').innerHTML = '<div style="color:red">Render error: ' + e.message + '</div>';
  }
  alert('STEP 6: Rendered. Generating CSV now.');

  const csvContent = outputRows.map(csvRow).join('\n');
  lastCSV = csvContent;

  const encoded = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
  const a = document.createElement('a');
  a.href = encoded;
  a.download = 'QB_Invoices_' + month.replace(/'/g, '').replace(/ /g, '_') + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  document.getElementById('copyBtn').style.display = 'block';
  alert('STEP 7: Done. ' + outputRows.length + ' rows generated.');
  logMsg('If the file did not download, use "Copy CSV to clipboard" and paste into a text file saved as .csv', 'info', 'ok');
}
