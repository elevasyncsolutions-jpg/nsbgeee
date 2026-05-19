import express from "express";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";
import { Connection, Keypair, VersionedTransaction, SystemProgram, Transaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "../public")));

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYOUT_WALLET = process.env.PAYOUT_WALLET;
const APP_PASSWORD = process.env.APP_PASSWORD || "FLOWWW111";
const SESSION_SECRET = process.env.SESSION_SECRET || "fallback_secret";

let wallet = null;
if (process.env.SERVER_WALLET_SECRET_KEY_BASE58) {
  wallet = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_WALLET_SECRET_KEY_BASE58));
  console.log("🟢 Hot Wallet Loaded");
}

const state = { running: false, loop: null, logs: [], positions: [] };

function logEngine(msg, type = "INFO") {
  const entry = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
  console.log(entry);
  state.logs.unshift({ time: new Date().toISOString(), type, msg });
  state.logs = state.logs.slice(0, 100);
}

// Security Middleware
app.post("/api/login", (req, res) => {
  if (req.body?.password === APP_PASSWORD) {
    res.cookie("apex_auth", SESSION_SECRET, { httpOnly: false, sameSite: "lax", maxAge: 7 * 86400 * 1000 });
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: "bad_password" });
  }
});

function requireAuth(req, res, next) {
  if (req.path === "/api/login") return next();
  if (req.cookies?.apex_auth === SESSION_SECRET) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

app.use("/api", requireAuth);

// API Routes
app.get("/api/status", (req, res) => res.json({ state }));

app.post("/api/start", (req, res) => {
  if (state.running) return res.json({ ok: true, msg: "Already running" });
  state.running = true;
  state.loop = setInterval(scanMarket, 15000); 
  logEngine("Apex Engine Started.", "SYSTEM");
  scanMarket();
  res.json({ ok: true });
});

app.post("/api/stop", (req, res) => {
  clearInterval(state.loop);
  state.running = false;
  logEngine("Apex Engine Halted.", "SYSTEM");
  res.json({ ok: true });
});

// Trading Logic
async function validateWithGroq(tokenData) {
  if (!GROQ_API_KEY) return true;
  const prompt = `Analyze this Solana token data: Name: ${tokenData.baseToken.name}, Symbol: ${tokenData.baseToken.symbol}, Liquidity: $${tokenData.liquidity?.usd}, FDV: $${tokenData.fdv}. Does this look like a high-risk rug pull or a safe micro-cap for a quick 2x scalp? Answer strictly "SAFE" or "RUG".`;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1
      })
    });
    const data = await res.json();
    return data.choices[0].message.content.trim().toUpperCase().includes("SAFE");
  } catch (e) {
    logEngine("Groq API Error: " + e.message, "ERROR");
    return false;
  }
}

async function checkAndSweepProfits() {
  if (!wallet || !PAYOUT_WALLET) return;
  const balance = await connection.getBalance(wallet.publicKey) / 1e9;
  const threshold = parseFloat(process.env.AUTO_PAYOUT_THRESHOLD_SOL || 0.05);
  const sweepAmount = parseFloat(process.env.AUTO_PAYOUT_AMOUNT_SOL || 0.02);

  if (balance >= threshold) {
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(PAYOUT_WALLET),
          lamports: Math.floor(sweepAmount * 1e9)
        })
      );
      const signature = await connection.sendTransaction(tx, [wallet]);
      logEngine(`Swept ${sweepAmount} SOL to ${PAYOUT_WALLET}. TX: ${signature}`, "PAYOUT");
    } catch (e) {
      logEngine(`Sweep failed: ${e.message}`, "ERROR");
    }
  }
}

async function scanMarket() {
  logEngine("Heartbeat: Checking market for all activity...", "SCAN");
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana");
    const data = await res.json();
    
    // REMOVED THE >1000 FILTER: Now it checks everything found
    const pairs = (data.pairs || []).filter(p => p.chainId === "solana");
    
    if (pairs.length === 0) {
      logEngine("No tokens found. Refreshing...", "INFO");
      return;
    }

    logEngine(`Scanning ${pairs.length} tokens...`, "SCAN");

    for (const p of pairs.slice(0, 3)) {
        // Logging every single token found so you KNOW it's working
        logEngine(`Analyzing: ${p.baseToken.symbol} | Vol: ${p.volume?.m5}`, "ANALYSIS");
        
        // Removed the strict volume acceleration check temporarily 
        // to see if the engine triggers on ANY token
        logEngine(`Groq auditing ${p.baseToken.symbol}...`, "ALERT");
        const isSafe = await validateWithGroq(p);
        
        if (isSafe) {
          logEngine(`SAFE: ${p.baseToken.symbol} ready for trade.`, "TRADE");
        }
    }
  } catch (e) {
    logEngine("Error: " + e.message, "ERROR");
  }
}

app.listen(process.env.PORT || 8080, () => {
  console.log("🚀 V18 Apex Engine Running");
});
