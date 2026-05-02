import "./style.css";
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import Web3 from "web3";

window.Web3 = Web3;

const API_BASE = import.meta.env.VITE_API_BASE || "";

const ARC_CHAIN_ID = 5042002;
const ARC_CHAIN_HEX = "0x4cef52";
const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_EXPLORER = "https://testnet.arcscan.app";
const ARC_CHAIN_NAME = "Arc Testnet";

const USDC_TOKEN = "0x3600000000000000000000000000000000000000";
const USDC_DECIMALS = 6;

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
    constant: true,
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    type: "function"
  }
];

let selectedInvoice = null;
let metamaskWallet = null;

const statusEl = document.getElementById("status");
const emailEl = document.getElementById("email");
const circleWalletEl = document.getElementById("circleWallet");
const metamaskWalletEl = document.getElementById("metamaskWallet");
const selectedInvoiceEl = document.getElementById("selectedInvoice");
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
const btnPayCircle = document.getElementById("btnPayCircle");
const btnCreateInvoice = document.getElementById("btnCreateInvoice");
const btnLoadInvoices = document.getElementById("btnLoadInvoices");
const btnRefresh = document.getElementById("btnRefresh");
const btnLogoutGoogle = document.getElementById("btnLogoutGoogle");

function setStatus(message, type = "") {
  statusEl.className = type;
  statusEl.textContent = message;
}

