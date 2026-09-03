import { defineMigration, entity, field, website } from "@pom4h/migrate";

export default defineMigration({
  name: "example-catalog",

  source: website("https://legacy.example.com", {
    discover: ["sitemap", "links"],
    include: ["/catalog/**"],
    concurrency: 8,
    maxPages: 2_000,
  }),

  entities: [
    entity("product", {
      match: "/catalog/:category/:slug",
      id: field.param("slug"),
      route: "/products/:slug",
      fields: {
        title: field.text("h1"),
        description: field.text(".product-description", { required: false }),
        price: field.money(".price"),
        images: field.list(".gallery img[src]", {
          attribute: "src",
          absolute: true,
        }),
      },
      assetFields: ["images"],
    }),
  ],

  output: {
    generated: "content/generated",
    resolved: "content/resolved",
    overrides: "content/overrides.ts",
  },

  checks: {
    allowEmpty: false,
    requireHttps: true,
    maxRemovedRatio: 0.05,
  },
});
