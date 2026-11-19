import { notifyEnabled } from "./notify-prefs.js";

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

const MONEY_FIELDS = [
  ["openedFinancialResult", "result", "Открытый результат"],
  ["expectedFinancialResult", "session", "За сессию"],
  ["commission", "fee", "Комиссия"],
];

function lotsLabel(value) {
  const n = finite(value);
  if (n == null) return "—";
  if (n === 0) return "0";
  return formatLots(n);
}

function moneyLabel(value) {
  const n = finite(value);
  if (n == null) return "—";
  const text = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return `${text} ₽`;
}

function knownShort(item) {
  const type = String(item?.type || "").toLowerCase();
  if (type === "short") return true;
  if (type === "long") return false;
  const n = finite(item?.position);
  if (n != null && n !== 0) return n < 0;
  return null;
}

function sideItem(before, after) {
  if (lotsOf(after?.position) != null) return after;
  if (lotsOf(before?.position) != null) return before;
  if (after?.type) return after;
  return before;
}

function positionMark(before, after) {
  const short = knownShort(sideItem(before, after));
  const value = `${lotsLabel(before?.position)} → ${lotsLabel(after?.position)}`;
  return {
    icon: short == null ? "lots" : short ? "down" : "up",
    tone: short == null ? null : short ? "down" : "up",
    value,
    label: `Объём ${value}`,
  };
}

function moneyDeltaMark(icon, title, before, after) {
  const left = moneyLabel(before);
  const right = moneyLabel(after);
  const next = finite(after);
  const prev = finite(before);
  const toneSource = next != null && next !== 0 ? next : prev;
  return {
    icon,
    tone: toneSource == null || toneSource === 0 ? null : toneSource < 0 ? "down" : "up",
    value: `${left} → ${right}`,
    label: `${title} ${left} → ${right}`,
  };
}

function fieldMarks(before, after, names) {
  const marks = [];
  if (names.includes("type") && !names.includes("position")) {
    const short = knownShort(after);
    marks.push({
      icon: short == null ? "lots" : short ? "down" : "up",
      tone: short == null ? null : short ? "down" : "up",
      value: "",
      label: short == null ? "Направление" : short ? "Короткая" : "Длинная",
    });
  }
  if (names.includes("position")) marks.push(positionMark(before, after));
  for (const [field, icon, title] of MONEY_FIELDS) {
    if (names.includes(field)) marks.push(moneyDeltaMark(icon, title, before?.[field], after?.[field]));
  }
  return marks;
}

function orderId(order) {
  const number = order?.orderNumber;
  if (number == null || String(number) === "") return null;
  return String(number);
}

function orderSignature(order) {
  return [order?.direction, order?.lots, order?.price == null ? null : String(order.price)].join("|");
}

function pairOrders(beforeList, afterList) {
  const before = ordersOf({ orders: beforeList });
  const after = ordersOf({ orders: afterList });
  const consumed = new Set();
  const removed = [];
  const changed = [];
  const afterByNumber = new Map();
  after.forEach((order, index) => {
    const id = orderId(order);
    if (id != null && !afterByNumber.has(id)) afterByNumber.set(id, index);
  });
  for (const order of before) {
    const id = orderId(order);
    let index = id != null ? afterByNumber.get(id) : undefined;
    if (index != null && consumed.has(index)) index = undefined;
    if (index == null && id == null) {
      const found = after.findIndex(
        (candidate, candidateIndex) =>
          !consumed.has(candidateIndex) && orderId(candidate) == null && orderSignature(candidate) === orderSignature(order)
      );
      if (found >= 0) index = found;
    }
    if (index == null) {
      removed.push(order);
      continue;
    }
    consumed.add(index);
    const next = after[index];
    if (orderSignature(order) !== orderSignature(next)) changed.push([order, next]);
  }
  return { removed, added: after.filter((_, index) => !consumed.has(index)), changed };
}

function sideWord(side) {
  if (side === "buy") return "покупка";
  if (side === "sell") return "продажа";
  return "";
}

function sideIcon(side) {
  if (side === "buy") return { icon: "up", tone: "up", label: "Покупка", badge: true };
  if (side === "sell") return { icon: "down", tone: "down", label: "Продажа", badge: true };
  return null;
}

function actionIcon(action) {
  if (action === "added") return { icon: "plus", tone: "up", label: "Выставлена" };
  if (action === "removed") return { icon: "minus", tone: "down", label: "Снята" };
  return null;
}

function orderAmount(order) {
  const side = orderSide(order?.direction);
  const lots = formatLots(order?.lots);
  const price = formatPlain(order?.price);
  const bits = [];
  if (!side) {
    const raw = String(order?.direction ?? "").trim();
    if (raw) bits.push(raw);
  }
  if (lots) bits.push(lots);
  if (price) bits.push(`@ ${price}`);
  return bits.join(" ");
}

