// check-hayl-mary-sync.js
//
// Compares the menu items in Airtable against what's actually live on
// haylmary.com.au. If an item exists in Airtable but its name doesn't
// appear anywhere on the live page, the Airtable → Framer connection
// has likely stalled.
//
// Requires one secret: AIRTABLE_API_KEY (read-only Personal Access Token,
// scoped to just the HaylMary base).

const AIRTABLE_BASE_ID = "app1uNj8G6PrJIJv8";
const AIRTABLE_TABLE_ID = "tbl9BDIdgG0R78oUe"; // Menu Items
const LIVE_SITE_URL = "https://haylmary.com.au/";

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

async function fetchAllAirtableRecords() {
  const records = [];
  let offset;

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`
    );
    url.searchParams.set("fields[]", "Name");
    url.searchParams.append("fields[]", "Price");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });

    if (!res.ok) {
      throw new Error(`Airtable API returned HTTP ${res.status} — check AIRTABLE_API_KEY`);
    }

    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

async function fetchLiveSiteText() {
  const res = await fetch(LIVE_SITE_URL);
  if (!res.ok) {
    throw new Error(`Could not load ${LIVE_SITE_URL} — HTTP ${res.status}`);
  }
  return normalize(await res.text());
}

async function main() {
  const [records, siteText] = await Promise.all([
    fetchAllAirtableRecords(),
    fetchLiveSiteText(),
  ]);

  const missing = records.filter((record) => {
    const name = record.fields.Name;
    if (!name) return false;
    return !siteText.includes(normalize(name));
  });

  if (missing.length > 0) {
    console.error(`❌ ${missing.length} menu item(s) in Airtable are missing from the live site:`);
    missing.forEach((r) => console.error(`   - ${r.fields.Name}`));
    console.error("\nThis usually means the Airtable → Framer plugin connection has stalled or timed out.");
    process.exit(1);
  }

  console.log(`✅ All ${records.length} menu items match the live site.`);
}

main().catch((err) => {
  console.error("Check failed to run:", err.message);
  process.exit(1);
});
