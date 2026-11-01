# Herdr API schema

The reusable Rust wire codec, typed API and bounded event parser live in
[`crates/herdr-protocol`](../crates/herdr-protocol), published under MIT.
Whip's connection, subscription and native adapters consume that crate.

The versioned `herdr-api-v*.schema.json` files are the official JSON Schemas
published by Herdr for every local socket API protocol Whip supports:

| Protocol | Herdr source | Commit |
| --- | --- | --- |
| 17 | `v0.7.5` | `ef4c23f5775bb8cfec05f05d0844226ff959a07a` |
| 18 | `preview-2026-07-29-44b3adb12552` | `44b3adb125524ea9a55739eee3776f922f2115ad` |
| 19 | `v0.8.0` | `346411fa21afd297f5ed3b3fa56f9e3fbf7654b7` |
| 20 | upstream `master` | `d6dae88345d24b8e468f63faad6a09173d2cbeac` |

All four currently use schema version 1. Protocol schemas stay separate because
their request, response, and event surfaces can differ even when shared domain
objects have the same shape.

To update it from a nearby Herdr checkout and regenerate the TypeScript types:

```bash
git -C ../herdr show v0.7.5:docs/next/api/herdr-api.schema.json > protocol/herdr-api-v17.schema.json
git -C ../herdr show preview-2026-07-29-44b3adb12552:docs/next/api/herdr-api.schema.json > protocol/herdr-api-v18.schema.json
git -C ../herdr show v0.8.0:docs/next/api/herdr-api.schema.json > protocol/herdr-api-v19.schema.json
cp ../herdr/docs/next/api/herdr-api.schema.json protocol/herdr-api-v20.schema.json
npm run generate:herdr-api
```

The generator emits isolated modules for each protocol plus `herdrApi.ts`, the
compatibility unions consumed by Whip. Generated files are committed so normal
app builds do not depend on the upstream repository or run code generation
implicitly.
