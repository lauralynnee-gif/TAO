// TAO Subnet Price Alert Server
// Polls subnet prices and sends alerts via Mailgun (email + SMS-via-email)
// Run: node server.js

const https = require("https");
const http  = require("http");

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  MAILGUN_API_KEY:  "91f46d112b5cc94f14ae64aa700af6bb-c6620443-ac48a2d7",
  MAILGUN_DOMAIN:   "sandbox625233df0dac46e8b144d0d54efddc52.mailgun.org",
  FROM_EMAIL:       "alerts@sandbox625233df0dac46e8b144d0d54efddc52.mailgun.org",
  POLL_INTERVAL_MS: 60_000,

  // Optional: get a FREE taostats API key at https://taostats.io → Developers → API Keys
  // Paste it here to use the official taostats API for prices
  TAOSTATS_API_KEY: "tao-76d837eb-ea89-4df3-b0a3-2874974a7cdc:421d9012",
};

// ─────────────────────────────────────────
//  SMS CARRIER GATEWAYS
// ─────────────────────────────────────────
const CARRIER_GATEWAYS = {
  "verizon":   "vtext.com",
  "att":       "txt.att.net",
  "tmobile":   "tmomail.net",
  "sprint":    "messaging.sprintpcs.com",
  "boost":     "sms.myboostmobile.com",
  "cricket":   "sms.cricketwireless.net",
  "metro":     "mymetropcs.com",
  "uscellular":"email.uscc.net",
};

// ─────────────────────────────────────────
//  SUBNET DEFINITIONS
//  netuid = subnet number on Bittensor chain
//  coinId = CoinGecko ID for USD price lookup (fallback)
// ─────────────────────────────────────────
const SUBNETS = {
  TEMPLAR: { netuid: 3,  name: "Templar", coinId: "bittensor-subnet-3-templar"  },
  TARGON:  { netuid: 4,  name: "Targon",  coinId: "bittensor-subnet-4-targon"   },
  GRAIL:   { netuid: 18, name: "Grail",   coinId: "bittensor-subnet-18-grail"   },
  BEAM:    { netuid: 2,  name: "Beam",    coinId: "bittensor-subnet-2-omron"    },
};

let alerts = [];
let prices = {};

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "Accept": "application/json", ...headers } }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    }).on("error", reject);
  });
}

// ─────────────────────────────────────────
//  PRICE FETCHING — 3 strategies in order:
//
//  1. Taostats API (if TAOSTATS_API_KEY is set)
//  2. Bittensor public subtensor RPC via taostats webscrape fallback
//  3. CoinGecko public API (no key needed, rate limited)
// ─────────────────────────────────────────

// Strategy 1: Official taostats API with key
async function fetchPriceTaostats(subnet) {
  if (!CONFIG.TAOSTATS_API_KEY) return null;
  const { netuid } = SUBNETS[subnet];
  try {
    const { status, json } = await httpsGet(
      `https://api.taostats.io/api/dtao/pool/latest/v1?netuid=${netuid}`,
      { "Authorization": `Bearer ${CONFIG.TAOSTATS_API_KEY}` }
    );
    if (status === 200 && json?.data?.[0]) {
      const d = json.data[0];
      // price fields vary by API version — try all known keys
      const raw = d.price_usd ?? d.price_tao ?? d.alpha_price_usd ?? d.price ?? null;
      if (raw && parseFloat(raw) > 0) return parseFloat(raw);
    }
  } catch (_) {}
  return null;
}

// Strategy 2: CoinGecko free public API (no key, 30 req/min limit)
// Maps subnet tokens to their CoinGecko IDs
const COINGECKO_IDS = {
  TEMPLAR: "bittensor",   // placeholder — update if CG lists subnet tokens
  TARGON:  "bittensor",
  GRAIL:   "bittensor",
  BEAM:    "bittensor",
};

