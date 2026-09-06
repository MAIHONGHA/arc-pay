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
const { generateJwt } = require("@coinbase/cdp-sdk/auth");
const ARC_MEMO_ADDRESS = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
  const CLAIM_V2_CONTRACT_ADDRESS = String(
  process.env.CLAIM_V2_CONTRACT_ADDRESS || ""
).trim();

if (!CLAIM_V2_CONTRACT_ADDRESS) {
  console.warn(
    "CLAIM_V2_CONTRACT_ADDRESS is not configured."
  );
}

const CLAIM_VERIFIER_PRIVATE_KEY = String(
  process.env.CLAIM_VERIFIER_PRIVATE_KEY || ""
).trim();

const CLAIM_VERIFIER_ADDRESS = String(
  process.env.CLAIM_VERIFIER_ADDRESS || ""
).trim();

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = Number(process.env.PORT || 3000);
const resend = new Resend(process.env.RESEND_API_KEY);

const TRIPLE_A_BASE_URL = String(
  process.env.TRIPLE_A_BASE_URL || "https://api.uat.triple-a.io"
).replace(/\/+$/, "");

const TRIPLE_A_CLIENT_ID = String(
  process.env.TRIPLE_A_CLIENT_ID || ""
).trim();

const TRIPLE_A_CLIENT_SECRET = String(
  process.env.TRIPLE_A_CLIENT_SECRET || ""
).trim();

async function getTripleAAccessToken() {
  if (!TRIPLE_A_CLIENT_ID || !TRIPLE_A_CLIENT_SECRET) {
    throw new Error(
      "Triple-A credentials are not configured."
    );
  }

  const body = new URLSearchParams({
    client_id: TRIPLE_A_CLIENT_ID,
    client_secret: TRIPLE_A_CLIENT_SECRET,
    grant_type: "client_credentials"
  });

  const response = await fetch(
    `${TRIPLE_A_BASE_URL}/api/fiat-payout/v1/oauth/token`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error_description ||
      data?.error ||
      `Triple-A OAuth failed (${response.status}).`
    );
  }

  const accessToken =
    data?.access_token ||
    data?.accessToken ||
    "";

  if (!accessToken) {
    throw new Error(
      "Triple-A OAuth response did not contain an access token."
    );
  }

  return accessToken;
}

const COINBASE_CDP_KEY_NAME = String(
  process.env.COINBASE_CDP_KEY_NAME || ""
).trim();

const COINBASE_CDP_PRIVATE_KEY = String(
  process.env.COINBASE_CDP_PRIVATE_KEY || ""
).trim();

const COINBASE_ONRAMP_HOST = "api.developer.coinbase.com";
const COINBASE_ONRAMP_TOKEN_PATH = "/onramp/v1/token";

function isCoinbaseOnrampConfigured() {
  return Boolean(
    COINBASE_CDP_KEY_NAME &&
    COINBASE_CDP_PRIVATE_KEY
  );
}

async function createCoinbaseOnrampSession({
  walletAddress,
  amount,
  clientIp
}) {
  if (!isCoinbaseOnrampConfigured()) {
    throw new Error(
      "Coinbase Onramp credentials are not configured."
    );
  }

  const jwt = await generateJwt({
    apiKeyId: COINBASE_CDP_KEY_NAME,
    apiKeySecret:
      COINBASE_CDP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    requestMethod: "POST",
    requestHost: COINBASE_ONRAMP_HOST,
    requestPath: COINBASE_ONRAMP_TOKEN_PATH,
    expiresIn: 120
  });

  const response = await fetch(
    `https://${COINBASE_ONRAMP_HOST}${COINBASE_ONRAMP_TOKEN_PATH}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        addresses: [
          {
            address: walletAddress,
            blockchains: ["base"]
          }
        ],
        clientIp: clientIp || "192.0.2.1"
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      `Coinbase Onramp token request failed (${response.status}).`
    );
  }

  const sessionToken =
    String(data?.token || "").trim();

  if (!sessionToken) {
    throw new Error(
      "Coinbase Onramp response did not contain a session token."
    );
  }

  const checkoutUrl =
    "https://pay.coinbase.com/buy/select-asset?" +
    new URLSearchParams({
      sessionToken,
      defaultNetwork: "base",
      defaultAsset: "USDC",
      presetFiatAmount: String(amount),
      partnerUserRef: `tror-${crypto.randomUUID()}`
    }).toString();

  return {
    provider: "coinbase",
    providerStatus: "SESSION_CREATED",
    sessionToken,
    checkoutUrl
  };
}

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
const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);

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

const DATABASE_PATH =
  process.env.DATABASE_PATH ||
  path.join(__dirname, "data.db");

console.log(
  "TROR database:",
  DATABASE_PATH
);

const db =
  new Database(DATABASE_PATH);

db.pragma("journal_mode = WAL");

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT,
    account_type TEXT NOT NULL DEFAULT 'PERSONAL',
    primary_wallet_address TEXT,
    circle_user_id TEXT,
    circle_wallet_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS user_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    identity_type TEXT NOT NULL,
    identity_value TEXT NOT NULL,
    provider TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(identity_type, identity_value)
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON user_identities(user_id)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS user_wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    wallet_type TEXT NOT NULL,
    provider TEXT,
    address TEXT NOT NULL,
    chain_id INTEGER,
    circle_wallet_id TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wallet_type, address, chain_id)
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id
  ON user_wallets(user_id)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_user_wallets_workspace_id
  ON user_wallets(workspace_id)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS wallet_link_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS profile_merge_challenges (
    id TEXT PRIMARY KEY,
    target_user_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_profile_merge_target_user
  ON profile_merge_challenges(target_user_id)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_profile_merge_source_user
  ON profile_merge_challenges(source_user_id)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_profile_merge_wallet
  ON profile_merge_challenges(wallet_address, chain_id)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_wallet_link_challenges_user_id
  ON wallet_link_challenges(user_id)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_wallet_link_challenges_wallet
  ON wallet_link_challenges(wallet_address, chain_id)
`).run();

/* =========================
   IDENTITY / WALLET BACKFILL
========================= */

const legacyUsers = db.prepare(`
  SELECT
    id,
    primary_wallet_address
  FROM users
  WHERE primary_wallet_address IS NOT NULL
    AND trim(primary_wallet_address) != ''
`).all();

const insertWeb3Identity = db.prepare(`
  INSERT OR IGNORE INTO user_identities (
    id,
    user_id,
    identity_type,
    identity_value,
    provider,
    verified_at,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertWeb3Wallet = db.prepare(`
  INSERT OR IGNORE INTO user_wallets (
    id,
    user_id,
    workspace_id,
    wallet_type,
    provider,
    address,
    chain_id,
    circle_wallet_id,
    is_primary,
    is_active,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const backfillLegacyWallets = db.transaction(() => {
  for (const user of legacyUsers) {
    const address = String(
      user.primary_wallet_address || ""
    )
      .trim()
      .toLowerCase();

    if (
      !address ||
      !ethers.isAddress(address)
    ) {
      continue;
    }

    const now =
      new Date().toISOString();

    insertWeb3Identity.run(
      crypto.randomUUID(),
      user.id,
      "WEB3",
      address,
      "legacy",
      now,
      now,
      now
    );

    insertWeb3Wallet.run(
      crypto.randomUUID(),
      user.id,
      null,
      "WEB3",
      "legacy",
      address,
      5042002,
      null,
      1,
      1,
      now,
      now
    );
  }
});

backfillLegacyWallets();

db.prepare(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    workspace_type TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS workspace_members (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'OWNER',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    invited_by_user_id TEXT,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, user_id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS business_profiles (
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    wallet TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    wallet TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_customers_workspace_id
  ON customers(workspace_id)
`).run();

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

try {
  db.prepare(`
    ALTER TABLE payouts
    ADD COLUMN payroll_item_id TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE payouts
    ADD COLUMN workspace_id TEXT
  `).run();

  console.log("workspace_id added to payouts");
} catch {
  console.log("payouts workspace_id already exists");
}

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_payouts_workspace_id
  ON payouts(workspace_id)
`).run();

db.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_payroll_item
  ON payouts(payroll_item_id)
  WHERE payroll_item_id IS NOT NULL
`).run();

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
    ADD COLUMN onchainId INTEGER
  `).run();
} catch {}

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

try {
  db.prepare(`
    ALTER TABLE invoices
    ADD COLUMN paymentMemo TEXT
  `).run();

  console.log("paymentMemo column added");
} catch {
  console.log("paymentMemo already exists");
}

try {
  db.prepare(`
    ALTER TABLE invoices
    ADD COLUMN workspace_id TEXT
  `).run();

  console.log("workspace_id added to invoices");
} catch {
  console.log("invoice workspace_id already exists");
}

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_invoices_workspace_id
  ON invoices(workspace_id)
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
  db.prepare(`
    ALTER TABLE claims
    ADD COLUMN workspace_id TEXT
  `).run();

  console.log("workspace_id added to claims");
} catch {
  console.log("claim workspace_id already exists");
}

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_claims_workspace_id
  ON claims(workspace_id)
`).run();

/* Payment-intent recipient choice claims are verification-only.
   They never authorize wallet delivery or bank payout by themselves. */
for (const columnSql of [
  `ALTER TABLE claims ADD COLUMN payment_intent_id TEXT`,
  `ALTER TABLE claims ADD COLUMN claim_type TEXT`,
  `ALTER TABLE claims ADD COLUMN display_currency TEXT`,
  `ALTER TABLE claims ADD COLUMN choice_recorded_at TEXT`
]) {
  try {
    db.prepare(columnSql).run();
  } catch {}
}

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_claims_payment_intent_id
  ON claims(payment_intent_id)
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    email TEXT,
    amount REAL,
    country TEXT,
    bank_name TEXT,
    account_holder TEXT,
    account_number TEXT,
    claim_id TEXT,
    status TEXT,
    created_at TEXT
)
`).run();

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN workspace_id TEXT
  `).run();
} catch {}

db.prepare(`
CREATE INDEX IF NOT EXISTS idx_withdrawals_workspace_id
ON withdrawals(workspace_id)
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS money_orders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'USDC',
  amount REAL NOT NULL,
  country TEXT NOT NULL,
  fiat_currency TEXT NOT NULL,
  wallet_type TEXT,
  wallet_address TEXT,
  provider TEXT,
  provider_order_id TEXT,
  provider_status TEXT,
  status TEXT NOT NULL,
  checkout_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`).run();

db.prepare(`
CREATE INDEX IF NOT EXISTS idx_money_orders_workspace_id
ON money_orders(workspace_id)
`).run();

db.prepare(`
CREATE INDEX IF NOT EXISTS idx_money_orders_provider_order_id
ON money_orders(provider_order_id)
`).run();


/* =========================
   SEND MONEY PAYMENT INTENTS

   A payment intent records user intent only.
   It does not mean fiat was collected or USDC was settled.
========================= */

db.prepare(`
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sender_country TEXT NOT NULL,
  send_amount REAL NOT NULL,
  send_currency TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_country TEXT NOT NULL,
  receive_method TEXT NOT NULL,
  receive_currency TEXT,
  settlement_asset TEXT NOT NULL DEFAULT 'USDC',
  provider TEXT,
  provider_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'AWAITING_PROVIDER',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`).run();

db.prepare(`
CREATE INDEX IF NOT EXISTS idx_payment_intents_workspace_id
ON payment_intents(workspace_id)
`).run();

db.prepare(`
CREATE INDEX IF NOT EXISTS idx_payment_intents_recipient_email
ON payment_intents(recipient_email)
`).run();

/*
  Recipient delivery is intentionally separate from sender preference.
  These additive columns keep existing databases compatible.
*/
for (const columnSql of [
  `ALTER TABLE payment_intents ADD COLUMN recipient_choice TEXT`,
  `ALTER TABLE payment_intents ADD COLUMN recipient_choice_at TEXT`,
  `ALTER TABLE payment_intents ADD COLUMN funded_at TEXT`,
  `ALTER TABLE payment_intents ADD COLUMN ready_at TEXT`,
  `ALTER TABLE payment_intents ADD COLUMN completed_at TEXT`,
  `ALTER TABLE payment_intents ADD COLUMN recipient_claim_id TEXT`,
  `ALTER TABLE payment_intents ADD COLUMN recipient_claim_sent_at TEXT`
]) {
  try {
    db.prepare(columnSql).run();
  } catch {}
}

// employees master table
db.prepare(`
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    employee_name TEXT NOT NULL,
    employee_email TEXT,
    wallet TEXT,
    base_salary REAL DEFAULT 0,
    employment_status TEXT DEFAULT 'ACTIVE',
    started_at TEXT,
    ended_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

try {
  db.prepare(`
    ALTER TABLE employees
    ADD COLUMN workspace_id TEXT
  `).run();

  console.log("workspace_id added to employees");
} catch {
  console.log("employee workspace_id already exists");
}

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_employees_workspace_id
  ON employees(workspace_id)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_employees_status
  ON employees(employment_status)
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
    ALTER TABLE payroll_batches
    ADD COLUMN workspace_id TEXT
  `).run();

  console.log("workspace_id added to payroll_batches");
} catch {
  console.log("payroll_batches workspace_id already exists");
}

try {
  db.prepare(`
    ALTER TABLE payroll_batches
    ADD COLUMN tx_hash TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE payroll_batches
    ADD COLUMN paid_at TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE payroll_items
    ADD COLUMN workspace_id TEXT
  `).run();

  console.log("workspace_id added to payroll_items");
} catch {
  console.log("payroll_items workspace_id already exists");
}

try {
  db.prepare(`
    ALTER TABLE payroll_items
    ADD COLUMN employee_id TEXT
  `).run();

  console.log("employee_id added to payroll_items");
} catch {
  console.log("payroll_items employee_id already exists");
}

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_payroll_batches_workspace_id
  ON payroll_batches(workspace_id)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_payroll_items_workspace_id
  ON payroll_items(workspace_id)
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
    ALTER TABLE withdrawals
    ADD COLUMN claim_id TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN reviewed_at TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN approved_at TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN completed_at TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN rejected_at TEXT
  `).run();
} catch {}

// Off-ramp provider fields
try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN provider TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN provider_order_id TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN provider_status TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN provider_reference TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN fiat_currency TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN destination_masked TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN processing_at TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN settled_at TEXT
  `).run();
} catch {}

try {
  db.prepare(`
    ALTER TABLE withdrawals
    ADD COLUMN failed_at TEXT
  `).run();
} catch {}

db.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_claim_id
  ON withdrawals(claim_id)
  WHERE claim_id IS NOT NULL
`).run();

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

/* =========================
   USERS
========================= */

app.get("/api/users/:wallet", (req, res) => {
  try {
    const wallet = String(req.params.wallet || "")
      .trim()
      .toLowerCase();

    const user = db.prepare(`
  SELECT DISTINCT u.*
  FROM users u
  LEFT JOIN user_wallets uw
    ON uw.user_id = u.id
  WHERE
    lower(u.primary_wallet_address) = ?
    OR (
      lower(uw.address) = ?
      AND uw.is_active = 1
    )
  LIMIT 1
`).get(
  wallet,
  wallet
);

    if (!user) {
      return res.status(404).json({
        exists: false
      });
    }

const linkedWallet = db.prepare(`
  SELECT
    id,
    user_id,
    wallet_type,
    provider,
    address,
    chain_id,
    is_primary,
    is_active
  FROM user_wallets
  WHERE user_id = ?
    AND lower(address) = ?
    AND is_active = 1
  LIMIT 1
`).get(
  user.id,
  wallet
);

const web3Identity = db.prepare(`
  SELECT
    id,
    user_id,
    identity_type,
    identity_value,
    provider,
    verified_at
  FROM user_identities
  WHERE user_id = ?
    AND identity_type = 'WEB3'
    AND lower(identity_value) = ?
  LIMIT 1
`).get(
  user.id,
  wallet
);

res.json({
  exists: true,
  user,
  wallet: linkedWallet || null,
  web3Identity: web3Identity || null,
  web3Verified: Boolean(
    web3Identity?.verified_at
  )
});

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load user"
    });
  }
});

app.get(
  "/api/users/:userId/wallets",
  (req, res) => {
    try {
      const userId = String(
        req.params.userId || ""
      ).trim();

      if (!userId) {
        return res.status(400).json({
          success: false,
          error:
            "TROR user ID is required"
        });
      }

      const user = db.prepare(`
        SELECT id
        FROM users
        WHERE id = ?
        LIMIT 1
      `).get(userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          error:
            "TROR profile was not found"
        });
      }

      const wallets = db.prepare(`
        SELECT
          uw.id,
          uw.user_id,
          uw.wallet_type,
          uw.provider,
          uw.address,
          uw.chain_id,
          uw.circle_wallet_id,
          uw.is_primary,
          uw.is_active,
          uw.created_at,
          uw.updated_at,

          CASE
            WHEN ui.verified_at IS NOT NULL
            THEN 1
            ELSE 0
          END AS verified

        FROM user_wallets uw

        LEFT JOIN user_identities ui
          ON ui.user_id = uw.user_id
          AND ui.identity_type =
            CASE
              WHEN uw.wallet_type = 'WEB3'
              THEN 'WEB3'
              ELSE NULL
            END
          AND lower(ui.identity_value) =
            lower(uw.address)

        WHERE uw.user_id = ?
          AND uw.is_active = 1

        ORDER BY
          uw.is_primary DESC,
          uw.created_at ASC
      `).all(userId);

      return res.json({
        success: true,
        userId,
        wallets
      });

    } catch (err) {
      console.error(
        "Load TROR user wallets error:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to load TROR user wallets"
      });
    }
  }
);

app.post("/api/users", (req, res) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const accountType = String(
      req.body.accountType || "PERSONAL"
    )
      .trim()
      .toUpperCase();

    const walletAddress = String(
      req.body.walletAddress || ""
    )
      .trim()
      .toLowerCase();

    const circleUserId = String(
      req.body.circleUserId || ""
    ).trim();

    const circleWalletId = String(
      req.body.circleWalletId || ""
    ).trim();

    if (!fullName) {
      return res.status(400).json({
        success: false,
        error: "Full name is required"
      });
    }

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: "Wallet address is required"
      });
    }

    if (!ethers.isAddress(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: "Invalid wallet address"
      });
    }

    const allowedAccountTypes = [
      "PERSONAL",
      "BUSINESS"
    ];

    if (!allowedAccountTypes.includes(accountType)) {
      return res.status(400).json({
        success: false,
        error: "Invalid account type"
      });
    }

    let existingUser = null;

/*
  1. Resolve by any wallet already linked
  to an existing TROR user.
*/
existingUser = db.prepare(`
  SELECT u.*
  FROM users u
  LEFT JOIN user_wallets uw
    ON uw.user_id = u.id
  WHERE
    lower(u.primary_wallet_address) = ?
    OR lower(uw.address) = ?
  LIMIT 1
`).get(
  walletAddress,
  walletAddress
);

/*
  2. If no wallet match, resolve by
  verified Google identity.
*/
if (
  !existingUser &&
  email
) {
  existingUser = db.prepare(`
    SELECT u.*
    FROM users u
    INNER JOIN user_identities ui
      ON ui.user_id = u.id
    WHERE ui.identity_type = 'GOOGLE'
      AND lower(ui.identity_value) = ?
    LIMIT 1
  `).get(email);
}

/*
  3. Legacy fallback for profiles that
  have an email but were created before
  user_identities was populated.
*/
if (
  !existingUser &&
  email
) {
  existingUser = db.prepare(`
    SELECT *
    FROM users
    WHERE lower(email) = ?
    LIMIT 1
  `).get(email);
}

if (existingUser) {
  const existingWorkspace = db.prepare(`
    SELECT
      w.*,
      wm.role,
      wm.status AS member_status,
      wm.joined_at
    FROM workspaces w
    INNER JOIN workspace_members wm
      ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
      AND wm.status = 'ACTIVE'
      AND w.status = 'ACTIVE'
    ORDER BY w.created_at ASC
    LIMIT 1
  `).get(existingUser.id);

  return res.json({
    success: true,
    existing: true,
    user: existingUser,
    workspace: existingWorkspace || null
  });
}

    const userId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const now = new Date().toISOString();

    const createProfile = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (
          id,
          full_name,
          email,
          account_type,
          primary_wallet_address,
          circle_user_id,
          circle_wallet_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        fullName,
        email || null,
        accountType,
        walletAddress,
        circleUserId || null,
        circleWalletId || null,
        now,
        now
      );

      db.prepare(`
        INSERT INTO workspaces (
          id,
          workspace_type,
          workspace_name,
          owner_user_id,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspaceId,
        accountType,
        accountType === "BUSINESS"
          ? `${fullName}'s Business`
          : `${fullName}'s Workspace`,
        userId,
        "ACTIVE",
        now,
        now
      );

      db.prepare(`
        INSERT INTO workspace_members (
          id,
          workspace_id,
          user_id,
          role,
          status,
          invited_by_user_id,
          joined_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memberId,
        workspaceId,
        userId,
        "OWNER",
        "ACTIVE",
        null,
        now,
        now
      );
    });

    createProfile();

    const user = db.prepare(`
      SELECT *
      FROM users
      WHERE id = ?
    `).get(userId);

    const workspace = db.prepare(`
      SELECT *
      FROM workspaces
      WHERE id = ?
    `).get(workspaceId);

    return res.status(201).json({
      success: true,
      user,
      workspace
    });
  } catch (err) {
    console.error("Create user profile error:", err);

    return res.status(500).json({
      success: false,
      error: "Failed to create user profile",
      details: err.message
    });
  }
});

/* =========================
   WEB3 WALLET LINK CHALLENGE
========================= */

app.post(
  "/api/users/:userId/web3-link-challenge",
  async (req, res) => {
    try {
      const userId = String(
        req.params.userId || ""
      ).trim();

      const walletAddress = String(
        req.body.walletAddress || ""
      )
        .trim()
        .toLowerCase();

      const chainId = Number(
        req.body.chainId || 5042002
      );

      const googleAccessToken = String(
        req.body.googleAccessToken || ""
        ).trim();

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: "User ID is required"
        });
      }

      if (
        !walletAddress ||
        !ethers.isAddress(walletAddress)
      ) {
        return res.status(400).json({
          success: false,
          error: "Valid Web3 wallet address is required"
        });
      }

      const user = db.prepare(`
        SELECT id
        FROM users
        WHERE id = ?
      `).get(userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: "TROR user not found"
        });
      }

if (!googleAccessToken) {
  return res.status(401).json({
    success: false,
    error: "Google verification is required"
  });
}

let googleUser;

try {
  googleUser =
    await getGoogleUserFromToken(
      googleAccessToken
    );
} catch (err) {
  return res.status(401).json({
    success: false,
    error:
      "Google verification failed. Please sign in with Google again."
  });
}

const verifiedEmail = String(
  googleUser?.email || ""
)
  .trim()
  .toLowerCase();

const identity = db.prepare(`
  SELECT user_id
  FROM user_identities
  WHERE identity_type = 'GOOGLE'
    AND lower(identity_value) = ?
  LIMIT 1
`).get(verifiedEmail);

if (
  !identity ||
  identity.user_id !== userId
) {
  return res.status(403).json({
    success: false,
    error:
      "Google account does not match this TROR profile"
  });
}

      /*
        Do not issue a linking challenge if
        this wallet already belongs to
        another TROR profile.
      */
      const existingWallet = db.prepare(`
        SELECT user_id
        FROM user_wallets
        WHERE lower(address) = ?
          AND wallet_type = 'WEB3'
          AND chain_id = ?
          AND is_active = 1
        LIMIT 1
      `).get(
        walletAddress,
        chainId
      );

      if (
  existingWallet &&
  existingWallet.user_id !== userId
) {
  return res.status(409).json({
    success: false,
    code: "PROFILE_MERGE_REQUIRED",
    error:
      "This Web3 wallet is already linked to another TROR profile",
    canMerge: true
  });
}

      const challengeId =
        crypto.randomUUID();

      const nonce =
        crypto.randomBytes(32).toString("hex");

      const createdAt =
        new Date();

      const expiresAt =
        new Date(
          createdAt.getTime() +
            5 * 60 * 1000
        );

      const message = [
        "TROR Wallet Link",
        "",
        "Sign this message to verify ownership of your Web3 wallet.",
        "",
        `User ID: ${userId}`,
        `Wallet: ${walletAddress}`,
        `Chain ID: ${chainId}`,
        `Nonce: ${nonce}`,
        `Issued At: ${createdAt.toISOString()}`,
        `Expiration Time: ${expiresAt.toISOString()}`
      ].join("\n");

      db.prepare(`
        INSERT INTO wallet_link_challenges (
          id,
          user_id,
          wallet_address,
          chain_id,
          nonce,
          message,
          expires_at,
          used_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        challengeId,
        userId,
        walletAddress,
        chainId,
        nonce,
        message,
        expiresAt.toISOString(),
        createdAt.toISOString()
      );

      return res.json({
        success: true,
        challengeId,
        message,
        expiresAt:
          expiresAt.toISOString()
      });

    } catch (err) {
      console.error(
        "Create Web3 link challenge error:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to create Web3 wallet link challenge"
      });
    }
  }
);

