
import express from "express";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";
import { Connection, PublicKey, Keypair, VersionedTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static("public"));

const env = (k, d="") => process.env[k] ?? d;
const bool = (k, d=false) => String(env(k, d ? "true":"false")).toLowerCase()==="true";
const num = (k, d=0) => Number(env(k, d));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const now = () => new Date().toISOString();

const cfg = {
  pass: env("APP_PASSWORD","Flowwwww1234"),
  secret: env("SESSION_SECRET","change_me"),
  dryRun: bool("DRY_RUN", true),
  auto: bool("AUTO_TRADING_ENABLED", false),
  autostart: bool("AUTOSTART", true),
  rpc: env("SOLANA_RPC_URL","https://api.mainnet-beta.solana.com"),
  dexTerms: env("DISCOVERY_TERMS","pump,solana,raydium,meteora,pumpswap,moon,ai").split(",").map(s=>s.trim()).filter(Boolean),
  discoverySeconds: num("DISCOVERY_LOOP_SECONDS", 25),
  walletPollSeconds: num("WALLET_POLL_SECONDS", 25),
  sigLimit: num("RPC_SIGNATURE_LIMIT", 12),
  txBatchSize: num("RPC_TX_BATCH_SIZE", 4),
  rpcMinGapMs: num("RPC_MIN_GAP_MS", 650),
  rpc429BackoffMs: num("RPC_429_BACKOFF_MS", 120000),
  walletWatchEnabled: bool("WALLET_WATCH_ENABLED", true),
  maxTradeSol: num("MAX_TRADE_SOL", 0.0003),
  reserveSol: num("RESERVE_SOL", 0.005),
  maxOpen: num("MAX_OPEN_POSITIONS", 1),
  maxDailyLoss: num("MAX_DAILY_LOSS_USD", 0.25),
  minScore: num("MIN_SCORE_TO_TRADE", 64),
  minLiq: num("MIN_LIQUIDITY_USD", 1000),
  minVol5: num("MIN_VOLUME_5M_USD", 250),
  maxMcap: num("MAX_MARKETCAP_USD", 5000000),
  maxAge: num("MAX_TOKEN_AGE_MINUTES", 180),
  minBuySell: num("MIN_BUY_SELL_RATIO_5M", 0.9),
  maxImpact: num("MAX_PRICE_IMPACT_PCT", 20),
  slippageBps: num("SLIPPAGE_BPS", 500),
  watchWallets: env("WATCH_WALLETS","").split(",").map(s=>s.trim()).filter(Boolean),
  payoutWallet: env("PAYOUT_WALLET",""),
  telegramToken: env("TELEGRAM_BOT_TOKEN",""),
  telegramChat: env("TELEGRAM_CHAT_ID",""),
  dflowEnabled: bool("DFLOW_ENABLED", false),
  dflowQuoteUrl: env("DFLOW_QUOTE_URL",""),
  dflowSwapUrl: env("DFLOW_SWAP_URL",""),
  dflowApiKey: env("DFLOW_API_KEY",""),
  jupQuoteUrl: env("JUPITER_QUOTE_URL","https://api.jup.ag/swap/v1/quote").replace("https://quote-api.jup.ag/v6/quote", "https://api.jup.ag/swap/v1/quote"),
  jupSwapUrl: env("JUPITER_SWAP_URL","https://api.jup.ag/swap/v1/swap").replace("https://quote-api.jup.ag/v6/swap", "https://api.jup.ag/swap/v1/swap"),
  jupApiKey: env("JUPITER_API_KEY",""),
  bitqueryEnabled: bool("BITQUERY_ENABLED", false),
  bitqueryToken: env("BITQUERY_TOKEN",""),
};

const SOL = "So11111111111111111111111111111111111111112";
const connection = new Connection(cfg.rpc, "confirmed");
let wallet = null;
try {
  if (env("SERVER_WALLET_SECRET_KEY_BASE58","")) wallet = Keypair.fromSecretKey(bs58.decode(env("SERVER_WALLET_SECRET_KEY_BASE58")));
} catch(e) { console.error("Bad server wallet key", e.message); }

const state = {
  startedAt: now(),
  running: false,
  panic: false,
  scanLoop: null,
  walletLoop: null,
  alerts: [],
  candidates: [],
  walletEvents: [],
  trades: [],
  positions: [],
  lastSeen: {},
  walletCooldown: {},
  stats: { scans:0, walletPolls:0, txProcessed:0, missedCaught:0, dflowQuotes:0, jupiterQuotes:0, rejects:0, accepted:0, rpc429:0 },
  daily: { lossUsd:0, date: new Date().toISOString().slice(0,10) }
};

