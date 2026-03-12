// TAO Subnet Price Alert Server
// Polls subnet prices and sends alerts via Mailgun (email + SMS-via-email)
// Run: node server.js

const https = require("https");
const http = require("http");

// ─────────────────────────────────────────
//  CONFIG — fill these in before running
// ─────────────────────────────────────────
const CONFIG = {
  MAILGUN_API_KEY: "91f46d112b5cc94f14ae64aa700af6bb-c6620443-ac48a2d7",
  MAILGUN_DOMAIN:  "sandbox625233df0dac46e8b144d0d54efddc52.mailgun.org",
  FROM_EMAIL:      "alerts@sandbox625233df0dac46e8b144d0d54efddc52.mailgun.org",
  POLL_INTERVAL_MS: 60_000,                      // how often to check prices (ms) — 60s default
};

// ─────────────────────────────────────────
//  SMS CARRIER GATEWAYS
//  Format: number@gateway  e.g. 5551234567@vtext.com
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
//  Using TAO subnet IDs — prices fetched from taostats.io API
// ─────────────────────────────────────────
const SUBNETS = {
  TEMPLAR: { netuid: 3,  name: "Templar" },
  TARGON:  { netuid: 4,  name: "Targon"  },
  GRAIL:   { netuid: 18, name: "Grail"   },
  BEAM:    { netuid: 2,  name: "Beam"    },
};

// ─────────────────────────────────────────
//  IN-MEMORY ALERT STORE
//  Alerts POSTed from the dashboard land here
// ─────────────────────────────────────────
let alerts = [];   // { id, subnet, cond, target, contact, mode, triggered }
let prices = {};   // { TEMPLAR: 11.42, ... }

// ─────────────────────────────────────────
//  PRICE FETCHING
//  Tries taostats.io public API; falls back to
//  a simulated price for local testing
// ─────────────────────────────────────────
function fetchPrice(subnet) {
  return new Promise((resolve) => {
    const { netuid } = SUBNETS[subnet];
    const url = `https://api.taostats.io/api/dtao/pool/latest/v1?netuid=${netuid}`;

    https.get(url, { headers: { "Accept": "application/json" } }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          // taostats returns price in the pool data
          const price = parseFloat(
            json?.data?.[0]?.price_tao ?? json?.data?.[0]?.price ?? 0
          );
          if (price > 0) return resolve(price);
        } catch (_) {}
        // fallback: keep last known or use seed
        resolve(prices[subnet] || SUBNETS[subnet].seedPrice || 10.00);
      });
    }).on("error", () => {
      resolve(prices[subnet] || 10.00);
    });
  });
}

async function pollAllPrices() {
  console.log(`[${new Date().toISOString()}] Polling prices...`);
  for (const key of Object.keys(SUBNETS)) {
    try {
      prices[key] = await fetchPrice(key);
      console.log(`  ${key}: $${prices[key].toFixed(4)}`);
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
      console.log(`  ALERT TRIGGERED: ${alert.subnet} ${alert.cond} $${alert.target} (current: $${price.toFixed(4)})`);
      sendNotification(alert, price);
    }
  });
}

// ─────────────────────────────────────────
//  MAILGUN SENDER
// ─────────────────────────────────────────
function sendMailgun({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      from:    CONFIG.FROM_EMAIL,
      to,
      subject,
      text,
    }).toString();

    const auth = Buffer.from(`api:${CONFIG.MAILGUN_API_KEY}`).toString("base64");

    // Mailgun API region: use api.eu.mailgun.net if your account is EU-based
    const options = {
      hostname: "api.mailgun.net",
      path:     `/v3/${CONFIG.MAILGUN_DOMAIN}/messages`,
      method:   "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type":  "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log(`  Sent to ${to}`);
          resolve(data);
        } else {
          console.error(`  Mailgun error ${res.statusCode}:`, data);
          reject(new Error(`Mailgun ${res.statusCode}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendNotification(alert, currentPrice) {
  const direction = alert.cond === "above" ? "risen above" : "fallen below";
  const subject   = `TAO Alert: ${alert.subnet} has ${direction} $${alert.target}`;
  const text      = [
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

  // SMS mode: convert phone number to carrier email gateway
  if (alert.mode === "sms") {
    // contact format expected: "5551234567:verizon"
    const [number, carrier] = alert.contact.split(":");
    const gateway = CARRIER_GATEWAYS[carrier?.toLowerCase()];
    if (!gateway) {
      console.error(`  Unknown carrier for SMS: ${alert.contact}`);
      return;
    }
    to = `${number.replace(/\D/g, "")}@${gateway}`;
    console.log(`  SMS via email gateway: ${to}`);
  }

  sendMailgun({ to, subject, text }).catch(err => {
    console.error("  Failed to send notification:", err.message);
  });
}

// ─────────────────────────────────────────
//  HTTP API SERVER
//  The dashboard POSTs alerts here
// ─────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  // GET /prices — current prices
  if (req.method === "GET" && req.url === "/prices") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(prices));
    return;
  }

  // GET /alerts — list active alerts
  if (req.method === "GET" && req.url === "/alerts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(alerts));
    return;
  }

  // POST /alerts — add a new alert
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
          id:        Date.now(),
          subnet:    subnet.toUpperCase(),
          cond,
          target:    parseFloat(target),
          contact,
          mode:      mode || "email",
          triggered: false,
          createdAt: new Date().toISOString(),
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

  // DELETE /alerts/:id — remove an alert
  const deleteMatch = req.url.match(/^\/alerts\/(\d+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const id = parseInt(deleteMatch[1]);
    const before = alerts.length;
    alerts = alerts.filter(a => a.id !== id);
    const removed = alerts.length < before;
    res.writeHead(removed ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: removed }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ─────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`TAO Alert Server running on http://localhost:${PORT}`);
  console.log(`Polling prices every ${CONFIG.POLL_INTERVAL_MS / 1000}s\n`);
  pollAllPrices();
  setInterval(pollAllPrices, CONFIG.POLL_INTERVAL_MS);
});
