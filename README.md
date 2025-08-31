# node-red-contrib-json-extract-rules

**JSON Extract Rules** is a Node-RED custom editor/node that lets you define **declarative extraction rules** over a JSON source using **JSONata** and simple path types. Each rule performs:

> **select → filter → map → aggregate → output**

It’s ideal for turning semi-structured JSON (e.g. parsed spreadsheets, API payloads) into clean, shaped data written back to `msg`, `flow`, or `global`.

---

## Features

- 🔎 **Typed inputs** with **JSONata** editor (“⋯”) on all relevant fields
- 🧮 Rule pipeline: **select**, **filter**, **map**, **aggregate**
- 🧰 Aggregators: `array`, `set`, `objectByKey`, `first`, `count`
- ⚙️ Optional **config file** (load/save/lock/watch) under your `userDir`
- 🚧 Non-blocking editor dialog so JSONata popup appears **on top**
- ⚠️ NA policy: normalize `["", "NA", "N/A"]` (configurable) to `null`
- ✅ “On empty” and “On error” behaviors per rule

---

## Install

```bash
npm install node-red-contrib-json-extract-rules
# or inside your Node-RED userDir:
# cd ~/.node-red
# npm i node-red-contrib-json-extract-rules
````

Restart Node-RED. The node appears under **function** as **json extract**.

> Requires Node-RED **≥ 3.0** for the built-in JSONata editor button on typed inputs.

---

## Quick start

1. Drop **json extract** onto a flow.
2. Set **Source root** (e.g. `msg.data`).
3. Click **Add rule** and define:

   * **Select scope** (array to iterate) — JSONata or path
   * **Filter rows** — JSONata boolean
   * **Mapping** — build objects from each item (key/value pairs)
   * **Aggregate** — `array`, `set`, etc.
   * **Output** — where to write results (e.g. `msg.extract.items`)

Example (generic) to collect “active” items into `msg.result.names`:

* **Select:**
  JSONata → `payload.items`
* **Filter:**
  JSONata → `$boolean(active)`
* **Map:**
  Key = `name`, Value = `name`
* **Aggregate:**
  `set` with **Value expression** = `name`
* **Output:**
  `msg.result.names`

Result:

```json
{
  "result": {
    "names": ["alpha","bravo","charlie"]
  }
}
```

---

## JSONata tips you can use here

* **Dynamic property lookup:**

  ```jsonata
  $lookup(object, key)
  ```
* **Regex match (boolean via existence):**

  ```jsonata
  $exists($match(text, /^ABC/i))
  ```
* **Basic transforms:** `$lowercase()`, `$replace()`, `$string()`, `$trim()`

> The editor’s function list is not exhaustive; you can enter functions manually.

---

## NA policy

Normalize “empty” values to `null` before mapping/aggregation:

```json
{
  "enabled": true,
  "values": ["", "NA", "N/A"]
}
```

Edit this in the node’s **NA policy** section.

---

## Using a config file (optional)

You can store your rules in a JSON file under Node-RED’s `userDir` and **Load / Save / Lock / Watch** it from the editor.

Example file (generic):

```json
{
  "source": { "type": "msg", "path": "data" },
  "naPolicy": { "enabled": true, "values": ["", "NA", "N/A"] },
  "rules": [
    {
      "name": "Collect active names",
      "select": "payload.items",
      "selectType": "jsonata",
      "filter": "$boolean(active)",
      "filterType": "jsonata",
      "map": [{ "key": "name", "src": "name", "srcType": "jsonata", "transform": "trim" }],
      "aggregate": { "mode": "set", "valueExpr": "name", "valueExprType": "jsonata" },
      "output": { "type": "msg", "path": "result.names" },
      "onEmpty": "ok",
      "onError": "continue"
    }
  ]
}
```

---

## UI notes

* If the JSONata editor popup (“⋯”) ever appears under your rule dialog, this node’s dialog uses **non-modal** mode so the JSONata editor always stacks **on top**.
* Avoid custom CSS that targets `.red-ui-typedInput-input` — it can hide the “⋯” button.

---

## Troubleshooting

* **“⋯ doesn’t open”**
  Ensure the field **type** is set to **jsonata** (the pill on the left).
* **Filter never matches**
  Test the expression in a **Change** node set to JSONata; confirm field names and data shape.
* **Dynamic sheet/table**
  Use `$lookup(container, key)` not `container[key]` syntax.

---

## Development

* Files:

  * `json-extract-rules.html` — editor UI & Node-RED editor scripts
  * `json-extract-rules.js` — runtime (node implementation)
* Link locally for development:

  ```bash
  cd ~/.node-red
  npm link /path/to/your/checkout
  node-red
  ```

---

## License

[MIT](LICENSE)
