// if-node-test.js — bisect IF filter behavior
// Usage: node if-node-test.js <variant>
//   lit-eq    : literal "callback" == "callback"          (expect TRUE)
//   lit-ne    : literal "nope" == "callback"              (expect FALSE)
//   expr-const: "={{ 'callback' }}" == "callback"         (TRUE => expressions evaluated)
//   expr-json : text item, "={{ $json.message ? 'msg' : 'no' }}" == "msg" (TRUE => $json works)
const fs = require("fs");
const http = require("http");

const KEY = fs.readFileSync("C:/Users/divye/review-bot/n8n-api-key.txt", "utf8").trim();
const BASE = "http://192.168.1.xxx:5678/api/v1";
const V = process.argv[2] || "lit-eq";

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const req = http.request(u, {
      method,
      headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" },
    }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => resolve({ status: r.statusCode, body: d }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const VARIANTS = {
  "lit-eq": {
    item: "return [{ json: { x: 1 } }];",
    leftValue: "callback", rightValue: "callback",
    op: { type: "string", operation: "equals" },
    expect: "TrueMark",
  },
  "lit-ne": {
    item: "return [{ json: { x: 1 } }];",
    leftValue: "nope", rightValue: "callback",
    op: { type: "string", operation: "equals" },
    expect: "FalseMark",
  },
  "expr-const": {
    item: "return [{ json: { x: 1 } }];",
    leftValue: "={{ 'callback' }}", rightValue: "callback",
    op: { type: "string", operation: "equals" },
    expect: "TrueMark (if expressions evaluated)",
  },
  "expr-json": {
    item: "return [{ json: { message: { text: '4/5 hi' } } }];",
    leftValue: "={{ $json.message ? 'msg' : 'no' }}", rightValue: "msg",
    op: { type: "string", operation: "equals" },
    expect: "TrueMark (if $json works)",
  },
};

const v = VARIANTS[V] || VARIANTS["lit-eq"];

const wf = {
  name: "IF NODE TEST (" + V + ")",
  nodes: [
    { id: "t1", name: "Sched", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [{ field: "seconds", secondsInterval: 30 }] } } },
    { id: "t2", name: "MakeItem", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0],
      parameters: { jsCode: v.item } },
    { id: "t3", name: "TestIF", type: "n8n-nodes-base.if", typeVersion: 2.2, position: [400, 0],
      parameters: {
        conditions: {
          combinator: "and",
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
          conditions: [
            { leftValue: v.leftValue, rightValue: v.rightValue, operator: v.op },
          ],
        },
        options: {},
      } },
    { id: "t4", name: "TrueMark", type: "n8n-nodes-base.code", typeVersion: 2, position: [600, -60],
      parameters: { jsCode: "return [{ json: { branch: 'TRUE_BRANCH' } }];" } },
    { id: "t5", name: "FalseMark", type: "n8n-nodes-base.code", typeVersion: 2, position: [600, 60],
      parameters: { jsCode: "return [{ json: { branch: 'FALSE_BRANCH' } }];" } },
  ],
  connections: {
    Sched: { main: [[{ node: "MakeItem", type: "main", index: 0 }]] },
    MakeItem: { main: [[{ node: "TestIF", type: "main", index: 0 }]] },
    TestIF: { main: [
      [{ node: "TrueMark", type: "main", index: 0 }],
      [{ node: "FalseMark", type: "main", index: 0 }],
    ] },
  },
  settings: { executionOrder: "v1" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const create = await api("POST", "/workflows", wf);
  if (create.status >= 400) { console.log("CREATE FAILED", create.status, create.body.slice(0, 300)); return; }
  const id = JSON.parse(create.body).id;
  const act = await api("POST", "/workflows/" + id + "/activate", {});
  console.log("VARIANT:", V, "| created", id, "| activate:", act.status);

  let result = "no execution in 90s";
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const list = await api("GET", "/executions?workflowId=" + id + "&limit=1&includeData=true");
    const ej = JSON.parse(list.body);
    const e = ej.data && ej.data[0];
    if (!e) continue;
    const st = e.status || e.finished;
    if (st === "running" || st === "waiting") continue;
    const rd = e.data && e.data.resultData;
    const run = rd && rd.runData;
    let ran = [];
    if (run) {
      for (const n of ["TrueMark", "FalseMark"]) {
        if (run[n] && run[n][0] && run[n][0].data && run[n][0].data.main && run[n][0].data.main[0] && run[n][0].data.main[0].length) ran.push(n);
      }
    }
    result = "status:" + st + " lastNode:" + (rd && rd.lastNodeExecuted) + " ran:" + ran.join("+") + "  (expected: " + v.expect + ")";
    break;
  }
  console.log("RESULT:", result);
  const del = await api("DELETE", "/workflows/" + id);
  console.log("deleted:", del.status);
})().catch((e) => console.log("ERR", e.message));
