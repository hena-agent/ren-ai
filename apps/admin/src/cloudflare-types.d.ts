// Scope Cloudflare's platform types without merging its HTMLRewriter Element into the browser DOM.
type D1Database = import("@cloudflare/workers-types").D1Database;
type D1PreparedStatement = import("@cloudflare/workers-types").D1PreparedStatement;
type D1Response = import("@cloudflare/workers-types").D1Response;
type D1Result<T = object> = import("@cloudflare/workers-types").D1Result<T>;
