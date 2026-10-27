// fix-if-nodes.js — patch the demo workflow's two IF nodes to the working filter format
const fs = require("fs");
const http = require("http");

const KEY = fs.readFileSync("C:/Users/divye/review-bot/n8n-api-key.txt", "utf8").trim();
const BASE = "http://192.168.1.xxx:5678/api/v1";
const WF_ID = "ELk9R3m7jeGK5VAF";

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

const FIXED = {
  "Is Callback": {
    typeVersion: 2.2,
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [
          {
            leftValue: "={{ $json.callback_query ? 'callback' : 'review' }}",
            rightValue: "callback",
            operator: { type: "string", operation: "equals" },
          },
        ],
      },
      options: {},
    },
  },
  "Is Authorized": {
    typeVersion: 2.2,
    parameters: {
      conditions: {
        combinator: "and",
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [
          {
            leftValue: "={{ $json.authorized ? 'yes' : 'no' }}",
            rightValue: "yes",
            operator: { type: "string", operation: "equals" },
          },
        ],
      },
      options: {},
    },
  },
};

(async () => {
  const get = await api("GET", "/workflows/" + WF_ID);
  if (get.status !== 200) { console.log("GET FAILED", get.status, get.body.slice(0, 200)); return; }
  const parsed = JSON.parse(get.body);
  const w = parsed.data || parsed;

  let changed = 0;
  for (const n of w.nodes) {
    if (FIXED[n.name]) {
      const before = JSON.stringify(n.parameters);
      n.typeVersion = FIXED[n.name].typeVersion;
      n.parameters = FIXED[n.name].parameters;
      console.log(n.name + " patched (was typeVersion " + (FIXED[n.name].typeVersion === 2.2 ? "2" : "?") + ")\n  old: " + before.slice(0, 150));
      changed++;
    }
  }
  if (changed !== 2) { console.log("EXPECTED 2 nodes, changed", changed); return; }

  // fix Is Callback branch wiring: true(0) -> Handle Callback, false(1) -> Parse Review
  const ic = w.connections["Is Callback"];
  console.log("Is Callback wiring before:", JSON.stringify(ic));
  w.connections["Is Callback"] = {
    main: [
      [{ node: "Handle Callback", type: "main", index: 0 }],
      [{ node: "Parse Review", type: "main", index: 0 }],
    ],
  };
  console.log("Is Callback wiring after :", JSON.stringify(w.connections["Is Callback"]));
  console.log("Is Authorized wiring       :", JSON.stringify(w.connections["Is Authorized"]));

  const body = {
    name: w.name,
    nodes: w.nodes,
    connections: w.connections,
    settings: w.settings,
  };
  const put = await api("PUT", "/workflows/" + WF_ID, body);
  console.log("PUT:", put.status, put.body.slice(0, 120));

  const act = await api("POST", "/workflows/" + WF_ID + "/activate", {});
  console.log("ACTIVATE:", act.status, act.body.slice(0, 120));

  const verify = await api("GET", "/workflows/" + WF_ID);
  const vj = JSON.parse(verify.body);
  console.log("active now:", vj.data.active);
})().catch((e) => console.log("ERR", e.message));
