require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");
const nodemailer = require("nodemailer");
const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = Number(process.env.PORT || 3000);

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
  process.env.CIRCLE_WALLET_KEY ||
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

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const ARC_EXPLORER_URL = String(
  process.env.ARC_EXPLORER_URL || "https://testnet.arcscan.app"
);

const USDC_ADDRESS = String(
  process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000"
);
const USDC_DECIMALS = Number(process.env.USDC_DECIMALS || 6);

const PAYOUT_PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;

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
    paidAt TEXT
  )
`).run();

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

try {
  db.prepare("ALTER TABLE claims ADD COLUMN txHash TEXT").run();
} catch {}

/* =========================
   MIDDLEWARE
========================= */

app.use(cors({
  origin: ["http://localhost:5173", "http://localhost:3000"],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   HELPERS
========================= */

function requireCircle(res) {
  if (!CIRCLE_API_KEY) {
    res.status(500).json({
      ok: false,
      error: "Missing CIRCLE_WALLET_KEY or CIRCLE_API_KEY in .env"
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

    const id = makeInvoiceId();

    db.prepare(`
      INSERT INTO invoices (
        id,
        title,
        amount,
        recipientAddress,
        targetChain,
        note,
        status,
        createdAt
      ) VALUES (
        @id,
        @title,
        @amount,
        @recipientAddress,
        @targetChain,
        @note,
        'CREATED',
        @createdAt
      )
    `).run({
      id,
      title,
      amount,
      recipientAddress,
      targetChain,
      note,
      createdAt
    });

    const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);

    res.json({
      ok: true,
      invoice: rowToInvoice(row)
    });
  } catch (error) {
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
    const appUrl = process.env.APP_URL || "http://localhost:3000";
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

    await mailer.sendMail({
      from: `"ArcPay" <${process.env.MAIL_USER}>`,
      to: recipientEmail,
      subject: `You received ${amount} USDC via ArcPay`,
      html: `
        <h2>You received ${amount} USDC</h2>
        <p>${message || "You have a USDC claim waiting for you."}</p>
        <p>Claim your USDC here:</p>
        <p><a href="${claimLink}">${claimLink}</a></p>
      `
    });

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

    res.json({
      success: true,
      message: "USDC claimed successfully",
      walletAddress,
      txHash: tx.hash
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

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`ARC Pay Mini API running at http://localhost:${PORT}`);
  console.log(`merchantAddress = ${MERCHANT_ADDRESS}`);
  console.log(`circleKey = ${CIRCLE_API_KEY ? "loaded" : "missing"}`);
});