/* =========================
   PROFILE MERGE CHALLENGE
========================= */

app.post(
  "/api/users/:userId/profile-merge-challenge",
  async (req, res) => {
    try {
      const targetUserId = String(
        req.params.userId || ""
      ).trim();

      const walletAddress = String(
        req.body.walletAddress || ""
      )
        .trim()
        .toLowerCase();

      const chainId = Number(
        req.body.chainId || 5042002
      );

      const googleAccessToken = String(
        req.body.googleAccessToken || ""
      ).trim();

      if (!targetUserId) {
        return res.status(400).json({
          success: false,
          error: "Target TROR user is required"
        });
      }

      if (
        !walletAddress ||
        !ethers.isAddress(walletAddress)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Valid Web3 wallet address is required"
        });
      }

      const targetUser = db.prepare(`
        SELECT id
        FROM users
        WHERE id = ?
        LIMIT 1
      `).get(targetUserId);

      if (!targetUser) {
        return res.status(404).json({
          success: false,
          error: "Target TROR profile not found"
        });
      }

      /*
        Verify ownership of the currently
        active target profile through Google.
      */
      if (!googleAccessToken) {
        return res.status(401).json({
          success: false,
          error:
            "Google verification is required before merging profiles"
        });
      }

      let googleUser;

      try {
        googleUser =
          await getGoogleUserFromToken(
            googleAccessToken
          );
      } catch {
        return res.status(401).json({
          success: false,
          error:
            "Google verification failed. Please sign in with Google again."
        });
      }

      const verifiedEmail = String(
        googleUser?.email || ""
      )
        .trim()
        .toLowerCase();

      let targetGoogleIdentity =
  db.prepare(`
    SELECT *
    FROM user_identities
    WHERE identity_type = 'GOOGLE'
      AND lower(identity_value) = ?
    LIMIT 1
  `).get(verifiedEmail);

if (
  targetGoogleIdentity &&
  targetGoogleIdentity.user_id !==
    targetUserId
) {
  return res.status(403).json({
    success: false,
    error:
      "This Google account is already linked to another TROR profile"
  });
}

/*
  Legacy recovery:
  some older TROR profiles have users.email
  populated but no GOOGLE identity row yet.
*/
if (!targetGoogleIdentity) {
  const legacyTargetUser =
    db.prepare(`
      SELECT
        id,
        email
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(targetUserId);

  const legacyEmail = String(
    legacyTargetUser?.email || ""
  )
    .trim()
    .toLowerCase();

  if (
    !legacyTargetUser ||
    !legacyEmail ||
    legacyEmail !== verifiedEmail
  ) {
    return res.status(403).json({
      success: false,
      error:
        "Google account does not match the active TROR profile"
    });
  }

  const now =
    new Date().toISOString();

  db.prepare(`
    INSERT INTO user_identities (
      id,
      user_id,
      identity_type,
      identity_value,
      provider,
      verified_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    targetUserId,
    "GOOGLE",
    verifiedEmail,
    "google",
    now,
    now,
    now
  );

  targetGoogleIdentity = {
    user_id: targetUserId
  };
}

      /*
        Resolve the source profile entirely
        on the backend from the conflict wallet.
        Never trust sourceUserId from the client.
      */
      const sourceWallet = db.prepare(`
        SELECT
          id,
          user_id,
          address,
          chain_id
        FROM user_wallets
        WHERE lower(address) = ?
          AND wallet_type = 'WEB3'
          AND chain_id = ?
          AND is_active = 1
        LIMIT 1
      `).get(
        walletAddress,
        chainId
      );

      if (!sourceWallet) {
        return res.status(404).json({
          success: false,
          error:
            "The Web3 wallet is not linked to another TROR profile"
        });
      }

      const sourceUserId =
        String(sourceWallet.user_id || "");

      if (
        !sourceUserId ||
        sourceUserId === targetUserId
      ) {
        return res.status(409).json({
          success: false,
          error:
            "These identities already belong to the same TROR profile"
        });
      }

      const sourceUser = db.prepare(`
        SELECT id
        FROM users
        WHERE id = ?
        LIMIT 1
      `).get(sourceUserId);

      if (!sourceUser) {
        return res.status(404).json({
          success: false,
          error:
            "Source TROR profile was not found"
        });
      }

      const challengeId =
        crypto.randomUUID();

      const nonce =
        crypto.randomBytes(32).toString("hex");

      const createdAt = new Date();

      const expiresAt = new Date(
        createdAt.getTime() +
          5 * 60 * 1000
      );

      const message = [
        "TROR Profile Merge",
        "",
        "Sign this message to prove ownership of the Web3 wallet before merging TROR profiles.",
        "",
        `Wallet: ${walletAddress}`,
        `Chain ID: ${chainId}`,
        `Nonce: ${nonce}`,
        `Issued At: ${createdAt.toISOString()}`,
        `Expiration Time: ${expiresAt.toISOString()}`
      ].join("\n");

      db.prepare(`
        INSERT INTO profile_merge_challenges (
          id,
          target_user_id,
          source_user_id,
          wallet_address,
          chain_id,
          nonce,
          message,
          expires_at,
          used_at,
          created_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
        )
      `).run(
        challengeId,
        targetUserId,
        sourceUserId,
        walletAddress,
        chainId,
        nonce,
        message,
        expiresAt.toISOString(),
        createdAt.toISOString()
      );

      return res.json({
        success: true,
        challengeId,
        message,
        expiresAt:
          expiresAt.toISOString(),
        requiresWalletSignature: true
      });
    } catch (err) {
      console.error(
        "Create profile merge challenge error:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to create profile merge challenge"
      });
    }
  }
);

/* =========================
   PROFILE MERGE VERIFY
========================= */

app.post(
  "/api/users/:userId/profile-merge-verify",
  (req, res) => {
    try {
      const targetUserId = String(
        req.params.userId || ""
      ).trim();

      const challengeId = String(
        req.body.challengeId || ""
      ).trim();

      const signature = String(
        req.body.signature || ""
      ).trim();

      if (!targetUserId) {
        return res.status(400).json({
          success: false,
          error: "Target TROR user is required"
        });
      }

      if (!challengeId) {
        return res.status(400).json({
          success: false,
          error: "Merge challenge ID is required"
        });
      }

      if (
        !signature ||
        !signature.startsWith("0x")
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Valid Web3 wallet signature is required"
        });
      }

      const challenge = db.prepare(`
        SELECT *
        FROM profile_merge_challenges
        WHERE id = ?
          AND target_user_id = ?
        LIMIT 1
      `).get(
        challengeId,
        targetUserId
      );

      if (!challenge) {
        return res.status(404).json({
          success: false,
          error:
            "Profile merge challenge not found"
        });
      }

      if (challenge.used_at) {
        return res.status(409).json({
          success: false,
          error:
            "This profile merge challenge has already been used"
        });
      }

      const expiresAt =
        Date.parse(challenge.expires_at);

      if (
        !Number.isFinite(expiresAt) ||
        Date.now() > expiresAt
      ) {
        return res.status(410).json({
          success: false,
          error:
            "Profile merge challenge has expired"
        });
      }

      let recoveredAddress;

      try {
        recoveredAddress =
          ethers.verifyMessage(
            challenge.message,
            signature
          );
      } catch {
        return res.status(400).json({
          success: false,
          error:
            "Invalid Web3 wallet signature"
        });
      }

      const normalizedRecovered =
        String(recoveredAddress || "")
          .trim()
          .toLowerCase();

      const normalizedExpected =
        String(
          challenge.wallet_address || ""
        )
          .trim()
          .toLowerCase();

      if (
        !normalizedRecovered ||
        normalizedRecovered !==
          normalizedExpected
      ) {
        return res.status(403).json({
          success: false,
          error:
            "Signature does not match the merge wallet"
        });
      }

      const targetUser = db.prepare(`
        SELECT
          id,
          full_name,
          email,
          account_type,
          primary_wallet_address
        FROM users
        WHERE id = ?
        LIMIT 1
      `).get(targetUserId);

      const sourceUser = db.prepare(`
        SELECT
          id,
          full_name,
          email,
          account_type,
          primary_wallet_address
        FROM users
        WHERE id = ?
        LIMIT 1
      `).get(
        challenge.source_user_id
      );

      if (!targetUser || !sourceUser) {
        return res.status(404).json({
          success: false,
          error:
            "One of the TROR profiles no longer exists"
        });
      }

      if (
        sourceUser.id ===
        targetUser.id
      ) {
        return res.status(409).json({
          success: false,
          error:
            "These identities already belong to the same TROR profile"
        });
      }

      /*
        Reconfirm that the signed wallet
        still belongs to the source profile.
      */
      const sourceWallet = db.prepare(`
        SELECT
          id,
          user_id,
          wallet_type,
          provider,
          address,
          chain_id,
          is_primary,
          is_active
        FROM user_wallets
        WHERE user_id = ?
          AND lower(address) = ?
          AND wallet_type = 'WEB3'
          AND chain_id = ?
          AND is_active = 1
        LIMIT 1
      `).get(
        sourceUser.id,
        normalizedExpected,
        challenge.chain_id
      );

      if (!sourceWallet) {
        return res.status(409).json({
          success: false,
          error:
            "The signed Web3 wallet no longer belongs to the source TROR profile"
        });
      }

      const targetWallets = db.prepare(`
        SELECT
          wallet_type,
          provider,
          address,
          chain_id,
          circle_wallet_id,
          is_primary,
          is_active
        FROM user_wallets
        WHERE user_id = ?
          AND is_active = 1
        ORDER BY
          is_primary DESC,
          created_at ASC
      `).all(targetUser.id);

      const sourceWallets = db.prepare(`
        SELECT
          wallet_type,
          provider,
          address,
          chain_id,
          circle_wallet_id,
          is_primary,
          is_active
        FROM user_wallets
        WHERE user_id = ?
          AND is_active = 1
        ORDER BY
          is_primary DESC,
          created_at ASC
      `).all(sourceUser.id);

      const targetWorkspaces = db.prepare(`
        SELECT
          id,
          workspace_type,
          workspace_name,
          owner_user_id
        FROM workspaces
        WHERE owner_user_id = ?
        ORDER BY created_at ASC
      `).all(targetUser.id);

      const sourceWorkspaces = db.prepare(`
        SELECT
          id,
          workspace_type,
          workspace_name,
          owner_user_id
        FROM workspaces
        WHERE owner_user_id = ?
        ORDER BY created_at ASC
      `).all(sourceUser.id);

      return res.json({
        success: true,
        verified: true,
        requiresConfirmation: true,
        challengeId,
        preview: {
          targetProfile: targetUser,
          sourceProfile: sourceUser,
          targetWallets,
          sourceWallets,
          targetWorkspaces,
          sourceWorkspaces
        }
      });
    } catch (err) {
      console.error(
        "Verify profile merge challenge error:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to verify profile merge challenge"
      });
    }
  }
);

/* =========================
   PROFILE MERGE CONFIRM
========================= */

app.post(
  "/api/users/:userId/profile-merge-confirm",
  async (req, res) => {
    try {
      const targetUserId = String(
        req.params.userId || ""
      ).trim();

      const challengeId = String(
        req.body.challengeId || ""
      ).trim();

      const signature = String(
        req.body.signature || ""
      ).trim();

const googleAccessToken = String(
  req.body.googleAccessToken || ""
).trim();

      if (!targetUserId) {
        return res.status(400).json({
          success: false,
          error: "Target TROR user is required"
        });
      }

      if (!challengeId) {
        return res.status(400).json({
          success: false,
          error: "Merge challenge ID is required"
        });
      }

      if (
        !signature ||
        !signature.startsWith("0x")
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Valid Web3 wallet signature is required"
        });
      }

if (!googleAccessToken) {
  return res.status(401).json({
    success: false,
    error:
      "Google verification is required before confirming profile merge"
  });
}

let googleUser;

try {
  googleUser =
    await getGoogleUserFromToken(
      googleAccessToken
    );
} catch {
  return res.status(401).json({
    success: false,
    error:
      "Google verification failed. Please sign in with Google again."
  });
}

const verifiedEmail = String(
  googleUser?.email || ""
)
  .trim()
  .toLowerCase();

const targetGoogleIdentity =
  db.prepare(`
    SELECT user_id
    FROM user_identities
    WHERE identity_type = 'GOOGLE'
      AND lower(identity_value) = ?
    LIMIT 1
  `).get(verifiedEmail);

if (
  !targetGoogleIdentity ||
  targetGoogleIdentity.user_id !==
    targetUserId
) {
  return res.status(403).json({
    success: false,
    error:
      "Google account does not match the target TROR profile"
  });
}

      const challenge = db.prepare(`
        SELECT *
        FROM profile_merge_challenges
        WHERE id = ?
          AND target_user_id = ?
        LIMIT 1
      `).get(
        challengeId,
        targetUserId
      );

      if (!challenge) {
        return res.status(404).json({
          success: false,
          error:
            "Profile merge challenge not found"
        });
      }

      if (challenge.used_at) {
        return res.status(409).json({
          success: false,
          error:
            "This profile merge challenge has already been used"
        });
      }

      const expiresAt =
        Date.parse(challenge.expires_at);

      if (
        !Number.isFinite(expiresAt) ||
        Date.now() > expiresAt
      ) {
        return res.status(410).json({
          success: false,
          error:
            "Profile merge challenge has expired"
        });
      }

      /*
        Verify the Web3 proof again.
        Preview verification alone is not enough
        to authorize the final merge.
      */
      let recoveredAddress;

      try {
        recoveredAddress =
          ethers.verifyMessage(
            challenge.message,
            signature
          );
      } catch {
        return res.status(400).json({
          success: false,
          error:
            "Invalid Web3 wallet signature"
        });
      }

      const normalizedRecovered =
        String(recoveredAddress || "")
          .trim()
          .toLowerCase();

      const normalizedExpected =
        String(
          challenge.wallet_address || ""
        )
          .trim()
          .toLowerCase();

      if (
        !normalizedRecovered ||
        normalizedRecovered !==
          normalizedExpected
      ) {
        return res.status(403).json({
          success: false,
          error:
            "Signature does not match the merge wallet"
        });
      }

      const sourceUserId = String(
        challenge.source_user_id || ""
      ).trim();

      if (
        !sourceUserId ||
        sourceUserId === targetUserId
      ) {
        return res.status(409).json({
          success: false,
          error:
            "Source and target profiles are invalid"
        });
      }

      const now =
        new Date().toISOString();

      const mergeProfiles =
        db.transaction(() => {

          /*
            Re-read challenge inside transaction.
          */
          const freshChallenge =
            db.prepare(`
              SELECT *
              FROM profile_merge_challenges
              WHERE id = ?
                AND target_user_id = ?
              LIMIT 1
            `).get(
              challengeId,
              targetUserId
            );

          if (
            !freshChallenge ||
            freshChallenge.used_at
          ) {
            const err =
              new Error(
                "Profile merge challenge already used"
              );

            err.code =
              "MERGE_CHALLENGE_USED";

            throw err;
          }

          const freshExpiresAt =
            Date.parse(
              freshChallenge.expires_at
            );

          if (
            !Number.isFinite(
              freshExpiresAt
            ) ||
            Date.now() >
              freshExpiresAt
          ) {
            const err =
              new Error(
                "Profile merge challenge expired"
              );

            err.code =
              "MERGE_CHALLENGE_EXPIRED";

            throw err;
          }

          const targetUser =
            db.prepare(`
              SELECT *
              FROM users
              WHERE id = ?
              LIMIT 1
            `).get(targetUserId);

          const sourceUser =
            db.prepare(`
              SELECT *
              FROM users
              WHERE id = ?
              LIMIT 1
            `).get(sourceUserId);

          if (
            !targetUser ||
            !sourceUser
          ) {
            const err =
              new Error(
                "One of the TROR profiles no longer exists"
              );

            err.code =
              "PROFILE_NOT_FOUND";

            throw err;
          }

          /*
            Reconfirm that the signed wallet
            still belongs to the source profile.
          */
          const sourceProofWallet =
            db.prepare(`
              SELECT *
              FROM user_wallets
              WHERE user_id = ?
                AND lower(address) = ?
                AND wallet_type = 'WEB3'
                AND chain_id = ?
                AND is_active = 1
              LIMIT 1
            `).get(
              sourceUserId,
              normalizedExpected,
              freshChallenge.chain_id
            );

          if (!sourceProofWallet) {
            const err =
              new Error(
                "Signed wallet no longer belongs to source profile"
              );

            err.code =
              "SOURCE_WALLET_CHANGED";

            throw err;
          }

          /*
            Move all source identities
            to the canonical target user.
          */
          db.prepare(`
            UPDATE user_identities
            SET
              user_id = ?,
              updated_at = ?
            WHERE user_id = ?
          `).run(
            targetUserId,
            now,
            sourceUserId
          );

          /*
            Move all source wallets.
            Source primary flags are cleared;
            target keeps its canonical primary.
          */
          db.prepare(`
            UPDATE user_wallets
            SET
              user_id = ?,
              is_primary = 0,
              updated_at = ?
            WHERE user_id = ?
          `).run(
            targetUserId,
            now,
            sourceUserId
          );

          /*
            Preserve all workspace IDs and data.
            Only ownership changes.
          */
          db.prepare(`
            UPDATE workspaces
            SET
              owner_user_id = ?,
              updated_at = ?
            WHERE owner_user_id = ?
          `).run(
            targetUserId,
            now,
            sourceUserId
          );

          /*
            Transfer memberships safely.

            If target already has membership
            in the same workspace, combine them
            instead of violating UNIQUE().
          */
          const sourceMemberships =
            db.prepare(`
              SELECT *
              FROM workspace_members
              WHERE user_id = ?
            `).all(sourceUserId);

          for (
            const membership
            of sourceMemberships
          ) {
            const targetMembership =
              db.prepare(`
                SELECT *
                FROM workspace_members
                WHERE workspace_id = ?
                  AND user_id = ?
                LIMIT 1
              `).get(
                membership.workspace_id,
                targetUserId
              );

            if (targetMembership) {
              const mergedRole =
                membership.role === "OWNER" ||
                targetMembership.role === "OWNER"
                  ? "OWNER"
                  : targetMembership.role;

              const mergedStatus =
                membership.status === "ACTIVE" ||
                targetMembership.status === "ACTIVE"
                  ? "ACTIVE"
                  : targetMembership.status;

              db.prepare(`
                UPDATE workspace_members
                SET
                  role = ?,
                  status = ?
                WHERE id = ?
              `).run(
                mergedRole,
                mergedStatus,
                targetMembership.id
              );

              db.prepare(`
                DELETE FROM workspace_members
                WHERE id = ?
              `).run(
                membership.id
              );
            } else {
              db.prepare(`
                UPDATE workspace_members
                SET user_id = ?
                WHERE id = ?
              `).run(
                targetUserId,
                membership.id
              );
            }
          }

          /*
            Any invitations created by source
            now reference canonical target.
          */
          db.prepare(`
            UPDATE workspace_members
            SET invited_by_user_id = ?
            WHERE invited_by_user_id = ?
          `).run(
            targetUserId,
            sourceUserId
          );

          /*
            Backfill legacy Circle fields only
            when target does not already have them.
          */
          db.prepare(`
            UPDATE users
            SET
              circle_user_id =
                COALESCE(
                  circle_user_id,
                  ?
                ),
              circle_wallet_id =
                COALESCE(
                  circle_wallet_id,
                  ?
                ),
              updated_at = ?
            WHERE id = ?
          `).run(
            sourceUser.circle_user_id ||
              null,
            sourceUser.circle_wallet_id ||
              null,
            now,
            targetUserId
          );

          /*
            Old source wallet-link challenges
            must not remain usable after merge.
          */
          db.prepare(`
            DELETE FROM wallet_link_challenges
            WHERE user_id = ?
          `).run(sourceUserId);

          /*
            Consume this merge challenge only
            after all transfers succeeded.
          */
          db.prepare(`
            UPDATE profile_merge_challenges
            SET used_at = ?
            WHERE id = ?
              AND used_at IS NULL
          `).run(
            now,
            challengeId
          );

          /*
            Source user is removed last.
            All identities, wallets and workspaces
            already belong to target at this point.
          */
          db.prepare(`
            DELETE FROM users
            WHERE id = ?
          `).run(sourceUserId);

          const mergedUser =
            db.prepare(`
              SELECT *
              FROM users
              WHERE id = ?
            `).get(targetUserId);

          const wallets =
            db.prepare(`
              SELECT *
              FROM user_wallets
              WHERE user_id = ?
                AND is_active = 1
              ORDER BY
                is_primary DESC,
                created_at ASC
            `).all(targetUserId);

          const workspaces =
            db.prepare(`
              SELECT
                w.*,
                wm.role,
                wm.status AS member_status
              FROM workspaces w
              INNER JOIN workspace_members wm
                ON wm.workspace_id = w.id
              WHERE wm.user_id = ?
                AND wm.status = 'ACTIVE'
                AND w.status = 'ACTIVE'
              ORDER BY w.created_at ASC
            `).all(targetUserId);

          return {
            user: mergedUser,
            wallets,
            workspaces
          };
        });

      let result;

      try {
        result =
          mergeProfiles();
      } catch (err) {
        if (
          err.code ===
          "MERGE_CHALLENGE_USED"
        ) {
          return res.status(409).json({
            success: false,
            error:
              "Profile merge challenge has already been used"
          });
        }

        if (
          err.code ===
          "MERGE_CHALLENGE_EXPIRED"
        ) {
          return res.status(410).json({
            success: false,
            error:
              "Profile merge challenge has expired"
          });
        }

        if (
          err.code ===
          "PROFILE_NOT_FOUND" ||
          err.code ===
          "SOURCE_WALLET_CHANGED"
        ) {
          return res.status(409).json({
            success: false,
            error: err.message
          });
        }

        throw err;
      }

      return res.json({
        success: true,
        merged: true,
        canonicalUserId:
          targetUserId,
        removedSourceUserId:
          sourceUserId,
        user: result.user,
        wallets: result.wallets,
        workspaces: result.workspaces
      });

    } catch (err) {
      console.error(
        "Confirm profile merge error:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to merge TROR profiles",
        details: err.message
      });
    }
  }
);

/* =========================
   WEB3 WALLET LINK VERIFY
========================= */

