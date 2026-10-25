#!/usr/bin/env node
import { main } from '../src/cli/ivwh.js';

process.exitCode = await main();
