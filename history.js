import { filterEvents } from "./notify-prefs.js";

const BUY = new Set(["buy", "long", "b", "покупка"]);
const SELL = new Set(["sell", "short", "s", "продажа"]);

export const HISTORY_LIMIT = 1000;

export function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function lotsOf(value) {
  const n = finite(value);
  if (n == null || n === 0) return null;
  return Math.abs(n);
}

export function isShort(item) {
  const type = String(item?.type || "").toLowerCase();
  if (type === "short") return true;
  if (type === "long") return false;
  const n = finite(item?.position);
  return n != null && n < 0;
}

export function money(value) {
  const n = finite(value);
  if (n == null || n === 0) return null;
  const text = `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ₽`;
  return { text, negative: n < 0 };
}

export function formatLots(value) {
  const n = finite(value);
  if (n == null) return null;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Math.abs(n));
}

export function formatPlain(value) {
  const n = finite(value);
  if (n == null) return null;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(n);
}

export function orderSide(direction) {
  const value = String(direction ?? "").trim().toLowerCase();
  if (BUY.has(value)) return "buy";
  if (SELL.has(value)) return "sell";
  return null;
}

export function ordersOf(item) {
  return Array.isArray(item?.orders) ? item.orders.filter((order) => order && typeof order === "object") : [];
}

export function sortOrders(orders) {
  return orders
    .map((order, index) => ({ order, index }))
    .sort((left, right) => {
      const leftPrice = finite(left.order.price);
      const rightPrice = finite(right.order.price);
      if (leftPrice == null && rightPrice == null) return left.index - right.index;
      if (leftPrice == null) return 1;
      if (rightPrice == null) return -1;
      if (leftPrice !== rightPrice) return leftPrice - rightPrice;
      return left.index - right.index;
    })
    .map((entry) => entry.order);
}

function orderCount(item) {
  const count = finite(item?.orderCount);
  if (count != null) return count;
  const listed = ordersOf(item).length;
  return listed > 0 ? listed : null;
}

function moneyMark(icon, field, item) {
  const value = money(item?.[field]);
  return {
    icon,
    tone: value ? (value.negative ? "down" : "up") : null,
    value: value ? value.text : "",
    label: value ? value.text : "",
  };
}

function marksForChange(event) {
  const marks = [];
  for (const name of event.changes || []) {
    if (name === "type") {
      const short = isShort(event.item);
      marks.push({
        icon: short ? "down" : "up",
        tone: short ? "down" : "up",
        value: "",
        label: short ? "Короткая" : "Длинная",
      });
    } else if (name === "position") {
      const lots = lotsOf(event.item?.position);
      const text = lots == null ? "" : formatLots(lots);
      marks.push({ icon: "lots", tone: null, value: text || "", label: text ? `Объём ${text}` : "Объём" });
    } else if (name === "openedFinancialResult") {
      marks.push(moneyMark("result", "openedFinancialResult", event.item));
    } else if (name === "expectedFinancialResult") {
      marks.push(moneyMark("session", "expectedFinancialResult", event.item));
    } else if (name === "commission") {
      marks.push(moneyMark("fee", "commission", event.item));
    } else if (name === "orders") {
      const count = orderCount(event.item);
      const text = count == null ? "" : String(count);
      marks.push({ icon: "list", tone: null, value: text, label: text ? `Заявки ${text}` : "Заявки" });
    }
  }
  return marks;
}

export function historyEntry(event, at) {
  let marks = [];
  if (event.kind === "opened") marks = [{ icon: "up", tone: "up", value: "", label: "Появилась" }];
  else if (event.kind === "closed") marks = [{ icon: "down", tone: "down", value: "", label: "Исчезла" }];
  else marks = marksForChange(event);
  return { at, tool: event.tool, marks };
}

export function rememberHistory(history, events, at) {
  for (const event of events) history.unshift({ at, event });
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
}

export function visibleHistory(history, prefs) {
  const stored = [];
  for (const entry of history || []) {
    if (!entry?.event) continue;
    stored.push({ ...entry.event, at: entry.at });
  }
  return filterEvents(stored, prefs).map((event) => historyEntry(event, event.at));
}
