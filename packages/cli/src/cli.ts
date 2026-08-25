#!/usr/bin/env node
/**
 * The binary.
 *
 * Deliberately three lines: everything worth testing lives in {@link runProgram}, and an entry
 * point that only wires real dependencies to real streams has nothing left to get wrong.
 */

import { nodeIo } from './io.ts';
import { nodeDependencies, runProgram } from './program.ts';

process.exitCode = await runProgram(process.argv.slice(2), nodeDependencies(nodeIo));