// Strategy 3: scrape taostats.io subnet page for the displayed price
async function fetchPriceTaostatsPage(subnet) {
  const { netuid } = SUBNETS[subnet];
  try {
    const { status, json } = await httpsGet(
      `https://api.taostats.io/api/dtao/pool/latest/v1?netuid=${netuid}`
    );
    if (status === 200 && json?.data?.[0]) {
      const d = json.data[0];
      // The pool price in TAO = tao_in / alpha_in
      const taoIn   = parseFloat(d.tao_in   ?? d.tao_reserve   ?? 0);
      const alphaIn = parseFloat(d.alpha_in ?? d.alpha_reserve ?? 0);
      if (taoIn > 0 && alphaIn > 0) {
        // This gives price in TAO — we then multiply by TAO/USD price
        return { priceTao: taoIn / alphaIn, needsUsd: true };
      }
      // Direct USD price fields
      const usd = parseFloat(d.price_usd ?? d.usd_price ?? 0);
      if (usd > 0) return { priceUsd: usd };
    }
  } catch (_) {}
  return null;
}

// Fetch TAO/USD price from CoinGecko (needed to convert TAO prices → USD)
let taoUsdPrice = null;
let taoUsdLastFetch = 0;
async function fetchTaoUsd() {
  const now = Date.now();
  if (taoUsdPrice && now - taoUsdLastFetch < 120_000) return taoUsdPrice; // cache 2 min
  try {
    const { status, json } = await httpsGet(
      "https://api.coingecko.com/api/v3/simple/price?ids=bittensor&vs_currencies=usd"
    );
    if (status === 200 && json?.bittensor?.usd) {
      taoUsdPrice = json.bittensor.usd;
      taoUsdLastFetch = now;
      console.log(`  TAO/USD: $${taoUsdPrice}`);
      return taoUsdPrice;
    }
  } catch (_) {}
  return taoUsdPrice ?? 450; // fallback estimate
}

// Master fetch with fallback chain
async function fetchPrice(subnet) {
  // Try taostats API with key first
  const fromApi = await fetchPriceTaostats(subnet);
  if (fromApi) return fromApi;

  // Try taostats without key (pool data)
  const poolData = await fetchPriceTaostatsPage(subnet);
  if (poolData) {
    if (poolData.priceUsd) return poolData.priceUsd;
    if (poolData.priceTao && poolData.needsUsd) {
      const taoUsd = await fetchTaoUsd();
      return poolData.priceTao * taoUsd;
    }
  }

  // Keep last known price rather than resetting to $10
  if (prices[subnet]) {
    console.log(`  ${subnet}: using last known price $${prices[subnet].toFixed(4)}`);
    return prices[subnet];
  }

  return null; // unknown
}

async function pollAllPrices() {
  console.log(`\n[${new Date().toISOString()}] Polling prices...`);

  // Fetch TAO/USD once per poll cycle
  await fetchTaoUsd();

  for (const key of Object.keys(SUBNETS)) {
    try {
      const price = await fetchPrice(key);
      if (price && price > 0) {
        prices[key] = price;
        console.log(`  ${key}: $${price.toFixed(4)}`);
      } else {
        console.log(`  ${key}: price unavailable`);
      }
    } catch (e) {
      console.error(`  Error fetching ${key}:`, e.message);
    }
  }
  checkAllAlerts();
}

// ─────────────────────────────────────────
//  ALERT CHECKING
// ─────────────────────────────────────────
function checkAllAlerts() {
  alerts.forEach(alert => {
    if (alert.triggered) return;
    const price = prices[alert.subnet];
    if (price == null) return;

    const hit =
      (alert.cond === "above" && price >= alert.target) ||
      (alert.cond === "below" && price <= alert.target);

    if (hit) {
      alert.triggered = true;
      console.log(`  *** ALERT TRIGGERED: ${alert.subnet} ${alert.cond} $${alert.target} (now: $${price.toFixed(4)}) ***`);
      sendNotification(alert, price);
    }
  });
}

