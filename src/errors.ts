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

export class WorkflowAbortError extends Error {
  constructor(message = "Workflow aborted") {
    super(message);
    this.name = "WorkflowAbortError";
  }
}
