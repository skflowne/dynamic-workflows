import assert from "node:assert/strict";
import test from "node:test";
import { CodexSdkAgentRunner, runWorkflow } from "../src/index.js";

test(
  "CodexSdkAgentRunner executes a live Codex agent turn",
  { skip: process.env.RUN_CODEX_SDK_LIVE === "1" ? false : "Set RUN_CODEX_SDK_LIVE=1 to run the live Codex SDK test." },
  async () => {
    const result = await runWorkflow(
      `export const meta = {
  name: 'codex_sdk_live',
  description: 'Live Codex SDK smoke test'
}

return agent('Return exactly this text and nothing else: codex-workflow-live-ok', { label: 'echo' })
`,
      {
        runner: new CodexSdkAgentRunner({
          cwd: process.cwd(),
          approvalPolicy: "never",
        }),
      },
    );

    assert.equal(String(result.result).trim(), "codex-workflow-live-ok");
  },
);
