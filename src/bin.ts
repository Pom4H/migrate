#!/usr/bin/env bun
import { main } from "./cli.js";

process.exitCode = await main();
