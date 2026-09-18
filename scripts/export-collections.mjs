// Run only when refreshing the reviewed public NFT index; no RPC calls.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const [source] = process.argv.slice(2);
assert.ok(source, "Usage: node scripts/export-collections.mjs CACHED_COLLECTIONS_JSON");
const { policies } = JSON.parse(readFileSync(new URL("../docs/policies.json", import.meta.url)));
const rows = JSON.parse(readFileSync(source)).map(({ master, name, pda }) => {
  assert.equal(policies[master]?.programAuthority, pda);
  assert.ok(typeof name === "string" && name.trim());
  return { master, name };
});
assert.equal(new Set(rows.map(r => r.master)).size, rows.length);
writeFileSync(new URL("../docs/collections.json", import.meta.url), JSON.stringify(rows, null, 2) + "\n");
console.log(`Exported ${rows.length} indexed labels. These are representative NFT names, not verified collection names.`);
