const MARKETS = ["stock", "futures", "currency"];

const MARKET_TITLE = {
  stock: "Акции",
  futures: "Фьючерсы",
  currency: "Валюта",
};

const FIELD_TITLE = {
  type: "направление",
  position: "объём",
  expectedFinancialResult: "ожидаемый результат",
  openedFinancialResult: "открытый результат",
  commission: "комиссия",
  orders: "заявки",
};

function indexPositions(snapshot) {
  const indexed = new Map();
  if (!snapshot) return indexed;
  for (const market of MARKETS) {
    const items = Array.isArray(snapshot[market]) ? snapshot[market] : [];
    for (const item of items) {
      if (item && typeof item.tool === "string" && item.tool) {
        indexed.set(`${market}\n${item.tool}`, { market, item });
      }
    }
  }
  return indexed;
}

function ordersOf(item) {
  return Array.isArray(item.orders) ? item.orders.filter((order) => order && typeof order === "object") : [];
}

function orderKey(order) {
  return [order.orderNumber, order.direction, order.lots, order.price == null ? null : String(order.price)].join("|");
}

function same(left, right) {
  if (left == null && right == null) return true;
  return String(left) === String(right);
}

export function diffPositions(previous, current) {
  const oldPositions = indexPositions(previous);
  const newPositions = indexPositions(current);
  const events = [];

  for (const [key, value] of newPositions) {
    if (!oldPositions.has(key)) {
      events.push({ kind: "opened", market: value.market, tool: value.item.tool, item: value.item });
    }
  }
  for (const [key, value] of oldPositions) {
    if (!newPositions.has(key)) {
      events.push({ kind: "closed", market: value.market, tool: value.item.tool, item: value.item });
    }
  }
  for (const [key, value] of newPositions) {
    if (!oldPositions.has(key)) continue;
    const before = oldPositions.get(key).item;
    const after = value.item;
    const changes = [];
    if (!same(before.type, after.type)) changes.push("type");
    if (!same(before.position, after.position)) changes.push("position");
    for (const field of ["expectedFinancialResult", "openedFinancialResult", "commission"]) {
      if (!same(before[field], after[field])) changes.push(field);
    }
    const beforeOrders = ordersOf(before).map(orderKey).sort();
    const afterOrders = ordersOf(after).map(orderKey).sort();
    if (before.orderCount !== after.orderCount || beforeOrders.join("||") !== afterOrders.join("||")) {
      changes.push("orders");
    }
    if (changes.length) {
      events.push({
        kind: "changed",
        market: value.market,
        tool: after.tool,
        changes,
        previous: before,
        item: after,
      });
    }
  }
  return events;
}

function valueOf(item, field) {
  const value = item[field];
  return value == null || value === "" ? "—" : String(value);
}

function renderEvent(event) {
  const header = `${MARKET_TITLE[event.market] || event.market} · ${event.tool}`;
  if (event.kind === "opened") {
    return [
      header,
      `Позиция появилась: ${valueOf(event.item, "type")}, объём ${valueOf(event.item, "position")}`,
      `Ожидаемый результат: ${valueOf(event.item, "expectedFinancialResult")}`,
      `Заявок: ${valueOf(event.item, "orderCount")}`,
    ].join("\n");
  }
  if (event.kind === "closed") {
    return `${header}\nПозиция исчезла (было ${valueOf(event.item, "type")}, объём ${valueOf(event.item, "position")})`;
  }
  const titles = event.changes.map((name) => FIELD_TITLE[name] || name);
  const lines = [header, `Изменилось: ${titles.join(", ")}`];
  for (const field of event.changes) {
    if (field === "orders") {
      lines.push(`Заявок: ${valueOf(event.previous, "orderCount")} → ${valueOf(event.item, "orderCount")}`);
      continue;
    }
    lines.push(`${FIELD_TITLE[field] || field}: ${valueOf(event.previous, field)} → ${valueOf(event.item, field)}`);
  }
  return lines.join("\n");
}

export function renderMessages(events) {
  return events.map(renderEvent);
}
