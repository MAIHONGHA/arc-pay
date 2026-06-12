import { defineConfig } from "vite";
import { resolve } from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: [
        "buffer",
        "process",
        "util",
        "stream",
        "crypto"
      ],
      globals: {
        Buffer: true,
        global: true,
        process: true
      }
    })
  ],

  resolve: {
    alias: {
      crypto: "crypto-browserify",
      stream: "stream-browserify",
      util: "util"
    }
  },

  define: {
    global: "globalThis"
  },

build: {
  rollupOptions: {
    input: {
      main: resolve(__dirname, "index.html"),
      app: resolve(__dirname, "app.html")
    }
  }
},

  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  }
})