function orderMark(action, side, value) {
  const icons = [];
  const actionPart = actionIcon(action);
  const sidePart = sideIcon(side);
  if (actionPart) icons.push(actionPart);
  if (sidePart) icons.push(sidePart);
  const tone = action === "added" ? "up" : action === "removed" ? "down" : null;
  const actionText = action === "added" ? "Выставлена" : action === "removed" ? "Снята" : "";
  const label = [actionText, sideWord(side), value].filter(Boolean).join(" ");
  return { kind: "order", icons, tone, value, label };
}

function orderChangeMark(before, after) {
  const leftSide = orderSide(before?.direction);
  const rightSide = orderSide(after?.direction);
  const leftAmount = orderAmount(before);
  const rightAmount = orderAmount(after);
  const sameLots = String(before?.lots) === String(after?.lots);
  const leftPrice = formatPlain(before?.price);
  const rightPrice = formatPlain(after?.price);
  const value =
    leftSide && leftSide === rightSide && sameLots && leftPrice && rightPrice
      ? `${leftAmount} → ${rightPrice}`
      : [leftAmount, rightAmount].filter(Boolean).join(" → ");
  const icons = [];
  if (leftSide && rightSide && leftSide !== rightSide) {
    icons.push(sideIcon(leftSide), sideIcon(rightSide));
  } else {
    const one = sideIcon(rightSide || leftSide);
    if (one) icons.push(one);
  }
  const label = [sideWord(leftSide), leftAmount, "→", sideWord(rightSide), rightAmount].filter(Boolean).join(" ");
  return { kind: "order", icons, tone: null, value, label };
}

function lotLabel(item) {
  const count = finite(item?.orderCount);
  return count == null ? null : String(count);
}

function orderDeltaRows(at, tool, before, after) {
  const { removed, added, changed } = pairOrders(before?.orders, after?.orders);
  const rows = [];
  for (const order of sortOrders(removed)) {
    rows.push({ at, tool, marks: [orderMark("removed", orderSide(order.direction), orderAmount(order))] });
  }
  changed.sort((left, right) => {
    const leftPrice = finite(left[0]?.price);
    const rightPrice = finite(right[0]?.price);
    if (leftPrice == null && rightPrice == null) return 0;
    if (leftPrice == null) return 1;
    if (rightPrice == null) return -1;
    return leftPrice - rightPrice;
  });
  for (const [left, right] of changed) {
    rows.push({ at, tool, marks: [orderChangeMark(left, right)] });
  }
  for (const order of sortOrders(added)) {
    rows.push({ at, tool, marks: [orderMark("added", orderSide(order.direction), orderAmount(order))] });
  }
  if (!removed.length && !added.length && !changed.length) {
    const from = lotLabel(before);
    const to = lotLabel(after);
    if ((from != null || to != null) && from !== to) {
      const fromText = from ?? "0";
      const toText = to ?? "0";
      const fromN = Number(fromText);
      const toN = Number(toText);
      const tone = toN > fromN ? "up" : toN < fromN ? "down" : null;
      const value = `лотов ${fromText} → ${toText}`;
      rows.push({
        at,
        tool,
        marks: [{ kind: "order", icon: "list", tone, value, label: `Лотов ${fromText} → ${toText}` }],
      });
    }
  }
  return rows;
}

function markedRow(at, tool, marks) {
  return marks.length ? [{ at, tool, marks }] : [];
}

export function historyRows(event, at, prefs) {
  const allow = (id) => notifyEnabled(prefs, id);
  if (!event || typeof event.tool !== "string") return [];
  if (event.kind === "opened") {
    const rows = [];
    if (allow("opened")) rows.push(...markedRow(at, event.tool, fieldMarks({ position: 0, type: event.item?.type }, event.item, ["position"])));
    if (allow("orders")) rows.push(...orderDeltaRows(at, event.tool, { orderCount: 0, orders: [] }, event.item));
    return rows;
  }
  if (event.kind === "closed") {
    const rows = [];
    if (allow("closed")) {
      rows.push(...markedRow(at, event.tool, fieldMarks(event.item, { position: 0, type: event.item?.type }, ["position"])));
    }
    if (allow("orders")) rows.push(...orderDeltaRows(at, event.tool, event.item, { orderCount: 0, orders: [] }));
    return rows;
  }
  if (event.kind !== "changed") return [];
  const names = (event.changes || []).filter((name) => name !== "orders" && allow(name));
  const rows = markedRow(at, event.tool, fieldMarks(event.previous, event.item, names));
  if ((event.changes || []).includes("orders") && allow("orders")) rows.push(...orderDeltaRows(at, event.tool, event.previous, event.item));
  return rows;
}

export function restoreHistory(stored) {
  if (!Array.isArray(stored)) return [];
  const entries = [];
  for (const entry of stored) {
    if (!entry?.event || typeof entry.at !== "number") continue;
    entries.push({ at: entry.at, event: entry.event });
    if (entries.length >= HISTORY_LIMIT) break;
  }
  return entries;
}

export function rememberHistory(history, events, at) {
  for (const event of events) history.unshift({ at, event });
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
}

export function visibleHistory(history, prefs) {
  const rows = [];
  for (const entry of history || []) {
    if (!entry?.event) continue;
    rows.push(...historyRows(entry.event, entry.at, prefs));
  }
  return rows;
}
