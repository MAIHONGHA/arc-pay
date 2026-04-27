import { state } from "./state.js";
import { config } from "./config.js";

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

export async function connectWallet() {
  if (!window.ethereum) {
    alert("Please install MetaMask");
    return;
  }

  await window.ethereum.request({
    method: "eth_requestAccounts"
  });

  await refreshWallet();
}

export async function switchArc() {
  if (!window.ethereum) {
    alert("MetaMask not found");
    return;
  }

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: config.arcChainIdHex }]
    });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: config.arcChainIdHex,
            chainName: config.arcChainName,
            rpcUrls: [config.arcRpcUrl],
            blockExplorerUrls: [config.arcExplorerUrl],
            nativeCurrency: {
              name: "ARC",
              symbol: "ARC",
              decimals: 18
            }
          }
        ]
      });
    } else {
      throw err;
    }
  }

  await refreshWallet();
}

export function disconnectWallet() {
  state.wallet = {
    address: null,
    chainId: null,
    usdcBalance: null
  };

  renderWallet();
}

export async function refreshWallet() {
  if (!window.ethereum) {
    renderWallet();
    return;
  }

  const accounts = await window.ethereum.request({
    method: "eth_accounts"
  });

  const chainId = await window.ethereum.request({
    method: "eth_chainId"
  });

  state.wallet.address = accounts[0] || null;
  state.wallet.chainId = chainId || null;

  renderWallet();
}

export function renderWallet() {
  setText("walletStatus", state.wallet.address ? "Connected" : "Disconnected");
  setText("walletAddress", short(state.wallet.address));
  setText("chainId", state.wallet.chainId || "-");
}