function formatUsdc(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 6
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
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

function toTokenUnits(amount, decimals) {
  const text = String(amount || "0").trim();
  const [wholeRaw, fracRaw = ""] = text.split(".");
  const whole = wholeRaw || "0";
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${whole}${frac}`.replace(/^0+/, "");
  return combined || "0";
}

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
   QR
========================= */

function getInvoicePayUrl(inv) {
  return `${window.location.origin}/?invoice=${encodeURIComponent(inv.id)}`;
}

function renderQR(inv) {
  if (!qrBoxEl) return;

  if (!inv || !inv.id) {
    qrBoxEl.innerHTML = `<div class="qr-empty">Open an invoice to show QR.</div>`;
    return;
  }

  const payUrl = getInvoicePayUrl(inv);
  const qrUrl =
    "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" +
    encodeURIComponent(payUrl);

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

  const btnCopyLink = document.getElementById("btnCopyLink");
  if (btnCopyLink) {
    btnCopyLink.addEventListener("click", async () => {
      await navigator.clipboard.writeText(payUrl);
      setStatus("Payment link copied.", "success");
    });
  }

  const btnCopyRecipient = document.getElementById("btnCopyRecipient");
  if (btnCopyRecipient) {
    btnCopyRecipient.addEventListener("click", async () => {
      await navigator.clipboard.writeText(inv.recipientAddress);
      setStatus("Recipient address copied.", "success");
    });
  }
}

/* =========================
   CIRCLE HELPERS
========================= */

function extractWalletAddress(data) {
  const wallet = extractWallet(data);

  return (
    wallet?.address ||
    wallet?.walletAddress ||
    wallet?.accounts?.[0]?.address ||
    null
  );
}

function extractWallet(data) {
  const wallets =
    data?.data?.wallets ||
    data?.wallets ||
    [];

  return (
    wallets.find((w) => String(w.blockchain || "").toUpperCase() === "ARC-TESTNET") ||
    wallets[0] ||
    data?.data?.wallet ||
    data?.wallet ||
    null
  );
}

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
  const encryptionKey =
    tokenData?.data?.encryptionKey || tokenData?.encryptionKey;

  if (!userToken || !encryptionKey) {
    console.log("Circle token response:", tokenData);
    throw new Error("Missing Circle userToken or encryptionKey.");
  }

  localStorage.setItem("circleUserToken", userToken);
  localStorage.setItem("circleEncryptionKey", encryptionKey);

  return { user, userToken, encryptionKey };
}

async function listCircleWallets(userToken) {
  try {
    return await api("/api/circle/list-wallets", {
      method: "POST",
      body: JSON.stringify({ userToken })
    });
  } catch (err) {
    return await api("/api/circle/wallets", {
      method: "POST",
      body: JSON.stringify({ userToken })
    });
  }
}

async function loadCircleWallet(userToken) {
  const listData = await listCircleWallets(userToken);
  console.log("List wallets response:", listData);

  const wallet = extractWallet(listData);
  const address = extractWalletAddress(listData);

  if (!address) {
    circleWalletEl.textContent = JSON.stringify(listData, null, 2);
    setStatus("Wallet loaded but address not found. Check console.", "error");
    return null;
  }

  circleWalletEl.textContent = address;
  setStatus("Circle wallet loaded.", "success");

  return {
    wallet,
    address
  };
}

async function findUsdcToken(userToken, walletId) {
  const balanceData = await api("/api/circle/wallet-balances", {
    method: "POST",
    body: JSON.stringify({
      userToken,
      walletId
    })
  });

  console.log("FULL Circle balances:", balanceData);

  const tokenBalances =
    balanceData?.data?.tokenBalances ||
    balanceData?.tokenBalances ||
    [];

  const usdc =
    tokenBalances.find((b) => {
      const symbol = String(b?.token?.symbol || "").toUpperCase();
      const tokenAddress = String(b?.token?.tokenAddress || "").toLowerCase();
      const blockchain = String(b?.token?.blockchain || "").toUpperCase();

      return (
        symbol === "USDC" &&
        blockchain === "ARC-TESTNET" &&
        tokenAddress === USDC_TOKEN.toLowerCase()
      );
    }) ||
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

  return {
    tokenId,
    balance,
    raw: usdc
  };
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

  const redirectUri = window.location.origin;

  window.location.href =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" +
    encodeURIComponent(googleClientId) +
    "&redirect_uri=" +
    encodeURIComponent(redirectUri) +
    "&response_type=token" +
    "&scope=" +
    encodeURIComponent("openid email profile") +
    "&prompt=" +
    encodeURIComponent("select_account");
}

async function handleGoogleRedirect() {
  const hash = window.location.hash;

  if (!hash.includes("access_token")) {
    const savedUser = getGoogleUser();

    if (savedUser.email) {
      emailEl.textContent = savedUser.email;
    }

    const savedToken = localStorage.getItem("circleUserToken");
    if (savedToken) {
      try {
        await loadCircleWallet(savedToken);
      } catch {}
    }

    return;
  }

  const params = new URLSearchParams(hash.replace("#", ""));
  const googleToken = params.get("access_token");

  if (!googleToken) return;

  localStorage.setItem("googleToken", googleToken);

  const user = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: "Bearer " + googleToken
    }
  }).then((r) => r.json());

  if (!user.email) {
    setStatus("Google login failed: missing email.", "error");
    return;
  }

  localStorage.setItem("googleUser", JSON.stringify(user));
  emailEl.textContent = user.email;

  window.history.replaceState(null, "", window.location.pathname);

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

    const sdk = new W3SSdk({
      appSettings: { appId }
    });

    sdk.setAuthentication({
      userToken,
      encryptionKey
    });

    sdk.execute(challengeId, async (error, result) => {
      if (error) {
        console.error("PIN setup error:", error);
        setStatus(
          "PIN setup failed: " + (error.message || JSON.stringify(error)),
          "error"
        );
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
  try {
    const body = {
      title: titleEl.value,
      amount: amountEl.value,
      recipientAddress: recipientEl.value,
      targetChain: "Arc",
      note: noteEl.value
    };

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
      const div = document.createElement("div");
      div.className = "invoice";

      div.innerHTML = `
        <div class="invoice-title">${escapeHtml(inv.title)}</div>
        <div>${formatUsdc(inv.amount)} USDC</div>
        <div><b>Status:</b> ${escapeHtml(inv.status)}</div>
        <div><b>ID:</b> ${escapeHtml(inv.id)}</div>
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
    setStatus("Invoice opened.", "success");
  } catch (err) {
    setStatus("Open invoice failed: " + err.message, "error");
  }
}

function renderSelectedInvoice() {
  if (!selectedInvoice) {
    selectedInvoiceEl.textContent = "No invoice selected.";
    renderQR(null);
    return;
  }

  selectedInvoiceEl.innerHTML = `
    <div><b>${escapeHtml(selectedInvoice.title)}</b></div>
    <div>${formatUsdc(selectedInvoice.amount)} USDC</div>
    <div>Status: ${escapeHtml(selectedInvoice.status)}</div>
    <div>ID: ${escapeHtml(selectedInvoice.id)}</div>
    <div>Recipient: ${escapeHtml(selectedInvoice.recipientAddress)}</div>
    ${
      selectedInvoice.txHash
        ? `<div>TX: <a href="${ARC_EXPLORER}/tx/${escapeHtml(
            selectedInvoice.txHash
          )}" target="_blank" rel="noreferrer">${escapeHtml(
            selectedInvoice.txHash
          )}</a></div>`
        : ""
    }
  `;

  renderQR(selectedInvoice);
}

