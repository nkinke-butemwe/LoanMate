const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const packageJson = require('./package.json');

let mainWindow;
let db;

function getSafeName(rawName) {
  return rawName.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function ensureProjectFolder() {
  const safeName = getSafeName(packageJson.name);
  const folderName = `${safeName}-db`;
  const folder = path.join(app.getPath('documents'), folderName);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    console.log('📁 Created folder:', folder);
  }
  return folder;
}

function connectDatabase() {
  const folder = ensureProjectFolder();
  const safeName = getSafeName(packageJson.name);
  const dbPath = path.join(folder, `${safeName}.db`);
  db = new sqlite3.Database(dbPath);
  console.log('🗄️ Connected to:', dbPath);

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS debtors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      debtor_id INTEGER NOT NULL,
      loan_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      loan_amount REAL NOT NULL,
      transfer_charges REAL DEFAULT 0,
      repayment_amount REAL NOT NULL,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (debtor_id) REFERENCES debtors(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS repayments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      repayment_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (loan_id) REFERENCES loans(id)
    )`);

    // Migration: add parent_loan_id to support loan extensions (v1.1.0).
    // Wrapped so it silently no-ops on databases that already have the column.
    db.run(`ALTER TABLE loans ADD COLUMN parent_loan_id INTEGER REFERENCES loans(id)`, () => {});

    // Migration: add new_principal / new_charges to support accurate capital-deployed
    // accounting for loan extensions (v1.6.0). For a root (non-extension) loan the
    // full loan_amount/transfer_charges are "new" capital. For an extension, these
    // columns hold only the incremental amount actually disbursed on top of the
    // carried-forward balance, so analytics don't double-count the rolled-over debt.
    db.run(`ALTER TABLE loans ADD COLUMN new_principal REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE loans ADD COLUMN new_charges REAL DEFAULT 0`, () => {});
  });
}

// ── DB HELPERS ─────────────────────────────────────────────────
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// Shared loan SELECT fragment (reused for active and all loans)
const LOAN_SELECT = `
  SELECT l.*, d.name as debtor_name,
    COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as total_repaid,
    l.repayment_amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as balance,
    (l.repayment_amount - l.loan_amount - l.transfer_charges) as interest,
    CASE WHEN l.due_date != '' AND l.due_date < date('now') AND l.status='active' THEN 1 ELSE 0 END as is_overdue
  FROM loans l
  JOIN debtors d ON d.id = l.debtor_id
`;

// ── IPC HANDLERS ───────────────────────────────────────────────

// DEBTORS
ipcMain.handle('get-debtors', async () => {
  return await dbAll(`
    SELECT d.*,
      COUNT(DISTINCT CASE WHEN l.parent_loan_id IS NULL OR COALESCE(l.new_principal,0) > 0 THEN l.id END) as loan_count,
      COALESCE(SUM(CASE WHEN l.status='active' THEN l.repayment_amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) ELSE 0 END),0) as total_outstanding
    FROM debtors d
    LEFT JOIN loans l ON l.debtor_id = d.id
    GROUP BY d.id
    ORDER BY d.name
  `);
});

ipcMain.handle('add-debtor', async (_, data) => {
  const { name, phone, email, notes } = data;
  return await dbRun(
    'INSERT INTO debtors (name, phone, email, notes) VALUES (?,?,?,?)',
    [name, phone || null, email || null, notes || null]
  );
});

ipcMain.handle('update-debtor', async (_, data) => {
  const { id, name, phone, email, notes } = data;
  return await dbRun(
    'UPDATE debtors SET name=?, phone=?, email=?, notes=? WHERE id=?',
    [name, phone || null, email || null, notes || null, id]
  );
});

ipcMain.handle('delete-debtor', async (_, id) => {
  return await dbRun('DELETE FROM debtors WHERE id=?', [id]);
});

// LOANS
ipcMain.handle('get-active-loans', async () => {
  return await dbAll(LOAN_SELECT + `WHERE l.status = 'active' ORDER BY l.due_date ASC`);
});

// NEW: All loans (active + closed) for Loan History page
ipcMain.handle('get-all-loans', async () => {
  return await dbAll(LOAN_SELECT + `ORDER BY l.loan_date DESC, l.id DESC`);
});

ipcMain.handle('get-loans-by-debtor', async (_, debtor_id) => {
  return await dbAll(`
    SELECT l.*,
      COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as total_repaid,
      l.repayment_amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as balance,
      CASE WHEN l.due_date != '' AND l.due_date < date('now') AND l.status='active' THEN 1 ELSE 0 END as is_overdue
    FROM loans l
    WHERE l.debtor_id=?
    ORDER BY l.loan_date DESC
  `, [debtor_id]);
});

ipcMain.handle('add-loan', async (_, data) => {
  const { debtor_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes } = data;
  // A root loan has no carried-forward balance, so its entire amount/charges are new capital.
  return await dbRun(
    'INSERT INTO loans (debtor_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes, new_principal, new_charges) VALUES (?,?,?,?,?,?,?,?,?)',
    [debtor_id, loan_date, due_date || '', loan_amount, transfer_charges || 0, repayment_amount, notes || null, loan_amount, transfer_charges || 0]
  );
});

ipcMain.handle('close-loan', async (_, id) => {
  return await dbRun('UPDATE loans SET status=? WHERE id=?', ['closed', id]);
});

ipcMain.handle('delete-loan', async (_, id) => {
  await dbRun('DELETE FROM repayments WHERE loan_id=?', [id]);
  return await dbRun('DELETE FROM loans WHERE id=?', [id]);
});

// BAD DEBT
// Marking a loan as bad debt is a non-destructive status change (mirrors the
// 'extended' pattern): the loan's terms, notes and repayment history are left
// untouched, only its status flips to 'bad_debt' so it drops out of the
// active-loans list and active-loan totals.
ipcMain.handle('mark-bad-debt', async (_, id) => {
  const loan = await dbGet('SELECT status FROM loans WHERE id=?', [id]);
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'active') throw new Error('Only active loans can be marked as bad debt');
  return await dbRun('UPDATE loans SET status=? WHERE id=?', ['bad_debt', id]);
});

// Reverses a bad-debt marking, restoring the loan to 'active' status so it
// reappears in Active Loans and active totals. Available from Loan History /
// Loan Detail for any loan currently marked bad_debt.
ipcMain.handle('undo-bad-debt', async (_, id) => {
  const loan = await dbGet('SELECT status FROM loans WHERE id=?', [id]);
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'bad_debt') throw new Error('Loan is not marked as bad debt');
  return await dbRun('UPDATE loans SET status=? WHERE id=?', ['active', id]);
});

// LOAN EXTENSIONS
// Extending a loan creates a brand-new loan row (with its own terms —
// interest, principal, dates, etc.) linked back to the original via
// parent_loan_id, and marks the original loan as 'extended' so it no
// longer counts as active/open.
ipcMain.handle('extend-loan', async (_, data) => {
  const { original_loan_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes, new_principal, new_charges } = data;

  const original = await dbGet('SELECT * FROM loans WHERE id=?', [original_loan_id]);
  if (!original) throw new Error('Original loan not found');

  // loan_amount/transfer_charges hold the FULL new loan's terms (carried-forward
  // balance + anything added). new_principal/new_charges hold ONLY the portion
  // that was actually newly disbursed at this extension (not the rolled-over
  // balance), so analytics can report accurate total capital deployed without
  // double-counting money that was never re-given to the debtor.
  const result = await dbRun(
    `INSERT INTO loans (debtor_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes, parent_loan_id, new_principal, new_charges)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [original.debtor_id, loan_date, due_date || '', loan_amount, transfer_charges || 0, repayment_amount, notes || null, original_loan_id, new_principal || 0, new_charges || 0]
  );
  await dbRun('UPDATE loans SET status=? WHERE id=?', ['extended', original_loan_id]);
  return result;
});

