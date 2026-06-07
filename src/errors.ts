export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

export class WorkflowBudgetExceededError extends Error {
  constructor(message = "Workflow budget exceeded") {
    super(message);
    this.name = "WorkflowBudgetExceededError";
  }
}

export class WorkflowAgentCapError extends Error {
  constructor(message = "Workflow agent() call cap reached") {
    super(message);
    this.name = "WorkflowAgentCapError";
  }
}

export class WorkflowAbortError extends Error {
  constructor(message = "Workflow aborted") {
    super(message);
    this.name = "WorkflowAbortError";
  }
}
