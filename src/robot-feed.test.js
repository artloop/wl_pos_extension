import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSockjs,
  encodeSockjs,
  parseStomp,
  parseTickers,
  robotBanner,
  sockjsWebsocketUrl,
  stompFrame,
  stripHtml,
  takeRobotFrame,
  watchedRobots,
} from "./robot-feed.js";

test("parseTickers splits and uppercases", () => {
  assert.deepEqual([...parseTickers(" sber, gazp\nSBER ")], ["SBER", "GAZP"]);
  assert.equal(parseTickers("").size, 0);
});

test("stripHtml keeps the lot text", () => {
  assert.equal(stripHtml("Лот: <b>27 - 29</b>, период <b>18</b> сек."), "Лот: 27 - 29, период 18 сек.");
});

test("first frame is a baseline", () => {
  const frame = takeRobotFrame(
    { ready: false, known: {} },
    [{ eventType: "INSERT", rowId: "a", title: "MTSS", type: "SIMPLE_MOEX_STOCKS", operationType: "SELL", text: "x" }],
    parseTickers("MTSS"),
    false
  );
  assert.equal(frame.ready, true);
  assert.deepEqual(frame.alerts, []);
  assert.equal(frame.known.a.title, "MTSS");
});

test("later insert on a watched ticker alerts", () => {
  const frame = takeRobotFrame(
    { ready: true, known: {} },
    [{ eventType: "INSERT", rowId: "b", title: "phor", type: "SIMPLE_MOEX_STOCKS", operationType: "SELL", text: "<b>3</b>" }],
    parseTickers("PHOR"),
    false
  );
  assert.equal(frame.alerts.length, 1);
  assert.equal(frame.alerts[0].kind, "new");
  assert.equal(frame.alerts[0].text, "3");
});

test("quiet hours and unknown tickers stay silent", () => {
  const item = { eventType: "INSERT", rowId: "c", title: "SBER", type: "SIMPLE_MOEX_STOCKS", operationType: "BUY", text: "" };
  assert.equal(takeRobotFrame({ ready: true, known: {} }, [item], parseTickers("SBER"), true).alerts.length, 0);
  assert.equal(takeRobotFrame({ ready: true, known: {} }, [item], parseTickers("GAZP"), false).alerts.length, 0);
});

test("delete of a known watched robot alerts", () => {
  const known = { a: { rowId: "a", title: "MTSS", market: "SIMPLE_MOEX_STOCKS", side: "SELL", text: "лот" } };
  const frame = takeRobotFrame({ ready: true, known }, [{ eventType: "DELETE", rowId: "a" }], parseTickers("MTSS"), false);
  assert.equal(frame.alerts[0].kind, "gone");
  assert.equal(frame.known.a, undefined);
  assert.match(robotBanner(frame.alerts[0]), /робот ушёл/);
});

test("watched list keeps selected tickers in market order", () => {
  const known = {
    b: { rowId: "b", title: "CRH7", market: "SIMPLE_MOEX_FUTURES", side: "BUY", text: "лот 4" },
    a: { rowId: "a", title: "mtss", market: "SIMPLE_MOEX_STOCKS", side: "SELL", text: "лот 27" },
    c: { rowId: "c", title: "SBER", market: "SIMPLE_MOEX_STOCKS", side: "BUY", text: "" },
  };
  const rows = watchedRobots(known, parseTickers("MTSS, CRH7"));
  assert.deepEqual(rows.map((row) => row.title), ["mtss", "CRH7"]);
  assert.equal(rows[0].text, "лот 27");
});

test("sockjs and stomp frames round-trip", () => {
  const raw = stompFrame("SUBSCRIBE", { id: "robots", destination: "/app/notifications/all" });
  const decoded = decodeSockjs(`a${encodeSockjs(raw)}`);
  assert.equal(decoded[0].type, "message");
  const stomp = parseStomp(decoded[0].body);
  assert.equal(stomp.command, "SUBSCRIBE");
  assert.equal(stomp.headers.destination, "/app/notifications/all");
  assert.equal(decodeSockjs("o")[0].type, "open");
  assert.match(sockjsWebsocketUrl("https://screener.aniscan.ru/ws"), /^wss:\/\/screener\.aniscan\.ru\/ws\/\d{3}\/[a-z0-9]{8}\/websocket$/);
});
