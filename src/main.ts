#!/usr/bin/env node
import { buildProgram } from "./cli.js";

try {
  await buildProgram().parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
