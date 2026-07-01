import React from "react";
import { createRoot } from "react-dom/client";
import PayoutPanel from "./PayoutPanel.jsx";
import "./style.css";
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import Web3 from "web3";
import PayrollPanel from "./PayrollPanel.jsx";
import { Html5Qrcode } from "html5-qrcode";
import { ethers } from "ethers";
import { CONTRACT_ADDRESS, CONTRACT_ABI, MEMO_ADDRESS, MEMO_ABI } from "./contract";
import { openAppKitWallet, wagmiAdapter } from "./appkit.js";
import { getAccount, readContract, writeContract, waitForTransactionReceipt } from "@wagmi/core";
import { parseUnits } from "viem";
window.openAppKitWallet = openAppKitWallet;

/* =========================
   WALLET CONNECT UI PATCH
   Integrated into main.jsx
========================= */

// Update topbar page title on tab switch
function updateTopbarTitle(tabId) {
  const titles = {
    dashboard:    "Dashboard",
    invoices:     "Invoices",
    customers:    "Customers",
    "gmail-claim":"Gmail Claim",
    payroll:      "Payroll",
    payouts:      "Payouts",
    business:     "Business"
  };
  const el = document.querySelector(".topbar-title");
  if (el) el.textContent = titles[tabId] || "ArcPay";
}

// Update wallet chip display state
function updateWalletChip(address, balance) {
  const dot  = document.getElementById("wcDot");
  const bal  = document.getElementById("walletChipBalance");
  const addr = document.getElementById("walletChipAddress");
  const btn  = document.getElementById("btnConnectWallet");

  if (address && address !== "Disconnected") {
    if (dot)  dot.classList.add("connected");
    if (bal)  bal.textContent = (balance || "0.00") + " USDC";
    if (addr) addr.textContent = address.slice(0,6) + "..." + address.slice(-4) + " ▾";
    if (btn)  {
      btn.textContent = "Connected ▾";
      btn.style.background = "rgba(0,232,135,0.15)";
      btn.style.borderColor = "rgba(0,232,135,0.3)";
    }

// Show/hide action buttons based on connection
const payBtn = document.getElementById("btnPay");
const scanBtn = document.getElementById("btnScanQR");

if (address && address !== "Disconnected") {
  if (payBtn) payBtn.style.display = "block";
  if (scanBtn) scanBtn.style.display = "block";
} else {
  if (payBtn) payBtn.style.display = "none";
  if (scanBtn) scanBtn.style.display = "none";
}

  } else {
    if (dot)  dot.classList.remove("connected");
    if (bal)  bal.textContent = "0.00 USDC";
    if (addr) addr.textContent = "Disconnected ▾";
    if (btn)  {
      btn.textContent = "Connect ▾";
      btn.style.background = "";
      btn.style.borderColor = "";
    }
  }
}

// Wallet chip click — toggle dropdown menu
function positionWalletMenu(chip) {
  const menu = document.getElementById("walletMenu");
  if (!chip || !menu) return;

  const rect = chip.getBoundingClientRect();

  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 8}px`;
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.right = "auto";
  menu.style.zIndex = "1000000";
}

document.querySelectorAll("#walletChip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const menu = document.getElementById("walletMenu");
    if (!menu) return;

    menu.classList.toggle("hidden");

    if (!menu.classList.contains("hidden")) {
      positionWalletMenu(chip);
    }
  });
});

// Auto close dropdown on scroll (mobile fix)
window.addEventListener("scroll", () => {
  const walletMenu = document.getElementById("walletMenu");

  if (walletMenu && !walletMenu.classList.contains("hidden")) {
    walletMenu.classList.add("hidden");
  }
}, { passive: true });

window.addEventListener("touchmove", () => {
  const walletMenu = document.getElementById("walletMenu");

  if (walletMenu && !walletMenu.classList.contains("hidden")) {
    walletMenu.classList.add("hidden");
  }
}, { passive: true });

// Sync topbar title when switching tabs
document.querySelectorAll("[data-tab]").forEach((link) => {
  link.addEventListener("click", () => {
    updateTopbarTitle(link.dataset.tab);
  });
});

// Initialize topbar title on page load
updateTopbarTitle(window.location.hash.replace("#","") || "dashboard");

/* =========================
   END OF WALLET UI PATCH
========================= */

window.Web3 = Web3;

globalThis.openCardPayment = window.openCardPayment = function () {
  let modal = document.getElementById("cardCheckoutModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "cardCheckoutModal";
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.75);
      z-index:999999;display:flex;align-items:center;justify-content:center;
    `;
    document.body.appendChild(modal);
  }

  function renderStep1() {
    modal.innerHTML = `
      <div style="width:340px;background:white;color:#111827;padding:24px;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <h2 style="margin-top:0;">💳 Pay with Visa / MasterCard</h2>
        <p style="color:#6b7280;font-size:13px;">ArcPay Sandbox — No real money</p>
        <input id="cardRecipientEmail" placeholder="Recipient Gmail"
          style="width:100%;padding:12px;margin-top:12px;background:#f9fafb;color:#111;border:1px solid #e5e7eb;border-radius:10px;box-sizing:border-box;" />
        <input id="cardAmount" placeholder="Amount USD" type="number"
          style="width:100%;padding:12px;margin-top:10px;background:#f9fafb;color:#111;border:1px solid #e5e7eb;border-radius:10px;box-sizing:border-box;" />
        <button id="btnStep1Continue"
          style="width:100%;padding:12px;margin-top:16px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;border:0;border-radius:10px;font-weight:bold;font-size:15px;cursor:pointer;">
          Continue →
        </button>
        <button id="btnStep1Cancel"
          style="width:100%;padding:10px;margin-top:10px;background:#f3f4f6;color:#374151;border:0;border-radius:10px;cursor:pointer;">
          Cancel
        </button>
      </div>
    `;
    modal.style.display = "flex";
    document.getElementById("btnStep1Cancel").onclick = () => { modal.style.display = "none"; };
    document.getElementById("btnStep1Continue").onclick = () => {
      const email = document.getElementById("cardRecipientEmail").value.trim();
      const amount = document.getElementById("cardAmount").value.trim();
      if (!email || !amount) { alert("Please enter Gmail and amount."); return; }
      renderStep2(email, amount);
    };
  }

  function renderStep2(email, amount) {
    modal.innerHTML = `
      <div style="width:340px;background:white;color:#111827;padding:24px;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <label style="font-size:12px;color:#6b7280;margin-bottom:4px;display:block;">
  Account Number
</label>

<div style="position:relative;margin-bottom:12px;">
  <input
    id="vcNumber"
    placeholder="•••• •••• •••• ••••"
    maxlength="19"
    type="password"
    autocomplete="off"
    style="
      width:100%;
      padding:12px 44px 12px 12px;
      background:#f9fafb;
      color:#111;
      border:1px solid #e5e7eb;
      border-radius:10px;
      box-sizing:border-box;
    "
  />

  <button
    id="toggleVcNumber"
    type="button"
    style="
      position:absolute;
      right:10px;
      top:8px;
      background:transparent;
      border:0;
      cursor:pointer;
      font-size:18px;
    "
  >
    👁️
  </button>
</div>

<div style="display:flex;gap:10px;">

  <div style="flex:1;">
    <label style="font-size:12px;color:#6b7280;margin-bottom:4px;display:block;">
      Valid Until
    </label>

    <div style="position:relative;">
      <input
        id="vcExpiry"
        placeholder="••/••"
        maxlength="5"
        type="password"
        autocomplete="off"
        style="
          width:100%;
          padding:12px 44px 12px 12px;
          background:#f9fafb;
          color:#111;
          border:1px solid #e5e7eb;
          border-radius:10px;
          box-sizing:border-box;
        "
      />

      <button
        id="toggleVcExpiry"
        type="button"
        style="
          position:absolute;
          right:10px;
          top:8px;
          background:transparent;
          border:0;
          cursor:pointer;
          font-size:18px;
        "
      >
        👁️
      </button>
    </div>
  </div>

  <div style="flex:1;">
    <label style="font-size:12px;color:#6b7280;margin-bottom:4px;display:block;">
      Security Code
    </label>

    <div style="position:relative;">
      <input
        id="vcCvv"
        placeholder="•••"
        maxlength="3"
        type="password"
        autocomplete="off"
        style="
          width:100%;
          padding:12px 44px 12px 12px;
          background:#f9fafb;
          color:#111;
          border:1px solid #e5e7eb;
          border-radius:10px;
          box-sizing:border-box;
        "
      />

      <button
        id="toggleVcCvv"
        type="button"
        style="
          position:absolute;
          right:10px;
          top:8px;
          background:transparent;
          border:0;
          cursor:pointer;
          font-size:18px;
        "
      >
        👁️
      </button>
    </div>
  </div>

</div>

        <div style="margin-top:14px;padding:12px;background:#f0fdf4;border-radius:10px;font-size:14px;color:#166534;">
          📤 Sending <b>${amount} USDC</b> to <b>${email}</b>
        </div>

        <button id="btnPayNow"
          style="width:100%;padding:14px;margin-top:16px;background:linear-gradient(135deg,#10b981,#059669);color:white;border:0;border-radius:10px;font-weight:bold;font-size:15px;cursor:pointer;">
          💸 Pay Now
        </button>
        <button id="btnStep2Back"
          style="width:100%;padding:10px;margin-top:10px;background:#f3f4f6;color:#374151;border:0;border-radius:10px;cursor:pointer;">
          ← Back
        </button>
      </div>
    `;

    document.getElementById("vcNumber").oninput = (e) => {
      let v = e.target.value.replace(/\D/g, "").slice(0, 16);
      e.target.value = v.match(/.{1,4}/g)?.join(" ") || v;
    };

document.getElementById("toggleVcNumber").onclick = () => {
  const input = document.getElementById("vcNumber");
  input.type = input.type === "password" ? "text" : "password";
};

document.getElementById("toggleVcExpiry").onclick = () => {
  const input = document.getElementById("vcExpiry");
  input.type = input.type === "password" ? "text" : "password";
};

document.getElementById("toggleVcCvv").onclick = () => {
  const input = document.getElementById("vcCvv");
  input.type = input.type === "password" ? "text" : "password";
};

    document.getElementById("vcExpiry").oninput = (e) => {
      let v = e.target.value.replace(/\D/g, "").slice(0, 4);
      if (v.length >= 2) v = v.slice(0,2) + "/" + v.slice(2);
      e.target.value = v;
    };

    document.getElementById("btnStep2Back").onclick = renderStep1;
    document.getElementById("btnPayNow").onclick = () => processPayment(email, amount);
  }
  
  async function processPayment(email, amount, card) {

    modal.innerHTML = `
      <div style="background:white;padding:32px;border-radius:20px;text-align:center;color:#111;">
        <div style="font-size:40px;">⏳</div>
        <h3>Processing...</h3>
        <p style="color:#6b7280;">Sending ${amount} USDC to ${email}</p>
      </div>
    `;

    try {
      const res = await fetch("/api/claims/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientEmail: email,
          amount: amount,
          message: "Payment created through ArcPay sandbox preview"
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Payment failed");

      modal.innerHTML = `
        <div style="background:white;padding:32px;border-radius:20px;text-align:center;color:#111;max-width:340px;">
          <div style="font-size:48px;">✅</div>
          <h2 style="color:#10b981;">Payment Successful!</h2>
          <p>${amount} USDC → <b>${email}</b></p>
          <a href="${data.claimLink}" target="_blank"
            style="display:block;margin:16px 0;padding:12px;background:#eff6ff;border-radius:10px;color:#2563eb;font-size:13px;word-break:break-all;">
            ${data.claimLink}
          </a>
          <button id="btnDone"
            style="width:100%;padding:12px;background:linear-gradient(135deg,#10b981,#059669);color:white;border:0;border-radius:10px;font-weight:bold;cursor:pointer;">
            Done ✓
          </button>
        </div>
      `;
      document.getElementById("btnDone").onclick = () => { modal.style.display = "none"; };

    } catch (err) {
      modal.innerHTML = `
        <div style="background:white;padding:32px;border-radius:20px;text-align:center;color:#111;max-width:340px;">
          <div style="font-size:48px;">❌</div>
          <h3 style="color:#ef4444;">Payment Failed</h3>
          <p>${err.message}</p>
          <button id="btnRetry"
            style="width:100%;padding:12px;margin-top:16px;background:#6366f1;color:white;border:0;border-radius:10px;cursor:pointer;">
            Try Again
          </button>
        </div>
      `;
      document.getElementById("btnRetry").onclick = renderStep1;
    }
  }

  renderStep1();
};

