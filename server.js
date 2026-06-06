require("dotenv").config();

const PDFDocument = require("pdfkit");
const express = require("express");
const OpenAI = require("openai");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");
const cron = require("node-cron");
const { Resend } = require("resend");
const { Web3 } = require("web3");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = Number(process.env.PORT || 3000);
const resend = new Resend(process.env.RESEND_API_KEY);

/* =========================
   AI CONFIG
========================= */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =========================
   CONFIG
========================= */

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "");
const CIRCLE_APP_ID = String(process.env.CIRCLE_APP_ID || "");

const CIRCLE_API_KEY = String(
  process.env.CIRCLE_API_KEY ||
    process.env.CIRCLE_API_KEY ||
    ""
);

const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);
const ARC_CHAIN_ID_HEX = String(process.env.ARC_CHAIN_ID_HEX || "0x4cef52");
const ARC_CHAIN_NAME = String(process.env.ARC_CHAIN_NAME || "Arc Testnet");
const ARC_RPC_URL = String(
  process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network"
);
const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL);
const PAYOUT_PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY || "";
const payoutWallet = PAYOUT_PRIVATE_KEY
  ? new ethers.Wallet(PAYOUT_PRIVATE_KEY, provider)
  : null;

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const ARC_EXPLORER_URL = String(
  process.env.ARC_EXPLORER_URL || "https://testnet.arcscan.app"
);

const USDC_ADDRESS = String(
  process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000"
);
const USDC_DECIMALS = Number(process.env.USDC_DECIMALS || 6);

const CLAIM_USDC_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)"
];

const MERCHANT_ADDRESS = String(
  process.env.CIRCLE_WALLET_ADDRESS ||
    process.env.MERCHANT_ADDRESS ||
    "0xa59615ffe6cabcdcbcff586c75efd12d2f7dd9f6"
).trim();

/* =========================
   DATABASE
========================= */

const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");

// payouts table
db.prepare(`
  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    recipient TEXT,
    amount REAL,
    status TEXT,
    tx_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();
try {
  db.prepare(`ALTER TABLE payouts ADD COLUMN mode TEXT DEFAULT 'now'`).run();
} catch {}
try {
  db.prepare(`
    ALTER TABLE payouts
    ADD COLUMN frequency TEXT DEFAULT 'once'
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE payouts
    ADD COLUMN next_run_at DATETIME
  `).run();
} catch {}

app.get("/api/claims/:id", (req, res) => {
  const { id } = req.params;

  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(id);

  if (!claim) {
    return res.status(404).json({ error: "Claim not found" });
  }

  res.json(claim);
});

db.prepare(`
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    recipientAddress TEXT NOT NULL,
    targetChain TEXT NOT NULL,
    note TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'CREATED',
    txHash TEXT,
    fromAddress TEXT,
    createdAt TEXT NOT NULL,
    paidAt TEXT,
    reminder_sent INTEGER DEFAULT 0,
    dueDate TEXT
  )
`).run();

try {

  db.prepare(`
    ALTER TABLE invoices
    ADD COLUMN dueDate TEXT
  `).run();

} catch {}

try {
  db.prepare(`
    ALTER TABLE invoices
    ADD COLUMN reminder_sent INTEGER DEFAULT 0
  `).run();

  console.log("✅ reminder_sent column added");
} catch (err) {
  console.log("reminder_sent already exists");
}

try {
  db.prepare(`
    ALTER TABLE invoices
    ADD COLUMN recipientEmail TEXT
  `).run();

  console.log("recipientEmail column added");
} catch {
  console.log("recipientEmail already exists");
}

db.prepare(`
  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    recipientEmail TEXT NOT NULL,
    amount REAL NOT NULL,
    message TEXT,
    status TEXT DEFAULT 'PENDING',
    walletAddress TEXT,
    createdAt TEXT,
    claimedAt TEXT
  )
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  email TEXT,
  amount REAL,
  country TEXT,
  bank_name TEXT,
  account_holder TEXT,
  account_number TEXT,
  status TEXT,
  created_at TEXT
)
`).run();

// payroll batches
db.prepare(`
  CREATE TABLE IF NOT EXISTS payroll_batches (
    id TEXT PRIMARY KEY,
    title TEXT,
    pay_date DATETIME,
    status TEXT DEFAULT 'DRAFT',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// payroll items
db.prepare(`
  CREATE TABLE IF NOT EXISTS payroll_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    employee_name TEXT,
    employee_email TEXT,
    wallet TEXT,
    base_salary REAL DEFAULT 0,
    overtime_hours REAL DEFAULT 0,
    overtime_rate REAL DEFAULT 0,
    allowance REAL DEFAULT 0,
    bonus REAL DEFAULT 0,
    deduction REAL DEFAULT 0,
    final_amount REAL DEFAULT 0,
    status TEXT DEFAULT 'DRAFT',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

try {
  db.prepare(`
    ALTER TABLE payroll_items
    ADD COLUMN tx_hash TEXT
  `).run();
} catch {}

try {
  db.prepare("ALTER TABLE claims ADD COLUMN txHash TEXT").run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE payroll_batches
    ADD COLUMN frequency TEXT DEFAULT 'once'
  `).run();
} catch {}

try {
  db.prepare(
    "ALTER TABLE payroll_batches ADD COLUMN auto_execute INTEGER DEFAULT 0"
  ).run();
  console.log("✅ Added auto_execute column");
} catch (e) {}

try {
  db.prepare(
    "ALTER TABLE payroll_batches ADD COLUMN requires_approval INTEGER DEFAULT 1"
  ).run();
  console.log("✅ Added requires_approval column");
} catch (e) {}

/* =========================
   MIDDLEWARE
========================= */

