import { expect, test, vi } from "vitest";
import { falSelection, falEntries } from "./fal-model-catalog.ts";
import { falSchema, modelCatalogFetch, seedreamModel } from "../test/image-models.ts";
import { fetchUrl } from "../test/fetch-url.ts";

type Properties = Record<string, object>;
function apiFetcher(api: object): typeof fetch {
  return async (url, init) =>
    fetchUrl(url).includes("openapi.json") ? Response.json(api) : modelCatalogFetch(url, init);
}
function schemaFetcher(edit: (props: Properties, required: string[]) => void): typeof fetch {
  return async (url, init) => {
    if (!fetchUrl(url).includes("openapi.json")) return modelCatalogFetch(url, init);
    const schema = falSchema(seedreamModel.model);
    const input = schema.components.schemas.Input;
    const props: Properties = { ...input.properties };
    const required = [...input.required];
    edit(props, required);
    return Response.json({
      ...schema,
      components: {
        schemas: { ...schema.components.schemas, Input: { properties: props, required } },
      },
    });
  };
}

test.each([
  {
    name: "two references",
    edit: (p: Properties) => {
      p["image_urls"] = { type: "array", minItems: 2 };
    },
  },
  {
    name: "no reference",
    edit: (p: Properties) => {
      delete p["image_urls"];
    },
  },
  {
    name: "no inline output",
    edit: (p: Properties) => {
      delete p["sync_mode"];
    },
  },
  {
    name: "minimum two outputs",
    edit: (p: Properties) => {
      p["num_images"] = { type: "integer", minimum: 2 };
    },
  },
  {
    name: "multiple sequential outputs",
    edit: (p: Properties) => {
      p["max_images"] = { type: "integer", minimum: 2 };
    },
  },
  {
    name: "no PNG",
    edit: (p: Properties) => {
      p["output_format"] = { enum: ["webp"] };
    },
  },
  {
    name: "inline disabled",
    edit: (p: Properties) => {
      p["sync_mode"] = { enum: [false] };
    },
  },
  {
    name: "forced sequential",
    edit: (p: Properties) => {
      p["sequential_image_generation"] = { enum: ["auto"] };
    },
  },
  {
    name: "required mask",
    edit: (p: Properties, required: string[]) => {
      p["mask"] = { type: "string" };
      required.push("mask");
    },
  },
  {
    name: "unsupported size",
    edit: (p: Properties, required: string[]) => {
      p["image_size"] = { type: "string" };
      required.push("image_size");
    },
  },
  {
    name: "unsupported ratio",
    edit: (p: Properties, required: string[]) => {
      p["aspect_ratio"] = { enum: ["1:1"] };
      required.push("aspect_ratio");
    },
  },
])(
  "incompatible fal contract ($name) is rejected during read-only resolution",
  async ({ edit }) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(schemaFetcher(edit));
    await expect(falSelection(seedreamModel.model, "key", fetcher)).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(
      true,
    );
  },
);

test("compatible singular-reference and ratio contracts are discovered without model-name registration", async () => {
  const fetcher = schemaFetcher((props, required) => {
    delete props["image_urls"];
    props["image_url"] = { type: "string" };
    required.splice(1, 1, "image_url");
    delete props["image_size"];
    props["aspect_ratio"] = { enum: ["2:3", "1:1"] };
  });
  const choice = await falSelection(seedreamModel.model, "key", fetcher);
  expect(choice.referenceField).toBe("image_url");
  expect(choice.size).toBe("ratio");
  expect(choice.fields).not.toContain("image_size");
  expect(choice.price).toContain("USD 0.035");
  const defaults = await falSelection(
    seedreamModel.model,
    "key",
    schemaFetcher((props) => {
      delete props["image_size"];
    }),
  );
  expect(defaults.size).toBe("default");
});

test("listing forwards search and cursor, and absent prices remain explicitly unknown", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) =>
      fetchUrl(url).includes("pricing")
        ? Response.json({ prices: [] })
        : modelCatalogFetch(url, init),
    );
  await falEntries("", fetcher, "new model", "cursor-value");
  const url = new URL(fetchUrl(fetcher.mock.calls[0]![0]));
  expect(url.searchParams.get("q")).toBe("new model");
  expect(url.searchParams.get("cursor")).toBe("cursor-value");
  expect(url.searchParams.get("sort")).toBe("recent");
  const choice = await falSelection(seedreamModel.model, "key", fetcher);
  expect(choice.price).toContain("단가 정보 없음");
});

test("missing schema links and inactive registry entries fail closed", async () => {
  const empty = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) =>
      fetchUrl(url).includes("openapi.json")
        ? Response.json({ ...falSchema(seedreamModel.model), paths: {} })
        : modelCatalogFetch(url, init),
    );
  await expect(falSelection(seedreamModel.model, "key", empty)).rejects.toThrow("요청·응답");
  const inactive = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      models: [
        {
          endpoint_id: seedreamModel.model,
          metadata: { display_name: "Retired", category: "image-to-image", status: "deprecated" },
        },
      ],
    }),
  );
  await expect(falSelection(seedreamModel.model, "key", inactive)).rejects.toThrow("활성");
});

test.each([
  (props: Properties) => {
    props["image_urls"] = { type: "array", maxItems: 0 };
  },
  (props: Properties) => {
    delete props["num_images"];
  },
  (props: Properties) => {
    props["num_images"] = { type: "integer", maximum: 0 };
  },
])("single-reference and single-output bounds fail closed", async (edit) => {
  await expect(falSelection(seedreamModel.model, "key", schemaFetcher(edit))).rejects.toMatchObject(
    { kind: "invalid" },
  );
});