// API base URL
const API_BASE = window.location.origin;

// Arc Network constants
const ARC_CHAIN_ID = 5042002;
const ARC_CHAIN_HEX = "0x4cef52";
const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_EXPLORER = "https://testnet.arcscan.app";
const ARC_CHAIN_NAME = "Arc Testnet";

// USDC token address on Arc
const USDC_TOKEN = "0x3600000000000000000000000000000000000000";
const USDC_DECIMALS = 6;

// Minimal ERC-20 ABI for transfer and balanceOf
const ERC20_ABI = [
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" }
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function"
  },
  {
  "constant": false,
  "inputs": [
    {
      "name": "spender",
      "type": "address"
    },
    {
      "name": "amount",
      "type": "uint256"
    }
  ],
  "name": "approve",
  "outputs": [
    {
      "name": "",
      "type": "bool"
    }
  ],
  "type": "function"
},
  {
    constant: true,
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    type: "function"
  }
];

let selectedInvoice = null;
let metamaskWallet = null;
let activeWalletType = null; // "web3" | "circle"

function clearCircleWalletLocal() {
  if (circleWalletEl) {
    circleWalletEl.textContent = "-";
  }

  if (activeWalletType === "circle") {
    activeWalletType = null;
  }
}

function clearWeb3WalletLocal() {
  metamaskWallet = null;

  if (metamaskWalletEl) {
    metamaskWalletEl.textContent = "Disconnected";
  }

  updateWalletChip(null, null);

  if (activeWalletType === "web3") {
    activeWalletType = null;
  }
}

// DOM element references
const statusEl = document.getElementById("status");
const params = new URLSearchParams(window.location.search);
const claimId = params.get("claim");

if (claimId) {
  openClaimPopup(claimId);
}
const emailEl = document.getElementById("email");
const circleWalletEl = document.getElementById("circleWallet");
const metamaskWalletEl = document.getElementById("metamaskWallet");
const selectedInvoiceEl = document.getElementById("selectedInvoice");
const invoiceModalEl = document.getElementById("invoiceModal");
const closeInvoiceModalEl = document.getElementById("closeInvoiceModal");
const invoiceListEl = document.getElementById("invoiceList");
const qrBoxEl = document.getElementById("qrBox");
const titleEl = document.getElementById("title");
const amountEl = document.getElementById("amount");
const recipientEl = document.getElementById("recipient");
const noteEl = document.getElementById("note");
const btnGoogle = document.getElementById("btnGoogle");
const btnSetupPin = document.getElementById("btnSetupPin");
const btnConnectWallet = document.getElementById("btnConnectWallet");
const btnDisconnectWallet = document.getElementById("btnDisconnectWallet");
const btnSwitchArc = document.getElementById("btnSwitchArc");
const btnPay = document.getElementById("btnPay");
const walletProviderEl = document.getElementById("walletProvider");
const btnPayCircle = document.getElementById("btnPayCircle");
const btnCreateInvoice = document.getElementById("btnCreateInvoice");
const btnLoadInvoices = document.getElementById("btnLoadInvoices");
const btnRefresh = document.getElementById("btnRefresh");
const btnLogoutGoogle = document.getElementById("btnLogoutGoogle");
const bizNameEl = document.getElementById("bizName");
const bizEmailEl = document.getElementById("bizEmail");
const bizWalletEl = document.getElementById("bizWallet");
const btnSaveBiz = document.getElementById("btnSaveBiz");
const custNameEl = document.getElementById("custName");
const custEmailEl = document.getElementById("custEmail");
const custWalletEl = document.getElementById("custWallet");
const btnSaveCustomer = document.getElementById("btnSaveCustomer");
const customerSelectEl = document.getElementById("customerSelect");
const claimEmailEl = document.getElementById("claimEmail");
const claimAmountEl = document.getElementById("claimAmount");
const claimMessageEl = document.getElementById("claimMessage");
const btnSendClaimEmail = document.getElementById("btnSendClaimEmail");
const claimResultEl = document.getElementById("claimResult");
const isClaimPage = window.location.pathname.startsWith("/claim/");
const btnScanQR = document.getElementById("btnScanQR");
const btnVoiceInvoice = document.getElementById("btnVoiceInvoice");
const voiceLangEl = document.getElementById("voiceLang");
const qrScannerModal = document.getElementById("qrScannerModal");
const btnCloseScanner = document.getElementById("btnCloseScanner");
let qrScanner = null;

// Wallet chip and menu event listeners
document.getElementById("disconnectWalletChip")?.addEventListener("click", () => {
  disconnectMetaMask();
  document.getElementById("walletMenu")?.classList.add("hidden");
});

document.getElementById("copyWalletAddress")?.addEventListener("click", async () => {
  if (!metamaskWallet) {
    setStatus("No wallet connected.", "error");
    return;
  }
  await navigator.clipboard.writeText(metamaskWallet);
  setStatus("Wallet address copied.", "success");
});

document.getElementById("viewWalletExplorer")?.addEventListener("click", () => {
  if (!metamaskWallet) {
    setStatus("No wallet connected.", "error");
    return;
  }
  window.open(`https://testnet.arcscan.app/address/${metamaskWallet}`, "_blank");
  document.getElementById("walletMenu")?.classList.add("hidden");
});

/* =========================
   TOAST & STATUS
========================= */

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast show ${type}`;

  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.className = "toast hidden";
  }, 3200);
}

function setStatus(message, type = "") {
  if (statusEl) {
    statusEl.className = type;
    statusEl.textContent = message;
  }
  if (message) {
    showToast(message, type || "success");
  }
}

/* =========================
   API HELPER
========================= */

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.error || data?.message || JSON.stringify(data));
  }

  return data;
}

/* =========================
   FORMATTING HELPERS
========================= */

function formatUsdc(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 6
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/<>/g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getGoogleUser() {
  try {
    return JSON.parse(localStorage.getItem("googleUser") || "{}");
  } catch {
    return {};
  }
}

// Convert decimal amount to token smallest units
function toTokenUnits(amount, decimals) {
  const text = String(amount || "0").trim();
  const [wholeRaw, fracRaw = ""] = text.split(".");
  const whole = wholeRaw || "0";
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${whole}${frac}`.replace(/^0+/, "");
  return combined || "0";
}

/* =========================
   CUSTOMER
========================= */

function saveCustomer() {
  const customer = {
    name: custNameEl.value,
    email: custEmailEl.value,
    wallet: custWalletEl.value
  };

  const list = JSON.parse(localStorage.getItem("customers") || "[]");
  list.push(customer);
  localStorage.setItem("customers", JSON.stringify(list));

  renderCustomerDropdown();
  setStatus("Customer saved.", "success");
}

/* =========================
   GMAIL CLAIM
========================= */