// Fetch the full chain of a loan: its root original loan plus every
// extension branching from it (supports multiple sequential extensions).
ipcMain.handle('get-loan-lineage', async (_, loanId) => {
  let current = await dbGet('SELECT id, parent_loan_id FROM loans WHERE id=?', [loanId]);
  if (!current) return [];
  let rootId = loanId;
  while (current && current.parent_loan_id) {
    rootId = current.parent_loan_id;
    current = await dbGet('SELECT id, parent_loan_id FROM loans WHERE id=?', [rootId]);
  }
  let ids = [rootId];
  let queue = [rootId];
  while (queue.length) {
    const pid = queue.shift();
    const children = await dbAll('SELECT id FROM loans WHERE parent_loan_id=?', [pid]);
    for (const c of children) { ids.push(c.id); queue.push(c.id); }
  }
  const placeholders = ids.map(() => '?').join(',');
  return await dbAll(LOAN_SELECT + `WHERE l.id IN (${placeholders}) ORDER BY l.loan_date ASC, l.id ASC`, ids);
});

// REPAYMENTS
ipcMain.handle('get-repayments-by-loan', async (_, loan_id) => {
  return await dbAll(
    'SELECT * FROM repayments WHERE loan_id=? ORDER BY repayment_date DESC',
    [loan_id]
  );
});