app.use(cors({
  origin: ["http://localhost:5173", "http://localhost:3000"],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/payroll-batches", (req, res) => {
  const rows = db.prepare(`
    SELECT
      b.*,
      COALESCE(SUM(i.final_amount), 0) AS total_amount,
      COUNT(i.id) AS employee_count
    FROM payroll_batches b
    LEFT JOIN payroll_items i ON i.batch_id = b.id
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `).all();

  res.json(rows);
});

app.get("/api/payroll-items", (req, res) => {
  const latestBatch = db.prepare(`
    SELECT * FROM payroll_batches
    ORDER BY created_at DESC
    LIMIT 1
  `).get();

  if (!latestBatch) {
    return res.json([]);
  }

  const rows = db.prepare(`
    SELECT * FROM payroll_items
    WHERE batch_id = ?
    ORDER BY created_at DESC
  `).all(latestBatch.id);

  res.json(rows);
});

app.get("/api/payroll-batches/:id/items", (req, res) => {
  const { id } = req.params;

  const items = db.prepare(`
    SELECT *
    FROM payroll_items
    WHERE batch_id = ?
    ORDER BY created_at DESC
  `).all(id);

  res.json(items);
});

app.get("/api/payroll-items/:id/payslip.pdf", (req, res) => {
  try {
    const item = db.prepare(`
      SELECT 
        pi.*,
        pb.title as batch_title,
        pb.pay_date,
        pb.frequency
      FROM payroll_items pi
      LEFT JOIN payroll_batches pb ON pi.batch_id = pb.id
      WHERE pi.id = ?
    `).get(req.params.id);

    if (!item) {
      return res.status(404).json({ error: "Payroll item not found" });
    }

    const doc = new PDFDocument({ margin: 50 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ArcPay-Payslip-${item.employee_name || item.id}.pdf"`
    );

    doc.pipe(res);

    doc.fontSize(26).text("ArcPay Payroll Payslip", { align: "center" });

doc.moveDown();

doc.fontSize(11).fillColor("gray").text(`Payslip ID: PAY-${item.id}`);
doc.text(`Generated by ArcPay`);
doc.fillColor("black");

doc.moveDown();

doc.fontSize(14).text("Employee Information", { underline: true });
doc.moveDown(0.5);
doc.fontSize(12).text(`Employee Name: ${item.employee_name}`);
doc.text(`Employee Email: ${item.employee_email}`);
doc.text(`Wallet: ${item.wallet}`);

doc.moveDown();

doc.fontSize(14).text("Payroll Information", { underline: true });
doc.moveDown(0.5);
doc.fontSize(12).text(`Payroll: ${batch.title}`);
doc.text(`Payroll Period: ${new Date(batch.pay_date).toLocaleDateString("en-US", {
  month: "long",
  year: "numeric"
})}`);
doc.text(`Pay Date: ${new Date(batch.pay_date).toISOString().slice(0, 10)}`);
doc.text(`Frequency: ${batch.frequency}`);
doc.text(`Status: ${batch.status}`);

doc.moveDown();

doc.fontSize(14).text("Earnings", { underline: true });
doc.moveDown(0.5);
doc.fontSize(12).text(`Base Salary: ${item.base_salary || 0} USDC`);
doc.text(`Overtime: ${(item.overtime_hours || 0) * (item.overtime_rate || 0)} USDC`);
doc.text(`Allowance: ${item.allowance || 0} USDC`);
doc.text(`Bonus: ${item.bonus || 0} USDC`);

doc.moveDown();

doc.fontSize(14).text("Deductions", { underline: true });
doc.moveDown(0.5);
doc.fontSize(12).text(`Deduction: ${item.deduction || 0} USDC`);

doc.moveDown();

doc.fontSize(18).fillColor("#111827").text(`Net Salary: ${item.final_amount} USDC`);

doc.moveDown();

doc.fontSize(14).fillColor("black").text("Payment Details", { underline: true });
doc.moveDown(0.5);
doc.fontSize(12).text(`Payment Status: PAID`);
doc.text(`Payment Date: ${new Date().toISOString().slice(0, 10)}`);
doc.text(`Transaction Hash: ${payoutResult.txHash}`);

doc.moveDown(2);

doc.fontSize(10)
  .fillColor("gray")
  .text("This payslip was generated automatically by ArcPay.", { align: "center" });

    doc.end();
  } catch (err) {
    console.error("Payslip PDF error:", err);
    res.status(500).json({ error: "Failed to generate payslip PDF" });
  }
});

app.post("/api/payroll-items/:id/email-payslip", async (req, res) => {
  // Send payslip via email
});

app.post("/api/payroll-batches/:id/approve", (req, res) => {
  const { id } = req.params;

  const batch = db.prepare(`
    SELECT * FROM payroll_batches
    WHERE id = ?
  `).get(id);

  if (!batch) {
    return res.status(404).json({ error: "Payroll batch not found" });
  }

  db.prepare(`
    UPDATE payroll_batches
    SET status = 'APPROVED'
    WHERE id = ?
  `).run(id);

  db.prepare(`
    UPDATE payroll_items
    SET status = 'APPROVED'
    WHERE batch_id = ?
  `).run(id);

  res.json({
    success: true,
    message: "Payroll batch approved",
    batchId: id
  });
});

app.post("/api/payroll-batches/:id/unapprove", (req, res) => {
  const { id } = req.params;

  db.prepare(`
    UPDATE payroll_batches
    SET status = 'DRAFT'
    WHERE id = ?
  `).run(id);

  db.prepare(`
    UPDATE payroll_items
    SET status = 'DRAFT'
    WHERE batch_id = ?
    AND status != 'PAID'
  `).run(id);

  res.json({
    success: true,
    message: "Payroll batch moved back to DRAFT"
  });
});

app.post("/api/payroll-batches/:id/cancel", (req, res) => {
  const { id } = req.params;

  db.prepare(`
    UPDATE payroll_batches
    SET status = 'CANCELLED'
    WHERE id = ?
    AND status != 'PAID'
  `).run(id);

  db.prepare(`
    UPDATE payroll_items
    SET status = 'CANCELLED'
    WHERE batch_id = ?
    AND status != 'PAID'
  `).run(id);

  res.json({
    success: true,
    message: "Payroll batch cancelled"
  });
});

app.post("/api/payroll-batches/:id/execute", async (req, res) => {
  const { id } = req.params;

  const batch = db.prepare(`
    SELECT *
    FROM payroll_batches
    WHERE id = ?
  `).get(id);

  if (!batch) {
    return res.status(404).json({
      error: "Payroll batch not found"
    });
  }

  if (batch.status !== "REVIEW") {
    return res.status(400).json({
      error: "Only REVIEW payroll batch can be executed"
    });
  }

  const items = db.prepare(`
    SELECT *
    FROM payroll_items
    WHERE batch_id = ?
  `).all(id);

  if (!items.length) {
    return res.status(404).json({
      error: "No payroll items found"
    });
  }

  const results = [];

  for (const item of items) {
    if (item.status === "PAID") {
      console.log("⚠️ Payroll item already paid:", item.id);
      continue;
    }

    if (item.status !== "REVIEW") {
      console.log("⚠️ Payroll item not ready:", item.id);
      continue;
    }

    const payoutId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO payouts (
        id,
        recipient,
        amount,
        status,
        mode,
        frequency
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      payoutId,
      item.wallet,
      item.final_amount,
      "APPROVED",
      "payroll",
      "once"
    );

    const payoutResult = await executePayoutById(payoutId);

    db.prepare(`
      UPDATE payroll_items
      SET status = 'PAID',
          tx_hash = ?
      WHERE id = ?
    `).run(
      payoutResult.txHash,
      item.id
    );

    try {

const doc = new PDFDocument({ margin: 50 });
const chunks = [];

doc.on("data", (chunk) => chunks.push(chunk));

const pdfBufferPromise = new Promise((resolve, reject) => {
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  doc.on("error", reject);
});

doc.fontSize(22).text("ArcPay Payslip", { align: "center" });
doc.moveDown();

doc.fontSize(12).text(`Payroll: ${batch.title || "Monthly Payroll"}`);
doc.text(`Pay Date: ${batch.pay_date || "-"}`);
doc.text(`Frequency: ${batch.frequency || "-"}`);
doc.text(`Status: PAID`);
doc.moveDown();

doc.text(`Employee Name: ${item.employee_name || "-"}`);
doc.text(`Employee Email: ${item.employee_email || "-"}`);
doc.text(`Wallet: ${item.wallet || "-"}`);
doc.moveDown();

doc.text(`Base Salary: ${item.base_salary || 0} USDC`);
doc.text(`Overtime: ${(item.overtime_hours || 0) * (item.overtime_rate || 0)} USDC`);
doc.text(`Allowance: ${item.allowance || 0} USDC`);
doc.text(`Bonus: ${item.bonus || 0} USDC`);
doc.text(`Deduction: ${item.deduction || 0} USDC`);
doc.moveDown();

doc.fontSize(16).text(`Final Amount: ${item.final_amount || 0} USDC`);
doc.moveDown();

doc.fontSize(10).text(`Tx Hash: ${payoutResult.txHash || "-"}`);
doc.moveDown();
doc.fontSize(10).text("Generated by ArcPay", { align: "center" });

doc.end();

const pdfBuffer = await pdfBufferPromise;

      await resend.emails.send({
        from: "ArcPay <no-reply@arcpay.pro>",
        to: [item.employee_email],
        subject: `Your salary has been paid - ${item.final_amount} USDC`,
        html: `
          <h2>Salary Paid</h2>
          <p>Hello ${item.employee_name},</p>
          <p>Your salary has been paid via ArcPay.</p>

          <ul>
            <li>Base salary: ${item.base_salary} USDC</li>
            <li>Overtime: ${item.overtime_hours}h × ${item.overtime_rate}</li>
            <li>Allowance: ${item.allowance} USDC</li>
            <li>Bonus: ${item.bonus} USDC</li>
            <li>Deduction: ${item.deduction} USDC</li>
            <li><b>Final amount: ${item.final_amount} USDC</b></li>
          </ul>

          <p><b>Transaction:</b> ${payoutResult.txHash}</p>

          <p>
            <a href="https://testnet.arcscan.app/tx/${payoutResult.txHash}">
              View transaction
            </a>
          </p>
        `,
        attachments: [
         {
            filename: `ArcPay-Payslip-${item.employee_name || item.id}.pdf`,
        content: pdfBuffer,
          },
       ],
      });

      console.log("✅ Payslip email sent:", item.employee_email);
    } catch (emailErr) {
      console.error("Payslip email failed:", emailErr.message);
    }

    results.push({
      employee: item.employee_name,
      amount: item.final_amount,
      txHash: payoutResult.txHash
    });
  }

  db.prepare(`
    UPDATE payroll_batches
    SET status = 'PAID'
    WHERE id = ?
  `).run(id);

  res.json({
    success: true,
    payrollBatch: id,
    results
  });
});

app.post("/api/payroll-items/:id/update", (req, res) => {
  const { id } = req.params;

  const item = db.prepare(`
    SELECT * FROM payroll_items
    WHERE id = ?
  `).get(id);

  if (!item) {
    return res.status(404).json({ error: "Payroll item not found" });
  }

  if (item.status === "PAID") {
    return res.status(400).json({
      error: "Cannot edit paid payroll item"
    });
  }

  const base = Number(req.body.base_salary || 0);
  const overtimeHours = Number(req.body.overtime_hours || 0);
  const overtimeRate = Number(req.body.overtime_rate || 0);
  const allowance = Number(req.body.allowance || 0);
  const bonus = Number(req.body.bonus || 0);
  const deduction = Number(req.body.deduction || 0);

  const finalAmount =
    base + overtimeHours * overtimeRate + allowance + bonus - deduction;

  db.prepare(`
    UPDATE payroll_items
    SET base_salary = ?,
        overtime_hours = ?,
        overtime_rate = ?,
        allowance = ?,
        bonus = ?,
        deduction = ?,
        final_amount = ?,
        status = 'DRAFT'
    WHERE id = ?
  `).run(
    base,
    overtimeHours,
    overtimeRate,
    allowance,
    bonus,
    deduction,
    finalAmount,
    id
  );

  db.prepare(`
    UPDATE payroll_batches
    SET status = 'DRAFT'
    WHERE id = ?
  `).run(item.batch_id);

  res.json({
    success: true,
    message: "Payroll item updated",
    finalAmount
  });
});

app.post("/api/payroll-items/:id/send-payslip", async (req, res) => {
  try {
    const { id } = req.params;

    const item = db.prepare(`
      SELECT 
        pi.*,
        pb.title AS batch_title,
        pb.pay_date,
        pb.frequency
      FROM payroll_items pi
      LEFT JOIN payroll_batches pb ON pi.batch_id = pb.id
      WHERE pi.id = ?
    `).get(id);

    if (!item) {
      return res.status(404).json({ error: "Payroll item not found" });
    }

    if (!item.employee_email) {
      return res.status(400).json({ error: "Missing employee email" });
    }

    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));

    const pdfBufferPromise = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    doc.fontSize(22).text("ArcPay Payslip", { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text(`Payroll: ${item.batch_title || "-"}`);
    doc.text(`Pay Date: ${item.pay_date || "-"}`);
    doc.text(`Frequency: ${item.frequency || "-"}`);
    doc.text(`Status: ${item.status || "-"}`);
    doc.moveDown();

    doc.text(`Employee Name: ${item.employee_name || "-"}`);
    doc.text(`Employee Email: ${item.employee_email || "-"}`);
    doc.text(`Wallet: ${item.wallet || "-"}`);
    doc.moveDown();

    doc.text(`Base Salary: ${item.base_salary || 0} USDC`);
    doc.text(`Overtime: ${(item.overtime_hours || 0) * (item.overtime_rate || 0)} USDC`);
    doc.text(`Allowance: ${item.allowance || 0} USDC`);
    doc.text(`Bonus: ${item.bonus || 0} USDC`);
    doc.text(`Deduction: ${item.deduction || 0} USDC`);
    doc.moveDown();

    doc.fontSize(16).text(`Final Amount: ${item.final_amount || 0} USDC`);
    doc.moveDown();

    if (item.tx_hash) {
      doc.fontSize(10).text(`Tx Hash: ${item.tx_hash}`);
    }

    doc.moveDown();
    doc.fontSize(10).text("Generated by ArcPay", { align: "center" });

    doc.end();

    const pdfBuffer = await pdfBufferPromise;

    await resend.emails.send({
      from: "ArcPay <no-reply@arcpay.pro>",
      to: [item.employee_email],
      subject: `ArcPay Payslip - ${item.final_amount || 0} USDC`,
      html: `
        <h2>ArcPay Payslip</h2>
        <p>Hello ${item.employee_name || "there"},</p>
        <p>Your payslip is attached as a PDF.</p>
        <ul>
          <li>Payroll: ${item.batch_title || "-"}</li>
          <li>Status: ${item.status || "-"}</li>
          <li>Final amount: <b>${item.final_amount || 0} USDC</b></li>
        </ul>
        ${item.tx_hash ? `
          <p>
            <a href="https://testnet.arcscan.app/tx/${item.tx_hash}">
              View transaction
            </a>
          </p>
        ` : ""}
      `,
      attachments: [
        {
          filename: `ArcPay-Payslip-${item.employee_name || item.id}.pdf`,
          content: pdfBuffer,
        },
      ],
    });

    res.json({
      success: true,
      message: `Payslip PDF sent to ${item.employee_email}`,
    });
  } catch (err) {
    console.error("Send payslip email error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payroll-batches", (req, res) => {
  const batchId = crypto.randomUUID();

  const {
    title = "Payroll Batch",
    pay_date,
    frequency = "once",
    employees = []
  } = req.body;

  db.prepare(`
    INSERT INTO payroll_batches (
      id,
      title,
      pay_date,
      status,
      frequency
  )
  VALUES (?, ?, ?, ?, ?)
  `).run(
  batchId,
  title,
  pay_date || new Date().toISOString(),
  "DRAFT",
  frequency
);

  for (const emp of employees) {
    const base = Number(emp.base_salary || 0);
    const overtimeHours = Number(emp.overtime_hours || 0);
    const overtimeRate = Number(emp.overtime_rate || 0);
    const allowance = Number(emp.allowance || 0);
    const bonus = Number(emp.bonus || 0);
    const deduction = Number(emp.deduction || 0);

    const finalAmount =
      base + overtimeHours * overtimeRate + allowance + bonus - deduction;

    db.prepare(`
      INSERT INTO payroll_items (
        id,
        batch_id,
        employee_name,
        employee_email,
        wallet,
        base_salary,
        overtime_hours,
        overtime_rate,
        allowance,
        bonus,
        deduction,
        final_amount,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      batchId,
      emp.employee_name,
      emp.employee_email,
      emp.wallet,
      base,
      overtimeHours,
      overtimeRate,
      allowance,
      bonus,
      deduction,
      finalAmount,
      "DRAFT"
    );
  }

  res.json({
    success: true,
    batchId,
    count: employees.length
  });
});

app.post("/api/payouts", (req, res) => {
  const { recipient, amount } = req.body;

  if (!recipient || !amount) {
    return res.status(400).json({ error: "Missing recipient or amount" });
  }

  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO payouts (id, recipient, amount, status)
    VALUES (?, ?, ?, ?)
  `).run(id, recipient, amount, "PENDING");

  res.json({
    id,
    recipient,
    amount,
    status: "PENDING"
  });
});

app.get("/api/payouts", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM payouts
    ORDER BY created_at DESC`
  ).all();

  res.json(rows);
});

app.get("/test-payout", (req, res) => {
  const id = crypto.randomUUID();

  db.prepare(`
  INSERT INTO payouts (
  id,
  recipient,
  amount,
  status,
  mode,
 frequency,
  next_run_at
)
VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  id,
  "0x09C960a7d011D1bb9241B69F9CDaD9c9BcE6175d",
  1,
  "PENDING",
  "scheduled",
  "monthly",
  new Date(Date.now() + 60000).toISOString()
);

  res.json({ message: "Test payout created", id });
});

app.get("/test-payroll", (req, res) => {
  const batchId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO payroll_batches (
      id,
      title,
      pay_date,
      status
    )
    VALUES (?, ?, datetime('now'), ?)
  `).run(
    batchId,
    "May 2026 Payroll",
    "DRAFT"
  );

  db.prepare(`
    INSERT INTO payroll_items (
      id,
      batch_id,
      employee_name,
      employee_email,
      wallet,
      base_salary,
      overtime_hours,
      overtime_rate,
      allowance,
      bonus,
      deduction,
      final_amount
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    batchId,
    "Mai",
    "mai@test.com",
    "0x09C960a7d011D1bb9241B69F9CDaD9c9BcE6175d",
    1,
    0,
    0,
    0,
    0,
    0,
    1
  );

  res.json({
    success: true,
    batchId
  });
});

async function executePayoutById(id) {
  if (!payoutWallet) {
    throw new Error("Missing PAYOUT_PRIVATE_KEY");
  }

  const payout = db.prepare(`
    SELECT * FROM payouts WHERE id = ?
  `).get(id);

  if (!payout) {
    throw new Error("Payout not found");
  }

  if (payout.status === "PAID") {
    return { alreadyPaid: true, payout };
  }

  const usdc = new ethers.Contract(
    USDC_ADDRESS,
    ERC20_ABI,
    payoutWallet
  );

  const amountUnits = ethers.parseUnits(String(payout.amount), 6);

  const tx = await usdc.transfer(payout.recipient, amountUnits);
  await tx.wait();

  db.prepare(`
    UPDATE payouts
    SET status = ?, tx_hash = ?
    WHERE id = ?
  `).run("PAID", tx.hash, id);

if (payout.mode === "scheduled" && payout.frequency === "monthly") {
  const nextId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO payouts (
      id, recipient, amount, status, mode, frequency, next_run_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+1 month'))
  `).run(
    nextId,
    payout.recipient,
    payout.amount,
    "APPROVED",
    "scheduled",
    "monthly"
  );
}

  return {
    id,
    txHash: tx.hash,
    status: "PAID"
  };
}

app.post("/api/payouts/:id/execute", async (req, res) => {
  try {
    const result = await executePayoutById(req.params.id);

    res.json({
      message: result.alreadyPaid ? "Already paid" : "Payout sent",
      ...result
    });
  } catch (err) {
    console.error("PAYOUT ERROR:", err);
    res.status(500).json({
      error: "Payout failed",
      details: err.message
    });
  }
});   

app.post("/api/payouts/:id/approve", (req, res) => {
  const { id } = req.params;

  const payout = db.prepare(`
    SELECT * FROM payouts WHERE id = ?
  `).get(id);

  if (!payout) {
    return res.status(404).json({ error: "Payout not found" });
  }

  if (payout.status !== "PENDING" && payout.status !== "REVIEW") {
    return res.status(400).json({
      error: "Only PENDING or REVIEW payouts can be approved"
    });
  }

  db.prepare(`
    UPDATE payouts
    SET status = 'APPROVED'
    WHERE id = ?
  `).run(id);

  res.json({
    message: "Payout approved",
    id,
    status: "APPROVED"
  });
});

// payroll batches
db.prepare(`
  CREATE TABLE IF NOT EXISTS payroll_batches (
    id TEXT PRIMARY KEY,
    title TEXT,
    pay_date DATETIME,
    status TEXT DEFAULT 'DRAFT',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// payroll items
db.prepare(`
  CREATE TABLE IF NOT EXISTS payroll_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    employee_name TEXT,
    employee_email TEXT,
    wallet TEXT,
    base_salary REAL DEFAULT 0,
    overtime_hours REAL DEFAULT 0,
    overtime_rate REAL DEFAULT 0,
    allowance REAL DEFAULT 0,
    bonus REAL DEFAULT 0,
    deduction REAL DEFAULT 0,
    final_amount REAL DEFAULT 0,
    status TEXT DEFAULT 'DRAFT',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

/* =========================
   HELPERS
========================= */

function requireCircle(res) {
  if (!CIRCLE_API_KEY) {
    res.status(500).json({
      ok: false,
      error: "Missing CIRCLE_API_KEY in .env"
    });
    return false;
  }

  return true;
}

function makeInvoiceId() {
  return `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Number(n.toFixed(6));
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function rowToInvoice(row) {
  if (!row) return null;

  const checkoutPath = `/?invoice=${row.id}`;

  return {
    id: row.id,
    title: row.title,
    amount: row.amount,
    recipientAddress: row.recipientAddress,
    targetChain: row.targetChain,
    note: row.note || "",
    status: row.status,
    txHash: row.txHash || null,
    fromAddress: row.fromAddress || null,
    createdAt: row.createdAt,
    paidAt: row.paidAt || null,
    dueDate: row.dueDate,
    checkoutPath,
    checkoutUrl: checkoutPath,
    explorerAddressUrl: `${ARC_EXPLORER_URL}/address/${row.recipientAddress}`,
    explorerTxUrl: row.txHash ? `${ARC_EXPLORER_URL}/tx/${row.txHash}` : null
  };
}

/* =========================
   HEALTH / CONFIG
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "arc-pay-mini-final",
    time: new Date().toISOString()
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    config: {
      merchantAddress: MERCHANT_ADDRESS,
      transakApiKey: process.env.TRANSAK_API_KEY,
      arcChainId: ARC_CHAIN_ID,
      arcChainIdHex: ARC_CHAIN_ID_HEX,
      arcChainName: ARC_CHAIN_NAME,
      arcRpcUrl: ARC_RPC_URL,
      arcExplorerUrl: ARC_EXPLORER_URL,
      usdcAddress: USDC_ADDRESS,
      usdcDecimals: USDC_DECIMALS
    }
  });
});

app.post("/api/card-payment-intent", async (req, res) => {
  try {
    const { recipientEmail, amount } = req.body;

    if (!recipientEmail || !amount) {
      return res.status(400).json({
        ok: false,
        error: "recipientEmail and amount are required"
      });
    }

    if (!process.env.TRANSAK_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing TRANSAK_API_KEY"
      });
    }

    const paymentId = crypto.randomUUID();

    const walletAddress =
      process.env.ARCPAY_TREASURY_WALLET ||
      MERCHANT_ADDRESS;

    const transakUrl =
      "https://global.transak.com" +
      "?apiKey=" + encodeURIComponent(process.env.TRANSAK_API_KEY) +
      "&productsAvailed=BUY"; 

    return res.json({
      ok: true,
      paymentId,
      transakUrl
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/api/circle/config", (req, res) => {
  res.json({
    ok: true,
    config: {
      circleAppId: CIRCLE_APP_ID,
      googleClientId: GOOGLE_CLIENT_ID
    }
  });
});

app.post("/api/ai/invoice-draft", async (req, res) => {
  if (!openai) {
    return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Create an ArcPay invoice draft from this request:

"${prompt}"

Return ONLY JSON:
{
  "title": "",
  "description": "",
  "amount": 0,
  "currency": "USDC",
  "customer": ""
}
`
    });

    let text = response.output_text.trim();

    text = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    console.log("GPT RAW:", text);
    const draft = JSON.parse(text);

    res.json({ success: true, draft });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI draft failed" });
  }
});


/* =========================
   INVOICES
========================= */

app.post("/api/ai/invoice-draft", async (req, res) => {

  try {

    const { prompt } = req.body;

    if (!openai) {
      return res.status(500).json({
        error: "OpenAI not configured"
      });
    }

    const completion =
      await openai.chat.completions.create({

        model: "gpt-4.1-mini",

        messages: [

          {
            role: "system",

            content: `
You are an AI commerce parser.

Extract:
- intent
- title
- amount
- category

Return ONLY JSON.`

          },

          {
            role: "user",
            content: prompt
          }

        ]

      });

    const text =
      completion.choices[0]
        .message.content;

    const parsed =
      JSON.parse(text);

    res.json(parsed);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }

});

app.get("/api/invoices", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM invoices ORDER BY createdAt DESC")
    .all()
    .map(rowToInvoice);

  res.json({
    ok: true,
    invoices: rows
  });
});

app.get("/api/invoices/:id", (req, res) => {
  const row = db
    .prepare("SELECT * FROM invoices WHERE id = ?")
    .get(req.params.id);

  if (!row) {
    return res.status(404).json({
      ok: false,
      error: "Invoice not found"
    });
  }

  res.json({
    ok: true,
    invoice: rowToInvoice(row)
  });
});

app.post("/api/invoices", (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const amount = normalizeAmount(req.body.amount);
    const recipientAddress = String(
      req.body.recipientAddress || MERCHANT_ADDRESS
    ).trim();

    const targetChain = String(req.body.targetChain || "Arc").trim() || "Arc";
    const note = String(req.body.note || "").trim();
    const dueDate =
      String(req.body.dueDate || "").trim();
    const createdAt = new Date().toISOString();

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Title is required"
      });
    }

    if (!amount) {
      return res.status(400).json({
        ok: false,
        error: "Valid amount is required"
      });
    }

    if (!isAddress(recipientAddress)) {
      return res.status(400).json({
        ok: false,
        error: "Recipient address is invalid"
      });
    }

    const recipientEmail = req.body.recipientEmail || null;

    const id = makeInvoiceId();

    db.prepare(`
      INSERT INTO invoices (
         id,
         title,
         amount,
         recipientAddress,
         recipientEmail,
         targetChain,
         note,
         status,
         createdAt,
         dueDate

      ) VALUES (
        @id,
        @title,
        @amount,
        @recipientAddress,
        @recipientEmail,
        @targetChain,
        @note,
        'CREATED',
        @createdAt,
        @dueDate
      )
    `).run({
      id,
      title,
      amount,
      recipientAddress,
      recipientEmail,
      targetChain,
      note,
      createdAt,
      dueDate
    });

    const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);

    res.json({
      ok: true,
      invoice: rowToInvoice(row)
    });
  } catch (error) {
  console.error(error);

  res.status(500).json({
    ok: false,
    error: error.message || "Create invoice failed"
  });
}
});

app.post("/api/invoices/:id/mark-paid", (req, res) => {
  try {
    const row = db
      .prepare("SELECT * FROM invoices WHERE id = ?")
      .get(req.params.id);

    if (!row) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found"
      });
    }

    if (row.status === "PAID") {
      return res.json({
        ok: true,
        invoice: rowToInvoice(row),
        alreadyPaid: true
      });
    }

    const txHash = String(req.body.txHash || "").trim();
    const fromAddress = String(req.body.fromAddress || "").trim();
    const paidAt = new Date().toISOString();

    db.prepare(`
      UPDATE invoices
      SET status = 'PAID',
          txHash = ?,
          fromAddress = ?,
          paidAt = ?
      WHERE id = ?
    `).run(txHash || null, fromAddress || null, paidAt, req.params.id);

    const updated = db
      .prepare("SELECT * FROM invoices WHERE id = ?")
      .get(req.params.id);

    res.json({
      ok: true,
      invoice: rowToInvoice(updated)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Mark paid failed"
    });
  }
});