/* =========================
   METAMASK PAYMENT
========================= */

async function connectMetaMask() {
  try {
    if (!window.ethereum) {
      setStatus("Install MetaMask first.", "error");
      return;
    }

    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts"
    });

    metamaskWallet = accounts[0] || null;
    metamaskWalletEl.textContent = metamaskWallet || "Disconnected";

    setStatus("MetaMask connected.", "success");
  } catch (err) {
    setStatus("MetaMask connect failed: " + err.message, "error");
  }
}

function disconnectMetaMask() {
  metamaskWallet = null;
  metamaskWalletEl.textContent = "Disconnected";
  setStatus("MetaMask disconnected locally.", "success");
}

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
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: ARC_CHAIN_HEX,
            chainName: ARC_CHAIN_NAME,
            rpcUrls: [ARC_RPC],
            nativeCurrency: {
              name: "ETH",
              symbol: "ETH",
              decimals: 18
            },
            blockExplorerUrls: [ARC_EXPLORER]
          }
        ]
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
      setStatus("Install MetaMask first.", "error");
      return;
    }

    if (!metamaskWallet) {
      await connectMetaMask();
    }

    if (!metamaskWallet) {
      setStatus("Connect MetaMask first.", "error");
      return;
    }

    if (!selectedInvoice) {
      setStatus("Open invoice first.", "error");
      return;
    }

    const chainId = await window.ethereum.request({
      method: "eth_chainId"
    });

    if (parseInt(chainId, 16) !== ARC_CHAIN_ID) {
      setStatus("Wrong network. Click Switch Arc first.", "error");
      return;
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

    const tx = await token.methods
      .transfer(selectedInvoice.recipientAddress, amountUnits)
      .send({
  from: metamaskWallet,
  gas: 120000
});

    await markInvoicePaid(tx.transactionHash, metamaskWallet);

    setStatus("MetaMask payment success: " + tx.transactionHash, "success");
  } catch (err) {
    setStatus("MetaMask payment failed: " + err.message, "error");
  }
}

/* =========================
   CIRCLE WALLET PAYMENT
========================= */

async function payWithCircleWallet() {
  try {
    console.log("Circle pay clicked");

    if (!selectedInvoice) {
      setStatus("Open invoice first.", "error");
      return;
    }

    if (selectedInvoice.status === "PAID") {
      setStatus("Invoice already paid.", "success");
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
    console.log("Circle wallet list:", walletList);

    const wallet = extractWallet(walletList);
    const walletAddress = extractWalletAddress(walletList);

    if (!wallet || !wallet.id || !walletAddress) {
      console.log("Wallet list:", walletList);
      setStatus("No Circle wallet found.", "error");
      return;
    }

    circleWalletEl.textContent = walletAddress;

    setStatus("Checking Circle USDC balance...");

    const usdc = await findUsdcToken(userToken, wallet.id);
    console.log("USDC token:", usdc);

    const invoiceAmount = Number(selectedInvoice.amount || 0);

    if (!Number.isFinite(usdc.balance) || usdc.balance < invoiceAmount) {
      setStatus(
        `Not enough USDC in Circle wallet. Balance: ${usdc.balance} USDC`,
        "error"
      );
      return;
    }

    setStatus("Creating Circle transfer challenge...");

    console.log("Circle transfer payload:", {
  userToken,
  walletId: wallet.id,
  tokenId: usdc.tokenId,
  amount: String(selectedInvoice.amount),
  destinationAddress: selectedInvoice.recipientAddress,
  walletBlockchain: wallet.blockchain
});

    const transferData = await api("/api/circle/transfer", {
      method: "POST",
      body: JSON.stringify({
        userToken,
        walletId: wallet.id,
        tokenId: usdc.tokenId,
        amount: String(selectedInvoice.amount),
        destinationAddress: selectedInvoice.recipientAddress
      })
    });

    console.log("Circle transfer response:", transferData);

    const challengeId =
      transferData?.data?.challengeId || transferData?.challengeId;

    if (!challengeId) {
      setStatus("No Circle transfer challengeId returned. Check console.", "error");
      return;
    }

    const sdk = new W3SSdk({
      appSettings: { appId }
    });

    sdk.setAuthentication({
      userToken,
      encryptionKey
    });

    sdk.execute(challengeId, async (error, result) => {
      if (error) {
        console.error("Circle payment error:", error);
        setStatus(
          "Circle payment failed: " + (error.message || JSON.stringify(error)),
          "error"
        );
        return;
      }

      console.log("Circle payment approved:", result);
      setStatus("Circle payment approved. Waiting for transaction...");

      setTimeout(async () => {
        try {
          const txData = await api("/api/circle/transactions", {
            method: "POST",
            body: JSON.stringify({ userToken })
          });

          console.log("Circle transactions:", txData);

          const tx =
            txData?.data?.transactions?.find((t) => {
              const dst = String(t.destinationAddress || "").toLowerCase();
              const recipient = String(selectedInvoice.recipientAddress || "").toLowerCase();
              const amount = Number(t.amounts?.[0] || t.amount || 0);

              return dst === recipient && amount === Number(selectedInvoice.amount || 0);
            }) ||
            txData?.data?.transactions?.[0] ||
            null;

          const txHash =
            tx?.txHash ||
            tx?.transactionHash ||
            tx?.id ||
            "circle_pending";

          await markInvoicePaid(txHash, walletAddress);

          setStatus("Circle payment submitted: " + txHash, "success");
        } catch (err) {
          setStatus(
            "Circle payment approved, but invoice update failed: " + err.message,
            "error"
          );
        }
      }, 7000);
    });
  } catch (err) {
    console.error(err);
    setStatus("Pay with Circle failed: " + err.message, "error");
  }
}

/* =========================
   MARK PAID
========================= */

async function markInvoicePaid(txHash, fromAddress) {
  await api(
    "/api/invoices/" + encodeURIComponent(selectedInvoice.id) + "/mark-paid",
    {
      method: "POST",
      body: JSON.stringify({
        txHash,
        fromAddress
      })
    }
  );

  selectedInvoice.status = "PAID";
  selectedInvoice.txHash = txHash;

  renderSelectedInvoice();
  await loadInvoices();
}

/* =========================
   EVENTS + INIT
========================= */

btnGoogle?.addEventListener("click", connectGoogleCircle);
btnSetupPin?.addEventListener("click", setupCirclePin);
btnConnectWallet?.addEventListener("click", connectMetaMask);
btnDisconnectWallet?.addEventListener("click", disconnectMetaMask);
btnSwitchArc?.addEventListener("click", switchArc);
btnPay?.addEventListener("click", payWithMetaMask);
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

  emailEl.textContent = "-";
  circleWalletEl.textContent = "-";

  setStatus("Google / Circle logged out.", "success");
});