app.post(
  "/api/users/:userId/web3-link-verify",
  (req, res) => {
    try {
      const userId = String(
        req.params.userId || ""
      ).trim();

      const challengeId = String(
        req.body.challengeId || ""
      ).trim();

      const signature = String(
        req.body.signature || ""
      ).trim();

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: "User ID is required"
        });
      }

      if (!challengeId) {
        return res.status(400).json({
          success: false,
          error: "Challenge ID is required"
        });
      }

      if (
        !signature ||
        !signature.startsWith("0x")
      ) {
        return res.status(400).json({
          success: false,
          error: "Valid wallet signature is required"
        });
      }

      const challenge = db.prepare(`
        SELECT *
        FROM wallet_link_challenges
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `).get(
        challengeId,
        userId
      );

      if (!challenge) {
        return res.status(404).json({
          success: false,
          error: "Wallet link challenge not found"
        });
      }

      if (challenge.used_at) {
        return res.status(409).json({
          success: false,
          error:
            "This wallet link challenge has already been used"
        });
      }

      const expiresAt =
        Date.parse(challenge.expires_at);

      if (
        !Number.isFinite(expiresAt) ||
        Date.now() > expiresAt
      ) {
        return res.status(410).json({
          success: false,
          error:
            "Wallet link challenge has expired"
        });
      }

      let recoveredAddress;

      try {
        recoveredAddress =
          ethers.verifyMessage(
            challenge.message,
            signature
          );
      } catch (err) {
        return res.status(400).json({
          success: false,
          error: "Invalid wallet signature"
        });
      }

      const normalizedRecovered =
        String(recoveredAddress || "")
          .trim()
          .toLowerCase();

      const normalizedExpected =
        String(
          challenge.wallet_address || ""
        )
          .trim()
          .toLowerCase();

      if (
        !normalizedRecovered ||
        normalizedRecovered !==
          normalizedExpected
      ) {
        return res.status(403).json({
          success: false,
          error:
            "Signature does not match the wallet being linked"
        });
      }

      const now =
        new Date().toISOString();

      const linkWallet =
        db.transaction(() => {

          /*
            Recheck challenge inside transaction
            so it cannot be reused concurrently.
          */
          const freshChallenge =
            db.prepare(`
              SELECT *
              FROM wallet_link_challenges
              WHERE id = ?
                AND user_id = ?
              LIMIT 1
            `).get(
              challengeId,
              userId
            );

          if (
            !freshChallenge ||
            freshChallenge.used_at
          ) {
            const err =
              new Error(
                "Wallet link challenge already used"
              );

            err.code =
              "CHALLENGE_USED";

            throw err;
          }

const freshExpiresAt =
  Date.parse(
    freshChallenge.expires_at
  );

if (
  !Number.isFinite(
    freshExpiresAt
  ) ||
  Date.now() >
    freshExpiresAt
) {
  const err =
    new Error(
      "Wallet link challenge expired"
    );

  err.code =
    "CHALLENGE_EXPIRED";

  throw err;
}

          /*
            Recheck wallet ownership conflict.
          */
          const existingWallet =
            db.prepare(`
              SELECT *
              FROM user_wallets
              WHERE lower(address) = ?
                AND wallet_type = 'WEB3'
                AND chain_id = ?
              LIMIT 1
            `).get(
              normalizedExpected,
              challenge.chain_id
            );

          if (
            existingWallet &&
            existingWallet.user_id !==
              userId
          ) {
            const err =
              new Error(
                "Wallet belongs to another TROR profile"
              );

            err.code =
              "WALLET_CONFLICT";

            throw err;
          }

          /*
            Identity must also not belong
            to another TROR profile.
          */
          const existingIdentity =
            db.prepare(`
              SELECT *
              FROM user_identities
              WHERE identity_type = 'WEB3'
                AND lower(identity_value) = ?
              LIMIT 1
            `).get(
              normalizedExpected
            );

          if (
            existingIdentity &&
            existingIdentity.user_id !==
              userId
          ) {
            const err =
              new Error(
                "Web3 identity belongs to another TROR profile"
              );

            err.code =
              "IDENTITY_CONFLICT";

            throw err;
          }

          /*
            Update existing wallet for same user,
            otherwise create a new linked wallet.
          */
          if (existingWallet) {
            db.prepare(`
              UPDATE user_wallets
              SET
                provider = 'web3',
                is_active = 1,
                updated_at = ?
              WHERE id = ?
            `).run(
              now,
              existingWallet.id
            );
          } else {
            const activeWeb3Wallet =
              db.prepare(`
                SELECT id
                FROM user_wallets
                WHERE user_id = ?
                  AND wallet_type = 'WEB3'
                  AND is_active = 1
                LIMIT 1
              `).get(userId);

            db.prepare(`
              INSERT INTO user_wallets (
                id,
                user_id,
                workspace_id,
                wallet_type,
                provider,
                address,
                chain_id,
                circle_wallet_id,
                is_primary,
                is_active,
                created_at,
                updated_at
              )
              VALUES (
                ?, ?, NULL,
                'WEB3',
                'web3',
                ?, ?,
                NULL,
                ?, 1,
                ?, ?
              )
            `).run(
              crypto.randomUUID(),
              userId,
              normalizedExpected,
              challenge.chain_id,
              activeWeb3Wallet ? 0 : 1,
              now,
              now
            );
          }

          /*
            Promote legacy WEB3 identity
            to cryptographically verified,
            or create it if missing.
          */
          if (existingIdentity) {
            db.prepare(`
              UPDATE user_identities
              SET
                provider = 'web3',
                verified_at = ?,
                updated_at = ?
              WHERE id = ?
            `).run(
              now,
              now,
              existingIdentity.id
            );
          } else {
            db.prepare(`
              INSERT INTO user_identities (
                id,
                user_id,
                identity_type,
                identity_value,
                provider,
                verified_at,
                created_at,
                updated_at
              )
              VALUES (
                ?, ?,
                'WEB3',
                ?,
                'web3',
                ?,
                ?, ?
              )
            `).run(
              crypto.randomUUID(),
              userId,
              normalizedExpected,
              now,
              now,
              now
            );
          }

          /*
            Consume challenge only after
            wallet + identity linking succeeds.
          */
          db.prepare(`
            UPDATE wallet_link_challenges
            SET used_at = ?
            WHERE id = ?
              AND used_at IS NULL
          `).run(
            now,
            challengeId
          );

          return db.prepare(`
            SELECT *
            FROM user_wallets
            WHERE user_id = ?
              AND is_active = 1
            ORDER BY
              is_primary DESC,
              created_at ASC
          `).all(userId);
        });

      let wallets;

      try {
        wallets = linkWallet();
      } catch (err) {
        if (
          err.code ===
          "CHALLENGE_USED"
        ) {
          return res.status(409).json({
            success: false,
            error:
              "This wallet link challenge has already been used"
          });
        }

if (
  err.code ===
  "CHALLENGE_EXPIRED"
) {
  return res.status(410).json({
    success: false,
    error:
      "Wallet link challenge has expired"
  });
}

        if (
          err.code ===
            "WALLET_CONFLICT" ||
          err.code ===
            "IDENTITY_CONFLICT"
        ) {
          return res.status(409).json({
            success: false,
            error:
              "This Web3 wallet is already linked to another TROR profile"
          });
        }

        throw err;
      }

      return res.json({
        success: true,
        verified: true,
        walletAddress:
          normalizedExpected,
        chainId:
          challenge.chain_id,
        wallets
      });

    } catch (err) {
      console.error(
        "Verify Web3 wallet link error:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to verify Web3 wallet link"
      });
    }
  }
);

app.post(
  "/api/users/:userId/link-circle-wallet",
  (req, res) => {
    try {
      const userId = String(
        req.params.userId || ""
      ).trim();

      const email = String(
        req.body.email || ""
      )
        .trim()
        .toLowerCase();

      const walletAddress = String(
        req.body.walletAddress || ""
      )
        .trim()
        .toLowerCase();

      const circleWalletId = String(
        req.body.circleWalletId || ""
      ).trim();

      const chainId = Number(
        req.body.chainId || 5042002
      );

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: "User ID is required"
        });
      }

      const user = db.prepare(`
        SELECT *
        FROM users
        WHERE id = ?
      `).get(userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: "TROR user not found"
        });
      }

      if (
        !walletAddress ||
        !ethers.isAddress(walletAddress)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Valid Circle wallet address is required"
        });
      }

      const now =
        new Date().toISOString();

      const linkCircle =
        db.transaction(() => {

          /*
            Link verified Google identity.

            We only add this when the frontend
            reached this endpoint through the
            authenticated Google/Circle flow.
          */
          if (email) {
            const existingIdentity =
              db.prepare(`
                SELECT *
                FROM user_identities
                WHERE identity_type = 'GOOGLE'
                  AND lower(identity_value) = ?
              `).get(email);

            if (
              existingIdentity &&
              existingIdentity.user_id !== userId
            ) {
              throw new Error(
                "This Google account is already linked to another TROR profile"
              );
            }

            if (!existingIdentity) {
              db.prepare(`
                INSERT INTO user_identities (
                  id,
                  user_id,
                  identity_type,
                  identity_value,
                  provider,
                  verified_at,
                  created_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                crypto.randomUUID(),
                userId,
                "GOOGLE",
                email,
                "google",
                now,
                now,
                now
              );
            }
          }

          const existingWallet =
            db.prepare(`
              SELECT *
              FROM user_wallets
              WHERE lower(address) = ?
                AND wallet_type = 'CIRCLE'
                AND chain_id = ?
            `).get(
              walletAddress,
              chainId
            );

          if (
            existingWallet &&
            existingWallet.user_id !== userId
          ) {
            throw new Error(
              "This Circle wallet is already linked to another TROR profile"
            );
          }

          if (existingWallet) {
            db.prepare(`
              UPDATE user_wallets
              SET
                circle_wallet_id = ?,
                provider = 'circle',
                is_active = 1,
                updated_at = ?
              WHERE id = ?
            `).run(
              circleWalletId || null,
              now,
              existingWallet.id
            );
          } else {
            db.prepare(`
              INSERT INTO user_wallets (
                id,
                user_id,
                workspace_id,
                wallet_type,
                provider,
                address,
                chain_id,
                circle_wallet_id,
                is_primary,
                is_active,
                created_at,
                updated_at
              )
              VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?
              )
            `).run(
              crypto.randomUUID(),
              userId,
              null,
              "CIRCLE",
              "circle",
              walletAddress,
              chainId,
              circleWalletId || null,
              0,
              1,
              now,
              now
            );
          }

          /*
            Keep legacy columns populated
            during migration.
          */
          db.prepare(`
            UPDATE users
            SET
              circle_wallet_id = COALESCE(
                ?,
                circle_wallet_id
              ),
              updated_at = ?
            WHERE id = ?
          `).run(
            circleWalletId || null,
            now,
            userId
          );
        });

      linkCircle();

      const wallets =
        db.prepare(`
          SELECT *
          FROM user_wallets
          WHERE user_id = ?
            AND is_active = 1
          ORDER BY
            is_primary DESC,
            created_at ASC
        `).all(userId);

      return res.json({
        success: true,
        userId,
        wallets
      });

    } catch (err) {
      console.error(
        "Link Circle wallet error:",
        err
      );

      return res.status(409).json({
        success: false,
        error:
          err?.message ||
          "Failed to link Circle wallet"
      });
    }
  }
);

/* =========================
   WORKSPACES
========================= */

// Get all workspaces belonging to a wallet
app.get("/api/workspaces/:wallet", (req, res) => {
  try {
    const walletAddress = String(
      req.params.wallet || ""
    )
      .trim()
      .toLowerCase();

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: "Wallet address is required"
      });
    }

    if (!ethers.isAddress(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: "Invalid wallet address"
      });
    }

    const user = db.prepare(`
  SELECT DISTINCT u.*
  FROM users u
  LEFT JOIN user_wallets uw
    ON uw.user_id = u.id
  WHERE
    lower(u.primary_wallet_address) = ?
    OR (
      lower(uw.address) = ?
      AND uw.is_active = 1
    )
  LIMIT 1
`).get(
  walletAddress,
  walletAddress
);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User profile not found",
        workspaces: []
      });
    }

    const workspaces = db.prepare(`
      SELECT
        w.*,
        wm.role,
        wm.status AS member_status,
        wm.joined_at
      FROM workspaces w
      INNER JOIN workspace_members wm
        ON wm.workspace_id = w.id
      WHERE wm.user_id = ?
        AND wm.status = 'ACTIVE'
        AND w.status = 'ACTIVE'
      ORDER BY w.created_at ASC
    `).all(user.id);

    return res.json({
      success: true,
      userId: user.id,
      workspaces
    });
  } catch (err) {
    console.error("Load workspaces error:", err);

    return res.status(500).json({
      success: false,
      error: "Failed to load workspaces",
      details: err.message
    });
  }
});

app.post("/api/workspaces", (req, res) => {
  try {
    const walletAddress = String(
      req.body.walletAddress || ""
    )
      .trim()
      .toLowerCase();

    const workspaceName = String(
      req.body.workspaceName || ""
    ).trim();

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: "Wallet address is required"
      });
    }

    if (!ethers.isAddress(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: "Invalid wallet address"
      });
    }

    if (!workspaceName) {
      return res.status(400).json({
        success: false,
        error: "Workspace name is required"
      });
    }

    const user = db.prepare(`
  SELECT DISTINCT u.*
  FROM users u
  LEFT JOIN user_wallets uw
    ON uw.user_id = u.id
  WHERE
    lower(u.primary_wallet_address) = ?
    OR (
      lower(uw.address) = ?
      AND uw.is_active = 1
    )
  LIMIT 1
`).get(
  walletAddress,
  walletAddress
);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User profile not found"
      });
    }

    const duplicate = db.prepare(`
      SELECT *
      FROM workspaces
      WHERE owner_user_id = ?
        AND lower(workspace_name) = lower(?)
        AND status = 'ACTIVE'
    `).get(user.id, workspaceName);

    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: "Workspace name already exists"
      });
    }

    const workspaceId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const now = new Date().toISOString();

    const createWorkspace = db.transaction(() => {
      db.prepare(`
        INSERT INTO workspaces (
          id,
          workspace_type,
          workspace_name,
          owner_user_id,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspaceId,
        "BUSINESS",
        workspaceName,
        user.id,
        "ACTIVE",
        now,
        now
      );

      db.prepare(`
        INSERT INTO workspace_members (
          id,
          workspace_id,
          user_id,
          role,
          status,
          invited_by_user_id,
          joined_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memberId,
        workspaceId,
        user.id,
        "OWNER",
        "ACTIVE",
        null,
        now,
        now
      );
    });

    createWorkspace();

    const workspace = db.prepare(`
      SELECT
        w.*,
        wm.role,
        wm.status AS member_status,
        wm.joined_at
      FROM workspaces w
      INNER JOIN workspace_members wm
        ON wm.workspace_id = w.id
      WHERE w.id = ?
        AND wm.user_id = ?
    `).get(workspaceId, user.id);

    return res.status(201).json({
      success: true,
      workspace
    });
  } catch (err) {
    console.error("Create workspace error:", err);

    return res.status(500).json({
      success: false,
      error: "Failed to create workspace",
      details: err.message
    });
  }
});

app.get("/api/business-profile", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(workspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found"
      });
    }

    const profile = db.prepare(`
      SELECT
        workspace_id AS workspaceId,
        name,
        email,
        wallet,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM business_profiles
      WHERE workspace_id = ?
    `).get(workspaceId);

    return res.json({
      profile: profile || null
    });
  } catch (err) {
    console.error(
      "Load business profile error:",
      err
    );

    return res.status(500).json({
      error: "Failed to load business profile"
    });
  }
});

app.post("/api/business-profile", (req, res) => {
  try {
    const workspaceId = String(
      req.body.workspaceId || ""
    ).trim();

    const name = String(
      req.body.name || ""
    ).trim();

    const email = String(
      req.body.email || ""
    )
      .trim()
      .toLowerCase();

    const wallet = String(
      req.body.wallet || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    if (!name) {
      return res.status(400).json({
        error: "Business name is required"
      });
    }

    if (wallet && !ethers.isAddress(wallet)) {
      return res.status(400).json({
        error: "Invalid merchant wallet address"
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(workspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found"
      });
    }

    db.prepare(`
      INSERT INTO business_profiles (
        workspace_id,
        name,
        email,
        wallet,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)

      ON CONFLICT(workspace_id)
      DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        wallet = excluded.wallet,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      workspaceId,
      name,
      email,
      wallet
    );

    const profile = db.prepare(`
      SELECT
        workspace_id AS workspaceId,
        name,
        email,
        wallet,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM business_profiles
      WHERE workspace_id = ?
    `).get(workspaceId);

    return res.json({
      success: true,
      message: "Business profile saved.",
      profile
    });
  } catch (err) {
    console.error(
      "Save business profile error:",
      err
    );

    return res.status(500).json({
      error: "Failed to save business profile"
    });
  }
});

/* =========================
   CUSTOMERS
========================= */

app.get("/api/customers", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required",
        customers: []
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(workspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found",
        customers: []
      });
    }

    const customers = db.prepare(`
      SELECT
        id,
        workspace_id AS workspaceId,
        name,
        email,
        wallet,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM customers
      WHERE workspace_id = ?
      ORDER BY created_at DESC
    `).all(workspaceId);

    return res.json(customers);

  } catch (err) {
    console.error(
      "Load customers error:",
      err
    );

    return res.status(500).json({
      error: "Failed to load customers",
      customers: []
    });
  }
});

app.post("/api/customers", (req, res) => {
  try {
    const workspaceId = String(
      req.body.workspaceId || ""
    ).trim();

    const name = String(
      req.body.name || ""
    ).trim();

    const email = String(
      req.body.email || ""
    )
      .trim()
      .toLowerCase();

    const wallet = String(
      req.body.wallet || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    if (!name) {
      return res.status(400).json({
        error: "Customer name is required"
      });
    }

    if (wallet && !ethers.isAddress(wallet)) {
      return res.status(400).json({
        error: "Invalid customer wallet address"
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(workspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found"
      });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO customers (
        id,
        workspace_id,
        name,
        email,
        wallet,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workspaceId,
      name,
      email,
      wallet,
      now,
      now
    );

    const customer = db.prepare(`
      SELECT
        id,
        workspace_id AS workspaceId,
        name,
        email,
        wallet,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM customers
      WHERE id = ?
        AND workspace_id = ?
    `).get(
      id,
      workspaceId
    );

    return res.status(201).json({
      success: true,
      customer
    });

  } catch (err) {
    console.error(
      "Create customer error:",
      err
    );

    return res.status(500).json({
      error: "Failed to create customer"
    });
  }
});

app.delete("/api/customers/:id", (req, res) => {
  try {
    const id = String(
      req.params.id || ""
    ).trim();

    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!id) {
      return res.status(400).json({
        error: "Customer is required"
      });
    }

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(workspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found"
      });
    }

    const result = db.prepare(`
      DELETE FROM customers
      WHERE id = ?
        AND workspace_id = ?
    `).run(
      id,
      workspaceId
    );

    if (result.changes !== 1) {
      return res.status(404).json({
        error: "Customer not found"
      });
    }

    return res.json({
      success: true,
      id
    });

  } catch (err) {
    console.error(
      "Delete customer error:",
      err
    );

    return res.status(500).json({
      error: "Failed to delete customer"
    });
  }
});

/* =========================
   EMPLOYEES
========================= */

// Get employee list by workspace
app.get("/api/employees", (req, res) => {
  try {
    const status = String(req.query.status || "")
      .trim()
      .toUpperCase();

    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    const allowedStatuses = [
      "ACTIVE",
      "INACTIVE",
      "TERMINATED"
    ];

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required",
        employees: []
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(workspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found",
        employees: []
      });
    }

    let rows;

    if (
      status &&
      allowedStatuses.includes(status)
    ) {
      rows = db.prepare(`
        SELECT *
        FROM employees
        WHERE workspace_id = ?
          AND employment_status = ?
        ORDER BY created_at DESC
      `).all(
        workspaceId,
        status
      );
    } else {
      rows = db.prepare(`
        SELECT *
        FROM employees
        WHERE workspace_id = ?
        ORDER BY created_at DESC
      `).all(workspaceId);
    }

    return res.json(rows);
  } catch (err) {
    console.error(
      "Load employees error:",
      err
    );

    return res.status(500).json({
      error: "Failed to load employees",
      employees: []
    });
  }
});

// Create a new employee
app.post("/api/employees", (req, res) => {
  try {
    const {
      employeeName,
      employeeEmail,
      wallet,
      baseSalary,
      startedAt,
      workspaceId
    } = req.body;

    const name = String(employeeName || "").trim();
    const email = String(employeeEmail || "")
      .trim()
      .toLowerCase();

    const walletAddress = String(wallet || "").trim();
    const salary = Number(baseSalary || 0);
    const startDate =
      startedAt || new Date().toISOString();

    if (!name) {
      return res.status(400).json({
        error: "Employee name is required"
      });
    }

    if (!Number.isFinite(salary) || salary < 0) {
      return res.status(400).json({
        error: "Invalid base salary"
      });
    }

if (!workspaceId) {
  return res.status(400).json({
    error: "Workspace is required"
  });
}

const workspace = db.prepare(`
  SELECT id
  FROM workspaces
  WHERE id = ?
    AND status = 'ACTIVE'
`).get(workspaceId);

if (!workspace) {
  return res.status(404).json({
    error: "Workspace not found"
  });
}

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO employees (
        id,
        employee_name,
        employee_email,
        wallet,
        base_salary,
        employment_status,
        started_at,
        ended_at,
        created_at,
        updated_at,
        workspace_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      email || null,
      walletAddress || null,
      salary,
      "ACTIVE",
      startDate,
      null,
      now,
      now,
      workspaceId
    );

    const employee = db.prepare(`
      SELECT *
      FROM employees
      WHERE id = ?
    `).get(id);

    res.status(201).json({
      success: true,
      employee
    });
  } catch (err) {
    console.error("Create employee error:", err);

    res.status(500).json({
      error: "Failed to create employee"
    });
  }
});

// Update employee employment status
app.post("/api/employees/:id/status", (req, res) => {
  try {
    const { id } = req.params;

    const status = String(req.body.status || "")
      .trim()
      .toUpperCase();

    const allowedStatuses = [
      "ACTIVE",
      "INACTIVE",
      "TERMINATED"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Invalid employee status"
      });
    }

    const employee = db.prepare(`
      SELECT *
      FROM employees
      WHERE id = ?
    `).get(id);

    if (!employee) {
      return res.status(404).json({
        error: "Employee not found"
      });
    }

    const now = new Date().toISOString();

    const endedAt =
      status === "TERMINATED"
        ? now
        : null;

    db.prepare(`
      UPDATE employees
      SET employment_status = ?,
          ended_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      endedAt,
      now,
      id
    );

    const updatedEmployee = db.prepare(`
      SELECT *
      FROM employees
      WHERE id = ?
    `).get(id);

    res.json({
      success: true,
      employee: updatedEmployee
    });
  } catch (err) {
    console.error("Update employee status error:", err);

    res.status(500).json({
      error: "Failed to update employee status"
    });
  }
});

// Delete employee only when no payroll history exists
app.delete("/api/employees/:id", (req, res) => {
  try {
    const { id } = req.params;

    const workspaceId =
      String(
        req.query.workspaceId || ""
      ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const employee =
      db.prepare(`
        SELECT *
        FROM employees
        WHERE id = ?
          AND workspace_id = ?
      `).get(
        id,
        workspaceId
      );

    if (!employee) {
      return res.status(404).json({
        error:
          "Employee not found in this workspace"
      });
    }

    const payrollHistory =
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM payroll_items
        WHERE employee_id = ?
          AND workspace_id = ?
      `).get(
        id,
        workspaceId
      );

    if (
      Number(
        payrollHistory?.count || 0
      ) > 0
    ) {
      return res.status(409).json({
        error:
          "Employee has payroll history. Mark the employee as Inactive or Left instead."
      });
    }

    db.prepare(`
      DELETE FROM employees
      WHERE id = ?
        AND workspace_id = ?
    `).run(
      id,
      workspaceId
    );

    return res.json({
      success: true,
      message:
        "Employee deleted successfully"
    });

  } catch (err) {
    console.error(
      "Delete employee error:",
      err
    );

    return res.status(500).json({
      error:
        "Failed to delete employee"
    });
  }
});

app.get("/api/payroll-batches", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const rows = db.prepare(`
      SELECT
        b.*,
        COALESCE(SUM(i.final_amount), 0) AS total_amount,
        COUNT(i.id) AS employee_count
      FROM payroll_batches b
      LEFT JOIN payroll_items i
        ON i.batch_id = b.id
        AND i.workspace_id = b.workspace_id
      WHERE b.workspace_id = ?
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `).all(workspaceId);

    return res.json(rows);
  } catch (err) {
    console.error("Load payroll batches error:", err);

    return res.status(500).json({
      error: "Failed to load payroll batches"
    });
  }
});

app.get("/api/payroll-items", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const latestBatch = db.prepare(`
      SELECT b.*
      FROM payroll_batches b
      WHERE b.workspace_id = ?
        AND EXISTS (
          SELECT 1
          FROM payroll_items i
          WHERE i.batch_id = b.id
            AND i.workspace_id = ?
        )
      ORDER BY b.created_at DESC
      LIMIT 1
    `).get(workspaceId, workspaceId);

    if (!latestBatch) {
      return res.json([]);
    }

    const rows = db.prepare(`
      SELECT *
      FROM payroll_items
      WHERE batch_id = ?
        AND workspace_id = ?
      ORDER BY created_at DESC
    `).all(latestBatch.id, workspaceId);

    return res.json(rows);
  } catch (err) {
    console.error("Load payroll items error:", err);

    return res.status(500).json({
      error: "Failed to load payroll items"
    });
  }
});

