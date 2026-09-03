import { defineOverrides } from "@pom4h/migrate";

export default defineOverrides({
  product: {
    "sample-product": {
      fields: {
        title: "A clearer product name",
        seo: {
          title: "A clearer product name — Example",
          featured: true,
        },
      },
      route: "/products/sample-product",
    },
  },
});
