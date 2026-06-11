import assert from 'node:assert/strict';
import test from 'node:test';
import { evalCommand } from '../tools/advancedCLI/index.ts';

test('advancedCLI.eval passes env overrides into managed command execution', async () => {
  const command = 'node -e "console.log(process.env.ADVANCEDCLI_TEST_ENV || \'\')"';
  const result = await evalCommand(command, {
    env: {
      ADVANCEDCLI_TEST_ENV: 'env-ok',
    },
  });

  assert.equal(result.success, true);
  assert.match(result.output, /env-ok/);
});