ipcMain.handle('add-repayment', async (_, data) => {
  const { loan_id, amount, repayment_date, notes } = data;
  const result = await dbRun(
    'INSERT INTO repayments (loan_id, amount, repayment_date, notes) VALUES (?,?,?,?)',
    [loan_id, amount, repayment_date, notes || null]
  );
  // Auto-close loan if fully repaid
  const loan = await dbGet('SELECT repayment_amount FROM loans WHERE id=?', [loan_id]);
  const paid = await dbGet('SELECT COALESCE(SUM(amount),0) as total FROM repayments WHERE loan_id=?', [loan_id]);
  if (loan && paid && paid.total >= loan.repayment_amount) {
    await dbRun('UPDATE loans SET status=? WHERE id=?', ['closed', loan_id]);
  }
  return result;
});

ipcMain.handle('delete-repayment', async (_, id) => {
  const rep = await dbGet('SELECT loan_id FROM repayments WHERE id=?', [id]);
  await dbRun('DELETE FROM repayments WHERE id=?', [id]);
  // Re-open loan if it was closed
  if (rep) {
    const loan = await dbGet('SELECT repayment_amount FROM loans WHERE id=?', [rep.loan_id]);
    const paid = await dbGet('SELECT COALESCE(SUM(amount),0) as total FROM repayments WHERE loan_id=?', [rep.loan_id]);
    if (loan && paid && paid.total < loan.repayment_amount) {
      await dbRun('UPDATE loans SET status=? WHERE id=?', ['active', rep.loan_id]);
    }
  }
  return { success: true };
});