/* =========================
   CIRCLE USER
========================= */

app.post("/api/circle/create-user", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "Missing email"
      });
    }

    const response = await fetch("https://api.circle.com/v1/w3s/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CIRCLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: String(email).toLowerCase()
      })
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.post("/api/circle/user-token", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "Missing email"
      });
    }

    const response = await fetch("https://api.circle.com/v1/w3s/users/token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CIRCLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: String(email).toLowerCase()
      })
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.post("/api/circle/initialize-user", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { userToken } = req.body;

    if (!userToken) {
      return res.status(400).json({
        error: "Missing userToken"
      });
    }

    const response = await fetch("https://api.circle.com/v1/w3s/user/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        blockchains: ["ARC-TESTNET"],
        accountType: "SCA"
      })
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================
   CIRCLE WALLETS
========================= */

app.post("/api/circle/create-wallet", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { userToken } = req.body;

    if (!userToken) {
      return res.status(400).json({
        error: "Missing userToken"
      });
    }

    const response = await fetch("https://api.circle.com/v1/w3s/user/wallets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        blockchains: ["ARC-TESTNET"],
        accountType: "SCA"
      })
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

async function listWalletsWithToken(userToken) {
  const response = await fetch("https://api.circle.com/v1/w3s/wallets", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CIRCLE_API_KEY}`,
      "X-User-Token": userToken,
      "Content-Type": "application/json"
    }
  });

  const data = await response.json();

  return {
    status: response.status,
    data
  };
}

app.post("/api/circle/list-wallets", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { userToken } = req.body;

    if (!userToken) {
      return res.status(400).json({
        error: "Missing userToken"
      });
    }

    const result = await listWalletsWithToken(userToken);
    res.status(result.status).json(result.data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.post("/api/circle/wallets", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { userToken } = req.body;

    if (!userToken) {
      return res.status(400).json({
        error: "Missing userToken"
      });
    }

    const result = await listWalletsWithToken(userToken);
    res.status(result.status).json(result.data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.post("/api/circle/wallet-balances", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { userToken, walletId } = req.body;

    if (!userToken) {
      return res.status(400).json({
        error: "Missing userToken"
      });
    }

    if (!walletId) {
      return res.status(400).json({
        error: "Missing walletId"
      });
    }

    const response = await fetch(
      `https://api.circle.com/v1/w3s/wallets/${walletId}/balances`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CIRCLE_API_KEY}`,
          "X-User-Token": userToken,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================
   CIRCLE PAYMENT
========================= */
app.post("/api/circle/transfer", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const {
      userToken,
      walletId,
      tokenId,
      amount,
      destinationAddress
    } = req.body;

    if (!userToken) return res.status(400).json({ error: "Missing userToken" });
    if (!walletId) return res.status(400).json({ error: "Missing walletId" });
    if (!tokenId) return res.status(400).json({ error: "Missing tokenId" });
    if (!amount) return res.status(400).json({ error: "Missing amount" });

    if (!destinationAddress || !isAddress(destinationAddress)) {
      return res.status(400).json({ error: "Invalid destinationAddress" });
    }

    const payload = {
  idempotencyKey: crypto.randomUUID(),
  walletId: String(walletId),
  tokenId: String(tokenId),
  destinationAddress: String(destinationAddress),
  amounts: [String(Number(amount).toFixed(6))],
  feeLevel: "MEDIUM"
};

    console.log("Circle transfer backend payload:", payload);

    const response = await fetch(
      "https://api.circle.com/v1/w3s/user/transactions/transfer",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CIRCLE_API_KEY}`,
          "X-User-Token": userToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();
    console.log("Circle transfer backend response:", response.status, data);

    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/circle/transactions", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const { userToken } = req.body;

    if (!userToken) {
      return res.status(400).json({
        error: "Missing userToken"
      });
    }

    const response = await fetch("https://api.circle.com/v1/w3s/transactions", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.post("/api/withdrawals", (req, res) => {
  const {
    email,
    amount,
    country,
    bankName,
    accountHolder,
    accountNumber
  } = req.body;

  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO withdrawals (
      id,
      email,
      amount,
      country,
      bank_name,
      account_holder,
      account_number,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    email,
    amount,
    country,
    bankName,
    accountHolder,
    accountNumber,
    "PENDING",
    new Date().toISOString()
  );

  res.json({
    success: true,
    withdrawalId: id
  });
});

app.get("/api/withdrawals", (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM withdrawals
    ORDER BY created_at DESC
  `).all();

  res.json(rows);
});