function alert(icon,title,msg){
  const a={t:now(),icon,title,msg:String(msg).slice(0,1200)};
  state.alerts.unshift(a); state.alerts=state.alerts.slice(0,80);
  tg(`${icon} *${title}*\n${msg}`).catch(()=>{});
  return a;
}
async function tg(text){
  if(!cfg.telegramToken || !cfg.telegramChat) return;
  await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:cfg.telegramChat,text,parse_mode:"Markdown",disable_web_page_preview:true})
  }).catch(()=>{});
}
function auth(req,res,next){
  if(req.path==="/api/login") return next();
  if(req.cookies?.sde_auth === cfg.secret) return next();
  return res.status(401).json({ok:false,error:"unauthorized"});
}
app.post("/api/login",(req,res)=> {
  if(req.body?.password === cfg.pass){
    res.cookie("sde_auth",cfg.secret,{httpOnly:false,sameSite:"lax",maxAge:7*86400*1000});
    res.json({ok:true});
  } else res.status(401).json({ok:false,error:"bad_password"});
});
app.use("/api", auth);

async function solBalance(){
  if(!wallet) return null;
  return (await connection.getBalance(wallet.publicKey))/1e9;
}

function scorePair(p, source="dex"){
  const tx5=p.txns?.m5||{};
  const buys=Number(tx5.buys||0), sells=Number(tx5.sells||0);
  const buySell=sells===0?buys:buys/sells;
  const liq=Number(p.liquidity?.usd||0), vol5=Number(p.volume?.m5||0);
  const mcap=Number(p.marketCap||p.fdv||0);
  const ageMin=p.pairCreatedAt ? (Date.now()-Number(p.pairCreatedAt))/60000 : 999999;
  const pc5=Number(p.priceChange?.m5||0);
  let score=0, reasons=[];
  if(liq>=cfg.minLiq) score+=16; else reasons.push("low liquidity");
  if(vol5>=cfg.minVol5) score+=16; else reasons.push("low 5m volume");
  if(buySell>=cfg.minBuySell) score+=14; else reasons.push("weak buy/sell");
  if(ageMin<=cfg.maxAge) score+=18; else reasons.push("too old");
  if(mcap>0 && mcap<=cfg.maxMcap) score+=14; else reasons.push("mcap too high/missing");
  if(pc5>=0) score+=8; else reasons.push("negative 5m");
  if(["meteora","pumpswap","raydium"].includes(p.dexId)) score+=6;
  if(source==="wallet") score+=14;
  if(source==="bitquery") score+=10;
  const c = {
    id:`${source}:${p.pairAddress||p.baseToken?.address||Math.random()}`,
    source, dexId:p.dexId, pairAddress:p.pairAddress, url:p.url,
    baseMint:p.baseToken?.address, symbol:p.baseToken?.symbol, name:p.baseToken?.name,
    fdv:Number(p.fdv||0), marketCap:mcap, liq, vol5, pc5, ageMin, buySell,
    score, accepted: score>=cfg.minScore && reasons.length===0, reasons, raw:p
  };
  if(!c.accepted) state.stats.rejects++; else state.stats.accepted++;
  return c;
}