// ANALYTICS
//
// Two accounting concerns are handled here in JS (rather than pure SQL) because
// they both require per-loan logic that can't be expressed as a simple SUM:
//
// 1. Capital deployed ("Total Loaned"): an extension's loan_amount includes the
//    carried-forward balance of the loan(s) before it, which was never actually
//    re-handed to the debtor as new cash. Only a root loan's full amount, or an
//    extension's new_principal/new_charges (the incremental amount added at that
//    extension), represent genuinely new capital. Summing loan_amount across every
//    loan in a chain would double- (or triple-) count the same money.
// 2. Interest earned: interest shouldn't be reported as "earned" until the debtor
//    has actually repaid more than the principal + charges — it's recognized
//    incrementally as repayments come in, capped at the loan's total expected
//    interest, rather than showing the full expected figure immediately or only
//    once a loan is fully closed.
// 3. Extension chains (v1.6.2): a chain (root -> ext -> ext ...) is reported as
//    ONE loan. An extension only adds to the loan count when new principal was
//    handed over, and the chain's repayable is what was paid on earlier links
//    plus the final link's repayment_amount (which already includes the
//    carried-forward balance), so rolled-over debt isn't counted repeatedly.
ipcMain.handle('get-analytics', async () => {
  const loans = await dbAll(`
    SELECT l.*, d.name as debtor_name,
      COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as total_repaid
    FROM loans l
    JOIN debtors d ON d.id = l.debtor_id
  `);
  const totalDebtorsRow = await dbGet('SELECT COUNT(*) as v FROM debtors');
  const todayStr = new Date().toISOString().slice(0, 10);

  // Group loans into extension chains (root -> ext -> ext ...). Each chain is
  // reported as ONE loan; extensions only add to the loan count when new
  // principal was actually handed over.
  const byId = new Map(loans.map(l => [l.id, l]));
  const childOf = new Map();
  for (const l of loans) {
    if (l.parent_loan_id && byId.has(l.parent_loan_id)) childOf.set(l.parent_loan_id, l);
  }
  const roots = loans.filter(l => !l.parent_loan_id || !byId.has(l.parent_loan_id));

  let totalLoaned = 0, totalRepayable = 0, totalRepaid = 0;
  let activeLoans = 0, overdueLoans = 0, closedLoans = 0;
  let totalInterest = 0, interestCollected = 0, totalOutstanding = 0;
  const perDebtorMap = {};
  const monthlyMap = {};
  const monthEntry = (month) =>
    (monthlyMap[month] = monthlyMap[month] || { month, loan_count: 0, loaned: 0, interest: 0 });

  for (const root of roots) {
    const chain = [root];
    const seen = new Set([root.id]);
    let next = childOf.get(root.id);
    while (next && !seen.has(next.id)) { chain.push(next); seen.add(next.id); next = childOf.get(next.id); }
    const terminal = chain[chain.length - 1];

    if (!perDebtorMap[root.debtor_id]) {
      perDebtorMap[root.debtor_id] = {
        name: root.debtor_name, loan_count: 0, total_loaned: 0, total_repayable: 0,
        total_interest: 0, total_repaid: 0, active_loans: 0, closed_loans: 0,
        outstanding: 0, recovered: 0
      };
    }
    const pd = perDebtorMap[root.debtor_id];

    let chainCapital = 0, chainRepaid = 0, priorRepaid = 0;

    chain.forEach((l, i) => {
      const isExt = !!l.parent_loan_id;
      const newPrincipal = isExt ? (l.new_principal || 0) : l.loan_amount;
      const newCharges = isExt ? (l.new_charges || 0) : (l.transfer_charges || 0);
      const newCapital = newPrincipal + newCharges;
      const countsAsLoan = !isExt || newPrincipal > 0;

      chainCapital += newCapital;
      chainRepaid += l.total_repaid;
      if (i < chain.length - 1) priorRepaid += l.total_repaid;
      // Recovery counts repayments only up to the amount due on each link, so
      // overpayments never inflate the recovery rate.
      pd.recovered += Math.min(l.total_repaid, l.repayment_amount);

      if (countsAsLoan) pd.loan_count++;

      if (l.status === 'active') {
        activeLoans++; pd.active_loans++;
        if (l.due_date && l.due_date < todayStr) overdueLoans++;
        const bal = l.repayment_amount - l.total_repaid;
        if (bal > 0) { totalOutstanding += bal; pd.outstanding += bal; }
      }
      if (l.status === 'closed') { closedLoans++; pd.closed_loans++; }

      const month = (l.loan_date || '').slice(0, 7);
      if (month) {
        const m = monthEntry(month);
        m.loaned += newCapital;
        if (countsAsLoan) m.loan_count++;
      }
    });

    // The final link's repayment_amount already includes the balance carried
    // forward, so only add what was actually paid on the earlier links.
    const chainRepayable = priorRepaid + terminal.repayment_amount;
    const expectedInterest = chainRepayable - chainCapital;
    const recognizedInterest = Math.max(0, Math.min(expectedInterest, chainRepaid - chainCapital));

    totalLoaned += chainCapital;
    totalRepayable += chainRepayable;
    totalRepaid += chainRepaid;
    totalInterest += expectedInterest;
    interestCollected += recognizedInterest;

    pd.total_loaned += chainCapital;
    pd.total_repayable += chainRepayable;
    pd.total_repaid += chainRepaid;
    pd.total_interest += recognizedInterest;

    const rootMonth = (root.loan_date || '').slice(0, 7);
    if (rootMonth) monthEntry(rootMonth).interest += recognizedInterest;
  }

  const perDebtor = Object.values(perDebtorMap).sort((a, b) => b.total_interest - a.total_interest);
  const monthly = Object.values(monthlyMap).sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, 12).reverse();

  return {
    totalLoaned, totalRepayable, totalRepaid,
    activeLoans, overdueLoans, closedLoans,
    totalDebtors: totalDebtorsRow.v,
    totalInterest, interestCollected, totalOutstanding,
    perDebtor, monthly
  };
});

// ── WINDOW ─────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  connectDatabase();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
