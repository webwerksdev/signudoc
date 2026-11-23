import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { fieldTypeSchema } from "../schemas/field.ts";
import { signatureMeanings } from "../types/domain.ts";
import { buildOpenApiDocument } from "./openapi.ts";

// Every route file under src/app/api/v1 has a path in the OpenAPI
// description, with the same methods, and nothing is described that does
// not exist.

const V1_DIR = path.join(import.meta.dirname, "../../app/api/v1");

async function listRouteFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(
        ...(await listRouteFiles(
          path.join(dir, entry.name),
          `${prefix}/${entry.name.replace(/^\[(.+)\]$/, "{$1}")}`,
        )),
      );
    } else if (entry.name === "route.ts") {
      found.push(prefix);
    }
  }

  return found;
}

test("the OpenAPI description matches the route files", async () => {
  const { readFile } = await import("node:fs/promises");
  const document = buildOpenApiDocument("https://sign.example.com/api/v1");
  const routes = await listRouteFiles(V1_DIR);

  assert.deepEqual([...routes].sort(), Object.keys(document.paths).sort());

  for (const route of routes) {
    const source = await readFile(
      path.join(V1_DIR, route.replace(/\{(\w+)\}/g, "[$1]"), "route.ts"),
      "utf8",
    );
    const methods = [
      ...source.matchAll(
        /export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g,
      ),
    ]
      .map((match) => match[1]?.toLowerCase())
      .sort();
    const described = Object.keys(
      document.paths[route as keyof typeof document.paths],
    ).sort();

    assert.deepEqual(described, methods, `methods for ${route}`);
  }
});

test("the OpenAPI description allows the values the API accepts", () => {
  const document = buildOpenApiDocument("https://sign.example.com/api/v1");
  const { CreateEnvelope, Field } = document.components.schemas;
  const fromTemplate =
    document.paths["/templates/{id}/envelopes"].post.requestBody.content[
      "application/json"
    ].schema.properties.signers.items.properties;

  assert.deepEqual(Field.properties.type.enum, fieldTypeSchema.options);
  assert.deepEqual(
    CreateEnvelope.properties.signers.items.properties.signatureMeaning.enum,
    [...signatureMeanings],
  );
  assert.deepEqual(fromTemplate.signatureMeaning.enum, [...signatureMeanings]);
});

test("the OpenAPI description gives this install's signer limit", () => {
  const document = buildOpenApiDocument("https://sign.example.com/api/v1", 40);
  const fromTemplate =
    document.paths["/templates/{id}/envelopes"].post.requestBody.content[
      "application/json"
    ].schema.properties.signers;

  assert.equal(
    document.components.schemas.CreateEnvelope.properties.signers.maxItems,
    40,
  );
  assert.equal(fromTemplate.maxItems, 40);
});
