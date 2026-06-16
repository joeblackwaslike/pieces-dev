#!/usr/bin/env node

import { LtmReader } from "./db.js";
import type { CollectionName } from "./db.js";

const args = process.argv.slice(2);
const command = args[0];

function usage(): never {
  console.log(`Usage: ltm-reader <command> [options]

Commands:
  stats                        Show document counts per collection
  list <collection> [limit]    List document keys
  get <collection> <key>       Get a single document as JSON
  dump <collection> [limit]    Dump all documents as NDJSON
  collections                  List available collection names
`);
  process.exit(1);
}

const VALID_COLLECTIONS = [
  "workstreamEvents",
  "workstreamSummaries",
  "annotations",
  "hints",
  "tags",
  "persons",
  "websites",
  "anchors",
  "anchorPoints",
  "wpeSources",
  "wpeSourceWindows",
] as const;

function validateCollection(name: string | undefined): CollectionName {
  if (!name || !VALID_COLLECTIONS.includes(name as CollectionName)) {
    console.error(`Unknown collection: ${name ?? "(none)"}`);
    console.error(`Valid collections: ${VALID_COLLECTIONS.join(", ")}`);
    process.exit(1);
  }
  return name as CollectionName;
}

async function main() {
  const reader = new LtmReader();

  try {
    switch (command) {
      case "stats": {
        const stats = await reader.stats();
        console.log(JSON.stringify(stats, null, 2));
        break;
      }

      case "collections": {
        for (const name of VALID_COLLECTIONS) {
          console.log(name);
        }
        break;
      }

      case "list": {
        const collection = validateCollection(args[1]);
        const limit = parseInt(args[2] ?? "20", 10);
        const keys = await reader.listKeys(collection, limit);
        for (const key of keys) {
          console.log(key);
        }
        break;
      }

      case "get": {
        const collection = validateCollection(args[1]);
        const key = args[2];
        if (!key) {
          console.error("Missing document key");
          process.exit(1);
        }
        const doc = await reader.getDocument(collection, key);
        if (doc === null) {
          console.error(`Document not found: ${key}`);
          process.exit(1);
        }
        console.log(JSON.stringify(doc, null, 2));
        break;
      }

      case "dump": {
        const collection = validateCollection(args[1]);
        const limit = parseInt(args[2] ?? "100", 10);
        const docs = await reader.getAllDocuments(collection, limit);
        for (const doc of docs) {
          console.log(JSON.stringify(doc));
        }
        break;
      }

      default:
        usage();
    }
  } finally {
    reader.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
