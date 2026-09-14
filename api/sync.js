// api/sync.js
//
// Vercel serverless endpoint. Airtable calls this every time a Menu
// Items record is created or updated. Does a full resync (small
// dataset, ~90 records — simpler and safer than trying to patch just
// the one changed record, and it also catches deletions).
//
// Protected by a shared secret header so it can't be triggered by
// anyone who finds the URL.

import { connect } from "framer-api"

const AIRTABLE_BASE_ID = "app1uNj8G6PrJIJv8"
const AIRTABLE_TABLE_ID = "tbl9BDIdgG0R78oUe"
const FRAMER_COLLECTION_NAME = "Menu - Server API test" // TODO: rename once this becomes the real live collection

const CATEGORY_MAP = {
  Main: "Mains",
  Sides: "Sides",
  Drinks: "Drinks",
  Beer: "Beer",
  Wine: "Wine",
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

async function fetchAllAirtableRecords() {
  const records = []
  let offset

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`
    )
    ;["Name", "Description", "Price", "Menu"].forEach((f) =>
      url.searchParams.append("fields[]", f)
    )
    if (offset) url.searchParams.set("offset", offset)

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    })

    if (!res.ok) {
      throw new Error(`Airtable API returned HTTP ${res.status}`)
    }

    const data = await res.json()
    records.push(...data.records)
    offset = data.offset
  } while (offset)

  return records
}

async function runSync() {
  const airtableRecords = await fetchAllAirtableRecords()
  const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY)

  try {
    const collections = await framer.getCollections()
    const collection = collections.find((c) => c.name === FRAMER_COLLECTION_NAME)
    if (!collection) throw new Error(`Could not find collection "${FRAMER_COLLECTION_NAME}"`)

    const fields = await collection.getFields()
    const fieldId = (name) => {
      const field = fields.find((f) => f.name === name)
      if (!field) throw new Error(`Expected field "${name}" not found`)
      return field.id
    }

    const nameFieldId = fieldId("Name")
    const descriptionFieldId = fieldId("Description")
    const priceFieldId = fieldId("Price")
    const categoryFieldId = fieldId("Category")
    const recordIdFieldId = fieldId("Record ID")
    const lastSyncedFieldId = fieldId("Last Synced")

    const categoryField = fields.find((f) => f.name === "Category")
    const categoryCaseId = (airtableCategory) => {
      const framerCategoryName = CATEGORY_MAP[airtableCategory]
      const match = categoryField.cases.find((c) => c.name === framerCategoryName)
      if (!match) throw new Error(`No matching Framer category for "${airtableCategory}"`)
      return match.id
    }

    const existingItems = await collection.getItems()
    const existingByAirtableId = new Map()
    for (const item of existingItems) {
      const recordId = item.fieldData[recordIdFieldId]?.value
      if (recordId) existingByAirtableId.set(recordId, item.id)
    }

    const now = new Date().toISOString()
    let createdCount = 0
    let updatedCount = 0
    const skipped = []
    const itemsToWrite = []
    const seenAirtableIds = new Set()

    for (const record of airtableRecords) {
      const name = record.fields.Name
      if (!name) {
        skipped.push(record.id)
        continue
      }

      seenAirtableIds.add(record.id)
      const existingFramerId = existingByAirtableId.get(record.id)

      itemsToWrite.push({
        ...(existingFramerId && { id: existingFramerId }),
        slug: slugify(name),
        fieldData: {
          [nameFieldId]: { type: "string", value: name },
          [descriptionFieldId]: { type: "formattedText", value: record.fields.Description || "" },
          [priceFieldId]: { type: "number", value: record.fields.Price ?? 0 },
          [categoryFieldId]: { type: "enum", value: categoryCaseId(record.fields.Menu) },
          [recordIdFieldId]: { type: "string", value: record.id },
          [lastSyncedFieldId]: { type: "date", value: now },
        },
      })

      if (existingFramerId) updatedCount++
      else createdCount++
    }

    await collection.addItems(itemsToWrite)

    const toRemove = []
    for (const [airtableId, framerItemId] of existingByAirtableId) {
      if (!seenAirtableIds.has(airtableId)) toRemove.push(framerItemId)
    }
    if (toRemove.length > 0) {
      await collection.removeItems(toRemove)
    }

    return {
      created: createdCount,
      updated: updatedCount,
      removed: toRemove.length,
      skipped: skipped.length,
    }
  } finally {
    await framer.disconnect()
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" })
  }

  if (req.headers["x-webhook-secret"] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" })
  }

  try {
    const result = await runSync()
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    console.error("Sync failed:", err)
    return res.status(500).json({ ok: false, error: err.message })
  }
}