app.post("/api/withdrawals/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ["PENDING", "REVIEW", "APPROVED", "COMPLETED", "REJECTED"];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid withdrawal status" });
    }

    db.prepare(`
      UPDATE withdrawals
      SET status = ?
      WHERE id = ?
    `).run(status, id);

const row = db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(id);

await resend.emails.send({
  from: "ArcPay <no-reply@arcpay.pro>",
  to: [row.email],
  subject: `ArcPay withdrawal ${status}`,
  html: `
    <h2>Withdrawal ${status}</h2>
    <p>Your bank withdrawal request is now <b>${status}</b>.</p>
    <ul>
      <li>Amount: ${row.amount} USDC</li>
      <li>Bank: ${row.bank_name}</li>
      <li>Account: ${row.account_number}</li>
      <li>Holder: ${row.account_holder}</li>
    </ul>
  `
});

    res.json({
      success: true,
      withdrawalId: id,
      status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   FRONTEND FALLBACK
========================= */

const distPath = path.join(__dirname, "frontend", "dist");

app.get("/api/dashboard", (req, res) => {
  try {
    const totalReceivedRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM invoices
      WHERE status = 'PAID'
    `).get();

    const paidCountRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status = 'PAID'
    `).get();

    const pendingCountRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status != 'PAID'
    `).get();

    const latestPayment = db.prepare(`
      SELECT id, title, amount, txHash, paidAt
      FROM invoices
      WHERE status = 'PAID'
      ORDER BY paidAt DESC
      LIMIT 1
    `).get();

    const totalInvoicesRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
    `).get();

    const totalPayrollsRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM payroll_batches
    `).get();

    const totalClaimsRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM claims
    `).get();

    const totalVolumeRow = db.prepare(`
      SELECT COALESCE(SUM(amount),0) as total
      FROM invoices
      WHERE status='PAID'
    `).get();

const recentActivity = [];

if (latestPayment) {
  recentActivity.push({
    type: "invoice",
    text: `Invoice paid: ${latestPayment.title} (${latestPayment.amount} USDC)`
  });
}

const latestPayroll = db.prepare(`
  SELECT 
    b.title,
    COALESCE(SUM(i.final_amount), 0) AS total_amount
  FROM payroll_batches b
  LEFT JOIN payroll_items i ON i.batch_id = b.id
  GROUP BY b.id
  ORDER BY b.created_at DESC
  LIMIT 1
`).get();

if (latestPayroll) {
  recentActivity.push({
    type: "payroll",
    text: `Payroll executed: ${latestPayroll.title}`
  });
}

const latestClaim = db.prepare(`
  SELECT recipientEmail, amount
  FROM claims
  ORDER BY id DESC
  LIMIT 1
`).get();

if (latestClaim) {
  recentActivity.push({
    type: "claim",
    text: `Claim sent to ${latestClaim.recipientEmail}`
  });
}

    res.json({
  totalReceived: totalReceivedRow.total,
  paidCount: paidCountRow.count,
  pendingCount: pendingCountRow.count,

  totalInvoices: totalInvoicesRow.count,
  totalPayrolls: totalPayrollsRow.count,
  totalClaims: totalClaimsRow.count,
  totalVolume: totalVolumeRow.total,

  latestPayment: latestPayment || null,
recentActivity
});
  } catch (err) {
    console.error("dashboard error:", err);
    res.status(500).json({ error: "Dashboard failed" });
  }
});
app.get("/api/transak/config", (req, res) => {
  return res.json({
    apiKey: process.env.TRANSAK_API_KEY || "",
    walletAddress: process.env.ARCPAY_TREASURY_WALLET || ""
  });
});

