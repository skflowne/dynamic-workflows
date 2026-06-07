import type { WorkflowAgentCall, WorkflowAgentRunner } from "../types.js";

export type ScriptedAgentHandler = (call: WorkflowAgentCall, signal?: AbortSignal) => unknown | Promise<unknown>;

export class ScriptedAgentRunner implements WorkflowAgentRunner {
  readonly calls: WorkflowAgentCall[] = [];

  constructor(private readonly handler: ScriptedAgentHandler) {}

  async run(call: WorkflowAgentCall, signal?: AbortSignal): Promise<unknown> {
    this.calls.push(call);
    return this.handler(call, signal);
  }
}