async function sendClaimEmail() {
  try {
    const data = await api("/api/claims/send-email", {
      method: "POST",
      body: JSON.stringify({
        recipientEmail: claimEmailEl.value,
        amount: claimAmountEl.value,
        message: claimMessageEl.value
      })
    });

    claimResultEl.innerHTML = `
      <div style="margin-bottom:12px;">
        Status: <span id="claimStatus">PENDING</span>
      </div>
      <div style="margin-bottom:12px;">
        <a href="${data.claimLink}" target="_blank" style="color:#67e8f9;font-weight:bold;">
          Open Claim Page
        </a>
      </div>
      <div style="word-break:break-all;">${data.claimLink}</div>
      <div id="claimInfo" style="margin-top:12px;"></div>
    `;

    const claimId = data.claimId;

    // Poll claim status every 5 seconds
    setInterval(async () => {
      try {
        const res = await fetch(`/api/claims/${claimId}`);
        const claim = await res.json();

        if (claim.status === "CLAIMED") {
          document.getElementById("claimStatus").innerHTML = "CLAIMED ✅";
          document.getElementById("claimInfo").innerHTML = `
            <div>Wallet: ${claim.walletAddress || "-"}</div>
            <div>Tx: ${claim.txHash || "-"}</div>
            <div>Claimed At: ${claim.claimedAt || "-"}</div>
          `;
        }
      } catch (err) {
        console.error(err);
      }
    }, 5000);

    document.getElementById("btnCardPayment")?.addEventListener("click", () => {
      alert("Visa/Mastercard flow coming soon");
    });

    setStatus("Claim email sent.", "success");
  } catch (err) {
    setStatus("Send claim email failed: " + err.message, "error");
  }
}

/* =========================
   QR CODE
========================= */

function getInvoicePayUrl(inv) {
  return `${window.location.origin}/app.html?invoice=${encodeURIComponent(inv.id)}`;
}

