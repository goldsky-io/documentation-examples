/**
 * Minimal ambient declaration for the Deno globals used by this app.
 * The full Deno types aren't pulled in via @types/deno because compose's
 * default tsconfig keeps the type surface tight. Only declare what we use.
 */
declare namespace Deno {
  // deno-lint-ignore no-namespace
  namespace env {
    function get(key: string): string | undefined;
    function set(key: string, value: string): void;
  }
}