app.post("/api/transak/widget-url", async (req, res) => {
  try {
    const { amount } = req.body;

    // STEP 1
    // GET ACCESS TOKEN
    const tokenRes = await fetch(
      "https://api-stg.transak.com/partners/api/v2/refresh-token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "api-secret": process.env.TRANSAK_API_SECRET,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          apiKey: process.env.TRANSAK_API_KEY
        })
      }
    );

    const tokenData = await tokenRes.json();

    console.log("TOKEN:", tokenData);

    const accessToken =
      tokenData?.data?.accessToken;

    // STEP 2
    // CREATE SESSION
    const sessionRes = await fetch(
      "https://api-gateway-stg.transak.com/api/v2/auth/session",
      {
        method: "POST",
        headers: {
         accept: "application/json",
         "content-type": "application/json",
         "access-token": accessToken
        },
        body: JSON.stringify({
          widgetParams: {
            apiKey: process.env.TRANSAK_API_KEY,
            referrerDomain: "https://arc-pay-production.up.railway.app",
            productsAvailed: "BUY",
            fiatAmount: Number(amount) || 10,
            fiatCurrency: "USD",
            cryptoCurrencyCode: "USDC",
            network: "polygon",
          walletAddress: process.env.ARCPAY_TREASURY_WALLET,
            paymentMethod: "credit_debit_card",
            redirectURL: "https://arc-pay-production.up.railway.app/transak-return"
         }
       })
      }
    );

    const sessionData =
      await sessionRes.json();

    console.log(
      "SESSION:",
      sessionData
    );

    res.json(sessionData);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