function renderQR(inv) {
  if (!qrBoxEl) return;

  if (!inv || !inv.id) {
    qrBoxEl.innerHTML = `<div class="qr-empty">Open an invoice to show QR.</div>`;
    return;
  }

  const payUrl = getInvoicePayUrl(inv);
  const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(payUrl);

  qrBoxEl.innerHTML = `
    <div class="qr-wrap">
      <img src="${qrUrl}" alt="Invoice QR" />
      <div>
        <div><b>Payment Link</b></div>
        <div><a href="${payUrl}" target="_blank" rel="noreferrer">${payUrl}</a></div>
        <div class="row">
          <button id="btnCopyLink" class="secondary">Copy Link</button>
          <button id="btnCopyRecipient" class="secondary">Copy Recipient</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btnCopyLink")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(payUrl);
    setStatus("Payment link copied.", "success");
  });

  document.getElementById("btnCopyRecipient")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(inv.recipientAddress);
    setStatus("Recipient address copied.", "success");
  });
}

// Open QR scanner
btnScanQR?.addEventListener("click", async () => {
  try {
    qrScannerModal?.classList.remove("hidden");
    qrScanner = new Html5Qrcode("qrScanner");

    await qrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 250 },
      async (decodedText) => {
        await qrScanner.stop();
        qrScannerModal?.classList.add("hidden");

        const url = new URL(decodedText);
        const invoiceId = url.searchParams.get("invoice");

        if (invoiceId) {
          await openInvoice(invoiceId);
          setStatus("Invoice scanned. Ready to pay.", "success");

          if (navigator.vibrate) navigator.vibrate(120);

          setTimeout(() => {
            document.getElementById("sheetPayInvoice")?.scrollIntoView({
              behavior: "smooth",
              block: "center"
            });
          }, 400);
        } else {
          setStatus("QR does not contain invoice id.", "error");
        }
      }
    );
  } catch (err) {
    setStatus("QR scanner failed: " + err.message, "error");
  }
});

// Close QR scanner
btnCloseScanner?.addEventListener("click", async () => {
  try {
    if (qrScanner) await qrScanner.stop();
  } catch {}
  qrScannerModal?.classList.add("hidden");
});

qrScannerModal?.addEventListener("click", (e) => {
  if (e.target === qrScannerModal) {
    qrScannerModal.classList.add("hidden");
    stopQRScanner?.();
  }
});

/* =========================
   CIRCLE WALLET HELPERS
========================= */

// Extract wallet object from Circle API response
function extractWallet(data) {
  const wallets = data?.data?.wallets || data?.wallets || [];
  return (
    wallets.find((w) => String(w.blockchain || "").toUpperCase() === "ARC-TESTNET") ||
    wallets[0] ||
    data?.data?.wallet ||
    data?.wallet ||
    null
  );
}

// Extract wallet address from Circle API response
function extractWalletAddress(data) {
  const wallet = extractWallet(data);
  return (
    wallet?.address ||
    wallet?.walletAddress ||
    wallet?.accounts?.[0]?.address ||
    null
  );
}

// Get Circle auth tokens for current Google user
async function getCircleAuth() {
  const user = getGoogleUser();

  if (!user.email) {
    throw new Error("Login Google / Circle first.");
  }

  const tokenData = await api("/api/circle/user-token", {
    method: "POST",
    body: JSON.stringify({ email: user.email })
  });

  const userToken = tokenData?.data?.userToken || tokenData?.userToken;
  const encryptionKey = tokenData?.data?.encryptionKey || tokenData?.encryptionKey;

  if (!userToken || !encryptionKey) {
    console.log("Circle token response:", tokenData);
    throw new Error("Missing Circle userToken or encryptionKey.");
  }

  localStorage.setItem("circleUserToken", userToken);
  localStorage.setItem("circleEncryptionKey", encryptionKey);

  return { user, userToken, encryptionKey };
}

// List Circle wallets (try both endpoints for compatibility)
async function listCircleWallets(userToken) {
  try {
    return await api("/api/circle/list-wallets", {
      method: "POST",
      body: JSON.stringify({ userToken })
    });
  } catch {
    return await api("/api/circle/wallets", {
      method: "POST",
      body: JSON.stringify({ userToken })
    });
  }
}

// Load and display Circle wallet address
async function loadCircleWallet(userToken) {
  const listData = await listCircleWallets(userToken);
  console.log("List wallets response:", listData);

  const wallet = extractWallet(listData);
  const address = extractWalletAddress(listData);

  if (!address) {
    circleWalletEl.textContent = "No Circle wallet yet";
    document.getElementById("btnSetupPin")?.classList.remove("hidden");
    setStatus("No Circle wallet found. Tap Create Circle Wallet.", "error");
    return null;
  }

  circleWalletEl.textContent = address;
  clearWeb3WalletLocal();
activeWalletType = "circle";
  setStatus("Circle wallet loaded.", "success");
  document.getElementById("btnSetupPin")?.classList.add("hidden");

  return { wallet, address };
}

// Find USDC token in Circle wallet balances
async function findUsdcToken(userToken, walletId) {
  const balanceData = await api("/api/circle/wallet-balances", {
    method: "POST",
    body: JSON.stringify({ userToken, walletId })
  });

  console.log("FULL Circle balances:", balanceData);

  const tokenBalances = balanceData?.data?.tokenBalances || balanceData?.tokenBalances || [];

  // Find USDC on Arc Testnet — strict match first
  const usdc =
    tokenBalances.find((b) => {
      const symbol = String(b?.token?.symbol || "").toUpperCase();
      const tokenAddress = String(b?.token?.tokenAddress || "").toLowerCase();
      const blockchain = String(b?.token?.blockchain || "").toUpperCase();
      return symbol === "USDC" && blockchain === "ARC-TESTNET" && tokenAddress === USDC_TOKEN.toLowerCase();
    }) ||
    // Fallback: any USDC on Arc Testnet
    tokenBalances.find((b) => {
      const symbol = String(b?.token?.symbol || "").toUpperCase();
      const blockchain = String(b?.token?.blockchain || "").toUpperCase();
      return symbol === "USDC" && blockchain === "ARC-TESTNET";
    });

  if (!usdc) {
    console.log("No ARC USDC found. tokenBalances:", tokenBalances);
    throw new Error("No ARC USDC token found in Circle wallet.");
  }

  const tokenId = usdc?.token?.id;
  const balance = Number(usdc?.amount || 0);

  if (!tokenId) {
    console.log("USDC object without tokenId:", usdc);
    throw new Error("ARC USDC tokenId not found.");
  }

  return { tokenId, balance, raw: usdc };
}

/* =========================
   GOOGLE + CIRCLE LOGIN
========================= */

async function connectGoogleCircle() {
  const cfg = await api("/api/circle/config");
  const googleClientId = cfg?.config?.googleClientId;

  if (!googleClientId) {
    setStatus("Missing GOOGLE_CLIENT_ID in backend .env", "error");
    return;
  }

  const redirectUri = window.location.origin + "/app.html";

  window.location.href =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" + encodeURIComponent(googleClientId) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&response_type=token" +
    "&scope=" + encodeURIComponent("openid email profile") +
    "&prompt=" + encodeURIComponent("select_account");
}

async function handleGoogleRedirect() {
  const hash = window.location.hash;

  if (!hash.includes("access_token")) {
    const savedUser = getGoogleUser();
    if (savedUser.email && emailEl) {
      emailEl.textContent = savedUser.email;
    }
    // Do not auto-load Circle wallet with old token.
    // User must click Login Google / Setup Circle PIN to refresh token.
    return;
  }

  const params = new URLSearchParams(hash.replace("#", ""));
  const googleToken = params.get("access_token");
  if (!googleToken) return;

  localStorage.setItem("googleToken", googleToken);

  const user = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + googleToken }
  }).then((r) => r.json());

  if (!user.email) {
    setStatus("Google login failed: missing email.", "error");
    return;
  }

  localStorage.setItem("googleUser", JSON.stringify(user));
  emailEl.textContent = user.email;

  window.history.replaceState(null, "", "/app.html");
  setStatus("Google login success. Preparing Circle user...");

  try {
    await api("/api/circle/create-user", {
      method: "POST",
      body: JSON.stringify({ email: user.email })
    });
  } catch (err) {
    console.warn("Create user warning:", err.message);
  }

  const { userToken } = await getCircleAuth();
  setStatus("Circle user ready. Click Setup Circle PIN.", "success");

  try {
    await loadCircleWallet(userToken);
  } catch {}
}

// Setup Circle PIN and create wallet
async function setupCirclePin() {
  try {
    setStatus("Starting Circle PIN setup...");

    const cfg = await api("/api/circle/config");
    const appId = cfg?.config?.circleAppId;

    if (!appId) {
      setStatus("Missing CIRCLE_APP_ID in backend .env", "error");
      return;
    }

    const { userToken, encryptionKey } = await getCircleAuth();
    let challengeId = null;

    try {
      const initData = await api("/api/circle/initialize-user", {
        method: "POST",
        body: JSON.stringify({ userToken })
      });
      challengeId = initData?.data?.challengeId || initData?.challengeId;
    } catch (err) {
      if (String(err.message || "").includes("already been initialized")) {
        setStatus("User already initialized. Loading wallet...");
        await loadCircleWallet(userToken);
        return;
      }
      throw err;
    }

    if (!challengeId) {
      setStatus("No challengeId returned.", "error");
      return;
    }

    const sdk = new W3SSdk({ appSettings: { appId } });
    sdk.setAuthentication({ userToken, encryptionKey });

    sdk.execute(challengeId, async (error, result) => {
      if (error) {
        console.error("PIN setup error:", error);
        setStatus("PIN setup failed: " + (error.message || JSON.stringify(error)), "error");
        return;
      }

      console.log("PIN setup result:", result);
      setStatus("PIN setup completed. Creating wallet...");

      try {
        const walletData = await api("/api/circle/create-wallet", {
          method: "POST",
          body: JSON.stringify({ userToken })
        });

        console.log("Wallet response:", walletData);

        const address = extractWalletAddress(walletData);
        if (address) {
          circleWalletEl.textContent = address;
          setStatus("Circle wallet created.", "success");
          return;
        }

        await loadCircleWallet(userToken);
      } catch (err) {
        if (String(err.message || "").includes("already")) {
          await loadCircleWallet(userToken);
          return;
        }
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    setStatus("Setup PIN failed: " + err.message, "error");
  }
}

/* =========================
   INVOICES
========================= */

async function createInvoice() {
  console.log("CREATE INVOICE CLICKED");

  try {
    const appKitAccount = getAccount(wagmiAdapter.wagmiConfig);
    const appKitWallet = appKitAccount?.address || null;

    const circleWallet =
      circleWalletEl?.textContent &&
      circleWalletEl.textContent.startsWith("0x")
        ? circleWalletEl.textContent.trim()
        : null;

    const recipientAddress =
      recipientEl.value && recipientEl.value.trim() !== ""
        ? recipientEl.value.trim()
        : (metamaskWallet || appKitWallet || circleWallet);

    if (!recipientAddress) {
      setStatus("Please connect MetaMask or Circle Wallet before creating invoice.", "error");
      return;
    }

    const recipientEmail = document.getElementById("invoiceEmail").value;

    const body = {
      title: titleEl.value,
      amount: amountEl.value,
      recipientEmail,
      dueDate: document.getElementById("invoiceDueDate").value,
      recipientAddress,
      targetChain: "Arc",
      note: noteEl.value,
    };

    // =========================
    // CASE 1: MetaMask create invoice
    // =========================
    if (metamaskWallet && window.ethereum) {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const contract = new ethers.Contract(
        CONTRACT_ADDRESS,
        CONTRACT_ABI,
        signer
      );

      const tx = await contract.createInvoice(
        recipientAddress,
        ethers.parseUnits(amountEl.value, 6),
        noteEl.value
      );

      const receipt = await tx.wait();

      let onchainId = null;

      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          const id = parsed.args.invoiceId ?? parsed.args.id ?? parsed.args[0];

          if (id !== undefined) {
            onchainId = Number(id);
            break;
          }
        } catch (e) {}
      }

      if (onchainId === null) {
        throw new Error("Cannot read onchain invoice id from contract event");
      }

      body.txHash = tx.hash;
      body.onchainId = onchainId;
    }

else if (appKitWallet) {
  setStatus("AppKit: creating invoice on contract...");

  const nextId = await readContract(wagmiAdapter.wagmiConfig, {
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "nextInvoiceId",
  });

  const hash = await writeContract(wagmiAdapter.wagmiConfig, {
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "createInvoice",
    args: [
      recipientAddress,
      parseUnits(String(amountEl.value), 6),
      noteEl.value || "",
    ],
  });

  await waitForTransactionReceipt(wagmiAdapter.wagmiConfig, { hash });

  body.txHash = hash;
  body.onchainId = Number(nextId);
}

    // =========================
    // CASE 2: Circle create invoice
    // =========================
    else if (circleWallet) {
      const cfg = await api("/api/circle/config");
      const appId = cfg?.config?.circleAppId;

      if (!appId) {
        throw new Error("Missing CIRCLE_APP_ID.");
      }

      const { userToken, encryptionKey } = await getCircleAuth();

      const walletList = await listCircleWallets(userToken);
      const wallet = extractWallet(walletList);

      if (!wallet || !wallet.id) {
        throw new Error("No Circle wallet found.");
      }

      const readProvider = new ethers.JsonRpcProvider(ARC_RPC);
      const readContract = new ethers.Contract(
        CONTRACT_ADDRESS,
        CONTRACT_ABI,
        readProvider
      );

      const nextId = await readContract.nextInvoiceId();
      const onchainId = Number(nextId);

      const sdk = new W3SSdk({ appSettings: { appId } });
      sdk.setAuthentication({ userToken, encryptionKey });

      setStatus("Circle: creating invoice on contract...");

      const createData = await api("/api/circle/contract-execution", {
        method: "POST",
        body: JSON.stringify({
          userToken,
          walletId: wallet.id,
          contractAddress: CONTRACT_ADDRESS,
          abiFunctionSignature: "createInvoice(address,uint256,string)",
          abiParameters: [
            recipientAddress,
            toTokenUnits(amountEl.value, USDC_DECIMALS),
            noteEl.value || ""
          ]
        })
      });

      const challengeId =
        createData?.data?.challengeId || createData?.challengeId;

      if (!challengeId) {
        throw new Error("No Circle createInvoice challengeId returned.");
      }

      await new Promise((resolve, reject) => {
        sdk.execute(challengeId, (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          console.log("Circle createInvoice approved:", result);
          resolve(result);
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 9000));

      const txData = await api("/api/circle/transactions", {
        method: "POST",
        body: JSON.stringify({ userToken })
      });

      const tx =
        txData?.data?.transactions?.find((t) => {
          const contract =
            String(t.contractAddress || t.destinationAddress || "").toLowerCase();
          return contract === CONTRACT_ADDRESS.toLowerCase();
        }) ||
        txData?.data?.transactions?.[0] ||
        null;

      body.txHash =
        tx?.txHash ||
        tx?.transactionHash ||
        tx?.blockchainTxHash ||
        tx?.id ||
        "circle_create_pending";

      body.onchainId = onchainId;
    }

    const data = await api("/api/invoices", {
      method: "POST",
      body: JSON.stringify(body)
    });

    selectedInvoice = data.invoice;
    renderSelectedInvoice();
    await loadInvoices();

    setStatus("Invoice created.", "success");
  } catch (err) {
    setStatus("Create invoice failed: " + err.message, "error");
  }
}

async function saveBusinessProfile() {
  const body = {
    name: bizNameEl.value,
    email: bizEmailEl.value,
    wallet: bizWalletEl.value
  };
  localStorage.setItem("businessProfile", JSON.stringify(body));
  setStatus("Business profile saved.", "success");
}

function renderCustomerDropdown() {
  if (!customerSelectEl) return;

  const customers = JSON.parse(localStorage.getItem("customers") || "[]");
  customerSelectEl.innerHTML = `<option value="">-- Choose customer --</option>`;

  customers.forEach((c, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = `${c.name || "Customer"} (${c.wallet?.slice(0, 6) || "no wallet"}...)`;
    customerSelectEl.appendChild(option);
  });
}

async function loadInvoices() {
  try {
    const data = await api("/api/invoices");
    const invoices = data.invoices || [];

    invoiceListEl.innerHTML = "";

    if (!invoices.length) {
      invoiceListEl.innerHTML = `<div class="box">No invoices yet.</div>`;
      return;
    }

    invoices.forEach((inv) => {
      // Mark overdue if past due date and not paid
      if (inv.status !== "PAID" && inv.dueDate && new Date() > new Date(inv.dueDate)) {
        inv.status = "OVERDUE";
      }

      const div = document.createElement("div");
      div.className = "invoice";

      div.innerHTML = `
        <div class="invoice-title">${escapeHtml(inv.title)}</div>
        <div>${formatUsdc(inv.amount)} USDC</div>
        <div>
          <b>Status:</b>
          <span class="${
            inv.status === "PAID" ? "status-paid" :
            inv.status === "OVERDUE" ? "status-overdue" :
            inv.status === "REMINDER" ? "status-reminder" :
            "status-created"
          }">
            ${escapeHtml(inv.status)}
          </span>
        </div>
        <div><b>ID:</b> ${escapeHtml(inv.id)}</div>
        <div><b>Due:</b> ${inv.dueDate || "No due date"}</div>
        <div><b>Recipient:</b> ${escapeHtml(inv.recipientAddress)}</div>
        <div class="row">
          <button data-open="${escapeHtml(inv.id)}">Open</button>
        </div>
      `;

      invoiceListEl.appendChild(div);
    });

    invoiceListEl.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => openInvoice(btn.dataset.open));
    });
  } catch (err) {
    setStatus("Load invoices failed: " + err.message, "error");
  }
}

async function openInvoice(id) {
  try {
    const data = await api("/api/invoices/" + encodeURIComponent(id));
    selectedInvoice = data.invoice;

    renderSelectedInvoice();
    openInvoiceSheet(selectedInvoice);
    setStatus("Invoice opened.", "success");
  } catch (err) {
    setStatus("Open invoice failed: " + err.message, "error");
  }
}

function openInvoiceSheet(inv) {
  const sheet = document.getElementById("invoiceSheet");
  const sheetTitle = document.getElementById("sheetTitle");
  const sheetBody = document.getElementById("sheetBody");
  const sheetQR = document.getElementById("sheetQR");
  const copyBtn = document.getElementById("sheetCopyLink");
  const payBtn = document.getElementById("sheetPayInvoice");

  if (!sheet || !inv) return;

  const payUrl = getInvoicePayUrl(inv);
  const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(payUrl);

  if (sheetTitle) sheetTitle.textContent = inv.title || "Invoice";

  if (sheetBody) {
    sheetBody.innerHTML = `
      <div><b>${escapeHtml(inv.title || "")}</b></div>
      <div>${formatUsdc(inv.amount)} USDC</div>
      <div>Status: ${escapeHtml(inv.status || "")}</div>
      <div>ID: ${escapeHtml(inv.id || "")}</div>
      <div>Recipient: ${escapeHtml(inv.recipientAddress || "")}</div>

