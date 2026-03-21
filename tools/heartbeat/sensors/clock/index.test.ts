import test from 'node:test';
import assert from 'node:assert/strict';

import { collectClockEventsUpTo } from './index.ts';

test('collectClockEventsUpTo replays a missed minute boundary caused by timer drift', () => {
  const previous = new Date(2026, 2, 19, 20, 59, 59, 0).getTime();
  const now = new Date(2026, 2, 19, 21, 0, 1, 5);

  const result = collectClockEventsUpTo(now, previous);
  const replayedTimes = result.replayedSeconds.map(secondMs => {
    const date = new Date(secondMs);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
  });

  assert.deepEqual(replayedTimes, ['21:00:00', '21:00:01']);
});

test('collectClockEventsUpTo does not replay duplicate seconds', () => {
  const previous = new Date(2026, 2, 19, 21, 0, 1, 0).getTime();
  const now = new Date(2026, 2, 19, 21, 0, 1, 900);

  const result = collectClockEventsUpTo(now, previous);

  assert.deepEqual(result.replayedSeconds, []);
  assert.equal(result.processedSecondMs, previous);
});

test('collectClockEventsUpTo limits catch-up for large gaps', () => {
  const previous = new Date(2026, 2, 19, 20, 0, 0, 0).getTime();
  const now = new Date(2026, 2, 19, 21, 30, 15, 0);

  const result = collectClockEventsUpTo(now, previous, { maxCatchUpSeconds: 60 });
  const replayedTimes = result.replayedSeconds.map(secondMs => {
    const date = new Date(secondMs);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
  });

  assert.deepEqual(replayedTimes, ['21:30:15']);
});