test("inline schemas and optional native sizing work without undocumented fields", async () => {
  const schema = falSchema(seedreamModel.model);
  const input = { properties: { ...schema.components.schemas.Input.properties } };
  const output = schema.components.schemas.Output;
  const inline = {
    ...schema,
    paths: {
      [`/${seedreamModel.model}`]: {
        post: { requestBody: { content: { "application/json": { schema: input } } } },
      },
      [`/${seedreamModel.model}/requests/{request_id}`]: {
        get: { responses: { "200": { content: { "application/json": { schema: output } } } } },
      },
    },
  };
  expect((await falSelection(seedreamModel.model, "key", apiFetcher(inline))).size).toBe("pixels");
  const defaults: Properties = { ...input.properties };
  delete defaults["image_size"];
  const optional = {
    ...inline,
    paths: {
      ...inline.paths,
      [`/${seedreamModel.model}`]: {
        post: {
          requestBody: { content: { "application/json": { schema: { properties: defaults } } } },
        },
      },
    },
  };
  expect((await falSelection(seedreamModel.model, "key", apiFetcher(optional))).size).toBe(
    "default",
  );
  const native = await falSelection(
    seedreamModel.model,
    "key",
    schemaFetcher((props) => {
      props["image_size"] = { type: "object" };
      delete props["max_images"];
      delete props["output_format"];
      delete props["sequential_image_generation"];
    }),
  );
  expect(native.size).toBe("pixels");
  expect(native.fields).not.toContain("max_images");
});

test("unknown references and incomplete output contracts are not treated as runnable", async () => {
  const schema = falSchema(seedreamModel.model);
  const ref = { ...schema, components: { schemas: {} } };
  await expect(falSelection(seedreamModel.model, "key", apiFetcher(ref))).rejects.toThrow("해석");
  const noInput = {
    ...schema,
    components: { schemas: { ...schema.components.schemas, Input: {} } },
  };
  await expect(falSelection(seedreamModel.model, "key", apiFetcher(noInput))).rejects.toThrow(
    "규격",
  );
  const noOutput = {
    ...schema,
    components: { schemas: { ...schema.components.schemas, Output: {} } },
  };
  await expect(falSelection(seedreamModel.model, "key", apiFetcher(noOutput))).rejects.toThrow(
    "규격",
  );
});

test("optional sizes that cannot be lowered leave the provider's own default unchanged", async () => {
  const missingSize = schemaFetcher((props) => {
    props["image_size"] = { $ref: "#/components/schemas/Absent" };
  });
  expect((await falSelection(seedreamModel.model, "key", missingSize)).size).toBe("default");
  const ratio = schemaFetcher((props) => {
    delete props["image_size"];
    props["aspect_ratio"] = { type: "string" };
  });
  expect((await falSelection(seedreamModel.model, "key", ratio)).size).toBe("ratio");
  const unsupported = schemaFetcher((props) => {
    delete props["image_size"];
    props["aspect_ratio"] = { enum: ["1:1"] };
  });
  expect((await falSelection(seedreamModel.model, "key", unsupported)).size).toBe("default");
  const schema = falSchema(seedreamModel.model);
  const incompleteSize = {
    ...schema,
    components: {
      schemas: {
        ...schema.components.schemas,
        Size: { properties: { width: { type: "integer" } } },
      },
    },
  };
  expect((await falSelection(seedreamModel.model, "key", apiFetcher(incompleteSize))).size).toBe(
    "default",
  );
});

test("registry rows without metadata are skipped without inventing a name or price", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      models: [
        { endpoint_id: "vendor/no-metadata" },
        {
          endpoint_id: "vendor/image",
          metadata: { display_name: "Image", category: "image-to-image", status: "active" },
        },
      ],
    }),
  );
  const listed = await falEntries("", fetcher, "", null);
  expect(listed.models).toHaveLength(1);
  expect(listed.models[0]!.releaseDate).toBe("");
  expect(listed.nextCursor).toBeNull();
});

test("real fal Seedream names distinguish v5 tiers and omit specialized image utilities", async () => {
  const rows = [
    {
      endpoint_id: "bytedance/seedream/v5/flash/edit",
      metadata: { display_name: "Seedream", category: "image-to-image", status: "active" },
    },
    {
      endpoint_id: "bytedance/seedream/v5/lite/edit",
      metadata: { display_name: "Seedream", category: "image-to-image", status: "active" },
    },
    ...[
      "bytedance/seedream/v5/flash/layerize",
      "topaz/upscale/image/creative",
      "google/virtual-try-on",
      "bria/fibo-edit-1.5/product-holding",
      "bria/increase-resolution",
    ].map((endpoint_id) => ({
      endpoint_id,
      metadata: { display_name: "Other task", category: "image-to-image", status: "active" },
    })),
    {
      endpoint_id: "vendor/tool",
      metadata: {
        display_name: "Utility",
        category: "image-to-image",
        status: "active",
        tags: ["utility"],
      },
    },
  ];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ models: rows }));
  const page = await falEntries("key", fetcher, "seedream", null);
  expect(page.models.map((model) => model.name)).toEqual([
    "Seedream 5 · Flash",
    "Seedream 5 · Lite",
  ]);
  await expect(falSelection(rows[2]!.endpoint_id, "key", fetcher)).rejects.toThrow("원화");
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
