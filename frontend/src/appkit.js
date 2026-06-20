import { createAppKit } from "@reown/appkit";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "ETH",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

const projectId = "70b21c44685fc62f9b501eb07b04a67b";

const metadata = {
  name: "ArcPay",
  description: "ArcPay USDC payments on Arc Network",
  url: "https://arcpay.pro",
  icons: ["https://arcpay.pro/favicon.ico"],
};

export const wagmiAdapter = new WagmiAdapter({
  networks: [arcTestnet],
  projectId,
});

export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  networks: [arcTestnet],
  projectId,
  metadata,
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
});

export async function openAppKitWallet() {
  appKit.open();
}