app.get("/api/payroll-batches/:id/items", (req, res) => {
  try {
    const { id } = req.params;

    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const batch = db.prepare(`
      SELECT id
      FROM payroll_batches
      WHERE id = ?
        AND workspace_id = ?
    `).get(id, workspaceId);

    if (!batch) {
      return res.status(404).json({
        error: "Payroll batch not found"
      });
    }

    const items = db.prepare(`
      SELECT *
      FROM payroll_items
      WHERE batch_id = ?
        AND workspace_id = ?
      ORDER BY created_at DESC
    `).all(id, workspaceId);

    return res.json(items);
  } catch (err) {
    console.error("Load payroll batch items error:", err);

    return res.status(500).json({
      error: "Failed to load payroll batch items"
    });
  }
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
      `attachment; filename="TROR-Payslip-${item.employee_name || item.id}.pdf"`
    );

    doc.pipe(res);

    doc.fontSize(26).text("TROR Payroll Payslip", { align: "center" });

doc.moveDown();

doc.fontSize(11).fillColor("gray").text(`Payslip ID: PAY-${item.id}`);
doc.text(`Generated by TROR`);
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
  .text("This payslip was generated automatically by TROR.", { align: "center" });

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

/* =========================
   PREPARE PAYROLL EXECUTION
   NON-CUSTODIAL
========================= */

app.post("/api/payroll-batches/:id/execute", async (req, res) => {
  try {
    const { id } = req.params;

    const batch = db.prepare(`
      SELECT *
      FROM payroll_batches
      WHERE id = ?
    `).get(id);

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: "Payroll batch not found"
      });
    }

    if (!["APPROVED", "REVIEW"].includes(batch.status)) {
      return res.status(400).json({
        success: false,
        error:
          "Only APPROVED or REVIEW payroll batch can be prepared for payment"
      });
    }

    const items = db.prepare(`
      SELECT *
      FROM payroll_items
      WHERE batch_id = ?
        AND status != 'PAID'
      ORDER BY created_at ASC
    `).all(id);

    if (!items.length) {
      return res.status(400).json({
        success: false,
        error: "No unpaid payroll items found"
      });
    }

    const paymentItems = [];

    for (const item of items) {
      if (!ethers.isAddress(item.wallet)) {
        return res.status(400).json({
          success: false,
          error:
            `Invalid employee wallet for ${item.employee_name}`
        });
      }

      const amount =
        Number(item.final_amount);

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            `Invalid payroll amount for ${item.employee_name}`
        });
      }

      paymentItems.push({
        itemId: item.id,
        employeeName:
          item.employee_name,
        employeeEmail:
          item.employee_email || "",
        recipient:
          item.wallet,
        amount: Number(
          amount.toFixed(6)
        ),
        amountUnits:
          ethers
            .parseUnits(
              amount.toFixed(6),
              USDC_DECIMALS
            )
            .toString()
      });
    }

    const totalAmount =
      paymentItems.reduce(
        (sum, item) =>
          sum + Number(item.amount),
        0
      );

    return res.json({
      success: true,

      mode:
        "CONNECTED_WALLET",

      requiresWalletSignature:
        true,

      payrollBatch: {
        id: batch.id,
        workspaceId:
          batch.workspace_id,
        title:
          batch.title || "Payroll",
        status:
          batch.status,
        frequency:
          batch.frequency || "once"
      },

      currency:
        "USDC",

      network: {
        chainId:
          ARC_CHAIN_ID,
        chainName:
          ARC_CHAIN_NAME,
        usdcAddress:
          USDC_ADDRESS
      },

      employeeCount:
        paymentItems.length,

      totalAmount:
        Number(
          totalAmount.toFixed(6)
        ),

      items:
        paymentItems
    });

  } catch (err) {
    console.error(
      "PREPARE PAYROLL EXECUTION ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      error:
        "Failed to prepare payroll execution",
      details:
        err?.message ||
        "Unknown error"
    });
  }
}); 

app.post(
  "/api/payroll-batches/:id/confirm",
  async (req, res) => {
    try {
      const { id } = req.params;

      const txHash = String(
        req.body.txHash || ""
      ).trim();

      const payerAddress = String(
        req.body.payerAddress || ""
      ).trim();

      if (!txHash.startsWith("0x")) {
        return res.status(400).json({
          success: false,
          error: "Valid transaction hash is required"
        });
      }

      if (
        !payerAddress ||
        !ethers.isAddress(payerAddress)
      ) {
        return res.status(400).json({
          success: false,
          error: "Valid payer address is required"
        });
      }

      const batch = db.prepare(`
        SELECT *
        FROM payroll_batches
        WHERE id = ?
      `).get(id);

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Payroll batch not found"
        });
      }

      const receipt =
        await provider.getTransactionReceipt(
          txHash
        );

      if (!receipt) {
        return res.status(400).json({
          success: false,
          error:
            "Payroll transaction is not confirmed yet"
        });
      }

      if (Number(receipt.status) !== 1) {
        return res.status(400).json({
          success: false,
          error:
            "Payroll transaction failed on-chain"
        });
      }

      const TROR_PAYROLL_CONTRACT_ADDRESS =
  "0xE92413d559aCed050ef10c62DC79AAc568F377F0";

const expectedPayrollId =
  ethers.keccak256(
    ethers.toUtf8Bytes(
      `tror-payroll-${id}`
    )
  );

const payrollInterface =
  new ethers.Interface([
    "event PayrollExecuted(bytes32 indexed payrollId,address indexed payer,uint256 employeeCount,uint256 totalAmount)",
    "event PayrollPayment(bytes32 indexed payrollId,address indexed payer,address indexed recipient,uint256 amount)"
  ]);

let payrollExecutedEvent = null;

for (const log of receipt.logs) {
  if (
    String(log.address || "")
      .toLowerCase() !==
    TROR_PAYROLL_CONTRACT_ADDRESS
      .toLowerCase()
  ) {
    continue;
  }

  try {
    const parsedLog =
      payrollInterface.parseLog({
        topics:
          log.topics,
        data:
          log.data
      });

    if (
      parsedLog?.name ===
      "PayrollExecuted"
    ) {
      payrollExecutedEvent =
        parsedLog;

      break;
    }
  } catch {
    // Ignore logs from other events.
  }
}

if (!payrollExecutedEvent) {
  return res.status(400).json({
    success: false,
    error:
      "TRORPayroll execution event was not found"
  });
}

const eventPayrollId =
  String(
    payrollExecutedEvent.args.payrollId
  );

const eventPayer =
  String(
    payrollExecutedEvent.args.payer
  );

const eventEmployeeCount =
  BigInt(
    payrollExecutedEvent.args.employeeCount
  );

const eventTotalAmount =
  BigInt(
    payrollExecutedEvent.args.totalAmount
  );

if (
  eventPayrollId.toLowerCase() !==
  expectedPayrollId.toLowerCase()
) {
  return res.status(400).json({
    success: false,
    error:
      "Payroll ID does not match batch"
  });
}

if (
  eventPayer.toLowerCase() !==
  payerAddress.toLowerCase()
) {
  return res.status(400).json({
    success: false,
    error:
      "Payroll transaction payer does not match"
  });
}

const expectedItems =
  db.prepare(`
    SELECT *
    FROM payroll_items
    WHERE batch_id = ?
  `).all(id);

if (!expectedItems.length) {
  return res.status(400).json({
    success: false,
    error:
      "Payroll batch has no payment items"
  });
}

if (
  eventEmployeeCount !==
  BigInt(expectedItems.length)
) {
  return res.status(400).json({
    success: false,
    error:
      "Payroll employee count does not match"
  });
}

const expectedTotalAmount =
  expectedItems.reduce(
    (sum, item) => {
      return (
        sum +
        ethers.parseUnits(
          String(item.final_amount),
          6
        )
      );
    },
    0n
  );

if (
  eventTotalAmount !==
  expectedTotalAmount
) {
  return res.status(400).json({
    success: false,
    error:
      "Payroll total amount does not match"
  });
}

      const now =
        new Date().toISOString();

      let nextBatchId = null;
let nextPayDate = null;

