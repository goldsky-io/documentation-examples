// Tiny Deno Deploy server for the corporate-actions dashboard.
//
// Deploy:
//   deployctl deploy \
//     --project=corp-actions-dashboard \
//     --include=dashboard.html \
//     --prod \
//     main.ts
//
// (Run from this docs/ directory. First run prompts for browser auth.)

const HTML = await Deno.readTextFile(new URL("./dashboard.html", import.meta.url));

Deno.serve((req) => {
  const url = new URL(req.url);

  // Health check.
  if (url.pathname === "/healthz") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  // Everything else gets the dashboard.
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
});
