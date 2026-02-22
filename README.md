# JSON Schema → Data Dictionary

A browser-based tool that converts JSON Schema files into an interactive tabular data dictionary. Useful for documenting and sharing variable definitions, types, valid values, and constraints in a human-readable format.

> **Live tool:** https://mgarciaclosas.github.io/render-tabular-json-schema/
>
> Original tool by [@jeyabbalas](https://github.com/jeyabbalas): https://jeyabbalas.github.io/render-tabular-json-schema/

---

## What it does

Upload one or more JSON Schema files (or load them from URLs) and the tool renders a searchable, exportable data dictionary table with columns for variable name, description, data type, valid values, and constraints. The table can be exported to Excel. All processing happens locally in your browser — no data is sent anywhere.

---

## How to use

1. Open the tool in your browser
2. **Load schemas** — choose one or both methods:
   - **Upload files**: click **Choose JSON Schema File(s)** and select one or more `.json` schema files
   - **Load from URL**: paste a GitHub link or raw JSON URL into the URL box and click **Add URL**. Paste multiple URLs at once (one per line) to add them all in one go. Drag ⠿ to reorder the list — the table will follow this order
3. Click **Generate Table** to render the data dictionary
4. Use the **column selector** to show/hide and reorder columns
5. Use the **search box** to find variables, or the **category dropdown** to focus on one schema at a time. Use **Collapse all / Expand all** to fold or unfold all sections
6. **Select variables**: tick the checkbox on any row (or the section checkbox to select a whole schema). Click **Export Selected to Excel** to export only those variables — useful for building a data mart
7. Click **Export All to Excel** to download the full dictionary
8. If schemas were loaded from URLs, click **Copy shareable link** to get a URL that pre-loads the same schemas automatically for anyone you share it with

**Tips:**
- GitHub file links (`github.com/user/repo/blob/branch/file.json`) are automatically converted to raw content URLs — no need to find the raw link yourself
- Shareable links only work for URL-loaded schemas (not uploaded files). Host your schemas on GitHub and load them via the URL box to enable link sharing

---

## Supported schema structures

### Single domain schema (`type: object`)

Upload or link a single schema file directly — no wrapper needed:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Pregnancies",
  "type": "object",
  "properties": { ... }
}
```

### Multiple domain schemas

Upload or link several `type:object` schemas — all variables are combined into one table, with each schema shown as a separate category section. The order of the URL list determines the order of sections in the table.

### Dataset-level schema (`type: array` + row schema)

Upload or link two files together:
- A dataset schema with `type: array` whose `items` references a row schema
- The row schema itself (resolved via `$id` matching)

```json
{
  "type": "array",
  "items": { "$ref": "my-row-schema.json" }
}
```

### Combined schema using `allOf`

A row schema can combine multiple domain schemas via `allOf` and `$ref`. Upload the dataset schema, the combined row schema, and any referenced domain schemas together — all `$ref` links are resolved automatically by `$id` or filename matching.

---

## Nested array properties

Properties with `type: array` and object `items` (e.g. repeated measures like pregnancies) are automatically expanded. The parent field is shown as a row, followed by all sub-fields grouped under a sub-category labelled **`<fieldName> — array items`**.

Example — a `Pregnancies` array field with 14 sub-fields will appear as:

| Variable Name | Description | ... |
|---|---|---|
| Pregnancies | An array of pregnancy records | ... |
| *(Pregnancies — array items)* | | |
| R0_Preg_Outcome | Outcome of pregnancy | ... |
| R0_Preg_DurationWks | Length of pregnancy (weeks) | ... |
| ... | | |

---

## Table columns

| Column | Description |
|---|---|
| **Variable Name** | Property key from the schema |
| **Description** | `description` field |
| **Data Type** | `type` field (arrays shown as `type1 \| type2`) |
| **Valid Values** | `enum` values with optional `enumDescriptions` |
| **Constraints** | Required, min/max, length, pattern, etc. |
| **Additional Info** | Any other schema keywords not shown in other columns |

Columns can be shown/hidden and reordered using the column selector dropdown.

---

## Requirements

- Any modern browser — no installation, no server, no data leaves your device

---

## Tech stack

Vanilla JavaScript, HTML, CSS — no framework dependencies.

---

*Forked from [jeyabbalas/render-tabular-json-schema](https://github.com/jeyabbalas/render-tabular-json-schema). Additions: support for `type:object` schemas as direct input, automatic expansion of nested array properties, multi-schema concatenation, loading schemas directly from GitHub or raw JSON URLs (with drag-and-drop reordering), and multi-URL paste.*