const updatePayroll =
  db.transaction(() => {
    /*
      Mark the current payroll PAID only once.

      This guard is important because /confirm
      could theoretically be called again with
      the same transaction hash.
    */
    const paidResult = db.prepare(`
      UPDATE payroll_batches
      SET status = 'PAID',
          tx_hash = ?,
          paid_at = ?
      WHERE id = ?
        AND status != 'PAID'
    `).run(
      txHash,
      now,
      id
    );

    /*
      If this batch was already PAID,
      do not create another monthly cycle.
    */
    if (paidResult.changes !== 1) {
      return;
    }

    db.prepare(`
      UPDATE payroll_items
      SET status = 'PAID',
          tx_hash = ?
      WHERE batch_id = ?
        AND status != 'PAID'
    `).run(
      txHash,
      id
    );

    /*
      MONTHLY RECURRENCE

      The paid batch remains immutable history.

      A NEW payroll batch is created for
      the next month in DRAFT status.

      Base salary is preserved.
      Variable monthly values are reset.
    */
    if (
      String(batch.frequency || "")
        .toLowerCase() === "monthly"
    ) {
      const currentPayDate =
        new Date(batch.pay_date);

      if (
        !Number.isNaN(
          currentPayDate.getTime()
        )
      ) {
        /*
          Preserve the intended UTC day/time
          while safely handling month ends.

          Example:
          Jan 31 -> Feb 28/29
        */
        const originalDay =
          currentPayDate.getUTCDate();

        const nextDate =
          new Date(currentPayDate);

        nextDate.setUTCDate(1);

        nextDate.setUTCMonth(
          nextDate.getUTCMonth() + 1
        );

        const lastDayOfNextMonth =
          new Date(
            Date.UTC(
              nextDate.getUTCFullYear(),
              nextDate.getUTCMonth() + 1,
              0
            )
          ).getUTCDate();

        nextDate.setUTCDate(
          Math.min(
            originalDay,
            lastDayOfNextMonth
          )
        );

        nextPayDate =
          nextDate.toISOString();

        nextBatchId =
          crypto.randomUUID();

        db.prepare(`
          INSERT INTO payroll_batches (
            id,
            title,
            pay_date,
            status,
            frequency,
            workspace_id
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          nextBatchId,
          batch.title,
          nextPayDate,
          "DRAFT",
          "monthly",
          batch.workspace_id
        );

        for (const item of expectedItems) {
          const baseSalary =
            Number(
              item.base_salary || 0
            );

          /*
            New month starts clean:

            keep:
            - employee
            - wallet
            - base salary

            reset:
            - overtime
            - allowance
            - bonus
            - deduction
          */
          db.prepare(`
            INSERT INTO payroll_items (
              id,
              batch_id,
              employee_id,
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
              status,
              workspace_id
            )
            VALUES (
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?
            )
          `).run(
            crypto.randomUUID(),
            nextBatchId,
            item.employee_id || null,
            item.employee_name,
            item.employee_email || null,
            item.wallet,
            baseSalary,
            0,
            0,
            0,
            0,
            0,
            baseSalary,
            "DRAFT",
            batch.workspace_id
          );
        }
      }
    }
  });

updatePayroll();

      return res.json({
        success: true,
        batchId:
          id,
        status:
          "PAID",
        txHash,
        paidAt:
          now
      });

    } catch (err) {
      console.error(
        "CONFIRM PAYROLL ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err?.message ||
          "Failed to confirm payroll"
      });
    }
  }
);

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

  const finalAmount = Number(
  (
    Number(base || 0) +
    Number(overtimeHours || 0) * Number(overtimeRate || 0) +
    Number(allowance || 0) +
    Number(bonus || 0) -
    Number(deduction || 0)
  ).toFixed(6)
);

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

    doc.fontSize(22).text("TROR Payslip", { align: "center" });
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
    doc.fontSize(10).text("Generated by TROR", { align: "center" });

    doc.end();

    const pdfBuffer = await pdfBufferPromise;

    await resend.emails.send({
      from: "TROR <no-reply@mail.tror.app>",
      to: [item.employee_email],
      subject: `TROR Payslip - ${item.final_amount || 0} USDC`,
      html: `
        <h2>TROR Payslip</h2>
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
          filename: `TROR-Payslip-${item.employee_name || item.id}.pdf`,
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
  try {
    const batchId = crypto.randomUUID();

    const {
      workspaceId,
      title = "Payroll Batch",
      pay_date,
      frequency = "once",
      employees = []
    } = req.body;

if (
  !String(pay_date || "").trim()
) {
  return res.status(400).json({
    error:
      String(frequency || "").toLowerCase() === "monthly"
        ? "First pay date and time is required for monthly payroll."
        : "Pay date and time is required."
  });
}

const parsedPayDate =
  new Date(pay_date);

if (
  Number.isNaN(
    parsedPayDate.getTime()
  )
) {
  return res.status(400).json({
    error:
      "Please provide a valid pay date and time."
  });
}

    const normalizedWorkspaceId = String(
      workspaceId || ""
    ).trim();

    if (!normalizedWorkspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(normalizedWorkspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found"
      });
    }

    if (
      !Array.isArray(employees) ||
      employees.length === 0
    ) {
      return res.status(400).json({
        error:
          "Cannot create a payroll batch without employees"
      });
    }

    const createPayroll = db.transaction(() => {
      db.prepare(`
        INSERT INTO payroll_batches (
          id,
          title,
          pay_date,
          status,
          frequency,
          workspace_id
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        title,
        parsedPayDate.toISOString(),
        "DRAFT",
        frequency,
        normalizedWorkspaceId
      );

      for (const emp of employees) {
        const base = Number(emp.base_salary || 0);
        const overtimeHours =
          Number(emp.overtime_hours || 0);
        const overtimeRate =
          Number(emp.overtime_rate || 0);
        const allowance =
          Number(emp.allowance || 0);
        const bonus =
          Number(emp.bonus || 0);
        const deduction =
          Number(emp.deduction || 0);

        const finalAmount = Number(
          (
            base +
            overtimeHours * overtimeRate +
            allowance +
            bonus -
            deduction
          ).toFixed(6)
        );

        db.prepare(`
          INSERT INTO payroll_items (
            id,
            batch_id,
            employee_id,
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
            status,
            workspace_id
          )
          VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?
          )
        `).run(
          crypto.randomUUID(),
          batchId,
          emp.employee_id || null,
          emp.employee_name,
          emp.employee_email || null,
          emp.wallet,
          base,
          overtimeHours,
          overtimeRate,
          allowance,
          bonus,
          deduction,
          finalAmount,
          "DRAFT",
          normalizedWorkspaceId
        );
      }
    });

    createPayroll();

    return res.status(201).json({
      success: true,
      batchId,
      workspaceId: normalizedWorkspaceId,
      count: employees.length
    });
  } catch (err) {
    console.error("Create payroll batch error:", err);

    return res.status(500).json({
      error: "Failed to create payroll batch",
      details: err.message
    });
  }
});

app.post("/api/payouts", (req, res) => {
  try {
    const {
      recipient,
      amount,
      workspaceId,
      mode = "now",
      frequency = "once",
      nextRunAt = null
    } = req.body;

    const normalizedWorkspaceId = String(
      workspaceId || ""
    ).trim();

    if (!normalizedWorkspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(normalizedWorkspaceId);

    if (!workspace) {
      return res.status(404).json({
        error: "Workspace not found"
      });
    }

    if (!recipient || !amount) {
      return res.status(400).json({
        error: "Missing recipient or amount"
      });
    }

    if (!ethers.isAddress(recipient)) {
      return res.status(400).json({
        error: "Invalid recipient wallet"
      });
    }

    const numericAmount = Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        error: "Invalid payout amount"
      });
    }

    const id = crypto.randomUUID();

    db.prepare(`
      INSERT INTO payouts (
        id,
        recipient,
        amount,
        status,
        mode,
        frequency,
        next_run_at,
        workspace_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      recipient,
      numericAmount,
      "PENDING",
      mode,
      frequency,
      nextRunAt,
      normalizedWorkspaceId
    );

    const payout = db.prepare(`
      SELECT *
      FROM payouts
      WHERE id = ?
        AND workspace_id = ?
    `).get(id, normalizedWorkspaceId);

    return res.status(201).json(payout);
  } catch (err) {
    console.error("Create payout error:", err);

    return res.status(500).json({
      error: "Failed to create payout",
      details: err.message
    });
  }
});

app.get("/api/payouts", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const rows = db.prepare(`
      SELECT *
      FROM payouts
      WHERE workspace_id = ?
      ORDER BY created_at DESC
    `).all(workspaceId);

    return res.json(rows);
  } catch (err) {
    console.error("Load payouts error:", err);

    return res.status(500).json({
      error: "Failed to load payouts"
    });
  }
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

async function preparePayoutById(id, workspaceId) {
  const normalizedWorkspaceId =
    String(workspaceId || "").trim();

  if (!normalizedWorkspaceId) {
    throw new Error("Workspace is required");
  }

  const payout = db.prepare(`
    SELECT *
    FROM payouts
    WHERE id = ?
      AND workspace_id = ?
  `).get(
    id,
    normalizedWorkspaceId
  );

  if (!payout) {
    throw new Error(
      "Payout not found in this workspace"
    );
  }

  if (payout.status === "PAID") {
    return {
      alreadyPaid: true,
      payout
    };
  }

  const allowedStatuses = [
  "PENDING",
  "REVIEW",
  "APPROVED",
  "FAILED",
  "READY_TO_SIGN"
];

  if (
    !allowedStatuses.includes(
      payout.status
    )
  ) {
    throw new Error(
      `Payout cannot be prepared from status ${payout.status}`
    );
  }

  if (
    !ethers.isAddress(
      String(payout.recipient || "")
    )
  ) {
    throw new Error(
      "Invalid payout recipient"
    );
  }

  const numericAmount =
    Number(payout.amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount <= 0
  ) {
    throw new Error(
      `Invalid payout amount: ${payout.amount}`
    );
  }

  const normalizedAmount =
    numericAmount.toFixed(6);

  const amountUnits =
    ethers
      .parseUnits(
        normalizedAmount,
        USDC_DECIMALS
      )
      .toString();

  return {
    success: true,

    mode:
      "CONNECTED_WALLET",

    requiresWalletSignature:
      true,

    payout: {
      id: payout.id,

      workspaceId:
        payout.workspace_id,

      recipient:
        payout.recipient,

      amount:
        Number(normalizedAmount),

      amountUnits,

      currency:
        "USDC",

      payoutMode:
        payout.mode || "now",

      frequency:
        payout.frequency || "once",

      status:
        payout.status,

      nextRunAt:
        payout.next_run_at || null
    },

    network: {
      chainId:
        ARC_CHAIN_ID,

      chainName:
        ARC_CHAIN_NAME,

      usdcAddress:
        USDC_ADDRESS
    }
  };
}

app.post("/api/payouts/:id/execute", async (req, res) => {
  try {
    const workspaceId =
      String(
        req.body.workspaceId || ""
      ).trim();

    const result =
      await preparePayoutById(
        req.params.id,
        workspaceId
      );

    return res.json({
      message:
        result.alreadyPaid
          ? "Already paid"
          : "Payout ready for wallet authorization",
      ...result
    });

  } catch (err) {
    console.error(
      "PREPARE PAYOUT ERROR:",
      err
    );

    return res.status(500).json({
      error:
        "Failed to prepare payout",
      details:
        err?.message ||
        "Unknown error"
    });
  }
});

app.post("/api/payouts/:id/approve", (req, res) => {
  try {
    const { id } = req.params;

    const workspaceId = String(
      req.body.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const payout = db.prepare(`
      SELECT *
      FROM payouts
      WHERE id = ?
        AND workspace_id = ?
    `).get(id, workspaceId);

    if (!payout) {
      return res.status(404).json({
        error: "Payout not found in this workspace"
      });
    }

    if (payout.mode !== "scheduled") {
      return res.status(400).json({
        error: "Only scheduled payouts can be approved here"
      });
    }

    if (
      payout.status !== "PENDING" &&
      payout.status !== "REVIEW" &&
      payout.status !== "FAILED"
    ) {
      return res.status(400).json({
        error:
          "Only PENDING, REVIEW or FAILED scheduled payouts can be approved"
      });
    }

    if (!payout.next_run_at) {
      return res.status(400).json({
        error: "Scheduled payout is missing next_run_at"
      });
    }

    const scheduledTime = new Date(
      payout.next_run_at
    ).getTime();

    if (Number.isNaN(scheduledTime)) {
      return res.status(400).json({
        error: "Invalid scheduled payout time"
      });
    }

    if (scheduledTime <= Date.now()) {
      return res.status(400).json({
        error:
          "Scheduled payout time has already passed. Please create a new schedule."
      });
    }

    const result = db.prepare(`
      UPDATE payouts
      SET status = 'APPROVED'
      WHERE id = ?
        AND workspace_id = ?
        AND status IN ('PENDING', 'REVIEW', 'FAILED')
    `).run(id, workspaceId);

    if (result.changes !== 1) {
      return res.status(409).json({
        error: "Payout status changed. Please refresh and try again."
      });
    }

    return res.json({
      success: true,
      message: "Scheduled payout approved",
      id,
      status: "APPROVED",
      nextRunAt: payout.next_run_at
    });
  } catch (err) {
    console.error("Approve payout error:", err);

    return res.status(500).json({
      error: "Approve payout failed",
      details: err.message
    });
  }
});

/* =========================
   HELPERS
========================= */

async function getGoogleUserFromToken(accessToken) {
  if (!accessToken) {
    throw new Error("Missing Google access token");
  }

  const response = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const user = await response.json();

  if (!response.ok || !user.email) {
    throw new Error("Invalid Google login");
  }

  return user;
}

async function verifyClaimRecipient(claimId, accessToken) {
  const claim = db
    .prepare("SELECT * FROM claims WHERE id = ?")
    .get(String(claimId));

  if (!claim) {
    throw new Error("Claim not found");
  }

  const googleUser = await getGoogleUserFromToken(accessToken);

  const googleEmail = String(googleUser.email || "")
    .trim()
    .toLowerCase();

  const recipientEmail = String(claim.recipientEmail || "")
    .trim()
    .toLowerCase();

  if (googleEmail !== recipientEmail) {
    throw new Error(
      "This Google account is not the intended recipient"
    );
  }

  return {
    claim,
    googleUser
  };
}

app.post("/api/claims/:id/verify-google", async (req, res) => {
  try {
    const { googleAccessToken } = req.body;

    const { claim, googleUser } =
      await verifyClaimRecipient(
        req.params.id,
        googleAccessToken
      );

    res.json({
      success: true,
      verified: true,
      email: googleUser.email,
      claim: {
        id: claim.id,
        amount: claim.amount,
        message: claim.message,
        status: claim.status
      }
    });
  } catch (err) {
    res.status(403).json({
      success: false,
      verified: false,
      error: err.message
    });
  }
});

app.post(
  "/api/claims/:id/circle-auth",
  async (req, res) => {
    try {
      if (!requireCircle(res)) {
        return;
      }

      const googleAccessToken = String(
        req.body.googleAccessToken || ""
      ).trim();

      if (!googleAccessToken) {
        return res.status(400).json({
          success: false,
          error:
            "Google verification is required"
        });
      }

      /*
        Verify the Google account against
        the actual recipient stored on
        this claim.

        Do NOT trust an email supplied
        by the frontend.
      */
      const {
        claim,
        googleUser
      } = await verifyClaimRecipient(
        req.params.id,
        googleAccessToken
      );

      if (String(claim.claim_type || "").toUpperCase() === "PAYMENT_INTENT_CHOICE") {
        return res.status(409).json({
          success: false,
          error: "This claim records a recipient delivery choice only. No wallet claim is available yet."
        });
      }

      if (claim.status === "CLAIMED") {
        return res.status(400).json({
          success: false,
          error:
            "Claim already claimed"
        });
      }

const bankWithdrawal = db.prepare(`
  SELECT id, status
  FROM withdrawals
  WHERE claim_id = ?
  LIMIT 1
`).get(String(req.params.id));

if (
  bankWithdrawal &&
  withdrawalBlocksWalletClaim(
    bankWithdrawal.status
  )
) {
  return res.status(409).json({
    success: false,
    error:
      "This claim already has an active bank withdrawal request."
  });
}

      const recipientEmail =
        String(
          googleUser.email || ""
        )
          .trim()
          .toLowerCase();

      if (!recipientEmail) {
        return res.status(400).json({
          success: false,
          error:
            "Verified Google email is missing"
        });
      }

      /*
        Ensure a Circle user exists for
        the verified Gmail recipient.

        Circle may return an already-exists
        response. That is acceptable because
        the next step requests a user token.
      */
      try {
        const createResponse =
          await fetch(
            "https://api.circle.com/v1/w3s/users",
            {
              method: "POST",
              headers: {
                Authorization:
                  `Bearer ${CIRCLE_API_KEY}`,
                "Content-Type":
                  "application/json"
              },
              body: JSON.stringify({
                userId:
                  recipientEmail
              })
            }
          );

        /*
          Consume the response body but do
          not expose it or log sensitive data.
        */
        await createResponse
          .json()
          .catch(() => null);

      } catch (createError) {
        console.warn(
          "Claim Circle create-user warning:",
          createError?.message ||
            "Circle create-user request failed"
        );
      }

      /*
        Request Circle user-controlled-wallet
        authentication for the VERIFIED
        recipient email.
      */
      const tokenResponse =
        await fetch(
          "https://api.circle.com/v1/w3s/users/token",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${CIRCLE_API_KEY}`,
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              userId:
                recipientEmail
            })
          }
        );

      const tokenData =
        await tokenResponse.json();

      if (!tokenResponse.ok) {
        return res
          .status(tokenResponse.status)
          .json({
            success: false,
            error:
              tokenData?.message ||
              tokenData?.error ||
              "Failed to prepare Circle wallet"
          });
      }

      const userToken =
        tokenData?.data?.userToken ||
        tokenData?.userToken;

      const encryptionKey =
        tokenData?.data?.encryptionKey ||
        tokenData?.encryptionKey;

      if (
        !userToken ||
        !encryptionKey
      ) {
        return res.status(500).json({
          success: false,
          error:
            "Circle authentication data is incomplete"
        });
      }

      return res.json({
        success: true,

        recipient: {
          email:
            recipientEmail
        },

        circle: {
          userToken,
          encryptionKey
        }
      });

    } catch (err) {
      console.error(
        "CLAIM CIRCLE AUTH ERROR:",
        err?.message || err
      );

      return res.status(403).json({
        success: false,
        error:
          err?.message ||
          "Failed to prepare Circle recipient"
      });
    }
  }
);

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
    workspaceId: row.workspace_id || null,
    title: row.title,
    amount: row.amount,
    recipientAddress: row.recipientAddress,
    targetChain: row.targetChain,
    note: row.note || "",
    status: row.status,
    txHash: row.txHash || null,
    onchainId: row.onchainId,
    fromAddress: row.fromAddress || null,
    createdAt: row.createdAt,
    paidAt: row.paidAt || null,
    paymentMemo: row.paymentMemo || "",
    dueDate: row.dueDate,
    checkoutPath,
    checkoutUrl: checkoutPath,
    explorerAddressUrl: `${ARC_EXPLORER_URL}/address/${row.recipientAddress}`,
    explorerTxUrl: row.txHash ? `${ARC_EXPLORER_URL}/tx/${row.txHash}` : null
  };
}

function buildPaymentMemo({
  txHash,
  type,
  amount,
  from,
  to,
  note
}) {
  try {
    const memoText = JSON.stringify({
      app: "TROR",
      type: type || "",
      amount: String(amount || ""),
      from: from || "",
      to: to || "",
      note: note || "",
      ref: txHash || "",
      timestamp: new Date().toISOString()
    });

    const memoId = ethers.keccak256(
      ethers.toUtf8Bytes(
        `TROR-${type || "payment"}-${txHash || Date.now()}`
      )
    );

    const memoData =
      ethers.hexlify(
        ethers.toUtf8Bytes(memoText)
      );

    return {
      memoId,
      memoData,
      memoText,
      memoContract: ARC_MEMO_ADDRESS
    };

  } catch (err) {
    console.warn(
      "Failed to build payment memo:",
      err.message
    );

    return null;
  }
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
      process.env.TROR_TREASURY_WALLET ||
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


/* =========================
   INVOICES
========================= */

app.post("/api/ai/invoice-draft", async (req, res) => {
  if (!openai) {
    return res.status(500).json({
      success: false,
      error: "OPENAI_API_KEY is missing"
    });
  }

  try {
    const prompt = String(
      req.body?.prompt || ""
    ).trim();

    const workspaceId = String(
      req.body?.workspaceId || ""
    ).trim();

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Prompt is required"
      });
    }

let workspaceCustomers = [];

if (workspaceId) {
  workspaceCustomers = db.prepare(`
    SELECT
      id,
      name,
      email,
      wallet
    FROM customers
    WHERE workspace_id = ?
    ORDER BY created_at DESC
  `).all(workspaceId);
}

const now =
  new Date();

const currentDateTime =
  now.toISOString();

const currentDate =
  currentDateTime.slice(0, 10);

const customerContext =
  workspaceCustomers.length > 0
    ? workspaceCustomers
        .map((customer) => {
          return [
            `Name: ${customer.name || ""}`,
            `Email: ${customer.email || ""}`,
            `Wallet: ${customer.wallet || ""}`
          ].join(" | ");
        })
        .join("\n")
    : "No customers are available in this workspace.";

    const response =
      await openai.responses.create({
        model: "gpt-4.1-mini",

        input: [
          {
            role: "system",

            content: `
You are TROR AI, a financial action parser.

Current server date: ${currentDate}
Current server datetime: ${currentDateTime}

Customers available in the current TROR workspace:

${customerContext}

CUSTOMER RESOLUTION RULES:
- Only use customer information from the workspace customer list above.
- If the user refers to a customer by name, match that customer from the list.
- When a customer is matched, use that customer's email as recipientEmail when relevant.
- When a customer is matched, use that customer's wallet as recipientAddress when relevant.
- Never invent a customer email or wallet.
- If no reliable customer match exists, leave recipientEmail or recipientAddress empty as appropriate.

Use this current date and datetime to resolve
relative expressions such as:
- today
- tomorrow
- tonight
- next week
- next Monday
- this Friday

Never invent a different current year.
Never return a scheduledAt earlier than the current datetime.

Your job is to understand the user's request
and prepare a structured financial action draft.

Supported intents:

1. invoice.create
2. claim.create
3. payment.send
4. payout.create
5. payout.schedule
6. payroll.prepare

Never execute payments.
Never send transactions.
Never send emails.
Never claim that an action was completed.

Understand natural language in Vietnamese or English.

Return ONLY valid JSON in this exact structure:

{
  "intent": "",
  "confidence": 0,
  "draft": {
  "title": "",
  "description": "",
  "amount": null,
  "currency": "USDC",
  "customer": "",
  "recipientEmail": "",
  "recipientAddress": "",
  "dueDate": "",
  "note": "",
  "message": "",
  "network": "",
  "scheduledAt": "",
  "frequency": "",
  "payrollTitle": ""
},
  "missingFields": [],
  "needsConfirmation": true
}

INTENT RULES:

Use "invoice.create" when the user wants to:
- create an invoice
- bill a customer
- prepare an invoice
- request payment through an invoice

Use "claim.create" when the user wants to:
- send USDC through email
- create a Gmail claim
- send a claim to an email address
- let someone receive or claim USDC through email

Use "payment.send" when the user wants to:
- send USDC to a wallet address
- transfer USDC to a wallet
- pay a wallet address directly

For payment.send:
- extract recipientAddress
- extract amount
- extract network when provided
- currency defaults to USDC
- do not invent a wallet address
- do not invent a network

Use "payout.create" when the user wants to:
- create a payout to a wallet
- prepare a one-time payout
- pay a wallet through the Payout module
- create a payout that should be executed now

Use "payout.schedule" when the user wants to:
- schedule a payout for a future date or time
- send USDC to a wallet later
- create a one-time scheduled payout

Use "payroll.prepare" when the user wants to:
- prepare payroll
- create a payroll batch
- prepare salary payments
- pay active employees as payroll

INVOICE RULES:

For invoice.create:
- Generate a short professional title if no explicit title is provided.
- The title may be reasonably inferred from the service, product, work or purpose.
- Extract amount, customer, recipient email, recipient wallet, due date and note when provided.
- Do not require recipientAddress when the request already provides a recipient email or when a wallet was not explicitly requested.
- Do not mark recipientAddress as missing unless the user specifically asks for wallet-based invoicing and no address is supplied.

CLAIM RULES:

For claim.create:
- Extract recipientEmail.
- Extract amount.
- Extract message when provided.
- title may remain empty.
- dueDate may remain empty.
- recipientAddress may remain empty.
- customer may remain empty.

PAYOUT RULES:

For payout.create:
- Extract recipientAddress.
- Extract amount.
- payout is immediate unless the user explicitly asks for a future time.
- scheduledAt may remain empty.
- frequency defaults to "once".

For payout.schedule:
- Extract recipientAddress.
- Extract amount.
- Extract scheduledAt when the user provides a future date/time.
- frequency defaults to "once".
- Do not invent a date or time.
- Resolve relative dates using the actual current date supplied in the prompt context.
- Never return a past scheduledAt.
- If the exact future date cannot be determined reliably, leave scheduledAt empty.
- scheduledAt should use ISO local datetime format YYYY-MM-DDTHH:mm:ss when known.

PAYROLL RULES:

For payroll.prepare:
- Extract payrollTitle when explicitly provided.
- If no title is provided, "Monthly Payroll" is acceptable.
- Do not invent employees or wallet addresses.
- amount may remain null because payroll total is calculated from active employees.

GENERAL RULES:

- confidence must be between 0 and 1.
- amount must be a number or null.
- currency defaults to USDC.
- dueDate must use YYYY-MM-DD only when it can be determined reliably.
- Do not invent email addresses.
- Do not invent wallet addresses.
- Do not invent amounts.
- Do not invent customers.
- Do not invent dates.
- Add truly required missing fields to missingFields.
- needsConfirmation must always be true.

Required fields:

For invoice.create:
- title
- amount

For claim.create:
- recipientEmail
- amount

For payment.send:
- recipientAddress
- amount

For payout.create:
- recipientAddress
- amount

For payout.schedule:
- recipientAddress
- amount
- scheduledAt

For payroll.prepare:
- no fixed amount is required
- payrollTitle may default to "Monthly Payroll"

`
          },

          {
            role: "user",
            content: prompt
          }
        ]
      });

    let text =
      String(
        response.output_text || ""
      )
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

    console.log(
      "TROR AI raw:",
      text
    );

    const parsed =
      JSON.parse(text);

    const allowedIntents = [
  "invoice.create",
  "claim.create",
  "payment.send",
  "payout.create",
  "payout.schedule",
  "payroll.prepare"
];

    if (
      !allowedIntents.includes(
        parsed?.intent
      )
    ) {
      throw new Error(
        "Unsupported TROR AI intent."
      );
    }

    const rawAmount =
      parsed?.draft?.amount;

    const normalizedAmount =
      rawAmount === null ||
      rawAmount === undefined ||
      rawAmount === ""
        ? null
        : Number(rawAmount);

    const draft = {
      title:
        String(
          parsed?.draft?.title ||
          ""
        ).trim(),

      description:
        String(
          parsed?.draft?.description ||
          ""
        ).trim(),

      amount:
        Number.isFinite(
          normalizedAmount
        )
          ? normalizedAmount
          : null,

      currency:
        String(
          parsed?.draft?.currency ||
          "USDC"
        ).trim(),

      customer:
        String(
          parsed?.draft?.customer ||
          ""
        ).trim(),

      recipientEmail:
        String(
          parsed?.draft?.recipientEmail ||
          ""
        )
          .trim()
          .toLowerCase(),

      recipientAddress:
        String(
          parsed?.draft?.recipientAddress ||
          ""
        ).trim(),

      dueDate:
        String(
          parsed?.draft?.dueDate ||
          ""
        ).trim(),

      note:
        String(
          parsed?.draft?.note ||
          ""
        ).trim(),

      message:
        String(
          parsed?.draft?.message ||
          ""
        ).trim(),

      network:
  String(
    parsed?.draft?.network ||
    ""
  ).trim(),

scheduledAt:
  String(
    parsed?.draft?.scheduledAt ||
    ""
  ).trim(),

frequency:
  String(
    parsed?.draft?.frequency ||
    ""
  ).trim(),

payrollTitle:
  String(
    parsed?.draft?.payrollTitle ||
    ""
  ).trim()
};

    /*
      Rebuild important missing fields
      on the server instead of blindly
      trusting the model.
    */
    const missingFields = [];

const requestedCustomer =
  String(draft.customer || "")
    .trim()
    .toLowerCase();

const matchedCustomer =
  requestedCustomer
    ? workspaceCustomers.find(
        (customer) =>
          String(customer.name || "")
            .trim()
            .toLowerCase() ===
          requestedCustomer
      )
    : null;

if (matchedCustomer) {
  draft.customer =
    matchedCustomer.name || "";

  draft.recipientEmail =
    matchedCustomer.email || "";

  draft.recipientAddress =
    matchedCustomer.wallet || "";
}

if (
  parsed.intent ===
  "invoice.create"
) {
  if (!draft.title) {
    missingFields.push(
      "title"
    );
  }

  if (
    draft.amount === null ||
    draft.amount <= 0
  ) {
    missingFields.push(
      "amount"
    );
  }

if (
  draft.customer &&
  !matchedCustomer
) {
  draft.recipientEmail = "";
  draft.recipientAddress = "";

  missingFields.push(
    "customer"
  );
}

}

if (
  parsed.intent ===
  "claim.create"
) {
  if (!draft.recipientEmail) {
    missingFields.push(
      "recipientEmail"
    );
  }

  if (
    draft.amount === null ||
    draft.amount <= 0
  ) {
    missingFields.push(
      "amount"
    );
  }
}

if (
  parsed.intent ===
  "payment.send"
) {
  if (!draft.recipientAddress) {
    missingFields.push(
      "recipientAddress"
    );
  }

  if (
    draft.amount === null ||
    draft.amount <= 0
  ) {
    missingFields.push(
      "amount"
    );
  }
}

if (
  parsed.intent ===
  "payout.create"
) {
  if (!draft.recipientAddress) {
    missingFields.push(
      "recipientAddress"
    );
  }

  if (
    draft.amount === null ||
    draft.amount <= 0
  ) {
    missingFields.push(
      "amount"
    );
  }
}

if (
  parsed.intent ===
  "payout.schedule"
) {
  if (!draft.recipientAddress) {
    missingFields.push(
      "recipientAddress"
    );
  }

  if (
    draft.amount === null ||
    draft.amount <= 0
  ) {
    missingFields.push(
      "amount"
    );
  }

  if (!draft.scheduledAt) {
  missingFields.push(
    "scheduledAt"
  );
} else {
  const scheduledTime =
    new Date(
      draft.scheduledAt
    ).getTime();

  if (
    Number.isNaN(
      scheduledTime
    ) ||
    scheduledTime <= Date.now()
  ) {
    draft.scheduledAt = "";

    missingFields.push(
      "scheduledAt"
    );
  }
}
}

if (
  parsed.intent ===
  "payroll.prepare"
) {
  if (!draft.payrollTitle) {
    draft.payrollTitle =
      "Monthly Payroll";
  }

  if (!draft.frequency) {
    draft.frequency =
      "once";
  }
}

    const result = {
      success: true,

      action: {
        intent:
          parsed.intent,

        confidence:
          Math.max(
            0,
            Math.min(
              1,
              Number(
                parsed?.confidence || 0
              )
            )
          ),

        draft,

        missingFields,

        needsConfirmation:
          true
      }
    };

    console.log(
      "TROR AI action parse:",
      result
    );

    return res.json(result);

  } catch (err) {
    console.error(
      "TROR AI action error:",
      err
    );

    return res.status(500).json({
      success: false,

      error:
        err?.message ||
        "TROR AI action parsing failed"
    });
  }
});

app.get("/api/invoices", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    let rows;

    if (workspaceId) {
      rows = db.prepare(`
        SELECT *
        FROM invoices
        WHERE workspace_id = ?
        ORDER BY createdAt DESC
      `).all(workspaceId);
    } else {
      rows = db.prepare(`
        SELECT *
        FROM invoices
        ORDER BY createdAt DESC
      `).all();
    }

    return res.json({
      ok: true,
      invoices: rows.map(rowToInvoice)
    });
  } catch (err) {
    console.error("Load invoices error:", err);

    return res.status(500).json({
      ok: false,
      error: "Failed to load invoices",
      details: err.message
    });
  }
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
    const workspaceId = String(
  req.body.workspaceId || ""
).trim();
    const dueDate =
      String(req.body.dueDate || "").trim();
    const createdAt = new Date().toISOString();
    const txHash = String(req.body.txHash || "").trim();
    const onchainId =
  req.body.onchainId !== undefined
    ? Number(req.body.onchainId)
    : null;

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

if (!workspaceId) {
  return res.status(400).json({
    ok: false,
    error: "Workspace is required"
  });
}

const workspace = db.prepare(`
  SELECT *
  FROM workspaces
  WHERE id = ?
    AND status = 'ACTIVE'
`).get(workspaceId);

if (!workspace) {
  return res.status(404).json({
    ok: false,
    error: "Workspace not found"
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
         dueDate,
         txHash,
         onchainId,
         workspace_id
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
        @dueDate,
        @txHash,
        @onchainId,
        @workspaceId
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
      dueDate,
      txHash,
      onchainId,
      workspaceId
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

app.post("/api/invoices/:id/mark-paid", async (req, res) => {
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
    const paymentMemo = String(req.body.paymentMemo || "").trim();
    const paidAt = new Date().toISOString();

    db.prepare(`
      UPDATE invoices
      SET status = 'PAID',
          txHash = ?,
          fromAddress = ?,
          paidAt = ?,
          paymentMemo = ?
      WHERE id = ?
    `).run(txHash || null, fromAddress || null, paidAt, paymentMemo || null, req.params.id);

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
    if (!email) return res.status(400).json({ error: "Missing email" });

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

    const text = await response.text();

console.log("Circle status:", response.status);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

console.log(
  "Circle user-token fields:",
  Object.keys(data || {}),
  "data fields:",
  Object.keys(data?.data || {})
);

    
    return res.status(response.status).json(data);
  } catch (err) {
    console.error("Circle user-token error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Circle user-token failed"
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

app.post(
  "/api/circle/restore-pin",
  async (req, res) => {
    try {
      if (!requireCircle(res)) return;

      const { userToken } = req.body;

      if (!userToken) {
        return res.status(400).json({
          error: "Missing userToken"
        });
      }

      const response = await fetch(
        "https://api.circle.com/v1/w3s/user/pin/restore",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${CIRCLE_API_KEY}`,

            "X-User-Token":
              userToken,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            idempotencyKey:
              crypto.randomUUID()
          })
        }
      );

      const data =
        await response.json();

      return res
        .status(response.status)
        .json(data);

    } catch (err) {
      console.error(
        "Circle restore PIN error:",
        err
      );

      return res.status(500).json({
        error:
          err?.message ||
          "Failed to create PIN recovery challenge"
      });
    }
  }
);

/* =========================
   CIRCLE WALLETS
========================= */

app.post("/api/circle/create-wallet", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const {
  userToken,
  blockchains
} = req.body;

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
        blockchains:
  Array.isArray(blockchains) && blockchains.length > 0
    ? blockchains
    : [
        "ARC-TESTNET",
        "ETH-SEPOLIA",
        "BASE-SEPOLIA",
        "ARB-SEPOLIA",
        "AVAX-FUJI",
        "OP-SEPOLIA",
        "MATIC-AMOY",
        "UNI-SEPOLIA"
      ],
accountType: "SCA"
      })
    });

    const data = await response.json();
    console.log(
  "Circle create-wallet response:",
  JSON.stringify(data, null, 2)
);
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

/* =========================================================
   CIRCLE GATEWAY - UNIFIED BALANCE
========================================================= */

app.get("/api/circle/gateway/balance", async (req, res) => {
  try {
    const depositor = String(
      req.query.depositor || ""
    ).trim();

    if (!depositor) {
      return res.status(400).json({
        error: "Missing depositor address"
      });
    }

    if (!ethers.isAddress(depositor)) {
      return res.status(400).json({
        error: "Invalid depositor address"
      });
    }

    const response = await fetch(
      "https://gateway-api-testnet.circle.com/v1/balances",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
  token: "USDC",

  sources: [
    {
      depositor
    }
  ]
})
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "TROR Circle Gateway balance error:",
        data
      );

      return res.status(response.status).json({
        error:
          data?.message ||
          data?.error ||
          "Failed to load Unified Balance"
      });
    }

    console.log(
      "TROR Circle Gateway Unified Balance:",
      {
        depositor,
        data
      }
    );

    return res.json({
      success: true,
      depositor,
      data
    });
  } catch (err) {
    console.error(
      "TROR Circle Gateway balance error:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Failed to load Unified Balance"
    });
  }
});

/* =========================================================
   CIRCLE GATEWAY - PENDING DEPOSITS
========================================================= */

app.get(
  "/api/circle/gateway/deposits",
  async (req, res) => {
    try {
      const depositor = String(
        req.query.depositor || ""
      ).trim();

      if (!depositor) {
        return res.status(400).json({
          error: "Missing depositor address"
        });
      }

      if (!ethers.isAddress(depositor)) {
        return res.status(400).json({
          error: "Invalid depositor address"
        });
      }

      const response = await fetch(
        "https://gateway-api-testnet.circle.com/v1/deposits",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            token: "USDC",

            sources: [
              {
                depositor
              }
            ]
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        console.error(
          "TROR Circle Gateway deposits error:",
          data
        );

        return res.status(response.status).json({
          error:
            data?.message ||
            data?.error ||
            "Failed to load pending Gateway deposits",

          details: data
        });
      }

      console.log(
        "TROR Circle Gateway pending deposits:",
        {
          depositor,
          data
        }
      );

      return res.json({
        success: true,
        depositor,
        data
      });

    } catch (err) {
      console.error(
        "TROR Circle Gateway deposits error:",
        err
      );

      return res.status(500).json({
        error:
          err?.message ||
          "Failed to load pending Gateway deposits"
      });
    }
  }
);

/* =========================================================
   CIRCLE GATEWAY - ESTIMATE UNIFIED BALANCE TRANSFER
========================================================= */

app.post("/api/circle/gateway/estimate", async (req, res) => {
  try {
    const { spec } = req.body;

    if (!spec || typeof spec !== "object") {
      return res.status(400).json({
        error: "Missing Gateway transfer spec"
      });
    }

    console.log(
      "TROR Circle Gateway estimate spec:",
      spec
    );

    const response = await fetch(
      "https://gateway-api-testnet.circle.com/v1/estimate",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify([
          {
            spec
          }
        ])
      }
    );

    const data = await response.json();

    console.log(
      "TROR Circle Gateway estimate response:",
      response.status,
      data
    );

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          data?.message ||
          data?.error ||
          "Circle Gateway estimate failed",

        details: data
      });
    }

    return res.json({
      success: true,
      data
    });

  } catch (err) {
    console.error(
      "TROR Circle Gateway estimate error:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Circle Gateway estimate failed"
    });
  }
});

/* =========================================================
   CIRCLE GATEWAY - CREATE TRANSFER ATTESTATION
========================================================= */