<div style="margin-top:12px;">
  <label style="display:block;font-size:12px;opacity:.8;margin-bottom:6px;">
    Payment Memo / Reference (optional)
  </label>
  <input
    id="paymentMemoInput"
    type="text"
    maxlength="120"
    placeholder="Example: Coffee payment, Invoice #1025"
    style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:white;"
  />
</div>
    `;
  }

  if (sheetQR) {
    sheetQR.innerHTML = `
      <div class="sheet-qr-card">
        <img class="sheet-qr-img" src="${qrUrl}" alt="Invoice QR" />
        <div class="sheet-link-card">
          <div class="sheet-link-label">Payment Link</div>
          <a href="${payUrl}" target="_blank" rel="noreferrer">${payUrl}</a>
          <div class="row" style="margin-top:12px;">
          </div>
        </div>
      </div>
    `;
  }

  sheet.classList.remove("hidden");

  if (copyBtn) {
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(payUrl);
      setStatus("Payment link copied.", "success");
    };
  }

  const copyRecipientBtn = document.getElementById("sheetCopyRecipient");
  if (copyRecipientBtn) {
    copyRecipientBtn.onclick = async () => {
      await navigator.clipboard.writeText(inv.recipientAddress || "");
      setStatus("Recipient address copied.", "success");
    };
  }

if (payBtn) {
  if (inv.status === "PAID") {
    payBtn.textContent = "Paid";
    payBtn.disabled = true;
    payBtn.style.opacity = "0.6";
    payBtn.style.cursor = "not-allowed";
  } else {
    payBtn.textContent = "Pay Invoice";
    payBtn.disabled = false;
    payBtn.style.opacity = "1";
    payBtn.style.cursor = "pointer";
  }
}

  if (payBtn) {
  payBtn.onclick = async () => {
    if (metamaskWallet && window.ethereum) {
  await payWithArcMemoMetaMask();
  return;
}

const appKitAccount = getAccount(wagmiAdapter.wagmiConfig);
if (appKitAccount?.address) {
  await payWithAppKit();
  return;
}

    const circleAddress = circleWalletEl?.textContent?.trim();
    if (circleAddress && circleAddress.startsWith("0x")) {
      await payWithCircleWallet();
      return;
    }

    setStatus("Please connect Web3 wallet or Circle Wallet first.", "error");
  };
}
}

function closeInvoiceSheet() {
  document.getElementById("invoiceSheet")?.classList.add("hidden");
}

function renderSelectedInvoice() {
  if (!selectedInvoice) {
    if (selectedInvoiceEl) selectedInvoiceEl.textContent = "No invoice selected.";
    renderQR(null);
    return;
  }

  if (selectedInvoiceEl) {
    selectedInvoiceEl.innerHTML = `
      <div><b>${escapeHtml(selectedInvoice.title || "")}</b></div>
      <div>${formatUsdc(selectedInvoice.amount)} USDC</div>
      <div>Status: ${escapeHtml(selectedInvoice.status || "")}</div>
      <div>ID: ${escapeHtml(selectedInvoice.id || "")}</div>
      <div>Recipient: ${escapeHtml(selectedInvoice.recipientAddress || "")}</div>
      ${selectedInvoice.status === "PAID" && selectedInvoice.txHash ? `
<div>
  TX:
  <a
    href="https://testnet.arcscan.app/tx/${selectedInvoice.txHash}"
    target="_blank"
  >
    View TX
  </a>
</div>
` : `
<div>
  TX: -
</div>
`}
    `;
  }

  renderQR(selectedInvoice);
}

/* =========================
   METAMASK PAYMENT
========================= */

async function connectMetaMask() {
  try {
    if (!window.ethereum) {
      setStatus("Install a Web3 wallet first.", "error");
      return;
    }

    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    metamaskWallet = accounts[0] || null;
    metamaskWalletEl.textContent = metamaskWallet || "Disconnected";

    // Update topbar wallet chip
    updateWalletChip(metamaskWallet, null);
    clearCircleWalletLocal();
activeWalletType = "web3";
    setStatus("Wallet connected.", "success");
  } catch (err) {
    setStatus("MetaMask connect failed: " + err.message, "error");
  }
}

function disconnectMetaMask() {
  metamaskWallet = null;
  if (metamaskWalletEl) metamaskWalletEl.textContent = "Disconnected";

  // Reset topbar wallet chip
  updateWalletChip(null, null);
  setStatus("MetaMask disconnected locally.", "success");
}

// Switch to Arc Testnet network
async function switchArc() {
  try {
    if (!window.ethereum) {
      setStatus("Install MetaMask first.", "error");
      return;
    }

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC_CHAIN_HEX }]
      });
    } catch {
      // Network not added yet — add it
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: ARC_CHAIN_HEX,
          chainName: ARC_CHAIN_NAME,
          rpcUrls: [ARC_RPC],
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          blockExplorerUrls: [ARC_EXPLORER]
        }]
      });
    }

    setStatus("Switched to Arc.", "success");
  } catch (err) {
    setStatus("Switch Arc failed: " + err.message, "error");
  }
}

async function payWithMetaMask() {
  try {
    if (!window.ethereum) {
      setStatus("Install a Web3 wallet first.", "error");
      return;
    }

    if (!metamaskWallet) await connectMetaMask();
    if (!metamaskWallet) {
      setStatus("Connect wallet first.", "error");
      return;
    }

    if (!selectedInvoice) {
      setStatus("Open invoice first.", "error");
      return;
    }

    const chainId = await window.ethereum.request({ method: "eth_chainId" });

    if (parseInt(chainId, 16) !== ARC_CHAIN_ID) {
      setStatus("Switching to Arc network...");
      await switchArc();

      const newChainId = await window.ethereum.request({ method: "eth_chainId" });
      if (parseInt(newChainId, 16) !== ARC_CHAIN_ID) {
        setStatus("Wrong network. Please switch to Arc Testnet in wallet.", "error");
        return;
      }
    }

    if (selectedInvoice.status === "PAID") {
      setStatus("Invoice already paid.", "success");
      return;
    }

    const web3 = new Web3(window.ethereum);
    web3.eth.transactionBlockTimeout = 200;
    web3.eth.transactionPollingTimeout = 900;
    web3.eth.transactionConfirmationBlocks = 1;

    const token = new web3.eth.Contract(ERC20_ABI, USDC_TOKEN);
    const amountUnits = toTokenUnits(selectedInvoice.amount, USDC_DECIMALS);

    setStatus("Sending MetaMask USDC transaction...");

    const contract = new web3.eth.Contract(
  CONTRACT_ABI,
  CONTRACT_ADDRESS
);

setStatus("Approving USDC...");

await token.methods
  .approve(CONTRACT_ADDRESS, amountUnits)
  .send({
    from: metamaskWallet,
    gas: 120000
  });

setStatus("Paying invoice onchain...");

if (
  selectedInvoice.onchainId === undefined ||
  selectedInvoice.onchainId === null
) {
  throw new Error("Missing onchainId");
}
const tx = await contract.methods
  .payInvoice(selectedInvoice.onchainId)
  .send({
    from: metamaskWallet,
    gas: 250000
  });

await markInvoicePaid(tx.transactionHash, metamaskWallet);

setStatus(
  "Invoice paid onchain: " + tx.transactionHash,
  "success"
);
    setStatus("MetaMask payment success: " + tx.transactionHash, "success");
  } catch (err) {
    setStatus("MetaMask payment failed: " + err.message, "error");
  }
}

async function payWithArcMemoMetaMask() {
  try {
    if (!window.ethereum) {
      setStatus("Install a Web3 wallet first.", "error");
      return;
    }

    if (!metamaskWallet) await connectMetaMask();
    if (!metamaskWallet) {
      setStatus("Connect wallet first.", "error");
      return;
    }

    if (!selectedInvoice) {
      setStatus("Open invoice first.", "error");
      return;
    }

const paymentMemo =
  document.getElementById("paymentMemoInput")?.value?.trim() || "";

    if (selectedInvoice.status === "PAID") {
      setStatus("Invoice already paid.", "success");
      return;
    }

    if (selectedInvoice.onchainId === undefined || selectedInvoice.onchainId === null) {
      throw new Error("Missing onchainId");
    }

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();

    const token = new ethers.Contract(
      USDC_TOKEN,
      ["function approve(address spender, uint256 amount) returns (bool)"],
      signer
    );

    const invoice = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      signer
    );

    const memo = new ethers.Contract(
      MEMO_ADDRESS,
      MEMO_ABI,
      signer
    );

    const amountUnits = ethers.parseUnits(String(selectedInvoice.amount), 6);

    setStatus("Approving USDC for ArcPay contract...");

    const approveTx = await token.approve(CONTRACT_ADDRESS, amountUnits);
    await approveTx.wait();

    const payData = invoice.interface.encodeFunctionData("payInvoice", [
      BigInt(selectedInvoice.onchainId)
    ]);

    const memoId = ethers.id(`arcpay-invoice-${selectedInvoice.onchainId}`);

    const memoText =
  paymentMemo !== ""
    ? paymentMemo
    : `ArcPay invoice payment | invoiceId=${selectedInvoice.id} | onchainId=${selectedInvoice.onchainId} | amount=${selectedInvoice.amount} USDC`;

const memoData = ethers.toUtf8Bytes(memoText);

    setStatus("Paying invoice with Arc Memo...");

    const tx = await memo.memo(
      CONTRACT_ADDRESS,
      payData,
      memoId,
      memoData
    );

    await tx.wait();

    await markInvoicePaid(tx.hash, metamaskWallet);

    setStatus("Invoice paid with Arc Memo: " + tx.hash, "success");
  } catch (err) {
    console.error(err);
    setStatus("Arc Memo payment failed: " + (err.message || err), "error");
  }
}

async function payWithAppKit() {
  try {
    if (!selectedInvoice) {
      setStatus("No invoice selected.", "error");
      return;
    }

const paymentMemo =
  document.getElementById("paymentMemoInput")?.value?.trim() || "";

    const account = getAccount(wagmiAdapter.wagmiConfig);

    if (!account?.address) {
      walletModalMode = "pay";
      await openAppKitWallet();
      return;
    }

    const recipient =
      selectedInvoice.recipientAddress ||
      selectedInvoice.recipient ||
      selectedInvoice.merchantAddress;

    const amount = parseUnits(String(selectedInvoice.amount), 6);

    const contractInvoiceId =
  selectedInvoice.onchainId ?? selectedInvoice.contractInvoiceId;

if (contractInvoiceId === undefined || contractInvoiceId === null || contractInvoiceId === "") {
  throw new Error("Missing onchain invoice id. Please recreate this invoice.");
}

setStatus("AppKit: approving USDC...", "info");

const approveHash = await writeContract(wagmiAdapter.wagmiConfig, {
  address: USDC_TOKEN,
  abi: ERC20_ABI,
  functionName: "approve",
  args: [CONTRACT_ADDRESS, amount],
});

await waitForTransactionReceipt(wagmiAdapter.wagmiConfig, {
  hash: approveHash,
});

setStatus("AppKit: paying invoice with Arc Memo...", "info");

const invoiceInterface = new ethers.Interface(CONTRACT_ABI);

const payData = invoiceInterface.encodeFunctionData("payInvoice", [
  BigInt(contractInvoiceId),
]);

const memoId = ethers.id(`arcpay-invoice-${contractInvoiceId}`);

const memoText =
  paymentMemo !== ""
    ? paymentMemo
    : `ArcPay invoice payment | invoiceId=${selectedInvoice.id} | onchainId=${contractInvoiceId} | amount=${selectedInvoice.amount} USDC`;

const memoData = ethers.toUtf8Bytes(memoText);

const hash = await writeContract(wagmiAdapter.wagmiConfig, {
  address: MEMO_ADDRESS,
  abi: MEMO_ABI,
  functionName: "memo",
  args: [
    CONTRACT_ADDRESS,
    payData,
    memoId,
    memoData,
  ],
});

    await waitForTransactionReceipt(wagmiAdapter.wagmiConfig, { hash });

    await api(`/api/invoices/${selectedInvoice.id}/mark-paid`, {
      method: "POST",
      body: JSON.stringify({
        txHash: hash,
        fromAddress: account.address,
      }),
    });

    setStatus("Invoice paid with AppKit wallet.", "success");
    await openInvoice(selectedInvoice.id);
  } catch (err) {
    console.error("AppKit pay failed:", err);
    setStatus("AppKit pay failed: " + (err.message || err), "error");
  }
}

/* =========================
   CIRCLE WALLET PAYMENT
========================= */

async function payWithCircleWallet() {
  try {
    console.log("Circle contract pay clicked");

    if (!selectedInvoice) {
      setStatus("Open invoice first.", "error");
      return;
    }

const paymentMemo =
  document.getElementById("paymentMemoInput")?.value?.trim() || "";

    if (selectedInvoice.status === "PAID") {
      setStatus("Invoice already paid.", "success");
      return;
    }

    if (
      selectedInvoice.onchainId === undefined ||
      selectedInvoice.onchainId === null
    ) {
      setStatus("Missing onchainId. This invoice was not created on contract.", "error");
      return;
    }

    const cfg = await api("/api/circle/config");
    const appId = cfg?.config?.circleAppId;

    if (!appId) {
      setStatus("Missing CIRCLE_APP_ID.", "error");
      return;
    }

    const { userToken, encryptionKey } = await getCircleAuth();

    setStatus("Loading Circle wallet...");

    const walletList = await listCircleWallets(userToken);
    const wallet = extractWallet(walletList);
    const walletAddress = extractWalletAddress(walletList);

    if (!wallet || !wallet.id || !walletAddress) {
      setStatus("No Circle wallet found.", "error");
      return;
    }

    circleWalletEl.textContent = walletAddress;

    const usdc = await findUsdcToken(userToken, wallet.id);
    const invoiceAmount = Number(selectedInvoice.amount || 0);

    if (!Number.isFinite(usdc.balance) || usdc.balance < invoiceAmount) {
      setStatus(`Not enough USDC in Circle wallet. Balance: ${usdc.balance} USDC`, "error");
      return;
    }

    const amountUnits = toTokenUnits(selectedInvoice.amount, USDC_DECIMALS);

    const sdk = new W3SSdk({ appSettings: { appId } });
    sdk.setAuthentication({ userToken, encryptionKey });

    // STEP 1: approve USDC for ArcPayInvoice contract
    setStatus("Circle: approving USDC for ArcPay contract...");

    const approveData = await api("/api/circle/contract-execution", {
      method: "POST",
      body: JSON.stringify({
        userToken,
        walletId: wallet.id,
        contractAddress: USDC_TOKEN,
        abiFunctionSignature: "approve(address,uint256)",
        abiParameters: [
          CONTRACT_ADDRESS,
          amountUnits
        ]
      })
    });

    console.log("Circle approve response:", approveData);

    const approveChallengeId =
      approveData?.data?.challengeId || approveData?.challengeId;

    if (!approveChallengeId) {
      setStatus("No approve challengeId returned.", "error");
      return;
    }

    await new Promise((resolve, reject) => {
      sdk.execute(approveChallengeId, (error, result) => {
        if (error) {
          console.error("Circle approve error:", error);
          reject(error);
          return;
        }
        console.log("Circle approve approved:", result);
        resolve(result);
      });
    });

    // small delay so approve is indexed
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // STEP 2: pay through Arc Memo
    setStatus("Circle: preparing Arc Memo...");

    const invoiceInterface = new ethers.Interface(CONTRACT_ABI);

const encodedPayData = invoiceInterface.encodeFunctionData("payInvoice", [
  BigInt(selectedInvoice.onchainId),
]);

const memoId = ethers.id(
  `arcpay-invoice-${selectedInvoice.onchainId}`
);

const memoText =
  paymentMemo !== ""
    ? paymentMemo
    : `ArcPay invoice payment | invoiceId=${selectedInvoice.id} | onchainId=${selectedInvoice.onchainId} | amount=${selectedInvoice.amount} USDC`;

const memoData = ethers.hexlify(
  ethers.toUtf8Bytes(memoText)
);

setStatus("Circle: paying invoice with Arc Memo...");

const payData = await api("/api/circle/contract-execution", {
  method: "POST",
  body: JSON.stringify({
    userToken,
    walletId: wallet.id,
    contractAddress: MEMO_ADDRESS,
    abiFunctionSignature: "memo(address,bytes,bytes32,bytes)",
    abiParameters: [
      CONTRACT_ADDRESS,
      encodedPayData,
      memoId,
      memoData
    ]
  })
});

    console.log(
  "Circle payInvoice response:",
  JSON.stringify(payData, null, 2)
);

    const payChallengeId =
      payData?.data?.challengeId || payData?.challengeId;

    if (!payChallengeId) {
      setStatus("No payInvoice challengeId returned.", "error");
      return;
    }

    await new Promise((resolve, reject) => {
      sdk.execute(payChallengeId, (error, result) => {
        if (error) {
          console.error("Circle payInvoice error:", error);
          reject(error);
          return;
        }
        console.log("Circle payInvoice approved:", result);
        resolve(result);
      });
    });

    setStatus("Circle contract payment approved. Waiting for tx hash...");

    for (let i = 0; i < 10; i++) {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const txData = await api("/api/circle/transactions", {
    method: "POST",
    body: JSON.stringify({ userToken })
  });

  console.log(
    `Circle transactions attempt ${i + 1}:`,
    JSON.stringify(txData, null, 2)
  );

  const tx =
  txData?.data?.transactions?.find((t) => {
    return (
      t.operation === "CONTRACT_EXECUTION" &&
      (t.state === "COMPLETE" || t.status === "COMPLETE") &&
      (t.txHash || t.blockchainTxHash || t.transactionHash)
    );
  }) ||
  txData?.data?.transactions?.[0] ||
  null;

  const txHash =
    tx?.blockchainTxHash ||
    tx?.txHash ||
    tx?.transactionHash ||
    tx?.networkFeeTransactionId ||
    tx?.operation?.txHash ||
    "";

  if (txHash && txHash.startsWith("0x")) {
    await markInvoicePaid(txHash, walletAddress);

    setStatus(
      "Circle invoice paid through Arc Memo: " + txHash,
      "success"
    );

    return;
  }
}

throw new Error(
  "Circle payment approved, but blockchain tx hash is not ready yet. Please wait a moment and try refreshing."
);

  } catch (err) {
    console.error(err);
    setStatus("Pay with Circle contract failed: " + (err.message || JSON.stringify(err)), "error");
  }
}

/* =========================
   MARK INVOICE PAID
========================= */

async function markInvoicePaid(txHash, fromAddress) {
  const paymentMemo =
    document.getElementById("paymentMemoInput")?.value?.trim() || "";

  await api(
    "/api/invoices/" + encodeURIComponent(selectedInvoice.id) + "/mark-paid",
    {
      method: "POST",
      body: JSON.stringify({
        txHash,
        fromAddress,
        paymentMemo
      })
    }
  );

  selectedInvoice.status = "PAID";
  selectedInvoice.txHash = txHash;

  renderSelectedInvoice();
  await loadInvoices();
}

/* =========================
   AI INVOICE DRAFT
========================= */

window.generateAIDraft = async function () {
  const prompt = document.getElementById("aiPrompt").value;

  if (!prompt) {
    alert("Please enter invoice prompt");
    return;
  }

  const lower = prompt.toLowerCase();
  let amount = "0";
  let title = "General Service";

  const amountMatch = lower.match(/(\d+(\.\d+)?)/);
  if (amountMatch) amount = amountMatch[1];

  // Detect invoice title from keywords
  if (lower.includes("coffee") || lower.includes("cà phê")) title = "Coffee";
  if (lower.includes("design")) title = "Design Work";
  if (lower.includes("salary") || lower.includes("lương")) title = "Salary";
  if (lower.includes("game")) title = "Game Service";

  document.getElementById("title").value = title;
  document.getElementById("amount").value = amount;

  document.getElementById("aiResult").textContent = `
