/**
 * json-extract-rules
 * ------------------
 * Generic JSON extractor for Node-RED:
 * - Runs ordered "extraction rules" over JSON already in msg
 * - Each rule: select (scope) -> filter (per-row) -> map (fields) -> aggregate -> write to target
 * - JSONata support for select/filter/map (with row context and access to msg)
 * - Typed outputs: msg / flow / global
 * - NA policy (normalize empty/NA strings to null)
 * - Structured warnings/errors + node status
 * - Config-file support: save / load / lock / watch (under userDir)
 *
 * Admin endpoints:
 *   GET  /json-extract-rules/template
 *   GET  /json-extract-rules/config?file=path.json
 *   POST /json-extract-rules/config {file, config}
 */

module.exports = function (RED) {
  const fs = require("fs");
  const fsp = fs.promises;
  const path = require("path");

  const TYPE = "json-extract-rules";

  // --------------------------
  // Config-file helpers
  // --------------------------
  const watchers = new Map(); // absPath -> { count, watcher }

  function ensureJsonExt(p) {
    if (!p || typeof p !== "string") throw new Error("Config path is empty");
    if (!p.toLowerCase().endsWith(".json")) throw new Error("Config path must end with .json");
  }
  function resolveUnderUserDir(rel) {
    const userDir = RED.settings.userDir || process.cwd();
    const abs = path.resolve(userDir, rel);
    if (!abs.startsWith(path.resolve(userDir))) throw new Error("Config path must be under userDir");
    return abs;
  }
  async function readJsonIfExists(abs) {
    try {
      const s = await fsp.readFile(abs, "utf8");
      return JSON.parse(s);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async function writeJson(abs, obj) {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, JSON.stringify(obj, null, 2), "utf8");
  }

  // --------------------------
  // JSON / JSONata helpers
  // --------------------------
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

  function mkNASet(values) {
    const set = new Set((values || []).map((s) => String(s).toLowerCase()));
    return (v) => {
      if (v == null) return true;
      const s = String(v).trim();
      if (!s) return true;
      return set.has(s.toLowerCase());
    };
  }

  function normalizeNA(v, isNA) {
    if (isNA(v)) return null;
    return v;
  }

  function applyTransform(name, v) {
    switch (name) {
      case "trim":
        return v == null ? v : String(v).trim();
      case "lower":
        return v == null ? v : String(v).toLowerCase();
      case "upper":
        return v == null ? v : String(v).toUpperCase();
      case "number": {
        if (v == null || String(v).trim() === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      case "bool01":
        return v ? 1 : 0;
      case "string":
        return v == null ? "" : String(v);
      case "none":
      default:
        return v;
    }
  }

  function getObjectProperty(obj, prop) {
    try {
      return RED.util.getObjectProperty(obj, prop);
    } catch {
      return undefined;
    }
  }

  function setTypedTarget(node, msg, type, path, value) {
    if (!path) return;
    if (type === "flow") node.context().flow.set(path, value);
    else if (type === "global") node.context().global.set(path, value);
    else RED.util.setMessageProperty(msg, path, value, true);
  }

  function jsonataEval(node, expr, data) {
    if (expr == null || expr === "") return undefined;
    try {
      const compiled = RED.util.prepareJSONataExpression(String(expr), node);
      return new Promise((resolve, reject) => {
        RED.util.evaluateJSONataExpression(compiled, data, (err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  async function evalTyped(node, msg, type, src, rowCtx) {
    switch (type) {
      case "msg":
        return RED.util.getMessageProperty(msg, String(src));
      case "flow":
        return node.context().flow.get(String(src));
      case "global":
        return node.context().global.get(String(src));
      case "env":
        return process.env[String(src)] || "";
      case "path":
        return getObjectProperty(rowCtx ?? msg, String(src));
      case "jsonata": {
        const dataRoot = rowCtx != null ? { ...rowCtx, msg } : msg;
        return await jsonataEval(node, src, dataRoot);
      }
      case "str":
        return String(src ?? "");
      case "num":
        return Number(src);
      case "bool":
        return !!src;
      case "json": {
        if (typeof src === "string") {
          try {
            return JSON.parse(src);
          } catch {
            return undefined;
          }
        }
        return src;
      }
      default:
        return src;
    }
  }

  // --------------------------
  // Default template for config-file
  // --------------------------
  const DEFAULT_TEMPLATE = {
    source: { type: "msg", path: "data" },
    naPolicy: { enabled: true, values: ["", "NA", "N/A"] },
    rules: [
      {
        name: "Example: pick users older than 18",
        selectType: "jsonata",
        select: "users", // relative to source root
        filterType: "jsonata",
        filter: "number(age) >= 18",
        map: [
          { key: "id", srcType: "jsonata", src: "id", transform: "number" },
          { key: "name", srcType: "jsonata", src: "name", transform: "trim" }
        ],
        aggregate: { mode: "array" }, // array | objectByKey | set | first | count
        output: { type: "msg", path: "data.output.adults" },
        onEmpty: "warn" // ok | warn | error
      }
    ]
  };

  // --------------------------
  // Admin endpoints
  // --------------------------
  RED.httpAdmin.get(
    "/json-extract-rules/template",
    RED.auth.needsPermission("flows.read"),
    async (_req, res) => {
      res.json({ ok: true, template: DEFAULT_TEMPLATE });
    }
  );

  RED.httpAdmin.get(
    "/json-extract-rules/config",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const rel = String(req.query.file || "").trim();
        ensureJsonExt(rel);
        const abs = resolveUnderUserDir(rel);
        const cfg = await readJsonIfExists(abs);
        res.json({ ok: true, config: cfg || DEFAULT_TEMPLATE });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    }
  );

  RED.httpAdmin.post(
    "/json-extract-rules/config",
    RED.auth.needsPermission("flows.write"),
    async (req, res) => {
      try {
        const { file, config } = req.body || {};
        const rel = String(file || "").trim();
        ensureJsonExt(rel);
        const abs = resolveUnderUserDir(rel);
        await writeJson(abs, config || {});
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    }
  );

  // --------------------------
  // Node implementation
  // --------------------------
  function JsonExtractRules(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Node-saved config (editor)
    node.source = config.source || { type: "msg", path: "data" };
    node.naPolicy = config.naPolicy || { enabled: true, values: ["", "NA", "N/A"] };
    node.rules = Array.isArray(config.rules) ? config.rules : [];

    // config-file fields
    node.useConfigFile = !!config.useConfigFile;
    node.configPath = config.configPath || "";
    node.lockToFile = !!config.lockToFile;
    node.watchFile = !!config.watchFile;

    let lockedCfg = null;

    async function loadLockedConfigIfNeeded() {
      if (!node.useConfigFile || !node.lockToFile) {
        lockedCfg = null;
        return;
      }
      ensureJsonExt(node.configPath);
      const abs = resolveUnderUserDir(node.configPath);
      const cfg = await readJsonIfExists(abs);
      lockedCfg = cfg || null;
      node.status(
        lockedCfg
          ? { fill: "blue", shape: "dot", text: "cfg loaded" }
          : { fill: "yellow", shape: "ring", text: "cfg missing → node cfg" }
      );
    }

    function startWatchingIfNeeded() {
      if (!node.useConfigFile || !node.watchFile) return;
      try {
        ensureJsonExt(node.configPath);
        const abs = resolveUnderUserDir(node.configPath);
        let info = watchers.get(abs);
        if (!info) {
          const w = fs.watch(abs, { persistent: false }, async (ev) => {
            if (ev === "change" || ev === "rename") {
              try {
                await loadLockedConfigIfNeeded();
                node.trace("config reloaded");
              } catch (e) {
                node.warn("config reload failed: " + e.message);
              }
            }
          });
          info = { count: 0, watcher: w };
          watchers.set(abs, info);
        }
        info.count += 1;
      } catch {
        /* ignore if file not there yet */
      }
    }

    function stopWatching() {
      if (!node.useConfigFile || !node.configPath) return;
      try {
        const abs = resolveUnderUserDir(node.configPath);
        const info = watchers.get(abs);
        if (info) {
          info.count -= 1;
          if (info.count <= 0) {
            info.watcher.close();
            watchers.delete(abs);
          }
        }
      } catch {
        /* noop */
      }
    }

    loadLockedConfigIfNeeded().finally(startWatchingIfNeeded);
    node.on("close", stopWatching);

    // --------------- Core execution ---------------
    node.on("input", async (msg, send, done) => {
      const t0 = Date.now();
      const meta = (msg.meta ||= {});
      const warnings = (meta.warnings ||= []);
      const errors = (meta.errors ||= []);
      const stepName = "json-extract-rules";

      try {
        // Effective runtime cfg
        const runCfg = lockedCfg || {
          source: node.source,
          naPolicy: node.naPolicy,
          rules: node.rules
        };

        // Source root
        let root;
        if (!runCfg.source || runCfg.source.type === "msg") {
          root = runCfg.source?.path ? RED.util.getMessageProperty(msg, runCfg.source.path) : msg;
        } else if (runCfg.source.type === "flow") {
          root = node.context().flow.get(runCfg.source.path || "");
        } else if (runCfg.source.type === "global") {
          root = node.context().global.get(runCfg.source.path || "");
        } else if (runCfg.source.type === "jsonata") {
          root = await jsonataEval(node, runCfg.source.path || "", msg);
        } else if (runCfg.source.type === "path") {
          root = getObjectProperty(msg, runCfg.source.path || "");
        } else {
          root = msg;
        }

        const isNA = runCfg.naPolicy?.enabled
          ? mkNASet(runCfg.naPolicy.values || ["", "NA", "N/A"])
          : () => false;

        let ruleOK = 0, ruleWarn = 0, ruleErr = 0;

        for (let rIndex = 0; rIndex < (runCfg.rules || []).length; rIndex++) {
          const rule = runCfg.rules[rIndex];
          const tag = `[rule:${rule.name || rIndex}]`;

          // 1) SELECT scope
          let scope;
          try {
            if (rule.selectType === "jsonata") {
              scope = await jsonataEval(node, rule.select || "", root);
            } else if (rule.selectType === "path") {
              scope = getObjectProperty(root, rule.select || "");
            } else {
              // default: act on root
              scope = root;
            }
          } catch (e) {
            errors.push(`${tag} select evaluation failed: ${e.message}`);
            ruleErr++;
            if (rule.onError === "stop") break;
            else continue;
          }

          if (!Array.isArray(scope)) {
            if (scope == null) scope = [];
            else {
              errors.push(`${tag} select did not resolve to an array`);
              ruleErr++;
              if (rule.onError === "stop") break;
              else continue;
            }
          }

          // 2) FILTER
          let rows = scope;
          if (rule.filter) {
            const out = [];
            for (const row of scope) {
              try {
                const keep = await evalTyped(node, msg, rule.filterType || "jsonata", rule.filter, row);
                if (keep) out.push(row);
              } catch (e) {
                warnings.push(`${tag} filter error on row: ${e.message}`);
              }
            }
            rows = out;
          }

          // 3) MAP
          const mapped = [];
          const maps = Array.isArray(rule.map) ? rule.map : [];
          if (maps.length === 0) {
            // pass-through rows if no mapping (for aggregate modes like count)
            mapped.push(...rows);
          } else {
            for (const row of rows) {
              const rec = {};
              let include = true;
              for (const m of maps) {
                // optional "when"
                if (m.when) {
                  try {
                    const w = await evalTyped(node, msg, m.whenType || "jsonata", m.when, row);
                    if (!w) continue; // skip this field
                  } catch (e) {
                    warnings.push(`${tag} when error: ${e.message}`);
                    continue;
                  }
                }
                try {
                  let v = await evalTyped(node, msg, m.srcType || "jsonata", m.src, row);
                  v = normalizeNA(v, isNA);
                  v = applyTransform(m.transform || "none", v);
                  if (m.key) rec[m.key] = v;
                } catch (e) {
                  warnings.push(`${tag} map error for key=${m.key}: ${e.message}`);
                  include = include && true; // keep record, just missing this field
                }
              }
              if (include) mapped.push(rec);
            }
          }

          // 4) AGGREGATE
          let result;
          const agg = rule.aggregate || { mode: "array" };
          const mode = agg.mode || "array";

          if (mode === "array") {
            result = mapped;
          } else if (mode === "first") {
            result = mapped.length ? mapped[0] : null;
          } else if (mode === "count") {
            result = mapped.length;
          } else if (mode === "objectByKey") {
            const obj = {};
            for (const row of mapped) {
              try {
                const k = await evalTyped(node, msg, agg.keyExprType || "jsonata", agg.keyExpr, row);
                obj[String(k ?? "")] = row;
              } catch (e) {
                warnings.push(`${tag} objectByKey keyExpr error: ${e.message}`);
              }
            }
            result = obj;
          } else if (mode === "set") {
            // If valueExpr provided, use it; else use the first property value of each mapped row
            const outSet = new Set();
            for (const row of mapped) {
              try {
                let v;
                if (agg.valueExpr) {
                  v = await evalTyped(node, msg, agg.valueExprType || "jsonata", agg.valueExpr, row);
                } else {
                  const keys = Object.keys(row);
                  v = keys.length ? row[keys[0]] : undefined;
                }
                v = normalizeNA(v, isNA);
                if (v != null && String(v).trim() !== "") outSet.add(String(v));
              } catch (e) {
                warnings.push(`${tag} set valueExpr error: ${e.message}`);
              }
            }
            result = Array.from(outSet);
          } else {
            // fallback
            result = mapped;
          }

          // 5) OUTPUT
          const outType = (rule.output && rule.output.type) || "msg";
          const outPath = (rule.output && rule.output.path) || `extract.${rIndex}`;
          setTypedTarget(node, msg, outType, outPath, result);

          // 6) Empty handling
          const empty = (mode === "count") ? (result === 0) :
                        (mode === "first") ? (result == null) :
                        Array.isArray(result) ? (result.length === 0) :
                        isObj(result) ? (Object.keys(result).length === 0) :
                        (result == null);
          if (empty) {
            if (rule.onEmpty === "error") {
              errors.push(`${tag} produced empty result`);
              ruleErr++;
            } else if (rule.onEmpty === "warn" || !rule.onEmpty) {
              // default warn when unspecified? We'll respect explicit 'ok' to silence.
              warnings.push(`${tag} produced empty result`);
              ruleWarn++;
            } else {
              ruleOK++;
            }
          } else {
            ruleOK++;
          }
        }

        const t1 = Date.now();
        const summary = {
          ok: errors.length === 0,
          step: stepName,
          counts: { rules: (runCfg.rules || []).length, ok: ruleOK, warn: ruleWarn + warnings.length, err: ruleErr + errors.length },
          timings: { ms: t1 - t0 }
        };

        msg.payload = summary;

        // status
        if (summary.counts.err > 0) node.status({ fill: "red", shape: "dot", text: `err:${summary.counts.err} ${summary.timings.ms}ms` });
        else if (summary.counts.warn > 0) node.status({ fill: "yellow", shape: "dot", text: `warn:${summary.counts.warn} ${summary.timings.ms}ms` });
        else node.status({ fill: "green", shape: "dot", text: `ok:${summary.counts.ok} ${summary.timings.ms}ms` });

        send(msg);
        done();
      } catch (err) {
        errors.push(`[engine] ${err.message}`);
        node.status({ fill: "red", shape: "ring", text: err.message });
        done(err);
      }
    });
  }

  RED.nodes.registerType(TYPE, JsonExtractRules);
};