app.get("/api/circle/wallet-balances", async (req, res) => {
  try {

    const walletAddress =
      process.env.ARCPAY_TREASURY_WALLET;

    const rpcUrl =
      process.env.ARC_RPC_URL;

    const USDC =
      process.env.USDC_ADDRESS;

    const web3 = new Web3(rpcUrl);

    const abi = [
      {
        constant: true,
        inputs: [
          { name: "_owner", type: "address" }
        ],
        name: "balanceOf",
        outputs: [
          { name: "balance", type: "uint256" }
        ],
        type: "function"
      },
      {
        constant: true,
        inputs: [],
        name: "decimals",
        outputs: [
          { name: "", type: "uint8" }
        ],
        type: "function"
      }
    ];

    const contract =
      new web3.eth.Contract(abi, USDC);

    const raw =
      await contract.methods
        .balanceOf(walletAddress)
        .call();

    const decimals =
      await contract.methods
        .decimals()
        .call();

    const balance =
      Number(raw) / 10 ** Number(decimals);

    res.json({
      success: true,
      walletAddress,
      balance
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });

  }
});

app.post("/api/demo/send-test-usdc", async (req, res) => {

  try {

    const {
      email,
      amount
    } = req.body;

    console.log(
      "SEND TEST USDC:",
      email,
      amount
    );

    // generate claim ID
    const claimId =
      crypto.randomUUID();

    // generate claim link
    const APP_URL =
      process.env.APP_URL ||
      "https://arcpay.pro";

    const claimLink =
       `${APP_URL}/claim/${claimId}`;

    // send email
    await resend.emails.send({
      from:
        "ArcPay <no-reply@arcpay.pro>",

      to: [email],

      subject:
        "ArcPay Claim USDC",

      html: `
  <h2>You received ${amount} test USDC</h2>

  <p>${message || ""}</p>

  <p>Click below to claim your funds:</p>

  <p>
    <a
      href="${claimLink}"
      target="_blank"
      style="
        display:inline-block;
        padding:12px 20px;
        background:#4f46e5;
        color:white;
        text-decoration:none;
        border-radius:10px;
        font-weight:bold;
      "
    >
      Claim USDC
    </a>
  </p>

  <p>Or copy this link:</p>

  <p>
    <a href="${claimLink}">
      ${claimLink}
    </a>
  </p>
`
    });

    res.json({
      success: true,
      email,
      amount,
      claimId,
      claimLink
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

app.use(express.static(distPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"), (err) => {
    if (err) {
      res.status(404).send("Frontend not built. Use http://localhost:5173 for Vite dev.");
    }
  });
});

async function checkInvoicePaid(invoice) {
  try {
    const contract = new ethers.Contract(
      process.env.USDC_ADDRESS,
      ERC20_ABI,
      provider
    );

    const filter = contract.filters.Transfer(null, invoice.recipientAddress);

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(currentBlock - 1000, 0);

    const events = await contract.queryFilter(filter, fromBlock, currentBlock);

    for (const e of events) {
      const amount = Number(e.args.value) / 1e6;

      if (amount >= Number(invoice.amount)) {
        return {
          paid: true,
          txHash: e.transactionHash
        };
      }
    }

    return { paid: false };
  } catch (err) {
    console.error("checkInvoicePaid error:", err);
    return { paid: false };
  }
}

app.get("/api/invoices/:id/check-payment", async (req, res) => {
  try {
    const id = req.params.id;

    const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);

    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    if (invoice.status === "PAID") {
      return res.json(invoice);
    }

    const result = await checkInvoicePaid(invoice);

    if (result.paid) {
      db.prepare(`
        UPDATE invoices
        SET status = 'PAID',
            txHash = ?,
            paidAt = ?
        WHERE id = ?
      `).run(result.txHash, new Date().toISOString(), id);

      invoice.status = "PAID";
      invoice.txHash = result.txHash;
      invoice.paidAt = new Date().toISOString();
    }

    res.json(invoice);
  } catch (err) {
    console.error("check-payment error:", err);
    res.status(500).json({ error: "Check payment failed" });
  }
});

app.get("/api/dashboard", (req, res) => {
  try {
    const totalReceivedRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM invoices
      WHERE status = 'PAID'
    `).get();

    const paidCountRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status = 'PAID'
    `).get();

    const pendingCountRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status != 'PAID'
    `).get();

    const latestPayment = db.prepare(`
      SELECT id, title, amount, txHash, paidAt
      FROM invoices
      WHERE status = 'PAID'
      ORDER BY paidAt DESC
      LIMIT 1
    `).get();

    res.json({
      totalReceived: totalReceivedRow.total,
      paidCount: paidCountRow.count,
      pendingCount: pendingCountRow.count,
      latestPayment: latestPayment || null
    });
  } catch (err) {
    console.error("dashboard error:", err);
    res.status(500).json({ error: "Dashboard failed" });
  }
});

app.post("/api/claims/send-email", async (req, res) => {
  try {
    const { recipientEmail, amount, message } = req.body;

    if (!recipientEmail || !amount) {
      return res.status(400).json({ error: "recipientEmail and amount are required" });
    }

    const id = crypto.randomUUID();
    const appUrl = String(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
    const claimLink = `${appUrl}/claim/${id}`;

    db.prepare(`
      INSERT INTO claims (id, recipientEmail, amount, message, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      recipientEmail,
      Number(amount),
      message || "",
      "PENDING",
      new Date().toISOString()
    );

    const { data, error } = await resend.emails.send({
  from: "ArcPay <no-reply@arcpay.pro>",
  to: recipientEmail,
  subject: `You received ${amount} USDC via ArcPay`,
  html: ` 
    <h2>You received ${amount} USDC</h2>
    <p>${message || "You have a USDC claim waiting for you."}</p>
    <p>Claim your USDC here:</p>
    <p><a href="${claimLink}">${claimLink}</a></p>
  `
});

if (error) {
  console.error("Resend error:", error);
  return res.status(500).json({
    success: false,
    error: "Failed to send claim email"
  });
}

    res.json({
    success: true,
    claimId: id,
    claimLink
  });
  } catch (err) {
    console.error("send claim email error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/claims/:id", (req, res) => {
  const { id } = req.params;

  const claim = db
    .prepare("SELECT * FROM claims WHERE id = ?")
    .get(id);

  if (!claim) {
    return res.status(404).send("Claim not found");
  }

  res.json(claim);
});

app.get("/api/claims/:id", (req, res) => {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(req.params.id);

  if (!claim) {
    return res.status(404).json({ error: "Claim not found" });
  }

  res.json({ claim });
});

app.post("/api/claims/:id/claim", async (req, res) => {
  try {
    const { walletAddress } = req.body;
    const { id } = req.params;

    if (!walletAddress || !walletAddress.startsWith("0x")) {
      return res.status(400).json({ error: "Valid wallet address is required" });
    }

    const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(id);

    if (!claim) {
      return res.status(404).json({ error: "Claim not found" });
    }

    if (claim.status === "CLAIMED") {
      return res.status(400).json({ error: "Claim already claimed" });
    }

    if (!PAYOUT_PRIVATE_KEY) {
      return res.status(500).json({ error: "Missing PAYOUT_PRIVATE_KEY" });
    }

    const payoutWallet = new ethers.Wallet(PAYOUT_PRIVATE_KEY, provider);

    const usdc = new ethers.Contract(
      USDC_ADDRESS,
      CLAIM_USDC_ABI,
      payoutWallet
    );

    const amountUnits = ethers.parseUnits(String(claim.amount), USDC_DECIMALS);

    const tx = await usdc.transfer(walletAddress, amountUnits);
    await tx.wait();

    db.prepare(`
      UPDATE claims
      SET status = ?,
          walletAddress = ?,
          claimedAt = ?,
          txHash = ?
      WHERE id = ?
    `).run(
      "CLAIMED",
      walletAddress,
      new Date().toISOString(),
      tx.hash,
      id
    );

console.log("CLAIM CREATED:", id);

    res.json({
      success: true,
      message: "USDC claimed successfully",
      walletAddress,
      txHash: tx.hash,
      claimedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("claim transfer error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/claims/:id", (req, res) => {
  const { id } = req.params;

  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(id);

  if (!claim) {
    return res.status(404).json({ error: "Claim not found" });
  }

  res.json(claim);
});

app.get("/api/claim/:id", (req, res) => {
  const { id } = req.params;

  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(id);

  if (!claim) {
    return res.status(404).json({ error: "Claim not found" });
  }

  res.json(claim);
});

app.get("/test-email", async (req, res) => {
  try {
    const data = await resend.emails.send({
      from: "ArcPay <no-reply@arcpay.pro>",
      to: ["maihongha14021992mhh12@gmail.com"],
      subject: "Test email from ArcPay 🚀",
      html: "<h1>ArcPay email is working!</h1>",
    });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error sending email");
  }
});

async function checkInvoices() {

  const result =
    db.prepare(`
      UPDATE invoices
      SET status = CASE
        WHEN datetime(dueDate) < datetime('now')
          THEN 'OVERDUE'

        WHEN datetime(dueDate) <= datetime('now', '+1 day')
          THEN 'REMINDER'

        ELSE status
      END

        WHERE
          status != 'PAID'
          AND dueDate IS NOT NULL
    `).run();

  console.log(
    "checking invoices...",
    result.changes
  );

  const reminders = db.prepare(`
    SELECT *
    FROM invoices
    WHERE status = 'REMINDER'
    AND reminder_sent = 0
  `).all();

  for (const inv of reminders) {
    console.log(
  "Sending reminder:",
  inv.id
);

try {

  console.log(
    "recipientEmail:",
    inv.recipientEmail
  );

  await resend.emails.send({
  from: "ArcPay <no-reply@arcpay.pro>",

  to: [
   inv.recipientEmail
  ],

  subject:` Invoice Reminder ${inv.id}`,

  html: `
    <h2>Payment Reminder</h2>

    <p>
      Invoice: ${inv.title}
    </p>

    <p>
      Amount: ${inv.amount} USDC
    </p>

    <p>
      Status: ${inv.status}
    </p>
  `
});

  console.log(
    "Reminder email sent:",
    inv.id
  );

  db.prepare(`
  UPDATE invoices
  SET reminder_sent = 1
  WHERE id = ?
`).run(inv.id);

} catch (err) {
  console.error(
    "Reminder email failed:",
    err.message
  );
}
}
}

cron.schedule("*/1 * * * *", async () => {
  checkInvoices();
  console.log("AUTO PAYOUT CHECK...");

  const payouts = db.prepare(`
    SELECT * FROM payouts
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
    LIMIT 3
  `).all();

  for (const p of payouts) {
  try {
    db.prepare(`
      UPDATE payouts
      SET status = 'REVIEW'
      WHERE id = ?
      AND status = 'PENDING'
    `).run(p.id);

    console.log("Payout needs confirmation:", p.id);
  } catch (err) {
    console.error("Auto review error:", err.message);
  }
}
});

app.post("/api/payouts/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;

    const payout = db.prepare(`
      SELECT * FROM payouts WHERE id = ?
    `).get(id);

    if (!payout) {
      return res.status(404).json({ error: "Payout not found" });
    }

    if (payout.status !== "PENDING" && payout.status !== "REVIEW") {
      return res.status(400).json({
        error: "Only PENDING or REVIEW payouts can be confirmed"
      });
    }

    if (payout.mode === "scheduled") {
      db.prepare(`
        UPDATE payouts
        SET status = 'APPROVED',
            next_run_at = datetime('now', '+1 minute')
        WHERE id = ?
      `).run(id);

      return res.json({
        message: "Scheduled payout approved",
        id,
        status: "APPROVED"
      });
    }

    const result = await executePayoutById(id);

    res.json({
      message: "Payout paid now",
      ...result
    });
  } catch (err) {
    console.error("CONFIRM PAYOUT ERROR:", err);
    res.status(500).json({
      error: "Confirm payout failed",
      details: err.message
    });
  }
});

// =======================
// AUTO PAYOUT CRON
// =======================
cron.schedule("* * * * *", () => {
  console.log("⏰ Checking scheduled payrolls...");

  const duePayrolls = db.prepare(`
    SELECT *
    FROM payroll_batches
    WHERE status = 'APPROVED'
      AND datetime(pay_date) <= datetime('now')
  `).all();

  for (const payroll of duePayrolls) {

    db.prepare(`
      UPDATE payroll_batches
      SET status = 'REVIEW'
      WHERE id = ?
    `).run(payroll.id);

    db.prepare(`
      UPDATE payroll_items
      SET status = 'REVIEW'
      WHERE batch_id = ?
        AND status = 'APPROVED'
    `).run(payroll.id);

    console.log("Payroll needs final review:", payroll.id);

    // CREATE NEXT MONTHLY PAYROLL
    if (payroll.frequency === "monthly") {

      const nextDate = new Date(payroll.pay_date);

      nextDate.setMonth(nextDate.getMonth() + 1);

const existingNextPayroll = db.prepare(`
  SELECT id
  FROM payroll_batches
  WHERE title = ?
    AND frequency = 'monthly'
    AND date(pay_date) = date(?)
  LIMIT 1
`).get(payroll.title, nextDate.toISOString());

if (existingNextPayroll) {
  console.log("⚠️ Next monthly payroll already exists:", existingNextPayroll.id);
  continue;
}

      db.prepare(`
        INSERT INTO payroll_batches (
          id,
          title,
          pay_date,
          status,
          frequency,
          auto_execute,
          requires_approval
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        payroll.title,
        nextDate.toISOString(),
        "DRAFT",
        "monthly",
        payroll.auto_execute || 0,
        payroll.requires_approval || 1
      );

      console.log("✅ Next monthly payroll created");
    }
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    config: {
      merchantAddress: process.env.MERCHANT_ADDRESS,
      transakApiKey: process.env.TRANSAK_API_KEY,
    }
  });
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(
   ` ARC Pay Mini API running at http://localhost:${PORT}`
  );

  console.log(
   ` merchantAddress = ${MERCHANT_ADDRESS}`
  );

  console.log(
  ` circleKey = ${CIRCLE_API_KEY ? "loaded" : "missing"}`
  );
});