🧠 AI UNDERSTOOD

Intent: ${title}

Title: ${document.getElementById("title").value}

Amount: ${document.getElementById("amount").value} USDC
`;
};

/* =========================
   DASHBOARD
========================= */

function shortTx(tx) {
  if (!tx) return "-";
  return tx.slice(0, 8) + "..." + tx.slice(-6);
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");

    document.getElementById("dashTotal").innerText = Number(data.totalReceived || 0).toFixed(2) + " USDC";
    document.getElementById("dashPaid").innerText = data.paidCount || 0;
    document.getElementById("dashPending").innerText = data.pendingCount || 0;
    document.getElementById("dashLatestTx").innerText = data.latestPayment?.txHash ? shortTx(data.latestPayment.txHash) : "-";
    document.getElementById("dashTotalInvoices").innerText = data.totalInvoices || 0;
    document.getElementById("dashTotalPayrolls").innerText = data.totalPayrolls || 0;
    document.getElementById("dashTotalClaims").innerText = data.totalClaims || 0;
    document.getElementById("dashTotalVolume").innerText = Number(data.totalVolume || 0).toFixed(2) + " USDC";

    // Update wallet chip balance from dashboard data
    const totalBalance = Number(data.totalVolume || data.totalReceived || 0).toFixed(2);
    if (metamaskWallet) {
      updateWalletChip(metamaskWallet, totalBalance);
    }

    // Render recent activity feed
    const feed = document.getElementById("activityFeed");
    if (feed) {
      const items = data.recentActivity || [];
      feed.innerHTML = items.length
        ? items.map((item) => `<div class="activity-item">🟢 ${item.text}</div>`).join("")
        : "No activity yet.";
    }
  } catch (err) {
    console.error("loadDashboard error:", err);
  }
}

/* =========================
   CLAIM PAGE
========================= */

async function loadClaimPage() {
  const path = window.location.pathname;
  if (!path.startsWith("/claim/")) return;

  const claimId = path.split("/claim/")[1];

  document.body.innerHTML = `
    <div style="padding:40px;max-width:500px;margin:auto;color:white;font-family:sans-serif;">
      <h2>Claim your USDC</h2>
      <p id="claimInfo">Loading...</p>
      <div style="display:flex;flex-direction:column;gap:16px;margin-top:20px;">
        <button id="btnWalletOption" style="padding:18px;border:none;border-radius:16px;cursor:pointer;background:#2563eb;color:white;font-size:16px;">
          Withdraw to Web3 Wallet
        </button>
        <button id="btnBankOption" style="padding:18px;border:none;border-radius:16px;cursor:pointer;background:#16a34a;color:white;font-size:16px;">
          Withdraw to Bank
        </button>
      </div>

      <div id="walletBox" style="display:none;margin-top:24px;">
        <input id="walletInput" placeholder="Your wallet address" style="width:100%;padding:14px;border-radius:12px;border:none;" />
        <button id="btnClaim" style="width:100%;margin-top:16px;padding:14px;border:none;border-radius:12px;background:#06b6d4;color:white;font-size:16px;cursor:pointer;">
          Claim Now
        </button>
      </div>

      <div id="bankBox" style="display:none;margin-top:24px;">
        <div id="bankWithdrawForm" style="margin-top:16px;display:none;flex-direction:column;gap:12px;">
          <input id="bankCountry" placeholder="Country" style="padding:14px;border-radius:12px;border:none;" />
          <input id="bankName" placeholder="Bank Name" style="padding:14px;border-radius:12px;border:none;" />
          <input id="bankAccount" placeholder="Account Number" style="padding:14px;border-radius:12px;border:none;" />
          <input id="bankHolder" placeholder="Account Holder" style="padding:14px;border-radius:12px;border:none;" />
          <button id="btnRequestWithdraw" style="padding:16px;border:none;border-radius:14px;background:#2563eb;color:white;font-weight:bold;cursor:pointer;">
            Request Bank Withdraw
          </button>
        </div>
      </div>

      <p id="claimStatus" style="margin-top:20px;"></p>
    </div>
  `;

  let claimData = null;

  try {
    const data = await api(`/api/claims/${claimId}`);
    claimData = data;

    if (!data || !data.amount) {
      document.body.innerHTML = "❌ Claim not found";
      return;
    }

    document.getElementById("claimInfo").innerText = `You received ${data.amount} USDC`;
  } catch (err) {
    document.body.innerHTML = "❌ Claim not found";
    return;
  }

  document.getElementById("btnWalletOption").onclick = () => {
    document.getElementById("walletBox").style.display = "block";
    document.getElementById("bankBox").style.display = "none";
  };

  document.getElementById("btnBankOption").onclick = () => {
    document.getElementById("bankBox").style.display = "block";
    document.getElementById("walletBox").style.display = "none";
    document.getElementById("bankWithdrawForm").style.display = "flex";
  };

  document.getElementById("btnClaim").onclick = async () => {
    const wallet = document.getElementById("walletInput").value;
    try {
      const result = await api(`/api/claims/${claimId}/claim`, {
        method: "POST",
        body: JSON.stringify({ walletAddress: wallet })
      });
      document.getElementById("claimStatus").innerText = result.success ? "Claimed!" : "Error: " + result.error;
    } catch (err) {
      document.getElementById("claimStatus").innerText = "Error: " + err.message;
    }
  };

  document.getElementById("btnRequestWithdraw")?.addEventListener("click", async () => {
    const country = document.getElementById("bankCountry").value;
    const bankName = document.getElementById("bankName").value;
    const account = document.getElementById("bankAccount").value;
    const holder = document.getElementById("bankHolder").value;

    const res = await fetch("/api/withdrawals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: claimData?.recipientEmail || "",
        amount: claimData?.amount || 0,
        country,
        bankName,
        accountHolder: holder,
        accountNumber: account
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Bank withdraw request failed");
      return;
    }
    alert("Bank withdraw request submitted");
  });
}

/* =========================
   EVENT LISTENERS + INIT
========================= */

document.getElementById("btnMobileMenu")
  ?.addEventListener("click", () => {
    document.querySelector(".sidebar")?.classList.toggle("open");
  });

document.addEventListener("click", (e) => {
  const sidebar = document.querySelector(".sidebar");
  const btnMobileMenu = document.getElementById("btnMobileMenu");

  if (
    sidebar?.classList.contains("open") &&
    !sidebar.contains(e.target) &&
    !btnMobileMenu?.contains(e.target)
  ) {
    sidebar.classList.remove("open");
  }
});

btnSaveCustomer?.addEventListener("click", saveCustomer);

btnSendClaimEmail?.addEventListener("click", async () => {
  const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value;
  if (paymentMethod === "card") {
    alert("Visa/Mastercard flow coming soon");
    return;
  }
  sendClaimEmail();
});

btnSaveBiz?.addEventListener("click", saveBusinessProfile);

// Connect button opens wallet modal
btnConnectWallet?.addEventListener("click", () => {
  walletModalMode = "connect";
  document.getElementById("walletModal")?.classList.remove("hidden");
});

btnDisconnectWallet?.addEventListener("click", disconnectMetaMask);

// Close wallet modal
document.getElementById("btnCloseWalletModal")?.addEventListener("click", () => {
  document.getElementById("walletModal")?.classList.add("hidden");
});

let walletModalMode = "connect";

// MetaMask option in modal
document.getElementById("btnChooseMetaMask")?.addEventListener("click", async () => {
  document.getElementById("walletModal")?.classList.add("hidden");

  if (walletModalMode === "pay") {
  await payWithMetaMask();
  return;
}

  await openAppKitWallet();
});

// OKX Wallet — real connection
async function connectOKX() {
  const okx = window.okxwallet;
  if (!okx) {
    setStatus("OKX Wallet not installed.", "error");
    window.open("https://www.okx.com/download", "_blank");
    return;
  }
  try {
    const accounts = await okx.request({ method: "eth_requestAccounts" });
    metamaskWallet = accounts[0] || null;
    if (metamaskWalletEl) metamaskWalletEl.textContent = metamaskWallet || "Disconnected";
    updateWalletChip(metamaskWallet, null);
    clearCircleWalletLocal();
activeWalletType = "web3";
    setStatus("OKX Wallet connected.", "success");
  } catch (err) {
    setStatus("OKX connect failed: " + err.message, "error");
  }
}

// Coinbase Wallet — real connection
async function connectCoinbase() {
  const cb = window.coinbaseWalletExtension || window.ethereum;
  if (!cb) {
    setStatus("Coinbase Wallet not installed.", "error");
    window.open("https://www.coinbase.com/wallet/downloads", "_blank");
    return;
  }
  try {
    const accounts = await cb.request({ method: "eth_requestAccounts" });
    metamaskWallet = accounts[0] || null;
    if (metamaskWalletEl) metamaskWalletEl.textContent = metamaskWallet || "Disconnected";
    updateWalletChip(metamaskWallet, null);
    clearCircleWalletLocal();
activeWalletType = "web3";
    setStatus("Coinbase Wallet connected.", "success");
  } catch (err) {
    setStatus("Coinbase connect failed: " + err.message, "error");
  }
}

document.getElementById("btnChooseWeb3")?.addEventListener("click", async () => {
  document.getElementById("walletModal")?.classList.add("hidden");
  await openAppKitWallet();
});

// Google / Circle option in modal
document.getElementById("btnChooseCircle")?.addEventListener("click", async () => {
  document.getElementById("walletModal")?.classList.add("hidden");
  if (walletModalMode === "pay") {
    await payWithCircleWallet();
    return;
  }
  await connectGoogleCircle();
});

// Google button in modal header — same as Circle option
btnGoogle?.addEventListener("click", async () => {
  document.getElementById("walletModal")?.classList.add("hidden");
  await connectGoogleCircle();
});

btnSetupPin?.addEventListener("click", setupCirclePin);
btnSwitchArc?.addEventListener("click", switchArc);

// Pay Invoice button opens wallet modal in pay mode
btnPay?.addEventListener("click", async () => {
  if (metamaskWallet) {
    await payWithMetaMask();
    return;
  }

const appKitAccount = getAccount(wagmiAdapter.wagmiConfig);
if (appKitAccount?.address) {
  await payWithAppKit();
  return;
}

  const circleAddress = circleWalletEl?.textContent?.trim();
  if (circleAddress && circleAddress.startsWith("0x")) {
    await payWithCircleWallet();
    return;
  }

  setStatus("Please connect Web3 wallet or Circle Wallet first.", "error");
});

btnPayCircle?.addEventListener("click", payWithCircleWallet);
btnCreateInvoice?.addEventListener("click", createInvoice);
btnLoadInvoices?.addEventListener("click", loadInvoices);

btnRefresh?.addEventListener("click", () => {
  window.location.reload();
});

btnLogoutGoogle?.addEventListener("click", () => {
  localStorage.removeItem("googleUser");
  localStorage.removeItem("googleToken");
  localStorage.removeItem("circleUserToken");
  localStorage.removeItem("circleEncryptionKey");
  if (emailEl) emailEl.textContent = "-";
  if (circleWalletEl) circleWalletEl.textContent = "-";
  setStatus("Google / Circle logged out.", "success");
});

customerSelectEl?.addEventListener("change", () => {
  const customers = JSON.parse(localStorage.getItem("customers") || "[]");
  const selected = customers[customerSelectEl.value];
  if (selected) recipientEl.value = selected.wallet || "";
});

// Listen for account changes from MetaMask
if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts) => {
    metamaskWallet = accounts?.[0] || null;
    if (metamaskWalletEl) metamaskWalletEl.textContent = metamaskWallet || "Disconnected";
    updateWalletChip(metamaskWallet, null);
  });
}

/* =========================
   PAGE INIT
========================= */

if (isClaimPage) {
  loadClaimPage();
} else {
  renderQR(null);
  handleGoogleRedirect();

  loadInvoices().then(async () => {
    const invoiceId = new URLSearchParams(window.location.search).get("invoice");
    if (invoiceId) await openInvoice(invoiceId);
  });

  renderCustomerDropdown();
  loadDashboard();

  // Poll for invoice and dashboard updates every 5 seconds
  setInterval(async () => {
    try {
      await loadInvoices();
      if (selectedInvoice?.id) {
        const data = await api("/api/invoices/" + encodeURIComponent(selectedInvoice.id));
        selectedInvoice = data.invoice;
        renderSelectedInvoice();
      }
    } catch (err) {
      console.warn("Realtime poll error:", err.message);
    }
  }, 5000);

  setInterval(loadDashboard, 5000);
}

// Invoice sheet close handlers
document.getElementById("btnCloseInvoiceSheet")?.addEventListener("click", closeInvoiceSheet);
document.getElementById("closeInvoiceSheet")?.addEventListener("click", closeInvoiceSheet);

// Swipe down to close invoice sheet on mobile
let sheetStartY = 0;
let sheetCurrentY = 0;

const invoiceSheetEl = document.getElementById("invoiceSheet");

invoiceSheetEl?.addEventListener("touchstart", (e) => {
  sheetStartY = e.touches[0].clientY;
});

invoiceSheetEl?.addEventListener("touchmove", (e) => {
  sheetCurrentY = e.touches[0].clientY;
});

invoiceSheetEl?.addEventListener("touchend", () => {
  const distance = sheetCurrentY - sheetStartY;
  if (distance > 90) closeInvoiceSheet();
  sheetStartY = 0;
  sheetCurrentY = 0;
});

console.log("GLOBAL openCardPayment:", typeof globalThis.openCardPayment);
console.log("GLOBAL openCardPayment:", typeof window.openCardPayment);

// Mount React panels
const payoutRoot = document.getElementById("payout-root");
const payrollRoot = document.getElementById("payroll-anchor");

if (payoutRoot) createRoot(payoutRoot).render(<PayoutPanel />);
if (payrollRoot) createRoot(payrollRoot).render(<PayrollPanel />);

closeInvoiceModalEl?.addEventListener("click", () => {
  invoiceModalEl?.classList.add("hidden");
});

invoiceModalEl?.addEventListener("click", (e) => {
  if (e.target === invoiceModalEl) invoiceModalEl.classList.add("hidden");
});

/* =========================
   VOICE AI INVOICE
========================= */

btnVoiceInvoice?.addEventListener("click", () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    setStatus("Speech recognition not supported.", "error");
    return;
  }

  const recognition = new SpeechRecognition();
  const selectedLang = voiceLangEl?.value || "en-US";

  recognition.lang = selectedLang === "auto" ? "en-US" : selectedLang;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  setStatus("🎤 Listening... Speak naturally.");

  // Prevent duplicate recognition sessions
  if (window.__voiceRunning) return;
  window.__voiceRunning = true;

  setTimeout(() => { recognition.start(); }, 300);

  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
    console.log("VOICE TRANSCRIPT:", transcript);

    const aiPrompt = document.getElementById("aiPrompt");
    if (aiPrompt) {
      aiPrompt.value = transcript;
      parseInvoicePrompt(transcript);
      recognition.stop();
    }

    setStatus("Voice captured.", "success");

    // Auto-generate AI draft from voice input
    if (typeof window.generateAIDraft === "function") {
      await window.generateAIDraft();
    }
  };

  recognition.onerror = (event) => {
    console.error(event);
    window.__voiceRunning = false;
    setStatus("Voice recognition failed: " + event.error, "error");
  };

  recognition.onend = () => {
    window.__voiceRunning = false;
    console.log("Voice recognition ended.");
  };
});

/* =========================
   TAB NAVIGATION
========================= */

function showTab(tabId) {
  document.querySelectorAll(".app-section").forEach((section) => {
    section.classList.toggle("hidden-section", section.id !== tabId);
  });

  document.querySelectorAll("[data-tab]").forEach((link) => {
    link.classList.toggle("active-tab", link.dataset.tab === tabId);
  });
}

document.querySelectorAll("[data-tab]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const tabId = link.dataset.tab;
    window.location.hash = tabId;
    showTab(tabId);
  });
});

showTab(window.location.hash.replace("#", "") || "dashboard");

/* =========================
   AI INVOICE API CALL
========================= */

async function parseInvoicePrompt(prompt) {
  try {
    const res = await fetch("/api/ai/invoice-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });

    const data = await res.json();
    console.log("AI RESULT:", data);

    document.getElementById("title").value = data.draft?.title || "Invoice";
    document.getElementById("amount").value = data.draft?.amount || "";
  } catch (err) {
    console.error(err);
  }
}

/* =========================
   WITHDRAWALS
========================= */

async function loadWithdrawals() {
  try {
    const rows = await api("/api/withdrawals");

    const el = document.getElementById("withdrawalsList");
    if (!el) return;

    if (!Array.isArray(rows) || rows.length === 0) {
      el.innerHTML = "No withdrawals found";
      return;
    }

    el.innerHTML = rows.map((w) => `
      <div style="padding:12px;margin:10px 0;background:#111827;border-radius:10px;">
        <div><b>${w.account_holder || "-"}</b></div>
        <div>${w.bank_name || "-"}</div>
        <div>${w.account_number || "-"}</div>
        <div>${w.amount || 0} USDC</div>
        <div>Status: ${w.status || "PENDING"}</div>
        ${w.status === "PENDING" ? `<button onclick="updateWithdrawalStatus('${w.id}','REVIEW')">Review</button>` : ""}
        ${w.status === "REVIEW" ? `
          <button onclick="updateWithdrawalStatus('${w.id}','APPROVED')">Approve</button>
          <button onclick="updateWithdrawalStatus('${w.id}','REJECTED')">Reject</button>
        ` : ""}
        ${w.status === "APPROVED" ? `<button onclick="updateWithdrawalStatus('${w.id}','COMPLETED')">Complete</button>` : ""}
      </div>
    `).join("");
  } catch (err) {
    console.error(err);
  }
}

window.updateWithdrawalStatus = async function (id, status) {
  await api(`/api/withdrawals/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  await loadWithdrawals();
};

document.getElementById("btnLoadWithdrawals")?.addEventListener("click", loadWithdrawals);

// Sync AppKit wallet address with ArcPay
import { watchAccount } from "@wagmi/core";

watchAccount(wagmiAdapter.wagmiConfig, {
  onChange(account) {
    if (account.address) {
      metamaskWallet = account.address;
      if (metamaskWalletEl) metamaskWalletEl.textContent = account.address;
      updateWalletChip(account.address, null);
      clearCircleWalletLocal();
activeWalletType = "web3";
    } else {
  metamaskWallet = null;
  updateWalletChip(null, null);

  if (activeWalletType === "web3") {
    activeWalletType = null;
  }
 }
}
});