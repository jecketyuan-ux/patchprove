import { goPlugin } from "./go.js";
import { javaPlugin } from "./java.js";
import { jsPlugin } from "./js.js";
import { pythonPlugin } from "./python.js";
import { rustPlugin } from "./rust.js";
import type { LanguagePlugin } from "./types.js";

/** Built-in language plugins. Add a file next to these and push it here. */
export const builtinPlugins: LanguagePlugin[] = [
  jsPlugin,
  pythonPlugin,
  goPlugin,
  rustPlugin,
  javaPlugin,
];
