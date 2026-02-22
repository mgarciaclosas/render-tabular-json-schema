# JSON Schema → Data Dictionary

A browser-based tool that converts JSON Schema files into an interactive tabular data dictionary. Useful for documenting and sharing variable definitions, types, valid values, and constraints in a human-readable format.

> **Live tool:** https://mgarciaclosas.github.io/render-tabular-json-schema/
>
> Original tool by [@jeyabbalas](https://github.com/jeyabbalas): https://jeyabbalas.github.io/render-tabular-json-schema/

---

## What it does

Upload one or more JSON Schema files and the tool renders a searchable, exportable data dictionary table with columns for variable name, description, data type, valid values, and constraints. The table can be exported to Excel.

---

## How to use

1. Open the tool in your browser
2. Click **Choose Files** and select one or more JSON Schema files
3. Click **Process Schema**
4. Use the column selector to show/hide columns
5. Use the search box to filter variables
6. Click **Export to Excel** to download the data dictionary as an `.xlsx` file

---

## Supported schema structures

### Single domain schema (`type: object`)

Upload a single schema file directly — no wrapper needed:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Pregnancies",
  "type": "object",
  "properties": { ... }
}
```

### Dataset-level schema (`type: array` + row schema)

Upload two files together:
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
- All schema processing happens locally in the browser

---

## Tech stack

Vanilla JavaScript, HTML, CSS — no framework dependencies.

---

*Forked from [jeyabbalas/render-tabular-json-schema](https://github.com/jeyabbalas/render-tabular-json-schema). Additions: support for `type:object` schemas as direct input and automatic expansion of nested array properties.*