app.post("/api/circle/gateway/transfer", async (req, res) => {
  try {
    const {
      burnIntent,
      signature
    } = req.body;

    if (!burnIntent?.spec) {
      return res.status(400).json({
        error: "Missing Gateway burnIntent"
      });
    }

    if (
      !signature ||
      typeof signature !== "string" ||
      !signature.startsWith("0x")
    ) {
      return res.status(400).json({
        error: "Invalid Gateway signature"
      });
    }

    const requestBody = [
      {
        burnIntent,
        signature
      }
    ];

    console.log(
      "TROR Circle Gateway transfer request:",
      {
        burnIntent,
        signature:
          `${signature.slice(0, 12)}...${signature.slice(-8)}`
      }
    );

    const response = await fetch(
      "https://gateway-api-testnet.circle.com/v1/transfer",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify(requestBody)
      }
    );

    const data = await response.json();

    console.log(
      "TROR Circle Gateway transfer response:",
      response.status,
      data
    );

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          data?.message ||
          data?.error ||
          "Circle Gateway transfer failed",

        details: data
      });
    }

    return res.status(response.status).json({
      success: true,
      data
    });

  } catch (err) {
    console.error(
      "TROR Circle Gateway transfer error:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Circle Gateway transfer failed"
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

app.post("/api/circle/contract-execution", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const {
      userToken,
      walletId,
      contractAddress,
      abiFunctionSignature,
      abiParameters
    } = req.body;

    if (!userToken) return res.status(400).json({ error: "Missing userToken" });
    if (!walletId) return res.status(400).json({ error: "Missing walletId" });
    if (!contractAddress || !isAddress(contractAddress)) {
      return res.status(400).json({ error: "Invalid contractAddress" });
    }
    if (!abiFunctionSignature) {
      return res.status(400).json({ error: "Missing abiFunctionSignature" });
    }

    const payload = {
      idempotencyKey: crypto.randomUUID(),
      walletId: String(walletId),
      contractAddress: String(contractAddress),
      abiFunctionSignature: String(abiFunctionSignature),
      abiParameters: abiParameters || [],
      feeLevel: "MEDIUM"
    };

    console.log("Circle contract execution payload:", payload);

    const response = await fetch(
      "https://api.circle.com/v1/w3s/user/transactions/contractExecution",
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
    console.log("Circle contract execution response:", response.status, data);

    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   CIRCLE USER-CONTROLLED WALLET - SIGN TYPED DATA
========================================================= */

app.post("/api/circle/sign-typed-data", async (req, res) => {
  try {
    if (!requireCircle(res)) return;

    const {
      userToken,
      walletId,
      data,
      memo
    } = req.body;

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

    if (!data) {
      return res.status(400).json({
        error: "Missing typed data"
      });
    }

    const payload = {
      walletId: String(walletId),

      data:
        typeof data === "string"
          ? data
          : JSON.stringify(data),

      memo:
        String(
          memo ||
          "TROR Unified Balance transfer"
        )
    };

    console.log(
      "TROR Circle sign typed data payload:",
      {
        walletId: payload.walletId,
        memo: payload.memo
      }
    );

    const response = await fetch(
      "https://api.circle.com/v1/w3s/user/sign/typedData",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${CIRCLE_API_KEY}`,

          "X-User-Token":
            userToken,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify(payload)
      }
    );

    const result =
      await response.json();

    console.log(
      "TROR Circle sign typed data response:",
      response.status,
      result
    );

    return res
      .status(response.status)
      .json(result);

  } catch (err) {
    console.error(
      "TROR Circle sign typed data error:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Failed to create typed-data signing challenge"
    });
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

const ACTIVE_OFFRAMP_STATUSES = new Set([
  "PENDING",
  "REVIEW",
  "APPROVED",
  "AWAITING_PROVIDER",
  "KYC_REQUIRED",
  "REVIEW_REQUIRED",
  "AWAITING_CRYPTO",
  "PROCESSING",
  "SETTLED",
  "COMPLETED"
]);

function withdrawalBlocksWalletClaim(status) {
  return ACTIVE_OFFRAMP_STATUSES.has(
    String(status || "").trim().toUpperCase()
  );
}

function maskBankAccount(value) {
  const account = String(value || "").trim();

  if (!account) return null;

  const visible = account.slice(-4);

  return `${"*".repeat(
    Math.max(4, account.length - visible.length)
  )}${visible}`;
}

function selectOffRampProvider({ country }) {
  const normalizedCountry =
    String(country || "").trim().toUpperCase();

  /*
    Provider adapters will be connected here.

    Do not pretend that a provider order exists until
    TROR has real provider credentials and receives
    a successful provider API response.
  */
  return {
    provider: null,
    status: "AWAITING_PROVIDER",
    providerStatus: "NOT_CONFIGURED",
    country: normalizedCountry
  };
}


/* =========================
   SEND MONEY — PAYMENT INTENT

   Fast path for cross-border send UX.
   No card, bank credential or KYC document is collected here.
   Provider execution is intentionally a later Money Router step.
========================= */

app.post("/api/money/payment-intents", (req, res) => {
  try {
    const workspaceId = String(req.body?.workspaceId || "").trim();
    const senderCountry = normalizeMoneyCode(req.body?.senderCountry, 2);
    const sendAmount = Number(req.body?.sendAmount);
    const sendCurrency = normalizeMoneyCode(req.body?.sendCurrency, 3);
    const recipientEmail = String(req.body?.recipientEmail || "")
      .trim()
      .toLowerCase();
    const recipientCountry = normalizeMoneyCode(
      req.body?.recipientCountry,
      2
    );
    const receiveMethod = String(req.body?.receiveMethod || "")
      .trim()
      .toUpperCase();
    const receiveCurrency =
      receiveMethod === "FIAT"
        ? normalizeMoneyCode(req.body?.receiveCurrency, 3)
        : "USDC";

    if (!workspaceId) {
      throw new Error("Workspace is required");
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
      LIMIT 1
    `).get(workspaceId);

    if (!workspace) {
      throw new Error("Active workspace was not found");
    }

    if (!Number.isFinite(sendAmount) || sendAmount <= 0) {
      throw new Error("Send amount must be greater than 0");
    }

    if (senderCountry.length !== 2 || recipientCountry.length !== 2) {
      throw new Error("Countries must use 2-letter codes");
    }

    if (sendCurrency.length !== 3) {
      throw new Error("Send currency must use a 3-letter code");
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      throw new Error("A valid recipient email is required");
    }

    if (!["FIAT", "USDC"].includes(receiveMethod)) {
      throw new Error("Receive method must be FIAT or USDC");
    }

    if (receiveMethod === "FIAT" && receiveCurrency.length !== 3) {
      throw new Error("Receive currency must use a 3-letter code");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const status = "AWAITING_PROVIDER";

    db.prepare(`
      INSERT INTO payment_intents (
        id,
        workspace_id,
        sender_country,
        send_amount,
        send_currency,
        recipient_email,
        recipient_country,
        receive_method,
        receive_currency,
        settlement_asset,
        provider,
        provider_order_id,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USDC', NULL, NULL, ?, ?, ?)
    `).run(
      id,
      workspaceId,
      senderCountry,
      sendAmount,
      sendCurrency,
      recipientEmail,
      recipientCountry,
      receiveMethod,
      receiveCurrency,
      status,
      now,
      now
    );

    return res.status(201).json({
      success: true,
      intent: {
        id,
        workspaceId,
        senderCountry,
        sendAmount,
        sendCurrency,
        recipientEmail,
        recipientCountry,
        receiveMethod,
        receiveCurrency,
        settlementAsset: "USDC",
        status,
        recipientChoice: null,
        sandboxActionsAvailable: PAYMENT_INTENT_SANDBOX
      },
      nextAction: "PROVIDER_ROUTE",
      message: "Payment intent created. A provider route is required before collecting fiat or settling funds."
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Failed to create payment intent"
    });
  }
});

/* =========================
   PAYMENT INTENT STATE / RECIPIENT CHOICE

   Real provider integration will move intents through:
   AWAITING_PROVIDER -> AWAITING_SENDER_PAYMENT -> FUNDED
   -> READY_FOR_RECIPIENT -> RECIPIENT_SELECTED -> PROCESSING -> COMPLETED

   The sandbox transition below is opt-in and disabled in production.
========================= */

const PAYMENT_INTENT_STATUSES = new Set([
  "AWAITING_PROVIDER",
  "AWAITING_SENDER_PAYMENT",
  "FUNDED",
  "READY_FOR_RECIPIENT",
  "RECIPIENT_SELECTED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELED"
]);

const PAYMENT_INTENT_SANDBOX =
  String(process.env.TROR_PAYMENT_INTENT_SANDBOX || "")
    .trim()
    .toLowerCase() === "true" &&
  String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production";

function getPaymentIntentForWorkspace(id, workspaceId) {
  return db.prepare(`
    SELECT *
    FROM payment_intents
    WHERE id = ?
      AND workspace_id = ?
    LIMIT 1
  `).get(id, workspaceId);
}

function serializePaymentIntent(row) {
  if (!row) return null;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderCountry: row.sender_country,
    sendAmount: row.send_amount,
    sendCurrency: row.send_currency,
    recipientEmail: row.recipient_email,
    recipientCountry: row.recipient_country,
    receiveMethod: row.receive_method,
    receiveCurrency: row.receive_currency,
    settlementAsset: row.settlement_asset || "USDC",
    provider: row.provider || null,
    providerOrderId: row.provider_order_id || null,
    status: row.status,
    recipientChoice: row.recipient_choice || null,
    recipientChoiceAt: row.recipient_choice_at || null,
    fundedAt: row.funded_at || null,
    readyAt: row.ready_at || null,
    completedAt: row.completed_at || null,
    recipientClaimId: row.recipient_claim_id || null,
    recipientClaimSentAt: row.recipient_claim_sent_at || null,
    sandboxActionsAvailable: PAYMENT_INTENT_SANDBOX
  };
}

app.get("/api/money/payment-intents/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const workspaceId = String(req.query.workspaceId || "").trim();

    if (!id || !workspaceId) {
      throw new Error("Payment intent id and workspace are required");
    }

    const row = getPaymentIntentForWorkspace(id, workspaceId);

    if (!row) {
      return res.status(404).json({
        success: false,
        error: "Payment intent was not found"
      });
    }

    return res.json({
      success: true,
      intent: serializePaymentIntent(row)
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Failed to load payment intent"
    });
  }
});

app.post("/api/money/payment-intents/:id/sandbox/fund", (req, res) => {
  try {
    if (!PAYMENT_INTENT_SANDBOX) {
      return res.status(403).json({
        success: false,
        error: "Payment intent sandbox transitions are disabled"
      });
    }

    const id = String(req.params.id || "").trim();
    const workspaceId = String(req.body?.workspaceId || "").trim();
    const row = getPaymentIntentForWorkspace(id, workspaceId);

    if (!row) {
      return res.status(404).json({
        success: false,
        error: "Payment intent was not found"
      });
    }

    if (!["AWAITING_PROVIDER", "AWAITING_SENDER_PAYMENT", "FUNDED"].includes(row.status)) {
      throw new Error(`Intent cannot be funded from status ${row.status}`);
    }

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE payment_intents
      SET status = 'READY_FOR_RECIPIENT',
          funded_at = COALESCE(funded_at, ?),
          ready_at = ?,
          updated_at = ?
      WHERE id = ?
        AND workspace_id = ?
    `).run(now, now, now, id, workspaceId);

    const updated = getPaymentIntentForWorkspace(id, workspaceId);

    return res.json({
      success: true,
      intent: serializePaymentIntent(updated),
      message: "Sandbox funding recorded. Recipient choice is now available."
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Failed to simulate funding"
    });
  }
});

function buildRecipientClaimLink(appUrl, claimId) {
  const base = String(appUrl || "http://localhost:5173").replace(/\/+$/, "");
  const encodedId = encodeURIComponent(String(claimId || "").trim());

  // Vite dev server routes unknown paths to index.html. Enter through app.html
  // during local development so main.jsx can process ?claim= and render the claim UI.
  if (/^https?:\/\/localhost:5173$/i.test(base) || /^https?:\/\/127\.0\.0\.1:5173$/i.test(base)) {
    return `${base}/app.html?claim=${encodedId}`;
  }

  return `${base}/claim/${encodedId}`;
}

app.post("/api/money/payment-intents/:id/sandbox/send-recipient-claim", async (req, res) => {
  try {
    if (!PAYMENT_INTENT_SANDBOX) {
      return res.status(403).json({
        success: false,
        error: "Payment intent sandbox transitions are disabled"
      });
    }

    const id = String(req.params.id || "").trim();
    const workspaceId = String(req.body?.workspaceId || "").trim();
    const row = getPaymentIntentForWorkspace(id, workspaceId);

    if (!row) {
      return res.status(404).json({
        success: false,
        error: "Payment intent was not found"
      });
    }

    if (row.status !== "READY_FOR_RECIPIENT") {
      throw new Error("Recipient claim is only available after sender funding is confirmed");
    }

    let claim = db.prepare(`
      SELECT *
      FROM claims
      WHERE payment_intent_id = ?
        AND claim_type = 'PAYMENT_INTENT_CHOICE'
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(id);

    const now = new Date().toISOString();

    if (!claim) {
      const claimId = crypto.randomUUID();

      db.prepare(`
        INSERT INTO claims (
          id,
          recipientEmail,
          amount,
          message,
          status,
          createdAt,
          workspace_id,
          payment_intent_id,
          claim_type,
          display_currency
        ) VALUES (?, ?, ?, ?, 'CHOICE_PENDING', ?, ?, ?, 'PAYMENT_INTENT_CHOICE', ?)
      `).run(
        claimId,
        row.recipient_email,
        Number(row.send_amount),
        `TROR recipient choice for ${row.send_amount} ${row.send_currency}`,
        now,
        workspaceId,
        id,
        row.send_currency
      );

      db.prepare(`
        UPDATE payment_intents
        SET recipient_claim_id = ?,
            recipient_claim_sent_at = ?,
            updated_at = ?
        WHERE id = ?
          AND workspace_id = ?
      `).run(claimId, now, now, id, workspaceId);

      claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    }

    const appUrl = String(process.env.APP_URL || "http://localhost:5173")
      .replace(/\/+$/, "");
    const claimLink = buildRecipientClaimLink(appUrl, claim.id);

    let emailSent = false;
    let emailError = null;

    try {
      const { error } = await resend.emails.send({
        from: "TROR <no-reply@mail.tror.app>",
        to: row.recipient_email,
        subject: "Choose how to receive your TROR transfer",
        html: `
          <div style="font-family:Arial,sans-serif;padding:20px;color:#111;">
            <h2>TROR recipient choice</h2>
            <p>A transfer intent is ready for your verified recipient choice.</p>
            <div style="margin-top:16px;padding:14px;background:#f3f4f6;border-radius:12px;">
              <p><b>Sender amount:</b> ${row.send_amount} ${row.send_currency}</p>
              <p><b>Destination:</b> ${row.recipient_country}</p>
              <p><b>Settlement layer:</b> USDC</p>
            </div>
            <p style="margin-top:18px;">Verify the Gmail account that received this message, then choose local bank or USDC.</p>
            <a href="${claimLink}" style="display:inline-block;padding:12px 18px;background:#d4a62a;color:#111;text-decoration:none;border-radius:10px;font-weight:bold;">Open recipient choice</a>
            <p style="margin-top:20px;font-size:12px;color:#6b7280;">Sandbox test: this message does not deliver fiat or USDC and does not contact a bank.</p>
          </div>
        `
      });

      if (error) throw new Error(error.message || "Email provider rejected the message");
      emailSent = true;
    } catch (err) {
      emailError = err?.message || "Failed to send sandbox recipient email";
      console.error("Sandbox recipient choice email error:", err);
    }

    const updated = getPaymentIntentForWorkspace(id, workspaceId);

    return res.json({
      success: true,
      intent: serializePaymentIntent(updated),
      claimId: claim.id,
      claimLink,
      emailSent,
      emailError,
      message: emailSent
        ? "Recipient choice email sent. The verified recipient can now choose Bank or USDC."
        : "Recipient choice claim created. Email was not sent, but the local claim link is available for testing."
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Failed to create recipient choice claim"
    });
  }
});

app.post("/api/money/payment-intents/:id/sandbox/recipient-choice", (req, res) => {
  try {
    if (!PAYMENT_INTENT_SANDBOX) {
      return res.status(403).json({
        success: false,
        error: "Payment intent sandbox transitions are disabled"
      });
    }

    const id = String(req.params.id || "").trim();
    const workspaceId = String(req.body?.workspaceId || "").trim();
    const recipientChoice = String(req.body?.recipientChoice || "")
      .trim()
      .toUpperCase();
    const row = getPaymentIntentForWorkspace(id, workspaceId);

    if (!row) {
      return res.status(404).json({
        success: false,
        error: "Payment intent was not found"
      });
    }

    if (row.status !== "READY_FOR_RECIPIENT") {
      throw new Error("Recipient choice is only available after funding is confirmed");
    }

    if (!["FIAT", "USDC"].includes(recipientChoice)) {
      throw new Error("Recipient choice must be FIAT or USDC");
    }

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE payment_intents
      SET recipient_choice = ?,
          recipient_choice_at = ?,
          status = 'RECIPIENT_SELECTED',
          updated_at = ?
      WHERE id = ?
        AND workspace_id = ?
    `).run(recipientChoice, now, now, id, workspaceId);

    const updated = getPaymentIntentForWorkspace(id, workspaceId);

    return res.json({
      success: true,
      intent: serializePaymentIntent(updated),
      message: recipientChoice === "FIAT"
        ? "Recipient selected local bank delivery. Provider off-ramp is the next step."
        : "Recipient selected USDC. Wallet delivery is the next step."
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Failed to save recipient choice"
    });
  }
});

app.post("/api/claims/:id/payment-intent-choice", async (req, res) => {
  try {
    const googleAccessToken = String(req.body?.googleAccessToken || "").trim();
    const recipientChoice = String(req.body?.recipientChoice || "")
      .trim()
      .toUpperCase();

    if (!googleAccessToken) {
      return res.status(403).json({ success: false, error: "Google verification is required" });
    }

    if (!["FIAT", "USDC"].includes(recipientChoice)) {
      throw new Error("Recipient choice must be FIAT or USDC");
    }

    const { claim } = await verifyClaimRecipient(req.params.id, googleAccessToken);

    if (String(claim.claim_type || "").toUpperCase() !== "PAYMENT_INTENT_CHOICE") {
      throw new Error("This claim is not a payment-intent recipient choice");
    }

    const paymentIntentId = String(claim.payment_intent_id || "").trim();
    if (!paymentIntentId) {
      throw new Error("Payment intent is missing from this recipient claim");
    }

    const intent = db.prepare(`
      SELECT * FROM payment_intents
      WHERE id = ?
        AND workspace_id = ?
      LIMIT 1
    `).get(paymentIntentId, claim.workspace_id);

    if (!intent) {
      throw new Error("Payment intent was not found");
    }

    if (intent.status === "RECIPIENT_SELECTED") {
      const existingChoice = String(intent.recipient_choice || "").trim().toUpperCase();

      // Safe idempotency: browser retries/double-clicks for the SAME verified
      // choice return success instead of surfacing a false error.
      if (existingChoice === recipientChoice) {
        const now = new Date().toISOString();

        db.prepare(`
          UPDATE claims
          SET status = 'CHOICE_RECORDED',
              choice_recorded_at = COALESCE(choice_recorded_at, ?)
          WHERE id = ?
        `).run(now, claim.id);

        return res.json({
          success: true,
          recipientChoice,
          intent: serializePaymentIntent(intent),
          idempotent: true,
          message: recipientChoice === "FIAT"
            ? "Recipient selected local bank delivery. No bank payout has started yet."
            : "Recipient selected USDC delivery. No USDC transfer has started yet."
        });
      }

      // Once a delivery rail is selected, a different rail cannot replace it.
      throw new Error("Recipient delivery choice is already locked");
    }

    if (intent.status !== "READY_FOR_RECIPIENT") {
      throw new Error(`Recipient choice is not available from status ${intent.status}`);
    }

    const now = new Date().toISOString();
    const updateIntent = db.prepare(`
      UPDATE payment_intents
      SET recipient_choice = ?,
          recipient_choice_at = ?,
          status = 'RECIPIENT_SELECTED',
          updated_at = ?
      WHERE id = ?
        AND workspace_id = ?
        AND status = 'READY_FOR_RECIPIENT'
    `).run(recipientChoice, now, now, paymentIntentId, claim.workspace_id);

    if (updateIntent.changes !== 1) {
      throw new Error("Recipient choice could not be recorded");
    }

    db.prepare(`
      UPDATE claims
      SET status = 'CHOICE_RECORDED',
          choice_recorded_at = ?
      WHERE id = ?
    `).run(now, claim.id);

    const updatedIntent = db.prepare(`
      SELECT * FROM payment_intents
      WHERE id = ?
      LIMIT 1
    `).get(paymentIntentId);

    return res.json({
      success: true,
      recipientChoice,
      intent: serializePaymentIntent(updatedIntent),
      message: recipientChoice === "FIAT"
        ? "Recipient selected local bank delivery. No bank payout has started yet."
        : "Recipient selected USDC delivery. No USDC transfer has started yet."
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Failed to record recipient choice"
    });
  }
});

/* =========================
   MONEY ROUTER

   Provider-neutral fiat route discovery.
   Provider-hosted checkout/KYC is required for fiat rails.
   TROR never invents a provider order when no provider is configured.
========================= */

const MONEY_DIRECTIONS = new Set([
  "FIAT_IN",
  "FIAT_OUT"
]);

function normalizeMoneyCode(value, length) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, length);
}

function selectMoneyProvider({
  direction,
  country,
  fiatCurrency
}) {
  const normalizedDirection =
    String(direction || "").trim().toUpperCase();

  const normalizedCountry =
    normalizeMoneyCode(country, 2);

  const normalizedFiatCurrency =
    normalizeMoneyCode(fiatCurrency, 3);

  /*
    FIAT IN:
    Coinbase Hosted Onramp.

    Coinbase performs its own hosted
    payment/KYC flow.

    TROR never receives card data.
  */
  if (
    normalizedDirection === "FIAT_IN" &&
    isCoinbaseOnrampConfigured()
  ) {
    return {
      available: true,
      provider: "coinbase",
      status: "AWAITING_SENDER_PAYMENT",
      providerStatus: "AVAILABLE",
      checkoutUrl: null,
      requiresKyc: true,
      providerHostedFlow: true,
      direction: normalizedDirection,
      country: normalizedCountry,
      fiatCurrency: normalizedFiatCurrency
    };
  }

  /*
    FIAT OUT remains provider-neutral
    until the payout provider is connected.
  */
  return {
    available: false,
    provider: null,
    status: "AWAITING_PROVIDER",
    providerStatus: "NOT_CONFIGURED",
    checkoutUrl: null,
    requiresKyc: null,
    providerHostedFlow: true,
    direction: normalizedDirection,
    country: normalizedCountry,
    fiatCurrency: normalizedFiatCurrency
  };
}

function validateMoneyRouteRequest(body = {}) {
  const direction =
    String(body.direction || "").trim().toUpperCase();

  const asset =
    String(body.asset || "USDC").trim().toUpperCase();

  const amount = Number(body.amount);
  const country = normalizeMoneyCode(body.country, 2);
  const fiatCurrency = normalizeMoneyCode(
    body.fiatCurrency,
    3
  );

  const workspaceId =
    String(body.workspaceId || "").trim();

  const walletType =
    String(body.walletType || "").trim().toLowerCase();

  const walletAddress =
    String(body.walletAddress || "").trim();

  if (!MONEY_DIRECTIONS.has(direction)) {
    throw new Error("Invalid money route direction");
  }

  if (asset !== "USDC") {
    throw new Error("TROR Money Router currently supports USDC only");
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be greater than 0");
  }

  if (country.length !== 2) {
    throw new Error("Country must use a 2-letter code");
  }

  if (fiatCurrency.length !== 3) {
    throw new Error("Fiat currency must use a 3-letter code");
  }

  if (!workspaceId) {
    throw new Error("Workspace is required");
  }

  const workspace = db.prepare(`
    SELECT id
    FROM workspaces
    WHERE id = ?
      AND status = 'ACTIVE'
    LIMIT 1
  `).get(workspaceId);

  if (!workspace) {
    throw new Error("Active workspace was not found");
  }

  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    throw new Error("A valid active wallet address is required");
  }

  return {
    direction,
    asset,
    amount,
    country,
    fiatCurrency,
    workspaceId,
    walletType: walletType || null,
    walletAddress
  };
}

function discoverMoneyRoute(input) {
  const providerRoute = selectMoneyProvider(input);

  return {
    success: true,
    available: Boolean(providerRoute.available),
    direction: input.direction,
    asset: input.asset,
    amount: input.amount,
    country: input.country,
    fiatCurrency: input.fiatCurrency,
    walletType: input.walletType,
    walletAddress: input.walletAddress,
    workspaceId: input.workspaceId,
    provider: providerRoute.provider,
    status: providerRoute.status,
    providerStatus: providerRoute.providerStatus,
    checkoutUrl: providerRoute.checkoutUrl,
    requiresKyc: providerRoute.requiresKyc,
    providerHostedFlow: providerRoute.providerHostedFlow,
    message: providerRoute.available
      ? "A provider route is available."
      : "No fiat provider is configured for this route yet."
  };
}

app.get(
  "/api/money/providers/triple-a/enabled-countries",
  async (req, res) => {
    try {
      const accessToken = await getTripleAAccessToken();

      const response = await fetch(
        `${TRIPLE_A_BASE_URL}/api/fiat-payout/v1/discoveries/enabled-countries`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        return res.status(response.status).json({
          ok: false,
          error:
            data?.message ||
            data?.error ||
            `Triple-A enabled countries request failed (${response.status}).`
        });
      }

      const countries = Array.isArray(data) ? data : [];

      const vietnam = countries.find(
        (country) =>
          String(country?.code || "")
            .trim()
            .toUpperCase() === "VNM"
      );

      return res.json({
        ok: true,
        count: countries.length,
        vietnamEnabled: Boolean(vietnam),
        vietnam: vietnam || null,
        countries
      });
    } catch (error) {
      console.error(
        "Triple-A enabled countries error:",
        error?.message || error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Unable to query Triple-A enabled countries."
      });
    }
  }
);

app.post("/api/money/routes", (req, res) => {
  try {
    const input = validateMoneyRouteRequest(req.body);
    return res.json(discoverMoneyRoute(input));
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err?.message || "Failed to discover money route"
    });
  }
});

async function startMoneyProviderSession(
  req,
  res,
  direction
) {
  try {
    const input = validateMoneyRouteRequest({
      ...req.body,
      direction
    });

    const route = discoverMoneyRoute(input);

    if (!route.available || !route.provider) {
      return res.status(503).json({
        ...route,
        code: "PROVIDER_NOT_CONFIGURED"
      });
    }

    /*
      COINBASE FIAT IN
    */
    if (
      direction === "FIAT_IN" &&
      route.provider === "coinbase"
    ) {
      const forwardedIp =
  String(
    req.headers["x-forwarded-for"] || ""
  )
    .split(",")[0]
    .trim();

const rawRequestIp =
  forwardedIp ||
  String(req.ip || "").trim();

const isLocalIp =
  !rawRequestIp ||
  rawRequestIp === "::1" ||
  rawRequestIp === "127.0.0.1" ||
  rawRequestIp === "::ffff:127.0.0.1" ||
  rawRequestIp.startsWith("192.168.") ||
  rawRequestIp.startsWith("10.");

const requestIp =
  isLocalIp
    ? "192.0.2.1"
    : rawRequestIp.replace(/^::ffff:/, "");

      const coinbase =
        await createCoinbaseOnrampSession({
          walletAddress: input.walletAddress,
          amount: input.amount,
          clientIp: requestIp
        });

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      /*
        Coinbase session token is temporary.
        Do NOT store it in SQLite.

        Store only the provider/order shell
        and the hosted checkout URL.
      */
      db.prepare(`
        INSERT INTO money_orders (
          id,
          workspace_id,
          direction,
          asset,
          amount,
          country,
          fiat_currency,
          wallet_type,
          wallet_address,
          provider,
          provider_order_id,
          provider_status,
          status,
          checkout_url,
          created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        id,
        input.workspaceId,
        "FIAT_IN",
        input.asset,
        input.amount,
        input.country,
        input.fiatCurrency,
        input.walletType,
        input.walletAddress,
        "coinbase",
        null,
        coinbase.providerStatus,
        "AWAITING_SENDER_PAYMENT",
        coinbase.checkoutUrl,
        now,
        now
      );

      return res.status(201).json({
        success: true,
        available: true,
        orderId: id,
        provider: "coinbase",
        providerStatus:
          coinbase.providerStatus,
        status: "AWAITING_SENDER_PAYMENT",
        checkoutUrl:
          coinbase.checkoutUrl,
        requiresKyc: true,
        providerHostedFlow: true,
        message:
          "Coinbase Onramp session created."
      });
    }

    return res.status(501).json({
      success: false,
      code: "PROVIDER_ADAPTER_NOT_IMPLEMENTED",
      error:
        "The selected provider adapter is not implemented yet."
    });
  } catch (err) {
    console.error(
      "Start money provider session error:",
      err?.message || err
    );

    return res.status(400).json({
      success: false,
      error:
        err?.message ||
        "Failed to start money provider session"
    });
  }
}

app.post("/api/money/fiat-in", (req, res) =>
  startMoneyProviderSession(req, res, "FIAT_IN")
);

app.post("/api/money/fiat-out", (req, res) =>
  startMoneyProviderSession(req, res, "FIAT_OUT")
);

app.get("/api/money/orders/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!id || !workspaceId) {
      return res.status(400).json({
        success: false,
        error: "Order ID and workspace are required"
      });
    }

    const order = db.prepare(`
      SELECT *
      FROM money_orders
      WHERE id = ?
        AND workspace_id = ?
      LIMIT 1
    `).get(id, workspaceId);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Money order not found"
      });
    }

    return res.json({
      success: true,
      order
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to load money order"
    });
  }
});