async function dexSearch(){
  const out=[];
  for(const term of cfg.dexTerms.slice(0,8)){
    try{
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`);
      const j = await r.json();
      const pairs=(j.pairs||[]).filter(p=>p.chainId==="solana").slice(0,10);
      for(const p of pairs) out.push(scorePair(p,"dex"));
      await sleep(80);
    }catch(e){ alert("⚠️","DEX error",e.message); }
  }
  return out;
}

async function dexTokenPairs(mint){
  try{
    const r=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const j=await r.json();
    const pairs=(j.pairs||[]).filter(p=>p.chainId==="solana");
    return pairs.map(p=>scorePair(p,"wallet")).sort((a,b)=>b.score-a.score);
  }catch(e){ return []; }
}

async function quoteRoute(outMint, amountSol){
  const lamports = Math.max(1, Math.floor(amountSol*1e9));
  if(cfg.dflowEnabled && cfg.dflowQuoteUrl){
    try{
      state.stats.dflowQuotes++;
      const r=await fetch(cfg.dflowQuoteUrl,{
        method:"POST",
        headers:{"content-type":"application/json", ...(cfg.dflowApiKey?{"authorization":`Bearer ${cfg.dflowApiKey}`}:{})},
        body:JSON.stringify({inputMint:SOL,outputMint:outMint,amount:lamports,slippageBps:cfg.slippageBps,userPublicKey: wallet?.publicKey?.toBase58()})
      });
      const j=await r.json();
      if(r.ok) return {ok:true, source:"dflow", quote:j, priceImpactPct:Number(j.priceImpactPct||0)};
      return {ok:false, source:"dflow", error:JSON.stringify(j).slice(0,300)};
    }catch(e){ return {ok:false, source:"dflow", error:e.message}; }
  }
  try{
    state.stats.jupiterQuotes++;
    const url=`${cfg.jupQuoteUrl}?inputMint=${SOL}&outputMint=${outMint}&amount=${lamports}&slippageBps=${cfg.slippageBps}`;
    const r=await fetch(url, { headers: cfg.jupApiKey ? {"x-api-key": cfg.jupApiKey} : {} });
    const j=await r.json();
    if(!r.ok || j.error) return {ok:false, source:"jupiter", error:j.error||JSON.stringify(j).slice(0,300)};
    return {ok:true, source:"jupiter", quote:j, priceImpactPct:Number(j.priceImpactPct||0)};
  }catch(e){ return {ok:false, source:"jupiter", error:e.message}; }
}

async function maybeTrade(c, reason="candidate"){
  if(state.panic) return {ok:false, skipped:"panic"};
  if(!c.baseMint) return {ok:false, skipped:"no mint"};
  if(state.positions.length >= cfg.maxOpen) return {ok:false, skipped:"max open"};
  const q=await quoteRoute(c.baseMint, cfg.maxTradeSol);
  if(!q.ok) return {ok:false, skipped:`quote fail ${q.source}: ${q.error}`};
  if(q.priceImpactPct > cfg.maxImpact) return {ok:false, skipped:`impact ${q.priceImpactPct}`};
  const trade={t:now(),symbol:c.symbol,mint:c.baseMint,score:c.score,amountSol:cfg.maxTradeSol,route:q.source,mode:cfg.dryRun?"DRY_RUN":"REAL",reason,url:c.url};
  if(cfg.dryRun || !cfg.auto || !wallet){
    trade.status="SIMULATED";
    state.trades.unshift(trade); state.trades=state.trades.slice(0,80);
    alert("🧪","Simulated trade",`${c.symbol} score ${c.score} via ${q.source}. ${cfg.dryRun?"dryRun=true":""} ${!cfg.auto?"auto=false":""} ${!wallet?"no hot wallet":""}`);
    return {ok:true, simulated:true};
  }
  // Jupiter swap execution; DFlow swap execution is left for configured DFLOW_SWAP_URL only.
  try{
    if(q.source==="dflow") throw new Error("DFlow execution endpoint not configured in this template; quote only unless DFLOW_SWAP_URL implemented.");
    const sr=await fetch(cfg.jupSwapUrl,{method:"POST",headers:{"content-type":"application/json", ...(cfg.jupApiKey?{"x-api-key":cfg.jupApiKey}:{})},body:JSON.stringify({
      quoteResponse:q.quote,userPublicKey:wallet.publicKey.toBase58(),wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:"auto"
    })});
    const sj=await sr.json();
    if(!sr.ok || !sj.swapTransaction) throw new Error(JSON.stringify(sj).slice(0,500));
    const tx=VersionedTransaction.deserialize(Buffer.from(sj.swapTransaction,"base64"));
    tx.sign([wallet]);
    const sig=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:2});
    trade.status="SENT"; trade.signature=sig;
    state.trades.unshift(trade); state.positions.push({...trade, entryAt:Date.now()});
    alert("🚀","REAL trade sent",`${c.symbol} ${cfg.maxTradeSol} SOL\n${sig}`);
    return {ok:true,sig};
  }catch(e){
    trade.status="ERROR"; trade.error=e.message; state.trades.unshift(trade);
    alert("❌","Trade error",e.message);
    return {ok:false,error:e.message};
  }
}

async function scanMarket() {
  logEngine("Scanning for high-velocity candidates...", "SCAN");
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana");
    const data = await res.json();
    
    // RELAXED FILTER: Lowered volume requirements so it actually finds tokens
    const pairs = (data.pairs || []).filter(p => p.chainId === "solana" && p.volume?.m5 > 100);
    
    if (pairs.length === 0) {
      logEngine("No high-volume tokens found yet. Waiting for liquidity...", "INFO");
      return;
    }

    for (const p of pairs.slice(0, 3)) {
      const vol5 = Number(p.volume?.m5 || 1);
      const vol1 = Number(p.volume?.m1 || 0); 
      
      // RELAXED ACCELERATION: Changed 0.4 to 0.1 to catch emerging spikes earlier
      if (vol1 > (vol5 * 0.1)) {
        logEngine(`Candidate Found: ${p.baseToken.symbol}. Auditing with Groq...`, "ALERT");
        const isSafe = await validateWithGroq(p);
        if (isSafe) {
          logEngine(`Groq Cleared ${p.baseToken.symbol}. Logic ready to trade.`, "TRADE");
        } else {
          logEngine(`Groq flagged ${p.baseToken.symbol} as high risk.`, "WARN");
        }
      }
    }
    await checkAndSweepProfits();
  } catch (e) {
    logEngine("Scan Error: " + e.message, "ERROR");
  }
}

function tokenDeltas(tx, owner){
  const pre=tx.meta?.preTokenBalances||[], post=tx.meta?.postTokenBalances||[];
  const map=new Map();
  for(const b of pre){ if(b.owner===owner) map.set(`${b.mint}:${b.accountIndex}`, {mint:b.mint,pre:Number(b.uiTokenAmount?.uiAmount||0),post:0}); }
  for(const b of post){ if(b.owner===owner) {
    const k=`${b.mint}:${b.accountIndex}`;
    const v=map.get(k)||{mint:b.mint,pre:0,post:0}; v.post=Number(b.uiTokenAmount?.uiAmount||0); map.set(k,v);
  }}
  const byMint={};
  for(const v of map.values()){
    const d=v.post-v.pre;
    if(!byMint[v.mint]) byMint[v.mint]=0;
    byMint[v.mint]+=d;
  }
  return Object.entries(byMint).map(([mint,delta])=>({mint,delta})).filter(x=>Math.abs(x.delta)>0);
}

async function pollWallets(){
  if(!cfg.walletWatchEnabled) return;
  state.stats.walletPolls++;
  for(const addr of cfg.watchWallets){
    if(state.walletCooldown[addr] && Date.now() < state.walletCooldown[addr]) continue;
    try{
      const pk=new PublicKey(addr);
      const sigs=await connection.getSignaturesForAddress(pk,{limit:cfg.sigLimit});
      if(!sigs.length) continue;
      if(!state.lastSeen[addr]){
        state.lastSeen[addr]=sigs[0].signature;
        alert("🧊","Wallet bootstrapped",`${addr.slice(0,6)}... latest saved, only new tx after this will process.`);
        continue;
      }
      const idx=sigs.findIndex(s=>s.signature===state.lastSeen[addr]);
      const fresh=(idx===-1?sigs:sigs.slice(0,idx)).reverse();
      if(fresh.length) state.stats.missedCaught += Math.max(0,fresh.length-1);
      for(const s of fresh.slice(0,cfg.sigLimit)){
        const tx=await connection.getParsedTransaction(s.signature,{maxSupportedTransactionVersion:0,commitment:"confirmed"});
        if(!tx?.meta) continue;
        state.stats.txProcessed++;
        const deltas=tokenDeltas(tx, addr).filter(d=>d.mint!==SOL && d.delta>0);
        for(const d of deltas){
          const ev={t:now(),wallet:addr,signature:s.signature,mint:d.mint,amount:d.delta,type:"SWAP_IN"};
          state.walletEvents.unshift(ev); state.walletEvents=state.walletEvents.slice(0,120);
          const enriched=await dexTokenPairs(d.mint);
          const best=enriched[0];
          if(best){ best.source="wallet"; best.score+=12; await maybeTrade(best,"wallet-firehose"); }
          else alert("👁️","Wallet swap detected",`${addr.slice(0,6)} received ${d.mint}\n${s.signature}`);
        }
        await sleep(cfg.rpcMinGapMs);
      }
      if(fresh.length) state.lastSeen[addr]=fresh[fresh.length-1].signature;
    }catch(e){
      const msg=String(e.message || e);
      if(msg.includes("429")){
        state.stats.rpc429++;
        state.walletCooldown[addr]=Date.now()+cfg.rpc429BackoffMs;
        alert("🧯","RPC backoff",`${addr.slice(0,6)}... hit 429. Cooling ${Math.round(cfg.rpc429BackoffMs/1000)}s. Use a private RPC for fast wallet firehose.`);
      } else {
        alert("⚠️","Wallet poll error",`${addr}: ${msg}`);
      }
    }
  }
}

function start(){
  if(state.running) return;
  state.running=true;
  state.scanLoop=setInterval(scan, Math.max(10,cfg.discoverySeconds)*1000);
  if(cfg.walletWatchEnabled && cfg.watchWallets.length) state.walletLoop=setInterval(pollWallets, Math.max(8,cfg.walletPollSeconds)*1000);
  scan().catch(()=>{});
  if(cfg.walletWatchEnabled && cfg.watchWallets.length) pollWallets().catch(()=>{});
  alert("🟢","V16 terminal online",`dry=${cfg.dryRun} auto=${cfg.auto} hot=${!!wallet} dflow=${cfg.dflowEnabled}`);
}
function stop(){
  if(state.scanLoop) clearInterval(state.scanLoop);
  if(state.walletLoop) clearInterval(state.walletLoop);
  state.scanLoop=null; state.walletLoop=null; state.running=false;
}

app.get("/api/status", async (req,res)=>{
  res.json({ok:true,cfg:{dryRun:cfg.dryRun,autoTrading:cfg.auto,panic:state.panic,maxTradeSol:cfg.maxTradeSol,reserveSol:cfg.reserveSol,maxOpen:cfg.maxOpen,minScore:cfg.minScore,dflow:cfg.dflowEnabled,rpc:cfg.rpc,payoutWallet:cfg.payoutWallet||null,hotWallet:wallet?.publicKey?.toBase58()||null,hotBalanceSol:await solBalance().catch(()=>null),watchWallets:cfg.watchWallets.length,walletWatchEnabled:cfg.walletWatchEnabled,jupQuoteUrl:cfg.jupQuoteUrl,rpc429BackoffMs:cfg.rpc429BackoffMs}, state:{startedAt:state.startedAt,running:state.running,panic:state.panic,loops:{scan:!!state.scanLoop,wallet:!!state.walletLoop},stats:state.stats,alerts:state.alerts,candidates:state.candidates.slice(0,20),events:state.walletEvents.slice(0,40),trades:state.trades.slice(0,40),positions:state.positions.slice(0,10),daily:state.daily}});
});
app.post("/api/start",(req,res)=>{ start(); res.json({ok:true}); });
app.post("/api/stop",(req,res)=>{ stop(); res.json({ok:true}); });
app.post("/api/panic",(req,res)=>{ state.panic=true; stop(); alert("🛑","PANIC","Engine stopped"); res.json({ok:true}); });
app.post("/api/resume",(req,res)=>{ state.panic=false; start(); res.json({ok:true}); });
app.post("/api/scan", async (req,res)=>{ await scan(); res.json({ok:true}); });
app.post("/api/poll", async (req,res)=>{ await pollWallets(); res.json({ok:true}); });
app.post("/api/manual-buy", async (req,res)=> {
  const mint=req.body?.mint; if(!mint) return res.status(400).json({ok:false,error:"mint required"});
  const c={baseMint:mint,symbol:req.body.symbol||"MANUAL",score:999,url:"manual",accepted:true,reasons:[]};
  const r=await maybeTrade(c,"manual");
  res.json(r);
});
app.post("/api/payout", async (req,res)=>{
  if(!wallet) return res.status(400).json({ok:false,error:"no hot wallet"});
  if(!cfg.payoutWallet) return res.status(400).json({ok:false,error:"PAYOUT_WALLET missing"});
  const bal=await solBalance();
  const send=Math.max(0, bal-cfg.reserveSol);
  if(send<=0) return res.status(400).json({ok:false,error:"balance below reserve",bal});
  if(cfg.dryRun) return res.json({ok:true,dryRun:true,wouldSendSol:send,to:cfg.payoutWallet});
  const tx=new Transaction().add(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:new PublicKey(cfg.payoutWallet),lamports:Math.floor(send*1e9)}));
  const sig=await connection.sendTransaction(tx,[wallet]);
  alert("💸","Payout sent",`${send} SOL -> ${cfg.payoutWallet}\n${sig}`);
  res.json({ok:true,signature:sig,sendSol:send});
});

const port=Number(env("PORT",8080));
app.listen(port,()=>{ console.log(`V16 RPC Survival Terminal running on ${port}`); if(cfg.autostart) start(); });
