/**
 * `@tapedeck/cli` — the `tapedeck` command.
 *
 * The commands are exported as ordinary functions taking an IO object, so they can be driven from
 * a test, a script or another tool without spawning a process.
 */

export { type CliIo, nodeIo } from './io.ts';
export {
  type ProgramDependencies,
  VERSION,
  createProgram,
  nodeDependencies,
  runProgram,
} from './program.ts';
export {
  type PresetName,
  type RunCommandOptions,
  type RunDependencies,
  parseParams,
  resolveStrategyFactory,
  runCommand,
} from './commands/run.ts';
export {
  type PaperCommandOptions,
  type PaperDependencies,
  type PaperRuntime,
  type PaperStreamRequest,
  type WaitForStop,
  nodeWaitForStop,
  paperCommand,
} from './commands/paper.ts';
export { type ReportCommandOptions, reportCommand } from './commands/report.ts';
export {
  type DataDependencies,
  convertCommand,
  fetchCommand,
  readInstrumentFile,
} from './commands/data.ts';