app.post("/api/withdrawals", async (req, res) => {
  try {
    const {
      googleAccessToken,
      country,
      bankName,
      accountHolder,
      accountNumber,
      claimId
    } = req.body;

    if (!claimId) {
      return res.status(400).json({
        success: false,
        error: "Missing claimId"
      });
    }

    if (!googleAccessToken) {
      return res.status(403).json({
        success: false,
        error: "Google verification is required"
      });
    }

    const { claim, googleUser } =
      await verifyClaimRecipient(
        claimId,
        googleAccessToken
      );

if (String(claim.claim_type || "").toUpperCase() === "PAYMENT_INTENT_CHOICE") {
  return res.status(409).json({
    success: false,
    error: "This recipient-choice claim cannot create a bank withdrawal. Select the delivery method first; provider payout is a later step."
  });
}

if (String(claim.status || "").toUpperCase() === "CLAIMED") {
  return res.status(409).json({
    success: false,
    error:
      "This claim has already been claimed to a wallet."
  });
}

    if (
      !country ||
      !bankName ||
      !accountHolder ||
      !accountNumber
    ) {
      return res.status(400).json({
        success: false,
        error: "Bank information is required"
      });
    }

    const existing = db.prepare(`
      SELECT id
      FROM withdrawals
      WHERE claim_id = ?
      LIMIT 1
    `).get(String(claimId));

    if (existing) {
      return res.status(409).json({
        success: false,
        error:
          "This claim already has a bank withdrawal request."
      });
    }

const offRamp = selectOffRampProvider({
  country
});

const destinationMasked =
  maskBankAccount(accountNumber);

    const id = crypto.randomUUID();

    db.prepare(`
  INSERT INTO withdrawals (
    id,
    workspace_id,
    email,
    amount,
    country,
    bank_name,
    account_holder,
    account_number,
    claim_id,
    status,
    created_at,
    provider,
    provider_status,
    fiat_currency,
    destination_masked
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  id,
  claim.workspace_id || null,
  googleUser.email,
  claim.amount,
  country,
  bankName,
  accountHolder,
  accountNumber,
  String(claimId),
  offRamp.status,
  new Date().toISOString(),
  offRamp.provider,
  offRamp.providerStatus,
  null,
  destinationMasked
);

return res.json({
  success: true,
  withdrawalId: id,
  status: offRamp.status,
  provider: offRamp.provider,
  providerStatus: offRamp.providerStatus
});

  } catch (err) {
    console.error(
      "Create claim withdrawal error:",
      err
    );

    return res.status(500).json({
      success: false,
      error:
        err?.message ||
        "Failed to create bank withdrawal request"
    });
  }
});

app.get("/api/withdrawals/claim/:claimId", (req, res) => {
  try {
    const { claimId } = req.params;

    if (!claimId) {
      return res.status(400).json({
        error: "Missing claimId"
      });
    }

    const withdrawal = db.prepare(`
      SELECT *
      FROM withdrawals
      WHERE claim_id = ?
      LIMIT 1
    `).get(claimId);

    if (!withdrawal) {
      return res.status(404).json({
        error: "Withdrawal not found"
      });
    }

    res.json(withdrawal);
  } catch (err) {
    console.error("Get withdrawal by claim error:", err);

    res.status(500).json({
      error: err.message || "Failed to load withdrawal"
    });
  }
});

app.get("/api/withdrawals", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const rows = db.prepare(`
      SELECT *
      FROM withdrawals
      WHERE workspace_id = ?
      ORDER BY created_at DESC
    `).all(workspaceId);

    return res.json(rows);
  } catch (err) {
    console.error(
      "Load withdrawals error:",
      err
    );

    return res.status(500).json({
      error: "Failed to load withdrawals"
    });
  }
});

app.post("/api/withdrawals/:id/status", async (req, res) => {
  try {
    const { id } = req.params;

const workspaceId = String(
  req.body.workspaceId || ""
).trim();

const { status } = req.body;

if (!workspaceId) {
  return res.status(400).json({
    error: "Workspace is required"
  });
}

    const allowed = ["PENDING", "REVIEW", "APPROVED", "COMPLETED", "REJECTED"];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid withdrawal status" });
    }

if (status === "COMPLETED") {
  return res.status(409).json({
    success: false,
    error:
      "Withdrawal cannot be completed until off-ramp settlement is verified."
  });
}

    const timestampColumn = {
  REVIEW: "reviewed_at",
  APPROVED: "approved_at",
  COMPLETED: "completed_at",
  REJECTED: "rejected_at"
}[status];

if (timestampColumn) {
  const result = db.prepare(`
  UPDATE withdrawals
  SET status = ?,
      ${timestampColumn} = ?
  WHERE id = ?
    AND workspace_id = ?
`).run(
  status,
  new Date().toISOString(),
  id,
  workspaceId
);

if (result.changes === 0) {
  return res.status(404).json({
    error: "Withdrawal not found in this workspace"
  });
}
} else {
  const result = db.prepare(`
  UPDATE withdrawals
  SET status = ?
  WHERE id = ?
    AND workspace_id = ?
`).run(
  status,
  id,
  workspaceId
);

if (result.changes === 0) {
  return res.status(404).json({
    error: "Withdrawal not found in this workspace"
  });
}
}

const row = db.prepare(`
  SELECT *
  FROM withdrawals
  WHERE id = ?
    AND workspace_id = ?
`).get(id, workspaceId);

await resend.emails.send({
  from: "TROR <no-reply@mail.tror.app>",
  to: [row.email],
  subject: `TROR withdrawal ${status}`,
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

const workspaceId = String(
  req.query.workspaceId || ""
).trim();

if (!workspaceId) {
  return res.status(400).json({
    error: "Workspace is required"
  });
}

    const totalReceivedRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM invoices
      WHERE status = 'PAID'
      AND workspace_id = ?
    `).get(workspaceId);

    const paidCountRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status = 'PAID'
      AND workspace_id = ?
    `).get(workspaceId);

    const pendingCountRow = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status != 'PAID'
      AND workspace_id = ?
    `).get(workspaceId);

    const latestPayment = db.prepare(`
      SELECT id, title, amount, txHash, paidAt
      FROM invoices
      WHERE status = 'PAID'
      AND workspace_id = ?
      ORDER BY paidAt DESC
      LIMIT 1
    `).get(workspaceId);

    const totalInvoicesRow = db.prepare(`
  SELECT COUNT(*) AS count
  FROM invoices
  WHERE workspace_id = ?
`).get(workspaceId);

const totalPayrollsRow = db.prepare(`
  SELECT COUNT(*) AS count
  FROM payroll_batches
  WHERE workspace_id = ?
`).get(workspaceId);

    const totalClaimsRow = db.prepare(`
  SELECT COUNT(*) AS count
  FROM claims
  WHERE workspace_id = ?
`).get(workspaceId);

    const invoiceVolumeRow = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total
  FROM invoices
  WHERE status = 'PAID'
  AND workspace_id = ?
`).get(workspaceId);

const claimVolumeRow = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total
  FROM claims
  WHERE status = 'FUNDED'
  AND workspace_id = ?
`).get(workspaceId);

const payoutVolumeRow = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total
  FROM payouts
  WHERE status = 'PAID'
  AND workspace_id = ?
`).get(workspaceId);

const totalVolume =
  Number(invoiceVolumeRow?.total || 0) +
  Number(claimVolumeRow?.total || 0) +
  Number(payoutVolumeRow?.total || 0);

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
  LEFT JOIN payroll_items i
    ON i.batch_id = b.id
    AND i.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
  GROUP BY b.id
  ORDER BY b.created_at DESC
  LIMIT 1
`).get(workspaceId);

if (latestPayroll) {
  recentActivity.push({
    type: "payroll",
    text: `Payroll executed: ${latestPayroll.title}`
  });
}

const latestClaim = db.prepare(`
  SELECT recipientEmail, amount
  FROM claims
  WHERE workspace_id = ?
  ORDER BY createdAt DESC
  LIMIT 1
`).get(workspaceId);

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
  totalVolume,

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
    walletAddress: process.env.TROR_TREASURY_WALLET || ""
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
            referrerDomain: "https://tror.app",
            productsAvailed: "BUY",
            fiatAmount: Number(amount) || 10,
            fiatCurrency: "USD",
            cryptoCurrencyCode: "USDC",
            network: "polygon",
          walletAddress: process.env.TROR_TREASURY_WALLET,
            paymentMethod: "credit_debit_card",
            redirectURL: "https://tror.app/transak-return"
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
      process.env.TROR_TREASURY_WALLET;

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
      "https://tror.app";

    const claimLink =
      `${APP_URL}/claim/${claimId}`;

    // send email
    await resend.emails.send({
      from:
       "TROR <no-reply@mail.tror.app>",

      to: [email],

      subject:
        "TROR Claim USDC",

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

app.post("/api/claims/send-email", async (req, res) => {
  try {
    const {
  recipientEmail,
  amount,
  message,
  claimId,
  txHash,
  workspaceId
} = req.body;

console.log("CLAIM REQUEST BODY:", req.body);
console.log("CLAIM WORKSPACE ID:", workspaceId);

    if (!recipientEmail || !amount) {
      return res.status(400).json({ error: "recipientEmail and amount are required" });
    }

if (!workspaceId) {
  return res.status(400).json({
    error: "Workspace is required"
  });
}

const workspace = db.prepare(`
  SELECT *
  FROM workspaces
  WHERE id = ?
    AND status = 'ACTIVE'
`).get(workspaceId);

if (!workspace) {
  return res.status(404).json({
    error: "Workspace not found"
  });
}

    const id = claimId ? String(claimId) : crypto.randomUUID();
    const appUrl = String(process.env.APP_URL || "http://localhost:5173").replace(/\/+$/, "");
    const claimLink = `${appUrl}/claim/${id}`;

    db.prepare(`
  INSERT INTO claims (
    id,
    recipientEmail,
    amount,
    message,
    status,
    createdAt,
    txHash,
    workspace_id
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  id,
  recipientEmail,
  Number(amount),
  message || "",
  "FUNDED",
  new Date().toISOString(),
  txHash || null,
  workspaceId
);

    const { data, error } = await resend.emails.send({
  from: "TROR <no-reply@mail.tror.app>",
  to: recipientEmail,
  subject: `You have a message from TROR`,
html: `
  <div style="font-family:Arial,sans-serif;padding:20px;color:#111;">
    <h2>TROR Message</h2>

    <p>You have a new TROR message waiting for you.</p>

    <div style="margin-top:16px;padding:14px;background:#f3f4f6;border-radius:12px;">
      <p><b>Recipient:</b> ${recipientEmail}</p>
      <p><b>TROR Message:</b> Ready</p>
    </div>

    <p style="margin-top:18px;">Open your TROR messages:</p>

    <a href="${claimLink}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:white;text-decoration:none;border-radius:10px;font-weight:bold;">
  Open your TROR messages
</a>

    <p style="margin-top:24px;font-size:12px;color:#6b7280;">
      This message was generated automatically by TROR.
    </p>
  </div>
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

app.get("/api/claims", (req, res) => {
  try {
    const workspaceId = String(
      req.query.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        success: false,
        error: "Workspace is required",
        claims: []
      });
    }

    const workspace = db.prepare(`
      SELECT id
      FROM workspaces
      WHERE id = ?
        AND status = 'ACTIVE'
    `).get(workspaceId);

    if (!workspace) {
      return res.status(404).json({
        success: false,
        error: "Workspace not found",
        claims: []
      });
    }

    const claims = db.prepare(`
      SELECT *
      FROM claims
      WHERE workspace_id = ?
      ORDER BY createdAt DESC
    `).all(workspaceId);

    return res.json({
      success: true,
      claims
    });
  } catch (err) {
    console.error("Load claims error:", err);

    return res.status(500).json({
      success: false,
      error: "Failed to load claims",
      details: err.message,
      claims: []
    });
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

  res.json(claim);
});

app.post("/api/claims/:id/claim", async (req, res) => {
  try {
    const {
      walletAddress,
      googleAccessToken
    } = req.body;

    const { id } = req.params;

    // Verify that the signed-in Google account
    // is the intended claim recipient.
    await verifyClaimRecipient(
      id,
      googleAccessToken
    );

    if (
      !walletAddress ||
      !ethers.isAddress(walletAddress)
    ) {
      return res.status(400).json({
        success: false,
        error: "Valid wallet address is required"
      });
    }

    const claim = db.prepare(`
      SELECT *
      FROM claims
      WHERE id = ?
    `).get(id);

    if (!claim) {
      return res.status(404).json({
        success: false,
        error: "Claim not found"
      });
    }

    if (String(claim.claim_type || "").toUpperCase() === "PAYMENT_INTENT_CHOICE") {
      return res.status(409).json({
        success: false,
        error: "This claim is for recipient delivery choice only. No USDC claim has been funded for wallet delivery."
      });
    }

    if (claim.status === "CLAIMED") {
      return res.status(400).json({
        success: false,
        error: "Claim already claimed"
      });
    }

const bankWithdrawal = db.prepare(`
  SELECT id, status
  FROM withdrawals
  WHERE claim_id = ?
  LIMIT 1
`).get(String(id));

if (
  bankWithdrawal &&
withdrawalBlocksWalletClaim(
  bankWithdrawal.status
)
) {
  return res.status(409).json({
    success: false,
    error:
      "This claim already has an active bank withdrawal request."
  });
}

    const amount =
      Number(claim.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid claim amount"
      });
    }

if (!CLAIM_VERIFIER_PRIVATE_KEY) {
  throw new Error(
    "CLAIM_VERIFIER_PRIVATE_KEY is not configured."
  );
}

if (!CLAIM_V2_CONTRACT_ADDRESS) {
  throw new Error(
    "CLAIM_V2_CONTRACT_ADDRESS is not configured."
  );
}

const authorizationDeadline =
  Math.floor(Date.now() / 1000) +
  10 * 60;

const verifierWallet =
  new ethers.Wallet(
    CLAIM_VERIFIER_PRIVATE_KEY
  );

if (
  CLAIM_VERIFIER_ADDRESS &&
  verifierWallet.address.toLowerCase() !==
    CLAIM_VERIFIER_ADDRESS.toLowerCase()
) {
  throw new Error(
    "CLAIM_VERIFIER_PRIVATE_KEY does not match CLAIM_VERIFIER_ADDRESS."
  );
}

const messageHash =
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256",
        "address",
        "uint256",
        "address",
        "bytes32",
        "uint256"
      ],
      [
        ARC_CHAIN_ID,
        CLAIM_V2_CONTRACT_ADDRESS,
        BigInt(id),
        walletAddress,
        ethers.keccak256(
          ethers.toUtf8Bytes(
            String(
              claim.recipientEmail || ""
            )
              .trim()
              .toLowerCase()
          )
        ),
        authorizationDeadline
      ]
    )
  );

const authorization =
  await verifierWallet.signMessage(
    ethers.getBytes(messageHash)
  );

return res.json({
  success: true,

  mode: "CONNECTED_WALLET",

  requiresWalletSignature: true,

  claim: {
    id: claim.id,
    recipientEmail:
      claim.recipientEmail,
    receiver:
      walletAddress,
    amount:
      Number(amount.toFixed(6)),
    status:
      claim.status
  },

  network: {
    chainId:
      ARC_CHAIN_ID,
    chainName:
      ARC_CHAIN_NAME,
    usdcAddress:
      USDC_ADDRESS,
    claimContract:
      CLAIM_V2_CONTRACT_ADDRESS
  },

  contractCall: {
    functionName:
      "claim",

    args: [
      id,
      String(
        authorizationDeadline
      ),
      authorization
    ]
  }
});

  } catch (err) {
    console.error(
      "PREPARE CLAIM ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      error:
        err?.message ||
        "Failed to prepare claim"
    });
  }
});

