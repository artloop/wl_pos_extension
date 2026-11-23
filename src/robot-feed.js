const MARKETS = {
  SIMPLE_MOEX_STOCKS: "акции",
  SIMPLE_MOEX_FUTURES: "фьючерсы",
  SIMPLE_MOEX_CURRENCY: "валюта",
};

export function parseTickers(value) {
  const found = new Set();
  for (const part of String(value || "").split(/[\s,;]+/)) {
    const ticker = part.trim().toUpperCase();
    if (ticker) found.add(ticker);
  }
  return found;
}

export function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sideWord(operationType) {
  if (operationType === "BUY") return "покупка";
  if (operationType === "SELL") return "продажа";
  return "";
}

export function marketWord(type) {
  return MARKETS[type] || "";
}

function recordOf(item) {
  return {
    rowId: item.rowId,
    title: String(item.title || "").trim(),
    market: item.type || "",
    side: item.operationType || "",
    text: stripHtml(item.text),
  };
}

export function takeRobotFrame(state, notifications, tickers, quiet) {
  const ready = Boolean(state?.ready);
  const previous = state?.known && typeof state.known === "object" ? state.known : {};
  const items = Array.isArray(notifications) ? notifications : [];
  if (!ready) {
    const known = {};
    for (const item of items) {
      if (item?.eventType !== "INSERT" || !item.rowId) continue;
      known[item.rowId] = recordOf(item);
    }
    return { ready: true, known, alerts: [] };
  }
  const known = { ...previous };
  const alerts = [];
  for (const item of items) {
    if (!item?.rowId) continue;
    if (item.eventType === "DELETE") {
      const prior = known[item.rowId];
      delete known[item.rowId];
      if (prior && tickers.has(prior.title.toUpperCase()) && !quiet) {
        alerts.push({ kind: "gone", ...prior });
      }
      continue;
    }
    if (item.eventType !== "INSERT") continue;
    const next = recordOf(item);
    const seen = known[item.rowId];
    known[item.rowId] = next;
    if (!seen && tickers.has(next.title.toUpperCase()) && !quiet) {
      alerts.push({ kind: "new", ...next });
    }
  }
  return { ready: true, known, alerts };
}

const MARKET_ORDER = ["SIMPLE_MOEX_STOCKS", "SIMPLE_MOEX_FUTURES", "SIMPLE_MOEX_CURRENCY"];

export function watchedRobots(known, tickers) {
  const rows = [];
  const source = known && typeof known === "object" ? known : {};
  for (const record of Object.values(source)) {
    const title = String(record?.title || "").trim();
    if (!title || !tickers.has(title.toUpperCase())) continue;
    rows.push({
      rowId: record.rowId,
      title,
      market: record.market || "",
      side: record.side || "",
      text: record.text || "",
    });
  }
  rows.sort((left, right) => {
    const market = marketRank(left.market) - marketRank(right.market);
    if (market) return market;
    const name = left.title.localeCompare(right.title, "ru");
    if (name) return name;
    return String(left.rowId).localeCompare(String(right.rowId));
  });
  return rows;
}

function marketRank(market) {
  const index = MARKET_ORDER.indexOf(market);
  return index === -1 ? MARKET_ORDER.length : index;
}

export function robotBanner(alert) {
  const side = sideWord(alert.side);
  const market = marketWord(alert.market);
  const bits = [side, alert.text, market].filter(Boolean);
  if (alert.kind === "gone") bits.unshift("робот ушёл");
  return bits.join(", ") || alert.title;
}

export function sockjsWebsocketUrl(httpUrl) {
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const server = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let session = "";
  for (let index = 0; index < 8; index += 1) {
    session += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const base = parsed.href.replace(/\/$/, "");
  return `${base}/${server}/${session}/websocket`;
}

export function encodeSockjs(payload) {
  return JSON.stringify([payload]);
}

export function decodeSockjs(data) {
  if (typeof data !== "string" || !data) return [];
  const type = data[0];
  if (type === "o") return [{ type: "open" }];
  if (type === "h") return [{ type: "heartbeat" }];
  if (type === "c") return [{ type: "close" }];
  if (type !== "a") return [];
  const messages = JSON.parse(data.slice(1));
  if (!Array.isArray(messages)) return [];
  return messages.map((body) => ({ type: "message", body: String(body) }));
}

export function stompFrame(command, headers) {
  const lines = [command];
  for (const [key, value] of Object.entries(headers || {})) lines.push(`${key}:${value}`);
  return `${lines.join("\n")}\n\n\0`;
}

export function parseStomp(frame) {
  const cleaned = String(frame || "").replace(/\0$/, "");
  const splitAt = cleaned.indexOf("\n\n");
  const head = splitAt === -1 ? cleaned : cleaned.slice(0, splitAt);
  const body = splitAt === -1 ? "" : cleaned.slice(splitAt + 2);
  const lines = head.split("\n");
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index)] = line.slice(index + 1);
  }
  return { command: lines[0] || "", headers, body };
}
