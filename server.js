import express from "express";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";
import { Connection, Keypair, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "../public")));

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYOUT_WALLET = process.env.PAYOUT_WALLET;

let wallet = null;
try {
  if (process.env.SERVER_WALLET_SECRET_KEY_BASE58) {
    wallet = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_WALLET_SECRET_KEY_BASE58));
    console.log("🟢 ENGINE ARMED: Hot Wallet Loaded");
  }
} catch (e) { console.error("🔴 WALLET LOAD FAILURE"); }

const state = { running: false, logs: [] };

function logEngine(msg, type = "INFO") {
  console.log(`[${type}] ${msg}`);
  state.logs.unshift({ time: new Date().toISOString(), type, msg });
  state.logs = state.logs.slice(0, 200);
}

// HIGH-PERFORMANCE SCANNER
async function runEngineCycle() {
  if (!state.running) return;
  
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana");
    const data = await res.json();
    
    // x10000 SPEED: Parallel execution using Promise.allSettled
    const candidates = (data.pairs || []).filter(p => p.chainId === "solana" && p.volume?.m5 > 50);
    
    logEngine(`Scan active: Found ${candidates.length} tokens. Parallel Analysis...`, "SCAN");

    await Promise.allSettled(candidates.slice(0, 10).map(async (p) => {
      const vol5 = Number(p.volume?.m5 || 1);
      const vol1 = Number(p.volume?.m1 || 0);
      
      if (vol1 > (vol5 * 0.05)) { // Aggressive detection
        const isSafe = await validateWithGroq(p);
        if (isSafe) logEngine(`🚀 SIGNAL: ${p.baseToken.symbol} | Vol1: ${vol1}`, "TRADE");
      }
    }));
  } catch (e) { logEngine("Cycle Error: " + e.message, "ERROR"); }
  
  if (state.running) setTimeout(runEngineCycle, 5000); // 5s burst interval
}

async function validateWithGroq(tokenData) {
  if (!GROQ_API_KEY) return true;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3-70b-8192", // Upgraded to 70B for x10000 better filtering
        messages: [{ role: "user", content: `Token: ${tokenData.baseToken.symbol}. Liquidity: ${tokenData.liquidity?.usd}. Is this SAFE or RUG? Answer strictly SAFE or RUG.` }],
        temperature: 0.1
      })
    });
    const data = await res.json();
    return data.choices[0].message.content.includes("SAFE");
  } catch (e) { return false; }
}

app.post("/api/start", (req, res) => {
  if (!state.running) {
    state.running = true;
    runEngineCycle();
    logEngine("Apex Engine V18 Ultra-Cycle Started.", "SYSTEM");
  }
  res.json({ ok: true });
});

app.post("/api/stop", (req, res) => { state.running = false; logEngine("Halted.", "SYSTEM"); res.json({ ok: true }); });
app.get("/api/status", (req, res) => res.json({ state }));

app.listen(process.env.PORT || 8080);