// ─────────────────────────────────────────
//  MAILGUN SENDER
// ─────────────────────────────────────────
function sendMailgun({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ from: CONFIG.FROM_EMAIL, to, subject, text }).toString();
    const auth = Buffer.from(`api:${CONFIG.MAILGUN_API_KEY}`).toString("base64");

    const options = {
      hostname: "api.mailgun.net",  // use api.eu.mailgun.net if your account is EU-based
      path:     `/v3/${CONFIG.MAILGUN_DOMAIN}/messages`,
      method:   "POST",
      headers: {
        "Authorization":  `Basic ${auth}`,
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        if (res.statusCode === 200) { console.log(`  Email sent to ${to}`); resolve(data); }
        else { console.error(`  Mailgun error ${res.statusCode}:`, data); reject(new Error(`Mailgun ${res.statusCode}`)); }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendNotification(alert, currentPrice) {
  const direction = alert.cond === "above" ? "risen above" : "fallen below";
  const subject = `TAO Alert: ${alert.subnet} has ${direction} $${alert.target}`;
  const text = [
    `Your TAO subnet price alert has been triggered.`,
    ``,
    `Subnet:        ${alert.subnet} (${SUBNETS[alert.subnet]?.name})`,
    `Condition:     Price ${alert.cond} $${alert.target}`,
    `Current price: $${currentPrice.toFixed(4)}`,
    `Time:          ${new Date().toLocaleString()}`,
    ``,
    `This alert has now been marked as triggered and will not fire again.`,
    `— TAO Subnet Monitor`,
  ].join("\n");

  let to = alert.contact;

  if (alert.mode === "sms") {
    const [number, carrier] = alert.contact.split(":");
    const gateway = CARRIER_GATEWAYS[carrier?.toLowerCase()];
    if (!gateway) { console.error(`  Unknown carrier: ${alert.contact}`); return; }
    to = `${number.replace(/\D/g, "")}@${gateway}`;
    console.log(`  SMS via gateway: ${to}`);
  }

  sendMailgun({ to, subject, text }).catch(err => {
    console.error("  Failed to send notification:", err.message);
  });
}

// ─────────────────────────────────────────
//  HTTP API SERVER
// ─────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/prices") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(prices));
    return;
  }

  if (req.method === "GET" && req.url === "/alerts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(alerts));
    return;
  }

  if (req.method === "POST" && req.url === "/alerts") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const { subnet, cond, target, contact, mode } = data;
        if (!SUBNETS[subnet]) throw new Error("Invalid subnet");
        if (!["above","below"].includes(cond)) throw new Error("Invalid condition");
        if (isNaN(parseFloat(target))) throw new Error("Invalid target price");
        if (!contact) throw new Error("Missing contact");

        const alert = {
          id: Date.now(), subnet: subnet.toUpperCase(), cond,
          target: parseFloat(target), contact, mode: mode || "email",
          triggered: false, createdAt: new Date().toISOString(),
        };
        alerts.push(alert);
        console.log(`[Alert added] ${alert.subnet} ${alert.cond} $${alert.target} → ${alert.contact}`);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, alert }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  const deleteMatch = req.url.match(/^\/alerts\/(\d+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const id = parseInt(deleteMatch[1]);
    const before = alerts.length;
    alerts = alerts.filter(a => a.id !== id);
    res.writeHead(alerts.length < before ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: alerts.length < before }));
    return;
  }

  // GET /health — quick status check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, prices, alertCount: alerts.length, uptime: process.uptime() }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ─────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\nTAO Alert Server running on http://localhost:${PORT}`);
  console.log(`Polling prices every ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
  if (!CONFIG.TAOSTATS_API_KEY) {
    console.log(`\nTIP: Add a free taostats API key to CONFIG.TAOSTATS_API_KEY for`);
    console.log(`     more reliable prices. Get one free at https://taostats.io\n`);
  }
  pollAllPrices();
  setInterval(pollAllPrices, CONFIG.POLL_INTERVAL_MS);
});