app.post(
  "/api/claims/:id/confirm",
  async (req, res) => {
    try {
      const { id } = req.params;

      const txHash = String(
        req.body.txHash || ""
      ).trim();

      const walletAddress = String(
        req.body.walletAddress || ""
      ).trim();

      const walletType = String(
        req.body.walletType || "web3"
      )
        .trim()
        .toLowerCase();

      const circleUserToken = String(
        req.body.circleUserToken || ""
      ).trim();

      const circleWalletId = String(
        req.body.circleWalletId || ""
      ).trim();

      if (!txHash.startsWith("0x")) {
        return res.status(400).json({
          success: false,
          error:
            "Valid transaction hash is required"
        });
      }

      if (
        !walletAddress ||
        !ethers.isAddress(walletAddress)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Valid wallet address is required"
        });
      }

      if (
        walletType !== "web3" &&
        walletType !== "circle"
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid wallet type"
        });
      }

      const claim = db.prepare(`
        SELECT *
        FROM claims
        WHERE id = ?
      `).get(String(id));

      if (!claim) {
        return res.status(404).json({
          success: false,
          error: "Claim not found"
        });
      }

      if (claim.status === "CLAIMED") {
  const storedTxHash =
    String(
      claim.txHash || ""
    )
      .trim()
      .toLowerCase();

  const storedWalletAddress =
    String(
      claim.walletAddress || ""
    )
      .trim()
      .toLowerCase();

  const submittedTxHash =
    txHash.toLowerCase();

  const submittedWalletAddress =
    walletAddress.toLowerCase();

  const sameTransaction =
    storedTxHash &&
    storedTxHash ===
      submittedTxHash;

  const sameReceiver =
    storedWalletAddress &&
    storedWalletAddress ===
      submittedWalletAddress;

  if (
    sameTransaction &&
    sameReceiver
  ) {
    /*
      Idempotent retry of the same
      successfully confirmed claim.
    */
    return res.json({
      success: true,
      alreadyClaimed: true,
      claim
    });
  }

  return res.status(409).json({
    success: false,
    error:
      "Claim has already been received by another confirmed transaction."
  });
}

      const amount =
        Number(claim.amount);

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid claim amount"
        });
      }

      const expectedAmount =
        ethers.parseUnits(
          amount.toFixed(6),
          6
        );

      const receipt =
        await provider.getTransactionReceipt(
          txHash
        );

      if (!receipt) {
        return res.status(400).json({
          success: false,
          error:
            "Claim transaction is not confirmed yet"
        });
      }

      if (Number(receipt.status) !== 1) {
        return res.status(400).json({
          success: false,
          error:
            "Claim transaction failed on-chain"
        });
      }

      /*
        ==================================================
        CIRCLE SCA VERIFICATION
        ==================================================

        Circle SCA outer transaction may not have:

          transaction.to === TRORClaim V2
          transaction.from === Circle wallet

        Therefore verify:

          1. Circle transaction metadata
          2. Arc receipt
          3. ClaimPaid event emitted by TRORClaim V2
      */
      if (walletType === "circle") {
        if (!circleUserToken) {
          return res.status(400).json({
            success: false,
            error:
              "Circle user token is required"
          });
        }

        if (!circleWalletId) {
          return res.status(400).json({
            success: false,
            error:
              "Circle wallet ID is required"
          });
        }

        if (!requireCircle(res)) {
          return;
        }

        const circleResponse =
          await fetch(
            "https://api.circle.com/v1/w3s/transactions",
            {
              method: "GET",
              headers: {
                Authorization:
                  `Bearer ${CIRCLE_API_KEY}`,
                "X-User-Token":
                  circleUserToken,
                "Content-Type":
                  "application/json"
              }
            }
          );

        const circleData =
          await circleResponse.json();

        if (!circleResponse.ok) {
          return res
            .status(circleResponse.status)
            .json({
              success: false,
              error:
                circleData?.message ||
                circleData?.error ||
                "Failed to verify Circle claim transaction"
            });
        }

        const circleTransactions =
          circleData?.data
            ?.transactions ||
          [];

        const circleTransaction =
          circleTransactions.find(
            (item) => {
              const hash =
                item?.blockchainTxHash ||
                item?.txHash ||
                item?.transactionHash ||
                "";

              return (
                String(hash).toLowerCase() ===
                txHash.toLowerCase()
              );
            }
          );

        console.log(
  "TROR Circle claim verification metadata:",
  {
    id:
      circleTransaction?.id || null,

    state:
      circleTransaction?.state ||
      circleTransaction?.status ||
      null,

    operation:
      circleTransaction?.operation ||
      null,

    transactionType:
      circleTransaction?.transactionType ||
      circleTransaction?.type ||
      null,

    blockchain:
      circleTransaction?.blockchain ||
      null,

    walletId:
      circleTransaction?.walletId ||
      null,

    contractAddress:
      circleTransaction?.contractAddress ||
      circleTransaction?.destinationAddress ||
      null,

    sourceAddress:
      circleTransaction?.sourceAddress ||
      null,

    blockchainTxHash:
      circleTransaction?.blockchainTxHash ||
      circleTransaction?.txHash ||
      circleTransaction?.transactionHash ||
      null
  }
);

        const circleState =
          String(
            circleTransaction?.state ||
            circleTransaction?.status ||
            ""
          ).toUpperCase();

        if (circleState !== "COMPLETE") {
          return res.status(400).json({
            success: false,
            error:
              "Circle claim transaction is not complete"
          });
        }

        const circleOperation =
          String(
            circleTransaction?.operation ||
            ""
          ).toUpperCase();

        const circleTransactionType =
          String(
            circleTransaction
              ?.transactionType ||
            circleTransaction?.type ||
            ""
          ).toUpperCase();

        const transactionWalletId =
          String(
            circleTransaction?.walletId ||
            ""
          );

        if (
          transactionWalletId !==
          circleWalletId
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Circle claim wallet does not match"
          });
        }

        const circleBlockchain =
          String(
            circleTransaction?.blockchain ||
            ""
          ).toUpperCase();

        if (
          circleBlockchain !==
          "ARC-TESTNET"
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Circle claim is not on Arc Testnet"
          });
        }

        const expectedClaimContract =
          String(
            CLAIM_V2_CONTRACT_ADDRESS
          ).toLowerCase();

        const expectedReceiver =
          walletAddress.toLowerCase();

        const circleContractAddress =
          String(
            circleTransaction
              ?.contractAddress ||
            circleTransaction
              ?.destinationAddress ||
            ""
          ).toLowerCase();

        const circleSourceAddress =
          String(
            circleTransaction
              ?.sourceAddress ||
            ""
          ).toLowerCase();

        /*
          Circle can expose the same Arc
          contract claim in two representations:

          1. CONTRACT_EXECUTION
             receiver SCA -> TRORClaim

          2. TRANSFER / INBOUND
             TRORClaim -> receiver SCA

          The ClaimPaid event verified below
          remains the authoritative on-chain
          proof in both cases.
        */
        const isContractExecution =
          circleOperation ===
            "CONTRACT_EXECUTION" &&
          circleContractAddress ===
            expectedClaimContract &&
          circleSourceAddress ===
            expectedReceiver;

        const isInboundClaimTransfer =
          circleOperation ===
            "TRANSFER" &&
          circleTransactionType ===
            "INBOUND" &&
          circleSourceAddress ===
            expectedClaimContract &&
          circleContractAddress ===
            expectedReceiver;

        if (
          !isContractExecution &&
          !isInboundClaimTransfer
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Circle transaction does not match the TROR claim flow"
          });
        }

        /*
          Verify the actual ClaimPaid event
          emitted by TRORClaim V2.

          This proves that claim() completed
          successfully and USDC was sent to
          the expected Circle SCA receiver.
        */
        const claimEventInterface =
          new ethers.Interface([
            "event ClaimPaid(uint256 indexed claimId,address indexed receiver,uint256 amount,string memo)"
          ]);

        let claimPaidEvent = null;

        for (
          const log of receipt.logs || []
        ) {
          if (
            String(log?.address || "")
              .toLowerCase() !==
            String(
              CLAIM_V2_CONTRACT_ADDRESS
            ).toLowerCase()
          ) {
            continue;
          }

          try {
            const parsedLog =
              claimEventInterface.parseLog({
                topics: log.topics,
                data: log.data
              });

            if (
              parsedLog?.name ===
              "ClaimPaid"
            ) {
              claimPaidEvent =
                parsedLog;
              break;
            }
          } catch {
            // Ignore unrelated logs.
          }
        }

        if (!claimPaidEvent) {
          return res.status(400).json({
            success: false,
            error:
              "TRORClaim ClaimPaid event was not found"
          });
        }

        const eventClaimId =
          String(
            claimPaidEvent.args[0]
          );

        const eventReceiver =
          String(
            claimPaidEvent.args[1]
          ).toLowerCase();

        const eventAmount =
          BigInt(
            claimPaidEvent.args[2]
          );

        if (
          eventClaimId !==
          String(id)
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Claim event ID does not match"
          });
        }

        if (
          eventReceiver !==
          walletAddress.toLowerCase()
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Claim event receiver does not match"
          });
        }

        if (
          eventAmount !==
          expectedAmount
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Claim event amount does not match"
          });
        }
      }

      /*
        ==================================================
        WEB3 / EOA VERIFICATION
        ==================================================

        Keep the existing direct-wallet
        verification unchanged.
      */
      else {
        const transaction =
          await provider.getTransaction(
            txHash
          );

        if (!transaction) {
          return res.status(400).json({
            success: false,
            error:
              "Claim transaction could not be loaded"
          });
        }

        if (
          String(transaction.to || "")
            .toLowerCase() !==
          String(
            CLAIM_V2_CONTRACT_ADDRESS
          ).toLowerCase()
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Transaction was not sent to TRORClaim V2"
          });
        }

        const claimInterface =
          new ethers.Interface([
            "function claim(uint256 claimId,uint256 authorizationDeadline,bytes authorization)"
          ]);

        let parsed;

        try {
          parsed =
            claimInterface.parseTransaction({
              data: transaction.data,
              value: transaction.value
            });
        } catch {
          return res.status(400).json({
            success: false,
            error:
              "Transaction is not a TRORClaim V2 claim"
          });
        }

        const txClaimId =
          parsed.args[0].toString();

        if (
          txClaimId !==
          String(id)
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Transaction claimId does not match"
          });
        }

        const sender =
          String(
            transaction.from || ""
          ).toLowerCase();

        if (
          sender !==
          walletAddress.toLowerCase()
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Transaction sender does not match receiving wallet"
          });
        }
      }

      /*
        Both verification paths have now
        proved the on-chain claim.
      */
      const now =
        new Date().toISOString();

      db.prepare(`
        UPDATE claims
        SET status = 'CLAIMED',
            walletAddress = ?,
            txHash = ?,
            claimedAt = ?
        WHERE id = ?
      `).run(
        walletAddress,
        txHash,
        now,
        String(id)
      );

      const updatedClaim =
        db.prepare(`
          SELECT *
          FROM claims
          WHERE id = ?
        `).get(String(id));

      return res.json({
        success: true,
        claim: updatedClaim
      });

    } catch (err) {
      console.error(
        "CONFIRM CLAIM ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err?.message ||
          "Failed to confirm claim"
      });
    }
  }
);

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
      from: "TROR <no-reply@mail.tror.app>",
      to: ["maihongha14021992mhh12@gmail.com"],
      subject: "Test email from TROR 🚀",
      html: "<h1>TROR email is working!</h1>",
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
  from: "TROR <no-reply@mail.tror.app>",

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

// cron.schedule("*/1 * * * *", async () => {
//   checkInvoices();
//   console.log("AUTO PAYOUT CHECK...");

//   const payouts = db.prepare(`
//     SELECT * FROM payouts
//     WHERE status = 'PENDING'
//     ORDER BY created_at ASC
//     LIMIT 3
//   `).all();

//   for (const p of payouts) {
//   try {
//     db.prepare(`
//       UPDATE payouts
//       SET status = 'REVIEW'
//       WHERE id = ?
//       AND status = 'PENDING'
//     `).run(p.id);

//     console.log("Payout needs confirmation:", p.id);
//   } catch (err) {
//     console.error("Auto review error:", err.message);
//   }
// }
// });

app.post("/api/payouts/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;

    const workspaceId = String(
      req.body.workspaceId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    const payout = db.prepare(`
      SELECT *
      FROM payouts
      WHERE id = ?
        AND workspace_id = ?
    `).get(id, workspaceId);

    if (!payout) {
      return res.status(404).json({
        error: "Payout not found in this workspace"
      });
    }

    if (
  payout.status !== "PENDING" &&
  payout.status !== "REVIEW" &&
  payout.status !== "READY_TO_SIGN"
) {
  return res.status(400).json({
    error:
      "Only PENDING, REVIEW or READY_TO_SIGN payouts can be confirmed"
  });
}

    if (
  payout.mode === "scheduled" &&
  payout.status !== "READY_TO_SIGN"
) {
  if (!payout.next_run_at) {
    return res.status(400).json({
      error: "Scheduled payout is missing next_run_at"
    });
  }

  const scheduledTime = new Date(
    payout.next_run_at
  ).getTime();

  if (
    Number.isNaN(scheduledTime) ||
    scheduledTime <= Date.now()
  ) {
    return res.status(400).json({
      error: "Scheduled payout time must be in the future"
    });
  }

  db.prepare(`
    UPDATE payouts
    SET status = 'APPROVED'
    WHERE id = ?
      AND workspace_id = ?
      AND status IN ('PENDING', 'REVIEW')
  `).run(id, workspaceId);

  return res.json({
    message: "Scheduled payout approved",
    id,
    status: "APPROVED",
    nextRunAt: payout.next_run_at
  });
}


    const result = await preparePayoutById(
  id,
  workspaceId
);

return res.json({
  message:
    "Payout ready for wallet authorization",
  ...result
});
  } catch (err) {
    console.error("CONFIRM PAYOUT ERROR:", err);

    return res.status(500).json({
      error: "Confirm payout failed",
      details: err.message
    });
  }
});

app.post("/api/payouts/:id/verify", async (req, res) => {
  try {
    const { id } = req.params;

    const workspaceId = String(
      req.body.workspaceId || ""
    ).trim();

    const txHash = String(
      req.body.txHash || ""
    ).trim();

    const payerAddress = String(
      req.body.payerAddress || ""
    ).trim();

    const walletType = String(
      req.body.walletType || "web3"
    )
      .trim()
      .toLowerCase();

    const circleUserToken = String(
      req.body.circleUserToken || ""
    ).trim();

    const circleWalletId = String(
      req.body.circleWalletId || ""
    ).trim();

    if (!workspaceId) {
      return res.status(400).json({
        error: "Workspace is required"
      });
    }

    if (!txHash.startsWith("0x")) {
      return res.status(400).json({
        error:
          "Valid transaction hash is required"
      });
    }

    if (
      !payerAddress ||
      !ethers.isAddress(payerAddress)
    ) {
      return res.status(400).json({
        error:
          "Valid payer address is required"
      });
    }

    if (
      walletType !== "web3" &&
      walletType !== "circle"
    ) {
      return res.status(400).json({
        error: "Invalid wallet type"
      });
    }

    const payout = db.prepare(`
      SELECT *
      FROM payouts
      WHERE id = ?
        AND workspace_id = ?
    `).get(
      id,
      workspaceId
    );

    if (!payout) {
      return res.status(404).json({
        error:
          "Payout not found in this workspace"
      });
    }

    if (payout.status === "PAID") {
      return res.json({
        success: true,
        id,
        status: "PAID",
        txHash: payout.tx_hash
      });
    }

    const receipt =
      await provider.getTransactionReceipt(
        txHash
      );

    if (!receipt) {
      return res.status(400).json({
        error:
          "Payout transaction is not confirmed yet"
      });
    }

    if (Number(receipt.status) !== 1) {
      return res.status(400).json({
        error:
          "Payout transaction failed on-chain"
      });
    }

    const TROR_PAYOUT_CONTRACT_ADDRESS =
      "0xaD91ad41D59cACA639D3Da3123d14DA009b8f3f5";

    const expectedPayoutId =
      ethers.keccak256(
        ethers.toUtf8Bytes(
          `tror-payout-${id}`
        )
      );

    if (!ethers.isAddress(payout.recipient)) {
      return res.status(400).json({
        error:
          "Invalid payout recipient"
      });
    }

    const expectedAmount =
      ethers.parseUnits(
        Number(payout.amount)
          .toFixed(6),
        6
      );

    /*
      ==================================================
      CIRCLE SCA VERIFICATION
      ==================================================

      Circle SCA outer transaction may not have:
        transaction.to === TRORPayout
        transaction.from === Circle wallet

      Therefore verify:
        1. Circle transaction metadata
        2. Arc receipt
        3. PayoutExecuted event emitted by TRORPayout
    */
    if (walletType === "circle") {
      if (!circleUserToken) {
        return res.status(400).json({
          error:
            "Circle user token is required"
        });
      }

      if (!circleWalletId) {
        return res.status(400).json({
          error:
            "Circle wallet ID is required"
        });
      }

      if (!requireCircle(res)) {
        return;
      }

      const circleResponse =
        await fetch(
          "https://api.circle.com/v1/w3s/transactions",
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token":
                circleUserToken,
              "Content-Type":
                "application/json"
            }
          }
        );

      const circleData =
        await circleResponse.json();

      if (!circleResponse.ok) {
        return res
          .status(circleResponse.status)
          .json({
            error:
              circleData?.message ||
              circleData?.error ||
              "Failed to verify Circle transaction"
          });
      }

      const circleTransactions =
        circleData?.data
          ?.transactions ||
        [];

      const circleTransaction =
        circleTransactions.find(
          (item) => {
            const hash =
              item?.blockchainTxHash ||
              item?.txHash ||
              item?.transactionHash ||
              "";

            return (
              String(hash).toLowerCase() ===
              txHash.toLowerCase()
            );
          }
        );

      if (!circleTransaction) {
        return res.status(400).json({
          error:
            "Circle transaction was not found"
        });
      }

      const circleState =
        String(
          circleTransaction?.state ||
          circleTransaction?.status ||
          ""
        ).toUpperCase();

      if (circleState !== "COMPLETE") {
        return res.status(400).json({
          error:
            "Circle payout transaction is not complete"
        });
      }

      const circleOperation =
        String(
          circleTransaction?.operation ||
          ""
        ).toUpperCase();

      if (
        circleOperation !==
        "CONTRACT_EXECUTION"
      ) {
        return res.status(400).json({
          error:
            "Circle transaction is not a contract execution"
        });
      }

      const transactionWalletId =
        String(
          circleTransaction?.walletId ||
          ""
        );

      if (
        transactionWalletId !==
        circleWalletId
      ) {
        return res.status(400).json({
          error:
            "Circle payout wallet does not match"
        });
      }

      const circleBlockchain =
        String(
          circleTransaction?.blockchain ||
          ""
        ).toUpperCase();

      if (
        circleBlockchain !==
        "ARC-TESTNET"
      ) {
        return res.status(400).json({
          error:
            "Circle payout is not on Arc Testnet"
        });
      }

      const circleContractAddress =
        String(
          circleTransaction
            ?.contractAddress ||
          ""
        ).toLowerCase();

      if (
        circleContractAddress !==
        TROR_PAYOUT_CONTRACT_ADDRESS
          .toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Circle transaction was not sent to TRORPayout"
        });
      }

      const circleSourceAddress =
        String(
          circleTransaction
            ?.sourceAddress ||
          ""
        ).toLowerCase();

      if (
        circleSourceAddress !==
        payerAddress.toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Circle payout payer does not match"
        });
      }

      /*
        Verify actual TRORPayout event
        from Arc receipt.

        This confirms that executePayout()
        completed successfully and USDC
        transferFrom succeeded.
      */
      const payoutEventInterface =
        new ethers.Interface([
          "event PayoutExecuted(bytes32 indexed payoutId,address indexed payer,address indexed recipient,uint256 amount)"
        ]);

      let payoutEvent = null;

      for (const log of receipt.logs || []) {
        if (
          String(log?.address || "")
            .toLowerCase() !==
          TROR_PAYOUT_CONTRACT_ADDRESS
            .toLowerCase()
        ) {
          continue;
        }

        try {
          const parsedLog =
            payoutEventInterface.parseLog({
              topics: log.topics,
              data: log.data
            });

          if (
            parsedLog?.name ===
            "PayoutExecuted"
          ) {
            payoutEvent =
              parsedLog;
            break;
          }
        } catch {
          // Ignore unrelated logs.
        }
      }

      if (!payoutEvent) {
        return res.status(400).json({
          error:
            "TRORPayout execution event was not found"
        });
      }

      const eventPayoutId =
        String(
          payoutEvent.args[0]
        ).toLowerCase();

      const eventPayer =
        String(
          payoutEvent.args[1]
        ).toLowerCase();

      const eventRecipient =
        String(
          payoutEvent.args[2]
        ).toLowerCase();

      const eventAmount =
        BigInt(
          payoutEvent.args[3]
        );

      if (
        eventPayoutId !==
        expectedPayoutId.toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Payout ID does not match"
        });
      }

      if (
        eventPayer !==
        payerAddress.toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Payout event payer does not match"
        });
      }

      if (
        eventRecipient !==
        String(
          payout.recipient
        ).toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Payout recipient does not match"
        });
      }

      if (
        eventAmount !==
        expectedAmount
      ) {
        return res.status(400).json({
          error:
            "Payout amount does not match"
        });
      }
    }

    /*
      ==================================================
      WEB3 / EOA VERIFICATION
      ==================================================
    */
    else {
      const transaction =
        await provider.getTransaction(
          txHash
        );

      if (!transaction) {
        return res.status(400).json({
          error:
            "Payout transaction could not be loaded"
        });
      }

      if (
        String(transaction.to || "")
          .toLowerCase() !==
        TROR_PAYOUT_CONTRACT_ADDRESS
          .toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Transaction was not sent to TRORPayout"
        });
      }

      if (
        String(transaction.from || "")
          .toLowerCase() !==
        payerAddress.toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Payout transaction payer does not match"
        });
      }

      const payoutInterface =
        new ethers.Interface([
          "function executePayout(bytes32 payoutId,address recipient,uint256 amount)"
        ]);

      let parsed;

      try {
        parsed =
          payoutInterface
            .parseTransaction({
              data:
                transaction.data,
              value:
                transaction.value
            });
      } catch {
        return res.status(400).json({
          error:
            "Transaction is not a TRORPayout execution"
        });
      }

      if (
        parsed?.name !==
        "executePayout"
      ) {
        return res.status(400).json({
          error:
            "Invalid TRORPayout function"
        });
      }

      if (
        String(parsed.args[0])
          .toLowerCase() !==
        expectedPayoutId
          .toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Payout ID does not match"
        });
      }

      const txRecipient =
        String(
          parsed.args[1]
        );

      if (
        txRecipient.toLowerCase() !==
        String(
          payout.recipient
        ).toLowerCase()
      ) {
        return res.status(400).json({
          error:
            "Payout recipient does not match"
        });
      }

      const txAmount =
        BigInt(
          parsed.args[2]
        );

      if (
        txAmount !==
        expectedAmount
      ) {
        return res.status(400).json({
          error:
            "Payout amount does not match"
        });
      }
    }

    /*
      ==================================================
      VERIFIED — UPDATE DATABASE
      ==================================================
    */
    const result =
      db.prepare(`
        UPDATE payouts
        SET status = 'PAID',
            tx_hash = ?
        WHERE id = ?
          AND workspace_id = ?
          AND status != 'PAID'
      `).run(
        txHash,
        id,
        workspaceId
      );

    if (result.changes !== 1) {
      const current =
        db.prepare(`
          SELECT status, tx_hash
          FROM payouts
          WHERE id = ?
            AND workspace_id = ?
        `).get(
          id,
          workspaceId
        );

      if (
        current?.status !==
        "PAID"
      ) {
        return res.status(409).json({
          error:
            "Payout status changed. Please refresh."
        });
      }
    }

    return res.json({
      success: true,
      id,
      status: "PAID",
      txHash
    });

  } catch (err) {
    console.error(
      "VERIFY PAYOUT ERROR:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Failed to verify payout"
    });
  }
});

// =======================
// SCHEDULED PAYOUT CRON
// NON-CUSTODIAL
// =======================

let payoutSchedulerRunning = false;

cron.schedule("* * * * *", async () => {
  if (payoutSchedulerRunning) {
    console.log(
      "Scheduled payout check skipped: previous run still active"
    );
    return;
  }

  payoutSchedulerRunning = true;

  try {
    const duePayouts = db.prepare(`
      SELECT *
      FROM payouts
      WHERE mode = 'scheduled'
        AND frequency = 'once'
        AND status = 'APPROVED'
        AND next_run_at IS NOT NULL
        AND datetime(next_run_at) <= datetime('now')
      ORDER BY datetime(next_run_at) ASC
      LIMIT 20
    `).all();

    if (duePayouts.length === 0) {
      return;
    }

    console.log(
      `Found ${duePayouts.length} scheduled payout(s) ready for wallet authorization`
    );

    for (const payout of duePayouts) {
      try {
        /*
         * NON-CUSTODIAL:
         *
         * The server NEVER signs or sends USDC.
         *
         * When the scheduled time arrives,
         * the payout becomes READY_TO_SIGN.
         *
         * The connected Web3 or Circle wallet
         * must authorize the actual transaction.
         */
        const result = db.prepare(`
          UPDATE payouts
          SET status = 'READY_TO_SIGN'
          WHERE id = ?
            AND workspace_id = ?
            AND status = 'APPROVED'
        `).run(
          payout.id,
          payout.workspace_id
        );

        if (result.changes !== 1) {
          console.log(
            "Scheduled payout was already updated:",
            payout.id
          );

          continue;
        }

        console.log(
          "Scheduled payout ready for wallet authorization:",
          payout.id
        );

      } catch (err) {
        console.error(
          "Failed to prepare scheduled payout:",
          payout.id,
          err?.message || err
        );
      }
    }

  } catch (err) {
    console.error(
      "Scheduled payout cron error:",
      err
    );

  } finally {
    payoutSchedulerRunning = false;
  }
});

// =======================
// SCHEDULED PAYROLL CRON
// NON-CUSTODIAL
// =======================

let payrollSchedulerRunning = false;

cron.schedule("* * * * *", async () => {
  if (payrollSchedulerRunning) {
    console.log(
      "Scheduled payroll check skipped: previous run still active"
    );
    return;
  }

  payrollSchedulerRunning = true;

  try {
    const duePayrolls = db.prepare(`
      SELECT *
      FROM payroll_batches
      WHERE status = 'APPROVED'
        AND pay_date IS NOT NULL
        AND TRIM(pay_date) != ''
        AND datetime(pay_date) <= datetime('now')
      ORDER BY datetime(pay_date) ASC
      LIMIT 20
    `).all();

    if (duePayrolls.length === 0) {
      return;
    }

    console.log(
      `Found ${duePayrolls.length} payroll batch(es) ready for wallet authorization`
    );

    for (const payroll of duePayrolls) {
      try {
        /*
         * NON-CUSTODIAL:
         *
         * The server NEVER signs or sends USDC.
         *
         * When pay_date arrives,
         * the payroll becomes REVIEW.
         *
         * The connected Web3 or Circle wallet
         * must authorize the actual transaction.
         */
        const result = db.prepare(`
          UPDATE payroll_batches
          SET status = 'REVIEW'
          WHERE id = ?
            AND status = 'APPROVED'
        `).run(
          payroll.id
        );

        if (result.changes !== 1) {
          console.log(
            "Scheduled payroll was already updated:",
            payroll.id
          );

          continue;
        }

        db.prepare(`
          UPDATE payroll_items
          SET status = 'REVIEW'
          WHERE batch_id = ?
            AND status = 'APPROVED'
        `).run(
          payroll.id
        );

        console.log(
          "Scheduled payroll ready for wallet authorization:",
          payroll.id,
          payroll.frequency,
          payroll.pay_date
        );

      } catch (err) {
        console.error(
          "Failed to prepare scheduled payroll:",
          payroll.id,
          err?.message || err
        );
      }
    }

  } catch (err) {
    console.error(
      "Scheduled payroll cron error:",
      err
    );

  } finally {
    payrollSchedulerRunning = false;
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

app.use(express.static(distPath));

app.get("/claim/:id", (req, res) => {
  res.sendFile(path.join(distPath, "app.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"), (err) => {
    if (err) {
      res.status(404).send("Frontend not built. Use http://localhost:5173 for Vite dev.");
    }
  });
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(
   `TROR API running at http://localhost:${PORT}`
  );

  console.log(
   ` merchantAddress = ${MERCHANT_ADDRESS}`
  );

  console.log(
  ` circleKey = ${CIRCLE_API_KEY ? "loaded" : "missing"}`
  );
});