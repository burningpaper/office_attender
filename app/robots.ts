import type { MetadataRoute } from "next";

/**
 * Nothing here is for a search engine.
 *
 * The shared week is the only page a crawler could reach at all, and it is
 * meant to be handed to colleagues rather than found. Disallowing the prefix
 * says so without printing the token itself, which would rather defeat it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