if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts) => {
    metamaskWallet = accounts?.[0] || null;
    metamaskWalletEl.textContent = metamaskWallet || "Disconnected";
  });
}

renderQR(null);
handleGoogleRedirect();
loadInvoices().then(async () => {
  const invoiceId = new URLSearchParams(window.location.search).get("invoice");
  if (invoiceId) {
    await openInvoice(invoiceId);
  }
});

setInterval(async () => {
  try {
    await loadInvoices();

    if (selectedInvoice?.id) {
      const data = await api("/api/invoices/" + encodeURIComponent(selectedInvoice.id));
      selectedInvoice = data.invoice;
      renderSelectedInvoice();
    }
  } catch (err) {
    console.warn("Realtime error:", err.message);
  }
}, 5000);

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 3500);
}

window.generateAIDraft = async function () {
  const prompt = document.getElementById("aiPrompt").value;

  const res = await fetch("/api/ai/invoice-draft", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });

  const data = await res.json();

  if (!data.success) {
    alert("AI failed");
    return;
  }

  document.getElementById("aiResult").textContent =
    JSON.stringify(data.draft, null, 2);

  // Auto-fill invoice form
titleEl.value = data.draft.title || "";
amountEl.value = data.draft.amount || "";
noteEl.value = data.draft.description || "";

recipientEl.value = data.draft.customer && data.draft.customer.startsWith("0x")
  ? data.draft.customer
  : "";
};
 
function shortTx(tx) {
  if (!tx) return "-";
  return tx.slice(0, 8) + "..." + tx.slice(-6);
}

async function loadDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    const data = await res.json();

    document.getElementById("dashTotal").innerText =
      Number(data.totalReceived || 0).toFixed(2) + " USDC";

    document.getElementById("dashPaid").innerText =
      data.paidCount || 0;

    document.getElementById("dashPending").innerText =
      data.pendingCount || 0;

    document.getElementById("dashLatestTx").innerText =
      data.latestPayment?.txHash
        ? shortTx(data.latestPayment.txHash)
        : "-";

  } catch (err) {
    console.error("loadDashboard error:", err);
  }
}

loadDashboard();
setInterval(loadDashboard, 5000);
